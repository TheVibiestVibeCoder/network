<?php
/**
 * Projects API Endpoint
 * Handles CRUD operations for projects
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Project.php';

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
if (in_array($method, ['POST', 'PUT', 'DELETE'], true)) {
    Auth::requireCsrfToken();
}

// Initialize project model
$projectModel = new Project();

try {
    switch ($method) {
        case 'GET':
            handleGet($projectModel, $action, $id);
            break;

        case 'POST':
            handlePost($projectModel, $action);
            break;

        case 'PUT':
            handlePut($projectModel, $id);
            break;

        case 'DELETE':
            handleDelete($projectModel, $action, $id);
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
function handleGet(Project $model, string $action, ?int $id): void
{
    // Get projects for a specific contact
    if ($action === 'contact' && isset($_GET['contact_id'])) {
        $contactId = (int) $_GET['contact_id'];
        $projects = $model->getByContact($contactId);
        echo json_encode(['success' => true, 'data' => $projects]);
        return;
    }

    // Get projects for a specific company
    if ($action === 'company' && isset($_GET['company'])) {
        $company = Auth::sanitizeString($_GET['company'], 255) ?? '';
        $projects = $model->getByCompany($company);
        echo json_encode(['success' => true, 'data' => $projects]);
        return;
    }

    // Get contacts for a project
    if ($action === 'contacts' && $id !== null) {
        $contacts = $model->getContacts($id);
        echo json_encode(['success' => true, 'data' => $contacts]);
        return;
    }

    // Get tags for a project
    if ($action === 'tags' && $id !== null) {
        $tags = $model->getTags($id);
        echo json_encode(['success' => true, 'data' => $tags]);
        return;
    }

    // Get notes for a project
    if ($action === 'notes' && $id !== null) {
        $notes = $model->getNotes($id);
        echo json_encode(['success' => true, 'data' => $notes]);
        return;
    }

    if ($id !== null) {
        // Get single project
        $project = $model->getById($id);

        if ($project === null) {
            http_response_code(404);
            echo json_encode(['error' => 'Project not found']);
            return;
        }

        echo json_encode(['success' => true, 'data' => $project]);
        return;
    }

    // Get all projects with optional search and sort
    $search = Auth::sanitizeString($_GET['search'] ?? '', 255) ?? '';
    $sortBy = $_GET['sort'] ?? 'name';
    $sortOrder = $_GET['order'] ?? 'ASC';

    $projects = $model->getAll($search, $sortBy, $sortOrder);
    echo json_encode(['success' => true, 'data' => $projects]);
}

/**
 * Handle POST requests (create, assign contact/tag, add notes)
 */
