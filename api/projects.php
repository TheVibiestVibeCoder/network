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

// Set JSON response headers and security headers
header('Content-Type: application/json');
Auth::sendSecurityHeaders();

// Check authentication
if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

// Get request method and action
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;

// Require CSRF token for state-changing requests
if (in_array($method, ['POST', 'PUT', 'DELETE'])) {
    Auth::requireCsrfToken();
}

// Initialize project model
$projectModel = new Project();

try {
    switch ($method) {
        case 'GET':
            handleGet($projectModel, $action, $id);
            break;

        case 'POST':
            handlePost($projectModel, $action);
            break;

        case 'PUT':
            handlePut($projectModel, $id);
            break;

        case 'DELETE':
            handleDelete($projectModel, $action, $id);
            break;

        default:
            http_response_code(405);
            echo json_encode(['error' => 'Method not allowed']);
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => 'An internal error occurred']);
}

/**
 * Handle GET requests
 */
function handleGet(Project $model, string $action, ?int $id): void
{
    // Get projects for a specific contact
    if ($action === 'contact' && isset($_GET['contact_id'])) {
        $contactId = (int) $_GET['contact_id'];
        $projects = $model->getByContact($contactId);
        echo json_encode(['success' => true, 'data' => $projects]);
        return;
    }

    // Get projects for a specific company
    if ($action === 'company' && isset($_GET['company'])) {
        $company = $_GET['company'];
        $projects = $model->getByCompany($company);
        echo json_encode(['success' => true, 'data' => $projects]);
        return;
    }

    // Get contacts for a project
    if ($action === 'contacts' && $id !== null) {
        $contacts = $model->getContacts($id);
        echo json_encode(['success' => true, 'data' => $contacts]);
        return;
    }

    // Get tags for a project
    if ($action === 'tags' && $id !== null) {
        $tags = $model->getTags($id);
        echo json_encode(['success' => true, 'data' => $tags]);
        return;
    }

    if ($id !== null) {
        // Get single project
        $project = $model->getById($id);

        if ($project === null) {
            http_response_code(404);
            echo json_encode(['error' => 'Project not found']);
            return;
        }

        echo json_encode(['success' => true, 'data' => $project]);
        return;
    }

    // Get all projects with optional search and sort
    $search = $_GET['search'] ?? '';
    $sortBy = $_GET['sort'] ?? 'name';
    $sortOrder = $_GET['order'] ?? 'ASC';

    $projects = $model->getAll($search, $sortBy, $sortOrder);
    echo json_encode(['success' => true, 'data' => $projects]);
}

/**
 * Handle POST requests (create, assign contact, assign tag)
 */
function handlePost(Project $model, string $action): void
{
    // Assign contact to project
    if ($action === 'assign-contact') {
        $input = json_decode(file_get_contents('php://input'), true);

        if (!isset($input['project_id']) || !isset($input['contact_id'])) {
            http_response_code(400);
            echo json_encode(['error' => 'Project ID and Contact ID are required']);
            return;
        }

        $success = $model->assignContact((int)$input['project_id'], (int)$input['contact_id']);
        echo json_encode(['success' => $success, 'message' => 'Contact assigned to project']);
        return;
    }

    // Assign tag to project
    if ($action === 'assign-tag') {
        $input = json_decode(file_get_contents('php://input'), true);

        if (!isset($input['project_id']) || !isset($input['tag_id'])) {
            http_response_code(400);
            echo json_encode(['error' => 'Project ID and Tag ID are required']);
            return;
        }

        $success = $model->assignTag((int)$input['project_id'], (int)$input['tag_id']);
        echo json_encode(['success' => $success, 'message' => 'Tag assigned to project']);
        return;
    }

    // Create new project
    $input = json_decode(file_get_contents('php://input'), true);

    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    // Sanitize input fields
    $input = Auth::sanitizeInput($input);

    // Validate required fields
    if (empty($input['name'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Name is required']);
        return;
    }

    if (empty($input['start_date'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Start date is required']);
        return;
    }

    if (empty($input['description'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Description is required']);
        return;
    }

    // Create project
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

    // Check if project exists
    $existing = $model->getById($id);
    if ($existing === null) {
        http_response_code(404);
        echo json_encode(['error' => 'Project not found']);
        return;
    }

    // Get JSON input
    $input = json_decode(file_get_contents('php://input'), true);

    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    // Sanitize input fields
    $input = Auth::sanitizeInput($input);

    // Validate required fields
    if (empty($input['name'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Name is required']);
        return;
    }

    if (empty($input['start_date'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Start date is required']);
        return;
    }

    if (empty($input['description'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Description is required']);
        return;
    }

    // Update project
    $model->update($id, $input);
    $project = $model->getById($id);

    echo json_encode(['success' => true, 'data' => $project]);
}

/**
 * Handle DELETE requests
 */
function handleDelete(Project $model, string $action, ?int $id): void
{
    // Unassign contact from project
    if ($action === 'unassign-contact') {
        $input = json_decode(file_get_contents('php://input'), true);

        if (!isset($input['project_id']) || !isset($input['contact_id'])) {
            http_response_code(400);
            echo json_encode(['error' => 'Project ID and Contact ID are required']);
            return;
        }

        $success = $model->unassignContact((int)$input['project_id'], (int)$input['contact_id']);
        echo json_encode(['success' => $success, 'message' => 'Contact unassigned from project']);
        return;
    }

    // Unassign tag from project
    if ($action === 'unassign-tag') {
        $input = json_decode(file_get_contents('php://input'), true);

        if (!isset($input['project_id']) || !isset($input['tag_id'])) {
            http_response_code(400);
            echo json_encode(['error' => 'Project ID and Tag ID are required']);
            return;
        }

        $success = $model->unassignTag((int)$input['project_id'], (int)$input['tag_id']);
        echo json_encode(['success' => $success, 'message' => 'Tag unassigned from project']);
        return;
    }

    // Delete project
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Project ID is required']);
        return;
    }

    // Check if project exists
    $existing = $model->getById($id);
    if ($existing === null) {
        http_response_code(404);
        echo json_encode(['error' => 'Project not found']);
        return;
    }

    // Delete project
    $model->delete($id);

    echo json_encode(['success' => true, 'message' => 'Project deleted']);
}
