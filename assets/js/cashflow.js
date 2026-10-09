/**
 * Cashflow: the arithmetic behind the Financials tab.
 *
 * No DOM - months, amounts and sums only, so every number on the tab comes
 * from one place and can be checked on its own (tests/cashflow.test.js).
 * financials.js draws the results.
 *
 * Money in: what the projects bring, under the same scenario as the revenue
 * forecast (stages, budget end, chance, single projects switched off) - but
 * as cash, not as revenue: an expected payment in its month, and what the
 * payments leave of the budget in one sum at the project's end month (the
 * final invoice), not spread. A project past its end, or a payment past its
 * month, is due now: it lands in this month and counts as overdue. Without an
 * end date, the rest has no month and is listed apart. Complete projects
 * still bring their unpaid payments, in full.
 *
 * VAT is left out: project amounts are net, and costs are entered net too.
 * Over a VAT period that is what stays in the account - the VAT collected
 * is passed on, the VAT in our costs comes back - only its timing is not
 * shown.
 *
 * Money out: our costs, net. A recurring cost every 1, 3, 6 or 12 months
 * from its first month to its last; one already due this month (its day has
 * passed) is taken to be in the balance already. A planned cost once, in its
 * month.
 *
 * The balance today is the one last entered, moved by every bookkeeping row
 * dated after it (rows left out of the month totals do not count). Each month
 * then closes at its opening plus what comes in less what goes out.
 *
 * Months are offsets from the current month, as in revenue-forecast.js.
 */
