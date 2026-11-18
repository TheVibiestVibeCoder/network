<?php
/**
 * MCP API actions
 *
 * What Claude can do through api/mcp.php, one method per action. The request
 * has already been verified by McpGuard when anything here runs.
 *
 * Reading is plain reading, with every list capped. Writing never settles
 * anything: a new record is stored as 'pending' and a change to an existing
 * record is stored as a proposal (see ReviewQueue). There is deliberately no
 * bulk write and no bulk delete - one record per call, and a deletion is only
 * ever a proposal a person has to accept.
 *
 * Input is validated with the same rules the CRM's own endpoints apply, so a
 * proposal that reaches a reviewer is one the normal forms would have accepted.
 *
 * Bookkeeping: Claude can see which invoice PDFs sit in the pool (with what the
 * invoice reader found in them) and put new ones there. Filing an invoice on
 * its bank entry stays a person's job.
 *
 * Money (since November 2026, docs/mcp-payments-cashflow.md): Claude reads a
 * project's expected payments and proposes changes to them - a whole payment
 * plan, or one payment as received - on the ordinary review path. It also
 * reads the bank entries, Financials (costs, balances, debts, VAT) and the
 * cashflow forecast, worked out by includes/Cashflow.php exactly as the
 * Financials tab does it. Those three show the bank balance and every cost,
 * so MCP_API_FINANCIALS=false in .env switches them off on their own.
 *
 * Project documents are the opposite on purpose: they are attached to a project
 * so that whoever works on it has the context, and that includes Claude. It can
 * list a project's documents, fetch one to read it, and add new ones - which,
 * like every other write, are proposals until a person accepts them.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/AssignmentFeed.php';
require_once __DIR__ . '/TodoLink.php';
require_once __DIR__ . '/ProjectArchive.php';
require_once __DIR__ . '/Cashflow.php';

/** A refusal Claude should read and act on - the message is shown to it verbatim. */
class McpError extends ReviewException
{
}

/**
 * A stored file as the answer to an action. api/mcp.php sends its bytes as the
 * response body instead of JSON, so a document is streamed from disk rather
 * than base64-encoded in memory.
 */
final class McpFile
{
    public string $path;

    public function __construct(string $path)
    {
        $this->path = $path;
    }
}

final class McpService
{
    private const STAGES = ['Complete', 'In Progress', 'Proposal', 'Negotiation', 'Lead'];
    private const PRIORITIES = ['low', 'medium', 'high'];
    private const MAX_PDF_BYTES = 10 * 1024 * 1024;

    /** Contact fields Claude may set, with their length limits. */
    private const CONTACT_FIELDS = [
        'name' => 255, 'company' => 255, 'location' => 255, 'email' => 255,
        'phone' => 50, 'website' => 2048, 'address' => 1000, 'note' => 10000,
    ];

    private const PROJECT_FIELDS = [
        'name', 'description', 'company', 'start_date', 'estimated_completion',
        'stage', 'budget_min', 'budget_max', 'success_chance',
    ];

    private const TODO_FIELDS = ['title', 'description', 'due_date', 'priority', 'is_completed'];

    /**
     * The whole surface: action => [method, writes]. Anything not listed here
     * does not exist.
     */
    private const ACTIONS = [
        'meta' => ['meta', false],
        'contacts.search' => ['contactsSearch', false],
        'contacts.get' => ['contactsGet', false],
        'companies.list' => ['companiesList', false],
        'companies.get' => ['companiesGet', false],
        'projects.search' => ['projectsSearch', false],
        'projects.get' => ['projectsGet', false],
        'projects.documents' => ['projectsDocuments', false],
        'projects.document' => ['projectsDocument', false],
        'projects.document_file' => ['projectsDocumentFile', false],
        'todos.list' => ['todosList', false],
        'activity.recent' => ['activityRecent', false],
        'tags.list' => ['tagsList', false],
        'bookkeeping.pool' => ['bookkeepingPool', false],
        'reviews.list' => ['reviewsList', false],
        'payments.list' => ['paymentsList', false],
        'projects.archived' => ['projectsArchived', false],
        'bookkeeping.rows' => ['bookkeepingRows', false],
        'financials.get' => ['financialsGet', false],
        'financials.forecast' => ['financialsForecast', false],

        'contacts.create' => ['contactsCreate', true],
        'contacts.update' => ['contactsUpdate', true],
        'contacts.add_note' => ['contactsAddNote', true],
        'projects.create' => ['projectsCreate', true],
        'projects.update' => ['projectsUpdate', true],
        'projects.add_note' => ['projectsAddNote', true],
        'projects.link_contact' => ['projectsLinkContact', true],
        'projects.unlink_contact' => ['projectsUnlinkContact', true],
        'projects.upload_document' => ['projectsUploadDocument', true],
        'tags.apply' => ['tagsApply', true],
        'tags.remove' => ['tagsRemove', true],
        'todos.create' => ['todosCreate', true],
        'todos.update' => ['todosUpdate', true],
        'records.assign' => ['recordsAssign', true],
        'records.delete' => ['recordsDelete', true],
        'bookkeeping.upload_pdf' => ['bookkeepingUploadPdf', true],
        'reviews.withdraw' => ['reviewsWithdraw', true],
        'projects.set_payments' => ['projectsSetPayments', true],
        'projects.mark_payment_paid' => ['projectsMarkPaymentPaid', true],
    ];

    private PDO $db;

    public function __construct()
    {
        $this->db = Database::getInstance();
        ReviewQueue::ensureBookkeepingColumn();
    }

    public static function isWrite(string $action): bool
    {
        return isset(self::ACTIONS[$action]) && self::ACTIONS[$action][1];
    }

    /** @return array|McpFile The JSON answer, or a file to send as the body. */
    public function handle(string $action, array $params)
    {
        if (!isset(self::ACTIONS[$action])) {
            throw new McpError('Unknown action "' . mb_substr($action, 0, 64) . '".', 400);
        }

        [$method, $writes] = self::ACTIONS[$action];

        if ($writes) {
            if (!MCP_API_ALLOW_WRITES) {
                throw new McpError('Writing through the API is switched off in the CRM. Only reading is possible.', 403);
            }
            if ($action !== 'reviews.withdraw' && ReviewQueue::pendingCount() >= MCP_API_MAX_PENDING) {
                throw new McpError(
                    'There are already ' . MCP_API_MAX_PENDING . ' proposals waiting for review in the CRM. '
                    . 'Ask the user to work through them before proposing more.',
                    429
                );
            }
        }

        return $this->$method($params);
    }

    // =========================================================================
    // Reading
    // =========================================================================

    private function meta(array $p): array
    {
        // The owner login is the recovery account, not a team member, so it is
        // not offered as someone to assign work to.
        $users = [];
        foreach ($this->db->query("SELECT id, name, role FROM users WHERE status <> 'disabled' ORDER BY name COLLATE NOCASE")->fetchAll() as $u) {
            $users[] = ['id' => (int) $u['id'], 'name' => $u['name'], 'role' => $u['role']];
        }

        return [
            'crm_name' => APP_NAME,
            'today' => date('Y-m-d'),
            'writes_enabled' => MCP_API_ALLOW_WRITES,
            'review_note' => 'Everything written through this API is a proposal. It shows in the CRM marked as coming from '
                . MCP_ACTOR_NAME . ' and only becomes permanent when a person accepts it.',
            'project_stages' => self::STAGES,
            'todo_priorities' => self::PRIORITIES,
            'document_labels' => ProjectDocument::LABELS,
            'team' => $users,
            'counts' => [
                'contacts' => (int) $this->db->query("SELECT COUNT(*) FROM contacts")->fetchColumn(),
                'projects_open' => (int) $this->db->query("SELECT COUNT(*) FROM projects WHERE stage <> 'Complete'")->fetchColumn(),
                'todos_open' => (int) $this->db->query("SELECT COUNT(*) FROM todos WHERE is_completed = 0 AND parent_todo_id IS NULL")->fetchColumn(),
                'proposals_waiting' => ReviewQueue::pendingCount(),
            ],
            'bookkeeping_available' => ReviewQueue::tableExists('bookkeeping_pdfs'),
            // Bank entries, Financials and the cashflow forecast (MCP_API_FINANCIALS).
            'financials_available' => MCP_API_FINANCIALS,
        ];
    }

    private function contactsSearch(array $p): array
    {
        [$limit, $offset] = $this->paging($p, 25, 100);
        $where = [];
        $params = [];

        $query = $this->str($p, 'query', 200);
        if ($query !== null) {
            $where[] = "(c.name LIKE :q ESCAPE '\\' OR c.company LIKE :q ESCAPE '\\' OR c.email LIKE :q ESCAPE '\\'
                        OR c.location LIKE :q ESCAPE '\\' OR c.phone LIKE :q ESCAPE '\\' OR c.address LIKE :q ESCAPE '\\'
                        OR c.note LIKE :q ESCAPE '\\')";
            $params['q'] = $this->like($query);
        }

        $company = $this->str($p, 'company', 255);
        if ($company !== null) {
            $where[] = "c.company LIKE :company ESCAPE '\\'";
            $params['company'] = $this->like($company);
        }

