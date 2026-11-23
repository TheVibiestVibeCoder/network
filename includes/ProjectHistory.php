<?php
/**
 * How a project's stage and chance of success developed.
 *
 * Every change is a row in project_history: the field ('stage' or
 * 'chance'), the value it has from then on, when, and who. The first row of
 * a field is its value when the project was created. Written by
 * Project::create and Project::update, so every way a project changes - its
 * sheet, a proposal from Claude accepted, a meeting - is recorded.
 *
 * Before this existed nothing kept the values, only that a field changed
 * (activity_events). backfill() rebuilds what it can, once: Claude's
 * proposals carry the value before and after and when they were accepted;
 * the activity log says when a field was last changed by hand. Rows rebuilt
 * so are marked source = 'reconstructed'.
 */

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

class ProjectHistory
{
    public const FIELDS = [
        'stage' => 'stage',
        'chance' => 'success_chance',
        'budget_min' => 'budget_min',
        'budget_max' => 'budget_max',
        'end' => 'estimated_completion',
    ];

    /** The fields the activity log knows enough about to rebuild (backfill). */
    private const BACKFILL_FIELDS = ['stage' => 'stage', 'chance' => 'success_chance'];

    /** Fields kept as whole numbers. */
    private const NUMERIC = ['chance', 'budget_min', 'budget_max'];

    /** German labels the activity log uses for the two fields. */
    private const LOG_LABELS = ['stage' => 'Phase', 'chance' => 'Erfolgschance'];

