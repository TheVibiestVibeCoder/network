/**
 * Tests for assets/js/home-dashboard.js - the numbers on the home page.
 *
 * No framework and no build step. Two ways to run them:
 *   - in a browser: open tests/home-dashboard.test.html straight from disk (file://)
 *   - in a terminal on macOS, with the JavaScriptCore shell:
 *       /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *           assets/js/home-dashboard.js tests/home-dashboard.test.js
 *
 * "Today" is fixed at Wednesday 7 October 2026 so the dates read naturally.
 */
(function (root) {
    'use strict';

    const HD = root.HomeDashboard;
    const TODAY = '2026-10-07';
    const results = [];

    function test(name, fn) {
        try {
            fn();
            results.push({ name, ok: true });
        } catch (e) {
            results.push({ name, ok: false, message: e && e.message ? e.message : String(e) });
        }
    }

    function eq(actual, expected, label) {
        const a = JSON.stringify(actual);
        const b = JSON.stringify(expected);
        if (a !== b) throw new Error(`${label || 'value'}: expected ${b}, got ${a}`);
    }

    function near(actual, expected, label) {
        if (Math.abs(actual - expected) > 0.01) throw new Error(`${label || 'value'}: expected ~${expected}, got ${actual}`);
    }

    let nextId = 1;
    function todo(due, priority, extra) {
        return Object.assign({
            id: nextId++,
            title: 'To-do ' + nextId,
            due_date: due,
            priority: priority,
            is_completed: 0
        }, extra || {});
    }

    // A week of work: something late, today, tomorrow, Friday, the last day
    // of the window, the day after it, and no date at all.
    function sample() {
        nextId = 1;
        return [
            todo('2026-10-14', 'medium'),            // 1  later (+7)
            todo(null, 'low'),                       // 2  no date
            todo('2026-10-09', 'low'),               // 3  Friday
            todo('2026-10-07', 'medium'),            // 4  today
            todo('2026-10-05', 'high'),              // 5  overdue (2 days)
            todo('2026-10-09', 'high'),              // 6  Friday
            todo('2026-10-08', null),                // 7  tomorrow, no priority
            todo('2026-10-13', 'high'),              // 8  Tuesday (+6)
            todo('2026-10-07', 'high'),              // 9  today
            todo('', 'medium')                       // 10 no date (empty string)
        ];
    }

    const ids = list => list.map(t => t.id);

    // ------------------------------------------------------------------
    // Dates
    // ------------------------------------------------------------------

    test('today is the calendar day in Vienna, not UTC', () => {
        // 22:30 UTC on 7 Oct is 00:30 on 8 Oct in Vienna (CEST, UTC+2).
        eq(HD.viennaToday(new Date('2026-10-07T22:30:00Z')), '2026-10-08');
        eq(HD.viennaToday(new Date('2026-10-07T21:59:00Z')), '2026-10-07');
        // In winter Vienna is UTC+1.
        eq(HD.viennaToday(new Date('2026-12-31T23:30:00Z')), '2027-01-01');
    });

    test('day offsets survive the daylight-saving change', () => {
        // Clocks go back on 25 Oct 2026.
        eq(HD.dayOffset('2026-10-26', '2026-10-24'), 2);
        eq(HD.dayOffset('2026-10-05', TODAY), -2);
        eq(HD.dayOffset(null, TODAY), null);
        eq(HD.dayOffset('not a date', TODAY), null);
    });

    test('the week strip runs from today for seven days', () => {
        const week = HD.week(TODAY);
        eq(week.length, 7);
        eq(week.map(d => d.initial).join(''), 'WTFSSMT');
        eq(week.map(d => d.dayOfMonth), [7, 8, 9, 10, 11, 12, 13]);
        eq(week[2].longLabel, 'Fri 9 October');
        eq(week[6].date, '2026-10-13');
    });

    // ------------------------------------------------------------------
    // Grouping
    // ------------------------------------------------------------------

    test('groups by due date: Overdue, Today, Tomorrow, weekday, Later, No due date', () => {
        const groups = HD.groupTodos(HD.filterTodos(sample(), {}, TODAY), TODAY);

        eq(groups.map(g => g.head), ['Overdue', 'Today', 'Tomorrow', 'Friday', 'Tuesday', 'Later', 'No due date']);
        eq(groups.map(g => g.sub), ['', 'Wed 7 Oct', 'Thu 8 Oct', 'Fri 9 Oct', 'Tue 13 Oct', '', '']);
        eq(groups.map(g => g.urgent), [true, true, false, false, false, false, false], 'urgent');
    });

    test('rows due after the week say when; late rows say how late', () => {
        const groups = HD.groupTodos(HD.filterTodos(sample(), {}, TODAY), TODAY);
        const later = groups.find(g => g.key === 'later');
        const overdue = groups.find(g => g.key === 'overdue');
        const today = groups.find(g => g.key === 'd0');

        eq(later.items[0].dueNote, 'due Wed 14 Oct');
        eq(overdue.items[0].dueNote, '2 days overdue');
        eq(today.items[0].dueNote, '');
    });

    test('sorted by due date, no date last, then High to No priority', () => {
        const sorted = HD.filterTodos(sample(), {}, TODAY);
        // 5 overdue; today: 9 high before 4 medium; 7 tomorrow; Friday: 6
        // high before 3 low; 8; 1 later; then no date: 10 medium before 2 low.
        eq(ids(sorted), [5, 9, 4, 7, 6, 3, 8, 1, 10, 2]);
    });

    // ------------------------------------------------------------------
    // Filters
    // ------------------------------------------------------------------

    test('priority filter alone', () => {
        eq(ids(HD.filterTodos(sample(), { prio: 'high' }, TODAY)), [5, 9, 6, 8]);
        eq(ids(HD.filterTodos(sample(), { prio: 'none' }, TODAY)), [7]);
    });

    test('day filter alone', () => {
        eq(ids(HD.filterTodos(sample(), { day: 2 }, TODAY)), [6, 3]);
        eq(ids(HD.filterTodos(sample(), { day: 0 }, TODAY)), [9, 4]);
        eq(ids(HD.filterTodos(sample(), { day: null }, TODAY)).length, 10);
    });

    test('priority and day filters combine', () => {
        eq(ids(HD.filterTodos(sample(), { prio: 'high', day: 2 }, TODAY)), [6]);
        eq(ids(HD.filterTodos(sample(), { prio: 'low', day: 0 }, TODAY)), []);
    });

    test('the filter bar names the filters and the count', () => {
        eq(HD.todoListLabel({ prio: null, day: null }, 10, TODAY), 'ALL OPEN · BY DUE DATE · 10');
        eq(HD.todoListLabel({ prio: 'high', day: 2 }, 1, TODAY), 'HIGH PRIORITY · FRIDAY · 1');
        eq(HD.todoListLabel({ prio: null, day: 0 }, 2, TODAY), 'TODAY · 2');
        eq(HD.todoListLabel({ prio: 'none', day: null }, 1, TODAY), 'NO PRIORITY · 1');
    });

    // ------------------------------------------------------------------
    // Counts: donut, legend, day badges
    // ------------------------------------------------------------------

    test('legend and donut count every open to-do by priority', () => {
        const s = HD.todoSummary(sample(), null, TODAY);
        eq(s.open, 10);
        eq(s.priorities, { high: 4, medium: 3, low: 2, none: 1 });
        eq(s.due, 6, 'due in the next 7 days');
        eq(s.overdue, 1);
    });

    test('day badges count only the selected priority', () => {
        eq(HD.todoSummary(sample(), null, TODAY).days, [2, 1, 2, 0, 0, 0, 1]);
        eq(HD.todoSummary(sample(), 'high', TODAY).days, [1, 0, 1, 0, 0, 0, 1]);
        // The legend keeps counting every priority while one is selected.
        eq(HD.todoSummary(sample(), 'high', TODAY).priorities.low, 2);
    });

    test('ticking a to-do off moves every count', () => {
        const todos = sample();
        todos.find(t => t.id === 9).is_completed = 1;   // today, high
        const s = HD.todoSummary(todos.filter(HD.isOpen), null, TODAY);
        eq(s.open, 9);
        eq(s.priorities.high, 3);
        eq(s.days[0], 1);
        eq(s.due, 5);
    });

    test('donut arcs share the ring, with gaps between them', () => {
        const C = HD.DONUT_CIRCUMFERENCE;
        const segs = HD.donutSegments([2, 1, 0, 1], -1);

        near(segs[0].length, C / 2 - 3, 'first arc');
        near(segs[1].length, C / 4 - 3, 'second arc');
        eq(segs[2].length, 0, 'empty arc');
        near(segs[3].offset, -(C * 3 / 4), 'last arc starts three quarters round');
        eq(segs.map(s => s.dimmed), [false, false, false, false]);
    });

    test('a single priority fills the ring without a gap; selection dims the rest', () => {
        const C = HD.DONUT_CIRCUMFERENCE;
        near(HD.donutSegments([0, 5, 0], -1)[1].length, C, 'full ring');
        eq(HD.donutSegments([1, 1, 1], 1).map(s => s.dimmed), [true, false, true]);
        eq(HD.donutSegments([0, 0, 0], -1).map(s => s.length), [0, 0, 0]);
    });

    // ------------------------------------------------------------------
    // Projects
    // ------------------------------------------------------------------

    const projects = [
        { id: 1, name: 'Senioren', stage: 'In Progress', open_todos: 3 },
        { id: 2, name: 'BfS Call', stage: 'Proposal', open_todos: 1 },
        { id: 3, name: 'Keynote', stage: 'Negotiation', open_todos: 0 },
        { id: 4, name: 'Workshops', stage: 'In Progress', open_todos: 2 },
        { id: 5, name: 'Old lead', stage: 'Lead', open_todos: 4 }
    ];

    test('stage counts and filter cover the active stages only', () => {
        eq(HD.stageCounts(projects), { 'In Progress': 2, 'Proposal': 1, 'Negotiation': 1 });
        eq(HD.filterProjects(projects, null).map(p => p.id), [1, 2, 3, 4]);
        eq(HD.filterProjects(projects, 'In Progress').map(p => p.id), [1, 4]);
    });

    test('project open to-do counts follow ticks made on the page', () => {
        const todos = [
            { id: 1, project_id: 1, is_completed: 1, loaded_open: true },   // just ticked off
            { id: 2, project_id: 1, is_completed: 0, loaded_open: true },   // still open
            { id: 3, project_id: 2, is_completed: 0, loaded_open: false },  // just reopened
            { id: 4, project_id: null, is_completed: 1, loaded_open: true }
        ];
        eq(HD.projectOpenTodos(projects[0], todos), 2);
        eq(HD.projectOpenTodos(projects[1], todos), 2);
        eq(HD.projectOpenTodos(projects[2], todos), 0);
        eq(HD.projectOpenTodos(projects[3], todos), 2);
    });

    // ------------------------------------------------------------------
    // Report
    // ------------------------------------------------------------------

    const failed = results.filter(r => !r.ok);
    root.homeDashboardTestResults = results;

    if (typeof document === 'undefined') {
        const out = typeof print === 'function' ? print : console.log;
        results.forEach(r => out((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '\n     ' + r.message)));
        out(`\n${results.length - failed.length}/${results.length} passed`);
        if (failed.length && typeof quit === 'function') quit(1);
    }
})(typeof window !== 'undefined' ? window : globalThis);
