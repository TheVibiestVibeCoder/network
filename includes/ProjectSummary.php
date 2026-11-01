<?php
/**
 * Claude summary of a project.
 *
 * The project sheet shows, under the description, what the description and
 * all of the project's notes add up to: what the project is and where it
 * stands now. It is written by Claude and kept with the project
 * (projects.claude_summary), together with a fingerprint of what it was
 * written from. Whenever the description or a note changes - here, through
 * a meeting, or by accepting one of Claude's proposals - the fingerprint no
 * longer matches, and the next look at the project has it written again.
 * Nothing changed, nothing is sent: opening a project costs no request.
 *
 * Only settled notes count. A note Claude proposed and nobody has accepted
 * yet (review_status 'pending') is left out until it is accepted.
 *
 * On while ANTHROPIC_API_KEY is set in .env, like the meeting assistant;
 * PROJECT_SUMMARY=off switches it off. SUMMARY_MODEL and SUMMARY_EFFORT
 * choose the model and how hard it thinks.
 */

class ProjectSummary
{
    private const API_URL = 'https://api.anthropic.com/v1/messages';
    private const API_VERSION = '2026-10-21';
    // Lets the API retry a declined request on the model it recommends for
    // that kind of decline, instead of handing back the refusal.
    private const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

    /** Notes beyond this many characters in all are cut, oldest first. */
    private const MAX_INPUT_CHARS = 60000;

    public static function enabled(): bool
    {
        $flag = strtolower(trim((string) ($_ENV['PROJECT_SUMMARY'] ?? '')));
        return self::apiKey() !== '' && !in_array($flag, ['0', 'false', 'off', 'no'], true);
    }

    private static function apiKey(): string
    {
        return trim((string) ($_ENV['ANTHROPIC_API_KEY'] ?? ''));
    }

    /** For an API key that is not scoped to one workspace: which one to use. */
    private static function workspaceId(): string
    {
        return trim((string) ($_ENV['ANTHROPIC_WORKSPACE_ID'] ?? ''));
    }

    private static function model(): string
    {
        $model = trim((string) ($_ENV['SUMMARY_MODEL'] ?? ''));
        return $model !== '' ? $model : 'claude-opus-5-5';
    }

    /** A summary needs little thought; 'low' keeps the wait short. */
    private static function effort(): string
    {
        $effort = strtolower(trim((string) ($_ENV['SUMMARY_EFFORT'] ?? '')));
        return in_array($effort, ['low', 'medium', 'high'], true) ? $effort : 'low';
    }

    // -------------------------------------------------------------------------
    // Reading
    // -------------------------------------------------------------------------

