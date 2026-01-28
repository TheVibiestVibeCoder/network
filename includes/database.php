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
