<?php
/**
 * Companies API (includes/Company.php)
 *
 * GET                       every company, with its counts of contacts and projects
 * GET    ?id=              one company with its contacts and projects
 * GET    ?action=similar   pairs of companies that look like the same firm
 * GET    ?action=map       the companies with a place on the map
 * POST                      create {name, website?, address?, vat_id?, sector?}
 * POST   ?action=merge      {from, into}: move everything over, delete "from"
 * POST   ?action=keep-apart {a, b}: no longer list this pair as similar
 * PUT    ?id=              change name and details (invoice_name: the name taken from an invoice)
 * DELETE ?id=              delete; contacts keep their company text
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Project.php';
require_once APP_ROOT . '/includes/Company.php';

header('Content-Type: application/json');
Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;

if (in_array($method, ['POST', 'PUT', 'DELETE'], true)) {
    Auth::requireCsrfToken();
}

$db = Database::getInstance();

function respond($data, int $status = 200): void
{
    http_response_code($status);
    echo json_encode(['success' => true, 'data' => $data]);
}

function fail(string $message, int $status): void
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
}

try {
    if ($method === 'GET') {
        if ($action === 'similar') {
            respond(Company::similar($db));
        } elseif ($action === 'map') {
            respond(Company::forMap($db));
        } elseif ($id !== null) {
            $company = Company::detail($db, $id);
            $company === null ? fail('Company not found', 404) : respond($company);
        } else {
            respond(Company::all($db));
        }
        return;
    }

    $input = $method === 'DELETE' ? [] : Auth::getJsonInput();
    if (!is_array($input)) {
        fail('Invalid JSON input', 400);
        return;
    }

    if ($method === 'POST' && $action === 'merge') {
        $from = (int) ($input['from'] ?? 0);
        $into = (int) ($input['into'] ?? 0);
        respond(Database::transactional(fn(PDO $d) => Company::merge($d, $from, $into)));
        return;
    }

    if ($method === 'POST' && $action === 'keep-apart') {
        Company::dismissPair($db, (int) ($input['a'] ?? 0), (int) ($input['b'] ?? 0));
        respond(Company::similar($db));
        return;
    }

    if ($method === 'POST') {
        $name = Company::cleanName($input['name'] ?? null);
        if ($name === null) {
            fail('Name is required', 400);
            return;
        }
        if (Company::idByName($db, $name) !== null) {
            fail('There is already a company called ' . $name, 409);
            return;
        }
        $company = Database::transactional(function (PDO $d) use ($name, $input) {
            $newId = Company::findOrCreate($d, $name);
            return Company::update($d, $newId, array_intersect_key($input, array_flip(['website', 'address', 'vat_id', 'sector'])));
        });
        Company::locate($db, (int) $company['id']);
        respond($company, 201);
        return;
    }

    if ($method === 'PUT' && $id !== null) {
        $fields = array_intersect_key($input, array_flip(['name', 'website', 'address', 'vat_id', 'sector', 'invoice_name']));
        $company = Database::transactional(fn(PDO $d) => Company::update($d, $id, $fields));
        if (array_key_exists('address', $fields)) {
            Company::locate($db, $id);
        }
        respond($company);
        return;
    }

    if ($method === 'DELETE' && $id !== null) {
        if (Company::get($db, $id) === null) {
            fail('Company not found', 404);
            return;
        }
        Database::transactional(fn(PDO $d) => Company::delete($d, $id));
        respond(['id' => $id]);
        return;
    }

    fail('Method not allowed', 405);
} catch (PDOException $e) {
    error_log('companies api: ' . $e->getMessage());
    fail('An internal error occurred', 500);
} catch (InvalidArgumentException $e) {
    fail($e->getMessage(), 400);
} catch (RuntimeException $e) {
    fail($e->getMessage(), $e->getCode() === 404 ? 404 : 400);
} catch (Throwable $e) {
    error_log('companies api: ' . $e->getMessage());
    fail('An internal error occurred', 500);
}
