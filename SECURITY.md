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

## Known trade-offs

- **Single shared password, no user accounts.** Everyone with the password has
  full access, and there is no per-user audit trail. Rotating the password is
  the only revocation mechanism.
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
