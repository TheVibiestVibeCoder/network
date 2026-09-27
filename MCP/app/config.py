"""Settings, read once from the environment (the .env file next to docker-compose.yml).

Everything is checked at start-up. A missing or weak setting stops the server
with a message that says what to fix, instead of starting half-configured.
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from urllib.parse import urlparse


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    public_url: str            # https://mcp.example.eu - where Claude and your browser reach this server
    crm_api_url: str           # https://crm.example.eu/api/mcp.php
    crm_api_secret: str        # the same value as MCP_API_SECRET in the CRM's .env
    login_password_hash: str   # scrypt hash of the sign-in password (scripts/make_secrets.py)
    totp_secret: str | None    # optional second factor for the sign-in page
    data_dir: str              # where the OAuth database lives (a Docker volume)
    access_token_ttl: int      # seconds
    refresh_token_ttl: int     # seconds
    read_only: bool            # hide every tool that proposes changes
    allow_insecure_http: bool  # local testing only
    host: str
    port: int
    log_level: str

    @property
    def mcp_url(self) -> str:
        return self.public_url + "/mcp"

    @property
    def public_host(self) -> str:
        return urlparse(self.public_url).netloc


def _bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if raw == "":
        return default
    return raw in ("1", "true", "yes", "on")


def _int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a whole number.") from exc
    return max(minimum, min(maximum, value))


def load_settings() -> Settings:
    insecure = _bool("ALLOW_INSECURE_HTTP")

    public_url = os.environ.get("PUBLIC_URL", "").strip().rstrip("/")
    if not public_url:
        domain = os.environ.get("MCP_DOMAIN", "").strip()
        if domain:
            public_url = f"https://{domain}"
    if not public_url:
        raise ConfigError("Set MCP_DOMAIN (e.g. mcp.example.eu) or PUBLIC_URL in .env.")
    if not insecure and not public_url.startswith("https://"):
        raise ConfigError("PUBLIC_URL must start with https://")

    crm_api_url = os.environ.get("CRM_API_URL", "").strip()
    if not crm_api_url:
        raise ConfigError("Set CRM_API_URL in .env, e.g. https://crm.example.eu/api/mcp.php")
    if not insecure and not crm_api_url.startswith("https://"):
        raise ConfigError("CRM_API_URL must start with https:// - the CRM refuses anything else.")

    secret = os.environ.get("CRM_API_SECRET", "").strip()
    if len(secret) < 64:
        raise ConfigError(
            "CRM_API_SECRET must be at least 64 characters (create one with: openssl rand -hex 32) "
            "and must be the same value as MCP_API_SECRET in the CRM's .env."
        )

    password_hash = os.environ.get("LOGIN_PASSWORD_HASH", "").strip().strip("'\"")
    if not password_hash.startswith("scrypt$"):
        raise ConfigError(
            "LOGIN_PASSWORD_HASH is missing. Create it with: "
            "docker compose run --rm mcp python -m scripts.make_secrets"
        )

    totp = os.environ.get("TOTP_SECRET", "").strip().replace(" ", "").upper() or None
    if totp is not None and not re.fullmatch(r"[A-Z2-7]{16,64}=*", totp):
        raise ConfigError("TOTP_SECRET must be a base32 secret (letters A-Z and digits 2-7), or empty.")

    return Settings(
        public_url=public_url,
        crm_api_url=crm_api_url,
        crm_api_secret=secret,
        login_password_hash=password_hash,
        totp_secret=totp,
        data_dir=os.environ.get("DATA_DIR", "/data").strip() or "/data",
        access_token_ttl=_int("ACCESS_TOKEN_TTL", 3600, 300, 86400),
        refresh_token_ttl=_int("REFRESH_TOKEN_TTL", 30 * 86400, 3600, 180 * 86400),
        read_only=_bool("READ_ONLY"),
        allow_insecure_http=insecure,
        host=os.environ.get("HOST", "0.0.0.0").strip() or "0.0.0.0",
        port=_int("PORT", 8000, 1, 65535),
        log_level=(os.environ.get("LOG_LEVEL", "INFO").strip().upper() or "INFO"),
    )


def load_settings_or_exit() -> Settings:
    try:
        return load_settings()
    except ConfigError as exc:
        print(f"\nConfiguration problem: {exc}\n", file=sys.stderr)
        sys.exit(2)
