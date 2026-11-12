# Spezifikation: Teamkalender im Disinfo CRM

Diese Spezifikation beschreibt die Kalenderintegration für das Disinfo CRM (Repo „network“). Passe alles an die bestehende Architektur, den Code-Stil und das Vorschlagsmuster des CRM-MCP an. Wo diese Spezifikation und der bestehende Code kollidieren, frag nach, statt zu raten.

## 1. Ziel, Kontext und Projektdaten

Das CRM bekommt einen Teamkalender für 3–4 Personen. Jede Person hat ihren Kalender auf dem CalDAV-Server von cPanel und nutzt ihn am iPhone. Das CRM zeigt alle Kalender zentral, mit Verfügbarkeiten, und erlaubt Termine anzulegen, auch über den CRM-MCP. Externe werden per Mail eingeladen, optional mit Google-Meet-Link.

Kontext: Das CRM läuft auf demselben cPanel-Server wie Mail und Kalender. Der Kalenderserver ist der cPanel-eigene CalDAV-Dienst (cpdavd).

### Projektdaten (von Livio auszufüllen)

| Feld | Wert |
| --- | --- |
| cPanel-Version | 138.0 (build 21) |
| CalDAV-Server-URL (inkl. Port) | Server: https://mail.disinfoconsulting.eu:2080. Beispiel Livio: https://mail.disinfoconsulting.eu:2080/calendars/livio@disinfoconsulting.eu/calendar (Kalender „Public“) und https://mail.disinfoconsulting.eu:2080/calendars/livio@disinfoconsulting.eu/calendar-f410890c-1fbe-4496-be7d-54da947cd005 (Kalender „Private“) |
| Pfade der freigegebenen Kalender (aus „Shared Collections“) | Livio: /calendars/livio@disinfoconsulting.eu/calendar (Public) und /calendars/livio@disinfoconsulting.eu/calendar-f410890c-1fbe-4496-be7d-54da947cd005 (Private). Markus und Vivian: gleiches Muster mit eigener ID; in Phase 0 per Discovery über kalender@ ermitteln und Livio zur Bestätigung vorlegen. |
| Freigabekonto | kalender@disinfoconsulting.eu (Passwort nur in der Server-Konfiguration) |
| Team: CRM-User ↔ Mailadresse | Livio ↔ livio@disinfoconsulting.eu; Markus ↔ markus@disinfoconsulting.eu; Vivian ↔ vivian@disinfoconsulting.eu; ggf. 4. Person |
| Kalender pro Person | „Public“ = Arbeitskalender (Standardkalender, Freigabe an kalender@ lesen und schreiben); „Private“ = Privat-Kalender (Freigabe nur lesen). Diese Spezifikation nennt sie „Arbeitskalender“ und „Privat-Kalender“. |
| Ergebnis interner Einladungstest | Der Termin kam beim Kollegen nur als die einfache Server-Mail an, nicht in seinem Kalender. Zusagen war nicht möglich. Der Server verteilt intern also nicht, es gilt die Umsetzung in Abschnitt 4. |
| CRM-Webadresse (für Google-OAuth) | https://network.disinfocombat.eu |
| Zeitzone | Europe/Vienna |

### Bekannte Testergebnisse

- Der Server verschickt bei Terminen, die am iPhone mit externen Teilnehmer:innen angelegt werden, selbst eine Einladungsmail. Diese kommt vom Organisator, ist aber englisch, enthält Platzhalter wie „Location: ?“ und hängt die .ics nur als Datei an. Mail-Programme zeigen deshalb keine Zusage-Buttons. Für CRM-Termine ist sie nicht verwendbar. Interne Teilnehmer:innen bekommen ebenfalls nur diese Mail: Der Termin landet nicht in ihrem Kalender, eine Zusage ist nicht möglich.
- cPanel erlaubt Freigaben pro Kalender an andere Mailkonten desselben cPanel-Kontos, nur lesend oder mit Bearbeiten. Laut cPanel-Doku kann in geteilten Kalendern nur einladen, wer den Termin erstellt hat.
- cPanel kennt keine App-Passwörter. Deshalb speichert das CRM nur die Zugangsdaten von kalender@, nie die persönlichen Mailpasswörter.

