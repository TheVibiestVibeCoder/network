<?php
/**
 * Contacts API Endpoint
 * Handles CRUD operations for contacts
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Contact.php';

// Set JSON response headers and security headers
header('Content-Type: application/json');
Auth::sendSecurityHeaders();

// Check authentication
if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

// Get request method and action
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;

// Require CSRF token for state-changing requests
if (in_array($method, ['POST', 'PUT', 'DELETE'])) {
    Auth::requireCsrfToken();
}

// Initialize contact model
$contactModel = new Contact();

try {
    switch ($method) {
        case 'GET':
            handleGet($contactModel, $action, $id);
            break;

        case 'POST':
            handlePost($contactModel, $action);
            break;

        case 'PUT':
            handlePut($contactModel, $id);
            break;

        case 'DELETE':
            handleDelete($contactModel, $id);
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
function handleGet(Contact $model, string $action, ?int $id): void
{
    if ($action === 'map') {
        // Get contacts for map display
        $contacts = $model->getForMap();
        echo json_encode(['success' => true, 'data' => $contacts]);
        return;
    }

    if ($id !== null) {
        // Get single contact
        $contact = $model->getById($id);

        if ($contact === null) {
            http_response_code(404);
            echo json_encode(['error' => 'Contact not found']);
            return;
        }

        echo json_encode(['success' => true, 'data' => $contact]);
        return;
    }

    // Get all contacts with optional search and sort
    $search = $_GET['search'] ?? '';
    $sortBy = $_GET['sort'] ?? 'name';
    $sortOrder = $_GET['order'] ?? 'ASC';

    $contacts = $model->getAll($search, $sortBy, $sortOrder);
    echo json_encode(['success' => true, 'data' => $contacts]);
}

/**
 * Handle POST requests (create)
 */
