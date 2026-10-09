<?php
/**
 * Review API Endpoint
 *
 * What the CRM's "From Claude" screen and the inline accept/reject buttons talk
 * to. Every signed-in person may accept, reject or edit a proposal - deciding
 * is ordinary teamwork, like assigning.
 *
 *   GET  ?action=summary                          open proposals per type (nav badge)
 *   GET  ?action=list&status=pending|resolved     the proposals themselves
 *   GET  ?action=list&entity_type=..&entity_id=.. the open proposals for one record
 *   POST ?action=accept   {id} | {entity_type, entity_id}
 *   POST ?action=reject   {id} | {entity_type, entity_id}
 *   POST ?action=resolve  {id}   after the browser applied an edit/delete/assign
 *   POST ?action=edit-note {entity_type, entity_id, content}   reword a proposed note
 *
 * The {entity_type, entity_id} form is for the buttons on a proposed record
 * itself: it finds the open "create" proposal behind that record.
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/ReviewQueue.php';

header('Content-Type: application/json');
Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

if ($method === 'POST') {
    Auth::requireCsrfToken();
}

try {
    if ($method === 'GET' && $action === 'summary') {
        reviewRespond(['success' => true, 'data' => reviewVisibleSummary()]);
    }

    if ($method === 'GET' && $action === 'list') {
        $status = ($_GET['status'] ?? 'pending') === 'resolved' ? 'resolved' : ReviewQueue::PENDING;
        $type = isset($_GET['entity_type']) ? (string) $_GET['entity_type'] : null;
        $id = isset($_GET['entity_id']) ? (int) $_GET['entity_id'] : null;
        $limit = $status === ReviewQueue::PENDING ? 300 : 100;

        $items = ReviewQueue::listItems($status, $limit, $type, $id);
        // Invoices for the bookkeeping drop zone are for administrators only.
        if (!Auth::isAdmin()) {
            $items = array_values(array_filter($items, fn($item) => $item['entity_type'] !== 'bookkeeping_pdf'));
        }
        reviewRespond(['success' => true, 'data' => $items]);
    }

    if ($method === 'POST' && $action === 'edit-note') {
        $input = Auth::getJsonInput();
        if (!is_array($input)) {
            reviewRespond(['error' => 'Invalid request body.'], 400);
        }

        // Notes have no edit endpoint of their own; a note Claude proposed can
        // be reworded here before it is accepted, and only while it is pending.
        $tables = ['contact_note' => 'notes', 'project_note' => 'project_notes'];
        $type = (string) ($input['entity_type'] ?? '');
        $noteId = (int) ($input['entity_id'] ?? 0);
        $content = Auth::sanitizeString(isset($input['content']) ? (string) $input['content'] : null, 10000);

        if (!isset($tables[$type]) || $noteId <= 0) {
            reviewRespond(['error' => 'Which note?'], 422);
        }
        if ($content === null || $content === '') {
            reviewRespond(['error' => 'A note cannot be empty.'], 422);
        }

        $stmt = Database::getInstance()->prepare(
            "UPDATE " . $tables[$type] . " SET content = :content WHERE id = :id AND review_status = 'pending'"
        );
        $stmt->execute(['content' => $content, 'id' => $noteId]);
        if ($stmt->rowCount() === 0) {
            reviewRespond(['error' => 'Only a note that is still waiting for review can be edited here.'], 409);
        }

        reviewRespond(['success' => true]);
    }

    if ($method === 'POST' && in_array($action, ['accept', 'reject', 'resolve'], true)) {
        $input = Auth::getJsonInput();
        if (!is_array($input)) {
            reviewRespond(['error' => 'Invalid request body.'], 400);
        }

        $id = reviewTargetId($input, $action);

        $target = ReviewQueue::get($id);
        if ($target && $target['entity_type'] === 'bookkeeping_pdf' && !Auth::isAdmin()) {
            reviewRespond(['error' => 'Administrator access required'], 403);
        }

        switch ($action) {
            case 'accept':
                $item = ReviewQueue::accept($id);
                break;
            case 'reject':
                $item = ReviewQueue::reject($id);
                break;
            default:
                $item = ReviewQueue::resolve($id);
        }

        reviewRespond(['success' => true, 'data' => $item, 'summary' => reviewVisibleSummary()]);
    }

    reviewRespond(['error' => 'Unknown action'], 400);
} catch (ReviewException $e) {
    reviewRespond(['error' => $e->getMessage()], $e->status());
} catch (Throwable $e) {
    error_log('review endpoint error: ' . $e->getMessage());
    reviewRespond(['error' => 'An internal error occurred'], 500);
}

/**
 * The open proposals the signed-in person can act on: everything for an
 * administrator, everything but bookkeeping invoices for anyone else.
 */
function reviewVisibleSummary(): array
{
    $summary = ReviewQueue::summary();
    if (!Auth::isAdmin() && isset($summary['by_type']['bookkeeping_pdf'])) {
        $summary['total'] -= $summary['by_type']['bookkeeping_pdf'];
        unset($summary['by_type']['bookkeeping_pdf']);
    }
    return $summary;
}

/**
 * The proposal a request is about: an explicit id, or - for the buttons on a
 * proposed record - the open "create" proposal behind that record.
 */
function reviewTargetId(array $input, string $action): int
{
    if (isset($input['id']) && (int) $input['id'] > 0) {
        return (int) $input['id'];
    }

    $type = (string) ($input['entity_type'] ?? '');
    $entityId = (int) ($input['entity_id'] ?? 0);

    if ($action !== 'resolve' && isset(ReviewQueue::PENDABLE[$type]) && $entityId > 0) {
        $item = ReviewQueue::pendingCreateFor($type, $entityId);
        if ($item !== null) {
            return (int) $item['id'];
        }
        throw new ReviewException('There is no open proposal for that record any more.', 404);
    }

    throw new ReviewException('Which proposal? Send an id.', 422);
}

function reviewRespond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload);
    exit;
}
