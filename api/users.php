<?php
/**
 * Users API Endpoint
 *
 * Administrator-only account management: invite, edit, enable/disable, issue a
 * fresh password link, delete.
 *
 * Every handler here runs behind three gates: a valid session, an administrator
 * role, and a CSRF token on anything that changes state.
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Mailer.php';

header('Content-Type: application/json');
Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

// Account management is administrators only.
Auth::requireAdmin();

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;

if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
    Auth::requireCsrfToken();
}

$model = new User();
$model->pruneTokens();

try {
    switch ($method) {
        case 'GET':
            handleList($model);
            break;

        case 'POST':
            handleCreate($model);
            break;

        case 'PATCH':
            handleUpdate($model, $id, $action);
            break;

        case 'DELETE':
            handleDelete($model, $id);
            break;

        default:
            http_response_code(405);
            echo json_encode(['error' => 'Method not allowed']);
    }
} catch (Throwable $e) {
    error_log('users endpoint error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'An internal error occurred']);
}

/**
 * List all accounts, plus a description of the caller so the UI knows what it
 * is allowed to offer (an admin must not be handed a button that deletes
 * themselves).
 */
function handleList(User $model): void
{
    $me = Auth::currentUser();

    echo json_encode([
        'success' => true,
        'data' => $model->getAll(),
        'me' => [
            'id' => $me['id'] ?? null,
            'name' => $me['name'] ?? '',
            'email' => $me['email'] ?? null,
            'role' => $me['role'] ?? User::ROLE_MEMBER,
            'is_owner' => (bool) ($me['is_owner'] ?? false),
        ],
        'owner_name' => OWNER_DISPLAY_NAME,
    ]);
}

/**
 * Invite a new user.
 *
 * The admin supplies a name, an email and a role - never a password. The user
 * chooses their own through the emailed link, so no credential is ever known to
 * anyone but its owner.
 */
function handleCreate(User $model): void
{
    $input = Auth::getJsonInput();
    if (!is_array($input)) {
        respondError('Invalid request body.', 400);
    }

    $email = User::normalizeEmail($input['email'] ?? null);
    $name = Auth::sanitizeString($input['name'] ?? null, 120);
    $role = User::normalizeRole($input['role'] ?? null);

    if ($email === null) {
        respondError('Please enter a valid email address.', 422);
    }
    if ($name === null || $name === '') {
        respondError('Please enter a name.', 422);
    }

    try {
        $created = $model->invite($email, $name, $role);
    } catch (PDOException $e) {
        // UNIQUE violation on the email column.
        if (stripos($e->getMessage(), 'UNIQUE') !== false) {
            respondError('An account with that email already exists.', 409);
        }
        throw $e;
    }

    $link = buildTokenLink($created['token']);
    $mailed = Mailer::sendInvite($email, $name, $link, $created['expires_at']);

    logAccountEvent('created', $created['user'], 'Nutzer eingeladen: ' . $name);

    http_response_code(201);
    echo json_encode([
        'success' => true,
        'data' => $created['user'],
        // The link is returned either way. Mail on shared hosting is
        // unreliable, and an admin who can see the link can always finish the
        // setup by hand instead of the invite silently going nowhere.
        'invite_link' => $link,
        'invite_expires_at' => $created['expires_at'],
        'mail_sent' => $mailed,
    ]);
}

/**
 * Update an account: profile/role, status, or issue a fresh password link.
 */