        $tag = $this->str($p, 'tag', 100);
        if ($tag !== null) {
            $where[] = "EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
                               WHERE ct.contact_id = c.id AND LOWER(t.name) = LOWER(:tag))";
            $params['tag'] = $tag;
        }

        if ($this->bool($p, 'pending_only')) {
            $where[] = "c.review_status = 'pending'";
        }

        $whereSql = $where ? ' WHERE ' . implode(' AND ', $where) : '';

        $count = $this->db->prepare("SELECT COUNT(*) FROM contacts c" . $whereSql);
        $count->execute($params);

        $stmt = $this->db->prepare("
            SELECT c.id, c.name, c.company, c.location, c.email, c.phone, c.website,
                   c.assigned_to_name, c.review_status, c.updated_at,
                   (SELECT GROUP_CONCAT(t.name, ', ') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
                    WHERE ct.contact_id = c.id) AS tags
            FROM contacts c" . $whereSql . "
            ORDER BY c.name COLLATE NOCASE
            LIMIT " . $limit . " OFFSET " . $offset
        );
        $stmt->execute($params);

        return ['total' => (int) $count->fetchColumn(), 'offset' => $offset, 'contacts' => $stmt->fetchAll()];
    }

    private function contactsGet(array $p): array
    {
        $id = $this->id($p, 'contact_id');
        $contact = $this->fetchContact($id);

        $tags = $this->db->prepare("SELECT t.id, t.name FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id WHERE ct.contact_id = :id ORDER BY t.name");
        $tags->execute(['id' => $id]);

        $notes = $this->db->prepare("
            SELECT id, content, author_name, review_status, created_at
            FROM notes WHERE contact_id = :id ORDER BY created_at DESC, id DESC LIMIT 50
        ");
        $notes->execute(['id' => $id]);

        $projects = $this->db->prepare("
            SELECT p.id, p.name, p.company, p.stage, p.review_status
            FROM projects p JOIN project_contacts pc ON pc.project_id = p.id
            WHERE pc.contact_id = :id ORDER BY p.name COLLATE NOCASE
        ");
        $projects->execute(['id' => $id]);

        $todos = $this->db->prepare("
            SELECT COALESCE(parent_todo_id, id) AS id, title, due_date, priority, is_completed, assigned_to_name, review_status
            FROM todos WHERE contact_id = :id
            ORDER BY is_completed ASC, CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC
            LIMIT 50
        ");
        $todos->execute(['id' => $id]);

        return [
            'contact' => $contact,
            'tags' => $tags->fetchAll(),
            'notes' => $notes->fetchAll(),
            'projects' => $projects->fetchAll(),
            'todos' => $todos->fetchAll(),
            'open_proposals' => $this->proposalsFor('contact', $id),
        ];
    }

    private function companiesList(array $p): array
    {
        $limit = $this->limit($p, 50, 200);
        $params = [];
        $filter = '';

        $query = $this->str($p, 'query', 200);
        if ($query !== null) {
            $filter = " AND company LIKE :q ESCAPE '\\'";
            $params['q'] = $this->like($query);
        }

        $stmt = $this->db->prepare("
            SELECT TRIM(company) AS company, COUNT(*) AS contacts
            FROM contacts
            WHERE company IS NOT NULL AND TRIM(company) <> ''" . $filter . "
            GROUP BY LOWER(TRIM(company))
            ORDER BY company COLLATE NOCASE
            LIMIT " . $limit
        );
        $stmt->execute($params);
        $companies = $stmt->fetchAll();

        $projectCounts = [];
        foreach ($this->db->query("
            SELECT LOWER(TRIM(company)) AS k, COUNT(*) AS n FROM projects
            WHERE company IS NOT NULL AND TRIM(company) <> '' GROUP BY LOWER(TRIM(company))
        ")->fetchAll() as $row) {
            $projectCounts[$row['k']] = (int) $row['n'];
        }

        foreach ($companies as &$company) {
            $company['contacts'] = (int) $company['contacts'];
            $company['projects'] = $projectCounts[mb_strtolower((string) $company['company'])] ?? 0;
        }
        unset($company);

        return ['companies' => $companies];
    }

    private function companiesGet(array $p): array
    {
        $name = $this->str($p, 'name', 255, true);

        $contacts = $this->db->prepare("
            SELECT id, name, email, phone, location, review_status
            FROM contacts WHERE LOWER(TRIM(company)) = LOWER(:name) ORDER BY name COLLATE NOCASE
        ");
        $contacts->execute(['name' => $name]);
        $contactRows = $contacts->fetchAll();

        $projects = $this->db->prepare("
            SELECT id, name, stage, budget_min, budget_max, estimated_completion, review_status
            FROM projects WHERE LOWER(TRIM(company)) = LOWER(:name) ORDER BY name COLLATE NOCASE
        ");
        $projects->execute(['name' => $name]);
        $projectRows = $projects->fetchAll();

        // No exact match: offer the near misses rather than an empty answer,
        // so "ACME" still finds "ACME GmbH".
        if (empty($contactRows) && empty($projectRows)) {
            $similar = $this->db->prepare("
                SELECT DISTINCT TRIM(company) AS company FROM (
                    SELECT company FROM contacts UNION ALL SELECT company FROM projects
                ) WHERE company LIKE :q ESCAPE '\\' LIMIT 20
            ");
            $similar->execute(['q' => $this->like($name)]);

            return [
                'found' => false,
                'message' => 'No company with exactly that name. Similar names are listed; call again with one of them.',
                'similar' => array_column($similar->fetchAll(), 'company'),
            ];
        }

        $notes = $this->db->prepare("
            SELECT n.id, n.content, n.created_at, n.review_status, c.name AS contact_name
            FROM notes n JOIN contacts c ON c.id = n.contact_id
            WHERE LOWER(TRIM(c.company)) = LOWER(:name)
            ORDER BY n.created_at DESC LIMIT 30
        ");
        $notes->execute(['name' => $name]);

        $todos = [];
        $contactIds = array_map('intval', array_column($contactRows, 'id'));
        $projectIds = array_map('intval', array_column($projectRows, 'id'));
        if ($contactIds || $projectIds) {
            $conditions = [];
            if ($contactIds) {
                $conditions[] = 'contact_id IN (' . implode(',', $contactIds) . ')';
            }
            if ($projectIds) {
                $conditions[] = 'project_id IN (' . implode(',', $projectIds) . ')';
            }
            $todos = $this->db->query("
                SELECT id, title, due_date, priority, contact_id, project_id, assigned_to_name, review_status
                FROM todos WHERE parent_todo_id IS NULL AND is_completed = 0 AND (" . implode(' OR ', $conditions) . ")
                ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date LIMIT 50
            ")->fetchAll();
        }

        return [
            'found' => true,
            'company' => $name,
            'contacts' => $contactRows,
            'projects' => $projectRows,
            'recent_notes' => $notes->fetchAll(),
            'open_todos' => $todos,
        ];
    }

    private function projectsSearch(array $p): array
    {
        [$limit, $offset] = $this->paging($p, 25, 100);
        $where = [];
        $params = [];

        $query = $this->str($p, 'query', 200);
        if ($query !== null) {
            $where[] = "(name LIKE :q ESCAPE '\\' OR company LIKE :q ESCAPE '\\' OR description LIKE :q ESCAPE '\\')";
            $params['q'] = $this->like($query);
        }

        $company = $this->str($p, 'company', 255);
        if ($company !== null) {
            $where[] = "company LIKE :company ESCAPE '\\'";
            $params['company'] = $this->like($company);
        }

        $stage = $this->str($p, 'stage', 50);
        if ($stage !== null) {
            $where[] = 'stage = :stage';
            $params['stage'] = $this->enum($stage, self::STAGES, 'stage');
        } elseif (!$this->bool($p, 'include_completed')) {
            $where[] = "stage <> 'Complete'";
        }

        if ($this->bool($p, 'pending_only')) {
            $where[] = "review_status = 'pending'";
        }

        $whereSql = $where ? ' WHERE ' . implode(' AND ', $where) : '';

        $count = $this->db->prepare("SELECT COUNT(*) FROM projects" . $whereSql);
        $count->execute($params);

        $stmt = $this->db->prepare("
            SELECT id, name, company, stage, start_date, estimated_completion, budget_min, budget_max,
                   success_chance, assigned_to_name, review_status, updated_at
            FROM projects" . $whereSql . "
            ORDER BY updated_at DESC
            LIMIT " . $limit . " OFFSET " . $offset
        );
        $stmt->execute($params);

        return ['total' => (int) $count->fetchColumn(), 'offset' => $offset, 'projects' => $stmt->fetchAll()];
    }

    private function projectsGet(array $p): array
    {
        $id = $this->id($p, 'project_id');
        $project = $this->fetchProject($id);

        $contacts = $this->db->prepare("
            SELECT c.id, c.name, c.company, c.email, c.review_status
            FROM contacts c JOIN project_contacts pc ON pc.contact_id = c.id
            WHERE pc.project_id = :id ORDER BY c.name COLLATE NOCASE
        ");
        $contacts->execute(['id' => $id]);

        $tags = $this->db->prepare("SELECT t.id, t.name FROM tags t JOIN project_tags pt ON pt.tag_id = t.id WHERE pt.project_id = :id ORDER BY t.name");
        $tags->execute(['id' => $id]);

        $notes = $this->db->prepare("
            SELECT id, content, author_name, review_status, created_at
            FROM project_notes WHERE project_id = :id ORDER BY created_at DESC, id DESC LIMIT 50
        ");
        $notes->execute(['id' => $id]);

        $todos = $this->db->prepare("
            SELECT id, title, description, due_date, priority, is_completed, assigned_to_name, review_status
            FROM todos WHERE project_id = :id AND parent_todo_id IS NULL
            ORDER BY is_completed ASC, CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC
            LIMIT 50
        ");
        $todos->execute(['id' => $id]);
        $todoRows = $todos->fetchAll();
        TodoLink::attach($this->db, $todoRows);

        // Expected payments (changed through projects.set_payments / mark_payment_paid)
        // and the Claude summary the project sheet shows under the description.
        $extra = $this->db->prepare("SELECT payments, claude_summary, claude_summary_at FROM projects WHERE id = :id");
        $extra->execute(['id' => $id]);
        $row = $extra->fetch() ?: [];
        $project['expected_payments'] = Project::decodePayments($row['payments'] ?? null);
        $project['payments_summary'] = $this->paymentsSummary($project, $project['expected_payments']);
        $project['claude_summary'] = $row['claude_summary'] ?? null;
        $project['claude_summary_at'] = $row['claude_summary_at'] ?? null;

        return [
            'project' => $project,
            'contacts' => $contacts->fetchAll(),
            'tags' => $tags->fetchAll(),
            'notes' => $notes->fetchAll(),
            'todos' => $todoRows,
            'documents' => array_map([ProjectDocument::class, 'present'], ProjectDocument::forProject($id)),
            'open_proposals' => $this->proposalsFor('project', $id),
        ];
    }

    private function projectsDocuments(array $p): array
    {
        $project = $this->fetchProject($this->id($p, 'project_id'));
        $label = $this->documentLabel($p, false);

        $documents = [];
        foreach (ProjectDocument::forProject((int) $project['id']) as $row) {
            if ($label === null || $row['label'] === $label) {
                $documents[] = ProjectDocument::present($row);
            }
        }

        return [
            'project' => $this->pick($project, ['id', 'name', 'company', 'stage', 'review_status']),
            'labels' => ProjectDocument::LABELS,
            'allowed_extensions' => ProjectDocument::extensions(),
            'max_upload_bytes' => ProjectDocument::MAX_API_BYTES,
            'documents' => $documents,
        ];
    }

    private function projectsDocument(array $p): array
    {
        $row = $this->fetchDocument($this->id($p, 'document_id'));
        $project = $this->fetchProject((int) $row['project_id']);

        return [
            'document' => ProjectDocument::present($row),
            'project' => $this->pick($project, ['id', 'name', 'company', 'stage', 'review_status']),
        ];
    }

    /** The file itself. Sent as the response body, not as JSON. */
    private function projectsDocumentFile(array $p): McpFile
    {
        $row = $this->fetchDocument($this->id($p, 'document_id'));
        $path = ProjectDocument::pathOf($row);
        if ($path === null || !is_file($path)) {
            throw new McpError('The file behind document ' . (int) $row['id'] . ' is missing on the server.', 404);
        }

        return new McpFile($path);
    }

    private function todosList(array $p): array
    {
        $limit = $this->limit($p, 50, 200);
        $where = ['t.parent_todo_id IS NULL'];
        $params = [];

        $status = $this->str($p, 'status', 16) ?? 'open';
        $status = $this->enum($status, ['open', 'completed', 'all'], 'status');
        if ($status === 'open') {
            $where[] = 't.is_completed = 0';
        } elseif ($status === 'completed') {
            $where[] = 't.is_completed = 1';
        }

        $contactId = $this->id($p, 'contact_id', false);
        if ($contactId !== null) {
            // A project to-do shows under each of the project's contacts as a
            // mirrored copy; the list answers with the to-do itself.
            $where[] = '(t.contact_id = :cid OR t.id IN (SELECT parent_todo_id FROM todos WHERE contact_id = :cid2 AND parent_todo_id IS NOT NULL))';
            $params['cid'] = $contactId;
            $params['cid2'] = $contactId;
        }

        $projectId = $this->id($p, 'project_id', false);
        if ($projectId !== null) {
            $where[] = 't.project_id = :pid';
            $params['pid'] = $projectId;
        }

        if (array_key_exists('assigned_to', $p) && $p['assigned_to'] !== null && $p['assigned_to'] !== '') {
            if (!is_numeric($p['assigned_to']) || (int) $p['assigned_to'] < 0) {
                throw new McpError('assigned_to must be a team member id from meta (0 is the owner).', 422);
            }
            $where[] = 't.assigned_to = :assignee';
            $params['assignee'] = (int) $p['assigned_to'];
        }

        $dueBefore = $this->date($p, 'due_before');
        if ($dueBefore !== null) {
            $where[] = 't.due_date IS NOT NULL AND t.due_date <= :due';
            $params['due'] = $dueBefore;
        }

        if ($this->bool($p, 'pending_only')) {
            $where[] = "t.review_status = 'pending'";
        }

        $stmt = $this->db->prepare("
            SELECT t.id, t.title, t.description, t.due_date, t.priority, t.is_completed,
                   t.contact_id, c.name AS contact_name, t.project_id, p.name AS project_name,
                   t.assigned_to, t.assigned_to_name, t.review_status, t.created_by_name
            FROM todos t
            LEFT JOIN contacts c ON c.id = t.contact_id
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE " . implode(' AND ', $where) . "
            ORDER BY t.is_completed ASC, CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date ASC, t.created_at DESC
            LIMIT " . $limit
        );
        $stmt->execute($params);
        $todos = $stmt->fetchAll();
        TodoLink::attach($this->db, $todos);

        return ['todos' => $todos];
    }

    private function activityRecent(array $p): array
    {
        $days = $this->intRange($p, 'days', 1, 90) ?? 14;
        $limit = $this->limit($p, 100, 300);
        $since = date('Y-m-d H:i:s', time() - $days * 86400);

        $events = $this->db->prepare("
            SELECT entry_type, action, content, contact_id, contact_name, project_id, project_name, actor_name, created_at
            FROM activity_events WHERE created_at >= :since ORDER BY created_at DESC LIMIT " . $limit
        );
        $events->execute(['since' => $since]);

        $notes = $this->db->prepare("
            SELECT 'contact_note' AS type, n.id, n.content, n.author_name, n.created_at, c.id AS contact_id, c.name AS contact_name,
                   NULL AS project_id, NULL AS project_name
            FROM notes n JOIN contacts c ON c.id = n.contact_id WHERE n.created_at >= :since
            UNION ALL
            SELECT 'project_note', n.id, n.content, n.author_name, n.created_at, NULL, NULL, pr.id, pr.name
            FROM project_notes n JOIN projects pr ON pr.id = n.project_id WHERE n.created_at >= :since2
            ORDER BY created_at DESC LIMIT " . $limit
        );
        $notes->execute(['since' => $since, 'since2' => $since]);

        return ['days' => $days, 'events' => $events->fetchAll(), 'notes' => $notes->fetchAll()];
    }

    private function tagsList(array $p): array
    {
        return ['tags' => $this->db->query("
            SELECT t.id, t.name, t.color,
                   (SELECT COUNT(*) FROM contact_tags WHERE tag_id = t.id) AS contacts,
                   (SELECT COUNT(*) FROM project_tags WHERE tag_id = t.id) AS projects
            FROM tags t ORDER BY t.name COLLATE NOCASE
        ")->fetchAll()];
    }

    private function bookkeepingPool(array $p): array
    {
        $this->requireBookkeeping();

        // What the invoice reader found in each PDF, where it has read it.
        $columns = array_column($this->db->query("PRAGMA table_info(bookkeeping_pdfs)")->fetchAll(PDO::FETCH_ASSOC), 'name');
        $invoiceSql = in_array('invoice_data', $columns, true) ? ', invoice_data, invoice_error' : ', NULL AS invoice_data, NULL AS invoice_error';
        $pdfs = $this->db->query("
            SELECT id, original_name, file_size, created_at, review_status" . $invoiceSql . "
            FROM bookkeeping_pdfs WHERE row_id IS NULL
            ORDER BY created_at DESC, id DESC LIMIT 200
        ")->fetchAll();
        foreach ($pdfs as &$pdf) {
            $pdf['invoice'] = $this->invoiceFacts($pdf['invoice_data']);
            $pdf['invoice_read'] = $pdf['invoice'] !== null ? 'read' : ($pdf['invoice_error'] ? 'could not be read' : 'not read yet');
            unset($pdf['invoice_data'], $pdf['invoice_error']);
        }
        unset($pdf);

        return [
            'explanation' => 'Invoice PDFs in the bookkeeping drop zone, not yet filed on a bank entry. "invoice" is what the CRM '
                . 'read from the PDF (issuer, number, dates, net, VAT, gross); amounts as on the invoice.',
            'pdfs' => $pdfs,
        ];
    }

    private function reviewsList(array $p): array
    {
        $status = $this->enum($this->str($p, 'status', 16) ?? 'pending', ['pending', 'resolved'], 'status');
        $limit = $this->limit($p, 50, 200);

        $items = [];
        foreach (ReviewQueue::listItems($status, $limit) as $item) {
            $items[] = $this->publicProposal($item);
        }

        return ['status' => $status, 'proposals' => $items];
    }

    // =========================================================================
    // Reading - money
    // =========================================================================

    /** Expected payments across all projects, filtered by month and state. */
    private function paymentsList(array $p): array
    {
        $from = $this->month($p, 'from_month');
        $to = $this->month($p, 'to_month');
        $status = $this->enum($this->str($p, 'status', 16) ?? 'open', ['open', 'paid', 'all'], 'status');
        $overdueOnly = $this->bool($p, 'overdue_only');
        $projectId = $this->id($p, 'project_id', false);
        $limit = $this->limit($p, 200, 500);
        $current = Cashflow::today()->format('Y-m');

        $sql = "SELECT id, name, company, stage, success_chance, estimated_completion, payments, review_status
                FROM projects WHERE payments IS NOT NULL AND payments <> ''";
        $params = [];
        if ($projectId !== null) {
            $sql .= ' AND id = :id';
            $params['id'] = $projectId;
        }
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        $rows = [];
        foreach ($stmt->fetchAll() as $project) {
            foreach (Cashflow::parsePayments($project['payments']) as $payment) {
                $overdue = !$payment['paid'] && $payment['month'] < $current;
                if (($status === 'open' && $payment['paid']) || ($status === 'paid' && !$payment['paid'])
                    || ($overdueOnly && !$overdue)
                    || ($from !== null && $payment['month'] < $from) || ($to !== null && $payment['month'] > $to)) {
                    continue;
                }
                $rows[] = [
                    'project_id' => (int) $project['id'],
                    'project' => $project['name'],
                    'company' => $project['company'],
                    'stage' => $project['stage'],
                    'success_chance' => $project['success_chance'] === null ? null : (int) $project['success_chance'],
                    'month' => $payment['month'],
                    'amount' => $payment['amount'],
                    'paid' => $payment['paid'],
                    'payment_in_full' => $payment['full'],
                    'overdue' => $overdue,
                    'project_review_status' => $project['review_status'],
                ];
            }
        }
        usort($rows, fn($a, $b) => strcmp($a['month'], $b['month']) ?: strcasecmp((string) $a['project'], (string) $b['project']) ?: ($a['amount'] <=> $b['amount']));

        $byMonth = [];
        $sumOpen = 0.0;
        $sumPaid = 0.0;
        foreach ($rows as $row) {
            $byMonth[$row['month']] ??= ['open' => 0.0, 'paid' => 0.0];
            $byMonth[$row['month']][$row['paid'] ? 'paid' : 'open'] += $row['amount'];
            $row['paid'] ? $sumPaid += $row['amount'] : $sumOpen += $row['amount'];
        }

        return [
            'this_month' => $current,
            'note' => 'Amounts are net, like the projects\' budgets. A payment is overdue when it is not marked as paid and '
                . 'its month has passed. Chance is not applied here - see financials.forecast for that.',
            'count' => count($rows),
            'totals' => ['open' => Cashflow::round2($sumOpen), 'paid' => Cashflow::round2($sumPaid)],
            'by_month' => array_map(fn($m) => ['open' => Cashflow::round2($m['open']), 'paid' => Cashflow::round2($m['paid'])], $byMonth),
            'payments' => array_slice($rows, 0, $limit),
        ];
    }

    private function projectsArchived(array $p): array
    {
        $limit = $this->limit($p, 50, 200);
        $query = $this->str($p, 'query', 200);
        if (!ReviewQueue::tableExists('deleted_projects')) {
            return ['total' => 0, 'archived' => []];
        }

        $list = array_values(array_filter(ProjectArchive::list($this->db), fn($a) => $query === null
            || mb_stripos((string) $a['name'], $query) !== false || mb_stripos((string) $a['company'], $query) !== false));

        return [
            'explanation' => 'Archived projects: removed from the pipeline with their to-dos, notes and documents, and kept whole so a '
                . 'person can restore them in the CRM (Projects, Archived). Their ids are not usable with the other tools while archived.',
            'total' => count($list),
            'archived' => array_slice($list, 0, $limit),
        ];
    }

    /** The bank entries imported into Bookkeeping, newest first. */
    private function bookkeepingRows(array $p): array
    {
        $this->requireFinancials();
        $this->requireBookkeeping();
        [$limit, $offset] = $this->paging($p, 100, 500);
        $from = $this->date($p, 'date_from');
        $to = $this->date($p, 'date_to');
        $direction = $this->enum($this->str($p, 'direction', 8) ?? 'all', ['in', 'out', 'all'], 'direction');
        $query = $this->str($p, 'query', 200);
        $missingOnly = $this->bool($p, 'missing_invoice_only');
        $withExcluded = $this->bool($p, 'include_excluded');

        $bank = Cashflow::bankRows($this->db);
        if ($bank['amount_column'] === null) {
            return ['count' => 0, 'rows' => [],
                    'message' => 'No bank entries yet, or Bookkeeping cannot tell which column holds the amounts.'];
        }
        $rows = Cashflow::markVatPayments($bank['rows'], (new Financials())->settings()['vat_links']);

        $rows = array_values(array_filter($rows, function ($r) use ($from, $to, $direction, $query, $missingOnly, $withExcluded) {
            return ($withExcluded || !$r['excluded'])
                && ($from === null || $r['date'] >= $from) && ($to === null || $r['date'] <= $to)
                && ($direction === 'all' || ($direction === 'in' ? $r['amount'] > 0 : $r['amount'] < 0))
                && ($query === null || mb_stripos($r['party'] . ' ' . $r['text'], $query) !== false)
                && (!$missingOnly || ($r['pdf'] === null && !$r['no_pdf_needed'] && empty($r['vat_quarter'])));
        }));
        usort($rows, fn($a, $b) => strcmp($b['date'], $a['date']) ?: ($b['id'] <=> $a['id']));

        $in = 0.0;
        $out = 0.0;
        foreach ($rows as $r) {
            if (!$r['excluded']) {
                $r['amount'] > 0 ? $in += $r['amount'] : $out -= $r['amount'];
            }
        }

        return [
            'explanation' => 'Bank entries as imported into Bookkeeping: + money in, - money out, as the bank booked it (gross). '
                . '"vat" is the VAT share the matched invoice gives the entry (+ comes back, - is owed). "needs_invoice" = no '
                . 'invoice filed yet. "vat_quarter" marks a payment to or from the tax office. Excluded entries (own transfers, '
                . 'duplicates) do not count in any sum. Filing invoices on entries is a person\'s job.',
            'amount_column' => $bank['amount_column'],
            'count' => count($rows),
            'offset' => $offset,
            'sums' => ['in' => Cashflow::round2($in), 'out' => Cashflow::round2($out), 'net' => Cashflow::round2($in - $out)],
            'rows' => array_map(fn($r) => [
                'id' => $r['id'],
                'date' => $r['date'],
                'amount' => $r['amount'],
                'party' => $r['party'] !== '' ? $r['party'] : null,
                'details' => $r['data'],
                'vat' => $r['vat'],
                'invoice_pdf' => $r['pdf'] ? $r['pdf']['name'] : null,
                'invoice' => $r['pdf'] ? $this->invoiceFacts($r['pdf']['invoice']) : null,
                'needs_invoice' => $r['pdf'] === null && !$r['no_pdf_needed'] && empty($r['vat_quarter']),
                'no_invoice_needed' => $r['no_pdf_needed'],
                'excluded' => $r['excluded'],
                'vat_quarter' => $r['vat_quarter'] ?? null,
            ], array_slice($rows, $offset, $limit)),
        ];
    }

    /** What the Financials tab keeps: costs, balances, debts, VAT - without the projection. */
    private function financialsGet(array $p): array
    {
        $this->requireFinancials();
        $in = Cashflow::inputs($this->db, Cashflow::today());
        $today = $in['today'];
        $dates = array_column($in['transactions'], 'date');

        return [
            'today' => $today,
            'note' => 'Costs are entered net, like the projects\' amounts; the balance is what is in the account. A recurring cost '
                . 'falls every interval_months from start_month (until end_month) on its day (31 = the last day of the month). '
                . 'VAT per quarter comes from the bank entries and their invoices, due on the 15th of the second month after the '
                . 'quarter; "settled" once a bank entry is linked to it. For what this means month by month, use financials.forecast.',
            'balance_today' => Cashflow::balanceToday($in['balances'], $in['transactions']),
            'balances_entered' => $in['balances'],
            'cash_buffer' => $in['settings']['buffer'],
            'costs' => $in['costs'],
            'fixed_costs_per_month' => Cashflow::round2(Cashflow::monthlyFixed($in['costs'], $in['now'])),
            'debts' => Cashflow::debtSummary($in['debts'], $today),
            'vat_tracked_from' => Cashflow::vatFrom($in['settings'], $today),
            'vat_quarters' => Cashflow::vatQuarters($in['transactions'], $in['settings'], $today),
            'bank_entries' => ['count' => count($in['transactions']), 'latest' => $dates ? max($dates) : null,
                               'amount_column' => $in['amount_column']],
        ];
    }

    /** The cashflow forecast, worked out exactly as on the Financials tab. */
    private function financialsForecast(array $p): array
    {
        $this->requireFinancials();
        $months = $this->intRange($p, 'months', 1, 36) ?? Cashflow::DEFAULT_HORIZON;
        $preset = $this->enum($this->str($p, 'scenario', 16) ?? Cashflow::DEFAULT_PRESET, array_keys(Cashflow::PRESETS), 'scenario');
        $details = !array_key_exists('details', $p) || $p['details'] === null || $this->bool($p, 'details');

        $overrides = [];
        if (($budget = $this->str($p, 'budget', 8)) !== null) {
            $overrides['budget'] = $this->enum($budget, ['low', 'mid', 'high'], 'budget');
        }
        if (($chance = $this->str($p, 'chance', 8)) !== null) {
            $overrides['chance'] = $this->enum($chance, ['as_set', 'all'], 'chance') === 'all' ? 'all' : 'as';
        }
        if (isset($p['stages'])) {
            if (!is_array($p['stages'])) {
                throw new McpError('stages must be a list of: ' . implode(', ', Cashflow::STAGE_KEYS) . '.', 422);
            }
            $overrides['stages'] = array_map(fn($s) => $this->enum((string) $s, Cashflow::STAGE_KEYS, 'stages'), $p['stages']);
        }
        if (isset($p['exclude_project_ids'])) {
            if (!is_array($p['exclude_project_ids'])) {
                throw new McpError('exclude_project_ids must be a list of project ids.', 422);
            }
            $overrides['excluded'] = array_map(fn($id) => $this->id(['id' => $id], 'id'), $p['exclude_project_ids']);
        }

        $in = Cashflow::inputs($this->db, Cashflow::today());
        $base = ['projects' => $in['projects'], 'costs' => $in['costs'], 'balances' => $in['balances'], 'debts' => $in['debts'],
                 'settings' => $in['settings'], 'transactions' => $in['transactions'], 'now' => $in['now'], 'today' => $in['today'],
                 'months' => $months];
        $scenario = Cashflow::scenario($preset, $overrides);
        $plan = Cashflow::plan(['scenario' => $scenario] + $base);
        // The year's end needs a plan reaching December, whatever is asked for.
        $toDecember = $months >= 12 - $in['now']['month'] ? $plan : Cashflow::plan(['scenario' => $scenario, 'months' => 12] + $base);

        $compare = [];
        foreach (array_keys(Cashflow::PRESETS) as $key) {
            $other = $key === $scenario['name'] ? $plan : Cashflow::plan(['scenario' => Cashflow::scenario($key)] + $base);
            $compare[$key] = [
                'income_total' => $other['kpis']['income_total'],
                'end_balance' => $other['kpis']['end'],
                'lowest' => $other['kpis']['lowest'],
                'below_zero' => $other['kpis']['below_zero'],
                'below_buffer' => $other['kpis']['below_buffer'],
            ];
        }

        $presentIncome = fn(array $x) => [
            'project_id' => $x['project_id'],
            'project' => $x['name'],
            'stage' => $x['stage'],
            'kind' => $x['kind'] === 'payment' ? ($x['full'] ? 'payment in full' : 'expected payment') : 'rest of budget (final invoice)',
            'own_month' => $x['kind'] === 'payment' ? $x['month'] : ($x['due'] === null ? null : Cashflow::monthKey($x['due'], $in['now'])),
            'net' => Cashflow::round2($x['net']),
            'factor' => $x['factor'],
            'expected' => Cashflow::round2($x['expected']),
            'overdue' => $x['overdue'],
        ];
        $counted = array_values(array_filter($plan['income'], fn($x) => $x['counted']));

        return [
            'today' => $in['today'],
            'months' => $months,
            'scenario' => [
                'name' => $scenario['name'],
                'stages' => $scenario['stages'],
                'budget' => $scenario['budget'],
                'chance' => $scenario['chance'] === 'all' ? 'all 100%' : 'as set on each project',
                'excluded_projects' => array_keys(array_filter($scenario['excluded'])),
            ],
            'notes' => [
                'Same arithmetic as the Financials tab. All amounts are net, except the bank balance (what is in the account).',
                'Money in: every expected payment in its month (this month once it is overdue), and what the payments leave of '
                    . 'the budget in the project\'s end month as the final invoice - times the chance, unless the scenario '
                    . 'counts everything at 100%. Complete projects bring their unpaid payments in full, in every scenario.',
                'Money out: fixed and planned costs, loans repaid in their month with their interest, and each VAT quarter '
                    . 'not settled yet on the 15th of the second month after it (a negative vat is a refund). A cost of this '
                    . 'month counts as paid - and is left out - once Bookkeeping has its bank entry.',
                'Each month closes at its opening plus "in" less "out". The tab\'s own scenario is chosen per browser; this '
                    . 'answer uses the one asked for (default: realistic).',
            ],
            'balance_today' => $plan['balance'],
            'cash_buffer' => $plan['buffer'],
            'kpis' => $plan['kpis'],
            'months_ahead' => array_map(fn($r) => [
                'month' => $r['month'],
                'label' => $r['label'],
                'opening' => $r['opening'],
                'income' => $r['income'],
                'fixed_costs' => $r['fixed'],
                'planned_costs' => $r['planned'],
                'debt_repayments' => $r['debt'],
                'vat' => $r['vat'],
                'in' => $r['in'],
                'out' => $r['out'],
                'net' => $r['net'],
                'closing' => $r['closing'],
            ] + ($details ? ['items' => [
                'income' => array_map($presentIncome, $r['items']['income']),
                'costs' => $r['items']['costs'],
                'debts' => $r['items']['debts'],
                'vat' => array_map(fn($q) => ['quarter' => $q['label'], 'owed' => $q['owed'], 'due' => $q['due'], 'overdue' => $q['overdue']], $r['items']['vat']),
            ]] : []), $plan['rows']),
            'income_outside_the_months' => [
                'undated' => array_map($presentIncome, array_values(array_filter($counted, fn($x) => $x['offset'] === null))),
                'after_the_last_month' => array_map($presentIncome, array_values(array_filter($counted, fn($x) => $x['offset'] !== null && $x['offset'] >= $months))),
            ],
            'projects_left_out' => array_map(fn($m) => ['project_id' => $m['id'], 'project' => $m['name'], 'stage' => $m['stage'],
                                                        'missing' => $m['gaps']], $plan['missing']),
            'past_months' => $plan['past'],
            'vat_quarters' => array_map(fn($q) => array_diff_key($q, ['payment_rows' => 1]), $plan['vat']),
            'year' => Cashflow::yearResult($in['transactions'], $toDecember, $in['now']),
            'scenarios_compared' => $compare,
        ];
    }

    // =========================================================================
    // Writing - contacts
    // =========================================================================

    private function contactsCreate(array $p): array
    {
        $input = $this->contactInput($p);
        if (empty($input['name'])) {
            throw new McpError('name is required.', 422);
        }

        if (!$this->bool($p, 'allow_duplicate')) {
            $this->refuseDuplicateContact($input);
        }

        $this->geocodeInto($input);

        $contactModel = new Contact();
        $comment = $this->comment($p);

        $result = Database::transactional(function (PDO $db) use ($contactModel, $input, $comment) {
            $id = $contactModel->create($input);
            $db->prepare("UPDATE contacts SET review_status = 'pending' WHERE id = :id")->execute(['id' => $id]);

            $this->logActivity('contact', $id, $input['name'], $input['company'] ?? null, 'created', 'Kontakt vorgeschlagen');
            $reviewId = ReviewQueue::add('create', 'contact', $id, $input['name'], array_filter($input, fn($v) => $v !== null), null, $comment);

            return ['id' => $id, 'review_id' => $reviewId];
        });

        return $this->proposed('contact_id', $result['id'], $result['review_id'], 'The contact was created as a proposal.');
    }

    private function contactsUpdate(array $p): array
    {
        $id = $this->id($p, 'contact_id');
        $existing = $this->fetchContact($id);
        $changes = $this->changes($p);

        $clean = [];
        foreach ($changes as $field => $value) {
            if (!isset(self::CONTACT_FIELDS[$field])) {
                throw new McpError('Unknown contact field "' . $field . '". Allowed: ' . implode(', ', array_keys(self::CONTACT_FIELDS)) . '.', 422);
            }
            $clean[$field] = $this->contactValue($field, $value);
        }
        if (array_key_exists('name', $clean) && ($clean['name'] === null || $clean['name'] === '')) {
            throw new McpError('A contact cannot lose its name.', 422);
        }

        $diff = $this->diff($existing, $clean);
        if (empty($diff)) {
            return ['status' => 'no_change', 'message' => 'Those values are already set.'];
        }

        // Claude's own record, still under review: change it in place.
        if ($existing['review_status'] === ReviewQueue::PENDING) {
            $merged = array_merge($existing, $diff);
            $geoSourceBefore = $existing['location'] ?: $existing['address'];
            $geoSourceAfter = $merged['location'] ?: $merged['address'];
            if ($geoSourceAfter !== $geoSourceBefore) {
                $merged['latitude'] = null;
                $merged['longitude'] = null;
                $this->geocodeInto($merged);
            }
            (new Contact())->update($id, $merged);

            return ['status' => 'updated_pending_record', 'contact_id' => $id,
                    'message' => 'The contact is still a proposal, so it was changed directly. It still needs to be accepted.'];
        }

        $reviewIds = ReviewQueue::addUpdates('contact', $id, (string) $existing['name'], $diff, $this->pick($existing, array_keys($diff)), $this->comment($p));

        return $this->proposedChanges('contact_id', $id, $reviewIds);
    }

    private function contactsAddNote(array $p): array
    {
        $contactId = $this->id($p, 'contact_id');
        $contact = $this->fetchContact($contactId);
        $content = $this->str($p, 'content', 10000, true);
        $comment = $this->comment($p);

        $result = Database::transactional(function (PDO $db) use ($contact, $content, $comment) {
            $actor = Auth::actor();
            $db->prepare("
                INSERT INTO notes (contact_id, company, content, author_id, author_name, review_status)
                VALUES (:contact_id, :company, :content, :author_id, :author_name, 'pending')
            ")->execute([
                'contact_id' => (int) $contact['id'],
                'company' => $contact['company'],
                'content' => $content,
                'author_id' => $actor['id'],
                'author_name' => $actor['name'],
            ]);
            $noteId = (int) $db->lastInsertId();

            $label = $contact['name'] . ': ' . $this->excerpt($content);
            $reviewId = ReviewQueue::add('create', 'contact_note', $noteId, $label, ['content' => $content], null, $comment);

            return ['id' => $noteId, 'review_id' => $reviewId];
        });

        return $this->proposed('note_id', $result['id'], $result['review_id'], 'The note was added as a proposal.');
    }

    // =========================================================================
    // Writing - projects
    // =========================================================================

    private function projectsCreate(array $p): array
    {
        $data = $this->projectInput($p, null);
        $comment = $this->comment($p);

        $result = Database::transactional(function (PDO $db) use ($data, $comment) {
            $id = (new Project())->create($data);
            $db->prepare("UPDATE projects SET review_status = 'pending' WHERE id = :id")->execute(['id' => $id]);

            $this->logActivity('project', $id, $data['name'], $data['company'], 'created', 'Projekt vorgeschlagen');
            $reviewId = ReviewQueue::add('create', 'project', $id, $data['name'], array_filter($data, fn($v) => $v !== null), null, $comment);

            return ['id' => $id, 'review_id' => $reviewId];
        });

        return $this->proposed('project_id', $result['id'], $result['review_id'], 'The project was created as a proposal.');
    }

    private function projectsUpdate(array $p): array
    {
        $id = $this->id($p, 'project_id');
        $existing = $this->fetchProject($id);
        $changes = $this->changes($p);

        foreach (array_keys($changes) as $field) {
            if (!in_array($field, self::PROJECT_FIELDS, true)) {
                throw new McpError('Unknown project field "' . $field . '". Allowed: ' . implode(', ', self::PROJECT_FIELDS) . '.', 422);
            }
        }

        // Validate the merged result as a whole, so e.g. min/max budgets are
        // checked against each other, then keep only what actually changes.
        $merged = $this->projectInput(array_merge($this->pick($existing, self::PROJECT_FIELDS), $changes), $existing);
        $diff = $this->diff($existing, array_intersect_key($merged, $changes + ['budget_min' => 1, 'budget_max' => 1]));

        if (empty($diff)) {
            return ['status' => 'no_change', 'message' => 'Those values are already set.'];
        }

        if ($existing['review_status'] === ReviewQueue::PENDING) {
            (new Project())->update($id, $merged);

            return ['status' => 'updated_pending_record', 'project_id' => $id,
                    'message' => 'The project is still a proposal, so it was changed directly. It still needs to be accepted.'];
        }

        $reviewIds = ReviewQueue::addUpdates('project', $id, (string) $existing['name'], $diff, $this->pick($existing, array_keys($diff)), $this->comment($p));

        return $this->proposedChanges('project_id', $id, $reviewIds);
    }

    private function projectsAddNote(array $p): array
    {
        $projectId = $this->id($p, 'project_id');
        $project = $this->fetchProject($projectId);
        $content = $this->str($p, 'content', 10000, true);
        $comment = $this->comment($p);

        $result = Database::transactional(function (PDO $db) use ($project, $content, $comment) {
            $note = (new Project())->createNote((int) $project['id'], $content);
            $noteId = (int) ($note['id'] ?? 0);
            $db->prepare("UPDATE project_notes SET review_status = 'pending' WHERE id = :id")->execute(['id' => $noteId]);

            $label = $project['name'] . ': ' . $this->excerpt($content);
            $reviewId = ReviewQueue::add('create', 'project_note', $noteId, $label, ['content' => $content], null, $comment);

            return ['id' => $noteId, 'review_id' => $reviewId];
        });

        return $this->proposed('note_id', $result['id'], $result['review_id'], 'The note was added as a proposal.');
    }

    private function projectsLinkContact(array $p): array
    {
        $project = $this->fetchProject($this->id($p, 'project_id'));
        $contact = $this->fetchContact($this->id($p, 'contact_id'));

        if ($this->isLinked((int) $project['id'], (int) $contact['id'])) {
            return ['status' => 'no_change', 'message' => 'That contact is already on the project.'];
        }

        // If either side is itself a proposal, the link lives or dies with it.
        if ($project['review_status'] === ReviewQueue::PENDING || $contact['review_status'] === ReviewQueue::PENDING) {
            (new Project())->assignContact((int) $project['id'], (int) $contact['id']);

            return ['status' => 'linked_pending_record',
                    'message' => 'Linked directly, because the project or the contact is itself still a proposal.'];
        }

        $label = $project['name'] . ' ↔ ' . $contact['name'];
        $reviewId = ReviewQueue::add('link', 'project', (int) $project['id'], $label, ['contact_id' => (int) $contact['id']], null, $this->comment($p));

        return $this->proposed('project_id', (int) $project['id'], $reviewId, 'The link was proposed.');
    }

    private function projectsUnlinkContact(array $p): array
    {
        $project = $this->fetchProject($this->id($p, 'project_id'));
        $contact = $this->fetchContact($this->id($p, 'contact_id'));

        if (!$this->isLinked((int) $project['id'], (int) $contact['id'])) {
            return ['status' => 'no_change', 'message' => 'That contact is not on the project.'];
        }

        $label = $project['name'] . ' ↮ ' . $contact['name'];
        $reviewId = ReviewQueue::add('unlink', 'project', (int) $project['id'], $label, ['contact_id' => (int) $contact['id']], null, $this->comment($p));

        return $this->proposed('project_id', (int) $project['id'], $reviewId, 'Removing the contact from the project was proposed.');
    }

    private function projectsUploadDocument(array $p): array
    {
        $project = $this->fetchProject($this->id($p, 'project_id'));
        $label = $this->documentLabel($p, true);
        $filename = $this->str($p, 'filename', 200, true);

        $raw = $p['content_base64'] ?? null;
        if (!is_string($raw) || $raw === '') {
            throw new McpError('content_base64 is required.', 422);
        }

        $raw = preg_replace('/^data:[^;,]*;base64,/i', '', trim($raw));
        $bytes = base64_decode(preg_replace('/\s+/', '', (string) $raw), true);
        if ($bytes === false || $bytes === '') {
            throw new McpError('content_base64 is not valid base64.', 422);
        }

        // Written under its final name and checked there, by the same rules as
        // a file uploaded in the CRM itself.
        try {
            $stored = ProjectDocument::storeBytes($filename, $bytes, ProjectDocument::MAX_API_BYTES);
        } catch (InvalidArgumentException $e) {
            throw new McpError($e->getMessage(), 422);
        }

        $comment = $this->comment($p);

        try {
            $result = Database::transactional(function (PDO $db) use ($project, $label, $stored, $comment) {
                $documentId = ProjectDocument::insert(
                    (int) $project['id'], $label, $stored['name'], $stored['stored_name'], $stored['mime'], $stored['size'],
                    ReviewQueue::PENDING
                );

                $reviewId = ReviewQueue::add(
                    'create',
                    'project_document',
                    $documentId,
                    $project['name'] . ': ' . $stored['name'],
                    ['name' => $stored['name'], 'label' => $label, 'size' => $stored['size'], 'project_id' => (int) $project['id']],
                    null,
                    $comment
                );

                return ['document_id' => $documentId, 'review_id' => $reviewId];
            });
        } catch (Throwable $e) {
            @unlink($stored['path']);
            throw $e;
        }

        return [
            'status' => 'proposed',
            'document_id' => $result['document_id'],
            'review_id' => $result['review_id'],
            'message' => 'The document is attached to the project as "' . $label . '", marked as coming from ' . MCP_ACTOR_NAME
                . '. It waits for a person to accept or reject it.',
        ];
    }

    // =========================================================================
    // Writing - tags
    // =========================================================================

    private function tagsApply(array $p): array
    {
        [$type, $record] = $this->taggable($p);
        $tagName = $this->str($p, 'tag', 100, true);
        $color = $this->str($p, 'color', 7) ?? '';

        $tag = $this->findTag($tagName);
        if ($tag !== null && $this->hasTag($type, (int) $record['id'], (int) $tag['id'])) {
            return ['status' => 'no_change', 'message' => 'That tag is already set.'];
        }

        $recordName = (string) $record['name'];

        if ($tag !== null && $record['review_status'] === ReviewQueue::PENDING) {
            $junction = $type === 'contact' ? 'contact_tags' : 'project_tags';
            $column = $type === 'contact' ? 'contact_id' : 'project_id';
            $this->db->prepare("INSERT OR IGNORE INTO " . $junction . " (" . $column . ", tag_id) VALUES (:e, :t)")
                ->execute(['e' => (int) $record['id'], 't' => (int) $tag['id']]);

            return ['status' => 'tagged_pending_record', 'message' => 'Tagged directly, because the record is itself still a proposal.'];
        }

        $label = 'Tag „' . $tagName . '“ → ' . $recordName . ($tag === null ? ' (new tag)' : '');
        $reviewId = ReviewQueue::add('tag', $type, (int) $record['id'], $label, ['tag_name' => $tag['name'] ?? $tagName, 'color' => $color], null, $this->comment($p));

        return $this->proposed($type . '_id', (int) $record['id'], $reviewId, 'The tag was proposed.');
    }

    private function tagsRemove(array $p): array
    {
        [$type, $record] = $this->taggable($p);
        $tagName = $this->str($p, 'tag', 100, true);

        $tag = $this->findTag($tagName);
        if ($tag === null || !$this->hasTag($type, (int) $record['id'], (int) $tag['id'])) {
            return ['status' => 'no_change', 'message' => 'That tag is not set on this record.'];
        }

        $label = 'Tag „' . $tag['name'] . '“ entfernen: ' . $record['name'];
        $reviewId = ReviewQueue::add('untag', $type, (int) $record['id'], $label, ['tag_id' => (int) $tag['id'], 'tag_name' => $tag['name']], null, $this->comment($p));

        return $this->proposed($type . '_id', (int) $record['id'], $reviewId, 'Removing the tag was proposed.');
    }

    // =========================================================================
    // Writing - to-dos
    // =========================================================================

    private function todosCreate(array $p): array
    {
        $title = $this->str($p, 'title', 255, true);
        $description = $this->str($p, 'description', 10000);
        $dueDate = $this->date($p, 'due_date');
        $priority = $this->priority($p['priority'] ?? null);

        $contactId = $this->id($p, 'contact_id', false);
        $projectId = $this->id($p, 'project_id', false);
        if (($contactId === null) === ($projectId === null)) {
            throw new McpError('Give exactly one of contact_id or project_id.', 422);
        }
        if ($contactId !== null) {
            $this->fetchContact($contactId);
        } else {
            $this->fetchProject($projectId);
        }
        $comment = $this->comment($p);

        $result = Database::transactional(function (PDO $db) use ($title, $description, $dueDate, $priority, $contactId, $projectId, $comment) {
            $actor = Auth::actor();
            $insert = $db->prepare("
                INSERT INTO todos (title, description, due_date, priority, is_completed, contact_id, project_id, parent_todo_id,
                                   created_by, created_by_name, updated_by, updated_by_name, review_status)
                VALUES (:title, :description, :due_date, :priority, 0, :contact_id, :project_id, :parent,
                        :actor_id, :actor_name, :actor_id2, :actor_name2, 'pending')
            ");

            $row = [
                'title' => $title,
                'description' => $description,
                'due_date' => $dueDate,
                'priority' => $priority,
                'actor_id' => $actor['id'],
                'actor_name' => $actor['name'],
                'actor_id2' => $actor['id'],
                'actor_name2' => $actor['name'],
            ];

            $insert->execute($row + ['contact_id' => $contactId, 'project_id' => $projectId, 'parent' => null]);
            $todoId = (int) $db->lastInsertId();

            // A project to-do is mirrored to each of the project's contacts,
            // exactly as todos.php does it.
            if ($projectId !== null) {
                $contacts = $db->prepare("SELECT contact_id FROM project_contacts WHERE project_id = :p ORDER BY contact_id");
                $contacts->execute(['p' => $projectId]);
                foreach ($contacts->fetchAll(PDO::FETCH_COLUMN) as $cid) {
                    $insert->execute($row + ['contact_id' => (int) $cid, 'project_id' => $projectId, 'parent' => $todoId]);
                }
            }

            $reviewId = ReviewQueue::add('create', 'todo', $todoId, $title, array_filter([
                'title' => $title, 'description' => $description, 'due_date' => $dueDate, 'priority' => $priority,
                'contact_id' => $contactId, 'project_id' => $projectId,
            ], fn($v) => $v !== null), null, $comment);

            return ['id' => $todoId, 'review_id' => $reviewId];
        });

        return $this->proposed('todo_id', $result['id'], $result['review_id'], 'The to-do was created as a proposal.');
    }

    private function todosUpdate(array $p): array
    {
        $todo = $this->fetchTodoRoot($this->id($p, 'todo_id'));
        $changes = $this->changes($p);

        $clean = [];
        foreach ($changes as $field => $value) {
            switch ($field) {
                case 'title':
                    $clean['title'] = $this->str(['title' => $value], 'title', 255, true);
                    break;
                case 'description':
                    $clean['description'] = $this->str(['description' => $value], 'description', 10000);
                    break;
                case 'due_date':
                    $clean['due_date'] = $this->date(['due_date' => $value], 'due_date');
                    break;
                case 'priority':
                    $clean['priority'] = $this->priority($value);
                    break;
                case 'is_completed':
                    $clean['is_completed'] = $this->bool(['is_completed' => $value], 'is_completed') ? 1 : 0;
                    break;
                default:
                    throw new McpError('Unknown to-do field "' . $field . '". Allowed: ' . implode(', ', self::TODO_FIELDS) . '.', 422);
            }
        }

        $diff = $this->diff($todo, $clean);
        if (empty($diff)) {
            return ['status' => 'no_change', 'message' => 'Those values are already set.'];
        }

        if ($todo['review_status'] === ReviewQueue::PENDING) {
            $sets = [];
            $params = ['id' => (int) $todo['id'], 'id2' => (int) $todo['id']];
            foreach ($diff as $field => $value) {
                $sets[] = $field . ' = :' . $field;
                $params[$field] = $value;
            }
            $this->db->prepare("UPDATE todos SET " . implode(', ', $sets) . ", updated_at = CURRENT_TIMESTAMP WHERE id = :id OR parent_todo_id = :id2")
                ->execute($params);

            return ['status' => 'updated_pending_record', 'todo_id' => (int) $todo['id'],
                    'message' => 'The to-do is still a proposal, so it was changed directly. It still needs to be accepted.'];
        }

        $reviewIds = ReviewQueue::addUpdates('todo', (int) $todo['id'], (string) $todo['title'], $diff, $this->pick($todo, array_keys($diff)), $this->comment($p));

        return $this->proposedChanges('todo_id', (int) $todo['id'], $reviewIds);
    }

    // =========================================================================
    // Writing - assignment and deletion
    // =========================================================================

    private function recordsAssign(array $p): array
    {
        $type = $this->enum($this->str($p, 'entity', 32, true), ['contact', 'project', 'todo'], 'entity');
        $id = $this->id($p, 'id');

        switch ($type) {
            case 'contact':
                $record = $this->fetchContact($id);
                $label = (string) $record['name'];
                break;
            case 'project':
                $record = $this->fetchProject($id);
                $label = (string) $record['name'];
                break;
            default:
                $record = $this->fetchTodoRoot($id);
                $id = (int) $record['id'];
                $label = (string) $record['title'];
        }

        $assignee = $this->resolveAssignee($p['user_id'] ?? null);

        $current = $record['assigned_to'] === null ? null : (int) $record['assigned_to'];
        if ($current === $assignee['id']) {
            return ['status' => 'no_change', 'message' => 'It is already assigned that way.'];
        }

        if (($record['review_status'] ?? null) === ReviewQueue::PENDING) {
            $table = ReviewQueue::ENTITY_TABLES[$type];
            $this->db->prepare("UPDATE " . $table . " SET assigned_to = :a, assigned_to_name = :n WHERE id = :id")
                ->execute(['a' => $assignee['id'], 'n' => $assignee['name'], 'id' => $id]);
            // Shows as new for the assignee once the record is accepted.
            AssignmentFeed::record($this->db, $type, $id, $assignee['id'], null, MCP_ACTOR_NAME);

            return ['status' => 'assigned_pending_record', 'message' => 'Assigned directly, because the record is itself still a proposal.'];
        }

        $reviewId = ReviewQueue::add(
            'assign',
            $type,
            $id,
            $label . ' → ' . ($assignee['name'] ?? 'niemand'),
            ['assigned_to' => $assignee['id'], 'assigned_to_name' => $assignee['name']],
            ['assigned_to' => $current, 'assigned_to_name' => $record['assigned_to_name']],
            $this->comment($p)
        );

        return $this->proposed('id', $id, $reviewId, 'The assignment was proposed.');
    }

    private function recordsDelete(array $p): array
    {
        $type = $this->enum($this->str($p, 'entity', 32, true), ['contact', 'project', 'todo', 'contact_note', 'project_note'], 'entity');
        $id = $this->id($p, 'id');

        switch ($type) {
            case 'contact':
                $record = $this->fetchContact($id);
                $label = (string) $record['name'];
                break;
            case 'project':
                $record = $this->fetchProject($id);
                $label = (string) $record['name'];
                break;
            case 'todo':
                $record = $this->fetchTodoRoot($id);
                $id = (int) $record['id'];
                $label = (string) $record['title'];
                break;
            default:
                $table = ReviewQueue::ENTITY_TABLES[$type];
                $stmt = $this->db->prepare("SELECT * FROM " . $table . " WHERE id = :id");
                $stmt->execute(['id' => $id]);
                $record = $stmt->fetch();
                if (!$record) {
                    throw new McpError('Note not found.', 404);
                }
                $label = $this->excerpt((string) $record['content']);
        }

        // Taking back its own proposal needs nobody's approval.
        if (($record['review_status'] ?? null) === ReviewQueue::PENDING) {
            $create = ReviewQueue::pendingCreateFor($type, $id);
            if ($create !== null) {
                ReviewQueue::withdraw((int) $create['id']);

                return ['status' => 'withdrawn', 'message' => 'That record was your own open proposal, so it was withdrawn and removed.'];
            }
        }

        $reviewId = ReviewQueue::add('delete', $type, $id, $label, [], $this->deletionSnapshot($type, $record), $this->comment($p));

        return $this->proposed('id', $id, $reviewId, $type === 'project'
            ? 'Archiving it was proposed. Nothing is archived unless a person accepts.'
            : 'Deleting it was proposed. Nothing is deleted unless a person accepts.');
    }

    // =========================================================================
    // Writing - bookkeeping
    // =========================================================================

    private function bookkeepingUploadPdf(array $p): array
    {
        $this->requireBookkeeping();

        $name = $this->pdfFileName($this->str($p, 'filename', 200, true));
        $raw = $p['content_base64'] ?? null;
        if (!is_string($raw) || $raw === '') {
            throw new McpError('content_base64 is required.', 422);
        }

        $raw = preg_replace('/^data:application\/pdf;base64,/i', '', trim($raw));
        $bytes = base64_decode(preg_replace('/\s+/', '', (string) $raw), true);
        if ($bytes === false || $bytes === '') {
            throw new McpError('content_base64 is not valid base64.', 422);
        }
        if (strlen($bytes) > self::MAX_PDF_BYTES) {
            throw new McpError('The PDF is larger than 10 MB. Ask the user to upload it in the CRM instead.', 413);
        }
        if (strncmp($bytes, '%PDF-', 5) !== 0 || (new finfo(FILEINFO_MIME_TYPE))->buffer($bytes) !== 'application/pdf') {
            throw new McpError('That file is not a PDF.', 422);
        }

        $dir = DATA_DIR . '/bookkeeping_pdfs';
        if (!is_dir($dir)) {
            throw new McpError('The invoice folder does not exist yet. Ask the user to open Bookkeeping in the CRM once.', 409);
        }

        $storedName = date('Ymd_His') . '_' . bin2hex(random_bytes(8)) . '.pdf';
        $target = $dir . '/' . $storedName;
        if (file_put_contents($target, $bytes, LOCK_EX) !== strlen($bytes)) {
            @unlink($target);
            throw new McpError('The server could not store the file.', 500);
        }

        $comment = $this->comment($p);

        try {
            $result = Database::transactional(function (PDO $db) use ($name, $storedName, $bytes, $comment) {
                // Into the pool only. Filing it on its row is a person's job
                // (dragging it there also accepts the upload).
                $db->prepare("
                    INSERT INTO bookkeeping_pdfs (row_id, original_name, stored_name, file_size, review_status)
                    VALUES (NULL, :name, :stored, :size, 'pending')
                ")->execute(['name' => $name, 'stored' => $storedName, 'size' => strlen($bytes)]);
                $pdfId = (int) $db->lastInsertId();

                $reviewId = ReviewQueue::add('create', 'bookkeeping_pdf', $pdfId, $name, ['name' => $name, 'size' => strlen($bytes)], null, $comment);

                return ['pdf_id' => $pdfId, 'review_id' => $reviewId];
            });
        } catch (Throwable $e) {
            @unlink($target);
            throw $e;
        }

        return [
            'status' => 'proposed',
            'pdf_id' => $result['pdf_id'],
            'review_id' => $result['review_id'],
            'message' => 'The PDF is in the bookkeeping drop zone, marked as coming from ' . MCP_ACTOR_NAME
                . '. The user files it on its bank entry and accepts it there.',
        ];
    }

    private function reviewsWithdraw(array $p): array
    {
        $item = ReviewQueue::get($this->id($p, 'review_id'));
        if ($item === null) {
            throw new McpError('Proposal not found.', 404);
        }
        if ($item['status'] !== ReviewQueue::PENDING) {
            throw new McpError('That proposal has already been decided (' . $item['status'] . ').', 409);
        }

        ReviewQueue::withdraw((int) $item['id']);

        return ['status' => 'withdrawn', 'review_id' => (int) $item['id']];
    }

    // =========================================================================
    // Writing - expected payments
    // =========================================================================

    /**
     * Propose a project's whole list of expected payments. It replaces the
     * list as one field of the project, so the reviewer sees the old and the
     * new plan side by side and accepts or rejects it as a whole.
     */
    private function projectsSetPayments(array $p): array
    {
        $project = $this->fetchProject($this->id($p, 'project_id'));
        if (!array_key_exists('payments', $p) || !is_array($p['payments'])) {
            throw new McpError('payments must be a list of {month: "YYYY-MM", amount, paid?, full?} - an empty list removes every payment.', 422);
        }
        $payments = Project::normalizePayments($p['payments']);
        if (is_string($payments)) {
            throw new McpError($payments . '.', 422);
        }

        return $this->proposePayments($project, $payments, $p);
    }

    /** Propose marking one expected payment as received. */
    private function projectsMarkPaymentPaid(array $p): array
    {
        $project = $this->fetchProject($this->id($p, 'project_id'));
        $month = $this->month($p, 'month', true);
        $amount = $this->number($p, 'amount');

        $payments = $this->storedPayments((int) $project['id']);
        $hits = [];
        foreach ($payments as $i => $payment) {
            if (empty($payment['paid']) && $payment['month'] === $month
                && ($amount === null || abs((float) $payment['amount'] - $amount) < 0.005)) {
                $hits[] = $i;
            }
        }

        if (!$hits) {
            $open = array_values(array_filter($payments, fn($x) => empty($x['paid'])));
            throw new McpError('This project has no unpaid payment ' . ($amount !== null ? 'of ' . $amount . ' ' : '') . 'in ' . $month . '. '
                . ($open
                    ? 'Its unpaid payments: ' . implode(', ', array_map(fn($x) => $x['month'] . ' ' . $x['amount'], $open)) . '.'
                    : 'It has no unpaid payments.')
                . ' To change amounts or months, use projects.set_payments.', 404);
        }
        $amounts = array_unique(array_map(fn($i) => (float) $payments[$i]['amount'], $hits));
        if (count($amounts) > 1) {
            throw new McpError('There are several unpaid payments in ' . $month . ' (' . implode(', ', $amounts) . '). Pass the amount too.', 422);
        }

        $payments[$hits[0]]['paid'] = true;

        return $this->proposePayments($project, $payments, $p);
    }

    private function proposePayments(array $project, array $payments, array $p): array
    {
        $id = (int) $project['id'];
        $before = $this->storedPayments($id);
        if (json_encode($before) === json_encode($payments)) {
            return ['status' => 'no_change', 'message' => 'The project already has exactly these payments.'];
        }

        // Two open proposals for the same list would overwrite each other.
        foreach (ReviewQueue::listItems('pending', 200, 'project', $id) as $item) {
            if ($item['kind'] === 'update' && array_key_exists('payments', (array) $item['payload'])) {
                throw new McpError('There is already an open proposal for this project\'s payments (review_id ' . $item['id'] . '). '
                    . 'Wait until a person has decided on it, or withdraw it (reviews.withdraw) and propose again.', 409);
            }
        }

        $warnings = $this->paymentWarnings($project, $payments);

        if ($project['review_status'] === ReviewQueue::PENDING) {
            (new Project())->update($id, $this->pick($project, self::PROJECT_FIELDS) + ['payments' => $payments]);

            return ['status' => 'updated_pending_record', 'project_id' => $id, 'payments' => $payments, 'warnings' => $warnings,
                    'message' => 'The project is still a proposal, so its payments were changed directly. It still needs to be accepted.'];
        }

        $reviewIds = ReviewQueue::addUpdates('project', $id, (string) $project['name'], ['payments' => $payments], ['payments' => $before], $this->comment($p));

        return $this->proposedChanges('project_id', $id, $reviewIds) + [
            'payments' => $payments,
            'previous_payments' => $before,
            'warnings' => $warnings,
        ];
    }

    /** The project's stored payments, cleaned the way a save cleans them. */
    private function storedPayments(int $id): array
    {
        $stmt = $this->db->prepare("SELECT payments FROM projects WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $decoded = Project::decodePayments($stmt->fetchColumn() ?: null);
        $clean = Project::normalizePayments($decoded);

        return is_array($clean) ? $clean : $decoded;
    }

    /**
     * What the project sheet would object to or point out - said to Claude,
     * not refused: the CRM itself stores these too.
     */
    private function paymentWarnings(array $project, array $payments): array
    {
        $warnings = [];
        $index = fn(string $ym) => (int) substr($ym, 0, 4) * 12 + (int) substr($ym, 5, 2);
        $end = $project['estimated_completion'] ? $index(substr((string) $project['estimated_completion'], 0, 7)) : null;
        $current = $index(Cashflow::today()->format('Y-m'));

        foreach ($payments as $payment) {
            if ($end !== null && $index($payment['month']) > $end + 3) {
                $warnings[] = 'The payment in ' . $payment['month'] . ' lies more than three months after the project\'s planned end - '
                    . 'the project sheet only offers months up to three after it.';
            }
            if (empty($payment['paid']) && $index($payment['month']) < $current) {
                $warnings[] = 'The payment in ' . $payment['month'] . ' lies in the past and is not marked as paid, so it counts as overdue.';
            }
        }

        $summary = $this->paymentsSummary($project, $payments);
        if ($summary['above_budget'] > 0.005) {
            $warnings[] = 'The payments add up to ' . $summary['planned'] . ', ' . Cashflow::round2($summary['above_budget'])
                . ' more than the budget - the payments then count as the project\'s total.';
        }

        return $warnings;
    }

    /**
     * Where the payments stand against the budget, as the project sheet says
     * it (project-payments.js summarize).
     */
    private function paymentsSummary(array $project, array $payments): array
    {
        $list = Cashflow::parsePayments($payments);
        $planned = array_sum(array_column($list, 'amount'));
        $paid = array_sum(array_column(array_filter($list, fn($x) => $x['paid']), 'amount'));
        $full = Cashflow::isFull($list);

        $budget = null;
        if (!$full) {
            $min = Cashflow::number($project['budget_min'] ?? null);
            $max = Cashflow::number($project['budget_max'] ?? null);
            $min ??= $max;
            $max ??= $min;
            if ($min !== null) {
                $min = max(0.0, $min);
                $max = max(0.0, $max);
                if ($min > $max) {
                    [$min, $max] = [$max, $min];
                }
                $budget = $max > 0 ? ['min' => $min, 'max' => $max] : null;
            }
        }

        $out = [
            'count' => count($list),
            'paid_count' => count(array_filter($list, fn($x) => $x['paid'])),
            'planned' => Cashflow::round2($planned),
            'paid' => Cashflow::round2($paid),
            'payment_in_full' => $full,
            'budget' => $budget,
            'above_budget' => 0.0,
            'below_budget' => 0.0,
            'not_planned_yet' => null,
        ];
        if ($budget) {
            $out['above_budget'] = Cashflow::round2(max(0, $planned - $budget['max']));
            $out['below_budget'] = Cashflow::round2(max(0, $budget['min'] - $planned));
            $out['not_planned_yet'] = ['min' => Cashflow::round2(max(0, $budget['min'] - $planned)), 'max' => Cashflow::round2(max(0, $budget['max'] - $planned))];
            $out['still_to_pay'] = ['min' => Cashflow::round2(max($budget['min'], $planned) - $paid), 'max' => Cashflow::round2(max($budget['max'], $planned) - $paid)];
        } else {
            $out['still_to_pay'] = ['min' => Cashflow::round2($planned - $paid), 'max' => Cashflow::round2($planned - $paid)];
        }

        return $out;
    }

    /** What the invoice reader found in a PDF, without its bookkeeping. */
    private function invoiceFacts($data): ?array
    {
        if (is_string($data)) {
            $data = json_decode($data, true);
        }
        if (!is_array($data)) {
            return null;
        }
        $keep = ['kind', 'issuer', 'recipient', 'invoice_number', 'invoice_date', 'due_date', 'subject', 'currency', 'net', 'vat', 'gross'];

        return array_intersect_key($data, array_flip($keep));
    }

    private function requireFinancials(): void
    {
        if (!MCP_API_FINANCIALS) {
            throw new McpError('Bank entries, Financials and the cashflow forecast are switched off for ' . MCP_ACTOR_NAME
                . ' in this CRM (MCP_API_FINANCIALS).', 403);
        }
    }

    // =========================================================================
    // Record helpers
    // =========================================================================

    private function fetchContact(int $id): array
    {
        $stmt = $this->db->prepare("
            SELECT id, name, company, location, latitude, longitude, email, phone, website, address, note,
                   assigned_to, assigned_to_name, review_status, created_by_name, created_at, updated_by_name, updated_at
            FROM contacts WHERE id = :id
        ");
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new McpError('Contact ' . $id . ' not found.', 404);
        }

        return $row;
    }

    private function fetchProject(int $id): array
    {
        $stmt = $this->db->prepare("
            SELECT id, name, company, stage, description, start_date, estimated_completion, budget_min, budget_max,
                   success_chance, assigned_to, assigned_to_name, review_status, created_by_name, created_at, updated_by_name, updated_at
            FROM projects WHERE id = :id
        ");
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new McpError('Project ' . $id . ' not found.', 404);
        }

        return $row;
    }

    /** A to-do by id; a mirrored copy resolves to the to-do it mirrors. */
    private function fetchTodoRoot(int $id): array
    {
        $stmt = $this->db->prepare("SELECT COALESCE(parent_todo_id, id) FROM todos WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $rootId = $stmt->fetchColumn();
        if ($rootId === false) {
            throw new McpError('To-do ' . $id . ' not found.', 404);
        }

        $stmt = $this->db->prepare("
            SELECT id, title, description, due_date, priority, is_completed, contact_id, project_id,
                   assigned_to, assigned_to_name, review_status
            FROM todos WHERE id = :id
        ");
        $stmt->execute(['id' => (int) $rootId]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new McpError('To-do ' . $id . ' not found.', 404);
        }
        $row['is_completed'] = (int) $row['is_completed'];

        return $row;
    }

    private function fetchDocument(int $id): array
    {
        $row = ProjectDocument::find($id);
        if ($row === null) {
            throw new McpError('Document ' . $id . ' not found.', 404);
        }

        return $row;
    }

    /** One of the document labels, written as the CRM writes it. */
    private function documentLabel(array $p, bool $required): ?string
    {
        $raw = $this->str($p, 'label', 32, $required);
        if ($raw === null) {
            return null;
        }

        $label = ProjectDocument::label($raw);
        if ($label === null) {
            throw new McpError('label must be one of: ' . implode(', ', ProjectDocument::LABELS) . '.', 422);
        }

        return $label;
    }

    private function requireBookkeeping(): void
    {
        if (!ReviewQueue::tableExists('bookkeeping_pdfs')) {
            throw new McpError('Bookkeeping has not been set up in the CRM yet.', 409);
        }
    }

    private function pdfFileName(string $name): string
    {
        $name = basename(str_replace('\\', '/', $name));
        $name = preg_replace('/[^\w.\- ()\[\]äöüÄÖÜéèàç]/u', '_', $name) ?? 'invoice.pdf';
        if ($name === '' || $name === '.' || $name === '..') {
            $name = 'invoice.pdf';
        }
        if (strtolower(pathinfo($name, PATHINFO_EXTENSION)) !== 'pdf') {
            $name .= '.pdf';
        }

        return mb_substr($name, 0, 200);
    }

    private function isLinked(int $projectId, int $contactId): bool
    {
        $stmt = $this->db->prepare("SELECT 1 FROM project_contacts WHERE project_id = :p AND contact_id = :c");
        $stmt->execute(['p' => $projectId, 'c' => $contactId]);

        return (bool) $stmt->fetchColumn();
    }

    /** @return array{0: string, 1: array} */
    private function taggable(array $p): array
    {
        $type = $this->enum($this->str($p, 'entity', 16, true), ['contact', 'project'], 'entity');
        $id = $this->id($p, 'id');

        return [$type, $type === 'contact' ? $this->fetchContact($id) : $this->fetchProject($id)];
    }

    private function findTag(string $name): ?array
    {
        $stmt = $this->db->prepare("SELECT id, name, color FROM tags WHERE LOWER(name) = LOWER(:name)");
        $stmt->execute(['name' => $name]);
        $tag = $stmt->fetch();

        return $tag ?: null;
    }

    private function hasTag(string $type, int $id, int $tagId): bool
    {
        $sql = $type === 'contact'
            ? "SELECT 1 FROM contact_tags WHERE contact_id = :id AND tag_id = :t"
            : "SELECT 1 FROM project_tags WHERE project_id = :id AND tag_id = :t";
        $stmt = $this->db->prepare($sql);
        $stmt->execute(['id' => $id, 't' => $tagId]);

        return (bool) $stmt->fetchColumn();
    }

    /** Same rules as api/assign.php: nobody, or an account that is not disabled. Never the owner login. */
    private function resolveAssignee($raw): array
    {
        if ($raw === null || $raw === '' || $raw === 'none') {
            return ['id' => null, 'name' => null];
        }
        if (!is_numeric($raw) || (int) $raw <= 0) {
            throw new McpError('user_id must be a team member id from meta, or null to unassign.', 422);
        }

        $stmt = $this->db->prepare("SELECT id, name, status FROM users WHERE id = :id");
        $stmt->execute(['id' => (int) $raw]);
        $user = $stmt->fetch();
        if (!$user || $user['status'] === 'disabled') {
            throw new McpError('That person cannot be assigned work.', 422);
        }

        return ['id' => (int) $user['id'], 'name' => (string) $user['name']];
    }

    private function proposalsFor(string $type, int $id): array
    {
        return array_map([$this, 'publicProposal'], ReviewQueue::listItems('pending', 50, $type, $id));
    }

    private function publicProposal(array $item): array
    {
        return [
            'review_id' => $item['id'],
            'kind' => $item['kind'],
            'entity' => $item['entity_type'],
            'entity_id' => $item['entity_id'],
            'label' => $item['entity_label'],
            'proposed' => $item['payload'],
            'previous' => $item['previous'],
            'comment' => $item['comment'],
            'status' => $item['status'],
            'created_at' => $item['created_at'],
            'resolved_at' => $item['resolved_at'],
            'resolved_by' => $item['resolved_by_name'],
        ];
    }

    private function deletionSnapshot(string $type, array $record): array
    {
        $keep = [
            'contact' => ['name', 'company', 'email', 'phone', 'location'],
            'project' => ['name', 'company', 'stage'],
            'todo' => ['title', 'due_date', 'is_completed'],
            'contact_note' => ['content'],
            'project_note' => ['content'],
        ][$type] ?? [];

        return $this->pick($record, $keep);
    }

    private function logActivity(string $type, int $id, string $name, ?string $company, string $action, string $content): void
    {
        $isContact = $type === 'contact';
        $prefix = $isContact ? 'contact' : 'project';
        $actor = Auth::actor();

        $this->db->prepare("
            INSERT INTO activity_events (entry_type, action, content, {$prefix}_id, {$prefix}_name, {$prefix}_company, actor_id, actor_name)
            VALUES (:entry_type, :action, :content, :id, :name, :company, :actor_id, :actor_name)
        ")->execute([
            'entry_type' => $prefix . '_activity',
            'action' => $action,
            'content' => $content,
            'id' => $id,
            'name' => $name,
            'company' => $company,
            'actor_id' => $actor['id'],
            'actor_name' => $actor['name'],
        ]);
    }

    private function refuseDuplicateContact(array $input): void
    {
        if (!empty($input['email'])) {
            $stmt = $this->db->prepare("SELECT id, name FROM contacts WHERE LOWER(email) = LOWER(:e) LIMIT 1");
            $stmt->execute(['e' => $input['email']]);
            if ($match = $stmt->fetch()) {
                throw new McpError('A contact with that email already exists: #' . $match['id'] . ' ' . $match['name']
                    . '. Use contacts.update, or pass allow_duplicate=true if it really is a different person.', 409);
            }
        }

        $stmt = $this->db->prepare("
            SELECT id FROM contacts
            WHERE LOWER(TRIM(name)) = LOWER(:n) AND LOWER(TRIM(COALESCE(company, ''))) = LOWER(:c) LIMIT 1
        ");
        $stmt->execute(['n' => $input['name'], 'c' => (string) ($input['company'] ?? '')]);
        if ($id = $stmt->fetchColumn()) {
            throw new McpError('A contact with that name and company already exists: #' . $id
                . '. Use contacts.update, or pass allow_duplicate=true if it really is a different person.', 409);
        }
    }

    /**
     * Look up coordinates for a contact's location (or address), as the CRM
     * does when a contact is saved, so a proposed contact appears on the map.
     */
    private function geocodeInto(array &$contact): void
    {
        if (!empty($contact['latitude']) && !empty($contact['longitude'])) {
            return;
        }
        $query = !empty($contact['location']) ? $contact['location'] : ($contact['address'] ?? null);
        if (empty($query)) {
            return;
        }

        $url = 'https://nominatim.openstreetmap.org/search?' . http_build_query(['q' => $query, 'format' => 'json', 'limit' => 1]);
        $context = stream_context_create(['http' => ['header' => 'User-Agent: SimpleCRM/1.0', 'timeout' => 5]]);
        $response = @file_get_contents($url, false, $context);
        $data = $response === false ? null : json_decode($response, true);

        if (isset($data[0]['lat'], $data[0]['lon'])) {
            $contact['latitude'] = (float) $data[0]['lat'];
            $contact['longitude'] = (float) $data[0]['lon'];
        }
    }

    // =========================================================================
    // Input helpers
    // =========================================================================

    private function contactInput(array $p): array
    {
        $input = [];
        foreach (array_keys(self::CONTACT_FIELDS) as $field) {
            $input[$field] = array_key_exists($field, $p) ? $this->contactValue($field, $p[$field]) : null;
        }
        $input['latitude'] = null;
        $input['longitude'] = null;

        return $input;
    }

    /** One contact field, validated the way the contact form's endpoint does it. */
    private function contactValue(string $field, $value): ?string
    {
        if ($value !== null && !is_scalar($value)) {
            throw new McpError($field . ' must be text.', 422);
        }
        $value = $value === null ? null : trim((string) $value);
        if ($value === '' || $value === null) {
            return null;
        }

        switch ($field) {
            case 'email':
                if (!filter_var($value, FILTER_VALIDATE_EMAIL)) {
                    throw new McpError('"' . mb_substr($value, 0, 80) . '" is not a valid email address.', 422);
                }
                return Auth::sanitizeEmail($value);
            case 'phone':
                return Auth::sanitizePhone($value);
            case 'website':
                $url = Auth::sanitizeUrl($value);
                if ($url === null) {
                    throw new McpError('That website address is not allowed.', 422);
                }
                return Contact::normalizeWebsite($url);
            default:
                return Auth::sanitizeString($value, self::CONTACT_FIELDS[$field]);
        }
    }

    /**
     * A project's fields, validated as api/projects.php does. With $existing,
     * fields missing from $p keep their current value.
     */
    private function projectInput(array $p, ?array $existing): array
    {
        $name = $this->str($p, 'name', 255, true);
        $description = $this->str($p, 'description', 10000);
        if ($description === null) {
            throw new McpError('description is required - one or two sentences on what the project is.', 422);
        }

        $startDate = $this->date($p, 'start_date') ?? ($existing['start_date'] ?? date('Y-m-d'));
        $estimated = $this->date($p, 'estimated_completion');
        $company = $this->str($p, 'company', 255);

        $stageRaw = $this->str($p, 'stage', 50) ?? 'Lead';
        $stage = $this->enum($stageRaw, self::STAGES, 'stage');

        $budgetMin = $this->number($p, 'budget_min');
        $budgetMax = $this->number($p, 'budget_max');
        if ($budgetMin !== null && $budgetMax !== null && $budgetMin > $budgetMax) {
            [$budgetMin, $budgetMax] = [$budgetMax, $budgetMin];
        }

        $chance = $this->intRange($p, 'success_chance', 0, 100);

        return [
            'name' => $name,
            'description' => $description,
            'start_date' => $startDate,
            'estimated_completion' => $estimated,
            'company' => $company,
            'stage' => $stage,
            'budget_min' => $budgetMin,
            'budget_max' => $budgetMax,
            'success_chance' => $chance,
        ];
    }

    private function changes(array $p): array
    {
        $changes = $p['changes'] ?? null;
        if (!is_array($changes) || empty($changes) || array_values($changes) === $changes) {
            throw new McpError('changes must be an object of field names and new values, e.g. {"phone": "+43 1 234"}.', 422);
        }

        return $changes;
    }

    /** Only the fields whose value actually differs from the record. */
    private function diff(array $record, array $proposed): array
    {
        $diff = [];
        foreach ($proposed as $field => $value) {
            $old = $record[$field] ?? null;
            $normalize = function ($v) {
                if ($v === null) {
                    return '';
                }
                if (is_bool($v)) {
                    return $v ? '1' : '0';
                }
                if (is_numeric($v)) {
                    return (string) (float) $v;
                }
                return trim((string) $v);
            };
            if ($normalize($old) !== $normalize($value)) {
                $diff[$field] = $value;
            }
        }

        return $diff;
    }

    private function pick(array $record, array $keys): array
    {
        return array_intersect_key($record, array_flip($keys));
    }

    private function proposed(string $idKey, int $id, int $reviewId, string $message): array
    {
        return [
            'status' => 'proposed',
            $idKey => $id,
            'review_id' => $reviewId,
            'message' => $message . ' It is marked in the CRM as coming from ' . MCP_ACTOR_NAME
                . ' and waits for a person to accept, edit or reject it.',
        ];
    }

    /** A change to several fields is proposed one field at a time (ReviewQueue::addUpdates). */
    private function proposedChanges(string $idKey, int $id, array $reviewIds): array
    {
        $many = count($reviewIds) > 1;
        return $this->proposed($idKey, $id, (int) $reviewIds[0], $many
            ? 'The change was proposed as ' . count($reviewIds) . ' proposals, one per field, so each can be accepted on its own. They are applied once a person accepts them.'
            : 'The change was proposed. It is applied once a person accepts it.') + ['review_ids' => $reviewIds];
    }

    private function comment(array $p): ?string
    {
        return $this->str($p, 'reason', 2000);
    }

    private function excerpt(string $text, int $length = 60): string
    {
        $text = trim(preg_replace('/\s+/', ' ', $text) ?? '');

        return mb_strlen($text) > $length ? mb_substr($text, 0, $length - 1) . '…' : $text;
    }

    private function str(array $p, string $key, int $max, bool $required = false): ?string
    {
        $value = $p[$key] ?? null;
        if ($value !== null && !is_scalar($value)) {
            throw new McpError($key . ' must be text.', 422);
        }
        $value = $value === null ? null : Auth::sanitizeString((string) $value, $max);
        if ($value === '') {
            $value = null;
        }
        if ($required && $value === null) {
            throw new McpError($key . ' is required.', 422);
        }

        return $value;
    }

    private function id(array $p, string $key, bool $required = true): ?int
    {
        $value = $p[$key] ?? null;
        if ($value === null || $value === '') {
            if ($required) {
                throw new McpError($key . ' is required.', 422);
            }
            return null;
        }
        if (is_int($value) || (is_string($value) && ctype_digit($value)) || (is_float($value) && floor($value) === $value)) {
            $id = (int) $value;
            if ($id > 0) {
                return $id;
            }
        }

        throw new McpError($key . ' must be a positive whole number.', 422);
    }

    private function bool(array $p, string $key): bool
    {
        $value = $p[$key] ?? false;
        if (is_bool($value)) {
            return $value;
        }

        return filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? false;
    }

    private function date(array $p, string $key): ?string
    {
        $value = $p[$key] ?? null;
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
            throw new McpError($key . ' must be a date written as YYYY-MM-DD.', 422);
        }
        [$y, $m, $d] = array_map('intval', explode('-', $value));
        if (!checkdate($m, $d, $y)) {
            throw new McpError($key . ' is not a real date.', 422);
        }

        return $value;
    }

    private function month(array $p, string $key, bool $required = false): ?string
    {
        $value = $p[$key] ?? null;
        if ($value === null || $value === '') {
            if ($required) {
                throw new McpError($key . ' is required (YYYY-MM).', 422);
            }
            return null;
        }
        if (!is_string($value) || !preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $value)) {
            throw new McpError($key . ' must be a month written as YYYY-MM.', 422);
        }

        return $value;
    }

    private function number(array $p, string $key): ?float
    {
        $value = $p[$key] ?? null;
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_numeric($value) || abs((float) $value) > 1e12) {
            throw new McpError($key . ' must be a number.', 422);
        }

        return (float) $value;
    }

    private function intRange(array $p, string $key, int $min, int $max): ?int
    {
        $value = $p[$key] ?? null;
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_numeric($value)) {
            throw new McpError($key . ' must be a whole number between ' . $min . ' and ' . $max . '.', 422);
        }

        return max($min, min($max, (int) round((float) $value)));
    }

    private function priority($value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        return $this->enum(strtolower(trim((string) $value)), self::PRIORITIES, 'priority');
    }

    private function enum(string $value, array $allowed, string $key): string
    {
        foreach ($allowed as $candidate) {
            if (strcasecmp($candidate, $value) === 0) {
                return $candidate;
            }
        }

        throw new McpError($key . ' must be one of: ' . implode(', ', $allowed) . '.', 422);
    }

    private function limit(array $p, int $default, int $max): int
    {
        return $this->intRange($p, 'limit', 1, $max) ?? $default;
    }

    /** @return array{0: int, 1: int} */
    private function paging(array $p, int $default, int $max): array
    {
        return [$this->limit($p, $default, $max), $this->intRange($p, 'offset', 0, 100000) ?? 0];
    }

    private function like(string $value): string
    {
        return '%' . addcslashes($value, '%_\\') . '%';
    }
}
