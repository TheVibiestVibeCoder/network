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
 * Load environment variables from .env file
 */
function loadEnv(): void
{
    $envFile = APP_ROOT . '/.env';

    if (!file_exists($envFile)) {
        // Detailed setup state goes to the log, not to an anonymous visitor.
        error_log('Configuration error: .env not found at ' . $envFile);
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
loadEnv();

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
define('DB_PATH', APP_ROOT . '/data/crm.db');

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

// Security configuration
define('MAX_LOGIN_ATTEMPTS', max(1, envInt('MAX_LOGIN_ATTEMPTS', 10)));      // Lock out after this many failed attempts
define('LOGIN_LOCKOUT_DURATION', max(60, envInt('LOGIN_LOCKOUT_DURATION', 900))); // Lockout duration in seconds
define('CSRF_TOKEN_NAME', 'csrf_token');  // CSRF token parameter/header name

// SQLite performance tuning
define('SQLITE_BUSY_TIMEOUT_MS', max(1000, envInt('SQLITE_BUSY_TIMEOUT_MS', 5000)));
define('SQLITE_CACHE_SIZE_KB', max(2048, envInt('SQLITE_CACHE_SIZE_KB', 20000)));