## 2. Architektur, Sync und Datenmodell

Grundprinzip: Der CalDAV-Server ist die einzige Datenquelle. Das CRM ist ein CalDAV-Client mit lokalem Cache und hält keine eigenen Kalender-Stammdaten.

### Zugriff

- Ausschließlich über kalender@ (HTTPS, Basic Auth).
- Discovery per PROPFIND auf Principal und Calendar-Home von kalender@. Tauchen die geteilten Kalender dort nicht auf, die direkten Collection-URLs der Eigentümer verwenden (Pfade aus den Projektdaten).
- Kalenderquellen in einer Tabelle konfigurierbar machen: Eigentümer, URL, Typ (Arbeit oder Privat), schreibbar ja/nein.
- Bibliotheken passend zum Stack, nichts selbst parsen. Beispiele: Node `tsdav` + `ical.js`; Python `caldav` + `icalendar` + `recurring-ical-events`; PHP `sabre/dav` + `sabre/vobject`.

### Sync

- Ein Sync-Script, das per cPanel-Cron alle 5 Minuten läuft. Keine Timer in der App, weil cPanel Apps bei Inaktivität pausieren kann.
- Pro Kalender erst sync-token (RFC 6578, sync-collection) bzw. CTag prüfen. Nur geänderte Objekte laden, Löschungen übernehmen. Fallback: ETag-Vergleich aller Objekte.
- Lock gegen überlappende Läufe.
- Zusätzlich ein Sync beim Öffnen der Kalenderansicht, höchstens alle 30 Sekunden.
- Im UI anzeigen, wann zuletzt synchronisiert wurde. Fehler loggen, ohne Termininhalte.

### Schreiben

- Neu: PUT mit `If-None-Match: *`. Änderung: PUT mit `If-Match: <etag>`. Löschen: DELETE mit `If-Match`.
- Bei 412 (Konflikt) nichts überschreiben: neu laden und im UI auf den Konflikt hinweisen.
- UID als neue UUID. SEQUENCE bei inhaltlichen Änderungen erhöhen, DTSTAMP und LAST-MODIFIED setzen.

### Zeit und Serien

- Intern UTC speichern, anzeigen in Europe/Vienna. Beim Schreiben TZID=Europe/Vienna mit VTIMEZONE; ganztägige Termine als DATE.
- Serien korrekt expandieren (RRULE, EXDATE, RECURRENCE-ID), z. B. im Fenster −3 bis +12 Monate.
- Bearbeiten von Serien im CRM: ganze Serie oder einzelnes Vorkommen. Komplexe Regeln bleiben dem iPhone überlassen.

### Datenmodell (Vorschlag, an das bestehende Schema anpassen)

| Tabelle | Inhalt |
| --- | --- |
| calendar\_sources | Eigentümer (CRM-User), URL, Typ Arbeit/Privat, schreibbar, Anzeige (Details/Beschäftigt/Privat), sync-token, CTag, zuletzt synchronisiert |
| events | Quelle, href, ETag, UID, Roh-ICS, Titel, Ort, Beschreibung, Start/Ende UTC, ganztägig, Serie ja/nein, Organisator, Teilnehmer (JSON mit PARTSTAT), Status, CLASS, SEQUENCE |
| event\_instances | expandierte Vorkommen: Termin, Start/Ende UTC, RECURRENCE-ID |
| event\_links | UID ↔ Kontakt und/oder Projekt; nur im CRM, nie in CalDAV |
| external\_invitations | UID, Adresse, PARTSTAT, zuletzt verschickte SEQUENCE, Versandzeit, Token, wer verschickt hat |
| google\_connection | OAuth-Tokens verschlüsselt (Phase 5) |

## 3. Berechtigungen, Sichtbarkeit und UI

### Berechtigungen und Sichtbarkeit

