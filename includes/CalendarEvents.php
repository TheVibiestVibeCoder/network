<?php
/**
 * Appointments made and changed in the CRM (phase 2 of docs/kalender-spec.md)
 *
 * Everything is written to the calendar server first and to the cache right
 * after, so the CRM shows the change at once and the iPhones on their next
 * sync. Writing goes through the shared calendar account, which never makes
 * the server send mail (phase 0).
 *
 *   - New appointments go into the organizer's work calendar; every other
 *     team member taking part gets a copy (CalendarCopies).
 *   - The server ignores If-Match (phase 0), so before every change the CRM
 *     reads the appointment as it is now and compares it with what the
 *     person editing saw ("base", the content hash). If somebody changed it
 *     meanwhile - on a phone or in the CRM - nothing is written: the person
 *     gets the new version and decides (CalendarConflict).
 *   - Moving and cancelling: the organizer, or anyone with the "edit" right
 *     (spec, section 3). Answering: the team members invited.
 *   - Into another calendar: the appointment is written into the new
 *     organizer's work calendar and leaves the old one - unless its owner
 *     stays in it, then theirs becomes a copy.
 *   - Its type (online, external, office) lives in the CRM only
 *     (CalendarTypes); changing just that never touches the server.
 *   - In a series: the whole series, or one occurrence.
 *
 * Guests from outside the team (phase 4) are not invited from here; those a
 * phone put into an appointment stay in it untouched.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

require_once APP_ROOT . '/includes/CalendarSync.php';
require_once APP_ROOT . '/includes/CalendarView.php';
require_once APP_ROOT . '/includes/CalendarStore.php';
require_once APP_ROOT . '/includes/CalendarCopies.php';
require_once APP_ROOT . '/includes/CalendarIcsWriter.php';
require_once APP_ROOT . '/includes/CalendarLinks.php';
require_once APP_ROOT . '/includes/CalendarTypes.php';

/** Somebody else changed or deleted the appointment while it was being edited. */
final class CalendarConflict extends RuntimeException
{
    /** 'changed' | 'deleted' */
    public string $kind;

    public function __construct(string $kind)
    {
        $this->kind = $kind;
        parent::__construct($kind === 'deleted'
            ? 'This appointment was deleted in the meantime.'
            : 'This appointment was changed in the meantime.');
    }
}

final class CalendarEvents
{
    public const ANSWERS = ['ACCEPTED', 'TENTATIVE', 'DECLINED'];

    /** Longest appointment the sheet makes. */
    private const MAX_DAYS = 62;

    private CalendarStore $store;
    private CalendarSync $cache;
    private CalendarCopies $copies;
    private PDO $db;

    public function __construct(CalendarStore $store)
    {
        $this->store = $store;
        $this->cache = new CalendarSync($store->server());
        $this->copies = new CalendarCopies($store, $this->cache);
        $this->db = Database::getInstance();
    }

    public static function fromConfig(): self
    {
        return new self(CalendarStore::fromConfig());
    }

    // =========================================================================
    // Reading
    // =========================================================================