function handlePost(Project $model, string $action): void
{
    // Assign contact to project
    if ($action === 'assign-contact') {
        $input = Auth::getJsonInput();
        if (!is_array($input)) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid JSON input']);
            return;
        }

        $projectId = parsePositiveId($input['project_id'] ?? null);
        $contactId = parsePositiveId($input['contact_id'] ?? null);
        if ($projectId === null || $contactId === null) {
            http_response_code(400);
            echo json_encode(['error' => 'Project ID and Contact ID are required']);
            return;
        }

        if (!recordExists('projects', $projectId)) {
            http_response_code(404);
            echo json_encode(['error' => 'Project not found']);
            return;
        }

        if (!recordExists('contacts', $contactId)) {
            http_response_code(404);
            echo json_encode(['error' => 'Contact not found']);
            return;
        }

        $success = $model->assignContact($projectId, $contactId);
        echo json_encode(['success' => $success, 'message' => 'Contact assigned to project']);
        return;
    }

    // Assign tag to project
    if ($action === 'assign-tag') {
        $input = Auth::getJsonInput();
        if (!is_array($input)) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid JSON input']);
            return;
        }

        $projectId = parsePositiveId($input['project_id'] ?? null);
        $tagId = parsePositiveId($input['tag_id'] ?? null);
        if ($projectId === null || $tagId === null) {
            http_response_code(400);
            echo json_encode(['error' => 'Project ID and Tag ID are required']);
            return;
        }

        if (!recordExists('projects', $projectId)) {
            http_response_code(404);
            echo json_encode(['error' => 'Project not found']);
            return;
        }

        if (!recordExists('tags', $tagId)) {
            http_response_code(404);
            echo json_encode(['error' => 'Tag not found']);
            return;
        }

        $success = $model->assignTag($projectId, $tagId);
        echo json_encode(['success' => $success, 'message' => 'Tag assigned to project']);
        return;
    }

    // Add note to project
    if ($action === 'add-note') {
        $input = Auth::getJsonInput();
        if (!is_array($input)) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid JSON input']);
            return;
        }

        $projectId = isset($input['project_id']) ? (int)$input['project_id'] : 0;
        $contentText = Auth::sanitizeString($input['content'] ?? null, 10000);

        if ($projectId <= 0) {
            http_response_code(400);
            echo json_encode(['error' => 'project_id is required']);
            return;
        }

        if (empty($contentText)) {
            http_response_code(400);
            echo json_encode(['error' => 'content is required']);
            return;
        }

        $project = $model->getById($projectId);
        if ($project === null) {
            http_response_code(404);
            echo json_encode(['error' => 'Project not found']);
            return;
        }

        $note = $model->createNote($projectId, $contentText);

        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $note]);
        return;
    }

    // Create new project
    $input = Auth::getJsonInput();
    if (!is_array($input)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    $name = Auth::sanitizeString($input['name'] ?? '', 255);
    $description = Auth::sanitizeString($input['description'] ?? '', 10000);
    $startDate = normalizeDateYmd($input['start_date'] ?? null, true);
    $estimatedCompletion = normalizeDateYmd($input['estimated_completion'] ?? null, false);
    $company = Auth::sanitizeString($input['company'] ?? null, 255);
    $stage = normalizeStage($input['stage'] ?? 'Lead');
    $budgetMin = normalizeNullableFloat($input['budget_min'] ?? null);
    $budgetMax = normalizeNullableFloat($input['budget_max'] ?? null);
    $successChance = normalizeNullableInt($input['success_chance'] ?? null);

    // Validate required fields
    if ($name === null || trim($name) === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Name is required']);
        return;
    }

    if ($description === null || trim($description) === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Description is required']);
        return;
    }

    if ($startDate === false) {
        http_response_code(400);
        echo json_encode(['error' => 'Start date is required and must be YYYY-MM-DD']);
        return;
    }

    if ($estimatedCompletion === false) {
        http_response_code(400);
        echo json_encode(['error' => 'estimated_completion must be YYYY-MM-DD']);
        return;
    }

    if ($budgetMin === false || $budgetMax === false) {
        http_response_code(400);
        echo json_encode(['error' => 'budget_min and budget_max must be numeric values']);
        return;
    }

    if ($successChance === false) {
        http_response_code(400);
        echo json_encode(['error' => 'success_chance must be an integer between 0 and 100']);
        return;
    }

    $normalizedSuccessChance = $successChance === null ? null : max(0, min(100, $successChance));
    $normalizedBudgetMin = $budgetMin === null ? null : (float) $budgetMin;
    $normalizedBudgetMax = $budgetMax === null ? null : (float) $budgetMax;

    if ($normalizedBudgetMin !== null && $normalizedBudgetMax !== null && $normalizedBudgetMin > $normalizedBudgetMax) {
        [$normalizedBudgetMin, $normalizedBudgetMax] = [$normalizedBudgetMax, $normalizedBudgetMin];
    }

    $sanitized = [
        'name' => $name,
        'start_date' => $startDate,
        'description' => $description,
        'company' => $company,
        'budget_min' => $normalizedBudgetMin,
        'budget_max' => $normalizedBudgetMax,
        'success_chance' => $normalizedSuccessChance,
        'stage' => $stage,
        'estimated_completion' => $estimatedCompletion
    ];

    // Create project
    $id = $model->create($sanitized);
    $project = $model->getById($id);
    logProjectActivityEvent('created', $project, null);

    http_response_code(201);
    echo json_encode(['success' => true, 'data' => $project]);
}

