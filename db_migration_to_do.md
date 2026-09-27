# Umzug: Daten raus aus dem Webordner

## Kurz erklärt

**Das Problem:** Alle CRM-Daten und das Passwort liegen im **Webordner**. Das ist
der Ordner, aus dem die Website `network.disinfocombat.eu` ausgeliefert wird.
Was dort liegt, ist nur durch `.htaccess`-Regeln geschützt. Wenn die einmal
nicht greifen, könnte jemand die ganze Datenbank herunterladen.

**Die Lösung:** Wir verschieben die Daten nach `/home/markussc/crm-private`.
Dieser Ordner liegt **außerhalb** des Webordners. Der Webserver kann ihn gar
nicht ausliefern, egal was mit `.htaccess` passiert.

**Der Ablauf in 5 Teilen:**

| Teil | Wer | Dauer | Was |
|---|---|---|---|
| 1 | du | 10 Min. | Ordner prüfen, Webordner finden, **dann „go“ an Claude** |
| 2 | Claude | – | Code anpassen (du musst nichts tun) |
| 3 | du | 45 Min. | Backup, neuen Code hochladen, Daten umziehen, testen |
| 4 | du | 15 Min. | Alte Dateien löschen, Rechte setzen, prüfen |
| 5 | du | laufend | Regelmäßige Backups |

> **Wann darfst du „go“ sagen?** Direkt nach Teil 1. Die Code-Änderung passiert
> nur im Repo, auf dem Server ändert sich dabei nichts. Das Backup machst du
> später in Teil 3, **bevor** du irgendetwas hochlädst.

---

## Merkzettel (bitte ausfüllen)

- Mein Webordner: `/home/markussc/network.disinfocombat.eu`
- Anzahl Kontakte vor dem Umzug: `_______`
- Datum des Umzugs: `_______`

---

## So sieht es vorher und nachher aus

```
VORHER
/home/markussc/
├── crm-private/                  ← leer
└── network.disinfocombat.eu/     ← aus dem Internet erreichbar
    ├── index.php, api/, ...
    ├── .env                      ← Passwort und Einstellungen
    └── data/
        ├── crm.db                ← ALLE CRM-Daten
        ├── bookkeeping_pdfs/     ← Rechnungen
        └── avatars/              ← Profilbilder

NACHHER
/home/markussc/
├── crm-private/                  ← NICHT aus dem Internet erreichbar
│   ├── .env
│   ├── data/
│   │   ├── crm.db
│   │   ├── bookkeeping_pdfs/
│   │   └── avatars/
│   └── logs/                     ← Fehlerprotokoll, entsteht von selbst
└── network.disinfocombat.eu/     ← Webordner
    ├── index.php, api/, ...
    └── data/
        └── .htaccess             ← bleibt, der Ordner ist sonst leer
```

---

## Teil 1 – Vorbereitung (du, ca. 10 Min.)

### Schritt 1: Versteckte Dateien sichtbar machen

Dateien, die mit einem Punkt beginnen (z. B. `.env`), zeigt der cPanel-
Dateimanager normalerweise nicht an.

- [ ] cPanel → **Dateimanager** öffnen
- [ ] Oben rechts auf **Einstellungen** (Settings) klicken
- [ ] Häkchen bei **Versteckte Dateien anzeigen (dotfiles)** setzen → Speichern

### Schritt 2: Den Ordner `crm-private` prüfen

- [ ] Im Dateimanager den Ordner `crm-private` öffnen
- [ ] Oben in der Pfadzeile muss genau stehen: `/home/markussc/crm-private`
  - **Nicht** `/home/markussc/public_html/crm-private`
  - **Nicht** irgendwo im Webordner
- [ ] Der Ordner ist **leer**

### Schritt 3: Den Webordner herausfinden

- [ ] cPanel-Startseite → **Domains**
- [ ] In der Zeile `network.disinfocombat.eu` steht in der Spalte
      **Document Root** (Dokumentstamm) ein Pfad, z. B.
      `/home/markussc/network.disinfocombat.eu` oder
      `/home/markussc/public_html/network`
  - cPanel zeigt statt `/home/markussc` oft nur ein **Haus-Symbol** 🏠.
    🏠 `/network.disinfocombat.eu` heißt also `/home/markussc/network.disinfocombat.eu`.
