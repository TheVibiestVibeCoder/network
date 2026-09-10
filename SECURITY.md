# Security notes

This app is a single-password CRM that holds contacts, project notes and
scanned invoices. It is designed to sit on a public domain, so everything below
is part of "working correctly", not optional polish.

## Deployment checklist

1. **Set a real password.** Copy `.env.example` to `.env` and set `APP_PASSWORD`.
   Prefer a hash over a plain value:

   ```
   php -r "echo password_hash('your-strong-password', PASSWORD_DEFAULT), PHP_EOL;"
   ```

   The app refuses to start while `APP_PASSWORD` is empty or a placeholder such
   as `changeme`.

2. **Serve only over HTTPS.** The password is sent in a form POST; without TLS
   it travels in the clear. The bundled `.htaccess` redirects HTTP to HTTPS and
   sends HSTS once TLS is active.

3. **Confirm the sensitive paths are not reachable.** After deploying, request
   each of these and confirm you get 403 or 404 - never file content:

   ```
   https://your-domain/.env
   https://your-domain/data/crm.db
   https://your-domain/data/bookkeeping_pdfs/
   https://your-domain/config/config.php
   https://your-domain/includes/auth.php
   https://your-domain/.git/config
   https://your-domain/composer.lock
   ```

   `.env` and `data/crm.db` are the two that matter most: the first is the
   password, the second is every contact, note and bookkeeping row.

4. **Make sure `.git` is not deployed at all.** Deploy an export
   (`git archive`), or keep the checkout outside the web root. A readable
   `.git` directory hands out the full source and history.

5. **Check the error log after the first real use.** Errors are logged, never
   displayed, so a broken deployment fails quietly by design.

## Users and roles

There are two kinds of identity:

- **Owner** - the `APP_PASSWORD` in `.env`. No database row, always an
  administrator, cannot be deleted or demoted. Sign in by leaving the email
  field empty. This is the recovery path: whatever happens to the users table,
  the owner still gets in.
- **Users** - rows in the `users` table, signing in with email + password.
  Either `admin` (full access plus user management) or `member` (full CRM
  access, no user management).

Passwords are never set by an administrator. Inviting someone creates a
one-time link; they choose their own password through it. Only the SHA-256 of
that token is stored, so a leaked database yields no working links.

What takes effect immediately, on the target's very next request:

| Action | Effect |
|---|---|
| Change a role | New permissions apply without re-login |
| Disable an account | Existing sessions die, sign-in refused |
| Delete an account | Sessions die; their tokens are removed |
| Change a password | Every other session for that account dies |

Deleting a user never deletes their work. Each record carries both the actor's
id and a snapshot of their name, so the history stays readable after the
account is gone.

Guards worth knowing about:

- An admin cannot change their own role, disable themselves, or delete
  themselves - each would strand them mid-action.
- The sign-in form answers identically for an unknown address, a disabled
  account and a wrong password, and spends the same time on each, so it cannot
  be used to discover who has an account.
- Sign-ins are throttled per IP **and** per identity, so neither a single IP
  spreading attempts across accounts nor many IPs grinding one account slips
  under the limit.
- Password-reset requests are throttled per email (3/hour) and per IP (10/hour).

If mail cannot be sent, nothing breaks: the Users panel always shows the
generated link so an admin can pass it on by hand.

## What protects what

| Layer | File | Protects against |
|---|---|---|
| Web server deny rules | `.htaccess`, `*/.htaccess` | Direct download of `.env`, the SQLite DB, uploaded PDFs, PHP includes, `.git` |
| PHP direct-access guard | top of `config/config.php`, `includes/*.php` | The same, on nginx, which ignores `.htaccess` |
| Session auth | `includes/auth.php` | Unauthenticated API access (every endpoint checks first) |
| CSRF tokens | `Auth::validateCsrfToken()` | Cross-site state changes; required on POST/PUT/PATCH/DELETE |
| Login lockout | `login_attempts` table | Password brute force (per IP) |
| CSP + output escaping | `Auth::sendSecurityHeaders()`, `escapeHtml()` | Stored XSS from contact/company/tag/file names |
| Upload validation | `api/bookkeeping.php`, `api/import-export.php` | Web shells uploaded as invoices or spreadsheets |
| Image re-encoding | `api/profile.php` | Polyglot files, EXIF leakage and decompression bombs in profile pictures |
| Role gate | `Auth::requireAdmin()` | Non-admins reaching `api/users.php` |
| Hashed one-time tokens | `includes/User.php` | Invite/reset links being reused, or usable from a database leak |
| Session-to-account binding | `Auth::sessionAccountStillValid()` | A disabled, deleted or password-changed account keeping a live session |

