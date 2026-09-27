"""OAuth for the MCP server: who may connect Claude to the CRM.

This server is its own OAuth authorization server (the MCP SDK provides the
/register, /authorize, /token, /revoke and metadata endpoints; this module is
the storage and the decisions behind them, plus the sign-in page).

How a connection is made:

  1. Claude registers itself (Dynamic Client Registration). Only Claude's own
     callback URL is accepted, so no other app can register here.
  2. Claude sends your browser to /authorize, which forwards to /login.
  3. You sign in with the password from .env (and, if configured, a six-digit
     code from an authenticator app).
  4. Claude exchanges the one-time code (PKCE-protected) for an access token
     and a refresh token.

Access tokens expire after an hour; refresh tokens are replaced every time they
are used. Only SHA-256 hashes of tokens and codes are stored.
"""

from __future__ import annotations

import html
import json
import logging
import os
import sqlite3
import threading
import time
from typing import Any
from urllib.parse import urlparse

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response

from .config import Settings
from .security import new_token, token_hash, totp_match, verify_password

log = logging.getLogger("crm-mcp.oauth")

# Where Claude's hosted apps (claude.ai, Desktop, mobile) send the user back.
# https://claude.com/docs/connectors/building/authentication#callback-urls
CLAUDE_REDIRECT_URIS = {
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
}

SCOPES = ["crm", "offline_access"]
SUBJECT = "crm-owner"

AUTH_REQUEST_TTL = 600        # the sign-in page is valid for 10 minutes
MAX_OPEN_AUTH_REQUESTS = 500  # /authorize is public; this keeps it from filling the disk
AUTH_CODE_TTL = 300           # a one-time code must be exchanged within 5 minutes
MAX_CLIENTS = 200
CLIENT_IDLE_SECONDS = 90 * 86400

LOGIN_WINDOW = 15 * 60        # failed sign-ins are counted over 15 minutes...
LOGIN_MAX_PER_IP = 5          # ...5 per address...
LOGIN_MAX_GLOBAL = 20         # ...and 20 in total, whoever is guessing


