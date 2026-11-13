<?php
/**
 * Team calendar tests - phase 2 of docs/kalender-spec.md
 *
 *     php tests/calendar-write.test.php
 *
 * Creating, changing, cancelling and answering appointments, the copies in
 * the team's calendars and how the sync keeps them in step, conflicts,
 * series, links to contacts and projects - against a scratch SQLite database
 * and a calendar server held in memory (tests/FakeCalDav.php). Never
 * touches data/crm.db or the mail server. Dates are relative to today.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

define('APP_ROOT', dirname(__DIR__));
$scratch = sys_get_temp_dir() . '/crm-calendar-write-test-' . bin2hex(random_bytes(4));
mkdir($scratch, 0700);
define('DATA_DIR', $scratch);
define('DB_PATH', $scratch . '/crm.db');

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/User.php';
require_once APP_ROOT . '/includes/CalendarSync.php';
require_once APP_ROOT . '/includes/CalendarView.php';
require_once APP_ROOT . '/includes/CalendarEvents.php';
require_once APP_ROOT . '/includes/CalendarLinks.php';
require_once __DIR__ . '/FakeCalDav.php';

register_shutdown_function(static function () use ($scratch): void {
    foreach (glob($scratch . '/*') ?: [] as $file) {
        @unlink($file);
    }
    @rmdir($scratch);
});

$failures = 0;
$passes = 0;

function check(string $label, bool $ok, $detail = null): void
{
    global $failures, $passes;
    if ($ok) {
        $passes++;
        echo "  ok    {$label}\n";
    } else {
        $failures++;
        echo "  FAIL  {$label}" . ($detail !== null ? ' - got ' . json_encode($detail, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : '') . "\n";
    }
}

function section(string $title): void
{
    echo "\n{$title}\n";
}

/** @return mixed the exception's class, or the result */
function attempt(callable $fn)
{
    try {
        return $fn();
    } catch (Throwable $e) {
        return get_class($e) . ': ' . $e->getMessage();
    }
}

const LIVIO = 'livio@disinfoconsulting.eu';
const MARKUS = 'markus@disinfoconsulting.eu';
const VIVIAN = 'vivian@disinfoconsulting.eu';

function viewer(string $email, bool $canEdit, bool $admin = false): array
{
    return ['user_id' => null, 'is_owner' => false, 'is_admin' => $admin, 'can_view' => true, 'can_edit' => $canEdit, 'emails' => [$email]];
}

$zone = new DateTimeZone(CALENDAR_TIMEZONE);
$monday = (new DateTimeImmutable('monday next week', $zone));
function day(int $offset): string
{
    global $monday;
    return $monday->modify('+' . $offset . ' days')->format('Y-m-d');
}

// =============================================================================
// The team and its calendars
// =============================================================================

$work = ['livio' => '/calendars/' . LIVIO . '/calendar/', 'markus' => '/calendars/' . MARKUS . '/calendar/', 'vivian' => '/calendars/' . VIVIAN . '/calendar/'];
$private = ['livio' => '/calendars/' . LIVIO . '/calendar-p1/', 'markus' => '/calendars/' . MARKUS . '/calendar-p2/', 'vivian' => '/calendars/' . VIVIAN . '/calendar-p3/'];
$server = new FakeCalDav();
foreach ([['livio', LIVIO], ['markus', MARKUS], ['vivian', VIVIAN]] as [$key, $email]) {
    $server->addCalendar($work[$key], $email, 'Public', 'work', true);
    $server->addCalendar($private[$key], $email, 'Private', 'private', false);
}
$db = Database::getInstance();
foreach ([[LIVIO, 'Livio Zalozieckyj'], [MARKUS, 'Markus Schwinghammer'], [VIVIAN, 'Vivian Lösch']] as [$email, $name]) {
    $db->prepare("INSERT INTO users (email, name, role, status) VALUES (:email, :name, 'member', 'active')")->execute(['email' => $email, 'name' => $name]);
}
$db->exec("INSERT INTO contacts (name, company, email) VALUES ('Anna Berger', 'Alpenbank', 'Anna.Berger@alpenbank.example')");
$annaId = (int) $db->lastInsertId();
$db->exec("INSERT INTO projects (name, start_date, description, company) VALUES ('Relaunch', '2026-01-01', 'x', 'Alpenbank')");
$projectId = (int) $db->lastInsertId();

function sync(bool $discover = false): array
{
    global $server;
    return (new CalendarSync($server))->run($discover);
}

sync(true);
$events = new CalendarEvents(new CalendarStore($server));

$livio = viewer(LIVIO, true);
$markus = viewer(MARKUS, false);   // may see, not edit
$vivian = viewer(VIVIAN, true);

function items(array $viewer, string $from, string $to): array
{
    return CalendarView::range($from, $to, $viewer);
}

function find(array $items, string $title): ?array
{
    foreach ($items as $item) {
        if ($item['title'] === $title) {
            return $item;
        }
    }
    return null;
}

