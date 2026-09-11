<?php
/**
 * Assignment API Endpoint
 *
 * Who is responsible for a contact, project or to-do - and the per-person
 * workload that the "My Work" view is built from.
 *
 * Assigning is deliberately open to every signed-in user, not just admins:
 * handing a job to a colleague is ordinary teamwork, not administration. What
 * is *not* open is inventing an assignee - the target must be a real, active
 * account (or the owner), checked here rather than trusted from the client.
 *
 * All three record types are served by this one endpoint so that the table
 * whitelist, the assignee check and the activity logging exist exactly once.
 */

define('APP_ROOT', dirname(__DIR__));

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Project.php';

header('Content-Type: application/json');
Auth::sendSecurityHeaders();

if (!Auth::isAuthenticated()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

/**
 * The only tables that may be assigned, and how to describe one in the log.
 *
 * This map is the whitelist: a type that is not a key here never reaches SQL,
 * so the table name interpolated into the statements below is always one of
 * these three literals and never anything a caller supplied.
 */
const ASSIGNABLE = [
    'contact' => ['table' => 'contacts', 'label' => 'Kontakt', 'title' => 'name'],
    'project' => ['table' => 'projects', 'label' => 'Projekt', 'title' => 'name'],
    'todo'    => ['table' => 'todos',    'label' => 'To-do',   'title' => 'title'],
    // A bookkeeping row has no name of its own - the date is the only single
    // column every import is guaranteed to have - so that is what it is called
    // in the log. The readable summary is built from the row's own columns
    // where it is shown, in the workload below.
    'bookkeeping' => ['table' => 'bookkeeping_rows', 'label' => 'Buchhaltung', 'title' => 'row_date'],
];

/** Sentinel for the owner identity, which has no users row. */
const ASSIGNEE_OWNER = 0;

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
    Auth::requireCsrfToken();
}