    /**
     * Everything the sheet shows of one appointment, as $viewer may see it.
     * Hidden from them (Private) is the same as not there.
     */
    public function sheet(string $uid, ?string $occurrence, array $viewer): array
    {
        $rows = $this->rows($uid);
        $visible = $this->visibleRow($rows, $viewer);
        if ($visible === null) {
            throw new OutOfBoundsException('This appointment is not in the calendar (any more).');
        }
        $original = $this->original($rows);
        $instance = $this->instance((int) $visible['id'], $occurrence)
            ?? ($original !== null ? $this->instance((int) $original['id'], $occurrence) : null);
        if ($instance === null) {
            throw new OutOfBoundsException('This occurrence is not in the calendar (any more).');
        }
        // One occurrence marked private on the phone stays private, even in
        // a series everyone may see.
        $own = in_array(strtolower((string) $visible['owner_email']), $viewer['emails'], true);
        if (!$own && in_array(strtoupper((string) $instance['class']), ['PRIVATE', 'CONFIDENTIAL'], true)) {
            throw new OutOfBoundsException('This appointment is not in the calendar (any more).');
        }

        $zone = new DateTimeZone(CALENDAR_TIMEZONE);
        $team = [];
        foreach (CalendarView::people($viewer) as $person) {
            $team[$person['email']] = $person;
        }
        $organizer = json_decode((string) $instance['organizer'], true);
        $organizerEmail = is_array($organizer) ? strtolower((string) ($organizer['email'] ?? '')) : '';
        $attendees = [];
        $guests = [];
        foreach ((array) json_decode((string) $instance['attendees'], true) as $attendee) {
            $email = strtolower((string) ($attendee['email'] ?? ''));
            if ($email === '') {
                continue;
            }
            $entry = [
                'email'     => $email,
                'name'      => isset($team[$email]) ? $team[$email]['name'] : ($attendee['name'] ?? null),
                'answer'    => $email === $organizerEmail ? 'ORGANIZER' : ($attendee['partstat'] ?? 'NEEDS-ACTION'),
                'organizer' => $email === $organizerEmail,
            ];
            if (isset($team[$email])) {
                $attendees[] = $entry;
            } elseif ($email !== $organizerEmail) {
                $guests[] = $entry;
            }
        }
        if (!$attendees && $original !== null) {
            // A plain appointment: the calendar's owner is the one in it.
            $owner = strtolower((string) $original['owner_email']);
            if (isset($team[$owner])) {
                $attendees[] = ['email' => $owner, 'name' => $team[$owner]['name'], 'answer' => 'ORGANIZER', 'organizer' => true];
            }
        }

        $base = $original ?? $visible;
        $details = CalendarIcsWriter::details((string) $base['ics']);
        $allDay = (int) $instance['all_day'] === 1;
        if ($allDay) {
            $start = (string) $instance['starts_at'];
            $end = (new DateTimeImmutable((string) $instance['ends_at'], $zone))->modify('-1 day')->format('Y-m-d');
            $past = (string) $instance['ends_at'] <= (new DateTimeImmutable('today', $zone))->format('Y-m-d');
        } else {
            $utc = new DateTimeZone('UTC');
            $start = (new DateTimeImmutable((string) $instance['starts_at'], $utc))->setTimezone($zone)->format('Y-m-d\TH:i');
            $end = (new DateTimeImmutable((string) $instance['ends_at'], $utc))->setTimezone($zone)->format('Y-m-d\TH:i');
            $past = (new DateTimeImmutable((string) $instance['ends_at'], $utc)) <= new DateTimeImmutable('now', $utc);
        }

        $myAnswer = null;
        foreach ($attendees as $attendee) {
            if (!$attendee['organizer'] && in_array($attendee['email'], $viewer['emails'], true)) {
                $myAnswer = $attendee['answer'];
            }
        }
        $can = $this->permissions($original, $viewer, $myAnswer !== null);
        $can['reason'] = $can['edit'] ? null : $this->readOnlyReason($original, $visible, $organizerEmail, $team, $viewer);
        $calendarOwner = strtolower((string) ($original ?? $visible)['owner_email']);

        return [
            'uid'             => $uid,
            'occurrence'      => $instance['recurrence_id'],
            'title'           => (string) ($instance['summary'] ?: '(No title)'),
            'all_day'         => $allDay,
            'start'           => $start,
            'end'             => $end,
            'past'            => $past,
            'location'        => $instance['location'],
            'description'     => $instance['description'],
            'url'             => $instance['url'],
            'type'            => CalendarTypes::of($uid),
            'video_url'       => CalendarIcs::videoLink($instance['location'], $instance['url'], $instance['description']),
            'organizer'       => $organizerEmail !== ''
                ? ['email' => $organizerEmail, 'name' => isset($team[$organizerEmail]) ? $team[$organizerEmail]['name'] : ($organizer['name'] ?? null), 'team' => isset($team[$organizerEmail])]
                : null,
            'calendar'        => ['email' => $calendarOwner, 'name' => isset($team[$calendarOwner]) ? $team[$calendarOwner]['name'] : $calendarOwner],
            'attendees'       => $attendees,
            'guests'          => $guests,
            'series'          => $details['series'],
            'repeat'          => $details['repeat'],
            'repeat_custom'   => $details['repeat_custom'],
            'movable_days'    => $details['movable_days'],
            'reminder'        => $details['reminder'],
            'reminder_custom' => $details['reminder_custom'],
            'base'            => (string) $base['content_hash'],
            'my_answer'       => $myAnswer,
            'can'             => $can,
            'links'           => CalendarLinks::forEvent($uid),
            'suggestions'     => CalendarLinks::suggestions(array_column($guests, 'email'), $uid),
        ];
    }

    /** Whether $viewer may see this appointment in full (and so link it). */
    public function visible(string $uid, array $viewer): bool
    {
        return $this->visibleRow($this->rows($uid), $viewer) !== null;
    }

