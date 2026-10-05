<?php
/**
 * Links on a to-do.
 *
 * Mostly Google Drive documents, so a link knows what kind of Google file it
 * points to and tries to learn the document's name when it is added. Any other
 * web address works too; it is simply shown by its host.
 *
 * Links belong to the master to-do (parent_todo_id IS NULL). A to-do mirrored
 * onto a project's contacts is one piece of work, so its copies share them.
 */
class TodoLink
{
    public const MAX_URL_LENGTH = 2000;
    public const MAX_TITLE_LENGTH = 255;

    /** Hosts whose pages may be fetched to read a document's name. */
    private const TITLE_HOSTS = ['docs.google.com', 'drive.google.com'];

    /**
     * The URL, trimmed, if it is a usable http(s) address - or null.
     */
    public static function normalizeUrl(?string $url): ?string
    {
        $url = trim((string) $url);
        if ($url === '' || strlen($url) > self::MAX_URL_LENGTH) {
            return null;
        }

        // A pasted address without a scheme ("docs.google.com/...") is meant as https.
        if (!preg_match('~^[a-z][a-z0-9+.-]*://~i', $url)) {
            $url = 'https://' . $url;
        }

        $parts = parse_url($url);
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        if (!in_array($scheme, ['http', 'https'], true) || empty($parts['host'])) {
            return null;
        }

        return filter_var($url, FILTER_VALIDATE_URL) !== false ? $url : null;
    }

    /**
     * What a link points to: doc, sheet, slides, form, folder, drive (any
     * other Drive file) or web.
     */
    public static function kind(string $url): string
    {
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        $path = (string) parse_url($url, PHP_URL_PATH);

        if ($host === 'docs.google.com') {
            if (str_starts_with($path, '/document/')) return 'doc';
            if (str_starts_with($path, '/spreadsheets/')) return 'sheet';
            if (str_starts_with($path, '/presentation/')) return 'slides';
            if (str_starts_with($path, '/forms/')) return 'form';
            return 'drive';
        }

        if ($host === 'drive.google.com') {
            return str_contains($path, '/folders/') ? 'folder' : 'drive';
        }

        return 'web';
    }

    /** A readable name for a link whose own name is unknown. */
    public static function fallbackTitle(string $url): string
    {
        switch (self::kind($url)) {
            case 'doc': return 'Google Doc';
            case 'sheet': return 'Google Sheet';
            case 'slides': return 'Google Slides';
            case 'form': return 'Google Form';
            case 'folder': return 'Drive folder';
            case 'drive': return 'Drive file';
        }

        $host = (string) parse_url($url, PHP_URL_HOST);
        return preg_replace('/^www\./i', '', $host) ?: $url;
    }

