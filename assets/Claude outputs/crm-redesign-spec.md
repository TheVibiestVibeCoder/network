# Disinfo CRM: Clean Redesign (Handoff für Claude Code)

Überarbeitetes Erscheinungsbild für **Home, Projects, To-dos und Financials** sowie eine neue **Zahlungsanzeige** für Projekte. Ziel: übersichtlicher durch klare Farbcodierung, ruhige Listen statt Kartenraster, viel Weißraum und sparsame Linien. Financials orientiert sich an Trade Republic.

**Grundlage ist das bestehende Design-System in `assets/css/design.css`.** Es werden nur vorhandene Tokens eingesetzt, mit wenigen begründeten Ergänzungen (Abschnitt 2.1).

Stand: 30.10.2026 · Quelle: Design-Canvas „Disinfo CRM – Clean Redesign“

---

## So gibst du das an Claude Code

1. Lege den Ordner `claude-code-handoff/` ins Repo, z. B. als `docs/redesign/`.
2. Gib Claude Code diesen Prompt:

```text
Setze das Redesign aus docs/redesign/ um. Lies zuerst crm-redesign-spec.md,
dann die Referenzseiten (*-redesign-reference.html) und die Screenshots (screenshots/*.png).

1. Verwende die vorhandenen Tokens aus assets/css/design.css (--c-*, --stage-*, --pri-*, --type-*,
   --r-*, --e-*, --t-*). Die Hexwerte in den Referenzseiten entsprechen diesen Tokens
   (Zuordnung in Abschnitt 2). Neue Tokens nur die in Abschnitt 2.1 genannten.
2. Analysiere zuerst die bestehenden Views und Klassen (design.css Abschnitte 9–12, 42, 43;
   app.js, home-dashboard.js, financials.js, cashflow.js, revenue-forecast-card.js,
   project-payments.js) und zeig mir einen kurzen Plan, bevor du Code änderst.
3. Neue Regeln als eigener, klar kommentierter Abschnitt am Ende von design.css
   („Redesign 2026-10“). Bestehende Klassen wiederverwenden, wo möglich.
4. Reihenfolge: gemeinsame Bausteine → Projects (inkl. Zahlungsanzeige) → To-dos → Home → Financials.
   Melde dich nach jeder Seite kurz.
5. Datenlogik, Routen, API-Aufrufe und bestehende Funktionen (Suche, Filter, Claude-Vorschläge
   annehmen/ablehnen, PDF-Drop in Bookkeeping, Szenarien, Zeitraum, Buffer) bleiben unverändert.
   Nur die Zahlungsanzeige braucht ggf. zusätzliche abgeleitete Werte (Abschnitt 6).
6. Dark Mode muss weiter funktionieren. Bitte prüfen.
7. Die Referenz-HTMLs sind Vorlagen für Look und Maße, kein Code zum Kopieren.
   Beispieldaten und [Platzhalter] nicht übernehmen.
```

### Inhalt des Pakets

| Datei | Zweck |
|---|---|
| `crm-redesign-spec.md` | Diese Spezifikation |
| `projects-` / `todos-` / `home-` / `financials-redesign-reference.html` | Statische Referenzseiten (Inline-Styles = exakte Werte) |
| `payments-redesign-reference.html` | Alle Zustände der Zahlungsanzeige |
| `screenshots/*.png` | Gerenderte Ansichten bei 1440 px Breite |
| `fonts/`, `img/favicon.svg` | Kopien aus `assets/`, nur damit die Referenzseiten lokal korrekt rendern |

---

## 1. Leitlinien

- **Keine Karten und Kacheln.** Alle vier Seiten (Home, Projects, To-dos, Financials) liegen auf weißem Grund (`--c-surface`). Gruppen werden durch eine Überschrift und Weißraum getrennt (28–48 px), Zeilen durch eine feine Linie (`--c-line-2`). Keine Rahmen, keine Schatten, keine Kartenflächen.
- **Weniger Ränder.** Hervorhebungen über weiche Hintergrundflächen statt Rahmen: Claude-Hinweise, Vorschlagszeilen, Zahlungszeile, Warnleiste.
- **Feste Farbcodierung** (Abschnitt 3), überall gleich.
- **Linien sparsam.** Nur zwischen Zeilen und als Trennlinie der Sidebar. Nicht unter Überschriften, nicht um Bereiche.

## 2. Token-Zuordnung (Hexwert in der Referenz → Token in `design.css`)

