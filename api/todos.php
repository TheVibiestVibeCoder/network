<?php
/**
 * To-Dos API Endpoint
 * Handles CRUD operations for to-dos assigned to contacts or projects
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';

// Set JSON response headers and security headers
header('Content-Type: application/json');
Auth::sendSecurityHeaders();

// Check authentication
if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;

// Require CSRF token for state-changing requests
if (in_array($method, ['POST', 'PUT', 'DELETE'], true)) {
    Auth::requireCsrfToken();
}

$db = Database::getInstance();

try {
    switch ($method) {
        case 'GET':
            handleGet($db, $id);
            break;

        case 'POST':
            handlePost($db);
            break;

        case 'PUT':
            handlePut($db, $id);
            break;

        case 'DELETE':
            handleDelete($db, $id);
            break;

        default:
            http_response_code(405);
            echo json_encode(['error' => 'Method not allowed']);
            break;
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => 'An internal error occurred']);
}

/**
 * Handle GET requests.
 */
function handleGet(PDO $db, ?int $id): void
{
    if ($id !== null) {
        $todo = getTodoById($db, $id);
        if ($todo === null) {
            http_response_code(404);
            echo json_encode(['error' => 'To-do not found']);
            return;
        }

        echo json_encode(['success' => true, 'data' => $todo]);
        return;
    }

    $contactId = isset($_GET['contact_id']) ? (int) $_GET['contact_id'] : null;
    $projectId = isset($_GET['project_id']) ? (int) $_GET['project_id'] : null;
    $status = $_GET['status'] ?? 'all';
    $search = isset($_GET['search']) ? trim((string) $_GET['search']) : '';

    $conditions = [];
    $params = [];

    $hasContactFilter = $contactId !== null && $contactId > 0;
    $hasProjectFilter = $projectId !== null && $projectId > 0;

    if ($hasContactFilter && $hasProjectFilter) {
        $conditions[] = '(t.contact_id = :contact_id OR t.project_id = :project_id)';
        $params['contact_id'] = $contactId;
        $params['project_id'] = $projectId;
    } elseif ($hasContactFilter) {
        $conditions[] = 't.contact_id = :contact_id';
        $params['contact_id'] = $contactId;
    } elseif ($hasProjectFilter) {
        $conditions[] = 't.project_id = :project_id';
        $params['project_id'] = $projectId;
    }

    if ($status === 'open') {
        $conditions[] = 't.is_completed = 0';
    } elseif ($status === 'completed') {
        $conditions[] = 't.is_completed = 1';
    }

    if ($search !== '') {
        $conditions[] = '(t.title LIKE :search OR t.description LIKE :search OR c.name LIKE :search OR p.name LIKE :search)';
        $params['search'] = '%' . $search . '%';
    }

    $sql = "
        SELECT
            t.*,
            c.name AS contact_name,
            p.name AS project_name
        FROM todos t
        LEFT JOIN contacts c ON c.id = t.contact_id
        LEFT JOIN projects p ON p.id = t.project_id
    ";

    if (!empty($conditions)) {
        $sql .= ' WHERE ' . implode(' AND ', $conditions);
    }

    $sql .= "
        ORDER BY
            t.is_completed ASC,
            CASE WHEN t.due_date IS NULL OR t.due_date = '' THEN 1 ELSE 0 END ASC,
            t.due_date ASC,
            t.created_at DESC
    ";

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $todos = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode(['success' => true, 'data' => $todos]);
}

/**
 * Handle POST requests.
 */
