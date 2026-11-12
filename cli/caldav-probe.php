<?php
/**
 * Team calendar, Phase 0: feasibility probe against the real servers
 *
 * docs/kalender-spec.md, section 7, lists six checks to run against the mail
 * server before any calendar code is written. This script runs them from a
 * shell, as the shared account configured in .env, and prints what it finds:
 *
 *     php cli/caldav-probe.php help
 *
 * Privacy: for the team's real calendars it reports counts, privileges,
 * tokens and capabilities only - never a title, a time or a participant. The
 * only appointments whose contents it prints are the ones it writes itself.
 * Each of those is recorded in data/caldav-probe.json, and "cleanup" deletes
 * all of them again.
 *
 * It writes to a calendar only on the explicit t2/t3/t4/c0 commands, only into
 * work calendars (each person's default collection "calendar"), and only
 * appointments titled "CRM-Test ...". Mail goes out only on t5:send/t6:send.
 *
 * The password is read from .env and handed to curl and the mail sockets. It
 * is never printed; the SMTP transcript masks the AUTH line.
 *
 * Deliberately free of dependencies (curl, DOM, sockets): it answers what the
 * server can do. The calendar code itself will use proper iCalendar libraries,
 * as the spec asks.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

define('APP_ROOT', dirname(__DIR__));
require_once APP_ROOT . '/config/config.php';

define('PROBE_TZ', 'Europe/Vienna');
define('PROBE_STATE_FILE', DATA_DIR . '/caldav-probe.json');
define('PROBE_PLUS_TAG', 'p0test');
define('PROBE_ORGANIZER', 'livio@disinfoconsulting.eu');

/** The team, and the names that go into CN on the test appointments. */
const PROBE_TEAM = [
    'livio@disinfoconsulting.eu'  => 'Livio Zalozieckyj',
    'markus@disinfoconsulting.eu' => 'Markus Schwinghammer',
    'vivian@disinfoconsulting.eu' => 'Vivian Lösch',
];

/** Livio's paths from the spec's project data; the others are what "discover" is for. */
const PROBE_KNOWN_CALENDARS = [
    'livio@disinfoconsulting.eu' => [
        '/calendars/livio@disinfoconsulting.eu/calendar/',
        '/calendars/livio@disinfoconsulting.eu/calendar-f410890c-1fbe-4496-be7d-54da947cd005/',
    ],
];

const NS = [
    'd'    => 'DAV:',
    'c'    => 'urn:ietf:params:xml:ns:caldav',
    'cs'   => 'http://calendarserver.org/ns/',
    'ical' => 'http://apple.com/ns/ical/',
];

const COLLECTION_PROPS = [
    'd:resourcetype', 'd:displayname', 'd:owner', 'd:current-user-privilege-set',
    'd:supported-report-set', 'd:sync-token', 'cs:getctag',
    'c:supported-calendar-component-set',
];

/** Europe/Vienna under the EU rules in force since 1996. */
const VTIMEZONE_VIENNA = [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Vienna',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
];

final class ProbeFailure extends RuntimeException
{
}

// =============================================================================
// Entry point
// =============================================================================

$opts = parseOptions(array_slice($argv, 1));
$command = $opts['_'][0] ?? 'help';

