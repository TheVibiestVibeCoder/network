<?php
/**
 * Companies: our customers and the firms our contacts work for.
 *
 * A company is a record of its own (table companies). Contacts point to one
 * (contacts.company_id), projects to any number (project_companies). The old
 * text columns contacts.company and projects.company stay, as a copy of the
 * name(s) kept in step here, so search, lists, activity and the Claude
 * connector that read them go on working.
 *
 * Writing a name into a contact or project (a form, an import, a proposal
 * from Claude) finds the company of that name or creates it: nothing has to
 * pick a company id first. Names that only look alike are never merged
 * automatically - similar() lists them for a person to decide.
 */

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

class Company
{
    /** Words that say what kind of company it is, not which one. */
    private const NAME_NOISE = ['gmbh', 'ltd', 'limited', 'inc', 'llc', 'ag', 'kg', 'og', 'eu', 'co', 'bv', 'sarl', 'se',
        'srl', 'mbh', 'gesmbh', 'gesellschaft', 'ug', 'ev', 'e.v', 'und', 'and', 'the', 'der', 'die', 'das', 'von', 'for', 'für'];

    public const MAX_PER_PROJECT = 10;

    /** A name as stored: trimmed, inner spaces collapsed, at most 255 characters; null for none. */
    public static function cleanName($name): ?string
    {
        if (!is_string($name)) {
            return null;
        }
        $name = trim(preg_replace('/\s+/u', ' ', $name));
        if ($name === '') {
            return null;
        }
        return mb_substr($name, 0, 255);
    }