| Hex | Token | Verwendung |
|---|---|---|
| `#FFFFFF` | `--c-surface` | Seitenhintergrund aller vier Views, Sidebar, Inputs (`--c-bg` wird auf diesen Seiten nicht mehr als Fläche verwendet) |
| `#DCE1EA` | `--c-tint` | aktiver Nav-Eintrag, Faces |
| `#E7EAF0` | `--c-tint-2` | Segmented-Hintergrund, Zähler-Pills, Track der Chance-Linie |
| `#F2F4F7` | `--c-tint-3` | Nav-Hover, Anhang-Chip |
| `#F7F8FA` | *(Zeilen-Hover / Zahlungszeile; zwischen `--c-tint-3` und Weiß)* | Hover und Hintergrund der Zahlungszeile |
| `#1C3258` / `#364765` / `#5C6A84` / `#828C9F` | `--c-ink` / `-2` / `-3` / `-4` | Text, Sekundärtext, Meta, Placeholder/Chevrons/Checkbox-Ring |
| `#DDE0E6` / `#E8EAEE` / `#C5CBD5` | `--c-line` / `-line-2` / `-line-strong` | Input-Rahmen + „nicht geplant“ / Zeilentrenner / Nulllinie, Schraffur |
| `#30599D` | `--c-accent` / `--stage-proposal` | aktiv, Proposal, „startet morgen“, „Today“ |
| `#D97757` · `#B4583A` · `rgba(217,119,87,.13)` · `.07` | `--c-claude` · `-2` · `-soft` · `-softer` | alles von Claude |
| `#D76262` · `#BC3F3F` · `rgba(215,98,98,.12)` | `--c-danger` · `-ink` · `-soft` | überfällig, High, unter null |
| `#B48B39` · `#89640D` | `--c-warning` / `--type-bookkeeping` · `-ink` | Bookkeeping, „bald endend“ |
| `#63A375` · `#457553` | `--c-success` · `-ink` | erhalten, Low, Annehmen, Zuflüsse |
| `#D08440` | `--pri-medium` | Priorität Medium |
| `#1C7E7E` · `#30599D` · `#8FB4E4` | `--stage-progress` · `-proposal` · `-negotiation` | Projektphasen |
| `#8A68AE` · `#A55F8F` | `--type-project` · `--type-contact` | Typ-Kennzeichnung |
| `10px` / `8px` / `12–14px` / `20px` | `--r-md` / `--r-sm` / `--r-lg` / `--r-xl` | Buttons, Inputs / Segmente, kleine Buttons, Icon-Chips / Hinweisflächen, Claude-Zeilen / (frei) |

### 2.1 Vorgeschlagene Ergänzungen in `design.css`

| Neuer Token | Wert | Grund |
|---|---|---|
| `--c-claude-ink` | `#A04B2F` | Text auf `--c-claude-soft`; `--c-claude-2` erreicht dort nur ca. 4:1 |
| `--pay-scheduled` | `#B5D6BF` | Zahlungsanzeige: geplant, noch nicht bezahlt (helles Grün, klar heller als `--c-success`) |
| `--chart-lead` | `#C8D4E8` | Lead im Umsatz-Balkendiagramm: heller als `--stage-lead`, damit unsichere Umsätze zurücktreten. Alternativ `--stage-lead` global auf diesen Wert ändern; dann aber die Lesbarkeit der Lead-Punkte an anderen Stellen prüfen. |
| `--type-project-soft`, `--type-contact-soft` | Typfarbe mit 13 % | Icon-Chips auf Home |

Dark-Mode-Werte für die Ergänzungen bitte analog zu den bestehenden ableiten.

**Schrift:** General Sans (bereits in `assets/fonts/`). Größen 12 / 13 / 14 / 15 / 17 / 20 / 26 / 32 px; Hero-Zahl auf Financials 56 px, Forecast-Summe 40 px. Ziffern tabellarisch.

## 3. Farbsprache (verbindlich)