/**
 * Handle PUT requests (update)
 */
function handlePut(Project $model, ?int $id): void
{
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Project ID is required']);
        return;
    }

    // Check if project exists
    $existing = $model->getById($id);
    if ($existing === null) {
        http_response_code(404);
        echo json_encode(['error' => 'Project not found']);
        return;
    }

    $input = Auth::getJsonInput();
    if (!is_array($input)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON input']);
        return;
    }

    $name = Auth::sanitizeString($input['name'] ?? '', 255);
    $description = Auth::sanitizeString($input['description'] ?? '', 10000);
    $startDate = normalizeDateYmd($input['start_date'] ?? null, true);
    $estimatedCompletion = normalizeDateYmd($input['estimated_completion'] ?? null, false);
    $company = Auth::sanitizeString($input['company'] ?? null, 255);
    $stage = normalizeStage($input['stage'] ?? 'Lead');
    $budgetMin = normalizeNullableFloat($input['budget_min'] ?? null);
    $budgetMax = normalizeNullableFloat($input['budget_max'] ?? null);
    $successChance = normalizeNullableInt($input['success_chance'] ?? null);

    // Validate required fields
    if ($name === null || trim($name) === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Name is required']);
        return;
    }

    if ($description === null || trim($description) === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Description is required']);
        return;
    }

    if ($startDate === false) {
        http_response_code(400);
        echo json_encode(['error' => 'Start date is required and must be YYYY-MM-DD']);
        return;
    }

    if ($estimatedCompletion === false) {
        http_response_code(400);
        echo json_encode(['error' => 'estimated_completion must be YYYY-MM-DD']);
        return;
    }

    if ($budgetMin === false || $budgetMax === false) {
        http_response_code(400);
        echo json_encode(['error' => 'budget_min and budget_max must be numeric values']);
        return;
    }

    if ($successChance === false) {
        http_response_code(400);
        echo json_encode(['error' => 'success_chance must be an integer between 0 and 100']);
        return;
    }

    $normalizedSuccessChance = $successChance === null ? null : max(0, min(100, $successChance));
    $normalizedBudgetMin = $budgetMin === null ? null : (float) $budgetMin;
    $normalizedBudgetMax = $budgetMax === null ? null : (float) $budgetMax;

    if ($normalizedBudgetMin !== null && $normalizedBudgetMax !== null && $normalizedBudgetMin > $normalizedBudgetMax) {
        [$normalizedBudgetMin, $normalizedBudgetMax] = [$normalizedBudgetMax, $normalizedBudgetMin];
    }

    $sanitized = [
        'name' => $name,
        'start_date' => $startDate,
        'description' => $description,
        'company' => $company,
        'budget_min' => $normalizedBudgetMin,
        'budget_max' => $normalizedBudgetMax,
        'success_chance' => $normalizedSuccessChance,
        'stage' => $stage,
        'estimated_completion' => $estimatedCompletion
    ];

    // Update project
    $model->update($id, $sanitized);
    $project = $model->getById($id);
    logProjectActivityEvent('updated', $project, $existing);

    echo json_encode(['success' => true, 'data' => $project]);
}

/**
 * Handle DELETE requests
 */
