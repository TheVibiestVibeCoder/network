# Teamkalender, Phase 2: Termine anlegen und bearbeiten, gemeinsame Termine, Verknüpfung

Stand 12.11.2026, Branch `calendar-integration`. Spezifikation: [kalender-spec.md](kalender-spec.md). Vorher: [kalender-phase0.md](kalender-phase0.md), [kalender-phase1.md](kalender-phase1.md).

Seit Phase 2 schreibt das CRM in die Kalender auf dem Mailserver, immer über das Konto kalender@. Einladungen an Gäste außerhalb des Teams kommen erst mit Phase 4.

## Was gebaut ist

### Das Terminblatt

Ein Termin wird in einem einzigen Blatt angesehen, bearbeitet und neu angelegt, wie Projekte und To-dos im CRM (`#eventSheet`, `assets/js/team-calendar.js`). Es öffnet sich von überall gleich:

- über den Knopf „New appointment“ im Kalender,
- mit einem Klick auf eine freie Stelle im Raster (zur halben Stunde),
- mit einem Klick auf eine gefundene freie Zeit (grün): Dauer und gesuchte Personen sind dann schon eingetragen,
- mit einem Klick auf einen Termin,
- aus Kontakt und Projekt, im neuen Abschnitt „Appointments“, dort mit „New“ schon verknüpft.

Das Blatt hat diese Felder:

- Titel, Beginn und Ende oder ganztägig
- Wiederholung (täglich, wöchentlich, monatlich, optional bis zu einem Datum)
- Kalender (= Organisator), Teilnehmer aus dem Team
- Ort, Videolink, Erinnerung, Notizen
- verknüpfte Kontakte und Projekte

„Private“ öffnet nur mit Zeitraum, wie bisher.

### Schreiben

- **Wohin:** Ein neuer Termin landet im Arbeitskalender des Organisators auf dem Mailserver. Das CRM zeigt ihn sofort, das iPhone beim nächsten Abgleich.
- **Server-Mails:** Schreiben über kalender@ löst keine Server-Mails aus (Phase 0).
- **Format:** Zeiten werden in Europe/Vienna mit Zeitzonen-Definition geschrieben, ganztägige Termine als Datum. Bestehende Termine werden bearbeitet, nicht neu erzeugt. Was das iPhone hineingeschrieben hat, bleibt erhalten.
- **Interne Teilnehmer:** stehen als ATTENDEE im Termin, mit `SCHEDULE-AGENT=CLIENT`, nie am Organisator (Phase 0, Empfehlung 6).

### Gemeinsame Termine (Spec, Abschnitt 4)

Jedes Teammitglied, das teilnimmt, bekommt eine Kopie in seinen Arbeitskalender: gleiche UID, gleicher Organisator, gleiche Teilnehmerliste (`includes/CalendarCopies.php`). Im CRM erscheint der Termin trotzdem nur einmal.

Ändert das CRM einen Termin, schreibt es die Kopien sofort mit.

Nach jedem Sync gleicht das CRM außerdem ab, was an den iPhones passiert ist:

- **Zusage am iPhone:** Sagt jemand in seiner Kopie zu oder ab, kommt das ins Original und in die anderen Kopien.
- **Kopie gelöscht:** Löscht jemand seine Kopie, gilt das als Absage. Die Kopie wird nicht zurückgeschrieben, außer die Person sagt später im CRM zu.
- **Andere Änderungen an einer Kopie:** Das Original überschreibt sie. Protokolliert werden nur die IDs.
- **Original verschoben oder geändert:** Verschiebt der Organisator am iPhone, ziehen die Kopien nach.
- **Neuer Termin am iPhone:** Legt jemand am iPhone einen Termin mit Teammitgliedern an, bekommen diese ihre Kopie.
- **Original gelöscht oder Teilnehmer entfernt:** Die betroffenen Kopien verschwinden.

Sicherungen:

- **Begrenzung:** Höchstens 40 Schreibvorgänge pro Sync.
- **Nur aktuelle Kalender:** Gelöscht wird nur, wenn der Kalender des Organisators in diesem Lauf erfolgreich abgeglichen wurde.
- **Notschalter:** `CALENDAR_COPIES=0` in der `.env` stoppt den automatischen Abgleich. Das CRM schreibt bei eigenen Änderungen trotzdem weiter Kopien.

### Antworten

Wer eingeladen ist, beantwortet die Frage „Will you be there?“ im Blatt mit Yes, Maybe oder No. Die Antwort geht ins Original und in alle Kopien.