    /**
     * The calendars a new appointment can go into: each team member's work
     * calendar the shared account may write.
     *
     * @return list<array{email: string, name: string, mine: bool}>
     */
    public function writableCalendars(array $viewer): array
    {
        $list = [];
        $work = $this->workCalendars();
        foreach (CalendarView::people($viewer) as $person) {
            $source = $work[$person['email']] ?? null;
            if ($source !== null && (int) $source['writable'] === 1 && $this->store->reaches((string) $source['href'])) {
                $list[] = ['email' => $person['email'], 'name' => $person['name'], 'mine' => $person['is_me']];
            }
        }
        return $list;
    }

    // =========================================================================
    // Writing
    // =========================================================================

    /**
     * A new appointment, from the sheet's fields.
     *
     * @return array{uid: string, occurrence: ?string, warnings: list<string>}
     */
    public function create(array $input, array $viewer): array
    {
        if (!$viewer['can_edit']) {
            throw new DomainException('You may not add appointments to the team calendar.');
        }
        $team = $this->team($viewer);
        $work = $this->workCalendars();
        $organizer = strtolower(trim((string) ($input['organizer'] ?? '')));
        if ($organizer === '') {
            foreach ($viewer['emails'] as $email) {
                if (isset($work[$email])) {
                    $organizer = $email;
                    break;
                }
            }
        }
        $source = $this->targetCalendar($organizer, $team, $work);
        $type = CalendarTypes::valid($input['type'] ?? null);

        $fields = $this->fields($input, true);
        $repeat = array_key_exists('repeat', $fields) ? $fields['repeat'] : null;
        $uid = CalendarIcsWriter::uuid();
        $ics = CalendarIcsWriter::create([
            'uid'         => $uid,
            'title'       => $fields['title'],
            'all_day'     => $fields['all_day'],
            'start'       => $fields['start'],
            'end'         => $fields['end'],
            'location'    => $fields['location'],
            'description' => $fields['description'],
            'url'         => $fields['url'],
            'organizer'   => ['email' => $organizer, 'name' => $team[$organizer]['name']],
            'attendees'   => $this->attendees((array) ($input['attendees'] ?? []), $team, $organizer),
            'repeat'      => $repeat,
            'reminder'    => $fields['reminder'] ?? null,
        ]);

        $href = CalendarCopies::hrefFor((string) $source['href'], $uid);
        if ($this->store->get($href) !== null) {
            throw new RuntimeException('The calendar already holds an appointment at that address; nothing was saved.');
        }
        $this->write($source, $href, $ics);
        $warnings = $this->copies->push($uid, $ics, $organizer, $href);
        if ($type !== null) {
            CalendarTypes::set($uid, $type, $viewer['user_id']);
        }

        foreach ((array) ($input['links'] ?? []) as $link) {
            if (is_array($link) && isset($link['type'], $link['target_id'])) {
                try {
                    CalendarLinks::add($uid, (string) $link['type'], (int) $link['target_id'], $viewer['user_id']);
                } catch (InvalidArgumentException | OutOfBoundsException $e) {
                    $warnings[] = $e->getMessage();
                }
            }
        }
        return ['uid' => $uid, 'occurrence' => $this->firstOccurrence($uid), 'warnings' => $warnings];
    }