class Store:
    """A small SQLite database in the Docker volume."""

    def __init__(self, data_dir: str):
        os.makedirs(data_dir, exist_ok=True)
        self._db = sqlite3.connect(os.path.join(data_dir, "oauth.sqlite3"), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.executescript(
                """
                CREATE TABLE IF NOT EXISTS clients (
                    client_id TEXT PRIMARY KEY, info TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auth_requests (
                    id_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auth_codes (
                    code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS access_tokens (
                    token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, scopes TEXT NOT NULL,
                    expires_at INTEGER NOT NULL, refresh_hash TEXT
                );
                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS login_failures (ip TEXT NOT NULL, at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_login_failures_at ON login_failures(at);
                CREATE TABLE IF NOT EXISTS totp_used (counter INTEGER PRIMARY KEY, used_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS upload_links (
                    token_hash TEXT PRIMARY KEY, uploads_left INTEGER NOT NULL, expires_at INTEGER NOT NULL
                );
                """
            )

    def run(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._db.execute(sql, params)

    def one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._db.execute(sql, params).fetchone()

    def prune(self) -> None:
        now = int(time.time())
        with self._lock:
            for table in ("auth_requests", "auth_codes", "access_tokens", "refresh_tokens", "upload_links"):
                self._db.execute(f"DELETE FROM {table} WHERE expires_at < ?", (now,))
            self._db.execute("DELETE FROM login_failures WHERE at < ?", (now - 86400,))
            self._db.execute("DELETE FROM totp_used WHERE used_at < ?", (now - 600,))
            self._db.execute("DELETE FROM clients WHERE last_used_at < ?", (now - CLIENT_IDLE_SECONDS,))


class CrmOAuthProvider:
    """The decisions behind the SDK's OAuth endpoints."""

    def __init__(self, settings: Settings, store: Store):
        self.settings = settings
        self.store = store

    # -- clients ---------------------------------------------------------

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        row = self.store.one("SELECT info FROM clients WHERE client_id = ?", (client_id,))
        if row is None:
            return None
        self.store.run("UPDATE clients SET last_used_at = ? WHERE client_id = ?", (int(time.time()), client_id))
        return OAuthClientInformationFull.model_validate_json(row["info"])

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        uris = [str(uri) for uri in (client_info.redirect_uris or [])]
        if not uris or any(uri not in CLAUDE_REDIRECT_URIS for uri in uris):
            log.warning("Refused client registration with redirect URIs %s", uris)
            raise RegistrationError("invalid_redirect_uri", "This server only accepts Claude's own callback URL.")

        self.store.prune()
        count = self.store.one("SELECT COUNT(*) AS n FROM clients")["n"]
        if count >= MAX_CLIENTS:
            raise RegistrationError("invalid_client_metadata", "Too many registered clients. Try again later.")

        now = int(time.time())
        self.store.run(
            "INSERT INTO clients (client_id, info, created_at, last_used_at) VALUES (?, ?, ?, ?)",
            (client_info.client_id, client_info.model_dump_json(), now, now),
        )
        log.info("Registered OAuth client %s (%s)", client_info.client_id, client_info.client_name or "unnamed")

    # -- authorization ---------------------------------------------------

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        if params.resource and params.resource.rstrip("/") != self.settings.mcp_url:
            raise AuthorizeError("invalid_target", "This server only issues tokens for its own MCP endpoint.")

        self.store.prune()
        open_requests = self.store.one("SELECT COUNT(*) AS n FROM auth_requests")["n"]
        if open_requests >= MAX_OPEN_AUTH_REQUESTS:
            log.warning("Refusing /authorize: %d sign-in requests already open", open_requests)
            raise AuthorizeError("temporarily_unavailable", "Too many sign-in attempts in progress. Try again in a few minutes.")

        request_id = new_token()
        payload = {
            "client_id": client.client_id,
            "client_name": client.client_name or "Claude",
            "redirect_uri": str(params.redirect_uri),
            "redirect_uri_provided_explicitly": params.redirect_uri_provided_explicitly,
            "state": params.state,
            "scopes": params.scopes or ["crm"],
            "code_challenge": params.code_challenge,
        }
        self.store.run(
            "INSERT INTO auth_requests (id_hash, client_id, params, expires_at) VALUES (?, ?, ?, ?)",
            (token_hash(request_id), client.client_id, json.dumps(payload), int(time.time()) + AUTH_REQUEST_TTL),
        )
        return f"{self.settings.public_url}/login?request={request_id}"

    def pending_request(self, request_id: str) -> dict[str, Any] | None:
        if not request_id:
            return None
        row = self.store.one(
            "SELECT params FROM auth_requests WHERE id_hash = ? AND expires_at >= ?",
            (token_hash(request_id), int(time.time())),
        )
        return json.loads(row["params"]) if row else None

    def complete_request(self, request_id: str) -> str | None:
        """Turn a signed-in request into a one-time code; returns the redirect URL."""
        payload = self.pending_request(request_id)
        if payload is None:
            return None
        cursor = self.store.run("DELETE FROM auth_requests WHERE id_hash = ?", (token_hash(request_id),))
        if cursor.rowcount == 0:
            return None  # used by a parallel submit

        code = new_token()
        self.store.run(
            "INSERT INTO auth_codes (code_hash, client_id, data, expires_at) VALUES (?, ?, ?, ?)",
            (token_hash(code), payload["client_id"], json.dumps(payload), int(time.time()) + AUTH_CODE_TTL),
        )
        return construct_redirect_uri(payload["redirect_uri"], code=code, state=payload["state"])

    def deny_request(self, request_id: str) -> str | None:
        payload = self.pending_request(request_id)
        if payload is None:
            return None
        self.store.run("DELETE FROM auth_requests WHERE id_hash = ?", (token_hash(request_id),))
        return construct_redirect_uri(
            payload["redirect_uri"], error="access_denied", error_description="Sign-in was declined.", state=payload["state"]
        )

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str) -> AuthorizationCode | None:
        row = self.store.one(
            "SELECT data, expires_at FROM auth_codes WHERE code_hash = ? AND client_id = ? AND expires_at >= ?",
            (token_hash(authorization_code), client.client_id, int(time.time())),
        )
        if row is None:
            return None
        data = json.loads(row["data"])
        return AuthorizationCode(
            code=authorization_code,
            scopes=data["scopes"],
            expires_at=float(row["expires_at"]),
            client_id=data["client_id"],
            code_challenge=data["code_challenge"],
            redirect_uri=data["redirect_uri"],
            redirect_uri_provided_explicitly=data["redirect_uri_provided_explicitly"],
            resource=self.settings.mcp_url,
            subject=SUBJECT,
        )

    async def exchange_authorization_code(self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode) -> OAuthToken:
        cursor = self.store.run(
            "DELETE FROM auth_codes WHERE code_hash = ? AND client_id = ?",
            (token_hash(authorization_code.code), client.client_id),
        )
        if cursor.rowcount == 0:
            raise TokenError("invalid_grant", "This code has already been used or has expired.")
        log.info("Issued tokens to client %s", client.client_id)
        return self._issue(client.client_id, authorization_code.scopes)

    # -- tokens ----------------------------------------------------------

    def _issue(self, client_id: str, scopes: list[str]) -> OAuthToken:
        now = int(time.time())
        access = new_token()
        refresh = new_token()
        self.store.run(
            "INSERT INTO refresh_tokens (token_hash, client_id, scopes, expires_at) VALUES (?, ?, ?, ?)",
            (token_hash(refresh), client_id, " ".join(scopes), now + self.settings.refresh_token_ttl),
        )
        self.store.run(
            "INSERT INTO access_tokens (token_hash, client_id, scopes, expires_at, refresh_hash) VALUES (?, ?, ?, ?, ?)",
            (token_hash(access), client_id, " ".join(scopes), now + self.settings.access_token_ttl, token_hash(refresh)),
        )
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=self.settings.access_token_ttl,
            refresh_token=refresh,
            scope=" ".join(scopes),
        )

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        row = self.store.one(
            "SELECT scopes, expires_at FROM refresh_tokens WHERE token_hash = ? AND client_id = ? AND expires_at >= ?",
            (token_hash(refresh_token), client.client_id, int(time.time())),
        )
        if row is None:
            return None
        return RefreshToken(
            token=refresh_token,
            client_id=client.client_id,
            scopes=row["scopes"].split(),
            expires_at=int(row["expires_at"]),
            resource=self.settings.mcp_url,
            subject=SUBJECT,
        )

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]) -> OAuthToken:
        old_hash = token_hash(refresh_token.token)
        cursor = self.store.run("DELETE FROM refresh_tokens WHERE token_hash = ? AND client_id = ?", (old_hash, client.client_id))
        if cursor.rowcount == 0:
            raise TokenError("invalid_grant", "This refresh token is no longer valid.")
        self.store.run("DELETE FROM access_tokens WHERE refresh_hash = ?", (old_hash,))

        granted = [s for s in scopes if s in refresh_token.scopes] if scopes else refresh_token.scopes
        return self._issue(client.client_id, granted or refresh_token.scopes)

    async def load_access_token(self, token: str) -> AccessToken | None:
        row = self.store.one(
            "SELECT client_id, scopes, expires_at FROM access_tokens WHERE token_hash = ? AND expires_at >= ?",
            (token_hash(token), int(time.time())),
        )
        if row is None:
            return None
        return AccessToken(
            token=token,
            client_id=row["client_id"],
            scopes=row["scopes"].split(),
            expires_at=int(row["expires_at"]),
            resource=self.settings.mcp_url,
            subject=SUBJECT,
        )

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        hashed = token_hash(token.token)
        row = self.store.one("SELECT refresh_hash FROM access_tokens WHERE token_hash = ?", (hashed,))
        refresh_hash = row["refresh_hash"] if row else hashed
        self.store.run("DELETE FROM access_tokens WHERE token_hash = ? OR refresh_hash = ?", (hashed, refresh_hash))
        self.store.run("DELETE FROM refresh_tokens WHERE token_hash = ?", (refresh_hash,))

    async def exchange_identity_assertion(self, client, params) -> OAuthToken:  # pragma: no cover - not offered
        raise TokenError("unsupported_grant_type", "Not supported.")