(function (root) {
    'use strict';

    const RF = root.RevenueForecast;
    const PP = root.ProjectPayments;

    const HORIZONS = [6, 12, 24];
    const DEFAULT_HORIZON = 12;
    // Past months shown from Bookkeeping, before this one.
    const PAST_MONTHS = 6;

    const DEFAULT_SETTINGS = { buffer: 0 };

    const round2 = n => Math.round(n * 100) / 100;
    const sum = (list, fn) => list.reduce((s, x) => s + (fn ? fn(x) : x), 0);

    function number(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
    }

    function cleanSettings(raw) {
        const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
        return {
            buffer: Math.max(0, number(s.buffer) || 0)
        };
    }

    // ------------------------------------------------------------------
    // Months
    // ------------------------------------------------------------------

    /** "YYYY-MM-DD" -> its day of the month, or null. */
    function dayOf(iso) {
        const m = /^\d{4}-\d{2}-(\d{2})/.exec(String(iso || ''));
        return m ? Number(m[1]) : null;
    }

    /** The last day of a month offset, as "YYYY-MM-DD". */
    function lastDayOf(offset, now) {
        const c = RF.calendarMonth(offset, now);
        const last = new Date(Date.UTC(c.year, c.month + 1, 0)).getUTCDate();
        return c.year + '-' + String(c.month + 1).padStart(2, '0') + '-' + String(last).padStart(2, '0');
    }

    // ------------------------------------------------------------------
    // Money in
    // ------------------------------------------------------------------

    function budgetFor(p, budget) {
        if (budget === 'low') return p.min;
        if (budget === 'high') return p.max;
        return (p.min + p.max) / 2;
    }

    /**
     * Every amount the projects are expected to bring, one item each:
     *   { projectId, name, company, stage, kind: 'payment' | 'final',
     *     offset (month it counts in, null = no date), due (its own month),
     *     overdue, net (full amount), factor, expected (net x factor),
     *     counted (in this scenario) }
     * plus the open projects the forecast cannot use (missing data).
     */
    function incomeItems(projects, scenario, now) {
        const { items, missing } = RF.prepare(projects, now);
        const out = [];

        items.forEach(p => {
            const counted = scenario.stages.indexOf(p.stage) >= 0 && !(scenario.excluded && scenario.excluded[p.id]);
            const factor = scenario.chance === 'all' ? 1 : p.chance / 100;
            const base = { projectId: p.id, name: p.name, company: p.company, stage: p.stage, chance: p.chance, factor, counted };

            p.due.forEach(x => out.push(Object.assign({}, base, {
                kind: 'payment', due: x.o, offset: Math.max(x.o, 0), overdue: x.o < 0, net: x.amount
            })));

            const rest = Math.max(0, budgetFor(p, scenario.budget) - p.planned);
            if (rest > 0.005) {
                out.push(Object.assign({}, base, {
                    kind: 'final',
                    due: p.e,
                    offset: p.e === null ? null : Math.max(p.e, 0),
                    overdue: p.e !== null && p.e < 0,
                    net: rest,
                    partial: p.payments > 0
                }));
            }
        });

        // Finished work still owed: its unpaid payments, certain.
        (projects || []).forEach(p => {
            if (p.stage !== 'Complete' || p.review_status === 'pending') return;
            PP.parse(p.payments).filter(x => !x.paid).forEach(x => {
                const o = RF.offsetOf(x.month, now);
                out.push({
                    projectId: p.id, name: p.name || 'Untitled project', company: p.company || '', stage: 'Complete',
                    chance: 100, factor: 1, counted: true,
                    kind: 'payment', due: o, offset: Math.max(o, 0), overdue: o < 0, net: x.amount
                });
            });
        });

        out.forEach(x => { x.expected = x.net * x.factor; });
        out.sort((a, b) => (a.offset === null) - (b.offset === null) || (a.offset - b.offset) || (a.due - b.due)
            || String(a.name).localeCompare(String(b.name)));
        return { items: out, missing };
    }

    // ------------------------------------------------------------------
    // Money out
    // ------------------------------------------------------------------

    /**
     * Where a cost falls in the next `months` months:
     *   [{ offset, amount, paid }] - paid: a recurring cost whose
     * day this month has already come, so it is in the balance already.
     */
    function costOccurrences(cost, months, now, todayDay) {
        const start = RF.offsetOf(cost.start_month, now);
        if (start === null) return [];
        const amount = number(cost.amount) || 0;
        const make = (offset, paid) => ({ offset, amount, paid: !!paid });

        if (cost.kind === 'once') {
            return start >= 0 && start < months ? [make(start, false)] : [];
        }

        const interval = Math.max(1, number(cost.interval_months) || 1);
        const end = cost.end_month ? RF.offsetOf(cost.end_month, now) : Infinity;
        const out = [];
        // The first occurrence at or after this month, on the cost's rhythm.
        let i = start >= 0 ? start : start + Math.ceil(-start / interval) * interval;
        for (; i < months && i <= end; i += interval) {
            const day = number(cost.day) || 1;
            out.push(make(i, i === 0 && todayDay !== null && day <= todayDay));
        }
        return out;
    }

    /** What the recurring costs come to per month, on average, from now on. */
    function monthlyFixed(costs, now) {
        return sum((costs || []).filter(c => c.kind !== 'once'), c => {
            const end = c.end_month ? RF.offsetOf(c.end_month, now) : Infinity;
            if (end < 0) return 0;
            return (number(c.amount) || 0) / Math.max(1, number(c.interval_months) || 1);
        });
    }

    // ------------------------------------------------------------------
    // The bank
    // ------------------------------------------------------------------

    /** The newest balance entered: latest date, then latest entry. */
    function anchorOf(balances) {
        const list = (balances || []).filter(b => b && /^\d{4}-\d{2}-\d{2}$/.test(String(b.as_of)));
        list.sort((a, b) => (a.as_of < b.as_of ? 1 : a.as_of > b.as_of ? -1 : (b.id || 0) - (a.id || 0)));
        return list[0] || null;
    }

    /**
     * Today's balance: the anchor plus every counted bookkeeping row after
     * its date. null without an anchor.
     */
    function balanceToday(balances, transactions) {
        const anchor = anchorOf(balances);
        if (!anchor) return null;
        const after = (transactions || []).filter(t => !t.excluded && t.date > anchor.as_of);
        const movement = sum(after, t => t.amount);
        const last = after.reduce((d, t) => (t.date > d ? t.date : d), '');
        return {
            amount: round2((number(anchor.amount) || 0) + movement),
            anchor: { id: anchor.id, amount: number(anchor.amount) || 0, asOf: anchor.as_of },
            movement: round2(movement),
            rows: after.length,
            lastRow: last || null
        };
    }

    /**
     * The months before this one, from Bookkeeping: what came in, what went
     * out and - with a balance - where the account stood at each month's end.
     */
    function pastMonths(transactions, now, today) {
        const rows = (transactions || []).filter(t => !t.excluded);
        if (!rows.length) return [];
        const out = [];
        for (let o = -PAST_MONTHS; o < 0; o++) {
            const c = RF.calendarMonth(o, now);
            const prefix = c.year + '-' + String(c.month + 1).padStart(2, '0');
            const inMonth = rows.filter(t => t.date.slice(0, 7) === prefix);
            const end = lastDayOf(o, now);
            out.push({
                offset: o,
                label: RF.monthName(o, now),
                income: round2(sum(inMonth.filter(t => t.amount > 0), t => t.amount)),
                expenses: round2(-sum(inMonth.filter(t => t.amount < 0), t => t.amount)),
                rows: inMonth.length,
                closing: today ? round2(today.amount - sum(rows.filter(t => t.date > end), t => t.amount)) : null
            });
        }
        // Months before the first imported row say nothing; leave them out.
        const first = out.findIndex(m => m.rows > 0);
        return first < 0 ? [] : out.slice(first);
    }

    // ------------------------------------------------------------------
    // The plan
    // ------------------------------------------------------------------

    /**
     * Everything the tab shows, for one scenario.
     *   input: { projects, costs, balances, transactions, settings, scenario,
     *            months, now: {year, month}, today: "YYYY-MM-DD" }
     */
    function plan(input) {
        const now = input.now;
        const today = input.today;
        const todayDay = dayOf(today);
        const months = HORIZONS.indexOf(input.months) >= 0 ? input.months : DEFAULT_HORIZON;
        const settings = cleanSettings(input.settings);

        const income = incomeItems(input.projects, input.scenario, now);

        const rows = [];
        for (let i = 0; i < months; i++) {
            rows.push({
                offset: i, label: RF.monthName(i, now),
                income: 0, fixed: 0, planned: 0,
                items: { income: [], costs: [] }
            });
        }

        income.items.forEach(x => {
            if (!x.counted || x.offset === null || x.offset >= months) return;
            const r = rows[x.offset];
            r.income += x.expected;
            r.items.income.push(x);
        });

        const costs = (input.costs || []).map(c => Object.assign({}, c, { occurrences: costOccurrences(c, months, now, todayDay) }));
        costs.forEach(c => c.occurrences.forEach(o => {
            const r = rows[o.offset];
            r.items.costs.push({ cost: c, amount: o.amount, paid: o.paid });
            if (o.paid) return;
            if (c.kind === 'once') r.planned += o.amount; else r.fixed += o.amount;
        }));

        const balance = balanceToday(input.balances, input.transactions);
        let running = balance ? balance.amount : 0;
        rows.forEach(r => {
            r.opening = round2(running);
            r.out = r.fixed + r.planned;
            r.in = r.income;
            r.net = r.in - r.out;
            running += r.net;
            r.closing = round2(running);
            ['income', 'fixed', 'planned', 'out', 'in', 'net']
                .forEach(k => { r[k] = round2(r[k]); });
        });

        const counted = income.items.filter(x => x.counted);
        const lowest = rows.reduce((lo, r) => (!lo || r.closing < lo.closing ? r : lo), null);
        const below = level => rows.find(r => r.closing < level) || null;
        const overdue = counted.filter(x => x.overdue);
        const undated = counted.filter(x => x.offset === null);
        const later = counted.filter(x => x.offset !== null && x.offset >= months);

        return {
            months,
            settings,
            hasBalance: !!balance,
            balance,
            rows,
            past: pastMonths(input.transactions, now, balance),
            income: income.items,
            missing: income.missing,
            costs,
            kpis: {
                balance: balance ? balance.amount : null,
                incomeNext3: round2(sum(rows.slice(0, 3), r => r.income)),
                incomeTotal: round2(sum(rows, r => r.income)),
                outTotal: round2(sum(rows, r => r.out)),
                fixedPerMonth: round2(monthlyFixed(input.costs, now)),
                lowest: lowest ? { offset: lowest.offset, label: lowest.label, amount: lowest.closing } : null,
                end: rows.length ? rows[rows.length - 1].closing : null,
                belowBuffer: settings.buffer > 0 ? below(settings.buffer) : null,
                belowZero: below(0),
                overdue: { count: overdue.length, amount: round2(sum(overdue, x => x.expected)) },
                undated: { count: undated.length, amount: round2(sum(undated, x => x.expected)) },
                later: { count: later.length, amount: round2(sum(later, x => x.expected)) }
            }
        };
    }

    root.Cashflow = {
        HORIZONS, DEFAULT_HORIZON, PAST_MONTHS, DEFAULT_SETTINGS,
        cleanSettings, incomeItems, costOccurrences, monthlyFixed,
        anchorOf, balanceToday, pastMonths, lastDayOf,
        plan
    };
})(typeof window !== 'undefined' ? window : globalThis);
