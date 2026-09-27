"""Does this server reach the CRM? Run on the server:

    docker compose exec mcp python -m scripts.check_crm

It makes one signed read request (the same one Claude makes first) and says in
plain words whether it worked, and if not, what to check.
"""

from __future__ import annotations

import asyncio
import sys

from app.config import load_settings_or_exit
from app.crm_client import CrmClient, CrmError

HINTS = {
    404: "Das CRM antwortet 404. Prüfe in der .env des CRM: MCP_API_ENABLED=true, MCP_API_SECRET gesetzt "
         "(mindestens 64 Zeichen) und MCP_API_ALLOWED_IPS enthält die IP dieses Servers.",
    401: "Die Signatur passt nicht: MCP_API_SECRET (CRM) und CRM_API_SECRET (hier) müssen exakt gleich sein. "
         "Oder die Uhrzeit dieses Servers stimmt nicht (timedatectl).",
    403: "Das CRM verlangt HTTPS - CRM_API_URL muss mit https:// beginnen.",
    429: "Zu viele Anfragen in kurzer Zeit. Eine Minute warten.",
}


async def main() -> int:
    settings = load_settings_or_exit()
    client = CrmClient(settings.crm_api_url, settings.crm_api_secret)
    try:
        meta = await client.call("meta")
    except CrmError as exc:
        print(f"\n  NICHT OK: {exc}")
        if exc.status in HINTS:
            print(f"\n  Hinweis: {HINTS[exc.status]}")
        print()
        return 1
    finally:
        await client.aclose()

    counts = meta.get("counts", {})
    print(f"\n  OK - verbunden mit '{meta.get('crm_name')}'.")
    print(f"  {counts.get('contacts', 0)} Kontakte, {counts.get('projects_open', 0)} offene Projekte, "
          f"{counts.get('proposals_waiting', 0)} Vorschläge warten auf Prüfung.")
    print(f"  Schreiben erlaubt: {'ja (nur als Vorschlag)' if meta.get('writes_enabled') else 'nein'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
