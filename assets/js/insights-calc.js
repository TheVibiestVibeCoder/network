/**
 * The figures of the Insights tab, worked out from what the CRM keeps.
 *
 * Only history: what happened, never a forecast (that is Financials). Pure
 * functions, no DOM: insights.js draws, tests/insights-calc.test.js checks.
 *
 * Input (InsightsCalc.prepare):
 *   invoices   our invoices with their company and project (invoice-list.js attach)
 *   projects   the projects as api/projects.php lists them
 *   history    every recorded change: { project_id, field, value, changed_at, source }
 *   archived   the archived projects (api/insights.php): reason, the project
 *              as it was, its history and companies
 *   companies  [{ id, name, sector }]
 *   products   [{ name, color }] in their order
 *   today      'YYYY-MM-DD'
 *
 * Every project, live or archived, becomes one "deal" with an outcome:
 *   won      reached In Progress or Complete, or archived as done
 *   lost     archived with a reason that says so
 *   open     still in Lead, Negotiation or Proposal
 *   unclear  archived from an open stage without a reason
 * Archived as a test or duplicate, or still waiting as Claude's proposal,
 * it is left out altogether.
 */
(function (root) {
    'use strict';

    const DAY = 86400000;
    const OPEN_STAGES = ['Lead', 'Negotiation', 'Proposal'];
    const RANK = { Lead: 0, Negotiation: 1, Proposal: 2, 'In Progress': 3, Complete: 3 };
    const LOST_REASONS = ['no_budget', 'no_answer', 'went_elsewhere', 'postponed', 'not_a_fit'];
    const NO_PRODUCT = 'No product';
    const NO_SECTOR = 'No sector';

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    const day = v => (v ? String(v).slice(0, 10) : null);
    const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
    const round1 = n => Math.round(n * 10) / 10;

    function utc(d) {
        return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    }

    function daysBetween(from, to) {
        return Math.round((utc(to) - utc(from)) / DAY);
    }

    function addDays(d, n) {
        return new Date(utc(d) + n * DAY).toISOString().slice(0, 10);
    }

    /** 'YYYY-MM' n months after (or before) the month of d. */
    function addMonths(month, n) {
        const y = +month.slice(0, 4);
        const m = +month.slice(5, 7) - 1 + n;
        const yy = y + Math.floor(m / 12);
        const mm = ((m % 12) + 12) % 12;
        return yy + '-' + String(mm + 1).padStart(2, '0');
    }

    function lastDay(month) {
        const y = +month.slice(0, 4);
        const m = +month.slice(5, 7);
        return month + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
    }

    function monthsFrom(startMonth, endMonth) {
        const out = [];
        for (let m = startMonth; m <= endMonth && out.length < 600; m = addMonths(m, 1)) out.push(m);
        return out;
    }

    function quarterOf(d) {
        return d.slice(0, 4) + '-Q' + (Math.floor((+d.slice(5, 7) - 1) / 3) + 1);
    }

    function quarterStart(q) {
        return q.slice(0, 4) + '-' + String((+q.slice(6) - 1) * 3 + 1).padStart(2, '0') + '-01';
    }

    function addQuarters(q, n) {
        const index = +q.slice(0, 4) * 4 + (+q.slice(6) - 1) + n;
        return Math.floor(index / 4) + '-Q' + (index % 4 + 1);
    }

    function median(list) {
        const s = list.filter(v => v !== null && v !== undefined && !Number.isNaN(v)).slice().sort((a, b) => a - b);
        if (!s.length) return null;
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    const sum = (list, f) => list.reduce((s, x) => s + (Number(f ? f(x) : x) || 0), 0);
    const within = (d, range) => !!d && d >= range.start && d <= range.end;

    /** A budget as one figure: the middle of its range, or null without one. */
    function budgetMid(min, max) {
        const a = num(min);
        const b = num(max);
        if (a === null && b === null) return null;
        if (a === null) return b;
        if (b === null) return a;
        return (a + b) / 2;
    }

    /** The value a field had on a day: the last row up to it, else the first one there is. */
    function asOf(rows, d) {
        if (!rows.length) return undefined;
        let value = rows[0].value;
        for (const row of rows) {
            if (row.at <= d) value = row.value;
            else break;
        }
        return value;
    }

    /** A budget given as nothing: 0, or 0 to 0. */
    function unpaid(min, max) {
        const a = num(min);
        const b = num(max);
        return (a !== null || b !== null) && (a || 0) <= 0 && (b || 0) <= 0;
    }

    /** Words that say a project is a talk rather than paid work. */
    function isTalkProduct(product) {
        return /vortrag|talk|keynote|panel/i.test(String(product || ''));
    }

    // ------------------------------------------------------------------
    // Periods
    // ------------------------------------------------------------------

    /**
     * 'year:2026', '12m' or 'all' as dates: { key, kind, start, end, prev,
     * months, label }. A year still running ends today and is compared with
     * the same days a year before; 12 months are this month and the 11
     * before. 'all' starts with the first data there is (first).
     */
    function period(key, today, first) {
        const month = today.slice(0, 7);
        if (key === '12m') {
            const startMonth = addMonths(month, -11);
            return {
                key, kind: '12m', label: 'last 12 months',
                start: startMonth + '-01', end: today,
                prev: { start: addMonths(startMonth, -12) + '-01', end: addDays(today, -365) },
                months: monthsFrom(startMonth, month)
            };
        }
        if (key === 'all') {
            const start = (first && first < today ? first : today).slice(0, 7) + '-01';
            return { key, kind: 'all', label: 'all time', start, end: today, prev: null, months: monthsFrom(start.slice(0, 7), month) };
        }
        const year = Number(String(key).split(':')[1]) || Number(today.slice(0, 4));
        const running = String(year) === today.slice(0, 4);
        const end = running ? today : year + '-12-31';
        const prevEnd = running ? (year - 1) + today.slice(4) : (year - 1) + '-12-31';
        return {
            key: 'year:' + year, kind: 'year', year, running, label: String(year),
            start: year + '-01-01', end,
            prev: { start: (year - 1) + '-01-01', end: prevEnd === (year - 1) + '-02-29' ? (year - 1) + '-02-28' : prevEnd },
            months: monthsFrom(year + '-01', year + '-12')
        };
    }

    // ------------------------------------------------------------------
    // Deals: one per project, live or archived
    // ------------------------------------------------------------------

    function historyRows(rows) {
        const by = { stage: [], chance: [], budget_min: [], budget_max: [], end: [] };
        (rows || []).slice()
            .sort((a, b) => String(a.changed_at).localeCompare(String(b.changed_at)))
            .forEach(r => {
                if (!by[r.field]) return;
                by[r.field].push({ at: day(r.changed_at), value: r.field === 'stage' || r.field === 'end' ? r.value : num(r.value), live: r.source !== 'reconstructed' });
            });
        return by;
    }

    function makeDeal(base, rows, archived, today) {
        const h = historyRows(rows);
        const created = day(base.created_at) || today;
        const stageNow = archived ? archived.stage : base.stage;
        const ranks = h.stage.map(r => RANK[r.value]).filter(r => r !== undefined);
        if (RANK[stageNow] !== undefined) ranks.push(RANK[stageNow]);
        const furthest = ranks.length ? Math.max.apply(null, ranks) : 0;
        const firstStage = h.stage.length ? h.stage[0].value : null;

        // When each stage was first reached (this or a later one).
        // and whether that was recorded as it happened (rebuilt rows carry rough times).
        const reachedAt = [null, null, null, null];
        const reachedLive = [false, false, false, false];
        h.stage.forEach(r => {
            const rank = RANK[r.value];
            if (rank === undefined) return;
            for (let k = 0; k <= rank; k++) {
                if (!reachedAt[k]) {
                    reachedAt[k] = r.at;
                    reachedLive[k] = r.live;
                }
            }
        });
        if (!reachedAt[0]) reachedAt[0] = created;

        const reason = archived ? archived.reason || null : null;
        let outcome = 'open';
        let decidedAt = null;
        const wonStage = RANK[stageNow] === 3;
        const startDay = base.start_date && base.start_date <= today ? base.start_date : null;
        if (archived && LOST_REASONS.includes(reason)) {
            outcome = 'lost';
            decidedAt = day(archived.deleted_at);
        } else if (reason === 'done' || wonStage) {
            outcome = 'won';
            decidedAt = reachedAt[3] || (startDay && startDay >= created ? startDay : created);
            if (archived && decidedAt > day(archived.deleted_at)) decidedAt = day(archived.deleted_at);
        } else if (archived) {
            outcome = 'unclear';
            decidedAt = day(archived.deleted_at);
        }

        const budget = budgetMid(base.budget_min, base.budget_max);
        const lastChance = num(base.success_chance);
        return {
            key: archived ? 'a' + archived.id : 'p' + base.id,
            id: Number(base.id),
            archived: !!archived,
            name: base.name || '',
            product: base.product || null,
            companyIds: base.companyIds || [],
            created,
            outcome,
            decidedAt,
            reason,
            stageNow,
            furthest: outcome === 'won' ? 3 : Math.min(furthest, 2),
            enteredOpen: firstStage ? RANK[firstStage] !== undefined && RANK[firstStage] < 3 : false,
            reachedAt,
            reachedLive,
            budget,
            budgetMin: num(base.budget_min),
            budgetMax: num(base.budget_max),
            chanceNow: lastChance,
            stages: h.stage,
            chances: h.chance,
            budgetMins: h.budget_min,
            budgetMaxs: h.budget_max,
            // A talk, or work agreed without pay (a budget of 0).
            talk: isTalkProduct(base.product) || unpaid(base.budget_min, base.budget_max)
        };
    }

    /** Everything the figures are drawn from, in one shape. */
    function prepare(input) {
        const today = input.today;
        const companies = input.companies || [];
        const companyById = new Map(companies.map(c => [Number(c.id), c]));
        const keyToCompany = new Map();
        companies.forEach(c => keyToCompany.set(companyKey(c.name), c));
        const companyOfName = name => {
            const k = companyKey(name);
            return k ? keyToCompany.get(k) || null : null;
        };

        const byProject = new Map();
        (input.history || []).forEach(r => {
            const id = Number(r.project_id);
            if (!byProject.has(id)) byProject.set(id, []);
            byProject.get(id).push(r);
        });

        const deals = [];
        (input.projects || []).forEach(p => {
            if (p.review_status === 'pending') return;
            const ids = (p.companies || []).map(c => Number(c.id));
            if (!ids.length && p.company) {
                const c = companyOfName(p.company);
                if (c) ids.push(Number(c.id));
            }
            deals.push(makeDeal(Object.assign({}, p, { companyIds: ids }), byProject.get(Number(p.id)), null, today));
        });
        (input.archived || []).forEach(a => {
            if (a.reason === 'mistake') return;
            const p = a.project || {};
            if (p.review_status === 'pending') return;
            let ids = (a.companies || []).map(Number).filter(id => companyById.has(id));
            if (!ids.length && a.company) {
                ids = String(a.company).split(',').map(companyOfName).filter(Boolean).map(c => Number(c.id));
            }
            deals.push(makeDeal(Object.assign({}, p, { id: a.project_id, name: a.name, companyIds: ids }), a.history, a, today));
        });

        const dealByProject = new Map(deals.map(d => [d.id, d]));
        const invoices = (input.invoices || []).filter(i => i.date).map(i => {
            const company = i.company ? companyById.get(Number(i.company.id)) || { id: i.company.id, name: i.company.name } : null;
            const deal = i.project ? dealByProject.get(Number(i.project.id)) || null : null;
            return {
                number: i.number,
                date: i.date,
                due: i.due || null,
                net: Number(i.net) || 0,
                gross: Number(i.gross) || 0,
                credit: !!i.credit,
                paid: i.paid && i.paid.date ? { date: i.paid.date, amount: Number(i.paid.amount) || 0 } : null,
                overdue: !!i.overdue,
                customer: company ? 'c' + company.id : 'n' + (companyKey(i.customer) || i.number),
                customerName: company ? company.name : (i.customer || 'Unknown'),
                companyId: company ? Number(company.id) : null,
                projectId: i.project ? Number(i.project.id) : null,
                product: deal ? deal.product : null
            };
        });

        const firsts = [].concat(invoices.map(i => i.date), deals.map(d => d.created)).filter(Boolean).sort();
        return {
            today,
            deals,
            invoices,
            companies,
            companyById,
            products: input.products || [],
            first: firsts[0] || today,
            unclear: deals.filter(d => d.outcome === 'unclear').length
        };
    }

    const NAME_NOISE = new Set(['gmbh', 'ltd', 'limited', 'inc', 'llc', 'ag', 'kg', 'og', 'eu', 'co', 'bv', 'sarl', 'se', 'srl',
        'mbh', 'gesmbh', 'gesellschaft', 'ug', 'ev', 'und', 'and', 'the', 'der', 'die', 'das', 'von', 'for', 'für']);

    function companyKey(name) {
        const words = String(name || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        const kept = words.filter(w => !NAME_NOISE.has(w));
        return (kept.length ? kept : words).join('');
    }

    // ------------------------------------------------------------------
    // Revenue and customers
    // ------------------------------------------------------------------

    const revenueIn = (invoices, range) => sum(invoices.filter(i => within(i.date, range)), i => i.net);

    function cashIn(invoices, range) {
        return sum(invoices.filter(i => i.paid && within(i.paid.date, range)), i =>
            i.gross ? i.net * Math.min(1, Math.abs(i.paid.amount) / Math.abs(i.gross)) : i.net);
    }

    /** Revenue per customer in a range, biggest first: [{ key, name, companyId, net }]. */
    function byCustomer(invoices, range) {
        const map = new Map();
        invoices.filter(i => within(i.date, range)).forEach(i => {
            const c = map.get(i.customer) || { key: i.customer, name: i.customerName, companyId: i.companyId, net: 0 };
            c.net += i.net;
            map.set(i.customer, c);
        });
        return Array.from(map.values()).filter(c => Math.abs(c.net) > 0.005).sort((a, b) => b.net - a.net);
    }

    /** Each customer's first invoice day. */
    function firstInvoice(invoices) {
        const map = new Map();
        invoices.forEach(i => {
            if (i.credit) return;
            const known = map.get(i.customer);
            if (!known || i.date < known) map.set(i.customer, i.date);
        });
        return map;
    }

    function shares(list, total) {
        const top = list.filter(c => c.net > 0);
        return {
            top1: total > 0 && top[0] ? top[0].net / total : null,
            top3: total > 0 && top.length ? sum(top.slice(0, 3), c => c.net) / total : null
        };
    }

    // ------------------------------------------------------------------
    // Overview
    // ------------------------------------------------------------------

    const wonIn = (deals, range) => deals.filter(d => d.outcome === 'won' && within(d.decidedAt, range));
    const lostIn = (deals, range) => deals.filter(d => d.outcome === 'lost' && within(d.decidedAt, range));

    function kpis(data, p) {
        const revenue = revenueIn(data.invoices, p);
        const revenuePrev = p.prev ? revenueIn(data.invoices, p.prev) : null;
        const cash = cashIn(data.invoices, p);
        const cashPrev = p.prev ? cashIn(data.invoices, p.prev) : null;
        const customers = byCustomer(data.invoices, p).filter(c => c.net > 0);
        const customersPrev = p.prev ? byCustomer(data.invoices, p.prev).filter(c => c.net > 0) : null;
        const firsts = firstInvoice(data.invoices);
        const isNew = c => (firsts.get(c.key) || '') >= p.start;
        const won = wonIn(data.deals, p);
        const wonPrev = p.prev ? wonIn(data.deals, p.prev) : null;
        const lost = lostIn(data.deals, p);
        const cycles = won.filter(d => d.enteredOpen).map(d => daysBetween(d.created, d.decidedAt)).filter(n => n > 0);
        return {
            revenue, revenuePrev,
            cash, cashPrev,
            customers: customers.length,
            customersPrev: customersPrev ? customersPrev.length : null,
            newCustomers: customers.filter(isNew).length,
            returning: customers.filter(c => !isNew(c)).length,
            won: won.length,
            wonVolume: sum(won, d => d.budget),
            wonPrev: wonPrev ? wonPrev.length : null,
            decided: won.length + lost.length,
            winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
            timeToWin: median(cycles),
            timeToWinN: cycles.length
        };
    }

    /**
     * Revenue added up month by month over the period, and over the period
     * before when there is one: { months, cur: [{ month, value, x }], prev }.
     * x is the position in months from the start; the running month ends on today.
     */
    function cumulative(data, p) {
        const line = (months, range) => {
            let total = 0;
            const out = [];
            months.forEach((m, i) => {
                const from = m + '-01';
                if (from > range.end) return;
                const to = lastDay(m) < range.end ? lastDay(m) : range.end;
                total += revenueIn(data.invoices, { start: from < range.start ? range.start : from, end: to });
                const days = +lastDay(m).slice(8);
                const x = to === lastDay(m) ? i + 1 : i + (+to.slice(8)) / days;
                out.push({ month: m, value: total, x });
            });
            return out;
        };
        const cur = line(p.months, p);
        let prev = null;
        if (p.prev) {
            const months = p.months.map(m => addMonths(m, -12));
            prev = line(months, { start: p.prev.start, end: p.kind === 'year' ? months[months.length - 1] + '-31' : p.prev.end });
        }
        return { months: p.months, cur, prev };
    }

    /** Revenue per quarter: the period's quarters and the ones before it. */
    function quarters(data, p) {
        const last = quarterOf(p.end);
        const first = p.kind === 'all' ? quarterOf(p.start) : addQuarters(quarterOf(p.start), -4);
        const list = [];
        for (let q = first, n = 0; q <= last && n < 40; q = addQuarters(q, 1), n++) list.push(q);
        const shown = list.slice(-12);
        return shown.map(q => {
            const start = quarterStart(q);
            const end = addDays(quarterStart(addQuarters(q, 1)), -1);
            return {
                quarter: q,
                label: 'Q' + q.slice(6),
                year: q.slice(0, 4),
                value: revenueIn(data.invoices, { start, end: end < data.today ? end : data.today }),
                partial: data.today < end && data.today >= start,
                inPeriod: end >= p.start && start <= p.end
            };
        });
    }

    /** Share of revenue per product, in the products' order: [{ name, color, net, share }]. */
    function productMix(data, range) {
        const total = revenueIn(data.invoices, range);
        const names = data.products.map(x => x.name);
        const map = new Map();
        data.invoices.filter(i => within(i.date, range)).forEach(i => {
            const name = i.product && names.includes(i.product) ? i.product : NO_PRODUCT;
            map.set(name, (map.get(name) || 0) + i.net);
        });
        const out = data.products.map(x => ({ name: x.name, color: x.color, net: map.get(x.name) || 0 }));
        out.push({ name: NO_PRODUCT, color: null, net: map.get(NO_PRODUCT) || 0 });
        return { total, parts: out.filter(x => x.net > 0.005).map(x => Object.assign(x, { share: total > 0 ? x.net / total : 0 })) };
    }

    /** New projects and offers sent per month of the period (to this month). */
    function inflow(data, p) {
        const months = p.months.filter(m => m + '-01' <= p.end);
        return months.map(m => {
            const range = { start: m + '-01', end: lastDay(m) };
            return {
                month: m,
                leads: data.deals.filter(d => within(d.created, range)).length,
                offers: data.deals.filter(d => within(d.reachedAt[2], range)).length
            };
        });
    }

    // ------------------------------------------------------------------
    // Sales
    // ------------------------------------------------------------------

    const STEP_NAMES = ['Lead', 'Negotiation', 'Proposal', 'Won'];

    /** From lead to order, for the projects entered in the period. */
    function funnel(data, p) {
        const cohort = data.deals.filter(d => within(d.created, p));
        const steps = STEP_NAMES.map((name, rank) => {
            const reached = cohort.filter(d => d.furthest >= rank);
            const next = cohort.filter(d => d.furthest >= rank + 1);
            // Only moves recorded as they happened: rebuilt ones share rough times.
            const days = next.map(d => {
                const from = d.reachedAt[rank];
                const j = d.reachedAt.findIndex((at, k) => k > rank && at);
                return from && j > 0 && d.reachedLive[j] ? daysBetween(from, d.reachedAt[j]) : null;
            }).filter(n => n !== null && n >= 0);
            return {
                name,
                reached: reached.length,
                lost: rank < 3 ? cohort.filter(d => d.outcome === 'lost' && Math.min(RANK[d.stageNow] || 0, 2) === rank).length : 0,
                open: cohort.filter(d => d.outcome === 'open' && d.furthest === rank).length,
                next: rank < 3 ? (reached.length ? next.length / reached.length : null) : null,
                days: rank < 3 ? median(days) : null,
                // Those that got no further than this stage, by what became of them.
                stopped: rank < 3 ? ['lost', 'open', 'unclear'].reduce((out, outcome) => {
                    out[outcome] = cohort.filter(d => d.furthest === rank && d.outcome === outcome).length;
                    return out;
                }, {}) : null
            };
        });
        const won = cohort.filter(d => d.outcome === 'won');
        const lost = cohort.filter(d => d.outcome === 'lost');
        return {
            entered: cohort.length,
            steps,
            won: won.length,
            winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
            wonVolume: sum(won, d => d.budget),
            unclear: cohort.filter(d => d.outcome === 'unclear').length
        };
    }

    /** One mark per project, by the quarter it was entered in. */
    function cohorts(data, p) {
        const order = { won: 0, open: 1, unclear: 2, lost: 3 };
        const map = new Map();
        data.deals.filter(d => within(d.created, p)).forEach(d => {
            const q = quarterOf(d.created);
            if (!map.has(q)) map.set(q, []);
            map.get(q).push(d);
        });
        return Array.from(map.keys()).sort().map(q => {
            const list = map.get(q).slice().sort((a, b) => order[a.outcome] - order[b.outcome]);
            const won = list.filter(d => d.outcome === 'won').length;
            const lost = list.filter(d => d.outcome === 'lost').length;
            return { quarter: q, label: 'Q' + q.slice(6) + ' ' + q.slice(0, 4), deals: list, won, decided: won + lost };
        });
    }

    /** Days from first entry to order, per product, for the projects won in the period. */
    function timeToWin(data, p) {
        // Won on the day it was entered: written down after the fact, not a sale we followed.
        const won = wonIn(data.deals, p).filter(d => d.enteredOpen && daysBetween(d.created, d.decidedAt) > 0);
        const names = data.products.map(x => x.name).concat([NO_PRODUCT]);
        return names.map(name => {
            const list = won.filter(d => (d.product && names.includes(d.product) ? d.product : NO_PRODUCT) === name)
                .map(d => ({ deal: d, days: daysBetween(d.created, d.decidedAt) }));
            return { name, items: list, median: median(list.map(x => x.days)) };
        }).filter(row => row.items.length);
    }

    /** The chance a project stood at before its decision: the last one entered earlier. */
    function estimateBefore(d) {
        const before = d.chances.filter(r => r.at < d.decidedAt && r.value !== null);
        if (before.length) return before[before.length - 1].value;
        if (d.outcome === 'lost' && d.chanceNow !== null) return d.chanceNow;
        return null;
    }

    const BINS = [
        { label: 'Up to 30%', max: 32.5 },
        { label: '35 to 60%', max: 62.5 },
        { label: '65 to 90%', max: 92.5 },
        { label: '95% and more', max: 101 }
    ];

    /** How our estimates compare with what happened, for the projects decided in the period. */
    function calibration(data, p) {
        const decided = data.deals.filter(d => (d.outcome === 'won' || d.outcome === 'lost') && within(d.decidedAt, p))
            .map(d => ({ d, est: estimateBefore(d) }))
            .filter(x => x.est !== null && !(x.d.outcome === 'won' && x.est >= 100 && x.d.chances.length <= 1));
        const rows = BINS.map((bin, i) => {
            const lo = i ? BINS[i - 1].max : -1;
            const list = decided.filter(x => x.est >= lo && x.est < bin.max);
            const won = list.filter(x => x.d.outcome === 'won').length;
            return {
                label: bin.label,
                n: list.length,
                won,
                estimated: list.length ? sum(list, x => x.est) / list.length / 100 : null,
                actual: list.length ? won / list.length : null
            };
        });
        const withBudget = decided.filter(x => x.d.budget);
        return {
            rows,
            n: decided.length,
            weighted: sum(withBudget, x => x.d.budget * x.est / 100),
            wonVolume: sum(withBudget.filter(x => x.d.outcome === 'won'), x => x.d.budget)
        };
    }

    const SAMPLE_DAYS = [-90, -75, -60, -45, -30, -20, -10, -5, 0];

    /**
     * The chance in the 90 days before each decision: step lines (days
     * before, chance) per project and their median, for won and for lost.
     */
    function chanceCurves(data, p) {
        const curve = d => {
            const rows = d.chances.filter(r => r.value !== null && r.at <= d.decidedAt);
            if (!rows.length) return null;
            const pts = [];
            const startDay = Math.max(-90, -daysBetween(d.created, d.decidedAt));
            let carried = null;
            rows.forEach(r => {
                const at = -daysBetween(r.at, d.decidedAt);
                if (at <= startDay) carried = r.value;
                else pts.push([at, r.value]);
            });
            if (carried === null && !pts.length) return null;
            const line = [[startDay, carried !== null ? carried : pts[0][1]]].concat(pts.filter(x => x[0] > startDay));
            const lastValue = line[line.length - 1][1];
            line.push([0, d.outcome === 'won' ? 100 : lastValue]);
            return { deal: d, line, live: d.chances.some(r => r.live) };
        };
        const at = (line, x) => {
            if (x < line[0][0]) return null;
            let v = line[0][1];
            line.forEach(pt => { if (pt[0] <= x) v = pt[1]; });
            return v;
        };
        const group = outcome => {
            const list = data.deals.filter(d => d.outcome === outcome && within(d.decidedAt, p)).map(curve).filter(Boolean);
            const med = SAMPLE_DAYS.map(x => [x, median(list.map(c => at(c.line, x)).filter(v => v !== null))]).filter(pt => pt[1] !== null);
            return { lines: list, median: med, total: data.deals.filter(d => d.outcome === outcome && within(d.decidedAt, p)).length };
        };
        const won = group('won');
        const lost = group('lost');
        const lostMonth = lost.lines.map(c => at(c.line, -30)).filter(v => v !== null);
        return { won, lost, lostMonthBefore: median(lostMonth), lostMonthN: lostMonth.length };
    }

    /** Where we lose: by the stage a lost project was in, with its chance then; and why. */
    function losses(data, p, reasons) {
        const lost = lostIn(data.deals, p);
        const stages = ['Lead', 'Negotiation', 'Proposal', 'In Progress'].map(name => {
            const list = lost.filter(d => (d.stageNow === 'Complete' ? 'In Progress' : d.stageNow) === name);
            return { name, items: list.map(d => ({ deal: d, chance: estimateBefore(d) })) };
        }).filter((row, i) => i < 3 || row.items.length);
        const why = LOST_REASONS.map(key => ({ key, label: (reasons && reasons[key]) || key, n: lost.filter(d => d.reason === key).length }))
            .filter(x => x.n > 0).sort((a, b) => b.n - a.n);
        return {
            total: lost.length,
            stages,
            why,
            unclear: data.deals.filter(d => d.outcome === 'unclear' && within(d.decidedAt, p)).length
        };
    }

    /** The open pipeline at each month's end: budgets, and weighted by the chance then. */
    function pipeline(data, p) {
        const months = p.months.filter(m => m + '-01' <= p.end && m + '-01' <= data.today);
        return months.map(m => {
            const t = lastDay(m) < data.today ? lastDay(m) : data.today;
            let open = 0;
            let weighted = 0;
            let count = 0;
            data.deals.forEach(d => {
                if (d.created > t) return;
                if (d.decidedAt && d.decidedAt <= t) return;
                const stage = d.stages.length ? asOf(d.stages, t) : d.stageNow;
                if (!OPEN_STAGES.includes(stage)) return;
                const min = d.budgetMins.length ? asOf(d.budgetMins, t) : d.budgetMin;
                const max = d.budgetMaxs.length ? asOf(d.budgetMaxs, t) : d.budgetMax;
                const budget = budgetMid(min, max);
                const chance = d.chances.length ? asOf(d.chances, t) : d.chanceNow;
                count++;
                if (!budget) return;
                open += budget;
                weighted += budget * (Number(chance) || 0) / 100;
            });
            return { month: m, open, weighted, count };
        });
    }

    /**
     * Per product, for the period: revenue and its share, projects won
     * against those decided in it, the median order and time to win.
     */
    function byProduct(data, p) {
        const names = data.products.map(x => x.name).concat([NO_PRODUCT]);
        const nameOf = product => (product && names.includes(product) ? product : NO_PRODUCT);
        const won = wonIn(data.deals, p);
        const lost = lostIn(data.deals, p);
        const total = revenueIn(data.invoices, p);
        const figures = (w, l, revenue) => ({
            won: w.length,
            decided: w.length + l.length,
            order: median(w.map(d => d.budget).filter(b => b > 0)),
            days: median(w.filter(d => d.enteredOpen).map(d => daysBetween(d.created, d.decidedAt)).filter(n => n > 0)),
            revenue,
            share: total > 0 ? revenue / total : null
        });
        const rows = names.map(name => Object.assign({ name, color: (data.products.find(x => x.name === name) || {}).color || null },
            figures(won.filter(d => nameOf(d.product) === name), lost.filter(d => nameOf(d.product) === name),
                sum(data.invoices.filter(i => within(i.date, p) && nameOf(i.product) === name), i => i.net))))
            .filter(r => r.decided || Math.abs(r.revenue) > 0.005);
        return { rows, total: figures(won, lost, total) };
    }

    // ------------------------------------------------------------------
    // Customers
    // ------------------------------------------------------------------

    function customerFigures(data, p) {
        const list = byCustomer(data.invoices, p);
        const total = revenueIn(data.invoices, p);
        const firsts = firstInvoice(data.invoices);
        const paying = list.filter(c => c.net > 0);
        const fresh = paying.filter(c => (firsts.get(c.key) || '') >= p.start);
        const prevList = p.prev ? byCustomer(data.invoices, p.prev).filter(c => c.net > 0) : null;
        const prevTotal = p.prev ? revenueIn(data.invoices, p.prev) : null;
        const now = new Set(paying.map(c => c.key));
        return {
            total,
            customers: paying.length,
            customersPrev: prevList ? prevList.length : null,
            newCount: fresh.length,
            newShare: total > 0 ? sum(fresh, c => c.net) / total : null,
            again: prevList ? prevList.filter(c => now.has(c.key)).length : null,
            prevCount: prevList ? prevList.length : null,
            shares: shares(list, total),
            sharesPrev: prevList ? shares(prevList, prevTotal) : null,
            list: list.map(c => Object.assign({}, c, {
                share: total > 0 ? c.net / total : null,
                isNew: (firsts.get(c.key) || '') >= p.start,
                sector: c.companyId && data.companyById.get(c.companyId) ? data.companyById.get(c.companyId).sector || null : null
            }))
        };
    }

    /** Revenue per quarter of the period, from customers who had bought before and from new ones. */
    function newReturning(data, p) {
        const firsts = firstInvoice(data.invoices);
        const qs = [];
        for (let q = quarterOf(p.start), n = 0; q <= quarterOf(p.end) && n < 40; q = addQuarters(q, 1), n++) qs.push(q);
        return qs.slice(-8).map(q => {
            const start = quarterStart(q);
            const end = addDays(quarterStart(addQuarters(q, 1)), -1);
            const list = data.invoices.filter(i => within(i.date, { start: start < p.start ? p.start : start, end: end < p.end ? end : p.end }));
            const returning = sum(list.filter(i => (firsts.get(i.customer) || i.date) < start), i => i.net);
            const fresh = sum(list, i => i.net) - returning;
            return { quarter: q, label: 'Q' + q.slice(6) + (qs.length > 4 || p.kind !== 'year' ? ' ' + q.slice(2, 4) : ''), returning, fresh };
        });
    }

    // ------------------------------------------------------------------
    // Year against year
    // ------------------------------------------------------------------

    /**
     * The years a comparison shows: the period's last year and up to
     * count - 1 before it, from the first data on. A running year ends today.
     */
    function yearColumns(data, p, count) {
        const endYear = +p.end.slice(0, 4);
        const firstYear = Math.min(+data.first.slice(0, 4), endYear);
        const out = [];
        for (let y = Math.max(firstYear, endYear - (count || 3) + 1); y <= endYear; y++) {
            const running = String(y) === data.today.slice(0, 4);
            out.push({ year: y, running, start: y + '-01-01', end: running ? data.today : y + '-12-31' });
        }
        return out;
    }

    /**
     * Revenue per year by something of the invoice (its customer, the
     * customer's sector): { years, rows: [{ key, name, values, total, change }],
     * totals, change }. change is the last year against the one before - a
     * running year against the same days of the year before - and null
     * without revenue then.
     */
    function yearTable(data, p, keyOf, count) {
        const years = yearColumns(data, p, count);
        const last = years[years.length - 1];
        const same = years.length > 1 ? period('year:' + last.year, data.today, data.first).prev : null;
        const map = new Map();
        const totals = years.map(() => 0);
        let totalSame = 0;
        data.invoices.forEach(i => {
            const col = years.findIndex(y => within(i.date, y));
            const inSame = !!same && within(i.date, same);
            if (col < 0 && !inSame) return;
            const k = keyOf(i);
            if (!map.has(k.key)) map.set(k.key, Object.assign({ values: years.map(() => 0), same: 0 }, k));
            const row = map.get(k.key);
            if (col >= 0) {
                row.values[col] += i.net;
                totals[col] += i.net;
            }
            if (inSame) {
                row.same += i.net;
                totalSame += i.net;
            }
        });
        const change = (now, before) => (same && before > 0.005 ? (now - before) / before : null);
        const rows = Array.from(map.values())
            .filter(r => r.values.some(v => Math.abs(v) > 0.005))
            .map(r => Object.assign(r, { total: sum(r.values), change: change(r.values[r.values.length - 1], r.same) }));
        return { years, rows, totals, change: change(totals[totals.length - 1], totalSame) };
    }

    /**
     * How the customers grew: revenue per year of the biggest ones (over
     * the years shown); new when the first invoice falls in the last year.
     */
    function customerYears(data, p, count) {
        const t = yearTable(data, p, i => ({ key: i.customer, name: i.customerName, companyId: i.companyId }), 3);
        const firsts = firstInvoice(data.invoices);
        const lastStart = t.years[t.years.length - 1].start;
        const rows = t.rows.filter(r => r.total > 0.005).sort((a, b) => b.total - a.total);
        rows.forEach(r => { r.isNew = (firsts.get(r.key) || '') >= lastStart; });
        return Object.assign(t, { rows: rows.slice(0, count || 8), more: Math.max(0, rows.length - (count || 8)) });
    }

    /**
     * Talks and unpaid work at a customer with no paid order before it, in
     * the period: how many were followed by a paid project within 12 months.
     */
    function doors(data, p) {
        const paid = data.deals.filter(d => d.outcome === 'won' && !d.talk && d.budget > 0);
        const talks = data.deals.filter(d => d.outcome === 'won' && d.talk && within(d.decidedAt, p) && d.companyIds.length);
        const items = talks.map(t => {
            const before = paid.some(d => d.decidedAt < t.decidedAt && d.companyIds.some(id => t.companyIds.includes(id)));
            if (before) return null;
            const after = paid.filter(d => d.decidedAt >= t.decidedAt && daysBetween(t.decidedAt, d.decidedAt) <= 365
                && d.companyIds.some(id => t.companyIds.includes(id)))
                .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
            return { talk: t, order: after[0] || null, orders: after };
        }).filter(Boolean);
        const hits = items.filter(x => x.order);
        return {
            items,
            hits: hits.length,
            months: median(hits.map(x => daysBetween(x.talk.decidedAt, x.order.decidedAt) / 30.44)),
            volume: sum(hits, x => sum(x.orders, d => d.budget))
        };
    }

    /** Days from invoice to payment: median per quarter, late ones, the slowest customers. */
    function payments(data, p) {
        const paid = data.invoices.filter(i => !i.credit && i.paid && i.paid.date >= i.date);
        const qs = quarters(data, p).slice(-8);
        const perQuarter = qs.map(q => {
            const start = quarterStart(q.quarter);
            const end = addDays(quarterStart(addQuarters(q.quarter, 1)), -1);
            const list = paid.filter(i => within(i.date, { start, end }));
            return { quarter: q.quarter, label: q.label, year: q.year, inPeriod: q.inPeriod, days: median(list.map(i => daysBetween(i.date, i.paid.date))), n: list.length };
        });
        const inPeriod = data.invoices.filter(i => !i.credit && within(i.date, p));
        const late = inPeriod.filter(i => i.due && ((i.paid && i.paid.date > i.due) || (!i.paid && i.overdue)));
        const map = new Map();
        paid.filter(i => within(i.date, p)).forEach(i => {
            const c = map.get(i.customer) || { name: i.customerName, companyId: i.companyId, days: [] };
            c.days.push(daysBetween(i.date, i.paid.date));
            map.set(i.customer, c);
        });
        const slowest = Array.from(map.values()).filter(c => c.days.length >= 2)
            .map(c => ({ name: c.name, companyId: c.companyId, days: median(c.days), n: c.days.length }))
            .sort((a, b) => b.days - a.days).slice(0, 3);
        return { perQuarter, late: late.length, count: inPeriod.length, slowest, median: median(paid.filter(i => within(i.date, p)).map(i => daysBetween(i.date, i.paid.date))) };
    }

    /** Revenue per year by the sector of the customer, biggest in the last year first. */
    function sectors(data, p) {
        const sectorOf = id => {
            const c = id ? data.companyById.get(id) : null;
            return c && c.sector ? String(c.sector).trim() : NO_SECTOR;
        };
        const t = yearTable(data, p, i => {
            const name = sectorOf(i.companyId);
            return { key: name, name };
        }, 3);
        const last = t.years.length - 1;
        const named = t.rows.filter(r => r.name !== NO_SECTOR).sort((a, b) => b.values[last] - a.values[last] || b.total - a.total);
        return {
            years: t.years,
            rows: named,
            none: t.rows.find(r => r.name === NO_SECTOR) || null,
            totals: t.totals,
            change: t.change,
            withSector: named.length,
            anySector: data.companies.some(c => c.sector && String(c.sector).trim())
        };
    }

    /**
     * Revenue in the period by the customer's sector, biggest first, against
     * the period before: { total, rows: [{ name, net, share, change, isNew }],
     * none, withSector, anySector }. Without a sector: none.
     */
    function sectorShares(data, p) {
        const sectorOf = id => {
            const c = id ? data.companyById.get(id) : null;
            return c && c.sector ? String(c.sector).trim() : NO_SECTOR;
        };
        const group = range => {
            const map = new Map();
            data.invoices.filter(i => within(i.date, range)).forEach(i => {
                const k = sectorOf(i.companyId);
                map.set(k, (map.get(k) || 0) + i.net);
            });
            return map;
        };
        const cur = group(p);
        const prev = p.prev ? group(p.prev) : null;
        const all = Array.from(cur.entries()).filter(([, net]) => net > 0.005);
        const total = sum(all, ([, net]) => net);
        const row = ([name, net]) => {
            const before = prev ? prev.get(name) || 0 : null;
            return {
                name, net,
                share: total > 0 ? net / total : null,
                change: before !== null && before > 0.005 ? (net - before) / before : null,
                isNew: before !== null && before <= 0.005
            };
        };
        const rows = all.filter(([name]) => name !== NO_SECTOR).map(row).sort((a, b) => b.net - a.net);
        const none = all.find(([name]) => name === NO_SECTOR);
        return {
            total, rows,
            none: none ? row(none) : null,
            withSector: rows.length,
            anySector: data.companies.some(c => c.sector && String(c.sector).trim())
        };
    }

    // ------------------------------------------------------------------
    // Highlights: a few findings from the figures, each
    // { tone, view, title, figure, parts: [[text, 'b'?]] }
    // ------------------------------------------------------------------

    function highlights(data, p, parts) {
        const out = [];
        const k = parts.kpis;
        const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

        if (p.kind === 'year' && k.revenuePrev !== null && k.revenuePrev > 0) {
            const delta = (k.revenue - k.revenuePrev) / k.revenuePrev;
            const prevFull = revenueIn(data.invoices, { start: (p.year - 1) + '-01-01', end: (p.year - 1) + '-12-31' });
            const passed = p.running && prevFull > 0 ? parts.cumulative.cur.find(pt => pt.value >= prevFull) : null;
            out.push({
                tone: delta >= 0 ? 'good' : 'warn', view: 'overview', title: 'Revenue', figure: signedPct(delta),
                parts: passed
                    ? [['Revenue passed all of ' + (p.year - 1) + ' in ' + MONTHS[+passed.month.slice(5) - 1] + '. Year to date '], [signedPct(delta), 'b'], [' on last year.']]
                    : [[p.running ? 'Year to date, revenue is ' : 'Revenue was '], [signedPct(delta), 'b'], [' on ' + (p.year - 1) + '.']]
            });
        }

        const cal = parts.calibration.rows.filter(r => r.n >= 5 && r.estimated !== null)
            .map(r => Object.assign({ gap: r.estimated - r.actual }, r))
            .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
        if (cal && Math.abs(cal.gap) >= 0.15) {
            out.push({
                tone: 'warn', view: null, title: 'Our estimates', figure: cal.won + ' of ' + cal.n,
                parts: [['Estimates of ' + cal.label.toLowerCase() + ' came true '], [cal.won + ' of ' + cal.n, 'b'], [' times' + (cal.gap > 0 ? ', less often than estimated.' : ', more often than estimated.')]]
            });
        }

        const cf = parts.customers;
        if (cf.shares.top1 !== null && cf.customers >= 3) {
            const prev = cf.sharesPrev && cf.sharesPrev.top1 !== null ? cf.sharesPrev.top1 : null;
            out.push({
                tone: prev !== null && cf.shares.top1 < prev ? 'good' : (cf.shares.top1 > 0.4 ? 'warn' : 'info'), view: 'customers',
                title: 'Biggest customer', figure: pct(cf.shares.top1),
                parts: [['The biggest customer brings '], [pct(cf.shares.top1), 'b'], [' of revenue' + (prev !== null ? ', ' + (cf.shares.top1 < prev ? 'down' : 'up') + ' from ' + pct(prev) + '.' : '.')]]
            });
        }

        const dr = parts.doors;
        if (dr.items.length >= 3) {
            out.push({
                tone: 'info', view: null, title: 'From talk to order', figure: dr.hits + ' of ' + dr.items.length,
                parts: [[''], [dr.hits + ' of ' + dr.items.length, 'b'], [' talks led to a paid project within a year' + (dr.months !== null && dr.hits ? ', a median of ' + Math.round(dr.months) + ' months later.' : '.')]]
            });
        }

        const inf = parts.inflow;
        if (inf.length >= 6) {
            const last = inf.slice(-3);
            const before = inf.slice(-6, -3);
            const a = sum(last, x => x.offers);
            const b = sum(before, x => x.offers);
            if (a + b >= 4 && b > 0 && Math.abs(a - b) / b >= 0.3) {
                out.push({
                    tone: a > b ? 'good' : 'warn', view: 'overview', title: 'Offers sent', figure: String(a),
                    parts: [['Offers sent in the last 3 months: '], [String(a), 'b'], [', against ' + b + ' in the 3 before.']]
                });
            }
        }

        if (data.unclear > 0) {
            out.push({
                tone: 'warn', view: 'archive', title: 'Archive', figure: String(data.unclear),
                parts: [[''], [data.unclear + (data.unclear === 1 ? ' archived project has' : ' archived projects have'), 'b'], [' no reason yet, so they count neither as won nor as lost.']]
            });
        }
        return out.slice(0, 4);
    }

    function pct(v) {
        return Math.round(v * 100) + '%';
    }

    function signedPct(v) {
        const n = Math.round(v * 100);
        return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n) + '%';
    }

    // ------------------------------------------------------------------

    /** Everything a view shows, for one period. */
    function compute(data, key, reasons) {
        const p = period(key, data.today, data.first);
        const parts = {};
        parts.period = p;
        parts.kpis = kpis(data, p);
        parts.cumulative = cumulative(data, p);
        parts.quarters = quarters(data, p);
        parts.mix = { cur: productMix(data, p), prev: p.prev ? productMix(data, p.prev) : null };
        parts.inflow = inflow(data, p);
        parts.funnel = funnel(data, p);
        parts.calibration = calibration(data, p); // behind a highlight only, no card of its own
        parts.byProduct = byProduct(data, p);
        parts.customers = customerFigures(data, p);
        parts.newReturning = newReturning(data, p);
        parts.growth = customerYears(data, p, 10);
        parts.doors = doors(data, p); // behind a highlight only, no card of its own
        parts.payments = payments(data, p);
        parts.sectors = sectorShares(data, p);
        parts.highlights = highlights(data, p, parts);
        return parts;
    }

    /** The years there is anything for, newest first. */
    function years(data) {
        const set = new Set([data.today.slice(0, 4)]);
        data.invoices.forEach(i => set.add(i.date.slice(0, 4)));
        data.deals.forEach(d => set.add(d.created.slice(0, 4)));
        return Array.from(set).filter(y => y <= data.today.slice(0, 4)).sort().reverse();
    }

    root.InsightsCalc = {
        NO_PRODUCT, NO_SECTOR, LOST_REASONS,
        prepare, compute, period, years,
        daysBetween, median, budgetMid, asOf, addMonths, lastDay, quarterOf,
        kpis, cumulative, quarters, productMix, inflow,
        funnel, cohorts, timeToWin, calibration, chanceCurves, losses, pipeline, byProduct,
        customerFigures, newReturning, yearColumns, yearTable, customerYears, doors, payments, sectors, sectorShares, highlights
    };
})(typeof window !== 'undefined' ? window : globalThis);
