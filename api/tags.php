<?php
/**
 * Tags API Endpoint
 * Handles CRUD operations for tags and contact-tag relationships
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

// Get request method and parameters
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;
$contactId = isset($_GET['contact_id']) ? (int) $_GET['contact_id'] : null;

// Require CSRF token for state-changing requests
if (in_array($method, ['POST', 'PUT', 'DELETE'])) {
    Auth::requireCsrfToken();
}

$db = Database::getInstance();

try {
    switch ($method) {
        case 'GET':
            handleGet($db, $action, $id, $contactId);
            break;

        case 'POST':
            handlePost($db, $action);
            break;

        case 'PUT':
            handlePut($db, $id);
            break;

        case 'DELETE':
            handleDelete($db, $action, $id, $contactId);
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
function handleGet(PDO $db, string $action, ?int $id, ?int $contactId): void
{
    if ($action === 'contact' && $contactId !== null) {
        // Get tags for a specific contact
        $stmt = $db->prepare("
            SELECT t.*
            FROM tags t
            JOIN contact_tags ct ON t.id = ct.tag_id
            WHERE ct.contact_id = ?
            ORDER BY t.name ASC
        ");
        $stmt->execute([$contactId]);
        $tags = $stmt->fetchAll();
        echo json_encode(['success' => true, 'data' => $tags]);
        return;
    }

    if ($action === 'contacts' && $id !== null) {
        // Get all contacts with a specific tag
        $stmt = $db->prepare("
            SELECT c.*
            FROM contacts c
            JOIN contact_tags ct ON c.id = ct.contact_id
            WHERE ct.tag_id = ?
            ORDER BY c.name ASC
        ");
        $stmt->execute([$id]);
        $contacts = $stmt->fetchAll();
        echo json_encode(['success' => true, 'data' => $contacts]);
        return;
    }

    if ($action === 'grouped') {
        // Get all tags with their contact counts for list view grouping
        $stmt = $db->query("
            SELECT t.*, COUNT(ct.contact_id) as contact_count
            FROM tags t
            LEFT JOIN contact_tags ct ON t.id = ct.tag_id
            GROUP BY t.id
            ORDER BY t.name ASC
        ");
        $tags = $stmt->fetchAll();

        // Get contacts for each tag
        $result = [];
        foreach ($tags as $tag) {
            $contactStmt = $db->prepare("
                SELECT c.*
                FROM contacts c
                JOIN contact_tags ct ON c.id = ct.contact_id
                WHERE ct.tag_id = ?
                ORDER BY c.name ASC
            ");
            $contactStmt->execute([$tag['id']]);
            $tag['contacts'] = $contactStmt->fetchAll();
            $result[] = $tag;
        }

        // Get untagged contacts
        $untaggedStmt = $db->query("
            SELECT c.*
            FROM contacts c
            WHERE c.id NOT IN (SELECT contact_id FROM contact_tags)
            ORDER BY c.name ASC
        ");
        $untaggedContacts = $untaggedStmt->fetchAll();

        echo json_encode([
            'success' => true,
            'data' => [
                'tags' => $result,
                'untagged' => $untaggedContacts
            ]
        ]);
        return;
    }

    // Get all tags
    $stmt = $db->query("SELECT * FROM tags ORDER BY name ASC");
    $tags = $stmt->fetchAll();
    echo json_encode(['success' => true, 'data' => $tags]);
}

/**
 * Handle POST requests
 */
