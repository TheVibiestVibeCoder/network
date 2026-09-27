<?php
/**
 * Application Configuration
 * Loads environment variables and sets up application constants
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
// Every entry point (index.php, api/*.php) defines APP_ROOT before requiring
// this file. If it is not defined we are being requested straight from the
// browser - refuse. nginx ignores .htaccess, so this is the portable backstop.
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

// ---------------------------------------------------------------------------
// Fail closed on error output
// ---------------------------------------------------------------------------
// A PHP notice rendered into the response leaks absolute paths, SQL fragments
// and occasionally secrets. Errors are logged, never displayed. This is set
// here (rather than only in .htaccess / .user.ini) so it holds on every SAPI.
@ini_set('display_errors', '0');
@ini_set('display_startup_errors', '0');
@ini_set('log_errors', '1');
error_reporting(E_ALL);

/**
 * Locate the private folder that keeps .env and data/ out of the web root.
 *
 * .htaccess can only deny what the web server would otherwise serve. A folder
 * next to the web root is not mapped to any URL at all, so nothing in it can be
 * downloaded, whatever happens to the deny rules. The folder only counts once
 * it holds a .env: creating it changes nothing, and moving .env into it is the
 * single switch that moves the whole application over.
 *
 * Returns null when there is none - .env and data/ are then read from the web
 * root, exactly as before.
 */
function findPrivateDir(): ?string
{
    $candidate = dirname(APP_ROOT) . '/crm-private';

    // @: under open_basedir a path outside the allowed list warns on every
    // request, and not finding the folder is the ordinary case.
    return @is_file($candidate . '/.env') ? $candidate : null;
}

/**
 * Point the PHP error log into the private folder.
 *
 * Left to the host, the log usually becomes an error_log file next to whichever
 * script failed - inside the web root, and full of absolute paths.
 */
function routeErrorLog(string $privateDir): void
{
    $logDir = $privateDir . '/logs';
    if (!is_dir($logDir)) {
        @mkdir($logDir, 0700, true);
    }
    if (is_dir($logDir) && is_writable($logDir)) {
        @ini_set('error_log', $logDir . '/php-error.log');
    }
}

define('PRIVATE_DIR', findPrivateDir());

if (PRIVATE_DIR !== null) {
    routeErrorLog(PRIVATE_DIR);
}

/**
 * Load environment variables from .env file
 */
function loadEnv(string $envFile): void
{
    if (!file_exists($envFile)) {
        // Detailed setup state goes to the log, not to an anonymous visitor.
        error_log('Configuration error: .env not found at ' . $envFile
            . ' or ' . dirname(APP_ROOT) . '/crm-private/.env');
        http_response_code(503);
        header('Content-Type: text/plain; charset=utf-8');
        exit('Service temporarily unavailable.');
    }

    $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

    foreach ($lines as $line) {
        // Skip comments
        if (strpos(trim($line), '#') === 0) {
            continue;
        }

        // Parse key=value pairs
        if (strpos($line, '=') !== false) {
            list($key, $value) = explode('=', $line, 2);
            $key = trim($key);
            $value = trim($value);

            // Remove quotes if present
            $value = trim($value, '"\'');

            // Set as environment variable
            $_ENV[$key] = $value;
            putenv("$key=$value");
        }
    }
}

// Load environment variables
loadEnv((PRIVATE_DIR ?? APP_ROOT) . '/.env');

/**
 * Parse an integer environment variable with a safe fallback.
 */
function envInt(string $key, int $default): int
{
    $raw = $_ENV[$key] ?? null;
    if ($raw === null || $raw === '') {
        return $default;
    }

    $value = filter_var($raw, FILTER_VALIDATE_INT);
    return $value !== false ? (int) $value : $default;
}

/**
 * Parse a boolean environment variable with a safe fallback.
 */
