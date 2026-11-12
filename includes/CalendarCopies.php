<?php
/**
 * Copies of shared appointments (spec, section 4)
 *
 * The mail server does not hand an appointment to the team members in it,
 * so the CRM does: the original sits in the organizer's work calendar, and
 * every other team member taking part gets a copy in theirs - same UID,
 * same ORGANIZER and attendee list. The team view shows them once (by UID).
 *
 * Kept in step two ways:
 *   - When the CRM changes an appointment it writes the copies right away
 *     (push), after taking in the answers people gave on their phones
 *     (mergeAnswers).
 *   - After every sync (reconcile): an answer given in a copy goes into the
 *     original; a copy deleted on the phone counts as declined; any other
 *     change to a copy is overwritten by the original (logged, IDs only); an
 *     appointment made on a phone with team members in it gets its copies;
 *     copies of an appointment that is gone, or that no longer has their
 *     owner in it, go too.
 *
 * Nothing is ever copied from a made-up (local demo) calendar into a real
 * one (CalendarStore::mayCopy), and a sync run writes at most MAX_WRITES
 * objects - a safety net should anything ever start to go back and forth.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

require_once APP_ROOT . '/includes/CalendarStore.php';
require_once APP_ROOT . '/includes/CalendarIcs.php';
require_once APP_ROOT . '/includes/CalendarIcsWriter.php';

final class CalendarCopies
{
    private const MAX_WRITES = 40;

    private CalendarStore $store;
    private CalendarSync $cache;
    private PDO $db;
    private int $written = 0;

    public function __construct(CalendarStore $store, CalendarSync $cache)
    {
        $this->store = $store;
        $this->cache = $cache;
        $this->db = Database::getInstance();
    }

    /** Where a copy of $uid goes in a calendar: its UID as the file name, when that is a safe one. */
    public static function hrefFor(string $collection, string $uid): string
    {
        $name = preg_match('/^[A-Za-z0-9._-]{1,120}$/', $uid)
            ? $uid
            : substr((string) preg_replace('/[^A-Za-z0-9._-]+/', '-', $uid), 0, 60) . '-' . substr(sha1($uid), 0, 10);
        return rtrim($collection, '/') . '/' . $name . '.ics';
    }

    // =========================================================================
    // When the CRM writes an original
    // =========================================================================

    /** Answers given in the copies (on a phone) that the original does not have yet. */
    public function mergeAnswers(string $uid, string $ics, string $organizer): string
    {
        $work = $this->workCalendars();
        foreach (CalendarIcsWriter::people($ics)['attendees'] as $email => $partstat) {
            if ($email === $organizer || !isset($work[$email])) {
                continue;
            }
            $copy = $this->copyIn($work[$email], $uid);
            if ($copy === null) {
                continue;
            }
            try {
                $fresh = $this->store->get((string) $copy['href']);
            } catch (Throwable $e) {
                continue; // that copy's answer waits for the next sync
            }
            $answer = $fresh === null ? null : CalendarIcsWriter::partstat($fresh['data'], $email);
            if ($answer !== null && $answer !== $partstat) {
                $ics = CalendarIcsWriter::setPartstat($ics, $email, $answer);
            }
        }
        return $ics;
    }

    /**
     * Write $ics as the copy of every team member taking part and take away
     * the copies of those who no longer are. A person who deleted their copy
     * on the phone gets none again - unless listed in $reactivate (they have
     * just accepted in the CRM).
     *
     * @param string $originalHref where the original is (decides mayCopy)
     * @return list<string> what could not be done, said for the person writing
     */
    public function push(string $uid, string $ics, string $organizer, string $originalHref, array $reactivate = []): array
    {
        $warnings = [];
        $work = $this->workCalendars();
        $names = $this->names();
        $taking = array_values(array_diff(array_keys(CalendarIcsWriter::people($ics)['attendees']), [$organizer]));
        $records = $this->records($uid);

        foreach ($work as $email => $source) {
            if ($email === $organizer) {
                continue;
            }
            $record = $records[$email] ?? null;
            $copy = $this->copyIn($source, $uid);
            $name = $names[$email] ?? $email;

            if (!in_array($email, $taking, true)) {
                if ($copy !== null && $record !== null) {
                    try {
                        $this->remove($source, (string) $copy['href']);
                        $this->dropRecord($uid, $email);
                    } catch (Throwable $e) {
                        $warnings[] = $name . "'s copy could not be removed; the next sync tries again.";
                    }
                }
                continue;
            }
            if ($record !== null && $record['state'] === 'removed' && !in_array($email, $reactivate, true)) {
                continue;
            }
            if (!$this->store->mayCopy($originalHref, (string) $source['href'])) {
                $warnings[] = $this->store->isLocal($originalHref)
                    ? $name . ' gets no copy: this is a made-up test calendar.'
                    : $name . "'s calendar cannot be reached from here.";
                continue;
            }
            if ((int) $source['writable'] !== 1) {
                $warnings[] = $name . ' has shared the work calendar to read only, so the appointment is not in it. Sharing it to read and write fixes that.';
                continue;
            }
            $href = $copy !== null ? (string) $copy['href'] : ($record['href'] ?? self::hrefFor((string) $source['href'], $uid));
            try {
                $this->write($source, $href, $ics);
                $this->record($uid, $email, $href);
            } catch (Throwable $e) {
                error_log('Calendar copies: writing to calendar ' . $source['id'] . ' failed: ' . self::short($e));
                $warnings[] = $name . "'s copy could not be written; the next sync tries again.";
            }
        }

        $team = $this->teamEmails();
        foreach ($taking as $email) {
            if (in_array($email, $team, true) && !isset($work[$email])) {
                $warnings[] = ($names[$email] ?? $email) . ' has not shared a work calendar with the calendar account, so the appointment is not on their phone.';
            }
        }
        return $warnings;
    }

    /** The appointment was cancelled: every copy goes. */
    public function removeAll(string $uid, string $organizer): array
    {
        $warnings = [];
        $records = $this->records($uid);
        foreach ($this->workCalendars() as $email => $source) {
            if ($email === $organizer) {
                continue;
            }
            $copy = $this->copyIn($source, $uid);
            if ($copy === null) {
                continue;
            }
            // Only copies of this organizer's appointment, never somebody's own.
            $people = CalendarIcsWriter::people((string) $copy['ics']);
            if ($people['organizer'] !== $organizer && !isset($records[$email])) {
                continue;
            }
            try {
                $this->remove($source, (string) $copy['href']);
            } catch (Throwable $e) {
                $warnings[] = 'A copy could not be removed; the next sync tries again.';
            }
        }
        $this->db->prepare("DELETE FROM calendar_copies WHERE uid = :uid")->execute(['uid' => $uid]);
        return $warnings;
    }

    // =========================================================================
    // After a sync
    // =========================================================================

    /**
     * Bring every shared appointment's copies in line with its original.
     * $synced: the calendars this run brought up to date. Only there does a
     * missing copy or original mean that it was deleted.
     *
     * @param list<int> $synced
     * @return array{written: int, errors: int, error: ?string}
     */
    public function reconcile(array $synced): array
    {
        $errors = 0;
        $error = null;
        $work = $this->workCalendars();

        // Originals: in a team member's work calendar, organized by them.
        $rows = $this->db->query("
            SELECT e.id, e.uid, e.href, e.ics, e.content_hash, e.organizer, e.source_id, s.owner_email
            FROM calendar_events e
            JOIN calendar_sources s ON s.id = e.source_id
            WHERE s.enabled = 1 AND s.kind = 'work' AND e.archived = 0 AND e.ics IS NOT NULL AND e.organizer IS NOT NULL
            ORDER BY e.id
        ")->fetchAll();
        $originals = [];
        foreach ($rows as $row) {
            $organizer = strtolower((string) (json_decode((string) $row['organizer'], true)['email'] ?? ''));
            $owner = strtolower((string) $row['owner_email']);
            if ($organizer !== '' && $organizer === $owner && isset($work[$owner]) && (int) $work[$owner]['id'] === (int) $row['source_id']) {
                $originals[(string) $row['uid']] = $row;
            }
        }

        foreach ($originals as $uid => $original) {
            if ($this->written >= self::MAX_WRITES) {
                break;
            }
            try {
                $this->reconcileOne((string) $uid, $original, $work, $synced);
            } catch (Throwable $e) {
                $errors++;
                $error = self::short($e);
                error_log('Calendar copies: appointment in calendar ' . $original['source_id'] . ' failed: ' . self::short($e));
            }
        }

        // Copies whose original is gone, or no longer shared with anyone.
        $records = $this->db->query("SELECT * FROM calendar_copies WHERE state = 'active'")->fetchAll();
        foreach ($records as $record) {
            if (isset($originals[$record['uid']]) || $this->written >= self::MAX_WRITES) {
                continue;
            }
            try {
                $source = $work[strtolower((string) $record['email'])] ?? null;
                $copy = $source !== null ? $this->copyIn($source, (string) $record['uid']) : null;
                if ($copy === null) {
                    if ($source !== null && in_array((int) $source['id'], $synced, true)) {
                        $this->dropRecord((string) $record['uid'], (string) $record['email']);
                    }
                    continue;
                }
                $organizer = CalendarIcsWriter::people((string) $copy['ics'])['organizer'];
                $organizerSource = $organizer !== null ? ($work[$organizer] ?? null) : null;
                // Only when the organizer's calendar is current can its
                // silence be trusted.
                if ($organizerSource === null || !in_array((int) $organizerSource['id'], $synced, true)) {
                    continue;
                }
                $this->remove($source, (string) $copy['href']);
                $this->dropRecord((string) $record['uid'], (string) $record['email']);
            } catch (Throwable $e) {
                $errors++;
                $error = self::short($e);
            }
        }

        return ['written' => $this->written, 'errors' => $errors, 'error' => $error];
    }

    private function reconcileOne(string $uid, array $original, array $work, array $synced): void
    {
        $organizer = strtolower((string) $original['owner_email']);
        $originalSource = $work[$organizer];
        $ics = (string) $original['ics'];
        $people = CalendarIcsWriter::people($ics);
        $records = $this->records($uid);

        // 1. Answers: given in a copy on a phone - or the copy deleted there,
        // which is declining.
        $answers = [];
        foreach ($people['attendees'] as $email => $partstat) {
            if ($email === $organizer || !isset($work[$email])) {
                continue;
            }
            $source = $work[$email];
            $copy = $this->copyIn($source, $uid);
            $record = $records[$email] ?? null;
            if ($copy !== null) {
                $answer = CalendarIcsWriter::partstat((string) $copy['ics'], $email);
                if ($answer !== null && $answer !== $partstat) {
                    $answers[$email] = $answer;
                }
            } elseif ($record !== null && $record['state'] === 'active' && in_array((int) $source['id'], $synced, true)) {
                $answers[$email] = 'DECLINED';
                $this->markRemoved($uid, $email);
                $records[$email]['state'] = 'removed';
            }
        }
        if ($answers && (int) $originalSource['writable'] === 1 && $this->store->reaches((string) $originalSource['href'])) {
            // Written onto the original as it is now; if it changed since
            // this run read it, the next run takes over.
            $fresh = $this->store->get((string) $original['href']);
            if ($fresh === null || CalendarIcs::hash($fresh['data']) !== $original['content_hash']) {
                return;
            }
            foreach ($answers as $email => $answer) {
                $ics = CalendarIcsWriter::setPartstat($ics, $email, $answer);
            }
            $this->write($originalSource, (string) $original['href'], $ics);
        }

        // 2. The copies say what the original says.
        $fingerprint = CalendarIcsWriter::fingerprint($ics);
        $taking = array_diff(array_keys($people['attendees']), [$organizer]);
        foreach ($work as $email => $source) {
            if ($email === $organizer || $this->written >= self::MAX_WRITES) {
                continue;
            }
            $record = $records[$email] ?? null;
            $copy = $this->copyIn($source, $uid);
            if (!in_array($email, $taking, true)) {
                if ($copy !== null && $record !== null) {
                    $this->remove($source, (string) $copy['href']);
                    $this->dropRecord($uid, $email);
                }
                continue;
            }
            if (($record !== null && $record['state'] === 'removed')
                || (int) $source['writable'] !== 1
                || !$this->store->mayCopy((string) $original['href'], (string) $source['href'])) {
                continue;
            }
            if ($copy === null) {
                if ($record === null) {
                    // Made on a phone with this person in it: their copy.
                    $href = self::hrefFor((string) $source['href'], $uid);
                    $this->write($source, $href, $ics);
                    $this->record($uid, $email, $href);
                }
                continue;
            }
            if ($record === null) {
                $this->record($uid, $email, (string) $copy['href']);
            }
            if (CalendarIcsWriter::fingerprint((string) $copy['ics']) === $fingerprint) {
                continue;
            }
            // Overwritten with the original - unless it changed meanwhile.
            $fresh = $this->store->get((string) $copy['href']);
            if ($fresh !== null && CalendarIcs::hash($fresh['data']) !== $copy['content_hash']) {
                continue;
            }
            $this->write($source, (string) $copy['href'], $ics);
            error_log('Calendar copies: the copy in calendar ' . $source['id'] . ' was updated from its original in calendar ' . $originalSource['id']);
        }
    }

    // =========================================================================

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

    /** @return list<string> */
    private function teamEmails(): array
    {
        return array_map('strtolower', $this->db->query("SELECT email FROM calendar_people")->fetchAll(PDO::FETCH_COLUMN));
    }

    /** @return array<string, string> */
    private function names(): array
    {
        $names = [];
        foreach ($this->db->query("SELECT email, name FROM calendar_people")->fetchAll() as $row) {
            $names[strtolower((string) $row['email'])] = (string) ($row['name'] ?: $row['email']);
        }
        return $names;
    }

    private function copyIn(array $source, string $uid): ?array
    {
        $stmt = $this->db->prepare("
            SELECT id, href, ics, content_hash FROM calendar_events
            WHERE source_id = :source AND uid = :uid AND archived = 0 AND ics IS NOT NULL
            ORDER BY id LIMIT 1
        ");
        $stmt->execute(['source' => $source['id'], 'uid' => $uid]);
        return $stmt->fetch() ?: null;
    }

    /** @return array<string, array> address => row */
    private function records(string $uid): array
    {
        $stmt = $this->db->prepare("SELECT * FROM calendar_copies WHERE uid = :uid");
        $stmt->execute(['uid' => $uid]);
        $records = [];
        foreach ($stmt->fetchAll() as $row) {
            $records[strtolower((string) $row['email'])] = $row;
        }
        return $records;
    }

    private function record(string $uid, string $email, string $href): void
    {
        $this->db->prepare("
            INSERT INTO calendar_copies (uid, email, href, state) VALUES (:uid, :email, :href, 'active')
            ON CONFLICT(uid, email) DO UPDATE SET href = excluded.href, state = 'active', updated_at = CURRENT_TIMESTAMP
        ")->execute(['uid' => $uid, 'email' => $email, 'href' => $href]);
    }

    private function markRemoved(string $uid, string $email): void
    {
        $this->db->prepare("UPDATE calendar_copies SET state = 'removed', updated_at = CURRENT_TIMESTAMP WHERE uid = :uid AND email = :email")
            ->execute(['uid' => $uid, 'email' => $email]);
    }

    private function dropRecord(string $uid, string $email): void
    {
        $this->db->prepare("DELETE FROM calendar_copies WHERE uid = :uid AND email = :email")->execute(['uid' => $uid, 'email' => $email]);
    }

    private function write(array $source, string $href, string $ics): void
    {
        $etag = $this->store->put($href, $ics);
        $this->cache->remember((int) $source['id'], $href, $etag, $ics);
        $this->written++;
    }

    private function remove(array $source, string $href): void
    {
        $this->store->delete($href);
        $this->cache->forget((int) $source['id'], $href);
        $this->written++;
    }

    private static function short(Throwable $e): string
    {
        return mb_substr(preg_replace('/\s+/', ' ', $e->getMessage()) ?? '', 0, 200);
    }
}
