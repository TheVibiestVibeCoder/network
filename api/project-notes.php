<?php
/**
 * Project Notes API Endpoint
 * Handles CRUD operations for project timeline notes
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';

header('Content-Type: application/json');

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$projectId = isset($_GET['project_id']) ? (int) $_GET['project_id'] : null;
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;

$db = Database::getInstance();

try {
    switch ($method) {
        case 'GET':
            handleGet($db, $projectId);
            break;

        case 'POST':
            handlePost($db);
            break;

        case 'DELETE':
            handleDelete($db, $id);
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
 * Handle GET requests - get notes for a project
 */
function handleGet(PDO $db, ?int $projectId): void
{
    if ($projectId === null) {
        http_response_code(400);
        echo json_encode(['error' => 'project_id is required']);
        return;
    }

    $stmt = $db->prepare('
        SELECT *
        FROM project_notes
        WHERE project_id = ?
        ORDER BY created_at DESC
    ');
    $stmt->execute([$projectId]);

    echo json_encode(['success' => true, 'data' => $stmt->fetchAll()]);
}

/**
 * Handle POST requests - create a project note
 */
function handlePost(PDO $db): void
{
    $input = json_decode(file_get_contents('php://input'), true);

    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    if (empty($input['project_id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'project_id is required']);
        return;
    }

    if (empty($input['content'])) {
        http_response_code(400);
        echo json_encode(['error' => 'content is required']);
        return;
    }

    $projectStmt = $db->prepare('SELECT id FROM projects WHERE id = ?');
    $projectStmt->execute([(int) $input['project_id']]);
    if (!$projectStmt->fetch()) {
        http_response_code(404);
        echo json_encode(['error' => 'Project not found']);
        return;
    }

    $stmt = $db->prepare('
        INSERT INTO project_notes (project_id, content)
        VALUES (?, ?)
    ');
    $stmt->execute([
        (int) $input['project_id'],
        $input['content']
    ]);

    $noteId = $db->lastInsertId();

    $noteStmt = $db->prepare('SELECT * FROM project_notes WHERE id = ?');
    $noteStmt->execute([$noteId]);

    http_response_code(201);
    echo json_encode(['success' => true, 'data' => $noteStmt->fetch()]);
}

/**
 * Handle DELETE requests - delete a project note
 */
function handleDelete(PDO $db, ?int $id): void
{
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Note ID is required']);
        return;
    }

    $checkStmt = $db->prepare('SELECT id FROM project_notes WHERE id = ?');
    $checkStmt->execute([$id]);
    if (!$checkStmt->fetch()) {
        http_response_code(404);
        echo json_encode(['error' => 'Note not found']);
        return;
    }

    $stmt = $db->prepare('DELETE FROM project_notes WHERE id = ?');
    $stmt->execute([$id]);

    echo json_encode(['success' => true, 'message' => 'Note deleted']);
}
