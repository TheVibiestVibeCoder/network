# Simple CRM

Ein modernes, passwortgeschuetztes Kontaktmanagement-System mit interaktiver Kartenvisualisierung, Kalenderansicht und Tag-System. Gebaut mit PHP, SQLite und Vanilla JavaScript.

---

## Inhaltsverzeichnis

- [Uebersicht](#uebersicht)
- [Tech Stack](#tech-stack)
- [Projektstruktur](#projektstruktur)
- [Installation & Setup](#installation--setup)
- [Konfiguration](#konfiguration)
- [Features](#features)
  - [Kontaktverwaltung](#kontaktverwaltung)
  - [Kartenansicht](#kartenansicht)
  - [Listenansicht](#listenansicht)
  - [Kalenderansicht](#kalenderansicht)
  - [Tag-System](#tag-system)
  - [Notizen & Timeline](#notizen--timeline)
  - [Excel Import/Export](#excel-importexport)
- [API-Referenz](#api-referenz)
- [Datenbank-Schema](#datenbank-schema)
- [Sicherheit](#sicherheit)
- [Frontend-Architektur](#frontend-architektur)
- [Deployment](#deployment)
- [Backup & Wartung](#backup--wartung)

---

## Uebersicht

Simple CRM ist ein schlankes, selbst gehostetes CRM-System fuer die interne Verwaltung von Geschaeftskontakten. Die Anwendung laeuft komplett auf einem einzelnen Server ohne externe Datenbank-Abhaengigkeiten (SQLite) und bietet drei Hauptansichten:

- **Karte** -- Kontakte auf einer interaktiven Leaflet-Karte mit Marker-Clustering
- **Liste** -- Durchsuchbare Kontaktliste, gruppierbar nach Firma oder Tags
- **Kalender** -- Notizen-Timeline in Monats-, Wochen- oder Tagesansicht

Das System ist als Single-Page-Application aufgebaut (alles in `index.php`), nutzt ein dunkles, modernes UI-Design und ist mobilfreundlich.

---

## Tech Stack

| Komponente | Technologie |
|---|---|
| **Backend** | PHP 7.4+ |
| **Datenbank** | SQLite (Datei: `data/crm.db`) |
| **Frontend** | Vanilla JavaScript, CSS3 |
| **Karte** | Leaflet 1.9.4 + MarkerCluster |
| **Geocoding** | OpenStreetMap Nominatim (kostenlos) |
| **Kartentiles** | CartoDB Dark Matter |
| **Excel** | PhpSpreadsheet 1.25.2 |
| **Schrift** | Inter (Google Fonts) |
| **Build-Tool** | Keines -- kein Build-Schritt noetig |

---

## Projektstruktur

```
network/
├── index.php                  # Haupt-Einstiegspunkt (Login + SPA)
├── composer.json               # PHP-Abhaengigkeiten
├── composer.lock               # Gelockte Versionen
├── .env.example                # Umgebungsvariablen-Vorlage
├── .gitignore
├── README.md
│
├── config/
│   └── config.php              # App-Konfiguration, .env-Loader, Konstanten
│
├── includes/                   # PHP-Klassen (Namespace: SimpleCRM\)
│   ├── auth.php                # Authentifizierung, Session, CSRF, Security Headers
│   ├── database.php            # SQLite-Verbindung & Schema-Initialisierung
│   └── Contact.php             # Contact-Model mit CRUD-Operationen
│
├── api/                        # REST-API-Endpunkte
│   ├── contacts.php            # Kontakt-CRUD + Geocoding + Daten-Fix
│   ├── tags.php                # Tag-Verwaltung & Zuweisungen
│   ├── notes.php               # Notizen-Timeline pro Kontakt
│   ├── calendar.php            # Kalenderansicht mit Filterung
│   └── import-export.php       # Excel-Import/Export
│
├── assets/
│   ├── css/
│   │   └── style.css           # Komplettes Stylesheet (Dark Theme)
│   └── js/
│       └── app.js              # Frontend-Logik (SPA)
│
├── data/
│   └── .gitkeep                # DB-Verzeichnis (crm.db wird hier erstellt)
│
└── vendor/                     # Composer-Dependencies
```

---

## Installation & Setup

### Voraussetzungen

- PHP 7.4 oder hoeher
- Composer
- Webserver (Apache, Nginx, oder PHP Built-in Server)

### Schritte

```bash
# 1. Repository klonen
git clone <repo-url>
cd network

# 2. PHP-Abhaengigkeiten installieren
composer install

# 3. Umgebungsdatei erstellen
cp .env.example .env

# 4. Passwort setzen (siehe Konfiguration)
nano .env

# 5. Data-Verzeichnis sicherstellen
mkdir -p data
chmod 775 data

# 6. Entwicklungsserver starten
php -S localhost:8000
```

Die Datenbank (`data/crm.db`) wird beim ersten Zugriff automatisch erstellt und das Schema angelegt.

---

## Konfiguration

### Umgebungsvariablen (`.env`)

```env
# Pflicht: Zugangspasswort
APP_PASSWORD=changeme

# Optional: App-Name (wird im Header und Browser-Tab angezeigt)
APP_NAME="Simple CRM"
```

### Passwort-Optionen

Das Passwort kann als Klartext oder als bcrypt-Hash gesetzt werden:

```bash
# Klartext (nur fuer Entwicklung)
APP_PASSWORD=meinpasswort

# Bcrypt-Hash (empfohlen fuer Produktion)
# Hash generieren:
php -r "echo password_hash('meinpasswort', PASSWORD_BCRYPT) . PHP_EOL;"
# Ergebnis in .env eintragen:
APP_PASSWORD=$2y$10$...
```

Bcrypt-Hashes werden automatisch erkannt (beginnen mit `$2y$`, `$2a$` oder `$2b$`).

### Feste Konstanten (in `config/config.php`)

| Konstante | Wert | Beschreibung |
|---|---|---|
| `DB_PATH` | `data/crm.db` | Pfad zur SQLite-Datenbank |
| `SESSION_LIFETIME` | 86400 (24h) | Session-Dauer |
| `MAX_LOGIN_ATTEMPTS` | 10 | Max. fehlgeschlagene Logins |
| `LOGIN_LOCKOUT_DURATION` | 900 (15min) | Sperrzeit nach zu vielen Fehlversuchen |

---

## Features

### Kontaktverwaltung

Vollstaendige CRUD-Operationen fuer Kontakte mit folgenden Feldern:

| Feld | Typ | Pflicht | Beschreibung |
|---|---|---|---|
| Name | Text | Ja | Kontaktname |
| Firma | Text | Nein | Unternehmen |
| Standort | Text | Nein | Stadt/Region (wird geocoded) |
| E-Mail | E-Mail | Nein | E-Mail-Adresse |
| Telefon | Text | Nein | Telefonnummer |
| Website | URL | Nein | Webseite (https:// wird automatisch ergaenzt) |
| Adresse | Text | Nein | Volle Postadresse |
| Notiz | Text | Nein | Freitext-Notiz |

**Geocoding:** Wenn ein Standort oder eine Adresse angegeben wird, werden automatisch GPS-Koordinaten via OpenStreetMap Nominatim ermittelt. Diese Koordinaten werden fuer die Kartenansicht genutzt.

### Kartenansicht

Die Standard-Ansicht zeigt alle Kontakte mit Koordinaten auf einer interaktiven Leaflet-Karte:

- Zentriert auf Europa (52.5 N, 10 E)
- Marker-Clustering bei dichter Kontaktverteilung
- Klick auf Marker zeigt Popup mit Name, Firma, Standort
- Klick im Popup oeffnet die Kontakt-Detailansicht
- CartoDB Dark Matter Kartenstil passend zum Dark Theme

### Listenansicht

Durchsuchbare Liste aller Kontakte mit zwei Gruppierungsmodi:

**Nach Firma gruppiert:**
- Aufklappbare Firmensektionen
- Kontakte alphabetisch innerhalb der Firma
- Firmenname als Section-Header

**Nach Tags gruppiert:**
- Aufklappbare Tag-Sektionen mit farbigen Tag-Badges
- Abschnitt "Ohne Tags" fuer nicht-getaggte Kontakte
- Inline-Bearbeitung von Tag-Namen und -Farben
- Tag-Loeschung direkt in der Ansicht
- Suche innerhalb der Tag-Ansicht

**Sortierung:** Name, Firma, Standort oder Erstelldatum (aufsteigend/absteigend)

**Suche:** Durchsucht Name, Firma, Standort, E-Mail und Notizen

### Kalenderansicht

Zeigt Notizen in einer kalenderartigen Timeline:

- **Monatsansicht** -- Gitter mit allen Tagen, Notizen als farbige Chips
- **Wochenansicht** -- 7-Tage-Raster mit Notizen
- **Tagesansicht** -- Einzelner Tag mit allen Notizen
- Navigation: Vor/Zurueck-Buttons, "Heute"-Schnelltaste
- Suche nach Kontaktname, Firma oder Notizinhalt
- Filterung nach Tags via Dropdown
- Klick auf Notiz oeffnet Kontakt-Detailansicht

### Tag-System

Flexibles Tagging-System mit Farbkodierung:

- Tags mit frei waehlbarer Hex-Farbe erstellen
- Tags an Kontakte zuweisen und entfernen (Many-to-Many)
- Inline-Tag-Erstellung im Kontakt-Detail-Modal
- Tag-Vorschlaege beim Tippen (existierende Tags)
- Tags in der Listenansicht bearbeiten und loeschen
- Tags werden in Kontaktkarten, Kalender-Chips und Detailansicht angezeigt

### Notizen & Timeline

Jeder Kontakt hat eine eigene Notizen-Timeline:

- Notizen werden mit Zeitstempel gespeichert
- Sortierung: Neueste zuerst
- **Firmenweite Notizen:** Alle Notizen von Kontakten derselben Firma sind sichtbar
- Separates "Firmen-Notizen"-Modal zeigt alle Notizen der Firma mit Kontaktnamen
- Notizen koennen einzeln geloescht werden
- Notizen erscheinen auch in der Kalenderansicht

### Excel Import/Export

**Export:**
- Alle Kontakte als formatierte `.xlsx`-Datei
- Gestylter Header (blauer Hintergrund, weisse Schrift)
- Automatische Spaltenbreiten
- Dateiname: `contacts_export_JJJJ-MM-TT_HHmmss.xlsx`

**Import:**
- `.xlsx` und `.xls` Dateien unterstuetzt
- Maximale Dateigroesse: 10 MB
- Flexible Spaltenzuordnung (Reihenfolge egal)
- Deutsche und englische Spaltennamen unterstuetzt:
  - Name / Namen / Kontaktname
  - Company / Firma / Unternehmen
  - Location / Ort / Stadt
  - Email / E-Mail
  - Phone / Telefon / Tel
  - Website / Webseite / URL
  - Address / Adresse / Anschrift
  - Note / Notiz / Bemerkung
- Automatisches Geocoding der ersten 50 Kontakte (Rate-Limit: 1 Req/Sek)
- Detaillierter Fehlerbericht mit Zeilennummern

**Template:** Herunterladbare Vorlage mit Anleitung und Beispieldaten

---

## API-Referenz

Alle Endpunkte erfordern eine aktive Session. Zustandsaendernde Requests benoetigen einen CSRF-Token im `X-CSRF-Token`-Header.

### Kontakte (`/api/contacts.php`)

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/contacts.php` | Alle Kontakte abrufen |
| `GET` | `/api/contacts.php?search=...&sort=name&order=ASC` | Suchen & sortieren |
| `GET` | `/api/contacts.php?action=map` | Kontakte mit Koordinaten (Karte) |
| `GET` | `/api/contacts.php?id=123` | Einzelnen Kontakt abrufen |
| `POST` | `/api/contacts.php` | Neuen Kontakt erstellen |
| `PUT` | `/api/contacts.php?id=123` | Kontakt aktualisieren |
| `DELETE` | `/api/contacts.php?id=123` | Kontakt loeschen |
| `POST` | `/api/contacts.php?action=fix-data` | URLs normalisieren & fehlende Koordinaten geocoden |

### Tags (`/api/tags.php`)

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/tags.php` | Alle Tags abrufen |
| `GET` | `/api/tags.php?action=contact&contact_id=123` | Tags eines Kontakts |
| `GET` | `/api/tags.php?action=contacts&id=5` | Kontakte mit bestimmtem Tag |
| `GET` | `/api/tags.php?action=grouped` | Tags mit gruppierten Kontakten |
| `POST` | `/api/tags.php` | Neuen Tag erstellen |
| `POST` | `/api/tags.php?action=assign` | Tag an Kontakt zuweisen |
| `PUT` | `/api/tags.php?id=5` | Tag aktualisieren |
| `DELETE` | `/api/tags.php?id=5` | Tag loeschen |
| `DELETE` | `/api/tags.php?action=unassign` | Tag von Kontakt entfernen |

### Notizen (`/api/notes.php`)

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/notes.php?contact_id=123` | Notizen eines Kontakts (inkl. firmenweite) |
| `GET` | `/api/notes.php?company=Acme` | Alle Notizen einer Firma |
| `POST` | `/api/notes.php` | Neue Notiz erstellen |
| `DELETE` | `/api/notes.php?id=456` | Notiz loeschen |

### Kalender (`/api/calendar.php`)

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/calendar.php?start=...&end=...` | Kalendereintraege im Zeitraum |
| `GET` | `/api/calendar.php?search=...&tag_id=5` | Filtern nach Suche/Tag |

### Import/Export (`/api/import-export.php`)

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `?action=template` | Excel-Vorlage herunterladen |
| `GET` | `?action=export` | Alle Kontakte als .xlsx exportieren |
| `POST` | `?action=import` | Kontakte aus Excel importieren (multipart/form-data) |

---

## Datenbank-Schema

SQLite-Datenbank mit automatischer Schema-Erstellung beim ersten Start.

### Tabelle: `contacts`

```sql
CREATE TABLE contacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        VARCHAR(255) NOT NULL,
    company     VARCHAR(255),
    location    VARCHAR(255),
    latitude    REAL,
    longitude   REAL,
    note        TEXT,
    email       VARCHAR(255),
    phone       VARCHAR(50),
    website     VARCHAR(255),
    address     TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabelle: `tags`

```sql
CREATE TABLE tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        VARCHAR(100) NOT NULL UNIQUE,
    color       VARCHAR(7) DEFAULT '#3b82f6',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabelle: `contact_tags`

```sql
CREATE TABLE contact_tags (
    contact_id  INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    tag_id      INTEGER REFERENCES tags(id) ON DELETE CASCADE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (contact_id, tag_id)
);
```

### Tabelle: `notes`

```sql
CREATE TABLE notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id  INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    company     VARCHAR(255),
    content     TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabelle: `login_attempts`

```sql
CREATE TABLE login_attempts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address    VARCHAR(45),
    attempted_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    success       INTEGER DEFAULT 0
);
-- Eintraege aelter als 24h werden automatisch geloescht
```

### ER-Diagramm (vereinfacht)

```
contacts ──< contact_tags >── tags
    │
    └──< notes
```

---

## Sicherheit

### Authentifizierung

- Einzelnes Passwort fuer alle Benutzer (konfiguriert via `.env`)
- Unterstuetzt Klartext und bcrypt-Hashes
- Constant-Time-Vergleich via `hash_equals()` (verhindert Timing-Attacken)

### Brute-Force-Schutz

- Maximal 10 Fehlversuche pro IP
- 15-Minuten-Sperre nach Ueberschreitung
- Automatische Bereinigung nach 24 Stunden
- Erkennt Proxy-IPs (X-Forwarded-For, X-Real-IP)

### Session-Sicherheit

- 24-Stunden-Lebensdauer
- HttpOnly-Cookies (kein JavaScript-Zugriff)
- SameSite=Strict (CSRF-Schutz auf Cookie-Ebene)
- Secure-Flag automatisch bei HTTPS
- Cache-Control: no-store (kein Caching authentifizierter Seiten)

### CSRF-Schutz

- 64-Zeichen-Hex-Tokens via `random_bytes(32)`
- Validierung bei allen POST/PUT/DELETE-Requests
- Token im `X-CSRF-Token`-Header oder als POST-Parameter

### Security Headers

```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: [strenge Whitelist]
```

### Input-Sanitisierung

- Strings: Trim + Laengenbegrenzung (max. 255 Zeichen)
- E-Mail: `FILTER_VALIDATE_EMAIL`
- Telefon: Nur Ziffern, +, -, (), /
- URLs: Blockiert `javascript:`, `data:`, `vbscript:`
- Notizen: Max. 10.000 Zeichen
- Adressen: Max. 1.000 Zeichen

---

## Frontend-Architektur

Die gesamte Frontend-Logik ist in `assets/js/app.js` als IIFE (Immediately Invoked Function Expression) strukturiert:

### Architektur-Module

| Modul | Aufgabe |
|---|---|
| **State** | Zentrales State-Objekt mit allen App-Zustaenden |
| **API-Layer** | Async-Funktionen fuer alle CRUD-Operationen |
| **DOM-Cache** | Gecachte Referenzen auf alle UI-Elemente |
| **Event-Listener** | Button-Clicks, Input-Events, Form-Submits |
| **Renderer** | DOM-Update-Funktionen basierend auf State |
| **Utilities** | Formatierung, Escaping, Debouncing |

### Zentrale Funktionen

```
initMap()                          -- Leaflet-Karte initialisieren
loadMapMarkers()                   -- Kontakt-Marker laden und anzeigen
loadContacts()                     -- Kontaktliste laden
renderContactsListByCompany()      -- Firmengruppierung rendern
renderContactsListByTags()         -- Tag-Gruppierung rendern
openContactModal()                 -- Kontaktformular oeffnen
openOverviewModal()                -- Kontakt-Detailansicht oeffnen
openImportExportModal()            -- Import/Export-Dialog oeffnen
loadCalendarNotes()                -- Kalendereintraege laden
renderCalendar()                   -- Kalender rendern (Monat/Woche/Tag)
switchView()                       -- Zwischen Karte/Liste/Kalender wechseln
debounce()                         -- Input-Throttling
```

### UI-Modals

| Modal | Funktion |
|---|---|
| **Kontaktformular** | Erstellen/Bearbeiten von Kontakten |
| **Kontakt-Detail** | Vollansicht mit Tags, Notizen, Timeline |
| **Loeschen-Bestaetigung** | Sicherheitsabfrage vor Loeschung |
| **Firmen-Notizen** | Alle Notizen einer Firma |
| **Import/Export** | Excel hoch-/herunterladen |

### Design-System

Dark Theme mit CSS Custom Properties:

```css
--color-bg:             #000000     /* Hintergrund */
--color-surface:        #0a0a0a     /* Oberflaechen */
--color-text:           #ffffff     /* Primaertext */
--color-text-secondary: #a0a0a0     /* Sekundaertext */
--color-primary:        #ffffff     /* Akzent */
--color-danger:         #ff4444     /* Fehler/Loeschen */
--color-success:        #22c55e     /* Erfolg */
```

---

## Deployment

### Entwicklung (PHP Built-in Server)

```bash
php -S localhost:8000
# Oeffne http://localhost:8000
```

### Produktion mit Apache

```apache
<VirtualHost *:80>
    ServerName crm.example.com
    DocumentRoot /var/www/crm

    <Directory /var/www/crm>
        AllowOverride All
        Require all granted
    </Directory>

    # .env nicht ueber Web zugaenglich machen
    <Files .env>
        Require all denied
    </Files>
</VirtualHost>
```

### Produktion mit Nginx

```nginx
server {
    listen 80;
    server_name crm.example.com;
    root /var/www/crm;
    index index.php;

    # .env blockieren
    location ~ /\.env {
        deny all;
    }

    location ~ \.php$ {
        fastcgi_pass unix:/var/run/php-fpm.sock;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}
```

### Docker (Quick Start)

```bash
docker run -it --rm -p 8000:8000 \
  -v $(pwd):/app -w /app \
  php:7.4-cli php -S 0.0.0.0:8000
```

---

## Backup & Wartung

### Datenbank-Backup

```bash
# Manuelles Backup
cp data/crm.db data/crm.db.backup.$(date +%Y%m%d_%H%M%S)

# Automatisches taegliches Backup (Crontab)
0 2 * * * cp /var/www/crm/data/crm.db /backups/crm.db.$(date +\%Y\%m\%d)
```

### Datenbank zuruecksetzen

```bash
# Loescht alle Daten -- Datenbank wird beim naechsten Zugriff neu erstellt
rm data/crm.db
```

### Daten reparieren

Der Endpunkt `POST /api/contacts.php?action=fix-data` normalisiert Website-URLs (fuegt `https://` hinzu) und geocodet Kontakte mit fehlendem Breiten-/Laengengrad. Einmalig nach groesseren Datenimporten nuetzlich.

---

## Lizenz

Internes Tool -- nicht zur oeffentlichen Verbreitung bestimmt.
