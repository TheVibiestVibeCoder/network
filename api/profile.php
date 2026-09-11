<?php
/**
 * Profile API Endpoint
 *
 * Profile pictures, and the small directory the UI uses to put a face next to
 * an attribution line.
 *
 * Everyone signed in may change their OWN picture and nobody else's. The owner
 * identity has no users row, so its picture is keyed in app_settings instead.
 *
 * Uploads are the sharp edge here. An uploaded image is never stored as sent:
 * it is decoded, re-drawn onto a fresh canvas and written back out as PNG. That
 * destroys EXIF, trailing payloads and polyglot files in one step - whatever
 * arrives, what lands on disk is pixels this server drew.
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';

const AVATAR_DIR = APP_ROOT . '/data/avatars';
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB before re-encoding
const AVATAR_MAX_PIXELS = 40000000;         // Guard against decompression bombs
const AVATAR_SIZE = 256;                    // Stored edge length, square

Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

// An upload larger than post_max_size arrives with $_POST and $_FILES already
// emptied, which would surface as a confusing "missing CSRF token".
if ($method === 'POST' && empty($_POST) && empty($_FILES)) {
    $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    $postMax = profileIniBytes((string) ini_get('post_max_size'));
    if ($contentLength > 0 && $postMax > 0 && $contentLength > $postMax) {
        profileJson(['error' => 'That image is larger than the server allows.'], 413);
    }
}

if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
    Auth::requireCsrfToken();
}

try {
    if ($method === 'GET' && $action === 'avatar') {
        serveAvatar($_GET['id'] ?? '');
    } elseif ($method === 'GET' && $action === 'directory') {
        serveDirectory();
    } elseif ($method === 'POST' && $action === 'avatar') {
        uploadAvatar();
    } elseif ($method === 'DELETE' && $action === 'avatar') {
        deleteAvatar();
    } else {
        profileJson(['error' => 'Unknown action'], 400);
    }
} catch (Throwable $e) {
    error_log('profile endpoint error: ' . $e->getMessage());
    profileJson(['error' => 'An internal error occurred'], 500);
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

/**
 * The list the UI uses to show a face next to an attribution line.
 *
 * Names and pictures only - no email addresses, no roles, no status. Members
 * do not need to know who is an administrator to render a by-line.
 */
function serveDirectory(): void
{
    $db = Database::getInstance();
    $people = [];

    $ownerAvatar = getSetting($db, 'owner_avatar');
    $people[] = [
        'id' => null,
        'name' => OWNER_DISPLAY_NAME,
        'avatar_url' => $ownerAvatar ? avatarUrl('owner', $ownerAvatar) : null,
    ];

    $stmt = $db->query("SELECT id, name, avatar FROM users ORDER BY name COLLATE NOCASE ASC");
    foreach ($stmt as $row) {
        $people[] = [
            'id' => (int) $row['id'],
            'name' => (string) $row['name'],
            'avatar_url' => $row['avatar'] ? avatarUrl((string) $row['id'], (string) $row['avatar']) : null,
        ];
    }

    $me = Auth::currentUser();
    profileJson([
        'success' => true,
        'data' => $people,
        'me' => [
            'id' => $me['id'],
            'name' => $me['name'],
            'is_owner' => $me['is_owner'],
            'avatar_url' => currentAvatarUrl(),
        ],
    ]);
}

/**
 * Stream one profile picture.
 *
 * Everything stored here was re-encoded by this server, so the content type is
 * known rather than guessed. The response is still sent with nosniff and a
 * locked-down CSP so a browser cannot be talked into treating it as anything
 * but an image.
 */
