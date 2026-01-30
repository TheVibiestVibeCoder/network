<?php
/**
 * Calendar API Endpoint
 * Returns notes with contact/company/tag information for calendar display
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';

header('Content-Type: application/json');
Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method !== 'GET') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

$db = Database::getInstance();

try {
    $start = $_GET['start'] ?? null;
    $end = $_GET['end'] ?? null;
    $tagId = isset($_GET['tag_id']) ? (int) $_GET['tag_id'] : null;
    $search = $_GET['search'] ?? '';

    $params = [];
    $conditions = [];

    if ($start !== null) {
        $conditions[] = "n.created_at >= ?";
        $params[] = $start;
    }
    if ($end !== null) {
        $conditions[] = "n.created_at <= ?";
        $params[] = $end;
    }

    if ($search !== '') {
        $conditions[] = "(c.name LIKE ? OR c.company LIKE ? OR n.content LIKE ?)";
        $searchParam = '%' . $search . '%';
        $params[] = $searchParam;
        $params[] = $searchParam;
        $params[] = $searchParam;
    }

    if ($tagId !== null) {
        $conditions[] = "c.id IN (SELECT contact_id FROM contact_tags WHERE tag_id = ?)";
        $params[] = $tagId;
    }

    $where = count($conditions) > 0 ? 'WHERE ' . implode(' AND ', $conditions) : '';

    $sql = "
        SELECT n.id, n.contact_id, n.company, n.content, n.created_at,
               c.name as contact_name, c.company as contact_company
        FROM notes n
        JOIN contacts c ON n.contact_id = c.id
        {$where}
        ORDER BY n.created_at DESC
    ";

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $notes = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Fetch tags for each contact involved
    $contactIds = array_unique(array_column($notes, 'contact_id'));
    $contactTags = [];

    if (count($contactIds) > 0) {
        $placeholders = implode(',', array_fill(0, count($contactIds), '?'));
        $tagStmt = $db->prepare("
            SELECT ct.contact_id, t.id as tag_id, t.name as tag_name, t.color as tag_color
            FROM contact_tags ct
            JOIN tags t ON ct.tag_id = t.id
            WHERE ct.contact_id IN ({$placeholders})
        ");
        $tagStmt->execute(array_values($contactIds));
        $tagRows = $tagStmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($tagRows as $row) {
            $cid = $row['contact_id'];
            if (!isset($contactTags[$cid])) {
                $contactTags[$cid] = [];
            }
            $contactTags[$cid][] = [
                'id' => $row['tag_id'],
                'name' => $row['tag_name'],
                'color' => $row['tag_color']
            ];
        }
    }

    // Attach tags to notes
    foreach ($notes as &$note) {
        $note['tags'] = $contactTags[$note['contact_id']] ?? [];
    }
    unset($note);

    echo json_encode(['success' => true, 'data' => $notes]);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => 'An internal error occurred']);
}
