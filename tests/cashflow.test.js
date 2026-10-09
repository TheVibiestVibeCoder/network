/**
 * Tests for assets/js/cashflow.js - the numbers on the Financials tab.
 *
 * No framework and no build step. Two ways to run them:
 *   - in a browser: open tests/cashflow.test.html straight from disk (file://)
 *   - in a terminal on macOS, with the JavaScriptCore shell:
 *       /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *           assets/js/project-payments.js assets/js/revenue-forecast.js assets/js/cashflow.js tests/cashflow.test.js
 *
 * Today is fixed at 9 October 2026.
 */
(function (root) {
    'use strict';

    const CF = root.Cashflow;
    const RF = root.RevenueForecast;
    const NOW = { year: 2026, month: 9 };
    const TODAY = '2026-10-09';
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
    function project(stage, min, max, chance, start, end, extra) {
        return Object.assign({
            id: nextId++, name: 'Project ' + nextId, company: 'Client', stage,
            budget_min: min, budget_max: max, success_chance: chance,
            start_date: start, estimated_completion: end
        }, extra || {});
    }
    const pay = (month, amount, paid) => ({ month, amount, paid: !!paid });

    const SETTINGS = { buffer: 0 };

    function run(input) {
        return CF.plan(Object.assign({
            projects: [], costs: [], balances: [], transactions: [],
            settings: SETTINGS, scenario: RF.settingsFor('realistic'),
            months: 12, now: NOW, today: TODAY
        }, input));
    }

    // ------------------------------------------------------------------
    // Money in
    // ------------------------------------------------------------------

    test('amounts stay net: no VAT is added to income', () => {
        nextId = 1;
        const p = run({ projects: [project('In Progress', 10000, 10000, 100, '2026-10-01', '2026-11-30')] });
        near(p.rows[1].income, 10000, 'Nov');
        eq(p.rows[1].vat, undefined, 'no VAT column');
    });

    test('no payments: the whole budget comes in at the end month, not spread', () => {
        nextId = 1;
        const p = run({ projects: [project('In Progress', 12000, 12000, 100, '2026-09-01', '2027-01-31')] });
        near(p.rows[2].income, 0, 'Dec');
        near(p.rows[3].income, 12000, 'Jan');
        near(p.kpis.incomeTotal, 12000, 'total');
    });

    test('payments in their months, the rest of the budget at the end', () => {
        nextId = 1;
        const p = run({ projects: [project('In Progress', 10000, 10000, 100, '2026-10-01', '2026-12-31',
            { payments: [pay('2026-11', 4000)] })] });
        near(p.rows[1].income, 4000, 'Nov payment');
        near(p.rows[2].income, 6000, 'Dec final');
        eq(p.income.map(x => x.kind), ['payment', 'final']);
    });

    test('paid payments are not income any more, but still reduce the rest', () => {
        nextId = 1;
        const p = run({ projects: [project('In Progress', 10000, 10000, 100, '2026-08-01', '2026-12-31',
            { payments: [pay('2026-09', 3000, true), pay('2026-11', 2000)] })] });
        near(p.kpis.incomeTotal, 7000, 'total');
        near(p.rows[2].income, 5000, 'Dec final');
    });

    test('a payment past its month and a project past its end are due now, and overdue', () => {
        nextId = 1;
        const p = run({ projects: [
            project('In Progress', 2000, 2000, 100, '2026-06-01', '2026-12-31', { payments: [pay('2026-08', 2000)] }),
            project('In Progress', 5000, 5000, 100, '2026-03-01', '2026-09-30')
        ] });
        near(p.rows[0].income, 7000, 'Oct');
        eq(p.kpis.overdue, { count: 2, amount: 7000 });
    });

    test('without an end date the rest has no month', () => {
        nextId = 1;
        const p = run({ projects: [project('Proposal', 8000, 8000, 50, '2026-10-01', null)] });
        near(p.kpis.incomeTotal, 0, 'not in the months');
        eq(p.kpis.undated, { count: 1, amount: 4000 });
    });

    test('the scenario weighs income like the forecast', () => {
        nextId = 1;
        const rows = [project('Proposal', 10000, 20000, 50, '2026-10-01', '2026-11-30')];
        near(run({ projects: rows }).kpis.incomeTotal, 7500, 'realistic: mid x 50%');
        near(run({ projects: rows, scenario: RF.settingsFor('best') }).kpis.incomeTotal, 20000, 'best');
        near(run({ projects: rows, scenario: RF.settingsFor('worst') }).kpis.incomeTotal, 0, 'worst: proposals out');
    });

    test('complete projects bring their unpaid payments in full, in every scenario', () => {
        nextId = 1;
        const p = run({ projects: [project('Complete', 9000, 9000, null, '2026-01-01', '2026-06-30',
            { payments: [pay('2026-07', 3000, true), pay('2026-09', 6000)] })], scenario: RF.settingsFor('worst') });
        near(p.rows[0].income, 6000, 'overdue invoice');
    });

    // ------------------------------------------------------------------
    // Money out
    // ------------------------------------------------------------------

    test('a monthly cost already due this month is in the balance; later months count', () => {
        const occ = CF.costOccurrences({ kind: 'recurring', amount: 1200, interval_months: 1, start_month: '2026-01', day: 1 }, 12, NOW, 9);
        eq(occ.length, 12, 'every month');
        eq(occ[0].paid, true, 'October already paid');
        eq(occ[1].paid, false, 'November');
        near(occ[1].amount, 1200, 'amount as entered');
    });

    test('a cost later in the month still counts this month', () => {
        const occ = CF.costOccurrences({ kind: 'recurring', amount: 100, interval_months: 1, start_month: '2026-10', day: 25 }, 3, NOW, 9);
        eq(occ.map(o => o.paid), [false, false, false]);
    });

    test('quarterly from November, until a last month', () => {
        const occ = CF.costOccurrences({ kind: 'recurring', amount: 500, interval_months: 3, start_month: '2026-05', end_month: '2027-06', day: 1 }, 12, NOW, 9);
        eq(occ.map(o => o.offset), [1, 4, 7], 'Nov, Feb, May');
    });

    test('a planned cost once, in its month; past ones not at all', () => {
        eq(CF.costOccurrences({ kind: 'once', amount: 900, start_month: '2027-02' }, 12, NOW, 9).map(o => o.offset), [4]);
        eq(CF.costOccurrences({ kind: 'once', amount: 900, start_month: '2026-09' }, 12, NOW, 9).length, 0);
        eq(CF.costOccurrences({ kind: 'once', amount: 900, start_month: '2026-10', day: 1 }, 12, NOW, 9)[0].paid, false, 'planned this month still counts');
    });

    test('fixed costs per month: quarterly and yearly averaged, ended ones left out', () => {
        near(CF.monthlyFixed([
            { kind: 'recurring', amount: 1000, interval_months: 1, start_month: '2026-01' },
            { kind: 'recurring', amount: 600, interval_months: 3, start_month: '2026-01' },
            { kind: 'recurring', amount: 1200, interval_months: 12, start_month: '2026-01' },
            { kind: 'recurring', amount: 5000, interval_months: 1, start_month: '2025-01', end_month: '2026-06' },
            { kind: 'once', amount: 9999, start_month: '2026-11' }
        ], NOW), 1000 + 200 + 100);
    });

    // ------------------------------------------------------------------
    // The bank
    // ------------------------------------------------------------------

    const tx = (date, amount, excluded) => ({ date, amount, excluded: !!excluded });

    test('balance today: the newest entry, moved by later bookkeeping rows', () => {
        const b = CF.balanceToday(
            [{ id: 1, amount: 40000, as_of: '2026-09-01' }, { id: 2, amount: 50000, as_of: '2026-10-01' }],
            [tx('2026-09-30', 500), tx('2026-10-01', -300), tx('2026-10-05', -1000), tx('2026-10-06', 2500, true), tx('2026-10-08', 750)]);
        near(b.amount, 49750, 'balance');
        eq([b.anchor.asOf, b.rows, b.lastRow], ['2026-10-01', 2, '2026-10-08']);
    });

    test('no balance entered: no balance', () => {
        eq(CF.balanceToday([], [tx('2026-10-05', 100)]), null);
    });

    test('each month closes at its opening plus in less out', () => {
        nextId = 1;
        const p = run({
            balances: [{ id: 1, amount: 20000, as_of: TODAY }],
            projects: [project('In Progress', 6000, 6000, 100, '2026-10-01', '2026-11-30')],
            costs: [{ id: 1, kind: 'recurring', amount: 3000, interval_months: 1, start_month: '2026-10', day: 28 }]
        });
        eq([p.rows[0].opening, p.rows[0].closing], [20000, 17000], 'October');
        eq([p.rows[1].opening, p.rows[1].closing], [17000, 20000], 'November');
        near(p.rows[11].closing, 20000 + 6000 - 12 * 3000, 'September');
        eq(p.kpis.belowZero.label, 'Jun 2027', 'first month below zero');
        eq(p.kpis.lowest.label, 'Sep 2027');
    });

    test('the cash buffer warns before zero does', () => {
        const p = run({
            settings: { buffer: 10000 },
            balances: [{ id: 1, amount: 15000, as_of: TODAY }],
            costs: [{ id: 1, kind: 'recurring', amount: 2000, interval_months: 1, start_month: '2026-11', day: 1 }]
        });
        eq(p.kpis.belowBuffer.label, 'Jan 2027', 'below 10k');
        eq(p.kpis.belowZero.label, 'Jun 2027', 'below zero later');
    });

    test('past months from bookkeeping, with where the balance stood', () => {
        const p = run({
            balances: [{ id: 1, amount: 10000, as_of: '2026-10-01' }],
            transactions: [tx('2026-08-10', 3000), tx('2026-08-20', -1000), tx('2026-09-15', -500), tx('2026-10-03', 200)]
        });
        eq(p.past.map(m => m.label), ['Aug 2026', 'Sep 2026'], 'from the first imported month');
        eq([p.past[0].income, p.past[0].expenses], [3000, 1000], 'August');
        near(p.balance.amount, 10200, 'today');
        near(p.past[1].closing, 10000, 'end of September');
        near(p.past[0].closing, 10500, 'end of August');
    });

    root.cashflowTestResults = results;

    if (typeof document === 'undefined') {
        const failed = results.filter(r => !r.ok);
        const out = typeof print === 'function' ? print : console.log;
        results.forEach(r => out((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '\n     ' + r.message)));
        out(`\n${results.length - failed.length}/${results.length} passed`);
        if (failed.length && typeof quit === 'function') quit(1);
    }
})(typeof window !== 'undefined' ? window : globalThis);
