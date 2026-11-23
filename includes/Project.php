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

// Deleting a project has to take its documents' files along, wherever the
// delete is called from.
require_once APP_ROOT . '/includes/ProjectDocument.php';
require_once APP_ROOT . '/includes/ProjectArchive.php';
require_once APP_ROOT . '/includes/Company.php';
require_once APP_ROOT . '/includes/ProjectHistory.php';

class Project
{
    /** The most expected payments one project can hold. */
    public const MAX_PAYMENTS = 60;

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
        $allowedSortFields = ['name', 'company', 'start_date', 'stage', 'product', 'success_chance', 'created_at', 'updated_at'];
        $sortBy = in_array($sortBy, $allowedSortFields) ? $sortBy : 'name';
        $sortOrder = strtoupper($sortOrder) === 'DESC' ? 'DESC' : 'ASC';

        $sql = "SELECT * FROM projects";
        $params = [];

        if (!empty($search)) {
            $sql .= " WHERE name LIKE :search
                      OR company LIKE :search
                      OR description LIKE :search
                      OR stage LIKE :search
                      OR product LIKE :search";
            $params['search'] = '%' . $search . '%';
        }

        // Stage is a pipeline position, not a word: sorting it alphabetically
        // puts Complete first and In Progress in the middle. Order it the way
        // the work actually reads instead - what is running, then what is being
        // won, then what is only a lead, and finished work last.
        if ($sortBy === 'stage') {
            $sql .= " ORDER BY " . self::stageRankSql() . " $sortOrder, name COLLATE NOCASE ASC";
        } elseif ($sortBy === 'product') {
            // In the products' own order, the projects without one last
            // either way; within a product by stage, as the list reads.
            $sql .= " ORDER BY (product IS NULL) ASC, " . self::productRankSql() . " $sortOrder, "
                . self::stageRankSql() . " ASC, name COLLATE NOCASE ASC";
        } else {
            $sql .= " ORDER BY $sortBy $sortOrder";
        }

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        $projects = $stmt->fetchAll();
        $companies = Company::companiesByProject($this->db);
        foreach ($projects as &$project) {
            $project['companies'] = $companies[(int) $project['id']] ?? [];
        }
        unset($project);
        return $projects;
    }

    /** The products in their order (products()), as a SQL CASE expression. */
    public static function productRankSql(string $column = 'product'): string
    {
        if (!preg_match('/^[a-z_.]+$/', $column)) {
            $column = 'product';
        }
        $sql = 'CASE ' . $column;
        $names = self::productNames();
        foreach ($names as $i => $product) {
            $sql .= " WHEN '" . str_replace("'", "''", $product) . "' THEN " . $i;
        }
        return $sql . ' ELSE ' . count($names) . ' END';
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
     * The stages that count as live work on the home page: being run or being
     * won. A lead is not work yet and a complete project no longer is.
     */
    public const ACTIVE_STAGES = ['In Progress', 'Proposal', 'Negotiation'];

    /**
     * "stage IN (...)" for ACTIVE_STAGES, so the home page's list and the
     * per-person counts in its switcher use one rule.
     */
    public static function activeStageSql(string $column = 'stage'): string
    {
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_.]*$/', $column)) {
            $column = 'stage';
        }

        return $column . " IN ('" . implode("', '", self::ACTIVE_STAGES) . "')";
    }

    /**
     * Get a single project by ID
     */
    public function getById(int $id): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM projects WHERE id = :id");
        $stmt->execute(['id' => $id]);

        $project = $stmt->fetch();
        if (!$project) {
            return null;
        }
        $project['companies'] = Company::projectCompanies($this->db, $id);
        return $project;
    }

    /**
     * Create a new project
     */
    public function create(array $data): int
    {
        $stmt = $this->db->prepare("
            INSERT INTO projects (name, start_date, description, company, budget_min, budget_max,
                                success_chance, stage, estimated_completion, payments, product,
                                created_by, created_by_name, updated_by, updated_by_name)
            VALUES (:name, :start_date, :description, :company, :budget_min, :budget_max,
                    :success_chance, :stage, :estimated_completion, :payments, :product,
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
            'payments' => self::encodePayments($data['payments'] ?? []),
            'product' => self::cleanProduct($data['product'] ?? null),
        ]);

        $id = (int) $this->db->lastInsertId();
        Company::syncProject($this->db, $id, $data);
        ProjectHistory::recordCreated($this->db, $id, $data);
        return $id;
    }

    /**
     * Update an existing project. Its expected payments are only replaced
     * when $data has a 'payments' key, so an update that does not know
     * about them (a proposal Claude made) leaves them as they are.
     */
    public function update(int $id, array $data): bool
    {
        $withPayments = array_key_exists('payments', $data);
        // Like the payments: only an update that knows the product changes it.
        $withProduct = array_key_exists('product', $data);
        $stmt = $this->db->prepare("
            UPDATE projects
            SET " . ($withPayments ? "payments = :payments," : "") . ($withProduct ? "product = :product," : "") . "
                name = :name,
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

        $params = [
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
        ];
        if ($withPayments) {
            $params['payments'] = self::encodePayments($data['payments'] ?? []);
        }
        if ($withProduct) {
            $params['product'] = self::cleanProduct($data['product']);
        }

        $before = $this->db->prepare("SELECT stage, success_chance, budget_min, budget_max, estimated_completion FROM projects WHERE id = :id");
        $before->execute(['id' => $id]);
        $previous = $before->fetch() ?: [];

        $ok = $stmt->execute($params);
        Company::syncProject($this->db, $id, $data);
        if ($previous) {
            ProjectHistory::recordChanges($this->db, $id, $previous, [
                'stage' => $params['stage'],
                'success_chance' => $params['success_chance'],
                'budget_min' => $params['budget_min'],
                'budget_max' => $params['budget_max'],
                'estimated_completion' => $params['estimated_completion'],
            ]);
        }
        return $ok;
    }

    /**
     * What our projects are about: one product per project, or none. The
     * products are kept in the table products and added from the CRM.
     * [{ id, name, color, position }] in their order.
     */
    public static function products(): array
    {
        $rows = Database::getInstance()->query("SELECT id, name, short, color, position FROM products ORDER BY position, id")->fetchAll();
        return array_map(fn($r) => [
            'id' => (int) $r['id'], 'name' => $r['name'], 'short' => $r['short'] ?: self::shortName($r['name']),
            'color' => $r['color'], 'position' => (int) $r['position'],
        ], $rows);
    }

    /**
     * A product's short form: the initials of its words ("Media Training"
     * -> "MT"), a short word in capitals as it is ("SHIELD" -> "SH" only when
     * longer than five letters), else its first two letters ("Coaching" -> "CO").
     */
    public static function shortName(string $name): string
    {
        $words = preg_split('/[^\p{L}\p{N}]+/u', $name, -1, PREG_SPLIT_NO_EMPTY);
        if (count($words) > 1) {
            return mb_strtoupper(implode('', array_map(fn($w) => mb_substr($w, 0, 1), array_slice($words, 0, 4))));
        }
        $word = $words[0] ?? $name;
        if (mb_strlen($word) <= 5 && $word === mb_strtoupper($word)) {
            return $word;
        }
        return mb_strtoupper(mb_substr($word, 0, 2));
    }

    /** The products' names, in their order. */
    public static function productNames(): array
    {
        return array_column(self::products(), 'name');
    }

    /** Colours for new products, from the company palette and beside it. */
    private const PRODUCT_COLORS = ['#30599D', '#1C3258', '#1C7E7E', '#63A375', '#8A94A6', '#5B7DB8', '#2E8B9A',
        '#7A6FB0', '#B07A3A', '#4C6A92', '#3F8F6B', '#9A5B7A'];

    /** Add a product (or find the one of that name), with the next free colour. */
    public static function addProduct(string $name): array
    {
        $name = trim(preg_replace('/\s+/u', ' ', $name));
        if ($name === '' || mb_strlen($name) > 80) {
            throw new InvalidArgumentException('A product needs a name of up to 80 characters');
        }
        $db = Database::getInstance();
        foreach (self::products() as $product) {
            if (mb_strtolower($product['name']) === mb_strtolower($name)) {
                return $product;
            }
        }
        $used = array_map('strtoupper', array_column(self::products(), 'color'));
        $color = null;
        foreach (self::PRODUCT_COLORS as $c) {
            if (!in_array($c, $used, true)) {
                $color = $c;
                break;
            }
        }
        $color ??= self::PRODUCT_COLORS[count($used) % count(self::PRODUCT_COLORS)];
        $position = (int) $db->query("SELECT COALESCE(MAX(position), -1) + 1 FROM products")->fetchColumn();
        $short = self::shortName($name);
        $db->prepare("INSERT INTO products (name, short, color, position) VALUES (:n, :s, :c, :p)")
            ->execute(['n' => $name, 's' => $short, 'c' => $color, 'p' => $position]);
        return ['id' => (int) $db->lastInsertId(), 'name' => $name, 'short' => $short, 'color' => $color, 'position' => $position];
    }

    /**
     * Save the products as edited in the CRM, in this order:
     * [{ id?, name, short?, color }]. A renamed product renames it on its
     * projects; one left out is gone, and its projects have no product then.
     * Returns the products as they now are.
     */
    public static function saveProducts(array $list): array
    {
        $db = Database::getInstance();
        $clean = [];
        $names = [];
        foreach (array_values($list) as $i => $p) {
            if (!is_array($p)) {
                throw new InvalidArgumentException('Each product needs a name and a colour');
            }
            $name = trim(preg_replace('/\s+/u', ' ', (string) ($p['name'] ?? '')));
            if ($name === '' || mb_strlen($name) > 80) {
                throw new InvalidArgumentException('Product ' . ($i + 1) . ' needs a name of up to 80 characters');
            }
            $key = mb_strtolower($name);
            if (isset($names[$key])) {
                throw new InvalidArgumentException('Two products are called ' . $name);
            }
            $names[$key] = true;
            $color = strtoupper(trim((string) ($p['color'] ?? '')));
            if (!preg_match('/^#[0-9A-F]{6}$/', $color)) {
                throw new InvalidArgumentException('The colour of ' . $name . ' must be like #30599D');
            }
            $short = trim((string) ($p['short'] ?? ''));
            $short = $short === '' ? self::shortName($name) : mb_substr($short, 0, 12);
            $clean[] = ['id' => isset($p['id']) && (int) $p['id'] > 0 ? (int) $p['id'] : null, 'name' => $name, 'short' => $short, 'color' => $color];
        }

        return Database::transactional(function (PDO $db) use ($clean) {
            $old = [];
            foreach ($db->query("SELECT id, name FROM products")->fetchAll() as $row) {
                $old[(int) $row['id']] = $row['name'];
            }
            $kept = array_filter(array_column($clean, 'id'));
            // Gone: their projects have no product any more.
            foreach ($old as $id => $name) {
                if (!in_array($id, $kept, true)) {
                    $db->prepare("UPDATE projects SET product = NULL WHERE product = :n")->execute(['n' => $name]);
                    $db->prepare("DELETE FROM products WHERE id = :id")->execute(['id' => $id]);
                }
            }
            // Renames first under a temporary name, so swapping two names works.
            foreach ($clean as $p) {
                if ($p['id'] !== null && isset($old[$p['id']])) {
                    $temp = "\x01" . $p['id'];
                    $db->prepare("UPDATE products SET name = :n WHERE id = :id")->execute(['n' => $temp, 'id' => $p['id']]);
                    if ($old[$p['id']] !== $p['name']) {
                        $db->prepare("UPDATE projects SET product = :t WHERE product = :old")->execute(['t' => $temp, 'old' => $old[$p['id']]]);
                    }
                }
            }
            foreach ($clean as $position => $p) {
                if ($p['id'] !== null && isset($old[$p['id']])) {
                    $db->prepare("UPDATE products SET name = :n, short = :s, color = :c, position = :pos WHERE id = :id")
                        ->execute(['n' => $p['name'], 's' => $p['short'], 'c' => $p['color'], 'pos' => $position, 'id' => $p['id']]);
                    if ($old[$p['id']] !== $p['name']) {
                        $db->prepare("UPDATE projects SET product = :new WHERE product = :t")->execute(['new' => $p['name'], 't' => "\x01" . $p['id']]);
                    }
                } else {
                    $db->prepare("INSERT INTO products (name, short, color, position) VALUES (:n, :s, :c, :pos)")
                        ->execute(['n' => $p['name'], 's' => $p['short'], 'c' => $p['color'], 'pos' => $position]);
                }
            }
            return self::products();
        });
    }

    /** A product as stored: one of the products (any case), or null. */
    public static function cleanProduct($value): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        foreach (self::productNames() as $product) {
            if (strcasecmp(trim($value), $product) === 0) {
                return $product;
            }
        }
        return null;
    }

    /**
     * Cleans expected payments as they come in: a list of
     * {month: "YYYY-MM", amount > 0, paid: bool, full?: true}, returned ordered by month
     * (stable, so equal months keep their order). Null or an empty list is
     * no payments. Returns an error message instead when anything is off;
     * nothing is guessed or dropped silently.
     *
     * @return array|string
     */
    public static function normalizePayments($input)
    {
        if ($input === null || $input === '') {
            return [];
        }
        if (!is_array($input) || array_values($input) !== $input) {
            return 'payments must be a list';
        }
        if (count($input) > self::MAX_PAYMENTS) {
            return 'A project can have at most ' . self::MAX_PAYMENTS . ' expected payments';
        }

        $payments = [];
        $full = false;
        foreach ($input as $i => $row) {
            $n = $i + 1;
            if (!is_array($row)) {
                return 'Payment ' . $n . ' is not valid';
            }
            $month = is_string($row['month'] ?? null) ? trim($row['month']) : '';
            if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month)) {
                return 'Payment ' . $n . ' needs a month (YYYY-MM)';
            }
            $amount = $row['amount'] ?? null;
            if (!is_numeric($amount) || (float) $amount <= 0 || (float) $amount > 1e10) {
                return 'Payment ' . $n . ' needs an amount above 0';
            }
            $payment = [
                'month' => $month,
                'amount' => round((float) $amount, 2),
                'paid' => filter_var($row['paid'] ?? false, FILTER_VALIDATE_BOOLEAN),
            ];
            // Payment in full: the whole project paid at once, in one
            // payment - possibly after the project has ended. It is then
            // the only payment the project has.
            if (filter_var($row['full'] ?? false, FILTER_VALIDATE_BOOLEAN)) {
                $payment['full'] = true;
                $full = true;
            }
            $payments[] = $payment;
        }
        if ($full && count($payments) > 1) {
            return 'A payment in full is the only payment of a project';
        }

        // usort is stable since PHP 8.0.
        usort($payments, fn($a, $b) => strcmp($a['month'], $b['month']));
        return $payments;
    }

    /**
     * Marks expected payments as paid, each named by project, month and
     * amount: the first unpaid payment of that project that matches both is
     * the one. A payment that was changed or paid in the meantime matches
     * nothing and is skipped, never guessed.
     *
     * @param array $items [{project_id, month, amount}]
     * @return array{marked: int, skipped: int, changed: array<int, array{before: array, after: array}>}
     */
    public function markPaymentsPaid(array $items): array
    {
        return Database::transactional(function (PDO $db) use ($items) {
            $byProject = [];
            foreach ($items as $item) {
                $byProject[(int) ($item['project_id'] ?? 0)][] = $item;
            }

            $marked = 0;
            $skipped = 0;
            $changed = [];
            $actor = Auth::actor();
            $read = $db->prepare("SELECT * FROM projects WHERE id = :id");
            $write = $db->prepare("
                UPDATE projects
                SET payments = :payments, updated_by = :actor_id, updated_by_name = :actor_name, updated_at = CURRENT_TIMESTAMP
                WHERE id = :id
            ");

            foreach ($byProject as $projectId => $wanted) {
                $read->execute(['id' => $projectId]);
                $before = $read->fetch(PDO::FETCH_ASSOC);
                if (!$before) {
                    $skipped += count($wanted);
                    continue;
                }

                $payments = self::decodePayments($before['payments'] ?? null);
                $hits = 0;
                foreach ($wanted as $item) {
                    $month = (string) ($item['month'] ?? '');
                    $amount = (float) ($item['amount'] ?? 0);
                    $found = false;
                    foreach ($payments as $i => $p) {
                        if (empty($p['paid']) && ($p['month'] ?? '') === $month && abs((float) ($p['amount'] ?? 0) - $amount) < 0.005) {
                            $payments[$i]['paid'] = true;
                            $found = true;
                            break;
                        }
                    }
                    $found ? $hits++ : $skipped++;
                }

                if ($hits > 0) {
                    $write->execute([
                        'id' => $projectId,
                        'payments' => self::encodePayments($payments),
                        'actor_id' => $actor['id'],
                        'actor_name' => $actor['name'],
                    ]);
                    $read->execute(['id' => $projectId]);
                    $changed[] = ['before' => $before, 'after' => $read->fetch(PDO::FETCH_ASSOC)];
                    $marked += $hits;
                }
            }

            return ['marked' => $marked, 'skipped' => $skipped, 'changed' => $changed];
        });
    }

    /** A project row's stored payments as a list (empty when none or unreadable). */
    public static function decodePayments($raw): array
    {
        if (!is_string($raw) || $raw === '') {
            return [];
        }
        $list = json_decode($raw, true);
        return is_array($list) ? $list : [];
    }

    private static function encodePayments(array $payments): ?string
    {
        return $payments ? json_encode(array_values($payments)) : null;
    }

    /**
     * Delete a project. It moves to "Deleted projects" (ProjectArchive) with
     * everything that hangs off it, so it can be restored; its document files
     * stay on disk until it is deleted from there for good.
     */
    public function delete(int $id, ?string $reason = null): bool
    {
        return Database::transactional(function (PDO $db) use ($id, $reason) {
            ProjectArchive::archive($db, $id, Auth::actor(), $reason);

            $stmt = $db->prepare("DELETE FROM projects WHERE id = :id");
            return $stmt->execute(['id' => $id]);
        });
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
