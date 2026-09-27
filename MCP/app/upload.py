"""Upload links: how invoice PDFs get from you into the CRM's drop zone.

A tool argument is text that Claude writes out, so Claude cannot hand over the
bytes of a PDF you attached in a chat (beyond very small files). Instead Claude
asks for an upload link: a one-time address on this server, valid for 30
minutes and for at most 20 files. You open it, pick the PDFs, and each one goes
through the signed API into the bookkeeping drop zone - marked as a proposal,
like everything else that arrives this way. Filing them on their bank entries
is up to you.

The link is the only credential for the page, so it is long and random, only
its hash is stored, and wrong links count towards the same lockout as wrong
passwords on the sign-in page.
"""

from __future__ import annotations

import base64
import html
import logging
import time

from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import Response

from .config import Settings
from .crm_client import CrmClient, CrmError
from .oauth import LOGIN_MAX_GLOBAL, LOGIN_MAX_PER_IP, LOGIN_WINDOW, Store, html_page
from .security import new_token, token_hash

log = logging.getLogger("crm-mcp.upload")

LINK_TTL = 30 * 60
LINK_MAX_FILES = 20
FILES_PER_SUBMIT = 10
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_SUBMIT_BYTES = 55 * 1024 * 1024


def create_link(settings: Settings, store: Store) -> dict:
    store.prune()
    token = new_token()
    store.run(
        "INSERT INTO upload_links (token_hash, uploads_left, expires_at) VALUES (?, ?, ?)",
        (token_hash(token), LINK_MAX_FILES, int(time.time()) + LINK_TTL),
    )
    return {
        "url": f"{settings.public_url}/upload?t={token}",
        "valid_minutes": LINK_TTL // 60,
        "max_files": LINK_MAX_FILES,
    }


class UploadPage:
    def __init__(self, settings: Settings, store: Store, crm: CrmClient):
        self.settings = settings
        self.store = store
        self.crm = crm

    async def __call__(self, request: Request) -> Response:
        ip = request.client.host if request.client else "unknown"
        if self._locked(ip):
            return html_page(_message("Zu viele Versuche", "Bitte 15 Minuten warten."), status=429)

        if request.method == "GET":
            token = request.query_params.get("t", "")
            left = self._uploads_left(token)
            if left is None:
                self._fail(ip)
                return html_page(_expired(), status=410)
            return html_page(_form(token, left))

        if int(request.headers.get("content-length") or 0) > MAX_SUBMIT_BYTES:
            return html_page(_message("Zu groß", "Bitte weniger Dateien auf einmal hochladen (höchstens 50 MB)."), status=413)

        form = await request.form(max_files=FILES_PER_SUBMIT, max_fields=4)
        try:
            token = str(form.get("t", ""))
            if self._uploads_left(token) is None:
                self._fail(ip)
                return html_page(_expired(), status=410)

            done, problems = [], []
            for item in form.getlist("pdfs"):
                if not isinstance(item, UploadFile) or not item.filename:
                    continue
                name = item.filename[:200]
                data = await item.read(MAX_PDF_BYTES + 1)
                if len(data) > MAX_PDF_BYTES:
                    problems.append(f"{name}: größer als 10 MB")
                    continue
                if not data.startswith(b"%PDF-"):
                    problems.append(f"{name}: keine PDF-Datei")
                    continue
                if not self._take_slot(token):
                    problems.append(f"{name}: Der Link ist aufgebraucht oder abgelaufen")
                    continue
                try:
                    await self.crm.call("bookkeeping.upload_pdf", {
                        "filename": name,
                        "content_base64": base64.b64encode(data).decode(),
                        "reason": "Über einen Upload-Link von Claude hochgeladen.",
                    })
                    done.append(name)
                except CrmError as exc:
                    problems.append(f"{name}: {exc}")
        finally:
            await form.close()

        log.info("Upload link used from %s: %d uploaded, %d refused", ip, len(done), len(problems))
        left = self._uploads_left(token)
        return html_page(_result(done, problems) + (_form(token, left) if left else ""))

    def _uploads_left(self, token: str) -> int | None:
        if not token:
            return None
        row = self.store.one(
            "SELECT uploads_left FROM upload_links WHERE token_hash = ? AND expires_at >= ?",
            (token_hash(token), int(time.time())),
        )
        if row is None:
            return None
        return int(row["uploads_left"])

    def _take_slot(self, token: str) -> bool:
        cursor = self.store.run(
            "UPDATE upload_links SET uploads_left = uploads_left - 1 WHERE token_hash = ? AND uploads_left > 0 AND expires_at >= ?",
            (token_hash(token), int(time.time())),
        )
        return cursor.rowcount == 1

    def _fail(self, ip: str) -> None:
        self.store.run("INSERT INTO login_failures (ip, at) VALUES (?, ?)", (ip, int(time.time())))

    def _locked(self, ip: str) -> bool:
        since = int(time.time()) - LOGIN_WINDOW
        per_ip = self.store.one("SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at >= ?", (ip, since))["n"]
        total = self.store.one("SELECT COUNT(*) AS n FROM login_failures WHERE at >= ?", (since,))["n"]
        return per_ip >= LOGIN_MAX_PER_IP or total >= LOGIN_MAX_GLOBAL


def _form(token: str, left: int) -> str:
    return f"""
        <h1>Rechnungen hochladen</h1>
        <p class="lead">Die PDFs landen in der <strong>Drop Zone der Buchhaltung</strong>, markiert als von Claude.
        Zuordnen kannst du sie danach im CRM.</p>
        <form method="post" action="/upload" enctype="multipart/form-data">
            <input type="hidden" name="t" value="{html.escape(token)}">
            <label for="pdfs">PDF-Dateien (bis zu {FILES_PER_SUBMIT} auf einmal, je max. 10 MB)</label>
            <input id="pdfs" name="pdfs" type="file" accept="application/pdf,.pdf" multiple required>
            <div class="row"><button type="submit">Hochladen</button></div>
        </form>
        <p class="small">Dieser Link gilt noch für {left} Datei{'en' if left != 1 else ''} und läuft 30 Minuten nach dem Erstellen ab.</p>
    """


def _result(done: list[str], problems: list[str]) -> str:
    parts = []
    if done:
        items = "".join(f"<li>{html.escape(n)}</li>" for n in done)
        parts.append(f'<div class="ok"><strong>In der Drop Zone:</strong><ul>{items}</ul></div>')
    if problems:
        items = "".join(f"<li>{html.escape(p)}</li>" for p in problems)
        parts.append(f'<div class="error"><strong>Nicht hochgeladen:</strong><ul>{items}</ul></div>')
    if not parts:
        parts.append('<div class="error">Es wurde keine Datei ausgewählt.</div>')
    return "".join(parts) + '<hr style="border:0;border-top:1px solid var(--line);margin:22px 0">'


def _expired() -> str:
    return _message("Link abgelaufen", "Dieser Upload-Link ist abgelaufen oder aufgebraucht. Bitte Claude um einen neuen.")


def _message(title: str, text: str) -> str:
    return f"<h1>{html.escape(title)}</h1><p class=\"lead\">{html.escape(text)}</p>"
