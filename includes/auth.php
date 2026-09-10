<?php
/**
 * Authentication Handler
 * Secure password-based authentication with session management,
 * brute force protection, CSRF tokens, and security headers.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
// This file is library code. It must only ever be loaded through an entry
// point (index.php or api/*.php), each of which defines APP_ROOT first.
// nginx ignores .htaccess, so this check - not the deny rules - is the
// portable backstop that stops the file being requested from a browser.
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

// Auth resolves accounts through the User model, so every entry point that
// pulls in auth.php gets it without having to remember the extra require.
require_once APP_ROOT . '/includes/User.php';

class Auth
{
    /** Per-request nonce that whitelists the application's own inline scripts. */
    private static ?string $cspNonce = null;

    /**
     * Return the Content-Security-Policy nonce for this request.
     *
     * The CSP does not allow 'unsafe-inline' for scripts, so the two inline
     * <script> blocks in index.php have to carry this nonce to be allowed to
     * run. It is generated once per request and stays constant for it.
     */
    public static function getCspNonce(): string
    {
        if (self::$cspNonce === null) {
            self::$cspNonce = base64_encode(random_bytes(16));
        }

        return self::$cspNonce;
    }

    /**
     * True when the current request reached us over TLS.
     */
    public static function isHttps(): bool
    {
        if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
            return true;
        }

        if (isset($_SERVER['SERVER_PORT']) && (int) $_SERVER['SERVER_PORT'] === 443) {
            return true;
        }

        if (TRUST_PROXY_HEADERS) {
            if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO'])
                && strtolower((string) $_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') {
                return true;
            }
            if (!empty($_SERVER['HTTP_X_FORWARDED_SSL'])
                && strtolower((string) $_SERVER['HTTP_X_FORWARDED_SSL']) === 'on') {
                return true;
            }
        }

        return false;
    }

    /**
     * Start session with secure configuration
     */
    public static function startSession(): void
    {
        if (session_status() === PHP_SESSION_NONE) {
            $isHttps = self::isHttps();

            // Harden session handling against fixation and cookie downgrade issues.
            ini_set('session.use_strict_mode', '1');
            ini_set('session.use_only_cookies', '1');
            ini_set('session.cookie_httponly', '1');
            ini_set('session.cookie_samesite', 'Strict');
            ini_set('session.gc_maxlifetime', (string) SESSION_LIFETIME);
            // Do not let the session id travel in URLs even if the host enables it.
            ini_set('session.use_trans_sid', '0');

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

        // Enforce the idle timeout. last_activity was already being recorded but
        // never checked, so a stolen session cookie stayed valid for the full
        // 24 hours regardless of whether anyone was using it.
        if (isset($_SESSION['last_activity'])) {
            if (time() - (int) $_SESSION['last_activity'] > SESSION_IDLE_TIMEOUT) {
                self::logout();
                return false;
            }
        }

        // A session is only as valid as the account behind it. Disabling or
        // deleting a user, or that user changing their password, has to take
        // effect on their next request - not whenever their cookie expires.
        if (!self::sessionAccountStillValid()) {
            self::logout();
            return false;
        }

        // Refresh last activity timestamp
        $_SESSION['last_activity'] = time();

        return true;
    }

    /**
     * Re-check the database row behind the current session.
     *
     * The owner login has no row and is always valid. For everyone else the
     * account must still exist, still be active, and must not have had its
     * password changed since this session was created.
     */
    private static function sessionAccountStillValid(): bool
    {
        if (!empty($_SESSION['is_owner'])) {
            return true;
        }

        $userId = (int) ($_SESSION['user_id'] ?? 0);
        if ($userId <= 0) {
            return false;
        }

        // Resolved once per request; every endpoint calls isAuthenticated().
        static $cache = [];
        $key = $userId . ':' . (int) ($_SESSION['login_time'] ?? 0);
        if (isset($cache[$key])) {
            return $cache[$key];
        }

        try {
            $db = Database::getInstance();
            $stmt = $db->prepare(
                "SELECT status, role, name, password_changed_at FROM users WHERE id = :id"
            );
            $stmt->execute(['id' => $userId]);
            $row = $stmt->fetch();
        } catch (Throwable $e) {
            // Fail closed rather than granting access on a broken query.
            return $cache[$key] = false;
        }

        if (!$row || $row['status'] !== User::STATUS_ACTIVE) {
            return $cache[$key] = false;
        }

        // Password-change revocation by exact stamp rather than by comparing
        // clocks. The session remembers the password_changed_at it was created
        // with; any difference means the password has changed since, so the
        // session dies. Comparing timestamps instead needed a slack window to
        // survive a set-password-then-sign-in in the same second, and that same
        // slack let a session created in that second outlive the change.
        if (($_SESSION['pw_stamp'] ?? null) !== (string) ($row['password_changed_at'] ?? '')) {
            return $cache[$key] = false;
        }

        // Keep the session's copy of role and name in step with the database so
        // a demotion applies immediately rather than at next sign-in.
        $_SESSION['role'] = User::normalizeRole($row['role']);
        $_SESSION['user_name'] = (string) $row['name'];

        return $cache[$key] = true;
    }

    /**
     * Verify a password against the owner password from .env.
     *
     * Supports a password hash (recommended) and falls back to a constant-time
     * comparison for a plaintext value.
     */
    public static function verifyPassword(string $password): bool
    {
        $stored = (string) APP_PASSWORD;

        if (preg_match('/^\$(?:2[yab]|argon2(?:id|i|d)?)\$/', $stored)) {
            return password_verify($password, $stored);
        }

        return hash_equals($stored, $password);
    }

    // -------------------------------------------------------------------------
    // Current identity
    // -------------------------------------------------------------------------

    /**
     * The signed-in identity, or null.
     *
     * @return array{id: ?int, name: string, email: ?string, role: string, is_owner: bool}|null
     */
    public static function currentUser(): ?array
    {
        self::startSession();

        if (empty($_SESSION['authenticated'])) {
            return null;
        }

        return [
            'id' => isset($_SESSION['user_id']) ? (int) $_SESSION['user_id'] : null,
            'name' => (string) ($_SESSION['user_name'] ?? OWNER_DISPLAY_NAME),
            'email' => $_SESSION['user_email'] ?? null,
            'role' => (string) ($_SESSION['role'] ?? User::ROLE_MEMBER),
            'is_owner' => !empty($_SESSION['is_owner']),
        ];
    }

    /**
     * The actor to stamp onto whatever this request writes.
     *
     * @return array{id: ?int, name: string}
     */
    public static function actor(): array
    {
        $user = self::currentUser();

        if ($user === null) {
            return ['id' => null, 'name' => 'System'];
        }

        return ['id' => $user['id'], 'name' => $user['name']];
    }

    public static function isAdmin(): bool
    {
        $user = self::currentUser();

        return $user !== null && ($user['is_owner'] || $user['role'] === User::ROLE_ADMIN);
    }

    /**
     * Refuse the request unless the caller is an administrator.
     */
    public static function requireAdmin(): void
    {
        if (!self::isAdmin()) {
            http_response_code(403);
            header('Content-Type: application/json');
            echo json_encode(['error' => 'Administrator access required']);
            exit;
        }
    }

    // -------------------------------------------------------------------------
    // Login
    // -------------------------------------------------------------------------

    /**
     * Attempt to sign in.
     *
     * An empty email means the owner login (the APP_PASSWORD from .env), which
     * is the recovery path that always works. Anything else is looked up in the
     * users table.
     *
     * Brute force is throttled twice over: per IP and per identity. Otherwise an
     * attacker spread across many IPs could grind one account, or a single IP
     * could spread its attempts across many accounts and never trip the limit.
     *
     * @return array{success: bool, error?: string, remaining_attempts?: int, locked_until?: int}
     */
    public static function login(string $email, string $password): array
    {
        self::startSession();

        $ip = self::getClientIp();
        $normalizedEmail = User::normalizeEmail($email);
        $isOwnerAttempt = trim($email) === '';
        $identity = $isOwnerAttempt ? '__owner__' : ($normalizedEmail ?? mb_strtolower(trim($email)));

        foreach ([$ip, $identity] as $scope) {
            $lockout = self::getLockoutInfo($scope);
            if ($lockout['locked']) {
                return [
                    'success' => false,
                    'error' => 'Too many failed sign-in attempts. Please try again later.',
                    'locked_until' => $lockout['locked_until'],
                ];
            }
        }

        $authenticated = null;

        if ($isOwnerAttempt) {
            if (self::verifyPassword($password)) {
                $authenticated = [
                    'id' => null,
                    'name' => OWNER_DISPLAY_NAME,
                    'email' => null,
                    'role' => User::ROLE_ADMIN,
                    'is_owner' => true,
                ];
            }
        } elseif ($normalizedEmail !== null) {
            $authenticated = self::authenticateAccount($normalizedEmail, $password);
        } else {
            // Not a valid address. Still spend what a real verify costs, so the
            // response does not reveal which addresses are even well formed.
            self::dummyPasswordCheck();
        }

        if ($authenticated !== null) {
            self::recordLoginAttempt($ip, true, $identity);
            self::clearFailedAttempts($ip);
            self::clearFailedAttempts($identity);

            self::establishSession($authenticated, $ip);

            if ($authenticated['id'] !== null) {
                try {
                    (new User())->recordLogin((int) $authenticated['id']);
                } catch (Throwable $e) {
                    // A failed bookkeeping update must not block the sign-in.
                }
            }

            return ['success' => true];
        }

        self::recordLoginAttempt($ip, false, $identity);

        $failedForIdentity = self::getRecentFailedAttempts($identity);
        $failedForIp = self::getRecentFailedAttempts($ip);
        $remaining = max(0, MAX_LOGIN_ATTEMPTS - max($failedForIdentity, $failedForIp));

        // One message for unknown, disabled and wrong-password alike, so the
        // form cannot be used to discover who has an account here.
        $error = 'Incorrect email or password.';
        if ($remaining <= 3 && $remaining > 0) {
            $error = "Incorrect email or password. $remaining attempt(s) remaining before lockout.";
        } elseif ($remaining === 0) {
            $error = 'Too many failed sign-in attempts. Access has been temporarily locked.';
        }

        return [
            'success' => false,
            'error' => $error,
            'remaining_attempts' => $remaining,
        ];
    }

    /**
     * Verify an email + password pair against the users table.
     *
     * @return array|null The identity to sign in as, or null.
     */
    private static function authenticateAccount(string $email, string $password): ?array
    {
        try {
            $model = new User();
            $row = $model->findForAuth($email);
        } catch (Throwable $e) {
            error_log('login lookup failed: ' . $e->getMessage());
            return null;
        }

        // Unknown address, or one that has not chosen a password yet: burn the
        // time a real check would take, so response timing does not separate
        // "no such user" from "wrong password".
        if (!$row || empty($row['password_hash'])) {
            self::dummyPasswordCheck();
            return null;
        }

        if (!password_verify($password, (string) $row['password_hash'])) {
            return null;
        }

        // Correct password, but the account is not allowed in.
        if (($row['status'] ?? '') !== User::STATUS_ACTIVE) {
            return null;
        }

        // Opportunistically upgrade the stored hash when PHP's default changes.
        if (password_needs_rehash((string) $row['password_hash'], PASSWORD_DEFAULT)) {
            try {
                $db = Database::getInstance();
                $stmt = $db->prepare("UPDATE users SET password_hash = :hash WHERE id = :id");
                $stmt->execute([
                    'hash' => password_hash($password, PASSWORD_DEFAULT),
                    'id' => (int) $row['id'],
                ]);
            } catch (Throwable $e) {
                // Keeping the old hash is fine; it still verifies.
            }
        }

        return [
            'id' => (int) $row['id'],
            'name' => (string) $row['name'],
            'email' => (string) $row['email'],
            'role' => User::normalizeRole($row['role']),
            'is_owner' => false,
        ];
    }

    /**
     * Spend roughly one password_verify worth of time against a fixed hash.
     *
     * Without this, a request for an address that does not exist returns
     * measurably faster than one that does, which turns the sign-in form into
     * an account-enumeration oracle.
     */
    private static function dummyPasswordCheck(): void
    {
        static $dummyHash = null;
        if ($dummyHash === null) {
            $dummyHash = password_hash('timing-equalizer', PASSWORD_DEFAULT);
        }

        password_verify('timing-equalizer-attempt', $dummyHash);
    }

    /**
     * Write a freshly authenticated identity into the session.
     */
    private static function establishSession(array $identity, string $ip): void
    {
        // Regenerate the session ID so a fixated pre-login ID cannot be reused.
        session_regenerate_id(true);

        $_SESSION['authenticated'] = true;
        $_SESSION['login_time'] = time();
        $_SESSION['last_activity'] = time();
        $_SESSION['ip_address'] = $ip;

        $_SESSION['user_id'] = $identity['id'];
        $_SESSION['user_name'] = $identity['name'];
        $_SESSION['user_email'] = $identity['email'];
        $_SESSION['role'] = $identity['role'];
        $_SESSION['is_owner'] = (bool) $identity['is_owner'];

        // Bind the session to the password it was opened with. Changing the
        // password moves this value on and every older session stops matching.
        $_SESSION['pw_stamp'] = $identity['is_owner']
            ? null
            : self::readPasswordStamp((int) $identity['id']);

        // A new session gets a new CSRF token.
        $_SESSION[CSRF_TOKEN_NAME] = self::generateCsrfToken();
    }

    /**
     * The account's current password_changed_at, verbatim.
     *
     * Stored on the session at sign-in and compared on every later request, so
     * the comparison is a string match rather than clock arithmetic.
     */
    private static function readPasswordStamp(int $userId): string
    {
        try {
            $db = Database::getInstance();
            $stmt = $db->prepare("SELECT password_changed_at FROM users WHERE id = :id");
            $stmt->execute(['id' => $userId]);

            return (string) ($stmt->fetchColumn() ?: '');
        } catch (Throwable $e) {
            return '';
        }
    }

    /**
     * Sign the current identity in immediately after they set a password.
     *
     * Used by the invite / reset flow so a new user lands in the CRM instead of
     * being bounced back to a login form they just proved themselves against.
     */
    public static function loginAsUserId(int $userId): bool
    {
        try {
            $row = (new User())->getById($userId);
        } catch (Throwable $e) {
            return false;
        }

        if ($row === null || $row['status'] !== User::STATUS_ACTIVE) {
            return false;
        }

        self::startSession();
        self::establishSession([
            'id' => (int) $row['id'],
            'name' => (string) $row['name'],
            'email' => (string) $row['email'],
            'role' => User::normalizeRole($row['role']),
            'is_owner' => false,
        ], self::getClientIp());

        return true;
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
        $remoteIp = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';

        // By default do not trust proxy headers because they are client-controlled.
        if (!TRUST_PROXY_HEADERS) {
            return filter_var($remoteIp, FILTER_VALIDATE_IP) ? $remoteIp : '0.0.0.0';
        }

        $ip = $remoteIp;
        if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $ips = explode(',', (string) $_SERVER['HTTP_X_FORWARDED_FOR']);
            $candidate = trim((string) ($ips[0] ?? ''));
            if ($candidate !== '') {
                $ip = $candidate;
            }
        } elseif (!empty($_SERVER['HTTP_X_REAL_IP'])) {
            $ip = (string) $_SERVER['HTTP_X_REAL_IP'];
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
    private static function recordLoginAttempt(string $ip, bool $success, string $identity = ''): void
    {
        try {
            $db = Database::getInstance();
            $stmt = $db->prepare(
                "INSERT INTO login_attempts (ip_address, identifier, success) VALUES (:ip, :identifier, :success)"
            );
            $stmt->execute([
                'ip' => $ip,
                'identifier' => $identity,
                'success' => $success ? 1 : 0,
            ]);

            // Periodically clean old attempts (older than 24 hours)
            $db->exec("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-24 hours')");
        } catch (Exception $e) {
            // Silently fail - don't break login flow over logging issues
        }
    }

    /**
     * Count recent failed sign-ins for a throttling scope.
     *
     * A scope is either an IP address or an identity (an email address, or
     * '__owner__' for the owner login). The two value spaces cannot overlap, so
     * one query matching either column serves both without a mode flag.
     */
    private static function getRecentFailedAttempts(string $scope): int
    {
        if ($scope === '') {
            return 0;
        }

        try {
            $db = Database::getInstance();
            // attempted_at defaults to SQLite CURRENT_TIMESTAMP, which is UTC,
            // so the cutoff has to be UTC too - otherwise the lockout window is
            // off by the server's offset in whichever direction hurts.
            $cutoff = gmdate('Y-m-d H:i:s', time() - LOGIN_LOCKOUT_DURATION);

            $stmt = $db->prepare("
                SELECT COUNT(*) FROM login_attempts
                WHERE (ip_address = :scope OR identifier = :scope)
                  AND success = 0
                  AND attempted_at > :cutoff
            ");
            $stmt->execute(['scope' => $scope, 'cutoff' => $cutoff]);

            return (int) $stmt->fetchColumn();
        } catch (Exception $e) {
            return 0;
        }
    }

    /**
     * Check whether a throttling scope (IP or identity) is locked out.
     *
     * @return array{locked: bool, locked_until?: int, failed_attempts: int}
     */
    public static function getLockoutInfo(string $scope): array
    {
        $failedAttempts = self::getRecentFailedAttempts($scope);

        if ($failedAttempts >= MAX_LOGIN_ATTEMPTS) {
            // Find the most recent failed attempt time
            try {
                $db = Database::getInstance();
                $stmt = $db->prepare("
                    SELECT attempted_at FROM login_attempts
                    WHERE (ip_address = :scope OR identifier = :scope) AND success = 0
                    ORDER BY attempted_at DESC
                    LIMIT 1
                ");
                $stmt->execute(['scope' => $scope]);
                $lastAttempt = $stmt->fetchColumn();

                if ($lastAttempt) {
                    $lockedUntil = strtotime($lastAttempt . ' UTC') + LOGIN_LOCKOUT_DURATION;
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
     * Clear failed sign-ins for a scope (on a successful sign-in)
     */
    private static function clearFailedAttempts(string $scope): void
    {
        if ($scope === '') {
            return;
        }

        try {
            $db = Database::getInstance();
            $stmt = $db->prepare(
                "DELETE FROM login_attempts WHERE (ip_address = :scope OR identifier = :scope) AND success = 0"
            );
            $stmt->execute(['scope' => $scope]);
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
        // Do not advertise the PHP version to scanners.
        header_remove('X-Powered-By');

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
        header('Cross-Origin-Opener-Policy: same-origin');
        header('Cross-Origin-Resource-Policy: same-origin');

        // HTTP Strict Transport Security.
        // Only sent over TLS - sending it over plain HTTP is ignored by browsers
        // and would pin an unreachable scheme if the site were ever HTTP-only.
        if (self::isHttps()) {
            header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
        }

        // Content Security Policy.
        //
        // script-src deliberately has no 'unsafe-inline': the application's own
        // two inline blocks in index.php carry the per-request nonce instead, so
        // injected markup cannot execute even if it reaches the DOM.
        // 'unsafe-inline' stays for style-src because the UI sets inline styles
        // (tag colours, map layout); inline CSS is not an execution primitive.
        $nonce = self::getCspNonce();
        header(
            "Content-Security-Policy: "
            . "default-src 'self'; "
            . "base-uri 'self'; "
            . "object-src 'none'; "
            . "frame-ancestors 'none'; "
            . "form-action 'self'; "
            . "frame-src 'self'; "
            . "worker-src 'self'; "
            . "manifest-src 'self'; "
            . "script-src 'self' 'nonce-{$nonce}' https://unpkg.com; "
            . "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; "
            . "font-src 'self' https://fonts.gstatic.com; "
            . "img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org; "
            . "connect-src 'self' https://nominatim.openstreetmap.org"
        );

        // Prevent caching of sensitive pages
        self::startSession();
        if (!empty($_SESSION['authenticated'])) {
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

    /**
     * Parse JSON request body into an array.
     * Returns null for invalid JSON or non-object/non-array payloads.
     */
    public static function getJsonInput(): ?array
    {
        $raw = file_get_contents('php://input');
        if ($raw === false) {
            return null;
        }

        $raw = trim($raw);
        if ($raw === '') {
            return [];
        }

        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }
}