function envBool(string $key, bool $default): bool
{
    $raw = $_ENV[$key] ?? null;
    if ($raw === null || $raw === '') {
        return $default;
    }

    $value = filter_var($raw, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    return $value !== null ? $value : $default;
}

// Application constants
define('APP_NAME', $_ENV['APP_NAME'] ?? 'Simple CRM');
define('APP_PASSWORD', $_ENV['APP_PASSWORD'] ?? '');
// The database, invoice PDFs and profile pictures all live under DATA_DIR.
define('DATA_DIR', (PRIVATE_DIR ?? APP_ROOT) . '/data');
define('DB_PATH', DATA_DIR . '/crm.db');

// ---------------------------------------------------------------------------
// Refuse to start on a database that was not moved along
// ---------------------------------------------------------------------------
// SQLite does not report a missing file - it quietly creates a new, empty one.
// In the web root that is how a fresh install starts. In the private folder it
// means data/ was not copied over, and everyone would be greeted by an empty
// CRM that starts collecting new records. A deliberately fresh install can
// create an empty data/crm.db first: SQLite treats a zero-byte file as an
// empty database.
if (PRIVATE_DIR !== null && !is_file(DB_PATH)) {
    error_log('Configuration error: ' . PRIVATE_DIR . '/.env exists but ' . DB_PATH
        . ' does not. Copy data/ into the private folder, or create an empty'
        . ' crm.db there for a fresh install.');
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    exit('Service temporarily unavailable.');
}

// ---------------------------------------------------------------------------
// Refuse to run with a placeholder password
// ---------------------------------------------------------------------------
// An unchanged APP_PASSWORD means anyone who knows this project can log in.
// On a public domain that is the same as having no password at all, so the
// application stops instead of serving a wide open instance.
if (APP_PASSWORD === '' || in_array(strtolower(APP_PASSWORD), ['changeme', 'change-me', 'password', 'secret', 'admin'], true)) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    exit(<<<TXT
Setup incomplete: APP_PASSWORD in .env is unset or still a placeholder.
Set a strong password before exposing this instance.

Recommended - store a hash instead of the plain password:
  php -r "echo password_hash('your-strong-password', PASSWORD_DEFAULT), PHP_EOL;"
then put the resulting \$2y\$... string in .env as APP_PASSWORD.

TXT);
}

// Session configuration
define('SESSION_NAME', 'crm_session');
define('SESSION_LIFETIME', max(300, envInt('SESSION_LIFETIME', 86400))); // 24 hours
// Idle timeout: log out after this long without a request. Defaults to the
// absolute lifetime, which means "off" unless the operator opts in - so the
// out-of-the-box behaviour is unchanged.
define('SESSION_IDLE_TIMEOUT', max(60, envInt('SESSION_IDLE_TIMEOUT', SESSION_LIFETIME)));
define('TRUST_PROXY_HEADERS', envBool('TRUST_PROXY_HEADERS', false));

// -----------------------------------------------------------------------------
// Multi-user configuration
// -----------------------------------------------------------------------------
// The owner account is the original single password. It always exists, is
// always an admin, and is never stored in the database - so a broken users
// table or a deleted admin row can never lock you out of your own CRM.
// Sign in as the owner by leaving the email field empty.
define('OWNER_DISPLAY_NAME', trim((string) ($_ENV['OWNER_NAME'] ?? '')) !== '' ? trim((string) $_ENV['OWNER_NAME']) : 'Owner');

// How long an invite / password-reset link stays valid, in seconds.
define('INVITE_TOKEN_LIFETIME', max(300, envInt('INVITE_TOKEN_LIFETIME', 172800)));   // 48 h
define('RESET_TOKEN_LIFETIME', max(300, envInt('RESET_TOKEN_LIFETIME', 3600)));       // 1 h

// Minimum length for a user-chosen password.
define('MIN_PASSWORD_LENGTH', max(8, envInt('MIN_PASSWORD_LENGTH', 10)));

// Outgoing mail. MAIL_FROM must be a bare address on a domain this server is
// allowed to send for, otherwise the invite mails land in spam or bounce.
define('MAIL_FROM', trim((string) ($_ENV['MAIL_FROM'] ?? '')));
define('MAIL_FROM_NAME', trim((string) ($_ENV['MAIL_FROM_NAME'] ?? '')) !== '' ? trim((string) $_ENV['MAIL_FROM_NAME']) : APP_NAME);

// Public base URL, used to build invite links. Auto-detected per request when
// left empty; set it explicitly if the app sits behind a proxy or subpath.
define('APP_BASE_URL', rtrim(trim((string) ($_ENV['APP_BASE_URL'] ?? '')), '/'));

