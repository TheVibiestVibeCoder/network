#!/usr/bin/env python3
"""Interactive set-up: asks a few questions and writes the .env file.

Run on the server, inside the MCP folder:

    python3 scripts/setup.py

It needs nothing but Python 3 (Ubuntu has it). It
  - creates the shared secret for the CRM (and prints the line for the CRM's .env),
  - turns your sign-in password into a hash (the password itself is not stored),
  - optionally sets up a six-digit code from an authenticator app,
  - writes .env readable only by you.
"""

from __future__ import annotations

import getpass
import os
import re
import secrets
import stat
import sys
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from app.security import hash_password, new_totp_secret, totp_at  # noqa: E402

ENV_PATH = HERE / ".env"


def ask(question: str, default: str | None = None, pattern: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        answer = input(f"{question}{suffix}: ").strip() or (default or "")
        if not answer:
            print("  Bitte etwas eingeben.")
            continue
        if pattern and not re.fullmatch(pattern, answer):
            print("  Das sieht nicht richtig aus, bitte noch einmal.")
            continue
        return answer


def yes(question: str, default: bool = False) -> bool:
    hint = "J/n" if default else "j/N"
    answer = input(f"{question} ({hint}): ").strip().lower()
    return default if answer == "" else answer in ("j", "ja", "y", "yes")


def main() -> None:
    print("\n=== Einrichtung des CRM-MCP-Servers ===\n")

    if ENV_PATH.exists() and not yes(f"{ENV_PATH.name} gibt es schon. Überschreiben?"):
        print("Nichts geändert.")
        return

    domain = ask("Adresse dieses MCP-Servers (ohne https://)", "mcp.disinfocombat.eu", r"[a-z0-9.-]+\.[a-z]{2,}")
    crm_url = ask("Adresse der CRM-API", "https://network.disinfocombat.eu/api/mcp.php", r"https://\S+/api/mcp\.php")
    email = ask("Deine E-Mail (für das HTTPS-Zertifikat von Let's Encrypt)", pattern=r"[^@\s]+@[^@\s]+\.[^@\s]+")

    print("\nJetzt das Passwort, mit dem du Claude später einmalig mit dem CRM verbindest.")
    print("Tipp: mindestens 16 Zeichen, nirgends sonst verwendet. Leer lassen = ich erzeuge eins.")
    while True:
        password = getpass.getpass("Passwort (unsichtbar): ")
        if not password:
            password = secrets.token_urlsafe(18)
            print(f"\n  Erzeugtes Passwort:  {password}\n  -> Bitte JETZT in deinem Passwort-Manager speichern!\n")
            break
        if len(password) < 12:
            print("  Bitte mindestens 12 Zeichen.")
            continue
        if getpass.getpass("Noch einmal: ") != password:
            print("  Die beiden Eingaben stimmen nicht überein.")
            continue
        break

    totp = None
    if yes("\nZusätzlich einen 6-stelligen Code aus einer Authenticator-App verlangen? (empfohlen)", True):
        totp = new_totp_secret()
        label = quote(f"CRM MCP ({domain})")
        print("\n  Öffne deine Authenticator-App (z. B. Microsoft oder Google Authenticator),")
        print("  wähle 'Konto hinzufügen' -> 'Schlüssel manuell eingeben' und tippe ein:")
        print(f"\n     Name:      CRM MCP\n     Schlüssel: {' '.join(totp[i:i + 4] for i in range(0, len(totp), 4))}\n     Typ:       zeitbasiert\n")
        print(f"  (Oder als Link: otpauth://totp/{label}?secret={totp}&issuer=CRM%20MCP)\n")
        import time
        while True:
            code = input("  Zur Kontrolle: welchen 6-stelligen Code zeigt die App jetzt? ").strip().replace(" ", "")
            now = int(time.time() // 30)
            if code in {totp_at(totp, now + d) for d in (-1, 0, 1)}:
                print("  Passt!\n")
                break
            print("  Der Code passt nicht - Schlüssel richtig abgetippt? Noch einmal.")

    secret = secrets.token_hex(32)
    lines = [
        "# Written by scripts/setup.py. Keep this file private (it is readable only by you).",
        f"MCP_DOMAIN={domain}",
        f"ACME_EMAIL={email}",
        f"CRM_API_URL={crm_url}",
        f"CRM_API_SECRET={secret}",
        # Single quotes: Docker Compose takes the value literally, so the $ signs
        # inside the hash are not read as variables.
        f"LOGIN_PASSWORD_HASH='{hash_password(password)}'",
        f"TOTP_SECRET={totp or ''}",
        "",
        "# Extra addresses allowed to reach the MCP endpoints besides Anthropic (space-separated).",
        "# Leave empty unless you know you need it.",
        "EXTRA_ALLOWED_IPS=",
        "",
        "# true = Claude can only read, never propose changes.",
        "READ_ONLY=false",
        "LOG_LEVEL=INFO",
    ]
    content = "\n".join(lines) + "\n"

    ENV_PATH.write_text(content, encoding="utf-8")
    os.chmod(ENV_PATH, stat.S_IRUSR | stat.S_IWUSR)

    print("=" * 70)
    print(f"Fertig: {ENV_PATH} geschrieben.\n")
    print("Jetzt diese Zeile in die .env des CRM eintragen (cPanel, Datei crm-private/.env):\n")
    print(f"    MCP_API_SECRET={secret}\n")
    print("Diese Zeile ist wie ein Passwort - nirgendwo sonst speichern oder verschicken.")
    print("=" * 70 + "\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAbgebrochen, nichts geschrieben.")