function copyRecord(string $uid, string $email): ?array
{
    $stmt = Database::getInstance()->prepare("SELECT * FROM calendar_copies WHERE uid = :uid AND email = :email");
    $stmt->execute(['uid' => $uid, 'email' => $email]);
    return $stmt->fetch() ?: null;
}

// =============================================================================

section('A new appointment');
$created = $events->create([
    'title' => 'Projektmeeting', 'start' => day(1) . 'T10:00', 'end' => day(1) . 'T11:00',
    'location' => 'Büro', 'attendees' => [MARKUS],
    'links' => [['type' => 'contact', 'target_id' => $annaId]],
], $livio);
$uid = $created['uid'];
$original = $server->object($work['livio'] . $uid . '.ics');
$copy = $server->object($work['markus'] . $uid . '.ics');
check('the original is in the organizer\'s work calendar on the server', $original !== null && str_contains($original, 'SUMMARY:Projektmeeting'));
$unfolded = str_replace(["\r\n ", "\n "], '', (string) $original);
check('... with Markus invited, SCHEDULE-AGENT=CLIENT on him, never on the organizer',
    (bool) preg_match('/^ATTENDEE;[^\r\n]*PARTSTAT=NEEDS-ACTION[^\r\n]*SCHEDULE-AGENT=CLIENT[^\r\n]*:mailto:' . preg_quote(MARKUS, '/') . '/m', $unfolded)
    && (bool) preg_match('/^ORGANIZER;[^\r\n]*:mailto:' . preg_quote(LIVIO, '/') . '/m', $unfolded)
    && !preg_match('/^ORGANIZER;[^\r\n]*SCHEDULE-AGENT/m', $unfolded));
check('... in local time with the zone\'s VTIMEZONE', $original !== null && str_contains($original, 'DTSTART;TZID=' . CALENDAR_TIMEZONE . ':') && str_contains($original, 'BEGIN:VTIMEZONE'));
check('Markus has an identical copy in his work calendar', $copy !== null && $copy === $original);
check('... recorded as a copy the CRM keeps', (copyRecord($uid, MARKUS)['state'] ?? null) === 'active');
check('nothing went into a private calendar', count($server->objects[$private['markus']]) === 0);
$week = items($livio, day(0), day(7));
$item = find($week, 'Projektmeeting');
check('the CRM shows it at once, once, as Livio\'s, with both people', $item !== null && $item['mine'] && $item['people'] === [LIVIO, MARKUS]
    && count(array_filter($week, static fn ($i) => $i['title'] === 'Projektmeeting')) === 1, $item);
check('the link to the contact is there', count(CalendarLinks::forEvent($uid)) === 1 && CalendarLinks::forEvent($uid)[0]['name'] === 'Anna Berger');

check('a title is needed', str_contains((string) attempt(fn () => $events->create(['title' => ' ', 'start' => day(1) . 'T10:00', 'end' => day(1) . 'T11:00'], $livio)), 'InvalidArgument'));
check('it has to end after it starts', str_contains((string) attempt(fn () => $events->create(['title' => 'X', 'start' => day(1) . 'T10:00', 'end' => day(1) . 'T09:00'], $livio)), 'InvalidArgument'));
check('participants come from the team only', str_contains((string) attempt(fn () => $events->create(['title' => 'X', 'start' => day(1) . 'T10:00', 'end' => day(1) . 'T11:00', 'attendees' => ['someone@example.org']], $livio)), 'InvalidArgument'));
check('without the edit right nobody creates', str_contains((string) attempt(fn () => $events->create(['title' => 'X', 'start' => day(1) . 'T10:00', 'end' => day(1) . 'T11:00'], $markus)), 'DomainException'));
check('Livio may put one into Vivian\'s calendar (edit right)', is_array(attempt(fn () => $events->create(['title' => 'Für Vivian', 'organizer' => VIVIAN, 'start' => day(2) . 'T09:00', 'end' => day(2) . 'T09:30'], $livio))));

$allDay = $events->create(['title' => 'Klausur', 'all_day' => true, 'start' => day(3), 'end' => day(4), 'reminder' => 1440], $livio);
$allDayIcs = (string) $server->object($work['livio'] . $allDay['uid'] . '.ics');
check('all day: dates, the end the day after the last', str_contains($allDayIcs, 'DTSTART;VALUE=DATE:' . str_replace('-', '', day(3))) && str_contains($allDayIcs, 'DTEND;VALUE=DATE:' . str_replace('-', '', day(5))));
check('... with its reminder', str_contains($allDayIcs, 'TRIGGER:-PT1440M'));
check('... and no participants: a plain appointment', !str_contains($allDayIcs, 'ORGANIZER'));

