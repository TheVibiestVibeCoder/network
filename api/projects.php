<?php
/**
 * Projects API Endpoint
 * Handles CRUD operations for projects
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Project.php';

header('Content-Type: application/json');

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;

$projectModel = new Project();

try {
    switch ($method) {
        case 'GET':
            handleGet($projectModel, $id);
            break;

        case 'POST':
            handlePost($projectModel);
            break;

        case 'PUT':
            handlePut($projectModel, $id);
            break;

        case 'DELETE':
            handleDelete($projectModel, $id);
            break;

        default:
            http_response_code(405);
            echo json_encode(['error' => 'Method not allowed']);
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}

/**
 * Handle GET requests
 */
function handleGet(Project $model, ?int $id): void
{
    if ($id !== null) {
        $project = $model->getById($id);

        if ($project === null) {
            http_response_code(404);
            echo json_encode(['error' => 'Project not found']);
            return;
        }

        echo json_encode(['success' => true, 'data' => $project]);
        return;
    }

    $search = $_GET['search'] ?? '';
    $sortBy = $_GET['sort'] ?? 'name';
    $sortOrder = $_GET['order'] ?? 'ASC';

    $projects = $model->getAll($search, $sortBy, $sortOrder);
    echo json_encode(['success' => true, 'data' => $projects]);
}

/**
 * Handle POST requests (create)
 */
function handlePost(Project $model): void
{
    $input = json_decode(file_get_contents('php://input'), true);

    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    if (empty($input['name'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Name is required']);
        return;
    }

    $id = $model->create($input);
    $project = $model->getById($id);

    http_response_code(201);
    echo json_encode(['success' => true, 'data' => $project]);
}

/**
 * Handle PUT requests (update)
 */
function handlePut(Project $model, ?int $id): void
{
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Project ID is required']);
        return;
    }

    $existing = $model->getById($id);
    if ($existing === null) {
        http_response_code(404);
        echo json_encode(['error' => 'Project not found']);
        return;
    }

    $input = json_decode(file_get_contents('php://input'), true);

    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    if (empty($input['name'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Name is required']);
        return;
    }

    $model->update($id, $input);
    $project = $model->getById($id);

    echo json_encode(['success' => true, 'data' => $project]);
}

/**
 * Handle DELETE requests
 */
function handleDelete(Project $model, ?int $id): void
{
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Project ID is required']);
        return;
    }

    $existing = $model->getById($id);
    if ($existing === null) {
        http_response_code(404);
        echo json_encode(['error' => 'Project not found']);
        return;
    }

    $model->delete($id);

    echo json_encode(['success' => true, 'message' => 'Project deleted']);
}
