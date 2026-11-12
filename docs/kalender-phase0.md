# Teamkalender, Phase 0: Ergebnisse der Machbarkeitstests

Stand 11.11.2026. Getestet mit `cli/caldav-probe.php` gegen `https://mail.disinfoconsulting.eu:2080` (cPanel 138, cpdavd) als `kalender@disinfoconsulting.eu`. Spezifikation: [kalender-spec.md](kalender-spec.md).

## Kurzfassung

| # | Test | Ergebnis |
|---|---|---|
| 1 | Freigaben finden, sync-collection, CTag | ✓ Freigaben erscheinen in der Home von kalender@ · ✗ kein sync-collection · ✓ CTag · Markus und Vivian haben noch nicht freigegeben |
| 2 | Schreiben, ändern, löschen in Livios Arbeitskalender | ✓ alles korrekt am iPhone · ✗ der Server ignoriert `If-Match` und `If-None-Match` |
| 3 | Interner Teilnehmer, Kopie beim Kollegen | **offen**, wartet auf die Freigaben von Markus und Vivian |
| 4 | Externer Teilnehmer mit `SCHEDULE-AGENT=CLIENT` | Anlegen über kalender@ verschickt nichts. Verschiebt der Organisator den Termin am iPhone, schickt der Server seine eigene Einladung an Externe, `SCHEDULE-AGENT=CLIENT` am Teilnehmer verhindert das nicht. Am Organisator gesetzt, speichert das iPhone keine Änderungen mehr. |
| 5 | Mail im Namen von livio@ | ✓ Exim nimmt an, Gmail: SPF, DKIM, DMARC = PASS, Posteingang |
| 6 | Plus-Adressierung | ✓ wird zugestellt · cPanel legt pro Suffix automatisch einen Ordner an |

## Empfehlungen zur Entscheidung

1. **Externe nach Ansatz 2.** Externe nicht als `ATTENDEE` in CalDAV speichern, nur in `external_invitations`, und im Beschreibungstext auflisten. Mit Ansatz 1 löst jede spätere Änderung am iPhone die unbrauchbare Server-Einladung an alle Externen aus (T4).
2. **Antworten von Externen nach Option a** (Plus-Adresse), Begründung unten.
3. **Konflikte erkennt das CRM selbst.** Der Server liefert nie 412. Vor jedem PUT und DELETE den aktuellen ETag lesen und mit dem vergleichen, auf dem die Bearbeitung beruht. Weicht er ab, nicht schreiben, neu laden und den Konflikt anzeigen. Neue Termine bekommen einen UUID-Pfad, vorher kurz prüfen, dass er frei ist (GET → 404).
4. **Sync über CTag und ETag-Liste** (der Fallback der Spec). Siehe T1.
5. **Bestehende Termine bearbeiten, nicht neu erzeugen.** Beim Ändern das vorhandene ICS mit sabre/vobject bearbeiten und alles Unbekannte erhalten. Das iPhone schreibt eigene Zeitzonendefinitionen, `EMAIL=`-Parameter und Standard-Erinnerungen (`VALARM`, `X-APPLE-DEFAULT-ALARM`) hinein.
6. **Nie `SCHEDULE-AGENT` am `ORGANIZER`.** Bei Teilnehmern ist der Parameter unschädlich (das iPhone behält ihn), verhindert aber keine Server-Mails.
7. **Versand in Phase 4 per SMTP-Login von kalender@** (Port 465), nicht per PHP `mail()`. From = Organisator mit Name und Adresse, Envelope (Return-Path) = kalender@, damit Bounces im CRM-Postfach landen.

## Option a oder b: Empfehlung a

- **a ist durchgetestet.** Mails an `kalender+…@` kommen an. `Delivered-To` und `Envelope-To` enthalten die volle Adresse samt Token. Die Antwort von Gmail ist ein sauberes `METHOD:REPLY` mit UID, Teilnehmeradresse und `PARTSTAT` und lässt sich eindeutig zuordnen. Ein Token pro Empfänger verhindert zusätzlich, dass jemand Zusagen für andere fälscht.
- **Normale Antworten gehen weiter an dich.** Bei einer Antwort über „Antworten“ statt über die Zusage-Buttons nutzt das Mailprogramm die From-Adresse, also livio@. Nur Zusagen und Absagen gehen an die Plus-Adresse.
- **b ist nicht verlässlich.** In der Antwort steckt der Kalenderteil verschachtelt hinter Text- und HTML-Teil, zusätzlich als `invite.ics`. cPanel-Filter sehen nur die obersten Header und den Anfang des Textes. Der Betreff hängt von der Sprache des Antwortenden ab (Gmail: „Accepted: …“, „Declined: …“). Außerdem bräuchte jedes persönliche Postfach einen eigenen Filter.
- **Nachteil von a:** Als Organisator steht „Livio Zalozieckyj <kalender+…@disinfoconsulting.eu>“ in der Einladung. Der Name stimmt, die Adresse ist in den Details sichtbar.
- **Voraussetzung:** In cPanel unter Email Accounts → kalender@ → Manage die Option „Automatically Create Folders for Plus Addressing“ abschalten, sonst entsteht pro Einladung ein Ordner (T6).