section('The sheet');
$sheetMarkus = $events->sheet($uid, null, $markus);
check('Markus (invited, no edit right) may answer, not move', $sheetMarkus['can']['respond'] && !$sheetMarkus['can']['edit'] && $sheetMarkus['my_answer'] === 'NEEDS-ACTION', $sheetMarkus['can']);
$sheetVivian = $events->sheet($uid, null, $vivian);
check('Vivian (edit right, not invited) may move, not answer', $sheetVivian['can']['edit'] && !$sheetVivian['can']['respond'], $sheetVivian['can']);
check('times as the sheet shows them, local', $sheetMarkus['start'] === day(1) . 'T10:00' && $sheetMarkus['end'] === day(1) . 'T11:00', [$sheetMarkus['start'], $sheetMarkus['end']]);
$server->put($private['vivian'], 'zahnarzt.ics', "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:zahnarzt\nDTSTAMP:20260101T000000Z\nDTSTART:" . str_replace('-', '', day(2)) . "T080000Z\nDTEND:" . str_replace('-', '', day(2)) . "T090000Z\nSUMMARY:Zahnarzt\nEND:VEVENT\nEND:VCALENDAR\n");
sync();
check('a hidden appointment cannot be opened by others', str_contains((string) attempt(fn () => $events->sheet('zahnarzt', null, $livio)), 'OutOfBounds'));
check('... nor linked', !$events->visible('zahnarzt', $livio) && $events->visible('zahnarzt', $vivian));

