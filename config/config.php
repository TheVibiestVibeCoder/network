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

// Application constants
define('APP_NAME', $_ENV['APP_NAME'] ?? 'Simple CRM');
define('APP_PASSWORD', $_ENV['APP_PASSWORD'] ?? 'changeme');
define('DB_PATH', APP_ROOT . '/data/crm.db');

// Session configuration
define('SESSION_NAME', 'crm_session');
define('SESSION_LIFETIME', 86400); // 24 hours

// Security configuration
define('MAX_LOGIN_ATTEMPTS', 10);         // Lock out after this many failed attempts
define('LOGIN_LOCKOUT_DURATION', 900);    // Lockout duration in seconds (15 minutes)
define('CSRF_TOKEN_NAME', 'csrf_token');  // CSRF token parameter/header name
