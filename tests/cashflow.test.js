/**
 * Tests for assets/js/cashflow.js - the numbers on the Financials tab.
 *
 * No framework and no build step. Two ways to run them:
 *   - in a browser: open tests/cashflow.test.html straight from disk (file://)
 *   - in a terminal on macOS, with the JavaScriptCore shell:
 *       /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *           assets/js/format.js assets/js/project-payments.js assets/js/revenue-forecast.js assets/js/cashflow.js tests/cashflow.test.js
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
        near(p.rows[1].vat, 0, 'no VAT without Bookkeeping');
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

    test('a complete project owed its payment in full brings the cash in the month it is expected', () => {
        nextId = 1;
        const p = run({ projects: [project('Complete', 9000, 9000, null, '2026-01-01', '2026-09-30',
            { payments: [{ month: '2026-12', amount: 9000, paid: false, full: true }] })], scenario: RF.settingsFor('worst') });
        near(p.rows[0].income, 0, 'not this month');
        near(p.rows[2].income, 9000, 'December, as expected');
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

    // ---- The year's result ----

    const row = (date, amount, vat, open) => ({ date, amount, excluded: false, party: '', vat: vat === undefined ? null : vat, open: !!open });

    test('each month of the year so far, without the VAT, always from January', () => {
        const months = CF.yearMonths([
            row('2026-08-05', 9600, -1600), row('2026-08-20', -71.39, 11.9),
            row('2026-09-10', -1200, null, true), row('2026-10-02', 4800, -800),
            row('2025-12-30', 5000)
        ], NOW, null);
        eq(months.length, 10, 'January to now');
        eq([months[0].label, months[0].rows, months[0].result], ['Jan 2026', 0, 0], 'January, nothing imported');
        eq([months[7].income, months[7].costs, months[7].result], [8000, 59.49, 7940.51], 'August net');
        eq([months[8].result, months[8].open], [-1200, 1], 'September: one entry without invoice');
        eq(months[9].result, 4000, 'October so far');
        eq(months[7].closing, null, 'no balance, no closing');
    });

    test('the year: actual so far plus the plan to December', () => {
        const p = run({
            months: 6,
            balances: [{ id: 1, amount: 20000, as_of: '2026-10-01' }],
            transactions: [row('2026-09-15', 6000, -1000), row('2026-10-03', -500, 0)],
            costs: [{ id: 1, kind: 'recurring', amount: 1000, interval_months: 1, start_month: '2026-10', day: 28 }]
        });
        const y = CF.yearResult([row('2026-09-15', 6000, -1000), row('2026-10-03', -500, 0)], p, NOW);
        eq([y.year, y.actual, y.months.length], [2026, 4500, 10], 'January to October');
        near(y.planned, -3000, 'rent for October to December');
        near(y.projected, 1500, 'year end');
        eq([y.fixedRest, y.plannedRest], [3000, 0], 'costs until December');
        near(y.months[8].closing, 20000, 'end of September');
    });

    // ---- Recurring costs spotted in Bookkeeping ----

    const bank = (date, party, amount, vat) => ({ date, amount, excluded: false, party, vat: vat === undefined ? null : vat });

    test('a monthly payment becomes a suggestion, net of the VAT it gives back', () => {
        const list = CF.recurringSuggestions([
            bank('2026-07-26', 'Adobe Systems Software', -71.39, 11.9),
            bank('2026-08-26', 'Adobe Systems Software', -71.39, 11.9),
            bank('2026-09-26', 'Adobe Systems Software', -71.39, 11.9),
            bank('2026-09-28', 'Alpenblick Hotels GmbH', 9600)
        ], [], [], TODAY);
        eq(list.length, 1, 'one suggestion');
        eq([list[0].name, list[0].interval, list[0].day, list[0].start_month, list[0].count],
            ['Adobe Systems Software', 1, 26, '2026-09', 3]);
        near(list[0].amount, 59.49, 'net');
    });

    test('one read invoice tells the VAT for the whole series', () => {
        const list = CF.recurringSuggestions([
            bank('2026-07-26', 'Adobe Systems Software', -71.39), bank('2026-08-26', 'Adobe Systems Software', -71.39),
            bank('2026-09-26', 'Adobe Systems Software', -71.39, 11.9)
        ], [], [], TODAY);
        near(list[0].amount, 59.49, 'net');
        eq(list[0].net, true, 'net');
        const unknown = CF.recurringSuggestions([
            bank('2026-07-26', 'Adobe Systems Software', -71.39), bank('2026-08-26', 'Adobe Systems Software', -71.39),
            bank('2026-09-26', 'Adobe Systems Software', -71.39)
        ], [], [], TODAY);
        eq([unknown[0].amount, unknown[0].net], [71.39, false], 'as paid');
    });

    test('quarterly needs three, yearly two; small changes in amount still count', () => {
        const list = CF.recurringSuggestions([
            bank('2026-01-15', 'Steuerberater Huber', -900), bank('2026-04-15', 'Steuerberater Huber', -950),
            bank('2026-07-15', 'Steuerberater Huber', -900),
            bank('2025-10-01', 'Uniqa Versicherung AG', -1200), bank('2026-10-01', 'Uniqa Versicherung AG', -1200)
        ], [], [], TODAY);
        eq(list.map(s => [s.name, s.interval]), [['Steuerberater Huber', 3], ['Uniqa Versicherung AG', 12]]);
    });

    test('no suggestion when the payments stopped, are irregular, too few, covered or turned down', () => {
        const stopped = [bank('2026-03-05', 'Hetzner Online GmbH', -38.56), bank('2026-04-05', 'Hetzner Online GmbH', -38.56),
            bank('2026-05-05', 'Hetzner Online GmbH', -38.56)];
        eq(CF.recurringSuggestions(stopped, [], [], TODAY).length, 0, 'stopped in May');

        const irregular = [bank('2026-06-01', 'Kaffee Hummel', -40), bank('2026-06-09', 'Kaffee Hummel', -40),
            bank('2026-08-20', 'Kaffee Hummel', -40), bank('2026-09-02', 'Kaffee Hummel', -40)];
        eq(CF.recurringSuggestions(irregular, [], [], TODAY).length, 0, 'irregular');

        const two = [bank('2026-08-05', 'A1 Telekom Austria', -59.9), bank('2026-09-05', 'A1 Telekom Austria', -59.9)];
        eq(CF.recurringSuggestions(two, [], [], TODAY).length, 0, 'two monthly ones are not enough');

        const three = two.concat([bank('2026-10-05', 'A1 Telekom Austria', -59.9)]);
        eq(CF.recurringSuggestions(three, [], [], TODAY).length, 1, 'three are');
        eq(CF.recurringSuggestions(three, [{ kind: 'recurring', name: 'Telekom (Internet)', amount: 49.9, interval_months: 1 }], [], TODAY).length, 0, 'covered by name');
        eq(CF.recurringSuggestions(three, [{ kind: 'recurring', name: 'Internet', amount: 59.9, interval_months: 1 }], [], TODAY).length, 0, 'covered by amount');
        eq(CF.recurringSuggestions(three, [{ kind: 'recurring', name: 'Telekom', amount: 59.9, interval_months: 1, end_month: '2026-06' }], [], TODAY).length, 1, 'an ended cost covers nothing');
        eq(CF.recurringSuggestions(three, [], ['telekom austria|1'], TODAY).length, 0, 'turned down');
    });

    test('any count of months up to 36, the default for anything else', () => {
        eq(run({ months: 3 }).rows.map(r => r.label), ['Oct 2026', 'Nov 2026', 'Dec 2026'], 'until December');
        eq(run({ months: 0 }).rows.length, 12, 'nothing is a year');
        eq(run({ months: 'year' }).rows.length, 12, 'not a number');
    });

    test('the horizon totals of fixed and planned costs', () => {
        const p = run({
            months: 6,
            costs: [
                { id: 1, kind: 'recurring', amount: 1000, interval_months: 1, start_month: '2026-10', day: 28 },
                { id: 2, kind: 'once', amount: 3000, start_month: '2026-12' },
                { id: 3, kind: 'once', amount: 500, start_month: '2027-06' }
            ]
        });
        near(p.kpis.fixedTotal, 6000, 'six months of rent');
        near(p.kpis.plannedTotal, 3000, 'only what falls inside the six months');
    });

    // ------------------------------------------------------------------
    // Debts
    // ------------------------------------------------------------------

    test('interest accrues day by day, to today and to the repayment', () => {
        const i = CF.debtInterest({ amount: 100000, rate: 5, start_date: '2026-01-01', end_date: '2026-12-31' }, TODAY);
        eq(i.days, 281, 'Jan 1 to Oct 9');
        near(i.toDate, 3849.32, 'so far');
        near(i.total, 4986.30, 'until the repayment');
        eq(i.repaid, false);
        eq(i.daysLeft, 83);
    });

    test('a loan without an end date has interest so far, none in total', () => {
        const i = CF.debtInterest({ amount: 20000, rate: 3.5, start_date: '2025-10-09' }, TODAY);
        eq(i.days, 365);
        near(i.toDate, 700);
        eq(i.total, null);
    });

    test('a repaid loan stops at its end; one not started has none yet', () => {
        const done = CF.debtInterest({ amount: 36500, rate: 10, start_date: '2026-01-01', end_date: '2026-01-11' }, TODAY);
        eq(done.days, 10);
        near(done.toDate, 100);
        eq(done.repaid, true);
        const later = CF.debtInterest({ amount: 10000, rate: 4, start_date: '2026-12-01' }, TODAY);
        eq(later.started, false);
        near(later.toDate, 0);
    });

    test('the debts summed: what is owed and its interest', () => {
        const sum = CF.debtSummary([
            { id: 1, amount: 100000, rate: 5, start_date: '2026-01-01', end_date: '2026-12-31' },
            { id: 2, amount: 20000, rate: 3.5, start_date: '2025-10-09' },
            { id: 3, amount: 36500, rate: 10, start_date: '2026-01-01', end_date: '2026-01-11' }
        ], TODAY);
        near(sum.outstanding, 120000, 'the repaid one is not owed');
        near(sum.interestToDate, 4549.32);
        near(sum.interestTotal, 4986.30, 'only loans with an end date');
        eq(sum.undatedCount, 1);
    });

    test('a loan with a repayment date goes out in that month, with its interest', () => {
        const p = run({
            months: 12,
            debts: [
                { id: 1, name: 'Loan', amount: 36500, rate: 10, start_date: '2026-01-01', end_date: '2027-01-01' },
                { id: 2, name: 'Open-ended', amount: 5000, rate: 5, start_date: '2026-01-01' },
                { id: 3, name: 'Repaid', amount: 1000, rate: 5, start_date: '2026-01-01', end_date: '2026-10-01' }
            ]
        });
        near(p.rows[3].debt, 36500 + 3650, 'January: amount plus 365 days of interest');
        near(p.rows[3].debtInterest, 3650);
        near(p.rows[3].out, 40150, 'counted as money out');
        eq(p.rows[3].items.debts.length, 1);
        near(p.kpis.debtTotal, 40150, 'no other loan in the plan');
    });

    test('a cost of this month is paid only once Bookkeeping has it; until then it is open', () => {
        const costs = [
            { id: 1, name: 'Office rent', kind: 'recurring', amount: 1000, interval_months: 1, start_month: '2026-01', day: 1 },
            { id: 2, name: 'Adobe', kind: 'recurring', amount: 60, interval_months: 1, start_month: '2026-01', day: 2 },
            { id: 3, name: 'Insurance', kind: 'recurring', amount: 300, interval_months: 1, start_month: '2026-01', day: 28 }
        ];
        const tx = [
            { date: '2026-10-02', amount: -72, vat: 12, party: 'Adobe Systems' },
            { date: '2026-10-05', amount: -300, vat: 0, party: 'Muster Versicherung AG' }
        ];
        const p = run({ costs, transactions: tx });
        const item = id => p.rows[0].items.costs.find(c => c.cost.id === id);
        eq([item(1).paid, item(1).due], [false, true], 'the rent: due since the 1st, not booked - open');
        eq(item(2).paid, true, 'Adobe: booked by name');
        eq(item(3).paid, true, 'insurance: booked by amount, before its day');
        near(p.rows[0].out, 1000, 'only the open rent still goes out of the balance');

        const y = CF.yearResult(tx, run({ costs, months: 3, transactions: tx }), NOW);
        near(y.costs, 60 + 300, 'so far: only what Bookkeeping has');
        near(y.actual, -360, 'and the result so far with it');
        near(y.costsRest, 1000 + 2 * 1360, 'still to pay: the rent this month, then Nov and Dec');
        near(y.costsYear, 360 + 1000 + 2 * 1360);
    });

    test('a bank row pays one cost only', () => {
        const costs = [
            { id: 1, name: 'Tool A', kind: 'recurring', amount: 100, interval_months: 1, start_month: '2026-01', day: 1 },
            { id: 2, name: 'Tool B', kind: 'recurring', amount: 100, interval_months: 1, start_month: '2026-01', day: 1 }
        ];
        const p = run({ costs, transactions: [{ date: '2026-10-01', amount: -100, vat: 0, party: 'Someone' }] });
        eq(p.rows[0].items.costs.filter(c => c.paid).length, 1, 'one of the two');
        near(p.rows[0].out, 100);
    });

    test('a cost on the 31st falls on the month\'s last day: salaries at the month\'s end', () => {
        const costs = [{ id: 1, name: 'Salaries', kind: 'recurring', amount: 9000, interval_months: 1, start_month: '2026-01', day: 31 }];
        const before = run({ costs });
        eq(before.rows[0].items.costs[0].due, false, 'not due on the 9th');
        near(before.rows[0].out, 9000, 'so it still goes out this month');
        const nov = CF.plan({ projects: [], costs, transactions: [], balances: [], settings: CF.DEFAULT_SETTINGS,
            months: 3, now: { year: 2026, month: 10 }, today: '2026-11-30' });
        eq(nov.rows[0].items.costs[0].due, true, 'due on 30 November, the last day of the month');
        eq(CF.recurringSuggestions([
            { date: '2026-07-31', amount: -900, party: 'Payroll' },
            { date: '2026-08-31', amount: -900, party: 'Payroll' },
            { date: '2026-09-30', amount: -900, party: 'Payroll' }
        ], [], [], TODAY).map(x => x.day), [31], 'paid on the last day: suggested at month end');
    });

    test('the year in full: revenue, costs and result', () => {
        nextId = 1;
        const p = run({
            months: 3,
            projects: [project('In Progress', 6000, 6000, 100, '2026-09-01', '2026-11-30')],
            costs: [{ id: 1, kind: 'recurring', amount: 1000, interval_months: 1, start_month: '2026-01', day: 28 }],
            transactions: [
                { date: '2026-03-10', amount: 12000, vat: -2000 },
                { date: '2026-04-10', amount: -1200, vat: 200 }
            ]
        });
        const y = CF.yearResult([
            { date: '2026-03-10', amount: 12000, vat: -2000 },
            { date: '2026-04-10', amount: -1200, vat: 200 }
        ], p, NOW);
        near(y.income, 10000, 'so far, without VAT');
        near(y.costs, 1000, 'so far, without VAT');
        near(y.incomeRest, 6000, 'the project, in November');
        near(y.costsRest, 3000, 'rent Oct to Dec');
        near(y.revenue, 16000);
        near(y.costsYear, 4000);
        near(y.projected, 12000, 'revenue less costs');
    });

    // ------------------------------------------------------------------
    // VAT
    // ------------------------------------------------------------------

    const vb = (id, date, amount, vat, extra) => Object.assign({ id, date, amount, excluded: false, party: '', vat: vat === undefined ? null : vat, open: false }, extra || {});

    test('VAT: due on the 15th of the second month after the quarter', () => {
        eq(CF.vatDue('2026-Q1'), '2026-05-15');
        eq(CF.vatDue('2026-Q3'), '2026-11-15');
        eq(CF.vatDue('2026-Q4'), '2027-02-15', 'into the next year');
        eq(CF.quarterOf('2026-10-09'), '2026-Q4');
        eq(CF.shiftQuarter('2026-Q1', -1), '2025-Q4');
        eq(CF.vatFrom({}, TODAY), '2026-Q3', 'by default the quarter before today');
        eq(CF.vatFrom({ vat_from: '2027-Q1' }, TODAY), '2026-Q4', 'never after today');
    });

    test('VAT: what each quarter comes to, from the bank rows', () => {
        const tx = [
            vb(1, '2026-08-03', 12000, -2000),          // our invoice: 2.000 owed
            vb(2, '2026-09-20', -600, 100),             // a cost: 100 back
            vb(3, '2026-09-25', -50, null, { open: true }),
            vb(4, '2026-10-02', -1200, 200),            // Q4: 200 back so far
            vb(5, '2026-07-01', 5000, -1000, { excluded: true })
        ];
        const q = CF.vatQuarters(tx, {}, TODAY);
        eq(q.map(x => x.key), ['2026-Q3', '2026-Q4']);
        near(q[0].collected, 2000);
        near(q[0].deductible, 100);
        near(q[0].owed, 1900, 'owed, the excluded row left out');
        eq(q[0].open, 1, 'one row still without its invoice');
        eq([q[0].settled, q[0].overdue, q[0].running], [false, false, false]);
        near(q[1].owed, -200, 'Q4 so far: a refund');
        eq(q[1].running, true);
    });

    test('VAT: planned on its due day, settled once a bank row is linked', () => {
        const tx = [vb(1, '2026-08-03', 12000, -2000), vb(2, '2026-10-02', -1200, 200)];
        const p = run({ transactions: tx, balances: [{ id: 1, amount: 20000, as_of: '2026-10-01' }] });
        near(p.rows[1].vat, 2000, 'Q3 in November');
        near(p.rows[1].out, 2000, 'out of the account');
        near(p.rows[4].vat, -200, 'Q4 refund in February');
        near(p.rows[4].in, 200);
        near(p.kpis.vatOwed, 1800, 'owed today: Q3 less what Q4 brings back so far');
        eq(p.kpis.vatNext.label, 'Q3 2026');

        const paid = vb(9, '2026-11-14', -2000, null, { party: 'Finanzamt Österreich' });
        const all = CF.markVatPayments(tx.concat(paid), { '2026-Q3': { rows: [9] } });
        const later = run({ transactions: all, today: '2026-11-20', now: { year: 2026, month: 10 } });
        const q3 = later.vat.find(x => x.key === '2026-Q3');
        eq(q3.settled, true);
        near(q3.paid, 2000);
        near(later.rows[0].vat, 0, 'nothing planned for Q3 any more');
        near(later.kpis.vatOwed, -200);
    });

    test('VAT: unpaid after its due day, it is overdue and lands in this month', () => {
        const tx = [vb(1, '2026-08-03', 12000, -2000)];
        const p = run({ transactions: tx, today: '2026-12-02', now: { year: 2026, month: 11 } });
        const q3 = p.vat.find(x => x.key === '2026-Q3');
        eq(q3.overdue, true);
        near(p.rows[0].vat, 2000, 'in December');
    });

    test('VAT: a linked payment is neither cost nor income, nor a recurring cost', () => {
        const tx = CF.markVatPayments([
            vb(1, '2026-08-03', 12000, -2000),
            vb(2, '2026-08-14', -1500, null, { party: 'Finanzamt Österreich' })
        ], { '2026-Q2': { rows: [2] } });
        const months = CF.yearMonths(tx, NOW, null);
        const aug = months.find(m => m.label.indexOf('Aug') === 0);
        near(aug.costs, 0, 'the VAT payment is no cost');
        near(aug.income, 10000);
        eq(tx[1].open, false, 'needs no invoice');
    });

    test('VAT: the tax office is offered first, after the quarter', () => {
        const tx = [
            vb(1, '2026-08-03', 12000, -2000),
            vb(2, '2026-09-30', -2000, null, { party: 'Finanzamt Österreich' }),   // inside the quarter
            vb(3, '2026-11-10', -2000, null, { party: 'Office rent' }),
            vb(4, '2026-11-14', -2600, null, { party: 'Finanzamt Österreich' }),   // with other taxes in it
            vb(5, '2026-11-12', 300, null, { party: 'Finanzamt Österreich' })      // wrong direction
        ];
        const q3 = CF.vatQuarters(tx, {}, '2026-11-20')[0];
        const c = CF.vatCandidates(q3, tx);
        eq(c.map(x => x.row.id), [4, 3], 'the tax office first, then by amount');
        eq(c[1].exact, true);
        eq(CF.vatSuggestion(q3, tx).row.id, 4);
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
