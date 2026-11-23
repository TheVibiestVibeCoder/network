<?php
/**
 * Claude connector: expected payments, bank entries, Financials, forecast.
 *
 *     php tests/mcp-money.test.php
 *
 * Runs McpService - the code behind api/mcp.php - against a scratch SQLite
 * database: the new reading actions, the two payment proposals with their
 * refusals, and what reaches the review queue. The forecast's arithmetic
 * itself is checked against the browser code in tests/cashflow-parity.test.js.
 * Never touches data/crm.db.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

define('APP_ROOT', dirname(__DIR__));
$scratch = sys_get_temp_dir() . '/crm-mcp-money-test-' . bin2hex(random_bytes(4));
mkdir($scratch, 0700);
define('DATA_DIR', $scratch);
define('DB_PATH', $scratch . '/crm.db');

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Contact.php';
require_once APP_ROOT . '/includes/Project.php';
require_once APP_ROOT . '/includes/ReviewQueue.php';
require_once APP_ROOT . '/includes/McpService.php';

register_shutdown_function(static function () use ($scratch): void {
    foreach (glob($scratch . '/*') ?: [] as $file) {
        @unlink($file);
    }
    @rmdir($scratch);
});

// =============================================================================
// A tiny test runner
// =============================================================================

$results = [];
function test(string $name, callable $fn): void
{
    global $results;
    try {
        $fn();
        $results[] = [$name, true, ''];
    } catch (Throwable $e) {
        $results[] = [$name, false, $e->getMessage() . ' (line ' . $e->getLine() . ')'];
    }
}
function eq($actual, $expected, string $label = 'value'): void
{
    if ($actual !== $expected) {
        throw new RuntimeException($label . ': expected ' . json_encode($expected) . ', got ' . json_encode($actual));
    }
}
function near(float $actual, float $expected, string $label = 'value'): void
{
    if (abs($actual - $expected) > 0.005) {
        throw new RuntimeException($label . ': expected ' . $expected . ', got ' . $actual);
    }
}
function ok($condition, string $label): void
{
    if (!$condition) {
        throw new RuntimeException($label);
    }
}
/** The refusal an action gives, or a failure when it gives none. */
function refused(string $action, array $params): string
{
    try {
        mcp($action, $params);
    } catch (McpError $e) {
        return $e->getMessage();
    }
    throw new RuntimeException($action . ' was not refused');
}
function mcp(string $action, array $params = [])
{
    return (new McpService())->handle($action, $params);
}

/** "YYYY-MM" n months from this one. */
function ym(int $offset): string
{
    return Cashflow::monthKey($offset, Cashflow::nowOf(Cashflow::today()));
}
function ymd(int $offset, int $day): string
{
    return ym($offset) . '-' . str_pad((string) $day, 2, '0', STR_PAD_LEFT);
}

// =============================================================================
// Fixtures
// =============================================================================

$db = Database::getInstance();
Auth::actAs(null, MCP_ACTOR_NAME);

$db->exec("INSERT INTO projects (id, name, start_date, description, company, budget_min, budget_max, success_chance, stage, estimated_completion, payments, claude_summary)
           VALUES (1, 'Lagebild Q4', '" . ymd(-2, 1) . "', 'Monitoring', 'ACME', 20000, 30000, 80, 'In Progress', '" . ymd(2, 28) . "',
                   '" . json_encode([
                       ['month' => ym(-1), 'amount' => 5000, 'paid' => true],
                       ['month' => ym(-1), 'amount' => 3000, 'paid' => false],
                       ['month' => ym(1), 'amount' => 7000, 'paid' => false],
                   ]) . "', 'Runs well; second report due.')");