    /**
     * Change an appointment. Only the fields in $input change; with "base"
     * it is checked against what the person saw first.
     *
     * @param string $scope 'series' (the whole appointment) or 'occurrence'
     * @return array{uid: string, occurrence: ?string, warnings: list<string>}
     */
    public function update(string $uid, ?string $occurrence, string $scope, array $input, array $viewer): array
    {
        [$original, $source, $organizer] = $this->editable($uid, $viewer);
        $setType = array_key_exists('type', $input);
        $type = $setType ? CalendarTypes::valid($input['type']) : null;
        $newOrganizer = strtolower(trim((string) ($input['organizer'] ?? '')));
        $moving = $newOrganizer !== '' && $newOrganizer !== $organizer;
        if (!$moving && !array_diff(array_keys($input), ['base', 'type', 'organizer'])) {
            // Only the type: the CRM's, nothing goes to the server.
            if ($setType) {
                CalendarTypes::set($uid, $type, $viewer['user_id']);
            }
            return ['uid' => $uid, 'occurrence' => $occurrence, 'warnings' => []];
        }
        $target = null;
        if ($moving) {
            if (!$viewer['can_edit']) {
                throw new DomainException('You may not put appointments into somebody else\'s calendar.');
            }
            $team = $this->team($viewer);
            $target = $this->targetCalendar($newOrganizer, $team, $this->workCalendars());
            if ($this->store->isLocal((string) $original['href']) !== $this->store->isLocal((string) $target['href'])) {
                throw new InvalidArgumentException('An appointment cannot move between a made-up test calendar and a real one.');
            }
        }
        $fresh = $this->current($original, $source, $input['base'] ?? null);
        $fresh = $this->copies->mergeAnswers($uid, $fresh, $organizer);
        $details = CalendarIcsWriter::details($fresh);
        $single = $details['series'] && $occurrence !== null && $scope === 'occurrence';
        if ($moving && $single) {
            throw new InvalidArgumentException('Another calendar is for the whole series, not one occurrence.');
        }
        $fields = $this->fields($input, false);

        $changes = [];
        foreach (['title', 'location', 'description', 'url', 'reminder'] as $key) {
            if (array_key_exists($key, $fields)) {
                $changes[$key] = $fields[$key];
            }
        }
        $origin = null;
        if (isset($fields['start'])) {
            $changes += ['start' => $fields['start'], 'end' => $fields['end'], 'all_day' => $fields['all_day']];
            if ($details['series']) {
                $instance = $occurrence !== null ? $this->instanceByUid($uid, $occurrence) : null;
                if ($instance === null) {
                    throw new InvalidArgumentException('Which occurrence was changed is missing.');
                }
                if (((int) $instance['all_day'] === 1) !== $fields['all_day']) {
                    throw new InvalidArgumentException('A series cannot switch between all day and a time here.');
                }
                $origin = (int) $instance['all_day'] === 1
                    ? new DateTimeImmutable((string) $instance['starts_at'], new DateTimeZone(CALENDAR_TIMEZONE))
                    : new DateTimeImmutable((string) $instance['starts_at'], new DateTimeZone('UTC'));
            }
        }

        if ($single) {
            unset($changes['all_day']);
            $ics = CalendarIcsWriter::update($fresh, $changes, $occurrence);
        } else {
            if (array_key_exists('repeat', $fields)) {
                $changes['repeat'] = $fields['repeat'];
            }
            if ($moving) {
                $team = $this->team($viewer);
                // Not said who takes part: everyone as before, the previous
                // organizer included.
                $emails = array_key_exists('attendees', $input)
                    ? (array) $input['attendees']
                    : array_merge(array_keys(CalendarIcsWriter::people($fresh)['attendees']), [$organizer]);
                $changes['attendees'] = $this->attendees(array_filter($emails, static function ($email) use ($team): bool {
                    return isset($team[strtolower(trim((string) $email))]);
                }), $team, $newOrganizer);
                $changes['organizer'] = ['email' => $newOrganizer, 'name' => $team[$newOrganizer]['name'] ?? $newOrganizer];
                $changes['team'] = $this->teamEmails();
                $changes['reassign'] = true;
                $changes['previous'] = $organizer;
            } elseif (array_key_exists('attendees', $input)) {
                $team = $this->team($viewer);
                $changes['attendees'] = $this->attendees((array) $input['attendees'], $team, $organizer);
                $changes['organizer'] = ['email' => $organizer, 'name' => $team[$organizer]['name'] ?? $organizer];
                $changes['team'] = $this->teamEmails();
            }
            $ics = CalendarIcsWriter::update($fresh, $changes, null, $origin);
        }

        if ($target !== null) {
            $warnings = $this->move($uid, $original, $source, $target, $ics, $organizer, $newOrganizer);
        } else {
            $this->write($source, (string) $original['href'], $ics);
            $warnings = $this->copies->push($uid, $ics, $organizer, (string) $original['href']);
        }
        if ($setType) {
            CalendarTypes::set($uid, $type, $viewer['user_id']);
        }
        return ['uid' => $uid, 'occurrence' => $occurrence, 'warnings' => $warnings];
    }

