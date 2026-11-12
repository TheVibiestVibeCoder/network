# Teamkalender, Phase 1: Lesen und Teamansicht

Stand 12.11.2026, Branch `calendar-integration`. Spezifikation: [kalender-spec.md](kalender-spec.md), Machbarkeitstests: [kalender-phase0.md](kalender-phase0.md).

Phase 1 liest nur. Nichts im CRM schreibt bisher in die Kalender auf dem Mailserver. Anlegen und Bearbeiten folgen in Phase 2.

## Was gebaut ist

- **Sync** (`includes/CalendarSync.php`, `cli/calendar-sync.php`):
  - Läuft per Cron alle 5 Minuten und zusätzlich beim Öffnen des Kalenders, dort höchstens alle 30 Sekunden.
  - Je Kalender prüft er zuerst den CTag. Nur bei einer Änderung holt er die ETag-Liste, lädt Geändertes per `calendar-multiget` und übernimmt Löschungen.
  - Was sich in einem Lauf geändert hat, prüft der nächste Lauf noch einmal inhaltlich, weil die ETags des Servers nur sekundengenau sind.
  - Ein Lock verhindert überlappende Läufe. Protokolliert werden nur Kalender-IDs und HTTP-Status, nie Termininhalte.
- **Discovery:**
  - Freigaben an kalender@ werden beim ersten Lauf und danach täglich automatisch erkannt.
  - Neu freigegebene Kalender erscheinen von selbst, mit Arbeitskalender = „Details“ und Privat-Kalender = „Private“.
  - Wird eine Freigabe zurückgezogen, verschwinden die zwischengespeicherten Termine dieses Kalenders.
- **Termine lesen** (`includes/CalendarIcs.php`, mit `sabre/vobject`):
  - Serien werden aufgelöst, einschließlich Ausnahmen (EXDATE) und verschobener Einzeltermine (RECURRENCE-ID).
  - Gespeichert wird in UTC, ganztägige Termine als reines Datum, Zeiten ohne Zone gelten als Europe/Vienna.
  - Zeitfenster: 12 Monate zurück und 12 Monate voraus. Was länger als 12 Monate vorbei ist, verliert im Cache seinen Inhalt.
- **Datenschutz** (`includes/CalendarView.php`), serverseitig vor jeder Ausgabe:
  - Bei „Private“ geht nur der Zeitraum raus, ohne Titel, Ort, Beschreibung, Link oder Teilnehmer. (Bis 12.11.2026 gab es daneben „Busy“, das genauso wenig zeigte. Livio hat es gestrichen.)
  - `CLASS:PRIVATE`/`CONFIDENTIAL` gilt immer als privat.
  - Eigene Kalender sieht man vollständig.
  - Verdeckte Kopien werden nie über die UID zusammengeführt, das würde zeigen, wer mit wem einen Termin hat.
- **Rechte:**
  - „Kalender: sehen“ und „Kalender: bearbeiten“ vergibst du im Users-Panel pro Person. Admins haben anfangs beide.
  - Ohne Recht gibt es keinen Menüpunkt, kein Panel und kein API-Zugriff (403).
- **Teamansicht** (`assets/js/team-calendar.js`, `assets/css/team-calendar.css`), seit 12.11.2026 mit einer Spalte pro Tag (siehe Abweichungen):
  - Die Woche ist die Hauptansicht, der einzelne Tag die Detailansicht. Am Handy startet der Kalender mit dem Tag. Ein Klick auf einen Wochentag öffnet ihn.
  - Jeder Termin zeigt die CRM-Profilbilder der beteiligten Teammitglieder. Wer kein Profilbild hat, erscheint mit Initialen in seiner Farbe.
  - Termine, an denen die angemeldete Person teilnimmt, sind in Akzentblau #30599D gefüllt, egal ob allein oder mit anderen. Die übrigen sind hell, „Private“ grau schraffiert.
  - Gemeinsame Termine (gleiche UID in mehreren Kalendern) erscheinen einmal, mit allen Gesichtern, Zahl der externen Gäste und Video-Symbol.
  - Ganztägige und mehrtägige Termine laufen als Balken über die Tage.
  - Überschneidungen stehen nebeneinander. Ist eine Karte zu schmal, entfällt die Uhrzeit vor dem Titel.
  - Personen lassen sich oben ein- und ausblenden.
  - Die Detailansicht zeigt den Zusage-Status je Person und bei Videocalls einen Button „Join video call“.
  - Neben dem Datum steht, wann zuletzt synchronisiert wurde, mit einem Knopf zum Sofort-Sync.
- **Freien Termin finden:**
  - Personen, Dauer und Zeitraum wählen, die gemeinsamen Lücken innerhalb der Arbeitszeit (Standard Mo–Fr 08:00–18:00) erscheinen als Liste und grün markiert in den Tagesspalten.
  - Alle Kalender zählen, auch private, angezeigt werden aber nur die Lücken.
