<?php
/**
 * Team calendar settings
 *
 * Which calendars there are, who they belong to, how each one shows to the
 * rest of the team, and the working hours "find a free slot" looks within.
 *
 * Admins configure everything. A calendar's owner may set how their own
 * calendars show to others (spec, section 3) and nothing else.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

require_once APP_ROOT . '/includes/CalendarView.php';

final class CalendarSettings
{
    private const WORKING_HOURS_KEY = 'calendar.working_hours';
    public const DEFAULT_WORKING_HOURS = ['days' => [1, 2, 3, 4, 5], 'start' => '08:00', 'end' => '18:00', 'buffer' => 30, 'external_buffer' => 45];
    /** Minutes "find a free slot" keeps clear before and after appointments. */
    public const BUFFERS = [0, 10, 15, 30, 45, 60];
    /** The same around external appointments (travel), shown in the grid too. */
    public const EXTERNAL_BUFFERS = [0, 15, 30, 45, 60, 90, 120];

    // =========================================================================
    // Working hours
    // =========================================================================

    /** @return array{days: list<int>, start: string, end: string, buffer: int, external_buffer: int} ISO weekdays, 1 = Monday. */
    public static function workingHours(): array
    {
        $stmt = Database::getInstance()->prepare("SELECT value FROM app_settings WHERE key = :key");
        $stmt->execute(['key' => self::WORKING_HOURS_KEY]);
        $stored = json_decode((string) $stmt->fetchColumn(), true);
        return is_array($stored) ? self::validWorkingHours($stored) ?? self::DEFAULT_WORKING_HOURS : self::DEFAULT_WORKING_HOURS;
    }

    public static function setWorkingHours(array $input): array
    {
        $hours = self::validWorkingHours($input);
        if ($hours === null) {
            throw new InvalidArgumentException('Working hours need at least one day, a start before the end (HH:MM), a buffer of ' . implode(', ', self::BUFFERS) . ' minutes and one of ' . implode(', ', self::EXTERNAL_BUFFERS) . ' around external appointments.');
        }
        Database::getInstance()->prepare("
            INSERT INTO app_settings (key, value, updated_at) VALUES (:key, :value, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        ")->execute(['key' => self::WORKING_HOURS_KEY, 'value' => json_encode($hours)]);
        return $hours;
    }

    private static function validWorkingHours(array $input): ?array
    {
        $days = array_values(array_unique(array_filter(array_map('intval', (array) ($input['days'] ?? [])), static function (int $d): bool {
            return $d >= 1 && $d <= 7;
        })));
        sort($days);
        $start = (string) ($input['start'] ?? '');
        $end = (string) ($input['end'] ?? '');
        $time = '/^([01]\d|2[0-3]):[0-5]\d$/';
        // Stored before there were buffers: the defaults.
        $buffer = array_key_exists('buffer', $input) ? $input['buffer'] : self::DEFAULT_WORKING_HOURS['buffer'];
        $external = array_key_exists('external_buffer', $input) ? $input['external_buffer'] : self::DEFAULT_WORKING_HOURS['external_buffer'];
        if (!$days || !preg_match($time, $start) || !preg_match($time, $end) || $start >= $end
            || !is_numeric($buffer) || !in_array((int) $buffer, self::BUFFERS, true)
            || !is_numeric($external) || !in_array((int) $external, self::EXTERNAL_BUFFERS, true)) {
            return null;
        }
        return ['days' => $days, 'start' => $start, 'end' => $end, 'buffer' => (int) $buffer, 'external_buffer' => (int) $external];
    }

    // =========================================================================
    // Calendars
    // =========================================================================

    /**
     * The calendars $viewer may configure: all of them for an admin, their
     * own for everyone else.
     */
    public static function sources(array $viewer): array
    {
        $rows = Database::getInstance()->query("
            SELECT s.id, s.owner_email, s.display_name, s.kind, s.visibility, s.enabled, s.writable,
                   s.last_synced_at, s.last_error,
                   (SELECT COUNT(*) FROM calendar_instances i WHERE i.source_id = s.id) AS occurrences,
                   COALESCE(p.position, 999) AS position
            FROM calendar_sources s
            LEFT JOIN calendar_people p ON p.email = s.owner_email
            ORDER BY position, s.owner_email, CASE s.kind WHEN 'work' THEN 0 ELSE 1 END, s.id
        ")->fetchAll();

        $sources = [];
        foreach ($rows as $row) {
            $owner = strtolower((string) $row['owner_email']);
            if (!$viewer['is_admin'] && !in_array($owner, $viewer['emails'], true)) {
                continue;
            }
            $sources[] = self::shapeSource($row);
        }
        return $sources;
    }

    public static function updateSource(int $id, array $input, array $viewer): array
    {
        $db = Database::getInstance();
        $stmt = $db->prepare("SELECT * FROM calendar_sources WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $source = $stmt->fetch();
        if (!$source) {
            throw new OutOfBoundsException('No such calendar.');
        }
        $isOwner = in_array(strtolower((string) $source['owner_email']), $viewer['emails'], true);
        if (!$viewer['is_admin'] && !$isOwner) {
            throw new DomainException('Only an admin or the calendar\'s owner can change it.');
        }

        $changes = [];
        if (array_key_exists('visibility', $input)) {
            if (!in_array($input['visibility'], CalendarView::VISIBILITIES, true)) {
                throw new InvalidArgumentException('Visibility must be details or private.');
            }
            $changes['visibility'] = $input['visibility'];
        }
        // Everything else is an admin's to change.
        foreach (['kind', 'enabled'] as $field) {
            if (array_key_exists($field, $input) && !$viewer['is_admin']) {
                throw new DomainException('Only an admin can change that.');
            }
        }
        if (array_key_exists('kind', $input)) {
            if (!in_array($input['kind'], CalendarView::KINDS, true)) {
                throw new InvalidArgumentException('Kind must be work or private.');
            }
            $changes['kind'] = $input['kind'];
        }
        if (array_key_exists('enabled', $input)) {
            $changes['enabled'] = $input['enabled'] ? 1 : 0;
        }
        if (!$changes) {
            return self::shapeSource($source + ['occurrences' => 0]);
        }

        Database::transactional(function (PDO $db) use ($id, $changes, $source) {
            $sets = [];
            foreach (array_keys($changes) as $field) {
                $sets[] = $field . ' = :' . $field;
            }
            $db->prepare("UPDATE calendar_sources SET " . implode(', ', $sets) . ", updated_at = CURRENT_TIMESTAMP WHERE id = :id")
                ->execute($changes + ['id' => $id]);

            // A calendar switched off keeps nothing in the CRM. Switched on
            // again, the next sync fetches it afresh.
            if (isset($changes['enabled']) && $changes['enabled'] === 0 && (int) $source['enabled'] === 1) {
                $db->prepare("DELETE FROM calendar_events WHERE source_id = :id")->execute(['id' => $id]);
                $db->prepare("UPDATE calendar_sources SET ctag = NULL, expanded_on = NULL WHERE id = :id")->execute(['id' => $id]);
            }
        });

        foreach (self::sources(['is_admin' => true, 'emails' => []]) as $shaped) {
            if ($shaped['id'] === $id) {
                return $shaped;
            }
        }
        throw new OutOfBoundsException('No such calendar.');
    }

    private static function shapeSource(array $row): array
    {
        return [
            'id'             => (int) $row['id'],
            'owner_email'    => strtolower((string) $row['owner_email']),
            'name'           => self::calendarName((string) ($row['display_name'] ?? ''), (string) $row['kind']),
            'kind'           => (string) $row['kind'],
            'visibility'     => (string) $row['visibility'],
            'enabled'        => (int) $row['enabled'] === 1,
            'writable'       => (int) $row['writable'] === 1,
            'last_synced_at' => $row['last_synced_at'] ?? null,
            'last_error'     => $row['last_error'] ?? null,
            'occurrences'    => (int) ($row['occurrences'] ?? 0),
        ];
    }

    /** "Public (livio@…)" -> "Public": the address is already shown beside it. */
    private static function calendarName(string $displayName, string $kind): string
    {
        $name = trim((string) preg_replace('/\s*\([^)]*@[^)]*\)\s*$/', '', $displayName));
        return $name !== '' ? $name : ($kind === 'work' ? 'Work' : 'Private');
    }

    // =========================================================================
    // People
    // =========================================================================

    /** Everyone with a calendar, with their CRM account mapping (admins). */
    public static function people(): array
    {
        // Named after the linked CRM account, as everywhere in the calendar.
        $rows = Database::getInstance()->query("
            SELECT p.email, p.user_id, COALESCE(NULLIF(u.name, ''), p.name) AS name, p.color, p.position
            FROM calendar_people p
            LEFT JOIN users u ON u.id = p.user_id
            ORDER BY p.position, name COLLATE NOCASE
        ")->fetchAll();
        return array_map(static function (array $row): array {
            return [
                'email'    => strtolower((string) $row['email']),
                'user_id'  => $row['user_id'] !== null ? (int) $row['user_id'] : null,
                'name'     => (string) $row['name'],
                'initials' => CalendarView::initials((string) $row['name']),
                'color'    => (string) $row['color'],
                'position' => (int) $row['position'],
            ];
        }, $rows);
    }

    /** CRM accounts a person can be mapped to. */
    public static function accounts(): array
    {
        return Database::getInstance()->query("
            SELECT id, name, email FROM users WHERE status = 'active' ORDER BY name COLLATE NOCASE
        ")->fetchAll();
    }

    public static function updatePerson(string $email, array $input): array
    {
        $db = Database::getInstance();
        $stmt = $db->prepare("SELECT * FROM calendar_people WHERE email = :email");
        $stmt->execute(['email' => $email]);
        $person = $stmt->fetch();
        if (!$person) {
            throw new OutOfBoundsException('No such person.');
        }

        $changes = [];
        if (array_key_exists('name', $input)) {
            $name = trim((string) $input['name']);
            if ($name === '' || mb_strlen($name) > 80) {
                throw new InvalidArgumentException('The name must be 1 to 80 characters.');
            }
            $changes['name'] = $name;
        }
        if (array_key_exists('color', $input)) {
            if (!preg_match('/^#[0-9A-Fa-f]{6}$/', (string) $input['color'])) {
                throw new InvalidArgumentException('The colour must look like #30599D.');
            }
            $changes['color'] = strtoupper((string) $input['color']);
        }
        if (array_key_exists('user_id', $input)) {
            $userId = $input['user_id'] === null || $input['user_id'] === '' ? null : (int) $input['user_id'];
            if ($userId !== null) {
                $exists = $db->prepare("SELECT COUNT(*) FROM users WHERE id = :id");
                $exists->execute(['id' => $userId]);
                if ((int) $exists->fetchColumn() === 0) {
                    throw new InvalidArgumentException('No such CRM account.');
                }
                // One account, one person: else both carry that account's
                // name, and whoever signs in with it is both of them.
                $taken = $db->prepare("SELECT COALESCE(NULLIF(name, ''), email) FROM calendar_people WHERE user_id = :id AND email <> :email LIMIT 1");
                $taken->execute(['id' => $userId, 'email' => $email]);
                $other = $taken->fetchColumn();
                if ($other !== false) {
                    throw new InvalidArgumentException('That account already belongs to ' . $other . '.');
                }
            }
            $changes['user_id'] = $userId;
        }

        Database::transactional(function (PDO $db) use ($email, $changes, $input, $person) {
            if ($changes) {
                $sets = [];
                foreach (array_keys($changes) as $field) {
                    $sets[] = $field . ' = :' . $field;
                }
                $db->prepare("UPDATE calendar_people SET " . implode(', ', $sets) . ", updated_at = CURRENT_TIMESTAMP WHERE email = :email")
                    ->execute($changes + ['email' => $email]);
            }
            // Moving a column left or right swaps it with its neighbour.
            if (in_array($input['move'] ?? null, ['up', 'down'], true)) {
                $order = $db->query("SELECT email FROM calendar_people ORDER BY position, name COLLATE NOCASE")->fetchAll(PDO::FETCH_COLUMN);
                $index = array_search($person['email'], $order, true);
                $target = $input['move'] === 'up' ? $index - 1 : $index + 1;
                if ($index !== false && $target >= 0 && $target < count($order)) {
                    [$order[$index], $order[$target]] = [$order[$target], $order[$index]];
                }
                $update = $db->prepare("UPDATE calendar_people SET position = :position WHERE email = :email");
                foreach ($order as $position => $personEmail) {
                    $update->execute(['position' => $position, 'email' => $personEmail]);
                }
            }
        });

        foreach (self::people() as $shaped) {
            if ($shaped['email'] === strtolower($email)) {
                return $shaped;
            }
        }
        throw new OutOfBoundsException('No such person.');
    }
}

/**
 * Common free time of several people, inside working hours, keeping the
 * buffer (working hours "buffer", in minutes) clear before and after every
 * appointment - around external ones the longer of it and "external_buffer"
 * (travel).
 *
 * Reads every calendar of each person, hidden ones included, but hands back
 * only the gaps - never what fills the rest.
 */
final class CalendarAvailability
{
    /** Longest range one search may cover, in days. */
    public const MAX_DAYS = 31;

    /**
     * @param list<string> $emails
     * @return list<array{start: string, end: string, minutes: int}> ISO UTC
     */
    public static function freeSlots(array $emails, int $minutes, string $fromDate, string $toDate, array $workingHours, ?int $now = null): array
    {
        $zone = new DateTimeZone(CALENDAR_TIMEZONE);
        $now = $now ?? time();
        // Nothing starts in the past; from now on, on the next quarter hour.
        $earliest = (int) (ceil($now / 900) * 900);

        $buffer = max(0, (int) ($workingHours['buffer'] ?? 0)) * 60;
        $external = max($buffer, (int) ($workingHours['external_buffer'] ?? 0) * 60);
        $busy = [];
        foreach (CalendarView::busy($emails, $fromDate, $toDate) as $intervals) {
            foreach ($intervals as [$start, $end, $type]) {
                $around = $type === 'external' ? $external : $buffer;
                $busy[] = [$start - $around, $end + $around];
            }
        }
        $busy = self::merge($busy);

        $slots = [];
        $day = new DateTimeImmutable($fromDate, $zone);
        $last = new DateTimeImmutable($toDate, $zone);
        for (; $day < $last; $day = $day->modify('+1 day')) {
            if (!in_array((int) $day->format('N'), $workingHours['days'], true)) {
                continue;
            }
            $windowStart = max($earliest, self::at($day, $workingHours['start'])->getTimestamp());
            $windowEnd = self::at($day, $workingHours['end'])->getTimestamp();
            if ($windowEnd - $windowStart < $minutes * 60) {
                continue;
            }
            $cursor = $windowStart;
            foreach ($busy as [$start, $end]) {
                if ($end <= $cursor) {
                    continue;
                }
                if ($start >= $windowEnd) {
                    break;
                }
                if ($start - $cursor >= $minutes * 60) {
                    $slots[] = self::slot($cursor, $start);
                }
                $cursor = max($cursor, $end);
                if ($cursor >= $windowEnd) {
                    break;
                }
            }
            if ($windowEnd - $cursor >= $minutes * 60) {
                $slots[] = self::slot($cursor, $windowEnd);
            }
        }
        return $slots;
    }

    /** @param list<array{0: int, 1: int}> $intervals */
    private static function merge(array $intervals): array
    {
        usort($intervals, static function (array $a, array $b): int {
            return $a[0] <=> $b[0];
        });
        $merged = [];
        foreach ($intervals as [$start, $end]) {
            if ($merged && $start <= $merged[count($merged) - 1][1]) {
                $merged[count($merged) - 1][1] = max($merged[count($merged) - 1][1], $end);
            } else {
                $merged[] = [$start, $end];
            }
        }
        return $merged;
    }

    /** A local wall-clock time on a given day (DST-safe). */
    private static function at(DateTimeImmutable $day, string $time): DateTimeImmutable
    {
        [$hour, $minute] = array_map('intval', explode(':', $time));
        return $day->setTime($hour, $minute);
    }

    private static function slot(int $start, int $end): array
    {
        return [
            'start'   => gmdate('Y-m-d\TH:i:s\Z', $start),
            'end'     => gmdate('Y-m-d\TH:i:s\Z', $end),
            'minutes' => intdiv($end - $start, 60),
        ];
    }
}