- [ ] Diesen Pfad oben im Merkzettel eintragen
- [ ] Im Dateimanager kurz in diesen Ordner schauen: Dort liegen `index.php`,
      `.env` und der Ordner `data`. Dann ist es der richtige.

### Schritt 4: Claude „go“ sagen

Schick Claude diese Nachricht (mit deinem Pfad):

```
go – db_migration Teil 2
Webordner: /home/markussc/network.disinfocombat.eu
Privater Ordner: /home/markussc/crm-private
```

Claude braucht den Webordner, um sicherzugehen, dass die App den Ordner
`crm-private` von dort aus findet.

---

## Teil 2 – Code-Änderung (Claude) ✅ erledigt

Das hat Claude geändert:

1. **Die App sucht zuerst nach `crm-private`.** Beim Start schaut sie, ob
   oberhalb des Webordners ein Ordner `crm-private` mit einer `.env` liegt.
   - **Ja** → Passwort und Einstellungen kommen aus
     `/home/markussc/crm-private/.env`, die Daten aus
     `/home/markussc/crm-private/data/`.
   - **Nein** → alles bleibt wie bisher.

   Deshalb ist das Hochladen des neuen Codes ungefährlich: Solange keine `.env`
   in `crm-private` liegt, ändert sich nichts. **Das Verschieben der `.env`
   ist der Schalter** (Schritt 9).

2. **Sicherheitsnetz:** Liegt die `.env` schon in `crm-private`, fehlt dort aber
   die Datenbank, zeigt die App eine Fehlerseite. Sie legt dann nicht still eine
   neue, leere Datenbank an.

3. **Fehlerprotokoll absichern:** Bei cPanel schreibt PHP Fehler oft in eine
   Datei namens `error_log` direkt im Webordner. Die `.htaccess` hat diese
   Datei bisher **nicht** gesperrt, und sie kann Serverpfade enthalten. Jetzt
   ist sie gesperrt. Nach dem Umzug schreibt die App ihr Protokoll nach
   `crm-private/logs/php-error.log`.

4. **ZIP-Dateien sperren:** Die `.htaccess` sperrt jetzt auch `.zip`, `.tar`,
   `.gz`, `.7z` und `.rar`. Landet ein Backup doch einmal aus Versehen im
   Webordner, kann es trotzdem niemand herunterladen. (Das CRM selbst bietet
   keine solchen Dateien direkt an. Der Rechnungs-Export wird von PHP erzeugt
   und ist davon nicht betroffen.)

5. `SECURITY.md` und `.env.example` sind ergänzt.

**Getestet** hat Claude das lokal mit echtem PHP: alter Aufbau, neuer Aufbau
(einloggen, Kontakte lesen, Kontakt anlegen, Rechnungs-Ordner), `.env`
umgezogen ohne Daten (→ Fehlerseite, keine leere Datenbank) und keine `.env`
(→ Fehlerseite).

**Geänderte Dateien:** `config/config.php`, `api/bookkeeping.php`,
`api/profile.php` und `.htaccess`, dazu `SECURITY.md`, `.env.example` und
diese Anleitung. Alles liegt im Branch `claude/mcp-server-api-feasibility-poaxuy`
und kommt in Schritt 7 per Git auf den Server, wie sonst auch.

`.env` und `data/crm.db` fasst Git **nicht** an. Sie stehen in `.gitignore`,
deshalb überschreibt oder löscht ein Git-Update sie nie.

---

## Teil 3 – Der Umzug (du, ca. 45 Min.)

> Mach Teil 3 **in einem Rutsch**, zu einer ruhigen Zeit, z. B. am Abend.
> Schritt 9 **erst**, wenn der neue Code online ist (Schritt 7). Sonst zeigt
> die Seite nur eine Fehlermeldung.

### Schritt 5: Für Ruhe sorgen

