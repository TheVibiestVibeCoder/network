<?php
/**
 * Bookkeeping API Endpoint
 * Handles CSV imports, bookkeeping rows, and PDF (invoice) attachments.
 * Self-contained: creates its own tables and PDF storage directory.
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/vendor/autoload.php';
require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';

use ZipStream\Option\Archive;
use ZipStream\ZipStream;

const BK_PDF_DIR = APP_ROOT . '/data/bookkeeping_pdfs';
const BK_MAX_PDF_SIZE = 25 * 1024 * 1024; // 25 MB

Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

// A POST bigger than post_max_size reaches PHP with $_POST and $_FILES already
// emptied, so the CSRF check below would fail and report a misleading "missing
// token" for what is really an oversized upload. Detect that first.
if ($method === 'POST' && empty($_POST) && empty($_FILES)) {
    $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    $postMax = bkIniBytes((string) ini_get('post_max_size'));
    if ($contentLength > 0 && $postMax > 0 && $contentLength > $postMax) {
        bkJson([
            'error' => 'That upload is larger than the server limit of ' . bkFormatBytes($postMax)
                . '. Please upload fewer files at once, or a smaller file.',
        ], 413);
    }
}

if (in_array($method, ['POST', 'PUT', 'DELETE'], true)) {
    if (!Auth::validateCsrfToken()) {
        http_response_code(403);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Invalid or missing CSRF token']);
        exit;
    }
}

$db = Database::getInstance();
bkEnsureSchema($db);

try {
    if ($method === 'GET') {
        switch ($action) {
            case 'table':
                bkGetTable($db);
                break;
            case 'download-pdf':
                bkDownloadPdf($db, (int) ($_GET['id'] ?? 0));
                break;
            case 'export-pdfs':
                bkExportPdfs($db, (string) ($_GET['ids'] ?? ''));
                break;
            default:
                bkJson(['error' => 'Unknown action'], 400);
        }
    } elseif ($method === 'POST') {
        switch ($action) {
            case 'import':
                bkImport($db);
                break;
            case 'upload-pdf':
                bkUploadPdf($db);
                break;
            case 'upload-pool':
                bkUploadPool($db);
                break;
            case 'assign-pdf':
                bkAssignPdf($db);
                break;
            case 'unassign-pdf':
                bkUnassignPdf($db);
                break;
            case 'delete-rows':
                bkDeleteRows($db);
                break;
            case 'delete-pdfs':
                bkDeletePdfs($db);
                break;
            case 'set-no-pdf':
                bkSetNoPdf($db);
                break;
            default:
                bkJson(['error' => 'Unknown action'], 400);
        }
    } else {
        bkJson(['error' => 'Method not allowed'], 405);
    }
} catch (Exception $e) {
    bkJson(['error' => 'An internal error occurred'], 500);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Converts a php.ini shorthand size ("2M", "512K") to bytes. */
function bkIniBytes(string $value): int
{
    $value = trim($value);
    if ($value === '') {
        return 0;
    }

    $unit = strtolower($value[strlen($value) - 1]);
    $num = (int) $value;

    switch ($unit) {
        case 'g':
            $num *= 1024;
            // no break
        case 'm':
            $num *= 1024;
            // no break
        case 'k':
            $num *= 1024;
    }

    return $num;
}

function bkFormatBytes(int $bytes): string
{
    if ($bytes >= 1048576) {
        return round($bytes / 1048576, 1) . ' MB';
    }
    if ($bytes >= 1024) {
        return round($bytes / 1024) . ' KB';
    }
    return $bytes . ' B';
}

/**
 * The real per-file ceiling: our own cap, but never more than what PHP itself
 * will accept. Without this the app advertises 25 MB while php.ini silently
 * rejects anything over upload_max_filesize (2 MB by default).
 */
function bkMaxUploadBytes(): int
{
    $limits = [BK_MAX_PDF_SIZE];
    foreach (['upload_max_filesize', 'post_max_size'] as $key) {
        $bytes = bkIniBytes((string) ini_get($key));
        if ($bytes > 0) {
            $limits[] = $bytes;
        }
    }
    return min($limits);
}

