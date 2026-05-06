<?php
define('APP_ROOT', __DIR__);
require_once 'config/config.php';
require_once 'includes/database.php';
require_once 'includes/auth.php';
require_once 'includes/Contact.php';

echo "<b>1. Contacts table columns:</b><br>";
$db = Database::getInstance();
$cols = $db->query('PRAGMA table_info(contacts)')->fetchAll(PDO::FETCH_ASSOC);
foreach ($cols as $c) {
    echo htmlspecialchars($c['name']) . "<br>";
}

echo "<br><b>2. Contact::create() test:</b><br>";
try {
    $model = new Contact();
    $id = $model->create([
        'name' => '__check_test__', 'company' => null, 'location' => null,
        'latitude' => null, 'longitude' => null, 'note' => null,
        'email' => null, 'phone' => null, 'website' => null, 'address' => null,
    ]);
    $model->delete($id);
    echo "OK (id=$id, deleted)<br>";
} catch (Exception $e) {
    echo "<b style='color:red'>ERROR: " . htmlspecialchars($e->getMessage()) . "</b><br>";
}

echo "<br><b>3. Auth::sanitizeContactInput() keys returned by server:</b><br>";
try {
    $sanitized = Auth::sanitizeContactInput([
        'name' => 'Test', 'company' => '', 'location' => '', 'email' => '',
        'phone' => '', 'website' => '', 'address' => '', 'note' => '',
    ]);
    echo implode(', ', array_keys($sanitized)) . "<br>";
} catch (Exception $e) {
    echo "<b style='color:red'>ERROR: " . htmlspecialchars($e->getMessage()) . "</b><br>";
}

echo "<br><b>4. Simulate full handlePost() flow (no geocode, no CSRF):</b><br>";
try {
    $input = Auth::sanitizeContactInput([
        'name' => '__check_post_test__', 'company' => '', 'location' => '',
        'email' => '', 'phone' => '', 'website' => '', 'address' => '', 'note' => '',
    ]);

    if (empty($input['name'])) throw new Exception('name empty after sanitize');

    $model = new Contact();
    $id = $model->create($input);
    $contact = $model->getById($id);

    // Simulate logContactActivityEvent
    $stmt = $db->prepare("
        INSERT INTO activity_events (entry_type, action, content, contact_id, contact_name, contact_company)
        VALUES ('contact_activity', 'created', 'Kontakt erstellt', :cid, :cname, :ccompany)
    ");
    $stmt->execute([
        'cid'      => $id,
        'cname'    => $contact['name'] ?? '',
        'ccompany' => $contact['company'] ?? null,
    ]);

    $model->delete($id);
    echo "OK - full flow succeeded (id=$id, cleaned up)<br>";
} catch (Exception $e) {
    echo "<b style='color:red'>ERROR: " . htmlspecialchars($e->getMessage()) . "</b><br>";
}

echo "<br><b>5. contacts.php file exists on server:</b><br>";
$apiFile = APP_ROOT . '/api/contacts.php';
echo file_exists($apiFile) ? "YES - " . htmlspecialchars($apiFile) : "NOT FOUND";

echo "<br><br><b>6. Server's contacts.php handlePost first 60 lines:</b><br><pre>";
if (file_exists($apiFile)) {
    $lines = file($apiFile);
    $inPost = false;
    $printed = 0;
    foreach ($lines as $i => $line) {
        if (strpos($line, 'function handlePost') !== false) $inPost = true;
        if ($inPost) {
            echo htmlspecialchars($line);
            $printed++;
            if ($printed >= 60) break;
        }
    }
}
echo "</pre>";