    /**
     * Into another calendar: written there first (over the new organizer's
     * copy, if they had one), then out of the old one - unless its owner
     * still takes part; then the copies bring theirs in line.
     *
     * @return list<string> warnings
     */
    private function move(string $uid, array $original, array $source, array $target, string $ics, string $from, string $to): array
    {
        $stmt = $this->db->prepare("SELECT href FROM calendar_events WHERE source_id = :source AND uid = :uid AND archived = 0 ORDER BY id LIMIT 1");
        $stmt->execute(['source' => $target['id'], 'uid' => $uid]);
        $copyHref = $stmt->fetchColumn();
        $href = is_string($copyHref) && $copyHref !== '' ? $copyHref : CalendarCopies::hrefFor((string) $target['href'], $uid);
        if ($copyHref === false && $this->store->get($href) !== null) {
            throw new RuntimeException('The other calendar already holds an appointment at that address; nothing was saved.');
        }
        $this->write($target, $href, $ics);
        // Theirs is the original now, not a copy.
        $this->db->prepare("DELETE FROM calendar_copies WHERE uid = :uid AND email = :email")->execute(['uid' => $uid, 'email' => $to]);

        $warnings = [];
        if (!array_key_exists($from, CalendarIcsWriter::people($ics)['attendees'])) {
            try {
                $this->store->delete((string) $original['href']);
                $this->cache->forget((int) $source['id'], (string) $original['href']);
            } catch (Throwable $e) {
                error_log('Calendar events: removing the moved appointment from calendar ' . $source['id'] . ' failed');
                $warnings[] = 'It is in the new calendar, but could not be taken out of the old one; delete it there.';
            }
        }
        return array_merge($warnings, $this->copies->push($uid, $ics, $to, $href));
    }

    /** A team member's work calendar the shared account may write into. */
    private function targetCalendar(string $email, array $team, array $work): array
    {
        $source = $work[$email] ?? null;
        if ($source === null || !isset($team[$email]) || (int) $source['writable'] !== 1 || !$this->store->reaches((string) $source['href'])) {
            throw new InvalidArgumentException('Choose a calendar the appointment can go into.');
        }
        return $source;
    }

    /**
     * Cancel an appointment - for everyone, all copies included - or one
     * occurrence of a series.
     *
     * @return array{uid: string, cancelled: string, warnings: list<string>}
     */
    public function cancel(string $uid, ?string $occurrence, string $scope, ?string $base, array $viewer): array
    {
        [$original, $source, $organizer] = $this->editable($uid, $viewer);
        $fresh = $this->current($original, $source, $base);

        if ($occurrence !== null && $scope === 'occurrence' && CalendarIcsWriter::details($fresh)['series']) {
            $ics = CalendarIcsWriter::removeOccurrence($this->copies->mergeAnswers($uid, $fresh, $organizer), $occurrence);
            $this->write($source, (string) $original['href'], $ics);
            $warnings = $this->copies->push($uid, $ics, $organizer, (string) $original['href']);
            return ['uid' => $uid, 'cancelled' => 'occurrence', 'warnings' => $warnings];
        }

        $this->store->delete((string) $original['href']);
        $this->cache->forget((int) $source['id'], (string) $original['href']);
        $warnings = $this->copies->removeAll($uid, $organizer);
        CalendarLinks::removeForEvent($uid);
        CalendarTypes::remove($uid);
        return ['uid' => $uid, 'cancelled' => 'series', 'warnings' => $warnings];
    }

    /**
     * A team member's answer to an appointment they are invited to.
     *
     * @return array{uid: string, answer: string, warnings: list<string>}
     */
    public function respond(string $uid, string $answer, array $viewer): array
    {
        $answer = strtoupper(trim($answer));
        if (!in_array($answer, self::ANSWERS, true)) {
            throw new InvalidArgumentException('Answer accepted, tentative or declined.');
        }
        $rows = $this->rows($uid);
        $original = $this->original($rows);
        if ($original === null || $this->visibleRow($rows, $viewer) === null) {
            throw new OutOfBoundsException('This appointment is not in the calendar (any more).');
        }
        [$source, $organizer] = $this->writableSource($original);
        $fresh = $this->current($original, $source, null);
        $me = null;
        foreach (array_keys(CalendarIcsWriter::people($fresh)['attendees']) as $email) {
            if ($email !== $organizer && in_array($email, $viewer['emails'], true)) {
                $me = $email;
            }
        }
        if ($me === null) {
            throw new DomainException('Only the people invited can answer.');
        }
        $ics = CalendarIcsWriter::setPartstat($this->copies->mergeAnswers($uid, $fresh, $organizer), $me, $answer);
        $this->write($source, (string) $original['href'], $ics);
        $warnings = $this->copies->push($uid, $ics, $organizer, (string) $original['href'], $answer === 'DECLINED' ? [] : [$me]);
        return ['uid' => $uid, 'answer' => $answer, 'warnings' => $warnings];
    }

    // =========================================================================
    // Finding the appointment
    // =========================================================================