try {
    switch ($command) {
        case 'help':
            printHelp();
            break;
        case 'ics:sample':
            cmdIcsSample();
            break;
        case 'connectivity':
            cmdConnectivity();
            break;
        case 'status':
            cmdStatus(loadState());
            break;
        default:
            $state = loadState();
            runCommand($command, $state, $opts);
    }
} catch (ProbeFailure $e) {
    fwrite(STDERR, PHP_EOL . 'Abbruch: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}

function runCommand(string $command, array &$state, array $opts): void
{
    requireAccount(true);
    $dav = new Dav(CALDAV_BASE_URL, CALENDAR_ACCOUNT, CALENDAR_ACCOUNT_PASSWORD);

    switch ($command) {
        case 'discover':
            cmdDiscover($dav, $state);
            break;
        case 't2:create':
            cmdT2Create($dav, $state, $opts);
            break;
        case 't2:update':
            cmdT2Update($dav, $state);
            break;
        case 't2:delete':
            cmdT2Delete($dav, $state);
            break;
        case 'c0:create':
            cmdC0Create($dav, $state, $opts);
            break;
        case 't3:create':
            cmdT3Create($dav, $state, $opts);
            break;
        case 't3:status':
            cmdShow($dav, $state, ['t3', 't3copy']);
            break;
        case 'show':
            cmdShow($dav, $state, array_slice($opts['_'], 1));
            break;
        case 't4:create':
            cmdT4Create($dav, $state, $opts);
            break;
        case 't5:send':
            cmdT5Send($state, $opts);
            break;
        case 't6:send':
            cmdT6Send($state);
            break;
        case 'mailcheck':
            cmdMailcheck($state, isset($opts['all']));
            break;
        case 'cleanup':
            cmdCleanup($dav, $state);
            break;
        default:
            throw new ProbeFailure('Unbekannter Befehl "' . $command . '". Übersicht: php cli/caldav-probe.php help');
    }

    saveState($state);
}

function printHelp(): void
{
    $lines = [
        'Teamkalender, Phase 0: Machbarkeitstests gegen den echten Server.',
        'Spezifikation: docs/kalender-spec.md, Abschnitt 7.',
        '',
        'Aufruf:  php cli/caldav-probe.php <befehl> [optionen]',
        '',
        'Ohne Passwort:',
        '  connectivity                 Erreichbarkeit von CalDAV, SMTP und IMAP',
        '  ics:sample                   Zeigt einen Testtermin, wie er geschrieben würde',
        '  status                       Angelegte Testtermine und Tokens',
        '  show [KEY ...]               (mit Passwort) Stand der Testtermine auf dem Server,',
        '                               Vergleich mit dem Geschriebenen, z. B. show c0 t4',
        '',
        'Mit CALENDAR_ACCOUNT_PASSWORD in .env, in dieser Reihenfolge:',
        '  discover                     T1  Kalender finden; Rechte, sync-collection, CTag',
        '  t6:send                      T6  Mail an kalender+' . PROBE_PLUS_TAG . '@ (Plus-Adressierung)',
        '  mailcheck [--all]                Postfach von kalender@ nach den Test-Mails durchsuchen',
        '                                   (--all: jede Mail seit Teststart auflisten)',
        '  t2:create                    T2  Termin in Livios Arbeitskalender anlegen, Konfliktproben',
        '  t2:update                    T2  Termin verschieben und umbenennen (If-Match)',
        '  t2:delete                    T2  Termin löschen (If-Match), Löschung im Sync prüfen',
        '  c0:create                        Kontrolle: Teilnehmer OHNE SCHEDULE-AGENT',
        '  t3:create --colleague=ADR    T3  interner Teilnehmer + Kopie im Arbeitskalender von ADR',
        '  t3:status                    T3  ETags und Zusage-Status von Original und Kopie',
        '  t4:create --external=ADR [--agent=all|attendees|none]',
        '                               T4  externer Teilnehmer ADR; SCHEDULE-AGENT=CLIENT überall (all,',
        '                                   Standard, 10:00), nur bei Teilnehmern (13:00) oder gar nicht (12:00)',
        '  t5:send --to=ADR[,ADR] [--envelope=account|organizer]',
        '                               T5  Testmail im Namen von livio@ über das SMTP-Konto von kalender@',
        '  cleanup                          Alle Testtermine wieder löschen',
        '',
        'Optionen:',
        '  --date=JJJJ-MM-TT            Tag der Testtermine (Standard: morgen)',
        '',
        'Testtermine heißen „CRM-Test …“ und liegen am Testtag zwischen 07:00 und 13:30.',
        'Von echten Terminen gibt das Skript nur Anzahlen aus, nie Inhalte.',
    ];
    foreach ($lines as $line) {
        out($line);
    }
}

// =============================================================================
// T1: discovery
// =============================================================================

function cmdDiscover(Dav $dav, array &$state): void
{
    heading('T1 · Discovery als ' . CALENDAR_ACCOUNT);

    $options = $dav->request('OPTIONS', '/');
    if ($options['status'] === 401) {
        throw new ProbeFailure('Der Server lehnt die Anmeldung ab (401). Stimmt CALENDAR_ACCOUNT_PASSWORD in .env?');
    }
    result('OPTIONS /', statusText($options));
    result('DAV-Klassen', $options['headers']['dav'] ?? '–');
    result('Allow', $options['headers']['allow'] ?? '–');

    // Principal and calendar home of the shared account.
    $root = propfind($dav, '/', '0', ['d:current-user-principal', 'd:principal-URL', 'd:resourcetype']);
    $rootEntry = firstResponse($root);
    $principal = $rootEntry !== null ? (propHrefs($rootEntry, 'd:current-user-principal')[0] ?? null) : null;
    result('PROPFIND / (Depth 0)', statusText($root));
    result('current-user-principal', $principal ?? '– (nicht geliefert)');
    if ($principal === null) {
        $principal = '/principals/' . CALENDAR_ACCOUNT . '/';
        result('→ versuche', $principal);
    }

    $principalProps = [
        'calendar-home-set'         => 'c:calendar-home-set',
        'calendar-user-address-set' => 'c:calendar-user-address-set',
        'schedule-inbox-URL'        => 'c:schedule-inbox-URL',
        'schedule-outbox-URL'       => 'c:schedule-outbox-URL',
        'calendar-proxy-read-for'   => 'cs:calendar-proxy-read-for',
        'calendar-proxy-write-for'  => 'cs:calendar-proxy-write-for',
        'group-membership'          => 'd:group-membership',
    ];
    $p = propfind($dav, $principal, '0', array_merge(['d:displayname'], array_values($principalProps)));
    $pe = firstResponse($p);
    result('PROPFIND Principal', statusText($p));
    foreach ($principalProps as $label => $qname) {
        $values = $pe !== null ? propHrefs($pe, $qname) : [];
        result($label, $values ? implode(', ', $values) : '–');
    }
    $home = $pe !== null ? (propHrefs($pe, 'c:calendar-home-set')[0] ?? null) : null;
    if ($home === null) {
        $home = '/calendars/' . CALENDAR_ACCOUNT . '/';
        result('→ versuche', $home);
    }

    // Do the calendars the team shared show up in the shared account's home?
    heading('Calendar-Home von ' . CALENDAR_ACCOUNT . ': tauchen die Freigaben hier auf?');
    $own = listCollections($dav, $home);
    result('PROPFIND ' . collectionPath($home) . ' (Depth 1)', statusText($own['response']) . ', ' . count($own['items']) . ' Kalender');
    $foreignInHome = 0;
    foreach ($own['items'] as $collection) {
        printCollection($collection);
        $ownedBySelf = $collection['owner'] === null || samePath($collection['owner'], $principal);
        if (!$ownedBySelf || array_intersect($collection['types'], ['shared', 'shared-owner'])) {
            $foreignInHome++;
        }
    }

    // The owners' own URLs.
    $calendars = [];
    foreach (PROBE_TEAM as $email => $name) {
        heading('Kalender von ' . $name . ' (' . $email . ')');
        $teamHome = '/calendars/' . $email . '/';
        $list = listCollections($dav, $teamHome);
        result('PROPFIND ' . $teamHome . ' (Depth 1)', statusText($list['response']) . ', ' . count($list['items']) . ' Kalender');
        if (!$list['items']) {
            foreach ($list['diagnosis'] ?: ['keine Antwort-Einträge'] as $line) {
                out('      ' . $line);
            }
        }
        $found = $list['items'];

        $known = PROBE_KNOWN_CALENDARS;
        foreach (array_unique(array_merge($known[$email] ?? [], [workCalendar($email)])) as $path) {
            if (isset($found[collectionPath($path)])) {
                continue;
            }
            $single = listCollections($dav, $path, '0');
            result('PROPFIND ' . collectionPath($path) . ' (Depth 0)', statusText($single['response']));
            if (!$single['items']) {
                foreach ($single['diagnosis'] ?: ['keine Antwort-Einträge'] as $line) {
                    out('      ' . $line);
                }
            }
            $found += $single['items'];
        }

        foreach ($found as $href => $collection) {
            printCollection($collection);
            $calendars[$href] = $collection + ['owner_email' => $email];
        }
    }

    // Change detection on each calendar - counts only.
    heading('Synchronisation je Kalender (nur Anzahlen, keine Inhalte)');
    $today = new DateTimeImmutable('today', new DateTimeZone('UTC'));
    $from = $today->modify('-3 months');
    $to = $today->modify('+12 months');
    $syncOk = 0;
    $ctagOk = 0;
    foreach ($calendars as $href => $collection) {
        out('  ' . $href);
        $first = syncCollection($dav, $href, '');
        if ($first['ok']) {
            $second = syncCollection($dav, $href, $first['token']);
            result('    sync-collection, Erstabruf', count($first['changed']) . ' Objekte, Token '
                . ($first['token'] !== '' ? 'erhalten' : 'FEHLT') . ' (Depth ' . $first['depth'] . ')');
            result('    sync-collection, mit Token', $second['ok']
                ? count($second['changed']) . ' geändert, ' . count($second['removed']) . ' gelöscht'
                : 'Fehler: ' . $second['error']);
            if ($first['token'] !== '' && $second['ok']) {
                $syncOk++;
            }
        } else {
            result('    sync-collection', 'nicht unterstützt: ' . $first['error']);
        }

        $query = calendarQueryCount($dav, $href, $from, $to);
        result('    calendar-query −3/+12 Monate', $query['ok'] ? $query['count'] . ' Termine' : 'Fehler: ' . $query['error']);
        $listing = etagListing($dav, $href);
        result('    PROPFIND Depth 1 (alle ETags)', $listing['ok'] ? count($listing['etags']) . ' Objekte mit ETag' : 'Fehler: ' . $listing['error']);
        result('    CTag', $collection['ctag'] !== null ? 'ja' : 'nein');
        if ($collection['ctag'] !== null) {
            $ctagOk++;
        }

        // Batch download, which the sync needs - on Livio's calendar only, sizes only.
        if (samePath($href, workCalendar(PROBE_ORGANIZER)) && $listing['ok'] && $listing['etags']) {
            $multi = multigetSizes($dav, $href, array_slice(array_keys($listing['etags']), 0, 3));
            result('    calendar-multiget (bis 3 Objekte)', $multi['ok']
                ? count($multi['sizes']) . ' mit calendar-data (' . implode(', ', array_map(static function (int $s): string {
                    return $s . ' B';
                }, $multi['sizes'])) . ')'
                : 'Fehler: ' . $multi['error']);
        }

        $state['calendars'][$href] = [
            'owner_email' => $collection['owner_email'],
            'displayname' => $collection['displayname'],
            'writable'    => $collection['writable'],
            'privileges'  => $collection['privileges'],
            'ctag'        => $collection['ctag'] !== null,
            'sync'        => $first['ok'],
        ];
    }

    heading('Ergebnis T1');
    result('Freigaben in der Home von kalender@', $foreignInHome > 0 ? 'ja, ' . $foreignInHome : 'nein → direkte URLs der Eigentümer');
    result('Kalender erreichbar', (string) count($calendars));
    result('sync-collection (RFC 6578)', $syncOk . ' von ' . count($calendars) . ' Kalendern');
    result('CTag', $ctagOk . ' von ' . count($calendars) . ' Kalendern');
    foreach (PROBE_TEAM as $email => $name) {
        $work = $calendars[workCalendar($email)] ?? null;
        $others = [];
        foreach ($calendars as $href => $collection) {
            if ($collection['owner_email'] === $email && !samePath($href, workCalendar($email))) {
                $others[] = $href . ' („' . ($collection['displayname'] ?? '') . '“, ' . ($collection['writable'] ? 'schreibbar' : 'nur lesen') . ')';
            }
        }
        result($name, 'Arbeit: ' . ($work !== null
            ? workCalendar($email) . ' („' . ($work['displayname'] ?? '') . '“, ' . ($work['writable'] ? 'schreibbar' : 'nur lesen') . ')'
            : '–'));
        result('', 'weitere: ' . ($others ? implode('; ', $others) : '–'));
    }
}

// =============================================================================
// T2: write, change, delete in Livio's work calendar
// =============================================================================

function cmdT2Create(Dav $dav, array &$state, array $opts): void
{
    heading('T2 · Termin in Livios Arbeitskalender anlegen');
    refuseIfActive($state, ['t2']);
    $calendar = workCalendar(PROBE_ORGANIZER);
    requireWritable($dav, $calendar);

    $before = collectionState($dav, $calendar);
    $baseline = changeBaseline($dav, $calendar);
    $event = testEvent('T2', 'Prüftermin, angelegt', testDay($opts)->setTime(7, 0), 30);
    if (!writeNewEvent($dav, $state, 't2', $calendar, $event, 'T2')) {
        return;
    }
    $object = $state['objects']['t2'];

    // Both conditional writes must be refused and change nothing.
    $ics = buildEvent($event);
    $again = $dav->request('PUT', $object['href'], ['Content-Type: text/calendar; charset=utf-8', 'If-None-Match: *'], $ics);
    result('PUT erneut mit If-None-Match: *', statusText($again) . '  ' . verdict($again['status'] === 412, 'erwartet 412'));
    $stale = $dav->request('PUT', $object['href'], ['Content-Type: text/calendar; charset=utf-8', 'If-Match: "crm-probe-veraltet"'], $ics);
    result('PUT mit falschem If-Match', statusText($stale) . '  ' . verdict($stale['status'] === 412, 'erwartet 412'));
    $object['etag'] = currentEtag($dav, $object['href']) ?? $object['etag'];

    reportCtag($before, collectionState($dav, $calendar));
    $object['baseline'] = reportDelta($dav, $calendar, $baseline, $object['href'], 'neu');
    $state['objects']['t2'] = $object;
    saveState($state);

    out();
    out('→ Livio: Am iPhone (Kalender ggf. aktualisieren) sollte jetzt stehen:');
    out('  ' . eventLine($event));
}

function cmdT2Update(Dav $dav, array &$state): void
{
    heading('T2 · Termin verschieben und umbenennen (If-Match)');
    $object = requireObject($state, 't2', 'Zuerst t2:create.');
    $baseline = $object['baseline'] ?? null;
    $before = collectionState($dav, $object['calendar']);

    $current = currentEtag($dav, $object['href']);
    result('ETag gespeichert / aktuell', ($object['etag'] ?? '–') . ' / ' . ($current ?? '–'));
    $object['etag'] = $object['etag'] ?? $current;

    $event = $object['event'];
    $event['title'] = 'Prüftermin, geändert';
    $event['summary'] = 'CRM-Test T2 · ' . $event['title'] . ' [' . $event['token'] . ']';
    $event['start'] = (new DateTimeImmutable($event['start']))->modify('+60 minutes')->format(DATE_ATOM);
    $event['end'] = (new DateTimeImmutable($event['end']))->modify('+60 minutes')->format(DATE_ATOM);
    $event['sequence']++;
    $ics = buildEvent($event);

    $put = $dav->request('PUT', $object['href'], ['Content-Type: text/calendar; charset=utf-8', 'If-Match: ' . $object['etag']], $ics);
    result('PUT mit If-Match', statusText($put) . ', ETag in der Antwort: ' . ($put['headers']['etag'] ?? 'keins'));
    if ($put['status'] === 412) {
        out('  Konflikt: Der Termin wurde seit dem Anlegen verändert. Nichts überschrieben.');
        return;
    }
    if ($put['status'] < 200 || $put['status'] >= 300) {
        result('  Server meldet', errorSummary($put));
        return;
    }

    $get = $dav->request('GET', $object['href']);
    if ($get['status'] === 200) {
        printStoredDiff($ics, $get['body']);
    }
    $object['etag'] = $put['headers']['etag'] ?? $get['headers']['etag'] ?? currentEtag($dav, $object['href']) ?? $object['etag'];
    $object['event'] = $event;
    reportCtag($before, collectionState($dav, $object['calendar']));
    $object['baseline'] = reportDelta($dav, $object['calendar'], $baseline, $object['href'], 'geändert');
    $state['objects']['t2'] = $object;
    saveState($state);

    out();
    out('→ Livio: Am iPhone sollte der Termin jetzt so aussehen:');
    out('  ' . eventLine($event));
}

function cmdT2Delete(Dav $dav, array &$state): void
{
    heading('T2 · Termin löschen (If-Match)');
    $object = requireObject($state, 't2', 'Zuerst t2:create.');
    $baseline = $object['baseline'] ?? null;
    $before = collectionState($dav, $object['calendar']);

    $stale = $dav->request('DELETE', $object['href'], ['If-Match: "crm-probe-veraltet"']);
    result('DELETE mit falschem If-Match', statusText($stale) . '  ' . verdict($stale['status'] === 412, 'erwartet 412'));
    if ($stale['status'] >= 200 && $stale['status'] < 300) {
        out('  Achtung: Der Server hat trotz falschem ETag gelöscht.');
    } else {
        $delete = $dav->request('DELETE', $object['href'], ['If-Match: ' . ($object['etag'] ?? currentEtag($dav, $object['href']) ?? '*')]);
        result('DELETE mit gespeichertem ETag', statusText($delete));
        if ($delete['status'] === 412) {
            out('  Konflikt: Der Termin wurde zwischenzeitlich verändert. Lösche mit dem aktuellen ETag.');
            $etag = currentEtag($dav, $object['href']);
            if ($etag !== null) {
                result('DELETE mit aktuellem ETag', statusText($dav->request('DELETE', $object['href'], ['If-Match: ' . $etag])));
            }
        }
    }

    $get = $dav->request('GET', $object['href']);
    result('GET danach', statusText($get) . '  ' . verdict($get['status'] === 404, 'erwartet 404'));
    reportCtag($before, collectionState($dav, $object['calendar']));
    reportDelta($dav, $object['calendar'], $baseline, $object['href'], 'gelöscht');

    if ($get['status'] === 404) {
        $state['objects']['t2']['deleted'] = true;
        saveState($state);
        out();
        out('→ Livio: Der Termin sollte jetzt am iPhone verschwunden sein.');
    }
}

// =============================================================================
// C0, T3, T4: attendees and the server's own invitation mails
// =============================================================================

function cmdC0Create(Dav $dav, array &$state, array $opts): void
{
    heading('Kontrolle C0 · Teilnehmer OHNE SCHEDULE-AGENT');
    out('  Verschickt der Server überhaupt Einladungen, wenn ' . CALENDAR_ACCOUNT . ' einen Termin mit');
    out('  Teilnehmern in Livios Kalender schreibt? Ohne diese Kontrolle sagt ein „keine Mail“ in T3/T4 nichts.');
    refuseIfActive($state, ['c0']);
    $probe = probeAddress($state);
    $calendar = workCalendar(PROBE_ORGANIZER);
    requireWritable($dav, $calendar);

    $event = testEvent('C0', 'Kontrolle ohne SCHEDULE-AGENT', testDay($opts)->setTime(11, 0), 30,
        person(PROBE_ORGANIZER, 'ACCEPTED', false, null),
        [person(PROBE_ORGANIZER, 'ACCEPTED', false, null), probePerson($probe, null)]
    );
    if (writeNewEvent($dav, $state, 'c0', $calendar, $event, 'C0')) {
        out();
        out('→ Teilnehmer: ' . $probe . ' (landet im Postfach von ' . CALENDAR_ACCOUNT . ')');
        out('→ In 1–2 Minuten: php cli/caldav-probe.php mailcheck');
    }
}

function cmdT3Create(Dav $dav, array &$state, array $opts): void
{
    heading('T3 · Interner Teilnehmer mit SCHEDULE-AGENT=CLIENT, Kopie bei der Kollegin/dem Kollegen');
    $colleague = strtolower(trim((string) ($opts['colleague'] ?? '')));
    if (!array_key_exists($colleague, PROBE_TEAM) || $colleague === PROBE_ORGANIZER) {
        throw new ProbeFailure('--colleague=markus@disinfoconsulting.eu oder --colleague=vivian@disinfoconsulting.eu angeben.');
    }
    refuseIfActive($state, ['t3', 't3copy']);
    $probe = probeAddress($state);
    $original = workCalendar(PROBE_ORGANIZER);
    $copy = workCalendar($colleague);
    requireWritable($dav, $original);
    requireWritable($dav, $copy);

    // SCHEDULE-AGENT=CLIENT on the attendees only. On ORGANIZER it makes the
    // iPhone keep its edits to itself without any error (Phase 0, T4 vs T4C) -
    // in a colleague's copy that would swallow their accept/decline.
    $event = testEvent('T3', 'Gemeinsamer Termin', testDay($opts)->setTime(9, 0), 30,
        person(PROBE_ORGANIZER, 'ACCEPTED', false, null),
        [
            person(PROBE_ORGANIZER, 'ACCEPTED', false, 'CLIENT'),
            person($colleague, 'NEEDS-ACTION', true, 'CLIENT'),
            probePerson($probe, 'CLIENT'),
        ]
    );

    if (!writeNewEvent($dav, $state, 't3', $original, $event, 'T3 Original bei ' . teamName(PROBE_ORGANIZER))) {
        return;
    }
    if (!writeNewEvent($dav, $state, 't3copy', $copy, $event, 'T3 Kopie bei ' . teamName($colleague))) {
        return;
    }
    $state['objects']['t3copy']['colleague'] = $colleague;
    $state['tokens'][$event['token']]['what'] = 'T3 Original bei ' . teamName(PROBE_ORGANIZER) . ' + Kopie bei ' . teamName($colleague);
    saveState($state);

    out();
    out('→ ' . teamName($colleague) . ': Steht der Termin am iPhone? Kam eine Mail vom Server?');
    out('  ' . eventLine($event));
    out('→ Livio: Kam bei dir eine Mail zu diesem Termin an?');
    out('→ In 1–2 Minuten: php cli/caldav-probe.php mailcheck');
}

/**
 * Current state of test appointments on the server, compared with what this
 * script last wrote - shows what an iPhone changed when it saved one.
 */
function cmdShow(Dav $dav, array $state, array $keys): void
{
    heading('Testtermine: aktueller Stand auf dem Server');
    if (!$keys) {
        $keys = array_keys(array_filter($state['objects'], static function (array $o): bool {
            return !$o['deleted'];
        }));
    }
    foreach ($keys as $key) {
        $object = $state['objects'][$key] ?? null;
        if ($object === null || $object['deleted']) {
            result($key, $object === null ? 'unbekannt' : 'gelöscht');
            continue;
        }
        $get = $dav->request('GET', $object['href']);
        $etag = $get['headers']['etag'] ?? null;
        out('  ' . $object['label'] . ': ' . $object['href']);
        result('    GET', statusText($get) . ', ETag ' . ($etag ?? '–')
            . ($etag !== null && $etag !== $object['etag'] ? ' (seit dem Schreiben geändert)' : ' (unverändert)'));
        if ($get['status'] !== 200) {
            continue;
        }
        // DTSTAMP and LAST-MODIFIED differ on every write; leave them out.
        $volatile = static function (array $lines): array {
            return array_values(array_filter($lines, static function (string $line): bool {
                return !preg_match('/^(DTSTAMP|LAST-MODIFIED)[;:]/i', $line);
            }));
        };
        $written = $volatile(icsLines(buildEvent($object['event'])));
        $now = $volatile(icsLines($get['body']));
        $removed = array_values(array_diff($written, $now));
        $added = array_values(array_diff($now, $written));
        if (!$removed && !$added) {
            result('    Inhalt', 'wie vom Skript geschrieben');
            continue;
        }
        result('    Inhalt', 'geändert gegenüber dem Geschriebenen:');
        foreach ($removed as $line) {
            out('      − ' . $line);
        }
        foreach ($added as $line) {
            out('      + ' . $line);
        }
    }
}

function cmdT4Create(Dav $dav, array &$state, array $opts): void
{
    // --agent picks where SCHEDULE-AGENT=CLIENT goes: everywhere (the spec's
    // proposal, T4), on the attendees only (T4C), or nowhere (T4B).
    $variants = [
        'all'       => ['key' => 't4',  'test' => 'T4',  'hour' => 10, 'organizer' => 'CLIENT', 'attendees' => 'CLIENT', 'what' => 'SCHEDULE-AGENT=CLIENT überall'],
        'none'      => ['key' => 't4b', 'test' => 'T4B', 'hour' => 12, 'organizer' => null,     'attendees' => null,     'what' => 'ohne SCHEDULE-AGENT'],
        'attendees' => ['key' => 't4c', 'test' => 'T4C', 'hour' => 13, 'organizer' => null,     'attendees' => 'CLIENT', 'what' => 'SCHEDULE-AGENT=CLIENT nur bei Teilnehmern'],
    ];
    $variant = $variants[(string) ($opts['agent'] ?? 'all')] ?? null;
    if ($variant === null) {
        throw new ProbeFailure('--agent=all, --agent=attendees oder --agent=none');
    }
    heading($variant['test'] . ' · Externer Teilnehmer, ' . $variant['what']);
    $external = strtolower(trim((string) ($opts['external'] ?? '')));
    $ownDomain = '@' . substr((string) strrchr(CALENDAR_ACCOUNT, '@'), 1);
    if (!filter_var($external, FILTER_VALIDATE_EMAIL) || substr($external, -strlen($ownDomain)) === $ownDomain) {
        throw new ProbeFailure('--external=<Adresse außerhalb von ' . ltrim($ownDomain, '@') . '> angeben, z. B. ein privates Gmail-Postfach.');
    }
    refuseIfActive($state, [$variant['key']]);
    $probe = probeAddress($state);
    $calendar = workCalendar(PROBE_ORGANIZER);
    requireWritable($dav, $calendar);

    $agent = $variant['attendees'];
    $event = testEvent($variant['test'], 'Externe Einladung', testDay($opts)->setTime($variant['hour'], 0), 30,
        person(PROBE_ORGANIZER, 'ACCEPTED', false, $variant['organizer']),
        [
            person(PROBE_ORGANIZER, 'ACCEPTED', false, $agent),
            ['email' => $external, 'name' => 'Externer Test', 'partstat' => 'NEEDS-ACTION', 'rsvp' => true, 'agent' => $agent],
            probePerson($probe, $agent),
        ]
    );
    if (writeNewEvent($dav, $state, $variant['key'], $calendar, $event, $variant['test'])) {
        out();
        out('→ Kommt an ' . $external . ' eine Mail vom Server? Erwartet: nein.');
        out('→ In 1–2 Minuten: php cli/caldav-probe.php mailcheck');
    }
}

// =============================================================================
// T5, T6: mail through the server
// =============================================================================

function cmdT5Send(array &$state, array $opts): void
{
    heading('T5 · Testmail im Namen von ' . PROBE_ORGANIZER);
    $recipients = array_values(array_filter(array_map('trim', explode(',', (string) ($opts['to'] ?? '')))));
    if (!$recipients) {
        throw new ProbeFailure('--to=adresse[,adresse] angeben, am besten ein externes Postfach (z. B. Gmail).');
    }
    foreach ($recipients as $recipient) {
        if (!filter_var($recipient, FILTER_VALIDATE_EMAIL)) {
            throw new ProbeFailure('Keine gültige Adresse: ' . $recipient);
        }
    }
    $mode = (string) ($opts['envelope'] ?? 'account');
    if (!in_array($mode, ['account', 'organizer'], true)) {
        throw new ProbeFailure('--envelope=account oder --envelope=organizer');
    }
    $envelope = $mode === 'organizer' ? PROBE_ORGANIZER : CALENDAR_ACCOUNT;
    $token = newToken($mode === 'organizer' ? 't5b' : 't5a');
    $fromName = teamName(PROBE_ORGANIZER);

    $text = "Testmail der CRM-Kalenderintegration (Phase 0, Test 5).\n\n"
        . 'From (Header):    ' . $fromName . ' <' . PROBE_ORGANIZER . ">\n"
        . 'Envelope-Sender:  ' . $envelope . "\n"
        . 'Versand über:     SMTP-Login von ' . CALENDAR_ACCOUNT . ' auf ' . CALENDAR_MAIL_HOST . ":465\n\n"
        . "Bitte die Originalnachricht öffnen (Gmail: ⋮ → „Original anzeigen“) und\n"
        . "die Ergebnisse für SPF, DKIM und DMARC ablesen.\n\n"
        . 'Token: ' . $token . "\n";
    $html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#1C3258">'
        . '<h2 style="margin:0 0 12px">CRM-Test T5 · Absenderprüfung</h2>'
        . '<pre style="font-size:13px;background:#EEEEEE;padding:12px">' . htmlspecialchars($text, ENT_QUOTES, 'UTF-8') . '</pre>'
        . '</div>';
    $subject = 'CRM-Test T5 · Absenderprüfung (Envelope ' . $envelope . ') [' . $token . ']';
    $message = buildMail(PROBE_ORGANIZER, $fromName, $recipients, $subject, $text, $html, $token);

    result('From (Header)', $fromName . ' <' . PROBE_ORGANIZER . '>');
    result('Envelope (MAIL FROM)', $envelope);
    result('SMTP-Login', CALENDAR_ACCOUNT . ' @ ' . CALENDAR_MAIL_HOST . ':465');
    result('Empfänger', implode(', ', $recipients));

    $outcome = smtpSend($envelope, $recipients, $message);
    $state['tokens'][$token] = [
        'test' => 'T5', 'what' => 'Mail mit Envelope ' . $envelope . ' an ' . implode(', ', $recipients),
        'at' => gmdate('c'), 'accepted' => $outcome['accepted'], 'queue' => $outcome['queue'],
    ];
    saveState($state);
    if ($outcome['accepted']) {
        out();
        out('→ Im Empfängerpostfach die Originalnachricht öffnen: SPF, DKIM und DMARC ablesen.');
        out('  Betreff enthält: ' . $token);
    }
}

function cmdT6Send(array &$state): void
{
    heading('T6 · Plus-Adressierung');
    $to = plusAddress(PROBE_PLUS_TAG);
    $token = newToken('t6');
    $text = "Testmail der CRM-Kalenderintegration (Phase 0, Test 6).\nAn: " . $to . "\nKann gelöscht werden.\n";
    $html = '<p style="font-family:Arial,Helvetica,sans-serif;color:#1C3258">' . nl2br(htmlspecialchars($text, ENT_QUOTES, 'UTF-8')) . '</p>';
    $message = buildMail(CALENDAR_ACCOUNT, 'CRM Kalender-Test', [$to], 'CRM-Test T6 · Plus-Adressierung [' . $token . ']', $text, $html, $token);

    result('An', $to);
    $outcome = smtpSend(CALENDAR_ACCOUNT, [$to], $message);
    $state['tokens'][$token] = [
        'test' => 'T6', 'what' => 'Mail an ' . $to, 'at' => gmdate('c'),
        'accepted' => $outcome['accepted'], 'queue' => $outcome['queue'],
    ];
    saveState($state);
    if ($outcome['accepted']) {
        out();
        out('→ In etwa 30 Sekunden: php cli/caldav-probe.php mailcheck');
    }
}

function cmdMailcheck(array &$state, bool $all = false): void
{
    heading('Postfach ' . CALENDAR_ACCOUNT . ' durchsuchen');
    if ($all) {
        // Everything since the probe started, whether it carries a token or
        // not - a server mail might not repeat the appointment's title.
        $imap = new Imap(CALENDAR_MAIL_HOST);
        $imap->login(CALENDAR_ACCOUNT, CALENDAR_ACCOUNT_PASSWORD);
        $since = (new DateTimeImmutable($state['started_at']))->format('j-M-Y');
        foreach ($imap->folders() as $folder) {
            if (!$imap->examine($folder)) {
                continue;
            }
            $uids = $imap->search('SINCE ' . $since);
            result($folder, count($uids) . ' Mail(s) seit ' . $since);
            foreach ($uids as $uid) {
                printMail($folder, $imap->summary($uid));
            }
        }
        $imap->logout();
        return;
    }
    // T2 has no participants and T5 goes to other mailboxes: nothing to find here.
    $tokens = array_filter($state['tokens'], static function (array $t): bool {
        return in_array($t['test'], ['T6', 'C0', 'T3', 'T4', 'T4B', 'T4C'], true);
    });
    if (!$tokens) {
        out('  Noch kein Test mit Mailbezug gelaufen (t6:send, c0/t3/t4:create).');
        return;
    }

    $imap = new Imap(CALENDAR_MAIL_HOST);
    $imap->login(CALENDAR_ACCOUNT, CALENDAR_ACCOUNT_PASSWORD);
    $folders = $imap->folders();
    result('Ordner', implode(', ', $folders));

    $since = (new DateTimeImmutable($state['started_at']))->modify('-1 day')->format('j-M-Y');
    foreach ($tokens as $token => $info) {
        out();
        out('  [' . $info['test'] . '] ' . $info['what'] . '  (' . $token . ')');
        $hits = 0;
        $delivered = null;
        foreach ($folders as $folder) {
            if (!$imap->examine($folder)) {
                continue;
            }
            foreach ($imap->search('SINCE ' . $since . ' TEXT ' . Imap::quote($token)) as $uid) {
                $hits++;
                $mail = $imap->summary($uid);
                printMail($folder, $mail);
                $from = headerValue($mail['headers']['from'] ?? '');
                $bounce = stripos($from, 'mailer-daemon') !== false || stripos($from, 'mail delivery') !== false;
                if ($info['test'] === 'T6' && !$bounce && $delivered === null) {
                    $delivered = $folder;
                }
            }
        }
        if ($hits === 0) {
            out('    keine Mail gefunden');
        }
        $state['tokens'][$token]['mails'] = $hits;

        switch ($info['test']) {
            case 'T6':
                $state['plus'] = ['delivered' => $delivered !== null, 'folder' => $delivered, 'checked_at' => gmdate('c')];
                result('    → Plus-Adressierung', $delivered !== null ? '✓ zugestellt, Ordner ' . $delivered : '✗ nicht (oder noch nicht) zugestellt');
                break;
            case 'C0':
                result('    → Kontrolle', $hits > 0
                    ? 'Server verschickt Einladungen auch, wenn kalender@ schreibt'
                    : 'keine Server-Mail, auch ohne SCHEDULE-AGENT');
                break;
            case 'T4B':
                result('    → ohne SCHEDULE-AGENT', $hits > 0 ? '✗ Server hat eine Mail verschickt' : '✓ keine Server-Mail');
                break;
            case 'T3':
            case 'T4':
            case 'T4C':
                result('    → SCHEDULE-AGENT=CLIENT', $hits > 0
                    ? '✗ Server hat trotzdem eine Mail verschickt'
                    : '✓ keine Server-Mail (aussagekräftig, wenn C0 eine Mail ausgelöst hat)');
                break;
        }
    }
    $imap->logout();
    saveState($state);
}

// =============================================================================
// Cleanup and status
// =============================================================================

function cmdCleanup(Dav $dav, array &$state): void
{
    heading('Aufräumen: alle Testtermine löschen');
    $any = false;
    foreach ($state['objects'] as $key => $object) {
        if ($object['deleted']) {
            continue;
        }
        $any = true;
        $get = $dav->request('GET', $object['href']);
        if ($get['status'] === 404) {
            result($object['label'], 'schon weg');
            $state['objects'][$key]['deleted'] = true;
            saveState($state);
            continue;
        }
        $etag = $get['headers']['etag'] ?? currentEtag($dav, $object['href']);
        $delete = $dav->request('DELETE', $object['href'], $etag !== null ? ['If-Match: ' . $etag] : []);
        $ok = $delete['status'] >= 200 && $delete['status'] < 300;
        result($object['label'], $ok ? statusText($delete) . ', gelöscht' : errorSummary($delete));
        if ($ok) {
            $state['objects'][$key]['deleted'] = true;
            saveState($state);
        }
    }
    if (!$any) {
        out('  Nichts zu löschen.');
    }
}

function cmdStatus(array $state): void
{
    heading('Stand der Phase-0-Tests');
    result('Zustandsdatei', PROBE_STATE_FILE);
    result('begonnen', $state['started_at']);
    $plus = $state['plus'];
    result('Plus-Adressierung', $plus === null
        ? 'noch nicht geprüft'
        : ($plus['delivered'] ? 'zugestellt (Ordner ' . $plus['folder'] . ')' : 'nicht zugestellt'));
    out();
    out('  Testtermine:');
    if (!$state['objects']) {
        out('    keine');
    }
    foreach ($state['objects'] as $key => $object) {
        out('    ' . str_pad($key, 8) . ($object['deleted'] ? 'gelöscht   ' : 'vorhanden  ') . $object['href']);
    }
    out();
    out('  Tokens:');
    if (!$state['tokens']) {
        out('    keine');
    }
    foreach ($state['tokens'] as $token => $info) {
        out('    ' . $token . '  ' . $info['test'] . '  ' . $info['what']
            . (isset($info['mails']) ? '  (' . $info['mails'] . ' Mail(s) bei kalender@)' : ''));
    }
}

function cmdIcsSample(): void
{
    $event = testEvent('T3', 'Gemeinsamer Termin', new DateTimeImmutable('tomorrow 09:00', vienna()), 30,
        person(PROBE_ORGANIZER, 'ACCEPTED', false, null),
        [
            person(PROBE_ORGANIZER, 'ACCEPTED', false, 'CLIENT'),
            person('vivian@disinfoconsulting.eu', 'NEEDS-ACTION', true, 'CLIENT'),
            probePerson('kalender+' . PROBE_PLUS_TAG . '@disinfoconsulting.eu', 'CLIENT'),
        ]
    );
    fwrite(STDOUT, buildEvent($event));
}

function cmdConnectivity(): void
{
    requireAccount(false);
    heading('Erreichbarkeit (ohne Anmeldung)');

    $dav = new Dav(CALDAV_BASE_URL, '', '');
    $options = $dav->request('OPTIONS', '/', [], null, false);
    result('CalDAV ' . CALDAV_BASE_URL, statusText($options) . ', Server: ' . ($options['headers']['server'] ?? '–')
        . ', ' . ($options['headers']['www-authenticate'] ?? 'kein WWW-Authenticate'));

    $smtp = new Smtp(CALENDAR_MAIL_HOST, 465);
    $capabilities = $smtp->ehlo('crm-probe.local');
    $smtp->quit();
    result('SMTP ' . CALENDAR_MAIL_HOST . ':465', substr($smtp->transcript[0] ?? '', 3));
    result('  EHLO', implode(' · ', array_map(static function (string $line): string {
        return substr($line, 4);
    }, array_slice($capabilities, 1))));

    $imap = new Imap(CALENDAR_MAIL_HOST);
    [, $responses] = $imap->command('CAPABILITY');
    $imap->logout();
    result('IMAP ' . CALENDAR_MAIL_HOST . ':993', trim($responses[0] ?? '–'));
}

// =============================================================================
// Test appointments
// =============================================================================

function testEvent(string $test, string $title, DateTimeImmutable $start, int $minutes, ?array $organizer = null, array $attendees = []): array
{
    $token = newToken(strtolower($test));
    return [
        'uid'         => uuid4(),
        'token'       => $token,
        'test'        => $test,
        'title'       => $title,
        'summary'     => 'CRM-Test ' . $test . ' · ' . $title . ' [' . $token . ']',
        'location'    => 'Test – bitte ignorieren',
        'description' => 'Testtermin der CRM-Kalenderintegration (Phase 0, ' . $test . ").\nWird nach dem Test wieder gelöscht.",
        'start'       => $start->format(DATE_ATOM),
        'end'         => $start->modify('+' . $minutes . ' minutes')->format(DATE_ATOM),
        'sequence'    => 0,
        'created'     => utcNow()->format(DATE_ATOM),
        'organizer'   => $organizer,
        'attendees'   => $attendees,
    ];
}

function person(string $email, string $partstat, bool $rsvp, ?string $agent): array
{
    return ['email' => $email, 'name' => teamName($email), 'partstat' => $partstat, 'rsvp' => $rsvp, 'agent' => $agent];
}

function probePerson(string $email, ?string $agent): array
{
    return ['email' => $email, 'name' => 'CRM-Testpostfach', 'partstat' => 'NEEDS-ACTION', 'rsvp' => true, 'agent' => $agent];
}

/**
 * The address that stands in for a participant whose mail we can read: the
 * shared account's own mailbox, through a plus address once T6 showed those
 * arrive (it keeps the address distinct from the account that is writing).
 */
function probeAddress(array $state): string
{
    if ($state['plus'] === null) {
        throw new ProbeFailure('Zuerst T6 (t6:send, dann mailcheck): Davon hängt ab, an welche Adresse die Testteilnehmer gehen.');
    }
    if ($state['plus']['delivered']) {
        return plusAddress(PROBE_PLUS_TAG);
    }
    out('  Hinweis: Plus-Adressen kommen nicht an, Testteilnehmer ist ' . CALENDAR_ACCOUNT . ' selbst.');
    out('  Lässt der Server Mails an das schreibende Konto selbst aus, wäre ein „keine Mail“ nicht aussagekräftig.');
    return CALENDAR_ACCOUNT;
}

/** PUT a new appointment, read it back, and record it for cleanup. */
function writeNewEvent(Dav $dav, array &$state, string $key, string $calendar, array $event, string $label): bool
{
    $href = collectionPath($calendar) . $event['uid'] . '.ics';
    $ics = buildEvent($event);
    $put = $dav->request('PUT', $href, ['Content-Type: text/calendar; charset=utf-8', 'If-None-Match: *'], $ics);
    result($label . ': PUT neu', statusText($put) . ', ETag in der Antwort: ' . ($put['headers']['etag'] ?? 'keins'));
    if ($put['status'] < 200 || $put['status'] >= 300) {
        result('  Server meldet', errorSummary($put));
        return false;
    }

    $get = $dav->request('GET', $href);
    result($label . ': GET', statusText($get) . ', ETag: ' . ($get['headers']['etag'] ?? '–'));
    if ($get['status'] === 200) {
        printStoredDiff($ics, $get['body']);
    }

    $state['objects'][$key] = [
        'label'      => $label,
        'calendar'   => collectionPath($calendar),
        'href'       => $href,
        'etag'       => $put['headers']['etag'] ?? $get['headers']['etag'] ?? currentEtag($dav, $href),
        'event'      => $event,
        'written_at' => gmdate('c'),
        'deleted'    => false,
    ];
    $state['tokens'][$event['token']] = ['test' => $event['test'], 'what' => $label, 'at' => gmdate('c')];
    saveState($state);
    return true;
}

function refuseIfActive(array $state, array $keys): void
{
    foreach ($keys as $key) {
        if (isset($state['objects'][$key]) && !$state['objects'][$key]['deleted']) {
            throw new ProbeFailure('Testtermin ' . $key . ' existiert schon. Erst löschen (cleanup).');
        }
    }
}

function requireObject(array $state, string $key, string $hint): array
{
    $object = $state['objects'][$key] ?? null;
    if ($object === null || $object['deleted']) {
        throw new ProbeFailure('Kein aktiver Testtermin ' . $key . '. ' . $hint);
    }
    return $object;
}

function requireWritable(Dav $dav, string $calendar): void
{
    $collection = collectionState($dav, $calendar);
    if ($collection['status'] !== 207) {
        throw new ProbeFailure($calendar . ' ist für ' . CALENDAR_ACCOUNT . ' nicht erreichbar (' . $collection['status'] . '). Erst discover.');
    }
    if ($collection['privileges'] && !canWrite($collection['privileges'])) {
        throw new ProbeFailure(CALENDAR_ACCOUNT . ' darf in ' . $calendar . ' nicht schreiben (Rechte: ' . implode(', ', $collection['privileges']) . ').');
    }
}

function eventLine(array $event): string
{
    $start = (new DateTimeImmutable($event['start']))->setTimezone(vienna());
    $end = (new DateTimeImmutable($event['end']))->setTimezone(vienna());
    $days = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    return '„' . $event['summary'] . '“, ' . $days[(int) $start->format('w')] . ' ' . $start->format('d.m.Y, H:i') . '–' . $end->format('H:i');
}

// =============================================================================
// iCalendar output (test data only - parsing is left to a library later)
// =============================================================================

function buildEvent(array $e): string
{
    $now = utcNow();
    $lines = array_merge(
        ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Disinfo Consulting//CRM Kalender Phase 0//DE', 'CALSCALE:GREGORIAN'],
        VTIMEZONE_VIENNA,
        [
            'BEGIN:VEVENT',
            'UID:' . $e['uid'],
            'DTSTAMP:' . icsUtc($now),
            'CREATED:' . icsUtc(new DateTimeImmutable($e['created'])),
            'LAST-MODIFIED:' . icsUtc($now),
            'SEQUENCE:' . (int) $e['sequence'],
            'DTSTART;TZID=' . PROBE_TZ . ':' . icsLocal(new DateTimeImmutable($e['start'])),
            'DTEND;TZID=' . PROBE_TZ . ':' . icsLocal(new DateTimeImmutable($e['end'])),
            'SUMMARY:' . icsText($e['summary']),
            'LOCATION:' . icsText($e['location']),
            'DESCRIPTION:' . icsText($e['description']),
            'STATUS:CONFIRMED',
            'TRANSP:OPAQUE',
            'CLASS:PUBLIC',
        ]
    );

    if ($e['organizer'] !== null) {
        $o = $e['organizer'];
        $lines[] = 'ORGANIZER;CN=' . icsParam($o['name'])
            . ($o['agent'] !== null ? ';SCHEDULE-AGENT=' . $o['agent'] : '')
            . ':mailto:' . $o['email'];
    }
    foreach ($e['attendees'] as $a) {
        $params = ['CN=' . icsParam($a['name']), 'CUTYPE=INDIVIDUAL', 'ROLE=REQ-PARTICIPANT', 'PARTSTAT=' . $a['partstat']];
        if ($a['rsvp']) {
            $params[] = 'RSVP=TRUE';
        }
        if ($a['agent'] !== null) {
            $params[] = 'SCHEDULE-AGENT=' . $a['agent'];
        }
        $lines[] = 'ATTENDEE;' . implode(';', $params) . ':mailto:' . $a['email'];
    }

    $lines[] = 'X-DISINFO-CRM-PROBE:' . $e['token'];
    $lines[] = 'END:VEVENT';
    $lines[] = 'END:VCALENDAR';

    return implode("\r\n", array_map('icsFold', $lines)) . "\r\n";
}

function icsUtc(DateTimeImmutable $time): string
{
    return $time->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z');
}

function icsLocal(DateTimeImmutable $time): string
{
    return $time->setTimezone(vienna())->format('Ymd\THis');
}

/** RFC 5545 3.3.11 TEXT escaping. */
function icsText(string $value): string
{
    return str_replace(['\\', ';', ',', "\r\n", "\n", "\r"], ['\\\\', '\\;', '\\,', '\\n', '\\n', '\\n'], $value);
}

function icsParam(string $value): string
{
    return '"' . str_replace(['"', "\r", "\n"], '', $value) . '"';
}

/** Fold at 75 octets without splitting a UTF-8 character (RFC 5545 3.1). */
function icsFold(string $line): string
{
    $parts = [];
    $current = '';
    foreach (preg_split('//u', $line, -1, PREG_SPLIT_NO_EMPTY) ?: [$line] as $char) {
        if (strlen($current) + strlen($char) > 75) {
            $parts[] = $current;
            $current = ' ';
        }
        $current .= $char;
    }
    $parts[] = $current;
    return implode("\r\n", $parts);
}

/** Lines with folding undone - only to compare what was sent with what came back. */
function icsLines(string $ics): array
{
    $unfolded = preg_replace("/\r?\n[ \t]/", '', $ics) ?? $ics;
    $lines = array_map('rtrim', preg_split("/\r?\n/", $unfolded) ?: []);
    return array_values(array_filter($lines, static function (string $line): bool {
        return $line !== '';
    }));
}

function printStoredDiff(string $sent, string $stored): void
{
    $sentLines = icsLines($sent);
    $storedLines = icsLines($stored);
    $removed = array_values(array_diff($sentLines, $storedLines));
    $added = array_values(array_diff($storedLines, $sentLines));
    if (!$removed && !$added) {
        result('  gespeichert wie gesendet', 'ja, Zeile für Zeile');
        return;
    }
    result('  gespeichert wie gesendet', 'nein, der Server hat geändert:');
    foreach ($removed as $line) {
        out('      − ' . $line);
    }
    foreach ($added as $line) {
        out('      + ' . $line);
    }
    if (preg_match('/SCHEDULE-STATUS=/i', $stored)) {
        result('  SCHEDULE-STATUS', 'vom Server gesetzt → er hat eine Zustellung versucht');
    }
}

// =============================================================================
// CalDAV
// =============================================================================

final class Dav
{
    private string $base;
    private string $user;
    private string $password;

    public function __construct(string $base, string $user, string $password)
    {
        $this->base = rtrim($base, '/');
        $this->user = $user;
        $this->password = $password;
    }

    /**
     * @return array{status:int, headers:array<string,string>, body:string}
     */
    public function request(string $method, string $path, array $headers = [], ?string $body = null, bool $auth = true): array
    {
        $url = preg_match('#^https?://#i', $path) ? $path : $this->base . '/' . ltrim($path, '/');
        $responseHeaders = [];

        $handle = curl_init($url);
        $options = [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            // "Expect:" stops curl from waiting for a 100 Continue on larger bodies.
            CURLOPT_HTTPHEADER     => array_merge(['User-Agent: DisinfoCRM-CalDAV-Probe/1', 'Expect:'], $headers),
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT        => 60,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$responseHeaders): int {
                $trimmed = trim($line);
                if (stripos($trimmed, 'HTTP/') === 0) {
                    $responseHeaders = [];
                } elseif (strpos($trimmed, ':') !== false) {
                    [$name, $value] = explode(':', $trimmed, 2);
                    $responseHeaders[strtolower(trim($name))] = trim($value);
                }
                return strlen($line);
            },
        ];
        if ($auth) {
            $options[CURLOPT_HTTPAUTH] = CURLAUTH_BASIC;
            $options[CURLOPT_USERNAME] = $this->user;
            $options[CURLOPT_PASSWORD] = $this->password;
        }
        if ($body !== null) {
            $options[CURLOPT_POSTFIELDS] = $body;
        }
        curl_setopt_array($handle, $options);

        $responseBody = curl_exec($handle);
        if ($responseBody === false) {
            throw new ProbeFailure($method . ' ' . $path . ' fehlgeschlagen: ' . curl_error($handle));
        }

        return [
            'status'  => (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE),
            'headers' => $responseHeaders,
            'body'    => (string) $responseBody,
        ];
    }
}

function propfind(Dav $dav, string $path, string $depth, array $props): array
{
    $xml = '<?xml version="1.0" encoding="utf-8"?>' . "\n"
        . '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/"><d:prop>';
    foreach ($props as $prop) {
        $xml .= '<' . $prop . '/>';
    }
    $xml .= '</d:prop></d:propfind>';

    $response = $dav->request('PROPFIND', $path, ['Depth: ' . $depth, 'Content-Type: application/xml; charset=utf-8'], $xml);
    $response['ms'] = $response['status'] === 207 ? parseMultistatus($response['body']) : null;
    return $response;
}

function firstResponse(array $propfind): ?array
{
    return $propfind['ms']['responses'][0] ?? null;
}

/**
 * Calendar collections at $path: its children (Depth 1) or itself (Depth 0).
 *
 * @return array{response: array, items: array<string, array>}
 */
function listCollections(Dav $dav, string $path, string $depth = '1'): array
{
    $response = propfind($dav, collectionPath($path), $depth, COLLECTION_PROPS);
    // Some servers only know a collection without its trailing slash.
    if (in_array($response['status'], [301, 302, 404, 405], true)) {
        $bare = propfind($dav, rtrim(collectionPath($path), '/'), $depth, COLLECTION_PROPS);
        if ($bare['status'] === 207) {
            out('  Hinweis: ' . rtrim(collectionPath($path), '/') . ' antwortet nur ohne Schrägstrich am Ende.');
            $response = $bare;
        }
    }
    $items = [];
    $diagnosis = [];
    foreach ($response['ms']['responses'] ?? [] as $entry) {
        $types = propChildNames($entry, 'd:resourcetype');
        if (!in_array('calendar', $types, true)) {
            $diagnosis[] = $entry['href'] . ' → ' . describeEntry($entry, $types);
            continue;
        }
        $privileges = propNestedNames($entry, 'd:current-user-privilege-set', 'privilege');
        $href = collectionPath($entry['href']);
        $items[$href] = [
            'href'        => $href,
            'displayname' => propText($entry, 'd:displayname'),
            'types'       => $types,
            'owner'       => propHrefs($entry, 'd:owner')[0] ?? null,
            'privileges'  => $privileges,
            'writable'    => canWrite($privileges),
            'reports'     => propNestedNames($entry, 'd:supported-report-set', 'report'),
            'components'  => propComponents($entry),
            'ctag'        => propText($entry, 'cs:getctag'),
            'sync_token'  => propText($entry, 'd:sync-token'),
        ];
    }
    return ['response' => $response, 'items' => $items, 'diagnosis' => $diagnosis];
}

/** Which properties came back with which status - tells "not shared" from "not there". */
function describeEntry(array $entry, array $types): string
{
    $byStatus = [];
    if ($entry['status'] !== '') {
        $byStatus[$entry['status']][] = '(Ressource)';
    }
    foreach ($entry['props'] as $key => $prop) {
        $byStatus[$prop['status']][] = substr($key, strrpos($key, '|') + 1);
    }
    $parts = [];
    foreach ($byStatus as $status => $names) {
        $parts[] = preg_replace('#^HTTP/[\d.]+ #', '', (string) $status) . ': ' . implode(', ', $names);
    }
    return ($types ? 'resourcetype=' . implode(',', $types) . '; ' : '') . ($parts ? implode('; ', $parts) : 'keine Properties');
}

function printCollection(array $c): void
{
    out('  ' . $c['href']);
    result('    Name', $c['displayname'] !== null && $c['displayname'] !== '' ? '„' . $c['displayname'] . '“' : '–');
    result('    resourcetype', implode(', ', $c['types']));
    result('    Eigentümer', $c['owner'] ?? '–');
    result('    Rechte von kalender@', $c['privileges'] ? implode(', ', $c['privileges']) : '– (nicht geliefert)');
    result('    schreibbar', $c['writable'] ? 'ja' : 'nein');
    result('    Komponenten', $c['components'] ? implode(', ', $c['components']) : '–');
    result('    REPORTs', $c['reports'] ? implode(', ', $c['reports']) : '– (supported-report-set nicht geliefert)');
    result('    CTag (getctag)', $c['ctag'] !== null ? 'ja' : 'nein');
    result('    sync-token (Property)', $c['sync_token'] !== null ? 'ja' : 'nein');
}

function canWrite(array $privileges): bool
{
    return in_array('all', $privileges, true)
        || in_array('write', $privileges, true)
        || (in_array('write-content', $privileges, true) && in_array('bind', $privileges, true));
}

function collectionState(Dav $dav, string $collection): array
{
    $response = propfind($dav, collectionPath($collection), '0', ['cs:getctag', 'd:sync-token', 'd:current-user-privilege-set']);
    $entry = firstResponse($response);
    return [
        'status'     => $response['status'],
        'ctag'       => $entry !== null ? propText($entry, 'cs:getctag') : null,
        'sync_token' => $entry !== null ? propText($entry, 'd:sync-token') : null,
        'privileges' => $entry !== null ? propNestedNames($entry, 'd:current-user-privilege-set', 'privilege') : [],
    ];
}

function currentEtag(Dav $dav, string $href): ?string
{
    $entry = firstResponse(propfind($dav, $href, '0', ['d:getetag']));
    $etag = $entry !== null ? propText($entry, 'd:getetag') : null;
    if ($etag !== null && $etag !== '') {
        return $etag;
    }
    $get = $dav->request('GET', $href);
    return $get['status'] === 200 ? ($get['headers']['etag'] ?? null) : null;
}

/**
 * RFC 6578 sync-collection. An empty token asks for everything.
 */
function syncCollection(Dav $dav, string $collection, string $token): array
{
    $xml = '<?xml version="1.0" encoding="utf-8"?>' . "\n"
        . '<d:sync-collection xmlns:d="DAV:">'
        . ($token === '' ? '<d:sync-token/>' : '<d:sync-token>' . xmlText($token) . '</d:sync-token>')
        . '<d:sync-level>1</d:sync-level>'
        . '<d:prop><d:getetag/></d:prop>'
        . '</d:sync-collection>';

    // RFC 6578 says Depth: 0; some servers only answer to Depth: 1.
    $response = null;
    $depth = '0';
    foreach (['0', '1'] as $depth) {
        $response = $dav->request('REPORT', collectionPath($collection), ['Depth: ' . $depth, 'Content-Type: application/xml; charset=utf-8'], $xml);
        if ($response['status'] === 207) {
            break;
        }
    }

    $result = ['status' => $response['status'], 'ok' => false, 'depth' => $depth, 'token' => '', 'changed' => [], 'removed' => [], 'error' => null];
    if ($response['status'] !== 207) {
        $result['error'] = errorSummary($response);
        return $result;
    }

    $ms = parseMultistatus($response['body']);
    $result['token'] = $ms['sync-token'];
    // A 207 without a token is a server that does not know the report and
    // answers with an empty multistatus.
    $result['ok'] = $result['token'] !== '';
    if (!$result['ok']) {
        $result['error'] = 'leere Antwort ohne sync-token, REPORT wird nicht unterstützt';
        return $result;
    }
    foreach ($ms['responses'] as $entry) {
        if (samePath($entry['href'], $collection)) {
            continue;
        }
        if ($entry['status'] !== '' && strpos($entry['status'], ' 404') !== false) {
            $result['removed'][] = $entry['href'];
            continue;
        }
        $result['changed'][$entry['href']] = propText($entry, 'd:getetag') ?? '';
    }
    return $result;
}

/** What change detection compares against: the sync token if the server has one, else every ETag. */
function changeBaseline(Dav $dav, string $calendar): ?array
{
    $sync = syncCollection($dav, $calendar, '');
    if ($sync['ok']) {
        return ['kind' => 'sync', 'token' => $sync['token']];
    }
    $listing = etagListing($dav, $calendar);
    return $listing['ok'] ? ['kind' => 'etags', 'etags' => $listing['etags']] : null;
}

/**
 * Check that the change to $href shows up the way the sync job will see it.
 * Returns the baseline for the next step.
 */
function reportDelta(Dav $dav, string $calendar, ?array $baseline, string $href, string $expect): ?array
{
    if ($baseline === null) {
        result('Änderungserkennung', 'nicht möglich (keine Ausgangsbasis)');
        return changeBaseline($dav, $calendar);
    }
    $key = rtrim(pathOf($href), '/');

    if ($baseline['kind'] === 'sync') {
        $delta = syncCollection($dav, $calendar, $baseline['token']);
        if (!$delta['ok']) {
            result('sync-collection-Delta', 'Fehler: ' . $delta['error']);
            return changeBaseline($dav, $calendar);
        }
        $listed = false;
        foreach ($expect === 'gelöscht' ? $delta['removed'] : array_keys($delta['changed']) as $candidate) {
            $listed = $listed || rtrim(pathOf((string) $candidate), '/') === $key;
        }
        result('sync-collection-Delta', count($delta['changed']) . ' geändert, ' . count($delta['removed']) . ' gelöscht  '
            . verdict($listed, 'Testtermin als ' . $expect . ' gemeldet'));
        return ['kind' => 'sync', 'token' => $delta['token']];
    }

    $now = etagListing($dav, $calendar);
    if (!$now['ok']) {
        result('ETag-Vergleich', 'Fehler: ' . $now['error']);
        return null;
    }
    $before = $baseline['etags'];
    $after = $now['etags'];
    $added = array_diff_key($after, $before);
    $removed = array_diff_key($before, $after);
    $changed = [];
    foreach (array_intersect_key($after, $before) as $path => $etag) {
        if ($before[$path] !== $etag) {
            $changed[$path] = $etag;
        }
    }
    if ($expect === 'neu') {
        $listed = isset($added[$key]);
    } elseif ($expect === 'geändert') {
        $listed = isset($changed[$key]);
    } else {
        $listed = isset($removed[$key]);
    }
    result('ETag-Vergleich (Fallback)', count($added) . ' neu, ' . count($changed) . ' geändert, ' . count($removed) . ' gelöscht  '
        . verdict($listed, 'Testtermin als ' . $expect . ' erkannt'));
    return ['kind' => 'etags', 'etags' => $after];
}

function reportCtag(array $before, array $after): void
{
    if ($before['ctag'] === null) {
        result('CTag geändert', 'kein CTag');
        return;
    }
    $changed = $before['ctag'] !== $after['ctag'];
    result('CTag geändert', verdict($changed, $changed ? 'ja' : 'nein'));
}

/** Every object in a collection with its ETag - the fallback when there is no sync-collection. */
function etagListing(Dav $dav, string $collection): array
{
    $response = propfind($dav, collectionPath($collection), '1', ['d:getetag']);
    if ($response['status'] !== 207) {
        return ['ok' => false, 'etags' => [], 'error' => errorSummary($response)];
    }
    $etags = [];
    foreach ($response['ms']['responses'] as $entry) {
        $etag = propText($entry, 'd:getetag');
        if ($etag !== null && $etag !== '' && !samePath($entry['href'], $collection)) {
            $etags[rtrim(pathOf($entry['href']), '/')] = $etag;
        }
    }
    return ['ok' => true, 'etags' => $etags, 'error' => null];
}

function calendarQueryCount(Dav $dav, string $collection, DateTimeImmutable $from, DateTimeImmutable $to): array
{
    $xml = '<?xml version="1.0" encoding="utf-8"?>' . "\n"
        . '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        . '<d:prop><d:getetag/></d:prop>'
        . '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
        . '<c:time-range start="' . icsUtc($from) . '" end="' . icsUtc($to) . '"/>'
        . '</c:comp-filter></c:comp-filter></c:filter>'
        . '</c:calendar-query>';
    $response = $dav->request('REPORT', collectionPath($collection), ['Depth: 1', 'Content-Type: application/xml; charset=utf-8'], $xml);
    if ($response['status'] !== 207) {
        return ['ok' => false, 'count' => 0, 'error' => errorSummary($response)];
    }
    $count = 0;
    foreach (parseMultistatus($response['body'])['responses'] as $entry) {
        if (!samePath($entry['href'], $collection)) {
            $count++;
        }
    }
    return ['ok' => true, 'count' => $count, 'error' => null];
}

function multigetSizes(Dav $dav, string $collection, array $hrefs): array
{
    $xml = '<?xml version="1.0" encoding="utf-8"?>' . "\n"
        . '<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        . '<d:prop><d:getetag/><c:calendar-data/></d:prop>';
    foreach ($hrefs as $href) {
        $xml .= '<d:href>' . xmlText((string) $href) . '</d:href>';
    }
    $xml .= '</c:calendar-multiget>';
    $response = $dav->request('REPORT', collectionPath($collection), ['Depth: 1', 'Content-Type: application/xml; charset=utf-8'], $xml);
    if ($response['status'] !== 207) {
        return ['ok' => false, 'sizes' => [], 'error' => errorSummary($response)];
    }
    $sizes = [];
    foreach (parseMultistatus($response['body'])['responses'] as $entry) {
        $data = propText($entry, 'c:calendar-data');
        if ($data !== null) {
            $sizes[] = strlen($data);
        }
    }
    return ['ok' => true, 'sizes' => $sizes, 'error' => null];
}

// --- multistatus XML ---------------------------------------------------------

function parseMultistatus(string $xml): array
{
    $result = ['responses' => [], 'sync-token' => ''];
    $doc = new DOMDocument();
    // LIBXML_NONET: never fetch anything an XML document points at.
    if ($xml === '' || !@$doc->loadXML($xml, LIBXML_NONET)) {
        return $result;
    }
    $xp = new DOMXPath($doc);
    $xp->registerNamespace('d', NS['d']);

    foreach ($xp->query('/d:multistatus/d:response') as $response) {
        $entry = [
            'href'   => trim((string) $xp->evaluate('string(d:href)', $response)),
            'status' => trim((string) $xp->evaluate('string(d:status)', $response)),
            'props'  => [],
        ];
        foreach ($xp->query('d:propstat', $response) as $propstat) {
            $status = trim((string) $xp->evaluate('string(d:status)', $propstat));
            foreach ($xp->query('d:prop/*', $propstat) as $prop) {
                $entry['props'][$prop->namespaceURI . '|' . $prop->localName] = ['status' => $status, 'el' => $prop];
            }
        }
        $result['responses'][] = $entry;
    }
    $result['sync-token'] = trim((string) $xp->evaluate('string(/d:multistatus/d:sync-token)'));
    return $result;
}

function propEl(array $entry, string $qname): ?DOMElement
{
    [$prefix, $local] = explode(':', $qname, 2);
    $prop = $entry['props'][NS[$prefix] . '|' . $local] ?? null;
    if ($prop === null || strpos($prop['status'], ' 200') === false) {
        return null;
    }
    return $prop['el'];
}

function propText(array $entry, string $qname): ?string
{
    $el = propEl($entry, $qname);
    return $el === null ? null : trim($el->textContent);
}

/** The d:href values inside a property (principal URLs, home sets, addresses). */
function propHrefs(array $entry, string $qname): array
{
    $el = propEl($entry, $qname);
    if ($el === null) {
        return [];
    }
    $hrefs = [];
    foreach ($el->getElementsByTagNameNS(NS['d'], 'href') as $href) {
        $hrefs[] = trim($href->textContent);
    }
    return $hrefs;
}

/** Local names of a property's element children, e.g. of resourcetype. */
function propChildNames(array $entry, string $qname): array
{
    $el = propEl($entry, $qname);
    if ($el === null) {
        return [];
    }
    $names = [];
    foreach ($el->childNodes as $child) {
        if ($child instanceof DOMElement) {
            $names[] = $child->localName;
        }
    }
    return $names;
}

/** Local names inside every d:$wrapper below a property (privileges, reports). */
function propNestedNames(array $entry, string $qname, string $wrapper): array
{
    $el = propEl($entry, $qname);
    if ($el === null) {
        return [];
    }
    $names = [];
    foreach ($el->getElementsByTagNameNS(NS['d'], $wrapper) as $node) {
        foreach ($node->childNodes as $child) {
            if ($child instanceof DOMElement) {
                $names[] = $child->localName;
            }
        }
    }
    return array_values(array_unique($names));
}

function propComponents(array $entry): array
{
    $el = propEl($entry, 'c:supported-calendar-component-set');
    if ($el === null) {
        return [];
    }
    $names = [];
    foreach ($el->getElementsByTagNameNS(NS['c'], 'comp') as $comp) {
        $names[] = $comp->getAttribute('name');
    }
    return $names;
}

function xmlText(string $value): string
{
    return htmlspecialchars($value, ENT_XML1 | ENT_QUOTES, 'UTF-8');
}

function pathOf(string $href): string
{
    $path = preg_match('#^https?://#i', $href) ? (string) parse_url($href, PHP_URL_PATH) : $href;
    return rawurldecode($path);
}

function samePath(string $a, string $b): bool
{
    return rtrim(pathOf($a), '/') === rtrim(pathOf($b), '/');
}

function collectionPath(string $path): string
{
    return rtrim(pathOf($path), '/') . '/';
}

function workCalendar(string $email): string
{
    return '/calendars/' . $email . '/calendar/';
}

function statusText(array $response): string
{
    $names = [
        200 => 'OK', 201 => 'Created', 204 => 'No Content', 207 => 'Multi-Status',
        301 => 'Moved Permanently', 302 => 'Found', 400 => 'Bad Request', 401 => 'Unauthorized',
        403 => 'Forbidden', 404 => 'Not Found', 405 => 'Method Not Allowed', 409 => 'Conflict',
        412 => 'Precondition Failed', 415 => 'Unsupported Media Type', 500 => 'Internal Server Error',
        501 => 'Not Implemented', 507 => 'Insufficient Storage',
    ];
    $status = (int) $response['status'];
    return $status . (isset($names[$status]) ? ' ' . $names[$status] : '');
}

/** Status plus the server's own message - error bodies, never appointment data. */
function errorSummary(array $response): string
{
    $text = trim(preg_replace('/\s+/', ' ', strip_tags($response['body'])) ?? '');
    return statusText($response) . ($text !== '' ? ' – ' . mb_substr($text, 0, 200) : '');
}

// =============================================================================
// Mail
// =============================================================================

final class Smtp
{
    /** @var resource */
    private $socket;

    /** @var list<string> What was said, with the AUTH line masked. */
    public array $transcript = [];

    public function __construct(string $host, int $port = 465)
    {
        $context = stream_context_create(['ssl' => ['peer_name' => $host, 'verify_peer' => true, 'verify_peer_name' => true]]);
        $socket = @stream_socket_client('ssl://' . $host . ':' . $port, $errno, $errstr, 20, STREAM_CLIENT_CONNECT, $context);
        if ($socket === false) {
            throw new ProbeFailure('SMTP: keine Verbindung zu ' . $host . ':' . $port . ' (' . $errstr . ')');
        }
        stream_set_timeout($socket, 60);
        $this->socket = $socket;
        $this->expect([220]);
    }

    public function ehlo(string $name): array
    {
        $this->send('EHLO ' . $name);
        return $this->expect([250]);
    }

    public function auth(string $user, string $password): void
    {
        $this->send('AUTH PLAIN ' . base64_encode("\0" . $user . "\0" . $password), 'AUTH PLAIN ********');
        $this->expect([235]);
    }

    public function mailFrom(string $address): void
    {
        $this->send('MAIL FROM:<' . $address . '>');
        $this->expect([250]);
    }

    public function rcptTo(string $address): void
    {
        $this->send('RCPT TO:<' . $address . '>');
        $this->expect([250, 251]);
    }

    /** @return string The server's final answer, which carries Exim's queue id. */
    public function data(string $message): string
    {
        $this->send('DATA');
        $this->expect([354]);
        $normalized = preg_replace("/\r\n|\r|\n/", "\r\n", $message) ?? $message;
        $stuffed = preg_replace('/^\./m', '..', $normalized) ?? $normalized;
        fwrite($this->socket, rtrim($stuffed, "\r\n") . "\r\n.\r\n");
        $this->transcript[] = 'C: <Nachricht, ' . strlen($stuffed) . ' Bytes>';
        $this->transcript[] = 'C: .';
        $lines = $this->expect([250]);
        return (string) end($lines);
    }

    public function quit(): void
    {
        try {
            $this->send('QUIT');
            $this->expect([221]);
        } catch (ProbeFailure $e) {
            // The message is already through or already refused.
        }
        fclose($this->socket);
    }

    private function send(string $line, ?string $logged = null): void
    {
        fwrite($this->socket, $line . "\r\n");
        $this->transcript[] = 'C: ' . ($logged ?? $line);
    }

    private function expect(array $codes): array
    {
        $lines = [];
        do {
            $line = fgets($this->socket);
            if ($line === false) {
                throw new ProbeFailure('SMTP: Verbindung unterbrochen');
            }
            $line = rtrim($line, "\r\n");
            $lines[] = $line;
            $this->transcript[] = 'S: ' . $line;
        } while (isset($line[3]) && $line[3] === '-');

        if (!in_array((int) substr($line, 0, 3), $codes, true)) {
            throw new ProbeFailure('SMTP: Server antwortet „' . $line . '“');
        }
        return $lines;
    }
}

/** Submit one message as the shared account and print the transcript. */
function smtpSend(string $envelope, array $recipients, string $message): array
{
    $smtp = null;
    $accepted = false;
    $queue = null;
    $error = null;
    try {
        $smtp = new Smtp(CALENDAR_MAIL_HOST, 465);
        $smtp->ehlo('crm-probe.local');
        $smtp->auth(CALENDAR_ACCOUNT, CALENDAR_ACCOUNT_PASSWORD);
        $smtp->mailFrom($envelope);
        foreach ($recipients as $recipient) {
            $smtp->rcptTo($recipient);
        }
        $final = $smtp->data($message);
        $accepted = true;
        $queue = preg_match('/id=(\S+)/', $final, $m) ? $m[1] : null;
    } catch (ProbeFailure $e) {
        $error = $e->getMessage();
    } finally {
        if ($smtp !== null) {
            $smtp->quit();
        }
    }

    out();
    out('  SMTP-Protokoll (Anmeldung maskiert):');
    foreach ($smtp !== null ? $smtp->transcript : [] as $line) {
        out('    ' . $line);
    }
    result('Ergebnis', $accepted
        ? '✓ angenommen' . ($queue !== null ? ' (Exim-ID ' . $queue . ')' : '')
        : '✗ abgelehnt: ' . $error);
    return ['accepted' => $accepted, 'queue' => $queue, 'error' => $error];
}

function buildMail(string $fromEmail, string $fromName, array $to, string $subject, string $text, string $html, string $token): string
{
    $boundary = 'crm-p0-' . bin2hex(random_bytes(8));
    $domain = substr((string) strrchr($fromEmail, '@'), 1);
    $headers = [
        'From: ' . mb_encode_mimeheader($fromName, 'UTF-8', 'B', "\r\n", 6) . ' <' . $fromEmail . '>',
        'To: ' . implode(', ', array_map(static function (string $address): string {
            return '<' . $address . '>';
        }, $to)),
        'Subject: ' . mb_encode_mimeheader($subject, 'UTF-8', 'B', "\r\n", 9),
        'Date: ' . (new DateTimeImmutable('now', vienna()))->format(DATE_RFC2822),
        'Message-ID: <' . $token . '.' . bin2hex(random_bytes(4)) . '@' . $domain . '>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
    ];
    $body = '--' . $boundary . "\r\n"
        . "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        . chunk_split(base64_encode($text), 76, "\r\n")
        . '--' . $boundary . "\r\n"
        . "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        . chunk_split(base64_encode($html), 76, "\r\n")
        . '--' . $boundary . "--\r\n";
    return implode("\r\n", $headers) . "\r\n\r\n" . $body;
}

/**
 * A minimal IMAP client: read-only (EXAMINE, BODY.PEEK), enough to look for
 * the probe's own test mails in the shared account's mailbox.
 */
final class Imap
{
    /** @var resource */
    private $socket;
    private int $tag = 0;

    public function __construct(string $host, int $port = 993)
    {
        $context = stream_context_create(['ssl' => ['peer_name' => $host, 'verify_peer' => true, 'verify_peer_name' => true]]);
        $socket = @stream_socket_client('ssl://' . $host . ':' . $port, $errno, $errstr, 20, STREAM_CLIENT_CONNECT, $context);
        if ($socket === false) {
            throw new ProbeFailure('IMAP: keine Verbindung zu ' . $host . ':' . $port . ' (' . $errstr . ')');
        }
        stream_set_timeout($socket, 30);
        $this->socket = $socket;
        if (strpos($this->readLine(), '* OK') !== 0) {
            throw new ProbeFailure('IMAP: unerwartete Begrüßung');
        }
    }

    public function login(string $user, string $password): void
    {
        // SASL-IR (Dovecot announces it): one line, no quoting problems.
        [$status] = $this->command('AUTHENTICATE PLAIN ' . base64_encode("\0" . $user . "\0" . $password));
        if (stripos($status, 'OK') !== 0) {
            throw new ProbeFailure('IMAP-Anmeldung abgelehnt: ' . $status);
        }
    }

    /** @return array{0:string, 1:list<string>} Tagged status and the untagged responses, literals inlined. */
    public function command(string $command): array
    {
        $tag = 'p' . (++$this->tag);
        fwrite($this->socket, $tag . ' ' . $command . "\r\n");
        $responses = [];
        while (true) {
            $line = $this->readLine();
            while (preg_match('/\{(\d+)\}\r\n$/', $line, $m)) {
                $line .= $this->readBytes((int) $m[1]);
                $line .= $this->readLine();
            }
            if (strncmp($line, $tag . ' ', strlen($tag) + 1) === 0) {
                return [trim(substr($line, strlen($tag) + 1)), $responses];
            }
            $responses[] = $line;
        }
    }

    /** @return list<string> Selectable folders. */
    public function folders(): array
    {
        [$status, $responses] = $this->command('LIST "" "*"');
        if (stripos($status, 'OK') !== 0) {
            throw new ProbeFailure('IMAP LIST: ' . $status);
        }
        $folders = [];
        foreach ($responses as $line) {
            if (!preg_match('/^\* LIST \(([^)]*)\) (?:"(?:[^"\\\\]|\\\\.)*"|NIL) (.+?)\r?\n?$/s', $line, $m)) {
                continue;
            }
            if (stripos($m[1], '\\Noselect') !== false || stripos($m[1], '\\NonExistent') !== false) {
                continue;
            }
            $name = $m[2];
            if (preg_match('/^\{\d+\}\r\n(.*)$/s', $name, $literal)) {
                $name = $literal[1];
            } elseif (strlen($name) >= 2 && $name[0] === '"') {
                $name = str_replace(['\\"', '\\\\'], ['"', '\\'], substr($name, 1, -1));
            }
            $folders[] = $name;
        }
        return $folders;
    }

    public function examine(string $folder): bool
    {
        [$status] = $this->command('EXAMINE ' . self::quote($folder));
        return stripos($status, 'OK') === 0;
    }

    /** @return list<int> */
    public function search(string $criteria): array
    {
        [, $responses] = $this->command('UID SEARCH ' . $criteria);
        foreach ($responses as $line) {
            if (preg_match('/^\* SEARCH([\d ]*)/', $line, $m)) {
                return array_values(array_map('intval', array_filter(explode(' ', trim($m[1])), 'strlen')));
            }
        }
        return [];
    }

    public function summary(int $uid): array
    {
        [, $responses] = $this->command('UID FETCH ' . $uid . ' (INTERNALDATE BODY.PEEK[HEADER])');
        $text = implode('', $responses);
        $header = '';
        if (preg_match('/BODY\[HEADER\] \{(\d+)\}\r\n/', $text, $m, PREG_OFFSET_CAPTURE)) {
            $header = substr($text, $m[0][1] + strlen($m[0][0]), (int) $m[1][0]);
        }
        $internal = preg_match('/INTERNALDATE "([^"]+)"/', $text, $date) ? $date[1] : '';

        [, $structureResponses] = $this->command('UID FETCH ' . $uid . ' (BODYSTRUCTURE)');
        $structure = implode('', $structureResponses);
        preg_match_all('/\("(TEXT|APPLICATION|IMAGE|MESSAGE|AUDIO|VIDEO)" "([^"]+)"/i', $structure, $types, PREG_SET_ORDER);
        $parts = array_map(static function (array $t): string {
            return strtolower($t[1] . '/' . $t[2]);
        }, $types);
        $method = preg_match('/"METHOD" "([^"]+)"/i', $structure, $mm) ? strtoupper($mm[1]) : null;

        $headers = [];
        $decoded = $header !== '' ? iconv_mime_decode_headers($header, ICONV_MIME_DECODE_CONTINUE_ON_ERROR, 'UTF-8') : [];
        foreach ($decoded ?: [] as $name => $value) {
            $headers[strtolower((string) $name)] = $value;
        }

        return ['internaldate' => $internal, 'headers' => $headers, 'parts' => $parts, 'method' => $method];
    }

    public function logout(): void
    {
        try {
            $this->command('LOGOUT');
        } catch (ProbeFailure $e) {
            // Closing anyway.
        }
        fclose($this->socket);
    }

    public static function quote(string $value): string
    {
        return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $value) . '"';
    }

    private function readLine(): string
    {
        $line = fgets($this->socket);
        if ($line === false) {
            throw new ProbeFailure('IMAP: Verbindung unterbrochen');
        }
        return $line;
    }

    private function readBytes(int $length): string
    {
        $data = '';
        while (strlen($data) < $length) {
            $chunk = fread($this->socket, $length - strlen($data));
            if ($chunk === false || $chunk === '') {
                throw new ProbeFailure('IMAP: Verbindung unterbrochen');
            }
            $data .= $chunk;
        }
        return $data;
    }
}

