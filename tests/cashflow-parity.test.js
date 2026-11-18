/**
 * Parity test: includes/Cashflow.php against the browser code it ports.
 *
 *     node tests/cashflow-parity.test.js
 *
 * Builds many random but reproducible data sets - projects with budgets,
 * chances and expected payments, costs, debts, balances, bank rows with VAT
 * and tax office payments - runs the Financials arithmetic on each in both
 * languages and compares every number: the months, the KPIs, VAT quarters,
 * the year's result and the debts. Also the bank amount parser and the
 * amount column detection from bookkeeping.js.
 *
 * Needs node and php on the PATH. Exits with 1 on the first difference.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// ---------------------------------------------------------------------------
// The browser code, as the page loads it
// ---------------------------------------------------------------------------

const context = vm.createContext({ console });
context.globalThis = context;
['assets/js/format.js', 'assets/js/project-payments.js', 'assets/js/revenue-forecast.js', 'assets/js/cashflow.js']
    .forEach(file => vm.runInContext(read(file), context, { filename: file }));
const CF = context.Cashflow;
const RF = context.RevenueForecast;

// bookkeeping.js draws the page; only its pure helpers are taken out of it.
function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('bookkeeping.js has no function ' + name);
    let depth = 0;
    for (let i = source.indexOf('{', source.indexOf(')', start)); i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error('Unbalanced braces in ' + name);
}
const bookkeeping = read('assets/js/bookkeeping.js');
const helpers = vm.createContext({});
vm.runInContext(['parseDecimalValue', 'looksLikeDateColumn', 'detectAmountColumn']
    .map(name => extractFunction(bookkeeping, name)).join('\n') + '\nthis.h = { parseDecimalValue, looksLikeDateColumn, detectAmountColumn };', helpers);
const BK = helpers.h;

// ---------------------------------------------------------------------------
// Random data, the same every run
// ---------------------------------------------------------------------------

let seed = 20261118;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = list => list[int(0, list.length - 1)];
const chance = p => rand() < p;
const pad = n => String(n).padStart(2, '0');
const monthAt = (now, offset) => { const c = RF.calendarMonth(offset, now); return c.year + '-' + pad(c.month + 1); };
const dayAt = (now, offset, day) => {
    const c = RF.calendarMonth(offset, now);
    const last = new Date(Date.UTC(c.year, c.month + 1, 0)).getUTCDate();
    return c.year + '-' + pad(c.month + 1) + '-' + pad(Math.min(day, last));
};
const money = (lo, hi) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;

const PARTIES = ['Hetzner Online GmbH', 'Google Ireland Ltd', 'Finanzamt Wien', 'Miete Neustiftgasse', 'A1 Telekom Austria AG',
    'Kunde Alpha GmbH', 'Beta Consulting OG', 'Adobe Systems', 'Gehalt Livio', 'Gehalt Markus', 'Versicherung Uniqa', ''];
const STAGES = ['Lead', 'Negotiation', 'Proposal', 'In Progress', 'Complete', 'Lost'];

function dataset(now, today) {
    let id = 1;
    const projects = Array.from({ length: int(0, 14) }, () => {
        const start = int(-10, 4);
        const end = chance(0.8) ? start + int(-1, 10) : null;
        const min = chance(0.85) ? money(0, 60000) : null;
        const max = chance(0.7) && min !== null ? min + money(0, 20000) : (chance(0.2) ? money(0, 50000) : null);
        let payments = null;
        if (chance(0.5)) {
            if (chance(0.2)) {
                payments = [{ month: monthAt(now, (end ?? start) + int(0, 3)), amount: money(1000, 40000), paid: chance(0.3), full: true }];
            } else {
                payments = Array.from({ length: int(1, 5) }, () => ({ month: monthAt(now, start + int(-2, 12)), amount: money(500, 20000), paid: chance(0.35) }));
            }
            if (chance(0.5)) payments = JSON.stringify(payments);
        }
        return {
            id: id++, name: pick(['Lagebild', 'Workshop', 'Audit', 'Training', 'Studie']) + ' ' + id, company: pick(['ACME', 'Muster', '', null]),
            stage: pick(STAGES), budget_min: min === null ? null : String(min), budget_max: max === null ? null : max,
            success_chance: chance(0.85) ? int(0, 100) : null,
            start_date: chance(0.95) ? dayAt(now, start, int(1, 28)) : null,
            estimated_completion: end === null ? null : dayAt(now, end, int(1, 28)),
            payments, review_status: chance(0.1) ? 'pending' : null
        };
    });

    const costs = Array.from({ length: int(0, 10) }, () => {
        const once = chance(0.3);
        return {
            id: id++, name: pick(PARTIES.filter(Boolean)) + (chance(0.3) ? ' Abo' : ''), category: pick(['IT', 'Office', null]),
            amount: money(5, 4000), kind: once ? 'once' : 'recurring', interval_months: once ? 1 : pick([1, 1, 3, 6, 12]),
            start_month: monthAt(now, int(-14, 6)), end_month: chance(0.25) ? monthAt(now, int(-3, 18)) : null, day: pick([1, 5, 15, 28, 31])
        };
    });

    const balances = Array.from({ length: int(0, 3) }, () => ({ id: id++, amount: money(-5000, 80000), as_of: dayAt(now, int(-8, 0), int(1, 28)), note: null }));

    const debts = Array.from({ length: int(0, 3) }, () => {
        const start = dayAt(now, int(-24, 1), int(1, 28));
        return { id: id++, name: 'Darlehen ' + id, lender: pick(['Bank', 'Familie', null]), amount: money(1000, 100000), start_date: start,
                 end_date: chance(0.7) ? dayAt(now, int(-3, 30), int(1, 28)) : null, rate: pick([0, 1.5, 3.25, 7]) };
    });

    const transactions = Array.from({ length: int(0, 120) }, () => {
        const amount = chance(0.35) ? money(10, 30000) : -money(5, 6000);
        const party = pick(PARTIES);
        const vat = chance(0.5) ? Math.round(-Math.sign(amount) * Math.abs(amount) * pick([0.2, 0.1, 0.1667]) * 100) / 100 : null;
        return { id: id++, date: dayAt(now, int(-14, 0), int(1, 31)), amount, excluded: chance(0.05), party,
                 text: party + ' Ref ' + int(1, 999) + (chance(0.05) ? ' UVA 07-09' : ''), vat, open: chance(0.2) };
    }).filter(t => t.date <= today);

    const quarters = [CF.shiftQuarter(CF.quarterOf(today), -1), CF.shiftQuarter(CF.quarterOf(today), -2)];
    const vatLinks = {};
    quarters.forEach(q => {
        if (chance(0.3) && transactions.length) vatLinks[q] = { rows: [pick(transactions).id], settled: false };
        else if (chance(0.2)) vatLinks[q] = { rows: [], settled: true };
    });
    const settings = { buffer: chance(0.5) ? money(0, 20000) : 0, vat_from: chance(0.5) ? CF.shiftQuarter(CF.quarterOf(today), -int(0, 3)) : '', vat_links: vatLinks };

    return { projects, costs, balances, debts, transactions, settings };
}

const TODAYS = ['2026-11-18', '2026-10-09', '2026-01-31', '2026-12-31', '2027-02-28', '2026-03-01', '2026-06-30'];
const cases = [];
for (let n = 0; n < 160; n++) {
    const today = TODAYS[n % TODAYS.length];
    const now = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 };
    const input = dataset(now, today);
    const preset = pick(['worst', 'realistic', 'best']);
    const overrides = chance(0.25) ? { budget: pick(['low', 'mid', 'high']), chance: pick(['as', 'all']), stages: ['Lead', 'In Progress'],
                                       excluded: input.projects.slice(0, 2).map(p => p.id) } : {};
    cases.push({ input, now, today, preset, overrides, months: pick([1, 3, 6, 12, 24, 36]) });
}

const decimals = ['1.234,56', '-1.234,56', '1,234.56', '(12.00)', '12,50 €', 'EUR 99.9', '07.03.2026', '1234', '', '  -0,5 ',
    "1'234.50", '+3,00', 'abc', '1 234,56', '1 234,56', '-,50', '12.345', '€ -45,10', 'USD 1,5', '0,00'];

const columnSets = Array.from({ length: 30 }, () => {
    const names = ['Buchungsdatum', 'Betrag', 'Partnername', 'Verwendungszweck', 'Saldo', 'Valuta', 'Wert'].filter(() => chance(0.7));
    const rows = Array.from({ length: int(1, 12) }, () => {
        const data = {};
        names.forEach(c => {
            data[c] = chance(0.15) ? '' : (/datum|valuta/i.test(c) ? '07.03.2026' : (/partner|zweck/i.test(c) ? pick(PARTIES) : pick(['-12,50', '1.200,00', '3', 'x'])));
        });
        return { data };
    });
    return { columns: names, rows, date_column: chance(0.5) ? 'Buchungsdatum' : null };
});

// ---------------------------------------------------------------------------
// Both sides
// ---------------------------------------------------------------------------

function jsSide(c) {
    const scenario = Object.assign(RF.settingsFor(c.preset), c.overrides.budget ? {
        budget: c.overrides.budget, chance: c.overrides.chance,
        stages: RF.STAGE_KEYS.filter(k => c.overrides.stages.indexOf(k) >= 0),
        excluded: Object.fromEntries(c.overrides.excluded.map(id => [id, true]))
    } : {});
    const transactions = CF.markVatPayments(c.input.transactions, c.input.settings.vat_links);
    const input = Object.assign({}, c.input, { transactions, scenario, months: c.months, now: c.now, today: c.today });
    const plan = CF.plan(input);
    const twelve = CF.plan(Object.assign({}, input, { months: 12 }));
    return { plan, year: CF.yearResult(transactions, twelve, c.now), debts: CF.debtSummary(c.input.debts, c.today) };
}

const php = JSON.parse(execFileSync('php', [path.join(__dirname, 'cashflow-parity.php')], {
    input: JSON.stringify({ cases, decimals, columns: columnSets }),
    maxBuffer: 512 * 1024 * 1024
}).toString());

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

let compared = 0;
function same(label, a, b) {
    compared++;
    const num = v => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
    if (JSON.stringify(num(a)) !== JSON.stringify(num(b))) {
        console.error(`DIFFERENT ${label}\n  js:  ${JSON.stringify(a)}\n  php: ${JSON.stringify(b)}`);
        process.exit(1);
    }
}
const ROW_KEYS = { offset: 'offset', income: 'income', fixed: 'fixed', planned: 'planned', debt: 'debt', debtInterest: 'debt_interest',
                   vat: 'vat', opening: 'opening', in: 'in', out: 'out', net: 'net', closing: 'closing' };

cases.forEach((c, i) => {
    const js = jsSide(c);
    const ph = php.cases[i];
    const at = `case ${i} (today ${c.today}, ${c.preset}, ${c.months} months)`;

    same(`${at} rows`, js.plan.rows.length, ph.plan.rows.length);
    js.plan.rows.forEach((r, k) => {
        Object.keys(ROW_KEYS).forEach(key => same(`${at} row ${k} ${key}`, r[key], ph.plan.rows[k][ROW_KEYS[key]]));
        same(`${at} row ${k} cost items`, r.items.costs.map(x => [x.amount, x.paid]), ph.plan.rows[k].items.costs.map(x => [x.amount, x.paid]));
        same(`${at} row ${k} income items`, r.items.income.map(x => [x.projectId, x.kind, x.expected]),
            ph.plan.rows[k].items.income.map(x => [x.project_id, x.kind, x.expected]));
    });

    const k = js.plan.kpis, kp = ph.plan.kpis;
    [['balance', 'balance'], ['vatOwed', 'vat_owed'], ['vatTotal', 'vat_total'], ['incomeNext3', 'income_next3'],
     ['incomeTotal', 'income_total'], ['outTotal', 'out_total'], ['fixedPerMonth', 'fixed_per_month'], ['fixedTotal', 'fixed_total'],
     ['plannedTotal', 'planned_total'], ['debtTotal', 'debt_total'], ['end', 'end']].forEach(([a, b]) => same(`${at} kpi ${a}`, k[a], kp[b]));
    same(`${at} kpi lowest`, k.lowest && [k.lowest.offset, k.lowest.amount], kp.lowest && [kp.lowest.offset, kp.lowest.amount]);
    same(`${at} kpi belowZero`, k.belowZero && k.belowZero.offset, kp.below_zero && kp.below_zero.offset);
    same(`${at} kpi belowBuffer`, k.belowBuffer && k.belowBuffer.offset, kp.below_buffer && kp.below_buffer.offset);
    ['overdue', 'undated', 'later'].forEach(key => same(`${at} kpi ${key}`, [k[key].count, k[key].amount], [kp[key].count, kp[key].amount]));
    same(`${at} kpi vatNext`, k.vatNext && [k.vatNext.key, k.vatNext.owed, k.vatNext.overdue], kp.vat_next && [kp.vat_next.key, kp.vat_next.owed, kp.vat_next.overdue]);

    same(`${at} income items`, js.plan.income.map(x => [x.projectId, x.kind, x.offset, x.overdue, x.net, x.expected, x.counted]),
        ph.plan.income.map(x => [x.project_id, x.kind, x.offset, x.overdue, x.net, x.expected, x.counted]));
    same(`${at} missing`, js.plan.missing.map(x => [x.id, x.gaps]), ph.plan.missing.map(x => [x.id, x.gaps]));
    same(`${at} past`, js.plan.past.map(m => [m.offset, m.income, m.expenses, m.rows, m.closing]),
        ph.plan.past.map(m => [m.offset, m.income, m.expenses, m.rows, m.closing]));
    same(`${at} vat`, js.plan.vat.map(q => [q.key, q.due, q.collected, q.deductible, q.owed, q.open, q.running, q.settled, q.manual, q.nil, q.paid, q.overdue]),
        ph.plan.vat.map(q => [q.key, q.due, q.collected, q.deductible, q.owed, q.open, q.running, q.settled, q.manual, q.nil, q.paid, q.overdue]));
    same(`${at} balance`, js.plan.balance && [js.plan.balance.amount, js.plan.balance.movement, js.plan.balance.rows, js.plan.balance.lastRow],
        ph.plan.balance && [ph.plan.balance.amount, ph.plan.balance.movement, ph.plan.balance.rows, ph.plan.balance.last_row]);

    const y = js.year, yp = ph.year;
    [['actual', 'actual'], ['planned', 'planned'], ['projected', 'projected'], ['income', 'income'], ['costs', 'costs'],
     ['incomeRest', 'income_rest'], ['costsRest', 'costs_rest'], ['revenue', 'revenue'], ['costsYear', 'costs_year'],
     ['fixedRest', 'fixed_rest'], ['plannedRest', 'planned_rest']].forEach(([a, b]) => same(`${at} year ${a}`, y[a], yp[b]));
    same(`${at} year months`, y.months.map(m => [m.offset, m.income, m.costs, m.result, m.open, m.rows, m.closing]),
        yp.months.map(m => [m.offset, m.income, m.costs, m.result, m.open, m.rows, m.closing]));

    const d = js.debts, dp = ph.debts;
    same(`${at} debts`, [d.count, d.openCount, d.outstanding, d.interestToDate, d.interestTotal, d.undatedCount],
        [dp.count, dp.open_count, dp.outstanding, dp.interest_to_date, dp.interest_total, dp.undated_count]);
    same(`${at} debt list`, d.list.map(x => [x.interest.days, x.interest.toDate, x.interest.total, x.interest.repaid, x.interest.daysLeft]),
        dp.list.map(x => [x.interest.days, x.interest.to_date, x.interest.total, x.interest.repaid, x.interest.days_left]));
});

decimals.forEach((text, i) => same(`parseDecimal(${JSON.stringify(text)})`, BK.parseDecimalValue(text), php.decimals[i]));
columnSets.forEach((set, i) => same(`detectAmountColumn set ${i}`,
    BK.detectAmountColumn(set.columns.map(name => ({ name })), set.rows, name => name === set.date_column || BK.looksLikeDateColumn(name)),
    php.columns[i]));

// How much of the arithmetic the data sets actually reached.
const reached = { 'a balance': 0, 'VAT owed': 0, 'a VAT quarter settled by a bank row': 0, 'a loan repaid in the plan': 0,
                  'a cost already booked this month': 0, 'an overdue payment': 0, 'an undated project': 0, 'a project left out': 0 };
php.cases.forEach(({ plan }) => {
    if (plan.balance) reached['a balance']++;
    if (plan.kpis.vat_owed) reached['VAT owed']++;
    if (plan.vat.some(q => q.payment_rows.length)) reached['a VAT quarter settled by a bank row']++;
    if (plan.kpis.debt_total) reached['a loan repaid in the plan']++;
    if (plan.rows.some(r => r.items.costs.some(x => x.paid))) reached['a cost already booked this month']++;
    if (plan.kpis.overdue.count) reached['an overdue payment']++;
    if (plan.kpis.undated.count) reached['an undated project']++;
    if (plan.missing.length) reached['a project left out']++;
});
console.log('Data sets with ' + Object.entries(reached).map(([what, n]) => `${what}: ${n}`).join(', '));
console.log(`OK - ${cases.length} data sets, ${decimals.length} amounts, ${columnSets.length} column sets: ${compared} comparisons, all equal.`);
