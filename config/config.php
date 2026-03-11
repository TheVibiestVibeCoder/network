<?php
/**
 * Application Configuration
 * Loads environment variables and sets up application constants
 */

// Prevent direct access
if (!defined('APP_ROOT')) {
    define('APP_ROOT', dirname(__DIR__));
}

/**
 * Load environment variables from .env file
 */
function loadEnv(): void
{
    $envFile = APP_ROOT . '/.env';

    if (!file_exists($envFile)) {
        die('Error: .env file not found. Please copy .env.example to .env and configure it.');
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
define('APP_PASSWORD', $_ENV['APP_PASSWORD'] ?? 'changeme');
define('DB_PATH', APP_ROOT . '/data/crm.db');

// Session configuration
define('SESSION_NAME', 'crm_session');
define('SESSION_LIFETIME', max(300, envInt('SESSION_LIFETIME', 86400))); // 24 hours
define('TRUST_PROXY_HEADERS', envBool('TRUST_PROXY_HEADERS', false));

// Security configuration
define('MAX_LOGIN_ATTEMPTS', max(1, envInt('MAX_LOGIN_ATTEMPTS', 10)));      // Lock out after this many failed attempts
define('LOGIN_LOCKOUT_DURATION', max(60, envInt('LOGIN_LOCKOUT_DURATION', 900))); // Lockout duration in seconds
define('CSRF_TOKEN_NAME', 'csrf_token');  // CSRF token parameter/header name

// SQLite performance tuning
define('SQLITE_BUSY_TIMEOUT_MS', max(1000, envInt('SQLITE_BUSY_TIMEOUT_MS', 5000)));
define('SQLITE_CACHE_SIZE_KB', max(2048, envInt('SQLITE_CACHE_SIZE_KB', 20000)));
