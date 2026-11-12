<?php
/**
 * CalDAV client for the team calendar
 *
 * Talks to the mail server's CalDAV service (cPanel cpdavd) as the shared
 * account from .env. What that server does and does not do was established in
 * Phase 0 (docs/kalender-phase0.md), and it shapes this class:
 *
 *   - The calendars the team shared appear in the shared account's calendar
 *     home, with their owners' own addresses - discovery reads that list.
 *   - There is no sync-collection (RFC 6578). Changes are found by the
 *     collection's CTag first, then by comparing every object's ETag.
 *   - If-Match / If-None-Match are ignored, so writes (phase 2) must compare
 *     ETags themselves. ETags are unquoted file times with one-second
 *     resolution; the sync allows for that.
 *
 * XML is read with DOM (libxml), never with string matching. Errors carry the
 * method and HTTP status only - no paths (they hold people's addresses) and
 * never the contents of an appointment; whoever logs them adds the calendar's
 * id.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

final class CalDavException extends RuntimeException
{
}

/**
 * What the sync needs from a calendar server. CalDavClient is the real one;
 * the tests (tests/calendar.test.php) stand in a server held in memory.
 */
interface CalDavSource
{
    /** @return list<array{href: string, owner_email: string, display_name: ?string, writable: bool, kind: string}> */
    public function discoverCalendars(): array;

    public function getCtag(string $collection): ?string;

    /** @return array<string, string> path => ETag */
    public function listEtags(string $collection): array;

    /** @return array<string, array{etag: ?string, data: string}> path => object */
    public function multiget(string $collection, array $paths): array;

    /**
     * Whether the calendar at $href lives on this server. The sync leaves
     * every other one alone - the made-up calendars of a local demo
     * (dev/seed-calendar-demo.php) are neither synced nor taken for gone.
     */
    public function serves(string $href): bool;

    /**
     * One object as it is now, or null when it is not there (any more).
     *
     * @return array{etag: ?string, data: string}|null
     */
    public function getObject(string $href): ?array;

    /**
     * Store an object, new or replacing. Returns its new ETag when the
     * server says it. The server ignores If-Match and If-None-Match (phase
     * 0), so whoever writes compares first (includes/CalendarEvents.php).
     */
    public function putObject(string $href, string $data): ?string;

    /** Remove an object; one that is already gone is fine. */
    public function deleteObject(string $href): void;
}

final class CalDavClient implements CalDavSource
{
    private const NS = [
        'd'  => 'DAV:',
        'c'  => 'urn:ietf:params:xml:ns:caldav',
        'cs' => 'http://calendarserver.org/ns/',
    ];

    /** Objects per calendar-multiget request. */
    private const MULTIGET_BATCH = 40;

    private string $base;
    private string $user;
    private string $password;

    public function __construct(string $base, string $user, string $password)
    {
        $this->base = rtrim($base, '/');
        $this->user = $user;
        $this->password = $password;
    }

    public static function fromConfig(): self
    {
        if (!calendarConfigured()) {
            throw new CalDavException('The calendar account is not configured in .env.');
        }
        return new self(CALDAV_BASE_URL, CALENDAR_ACCOUNT, CALENDAR_ACCOUNT_PASSWORD);
    }

    // =========================================================================
    // Discovery
    // =========================================================================

    /**
     * Every calendar the team shared with the account.
     *
     * The account's own collections are left out - nobody's appointments
     * live there.
     *
     * @return list<array{href: string, owner_email: string, display_name: ?string, writable: bool, kind: string}>
     */
    public function discoverCalendars(): array
    {
        $root = $this->propfind('/', '0', ['d:current-user-principal']);
        $principal = self::hrefs($root[0] ?? null, 'd:current-user-principal')[0] ?? '/principals/' . $this->user . '/';

        $principalProps = $this->propfind($principal, '0', ['c:calendar-home-set']);
        $home = self::hrefs($principalProps[0] ?? null, 'c:calendar-home-set')[0] ?? '/calendars/' . $this->user . '/';

        $entries = $this->propfind($home, '1', [
            'd:resourcetype', 'd:displayname', 'd:owner', 'd:current-user-privilege-set',
        ]);

        $calendars = [];
        foreach ($entries as $entry) {
            if (!in_array('calendar', self::childNames($entry, 'd:resourcetype'), true)) {
                continue;
            }
            $href = self::collectionPath($entry['href']);
            $owner = self::ownerEmail(self::hrefs($entry, 'd:owner')[0] ?? null, $href);
            if ($owner === null || strcasecmp($owner, $this->user) === 0) {
                continue;
            }
            $privileges = self::nestedNames($entry, 'd:current-user-privilege-set', 'privilege');
            $calendars[] = [
                'href'         => $href,
                'owner_email'  => strtolower($owner),
                'display_name' => self::text($entry, 'd:displayname'),
                'writable'     => self::canWrite($privileges),
                // Each person's default collection is their work calendar
                // ("Public"); any other one they shared is private. An admin
                // can change this in the settings.
                'kind'         => basename(rtrim($href, '/')) === 'calendar' ? 'work' : 'private',
            ];
        }
        return $calendars;
    }