function printMail(string $folder, array $mail): void
{
    out('    ✉ Ordner ' . $folder . ', eingegangen ' . $mail['internaldate']);
    $fields = ['from', 'sender', 'to', 'cc', 'subject', 'date', 'delivered-to', 'x-original-to', 'envelope-to',
        'return-path', 'content-type', 'x-mailer', 'auto-submitted'];
    foreach ($fields as $name) {
        if (isset($mail['headers'][$name])) {
            result('      ' . $name, headerValue($mail['headers'][$name]));
        }
    }
    if ($mail['parts']) {
        result('      MIME-Teile', implode(', ', $mail['parts']));
    }
    if ($mail['method'] !== null) {
        result('      iTIP-Methode', $mail['method']);
    }
}

function headerValue($value): string
{
    $text = is_array($value) ? implode(' | ', $value) : (string) $value;
    $text = preg_replace('/\s+/', ' ', $text) ?? $text;
    return mb_strlen($text) > 220 ? mb_substr($text, 0, 220) . '…' : $text;
}

function plusAddress(string $tag): string
{
    [$local, $domain] = explode('@', CALENDAR_ACCOUNT, 2);
    return $local . '+' . $tag . '@' . $domain;
}

// =============================================================================
// Small helpers
// =============================================================================

function requireAccount(bool $withPassword): void
{
    $missing = [];
    foreach (['CALDAV_BASE_URL' => CALDAV_BASE_URL, 'CALENDAR_ACCOUNT' => CALENDAR_ACCOUNT, 'CALENDAR_MAIL_HOST' => CALENDAR_MAIL_HOST] as $name => $value) {
        if ($value === '') {
            $missing[] = $name;
        }
    }
    if ($withPassword && CALENDAR_ACCOUNT_PASSWORD === '') {
        $missing[] = 'CALENDAR_ACCOUNT_PASSWORD';
    }
    if ($missing) {
        throw new ProbeFailure('In .env fehlt oder ist leer: ' . implode(', ', $missing) . '.');
    }
}

