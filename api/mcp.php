<?php
/**
 * MCP API endpoint
 *
 * The one door Claude's MCP server uses to read the CRM and to propose
 * changes. It is not for browsers: there is no session and no cookie, and a
 * request has to pass every check in includes/McpGuard.php (switched on,
 * allow-listed address, HTTPS, fresh timestamp, valid HMAC signature, unseen
 * nonce, rate limit) before anything below runs. The actions themselves are in
 * includes/McpService.php; whatever they write waits for a person to accept it
 * (includes/ReviewQueue.php).
 *
 * Wire format:
 *   POST api/mcp.php
 *   Content-Type: application/octet-stream
 *   X-CRM-Timestamp: <unix seconds>
 *   X-CRM-Nonce: <32-64 hex chars, never reused>
 *   X-CRM-Signature: hex(HMAC-SHA256(secret, "CRM-MCP-V1\n{timestamp}\n{nonce}\n{hex(SHA256(body))}"))
 *   body: base64( JSON {"action": "...", "params": {...}} )
 *
 * The base64 layer is there for the same reason as the contact form's payload
 * encoding: shared-hosting web application firewalls inspect JSON bodies and
 * block ordinary CRM text as if it were an attack.
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Contact.php';
require_once APP_ROOT . '/includes/Project.php';
require_once APP_ROOT . '/includes/ReviewQueue.php';
require_once APP_ROOT . '/includes/McpGuard.php';
require_once APP_ROOT . '/includes/McpService.php';

header_remove('X-Powered-By');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
header('Cache-Control: no-store');

$rawBody = McpGuard::verify();

$decoded = base64_decode(trim($rawBody), true);
$request = $decoded === false ? null : json_decode($decoded, true);

if (!is_array($request) || !isset($request['action']) || !is_string($request['action'])) {
    McpGuard::fail(400, 'The body must be base64-encoded JSON with an "action".');
}

$action = $request['action'];
$params = $request['params'] ?? [];
if (!is_array($params)) {
    McpGuard::fail(400, '"params" must be an object.');
}

// For the audit trail: which action each accepted request was.
try {
    Database::getInstance()
        ->prepare("UPDATE mcp_api_nonces SET action = :action WHERE nonce = :nonce")
        ->execute(['action' => mb_substr($action, 0, 64), 'nonce' => (string) ($_SERVER['HTTP_X_CRM_NONCE'] ?? '')]);
} catch (Throwable $e) {
    // Not worth failing a request over.
}

// Everything this request writes carries Claude's name, not a person's.
Auth::actAs(null, MCP_ACTOR_NAME);

try {
    $data = (new McpService())->handle($action, $params);
    mcpRespond(200, ['ok' => true, 'data' => $data]);
} catch (ReviewException $e) {
    mcpRespond($e->status(), ['ok' => false, 'error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('MCP API error in ' . mb_substr($action, 0, 64) . ': ' . $e->getMessage());
    mcpRespond(500, ['ok' => false, 'error' => 'Internal error in the CRM.']);
}

function mcpRespond(int $status, array $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
