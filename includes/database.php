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
            $pdo->exec('PRAGMA foreign_keys = ON');

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
        // Create project tables (optional migration)
        // If schema updates are blocked on the server, keep contacts app usable.
        try {
            $db->exec(" 
                CREATE TABLE IF NOT EXISTS projects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name VARCHAR(255) NOT NULL,
                    client VARCHAR(255),
                    status VARCHAR(50) DEFAULT 'Planning',
                    description TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            ");

            // Create indexes for projects
            $db->exec("CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name)");
            $db->exec("CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client)");
            $db->exec("CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)");
            $db->exec("CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at)");

            // Create project notes table for project timeline
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
        } catch (Throwable $e) {
            // Project module can be unavailable until DB migration permissions are fixed.
        }

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
    }
}


