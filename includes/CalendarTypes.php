<?php
/**
 * What kind of appointment it is - online, external, at the office
 *
 * Kept in the CRM only (calendar_event_types), keyed by the appointment's
 * UID: a phone changing the appointment cannot lose it, and all copies of a
 * shared meeting share it. External appointments take travel time: they
 * show a buffer before and after in the grid, and "Find a free slot" keeps
 * it clear (working hours "external_buffer").
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

final class CalendarTypes
{
    public const TYPES = ['online', 'external', 'office'];

    public const LABELS = ['online' => 'Online', 'external' => 'External', 'office' => 'Office'];

    /** @var array<string, string>|null uid => type, read once per request */
    private static ?array $map = null;

    public static function of(string $uid): ?string
    {
        return self::all()[$uid] ?? null;
    }

    /** @return array<string, string> uid => type */
    public static function all(): array
    {
        if (self::$map === null) {
            self::$map = [];
            foreach (Database::getInstance()->query("SELECT uid, type FROM calendar_event_types")->fetchAll() as $row) {
                self::$map[(string) $row['uid']] = (string) $row['type'];
            }
        }
        return self::$map;
    }

    /** Null or '' takes the type away. */
    public static function set(string $uid, ?string $type, ?int $userId): void
    {
        $type = self::valid($type);
        $db = Database::getInstance();
        if ($type === null) {
            $db->prepare("DELETE FROM calendar_event_types WHERE uid = :uid")->execute(['uid' => $uid]);
        } else {
            $db->prepare("
                INSERT INTO calendar_event_types (uid, type, updated_by, updated_at) VALUES (:uid, :type, :user, CURRENT_TIMESTAMP)
                ON CONFLICT(uid) DO UPDATE SET type = excluded.type, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
            ")->execute(['uid' => $uid, 'type' => $type, 'user' => $userId]);
        }
        self::$map = null;
    }

    public static function remove(string $uid): void
    {
        self::set($uid, null, null);
    }

    /** A type as sent by the sheet: one of TYPES, or null for none. */
    public static function valid($type): ?string
    {
        if ($type === null || $type === '') {
            return null;
        }
        $type = strtolower(trim((string) $type));
        if (!in_array($type, self::TYPES, true)) {
            throw new InvalidArgumentException('The type is online, external or office.');
        }
        return $type;
    }

    /** Minutes kept clear before and after an appointment of this type. */
    public static function buffer(?string $type, array $workingHours): int
    {
        return $type === 'external' ? (int) ($workingHours['external_buffer'] ?? 0) : 0;
    }
}
