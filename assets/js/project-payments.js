/**
 * Expected payments on a project: in which month money is expected, how
 * much, and whether it has come in.
 *
 * Two halves. The numbers (parse, summarize, the month list) have no DOM and
 * are shared with the revenue forecast (revenue-forecast.js), so the sheet
 * and the forecast always agree. The rest draws the payments: on a project
 * card (cardSummary), and in the project sheet a short summary under the
 * budget and the list while reading, an editor while editing. app.js calls
 * init() once, edit() when the sheet enters edit mode, read() when it saves
 * and renderView() when it draws.
 *
 * The budget stays the project's total. Payments plan it: what they do not
 * cover is "not planned yet", what has been paid is subtracted from what is
 * still open. Payments above the budget make the payments the total.
 *
 * Two ways to plan it: partial payments (any number, each in a month of the
 * project), or one payment in full - the whole project at once, in a month
 * that may lie after the project's end (invoices are paid late). A payment
 * in full is the project's value: no budget is "not planned yet" beside it.
 * It is stored as the one payment, marked { full: true }.
 *
 * When a project is set to Complete, askOnComplete() asks whether it has
 * all been paid - a finished project can still be owed its money.
 */
(function (root) {
    'use strict';

    const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Months offered after the start when a project has no end date.
    const MONTHS_AHEAD = 24;
    // How long after the end a payment in full can be expected.
    const MONTHS_AFTER_END = 12;

    // ------------------------------------------------------------------
    // Numbers
    // ------------------------------------------------------------------

    function number(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
    }

    /** What someone typed or pasted into an amount field ("1.234,56", "1,234.56"); null when empty or unreadable. */
    function typed(v) {
        const n = root.CRMAmount ? root.CRMAmount.parse(v) : number(v);
        return n === null || Number.isNaN(n) ? null : n;
    }

    /** A project's payments (JSON text from the API, or a list) as [{ month, amount, paid, full }]. */
    function parse(raw) {
        let list = raw;
        if (typeof raw === 'string') {
            try { list = JSON.parse(raw); } catch (e) { list = null; }
        }
        if (!Array.isArray(list)) return [];
        return list
            .map(x => ({ month: String((x && x.month) || ''), amount: number(x && x.amount), paid: !!(x && x.paid), full: !!(x && x.full) }))
            .filter(x => /^\d{4}-(0[1-9]|1[0-2])$/.test(x.month) && x.amount !== null && x.amount > 0);
    }

    /** True when the payments are one payment in full. */
    function isFull(list) {
        return Array.isArray(list) && list.length === 1 && !!list[0].full;
    }

    /** 'full' or 'partial' - how a project's payments are planned. */
    function modeOf(project) {
        return isFull(parse(project && project.payments)) ? 'full' : 'partial';
    }

    /** The budget as { min, max }, a missing end copying the other; null when there is none. */
    function budgetOf(project) {
        let min = number(project && project.budget_min);
        let max = number(project && project.budget_max);
        if (min === null) min = max;
        if (max === null) max = min;
        if (min === null) return null;
        min = Math.max(0, min);
        max = Math.max(0, max);
        if (min > max) { const t = min; min = max; max = t; }
        return max > 0 ? { min, max } : null;
    }

    /**
     * Where the payments stand against the budget:
     *   planned    all payments, paid ones included
     *   above      how far they go past the (max) budget
     *   below      how far they stay under the (min) budget
     *   unplanned  budget no payment covers yet, as a range
     *   open       what is still to be paid: the larger of budget and
     *              payments, less what has been paid, as a range
     */
    function summarize(project, payments) {
        const list = payments || parse(project && project.payments);
        const planned = list.reduce((s, x) => s + x.amount, 0);
        const paid = list.filter(x => x.paid).reduce((s, x) => s + x.amount, 0);
        const full = isFull(list);
        // A payment in full is the project's value; the budget beside it is only for reference.
        const budget = full ? null : budgetOf(project);
        const out = { count: list.length, paidCount: list.filter(x => x.paid).length, planned, paid, budget, full, above: 0, below: 0, unplanned: null, open: null };
        if (budget) {
            out.above = Math.max(0, planned - budget.max);
            out.below = Math.max(0, budget.min - planned);
            out.unplanned = { min: Math.max(0, budget.min - planned), max: Math.max(0, budget.max - planned) };
            out.open = { min: Math.max(budget.min, planned) - paid, max: Math.max(budget.max, planned) - paid };
        } else {
            out.open = { min: planned - paid, max: planned - paid };
        }
        return out;
    }

    // Months as one number (year * 12 + month 0-11), so ranges are plain loops.
    function monthIndex(value) {
        const m = /^(\d{4})-(\d{2})/.exec(String(value || ''));
        return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
    }
    const monthKey = i => Math.floor(i / 12) + '-' + String((i % 12) + 1).padStart(2, '0');
    const monthLabel = i => MONTHS_SHORT[i % 12] + ' ' + Math.floor(i / 12);

    /** "2026-11" -> "Nov 2026". */
    function monthName(key) {
        const i = monthIndex(key);
        return i === null ? '' : monthLabel(i);
    }

    /**
     * The months a payment can be in: start month to end month. Without an
     * end date, the start and the 24 months after it; without a start date
     * (older projects), from this month or the end month, whichever is first.
     * A payment in full (`full`) can also come up to a year after the end.
     */
    function monthRange(startDate, endDate, today, full) {
        const now = monthIndex(today) !== null ? monthIndex(today) : monthIndex(new Date().toISOString());
        const s = monthIndex(startDate);
        const e = monthIndex(endDate);
        const from = s !== null ? s : (e !== null ? Math.min(now, e) : now);
        let to = e !== null && e >= from ? e : from + MONTHS_AHEAD;
        if (full && e !== null && e >= from) to = e + MONTHS_AFTER_END;
        // Never short of this month: a finished project's money can still be due now.
        if (full) to = Math.max(to, now + MONTHS_AFTER_END);
        return { from, to };
    }

    /** True when a "YYYY-MM" lies outside the project's months. */
    function isOutside(month, startDate, endDate, today, full) {
        const r = monthRange(startDate, endDate, today, full);
        const i = monthIndex(month);
        return i !== null && (i < r.from || i > r.to);
    }

    /** "at the end" / "2 months after the end" / '' - a month against the project's end. */
    function afterEndLabel(month, endDate) {
        const i = monthIndex(month);
        const e = monthIndex(endDate);
        if (i === null || e === null || i < e) return '';
        if (i === e) return 'at the end';
        const n = i - e;
        return n + (n === 1 ? ' month' : ' months') + ' after the end';
    }

    /**
     * The dropdown's months: the project's range plus any month already in
     * use outside it, so changing a date never silently moves a payment.
     */
    function monthOptions(startDate, endDate, used, today, full) {
        const r = monthRange(startDate, endDate, today, full);
        const options = [];
        for (let i = r.from; i <= r.to; i++) options.push({ value: monthKey(i), label: monthLabel(i), outside: false });
        (used || []).forEach(key => {
            const i = monthIndex(key);
            if (i === null || (i >= r.from && i <= r.to) || options.some(o => o.value === key)) return;
            options.push({ value: key, label: monthLabel(i), outside: true });
        });
        return options.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    }

    /** "18.000 €" and "18.450,50 €" (format.js), as amounts read everywhere. */
    const euro = n => root.CRMFormat.amount(n);

    /** "4.000 – 10.000 €", or one amount when both ends agree. */
    function euroRange(r) {
        return Math.round(r.min * 100) === Math.round(r.max * 100)
            ? euro(r.min)
            : root.CRMFormat.amountRange(r.min, r.max);
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const ICON_CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
    const ICON_TRASH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 7h15"/><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12"/></svg>';
    const ICON_PLUS = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    const ICON_WARN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

    const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

    /**
     * The sums under a list of payments, the same while reading and editing.
     *
     * A head line - planned against the budget, and what is still open - over
     * a bar of the budget: paid (green), expected (blue), the rest not planned
     * yet. A budget range shows its uncertain part, min to max, hatched. The
     * bar scales to the budget, or to the payments when they go past it, and
     * then marks where the budget ends. A legend gives each part's amount.
     */
    function sumBlock(sum, ctx) {
        if (sum.full) return fullBlock(sum, ctx);
        const b = sum.budget;
        const expected = sum.planned - sum.paid;
        const open = openLabel(sum);

        const key = (tone, label, value) =>
            `<li><span class="ppay-key is-${tone}" aria-hidden="true"></span>${esc(label)} <strong>${esc(value)}</strong></li>`;
        const unplanned = b && sum.unplanned.max > 0
            ? key('rest', 'Not planned yet', sum.unplanned.min > 0 ? euroRange(sum.unplanned) : 'up to ' + euro(sum.unplanned.max))
            : '';

        let note = '';
        if (!b) {
            note = '<p class="ppay-note">No budget set: the forecast uses the payments alone.</p>';
        } else if (sum.above > 0) {
            note = `<p class="ppay-note is-warn">${ICON_WARN}<span><strong>${esc(euro(sum.above))}</strong> above the ${b.min !== b.max ? 'max ' : ''}budget of ${esc(euro(b.max))}</span></p>`;
        }

        const keys = (sum.paid > 0 ? key('paid', 'Paid', euro(sum.paid)) : '')
            + (expected > 0 ? key('expected', 'Expected', euro(expected)) : '')
            + unplanned;

        return `
            <div class="ppay-sum">
                <div class="ppay-sum-head">
                    <span class="ppay-sum-planned">Planned <strong>${esc(euro(sum.planned))}</strong>${b ? ` of ${esc(euroRange(b))}` : ''}</span>
                    <span class="ppay-sum-open${open.done ? ' is-done' : ''}">${open.html}</span>
                </div>
                ${budgetBar(sum)}
                ${keys ? `<ul class="ppay-legend">${keys}</ul>` : ''}
                ${note}
            </div>`;
    }

    /**
     * Under a payment in full: whether it has come in, and the budget for
     * reference when it says something else.
     */
    function fullBlock(sum, ctx) {
        const open = openLabel(sum);
        const b = budgetOf(ctx || {});
        const differs = b && (sum.planned < b.min - 0.005 || sum.planned > b.max + 0.005);
        return `
            <div class="ppay-sum">
                <div class="ppay-sum-head">
                    <span class="ppay-sum-planned">Payment in full <strong>${esc(euro(sum.planned))}</strong></span>
                    <span class="ppay-sum-open${open.done ? ' is-done' : ''}">${open.html}</span>
                </div>
                ${differs ? `<p class="ppay-note">The budget is ${esc(euroRange(b))}; the forecast counts the payment.</p>` : ''}
            </div>`;
    }

    /** The budget bar on its own; also on a project card. Its label reads out every part. */
    function budgetBar(sum) {
        const b = sum.budget;
        const expected = sum.planned - sum.paid;
        const scale = Math.max(b ? b.max : 0, sum.planned) || 1;
        const pct = v => (Math.min(1, Math.max(0, v / scale)) * 100).toFixed(2) + '%';

        const range = b && b.min !== b.max && sum.above <= 0
            ? `<span class="ppay-bar-range" style="left:${pct(b.min)};width:${pct(b.max - b.min)}"></span>` : '';
        // Past the budget: hatched in amber, from where the budget ends.
        const mark = b && sum.above > 0
            ? `<span class="ppay-bar-over" style="left:${pct(b.max)}"></span><span class="ppay-bar-mark" style="left:${pct(b.max)}"></span>` : '';

        const parts = [`Paid ${euro(sum.paid)}`, `expected ${euro(expected)}`];
        if (b && sum.unplanned.max > 0) parts.push(`not planned yet ${euroRange(sum.unplanned)}`);
        if (b && sum.above > 0) parts.push(`${euro(sum.above)} above the budget of ${euro(b.max)}`);
        if (b) parts.push(`budget ${euroRange(b)}`);
        const label = parts.join(' · ');

        return `
            <div class="ppay-bar" role="img" aria-label="${esc(label)}" title="${esc(label)}">
                ${range}
                <span class="ppay-bar-seg is-paid" style="width:${pct(sum.paid)}"></span>
                <span class="ppay-bar-seg is-expected" style="left:${pct(sum.paid)};width:${pct(expected)}"></span>
                ${mark}
            </div>`;
    }

    /** What is still open, or "Fully paid". */
    function openLabel(sum) {
        return sum.open.max <= 0.005
            ? { done: true, html: `${ICON_CHECK}Fully paid` }
            : { done: false, html: `<strong>${esc(euroRange(sum.open))}</strong> <span class="ppay-nowrap">still open</span>` };
    }

    // ---- A project card or list row: one dash per payment, and a line ----

    /**
     * Under the card's figures (and in the list view's row): one dash per
     * payment in month order - received green, overdue red, still expected
     * grey - with a hatched dash for budget no payment covers yet, then one
     * line for what matters most:
     *   everything paid       "Fully paid"
     *   a payment overdue     "6.400 € received · 4.000 € overdue"
     *   some received         "6.400 € received"
     *   nothing received yet  "First 4.000 € in Nov 2026"
     * and "over budget" when the payments add up to more than the budget.
     * The tooltip lists every payment. '' for a project without payments.
     */
    function cardSummary(project, today) {
        const list = parse(project && project.payments)
            .slice()
            .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
        if (!list.length) return '';
        const sum = summarize(project, list);
        const now = monthIndex(today || new Date().toISOString());
        const isLate = x => !x.paid && monthIndex(x.month) !== null && monthIndex(x.month) < now;
        const late = list.filter(isLate);
        const lateSum = late.reduce((t, x) => t + x.amount, 0);
        const unplanned = sum.budget && sum.unplanned.max > 0.005;
        const done = sum.open.max <= 0.005;

        const dashes = list.map(x => `<span class="ppay-dash ${x.paid ? 'is-paid' : isLate(x) ? 'is-late' : 'is-due'}"></span>`).join('')
            + (unplanned ? '<span class="ppay-dash is-unplanned"></span>' : '');

        let text;
        if (done) {
            text = `<span class="is-paid">${ICON_CHECK}Fully paid</span>`;
        } else if (late.length) {
            text = (sum.paid > 0 ? `<span class="is-paid">${esc(euro(sum.paid))} received</span><span class="ppay-sep">·</span>` : '')
                + `<span class="is-late">${esc(euro(lateSum))} overdue</span>`;
        } else if (sum.paid > 0) {
            text = `<span class="is-paid">${esc(euro(sum.paid))} received</span>`;
        } else {
            const next = list.find(x => !x.paid);
            text = sum.full
                ? `<span class="is-due">${esc(euro(next.amount))} due in ${esc(monthName(next.month))}</span>`
                : `<span class="is-due">First ${esc(euro(next.amount))} in ${esc(monthName(next.month))}</span>`;
        }
        if (sum.above > 0) {
            text += `<span class="ppay-sep">·</span><span class="is-warn">over budget</span>`;
        }

        const tip = list.map(x => `${sum.full ? 'Payment in full, ' : ''}${monthName(x.month)}: ${euro(x.amount)} · ${x.paid ? 'received' : isLate(x) ? 'overdue' : 'expected'}`);
        if (unplanned) tip.push(`Not planned yet: ${sum.unplanned.min > 0 ? euroRange(sum.unplanned) : 'up to ' + euro(sum.unplanned.max)}`);
        if (sum.above > 0) tip.push(`${euro(sum.above)} above the budget of ${euro(sum.budget.max)}`);
        if (!done) tip.push(`Still open: ${euroRange(sum.open)}`);

        return `
            <div class="ppay-card" title="${esc(tip.join('\n'))}">
                <span class="ppay-dashes" aria-hidden="true">${dashes}</span>
                <span class="ppay-card-text">${text}</span>
            </div>`;
    }

    // ---- Reading: the summary under the budget and the list ----

    /**
     * Under the budget: "3 expected payments", what is still open and a
     * warning above the budget. The list itself always shows, full width.
     */
    function renderView(project, summaryEl, listEl) {
        if (!summaryEl || !listEl) return;
        const list = parse(project && project.payments);
        const sum = summarize(project, list);

        if (!list.length) {
            summaryEl.innerHTML = '';
            summaryEl.hidden = true;
            listEl.innerHTML = '';
            listEl.hidden = true;
            return;
        }

        const open = openLabel(sum);
        summaryEl.hidden = false;
        summaryEl.innerHTML = `
            <span class="ppay-count">${sum.full ? 'Payment in full' : esc(plural(list.length, 'expected payment'))}</span>
            <span class="ppay-open${open.done ? ' is-done' : ''}">${open.html}</span>
            ${sum.above > 0 ? `<span class="ppay-flag is-warn">${ICON_WARN}${esc(euro(sum.above))} above budget</span>` : ''}`;

        const startDate = project.start_date;
        const endDate = project.estimated_completion;
        const now = monthIndex(new Date().toISOString());
        const rows = list.map((p, i) => {
            const outside = isOutside(p.month, startDate, endDate, null, sum.full);
            const after = sum.full ? afterEndLabel(p.month, endDate) : '';
            const late = !p.paid && monthIndex(p.month) < now;
            return `
                <li class="ppay-item${p.paid ? ' is-paid' : ''}${late ? ' is-late' : ''}">
                    <span class="ppay-num" aria-hidden="true">${sum.full ? '' : i + 1}</span>
                    <span class="ppay-item-month">${esc(monthName(p.month))}${after ? `<span class="ppay-item-after">${esc(after)}</span>` : ''}${outside ? '<span class="ppay-flag is-warn">outside project dates</span>' : ''}</span>
                    <span class="ppay-item-amount">${esc(euro(p.amount))}</span>
                    <span class="ppay-item-status">${p.paid ? `${ICON_CHECK}Paid` : late ? 'Overdue' : 'Expected'}</span>
                </li>`;
        }).join('');

        listEl.hidden = false;
        listEl.innerHTML = `
            <span class="detail-label">${sum.full ? 'Payment in full' : 'Expected payments'}</span>
            <ol class="ppay-items${sum.full ? ' is-full' : ''}">${rows}</ol>
            ${sumBlock(sum, project)}`;
    }

    // ---- Editing ----

    const editor = {
        el: null,
        fields: null,
        // 'partial': any number of rows; 'full': exactly one, the payment in full.
        mode: 'partial',
        rows: [],   // { key, month, amount (text as typed), paid }
        seq: 0
    };

    const MODES = [
        { key: 'partial', label: 'Partial', hint: 'Several payments, each in a month of the project' },
        { key: 'full', label: 'In full', hint: 'The whole project in one payment - also after it has ended' }
    ];

    function context() {
        const f = editor.fields;
        return {
            start: f.start.value,
            end: f.end.value,
            budget_min: typed(f.min.value),
            budget_max: typed(f.max.value)
        };
    }

    /** The rows as payments; rows without a usable amount are left out. */
    function currentPayments() {
        const full = editor.mode === 'full';
        return editor.rows
            .map(r => Object.assign({ month: r.month, amount: typed(r.amount), paid: r.paid }, full ? { full: true } : {}))
            .filter(p => p.amount !== null && p.amount > 0);
    }

    function monthOptionsHtml(row, ctx, used) {
        const full = editor.mode === 'full';
        return monthOptions(ctx.start, ctx.end, used, null, full).map(o => {
            const after = full ? afterEndLabel(o.value, ctx.end) : '';
            return `<option value="${esc(o.value)}"${o.value === row.month ? ' selected' : ''}>${esc(o.label)}${after ? ' · ' + esc(after) : ''}${o.outside ? ' (outside dates)' : ''}</option>`;
        }).join('');
    }

    /** What a payment in full starts at: the budget (its middle for a range), else nothing. */
    function defaultFullAmount(ctx) {
        const b = budgetOf(ctx);
        if (!b) return '';
        const v = b.min === b.max ? b.max : (b.min + b.max) / 2;
        return root.CRMAmount ? root.CRMAmount.format(v) : String(Math.round(v * 100) / 100);
    }

    /** Where a payment in full starts: the end month, else this month - inside the months on offer. */
    function defaultFullMonth(ctx) {
        const r = monthRange(ctx.start, ctx.end, null, true);
        const e = monthIndex(ctx.end);
        const now = monthIndex(new Date().toISOString());
        const pick = e !== null ? e : now;
        return monthKey(Math.min(r.to, Math.max(r.from, pick)));
    }

    /**
     * Partial to full: the rows become one payment - what they add up to
     * (the budget when there are none), in the last of their months, paid
     * when all of them were. Full to partial: the payment stays, as the
     * first of the partial payments.
     */
    function switchMode(mode) {
        if (mode === editor.mode) return;
        const ctx = context();
        if (mode === 'full') {
            const amounts = editor.rows.map(r => typed(r.amount)).filter(n => n !== null && n > 0);
            const total = amounts.reduce((a, b) => a + b, 0);
            const months = editor.rows.map(r => r.month).sort();
            editor.rows = [{
                key: ++editor.seq,
                month: months.length ? months[months.length - 1] : defaultFullMonth(ctx),
                amount: total > 0 ? (root.CRMAmount ? root.CRMAmount.format(total) : String(total)) : defaultFullAmount(ctx),
                paid: editor.rows.length > 0 && editor.rows.every(r => r.paid)
            }];
        }
        editor.mode = mode;
        renderEditor(`[data-ppay-mode="${mode}"]`);
    }

    function modeSwitch() {
        return `<div class="segmented ppay-mode" role="group" aria-label="How the project is paid">${MODES.map(m => {
            const on = m.key === editor.mode;
            return `<button type="button" class="segmented-btn${on ? ' active' : ''}" aria-pressed="${on}" data-ppay-mode="${m.key}" title="${esc(m.hint)}">${esc(m.label)}</button>`;
        }).join('')}</div>`;
    }

    function renderEditor(focusKey) {
        const el = editor.el;
        if (!el) return;
        const ctx = context();
        const used = editor.rows.map(r => r.month);
        const full = editor.mode === 'full';
        if (full && !editor.rows.length) {
            editor.rows = [{ key: ++editor.seq, month: defaultFullMonth(ctx), amount: defaultFullAmount(ctx), paid: false }];
        }

        if (full) {
            const r = editor.rows[0];
            el.innerHTML = `
                ${modeSwitch()}
                <ol class="ppay-rows is-full">
                    <li class="ppay-row${r.paid ? ' is-paid' : ''}" data-ppay-row="${r.key}">
                        <select class="form-select ov-field ppay-month" data-ppay-month aria-label="Payment in full: expected in">
                            ${monthOptionsHtml(r, ctx, used)}
                        </select>
                        <span class="ppay-amount">
                            <input type="text" class="form-input ov-field" data-ppay-amount data-amount inputmode="decimal" autocomplete="off"
                                placeholder="Amount" aria-label="Payment in full: amount in euros" value="${esc(r.amount)}">
                            <span class="ppay-currency" aria-hidden="true">€</span>
                        </span>
                        <button type="button" class="ppay-paid" data-ppay-paid role="checkbox" aria-checked="${r.paid}"
                            title="${r.paid ? 'Mark as not paid' : 'Mark as paid'}">
                            <span class="ppay-paid-box" aria-hidden="true">${ICON_CHECK}</span>Paid
                        </button>
                    </li>
                </ol>
                <div class="ppay-foot">
                    <div class="ppay-status" data-ppay-status aria-live="polite"></div>
                </div>`;
            renderStatus();
            if (focusKey) {
                const target = el.querySelector(focusKey);
                if (target) target.focus();
            }
            return;
        }

        const rows = editor.rows.map((r, i) => {
            const n = i + 1;
            const outside = isOutside(r.month, ctx.start, ctx.end);
            return `
                <li class="ppay-row${r.paid ? ' is-paid' : ''}" data-ppay-row="${r.key}">
                    <span class="ppay-num" aria-hidden="true">${n}</span>
                    <select class="form-select ov-field ppay-month${outside ? ' is-outside' : ''}" data-ppay-month aria-label="Payment ${n}: month">
                        ${monthOptionsHtml(r, ctx, used)}
                    </select>
                    <span class="ppay-amount">
                        <input type="text" class="form-input ov-field" data-ppay-amount data-amount inputmode="decimal" autocomplete="off"
                            placeholder="Amount" aria-label="Payment ${n}: amount in euros" value="${esc(r.amount)}">
                        <span class="ppay-currency" aria-hidden="true">€</span>
                    </span>
                    <button type="button" class="ppay-paid" data-ppay-paid role="checkbox" aria-checked="${r.paid}"
                        title="${r.paid ? 'Mark as not paid' : 'Mark as paid'}">
                        <span class="ppay-paid-box" aria-hidden="true">${ICON_CHECK}</span>Paid
                    </button>
                    <button type="button" class="ppay-remove" data-ppay-remove aria-label="Remove payment ${n}" title="Remove payment">${ICON_TRASH}</button>
                </li>`;
        }).join('');

        el.innerHTML = `
            ${modeSwitch()}
            ${editor.rows.length ? `<ol class="ppay-rows">${rows}</ol>` : ''}
            <div class="ppay-foot">
                <button type="button" class="ov-add-btn ppay-add" data-ppay-add>${ICON_PLUS}Add payment</button>
                <div class="ppay-status" data-ppay-status aria-live="polite"></div>
            </div>`;

        renderStatus();

        if (focusKey) {
            const target = el.querySelector(focusKey);
            if (target) target.focus();
        }
    }

    /** The lines under the rows; redrawn on every keystroke, the rows are not. */
    function renderStatus() {
        const box = editor.el && editor.el.querySelector('[data-ppay-status]');
        if (!box) return;
        const ctx = context();
        const payments = currentPayments();

        if (editor.mode === 'full') {
            const r = editor.rows[0];
            const after = r ? afterEndLabel(r.month, ctx.end) : '';
            box.innerHTML = (payments.length ? sumBlock(summarize(ctx, payments), ctx) : '')
                + `<p class="ppay-note">The whole project in one payment${after ? ', expected ' + esc(after) : ''}. Pick a month after the end when the invoice is paid later.</p>`;
            return;
        }

        if (!editor.rows.length) {
            box.innerHTML = '<p class="ppay-note">Without payments, the forecast counts the budget at the project’s end.</p>';
            return;
        }

        box.innerHTML = sumBlock(summarize(ctx, payments), ctx);
    }

    /** The first month of the range no payment uses yet, else the last one used. */
    function nextMonth() {
        const ctx = context();
        const used = editor.rows.map(r => r.month);
        const free = monthOptions(ctx.start, ctx.end, []).find(o => used.indexOf(o.value) < 0);
        if (free) return free.value;
        const r = monthRange(ctx.start, ctx.end);
        return used.length ? used[used.length - 1] : monthKey(r.from);
    }

    function rowOf(target) {
        const li = target.closest('[data-ppay-row]');
        const key = li ? Number(li.getAttribute('data-ppay-row')) : null;
        return editor.rows.find(r => r.key === key) || null;
    }

    function init(options) {
        if (editor.el || !options || !options.editor) return;
        editor.el = options.editor;
        editor.fields = options.fields;
        const el = editor.el;

        el.addEventListener('click', e => {
            const btn = e.target.closest('button');
            if (!btn || !el.contains(btn)) return;
            if (btn.hasAttribute('data-ppay-mode')) {
                switchMode(btn.getAttribute('data-ppay-mode'));
                return;
            }
            if (btn.hasAttribute('data-ppay-add')) {
                const key = ++editor.seq;
                editor.rows.push({ key, month: nextMonth(), amount: '', paid: false });
                renderEditor(`[data-ppay-row="${key}"] [data-ppay-amount]`);
                return;
            }
            const row = rowOf(btn);
            if (!row) return;
            if (btn.hasAttribute('data-ppay-paid')) {
                row.paid = !row.paid;
                renderEditor(`[data-ppay-row="${row.key}"] [data-ppay-paid]`);
            } else if (btn.hasAttribute('data-ppay-remove')) {
                const i = editor.rows.indexOf(row);
                editor.rows.splice(i, 1);
                const next = editor.rows[Math.min(i, editor.rows.length - 1)];
                renderEditor(next ? `[data-ppay-row="${next.key}"] [data-ppay-remove]` : '[data-ppay-add]');
            }
        });

        el.addEventListener('input', e => {
            if (!e.target.hasAttribute('data-ppay-amount')) return;
            const row = rowOf(e.target);
            if (!row) return;
            row.amount = e.target.value;
            e.target.classList.remove('is-invalid');
            renderStatus();
        });

        el.addEventListener('change', e => {
            if (!e.target.hasAttribute('data-ppay-month')) return;
            const row = rowOf(e.target);
            if (!row) return;
            row.month = e.target.value;
            renderEditor(`[data-ppay-row="${row.key}"] [data-ppay-month]`);
        });

        // Dates change the months on offer, the budget changes the lines.
        const f = editor.fields;
        [f.start, f.end].forEach(input => input.addEventListener('change', () => renderEditor()));
        [f.min, f.max].forEach(input => input.addEventListener('input', renderStatus));
    }

    /** Edit mode: the editor with this project's payments (none for a new project). */
    function edit(project) {
        editor.mode = modeOf(project);
        editor.rows = parse(project && project.payments).map(p => ({
            key: ++editor.seq,
            month: p.month,
            amount: root.CRMAmount ? root.CRMAmount.format(p.amount) : String(Math.round(p.amount * 100) / 100),
            paid: p.paid
        }));
        renderEditor();
    }

    /**
     * What to save: { payments } or, when a row has no usable amount,
     * { error } with that row's field marked and focused.
     */
    function read() {
        let bad = null;
        editor.rows.forEach(r => {
            const amount = typed(r.amount);
            const field = editor.el.querySelector(`[data-ppay-row="${r.key}"] [data-ppay-amount]`);
            const invalid = amount === null || amount <= 0;
            if (field) field.classList.toggle('is-invalid', invalid);
            if (invalid && !bad) bad = field;
        });
        if (bad) {
            bad.focus();
            return { error: editor.mode === 'full' ? 'The payment in full needs an amount above 0.' : 'Every expected payment needs an amount above 0.' };
        }
        return { payments: currentPayments() };
    }

    // ---- After a bookkeeping import: which expected payments came in? ----

    const ask = { modal: null, open: [], selected: new Set(), resolve: null, busy: false, returnFocus: null };

    function csrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    /** "2026-10-03" -> "Oct 3"; anything else as it came. */
    function dayName(iso) {
        return root.CRMFormat.date(iso) || String(iso || '');
    }

    const sameAmount = (a, b) => Math.abs(a - b) < 0.005;

    /**
     * Shows every open expected payment, across all projects, and asks which
     * of them the imported income paid. incomes: [{ amount, party, date }],
     * amounts above 0. Payments of the same amount as an income are listed
     * first and labelled, but nothing is ticked for the user. Resolves with
     * how many payments were marked paid (0 when there was nothing to ask,
     * or the user chose "Not now").
     */
    async function askAfterImport(incomes) {
        const modal = document.getElementById('ppayPaidModal');
        if (!modal || !incomes || !incomes.length || ask.resolve) return 0;

        let projects = null;
        try {
            const response = await fetch('api/projects.php?' + new URLSearchParams({ search: '', sort: 'name', order: 'ASC' }));
            const result = await response.json();
            projects = result && result.success ? result.data : null;
        } catch (e) {
            projects = null;
        }
        if (!Array.isArray(projects)) return 0;

        const open = [];
        projects.forEach(p => {
            // A project Claude proposed and nobody accepted yet is not ours.
            if (p.review_status === 'pending') return;
            parse(p.payments).forEach(x => {
                if (x.paid) return;
                const match = incomes.find(inc => sameAmount(inc.amount, x.amount)) || null;
                open.push({ key: open.length, project: p, month: x.month, amount: x.amount, full: x.full, match });
            });
        });
        if (!open.length) return 0;

        // Matching amounts first, then by month, oldest first.
        open.sort((a, b) => (!!b.match - !!a.match) || (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

        ask.modal = modal;
        ask.open = open;
        ask.selected = new Set();
        ask.returnFocus = document.activeElement;
        bindAsk(modal);
        renderAsk(incomes);
        modal.classList.add('active');
        const first = modal.querySelector('[data-ppaid-key]');
        if (first) first.focus();

        return new Promise(resolve => { ask.resolve = resolve; });
    }

    function renderAsk(incomes) {
        const modal = ask.modal;
        const total = incomes.reduce((s, x) => s + x.amount, 0);
        modal.querySelector('#ppayPaidSub').textContent = incomes.length === 1
            ? `This import has one incoming payment of ${euro(total)}. Tick the expected payments it covers.`
            : `This import has ${incomes.length} incoming payments, ${euro(total)} in all. Tick the expected payments they cover.`;

        const shown = incomes.slice(0, 6);
        const incomeList = `
            <ul class="ppaid-incomes" aria-label="Income in this import">
                ${shown.map(inc => `
                    <li class="ppaid-income">
                        <span class="ppaid-income-amount">+${esc(euro(inc.amount))}</span>
                        <span class="ppaid-income-text">${esc(inc.party || 'Unknown sender')}${inc.date ? `<span class="ppaid-income-date">${esc(dayName(inc.date))}</span>` : ''}</span>
                    </li>`).join('')}
                ${incomes.length > shown.length ? `<li class="ppaid-income is-more">and ${incomes.length - shown.length} more</li>` : ''}
            </ul>`;

        const row = item => {
            const p = item.project;
            const id = 'ppaid-' + item.key;
            return `
                <li>
                    <label class="ppaid-row${item.match ? ' is-match' : ''}" for="${id}">
                        <input type="checkbox" id="${id}" data-ppaid-key="${item.key}"${ask.selected.has(item.key) ? ' checked' : ''}>
                        <span class="ppaid-row-main">
                            <span class="ppaid-row-name">${esc(p.name || 'Untitled project')}</span>
                            <span class="ppaid-row-meta">${esc([p.company, p.stage, item.full ? 'Payment in full' : ''].filter(Boolean).join(' · '))}</span>
                            ${item.match ? `<span class="ppaid-row-match">${ICON_CHECK}Same amount as ${esc(item.match.party || 'an income')}${item.match.date ? ' on ' + esc(dayName(item.match.date)) : ''}</span>` : ''}
                        </span>
                        <span class="ppaid-row-month">${esc(monthName(item.month))}</span>
                        <span class="ppaid-row-amount">${esc(euro(item.amount))}</span>
                    </label>
                </li>`;
        };

        const matches = ask.open.filter(x => x.match);
        const others = ask.open.filter(x => !x.match);
        const group = (title, items) => items.length ? `
            <section class="ppaid-group">
                <h3 class="ppaid-group-title">${esc(title)} <span>${items.length}</span></h3>
                <ul class="ppaid-list">${items.map(row).join('')}</ul>
            </section>` : '';

        modal.querySelector('#ppayPaidBody').innerHTML = incomeList
            + group('Matching amounts', matches)
            + group(matches.length ? 'Other open payments' : 'Open expected payments', others);
        updateAskCount();
    }

    function updateAskCount() {
        const n = ask.selected.size;
        const sum = ask.open.filter(x => ask.selected.has(x.key)).reduce((s, x) => s + x.amount, 0);
        ask.modal.querySelector('#ppayPaidCount').textContent = n ? `${plural(n, 'payment')} · ${euro(sum)}` : '';
        const confirm = ask.modal.querySelector('#ppayPaidConfirm');
        confirm.disabled = n === 0 || ask.busy;
        confirm.textContent = n ? `Mark ${n} as paid` : 'Mark as paid';
    }

    function closeAsk(marked) {
        if (!ask.modal) return;
        ask.modal.classList.remove('active');
        const resolve = ask.resolve;
        ask.resolve = null;
        if (ask.returnFocus && ask.returnFocus.focus) ask.returnFocus.focus();
        if (resolve) resolve(marked || 0);
    }

    async function confirmAsk() {
        const chosen = ask.open.filter(x => ask.selected.has(x.key));
        if (!chosen.length || ask.busy) return;
        ask.busy = true;
        updateAskCount();
        try {
            const response = await fetch('api/projects.php?action=mark-payments-paid', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
                body: JSON.stringify({ payments: chosen.map(x => ({ project_id: x.project.id, month: x.month, amount: x.amount })) })
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || 'Request failed');
            // Projects on screen (cards, forecast, an open sheet) catch up.
            document.dispatchEvent(new CustomEvent('crm:projects-changed'));
            closeAsk(result.marked);
        } catch (e) {
            const count = ask.modal.querySelector('#ppayPaidCount');
            count.textContent = 'Could not save: ' + e.message;
            count.classList.add('is-error');
        } finally {
            ask.busy = false;
            if (ask.modal.classList.contains('active')) updateAskCount();
        }
    }

    let askBound = false;
    function bindAsk(modal) {
        if (askBound) return;
        askBound = true;
        modal.addEventListener('click', e => {
            if (e.target.closest('[data-ppaid-close]')) closeAsk(0);
        });
        modal.addEventListener('change', e => {
            const box = e.target.closest('[data-ppaid-key]');
            if (!box) return;
            const key = Number(box.getAttribute('data-ppaid-key'));
            if (box.checked) ask.selected.add(key); else ask.selected.delete(key);
            modal.querySelector('#ppayPaidCount').classList.remove('is-error');
            updateAskCount();
        });
        modal.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); closeAsk(0); }
        });
        modal.querySelector('#ppayPaidConfirm').addEventListener('click', confirmAsk);
    }

    // ---- Set to Complete: has it all been paid? ----

    /**
     * Whether completing a project with these payments needs asking: unless
     * every payment is already marked paid and they cover the budget, a
     * finished project may still be owed money.
     */
    function needsCompleteCheck(project, payments) {
        const list = parse(payments);
        if (!list.length || list.some(x => !x.paid)) return true;
        const sum = summarize(project, list);
        return !sum.full && !!sum.budget && sum.unplanned.max > 0.005;
    }

    const done = { modal: null, project: null, list: [], answer: null, ticked: new Set(), rest: false, resolve: null, returnFocus: null };

    /**
     * Asks, when a project is set to Complete, whether everything has been
     * paid. project: the project as it is about to be saved (budget, dates,
     * name); payments: what the sheet is about to save.
     *
     * Resolves with the payments to save instead:
     *   yes, all paid       every payment marked paid (none stay none)
     *   not yet, partial    the open payments stay open; the ones ticked as
     *                       received are marked paid. Budget no payment
     *                       covers can be added as one more payment.
     *   not yet, otherwise  one payment in full, unpaid, with the amount and
     *                       the month it is expected in
     * or with null when the user goes back to editing.
     */
    function askOnComplete(project, payments) {
        const modal = document.getElementById('ppayCompleteModal');
        const list = parse(payments);
        if (!modal || done.resolve) return Promise.resolve({ payments: list });

        done.modal = modal;
        done.project = project || {};
        done.list = list;
        done.answer = null;
        done.ticked = new Set();
        done.amount = undefined;
        done.month = null;
        done.restMonth = null;
        done.returnFocus = document.activeElement;
        const sum = summarize(done.project, list);
        // Budget the payments leave open: offered as a final payment.
        done.restAmount = !sum.full && sum.budget && sum.unplanned.max > 0.005 ? sum.unplanned.max : 0;
        done.rest = done.restAmount > 0 && list.every(x => x.paid);
        bindComplete(modal);
        renderComplete();
        modal.classList.add('active');
        const first = modal.querySelector('[data-pdone-answer]');
        if (first) first.focus();
        return new Promise(resolve => { done.resolve = resolve; });
    }

    /** "Nov 2026 · this month" etc: months from half a year back to a year ahead, the end month included. */
    function completeMonthOptions(selected) {
        const now = monthIndex(new Date().toISOString());
        const end = monthIndex(done.project.estimated_completion);
        const from = Math.min(now - 6, end === null ? now : end);
        const to = Math.max(now + MONTHS_AFTER_END, end === null ? now : end);
        const out = [];
        for (let i = from; i <= to; i++) {
            const key = monthKey(i);
            const notes = [];
            if (i === now) notes.push('this month');
            const after = afterEndLabel(key, done.project.estimated_completion);
            if (after) notes.push(after);
            out.push(`<option value="${key}"${key === selected ? ' selected' : ''}>${esc(monthLabel(i))}${notes.length ? ' · ' + esc(notes.join(', ')) : ''}</option>`);
        }
        return out.join('');
    }

    function renderComplete() {
        const modal = done.modal;
        const p = done.project;
        const list = done.list;
        const open = list.filter(x => !x.paid);
        const partial = list.length > 0 && !isFull(list);
        const existingFull = isFull(list) ? list[0] : null;
        const nowKey = monthKey(monthIndex(new Date().toISOString()));

        modal.querySelector('#ppayCompleteSub').textContent =
            `${p.name || 'This project'} is now complete. Finished work can still be owed money - say what has come in, so the forecast and the cashflow stay right.`;

        const option = (value, title, text) => `
            <label class="pdone-choice${done.answer === value ? ' is-on' : ''}">
                <input type="radio" name="pdoneAnswer" value="${value}" data-pdone-answer${done.answer === value ? ' checked' : ''}>
                <span class="pdone-choice-text"><strong>${esc(title)}</strong><span>${esc(text)}</span></span>
            </label>`;

        const openSum = open.reduce((t, x) => t + x.amount, 0);
        let html = `<div class="pdone-choices" role="radiogroup" aria-label="Has everything been paid?">
            ${option('yes', 'Yes, everything is paid', list.length ? 'Every payment is marked as received.' : 'Nothing is left to come in.')}
            ${option('no', 'Not yet', partial && open.length
                ? `${euro(openSum)} in ${plural(open.length, 'payment')} still open - they stay in the forecast and the cashflow.`
                : 'The money still to come stays in the forecast (this month) and the cashflow.')}
        </div>`;

        if (done.answer === 'no' && partial) {
            const rows = open.map((x, i) => `
                <li><label class="pdone-pay">
                    <input type="checkbox" data-pdone-tick="${i}"${done.ticked.has(i) ? ' checked' : ''}>
                    <span class="pdone-pay-month">${esc(monthName(x.month))}</span>
                    <span class="pdone-pay-amount">${esc(euro(x.amount))}</span>
                </label></li>`).join('');
            html += `<div class="pdone-detail">
                ${open.length ? `<p class="pdone-label">Already received? Tick them - the rest stays open.</p><ul class="pdone-pays">${rows}</ul>` : ''}
                ${done.restAmount > 0 ? `
                <label class="pdone-pay pdone-rest">
                    <input type="checkbox" data-pdone-rest${done.rest ? ' checked' : ''}>
                    <span class="pdone-pay-month">Expect the rest of the budget (${esc(euro(done.restAmount))}) as a final payment in</span>
                    <select class="form-select" data-pdone-rest-month aria-label="Final payment expected in">${completeMonthOptions(done.restMonth || nowKey)}</select>
                </label>` : ''}
            </div>`;
        } else if (done.answer === 'no') {
            const amount = done.amount !== undefined ? done.amount
                : existingFull ? (root.CRMAmount ? root.CRMAmount.format(existingFull.amount) : String(existingFull.amount))
                : defaultFullAmount({ budget_min: p.budget_min, budget_max: p.budget_max });
            html += `<div class="pdone-detail">
                <p class="pdone-label">The payment still to come, as one payment in full:</p>
                <div class="pdone-fields">
                    <label class="pdone-field"><span>Amount</span>
                        <span class="ppay-amount"><input type="text" class="form-input" data-pdone-amount data-amount inputmode="decimal" autocomplete="off" value="${esc(amount)}" placeholder="Amount"><span class="ppay-currency" aria-hidden="true">€</span></span></label>
                    <label class="pdone-field"><span>Expected in</span>
                        <select class="form-select" data-pdone-month>${completeMonthOptions(done.month || (existingFull ? existingFull.month : nowKey))}</select></label>
                </div>
                <p class="pdone-error" data-pdone-error role="alert" hidden></p>
            </div>`;
        }

        modal.querySelector('#ppayCompleteBody').innerHTML = html;
        const confirm = modal.querySelector('#ppayCompleteConfirm');
        confirm.disabled = !done.answer;
        confirm.textContent = done.answer === 'yes' ? 'Save as paid' : done.answer === 'no' ? 'Save as open' : 'Save';
    }

    function closeComplete(result) {
        if (!done.modal) return;
        done.modal.classList.remove('active');
        const resolve = done.resolve;
        done.resolve = null;
        if (done.returnFocus && done.returnFocus.focus) done.returnFocus.focus();
        if (resolve) resolve(result);
    }

    function confirmComplete() {
        const list = done.list;
        if (done.answer === 'yes') {
            closeComplete({ payments: list.map(x => Object.assign({}, x, { paid: true })) });
            return;
        }
        if (done.answer !== 'no') return;

        if (list.length && !isFull(list)) {
            const open = list.filter(x => !x.paid);
            const out = list.map(x => {
                const i = open.indexOf(x);
                return Object.assign({}, x, { paid: x.paid || (i >= 0 && done.ticked.has(i)) });
            });
            if (done.rest && done.restAmount > 0) {
                out.push({ month: done.restMonth || monthKey(monthIndex(new Date().toISOString())), amount: Math.round(done.restAmount * 100) / 100, paid: false });
                out.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
            }
            closeComplete({ payments: out.map(x => ({ month: x.month, amount: x.amount, paid: x.paid })) });
            return;
        }

        const field = done.modal.querySelector('[data-pdone-amount]');
        const amount = typed(field ? field.value : '');
        if (amount === null || amount <= 0) {
            const err = done.modal.querySelector('[data-pdone-error]');
            err.textContent = 'Enter the amount still to come, e.g. 12.000';
            err.hidden = false;
            if (field) { field.classList.add('is-invalid'); field.focus(); }
            return;
        }
        const month = done.modal.querySelector('[data-pdone-month]').value;
        closeComplete({ payments: [{ month, amount: Math.round(amount * 100) / 100, paid: false, full: true }] });
    }

    let doneBound = false;
    function bindComplete(modal) {
        if (doneBound) return;
        doneBound = true;
        modal.addEventListener('click', e => {
            if (e.target.closest('[data-pdone-close]')) closeComplete(null);
        });
        modal.addEventListener('change', e => {
            const t = e.target;
            if (t.hasAttribute('data-pdone-answer')) {
                done.answer = t.value;
                renderComplete();
                const again = modal.querySelector(`[data-pdone-answer][value="${t.value}"]`);
                if (again) again.focus();
            } else if (t.hasAttribute('data-pdone-tick')) {
                const i = Number(t.getAttribute('data-pdone-tick'));
                if (t.checked) done.ticked.add(i); else done.ticked.delete(i);
            } else if (t.hasAttribute('data-pdone-rest')) {
                done.rest = t.checked;
            } else if (t.hasAttribute('data-pdone-rest-month')) {
                done.restMonth = t.value;
                done.rest = true;
                const box = modal.querySelector('[data-pdone-rest]');
                if (box) box.checked = true;
            } else if (t.hasAttribute('data-pdone-month')) {
                done.month = t.value;
            }
        });
        modal.addEventListener('input', e => {
            if (e.target.hasAttribute('data-pdone-amount')) {
                done.amount = e.target.value;
                e.target.classList.remove('is-invalid');
            }
        });
        modal.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); closeComplete(null); }
            if (e.key === 'Enter' && e.target.matches('input[type="text"]')) { e.preventDefault(); confirmComplete(); }
        });
        modal.querySelector('#ppayCompleteConfirm').addEventListener('click', confirmComplete);
    }

    root.ProjectPayments = {
        // numbers
        parse, isFull, modeOf, budgetOf, summarize, monthRange, monthOptions, isOutside, afterEndLabel, monthName, euro, euroRange,
        // sheet
        init, edit, read, renderView, cardSummary,
        // set to Complete
        needsCompleteCheck, askOnComplete,
        // bookkeeping
        askAfterImport
    };
})(typeof window !== 'undefined' ? window : globalThis);
