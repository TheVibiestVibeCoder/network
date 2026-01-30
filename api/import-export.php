<?php
/**
 * Import/Export API Endpoint
 * Handles Excel import and export of contacts
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/vendor/autoload.php';
require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Contact.php';

use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx;
use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Style\Fill;
use PhpOffice\PhpSpreadsheet\Style\Font;
use PhpOffice\PhpSpreadsheet\Style\Alignment;
use PhpOffice\PhpSpreadsheet\Style\Border;

// Send security headers
Auth::sendSecurityHeaders();

// Check authentication
if (!Auth::isAuthenticated()) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

// Require CSRF token for import (state-changing POST)
if ($action === 'import' && $method === 'POST') {
    // CSRF token is in the POST form data or header for multipart requests
    $csrfValid = false;
    $sessionToken = $_SESSION[CSRF_TOKEN_NAME] ?? '';
    $headerToken = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    $postToken = $_POST[CSRF_TOKEN_NAME] ?? '';

    if (!empty($sessionToken)) {
        if ((!empty($headerToken) && hash_equals($sessionToken, $headerToken)) ||
            (!empty($postToken) && hash_equals($sessionToken, $postToken))) {
            $csrfValid = true;
        }
    }

    if (!$csrfValid) {
        http_response_code(403);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Invalid or missing CSRF token']);
        exit;
    }
}

try {
    switch ($action) {
        case 'export':
            handleExport();
            break;

        case 'import':
            handleImport();
            break;

        case 'template':
            handleTemplate();
            break;

        default:
            http_response_code(400);
            header('Content-Type: application/json');
            echo json_encode(['error' => 'Invalid action. Use: export, import, or template']);
    }
} catch (Exception $e) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'An internal error occurred']);
}

/**
 * Export all contacts to Excel file
 */
function handleExport(): void
{
    $contactModel = new Contact();
    $contacts = $contactModel->exportAll();

    $spreadsheet = new Spreadsheet();
    $sheet = $spreadsheet->getActiveSheet();
    $sheet->setTitle('Contacts');

    // Define headers
    $headers = ['Name', 'Company', 'Location', 'Email', 'Phone', 'Website', 'Address', 'Note'];

    // Style for header row
    $headerStyle = [
        'font' => [
            'bold' => true,
            'color' => ['rgb' => 'FFFFFF'],
        ],
        'fill' => [
            'fillType' => Fill::FILL_SOLID,
            'startColor' => ['rgb' => '3B82F6'],
        ],
        'alignment' => [
            'horizontal' => Alignment::HORIZONTAL_CENTER,
            'vertical' => Alignment::VERTICAL_CENTER,
        ],
        'borders' => [
            'allBorders' => [
                'borderStyle' => Border::BORDER_THIN,
            ],
        ],
    ];

    // Write headers
    foreach ($headers as $colIndex => $header) {
        $cell = $sheet->getCellByColumnAndRow($colIndex + 1, 1);
        $cell->setValue($header);
    }
    $sheet->getStyle('A1:H1')->applyFromArray($headerStyle);
    $sheet->getRowDimension(1)->setRowHeight(25);

    // Write data
    $row = 2;
    foreach ($contacts as $contact) {
        $sheet->setCellValue('A' . $row, $contact['name'] ?? '');
        $sheet->setCellValue('B' . $row, $contact['company'] ?? '');
        $sheet->setCellValue('C' . $row, $contact['location'] ?? '');
        $sheet->setCellValue('D' . $row, $contact['email'] ?? '');
        $sheet->setCellValue('E' . $row, $contact['phone'] ?? '');
        $sheet->setCellValue('F' . $row, $contact['website'] ?? '');
        $sheet->setCellValue('G' . $row, $contact['address'] ?? '');
        $sheet->setCellValue('H' . $row, $contact['note'] ?? '');
        $row++;
    }

    // Auto-size columns
    foreach (range('A', 'H') as $col) {
        $sheet->getColumnDimension($col)->setAutoSize(true);
    }

    // Set minimum column widths
    $sheet->getColumnDimension('A')->setWidth(20);
    $sheet->getColumnDimension('B')->setWidth(20);
    $sheet->getColumnDimension('C')->setWidth(25);
    $sheet->getColumnDimension('D')->setWidth(25);
    $sheet->getColumnDimension('G')->setWidth(30);
    $sheet->getColumnDimension('H')->setWidth(40);

    // Generate filename with date
    $filename = 'contacts_export_' . date('Y-m-d_His') . '.xlsx';

    // Output file
    header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Cache-Control: max-age=0');

    $writer = new Xlsx($spreadsheet);
    $writer->save('php://output');
    exit;
}

