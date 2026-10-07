<?php
/**
 * Simple CRM - Main Entry Point
 * A contact management system with map visualization
 */

define('APP_ROOT', __DIR__);

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Contact.php';
require_once APP_ROOT . '/includes/Mailer.php';

// Start session
Auth::startSession();

// Send security headers on every response
Auth::sendSecurityHeaders();

// Handle actions
$action = $_GET['action'] ?? '';

// Handle logout
if ($action === 'logout') {
    Auth::logout();
    header('Location: index.php');
    exit;
}

// Login / password state
$loginError = null;
$loginNotice = null;
$isLockedOut = false;
$lockoutRemaining = 0;
$loginEmail = '';

// Password-set screen state
$passwordToken = null;
$passwordTokenUser = null;
$passwordTokenPurpose = User::PURPOSE_INVITE;
$passwordError = null;

// Forgot-password screen state
$forgotNotice = null;
$forgotError = null;

// Two-factor screen state
$twoFactorPending = null;   // the challenge row, when one is in flight
$twoFactorError = null;
$twoFactorNotice = null;
$twoFactorNoticeOk = true;  // false when the notice reports a delivery failure
$twoFactorDebugCode = null; // only ever set for a request from this machine
$rememberChecked = false;

// -----------------------------------------------------------------------------
// Sign in
// -----------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'login') {
    if (!Auth::validateCsrfToken()) {
        $loginError = 'Invalid session token. Please refresh and try again.';
    } else {
        $loginEmail = trim((string) ($_POST['email'] ?? ''));
        $password = (string) ($_POST['password'] ?? '');
        $rememberChecked = !empty($_POST['remember']);

        $result = Auth::login($loginEmail, $password, $rememberChecked);

        if ($result['success']) {
            header('Location: index.php');
            exit;
        }

        // Password accepted, second factor outstanding. Redirect rather than
        // render, so a refresh on the code screen does not resubmit the
        // password and mail out a second code.
        if (isset($result['challenge'])) {
            $_SESSION['2fa_notice'] = ($result['delivered'] ?? false)
                ? 'We sent a sign-in code to your email address.'
                : 'Your sign-in code could not be emailed.';
            $_SESSION['2fa_notice_ok'] = (bool) ($result['delivered'] ?? false);

            if (isset($result['debug_code'])) {
                $_SESSION['2fa_debug_code'] = $result['debug_code'];
            }

            header('Location: index.php?action=verify');
            exit;
        }

        $loginError = $result['error'];
        if (isset($result['locked_until'])) {
            $isLockedOut = true;
            $lockoutRemaining = max(0, $result['locked_until'] - time());
        }
    }
}

// -----------------------------------------------------------------------------
// Two-factor: enter the emailed code
// -----------------------------------------------------------------------------
if ($action === 'verify') {
    Auth::pruneChallenges();

    // "Use a different account" - drop the challenge and go back to the form.
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['cancel'])) {
        Auth::cancelTwoFactor();
        header('Location: index.php');
        exit;
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!Auth::validateCsrfToken()) {
            $twoFactorError = 'Invalid session token. Please refresh and try again.';
        } elseif (isset($_POST['resend'])) {
            $resend = Auth::resendTwoFactor();

            if (!empty($resend['success'])) {
                $_SESSION['2fa_notice'] = !empty($resend['delivered'])
                    ? 'A new code is on its way.'
                    : 'A new code was generated but could not be emailed.';
                $_SESSION['2fa_notice_ok'] = !empty($resend['delivered']);

                if (!empty($resend['debug_code'])) {
                    $_SESSION['2fa_debug_code'] = $resend['debug_code'];
                }

                // Redirect so the resend is not repeated by a refresh.
                header('Location: index.php?action=verify');
                exit;
            }

            $twoFactorError = $resend['error'] ?? 'Could not send a new code.';
        } else {
            $verdict = Auth::verifyTwoFactor((string) ($_POST['code'] ?? ''));

            if (!empty($verdict['success'])) {
                unset($_SESSION['2fa_notice'], $_SESSION['2fa_notice_ok'], $_SESSION['2fa_debug_code']);
                header('Location: index.php');
                exit;
            }

            $twoFactorError = $verdict['error'];
        }
    }

    $twoFactorPending = Auth::pendingChallenge();

    if ($twoFactorPending === null) {
        // Nothing in flight - either it expired or the code screen was opened
        // directly. Back to the sign-in form with an explanation.
        $loginError = $twoFactorError ?? 'This sign-in has expired. Please sign in again.';
        $action = '';
        unset($_SESSION['2fa_notice'], $_SESSION['2fa_notice_ok'], $_SESSION['2fa_debug_code']);
    } else {
        // These are one-shot: read them out of the session so a later refresh
        // does not keep repeating a notice about a code that is long gone.
        if (isset($_SESSION['2fa_notice'])) {
            $twoFactorNotice = (string) $_SESSION['2fa_notice'];
            $twoFactorNoticeOk = (bool) ($_SESSION['2fa_notice_ok'] ?? true);
            unset($_SESSION['2fa_notice'], $_SESSION['2fa_notice_ok']);
        }
        // Not one-shot, unlike the notice: on a local instance this is the only
        // copy of the code, so it has to survive a refresh of the code screen.
        // It is cleared when the challenge is spent, cancelled or expires.
        if (isset($_SESSION['2fa_debug_code'])) {
            $twoFactorDebugCode = (string) $_SESSION['2fa_debug_code'];
        }
    }
}

// -----------------------------------------------------------------------------
// Choose a password (invite + reset links land here)
// -----------------------------------------------------------------------------
if ($action === 'set-password') {
    $userModel = new User();
    $userModel->pruneTokens();

    // On POST the token travels in the body, so it never ends up in a log or a
    // Referer header on the request that actually spends it.
    $passwordToken = $_SERVER['REQUEST_METHOD'] === 'POST'
        ? (string) ($_POST['token'] ?? '')
        : (string) ($_GET['token'] ?? '');

    $tokenRow = $userModel->findValidToken($passwordToken);

    if ($tokenRow !== null) {
        $passwordTokenUser = $tokenRow;
        $passwordTokenPurpose = (string) $tokenRow['purpose'];
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!Auth::validateCsrfToken()) {
            $passwordError = 'Invalid session token. Please reload the page and try again.';
        } elseif ($tokenRow === null) {
            $passwordError = 'This link is no longer valid.';
        } else {
            $new = (string) ($_POST['password'] ?? '');
            $confirm = (string) ($_POST['password_confirm'] ?? '');

            if ($new !== $confirm) {
                $passwordError = 'The two passwords do not match.';
            } elseif (($problem = User::validatePassword($new)) !== null) {
                $passwordError = $problem;
            } elseif (!$userModel->consumeTokenAndSetPassword($passwordToken, $new)) {
                $passwordError = 'This link has already been used. Please request a new one.';
            } else {
                // Straight into the CRM - they just proved who they are.
                if (Auth::loginAsUserId((int) $tokenRow['user_id'])) {
                    header('Location: index.php');
                    exit;
                }

                header('Location: index.php?action=login&set=1');
                exit;
            }
        }
    }
}

if ($action === 'login' && isset($_GET['set'])) {
    $loginNotice = 'Your password has been set. You can sign in now.';
}

// -----------------------------------------------------------------------------
// Forgot password
// -----------------------------------------------------------------------------
if ($action === 'forgot' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!Auth::validateCsrfToken()) {
        $forgotError = 'Invalid session token. Please refresh and try again.';
    } else {
        $requested = User::normalizeEmail($_POST['email'] ?? null);

        // The response is identical whether or not the address exists, so this
        // form cannot be used to find out who has an account here.
        $forgotNotice = 'If that email belongs to an account, a reset link is on its way.';

        if ($requested !== null && resetRequestAllowed($requested)) {
            try {
                $userModel = new User();
                $row = $userModel->findForAuth($requested);

                if ($row && $row['status'] !== User::STATUS_DISABLED) {
                    $purpose = empty($row['password_hash'])
                        ? User::PURPOSE_INVITE
                        : User::PURPOSE_RESET;

                    $token = $userModel->issueLink((int) $row['id'], $purpose);
                    $link = buildPasswordLink($token['token']);

                    if ($purpose === User::PURPOSE_INVITE) {
                        Mailer::sendInvite($row['email'], $row['name'], $link, $token['expires_at']);
                    } else {
                        Mailer::sendPasswordReset($row['email'], $row['name'], $link, $token['expires_at']);
                    }
                }
            } catch (Throwable $e) {
                error_log('password reset request failed: ' . $e->getMessage());
            }
        }
    }
}

// Show the lockout screen on a plain GET too, not only after a failed attempt.
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    $lockoutInfo = Auth::getLockoutInfo(Auth::getClientIp());
    if ($lockoutInfo['locked']) {
        $isLockedOut = true;
        $lockoutRemaining = max(0, $lockoutInfo['locked_until'] - time());
    }
}

// Check if authenticated
$isAuthenticated = Auth::isAuthenticated();
$currentUser = Auth::currentUser();
$isAdmin = Auth::isAdmin();

// Get contact count for dashboard
$contactCount = 0;
if ($isAuthenticated) {
    $contactModel = new Contact();
    $contactCount = $contactModel->count();
}

/**
 * Throttle password-reset requests so the form cannot be used to flood an
 * inbox, or to hammer the mailer. Limits are per email and per IP.
 */