| Bedeutung | Farbe | Darstellung |
|---|---|---|
| Projektphase | `--stage-*` | Punkt im Gruppenkopf und Filter; **4-px-Balken links an jeder Projektzeile** (läuft über Zahlungszeile mit); Chance-Linie in Phasenfarbe |
| Wahrscheinlichkeit (Chance) | Phasenfarbe auf `--c-tint-2` | **Linie** 48 × 4 px unter dem Prozentwert (kein Ring) |
| Priorität | High `--c-danger` · Medium `--pri-medium` · Low `--c-success` · keine `--c-line-strong` | In Listen: Punkt + Wort. Auf Home: Pill mit Soft-Hintergrund. |
| Fälligkeit/Restzeit | überfällig `--c-danger-ink` · heute/morgen `--c-accent` · ≤ 14 Tage `--c-warning-ink` · sonst ink-3 | Text |
| Objekttyp | To-do accent · Projekt `--type-project` · Bookkeeping `--type-bookkeeping` · Kontakt `--type-contact` | Icon-Chips (Home), Projekt-Punkt vor Projektnamen in To-dos |
| Claude | `--c-claude*` | Asterisk, Chips, Hinweisleiste, Vorschlagszeilen |
| Geld | Zufluss `--c-success-ink` mit „+“ · Abfluss ink mit „−“ · negativer Kontostand `--c-danger-ink` | Financials-Übersicht, Zahlungsanzeige |

Farbe ist nie das einzige Signal: Phase, Priorität und Status stehen immer auch als Wort da.

## 4. Gemeinsame Bausteine

**App-Shell**

- **Sidebar:** `--c-surface`, 248 px, rechts eine Linie `--c-line-2`.
  - Logo + „Disinfo **CRM**“ („CRM“ in Accent) + „TEST“.
  - Nav-Items: 40 px, Radius 10. Aktiv: `--c-tint` + 600.
  - Zähler: `--c-tint-2`-Pill. Home: Accent. From Claude: `--c-claude-2` mit Claude-Icon.
- **Hauptbereich:** weiß, Padding `36px clamp(16px,4vw,56px) 64px`. Inhalt max. 1120 px (Financials 1040 px), zentriert.

**Listen-Muster** (Projects, To-dos)

- Spaltenköpfe: 12/500, ink-3.
- **Gruppenkopf:** Punkt bzw. 28-px-Icon-Chip + Titel 17/600 + Zähler-Pill. Rechts optional eine Summe (14, ink-3). Abstand nach oben 28–36 px, nach unten 12 px.
- **Zeile:** `border-top: 1px solid --c-line-2`, Padding 14–16 px vertikal. Die Hover-Fläche läuft 12 px über den Rand hinaus (`margin: 0 -12px; padding-inline: 12px`), Hover `#F7F8FA`.

**Weitere Bausteine**

| Baustein | Aussehen |
|---|---|
| Claude-Hinweisleiste | `--c-claude-softer`, Radius 14, ohne Rahmen. Asterisk, Text, rechts ein Button „Review ›“ in `--c-claude-soft` / Claude-Ink |
| Claude-Chip | 22 px, `--c-claude-soft`, Text `--c-claude-ink`, Asterisk 11 px |
| Buttons | bestehende `.btn-primary` / `.btn-secondary` / `.btn-small` / `.btn-icon` (40 bzw. 32 px, Radius 10) |
| Segmented | bestehendes `.segmented` (`--c-tint-2`, aktives Segment weiß + leichter Schatten) |
| Suche | `.form-input`-Optik, 40 px, Lupe ink-4 |
| Annehmen / Ablehnen (Claude-Vorschläge) | 34 px, Radius 10. Ablehnen: weiß, `--c-line`, ✕ in danger-ink. Annehmen: `--c-success-ink` mit weißem ✓. |

## 5. Seiten

### 5.1 Projects

1. **Kopf:** Titel 26/700. Rechts `Continue meeting` (secondary) und `Add project` (primary).
2. **Claude-Hinweisleiste** (nur wenn offene Projekt-Vorschläge existieren): „**Claude proposed N changes** on M projects“ + „Review ›“.
3. **Werkzeugleiste:** Segmented `All · ● In progress · ● Proposal · ● Negotiation` (mit Phasenpunkt und Anzahl). Rechts Suche und Filter.
4. **Spaltenköpfe:** Project · Timeline · Budget · Chance.
5. **Gruppen je Phase:** Kopf mit Phasenpunkt, Name, Zähler; rechts die Budgetsumme der Gruppe (min – max; Projekte ohne Budget ignorieren).
6. **Projektzeile:** links der 4-px-Phasenbalken. Spalten `1fr · 160 · 170 · 64 · 28 · 16`, 24 px Abstand.

| Spalte | Inhalt und Regeln |
|---|---|
| Projekt | Titel 15/600 + Claude-Chip „N changes“ (bei 0 ausblenden). Darunter der Kunde (13, ink-3). **Keine Beschreibung.** |
| Timeline | `MMM d – MMM d` (Jahr nur wenn ≠ aktuelles; ohne Ende: „no end“ in ink-3). Darunter die Restzeit, farbig nach Abschnitt 3. |
| Budget | rechtsbündig, 14/600 |
| Chance | Prozent 14/600 + Linie 48 × 4 in Phasenfarbe |
| Owner | Face 28 |
| (letzte) | Chevron ink-4 |

