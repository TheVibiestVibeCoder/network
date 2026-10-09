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
 */
(function (root) {
    'use strict';

    const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Months offered after the start when a project has no end date.
    const MONTHS_AHEAD = 24;

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

    /** A project's payments (JSON text from the API, or a list) as [{ month, amount, paid }]. */
    function parse(raw) {
        let list = raw;
        if (typeof raw === 'string') {
            try { list = JSON.parse(raw); } catch (e) { list = null; }
        }
        if (!Array.isArray(list)) return [];
        return list
            .map(x => ({ month: String((x && x.month) || ''), amount: number(x && x.amount), paid: !!(x && x.paid) }))
            .filter(x => /^\d{4}-(0[1-9]|1[0-2])$/.test(x.month) && x.amount !== null && x.amount > 0);
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
        const budget = budgetOf(project);
        const out = { count: list.length, paidCount: list.filter(x => x.paid).length, planned, paid, budget, above: 0, below: 0, unplanned: null, open: null };
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
     */
    function monthRange(startDate, endDate, today) {
        const now = monthIndex(today) !== null ? monthIndex(today) : monthIndex(new Date().toISOString());
        const s = monthIndex(startDate);
        const e = monthIndex(endDate);
        const from = s !== null ? s : (e !== null ? Math.min(now, e) : now);
        const to = e !== null && e >= from ? e : from + MONTHS_AHEAD;
        return { from, to };
    }

    /** True when a "YYYY-MM" lies outside the project's months. */
    function isOutside(month, startDate, endDate, today) {
        const r = monthRange(startDate, endDate, today);
        const i = monthIndex(month);
        return i !== null && (i < r.from || i > r.to);
    }

    /**
     * The dropdown's months: the project's range plus any month already in
     * use outside it, so changing a date never silently moves a payment.
     */
    function monthOptions(startDate, endDate, used, today) {
        const r = monthRange(startDate, endDate, today);
        const options = [];
        for (let i = r.from; i <= r.to; i++) options.push({ value: monthKey(i), label: monthLabel(i), outside: false });
        (used || []).forEach(key => {
            const i = monthIndex(key);
            if (i === null || (i >= r.from && i <= r.to) || options.some(o => o.value === key)) return;
            options.push({ value: key, label: monthLabel(i), outside: true });
        });
        return options.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    }

    /** "18.000 €" and "18.450,50 €", as the budget is shown everywhere in the sheet. */
    function euroNumber(n) {
        const v = Math.round(n * 100) / 100;
        const cents = Math.round(Math.abs(v) * 100) % 100 !== 0;
        return v.toLocaleString('de-DE', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
    }
    const euro = n => euroNumber(n) + ' €';

    /** "4.000 – 10.000 €", or one amount when both ends agree. */
    function euroRange(r) {
        return Math.round(r.min * 100) === Math.round(r.max * 100)
            ? euro(r.min)
            : euroNumber(r.min) + ' – ' + euro(r.max);
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
    const ICON_TRASH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
    const ICON_PLUS = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
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
    function sumBlock(sum) {
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

    // ---- A project card: what is still open, prominently ----

    /**
     * Under the card's figures: what is still open, the payment count and
     * the budget bar of the project sheet; '' for a project without payments.
     */
    function cardSummary(project) {
        const list = parse(project && project.payments);
        if (!list.length) return '';
        const sum = summarize(project, list);
        const open = openLabel(sum);
        return `
            <div class="ppay-card${open.done ? ' is-done' : ''}">
                <div class="ppay-card-head">
                    <span class="ppay-card-open">${open.html}</span>
                    <span class="ppay-card-count">${esc(plural(list.length, 'expected payment'))}${sum.paidCount ? ` · ${sum.paidCount} paid` : ''}</span>
                </div>
                ${budgetBar(sum)}
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
            <span class="ppay-count">${esc(plural(list.length, 'expected payment'))}</span>
            <span class="ppay-open${open.done ? ' is-done' : ''}">${open.html}</span>
            ${sum.above > 0 ? `<span class="ppay-flag is-warn">${ICON_WARN}${esc(euro(sum.above))} above budget</span>` : ''}`;

        const startDate = project.start_date;
        const endDate = project.estimated_completion;
        const rows = list.map((p, i) => {
            const outside = isOutside(p.month, startDate, endDate);
            return `
                <li class="ppay-item${p.paid ? ' is-paid' : ''}">
                    <span class="ppay-num" aria-hidden="true">${i + 1}</span>
                    <span class="ppay-item-month">${esc(monthName(p.month))}${outside ? '<span class="ppay-flag is-warn">outside project dates</span>' : ''}</span>
                    <span class="ppay-item-amount">${esc(euro(p.amount))}</span>
                    <span class="ppay-item-status">${p.paid ? `${ICON_CHECK}Paid` : 'Expected'}</span>
                </li>`;
        }).join('');

        listEl.hidden = false;
        listEl.innerHTML = `
            <span class="detail-label">Expected payments</span>
            <ol class="ppay-items">${rows}</ol>
            ${sumBlock(sum)}`;
    }

    // ---- Editing ----

    const editor = {
        el: null,
        fields: null,
        rows: [],   // { key, month, amount (text as typed), paid }
        seq: 0
    };

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
        return editor.rows
            .map(r => ({ month: r.month, amount: typed(r.amount), paid: r.paid }))
            .filter(p => p.amount !== null && p.amount > 0);
    }

    function monthOptionsHtml(row, ctx, used) {
        return monthOptions(ctx.start, ctx.end, used).map(o =>
            `<option value="${esc(o.value)}"${o.value === row.month ? ' selected' : ''}>${esc(o.label)}${o.outside ? ' (outside dates)' : ''}</option>`
        ).join('');
    }

    function renderEditor(focusKey) {
        const el = editor.el;
        if (!el) return;
        const ctx = context();
        const used = editor.rows.map(r => r.month);

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

        if (!editor.rows.length) {
            box.innerHTML = '<p class="ppay-note">Without payments, the forecast spreads the budget over the project’s months.</p>';
            return;
        }

        box.innerHTML = sumBlock(summarize(ctx, payments));
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
            return { error: 'Every expected payment needs an amount above 0.' };
        }
        return { payments: currentPayments() };
    }

    // ---- After a bookkeeping import: which expected payments came in? ----

    const ask = { modal: null, open: [], selected: new Set(), resolve: null, busy: false, returnFocus: null };

    function csrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    /** "2026-10-03" -> "3 Oct 2026"; anything else as it came. */
    function dayName(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
        return m ? Number(m[3]) + ' ' + MONTHS_SHORT[Number(m[2]) - 1] + ' ' + m[1] : String(iso || '');
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
                open.push({ key: open.length, project: p, month: x.month, amount: x.amount, match });
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
                            <span class="ppaid-row-meta">${esc([p.company, p.stage].filter(Boolean).join(' · '))}</span>
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

    root.ProjectPayments = {
        // numbers
        parse, budgetOf, summarize, monthRange, monthOptions, isOutside, monthName, euro, euroRange,
        // sheet
        init, edit, read, renderView, cardSummary,
        // bookkeeping
        askAfterImport
    };
})(typeof window !== 'undefined' ? window : globalThis);