    /** The cached objects with this UID in enabled calendars, with their calendar. */
    private function rows(string $uid): array
    {
        $stmt = $this->db->prepare("
            SELECT e.*, s.owner_email, s.kind, s.writable, s.visibility, s.href AS source_href
            FROM calendar_events e
            JOIN calendar_sources s ON s.id = e.source_id
            WHERE e.uid = :uid AND s.enabled = 1 AND e.archived = 0 AND e.ics IS NOT NULL
            ORDER BY CASE s.kind WHEN 'work' THEN 0 ELSE 1 END, e.id
        ");
        $stmt->execute(['uid' => $uid]);
        return $stmt->fetchAll();
    }

    /**
     * The original: in the organizer's own calendar - or, without an
     * organizer, the appointment itself. Null when the organizer's calendar
     * is not here (somebody from outside invited the team).
     */
    private function original(array $rows): ?array
    {
        $anyOrganizer = false;
        foreach ($rows as $row) {
            $organizer = json_decode((string) $row['organizer'], true);
            $email = is_array($organizer) ? strtolower((string) ($organizer['email'] ?? '')) : '';
            if ($email === '') {
                continue;
            }
            $anyOrganizer = true;
            if ($email === strtolower((string) $row['owner_email'])) {
                return $row;
            }
        }
        return $anyOrganizer ? null : ($rows[0] ?? null);
    }

    /** A copy $viewer may see in full - their own first, then the original. */
    private function visibleRow(array $rows, array $viewer): ?array
    {
        $found = null;
        foreach ($rows as $row) {
            $owner = strtolower((string) $row['owner_email']);
            if (in_array($owner, $viewer['emails'], true)) {
                return $row;
            }
            $private = in_array(strtoupper((string) $row['class']), ['PRIVATE', 'CONFIDENTIAL'], true);
            if ($found === null && $row['visibility'] === 'details' && !$private) {
                $found = $row;
            }
        }
        return $found;
    }

    /** One occurrence of a cached object: the one named, or the only/first one. */
    private function instance(int $eventId, ?string $occurrence): ?array
    {
        if ($occurrence !== null && $occurrence !== '') {
            $stmt = $this->db->prepare("SELECT * FROM calendar_instances WHERE event_id = :id AND recurrence_id = :rid LIMIT 1");
            $stmt->execute(['id' => $eventId, 'rid' => $occurrence]);
        } else {
            $stmt = $this->db->prepare("SELECT * FROM calendar_instances WHERE event_id = :id ORDER BY recurrence_id IS NOT NULL, starts_at LIMIT 1");
            $stmt->execute(['id' => $eventId]);
        }
        return $stmt->fetch() ?: null;
    }

    private function instanceByUid(string $uid, string $occurrence): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM calendar_instances WHERE uid = :uid AND recurrence_id = :rid ORDER BY id LIMIT 1");
        $stmt->execute(['uid' => $uid, 'rid' => $occurrence]);
        return $stmt->fetch() ?: null;
    }

    private function firstOccurrence(string $uid): ?string
    {
        $stmt = $this->db->prepare("SELECT recurrence_id FROM calendar_instances WHERE uid = :uid ORDER BY starts_at LIMIT 1");
        $stmt->execute(['uid' => $uid]);
        $rid = $stmt->fetchColumn();
        return $rid === false ? null : $rid;
    }

    /**
     * Why $viewer may not change this appointment, in a sentence for the
     * sheet - so a missing Edit is never a riddle.
     */
    private function readOnlyReason(?array $original, array $visible, string $organizerEmail, array $team, array $viewer): string
    {
        $name = static function (string $email) use ($team): string {
            return isset($team[$email]) ? $team[$email]['name'] : $email;
        };
        if ($original === null) {
            return isset($team[$organizerEmail])
                ? 'Its original is in ' . $name($organizerEmail) . "'s work calendar, which the CRM cannot see - shared with the calendar account, to read and write, it can be changed here."
                : 'Organized by someone outside the team - only they can change it.';
        }
        if ($original['kind'] !== 'work') {
            return 'In a private calendar - private calendars are read only here.';
        }
        if ((int) $original['writable'] !== 1) {
            return $name(strtolower((string) $original['owner_email'])) . "'s work calendar is shared to read only - shared to read and write, it can be changed here.";
        }
        if (!$this->store->reaches((string) $original['source_href'])) {
            return 'The calendar it is in cannot be reached right now.';
        }
        return 'Only the organizer, or someone allowed to edit the team calendar, can change it.';
    }

    /** @return array{edit: bool, cancel: bool, respond: bool, link: bool} */
    private function permissions(?array $original, array $viewer, bool $invited): array
    {
        $writable = $original !== null && (int) $original['writable'] === 1 && $original['kind'] === 'work'
            && $this->store->reaches((string) $original['source_href']);
        $isOrganizer = $original !== null && in_array(strtolower((string) $original['owner_email']), $viewer['emails'], true);
        $edit = $writable && ($viewer['can_edit'] || $isOrganizer);
        return ['edit' => $edit, 'cancel' => $edit, 'respond' => $writable && $invited, 'link' => true];
    }

