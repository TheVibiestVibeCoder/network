<?php
/**
 * Financials API Endpoint
 *
 * The Financials tab's own data: costs, the bank balance, settings
 * (includes/Financials.php). Administrators only - the tab shows the bank
 * balance and every cost we have.
 *
 * GET  ?action=overview         costs, balances (newest first), settings
 * POST ?action=save-cost        { id?, name, category, amount, vat_rate, kind, interval_months, start_month, end_month, day }
 * POST ?action=delete-cost      { id }
 * POST ?action=set-balance      { amount, as_of, note? }
 * POST ?action=delete-balance   { id }
 * POST ?action=save-settings    { vat_enabled?, vat_rate?, vat_period?, buffer? }
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Financials.php';

header('Content-Type: application/json');
Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}
Auth::requireAdmin();

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

if ($method === 'POST') {
    Auth::requireCsrfToken();
}

function finJson(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload);
    exit;
}

function finId($value): ?int
{
    $id = filter_var($value, FILTER_VALIDATE_INT);
    return ($id !== false && $id > 0) ? (int) $id : null;
}

try {
    $model = new Financials();

    if ($method === 'GET' && $action === 'overview') {
        finJson(['success' => true, 'data' => $model->overview()]);
    }

    if ($method !== 'POST') {
        finJson(['error' => 'Unknown action'], 400);
    }

    $input = Auth::getJsonInput();
    if (!is_array($input)) {
        finJson(['error' => 'Invalid JSON input'], 400);
    }

    switch ($action) {
        case 'save-cost':
            $cost = Financials::normalizeCost($input);
            if (is_string($cost)) {
                finJson(['error' => $cost], 400);
            }
            $id = array_key_exists('id', $input) && $input['id'] !== null ? finId($input['id']) : null;
            if (array_key_exists('id', $input) && $input['id'] !== null && $id === null) {
                finJson(['error' => 'Invalid cost id'], 400);
            }
            $savedId = $model->saveCost($id, $cost);
            finJson(['success' => true, 'id' => $savedId, 'data' => $model->overview()]);
            break;

        case 'delete-cost':
            $id = finId($input['id'] ?? null);
            if ($id === null) {
                finJson(['error' => 'A cost id is required'], 400);
            }
            $model->deleteCost($id);
            finJson(['success' => true, 'data' => $model->overview()]);
            break;

        case 'set-balance':
            $amount = $input['amount'] ?? null;
            if (!is_numeric($amount) || abs((float) $amount) > 1e12) {
                finJson(['error' => 'The balance must be a number'], 400);
            }
            $asOf = (string) ($input['as_of'] ?? '');
            $date = DateTime::createFromFormat('!Y-m-d', $asOf);
            if (!$date || $date->format('Y-m-d') !== $asOf) {
                finJson(['error' => 'The date must be YYYY-MM-DD'], 400);
            }
            $note = trim((string) ($input['note'] ?? ''));
            $model->addBalance((float) $amount, $asOf, $note === '' ? null : mb_substr($note, 0, 255));
            finJson(['success' => true, 'data' => $model->overview()]);
            break;

        case 'delete-balance':
            $id = finId($input['id'] ?? null);
            if ($id === null) {
                finJson(['error' => 'A balance id is required'], 400);
            }
            $model->deleteBalance($id);
            finJson(['success' => true, 'data' => $model->overview()]);
            break;

        case 'save-settings':
            $error = $model->saveSettings($input);
            if ($error !== null) {
                finJson(['error' => $error], 400);
            }
            finJson(['success' => true, 'data' => $model->overview()]);
            break;

        default:
            finJson(['error' => 'Unknown action'], 400);
    }
} catch (InvalidArgumentException $e) {
    finJson(['error' => $e->getMessage()], 400);
} catch (Throwable $e) {
    error_log('financials: ' . $e->getMessage());
    finJson(['error' => 'An internal error occurred'], 500);
}