section('Changing it');
$puts = $server->puts;
$moved = $events->update($uid, null, 'series', ['base' => $sheetMarkus['base'], 'start' => day(1) . 'T11:00', 'end' => day(1) . 'T12:00'], $livio);
$original = (string) $server->object($work['livio'] . $uid . '.ics');
$copy = (string) $server->object($work['markus'] . $uid . '.ics');
check('moved in the original and in Markus\'s copy', str_contains($original, 'T110000') && $copy === $original);
check('... with SEQUENCE raised', str_contains($original, 'SEQUENCE:1'));
check('... the CRM shows the new time at once', (find(items($livio, day(0), day(7)), 'Projektmeeting')['start'] ?? null) === (new DateTimeImmutable(day(1) . ' 11:00', $zone))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'));

// Somebody changes it on the phone meanwhile.
$phone = str_replace('SUMMARY:Projektmeeting', 'SUMMARY:Projektmeeting (Raum 2)', $original);
$server->put($work['livio'], $uid . '.ics', $phone);
$puts = $server->puts;
$conflict = attempt(fn () => $events->update($uid, null, 'series', ['base' => $events->sheet($uid, null, $livio)['base'], 'location' => 'Raum 3'], $livio));
check('a change made meanwhile is caught: nothing written', str_contains((string) $conflict, 'CalendarConflict') && $server->puts === $puts, $conflict);
check('... and the CRM now knows the phone\'s version', $events->sheet($uid, null, $livio)['title'] === 'Projektmeeting (Raum 2)');
$again = attempt(fn () => $events->update($uid, null, 'series', ['base' => $events->sheet($uid, null, $livio)['base'], 'location' => 'Raum 3'], $livio));
$original = (string) $server->object($work['livio'] . $uid . '.ics');
check('on the new version the change goes through, the phone\'s title kept', is_array($again) && str_contains($original, 'LOCATION:Raum 3') && str_contains($original, 'Projektmeeting (Raum 2)'));
check('without the edit right Markus cannot move it', str_contains((string) attempt(fn () => $events->update($uid, null, 'series', ['location' => 'X'], $markus)), 'DomainException'));

$events->update($uid, null, 'series', ['attendees' => [VIVIAN]], $livio);
check('participants changed: Vivian gets a copy', $server->object($work['vivian'] . $uid . '.ics') !== null && (copyRecord($uid, VIVIAN)['state'] ?? null) === 'active');
check('... and Markus\'s copy goes', $server->object($work['markus'] . $uid . '.ics') === null && copyRecord($uid, MARKUS) === null);
$events->update($uid, null, 'series', ['attendees' => [MARKUS, VIVIAN]], $livio);

section('Answering');
$events->respond($uid, 'accepted', $markus);
$original = (string) $server->object($work['livio'] . $uid . '.ics');
check('Markus accepts in the CRM: the original says so', CalendarIcsWriter::partstat($original, MARKUS) === 'ACCEPTED');
check('... and every copy', CalendarIcsWriter::partstat((string) $server->object($work['vivian'] . $uid . '.ics'), MARKUS) === 'ACCEPTED'
    && CalendarIcsWriter::partstat((string) $server->object($work['markus'] . $uid . '.ics'), MARKUS) === 'ACCEPTED');
check('somebody not invited cannot answer', str_contains((string) attempt(fn () => $events->respond($allDay['uid'], 'accepted', $vivian)), 'Exception'));

section('What phones do, and the next sync');
// Vivian declines on her phone.
$server->put($work['vivian'], $uid . '.ics', CalendarIcsWriter::setPartstat((string) $server->object($work['vivian'] . $uid . '.ics'), VIVIAN, 'DECLINED'));
$stats = sync();
check('an answer given in a copy goes into the original', CalendarIcsWriter::partstat((string) $server->object($work['livio'] . $uid . '.ics'), VIVIAN) === 'DECLINED', $stats);
check('... and on into the other copies', CalendarIcsWriter::partstat((string) $server->object($work['markus'] . $uid . '.ics'), VIVIAN) === 'DECLINED');

// Markus renames his copy on the phone.
$server->put($work['markus'], $uid . '.ics', str_replace('SUMMARY:Projektmeeting (Raum 2)', 'SUMMARY:Meins', (string) $server->object($work['markus'] . $uid . '.ics')));
sync();
check('any other change to a copy is overwritten by the original', str_contains((string) $server->object($work['markus'] . $uid . '.ics'), 'SUMMARY:Projektmeeting (Raum 2)'));

// Livio moves the original on his phone.
$server->put($work['livio'], $uid . '.ics', str_replace('T110000', 'T140000', (string) $server->object($work['livio'] . $uid . '.ics')));
sync();
check('the organizer moves it on the phone: the copies follow', str_contains((string) $server->object($work['markus'] . $uid . '.ics'), 'T140000') && str_contains((string) $server->object($work['vivian'] . $uid . '.ics'), 'T140000'));

$quiet = sync();
$quiet2 = sync();
check('nothing to do: nothing written, run after run', $quiet['copies'] === 0 && $quiet2['copies'] === 0, [$quiet['copies'], $quiet2['copies']]);

// Markus deletes his copy on the phone: that is declining.
$server->delete($work['markus'], $uid . '.ics');
sync();
check('a copy deleted on the phone counts as declined', CalendarIcsWriter::partstat((string) $server->object($work['livio'] . $uid . '.ics'), MARKUS) === 'DECLINED');
sync();
check('... and is not written back', $server->object($work['markus'] . $uid . '.ics') === null && (copyRecord($uid, MARKUS)['state'] ?? null) === 'removed');
$events->respond($uid, 'accepted', $markus);
check('accepting in the CRM afterwards brings it back', $server->object($work['markus'] . $uid . '.ics') !== null && (copyRecord($uid, MARKUS)['state'] ?? null) === 'active');

// Vivian makes an appointment on her phone with Livio in it.
$phoneMade = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Apple Inc.//iPhone OS 18//EN\nBEGIN:VEVENT\nUID:PHONE-MADE-1\nDTSTAMP:20260101T000000Z\n"
    . "DTSTART:" . str_replace('-', '', day(4)) . "T090000Z\nDTEND:" . str_replace('-', '', day(4)) . "T100000Z\nSUMMARY:Abstimmung vom iPhone\n"
    . "ORGANIZER;CN=Vivian:mailto:" . VIVIAN . "\nATTENDEE;PARTSTAT=ACCEPTED:mailto:" . VIVIAN . "\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:" . LIVIO . "\n"
    . "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\nEND:VEVENT\nEND:VCALENDAR\n";
$server->put($work['vivian'], 'PHONE-MADE-1.ics', $phoneMade);
sync();
check('made on a phone with Livio in it: Livio gets his copy', $server->object($work['livio'] . 'PHONE-MADE-1.ics') !== null);
check('... shown once', count(array_filter(items($livio, day(0), day(7)), static fn ($i) => $i['title'] === 'Abstimmung vom iPhone')) === 1);
$server->delete($work['vivian'], 'PHONE-MADE-1.ics');
sync();
check('deleted on the organizer\'s phone: the copy goes too', $server->object($work['livio'] . 'PHONE-MADE-1.ics') === null && copyRecord('PHONE-MADE-1', LIVIO) === null);

section('Series');
$series = $events->create(['title' => 'Weekly', 'start' => day(0) . 'T09:00', 'end' => day(0) . 'T09:30', 'attendees' => [MARKUS],
    'repeat' => ['freq' => 'weekly', 'until' => (new DateTimeImmutable(day(0), $zone))->modify('+5 weeks')->format('Y-m-d')]], $livio);
$sid = $series['uid'];
$occurrences = static function (string $sourceHref) use ($sid): array {
    $stmt = Database::getInstance()->prepare("SELECT i.recurrence_id, i.starts_at FROM calendar_instances i JOIN calendar_sources s ON s.id = i.source_id WHERE i.uid = :uid AND s.href = :href ORDER BY i.starts_at");
    $stmt->execute(['uid' => $sid, 'href' => $sourceHref]);
    return $stmt->fetchAll();
};
$before = $occurrences($work['livio']);
check('a weekly series of six', count($before) === 6 && count($occurrences($work['markus'])) === 6, count($before));
$third = $before[2]['recurrence_id'];
$thirdDay = (new DateTimeImmutable($before[2]['starts_at'], new DateTimeZone('UTC')))->setTimezone($zone)->format('Y-m-d');
$events->update($sid, $third, 'occurrence', ['start' => $thirdDay . 'T15:00', 'end' => $thirdDay . 'T15:30', 'title' => 'Weekly (später)'], $livio);
$after = $occurrences($work['livio']);
$movedOne = array_values(array_filter($after, static fn ($r) => $r['recurrence_id'] === $third))[0] ?? null;
check('one occurrence moved, the others not', $movedOne !== null && str_ends_with((new DateTimeImmutable($movedOne['starts_at'], new DateTimeZone('UTC')))->setTimezone($zone)->format('H:i'), '15:00')
    && $after[0]['starts_at'] === $before[0]['starts_at'] && count($after) === 6);
check('... in Markus\'s copy too', count(array_filter($occurrences($work['markus']), static fn ($r) => $r['recurrence_id'] === $third && $r['starts_at'] === $movedOne['starts_at'])) === 1);

$first = $after[0];
$firstLocal = (new DateTimeImmutable($first['starts_at'], new DateTimeZone('UTC')))->setTimezone($zone);
$events->update($sid, $first['recurrence_id'], 'series', ['start' => $firstLocal->format('Y-m-d') . 'T09:30', 'end' => $firstLocal->format('Y-m-d') . 'T10:00'], $livio);
$shifted = $occurrences($work['livio']);
$times = array_map(static fn ($r) => (new DateTimeImmutable($r['starts_at'], new DateTimeZone('UTC')))->setTimezone($zone)->format('H:i'), $shifted);
check('the whole series half an hour later; the moved occurrence keeps its own time', count($shifted) === 6
    && count(array_filter($times, static fn ($t) => $t === '09:30')) === 5 && in_array('15:00', $times, true), $times);

$fourth = $shifted[3]['recurrence_id'];
$events->cancel($sid, $fourth, 'occurrence', null, $livio);
check('one occurrence cancelled, for everyone', count($occurrences($work['livio'])) === 5 && count($occurrences($work['markus'])) === 5);

CalendarLinks::add($sid, 'project', $projectId, null);
$events->cancel($sid, null, 'series', null, $livio);
check('the whole series cancelled: original, copies and links gone', $server->object($work['livio'] . $sid . '.ics') === null
    && $server->object($work['markus'] . $sid . '.ics') === null && CalendarLinks::forEvent($sid) === [] && copyRecord($sid, MARKUS) === null);

section('Calendars that cannot take it');
$db->exec("UPDATE calendar_sources SET writable = 0 WHERE href = '" . $work['vivian'] . "'");
$readOnly = $events->create(['title' => 'Mit Vivian', 'start' => day(2) . 'T13:00', 'end' => day(2) . 'T14:00', 'attendees' => [VIVIAN]], $livio);
check('a work calendar shared to read only gets no copy, and the person writing is told', $server->object($work['vivian'] . $readOnly['uid'] . '.ics') === null
    && (bool) array_filter($readOnly['warnings'], static fn ($w) => str_contains($w, 'read only')), $readOnly['warnings']);
check('nobody can create in a calendar that is read only', str_contains((string) attempt(fn () => $events->create(['title' => 'X', 'organizer' => VIVIAN, 'start' => day(2) . 'T13:00', 'end' => day(2) . 'T14:00'], $livio)), 'InvalidArgument'));
$db->exec("UPDATE calendar_sources SET writable = 1 WHERE href = '" . $work['vivian'] . "'");

section('Made-up (demo) calendars');
$db->exec("INSERT INTO calendar_sources (href, owner_email, display_name, kind, writable, visibility, enabled) VALUES ('demo:" . MARKUS . "/work/', '" . MARKUS . "', 'Demo', 'work', 1, 'details', 1)");
$db->exec("UPDATE calendar_sources SET enabled = 0 WHERE href = '" . $work['markus'] . "'");
$demo = $events->create(['title' => 'Demo-Treffen', 'organizer' => MARKUS, 'start' => day(3) . 'T10:00', 'end' => day(3) . 'T11:00', 'attendees' => [LIVIO]], $livio);
$demoRow = $db->query("SELECT e.href FROM calendar_events e JOIN calendar_sources s ON s.id = e.source_id WHERE e.uid = '" . $demo['uid'] . "' AND s.href LIKE 'demo:%'")->fetchColumn();
check('an appointment in a made-up calendar lives in the database only', $demoRow !== false && $server->object($work['livio'] . $demo['uid'] . '.ics') === null);
check('... and is never copied into a real calendar', (bool) array_filter($demo['warnings'], static fn ($w) => str_contains($w, 'made-up')), $demo['warnings']);
sync();
check('... not by the sync either', $server->object($work['livio'] . $demo['uid'] . '.ics') === null);
$db->exec("DELETE FROM calendar_sources WHERE href LIKE 'demo:%'");
$db->exec("UPDATE calendar_sources SET enabled = 1 WHERE href = '" . $work['markus'] . "'");
sync();

section('Links');
$guest = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:with-anna\nDTSTAMP:20260101T000000Z\nDTSTART:" . str_replace('-', '', day(1)) . "T150000Z\nDTEND:" . str_replace('-', '', day(1)) . "T160000Z\n"
    . "SUMMARY:Call mit Anna\nORGANIZER:mailto:" . LIVIO . "\nATTENDEE;PARTSTAT=ACCEPTED:mailto:" . LIVIO . "\nATTENDEE;CN=Anna:mailto:anna.berger@alpenbank.example\nEND:VEVENT\nEND:VCALENDAR\n";
$server->put($work['livio'], 'with-anna.ics', $guest);
sync();
$sheet = $events->sheet('with-anna', null, $livio);
check('a guest who is a contact is suggested for linking', count($sheet['suggestions']) === 1 && $sheet['suggestions'][0]['target_id'] === $annaId, $sheet['suggestions']);
check('... and shown as a guest, not as team', count($sheet['guests']) === 1 && $sheet['guests'][0]['email'] === 'anna.berger@alpenbank.example');
CalendarLinks::add('with-anna', 'contact', $annaId, null);
$forAnna = CalendarLinks::appointments('contact', $annaId, $livio);
check('the contact lists its appointments', count($forAnna['upcoming']) === 2, array_column($forAnna['upcoming'], 'title'));
CalendarLinks::add('zahnarzt', 'contact', $annaId, null);
$forAnnaLivio = CalendarLinks::appointments('contact', $annaId, $livio);
check('an appointment hidden from the viewer is not listed for them', !in_array('Private', array_column($forAnnaLivio['upcoming'], 'title'), true)
    && !in_array('Zahnarzt', array_column($forAnnaLivio['upcoming'], 'title'), true));
check('the link picker finds contacts and projects', count(CalendarLinks::targets('alpen')) === 2, CalendarLinks::targets('alpen'));

section('Why read only');
$own = $events->sheet('zahnarzt', null, $vivian);
check('own private appointment: no edit, and the sheet says why', !$own['can']['edit'] && str_contains((string) $own['can']['reason'], 'private calendar'), $own['can']);
$server->put($work['livio'], 'from-outside.ics', "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:from-outside\nDTSTAMP:20260101T000000Z\nDTSTART:" . str_replace('-', '', day(5)) . "T090000Z\nDTEND:" . str_replace('-', '', day(5)) . "T100000Z\n"
    . "SUMMARY:Einladung von aussen\nORGANIZER:mailto:someone@example.org\nATTENDEE;PARTSTAT=ACCEPTED:mailto:" . LIVIO . "\nEND:VEVENT\nEND:VCALENDAR\n");
sync();
$outside = $events->sheet('from-outside', null, $livio);
check('organized outside the team: no edit, and the sheet says who can', !$outside['can']['edit'] && str_contains((string) $outside['can']['reason'], 'outside the team'), $outside['can']);
$ownItems = items($vivian, day(2), day(3));
$dentist = find($ownItems, 'Zahnarzt');
check('own private-calendar appointment is marked as such, a work one is not', ($dentist['private_calendar'] ?? null) === true
    && (find(items($livio, day(0), day(7)), 'Projektmeeting (Raum 2)')['private_calendar'] ?? null) === false, $dentist);
check('an appointment that can be changed carries no reason', $events->sheet($uid, null, $livio)['can']['reason'] === null);

section('Another calendar');
$alone = $events->create(['title' => 'Nur ich', 'start' => day(4) . 'T09:00', 'end' => day(4) . 'T10:00'], $livio);
$puts = $server->puts;
$events->update($alone['uid'], null, 'series', ['organizer' => VIVIAN, 'attendees' => [], 'base' => $events->sheet($alone['uid'], null, $livio)['base']], $livio);
$there = (string) $server->object($work['vivian'] . $alone['uid'] . '.ics');
check('a plain appointment moves into Vivian\'s calendar and out of Livio\'s', $there !== '' && $server->object($work['livio'] . $alone['uid'] . '.ics') === null);
check('... still plain: no organizer, nobody invited', !str_contains($there, 'ORGANIZER') && !str_contains($there, 'ATTENDEE'));
check('... the sheet says whose calendar it is now', $events->sheet($alone['uid'], null, $livio)['calendar']['email'] === VIVIAN);

$handover = $events->create(['title' => 'Übergabe', 'start' => day(4) . 'T11:00', 'end' => day(4) . 'T12:00', 'attendees' => [MARKUS]], $livio);
$hu = $handover['uid'];
$events->update($hu, null, 'series', ['organizer' => MARKUS, 'attendees' => [LIVIO], 'base' => $events->sheet($hu, null, $livio)['base']], $livio);
$markusIcs = str_replace(["\r\n ", "\n "], '', (string) $server->object($work['markus'] . $hu . '.ics'));
$livioIcs = (string) $server->object($work['livio'] . $hu . '.ics');
check('moved to Markus with Livio still in it: Markus\'s is the original, organized by him',
    (bool) preg_match('/^ORGANIZER;[^\r\n]*:mailto:' . preg_quote(MARKUS, '/') . '/m', $markusIcs) && copyRecord($hu, MARKUS) === null);
check('... Livio takes part, accepted, and his is now a copy', CalendarIcsWriter::partstat($markusIcs, LIVIO) === 'ACCEPTED'
    && $livioIcs === (string) $server->object($work['markus'] . $hu . '.ics') && (copyRecord($hu, LIVIO)['state'] ?? null) === 'active');
check('... nobody chair but Markus, no SCHEDULE-AGENT on him', substr_count($markusIcs, 'ROLE=CHAIR') === 1
    && !preg_match('/^ATTENDEE;[^\r\n]*SCHEDULE-AGENT[^\r\n]*:mailto:' . preg_quote(MARKUS, '/') . '/m', $markusIcs));
$item = find(items($livio, day(0), day(7)), 'Übergabe');
check('... shown once with both of them', $item !== null && $item['people'] === [LIVIO, MARKUS], $item);
$puts = $server->puts;
sync();
check('... and the next sync leaves it as it is', $server->puts === $puts && $server->object($work['livio'] . $hu . '.ics') === $livioIcs);
check('without the edit right nobody moves it', str_contains((string) attempt(fn () => $events->update($hu, null, 'series', ['organizer' => VIVIAN], $markus)), 'DomainException'));

section('Private calendars: their owner alone');
// Livio shares his private calendar to read and write now.
$server->calendars[$private['livio']]['writable'] = true;
sync(true);
$choices = array_column($events->writableCalendars($livio), 'key');
check('my private calendar is a choice for me', in_array('private:' . LIVIO, $choices, true), $choices);
check('... but nobody else\'s', !in_array('private:' . MARKUS, $choices, true) && !in_array('private:' . LIVIO, array_column($events->writableCalendars($vivian), 'key'), true));
$mine = $events->create(['title' => 'Physio', 'organizer' => 'private:' . LIVIO, 'start' => day(5) . 'T07:00', 'end' => day(5) . 'T08:00'], $livio);
$physio = (string) $server->object($private['livio'] . $mine['uid'] . '.ics');
check('a private appointment goes into my private calendar, plain', $physio !== '' && !str_contains($physio, 'ORGANIZER'));
check('... nobody from the team can be in it', str_contains((string) attempt(fn () => $events->create(['title' => 'X', 'organizer' => 'private:' . LIVIO, 'attendees' => [MARKUS], 'start' => day(5) . 'T09:00', 'end' => day(5) . 'T10:00'], $livio)), 'InvalidArgument'));
check('... nobody else can put one into my private calendar, edit right or not', str_contains((string) attempt(fn () => $events->create(['title' => 'X', 'organizer' => 'private:' . LIVIO, 'start' => day(5) . 'T09:00', 'end' => day(5) . 'T10:00'], $vivian)), 'DomainException'));
$sheetMine = $events->sheet($mine['uid'], null, $livio);
check('I can change and delete it', $sheetMine['can']['edit'] && $sheetMine['can']['cancel'] && $sheetMine['calendar']['key'] === 'private:' . LIVIO, $sheetMine['can']);
$db->exec("UPDATE calendar_sources SET visibility = 'details' WHERE href = '" . $private['livio'] . "'");
$sheetVivian = $events->sheet($mine['uid'], null, $vivian);
check('Vivian (edit right) sees it, set to details, but may not change it - and is told why', !$sheetVivian['can']['edit'] && str_contains((string) $sheetVivian['can']['reason'], 'private calendar'), $sheetVivian['can']);
check('... and cannot, through the API either', str_contains((string) attempt(fn () => $events->update($mine['uid'], null, 'series', ['location' => 'X'], $vivian)), 'DomainException'));
$db->exec("UPDATE calendar_sources SET visibility = 'private' WHERE href = '" . $private['livio'] . "'");
$events->update($mine['uid'], null, 'series', ['location' => 'Praxis', 'base' => $sheetMine['base']], $livio);
check('my change is written into my private calendar', str_contains((string) $server->object($private['livio'] . $mine['uid'] . '.ics'), 'LOCATION:Praxis'));
$events->update($mine['uid'], null, 'series', ['organizer' => LIVIO, 'attendees' => [], 'base' => $events->sheet($mine['uid'], null, $livio)['base']], $livio);
check('moved from my private into my work calendar', $server->object($work['livio'] . $mine['uid'] . '.ics') !== null && $server->object($private['livio'] . $mine['uid'] . '.ics') === null);
$events->update($mine['uid'], null, 'series', ['organizer' => 'private:' . LIVIO, 'base' => $events->sheet($mine['uid'], null, $livio)['base']], $livio);
check('... and back', $server->object($private['livio'] . $mine['uid'] . '.ics') !== null && $server->object($work['livio'] . $mine['uid'] . '.ics') === null);
$shared = $events->create(['title' => 'Mit Markus', 'start' => day(5) . 'T11:00', 'end' => day(5) . 'T12:00', 'attendees' => [MARKUS]], $livio);
check('a meeting with Markus in it cannot go into my private calendar', str_contains((string) attempt(fn () => $events->update($shared['uid'], null, 'series', ['organizer' => 'private:' . LIVIO, 'base' => $events->sheet($shared['uid'], null, $livio)['base']], $livio)), 'InvalidArgument'));
$events->cancel($mine['uid'], null, 'series', null, $livio);
check('I can delete it', $server->object($private['livio'] . $mine['uid'] . '.ics') === null);
$server->calendars[$private['livio']]['writable'] = false;
sync(true);
$server->put($private['livio'], 'ro.ics', "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:ro-private\nDTSTAMP:20260101T000000Z\nDTSTART:" . str_replace('-', '', day(5)) . "T150000Z\nDTEND:" . str_replace('-', '', day(5)) . "T160000Z\nSUMMARY:Nur lesen\nEND:VEVENT\nEND:VCALENDAR\n");
sync();
$ro = $events->sheet('ro-private', null, $livio);
check('shared to read only again: mine, but not to change - and it says so', !$ro['can']['edit'] && str_contains((string) $ro['can']['reason'], 'read only'), $ro['can']);

section('Types and travel time');
$visit = $events->create(['title' => 'Termin bei Alpenbank', 'type' => 'external', 'organizer' => VIVIAN, 'start' => day(6) . 'T12:00', 'end' => day(6) . 'T13:00'], $livio);
check('the type is kept in the CRM, not on the server', CalendarTypes::of($visit['uid']) === 'external' && !str_contains((string) $server->object($work['vivian'] . $visit['uid'] . '.ics'), 'external'));
check('... the sheet has it', $events->sheet($visit['uid'], null, $livio)['type'] === 'external');
$item = find(items($livio, day(0), day(7)), 'Termin bei Alpenbank');
check('... the grid gets it with 45 minutes of travel around it', $item !== null && $item['type'] === 'external' && $item['buffer'] === 45, $item);
check('only online, external or office', str_contains((string) attempt(fn () => $events->create(['title' => 'X', 'type' => 'somewhere', 'start' => day(6) . 'T15:00', 'end' => day(6) . 'T16:00'], $livio)), 'InvalidArgument'));
$puts = $server->puts;
$events->update($visit['uid'], null, 'series', ['type' => 'office'], $livio);
check('changing only the type never writes to the server', $server->puts === $puts && CalendarTypes::of($visit['uid']) === 'office');
$events->update($visit['uid'], null, 'series', ['type' => 'external'], $livio);

$at = static fn (string $time) => (new DateTimeImmutable(day(6) . ' ' . $time, $zone))->getTimestamp();
$clash = CalendarAvailability::conflicts([VIVIAN, MARKUS], $at('12:30'), $at('13:30'));
check('a participant who is busy then is found, with the time; one who is free is not', count($clash[VIVIAN] ?? []) === 1 && !isset($clash[MARKUS]), $clash);
check('... the appointment being edited does not clash with itself', CalendarAvailability::conflicts([VIVIAN], $at('12:30'), $at('13:30'), $visit['uid']) === []);
check('... and touching is not overlapping', CalendarAvailability::conflicts([VIVIAN], $at('13:00'), $at('14:00')) === []);
CalendarSettings::setWorkingHours(['days' => [1, 2, 3, 4, 5, 6, 7], 'start' => '08:00', 'end' => '18:00', 'buffer' => 0, 'external_buffer' => 45]);
$slots = CalendarAvailability::freeSlots([VIVIAN], 30, day(6), day(7), CalendarSettings::workingHours(), 0);
$local = array_map(static fn ($s) => (new DateTimeImmutable($s['start']))->setTimezone($zone)->format('H:i') . '-' . (new DateTimeImmutable($s['end']))->setTimezone($zone)->format('H:i'), $slots);
check('"Find a free slot" keeps 45 minutes clear around an external appointment', $local === ['08:00-11:15', '13:45-18:00'], $local);

$db->exec("UPDATE calendar_sources SET visibility = 'private' WHERE href = '" . $work['vivian'] . "'");
$masked = null;
foreach (items($markus, day(6), day(7)) as $candidate) {
    if ($candidate['masked']) {
        $masked = $candidate;
    }
}
check('a Private one shows its travel time to others, not its type', $masked !== null && $masked['buffer'] === 45 && !array_key_exists('type', $masked), $masked);
$db->exec("UPDATE calendar_sources SET visibility = 'details' WHERE href = '" . $work['vivian'] . "'");

section('Search');
$titles = static fn (array $found) => array_column(array_merge($found['upcoming'], $found['past']), 'title');
check('by title, whatever the case, umlauts too', $titles(CalendarView::search('ÜBERGABE', $livio)) === ['Übergabe'], $titles(CalendarView::search('ÜBERGABE', $livio)));
check('by a guest\'s name, every word has to match', $titles(CalendarView::search('call anna', $livio)) === ['Call mit Anna'] && $titles(CalendarView::search('call bernd', $livio)) === []);
CalendarLinks::add($hu, 'project', $projectId, null);
$byProject = CalendarView::search('relaunch', $livio);
check('by a linked project, which the result names', $titles($byProject) === ['Übergabe'] && ($byProject['upcoming'][0]['links'][0]['name'] ?? null) === 'Relaunch', $byProject);
check('by type', in_array('Termin bei Alpenbank', $titles(CalendarView::search('external', $livio)), true));
check('never by what a Private appointment hides', $titles(CalendarView::search('zahnarzt', $livio)) === [] && $titles(CalendarView::search('zahnarzt', $vivian)) === ['Zahnarzt']);
check('one letter is not a search', $titles(CalendarView::search('a', $livio)) === []);

echo "\n" . ($failures === 0 ? "All {$passes} checks passed." : "{$failures} of " . ($passes + $failures) . " checks FAILED.") . "\n";
exit($failures === 0 ? 0 : 1);