    // =========================================================================
    // Change detection and download
    // =========================================================================

    /** Every calendar of this server sits at an absolute path. */
    public function serves(string $href): bool
    {
        return str_starts_with($href, '/');
    }

    /** The collection's CTag, which changes whenever anything in it does. */
    public function getCtag(string $collection): ?string
    {
        $entries = $this->propfind(self::collectionPath($collection), '0', ['cs:getctag']);
        return self::text($entries[0] ?? null, 'cs:getctag');
    }

    /**
     * Every object in a collection with its ETag.
     *
     * @return array<string, string> path => ETag
     */
    public function listEtags(string $collection): array
    {
        $collection = self::collectionPath($collection);
        $etags = [];
        foreach ($this->propfind($collection, '1', ['d:getetag']) as $entry) {
            $path = self::path($entry['href']);
            if (rtrim($path, '/') === rtrim($collection, '/')) {
                continue;
            }
            $etag = self::text($entry, 'd:getetag');
            if ($etag !== null && $etag !== '') {
                $etags[$path] = $etag;
            }
        }
        return $etags;
    }

    /**
     * Download objects by path, in batches.
     *
     * @param list<string> $paths
     * @return array<string, array{etag: ?string, data: string}> path => object
     */
    public function multiget(string $collection, array $paths): array
    {
        $collection = self::collectionPath($collection);
        $objects = [];
        foreach (array_chunk(array_values($paths), self::MULTIGET_BATCH) as $batch) {
            $xml = '<?xml version="1.0" encoding="utf-8"?>'
                . '<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                . '<d:prop><d:getetag/><c:calendar-data/></d:prop>';
            foreach ($batch as $path) {
                $xml .= '<d:href>' . htmlspecialchars($path, ENT_XML1 | ENT_QUOTES, 'UTF-8') . '</d:href>';
            }
            $xml .= '</c:calendar-multiget>';

            $response = $this->request('REPORT', $collection, ['Depth: 1', 'Content-Type: application/xml; charset=utf-8'], $xml);
            if ($response['status'] !== 207) {
                throw new CalDavException('calendar-multiget answered HTTP ' . $response['status']);
            }
            foreach (self::parseMultistatus($response['body']) as $entry) {
                $data = self::text($entry, 'c:calendar-data', false);
                if ($data !== null && $data !== '') {
                    $objects[self::path($entry['href'])] = ['etag' => self::text($entry, 'd:getetag'), 'data' => $data];
                }
            }
        }
        return $objects;
    }

    // =========================================================================
    // Single objects (phase 2: writing)
    // =========================================================================

    public function getObject(string $href): ?array
    {
        $path = self::path($href);
        $response = $this->request('GET', $path, ['Accept: text/calendar']);
        if ($response['status'] === 404 || $response['status'] === 410) {
            return null;
        }
        if ($response['status'] !== 200) {
            throw new CalDavException('GET answered HTTP ' . $response['status']);
        }
        return ['etag' => self::etagHeader($response['headers']), 'data' => $response['body']];
    }

    public function putObject(string $href, string $data): ?string
    {
        $path = self::path($href);
        $response = $this->request('PUT', $path, ['Content-Type: text/calendar; charset=utf-8'], $data);
        if (!in_array($response['status'], [200, 201, 204], true)) {
            throw new CalDavException('PUT answered HTTP ' . $response['status']);
        }
        return self::etagHeader($response['headers']);
    }

    public function deleteObject(string $href): void
    {
        $path = self::path($href);
        $response = $this->request('DELETE', $path, []);
        if (!in_array($response['status'], [200, 204, 404, 410], true)) {
            throw new CalDavException('DELETE answered HTTP ' . $response['status']);
        }
    }

    /** An ETag header as the server lists them in PROPFIND: unquoted, no W/. */
    private static function etagHeader(array $headers): ?string
    {
        $etag = trim((string) ($headers['etag'] ?? ''));
        if (stripos($etag, 'W/') === 0) {
            $etag = substr($etag, 2);
        }
        $etag = trim($etag, " \"");
        return $etag === '' ? null : $etag;
    }

    // =========================================================================
    // HTTP and XML
    // =========================================================================

    /** @return list<array{href: string, status: string, props: array}> */
    private function propfind(string $path, string $depth, array $props): array
    {
        $xml = '<?xml version="1.0" encoding="utf-8"?>'
            . '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop>';
        foreach ($props as $prop) {
            $xml .= '<' . $prop . '/>';
        }
        $xml .= '</d:prop></d:propfind>';

        $response = $this->request('PROPFIND', $path, ['Depth: ' . $depth, 'Content-Type: application/xml; charset=utf-8'], $xml);
        if ($response['status'] === 401) {
            throw new CalDavException('The calendar server refused the shared account (HTTP 401).');
        }
        if ($response['status'] !== 207) {
            throw new CalDavException('PROPFIND answered HTTP ' . $response['status']);
        }
        return self::parseMultistatus($response['body']);
    }

