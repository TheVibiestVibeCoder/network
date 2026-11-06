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
 * still bring their unpaid payments, in full, in every scenario. A payment in
 * full counts as cash in the month it is expected (which may be after the
 * project's end) - the revenue forecast books a complete project's in this
 * month instead, since the work is done.
 *
 * VAT is left out: project amounts are net, and costs are entered net too.
 * Over a VAT period that is what stays in the account - the VAT collected
 * is passed on, the VAT in our costs comes back - only its timing is not
 * shown.
 *
 * Money out: our costs, net. A recurring cost every 1, 3, 6 or 12 months
 * from its first month to its last, on its day of the month - 31 meaning
 * the last day, whatever the month's length (salaries at the month's end).
 * A planned cost once, in its month. A cost counts as paid only once
 * Bookkeeping has it - then it is in the balance and in the year so far;
 * until then it is open, whatever its day.
 *
 * The year's result: this year's months in Bookkeeping as profit or loss,
 * without the VAT in them, and where the year ends if the plan holds
 * (yearMonths, yearResult) - revenue, costs and result for the whole year.
 *
 * Debts: interest accrued on each loan day by day, to today and to its
 * repayment (debtInterest, debtSummary). A loan with a repayment date goes
 * out of the account in that month, with all its interest.
 *
 * Recurring payments in Bookkeeping that no fixed cost covers yet are
 * offered as suggestions (recurringSuggestions).
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

    /** Whether "YYYY-MM-DD" is the last day of its month. */
    function isMonthEnd(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        return !!m && new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() === Number(m[3]);
    }

    // ------------------------------------------------------------------
    // Money in
    // ------------------------------------------------------------------

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
            const counted = RF.isCounted(p, scenario, true);
            const factor = RF.factorFor(p, scenario);
            const base = { projectId: p.id, name: p.name, company: p.company, stage: p.stage, chance: p.chance, factor, counted };

            // Cash comes when it is expected: a payment in its month, this
            // month once that has passed.
            p.due.forEach(x => out.push(Object.assign({}, base, {
                kind: 'payment', full: x.full, due: x.o, offset: Math.max(x.o, 0), overdue: x.o < 0, net: x.amount
            })));

            const rest = Math.max(0, RF.budgetFor(p, scenario.budget) - p.planned);
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
     * day this month has already come (due; plan() asks Bookkeeping whether
     * it really is paid).
     */
    function costOccurrences(cost, months, now, todayDay) {
        const start = RF.offsetOf(cost.start_month, now);
        // A day past the month's end (31 in November) is its last day.
        const monthEnd = dayOf(lastDayOf(0, now));
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
            const day = Math.min(number(cost.day) || 1, monthEnd);
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
    // The year's result
    // ------------------------------------------------------------------

    /**
     * Each month of this year so far, from Bookkeeping, as our financial
     * result: what came in and went out, each without the VAT in it - the
     * VAT on our own invoices is owed, the VAT on what we paid comes back
     * (the rows' `vat`). Income less costs is the month's profit or loss.
     *
     * `open` counts entries still without their invoice: until it is 0 the
     * VAT, and so the result, is not final. With a balance, `closing` is
     * where the account stood at the month's end. Always from January to
     * this month, which is included as far as it has gone; a month without
     * rows counts as 0.
     *
     *   -> [{ offset, label, income, costs, result, open, rows, closing }]
     */
    function yearMonths(transactions, now, today) {
        const rows = (transactions || []).filter(t => !t.excluded);
        const net = t => t.amount + (number(t.vat) || 0);
        const out = [];
        for (let m = 0; m <= now.month; m++) {
            const o = m - now.month;
            const prefix = now.year + '-' + String(m + 1).padStart(2, '0');
            const inMonth = rows.filter(t => t.date.slice(0, 7) === prefix);
            const income = sum(inMonth.filter(t => t.amount > 0), net);
            const costs = -sum(inMonth.filter(t => t.amount < 0), net);
            const end = lastDayOf(o, now);
            out.push({
                offset: o,
                label: RF.monthName(o, now),
                income: round2(income),
                costs: round2(costs),
                result: round2(income - costs),
                open: inMonth.filter(t => t.open).length,
                rows: inMonth.length,
                closing: today && o < 0 ? round2(today.amount - sum(rows.filter(t => t.date > end), t => t.amount)) : null
            });
        }
        return out;
    }

    /**
     * The year so far and where it is heading: the actual result of this
     * year's months in Bookkeeping, plus what the plan nets in the months
     * left until December - income under the chosen scenario less the costs
     * still to come, both net like the actuals. This month counts with what
     * has happened (actual) and what is still planned (the plan leaves out
     * costs already paid).
     *
     * Each figure for the whole year as well, January to December: what will
     * have come in (`revenue`), what will have gone out (`costs`) and the
     * result they leave (`projected` = revenue - costs).
     *
     *   plan: a plan() reaching at least to December
     *   -> { year, months, actual, planned, projected,
     *        income, costs (so far), incomeRest, costsRest (still to come),
     *        revenue, costsYear (the whole year),
     *        fixedRest, plannedRest (the costs of each kind until December) }
     */
    function yearResult(transactions, plan, now) {
        const months = yearMonths(transactions, now, plan.balance);
        const rest = plan.rows.filter(r => RF.calendarMonth(r.offset, now).year === now.year);
        // So far: what Bookkeeping has, nothing else - so it matches the
        // balance. A cost not booked yet is still to pay.
        const income = round2(sum(months, m => m.income));
        const costs = round2(sum(months, m => m.costs));
        const actual = round2(income - costs);
        const incomeRest = round2(sum(rest, r => r.in));
        // Still to pay until December. A loan's repayment is not a cost;
        // the interest paid with it is.
        const costsRest = round2(sum(rest, r => r.fixed + r.planned + (r.debtInterest || 0)));
        const planned = round2(incomeRest - costsRest);
        return {
            year: now.year,
            months,
            actual,
            planned,
            projected: round2(actual + planned),
            income,
            costs,
            incomeRest,
            costsRest,
            revenue: round2(income + incomeRest),
            costsYear: round2(costs + costsRest),
            fixedRest: round2(sum(rest, r => r.fixed)),
            plannedRest: round2(sum(rest, r => r.planned))
        };
    }

    // ------------------------------------------------------------------
    // Debts
    // ------------------------------------------------------------------

    /** Days from one "YYYY-MM-DD" to another (negative when `to` is earlier); null when either is not a date. */
    function daysBetween(from, to) {
        const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(from || ''));
        const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(to || ''));
        if (!a || !b) return null;
        const t = m => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return Math.round((t(b) - t(a)) / 86400000);
    }

    /**
     * Interest on one loan, day by day: simple interest on the amount at
     * the yearly rate, actual days over 365 (act/365) - the way a loan
     * agreement without compounding reckons it.
     *
     *   debt: { amount, rate (% p.a.), start_date, end_date? }
     *   -> { days, toDate (accrued until today, or until the repayment once
     *        it is past), total (until the repayment; null without an end
     *        date), daily, repaid, started, daysLeft (null without an end) }
     */
    function debtInterest(debt, today) {
        const amount = Math.max(0, number(debt && debt.amount) || 0);
        const rate = Math.max(0, number(debt && debt.rate) || 0);
        const daily = amount * rate / 100 / 365;
        const start = debt && debt.start_date;
        const end = debt && debt.end_date ? debt.end_date : null;
        const sinceStart = daysBetween(start, today);
        const term = end ? daysBetween(start, end) : null;
        const started = sinceStart !== null && sinceStart >= 0;
        const repaid = end !== null && daysBetween(end, today) !== null && daysBetween(end, today) >= 0;
        let days = started ? sinceStart : 0;
        if (term !== null) days = Math.min(days, Math.max(0, term));
        return {
            days,
            daily: round2(daily),
            toDate: round2(daily * days),
            total: term === null ? null : round2(daily * Math.max(0, term)),
            started,
            repaid,
            daysLeft: end === null ? null : Math.max(0, daysBetween(today, end) || 0)
        };
    }

    /**
     * All loans together: what is still owed (loans not yet repaid), the
     * interest accrued on all of them until today, and until their repayment
     * (for the loans that have an end date).
     */
    function debtSummary(debts, today) {
        const list = (debts || []).map(d => Object.assign({}, d, { interest: debtInterest(d, today) }));
        const open = list.filter(d => !d.interest.repaid);
        const dated = list.filter(d => d.interest.total !== null);
        return {
            list,
            count: list.length,
            openCount: open.length,
            outstanding: round2(sum(open, d => number(d.amount) || 0)),
            interestToDate: round2(sum(open, d => d.interest.toDate)),
            interestTotal: round2(sum(dated.filter(d => !d.interest.repaid), d => d.interest.total)),
            undatedCount: open.filter(d => d.interest.total === null).length
        };
    }

    // ------------------------------------------------------------------
    // Recurring costs, spotted in Bookkeeping
    // ------------------------------------------------------------------

    // How far apart payments of each rhythm land, in days, and how many it
    // takes before a rhythm is believed: three for monthly and quarterly,
    // two for the longer ones, which a few months of bookkeeping rarely
    // show more often.
    const RHYTHMS = [
        { interval: 1, min: 24, max: 38, count: 3 },
        { interval: 3, min: 80, max: 101, count: 3 },
        { interval: 6, min: 170, max: 195, count: 2 },
        { interval: 12, min: 350, max: 380, count: 2 }
    ];

    // Words that say what kind of company it is, not which one.
    const NAME_NOISE = ['gmbh', 'ltd', 'limited', 'inc', 'llc', 'ag', 'kg', 'og', 'eu', 'co', 'bv', 'sarl', 'se', 'srl',
        'und', 'and', 'the', 'der', 'die', 'das', 'von', 'for', 'für'];

    function nameWords(name) {
        return String(name || '').toLowerCase()
            .split(/[^a-z0-9äöüß]+/)
            .filter(w => w.length >= 3 && NAME_NOISE.indexOf(w) < 0 && !/^\d+$/.test(w));
    }

    function median(list) {
        const s = list.slice().sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    const daysApart = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

    /**
     * Payments in Bookkeeping that look like a fixed cost nobody has entered:
     * money out to the same party, about the same amount each time (within
     * 15%), on a steady rhythm - and still going, the last one no longer ago
     * than the rhythm allows.
     *
     * Left out: anything an existing fixed cost already covers (a word of its
     * name in the party, or the same rhythm and about the same amount) and
     * what somebody turned down (its key in `dismissed`).
     *
     * The amount is net, as costs are entered: the payment less the VAT its
     * invoices give back, where Bookkeeping knows it (net: false where it
     * does not, and the amount is what was paid). The first month is the
     * last payment's, so the cost carries on from there on its rhythm.
     *
     *   transactions: [{ date, amount, excluded, party, vat }]
     *   -> [{ key, name, amount, net, interval, day, start_month, count, first, last }]
     */
    function recurringSuggestions(transactions, costs, dismissed, today) {
        const groups = new Map();
        (transactions || []).forEach(t => {
            if (t.excluded || !(t.amount < 0) || !t.party) return;
            const words = nameWords(t.party);
            if (!words.length) return;
            const key = words.slice(0, 2).join(' ');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(t);
        });

        const currentMonth = String(today).slice(0, 7);
        const fixed = (costs || []).filter(c => c.kind !== 'once' && (!c.end_month || c.end_month >= currentMonth));
        const out = [];

        groups.forEach((all, partyKey) => {
            const typical = median(all.map(t => -t.amount));
            const rows = all.filter(t => Math.abs(-t.amount - typical) <= Math.max(typical * 0.15, 1))
                .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
            if (rows.length < 2) return;

            const gaps = [];
            for (let i = 1; i < rows.length; i++) gaps.push(daysApart(rows[i - 1].date, rows[i].date));
            const gap = median(gaps);
            const rhythm = RHYTHMS.find(r => gap >= r.min && gap <= r.max);
            if (!rhythm || rows.length < rhythm.count) return;
            // Most gaps have to keep the rhythm, not just the middle one.
            if (gaps.filter(g => g >= rhythm.min && g <= rhythm.max).length < gaps.length * 0.6) return;

            const last = rows[rows.length - 1];
            if (daysApart(last.date, today) > rhythm.max + 20) return;

            const key = partyKey + '|' + rhythm.interval;
            if ((dismissed || []).indexOf(key) >= 0) return;

            // The VAT share of the payments whose invoice Bookkeeping has
            // read, applied to the typical payment: one read invoice is
            // enough to tell what the others leave behind.
            const withVat = rows.filter(t => t.vat > 0);
            const vatShare = withVat.length ? median(withVat.map(t => t.vat / -t.amount)) : 0;
            const amount = round2(median(rows.map(t => -t.amount)) * (1 - vatShare));
            const words = nameWords(last.party);
            const covered = fixed.some(c => nameWords(c.name).some(w => words.indexOf(w) >= 0)
                || (Math.max(1, number(c.interval_months) || 1) === rhythm.interval
                    && Math.abs((number(c.amount) || 0) - amount) <= amount * 0.1));
            if (covered) return;

            out.push({
                key,
                name: last.party,
                amount,
                // False when no invoice told the VAT: then it is the amount paid.
                net: withVat.length > 0,
                interval: rhythm.interval,
                // Paid on a month's last day: the last day each month (31).
                day: isMonthEnd(last.date) ? 31 : (dayOf(last.date) || 1),
                start_month: last.date.slice(0, 7),
                count: rows.length,
                first: rows[0].date,
                last: last.date
            });
        });

        // The ones that weigh most on a month first.
        return out.sort((a, b) => b.amount / b.interval - a.amount / a.interval);
    }

    // ------------------------------------------------------------------
    // The plan
    // ------------------------------------------------------------------

    /**
     * Which of this month's costs Bookkeeping already has: each bank row
     * going out pays at most one cost - first by name (a word of the cost's
     * name in the party), then by amount (net within 10%).
     *   items: [{ cost, amount }] -> Set of the items paid
     */
    function bookedCosts(items, rows) {
        const used = new Set();
        const paid = new Set();
        const net = t => -(t.amount + (number(t.vat) || 0));
        const take = (item, test) => {
            const i = rows.findIndex((t, j) => !used.has(j) && test(t));
            if (i < 0) return;
            used.add(i);
            paid.add(item);
        };
        items.forEach(item => {
            const words = nameWords(item.cost.name);
            take(item, t => { const party = nameWords(t.party); return words.some(w => party.indexOf(w) >= 0); });
        });
        items.filter(item => !paid.has(item)).forEach(item => {
            take(item, t => Math.abs(net(t) - item.amount) <= Math.max(1, item.amount * 0.1));
        });
        return paid;
    }

    /**
     * Everything the tab shows, for one scenario.
     *   input: { projects, costs, balances, transactions, debts, settings,
     *            scenario, months, now: {year, month}, today: "YYYY-MM-DD" }
     * months: how many months ahead, this one included - one of HORIZONS, or
     * any other count up to 36 (Financials' "until December").
     */
    function plan(input) {
        const now = input.now;
        const today = input.today;
        const todayDay = dayOf(today);
        const months = Number.isInteger(input.months) && input.months >= 1 && input.months <= 36 ? input.months : DEFAULT_HORIZON;
        const settings = cleanSettings(input.settings);

        const income = incomeItems(input.projects, input.scenario, now);

        const rows = [];
        for (let i = 0; i < months; i++) {
            rows.push({
                offset: i, label: RF.monthName(i, now),
                income: 0, fixed: 0, planned: 0, debt: 0, debtInterest: 0,
                items: { income: [], costs: [], debts: [] }
            });
        }

        income.items.forEach(x => {
            if (!x.counted || x.offset === null || x.offset >= months) return;
            const r = rows[x.offset];
            r.income += x.expected;
            r.items.income.push(x);
        });

        const costs = (input.costs || []).map(c => Object.assign({}, c, { occurrences: costOccurrences(c, months, now, todayDay) }));
        // This month's bank rows going out: a cost of this month is paid -
        // in the balance and in the year so far - once Bookkeeping has it,
        // and open until then (due: its day has passed).
        const thisMonth = RF.calendarMonth(0, now);
        const monthPrefix = thisMonth.year + '-' + String(thisMonth.month + 1).padStart(2, '0');
        const bookedOut = (input.transactions || []).filter(t => !t.excluded && t.amount < 0 && String(t.date).slice(0, 7) === monthPrefix);

        const items = [];
        costs.forEach(c => c.occurrences.forEach(o => {
            const item = { cost: c, amount: o.amount, offset: o.offset, due: o.paid, paid: false };
            rows[o.offset].items.costs.push(item);
            items.push(item);
        }));
        const booked = bookedCosts(items.filter(x => x.offset === 0), bookedOut);
        items.forEach(item => {
            if (booked.has(item)) { item.paid = true; return; }
            const r = rows[item.offset];
            if (item.cost.kind === 'once') r.planned += item.amount; else r.fixed += item.amount;
        });

        // Loans with a repayment date still to come: out in that month,
        // with every day's interest until then.
        (input.debts || []).forEach(d => {
            if (!d.end_date || !(String(d.end_date) > String(today))) return;
            const o = RF.offsetOf(d.end_date, now);
            if (o === null || o < 0 || o >= months) return;
            const interest = debtInterest(d, d.end_date).total || 0;
            const principal = number(d.amount) || 0;
            const r = rows[o];
            r.debt += principal + interest;
            r.debtInterest += interest;
            r.items.debts.push({ debt: d, principal, interest, amount: round2(principal + interest) });
        });

        const balance = balanceToday(input.balances, input.transactions);
        let running = balance ? balance.amount : 0;
        rows.forEach(r => {
            r.opening = round2(running);
            r.out = r.fixed + r.planned + r.debt;
            r.in = r.income;
            r.net = r.in - r.out;
            running += r.net;
            r.closing = round2(running);
            ['income', 'fixed', 'planned', 'debt', 'debtInterest', 'out', 'in', 'net']
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
                // What each kind of cost comes to over the months shown.
                fixedTotal: round2(sum(rows, r => r.fixed)),
                plannedTotal: round2(sum(rows, r => r.planned)),
                debtTotal: round2(sum(rows, r => r.debt)),
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
        yearMonths, yearResult, recurringSuggestions,
        daysBetween, debtInterest, debtSummary,
        plan
    };
})(typeof window !== 'undefined' ? window : globalThis);