    /**
     * The original of an appointment $viewer may move and cancel.
     *
     * @return array{0: array, 1: array, 2: string} [original, its calendar, organizer address]
     */
    private function editable(string $uid, array $viewer): array
    {
        $rows = $this->rows($uid);
        if ($this->visibleRow($rows, $viewer) === null) {
            throw new OutOfBoundsException('This appointment is not in the calendar (any more).');
        }
        $original = $this->original($rows);
        if ($original === null) {
            throw new DomainException('This appointment was made by somebody outside the team; only they can change it.');
        }
        if (!$this->permissions($original, $viewer, false)['edit']) {
            throw new DomainException('Only the organizer, or someone allowed to edit the team calendar, can change this appointment.');
        }
        [$source, $organizer] = $this->writableSource($original);
        return [$original, $source, $organizer];
    }

    /** @return array{0: array, 1: string} [the original's calendar, organizer address] */
    private function writableSource(array $original): array
    {
        $stmt = $this->db->prepare("SELECT * FROM calendar_sources WHERE id = :id");
        $stmt->execute(['id' => $original['source_id']]);
        $source = $stmt->fetch();
        if (!$source || (int) $source['writable'] !== 1 || !$this->store->reaches((string) $source['href'])) {
            throw new DomainException('This calendar is shared to read only; the appointment can only be changed on the phone.');
        }
        return [$source, strtolower((string) $source['owner_email'])];
    }

    /**
     * The original as it is on the server now. Differs it from what the
     * person editing saw ($base), nothing is written: CalendarConflict.
     */
    private function current(array $original, array $source, $base): string
    {
        $fresh = $this->store->get((string) $original['href']);
        if ($fresh === null) {
            $this->cache->forget((int) $source['id'], (string) $original['href']);
            throw new CalendarConflict('deleted');
        }
        $hash = CalendarIcs::hash($fresh['data']);
        if ($hash !== $original['content_hash']) {
            // Newer than the cache: keep it, whatever happens next.
            $this->cache->remember((int) $source['id'], (string) $original['href'], $fresh['etag'], $fresh['data']);
        }
        if (is_string($base) && $base !== '' && !hash_equals($base, $hash)) {
            throw new CalendarConflict('changed');
        }
        return $fresh['data'];
    }

    // =========================================================================
    // The sheet's fields
    // =========================================================================