- Zwei neue CRM-Rechte: „Teamkalender sehen“ und „Teamkalender bearbeiten“. Nicht jeder CRM-User bekommt sie.
- Admin-Einstellungsseite: Zuordnung CRM-User ↔ Mailadresse ↔ Kalenderquellen.
- Anzeige pro Kalender einstellbar, durch den Eigentümer oder einen Admin: „Details“, „Beschäftigt“ (nur Zeitraum, Titel „Beschäftigt“) oder „Privat“ (nur Zeitraum, Titel „Privat“). Standard: Arbeitskalender „Details“, Privat-Kalender „Privat“. Eigene Termine sieht jede Person immer mit Details.
- Bei „Beschäftigt“ und „Privat“ sehen andere nur den Zeitraum, keinen Titel, Ort, keine Beschreibung und keine Teilnehmer. Termine mit CLASS:PRIVATE oder CONFIDENTIAL werden unabhängig von der Kalendereinstellung wie „Privat“ behandelt.
- Diese Filterung passiert serverseitig. Details dürfen weder an den Browser noch über API oder MCP ausgeliefert werden.

### Teamansicht

- Tagesansicht als Hauptansicht, Wochenansicht als Übersicht; Monatsansicht optional.
- Tagesansicht: links eine schmale Spalte „Gemeinsam“, daneben eine Spalte pro Person in fester Reihenfolge und eigener Farbe. Personen lassen sich ein- und ausblenden. Die Wochenansicht folgt derselben Logik pro Tag, aber kompakt als Farbblöcke: Titel per Mouseover, ein Klick öffnet den Tag.
- Gemeinsame Termine (gleiche UID in mehreren Kalendern) erscheinen nur einmal. Nehmen alle Teammitglieder teil: eine Karte über die volle Breite aller Spalten. Nimmt nur ein Teil teil: eine Karte in der Spalte „Gemeinsam“ mit Initialen der Beteiligten, Anzahl Externer und Videolink-Symbol; in den Spalten der Beteiligten ein schraffierter Platzhalter in ihrer Farbe, der auf die Karte verweist (Klick öffnet sie). Nie eine Karte quer über nicht benachbarte Spalten. Zusage-Status pro Person in der Detailansicht.
- „Freien Termin finden“: Personen, Dauer und Zeitraum wählen, das CRM zeigt gemeinsame Lücken innerhalb der Arbeitszeit (Standard Mo–Fr 08:00–18:00, konfigurierbar). Gefundene Lücken markiert das CRM direkt im Raster. Dieselbe Logik nutzt der MCP.
- Farben aus dem Corporate Design: #1C3258 Hauptfarbe, #EEEEEE helle Flächen, #30599D Akzent und Hervorhebung, #63a375 positiv (z. B. zugesagt), #D76262 negativ (z. B. abgelehnt). Personenfarben passend dazu ableiten (Vorschlag: #30599D, #2E8A8A, #B07A2A). Gemeinsame Termine in #1C3258 mit weißer Schrift, „Privat“ und „Beschäftigt“ neutral grau.

### Termin anlegen und bearbeiten

- Felder: Titel, Start und Ende, ganztägig, Ort, Beschreibung, Organisator (= Kalender, in den geschrieben wird), interne Teilnehmer aus dem Team, externe Teilnehmer per Mailadresse mit Vorschlägen aus CRM-Kontakten, Verknüpfung mit Kontakt oder Projekt, Videolink (Google Meet ab Phase 5 oder manuell), optional Erinnerung und einfache Serien (täglich, wöchentlich, monatlich, bis Datum).
- Verschieben und Absagen nur durch den Organisator bzw. CRM-User mit Bearbeiten-Recht. Interne Teilnehmer können im CRM zu- oder absagen.

### Verknüpfung mit CRM-Daten

- Termine lassen sich mit Kontakten und Projekten verknüpfen. Das wird nur im CRM gespeichert, nicht in CalDAV.
- Kontakt- und Projektseite bekommen einen Abschnitt „Termine“ (kommende und vergangene).
- Ist eine externe Teilnehmer-Adresse als Kontakt im CRM bekannt, schlägt das CRM die Verknüpfung automatisch vor.

## 4. Gemeinsame Termine und Einladungen an Externe