function handleDelete(Project $model, string $action, ?int $id): void
{
    // Unassign contact from project
    if ($action === 'unassign-contact') {
        $input = Auth::getJsonInput();
        if (!is_array($input)) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid JSON input']);
            return;
        }

        $projectId = parsePositiveId($input['project_id'] ?? null);
        $contactId = parsePositiveId($input['contact_id'] ?? null);
        if ($projectId === null || $contactId === null) {
            http_response_code(400);
            echo json_encode(['error' => 'Project ID and Contact ID are required']);
            return;
        }

        $success = $model->unassignContact($projectId, $contactId);
        echo json_encode(['success' => $success, 'message' => 'Contact unassigned from project']);
        return;
    }

    // Unassign tag from project
    if ($action === 'unassign-tag') {
        $input = Auth::getJsonInput();
        if (!is_array($input)) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid JSON input']);
            return;
        }

        $projectId = parsePositiveId($input['project_id'] ?? null);
        $tagId = parsePositiveId($input['tag_id'] ?? null);
        if ($projectId === null || $tagId === null) {
            http_response_code(400);
            echo json_encode(['error' => 'Project ID and Tag ID are required']);
            return;
        }

        $success = $model->unassignTag($projectId, $tagId);
        echo json_encode(['success' => $success, 'message' => 'Tag unassigned from project']);
        return;
    }

    // Delete a note from project
    if ($action === 'delete-note') {
        if ($id === null) {
            http_response_code(400);
            echo json_encode(['error' => 'Note ID is required']);
            return;
        }

        $existingNote = $model->getNoteById($id);
        if ($existingNote === null) {
            http_response_code(404);
            echo json_encode(['error' => 'Note not found']);
            return;
        }

        $model->deleteNote($id);
        echo json_encode(['success' => true, 'message' => 'Note deleted']);
        return;
    }

    // Delete project
    if ($id === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Project ID is required']);
        return;
    }

    // Check if project exists
    $existing = $model->getById($id);
    if ($existing === null) {
        http_response_code(404);
        echo json_encode(['error' => 'Project not found']);
        return;
    }

    // Delete project
    $model->delete($id);
    logProjectActivityEvent('deleted', null, $existing);

    echo json_encode(['success' => true, 'message' => 'Project deleted']);
}

/**
 * Parse a positive integer ID.
 */
function parsePositiveId($value): ?int
{
    if (is_int($value)) {
        return $value > 0 ? $value : null;
    }

    if (is_string($value) && ctype_digit($value)) {
        $parsed = (int) $value;
        return $parsed > 0 ? $parsed : null;
    }

    return null;
}

/**
 * Check if a record exists in a supported table.
 */
function recordExists(string $table, int $id): bool
{
    $allowedTables = ['contacts', 'projects', 'tags'];
    if (!in_array($table, $allowedTables, true) || $id <= 0) {
        return false;
    }

    $db = Database::getInstance();
    $stmt = $db->prepare("SELECT id FROM {$table} WHERE id = :id LIMIT 1");
    $stmt->execute(['id' => $id]);
    return (bool) $stmt->fetchColumn();
}

/**
 * Validate and normalize date values to YYYY-MM-DD.
 *
 * @return string|false|null
 */
function normalizeDateYmd($value, bool $required)
{
    if ($value === null || $value === '') {
        return $required ? false : null;
    }

    if (!is_string($value)) {
        return false;
    }

    $date = trim($value);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        return false;
    }

    $dt = DateTime::createFromFormat('Y-m-d', $date);
    $errors = DateTime::getLastErrors();
    $warningCount = is_array($errors) ? (int) ($errors['warning_count'] ?? 0) : 0;
    $errorCount = is_array($errors) ? (int) ($errors['error_count'] ?? 0) : 0;

    if (!$dt || $warningCount > 0 || $errorCount > 0 || $dt->format('Y-m-d') !== $date) {
        return false;
    }

    return $date;
}

/**
 * Validate and normalize project stage.
 */
function normalizeStage($value): string
{
    $candidate = Auth::sanitizeString(is_string($value) ? $value : 'Lead', 50) ?? 'Lead';
    $allowedStages = ['Lead', 'Proposal', 'Negotiation', 'In Progress', 'Complete'];
    return in_array($candidate, $allowedStages, true) ? $candidate : 'Lead';
}