    /**
     * The fields sent, checked and converted. For a new appointment every
     * field is read (missing = empty); for a change only those sent.
     */
    private function fields(array $input, bool $creating): array
    {
        $fields = [];
        if ($creating || array_key_exists('title', $input)) {
            $title = trim((string) ($input['title'] ?? ''));
            if ($title === '' || mb_strlen($title) > 255) {
                throw new InvalidArgumentException('Give the appointment a title (at most 255 characters).');
            }
            $fields['title'] = $title;
        }
        foreach (['location' => 500, 'description' => 10000] as $key => $max) {
            if ($creating || array_key_exists($key, $input)) {
                $value = trim((string) ($input[$key] ?? ''));
                if (mb_strlen($value) > $max) {
                    throw new InvalidArgumentException(ucfirst($key) . ' can be at most ' . $max . ' characters long.');
                }
                $fields[$key] = $value === '' ? null : $value;
            }
        }
        if ($creating || array_key_exists('url', $input)) {
            $url = trim((string) ($input['url'] ?? ''));
            if ($url !== '' && (!preg_match('#^https?://#i', $url) || filter_var($url, FILTER_VALIDATE_URL) === false || strlen($url) > 500)) {
                throw new InvalidArgumentException('The video link must be a web address starting with https://.');
            }
            $fields['url'] = $url === '' ? null : $url;
        }
        if ($creating || array_key_exists('start', $input) || array_key_exists('end', $input) || array_key_exists('all_day', $input)) {
            $allDay = !empty($input['all_day']);
            [$fields['start'], $fields['end']] = $this->times((string) ($input['start'] ?? ''), (string) ($input['end'] ?? ''), $allDay);
            $fields['all_day'] = $allDay;
        }
        if (array_key_exists('repeat', $input)) {
            $repeat = $input['repeat'];
            $freq = is_array($repeat) ? strtoupper(trim((string) ($repeat['freq'] ?? ''))) : '';
            if ($freq === '' || $freq === 'NONE') {
                $fields['repeat'] = null;
            } else {
                if (!in_array($freq, CalendarIcsWriter::FREQUENCIES, true)) {
                    throw new InvalidArgumentException('Repeat daily, weekly or monthly.');
                }
                $until = trim((string) ($repeat['until'] ?? ''));
                if ($until !== '') {
                    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $until, new DateTimeZone(CALENDAR_TIMEZONE));
                    if ($date === false || $date->format('Y-m-d') !== $until) {
                        throw new InvalidArgumentException('The last day of the series must be a date.');
                    }
                    if (isset($fields['start']) && $until < $fields['start']->format('Y-m-d')) {
                        throw new InvalidArgumentException('The series cannot end before it starts.');
                    }
                }
                $fields['repeat'] = ['freq' => $freq, 'until' => $until !== '' ? $until : null];
            }
        }
        if (array_key_exists('reminder', $input)) {
            $reminder = $input['reminder'];
            if ($reminder === null || $reminder === '') {
                $fields['reminder'] = null;
            } elseif (in_array((int) $reminder, CalendarIcsWriter::REMINDERS, true) && is_numeric($reminder)) {
                $fields['reminder'] = (int) $reminder;
            } else {
                throw new InvalidArgumentException('Choose one of the reminders offered.');
            }
        }
        return $fields;
    }

    /**
     * Start and end from the sheet: "Y-m-d\TH:i" in CALENDAR_TIMEZONE, or
     * for all day the first and last day ("Y-m-d"; the end comes back as the
     * day after, as the calendar writes it).
     *
     * @return array{0: DateTimeImmutable, 1: DateTimeImmutable}
     */
    private function times(string $start, string $end, bool $allDay): array
    {
        $zone = new DateTimeZone(CALENDAR_TIMEZONE);
        if ($allDay) {
            $from = DateTimeImmutable::createFromFormat('!Y-m-d', substr($start, 0, 10), $zone);
            $to = DateTimeImmutable::createFromFormat('!Y-m-d', substr($end, 0, 10), $zone);
            if ($from === false || $to === false) {
                throw new InvalidArgumentException('Choose the first and the last day.');
            }
            if ($to < $from) {
                throw new InvalidArgumentException('The last day cannot be before the first.');
            }
            $to = $to->modify('+1 day');
        } else {
            $from = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', substr($start, 0, 16), $zone);
            $to = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', substr($end, 0, 16), $zone);
            if ($from === false || $to === false) {
                throw new InvalidArgumentException('Choose when it starts and when it ends.');
            }
            if ($to <= $from) {
                throw new InvalidArgumentException('It has to end after it starts.');
            }
        }
        if ($to->getTimestamp() - $from->getTimestamp() > self::MAX_DAYS * 86400) {
            throw new InvalidArgumentException('An appointment can last at most ' . self::MAX_DAYS . ' days.');
        }
        return [$from, $to];
    }

    /**
     * Team members taking part besides the organizer.
     *
     * @return list<array{email: string, name: string}>
     */
    private function attendees(array $emails, array $team, string $organizer): array
    {
        $list = [];
        foreach ($emails as $email) {
            $email = strtolower(trim((string) $email));
            if ($email === '' || $email === $organizer) {
                continue;
            }
            if (!isset($team[$email])) {
                throw new InvalidArgumentException('Only members of the team can be added as participants.');
            }
            $list[$email] = ['email' => $email, 'name' => $team[$email]['name']];
        }
        return array_values($list);
    }

    // =========================================================================

    /** @return array<string, array> address => person, the team $viewer sees */
    private function team(array $viewer): array
    {
        $team = [];
        foreach (CalendarView::people($viewer) as $person) {
            $team[$person['email']] = $person;
        }
        return $team;
    }

    /** @return list<string> everyone who has (had) a calendar here */
    private function teamEmails(): array
    {
        return array_map('strtolower', $this->db->query("SELECT email FROM calendar_people")->fetchAll(PDO::FETCH_COLUMN));
    }

    /** @return array<string, array> address => that person's work calendar */
    private function workCalendars(): array
    {
        $rows = $this->db->query("SELECT * FROM calendar_sources WHERE enabled = 1 AND kind = 'work' ORDER BY writable DESC, id")->fetchAll();
        $work = [];
        foreach ($rows as $row) {
            $email = strtolower((string) $row['owner_email']);
            $work[$email] = $work[$email] ?? $row;
        }
        return $work;
    }

    private function write(array $source, string $href, string $ics): void
    {
        $etag = $this->store->put($href, $ics);
        $this->cache->remember((int) $source['id'], $href, $etag, $ics);
    }
}
