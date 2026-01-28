<?php
/**
 * Contact Model
 * Handles all contact-related database operations
 */

class Contact
{
    private PDO $db;

    public function __construct()
    {
        $this->db = Database::getInstance();
    }

    /**
     * Get all contacts
     */
    public function getAll(string $search = '', string $sortBy = 'name', string $sortOrder = 'ASC'): array
    {
        $allowedSortFields = ['name', 'company', 'location', 'created_at', 'updated_at'];
        $sortBy = in_array($sortBy, $allowedSortFields) ? $sortBy : 'name';
        $sortOrder = strtoupper($sortOrder) === 'DESC' ? 'DESC' : 'ASC';

        $sql = "SELECT * FROM contacts";
        $params = [];

        if (!empty($search)) {
            $sql .= " WHERE name LIKE :search
                      OR company LIKE :search
                      OR location LIKE :search
                      OR email LIKE :search
                      OR note LIKE :search";
            $params['search'] = '%' . $search . '%';
        }

        $sql .= " ORDER BY $sortBy $sortOrder";

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        return $stmt->fetchAll();
    }

    /**
     * Get contacts with coordinates for map display
     */
    public function getForMap(): array
    {
        $stmt = $this->db->prepare("
            SELECT id, name, company, location, latitude, longitude, note
            FROM contacts
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        ");
        $stmt->execute();

        return $stmt->fetchAll();
    }

    /**
     * Get a single contact by ID
     */
    public function getById(int $id): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM contacts WHERE id = :id");
        $stmt->execute(['id' => $id]);

        $contact = $stmt->fetch();
        return $contact ?: null;
    }

    /**
     * Create a new contact
     */
    public function create(array $data): int
    {
        $stmt = $this->db->prepare("
            INSERT INTO contacts (name, company, location, latitude, longitude, note, email, phone, website, address)
            VALUES (:name, :company, :location, :latitude, :longitude, :note, :email, :phone, :website, :address)
        ");

        $stmt->execute([
            'name' => $data['name'] ?? '',
            'company' => $data['company'] ?? null,
            'location' => $data['location'] ?? null,
            'latitude' => $data['latitude'] ?? null,
            'longitude' => $data['longitude'] ?? null,
            'note' => $data['note'] ?? null,
            'email' => $data['email'] ?? null,
            'phone' => $data['phone'] ?? null,
            'website' => $data['website'] ?? null,
            'address' => $data['address'] ?? null,
        ]);

        return (int) $this->db->lastInsertId();
    }

    /**
     * Update an existing contact
     */
    public function update(int $id, array $data): bool
    {
        $stmt = $this->db->prepare("
            UPDATE contacts
            SET name = :name,
                company = :company,
                location = :location,
                latitude = :latitude,
                longitude = :longitude,
                note = :note,
                email = :email,
                phone = :phone,
                website = :website,
                address = :address,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = :id
        ");

        return $stmt->execute([
            'id' => $id,
            'name' => $data['name'] ?? '',
            'company' => $data['company'] ?? null,
            'location' => $data['location'] ?? null,
            'latitude' => $data['latitude'] ?? null,
            'longitude' => $data['longitude'] ?? null,
            'note' => $data['note'] ?? null,
            'email' => $data['email'] ?? null,
            'phone' => $data['phone'] ?? null,
            'website' => $data['website'] ?? null,
            'address' => $data['address'] ?? null,
        ]);
    }

    /**
     * Delete a contact
     */
    public function delete(int $id): bool
    {
        $stmt = $this->db->prepare("DELETE FROM contacts WHERE id = :id");
        return $stmt->execute(['id' => $id]);
    }

    /**
     * Get contact count
     */
    public function count(): int
    {
        $stmt = $this->db->query("SELECT COUNT(*) FROM contacts");
        return (int) $stmt->fetchColumn();
    }

    /**
     * Bulk create contacts (for import)
     * Returns array with success count and errors
     */
    public function bulkCreate(array $contacts): array
    {
        $successCount = 0;
        $errors = [];
        $createdIds = [];

        $this->db->beginTransaction();

        try {
            $stmt = $this->db->prepare("
                INSERT INTO contacts (name, company, location, latitude, longitude, note, email, phone, website, address)
                VALUES (:name, :company, :location, :latitude, :longitude, :note, :email, :phone, :website, :address)
            ");

            foreach ($contacts as $index => $data) {
                // Skip if name is empty
                if (empty($data['name'])) {
                    $errors[] = [
                        'row' => $index + 2, // +2 because row 1 is header, and index is 0-based
                        'error' => 'Name is required'
                    ];
                    continue;
                }

                try {
                    $stmt->execute([
                        'name' => $data['name'] ?? '',
                        'company' => $data['company'] ?? null,
                        'location' => $data['location'] ?? null,
                        'latitude' => $data['latitude'] ?? null,
                        'longitude' => $data['longitude'] ?? null,
                        'note' => $data['note'] ?? null,
                        'email' => $data['email'] ?? null,
                        'phone' => $data['phone'] ?? null,
                        'website' => $data['website'] ?? null,
                        'address' => $data['address'] ?? null,
                    ]);

                    $createdIds[] = (int) $this->db->lastInsertId();
                    $successCount++;
                } catch (Exception $e) {
                    $errors[] = [
                        'row' => $index + 2,
                        'error' => 'Database error: ' . $e->getMessage()
                    ];
                }
            }

            $this->db->commit();
        } catch (Exception $e) {
            $this->db->rollBack();
            throw $e;
        }

        return [
            'success_count' => $successCount,
            'errors' => $errors,
            'created_ids' => $createdIds
        ];
    }

    /**
     * Export all contacts as array
     */
    public function exportAll(): array
    {
        $stmt = $this->db->query("SELECT name, company, location, email, phone, website, address, note FROM contacts ORDER BY name ASC");
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }
}
