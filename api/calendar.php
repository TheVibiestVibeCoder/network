<?php
/**
 * Team Calendar API Endpoint
 *
 * The team's calendars from the mail server (docs/kalender-spec.md).
 *
 *   GET    ?from=YYYY-MM-DD&to=YYYY-MM-DD          occurrences in [from, to)
 *   POST   ?action=sync                             sync now, at most every
 *                                                   CALENDAR_OPEN_SYNC_SECONDS
 *   GET    ?action=free_slots&people=a,b&minutes=60&from=…&to=…
 *   GET    ?action=settings                         calendars, people, hours
 *   PATCH  ?action=source&id=N                      visibility (owner, admin),
 *                                                   kind / enabled (admin)
 *   PATCH  ?action=person&email=…                   name, colour, account, order (admin)
 *   PATCH  ?action=working_hours                    (admin)
 *   POST   ?action=discover                         look for new calendars (admin)
 *
 * Appointments (phase 2, includes/CalendarEvents.php):
 *
 *   GET    ?action=event&uid=…[&occurrence=…]      one appointment for the sheet
 *   POST   ?action=event                            new appointment
 *   PATCH  ?action=event&uid=…[&occurrence=…&scope=occurrence|series]
 *                                                   change it; 409 when it
 *                                                   changed meanwhile ("base")
 *   DELETE ?action=event&uid=…[&occurrence=…&scope=…&base=…]   cancel it
 *   POST   ?action=respond&uid=…                    answer an invitation
 *   POST   ?action=link / DELETE ?action=link&id=N  link a contact or project
 *   GET    ?action=linked&type=contact|project&id=N appointments of a record
 *   GET    ?action=link_targets&q=…                 contacts and projects to link
 *
 * Behind a session and the "see the team calendar" right; a CSRF token on
 * everything that changes state. What may be seen of each appointment is
 * decided in includes/CalendarView.php, before anything is sent.
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/User.php';
require_once APP_ROOT . '/includes/CalendarSync.php';
require_once APP_ROOT . '/includes/CalendarView.php';
require_once APP_ROOT . '/includes/CalendarSettings.php';
require_once APP_ROOT . '/includes/CalendarEvents.php';
require_once APP_ROOT . '/includes/CalendarLinks.php';

header('Content-Type: application/json');
Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    calendarRespond(401, ['error' => 'Unauthorized']);
}

$viewer = CalendarView::viewer();
if (!$viewer['can_view']) {
    calendarRespond(403, ['error' => 'You do not have access to the team calendar.']);
}

$method = $_SERVER['REQUEST_METHOD'];
$action = (string) ($_GET['action'] ?? '');
if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
    Auth::requireCsrfToken();
}

try {
    switch ($method . ' ' . $action) {
        case 'GET ':
        case 'GET range':
            handleRange($viewer);
            break;
        case 'POST sync':
            handleSync();
            break;
        case 'GET free_slots':
            handleFreeSlots($viewer);
            break;
        case 'GET settings':
            handleSettings($viewer);
            break;
        case 'PATCH source':
            $input = calendarInput();
            calendarRespond(200, ['success' => true, 'data' => CalendarSettings::updateSource((int) ($_GET['id'] ?? 0), $input, $viewer)]);
            break;
        case 'PATCH person':
            requireCalendarAdmin($viewer);
            $input = calendarInput();
            calendarRespond(200, ['success' => true, 'data' => CalendarSettings::updatePerson(strtolower(trim((string) ($_GET['email'] ?? ''))), $input)]);
            break;
        case 'PATCH working_hours':
            requireCalendarAdmin($viewer);
            calendarRespond(200, ['success' => true, 'data' => CalendarSettings::setWorkingHours(calendarInput())]);
            break;
        case 'POST discover':
            requireCalendarAdmin($viewer);
            handleDiscover();
            break;
        case 'GET event':
            calendarRespond(200, ['success' => true, 'data' => CalendarEvents::fromConfig()->sheet(calendarUid(), calendarOccurrence(), $viewer)]);
            break;
        case 'POST event':
        case 'PATCH event':
        case 'DELETE event':
        case 'POST respond':
            handleEventWrite($method . ' ' . $action, $viewer);
            break;
        case 'POST link':
            $input = calendarInput();
            $uid = trim((string) ($input['uid'] ?? ''));
            requireVisibleEvent($uid, $viewer);
            CalendarLinks::add($uid, (string) ($input['type'] ?? ''), (int) ($input['target_id'] ?? 0), $viewer['user_id']);
            calendarRespond(200, ['success' => true, 'data' => ['links' => CalendarLinks::forEvent($uid)]]);
            break;
        case 'DELETE link':
            $uid = CalendarLinks::uidOf((int) ($_GET['id'] ?? 0));
            if ($uid === null) {
                calendarRespond(404, ['error' => 'That link does not exist (any more).']);
            }
            requireVisibleEvent($uid, $viewer);
            CalendarLinks::remove((int) $_GET['id']);
            calendarRespond(200, ['success' => true, 'data' => ['links' => CalendarLinks::forEvent($uid)]]);
            break;
        case 'GET linked':
            calendarRespond(200, ['success' => true, 'data' => CalendarLinks::appointments((string) ($_GET['type'] ?? ''), (int) ($_GET['id'] ?? 0), $viewer)]);
            break;
        case 'GET link_targets':
            calendarRespond(200, ['success' => true, 'data' => CalendarLinks::targets(mb_substr((string) ($_GET['q'] ?? ''), 0, 100))]);
            break;
        default:
            calendarRespond(405, ['error' => 'Method not allowed']);
    }
} catch (CalDavException $e) {
    // The mail server said no, or could not be reached: nothing was saved.
    error_log('Calendar API: calendar server: ' . mb_substr($e->getMessage(), 0, 200));
    calendarRespond(502, ['error' => 'The mail server did not take the change (' . calendarServerReason($e) . '). Nothing was saved; try again in a moment.']);
} catch (InvalidArgumentException $e) {
    calendarRespond(422, ['error' => $e->getMessage()]);
} catch (DomainException $e) {
    calendarRespond(403, ['error' => $e->getMessage()]);
} catch (OutOfBoundsException $e) {
    calendarRespond(404, ['error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('Calendar API error: ' . get_class($e) . ': ' . mb_substr($e->getMessage(), 0, 200));
    calendarRespond(500, ['error' => 'An internal error occurred']);
}

// =============================================================================

function handleRange(array $viewer): void
{
    [$from, $to] = calendarDates(62);
    calendarRespond(200, [
        'success' => true,
        'data' => [
            'configured' => calendarConfigured(),
            'timezone'   => CALENDAR_TIMEZONE,
            'people'     => CalendarView::people($viewer),
            'items'      => CalendarView::range($from, $to, $viewer),
            'sync'       => calendarSyncState(),
            'me'         => [
                'is_admin' => $viewer['is_admin'],
                'can_edit' => $viewer['can_edit'],
                'emails'   => $viewer['emails'],
                // Owners may set how their calendars show; admins everything.
                'can_configure' => $viewer['is_admin'] || count(CalendarSettings::sources($viewer)) > 0,
                // Where a new appointment can go (the sheet's calendar choice).
                'calendars' => $viewer['can_edit'] ? CalendarEvents::fromConfig()->writableCalendars($viewer) : [],
            ],
            'window' => [
                'from' => (new DateTimeImmutable('today', new DateTimeZone(CALENDAR_TIMEZONE)))->modify('-' . CALENDAR_RETENTION_MONTHS . ' months')->format('Y-m-d'),
                'to'   => (new DateTimeImmutable('today', new DateTimeZone(CALENDAR_TIMEZONE)))->modify('+' . CALENDAR_FUTURE_MONTHS . ' months')->format('Y-m-d'),
            ],
            'working_hours' => CalendarSettings::workingHours(),
        ],
    ]);
}

/** Opening the calendar syncs too - unless that happened moments ago. */
function handleSync(): void
{
    if (!calendarConfigured()) {
        calendarRespond(200, ['success' => true, 'data' => ['ran' => false, 'changed' => 0] + calendarSyncState()]);
    }
    $last = CalendarSync::lastSyncAt();
    if ($last !== null && strtotime($last . ' UTC') > time() - CALENDAR_OPEN_SYNC_SECONDS) {
        calendarRespond(200, ['success' => true, 'data' => ['ran' => false, 'changed' => 0] + calendarSyncState()]);
    }
    // The sync talks to the mail server; do not let a slow one hold the
    // session lock for everyone else's requests meanwhile.
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    $stats = CalendarSync::runLocked();
    calendarRespond(200, ['success' => true, 'data' => [
        'ran'     => $stats !== null,
        'changed' => $stats === null ? 0 : $stats['changed'] + $stats['removed'],
    ] + calendarSyncState()]);
}

