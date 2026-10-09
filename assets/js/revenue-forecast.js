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
 *     rest     = (budget - all payments, paid ones included, at least 0) x factor
 *     perMonth = rest / months still to come, from the later of start and
 *                this month to end, inclusive
 *
 * Expected payments (project-payments.js) say when the money comes; only
 * what they leave of the budget is spread. Paid payments are money already
 * in, so they are not forecast. The whole budget is always counted: a
 * project that started in the past spreads all of it over the months it has
 * left, and one still open past its end month - or a payment past its month
 * - is due now, so it lands in this month. A project without a start date
 * is due in its end month. One without an end date cannot be spread over
 * months: its rest goes into a separate "undated" sum next to the months.
 * Months are carried as an offset from the current month: 0 is this month,
 * -3 three months ago, 12 a year from now.
 */
(function (root) {
    'use strict';

    const PP = root.ProjectPayments;

    // The open pipeline, in the order a project moves through it. Complete
    // projects are not forecast; archived ones are no longer in the table.
    const STAGES = [
        { key: 'Lead', label: 'Lead', tone: 'lead' },
        { key: 'Negotiation', label: 'Negotiation', tone: 'negotiation' },
        { key: 'Proposal', label: 'Proposal', tone: 'proposal' },
        { key: 'In Progress', label: 'In progress', tone: 'progress' }
    ];
    const STAGE_KEYS = STAGES.map(s => s.key);

    // Bottom to top in a monthly bar: the surest money carries the rest.
    const STACK = ['In Progress', 'Proposal', 'Negotiation', 'Lead'];

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
            if (STAGE_KEYS.indexOf(p.stage) < 0) return;
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
            // Only payments still to come are forecast, each at its month.
            const due = payments.filter(x => !x.paid).map(x => ({ o: offsetOf(x.month, now), amount: x.amount }));

            const gaps = [];
            if ((min === null || max === 0) && !payments.length) gaps.push('budget');
            if (chanceRaw === null) gaps.push('chance');
            if (s !== null && e !== null && e < s) gaps.push('end before start');
            // Payments without a budget: the payments are all there is.
            if (min === null) { min = 0; max = 0; }

            const base = { id: p.id, name: p.name || 'Untitled project', company: p.company || '', stage: p.stage };
            if (gaps.length) {
                missing.push(Object.assign(base, { gaps }));
                return;
            }

            items.push(Object.assign(base, {
                chance: Math.max(0, Math.min(100, chanceRaw)),
                min, max, s, e,
                undated: e === null,
                payments: payments.length,
                planned,
                due
            }));
        });

        return { items, missing };
    }

    /** Months on the axis: this month to the last end month or payment, at least a year. */
    function horizon(items) {
        return items.reduce((n, p) => p.due.reduce((m, x) => Math.max(m, x.o + 1),
            p.undated ? n : Math.max(n, p.e + 1)), MIN_MONTHS);
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

    function budgetFor(p, budget) {
        if (budget === 'low') return p.min;
        if (budget === 'high') return p.max;
        return (p.min + p.max) / 2;
    }

    /**
     * Monthly revenue for one setting over `months` months, plus what
     * undated projects bring (`undated`, by stage in `undatedByStage`).
     * `excluded` (by project id) only applies when respectExcluded is true:
     * the preset totals for comparison ignore individual switches.
     */
    function compute(items, settings, months, respectExcluded) {
        const byStage = {};
        const undatedByStage = {};
        STAGE_KEYS.forEach(k => { byStage[k] = new Array(months).fill(0); undatedByStage[k] = 0; });
        const perProject = {};

        items.forEach(p => {
            const switchedOff = respectExcluded && settings.excluded && settings.excluded[p.id];
            const counted = settings.stages.indexOf(p.stage) >= 0 && !switchedOff;
            let value = 0;
            if (counted) {
                const factor = settings.chance === 'all' ? 1 : p.chance / 100;
                const add = (i, v) => {
                    if (i < months) { byStage[p.stage][i] += v; value += v; }
                };
                p.due.forEach(x => add(Math.max(x.o, 0), x.amount * factor));

                const rest = Math.max(0, budgetFor(p, settings.budget) - p.planned) * factor;
                if (rest > 0 && p.undated) {
                    undatedByStage[p.stage] += rest;
                    value += rest;
                } else if (rest > 0) {
                    // No start date: all of it is due in the end month.
                    const first = Math.max(p.s === null ? p.e : p.s, 0);
                    const last = Math.max(p.e, 0);
                    const perMonth = rest / (last - first + 1);
                    for (let i = first; i <= last; i++) add(i, perMonth);
                }
            }
            perProject[p.id] = { counted, value };
        });

        const totals = new Array(months).fill(0)
            .map((_, i) => STAGE_KEYS.reduce((sum, k) => sum + byStage[k][i], 0));
        const undated = STAGE_KEYS.reduce((sum, k) => sum + undatedByStage[k], 0);
        return {
            byStage, totals, undatedByStage, undated, perProject,
            total: totals.reduce((a, b) => a + b, 0) + undated
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
            hasUndated: items.some(p => p.undated && p.max > p.planned),
            active: activePreset(settings),
            counted: items.filter(p => current.perProject[p.id].counted).length
        };
    }

    // ------------------------------------------------------------------
    // Numbers
    // ------------------------------------------------------------------

    /** "€18.9k", "€48k", "€141k", "€1.2M", "€950". */
    function money(v) {
        const n = Math.max(0, v || 0);
        if (n >= 999500) return '€' + (Math.round(n / 100000) / 10).toString().replace(/\.0$/, '') + 'M';
        if (n >= 99950) return '€' + Math.round(n / 1000) + 'k';
        if (n >= 1000) return '€' + (Math.round(n / 100) / 10).toString().replace(/\.0$/, '') + 'k';
        return '€' + Math.round(n);
    }

    /** "€48,000" - for screen readers. */
    function moneyFull(v) {
        return '€' + Math.round(Math.max(0, v || 0)).toLocaleString('en-US');
    }

    /** A budget as typed: "€48k" or "€24–30k". */
    function budgetLabel(min, max) {
        if (min === max) return money(min);
        const a = money(min);
        const b = money(max);
        const unit = b.slice(-1);
        return (a.slice(-1) === unit && /[kM]/.test(unit) ? a.slice(0, -1) : a) + '–' + b.slice(1);
    }

    /** "Dec ’26 – May ’27", one month, "From Dec ’26", "Ends Dec ’26" or "No dates". */
    function periodLabel(s, e, now) {
        const one = o => { const c = calendarMonth(o, now); return MONTHS_SHORT[c.month] + ' ’' + String(c.year).slice(2); };
        if (e === null) return s === null ? 'No dates' : 'From ' + one(s);
        if (s === null) return 'Ends ' + one(e);
        return s === e ? one(s) : one(s) + ' – ' + one(e);
    }

    root.RevenueForecast = {
        STAGES, STAGE_KEYS, STACK, PRESETS, DEFAULT_PRESET, MONTHS_SHORT,
        monthOf, offsetOf, calendarMonth, monthName,
        prepare, horizon,
        presetByKey, settingsFor, normalizeSettings, excludedCount, activePreset,
        compute, scale, forecast,
        money, moneyFull, budgetLabel, periodLabel
    };
})(typeof window !== 'undefined' ? window : globalThis);
