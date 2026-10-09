<?php
/**
 * Financials Model
 *
 * What the Financials tab keeps that no other part of the CRM has: our own
 * costs (recurring positions and one-off planned ones), the bank balance as
 * we last entered it, and the settings the cashflow needs (the cash buffer).
 * Income comes from the projects' budgets and expected payments,
 * movements since the balance from Bookkeeping - both are read where they
 * live, not copied here. The arithmetic is in assets/js/cashflow.js.
 *
 * VAT is left out: costs are entered net, like the projects' amounts. The
 * balance is what is in the account.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

class Financials
{
    public const KINDS = ['recurring', 'once'];
    public const INTERVALS = [1, 3, 6, 12];
    public const MAX_COSTS = 500;

    /** Settings with their defaults; stored in app_settings as fin_<key>. */
    public const SETTINGS = [
        'buffer' => 0.0,
    ];

    private PDO $db;

    public function __construct()
    {
        $this->db = Database::getInstance();
        self::ensureSchema($this->db);
    }

    private static function ensureSchema(PDO $db): void
    {
        // A cost is either recurring - every interval_months from start_month,
        // until end_month if there is one, on `day` of the month - or once,
        // in start_month.
        $db->exec("
            CREATE TABLE IF NOT EXISTS fin_costs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(255) NOT NULL,
                category VARCHAR(64),
                amount DECIMAL(12,2) NOT NULL,
                kind VARCHAR(16) NOT NULL DEFAULT 'recurring',
                interval_months INTEGER NOT NULL DEFAULT 1,
                start_month CHAR(7) NOT NULL,
                end_month CHAR(7),
                day INTEGER NOT NULL DEFAULT 1,
                created_by INTEGER,
                created_by_name VARCHAR(255),
                updated_by INTEGER,
                updated_by_name VARCHAR(255),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ");

        // Every balance entered is kept; the newest by date is the anchor.
        $db->exec("
            CREATE TABLE IF NOT EXISTS fin_balances (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                amount DECIMAL(14,2) NOT NULL,
                as_of DATE NOT NULL,
                note VARCHAR(255),
                created_by INTEGER,
                created_by_name VARCHAR(255),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_fin_balances_as_of ON fin_balances(as_of)");
    }

    /** Everything the tab needs in one answer. */
    public function overview(): array
    {
        $costs = $this->db->query("
            SELECT id, name, category, amount, kind, interval_months, start_month, end_month, day,
                   updated_by_name, updated_at
            FROM fin_costs ORDER BY kind DESC, start_month, name COLLATE NOCASE
        ")->fetchAll(PDO::FETCH_ASSOC);

        $balances = $this->db->query("
            SELECT id, amount, as_of, note, created_by_name, created_at
            FROM fin_balances ORDER BY as_of DESC, id DESC LIMIT 12
        ")->fetchAll(PDO::FETCH_ASSOC);

        return [
            'costs' => array_map([self::class, 'presentCost'], $costs),
            'balances' => array_map(fn($b) => ['id' => (int) $b['id'], 'amount' => (float) $b['amount']] + $b, $balances),
            'settings' => $this->settings(),
        ];
    }

    private static function presentCost(array $c): array
    {
        $c['id'] = (int) $c['id'];
        $c['amount'] = (float) $c['amount'];
        $c['interval_months'] = (int) $c['interval_months'];
        $c['day'] = (int) $c['day'];
        return $c;
    }

    /**
     * Cleans a cost as it comes in. Returns the clean row, or an error
     * message; nothing is guessed.
     *
     * @return array|string
     */
    public static function normalizeCost(array $in)
    {
        $name = trim((string) ($in['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 255) {
            return 'A cost needs a name';
        }
        $category = trim((string) ($in['category'] ?? ''));
        if (mb_strlen($category) > 64) {
            return 'The category is too long';
        }

        $amount = $in['amount'] ?? null;
        if (!is_numeric($amount) || (float) $amount <= 0 || (float) $amount > 1e10) {
            return 'A cost needs an amount above 0';
        }

        $kind = in_array($in['kind'] ?? '', self::KINDS, true) ? $in['kind'] : null;
        if ($kind === null) {
            return 'A cost is either recurring or once';
        }

        $month = '/^\d{4}-(0[1-9]|1[0-2])$/';
        $start = (string) ($in['start_month'] ?? '');
        if (!preg_match($month, $start)) {
            return $kind === 'once' ? 'A planned cost needs a month' : 'A recurring cost needs a first month';
        }
        $end = $in['end_month'] ?? null;
        $end = ($end === null || $end === '') ? null : (string) $end;
        if ($end !== null && (!preg_match($month, $end) || $end < $start)) {
            return 'The last month must be on or after the first';
        }

        $interval = (int) ($in['interval_months'] ?? 1);
        if (!in_array($interval, self::INTERVALS, true)) {
            return 'Repeat every 1, 3, 6 or 12 months';
        }

        $day = (int) ($in['day'] ?? 1);
        if ($day < 1 || $day > 31) {
            return 'The day must be between 1 and 31';
        }

        return [
            'name' => $name,
            'category' => $category === '' ? null : $category,
            'amount' => round((float) $amount, 2),
            'kind' => $kind,
            'interval_months' => $kind === 'once' ? 1 : $interval,
            'start_month' => $start,
            'end_month' => $kind === 'once' ? null : $end,
            'day' => $day,
        ];
    }

    /** Creates (no id) or updates a cost; returns its id. */
    public function saveCost(?int $id, array $cost): int
    {
        $actor = Auth::actor();
        $params = $cost + ['actor_id' => $actor['id'], 'actor_name' => $actor['name']];

        if ($id === null) {
            $params += ['actor_id2' => $actor['id'], 'actor_name2' => $actor['name']];
            $count = (int) $this->db->query("SELECT COUNT(*) FROM fin_costs")->fetchColumn();
            if ($count >= self::MAX_COSTS) {
                throw new InvalidArgumentException('There are already ' . self::MAX_COSTS . ' costs');
            }
            $this->db->prepare("
                INSERT INTO fin_costs (name, category, amount, kind, interval_months, start_month, end_month, day,
                                       created_by, created_by_name, updated_by, updated_by_name)
                VALUES (:name, :category, :amount, :kind, :interval_months, :start_month, :end_month, :day,
                        :actor_id, :actor_name, :actor_id2, :actor_name2)
            ")->execute($params);
            return (int) $this->db->lastInsertId();
        }

        $stmt = $this->db->prepare("
            UPDATE fin_costs
            SET name = :name, category = :category, amount = :amount, kind = :kind,
                interval_months = :interval_months, start_month = :start_month, end_month = :end_month, day = :day,
                updated_by = :actor_id, updated_by_name = :actor_name, updated_at = CURRENT_TIMESTAMP
            WHERE id = :id
        ");
        $stmt->execute($params + ['id' => $id]);
        if ($stmt->rowCount() === 0) {
            throw new InvalidArgumentException('This cost no longer exists');
        }
        return $id;
    }

    public function deleteCost(int $id): void
    {
        $this->db->prepare("DELETE FROM fin_costs WHERE id = :id")->execute(['id' => $id]);
    }

    public function addBalance(float $amount, string $asOf, ?string $note): int
    {
        $actor = Auth::actor();
        $this->db->prepare("
            INSERT INTO fin_balances (amount, as_of, note, created_by, created_by_name)
            VALUES (:amount, :as_of, :note, :actor_id, :actor_name)
        ")->execute([
            'amount' => round($amount, 2),
            'as_of' => $asOf,
            'note' => $note,
            'actor_id' => $actor['id'],
            'actor_name' => $actor['name'],
        ]);
        return (int) $this->db->lastInsertId();
    }

    public function deleteBalance(int $id): void
    {
        $this->db->prepare("DELETE FROM fin_balances WHERE id = :id")->execute(['id' => $id]);
    }

    public function settings(): array
    {
        $out = self::SETTINGS;
        $stmt = $this->db->prepare("SELECT key, value FROM app_settings WHERE key LIKE 'fin_%'");
        $stmt->execute();
        foreach ($stmt->fetchAll(PDO::FETCH_KEY_PAIR) as $key => $value) {
            $name = substr($key, 4);
            if (!array_key_exists($name, $out) || $value === null) {
                continue;
            }
            $default = self::SETTINGS[$name];
            $out[$name] = is_bool($default) ? $value === '1' : (is_float($default) ? (float) $value : (string) $value);
        }
        return $out;
    }

    /**
     * Saves the settings that are sent; returns an error message or null.
     */
    public function saveSettings(array $in): ?string
    {
        $clean = [];
        if (array_key_exists('buffer', $in)) {
            if (!is_numeric($in['buffer']) || (float) $in['buffer'] < 0 || (float) $in['buffer'] > 1e10) {
                return 'The cash buffer must be 0 or more';
            }
            $clean['buffer'] = (string) round((float) $in['buffer'], 2);
        }

        $stmt = $this->db->prepare("
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (:key, :value, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        ");
        foreach ($clean as $key => $value) {
            $stmt->execute(['key' => 'fin_' . $key, 'value' => $value]);
        }
        return null;
    }
}
