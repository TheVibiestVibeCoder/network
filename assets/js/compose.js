/**
 * Quick add (test)
 *
 * One line of text instead of a form: type "create a new to-do to call Anna
 * by Friday" and the page recognises what is meant, marks the words it
 * understood, and walks through what is still missing - what it belongs to,
 * who does it, when, how urgent - one short list at a time.
 *
 * All of it runs here in the browser: the keyword, dates, priorities and
 * names are matched against fixed word lists and the CRM's own team and
 * project names. No request goes to Claude, so it costs nothing per to-do
 * and reacts on every keystroke.
 *
 * The to-do is created through api/todos.php and assigned through
 * api/assign.php, exactly as the to-do sheet does it, so it gets the same
 * checks and log entries. Afterwards it opens in that sheet for anything
 * else (description, links).
 */
(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Recognising the sentence
    // ------------------------------------------------------------------
    // English and German. JavaScript's \b only counts ASCII letters as part
    // of a word, so "übermorgen" would have no word start and "morgen" would
    // be found inside it. Words are fenced with these instead.

    const LETTER = 'A-Za-zÄÖÜäöüß0-9_';
    const B = `(?<![${LETTER}])`;
    const E = `(?![${LETTER}])`;

    function words(source) {
        return new RegExp(`${B}(?:${source})${E}`, 'i');
    }

    // "todo", "to-do", "task", "Aufgabe" anywhere; "to do" with a space only
    // where it is clearly a noun ("a to do", "new to do", at the start), so
    // "I need to do the slides" is not taken for one.
    const INTENT_WORD = words('to-?dos?|tasks?|aufgaben?');
    const INTENT_SPACED = /(?:^|\b(?:a|an|new|create|add|neue?[nrs]?|ein(?:e|en)?)\s+)(to do)\b/i;

    // What may stand in front of the keyword and still count as the command
    // rather than part of the title: "please create a new", "Kannst du mir
    // bitte eine neue", "Ich brauche ein", "Guten Morgen, neue".
    const LEAD_WORDS = [
        'hi', 'hey', 'hallo', 'moin', 'guten\\s+(?:morgen|tag)', 'please', 'can', 'could', 'you', 'i', 'need', 'want', 'create', 'add', 'make', 'new', 'a', 'an', 'the',
        'bitte', 'kannst', 'könntest', 'du', 'mir', 'uns', 'mal', 'noch', 'ich', 'brauche', 'möchte', 'hätte', 'gerne?',
        'erstell\\w*', 'leg\\w*', 'mach\\w*', 'notier\\w*', 'füg\\w*', 'trag\\w*', 'neue?[nrs]?', 'ein(?:e[nrs]?)?'
    ];
    const INTENT_LEAD = new RegExp(`^(?:[\\s,]*(?:${LEAD_WORDS.join('|')})${E})*[\\s,]*$`, 'i');

    const WEEKDAYS = [
        ['sunday', 'sonntag', 'sun', 'so'],
        ['monday', 'montag', 'mon', 'mo'],
        ['tuesday', 'dienstag', 'tue', 'di'],
        ['wednesday', 'mittwoch', 'wed', 'mi'],
        ['thursday', 'donnerstag', 'thu', 'do'],
        ['friday', 'freitag', 'fri', 'fr'],
        ['saturday', 'samstag', 'sat', 'sa']
    ];
    // Only the full names are matched in running text: "do" and "so" are
    // ordinary words.
    const WEEKDAY = `(${WEEKDAYS.map(names => names.slice(0, 2).join('|')).join('|')})`;

    const MONTHS = ['jan', 'feb', 'mar|mär', 'apr', 'may|mai', 'jun', 'jul', 'aug', 'sep', 'oct|okt', 'nov', 'dec|dez'];
    const MONTH = `(${MONTHS.join('|')})[a-zä]*\\.?`;

    const NUMBER_WORDS = {
        a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
        ein: 1, eine: 1, einem: 1, einer: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10
    };
    const COUNT = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|')})`;

    // "by", "due", "bis zum", "bis spätestens am" in front of a date go with
    // it, so they leave the title along with the date.
    const DATE_PREFIX = `${B}(?:(?:due|by|on|until|before|bis|zum|am|vor|spätestens|fällig|deadline:?)\\s+){0,3}`;

    // Negations first, or "nicht dringend" would be read as urgent. A "mit"
    // or "with" in front goes with the priority: "mit hoher Priorität".
    const PRIO = 'prio(?:rity|rität)?';
    const PRIORITY_PATTERNS = [
        { value: 'low', re: 'not (?:urgent|important)|no rush|nicht (?:so )?(?:dringend|eilig|wichtig)|keine eile|hat zeit|unwichtig' },
        { value: 'high', re: `(?:high|highest|hohe[rnms]?|höchste[rnms]?)\\s+${PRIO}|${PRIO}\\s*:?\\s*(?:high|hoch|1)|p1|urgent|asap|dringend|eilig|wichtig|sofort` },
        { value: 'medium', re: `(?:medium|normal|mittlere[rnms]?)\\s+${PRIO}|${PRIO}\\s*:?\\s*(?:medium|mittel|normal|2)|p2` },
        { value: 'low', re: `(?:low|niedrige[rnms]?|geringe[rnms]?)\\s+${PRIO}|${PRIO}\\s*:?\\s*(?:low|niedrig|gering|3)|p3` }
    ].map(({ value, re }) => ({ value, re: words(`(?:mit|with)\\s+(?:${re})|${re}`) }));

    const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

    // Who a to-do is for: "for Anna", "für Anna", "zuständig: Anna",
    // "@Anna" - and "für mich", "for me" for the person typing. "an Anna"
    // only right after the keyword or before a colon ("Aufgabe an Anna",
    // "an Anna: ..."): elsewhere it is "Angebot an Anna schicken".
    const PERSON_PREFIX = `(?:${B}(?:for|für|assign(?:ed)?\\s+to|zuständig(?:\\s+ist)?:?|verantwortlich:?)\\s+|@|(?<=${B}(?:to-?dos?|tasks?|aufgaben?)\\s+)an\\s+)`;
    const PERSON_PREFIX_COLON = `${B}an\\s+`;
    const ME = '(?:me|myself|mich(?:\\s+selbst)?|mir)';

    function escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function startOfToday() {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    function addDays(date, days) {
        const next = new Date(date);
        next.setDate(next.getDate() + days);
        return next;
    }

    function toIso(date) {
        const pad = n => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function fromIso(iso) {
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    /** The next given weekday, today included. */
    function upcomingWeekday(day) {
        const today = startOfToday();
        return addDays(today, (day - today.getDay() + 7) % 7);
    }

    /** That weekday in the coming calendar week (weeks start on Monday). */
    function weekdayNextWeek(day) {
        const today = startOfToday();
        const toMonday = ((8 - today.getDay()) % 7) || 7;
        return addDays(today, toMonday + ((day + 6) % 7));
    }

    /** The last day of this month. */
    function endOfMonth() {
        const today = startOfToday();
        return new Date(today.getFullYear(), today.getMonth() + 1, 0);
    }

    /** The Friday of a calendar week ("KW 46"): this year's, or next year's if past. */
    function calendarWeekFriday(week) {
        if (week < 1 || week > 53) return null;
        const today = startOfToday();
        for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
            // Week 1 is the week with 4 January in it.
            const jan4 = new Date(year, 0, 4);
            const monday = addDays(jan4, -((jan4.getDay() + 6) % 7));
            const friday = addDays(monday, (week - 1) * 7 + 4);
            if (friday >= today) return friday;
        }
        return null;
    }

    /** "in 2 weeks", "in einer Woche", "in drei Tagen". */
    function inCount(amount, unit) {
        const n = /^\d+$/.test(amount) ? Number(amount) : NUMBER_WORDS[amount.toLowerCase()];
        const today = startOfToday();
        if (/^mon/i.test(unit)) return new Date(today.getFullYear(), today.getMonth() + n, today.getDate());
        return addDays(today, n * (/^w/i.test(unit) ? 7 : 1));
    }

    /** A day and month without a year: this year, or next if it is past. */
    function dayMonth(day, month, year) {
        if (month < 0 || month > 11 || day < 1 || day > 31) return null;
        const today = startOfToday();
        let full = year;
        if (full === undefined) {
            full = today.getFullYear();
            if (new Date(full, month, day) < today) full += 1;
        } else if (full < 100) {
            full += 2000;
        }
        const date = new Date(full, month, day);
        return date.getMonth() === month ? date : null;
    }

    /** Just a day ("14"): this month, or next if it is past. */
    function dayOnly(day) {
        const today = startOfToday();
        const month = day < today.getDate() ? today.getMonth() + 1 : today.getMonth();
        return dayMonth(day, month % 12, today.getFullYear() + (month > 11 ? 1 : 0));
    }

    const NEXT_WEEK = '(?:next|nächste[rn]?|kommende[rn]?) week|(?:nächste[rn]?|kommende[rn]?) woche';

    /**
     * Every way of naming a day the parser knows, tried in order, longer
     * phrases first. Each returns a Date from its match, or null when the
     * match is no real date. `loose` rules only apply to the due date field,
     * where a bare "14.11" or "14" can only mean a day.
     */
    const DATE_RULES = [
        { re: 'day after tomorrow|übermorgen', date: () => addDays(startOfToday(), 2) },
        { re: 'today|heute', date: () => startOfToday() },
        // Not the "Morgen" of "Guten Morgen".
        { re: 'tomorrow|(?<!guten\\s)morgen', date: () => addDays(startOfToday(), 1) },
        { re: 'end of (?:the |this )?month|ende (?:des|dieses) monats|monatsende', date: endOfMonth },
        { re: `(?:end of|ende) (?:${NEXT_WEEK})`, date: () => weekdayNextWeek(5) },
        { re: `(?:middle of|mid|mitte) (?:${NEXT_WEEK})`, date: () => weekdayNextWeek(3) },
        { re: `(?:start of|beginning of|anfang) (?:${NEXT_WEEK})`, date: () => weekdayNextWeek(1) },
        { re: 'the week after next|übernächste[rn]? woche', date: () => addDays(weekdayNextWeek(1), 7) },
        { re: NEXT_WEEK, date: () => weekdayNextWeek(1) },
        { re: 'end of (?:the |this )?week|ende (?:der|dieser) woche', date: () => upcomingWeekday(5) },
        { re: '(?:kw|kalenderwoche|cw|calendar week)\\s*(\\d{1,2})', date: m => calendarWeekFriday(Number(m[1])) },
        { re: `in\\s+${COUNT}\\s+(days?|tage?n?|weeks?|wochen?|months?|monate?n?)`, date: m => inCount(m[1], m[2]) },
        { re: '(\\d{4})-(\\d{2})-(\\d{2})', date: m => dayMonth(Number(m[3]), Number(m[2]) - 1, Number(m[1])) },
        // "14.11." and "14.11.2026" anywhere; "14.11" only after "bis",
        // "am", "by" - on its own it may be "3.5 hours".
        { re: '(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4}|\\d{2})?', date: m => dayMonth(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : undefined) },
        { re: '(?:bis|zum|am|vor|spätestens|by|due|on|until|before)\\s+(\\d{1,2})\\.(\\d{1,2})', date: m => dayMonth(Number(m[1]), Number(m[2]) - 1) },
        { re: '(\\d{1,2})\\.(\\d{1,2})', loose: true, date: m => dayMonth(Number(m[1]), Number(m[2]) - 1) },
        { re: `(\\d{1,2})\\.?\\s*${MONTH}`, date: m => dayMonth(Number(m[1]), monthIndex(m[2])) },
        { re: `${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?`, date: m => dayMonth(Number(m[2]), monthIndex(m[1])) },
        // "next Friday" is the Friday of next week; "nächsten Freitag",
        // "kommenden Freitag" the next one to come.
        { re: `next\\s+${WEEKDAY}`, date: m => weekdayNextWeek(weekdayIndex(m[1])) },
        { re: `(?:nächste[nr]?|kommende[nr]?)\\s+${WEEKDAY}`, date: m => addDays(upcomingWeekday(weekdayIndex(m[1])), upcomingWeekday(weekdayIndex(m[1])) <= startOfToday() ? 7 : 0) },
        { re: `(?:(?:this|coming|diese[nrm]?)\\s+)?${WEEKDAY}`, date: m => upcomingWeekday(weekdayIndex(m[1])) },
        { re: '^\\s*(\\d{1,2})\\.?\\s*$', loose: true, date: m => dayOnly(Number(m[1])) }
    ].map(rule => ({ ...rule, re: new RegExp(`${DATE_PREFIX}(?:${rule.re})${E}`, 'i') }));

    function monthIndex(word) {
        const lower = word.toLowerCase();
        return MONTHS.findIndex(alts => alts.split('|').some(alt => lower.startsWith(alt)));
    }

    function weekdayIndex(word) {
        const lower = word.toLowerCase();
        return WEEKDAYS.findIndex(names => names.includes(lower));
    }

    /**
     * Find a date in the text. The range covers a leading "by", "due",
     * "bis zum" so it is taken out of the title along with the date. With
     * `loose`, also a bare "14.11" or "14" (the due date field).
     */
    function findDate(text, loose = false) {
        for (const rule of DATE_RULES) {
            if (rule.loose && !loose) continue;
            const match = rule.re.exec(text);
            if (!match) continue;
            // The prefix captures nothing, so the rule's groups keep their numbers.
            const date = rule.date(match);
            if (date) {
                return { start: match.index, end: match.index + match[0].length, value: toIso(date) };
            }
        }
        return null;
    }

    function findPriority(text) {
        for (const { re, value } of PRIORITY_PATTERNS) {
            const match = re.exec(text);
            if (match) return { start: match.index, end: match.index + match[0].length, value };
        }
        return null;
    }

    /**
     * A teammate named after "for", "für", "an", "zuständig" or "@", or the
     * person typing ("für mich", "for me"). A bare name is left alone: "call
     * Anna" is about Anna, not for her.
     */
    function findPerson(text, people) {
        const meKey = window.CRMPeople && window.CRMPeople.meKey ? window.CRMPeople.meKey() : null;
        const me = people.find(person => personKey(person) === meKey);
        if (me) {
            const match = new RegExp(`${PERSON_PREFIX}${ME}${E}|${PERSON_PREFIX_COLON}${ME}(?=\\s*:)`, 'i').exec(text);
            if (match) return { start: match.index, end: match.index + match[0].length, person: me };
        }

        const candidates = [];
        people.forEach(person => {
            const full = person.name.trim();
            const first = full.split(/\s+/)[0];
            [full, first].forEach(name => {
                if (name.length >= 2) candidates.push({ person, name });
            });
        });
        // Longest names first, so "Anna Berg" wins over "Anna".
        candidates.sort((a, b) => b.name.length - a.name.length);

        for (const { person, name } of candidates) {
            const named = escapeRegExp(name);
            const match = new RegExp(`${PERSON_PREFIX}${named}${E}|${PERSON_PREFIX_COLON}${named}(?=\\s*:)`, 'i').exec(text);
            if (match) {
                return { start: match.index, end: match.index + match[0].length, person };
            }
        }
        return null;
    }

    /**
     * A project named in the text, longest name first. Contacts are not
     * matched: too many of them share first names with everyday words.
     */
    function findProject(text, projects) {
        const named = projects
            .filter(project => project.name && project.name.trim().length >= 4)
            .sort((a, b) => b.name.length - a.name.length);

        for (const project of named) {
            const match = new RegExp(`${B}${escapeRegExp(project.name.trim())}${E}`, 'i').exec(text);
            if (match) return { start: match.index, end: match.index + match[0].length, project };
        }
        return null;
    }

    function findIntent(text) {
        let match = INTENT_WORD.exec(text);
        if (match) return { start: match.index, end: match.index + match[0].length };
        match = INTENT_SPACED.exec(text);
        if (match) {
            const start = match.index + match[0].length - match[1].length;
            return { start, end: start + match[1].length };
        }
        return null;
    }

    /**
     * Read one line of text: what it asks for, and what it already says.
     * Each found part carries its character range for the highlight.
     */
    function parse(text, people, projects) {
        const intent = findIntent(text);
        if (!intent) return { intent: null, parts: [] };

        const parts = [{ kind: 'intent', start: intent.start, end: intent.end }];
        const taken = [[intent.start, intent.end]];
        const free = (range) => range && !taken.some(([s, e]) => range.start < e && range.end > s);
        const take = (range, kind) => {
            if (!free(range)) return null;
            taken.push([range.start, range.end]);
            parts.push({ ...range, kind });
            return range;
        };

        const due = take(findDate(text), 'due');
        const priority = take(findPriority(text), 'priority');
        const person = take(findPerson(text, people), 'assignee');
        const project = take(findProject(text, projects), 'link');

        // The title is what is left: the command in front of the keyword,
        // the date, priority and person phrases taken out. A project name
        // stays in - "Send the Müller offer" would lose its meaning.
        const cut = [due, priority, person].filter(Boolean).map(range => [range.start, range.end]);

        // Whether what stands before the keyword is only the command is
        // judged without the parts found in it: "Erstelle für Anna ein To-do".
        let lead = text.slice(0, intent.start);
        cut.forEach(([s, e]) => {
            if (e <= intent.start) lead = lead.slice(0, s) + ' '.repeat(e - s) + lead.slice(e);
        });
        cut.push(INTENT_LEAD.test(lead) ? [0, intent.end] : [intent.start, intent.end]);
        cut.sort((a, b) => a[0] - b[0]);

        let title = '';
        let at = 0;
        cut.forEach(([s, e]) => {
            if (s > at) title += text.slice(at, s) + ' ';
            at = Math.max(at, e);
        });
        title += text.slice(at);

        return {
            intent: 'todo',
            parts: parts.sort((a, b) => a.start - b.start),
            title: cleanTitle(title),
            due: due ? due.value : undefined,
            priority: priority ? priority.value : undefined,
            assignee: person ? person.person : undefined,
            project: project ? project.project : undefined
        };
    }

    function cleanTitle(raw) {
        let title = raw.replace(/\s+/g, ' ').trim();
        // Punctuation left behind where a part was taken out:
        // "Müller anrufen , , wegen des Angebots".
        title = title.replace(/\s+([,;:.!?])/g, '$1').replace(/([,;:])(?:\s*[,;:])+/g, '$1');
        // Joining words left at the edges once the parts are gone.
        title = title.replace(/^(?:[:,;.\-–—]\s*)+/, '');
        // The rest of the command after the keyword: "Leg ein To-do an: ...",
        // "Aufgabe anlegen - ...".
        title = title.replace(/^(?:an|anlegen|erstellen|hinzufügen|eintragen|notieren|create|add)\s*[:,;\-–—]\s*/i, '');
        title = title.replace(/^(?:to|that|about|for|zum|zur|um|dass|über|wegen|bitte|please)\s+/i, '');
        title = title.replace(/[\s,;]+(?:bitte|please|danke|thanks)[.!]?$/i, '');
        title = title.replace(/\s+(?:and|und|with|mit|,)$/i, '');
        title = title.replace(/[\s,;:\-–—]+$/, '');
        return title ? title.charAt(0).toUpperCase() + title.slice(1) : '';
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    const STEPS = ['title', 'link', 'assignee', 'due', 'priority', 'confirm'];
    const STEP_LABEL = { title: 'Title', link: 'For', assignee: 'Who', due: 'Due', priority: 'Priority' };

    const state = {
        loaded: false,
        projects: [],
        contacts: [],
        phase: 'typing',      // typing | steps | saving | done
        text: '',
        parsed: { intent: null, parts: [] },
        // Each field: undefined = still open, null = deliberately empty.
        // `picked` remembers what was chosen by hand, so editing the
        // sentence again does not overwrite it.
        draft: {},
        picked: {},
        step: null,
        query: '',
        active: 0,
        options: [],
        error: '',
        created: null
    };

    let els = {};

    function people() {
        return window.CRMPeople ? window.CRMPeople.list() : [];
    }

    function personKey(person) {
        return person.id === null ? 'owner' : String(person.id);
    }

    function getCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    // Quotes too: the result also goes into attribute values.
    function escapeHtml(text) {
        return String(text == null ? '' : text).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }

    function initials(name) {
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) return '?';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function plainDate(iso) {
        return fromIso(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }

    function formatDue(iso) {
        if (!iso) return 'No date';
        const days = Math.round((fromIso(iso) - startOfToday()) / 86400000);
        const label = plainDate(iso);
        if (days === 0) return `Today, ${label}`;
        if (days === 1) return `Tomorrow, ${label}`;
        return label;
    }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    async function loadData() {
        try {
            const [projects, contacts] = await Promise.all([
                fetch('api/projects.php?' + new URLSearchParams({ search: '', sort: 'updated_at', order: 'DESC' })).then(r => r.json()),
                fetch('api/directory.php?' + new URLSearchParams({ search: '', sort: 'name', order: 'ASC' })).then(r => r.json())
            ]);
            state.projects = projects.success ? projects.data : [];
            state.contacts = contacts.success ? contacts.data : [];
            if (window.CRMPeople && !window.CRMPeople.ready()) {
                await window.CRMPeople.reload();
            }
            state.loaded = true;
        } catch (error) {
            console.error('Quick add: could not load projects and contacts', error);
        }
    }

    // ------------------------------------------------------------------
    // The sentence
    // ------------------------------------------------------------------

    function onSentenceInput() {
        state.text = els.input.value;
        state.parsed = parse(state.text, people(), state.projects);
        applyParsed();
        renderSentence();
        renderTrail();
        renderHint();
    }

    /** Copy what the sentence says into the draft, except hand-picked fields. */
    function applyParsed() {
        const p = state.parsed;
        const set = (field, value) => {
            if (!state.picked[field]) state.draft[field] = value;
        };
        set('title', p.intent ? (p.title || undefined) : undefined);
        set('due', p.due);
        set('priority', p.priority);
        set('assignee', p.assignee ? { key: personKey(p.assignee), name: p.assignee.name } : undefined);
        set('link', p.project ? { type: 'project', id: Number(p.project.id), name: p.project.name } : undefined);
    }

    /** Mirror the text behind the input with the recognised words marked. */
    function renderSentence() {
        const text = state.text;
        let html = '';
        let at = 0;
        state.parsed.parts.forEach(part => {
            html += escapeHtml(text.slice(at, part.start));
            html += `<mark class="compose-hl compose-hl--${part.kind}">${escapeHtml(text.slice(part.start, part.end))}</mark>`;
            at = part.end;
        });
        html += escapeHtml(text.slice(at));
        // A trailing space collapses in the mirror unless something follows it.
        els.backdrop.innerHTML = html + '​';
        els.backdrop.scrollLeft = els.input.scrollLeft;
        els.card.classList.toggle('is-recognised', !!state.parsed.intent);
    }

    function renderHint() {
        if (state.phase !== 'typing') return;
        if (!state.text.trim()) {
            els.hint.innerHTML = 'Start with <kbd>to-do</kbd> or <kbd>Aufgabe</kbd> - for example <em>"New to-do: send the offer to Müller by Friday, high priority"</em> or <em>"Aufgabe für Anna: Moodboard bis nächsten Montag"</em>';
        } else if (!state.parsed.intent) {
            els.hint.textContent = 'Only to-dos can be created here so far. Mention "to-do", "task" or "Aufgabe" somewhere.';
        } else {
            els.hint.innerHTML = '<kbd>Enter</kbd> to continue';
        }
    }

    // ------------------------------------------------------------------
    // The trail of fields
    // ------------------------------------------------------------------

    function fieldText(field) {
        const value = state.draft[field];
        if (value === undefined) return '';
        if (field === 'title') return value;
        if (field === 'link') return value.name;
        if (field === 'assignee') return value ? value.name : 'Unassigned';
        if (field === 'due') return formatDue(value);
        if (field === 'priority') return value ? PRIORITY_LABEL[value] : 'No priority';
        return '';
    }

    function renderTrail() {
        if (!state.parsed.intent && state.phase === 'typing') {
            els.trail.hidden = true;
            return;
        }
        els.trail.hidden = false;

        const chips = ['<span class="compose-chip compose-chip--kind">To-do</span>'];
        STEPS.filter(step => step !== 'confirm').forEach(field => {
            const text = fieldText(field);
            const classes = ['compose-chip'];
            if (!text) classes.push('is-open');
            if (state.phase === 'steps' && state.step === field) classes.push('is-current');
            if (field === 'priority' && state.draft.priority) classes.push('compose-chip--pri-' + state.draft.priority);
            chips.push(`
                <button type="button" class="${classes.join(' ')}" data-compose-step="${field}" ${state.phase === 'done' || state.phase === 'saving' ? 'disabled' : ''}>
                    <span class="compose-chip-label">${STEP_LABEL[field]}</span>
                    <span class="compose-chip-value">${escapeHtml(text || '…')}</span>
                </button>`);
        });
        els.trail.innerHTML = chips.join('');
    }

    // ------------------------------------------------------------------
    // Steps
    // ------------------------------------------------------------------

    function firstOpenStep() {
        return STEPS.find(step => step === 'confirm' || state.draft[step] === undefined);
    }

    function startSteps() {
        if (!state.parsed.intent) return;
        state.phase = 'steps';
        els.card.classList.add('is-stepping');
        goTo(firstOpenStep());
    }

    function goTo(step) {
        state.step = step;
        state.query = step === 'title' ? (state.draft.title || '') : '';
        state.active = 0;
        state.error = '';
        renderTrail();
        renderStep();
    }

    function advance() {
        goTo(firstOpenStep());
    }

    function back() {
        const index = STEPS.indexOf(state.step);
        if (index <= 0) {
            backToSentence();
            return;
        }
        goTo(STEPS[index - 1]);
    }

    function backToSentence() {
        state.phase = 'typing';
        state.step = null;
        els.card.classList.remove('is-stepping');
        els.step.hidden = true;
        els.step.innerHTML = '';
        renderTrail();
        renderHint();
        els.input.focus();
    }

    function linkOptions(query) {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = (...fields) => {
            const hay = fields.filter(Boolean).join(' ').toLowerCase();
            return words.every(word => hay.includes(word));
        };

        const projects = state.projects
            .filter(p => matches(p.name, p.company))
            .map(p => ({ value: { type: 'project', id: Number(p.id), name: p.name }, label: p.name, meta: [p.stage, p.company].filter(Boolean).join(' · '), tag: 'Project' }));
        const contacts = words.length === 0 ? [] : state.contacts
            .filter(c => matches(c.name, c.company))
            .map(c => ({ value: { type: 'contact', id: Number(c.id), name: c.name }, label: c.name, meta: c.company || '', tag: 'Contact' }));

        // Names that start with what was typed come first.
        const first = words[0] || '';
        const rank = option => option.label.toLowerCase().startsWith(first) ? 0 : 1;
        return projects.concat(contacts)
            .sort((a, b) => rank(a) - rank(b))
            .slice(0, 8);
    }

    function assigneeOptions(query) {
        const q = query.toLowerCase().trim();
        const meKey = window.CRMPeople ? window.CRMPeople.meKey() : null;
        const options = people()
            .filter(person => !q || person.name.toLowerCase().includes(q))
            .map(person => {
                const key = personKey(person);
                return { value: { key, name: person.name }, label: person.name, meta: key === meKey ? 'You' : '', person: { key, name: person.name } };
            });
        if (!q || 'unassigned'.includes(q)) {
            options.push({ value: null, label: 'Unassigned', meta: '' });
        }
        return options;
    }

    function dueOptions(query) {
        const today = startOfToday();
        const presets = [
            { label: 'Today', date: today },
            { label: 'Tomorrow', date: addDays(today, 1) },
            { label: 'Friday', date: upcomingWeekday(5) },
            { label: 'Next Monday', date: weekdayNextWeek(1) },
            { label: 'In a week', date: addDays(today, 7) },
            { label: 'In two weeks', date: addDays(today, 14) }
        ].map(p => ({ value: toIso(p.date), label: p.label, meta: plainDate(toIso(p.date)) }));

        const q = query.trim();
        const typed = q ? findDate(q, true) : null;
        const options = [];
        if (typed) {
            options.push({ value: typed.value, label: formatDue(typed.value), meta: 'From what you typed' });
        }
        // One row per day: on a Friday, "Friday" is already "Today".
        presets
            .filter(p => !q || typed || p.label.toLowerCase().includes(q.toLowerCase()))
            .forEach(p => { if (!options.some(o => o.value === p.value)) options.push(p); });
        options.push({ value: null, label: 'No due date', meta: '' });
        return options;
    }

    function priorityOptions(query) {
        const q = query.toLowerCase().trim();
        return [
            { value: 'high', label: 'High', dot: 'high' },
            { value: 'medium', label: 'Medium', dot: 'medium' },
            { value: 'low', label: 'Low', dot: 'low' },
            { value: null, label: 'No priority', dot: '' }
        ].filter(o => !q || o.label.toLowerCase().includes(q));
    }

    const OPTIONS = { link: linkOptions, assignee: assigneeOptions, due: dueOptions, priority: priorityOptions };

    const PLACEHOLDER = {
        title: 'What needs doing?',
        link: 'Search projects or contacts…',
        assignee: 'Who should do it?',
        due: 'Pick below, or type "next Tuesday", "Freitag", "14.11", "in 3 Tagen"…',
        priority: 'How urgent?'
    };

    const QUESTION = {
        title: 'What is the to-do?',
        link: 'Which project or contact is it for?',
        assignee: 'Who does it?',
        due: 'When is it due?',
        priority: 'How urgent is it?'
    };

    function renderStep() {
        els.step.hidden = false;

        if (state.step === 'confirm') {
            renderConfirm();
            return;
        }

        els.step.innerHTML = `
            <div class="compose-step-head">
                <span class="compose-step-question">${QUESTION[state.step]}</span>
                <span class="compose-step-count">${STEPS.indexOf(state.step) + 1} / ${STEPS.length - 1}</span>
            </div>
            <input type="text" class="compose-filter" id="composeFilter" autocomplete="off" spellcheck="false"
                   placeholder="${escapeHtml(PLACEHOLDER[state.step])}" value="${escapeHtml(state.query)}"
                   ${state.step === 'title' ? '' : 'role="combobox" aria-controls="composeOptions" aria-expanded="true"'}>
            ${state.step === 'title' ? '' : '<ul class="compose-options" id="composeOptions" role="listbox"></ul>'}
            ${state.step === 'due' ? '<label class="compose-date-pick">Or pick a date <input type="date" id="composeDatePick"></label>' : ''}
            <p class="compose-error" id="composeError" ${state.error ? '' : 'hidden'}>${escapeHtml(state.error)}</p>
        `;

        const filter = els.step.querySelector('#composeFilter');
        filter.addEventListener('input', () => {
            state.query = filter.value;
            state.active = 0;
            renderOptions();
        });
        filter.addEventListener('keydown', onStepKey);

        const datePick = els.step.querySelector('#composeDatePick');
        if (datePick) {
            datePick.addEventListener('change', () => {
                if (datePick.value) pick('due', datePick.value);
            });
        }

        renderOptions();
        filter.focus();
        filter.setSelectionRange(filter.value.length, filter.value.length);
    }

    function renderOptions() {
        const list = els.step.querySelector('#composeOptions');
        if (!list) return;

        state.options = OPTIONS[state.step](state.query);
        if (state.step === 'assignee' && !state.query) {
            // Start on the signed-in person: most to-dos are one's own.
            const meKey = window.CRMPeople ? window.CRMPeople.meKey() : null;
            const mine = state.options.findIndex(o => o.value && o.value.key === meKey);
            if (mine >= 0 && state.active === 0) state.active = mine;
        }
        state.active = Math.min(state.active, Math.max(0, state.options.length - 1));

        if (state.options.length === 0) {
            list.innerHTML = `<li class="compose-empty">${state.step === 'link' && !state.loaded ? 'Loading…' : 'Nothing matches'}</li>`;
            return;
        }

        list.innerHTML = state.options.map((option, i) => `
            <li class="compose-option${i === state.active ? ' is-active' : ''}" role="option" aria-selected="${i === state.active}" data-compose-option="${i}">
                ${optionLead(option)}
                <span class="compose-option-label">${escapeHtml(option.label)}</span>
                ${option.meta ? `<span class="compose-option-meta">${escapeHtml(option.meta)}</span>` : ''}
                ${option.tag ? `<span class="compose-option-tag">${escapeHtml(option.tag)}</span>` : ''}
            </li>`).join('');

        const active = list.querySelector('.is-active');
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    function optionLead(option) {
        if (state.step === 'assignee') {
            if (!option.person) return '<span class="compose-face is-empty"></span>';
            const url = window.CRMPeople ? window.CRMPeople.avatarFor(option.person.key, option.person.name) : null;
            return url
                ? `<span class="compose-face has-photo"><img src="${escapeHtml(url)}" alt=""></span>`
                : `<span class="compose-face">${escapeHtml(initials(option.person.name))}</span>`;
        }
        if (state.step === 'priority') {
            return `<span class="compose-dot${option.dot ? ' compose-dot--' + option.dot : ''}"></span>`;
        }
        return '';
    }

    function onStepKey(event) {
        const filter = event.target;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!state.options.length) return;
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            state.active = (state.active + delta + state.options.length) % state.options.length;
            renderOptions();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (state.step === 'title') {
                const title = filter.value.trim();
                if (!title) {
                    showError('A to-do needs a title.');
                    return;
                }
                pick('title', title);
            } else if (state.options[state.active]) {
                pick(state.step, state.options[state.active].value);
            }
        } else if (event.key === 'Escape') {
            event.preventDefault();
            backToSentence();
        } else if (event.key === 'Backspace' && filter.value === '') {
            event.preventDefault();
            back();
        }
    }

    function pick(field, value) {
        state.draft[field] = value;
        state.picked[field] = true;
        advance();
    }

    function showError(message) {
        state.error = message;
        const node = els.step.querySelector('#composeError');
        if (node) {
            node.textContent = message;
            node.hidden = false;
        }
    }

    function renderConfirm() {
        const d = state.draft;
        els.step.innerHTML = `
            <div class="compose-step-head">
                <span class="compose-step-question">Create this to-do?</span>
            </div>
            <div class="compose-summary">
                <div class="compose-summary-title">${escapeHtml(d.title)}</div>
                <div class="compose-summary-meta">
                    ${escapeHtml(d.link.type === 'project' ? 'Project' : 'Contact')}: ${escapeHtml(d.link.name)}
                    · ${escapeHtml(d.assignee ? d.assignee.name : 'Unassigned')}
                    · ${escapeHtml(formatDue(d.due))}
                    · ${escapeHtml(d.priority ? PRIORITY_LABEL[d.priority] + ' priority' : 'No priority')}
                </div>
            </div>
            <div class="compose-actions">
                <button type="button" class="btn btn-secondary btn-small" data-compose-action="back">Back</button>
                <button type="button" class="btn btn-primary btn-small" data-compose-action="create" id="composeCreateBtn">Create to-do</button>
            </div>
            <p class="compose-error" id="composeError" ${state.error ? '' : 'hidden'}>${escapeHtml(state.error)}</p>
        `;
        els.step.querySelector('#composeCreateBtn').focus();
    }

    // ------------------------------------------------------------------
    // Creating
    // ------------------------------------------------------------------

    async function create() {
        if (state.phase === 'saving') return;
        const d = state.draft;
        state.phase = 'saving';
        const button = els.step.querySelector('#composeCreateBtn');
        if (button) {
            button.disabled = true;
            button.textContent = 'Creating…';
        }

        try {
            const response = await fetch('api/todos.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({
                    title: d.title,
                    description: null,
                    due_date: d.due || null,
                    priority: d.priority || null,
                    contact_id: d.link.type === 'contact' ? d.link.id : null,
                    project_id: d.link.type === 'project' ? d.link.id : null
                })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) {
                throw new Error(result.error || 'The to-do could not be created.');
            }

            const id = Number(result.data && result.data.id);
            let note = '';
            if (d.assignee && id) {
                // Through api/assign.php, as the to-do sheet does it, so the
                // assignment gets the same account check and log entry.
                const assigned = await fetch('api/assign.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                    body: JSON.stringify({ type: 'todo', id, assigned_to: d.assignee.key })
                });
                if (!assigned.ok) note = 'It was created, but could not be assigned.';
                if (window.CRMWorkload && window.CRMWorkload.refreshBadge) window.CRMWorkload.refreshBadge();
            }

            state.created = { id, title: d.title, note };
            state.phase = 'done';
            renderDone();
        } catch (error) {
            state.phase = 'steps';
            showError(error.message);
            if (button) {
                button.disabled = false;
                button.textContent = 'Create to-do';
            }
        }
    }

    function renderDone() {
        renderTrail();
        els.input.readOnly = true;
        els.card.classList.add('is-done');
        els.step.innerHTML = `
            <div class="compose-done">
                <span class="compose-done-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
                </span>
                <div class="compose-done-text">
                    <div class="compose-done-title">To-do created</div>
                    <div class="compose-done-sub">${escapeHtml(state.created.note || state.created.title)}</div>
                </div>
            </div>
            <div class="compose-actions">
                <button type="button" class="btn btn-secondary btn-small" data-compose-action="open">Open to-do</button>
                <button type="button" class="btn btn-primary btn-small" data-compose-action="again" id="composeAgainBtn">Add another</button>
            </div>
        `;
        els.step.querySelector('#composeAgainBtn').focus();
    }

    function reset() {
        state.phase = 'typing';
        state.text = '';
        state.parsed = { intent: null, parts: [] };
        state.draft = {};
        state.picked = {};
        state.step = null;
        state.created = null;
        state.error = '';
        els.input.value = '';
        els.input.readOnly = false;
        els.card.classList.remove('is-stepping', 'is-done', 'is-recognised');
        els.step.hidden = true;
        els.step.innerHTML = '';
        renderSentence();
        renderTrail();
        renderHint();
        els.input.focus();
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function bind() {
        els = {
            card: document.getElementById('composeCard'),
            input: document.getElementById('composeInput'),
            backdrop: document.getElementById('composeBackdrop'),
            trail: document.getElementById('composeTrail'),
            step: document.getElementById('composeStep'),
            hint: document.getElementById('composeHint')
        };
        if (!els.card) return false;

        els.input.addEventListener('input', onSentenceInput);
        // Keep the marks under the words when a long line scrolls sideways.
        ['scroll', 'keyup', 'click', 'select'].forEach(type => {
            els.input.addEventListener(type, () => { els.backdrop.scrollLeft = els.input.scrollLeft; });
        });
        els.input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                startSteps();
            }
        });
        // Back to the sentence by clicking it while stepping.
        els.input.addEventListener('focus', () => {
            if (state.phase === 'steps') backToSentence();
        });

        els.trail.addEventListener('click', event => {
            const chip = event.target.closest('[data-compose-step]');
            if (!chip || chip.disabled) return;
            state.phase = 'steps';
            els.card.classList.add('is-stepping');
            goTo(chip.getAttribute('data-compose-step'));
        });

        els.step.addEventListener('click', event => {
            const option = event.target.closest('[data-compose-option]');
            if (option) {
                const chosen = state.options[Number(option.getAttribute('data-compose-option'))];
                if (chosen) pick(state.step, chosen.value);
                return;
            }
            const action = event.target.closest('[data-compose-action]');
            if (!action) return;
            const what = action.getAttribute('data-compose-action');
            if (what === 'create') create();
            else if (what === 'back') back();
            else if (what === 'again') reset();
            else if (what === 'open' && window.CRM && state.created) window.CRM.openTodoDetail(state.created.id);
        });

        els.step.addEventListener('keydown', event => {
            if (event.target.closest('.compose-filter')) return;
            if (event.key === 'Escape' && state.phase === 'steps') {
                event.preventDefault();
                back();
            }
        });

        renderHint();
        return true;
    }

    let bound = false;

    async function open() {
        if (!bound) bound = bind();
        if (!bound) return;
        await loadData();
        // Names and projects may have arrived since the text was typed.
        if (state.phase === 'typing') {
            onSentenceInput();
            els.input.focus();
        } else if (state.phase === 'steps') {
            renderOptions();
        }
    }

    window.CRMCompose = { open: open, parse: (text) => parse(text, people(), state.projects) };
})();