    public static function ensureSchema(PDO $db): void
    {
        $db->exec("
            CREATE TABLE IF NOT EXISTS project_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                field VARCHAR(16) NOT NULL,
                value VARCHAR(64),
                changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                actor_name VARCHAR(255),
                source VARCHAR(16) NOT NULL DEFAULT 'live',
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            )
        ");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_project_history ON project_history(project_id, field, changed_at)");
    }

    /** A value as kept: the stage's name, the chance as a whole number, or null. */
    private static function norm(string $field, $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        return in_array($field, self::NUMERIC, true) ? (string) (int) round((float) $value) : (string) $value;
    }

    /** The values a new project starts with. */
    public static function recordCreated(PDO $db, int $projectId, array $data): void
    {
        self::ensureSchema($db);
        $actor = Auth::actor();
        $insert = $db->prepare("INSERT INTO project_history (project_id, field, value, actor_name) VALUES (:p, :f, :v, :a)");
        foreach (self::FIELDS as $field => $column) {
            $insert->execute(['p' => $projectId, 'f' => $field, 'v' => self::norm($field, $data[$column] ?? ($field === 'stage' ? 'Lead' : null)), 'a' => $actor['name']]);
        }
    }

    /** What changed between the project before and after a save. */
    public static function recordChanges(PDO $db, int $projectId, array $before, array $after): void
    {
        self::ensureSchema($db);
        $actor = Auth::actor();
        $insert = $db->prepare("INSERT INTO project_history (project_id, field, value, actor_name) VALUES (:p, :f, :v, :a)");
        foreach (self::FIELDS as $field => $column) {
            $old = self::norm($field, $before[$column] ?? null);
            $new = self::norm($field, $after[$column] ?? null);
            if ($old !== $new) {
                $insert->execute(['p' => $projectId, 'f' => $field, 'v' => $new, 'a' => $actor['name']]);
            }
        }
    }

    /** A project's history: { created_at, stage: [{ value, at, by, source }], chance: [...] }. */
    public static function forProject(PDO $db, int $projectId): ?array
    {
        self::ensureSchema($db);
        $stmt = $db->prepare("SELECT created_at FROM projects WHERE id = :id");
        $stmt->execute(['id' => $projectId]);
        $created = $stmt->fetchColumn();
        if ($created === false) {
            return null;
        }
        $stmt = $db->prepare("
            SELECT field, value, changed_at, actor_name, source FROM project_history
            WHERE project_id = :id ORDER BY changed_at, id
        ");
        $stmt->execute(['id' => $projectId]);
        $out = ['created_at' => $created, 'stage' => [], 'chance' => []];
        foreach ($stmt->fetchAll() as $row) {
            if (!isset($out[$row['field']])) {
                continue;
            }
            $out[$row['field']][] = [
                'value' => $row['field'] === 'chance' && $row['value'] !== null ? (int) $row['value'] : $row['value'],
                'at' => $row['changed_at'],
                'by' => $row['actor_name'],
                'source' => $row['source'],
            ];
        }
        return $out;
    }

    /**
     * Once, when budget and planned end joined the history: every project's
     * values as they are now, so a later change has something before it.
     */
    public static function seedLaterFields(PDO $db): void
    {
        self::ensureSchema($db);
        if ($db->query("SELECT value FROM app_settings WHERE key = 'project_history_budget_seeded'")->fetchColumn()) {
            return;
        }
        $db->beginTransaction();
        try {
            $insert = $db->prepare("INSERT INTO project_history (project_id, field, value, source) VALUES (:p, :f, :v, 'live')");
            $has = $db->prepare("SELECT 1 FROM project_history WHERE project_id = :p AND field = :f LIMIT 1");
            foreach ($db->query("SELECT id, budget_min, budget_max, estimated_completion FROM projects")->fetchAll() as $project) {
                foreach (['budget_min' => 'budget_min', 'budget_max' => 'budget_max', 'end' => 'estimated_completion'] as $field => $column) {
                    $has->execute(['p' => $project['id'], 'f' => $field]);
                    if (!$has->fetchColumn()) {
                        $insert->execute(['p' => $project['id'], 'f' => $field, 'v' => self::norm($field, $project[$column])]);
                    }
                }
            }
            $db->exec("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('project_history_budget_seeded', '1')");
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            error_log('Project history seed failed: ' . $e->getMessage());
        }
    }

    /** Every recorded change of the projects there are, oldest first (the Insights page). */
    public static function all(PDO $db): array
    {
        self::ensureSchema($db);
        return array_map(fn($row) => [
            'project_id' => (int) $row['project_id'],
            'field' => $row['field'],
            'value' => $row['value'],
            'changed_at' => $row['changed_at'],
            'source' => $row['source'],
        ], $db->query("
            SELECT h.project_id, h.field, h.value, h.changed_at, h.source
            FROM project_history h JOIN projects p ON p.id = h.project_id
            ORDER BY h.changed_at, h.id
        ")->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Once: the history before there was one, from what the CRM kept anyway.
     * Per project and field: the value at creation (Claude's proposal for the
     * project, or the first change's "before"), every accepted proposal of
     * Claude's that changed it (at the moment it was accepted), and - when the
     * project now has another value than the last one known - that value
     * from the last time the activity log saw the field change.
     */
    public static function backfill(PDO $db): void
    {
        self::ensureSchema($db);
        if ($db->query("SELECT value FROM app_settings WHERE key = 'project_history_backfilled'")->fetchColumn()) {
            return;
        }
        $hasReviews = (bool) $db->query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_items'")->fetchColumn();

        $db->beginTransaction();
        try {
            $insert = $db->prepare("INSERT INTO project_history (project_id, field, value, changed_at, actor_name, source)
                                    VALUES (:p, :f, :v, :at, :a, 'reconstructed')");
            $projects = $db->query("SELECT id, stage, success_chance, created_at, updated_at FROM projects")->fetchAll();
            foreach ($projects as $project) {
                $id = (int) $project['id'];
                $existing = $db->prepare("SELECT COUNT(*) FROM project_history WHERE project_id = :id");
                $existing->execute(['id' => $id]);
                if ((int) $existing->fetchColumn() > 0) {
                    continue;
                }

                $proposals = [];
                $created = null;
                if ($hasReviews) {
                    $stmt = $db->prepare("
                        SELECT kind, payload, previous, resolved_at, created_at, resolved_by_name FROM review_items
                        WHERE entity_type = 'project' AND entity_id = :id AND status = 'accepted' AND kind IN ('create', 'update')
                        ORDER BY COALESCE(resolved_at, created_at), id
                    ");
                    $stmt->execute(['id' => $id]);
                    foreach ($stmt->fetchAll() as $item) {
                        $payload = json_decode((string) $item['payload'], true) ?: [];
                        if ($item['kind'] === 'create') {
                            $created = $payload;
                        } else {
                            $proposals[] = ['payload' => $payload, 'previous' => json_decode((string) $item['previous'], true) ?: [],
                                'at' => $item['resolved_at'] ?: $item['created_at'], 'by' => $item['resolved_by_name']];
                        }
                    }
                }

                foreach (self::BACKFILL_FIELDS as $field => $column) {
                    $rows = [];
                    $moves = array_values(array_filter($proposals, fn($p) => array_key_exists($column, $p['payload'])));
                    $log = $db->prepare("
                        SELECT created_at FROM activity_events
                        WHERE entry_type = 'project_activity' AND action = 'updated' AND project_id = :id AND content LIKE :label
                        ORDER BY created_at
                    ");
                    $log->execute(['id' => $id, 'label' => '%' . self::LOG_LABELS[$field] . '%']);
                    $changes = $log->fetchAll(PDO::FETCH_COLUMN);

                    // At creation.
                    $initial = null;
                    $known = false;
                    if ($created !== null && array_key_exists($column, $created)) {
                        [$initial, $known] = [self::norm($field, $created[$column]), true];
                    } elseif ($created !== null && $field === 'stage') {
                        [$initial, $known] = ['Lead', true];
                    } elseif ($moves && array_key_exists($column, $moves[0]['previous'])) {
                        [$initial, $known] = [self::norm($field, $moves[0]['previous'][$column]), true];
                    } elseif (!$changes) {
                        [$initial, $known] = [self::norm($field, $project[$column]), true];
                    }
                    if ($known) {
                        $rows[] = [$initial, $project['created_at'], null];
                    }
                    // Claude's proposals, as they were accepted.
                    foreach ($moves as $move) {
                        $rows[] = [self::norm($field, $move['payload'][$column]), $move['at'], $move['by']];
                    }
                    // A later change by hand that brought it to what it is now.
                    $current = self::norm($field, $project[$column]);
                    $last = $rows ? end($rows) : null;
                    if (!$last || $last[0] !== $current) {
                        $after = $last ? $last[1] : $project['created_at'];
                        // Strictly after: the log notes an accepted proposal at its own moment too.
                        $later = array_values(array_filter($changes, fn($at) => $at > $after));
                        $rows[] = [$current, $later ? end($later) : ($project['updated_at'] ?: $after), null];
                    }
                    // Once each, in order.
                    $previous = false;
                    foreach ($rows as [$value, $at, $by]) {
                        if ($previous !== false && $value === $previous) {
                            continue;
                        }
                        $insert->execute(['p' => $id, 'f' => $field, 'v' => $value, 'at' => $at, 'a' => $by]);
                        $previous = $value;
                    }
                }
            }
            $db->exec("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('project_history_backfilled', '1')");
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            error_log('Project history backfill failed: ' . $e->getMessage());
        }
    }
}