- [ ] Dem Team Bescheid geben: „Heute zwischen __ und __ Uhr bitte nichts im
      CRM speichern.“ (Sonst geht, was in dieser Zeit gespeichert wird,
      beim Umzug verloren.)
- [ ] Im CRM einloggen und die **Anzahl der Kontakte** in den Merkzettel
      schreiben. Damit prüfst du später, ob alle Daten da sind.

### Schritt 6: Backup machen

Wir packen den `data`-Ordner und die `.env` in eine ZIP-Datei und laden sie
herunter.

- [ ] Im Dateimanager den **Webordner** öffnen
- [ ] Den Ordner `data` anklicken, dann mit **Strg** zusätzlich `.env` anklicken
      (beide sind jetzt markiert)
- [ ] Oben auf **Komprimieren** (Compress) → **Zip Archive** wählen
- [ ] Als Speicherort eintragen: `/home/markussc/crm-backup.zip`
  - Falls cPanel im Feld einen Pfad **ohne** `/home/markussc` zeigt
    (z. B. `/public_html/...`), dann einfach `/crm-backup.zip` eintragen.
  - **Wichtig:** Die ZIP-Datei darf **nicht** im Webordner landen, sonst
    könnte man sie aus dem Internet herunterladen.
- [ ] Zu `/home/markussc` wechseln, `crm-backup.zip` anklicken → **Herunterladen**
- [ ] Auf deinem PC die ZIP öffnen und prüfen:
  - Ordner `data` mit der Datei `crm.db` ist drin, und sie ist **nicht 0 KB** groß
  - `.env` ist drin
- [ ] Die ZIP an einem sicheren Ort aufheben (nicht in einem geteilten Ordner).
      Sie enthält das Passwort und alle Daten.

### Schritt 7: Neuen Code hochladen (noch ohne Umzug)

So wie du sonst Updates machst, per Git:

- [ ] Prüfen, dass die Änderungen auf GitHub im Branch
      `claude/mcp-server-api-feasibility-poaxuy` sind (gepusht)
- [ ] cPanel → **Git Version Control** → beim CRM auf **Manage** (Verwalten)
- [ ] Auf den Branch `claude/mcp-server-api-feasibility-poaxuy` wechseln und
      **Update from Remote** klicken
  - Meldet cPanel einen Fehler (z. B. wegen „lokaler Änderungen“ oder
    „would be overwritten“): **abbrechen**, nichts erzwingen, Claude Bescheid
    sagen.
- [ ] Die Seite öffnen und einloggen. Alles muss **genau wie vorher** aussehen,
      die Kontakte sind da.
  - Es hat sich noch nichts geändert, und das ist richtig so.

> **Zurück zum alten Code:** In cPanel wieder auf `main` wechseln.
> Das geht einfach **nur bis Schritt 9**. Danach musst du vorher die `.env`
> zurück in den Webordner verschieben, denn der alte Code kennt `crm-private`
> nicht.

### Schritt 8: Den Datenordner kopieren

Wir **kopieren** den ganzen `data`-Ordner. Das Original bleibt als
Rückfall-Lösung erst mal liegen.

- [ ] Im **Webordner** den Ordner `data` anklicken (nur diesen)
- [ ] Oben auf **Kopieren** (Copy)
- [ ] Als Ziel eintragen: `/home/markussc/crm-private`
  - Falls cPanel den Pfad ohne `/home/markussc` zeigt: `/crm-private`
- [ ] Auf **Kopieren** klicken
- [ ] Zu `/home/markussc/crm-private/data` wechseln und prüfen:
  - `crm.db` ist da, und die **Größe ist gleich** wie im Webordner
  - `bookkeeping_pdfs` ist da (falls es ihn im Webordner gab)
  - `avatars` ist da (falls es ihn im Webordner gab)
  - `crm.db-wal` und `crm.db-shm`: gibt es manchmal, manchmal nicht. Beides ist ok.

### Schritt 9: Der Schalter – `.env` verschieben