7. **Zahlungszeile** unter der Hauptzeile: nur bei Projekten mit Zahlungsplan oder in Phase In progress (Abschnitt 6).

### 5.2 To-dos

1. **Kopf:** Titel; darunter „6 open · ● 3 overdue · ● 1 due today“. Rechts `New to-do`.
2. **Werkzeugleiste:** Segmented `By due date` · `By project` · `Assigned to me`. Rechts Suche und Filter.
3. **Gruppen ohne Karten.** Kopf mit 28-px-Icon-Chip:

| Gruppe | Icon-Chip | Zähler |
|---|---|---|
| Overdue | Wecker, `--c-danger-soft` | danger |
| Today | Kalender-Häkchen, `--c-accent-soft`; Datum in ink-3 | accent |
| Upcoming | Kalender, `--c-tint-2` | neutral |

   Bei „By project“: Kopf = Projekt-Punkt + Projektname + Anzahl + rechts „Open project ›“.

4. **Zeile:**
   - Checkbox (20-px-Kreis, Ring ink-4).
   - Titel 15/600 + Beschreibung einzeilig (ink-3). Anhang-Chip ohne Rahmen: `--c-tint-3`, Datei-Icon in `--type-bookkeeping`.
   - Projekt-Link mit violettem Punkt.
   - Priorität: Punkt + Wort.
   - Due: farbig nach Abschnitt 3.
   - Assignee: Face.

### 5.3 Home (ohne Kacheln)

1. **Kopf:** Datum (12/600, Großbuchstaben, gesperrt, ink-3) + „Good afternoon, {Vorname}“ 32/700. Rechts die Scope-Auswahl („Me“ + Zähler-Pill + Chevron, secondary).
2. **Überblick** als Zahlenreihe ohne Kästen (je kleines Typ-Icon + Label 13 ink-3, darunter Zahl 30/600 mit Zusatz). Jede Zahl verlinkt auf die gefilterte Ansicht:
   - **Open to-dos:** Zahl + „4 overdue“ in danger-ink. Überfällige sind Teil der offenen To-dos, keine eigene Kennzahl.
   - **Active projects:** Zahl + Phasenaufteilung
   - **Invoices missing:** Zahl + „bank entries without PDF“
3. **Zwei Spalten**, getrennt nur durch Weißraum (64 px): links **My to-dos** (`flex: 1.6 1 520px`), rechts **Bookkeeping**, **My projects**, **Contacts** untereinander (48 px Abstand).
4. **My to-dos:**
   - Kopf mit Icon-Chip, Zähler und `New to-do` (`.btn-small` secondary).
   - **7-Tage-Leiste ohne Kacheln:** Wochentag + Zahl. Heute als Navy-Kreis (30 px), Tage mit Fälligkeit mit 5-px-Punkt in Accent. Klick filtert.
   - Daneben der Prioritätsbalken (6 px) mit Legende.
   - **Eine durchgehende Liste, sortiert nach Fälligkeit.** Keine eigene Gruppe „Overdue“; Überfälliges steht einfach oben und ist in der Fälligkeitsspalte rot markiert („31 days overdue“). Weitere Werte: „Tomorrow“ (accent), sonst Datum.
   - Zeile: Checkbox, Titel 14/600 (+ Link-Chip), Unterzeile Person bzw. Projekt (mit violettem Projekt-Punkt), rechts Fälligkeit (120 px) und Prioritäts-Pill.
   - **Claude-Vorschläge** stehen an ihrer Position in der Liste: Hintergrund `--c-claude-softer`, Radius 14, ohne Rahmen. Chip „Awaiting review“, rechts Ablehnen/Annehmen.
   - Am Ende der Link „Show all N to-dos ›“.
5. **Bookkeeping:**
   - Kopf mit Bookkeeping-Icon-Chip, Zähler in warning, „Open ›“.
   - Eine Zeile Erklärtext.
   - Einträge als Listenzeilen: Gegenpartei, „Datum · **PDF missing**“ (warning-ink), Betrag rechts.
   - Der PDF-Drop auf die Zeile bleibt. Beim Drag-over: Hintergrund `--c-accent-softer` und 2-px-Outline in Accent.
