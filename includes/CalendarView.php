<?php
/**
 * What a viewer may see of the team calendar
 *
 * Every privacy rule of docs/kalender-spec.md (section 3) is applied here, on
 * the server, before anything leaves for the browser, an API or the MCP:
 *
 *   - A calendar set to "private" shows everyone but its owner the time
 *     only, titled Private: no title, place, description, link or
 *     participants.
 *   - CLASS:PRIVATE and CLASS:CONFIDENTIAL count as private, whatever the
 *     calendar is set to.
 *   - Your own calendars you always see in full.
 *
 * Appointments with the same UID in several calendars (a shared meeting) are
 * shown once. Masked occurrences are never merged: putting two people's
 * "Private" blocks together by UID would tell who meets whom.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

require_once APP_ROOT . '/includes/CalendarIcs.php';

final class CalendarView
{
    public const VISIBILITIES = ['details', 'private'];
    public const KINDS = ['work', 'private'];

    private const PRIVATE_CLASSES = ['PRIVATE', 'CONFIDENTIAL'];

    /**
     * The signed-in identity's calendar rights and addresses.
     *
     * @return array{user_id: ?int, is_owner: bool, is_admin: bool, can_view: bool, can_edit: bool, emails: list<string>}
     */
    public static function viewer(): array
    {
        $none = ['user_id' => null, 'is_owner' => false, 'is_admin' => false, 'can_view' => false, 'can_edit' => false, 'emails' => []];
        $user = Auth::currentUser();
        if ($user === null) {
            return $none;
        }
        // The owner login is the recovery account: always an admin, never
        // anybody's calendar.
        if (!empty($user['is_owner'])) {
            return ['user_id' => null, 'is_owner' => true, 'is_admin' => true, 'can_view' => true, 'can_edit' => true, 'emails' => []];
        }

        $db = Database::getInstance();
        $stmt = $db->prepare("SELECT email, role, can_calendar, can_calendar_edit FROM users WHERE id = :id AND status = 'active'");
        $stmt->execute(['id' => (int) $user['id']]);
        $row = $stmt->fetch();
        if (!$row) {
            return $none;
        }

        // Your calendars: the people mapped to your account, and your own
        // address in case the mapping has not been made yet.
        $emails = [strtolower((string) $row['email'])];
        $mapped = $db->prepare("SELECT email FROM calendar_people WHERE user_id = :id");
        $mapped->execute(['id' => (int) $user['id']]);
        foreach ($mapped->fetchAll(PDO::FETCH_COLUMN) as $email) {
            $emails[] = strtolower((string) $email);
        }

        return [
            'user_id'  => (int) $user['id'],
            'is_owner' => false,
            'is_admin' => $row['role'] === User::ROLE_ADMIN,
            'can_view' => (int) $row['can_calendar'] === 1,
            'can_edit' => (int) $row['can_calendar_edit'] === 1,
            'emails'   => array_values(array_unique($emails)),
        ];
    }

    /**
     * The people who have at least one enabled calendar, in the team's order,
     * with the profile picture of the CRM account each one is mapped to.
     *
     * @return list<array{email: string, name: string, initials: string, position: int, is_me: bool, avatar_url: ?string}>
     */
    public static function people(array $viewer): array
    {
        // The name is the linked CRM account's; only someone without an
        // account keeps the name the calendar was found with.
        $rows = Database::getInstance()->query("
            SELECT p.email, COALESCE(NULLIF(u.name, ''), p.name) AS name, p.position, p.user_id, u.avatar
            FROM calendar_people p
            LEFT JOIN users u ON u.id = p.user_id
            WHERE EXISTS (SELECT 1 FROM calendar_sources s WHERE s.owner_email = p.email AND s.enabled = 1)
            ORDER BY p.position, name COLLATE NOCASE
        ")->fetchAll();

        return array_map(static function (array $row) use ($viewer): array {
            $email = strtolower((string) $row['email']);
            $name = (string) ($row['name'] ?: $email);
            return [
                'email'      => $email,
                'name'       => $name,
                'initials'   => self::initials($name),
                'position'   => (int) $row['position'],
                'is_me'      => in_array($email, $viewer['emails'], true),
                'avatar_url' => $row['user_id'] !== null && $row['avatar']
                    ? self::avatarUrl((int) $row['user_id'], (string) $row['avatar']) : null,
            ];
        }, $rows);
    }

    /**
     * The same picture URL api/profile.php hands out: the v= fingerprint
     * changes with every new upload, so browsers may cache it for long.
     */
    private static function avatarUrl(int $userId, string $storedName): string
    {
        return 'api/profile.php?action=avatar&id=' . $userId . '&v=' . substr(hash('sha256', $storedName), 0, 12);
    }

    /**
     * Every occurrence overlapping [$fromDate, $toDate), local dates in
     * CALENDAR_TIMEZONE, filtered and merged for $viewer.
     *
     * @return list<array>
     */
    public static function range(string $fromDate, string $toDate, array $viewer): array
    {
        return self::items(self::instances($fromDate, $toDate), $viewer);
    }

    /**
     * Every occurrence the cache holds of these appointments, as $viewer may
     * see them - the contact and project pages list linked appointments
     * with it.
     *
     * @param list<string> $uids
     * @return list<array>
     */
    public static function forUids(array $uids, array $viewer): array
    {
        $uids = array_values(array_unique(array_filter(array_map('strval', $uids))));
        if (!$uids) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($uids), '?'));
        $stmt = Database::getInstance()->prepare("
            SELECT i.*, s.owner_email, s.visibility, s.kind
            FROM calendar_instances i
            JOIN calendar_sources s ON s.id = i.source_id
            WHERE s.enabled = 1 AND (i.status IS NULL OR i.status <> 'CANCELLED') AND i.uid IN (" . $placeholders . ")
            ORDER BY i.starts_at
        ");
        $stmt->execute($uids);
        return self::items($stmt->fetchAll(), $viewer);
    }

    /** Filter, mask and merge raw occurrences for $viewer. */
    private static function items(array $rows, array $viewer): array
    {
        $people = self::people($viewer);
        $team = array_column($people, 'email');

        $groups = [];
        $hidden = [];
        foreach ($rows as $row) {
            $owner = strtolower((string) $row['owner_email']);
            $details = in_array($owner, $viewer['emails'], true)
                || ($row['visibility'] === 'details' && !in_array(strtoupper((string) $row['class']), self::PRIVATE_CLASSES, true));
            $key = ($row['uid'] ?: 'event-' . $row['event_id']) . '|' . ($row['recurrence_id'] ?? $row['starts_at']);

            if (!$details) {
                // A free entry in a hidden calendar says nothing worth showing.
                if ((int) $row['transparent'] !== 1) {
                    $hidden[] = [$key, $row, $owner];
                }
                continue;
            }
            $groups[$key][] = $row;
        }

        $items = [];
        foreach ($groups as $group) {
            $item = self::merged($group, $team);
            // Yours: in your calendar, or you take part (and did not decline).
            $item['mine'] = (bool) array_intersect(array_merge($item['owners'], $item['people']), $viewer['emails']);
            $items[] = $item;
        }
        // A hidden copy of an appointment the viewer already sees in full -
        // someone's own copy of a shared meeting - would only show it twice.
        foreach ($hidden as [$key, $row, $owner]) {
            if (!isset($groups[$key])) {
                $items[] = self::masked($row, $owner);
            }
        }

        usort($items, static function (array $a, array $b): int {
            return [$a['start'], $a['end']] <=> [$b['start'], $b['end']];
        });
        return $items;
    }

    /**
     * Busy intervals per person, for finding free time. Uses every calendar
     * of the person, hidden ones included - but returns times only.
     *
     * @param list<string> $emails
     * @return array<string, list<array{0: int, 1: int}>> email => [[start, end] unix seconds]
     */
    public static function busy(array $emails, string $fromDate, string $toDate): array
    {
        $zone = new DateTimeZone(CALENDAR_TIMEZONE);
        $busy = array_fill_keys($emails, []);
        foreach (self::instances($fromDate, $toDate) as $row) {
            $owner = strtolower((string) $row['owner_email']);
            if (!isset($busy[$owner]) || (int) $row['transparent'] === 1) {
                continue;
            }
            if ((int) $row['all_day'] === 1) {
                $start = (new DateTimeImmutable($row['starts_at'], $zone))->getTimestamp();
                $end = (new DateTimeImmutable($row['ends_at'], $zone))->getTimestamp();
            } else {
                $start = (new DateTimeImmutable($row['starts_at'], new DateTimeZone('UTC')))->getTimestamp();
                $end = (new DateTimeImmutable($row['ends_at'], new DateTimeZone('UTC')))->getTimestamp();
            }
            $busy[$owner][] = [$start, max($start, $end)];
        }
        return $busy;
    }

    // -------------------------------------------------------------------------

    /** Raw occurrences in the range from enabled calendars, cancelled ones left out. */
    private static function instances(string $fromDate, string $toDate): array
    {
        $zone = new DateTimeZone(CALENDAR_TIMEZONE);
        $utc = new DateTimeZone('UTC');
        $from = new DateTimeImmutable($fromDate, $zone);
        $to = new DateTimeImmutable($toDate, $zone);

        $stmt = Database::getInstance()->prepare("
            SELECT i.*, s.owner_email, s.visibility, s.kind
            FROM calendar_instances i
            JOIN calendar_sources s ON s.id = i.source_id
            WHERE s.enabled = 1
              AND (i.status IS NULL OR i.status <> 'CANCELLED')
              AND (
                    (i.all_day = 0 AND i.starts_at < :to_utc AND i.ends_at > :from_utc)
                 OR (i.all_day = 1 AND i.starts_at < :to_date AND i.ends_at > :from_date)
                 OR (i.all_day = 0 AND i.starts_at = i.ends_at AND i.starts_at >= :from_utc2 AND i.starts_at < :to_utc2)
              )
            ORDER BY i.starts_at
        ");
        $stmt->execute([
            'from_utc'  => $from->setTimezone($utc)->format('Y-m-d H:i:s'),
            'to_utc'    => $to->setTimezone($utc)->format('Y-m-d H:i:s'),
            'from_utc2' => $from->setTimezone($utc)->format('Y-m-d H:i:s'),
            'to_utc2'   => $to->setTimezone($utc)->format('Y-m-d H:i:s'),
            'from_date' => $from->format('Y-m-d'),
            'to_date'   => $to->format('Y-m-d'),
        ]);
        return $stmt->fetchAll();
    }

    /** An occurrence the viewer may only see as a time slot. */
    private static function masked(array $row, string $owner): array
    {
        return self::times($row) + [
            'id'          => 'i' . $row['id'],
            'masked'      => true,
            'title'       => 'Private',
            'location'    => null,
            'description' => null,
            'video_url'   => null,
            'people'      => [$owner],
            'owners'      => [$owner],
            'organizer'   => null,
            'attendees'   => [],
            'externals'   => 0,
            'transparent' => false,
            'mine'        => false,
        ];
    }

    /** The copies of one appointment in several calendars, shown once. */
    private static function merged(array $group, array $team): array
    {
        // In the team's column order, so the same meeting reads the same way.
        $owners = array_values(array_unique(array_map(static function (array $row): string {
            return strtolower((string) $row['owner_email']);
        }, $group)));
        $owners = array_values(array_unique(array_merge(array_intersect($team, $owners), $owners)));

        // The organizer's copy is the original (spec, section 4).
        $main = $group[0];
        foreach ($group as $row) {
            $organizer = json_decode((string) $row['organizer'], true);
            if (is_array($organizer) && in_array(strtolower((string) ($organizer['email'] ?? '')), $owners, true)
                && strtolower((string) ($organizer['email'] ?? '')) === strtolower((string) $row['owner_email'])) {
                $main = $row;
                break;
            }
        }

        $organizer = json_decode((string) $main['organizer'], true);
        $attendees = json_decode((string) $main['attendees'], true);
        $attendees = is_array($attendees) ? $attendees : [];

        $people = $owners;
        $externals = 0;
        $list = [];
        foreach ($attendees as $attendee) {
            $email = strtolower((string) ($attendee['email'] ?? ''));
            $isTeam = in_array($email, $team, true);
            if ($isTeam && ($attendee['partstat'] ?? '') !== 'DECLINED') {
                $people[] = $email;
            }
            if (!$isTeam && $email !== strtolower((string) ($organizer['email'] ?? ''))) {
                $externals++;
            }
            $list[] = [
                'email'    => $email,
                'name'     => $attendee['name'] ?? null,
                'partstat' => $attendee['partstat'] ?? 'NEEDS-ACTION',
                'team'     => $isTeam,
            ];
        }
        $people = array_values(array_intersect($team, array_unique($people)));
        if (!$people) {
            $people = $owners;
        }

        return self::times($main) + [
            'id'          => 'i' . $main['id'],
            // What the sheet opens it by: the appointment and, in a series,
            // which occurrence. Never sent for a masked one.
            'uid'         => (string) $main['uid'],
            'occurrence'  => $main['recurrence_id'],
            'masked'      => false,
            'title'       => $main['summary'] ?: '(No title)',
            'location'    => $main['location'],
            'description' => $main['description'],
            'video_url'   => CalendarIcs::videoLink($main['location'], $main['url'], $main['description']),
            'people'      => $people,
            'owners'      => $owners,
            'organizer'   => is_array($organizer) ? ['email' => $organizer['email'] ?? null, 'name' => $organizer['name'] ?? null] : null,
            'attendees'   => $list,
            'externals'   => $externals,
            'transparent' => (int) $main['transparent'] === 1,
        ];
    }

    /** Start and end as the client needs them: ISO UTC, or plain dates for all-day. */
    private static function times(array $row): array
    {
        if ((int) $row['all_day'] === 1) {
            return ['all_day' => true, 'start' => (string) $row['starts_at'], 'end' => (string) $row['ends_at']];
        }
        $utc = new DateTimeZone('UTC');
        return [
            'all_day' => false,
            'start'   => (new DateTimeImmutable($row['starts_at'], $utc))->format('Y-m-d\TH:i:s\Z'),
            'end'     => (new DateTimeImmutable($row['ends_at'], $utc))->format('Y-m-d\TH:i:s\Z'),
        ];
    }

    public static function initials(string $name): string
    {
        $parts = preg_split('/[\s.\-]+/u', trim($name), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        if (!$parts) {
            return '?';
        }
        $first = mb_strtoupper(mb_substr($parts[0], 0, 1));
        $last = count($parts) > 1 ? mb_strtoupper(mb_substr($parts[count($parts) - 1], 0, 1)) : '';
        return $first . $last;
    }
}