/**
 * Import contacts from uploaded Excel file
 */
function handleImport(): void
{
    header('Content-Type: application/json');

    // Check if file was uploaded
    if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
        $errorMessages = [
            UPLOAD_ERR_INI_SIZE => 'File too large (exceeds server limit)',
            UPLOAD_ERR_FORM_SIZE => 'File too large (exceeds form limit)',
            UPLOAD_ERR_PARTIAL => 'File was only partially uploaded',
            UPLOAD_ERR_NO_FILE => 'No file was uploaded',
            UPLOAD_ERR_NO_TMP_DIR => 'Missing temporary folder',
            UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk',
        ];

        $errorCode = $_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE;
        $errorMessage = $errorMessages[$errorCode] ?? 'Unknown upload error';

        http_response_code(400);
        echo json_encode(['error' => $errorMessage]);
        return;
    }

    $file = $_FILES['file'];

    // Validate file size (max 10MB)
    $maxFileSize = 10 * 1024 * 1024;
    if ($file['size'] > $maxFileSize) {
        http_response_code(400);
        echo json_encode(['error' => 'File too large. Maximum size is 10MB.']);
        return;
    }

    $extension = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    // Validate file type
    $allowedExtensions = ['xlsx', 'xls'];
    if (!in_array($extension, $allowedExtensions)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid file type. Please upload an Excel file (.xlsx or .xls)']);
        return;
    }

    try {
        // Load the spreadsheet
        $spreadsheet = IOFactory::load($file['tmp_name']);
        $sheet = $spreadsheet->getActiveSheet();
        $rows = $sheet->toArray();

        // Check if file has data
        if (count($rows) < 2) {
            http_response_code(400);
            echo json_encode(['error' => 'Excel file is empty or contains only headers']);
            return;
        }

        // Get headers from first row
        $headers = array_map('strtolower', array_map('trim', $rows[0]));

        // Map headers to contact fields
        $fieldMapping = [
            'name' => ['name', 'namen', 'kontaktname', 'contact name', 'full name', 'fullname', 'vor- und nachname'],
            'company' => ['company', 'firma', 'unternehmen', 'organisation', 'organization', 'firmenname', 'company name'],
            'location' => ['location', 'ort', 'standort', 'city', 'stadt', 'place'],
            'email' => ['email', 'e-mail', 'mail', 'emailadresse', 'email address', 'e-mail-adresse'],
            'phone' => ['phone', 'telefon', 'tel', 'telephone', 'telefonnummer', 'phone number', 'handy', 'mobile'],
            'website' => ['website', 'webseite', 'web', 'url', 'homepage', 'internetseite'],
            'address' => ['address', 'adresse', 'anschrift', 'full address', 'street', 'strasse', 'straße'],
            'note' => ['note', 'notiz', 'notes', 'notizen', 'bemerkung', 'bemerkungen', 'comment', 'comments', 'kommentar'],
        ];

        // Find column indices for each field
        $columnMap = [];
        foreach ($fieldMapping as $field => $possibleNames) {
            foreach ($headers as $colIndex => $header) {
                if (in_array($header, $possibleNames)) {
                    $columnMap[$field] = $colIndex;
                    break;
                }
            }
        }

        // Check if name column exists
        if (!isset($columnMap['name'])) {
            http_response_code(400);
            echo json_encode([
                'error' => 'Could not find a "Name" column in the Excel file. Please ensure the first row contains column headers including "Name".',
                'found_headers' => $headers
            ]);
            return;
        }

        // Parse contacts from rows (skip header row)
        $contacts = [];
        for ($i = 1; $i < count($rows); $i++) {
            $row = $rows[$i];

            // Skip completely empty rows
            $rowValues = array_filter($row, function($val) {
                return $val !== null && $val !== '';
            });
            if (empty($rowValues)) {
                continue;
            }

            $contact = [];
            foreach ($columnMap as $field => $colIndex) {
                $value = $row[$colIndex] ?? null;
                // Convert to string and trim, handle empty values
                $contact[$field] = ($value !== null && $value !== '') ? trim((string) $value) : null;
            }

            // Only add if name is not empty
            if (!empty($contact['name'])) {
                $contacts[] = $contact;
            }
        }

        if (empty($contacts)) {
            http_response_code(400);
            echo json_encode(['error' => 'No valid contacts found in the file. Ensure at least one row has a name.']);
            return;
        }

        // Normalize website URLs
        foreach ($contacts as &$contact) {
            if (!empty($contact['website'])) {
                $contact['website'] = Contact::normalizeWebsite($contact['website']);
            }
        }
        unset($contact);

        // Import contacts
        $contactModel = new Contact();
        $result = $contactModel->bulkCreate($contacts);

        // Geocode locations for successfully created contacts (in background, limit rate)
        geocodeImportedContacts($result['created_ids']);

        echo json_encode([
            'success' => true,
            'imported' => $result['success_count'],
            'errors' => $result['errors'],
            'total_rows' => count($contacts)
        ]);

    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Error processing Excel file: ' . $e->getMessage()]);
    }
}