6. **My projects:** Zeilen mit 4-px-Phasenbalken, Titel, „Kunde · Phase“, rechts „N to-do(s)“.
7. **Contacts:** Zeilen mit Face 32, Name, Firma; „View all ›“.

### 5.4 Financials (an Trade Republic orientiert)

Eine ruhige Spalte von oben nach unten, ohne Karten:

1. **Kopf:** Titel; rechts Segmented `Worst · Realistic · Best`. Das Szenario gilt für die ganze Seite.
2. **Kontostand als Hero:**
   - „Bank balance“ (15, ink-3) + Pill „Update“.
   - Darunter der Betrag 56/600.
   - Darunter die Veränderung bis zum Ende des Zeitraums mit Pfeil: „↘ −170.058 € by Sep 2028“ (danger-ink; bei positiver Entwicklung ↗ in success-ink) und „Today · entered for {Datum}“ (ink-3).
3. **Verlaufslinie** (ca. 260 px, volle Breite):
   - Keine y-Achse, keine Gitterlinien.
   - Gebuchte Monate gestrichelt ink-4. Plan über null in `--c-ink`, unter null in `--c-danger`.
   - Fläche unter null: `--c-danger` mit 6 %. Nulllinie `--c-line` mit Label „0 €“ rechts.
   - Gepunktete Linie auf Höhe des heutigen Stands.
   - Punkt „Today“, Endpunkt als roter Ring mit Betrag, Label „Below zero from {Monat}“.
   - Fünf Monatslabels.
   - Hover (bestehende Logik): senkrechte Linie + Wert des Monats.
4. **Darunter:**
   - Links die Zeitraum-Pills `6M · 12M · 24M` (aktiv: Navy-Pill mit weißer Schrift; entspricht „Months ahead“).
   - Rechts die Legende und ein kleiner Button „In & out“ (schaltet auf Monatsbalken ein/aus wie bisher).
5. **Warnleiste:** `--c-danger-soft` ohne Rahmen. „**Below zero from Jul 2027** (−9.899 €) in the realistic scenario“, rechts der weiße Button „Set buffer“.
6. **Overview:** zwei Spalten mit Schlüssel-Wert-Zeilen (Label 14 ink-3 links, Wert 15/600 rechts, Linie `--c-line-2` dazwischen):
   - Coming in · next 3 months **+42.165 €** (success-ink)
   - Coming in · 24 months, net **+69.395 €** (success-ink)
   - Lowest balance · {Monat} **−154.078 €** (danger-ink)
   - Fixed costs · per month **−10.411 €**
   - Fixed costs · 24 months, N positions **−239.453 €**
   - Below zero from **Jul 2027** (danger-ink; ausblenden, wenn nie unter null)
7. **Revenue forecast:**
   - Kopf: Titel 20/600; rechts die Textbuttons „Adjust“ und „Projects ›“ (bisher „Expand“).
   - Links: „Expected revenue · {Szenario} · N of N projects“, Summe 40/600, „Zeitraum · + X without end date“.
   - Rechts eine **Szenario-Spanne:** Linie von Worst bis Best, Punkt beim gewählten Szenario, die drei Werte darunter.
   - **Balkendiagramm** (190 px):
     - **gestrichelte Outline** (1,5 px `#B8BDC4`) = Budget-Obergrenze („Top of budget“).
     - Gestapelte Segmente von unten In progress → Proposal → Negotiation → Lead, 1 px Abstand.
     - **Lead in `--chart-lead` (heller).**
     - Über dem stärksten Monat dessen Wert als Label.
     - Spalte „n/d“ mit gestrichelter Trennlinie.
     - Monats- und Jahreslabels, Legende, Hinweis „click a bar to see its projects“.

## 6. Zahlungsanzeige (Projekte)

Referenz: `payments-redesign-reference.html`.

**Ort:** eigene Zeile unter der Projektzeile, Hintergrund `#F7F8FA`, Radius 12, ohne Rahmen. Inhalt:

- Label „Payments“
- Balken: 8 px hoch, flex, max. 380 px
- „X € received“ (success-ink 600)
- „n of m payments“ (ink-3)
- „**A – B €** open“
- optional „Y € not scheduled“ (ink-3)

**Balken:** Gesamtbreite = **maximales Budget**. Segmente proportional zum Betrag, 2 px Abstand, von links nach rechts:

