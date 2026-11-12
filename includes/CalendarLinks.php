<?php
/**
 * Appointments linked to contacts and projects (spec, section 3)
 *
 * A link belongs to the CRM alone - it is never written to the calendar
 * server - and is keyed by the appointment's UID, so it stays when the
 * cache drops an old appointment's contents. Contact and project pages list
 * the linked appointments their viewer may see in full; what is hidden from
 * them does not appear at all.
 *
 * When a guest's address belongs to a contact in the CRM, the sheet
 * suggests linking that contact.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

require_once APP_ROOT . '/includes/CalendarView.php';

final class CalendarLinks
{
    public const TYPES = ['contact', 'project'];

    /** @return list<array{id: int, type: string, target_id: int, name: string, detail: ?string}> */
    public static function forEvent(string $uid): array
    {
        $stmt = Database::getInstance()->prepare("
            SELECT l.id, l.contact_id, l.project_id, c.name AS contact_name, c.company AS contact_company,
                   p.name AS project_name, p.company AS project_company
            FROM calendar_links l
            LEFT JOIN contacts c ON c.id = l.contact_id
            LEFT JOIN projects p ON p.id = l.project_id
            WHERE l.uid = :uid
            ORDER BY l.created_at, l.id
        ");
        $stmt->execute(['uid' => $uid]);
        $links = [];
        foreach ($stmt->fetchAll() as $row) {
            $isContact = $row['contact_id'] !== null;
            $links[] = [
                'id'        => (int) $row['id'],
                'type'      => $isContact ? 'contact' : 'project',
                'target_id' => (int) ($isContact ? $row['contact_id'] : $row['project_id']),
                'name'      => (string) ($isContact ? $row['contact_name'] : $row['project_name']),
                'detail'    => ($isContact ? $row['contact_company'] : $row['project_company']) ?: null,
            ];
        }
        return $links;
    }

    public static function add(string $uid, string $type, int $targetId, ?int $userId): void
    {
        if (!in_array($type, self::TYPES, true)) {
            throw new InvalidArgumentException('Link a contact or a project.');
        }
        $db = Database::getInstance();
        $table = $type === 'contact' ? 'contacts' : 'projects';
        $exists = $db->prepare("SELECT COUNT(*) FROM " . $table . " WHERE id = :id");
        $exists->execute(['id' => $targetId]);
        if ((int) $exists->fetchColumn() === 0) {
            throw new OutOfBoundsException('That ' . $type . ' does not exist.');
        }
        $column = $type === 'contact' ? 'contact_id' : 'project_id';
        $db->prepare("INSERT OR IGNORE INTO calendar_links (uid, " . $column . ", created_by) VALUES (:uid, :target, :user)")
            ->execute(['uid' => $uid, 'target' => $targetId, 'user' => $userId]);
    }

    /** @return ?string the UID the removed link belonged to */
    public static function remove(int $id): ?string
    {
        $db = Database::getInstance();
        $stmt = $db->prepare("SELECT uid FROM calendar_links WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $uid = $stmt->fetchColumn();
        if ($uid === false) {
            return null;
        }
        $db->prepare("DELETE FROM calendar_links WHERE id = :id")->execute(['id' => $id]);
        return (string) $uid;
    }

    public static function uidOf(int $id): ?string
    {
        $stmt = Database::getInstance()->prepare("SELECT uid FROM calendar_links WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $uid = $stmt->fetchColumn();
        return $uid === false ? null : (string) $uid;
    }

    public static function removeForEvent(string $uid): void
    {
        Database::getInstance()->prepare("DELETE FROM calendar_links WHERE uid = :uid")->execute(['uid' => $uid]);
    }

    /**
     * Contacts whose address is one of the guests' and that are not linked
     * yet - the sheet offers them.
     *
     * @param list<string> $emails
     * @return list<array{type: string, target_id: int, name: string, email: string}>
     */
    public static function suggestions(array $emails, string $uid): array
    {
        $emails = array_values(array_unique(array_filter(array_map(static function ($e): string {
            return strtolower(trim((string) $e));
        }, $emails))));
        if (!$emails) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($emails), '?'));
        $stmt = Database::getInstance()->prepare("
            SELECT c.id, c.name, LOWER(TRIM(c.email)) AS email
            FROM contacts c
            WHERE LOWER(TRIM(c.email)) IN (" . $placeholders . ")
              AND (c.review_status IS NULL OR c.review_status <> 'pending')
              AND NOT EXISTS (SELECT 1 FROM calendar_links l WHERE l.uid = ? AND l.contact_id = c.id)
            ORDER BY c.name COLLATE NOCASE
        ");
        $stmt->execute(array_merge($emails, [$uid]));
        return array_map(static function (array $row): array {
            return ['type' => 'contact', 'target_id' => (int) $row['id'], 'name' => (string) $row['name'], 'email' => (string) $row['email']];
        }, $stmt->fetchAll());
    }

    /**
     * Contacts and projects matching $query, for the link picker.
     *
     * @return list<array{type: string, target_id: int, name: string, detail: ?string}>
     */
    public static function targets(string $query): array
    {
        $query = trim($query);
        if (mb_strlen($query) < 1) {
            return [];
        }
        $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $query) . '%';
        $db = Database::getInstance();
        $contacts = $db->prepare("
            SELECT id, name, company, email FROM contacts
            WHERE (name LIKE :q1 ESCAPE '\\' OR company LIKE :q2 ESCAPE '\\' OR email LIKE :q3 ESCAPE '\\')
              AND (review_status IS NULL OR review_status <> 'pending')
            ORDER BY name COLLATE NOCASE LIMIT 8
        ");
        $contacts->execute(['q1' => $like, 'q2' => $like, 'q3' => $like]);
        $projects = $db->prepare("
            SELECT id, name, company FROM projects
            WHERE (name LIKE :q1 ESCAPE '\\' OR company LIKE :q2 ESCAPE '\\')
              AND (review_status IS NULL OR review_status <> 'pending')
            ORDER BY name COLLATE NOCASE LIMIT 8
        ");
        $projects->execute(['q1' => $like, 'q2' => $like]);

        $found = [];
        foreach ($contacts->fetchAll() as $row) {
            $found[] = ['type' => 'contact', 'target_id' => (int) $row['id'], 'name' => (string) $row['name'], 'detail' => ($row['company'] ?: $row['email']) ?: null];
        }
        foreach ($projects->fetchAll() as $row) {
            $found[] = ['type' => 'project', 'target_id' => (int) $row['id'], 'name' => (string) $row['name'], 'detail' => $row['company'] ?: null];
        }
        return $found;
    }

    /**
     * The appointments linked to a contact or project that $viewer may see:
     * per appointment the next occurrence (upcoming) or else the last one
     * (past). Appointments hidden from the viewer are left out entirely.
     *
     * @return array{upcoming: list<array>, past: list<array>, people: list<array>}
     */
    public static function appointments(string $type, int $targetId, array $viewer): array
    {
        if (!in_array($type, self::TYPES, true)) {
            throw new InvalidArgumentException('Appointments belong to a contact or a project.');
        }
        $column = $type === 'contact' ? 'contact_id' : 'project_id';
        $stmt = Database::getInstance()->prepare("SELECT DISTINCT uid FROM calendar_links WHERE " . $column . " = :id");
        $stmt->execute(['id' => $targetId]);
        $uids = $stmt->fetchAll(PDO::FETCH_COLUMN);

        $now = gmdate('Y-m-d\TH:i:s\Z');
        $today = (new DateTimeImmutable('today', new DateTimeZone(CALENDAR_TIMEZONE)))->format('Y-m-d');
        $next = [];
        $last = [];
        foreach (CalendarView::forUids($uids, $viewer) as $item) {
            if ($item['masked']) {
                continue;
            }
            $upcoming = $item['all_day'] ? $item['end'] > $today : $item['end'] > $now;
            $uid = $item['uid'];
            if ($upcoming) {
                if (!isset($next[$uid]) || $item['start'] < $next[$uid]['start']) {
                    $next[$uid] = $item;
                }
            } elseif (!isset($last[$uid]) || $item['start'] > $last[$uid]['start']) {
                $last[$uid] = $item;
            }
        }
        $past = array_values(array_diff_key($last, $next));
        $upcomingList = array_values($next);
        usort($upcomingList, static function (array $a, array $b): int {
            return strcmp(self::sortKey($a), self::sortKey($b));
        });
        usort($past, static function (array $a, array $b): int {
            return strcmp(self::sortKey($b), self::sortKey($a));
        });
        return [
            'upcoming' => array_slice($upcomingList, 0, 20),
            'past'     => array_slice($past, 0, 20),
            'people'   => CalendarView::people($viewer),
        ];
    }

    /** All-day dates and UTC times sort together. */
    private static function sortKey(array $item): string
    {
        return $item['all_day'] ? $item['start'] . 'T00:00:00Z' : $item['start'];
    }
}