function serveAvatar(string $rawId): void
{
    $db = Database::getInstance();

    if ($rawId === 'owner') {
        $stored = getSetting($db, 'owner_avatar');
    } else {
        $id = (int) $rawId;
        if ($id <= 0) {
            profileJson(['error' => 'Not found'], 404);
        }
        $stmt = $db->prepare("SELECT avatar FROM users WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $stored = $stmt->fetchColumn() ?: null;
    }

    if (!$stored || !isSafeStoredName((string) $stored)) {
        profileJson(['error' => 'Not found'], 404);
    }

    $path = AVATAR_DIR . '/' . $stored;
    if (!is_file($path)) {
        profileJson(['error' => 'Not found'], 404);
    }

    // The URL carries the stored name's fingerprint, so it changes whenever the
    // picture does. That makes a long private cache safe - and keeps the app
    // from re-fetching every face on every render.
    header('Content-Type: image/png');
    header('Content-Length: ' . filesize($path));
    header('Content-Disposition: inline; filename="avatar.png"');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'; img-src 'self'; sandbox");
    header('Cache-Control: private, max-age=604800, immutable');
    header_remove('Pragma');

    readfile($path);
    exit;
}

// -----------------------------------------------------------------------------
// Write
// -----------------------------------------------------------------------------

/**
 * Replace the caller's own profile picture.
 *
 * There is deliberately no "whose avatar" parameter: the target is always the
 * session's own identity, so this endpoint cannot be pointed at somebody else.
 */
function uploadAvatar(): void
{
    $file = $_FILES['avatar'] ?? null;
    if (!is_array($file)) {
        profileJson(['error' => 'No image was received.'], 400);
    }

    $error = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($error !== UPLOAD_ERR_OK) {
        profileJson(['error' => uploadErrorMessage($error)], 400);
    }

    $size = (int) ($file['size'] ?? 0);
    if ($size <= 0) {
        profileJson(['error' => 'That file is empty.'], 400);
    }
    if ($size > AVATAR_MAX_BYTES) {
        profileJson(['error' => 'Please choose an image under 5 MB.'], 413);
    }

    $tmp = (string) ($file['tmp_name'] ?? '');
    // Only a genuine PHP upload may be read - never an arbitrary server path.
    if ($tmp === '' || !is_uploaded_file($tmp)) {
        profileJson(['error' => 'That upload could not be read.'], 400);
    }

    if (!function_exists('imagecreatetruecolor')) {
        profileJson([
            'error' => 'Profile pictures need the PHP GD extension, which is not enabled on this server.',
        ], 501);
    }

    $image = decodeUploadedImage($tmp);
    if ($image === null) {
        profileJson(['error' => 'That file is not a readable JPEG, PNG, GIF or WebP image.'], 415);
    }

    // Since PHP 8.0 a GD image is an object freed by the garbage collector, so
    // there is nothing to release by hand - imagedestroy() is a deprecated no-op.
    $square = squareThumbnail($image, AVATAR_SIZE);
    unset($image);

    if (!is_dir(AVATAR_DIR)) {
        ensureAvatarDir();
    }

    $storedName = 'a' . bin2hex(random_bytes(16)) . '.png';
    $target = AVATAR_DIR . '/' . $storedName;

    $written = imagepng($square, $target, 6);
    unset($square);

    if (!$written) {
        profileJson(['error' => 'The image could not be saved.'], 500);
    }
    @chmod($target, 0600);

    $previous = persistAvatar($storedName);
    removeStoredFile($previous);

    profileJson([
        'success' => true,
        'avatar_url' => avatarUrl(avatarOwnerKey(), $storedName),
    ]);
}

/**
 * Remove the caller's own profile picture.
 */
function deleteAvatar(): void
{
    $previous = persistAvatar(null);
    removeStoredFile($previous);

    profileJson(['success' => true, 'avatar_url' => null]);
}

// -----------------------------------------------------------------------------
// Image handling
// -----------------------------------------------------------------------------

/**
 * Decode an uploaded file into a GD image, or null if it is not an image.
 *
 * Three independent checks run before a single byte is decoded: the declared
 * MIME from libmagic, the real image header, and the pixel count. Only then is
 * the file handed to GD, and only through the decoder matching its actual type.
 */
function decodeUploadedImage(string $path): ?\GdImage
{
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime = $finfo->file($path);

    $allowed = [
        'image/jpeg' => IMAGETYPE_JPEG,
        'image/png' => IMAGETYPE_PNG,
        'image/gif' => IMAGETYPE_GIF,
        'image/webp' => IMAGETYPE_WEBP,
    ];

    if (!is_string($mime) || !isset($allowed[$mime])) {
        return null;
    }

    $info = @getimagesize($path);
    if (!is_array($info) || !isset($info[0], $info[1], $info[2])) {
        return null;
    }

    // The header must agree with libmagic - a mismatch means a crafted file.
    if ((int) $info[2] !== $allowed[$mime]) {
        return null;
    }

    $width = (int) $info[0];
    $height = (int) $info[1];
    if ($width < 1 || $height < 1) {
        return null;
    }

    // A small file can still declare enormous dimensions; decoding it would
    // exhaust memory long before anything else noticed.
    if ($width * $height > AVATAR_MAX_PIXELS) {
        return null;
    }

    switch ($allowed[$mime]) {
        case IMAGETYPE_JPEG:
            $image = @imagecreatefromjpeg($path);
            break;
        case IMAGETYPE_PNG:
            $image = @imagecreatefrompng($path);
            break;
        case IMAGETYPE_GIF:
            $image = @imagecreatefromgif($path);
            break;
        case IMAGETYPE_WEBP:
            $image = function_exists('imagecreatefromwebp') ? @imagecreatefromwebp($path) : false;
            break;
        default:
            $image = false;
    }

    return $image instanceof \GdImage ? $image : null;
}

/**
 * Centre-crop to a square and scale to the stored edge length.
 *
 * The result is drawn onto a brand new canvas, which is what actually makes the
 * upload safe: nothing of the original file survives except its pixels.
 */
function squareThumbnail(\GdImage $source, int $size): \GdImage
{
    $width = imagesx($source);
    $height = imagesy($source);
    $edge = min($width, $height);

    $srcX = (int) (($width - $edge) / 2);
    $srcY = (int) (($height - $edge) / 2);

    $canvas = imagecreatetruecolor($size, $size);

    // Keep transparency intact for PNG and GIF sources.
    imagealphablending($canvas, false);
    imagesavealpha($canvas, true);
    $transparent = imagecolorallocatealpha($canvas, 0, 0, 0, 127);
    imagefilledrectangle($canvas, 0, 0, $size, $size, $transparent);

    imagecopyresampled($canvas, $source, 0, 0, $srcX, $srcY, $size, $size, $edge, $edge);

    return $canvas;
}

// -----------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------------

/**
 * Point the caller's identity at a stored file (or at nothing).
 *
 * @return string|null The previously stored filename, so it can be cleaned up.
 */
function persistAvatar(?string $storedName): ?string
{
    $db = Database::getInstance();
    $me = Auth::currentUser();

    if ($me['is_owner']) {
        $previous = getSetting($db, 'owner_avatar');
        setSetting($db, 'owner_avatar', $storedName);
        return $previous;
    }

    $userId = (int) $me['id'];

    $stmt = $db->prepare("SELECT avatar FROM users WHERE id = :id");
    $stmt->execute(['id' => $userId]);
    $previous = $stmt->fetchColumn() ?: null;

    $update = $db->prepare("UPDATE users SET avatar = :avatar, updated_at = CURRENT_TIMESTAMP WHERE id = :id");
    $update->execute(['avatar' => $storedName, 'id' => $userId]);

    return $previous ? (string) $previous : null;
}

/**
 * Delete a previously stored picture.
 *
 * The name is re-validated even though it came out of our own database: it is
 * about to be concatenated into a filesystem path.
 */
function removeStoredFile(?string $storedName): void
{
    if (!$storedName || !isSafeStoredName($storedName)) {
        return;
    }

    $path = AVATAR_DIR . '/' . $storedName;
    if (is_file($path)) {
        @unlink($path);
    }
}

/**
 * Stored names are generated by this file and always look the same. Anything
 * else is refused rather than reasoned about.
 */
function isSafeStoredName(string $name): bool
{
    return preg_match('/^a[a-f0-9]{32}\.png$/', $name) === 1;
}

function ensureAvatarDir(): void
{
    if (!is_dir(AVATAR_DIR)) {
        mkdir(AVATAR_DIR, 0700, true);
    }

    // Same deny rule as the invoice store: pictures are served by this endpoint
    // after a session check, never straight off the filesystem. On nginx this
    // file does nothing - see SECURITY.md for the server block.
    $htaccess = AVATAR_DIR . '/.htaccess';
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
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function avatarOwnerKey(): string
{
    $me = Auth::currentUser();

    return $me['is_owner'] ? 'owner' : (string) $me['id'];
}

/**
 * The URL for a stored picture.
 *
 * The v= fingerprint changes with the stored name, which changes on every
 * upload, so the browser cache updates itself without any cache busting.
 */
function avatarUrl(string $key, string $storedName): string
{
    return 'api/profile.php?action=avatar&id=' . rawurlencode($key)
        . '&v=' . substr(hash('sha256', $storedName), 0, 12);
}

function currentAvatarUrl(): ?string
{
    $db = Database::getInstance();
    $me = Auth::currentUser();

    if ($me['is_owner']) {
        $stored = getSetting($db, 'owner_avatar');
        return $stored ? avatarUrl('owner', $stored) : null;
    }

    $stmt = $db->prepare("SELECT avatar FROM users WHERE id = :id");
    $stmt->execute(['id' => (int) $me['id']]);
    $stored = $stmt->fetchColumn() ?: null;

    return $stored ? avatarUrl((string) $me['id'], (string) $stored) : null;
}

function getSetting(PDO $db, string $key): ?string
{
    $stmt = $db->prepare("SELECT value FROM app_settings WHERE key = :key");
    $stmt->execute(['key' => $key]);
    $value = $stmt->fetchColumn();

    return ($value === false || $value === null || $value === '') ? null : (string) $value;
}

function setSetting(PDO $db, string $key, ?string $value): void
{
    $stmt = $db->prepare("
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (:key, :value, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    ");
    $stmt->execute(['key' => $key, 'value' => $value]);
}

function uploadErrorMessage(int $code): string
{
    switch ($code) {
        case UPLOAD_ERR_INI_SIZE:
        case UPLOAD_ERR_FORM_SIZE:
            return 'That image is larger than the server allows.';
        case UPLOAD_ERR_PARTIAL:
            return 'The upload was interrupted. Please try again.';
        case UPLOAD_ERR_NO_FILE:
            return 'No image was received.';
        case UPLOAD_ERR_NO_TMP_DIR:
            return 'The server has no temporary upload directory configured.';
        case UPLOAD_ERR_CANT_WRITE:
            return 'The server could not write the upload to disk.';
        default:
            return 'The upload failed. Please try again.';
    }
}

/** Converts a php.ini shorthand size ("2M", "512K") to bytes. */
function profileIniBytes(string $value): int
{
    $value = trim($value);
    if ($value === '') {
        return 0;
    }

    $unit = strtolower($value[strlen($value) - 1]);
    $num = (int) $value;

    switch ($unit) {
        case 'g':
            $num *= 1024;
            // no break
        case 'm':
            $num *= 1024;
            // no break
        case 'k':
            $num *= 1024;
    }

    return $num;
}

function profileJson(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}
