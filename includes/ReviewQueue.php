<?php
/**
 * Review queue
 *
 * Everything Claude writes through the MCP API passes through here, and none of
 * it becomes a settled record until a person has looked at it.
 *
 * There are two shapes of proposal:
 *
 *   - A NEW record (contact, project, to-do, note, invoice PDF) is written to
 *     its ordinary table straight away, with review_status = 'pending'. That
 *     way it shows up where people already look - in the lists, the detail
 *     views, the bookkeeping pool - clearly marked, editable with the normal
 *     forms, and Claude can keep referring to it by id (add a note to the
 *     contact it just proposed, for instance). Accepting clears the flag;
 *     rejecting deletes the row.
 *
 *   - A CHANGE to a record that already exists (edit fields, link, tag, assign,
 *     delete) is never written. It waits in review_items
 *     with the proposed values and a snapshot of what was there before, until
 *     somebody accepts or rejects it.
 *
 * Accepting a change happens in one of two places. Structural changes (links,
 * tags) are applied here. Field edits,
 * deletions and assignments are applied by the reviewer's browser through the
 * ordinary endpoints - so they get exactly the validation, geocoding, to-do
 * mirroring and activity logging a manual edit gets, attributed to the person
 * who accepted - and are then marked resolved.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

/** A refusal the caller should see, with the HTTP status that fits it. */
class ReviewException extends RuntimeException
{
    private int $status;

    public function __construct(string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->status = $status;
    }

    public function status(): int
    {
        return $this->status;
    }
}

final class ReviewQueue
{
    public const PENDING = 'pending';

    /** Applied by accept() on the server. */
    public const SERVER_APPLIED = ['create', 'link', 'unlink', 'tag', 'untag'];

    /** Applied by the reviewer's browser through the ordinary endpoints, then resolve()d. */
    public const CLIENT_APPLIED = ['update', 'delete', 'assign'];

    /**
     * Tables that carry review_status, by entity type.
     *
     * This map is the whitelist: a type that is not a key here never reaches
     * SQL, so the table names interpolated below are always one of these
     * literals and never anything a caller supplied.
     */
    public const PENDABLE = [
        'contact' => 'contacts',
        'project' => 'projects',
        'todo' => 'todos',
        'contact_note' => 'notes',
        'project_note' => 'project_notes',
        'bookkeeping_pdf' => 'bookkeeping_pdfs',
    ];

    /** Every entity a proposal can point at. */
    public const ENTITY_TABLES = self::PENDABLE;

    // -------------------------------------------------------------------------
    // Writing proposals (called by the MCP API)
    // -------------------------------------------------------------------------