function handlePost(PDO $db, string $action): void
{
    $input = json_decode(file_get_contents('php://input'), true);

    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    if ($action === 'assign') {
        // Assign a tag to a contact
        if (empty($input['contact_id']) || empty($input['tag_id'])) {
            http_response_code(400);
            echo json_encode(['error' => 'contact_id and tag_id are required']);
            return;
        }

        // Check if already assigned
        $checkStmt = $db->prepare("SELECT 1 FROM contact_tags WHERE contact_id = ? AND tag_id = ?");
        $checkStmt->execute([$input['contact_id'], $input['tag_id']]);
        if ($checkStmt->fetch()) {
            echo json_encode(['success' => true, 'message' => 'Tag already assigned']);
            return;
        }

        $stmt = $db->prepare("INSERT INTO contact_tags (contact_id, tag_id) VALUES (?, ?)");
        $stmt->execute([$input['contact_id'], $input['tag_id']]);

        echo json_encode(['success' => true, 'message' => 'Tag assigned']);
        return;
    }

    // Create a new tag
    if (empty($input['name'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Tag name is required']);
        return;
    }

    $name = Auth::sanitizeString($input['name'], 100);
    $color = Auth::sanitizeString($input['color'] ?? '#3b82f6', 7);

    // Validate color format (hex color)
    if (!preg_match('/^#[0-9a-fA-F]{6}$/', $color)) {
        $color = '#3b82f6';
    }

    // Check if tag already exists
    $checkStmt = $db->prepare("SELECT * FROM tags WHERE LOWER(name) = LOWER(?)");
    $checkStmt->execute([$name]);
    $existing = $checkStmt->fetch();

    if ($existing) {
        // Return existing tag
        echo json_encode(['success' => true, 'data' => $existing, 'existing' => true]);
        return;
    }

    // Create new tag
    $stmt = $db->prepare("INSERT INTO tags (name, color) VALUES (?, ?)");
    $stmt->execute([$name, $color]);
    $tagId = $db->lastInsertId();

    $newTag = $db->prepare("SELECT * FROM tags WHERE id = ?");
    $newTag->execute([$tagId]);
    $tag = $newTag->fetch();

    http_response_code(201);
    echo json_encode(['success' => true, 'data' => $tag]);
}

/**
 * Handle PUT requests - update a tag
 */
function handlePut(PDO $db, ?int $id): void
{
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Tag ID is required']);
        return;
    }

    $input = json_decode(file_get_contents('php://input'), true);
    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    // Check tag exists
    $checkStmt = $db->prepare("SELECT * FROM tags WHERE id = ?");
    $checkStmt->execute([$id]);
    $existing = $checkStmt->fetch();

    if (!$existing) {
        http_response_code(404);
        echo json_encode(['error' => 'Tag not found']);
        return;
    }

    $name = Auth::sanitizeString($input['name'] ?? $existing['name'], 100);
    $color = Auth::sanitizeString($input['color'] ?? $existing['color'], 7);

    if (empty($name)) {
        http_response_code(400);
        echo json_encode(['error' => 'Tag name is required']);
        return;
    }

    // Validate color format
    if (!preg_match('/^#[0-9a-fA-F]{6}$/', $color)) {
        $color = $existing['color'];
    }

    // Check for name conflict with another tag
    $conflictStmt = $db->prepare("SELECT id FROM tags WHERE LOWER(name) = LOWER(?) AND id != ?");
    $conflictStmt->execute([$name, $id]);
    if ($conflictStmt->fetch()) {
        http_response_code(409);
        echo json_encode(['error' => 'A tag with this name already exists']);
        return;
    }

    $stmt = $db->prepare("UPDATE tags SET name = ?, color = ? WHERE id = ?");
    $stmt->execute([$name, $color, $id]);

    $updatedStmt = $db->prepare("SELECT * FROM tags WHERE id = ?");
    $updatedStmt->execute([$id]);
    $tag = $updatedStmt->fetch();

    echo json_encode(['success' => true, 'data' => $tag]);
}

/**
 * Handle DELETE requests
 */
function handleDelete(PDO $db, string $action, ?int $id, ?int $contactId): void
{
    if ($action === 'unassign') {
        // Remove a tag from a contact
        $input = json_decode(file_get_contents('php://input'), true);
        $tagId = $input['tag_id'] ?? $id;
        $cId = $input['contact_id'] ?? $contactId;

        if (empty($cId) || empty($tagId)) {
            http_response_code(400);
            echo json_encode(['error' => 'contact_id and tag_id are required']);
            return;
        }

        $stmt = $db->prepare("DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?");
        $stmt->execute([$cId, $tagId]);

        echo json_encode(['success' => true, 'message' => 'Tag removed from contact']);
        return;
    }

    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Tag ID is required']);
        return;
    }

    // Delete tag entirely
    $stmt = $db->prepare("DELETE FROM tags WHERE id = ?");
    $stmt->execute([$id]);

    echo json_encode(['success' => true, 'message' => 'Tag deleted']);
}
