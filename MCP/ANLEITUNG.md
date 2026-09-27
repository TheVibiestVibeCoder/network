# Anleitung: Claude mit dem CRM verbinden

Schritt für Schritt, zum Abhaken. Jeder Befehl steht in einem grauen Kasten –
kopieren, einfügen, Enter.

---

## Worum geht es?

```
  Claude (claude.ai, App, Handy)
        │  1. fragt den MCP-Server – nur mit deinem Login (OAuth)
        ▼
  MCP-Server  ── läuft bei Hetzner (lagebild, 2.28.118.11), in Docker
        │  2. fragt die CRM-API – nur mit geheimer Signatur,
        │     nur von der Hetzner-IP, nur über HTTPS
        ▼
  CRM  ── network.disinfocombat.eu (cPanel)
        3. Alles, was Claude schreibt, ist nur ein VORSCHLAG.
           Ihr nehmt ihn im CRM unter „From Claude" an (✓),
           bearbeitet ihn oder lehnt ihn ab (✗).
```

**Was Claude kann:**

- **Lesen:** Kontakte, Firmen, Projekte, To-dos, Notizen, Tags, letzte Aktivitäten
- **Vorschlagen:** Kontakte und Projekte anlegen oder ändern, Notizen, To-dos, Tags, Personen zu Projekten hinzufügen, Zuständigkeiten, einzelne Löschungen
- **Rechnungen hochladen:** Claude gibt dir einen Upload-Link, die PDFs landen in der Drop Zone der Buchhaltung. Das Zuordnen zu den Buchungen machst du selbst.
- **Nicht möglich:** Massen-Löschen, Benutzer, Passwörter, Einstellungen, Import/Export, Buchungen lesen

**Wie es geschützt ist:**

| Schutz | Wo |
|---|---|
| Login mit Passwort + 6-stelligem Code aus einer App, bevor Claude verbinden darf | MCP-Server |
| Nur Anthropic-Server erreichen die Werkzeuge; Login- und Upload-Seite erreicht dein Browser | Caddy (Türsteher auf Hetzner) |
| CRM-API antwortet nur der Hetzner-IP, nur mit gültiger Signatur, nur über HTTPS – allen anderen: 404 | CRM |
| Jede Änderung wartet auf ein ✓ von einem Menschen | CRM |

**Dauer:** ca. 1–1,5 Stunden, einmalig.

---

## Merkzettel

- MCP-Adresse: `mcp.disinfocombat.eu` (kannst du ändern – dann überall gleich)
- Hetzner-Server: `lagebild`, IP `2.28.118.11`
- GitHub-Repo für den MCP-Server: `crm-mcp` (privat)
- Passwort für die Verbindung: ____________ (in den Passwort-Manager!)

---

## Teil 1 – CRM aktualisieren (cPanel, ca. 10 Min.)

Die neue Version des CRM hat die API und die Ansicht „From Claude". Die API ist
**ausgeschaltet**, bis du sie in Teil 5 einschaltest.

- [ ] Den Branch `mcp_crm` committen und auf GitHub pushen (wie immer)
- [ ] cPanel → **Git Version Control** → **Manage** → auf `mcp_crm` wechseln →
      **Update from Remote**
- [ ] CRM öffnen und einloggen. Links im Menü gibt es jetzt **„From Claude"**.
      Sonst ist alles wie vorher.

> Zurück: in cPanel wieder auf `main` wechseln.

---

## Teil 2 – Eigenes privates Repo für den MCP-Server (dein PC, ca. 10 Min.)

### Schritt 2.1: Leeres Repo auf GitHub anlegen

- [ ] github.com → oben rechts **+** → **New repository**
- [ ] Name: `crm-mcp`, **Private** auswählen, **keine** README anhaken
- [ ] **Create repository**

### Schritt 2.2: Den Ordner `MCP` hochladen

In **Git Bash auf deinem PC**:

```bash
cp -r ~/network/network/MCP ~/crm-mcp
cd ~/crm-mcp
git init -b main
git add .
git commit -m "CRM MCP server"
git remote add origin https://github.com/TheVibiestVibeCoder/crm-mcp.git
git push -u origin main
```

