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
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars(APP_NAME) ?></title>

    <!-- Inter Font -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

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
            } catch (e) {
                // Ignore storage errors and keep default theme
            }
        })();
    </script>

    <!-- Application CSS -->
    <link rel="stylesheet" href="assets/css/style.css">
    <link rel="stylesheet" href="assets/css/bookkeeping.css">
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
                            <span class="login-alt-sep">&middot;</span>
                            <span class="login-hint-inline">Owner: leave email empty</span>
                        </p>
                    <?php endif; ?>
                </div>
            </div>
        <?php endif; ?>

    <?php else: ?>
        <!-- Main Application -->
        <div class="app-container">
            <!-- Header -->
            <header class="app-header">
                <div class="header-left">
                    <h1 class="app-title"><?= htmlspecialchars(APP_NAME) ?></h1>
                    <span class="contact-count"><?= $contactCount ?> contact<?= $contactCount !== 1 ? 's' : '' ?></span>
                </div>
                <div class="header-center">
                    <!-- View Toggle -->
                    <div class="view-toggle">
                        <button type="button" class="toggle-btn active" data-view="workload" title="My Work">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
                            </svg>
                            <span class="toggle-badge" id="workloadBadge" hidden>0</span>
                        </button>
                        <button type="button" class="toggle-btn" data-view="projects" title="Projects">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/>
                            </svg>
                        </button>
                        <button type="button" class="toggle-btn" data-view="todos" title="To-Dos">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
                            </svg>
                        </button>
                        <button type="button" class="toggle-btn" data-view="list" title="Contacts">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M20 0H4v2h16V0zM4 24h16v-2H4v2zM20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 2.75c1.24 0 2.25 1.01 2.25 2.25s-1.01 2.25-2.25 2.25S9.75 10.24 9.75 9 10.76 6.75 12 6.75zM17 17H7v-1.5c0-1.67 3.33-2.5 5-2.5s5 .83 5 2.5V17z"/>
                            </svg>
                        </button>
                        <button type="button" class="toggle-btn" data-view="calendar" title="Kalender">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/>
                            </svg>
                        </button>
                        <button type="button" class="toggle-btn" data-view="bookkeeping" title="Bookkeeping">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M4 3h13l3 3v15H4V3zm2 2v14h12V7.83L16.17 5H6zm2 3h8v2H8V8zm0 4h8v2H8v-2zm0 4h5v2H8v-2z"/>
                            </svg>
                        </button>
                        <button type="button" class="toggle-btn" data-view="map" title="Map">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/>
                            </svg>
                        </button>
                    </div>
                </div>
                <div class="header-right">
                    <div class="user-chip-wrap">
                        <button type="button" class="user-chip" id="userChip"
                                title="<?= htmlspecialchars(($currentUser['email'] ?? 'Owner login') . ' - ' . ($isAdmin ? 'Administrator' : 'Member')) ?>"
                                aria-haspopup="dialog" aria-expanded="false">
                            <span class="user-chip-avatar" id="userChipAvatar"><?= htmlspecialchars(userInitials($currentUser['name'] ?? '')) ?></span>
                            <span class="user-chip-name"><?= htmlspecialchars($currentUser['name'] ?? '') ?></span>
                            <?php if ($isAdmin): ?><span class="user-chip-role">Admin</span><?php endif; ?>
                        </button>

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
                                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                                        <path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/>
                                    </svg>
                                    <span id="profilePhotoBtnLabel">Upload photo</span>
                                </button>
                                <button type="button" class="btn btn-secondary btn-small btn-block profile-pop-remove" id="profileRemoveBtn" hidden>Remove photo</button>
                            </div>
                            <p class="profile-pop-hint">JPEG, PNG, GIF or WebP &middot; up to 5 MB</p>
                            <input type="file" id="profilePhotoInput" accept="image/jpeg,image/png,image/gif,image/webp" hidden>
                        </div>
                    </div>
                    <?php if ($isAdmin): ?>
                    <button type="button" class="btn btn-secondary" id="manageUsersBtn" title="Manage users">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                        </svg>
                        <span class="header-btn-label">Users</span>
                    </button>
                    <?php endif; ?>
                    <button type="button" class="btn btn-secondary theme-toggle-btn" id="themeToggleBtn" aria-label="Switch to light mode" title="Switch to light mode">
                        <svg class="theme-toggle-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.8zM1 13h3v-2H1zm10 9h2v-3h-2zm7.04-2.05l1.41-1.41-1.79-1.8-1.41 1.42zM20 13h3v-2h-3zM17.24 4.84l1.79-1.79-1.41-1.41-1.8 1.79zM12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM4.22 19.78l1.41 1.41 1.8-1.79-1.42-1.41zM11 1h2v3h-2z"/>
                        </svg>
                        <span class="theme-toggle-label">Light Mode</span>
                    </button>
                    <a href="index.php?action=logout" class="btn btn-secondary header-logout-btn">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
                        </svg>
                        <span>Logout</span>
                    </a>
                </div>
            </header>

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
                                    <h2 class="workload-title" id="workloadTitle">My Work</h2>
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

                <!-- Map View -->
                <div class="view-panel" id="mapView">
                    <div id="map"></div>
                </div>

                <!-- Calendar View -->
                <div class="view-panel" id="calendarView">
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
                <div class="view-panel" id="bookkeepingView">
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
                </div>

                <!-- To-Do View -->
                <div class="view-panel" id="todoView">
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
                            <select id="todoContactFilter" class="form-select">
                                <option value="">All People</option>
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
                    <!-- Dashboard -->
                    <div class="dashboard-wrapper collapsed" id="dashboardWrapper">
                        <!-- Collapsed bar (always visible) -->
                        <div class="dashboard-bar" id="dashboardBar">
                            <div class="dashboard-mobile-label">Project Dashboard</div>
                            <div class="dashboard-bar-stats" id="dashboardBarStats">
                                <div class="dashboard-bar-stat">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg>
                                    <span class="dashboard-bar-stat-value" id="dashBarProjects">—</span>
                                    <span>Projects</span>
                                </div>
                                <div class="dashboard-bar-stat">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M15 18.5c-2.51 0-4.68-1.42-5.76-3.5H15v-2H8.58c-.05-.33-.08-.66-.08-1s.03-.67.08-1H15V9H9.24C10.32 6.92 12.5 5.5 15 5.5c1.61 0 3.09.59 4.23 1.57L21 5.3C19.41 3.87 17.3 3 15 3c-3.92 0-7.24 2.51-8.48 6H3v2h3.06c-.04.33-.06.66-.06 1s.02.67.06 1H3v2h3.52c1.24 3.49 4.56 6 8.48 6 2.31 0 4.41-.87 6-2.3l-1.78-1.77c-1.13.98-2.6 1.57-4.22 1.57z"/></svg>
                                    <span class="dashboard-bar-stat-value" id="dashBarPotential">—</span>
                                </div>
                                <div class="dashboard-bar-stat">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/></svg>
                                    <span class="dashboard-bar-stat-value" id="dashBarChance">—</span>
                                    <span>Avg. Chance</span>
                                </div>
                                <div class="dashboard-bar-stat">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/></svg>
                                    <span class="dashboard-bar-stat-value" id="dashBarProjection">—</span>
                                    <span>Projected</span>
                                </div>
                            </div>
                            <button class="dashboard-toggle-btn" id="dashboardToggleBtn" title="Toggle dashboard">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                                </svg>
                            </button>
                        </div>
                        <!-- Expanded card grid -->
                        <div class="projects-dashboard" id="projectsDashboard">
                            <div class="dashboard-card">
                                <div class="dashboard-card-icon">
                                    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                                        <path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/>
                                    </svg>
                                </div>
                                <div class="dashboard-card-body">
                                    <div class="dashboard-card-value" id="dashTotalProjects">—</div>
                                    <div class="dashboard-card-label">Total Projects</div>
                                </div>
                            </div>
                            <div class="dashboard-card">
                                <div class="dashboard-card-icon">
                                    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                                        <path d="M15 18.5c-2.51 0-4.68-1.42-5.76-3.5H15v-2H8.58c-.05-.33-.08-.66-.08-1s.03-.67.08-1H15V9H9.24C10.32 6.92 12.5 5.5 15 5.5c1.61 0 3.09.59 4.23 1.57L21 5.3C19.41 3.87 17.3 3 15 3c-3.92 0-7.24 2.51-8.48 6H3v2h3.06c-.04.33-.06.66-.06 1s.02.67.06 1H3v2h3.52c1.24 3.49 4.56 6 8.48 6 2.31 0 4.41-.87 6-2.3l-1.78-1.77c-1.13.98-2.6 1.57-4.22 1.57z"/>
                                    </svg>
                                </div>
                                <div class="dashboard-card-body">
                                    <div class="dashboard-card-value" id="dashTotalPotential">—</div>
                                    <div class="dashboard-card-label">Total Potential</div>
                                    <div class="dashboard-card-sub" id="dashPotentialSub"></div>
                                </div>
                            </div>
                            <div class="dashboard-card">
                                <div class="dashboard-card-icon">
                                    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/>
                                    </svg>
                                </div>
                                <div class="dashboard-card-body">
                                    <div class="dashboard-card-value" id="dashSuccessChance">—</div>
                                    <div class="dashboard-card-label">Avg. Success Chance</div>
                                </div>
                            </div>
                            <!-- Revenue Projection — spans full width -->
                            <div class="dashboard-card dashboard-card--projection">
                                <div class="dashboard-card-icon dashboard-card-icon--success">
                                    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                                        <path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/>
                                    </svg>
                                </div>
                                <div class="dashboard-card-body">
                                    <div class="dashboard-card-label">Revenue Projection</div>
                                    <div class="dashboard-proj-scenarios">
                                        <div class="dashboard-proj-scenario">
                                            <span class="dashboard-proj-scenario-label">Conservative</span>
                                            <span class="dashboard-card-value" id="dashProjConservative">—</span>
                                        </div>
                                        <div class="dashboard-proj-scenario dashboard-proj-scenario--main">
                                            <span class="dashboard-proj-scenario-label">Realistic</span>
                                            <span class="dashboard-card-value" id="dashProjRealistic">—</span>
                                        </div>
                                        <div class="dashboard-proj-scenario">
                                            <span class="dashboard-proj-scenario-label">Optimistic</span>
                                            <span class="dashboard-card-value" id="dashProjOptimistic">—</span>
                                        </div>
                                    </div>
                                    <div class="dashboard-card-sub" id="dashProjSub">
                                        Stage-aware probability bands - timeline-adjusted - open projects only
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

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
                </div>
            </main>
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

                        <!-- Excel Format Instructions -->
                        <div class="import-instructions">
                            <h4>Excel File Format</h4>
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
                        </div>

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

        <!-- Project Modal -->
        <div class="modal" id="projectModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content">
                <div class="modal-header">
                    <h2 id="projectModalTitle">Add Project</h2>
                    <button type="button" class="modal-close" id="closeProjectModal">&times;</button>
                </div>
                <form id="projectForm">
                    <input type="hidden" id="projectId" name="id">

                    <div class="modal-body">
                        <!-- Required Fields -->
                        <div class="form-section">
                            <h3>Basic Information</h3>

                            <div class="form-group">
                                <label for="projectName">Project Name *</label>
                                <input type="text" id="projectName" name="name" required class="form-input">
                            </div>

                            <div class="form-group">
                                <label for="projectStartDate">Start Date *</label>
                                <input type="date" id="projectStartDate" name="start_date" required class="form-input">
                            </div>

                            <div class="form-group">
                                <label for="projectDescription">Description *</label>
                                <textarea id="projectDescription" name="description" required class="form-input" rows="3"></textarea>
                            </div>
                        </div>

                        <!-- Optional Fields -->
                        <div class="form-section">
                            <h3>Additional Details</h3>

                            <div class="form-group">
                                <label for="projectCompany">Company</label>
                                <div class="autocomplete-wrapper">
                                    <input type="text" id="projectCompany" name="company" class="form-input" autocomplete="off" placeholder="Search or enter company name...">
                                    <div class="autocomplete-suggestions" id="projectCompanySuggestions"></div>
                                </div>
                            </div>

                            <div class="form-row">
                                <div class="form-group">
                                    <label for="projectBudgetMin">Budget Min</label>
                                    <input type="number" id="projectBudgetMin" name="budget_min" class="form-input" step="0.01" placeholder="0.00">
                                </div>
                                <div class="form-group">
                                    <label for="projectBudgetMax">Budget Max</label>
                                    <input type="number" id="projectBudgetMax" name="budget_max" class="form-input" step="0.01" placeholder="0.00">
                                </div>
                            </div>

                            <div class="form-group">
                                <label for="projectSuccessChance">Success Chance (%)</label>
                                <input type="number" id="projectSuccessChance" name="success_chance" class="form-input" min="0" max="100" placeholder="0-100">
                            </div>

                            <div class="form-group">
                                <label for="projectStage">Stage</label>
                                <select id="projectStage" name="stage" class="form-select">
                                    <option value="Lead">Lead</option>
                                    <option value="Proposal">Proposal</option>
                                    <option value="Negotiation">Negotiation</option>
                                    <option value="In Progress">In Progress</option>
                                    <option value="Complete">Complete</option>
                                </select>
                            </div>

                            <div class="form-group">
                                <label for="projectEstimatedCompletion">Estimated Completion</label>
                                <input type="date" id="projectEstimatedCompletion" name="estimated_completion" class="form-input">
                            </div>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" id="cancelProjectBtn">Cancel</button>
                        <button type="button" class="btn btn-danger" id="deleteProjectBtn" style="display: none;">Delete</button>
                        <button type="submit" class="btn btn-primary" id="saveProjectBtn">Save Project</button>
                    </div>
                </form>
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
                    <p>Are you sure you want to delete <strong id="deleteProjectName"></strong>?</p>
                    <p class="text-muted">This action cannot be undone.</p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="cancelDeleteProjectBtn">Cancel</button>
                    <button type="button" class="btn btn-danger" id="confirmDeleteProjectBtn">Delete</button>
                </div>
            </div>
        </div>

        <!-- Project Overview Modal -->
        <div class="modal" id="projectOverviewModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <div class="overview-header-info">
                        <div class="overview-title-info">
                            <h2 id="projectOverviewName">Project Name</h2>
                            <p class="overview-company" id="projectOverviewCompany"></p>
                            <p class="overview-edited" id="projectOverviewEdited"></p>
                        </div>
                    </div>
                    <button type="button" class="modal-close" id="closeProjectOverviewModal">&times;</button>
                </div>
                <div class="modal-body overview-body">
                    <!-- Who is responsible for this project -->
                    <div id="projectOverviewAssignee"></div>

                    <!-- Project Details Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Project Information</h3>
                        <div class="overview-details">
                            <div class="overview-detail-item">
                                <span class="detail-label">Start Date</span>
                                <span class="detail-value" id="projectOverviewStartDate"></span>
                            </div>
                            <div class="overview-detail-item">
                                <span class="detail-label">Stage</span>
                                <span class="detail-value" id="projectOverviewStage"></span>
                            </div>
                            <div class="overview-detail-item">
                                <span class="detail-label">Budget</span>
                                <span class="detail-value" id="projectOverviewBudget"></span>
                            </div>
                            <div class="overview-detail-item">
                                <span class="detail-label">Success Chance</span>
                                <span class="detail-value" id="projectOverviewSuccessChance"></span>
                            </div>
                            <div class="overview-detail-item">
                                <span class="detail-label">Est. Completion</span>
                                <span class="detail-value" id="projectOverviewEstCompletion"></span>
                            </div>
                            <div class="overview-detail-item full-width">
                                <span class="detail-label">Description</span>
                                <span class="detail-value" id="projectOverviewDescription"></span>
                            </div>
                        </div>
                    </div>

                    <!-- Tags Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Tags</h3>
                        <div class="tags-container" id="projectTags">
                            <!-- Tags will be populated by JS -->
                        </div>
                        <div class="add-tag-form">
                            <div class="tag-input-wrapper">
                                <input type="text" id="newProjectTagInput" class="form-input" placeholder="Add or create tag..." autocomplete="off">
                                <div class="tag-suggestions" id="projectTagSuggestions"></div>
                            </div>
                            <button type="button" class="btn btn-secondary" id="addProjectTagBtn">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                </svg>
                                Add
                            </button>
                        </div>
                    </div>

                    <!-- Assigned Contacts Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Assigned Contacts</h3>
                        <div class="project-contacts-list" id="projectContacts">
                            <!-- Contacts will be populated by JS -->
                        </div>
                        <div class="add-tag-form">
                            <div class="tag-input-wrapper">
                                <input type="text" id="newProjectContactInput" class="form-input" placeholder="Assign contact..." autocomplete="off">
                                <div class="contact-suggestions" id="projectContactSuggestions"></div>
                            </div>
                            <button type="button" class="btn btn-secondary" id="addProjectContactBtn">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                </svg>
                                Add
                            </button>
                        </div>
                    </div>

                    <!-- Project To-Dos Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Project To-Dos</h3>
                        <div class="todo-list" id="projectTodosList">
                            <!-- Project to-dos will be populated by JS -->
                        </div>
                        <div class="add-note-form">
                            <button type="button" class="btn btn-secondary" id="addProjectTodoBtn">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                </svg>
                                New To-Do
                            </button>
                        </div>
                    </div>

                    <!-- Project Notes Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Project Notes</h3>
                        <div class="notes-timeline" id="projectNotesTimeline">
                            <!-- Project notes will be populated by JS -->
                        </div>
                        <div class="add-note-form">
                            <textarea id="newProjectNoteContent" class="form-input" placeholder="Add a note..." rows="3"></textarea>
                            <button type="button" class="btn btn-primary" id="addProjectNoteBtn">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                                </svg>
                                Add Note
                            </button>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="closeProjectOverviewBtn">Close</button>
                    <button type="button" class="btn btn-danger" id="deleteProjectOverviewBtn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                        </svg>
                        Delete
                    </button>
                    <button type="button" class="btn btn-secondary" id="editProjectBtn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                        Edit Project
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

                            <!-- Only rendered once the to-do exists, since an
                                 assignment needs a record to attach to. -->
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
                                    <label for="todoAssignType">Assign To *</label>
                                    <select id="todoAssignType" class="form-select" required>
                                        <option value="contact">Contact</option>
                                        <option value="project">Project</option>
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label for="todoAssigneeId">Assignee *</label>
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
                    <iframe id="bkPdfPreviewFrame" class="bk-pdf-preview-frame" title="PDF preview"></iframe>
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

        <!-- Leaflet JS -->
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>

        <!-- Leaflet MarkerCluster JS -->
        <script src="https://unpkg.com/leaflet.markercluster@1.4.1/dist/leaflet.markercluster.js" integrity="sha384-RLIyj5q1b5XJTn0tqUhucRZe40nFTocRP91R/NkRJHwAe4XxnTV77FXy/vGLiec2" crossorigin="anonymous"></script>

        <!-- Application JS -->
        <script src="assets/js/app.js"></script>
        <script src="assets/js/bookkeeping.js"></script>
        <script src="assets/js/profile.js"></script>
        <script src="assets/js/workload.js"></script>
        <?php if ($isAdmin): ?>
        <script src="assets/js/users.js"></script>
        <?php endif; ?>
    <?php endif; ?>
</body>
</html>
