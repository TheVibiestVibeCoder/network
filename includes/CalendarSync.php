<?php
/**
 * Team calendar sync: the mail server's calendars into the CRM's cache
 *
 * Run every 5 minutes by cron (cli/calendar-sync.php) and, at most every
 * CALENDAR_OPEN_SYNC_SECONDS, when somebody opens the calendar. The CalDAV
 * server stays the only source of truth; this only ever reads from it.
 *
 * Per calendar:
 *   1. CTag unchanged and nothing waiting for a second look: done.
 *   2. Otherwise list every object's ETag, download what is new or changed
 *      (calendar-multiget), forget what is gone.
 *   3. The server's ETags have one-second resolution, so an object changed in
 *      this run is downloaded once more in the next one and compared by
 *      content (recheck). A second edit within the same second is caught.
 *   4. Once a day every stored object is expanded again - the window moves -
 *      and whatever finished longer ago than CALENDAR_RETENTION_MONTHS loses
 *      its contents.
 *
 * A file lock keeps runs from overlapping. Errors are logged with calendar id
 * and HTTP status only, never with titles, times or participants. Calendars
 * that are not on this server - a local demo's - are left alone.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

require_once APP_ROOT . '/includes/CalDavClient.php';
require_once APP_ROOT . '/includes/CalendarIcs.php';
require_once APP_ROOT . '/includes/CalendarStore.php';
require_once APP_ROOT . '/includes/CalendarCopies.php';

final class CalendarSync
{
    /** Person colours, in the order people are first seen (spec, section 3). */
    public const PALETTE = ['#30599D', '#2E8A8A', '#B07A2A', '#8A5A83', '#5E7A3A', '#9A4A4A'];

    private const SETTING_LAST_SYNC = 'calendar.last_sync_at';
    private const SETTING_LAST_ERROR = 'calendar.last_sync_error';
    private const SETTING_LAST_DISCOVERY = 'calendar.last_discovery_at';

    private PDO $db;
    private CalDavSource $dav;
    private DateTimeImmutable $windowStart;
    private DateTimeImmutable $windowEnd;
    private DateTimeImmutable $today;

    /** @var array{sources: int, checked: int, fetched: int, changed: int, removed: int, errors: int, discovered: int, copies: int} */
    private array $stats = ['sources' => 0, 'checked' => 0, 'fetched' => 0, 'changed' => 0, 'removed' => 0, 'errors' => 0, 'discovered' => 0, 'copies' => 0];

    public function __construct(?CalDavSource $dav = null)
    {
        $this->db = Database::getInstance();
        $this->dav = $dav ?? CalDavClient::fromConfig();
        $zone = new DateTimeZone(CALENDAR_TIMEZONE);
        $this->today = new DateTimeImmutable('today', $zone);
        $this->windowStart = $this->today->modify('-' . CALENDAR_RETENTION_MONTHS . ' months');
        $this->windowEnd = $this->today->modify('+' . CALENDAR_FUTURE_MONTHS . ' months');
    }

    /**
     * Run once - or not at all when another run holds the lock.
     *
     * @return array|null The run's counts, or null when it was skipped.
     */
    public static function runLocked(bool $discover = false, ?CalDavSource $dav = null): ?array
    {
        $lock = @fopen(DATA_DIR . '/calendar-sync.lock', 'c');
        if ($lock === false) {
            throw new RuntimeException('Cannot open the calendar sync lock file.');
        }
        if (!flock($lock, LOCK_EX | LOCK_NB)) {
            fclose($lock);
            return null;
        }
        try {
            return (new self($dav))->run($discover);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /** When the last run finished, as stored in app_settings (UTC). */
    public static function lastSyncAt(): ?string
    {
        return self::setting(self::SETTING_LAST_SYNC);
    }

    public static function lastError(): ?string
    {
        return self::setting(self::SETTING_LAST_ERROR);
    }

    public function run(bool $discover = false): array
    {
        $this->stats = array_fill_keys(array_keys($this->stats), 0);
        $error = null;
        try {
            if ($discover || $this->discoveryDue()) {
                $this->discover();
            }
        } catch (Throwable $e) {
            // Without a fresh list the known calendars can still be synced.
            $this->stats['errors']++;
            $error = 'Discovery: ' . self::shortError($e);
            error_log('Calendar sync: discovery failed: ' . self::shortError($e));
        }

        $sources = $this->db->query("SELECT * FROM calendar_sources WHERE enabled = 1 ORDER BY id")->fetchAll();
        $synced = [];
        foreach ($sources as $source) {
            if (!$this->dav->serves((string) $source['href'])) {
                continue; // a local demo calendar, not this server's
            }
            $this->stats['sources']++;
            try {
                $this->syncSource($source);
                $this->db->prepare("UPDATE calendar_sources SET last_error = NULL, last_synced_at = :now WHERE id = :id")
                    ->execute(['now' => gmdate('Y-m-d H:i:s'), 'id' => $source['id']]);
                $synced[] = (int) $source['id'];
            } catch (Throwable $e) {
                $this->stats['errors']++;
                $error = 'Calendar ' . $source['id'] . ': ' . self::shortError($e);
                error_log('Calendar sync: calendar ' . $source['id'] . ' failed: ' . self::shortError($e));
                $this->db->prepare("UPDATE calendar_sources SET last_error = :error WHERE id = :id")
                    ->execute(['error' => mb_substr(self::shortError($e), 0, 250), 'id' => $source['id']]);
            }
        }

        // The copies of shared appointments, once every calendar is current.
        if (CALENDAR_COPIES) {
            try {
                $copies = (new CalendarCopies(new CalendarStore($this->dav), $this))->reconcile($synced);
                $this->stats['copies'] += $copies['written'];
                if ($copies['errors'] > 0) {
                    $this->stats['errors'] += $copies['errors'];
                    $error = 'Copies: ' . $copies['error'];
                }
            } catch (Throwable $e) {
                $this->stats['errors']++;
                $error = 'Copies: ' . self::shortError($e);
                error_log('Calendar sync: copies failed: ' . self::shortError($e));
            }
        }

        self::storeSetting(self::SETTING_LAST_SYNC, gmdate('Y-m-d H:i:s'));
        self::storeSetting(self::SETTING_LAST_ERROR, $error);
        return $this->stats;
    }

    // =========================================================================
    // After the CRM wrote
    // =========================================================================

    /**
     * Keep an object the CRM has just written, exactly as the sync would
     * have stored it - the calendar shows it at once instead of after the
     * next run. The next run compares it with the server once more.
     */
    public function remember(int $sourceId, string $href, ?string $etag, string $ics): void
    {
        $stmt = $this->db->prepare("SELECT id FROM calendar_events WHERE source_id = :source AND href = :href");
        $stmt->execute(['source' => $sourceId, 'href' => $href]);
        $id = $stmt->fetchColumn();
        $this->writeEvent($sourceId, $href, (string) $etag, $ics, CalendarIcs::hash($ics), $id === false ? null : (int) $id, true);
    }

    /** Drop an object the CRM has just deleted. */
    public function forget(int $sourceId, string $href): void
    {
        $this->db->prepare("DELETE FROM calendar_events WHERE source_id = :source AND href = :href")
            ->execute(['source' => $sourceId, 'href' => $href]);
    }

    // =========================================================================
    // Discovery
    // =========================================================================

    /**
     * Pick up every calendar the shared account can see. New ones arrive
     * enabled, work calendars with details, private ones as "private". What
     * an admin set on known ones (kind, visibility, enabled) is left alone.
     */
    public function discover(): void
    {
        $found = $this->dav->discoverCalendars();
        $seen = [];

        foreach ($found as $calendar) {
            $seen[] = $calendar['href'];
            $existing = $this->db->prepare("SELECT id FROM calendar_sources WHERE href = :href");
            $existing->execute(['href' => $calendar['href']]);
            $id = $existing->fetchColumn();

            if ($id === false) {
                $this->db->prepare("
                    INSERT INTO calendar_sources (href, owner_email, display_name, kind, writable, visibility, enabled)
                    VALUES (:href, :owner, :name, :kind, :writable, :visibility, 1)
                ")->execute([
                    'href'       => $calendar['href'],
                    'owner'      => $calendar['owner_email'],
                    'name'       => $calendar['display_name'],
                    'kind'       => $calendar['kind'],
                    'writable'   => $calendar['writable'] ? 1 : 0,
                    'visibility' => $calendar['kind'] === 'work' ? 'details' : 'private',
                ]);
                $this->stats['discovered']++;
            } else {
                // Shared again after it had gone: switch it back on.
                $this->db->prepare("
                    UPDATE calendar_sources
                    SET owner_email = :owner, display_name = :name, writable = :writable,
                        enabled = CASE WHEN last_error = :missing THEN 1 ELSE enabled END,
                        last_error = CASE WHEN last_error = :missing2 THEN NULL ELSE last_error END,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = :id
                ")->execute([
                    'owner'    => $calendar['owner_email'],
                    'name'     => $calendar['display_name'],
                    'writable' => $calendar['writable'] ? 1 : 0,
                    'missing'  => self::NOT_SHARED,
                    'missing2' => self::NOT_SHARED,
                    'id'       => $id,
                ]);
            }
            $this->ensurePerson($calendar['owner_email']);
        }

        // A calendar no longer shared takes its cached appointments with it:
        // the owner withdrew access, so the CRM should not keep showing them.
        // It is switched off until it is shared again; one an admin switched
        // off on purpose stays as it was.
        $known = $this->db->query("SELECT id, href, enabled FROM calendar_sources")->fetchAll();
        foreach ($known as $source) {
            if (in_array($source['href'], $seen, true) || !$this->dav->serves((string) $source['href'])) {
                continue;
            }
            $this->db->prepare("DELETE FROM calendar_events WHERE source_id = :id")->execute(['id' => $source['id']]);
            if ((int) $source['enabled'] === 1) {
                $this->db->prepare("UPDATE calendar_sources SET enabled = 0, last_error = :missing, ctag = NULL, expanded_on = NULL WHERE id = :id")
                    ->execute(['missing' => self::NOT_SHARED, 'id' => $source['id']]);
            }
        }

        self::storeSetting(self::SETTING_LAST_DISCOVERY, gmdate('Y-m-d H:i:s'));
    }

    public const NOT_SHARED = 'Not shared with the calendar account any more';

    /** A person row for a calendar owner, linked to the CRM account with that address. */
    private function ensurePerson(string $email): void
    {
        $userStmt = $this->db->prepare("SELECT id, name FROM users WHERE email = :email COLLATE NOCASE");
        $userStmt->execute(['email' => $email]);
        $user = $userStmt->fetch() ?: null;

        $personStmt = $this->db->prepare("SELECT email, user_id FROM calendar_people WHERE email = :email");
        $personStmt->execute(['email' => $email]);
        $person = $personStmt->fetch();

        if ($person === false) {
            $count = (int) $this->db->query("SELECT COUNT(*) FROM calendar_people")->fetchColumn();
            $this->db->prepare("
                INSERT INTO calendar_people (email, user_id, name, color, position)
                VALUES (:email, :user_id, :name, :color, :position)
            ")->execute([
                'email'    => $email,
                'user_id'  => $user ? (int) $user['id'] : null,
                'name'     => $user ? (string) $user['name'] : self::nameFromEmail($email),
                'color'    => self::PALETTE[$count % count(self::PALETTE)],
                'position' => $count,
            ]);
        } elseif ($person['user_id'] === null && $user) {
            // The account was created after the calendar was first seen.
            $this->db->prepare("UPDATE calendar_people SET user_id = :user_id, updated_at = CURRENT_TIMESTAMP WHERE email = :email")
                ->execute(['user_id' => (int) $user['id'], 'email' => $email]);
        }
    }

    private function discoveryDue(): bool
    {
        if ((int) $this->db->query("SELECT COUNT(*) FROM calendar_sources")->fetchColumn() === 0) {
            return true;
        }
        $last = self::setting(self::SETTING_LAST_DISCOVERY);
        return $last === null || strtotime($last . ' UTC') < time() - 86400;
    }

    // =========================================================================
    // One calendar
    // =========================================================================

    private function syncSource(array $source): void
    {
        $sourceId = (int) $source['id'];
        $ctag = $this->dav->getCtag($source['href']);
        $expandDue = $source['expanded_on'] !== $this->today->format('Y-m-d');

        $recheckStmt = $this->db->prepare("SELECT COUNT(*) FROM calendar_events WHERE source_id = :id AND recheck = 1");
        $recheckStmt->execute(['id' => $sourceId]);
        $recheckDue = (int) $recheckStmt->fetchColumn() > 0;

        $this->stats['checked']++;
        if ($ctag !== null && $ctag === $source['ctag'] && !$recheckDue && !$expandDue) {
            return;
        }

        $remote = $this->dav->listEtags($source['href']);

        $localStmt = $this->db->prepare("SELECT id, href, etag, content_hash, recheck, archived FROM calendar_events WHERE source_id = :id");
        $localStmt->execute(['id' => $sourceId]);
        $local = [];
        foreach ($localStmt->fetchAll() as $row) {
            $local[$row['href']] = $row;
        }

        $toFetch = [];
        foreach ($remote as $href => $etag) {
            $row = $local[$href] ?? null;
            if ($row === null || $row['etag'] !== $etag || (int) $row['recheck'] === 1) {
                $toFetch[] = $href;
            }
        }

        $fetchedHrefs = [];
        if ($toFetch) {
            $objects = $this->dav->multiget($source['href'], $toFetch);
            foreach ($toFetch as $href) {
                if (!isset($objects[$href])) {
                    continue; // gone between listing and download: the next run sees it
                }
                $this->stats['fetched']++;
                $fetchedHrefs[$href] = true;
                $this->store($sourceId, $href, $objects[$href]['etag'] ?? $remote[$href], $objects[$href]['data'], $local[$href] ?? null);
            }
        }

        foreach (array_diff_key($local, $remote) as $row) {
            $this->db->prepare("DELETE FROM calendar_events WHERE id = :id")->execute(['id' => $row['id']]);
            $this->stats['removed']++;
        }

        if ($expandDue) {
            $this->reexpand($sourceId, $fetchedHrefs);
        }

        $this->db->prepare("UPDATE calendar_sources SET ctag = :ctag, expanded_on = :today WHERE id = :id")
            ->execute(['ctag' => $ctag, 'today' => $this->today->format('Y-m-d'), 'id' => $sourceId]);
    }

    /** Store one downloaded object and its occurrences. */
    private function store(int $sourceId, string $href, string $etag, string $ics, ?array $existing): void
    {
        $hash = CalendarIcs::hash($ics);

        if ($existing !== null && $existing['content_hash'] === $hash) {
            // Same content as before (a recheck, or the ETag moved on its
            // own): note the ETag, the second look is done.
            $this->db->prepare("UPDATE calendar_events SET etag = :etag, recheck = 0 WHERE id = :id")
                ->execute(['etag' => $etag, 'id' => $existing['id']]);
            return;
        }

        $this->writeEvent($sourceId, $href, $etag, $ics, $hash, $existing === null ? null : (int) $existing['id'], true);
        $this->stats['changed']++;
    }

    /**
     * Expand every stored object again: the window has moved, and what has
     * finished beyond the retention period loses its contents.
     */
    private function reexpand(int $sourceId, array $skipHrefs): void
    {
        $stmt = $this->db->prepare("SELECT id, href, etag, ics, content_hash FROM calendar_events WHERE source_id = :id AND archived = 0 AND ics IS NOT NULL");
        $stmt->execute(['id' => $sourceId]);
        foreach ($stmt->fetchAll() as $row) {
            if (isset($skipHrefs[$row['href']])) {
                continue;
            }
            $this->writeEvent($sourceId, $row['href'], (string) $row['etag'], (string) $row['ics'], (string) $row['content_hash'], (int) $row['id'], false);
        }
    }

    private function writeEvent(int $sourceId, string $href, string $etag, string $ics, string $hash, ?int $eventId, bool $changed): void
    {
        try {
            $parsed = CalendarIcs::read($ics, $this->windowStart, $this->windowEnd, $this->windowStart);
        } catch (Throwable $e) {
            // An object the library cannot read is skipped, not fatal. Logged
            // by calendar and position, without its contents.
            error_log('Calendar sync: calendar ' . $sourceId . ': unreadable object ' . basename($href) . ': ' . get_class($e));
            $this->stats['errors']++;
            return;
        }

        Database::transactional(function (PDO $db) use ($sourceId, $href, $etag, $ics, $hash, $eventId, $changed, $parsed) {
            if ($parsed === null) {
                // Not an appointment (a to-do, say): nothing to show.
                if ($eventId !== null) {
                    $db->prepare("DELETE FROM calendar_events WHERE id = :id")->execute(['id' => $eventId]);
                }
                return;
            }

            $archived = $parsed['archivable'];
            $master = $parsed['master'];
            $values = [
                'source_id'    => $sourceId,
                'href'         => $href,
                'etag'         => $etag,
                'content_hash' => $hash,
                'uid'          => $parsed['uid'],
                'ics'          => $archived ? null : $ics,
                'summary'      => $archived ? null : $master['summary'],
                'location'     => $archived ? null : $master['location'],
                'starts_at'    => $master['starts_at'],
                'ends_at'      => $master['ends_at'],
                'all_day'      => $master['all_day'] ? 1 : 0,
                'is_recurring' => $parsed['recurring'] ? 1 : 0,
                'organizer'    => $archived ? null : self::json($master['organizer']),
                'attendees'    => $archived ? null : self::json($master['attendees']),
                'status'       => $master['status'],
                'class'        => $master['class'],
                'sequence'     => $master['sequence'],
                'archived'     => $archived ? 1 : 0,
                'recheck'      => $changed ? 1 : 0,
            ];

            if ($eventId === null) {
                $db->prepare("
                    INSERT INTO calendar_events (source_id, href, etag, content_hash, uid, ics, summary, location, starts_at, ends_at,
                        all_day, is_recurring, organizer, attendees, status, class, sequence, archived, recheck, synced_at)
                    VALUES (:source_id, :href, :etag, :content_hash, :uid, :ics, :summary, :location, :starts_at, :ends_at,
                        :all_day, :is_recurring, :organizer, :attendees, :status, :class, :sequence, :archived, :recheck, CURRENT_TIMESTAMP)
                ")->execute($values);
                $eventId = (int) $db->lastInsertId();
            } else {
                $values['id'] = $eventId;
                unset($values['source_id'], $values['href']);
                $db->prepare("
                    UPDATE calendar_events SET etag = :etag, content_hash = :content_hash, uid = :uid, ics = :ics, summary = :summary,
                        location = :location, starts_at = :starts_at, ends_at = :ends_at, all_day = :all_day, is_recurring = :is_recurring,
                        organizer = :organizer, attendees = :attendees, status = :status, class = :class, sequence = :sequence,
                        archived = :archived, recheck = :recheck, synced_at = CURRENT_TIMESTAMP
                    WHERE id = :id
                ")->execute($values);
            }

            $db->prepare("DELETE FROM calendar_instances WHERE event_id = :id")->execute(['id' => $eventId]);
            if ($archived) {
                return;
            }

            $insert = $db->prepare("
                INSERT INTO calendar_instances (event_id, source_id, uid, recurrence_id, starts_at, ends_at, all_day, summary,
                    location, description, url, status, class, transparent, organizer, attendees)
                VALUES (:event_id, :source_id, :uid, :recurrence_id, :starts_at, :ends_at, :all_day, :summary,
                    :location, :description, :url, :status, :class, :transparent, :organizer, :attendees)
            ");
            foreach ($parsed['instances'] as $instance) {
                if ($instance['starts_at'] === null || $instance['ends_at'] === null) {
                    continue;
                }
                $insert->execute([
                    'event_id'      => $eventId,
                    'source_id'     => $sourceId,
                    'uid'           => $parsed['uid'],
                    'recurrence_id' => $instance['recurrence_id'],
                    'starts_at'     => $instance['starts_at'],
                    'ends_at'       => $instance['ends_at'],
                    'all_day'       => $instance['all_day'] ? 1 : 0,
                    'summary'       => $instance['summary'],
                    'location'      => $instance['location'],
                    'description'   => $instance['description'],
                    'url'           => $instance['url'],
                    'status'        => $instance['status'],
                    'class'         => $instance['class'],
                    'transparent'   => $instance['transparent'] ? 1 : 0,
                    'organizer'     => self::json($instance['organizer']),
                    'attendees'     => self::json($instance['attendees']),
                ]);
            }
        });
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private static function json($value): ?string
    {
        if ($value === null || $value === []) {
            return null;
        }
        return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    /** "vivian.loesch@x" -> "Vivian Loesch", until a CRM account supplies the real name. */
    private static function nameFromEmail(string $email): string
    {
        $local = (string) strstr($email, '@', true);
        return ucwords(str_replace(['.', '_', '-'], ' ', $local !== '' ? $local : $email));
    }

    /** An exception as one short line without any server body. */
    private static function shortError(Throwable $e): string
    {
        return mb_substr(preg_replace('/\s+/', ' ', $e->getMessage()) ?? '', 0, 200);
    }

    private static function setting(string $key): ?string
    {
        $stmt = Database::getInstance()->prepare("SELECT value FROM app_settings WHERE key = :key");
        $stmt->execute(['key' => $key]);
        $value = $stmt->fetchColumn();
        return $value === false || $value === null || $value === '' ? null : (string) $value;
    }

    private static function storeSetting(string $key, ?string $value): void
    {
        Database::getInstance()->prepare("
            INSERT INTO app_settings (key, value, updated_at) VALUES (:key, :value, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        ")->execute(['key' => $key, 'value' => $value]);
    }
}