function handlePost(Contact $model, string $action): void
{
    // One-time data fix: normalize URLs + geocode missing coordinates
    if ($action === 'fix-data') {
        handleFixData($model);
        return;
    }

    // Get JSON input
    $input = json_decode(file_get_contents('php://input'), true);

    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    // Sanitize all input fields
    $input = Auth::sanitizeContactInput($input);

    // Validate required fields
    if (empty($input['name'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Name is required']);
        return;
    }

    // Normalize website URL
    if (!empty($input['website'])) {
        $input['website'] = Contact::normalizeWebsite($input['website']);
    }

    // Geocode location if provided (fall back to address field)
    $locationToGeocode = !empty($input['location']) ? $input['location'] : (!empty($input['address']) ? $input['address'] : null);
    if ($locationToGeocode && (empty($input['latitude']) || empty($input['longitude']))) {
        $coords = geocodeLocation($locationToGeocode);
        if ($coords) {
            $input['latitude'] = $coords['lat'];
            $input['longitude'] = $coords['lng'];
        }
    }

    // Create contact
    $id = $model->create($input);
    $contact = $model->getById($id);

    http_response_code(201);
    echo json_encode(['success' => true, 'data' => $contact]);
}

/**
 * Handle PUT requests (update)
 */
function handlePut(Contact $model, ?int $id): void
{
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Contact ID is required']);
        return;
    }

    // Check if contact exists
    $existing = $model->getById($id);
    if ($existing === null) {
        http_response_code(404);
        echo json_encode(['error' => 'Contact not found']);
        return;
    }

    // Get JSON input
    $input = json_decode(file_get_contents('php://input'), true);

    if ($input === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    // Sanitize all input fields
    $input = Auth::sanitizeContactInput($input);

    // Validate required fields
    if (empty($input['name'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Name is required']);
        return;
    }

    // Normalize website URL
    if (!empty($input['website'])) {
        $input['website'] = Contact::normalizeWebsite($input['website']);
    }

    // Geocode location if changed (fall back to address field)
    $locationToGeocode = !empty($input['location']) ? $input['location'] : (!empty($input['address']) ? $input['address'] : null);
    $existingGeoSource = !empty($existing['location']) ? $existing['location'] : (!empty($existing['address']) ? $existing['address'] : null);
    if ($locationToGeocode && $locationToGeocode !== $existingGeoSource) {
        $coords = geocodeLocation($locationToGeocode);
        if ($coords) {
            $input['latitude'] = $coords['lat'];
            $input['longitude'] = $coords['lng'];
        } else {
            $input['latitude'] = null;
            $input['longitude'] = null;
        }
    } elseif (!$locationToGeocode) {
        $input['latitude'] = null;
        $input['longitude'] = null;
    }

    // Update contact
    $model->update($id, $input);
    $contact = $model->getById($id);

    echo json_encode(['success' => true, 'data' => $contact]);
}

/**
 * Handle DELETE requests
 */
function handleDelete(Contact $model, ?int $id): void
{
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Contact ID is required']);
        return;
    }

    // Check if contact exists
    $existing = $model->getById($id);
    if ($existing === null) {
        http_response_code(404);
        echo json_encode(['error' => 'Contact not found']);
        return;
    }

    // Delete contact
    $model->delete($id);

    echo json_encode(['success' => true, 'message' => 'Contact deleted']);
}

/**
 * Geocode a location string to coordinates
 * Uses Nominatim (OpenStreetMap) - free and open source
 */
function geocodeLocation(string $location): ?array
{
    $url = 'https://nominatim.openstreetmap.org/search?' . http_build_query([
        'q' => $location,
        'format' => 'json',
        'limit' => 1
    ]);

    $context = stream_context_create([
        'http' => [
            'header' => 'User-Agent: SimpleCRM/1.0',
            'timeout' => 5
        ]
    ]);

    $response = @file_get_contents($url, false, $context);

    if ($response === false) {
        return null;
    }

    $data = json_decode($response, true);

    if (empty($data) || !isset($data[0]['lat']) || !isset($data[0]['lon'])) {
        return null;
    }

    return [
        'lat' => (float) $data[0]['lat'],
        'lng' => (float) $data[0]['lon']
    ];
}

/**
 * One-time fix for existing data:
 * 1. Normalize all website URLs missing a protocol
 * 2. Geocode contacts that have location/address but no coordinates
 */
function handleFixData(Contact $model): void
{
    set_time_limit(600);

    $db = Database::getInstance();
    $results = ['urls_fixed' => 0, 'geocoded' => 0, 'geocode_failed' => 0];

    // 1. Normalize website URLs
    $stmt = $db->query("SELECT id, website FROM contacts WHERE website IS NOT NULL AND website != ''");
    $contacts = $stmt->fetchAll();

    $update = $db->prepare("UPDATE contacts SET website = :website WHERE id = :id");
    foreach ($contacts as $contact) {
        $normalized = Contact::normalizeWebsite($contact['website']);
        if ($normalized !== $contact['website']) {
            $update->execute(['website' => $normalized, 'id' => $contact['id']]);
            $results['urls_fixed']++;
        }
    }

    // 2. Geocode contacts missing coordinates
    $stmt = $db->query("
        SELECT id, location, address FROM contacts
        WHERE latitude IS NULL AND (location IS NOT NULL AND location != '' OR address IS NOT NULL AND address != '')
    ");
    $toGeocode = $stmt->fetchAll();

    $update = $db->prepare("UPDATE contacts SET latitude = :lat, longitude = :lng WHERE id = :id");
    foreach ($toGeocode as $contact) {
        $locationToGeocode = !empty($contact['location']) ? $contact['location'] : $contact['address'];
        $coords = geocodeLocation($locationToGeocode);

        if ($coords) {
            $update->execute(['lat' => $coords['lat'], 'lng' => $coords['lng'], 'id' => $contact['id']]);
            $results['geocoded']++;
        } else {
            $results['geocode_failed']++;
        }

        // Respect Nominatim rate limit (1 req/sec)
        usleep(1100000);
    }

    echo json_encode([
        'success' => true,
        'message' => "Fixed {$results['urls_fixed']} URLs, geocoded {$results['geocoded']} contacts, {$results['geocode_failed']} could not be resolved.",
        'data' => $results
    ]);
}