function resetRequestAllowed(string $email): bool
{
    try {
        $db = Database::getInstance();
        $ip = Auth::getClientIp();

        $stmt = $db->prepare("
            SELECT
                SUM(CASE WHEN email = :email THEN 1 ELSE 0 END) AS by_email,
                SUM(CASE WHEN ip_address = :ip THEN 1 ELSE 0 END) AS by_ip
            FROM reset_requests
            WHERE requested_at > datetime('now', '-1 hour')
        ");
        $stmt->execute(['email' => $email, 'ip' => $ip]);
        $counts = $stmt->fetch() ?: [];

        if ((int) ($counts['by_email'] ?? 0) >= 3 || (int) ($counts['by_ip'] ?? 0) >= 10) {
            return false;
        }

        $insert = $db->prepare("INSERT INTO reset_requests (ip_address, email) VALUES (:ip, :email)");
        $insert->execute(['ip' => $ip, 'email' => $email]);

        return true;
    } catch (Throwable $e) {
        error_log('reset throttle check failed: ' . $e->getMessage());
        return false;
    }
}

/**
 * Partly hide an address for the two-factor screen: t****@example.com
 *
 * Enough for the right person to recognise which inbox to open, not enough for
 * somebody who only has the password to learn the address itself.
 */
function maskEmail(string $email): string
{
    $at = strrpos($email, '@');
    if ($at === false || $at === 0) {
        return 'your email address';
    }

    $local = substr($email, 0, $at);
    $domain = substr($email, $at);

    if (mb_strlen($local) <= 1) {
        return $local . '***' . $domain;
    }

    return mb_substr($local, 0, 1) . str_repeat('*', min(6, mb_strlen($local) - 1)) . $domain;
}

/**
 * Initials for the header avatar, matching getInitials() in app.js.
 */
function userInitials(string $name): string
{
    $parts = preg_split('/\s+/', trim($name)) ?: [];
    $parts = array_values(array_filter($parts, static fn($p) => $p !== ''));

    if ($parts === []) {
        return '?';
    }
    if (count($parts) === 1) {
        return mb_strtoupper(mb_substr($parts[0], 0, 2));
    }

    return mb_strtoupper(mb_substr($parts[0], 0, 1) . mb_substr($parts[count($parts) - 1], 0, 1));
}

/**
 * Absolute link to the password screen, mirroring api/users.php.
 */
function buildPasswordLink(string $token): string
{
    if (APP_BASE_URL !== '') {
        $base = APP_BASE_URL;
    } else {
        $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
        if (!preg_match('/^[A-Za-z0-9.-]+(?::\d{1,5})?$/', $host)) {
            $host = 'localhost';
        }

        $scheme = Auth::isHttps() ? 'https' : 'http';
        $dir = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/'))), '/');
        $base = $scheme . '://' . $host . $dir;
    }

    return rtrim($base, '/') . '/index.php?action=set-password&token=' . urlencode($token);
}

/**
 * The address of one of the app's own stylesheets or scripts, with a version
 * that changes whenever the file does.
 *
 * The host serves static files with a cache lifetime of a week. Without the
 * version, a browser keeps running last week's script against today's page
 * after an update - until somebody thinks of a hard reload.
 */
function assetUrl(string $path): string
{
    $modified = @filemtime(APP_ROOT . '/' . $path);

    return htmlspecialchars($path . ($modified ? '?v=' . $modified : ''), ENT_QUOTES, 'UTF-8');
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars(APP_NAME) ?></title>

    <!--
        General Sans, served from this server rather than a font CDN: no
        third party learns who opens the CRM, and the page does not wait on
        anyone else's servers. The two weights used above the fold are
        preloaded; the rest arrive as they are needed.
    -->
    <link rel="preload" href="assets/fonts/GeneralSans-500.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="assets/fonts/GeneralSans-600.woff2" as="font" type="font/woff2" crossorigin>

    <!-- Leaflet CSS -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">

    <!-- Leaflet MarkerCluster CSS -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.css" integrity="sha384-lPzjPsFQL6te2x+VxmV6q1DpRxpRk0tmnl2cpwAO5y04ESyc752tnEWPKDfl1olr" crossorigin="anonymous">
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.Default.css" integrity="sha384-5kMSQJ6S4Qj5i09mtMNrWpSi8iXw230pKU76xTmrpezGnNJQzj0NzXjQLLg+jE7k" crossorigin="anonymous">

    <script nonce="<?= htmlspecialchars(Auth::getCspNonce(), ENT_QUOTES, 'UTF-8') ?>">
        (function() {
            try {
                var storedTheme = localStorage.getItem('crm-theme');
                if (storedTheme === 'light' || storedTheme === 'dark') {
                    document.documentElement.setAttribute('data-theme', storedTheme);
                }
                // Before first paint, so a collapsed sidebar does not flash open.
                if (localStorage.getItem('crm-sidebar-collapsed') === '1') {
                    document.documentElement.classList.add('sidebar-collapsed');
                }
            } catch (e) {
                // Ignore storage errors and keep default theme
            }
        })();
    </script>

    <!-- Application CSS -->
    <link rel="stylesheet" href="<?= assetUrl('assets/css/style.css') ?>">
    <link rel="stylesheet" href="<?= assetUrl('assets/css/bookkeeping.css') ?>">
    <!-- The design system. Loaded last: its tokens and components are the
         final word over the two stylesheets above. -->
    <link rel="stylesheet" href="<?= assetUrl('assets/css/design.css') ?>">
    <link rel="stylesheet" href="<?= assetUrl('assets/css/review.css') ?>">
</head>
<body>
    <?php if (!$isAuthenticated): ?>
        <?php if ($action === 'set-password'): ?>
            <!-- Choose a password (invite / reset link) -->
            <div class="login-container">
                <div class="login-box">
                    <h1><?= htmlspecialchars(APP_NAME) ?></h1>

                    <?php if ($passwordTokenUser === null): ?>
                        <p class="login-subtitle">This link cannot be used</p>
                        <div class="alert alert-error">
                            It has expired, has already been used, or was not copied in full.
                        </div>
                        <a href="index.php?action=forgot" class="btn btn-primary btn-block">Request a new link</a>
                        <p class="login-alt"><a href="index.php">Back to sign in</a></p>
                    <?php else: ?>
                        <p class="login-subtitle">
                            <?= $passwordTokenPurpose === User::PURPOSE_RESET ? 'Choose a new password' : 'Welcome' ?>,
                            <?= htmlspecialchars((string) $passwordTokenUser['name']) ?>
                        </p>

                        <?php if ($passwordError !== null): ?>
                            <div class="alert alert-error"><?= htmlspecialchars($passwordError) ?></div>
                        <?php endif; ?>

                        <form method="POST" action="index.php?action=set-password" class="login-form" autocomplete="off">
                            <input type="hidden" name="csrf_token" value="<?= htmlspecialchars(Auth::getCsrfToken()) ?>">
                            <input type="hidden" name="token" value="<?= htmlspecialchars($passwordToken, ENT_QUOTES, 'UTF-8') ?>">

                            <div class="form-group">
                                <input type="email"
                                       value="<?= htmlspecialchars((string) $passwordTokenUser['email']) ?>"
                                       class="form-input"
                                       autocomplete="username"
                                       readonly>
                            </div>
                            <div class="form-group">
                                <input type="password"
                                       name="password"
                                       placeholder="New password"
                                       minlength="<?= (int) MIN_PASSWORD_LENGTH ?>"
                                       required
                                       autofocus
                                       autocomplete="new-password"
                                       class="form-input">
                            </div>
                            <div class="form-group">
                                <input type="password"
                                       name="password_confirm"
                                       placeholder="Repeat password"
                                       minlength="<?= (int) MIN_PASSWORD_LENGTH ?>"
                                       required
                                       autocomplete="new-password"
                                       class="form-input">
                            </div>
                            <p class="login-hint">At least <?= (int) MIN_PASSWORD_LENGTH ?> characters.</p>
                            <button type="submit" class="btn btn-primary btn-block">Set password &amp; sign in</button>
                        </form>
                    <?php endif; ?>
                </div>
            </div>

        <?php elseif ($action === 'forgot'): ?>
            <!-- Forgot password -->
            <div class="login-container">
                <div class="login-box">
                    <h1><?= htmlspecialchars(APP_NAME) ?></h1>
                    <p class="login-subtitle">We will email you a link to choose a new password</p>

                    <?php if ($forgotError !== null): ?>
                        <div class="alert alert-error"><?= htmlspecialchars($forgotError) ?></div>
                    <?php endif; ?>

                    <?php if ($forgotNotice !== null): ?>
                        <div class="alert alert-success"><?= htmlspecialchars($forgotNotice) ?></div>
                        <p class="login-alt"><a href="index.php">Back to sign in</a></p>
                    <?php else: ?>
                        <form method="POST" action="index.php?action=forgot" class="login-form">
                            <input type="hidden" name="csrf_token" value="<?= htmlspecialchars(Auth::getCsrfToken()) ?>">
                            <div class="form-group">
                                <input type="email"
                                       name="email"
                                       placeholder="Your email"
                                       required
                                       autofocus
                                       autocomplete="username"
                                       class="form-input">
                            </div>
                            <button type="submit" class="btn btn-primary btn-block">Send reset link</button>
                        </form>
                        <p class="login-alt"><a href="index.php">Back to sign in</a></p>
                    <?php endif; ?>
                </div>
            </div>

        <?php elseif ($action === 'verify' && $twoFactorPending !== null): ?>
            <!-- Two-factor: enter the emailed code -->
            <div class="login-container">
                <div class="login-box">
                    <h1><?= htmlspecialchars(APP_NAME) ?></h1>
                    <p class="login-subtitle">
                        Enter the code we sent to
                        <strong><?= htmlspecialchars(maskEmail((string) $twoFactorPending['email'])) ?></strong>
                    </p>

                    <?php if ($twoFactorNotice !== null): ?>
                        <div class="alert <?= $twoFactorNoticeOk ? 'alert-success' : 'alert-warning' ?>"><?= htmlspecialchars($twoFactorNotice) ?></div>
                    <?php endif; ?>

                    <?php if ($twoFactorError !== null): ?>
                        <div class="alert alert-error"><?= htmlspecialchars($twoFactorError) ?></div>
                    <?php endif; ?>

                    <?php if ($twoFactorDebugCode !== null): ?>
                        <!-- Local instance only: Auth::isLocalRequest() gates this,
                             so it can never render for a remote visitor. -->
                        <div class="alert alert-warning login-devcode">
                            <strong>Local testing</strong>
                            <span>Mail could not be sent, so the code is shown here. This only
                                  happens for requests from this machine.</span>
                            <code><?= htmlspecialchars($twoFactorDebugCode) ?></code>
                        </div>
                    <?php endif; ?>

                    <form method="POST" action="index.php?action=verify" class="login-form">
                        <input type="hidden" name="csrf_token" value="<?= htmlspecialchars(Auth::getCsrfToken()) ?>">
                        <div class="form-group">
                            <input type="text"
                                   name="code"
                                   placeholder="6-digit code"
                                   inputmode="numeric"
                                   pattern="[0-9]*"
                                   maxlength="6"
                                   autocomplete="one-time-code"
                                   required
                                   autofocus
                                   class="form-input login-code-input">
                        </div>
                        <button type="submit" class="btn btn-primary btn-block">Verify &amp; sign in</button>
                    </form>

                    <form method="POST" action="index.php?action=verify" class="login-form login-resend">
                        <input type="hidden" name="csrf_token" value="<?= htmlspecialchars(Auth::getCsrfToken()) ?>">
                        <button type="submit" name="resend" value="1" class="btn-link">Send a new code</button>
                    </form>

                    <p class="login-alt">
                        <a href="index.php?action=verify&amp;cancel=1">Use a different account</a>
                    </p>
                </div>
            </div>

        <?php else: ?>
            <!-- Login Screen -->
            <div class="login-container">
                <div class="login-box">
                    <h1><?= htmlspecialchars(APP_NAME) ?></h1>
                    <p class="login-subtitle">Sign in to continue</p>

                    <?php if ($loginNotice !== null): ?>
                        <div class="alert alert-success"><?= htmlspecialchars($loginNotice) ?></div>
                    <?php endif; ?>

                    <?php if ($loginError !== null): ?>
                        <div class="alert alert-error"><?= htmlspecialchars($loginError) ?></div>
                    <?php endif; ?>

                    <?php if ($isLockedOut): ?>
                        <div class="alert alert-error lockout-alert">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="vertical-align: middle; margin-right: 6px;">
                                <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/>
                            </svg>
                            Temporarily locked. Try again in <strong id="lockoutTimer"><?= ceil($lockoutRemaining / 60) ?></strong> minute(s).
                        </div>
                        <form method="POST" action="index.php?action=login" class="login-form">
                            <input type="hidden" name="csrf_token" value="<?= htmlspecialchars(Auth::getCsrfToken()) ?>">
                            <div class="form-group">
                                <input type="email" name="email" placeholder="Email" disabled class="form-input">
                            </div>
                            <div class="form-group">
                                <input type="password" name="password" placeholder="Password" disabled class="form-input">
                            </div>
                            <button type="submit" class="btn btn-primary btn-block" disabled>Locked</button>
                        </form>
                        <script nonce="<?= htmlspecialchars(Auth::getCspNonce(), ENT_QUOTES, 'UTF-8') ?>">
                            (function() {
                                var remaining = <?= (int)$lockoutRemaining ?>;
                                var timer = document.getElementById('lockoutTimer');
                                var interval = setInterval(function() {
                                    remaining--;
                                    if (remaining <= 0) {
                                        clearInterval(interval);
                                        window.location.reload();
                                    } else {
                                        timer.textContent = Math.ceil(remaining / 60);
                                    }
                                }, 1000);
                            })();
                        </script>
                    <?php else: ?>
                        <form method="POST" action="index.php?action=login" class="login-form">
                            <input type="hidden" name="csrf_token" value="<?= htmlspecialchars(Auth::getCsrfToken()) ?>">
                            <div class="form-group">
                                <input type="email"
                                       name="email"
                                       value="<?= htmlspecialchars($loginEmail, ENT_QUOTES, 'UTF-8') ?>"
                                       placeholder="Email"
                                       autocomplete="username"
                                       autofocus
                                       class="form-input">
                            </div>
                            <div class="form-group">
                                <input type="password"
                                       name="password"
                                       placeholder="Password"
                                       required
                                       autocomplete="current-password"
                                       class="form-input">
                            </div>
                            <?php if (REMEMBER_ME_ENABLED): ?>
                                <label class="login-remember">
                                    <input type="checkbox" name="remember" value="1"<?= $rememberChecked ? ' checked' : '' ?>>
                                    <span>Keep me signed in on this device</span>
                                </label>
                            <?php endif; ?>
                            <button type="submit" class="btn btn-primary btn-block">Sign in</button>
                        </form>
                        <p class="login-alt">
                            <a href="index.php?action=forgot">Forgot password?</a>
                        </p>
                    <?php endif; ?>
                </div>
            </div>
        <?php endif; ?>

    <?php else: ?>
        <!-- Main Application -->
        <div class="app-container">
            <!--
                Sidebar: the primary navigation on desktop, an icon rail on
                tablets, and a slide-in drawer on phones (opened from "More" in
                the tab bar). Every .toggle-btn[data-view] is wired to
                switchView() by app.js, wherever it sits in the page.
            -->
            <aside class="sidebar" id="sidebar" aria-label="Main navigation">
                <div class="sidebar-brand">
                    <span class="brand-name"><?= htmlspecialchars(APP_NAME) ?></span>
                    <!-- Desktop only: folds the sidebar into the same icon rail tablets get -->
                    <button type="button" class="sidebar-collapse-btn" id="sidebarCollapseBtn"
                            aria-controls="sidebar" aria-expanded="true" aria-label="Collapse sidebar" title="Collapse sidebar">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M9.5 4v16"/><path class="sidebar-collapse-chevron" d="m15.5 10-2 2 2 2"/>
                        </svg>
                    </button>
                </div>

                <nav class="sidebar-nav">
                    <button type="button" class="toggle-btn nav-item active" data-view="workload" title="Home">
                        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"/>
                        </svg>
                        <span class="nav-label">Home</span>
                        <span class="toggle-badge nav-count nav-count--alert" id="workloadBadge" data-workload-badge hidden>0</span>
                    </button>
                    <button type="button" class="toggle-btn nav-item" data-view="projects" title="Projects">
                        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.5 7V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V7"/><path d="M3 12.5h18"/>
                        </svg>
                        <span class="nav-label">Projects</span>
                    </button>
                    <button type="button" class="toggle-btn nav-item" data-view="todos" title="To-dos">
                        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8.5 12 2.5 2.5 4.5-5"/>
                        </svg>
                        <span class="nav-label">To-dos</span>
                    </button>
                    <button type="button" class="toggle-btn nav-item" data-view="list" title="Contacts">
                        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M18.5 14c1.9.8 3 2.9 3 6"/>
                        </svg>
                        <span class="nav-label">Contacts</span>
                    </button>
                    <button type="button" class="toggle-btn nav-item" data-view="calendar" title="Calendar">
                        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>
                        </svg>
                        <span class="nav-label">Calendar</span>
                    </button>
                    <button type="button" class="toggle-btn nav-item" data-view="bookkeeping" title="Bookkeeping">
                        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M6 3.5h12a1 1 0 0 1 1 1V21l-2.5-1.6L14 21l-2-1.6L10 21l-2.5-1.6L5 21V4.5a1 1 0 0 1 1-1z"/><path d="M9 8.5h6M9 12.5h6"/>
                        </svg>
                        <span class="nav-label">Bookkeeping</span>
                    </button>
                    <button type="button" class="toggle-btn nav-item" data-view="review" title="From Claude - waiting for review">
                        <!-- Claude's mark, filled: the outline style of the other icons would blur its rays -->
                        <svg class="nav-icon nav-icon--claude" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>
                        </svg>
                        <span class="nav-label">From Claude</span>
                        <span class="toggle-badge nav-count nav-count--alert" id="reviewBadge" data-review-badge hidden>0</span>
                    </button>
                </nav>

                <!-- The team, one click away from each person's workload -->
                <div class="sidebar-team" id="sidebarTeamWrap" hidden>
                    <div class="sidebar-heading">Team</div>
                    <div class="team-list" id="sidebarTeam"></div>
                </div>

                <div class="sidebar-foot">
                    <?php if ($isAdmin): ?>
                    <button type="button" class="nav-item nav-item--quiet" id="manageUsersBtn" title="Manage users">
                        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c0-3.6 2.9-6.5 6.5-6.5 1.2 0 2.3.3 3.2.8"/><circle cx="17.5" cy="17" r="2.5"/><path d="M17.5 13v1.5M17.5 19.5V21M21.5 17H20M15 17h-1.5"/>
                        </svg>
                        <span class="nav-label header-btn-label">Users</span>
                    </button>
                    <?php endif; ?>
                    <button type="button" class="nav-item nav-item--quiet theme-toggle-btn" id="themeToggleBtn" aria-label="Switch to dark mode" title="Switch to dark mode">
                        <span class="nav-label theme-toggle-label">Dark mode</span>
                    </button>

                    <div class="user-chip-wrap">
                        <button type="button" class="user-chip" id="userChip"
                                title="<?= htmlspecialchars(($currentUser['email'] ?? 'Owner login') . ' - ' . ($isAdmin ? 'Administrator' : 'Member')) ?>"
                                aria-haspopup="dialog" aria-expanded="false">
                            <span class="user-chip-avatar" id="userChipAvatar"><?= htmlspecialchars(userInitials($currentUser['name'] ?? '')) ?></span>
                            <span class="user-chip-text">
                                <span class="user-chip-name"><?= htmlspecialchars($currentUser['name'] ?? '') ?></span>
                                <span class="user-chip-role"><?= $isAdmin ? 'Admin' : 'Member' ?></span>
                            </span>
                        </button>
                        <a href="index.php?action=logout" class="user-chip-logout header-logout-btn" title="Sign out" aria-label="Sign out">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5"/><path d="m10 16.5-4.5-4.5L10 7.5"/><path d="M5.5 12H15"/>
                            </svg>
                        </a>

                        <!-- Profile picture popover -->
                        <div class="profile-pop" id="profilePop" hidden role="dialog" aria-label="Your profile picture">
                            <div class="profile-pop-head">
                                <div class="profile-pop-avatar" id="profilePopAvatar"><?= htmlspecialchars(userInitials($currentUser['name'] ?? '')) ?></div>
                                <div class="profile-pop-info">
                                    <div class="profile-pop-name"><?= htmlspecialchars($currentUser['name'] ?? '') ?></div>
                                    <div class="profile-pop-sub"><?= htmlspecialchars($currentUser['email'] ?? 'Owner login') ?></div>
                                </div>
                            </div>
                            <div class="profile-pop-actions">
                                <button type="button" class="btn btn-secondary btn-small btn-block" id="profilePhotoBtn">
                                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                        <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.2"/>
                                    </svg>
                                    <span id="profilePhotoBtnLabel">Upload photo</span>
                                </button>
                                <button type="button" class="btn btn-secondary btn-small btn-block profile-pop-remove" id="profileRemoveBtn" hidden>Remove photo</button>
                            </div>
                            <p class="profile-pop-hint">JPEG, PNG, GIF or WebP &middot; up to 5 MB</p>
                            <input type="file" id="profilePhotoInput" accept="image/jpeg,image/png,image/gif,image/webp" hidden>
                        </div>
                    </div>
                </div>
            </aside>
            <div class="sidebar-scrim" id="sidebarScrim" hidden></div>

            <div class="app-body">
            <!-- Main Content -->
            <main class="app-main">
                <!-- My Work: everything assigned to one person -->
                <!-- My Work is the home tab, so it is the one the server renders
                     active. app.js switches to the device's remembered tab on
                     load if there is one. -->
                <div class="view-panel active" id="workloadView">
                    <div class="workload-wrap">
                        <div class="workload-head">
                            <div class="workload-person">
                                <span class="workload-person-face" id="workloadFace"></span>
                                <div class="workload-person-text">
                                    <h1 class="workload-title" id="workloadTitle">My Work</h1>
                                    <p class="workload-subtitle" id="workloadSummary">Nothing assigned yet</p>
                                </div>
                            </div>
                            <div class="workload-switch">
                                <label for="workloadWho" class="workload-switch-label">Showing</label>
                                <select id="workloadWho" class="form-select"></select>
                            </div>
                        </div>

                        <div class="workload-body" id="workloadBody"></div>
                    </div>
                </div>

                <!-- Calendar View -->
                <div class="view-panel" id="calendarView">
                    <div class="view-head">
                        <div class="view-head-text">
                            <h1 class="view-title">Calendar</h1>
                        </div>
                    </div>

                    <div class="calendar-toolbar">
                        <div class="calendar-toolbar-left">
                            <button type="button" class="btn btn-icon" id="calPrev" title="Zurück">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                    <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
                                </svg>
                            </button>
                            <button type="button" class="btn btn-secondary btn-small" id="calToday">Heute</button>
                            <button type="button" class="btn btn-icon" id="calNext" title="Weiter">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
                                </svg>
                            </button>
                            <h2 class="calendar-title" id="calTitle"></h2>
                        </div>
                        <div class="calendar-toolbar-right">
                            <div class="calendar-mode-toggle">
                                <button type="button" class="cal-mode-btn active" data-mode="month">Monat</button>
                                <button type="button" class="cal-mode-btn" data-mode="week">Woche</button>
                                <button type="button" class="cal-mode-btn" data-mode="day">Tag</button>
                            </div>
                        </div>
                    </div>
                    <div class="calendar-filters" id="calendarFilters">
                        <div class="calendar-search-box">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" class="cal-search-icon">
                                <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                            </svg>
                            <input type="text" id="calSearchInput" placeholder="Name, Firma, Projekt oder To-do suchen..." class="cal-search-input">
                        </div>
                        <div class="calendar-tag-filter">
                            <select id="calTagFilter" class="form-select">
                                <option value="">Alle Tags</option>
                            </select>
                        </div>
                        <button type="button" class="btn btn-icon calendar-filter-toggle-btn" id="calFilterToggle" title="Filter">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="calendar-body" id="calendarBody">
                        <!-- Calendar grid rendered by JS -->
                    </div>
                </div>

                <!-- Bookkeeping View -->
                <!-- From Claude: everything the MCP API proposed, waiting for a person.
                     Filled in by review.js. -->
                <div class="view-panel" id="reviewView">
                    <div class="view-head">
                        <div class="view-head-text">
                            <h1 class="view-title">From Claude</h1>
                            <p class="view-sub" id="reviewSubtitle">Everything Claude adds or changes waits here until someone on the team accepts it.</p>
                        </div>
                        <div class="segmented" role="tablist" aria-label="Show proposals">
                            <button type="button" class="segmented-btn active" data-review-tab="pending" role="tab" aria-selected="true">Waiting</button>
                            <button type="button" class="segmented-btn" data-review-tab="resolved" role="tab" aria-selected="false">History</button>
                        </div>
                    </div>
                    <!-- Decide everything waiting at once (review.js decideAll) -->
                    <div class="review-bulk" id="reviewBulk" hidden>
                        <div class="review-bulk-progress" aria-hidden="true"><span class="review-bulk-bar" id="reviewBulkBar"></span></div>
                        <span class="review-bulk-status" id="reviewBulkStatus" role="status"></span>
                        <div class="review-bulk-actions">
                            <button type="button" class="btn btn-secondary btn-small review-bulk-btn review-bulk-btn--reject" data-review-bulk="reject">
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
                                <span>Reject all</span>
                            </button>
                            <button type="button" class="btn btn-primary btn-small review-bulk-btn review-bulk-btn--accept" data-review-bulk="accept">
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
                                <span>Accept all</span>
                            </button>
                        </div>
                    </div>
                    <div class="review-list" id="reviewList" aria-live="polite"></div>
                </div>

                <div class="view-panel" id="bookkeepingView">
                    <div class="view-head">
                        <div class="view-head-text">
                            <h1 class="view-title">Bookkeeping</h1>
                        </div>
                    </div>

                    <!-- One toolbar. The date tools that used to occupy a bar of
                         their own are behind the Select button: they tick rows by
                         month or range, which is an occasional job, not something
                         that needs permanent screen space. -->
                    <header class="bk-bar">
                        <div class="bk-bar-lead">
                            <h2 class="bk-bar-title">Bookkeeping</h2>
                            <span class="bk-row-count" id="bkRowCount">0 entries</span>
                        </div>

                        <div class="bk-bar-tools">
                            <div class="bk-search">
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" class="bk-search-icon" aria-hidden="true">
                                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                                </svg>
                                <input type="text" id="bkFilterInput" class="bk-search-input" placeholder="Search" aria-label="Search all columns">
                            </div>

                            <div class="bk-menu-wrap">
                                <button type="button" class="bk-btn" id="bkSelectToolsBtn"
                                        aria-haspopup="dialog" aria-expanded="false" aria-controls="bkSelectTools"
                                        title="Select rows by date">
                                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                                        <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/>
                                    </svg>
                                    <span>Select</span>
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" class="bk-btn-chevron" aria-hidden="true">
                                        <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                                    </svg>
                                </button>

                                <div class="bk-menu" id="bkSelectTools" role="dialog" aria-label="Select rows by date" hidden>
                                    <p class="bk-menu-title">Select rows by date</p>

                                    <div class="bk-menu-section">
                                        <label class="bk-menu-label" for="bkSelectMonth">Month</label>
                                        <div class="bk-menu-row">
                                            <select id="bkSelectMonth" class="form-select"></select>
                                            <select id="bkSelectYear" class="form-select"></select>
                                        </div>
                                        <button type="button" class="bk-btn bk-btn-block" id="bkSelectMonthBtn">Select month</button>
                                    </div>

                                    <div class="bk-menu-sep"></div>

                                    <div class="bk-menu-section">
                                        <label class="bk-menu-label" for="bkSelectFrom">Date range</label>
                                        <div class="bk-menu-row">
                                            <input type="date" id="bkSelectFrom" class="form-input" aria-label="From">
                                            <span class="bk-menu-dash">&ndash;</span>
                                            <input type="date" id="bkSelectTo" class="form-input" aria-label="To">
                                        </div>
                                        <button type="button" class="bk-btn bk-btn-block" id="bkSelectRangeBtn">Select range</button>
                                    </div>
                                </div>
                            </div>

                            <button type="button" class="bk-btn bk-btn-primary" id="bkImportCsvBtn" title="Import a CSV file">
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                                    <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                                </svg>
                                <span>Import</span>
                            </button>
                            <input type="file" id="bkCsvInput" accept=".csv,text/csv" hidden>
                        </div>
                    </header>

                    <div class="bk-body">
                        <div class="bk-table-wrap" id="bkTableWrap">
                            <div class="bk-table-inner" id="bkTableInner">
                                <!-- Table rendered by JS -->
                            </div>
                            <div class="bk-row-drop-pill" id="bkRowDropPill" aria-hidden="true">Drop PDF here</div>
                        </div>

                        <aside class="bk-dropzone" id="bkDropzone">
                            <div class="bk-dropzone-header">
                                <h3 class="bk-dropzone-title">
                                    Drop Zone
                                    <span class="bk-pool-count" id="bkPoolCount">0 files</span>
                                </h3>
                                <button type="button" class="bk-btn bk-btn-small" id="bkPoolBrowseBtn" title="Upload PDFs">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                        <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                                    </svg>
                                    <span>Upload</span>
                                </button>
                            </div>
                            <p class="bk-dropzone-hint">Invoices parked here until their bank entry is imported. Drag one onto a row to assign it.</p>
                            <div class="bk-pool-list" id="bkPoolList">
                                <!-- Unassigned PDFs rendered by JS -->
                            </div>
                            <input type="file" id="bkPoolInput" accept=".pdf,application/pdf" multiple hidden>
                        </aside>

                        <!-- Contextual action bar: floats over the table only while
                             rows are ticked, so the toolbar above stays uncluttered. -->
                        <div class="bk-selection-bar" id="bkSelectionBar">
                            <span class="bk-selection-count" id="bkSelectionCount"></span>
                            <span class="bk-selection-sep" aria-hidden="true"></span>
                            <button type="button" class="bk-sel-btn" id="bkExportSelectedBtn" title="Download all PDFs of the selected rows as a ZIP file">
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                                    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                                </svg>
                                <span>Export PDFs</span>
                            </button>
                            <button type="button" class="bk-sel-btn bk-sel-btn-danger" id="bkDeleteSelectedBtn">
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                                </svg>
                                <span>Delete</span>
                            </button>
                            <button type="button" class="bk-sel-btn bk-sel-btn-plain" id="bkClearSelectionBtn">Done</button>
                        </div>
                    </div>
                </div>

                <!-- List View -->
                <div class="view-panel" id="listView">
                    <div class="view-head">
                        <div class="view-head-text">
                            <h1 class="view-title">Contacts</h1>
                            <p class="view-sub"><span data-contact-count><?= (int) $contactCount ?></span> people</p>
                        </div>
                        <!-- The map is a way of looking at contacts, not a place of
                             its own, so it lives here as a second mode. -->
                        <div class="segmented" role="tablist" aria-label="Show contacts as">
                            <button type="button" class="segmented-btn active" data-contacts-mode="list" role="tab" aria-selected="true">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
                                    <path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>
                                </svg>
                                <span>List</span>
                            </button>
                            <button type="button" class="segmented-btn" data-contacts-mode="map" id="contactsMapBtn" role="tab" aria-selected="false">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <path d="m9 4.5-5.5 2v13l5.5-2 6 2 5.5-2v-13l-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>
                                </svg>
                                <span>Map</span>
                            </button>
                        </div>
                    </div>

                    <div class="list-header">
                        <div class="list-header-top">
                            <div class="search-box">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" class="search-icon">
                                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                                </svg>
                                <input type="text" id="searchInput" placeholder="Search contacts..." class="search-input">
                            </div>
                            <div class="list-header-actions">
                                <button type="button" class="btn btn-secondary" id="importExportBtn" title="Import/Export Contacts">
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                                    </svg>
                                    <span>Import/Export</span>
                                </button>
                                <button type="button" class="btn btn-primary" id="addContactBtn" title="Add Contact">
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                    </svg>
                                    <span>Add Contact</span>
                                </button>
                                <button type="button" class="btn btn-icon list-filter-toggle" id="listFilterToggle" title="Filters">
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                        <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div class="list-controls" id="listControls">
                            <!-- Group By Toggle -->
                            <div class="group-toggle">
                                <button type="button" class="group-btn active" data-group="company" title="Group by Company">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                        <path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z"/>
                                    </svg>
                                    <span>Firma</span>
                                </button>
                                <button type="button" class="group-btn" data-group="tags" title="Group by Tags">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                        <path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>
                                    </svg>
                                    <span>Tags</span>
                                </button>
                            </div>
                            <div class="sort-controls">
                                <label>Sort:</label>
                                <select id="sortField" class="form-select">
                                    <option value="name">Name</option>
                                    <option value="company">Company</option>
                                    <option value="location">Location</option>
                                    <option value="created_at">Date Added</option>
                                </select>
                                <button type="button" id="sortOrderBtn" class="btn btn-icon" title="Toggle sort order">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" id="sortOrderIcon">
                                        <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="contacts-list" id="contactsList">
                        <!-- Contacts will be loaded here -->
                    </div>

                    <!-- Map mode. Kept as #mapView so the existing map code finds it. -->
                    <div class="contacts-map" id="mapView" hidden>
                        <div id="map"></div>
                    </div>
                </div>

                <!-- To-Do View -->
                <div class="view-panel" id="todoView">
                    <div class="view-head">
                        <div class="view-head-text">
                            <h1 class="view-title">To-dos</h1>
                        </div>
                    </div>

                    <div class="list-header">
                        <div class="list-header-top">
                            <div class="search-box">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" class="search-icon">
                                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                                </svg>
                                <input type="text" id="searchTodosInput" placeholder="Search to-dos..." class="search-input">
                            </div>
                            <div class="list-header-actions">
                                <button type="button" class="btn btn-primary" id="addTodoBtn" title="New To-Do">
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                    </svg>
                                    <span>New To-Do</span>
                                </button>
                                <button type="button" class="btn btn-icon list-filter-toggle" id="todoFilterToggle" title="Filters">
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                        <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div class="todo-controls list-controls" id="todoFilterControls">
                            <select id="todoAssignedFilter" class="form-select" title="Assigned to">
                                <option value="">Assigned to anyone</option>
                            </select>
                            <select id="todoContactFilter" class="form-select">
                                <option value="">All Contacts</option>
                            </select>
                            <select id="todoProjectFilter" class="form-select">
                                <option value="">All Projects</option>
                            </select>
                            <select id="todoStatusFilter" class="form-select">
                                <option value="open">Open</option>
                                <option value="completed">Completed</option>
                                <option value="all">All</option>
                            </select>
                            <select id="todoSort" class="form-select" title="Sort to-dos">
                                <option value="default">Sort: Default</option>
                                <option value="priority_desc">Sort: Priority (High to Low)</option>
                                <option value="priority_asc">Sort: Priority (Low to High)</option>
                            </select>
                        </div>
                    </div>
                    <div class="todos-list" id="todosList">
                        <!-- To-dos will be loaded here -->
                    </div>
                </div>

                <!-- Projects View -->
                <div class="view-panel" id="projectsView">
                    <div class="view-head">
                        <div class="view-head-text">
                            <h1 class="view-title">Projects</h1>
                        </div>
                    </div>

                    <!--
                        Pipeline summary: three small charts drawn by app.js from
                        the projects on screen. The chevron opens the breakdown.
                    -->
                    <section class="kpi-band kpi-band--projects" id="projectsSummary" aria-label="Pipeline summary" hidden>
                        <div class="kpi-grid" id="projectsKpis"></div>
                        <button type="button" class="kpi-toggle" id="projectsBreakdownToggle"
                                aria-expanded="false" aria-controls="projectsBreakdown"
                                aria-label="Show breakdown" title="Show breakdown">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="m6 9 6 6 6-6"/>
                            </svg>
                        </button>
                        <div class="kpi-detail" id="projectsBreakdown" hidden></div>
                    </section>

                    <div class="list-header">
                        <div class="list-header-top">
                            <div class="search-box">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" class="search-icon">
                                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                                </svg>
                                <input type="text" id="searchProjectsInput" placeholder="Search projects..." class="search-input">
                            </div>
                            <div class="list-header-actions">
                                <button type="button" class="btn btn-primary" id="addProjectBtn" title="Add Project">
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                    </svg>
                                    <span>Add Project</span>
                                </button>
                                <button type="button" class="btn btn-icon list-filter-toggle" id="projectFilterToggle" title="Filters">
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                        <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div class="list-controls" id="projectControls">
                            <div class="sort-controls">
                                <label>Sort:</label>
                                <select id="projectSortField" class="form-select">
                                    <option value="name">Name</option>
                                    <option value="company">Company</option>
                                    <option value="start_date">Start Date</option>
                                    <option value="stage" selected>Stage</option>
                                    <option value="success_chance">Success Chance</option>
                                </select>
                                <button type="button" id="projectSortOrderBtn" class="btn btn-icon" title="Toggle sort order">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" id="projectSortOrderIcon">
                                        <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                                    </svg>
                                </button>
                            </div>
                            <label class="filter-check" id="hideCompletedWrap">
                                <input type="checkbox" id="hideCompletedProjects" checked>
                                <span>Hide completed</span>
                                <span class="filter-check-count" id="hiddenCompletedCount" hidden></span>
                            </label>
                        </div>
                    </div>
                    <div class="projects-list" id="projectsList">
                        <!-- Projects will be loaded here -->
                    </div>

                    <!-- Deleted projects: kept whole, restorable (ProjectArchive) -->
                    <details class="deleted-projects" id="deletedProjects" hidden>
                        <summary class="deleted-projects-head">
                            <span class="deleted-projects-title">Deleted projects</span>
                            <span class="deleted-projects-count" id="deletedProjectsCount">0</span>
                        </summary>
                        <p class="deleted-projects-hint">Restoring brings a project back with its to-dos, notes, tags, contacts and documents.</p>
                        <div class="deleted-projects-list" id="deletedProjectsList"></div>
                    </details>
                </div>
            </main>
            </div>

            <!--
                Phone tab bar: the four places people go most, plus "More",
                which slides the sidebar in as a drawer for everything else.
                "More" is deliberately not a .toggle-btn - it opens the drawer
                rather than switching to a view.
            -->
            <nav class="tabbar" aria-label="Main navigation">
                <button type="button" class="toggle-btn tab-item active" data-view="workload">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"/>
                    </svg>
                    <span>Home</span>
                    <span class="toggle-badge tab-badge" data-workload-badge hidden>0</span>
                </button>
                <button type="button" class="toggle-btn tab-item" data-view="projects">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.5 7V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V7"/><path d="M3 12.5h18"/>
                    </svg>
                    <span>Projects</span>
                </button>
                <button type="button" class="toggle-btn tab-item" data-view="todos">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8.5 12 2.5 2.5 4.5-5"/>
                    </svg>
                    <span>To-dos</span>
                </button>
                <button type="button" class="toggle-btn tab-item" data-view="list">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M18.5 14c1.9.8 3 2.9 3 6"/>
                    </svg>
                    <span>Contacts</span>
                </button>
                <button type="button" class="tab-item" id="tabbarMoreBtn" aria-controls="sidebar" aria-expanded="false">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="5.5" cy="12" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="18.5" cy="12" r="1.25"/>
                    </svg>
                    <span>More</span>
                    <!-- "From Claude" lives in the drawer on phones; its count shows here -->
                    <span class="toggle-badge tab-badge" data-review-badge hidden>0</span>
                </button>
            </nav>
        </div>

        <!-- Contact Modal -->
        <div class="modal" id="contactModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content">
                <div class="modal-header">
                    <h2 id="modalTitle">Add Contact</h2>
                    <button type="button" class="modal-close" id="closeModal">&times;</button>
                </div>
                <form id="contactForm">
                    <input type="hidden" id="contactId" name="id">

                    <div class="modal-body">
                        <!-- Required Fields -->
                        <div class="form-section">
                            <h3>Basic Information</h3>

                            <div class="form-group">
                                <label for="contactName">Name *</label>
                                <input type="text" id="contactName" name="name" required class="form-input">
                            </div>

                            <div class="form-group">
                                <label for="contactCompany">Company</label>
                                <input type="text" id="contactCompany" name="company" class="form-input">
                            </div>

                            <div class="form-group">
                                <label for="contactLocation">Location</label>
                                <input type="text" id="contactLocation" name="location" class="form-input" placeholder="City, Country or Address">
                                <small class="form-hint">Enter a location to show this contact on the map</small>
                            </div>

                            <div class="form-group">
                                <label for="contactNote">Note</label>
                                <textarea id="contactNote" name="note" class="form-input" rows="3"></textarea>
                            </div>
                        </div>

                        <!-- Expandable Additional Fields -->
                        <div class="form-section expandable">
                            <button type="button" class="expand-toggle" id="expandToggle">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" class="expand-icon">
                                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                </svg>
                                Add More Details
                            </button>

                            <div class="expandable-content" id="expandableFields">
                                <div class="form-group">
                                    <label for="contactEmail">Email</label>
                                    <input type="email" id="contactEmail" name="email" class="form-input">
                                </div>

                                <div class="form-group">
                                    <label for="contactPhone">Phone</label>
                                    <input type="tel" id="contactPhone" name="phone" class="form-input">
                                </div>

                                <div class="form-group">
                                    <label for="contactWebsite">Website</label>
                                    <input type="text" id="contactWebsite" name="website" class="form-input" placeholder="www.example.com">
                                </div>

                                <div class="form-group">
                                    <label for="contactAddress">Full Address</label>
                                    <textarea id="contactAddress" name="address" class="form-input" rows="2"></textarea>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" id="cancelBtn">Cancel</button>
                        <button type="button" class="btn btn-danger" id="deleteBtn" style="display: none;">Delete</button>
                        <button type="submit" class="btn btn-primary" id="saveBtn">Save Contact</button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Delete Confirmation Modal -->
        <div class="modal" id="deleteModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-small">
                <div class="modal-header">
                    <h2>Delete Contact</h2>
                    <button type="button" class="modal-close" id="closeDeleteModal">&times;</button>
                </div>
                <div class="modal-body">
                    <p>Are you sure you want to delete <strong id="deleteContactName"></strong>?</p>
                    <p class="text-muted">This action cannot be undone.</p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="cancelDeleteBtn">Cancel</button>
                    <button type="button" class="btn btn-danger" id="confirmDeleteBtn">Delete</button>
                </div>
            </div>
        </div>

        <!-- Contact Overview Modal -->
        <div class="modal" id="overviewModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <div class="overview-header-info">
                        <div class="overview-avatar" id="overviewAvatar"></div>
                        <div class="overview-title-info">
                            <h2 id="overviewName"></h2>
                            <p class="overview-company" id="overviewCompany"></p>
                            <p class="overview-edited" id="overviewEdited"></p>
                        </div>
                    </div>
                    <button type="button" class="modal-close" id="closeOverviewModal">&times;</button>
                </div>
                <div class="modal-body overview-body">
                    <!-- Who is responsible for this contact -->
                    <div id="overviewAssignee"></div>

                    <!-- Proposals from Claude about this contact (review.js) -->
                    <div class="review-record-slot" id="overviewReview" hidden></div>

                    <!-- Contact Details Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Contact Information</h3>
                        <div class="overview-details" id="overviewDetails">
                            <!-- Details will be populated by JS -->
                        </div>
                    </div>

                    <!-- Tags Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Tags</h3>
                        <div class="tags-container" id="contactTags">
                            <!-- Tags will be populated by JS -->
                        </div>
                        <div class="add-tag-form">
                            <div class="tag-input-wrapper">
                                <input type="text" id="newTagInput" class="form-input" placeholder="Add or create tag..." autocomplete="off">
                                <div class="tag-suggestions" id="tagSuggestions"></div>
                            </div>
                            <button type="button" class="btn btn-secondary" id="addTagBtn">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                </svg>
                                Add
                            </button>
                        </div>
                    </div>

                    <!-- Related Projects Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Related Projects</h3>
                        <div class="contact-projects-list" id="contactProjects">
                            <!-- Projects will be populated by JS -->
                        </div>
                    </div>

                    <!-- Contact To-Dos Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">To-Dos</h3>
                        <div class="todo-list" id="contactTodosList">
                            <!-- To-dos will be populated by JS -->
                        </div>
                        <div class="add-note-form">
                            <button type="button" class="btn btn-secondary" id="addContactTodoBtn">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                </svg>
                                New To-Do
                            </button>
                        </div>
                    </div>

                    <!-- Notes Timeline Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Notes Timeline</h3>
                        <div class="notes-timeline" id="notesTimeline">
                            <!-- Notes will be populated by JS -->
                        </div>

                        <!-- Add Note Form -->
                        <div class="add-note-form">
                            <textarea id="newNoteContent" class="form-input" placeholder="Add a note..." rows="3"></textarea>
                            <button type="button" class="btn btn-primary" id="addNoteBtn">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                                </svg>
                                Add Note
                            </button>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="closeOverviewBtn">Close</button>
                    <button type="button" class="btn btn-secondary" id="editContactBtn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                        Edit Contact
                    </button>
                </div>
            </div>
        </div>

        <!-- Company Notes Modal -->
        <div class="modal" id="companyNotesModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <div class="overview-header-info">
                        <div class="company-avatar">
                            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                                <path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z"/>
                            </svg>
                        </div>
                        <div class="overview-title-info">
                            <h2 id="companyNotesTitle"></h2>
                            <p class="overview-company">All notes from this company</p>
                        </div>
                    </div>
                    <button type="button" class="modal-close" id="closeCompanyNotesModal">&times;</button>
                </div>
                <div class="modal-body overview-body">
                    <div class="notes-timeline" id="companyNotesTimeline">
                        <!-- Notes will be populated by JS -->
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="closeCompanyNotesBtn">Close</button>
                </div>
            </div>
        </div>

        <!-- Import/Export Modal -->
        <div class="modal" id="importExportModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <div class="overview-header-info">
                        <div class="import-export-icon">
                            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                        </div>
                        <div class="overview-title-info">
                            <h2>Import / Export Contacts</h2>
                            <p class="overview-company">Bulk import from Excel or export all contacts</p>
                        </div>
                    </div>
                    <button type="button" class="modal-close" id="closeImportExportModal">&times;</button>
                </div>
                <div class="modal-body">
                    <!-- Export Section -->
                    <div class="import-export-section">
                        <h3>
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                            Export Contacts
                        </h3>
                        <p class="section-description">Download all your contacts as an Excel file (.xlsx)</p>
                        <button type="button" class="btn btn-primary" id="exportBtn">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                            Export All Contacts
                        </button>
                    </div>

                    <div class="import-export-divider"></div>

                    <!-- Import Section -->
                    <div class="import-export-section">
                        <h3>
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                            </svg>
                            Import Contacts
                        </h3>
                        <p class="section-description">Upload an Excel file to bulk import contacts</p>

                        <!-- Excel format reference: needed once, so folded away. The drop
                             zone below is what most visits are for. -->
                        <details class="import-instructions">
                            <summary>What should the Excel file look like?</summary>
                            <p>Your Excel file should have these columns in the <strong>first row</strong> (header row):</p>
                            <div class="column-list">
                                <div class="column-item required">
                                    <span class="column-name">Name</span>
                                    <span class="column-badge">Required</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Company</span>
                                    <span class="column-desc">Company or organization</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Location</span>
                                    <span class="column-desc">City or address (for map)</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Email</span>
                                    <span class="column-desc">Email address</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Phone</span>
                                    <span class="column-desc">Phone number</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Website</span>
                                    <span class="column-desc">Website URL</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Address</span>
                                    <span class="column-desc">Full postal address</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Note</span>
                                    <span class="column-desc">Additional notes</span>
                                </div>
                            </div>
                            <div class="import-tips">
                                <p><strong>Tips:</strong></p>
                                <ul>
                                    <li>Column order doesn't matter - headers are matched by name</li>
                                    <li>Empty cells are allowed and will be skipped</li>
                                    <li>Rows without a name will be skipped</li>
                                    <li>German column names are also supported (Firma, Telefon, etc.)</li>
                                </ul>
                            </div>
                            <button type="button" class="btn btn-secondary btn-small" id="downloadTemplateBtn">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                                    <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
                                </svg>
                                Download Template
                            </button>
                        </details>

                        <!-- File Upload Area -->
                        <div class="file-upload-area" id="fileUploadArea">
                            <input type="file" id="importFileInput" accept=".xlsx,.xls" hidden>
                            <div class="upload-content">
                                <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                                    <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                                </svg>
                                <p class="upload-text">Drop your Excel file here or <span class="upload-link">browse</span></p>
                                <p class="upload-hint">Supports .xlsx and .xls files</p>
                            </div>
                            <div class="upload-file-info" id="uploadFileInfo" style="display: none;">
                                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                                    <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
                                </svg>
                                <span class="file-name" id="uploadFileName"></span>
                                <button type="button" class="file-remove" id="removeFileBtn">&times;</button>
                            </div>
                        </div>

                        <!-- Import Button -->
                        <button type="button" class="btn btn-primary" id="importBtn" disabled>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                            </svg>
                            Import Contacts
                        </button>

                        <!-- Import Progress/Results -->
                        <div class="import-results" id="importResults" style="display: none;">
                            <div class="import-progress" id="importProgress">
                                <div class="spinner"></div>
                                <span>Importing contacts...</span>
                            </div>
                            <div class="import-success" id="importSuccess" style="display: none;">
                                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                                </svg>
                                <span id="importSuccessText"></span>
                            </div>
                            <div class="import-errors" id="importErrors" style="display: none;">
                                <h4>Import Errors:</h4>
                                <ul id="importErrorList"></ul>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="closeImportExportBtn">Close</button>
                </div>
            </div>
        </div>

        <!-- Delete Project Confirmation Modal -->
        <div class="modal" id="deleteProjectModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-small">
                <div class="modal-header">
                    <h2>Delete Project</h2>
                    <button type="button" class="modal-close" id="closeDeleteProjectModal">&times;</button>
                </div>
                <div class="modal-body">
                    <p>Delete <strong id="deleteProjectName"></strong>?</p>
                    <p class="text-muted">It moves to &ldquo;Deleted projects&rdquo; at the bottom of the Projects page, where it can be restored with everything in it.</p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="cancelDeleteProjectBtn">Cancel</button>
                    <button type="button" class="btn btn-danger" id="confirmDeleteProjectBtn">Delete</button>
                </div>
            </div>
        </div>

        <!-- Project Overview Modal.
             Reading and editing share one layout: in edit mode (.is-editing)
             each fact swaps its value for a field in the same place, so the
             sheet does not jump to another form. [data-ov="view"] shows only
             while reading, [data-ov="edit"] only while editing. A new project
             is the same sheet in edit mode (.is-new), without the sections
             that need a saved project. -->
        <div class="modal" id="projectOverviewModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <div class="overview-header-info">
                        <div class="overview-title-info">
                            <h2 id="projectOverviewName" data-ov="view">Project Name</h2>
                            <input type="text" id="projectEditName" class="form-input ov-edit-title" data-ov="edit" aria-label="Project name" placeholder="Project name" required>
                            <p class="overview-company" id="projectOverviewCompany" data-ov="view"></p>
                            <div class="autocomplete-wrapper ov-edit-company" data-ov="edit">
                                <input type="text" id="projectEditCompany" class="form-input" autocomplete="off" placeholder="Company" aria-label="Company">
                                <div class="autocomplete-suggestions" id="projectEditCompanySuggestions"></div>
                            </div>
                            <p class="overview-edited" id="projectOverviewEdited"></p>
                        </div>
                    </div>
                    <button type="button" class="modal-close" id="closeProjectOverviewModal">&times;</button>
                </div>
                <div class="modal-body overview-body">
                    <!-- Who is responsible for this project -->
                    <div id="projectOverviewAssignee"></div>

                    <!-- Proposals from Claude about this project (review.js) -->
                    <div class="review-record-slot" id="projectOverviewReview" hidden></div>

                    <!-- Project Details Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Project Information</h3>
                        <div class="overview-details">
                            <div class="overview-detail-item">
                                <label class="detail-label" for="projectEditStartDate">Start Date</label>
                                <span class="detail-value" id="projectOverviewStartDate" data-ov="view"></span>
                                <input type="date" id="projectEditStartDate" class="form-input ov-field" data-ov="edit" required>
                            </div>
                            <div class="overview-detail-item">
                                <label class="detail-label" for="projectEditStage">Stage</label>
                                <span class="detail-value" id="projectOverviewStage" data-ov="view"></span>
                                <select id="projectEditStage" class="form-select ov-field" data-ov="edit">
                                    <option value="Lead">Lead</option>
                                    <option value="Proposal">Proposal</option>
                                    <option value="Negotiation">Negotiation</option>
                                    <option value="In Progress">In Progress</option>
                                    <option value="Complete">Complete</option>
                                </select>
                            </div>
                            <div class="overview-detail-item">
                                <label class="detail-label" for="projectEditBudgetMin">Budget</label>
                                <span class="detail-value" id="projectOverviewBudget" data-ov="view"></span>
                                <div class="ov-field-pair" data-ov="edit">
                                    <input type="number" id="projectEditBudgetMin" class="form-input ov-field" step="0.01" placeholder="Min" aria-label="Budget min">
                                    <input type="number" id="projectEditBudgetMax" class="form-input ov-field" step="0.01" placeholder="Max" aria-label="Budget max">
                                </div>
                            </div>
                            <div class="overview-detail-item">
                                <label class="detail-label" for="projectEditSuccessChance">Success Chance</label>
                                <span class="detail-value" id="projectOverviewSuccessChance" data-ov="view"></span>
                                <input type="number" id="projectEditSuccessChance" class="form-input ov-field" data-ov="edit" min="0" max="100" placeholder="0-100 %">
                            </div>
                            <div class="overview-detail-item">
                                <label class="detail-label" for="projectEditEstCompletion">Est. Completion</label>
                                <span class="detail-value" id="projectOverviewEstCompletion" data-ov="view"></span>
                                <input type="date" id="projectEditEstCompletion" class="form-input ov-field" data-ov="edit">
                            </div>
                            <div class="overview-detail-item full-width">
                                <label class="detail-label" for="projectEditDescription">Description</label>
                                <span class="detail-value" id="projectOverviewDescription" data-ov="view"></span>
                                <textarea id="projectEditDescription" class="form-input ov-field" data-ov="edit" rows="3" placeholder="What the project is about" required></textarea>
                            </div>
                        </div>
                    </div>

                    <!-- Tags Section -->
                    <div class="overview-section ov-section">
                        <div class="ov-section-head">
                            <h3 class="overview-section-title">Tags</h3>
                            <button type="button" class="ov-add-btn" id="addProjectTagBtn" aria-expanded="false" aria-controls="projectTagPicker">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                                Add
                            </button>
                        </div>
                        <div class="ov-picker tag-input-wrapper" id="projectTagPicker" hidden>
                            <input type="text" id="newProjectTagInput" class="form-input" placeholder="Find or create a tag…" autocomplete="off">
                            <div class="tag-suggestions" id="projectTagSuggestions"></div>
                        </div>
                        <div class="tags-container" id="projectTags">
                            <!-- Tags will be populated by JS -->
                        </div>
                    </div>

                    <!-- Assigned Contacts Section -->
                    <div class="overview-section ov-section">
                        <div class="ov-section-head">
                            <h3 class="overview-section-title">Assigned Contacts</h3>
                            <button type="button" class="ov-add-btn" id="addProjectContactBtn" aria-expanded="false" aria-controls="projectContactPicker">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                                Add
                            </button>
                        </div>
                        <div class="ov-picker tag-input-wrapper" id="projectContactPicker" hidden>
                            <input type="text" id="newProjectContactInput" class="form-input" placeholder="Search contacts…" autocomplete="off">
                            <div class="contact-suggestions" id="projectContactSuggestions"></div>
                        </div>
                        <div class="project-contacts-list" id="projectContacts">
                            <!-- Contacts will be populated by JS -->
                        </div>
                    </div>

                    <!-- Project To-Dos Section: open ones only, one line each
                         until opened. -->
                    <div class="overview-section ov-section">
                        <div class="ov-section-head">
                            <h3 class="overview-section-title">To-Dos</h3>
                            <button type="button" class="ov-add-btn" id="addProjectTodoBtn">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                                New
                            </button>
                        </div>
                        <div class="ptodo-list" id="projectTodosList">
                            <!-- Project to-dos will be populated by JS -->
                        </div>
                    </div>

                    <!-- Project Documents Section (assets/js/documents.js).
                         Dragging files over the sheet shows one drop target
                         per label, so a file is labelled as it is added. -->
                    <div class="overview-section ov-section" id="projectDocuments">
                        <h3 class="overview-section-title">
                            Documents
                            <span class="pdoc-count" id="projectDocumentsCount" hidden></span>
                        </h3>
                        <div class="pdoc-list" id="projectDocumentsList" aria-live="polite">
                            <!-- Documents will be populated by JS -->
                        </div>
                        <div class="pdoc-add" id="projectDocumentsAdd">
                            <!-- One button per label, rendered by JS -->
                        </div>
                        <input type="file" id="projectDocumentsInput" multiple hidden>
                    </div>

                    <!-- Project Notes Section -->
                    <div class="overview-section ov-section">
                        <div class="ov-section-head">
                            <h3 class="overview-section-title">Notes</h3>
                            <button type="button" class="ov-add-btn" id="openProjectNoteFormBtn" aria-expanded="false" aria-controls="projectNoteForm">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                                Add note
                            </button>
                        </div>
                        <div class="add-note-form ov-note-form" id="projectNoteForm" hidden>
                            <textarea id="newProjectNoteContent" class="form-input" placeholder="Write a note…" rows="3"></textarea>
                            <div class="ov-note-form-actions">
                                <button type="button" class="btn btn-secondary btn-small" id="cancelProjectNoteBtn">Cancel</button>
                                <button type="button" class="btn btn-primary btn-small" id="addProjectNoteBtn">Add Note</button>
                            </div>
                        </div>
                        <div class="notes-timeline" id="projectNotesTimeline">
                            <!-- Project notes will be populated by JS -->
                        </div>
                    </div>
                </div>
                <div class="modal-footer ov-footer">
                    <button type="button" class="btn btn-secondary ov-delete-btn" id="deleteProjectOverviewBtn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                        </svg>
                        Delete
                    </button>
                    <button type="button" class="btn btn-secondary" id="editProjectBtn" data-ov="view">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                        Edit
                    </button>
                    <button type="button" class="btn btn-secondary" id="cancelProjectEditBtn" data-ov="edit">Cancel</button>
                    <button type="button" class="btn btn-primary" id="saveProjectEditBtn" data-ov="edit">Save</button>
                </div>
            </div>
        </div>

        <!-- To-Do Detail Sheet: what a to-do is about - its facts, its
             description and its links (mostly Google Drive documents).
             Editing opens the to-do form on top of it. -->
        <div class="modal" id="todoDetailModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <div class="overview-header-info">
                        <div class="overview-title-info">
                            <h2 id="todoDetailTitle">To-Do</h2>
                            <p class="overview-company" id="todoDetailContext"></p>
                            <p class="overview-edited" id="todoDetailEdited"></p>
                        </div>
                    </div>
                    <button type="button" class="modal-close" id="closeTodoDetail">&times;</button>
                </div>
                <div class="modal-body overview-body">
                    <div id="todoDetailAssignee"></div>

                    <div class="overview-section">
                        <div class="overview-details">
                            <div class="overview-detail-item">
                                <span class="detail-label">Status</span>
                                <span class="detail-value" id="todoDetailStatus"></span>
                            </div>
                            <div class="overview-detail-item">
                                <span class="detail-label">Due</span>
                                <span class="detail-value" id="todoDetailDue"></span>
                            </div>
                            <div class="overview-detail-item">
                                <span class="detail-label">Priority</span>
                                <span class="detail-value" id="todoDetailPriority"></span>
                            </div>
                            <div class="overview-detail-item full-width">
                                <span class="detail-label">Description</span>
                                <span class="detail-value tdetail-description" id="todoDetailDescription"></span>
                            </div>
                        </div>
                    </div>

                    <div class="overview-section ov-section">
                        <div class="ov-section-head">
                            <h3 class="overview-section-title">Links</h3>
                            <button type="button" class="ov-add-btn" id="addTodoLinkBtn" aria-expanded="false" aria-controls="todoLinkForm">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                                Add
                            </button>
                        </div>
                        <form class="tlink-form" id="todoLinkForm" hidden novalidate>
                            <input type="url" id="todoLinkUrl" class="form-input" placeholder="Paste a Google Drive link…" autocomplete="off" aria-label="Link">
                            <input type="text" id="todoLinkTitle" class="form-input" placeholder="Name (optional)" maxlength="255" autocomplete="off" aria-label="Name">
                            <p class="tlink-form-hint">Leave the name empty and it is read from Google, where the document is shared by link.</p>
                            <div class="ov-note-form-actions">
                                <button type="button" class="btn btn-secondary btn-small" id="cancelTodoLinkBtn">Cancel</button>
                                <button type="submit" class="btn btn-primary btn-small" id="saveTodoLinkBtn">Add link</button>
                            </div>
                        </form>
                        <div class="tlink-list" id="todoLinksList"></div>
                    </div>
                </div>
                <div class="modal-footer ov-footer">
                    <button type="button" class="btn btn-secondary ov-delete-btn" id="deleteTodoDetailBtn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                        </svg>
                        Delete
                    </button>
                    <button type="button" class="btn btn-secondary" id="toggleTodoDetailDoneBtn">Mark as done</button>
                    <button type="button" class="btn btn-secondary" id="editTodoDetailBtn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                        Edit
                    </button>
                </div>
            </div>
        </div>

        <!-- To-Do Modal -->
        <div class="modal" id="todoModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content">
                <div class="modal-header">
                    <h2 id="todoModalTitle">New To-Do</h2>
                    <button type="button" class="modal-close" id="closeTodoModal">&times;</button>
                </div>
                <form id="todoForm">
                    <div class="modal-body">
                        <div class="form-section">
                            <div class="form-group">
                                <label for="todoTitle">Title *</label>
                                <input type="text" id="todoTitle" class="form-input" required maxlength="255" placeholder="Follow up with client">
                            </div>

                            <div class="form-group">
                                <label for="todoDescription">Description</label>
                                <textarea id="todoDescription" class="form-input" rows="3" placeholder="Optional details"></textarea>
                            </div>

                            <div class="form-group">
                                <label for="todoDueDate">Due Date</label>
                                <input type="date" id="todoDueDate" class="form-input">
                            </div>

                            <!-- On a new to-do the choice is applied right after
                                 it is created (saveTodo in app.js). -->
                            <div class="form-group" id="todoAssigneeGroup" hidden>
                                <label>Assigned to</label>
                                <div id="todoAssignee"></div>
                            </div>

                            <div class="form-group">
                                <label for="todoPriority">Priority</label>
                                <select id="todoPriority" class="form-select">
                                    <option value="">No priority</option>
                                    <option value="high">High</option>
                                    <option value="medium">Medium</option>
                                    <option value="low">Low</option>
                                </select>
                            </div>

                            <div class="todo-assignment-grid">
                                <div class="form-group">
                                    <label for="todoAssignType">Belongs to *</label>
                                    <select id="todoAssignType" class="form-select" required>
                                        <option value="contact">Contact</option>
                                        <option value="project">Project</option>
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label for="todoAssigneeId">Contact or project *</label>
                                    <select id="todoAssigneeId" class="form-select" required>
                                        <option value="">Select...</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <p class="overview-edited modal-footer-edited" id="todoEdited"></p>
                        <button type="button" class="btn btn-secondary" id="cancelTodoBtn">Cancel</button>
                        <button type="submit" class="btn btn-primary" id="saveTodoBtn">Create To-Do</button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Bookkeeping: CSV Import Modal -->
        <div class="modal" id="bkImportModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <h2>Import CSV</h2>
                    <button type="button" class="modal-close" id="bkImportCloseBtn">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="bk-import-meta">
                        <strong id="bkImportFileName"></strong>
                        <span id="bkImportRowCount"></span>
                    </div>

                    <!-- Step 1: choose columns and the date column -->
                    <div id="bkImportStepColumns">
                        <div class="bk-import-hint" id="bkImportHint">
                            Your previous column selection was restored. Columns not yet in the table will be added as new columns; existing data is never changed.
                        </div>
                        <div class="form-group">
                            <label>Columns to import</label>
                            <div class="bk-import-columns" id="bkImportColumns"></div>
                        </div>
                        <div class="form-group">
                            <label for="bkImportDateColumn">Date column (used for chronological order and month grouping)</label>
                            <select id="bkImportDateColumn" class="form-select"></select>
                        </div>
                    </div>

                    <!-- Step 2: preview which rows will be imported -->
                    <div id="bkImportStepPreview" style="display: none;">
                        <div class="bk-import-dup-warning" id="bkImportDupWarning" style="display: none;">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="flex-shrink:0;">
                                <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                            </svg>
                            <span id="bkImportDupWarningText">Possible duplicates found. Rows highlighted below look like they might already be in the table.</span>
                        </div>
                        <div class="form-group">
                            <label>Columns to import (click to include/exclude)</label>
                            <div class="bk-preview-columns" id="bkImportPreviewColumns"></div>
                        </div>
                        <div class="bk-import-preview-toolbar">
                            <label class="bk-import-preview-selectall">
                                <input type="checkbox" id="bkImportPreviewSelectAll" checked>
                                <span>Select all</span>
                            </label>
                            <span id="bkImportPreviewCount" class="text-muted"></span>
                        </div>
                        <div class="bk-import-preview-wrap" id="bkImportPreviewWrap"></div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="bkImportBackBtn" style="display: none;">Back</button>
                    <button type="button" class="btn btn-secondary" id="bkImportCancelBtn">Cancel</button>
                    <button type="button" class="btn btn-primary" id="bkImportConfirmBtn">Preview</button>
                </div>
            </div>
        </div>

        <!-- Bookkeeping: PDF Upload Modal -->
        <div class="modal" id="bkPdfModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Assign PDF to Row</h2>
                    <button type="button" class="modal-close" id="bkPdfCloseBtn">&times;</button>
                </div>
                <div class="modal-body">
                    <p>You are assigning a PDF to <strong>this row</strong>:</p>
                    <div id="bkPdfRowSummary"></div>
                    <div class="bk-pdf-warning" id="bkPdfWarning" style="display: none;">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="flex-shrink:0;">
                            <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                        </svg>
                        <span id="bkPdfWarningText"></span>
                    </div>
                    <div class="bk-pdf-upload-controls" id="bkPdfUploadControls">
                        <input type="file" id="bkPdfFileInput" accept=".pdf,application/pdf" hidden>
                        <button type="button" class="btn btn-secondary" id="bkPdfBrowseBtn">Choose PDF...</button>
                        <span class="bk-pdf-file-name" id="bkPdfFileName"></span>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="bkPdfCancelBtn">Cancel</button>
                    <button type="button" class="btn btn-primary" id="bkPdfUploadBtn" disabled>Upload &amp; Assign</button>
                </div>
            </div>
        </div>

        <!-- Bookkeeping: PDF Preview Modal -->
        <div class="modal" id="bkPdfPreviewModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content bk-pdf-preview-content">
                <div class="modal-header">
                    <h2 id="bkPdfPreviewTitle">PDF</h2>
                    <button type="button" class="modal-close" id="bkPdfPreviewCloseBtn">&times;</button>
                </div>
                <div class="modal-body bk-pdf-preview-body">
                    <!-- Pages drawn by PDF.js; the iframe is only the fallback if PDF.js cannot load -->
                    <div id="bkPdfPreviewPages" class="bk-pdf-preview-pages" aria-label="PDF preview"></div>
                    <iframe id="bkPdfPreviewFrame" class="bk-pdf-preview-frame" title="PDF preview" hidden></iframe>
                </div>
                <div class="modal-footer">
                    <a href="#" class="btn btn-secondary" id="bkPdfPreviewOpenBtn" target="_blank" rel="noopener">Open in new tab</a>
                    <button type="button" class="btn btn-primary" id="bkPdfPreviewDoneBtn">Close</button>
                </div>
            </div>
        </div>

        <!-- Bookkeeping: Confirm Modal -->
        <div class="modal" id="bkConfirmModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-small">
                <div class="modal-header">
                    <h2 id="bkConfirmTitle">Confirm</h2>
                    <button type="button" class="modal-close" id="bkConfirmCloseBtn">&times;</button>
                </div>
                <div class="modal-body">
                    <div id="bkConfirmMessage"></div>
                </div>
                <div class="modal-footer" id="bkConfirmActions"></div>
            </div>
        </div>

        <?php if ($isAdmin): ?>
        <!-- User Management (admin only) -->
        <div class="modal" id="usersModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <div class="overview-header-info">
                        <div class="import-export-icon">
                            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                            </svg>
                        </div>
                        <div class="overview-title-info">
                            <h2>Users</h2>
                            <p class="overview-company">Invite people and manage what they can do</p>
                        </div>
                    </div>
                    <button type="button" class="modal-close" id="closeUsersModal">&times;</button>
                </div>

                <div class="modal-body">
                    <!-- Invite -->
                    <div class="users-invite">
                        <form class="users-invite-form" id="inviteUserForm" autocomplete="off">
                            <div class="users-invite-fields">
                                <input type="text" id="inviteName" class="form-input" placeholder="Name" maxlength="120" required>
                                <input type="email" id="inviteEmail" class="form-input" placeholder="Email" maxlength="255" required>
                                <select id="inviteRole" class="form-select">
                                    <option value="member">Member</option>
                                    <option value="admin">Admin</option>
                                </select>
                                <button type="submit" class="btn btn-primary" id="inviteSubmitBtn">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                        <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                                    </svg>
                                    Invite
                                </button>
                            </div>
                            <p class="users-invite-hint">
                                They receive an email with a link to choose their own password &mdash;
                                you never see or set it.
                            </p>
                        </form>
                    </div>

                    <!-- The generated link, shown after an invite or a resend -->
                    <div class="users-link-box" id="usersLinkBox" hidden>
                        <div class="users-link-head">
                            <span class="users-link-title" id="usersLinkTitle">Invite link</span>
                            <button type="button" class="users-link-dismiss" id="usersLinkDismiss" title="Dismiss">&times;</button>
                        </div>
                        <p class="users-link-note" id="usersLinkNote"></p>
                        <div class="users-link-row">
                            <input type="text" class="form-input" id="usersLinkInput" readonly>
                            <button type="button" class="btn btn-secondary" id="usersLinkCopy">Copy</button>
                        </div>
                    </div>

                    <!-- Account list -->
                    <div class="users-list" id="usersList"></div>
                </div>
            </div>
        </div>
        <?php endif; ?>

        <!-- Bookkeeping: Toast -->
        <div class="bk-toast" id="bkToast"></div>

        <!-- CSRF Token for AJAX requests -->
        <meta name="csrf-token" content="<?= htmlspecialchars(Auth::getCsrfToken()) ?>">
        <meta name="current-user" content="<?= htmlspecialchars($currentUser['name'] ?? '', ENT_QUOTES, 'UTF-8') ?>">
        <meta name="current-user-id" content="<?= htmlspecialchars((string) ($currentUser['id'] ?? ''), ENT_QUOTES, 'UTF-8') ?>">
        <meta name="current-user-role" content="<?= $isAdmin ? 'admin' : 'member' ?>">
        <meta name="claude-actor-name" content="<?= htmlspecialchars(MCP_ACTOR_NAME, ENT_QUOTES, 'UTF-8') ?>">

        <!-- Leaflet JS -->
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>

        <!-- Leaflet MarkerCluster JS -->
        <script src="https://unpkg.com/leaflet.markercluster@1.4.1/dist/leaflet.markercluster.js" integrity="sha384-RLIyj5q1b5XJTn0tqUhucRZe40nFTocRP91R/NkRJHwAe4XxnTV77FXy/vGLiec2" crossorigin="anonymous"></script>

        <!-- Application JS -->
        <script src="<?= assetUrl('assets/js/charts.js') ?>"></script>
        <script src="<?= assetUrl('assets/js/review.js') ?>"></script>
        <script src="<?= assetUrl('assets/js/todo-links.js') ?>"></script>
        <script src="<?= assetUrl('assets/js/app.js') ?>"></script>
        <script src="<?= assetUrl('assets/js/bookkeeping.js') ?>"></script>
        <script src="<?= assetUrl('assets/js/documents.js') ?>"></script>
        <script src="<?= assetUrl('assets/js/profile.js') ?>"></script>
        <script src="<?= assetUrl('assets/js/home-dashboard.js') ?>"></script>
        <script src="<?= assetUrl('assets/js/workload.js') ?>"></script>
        <?php if ($isAdmin): ?>
        <script src="<?= assetUrl('assets/js/users.js') ?>"></script>
        <?php endif; ?>
    <?php endif; ?>
</body>
</html>