## Details

### T1: Discovery, sync-collection, CTag

- **Principal und Home:** Der Principal ist `/principals/kalender@disinfoconsulting.eu/`, die Calendar-Home `/calendars/kalender@disinfoconsulting.eu/`. Schedule-Inbox und -Outbox sind vorhanden.
- **Freigaben:** Sie erscheinen direkt in der Home von kalender@, mit den Original-URLs der Eigentümer (resourcetype `shared-owner`). Die Kalenderquellen lassen sich also automatisch finden.
- **Livio:** `/calendars/livio@disinfoconsulting.eu/calendar/` („Public“) ist lesbar und schreibbar, `/calendars/livio@disinfoconsulting.eu/calendar-f410890c-1fbe-4496-be7d-54da947cd005/` („Private“) nur lesbar. Das passt zur Spec.
- **Markus und Vivian:** kalender@ sieht nur deren Schedule-Inbox, keinen Kalender. Die Freigaben fehlen noch, deshalb ließen sich ihre Pfade nicht ermitteln.
- **sync-collection (RFC 6578) wird nicht unterstützt.** Es gibt keinen sync-token, der REPORT liefert eine leere Antwort.
- **CTag funktioniert.** Er ändert sich beim Anlegen, Ändern und Löschen.
- **Der Fallback funktioniert:** PROPFIND Depth 1 mit `getetag`, `calendar-query` mit Zeitraum und `calendar-multiget`.
- **ETag:** Er ist die Änderungszeit der Datei in Sekunden, ohne Anführungszeichen (z. B. `1794429086`). Zwei Änderungen in derselben Sekunde ergeben denselben ETag. Für den Sync heißt das: Objekte, die sich in einem Lauf geändert haben, im nächsten Lauf noch einmal inhaltlich prüfen (Hash vergleichen).

**Sync-Vorschlag:** Ein Cron-Lauf alle 5 Minuten prüft je Kalender den CTag. Nur wenn er sich geändert hat, holt er die ETag-Liste und vergleicht sie mit dem Cache. Geänderte Termine lädt er per `calendar-multiget`, fehlende übernimmt er als gelöscht.

### T2: Schreiben, ändern, löschen über kalender@

- **Am iPhone korrekt:** Anlegen (PUT), Verschieben und Umbenennen sowie Löschen kamen jeweils richtig an, inklusive Umlauten und Uhrzeit in Europe/Vienna.
- **Server speichert unverändert:** Das ICS liegt Zeile für Zeile so auf dem Server, wie es geschickt wurde.
- **Bedingte Requests wirken nicht:**
  - PUT mit `If-None-Match: *` auf einen bestehenden Termin → 201, überschrieben.
  - PUT mit falschem `If-Match`, gequotet oder ungequotet → 201, überschrieben.
  - DELETE mit falschem `If-Match` → 204, gelöscht.

  Der Server wertet bedingte Requests nicht aus, daher Empfehlung 3.

### T3: Interner Teilnehmer, Kopie beim Kollegen

Nicht durchgeführt, weil Markus und Vivian ihre Kalender noch nicht für kalender@ freigegeben haben. Das Skript ist vorbereitet (`t3:create --colleague=…`). Nach T4 setzt es `SCHEDULE-AGENT=CLIENT` nur noch bei Teilnehmern. Am Organisator könnte die Kollegin oder der Kollege am iPhone womöglich nicht mehr zu- oder absagen.

Zusätzlich zu prüfen:

1. Kommt eine Zusage am iPhone in der Kopie an?
2. Verschiebt der Organisator das Original am iPhone, schickt der Server dann der Kollegin oder dem Kollegen seine einfache Mail? Nach T4 ist das zu erwarten.