### Rechte (Spec, Abschnitt 3)

| Was | Wer |
|---|---|
| Neuen Termin anlegen | wer „Calendar: edit“ hat |
| Verschieben, ändern, absagen | der Organisator, oder wer „Calendar: edit“ hat |
| Zu- oder absagen | wer eingeladen ist |
| Mit Kontakt oder Projekt verknüpfen | wer den Termin vollständig sieht |

Termine von Organisatoren außerhalb des Teams bleiben unverändert. Ebenso Termine in Kalendern, die nur zum Lesen freigegeben sind.

### Gleichzeitige Bearbeitung

Der Mailserver wertet `If-Match` nicht aus (Phase 0), deshalb prüft das CRM selbst:

1. Vor jeder Änderung liest es den Termin, wie er gerade auf dem Server liegt.
2. Es vergleicht ihn mit dem Stand, auf dem die Bearbeitung beruht.
3. Hat ihn inzwischen jemand geändert, am iPhone oder im CRM, schreibt es nichts. Die eigenen Eingaben bleiben im Blatt stehen, und das Blatt zeigt „Changed in the meantime“ mit zwei Möglichkeiten:
   - „Show the new version“: den neuen Stand ansehen.
   - „Save mine anyway“: speichern. Dann überschreiben nur die Felder, die man selbst geändert hat. Die Änderung der anderen Person bleibt in allen übrigen Feldern erhalten.

### Serien

- Ändern: nur diesen Termin oder die ganze Serie. Das Blatt fragt beim Speichern.
- Verschiebt man die ganze Serie, wandern abgesagte und einzeln verschobene Termine korrekt mit.
- Absagen: nur diesen Termin oder die ganze Serie.

### Verknüpfung (Spec, Abschnitt 3)

- **Speicherort:** Verknüpfungen mit Kontakten und Projekten stehen nur im CRM (`calendar_links`), nie auf dem Mailserver.
- **Anzeige:** Kontakt und Projekt zeigen ihre Termine unter „Appointments“, getrennt nach „Coming up“ und „Earlier“. Was für die ansehende Person verborgen ist, erscheint dort nicht.
- **Vorschlag:** Ist die Adresse eines Gasts ein Kontakt im CRM, schlägt das Blatt die Verknüpfung vor, ein Klick genügt.

### Lokale Simulation

- **Testkalender nur lokal:** Die erfundenen Kalender von `dev/seed-calendar-demo.php` beschreibt das CRM nur in der lokalen Datenbank.
- **Keine echten Kalender:** Aus einem Testkalender wird nie etwas in einen echten Kalender kopiert, auch nicht vom Sync (`CalendarStore::mayCopy`).
- **Lokales Ausprobieren:** Ein Termin mit Markus oder Vivian landet so in deinem echten Kalender und als Kopie in ihren Testkalendern.

## Geprüft

- `php tests/calendar-write.test.php`: 60 Prüfungen mit einem simulierten Kalenderserver:
  - Anlegen, Ändern, Antworten, Kopien und der Abgleich nach dem Sync
  - iPhone-Änderungen, Konflikte, Serien
  - nur lesbare Kalender, Testkalender, Verknüpfungen
- `php tests/calendar.test.php`: die 65 Prüfungen aus Phase 1, weiterhin grün.
- **Browser** (Testkopie mit drei Personen): 31 Prüfungen für Phase 2 und die 41 aus Phase 1, ohne JavaScript-Fehler.
- **Echter Mailserver** (12.11.2026): Das CRM hat über `CalendarEvents` in Livios Arbeitskalender einen Testtermin angelegt, verschoben und wieder gelöscht, jeweils auf dem Server geprüft. Eine Änderung auf veraltetem Stand wurde abgelehnt. Der Sync danach lief ohne Fehler.

## Abnahme (Spec, Phase 2)

| Kriterium | Stand |
|---|---|
| Ein im CRM angelegter Termin erscheint am iPhone aller Beteiligten, ohne dass der Server eine Mail verschickt | Für Livio auf dem Server bestätigt. Livios Blick aufs iPhone steht aus. Für Markus und Vivian braucht es ihre Freigaben (T3) |
| Verschieben im CRM wird überall übernommen | Getestet (Original und Kopien, echter Server). iPhone-Prüfung steht aus |
| Gleichzeitige Bearbeitung wird als Konflikt erkannt, nichts geht verloren | Getestet, auch gegen den echten Server |
| Verknüpfte Termine stehen auf der Kontakt- bzw. Projektseite | Getestet |

## Grenzen und Entscheidungen

