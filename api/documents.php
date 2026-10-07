<?php
/**
 * Project documents API endpoint
 *
 * What the Documents section of a project's detail view talks to.
 *
 *   GET  ?action=list&project_id=N           the project's documents, the labels and the upload limits
 *   GET  ?action=meta                        the labels and the upload limits alone (a project being created)
 *   GET  ?action=download&id=N[&inline=1]    the file itself; inline only shows PDFs and images in place
 *   POST ?action=upload                      multipart: project_id, label, document
 *   POST ?action=set-label   {id, label}
 *   POST ?action=delete      {id}
 *
 * Every signed-in person may add, relabel and remove documents, as with notes
 * and to-dos. What may be stored, and where, is decided in
 * includes/ProjectDocument.php.
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/ProjectDocument.php';

Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    docJson(['error' => 'Unauthorized'], 401);
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

// A POST bigger than post_max_size reaches PHP with $_POST and $_FILES already
// emptied, so the CSRF check below would report a "missing token" for what is
// really an oversized upload. Detect that first.
if ($method === 'POST' && empty($_POST) && empty($_FILES)) {
    $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    $postMax = ProjectDocument::iniBytes((string) ini_get('post_max_size'));
    if ($contentLength > 0 && $postMax > 0 && $contentLength > $postMax) {
        docJson([
            'error' => 'That upload is larger than the server limit of ' . ProjectDocument::formatBytes($postMax) . '.',
        ], 413);
    }
}

if ($method === 'POST' && !Auth::validateCsrfToken()) {
    docJson(['error' => 'Invalid or missing CSRF token'], 403);
}

try {
    if ($method === 'GET' && $action === 'list') {
        docList((int) ($_GET['project_id'] ?? 0));
    }
    if ($method === 'GET' && $action === 'meta') {
        docJson(['success' => true, 'data' => docMeta()]);
    }
    if ($method === 'GET' && $action === 'download') {
        docDownload((int) ($_GET['id'] ?? 0), !empty($_GET['inline']));
    }
    if ($method === 'POST' && $action === 'upload') {
        docUpload();
    }
    if ($method === 'POST' && $action === 'set-label') {
        docSetLabel();
    }
    if ($method === 'POST' && $action === 'delete') {
        docDelete();
    }

    if (!in_array($method, ['GET', 'POST'], true)) {
        docJson(['error' => 'Method not allowed'], 405);
    }
    docJson(['error' => 'Unknown action'], 400);
} catch (InvalidArgumentException $e) {
    // A refusal with a reason the person can act on (wrong type, too large).
    docJson(['error' => $e->getMessage()], 400);
} catch (Throwable $e) {
    error_log('documents endpoint error: ' . $e->getMessage());
    docJson(['error' => 'An internal error occurred'], 500);
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------

function docList(int $projectId): void
{
    docRequireProject($projectId);

    docJson([
        'success' => true,
        'data' => ['documents' => array_map([ProjectDocument::class, 'present'], ProjectDocument::forProject($projectId))] + docMeta(),
    ]);
}

/** The labels and upload limits, decided in ProjectDocument. */
function docMeta(): array
{
    return [
        'labels' => ProjectDocument::LABELS,
        'limits' => [
            'max_upload_bytes' => ProjectDocument::maxUploadBytes(),
            'max_upload_label' => ProjectDocument::formatBytes(ProjectDocument::maxUploadBytes()),
            'extensions' => ProjectDocument::extensions(),
        ],
    ];
}

function docDownload(int $id, bool $inline): void
{
    $document = ProjectDocument::find($id);
    if ($document === null) {
        docJson(['error' => 'Document not found'], 404);
    }

    ProjectDocument::send($document, $inline);
}

function docUpload(): void
{
    $projectId = (int) ($_POST['project_id'] ?? 0);
    docRequireProject($projectId);

    $label = ProjectDocument::label($_POST['label'] ?? null);
    if ($label === null) {
        docJson(['error' => 'Choose a label: ' . implode(', ', ProjectDocument::LABELS) . '.'], 400);
    }

    $file = $_FILES['document'] ?? null;
    if (!is_array($file) || is_array($file['name'] ?? null)) {
        docJson(['error' => 'No file uploaded'], 400);
    }

    $document = ProjectDocument::storeUpload($projectId, $label, $file);

    docJson(['success' => true, 'data' => ProjectDocument::present($document)], 201);
}

function docSetLabel(): void
{
    $input = Auth::getJsonInput();
    $document = docRequireDocument($input);

    $label = ProjectDocument::label($input['label'] ?? null);
    if ($label === null) {
        docJson(['error' => 'Choose a label: ' . implode(', ', ProjectDocument::LABELS) . '.'], 400);
    }

    ProjectDocument::setLabel((int) $document['id'], $label);

    docJson(['success' => true, 'data' => ProjectDocument::present(ProjectDocument::find((int) $document['id']) ?? $document)]);
}

function docDelete(): void
{
    ProjectDocument::delete(docRequireDocument(Auth::getJsonInput()));

    docJson(['success' => true]);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function docRequireProject(int $projectId): void
{
    if ($projectId <= 0) {
        docJson(['error' => 'Project ID is required'], 400);
    }

    $stmt = Database::getInstance()->prepare("SELECT 1 FROM projects WHERE id = :id");
    $stmt->execute(['id' => $projectId]);
    if (!$stmt->fetchColumn()) {
        docJson(['error' => 'Project not found'], 404);
    }
}

function docRequireDocument(?array $input): array
{
    if (!is_array($input)) {
        docJson(['error' => 'Invalid JSON input'], 400);
    }

    $document = ProjectDocument::find((int) ($input['id'] ?? 0));
    if ($document === null) {
        docJson(['error' => 'Document not found'], 404);
    }

    return $document;
}

function docJson(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}