- **Einstellungen** (Zahnrad in der Kalenderansicht):
  - Admins stellen pro Kalender ein, was andere sehen, welcher Typ er ist und ob er im CRM erscheint.
  - Pro Person legen Admins Farbe, Reihenfolge und zugehöriges CRM-Konto fest, außerdem die Arbeitszeit.
  - Kalender-Eigentümer stellen ein, was andere von ihren eigenen Kalendern sehen.
- **Log:** Der frühere Aktivitäts-„Kalender“ ist jetzt das Log im Profilmenü, nur für Admins. Die Daten sind unverändert (`api/log.php`).

## Live schalten auf dem Server

1. **Code deployen** inklusive `vendor/`. Neu sind `sabre/vobject` 4.6.1, `sabre/xml` und `sabre/uri`. Der Server braucht PHP ≥ 8.0 mit curl, dom und mbstring.
2. **In der `.env` auf dem Server** diese vier Zeilen ergänzen, das Passwort wie in der lokalen `.env`:

   ```
   CALDAV_BASE_URL=https://mail.disinfoconsulting.eu:2080
   CALENDAR_ACCOUNT=kalender@disinfoconsulting.eu
   CALENDAR_ACCOUNT_PASSWORD=…
   CALENDAR_MAIL_HOST=mail.disinfoconsulting.eu
   ```

   Weitere Optionen mit Standardwerten stehen in `.env.example`.
3. **Einmal von Hand ausführen** (cPanel → Terminal, im Ordner des CRM): `php cli/calendar-sync.php --discover`
   - Das Skript meldet sich als kalender@ am Mailserver an, trägt die freigegebenen Kalender ein und lädt ihre Termine zum ersten Mal.
   - Es zeigt sofort, ob Zugang und Passwort stimmen. Ohne diesen Schritt macht der erste Cron-Lauf dasselbe, nur ohne Ausgabe.
   - `php -v` zeigt vorher, ob die Kommandozeile PHP 8 nutzt. cPanel kann dort eine andere Version haben als die Webseite.
4. **Cron einrichten** (cPanel → Cron Jobs, alle 5 Minuten):

   ```
   */5 * * * * /usr/local/bin/php /home/<cpanel-user>/<pfad>/cli/calendar-sync.php --quiet >/dev/null 2>&1
   ```

   Ein Problem zeigt die Kalenderansicht als „Last sync had a problem“ an. Ohne `>/dev/null 2>&1` schickt cPanel bei jedem Fehler eine Mail.
5. **Freigaben:** Markus und Vivian geben ihre Kalender für kalender@ frei, den Arbeitskalender zum Lesen und Schreiben, den privaten nur zum Lesen.
   - Das CRM findet sie innerhalb eines Tages, sofort über „Look for new calendars now“ in den Einstellungen.
   - Die Freigabe passiert auf dem Mailserver, nicht im CRM. Sie gilt damit für das Live-CRM und für die lokale Kopie zugleich.
   - Lokal danach `php dev/seed-calendar-demo.php` noch einmal ausführen. Dann verschwinden die Testkalender der beiden.
6. **Zuordnung prüfen:** In den Einstellungen unter „People“ kontrollieren, ob jede Person ihrem CRM-Konto zugeordnet ist. Die Zuordnung läuft automatisch über die Mailadresse.

## Lokale Simulation mit drei Personen

`php dev/seed-calendar-demo.php` gibt jedem Teammitglied, das noch keine Kalender freigegeben hat, einen erfundenen Arbeits- und Privat-Kalender. Das Skript liegt in `dev/` und kommt deshalb nicht ins Git.

- **Inhalt:** Termine rund um die aktuelle Woche: Serien, gemeinsame Termine mit Gästen und Videolinks, ganz- und mehrtägige Termine, private Termine, freie Zeit und Überschneidungen.
- **Echte Kalender** bleiben unverändert. Ein erneuter Lauf schiebt die Termine in die aktuelle Woche.
- **Speicherung:**
  - Die Termine laufen durch den echten Sync und werden wie echte gespeichert.
  - Die Testkalender haben `demo:`-Adressen. Sync und Cron lassen sie in Ruhe (`CalDavSource::serves()`).
- **Optionen:**
  - `--offline` arbeitet ohne Mailserver.
  - `--remove` nimmt alles wieder heraus.
- **Echte Freigaben:** Hat jemand seine echten Kalender freigegeben, entfernt der nächste Lauf dessen Testkalender von selbst.
- **Lokaler Stand:** Seit 12.11.2026 simuliert die lokale Datenbank Markus und Vivian. Livios Person ist lokal mit dem Konto „Test Admin“ verknüpft, damit seine Termine hervorgehoben sind.

## Tests