Davon hängt ab, ob interne Teilnehmer als `ATTENDEE` gespeichert werden. Dann zeigt das iPhone sie an und man kann dort zusagen, es kommen aber eventuell Server-Mails. Die Alternative ist, sie nur im CRM zu führen.

### T4: Externer Teilnehmer

Ablauf: Drei Termine mit livio.zalo@gmail.com als Teilnehmer wurden über kalender@ angelegt, danach am iPhone um 15 Minuten verschoben und zuletzt über kalender@ gelöscht.

| `SCHEDULE-AGENT=CLIENT` | Anlegen (kalender@) | Verschieben am iPhone (Livio) | Löschen (kalender@) |
|---|---|---|---|
| an Organisator und Teilnehmern (T4) | keine Mail | Änderung erreicht den Server nie, das iPhone meldet keinen Fehler | keine Mail |
| nur an Teilnehmern (T4C) | keine Mail | Server verschickt seine Einladung (englisch, .ics nur als Anhang), mit der neuen Uhrzeit | keine Absage |
| ohne (T4B) | keine Mail | ebenso | keine Absage |

- **Wann der Server verschickt:** nur, wenn der Organisator selbst schreibt (sein iPhone), nicht wenn kalender@ schreibt. `SCHEDULE-AGENT=CLIENT` am Teilnehmer ignoriert er. Updates nach der ersten Mail und Absagen verschickt er nicht.
- **Lokale Adressen als Teilnehmer:** An die Plus-Adresse des Testpostfachs ging nie etwas, auch nicht bei Änderungen am iPhone. Adressen auf der eigenen Domain sind daher kein Ersatz für echte Externe. Die Kontrollprobe C0, die nur lokale Teilnehmer hatte, war aus diesem Grund nicht aussagekräftig.
- **Folge für Phase 4:** Ändert der Organisator einen Termin mit Externen am iPhone, erfahren die Externen davon bei Ansatz 2 nichts automatisch. Der Sync muss solche Änderungen (Zeit, Ort, Löschung) erkennen und im CRM das Verschicken eines Updates bzw. einer Absage anbieten, mit der Bestätigung, die die Spec ohnehin verlangt.

### T5: Mail im Namen von livio@

- **Versandweg:** SMTP-Login als kalender@ auf Port 465, `From: Livio Zalozieckyj <livio@disinfoconsulting.eu>`. Exim nimmt die Mail an, sowohl mit Envelope kalender@ als auch mit Envelope livio@.
- **Ergebnis bei Gmail:** SPF, DKIM und DMARC sind jeweils PASS, beide Mails landen im Posteingang.
- **DNS:**
  - SPF erlaubt 185.221.63.17 und `relay.zumedns.com`.
  - DKIM-Selector `default` ist vorhanden, Reverse-DNS passt (`web2.bhx.zumedns.com`).
  - DMARC steht auf `p=none`. Nebenbefund: Gefälschte Mails „von @disinfoconsulting.eu“ werden damit nirgends abgewiesen. Ein späterer Schritt auf `quarantine` mit Reports wäre ein eigenes Thema.

### T6: Plus-Adressierung

- **Zustellung:** `kalender+p0test@disinfoconsulting.eu` kommt an. `Delivered-To` und `Envelope-To` enthalten die volle Adresse.
- **Ordner:** cPanel hat dafür automatisch den Ordner `INBOX.p0test` angelegt und die Mail dort abgelegt.

## Offene Punkte

- **Freigaben:** Markus und Vivian geben ihre Kalender für kalender@ frei (Public lesen und schreiben, Private nur lesen). Danach folgt T3 mit einer der beiden Personen.
- **Entscheidungen von Livio:**
  - Ansatz 2 für Externe
  - Option a für Antworten
  - Konflikterkennung im CRM
- **cPanel-Einstellungen:** Bei Option a das automatische Anlegen von Ordnern für Plus-Adressen bei kalender@ abschalten. Den Testordner `INBOX.p0test` löschen.
- **Phase 3:** Zugriff auf das Repo des MCP-Servers.

## Testwerkzeug

`php cli/caldav-probe.php help` zeigt alle Schritte.

- **Was es ausgibt:** Von echten Terminen nur Anzahlen, Rechte und Fähigkeiten, nie Inhalte.
- **Wo es seine Testobjekte merkt:** in `data/caldav-probe.json` (gitignored). `cleanup` löscht alle Testtermine wieder.
- **Stand:** Alle Testtermine aus diesem Lauf sind gelöscht.
