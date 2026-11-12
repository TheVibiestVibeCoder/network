<?php
// Team calendar sync - run by cron every 5 minutes (cPanel -> Cron Jobs):
//
//     */5 * * * * /usr/local/bin/php /path/to/cli/calendar-sync.php >/dev/null 2>&1

/**
 * Options:
 *     --discover   look for newly shared calendars now (otherwise once a day)
 *     --quiet      print nothing unless something failed
 *
 * cPanel can pause a web application that nobody uses, so the sync does not
 * rely on timers inside the app: this script is the regular path, opening the
 * calendar only adds a sync on top (includes/CalendarSync.php).
 *
 * Exit codes: 0 done or skipped (another run holds the lock), 1 not
 * configured, 2 finished with errors. Output is counts only.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

define('APP_ROOT', dirname(__DIR__));
require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/CalendarSync.php';

$options = array_slice($argv, 1);
$quiet = in_array('--quiet', $options, true);

if (!calendarConfigured()) {
    fwrite(STDERR, "Calendar sync: CALDAV_BASE_URL, CALENDAR_ACCOUNT and CALENDAR_ACCOUNT_PASSWORD must be set in .env.\n");
    exit(1);
}

$started = microtime(true);
try {
    $stats = CalendarSync::runLocked(in_array('--discover', $options, true));
} catch (Throwable $e) {
    fwrite(STDERR, 'Calendar sync failed: ' . $e->getMessage() . "\n");
    exit(2);
}

if ($stats === null) {
    if (!$quiet) {
        echo "Calendar sync: another run is still going, skipped.\n";
    }
    exit(0);
}

if (!$quiet || $stats['errors'] > 0) {
    printf(
        "Calendar sync: %d calendars, %d checked, %d downloaded, %d changed, %d removed, %d new calendars, %d copies written, %d errors (%.1fs)\n",
        $stats['sources'], $stats['checked'], $stats['fetched'], $stats['changed'], $stats['removed'], $stats['discovered'],
        $stats['copies'], $stats['errors'], microtime(true) - $started
    );
}
exit($stats['errors'] > 0 ? 2 : 0);