- `php tests/calendar.test.php`: 65 Prüfungen gegen eine Wegwerf-Datenbank und einen simulierten Kalenderserver. Abgedeckt sind:
  - Parsing, Serien mit Ausnahmen und Verschiebungen, Sommerzeitwechsel (28.3.2027)
  - Ganztägiges, DURATION, Zeiten ohne Zone
  - Aufbewahrung, Änderungserkennung, Lock
  - alle Datenschutzregeln, zusammengeführte gemeinsame Termine, Lückensuche
  - „eigene“ Termine und Profilbilder, Testkalender, die der Sync in Ruhe lässt
  - Einstellungen und Rechte
- **Im Browser** (Headless Chrome, Kopie der App mit drei Personen und Testkalendern, 41 Prüfungen):
  - als Livio (Admin) und als Markus (Member), dazu am Handy
  - Spalte pro Tag, ausgerichtete Spalten, Hervorhebung eigener Termine, Profilbilder und Initialen, Balken für mehrtägige Termine, Ein- und Ausblenden von Personen, Details, Lückensuche, Einstellungen, Dark Mode
  - Verborgene Titel kommen weder im Seitenquelltext noch in einer API-Antwort vor.
  - Die Phase-1-Prüfungen vom 11.11. (ohne Recht kein Kalender, API 403, Users-Panel, Log) sind unverändert.
- **Echter Sync** gegen den Mailserver mit Livios beiden Kalendern läuft fehlerfrei.

## Abnahme (Spec, Phase 1)

| Kriterium | Stand |
|---|---|
| Am iPhone angelegt, geändert oder gelöscht: nach spätestens 5 Minuten im CRM | Am 12.11. von Livio lokal bestätigt: zwei Termine (privat und öffentlich) angelegt und verschoben, beides kam im CRM an. Löschen ist automatisiert getestet, am iPhone noch kurz prüfen. Auf dem Server sorgt der Cron für die 5 Minuten |
| „Private“ nur Zeitraum und Aufschrift, auch nicht im Quelltext oder in API-Antworten | Getestet (Unit- und Browsertest) |
| Serien und Sommerzeitwechsel stimmen | Getestet |
| Ohne Recht kein Kalender sichtbar | Getestet |

## Abweichungen und Entscheidungen

- **Spalte pro Tag statt Spalte pro Person** (Livios Entscheidung vom 12.11.2026). Die Spec (Abschnitt 3) sah vor:
  - eine Spalte „Gemeinsam“ und eine Spalte pro Person
  - Karten über alle Spalten und schraffierte Platzhalter
  - gemeinsame Termine in #1C3258

  Jetzt gilt:
  - eine Spalte pro Tag
  - Profilbilder am Termin zeigen, wer beteiligt ist
  - eigene Termine in Akzentblau #30599D, die der anderen hell

  Die Wochenansicht ist damit die Hauptansicht.
- **Englische Beschriftung:** „Private“ usw. wie im Rest des CRM. Die Spec nennt die deutschen Begriffe, auf Wunsch lässt sich das schnell umstellen.
- **Verdeckte Kopie bei sichtbarem Termin:** Sieht man einen gemeinsamen Termin über eine Kopie vollständig, erscheint die verdeckte Kopie derselben Person nicht zusätzlich als „Private“.
- **Owner-Login:** Wer sich mit dem Owner-Passwort (APP_PASSWORD) anmeldet, gehört zu keinem Kalender und hat deshalb keine „eigenen“ Termine. Hervorgehoben wird für CRM-Konten, die in den Einstellungen unter „People“ einer Person zugeordnet sind.
- **Monatsansicht:** nicht gebaut, laut Spec optional.
- **Nebenbefund:** Das bestehende `phpoffice/phpspreadsheet` 1.30.6 hat drei Sicherheitshinweise (`composer audit`). Ein Update ist ein eigenes Thema, weil es Import und Export betrifft.

## Offen für die nächsten Phasen

- **T3 aus Phase 0:** wartet auf die Freigaben von Markus und Vivian. Das Ergebnis entscheidet, ob interne Teilnehmer in Phase 2 als ATTENDEE gespeichert werden.
- **Phase 2:** umgesetzt, siehe [kalender-phase2.md](kalender-phase2.md). Geplant war:
  - Termine im CRM anlegen, verschieben und absagen, im selben Formular wie überall im CRM.
  - Ein Klick auf eine freie Zeit im Raster oder eine gefundene Lücke legt dort einen Termin an.
  - Konfliktprüfung im CRM, weil der Server kein If-Match kennt.
  - Kopien für interne Teilnehmer, Zusagen im CRM.
  - Verknüpfung mit Kontakten und Projekten.
- **Phase 3:** Für die MCP-Tools brauche ich Zugriff auf das Repo des MCP-Servers. Die Lückensuche und der Datenschutzfilter sind schon so gebaut, dass der MCP sie nutzen kann.