### Gemeinsame Termine im Team

Entschieden: Der Server verteilt intern nicht. Beim internen Test kam beim Kollegen nur die einfache Mail an, kein Kalendereintrag und keine Zusagemöglichkeit. Deshalb übernimmt das CRM die Verteilung. Der Termin im Arbeitskalender des Organisators ist das Original, die Darstellung wird über die UID dedupliziert.

- **Kopien:** Das CRM schreibt eine Kopie mit identischer UID, ORGANIZER und Teilnehmerliste in den Arbeitskalender jeder internen Person und hält sie synchron.
- **Keine Server-Mails:** Beim Schreiben über das CRM bekommen alle ATTENDEE (intern und extern) `SCHEDULE-AGENT=CLIENT`, in Phase 0 testen. Fallback: Teilnehmer:innen nur im CRM speichern und im Beschreibungstext auflisten.
- **Zusagen:** Interne Teilnehmer:innen sagen im CRM zu oder ab. Ändert jemand den Status in seiner Kopie am iPhone, übernimmt der Sync das ins Original. Andere Änderungen an Kopien überschreibt das Original beim nächsten Sync; das wird geloggt.
- **Am iPhone angelegte Termine:** Erkennt der Sync in einem neuen Termin interne ATTENDEE, legt er die Kopien bei den Kolleg:innen automatisch an. Die einfache Server-Mail geht in diesem Fall trotzdem raus.

### Einladungen an Externe

- Die Server-eigenen Einladungsmails dürfen bei CRM-Terminen nicht rausgehen. Ansatz 1: externe ATTENDEE mit `SCHEDULE-AGENT=CLIENT` (RFC 6638), in Phase 0 testen. Ansatz 2 als Fallback: Externe nicht als ATTENDEE in CalDAV speichern, nur in external\_invitations, und im Beschreibungstext auflisten.
- Das CRM verschickt iMIP nach RFC 6047/5546, eine Mail pro Empfänger. MIME: multipart/mixed mit multipart/alternative (text/plain, text/html, `text/calendar; method=REQUEST; charset=UTF-8`) plus dieselbe .ics als Anhang (application/ics).
- iCalendar: METHOD:REQUEST, UID, SEQUENCE, DTSTAMP, ORGANIZER mit CN, ATTENDEE mit CN, ROLE=REQ-PARTICIPANT, PARTSTAT=NEEDS-ACTION und RSVP=TRUE, VTIMEZONE, Videolink in LOCATION bzw. URL.
- Änderung: SEQUENCE + 1, neue REQUEST an alle Externen. Absage: METHOD:CANCEL mit STATUS:CANCELLED. Entfernte Teilnehmer bekommen nur ein CANCEL.
- Absender: From = Organisator (Name und Adresse), Versand über den eigenen Server, sodass SPF, DKIM und DMARC bestehen. Prüfen, ob Exim das Senden im Namen des Organisators aus dem CRM erlaubt; sonst Alternative vorschlagen.
- Inhalt: Deutsch, optional Englisch pro Termin. HTML im Corporate Design mit Titel, Datum und Uhrzeit inkl. Zeitzone, Ort bzw. Button „An Videocall teilnehmen“, Beschreibung, Teilnehmern und Organisator. Leere Felder weglassen, nie Platzhalter wie „?“.
- Footer mit Firmendaten: Disinfo Consulting · Disinfo Combat GmbH · Neustiftgasse 36, 1070 Wien · FN 563690 g, Handelsgericht Wien · disinfoconsulting.eu.
- Versand nur nach ausdrücklicher Bestätigung im CRM, mit Vorschau der Mail und der Empfängerliste. Protokollieren, wer was an wen verschickt hat.
- Testmatrix: Gmail (Web und App), Outlook (Web und Desktop), Apple Mail/iCloud (iOS und macOS). Geprüft wird jeweils: Einladung erkannt, Zusage-Buttons sichtbar, Termin übernommen, Update und Absage kommen an.

### Antworten von Externen auswerten