/**
 * Parse a nullable float.
 *
 * @return float|false|null
 */
function normalizeNullableFloat($value)
{
    if ($value === null || $value === '') {
        return null;
    }

    if (!is_numeric($value)) {
        return false;
    }

    return (float) $value;
}

/**
 * Parse a nullable integer.
 *
 * @return int|false|null
 */
function normalizeNullableInt($value)
{
    if ($value === null || $value === '') {
        return null;
    }

    if (is_int($value)) {
        return $value;
    }

    if (is_string($value) && preg_match('/^-?\d+$/', $value)) {
        return (int) $value;
    }

    if (is_float($value) || (is_string($value) && is_numeric($value))) {
        return (int) round((float) $value);
    }

    return false;
}

/**
 * Persist project create/update/delete events for calendar history.
 */
function logProjectActivityEvent(string $action, ?array $current, ?array $previous): void
{
    try {
        $db = Database::getInstance();

        $source = $action === 'deleted' ? $previous : $current;
        if (!is_array($source)) {
            return;
        }

        $projectIdRaw = isset($source['id']) ? (int) $source['id'] : 0;
        $projectId = ($action === 'deleted' || $projectIdRaw <= 0) ? null : $projectIdRaw;
        $projectName = Auth::sanitizeString((string) ($source['name'] ?? ''), 255) ?? '';
        $projectCompany = Auth::sanitizeString($source['company'] ?? null, 255);
        $content = buildProjectActivityContent($action, $current, $previous);

        $stmt = $db->prepare("
            INSERT INTO activity_events (
                entry_type,
                action,
                content,
                project_id,
                project_name,
                project_company
            ) VALUES (
                'project_activity',
                :action,
                :content,
                :project_id,
                :project_name,
                :project_company
            )
        ");

        $stmt->execute([
            'action' => $action,
            'content' => $content,
            'project_id' => $projectId,
            'project_name' => $projectName,
            'project_company' => $projectCompany
        ]);
    } catch (Exception $e) {
        error_log('project activity log failed: ' . $e->getMessage());
    }
}

/**
 * Build readable activity text for project events.
 */
function buildProjectActivityContent(string $action, ?array $current, ?array $previous): string
{
    if ($action === 'created') {
        return 'Projekt erstellt';
    }

    if ($action === 'deleted') {
        return 'Projekt gelöscht';
    }

    $changedFields = detectProjectChangedFields($previous, $current);
    if (empty($changedFields)) {
        return 'Projekt bearbeitet';
    }

    $list = implode(', ', array_slice($changedFields, 0, 4));
    if (count($changedFields) > 4) {
        $list .= ', ...';
    }

    return 'Projekt aktualisiert: ' . $list;
}

/**
 * Detect meaningful field changes for project updates.
 */
function detectProjectChangedFields(?array $before, ?array $after): array
{
    if (!is_array($before) || !is_array($after)) {
        return [];
    }

    $fields = [
        'name' => 'Name',
        'company' => 'Firma',
        'start_date' => 'Startdatum',
        'stage' => 'Phase',
        'success_chance' => 'Erfolgschance',
        'budget_min' => 'Budget Min',
        'budget_max' => 'Budget Max',
        'estimated_completion' => 'Abschlussdatum',
        'description' => 'Beschreibung'
    ];

    $changed = [];
    foreach ($fields as $key => $label) {
        $old = normalizeProjectComparableValue($before[$key] ?? null);
        $new = normalizeProjectComparableValue($after[$key] ?? null);
        if ($old !== $new) {
            $changed[] = $label;
        }
    }

    return $changed;
}

/**
 * Normalize values for project change comparison.
 */
function normalizeProjectComparableValue($value): string
{
    if ($value === null) {
        return '';
    }

    if (is_bool($value)) {
        return $value ? '1' : '0';
    }

    if (is_numeric($value)) {
        return (string) $value;
    }

    return trim((string) $value);
}
