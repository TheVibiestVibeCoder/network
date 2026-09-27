"""Password hashing, one-time codes and token hashing - standard library only.

Passwords: scrypt (memory-hard), stored as
    scrypt$<n>$<r>$<p>$<salt b64>$<hash b64>

One-time codes: RFC 6238 TOTP (the six-digit codes of any authenticator app),
30-second steps, one step of clock drift allowed either way, and a code that
has been used once is refused afterwards.

Tokens: only their SHA-256 is stored, so a copy of the database contains
nothing that can be presented as a token.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time

_SCRYPT_N = 2**15
_SCRYPT_R = 8
_SCRYPT_P = 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, maxmem=64 * 1024 * 1024)
    return "scrypt${}${}${}${}${}".format(
        _SCRYPT_N, _SCRYPT_R, _SCRYPT_P,
        base64.b64encode(salt).decode(), base64.b64encode(digest).decode(),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        digest = hashlib.scrypt(
            password.encode(), salt=salt, n=int(n), r=int(r), p=int(p),
            maxmem=64 * 1024 * 1024, dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest, expected)


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def totp_at(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def totp_match(secret: str, code: str, now: float | None = None) -> int | None:
    """The time step the code belongs to, or None. Checks now and one step either side."""
    code = "".join(ch for ch in code if ch.isdigit())
    if len(code) != 6:
        return None
    current = int((now if now is not None else time.time()) // 30)
    for counter in (current - 1, current, current + 1):
        if hmac.compare_digest(totp_at(secret, counter), code):
            return counter
    return None


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    # 256 bits: far past the 160 the OAuth spec asks for.
    return secrets.token_urlsafe(32)