    /**
     * What the summary is written from: the project's name, company and
     * description, and its settled notes, oldest first. Null if there is no
     * such project.
     */
    private static function source(PDO $db, int $projectId): ?array
    {
        $stmt = $db->prepare("SELECT id, name, company, stage, description FROM projects WHERE id = :id");
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();
        if (!$project) {
            return null;
        }

        $stmt = $db->prepare("
            SELECT content, created_at, author_name
            FROM project_notes
            WHERE project_id = :id AND review_status IS NULL
            ORDER BY created_at ASC, id ASC
        ");
        $stmt->execute(['id' => $projectId]);

        $notes = array_map(static fn(array $note): array => [
            'date' => substr((string) $note['created_at'], 0, 10),
            'by' => (string) ($note['author_name'] ?? ''),
            'text' => trim((string) $note['content']),
        ], $stmt->fetchAll());

        return [
            'name' => (string) $project['name'],
            'company' => (string) ($project['company'] ?? ''),
            'stage' => (string) ($project['stage'] ?? ''),
            'description' => trim((string) ($project['description'] ?? '')),
            'notes' => $notes,
        ];
    }

    /** A fingerprint of what the summary is written from. */
    private static function fingerprint(array $source): string
    {
        return hash('sha256', json_encode([$source['description'], $source['notes']], JSON_UNESCAPED_UNICODE));
    }

    /**
     * The summary as it is stored, and whether it still matches the project
     * (stale: the description or the notes changed since it was written).
     *
     * @return array{summary: string, updated_at: ?string, stale: bool, empty: bool}|null
     */
    public static function get(PDO $db, int $projectId): ?array
    {
        $source = self::source($db, $projectId);
        if ($source === null) {
            return null;
        }

        $stmt = $db->prepare("SELECT claude_summary, claude_summary_hash, claude_summary_at FROM projects WHERE id = :id");
        $stmt->execute(['id' => $projectId]);
        $row = $stmt->fetch() ?: [];

        $empty = $source['description'] === '' && $source['notes'] === [];
        return [
            'summary' => (string) ($row['claude_summary'] ?? ''),
            'updated_at' => $row['claude_summary_at'] ?? null,
            'stale' => !$empty && ($row['claude_summary_hash'] ?? '') !== self::fingerprint($source),
            'empty' => $empty,
        ];
    }

    // -------------------------------------------------------------------------
    // Writing
    // -------------------------------------------------------------------------

    /**
     * Have the summary written again if the description or the notes changed
     * since; otherwise hand back the one there is.
     *
     * @throws RuntimeException with a message fit to show the user
     */
    public static function refresh(PDO $db, int $projectId): ?array
    {
        $source = self::source($db, $projectId);
        if ($source === null) {
            return null;
        }

        $current = self::get($db, $projectId);
        if (!$current['stale']) {
            return $current;
        }

        $hash = self::fingerprint($source);
        $text = self::write($source);

        // The project may have changed while Claude wrote; then this summary
        // is already behind, and is kept without claiming to be current.
        $latest = self::source($db, $projectId);
        $stored = $latest !== null && self::fingerprint($latest) === $hash ? $hash : '';

        $stmt = $db->prepare("
            UPDATE projects
            SET claude_summary = :summary, claude_summary_hash = :hash, claude_summary_at = CURRENT_TIMESTAMP
            WHERE id = :id
        ");
        $stmt->execute(['summary' => $text, 'hash' => $stored, 'id' => $projectId]);

        return self::get($db, $projectId);
    }

    /**
     * Ask Claude for the summary.
     *
     * @throws RuntimeException with a message fit to show the user
     */
    private static function write(array $source): string
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('The server cannot reach Claude (PHP curl is missing).');
        }

        // Very long histories: the newest notes matter most, so the oldest go.
        while (count($source['notes']) > 1 && strlen(json_encode($source, JSON_UNESCAPED_UNICODE)) > self::MAX_INPUT_CHARS) {
            array_shift($source['notes']);
            $source['older_notes_left_out'] = true;
        }

        $request = [
            'model' => self::model(),
            'max_tokens' => 16000,
            'fallbacks' => 'default',
            'output_config' => ['effort' => self::effort()],
            'system' => self::systemPrompt(),
            'messages' => [[
                'role' => 'user',
                'content' => 'Today is ' . (new DateTimeImmutable('now'))->format('l, Y-m-d') . ".\n\n"
                    . "<project>\n" . json_encode($source, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n</project>",
            ]],
        ];

        $headers = [
            'Content-Type: application/json',
            'x-api-key: ' . self::apiKey(),
            'anthropic-version: ' . self::API_VERSION,
            'anthropic-beta: ' . self::FALLBACK_BETA,
        ];
        if (self::workspaceId() !== '') {
            $headers[] = 'anthropic-workspace-id: ' . self::workspaceId();
        }

        $curl = curl_init(self::API_URL);
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_POSTFIELDS => json_encode($request, JSON_UNESCAPED_UNICODE),
        ]);
        $body = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $curlError = curl_error($curl);
        unset($curl);

        if ($body === false) {
            error_log('project summary: request failed: ' . $curlError);
            throw new RuntimeException('Claude could not be reached. Please try again.');
        }

        $response = json_decode((string) $body, true);
        if ($status !== 200 || !is_array($response)) {
            $type = is_array($response) ? (string) ($response['error']['type'] ?? '') : '';
            error_log('project summary: HTTP ' . $status . ' ' . $type . ' ' . (is_array($response) ? (string) ($response['error']['message'] ?? '') : ''));
            if ($status === 401 || $status === 403) {
                throw new RuntimeException('The Claude API key was not accepted. Check ANTHROPIC_API_KEY in .env.');
            }
            if ($status === 429 || $status === 529 || $type === 'overloaded_error' || $type === 'rate_limit_error') {
                throw new RuntimeException('Claude is busy right now. Please try again in a moment.');
            }
            throw new RuntimeException('Claude could not write the summary (error ' . $status . ').');
        }

        $stop = (string) ($response['stop_reason'] ?? '');
        if ($stop === 'refusal') {
            throw new RuntimeException('Claude declined to summarise this project.');
        }

        $text = '';
        foreach ((array) ($response['content'] ?? []) as $block) {
            if (($block['type'] ?? '') === 'text') {
                $text .= (string) $block['text'];
            }
        }
        $text = trim($text);
        if ($text === '') {
            error_log('project summary: empty answer, stop_reason ' . $stop);
            throw new RuntimeException('Claude\'s summary came back empty. Please try again.');
        }

        return $text;
    }

    private static function systemPrompt(): string
    {
        return <<<'PROMPT'
You write the summary at the top of a project in the CRM of a small consulting team. You get the project's description and all of its notes (<project>), oldest first. Someone opening the project should be up to date after reading your summary alone.

Write:
- First, two or three sentences: what the project is, for whom, and where it stands now.
- Then up to five lines starting with "- ": the most important current facts - decisions, agreements, open questions, next steps and who does them, dates and amounts that matter.

Rules:
- Use only what the description and the notes say. Do not add anything.
- Where notes disagree, the newest one counts; leave out what has been overtaken.
- Write in the language most of the notes and the description are written in.
- Plain text only: no headings, no bold, no Markdown other than the "- " lines. Keep it under 150 words.
- If there is very little to go on, say what there is in one or two sentences.
PROMPT;
    }
}