// -----------------------------------------------------------------------------
// Two-factor sign-in
// -----------------------------------------------------------------------------
// A password alone does not open a session for a user account: a one-time code
// goes to their registered address and has to come back. The owner login is
// deliberately exempt - it has no registered address, and it is the recovery
// path that has to keep working when everything else does not.
define('TWO_FACTOR_ENABLED', envBool('TWO_FACTOR_ENABLED', true));
define('LOGIN_CODE_LIFETIME', max(60, envInt('LOGIN_CODE_LIFETIME', 600)));       // 10 min
define('LOGIN_CODE_MAX_ATTEMPTS', max(1, envInt('LOGIN_CODE_MAX_ATTEMPTS', 5)));
// Codes an account may request per hour, so the sign-in form cannot be turned
// into a way to flood somebody's inbox.
define('LOGIN_CODE_MAX_PER_HOUR', max(1, envInt('LOGIN_CODE_MAX_PER_HOUR', 10)));

// -----------------------------------------------------------------------------
// "Remember this device"
// -----------------------------------------------------------------------------
// An opt-in cookie that restores the session without password or code. It is a
// second key to the account, so it is off by default, expires on its own, and
// dies with the password it was issued against.
define('REMEMBER_ME_ENABLED', envBool('REMEMBER_ME_ENABLED', true));
define('REMEMBER_ME_LIFETIME', max(3600, envInt('REMEMBER_ME_LIFETIME', 2592000))); // 30 days
define('REMEMBER_COOKIE_NAME', 'crm_remember');
// How long the just-replaced validator stays acceptable after a rotation. One
// page load fires several requests at once, and they all carry the cookie the
// browser had before any of them returned - without this window the ones that
// arrive second look exactly like a replayed cookie.
define('REMEMBER_ROTATION_GRACE', max(5, envInt('REMEMBER_ROTATION_GRACE', 60)));

// Security configuration
define('MAX_LOGIN_ATTEMPTS', max(1, envInt('MAX_LOGIN_ATTEMPTS', 10)));      // Lock out after this many failed attempts
define('LOGIN_LOCKOUT_DURATION', max(60, envInt('LOGIN_LOCKOUT_DURATION', 900))); // Lockout duration in seconds
define('CSRF_TOKEN_NAME', 'csrf_token');  // CSRF token parameter/header name

// SQLite performance tuning
define('SQLITE_BUSY_TIMEOUT_MS', max(1000, envInt('SQLITE_BUSY_TIMEOUT_MS', 5000)));
define('SQLITE_CACHE_SIZE_KB', max(2048, envInt('SQLITE_CACHE_SIZE_KB', 20000)));

// -----------------------------------------------------------------------------
// MCP API (api/mcp.php)
// -----------------------------------------------------------------------------
// The door Claude's MCP server uses. Closed unless every one of these is set:
// it answers 404 while disabled, while the secret is shorter than 64
// characters, and to every address not on the allow-list. See SECURITY.md.
define('MCP_API_ENABLED', envBool('MCP_API_ENABLED', false));
// Shared HMAC key. Never sent over the wire - requests carry a signature made
// with it, so a captured request cannot be altered or replayed.
define('MCP_API_SECRET', trim((string) ($_ENV['MCP_API_SECRET'] ?? '')));
// Comma-separated IPs and CIDR ranges, IPv4 and IPv6. Compared against
// REMOTE_ADDR only - never a forwarded header, which the caller controls.
define('MCP_API_ALLOWED_IPS', trim((string) ($_ENV['MCP_API_ALLOWED_IPS'] ?? '')));
// With writes off, the API only reads. With them on, every write is still a
// proposal a person has to accept in the CRM.
define('MCP_API_ALLOW_WRITES', envBool('MCP_API_ALLOW_WRITES', true));
define('MCP_API_RATE_LIMIT', max(10, envInt('MCP_API_RATE_LIMIT', 120)));      // signed requests per minute
define('MCP_API_MAX_PENDING', max(10, envInt('MCP_API_MAX_PENDING', 200)));    // open proposals before new ones are refused
define('MCP_ACTOR_NAME', trim((string) ($_ENV['MCP_ACTOR_NAME'] ?? '')) !== '' ? trim((string) $_ENV['MCP_ACTOR_NAME']) : 'Claude');
