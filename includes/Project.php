<?php
/**
 * Project Model
 * Handles all project-related database operations
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

class Project
{
    private PDO $db;

    public function __construct()
    {
        $this->db = Database::getInstance();
    }

    /**
     * Get all projects
     */
    public function getAll(string $search = '', string $sortBy = 'name', string $sortOrder = 'ASC'): array
    {
        $allowedSortFields = ['name', 'company', 'start_date', 'stage', 'success_chance', 'created_at', 'updated_at'];
        $sortBy = in_array($sortBy, $allowedSortFields) ? $sortBy : 'name';
        $sortOrder = strtoupper($sortOrder) === 'DESC' ? 'DESC' : 'ASC';

        $sql = "SELECT * FROM projects";
        $params = [];

        if (!empty($search)) {
            $sql .= " WHERE name LIKE :search
                      OR company LIKE :search
                      OR description LIKE :search
                      OR stage LIKE :search";
            $params['search'] = '%' . $search . '%';
        }

        // Stage is a pipeline position, not a word: sorting it alphabetically
        // puts Complete first and In Progress in the middle. Order it the way
        // the work actually reads instead - what is running, then what is being
        // won, then what is only a lead, and finished work last.
        if ($sortBy === 'stage') {
            $sql .= " ORDER BY " . self::stageRankSql() . " $sortOrder, name COLLATE NOCASE ASC";
        } else {
            $sql .= " ORDER BY $sortBy $sortOrder";
        }

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        return $stmt->fetchAll();
    }

    /**
     * Pipeline order for the stage column, as a SQL CASE expression.
     *
     * Public so that every list of projects - the Projects view and the home
     * page alike - sorts by this one expression and can never drift apart.
     *
     * @param string $column The stage column, qualified if the query joins.
     */
    public static function stageRankSql(string $column = 'stage'): string
    {
        // $column is always a literal from a caller in this codebase; it is
        // still shape-checked because it is concatenated into SQL.
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_.]*$/', $column)) {
            $column = 'stage';
        }

        return "CASE " . $column . "
                    WHEN 'In Progress' THEN 1
                    WHEN 'Proposal'    THEN 2
                    WHEN 'Negotiation' THEN 3
                    WHEN 'Lead'        THEN 4
                    WHEN 'Complete'    THEN 5
                    ELSE 6
                END";
    }

    /**
     * Get a single project by ID
     */
    public function getById(int $id): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM projects WHERE id = :id");
        $stmt->execute(['id' => $id]);

        $project = $stmt->fetch();
        return $project ?: null;
    }

    /**
     * Create a new project
     */
    public function create(array $data): int
    {
        $stmt = $this->db->prepare("
            INSERT INTO projects (name, start_date, description, company, budget_min, budget_max,
                                success_chance, stage, estimated_completion,
                                created_by, created_by_name, updated_by, updated_by_name)
            VALUES (:name, :start_date, :description, :company, :budget_min, :budget_max,
                    :success_chance, :stage, :estimated_completion,
                    :actor_id, :actor_name, :actor_id2, :actor_name2)
        ");

        // Stamped in the model so no endpoint can forget to attribute a write.
        $actor = Auth::actor();

        $stmt->execute([
            'actor_id' => $actor['id'],
            'actor_name' => $actor['name'],
            'actor_id2' => $actor['id'],
            'actor_name2' => $actor['name'],
            'name' => $data['name'] ?? '',
            'start_date' => $data['start_date'] ?? date('Y-m-d'),
            'description' => $data['description'] ?? '',
            'company' => $data['company'] ?? null,
            'budget_min' => $data['budget_min'] ?? null,
            'budget_max' => $data['budget_max'] ?? null,
            'success_chance' => $data['success_chance'] ?? null,
            'stage' => $data['stage'] ?? 'Lead',
            'estimated_completion' => $data['estimated_completion'] ?? null,
        ]);

        return (int) $this->db->lastInsertId();
    }

    /**
     * Update an existing project
     */
    public function update(int $id, array $data): bool
    {
        $stmt = $this->db->prepare("
            UPDATE projects
            SET name = :name,
                start_date = :start_date,
                description = :description,
                company = :company,
                budget_min = :budget_min,
                budget_max = :budget_max,
                success_chance = :success_chance,
                stage = :stage,
                estimated_completion = :estimated_completion,
                updated_by = :actor_id,
                updated_by_name = :actor_name,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = :id
        ");

        $actor = Auth::actor();

        return $stmt->execute([
            'id' => $id,
            'actor_id' => $actor['id'],
            'actor_name' => $actor['name'],
            'name' => $data['name'] ?? '',
            'start_date' => $data['start_date'] ?? date('Y-m-d'),
            'description' => $data['description'] ?? '',
            'company' => $data['company'] ?? null,
            'budget_min' => $data['budget_min'] ?? null,
            'budget_max' => $data['budget_max'] ?? null,
            'success_chance' => $data['success_chance'] ?? null,
            'stage' => $data['stage'] ?? 'Lead',
            'estimated_completion' => $data['estimated_completion'] ?? null,
        ]);
    }

    /**
     * Delete a project
     */
    public function delete(int $id): bool
    {
        $stmt = $this->db->prepare("DELETE FROM projects WHERE id = :id");
        return $stmt->execute(['id' => $id]);
    }

    /**
     * Get project count
     */
    public function count(): int
    {
        $stmt = $this->db->query("SELECT COUNT(*) FROM projects");
        return (int) $stmt->fetchColumn();
    }

    /**
     * Get projects for a specific contact
     */
    public function getByContact(int $contactId): array
    {
        $stmt = $this->db->prepare("
            SELECT p.* FROM projects p
            INNER JOIN project_contacts pc ON p.id = pc.project_id
            WHERE pc.contact_id = :contact_id
            ORDER BY p.start_date DESC
        ");
        $stmt->execute(['contact_id' => $contactId]);

        return $stmt->fetchAll();
    }

    /**
     * Get projects for a specific company
     */
    public function getByCompany(string $company): array
    {
        $stmt = $this->db->prepare("
            SELECT * FROM projects
            WHERE company = :company
            ORDER BY start_date DESC
        ");
        $stmt->execute(['company' => $company]);

        return $stmt->fetchAll();
    }

    /**
     * Assign a contact to a project
     */
    public function assignContact(int $projectId, int $contactId): bool
    {
        try {
            $stmt = $this->db->prepare("
                INSERT OR IGNORE INTO project_contacts (project_id, contact_id)
                VALUES (:project_id, :contact_id)
            ");
            return $stmt->execute([
                'project_id' => $projectId,
                'contact_id' => $contactId
            ]);
        } catch (Exception $e) {
            return false;
        }
    }

    /**
     * Unassign a contact from a project
     */
    public function unassignContact(int $projectId, int $contactId): bool
    {
        $stmt = $this->db->prepare("
            DELETE FROM project_contacts
            WHERE project_id = :project_id AND contact_id = :contact_id
        ");
        return $stmt->execute([
            'project_id' => $projectId,
            'contact_id' => $contactId
        ]);
    }

    /**
     * Get all contacts for a project
     */
    public function getContacts(int $projectId): array
    {
        $stmt = $this->db->prepare("
            SELECT c.* FROM contacts c
            INNER JOIN project_contacts pc ON c.id = pc.contact_id
            WHERE pc.project_id = :project_id
            ORDER BY c.name ASC
        ");
        $stmt->execute(['project_id' => $projectId]);

        return $stmt->fetchAll();
    }

    /**
     * Assign a tag to a project
     */
    public function assignTag(int $projectId, int $tagId): bool
    {
        try {
            $stmt = $this->db->prepare("
                INSERT OR IGNORE INTO project_tags (project_id, tag_id)
                VALUES (:project_id, :tag_id)
            ");
            return $stmt->execute([
                'project_id' => $projectId,
                'tag_id' => $tagId
            ]);
        } catch (Exception $e) {
            return false;
        }
    }

    /**
     * Unassign a tag from a project
     */
    public function unassignTag(int $projectId, int $tagId): bool
    {
        $stmt = $this->db->prepare("
            DELETE FROM project_tags
            WHERE project_id = :project_id AND tag_id = :tag_id
        ");
        return $stmt->execute([
            'project_id' => $projectId,
            'tag_id' => $tagId
        ]);
    }

    /**
     * Get all tags for a project
     */
    public function getTags(int $projectId): array
    {
        $stmt = $this->db->prepare("
            SELECT t.* FROM tags t
            INNER JOIN project_tags pt ON t.id = pt.tag_id
            WHERE pt.project_id = :project_id
            ORDER BY t.name ASC
        ");
        $stmt->execute(['project_id' => $projectId]);

        return $stmt->fetchAll();
    }
    /**
     * Get all notes for a project
     */
    public function getNotes(int $projectId): array
    {
        $stmt = $this->db->prepare("
            SELECT *
            FROM project_notes
            WHERE project_id = :project_id
            ORDER BY created_at DESC
        ");
        $stmt->execute(['project_id' => $projectId]);

        return $stmt->fetchAll();
    }

    /**
     * Get a single project note by ID
     */
    public function getNoteById(int $noteId): ?array
    {
        $stmt = $this->db->prepare("
            SELECT *
            FROM project_notes
            WHERE id = :id
        ");
        $stmt->execute(['id' => $noteId]);

        $note = $stmt->fetch();
        return $note ?: null;
    }

    /**
     * Create a note for a project
     */
    public function createNote(int $projectId, string $content): ?array
    {
        $stmt = $this->db->prepare("
            INSERT INTO project_notes (project_id, content, author_id, author_name)
            VALUES (:project_id, :content, :author_id, :author_name)
        ");

        $actor = Auth::actor();

        $stmt->execute([
            'project_id' => $projectId,
            'content' => $content,
            'author_id' => $actor['id'],
            'author_name' => $actor['name']
        ]);

        $noteId = (int) $this->db->lastInsertId();
        return $this->getNoteById($noteId);
    }

    /**
     * Delete a project note
     */
    public function deleteNote(int $noteId): bool
    {
        $stmt = $this->db->prepare("
            DELETE FROM project_notes
            WHERE id = :id
        ");
        return $stmt->execute(['id' => $noteId]);
    }
}
