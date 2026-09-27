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
   https://your-domain/error_log
   https://your-domain/api/error_log
   ```

   `.env` and `data/crm.db` are the two that matter most: the first is the
   password, the second is every contact, note and bookkeeping row.

4. **Make sure `.git` is not deployed at all.** Deploy an export
   (`git archive`), or keep the checkout outside the web root. A readable
   `.git` directory hands out the full source and history.

5. **Check the error log after the first real use.** Errors are logged, never
   displayed, so a broken deployment fails quietly by design. With a private
   folder (below) the log is `crm-private/logs/php-error.log`; otherwise it is
   wherever the host puts it - on cPanel usually an `error_log` file next to
   the failing script, which `.htaccess` denies.

6. **Keep `.env` and the data outside the web root.** Recommended wherever the
   host allows it - see the next section.

## Keeping `.env` and the data outside the web root

The deny rules only protect what the web server honours them for. The stronger
setup keeps secrets and data in a folder the web server has no URL for at all:

```
/home/you/
├── crm-private/          <- not reachable from the web
│   ├── .env
│   ├── data/             <- crm.db, bookkeeping_pdfs/, avatars/
│   └── logs/             <- php-error.log, created automatically
└── your-web-root/        <- the app
```

- The folder must be called `crm-private` and sit **directly next to** the web
  root. Make sure that place is not itself inside another site's web root:
  with a layout like `public_html/crm`, the sibling would be
  `public_html/crm-private`, which the main domain serves.
- It only takes effect once `crm-private/.env` exists. Until then `.env` and
  `data/` are read from the web root as before, so moving `.env` is the switch.
- If `crm-private/.env` exists but `crm-private/data/crm.db` does not, the app
  refuses to start instead of silently creating an empty database. For a fresh
  install in the private folder, create an empty `data/crm.db` file first.
- PHP must be allowed to read and write there. On hosts with `open_basedir`,
  the folder has to be inside the allowed paths.

Moving an existing install:

1. Make sure nobody saves anything, and back up `data/` and `.env`.
2. Copy the whole `data/` folder into `crm-private/`.
3. Move `.env` into `crm-private/`.
4. Test (sign in, open an invoice PDF, create and delete a contact). If
   anything is wrong, move `.env` back - the old data is still in place.
5. Delete `crm.db*`, `bookkeeping_pdfs/` and `avatars/` from the web root's
   `data/`. Keep its `.htaccess`.

A step-by-step walkthrough for cPanel is in `db_migration_to_do.md`.

## The MCP API: Claude as a colleague who proposes

`api/mcp.php` lets Claude (through the MCP server in `MCP/`, which runs on a
separate machine) read the CRM and propose changes. It is built so that the
worst a compromised MCP server or a manipulated Claude can do is *read* and
*ask* - never change anything on its own.

**Who can call it.** A request is answered only when all of these hold, checked
in this order by `includes/McpGuard.php`:

1. `MCP_API_ENABLED=true` and `MCP_API_SECRET` has at least 64 characters.
2. `REMOTE_ADDR` is on `MCP_API_ALLOWED_IPS` (IPs or CIDR ranges, IPv4 and
   IPv6). Forwarded headers are ignored, whatever `TRUST_PROXY_HEADERS` says.
3. The connection is HTTPS.
4. It is a POST with a timestamp within five minutes, a never-seen nonce, and
   an HMAC-SHA256 signature over timestamp, nonce and the SHA-256 of the exact
   body. The secret itself never travels, so a captured request can be neither
   altered nor replayed.
5. The rate limit (`MCP_API_RATE_LIMIT`, default 120 per minute) holds.

Failing 1 or 2 returns an empty 404, so to everyone else the endpoint does not
exist.

**What it can do.** A fixed list of actions (`includes/McpService.php`). Every
list is capped; there is no bulk write and no bulk delete. It never touches
users, passwords, settings, imports or exports. Bookkeeping is limited to
listing the drop zone and putting invoice PDFs into it: Claude cannot read
bank entries or invoices, and filing an invoice on its entry is left to a
person (doing so also accepts the upload).

**Human in the loop.** Nothing written through the API is settled:

- A new contact, project, to-do, note or invoice PDF is stored with
  `review_status = 'pending'`. It shows up in the CRM marked "Claude", can be
  edited with the normal forms, and is deleted if rejected.
- A change to an existing record (fields, links, tags, assignment, deletion)
  is not written at all. It waits in `review_items` with
  the proposed values and a snapshot of what was there, until somebody accepts.
- Field edits, deletions and assignments are applied by the accepting person's
  browser through the ordinary endpoints, so they get the same validation and
  logging and are attributed to that person.
- `MCP_API_MAX_PENDING` (default 200) stops a runaway client from flooding the
  queue. `MCP_API_ALLOW_WRITES=false` makes the API read-only.

Every signed-in user may accept, edit or reject ("From Claude" in the sidebar,
or the buttons on a proposed record). `api/review.php` requires a session and
the CSRF token like every other endpoint.

**Prompt injection.** Text in the CRM (notes, imported rows) reaches Claude.
Someone who can write into the CRM could try to steer Claude with it. The
review queue is the answer: whatever Claude is talked into, it can only
propose, and a person decides.

**Where the key lives.** `MCP_API_SECRET` sits in `.env` here (outside the web
root when `crm-private/` is used) and in the MCP server's `.env`. Rotate it by
changing both.

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
| Disable an account | Existing sessions die, sign-in refused, remembered devices refused |
| Delete an account | Sessions die; their tokens and remembered devices are removed |
| Change a password | Every other session dies, and every remembered device is retired |

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

### Two-factor sign-in

A user account's password only opens a *challenge*: a six-digit code goes to
the registered address and has to come back before a session exists. The code
is stored as a bcrypt hash, is single-use, lasts 10 minutes, and dies after 5
wrong guesses. Requesting a new one immediately invalidates the previous one.

Nothing the client holds names the account being signed in - the session
carries only an opaque challenge id, and the row behind it is the authority on
whose sign-in it is.

**The owner login is exempt**, deliberately. It has no registered address, and
it is the way back in when mail, the database or an account is broken; putting
it behind a mail server would make the recovery path depend on the component
most likely to be down. This is the trade the design makes: the owner password
is single-factor, so it has to be long, random and not reused.

A corollary worth planning for: **mail has to work before you invite anyone.**
An account whose code cannot be delivered cannot sign in, and unlike an invite
link there is no panel to copy it out of. Prove delivery with an account of
your own first.

### Keep me signed in

Opt-in, off by default. The cookie is `<selector>:<validator>`; the selector is
the lookup key, and only a SHA-256 of the validator is stored, so a dump of the
table yields nothing presentable. It restores a session with neither password
nor code, which makes it a second key to the account - `REMEMBER_ME_LIFETIME`
(30 days by default) is effectively how long a stolen laptop stays useful.

It is retired by: signing out, changing the password (the token is pinned to
the `password_changed_at` it was issued under), disabling the account, and
expiry.

The validator is rotated on every use. A cookie presenting a *superseded*
validator is evidence it was copied, so every token on that account is dropped
rather than just refused - one stolen cookie costs the thief and the owner the
same thing. The exception is a 60-second grace window
(`REMEMBER_ROTATION_GRACE`) after a rotation, because a single page load fires
several requests carrying the cookie the browser held before any of them
returned; without it, ordinary use would look like theft.

## Assignment and My Work

Any contact, project or to-do can be made somebody's responsibility, and
**My Work** is the per-person view of what that adds up to.

Assigning is open to every signed-in user, not just administrators: handing a
job to a colleague is ordinary teamwork. What is not open is inventing an
assignee - the server checks that the target is a real, active account (or the
owner) rather than trusting the value the browser sent, so work cannot be
parked on a disabled account or a person who does not exist.

Assignment is separate from attribution, and the two behave differently when an
account is deleted:

- **Attribution** ("who wrote this") keeps its name snapshot. It is history.
- **Assignment** ("who is responsible now") is cleared. Work left pointing at a
  deleted colleague would silently belong to nobody; showing it as unassigned
  is how it gets picked up again.

Every assignment change is written to the shared timeline alongside other
edits, so a reassignment is as visible as any other change.

My Work can be pointed at any colleague, or at the unassigned bucket. That is a
re-sorting of records everyone can already read in the ordinary views, not a new
level of access - see the trade-off note below about all members seeing all data.

## What protects what

| Layer | File | Protects against |
|---|---|---|
| Private folder | `crm-private/` next to the web root | Everything below, even when the deny rules are not honoured |
| MCP API guard | `includes/McpGuard.php` | Anyone but the MCP server calling `api/mcp.php`; replayed or altered requests |
| Review queue | `includes/ReviewQueue.php` | Claude changing data without a person accepting it |
| Web server deny rules | `.htaccess`, `*/.htaccess` | Direct download of `.env`, the SQLite DB, uploaded PDFs, PHP includes, `.git`, `error_log`, stray archives |
| PHP direct-access guard | top of `config/config.php`, `includes/*.php` | The same, on nginx, which ignores `.htaccess` |
| Session auth | `includes/auth.php` | Unauthenticated API access (every endpoint checks first) |
| CSRF tokens | `Auth::validateCsrfToken()` | Cross-site state changes; required on POST/PUT/PATCH/DELETE |
| Login lockout | `login_attempts` table | Password brute force (per IP) |
| CSP + output escaping | `Auth::sendSecurityHeaders()`, `escapeHtml()` | Stored XSS from contact/company/tag/file names |
| Upload validation | `api/bookkeeping.php`, `api/import-export.php` | Web shells uploaded as invoices or spreadsheets |
| Image re-encoding | `api/profile.php` | Polyglot files, EXIF leakage and decompression bombs in profile pictures |
| Role gate | `Auth::requireAdmin()` | Non-admins reaching `api/users.php` |
| Type whitelist | `api/assign.php` | A caller choosing which table an assignment writes to |
| Assignee check | `resolveAssignee()` | Work being parked on a disabled or non-existent account |
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

    # Never serve PHP error logs or archives (a misplaced backup ZIP)
    location ~ (^|/)error_log$ {
        deny all;
        return 404;
    }
    location ~ \.(zip|tar|gz|tgz|7z|rar)$ {
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
- **The owner account is single-factor.** Every other account needs an emailed
  code; the owner cannot, because it has no address and must stay usable when
  mail is down. That password is the one credential with no second gate.
- **"Keep me signed in" trades a factor for convenience.** While the cookie
  lives, the device needs neither password nor code. Reuse detection limits the
  damage after the fact; it does not prevent the first use of a stolen cookie.
- **`style-src` keeps `'unsafe-inline'`.** The UI sets inline styles for tag
  colours and map layout. Inline CSS is not a script execution primitive, and
  tag colours are validated as hex server-side.
- **Two outside hosts, both for the map.** Leaflet and its cluster plugin load
  from `unpkg.com`, pinned to exact versions with Subresource Integrity, so a
  changed file is refused rather than run. Map tiles are plain images from
  `tile.openstreetmap.org`, the only outside image host the CSP allows; each
  tile request tells OpenStreetMap roughly which area is on screen, and their
  usage policy expects light traffic with the attribution kept visible. Fonts
  (General Sans, `assets/fonts/`) are served from this site, so no font CDN
  sees your visitors.

## Reporting

This is a private tool; there is no bounty process. If something looks wrong,
check the error log first, then the deny rules in step 3 above.
