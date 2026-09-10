<?php
/**
 * User Model
 *
 * Accounts, roles and the invite / password-reset token lifecycle.
 *
 * Two identities exist in this application:
 *   - the OWNER, which is the APP_PASSWORD from .env. It has no database row,
 *     is always an admin, and cannot be deleted or demoted. It is the recovery
 *     path: whatever happens to the users table, the owner can still sign in.
 *   - regular USERS, rows in this table, who sign in with email + password.
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

class User
{
    public const ROLE_ADMIN  = 'admin';
    public const ROLE_MEMBER = 'member';

    public const STATUS_INVITED  = 'invited';
    public const STATUS_ACTIVE   = 'active';
    public const STATUS_DISABLED = 'disabled';

    public const PURPOSE_INVITE = 'invite';
    public const PURPOSE_RESET  = 'reset';

    /** Columns that are safe to hand to the client. password_hash never is. */
    private const PUBLIC_COLUMNS = 'id, email, name, role, status, last_login_at, created_at';

    private PDO $db;

    public function __construct()
    {
        $this->db = Database::getInstance();
    }

    // -------------------------------------------------------------------------
    // Queries
    // -------------------------------------------------------------------------

    /**
     * All accounts, admins first, then alphabetically.
     */
    public function getAll(): array
    {
        $stmt = $this->db->query(
            "SELECT " . self::PUBLIC_COLUMNS . " FROM users
             ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, name COLLATE NOCASE ASC"
        );

        return array_map([$this, 'shape'], $stmt->fetchAll());
    }

    public function getById(int $id): ?array
    {
        $stmt = $this->db->prepare("SELECT " . self::PUBLIC_COLUMNS . " FROM users WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();

        return $row ? $this->shape($row) : null;
    }

    /**
     * Full row including password_hash - for authentication only.
     */
    public function findForAuth(string $email): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM users WHERE email = :email");
        $stmt->execute(['email' => $email]);
        $row = $stmt->fetch();

        return $row ?: null;
    }

    // -------------------------------------------------------------------------
    // Mutations
    // -------------------------------------------------------------------------

    /**
     * Create an invited account. The password is chosen by the user through the
     * emailed link, so a password never passes through the admin's hands.
     *
     * @return array{user: array, token: string, expires_at: int}
     */
    public function invite(string $email, string $name, string $role): array
    {
        $role = self::normalizeRole($role);

        return Database::transactional(function (PDO $db) use ($email, $name, $role) {
            $stmt = $db->prepare("
                INSERT INTO users (email, name, role, status)
                VALUES (:email, :name, :role, :status)
            ");
            $stmt->execute([
                'email' => $email,
                'name' => $name,
                'role' => $role,
                'status' => self::STATUS_INVITED,
            ]);

            $id = (int) $db->lastInsertId();
            $token = $this->issueToken($db, $id, self::PURPOSE_INVITE, INVITE_TOKEN_LIFETIME);

            return [
                'user' => $this->getById($id),
                'token' => $token['token'],
                'expires_at' => $token['expires_at'],
            ];
        });
    }

    /**
     * Issue a fresh invite / reset link for an existing account.
     *
     * @return array{token: string, expires_at: int}
     */
    public function issueLink(int $userId, string $purpose): array
    {
        $lifetime = $purpose === self::PURPOSE_INVITE ? INVITE_TOKEN_LIFETIME : RESET_TOKEN_LIFETIME;

        return Database::transactional(function (PDO $db) use ($userId, $purpose, $lifetime) {
            return $this->issueToken($db, $userId, $purpose, $lifetime);
        });
    }

    public function updateProfile(int $id, string $name, string $role): bool
    {
        $stmt = $this->db->prepare("
            UPDATE users
            SET name = :name, role = :role, updated_at = CURRENT_TIMESTAMP
            WHERE id = :id
        ");

        return $stmt->execute([
            'id' => $id,
            'name' => $name,
            'role' => self::normalizeRole($role),
        ]);
    }

    /**
     * Enable or disable an account. A disabled user keeps their data and their
     * attribution history but can no longer sign in.
     */
    public function setStatus(int $id, string $status): bool
    {
        if (!in_array($status, [self::STATUS_ACTIVE, self::STATUS_DISABLED, self::STATUS_INVITED], true)) {
            return false;
        }

        // Only an account that has actually set a password can become active.
        if ($status === self::STATUS_ACTIVE) {
            $stmt = $this->db->prepare("SELECT password_hash FROM users WHERE id = :id");
            $stmt->execute(['id' => $id]);
            if (empty($stmt->fetchColumn())) {
                $status = self::STATUS_INVITED;
            }
        }

        $stmt = $this->db->prepare("
            UPDATE users SET status = :status, updated_at = CURRENT_TIMESTAMP WHERE id = :id
        ");

        return $stmt->execute(['id' => $id, 'status' => $status]);
    }

    public function delete(int $id): bool
    {
        $stmt = $this->db->prepare("DELETE FROM users WHERE id = :id");

        return $stmt->execute(['id' => $id]);
    }

    public function recordLogin(int $id): void
    {
        $stmt = $this->db->prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id");
        $stmt->execute(['id' => $id]);
    }

    // -------------------------------------------------------------------------
    // Tokens
    // -------------------------------------------------------------------------

    /**
     * Create a single-use token and return the raw value.
     *
     * Only the SHA-256 hash is persisted, so the database never contains a
     * usable link. The raw token exists for exactly as long as it takes to put
     * it into an email.
     *
     * @return array{token: string, expires_at: int}
     */
    private function issueToken(PDO $db, int $userId, string $purpose, int $lifetime): array
    {
        // A new link invalidates every older one of the same kind, so an
        // intercepted or forwarded earlier mail stops working.
        $stmt = $db->prepare("DELETE FROM user_tokens WHERE user_id = :user_id AND purpose = :purpose");
        $stmt->execute(['user_id' => $userId, 'purpose' => $purpose]);

        $raw = bin2hex(random_bytes(32));
        $expiresAt = time() + $lifetime;

        $stmt = $db->prepare("
            INSERT INTO user_tokens (user_id, token_hash, purpose, expires_at)
            VALUES (:user_id, :token_hash, :purpose, :expires_at)
        ");
        $stmt->execute([
            'user_id' => $userId,
            'token_hash' => self::hashToken($raw),
            'purpose' => $purpose,
            // gmdate, not date: this column is compared against SQLite's
            // CURRENT_TIMESTAMP, which is always UTC. Writing server-local time
            // here would stretch or shrink every token's life by the UTC offset.
            'expires_at' => gmdate('Y-m-d H:i:s', $expiresAt),
        ]);

        return ['token' => $raw, 'expires_at' => $expiresAt];
    }

    /**
     * Look up an unused, unexpired token.
     *
     * @return array|null The joined token + user row, or null when unusable.
     */
    public function findValidToken(string $rawToken): ?array
    {
        // Reject anything that is not the exact shape we issue, before the
        // database is touched at all.
        if (!preg_match('/^[a-f0-9]{64}$/', $rawToken)) {
            return null;
        }

        $stmt = $this->db->prepare("
            SELECT t.id AS token_id, t.user_id, t.purpose, t.expires_at, t.used_at,
                   u.email, u.name, u.role, u.status
            FROM user_tokens t
            JOIN users u ON u.id = t.user_id
            WHERE t.token_hash = :hash
        ");
        $stmt->execute(['hash' => self::hashToken($rawToken)]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }
        if ($row['used_at'] !== null) {
            return null;
        }
        if (strtotime((string) $row['expires_at'] . ' UTC') < time()) {
            return null;
        }
        if ($row['status'] === self::STATUS_DISABLED) {
            return null;
        }

        return $row;
    }

    /**
     * Consume a token and set the account's password.
     *
     * One transaction, so a token can never be spent without the password
     * actually landing. Marking it used is the atomic guard - two parallel
     * requests carrying the same link cannot both succeed.
     */
    public function consumeTokenAndSetPassword(string $rawToken, string $password): bool
    {
        return Database::transactional(function (PDO $db) use ($rawToken, $password) {
            $hash = self::hashToken($rawToken);

            $claim = $db->prepare("
                UPDATE user_tokens
                SET used_at = CURRENT_TIMESTAMP
                WHERE token_hash = :hash
                  AND used_at IS NULL
                  AND expires_at > CURRENT_TIMESTAMP
            ");
            $claim->execute(['hash' => $hash]);

            if ($claim->rowCount() !== 1) {
                return false;
            }

            $lookup = $db->prepare("SELECT user_id FROM user_tokens WHERE token_hash = :hash");
            $lookup->execute(['hash' => $hash]);
            $userId = (int) $lookup->fetchColumn();

            if ($userId <= 0) {
                return false;
            }

            $update = $db->prepare("
                UPDATE users
                SET password_hash = :hash,
                    status = :status,
                    password_changed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :id
            ");
            $update->execute([
                'id' => $userId,
                'hash' => password_hash($password, PASSWORD_DEFAULT),
                'status' => self::STATUS_ACTIVE,
            ]);

            // Any other outstanding link for this account is now void.
            $db->prepare("DELETE FROM user_tokens WHERE user_id = :id AND used_at IS NULL")
               ->execute(['id' => $userId]);

            return true;
        });
    }

    /**
     * Drop expired and long-spent tokens. Cheap, so it runs opportunistically.
     */
    public function pruneTokens(): void
    {
        try {
            $this->db->exec("
                DELETE FROM user_tokens
                WHERE expires_at < datetime('now', '-7 days')
                   OR (used_at IS NOT NULL AND used_at < datetime('now', '-7 days'))
            ");
            $this->db->exec("DELETE FROM reset_requests WHERE requested_at < datetime('now', '-1 day')");
        } catch (Throwable $e) {
            // Housekeeping must never break a request.
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    public static function hashToken(string $rawToken): string
    {
        return hash('sha256', $rawToken);
    }

    public static function normalizeRole(?string $role): string
    {
        return $role === self::ROLE_ADMIN ? self::ROLE_ADMIN : self::ROLE_MEMBER;
    }

    /**
     * Normalize an email for storage and lookup, or null when it is not one.
     */
    public static function normalizeEmail(?string $email): ?string
    {
        $email = trim((string) $email);
        if ($email === '' || mb_strlen($email) > 255) {
            return null;
        }

        return filter_var($email, FILTER_VALIDATE_EMAIL) ? mb_strtolower($email) : null;
    }

    /**
     * Reject passwords that are too short or obviously guessable.
     *
     * @return string|null An error message, or null when acceptable.
     */
    public static function validatePassword(string $password): ?string
    {
        if (mb_strlen($password) < MIN_PASSWORD_LENGTH) {
            return 'Password must be at least ' . MIN_PASSWORD_LENGTH . ' characters long.';
        }
        if (mb_strlen($password) > 4096) {
            return 'Password is too long.';
        }

        $weak = ['password', '12345678', '1234567890', 'qwertyuiop', 'letmein123', 'changeme123'];
        if (in_array(mb_strtolower($password), $weak, true)) {
            return 'That password is too easy to guess. Please choose another one.';
        }

        return null;
    }

    /**
     * Cast a raw row into the shape the client expects.
     */
    private function shape(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'email' => (string) $row['email'],
            'name' => (string) $row['name'],
            'role' => (string) $row['role'],
            'status' => (string) $row['status'],
            'last_login_at' => $row['last_login_at'] ?? null,
            'created_at' => $row['created_at'] ?? null,
        ];
    }
}
