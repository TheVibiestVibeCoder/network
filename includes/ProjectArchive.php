<?php
/**
 * Deleted projects, kept so they can be brought back.
 *
 * Deleting a project still removes it (and, through ON DELETE CASCADE, its
 * to-dos, notes, tags, contact links and document rows), so nothing else in
 * the app has to know about deleted projects. Just before that, everything
 * that is about to go is written into deleted_projects as one snapshot.
 * Restoring puts the rows back under their original ids - SQLite's
 * AUTOINCREMENT never hands an id out twice, so they are still free.
 *
 * Document files stay on disk while a project is in here; they are removed
 * when it is deleted for good.
 */
class ProjectArchive
{
    /**
     * The tables a project's snapshot holds, in the order they are restored:
     * every row after the rows it points to.
     */
    private const TABLES = ['projects', 'project_notes', 'project_contacts', 'project_tags', 'project_documents', 'todos', 'todo_links'];

    /**
     * Write a project and everything that hangs off it into the archive.
     * Call inside the same transaction as the delete.
     */
    public static function archive(PDO $db, int $projectId, array $actor): void
    {
        $rows = self::collect($db, $projectId);
        if (empty($rows['projects'])) {
            return;
        }

        $project = $rows['projects'][0];
        $db->prepare('
            INSERT INTO deleted_projects (project_id, name, company, stage, deleted_by, deleted_by_name, snapshot)
            VALUES (:project_id, :name, :company, :stage, :deleted_by, :deleted_by_name, :snapshot)
        ')->execute([
            'project_id' => $projectId,
            'name' => $project['name'] ?? '',
            'company' => $project['company'] ?? null,
            'stage' => $project['stage'] ?? null,
            'deleted_by' => $actor['id'],
            'deleted_by_name' => $actor['name'],
            'snapshot' => json_encode($rows, JSON_UNESCAPED_UNICODE),
        ]);
    }

    /** The archived projects, newest first, with what each one holds. */
    public static function list(PDO $db): array
    {
        $out = [];
        foreach ($db->query('SELECT * FROM deleted_projects ORDER BY deleted_at DESC, id DESC')->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $snapshot = json_decode((string) $row['snapshot'], true) ?: [];
            $out[] = [
                'id' => (int) $row['id'],
                'project_id' => (int) $row['project_id'],
                'name' => $row['name'],
                'company' => $row['company'],
                'stage' => $row['stage'],
                'deleted_at' => $row['deleted_at'],
                'deleted_by_name' => $row['deleted_by_name'],
                'counts' => [
                    'todos' => count(array_filter($snapshot['todos'] ?? [], fn($t) => empty($t['parent_todo_id']))),
                    'notes' => count($snapshot['project_notes'] ?? []),
                    'documents' => count($snapshot['project_documents'] ?? []),
                ],
            ];
        }

        return $out;
    }

    /**
     * Put a deleted project back as it was. Links to contacts or tags that
     * have been deleted since are left out; so is a mirrored to-do whose
     * contact is gone.
     *
     * @return int the restored project's id
     */
    public static function restore(PDO $db, int $archiveId): int
    {
        $entry = self::find($db, $archiveId);
        $rows = json_decode((string) $entry['snapshot'], true);
        if (!is_array($rows) || empty($rows['projects'])) {
            throw new RuntimeException('This archived project cannot be restored.');
        }

        $projectId = (int) $entry['project_id'];
        $exists = $db->prepare('SELECT 1 FROM projects WHERE id = :id');
        $exists->execute(['id' => $projectId]);
        if ($exists->fetchColumn()) {
            throw new RuntimeException('A project with this id already exists.');
        }

        $contactIds = array_map('intval', $db->query('SELECT id FROM contacts')->fetchAll(PDO::FETCH_COLUMN));
        $tagIds = array_map('intval', $db->query('SELECT id FROM tags')->fetchAll(PDO::FETCH_COLUMN));
        $contactExists = fn($id) => $id === null || $id === '' || in_array((int) $id, $contactIds, true);

        $db->beginTransaction();
        try {
            $restoredTodos = [];
            foreach (self::TABLES as $table) {
                $list = $rows[$table] ?? [];

                if ($table === 'project_contacts') {
                    $list = array_filter($list, fn($r) => $contactExists($r['contact_id'] ?? null));
                } elseif ($table === 'project_tags') {
                    $list = array_filter($list, fn($r) => in_array((int) $r['tag_id'], $tagIds, true));
                } elseif ($table === 'todos') {
                    // Masters before their mirrored copies.
                    usort($list, fn($a, $b) => (int) !empty($a['parent_todo_id']) <=> (int) !empty($b['parent_todo_id']));
                    $kept = [];
                    foreach ($list as $todo) {
                        if (!$contactExists($todo['contact_id'] ?? null)) {
                            // A master keeps its project; a copy is only its contact.
                            if (!empty($todo['parent_todo_id'])) {
                                continue;
                            }
                            $todo['contact_id'] = null;
                        }
                        if (!empty($todo['parent_todo_id']) && !isset($restoredTodos[(int) $todo['parent_todo_id']])) {
                            continue;
                        }
                        $restoredTodos[(int) $todo['id']] = true;
                        $kept[] = $todo;
                    }
                    $list = $kept;
                } elseif ($table === 'todo_links') {
                    $list = array_filter($list, fn($r) => isset($restoredTodos[(int) $r['todo_id']]));
                }

                self::insertRows($db, $table, $list);
            }

            $db->prepare('DELETE FROM deleted_projects WHERE id = :id')->execute(['id' => $archiveId]);
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            throw $e;
        }

        return $projectId;
    }

    /** Delete for good: the archive entry and the document files. */
    public static function purge(PDO $db, int $archiveId): void
    {
        $entry = self::find($db, $archiveId);
        $rows = json_decode((string) $entry['snapshot'], true) ?: [];

        $files = [];
        foreach ($rows['project_documents'] ?? [] as $document) {
            $path = ProjectDocument::pathOf($document);
            if ($path !== null) {
                $files[] = $path;
            }
        }

        $db->prepare('DELETE FROM deleted_projects WHERE id = :id')->execute(['id' => $archiveId]);
        ProjectDocument::removeFiles($files);
    }

    private static function find(PDO $db, int $archiveId): array
    {
        $stmt = $db->prepare('SELECT * FROM deleted_projects WHERE id = :id');
        $stmt->execute(['id' => $archiveId]);
        $entry = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$entry) {
            throw new RuntimeException('Archived project not found.');
        }

        return $entry;
    }

    /** Every row the delete is about to take with it. */
    private static function collect(PDO $db, int $projectId): array
    {
        $select = function (string $sql, array $params) use ($db): array {
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        };
        $byProject = ['id' => $projectId];

        $todos = $select('
            SELECT * FROM todos
            WHERE project_id = :id
               OR parent_todo_id IN (SELECT id FROM todos WHERE project_id = :id2)
        ', ['id' => $projectId, 'id2' => $projectId]);

        $links = [];
        if ($todos) {
            $ids = array_map(fn($t) => (int) $t['id'], $todos);
            $links = $select('SELECT * FROM todo_links WHERE todo_id IN (' . implode(',', $ids) . ')', []);
        }

        return [
            'projects' => $select('SELECT * FROM projects WHERE id = :id', $byProject),
            'project_notes' => $select('SELECT * FROM project_notes WHERE project_id = :id', $byProject),
            'project_contacts' => $select('SELECT * FROM project_contacts WHERE project_id = :id', $byProject),
            'project_tags' => $select('SELECT * FROM project_tags WHERE project_id = :id', $byProject),
            'project_documents' => $select('SELECT * FROM project_documents WHERE project_id = :id', $byProject),
            'todos' => $todos,
            'todo_links' => $links,
        ];
    }

    /**
     * Insert rows as they were. Only columns the table still has are written,
     * so a snapshot taken before a later schema change still restores.
     */
    private static function insertRows(PDO $db, string $table, array $rows): void
    {
        if (!$rows || !in_array($table, self::TABLES, true)) {
            return;
        }

        $columns = array_column($db->query('PRAGMA table_info(' . $table . ')')->fetchAll(PDO::FETCH_ASSOC), 'name');

        foreach ($rows as $row) {
            $row = array_intersect_key($row, array_flip($columns));
            if (!$row) {
                continue;
            }
            $names = array_keys($row);
            $sql = 'INSERT INTO ' . $table . ' (' . implode(', ', $names) . ') VALUES (:' . implode(', :', $names) . ')';
            $db->prepare($sql)->execute($row);
        }
    }
}
