<?php
/**
 * MCP API guard
 *
 * Decides whether a request to api/mcp.php may be answered at all. Every check
 * has to pass, in this order:
 *
 *   1. The API is switched on and has a secret of at least 64 characters.
 *   2. REMOTE_ADDR is on MCP_API_ALLOWED_IPS. Forwarded headers are ignored -
 *      the caller writes those.
 *   3. The connection is HTTPS (loopback excepted, for local testing only; a
 *      loopback address still has to be on the allow-list).
 *   4. It is a POST of reasonable size.
 *   5. It carries a timestamp within five minutes of the server clock.
 *   6. It carries an HMAC-SHA256 signature over that timestamp, a nonce and the
 *      SHA-256 of the exact body, made with the shared secret. The secret itself
 *      never travels, so a captured request can be neither altered nor used to
 *      sign a new one.
 *   7. The nonce has not been seen before, which makes a captured request
 *      useless a second time.
 *   8. The allowed rate has not been exceeded.
 *
 * Anything failing 1-2 gets a bare 404, so to the rest of the internet the
 * endpoint does not exist.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

final class McpGuard
{
    /** Allowed clock difference between the MCP server and this one. */
    private const MAX_SKEW_SECONDS = 300;

    /** Largest body accepted - an invoice PDF, base64-encoded twice, fits. */
    public const MAX_BODY_BYTES = 20 * 1024 * 1024;

    /** Prefix of the signed string; a new scheme gets a new version. */
    public const SIGNATURE_VERSION = 'CRM-MCP-V1';

    /**
     * Verify the request, or end it. Returns the raw body on success.
     */
    public static function verify(): string
    {
        if (!MCP_API_ENABLED || strlen(MCP_API_SECRET) < 64) {
            self::fail(404, 'Not found');
        }

        $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        if (!self::ipAllowed($remote, self::allowList())) {
            self::fail(404, 'Not found');
        }

        if (!Auth::isHttps() && !self::isLoopback($remote)) {
            self::fail(403, 'HTTPS required');
        }

        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
            self::fail(405, 'Method not allowed');
        }

        $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($length <= 0 || $length > self::MAX_BODY_BYTES) {
            self::fail(413, 'Request body missing or too large');
        }

        $timestamp = (string) ($_SERVER['HTTP_X_CRM_TIMESTAMP'] ?? '');
        $nonce = (string) ($_SERVER['HTTP_X_CRM_NONCE'] ?? '');
        $signature = strtolower((string) ($_SERVER['HTTP_X_CRM_SIGNATURE'] ?? ''));

        if (!ctype_digit($timestamp) || !preg_match('/^[a-f0-9]{32,64}$/', $nonce) || !preg_match('/^[a-f0-9]{64}$/', $signature)) {
            self::fail(401, 'Missing or malformed signature headers');
        }

        if (abs(time() - (int) $timestamp) > self::MAX_SKEW_SECONDS) {
            self::fail(401, 'Request timestamp outside the allowed window - check the clocks');
        }

        $body = (string) file_get_contents('php://input', false, null, 0, self::MAX_BODY_BYTES + 1);
        if ($body === '' || strlen($body) > self::MAX_BODY_BYTES) {
            self::fail(413, 'Request body missing or too large');
        }

        $expected = self::sign($timestamp, $nonce, $body);
        if (!hash_equals($expected, $signature)) {
            // Only allow-listed addresses get this far, so this is worth a line
            // in the log: a wrong secret, or someone on that host probing.
            error_log('MCP API: bad signature from ' . $remote);
            self::fail(401, 'Invalid signature');
        }

        self::rememberNonce($nonce);

        return $body;
    }

    public static function sign(string $timestamp, string $nonce, string $body): string
    {
        $message = self::SIGNATURE_VERSION . "\n" . $timestamp . "\n" . $nonce . "\n" . hash('sha256', $body);

        return hash_hmac('sha256', $message, MCP_API_SECRET);
    }

    /** @return string[] */
    private static function allowList(): array
    {
        return array_values(array_filter(array_map('trim', explode(',', MCP_API_ALLOWED_IPS)), 'strlen'));
    }

    /**
     * Whether an address matches one of the allow-list entries. An entry is a
     * single IPv4/IPv6 address or a CIDR range; a malformed entry matches
     * nothing rather than everything.
     */
    public static function ipAllowed(string $ip, array $rules): bool
    {
        $packed = @inet_pton($ip);
        if ($packed === false) {
            return false;
        }

        // A dual-stack listener may report an IPv4 client as ::ffff:a.b.c.d.
        // Compare that as the IPv4 address it is.
        if (strlen($packed) === 16 && strncmp($packed, str_repeat(chr(0), 10) . chr(255) . chr(255), 12) === 0) {
            $packed = substr($packed, 12);
        }

        foreach ($rules as $rule) {
            $bits = null;
            if (strpos($rule, '/') !== false) {
                [$rule, $bitsRaw] = explode('/', $rule, 2);
                if (!ctype_digit($bitsRaw)) {
                    continue;
                }
                $bits = (int) $bitsRaw;
            }

            $network = @inet_pton($rule);
            if ($network === false || strlen($network) !== strlen($packed)) {
                continue;
            }

            $maxBits = strlen($packed) * 8;
            $bits = $bits ?? $maxBits;
            if ($bits < 0 || $bits > $maxBits) {
                continue;
            }

            $fullBytes = intdiv($bits, 8);
            $restBits = $bits % 8;

            if (substr($packed, 0, $fullBytes) !== substr($network, 0, $fullBytes)) {
                continue;
            }

            if ($restBits > 0) {
                $mask = (0xFF << (8 - $restBits)) & 0xFF;
                if ((ord($packed[$fullBytes]) & $mask) !== (ord($network[$fullBytes]) & $mask)) {
                    continue;
                }
            }

            return true;
        }

        return false;
    }

    private static function isLoopback(string $ip): bool
    {
        return in_array($ip, ['127.0.0.1', '::1'], true);
    }

    /**
     * Store the nonce - refusing one already seen - and enforce the rate limit
     * over the same rows.
     */
    private static function rememberNonce(string $nonce): void
    {
        $db = Database::getInstance();
        $now = time();

        // Anything older than the timestamp window can no longer be replayed,
        // because its timestamp would be refused first.
        $db->prepare("DELETE FROM mcp_api_nonces WHERE seen_at < :cutoff")
            ->execute(['cutoff' => $now - (self::MAX_SKEW_SECONDS * 2)]);

        $count = $db->prepare("SELECT COUNT(*) FROM mcp_api_nonces WHERE seen_at >= :since");
        $count->execute(['since' => $now - 60]);
        if ((int) $count->fetchColumn() >= MCP_API_RATE_LIMIT) {
            header('Retry-After: 60');
            self::fail(429, 'Too many requests - slow down');
        }

        try {
            $db->prepare("INSERT INTO mcp_api_nonces (nonce, seen_at) VALUES (:nonce, :seen_at)")
                ->execute(['nonce' => $nonce, 'seen_at' => $now]);
        } catch (PDOException $e) {
            // Primary-key collision: this exact request has been seen before.
            self::fail(401, 'Replayed request');
        }
    }

    public static function fail(int $status, string $message): void
    {
        http_response_code($status);
        header('Cache-Control: no-store');

        // A 404 says nothing at all - not even that there is an API here.
        if ($status !== 404) {
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['ok' => false, 'error' => $message]);
        }
        exit;
    }
}
