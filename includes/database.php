<?php
/**
 * Database Connection and Setup
 * Uses SQLite for simplicity - no external database server required
 */

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
            die('Database connection failed: ' . $e->getMessage());
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

        // Create indexes for todos
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_contact_id ON todos(contact_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_project_id ON todos(project_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_parent_todo_id ON todos(parent_todo_id)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_is_completed ON todos(is_completed)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at)");
    }
}
