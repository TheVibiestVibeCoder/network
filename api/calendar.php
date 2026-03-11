<?php
/**
 * Calendar API Endpoint
 * Returns a unified activity stream (notes, to-dos, and entity activity events).
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';

header('Content-Type: application/json');
Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

$db = Database::getInstance();

try {
    $start = normalizeDateTimeFilter($_GET['start'] ?? null);
    $end = normalizeDateTimeFilter($_GET['end'] ?? null);
    $tagId = isset($_GET['tag_id']) ? (int) $_GET['tag_id'] : null;
    $search = Auth::sanitizeString(trim((string) ($_GET['search'] ?? '')), 255) ?? '';

    if ($tagId !== null && $tagId <= 0) {
        $tagId = null;
    }

    $entries = array_merge(
        fetchEntityActivityEntries($db, $start, $end, $search, $tagId),
        fetchContactNoteEntries($db, $start, $end, $search, $tagId),
        fetchProjectNoteEntries($db, $start, $end, $search, $tagId),
        fetchTodoEntries($db, $start, $end, $search, $tagId)
    );

    usort($entries, static function (array $a, array $b): int {
        return strcmp((string) ($b['created_at'] ?? ''), (string) ($a['created_at'] ?? ''));
    });

    attachEntryTags($db, $entries);

    echo json_encode(['success' => true, 'data' => $entries]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => 'An internal error occurred']);
}

function normalizeDateTimeFilter($value): ?string
{
    if ($value === null) {
        return null;
    }

    if (!is_string($value)) {
        return null;
    }

    $value = trim($value);
    return $value !== '' ? $value : null;
}

function fetchEntityActivityEntries(PDO $db, ?string $start, ?string $end, string $search, ?int $tagId): array
{
    $conditions = ["a.entry_type IN ('contact_activity', 'project_activity')"];
    $params = [];

    if ($start !== null) {
        $conditions[] = 'a.created_at >= ?';
        $params[] = $start;
    }

    if ($end !== null) {
        $conditions[] = 'a.created_at <= ?';
        $params[] = $end;
    }

    if ($search !== '') {
        $conditions[] = '(
            a.content LIKE ?
            OR a.contact_name LIKE ?
            OR a.contact_company LIKE ?
            OR a.project_name LIKE ?
            OR a.project_company LIKE ?
        )';
        $searchParam = '%' . $search . '%';
        $params[] = $searchParam;
        $params[] = $searchParam;
        $params[] = $searchParam;
        $params[] = $searchParam;
        $params[] = $searchParam;
    }

    if ($tagId !== null) {
        $conditions[] = '(
            (a.contact_id IS NOT NULL AND EXISTS (
                SELECT 1
                FROM contact_tags ct
                WHERE ct.contact_id = a.contact_id AND ct.tag_id = ?
            ))
            OR
            (a.project_id IS NOT NULL AND (
                EXISTS (
                    SELECT 1
                    FROM project_tags pt
                    WHERE pt.project_id = a.project_id AND pt.tag_id = ?
                )
                OR EXISTS (
                    SELECT 1
                    FROM project_contacts pc
                    JOIN contact_tags ct ON ct.contact_id = pc.contact_id
                    WHERE pc.project_id = a.project_id AND ct.tag_id = ?
                )
            ))
        )';
        $params[] = $tagId;
        $params[] = $tagId;
        $params[] = $tagId;
    }

    $where = 'WHERE ' . implode(' AND ', $conditions);
    $sql = "
        SELECT
            a.id,
            a.entry_type,
            a.created_at,
            a.content,
            NULL AS title,
            NULL AS description,
            NULL AS due_date,
            NULL AS is_completed,
            a.contact_id,
            a.contact_name,
            a.contact_company,
            a.project_id,
            a.project_name,
            a.project_company,
            a.action AS activity_action
        FROM activity_events a
        {$where}
    ";

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function fetchContactNoteEntries(PDO $db, ?string $start, ?string $end, string $search, ?int $tagId): array
{
    $conditions = [];
    $params = [];

    if ($start !== null) {
        $conditions[] = 'n.created_at >= ?';
        $params[] = $start;
    }

    if ($end !== null) {
        $conditions[] = 'n.created_at <= ?';
        $params[] = $end;
    }

    if ($search !== '') {
        $conditions[] = '(c.name LIKE ? OR c.company LIKE ? OR n.content LIKE ?)';
        $searchParam = '%' . $search . '%';
        $params[] = $searchParam;
        $params[] = $searchParam;
        $params[] = $searchParam;
    }

    if ($tagId !== null) {
        $conditions[] = 'EXISTS (
            SELECT 1
            FROM contact_tags ct
            WHERE ct.contact_id = n.contact_id AND ct.tag_id = ?
        )';
        $params[] = $tagId;
    }

    $where = !empty($conditions) ? 'WHERE ' . implode(' AND ', $conditions) : '';

    $sql = "
        SELECT
            n.id,
            'contact_note' AS entry_type,
            n.created_at,
            n.content,
            NULL AS title,
            NULL AS description,
            NULL AS due_date,
            NULL AS is_completed,
            n.contact_id,
            c.name AS contact_name,
            c.company AS contact_company,
            NULL AS project_id,
            NULL AS project_name,
            NULL AS project_company
        FROM notes n
        JOIN contacts c ON c.id = n.contact_id
        {$where}
    ";

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function fetchProjectNoteEntries(PDO $db, ?string $start, ?string $end, string $search, ?int $tagId): array
{
    $conditions = [];
    $params = [];

    if ($start !== null) {
        $conditions[] = 'pn.created_at >= ?';
        $params[] = $start;
    }

    if ($end !== null) {
        $conditions[] = 'pn.created_at <= ?';
        $params[] = $end;
    }

    if ($search !== '') {
        $conditions[] = '(p.name LIKE ? OR p.company LIKE ? OR pn.content LIKE ?)';
        $searchParam = '%' . $search . '%';
        $params[] = $searchParam;
        $params[] = $searchParam;
        $params[] = $searchParam;
    }

    if ($tagId !== null) {
        $conditions[] = '(
            EXISTS (
                SELECT 1
                FROM project_tags pt
                WHERE pt.project_id = pn.project_id AND pt.tag_id = ?
            )
            OR EXISTS (
                SELECT 1
                FROM project_contacts pc
                JOIN contact_tags ct ON ct.contact_id = pc.contact_id
                WHERE pc.project_id = pn.project_id AND ct.tag_id = ?
            )
        )';
        $params[] = $tagId;
        $params[] = $tagId;
    }

    $where = !empty($conditions) ? 'WHERE ' . implode(' AND ', $conditions) : '';

    $sql = "
        SELECT
            pn.id,
            'project_note' AS entry_type,
            pn.created_at,
            pn.content,
            NULL AS title,
            NULL AS description,
            NULL AS due_date,
            NULL AS is_completed,
            NULL AS contact_id,
            NULL AS contact_name,
            NULL AS contact_company,
            pn.project_id,
            p.name AS project_name,
            p.company AS project_company
        FROM project_notes pn
        JOIN projects p ON p.id = pn.project_id
        {$where}
    ";

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function fetchTodoEntries(PDO $db, ?string $start, ?string $end, string $search, ?int $tagId): array
{
    $conditions = ['t.parent_todo_id IS NULL'];
    $params = [];

    if ($start !== null) {
        $conditions[] = 't.created_at >= ?';
        $params[] = $start;
    }

    if ($end !== null) {
        $conditions[] = 't.created_at <= ?';
        $params[] = $end;
    }

    if ($search !== '') {
        $conditions[] = '(
            t.title LIKE ?
            OR t.description LIKE ?
            OR c.name LIKE ?
            OR c.company LIKE ?
            OR p.name LIKE ?
            OR p.company LIKE ?
        )';
        $searchParam = '%' . $search . '%';
        $params[] = $searchParam;
        $params[] = $searchParam;
        $params[] = $searchParam;
        $params[] = $searchParam;
        $params[] = $searchParam;
        $params[] = $searchParam;
    }

    if ($tagId !== null) {
        $conditions[] = '(
            (t.contact_id IS NOT NULL AND EXISTS (
                SELECT 1
                FROM contact_tags ct
                WHERE ct.contact_id = t.contact_id AND ct.tag_id = ?
            ))
            OR
            (t.project_id IS NOT NULL AND (
                EXISTS (
                    SELECT 1
                    FROM project_tags pt
                    WHERE pt.project_id = t.project_id AND pt.tag_id = ?
                )
                OR EXISTS (
                    SELECT 1
                    FROM project_contacts pc
                    JOIN contact_tags ct ON ct.contact_id = pc.contact_id
                    WHERE pc.project_id = t.project_id AND ct.tag_id = ?
                )
            ))
        )';
        $params[] = $tagId;
        $params[] = $tagId;
        $params[] = $tagId;
    }

    $where = !empty($conditions) ? 'WHERE ' . implode(' AND ', $conditions) : '';

    $sql = "
        SELECT
            t.id,
            'todo' AS entry_type,
            t.created_at,
            COALESCE(NULLIF(t.description, ''), t.title) AS content,
            t.title,
            t.description,
            t.due_date,
            t.is_completed,
            t.contact_id,
            c.name AS contact_name,
            c.company AS contact_company,
            t.project_id,
            p.name AS project_name,
            p.company AS project_company
        FROM todos t
        LEFT JOIN contacts c ON c.id = t.contact_id
        LEFT JOIN projects p ON p.id = t.project_id
        {$where}
    ";

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function attachEntryTags(PDO $db, array &$entries): void
{
    if (empty($entries)) {
        return;
    }

    $contactIds = [];
    $projectIds = [];

    foreach ($entries as $entry) {
        $contactId = (int) ($entry['contact_id'] ?? 0);
        $projectId = (int) ($entry['project_id'] ?? 0);

        if ($contactId > 0) {
            $contactIds[$contactId] = $contactId;
        }
        if ($projectId > 0) {
            $projectIds[$projectId] = $projectId;
        }
    }

    $contactTags = fetchTagMap($db, 'contact', array_values($contactIds));
    $projectTags = fetchTagMap($db, 'project', array_values($projectIds));

    foreach ($entries as &$entry) {
        $mergedTags = [];
        $contactId = (int) ($entry['contact_id'] ?? 0);
        $projectId = (int) ($entry['project_id'] ?? 0);

        if ($contactId > 0 && isset($contactTags[$contactId])) {
            foreach ($contactTags[$contactId] as $tag) {
                $mergedTags[(int) $tag['id']] = $tag;
            }
        }

        if ($projectId > 0 && isset($projectTags[$projectId])) {
            foreach ($projectTags[$projectId] as $tag) {
                $mergedTags[(int) $tag['id']] = $tag;
            }
        }

        $entry['tags'] = array_values($mergedTags);
    }
    unset($entry);
}

function fetchTagMap(PDO $db, string $ownerType, array $ownerIds): array
{
    if (empty($ownerIds)) {
        return [];
    }

    if ($ownerType === 'contact') {
        $ownerColumn = 'ct.contact_id';
        $joinSql = 'FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id';
        $inColumn = 'ct.contact_id';
    } elseif ($ownerType === 'project') {
        $ownerColumn = 'pt.project_id';
        $joinSql = 'FROM project_tags pt JOIN tags t ON t.id = pt.tag_id';
        $inColumn = 'pt.project_id';
    } else {
        return [];
    }

    $placeholders = implode(',', array_fill(0, count($ownerIds), '?'));
    $sql = "
        SELECT
            {$ownerColumn} AS owner_id,
            t.id AS tag_id,
            t.name AS tag_name,
            t.color AS tag_color
        {$joinSql}
        WHERE {$inColumn} IN ({$placeholders})
        ORDER BY t.name ASC
    ";

    $stmt = $db->prepare($sql);
    $stmt->execute(array_values($ownerIds));
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $map = [];
    foreach ($rows as $row) {
        $ownerId = (int) ($row['owner_id'] ?? 0);
        if ($ownerId <= 0) {
            continue;
        }

        if (!isset($map[$ownerId])) {
            $map[$ownerId] = [];
        }

        $map[$ownerId][] = [
            'id' => (int) ($row['tag_id'] ?? 0),
            'name' => (string) ($row['tag_name'] ?? ''),
            'color' => (string) ($row['tag_color'] ?? '#3b82f6')
        ];
    }

    return $map;
}
