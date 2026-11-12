<?php
/**
 * Where an appointment is written
 *
 * The team's calendars live on the mail server (CalDavClient). The made-up
 * calendars of a local demo (dev/seed-calendar-demo.php, addresses starting
 * with "demo:") live only in this database. CalendarStore sends every read
 * and write to the right one, so creating, moving and sharing appointments
 * works the same on a local copy as against the real server.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

require_once APP_ROOT . '/includes/CalDavClient.php';

/**
 * Calendars that exist only in the cache. Reading one reads the cache;
 * writing one is the cache update that follows every write anyway. They are
 * never synced - listing them is refused, so a sync pointed here by mistake
 * cannot empty them.
 */
final class LocalCalendars implements CalDavSource
{
    public function serves(string $href): bool
    {
        return str_starts_with($href, 'demo:');
    }

    public function discoverCalendars(): array
    {
        return [];
    }

    public function getCtag(string $collection): ?string
    {
        return null;
    }

    public function listEtags(string $collection): array
    {
        throw new LogicException('Local calendars are not synced.');
    }

    public function multiget(string $collection, array $paths): array
    {
        throw new LogicException('Local calendars are not synced.');
    }

    public function getObject(string $href): ?array
    {
        $stmt = Database::getInstance()->prepare("SELECT etag, ics FROM calendar_events WHERE href = :href AND ics IS NOT NULL");
        $stmt->execute(['href' => $href]);
        $row = $stmt->fetch();
        return $row ? ['etag' => $row['etag'], 'data' => (string) $row['ics']] : null;
    }

    public function putObject(string $href, string $data): ?string
    {
        return 'local-' . substr(hash('sha256', $data), 0, 16);
    }

    public function deleteObject(string $href): void
    {
        // The cache update after the write removes it.
    }
}

final class CalendarStore
{
    private ?CalDavSource $server;
    private LocalCalendars $local;

    public function __construct(?CalDavSource $server)
    {
        $this->server = $server;
        $this->local = new LocalCalendars();
    }

    public static function fromConfig(): self
    {
        return new self(calendarConfigured() ? CalDavClient::fromConfig() : null);
    }

    /** The mail server, or the local calendars when there is none. */
    public function server(): CalDavSource
    {
        return $this->server ?? $this->local;
    }

    /** Whether a calendar at $href can be written at all. */
    public function reaches(string $href): bool
    {
        return $this->local->serves($href) || ($this->server !== null && $this->server->serves($href));
    }

    /** A calendar that exists only in this database (a local demo's). */
    public function isLocal(string $href): bool
    {
        return $this->local->serves($href);
    }

    /**
     * Whether what is in the calendar at $from may be copied into the one at
     * $to: never from a made-up calendar into a real one, so a local demo
     * cannot put its appointments on anybody's phone.
     */
    public function mayCopy(string $from, string $to): bool
    {
        return $this->reaches($to) && (!$this->isLocal($from) || $this->isLocal($to));
    }

    public function get(string $href): ?array
    {
        return $this->source($href)->getObject($href);
    }

    public function put(string $href, string $data): ?string
    {
        return $this->source($href)->putObject($href, $data);
    }

    public function delete(string $href): void
    {
        $this->source($href)->deleteObject($href);
    }

    private function source(string $href): CalDavSource
    {
        if ($this->local->serves($href)) {
            return $this->local;
        }
        if ($this->server !== null && $this->server->serves($href)) {
            return $this->server;
        }
        throw new CalDavException('This calendar cannot be reached from here.');
    }
}
