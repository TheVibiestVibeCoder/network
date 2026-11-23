<?php
/**
 * How a project's stage and chance developed (includes/ProjectHistory.php).
 *
 *     php tests/project-history.test.php
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
$scratch = sys_get_temp_dir() . '/crm-history-test-' . bin2hex(random_bytes(4));
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
require_once APP_ROOT . '/includes/InvoiceArchive.php';
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

$history = fn(int $id, string $field) => array_map(fn($r) => [$r['value'], $r['source']], ProjectHistory::forProject(Database::getInstance(), $id)[$field]);

test('a new project starts its history with its stage and chance', function () use ($history) {
    $id = (new Project())->create(['name' => 'A', 'description' => 'd', 'stage' => 'Lead', 'success_chance' => 20]);
    eq($history($id, 'stage'), [['Lead', 'live']], 'stage');
    eq($history($id, 'chance'), [[20, 'live']], 'chance');
});

test('a save records only what changed', function () use ($history) {
    $model = new Project();
    $id = $model->create(['name' => 'B', 'description' => 'd', 'stage' => 'Lead', 'success_chance' => 20]);
    $model->update($id, ['name' => 'B2', 'description' => 'd', 'stage' => 'Lead', 'success_chance' => 20]);
    $model->update($id, ['name' => 'B2', 'description' => 'd', 'stage' => 'Proposal', 'success_chance' => '45']);
    $model->update($id, ['name' => 'B2', 'description' => 'd', 'stage' => 'Proposal', 'success_chance' => 45]);
    eq(array_column($history($id, 'stage'), 0), ['Lead', 'Proposal'], 'stage');
    eq(array_column($history($id, 'chance'), 0), [20, 45], 'chance');
});

test('an archived project comes back with its history', function () use ($history) {
    $db = Database::getInstance();
    $model = new Project();
    $id = $model->create(['name' => 'C', 'description' => 'd', 'stage' => 'Lead', 'success_chance' => 10]);
    $model->update($id, ['name' => 'C', 'description' => 'd', 'stage' => 'Negotiation', 'success_chance' => 60]);
    $model->delete($id);
    ProjectArchive::restore($db, (int) col("SELECT id FROM deleted_projects WHERE project_id = ?", [$id]));
    eq(array_column($history($id, 'stage'), 0), ['Lead', 'Negotiation'], 'kept');
});

test('the history before it existed is rebuilt from proposals and the activity log', function () use ($history) {
    $db = Database::getInstance();
    $db->exec("INSERT INTO projects (id, name, start_date, description, stage, success_chance, created_at, updated_at)
               VALUES (500, 'Old', '2026-09-01', 'd', 'Negotiation', 80, '2026-09-01 08:00:00', '2026-11-10 09:00:00')");
    $db->exec("INSERT INTO projects (id, name, start_date, description, stage, success_chance, created_at)
               VALUES (501, 'Quiet', '2026-09-01', 'd', 'Lead', 30, '2026-09-01 08:00:00')");
    $add = $db->prepare("INSERT INTO review_items (kind, entity_type, entity_id, entity_label, payload, previous, status, created_at, resolved_at, resolved_by_name)
                         VALUES (:k, 'project', 500, 'Old', :p, :pr, :s, :c, :r, 'Livio')");
    $add->execute(['k' => 'update', 'p' => '{"stage":"Proposal","success_chance":45}', 'pr' => '{"stage":"Lead","success_chance":30}', 's' => 'accepted', 'c' => '2026-10-01 10:00:00', 'r' => '2026-10-01 11:00:00']);
    $add->execute(['k' => 'update', 'p' => '{"success_chance":60}', 'pr' => '{"success_chance":45}', 's' => 'accepted', 'c' => '2026-10-10 10:00:00', 'r' => '2026-10-11 09:00:00']);
    $add->execute(['k' => 'update', 'p' => '{"stage":"Lead"}', 'pr' => '{"stage":"Proposal"}', 's' => 'rejected', 'c' => '2026-10-12 10:00:00', 'r' => '2026-10-12 11:00:00']);
    $db->exec("INSERT INTO activity_events (entry_type, action, content, project_id, created_at)
               VALUES ('project_activity', 'updated', 'Projekt aktualisiert: Phase, Erfolgschance', 500, '2026-11-02 14:00:00')");
    $db->exec("DELETE FROM app_settings WHERE key = 'project_history_backfilled'");
    ProjectHistory::backfill($db);

    $at = fn(int $id, string $field) => array_map(fn($r) => [$r['value'], $r['at']], ProjectHistory::forProject($db, $id)[$field]);
    eq($at(500, 'stage'), [['Lead', '2026-09-01 08:00:00'], ['Proposal', '2026-10-01 11:00:00'], ['Negotiation', '2026-11-02 14:00:00']], 'stage');
    eq($at(500, 'chance'), [[30, '2026-09-01 08:00:00'], [45, '2026-10-01 11:00:00'], [60, '2026-10-11 09:00:00'], [80, '2026-11-02 14:00:00']], 'chance');
    eq($history(500, 'stage')[0][1], 'reconstructed', 'marked');
    eq($at(501, 'stage'), [['Lead', '2026-09-01 08:00:00']], 'never changed: as it is, since its start');
    ok(count($history(1, 'stage')) === 1, 'a project with a live history is left alone');
    ProjectHistory::backfill($db);
    eq(count($at(500, 'chance')), 4, 'runs once');
});

test('budget and planned end are recorded too, as whole numbers', function () {
    $db = Database::getInstance();
    $model = new Project();
    $id = $model->create(['name' => 'D', 'description' => 'd', 'budget_min' => 5000, 'budget_max' => '8000.00', 'estimated_completion' => '2027-01-31']);
    $model->update($id, ['name' => 'D', 'description' => 'd', 'budget_min' => '5000.00', 'budget_max' => 8000, 'estimated_completion' => '2027-01-31']);
    $model->update($id, ['name' => 'D', 'description' => 'd', 'budget_min' => 4000, 'budget_max' => 8000, 'estimated_completion' => '2027-03-31']);
    $rows = fn($field) => array_column(array_values(array_filter(ProjectHistory::all($db),
        fn($r) => $r['project_id'] === $id && $r['field'] === $field)), 'value');
    eq($rows('budget_min'), ['5000', '4000'], 'budget_min');
    eq($rows('budget_max'), ['8000'], 'budget_max unchanged');
    eq($rows('end'), ['2027-01-31', '2027-03-31'], 'end');
    eq(array_keys(ProjectHistory::forProject($db, $id)), ['created_at', 'stage', 'chance'], 'the sheet still reads stage and chance only');
});

test('projects from before get their budget once as a starting point', function () {
    $db = Database::getInstance();
    $db->exec("INSERT INTO projects (id, name, start_date, description, budget_min, budget_max) VALUES (600, 'Older', '2026-01-01', 'd', 2500, 2500)");
    $db->exec("DELETE FROM app_settings WHERE key = 'project_history_budget_seeded'");
    ProjectHistory::seedLaterFields($db);
    ProjectHistory::seedLaterFields($db);
    eq((int) col("SELECT COUNT(*) FROM project_history WHERE project_id = 600 AND field = 'budget_min'"), 1, 'once');
    eq(col("SELECT value FROM project_history WHERE project_id = 600 AND field = 'budget_max'"), '2500', 'value');
});

test('an archived project keeps why it was archived', function () {
    $db = Database::getInstance();
    $model = new Project();
    $won = $model->create(['name' => 'E', 'description' => 'd', 'stage' => 'Complete', 'success_chance' => 100, 'product' => 'Workshop', 'budget_min' => 2500]);
    $lost = $model->create(['name' => 'F', 'description' => 'd', 'stage' => 'Proposal', 'success_chance' => 60]);
    $odd = $model->create(['name' => 'G', 'description' => 'd']);
    $model->delete($won, 'done');
    $model->delete($lost, 'nonsense');
    $model->delete($odd);
    $entry = fn($id) => array_values(array_filter(ProjectArchive::forInsights($db), fn($e) => $e['project_id'] === $id))[0];
    eq($entry($won)['reason'], 'done', 'given');
    eq($entry($lost)['reason'], null, 'an unknown reason is none');
    eq($entry($won)['project']['product'], 'Workshop', 'the project as it was');
    eq(array_column($entry($lost)['history'], 'value', 'field')['chance'], '60', 'its history');
    ProjectArchive::setReason($db, $entry($lost)['id'], 'went_elsewhere');
    eq($entry($lost)['reason'], 'went_elsewhere', 'said later');
    ProjectArchive::setReason($db, $entry($lost)['id'], null);
    eq($entry($lost)['reason'], null, 'cleared');
    $listed = array_values(array_filter(ProjectArchive::list($db), fn($e) => $e['project_id'] === $won))[0];
    eq($listed['reason'], 'done', 'the archive list shows it');
});

// =============================================================================

$failed = 0;
foreach ($results as [$name, $passed, $message]) {
    echo ($passed ? '  ok   ' : '  FAIL ') . $name . ($passed ? '' : "\n         " . $message) . "\n";
    $failed += $passed ? 0 : 1;
}
echo "\n" . (count($results) - $failed) . '/' . count($results) . " passed\n";
exit($failed ? 1 : 0);