- **Gäste von außen:** Gäste kommen mit Phase 4 ins Blatt, samt Einladung. Termine, in die das iPhone schon Gäste eingetragen hat, lassen sich im CRM ändern, die Gäste erfahren davon aber nichts. Das Blatt sagt das dazu.
- **Absagen:** Eine Absage entfernt den Termin aus allen Kalendern. Absage-Mails an Gäste kommen mit Phase 4.
- **Serien:**
  - „Dieser und alle folgenden“ gibt es nicht. Die Spec verlangt nur „ganze Serie oder einzelner Termin“.
  - Teilnehmer und Wiederholung gelten immer für die ganze Serie.
  - Ganztägig lässt sich bei einer Serie nicht umschalten.
  - Eine Serie mit am iPhone festgelegten Wochentagen lässt sich im CRM nur in der Uhrzeit verschieben, nicht auf andere Tage.
  - Komplexere Regeln bleiben, wie das iPhone sie gesetzt hat. Die Spec sagt: „Komplexe Regeln bleiben dem iPhone überlassen“.
- **Erinnerung:** Eine im CRM gesetzte Erinnerung ersetzt die Erinnerungen, die das iPhone in diesem Termin hatte. Ohne Änderung im CRM bleiben sie.
- **Kopien:** Kopien gehen nur in Arbeitskalender, die zum Lesen und Schreiben freigegeben sind. Sonst sagt das Blatt, wer den Termin nicht bekommt.
- **Nur „Private“:** „Busy“ ist gestrichen (Livio, 12.11.2026), es zeigte genauso wenig wie „Private“. Kalender, die auf „Busy“ standen, stellt die Datenbank beim nächsten Aufruf selbst auf „Private“ um.
- **Owner-Login:** Wer sich mit dem Owner-Passwort anmeldet, hat keinen eigenen Kalender. Er sieht nichts als „seins“ hervorgehoben und kann nicht zu- oder absagen, kann mit Bearbeiten-Recht aber anlegen.
- **Konfliktprüfung:** Ohne `If-Match` bleibt ein Bruchteil einer Sekunde zwischen Prüfen und Schreiben, in dem eine gleichzeitige iPhone-Änderung verloren ginge.
- **Fehlermeldungen:** Sie enthalten keine Kalenderpfade mehr, denn die enthalten Mailadressen. Das gilt jetzt auch für Phase 1. Protokolliert werden nur Kalender-ID, Methode und HTTP-Status.

## Nachträge (12.11.2026, nach Livios Durchsicht)

- **Puffer bei „Find a free slot“:** Die Suche hält vor und nach jedem Termin Zeit frei, standardmäßig 30 Minuten. Einstellbar in den Kalendereinstellungen unter „Working hours“ (keiner, 10, 15, 30, 45 oder 60 Minuten). Er wird mit den Arbeitszeiten gespeichert. Früher gespeicherte Arbeitszeiten bekommen die 30 Minuten.
- **Personen nur mit Profilbild:** Über dem Kalender und bei „Find a free slot“ werden Personen per Profilbild ein- und ausgeschaltet, der Name steht im Tooltip.
- **Ohne Schloss:** Private Termine zeigen kein Schloss mehr, nur „Private“.
- **Volle Fläche:** Das Raster reicht von der Seitenleiste bis zum rechten und unteren Fensterrand.
- **Vergangene Termine:** Sie sind blass, aber deckend. Die Stundenlinien scheinen nicht mehr durch.

## Offen

- **T3:** Sobald Markus und Vivian ihre Kalender für kalender@ freigegeben haben, ist zu prüfen:
  - ob ihre Kopie am iPhone erscheint,
  - ob Zusagen am iPhone funktionieren,
  - ob der Server ihnen die einfache Mail schickt, wenn der Organisator am iPhone verschiebt.
- **Livios Test am iPhone:** einen Termin im CRM anlegen, verschieben und absagen.
- **Deployment (am Ende):**
  - Neue Dateien sind `includes/CalendarStore.php`, `CalendarIcsWriter.php`, `CalendarEvents.php`, `CalendarCopies.php` und `CalendarLinks.php`.
  - Die Datenbank erweitert sich beim ersten Aufruf selbst (`calendar_links`, `calendar_copies`).
  - Neue `.env`-Einträge sind nicht nötig.
- **Phase 3 (MCP):** Ich brauche Zugriff auf das Repo des MCP-Servers. `CalendarEvents` ist so gebaut, dass freigegebene Vorschläge dieselben Wege nehmen.
