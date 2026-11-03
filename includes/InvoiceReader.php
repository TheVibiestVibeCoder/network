<?php
/**
 * Claude reads an invoice PDF.
 *
 * Every invoice that reaches Bookkeeping - into the drop zone or straight
 * onto a row, by hand or through the Claude connector - is read once:
 * who issued it, its number and date, net, VAT and gross. The drop zone
 * shows an invoice by what it is rather than by its file name, the table
 * gets a VAT column, and bookkeeping.js suggests filing an invoice on the
 * bank entry it fits (same amount, a plausible date).
 *
 * What was read is kept with the file (bookkeeping_pdfs.invoice_data), so a
 * file is sent to Claude once and never again. The figures are for the
 * team's own overview; the accountant does the real VAT.
 *
 * On while ANTHROPIC_API_KEY is set in .env, like the meeting assistant;
 * INVOICE_READER=off switches it off. INVOICE_MODEL and INVOICE_EFFORT
 * choose the model and how hard it thinks. Opus at low effort by default:
 * Haiku missed the VAT on too many of our own invoices. What one model read
 * counts as out of date once another is set, and is read again.
 */

class InvoiceReader
{
    private const API_URL = 'https://api.anthropic.com/v1/messages';
    private const API_VERSION = '2026-10-21';
    // Lets the API retry a declined request on the model it recommends for
    // that kind of decline. Haiku has no such fallback, so not for Haiku.
    private const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

    /**
     * Above this the base64 form no longer fits into one request (32 MB).
     * An invoice is a few hundred KB; a file this big is a scan of a binder.
     */
    public const MAX_FILE_BYTES = 20 * 1024 * 1024;

    /** Thrown for "try again later": Claude busy or unreachable. */
    public const TEMPORARY = 503;

    public static function enabled(): bool
    {
        $flag = strtolower(trim((string) ($_ENV['INVOICE_READER'] ?? '')));
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

    public static function model(): string
    {
        $model = trim((string) ($_ENV['INVOICE_MODEL'] ?? ''));
        return $model !== '' ? $model : 'claude-opus-5-5';
    }

    /** True when what was read came from the model now set. */
    public static function isCurrent(?array $invoice): bool
    {
        return $invoice !== null && ($invoice['model'] ?? '') === self::model();
    }

    private static function hasFallback(): bool
    {
        return strpos(self::model(), 'claude-haiku') !== 0;
    }

    private static function effort(): string
    {
        $effort = strtolower(trim((string) ($_ENV['INVOICE_EFFORT'] ?? '')));
        return in_array($effort, ['low', 'medium', 'high'], true) ? $effort : 'low';
    }

    /**
     * Read one invoice.
     *
     * @return array{kind: string, issuer: string, recipient: string, invoice_number: ?string,
     *               invoice_date: ?string, due_date: ?string, subject: string, currency: string,
     *               net: ?float, vat: ?float, gross: ?float, model: string}
     * @throws RuntimeException with a message fit to show the user; code
     *         TEMPORARY when it is worth trying again later
     */
    public static function read(string $path): array
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('The server cannot reach Claude (PHP curl is missing).');
        }

        $size = is_file($path) ? (int) filesize($path) : 0;
        if ($size <= 0) {
            throw new RuntimeException('The file is missing on the server.');
        }
        if ($size > self::MAX_FILE_BYTES) {
            throw new RuntimeException('The file is too large for Claude to read.');
        }

        $request = [
            'model' => self::model(),
            'max_tokens' => 8000,
            'output_config' => [
                'effort' => self::effort(),
                'format' => ['type' => 'json_schema', 'schema' => self::schema()],
            ],
            'system' => self::systemPrompt(),
            'messages' => [[
                'role' => 'user',
                'content' => [
                    [
                        'type' => 'document',
                        'source' => [
                            'type' => 'base64',
                            'media_type' => 'application/pdf',
                            'data' => base64_encode((string) file_get_contents($path)),
                        ],
                    ],
                    ['type' => 'text', 'text' => 'Read this document.'],
                ],
            ]],
        ];
        if (self::hasFallback()) {
            $request['fallbacks'] = 'default';
        }