    /** The company of that name (any case), created when there is none. */
    public static function findOrCreate(PDO $db, string $name): int
    {
        $name = self::cleanName($name);
        if ($name === null) {
            throw new InvalidArgumentException('A company needs a name');
        }
        $id = self::idByName($db, $name);
        if ($id !== null) {
            return $id;
        }
        $actor = Auth::actor();
        $db->prepare("
            INSERT INTO companies (name, created_by, created_by_name, updated_by, updated_by_name)
            VALUES (:name, :a, :an, :a2, :an2)
        ")->execute(['name' => $name, 'a' => $actor['id'], 'an' => $actor['name'], 'a2' => $actor['id'], 'an2' => $actor['name']]);
        return (int) $db->lastInsertId();
    }

    public static function idByName(PDO $db, string $name): ?int
    {
        $stmt = $db->prepare("SELECT id FROM companies WHERE name = :name");
        $stmt->execute(['name' => self::cleanName($name) ?? '']);
        $id = $stmt->fetchColumn();
        return $id === false ? null : (int) $id;
    }

    // ------------------------------------------------------------------
    // Contacts and projects
    // ------------------------------------------------------------------

    /**
     * A contact's company from the name written into it: linked, and the
     * text set to the company's own spelling. No name, no company.
     */
    public static function syncContact(PDO $db, int $contactId, $name): void
    {
        $name = self::cleanName($name);
        if ($name === null) {
            $db->prepare("UPDATE contacts SET company_id = NULL WHERE id = :id")->execute(['id' => $contactId]);
            return;
        }
        $companyId = self::findOrCreate($db, $name);
        $db->prepare("UPDATE contacts SET company_id = :c, company = (SELECT name FROM companies WHERE id = :c2) WHERE id = :id")
            ->execute(['c' => $companyId, 'c2' => $companyId, 'id' => $contactId]);
    }

    /**
     * A project's companies after a save. With company_ids in $data (the
     * sheet) those are linked, in that order; otherwise the company text
     * decides (an older client, a proposal from Claude): unchanged text keeps
     * the links, another name links that one company, none links none.
     */
    public static function syncProject(PDO $db, int $projectId, array $data): void
    {
        if (array_key_exists('company_ids', $data) && is_array($data['company_ids'])) {
            self::setProjectCompanies($db, $projectId, $data['company_ids']);
            return;
        }
        if (!array_key_exists('company', $data)) {
            return;
        }
        $text = self::cleanName($data['company']);
        $current = self::projectCompanies($db, $projectId);
        $joined = implode(', ', array_column($current, 'name'));
        if ($text !== null && mb_strtolower($text) === mb_strtolower($joined)) {
            self::refreshProjectText($db, $projectId);
            return;
        }
        self::setProjectCompanies($db, $projectId, $text === null ? [] : [self::findOrCreate($db, $text)]);
    }

    /** Link exactly these companies (ids, in order) to the project. */
    public static function setProjectCompanies(PDO $db, int $projectId, array $ids): void
    {
        $clean = [];
        foreach ($ids as $id) {
            $id = (int) $id;
            if ($id > 0 && !in_array($id, $clean, true)) {
                $clean[] = $id;
            }
        }
        $clean = array_slice($clean, 0, self::MAX_PER_PROJECT);
        $db->prepare("DELETE FROM project_companies WHERE project_id = :p")->execute(['p' => $projectId]);
        $insert = $db->prepare("
            INSERT OR IGNORE INTO project_companies (project_id, company_id, position)
            SELECT :p, id, :pos FROM companies WHERE id = :c
        ");
        foreach ($clean as $pos => $companyId) {
            $insert->execute(['p' => $projectId, 'pos' => $pos, 'c' => $companyId]);
        }
        self::refreshProjectText($db, $projectId);
    }

    /** projects.company as the names of its companies, in order. */
    public static function refreshProjectText(PDO $db, int $projectId): void
    {
        $names = array_column(self::projectCompanies($db, $projectId), 'name');
        $db->prepare("UPDATE projects SET company = :c WHERE id = :id")
            ->execute(['c' => $names ? implode(', ', $names) : null, 'id' => $projectId]);
    }

    /** [{ id, name }] in their order. */
    public static function projectCompanies(PDO $db, int $projectId): array
    {
        $stmt = $db->prepare("
            SELECT c.id, c.name FROM project_companies pc JOIN companies c ON c.id = pc.company_id
            WHERE pc.project_id = :p ORDER BY pc.position, c.name COLLATE NOCASE
        ");
        $stmt->execute(['p' => $projectId]);
        return array_map(fn($r) => ['id' => (int) $r['id'], 'name' => $r['name']], $stmt->fetchAll());
    }

    /**
     * Every project's companies at once, for lists: project id => [{ id, name }].
     */
    public static function companiesByProject(PDO $db): array
    {
        $rows = $db->query("
            SELECT pc.project_id, c.id, c.name FROM project_companies pc JOIN companies c ON c.id = pc.company_id
            ORDER BY pc.project_id, pc.position, c.name COLLATE NOCASE
        ")->fetchAll();
        $out = [];
        foreach ($rows as $r) {
            $out[(int) $r['project_id']][] = ['id' => (int) $r['id'], 'name' => $r['name']];
        }
        return $out;
    }

    // ------------------------------------------------------------------
    // Reading
    // ------------------------------------------------------------------

    /** Every company with how many contacts and projects it has. */
    public static function all(PDO $db): array
    {
        $rows = $db->query("
            SELECT c.id, c.name, c.website,
                (SELECT COUNT(*) FROM contacts k WHERE k.company_id = c.id) AS contacts,
                (SELECT COUNT(*) FROM project_companies pc WHERE pc.company_id = c.id) AS projects
            FROM companies c ORDER BY c.name COLLATE NOCASE
        ")->fetchAll();
        foreach ($rows as &$row) {
            $row['id'] = (int) $row['id'];
            $row['contacts'] = (int) $row['contacts'];
            $row['projects'] = (int) $row['projects'];
        }
        return $rows;
    }

    public static function get(PDO $db, int $id): ?array
    {
        $stmt = $db->prepare("SELECT * FROM companies WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $company = $stmt->fetch();
        if (!$company) {
            return null;
        }
        $company['id'] = (int) $company['id'];
        return $company;
    }

    /**
     * A company with its contacts (and when each last had a note) and its
     * projects (with what the figures on its page need).
     */
    public static function detail(PDO $db, int $id): ?array
    {
        $company = self::get($db, $id);
        if ($company === null) {
            return null;
        }
        $stmt = $db->prepare("
            SELECT k.id, k.name, k.email, k.phone, k.review_status,
                (SELECT MAX(n.created_at) FROM notes n WHERE n.contact_id = k.id) AS last_note
            FROM contacts k WHERE k.company_id = :id ORDER BY k.name COLLATE NOCASE
        ");
        $stmt->execute(['id' => $id]);
        $company['contacts'] = $stmt->fetchAll();

        $stmt = $db->prepare("
            SELECT p.id, p.name, p.stage, p.product, p.start_date, p.estimated_completion,
                p.budget_min, p.budget_max, p.success_chance, p.payments, p.review_status,
                (SELECT COUNT(*) FROM project_companies o WHERE o.project_id = p.id) AS companies
            FROM project_companies pc JOIN projects p ON p.id = pc.project_id
            WHERE pc.company_id = :id
            ORDER BY " . Project::stageRankSql('p.stage') . " ASC, p.start_date DESC
        ");
        $stmt->execute(['id' => $id]);
        $projects = $stmt->fetchAll();
        foreach ($projects as &$project) {
            $project['payments'] = Project::decodePayments($project['payments']);
            $project['companies'] = (int) $project['companies'];
        }
        unset($project);
        $company['projects'] = $projects;
        return $company;
    }

    // ------------------------------------------------------------------
    // Writing
    // ------------------------------------------------------------------

    /**
     * Change a company's name and details. A new name is written into its
     * contacts, its projects' company text and the notes filed under the old
     * name, so the notes stay with it.
     */
    public static function update(PDO $db, int $id, array $data): array
    {
        $company = self::get($db, $id);
        if ($company === null) {
            throw new RuntimeException('Company not found', 404);
        }
        $name = array_key_exists('name', $data) ? self::cleanName($data['name']) : $company['name'];
        if ($name === null) {
            throw new InvalidArgumentException('A company needs a name');
        }
        $other = self::idByName($db, $name);
        if ($other !== null && $other !== $id) {
            throw new InvalidArgumentException('There is already a company called ' . $name);
        }
        $field = static function (string $key, int $max) use ($data, $company) {
            if (!array_key_exists($key, $data)) {
                return $company[$key];
            }
            $value = is_string($data[$key]) ? trim($data[$key]) : '';
            return $value === '' ? null : mb_substr($value, 0, $max);
        };
        $actor = Auth::actor();
        $db->prepare("
            UPDATE companies SET name = :name, website = :website, address = :address, vat_id = :vat,
                updated_at = CURRENT_TIMESTAMP, updated_by = :a, updated_by_name = :an
            WHERE id = :id
        ")->execute([
            'name' => $name,
            'website' => $field('website', 255),
            'address' => $field('address', 2000),
            'vat' => $field('vat_id', 64),
            'a' => $actor['id'],
            'an' => $actor['name'],
            'id' => $id,
        ]);
        if ($name !== $company['name']) {
            self::renameEverywhere($db, $id, $company['name'], $name);
        }
        return self::get($db, $id);
    }

    private static function renameEverywhere(PDO $db, int $id, string $old, string $new): void
    {
        $db->prepare("UPDATE contacts SET company = :n WHERE company_id = :id")->execute(['n' => $new, 'id' => $id]);
        $db->prepare("UPDATE notes SET company = :n WHERE LOWER(TRIM(company)) = LOWER(:o)")->execute(['n' => $new, 'o' => $old]);
        $stmt = $db->prepare("SELECT project_id FROM project_companies WHERE company_id = :id");
        $stmt->execute(['id' => $id]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $projectId) {
            self::refreshProjectText($db, (int) $projectId);
        }
    }

    /**
     * Merge $fromId into $intoId: its contacts, projects, notes and invoice
     * links move over, then it is gone. Details the target lacks are taken.
     */
    public static function merge(PDO $db, int $fromId, int $intoId): array
    {
        if ($fromId === $intoId) {
            throw new InvalidArgumentException('A company cannot be merged into itself');
        }
        $from = self::get($db, $fromId);
        $into = self::get($db, $intoId);
        if ($from === null || $into === null) {
            throw new RuntimeException('Company not found', 404);
        }
        foreach (['website', 'address', 'vat_id'] as $key) {
            if (empty($into[$key]) && !empty($from[$key])) {
                $db->prepare("UPDATE companies SET " . $key . " = :v WHERE id = :id")->execute(['v' => $from[$key], 'id' => $intoId]);
            }
        }
        $db->prepare("UPDATE contacts SET company_id = :into, company = :name WHERE company_id = :from")
            ->execute(['into' => $intoId, 'name' => $into['name'], 'from' => $fromId]);
        $db->prepare("UPDATE notes SET company = :n WHERE LOWER(TRIM(company)) = LOWER(:o)")
            ->execute(['n' => $into['name'], 'o' => $from['name']]);

        $stmt = $db->prepare("SELECT project_id, position FROM project_companies WHERE company_id = :from");
        $stmt->execute(['from' => $fromId]);
        $moved = $stmt->fetchAll();
        $db->prepare("DELETE FROM project_companies WHERE company_id = :from")->execute(['from' => $fromId]);
        $insert = $db->prepare("INSERT OR IGNORE INTO project_companies (project_id, company_id, position) VALUES (:p, :c, :pos)");
        foreach ($moved as $row) {
            $insert->execute(['p' => $row['project_id'], 'c' => $intoId, 'pos' => $row['position']]);
            self::refreshProjectText($db, (int) $row['project_id']);
        }
        $db->prepare("UPDATE invoice_links SET company_id = :into WHERE company_id = :from")
            ->execute(['into' => $intoId, 'from' => $fromId]);
        $db->prepare("DELETE FROM companies WHERE id = :from")->execute(['from' => $fromId]);
        self::forgetDismissed($db, $fromId);
        return self::get($db, $intoId);
    }

    /** Delete a company: its contacts keep their name text but lose the link. */
    public static function delete(PDO $db, int $id): void
    {
        $stmt = $db->prepare("SELECT project_id FROM project_companies WHERE company_id = :id");
        $stmt->execute(['id' => $id]);
        $projects = $stmt->fetchAll(PDO::FETCH_COLUMN);
        $db->prepare("UPDATE contacts SET company_id = NULL WHERE company_id = :id")->execute(['id' => $id]);
        $db->prepare("DELETE FROM project_companies WHERE company_id = :id")->execute(['id' => $id]);
        $db->prepare("UPDATE invoice_links SET company_id = NULL WHERE company_id = :id")->execute(['id' => $id]);
        $db->prepare("DELETE FROM companies WHERE id = :id")->execute(['id' => $id]);
        foreach ($projects as $projectId) {
            self::refreshProjectText($db, (int) $projectId);
        }
        self::forgetDismissed($db, $id);
    }

    // ------------------------------------------------------------------
    // Look-alikes
    // ------------------------------------------------------------------

    /** "Disinfo Combat GmbH" -> "disinfocombat": the part of a name that tells which company. */
    public static function nameKey(string $name): string
    {
        $words = preg_split('/[^\p{L}\p{N}]+/u', mb_strtolower($name), -1, PREG_SPLIT_NO_EMPTY);
        $kept = array_filter($words, fn($w) => !in_array($w, self::NAME_NOISE, true));
        return implode('', $kept ?: $words);
    }

    /**
     * Pairs of companies whose names look like the same firm, for a person
     * to merge or keep apart: the same name without legal form and
     * punctuation, one inside the other, or a typo apart. Pairs already
     * kept apart are left out.
     *
     * @return array<int, array{a: array, b: array, why: string}>
     */
    public static function similar(PDO $db): array
    {
        $companies = self::all($db);
        $dismissed = self::dismissed($db);
        $pairs = [];
        $n = count($companies);
        for ($i = 0; $i < $n; $i++) {
            $ka = self::nameKey($companies[$i]['name']);
            for ($j = $i + 1; $j < $n; $j++) {
                $kb = self::nameKey($companies[$j]['name']);
                if ($ka === '' || $kb === '') {
                    continue;
                }
                $why = null;
                if ($ka === $kb) {
                    $why = 'same name';
                } elseif (min(mb_strlen($ka), mb_strlen($kb)) >= 4 && (str_contains($ka, $kb) || str_contains($kb, $ka))) {
                    $why = 'one name in the other';
                } elseif (min(strlen($ka), strlen($kb)) >= 6 && levenshtein($ka, $kb) <= 2) {
                    $why = 'nearly the same';
                }
                if ($why === null) {
                    continue;
                }
                $key = self::pairKey($companies[$i]['id'], $companies[$j]['id']);
                if (in_array($key, $dismissed, true)) {
                    continue;
                }
                $pairs[] = ['a' => $companies[$i], 'b' => $companies[$j], 'why' => $why];
            }
        }
        return $pairs;
    }

    public static function dismissPair(PDO $db, int $a, int $b): void
    {
        $list = self::dismissed($db);
        $key = self::pairKey($a, $b);
        if (!in_array($key, $list, true)) {
            $list[] = $key;
        }
        self::saveDismissed($db, $list);
    }

    private static function pairKey(int $a, int $b): string
    {
        return min($a, $b) . '-' . max($a, $b);
    }

    private static function dismissed(PDO $db): array
    {
        $raw = $db->query("SELECT value FROM app_settings WHERE key = 'company_pairs_kept'")->fetchColumn();
        $list = $raw ? json_decode($raw, true) : [];
        return is_array($list) ? $list : [];
    }

    private static function saveDismissed(PDO $db, array $list): void
    {
        $db->prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('company_pairs_kept', :v, CURRENT_TIMESTAMP)")
            ->execute(['v' => json_encode(array_values($list))]);
    }

    private static function forgetDismissed(PDO $db, int $id): void
    {
        $list = array_filter(self::dismissed($db), function ($key) use ($id) {
            [$a, $b] = array_map('intval', explode('-', $key));
            return $a !== $id && $b !== $id;
        });
        self::saveDismissed($db, $list);
    }
}
