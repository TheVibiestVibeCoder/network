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
     * Get all projects with optional search and sorting
     */
    public function getAll(string $search = '', string $sortBy = 'name', string $sortOrder = 'ASC'): array
    {
        $allowedSortFields = ['name', 'client', 'status', 'created_at', 'updated_at'];
        $sortBy = in_array($sortBy, $allowedSortFields, true) ? $sortBy : 'name';
        $sortOrder = strtoupper($sortOrder) === 'DESC' ? 'DESC' : 'ASC';

        $sql = 'SELECT * FROM projects';
        $params = [];

        if (!empty($search)) {
            $sql .= ' WHERE name LIKE :search
                      OR client LIKE :search
                      OR status LIKE :search
                      OR description LIKE :search';
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
        $stmt = $this->db->prepare('SELECT * FROM projects WHERE id = :id');
        $stmt->execute(['id' => $id]);

        $project = $stmt->fetch();
        return $project ?: null;
    }

    /**
     * Create a new project
     */
    public function create(array $data): int
    {
        $stmt = $this->db->prepare('
            INSERT INTO projects (name, client, status, description)
            VALUES (:name, :client, :status, :description)
        ');

        $stmt->execute([
            'name' => $data['name'] ?? '',
            'client' => $data['client'] ?? null,
            'status' => $data['status'] ?? 'Planning',
            'description' => $data['description'] ?? null,
        ]);

        return (int) $this->db->lastInsertId();
    }

    /**
     * Update an existing project
     */
    public function update(int $id, array $data): bool
    {
        $stmt = $this->db->prepare('
            UPDATE projects
            SET name = :name,
                client = :client,
                status = :status,
                description = :description,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = :id
        ');

        return $stmt->execute([
            'id' => $id,
            'name' => $data['name'] ?? '',
            'client' => $data['client'] ?? null,
            'status' => $data['status'] ?? 'Planning',
            'description' => $data['description'] ?? null,
        ]);
    }

    /**
     * Delete a project
     */
    public function delete(int $id): bool
    {
        $stmt = $this->db->prepare('DELETE FROM projects WHERE id = :id');
        return $stmt->execute(['id' => $id]);
    }

    /**
     * Get project count
     */
    public function count(): int
    {
        $stmt = $this->db->query('SELECT COUNT(*) FROM projects');
        return (int) $stmt->fetchColumn();
    }
}
