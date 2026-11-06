/**
 * Revenue forecast: the arithmetic behind the card on the Projects page.
 *
 * No DOM here - only months, budgets and sums - so every number on the card
 * comes from one place and can be checked on its own
 * (tests/revenue-forecast.test.js). revenue-forecast-card.js turns the
 * results into HTML.
 *
 * The rule is deliberately simple. For every project that is counted:
 *
 *     budget   = Low -> min | Mid -> (min + max) / 2 | High -> max
 *     factor   = "As set" -> chance / 100 | "All 100%" -> 1
 *     payment  = each expected payment not yet paid x factor, in its month
 *     rest     = (budget - all payments, paid ones included, at least 0) x factor,
 *                in the project's end month
 *
 * Expected payments (project-payments.js) say when the money comes; what
 * they leave of the budget - all of it, for a project without payments -
 * comes at the end, as the final invoice, the way the cashflow counts it
 * (cashflow.js). Paid payments are money already in, so they are not
 * forecast. The whole budget is always counted: a project still open past
 * its end month - or a payment past its month - is due now, so it lands in
 * this month. One without an end date has no month for its rest: it goes
 * into a separate "undated" sum next to the months.
 *
 * A payment in full (one payment for the whole project) is the project's
 * whole value: no budget is left beside it. Complete projects are forecast
 * only while money is still owed: their unpaid payments, certain (factor 1),
 * in every scenario. Like any payment, each counts in its own month - or,
 * once that has passed and it is still unpaid, in this month, overdue.
 * Months are carried as an offset from the current month: 0 is this month,
 * -3 three months ago, 12 a year from now.
 */