# ---------------------------------------------------------------------------
# The sign-in page
# ---------------------------------------------------------------------------

class LoginPage:
    """GET shows the sign-in form, POST checks it and sends the browser back to Claude."""

    def __init__(self, settings: Settings, provider: CrmOAuthProvider, store: Store):
        self.settings = settings
        self.provider = provider
        self.store = store

    async def __call__(self, request: Request) -> Response:
        if request.method == "POST":
            return await self._post(request)
        payload = self.provider.pending_request(request.query_params.get("request", ""))
        if payload is None:
            return self._page(_expired_body(), status=410)
        return self._page(self._form(request.query_params["request"], payload))

    async def _post(self, request: Request) -> Response:
        form = await request.form()
        request_id = str(form.get("request", ""))
        payload = self.provider.pending_request(request_id)
        if payload is None:
            return self._page(_expired_body(), status=410)

        if form.get("action") == "deny":
            target = self.provider.deny_request(request_id)
            return RedirectResponse(target, status_code=302) if target else self._page(_expired_body(), status=410)

        ip = request.client.host if request.client else "unknown"
        if self._locked(ip):
            log.warning("Sign-in locked for %s after repeated failures", ip)
            return self._page(self._form(request_id, payload, "Zu viele Fehlversuche. Bitte 15 Minuten warten."), status=429)

        password_ok = verify_password(str(form.get("password", "")), self.settings.login_password_hash)
        code_ok = True
        if self.settings.totp_secret:
            counter = totp_match(self.settings.totp_secret, str(form.get("code", "")))
            # The code is only spent on a sign-in that succeeds: a mistyped
            # password must not burn a valid code and force a 30-second wait.
            code_ok = counter is not None and password_ok and self._use_totp(counter)

        if not (password_ok and code_ok):
            self.store.run("INSERT INTO login_failures (ip, at) VALUES (?, ?)", (ip, int(time.time())))
            log.warning("Failed sign-in from %s", ip)
            return self._page(self._form(request_id, payload, "Passwort oder Code stimmt nicht."), status=401)

        target = self.provider.complete_request(request_id)
        if target is None:
            return self._page(_expired_body(), status=410)
        self.store.run("DELETE FROM login_failures WHERE ip = ?", (ip,))
        log.info("Signed in from %s; connecting client %s", ip, payload["client_id"])
        return RedirectResponse(target, status_code=302)

    def _locked(self, ip: str) -> bool:
        since = int(time.time()) - LOGIN_WINDOW
        per_ip = self.store.one("SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at >= ?", (ip, since))["n"]
        total = self.store.one("SELECT COUNT(*) AS n FROM login_failures WHERE at >= ?", (since,))["n"]
        return per_ip >= LOGIN_MAX_PER_IP or total >= LOGIN_MAX_GLOBAL

    def _use_totp(self, counter: int) -> bool:
        """A code works once: refusing a reused one stops someone who watched you type it."""
        try:
            self.store.run("INSERT INTO totp_used (counter, used_at) VALUES (?, ?)", (counter, int(time.time())))
            return True
        except sqlite3.IntegrityError:
            return False

    def _form(self, request_id: str, payload: dict[str, Any], error: str | None = None) -> str:
        host = urlparse(payload["redirect_uri"]).netloc
        code_field = (
            '<label for="code">6-stelliger Code aus der Authenticator-App</label>'
            '<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required>'
            if self.settings.totp_secret else ""
        )
        return f"""
            <h1>Claude mit dem CRM verbinden</h1>
            <p class="lead"><strong>{html.escape(payload.get("client_name") or "Claude")}</strong> möchte auf dein CRM zugreifen.
            Danach kann Claude lesen und <strong>Vorschläge</strong> machen - dauerhaft wird erst, was jemand im CRM annimmt.</p>
            <p class="small">Weiterleitung danach an: <code>{html.escape(host)}</code></p>
            {f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ''}
            <form method="post" action="/login" autocomplete="off">
                <input type="hidden" name="request" value="{html.escape(request_id)}">
                <label for="password">Passwort</label>
                <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
                {code_field}
                <div class="row">
                    <button type="submit" name="action" value="allow">Anmelden &amp; verbinden</button>
                    <button type="submit" name="action" value="deny" class="secondary" formnovalidate>Ablehnen</button>
                </div>
            </form>
            <p class="small">Nur fortfahren, wenn du die Verbindung gerade selbst in Claude gestartet hast.</p>
        """

    def _page(self, body: str, status: int = 200) -> HTMLResponse:
        # form-action also governs where the post-sign-in redirect may go.
        redirect_origins = sorted({f"https://{urlparse(u).netloc}" for u in CLAUDE_REDIRECT_URIS})
        return html_page(body, status, form_targets=redirect_origins)


