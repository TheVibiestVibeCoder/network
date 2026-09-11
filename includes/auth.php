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

        // Every failure below ends the session and then falls through to the
        // remember-me cookie, which is the whole point of that cookie: a
        // session that has merely aged out should not cost a password.
        // Explicitly signing out is different - logout() deletes the token
        // first, so there is nothing left here to be let back in by.
        if (!isset($_SESSION['authenticated']) || $_SESSION['authenticated'] !== true) {
            return self::attemptRememberLogin();
        }

        // Enforce server-side session timeout
        if (!isset($_SESSION['login_time'])) {
            // No login_time set - invalid session
            self::endSession();
            return self::attemptRememberLogin();
        }

        if (time() - $_SESSION['login_time'] > SESSION_LIFETIME) {
            self::endSession();
            return self::attemptRememberLogin();
        }

        // Enforce the idle timeout. last_activity was already being recorded but
        // never checked, so a stolen session cookie stayed valid for the full
        // 24 hours regardless of whether anyone was using it.
        if (isset($_SESSION['last_activity'])
            && time() - (int) $_SESSION['last_activity'] > SESSION_IDLE_TIMEOUT) {
            self::endSession();
            return self::attemptRememberLogin();
        }

        // A session is only as valid as the account behind it. Disabling or
        // deleting a user, or that user changing their password, has to take
        // effect on their next request - not whenever their cookie expires.
        //
        // Falling through to the cookie is safe here: a remember token carries
        // the same status and password checks, so a disabled account or a
        // changed password fails both and the token is dropped on the way out.
        if (!self::sessionAccountStillValid()) {
            self::endSession();
            return self::attemptRememberLogin();
        }

        // Refresh last activity timestamp
        $_SESSION['last_activity'] = time();

        return true;
    }

    /**
     * Empty the session without destroying it or touching any cookie.
     *
     * Used for sessions that expired rather than sessions that were signed out
     * of: the session must stay open so that establishSession() can regenerate
     * its id if the remember-me cookie immediately reopens it.
     */
    private static function endSession(): void
    {
        $_SESSION = [];
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
    public static function login(string $email, string $password, bool $remember = false): array
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
            // The password was right, so this IP is no longer suspect even if
            // the second factor is still outstanding.
            self::recordLoginAttempt($ip, true, $identity);
            self::clearFailedAttempts($ip);
            self::clearFailedAttempts($identity);

            // The owner has no registered address to send a code to, and is the
            // recovery path that must keep working when mail does not. It stays
            // single-factor by design; every account with an inbox does not.
            if (self::twoFactorRequiredFor($authenticated)) {
                return self::beginTwoFactor($authenticated, $ip, $remember);
            }

            self::completeLogin($authenticated, $ip, $remember);

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

    // -------------------------------------------------------------------------
    // Two-factor sign-in
    // -------------------------------------------------------------------------

    /**
     * Does this identity have to pass a one-time code?
     *
     * Only accounts with an inbox can. The owner login has no registered
     * address and is the documented way back in when everything else is
     * broken, so it is exempt - see TWO_FACTOR_ENABLED in config.php.
     */
    private static function twoFactorRequiredFor(array $identity): bool
    {
        if (!TWO_FACTOR_ENABLED) {
            return false;
        }
        if (!empty($identity['is_owner']) || $identity['id'] === null) {
            return false;
        }

        return filter_var((string) $identity['email'], FILTER_VALIDATE_EMAIL) !== false;
    }

    /**
     * Finish a sign-in: open the session, and optionally the remember cookie.
     */
    private static function completeLogin(array $identity, string $ip, bool $remember): void
    {
        self::establishSession($identity, $ip);

        if ($remember && $identity['id'] !== null) {
            self::issueRememberToken((int) $identity['id']);
        }

        if ($identity['id'] !== null) {
            try {
                (new User())->recordLogin((int) $identity['id']);
            } catch (Throwable $e) {
                // A failed bookkeeping update must not block the sign-in.
            }
        }
    }

    /**
     * Open a two-factor challenge and mail the code out.
     *
     * The session gets only the challenge id. Everything that decides who is
     * being signed in lives in the row, so nothing a client can reach names the
     * account - editing the cookie can at most point at a challenge that is not
     * yours, and that challenge still needs its own code.
     *
     * @return array{success: bool, challenge?: string, error?: string, delivered?: bool, debug_code?: string}
     */
    private static function beginTwoFactor(array $identity, string $ip, bool $remember): array
    {
        $userId = (int) $identity['id'];

        if (!self::codeRequestAllowed($userId)) {
            return [
                'success' => false,
                'error' => 'Too many sign-in codes requested. Please try again later.',
            ];
        }

        // Six digits, uniformly drawn. random_int is the CSPRNG - mt_rand would
        // make the code predictable from a couple of observed ones.
        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $challengeId = bin2hex(random_bytes(32));

        try {
            $db = Database::getInstance();

            // One live challenge per account. Without this, a second sign-in
            // attempt would leave the first code valid, so two codes would open
            // the same door and only one of them was ever read by its owner.
            $stmt = $db->prepare("DELETE FROM login_challenges WHERE user_id = :uid AND consumed_at IS NULL");
            $stmt->execute(['uid' => $userId]);

            $stmt = $db->prepare("
                INSERT INTO login_challenges (challenge_id, user_id, code_hash, remember, ip_address, expires_at)
                VALUES (:cid, :uid, :hash, :remember, :ip, :expires)
            ");
            $stmt->execute([
                'cid' => $challengeId,
                'uid' => $userId,
                // password_hash, not a bare SHA: the code is only a million
                // wide, so the stored form has to be slow to try offline.
                'hash' => password_hash($code, PASSWORD_DEFAULT),
                'remember' => $remember ? 1 : 0,
                'ip' => $ip,
                // gmdate to match SQLite's CURRENT_TIMESTAMP, which is UTC.
                'expires' => gmdate('Y-m-d H:i:s', time() + LOGIN_CODE_LIFETIME),
            ]);
        } catch (Throwable $e) {
            error_log('two-factor challenge could not be created: ' . $e->getMessage());
            return ['success' => false, 'error' => 'Could not start sign-in. Please try again.'];
        }

        $_SESSION['pending_challenge'] = $challengeId;

        $delivered = Mailer::sendLoginCode(
            (string) $identity['email'],
            (string) $identity['name'],
            $code,
            LOGIN_CODE_LIFETIME
        );

        $result = [
            'success' => false,
            'challenge' => $challengeId,
            'delivered' => $delivered,
        ];

        // Local development has no working MTA, so an undeliverable code would
        // mean nobody can sign in to their own test instance. Showing it is
        // only ever acceptable because the request came from this machine; on
        // any other host the code goes to the log and nowhere else.
        if (!$delivered) {
            error_log('two-factor code for user ' . $userId . ' could not be mailed');
            if (self::isLocalRequest()) {
                $result['debug_code'] = $code;
            }
        }

        return $result;
    }

    /**
     * True when this request came from the machine the app runs on.
     *
     * Used for one thing only: deciding whether an undeliverable sign-in code
     * may be shown on screen. It deliberately looks at the real socket peer and
     * never at a proxy header, which a client controls.
     */
    public static function isLocalRequest(): bool
    {
        $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');

        return in_array($remote, ['127.0.0.1', '::1'], true);
    }

    /**
     * Cap how many codes one account can trigger per hour.
     */
    private static function codeRequestAllowed(int $userId): bool
    {
        try {
            $db = Database::getInstance();
            $stmt = $db->prepare("
                SELECT COUNT(*) FROM login_challenges
                WHERE user_id = :uid AND created_at > datetime('now', '-1 hour')
            ");
            $stmt->execute(['uid' => $userId]);

            return (int) $stmt->fetchColumn() < LOGIN_CODE_MAX_PER_HOUR;
        } catch (Throwable $e) {
            error_log('code throttle check failed: ' . $e->getMessage());
            return false;
        }
    }

    /**
     * The challenge this session is part-way through, or null.
     *
     * @return array|null The challenge row joined to its account.
     */
    public static function pendingChallenge(): ?array
    {
        self::startSession();

        $challengeId = (string) ($_SESSION['pending_challenge'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/', $challengeId)) {
            return null;
        }

        try {
            $db = Database::getInstance();
            $stmt = $db->prepare("
                SELECT c.*, u.email, u.name, u.role, u.status
                FROM login_challenges c
                JOIN users u ON u.id = c.user_id
                WHERE c.challenge_id = :cid
            ");
            $stmt->execute(['cid' => $challengeId]);
            $row = $stmt->fetch();
        } catch (Throwable $e) {
            return null;
        }

        if (!$row || $row['consumed_at'] !== null) {
            return null;
        }
        if (strtotime((string) $row['expires_at'] . ' UTC') < time()) {
            return null;
        }
        if ($row['status'] !== User::STATUS_ACTIVE) {
            return null;
        }

        return $row;
    }

    /**
     * Check a submitted code and, if it matches, sign the account in.
     *
     * @return array{success: bool, error?: string, remaining?: int}
     */
    public static function verifyTwoFactor(string $submitted): array
    {
        self::startSession();

        $row = self::pendingChallenge();
        if ($row === null) {
            return ['success' => false, 'error' => 'This sign-in has expired. Please start again.'];
        }

        $submitted = preg_replace('/\D/', '', $submitted) ?? '';
        $ip = self::getClientIp();

        // Count the attempt before checking it, so a client that abandons the
        // request mid-flight cannot get a free guess.
        try {
            $db = Database::getInstance();
            $db->prepare("UPDATE login_challenges SET attempts = attempts + 1 WHERE id = :id")
               ->execute(['id' => (int) $row['id']]);
        } catch (Throwable $e) {
            return ['success' => false, 'error' => 'Could not verify the code. Please try again.'];
        }

        $attempts = (int) $row['attempts'] + 1;

        if ($attempts > LOGIN_CODE_MAX_ATTEMPTS) {
            self::discardChallenge((int) $row['id']);
            self::recordLoginAttempt($ip, false, (string) $row['email']);

            return ['success' => false, 'error' => 'Too many incorrect codes. Please sign in again.'];
        }

        if ($submitted === '' || !password_verify($submitted, (string) $row['code_hash'])) {
            self::recordLoginAttempt($ip, false, (string) $row['email']);
            $remaining = max(0, LOGIN_CODE_MAX_ATTEMPTS - $attempts);

            return [
                'success' => false,
                'error' => $remaining > 0
                    ? "Incorrect code. $remaining attempt(s) remaining."
                    : 'Incorrect code. Please sign in again.',
                'remaining' => $remaining,
            ];
        }

        // Spend the challenge before opening the session: the UPDATE only
        // matches while consumed_at is still null, so two requests carrying the
        // same code cannot both get through.
        try {
            $db = Database::getInstance();
            $claim = $db->prepare("
                UPDATE login_challenges SET consumed_at = CURRENT_TIMESTAMP
                WHERE id = :id AND consumed_at IS NULL
            ");
            $claim->execute(['id' => (int) $row['id']]);

            if ($claim->rowCount() !== 1) {
                return ['success' => false, 'error' => 'This code has already been used.'];
            }
        } catch (Throwable $e) {
            return ['success' => false, 'error' => 'Could not verify the code. Please try again.'];
        }

        unset($_SESSION['pending_challenge']);
        self::clearFailedAttempts((string) $row['email']);

        self::completeLogin([
            'id' => (int) $row['user_id'],
            'name' => (string) $row['name'],
            'email' => (string) $row['email'],
            'role' => User::normalizeRole($row['role']),
            'is_owner' => false,
        ], $ip, (int) $row['remember'] === 1);

        return ['success' => true];
    }

    /**
     * Send a fresh code for the challenge in flight, keeping its remember flag.
     *
     * @return array{success: bool, error?: string, delivered?: bool, debug_code?: string}
     */
    public static function resendTwoFactor(): array
    {
        $row = self::pendingChallenge();
        if ($row === null) {
            return ['success' => false, 'error' => 'This sign-in has expired. Please start again.'];
        }

        // beginTwoFactor drops the outstanding challenge for this account, so
        // the code just replaced stops working the moment the new one is sent.
        $result = self::beginTwoFactor([
            'id' => (int) $row['user_id'],
            'name' => (string) $row['name'],
            'email' => (string) $row['email'],
            'role' => User::normalizeRole($row['role']),
            'is_owner' => false,
        ], self::getClientIp(), (int) $row['remember'] === 1);

        if (isset($result['challenge'])) {
            return [
                'success' => true,
                'delivered' => $result['delivered'] ?? false,
                'debug_code' => $result['debug_code'] ?? null,
            ];
        }

        return $result;
    }

    /**
     * Drop a challenge and the session's pointer to it.
     */
    private static function discardChallenge(int $id): void
    {
        try {
            Database::getInstance()
                ->prepare("DELETE FROM login_challenges WHERE id = :id")
                ->execute(['id' => $id]);
        } catch (Throwable $e) {
            // Nothing to do: it expires on its own.
        }

        unset($_SESSION['pending_challenge']);
    }

    /**
     * Abandon whatever sign-in is in flight, e.g. "use a different account".
     */
    public static function cancelTwoFactor(): void
    {
        self::startSession();

        $row = self::pendingChallenge();
        if ($row !== null) {
            self::discardChallenge((int) $row['id']);
        }

        unset($_SESSION['pending_challenge']);
    }

    /**
     * Clear out spent and expired challenges.
     */
    public static function pruneChallenges(): void
    {
        try {
            Database::getInstance()->exec(
                "DELETE FROM login_challenges
                 WHERE expires_at < datetime('now') OR consumed_at IS NOT NULL"
            );
        } catch (Throwable $e) {
            // Housekeeping only.
        }
    }

    // -------------------------------------------------------------------------
    // "Remember this device"
    // -------------------------------------------------------------------------
    //
    // The cookie is "<selector>:<validator>". The selector is the lookup key and
    // is stored in the clear; the validator is stored only as a SHA-256 hash.
    // Looking a token up therefore costs one indexed read, and a dump of the
    // table still contains nothing that can be presented as a cookie.
    //
    // SHA-256 rather than password_hash here on purpose: the validator is 32
    // bytes from the CSPRNG, so it has nothing to brute force and does not need
    // a slow hash - unlike the six-digit sign-in code, which does.

    /**
     * Issue a remember-me cookie for an account.
     */
    private static function issueRememberToken(int $userId): void
    {
        if (!REMEMBER_ME_ENABLED) {
            return;
        }

        $selector = bin2hex(random_bytes(16));
        $validator = bin2hex(random_bytes(32));
        $expiresAt = time() + REMEMBER_ME_LIFETIME;

        try {
            $db = Database::getInstance();
            $stmt = $db->prepare("
                INSERT INTO remember_tokens (selector, validator_hash, user_id, pw_stamp, expires_at)
                VALUES (:selector, :hash, :uid, :stamp, :expires)
            ");
            $stmt->execute([
                'selector' => $selector,
                'hash' => hash('sha256', $validator),
                'uid' => $userId,
                // Pins the token to the password it was issued under, so a
                // password change retires every device without a second query.
                'stamp' => self::readPasswordStamp($userId),
                'expires' => gmdate('Y-m-d H:i:s', $expiresAt),
            ]);
        } catch (Throwable $e) {
            error_log('could not issue remember token: ' . $e->getMessage());
            return;
        }

        self::setRememberCookie($selector . ':' . $validator, $expiresAt);
    }

    /**
     * Write (or clear, with an expiry in the past) the remember-me cookie.
     */
    private static function setRememberCookie(string $value, int $expiresAt): void
    {
        if (headers_sent()) {
            return;
        }

        setcookie(REMEMBER_COOKIE_NAME, $value, [
            'expires' => $expiresAt,
            'path' => '/',
            'httponly' => true,
            'samesite' => 'Strict',
            'secure' => self::isHttps(),
        ]);
    }

    /**
     * Try to restore a session from the remember-me cookie.
     *
     * Called when there is no live session. A token that verifies is rotated on
     * the spot, so a cookie is only ever good for one restore.
     */
    public static function attemptRememberLogin(): bool
    {
        if (!REMEMBER_ME_ENABLED || empty($_COOKIE[REMEMBER_COOKIE_NAME])) {
            return false;
        }

        $raw = (string) $_COOKIE[REMEMBER_COOKIE_NAME];
        if (substr_count($raw, ':') !== 1) {
            self::clearRememberCookie();
            return false;
        }

        [$selector, $validator] = explode(':', $raw, 2);
        if (!preg_match('/^[a-f0-9]{32}$/', $selector) || !preg_match('/^[a-f0-9]{64}$/', $validator)) {
            self::clearRememberCookie();
            return false;
        }

        try {
            $db = Database::getInstance();
            $stmt = $db->prepare("
                SELECT t.*, u.name, u.email, u.role, u.status, u.password_changed_at
                FROM remember_tokens t
                JOIN users u ON u.id = t.user_id
                WHERE t.selector = :selector
            ");
            $stmt->execute(['selector' => $selector]);
            $row = $stmt->fetch();
        } catch (Throwable $e) {
            return false;
        }

        if (!$row) {
            self::clearRememberCookie();
            return false;
        }

        $presented = hash('sha256', $validator);
        $current = hash_equals((string) $row['validator_hash'], $presented);

        // The validator this one replaced, if that happened moments ago. A page
        // load fires several requests together, all carrying the cookie the
        // browser held before any of them came back: the first rotates, and the
        // rest legitimately present the value it just superseded.
        $withinGrace = !$current
            && $row['previous_hash'] !== null
            && $row['rotated_at'] !== null
            && hash_equals((string) $row['previous_hash'], $presented)
            && (time() - strtotime((string) $row['rotated_at'] . ' UTC')) <= REMEMBER_ROTATION_GRACE;

        // Neither the current validator nor a freshly retired one: somebody is
        // presenting a copy of this cookie. The real owner's token is gone
        // either way, so drop every token this account holds and make them sign
        // in again - that is the point of splitting the cookie in two.
        if (!$current && !$withinGrace) {
            error_log('remember token reuse detected for user ' . (int) $row['user_id']);
            self::revokeRememberTokensFor((int) $row['user_id']);
            self::clearRememberCookie();
            return false;
        }

        $invalid = strtotime((string) $row['expires_at'] . ' UTC') < time()
            || $row['status'] !== User::STATUS_ACTIVE
            || (string) ($row['pw_stamp'] ?? '') !== (string) ($row['password_changed_at'] ?? '');

        if ($invalid) {
            self::deleteRememberToken($selector);
            self::clearRememberCookie();
            return false;
        }

        // Rotate, but only for the request that presented the live validator.
        // One inside the grace window is a straggler from a rotation that has
        // already happened: it signs in, and leaves both the row and the cookie
        // to the request that won.
        $newValidator = null;
        $rotated = false;
        $expiresAt = time() + REMEMBER_ME_LIFETIME;

        if ($current) {
            $newValidator = bin2hex(random_bytes(32));

            try {
                $stmt = $db->prepare("
                    UPDATE remember_tokens
                    SET validator_hash = :hash,
                        previous_hash = :previous,
                        rotated_at = CURRENT_TIMESTAMP,
                        expires_at = :expires,
                        last_used_at = CURRENT_TIMESTAMP
                    WHERE id = :id AND validator_hash = :old
                ");
                $stmt->execute([
                    'hash' => hash('sha256', $newValidator),
                    'previous' => (string) $row['validator_hash'],
                    'expires' => gmdate('Y-m-d H:i:s', $expiresAt),
                    'id' => (int) $row['id'],
                    'old' => (string) $row['validator_hash'],
                ]);

                // Lost the race by a hair to another request holding the same
                // live validator. It has already sent the new cookie, so this
                // one signs in and leaves the cookie alone.
                $rotated = $stmt->rowCount() === 1;
            } catch (Throwable $e) {
                return false;
            }
        }

        self::startSession();
        self::establishSession([
            'id' => (int) $row['user_id'],
            'name' => (string) $row['name'],
            'email' => (string) $row['email'],
            'role' => User::normalizeRole($row['role']),
            'is_owner' => false,
        ], self::getClientIp());

        // Mark the session as opened by cookie rather than by password. Nothing
        // gates on it yet; it is what a future "confirm your password to change
        // your password" check would read.
        $_SESSION['via_remember'] = true;

        if ($rotated && $newValidator !== null) {
            self::setRememberCookie($selector . ':' . $newValidator, $expiresAt);
        }

        try {
            (new User())->recordLogin((int) $row['user_id']);
        } catch (Throwable $e) {
            // Bookkeeping only.
        }

        return true;
    }

    private static function clearRememberCookie(): void
    {
        if (!empty($_COOKIE[REMEMBER_COOKIE_NAME])) {
            unset($_COOKIE[REMEMBER_COOKIE_NAME]);
        }

        self::setRememberCookie('', time() - 42000);
    }

    private static function deleteRememberToken(string $selector): void
    {
        try {
            Database::getInstance()
                ->prepare("DELETE FROM remember_tokens WHERE selector = :selector")
                ->execute(['selector' => $selector]);
        } catch (Throwable $e) {
            // Expires on its own.
        }
    }

    /**
     * Drop every remembered device for an account.
     *
     * Called on a password change, and when a token looks copied.
     */
    public static function revokeRememberTokensFor(int $userId): void
    {
        try {
            Database::getInstance()
                ->prepare("DELETE FROM remember_tokens WHERE user_id = :uid")
                ->execute(['uid' => $userId]);
        } catch (Throwable $e) {
            error_log('could not revoke remember tokens for user ' . $userId);
        }
    }

    /**
     * Clear out expired tokens.
     */
    public static function pruneRememberTokens(): void
    {
        try {
            Database::getInstance()->exec(
                "DELETE FROM remember_tokens WHERE expires_at < datetime('now')"
            );
        } catch (Throwable $e) {
            // Housekeeping only.
        }
    }

    /**
     * Log out the current user
     */
    public static function logout(): void
    {
        self::startSession();

        // Signing out has to retire this device too, otherwise the next request
        // would be let straight back in by the cookie.
        if (!empty($_COOKIE[REMEMBER_COOKIE_NAME])) {
            $raw = (string) $_COOKIE[REMEMBER_COOKIE_NAME];
            $selector = substr($raw, 0, (int) (strpos($raw, ':') ?: 0));
            if (preg_match('/^[a-f0-9]{32}$/', $selector)) {
                self::deleteRememberToken($selector);
            }
            self::clearRememberCookie();
        }

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