        $headers = [
            'Content-Type: application/json',
            'x-api-key: ' . self::apiKey(),
            'anthropic-version: ' . self::API_VERSION,
        ];
        if (self::hasFallback()) {
            $headers[] = 'anthropic-beta: ' . self::FALLBACK_BETA;
        }
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
            error_log('invoice reader: request failed: ' . $curlError);
            throw new RuntimeException('Claude could not be reached. Please try again.', self::TEMPORARY);
        }

        $response = json_decode((string) $body, true);
        if ($status !== 200 || !is_array($response)) {
            $type = is_array($response) ? (string) ($response['error']['type'] ?? '') : '';
            error_log('invoice reader: HTTP ' . $status . ' ' . $type . ' ' . (is_array($response) ? (string) ($response['error']['message'] ?? '') : ''));
            if ($status === 401 || $status === 403) {
                throw new RuntimeException('The Claude API key was not accepted. Check ANTHROPIC_API_KEY in .env.', self::TEMPORARY);
            }
            if ($status === 429 || $status >= 500 || $type === 'overloaded_error' || $type === 'rate_limit_error') {
                throw new RuntimeException('Claude is busy right now. Please try again in a moment.', self::TEMPORARY);
            }
            // 400: most often a PDF Claude cannot open (encrypted, broken).
            throw new RuntimeException('Claude could not open this PDF (error ' . $status . ').');
        }

        $stop = (string) ($response['stop_reason'] ?? '');
        if ($stop === 'refusal') {
            throw new RuntimeException('Claude declined to read this document.');
        }

        // With a structured output the answer is the JSON in the text block.
        $json = null;
        foreach ((array) ($response['content'] ?? []) as $block) {
            if (($block['type'] ?? '') === 'text') {
                $json = (string) $block['text'];
            }
        }
        $result = $json !== null ? json_decode($json, true) : null;
        if (!is_array($result)) {
            error_log('invoice reader: unreadable answer, stop_reason ' . $stop);
            throw new RuntimeException('Claude\'s answer could not be read. Please try again.', self::TEMPORARY);
        }

        return self::clean($result);
    }

    /** The answer as stored: trimmed text, real dates, amounts rounded to the cent. */
    private static function clean(array $result): array
    {
        $text = static fn($value, int $max): string => mb_substr(trim((string) ($value ?? '')), 0, $max);
        $date = static function ($value): ?string {
            $value = trim((string) ($value ?? ''));
            if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
                return null;
            }
            return $value;
        };
        $amount = static fn($value): ?float => is_numeric($value) ? round((float) $value, 2) : null;

        $kind = (string) ($result['kind'] ?? '');
        $number = $text($result['invoice_number'] ?? null, 80);
        $currency = strtoupper($text($result['currency'] ?? null, 3));

        return [
            'kind' => in_array($kind, ['invoice', 'credit_note', 'receipt', 'other'], true) ? $kind : 'other',
            'issuer' => $text($result['issuer'] ?? null, 120),
            'recipient' => $text($result['recipient'] ?? null, 120),
            'invoice_number' => $number !== '' ? $number : null,
            'invoice_date' => $date($result['invoice_date'] ?? null),
            'due_date' => $date($result['due_date'] ?? null),
            'subject' => $text($result['subject'] ?? null, 160),
            'currency' => preg_match('/^[A-Z]{3}$/', $currency) ? $currency : 'EUR',
            'net' => $amount($result['net'] ?? null),
            'vat' => $amount($result['vat'] ?? null),
            'gross' => $amount($result['gross'] ?? null),
            'model' => self::model(),
        ];
    }

    private static function systemPrompt(): string
    {
        return <<<'PROMPT'
You read invoices for the bookkeeping of a small consulting company. You get one PDF; it is usually an invoice or receipt the company received or sent, occasionally something else that was filed by mistake.

Fill in:
- kind: "invoice", "credit_note" (a credit or refund note), "receipt" (a till receipt or payment confirmation), or "other" if it is not a bill at all (contract, offer, letter).
- issuer: the company or person who issued the document, as short as it is still clear ("Adobe", "Deutsche Bahn", "Hotel Alpenblick GmbH").
- recipient: who it is addressed to, just as short.
  For either of the two, an empty string if the document does not name one - never a note like "not stated".
- invoice_number: as printed, or null.
- invoice_date and due_date: YYYY-MM-DD, or null if not on the document.
- subject: a few words on what it is for ("Creative Cloud Team, October", "Train Vienna-Munich"), in the document's language.
- currency: ISO code of the amounts, e.g. "EUR".
- gross: the total to be paid, including VAT. net: the total before VAT. vat: the total VAT amount, added up over all VAT rates.

VAT goes by many names: USt, Umsatzsteuer, MwSt, Mehrwertsteuer, VAT, TVA, IVA. Look for it in the totals, in a VAT breakdown under them, and in phrases like "zzgl. 20 % USt" or "inkl. 10 % MwSt". The company's own invoices are as likely to carry VAT as the ones it received.

Rules:
- Amounts are positive numbers with a dot as decimal separator, also on a credit note.
- Only a rate given ("zzgl. 20 % USt") but no VAT amount: work it out from the net, rounded to the cent.
- VAT included in the prices ("inkl. MwSt"): take the VAT amount stated; if only the rate is given, work it out from the gross.
- No VAT on the document (reverse charge, small business, abroad): vat is 0 and net equals gross.
- Check before answering: net + vat must equal gross, give or take a cent. If they do not, read the totals again.
- Only what the document says. If a figure is not there and cannot be worked out from the others, use null.
PROMPT;
    }

    /** Flat and strict: every field present, missing ones null. */
    private static function schema(): array
    {
        $nullable = fn(array $type) => ['anyOf' => [$type, ['type' => 'null']]];

        return [
            'type' => 'object',
            'additionalProperties' => false,
            'required' => ['kind', 'issuer', 'recipient', 'invoice_number', 'invoice_date', 'due_date', 'subject', 'currency', 'net', 'vat', 'gross'],
            'properties' => [
                'kind' => ['type' => 'string', 'enum' => ['invoice', 'credit_note', 'receipt', 'other']],
                'issuer' => ['type' => 'string'],
                'recipient' => ['type' => 'string'],
                'invoice_number' => $nullable(['type' => 'string']),
                'invoice_date' => $nullable(['type' => 'string', 'format' => 'date']),
                'due_date' => $nullable(['type' => 'string', 'format' => 'date']),
                'subject' => ['type' => 'string'],
                'currency' => ['type' => 'string'],
                'net' => $nullable(['type' => 'number']),
                'vat' => $nullable(['type' => 'number']),
                'gross' => $nullable(['type' => 'number']),
            ],
        ];
    }
}