function handleDiscover(): void
{
    if (!calendarConfigured()) {
        calendarRespond(422, ['error' => 'The calendar account is not configured in .env.']);
    }
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    $stats = CalendarSync::runLocked(true);
    calendarRespond(200, ['success' => true, 'data' => ['ran' => $stats !== null, 'discovered' => $stats['discovered'] ?? 0] + calendarSyncState()]);
}

function handleFreeSlots(array $viewer): void
{
    [$from, $to] = calendarDates(CalendarAvailability::MAX_DAYS);
    $minutes = (int) ($_GET['minutes'] ?? 60);
    if ($minutes < 15 || $minutes > 480) {
        calendarRespond(422, ['error' => 'The length must be between 15 minutes and 8 hours.']);
    }
    $known = array_column(CalendarView::people($viewer), 'email');
    $emails = array_values(array_intersect($known, array_map('strtolower', array_map('trim', explode(',', (string) ($_GET['people'] ?? ''))))));
    if (!$emails) {
        calendarRespond(422, ['error' => 'Choose at least one person.']);
    }
    calendarRespond(200, ['success' => true, 'data' => [
        'people' => $emails,
        'slots'  => CalendarAvailability::freeSlots($emails, $minutes, $from, $to, CalendarSettings::workingHours()),
    ]]);
}

