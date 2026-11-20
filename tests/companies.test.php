<?php
/**
 * Companies as records (includes/Company.php) and the product per project.
 *
 *     php tests/companies.test.php
 *
 * Runs against a scratch SQLite database: the one-off migration from the
 * company names, contacts and projects keeping their links and text in step,
 * renaming, merging, look-alikes, products and the project archive.
 * Never touches data/crm.db.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

define('APP_ROOT', dirname(__DIR__));
$scratch = sys_get_temp_dir() . '/crm-companies-test-' . bin2hex(random_bytes(4));
mkdir($scratch, 0700);
define('DATA_DIR', $scratch);
define('DB_PATH', $scratch . '/crm.db');

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Contact.php';
require_once APP_ROOT . '/includes/Project.php';
require_once APP_ROOT . '/includes/Company.php';
require_once APP_ROOT . '/includes/ReviewQueue.php';
require_once APP_ROOT . '/includes/McpService.php';

register_shutdown_function(static function () use ($scratch): void {
    foreach (glob($scratch . '/*') ?: [] as $file) {
        @unlink($file);
    }
    @rmdir($scratch);
});

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
function ok($condition, string $label): void
{
    if (!$condition) {
        throw new RuntimeException($label);
    }
}
function col(string $sql, array $params = [])
{
    $stmt = Database::getInstance()->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchColumn();
}
function project(array $extra = []): int
{
    return (new Project())->create($extra + ['name' => 'P', 'description' => 'd', 'start_date' => '2026-01-01']);
}

$db = Database::getInstance();
Auth::actAs(null, 'Test');

// The migration ran on an empty database; run it again over names as they
// were before companies existed.
$db->exec("INSERT INTO contacts (id, name, company) VALUES (1, 'Anna', 'ACME GmbH'), (2, 'Ben', ' acme  gmbh '), (3, 'Cleo', 'Beta AG'), (4, 'Dan', '')");
$db->exec("INSERT INTO projects (id, name, start_date, description, company) VALUES (1, 'Old', '2025-01-01', 'd', 'ACME GmbH'), (2, 'None', '2025-01-01', 'd', NULL)");
$db->exec("INSERT INTO notes (contact_id, company, content) VALUES (1, 'ACME GmbH', 'hello')");
$db->exec("DELETE FROM app_settings WHERE key = 'companies_migrated'");
$migrate = new ReflectionMethod('Database', 'initializeCompanySchema');
$migrate->invoke(null, $db);

test('the migration makes one company per name, case and spaces aside', function () {
    eq((int) col("SELECT COUNT(*) FROM companies"), 2, 'companies');
    $acme = (int) col("SELECT id FROM companies WHERE name = 'acme gmbh'");
    eq((int) col("SELECT company_id FROM contacts WHERE id = 1"), $acme, 'Anna');
    eq((int) col("SELECT company_id FROM contacts WHERE id = 2"), $acme, 'Ben');
    eq(col("SELECT company_id FROM contacts WHERE id = 4"), null, 'Dan has none');
    eq((int) col("SELECT company_id FROM project_companies WHERE project_id = 1"), $acme, 'project linked');
    eq((int) col("SELECT COUNT(*) FROM project_companies WHERE project_id = 2"), 0, 'project without');
});

test('the migration runs once', function () use ($migrate, $db) {
    $db->exec("INSERT INTO contacts (name, company) VALUES ('Eve', 'Gamma')");
    $db->exec("UPDATE contacts SET company_id = NULL WHERE name = 'Eve'");
    $migrate->invoke(null, $db);
    eq(col("SELECT id FROM companies WHERE name = 'Gamma'"), false, 'not created again');
});

test('a contact saved with a company name is linked, created if new', function () {
    $model = new Contact();
    $id = $model->create(['name' => 'Fay', 'company' => 'delta  ltd']);
    $companyId = (int) col("SELECT company_id FROM contacts WHERE id = ?", [$id]);
    eq(col("SELECT name FROM companies WHERE id = ?", [$companyId]), 'delta ltd', 'created');
    $model->update($id, ['name' => 'Fay', 'company' => 'Beta ag']);
    eq(col("SELECT company FROM contacts WHERE id = ?", [$id]), 'Beta AG', 'the company\'s spelling');
    $model->update($id, ['name' => 'Fay', 'company' => '']);
    eq(col("SELECT company_id FROM contacts WHERE id = ?", [$id]), null, 'unlinked');
});

test('a project takes several companies, its text follows them', function () {
    $a = Company::findOrCreate(Database::getInstance(), 'Alpha');
    $b = Company::findOrCreate(Database::getInstance(), 'Bravo');
    $id = project(['company_ids' => [$b, $a, $b]]);
    eq(col("SELECT company FROM projects WHERE id = ?", [$id]), 'Bravo, Alpha', 'text in order');
    eq(array_column((new Project())->getById($id)['companies'], 'name'), ['Bravo', 'Alpha'], 'getById');
});

test('an update with the same company text keeps every company', function () {
    $a = Company::findOrCreate(Database::getInstance(), 'Alpha');
    $b = Company::findOrCreate(Database::getInstance(), 'Bravo');
    $id = project(['company_ids' => [$a, $b]]);
    (new Project())->update($id, ['name' => 'P', 'description' => 'd', 'company' => 'Alpha, Bravo']);
    eq((int) col("SELECT COUNT(*) FROM project_companies WHERE project_id = ?", [$id]), 2, 'both kept');
    (new Project())->update($id, ['name' => 'P', 'description' => 'd', 'company' => 'Charlie']);
    eq(array_column(Company::projectCompanies(Database::getInstance(), $id), 'name'), ['Charlie'], 'another name: that one');
    (new Project())->update($id, ['name' => 'P', 'description' => 'd', 'company' => null]);
    eq(col("SELECT company FROM projects WHERE id = ?", [$id]), null, 'none');
});

test('renaming writes the new name into contacts, projects and notes', function () {
    $db = Database::getInstance();
    $acme = (int) col("SELECT id FROM companies WHERE name = 'acme gmbh'");
    Company::update($db, $acme, ['name' => 'ACME Group', 'website' => 'acme.example']);
    eq(col("SELECT company FROM contacts WHERE id = 2"), 'ACME Group', 'contact');
    eq(col("SELECT company FROM projects WHERE id = 1"), 'ACME Group', 'project');
    eq(col("SELECT company FROM notes WHERE contact_id = 1"), 'ACME Group', 'note');
    eq(col("SELECT website FROM companies WHERE id = ?", [$acme]), 'acme.example', 'details');
});

test('a name already taken is refused', function () {
    $db = Database::getInstance();
    $acme = (int) col("SELECT id FROM companies WHERE name = 'ACME Group'");
    try {
        Company::update($db, $acme, ['name' => 'beta ag']);
    } catch (InvalidArgumentException $e) {
        return;
    }
    throw new RuntimeException('not refused');
});

test('look-alikes are listed until kept apart', function () {
    $db = Database::getInstance();
    $x = Company::findOrCreate($db, 'Muster Consulting GmbH');
    $y = Company::findOrCreate($db, 'Muster Consulting');
    $z = Company::findOrCreate($db, 'Musterr Consulting');
    $pairs = array_map(fn($p) => [$p['a']['id'], $p['b']['id']], Company::similar($db));
    ok(in_array([$x, $y], $pairs, true) || in_array([$y, $x], $pairs, true), 'legal form aside');
    ok(count(array_filter($pairs, fn($p) => in_array($z, $p, true))) >= 1, 'a typo apart');
    Company::dismissPair($db, $y, $x);
    $pairs = array_map(fn($p) => [$p['a']['id'], $p['b']['id']], Company::similar($db));
    ok(!in_array([$x, $y], $pairs, true) && !in_array([$y, $x], $pairs, true), 'kept apart');
});

test('merging moves contacts, projects and notes over', function () {
    $db = Database::getInstance();
    $beta = (int) col("SELECT id FROM companies WHERE name = 'Beta AG'");
    $acme = (int) col("SELECT id FROM companies WHERE name = 'ACME Group'");
    $p = project(['company_ids' => [$beta, $acme]]);
    Company::merge($db, $beta, $acme);
    eq(col("SELECT id FROM companies WHERE id = ?", [$beta]), false, 'gone');
    eq((int) col("SELECT company_id FROM contacts WHERE id = 3"), $acme, 'contact moved');
    eq(col("SELECT company FROM contacts WHERE id = 3"), 'ACME Group', 'contact text');
    eq(array_column(Company::projectCompanies($db, $p), 'name'), ['ACME Group'], 'one link, not two');
});

test('the company page has contacts and projects', function () {
    $db = Database::getInstance();
    $acme = (int) col("SELECT id FROM companies WHERE name = 'ACME Group'");
    $detail = Company::detail($db, $acme);
    ok(count($detail['contacts']) >= 3, 'contacts');
    ok(in_array('Old', array_column($detail['projects'], 'name'), true), 'projects');
});

test('a product is one of five, anything else is none', function () {
    eq(Project::cleanProduct('rb & shield'), 'RB & SHIELD', 'any case');
    eq(Project::cleanProduct('Webinar'), null, 'unknown');
    $id = project(['product' => 'Workshop']);
    eq(col("SELECT product FROM projects WHERE id = ?", [$id]), 'Workshop', 'stored');
    (new Project())->update($id, ['name' => 'P', 'description' => 'd']);
    eq(col("SELECT product FROM projects WHERE id = ?", [$id]), 'Workshop', 'an update without it keeps it');
    (new Project())->update($id, ['name' => 'P', 'description' => 'd', 'product' => null]);
    eq(col("SELECT product FROM projects WHERE id = ?", [$id]), null, 'cleared');
});

test('sorting by product: their order, none last either way', function () {
    $db = Database::getInstance();
    $db->exec("DELETE FROM projects");
    project(['name' => 'n', 'product' => null]);
    project(['name' => 's', 'product' => 'SHIELD']);
    project(['name' => 'w', 'product' => 'Workshop']);
    eq(array_column((new Project())->getAll('', 'product', 'ASC'), 'name'), ['w', 's', 'n'], 'asc');
    eq(array_column((new Project())->getAll('', 'product', 'DESC'), 'name'), ['s', 'w', 'n'], 'desc');
});

test('an archived project comes back with its companies', function () {
    $db = Database::getInstance();
    $acme = (int) col("SELECT id FROM companies WHERE name = 'ACME Group'");
    $id = project(['name' => 'Archived', 'company_ids' => [$acme]]);
    (new Project())->delete($id);
    eq((int) col("SELECT COUNT(*) FROM project_companies WHERE project_id = ?", [$id]), 0, 'links gone with it');
    $archiveId = (int) col("SELECT id FROM deleted_projects WHERE project_id = ?", [$id]);
    ProjectArchive::restore($db, $archiveId);
    eq(array_column(Company::projectCompanies($db, $id), 'id'), [$acme], 'back');
});

test('the connector lists and reads companies from their records', function () {
    $svc = new McpService();
    $list = $svc->handle('companies.list', ['query' => 'ACME']);
    eq($list['companies'][0]['company'], 'ACME Group', 'listed');
    $got = $svc->handle('companies.get', ['name' => 'acme group']);
    eq($got['found'], true, 'found');
    ok(count($got['contacts']) >= 3, 'contacts');
    eq($svc->handle('companies.get', ['name' => 'ACME'])['found'], false, 'near miss');
});

test('the connector proposes a project with several companies and a product', function () {
    $svc = new McpService();
    $r = $svc->handle('projects.create', ['name' => 'Briefing', 'description' => 'd', 'companies' => ['ACME Group', 'Zulu AG'], 'product' => 'risk briefing']);
    $id = (int) $r['project_id'];
    eq(array_column(Company::projectCompanies(Database::getInstance(), $id), 'name'), ['ACME Group', 'Zulu AG'], 'companies');
    eq(col("SELECT product FROM projects WHERE id = ?", [$id]), 'Risk Briefing', 'product');
    eq($svc->handle('projects.get', ['project_id' => $id])['project']['product'], 'Risk Briefing', 'read back');
    eq(in_array('SHIELD', $svc->handle('meta', [])['project_products'], true), true, 'meta');
});

// =============================================================================

$failed = 0;
foreach ($results as [$name, $passed, $message]) {
    echo ($passed ? '  ok   ' : '  FAIL ') . $name . ($passed ? '' : "\n         " . $message) . "\n";
    $failed += $passed ? 0 : 1;
}
echo "\n" . (count($results) - $failed) . '/' . count($results) . " passed\n";
exit($failed ? 1 : 0);
