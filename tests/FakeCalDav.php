<?php
/**
 * A calendar server held in memory, for tests/calendar*.test.php
 *
 * Behaves like the mail server as phase 0 found it: CTags change with every
 * change, ETags are plain counters, If-Match does not exist, and a calendar
 * shared to read only refuses writes (HTTP 403).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

final class FakeCalDav implements CalDavSource
{
    public array $calendars = [];
    public array $objects = [];
    public array $ctags = [];
    public int $fetched = 0;
    public int $puts = 0;
    public int $deletes = 0;
    private int $counter = 0;

    public function addCalendar(string $href, string $owner, string $name, string $kind, bool $writable): void
    {
        $this->calendars[$href] = ['href' => $href, 'owner_email' => $owner, 'display_name' => $name, 'writable' => $writable, 'kind' => $kind];
        $this->objects[$href] = [];
        $this->ctags[$href] = 'ctag-0';
    }

    /** Somebody changes a calendar directly - on their phone, as it were. */
    public function put(string $collection, string $name, string $ics): void
    {
        $this->counter++;
        $this->objects[$collection][$collection . $name] = ['etag' => (string) $this->counter, 'data' => $ics];
        $this->ctags[$collection] = 'ctag-' . $this->counter;
    }

    public function delete(string $collection, string $name): void
    {
        $this->counter++;
        unset($this->objects[$collection][$collection . $name]);
        $this->ctags[$collection] = 'ctag-' . $this->counter;
    }

    /** The object at $href as stored, or null. */
    public function object(string $href): ?string
    {
        return $this->objects[self::collectionOf($href)][$href]['data'] ?? null;
    }

    public function discoverCalendars(): array
    {
        return array_values($this->calendars);
    }

    public function getCtag(string $collection): ?string
    {
        return $this->ctags[$collection] ?? null;
    }

    public function listEtags(string $collection): array
    {
        return array_map(static function (array $object): string {
            return $object['etag'];
        }, $this->objects[$collection] ?? []);
    }

    public function multiget(string $collection, array $paths): array
    {
        $this->fetched += count($paths);
        $found = [];
        foreach ($paths as $path) {
            if (isset($this->objects[$collection][$path])) {
                $found[$path] = $this->objects[$collection][$path];
            }
        }
        return $found;
    }

    public function serves(string $href): bool
    {
        return str_starts_with($href, '/');
    }

    public function getObject(string $href): ?array
    {
        return $this->objects[self::collectionOf($href)][$href] ?? null;
    }

    public function putObject(string $href, string $data): ?string
    {
        $collection = self::collectionOf($href);
        if (!isset($this->calendars[$collection])) {
            throw new CalDavException('PUT ' . $href . ' answered HTTP 404');
        }
        if (!$this->calendars[$collection]['writable']) {
            throw new CalDavException('PUT ' . $href . ' answered HTTP 403');
        }
        $this->counter++;
        $this->puts++;
        $this->objects[$collection][$href] = ['etag' => (string) $this->counter, 'data' => $data];
        $this->ctags[$collection] = 'ctag-' . $this->counter;
        return (string) $this->counter;
    }

    public function deleteObject(string $href): void
    {
        $collection = self::collectionOf($href);
        if (isset($this->calendars[$collection]) && !$this->calendars[$collection]['writable']) {
            throw new CalDavException('DELETE ' . $href . ' answered HTTP 403');
        }
        $this->counter++;
        $this->deletes++;
        unset($this->objects[$collection][$href]);
        $this->ctags[$collection] = 'ctag-' . $this->counter;
    }

    private static function collectionOf(string $href): string
    {
        return substr($href, 0, (int) strrpos($href, '/') + 1);
    }
}