    public static function add(
        string $kind,
        string $entityType,
        int $entityId,
        string $label,
        array $payload = [],
        ?array $previous = null,
        ?string $comment = null
    ): int {
        if (!in_array($kind, array_merge(self::SERVER_APPLIED, self::CLIENT_APPLIED), true)
            || !isset(self::ENTITY_TABLES[$entityType])) {
            throw new InvalidArgumentException('Unknown proposal type');
        }

        $db = Database::getInstance();
        $stmt = $db->prepare("
            INSERT INTO review_items (kind, entity_type, entity_id, entity_label, payload, previous, comment, source)
            VALUES (:kind, :entity_type, :entity_id, :label, :payload, :previous, :comment, :source)
        ");
        $stmt->execute([
            'kind' => $kind,
            'entity_type' => $entityType,
            'entity_id' => $entityId,
            'label' => mb_substr($label, 0, 255),
            'payload' => self::encode($payload),
            'previous' => $previous === null ? null : self::encode($previous),
            'comment' => $comment === null || trim($comment) === '' ? null : mb_substr(trim($comment), 0, 2000),
            'source' => MCP_ACTOR_NAME,
        ]);

        return (int) $db->lastInsertId();
    }

    public static function pendingCount(): int
    {
        return (int) Database::getInstance()
            ->query("SELECT COUNT(*) FROM review_items WHERE status = 'pending'")
            ->fetchColumn();
    }

    /** Whether a record is itself still awaiting review. */
    public static function isPendingRecord(string $entityType, int $id): bool
    {
        if (!isset(self::PENDABLE[$entityType]) || !self::tableExists(self::PENDABLE[$entityType])) {
            return false;
        }

        $stmt = Database::getInstance()->prepare(
            "SELECT review_status FROM " . self::PENDABLE[$entityType] . " WHERE id = :id"
        );
        $stmt->execute(['id' => $id]);

        return $stmt->fetchColumn() === self::PENDING;
    }

    /** The open "create" proposal behind a pending record, if there is one. */
    public static function pendingCreateFor(string $entityType, int $id): ?array
    {
        $stmt = Database::getInstance()->prepare("
            SELECT * FROM review_items
            WHERE kind = 'create' AND entity_type = :type AND entity_id = :id AND status = 'pending'
            ORDER BY id DESC LIMIT 1
        ");
        $stmt->execute(['type' => $entityType, 'id' => $id]);
        $row = $stmt->fetch();

        return $row ?: null;
    }

    // -------------------------------------------------------------------------
    // Reading the queue (called by the CRM and the MCP API)
    // -------------------------------------------------------------------------

    public static function get(int $id): ?array
    {
        $stmt = Database::getInstance()->prepare("SELECT * FROM review_items WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();

        return $row ? self::decodeRow($row) : null;
    }

    /**
     * Open proposals per entity type, for the nav badge.
     *
     * @return array{total: int, by_type: array<string, int>}
     */
    public static function summary(): array
    {
        self::reconcile();

        $rows = Database::getInstance()->query("
            SELECT entity_type, COUNT(*) AS total
            FROM review_items
            WHERE status = 'pending'
            GROUP BY entity_type
        ")->fetchAll();

        $byType = [];
        $total = 0;
        foreach ($rows as $row) {
            $byType[$row['entity_type']] = (int) $row['total'];
            $total += (int) $row['total'];
        }

        return ['total' => $total, 'by_type' => $byType];
    }

    /**
     * Proposals with everything a reviewer needs to decide: the record as it is
     * now, and for links and attachments the other side of the relation.
     *
     * @param string $status 'pending' or 'resolved'
     */
    public static function listItems(string $status = self::PENDING, int $limit = 200, ?string $entityType = null, ?int $entityId = null): array
    {
        self::reconcile();

        $limit = max(1, min(500, $limit));
        $where = $status === self::PENDING ? "status = 'pending'" : "status <> 'pending'";
        $params = [];

        if ($entityType !== null && isset(self::ENTITY_TABLES[$entityType]) && $entityId !== null) {
            $where .= " AND entity_type = :type AND entity_id = :id";
            $params['type'] = $entityType;
            $params['id'] = $entityId;
        }

        $order = $status === self::PENDING ? "created_at ASC, id ASC" : "resolved_at DESC, id DESC";

        $stmt = Database::getInstance()->prepare(
            "SELECT * FROM review_items WHERE " . $where . " ORDER BY " . $order . " LIMIT " . $limit
        );
        $stmt->execute($params);

        $items = [];
        foreach ($stmt->fetchAll() as $row) {
            $item = self::decodeRow($row);
            $item['record'] = self::snapshot($item['entity_type'], (int) $item['entity_id']);
            $item['related'] = self::related($item);
            $item['applied_by'] = in_array($item['kind'], self::SERVER_APPLIED, true) ? 'server' : 'client';
            $items[] = $item;
        }

        return $items;
    }

    // -------------------------------------------------------------------------
    // Deciding (called by the CRM, one signed-in person at a time)
    // -------------------------------------------------------------------------

    /**
     * Accept a proposal that the server applies itself.
     */
    public static function accept(int $id): array
    {
        $item = self::requirePending($id);

        if (!in_array($item['kind'], self::SERVER_APPLIED, true)) {
            throw new ReviewException('This change is applied from the review screen.', 409);
        }

        Database::transactional(function (PDO $db) use ($item) {
            switch ($item['kind']) {
                case 'create':
                    self::settleCreated($db, $item);
                    break;
                case 'link':
                    self::applyLink($db, $item, true);
                    break;
                case 'unlink':
                    self::applyLink($db, $item, false);
                    break;
                case 'tag':
                    self::applyTag($db, $item, true);
                    break;
                case 'untag':
                    self::applyTag($db, $item, false);
                    break;
            }

            self::mark($db, (int) $item['id'], 'accepted', Auth::actor());
        });

        if ($item['kind'] === 'create') {
            self::logDecision($item, 'accepted');
        }

        return self::get((int) $item['id']) ?? $item;
    }

    /**
     * Record that the reviewer's browser has applied a field edit, deletion or
     * assignment through the ordinary endpoints.
     */
    public static function resolve(int $id): array
    {
        $item = self::requirePending($id);

        if (!in_array($item['kind'], self::CLIENT_APPLIED, true)) {
            throw new ReviewException('Use accept for this kind of proposal.', 409);
        }

        self::mark(Database::getInstance(), (int) $item['id'], 'accepted', Auth::actor());

        return self::get((int) $item['id']) ?? $item;
    }

    /**
     * Reject a proposal. A proposed new record is deleted with it.
     */
    public static function reject(int $id): array
    {
        return self::discard($id, 'rejected', Auth::actor());
    }

    /**
     * Claude taking back its own open proposal - the same as a rejection, but
     * recorded as withdrawn so the history says who changed their mind.
     */
    public static function withdraw(int $id): array
    {
        return self::discard($id, 'withdrawn', ['id' => null, 'name' => MCP_ACTOR_NAME]);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private static function discard(int $id, string $status, array $actor): array
    {
        $item = self::requirePending($id);
        $fileToRemove = null;

        Database::transactional(function (PDO $db) use ($item, $status, $actor, &$fileToRemove) {
            if ($item['kind'] === 'create') {
                $fileToRemove = self::deletePendingRecord($db, $item['entity_type'], (int) $item['entity_id']);
            }
            self::mark($db, (int) $item['id'], $status, $actor);
        });

        // The file goes only once the row is gone for good: a rolled-back
        // transaction must not leave a database row pointing at nothing.
        if ($fileToRemove !== null && is_file($fileToRemove)) {
            @unlink($fileToRemove);
        }

        if ($item['kind'] === 'create') {
            self::logDecision($item, $status);
        }

        return self::get((int) $item['id']) ?? $item;
    }

    private static function requirePending(int $id): array
    {
        self::reconcile();

        $item = self::get($id);
        if ($item === null) {
            throw new ReviewException('Proposal not found.', 404);
        }
        if ($item['status'] !== self::PENDING) {
            throw new ReviewException('This proposal has already been decided.', 409);
        }

        return $item;
    }

    private static function mark(PDO $db, int $id, string $status, array $actor): void
    {
        $stmt = $db->prepare("
            UPDATE review_items
            SET status = :status, resolved_at = CURRENT_TIMESTAMP, resolved_by = :by, resolved_by_name = :by_name
            WHERE id = :id AND status = 'pending'
        ");
        $stmt->execute([
            'status' => $status,
            'by' => $actor['id'] ?? null,
            'by_name' => $actor['name'] ?? null,
            'id' => $id,
        ]);
    }

    /**
     * Close proposals that have been overtaken by events: the record is gone,
     * or a pending record was accepted some other way (an invoice a person
     * dragged onto its row, which bookkeeping.php treats as accepting it).
     */
    private static function reconcile(): void
    {
        self::ensureBookkeepingColumn();

        $db = Database::getInstance();
        $pending = $db->query("SELECT id, kind, entity_type, entity_id FROM review_items WHERE status = 'pending'")->fetchAll();
        if (empty($pending)) {
            return;
        }

        $system = ['id' => null, 'name' => 'System'];

        foreach ($pending as $item) {
            $table = self::ENTITY_TABLES[$item['entity_type']] ?? null;
            if ($table === null) {
                continue;
            }

            if (!self::tableExists($table)) {
                self::mark($db, (int) $item['id'], 'obsolete', $system);
                continue;
            }

            $hasReviewColumn = isset(self::PENDABLE[$item['entity_type']]);
            $stmt = $db->prepare(
                "SELECT id" . ($hasReviewColumn ? ", review_status" : "") . " FROM " . $table . " WHERE id = :id"
            );
            $stmt->execute(['id' => (int) $item['entity_id']]);
            $record = $stmt->fetch();

            if (!$record) {
                self::mark($db, (int) $item['id'], 'obsolete', $system);
            } elseif ($item['kind'] === 'create' && $hasReviewColumn && $record['review_status'] !== self::PENDING) {
                self::mark($db, (int) $item['id'], 'accepted', $system);
            }
        }
    }

    /** Clear the pending flag on a proposed record (and a to-do's mirrored copies). */
    private static function settleCreated(PDO $db, array $item): void
    {
        $type = $item['entity_type'];
        $table = self::PENDABLE[$type] ?? null;
        if ($table === null) {
            throw new ReviewException('Unknown record type.', 422);
        }

        $id = (int) $item['entity_id'];
        $sql = "UPDATE " . $table . " SET review_status = NULL WHERE id = :id";
        if ($type === 'todo') {
            $sql .= " OR parent_todo_id = :id2";
        }

        $stmt = $db->prepare($sql);
        $stmt->execute($type === 'todo' ? ['id' => $id, 'id2' => $id] : ['id' => $id]);

        if ($stmt->rowCount() === 0) {
            throw new ReviewException('That record no longer exists.', 410);
        }
    }

    /**
     * Delete a record that is still pending. Returns the path of a stored file
     * to remove once the transaction has committed, if there is one.
     */
    private static function deletePendingRecord(PDO $db, string $type, int $id): ?string
    {
        $table = self::PENDABLE[$type] ?? null;
        if ($table === null || !self::tableExists($table)) {
            return null;
        }

        $file = null;
        if ($type === 'bookkeeping_pdf') {
            $stmt = $db->prepare("SELECT stored_name FROM bookkeeping_pdfs WHERE id = :id AND review_status = 'pending'");
            $stmt->execute(['id' => $id]);
            $stored = $stmt->fetchColumn();
            if (is_string($stored) && preg_match('/^[A-Za-z0-9_]+\.pdf$/', $stored)) {
                $file = DATA_DIR . '/bookkeeping_pdfs/' . $stored;
            }
        }

        // A to-do's mirrored copies live and die with it, as in todos.php. Older
        // databases gained parent_todo_id through ALTER TABLE, which cannot add
        // the cascading foreign key, so they go explicitly - but only when the
        // to-do itself is still pending.
        if ($type === 'todo' && self::isPendingRecord('todo', $id)) {
            $db->prepare("DELETE FROM todos WHERE parent_todo_id = :id")
                ->execute(['id' => $id]);
        }

        // Only ever a pending row: a proposal can never delete something a
        // person has already accepted.
        $db->prepare("DELETE FROM " . $table . " WHERE id = :id AND review_status = 'pending'")
            ->execute(['id' => $id]);

        return $file;
    }

    private static function applyLink(PDO $db, array $item, bool $link): void
    {
        $projectId = (int) $item['entity_id'];
        $contactId = (int) ($item['payload']['contact_id'] ?? 0);

        if (!self::exists($db, 'projects', $projectId) || !self::exists($db, 'contacts', $contactId)) {
            throw new ReviewException('The project or the contact no longer exists.', 410);
        }

        if ($link) {
            $db->prepare("INSERT OR IGNORE INTO project_contacts (project_id, contact_id) VALUES (:p, :c)")
                ->execute(['p' => $projectId, 'c' => $contactId]);
        } else {
            $db->prepare("DELETE FROM project_contacts WHERE project_id = :p AND contact_id = :c")
                ->execute(['p' => $projectId, 'c' => $contactId]);
        }
    }

    private static function applyTag(PDO $db, array $item, bool $add): void
    {
        $type = $item['entity_type'];
        if (!in_array($type, ['contact', 'project'], true)) {
            throw new ReviewException('Only contacts and projects carry tags.', 422);
        }

        $entityId = (int) $item['entity_id'];
        $table = $type === 'contact' ? 'contacts' : 'projects';
        if (!self::exists($db, $table, $entityId)) {
            throw new ReviewException('That record no longer exists.', 410);
        }

        $junction = $type === 'contact' ? 'contact_tags' : 'project_tags';
        $column = $type === 'contact' ? 'contact_id' : 'project_id';

        if ($add) {
            $tagId = self::findOrCreateTag($db, (string) ($item['payload']['tag_name'] ?? ''), (string) ($item['payload']['color'] ?? ''));
            $db->prepare("INSERT OR IGNORE INTO " . $junction . " (" . $column . ", tag_id) VALUES (:e, :t)")
                ->execute(['e' => $entityId, 't' => $tagId]);
            return;
        }

        $tagId = (int) ($item['payload']['tag_id'] ?? 0);
        $db->prepare("DELETE FROM " . $junction . " WHERE " . $column . " = :e AND tag_id = :t")
            ->execute(['e' => $entityId, 't' => $tagId]);
    }

    /** Same rules as api/tags.php: names are unique ignoring case, colours are #rrggbb. */
    public static function findOrCreateTag(PDO $db, string $name, string $color = ''): int
    {
        $name = Auth::sanitizeString($name, 100) ?? '';
        if ($name === '') {
            throw new ReviewException('A tag needs a name.', 422);
        }

        $stmt = $db->prepare("SELECT id FROM tags WHERE LOWER(name) = LOWER(:name)");
        $stmt->execute(['name' => $name]);
        $existing = $stmt->fetchColumn();
        if ($existing !== false) {
            return (int) $existing;
        }

        if (!preg_match('/^#[0-9a-fA-F]{6}$/', $color)) {
            $color = '#3b82f6';
        }

        $db->prepare("INSERT INTO tags (name, color) VALUES (:name, :color)")
            ->execute(['name' => $name, 'color' => $color]);

        return (int) $db->lastInsertId();
    }

    /**
     * The record as it stands now, trimmed to what a reviewer reads.
     */
    private static function snapshot(string $type, int $id): ?array
    {
        $table = self::ENTITY_TABLES[$type] ?? null;
        if ($table === null || !self::tableExists($table)) {
            return null;
        }

        $db = Database::getInstance();

        switch ($type) {
            case 'contact':
                $sql = "SELECT id, name, company, location, email, phone, website, address, note, review_status,
                               assigned_to, assigned_to_name, updated_at
                        FROM contacts WHERE id = :id";
                break;
            case 'project':
                $sql = "SELECT id, name, company, stage, description, start_date, estimated_completion,
                               budget_min, budget_max, success_chance, review_status, assigned_to, assigned_to_name, updated_at
                        FROM projects WHERE id = :id";
                break;
            case 'todo':
                $sql = "SELECT t.id, t.title, t.description, t.due_date, t.priority, t.is_completed, t.review_status,
                               t.contact_id, t.project_id, t.assigned_to, t.assigned_to_name,
                               c.name AS contact_name, p.name AS project_name
                        FROM todos t
                        LEFT JOIN contacts c ON c.id = t.contact_id
                        LEFT JOIN projects p ON p.id = t.project_id
                        WHERE t.id = :id";
                break;
            case 'contact_note':
                $sql = "SELECT n.id, n.content, n.contact_id, n.review_status, n.created_at, c.name AS contact_name
                        FROM notes n LEFT JOIN contacts c ON c.id = n.contact_id WHERE n.id = :id";
                break;
            case 'project_note':
                $sql = "SELECT n.id, n.content, n.project_id, n.review_status, n.created_at, p.name AS project_name
                        FROM project_notes n LEFT JOIN projects p ON p.id = n.project_id WHERE n.id = :id";
                break;
            case 'bookkeeping_pdf':
                $sql = "SELECT id, original_name, file_size, row_id, review_status, created_at FROM bookkeeping_pdfs WHERE id = :id";
                break;
            default:
                return null;
        }

        $stmt = $db->prepare($sql);
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();

        return $row ?: null;
    }

    /** The other side of a link, for display. */
    private static function related(array $item): array
    {
        if (!in_array($item['kind'], ['link', 'unlink'], true)) {
            return [];
        }

        $stmt = Database::getInstance()->prepare("SELECT id, name, company FROM contacts WHERE id = :id");
        $stmt->execute(['id' => (int) ($item['payload']['contact_id'] ?? 0)]);

        return ['contact' => $stmt->fetch() ?: null];
    }

    /** Leave a trace in the timeline when a proposed contact or project is decided. */
    private static function logDecision(array $item, string $status): void
    {
        if (!in_array($item['entity_type'], ['contact', 'project'], true)) {
            return;
        }

        try {
            $actor = Auth::actor();
            $isContact = $item['entity_type'] === 'contact';
            $accepted = $status === 'accepted';
            $noun = $isContact ? 'Kontakt' : 'Projekt';

            $content = $accepted
                ? $noun . ' von ' . MCP_ACTOR_NAME . ' übernommen'
                : 'Vorschlag von ' . MCP_ACTOR_NAME . ' ' . ($status === 'withdrawn' ? 'zurückgezogen' : 'abgelehnt');

            $idColumn = $isContact ? 'contact_id' : 'project_id';
            $nameColumn = $isContact ? 'contact_name' : 'project_name';

            $stmt = Database::getInstance()->prepare("
                INSERT INTO activity_events (entry_type, action, content, " . $idColumn . ", " . $nameColumn . ", actor_id, actor_name)
                VALUES (:entry_type, :action, :content, :entity_id, :entity_name, :actor_id, :actor_name)
            ");
            $stmt->execute([
                'entry_type' => $isContact ? 'contact_activity' : 'project_activity',
                'action' => $accepted ? 'updated' : 'deleted',
                'content' => $content,
                // A rejected record is gone, so the timeline must not link to it.
                'entity_id' => $accepted ? (int) $item['entity_id'] : null,
                'entity_name' => (string) ($item['entity_label'] ?? ''),
                'actor_id' => $actor['id'],
                'actor_name' => $actor['name'],
            ]);
        } catch (Throwable $e) {
            error_log('review decision log failed: ' . $e->getMessage());
        }
    }

    private static function decodeRow(array $row): array
    {
        $row['id'] = (int) $row['id'];
        $row['entity_id'] = (int) $row['entity_id'];
        $row['payload'] = json_decode((string) $row['payload'], true) ?: [];
        $row['previous'] = $row['previous'] === null ? null : (json_decode((string) $row['previous'], true) ?: []);

        return $row;
    }

    private static function encode(array $value): string
    {
        return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    }

    private static function exists(PDO $db, string $table, int $id): bool
    {
        if (!in_array($table, self::ENTITY_TABLES, true) && !in_array($table, ['tags'], true)) {
            return false;
        }

        $stmt = $db->prepare("SELECT 1 FROM " . $table . " WHERE id = :id");
        $stmt->execute(['id' => $id]);

        return (bool) $stmt->fetchColumn();
    }

    /**
     * bookkeeping_pdfs is created by api/bookkeeping.php, not by the main
     * schema, so its review column is added here as well as there - whichever
     * runs first.
     */
    public static function ensureBookkeepingColumn(): void
    {
        static $done = false;
        if ($done || !self::tableExists('bookkeeping_pdfs')) {
            return;
        }
        $done = true;

        $db = Database::getInstance();
        $columns = array_column($db->query("PRAGMA table_info(bookkeeping_pdfs)")->fetchAll(PDO::FETCH_ASSOC), 'name');
        if (!in_array('review_status', $columns, true)) {
            $db->exec("ALTER TABLE bookkeeping_pdfs ADD COLUMN review_status VARCHAR(16)");
        }
    }

    /** The bookkeeping tables only exist once Bookkeeping has been opened. */
    public static function tableExists(string $table): bool
    {
        static $cache = [];
        if (!array_key_exists($table, $cache)) {
            $stmt = Database::getInstance()->prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :name");
            $stmt->execute(['name' => $table]);
            $cache[$table] = (bool) $stmt->fetchColumn();
        }

        return $cache[$table];
    }
}