function handleSettings(array $viewer): void
{
    $data = [
        'sources'       => CalendarSettings::sources($viewer),
        'working_hours' => CalendarSettings::workingHours(),
        'is_admin'      => $viewer['is_admin'],
        'sync'          => calendarSyncState(),
    ];
    if ($viewer['is_admin']) {
        $data['people'] = CalendarSettings::people();
        $data['accounts'] = CalendarSettings::accounts();
        $data['configured'] = calendarConfigured();
    }
    calendarRespond(200, ['success' => true, 'data' => $data]);
}

// =============================================================================

/** @return array{0: string, 1: string} Local dates [from, to), validated. */
function calendarDates(int $maxDays): array
{
    $zone = new DateTimeZone(CALENDAR_TIMEZONE);
    $from = DateTimeImmutable::createFromFormat('!Y-m-d', (string) ($_GET['from'] ?? ''), $zone);
    $to = DateTimeImmutable::createFromFormat('!Y-m-d', (string) ($_GET['to'] ?? ''), $zone);
    if ($from === false || $to === false || $to <= $from) {
        calendarRespond(422, ['error' => 'from and to must be dates (YYYY-MM-DD), to after from.']);
    }
    if ($from->diff($to)->days > $maxDays) {
        calendarRespond(422, ['error' => 'At most ' . $maxDays . ' days at once.']);
    }
    return [$from->format('Y-m-d'), $to->format('Y-m-d')];
}