function loadState(): array
{
    $fresh = ['started_at' => gmdate('c'), 'objects' => [], 'tokens' => [], 'calendars' => [], 'plus' => null];
    if (!is_file(PROBE_STATE_FILE)) {
        return $fresh;
    }
    $data = json_decode((string) file_get_contents(PROBE_STATE_FILE), true);
    return is_array($data) ? array_merge($fresh, $data) : $fresh;
}

function saveState(array $state): void
{
    $json = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false || file_put_contents(PROBE_STATE_FILE, $json . "\n", LOCK_EX) === false) {
        throw new ProbeFailure('Konnte ' . PROBE_STATE_FILE . ' nicht schreiben.');
    }
    @chmod(PROBE_STATE_FILE, 0600);
}

function parseOptions(array $args): array
{
    $opts = ['_' => []];
    foreach ($args as $arg) {
        if (preg_match('/^--([a-z][a-z-]*)(?:=(.*))?$/s', $arg, $m)) {
            $opts[$m[1]] = $m[2] ?? '1';
        } else {
            $opts['_'][] = $arg;
        }
    }
    return $opts;
}

function testDay(array $opts): DateTimeImmutable
{
    if (isset($opts['date'])) {
        $day = DateTimeImmutable::createFromFormat('!Y-m-d', (string) $opts['date'], vienna());
        if ($day === false) {
            throw new ProbeFailure('--date erwartet JJJJ-MM-TT.');
        }
        return $day;
    }
    return new DateTimeImmutable('tomorrow', vienna());
}

function teamName(string $email): string
{
    $team = PROBE_TEAM;
    return $team[$email] ?? $email;
}

function newToken(string $test): string
{
    return 'p0-' . $test . '-' . bin2hex(random_bytes(3));
}

function uuid4(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
}

function vienna(): DateTimeZone
{
    return new DateTimeZone(PROBE_TZ);
}

function utcNow(): DateTimeImmutable
{
    return new DateTimeImmutable('now', new DateTimeZone('UTC'));
}

function verdict(bool $ok, string $text): string
{
    return ($ok ? '✓ ' : '✗ ') . $text;
}

function out(string $line = ''): void
{
    fwrite(STDOUT, $line . PHP_EOL);
}

function heading(string $title): void
{
    out();
    out($title);
    out(str_repeat('─', mb_strlen($title)));
}

function result(string $label, string $value): void
{
    out('  ' . $label . str_repeat(' ', max(1, 38 - mb_strlen($label))) . $value);
}