    /**
     * The document's name as Google shows it, or null.
     *
     * Only works for documents shared with "anyone with the link": a private
     * one answers with a redirect to the sign-in page, which is not followed.
     * Only Google's document hosts are ever contacted, so a link cannot make
     * the server fetch an arbitrary address.
     */
    public static function fetchTitle(string $url): ?string
    {
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        if (!in_array($host, self::TITLE_HOSTS, true) || strtolower((string) parse_url($url, PHP_URL_SCHEME)) !== 'https') {
            return null;
        }
        if (!function_exists('curl_init')) {
            return null;
        }

        $html = '';
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_TIMEOUT => 5,
            CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; CRM link preview)',
            CURLOPT_HTTPHEADER => ['Accept-Language: de,en;q=0.8'],
            // The title is near the top; stop reading after 256 KB.
            CURLOPT_WRITEFUNCTION => function ($handle, $chunk) use (&$html) {
                $html .= $chunk;
                return strlen($html) > 262144 ? 0 : strlen($chunk);
            },
        ]);
        curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        unset($curl);

        if ($status !== 200 || !preg_match('~<title[^>]*>(.*?)</title>~is', $html, $match)) {
            return null;
        }

        $title = trim(html_entity_decode(strip_tags($match[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        // "Angebot 2026 - Google Docs" -> "Angebot 2026"
        $title = trim((string) preg_replace('/\s+[-–]\s+Google\s+(Docs|Sheets|Slides|Forms|Drive|Tabellen|Präsentationen|Formulare|Dokumente|Notizen)$/iu', '', $title));

        // What Google shows instead of a document: no name to learn.
        if ($title === '' || preg_match('/^(Google (Docs|Drive|Sheets|Slides|Tabellen|Präsentationen)|Sign[- ]in|Anmelden|Meet Google Drive)/iu', $title)) {
            return null;
        }

        return mb_substr($title, 0, self::MAX_TITLE_LENGTH);
    }

    /** The master to-do's id for a to-do, or null when it does not exist. */
    public static function rootTodoId(PDO $db, int $todoId): ?int
    {
        $stmt = $db->prepare('SELECT id, parent_todo_id FROM todos WHERE id = :id');
        $stmt->execute(['id' => $todoId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }

        return !empty($row['parent_todo_id']) ? (int) $row['parent_todo_id'] : (int) $row['id'];
    }

    /** A stored row as the API hands it out. */
    public static function present(array $row): array
    {
        $title = trim((string) ($row['title'] ?? ''));

        return [
            'id' => (int) $row['id'],
            'url' => $row['url'],
            'title' => $title !== '' ? $title : self::fallbackTitle($row['url']),
            'title_known' => $title !== '',
            'kind' => self::kind($row['url']),
            'created_by_name' => $row['created_by_name'] ?? null,
            'created_at' => $row['created_at'] ?? null,
        ];
    }

    /**
     * Put each to-do's links on it as 'links' (master and copies alike).
     *
     * @param array<int, array> $todos rows with id and, where known, parent_todo_id
     */
    public static function attach(PDO $db, array &$todos): void
    {
        if (!$todos) {
            return;
        }

        $rootOf = static fn(array $todo): int => !empty($todo['parent_todo_id']) ? (int) $todo['parent_todo_id'] : (int) $todo['id'];
        $roots = array_values(array_unique(array_map($rootOf, $todos)));

        $byRoot = [];
        foreach (array_chunk($roots, 500) as $chunk) {
            $marks = implode(',', array_fill(0, count($chunk), '?'));
            $stmt = $db->prepare("SELECT * FROM todo_links WHERE todo_id IN ($marks) ORDER BY created_at ASC, id ASC");
            $stmt->execute($chunk);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $byRoot[(int) $row['todo_id']][] = self::present($row);
            }
        }

        foreach ($todos as &$todo) {
            $todo['links'] = $byRoot[$rootOf($todo)] ?? [];
        }
        unset($todo);
    }

    /**
     * Add a link to a to-do. Without a name, the document's own name is
     * looked up (Google documents only).
     *
     * @return array the stored link, as present() hands it out
     */
    public static function add(PDO $db, int $rootTodoId, string $url, ?string $title, array $actor): array
    {
        $title = $title !== null ? trim($title) : '';
        if ($title === '') {
            $title = self::fetchTitle($url) ?? '';
        }

        $stmt = $db->prepare('
            INSERT INTO todo_links (todo_id, url, title, created_by, created_by_name)
            VALUES (:todo_id, :url, :title, :created_by, :created_by_name)
        ');
        $stmt->execute([
            'todo_id' => $rootTodoId,
            'url' => $url,
            'title' => $title !== '' ? mb_substr($title, 0, self::MAX_TITLE_LENGTH) : null,
            'created_by' => $actor['id'],
            'created_by_name' => $actor['name'],
        ]);

        $row = $db->query('SELECT * FROM todo_links WHERE id = ' . (int) $db->lastInsertId())->fetch(PDO::FETCH_ASSOC);
        return self::present($row);
    }

    public static function delete(PDO $db, int $linkId): bool
    {
        $stmt = $db->prepare('DELETE FROM todo_links WHERE id = :id');
        $stmt->execute(['id' => $linkId]);
        return $stmt->rowCount() > 0;
    }
}
