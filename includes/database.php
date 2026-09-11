<?php
/**
 * Database Connection and Setup
 * Uses SQLite for simplicity - no external database server required
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

class Database
{
    private static ?PDO $instance = null;

    /**
     * Get database connection instance (singleton)
     */
    public static function getInstance(): PDO
    {
        if (self::$instance === null) {
            self::$instance = self::createConnection();
            self::initializeSchema();
        }

        return self::$instance;
    }

    /**
     * Create PDO connection to SQLite database
     */
    private static function createConnection(): PDO
    {
        try {
            $pdo = new PDO('sqlite:' . DB_PATH);
            $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
            $pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, false);
            $pdo->setAttribute(PDO::ATTR_TIMEOUT, max(1, (int) ceil(SQLITE_BUSY_TIMEOUT_MS / 1000)));

            // SQLite runtime tuning for concurrent reads and fewer lock errors.
            $pdo->exec('PRAGMA foreign_keys = ON');
            $pdo->exec('PRAGMA journal_mode = WAL');
            $pdo->exec('PRAGMA synchronous = NORMAL');
            $pdo->exec('PRAGMA temp_store = MEMORY');
            $pdo->exec('PRAGMA busy_timeout = ' . SQLITE_BUSY_TIMEOUT_MS);
            $pdo->exec('PRAGMA cache_size = -' . SQLITE_CACHE_SIZE_KB);

            return $pdo;
        } catch (PDOException $e) {
            // The PDO message contains the absolute path of the SQLite file and
            // sometimes filesystem details. Log it, show the visitor nothing.
            error_log('Database connection failed: ' . $e->getMessage());
            http_response_code(500);
            header('Content-Type: text/plain; charset=utf-8');
            exit('Service temporarily unavailable.');
        }
    }

    /**
     * Initialize database schema if tables don't exist
     */
    private static function initializeSchema(): void
    {
        $db = self::$instance;

        // Create contacts table
        $db->exec("
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(255) NOT NULL,
                company VARCHAR(255),
                location VARCHAR(255),
                latitude REAL,
                longitude REAL,
                note TEXT,
                email VARCHAR(255),
                phone VARCHAR(50),
                website VARCHAR(255),
                address TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ");

        // Create index for faster searches
        $db->exec("CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_contacts_location ON contacts(location)");

        // Lightweight migrations for contacts table columns added after initial release
        $contactColumns = $db->query("PRAGMA table_info(contacts)")->fetchAll(PDO::FETCH_ASSOC);
        $contactColumnNames = array_column($contactColumns, 'name');
        if (!in_array('website', $contactColumnNames)) {
            $db->exec("ALTER TABLE contacts ADD COLUMN website VARCHAR(255)");
        }
        if (!in_array('address', $contactColumnNames)) {
            $db->exec("ALTER TABLE contacts ADD COLUMN address TEXT");
        }
        if (!in_array('pinned', $contactColumnNames)) {
            $db->exec("ALTER TABLE contacts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
        }

        // Create notes table for timeline
        $db->exec("
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contact_id INTEGER NOT NULL,
                company VARCHAR(255),
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
            )
        ");

        // Create indexes for notes
        $db->exec("CREATE INDEX IF NOT EXISTS idx_notes_contact_id ON notes(contact_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_notes_company ON notes(company)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_notes_contact_created ON notes(contact_id, created_at)");

        // Create activity events table for calendar audit trail
        $db->exec("
            CREATE TABLE IF NOT EXISTS activity_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_type VARCHAR(32) NOT NULL,
                action VARCHAR(32) NOT NULL,
                content TEXT NOT NULL,
                contact_id INTEGER,
                contact_name VARCHAR(255),
                contact_company VARCHAR(255),
                project_id INTEGER,
                project_name VARCHAR(255),
                project_company VARCHAR(255),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_activity_events_created_at ON activity_events(created_at)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_activity_events_entry_type ON activity_events(entry_type)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_activity_events_contact_id ON activity_events(contact_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_activity_events_project_id ON activity_events(project_id)");

        // Create tags table
        $db->exec("
            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(100) NOT NULL UNIQUE,
                color VARCHAR(7) DEFAULT '#3b82f6',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ");

        // Create contact_tags junction table (many-to-many)
        $db->exec("
            CREATE TABLE IF NOT EXISTS contact_tags (
                contact_id INTEGER NOT NULL,
                tag_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (contact_id, tag_id),
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            )
        ");

        // Create indexes for tags
        $db->exec("CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_contact_tags_contact ON contact_tags(contact_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag_id)");

        // Create login_attempts table for brute force protection
        $db->exec("
            CREATE TABLE IF NOT EXISTS login_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip_address VARCHAR(45) NOT NULL,
                attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                success INTEGER DEFAULT 0
            )
        ");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts(attempted_at)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_success_time ON login_attempts(ip_address, success, attempted_at)");

        // Sign-ins are throttled per identity as well as per IP, so that an
        // attacker spread over many addresses cannot grind a single account.
        self::addColumnIfMissing($db, 'login_attempts', 'identifier', 'VARCHAR(255)');
        $db->exec("CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier, success, attempted_at)");

        // Create projects table
        $db->exec("
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(255) NOT NULL,
                start_date DATE NOT NULL,
                description TEXT NOT NULL,
                company VARCHAR(255),
                budget_min DECIMAL(10,2),
                budget_max DECIMAL(10,2),
                success_chance INTEGER,
                stage VARCHAR(50) DEFAULT 'Lead',
                estimated_completion DATE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ");

        // Create indexes for projects
        $db->exec("CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects(stage)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_projects_start_date ON projects(start_date)");
        // Create project_notes table for project timeline entries
        $db->exec("
            CREATE TABLE IF NOT EXISTS project_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            )
        ");

        // Create indexes for project notes
        $db->exec("CREATE INDEX IF NOT EXISTS idx_project_notes_project_id ON project_notes(project_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_project_notes_created_at ON project_notes(created_at)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_project_notes_project_created ON project_notes(project_id, created_at)");

        // Create project_contacts junction table (many-to-many)
        $db->exec("
            CREATE TABLE IF NOT EXISTS project_contacts (
                project_id INTEGER NOT NULL,
                contact_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (project_id, contact_id),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
            )
        ");

        // Create project_tags junction table (many-to-many)
        $db->exec("
            CREATE TABLE IF NOT EXISTS project_tags (
                project_id INTEGER NOT NULL,
                tag_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (project_id, tag_id),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            )
        ");

        // Create indexes for project junction tables
        $db->exec("CREATE INDEX IF NOT EXISTS idx_project_contacts_project ON project_contacts(project_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_project_contacts_contact ON project_contacts(contact_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_project_tags_project ON project_tags(project_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag_id)");

        // Create todos table (can belong to a contact or a project)
        $db->exec("
            CREATE TABLE IF NOT EXISTS todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                due_date DATE,
                priority VARCHAR(16),
                is_completed INTEGER NOT NULL DEFAULT 0,
                contact_id INTEGER,
                project_id INTEGER,
                parent_todo_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                CHECK (contact_id IS NOT NULL OR project_id IS NOT NULL),
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_todo_id) REFERENCES todos(id) ON DELETE CASCADE
            )
        ");

        // Lightweight migration for existing databases that don't yet have parent_todo_id
        $todoColumns = $db->query("PRAGMA table_info(todos)")->fetchAll(PDO::FETCH_ASSOC);
        $hasParentTodoColumn = false;
        foreach ($todoColumns as $column) {
            if (($column['name'] ?? '') === 'parent_todo_id') {
                $hasParentTodoColumn = true;
                break;
            }
        }
        if (!$hasParentTodoColumn) {
            $db->exec("ALTER TABLE todos ADD COLUMN parent_todo_id INTEGER");
        }

        $hasPriorityColumn = false;
        foreach ($todoColumns as $column) {
            if (($column['name'] ?? '') === 'priority') {
                $hasPriorityColumn = true;
                break;
            }
        }
        if (!$hasPriorityColumn) {
            $db->exec("ALTER TABLE todos ADD COLUMN priority VARCHAR(16)");
        }

        // ---------------------------------------------------------------
        // Multi-user: accounts, invite/reset tokens, attribution
        // ---------------------------------------------------------------

        // email is COLLATE NOCASE so that Ada@x.com and ada@x.com are the same
        // account and the UNIQUE index actually prevents duplicates.
        $db->exec("
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email VARCHAR(255) NOT NULL UNIQUE COLLATE NOCASE,
                name VARCHAR(255) NOT NULL,
                password_hash TEXT,
                role VARCHAR(16) NOT NULL DEFAULT 'member',
                status VARCHAR(16) NOT NULL DEFAULT 'invited',
                password_changed_at DATETIME,
                last_login_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)");

        // Profile picture: the stored filename inside data/avatars, or NULL.
        // The file itself lives outside anything the web server will serve.
        self::addColumnIfMissing($db, 'users', 'avatar', 'VARCHAR(255)');
        $db->exec("CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)");

        // Only the SHA-256 of a token is stored. A leaked database therefore
        // does not hand out working invite or reset links.
        $db->exec("
            CREATE TABLE IF NOT EXISTS user_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                purpose VARCHAR(16) NOT NULL,
                expires_at DATETIME NOT NULL,
                used_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        ");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_user_tokens_hash ON user_tokens(token_hash)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id)");

        // Instance-wide settings. The owner login has no users row, so its
        // profile picture is keyed in here rather than on an account.
        $db->exec("
            CREATE TABLE IF NOT EXISTS app_settings (
                key VARCHAR(64) PRIMARY KEY,
                value TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ");

        // Throttle table for password-reset requests (per IP and per email), so
        // the reset endpoint cannot be used to spam somebody's inbox.
        $db->exec("
            CREATE TABLE IF NOT EXISTS reset_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip_address VARCHAR(45) NOT NULL,
                email VARCHAR(255) NOT NULL COLLATE NOCASE,
                requested_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_reset_requests_ip ON reset_requests(ip_address, requested_at)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_reset_requests_email ON reset_requests(email, requested_at)");

        // ---------------------------------------------------------------
        // Two-factor sign-in challenges
        // ---------------------------------------------------------------
        // A correct password does not sign anyone in on its own: it opens a
        // challenge here, and only the emailed code closes it. The row holds a
        // hash of the code, never the code - a readable database must not be
        // enough to walk through somebody's second factor.
        //
        // The challenge, not the session, is the authority on what is being
        // authenticated. The session only carries the challenge id, so a user
        // cannot edit their way into a different account between the two steps.
        $db->exec("
            CREATE TABLE IF NOT EXISTS login_challenges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                challenge_id TEXT NOT NULL UNIQUE,
                user_id INTEGER NOT NULL,
                code_hash TEXT NOT NULL,
                remember INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,
                ip_address VARCHAR(45),
                expires_at DATETIME NOT NULL,
                consumed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        ");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_login_challenges_cid ON login_challenges(challenge_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_login_challenges_user ON login_challenges(user_id, created_at)");

        // ---------------------------------------------------------------
        // "Remember this device" tokens
        // ---------------------------------------------------------------
        // Split into a selector and a validator. The selector is the lookup key
        // and is stored as-is; the validator is only ever stored as a SHA-256
        // hash and compared in constant time. That way the lookup needs no
        // scan over every row, and a database read still does not yield a
        // usable cookie.
        //
        // The validator is rotated on every use. A cookie that presents a known
        // selector with a stale validator is evidence the cookie was copied, so
        // that whole family of tokens is dropped rather than just refused.
        $db->exec("
            CREATE TABLE IF NOT EXISTS remember_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                selector TEXT NOT NULL UNIQUE,
                validator_hash TEXT NOT NULL,
                previous_hash TEXT,
                rotated_at DATETIME,
                user_id INTEGER NOT NULL,
                pw_stamp TEXT,
                expires_at DATETIME NOT NULL,
                last_used_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        ");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_remember_tokens_selector ON remember_tokens(selector)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_remember_tokens_user ON remember_tokens(user_id)");
        // Added after the table shipped: the grace window that keeps a page's
        // parallel requests from looking like a stolen cookie.
        self::addColumnIfMissing($db, 'remember_tokens', 'previous_hash', 'TEXT');
        self::addColumnIfMissing($db, 'remember_tokens', 'rotated_at', 'DATETIME');

        // ---------------------------------------------------------------
        // Attribution columns
        // ---------------------------------------------------------------
        // Every actor column is stored as a nullable id plus a name snapshot.
        // The id powers filtering; the snapshot keeps the history readable
        // after an account is deleted (and the owner login has no row at all).
        self::addColumnIfMissing($db, 'contacts', 'created_by', 'INTEGER');
        self::addColumnIfMissing($db, 'contacts', 'created_by_name', 'VARCHAR(255)');
        self::addColumnIfMissing($db, 'contacts', 'updated_by', 'INTEGER');
        self::addColumnIfMissing($db, 'contacts', 'updated_by_name', 'VARCHAR(255)');

        self::addColumnIfMissing($db, 'projects', 'created_by', 'INTEGER');
        self::addColumnIfMissing($db, 'projects', 'created_by_name', 'VARCHAR(255)');
        self::addColumnIfMissing($db, 'projects', 'updated_by', 'INTEGER');
        self::addColumnIfMissing($db, 'projects', 'updated_by_name', 'VARCHAR(255)');

        self::addColumnIfMissing($db, 'todos', 'created_by', 'INTEGER');
        self::addColumnIfMissing($db, 'todos', 'created_by_name', 'VARCHAR(255)');
        self::addColumnIfMissing($db, 'todos', 'updated_by', 'INTEGER');
        self::addColumnIfMissing($db, 'todos', 'updated_by_name', 'VARCHAR(255)');

        self::addColumnIfMissing($db, 'notes', 'author_id', 'INTEGER');
        self::addColumnIfMissing($db, 'notes', 'author_name', 'VARCHAR(255)');

        self::addColumnIfMissing($db, 'project_notes', 'author_id', 'INTEGER');
        self::addColumnIfMissing($db, 'project_notes', 'author_name', 'VARCHAR(255)');

        self::addColumnIfMissing($db, 'activity_events', 'actor_id', 'INTEGER');
        self::addColumnIfMissing($db, 'activity_events', 'actor_name', 'VARCHAR(255)');

        $db->exec("CREATE INDEX IF NOT EXISTS idx_activity_events_actor ON activity_events(actor_id)");

        // ---------------------------------------------------------------
        // Assignment
        // ---------------------------------------------------------------
        // Who is responsible for a record, as opposed to who last touched it.
        //
        //   NULL = nobody is assigned
        //   0    = the owner identity, which has no users row (see User.php)
        //   N    = users.id
        //
        // Zero is safe as the owner sentinel because SQLite AUTOINCREMENT ids
        // start at 1, so it can never collide with a real account.
        //
        // assigned_to_name is a display snapshot like the attribution columns,
        // so a list still reads correctly without joining users on every row.
        foreach (['contacts', 'projects', 'todos'] as $table) {
            self::addColumnIfMissing($db, $table, 'assigned_to', 'INTEGER');
            self::addColumnIfMissing($db, $table, 'assigned_to_name', 'VARCHAR(255)');
            $db->exec("CREATE INDEX IF NOT EXISTS idx_" . $table . "_assigned_to ON " . $table . "(assigned_to)");
        }

        // Create indexes for todos
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_contact_id ON todos(contact_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_project_id ON todos(project_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_parent_todo_id ON todos(parent_todo_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_is_completed ON todos(is_completed)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at)");
    }

    /**
     * Add a column to an existing table when it is not there yet.
     *
     * SQLite has no "ADD COLUMN IF NOT EXISTS", and this app migrates itself on
     * every boot, so the check has to be explicit.
     */
    private static function addColumnIfMissing(PDO $db, string $table, string $column, string $definition): void
    {
        // Table and column names cannot be bound as parameters, so they are
        // whitelisted by shape. Every caller passes a literal, but this keeps
        // the method safe if that ever stops being true.
        foreach ([$table, $column] as $identifier) {
            if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $identifier)) {
                throw new InvalidArgumentException('Refusing unsafe SQL identifier');
            }
        }
        if (!preg_match('/^[A-Za-z0-9_() ,]+$/', $definition)) {
            throw new InvalidArgumentException('Refusing unsafe column definition');
        }

        $existing = $db->query("PRAGMA table_info(" . $table . ")")->fetchAll(PDO::FETCH_ASSOC);
        if (in_array($column, array_column($existing, 'name'), true)) {
            return;
        }

        $db->exec("ALTER TABLE " . $table . " ADD COLUMN " . $column . " " . $definition);
    }

    /**
     * Run a write inside a transaction, retrying if SQLite reports the database
     * as busy.
     *
     * With several people in the CRM at once, two writes can land in the same
     * instant. WAL lets readers continue during a write, but a second *writer*
     * still has to wait, and once busy_timeout is exhausted SQLite throws.
     * Retrying with a short backoff turns that rare collision into a slightly
     * slower save instead of a failed one.
     *
     * @template T
     * @param callable(PDO): T $work
     * @return T
     */
    public static function transactional(callable $work, int $attempts = 4)
    {
        $db = self::getInstance();

        for ($attempt = 1; ; $attempt++) {
            try {
                $db->beginTransaction();
                $result = $work($db);
                $db->commit();
                return $result;
            } catch (PDOException $e) {
                if ($db->inTransaction()) {
                    $db->rollBack();
                }

                $busy = stripos($e->getMessage(), 'database is locked') !== false
                    || stripos($e->getMessage(), 'database table is locked') !== false;

                if (!$busy || $attempt >= $attempts) {
                    throw $e;
                }

                // 20ms, 40ms, 80ms - short enough to stay within a request.
                usleep(20000 * (1 << ($attempt - 1)));
            } catch (Throwable $e) {
                if ($db->inTransaction()) {
                    $db->rollBack();
                }
                throw $e;
            }
        }
    }
}