function calendarSyncState(): array
{
    $last = CalendarSync::lastSyncAt();
    return [
        'last_sync_at' => $last !== null ? gmdate('Y-m-d\TH:i:s\Z', (int) strtotime($last . ' UTC')) : null,
        'error'        => CalendarSync::lastError(),
    ];
}

function requireCalendarAdmin(array $viewer): void
{
    if (!$viewer['is_admin']) {
        calendarRespond(403, ['error' => 'Administrator access required']);
    }
}

function calendarInput(): array
{
    $input = Auth::getJsonInput();
    if (!is_array($input)) {
        calendarRespond(400, ['error' => 'Invalid request body.']);
    }
    return $input;
}

function calendarRespond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// =============================================================================
// Appointments
// =============================================================================

/**
 * Create, change, cancel or answer. These talk to the mail server, so the
 * session is released first and other requests do not wait for it.
 */
function handleEventWrite(string $route, array $viewer): void
{
    $input = $route === 'DELETE event' ? [] : calendarInput();
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    $events = CalendarEvents::fromConfig();
    $uid = $route === 'POST event' ? '' : calendarUid();
    $occurrence = calendarOccurrence();
    try {
        switch ($route) {
            case 'POST event':
                calendarRespond(201, ['success' => true, 'data' => $events->create($input, $viewer)]);
                break;
            case 'PATCH event':
                $scope = ($_GET['scope'] ?? 'series') === 'occurrence' ? 'occurrence' : 'series';
                calendarRespond(200, ['success' => true, 'data' => $events->update($uid, $occurrence, $scope, $input, $viewer)]);
                break;
            case 'DELETE event':
                $scope = ($_GET['scope'] ?? 'series') === 'occurrence' ? 'occurrence' : 'series';
                $base = isset($_GET['base']) ? (string) $_GET['base'] : null;
                calendarRespond(200, ['success' => true, 'data' => $events->cancel($uid, $occurrence, $scope, $base, $viewer)]);
                break;
            case 'POST respond':
                calendarRespond(200, ['success' => true, 'data' => $events->respond($uid, (string) ($input['answer'] ?? ''), $viewer)]);
                break;
        }
    } catch (CalendarConflict $e) {
        // Nothing was written. The person gets the appointment as it is now.
        $current = null;
        if ($e->kind === 'changed') {
            try {
                $current = $events->sheet($uid, $occurrence, $viewer);
            } catch (Throwable $ignored) {
                $current = null;
            }
        }
        calendarRespond(409, ['error' => $e->getMessage(), 'conflict' => $e->kind, 'current' => $current]);
    }
}

function requireVisibleEvent(string $uid, array $viewer): void
{
    if ($uid === '' || !CalendarEvents::fromConfig()->visible($uid, $viewer)) {
        calendarRespond(404, ['error' => 'This appointment is not in the calendar (any more).']);
    }
}

function calendarUid(): string
{
    $uid = trim((string) ($_GET['uid'] ?? ''));
    if ($uid === '' || strlen($uid) > 512) {
        calendarRespond(422, ['error' => 'Which appointment is missing.']);
    }
    return $uid;
}

/** An occurrence as the cache names it: "Y-m-d H:i:s" (UTC) or "Y-m-d". */
function calendarOccurrence(): ?string
{
    $occurrence = trim((string) ($_GET['occurrence'] ?? ''));
    if ($occurrence === '') {
        return null;
    }
    if (!preg_match('/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/', $occurrence)) {
        calendarRespond(422, ['error' => 'That is not an occurrence of this appointment.']);
    }
    return $occurrence;
}

/** The HTTP status in a CalDavException, or "not reachable". */
function calendarServerReason(CalDavException $e): string
{
    return preg_match('/HTTP (\d{3})/', $e->getMessage(), $m) ? 'HTTP ' . $m[1] : 'not reachable';
}
