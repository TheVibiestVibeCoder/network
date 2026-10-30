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

    // "todo", "to-do", "task", "Aufgabe" anywhere; "to do" with a space only
    // where it is clearly a noun ("a to do", "new to do", at the start), so
    // "I need to do the slides" is not taken for one.
    const INTENT_WORD = /\b(to-?dos?|tasks?|aufgaben?)\b/i;
    const INTENT_SPACED = /(?:^|\b(?:a|an|new|create|add|neue?[nrs]?|ein(?:e|en)?)\s+)(to do)\b/i;

    // What may stand in front of the keyword and still count as the command
    // rather than part of the title: "please create a new", "Erstelle ein".
    const INTENT_LEAD = /^\s*(?:(?:please|bitte)\s+)?(?:(?:create|add|make|new|erstell\w*|leg\w*|mach\w*|neue?\w*)\s+)?(?:(?:a|an|the|ein\w*)\s+)?(?:(?:new|neue?\w*)\s+)?$/i;

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
    const WEEKDAY_NAMES = WEEKDAYS.map(names => names.slice(0, 2));

    const MONTHS = ['jan', 'feb', 'mar|mär', 'apr', 'may|mai', 'jun', 'jul', 'aug', 'sep', 'oct|okt', 'nov', 'dec|dez'];

    const DATE_PREFIX = '(?:(?:due|by|on|until|before|bis|am|zum|fällig)\\s+)?';

    const PRIORITY_PATTERNS = [
        { re: /\b(?:high|hohe?r?)\s+prio(?:rity|rität)?\b|\bprio(?:rity|rität)?\s*:?\s*high\b|\burgent\b|\basap\b|\bdringend\b|\bwichtig\b/i, value: 'high' },
        { re: /\b(?:medium|normal|mittlere?r?)\s+prio(?:rity|rität)?\b|\bprio(?:rity|rität)?\s*:?\s*medium\b/i, value: 'medium' },
        { re: /\b(?:low|niedrige?r?)\s+prio(?:rity|rität)?\b|\bprio(?:rity|rität)?\s*:?\s*low\b|\bno rush\b/i, value: 'low' }
    ];

    const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

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

    /**
     * Every way of naming a day the parser knows, tried in order. Each
     * returns a Date from its match, or null when the match is no real date.
     */
    const DATE_RULES = [
        { re: /\b(?:day after tomorrow|übermorgen)\b/i, date: () => addDays(startOfToday(), 2) },
        { re: /\b(?:today|heute)\b/i, date: () => startOfToday() },
        { re: /\b(?:tomorrow|morgen)\b/i, date: () => addDays(startOfToday(), 1) },
        { re: /\b(?:next week|nächste woche)\b/i, date: () => weekdayNextWeek(1) },
        { re: /\b(?:end of (?:the )?week|ende der woche)\b/i, date: () => upcomingWeekday(5) },
        { re: /\bin\s+(\d{1,2})\s+(days?|tagen?|weeks?|wochen?)\b/i, date: m => addDays(startOfToday(), Number(m[1]) * (/^(w)/i.test(m[2]) ? 7 : 1)) },
        { re: /\b(\d{4})-(\d{2})-(\d{2})\b/, date: m => dayMonth(Number(m[3]), Number(m[2]) - 1, Number(m[1])) },
        { re: /\b(\d{1,2})\.(\d{1,2})\.(?:(\d{2,4})\b)?/, date: m => dayMonth(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : undefined) },
        {
            re: new RegExp(`\\b(\\d{1,2})\\.?\\s+(${MONTHS.join('|')})[a-zä]*\\.?\\b`, 'i'),
            date: m => dayMonth(Number(m[1]), monthIndex(m[2]))
        },
        {
            re: new RegExp(`\\b(${MONTHS.join('|')})[a-zä]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'),
            date: m => dayMonth(Number(m[2]), monthIndex(m[1]))
        },
        {
            re: new RegExp(`\\b(next|nächste[nr]?)\\s+(${WEEKDAY_NAMES.flat().join('|')})\\b`, 'i'),
            date: m => weekdayNextWeek(weekdayIndex(m[2]))
        },
        {
            re: new RegExp(`\\b(${WEEKDAY_NAMES.flat().join('|')})\\b`, 'i'),
            date: m => upcomingWeekday(weekdayIndex(m[1]))
        }
    ];

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
     * "bis" so it is taken out of the title along with the date.
     */
    function findDate(text) {
        for (const rule of DATE_RULES) {
            const re = new RegExp(DATE_PREFIX + rule.re.source, rule.re.flags);
            const match = re.exec(text);
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
     * A teammate named after "for", "für", "an", "assign(ed) to" or "@".
     * A bare name is left alone: "call Anna" is about Anna, not for her.
     */
    function findPerson(text, people) {
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
            const re = new RegExp(`(?:\\b(?:for|für|an|assign(?:ed)?\\s+to)\\s+|@)${escapeRegExp(name)}(?![\\wäöüß])`, 'i');
            const match = re.exec(text);
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
            const re = new RegExp(`(?<![\\wäöüß])${escapeRegExp(project.name.trim())}(?![\\wäöüß])`, 'i');
            const match = re.exec(text);
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
        const cut = [];
        if (INTENT_LEAD.test(text.slice(0, intent.start))) {
            cut.push([0, intent.end]);
        } else {
            cut.push([intent.start, intent.end]);
        }
        [due, priority, person].forEach(range => { if (range) cut.push([range.start, range.end]); });
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
        // Joining words left at the edges once the parts are gone.
        title = title.replace(/^(?:[:,;.\-–—]\s*)+/, '');
        title = title.replace(/^(?:to|that|about|for|zum|zur|um|dass|über|:)\s+/i, '');
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
            els.hint.innerHTML = 'Start with <kbd>to-do</kbd> - for example <em>"New to-do: send the offer to Müller by Friday, high priority"</em>';
        } else if (!state.parsed.intent) {
            els.hint.textContent = 'Only to-dos can be created here so far. Mention "to-do" or "task" somewhere.';
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
        const typed = q ? findDate(q) : null;
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
        due: 'Pick below, or type "next Tuesday", "14.11.", "in 3 days"…',
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