try {
    if ($method === 'GET' && $action === 'workload') {
        handleWorkload($_GET['user'] ?? 'me');
    } elseif ($method === 'GET' && $action === 'summary') {
        handleSummary();
    } elseif ($method === 'POST') {
        handleAssign();
    } else {
        http_response_code(400);
        echo json_encode(['error' => 'Unknown action']);
    }
} catch (Throwable $e) {
    error_log('assign endpoint error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'An internal error occurred']);
}

// -----------------------------------------------------------------------------
// Write
// -----------------------------------------------------------------------------

/**
 * Set or clear the assignee on one record.
 */
function handleAssign(): void
{
    $input = Auth::getJsonInput();
    if (!is_array($input)) {
        respond(['error' => 'Invalid request body.'], 400);
    }

    $type = (string) ($input['type'] ?? '');
    if (!isset(ASSIGNABLE[$type])) {
        respond(['error' => 'Unknown record type.'], 422);
    }

    $id = isset($input['id']) ? (int) $input['id'] : 0;
    if ($id <= 0) {
        respond(['error' => 'A record id is required.'], 422);
    }

    // resolveAssignee refuses anything that is not a real, active account.
    $assignee = resolveAssignee($input['assigned_to'] ?? null);
    if ($assignee === false) {
        respond(['error' => 'That person cannot be assigned work.'], 422);
    }

    $spec = ASSIGNABLE[$type];
    $table = $spec['table'];
    $titleColumn = $spec['title'];

    $db = Database::getInstance();

    $stmt = $db->prepare(
        "SELECT id, " . $titleColumn . " AS title, assigned_to, assigned_to_name FROM " . $table . " WHERE id = :id"
    );
    $stmt->execute(['id' => $id]);
    $record = $stmt->fetch();

    if (!$record) {
        respond(['error' => ucfirst($type) . ' not found.'], 404);
    }

    // A bookkeeping row whose invoice is already filed is finished work. It
    // would be accepted here and then never show up on the home page, which
    // reads as the assignment having silently failed - so say so instead.
    if ($type === 'bookkeeping' && $assignee['id'] !== null && bookkeepingRowHasPdf($db, $id)) {
        respond(['error' => 'That row already has its invoice, so there is nothing to hand over.'], 409);
    }

    $update = $db->prepare(
        "UPDATE " . $table . "
         SET assigned_to = :assigned_to, assigned_to_name = :assigned_to_name
         WHERE id = :id"
    );
    $update->execute([
        'id' => $id,
        'assigned_to' => $assignee['id'],
        'assigned_to_name' => $assignee['name'],
    ]);

    logAssignment($type, $spec['label'], (string) ($record['title'] ?? ''), $record, $assignee);

    respond([
        'success' => true,
        'data' => [
            'id' => $id,
            'type' => $type,
            'assigned_to' => $assignee['id'],
            'assigned_to_name' => $assignee['name'],
        ],
    ]);
}

/**
 * Turn whatever the client sent into a real assignee, or false if it is not one.
 *
 * Accepts null / '' (unassign), the string 'owner', or a users.id. An account
 * that is disabled or does not exist is refused: work must never be parked on
 * somebody who cannot sign in to see it.
 *
 * @return array{id: ?int, name: ?string}|false
 */
function resolveAssignee($raw)
{
    if ($raw === null || $raw === '' || $raw === 'none') {
        return ['id' => null, 'name' => null];
    }

    if ($raw === 'owner' || (is_numeric($raw) && (int) $raw === ASSIGNEE_OWNER)) {
        return ['id' => ASSIGNEE_OWNER, 'name' => OWNER_DISPLAY_NAME];
    }

    if (!is_numeric($raw)) {
        return false;
    }

    $userId = (int) $raw;
    if ($userId <= 0) {
        return false;
    }

    $db = Database::getInstance();
    $stmt = $db->prepare("SELECT id, name, status FROM users WHERE id = :id");
    $stmt->execute(['id' => $userId]);
    $user = $stmt->fetch();

    if (!$user || $user['status'] === User::STATUS_DISABLED) {
        return false;
    }

    return ['id' => (int) $user['id'], 'name' => (string) $user['name']];
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

/**
 * Everything currently on one person's plate.
 *
 * Defaults to the caller. Any signed-in user may look at any colleague's
 * workload - the same records are already readable in the ordinary views, so
 * this only re-sorts what they can see, and knowing who is busy is the point
 * of having assignments at all.
 */
function handleWorkload(string $who): void
{
    $target = resolveWorkloadTarget($who);
    if ($target === false) {
        respond(['error' => 'Unknown person.'], 404);
    }

    $db = Database::getInstance();

    // A single bound value used by all three queries. NULL needs IS NULL
    // rather than = NULL, so the two cases are separate statements.
    $isUnassigned = $target['id'] === null;

    $todos = fetchAssigned(
        $db,
        "SELECT t.id, t.title, t.description, t.due_date, t.priority, t.is_completed,
                t.contact_id, t.project_id, t.assigned_to, t.assigned_to_name,
                c.name AS contact_name, p.name AS project_name
         FROM todos t
         LEFT JOIN contacts c ON c.id = t.contact_id
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.parent_todo_id IS NULL AND ",
        't.assigned_to',
        $isUnassigned,
        $target['id'],
        "ORDER BY t.is_completed ASC,
                  CASE WHEN t.due_date IS NULL OR t.due_date = '' THEN 1 ELSE 0 END ASC,
                  t.due_date ASC, t.created_at DESC"
    );

    $projects = fetchAssigned(
        $db,
        "SELECT id, name, company, stage, start_date, estimated_completion,
                success_chance, assigned_to, assigned_to_name
         FROM projects
         WHERE ",
        'assigned_to',
        $isUnassigned,
        $target['id'],
        // Same pipeline order as the Projects view: what is running first,
        // then what is being won, then leads, and finished work last.
        "ORDER BY " . Project::stageRankSql() . " ASC, name COLLATE NOCASE ASC"
    );

    $contacts = fetchAssigned(
        $db,
        "SELECT id, name, company, location, email, phone, assigned_to, assigned_to_name
         FROM contacts
         WHERE ",
        'assigned_to',
        $isUnassigned,
        $target['id'],
        "ORDER BY name COLLATE NOCASE ASC"
    );

    // "Unassigned" deliberately does not list bookkeeping rows: almost every
    // row ever imported is unassigned, and burying three real contacts under a
    // thousand bank lines would make that view useless.
    $bookkeeping = ($isUnassigned || !bookkeepingAssignable($db))
        ? []
        : fetchBookkeeping($db, $target['id']);

    $openTodos = 0;
    foreach ($todos as $todo) {
        if ((int) $todo['is_completed'] === 0) {
            $openTodos++;
        }
    }

    respond([
        'success' => true,
        'person' => $target,
        'data' => [
            'todos' => $todos,
            'projects' => $projects,
            'contacts' => $contacts,
            'bookkeeping' => $bookkeeping,
        ],
        'counts' => [
            'todos_open' => $openTodos,
            'todos_total' => count($todos),
            'projects' => count($projects),
            'contacts' => count($contacts),
            'bookkeeping' => count($bookkeeping),
        ],
    ]);
}

/**
 * Does this bookkeeping row already have its invoice attached?
 */
function bookkeepingRowHasPdf(PDO $db, int $rowId): bool
{
    $stmt = $db->prepare("SELECT id FROM bookkeeping_pdfs WHERE row_id = :row_id LIMIT 1");
    $stmt->execute(['row_id' => $rowId]);

    return (bool) $stmt->fetchColumn();
}

/**
 * Is there a bookkeeping table with an assignee column to read?
 *
 * The bookkeeping tables are created by their own endpoint the first time that
 * view is opened, so on an instance where nobody has been there yet they do not
 * exist at all. pragma_table_info answers with an empty set for a missing table
 * rather than raising, which is exactly the check needed here - the home page
 * must not fall over because a feature has never been used.
 */
function bookkeepingAssignable(PDO $db): bool
{
    static $available = null;
    if ($available !== null) {
        return $available;
    }

    try {
        $stmt = $db->query("SELECT name FROM pragma_table_info('bookkeeping_rows')");
        $columns = $stmt ? $stmt->fetchAll(PDO::FETCH_COLUMN) : [];
        $available = in_array('assigned_to', $columns, true);
    } catch (Throwable $e) {
        $available = false;
    }

    return $available;
}

/**
 * The bookkeeping rows on one person's plate, each with a readable label.
 *
 * A row is a bag of imported CSV columns, so the label is built the same way
 * the bookkeeping table builds its own row summaries: the first few non-empty
 * values in column order. Rows that already have their invoice are left out -
 * attaching one clears the assignment anyway, and an older row that kept both
 * is finished work either way.
 */
function fetchBookkeeping(PDO $db, ?int $assignee): array
{
    $columns = $db->query("SELECT name FROM bookkeeping_columns ORDER BY position, id")
        ->fetchAll(PDO::FETCH_COLUMN);

    $stmt = $db->prepare("
        SELECT r.id, r.row_date, r.data, r.no_pdf_needed, r.excluded,
               r.assigned_to, r.assigned_to_name
        FROM bookkeeping_rows r
        LEFT JOIN bookkeeping_pdfs p ON p.row_id = r.id
        WHERE r.assigned_to = :assignee AND p.id IS NULL
        ORDER BY (r.row_date IS NULL), r.row_date DESC, r.id DESC
    ");
    $stmt->execute(['assignee' => $assignee]);

    $rows = [];
    foreach ($stmt->fetchAll() as $row) {
        $data = json_decode((string) $row['data'], true);
        if (!is_array($data)) {
            $data = [];
        }

        $parts = [];
        foreach ($columns as $column) {
            $value = trim((string) ($data[$column] ?? ''));
            if ($value !== '' && count($parts) < 3) {
                $parts[] = $value;
            }
        }

        $rows[] = [
            'id' => (int) $row['id'],
            'row_date' => $row['row_date'],
            'summary' => $parts ? implode(' · ', $parts) : ('Row #' . (int) $row['id']),
            'no_pdf_needed' => (int) $row['no_pdf_needed'] === 1,
            'excluded' => (int) $row['excluded'] === 1,
            'assigned_to' => $row['assigned_to'] === null ? null : (int) $row['assigned_to'],
            'assigned_to_name' => $row['assigned_to_name'],
        ];
    }

    return $rows;
}

/**
 * Run one workload query, choosing between "= :id" and "IS NULL".
 */
function fetchAssigned(PDO $db, string $head, string $column, bool $isUnassigned, ?int $id, string $tail): array
{
    // $column is a literal from this file, never caller input.
    $condition = $isUnassigned ? ($column . ' IS NULL') : ($column . ' = :assignee');

    $stmt = $db->prepare($head . $condition . ' ' . $tail);
    $stmt->execute($isUnassigned ? [] : ['assignee' => $id]);

    return $stmt->fetchAll();
}

/**
 * How much is on everyone's plate - used for the counts in the person switcher.
 */
function handleSummary(): void
{
    $db = Database::getInstance();
    $counts = [];

    $tables = ['todos' => 'todos', 'projects' => 'projects', 'contacts' => 'contacts'];
    if (bookkeepingAssignable($db)) {
        $tables['bookkeeping'] = 'bookkeeping_rows';
    }

    foreach ($tables as $key => $table) {
        $extra = '';
        if ($table === 'todos') {
            $extra = ' AND parent_todo_id IS NULL AND is_completed = 0';
        } elseif ($table === 'bookkeeping_rows') {
            // Same rule as the workload list: a row with its invoice attached
            // is no longer work, whatever its assignee column still says.
            $extra = ' AND id NOT IN (SELECT row_id FROM bookkeeping_pdfs WHERE row_id IS NOT NULL)';
        }

        $sql = "SELECT assigned_to, COUNT(*) AS total FROM " . $table
             . " WHERE assigned_to IS NOT NULL" . $extra . " GROUP BY assigned_to";

        foreach ($db->query($sql) as $row) {
            $bucket = (string) (int) $row['assigned_to'];
            if (!isset($counts[$bucket])) {
                $counts[$bucket] = ['todos' => 0, 'projects' => 0, 'contacts' => 0, 'bookkeeping' => 0];
            }
            $counts[$bucket][$key] = (int) $row['total'];
        }
    }

    // The buckets are keyed by numeric user id, which json_encode would turn
    // into a JSON array as soon as they happen to run 0,1,2... Force an object
    // so the client can always look a person up by key.
    respond(['success' => true, 'counts' => (object) $counts]);
}

/**
 * Resolve the person whose workload is being asked for.
 *
 * @return array{id: ?int, name: string, is_owner: bool, unassigned: bool}|false
 */
function resolveWorkloadTarget(string $who)
{
    if ($who === 'me' || $who === '') {
        $me = Auth::currentUser();
        return [
            'id' => $me['is_owner'] ? ASSIGNEE_OWNER : (int) $me['id'],
            'name' => $me['name'],
            'is_owner' => (bool) $me['is_owner'],
            'unassigned' => false,
        ];
    }

    if ($who === 'unassigned') {
        return ['id' => null, 'name' => 'Unassigned', 'is_owner' => false, 'unassigned' => true];
    }

    if ($who === 'owner' || (is_numeric($who) && (int) $who === ASSIGNEE_OWNER)) {
        return [
            'id' => ASSIGNEE_OWNER,
            'name' => OWNER_DISPLAY_NAME,
            'is_owner' => true,
            'unassigned' => false,
        ];
    }

    if (!is_numeric($who)) {
        return false;
    }

    $db = Database::getInstance();
    $stmt = $db->prepare("SELECT id, name FROM users WHERE id = :id");
    $stmt->execute(['id' => (int) $who]);
    $user = $stmt->fetch();

    if (!$user) {
        return false;
    }

    return [
        'id' => (int) $user['id'],
        'name' => (string) $user['name'],
        'is_owner' => false,
        'unassigned' => false,
    ];
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Put the change on the shared timeline, so a reassignment is as visible as any
 * other edit. Nothing is logged when the assignee did not actually change.
 */
function logAssignment(string $type, string $label, string $title, array $record, array $assignee): void
{
    $before = $record['assigned_to'] === null ? null : (int) $record['assigned_to'];
    if ($before === $assignee['id']) {
        return;
    }

    // The timeline is a per-contact and per-project thing. A bookkeeping row
    // belongs to neither, and an entry that links to nothing is only noise in
    // the feed, so that one change is not logged.
    if ($type === 'bookkeeping') {
        return;
    }

    $content = $assignee['name'] === null
        ? $label . ' freigegeben: ' . $title
        : $label . ' zugewiesen an ' . $assignee['name'] . ': ' . $title;

    try {
        $actor = Auth::actor();
        $db = Database::getInstance();

        $entryType = $type === 'project' ? 'project_activity' : 'contact_activity';
        $columns = "entry_type, action, content, actor_id, actor_name";
        $values = ":entry_type, 'assigned', :content, :actor_id, :actor_name";
        $params = [
            'entry_type' => $entryType,
            'content' => $content,
            'actor_id' => $actor['id'],
            'actor_name' => $actor['name'],
        ];

        // Link the entry back to whatever it is about, so the calendar can
        // still navigate to the record.
        if ($type === 'project') {
            $columns .= ", project_id, project_name";
            $values .= ", :project_id, :project_name";
            $params['project_id'] = (int) $record['id'];
            $params['project_name'] = $title;
        } elseif ($type === 'contact') {
            $columns .= ", contact_id, contact_name";
            $values .= ", :contact_id, :contact_name";
            $params['contact_id'] = (int) $record['id'];
            $params['contact_name'] = $title;
        }

        $stmt = $db->prepare("INSERT INTO activity_events (" . $columns . ") VALUES (" . $values . ")");
        $stmt->execute($params);
    } catch (Throwable $e) {
        error_log('assignment log failed: ' . $e->getMessage());
    }
}

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload);
    exit;
}