    /** @return array{status: int, body: string, headers: array<string, string>} */
    private function request(string $method, string $path, array $headers, ?string $body = null): array
    {
        $responseHeaders = [];
        $handle = curl_init($this->base . '/' . ltrim(self::encodePath($path), '/'));
        $options = [
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$responseHeaders): int {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPAUTH       => CURLAUTH_BASIC,
            CURLOPT_USERNAME       => $this->user,
            CURLOPT_PASSWORD       => $this->password,
            // "Expect:" stops curl from waiting for a 100 Continue on large bodies.
            CURLOPT_HTTPHEADER     => array_merge(['User-Agent: DisinfoCRM-Calendar/1', 'Expect:'], $headers),
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT        => 60,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ];
        if ($body !== null) {
            $options[CURLOPT_POSTFIELDS] = $body;
        }
        curl_setopt_array($handle, $options);

        $responseBody = curl_exec($handle);
        if ($responseBody === false) {
            throw new CalDavException($method . ' failed: ' . curl_error($handle));
        }
        return [
            'status'  => (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE),
            'body'    => (string) $responseBody,
            'headers' => $responseHeaders,
        ];
    }

    /**
     * A decoded path as the URL needs it: what may stand in a path stays as
     * it is ("@" included), anything else is percent-encoded.
     */
    private static function encodePath(string $path): string
    {
        return (string) preg_replace_callback("#[^A-Za-z0-9\\-._~!$&'()*+,;=:@/]#u", static function (array $m): string {
            return rawurlencode($m[0]);
        }, $path);
    }

    /** @return list<array{href: string, status: string, props: array<string, array{status: string, el: DOMElement}>}> */
    private static function parseMultistatus(string $xml): array
    {
        $doc = new DOMDocument();
        // LIBXML_NONET: never fetch anything a document points at.
        if ($xml === '' || !@$doc->loadXML($xml, LIBXML_NONET)) {
            throw new CalDavException('The calendar server sent a response that is not valid XML.');
        }
        $xp = new DOMXPath($doc);
        $xp->registerNamespace('d', self::NS['d']);

        $entries = [];
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
            $entries[] = $entry;
        }
        return $entries;
    }

    private static function prop(?array $entry, string $qname): ?DOMElement
    {
        if ($entry === null) {
            return null;
        }
        [$prefix, $local] = explode(':', $qname, 2);
        $prop = $entry['props'][self::NS[$prefix] . '|' . $local] ?? null;
        if ($prop === null || strpos($prop['status'], ' 200') === false) {
            return null;
        }
        return $prop['el'];
    }

    private static function text(?array $entry, string $qname, bool $trim = true): ?string
    {
        $el = self::prop($entry, $qname);
        if ($el === null) {
            return null;
        }
        return $trim ? trim($el->textContent) : $el->textContent;
    }

    /** @return list<string> */
    private static function hrefs(?array $entry, string $qname): array
    {
        $el = self::prop($entry, $qname);
        $hrefs = [];
        if ($el !== null) {
            foreach ($el->getElementsByTagNameNS(self::NS['d'], 'href') as $href) {
                $hrefs[] = trim($href->textContent);
            }
        }
        return $hrefs;
    }

    /** @return list<string> */
    private static function childNames(?array $entry, string $qname): array
    {
        $el = self::prop($entry, $qname);
        $names = [];
        if ($el !== null) {
            foreach ($el->childNodes as $child) {
                if ($child instanceof DOMElement) {
                    $names[] = $child->localName;
                }
            }
        }
        return $names;
    }

    /** @return list<string> Local names inside every d:$wrapper (privileges). */
    private static function nestedNames(?array $entry, string $qname, string $wrapper): array
    {
        $el = self::prop($entry, $qname);
        $names = [];
        if ($el !== null) {
            foreach ($el->getElementsByTagNameNS(self::NS['d'], $wrapper) as $node) {
                foreach ($node->childNodes as $child) {
                    if ($child instanceof DOMElement) {
                        $names[] = $child->localName;
                    }
                }
            }
        }
        return array_values(array_unique($names));
    }

    private static function canWrite(array $privileges): bool
    {
        return in_array('all', $privileges, true)
            || in_array('write', $privileges, true)
            || (in_array('write-content', $privileges, true) && in_array('bind', $privileges, true));
    }

    /** The owner's address from their principal URL, else from the calendar's own path. */
    private static function ownerEmail(?string $ownerHref, string $calendarHref): ?string
    {
        foreach ([[$ownerHref, '#/principals/([^/]+@[^/]+)/?#'], [$calendarHref, '#/calendars/([^/]+@[^/]+)/#']] as [$href, $pattern]) {
            if ($href !== null && preg_match($pattern, self::path($href), $m)) {
                return $m[1];
            }
        }
        return null;
    }

    /** A server href as a decoded path, whether it came absolute or not. */
    public static function path(string $href): string
    {
        $path = preg_match('#^https?://#i', $href) ? (string) parse_url($href, PHP_URL_PATH) : $href;
        return rawurldecode($path);
    }

    public static function collectionPath(string $href): string
    {
        return rtrim(self::path($href), '/') . '/';
    }
}
