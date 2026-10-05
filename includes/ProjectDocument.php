<?php
/**
 * Project documents
 *
 * Files attached to a project: the offer that went out, the background it was
 * built on, the invoices that followed. Each one carries a label, so a
 * project's files read as a short sorted list rather than a pile.
 *
 * This class is the one place that decides what may be stored, and where. The
 * browser endpoint (api/documents.php) and the MCP API (includes/McpService.php)
 * both go through it, so a file is checked by the same rules whichever door it
 * came in by.
 *
 * What makes an upload safe here is never taking its word for what it is:
 *
 *   - the extension has to be on a short list, and the content has to look
 *     like that type;
 *   - the stored name is generated, never taken from the upload;
 *   - the folder is denied to the web server (and lies outside the web root
 *     when crm-private/ is used), so a file only ever leaves through an
 *     endpoint - with the content type from the list below, not the one it
 *     arrived with.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

final class ProjectDocument
{
    /** The labels a document can carry, in the order they are listed. */
    public const LABELS = ['Angebot', 'Hintergrund', 'Rechnung'];

    /** Our own ceiling for a file added in the CRM; php.ini may set a lower one. */
    public const MAX_BYTES = 25 * 1024 * 1024;

    /** Ceiling through the MCP API, where a file travels base64-encoded inside a signed request. */
    public const MAX_API_BYTES = 10 * 1024 * 1024;

    /**
     * What may be attached: extension => [content type it is served with, kind].
     *
     * Deliberately short. Nothing on it can run in a browser or on the server:
     * no HTML, no SVG, no scripts, no archives.
     */
    private const TYPES = [
        'pdf' => ['application/pdf', 'pdf'],
        'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'office'],
        'xlsx' => ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'office'],
        'pptx' => ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'office'],
        'txt' => ['text/plain', 'text'],
        'md' => ['text/markdown', 'text'],
        'csv' => ['text/csv', 'text'],
        'png' => ['image/png', 'image'],
        'jpg' => ['image/jpeg', 'image'],
        'jpeg' => ['image/jpeg', 'image'],
        'webp' => ['image/webp', 'image'],
        'gif' => ['image/gif', 'image'],
    ];

    /** The part every Word, Excel and PowerPoint file has, by extension. */
    private const OFFICE_PARTS = [
        'docx' => 'word/document.xml',
        'xlsx' => 'xl/workbook.xml',
        'pptx' => 'ppt/presentation.xml',
    ];

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    public static function dir(): string
    {
        return DATA_DIR . '/project_documents';
    }

    /**
     * Create the folder on first use and keep the web server out of it.
     *
     * Same rules as the invoice folder: denied on Apache 2.4 and 2.2, with the
     * PHP engine switched off in case a script ever lands here. nginx ignores
     * .htaccess - there the data directory is denied in the server block (see
     * SECURITY.md).
     */
    public static function ensureStorage(): void
    {
        static $done = false;
        if ($done) {
            return;
        }

        $dir = self::dir();
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new RuntimeException('The document folder could not be created');
        }

        $htaccess = $dir . '/.htaccess';
        $body = <<<HTA
<IfModule mod_authz_core.c>
    Require all denied
</IfModule>
<IfModule !mod_authz_core.c>
    Order allow,deny
    Deny from all
</IfModule>

<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteRule ^ - [F,L]
</IfModule>

<IfModule mod_php.c>
    php_flag engine off
</IfModule>
<IfModule mod_php7.c>
    php_flag engine off
</IfModule>
<IfModule mod_php8.c>
    php_flag engine off
</IfModule>

Options -Indexes

