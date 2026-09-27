"""Signed client for the CRM's MCP API (api/mcp.php).

Every request is signed with the shared secret. The secret itself never
travels: the CRM recomputes the signature and compares. Each request also
carries a fresh nonce and the current time, so a captured request cannot be
replayed or altered.

Wire format (must match includes/McpGuard.php in the CRM):

    POST <CRM_API_URL>
    Content-Type: application/octet-stream
    X-CRM-Timestamp: <unix seconds>
    X-CRM-Nonce: <32 hex chars>
    X-CRM-Signature: hex(HMAC-SHA256(secret,
                      "CRM-MCP-V1\\n{timestamp}\\n{nonce}\\n{hex(SHA256(body))}"))
    body: base64(JSON {"action": ..., "params": {...}})
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

import httpx

SIGNATURE_VERSION = "CRM-MCP-V1"


class CrmError(Exception):
    """The CRM refused or failed a request. The message is safe to show Claude."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def sign(secret: str, timestamp: str, nonce: str, body: bytes) -> str:
    message = f"{SIGNATURE_VERSION}\n{timestamp}\n{nonce}\n{hashlib.sha256(body).hexdigest()}"
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


class CrmClient:
    def __init__(self, api_url: str, secret: str, timeout: float = 45.0):
        self._url = api_url
        self._secret = secret
        # No redirects: an HTTP->HTTPS redirect would silently drop the body,
        # and a redirect anywhere else is not somewhere we want to send data.
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=10.0),
            follow_redirects=False,
            headers={"User-Agent": "crm-mcp-server/1.0"},
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def call(self, action: str, params: dict[str, Any] | None = None) -> Any:
        payload = {"action": action, "params": _drop_none(params or {})}
        body = base64.b64encode(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )
        timestamp = str(int(time.time()))
        nonce = secrets.token_hex(16)

        try:
            response = await self._http.post(
                self._url,
                content=body,
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-CRM-Timestamp": timestamp,
                    "X-CRM-Nonce": nonce,
                    "X-CRM-Signature": sign(self._secret, timestamp, nonce, body),
                },
            )
        except httpx.HTTPError as exc:
            raise CrmError(f"The CRM could not be reached ({type(exc).__name__}).") from exc

        try:
            data = response.json()
        except ValueError:
            data = None

        if not isinstance(data, dict):
            if response.status_code == 404:
                raise CrmError(
                    "The CRM answered 404 - the API is switched off, or this server's IP "
                    "is not on MCP_API_ALLOWED_IPS.",
                    404,
                )
            raise CrmError(
                f"The CRM returned an unexpected response (HTTP {response.status_code}). "
                "A web application firewall on the hosting may have blocked the request.",
                response.status_code,
            )

        if not data.get("ok"):
            raise CrmError(str(data.get("error") or "The CRM refused the request."), response.status_code)

        return data.get("data")


def _drop_none(params: dict[str, Any]) -> dict[str, Any]:
    """Leave out arguments Claude did not set, so the CRM applies its defaults."""
    return {key: value for key, value in params.items() if value is not None}
