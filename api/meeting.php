<?php
/**
 * Meeting assistant API (TEST) - see includes/MeetingAssistant.php.
 *
 *   GET  ?action=projects                    the projects to go through, in meeting order
 *   GET  ?action=context&id=..               one project: fields, contacts, open to-dos, notes, team
 *   GET  ?action=contexts                    all of them at once, keyed by project id
 *   POST ?action=submit {project_id, text}   Claude turns the text into proposals under "From Claude"
 *                                            (source: "card" when typed on a project card, not in a meeting)
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/User.php';
require_once APP_ROOT . '/includes/Contact.php';
require_once APP_ROOT . '/includes/Project.php';
require_once APP_ROOT . '/includes/ReviewQueue.php';
require_once APP_ROOT . '/includes/McpService.php';
require_once APP_ROOT . '/includes/MeetingAssistant.php';

header('Content-Type: application/json');
Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

if (!MeetingAssistant::enabled()) {
    http_response_code(404);
    echo json_encode(['error' => 'The meeting assistant is not switched on.']);
    exit;
}

if (!MeetingAssistant::allowed()) {
    http_response_code(403);
    echo json_encode(['error' => 'You do not have the meeting permission. An admin can give it to you on the Users page.']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

if ($method === 'POST') {
    Auth::requireCsrfToken();
}

// Claude takes a few seconds per project, and the meeting moves on meanwhile:
// let go of the session so the next project's requests are not queued behind
// this one, and finish even if the browser stops waiting.
session_write_close();

$db = Database::getInstance();

try {
    if ($method === 'GET' && $action === 'projects') {
        echo json_encode(['success' => true, 'data' => MeetingAssistant::projects($db)]);
    } elseif ($method === 'GET' && $action === 'contexts') {
        // Everything the meeting will show, in one go at its start, so moving
        // between projects never waits on the server - not even while it is
        // busy with Claude.
        $all = [];
        foreach (MeetingAssistant::projects($db) as $project) {
            $context = MeetingAssistant::context($db, $project['id']);
            if ($context !== null) {
                $all[(string) $project['id']] = $context;
            }
        }
        echo json_encode(['success' => true, 'data' => (object) $all]);
    } elseif ($method === 'GET' && $action === 'context') {
        $context = MeetingAssistant::context($db, (int) ($_GET['id'] ?? 0));
        if ($context === null) {
            http_response_code(404);
            echo json_encode(['error' => 'Project not found']);
        } else {
            echo json_encode(['success' => true, 'data' => $context]);
        }
    } elseif ($method === 'POST' && $action === 'submit') {
        ignore_user_abort(true);
        set_time_limit(240);

        $input = Auth::getJsonInput();
        $projectId = is_array($input) ? (int) ($input['project_id'] ?? 0) : 0;
        $text = is_array($input) ? trim((string) ($input['text'] ?? '')) : '';
        if ($text === '' || mb_strlen($text) > MeetingAssistant::MAX_TEXT_LENGTH) {
            http_response_code(400);
            echo json_encode(['error' => 'Please write what Claude should do (up to ' . MeetingAssistant::MAX_TEXT_LENGTH . ' characters).']);
            exit;
        }

        // Fresh from the database: Claude sees the project as it is now.
        $context = MeetingAssistant::context($db, $projectId);
        if ($context === null) {
            http_response_code(404);
            echo json_encode(['error' => 'Project not found']);
            exit;
        }

        try {
            $fromCard = is_array($input) && ($input['source'] ?? '') === 'card';
            echo json_encode(['success' => true, 'data' => MeetingAssistant::propose($db, $context, $text, $fromCard)]);
        } catch (RuntimeException $e) {
            http_response_code(502);
            echo json_encode(['error' => $e->getMessage()]);
        }
    } else {
        http_response_code(400);
        echo json_encode(['error' => 'Unknown action']);
    }
} catch (Throwable $e) {
    error_log('meeting endpoint error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'An internal error occurred']);
}
