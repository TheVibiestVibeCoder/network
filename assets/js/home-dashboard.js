/**
 * Home dashboard: the arithmetic behind the To-dos and Projects cards.
 *
 * No DOM here - only dates, filters, groups and counts - so every number on
 * the home page comes from one place and can be checked on its own
 * (tests/home-dashboard.test.js). workload.js turns the results into HTML.
 *
 * Dates are calendar days in Europe/Vienna, carried as "YYYY-MM-DD" strings
 * the way the API sends due dates. Day arithmetic happens in UTC, where every
 * day is 24 hours long, so a daylight-saving change can never shift a to-do
 * into the wrong day.
 */
(function (root) {
    'use strict';

    const TIME_ZONE = 'Europe/Vienna';
    const DAY_MS = 86400000;

    // The week strip and its groups: today and the six days after it.
    const WINDOW_DAYS = 7;

    const PRIORITIES = [
        { key: 'high', label: 'High' },
        { key: 'medium', label: 'Medium' },
        { key: 'low', label: 'Low' },
        { key: 'none', label: 'No priority' }
    ];

    // The live pipeline, in its usual order. Leads and finished projects are
    // not on the home page (api/assign.php, Project::ACTIVE_STAGES).
    const STAGES = [
        { key: 'In Progress', label: 'In progress', tone: 'progress' },
        { key: 'Proposal', label: 'Proposal', tone: 'proposal' },
        { key: 'Negotiation', label: 'Negotiation', tone: 'negotiation' }
    ];

    const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'];

    // ------------------------------------------------------------------
    // Dates
    // ------------------------------------------------------------------

    /** Today's date in Vienna, as "YYYY-MM-DD". */
    function viennaToday(now) {
        // en-CA writes dates as YYYY-MM-DD.
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(now || new Date());
    }

    /** The hour of day in Vienna, for the greeting. */
    function viennaHour(now) {
        const hour = new Intl.DateTimeFormat('en-GB', {
            timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23'
        }).format(now || new Date());
        return Number(hour);
    }

    /** "YYYY-MM-DD" to a UTC timestamp at midnight, or null. */
    function toUtc(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
        if (!match) return null;
        const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        return isNaN(time) ? null : time;
    }

    function fromUtc(time) {
        return new Date(time).toISOString().slice(0, 10);
    }

    /** Whole days from today to the date: 0 today, 1 tomorrow, -2 two days ago. */
    function dayOffset(value, today) {
        const due = toUtc(value);
        const base = toUtc(today);
        if (due === null || base === null) return null;
        return Math.round((due - base) / DAY_MS);
    }

    function addDays(today, days) {
        return fromUtc(toUtc(today) + days * DAY_MS);
    }

    /** The parts of a date needed for labels, read in UTC so nothing shifts. */
    function dateParts(value) {
        const date = new Date(toUtc(value));
        return {
            day: date.getUTCDate(),
            weekdayShort: WEEKDAYS_SHORT[date.getUTCDay()],
            weekdayLong: WEEKDAYS_LONG[date.getUTCDay()],
            monthShort: MONTHS_SHORT[date.getUTCMonth()],
            monthLong: MONTHS_LONG[date.getUTCMonth()]
        };
    }

    /** "Fri 9 Oct" */
    function shortDate(value) {
        const p = dateParts(value);
        return `${p.weekdayShort} ${p.day} ${p.monthShort}`;
    }

    /** "Today", "Tomorrow", then the weekday: "Friday". */
    function dayName(offset, today) {
        if (offset === 0) return 'Today';
        if (offset === 1) return 'Tomorrow';
        return dateParts(addDays(today, offset)).weekdayLong;
    }

    /** The seven days of the strip, today first. */
    function week(today) {
        return Array.from({ length: WINDOW_DAYS }, (_, offset) => {
            const date = addDays(today, offset);
            const p = dateParts(date);
            return {
                offset,
                date,
                initial: p.weekdayShort.charAt(0),
                dayOfMonth: p.day,
                // "Fri 9 October" - the start of the button's accessible name.
                longLabel: `${p.weekdayShort} ${p.day} ${p.monthLong}`
            };
        });
    }

    // ------------------------------------------------------------------
    // To-dos
    // ------------------------------------------------------------------

    function isOpen(todo) {
        return Number(todo.is_completed) === 0;
    }

    function priorityOf(todo) {
        const key = String(todo.priority || '').toLowerCase();
        return key === 'high' || key === 'medium' || key === 'low' ? key : 'none';
    }

    function priorityRank(todo) {
        return PRIORITIES.findIndex(p => p.key === priorityOf(todo));
    }

    /** Where a to-do sits: 'overdue', 'd0'..'d6', 'later' or 'none'. */
    function bucketOf(todo, today) {
        const offset = dayOffset(todo.due_date, today);
        if (offset === null) return 'none';
        if (offset < 0) return 'overdue';
        if (offset < WINDOW_DAYS) return 'd' + offset;
        return 'later';
    }

    /** Due date ascending, no date last; then High to No priority. */
    function compareTodos(a, b) {
        const da = toUtc(a.due_date);
        const db = toUtc(b.due_date);
        if (da !== db) {
            if (da === null) return 1;
            if (db === null) return -1;
            return da - db;
        }
        return priorityRank(a) - priorityRank(b);
    }

    /**
     * The list under the summary: the to-dos matching the priority and day
     * filters, sorted. `filters.day` is a day offset (0 = today) or null.
     */
    function filterTodos(todos, filters, today) {
        const prio = filters && filters.prio ? filters.prio : null;
        const day = filters && filters.day !== null && filters.day !== undefined ? filters.day : null;

        return todos
            .filter(todo => !prio || priorityOf(todo) === prio)
            .filter(todo => day === null || dayOffset(todo.due_date, today) === day)
            .slice()
            .sort(compareTodos);
    }

    /**
     * The sorted list in groups by when it is due, each with its heading.
     * A to-do due after the week carries its date in `dueNote`.
     */
    function groupTodos(sorted, today) {
        const groups = [];
        const byKey = {};

        sorted.forEach(todo => {
            const key = bucketOf(todo, today);
            let group = byKey[key];

            if (!group) {
                group = { key, head: '', sub: '', urgent: false, items: [] };
                if (key === 'overdue') {
                    group.head = 'Overdue';
                    group.urgent = true;
                } else if (key === 'later') {
                    group.head = 'Later';
                } else if (key === 'none') {
                    group.head = 'No due date';
                } else {
                    const offset = Number(key.slice(1));
                    group.head = dayName(offset, today);
                    group.sub = shortDate(addDays(today, offset));
                    group.urgent = offset === 0;
                }
                byKey[key] = group;
                groups.push(group);
            }

            let dueNote = '';
            if (key === 'later') {
                dueNote = 'due ' + shortDate(todo.due_date);
            } else if (key === 'overdue') {
                const late = -dayOffset(todo.due_date, today);
                dueNote = late === 1 ? 'due yesterday' : `${late} days overdue`;
            }
            group.items.push({ todo, dueNote });
        });

        return groups;
    }

    /**
     * Every number on the To-dos card, from the open to-dos alone:
     * the donut and its legend (all open, by priority), the day badges (the
     * selected priority only), and the "N due" / "N overdue" line.
     */
    function todoSummary(openTodos, prio, today) {
        const priorities = {};
        PRIORITIES.forEach(p => { priorities[p.key] = 0; });

        const days = new Array(WINDOW_DAYS).fill(0);
        let due = 0;
        let overdue = 0;

        openTodos.forEach(todo => {
            const key = priorityOf(todo);
            priorities[key]++;

            const offset = dayOffset(todo.due_date, today);
            if (offset === null) return;
            if (offset < 0) {
                overdue++;
            } else if (offset < WINDOW_DAYS) {
                due++;
                if (!prio || key === prio) days[offset]++;
            }
        });

        return { open: openTodos.length, priorities, days, due, overdue };
    }

    /** "HIGH PRIORITY · FRIDAY · 3", or "ALL OPEN · BY DUE DATE · 12". */
    function todoListLabel(filters, count, today) {
        const parts = [];
        if (filters.prio) {
            parts.push(filters.prio === 'none' ? 'No priority' : filters.prio + ' priority');
        }
        if (filters.day !== null && filters.day !== undefined) {
            parts.push(dayName(filters.day, today));
        }
        if (!parts.length) parts.push('All open', 'By due date');
        parts.push(String(count));
        return parts.join(' · ').toUpperCase();
    }

    // ------------------------------------------------------------------
    // Projects
    // ------------------------------------------------------------------

    function stageOf(project) {
        const stage = STAGES.find(s => s.key === project.stage);
        return stage || null;
    }

    function stageCounts(projects) {
        const counts = {};
        STAGES.forEach(s => { counts[s.key] = 0; });
        projects.forEach(project => {
            if (project.stage in counts) counts[project.stage]++;
        });
        return counts;
    }

    function filterProjects(projects, stage) {
        return projects.filter(project => stageOf(project) && (!stage || project.stage === stage));
    }

    /**
     * A project's open to-dos, as the server counted them when the page
     * loaded, corrected for the to-dos ticked or unticked since - so the pill
     * moves the moment a box is checked. `todo.loaded_open` is whether the
     * to-do was open in that same load.
     */
    function projectOpenTodos(project, todos) {
        let count = Number(project.open_todos) || 0;
        todos.forEach(todo => {
            if (Number(todo.project_id) !== Number(project.id)) return;
            const wasOpen = !!todo.loaded_open;
            const open = isOpen(todo);
            if (wasOpen && !open) count--;
            if (!wasOpen && open) count++;
        });
        return Math.max(0, count);
    }

    // ------------------------------------------------------------------
    // Donut
    // ------------------------------------------------------------------

    const DONUT_RADIUS = 38;
    const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
    const DONUT_GAP = 3;

    /**
     * One arc per count, as stroke-dasharray / -dashoffset values, with a
     * small gap between arcs when there is more than one. `activeIndex` is
     * the selected entry (-1 for none); the others are dimmed.
     */
    function donutSegments(counts, activeIndex) {
        const total = counts.reduce((sum, n) => sum + n, 0);
        const parts = counts.filter(n => n > 0).length;
        const gap = parts > 1 ? DONUT_GAP : 0;
        let start = 0;

        return counts.map((n, i) => {
            const length = total ? (n / total) * DONUT_CIRCUMFERENCE : 0;
            const visible = n ? Math.max(length - gap, 0) : 0;
            const segment = {
                length: visible,
                offset: -start,
                dimmed: activeIndex !== -1 && activeIndex !== i
            };
            start += length;
            return segment;
        });
    }

    const api = {
        TIME_ZONE,
        WINDOW_DAYS,
        PRIORITIES,
        STAGES,
        DONUT_RADIUS,
        DONUT_CIRCUMFERENCE,
        viennaToday,
        viennaHour,
        dayOffset,
        addDays,
        shortDate,
        dayName,
        week,
        isOpen,
        priorityOf,
        bucketOf,
        compareTodos,
        filterTodos,
        groupTodos,
        todoSummary,
        todoListLabel,
        stageOf,
        stageCounts,
        filterProjects,
        projectOpenTodos,
        donutSegments
    };

    root.HomeDashboard = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