- [ ] Auf GitHub neu laden: Die Dateien (`app`, `scripts`, `Dockerfile` …) sind da.

> Eine Datei `.env` darf dort **nie** auftauchen. Die `.gitignore` verhindert
> das.

---

## Teil 3 – Adresse für den MCP-Server anlegen (DNS, ca. 5 Min. + Wartezeit)

- [ ] cPanel → **Zone Editor** → bei `disinfocombat.eu` auf **+ A Record**
  - Name: `mcp.disinfocombat.eu.`
  - Address: `2.28.118.11`
  - **Add Record**
- [ ] **Keinen** AAAA-Eintrag (IPv6) anlegen, das ist so gewollt.

> Falls die DNS von `disinfocombat.eu` nicht bei cPanel liegt (z. B. bei
> Cloudflare oder beim Domain-Anbieter): denselben A-Eintrag dort anlegen. Bei
> Cloudflare das orange Wolken-Symbol **ausschalten** (grau, „DNS only").

Prüfen (Git Bash auf dem PC, kann 5–30 Min. dauern):

```bash
nslookup mcp.disinfocombat.eu
```

- [ ] Bei „Address" steht `2.28.118.11`

---

## Teil 4 – Den Server vorbereiten (Hetzner, ca. 20 Min.)

Einloggen wie immer:

```bash
ssh lagebild-server
```

### Schritt 4.1: Ist Docker da?

```bash
docker --version
docker compose version
```

- [ ] Beide zeigen eine Versionsnummer → weiter mit 4.2
  - Kommt `permission denied`: vor jeden `docker`-Befehl `sudo` schreiben,
    oder einmalig `sudo usermod -aG docker $USER` ausführen, dann aus- und
    wieder einloggen.
  - Kommt `command not found`: Docker installieren mit
    ```bash
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
    ```
    danach aus- und wieder einloggen.

### Schritt 4.2: Sind die Ports 80 und 443 frei?

```bash
sudo ss -tlnp | grep -E ':(80|443)\s'
```

- [ ] **Keine Ausgabe** → perfekt, das ist **Fall A**. Weiter mit 4.3.
- [ ] **Es kommt eine Zeile** (z. B. mit `nginx`, `caddy`, `traefik` oder
      `docker-proxy`) → Die Ports nutzt schon etwas, vermutlich Narrative
      Capture. Das ist **Fall B**, siehe Anhang ganz unten. Am einfachsten:
      schick Claude die Ausgabe.

### Schritt 4.3: Firewall

- [ ] **Hetzner Cloud Console** → dein Server → **Firewalls**:
  - Gibt es keine Firewall: nichts zu tun.
  - Gibt es eine: Regeln für **TCP 80** und **TCP 443** von „Any IPv4" und
    „Any IPv6" erlauben. Die Regel für **SSH (22)** bleibt, wie sie ist.

Warum 80/443 für alle? Dein Browser muss die Anmeldeseite erreichen, und das
HTTPS-Zertifikat braucht Port 80. Alles andere sperrt Caddy selbst: Die
Werkzeuge erreichen nur Anthropics Server.

### Schritt 4.4: Zugang zum privaten Repo (Deploy Key)

Der Server bekommt einen eigenen Schlüssel, der das Repo **nur lesen** darf.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/crm_mcp_deploy -N "" -C "hetzner-lagebild-crm-mcp"
cat ~/.ssh/crm_mcp_deploy.pub
```

- [ ] Die ausgegebene Zeile (beginnt mit `ssh-ed25519`) kopieren
- [ ] GitHub → Repo `crm-mcp` → **Settings** → **Deploy keys** → **Add deploy key**
  - Title: `Hetzner lagebild`
  - Key: einfügen
  - „Allow write access" **nicht** anhaken
  - **Add key**

Zurück auf dem Server:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-crm-mcp
    HostName github.com
    User git
    IdentityFile ~/.ssh/crm_mcp_deploy
    IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
git clone git@github-crm-mcp:TheVibiestVibeCoder/crm-mcp.git ~/crm-mcp
```

- [ ] Fragt er „Are you sure you want to continue connecting?": `yes` tippen
- [ ] Danach gibt es den Ordner `~/crm-mcp`

### Schritt 4.5: Einrichten – das Skript fragt alles ab

```bash
cd ~/crm-mcp
python3 scripts/setup.py
```

Das Skript fragt:

1. **Adresse dieses MCP-Servers**: Enter, wenn `mcp.disinfocombat.eu` stimmt
2. **Adresse der CRM-API**: Enter, wenn `https://network.disinfocombat.eu/api/mcp.php` stimmt
3. **Deine E-Mail**: für das HTTPS-Zertifikat
4. **Passwort**: Damit verbindest du später Claude. Mindestens 12 Zeichen, besser 16+. Leer lassen, dann erzeugt das Skript eins, und das speicherst du sofort im Passwort-Manager.
5. **6-stelliger Code aus einer App?** Empfohlen: `j`. Du tippst den angezeigten Schlüssel in deine Authenticator-App (Microsoft/Google Authenticator: „Konto hinzufügen" → „Schlüssel manuell eingeben") und bestätigst einmal mit dem aktuellen Code.

Am Ende zeigt das Skript eine Zeile wie:

```
MCP_API_SECRET=3f9a…(64 Zeichen)
```

- [ ] Diese Zeile **kopieren**. Du brauchst sie gleich in Teil 5. Nirgends sonst speichern oder verschicken.

---

## Teil 5 – Die CRM-API einschalten (cPanel, ca. 5 Min.)

- [ ] cPanel → **Dateimanager** → `/home/markussc/crm-private` → Datei `.env`
      anklicken → **Bearbeiten**
- [ ] Ganz unten diese drei Zeilen einfügen. Die mittlere ist die aus
      Schritt 4.5:

```
MCP_API_ENABLED=true
MCP_API_SECRET=3f9a…(die Zeile aus dem Skript)
MCP_API_ALLOWED_IPS=2.28.118.11,2a01:4f8:1c1e:9d04::/64
```

- [ ] **Speichern**

> Aus-Schalter für den Notfall: `MCP_API_ENABLED=false` setzen und speichern.
> Dann antwortet das CRM der API sofort nicht mehr.

---

## Teil 6 – Starten (Hetzner, ca. 5 Min.)

```bash
cd ~/crm-mcp
docker compose up -d --build
```

Das dauert beim ersten Mal 1–3 Minuten. Dann prüfen:

```bash
docker compose ps
```

- [ ] Zwei Zeilen (`mcp` und `caddy`), beide „Up" bzw. „running",
      `mcp` nach kurzer Zeit „(healthy)"

**Erreicht der Server das CRM?**

```bash
docker compose exec mcp python -m scripts.check_crm
```

- [ ] Es kommt `OK - verbunden mit '…'` und die Anzahl deiner Kontakte
  - Steht dort `NICHT OK`, steht darunter auch, was zu prüfen ist.

**Von außen prüfen** (Browser am PC oder Handy):

- [ ] `https://mcp.disinfocombat.eu/login` → Seite „Link abgelaufen", mit gültigem Schloss-Symbol ✔
      (richtig so: Das heißt, HTTPS funktioniert und der Server ist erreichbar)
- [ ] `https://mcp.disinfocombat.eu/mcp` → leere Seite / Fehler 404 ✔
      (richtig so: Dieser Teil ist nur für Anthropic offen)

> Klappt das Schloss nicht (Zertifikatsfehler): meist ist die DNS aus Teil 3
> noch nicht überall angekommen. 10 Minuten warten, dann
> `docker compose restart caddy`. Details: `docker compose logs caddy`.

---

## Teil 7 – Claude verbinden (ca. 5 Min.)

- [ ] **claude.ai** öffnen → unten links auf deinen Namen → **Einstellungen**
      → **Connectors**
- [ ] **Benutzerdefinierten Connector hinzufügen** („Add custom connector")
  - Name: `CRM`
  - URL: `https://mcp.disinfocombat.eu/mcp`
  - Erweiterte Einstellungen (Client-ID/Secret): **leer lassen**
  - **Hinzufügen**
- [ ] Beim neuen Connector auf **Verbinden** („Connect")
- [ ] Es öffnet sich deine Seite **„Claude mit dem CRM verbinden"**:
      Passwort und Code eintippen → **Anmelden & verbinden**
- [ ] Zurück in Claude steht der Connector auf „Verbunden"

> Siehst du „Connectors" oder „Benutzerdefiniert" nicht: Bei Team- oder
> Enterprise-Konten muss ein Owner eigene Connectoren erlauben. Bei
> Einzelkonten hängt es vom Plan ab.

Die Verbindung gilt dann auch in der Claude-App am Handy und am Desktop.

---

## Teil 8 – Ausprobieren

Neuen Chat öffnen. Über das **Werkzeug-Symbol** (bzw. „+") den Connector
**CRM** einschalten. Dann:

1. **Lesen:** „Welche Kontakte haben wir bei ACME?"
   → Claude fragt, ob es das Werkzeug benutzen darf → **Erlauben**
2. **Vorschlagen:** „Leg Max Muster von der Test GmbH als Kontakt an,
   E-Mail max@test.at"
   → Claude sagt „vorgeschlagen"
   → Im CRM unter **From Claude**: Karte „New contact" → **Accept**,
   **Edit** oder **Reject**
3. **Rechnungen:** „Ich hab zwei Rechnungen für die Buchhaltung"
   → Claude gibt dir einen Link → antippen → PDFs auswählen → **Hochladen**
   → Sie liegen in der **Drop Zone** der Buchhaltung, markiert mit „Claude".
   Ziehst du sie auf die passende Buchung, gelten sie als angenommen.

**Wo sieht man Claudes Vorschläge?**

- Menüpunkt **From Claude** mit Zähler. Dort ist alles zum Annehmen,
  Bearbeiten und Ablehnen, dazu ein Verlauf (wer was entschieden hat).
- **Direkt an den Einträgen:** eine blaue „✦ Claude"-Markierung mit ✓/✗ in
  Kontakt- und Projektlisten, bei Notizen, To-dos und in der Drop Zone.
- **In der Detailansicht** eines Kontakts oder Projekts: ein Kasten
  „Claude schlägt Änderungen vor" mit Vorher → Nachher.

Das kann **jeder angemeldete Benutzer** entscheiden.

---

## Alltag und Wartung

| Was | Befehl (auf dem Server, im Ordner `~/crm-mcp`) |
|---|---|
| Läuft alles? | `docker compose ps` |
| Was passiert gerade? | `docker compose logs -f` (Beenden mit Strg+C) |
| Verbindung zum CRM prüfen | `docker compose exec mcp python -m scripts.check_crm` |
| Update einspielen | `git pull && docker compose up -d --build` |
| Stoppen | `docker compose down` |
| Wieder starten | `docker compose up -d` |

- **Nach einem Neustart des Servers** starten die Container von selbst.
- **Nur lesen lassen:** in `~/crm-mcp/.env` die Zeile `READ_ONLY=true` setzen,
  dann `docker compose up -d`. Oder im CRM `MCP_API_ALLOW_WRITES=false`.
- **Neuen geheimen Schlüssel:** `openssl rand -hex 32` → den Wert in
  `~/crm-mcp/.env` (`CRM_API_SECRET=`) **und** in der CRM-`.env`
  (`MCP_API_SECRET=`) eintragen → `docker compose up -d`.
- **Notfall – alle Claude-Verbindungen sofort trennen:**
  ```bash
  docker compose down
  docker volume rm crm-mcp_mcp-data
  docker compose up -d
  ```
  Danach muss Claude neu verbunden werden (Teil 7).
- Beim Einloggen steht „*** System restart required ***"? Dann zu einer
  ruhigen Zeit `sudo apt update && sudo apt upgrade -y && sudo reboot`.

---

## Wenn etwas nicht klappt

| Du siehst … | Das heißt … | Das tust du |
|---|---|---|
| Claude: „Couldn't reach the MCP server" | Server nicht erreichbar oder URL falsch | URL muss auf `/mcp` enden. `docker compose ps` und `docker compose logs caddy` prüfen |
| Anmeldeseite: „Link abgelaufen" | Die Anmeldung ist älter als 10 Minuten | In Claude noch einmal auf „Verbinden" |
| „Zu viele Fehlversuche" | 5 falsche Versuche in 15 Minuten | 15 Minuten warten |
| Der 6-stellige Code passt nie | Uhrzeit von Handy oder Server stimmt nicht | Handy: Uhrzeit automatisch. Server: `timedatectl` (NTP sollte „active" sein) |
| Claude: „The CRM answered 404" | API aus, oder IP nicht erlaubt | Teil 5 prüfen, dann `check_crm` |
| Claude: „Invalid signature" | Schlüssel in beiden `.env` verschieden | Beide Werte vergleichen (Teil 4.5 / Teil 5) |
| Claude: „…web application firewall…" | Die Hosting-Firewall blockt die Anfrage | Hoster fragen, ob Anfragen an `/api/mcp.php` von 2.28.118.11 blockiert werden |
| Upload-Link: „abgelaufen" | Länger als 30 Minuten her oder 20 Dateien erreicht | Claude um einen neuen Link bitten |
| Claude: „already 200 proposals waiting" | Zu viele offene Vorschläge | Im CRM unter „From Claude" aufräumen |

Bei allem anderen: die Ausgabe von `docker compose logs --tail 50` an Claude
schicken.

---

## Anhang: Fall B – Ports 80/443 sind schon belegt

Dann läuft auf dem Server schon ein Webserver, vermutlich für Narrative
Capture. Unser Caddy startet dann nicht. Stattdessen:

1. Start mit der Zusatzdatei (statt Teil 6, erster Befehl):
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.behind-proxy.yml up -d --build
   ```
   Der MCP-Server lauscht dann nur lokal auf `127.0.0.1:8765`.

2. Der vorhandene Webserver leitet `mcp.disinfocombat.eu` dorthin weiter,
   **mit denselben Regeln**:
   - `/authorize`, `/login`, `/upload` → für alle
   - alles andere → nur `160.79.104.0/21` (Anthropic), sonst 404

   Beispiel für einen vorhandenen **Caddy** (direkt auf dem Server):
   ```
   mcp.disinfocombat.eu {
       @browser path /authorize /login /upload
       @anthropic remote_ip 160.79.104.0/21
       handle @browser { reverse_proxy 127.0.0.1:8765 }
       handle @anthropic { reverse_proxy 127.0.0.1:8765 }
       handle { respond 404 }
   }
   ```

   Beispiel für **nginx** (Zertifikat mit certbot):
   ```nginx
   server {
       server_name mcp.disinfocombat.eu;
       listen 443 ssl;
       # ssl_certificate ... (certbot trägt das ein)
       client_max_body_size 60m;

       location ~ ^/(authorize|login|upload)$ {
           proxy_pass http://127.0.0.1:8765;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $remote_addr;
           proxy_set_header X-Forwarded-Proto https;
       }
       location / {
           allow 160.79.104.0/21;
           deny all;
           proxy_pass http://127.0.0.1:8765;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $remote_addr;
           proxy_set_header X-Forwarded-Proto https;
       }
   }
   ```

Läuft der vorhandene Webserver selbst in Docker, zeigt `127.0.0.1` nicht auf
den Server. Am einfachsten schickst du Claude dann die Ausgaben von
`docker ps` und `sudo ss -tlnp | grep -E ':(80|443)\s'`, und du bekommst die
passende Konfiguration.

---

## Anhang: Womit funktioniert es?

- **claude.ai im Browser, Claude-Desktop-App, Claude-Handy-App:** ja. Alle
  drei laufen über Anthropics Server, und die sind freigeschaltet.
- **Claude Code:** bewusst nicht. Es würde sich direkt von deinem PC
  verbinden, und der Login nimmt absichtlich nur Claudes offizielle
  Rücksprungadresse an. Das ist ein Teil des Schutzes.