HTA;

        if (!is_file($htaccess) || file_get_contents($htaccess) !== $body) {
            file_put_contents($htaccess, $body);
        }

        $done = true;
    }

    /**
     * Where a stored file lives, or null if the name is not one this class
     * generated - so nothing read from the database can point outside the folder.
     */
    public static function pathOf(array $row): ?string
    {
        $stored = (string) ($row['stored_name'] ?? '');
        if (!preg_match('/^[A-Za-z0-9_]+\.[a-z0-9]{2,5}$/', $stored)) {
            return null;
        }

        return self::dir() . '/' . $stored;
    }

    // -------------------------------------------------------------------------
    // Labels, types and limits
    // -------------------------------------------------------------------------

    /** The label as it is written here, whatever the case it was sent in - or null. */
    public static function label($value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        foreach (self::LABELS as $label) {
            if (strcasecmp($label, trim($value)) === 0) {
                return $label;
            }
        }

        return null;
    }

    /** @return string[] */
    public static function extensions(): array
    {
        return array_keys(self::TYPES);
    }

    /**
     * What a file name says the file is.
     *
     * @return array{extension: string, mime: string, kind: string}|null
     */
    public static function typeOf(string $name): ?array
    {
        $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if (!isset(self::TYPES[$extension])) {
            return null;
        }

        return ['extension' => $extension, 'mime' => self::TYPES[$extension][0], 'kind' => self::TYPES[$extension][1]];
    }

    /**
     * The name to show and to offer on download. Same rules as an invoice's
     * name, and the extension always survives the length limit.
     */
    public static function cleanName(string $name): string
    {
        $name = basename(str_replace('\\', '/', $name));
        $name = preg_replace('/[^\w.\- ()\[\]äöüÄÖÜéèàç]/u', '_', $name) ?? '';
        $name = trim($name);

        $extension = pathinfo($name, PATHINFO_EXTENSION);
        $base = trim(pathinfo($name, PATHINFO_FILENAME), ' .');
        if ($base === '') {
            $base = 'document';
        }
        if ($extension === '') {
            return mb_substr($base, 0, 200);
        }

        return mb_substr($base, 0, 199 - mb_strlen($extension)) . '.' . $extension;
    }

    /**
     * The real ceiling for a browser upload: our own cap, but never more than
     * PHP itself accepts - otherwise the form would promise a size that
     * php.ini then silently refuses.
     */
    public static function maxUploadBytes(): int
    {
        $limits = [self::MAX_BYTES];
        foreach (['upload_max_filesize', 'post_max_size'] as $key) {
            $bytes = self::iniBytes((string) ini_get($key));
            if ($bytes > 0) {
                $limits[] = $bytes;
            }
        }

        return min($limits);
    }

    /** A php.ini shorthand size ("2M", "512K") in bytes. */
    public static function iniBytes(string $value): int
    {
        $value = trim($value);
        if ($value === '') {
            return 0;
        }

        $number = (int) $value;
        switch (strtolower($value[strlen($value) - 1])) {
            case 'g':
                $number *= 1024;
                // no break
            case 'm':
                $number *= 1024;
                // no break
            case 'k':
                $number *= 1024;
        }

        return $number;
    }

    public static function formatBytes(int $bytes): string
    {
        if ($bytes >= 1048576) {
            return round($bytes / 1048576, 1) . ' MB';
        }
        if ($bytes >= 1024) {
            return round($bytes / 1024) . ' KB';
        }

        return $bytes . ' B';
    }

    public static function uploadErrorMessage(int $code): string
    {
        switch ($code) {
            case UPLOAD_ERR_INI_SIZE:
            case UPLOAD_ERR_FORM_SIZE:
                return 'File is larger than the server limit of ' . self::formatBytes(self::maxUploadBytes()) . '.';
            case UPLOAD_ERR_PARTIAL:
                return 'Upload was interrupted before it finished. Please try again.';
            case UPLOAD_ERR_NO_FILE:
                return 'No file was received.';
            case UPLOAD_ERR_NO_TMP_DIR:
                return 'Server has no temporary upload directory configured.';
            case UPLOAD_ERR_CANT_WRITE:
                return 'Server could not write the uploaded file to disk.';
            case UPLOAD_ERR_EXTENSION:
                return 'A server extension blocked the upload.';
            default:
                return 'Upload failed. Please try again.';
        }
    }

    // -------------------------------------------------------------------------
    // Checking a file
    // -------------------------------------------------------------------------

    /**
     * Why a file may not be stored, or null if it may.
     *
     * The extension picks the rule and the content has to satisfy it. What a
     * browser or a client claimed as the content type is never looked at.
     */
    public static function problemWith(string $name, string $path, int $maxBytes): ?string
    {
        $type = self::typeOf($name);
        if ($type === null) {
            return 'This kind of file cannot be attached. Allowed: ' . implode(', ', self::extensions()) . '.';
        }

        $size = @filesize($path);
        if ($size === false || $size <= 0) {
            return 'File is empty.';
        }
        if ($size > $maxBytes) {
            return 'File is larger than the limit of ' . self::formatBytes($maxBytes) . '.';
        }

        $detected = (string) (new finfo(FILEINFO_MIME_TYPE))->file($path);
        $head = (string) file_get_contents($path, false, null, 0, 8192);

        switch ($type['kind']) {
            case 'pdf':
                $ok = $detected === 'application/pdf';
                break;
            case 'image':
                $ok = $detected === $type['mime'];
                break;
            case 'office':
                $ok = strncmp($head, "PK\x03\x04", 4) === 0 && self::hasOfficePart($path, $type['extension']);
                break;
            default:
                $ok = self::looksLikeText($head, $detected);
        }

        return $ok ? null : 'The file does not look like a real .' . $type['extension'] . ' file.';
    }

    /**
     * Word, Excel and PowerPoint files are ZIP archives with a fixed part in
     * them. Checked when PHP can read ZIPs; without that extension the ZIP
     * signature has to do - the file is stored and served as an inert download
     * either way.
     */
    private static function hasOfficePart(string $path, string $extension): bool
    {
        if (!class_exists('ZipArchive')) {
            return true;
        }

        $zip = new ZipArchive();
        if ($zip->open($path, ZipArchive::RDONLY) !== true) {
            return false;
        }
        $found = $zip->locateName(self::OFFICE_PARTS[$extension]) !== false;
        $zip->close();

        return $found;
    }

    private static function looksLikeText(string $head, string $detected): bool
    {
        // Notepad's "Unicode" is UTF-16 with a byte order mark; that is still text.
        if (strncmp($head, "\xFF\xFE", 2) === 0 || strncmp($head, "\xFE\xFF", 2) === 0) {
            return true;
        }
        if (strpos($head, "\0") !== false) {
            return false;
        }

        return strncmp($detected, 'text/', 5) === 0
            || in_array($detected, ['application/csv', 'application/json'], true);
    }

    // -------------------------------------------------------------------------
    // Storing
    // -------------------------------------------------------------------------

    /**
     * Store a file a signed-in person uploaded in the browser.
     *
     * @param array $file One entry of $_FILES
     * @throws InvalidArgumentException with a message for the person, when the file is refused
     */
    public static function storeUpload(int $projectId, string $label, array $file): array
    {
        $error = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($error !== UPLOAD_ERR_OK) {
            throw new InvalidArgumentException(self::uploadErrorMessage($error));
        }

        $name = self::cleanName((string) ($file['name'] ?? ''));
        $problem = self::problemWith($name, (string) $file['tmp_name'], self::maxUploadBytes());
        if ($problem !== null) {
            throw new InvalidArgumentException($problem);
        }

        self::ensureStorage();
        $type = self::typeOf($name);
        $storedName = self::newStoredName($type['extension']);
        $target = self::dir() . '/' . $storedName;

        if (!move_uploaded_file((string) $file['tmp_name'], $target)) {
            throw new RuntimeException('Failed to store uploaded file');
        }

        try {
            $id = self::insert($projectId, $label, $name, $storedName, $type['mime'], (int) filesize($target), null);
        } catch (Throwable $e) {
            @unlink($target);
            throw $e;
        }

        return self::find($id) ?? [];
    }

    /**
     * Store a file that arrived as bytes (through the MCP API).
     *
     * The bytes are written under their final, generated name first and
     * checked there, so they pass the same check as an upload - and are gone
     * again if they fail it. The row is the caller's to insert, because it
     * belongs in one transaction with the proposal that announces it.
     *
     * @return array{name: string, stored_name: string, mime: string, size: int, path: string}
     * @throws InvalidArgumentException with a message for the caller, when the file is refused
     */
    public static function storeBytes(string $name, string $bytes, int $maxBytes): array
    {
        $name = self::cleanName($name);
        $type = self::typeOf($name);
        if ($type === null) {
            throw new InvalidArgumentException(
                'This kind of file cannot be attached. Allowed: ' . implode(', ', self::extensions()) . '.'
            );
        }
        if (strlen($bytes) > $maxBytes) {
            throw new InvalidArgumentException('File is larger than the limit of ' . self::formatBytes($maxBytes) . '.');
        }

        self::ensureStorage();
        $storedName = self::newStoredName($type['extension']);
        $target = self::dir() . '/' . $storedName;

        if (file_put_contents($target, $bytes, LOCK_EX) !== strlen($bytes)) {
            @unlink($target);
            throw new RuntimeException('Failed to store the file');
        }

        $problem = self::problemWith($name, $target, $maxBytes);
        if ($problem !== null) {
            @unlink($target);
            throw new InvalidArgumentException($problem);
        }

        return ['name' => $name, 'stored_name' => $storedName, 'mime' => $type['mime'], 'size' => strlen($bytes), 'path' => $target];
    }

    /** The row for a stored file. $reviewStatus is 'pending' for a proposal, null otherwise. */
    public static function insert(
        int $projectId,
        string $label,
        string $name,
        string $storedName,
        string $mime,
        int $size,
        ?string $reviewStatus
    ): int {
        // Stamped here so no caller can forget to say who added the file.
        $actor = Auth::actor();

        $db = Database::getInstance();
        $db->prepare("
            INSERT INTO project_documents (project_id, label, original_name, stored_name, mime_type, file_size,
                                           uploaded_by, uploaded_by_name, review_status)
            VALUES (:project_id, :label, :name, :stored, :mime, :size, :actor_id, :actor_name, :review_status)
        ")->execute([
            'project_id' => $projectId,
            'label' => $label,
            'name' => $name,
            'stored' => $storedName,
            'mime' => $mime,
            'size' => $size,
            'actor_id' => $actor['id'],
            'actor_name' => $actor['name'],
            'review_status' => $reviewStatus,
        ]);

        return (int) $db->lastInsertId();
    }

    private static function newStoredName(string $extension): string
    {
        return date('Ymd_His') . '_' . bin2hex(random_bytes(8)) . '.' . $extension;
    }

    // -------------------------------------------------------------------------
    // Reading and changing
    // -------------------------------------------------------------------------

    /** A project's documents: by label in the order above, newest first within a label. */
    public static function forProject(int $projectId): array
    {
        $stmt = Database::getInstance()->prepare("
            SELECT * FROM project_documents WHERE project_id = :id ORDER BY created_at DESC, id DESC LIMIT 500
        ");
        $stmt->execute(['id' => $projectId]);
        $rows = $stmt->fetchAll();

        $rank = array_flip(self::LABELS);
        // usort is stable since PHP 8.0, so newest-first survives within a label.
        usort($rows, fn($a, $b) => ($rank[$a['label']] ?? PHP_INT_MAX) <=> ($rank[$b['label']] ?? PHP_INT_MAX));

        return $rows;
    }

    public static function find(int $id): ?array
    {
        $stmt = Database::getInstance()->prepare("SELECT * FROM project_documents WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();

        return $row ?: null;
    }

    public static function setLabel(int $id, string $label): void
    {
        Database::getInstance()
            ->prepare("UPDATE project_documents SET label = :label WHERE id = :id")
            ->execute(['label' => $label, 'id' => $id]);
    }

    /** Remove a document: the row first, so a failure never leaves a row pointing at nothing. */
    public static function delete(array $row): void
    {
        Database::getInstance()
            ->prepare("DELETE FROM project_documents WHERE id = :id")
            ->execute(['id' => (int) $row['id']]);

        $path = self::pathOf($row);
        if ($path !== null) {
            self::removeFiles([$path]);
        }
    }

    /**
     * The files behind a project's documents.
     *
     * Deleting a project takes its document rows along (ON DELETE CASCADE),
     * but the files have to be taken off the disk by hand: collect them with
     * this before the delete, and pass them to removeFiles() once it is done.
     *
     * @return string[]
     */
    public static function filesOfProject(int $projectId): array
    {
        $stmt = Database::getInstance()->prepare("SELECT stored_name FROM project_documents WHERE project_id = :id");
        $stmt->execute(['id' => $projectId]);

        $paths = [];
        foreach ($stmt->fetchAll() as $row) {
            $path = self::pathOf($row);
            if ($path !== null) {
                $paths[] = $path;
            }
        }

        return $paths;
    }

    /** @param string[] $paths */
    public static function removeFiles(array $paths): void
    {
        foreach ($paths as $path) {
            if (is_file($path)) {
                @unlink($path);
            }
        }
    }

    /** A row as the browser and Claude see it: no stored name, numbers as numbers. */
    public static function present(array $row): array
    {
        $type = self::typeOf((string) $row['stored_name']);

        return [
            'id' => (int) $row['id'],
            'project_id' => (int) $row['project_id'],
            'label' => $row['label'],
            'name' => $row['original_name'],
            'kind' => $type['kind'] ?? 'file',
            'mime_type' => $row['mime_type'],
            'size' => (int) $row['file_size'],
            'uploaded_by' => $row['uploaded_by'] === null ? null : (int) $row['uploaded_by'],
            'uploaded_by_name' => $row['uploaded_by_name'],
            'review_status' => $row['review_status'],
            'created_at' => $row['created_at'],
        ];
    }

    /**
     * Send a stored file as the response and end the request.
     *
     * The content type is the one this class assigns to the extension it
     * stored the file under. Only PDFs and images are ever shown in place, and
     * only when asked for; everything else is a download, so a browser never
     * renders what somebody uploaded.
     */
    public static function send(array $row, bool $inline): void
    {
        $path = self::pathOf($row);
        $type = self::typeOf((string) $row['stored_name']);
        if ($path === null || $type === null || !is_file($path)) {
            http_response_code(404);
            header('Content-Type: application/json');
            echo json_encode(['error' => 'Document not found']);
            exit;
        }

        $inline = $inline && in_array($type['kind'], ['pdf', 'image'], true);

        if ($inline && $type['kind'] === 'pdf') {
            // The preview may be framed by this site itself, and by nobody
            // else - the same two relaxations the invoice preview makes.
            header('X-Frame-Options: SAMEORIGIN');
            header("Content-Security-Policy: default-src 'none'; object-src 'self'; plugin-types application/pdf; frame-ancestors 'self'");
        } elseif ($inline) {
            header("Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
        } else {
            header("Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'");
        }

        // Control characters are stripped (a bare CR/LF would inject response
        // headers) and the UTF-8 form goes separately per RFC 5987, so umlauts
        // survive without a raw byte in the quoted string.
        $name = preg_replace('/[[:cntrl:]]/u', '', (string) $row['original_name']) ?? 'document';
        $asciiName = preg_replace('/[^A-Za-z0-9._-]/', '_', $name) ?: 'document';

        // Anything still buffered would be sent ahead of the file and corrupt it.
        while (ob_get_level() > 0) {
            ob_end_clean();
        }

        header('Content-Type: ' . $type['mime'] . ($type['kind'] === 'text' ? '; charset=utf-8' : ''));
        header('Content-Length: ' . filesize($path));
        header(
            'Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="' . $asciiName . '"; '
            . "filename*=UTF-8''" . rawurlencode($name)
        );
        header('X-Content-Type-Options: nosniff');
        readfile($path);
        exit;
    }
}