- [ ] Im **Webordner** die Datei `.env` anklicken
- [ ] Oben auf **Verschieben** (Move)
- [ ] Als Ziel eintragen: `/home/markussc/crm-private`
      (bzw. `/crm-private`, wie in Schritt 8)
- [ ] Auf **Verschieben** klicken
- [ ] Prüfen: Im Webordner gibt es **keine** `.env` mehr. In
      `/home/markussc/crm-private` liegen jetzt `.env` und `data`.

**Ab jetzt nutzt die Seite den neuen Ordner.**

### Schritt 10: Testen

- [ ] Seite öffnen → die Login-Seite erscheint (nicht „Service temporarily unavailable“)
- [ ] Als Owner einloggen
- [ ] Die Anzahl der Kontakte stimmt mit dem Merkzettel überein
- [ ] In der Buchhaltung ein Rechnungs-PDF öffnen
- [ ] Ein Profilbild wird angezeigt (falls es welche gibt)
- [ ] Einen Test-Kontakt anlegen
- [ ] Im Dateimanager nachsehen: In `/home/markussc/crm-private/data` hat
      `crm.db` (oder `crm.db-wal`) bei „Zuletzt geändert“ die **aktuelle
      Uhrzeit**. Damit ist bewiesen, dass die Seite in den neuen Ordner
      schreibt.
- [ ] Den Test-Kontakt wieder löschen
- [ ] Optional: Mit einem normalen Benutzerkonto einloggen (mit Code per Mail).
      Das prüft, ob die Mail-Einstellungen aus der `.env` noch funktionieren.

> **Wenn in Schritt 9 oder 10 etwas nicht stimmt: zurück!**
>
> Die `.env` aus `/home/markussc/crm-private` wieder in den Webordner
> verschieben. Sofort ist alles wie vorher, weil die alten Daten dort noch
> liegen. Dann Claude sagen, was du gesehen hast.
>
> Zurück nur **direkt nach dem Umzug**. Hat schon jemand im neuen Ordner
> gearbeitet, gehen diese Änderungen beim Zurückgehen verloren.

---

## Teil 4 – Aufräumen (du, ca. 15 Min.)

Erst machen, wenn Schritt 10 komplett geklappt hat.

### Schritt 11: Alte Daten im Webordner löschen

- [ ] Im Webordner den Ordner `data` öffnen
- [ ] Diese Dateien und Ordner **löschen** (sofern vorhanden):
  - `crm.db`
  - `crm.db-wal`
  - `crm.db-shm`
  - `bookkeeping_pdfs`
  - `avatars`
- [ ] **Stehen lassen:** `.htaccess` und `.gitkeep`
- [ ] Beim Löschen das Häkchen **Papierkorb überspringen** setzen. Du hast ja
      das Backup.
- [ ] Alte Fehlerprotokolle löschen: Liegt im Webordner oder im Ordner `api`
      eine Datei namens `error_log`, dann löschen. Sie ist zwar jetzt gesperrt,
      wird aber nicht mehr gebraucht. Neue Einträge landen in
      `/home/markussc/crm-private/logs/`.
- [ ] Die Seite noch einmal öffnen und einloggen. Die Kontakte sind noch da.
      Damit ist bewiesen, dass die alten Dateien nicht mehr gebraucht werden.

### Schritt 12: Rechte setzen

So können andere Nutzer auf dem Server die Dateien nicht lesen.

- [ ] In `/home/markussc` den Ordner `crm-private` anklicken → **Berechtigungen**
      (Permissions) → auf `700` setzen (nur bei „Benutzer“ alle drei Häkchen)
- [ ] In `crm-private` die Datei `.env` anklicken → **Berechtigungen** → `600`
      (nur bei „Benutzer“: Lesen und Schreiben)
- [ ] Die Seite noch einmal testen: einloggen, einen Kontakt öffnen
  - Geht nichts mehr? → `crm-private` zurück auf `755`, `.env` auf `644`,
    und Claude Bescheid sagen.

### Schritt 13: Von außen prüfen

Diese Adressen im Browser aufrufen. Bei **jeder** muss „403“, „404“ oder
„Forbidden“ / „Not Found“ kommen. **Niemals** darf eine Datei angezeigt oder
heruntergeladen werden.