function handleUpdate(User $model, ?int $id, string $action): void
{
    if ($id === null || $id <= 0) {
        respondError('User ID is required.', 400);
    }

    $target = $model->getById($id);
    if ($target === null) {
        respondError('User not found.', 404);
    }

    $me = Auth::currentUser();
    $isSelf = ($me['id'] !== null && (int) $me['id'] === $id);

    if ($action === 'resend') {
        $purpose = $target['status'] === User::STATUS_ACTIVE
            ? User::PURPOSE_RESET
            : User::PURPOSE_INVITE;

        $token = $model->issueLink($id, $purpose);
        $link = buildTokenLink($token['token']);

        $mailed = $purpose === User::PURPOSE_INVITE
            ? Mailer::sendInvite($target['email'], $target['name'], $link, $token['expires_at'])
            : Mailer::sendPasswordReset($target['email'], $target['name'], $link, $token['expires_at']);

        echo json_encode([
            'success' => true,
            'data' => $model->getById($id),
            'invite_link' => $link,
            'invite_expires_at' => $token['expires_at'],
            'mail_sent' => $mailed,
            'purpose' => $purpose,
        ]);
        return;
    }

    $input = Auth::getJsonInput();
    if (!is_array($input)) {
        respondError('Invalid request body.', 400);
    }

    // --- Status change (enable / disable) ---------------------------------
    if (array_key_exists('status', $input)) {
        $status = (string) $input['status'];

        // Locking yourself out of your own admin session is never a thing the
        // user meant to do.
        if ($isSelf && $status === User::STATUS_DISABLED) {
            respondError('You cannot disable your own account.', 422);
        }

        if (!$model->setStatus($id, $status)) {
            respondError('That status is not valid.', 422);
        }

        $updated = $model->getById($id);
        logAccountEvent('updated', $updated, $status === User::STATUS_DISABLED
            ? 'Nutzer deaktiviert: ' . $updated['name']
            : 'Nutzer aktiviert: ' . $updated['name']);

        echo json_encode(['success' => true, 'data' => $updated]);
        return;
    }

    // --- Profile / role change --------------------------------------------
    $name = Auth::sanitizeString($input['name'] ?? $target['name'], 120);
    if ($name === null || $name === '') {
        respondError('Please enter a name.', 422);
    }

    $role = $target['role'];
    if (array_key_exists('role', $input)) {
        $requested = User::normalizeRole($input['role']);

        // An admin demoting themselves would immediately lose the panel they
        // are standing in. Role changes always go through another admin.
        if ($isSelf && $requested !== $target['role']) {
            respondError('You cannot change your own role.', 422);
        }

        $role = $requested;
    }

    $model->updateProfile($id, $name, $role);
    $updated = $model->getById($id);

    $changes = [];
    if ($name !== $target['name']) {
        $changes[] = 'Name';
    }
    if ($role !== $target['role']) {
        $changes[] = $role === User::ROLE_ADMIN ? 'zu Admin befördert' : 'zu Mitglied geändert';
    }
    if ($changes !== []) {
        logAccountEvent('updated', $updated, 'Nutzer geändert (' . $updated['name'] . '): ' . implode(', ', $changes));
    }

    echo json_encode(['success' => true, 'data' => $updated]);
}

function handleDelete(User $model, ?int $id): void
{
    if ($id === null || $id <= 0) {
        respondError('User ID is required.', 400);
    }

    $target = $model->getById($id);
    if ($target === null) {
        respondError('User not found.', 404);
    }

    $me = Auth::currentUser();
    if ($me['id'] !== null && (int) $me['id'] === $id) {
        respondError('You cannot delete your own account.', 422);
    }

    $model->delete($id);

    // The account is gone, but everything it touched keeps its name snapshot,
    // so the history stays readable.
    logAccountEvent('deleted', $target, 'Nutzer gelöscht: ' . $target['name']);

    echo json_encode(['success' => true, 'message' => 'User deleted']);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function respondError(string $message, int $status): void
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

/**
 * Build the absolute link a user follows to choose a password.
 *
 * APP_BASE_URL wins when configured. Otherwise the URL is derived from the
 * current request - the Host header is client-controlled, so it is validated
 * as a plain hostname before being trusted.
 */
function buildTokenLink(string $token): string
{
    if (APP_BASE_URL !== '') {
        $base = APP_BASE_URL;
    } else {
        $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
        if (!preg_match('/^[A-Za-z0-9.-]+(?::\d{1,5})?$/', $host)) {
            $host = 'localhost';
        }

        $scheme = Auth::isHttps() ? 'https' : 'http';

        $dir = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/'))), '/');
        // This script lives in /api, the login page one level up.
        if (substr($dir, -4) === '/api') {
            $dir = substr($dir, 0, -4);
        }

        $base = $scheme . '://' . $host . $dir;
    }

    return rtrim($base, '/') . '/index.php?action=set-password&token=' . urlencode($token);
}

/**
 * Record an account change on the shared activity timeline.
 *
 * User management shows up in the same calendar as every other change, so there
 * is one place to see who did what - including who granted whom access.
 */
function logAccountEvent(string $action, ?array $target, string $content): void
{
    if (!is_array($target)) {
        return;
    }

    try {
        $actor = Auth::actor();
        $db = Database::getInstance();

        $stmt = $db->prepare("
            INSERT INTO activity_events (
                entry_type, action, content, actor_id, actor_name
            ) VALUES (
                'account_activity', :action, :content, :actor_id, :actor_name
            )
        ");
        $stmt->execute([
            'action' => $action,
            'content' => $content,
            'actor_id' => $actor['id'],
            'actor_name' => $actor['name'],
        ]);
    } catch (Throwable $e) {
        error_log('account activity log failed: ' . $e->getMessage());
    }
}