| Segment | Farbe | Bedeutung |
|---|---|---|
| Erhalten | `--c-success` | je bezahlte Teilzahlung ein Segment |
| Geplant | `--pay-scheduled` | je geplante, noch offene Teilzahlung ein Segment |
| Nicht geplant | `--c-line` | Teil des **Mindest**budgets ohne Teilzahlung |
| Abhängig vom Endbudget | Schraffur (`repeating-linear-gradient(135deg, --c-line-strong 0 2px, transparent 2px 5px)`) | Differenz max − min bei Budget-Range |

**Berechnung**

- `received` = Summe bezahlter Teilzahlungen
- `scheduled` = Summe geplanter, offener Teilzahlungen
- `notScheduled` = max(0, budgetMin − received − scheduled)
- `range` = budgetMax − max(budgetMin, received + scheduled)
- Text „open“: `budgetMin − received` bis `budgetMax − received`. Sind beide gleich (Fixbudget), nur ein Betrag.
- „Y € not scheduled“ nur wenn `notScheduled > 0`.

**Zustände**

| Zustand | Darstellung |
|---|---|
| Fixbudget, alles in Raten | nur grüne Segmente, keine graue/schraffierte Fläche |
| Fixbudget, teilweise in Raten | grüne Segmente + grauer Rest + „Y € not scheduled“ |
| Budget-Range, Minimum in Raten | grüne Segmente + Schraffur; „A – B € open“ |
| Budget-Range, teilweise in Raten | grün + grau + Schraffur; „A – B € open“ + „Y € not scheduled“ |
| Keine Raten | grau + Schraffur, „No payments scheduled“, Link „Plan payments“ |
| Vollständig bezahlt | nur dunkelgrün, ✓ „X € received“, „m of m payments · paid in full“ |

Wenn die Teilzahlungen das Maximalbudget übersteigen, als Warnung anzeigen (`--c-warning-ink`: „exceeds budget by Z €“).

## 7. Zahlen- und Textformate

- Beträge `20.000 €`, negativ mit echtem Minus `−1.950,00 €`, Bereiche `20.000 – 28.000 €`, Kurzform `80,1k €`. Überall einheitlich de-AT; bisher teils `€80.1k`.
- In der Financials-Übersicht Vorzeichen zeigen (`+` Zufluss, `−` Abfluss).
- UI-Sprache Englisch wie bisher. Datum `Oct 21`, Jahr nur wenn ≠ aktuelles Jahr.

## 8. Responsive

Die bestehenden Breakpoints (`design.css` Abschnitt 15) gelten weiter.

Zusätzlich:

| Breite | Verhalten |
|---|---|
| < 900 px | Home-Spalten untereinander (To-dos zuerst); Overview in Financials einspaltig |
| < 760 px | Spaltenköpfe ausblenden, Zeilen umbrechen (Titel volle Breite, Werte darunter), Owner/Chevron ausblenden; Zahlungsbalken volle Breite, Texte darunter; Monatslabels im Forecast nur jedes dritte |

## 9. Barrierefreiheit

- Text-Kontraste ≥ 4,5:1 (Claude-Text deshalb `--c-claude-ink`).
- Fokus wie bestehend.
- Segmente mit `aria-pressed`, aktive Nav mit `aria-current`, Icon-Buttons mit `aria-label`.
- Balken und Charts mit `role="img"` + `aria-label`, das die Zahlen nennt (z. B. „6.400 € received in 2 of 3 payments …“).
- Farbe nie allein.

## 10. Abnahme-Checkliste

- [ ] Alle vier Seiten weiß ohne Karten/Kacheln; Linien nur zwischen Zeilen
- [ ] Home: eine durchgehende To-do-Liste nach Fälligkeit, Überfälliges rot markiert statt eigener Gruppe
- [ ] Nur Tokens aus design.css plus die Ergänzungen aus 2.1
- [ ] Projects: Phasenbalken, Chance als Linie, keine Beschreibungen, Claude-Leiste nur bei offenen Vorschlägen
- [ ] Zahlungsanzeige: alle sechs Zustände korrekt, Berechnung nach Abschnitt 6, Range als Schraffur
- [ ] To-dos: Gruppierungen funktionieren, Fälligkeitsfarben korrekt
- [ ] Home: PDF-Drop und Vorschläge annehmen/ablehnen funktionieren
- [ ] Financials: Szenario und Zeitraum aktualisieren Hero, Linie, Warnleiste, Overview und Forecast; „In & out“ funktioniert
- [ ] Zahlenformat de-AT überall einheitlich
- [ ] Dark Mode geprüft; unter 760 px keine horizontale Scrollleiste
