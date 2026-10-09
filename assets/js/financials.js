/**
 * Financials (admins only): cash, costs and what is coming in.
 *
 * Draws the tab from four sources: the projects (budgets, expected
 * payments), our costs, balance and settings (api/financials.php), and the
 * bank movements in Bookkeeping. The numbers all come from cashflow.js; this
 * file only turns them into HTML and saves what is edited here.
 *
 * The scenario is the revenue forecast's (revenue-forecast-card.js), whose
 * card opens the page: Worst / Realistic / Best and its adjustments there
 * are what the whole page plans with.
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
    /** "€57.5k", with a minus when below zero - for the chart's axis. */
    const short = n => (n < 0 ? MINUS : '') + RF.money(Math.abs(n));
    const plural = (n, word, many) => n + ' ' + (n === 1 ? word : (many || word + 's'));

    /** An amount field's value: a number, null when empty, NaN when it cannot be read. */
    const readAmount = value => (window.CRMAmount ? window.CRMAmount.parse(value) : (value === '' ? null : Number(value)));
    const showAmount = n => (window.CRMAmount ? window.CRMAmount.format(n) : String(n ?? ''));

    function todayIso() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    /** "2026-10-01" -> "1 Oct 2026". */
    function dayName(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        return m ? Number(m[3]) + ' ' + RF.MONTHS_SHORT[Number(m[2]) - 1] + ' ' + m[1] : '';
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
        plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
        warn: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
        bank: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10h18L12 4 3 10z"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3.5 20.5h17"/></svg>',
        in: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12M6.5 10.5 12 16l5.5-5.5"/><path d="M4.5 20h15"/></svg>',
        out: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M6.5 9.5 12 4l5.5 5.5"/><path d="M4.5 20h15"/></svg>',
        low: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 7 6 6 4-4 7 7"/><path d="M20.5 11v5h-5"/></svg>',
        trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
    };

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    function init() {
        if (state.inited) return;
        state.inited = true;
        ['financialsView', 'finHeadTools', 'finPage', 'finKpis', 'finAlerts', 'finChart', 'finMonths',
            'finIncome', 'finCosts', 'finForecast'].forEach(id => { els[id] = document.getElementById(id); });

        try {
            const stored = Number(localStorage.getItem(HORIZON_KEY));
            if (CF.HORIZONS.indexOf(stored) >= 0) state.months = stored;
        } catch (e) { /* no storage: a year */ }

        Card.init(els.finForecast, { name: 'financials' });
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
        els.finKpis.innerHTML = [0, 1, 2, 3].map(() => '<div class="fin-kpi is-skeleton"><span class="fin-skel"></span><span class="fin-skel is-big"></span><span class="fin-skel"></span></div>').join('');
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
        renderHead();
        renderKpis();
        renderAlerts();
        renderChart();
        renderMonths();
        renderIncome();
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

    /** The scenario in words, as the forecast card above names it. */
    function scenarioName() {
        const active = RF.activePreset(Card.getSettings());
        return active ? RF.presetByKey(active).label + ' scenario' : 'Custom scenario';
    }

    function renderHead() {
        els.finHeadTools.innerHTML = `
            <div class="fin-tool">
                <span class="fin-tool-label">Months ahead</span>
                ${segmented('months', 'Months ahead', CF.HORIZONS.map(n => ({ key: n, label: String(n) })), state.months)}
            </div>`;
    }

    // ---- The four figures on top ----

    function renderKpis() {
        const p = state.plan;
        const k = p.kpis;
        const b = p.balance;

        let balanceSub;
        if (!b) {
            balanceSub = 'Enter today’s balance to plan from it';
        } else if (b.rows > 0) {
            balanceSub = `${euro(b.anchor.amount)} on ${dayName(b.anchor.asOf)} · ${signed(b.movement)} from ${plural(b.rows, 'bookkeeping row')} since`;
        } else {
            balanceSub = `Entered for ${dayName(b.anchor.asOf)}`;
        }
        if (state.tx.error) balanceSub += ' · Bookkeeping could not be read';

        const lowTone = !k.lowest ? '' : k.lowest.amount < 0 ? 'is-danger' : (k.belowBuffer ? 'is-warn' : 'is-ok');
        let lowSub = '';
        if (k.belowZero) lowSub = `Below zero from ${k.belowZero.label}`;
        else if (k.belowBuffer) lowSub = `Below your buffer of ${euro(p.settings.buffer)} from ${k.belowBuffer.label}`;
        else if (k.lowest && p.hasBalance) lowSub = `Stays above ${p.settings.buffer > 0 ? 'your buffer' : 'zero'} · ${p.rows[p.rows.length - 1].label} ends at ${euro(k.end)}`;
        else if (k.lowest) lowSub = 'Counted from zero until a balance is entered';

        const costsAhead = p.costs.filter(c => c.kind === 'once' && c.occurrences.length).length;

        els.finKpis.innerHTML = `
            <article class="fin-kpi fin-kpi--balance${b ? '' : ' is-empty'}">
                <span class="fin-kpi-icon" aria-hidden="true">${ICON.bank}</span>
                <span class="fin-kpi-label">Bank balance today</span>
                <span class="fin-kpi-value">${b ? esc(euro(b.amount)) : '—'}</span>
                <span class="fin-kpi-sub">${esc(balanceSub)}</span>
                <button type="button" class="fin-link fin-kpi-action" data-fin-balance data-fin-focus="balance" aria-expanded="${state.balanceOpen}">${b ? 'Update' : 'Enter balance'}</button>
                ${state.balanceOpen ? balanceForm() : ''}
            </article>
            <article class="fin-kpi fin-kpi--in">
                <span class="fin-kpi-icon" aria-hidden="true">${ICON.in}</span>
                <span class="fin-kpi-label">Coming in · next 3 months</span>
                <span class="fin-kpi-value">${esc(euro(k.incomeNext3))}</span>
                <span class="fin-kpi-sub">${esc(euro(k.incomeTotal))} in ${p.months} months · net${k.overdue.count ? ` · ${euro(k.overdue.amount)} overdue` : ''}</span>
            </article>
            <article class="fin-kpi fin-kpi--out">
                <span class="fin-kpi-icon" aria-hidden="true">${ICON.out}</span>
                <span class="fin-kpi-label">Fixed costs · per month</span>
                <span class="fin-kpi-value">${esc(euro(k.fixedPerMonth))}</span>
                <span class="fin-kpi-sub">${esc(plural(p.costs.filter(c => c.kind !== 'once').length, 'position'))}${costsAhead ? ` · ${esc(plural(costsAhead, 'planned cost'))} ahead` : ''} · ${esc(euro(k.outTotal))} out in ${p.months} months</span>
            </article>
            <article class="fin-kpi fin-kpi--low ${lowTone}">
                <span class="fin-kpi-icon" aria-hidden="true">${ICON.low}</span>
                <span class="fin-kpi-label">Lowest balance</span>
                <span class="fin-kpi-value">${k.lowest ? esc((k.lowest.amount < 0 ? MINUS : '') + euro(Math.abs(k.lowest.amount))) : '—'}</span>
                <span class="fin-kpi-sub">${k.lowest ? `<strong>${esc(k.lowest.label)}</strong> · ` : ''}${esc(lowSub)}</span>
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
        if (k.belowZero) {
            alerts.push({ tone: 'danger', html: `<strong>The account goes below zero in ${esc(k.belowZero.label)}</strong> (${esc(signed(k.belowZero.closing))}) in this scenario.` });
        } else if (k.belowBuffer) {
            alerts.push({ tone: 'warn', html: `<strong>Below your cash buffer from ${esc(k.belowBuffer.label)}</strong> - ${esc(euro(k.belowBuffer.closing))} against ${esc(euro(p.settings.buffer))}.` });
        }
        if (k.overdue.count) {
            const oldest = p.income.filter(x => x.counted && x.overdue).sort((a, b) => a.due - b.due)[0];
            alerts.push({ tone: 'warn', html: `<strong>${esc(plural(k.overdue.count, 'payment'))} overdue, ${esc(euro(k.overdue.amount))}</strong> - counted in this month. Oldest: ${esc(oldest.name)}, due ${esc(RF.monthName(oldest.due, RF.monthOf(new Date())))}.` });
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
        const p = state.plan;
        els.finChart.innerHTML = `
            <div class="fin-card-head">
                <div>
                    <h2 class="fin-card-title">Cashflow</h2>
                    <p class="fin-card-sub">${p.past.length ? `${esc(plural(p.past.length, 'month'))} from Bookkeeping, then` : 'The'} next ${p.months} months as planned · <strong>${esc(scenarioName())}</strong> from the forecast above</p>
                </div>
                <ul class="fin-legend" aria-label="Legend">
                    <li><span class="fin-key is-in"></span>In</li>
                    <li><span class="fin-key is-out"></span>Out</li>
                    <li><span class="fin-key is-line"></span>Balance</li>
                    ${p.settings.buffer > 0 ? '<li><span class="fin-key is-buffer"></span>Buffer</li>' : ''}
                </ul>
            </div>
            <div class="fin-readout" data-fin-readout aria-live="polite">${readout(null)}</div>
            <div class="fin-plot" data-fin-plot></div>`;
        drawPlot();
    }

    function readout(i) {
        const p = state.plan;
        const cols = chartColumns();
        if (i === null || i === undefined || !cols[i]) {
            const last = p.rows[p.rows.length - 1];
            return p.hasBalance
                ? `<span>Today</span> <strong>${esc(euro(p.balance.amount))}</strong> <span>→ end of ${esc(last.label)}</span> <strong class="${last.closing < 0 ? 'is-neg' : ''}">${esc((last.closing < 0 ? MINUS : '') + euro(Math.abs(last.closing)))}</strong>`
                : `<span>In ${esc(euro(p.kpis.incomeTotal))} · out ${esc(euro(p.kpis.outTotal))} over ${p.months} months</span>`;
        }
        const c = cols[i];
        const bal = c.closing === null ? '' : ` · <span>${c.past ? 'closed at' : 'balance'}</span> <strong class="${c.closing < 0 ? 'is-neg' : ''}">${esc((c.closing < 0 ? MINUS : '') + euro(Math.abs(c.closing)))}</strong>`;
        return `<strong>${esc(c.label)}</strong>${c.past ? ' <span class="fin-tag">actual</span>' : ''} · <span>in</span> <strong class="is-pos">${esc(signed(c.in))}</strong> · <span>out</span> <strong>${esc(signed(-c.out))}</strong>${bal}`;
    }

    /** A clean step for about four gridlines across `span`. */
    function niceStep(span) {
        if (span <= 0) return 1000;
        const raw = span / 4;
        const pow = Math.pow(10, Math.floor(Math.log10(raw)));
        const m = raw / pow;
        return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * pow;
    }

    function drawPlot() {
        const plot = els.finChart && els.finChart.querySelector('[data-fin-plot]');
        if (!plot || !state.plan) return;
        const W = Math.round(plot.clientWidth);
        if (!W) return;

        const p = state.plan;
        const cols = chartColumns();
        const n = cols.length;
        const narrow = W < 560;
        const padL = 52, padR = 6;
        const H1 = narrow ? 150 : 190, gap = 18, H2 = narrow ? 80 : 100, axisH = 22;
        const top1 = 8, top2 = top1 + H1 + gap, H = top2 + H2 + axisH;
        const cw = (W - padL - padR) / n;
        const cx = i => padL + cw * (i + 0.5);
        const todayX = padL + cw * p.past.length;

        // Balance panel scale
        const values = cols.filter(c => c.closing !== null).map(c => c.closing);
        if (p.hasBalance) values.push(p.balance.amount);
        if (p.settings.buffer > 0) values.push(p.settings.buffer);
        values.push(0);
        let lo = Math.min(...values), hi = Math.max(...values);
        if (hi === lo) hi = lo + 1000;
        const step = niceStep(hi - lo);
        lo = Math.floor(lo / step) * step;
        hi = Math.ceil(hi / step) * step;
        const y1 = v => top1 + (hi - v) / (hi - lo) * H1;

        // Flow panel scale: in up, out down from the middle
        const peak = Math.max(1, ...cols.map(c => Math.max(c.in, c.out)));
        const half = H2 / 2;
        const mid = top2 + half;
        const fh = v => (v / peak) * (half - 2);
        const bw = Math.max(3, Math.min(20, cw * 0.5));

        const parts = [];
        // gridlines + labels
        for (let v = lo; v <= hi + 0.001; v += step) {
            const y = y1(v);
            parts.push(`<line class="fin-grid${Math.abs(v) < 0.001 ? ' is-zero' : ''}" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`);
            parts.push(`<text class="fin-axis-y" x="${padL - 8}" y="${y + 4}" text-anchor="end">${esc(short(v))}</text>`);
        }
        if (lo < 0) {
            parts.push(`<rect class="fin-below-zero" x="${padL}" y="${y1(0)}" width="${W - padL - padR}" height="${y1(lo) - y1(0)}"/>`);
        }
        if (p.settings.buffer > 0) {
            const y = y1(p.settings.buffer);
            parts.push(`<line class="fin-buffer" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`);
            parts.push(`<text class="fin-buffer-label" x="${W - padR - 4}" y="${y - 5}" text-anchor="end">Buffer ${esc(short(p.settings.buffer))}</text>`);
        }

        // hover band (moved on hover)
        parts.push(`<rect class="fin-hover-band" data-fin-band x="0" y="${top1}" width="${cw}" height="${H - top1 - axisH + 4}" rx="6" visibility="hidden"/>`);

        // balance: past (actual) dashed, plan solid with a soft area
        const pastPts = cols.map((c, i) => (c.past && c.closing !== null ? [cx(i), y1(c.closing)] : null)).filter(Boolean);
        if (p.hasBalance) {
            const futurePts = [[todayX, y1(p.balance.amount)]].concat(cols.map((c, i) => (!c.past ? [cx(i), y1(c.closing)] : null)).filter(Boolean));
            if (pastPts.length) {
                parts.push(`<polyline class="fin-line is-past" points="${pastPts.concat([[todayX, y1(p.balance.amount)]]).map(pt => pt.join(',')).join(' ')}"/>`);
            }
            const area = `M${futurePts[0][0]},${top1 + H1} ` + futurePts.map(pt => `L${pt[0]},${pt[1]}`).join(' ') + ` L${futurePts[futurePts.length - 1][0]},${top1 + H1} Z`;
            parts.push(`<defs><linearGradient id="finArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="fin-area-top"/><stop offset="1" class="fin-area-bottom"/></linearGradient></defs>`);
            parts.push(`<path class="fin-area" d="${area}" fill="url(#finArea)"/>`);
            parts.push(`<polyline class="fin-line" points="${futurePts.map(pt => pt.join(',')).join(' ')}"/>`);
            parts.push(`<circle class="fin-dot is-today" cx="${todayX}" cy="${y1(p.balance.amount)}" r="4.5"/>`);
            // the lowest point
            const low = p.kpis.lowest;
            if (low) {
                const i = p.past.length + low.offset;
                parts.push(`<circle class="fin-dot is-low${low.amount < 0 ? ' is-neg' : ''}" cx="${cx(i)}" cy="${y1(low.amount)}" r="4"/>`);
            }
        }
        parts.push(`<circle class="fin-dot is-hover" data-fin-dot cx="0" cy="0" r="5" visibility="hidden"/>`);

        // flows
        parts.push(`<line class="fin-grid is-mid" x1="${padL}" x2="${W - padR}" y1="${mid}" y2="${mid}"/>`);
        parts.push(`<text class="fin-axis-y" x="${padL - 8}" y="${top2 + 10}" text-anchor="end">in</text>`);
        parts.push(`<text class="fin-axis-y" x="${padL - 8}" y="${top2 + H2 - 2}" text-anchor="end">out</text>`);
        cols.forEach((c, i) => {
            const x = cx(i) - bw / 2;
            const hIn = fh(c.in), hOut = fh(c.out);
            if (hIn > 0.5) parts.push(`<rect class="fin-bar is-in${c.past ? ' is-past' : ''}" x="${x}" y="${mid - hIn - 1}" width="${bw}" height="${hIn}" rx="${Math.min(3, bw / 3)}"/>`);
            if (hOut > 0.5) parts.push(`<rect class="fin-bar is-out${c.past ? ' is-past' : ''}" x="${x}" y="${mid + 1}" width="${bw}" height="${hOut}" rx="${Math.min(3, bw / 3)}"/>`);
        });

        // today divider
        parts.push(`<line class="fin-today" x1="${todayX}" x2="${todayX}" y1="${top1 - 4}" y2="${top2 + H2}"/>`);
        if (p.past.length) parts.push(`<text class="fin-today-label" x="${todayX + 5}" y="${top1 + 8}">Today</text>`);

        // month axis
        cols.forEach((c, i) => {
            const cal = RF.calendarMonth(c.offset, RF.monthOf(new Date()));
            const name = RF.MONTHS_SHORT[cal.month];
            const label = cw < 24 ? name.charAt(0) : name;
            parts.push(`<text class="fin-axis-x${c.offset === 0 ? ' is-now' : ''}${c.past ? ' is-past' : ''}" x="${cx(i)}" y="${top2 + H2 + 15}" text-anchor="middle">${esc(label)}</text>`);
            if ((cal.month === 0 || i === 0) && cw >= 24) {
                parts.push(`<text class="fin-axis-year" x="${cx(i)}" y="${top2 + H2 + 27}" text-anchor="middle">${cal.year}</text>`);
            }
        });

        // hit areas
        cols.forEach((c, i) => {
            parts.push(`<rect class="fin-hit" data-fin-col="${i}" x="${padL + cw * i}" y="0" width="${cw}" height="${H}"><title>${esc(c.label)}</title></rect>`);
        });

        plot.innerHTML = `<svg class="fin-svg" width="${W}" height="${H + 8}" viewBox="0 0 ${W} ${H + 8}" role="img"
            aria-label="${esc(`Cashflow: balance today ${p.hasBalance ? euro(p.balance.amount) : 'not entered'}, lowest ${p.kpis.lowest ? euro(p.kpis.lowest.amount) + ' in ' + p.kpis.lowest.label : ''}`)}">${parts.join('')}</svg>`;

        plot._geom = { cx, y1, cw, cols, padL };
    }

    function hoverColumn(i) {
        const plot = els.finChart.querySelector('[data-fin-plot]');
        if (!plot || !plot._geom) return;
        if (i === state.hover) return;
        state.hover = i;
        const g = plot._geom;
        const band = plot.querySelector('[data-fin-band]');
        const dot = plot.querySelector('[data-fin-dot]');
        const line = els.finChart.querySelector('[data-fin-readout]');
        if (line) line.innerHTML = readout(i);
        if (i === null) {
            band.setAttribute('visibility', 'hidden');
            dot.setAttribute('visibility', 'hidden');
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
                <div>
                    <h2 class="fin-card-title">Month by month</h2>
                    <p class="fin-card-sub">Open a month to see what makes it up · all amounts net</p>
                </div>
            </div>
            <div class="fin-table-scroll">
                <table class="fin-table">
                    <thead><tr>
                        <th scope="col">Month</th><th scope="col">In</th><th scope="col">Costs</th>
                        <th scope="col">Net</th><th scope="col">Balance</th>
                    </tr></thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
            <details class="fin-how">
                <summary>How this is worked out</summary>
                <p>Income follows the scenario of the revenue forecast at the top. An expected payment counts in its month, the part of a budget the payments leave open at the project’s end; anything overdue counts in this month. Complete projects still bring their unpaid payments. A fixed cost whose day this month has passed is taken to be in the balance already. VAT is left out: project amounts are net, so enter costs net too - over a VAT period that is what stays in the account; only when the VAT is paid is not shown.${state.tx.amountColumn ? ` Bank movements come from the Bookkeeping column “${esc(state.tx.amountColumn)}”; rows left out of the month totals do not move the balance.` : ''}</p>
            </details>`;
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

    // ---- Expected income ----

    function incomeKind(x) {
        if (x.kind === 'payment') return 'Expected payment';
        return x.partial ? 'Rest of budget' : 'Final invoice';
    }

    function renderIncome() {
        const p = state.plan;
        const now = RF.monthOf(new Date());
        const inRange = p.income.filter(x => x.offset !== null && x.offset < p.months);
        const later = p.income.filter(x => x.offset !== null && x.offset >= p.months);
        const undated = p.income.filter(x => x.offset === null);

        const row = x => `
            <li class="fin-income${x.counted ? '' : ' is-off'}${x.overdue ? ' is-overdue' : ''}">
                <span class="fin-income-main">
                    <a href="#" class="fin-income-name" data-crm-action="open-project-overview" data-project-id="${esc(x.projectId)}">${esc(x.name)}</a>
                    <span class="fin-income-meta">
                        <span class="fin-stage" data-stage="${esc(String(x.stage).toLowerCase().replace(/ /g, '-'))}">${esc(x.stage)}</span>
                        <span>${esc(incomeKind(x))}</span>
                        ${x.overdue ? `<span class="fin-tag is-warn">overdue since ${esc(RF.monthName(x.due, now))}</span>` : ''}
                        ${x.counted ? '' : '<span class="fin-tag">not in this scenario</span>'}
                    </span>
                </span>
                <span class="fin-income-amount">
                    <strong>${esc(euro(x.expected))}</strong>
                    <span>${x.factor < 1 ? `${Math.round(x.factor * 100)}% of ${esc(euro(x.net))} net` : `${esc(euro(x.net))} net`}</span>
                </span>
            </li>`;

        const groups = [];
        const byMonth = new Map();
        inRange.forEach(x => { if (!byMonth.has(x.offset)) byMonth.set(x.offset, []); byMonth.get(x.offset).push(x); });
        byMonth.forEach((items, offset) => groups.push({ title: RF.monthName(offset, now), items }));
        if (later.length) groups.push({ title: `Later than ${p.months} months`, items: later });
        if (undated.length) groups.push({ title: 'No end date', items: undated, note: 'Projects without an end date: when this comes in is open.' });

        const total = p.kpis.incomeTotal;
        els.finIncome.innerHTML = `
            <div class="fin-card-head">
                <div>
                    <h2 class="fin-card-title">Expected income</h2>
                    <p class="fin-card-sub">${esc(euro(total))} in ${p.months} months · payments in their month, the rest of a budget at the project’s end</p>
                </div>
            </div>
            ${groups.length ? groups.map(g => {
                const counted = g.items.filter(x => x.counted);
                return `
                <section class="fin-group">
                    <h3 class="fin-group-title"><span>${esc(g.title)}</span><strong>${esc(euro(counted.reduce((s, x) => s + x.expected, 0)))}</strong></h3>
                    ${g.note ? `<p class="fin-hint">${esc(g.note)}</p>` : ''}
                    <ul class="fin-income-list">${g.items.map(row).join('')}</ul>
                </section>`;
            }).join('') : '<p class="fin-empty">No income expected from projects yet. Budgets, end dates and expected payments on projects show up here.</p>'}
            ${p.missing.length ? `<p class="fin-hint">${esc(plural(p.missing.length, 'open project'))} without a budget or chance ${p.missing.length === 1 ? 'is' : 'are'} not included.</p>` : ''}`;
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
            <div class="fin-card-head">
                <div>
                    <h2 class="fin-card-title">Costs</h2>
                    <p class="fin-card-sub">Net, without VAT · ≈ ${esc(euro(p.kpis.fixedPerMonth))} fixed per month</p>
                </div>
            </div>
            ${editing ? costForm(editing) : ''}
            <section class="fin-group">
                <h3 class="fin-group-title"><span>Fixed costs</span>
                    <button type="button" class="ov-add-btn" data-fin-add="recurring" data-fin-focus="add-recurring">${ICON.plus}Add</button></h3>
                ${fixed.length ? `<ul class="fin-cost-list">${fixed.map(fixedRow).join('')}</ul>`
                    : '<p class="fin-empty">Rent, salaries, software, insurance - whatever goes out every month, quarter or year.</p>'}
            </section>
            <section class="fin-group">
                <h3 class="fin-group-title"><span>Planned costs</span>
                    <button type="button" class="ov-add-btn" data-fin-add="once" data-fin-focus="add-once">${ICON.plus}Add</button></h3>
                ${upcoming.length ? `<ul class="fin-cost-list">${upcoming.map(onceRow).join('')}</ul>`
                    : '<p class="fin-empty">One-off costs in a future month: a laptop, a tax payment, an event.</p>'}
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
            const field = els.finKpis.querySelector('[data-fin-focus="balance-amount"]');
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
            const t = e.target.closest('button');
            if (!t || !view.contains(t) || els.finForecast.contains(t)) return;

            if (t.hasAttribute('data-fin-retry')) {
                load();
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
                const field = els.finKpis.querySelector('[data-fin-focus="balance-amount"]');
                if (field) { field.focus(); field.select(); }
            } else if (t.hasAttribute('data-fin-balance-cancel')) {
                state.balanceOpen = false;
                renderKpis();
                const btn = els.finKpis.querySelector('[data-fin-balance]');
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
                els.finCosts.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
            } else if (state.bufferOpen && e.target.closest('[data-fin-buffer-form]')) {
                state.bufferOpen = false;
                renderKpis();
                const btn = els.finKpis.querySelector('[data-fin-buffer]');
                if (btn) btn.focus();
            } else if (state.balanceOpen && e.target.closest('[data-fin-balance-form]')) {
                state.balanceOpen = false;
                renderKpis();
                const btn = els.finKpis.querySelector('[data-fin-balance]');
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

    window.Financials = { load };
})();
