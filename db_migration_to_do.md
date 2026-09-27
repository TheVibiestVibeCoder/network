# To-do: Daten aus dem Webordner verschieben

## Worum geht es?

Derzeit liegen alle Daten **im Webordner**, also im selben Ordner wie die Website:

| Was | Wo |
|---|---|
| Alle CRM-Daten (Kontakte, Projekte, Notizen, Buchhaltung, Benutzer) | `data/crm.db` |
| Rechnungs-PDFs | `data/bookkeeping_pdfs/` |
| Profilbilder | `data/avatars/` |
| Passwort & Einstellungen | `.env` |

Geschützt sind sie nur durch `.htaccess`-Regeln. Wenn die einmal nicht greifen
(Hoster wechselt auf nginx, Server-Update, Fehlkonfiguration), könnte jemand
`https://network.disinfocombat.eu/data/crm.db` herunterladen – und hätte alles.

**Ziel:** Die Daten liegen in einem Ordner, den der Webserver gar nicht
ausliefern *kann*. Dann ist `.htaccess` nur noch zweite Absicherung.

```
VORHER                                  NACHHER
/home/USER/                             /home/USER/
└── network.disinfocombat.eu/  (web)    ├── crm-private/        (NICHT öffentlich)
    ├── index.php                       │   ├── .env
    ├── .env                            │   └── data/
    └── data/                           │       ├── crm.db
        ├── crm.db                      │       ├── bookkeeping_pdfs/
        ├── bookkeeping_pdfs/           │       └── avatars/
        └── avatars/                    └── network.disinfocombat.eu/  (web)
                                            ├── index.php
                                            └── ...
```

Aufwand: ca. 1–2 Stunden inkl. Testen.

---

## Schritt 0 – Vorher klären

- [ ] Beim Hoster nachsehen (FTP / Dateimanager): **Gibt es einen Ordner oberhalb
      des Webordners**, in den man schreiben darf? Meist heißt der Webordner
      `public_html`, `httpdocs` oder wie die Domain; der Ordner darüber ist
      dein Home-Verzeichnis.
- [ ] Den **vollständigen Pfad** notieren, z. B. `/home/USER/crm-private`.
      Tipp: Im Hoster-Panel steht er oft unter „Dateimanager“ oder „PHP-Info“
      (`DOCUMENT_ROOT`).
- [ ] Prüfen, ob PHP dort lesen/schreiben darf (Stichwort `open_basedir` –
      im Hoster-Panel oder beim Support nachfragen). **Wenn nein → hier stoppen
      und Hoster fragen**, sonst findet die App ihre Daten nicht.

## Schritt 1 – Backup machen (Pflicht!)

- [ ] Website kurz nicht benutzen (niemand sollte gerade etwas speichern).
- [ ] Per FTP herunterladen und lokal sicher aufheben:
  - `data/crm.db` **und**, falls vorhanden, `data/crm.db-wal` und `data/crm.db-shm`
    (die gehören zusammen!)
  - Ordner `data/bookkeeping_pdfs/`
  - Ordner `data/avatars/`
  - Datei `.env`

## Schritt 2 – Code anpassen (lässt sich von Claude erledigen)

Der Datenordner ist derzeit an drei Stellen fest eingetragen:

| Datei | Zeile | Aktuell |
|---|---|---|
| `config/config.php` | ~102 | `APP_ROOT . '/data/crm.db'` |
| `api/bookkeeping.php` | ~18 | `APP_ROOT . '/data/bookkeeping_pdfs'` |
| `api/profile.php` | ~23 | `APP_ROOT . '/data/avatars'` |

Plan:

1. In `config/config.php` eine neue Einstellung **`DATA_DIR`** einführen, die aus
   der `.env` gelesen wird. Ist sie leer, gilt wie bisher `APP_ROOT . '/data'`
   → nichts geht kaputt, solange man sie nicht setzt.
