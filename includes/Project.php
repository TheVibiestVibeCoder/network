<?php
/**
 * Project Model
 * Handles all project-related database operations
 */

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

        $sql .= " ORDER BY $sortBy $sortOrder";

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        return $stmt->fetchAll();
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
                                success_chance, stage, estimated_completion)
            VALUES (:name, :start_date, :description, :company, :budget_min, :budget_max,
                    :success_chance, :stage, :estimated_completion)
        ");

        $stmt->execute([
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
                updated_at = CURRENT_TIMESTAMP
            WHERE id = :id
        ");

        return $stmt->execute([
            'id' => $id,
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
}
