<?php
/**
 * Authentication Handler
 * Secure password-based authentication with session management,
 * brute force protection, CSRF tokens, and security headers.
 */

class Auth
{
    /**
     * Start session with secure configuration
     */
    public static function startSession(): void
    {
        if (session_status() === PHP_SESSION_NONE) {
            $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
                || (isset($_SERVER['SERVER_PORT']) && $_SERVER['SERVER_PORT'] == 443);

            session_name(SESSION_NAME);
            session_set_cookie_params([
                'lifetime' => SESSION_LIFETIME,
                'path' => '/',
                'httponly' => true,
                'samesite' => 'Strict',
                'secure' => $isHttps,
            ]);
            session_start();
        }
    }

    /**
     * Check if user is authenticated (includes session timeout check)
     */
    public static function isAuthenticated(): bool
    {
        self::startSession();

        if (!isset($_SESSION['authenticated']) || $_SESSION['authenticated'] !== true) {
            return false;
        }

        // Enforce server-side session timeout
        if (isset($_SESSION['login_time'])) {
            $elapsed = time() - $_SESSION['login_time'];
            if ($elapsed > SESSION_LIFETIME) {
                self::logout();
                return false;
            }
        } else {
            // No login_time set - invalid session
            self::logout();
            return false;
        }

        // Refresh last activity timestamp
        $_SESSION['last_activity'] = time();

        return true;
    }

    /**
     * Verify a password against the stored APP_PASSWORD.
     * Supports bcrypt hashes in .env (starting with $2y$ or $2a$ or $2b$)
     * and falls back to constant-time string comparison for plaintext.
     */
    public static function verifyPassword(string $password): bool
    {
        $stored = APP_PASSWORD;

        // If stored password is a bcrypt hash, use password_verify
        if (preg_match('/^\$2[yab]\$/', $stored)) {
            return password_verify($password, $stored);
        }

        // For plaintext passwords, use constant-time comparison
        return hash_equals($stored, $password);
    }

    /**
     * Attempt to log in with provided password.
     * Includes brute force protection with lockout.
     *
     * @return array{success: bool, error?: string, remaining_attempts?: int, locked_until?: int}
     */
    public static function login(string $password): array
    {
        self::startSession();

        $ip = self::getClientIp();

        // Check if this IP is currently locked out
        $lockoutInfo = self::getLockoutInfo($ip);
        if ($lockoutInfo['locked']) {
            return [
                'success' => false,
                'error' => 'Too many failed login attempts. Please try again later.',
                'locked_until' => $lockoutInfo['locked_until'],
            ];
        }

        // Verify the password
        if (self::verifyPassword($password)) {
            // Successful login
            self::recordLoginAttempt($ip, true);
            self::clearFailedAttempts($ip);

            // Regenerate session ID to prevent session fixation
            session_regenerate_id(true);

            $_SESSION['authenticated'] = true;
            $_SESSION['login_time'] = time();
            $_SESSION['last_activity'] = time();
            $_SESSION['ip_address'] = $ip;

            // Generate CSRF token for the session
            $_SESSION[CSRF_TOKEN_NAME] = self::generateCsrfToken();

            return ['success' => true];
        }

        // Failed login
        self::recordLoginAttempt($ip, false);
        $failedCount = self::getRecentFailedAttempts($ip);
        $remaining = max(0, MAX_LOGIN_ATTEMPTS - $failedCount);

        $error = 'Invalid password. Please try again.';
        if ($remaining <= 3 && $remaining > 0) {
            $error = "Invalid password. $remaining attempt(s) remaining before lockout.";
        } elseif ($remaining === 0) {
            $error = 'Too many failed login attempts. Your access has been temporarily locked.';
        }

        return [
            'success' => false,
            'error' => $error,
            'remaining_attempts' => $remaining,
        ];
    }

    /**
     * Log out the current user
     */
    public static function logout(): void
    {
        self::startSession();

        $_SESSION = [];

        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(
                session_name(),
                '',
                time() - 42000,
                $params['path'],
                $params['domain'],
                $params['secure'],
                $params['httponly']
            );
        }