function bkUploadErrorMessage(int $code): string
{
    switch ($code) {
        case UPLOAD_ERR_INI_SIZE:
        case UPLOAD_ERR_FORM_SIZE:
            return 'File is larger than the server limit of ' . bkFormatBytes(bkMaxUploadBytes()) . '.';
        case UPLOAD_ERR_PARTIAL:
            return 'Upload was interrupted before it finished. Please try again.';
        case UPLOAD_ERR_NO_FILE:
            return 'No file was received.';
        case UPLOAD_ERR_NO_TMP_DIR:
            return 'Server has no temporary upload directory configured.';
        case UPLOAD_ERR_CANT_WRITE:
            return 'Server could not write the uploaded file to disk.';
        case UPLOAD_ERR_EXTENSION:
            return 'A server extension blocked the upload.';
        default:
            return 'Upload failed. Please try again.';
    }
}

function bkJson(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}

function bkReadJsonBody(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw ?: '', true);
    return is_array($data) ? $data : [];
}

function bkEnsureSchema(PDO $db): void
{
    $db->exec("
        CREATE TABLE IF NOT EXISTS bookkeeping_rows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            row_date DATE,
            data TEXT NOT NULL DEFAULT '{}',
            no_pdf_needed INTEGER NOT NULL DEFAULT 0,
            import_batch INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS bookkeeping_columns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name VARCHAR(255) NOT NULL UNIQUE,
            position INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS bookkeeping_pdfs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            row_id INTEGER,
            original_name VARCHAR(255) NOT NULL,
            stored_name VARCHAR(255) NOT NULL,
            file_size INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (row_id) REFERENCES bookkeeping_rows(id) ON DELETE SET NULL
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS bookkeeping_settings (
            key VARCHAR(64) PRIMARY KEY,
            value TEXT
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_bk_pdfs_row ON bookkeeping_pdfs(row_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_bk_rows_date ON bookkeeping_rows(row_date)");

    if (!is_dir(BK_PDF_DIR)) {
        mkdir(BK_PDF_DIR, 0755, true);
    }
    // Block direct web access to stored PDFs (Apache); downloads go through this endpoint.
    $htaccess = BK_PDF_DIR . '/.htaccess';
    if (!file_exists($htaccess)) {
        file_put_contents($htaccess, "Require all denied\n");
    }
}

function bkGetSetting(PDO $db, string $key): ?string
{
    $stmt = $db->prepare("SELECT value FROM bookkeeping_settings WHERE key = :key");
    $stmt->execute(['key' => $key]);
    $value = $stmt->fetchColumn();
    return $value === false ? null : (string) $value;
}

function bkSetSetting(PDO $db, string $key, string $value): void
{
    $stmt = $db->prepare("
        INSERT INTO bookkeeping_settings (key, value) VALUES (:key, :value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    ");
    $stmt->execute(['key' => $key, 'value' => $value]);
}

/**
 * Normalize a raw date string to YYYY-MM-DD, or null if it can't be parsed.
 * Supports YYYY-MM-DD, DD.MM.YYYY, DD/MM/YYYY (day-first preferred) and 2-digit years.
 */
function bkParseDate(?string $raw): ?string
{
    $raw = trim((string) $raw);
    if ($raw === '') {
        return null;
    }

    $y = $m = $d = null;

    if (preg_match('/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/', $raw, $match)) {
        [, $y, $m, $d] = $match;
    } elseif (preg_match('/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/', $raw, $match)) {
        [, $d, $m, $y] = $match;
        // If day-first is impossible but month-first is valid, swap.
        if ((int) $m > 12 && (int) $d <= 12) {
            [$d, $m] = [$m, $d];
        }
        if (strlen($y) === 2) {
            $y = ((int) $y < 70 ? '20' : '19') . $y;
        }
    } else {
        return null;
    }

    $y = (int) $y;
    $m = (int) $m;
    $d = (int) $d;

    if (!checkdate($m, $d, $y)) {
        return null;
    }

    return sprintf('%04d-%02d-%02d', $y, $m, $d);
}

function bkSanitizeFileName(string $name): string
{
    $name = basename(str_replace('\\', '/', $name));
    $name = preg_replace('/[^\w.\- ()\[\]äöüÄÖÜéèàç]/u', '_', $name) ?? 'file.pdf';
    if ($name === '' || $name === '.' || $name === '..') {
        $name = 'file.pdf';
    }
    return mb_substr($name, 0, 200);
}

function bkValidatePdfUpload(array $file): ?string
{
    $error = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($error !== UPLOAD_ERR_OK) {
        return bkUploadErrorMessage($error);
    }
    if (($file['size'] ?? 0) <= 0) {
        return 'File is empty.';
    }
    if ($file['size'] > bkMaxUploadBytes()) {
        return 'File is larger than the server limit of ' . bkFormatBytes(bkMaxUploadBytes()) . '.';
    }
    $ext = strtolower(pathinfo($file['name'] ?? '', PATHINFO_EXTENSION));
    if ($ext !== 'pdf') {
        return 'Only PDF files are allowed.';
    }
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime = $finfo->file($file['tmp_name']);
    if ($mime !== 'application/pdf') {
        return 'The file does not appear to be a valid PDF.';
    }
    return null;
}

function bkStorePdf(PDO $db, array $file, ?int $rowId): array
{
    $originalName = bkSanitizeFileName((string) $file['name']);
    $storedName = date('Ymd_His') . '_' . bin2hex(random_bytes(8)) . '.pdf';
    $target = BK_PDF_DIR . '/' . $storedName;

    if (!move_uploaded_file($file['tmp_name'], $target)) {
        throw new RuntimeException('Failed to store uploaded file');
    }

    $stmt = $db->prepare("
        INSERT INTO bookkeeping_pdfs (row_id, original_name, stored_name, file_size)
        VALUES (:row_id, :original_name, :stored_name, :file_size)
    ");
    $stmt->execute([
        'row_id' => $rowId,
        'original_name' => $originalName,
        'stored_name' => $storedName,
        'file_size' => (int) $file['size'],
    ]);

    return [
        'id' => (int) $db->lastInsertId(),
        'row_id' => $rowId,
        'name' => $originalName,
        'size' => (int) $file['size'],
    ];
}

function bkRowHasPdf(PDO $db, int $rowId): bool
{
    $stmt = $db->prepare("SELECT COUNT(*) FROM bookkeeping_pdfs WHERE row_id = :id");
    $stmt->execute(['id' => $rowId]);
    return (int) $stmt->fetchColumn() > 0;
}

function bkIntList($value): array
{
    if (is_string($value)) {
        $value = explode(',', $value);
    }
    if (!is_array($value)) {
        return [];
    }
    $ids = array_values(array_unique(array_filter(array_map('intval', $value), fn($id) => $id > 0)));
    return $ids;
}

// ----------------------------------------------------------------------------
// GET handlers
// ----------------------------------------------------------------------------

function bkGetTable(PDO $db): void
{
    $columns = $db->query("SELECT id, name, position FROM bookkeeping_columns ORDER BY position, id")
        ->fetchAll();

    $rows = $db->query("
        SELECT r.id, r.row_date, r.data, r.no_pdf_needed, r.import_batch,
               p.id AS pdf_id, p.original_name AS pdf_name, p.file_size AS pdf_size
        FROM bookkeeping_rows r
        LEFT JOIN bookkeeping_pdfs p ON p.row_id = r.id
        ORDER BY (r.row_date IS NULL), r.row_date, r.id
    ")->fetchAll();

    $outRows = [];
    foreach ($rows as $row) {
        $outRows[] = [
            'id' => (int) $row['id'],
            'row_date' => $row['row_date'],
            'data' => json_decode($row['data'], true) ?: [],
            'no_pdf_needed' => (int) $row['no_pdf_needed'] === 1,
            'pdf' => $row['pdf_id'] !== null ? [
                'id' => (int) $row['pdf_id'],
                'name' => $row['pdf_name'],
                'size' => (int) $row['pdf_size'],
            ] : null,
        ];
    }

    $pool = $db->query("
        SELECT id, original_name AS name, file_size AS size, created_at
        FROM bookkeeping_pdfs
        WHERE row_id IS NULL
        ORDER BY created_at DESC, id DESC
    ")->fetchAll();
    foreach ($pool as &$item) {
        $item['id'] = (int) $item['id'];
        $item['size'] = (int) $item['size'];
    }
    unset($item);

    $selection = json_decode(bkGetSetting($db, 'csv_column_selection') ?? '[]', true);

    bkJson([
        'success' => true,
        'data' => [
            'columns' => array_map(fn($c) => ['id' => (int) $c['id'], 'name' => $c['name']], $columns),
            'rows' => $outRows,
            'pool' => $pool,
            'settings' => [
                'selected_columns' => is_array($selection) ? $selection : [],
                'date_column' => bkGetSetting($db, 'csv_date_column'),
            ],
            'limits' => [
                'max_upload_bytes' => bkMaxUploadBytes(),
                'max_upload_label' => bkFormatBytes(bkMaxUploadBytes()),
            ],
        ],
    ]);
}

function bkDownloadPdf(PDO $db, int $id): void
{
    $stmt = $db->prepare("SELECT * FROM bookkeeping_pdfs WHERE id = :id");
    $stmt->execute(['id' => $id]);
    $pdf = $stmt->fetch();

    if (!$pdf || !file_exists(BK_PDF_DIR . '/' . $pdf['stored_name'])) {
        bkJson(['error' => 'PDF not found'], 404);
    }

    $path = BK_PDF_DIR . '/' . $pdf['stored_name'];

    // The global security headers send X-Frame-Options: DENY / frame-ancestors
    // 'none', which block framing even from our own origin and would leave the
    // in-app PDF preview blank. Relax those two - and only those two - to
    // same-origin so the preview iframe can render, while still refusing to be
    // embedded by any other site.
    header('X-Frame-Options: SAMEORIGIN');
    header("Content-Security-Policy: default-src 'none'; object-src 'self'; plugin-types application/pdf; frame-ancestors 'self'");

    header('Content-Type: application/pdf');
    header('Content-Length: ' . filesize($path));
    header('Content-Disposition: inline; filename="' . str_replace('"', '', $pdf['original_name']) . '"');
    header('X-Content-Type-Options: nosniff');
    readfile($path);
    exit;
}

function bkExportPdfs(PDO $db, string $idsParam): void
{
    $rowIds = bkIntList($idsParam);
    if (empty($rowIds)) {
        bkJson(['error' => 'No rows selected'], 400);
    }

    $placeholders = implode(',', array_fill(0, count($rowIds), '?'));
    $stmt = $db->prepare("
        SELECT p.original_name, p.stored_name, r.row_date
        FROM bookkeeping_pdfs p
        JOIN bookkeeping_rows r ON r.id = p.row_id
        WHERE p.row_id IN ($placeholders)
        ORDER BY r.id
    ");
    $stmt->execute($rowIds);
    $pdfs = $stmt->fetchAll();

    if (empty($pdfs)) {
        bkJson(['error' => 'None of the selected rows has a PDF attached'], 404);
    }

    $options = new Archive();
    $options->setSendHttpHeaders(true);
    $zip = new ZipStream('bookkeeping_pdfs_' . date('Y-m-d') . '.zip', $options);

    $usedNames = [];
    foreach ($pdfs as $pdf) {
        $path = BK_PDF_DIR . '/' . $pdf['stored_name'];
        if (!file_exists($path)) {
            continue;
        }
        $name = $pdf['original_name'];
        if (isset($usedNames[$name])) {
            $usedNames[$name]++;
            $base = pathinfo($name, PATHINFO_FILENAME);
            $name = $base . ' (' . $usedNames[$name] . ').pdf';
        } else {
            $usedNames[$name] = 1;
        }
        $zip->addFileFromPath($name, $path);
    }

    $zip->finish();
    exit;
}

// ----------------------------------------------------------------------------
// POST handlers
// ----------------------------------------------------------------------------

function bkImport(PDO $db): void
{
    $body = bkReadJsonBody();

    $columns = $body['columns'] ?? [];
    $dateColumn = trim((string) ($body['date_column'] ?? ''));
    $rows = $body['rows'] ?? [];

    if (!is_array($columns) || empty($columns) || !is_array($rows)) {
        bkJson(['error' => 'Invalid import payload'], 400);
    }

    $columns = array_values(array_filter(array_map(
        fn($c) => mb_substr(trim((string) $c), 0, 255),
        $columns
    ), fn($c) => $c !== ''));

    if (empty($columns)) {
        bkJson(['error' => 'No columns selected'], 400);
    }
    if ($dateColumn === '' || !in_array($dateColumn, $columns, true)) {
        bkJson(['error' => 'A date column must be selected and included in the import'], 400);
    }

    $db->beginTransaction();
    try {
        // Register any new columns at the end; existing columns are never modified.
        $existing = $db->query("SELECT name, position FROM bookkeeping_columns")->fetchAll();
        $existingNames = array_column($existing, 'name');
        $maxPosition = 0;
        foreach ($existing as $col) {
            $maxPosition = max($maxPosition, (int) $col['position']);
        }
        $insertCol = $db->prepare("INSERT INTO bookkeeping_columns (name, position) VALUES (:name, :position)");
        $newColumns = 0;
        foreach ($columns as $columnName) {
            if (!in_array($columnName, $existingNames, true)) {
                $maxPosition++;
                $insertCol->execute(['name' => $columnName, 'position' => $maxPosition]);
                $newColumns++;
            }
        }

        // Remember this selection for the next import.
        bkSetSetting($db, 'csv_column_selection', json_encode($columns));
        bkSetSetting($db, 'csv_date_column', $dateColumn);

        $batch = (int) $db->query("SELECT COALESCE(MAX(import_batch), 0) + 1 FROM bookkeeping_rows")->fetchColumn();

        // Build clean row payloads restricted to the selected columns.
        $cleanRows = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $data = [];
            $hasValue = false;
            foreach ($columns as $columnName) {
                $value = isset($row[$columnName]) ? trim((string) $row[$columnName]) : '';
                $data[$columnName] = $value;
                if ($value !== '') {
                    $hasValue = true;
                }
            }
            if (!$hasValue) {
                continue;
            }
            $cleanRows[] = [
                'data' => $data,
                'row_date' => bkParseDate($data[$dateColumn] ?? null),
            ];
        }

        // New rows are appended after existing entries, chronologically within the import.
        usort($cleanRows, function ($a, $b) {
            return strcmp($a['row_date'] ?? '9999-12-31', $b['row_date'] ?? '9999-12-31');
        });

        $insertRow = $db->prepare("
            INSERT INTO bookkeeping_rows (row_date, data, import_batch)
            VALUES (:row_date, :data, :import_batch)
        ");
        foreach ($cleanRows as $row) {
            $insertRow->execute([
                'row_date' => $row['row_date'],
                'data' => json_encode($row['data']),
                'import_batch' => $batch,
            ]);
        }

        $db->commit();

        bkJson([
            'success' => true,
            'imported' => count($cleanRows),
            'new_columns' => $newColumns,
        ]);
    } catch (Exception $e) {
        $db->rollBack();
        throw $e;
    }
}

function bkUploadPdf(PDO $db): void
{
    $rowId = (int) ($_POST['row_id'] ?? 0);
    if ($rowId <= 0) {
        bkJson(['error' => 'Missing row'], 400);
    }

    $stmt = $db->prepare("SELECT id FROM bookkeeping_rows WHERE id = :id");
    $stmt->execute(['id' => $rowId]);
    if (!$stmt->fetch()) {
        bkJson(['error' => 'Row not found'], 404);
    }

    if (bkRowHasPdf($db, $rowId)) {
        bkJson(['error' => 'This row already has a PDF assigned. Remove it first.'], 409);
    }

    $file = $_FILES['pdf'] ?? null;
    if (!$file) {
        bkJson(['error' => 'No file uploaded'], 400);
    }
    $error = bkValidatePdfUpload($file);
    if ($error !== null) {
        bkJson(['error' => $error], 400);
    }

    $pdf = bkStorePdf($db, $file, $rowId);
    bkJson(['success' => true, 'pdf' => $pdf]);
}

function bkUploadPool(PDO $db): void
{
    if (empty($_FILES['pdfs'])) {
        bkJson(['error' => 'No files uploaded'], 400);
    }

    // Normalize to a list of file arrays (supports single and multiple uploads).
    $files = [];
    if (is_array($_FILES['pdfs']['name'])) {
        foreach ($_FILES['pdfs']['name'] as $index => $name) {
            $files[] = [
                'name' => $name,
                'type' => $_FILES['pdfs']['type'][$index],
                'tmp_name' => $_FILES['pdfs']['tmp_name'][$index],
                'error' => $_FILES['pdfs']['error'][$index],
                'size' => $_FILES['pdfs']['size'][$index],
            ];
        }
    } else {
        $files[] = $_FILES['pdfs'];
    }

    $uploaded = [];
    $errors = [];
    foreach ($files as $file) {
        $error = bkValidatePdfUpload($file);
        if ($error !== null) {
            $errors[] = ($file['name'] ?? 'file') . ': ' . $error;
            continue;
        }
        $uploaded[] = bkStorePdf($db, $file, null);
    }

    bkJson(['success' => true, 'uploaded' => $uploaded, 'errors' => $errors]);
}

function bkAssignPdf(PDO $db): void
{
    $body = bkReadJsonBody();
    $pdfId = (int) ($body['pdf_id'] ?? 0);
    $rowId = (int) ($body['row_id'] ?? 0);

    if ($pdfId <= 0 || $rowId <= 0) {
        bkJson(['error' => 'Missing PDF or row'], 400);
    }

    $stmt = $db->prepare("SELECT id, row_id FROM bookkeeping_pdfs WHERE id = :id");
    $stmt->execute(['id' => $pdfId]);
    $pdf = $stmt->fetch();
    if (!$pdf) {
        bkJson(['error' => 'PDF not found'], 404);
    }

    $stmt = $db->prepare("SELECT id FROM bookkeeping_rows WHERE id = :id");
    $stmt->execute(['id' => $rowId]);
    if (!$stmt->fetch()) {
        bkJson(['error' => 'Row not found'], 404);
    }

    if (bkRowHasPdf($db, $rowId)) {
        bkJson(['error' => 'This row already has a PDF assigned. Remove it first.'], 409);
    }

    $stmt = $db->prepare("UPDATE bookkeeping_pdfs SET row_id = :row_id WHERE id = :id");
    $stmt->execute(['row_id' => $rowId, 'id' => $pdfId]);

    bkJson(['success' => true]);
}

function bkUnassignPdf(PDO $db): void
{
    $body = bkReadJsonBody();
    $pdfId = (int) ($body['pdf_id'] ?? 0);
    if ($pdfId <= 0) {
        bkJson(['error' => 'Missing PDF'], 400);
    }

    $stmt = $db->prepare("UPDATE bookkeeping_pdfs SET row_id = NULL WHERE id = :id");
    $stmt->execute(['id' => $pdfId]);

    bkJson(['success' => true]);
}

function bkDeleteRows(PDO $db): void
{
    $body = bkReadJsonBody();
    $ids = bkIntList($body['ids'] ?? []);
    $deletePdfsToo = !empty($body['delete_pdfs']);
    if (empty($ids)) {
        bkJson(['error' => 'No rows selected'], 400);
    }

    $placeholders = implode(',', array_fill(0, count($ids), '?'));

    $deletedPdfCount = 0;
    if ($deletePdfsToo) {
        $stmt = $db->prepare("SELECT id, stored_name FROM bookkeeping_pdfs WHERE row_id IN ($placeholders)");
        $stmt->execute($ids);
        $pdfs = $stmt->fetchAll();

        if (!empty($pdfs)) {
            foreach ($pdfs as $pdf) {
                $path = BK_PDF_DIR . '/' . $pdf['stored_name'];
                if (file_exists($path)) {
                    unlink($path);
                }
            }
            $pdfIds = array_column($pdfs, 'id');
            $pdfPlaceholders = implode(',', array_fill(0, count($pdfIds), '?'));
            $delStmt = $db->prepare("DELETE FROM bookkeeping_pdfs WHERE id IN ($pdfPlaceholders)");
            $delStmt->execute($pdfIds);
            $deletedPdfCount = count($pdfIds);
        }
    }

    // Any PDFs still attached at this point (delete_pdfs was false) are kept
    // and moved back to the drop zone (row_id set NULL via FK ON DELETE SET NULL).
    $stmt = $db->prepare("DELETE FROM bookkeeping_rows WHERE id IN ($placeholders)");
    $stmt->execute($ids);
    $deleted = $stmt->rowCount();

    $removedColumns = bkPruneEmptyColumns($db);

    bkJson([
        'success' => true,
        'deleted' => $deleted,
        'removed_columns' => $removedColumns,
        'deleted_pdfs' => $deletedPdfCount,
    ]);
}

/**
 * Removes any column definition that no remaining row has a non-empty
 * value for. Called after a row deletion, so a column whose only data
 * lived in the deleted row(s) disappears along with it; if every row is
 * gone, every column is gone too.
 */
function bkPruneEmptyColumns(PDO $db): int
{
    $columns = $db->query("SELECT id, name FROM bookkeeping_columns")->fetchAll();
    if (empty($columns)) {
        return 0;
    }

    $usedColumns = [];
    $rows = $db->query("SELECT data FROM bookkeeping_rows")->fetchAll(PDO::FETCH_COLUMN);
    foreach ($rows as $json) {
        $data = json_decode($json, true);
        if (!is_array($data)) {
            continue;
        }
        foreach ($data as $key => $value) {
            if (trim((string) $value) !== '') {
                $usedColumns[$key] = true;
            }
        }
    }

    $toDelete = [];
    foreach ($columns as $col) {
        if (!isset($usedColumns[$col['name']])) {
            $toDelete[] = (int) $col['id'];
        }
    }

    if (empty($toDelete)) {
        return 0;
    }

    $placeholders = implode(',', array_fill(0, count($toDelete), '?'));
    $stmt = $db->prepare("DELETE FROM bookkeeping_columns WHERE id IN ($placeholders)");
    $stmt->execute($toDelete);

    return count($toDelete);
}

function bkDeletePdfs(PDO $db): void
{
    $body = bkReadJsonBody();
    $ids = bkIntList($body['ids'] ?? []);
    if (empty($ids)) {
        bkJson(['error' => 'No PDFs selected'], 400);
    }

    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $db->prepare("SELECT id, stored_name FROM bookkeeping_pdfs WHERE id IN ($placeholders)");
    $stmt->execute($ids);
    $pdfs = $stmt->fetchAll();

    foreach ($pdfs as $pdf) {
        $path = BK_PDF_DIR . '/' . $pdf['stored_name'];
        if (file_exists($path)) {
            unlink($path);
        }
    }

    $stmt = $db->prepare("DELETE FROM bookkeeping_pdfs WHERE id IN ($placeholders)");
    $stmt->execute($ids);

    bkJson(['success' => true, 'deleted' => $stmt->rowCount()]);
}

function bkSetNoPdf(PDO $db): void
{
    $body = bkReadJsonBody();
    $ids = bkIntList($body['ids'] ?? []);
    $value = !empty($body['value']) ? 1 : 0;

    if (empty($ids)) {
        bkJson(['error' => 'No rows selected'], 400);
    }

    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $db->prepare("UPDATE bookkeeping_rows SET no_pdf_needed = ? WHERE id IN ($placeholders)");
    $stmt->execute(array_merge([$value], $ids));

    bkJson(['success' => true]);
}
