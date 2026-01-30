<?php
/**
 * Notes API Endpoint
 * Handles CRUD operations for notes (timeline entries)
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
$contactId = isset($_GET['contact_id']) ? (int) $_GET['contact_id'] : null;
$company = $_GET['company'] ?? null;
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;

// Require CSRF token for state-changing requests
if (in_array($method, ['POST', 'DELETE'])) {
    Auth::requireCsrfToken();
}

$db = Database::getInstance();

try {
    switch ($method) {
        case 'GET':
            handleGet($db, $contactId, $company);
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
    echo json_encode(['error' => 'An internal error occurred']);
}

/**
 * Handle GET requests - get notes for a contact or company
 */
function handleGet(PDO $db, ?int $contactId, ?string $company): void
{
    if ($contactId === null && $company === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Either contact_id or company is required']);
        return;
    }

    $notes = [];

    if ($contactId !== null) {
        // Get notes for specific contact
        $stmt = $db->prepare("
            SELECT n.*, 'contact' as source
            FROM notes n
            WHERE n.contact_id = ?
            ORDER BY n.created_at DESC
        ");
        $stmt->execute([$contactId]);
        $contactNotes = $stmt->fetchAll();

        // Also get company notes if this contact has a company
        $companyStmt = $db->prepare("SELECT company FROM contacts WHERE id = ?");
        $companyStmt->execute([$contactId]);
        $contact = $companyStmt->fetch();

        if ($contact && !empty($contact['company'])) {
            // Get notes from other contacts in the same company
            $companyNotesStmt = $db->prepare("
                SELECT n.*, c.name as contact_name, 'company' as source
                FROM notes n
                JOIN contacts c ON n.contact_id = c.id
                WHERE n.company = ? AND n.contact_id != ?
                ORDER BY n.created_at DESC
            ");
            $companyNotesStmt->execute([$contact['company'], $contactId]);
            $companyNotes = $companyNotesStmt->fetchAll();

            // Merge and sort all notes by created_at
            $notes = array_merge($contactNotes, $companyNotes);
            usort($notes, function($a, $b) {
                return strtotime($b['created_at']) - strtotime($a['created_at']);
            });
        } else {
            $notes = $contactNotes;
        }
    } elseif ($company !== null) {
        // Get all notes for a company
        $stmt = $db->prepare("
            SELECT n.*, c.name as contact_name
            FROM notes n
            JOIN contacts c ON n.contact_id = c.id
            WHERE n.company = ?
            ORDER BY n.created_at DESC
        ");
        $stmt->execute([$company]);
        $notes = $stmt->fetchAll();
    }

    echo json_encode(['success' => true, 'data' => $notes]);
}

/**
 * Handle POST requests - create a new note
 */
function handlePost(PDO $db): void
{
    $input = json_decode(file_get_contents('php://input'), true);

    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    // Validate required fields
    if (empty($input['contact_id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'contact_id is required']);
        return;
    }

    $input['content'] = Auth::sanitizeString($input['content'] ?? null, 10000);
    if (empty($input['content'])) {
        http_response_code(400);
        echo json_encode(['error' => 'content is required']);
        return;
    }

    // Get contact's company for linking
    $contactStmt = $db->prepare("SELECT company FROM contacts WHERE id = ?");
    $contactStmt->execute([$input['contact_id']]);
    $contact = $contactStmt->fetch();

    if (!$contact) {
        http_response_code(404);
        echo json_encode(['error' => 'Contact not found']);
        return;
    }

    // Insert note
    $stmt = $db->prepare("
        INSERT INTO notes (contact_id, company, content)
        VALUES (?, ?, ?)
    ");
    $stmt->execute([
        $input['contact_id'],
        $contact['company'] ?? null,
        $input['content']
    ]);

    $noteId = $db->lastInsertId();

    // Fetch the created note
    $noteStmt = $db->prepare("SELECT * FROM notes WHERE id = ?");
    $noteStmt->execute([$noteId]);
    $note = $noteStmt->fetch();

    http_response_code(201);
    echo json_encode(['success' => true, 'data' => $note]);
}

/**
 * Handle DELETE requests - delete a note
 */
function handleDelete(PDO $db, ?int $id): void
{
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Note ID is required']);
        return;
    }

    // Check if note exists
    $checkStmt = $db->prepare("SELECT id FROM notes WHERE id = ?");
    $checkStmt->execute([$id]);
    if (!$checkStmt->fetch()) {
        http_response_code(404);
        echo json_encode(['error' => 'Note not found']);
        return;
    }

    // Delete note
    $stmt = $db->prepare("DELETE FROM notes WHERE id = ?");
    $stmt->execute([$id]);

    echo json_encode(['success' => true, 'message' => 'Note deleted']);
}