- [ ] `https://network.disinfocombat.eu/.env`
- [ ] `https://network.disinfocombat.eu/data/crm.db`
- [ ] `https://network.disinfocombat.eu/data/bookkeeping_pdfs/`
- [ ] `https://network.disinfocombat.eu/config/config.php`
- [ ] `https://network.disinfocombat.eu/.git/config`
- [ ] `https://network.disinfocombat.eu/error_log`
- [ ] `https://network.disinfocombat.eu/api/error_log`

Zum Ordner `.git` im Webordner: Den brauchst du, weil du per cPanel-Git
aktualisierst. **Nicht löschen.** Wichtig ist nur, dass
`https://network.disinfocombat.eu/.git/config` oben mit 403/404 geblockt wird.

### Schritt 14: Backup-Datei auf dem Server

- [ ] Nach etwa einer Woche ohne Probleme: `/home/markussc/crm-backup.zip`
      auf dem Server löschen. Die Kopie auf deinem PC behältst du.

### Schritt 15: Zurück auf `main`

Damit spätere Updates wieder ganz normal über `main` laufen:

- [ ] Auf GitHub den Branch `claude/mcp-server-api-feasibility-poaxuy` per
      Pull Request in `main` mergen
- [ ] cPanel → **Git Version Control** → **Manage** → auf `main` wechseln →
      **Update from Remote**
- [ ] Kurz einloggen und prüfen, ob alles läuft. Der Code ist derselbe, es
      darf sich nichts ändern.

---

## Teil 5 – Regelmäßige Backups

Das CRM macht selbst keine Backups.

- [ ] **Beim Hoster nachfragen** (oder in cPanel unter „Backup“ bzw.
      „JetBackup“ nachsehen): Gibt es tägliche automatische Backups? Und
      sichern sie das **ganze** Home-Verzeichnis `/home/markussc`, also auch
      `crm-private`, und nicht nur die Website?
- [ ] **Zusätzlich einmal im Monat** (oder öfter), am besten abends:
  1. Den Ordner `crm-private` komprimieren nach `/home/markussc/crm-backup-DATUM.zip`
  2. Herunterladen und sicher aufheben
  3. Die ZIP auf dem Server wieder löschen
- [ ] **Einmal ausprobieren**, ob das Backup wirklich funktioniert: ZIP öffnen,
      `crm.db` mit dem kostenlosen Programm „DB Browser for SQLite“ öffnen und
      nachsehen, ob die Kontakte drin sind.

---

## Wenn etwas schiefgeht

| Du siehst … | Das heißt wahrscheinlich … | Das tust du |
|---|---|---|
| „Service temporarily unavailable“ direkt nach Schritt 9 | Die App findet die `.env` oder die Datenbank im neuen Ordner nicht | `.env` zurück in den Webordner, Claude Bescheid sagen. Evtl. Hoster fragen: „Darf PHP im Ordner `/home/markussc/crm-private` lesen und schreiben (open_basedir)?“ |
| „Service temporarily unavailable“ nach Schritt 7 | Beim Update ist etwas schiefgegangen | In cPanel zurück auf `main` wechseln, Claude Bescheid sagen |
| Das CRM ist leer | Die App liest eine falsche Datenbank | `.env` zurück in den Webordner, Claude Bescheid sagen |
| Rechnungen oder Profilbilder fehlen | Ein Ordner wurde nicht mitkopiert | Prüfen, ob `bookkeeping_pdfs` und `avatars` in `crm-private/data` liegen |
| Speichern klappt nicht | Fehlende Schreibrechte | Rechte auf `755` (Ordner) und `644` (Dateien), Claude Bescheid sagen |
| Nach Schritt 12 geht nichts mehr | Rechte zu streng | `crm-private` auf `755`, `.env` auf `644` |

Im Zweifel gilt: **Das Backup aus Schritt 6 ist dein Sicherheitsnetz.** Damit
lässt sich jederzeit der Stand von vor dem Umzug wiederherstellen.