2. Die drei Stellen oben auf `DATA_DIR` umstellen.
3. `.env` wird derzeit aus `APP_ROOT . '/.env'` geladen (`config/config.php`, Zeile ~34).
   Zusätzlich erlauben, sie **eine Ebene höher** zu suchen
   (z. B. `dirname(APP_ROOT) . '/crm-private/.env'`), damit auch das Passwort
   aus dem Webordner raus kann.
4. `SECURITY.md` und `.env.example` um die neue Einstellung ergänzen.

→ Einfach Claude sagen: *„Setz bitte `db_migration_to_do.md` Schritt 2 um.“*

## Schritt 3 – Neuen Code hochladen (noch ohne Umzug)

- [ ] Geänderte Dateien hochladen, `DATA_DIR` **noch nicht** setzen.
- [ ] Einloggen, kurz durchklicken → alles muss wie vorher laufen.
      (Damit weißt du: der Code selbst ist ok.)

## Schritt 4 – Daten umziehen

- [ ] Neuen Ordner anlegen, z. B. `/home/USER/crm-private/data/`
- [ ] Rechte setzen: Ordner `700`, Dateien `600` (im FTP-Programm: „Dateiberechtigungen“).
- [ ] Hineinverschieben (nicht kopieren, damit keine alte Kopie zurückbleibt):
  - `crm.db` (+ `-wal` / `-shm`, falls vorhanden)
  - `bookkeeping_pdfs/`
  - `avatars/`
- [ ] `.env` nach `/home/USER/crm-private/.env` verschieben.
- [ ] In der `.env` eintragen:
  ```
  DATA_DIR=/home/USER/crm-private/data
  ```

## Schritt 5 – Testen

- [ ] Einloggen (Owner **und** ein normaler Benutzer mit Code per Mail).
- [ ] Kontakte sind da, Suche funktioniert.
- [ ] Ein Rechnungs-PDF in der Buchhaltung öffnen.
- [ ] Profilbild wird angezeigt.
- [ ] Einen Test-Kontakt anlegen und wieder löschen (prüft Schreibrechte).

**Wenn etwas nicht geht:** `DATA_DIR`-Zeile aus der `.env` löschen und das
Backup aus Schritt 1 wieder nach `data/` im Webordner legen → alter Zustand.

## Schritt 6 – Aufräumen & prüfen

- [ ] Im Webordner darf **kein** `data/crm.db` und **keine** `.env` mehr liegen.
- [ ] Diese Adressen im Browser aufrufen – überall muss **403 oder 404** kommen:
  ```
  https://network.disinfocombat.eu/.env
  https://network.disinfocombat.eu/data/crm.db
  https://network.disinfocombat.eu/data/bookkeeping_pdfs/
  https://network.disinfocombat.eu/.git/config
  https://network.disinfocombat.eu/config/config.php
  ```
- [ ] Liegt im Webordner ein `.git`-Ordner? → löschen.

## Schritt 7 – Backups einrichten (gleich mit erledigen)

Im Code gibt es keine automatische Sicherung.

- [ ] Beim Hoster nachsehen: Gibt es tägliche Backups? Umfassen sie auch den
      neuen Ordner `crm-private/`?
- [ ] Zusätzlich z. B. einmal pro Woche `crm.db` + PDFs herunterladen und
      verschlüsselt ablegen.
- [ ] Einmal ausprobieren, ob sich ein Backup wirklich wiederherstellen lässt.

---

## Falls der Hoster keinen Ordner außerhalb des Webordners erlaubt

Dann bleibt alles, wo es ist. Der aktuelle Schutz (`.htaccess` doppelt, PHP im
`data/`-Ordner abgeschaltet) ist ordentlich. Wichtig ist dann nur:

- Schritt 6 (Adressen prüfen) nach **jedem** Hoster-Update wiederholen.
- Schritt 7 (Backups) trotzdem umsetzen.