def html_page(body: str, status: int = 200, form_targets: list[str] | None = None) -> HTMLResponse:
    """A small self-contained page (sign-in, upload) with strict security headers."""
    targets = " ".join(["'self'", *(form_targets or [])])
    return HTMLResponse(
        _PAGE.replace("{body}", body),
        status_code=status,
        headers={
            "Content-Security-Policy": (
                "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; "
                f"form-action {targets}; frame-ancestors 'none'"
            ),
            "X-Frame-Options": "DENY",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow",
        },
    )


def _expired_body() -> str:
    return """
        <h1>Link abgelaufen</h1>
        <p class="lead">Diese Anmeldung ist abgelaufen oder wurde schon verwendet.
        Starte die Verbindung bitte noch einmal in Claude.</p>
    """


_PAGE = """<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>CRM verbinden</title>
<style>
  :root { color-scheme: light dark; --ink:#112D4E; --ink3:#5E7190; --bg:#F9F7F7; --card:#fff; --line:#E2E7EF; --accent:#3F72AF; --danger:#B3453B; }
  @media (prefers-color-scheme: dark) { :root { --ink:#E8EEF7; --ink3:#9AA9C0; --bg:#0B1524; --card:#122036; --line:#22324B; --accent:#83A9DC; --danger:#E0786E; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px; background:var(--bg); color:var(--ink);
         font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px; }
  h1 { font-size:22px; margin:0 0 10px; letter-spacing:-0.02em; }
  .lead { margin:0 0 12px; }
  .small { font-size:13px; color:var(--ink3); margin:12px 0 0; }
  code { font-size:13px; }
  label { display:block; font-size:13px; color:var(--ink3); margin:14px 0 6px; }
  input { width:100%; height:42px; padding:0 12px; border:1px solid var(--line); border-radius:10px; background:transparent; color:var(--ink); font:inherit; }
  input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
  .row { display:flex; gap:10px; margin-top:20px; flex-wrap:wrap; }
  button { height:42px; padding:0 18px; border-radius:10px; border:1px solid var(--ink); background:var(--ink); color:var(--bg); font:600 14px/1 inherit; cursor:pointer; }
  button.secondary { background:transparent; color:var(--ink); border-color:var(--line); }
  .error { color:var(--danger); background:color-mix(in srgb, var(--danger) 12%, transparent); padding:10px 12px; border-radius:10px; margin:12px 0 0; }
  .ok { color:var(--ink); background:color-mix(in srgb, var(--accent) 12%, transparent); padding:10px 12px; border-radius:10px; margin:12px 0 0; }
  input[type=file] { height:auto; padding:12px; border-style:dashed; }
  ul { margin:8px 0 0; padding-left:20px; }
</style>
</head>
<body><main>{body}</main></body>
</html>"""