## Profile pictures

An uploaded picture is never stored as it arrived. It is decoded, re-drawn onto
a fresh 256x256 canvas and written back out as PNG, so what lands on disk is
pixels this server drew - EXIF, trailing payloads and polyglot files do not
survive the round trip. Before decoding, the declared MIME type, the real image
header and the pixel count all have to agree.

Files live in `data/avatars/` under a generated name, denied to the web server,
and are served only through `api/profile.php` after a session check.

The upload endpoint takes no "whose picture" parameter: the target is always the
caller's own identity, so it cannot be aimed at another account.

Profile pictures need the PHP **GD** extension. Without it the upload returns a
clear message and everything else keeps working - people just keep their
initials.

## nginx

nginx does **not** read `.htaccess`. The PHP-level guards still hold, but you
must add the deny rules to your server block yourself:

```nginx
server {
    # ... your existing listen / server_name / TLS config ...

    root /var/www/crm;
    index index.php;

    # Never serve dotfiles - .env, .git, .user.ini, .htaccess
    location ~ /\. {
        deny all;
        return 404;
    }

    # Never serve the database, uploaded invoices, includes, config or vendor
    location ~ ^/(data|includes|config|vendor)/ {
        deny all;
        return 404;
    }

    # Never serve dependency manifests or notes
    location ~ ^/(composer\.(json|lock)|README\.md|SECURITY\.md)$ {
        deny all;
        return 404;
    }

    # Only ever execute real .php files
    location ~ \.php$ {
        try_files $uri =404;
        fastcgi_split_path_info ^(.+\.php)(/.+)$;
        fastcgi_pass  unix:/run/php/php-fpm.sock;
        fastcgi_index index.php;
        include       fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
}
```

`try_files $uri =404;` in the PHP location is important: without it, nginx can
be tricked into executing an uploaded file that is not a `.php` script.

The `^/(data|includes|config|vendor)/` rule already covers the invoice store and
`data/avatars/`, so uploaded files stay reachable only through their endpoints.

## Known trade-offs

- **Every member sees all CRM data.** Roles gate user *management*, not records.
  There is no per-record ownership or sharing model; anyone signed in can read
  and edit every contact, project and invoice. Attribution records who changed
  what, but it does not restrict anyone.
- **The owner password is shared by definition.** Anyone who knows it is an
  administrator, and there is no audit trail distinguishing two people using
  it. Give people their own accounts and keep the owner password for recovery.
- **Mail delivery is best-effort.** `mail()` on shared hosting frequently fails
  or lands in spam. Set `MAIL_FROM` to an address on a domain the server may
  send for, and expect to fall back to copying links by hand.
- **`TRUST_PROXY_HEADERS` defaults to false.** Turn it on *only* behind a proxy
  you control. If it is on without such a proxy, a client can spoof
  `X-Forwarded-For` and sidestep the login lockout entirely.
- **Login lockout is per IP.** It stops a single-source brute force, not a
  distributed one. A long, random `APP_PASSWORD` is what actually protects you.
- **`style-src` keeps `'unsafe-inline'`.** The UI sets inline styles for tag
  colours and map layout. Inline CSS is not a script execution primitive, and
  tag colours are validated as hex server-side.

## Reporting

This is a private tool; there is no bounty process. If something looks wrong,
check the error log first, then the deny rules in step 3 above.
