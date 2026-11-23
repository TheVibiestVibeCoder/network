<?php
/**
 * Insights API Endpoint
 *
 * What the Insights tab needs besides the projects, the companies and our
 * invoices (those it reads where they already come from): how every
 * project's stage, chance and budget developed, and the archived projects
 * with why they were archived. Administrators only, like Financials - the
 * page shows revenue per customer.
 *
 * GET  ?action=data   { history: [...], archived: [...], reasons: { key: label } }
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Project.php';
require_once APP_ROOT . '/includes/ProjectHistory.php';

header('Content-Type: application/json');
Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}
Auth::requireAdmin();

$action = $_GET['action'] ?? '';

if ($_SERVER['REQUEST_METHOD'] !== 'GET' || $action !== 'data') {
    http_response_code(400);
    echo json_encode(['error' => 'Unknown action']);
    exit;
}

$db = Database::getInstance();
echo json_encode(['success' => true, 'data' => [
    'history' => ProjectHistory::all($db),
    'archived' => ProjectArchive::forInsights($db),
    'reasons' => ProjectArchive::REASONS,
]]);
