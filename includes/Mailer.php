<?php
/**
 * Mailer
 *
 * Sends the invite and password-reset mails through PHP's mail(), which is what
 * shared hosting reliably offers. Delivery is best-effort by design: the admin
 * panel always shows the generated link as well, so an account can still be set
 * up when the host cannot send mail at all.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
// This file is library code. It must only ever be loaded through an entry
// point (index.php or api/*.php), each of which defines APP_ROOT first.
// nginx ignores .htaccess, so this check - not the deny rules - is the
// portable backstop that stops the file being requested from a browser.
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

class Mailer
{
    /**
     * Send the "you have been invited, choose a password" mail.
     */
    public static function sendInvite(string $email, string $name, string $link, int $expiresAt): bool
    {
        $appName = APP_NAME;
        $validFor = self::describeDuration($expiresAt - time());

        $subject = 'Your ' . $appName . ' account';
        $body = self::paragraphs([
            'Hi ' . $name . ',',
            'An account was created for you in ' . $appName . '. Choose your password here:',
            $link,
            'The link is valid for ' . $validFor . ' and can only be used once. '
                . 'If it has expired, ask an administrator for a new one.',
            'If you were not expecting this, you can ignore this message - the '
                . 'account cannot be used until a password is set.',
        ]);

        return self::send($email, $name, $subject, $body);
    }

    /**
     * Send the "reset your password" mail.
     */
    public static function sendPasswordReset(string $email, string $name, string $link, int $expiresAt): bool
    {
        $appName = APP_NAME;
        $validFor = self::describeDuration($expiresAt - time());

        $subject = 'Reset your ' . $appName . ' password';
        $body = self::paragraphs([
            'Hi ' . $name . ',',
            'A password reset was requested for your ' . $appName . ' account. '
                . 'Choose a new password here:',
            $link,
            'The link is valid for ' . $validFor . ' and can only be used once.',
            'If you did not request this, no action is needed - your current '
                . 'password stays valid and the link above expires on its own.',
        ]);

        return self::send($email, $name, $subject, $body);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /**
     * Hand a plain-text message to the MTA.
     *
     * Header injection is the risk here: a newline in a recipient address or a
     * subject would let the caller append arbitrary headers (Bcc, Content-Type)
     * to the message. Both are therefore validated and stripped, and the
     * display name is encoded rather than interpolated raw.
     */
    private static function send(string $email, string $name, string $subject, string $body): bool
    {
        if (!function_exists('mail')) {
            error_log('Mailer: mail() is not available on this host');
            return false;
        }

        $email = trim($email);
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || self::hasHeaderBreak($email)) {
            error_log('Mailer: refusing to send to an invalid recipient');
            return false;
        }

        $subject = self::singleLine($subject);

        $from = self::resolveFromAddress();
        if ($from === null) {
            error_log('Mailer: no usable From address (set MAIL_FROM in .env)');
            return false;
        }

        $headers = [
            'From: ' . self::encodeDisplayName(MAIL_FROM_NAME) . ' <' . $from . '>',
            'Reply-To: ' . $from,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            'X-Mailer: ' . self::singleLine(APP_NAME),
            'Auto-Submitted: auto-generated',
        ];

        // RFC 5322 wants CRLF line endings in the body; some MTAs are lenient
        // but Windows MTAs in particular are not.
        $body = str_replace(["\r\n", "\r", "\n"], "\r\n", $body);

        $sent = @mail(
            $email,
            self::encodeSubject($subject),
            $body,
            implode("\r\n", $headers),
            '-f' . $from
        );

        if (!$sent) {
            error_log('Mailer: mail() reported failure for a message to ' . $email);
        }

        return (bool) $sent;
    }

    /**
     * The envelope sender. Falls back to noreply@<host> when MAIL_FROM is unset,
     * because an empty From makes most MTAs drop the message outright.
     */
    private static function resolveFromAddress(): ?string
    {
        $configured = trim((string) MAIL_FROM);
        if ($configured !== ''
            && filter_var($configured, FILTER_VALIDATE_EMAIL)
            && !self::hasHeaderBreak($configured)) {
            return $configured;
        }

        $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
        $host = preg_replace('/:\d+$/', '', $host);
        // Host headers are client-controlled, so only accept a plain hostname.
        if (!preg_match('/^[a-z0-9.-]+\.[a-z]{2,}$/i', $host)) {
            return null;
        }

        return 'noreply@' . mb_strtolower($host);
    }

    /**
     * True when the value contains anything that could start a new header.
     */
    private static function hasHeaderBreak(string $value): bool
    {
        return preg_match('/[\r\n\x00]/', $value) === 1;
    }

    /**
     * Collapse a value to a single header-safe line.
     */
    private static function singleLine(string $value): string
    {
        $value = preg_replace('/[\r\n\x00]+/', ' ', $value) ?? '';

        return trim(mb_substr($value, 0, 200));
    }

    /**
     * RFC 2047 encode a header value so non-ASCII survives without ever
     * emitting a raw byte that could be read as a header break.
     */
    private static function encodeSubject(string $subject): string
    {
        if (preg_match('/^[\x20-\x7E]*$/', $subject)) {
            return $subject;
        }

        return '=?UTF-8?B?' . base64_encode($subject) . '?=';
    }

    /**
     * Quote (and if needed encode) a display name for use in a From header.
     */
    private static function encodeDisplayName(string $name): string
    {
        $name = self::singleLine($name);

        if (!preg_match('/^[\x20-\x7E]*$/', $name)) {
            return '=?UTF-8?B?' . base64_encode($name) . '?=';
        }

        return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $name) . '"';
    }

    private static function paragraphs(array $lines): string
    {
        return implode("\n\n", $lines) . "\n";
    }

    /**
     * Render a lifetime in seconds as something a person would say.
     */
    private static function describeDuration(int $seconds): string
    {
        if ($seconds >= 172800) {
            return (int) round($seconds / 86400) . ' days';
        }
        if ($seconds >= 86400) {
            return '24 hours';
        }
        if ($seconds >= 7200) {
            return (int) round($seconds / 3600) . ' hours';
        }
        if ($seconds >= 3600) {
            return '1 hour';
        }

        return max(1, (int) round($seconds / 60)) . ' minutes';
    }
}