Zusagen und Absagen gehen an die ORGANIZER-Adresse. Beide Optionen prüfen und Livio zur Entscheidung vorlegen:

| Option | Funktionsweise | Risiko |
| --- | --- | --- |
| a) Plus-Adresse | ORGANIZER in der verschickten Einladung = `kalender+<token>@disinfoconsulting.eu` mit CN des echten Organisators; die Kopie in CalDAV behält den echten Organisator. Das CRM liest das Postfach kalender@ per IMAP. | Empfänger sehen die kalender+…-Adresse als Organisator. |
| b) Mailfilter | ORGANIZER = echte Adresse; ein cPanel-Mailfilter im Postfach des Organisators kopiert Kalenderantworten an kalender@. | Der Filter erkennt Antworten eventuell nicht zuverlässig. |

Verarbeitung per Cron: Postfach lesen, text/calendar mit METHOD:REPLY parsen, über UID und Teilnehmeradresse zuordnen. PARTSTAT im CRM und im Originaltermin in CalDAV aktualisieren, verarbeitete Mails in einen Ordner „Verarbeitet“ verschieben. Gegenvorschläge (COUNTER) nur als Hinweis im CRM anzeigen.

## 5. MCP-Tools und Google Meet

### MCP-Tools (bestehender CRM-MCP-Server)

Lesende Tools liefern direkt Ergebnisse. Schreibende Tools erzeugen nur Vorschläge nach dem bestehenden Muster (wie bei den To-dos), die im CRM freigegeben werden.

| Tool | Art | Inhalt |
| --- | --- | --- |
| list\_events | lesen | Termine im Zeitraum, optional gefiltert nach Personen |
| get\_event | lesen | ein Termin per UID inkl. Teilnehmern und Verknüpfungen |
| find\_free\_slots | lesen | gemeinsame freie Zeitfenster für Personen, Dauer, Zeitraum, Arbeitszeit |
| propose\_event | Vorschlag | Titel, Zeit, Organisator, interne und externe Teilnehmer, Verknüpfung, Meet ja/nein, Beschreibung |
| propose\_event\_update | Vorschlag | Änderung eines bestehenden Termins |
| propose\_event\_cancel | Vorschlag | Absage eines Termins |

- Erst nach der Freigabe im CRM wird in CalDAV geschrieben und werden Einladungen verschickt.
- Der MCP sieht nur, was der verbundene CRM-User sieht. Termine mit Anzeige „Privat“ oder „Beschäftigt“ erscheinen auch hier nur als Zeitraum mit dieser Aufschrift.
- Zeiten im Tool-Interface als ISO 8601 mit Zeitzone, Standard Europe/Vienna.
- Tool-Beschreibungen an den Stil der bestehenden CRM-Tools anpassen.

### Google Meet (Phase 5, optional pro Termin)

- Meet REST API v2 `spaces.create`: erzeugt nur einen Raum mit Link, keinen Google-Kalendertermin und keine Einladungen. OAuth über ein kostenloses Google-Konto, Scope `https://www.googleapis.com/auth/meetings.space.created`.
- Refresh-Token verschlüsselt speichern. Die Google-App steht auf „In Produktion“ (im Testmodus verfallen Tokens nach 7 Tagen).
- `space.name` (spaces/…) speichern, nicht nur den Meeting-Code. `meetingUri` in LOCATION bzw. URL, in die Beschreibung und als Button in die Einladungsmail.
- Prüfen, ob Externe ohne Anklopfen beitreten können (spaceConfig, accessType) und ob das mit dem Gratiskonto einstellbar ist.
- Fallback: Feld für einen manuell eingefügten Videolink (Meet, Teams, Zoom).
- Ein Google-Fehler blockiert nie den Termin: Termin ohne Link anlegen und Hinweis anzeigen.

## 6. Sicherheit, Datenschutz und Nicht-Ziele

### Sicherheit und Datenschutz

