/**
 * Financials (admins only): cash, costs and what is coming in.
 *
 * Draws the tab from four sources: the projects (budgets, expected
 * payments), our costs, balance and settings (api/financials.php), and the
 * bank movements in Bookkeeping. The numbers all come from cashflow.js; this
 * file only turns them into HTML and saves what is edited here.
 *
 * The scenario is the revenue forecast's (revenue-forecast-card.js): its
 * switch - Worst / Realistic / Best, with the adjustments behind "Adjust" -
 * sits in this page's header, since the whole page plans with it.
 *
 * app.js calls window.Financials.load() when the tab opens.
 */
(function () {
    'use strict';

    const RF = window.RevenueForecast;
    const CF = window.Cashflow;
    const PP = window.ProjectPayments;
    const Card = window.RevenueForecastCard;
    if (!RF || !CF || !PP || !Card) return;

    const API = 'api/financials.php';
    const HORIZON_KEY = 'crm.financials.months';
    const CATEGORIES = ['Salaries', 'Rent', 'Software', 'Insurance', 'Taxes', 'Freelancers', 'Travel', 'Marketing', 'Bank', 'Other'];
    const INTERVALS = [
        { value: 1, label: 'Monthly', short: 'monthly' },
        { value: 3, label: 'Quarterly', short: 'quarterly' },
        { value: 6, label: 'Every 6 months', short: 'every 6 months' },
        { value: 12, label: 'Yearly', short: 'yearly' }
    ];

    const state = {
        inited: false,
        loading: false,
        loaded: false,
        error: null,
        projects: [],
        overview: { costs: [], balances: [], settings: CF.DEFAULT_SETTINGS },
        tx: { rows: [], amountColumn: null, error: null },
        months: CF.DEFAULT_HORIZON,
        plan: null,
        // A cost being added or edited: a draft of its fields, id null for new.
        draft: null,
        draftError: '',
        balanceOpen: false,
        balanceError: '',
        bufferOpen: false,
        bufferError: '',
        openMonths: new Set(),
        showPastPlanned: false,
        hover: null,
        token: 0
    };

    const els = {};

    // ------------------------------------------------------------------
    // Small things
    // ------------------------------------------------------------------

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Whole euros: cents are noise when planning cash.
    const euro = n => PP.euro(Math.round(n));
    const MINUS = '−';
    /** "+1.200 €" / "−300 €" / "0 €". */
    const signed = n => (Math.round(n) > 0 ? '+' : Math.round(n) < 0 ? MINUS : '') + PP.euro(Math.abs(Math.round(n)));
    /** "57,5k €", with a minus when below zero - for the chart's axis. */
    const short = n => RF.moneyShort(n);
    const plural = (n, word, many) => n + ' ' + (n === 1 ? word : (many || word + 's'));

    /** An amount field's value: a number, null when empty, NaN when it cannot be read. */
    const readAmount = value => (window.CRMAmount ? window.CRMAmount.parse(value) : (value === '' ? null : Number(value)));
    const showAmount = n => (window.CRMAmount ? window.CRMAmount.format(n) : String(n ?? ''));

    function todayIso() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    /** "2026-10-01" -> "Oct 1" (format.js). */
    function dayName(iso) {
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ''));
        return m ? window.CRMFormat.date(m[1]) : '';
    }

    function monthKey(offset, now) {
        const c = RF.calendarMonth(offset, now);
        return c.year + '-' + String(c.month + 1).padStart(2, '0');
    }

    function ordinal(n) {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    function csrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    async function getJson(url) {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || 'Request failed');
        return result;
    }

    async function post(action, payload) {
        const response = await fetch(`${API}?action=${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || 'Request failed');
        return result;
    }

    const ICON = {
        plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
        warn: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
        trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 7h15"/><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12"/></svg>',
        bank: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.5 12 4.5l8.5 5"/><path d="M5.5 10v7M10 10v7M14 10v7M18.5 10v7"/><path d="M3.5 19.5h17"/></svg>'
    };

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    function init() {
        if (state.inited) return;
        state.inited = true;
        ['financialsView', 'finHeadTools', 'finPage', 'finKpis', 'finAlerts', 'finChart', 'finMonths',
            'finCosts', 'finCostsModal', 'finForecast', 'finScenario', 'finAdjust'].forEach(id => { els[id] = document.getElementById(id); });

        try {
            const stored = Number(localStorage.getItem(HORIZON_KEY));
            if (CF.HORIZONS.indexOf(stored) >= 0) state.months = stored;
        } catch (e) { /* no storage: a year */ }

        Card.init(els.finForecast, { name: 'financials', controls: els.finScenario, adjust: els.finAdjust });
        // The forecast looks as far ahead as the rest of the page.
        Card.setMonths(state.months);
        Card.onChange(() => {
            if (!state.loaded) return;
            compute();
            render();
        });

        bind();

        if (window.ResizeObserver) {
            let width = 0;
            new ResizeObserver(entries => {
                const w = Math.round(entries[0].contentRect.width);
                if (w !== width) {
                    width = w;
                    drawPlot();
                }
            }).observe(els.finChart);
        }
    }

    async function load() {
        init();
        const token = ++state.token;
        state.loading = true;
        if (!state.loaded) renderSkeleton();

        try {
            const [projects, overview, tx] = await Promise.all([
                getJson('api/projects.php?' + new URLSearchParams({ search: '', sort: 'name', order: 'ASC' })).then(r => r.data || []),
                getJson(`${API}?action=overview`).then(r => r.data),
                (window.Bookkeeping && window.Bookkeeping.transactions
                    ? window.Bookkeeping.transactions()
                    : Promise.resolve({ rows: [], amountColumn: null }))
                    .catch(error => ({ rows: [], amountColumn: null, error: error.message || 'unavailable' }))
            ]);
            if (token !== state.token) return;
            state.projects = projects;
            state.overview = overview;
            state.tx = tx;
            state.error = null;
            Card.setProjects(projects);
            state.loaded = true;
            compute();
            render();
        } catch (error) {
            if (token !== state.token) return;
            state.error = error.message || 'Could not load';
            renderError();
        } finally {
            if (token === state.token) state.loading = false;
        }
    }

    function compute() {
        state.plan = CF.plan({
            projects: state.projects,
            costs: state.overview.costs,
            balances: state.overview.balances,
            transactions: state.tx.rows,
            settings: state.overview.settings,
            scenario: Card.getSettings(),
            months: state.months,
            now: RF.monthOf(new Date()),
            today: todayIso()
        });
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    function renderSkeleton() {
        els.finPage.setAttribute('aria-busy', 'true');
        els.finKpis.innerHTML = [0, 1].map(() => '<div class="fin-kpi is-skeleton"><span class="fin-skel"></span><span class="fin-skel is-big"></span><span class="fin-skel"></span></div>').join('');
        els.finChart.innerHTML = '<div class="fin-skel is-chart"></div>';
    }

    function renderError() {
        els.finPage.setAttribute('aria-busy', 'false');
        els.finKpis.innerHTML = `<div class="fin-error">${ICON.warn}<span>Financials could not be loaded: ${esc(state.error)}</span>
            <button type="button" class="btn btn-secondary btn-small" data-fin-retry>Try again</button></div>`;
    }

    function render() {
        if (!state.plan) return;
        const active = document.activeElement;
        const focusKey = active && els.financialsView.contains(active) ? active.getAttribute('data-fin-focus') : null;

        els.finPage.setAttribute('aria-busy', 'false');
        renderKpis();
        renderAlerts();
        renderChart();
        renderMonths();
        renderCosts();

        if (focusKey) {
            const again = els.financialsView.querySelector(`[data-fin-focus="${focusKey}"]`);
            if (again) again.focus();
        }
    }

    function segmented(kind, label, options, current) {
        return `<div class="segmented fin-seg" role="group" aria-label="${esc(label)}">${options.map(o => {
            const on = String(o.key) === String(current);
            return `<button type="button" class="segmented-btn${on ? ' active' : ''}" aria-pressed="${on}"
                data-fin-${kind}="${esc(o.key)}" data-fin-focus="${kind}-${esc(o.key)}"${o.hint ? ` title="${esc(o.hint)}"` : ''}>${esc(o.label)}</button>`;
        }).join('')}</div>`;
    }

    /**
     * The header: today's bank balance - where the page starts from, not its
     * headline - and how many months ahead it plans. The scenario between
     * them is drawn by the forecast card (#finScenario).
     */
    function renderHead() {
        els.finHeadTools.innerHTML = `
            ${state.plan ? balanceTool() : ''}
            <div class="fin-tool fin-months">
                ${segmented('months', 'Months ahead', CF.HORIZONS.map(n => ({ key: n, label: n + 'M', hint: n + ' months ahead' })), state.months)}
            </div>`;
    }

    /** Where today's balance comes from, in a line. */
    function balanceNote() {
        const b = state.plan.balance;
        let note;
        if (!b) {
            note = 'Enter today’s balance to plan from it';
        } else if (b.rows > 0) {
            note = `${euro(b.anchor.amount)} on ${dayName(b.anchor.asOf)} · ${signed(b.movement)} from ${plural(b.rows, 'bookkeeping row')} since`;
        } else {
            note = `Entered for ${dayName(b.anchor.asOf)}`;
        }
        if (state.tx.error) note += ' · Bookkeeping could not be read';
        return note;
    }

    function balanceTool() {
        const b = state.plan.balance;
        const balanceSub = balanceNote();

        return `
            <div class="fin-tool fin-balance${b ? '' : ' is-empty'}">
                <button type="button" class="fin-balance-btn" data-fin-balance data-fin-focus="balance" aria-expanded="${state.balanceOpen}"
                    title="Bank balance · ${esc(balanceSub)} · click to update">
                    ${ICON.bank}<span class="fin-balance-value">${b ? esc(euro(b.amount)) : 'Enter balance'}</span>
                </button>
                ${state.balanceOpen ? `<div class="fin-balance-pop">
                    <p class="fin-balance-note">${esc(balanceSub)}</p>
                    ${balanceForm()}
                </div>` : ''}
            </div>`;
    }

    /** How the lowest balance stands, as the colour of its figure. */
    function lowestTone() {
        const k = state.plan.kpis;
        return !k.lowest ? '' : k.lowest.amount < 0 ? 'is-danger' : (k.belowBuffer ? 'is-warn' : 'is-ok');
    }

    // ---- The two figures on top ----

    function renderKpis() {
        const p = state.plan;
        const k = p.kpis;

        // The balance lives in the header; its form is redrawn from here too.
        renderHead();

        const lowTone = lowestTone();

        // Fixed costs open the costs sheet (renderCosts), where they are edited.
        els.finKpis.innerHTML = `
            <button type="button" class="fin-kpi fin-kpi--out is-link" data-fin-costs data-fin-focus="costs" aria-haspopup="dialog"
                title="See and edit the costs">
                <span class="fin-kpi-label">Fixed costs</span>
                <span class="fin-kpi-value">${esc(euro(k.fixedPerMonth))}<span class="fin-kpi-unit">/month</span></span>
            </button>
            <article class="fin-kpi fin-kpi--low ${lowTone}">
                <span class="fin-kpi-label">Lowest balance</span>
                <span class="fin-kpi-value">${k.lowest ? esc((k.lowest.amount < 0 ? MINUS : '') + euro(Math.abs(k.lowest.amount))) : '—'}</span>
                ${k.lowest ? `<span class="fin-kpi-sub"><strong>${esc(k.lowest.label)}</strong></span>` : ''}
                <button type="button" class="fin-link fin-kpi-action" data-fin-buffer data-fin-focus="buffer" aria-expanded="${state.bufferOpen}"
                    title="The least that should always be in the account; the chart and this figure warn below it">${p.settings.buffer > 0 ? 'Buffer ' + esc(euro(p.settings.buffer)) : 'Set buffer'}</button>
                ${state.bufferOpen ? bufferForm() : ''}
            </article>`;
    }

    function bufferForm() {
        const buffer = state.plan.settings.buffer;
        return `
            <form class="fin-balance-form" data-fin-buffer-form>
                <label class="fin-field">
                    <span>Cash buffer</span>
                    <span class="fin-amount"><input type="text" class="form-input" name="buffer" data-amount inputmode="decimal" autocomplete="off"
                        value="${buffer > 0 ? esc(showAmount(buffer)) : ''}" placeholder="0" data-fin-focus="buffer-amount"><span aria-hidden="true">€</span></span>
                </label>
                <p class="fin-hint">The least that should always be in the account. The chart and this figure warn below it; 0 turns it off.</p>
                ${state.bufferError ? `<p class="fin-form-error">${esc(state.bufferError)}</p>` : ''}
                <div class="fin-form-actions">
                    <button type="button" class="btn btn-secondary btn-small" data-fin-buffer-cancel>Cancel</button>
                    <button type="submit" class="btn btn-primary btn-small">Save buffer</button>
                </div>
            </form>`;
    }

    function balanceForm() {
        const anchor = state.plan.balance ? state.plan.balance.anchor : null;
        const history = (state.overview.balances || []).slice(0, 5);
        return `
            <form class="fin-balance-form" data-fin-balance-form>
                <div class="fin-field-row">
                    <label class="fin-field">
                        <span>Balance</span>
                        <span class="fin-amount"><input type="text" class="form-input" name="amount" required data-amount autocomplete="off"
                            value="${anchor ? esc(showAmount(state.plan.balance.amount)) : ''}" data-fin-focus="balance-amount" inputmode="decimal"><span aria-hidden="true">€</span></span>
                    </label>
                    <label class="fin-field">
                        <span>At the end of</span>
                        <input type="date" class="form-input" name="as_of" required value="${esc(todayIso())}" max="${esc(todayIso())}">
                    </label>
                </div>
                <p class="fin-hint">Bookkeeping rows dated after this day move the balance from here.</p>
                ${state.balanceError ? `<p class="fin-form-error">${esc(state.balanceError)}</p>` : ''}
                <div class="fin-form-actions">
                    <button type="button" class="btn btn-secondary btn-small" data-fin-balance-cancel>Cancel</button>
                    <button type="submit" class="btn btn-primary btn-small">Save balance</button>
                </div>
                ${history.length ? `<ul class="fin-history" aria-label="Balances entered">${history.map(h => `
                    <li><span>${esc(dayName(h.as_of))}</span><strong>${esc(euro(h.amount))}</strong>
                        <button type="button" class="fin-icon-btn" data-fin-balance-delete="${h.id}" title="Delete this entry" aria-label="Delete the balance of ${esc(dayName(h.as_of))}">${ICON.trash}</button></li>`).join('')}</ul>` : ''}
            </form>`;
    }

    // ---- Alerts: what needs doing ----

    function renderAlerts() {
        const p = state.plan;
        const k = p.kpis;
        const alerts = [];
        // Below zero or below the buffer is on the "Lowest balance" card
        // already, in its colour; a banner repeating it was one too many.
        if (k.overdue.count) {
            const oldest = p.income.filter(x => x.counted && x.overdue).sort((a, b) => a.due - b.due)[0];
            alerts.push({ tone: 'warn', html: `<strong>${esc(euro(k.overdue.amount))} overdue</strong> · ${esc(oldest.name)}${k.overdue.count > 1 ? ` and ${k.overdue.count - 1} more` : ''}` });
        }
        if (!p.hasBalance) {
            alerts.push({ tone: 'info', html: '<strong>No bank balance yet.</strong> The balance line starts at zero until you enter one above.' });
        }
        els.finAlerts.innerHTML = alerts.length
            ? `<div class="fin-alerts">${alerts.map(a => `<p class="fin-alert is-${a.tone}">${ICON.warn}<span>${a.html}</span></p>`).join('')}</div>`
            : '';
    }

    // ---- The cashflow chart ----

    /** Past months (actuals) then the plan, as columns. */
    function chartColumns() {
        const p = state.plan;
        return p.past.map(m => ({ past: true, label: m.label, offset: m.offset, in: m.income, out: m.expenses, closing: m.closing }))
            .concat(p.rows.map(r => ({ past: false, label: r.label, offset: r.offset, in: r.in, out: r.out, closing: p.hasBalance ? r.closing : null, row: r })));
    }

    function renderChart() {
        // No key: the line is the balance, red is below zero, and the
        // buffer line carries its own label.
        els.finChart.innerHTML = `
            <div class="fin-card-head">
                <h2 class="fin-card-title">Cashflow</h2>
            </div>
            <div class="fin-plot-wrap">
                <div class="fin-plot" data-fin-plot></div>
                <div class="fin-hover-tip" data-fin-readout aria-live="polite" hidden></div>
            </div>`;
        drawPlot();
    }

    /** What a hovered month is made of, in the box above its point. */
    function readout(c) {
        const money = v => esc((v < 0 ? MINUS : '') + euro(Math.abs(v)));
        return `
            <strong class="fin-hover-month">${esc(c.label)}${c.past ? ' <span class="fin-tag">actual</span>' : ''}</strong>
            <span><span>In</span><strong class="is-pos">${esc(signed(c.in))}</strong></span>
            <span><span>Out</span><strong>${esc(signed(-c.out))}</strong></span>
            ${c.closing === null ? '' : `<span><span>Balance</span><strong class="${c.closing < 0 ? 'is-neg' : ''}">${money(c.closing)}</strong></span>`}`;
    }

    /** A clean step for about four gridlines across `span`. */
    function niceStep(span) {
        if (span <= 0) return 1000;
        const raw = span / 4;
        const pow = Math.pow(10, Math.floor(Math.log10(raw)));
        const m = raw / pow;
        return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * pow;
    }

    /**
     * A smooth path through the points that never bulges past them: a
     * monotone cubic, so the line shows no high or low the plan does not have.
     */
    function smoothPath(pts) {
        const n = pts.length;
        if (n < 2) return n ? `M${pts[0][0]},${pts[0][1]}` : '';
        const d = [];
        for (let i = 0; i < n - 1; i++) {
            const dx = pts[i + 1][0] - pts[i][0];
            d.push(dx ? (pts[i + 1][1] - pts[i][1]) / dx : 0);
        }
        const m = [d[0]];
        for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
        m.push(d[n - 2]);
        for (let i = 0; i < n - 1; i++) {
            if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
            const a = m[i] / d[i], b = m[i + 1] / d[i], sq = a * a + b * b;
            if (sq > 9) { const t = 3 / Math.sqrt(sq); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
        }
        const f = v => Math.round(v * 10) / 10;
        let path = `M${f(pts[0][0])},${f(pts[0][1])}`;
        for (let i = 0; i < n - 1; i++) {
            const h = (pts[i + 1][0] - pts[i][0]) / 3;
            path += ` C${f(pts[i][0] + h)},${f(pts[i][1] + m[i] * h)} ${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - m[i + 1] * h)} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
        }
        return path;
    }

    /**
     * The cashflow: the balance as one smooth line - blue above zero, red
     * below - with "Today" marked above its point and the last month's
     * balance at the end. Hovering a month reads its in and out above the chart.
     */
    function drawPlot() {
        const plot = els.finChart && els.finChart.querySelector('[data-fin-plot]');
        if (!plot || !state.plan) return;
        const W = Math.round(plot.clientWidth);
        if (!W) return;

        const p = state.plan;
        const cols = chartColumns();
        const n = cols.length;
        const narrow = W < 560;
        const padL = 48, padR = 12;
        const top = 16, H1 = narrow ? 190 : 250, axisH = 30;
        const H = top + H1 + axisH;
        const cw = (W - padL - padR) / n;
        const cx = i => padL + cw * (i + 0.5);
        const todayX = padL + cw * p.past.length;

        const values = cols.filter(c => c.closing !== null).map(c => c.closing);
        if (p.hasBalance) values.push(p.balance.amount);
        if (p.settings.buffer > 0) values.push(p.settings.buffer);
        values.push(0);
        let lo = Math.min(...values), hi = Math.max(...values);
        if (hi === lo) hi = lo + 1000;
        const step = niceStep(hi - lo);
        lo = Math.floor(lo / step) * step;
        hi = Math.ceil(hi / step) * step;
        const y1 = v => top + (hi - v) / (hi - lo) * H1;
        const y0 = y1(0);
        const right = W - padR;

        const parts = [];
        parts.push(`<defs>
            <linearGradient id="finArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="fin-area-top"/><stop offset="1" class="fin-area-bottom"/></linearGradient>
            <clipPath id="finAbove"><rect x="0" y="0" width="${W}" height="${y0}"/></clipPath>
            <clipPath id="finBelow"><rect x="0" y="${y0}" width="${W}" height="${H - y0}"/></clipPath>
        </defs>`);
        if (lo < 0) parts.push(`<rect class="fin-below-zero" x="${padL}" y="${y0}" width="${right - padL}" height="${y1(lo) - y0}"/>`);
        for (let v = lo; v <= hi + 0.001; v += step) {
            const y = y1(v);
            const zero = Math.abs(v) < 0.001;
            parts.push(`<line class="fin-grid${zero ? ' is-zero' : ' is-dashed'}" x1="${padL}" x2="${right}" y1="${y}" y2="${y}"/>`);
            parts.push(`<text class="fin-axis-y${zero ? ' is-zero' : v < 0 ? ' is-neg' : ''}" x="${padL - 10}" y="${y + 4}" text-anchor="end">${esc(zero ? '0' : short(v))}</text>`);
        }
        if (p.settings.buffer > 0) {
            const y = y1(p.settings.buffer);
            parts.push(`<line class="fin-buffer" x1="${padL}" x2="${right}" y1="${y}" y2="${y}"/>`);
            parts.push(`<text class="fin-buffer-label" x="${right - 4}" y="${y - 5}" text-anchor="end">Buffer ${esc(short(p.settings.buffer))}</text>`);
        }
        parts.push(`<rect class="fin-hover-band" data-fin-band x="0" y="${top - 6}" width="${cw}" height="${H1 + 12}" rx="8" visibility="hidden"/>`);

        if (p.hasBalance) {
            const pastPts = cols.map((c, i) => (c.past && c.closing !== null ? [cx(i), y1(c.closing)] : null)).filter(Boolean);
            const todayPt = [todayX, y1(p.balance.amount)];
            const futurePts = [todayPt].concat(cols.map((c, i) => (!c.past ? [cx(i), y1(c.closing)] : null)).filter(Boolean));
            const line = smoothPath(futurePts);
            const last = futurePts[futurePts.length - 1];

            if (pastPts.length) parts.push(`<path class="fin-line is-past" d="${smoothPath(pastPts.concat([todayPt]))}"/>`);
            const area = `${line} L${last[0]},${y0} L${todayPt[0]},${y0} Z`;
            parts.push(`<path class="fin-area" d="${area}" fill="url(#finArea)" clip-path="url(#finAbove)"/>`);
            parts.push(`<path class="fin-area is-neg" d="${area}" clip-path="url(#finBelow)"/>`);
            parts.push(`<path class="fin-line" d="${line}" clip-path="url(#finAbove)"/>`);
            parts.push(`<path class="fin-line is-neg" d="${line}" clip-path="url(#finBelow)"/>`);

            // Today: a dotted line down from its point.
            parts.push(`<line class="fin-today" x1="${todayX}" x2="${todayX}" y1="${todayPt[1]}" y2="${top + H1}"/>`);
            parts.push(`<circle class="fin-dot-mark" cx="${todayPt[0]}" cy="${todayPt[1]}" r="6"/>`);

            // Where the last month ends.
            const endValue = cols[cols.length - 1].closing;
            parts.push(`<circle class="fin-dot-mark${endValue < 0 ? ' is-neg' : ''}" cx="${last[0]}" cy="${last[1]}" r="6"/>`);
        }
        parts.push(`<circle class="fin-dot is-hover" data-fin-dot cx="0" cy="0" r="5" visibility="hidden"/>`);

        cols.forEach((c, i) => {
            const cal = RF.calendarMonth(c.offset, RF.monthOf(new Date()));
            const name = RF.MONTHS_SHORT[cal.month];
            const label = cw < 24 ? name.charAt(0) : name;
            const y = top + H1 + 20;
            parts.push(`<text class="fin-axis-x${c.offset === 0 ? ' is-now' : ''}${c.past ? ' is-past' : ''}" x="${cx(i)}" y="${y}" text-anchor="middle">${esc(label)}</text>`);
            if ((cal.month === 0 || i === 0) && cw >= 24) {
                parts.push(`<text class="fin-axis-year" x="${cx(i)}" y="${y + 12}" text-anchor="middle">${cal.year}</text>`);
            }
        });
        cols.forEach((c, i) => {
            parts.push(`<rect class="fin-hit" data-fin-col="${i}" x="${padL + cw * i}" y="0" width="${cw}" height="${H}"><title>${esc(c.label)}</title></rect>`);
        });

        plot.innerHTML = `<svg class="fin-svg" width="${W}" height="${H + 6}" viewBox="0 0 ${W} ${H + 6}" role="img"
            aria-label="${esc(`Cashflow: balance today ${p.hasBalance ? euro(p.balance.amount) : 'not entered'}, lowest ${p.kpis.lowest ? euro(p.kpis.lowest.amount) + ' in ' + p.kpis.lowest.label : ''}`)}">${parts.join('')}</svg>`;
        plot._geom = { cx, y1, cw, cols, padL, top };
    }

    function hoverColumn(i) {
        const plot = els.finChart.querySelector('[data-fin-plot]');
        if (!plot || !plot._geom) return;
        if (i === state.hover) return;
        state.hover = i;
        const g = plot._geom;
        const band = plot.querySelector('[data-fin-band]');
        const dot = plot.querySelector('[data-fin-dot]');
        const tip = els.finChart.querySelector('[data-fin-readout]');
        if (i === null) {
            band.setAttribute('visibility', 'hidden');
            dot.setAttribute('visibility', 'hidden');
            tip.hidden = true;
            return;
        }
        band.setAttribute('x', g.padL + g.cw * i);
        band.setAttribute('visibility', 'visible');
        const c = g.cols[i];
        if (c && c.closing !== null) {
            dot.setAttribute('cx', g.cx(i));
            dot.setAttribute('cy', g.y1(c.closing));
            dot.setAttribute('visibility', 'visible');
        } else {
            dot.setAttribute('visibility', 'hidden');
        }
        tip.innerHTML = readout(c);
        tip.hidden = false;
        // Above the point - below it when there is no room - and inside the
        // chart at both ends.
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        const x = Math.max(0, Math.min(plot.clientWidth - w, g.cx(i) - w / 2));
        const y = c.closing === null ? g.top : g.y1(c.closing);
        tip.style.left = Math.round(x) + 'px';
        tip.style.top = Math.round(y - h - 14 >= 0 ? y - h - 14 : y + 14) + 'px';
    }

    // ---- Month by month ----

    function renderMonths() {
        const p = state.plan;
        const buffer = p.settings.buffer;
        const balClass = v => (v < 0 ? 'is-neg' : buffer > 0 && v < buffer ? 'is-low' : '');

        const body = p.rows.map(r => {
            const open = state.openMonths.has(r.offset);
            return `
                <tr class="fin-month${open ? ' is-open' : ''}${r.offset === 0 ? ' is-now' : ''}">
                    <th scope="row">
                        <button type="button" class="fin-month-toggle" data-fin-month="${r.offset}" data-fin-focus="month-${r.offset}" aria-expanded="${open}">
                            ${ICON.chevron}<span>${esc(r.label)}</span>${r.offset === 0 ? '<span class="fin-tag">now</span>' : ''}
                        </button>
                    </th>
                    <td class="is-pos">${r.in > 0.005 ? esc(signed(r.in)) : '<span class="fin-muted">–</span>'}</td>
                    <td>${r.fixed + r.planned > 0.005 ? esc(signed(-(r.fixed + r.planned))) : '<span class="fin-muted">–</span>'}</td>
                    <td class="${r.net < 0 ? 'is-neg' : 'is-pos'}"><strong>${esc(signed(r.net))}</strong></td>
                    <td class="fin-col-balance ${p.hasBalance ? balClass(r.closing) : ''}">${p.hasBalance ? esc((r.closing < 0 ? MINUS : '') + euro(Math.abs(r.closing))) : '<span class="fin-muted">–</span>'}</td>
                </tr>
                ${open ? `<tr class="fin-month-detail"><td colspan="5">${monthDetail(r)}</td></tr>` : ''}`;
        }).join('');

        els.finMonths.innerHTML = `
            <div class="fin-card-head">
                <h2 class="fin-card-title">Month by month</h2>
            </div>
            <div class="fin-table-scroll">
                <table class="fin-table">
                    <thead><tr>
                        <th scope="col">Month</th><th scope="col">In</th><th scope="col">Costs</th>
                        <th scope="col">Net</th><th scope="col">Balance</th>
                    </tr></thead>
                    <tbody>${body}</tbody>
                </table>
            </div>`;
    }

    function monthDetail(r) {
        const line = (name, meta, amount, cls) => `
            <li class="${cls || ''}"><span class="fin-detail-name">${name}${meta ? `<span class="fin-detail-meta">${meta}</span>` : ''}</span><span class="fin-detail-amount">${amount}</span></li>`;
        const income = r.items.income.map(x => line(
            `<a href="#" data-crm-action="open-project-overview" data-project-id="${esc(x.projectId)}">${esc(x.name)}</a>`,
            esc(incomeKind(x) + (x.overdue ? ' · overdue' : '') + (x.factor < 1 ? ` · ${Math.round(x.factor * 100)}% of ${euro(x.net)}` : '')),
            esc(signed(x.expected)), 'is-in'));
        const costs = r.items.costs.map(c => line(esc(c.cost.name),
            esc([c.cost.category, c.cost.kind === 'once' ? 'planned' : rhythm(c.cost), c.paid ? 'already paid this month' : ''].filter(Boolean).join(' · ')),
            esc(signed(-c.amount)), c.paid ? 'is-paid' : 'is-out'));
        const all = income.concat(costs);
        return all.length ? `<ul class="fin-detail">${all.join('')}</ul>` : '<p class="fin-muted fin-detail-empty">Nothing planned this month.</p>';
    }

    function incomeKind(x) {
        if (x.kind === 'payment') return 'Expected payment';
        return x.partial ? 'Rest of budget' : 'Final invoice';
    }

    // ---- Costs ----

    function rhythm(c) {
        const iv = INTERVALS.find(x => x.value === Number(c.interval_months)) || INTERVALS[0];
        return iv.short + (Number(c.day) > 1 ? ` on the ${ordinal(Number(c.day))}` : '');
    }

    function monthLabelOf(key) {
        return key ? PP.monthName(key) : '';
    }

    function renderCosts() {
        const p = state.plan;
        const now = RF.monthOf(new Date());
        const current = monthKey(0, now);
        const fixed = state.overview.costs.filter(c => c.kind !== 'once');
        const once = state.overview.costs.filter(c => c.kind === 'once');
        const upcoming = once.filter(c => c.start_month >= current).sort((a, b) => (a.start_month < b.start_month ? -1 : 1));
        const past = once.filter(c => c.start_month < current);
        const ended = c => c.end_month && c.end_month < current;

        const fixedRow = c => `
            <li>
                <button type="button" class="fin-cost${ended(c) ? ' is-ended' : ''}" data-fin-edit="${c.id}" data-fin-focus="cost-${c.id}">
                    <span class="fin-cost-main">
                        <span class="fin-cost-name">${esc(c.name)}${c.category ? `<span class="fin-chip">${esc(c.category)}</span>` : ''}</span>
                        <span class="fin-cost-meta">${esc(rhythm(c))} · ${esc(monthLabelOf(c.start_month))}${c.end_month ? ' – ' + esc(monthLabelOf(c.end_month)) : ' onwards'}${ended(c) ? ' · ended' : ''}</span>
                    </span>
                    <span class="fin-cost-amount"><strong>${esc(euro(c.amount))}</strong>${Number(c.interval_months) > 1 ? `<span>≈ ${esc(euro(c.amount / c.interval_months))} / month</span>` : ''}</span>
                </button>
            </li>`;
        const onceRow = c => `
            <li>
                <button type="button" class="fin-cost" data-fin-edit="${c.id}" data-fin-focus="cost-${c.id}">
                    <span class="fin-cost-main">
                        <span class="fin-cost-name">${esc(c.name)}${c.category ? `<span class="fin-chip">${esc(c.category)}</span>` : ''}</span>
                        <span class="fin-cost-meta">${esc(monthLabelOf(c.start_month))}</span>
                    </span>
                    <span class="fin-cost-amount"><strong>${esc(euro(c.amount))}</strong></span>
                </button>
            </li>`;

        const editing = state.draft;
        els.finCosts.innerHTML = `
            ${editing ? costForm(editing) : ''}
            <section class="fin-group">
                <h3 class="fin-group-title"><span>Fixed costs <span class="fin-muted">· ${esc(euro(p.kpis.fixedPerMonth))}/month</span></span>
                    <button type="button" class="ov-add-btn" data-fin-add="recurring" data-fin-focus="add-recurring">${ICON.plus}Add</button></h3>
                ${fixed.length ? `<ul class="fin-cost-list">${fixed.map(fixedRow).join('')}</ul>`
                    : ''}
            </section>
            <section class="fin-group">
                <h3 class="fin-group-title"><span>Planned costs</span>
                    <button type="button" class="ov-add-btn" data-fin-add="once" data-fin-focus="add-once">${ICON.plus}Add</button></h3>
                ${upcoming.length ? `<ul class="fin-cost-list">${upcoming.map(onceRow).join('')}</ul>`
                    : ''}
                ${past.length ? `<button type="button" class="fin-link" data-fin-past>${state.showPastPlanned ? 'Hide' : 'Show'} ${esc(plural(past.length, 'past planned cost'))}</button>
                    ${state.showPastPlanned ? `<ul class="fin-cost-list is-past">${past.map(onceRow).join('')}</ul>` : ''}` : ''}
            </section>`;
    }

    function monthOptions(selected, from, to, now) {
        const out = [];
        for (let o = from; o <= to; o++) {
            const key = monthKey(o, now);
            out.push(`<option value="${key}"${key === selected ? ' selected' : ''}>${esc(RF.monthName(o, now))}</option>`);
        }
        return out.join('');
    }

    function costForm(d) {
        const now = RF.monthOf(new Date());
        const once = d.kind === 'once';
        const startOffset = RF.offsetOf(d.start_month, now);
        const from = Math.min(-24, startOffset === null ? 0 : startOffset);
        return `
            <form class="fin-cost-form" data-fin-cost-form aria-label="${d.id ? 'Edit cost' : once ? 'New planned cost' : 'New fixed cost'}">
                <p class="fin-form-title">${d.id ? 'Edit' : 'New'} ${once ? 'planned cost' : 'fixed cost'}</p>
                <div class="fin-field-grid">
                    <label class="fin-field is-wide"><span>Name</span>
                        <input type="text" class="form-input" name="name" value="${esc(d.name)}" maxlength="255" required placeholder="${once ? 'e.g. New laptops' : 'e.g. Office rent'}" data-fin-focus="draft-name"></label>
                    <label class="fin-field"><span>Category</span>
                        <input type="text" class="form-input" name="category" value="${esc(d.category || '')}" maxlength="64" list="finCategories" placeholder="Optional"></label>
                    <label class="fin-field"><span>Amount (excl. VAT)</span>
                        <span class="fin-amount"><input type="text" class="form-input" name="amount" value="${esc(d.amount)}" required data-amount inputmode="decimal" autocomplete="off" placeholder="0"><span aria-hidden="true">€</span></span></label>
                    ${once ? `
                    <label class="fin-field"><span>Month</span>
                        <select class="form-select" name="start_month">${monthOptions(d.start_month, from, 36, now)}</select></label>` : `
                    <label class="fin-field"><span>Repeats</span>
                        <select class="form-select" name="interval_months">${INTERVALS.map(iv => `<option value="${iv.value}"${Number(d.interval_months) === iv.value ? ' selected' : ''}>${iv.label}</option>`).join('')}</select></label>
                    <label class="fin-field"><span>On day</span>
                        <input type="number" class="form-input" name="day" value="${esc(d.day)}" min="1" max="31" step="1"></label>
                    <label class="fin-field"><span>First month</span>
                        <select class="form-select" name="start_month">${monthOptions(d.start_month, from, 36, now)}</select></label>
                    <label class="fin-field"><span>Last month</span>
                        <select class="form-select" name="end_month"><option value="">No end</option>${monthOptions(d.end_month, from, 60, now)}</select></label>`}
                </div>
                <datalist id="finCategories">${CATEGORIES.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
                ${state.draftError ? `<p class="fin-form-error">${esc(state.draftError)}</p>` : ''}
                <div class="fin-form-actions">
                    ${d.id ? `<button type="button" class="btn btn-secondary btn-small fin-delete" data-fin-delete="${d.id}">${ICON.trash}Delete</button>` : ''}
                    <span class="fin-spacer"></span>
                    <button type="button" class="btn btn-secondary btn-small" data-fin-cancel>Cancel</button>
                    <button type="submit" class="btn btn-primary btn-small">${d.id ? 'Save' : 'Add cost'}</button>
                </div>
            </form>`;
    }

    // ------------------------------------------------------------------
    // Editing
    // ------------------------------------------------------------------

    function newDraft(kind) {
        const now = RF.monthOf(new Date());
        return {
            id: null, kind, name: '', category: '', amount: '',
            interval_months: 1, day: 1,
            start_month: monthKey(kind === 'once' ? 1 : 0, now), end_month: ''
        };
    }

    function readCostForm(form) {
        const f = new FormData(form);
        const d = Object.assign({}, state.draft);
        ['name', 'category', 'amount', 'interval_months', 'day', 'start_month', 'end_month'].forEach(k => {
            if (f.has(k)) d[k] = f.get(k);
        });
        return d;
    }

    async function saveCost(form) {
        const d = readCostForm(form);
        state.draft = d;
        const amount = readAmount(d.amount);
        if (amount === null || Number.isNaN(amount) || amount <= 0) {
            state.draftError = 'Enter an amount above 0, e.g. 1.234,56';
            renderCosts();
            const field = els.finCosts.querySelector('[data-fin-cost-form] [name="amount"]');
            if (field) field.focus();
            return;
        }
        try {
            const result = await post('save-cost', {
                id: d.id, name: d.name, category: d.category, amount,
                kind: d.kind, interval_months: Number(d.interval_months) || 1, day: Number(d.day) || 1,
                start_month: d.start_month, end_month: d.end_month || null
            });
            state.overview = result.data;
            state.draft = null;
            state.draftError = '';
            compute();
            render();
            const saved = els.finCosts.querySelector(`[data-fin-edit="${result.id}"]`);
            if (saved) saved.focus();
        } catch (error) {
            state.draftError = error.message;
            renderCosts();
            const name = els.finCosts.querySelector('[data-fin-focus="draft-name"]');
            if (name && !d.name) name.focus();
        }
    }

    async function deleteCost(id) {
        if (!confirm('Delete this cost?')) return;
        try {
            const result = await post('delete-cost', { id });
            state.overview = result.data;
            state.draft = null;
            compute();
            render();
        } catch (error) {
            state.draftError = error.message;
            renderCosts();
        }
    }

    async function saveBalance(form) {
        const f = new FormData(form);
        const amount = readAmount(f.get('amount'));
        if (amount === null || Number.isNaN(amount)) {
            state.balanceError = 'Enter the balance, e.g. 48.500,00';
            renderKpis();
            const field = els.financialsView.querySelector('[data-fin-focus="balance-amount"]');
            if (field) field.focus();
            return;
        }
        try {
            const result = await post('set-balance', { amount, as_of: f.get('as_of') });
            state.overview = result.data;
            state.balanceOpen = false;
            state.balanceError = '';
            compute();
            render();
        } catch (error) {
            state.balanceError = error.message;
            renderKpis();
        }
    }

    async function deleteBalance(id) {
        if (!confirm('Delete this balance entry?')) return;
        try {
            const result = await post('delete-balance', { id });
            state.overview = result.data;
            compute();
            render();
        } catch (error) {
            state.balanceError = error.message;
            renderKpis();
        }
    }

    async function saveBuffer(form) {
        const value = readAmount(new FormData(form).get('buffer'));
        if (Number.isNaN(value) || (value !== null && value < 0)) {
            state.bufferError = 'Enter an amount of 0 or more, e.g. 15.000';
            renderKpis();
            return;
        }
        try {
            const result = await post('save-settings', { buffer: value || 0 });
            state.overview = result.data;
            state.bufferOpen = false;
            state.bufferError = '';
            compute();
            render();
            const btn = els.finKpis.querySelector('[data-fin-buffer]');
            if (btn) btn.focus();
        } catch (error) {
            state.bufferError = error.message;
            renderKpis();
        }
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    function bind() {
        const view = els.financialsView;

        view.addEventListener('click', e => {
            if (e.target.closest('[data-fin-costs-close]')) {
                closeCosts();
                return;
            }
            const t = e.target.closest('button');
            if (!t || !view.contains(t) || els.finForecast.contains(t)) return;

            if (t.hasAttribute('data-fin-retry')) {
                load();
            } else if (t.hasAttribute('data-fin-costs')) {
                openCosts();
            } else if (t.hasAttribute('data-fin-months')) {
                state.months = Number(t.getAttribute('data-fin-months'));
                try { localStorage.setItem(HORIZON_KEY, String(state.months)); } catch (err) { /* fine */ }
                Card.setMonths(state.months);
                compute();
                render();
            } else if (t.hasAttribute('data-fin-balance')) {
                state.balanceOpen = !state.balanceOpen;
                state.balanceError = '';
                renderKpis();
                const field = els.financialsView.querySelector('[data-fin-focus="balance-amount"]');
                if (field) { field.focus(); field.select(); }
            } else if (t.hasAttribute('data-fin-balance-cancel')) {
                state.balanceOpen = false;
                renderKpis();
                const btn = els.financialsView.querySelector('[data-fin-balance]');
                if (btn) btn.focus();
            } else if (t.hasAttribute('data-fin-buffer')) {
                state.bufferOpen = !state.bufferOpen;
                state.bufferError = '';
                renderKpis();
                const field = els.finKpis.querySelector('[data-fin-focus="buffer-amount"]');
                if (field) { field.focus(); field.select(); }
            } else if (t.hasAttribute('data-fin-buffer-cancel')) {
                state.bufferOpen = false;
                renderKpis();
                const btn = els.finKpis.querySelector('[data-fin-buffer]');
                if (btn) btn.focus();
            } else if (t.hasAttribute('data-fin-balance-delete')) {
                deleteBalance(Number(t.getAttribute('data-fin-balance-delete')));
            } else if (t.hasAttribute('data-fin-month')) {
                const o = Number(t.getAttribute('data-fin-month'));
                if (state.openMonths.has(o)) state.openMonths.delete(o); else state.openMonths.add(o);
                renderMonths();
                const again = els.finMonths.querySelector(`[data-fin-month="${o}"]`);
                if (again) again.focus();
            } else if (t.hasAttribute('data-fin-add')) {
                state.draft = newDraft(t.getAttribute('data-fin-add'));
                state.draftError = '';
                renderCosts();
                const name = els.finCosts.querySelector('[data-fin-focus="draft-name"]');
                if (name) name.focus();
            } else if (t.hasAttribute('data-fin-edit')) {
                const cost = state.overview.costs.find(c => c.id === Number(t.getAttribute('data-fin-edit')));
                if (!cost) return;
                state.draft = Object.assign({}, cost, { end_month: cost.end_month || '', amount: showAmount(cost.amount) });
                state.draftError = '';
                renderCosts();
                els.finCosts.scrollTop = 0;
                const name = els.finCosts.querySelector('[data-fin-focus="draft-name"]');
                if (name) name.focus();
            } else if (t.hasAttribute('data-fin-cancel')) {
                const id = state.draft && state.draft.id;
                state.draft = null;
                state.draftError = '';
                renderCosts();
                const back = id ? els.finCosts.querySelector(`[data-fin-edit="${id}"]`) : null;
                if (back) back.focus();
            } else if (t.hasAttribute('data-fin-delete')) {
                deleteCost(Number(t.getAttribute('data-fin-delete')));
            } else if (t.hasAttribute('data-fin-past')) {
                state.showPastPlanned = !state.showPastPlanned;
                renderCosts();
            }
        });

        view.addEventListener('submit', e => {
            if (e.target.matches('[data-fin-cost-form]')) {
                e.preventDefault();
                saveCost(e.target);
            } else if (e.target.matches('[data-fin-balance-form]')) {
                e.preventDefault();
                saveBalance(e.target);
            } else if (e.target.matches('[data-fin-buffer-form]')) {
                e.preventDefault();
                saveBuffer(e.target);
            }
        });

        // Keep what is typed in the cost form when the page redraws.
        view.addEventListener('input', e => {
            const form = e.target.closest('[data-fin-cost-form]');
            if (form && state.draft) state.draft = readCostForm(form);
        });

        view.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            if (state.draft && e.target.closest('[data-fin-cost-form]')) {
                state.draft = null;
                renderCosts();
            } else if (els.finCostsModal.classList.contains('active')) {
                closeCosts();
            } else if (state.bufferOpen && e.target.closest('[data-fin-buffer-form]')) {
                state.bufferOpen = false;
                renderKpis();
                const btn = els.finKpis.querySelector('[data-fin-buffer]');
                if (btn) btn.focus();
            } else if (state.balanceOpen && e.target.closest('[data-fin-balance-form]')) {
                state.balanceOpen = false;
                renderKpis();
                const btn = els.financialsView.querySelector('[data-fin-balance]');
                if (btn) btn.focus();
            }
        });

        // The chart: hover or touch a month to read it.
        els.finChart.addEventListener('mousemove', e => {
            const hit = e.target.closest('[data-fin-col]');
            hoverColumn(hit ? Number(hit.getAttribute('data-fin-col')) : null);
        });
        els.finChart.addEventListener('mouseleave', () => hoverColumn(null));
        els.finChart.addEventListener('touchstart', e => {
            const hit = e.target.closest('[data-fin-col]');
            if (hit) hoverColumn(Number(hit.getAttribute('data-fin-col')));
        }, { passive: true });
    }

    /** The costs sheet, opened from the "Fixed costs" figure. */
    function openCosts() {
        renderCosts();
        els.finCostsModal.classList.add('active');
        const close = els.finCostsModal.querySelector('.modal-close');
        if (close) close.focus();
    }

    function closeCosts() {
        els.finCostsModal.classList.remove('active');
        state.draft = null;
        state.draftError = '';
        const card = els.finKpis.querySelector('[data-fin-costs]');
        if (card) card.focus();
    }

    window.Financials = { load };
})();