        session_destroy();
    }

    /**
     * Require authentication - redirect to login if not authenticated
     */
    public static function requireAuth(): void
    {
        if (!self::isAuthenticated()) {
            header('Location: index.php?action=login');
            exit;
        }
    }

    // -------------------------------------------------------------------------
    // CSRF Protection
    // -------------------------------------------------------------------------

    /**
     * Generate a cryptographically secure CSRF token
     */
    public static function generateCsrfToken(): string
    {
        return bin2hex(random_bytes(32));
    }

    /**
     * Get the current CSRF token (generates one if not yet set)
     */
    public static function getCsrfToken(): string
    {
        self::startSession();

        if (empty($_SESSION[CSRF_TOKEN_NAME])) {
            $_SESSION[CSRF_TOKEN_NAME] = self::generateCsrfToken();
        }

        return $_SESSION[CSRF_TOKEN_NAME];
    }

    /**
     * Validate a CSRF token from a request.
     * Checks both POST body and X-CSRF-Token header.
     */
    public static function validateCsrfToken(): bool
    {
        self::startSession();

        $sessionToken = $_SESSION[CSRF_TOKEN_NAME] ?? '';
        if (empty($sessionToken)) {
            return false;
        }

        // Check header first (used by JS/AJAX requests)
        $headerToken = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!empty($headerToken) && hash_equals($sessionToken, $headerToken)) {
            return true;
        }

        // Check POST body (used by HTML forms)
        $postToken = $_POST[CSRF_TOKEN_NAME] ?? '';
        if (!empty($postToken) && hash_equals($sessionToken, $postToken)) {
            return true;
        }

        return false;
    }

    /**
     * Require a valid CSRF token for state-changing requests.
     * Returns 403 JSON response if invalid.
     */
    public static function requireCsrfToken(): void
    {
        if (!self::validateCsrfToken()) {
            http_response_code(403);
            echo json_encode(['error' => 'Invalid or missing CSRF token']);
            exit;
        }
    }

    // -------------------------------------------------------------------------
    // Brute Force Protection
    // -------------------------------------------------------------------------

    /**
     * Get the client's IP address
     */
    public static function getClientIp(): string
    {
        // Check for forwarded IP (behind proxy/load balancer)
        if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $ips = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
            $ip = trim($ips[0]);
        } elseif (!empty($_SERVER['HTTP_X_REAL_IP'])) {
            $ip = $_SERVER['HTTP_X_REAL_IP'];
        } else {
            $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        }

        // Validate IP format
        if (filter_var($ip, FILTER_VALIDATE_IP)) {
            return $ip;
        }

        return '0.0.0.0';
    }

    /**
     * Record a login attempt in the database
     */
    private static function recordLoginAttempt(string $ip, bool $success): void
    {
        try {
            $db = Database::getInstance();
            $stmt = $db->prepare("INSERT INTO login_attempts (ip_address, success) VALUES (:ip, :success)");
            $stmt->execute([
                'ip' => $ip,
                'success' => $success ? 1 : 0,
            ]);

            // Periodically clean old attempts (older than 24 hours)
            $db->exec("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-24 hours')");
        } catch (Exception $e) {
            // Silently fail - don't break login flow over logging issues
        }
    }

    /**
     * Get the number of recent failed login attempts for an IP
     */
    private static function getRecentFailedAttempts(string $ip): int
    {
        try {
            $db = Database::getInstance();
            $cutoff = date('Y-m-d H:i:s', time() - LOGIN_LOCKOUT_DURATION);

            $stmt = $db->prepare("
                SELECT COUNT(*) FROM login_attempts
                WHERE ip_address = :ip
                  AND success = 0
                  AND attempted_at > :cutoff
            ");
            $stmt->execute(['ip' => $ip, 'cutoff' => $cutoff]);

            return (int) $stmt->fetchColumn();
        } catch (Exception $e) {
            return 0;
        }
    }

    /**
     * Check if an IP is currently locked out
     *
     * @return array{locked: bool, locked_until?: int, failed_attempts: int}
     */
    public static function getLockoutInfo(string $ip): array
    {
        $failedAttempts = self::getRecentFailedAttempts($ip);

        if ($failedAttempts >= MAX_LOGIN_ATTEMPTS) {
            // Find the most recent failed attempt time
            try {
                $db = Database::getInstance();
                $stmt = $db->prepare("
                    SELECT attempted_at FROM login_attempts
                    WHERE ip_address = :ip AND success = 0
                    ORDER BY attempted_at DESC
                    LIMIT 1
                ");
                $stmt->execute(['ip' => $ip]);
                $lastAttempt = $stmt->fetchColumn();

                if ($lastAttempt) {
                    $lockedUntil = strtotime($lastAttempt) + LOGIN_LOCKOUT_DURATION;
                    if (time() < $lockedUntil) {
                        return [
                            'locked' => true,
                            'locked_until' => $lockedUntil,
                            'failed_attempts' => $failedAttempts,
                        ];
                    }
                }
            } catch (Exception $e) {
                // If we can't check, allow the attempt
            }
        }

        return [
            'locked' => false,
            'failed_attempts' => $failedAttempts,
        ];
    }

    /**
     * Clear failed login attempts for an IP (on successful login)
     */
    private static function clearFailedAttempts(string $ip): void
    {
        try {
            $db = Database::getInstance();
            $stmt = $db->prepare("DELETE FROM login_attempts WHERE ip_address = :ip AND success = 0");
            $stmt->execute(['ip' => $ip]);
        } catch (Exception $e) {
            // Silently fail
        }
    }

    // -------------------------------------------------------------------------
    // Security Headers
    // -------------------------------------------------------------------------

    /**
     * Send security HTTP headers.
     * Call this early in every entry point.
     */
    public static function sendSecurityHeaders(): void
    {
        // Prevent clickjacking
        header('X-Frame-Options: DENY');

        // Prevent MIME type sniffing
        header('X-Content-Type-Options: nosniff');

        // Enable XSS filter in older browsers
        header('X-XSS-Protection: 1; mode=block');

        // Control referrer information
        header('Referrer-Policy: strict-origin-when-cross-origin');

        // Permissions policy - disable unnecessary browser features
        header('Permissions-Policy: camera=(), microphone=(), geolocation=()');

        // Content Security Policy
        header("Content-Security-Policy: default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org; connect-src 'self' https://nominatim.openstreetmap.org");

        // Prevent caching of sensitive pages
        if (self::isAuthenticated()) {
            header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
            header('Pragma: no-cache');
        }
    }

    // -------------------------------------------------------------------------
    // Input Validation Helpers
    // -------------------------------------------------------------------------

    /**
     * Sanitize a string input - trim and limit length
     */
    public static function sanitizeString(?string $input, int $maxLength = 255): ?string
    {
        if ($input === null) {
            return null;
        }

        $input = trim($input);
        if (mb_strlen($input) > $maxLength) {
            $input = mb_substr($input, 0, $maxLength);
        }

        return $input;
    }

    /**
     * Validate and sanitize an email address
     */
    public static function sanitizeEmail(?string $email): ?string
    {
        if ($email === null || trim($email) === '') {
            return null;
        }

        $email = trim($email);
        $filtered = filter_var($email, FILTER_SANITIZE_EMAIL);

        if ($filtered && filter_var($filtered, FILTER_VALIDATE_EMAIL)) {
            return $filtered;
        }

        // Return trimmed original if it doesn't validate
        // (to not silently drop data, but the front-end can warn)
        return self::sanitizeString($email, 255);
    }

    /**
     * Sanitize a phone number - keep only digits, spaces, +, -, (, )
     */
    public static function sanitizePhone(?string $phone): ?string
    {
        if ($phone === null || trim($phone) === '') {
            return null;
        }

        $phone = trim($phone);
        // Remove anything that isn't a digit, space, +, -, (, ), or /
        $clean = preg_replace('/[^0-9\s\+\-\(\)\/]/', '', $phone);

        return self::sanitizeString($clean, 50);
    }

    /**
     * Sanitize a URL
     */
    public static function sanitizeUrl(?string $url): ?string
    {
        if ($url === null || trim($url) === '') {
            return null;
        }

        $url = trim($url);

        // Block javascript: and data: URLs
        $lower = strtolower($url);
        if (preg_match('/^(javascript|data|vbscript):/i', $lower)) {
            return null;
        }

        return self::sanitizeString($url, 2048);
    }

    /**
     * Sanitize contact input data array
     */
    public static function sanitizeContactInput(array $data): array
    {
        return [
            'name' => self::sanitizeString($data['name'] ?? null, 255),
            'company' => self::sanitizeString($data['company'] ?? null, 255),
            'location' => self::sanitizeString($data['location'] ?? null, 255),
            'latitude' => isset($data['latitude']) ? (float) $data['latitude'] : null,
            'longitude' => isset($data['longitude']) ? (float) $data['longitude'] : null,
            'note' => self::sanitizeString($data['note'] ?? null, 10000),
            'email' => self::sanitizeEmail($data['email'] ?? null),
            'phone' => self::sanitizePhone($data['phone'] ?? null),
            'website' => self::sanitizeUrl($data['website'] ?? null),
            'address' => self::sanitizeString($data['address'] ?? null, 1000),
        ];
    }
}