- Passwort von kalender@, Google-Client-Secret und OAuth-Tokens nur in der Server-Konfiguration (z. B. `.env`) bzw. verschlüsselt in der Datenbank. Der Schlüssel liegt nicht in der Datenbank. Nichts davon ins Git-Repo, nichts davon in Logs.
- Logs enthalten nur IDs und Status, keine Titel, Beschreibungen oder Teilnehmer.
- Filterung für „Privat“ und „Beschäftigt“ serverseitig (siehe Abschnitt 3).
- Cache-Aufbewahrung: Termine, die länger als 12 Monate zurückliegen, aus dem Cache löschen (Wert konfigurierbar, Livio legt ihn final fest). Verknüpfungen mit Kontakten und Projekten bleiben.
- Vor jedem Versand an Externe eine ausdrückliche Bestätigung; Audit-Log der Einsätze.

### Nicht-Ziele

- Kein eigener Kalenderspeicher im CRM neben dem CalDAV-Server.
- Keine Synchronisation mit Google Kalender.
- Keine Raum- oder Ressourcenverwaltung.
- Keine Änderung der Server-Einladungen für Termine, die direkt am iPhone angelegt werden.

## 7. Phasen und Abnahmekriterien

Jede Phase separat umsetzen, mit Datenbankmigrationen und Tests für Parsing, Serien, Zeitzonen und iMIP-Erzeugung. Nach jeder Phase an Livio berichten und auf seine Abnahme warten.

### Phase 0: Machbarkeitstests (vor jeder Implementierung)

Tests am echten Server durchführen, Ergebnisse dokumentieren und Entscheidungen Livio vorlegen:

1. Mit kalender@ per PROPFIND die freigegebenen Kalender finden. Unterstützung für sync-collection und CTag prüfen.
2. Über kalender@ einen Testtermin in Livios Arbeitskalender schreiben, ändern und löschen. Livio prüft am iPhone.
3. Über kalender@ einen Testtermin mit internem ATTENDEE und SCHEDULE-AGENT=CLIENT in Livios Arbeitskalender anlegen und eine Kopie in den Kalender der Kollegin bzw. des Kollegen schreiben: Verschickt der Server trotzdem eine Mail? Erscheint die Kopie an deren iPhone?
4. Testtermin mit externem ATTENDEE und `SCHEDULE-AGENT=CLIENT`: Verschickt der Server trotzdem eine Mail?
5. Testmail aus dem CRM im Namen von livio@: Bestehen SPF, DKIM und DMARC (Header prüfen)?
6. Wird `kalender+test@disinfoconsulting.eu` zugestellt (Plus-Adressierung)?

### Phase 1: Lesen und Teamansicht

Abnahme: Ein am iPhone angelegter, geänderter oder gelöschter Termin ist nach spätestens 5 Minuten im CRM nachgezogen. Termine mit Anzeige „Privat“ oder „Beschäftigt“ zeigen anderen nur Zeitraum und Aufschrift; Details stehen auch nicht im Seitenquelltext oder in API-Antworten. Serien und Sommerzeitwechsel stimmen. Ohne Recht ist kein Kalender sichtbar.

### Phase 2: Termine anlegen und bearbeiten, gemeinsame Termine, Verknüpfung

Abnahme: Ein im CRM angelegter Termin erscheint am iPhone aller Beteiligten, ohne dass der Server eine Mail verschickt. Verschieben im CRM wird überall übernommen. Gleichzeitige Bearbeitung wird als Konflikt erkannt, nichts geht verloren. Verknüpfte Termine stehen auf der Kontakt- bzw. Projektseite.

### Phase 3: MCP-Tools

Abnahme: Claude findet über den MCP freie Slots für zwei Personen. Ein Terminvorschlag erscheint im CRM und wird erst nach Freigabe angelegt.

### Phase 4: Einladungen an Externe und Antworten

Abnahme: Die Testmatrix aus Abschnitt 4 ist bestanden. Keine doppelten Einladungen. Eine Zusage aus Gmail ändert den Status im CRM und am iPhone des Organisators. Eine Absage im CRM verschickt CANCEL.

### Phase 5: Google Meet

Abnahme: Ein Termin mit Meet-Option hat den Link in der Einladung und am iPhone. Fällt Google aus, wird der Termin trotzdem angelegt, mit Hinweis.