(function (root) {
    'use strict';

    const PP = root.ProjectPayments;

    // The open pipeline, in the order a project moves through it - the
    // stages a scenario switches on and off. Archived projects are no longer
    // in the table.
    const STAGES = [
        { key: 'Lead', label: 'Lead', tone: 'lead' },
        { key: 'Negotiation', label: 'Negotiation', tone: 'negotiation' },
        { key: 'Proposal', label: 'Proposal', tone: 'proposal' },
        { key: 'In Progress', label: 'In progress', tone: 'progress' }
    ];
    const STAGE_KEYS = STAGES.map(s => s.key);

    // Complete projects are forecast only while they are still owed money,
    // and then always: no scenario switches finished work off.
    const COMPLETE = 'Complete';
    const STAGE_INFO = [{ key: COMPLETE, label: 'Complete', tone: 'complete' }].concat(STAGES);

    // Bottom to top in a monthly bar: the surest money carries the rest.
    const STACK = [COMPLETE, 'In Progress', 'Proposal', 'Negotiation', 'Lead'];

    // A preset is only a named combination of the controls below it.
    const PRESETS = [
        { key: 'worst', label: 'Worst', chance: 'as', budget: 'low', stages: ['In Progress'] },
        { key: 'realistic', label: 'Realistic', chance: 'as', budget: 'mid', stages: STAGE_KEYS },
        { key: 'best', label: 'Best', chance: 'all', budget: 'high', stages: STAGE_KEYS }
    ];
    const DEFAULT_PRESET = 'realistic';

    // The axis always shows at least a year.
    const MIN_MONTHS = 12;

    // Clean steps for the y-scale; the scale uses at most four of them.
    const SCALE_STEPS = [1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000,
        100000, 200000, 250000, 500000, 1000000];

    const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // ------------------------------------------------------------------
    // Months
    // ------------------------------------------------------------------

    /** The current month as { year, month } (month 0-11). */
    function monthOf(date) {
        const d = date || new Date();
        return { year: d.getFullYear(), month: d.getMonth() };
    }

    /** "YYYY-MM-DD" (or "YYYY-MM") -> months from `now`, or null. */
    function offsetOf(value, now) {
        const m = /^(\d{4})-(\d{2})/.exec(String(value || ''));
        if (!m) return null;
        const month = Number(m[2]) - 1;
        if (month < 0 || month > 11) return null;
        return (Number(m[1]) - now.year) * 12 + (month - now.month);
    }

    /** Offset -> { year, month }. */
    function calendarMonth(offset, now) {
        const t = now.month + offset;
        return { year: now.year + Math.floor(t / 12), month: ((t % 12) + 12) % 12 };
    }

    function monthName(offset, now) {
        const c = calendarMonth(offset, now);
        return MONTHS_SHORT[c.month] + ' ' + c.year;
    }

    // ------------------------------------------------------------------
    // Projects
    // ------------------------------------------------------------------

    function number(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Sorts API rows into the projects the forecast can use and the open
     * ones it cannot, with the reason. Nothing is guessed: a project without
     * a budget (or expected payments) or a chance is left out and named
     * instead. One without an end date is kept as undated.
     */
    function prepare(projects, now) {
        const items = [];
        const missing = [];

        (projects || []).forEach(p => {
            const complete = p.stage === COMPLETE;
            if (STAGE_KEYS.indexOf(p.stage) < 0 && !complete) return;
            // A project Claude proposed and nobody accepted yet is not ours.
            if (p.review_status === 'pending') return;

            let min = number(p.budget_min);
            let max = number(p.budget_max);
            if (min === null) min = max;
            if (max === null) max = min;
            if (min !== null) { min = Math.max(0, min); max = Math.max(0, max); }
            if (min !== null && min > max) { const t = min; min = max; max = t; }

            const chanceRaw = number(p.success_chance);
            const s = offsetOf(p.start_date, now);
            const e = offsetOf(p.estimated_completion, now);

            const payments = PP.parse(p.payments);
            const planned = payments.reduce((sum, x) => sum + x.amount, 0);
            const full = PP.isFull(payments);
            // Only payments still to come are forecast, each at its month -
            // or this month once that has passed (`at`).
            const due = payments.filter(x => !x.paid).map(x => {
                const o = offsetOf(x.month, now);
                return { o, at: Math.max(o, 0), amount: x.amount, full: !!x.full };
            });

            const base = { id: p.id, name: p.name || 'Untitled project', company: p.company || '', stage: p.stage };

            if (complete) {
                // Paid in full, or never planned: nothing left to forecast.
                if (!due.length) return;
                items.push(Object.assign(base, {
                    chance: 100,
                    min: min === null ? 0 : min, max: max === null ? 0 : max, s, e,
                    undated: false, complete: true, full,
                    payments: payments.length,
                    planned,
                    due
                }));
                return;
            }

            const gaps = [];
            if ((min === null || max === 0) && !payments.length) gaps.push('budget');
            if (chanceRaw === null) gaps.push('chance');
            if (s !== null && e !== null && e < s) gaps.push('end before start');
            // Payments without a budget: the payments are all there is.
            if (min === null) { min = 0; max = 0; }

            if (gaps.length) {
                missing.push(Object.assign(base, { gaps }));
                return;
            }

            items.push(Object.assign(base, {
                chance: Math.max(0, Math.min(100, chanceRaw)),
                min, max, s, e,
                // A payment in full leaves no budget for an end month.
                undated: e === null && !full,
                complete: false, full,
                payments: payments.length,
                planned,
                due
            }));
        });

        return { items, missing };
    }

    /** Months on the axis: this month to the last end month or payment, at least a year. */
    function horizon(items) {
        return items.reduce((n, p) => p.due.reduce((m, x) => Math.max(m, x.at + 1),
            p.undated || p.complete || p.e === null ? n : Math.max(n, p.e + 1)), MIN_MONTHS);
    }

    // ------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------

    function presetByKey(key) {
        return PRESETS.find(p => p.key === key) || null;
    }

    /** The controls a preset stands for, with no project switched off. */
    function settingsFor(key) {
        const p = presetByKey(key) || presetByKey(DEFAULT_PRESET);
        return { chance: p.chance, budget: p.budget, stages: p.stages.slice(), excluded: {} };
    }

    /** Fills in and cleans whatever came back from storage. */
    function normalizeSettings(raw) {
        const d = settingsFor(DEFAULT_PRESET);
        if (!raw || typeof raw !== 'object') return d;
        const excluded = {};
        if (raw.excluded && typeof raw.excluded === 'object') {
            Object.keys(raw.excluded).forEach(id => { if (raw.excluded[id]) excluded[id] = true; });
        }
        return {
            chance: raw.chance === 'all' ? 'all' : 'as',
            budget: ['low', 'mid', 'high'].indexOf(raw.budget) >= 0 ? raw.budget : d.budget,
            stages: Array.isArray(raw.stages) ? STAGE_KEYS.filter(k => raw.stages.indexOf(k) >= 0) : d.stages,
            excluded
        };
    }

    function excludedCount(settings) {
        return Object.keys(settings.excluded || {}).filter(id => settings.excluded[id]).length;
    }

    /** The preset the controls match, or null for a custom scenario. */
    function activePreset(settings) {
        if (excludedCount(settings) > 0) return null;
        const same = (a, b) => a.length === b.length && a.every(x => b.indexOf(x) >= 0);
        const hit = PRESETS.find(p => p.chance === settings.chance
            && p.budget === settings.budget && same(p.stages, settings.stages));
        return hit ? hit.key : null;
    }

    // ------------------------------------------------------------------
    // The sums
    // ------------------------------------------------------------------

    /**
     * The budget a setting counts with. A payment in full, and a complete
     * project, are what their payments say: nothing of the budget is left
     * to come beside them.
     */
    function budgetFor(p, budget) {
        if (p.full || p.complete) return p.planned;
        if (budget === 'low') return p.min;
        if (budget === 'high') return p.max;
        return (p.min + p.max) / 2;
    }

    /** Whether a setting counts a project: its stage is on (complete always is) and it is not switched off. */
    function isCounted(p, settings, respectExcluded) {
        const switchedOff = respectExcluded !== false && settings.excluded && settings.excluded[p.id];
        if (switchedOff) return false;
        return p.complete || settings.stages.indexOf(p.stage) >= 0;
    }

    /** What a project's amounts are multiplied by: its chance, or 1 - always 1 when complete. */
    function factorFor(p, settings) {
        return p.complete || settings.chance === 'all' ? 1 : p.chance / 100;
    }

    /**
     * Monthly revenue for one setting over `months` months, plus what
     * undated projects bring (`undated`, by stage in `undatedByStage`).
     * `excluded` (by project id) only applies when respectExcluded is true:
     * the preset totals for comparison ignore individual switches.
     *
     * perProject[id] also says how a counted project's value comes about, so
     * the card can show it rather than only the result:
     *     open     what its unpaid payments add up to, `openCount` of them
     *     budget   the budget the setting uses (low, middle or high end)
     *     rest     what of that budget the payments (paid ones too) leave open
     *     factor   what both are multiplied by: chance / 100, or 1
     *     after    the part, already multiplied, that falls after the last
     *              month on the axis and so is not in `value`
     *     undated  the part of `value` that went to the "No date" bar
     *
     * `parts[i]` lists what makes up month i, and `undatedParts` the "No
     * date" bar - one entry per payment or budget share, so a hovered bar can
     * say which projects it comes from:
     *     { id, kind: 'payment', amount, raw, o, full }   a payment (raw
     *                                               before the factor; o its
     *                                               own month, earlier when it
     *                                               is overdue)
     *     { id, kind: 'budget', amount, raw, of, months }   the budget left
     *                                               (`of`, here all of `raw`),
     *                                               in the end month (`months`
     *                                               1), or undated (0)
     */
    function compute(items, settings, months, respectExcluded) {
        const byStage = {};
        const undatedByStage = {};
        STACK.forEach(k => { byStage[k] = new Array(months).fill(0); undatedByStage[k] = 0; });
        const perProject = {};
        const parts = Array.from({ length: months }, () => []);
        const undatedParts = [];

        items.forEach(p => {
            const counted = isCounted(p, settings, respectExcluded);
            let value = 0;
            let after = 0;
            let undated = 0;
            const factor = factorFor(p, settings);
            const budget = budgetFor(p, settings.budget);
            const restRaw = Math.max(0, budget - p.planned);
            if (counted) {
                const add = (i, v, part) => {
                    if (i < months) {
                        byStage[p.stage][i] += v;
                        value += v;
                        parts[i].push(Object.assign({ id: p.id, amount: v }, part));
                    } else {
                        after += v;
                    }
                };
                p.due.forEach(x => add(x.at, x.amount * factor, { kind: 'payment', raw: x.amount, o: x.o, full: x.full }));

                const rest = restRaw * factor;
                if (rest > 0 && p.undated) {
                    undatedByStage[p.stage] += rest;
                    value += rest;
                    undated = rest;
                    undatedParts.push({ id: p.id, kind: 'budget', amount: rest, raw: restRaw, of: restRaw, months: 0 });
                } else if (rest > 0) {
                    // At the end, as the final invoice; past its end, due now.
                    add(Math.max(p.e, 0), rest, { kind: 'budget', raw: restRaw, of: restRaw, months: 1 });
                }
            }
            perProject[p.id] = {
                counted, value, factor, budget, after, undated,
                rest: restRaw,
                open: p.due.reduce((sum, x) => sum + x.amount, 0),
                openCount: p.due.length
            };
        });

        const totals = new Array(months).fill(0)
            .map((_, i) => STACK.reduce((sum, k) => sum + byStage[k][i], 0));
        const undated = STACK.reduce((sum, k) => sum + undatedByStage[k], 0);
        const dated = totals.reduce((a, b) => a + b, 0);
        return {
            byStage, totals, undatedByStage, undated, perProject, parts, undatedParts,
            // The total is always what the months hold plus the "No date" bar.
            dated,
            total: dated + undated
        };
    }

    /** The y-axis maximum: the peak rounded up to a clean step, at most 4 steps. */
    function scale(peak) {
        const step = SCALE_STEPS.find(s => peak / s <= 4) || SCALE_STEPS[SCALE_STEPS.length - 1];
        return { step, max: Math.max(step, Math.ceil(peak / step) * step) };
    }

    /**
     * Everything the card shows, for one setting. The scale comes from the
     * Best case, so switching scenarios never rescales the chart; it covers
     * the undated bar too, which the card only draws when `hasUndated`.
     * `months` fixes the axis (Financials' "months ahead"); without it the
     * axis runs to the last end month, at least a year.
     */
    function forecast(items, settings, months) {
        months = months > 0 ? months : horizon(items);
        const current = compute(items, settings, months, true);
        const presets = {};
        PRESETS.forEach(p => { presets[p.key] = compute(items, settingsFor(p.key), months, false); });
        const ceiling = presets.best;

        let busiest = 0;
        current.totals.forEach((v, i) => { if (v > current.totals[busiest]) busiest = i; });

        return {
            months,
            current,
            presets,
            ceiling,
            scale: scale(Math.max(0, ceiling.undated, ...ceiling.totals)),
            busiest,
            // Only when an undated project has budget its payments leave open.
            hasUndated: items.some(p => p.undated && !p.full && p.max > p.planned),
            active: activePreset(settings),
            counted: items.filter(p => current.perProject[p.id].counted).length
        };
    }

    // ------------------------------------------------------------------
    // Numbers
    // ------------------------------------------------------------------

    // Amounts read as everywhere in the CRM (assets/js/format.js): German
    // grouping, the euro sign after, whole euros here - "48.000 €". Written
    // out by hand rather than with Intl, so the tests run without a locale.
    const MINUS = '\u2212';
    const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

    /** "18.900 €", "48.000 €", "950 €". */
    function money(v) {
        return group(Math.round(Math.max(0, v || 0))) + ' €';
    }

    /** The same, for screen readers. */
    function moneyFull(v) {
        return money(v);
    }

    /** For the chart's axis, where room is short: "60k €", "1,2M €", "950 €". */
    function moneyShort(v) {
        const n = Math.abs(v || 0);
        const sign = v < 0 ? MINUS : '';
        const one = x => String(Math.round(x * 10) / 10).replace('.', ',');
        if (n >= 999500) return sign + one(n / 1e6) + 'M €';
        if (n >= 1000) return sign + one(n / 1000) + 'k €';
        return sign + Math.round(n) + ' €';
    }

    /** A budget as typed: "48.000 €" or "24.000 – 30.000 €". */
    function budgetLabel(min, max) {
        if (Math.round(min) === Math.round(max)) return money(min);
        return group(Math.round(Math.max(0, min || 0))) + ' – ' + money(max);
    }

    /** "Dec ’26 – May ’27", one month, "From Dec ’26", "Ends Dec ’26" or "No dates". */
    function periodLabel(s, e, now) {
        const one = o => { const c = calendarMonth(o, now); return MONTHS_SHORT[c.month] + ' ’' + String(c.year).slice(2); };
        if (e === null) return s === null ? 'No dates' : 'From ' + one(s);
        if (s === null) return 'Ends ' + one(e);
        return s === e ? one(s) : one(s) + ' – ' + one(e);
    }

    root.RevenueForecast = {
        STAGES, STAGE_KEYS, STAGE_INFO, COMPLETE, STACK, PRESETS, DEFAULT_PRESET, MONTHS_SHORT,
        monthOf, offsetOf, calendarMonth, monthName,
        prepare, horizon, budgetFor, isCounted, factorFor,
        presetByKey, settingsFor, normalizeSettings, excludedCount, activePreset,
        compute, scale, forecast,
        money, moneyFull, moneyShort, budgetLabel, periodLabel
    };
})(typeof window !== 'undefined' ? window : globalThis);