/**
 * Generate and download an empty template Excel file
 */
function handleTemplate(): void
{
    $spreadsheet = new Spreadsheet();
    $sheet = $spreadsheet->getActiveSheet();
    $sheet->setTitle('Contact Template');

    // Define headers
    $headers = ['Name', 'Company', 'Location', 'Email', 'Phone', 'Website', 'Address', 'Note'];

    // Style for header row
    $headerStyle = [
        'font' => [
            'bold' => true,
            'color' => ['rgb' => 'FFFFFF'],
        ],
        'fill' => [
            'fillType' => Fill::FILL_SOLID,
            'startColor' => ['rgb' => '3B82F6'],
        ],
        'alignment' => [
            'horizontal' => Alignment::HORIZONTAL_CENTER,
            'vertical' => Alignment::VERTICAL_CENTER,
        ],
        'borders' => [
            'allBorders' => [
                'borderStyle' => Border::BORDER_THIN,
            ],
        ],
    ];

    // Write headers
    foreach ($headers as $colIndex => $header) {
        $cell = $sheet->getCellByColumnAndRow($colIndex + 1, 1);
        $cell->setValue($header);
    }
    $sheet->getStyle('A1:H1')->applyFromArray($headerStyle);
    $sheet->getRowDimension(1)->setRowHeight(25);

    // Add example row
    $sheet->setCellValue('A2', 'Max Mustermann');
    $sheet->setCellValue('B2', 'Example GmbH');
    $sheet->setCellValue('C2', 'Berlin, Germany');
    $sheet->setCellValue('D2', 'max@example.com');
    $sheet->setCellValue('E2', '+49 123 456789');
    $sheet->setCellValue('F2', 'https://example.com');
    $sheet->setCellValue('G2', 'Musterstraße 1, 10115 Berlin');
    $sheet->setCellValue('H2', 'Important contact');

    // Style example row as italic/gray
    $sheet->getStyle('A2:H2')->applyFromArray([
        'font' => [
            'italic' => true,
            'color' => ['rgb' => '6B7280'],
        ],
    ]);

    // Set column widths
    $sheet->getColumnDimension('A')->setWidth(25);
    $sheet->getColumnDimension('B')->setWidth(25);
    $sheet->getColumnDimension('C')->setWidth(25);
    $sheet->getColumnDimension('D')->setWidth(30);
    $sheet->getColumnDimension('E')->setWidth(20);
    $sheet->getColumnDimension('F')->setWidth(30);
    $sheet->getColumnDimension('G')->setWidth(35);
    $sheet->getColumnDimension('H')->setWidth(40);

    // Add instructions sheet
    $instructionSheet = $spreadsheet->createSheet();
    $instructionSheet->setTitle('Instructions');

    $instructions = [
        ['Excel Import Instructions'],
        [''],
        ['Required Columns:'],
        ['- Name: Contact name (REQUIRED - contacts without name will be skipped)'],
        [''],
        ['Optional Columns:'],
        ['- Company: Company or organization name'],
        ['- Location: City, address, or place (will be shown on map if geocodable)'],
        ['- Email: Email address'],
        ['- Phone: Phone number'],
        ['- Website: Website URL'],
        ['- Address: Full postal address'],
        ['- Note: Additional notes or comments'],
        [''],
        ['Tips:'],
        ['- The first row must contain column headers'],
        ['- Column order does not matter - headers are matched by name'],
        ['- Empty cells are allowed and will be ignored'],
        ['- Empty rows will be skipped'],
        ['- German column names are also supported (e.g., Firma, Telefon, Notiz)'],
        ['- Delete this example row before importing your data!'],
    ];

    foreach ($instructions as $rowIndex => $row) {
        $instructionSheet->setCellValue('A' . ($rowIndex + 1), $row[0] ?? '');
    }

    // Style instructions
    $instructionSheet->getStyle('A1')->applyFromArray([
        'font' => ['bold' => true, 'size' => 14],
    ]);
    $instructionSheet->getStyle('A3')->applyFromArray([
        'font' => ['bold' => true],
    ]);
    $instructionSheet->getStyle('A6')->applyFromArray([
        'font' => ['bold' => true],
    ]);
    $instructionSheet->getStyle('A15')->applyFromArray([
        'font' => ['bold' => true],
    ]);
    $instructionSheet->getColumnDimension('A')->setWidth(80);

    // Set active sheet back to template
    $spreadsheet->setActiveSheetIndex(0);

    // Output file
    header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    header('Content-Disposition: attachment; filename="contacts_template.xlsx"');
    header('Cache-Control: max-age=0');

    $writer = new Xlsx($spreadsheet);
    $writer->save('php://output');
    exit;
}

/**
 * Geocode locations for imported contacts (limited to avoid rate limiting)
 */
function geocodeImportedContacts(array $contactIds): void
{
    if (empty($contactIds)) {
        return;
    }

    // Allow enough time for geocoding
    set_time_limit(300);

    $contactModel = new Contact();
    $db = Database::getInstance();

    // Geocode up to 50 contacts to avoid excessive rate limiting
    // Others will be geocoded when edited
    $idsToGeocode = array_slice($contactIds, 0, 50);

    foreach ($idsToGeocode as $id) {
        $contact = $contactModel->getById($id);

        $locationToGeocode = !empty($contact['location']) ? $contact['location'] : (!empty($contact['address']) ? $contact['address'] : null);
        if ($contact && $locationToGeocode && empty($contact['latitude'])) {
            $coords = geocodeLocation($locationToGeocode);

            if ($coords) {
                $stmt = $db->prepare("UPDATE contacts SET latitude = :lat, longitude = :lng WHERE id = :id");
                $stmt->execute([
                    'lat' => $coords['lat'],
                    'lng' => $coords['lng'],
                    'id' => $id
                ]);
            }

            // Rate limit: wait 1 second between requests
            usleep(1000000);
        }
    }
}

/**
 * Geocode a location string to coordinates
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