$db->exec("INSERT INTO projects (id, name, start_date, description, company, budget_min, budget_max, success_chance, stage, estimated_completion)
           VALUES (2, 'Workshop', '" . ymd(0, 1) . "', 'Training', 'Muster', 12000, 12000, 50, 'Proposal', '" . ymd(1, 15) . "')");
$db->exec("INSERT INTO projects (id, name, start_date, description, stage, review_status)
           VALUES (3, 'Proposed one', '" . ymd(0, 1) . "', 'Claude proposed this', 'Lead', 'pending')");
$db->exec("INSERT INTO projects (id, name, start_date, description, stage) VALUES (4, 'Old pitch', '" . ymd(-6, 1) . "', 'Gone', 'Lead')");

$db->exec("INSERT INTO todos (id, title, project_id) VALUES (10, 'Write report', 1)");
$db->exec("INSERT INTO todo_links (todo_id, url, title) VALUES (10, 'https://docs.google.com/document/d/abc/edit', 'Report draft')");

// Bookkeeping, as api/bookkeeping.php creates it.
$db->exec("CREATE TABLE bookkeeping_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, row_date DATE, data TEXT NOT NULL DEFAULT '{}',
           no_pdf_needed INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0, import_batch INTEGER NOT NULL DEFAULT 0,
           created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
$db->exec("CREATE TABLE bookkeeping_columns (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) NOT NULL UNIQUE, position INTEGER NOT NULL DEFAULT 0)");
$db->exec("CREATE TABLE bookkeeping_pdfs (id INTEGER PRIMARY KEY AUTOINCREMENT, row_id INTEGER, original_name VARCHAR(255) NOT NULL,
           stored_name VARCHAR(255) NOT NULL, file_size INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
           invoice_data TEXT, invoice_error TEXT)");
$db->exec("CREATE TABLE bookkeeping_settings (key VARCHAR(64) PRIMARY KEY, value TEXT)");
ReviewQueue::ensureBookkeepingColumn();

foreach (['Buchungsdatum', 'Partnername', 'Betrag', 'Verwendungszweck'] as $i => $name) {
    $db->prepare("INSERT INTO bookkeeping_columns (name, position) VALUES (:n, :p)")->execute(['n' => $name, 'p' => $i]);
}
$db->exec("INSERT INTO bookkeeping_settings (key, value) VALUES ('csv_date_column', 'Buchungsdatum')");
$bank = [
    [101, ymd(-1, 10), 'ACME GmbH', '5.000,00', 'Rechnung 1', 0],
    [102, ymd(-1, 12), 'Hetzner Online GmbH', '-119,00', 'Server', 0],
    [103, ymd(-1, 20), 'Eigenes Konto', '-2.000,00', 'Umbuchung', 1],
    [104, ymd(0, 2), 'Finanzamt Wien', '-850,00', 'UVA', 0],
    [105, ymd(0, 3), 'Adobe Systems', '-59,99', 'Abo', 0],
];
foreach ($bank as [$id, $date, $party, $amount, $text, $excluded]) {
    $db->prepare("INSERT INTO bookkeeping_rows (id, row_date, data, excluded) VALUES (:id, :d, :data, :x)")->execute([
        'id' => $id, 'd' => $date, 'x' => $excluded,
        'data' => json_encode(['Buchungsdatum' => $date, 'Partnername' => $party, 'Betrag' => $amount, 'Verwendungszweck' => $text]),
    ]);
}
$invoice = ['kind' => 'invoice', 'issuer' => 'Hetzner Online GmbH', 'invoice_number' => 'R-1', 'invoice_date' => ymd(-1, 1),
            'currency' => 'EUR', 'net' => 99.17, 'vat' => 19.83, 'gross' => 119.0, 'model' => 'x'];
$db->prepare("INSERT INTO bookkeeping_pdfs (row_id, original_name, stored_name, invoice_data) VALUES (102, 'hetzner.pdf', 'a.pdf', :inv)")
    ->execute(['inv' => json_encode($invoice)]);
$db->prepare("INSERT INTO bookkeeping_pdfs (row_id, original_name, stored_name, invoice_data) VALUES (NULL, 'pool.pdf', 'b.pdf', :inv)")
    ->execute(['inv' => json_encode(['issuer' => 'Google', 'gross' => 12.0] + $invoice)]);

// Financials: a balance before the bank rows, a cost, a loan, the tax office row paying last quarter.
$fin = new Financials();
$fin->addBalance(10000.0, ymd(-2, 28), 'Start');
$db->exec("INSERT INTO fin_costs (name, amount, kind, interval_months, start_month, day) VALUES ('Hetzner', 99.17, 'recurring', 1, '" . ym(-6) . "', 5)");
$db->exec("INSERT INTO fin_debts (name, lender, amount, start_date, end_date, rate) VALUES ('Darlehen', 'Bank', 10000, '" . ymd(-12, 1) . "', '" . ymd(3, 1) . "', 3)");
$lastQuarter = Cashflow::shiftQuarter(Cashflow::quarterOf(Cashflow::today()->format('Y-m-d')), -1);
$db->prepare("INSERT INTO app_settings (key, value) VALUES ('fin_vat_links', :v)")->execute(['v' => json_encode([$lastQuarter => ['rows' => [104], 'settled' => false]])]);

(new Project())->delete(4);

// =============================================================================
// Reading
// =============================================================================

test('projects.get: payments, their summary, the Claude summary and to-do links', function () {
    $r = mcp('projects.get', ['project_id' => 1]);
    eq(count($r['project']['expected_payments']), 3, 'payments');
    eq($r['project']['claude_summary'], 'Runs well; second report due.', 'summary');
    $s = $r['project']['payments_summary'];
    near($s['planned'], 15000, 'planned');
    near($s['paid'], 5000, 'paid');
    eq($s['not_planned_yet'], ['min' => 5000.0, 'max' => 15000.0], 'not planned yet');
    eq($s['still_to_pay'], ['min' => 15000.0, 'max' => 25000.0], 'still to pay');
    eq($r['todos'][0]['links'][0]['title'], 'Report draft', 'link');
    eq($r['todos'][0]['links'][0]['kind'] !== '', true, 'link kind');
});

test('todos.list carries the links', function () {
    $r = mcp('todos.list', ['project_id' => 1]);
    eq($r['todos'][0]['links'][0]['url'], 'https://docs.google.com/document/d/abc/edit', 'url');
});

test('payments.list: open by default, overdue marked, totals by month', function () {
    $r = mcp('payments.list');
    eq($r['count'], 2, 'open payments');
    eq($r['payments'][0]['month'], ym(-1), 'oldest first');
    eq($r['payments'][0]['overdue'], true, 'last month unpaid = overdue');
    eq($r['payments'][1]['overdue'], false, 'next month not overdue');
    near($r['totals']['open'], 10000, 'open total');
    near($r['by_month'][ym(1)]['open'], 7000, 'by month');

    eq(mcp('payments.list', ['status' => 'all'])['count'], 3, 'all');
    eq(mcp('payments.list', ['status' => 'paid'])['payments'][0]['amount'], 5000.0, 'paid');
    eq(mcp('payments.list', ['overdue_only' => true])['count'], 1, 'overdue only');
    eq(mcp('payments.list', ['from_month' => ym(0), 'to_month' => ym(6)])['count'], 1, 'month range');
    ok(str_contains(refused('payments.list', ['from_month' => '2026-13']), 'YYYY-MM'), 'bad month refused');
});

test('projects.archived lists the archived project', function () {
    $r = mcp('projects.archived');
    eq($r['total'], 1, 'one archived');
    eq($r['archived'][0]['name'], 'Old pitch', 'name');
    eq(mcp('projects.archived', ['query' => 'nothing like it'])['total'], 0, 'query');
});

test('bookkeeping.pool shows what the invoice reader found', function () {
    $r = mcp('bookkeeping.pool');
    eq($r['pdfs'][0]['invoice']['issuer'], 'Google', 'issuer');
    eq(isset($r['pdfs'][0]['invoice']['model']), false, 'internal keys left out');
    eq($r['pdfs'][0]['invoice_read'], 'read', 'read state');
});

test('bookkeeping.rows: newest first, sums without excluded rows, invoices, VAT quarter', function () {
    $r = mcp('bookkeeping.rows');
    eq($r['amount_column'], 'Betrag', 'amount column');
    eq($r['count'], 4, 'excluded left out');
    eq($r['rows'][0]['id'], 105, 'newest first');
    near($r['sums']['in'], 5000, 'in');
    near($r['sums']['out'], 119 + 850 + 59.99, 'out');
    $byId = array_column($r['rows'], null, 'id');
    eq($byId[104]['vat_quarter'], Cashflow::shiftQuarter(Cashflow::quarterOf(Cashflow::today()->format('Y-m-d')), -1), 'tax office row');
    eq($byId[104]['needs_invoice'], false, 'a VAT payment needs no invoice');
    near($byId[102]['vat'], 19.83, 'VAT from the invoice');
    eq($byId[102]['invoice']['invoice_number'], 'R-1', 'invoice facts');
    eq($byId[105]['needs_invoice'], true, 'no invoice yet');

    eq(mcp('bookkeeping.rows', ['include_excluded' => true])['count'], 5, 'with excluded');
    eq(mcp('bookkeeping.rows', ['missing_invoice_only' => true])['count'], 2, 'missing invoices');
    eq(mcp('bookkeeping.rows', ['direction' => 'in'])['count'], 1, 'money in');
    eq(mcp('bookkeeping.rows', ['query' => 'hetzner'])['rows'][0]['id'], 102, 'query');
    eq(mcp('bookkeeping.rows', ['date_from' => ymd(0, 1)])['count'], 2, 'from date');
});

test('financials.get: balance today = last balance + bank rows after it', function () {
    $r = mcp('financials.get');
    near($r['balance_today']['amount'], 10000 + 5000 - 119 - 850 - 59.99, 'balance today');
    eq($r['balance_today']['rows'], 4, 'rows after the balance');
    near($r['fixed_costs_per_month'], 99.17, 'fixed per month');
    eq($r['debts']['open_count'], 1, 'open loan');
    ok(count($r['vat_quarters']) >= 1, 'VAT quarters');
    eq($r['bank_entries']['amount_column'], 'Betrag', 'bank entries');
});

test('financials.forecast: the same plan as Cashflow::plan, scenarios compared', function () {
    $r = mcp('financials.forecast', ['months' => 6]);
    eq(count($r['months_ahead']), 6, 'months');
    eq($r['scenario']['name'], 'realistic', 'default scenario');

    $in = Cashflow::inputs(Database::getInstance(), Cashflow::today());
    $plan = Cashflow::plan(['scenario' => Cashflow::scenario('realistic'), 'months' => 6] + $in);
    foreach ($plan['rows'] as $i => $row) {
        near($r['months_ahead'][$i]['closing'], $row['closing'], 'closing ' . $row['month']);
        near($r['months_ahead'][$i]['income'], $row['income'], 'income ' . $row['month']);
    }
    // Lagebild: the overdue 3,000 lands in this month, x 80 %.
    $now = $r['months_ahead'][0]['items']['income'];
    $overdue = array_values(array_filter($now, fn($x) => $x['overdue'] && $x['project_id'] === 1));
    near($overdue[0]['expected'], 2400, 'overdue payment x chance');
    // The loan comes back in month 3 with its interest.
    ok($r['months_ahead'][3]['debt_repayments'] > 10000, 'loan repaid with interest');
    eq(array_keys($r['scenarios_compared']), ['worst', 'realistic', 'best'], 'scenarios');
    ok($r['scenarios_compared']['best']['income_total'] >= $r['scenarios_compared']['worst']['income_total'], 'best >= worst');
    eq(isset($r['year']['projected']), true, 'year result');

    $custom = mcp('financials.forecast', ['scenario' => 'best', 'stages' => ['Proposal'], 'exclude_project_ids' => [1], 'details' => false]);
    eq($custom['scenario']['name'], 'custom', 'custom scenario');
    eq(isset($custom['months_ahead'][0]['items']), false, 'details off');
    ok(str_contains(refused('financials.forecast', ['scenario' => 'dreamy']), 'scenario must be one of'), 'bad scenario refused');
    ok(str_contains(refused('financials.forecast', ['stages' => ['Won']]), 'stages must be one of'), 'bad stage refused');
});

// =============================================================================
// Proposing payments
// =============================================================================

test('projects.set_payments proposes the whole list as one field', function () {
    $new = [
        ['month' => ym(1), 'amount' => 7000],
        ['month' => ym(-1), 'amount' => 5000, 'paid' => true],
        ['month' => ym(-1), 'amount' => 3000],
        ['month' => ym(2), 'amount' => 10000],
    ];
    $r = mcp('projects.set_payments', ['project_id' => 1, 'payments' => $new, 'reason' => 'from the offer']);
    eq($r['status'], 'proposed', 'status');
    eq(count($r['payments']), 4, 'four payments');
    eq($r['payments'][0]['month'], ym(-1), 'sorted by month');
    ok(in_array(true, array_map(fn($w) => str_contains($w, 'overdue'), $r['warnings']), true), 'overdue warned');

    $item = ReviewQueue::get($r['review_id']);
    eq($item['kind'], 'update', 'kind');
    eq(array_keys($item['payload']), ['payments'], 'one field');
    eq(count($item['previous']['payments']), 3, 'previous list kept');
    eq($item['comment'], 'from the offer', 'reason');

    // Nothing changed yet: it waits for a person.
    eq(count(mcp('projects.get', ['project_id' => 1])['project']['expected_payments']), 3, 'unchanged until accepted');
});

test('a second payments proposal for the same project is refused until the first is decided', function () {
    $msg = refused('projects.mark_payment_paid', ['project_id' => 1, 'month' => ym(-1)]);
    ok(str_contains($msg, 'already an open proposal'), $msg);
});

test('accepting writes the list (what the review screen sends)', function () {
    $item = ReviewQueue::listItems('pending', 10, 'project', 1)[0];
    // review.js puts the project with the proposed payments, then resolves.
    $current = (new Project())->getById(1);
    $data = array_intersect_key($current, array_flip(['name', 'start_date', 'description', 'company', 'budget_min', 'budget_max', 'success_chance', 'stage', 'estimated_completion']));
    $data['payments'] = Project::normalizePayments($item['payload']['payments']);
    (new Project())->update(1, $data);
    ReviewQueue::resolve((int) $item['id']);
    eq(count(mcp('projects.get', ['project_id' => 1])['project']['expected_payments']), 4, 'four after accepting');
});

test('projects.mark_payment_paid flips exactly one payment', function () {
    $r = mcp('projects.mark_payment_paid', ['project_id' => 1, 'month' => ym(-1)]);
    eq($r['status'], 'proposed', 'status');
    $paid = array_values(array_filter($r['payments'], fn($x) => $x['month'] === ym(-1)));
    eq([$paid[0]['paid'], $paid[1]['paid']], [true, true], 'both payments of that month now paid');
    eq(count(array_filter($r['payments'], fn($x) => $x['paid'])), 2, 'nothing else changed');
    mcp('reviews.withdraw', ['review_id' => $r['review_id']]);
});

test('projects.mark_payment_paid refuses what it cannot tell apart or find', function () {
    ok(str_contains(refused('projects.mark_payment_paid', ['project_id' => 1, 'month' => ym(5)]), 'no unpaid payment'), 'no payment that month');
    ok(str_contains(refused('projects.mark_payment_paid', ['project_id' => 1, 'month' => ym(1), 'amount' => 1]), 'no unpaid payment of 1'), 'wrong amount');
    ok(str_contains(refused('projects.mark_payment_paid', ['project_id' => 1]), 'month is required'), 'month required');

    Database::getInstance()->exec("UPDATE projects SET payments = '" . json_encode([
        ['month' => ym(4), 'amount' => 100, 'paid' => false], ['month' => ym(4), 'amount' => 200, 'paid' => false],
    ]) . "' WHERE id = 2");
    ok(str_contains(refused('projects.mark_payment_paid', ['project_id' => 2, 'month' => ym(4)]), 'Pass the amount'), 'ambiguous');
    $r = mcp('projects.mark_payment_paid', ['project_id' => 2, 'month' => ym(4), 'amount' => 200]);
    eq(array_column($r['payments'], 'paid'), [false, true], 'the one with that amount');
    mcp('reviews.withdraw', ['review_id' => $r['review_id']]);
});

test('projects.set_payments refuses what the project sheet would refuse', function () {
    $full = refused('projects.set_payments', ['project_id' => 2, 'payments' => [
        ['month' => ym(1), 'amount' => 100, 'full' => true], ['month' => ym(2), 'amount' => 100],
    ]]);
    ok(str_contains($full, 'payment in full is the only payment'), $full);
    ok(str_contains(refused('projects.set_payments', ['project_id' => 2, 'payments' => [['month' => ym(1), 'amount' => -5]]]), 'amount above 0'), 'negative');
    ok(str_contains(refused('projects.set_payments', ['project_id' => 2, 'payments' => 'soon']), 'must be a list'), 'not a list');
    ok(str_contains(refused('projects.set_payments', ['project_id' => 99, 'payments' => []]), 'not found'), 'unknown project');
});

test('warnings: past the end, above the budget; no_change; an empty list removes all', function () {
    $r = mcp('projects.set_payments', ['project_id' => 2, 'payments' => [
        ['month' => ym(6), 'amount' => 8000], ['month' => ym(1), 'amount' => 8000],
    ]]);
    ok(in_array(true, array_map(fn($w) => str_contains($w, 'three months after'), $r['warnings']), true), 'after the end');
    ok(in_array(true, array_map(fn($w) => str_contains($w, 'more than the budget'), $r['warnings']), true), 'above budget');
    mcp('reviews.withdraw', ['review_id' => $r['review_id']]);

    $same = Project::decodePayments(Database::getInstance()->query("SELECT payments FROM projects WHERE id = 2")->fetchColumn());
    eq(mcp('projects.set_payments', ['project_id' => 2, 'payments' => $same])['status'], 'no_change', 'no change');

    $r = mcp('projects.set_payments', ['project_id' => 2, 'payments' => []]);
    eq($r['payments'], [], 'remove all');
    mcp('reviews.withdraw', ['review_id' => $r['review_id']]);
});

test('a project that is itself still a proposal is changed directly', function () {
    $r = mcp('projects.set_payments', ['project_id' => 3, 'payments' => [['month' => ym(2), 'amount' => 1500]]]);
    eq($r['status'], 'updated_pending_record', 'status');
    eq(count(mcp('projects.get', ['project_id' => 3])['project']['expected_payments']), 1, 'written');
});

test('the review snapshot carries the payments, so a stale proposal shows', function () {
    $r = mcp('projects.set_payments', ['project_id' => 1, 'payments' => [['month' => ym(3), 'amount' => 1]]]);
    $item = ReviewQueue::listItems('pending', 10, 'project', 1)[0];
    ok(array_key_exists('payments', (array) $item['record']), 'record has payments');
    mcp('reviews.withdraw', ['review_id' => $r['review_id']]);
});

test('the first VAT quarter tracked is pinned on the first read, not moved on later', function () {
    $db = Database::getInstance();
    $db->exec("DELETE FROM app_settings WHERE key = 'fin_vat_from'");
    $from = (new Financials())->settings()['vat_from'];
    $today = new DateTimeImmutable('now', new DateTimeZone('Europe/Vienna'));
    $index = (int) $today->format('Y') * 4 + intdiv((int) $today->format('n') - 1, 3) - 1;
    eq($from, intdiv($index, 4) . '-Q' . ($index % 4 + 1), 'the quarter before today\'s');
    eq($db->query("SELECT value FROM app_settings WHERE key = 'fin_vat_from'")->fetchColumn(), $from, 'stored');
    eq((new Financials())->saveSettings(['vat_from' => '']), 'Unknown quarter', 'cannot be emptied');
});

test('meta says whether Financials are available', function () {
    eq(mcp('meta')['financials_available'], true, 'flag');
});

// =============================================================================

$failed = 0;
foreach ($results as [$name, $passed, $message]) {
    echo ($passed ? '  ok   ' : '  FAIL ') . $name . ($passed ? '' : "\n         " . $message) . "\n";
    $failed += $passed ? 0 : 1;
}
echo "\n" . (count($results) - $failed) . '/' . count($results) . " passed\n";
exit($failed ? 1 : 0);
