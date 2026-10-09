<?php
/**
 * "New for you": what has been assigned to a person since they last looked.
 *
 * Every assignment to somebody is recorded as an event (api/assign.php, and
 * McpService when Claude assigns a record that is itself still a proposal).
 * Each person has a "seen up to" time in app_settings; the home page lists the
 * events after it, and "Got it" moves it to now.
 *
 * People are keyed as on the records themselves: users.id, or 0 for the owner
 * identity, which has no users row. NULL as the assigner means Claude or the
 * system - anyone but a team member.
 */
class AssignmentFeed
{
    /** Records an assignment can be about, and how to name one. */
    private const RECORDS = [
        'todo' => ['table' => 'todos', 'title' => 'title'],
        'project' => ['table' => 'projects', 'title' => 'name'],
        'contact' => ['table' => 'contacts', 'title' => 'name'],
        'bookkeeping' => ['table' => 'bookkeeping_rows', 'title' => 'row_date'],
    ];

    /** The most the home page lists at once; the rest are counted. */
    private const LIMIT = 20;

    /**
     * Note that a record was assigned to somebody. Nothing is noted when it
     * was unassigned, or when somebody assigned something to themselves.
     */
    public static function record(PDO $db, string $type, int $recordId, ?int $assignee, ?int $assignedBy, ?string $assignedByName): void
    {
        if ($assignee === null || !isset(self::RECORDS[$type]) || $assignedBy === $assignee) {
            return;
        }

        try {
            $db->prepare('
                INSERT INTO assignment_events (record_type, record_id, assigned_to, assigned_by, assigned_by_name)
                VALUES (:type, :id, :to, :by, :by_name)
            ')->execute([
                'type' => $type,
                'id' => $recordId,
                'to' => $assignee,
                'by' => $assignedBy,
                'by_name' => $assignedByName,
            ]);
        } catch (Throwable $e) {
            // The assignment itself has happened; only the notice is missing.
            error_log('assignment feed failed: ' . $e->getMessage());
        }
    }

    /**
     * What is new for a person: the records assigned to them since they last
     * looked, newest first, and still theirs - a to-do handed on again, or
     * finished, or deleted, is no longer news.
     *
     * @return array{items: array, total: int}
     */
    public static function news(PDO $db, int $person): array
    {
        $seen = self::seenAt($db, $person);
        if ($seen === null) {
            // The first look starts the clock rather than listing everything
            // ever assigned to them.
            self::markSeen($db, $person);
            return ['items' => [], 'total' => 0];
        }

        // The latest assignment of each record after the mark.
        $stmt = $db->prepare("
            SELECT e.record_type, e.record_id, e.assigned_by_name, e.created_at
            FROM assignment_events e
            WHERE e.assigned_to = :person AND e.created_at > :seen
              AND e.id = (
                  SELECT MAX(e2.id) FROM assignment_events e2
                  WHERE e2.record_type = e.record_type AND e2.record_id = e.record_id
              )
            ORDER BY e.created_at DESC, e.id DESC
        ");
        $stmt->execute(['person' => $person, 'seen' => $seen]);

        $items = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $event) {
            // Bookkeeping is for administrators only.
            if ($event['record_type'] === 'bookkeeping' && !Auth::isAdmin()) {
                continue;
            }
            $record = self::currentRecord($db, $event['record_type'], (int) $event['record_id'], $person);
            if ($record === null) {
                continue;
            }

            $items[] = [
                'type' => $event['record_type'],
                'id' => (int) $event['record_id'],
                'title' => $record['title'],
                'context' => $record['context'],
                'assigned_by_name' => $event['assigned_by_name'],
                'assigned_at' => $event['created_at'],
            ];
        }

        return ['items' => array_slice($items, 0, self::LIMIT), 'total' => count($items)];
    }

    public static function markSeen(PDO $db, int $person): void
    {
        $db->prepare("
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (:key, datetime('now'), CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        ")->execute(['key' => self::seenKey($person)]);
    }

    private static function seenAt(PDO $db, int $person): ?string
    {
        $stmt = $db->prepare('SELECT value FROM app_settings WHERE key = :key');
        $stmt->execute(['key' => self::seenKey($person)]);
        $value = $stmt->fetchColumn();

        return $value === false || $value === null || $value === '' ? null : (string) $value;
    }

    private static function seenKey(int $person): string
    {
        return 'assignments_seen_at:' . $person;
    }

    /**
     * The record as it is now - or null when it no longer belongs on the list:
     * gone, handed to somebody else, done, or still a proposal.
     *
     * @return array{title: string, context: ?string}|null
     */
    /**
     * A bank entry in words, as the home page's Bookkeeping list shows it:
     * its first three filled columns ("28.09.2026 · Alpenblick · 9600,00").
     */
    private static function bookkeepingSummary(PDO $db, string $json, string $date): string
    {
        $data = json_decode($json, true);
        $parts = [];
        if (is_array($data)) {
            $columns = $db->query('SELECT name FROM bookkeeping_columns ORDER BY position, id')->fetchAll(PDO::FETCH_COLUMN);
            foreach ($columns as $column) {
                $value = trim((string) ($data[$column] ?? ''));
                if ($value !== '' && count($parts) < 3) {
                    $parts[] = $value;
                }
            }
        }

        return $parts ? implode(' · ', $parts) : ('Bank entry' . ($date !== '' ? ' · ' . $date : ''));
    }

    private static function currentRecord(PDO $db, string $type, int $id, int $person): ?array
    {
        switch ($type) {
            case 'todo':
                $stmt = $db->prepare("
                    SELECT t.title, t.is_completed, t.assigned_to, t.review_status,
                           COALESCE(p.name, c.name) AS context
                    FROM todos t
                    LEFT JOIN projects p ON p.id = t.project_id
                    LEFT JOIN contacts c ON c.id = t.contact_id
                    WHERE t.id = :id
                ");
                break;
            case 'project':
                $stmt = $db->prepare("SELECT name AS title, assigned_to, review_status, company AS context FROM projects WHERE id = :id");
                break;
            case 'contact':
                $stmt = $db->prepare("SELECT name AS title, assigned_to, review_status, company AS context FROM contacts WHERE id = :id");
                break;
            case 'bookkeeping':
                $stmt = $db->prepare("SELECT row_date AS title, data, assigned_to, 'PDF missing' AS context FROM bookkeeping_rows WHERE id = :id");
                break;
            default:
                return null;
        }

        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row || $row['assigned_to'] === null || (int) $row['assigned_to'] !== $person) {
            return null;
        }
        if (($row['review_status'] ?? null) === 'pending' || (int) ($row['is_completed'] ?? 0) === 1) {
            return null;
        }

        $title = (string) $row['title'];
        if ($type === 'bookkeeping') {
            $title = self::bookkeepingSummary($db, (string) ($row['data'] ?? ''), $title);
        }

        return ['title' => $title, 'context' => $row['context'] ?? null];
    }
}