function handlePost(PDO $db): void
{
    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    $title = Auth::sanitizeString($input['title'] ?? null, 255);
    if ($title === null || trim($title) === '') {
        http_response_code(400);
        echo json_encode(['error' => 'title is required']);
        return;
    }

    $description = Auth::sanitizeString($input['description'] ?? null, 10000);
    $dueDate = normalizeDate($input['due_date'] ?? null);
    if (($input['due_date'] ?? null) !== null && $dueDate === false) {
        http_response_code(400);
        echo json_encode(['error' => 'due_date must be in YYYY-MM-DD format']);
        return;
    }

    $contactId = parseNullableId($input['contact_id'] ?? null);
    $projectId = parseNullableId($input['project_id'] ?? null);

    if ($contactId === false || $projectId === false) {
        http_response_code(400);
        echo json_encode(['error' => 'contact_id and project_id must be positive integers or null']);
        return;
    }

    if (($contactId === null && $projectId === null) || ($contactId !== null && $projectId !== null)) {
        http_response_code(400);
        echo json_encode(['error' => 'Assign exactly one: contact_id or project_id']);
        return;
    }

    if ($contactId !== null && !recordExists($db, 'contacts', $contactId)) {
        http_response_code(404);
        echo json_encode(['error' => 'Contact not found']);
        return;
    }

    if ($projectId !== null && !recordExists($db, 'projects', $projectId)) {
        http_response_code(404);
        echo json_encode(['error' => 'Project not found']);
        return;
    }

    $stmt = $db->prepare("
        INSERT INTO todos (title, description, due_date, is_completed, contact_id, project_id)
        VALUES (:title, :description, :due_date, 0, :contact_id, :project_id)
    ");
    $stmt->execute([
        'title' => trim($title),
        'description' => ($description !== null && trim($description) === '') ? null : $description,
        'due_date' => $dueDate === false ? null : $dueDate,
        'contact_id' => $contactId,
        'project_id' => $projectId
    ]);

    $todoId = (int) $db->lastInsertId();
    $todo = getTodoById($db, $todoId);

    http_response_code(201);
    echo json_encode(['success' => true, 'data' => $todo]);
}

/**
 * Handle PUT requests.
 */
function handlePut(PDO $db, ?int $id): void
{
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'To-do ID is required']);
        return;
    }

    $existing = getTodoById($db, $id);
    if ($existing === null) {
        http_response_code(404);
        echo json_encode(['error' => 'To-do not found']);
        return;
    }

    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    $title = array_key_exists('title', $input)
        ? Auth::sanitizeString($input['title'], 255)
        : $existing['title'];
    if ($title === null || trim($title) === '') {
        http_response_code(400);
        echo json_encode(['error' => 'title cannot be empty']);
        return;
    }

    $description = array_key_exists('description', $input)
        ? Auth::sanitizeString($input['description'], 10000)
        : $existing['description'];
    if ($description !== null && trim((string) $description) === '') {
        $description = null;
    }

    $dueDateInput = array_key_exists('due_date', $input) ? $input['due_date'] : $existing['due_date'];
    $dueDate = normalizeDate($dueDateInput);
    if ($dueDate === false) {
        http_response_code(400);
        echo json_encode(['error' => 'due_date must be in YYYY-MM-DD format']);
        return;
    }

    $isCompleted = array_key_exists('is_completed', $input)
        ? (int) ((bool) $input['is_completed'])
        : (int) $existing['is_completed'];

    $contactIdInput = array_key_exists('contact_id', $input) ? $input['contact_id'] : $existing['contact_id'];
    $projectIdInput = array_key_exists('project_id', $input) ? $input['project_id'] : $existing['project_id'];
    $contactId = parseNullableId($contactIdInput);
    $projectId = parseNullableId($projectIdInput);

    if ($contactId === false || $projectId === false) {
        http_response_code(400);
        echo json_encode(['error' => 'contact_id and project_id must be positive integers or null']);
        return;
    }

    if (($contactId === null && $projectId === null) || ($contactId !== null && $projectId !== null)) {
        http_response_code(400);
        echo json_encode(['error' => 'Assign exactly one: contact_id or project_id']);
        return;
    }

    if ($contactId !== null && !recordExists($db, 'contacts', $contactId)) {
        http_response_code(404);
        echo json_encode(['error' => 'Contact not found']);
        return;
    }

    if ($projectId !== null && !recordExists($db, 'projects', $projectId)) {
        http_response_code(404);
        echo json_encode(['error' => 'Project not found']);
        return;
    }

    $stmt = $db->prepare("
        UPDATE todos
        SET
            title = :title,
            description = :description,
            due_date = :due_date,
            is_completed = :is_completed,
            contact_id = :contact_id,
            project_id = :project_id,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = :id
    ");
    $stmt->execute([
        'id' => $id,
        'title' => trim($title),
        'description' => $description,
        'due_date' => $dueDate,
        'is_completed' => $isCompleted,
        'contact_id' => $contactId,
        'project_id' => $projectId
    ]);

    $updated = getTodoById($db, $id);
    echo json_encode(['success' => true, 'data' => $updated]);
}

/**
 * Handle DELETE requests.
 */
function handleDelete(PDO $db, ?int $id): void
{
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'To-do ID is required']);
        return;
    }

    $existing = getTodoById($db, $id);
    if ($existing === null) {
        http_response_code(404);
        echo json_encode(['error' => 'To-do not found']);
        return;
    }

    $stmt = $db->prepare('DELETE FROM todos WHERE id = ?');
    $stmt->execute([$id]);

    echo json_encode(['success' => true, 'message' => 'To-do deleted']);
}

/**
 * Get a single to-do by ID with assignment names.
 */
function getTodoById(PDO $db, int $id): ?array
{
    $stmt = $db->prepare("
        SELECT
            t.*,
            c.name AS contact_name,
            p.name AS project_name
        FROM todos t
        LEFT JOIN contacts c ON c.id = t.contact_id
        LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id = :id
    ");
    $stmt->execute(['id' => $id]);
    $todo = $stmt->fetch(PDO::FETCH_ASSOC);

    return $todo ?: null;
}

/**
 * Validate date string and normalize to YYYY-MM-DD.
 * Returns false for invalid format.
 */
function normalizeDate($value)
{
    if ($value === null || $value === '') {
        return null;
    }

    if (!is_string($value)) {
        return false;
    }

    $date = trim($value);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        return false;
    }

    $dt = DateTime::createFromFormat('Y-m-d', $date);
    $errors = DateTime::getLastErrors();
    $warningCount = is_array($errors) ? (int) ($errors['warning_count'] ?? 0) : 0;
    $errorCount = is_array($errors) ? (int) ($errors['error_count'] ?? 0) : 0;
    if (!$dt || $warningCount > 0 || $errorCount > 0 || $dt->format('Y-m-d') !== $date) {
        return false;
    }

    return $date;
}

/**
 * Parse nullable positive integer IDs.
 * Returns false for invalid values.
 */
function parseNullableId($value)
{
    if ($value === null || $value === '') {
        return null;
    }

    if (is_int($value)) {
        return $value > 0 ? $value : false;
    }

    if (is_string($value) && ctype_digit($value)) {
        $parsed = (int) $value;
        return $parsed > 0 ? $parsed : false;
    }

    return false;
}

/**
 * Check if a record exists in a table by ID.
 */
function recordExists(PDO $db, string $table, int $id): bool
{
    $allowedTables = ['contacts', 'projects'];
    if (!in_array($table, $allowedTables, true)) {
        return false;
    }

    $stmt = $db->prepare("SELECT id FROM {$table} WHERE id = ? LIMIT 1");
    $stmt->execute([$id]);
    return (bool) $stmt->fetchColumn();
}
