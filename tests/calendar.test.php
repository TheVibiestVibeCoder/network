<?php
/**
 * Team calendar tests - phase 1 of docs/kalender-spec.md
 *
 *     php tests/calendar.test.php
 *
 * Runs the real sync, view and availability code against a scratch SQLite
 * database and a calendar server held in memory: parsing, series with moved
 * and cancelled occurrences, the switch to summer time, all-day and floating
 * appointments, retention, change detection, the privacy rules and free-slot
 * search. Never touches data/crm.db or the mail server.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

define('APP_ROOT', dirname(__DIR__));
$scratch = sys_get_temp_dir() . '/crm-calendar-test-' . bin2hex(random_bytes(4));
mkdir($scratch, 0700);
define('DATA_DIR', $scratch);
define('DB_PATH', $scratch . '/crm.db');

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/User.php';
require_once APP_ROOT . '/includes/CalendarSync.php';
require_once APP_ROOT . '/includes/CalendarView.php';
require_once APP_ROOT . '/includes/CalendarSettings.php';

register_shutdown_function(static function () use ($scratch): void {
    foreach (glob($scratch . '/*') ?: [] as $file) {
        @unlink($file);
    }
    @rmdir($scratch);
});

// A calendar server in memory
require_once __DIR__ . '/FakeCalDav.php';

// =============================================================================
// Fixtures
// =============================================================================

const VIENNA = "BEGIN:VTIMEZONE\nTZID:Europe/Vienna\nBEGIN:DAYLIGHT\nTZOFFSETFROM:+0100\nTZOFFSETTO:+0200\nTZNAME:CEST\n"
    . "DTSTART:19700329T020000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\nEND:DAYLIGHT\nBEGIN:STANDARD\nTZOFFSETFROM:+0200\n"
    . "TZOFFSETTO:+0100\nTZNAME:CET\nDTSTART:19701025T030000\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\nEND:STANDARD\nEND:VTIMEZONE";

function ics(string ...$events): string
{
    return "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\n" . VIENNA . "\n" . implode("\n", $events) . "\nEND:VCALENDAR\n";
}

function vevent(array $lines): string
{
    return "BEGIN:VEVENT\nDTSTAMP:20261101T000000Z\n" . implode("\n", $lines) . "\nEND:VEVENT";
}

const LIVIO = 'livio@disinfoconsulting.eu';
const MARKUS = 'markus@disinfoconsulting.eu';
const VIVIAN = 'vivian@disinfoconsulting.eu';
const GUEST = 'guest@example.org';

$work = ['livio' => '/calendars/' . LIVIO . '/calendar/', 'markus' => '/calendars/' . MARKUS . '/calendar/', 'vivian' => '/calendars/' . VIVIAN . '/calendar/'];
$private = ['livio' => '/calendars/' . LIVIO . '/calendar-p1/', 'markus' => '/calendars/' . MARKUS . '/calendar-p2/', 'vivian' => '/calendars/' . VIVIAN . '/calendar-p3/'];

$server = new FakeCalDav();
foreach ([['livio', LIVIO], ['markus', MARKUS], ['vivian', VIVIAN]] as [$key, $email]) {
    $server->addCalendar($work[$key], $email, 'Public (' . $email . ')', 'work', true);
    $server->addCalendar($private[$key], $email, 'Private (' . $email . ')', 'private', false);
}

$attendee = static function (string $email, string $name, string $partstat = 'ACCEPTED'): string {
    return 'ATTENDEE;CN=' . $name . ';PARTSTAT=' . $partstat . ':mailto:' . $email;
};

$server->put($work['livio'], 'single.ics', ics(vevent([
    'UID:single-1', 'DTSTART;TZID=Europe/Vienna:20261216T090000', 'DTEND;TZID=Europe/Vienna:20261216T100000',
    'SUMMARY:Steuerberater', 'LOCATION:Büro Neustiftgasse', 'DESCRIPTION:Unterlagen mitnehmen',
])));

$server->put($work['livio'], 'series.ics', ics(
    vevent([
        'UID:series-1', 'DTSTART;TZID=Europe/Vienna:20270325T090000', 'DTEND;TZID=Europe/Vienna:20270325T093000',
        'RRULE:FREQ=DAILY;COUNT=6', 'EXDATE;TZID=Europe/Vienna:20270327T090000', 'SUMMARY:Daily',
    ]),
    vevent([
        'UID:series-1', 'RECURRENCE-ID;TZID=Europe/Vienna:20270329T090000', 'DTSTART;TZID=Europe/Vienna:20270329T140000',
        'DTEND;TZID=Europe/Vienna:20270329T143000', 'SUMMARY:Daily (verschoben)',
    ])
));

$server->put($private['livio'], 'urlaub.ics', ics(vevent([
    'UID:allday-1', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261227', 'SUMMARY:Urlaub', 'TRANSP:OPAQUE',
])));

$server->put($work['livio'], 'old.ics', ics(vevent([
    'UID:old-1', 'DTSTART:20240110T090000Z', 'DTEND:20240110T100000Z', 'SUMMARY:Längst vorbei',
])));

$server->put($work['livio'], 'cancelled.ics', ics(vevent([
    'UID:cancelled-1', 'DTSTART;TZID=Europe/Vienna:20261216T070000', 'DTEND;TZID=Europe/Vienna:20261216T073000',
    'SUMMARY:Abgesagt', 'STATUS:CANCELLED',
])));

$server->put($work['markus'], 'duration.ics', ics(vevent([
    'UID:duration-1', 'DTSTART:20261216T130000Z', 'DURATION:PT45M', 'SUMMARY:Call Kunde',
])));

$server->put($work['markus'], 'floating.ics', ics(vevent([
    'UID:floating-1', 'DTSTART:20261217T100000', 'DTEND:20261217T110000', 'SUMMARY:Ohne Zeitzone',
])));

$server->put($work['markus'], 'privat.ics', ics(vevent([
    'UID:class-1', 'DTSTART;TZID=Europe/Vienna:20261216T150000', 'DTEND;TZID=Europe/Vienna:20261216T160000',
    'SUMMARY:Privatsache', 'CLASS:PRIVATE',
])));

// One meeting, two copies (Livio organises, Markus and a guest attend).
$shared = ics(vevent([
    'UID:shared-1', 'DTSTART;TZID=Europe/Vienna:20261216T110000', 'DTEND;TZID=Europe/Vienna:20261216T120000',
    'SUMMARY:Projekt-Jour-fixe', 'LOCATION:https://meet.google.com/abc-defg-hij',
    'ORGANIZER;CN=Livio:mailto:' . LIVIO,
    $attendee(LIVIO, 'Livio'), $attendee(MARKUS, 'Markus', 'TENTATIVE'), $attendee(GUEST, 'Guest', 'NEEDS-ACTION'),
]));
$server->put($work['livio'], 'shared.ics', $shared);
$server->put($work['markus'], 'shared-copy.ics', $shared);

// The whole team, three copies.
$team = ics(vevent([
    'UID:team-1', 'DTSTART;TZID=Europe/Vienna:20261216T163000', 'DTEND;TZID=Europe/Vienna:20261216T173000',
    'SUMMARY:Teamrunde', 'ORGANIZER;CN=Livio:mailto:' . LIVIO,
    $attendee(LIVIO, 'Livio'), $attendee(MARKUS, 'Markus'), $attendee(VIVIAN, 'Vivian'),
]));
foreach (['livio', 'markus', 'vivian'] as $key) {
    $server->put($work[$key], 'team.ics', $team);
}

$server->put($work['vivian'], 'arzt.ics', ics(vevent([
    'UID:busy-1', 'DTSTART;TZID=Europe/Vienna:20261216T090000', 'DTEND;TZID=Europe/Vienna:20261216T100000',
    'SUMMARY:Arzttermin', 'LOCATION:Ordination Dr. X',
])));
$server->put($work['vivian'], 'frei.ics', ics(vevent([
    'UID:free-1', 'DTSTART;TZID=Europe/Vienna:20261216T120000', 'DTEND;TZID=Europe/Vienna:20261216T130000',
    'SUMMARY:Nur ein Hinweis', 'TRANSP:TRANSPARENT',
])));

// CRM accounts, so calendar owners map to people.
$db = Database::getInstance();
foreach ([[LIVIO, 'Livio Zalozieckyj', 'admin'], [MARKUS, 'Markus Schwinghammer', 'member'], [VIVIAN, 'Vivian Lösch', 'member']] as [$email, $name, $role]) {
    $db->prepare("INSERT INTO users (email, name, role, status) VALUES (:email, :name, :role, 'active')")
        ->execute(['email' => $email, 'name' => $name, 'role' => $role]);
}
// Markus has a profile picture (the stored file's name is all that matters here).
$db->exec("UPDATE users SET avatar = 'markus-photo.png' WHERE email = '" . MARKUS . "'");

// =============================================================================
// Assertions
// =============================================================================

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

function instances(string $uid): array
{
    $stmt = Database::getInstance()->prepare("SELECT * FROM calendar_instances WHERE uid = :uid ORDER BY starts_at");
    $stmt->execute(['uid' => $uid]);
    return $stmt->fetchAll();
}

function sourceId(string $href): int
{
    $stmt = Database::getInstance()->prepare("SELECT id FROM calendar_sources WHERE href = :href");
    $stmt->execute(['href' => $href]);
    return (int) $stmt->fetchColumn();
}

function viewer(string $email, bool $admin = false): array
{
    return ['user_id' => null, 'is_owner' => false, 'is_admin' => $admin, 'can_view' => true, 'can_edit' => false, 'emails' => [$email]];
}

function item(array $items, callable $match): ?array
{
    foreach ($items as $item) {
        if ($match($item)) {
            return $item;
        }
    }
    return null;
}

// =============================================================================
// Sync: discovery and first run
// =============================================================================

section('Discovery and first sync');
$sync = new CalendarSync($server);
$stats = $sync->run(true);
check('six calendars found', $stats['discovered'] === 6, $stats['discovered']);
check('no errors', $stats['errors'] === 0, $stats['errors']);
$people = $db->query("SELECT email, user_id, color, position FROM calendar_people ORDER BY position")->fetchAll();
check('three people, in order of discovery', array_column($people, 'email') === [LIVIO, MARKUS, VIVIAN], array_column($people, 'email'));
check('people mapped to CRM accounts', count(array_filter(array_column($people, 'user_id'))) === 3);
check('person colours from the palette', array_column($people, 'color') === array_slice(CalendarSync::PALETTE, 0, 3), array_column($people, 'color'));
$defaults = $db->query("SELECT kind, visibility FROM calendar_sources ORDER BY id")->fetchAll();
check('work calendars default to details, private ones to private', array_reduce($defaults, static function (bool $ok, array $row): bool {
    return $ok && $row['visibility'] === ($row['kind'] === 'work' ? 'details' : 'private');
}, true), $defaults);

section('Reading appointments');
$single = instances('single-1');
check('timed appointment stored in UTC (09:00 Vienna in winter = 08:00 UTC)', count($single) === 1 && $single[0]['starts_at'] === '2026-12-16 08:00:00' && $single[0]['ends_at'] === '2026-12-16 09:00:00', $single);
check('title, place and description kept', $single && $single[0]['summary'] === 'Steuerberater' && $single[0]['location'] === 'Büro Neustiftgasse' && $single[0]['description'] === 'Unterlagen mitnehmen');

$series = instances('series-1');
$starts = array_column($series, 'starts_at');
check('series: six days minus one cancelled = five occurrences', count($series) === 5, $starts);
check('series: winter time before the switch (08:00 UTC)', in_array('2027-03-25 08:00:00', $starts, true) && in_array('2027-03-26 08:00:00', $starts, true), $starts);
check('series: the cancelled occurrence (27 March) is gone', !array_filter($starts, static function (string $s): bool {
    return strpos($s, '2027-03-27') === 0;
}), $starts);
check('series: summer time after the switch on 28 March (07:00 UTC)', in_array('2027-03-28 07:00:00', $starts, true) && in_array('2027-03-30 07:00:00', $starts, true), $starts);
$moved = item($series, static function (array $row): bool {
    return $row['starts_at'] === '2027-03-29 12:00:00';
});
check('series: the moved occurrence at 14:00 Vienna, with its own title', $moved !== null && $moved['summary'] === 'Daily (verschoben)' && $moved['recurrence_id'] === '2027-03-29 07:00:00', $moved);

$allDay = instances('allday-1');
check('all-day: plain dates, end exclusive', count($allDay) === 1 && $allDay[0]['all_day'] == 1 && $allDay[0]['starts_at'] === '2026-12-24' && $allDay[0]['ends_at'] === '2026-12-27', $allDay);

$duration = instances('duration-1');
check('DURATION instead of DTEND', count($duration) === 1 && $duration[0]['ends_at'] === '2026-12-16 13:45:00', $duration);

$floating = instances('floating-1');
check('time without a zone read as Vienna (10:00 = 09:00 UTC)', count($floating) === 1 && $floating[0]['starts_at'] === '2026-12-17 09:00:00', $floating);

$old = $db->query("SELECT archived, ics, summary FROM calendar_events WHERE uid = 'old-1'")->fetch();
check('older than the retention period: archived, contents gone', $old && (int) $old['archived'] === 1 && $old['ics'] === null && $old['summary'] === null, $old);
check('archived appointment has no occurrences', instances('old-1') === []);

check('video link found in the location', CalendarIcs::videoLink('https://meet.google.com/abc-defg-hij') === 'https://meet.google.com/abc-defg-hij');
check('ordinary links are not video calls', CalendarIcs::videoLink('Details: https://example.org/agenda') === null);

// =============================================================================
// Change detection
// =============================================================================

section('Change detection');
$server->fetched = 0;
$stats = $sync->run();
check('second run downloads the just-changed objects once more and finds them unchanged', $server->fetched === 15 && $stats['changed'] === 0, ['fetched' => $server->fetched, 'stats' => $stats]);
check('... and clears the second look', (int) $db->query("SELECT COUNT(*) FROM calendar_events WHERE recheck = 1")->fetchColumn() === 0);

$server->fetched = 0;
$stats = (new CalendarSync($server))->run();
check('third run: CTags unchanged, nothing downloaded', $server->fetched === 0 && $stats['changed'] === 0, ['fetched' => $server->fetched, 'stats' => $stats]);

$server->put($work['livio'], 'single.ics', ics(vevent([
    'UID:single-1', 'DTSTART;TZID=Europe/Vienna:20261216T093000', 'DTEND;TZID=Europe/Vienna:20261216T103000',
    'SUMMARY:Steuerberater (verschoben)', 'SEQUENCE:1',
])));
$server->fetched = 0;
$stats = (new CalendarSync($server))->run();
$single = instances('single-1');
check('a changed appointment is downloaded alone and updated', $server->fetched === 1 && $stats['changed'] === 1 && $single[0]['starts_at'] === '2026-12-16 08:30:00', ['fetched' => $server->fetched, 'single' => $single]);

$server->delete($work['markus'], 'floating.ics');
$stats = (new CalendarSync($server))->run();
check('a deleted appointment disappears with its occurrences', $stats['removed'] === 1 && instances('floating-1') === [], $stats);

$lock = fopen(DATA_DIR . '/calendar-sync.lock', 'c');
flock($lock, LOCK_EX);
check('a second run while one holds the lock is skipped', CalendarSync::runLocked(false, $server) === null);
flock($lock, LOCK_UN);
fclose($lock);

// =============================================================================
// Privacy
// =============================================================================

section('What each person may see');
CalendarSettings::updateSource(sourceId($work['vivian']), ['visibility' => 'busy'], viewer(LIVIO, true));

$forLivio = CalendarView::range('2026-12-16', '2026-12-17', viewer(LIVIO));
$json = json_encode($forLivio, JSON_UNESCAPED_UNICODE);

$arzt = item($forLivio, static function (array $i): bool {
    return $i['owners'] === [VIVIAN] && $i['masked'];
});
check('"busy" calendar: others see the time, titled Busy', $arzt !== null && $arzt['title'] === 'Busy' && $arzt['label'] === 'busy' && $arzt['start'] === '2026-12-16T08:00:00Z', $arzt);
check('"busy" calendar: no place, description or people', $arzt !== null && $arzt['location'] === null && $arzt['description'] === null && $arzt['attendees'] === [] && $arzt['organizer'] === null);
check('nothing of the hidden appointment is in the response', strpos($json, 'Arzttermin') === false && strpos($json, 'Ordination') === false && strpos($json, 'busy-1') === false);
check('a free entry in a hidden calendar is not shown at all', strpos($json, 'Nur ein Hinweis') === false && count(array_filter($forLivio, static function (array $i): bool {
    return $i['owners'] === [VIVIAN] && $i['start'] === '2026-12-16T11:00:00Z';
})) === 0);

$privat = item($forLivio, static function (array $i): bool {
    return $i['owners'] === [MARKUS] && $i['masked'];
});
check('CLASS:PRIVATE in a details calendar: Private for others', $privat !== null && $privat['title'] === 'Private' && $privat['label'] === 'private', $privat);
check('... and its title is not in the response', strpos($json, 'Privatsache') === false);

$forMarkus = CalendarView::range('2026-12-16', '2026-12-17', viewer(MARKUS));
check('your own private appointment you see in full', item($forMarkus, static function (array $i): bool {
    return $i['title'] === 'Privatsache' && !$i['masked'];
}) !== null);
$forVivian = CalendarView::range('2026-12-16', '2026-12-17', viewer(VIVIAN));
check('your own "busy" calendar you see in full', item($forVivian, static function (array $i): bool {
    return $i['title'] === 'Arzttermin' && $i['location'] === 'Ordination Dr. X';
}) !== null);

$forLivio24 = CalendarView::range('2026-12-24', '2026-12-25', viewer(MARKUS));
$urlaub = item($forLivio24, static function (array $i): bool {
    return $i['owners'] === [LIVIO];
});
check('private calendar: all-day appointment shows as Private', $urlaub !== null && $urlaub['all_day'] === true && $urlaub['title'] === 'Private' && strpos(json_encode($forLivio24), 'Urlaub') === false, $urlaub);

check('cancelled appointments are not shown', strpos($json, 'Abgesagt') === false);

section('Shared appointments');
$sharedItems = array_values(array_filter($forLivio, static function (array $i): bool {
    return $i['title'] === 'Projekt-Jour-fixe';
}));
check('a meeting in two calendars is shown once', count($sharedItems) === 1, count($sharedItems));
$meeting = $sharedItems[0] ?? null;
check('... with both people and both calendars', $meeting && $meeting['people'] === [LIVIO, MARKUS] && $meeting['owners'] === [LIVIO, MARKUS], $meeting);
check('... one guest from outside', $meeting && $meeting['externals'] === 1, $meeting['externals'] ?? null);
check('... the video link', $meeting && $meeting['video_url'] === 'https://meet.google.com/abc-defg-hij');
$markusAnswer = $meeting ? item($meeting['attendees'], static function (array $a): bool {
    return $a['email'] === MARKUS;
}) : null;
check('... and each person\'s answer', $markusAnswer !== null && $markusAnswer['partstat'] === 'TENTATIVE', $markusAnswer);

$teamItems = array_values(array_filter($forLivio, static function (array $i): bool {
    return $i['start'] === '2026-12-16T15:30:00Z';
}));
check('team meeting: once, with all three people, even though one copy is in a "busy" calendar', count($teamItems) === 1 && $teamItems[0]['people'] === [LIVIO, MARKUS, VIVIAN] && !$teamItems[0]['masked'], $teamItems);

section('Yours, and whose face');
$single = item($forLivio, static function (array $i): bool {
    return $i['title'] === 'Steuerberater (verschoben)';
});
$markusCall = item($forLivio, static function (array $i): bool {
    return $i['title'] === 'Call Kunde';
});
check('your own appointment is marked as yours', $single !== null && $single['mine'] === true, $single['mine'] ?? null);
check('a meeting you take part in is marked as yours', $meeting !== null && $meeting['mine'] === true);
check('someone else\'s appointment is not', $markusCall !== null && $markusCall['mine'] === false, $markusCall['mine'] ?? null);
check('a hidden one never is', $arzt !== null && $arzt['mine'] === false);
$forVivianShared = CalendarView::range('2026-12-16', '2026-12-17', viewer(VIVIAN));
$sharedForVivian = item($forVivianShared, static function (array $i): bool {
    return $i['title'] === 'Projekt-Jour-fixe';
});
check('a meeting of two others is not yours', $sharedForVivian !== null && $sharedForVivian['mine'] === false);
$faces = array_column(CalendarView::people(viewer(LIVIO)), 'avatar_url', 'email');
check('a person mapped to an account with a picture brings it along', is_string($faces[MARKUS] ?? null)
    && str_starts_with($faces[MARKUS], 'api/profile.php?action=avatar&id=') && str_contains($faces[MARKUS], '&v=' . substr(hash('sha256', 'markus-photo.png'), 0, 12)), $faces);
check('... and one without a picture none', array_key_exists(LIVIO, $faces) && $faces[LIVIO] === null, $faces);

// All three copies hidden from someone outside the meeting: three separate
// "busy" blocks, never one appointment with three people on it.
foreach (['livio', 'markus'] as $key) {
    CalendarSettings::updateSource(sourceId($work[$key]), ['visibility' => 'busy'], viewer(LIVIO, true));
}
$forGuest = CalendarView::range('2026-12-16', '2026-12-17', viewer(GUEST));
$hiddenCopies = array_values(array_filter($forGuest, static function (array $i): bool {
    return $i['masked'] && $i['start'] === '2026-12-16T15:30:00Z';
}));
check('copies hidden from you stay separate (who meets whom stays hidden)', count($hiddenCopies) === 3 && !array_filter($hiddenCopies, static function (array $i): bool {
    return count($i['people']) !== 1 || count($i['owners']) !== 1;
}), $hiddenCopies);
foreach (['livio', 'markus'] as $key) {
    CalendarSettings::updateSource(sourceId($work[$key]), ['visibility' => 'details'], viewer(LIVIO, true));
}

// =============================================================================
// Free slots
// =============================================================================

section('Find a free slot');
$hours = ['days' => [1, 2, 3, 4, 5], 'start' => '08:00', 'end' => '18:00'];
$before = (new DateTimeImmutable('2026-12-01 00:00', new DateTimeZone('UTC')))->getTimestamp();
$slots = CalendarAvailability::freeSlots([LIVIO, MARKUS], 60, '2026-12-16', '2026-12-17', $hours, $before);
$found = array_map(static function (array $s): string {
    return $s['start'] . '/' . $s['end'];
}, $slots);
// Livio 09:30-10:30, 11-12, 16:30-17:30; Markus 11-12, 14-14:45, 15-16
// (private), 16:30-17:30 - Vienna time, working hours 08-18.
check('common gaps of an hour inside working hours', $found === [
    '2026-12-16T07:00:00Z/2026-12-16T08:30:00Z',
    '2026-12-16T11:00:00Z/2026-12-16T13:00:00Z',
], $found);
check('a gap shorter than the length asked for is left out', !in_array('2026-12-16T13:45:00Z/2026-12-16T14:00:00Z', $found, true));

$private30 = CalendarAvailability::freeSlots([MARKUS], 30, '2026-12-16', '2026-12-17', $hours, $before);
check('a private appointment blocks its time without being shown', !array_filter($private30, static function (array $s): bool {
    return $s['start'] < '2026-12-16T15:00:00Z' && $s['end'] > '2026-12-16T14:00:00Z';
}), $private30);

$xmas = CalendarAvailability::freeSlots([LIVIO], 30, '2026-12-24', '2026-12-25', $hours, $before);
check('an all-day appointment blocks the whole day', $xmas === [], $xmas);

$vivianFree = CalendarAvailability::freeSlots([VIVIAN], 60, '2026-12-16', '2026-12-17', $hours, $before);
check('time marked as free in the calendar app stays free', (bool) array_filter($vivianFree, static function (array $s): bool {
    return $s['start'] <= '2026-12-16T11:00:00Z' && $s['end'] >= '2026-12-16T12:00:00Z';
}), $vivianFree);

$weekend = CalendarAvailability::freeSlots([LIVIO], 60, '2026-12-19', '2026-12-21', $hours, $before);
check('no slots outside working days', $weekend === [], $weekend);

// =============================================================================
// Settings
// =============================================================================

section('Settings');
$markusPrivate = sourceId($private['markus']);
try {
    CalendarSettings::updateSource($markusPrivate, ['enabled' => false], viewer(LIVIO, false));
    check('only an admin may switch a calendar off', false);
} catch (DomainException $e) {
    check('only an admin may switch a calendar off', true);
}
try {
    CalendarSettings::updateSource(sourceId($work['markus']), ['visibility' => 'busy'], viewer(LIVIO, false));
    check('nobody else may change how your calendar shows', false);
} catch (DomainException $e) {
    check('nobody else may change how your calendar shows', true);
}
$changed = CalendarSettings::updateSource(sourceId($work['markus']), ['visibility' => 'busy'], viewer(MARKUS, false));
check('the owner may change how their calendar shows', $changed['visibility'] === 'busy');
CalendarSettings::updateSource(sourceId($work['markus']), ['visibility' => 'details'], viewer(MARKUS, false));

$server->put($private['markus'], 'p.ics', ics(vevent([
    'UID:p-1', 'DTSTART;TZID=Europe/Vienna:20261218T090000', 'DTEND;TZID=Europe/Vienna:20261218T100000', 'SUMMARY:Zahnarzt',
])));
(new CalendarSync($server))->run();
check('private calendar synced', count(instances('p-1')) === 1);
CalendarSettings::updateSource($markusPrivate, ['enabled' => false], viewer(LIVIO, true));
check('a calendar switched off keeps nothing in the CRM', instances('p-1') === [] && (int) $db->query("SELECT COUNT(*) FROM calendar_events WHERE source_id = " . $markusPrivate)->fetchColumn() === 0);
(new CalendarSync($server))->run();
check('... and the sync leaves it alone', instances('p-1') === []);

try {
    CalendarSettings::setWorkingHours(['days' => [1, 2], 'start' => '18:00', 'end' => '08:00']);
    check('working hours must start before they end', false);
} catch (InvalidArgumentException $e) {
    check('working hours must start before they end', true);
}

// A calendar that is not on the server - as the local demo adds them - is
// none of the sync's business: not fetched, and not taken for withdrawn.
$db->exec("INSERT INTO calendar_sources (href, owner_email, display_name, kind, writable, visibility, enabled) VALUES ('demo:" . VIVIAN . "/work', '" . VIVIAN . "', 'Demo', 'work', 0, 'details', 1)");
$demoId = sourceId('demo:' . VIVIAN . '/work');
$db->exec("INSERT INTO calendar_events (source_id, href, etag, uid) VALUES (" . $demoId . ", 'demo:" . VIVIAN . "/work/1.ics', '1', 'demo-1')");

unset($server->calendars[$work['vivian']]);
$stats = (new CalendarSync($server))->run(true);
$vivianWork = $db->query("SELECT last_error FROM calendar_sources WHERE href = '" . $work['vivian'] . "'")->fetchColumn();
check('a calendar no longer shared loses its appointments', (int) $db->query("SELECT COUNT(*) FROM calendar_events WHERE source_id = " . sourceId($work['vivian']))->fetchColumn() === 0
    && $vivianWork === CalendarSync::NOT_SHARED, $vivianWork);
$demo = $db->query("SELECT enabled, last_error, (SELECT COUNT(*) FROM calendar_events WHERE source_id = " . $demoId . ") AS events FROM calendar_sources WHERE id = " . $demoId)->fetch();
check('a calendar the server does not hold is left alone', $stats['errors'] === 0 && (int) $demo['enabled'] === 1 && $demo['last_error'] === null && (int) $demo['events'] === 1, ['stats' => $stats, 'demo' => $demo]);

echo "\n" . ($failures === 0 ? "All {$passes} checks passed." : "{$failures} of " . ($passes + $failures) . " checks FAILED.") . "\n";
exit($failures === 0 ? 0 : 1);
