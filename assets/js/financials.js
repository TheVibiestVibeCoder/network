/**
 * Financials (admins only): cash, costs and what is coming in.
 *
 * Draws the tab from four sources: the projects (budgets, expected
 * payments), our costs, balance, debts and settings (api/financials.php),
 * and the bank movements in Bookkeeping. The numbers all come from cashflow.js; this
 * file only turns them into HTML and saves what is edited here.
 *
 * The scenario is the revenue forecast's (revenue-forecast-card.js): its
 * switch - Worst / Realistic / Best, with the adjustments behind "Adjust" -
 * sits in this page's header, since the whole page plans with it.
 *
 * Our own invoices (the invoice card) come from Bookkeeping's files too,
 * through invoice-list.js; only the reminders sent are kept here.
 *
 * app.js calls window.Financials.load() when the tab opens.
 */
(function () {
    'use strict';

    const RF = window.RevenueForecast;
    const CF = window.Cashflow;
    const PP = window.ProjectPayments;
    const Card = window.RevenueForecastCard;
    const IL = window.InvoiceList;
    if (!RF || !CF || !PP || !Card || !IL) return;

    const API = 'api/financials.php';
    const HORIZON_KEY = 'crm.financials.months';
    // Folded or unfolded, per card: 'year', 'liquidity'.
    const FOLD_KEY = 'crm.financials.open.';
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
        // 6, 12, 24 - or 'year': this month until December.
        horizon: CF.DEFAULT_HORIZON,
        months: CF.DEFAULT_HORIZON,
        plan: null,
        // A cost being added or edited: a draft of its fields, id null for new.
        draft: null,
        draftError: '',
        balanceOpen: false,
        balanceError: '',
        bufferOpen: false,
        bufferError: '',
        // The VAT panel on the liquidity card: each quarter, linked to the
        // bank row that paid it.
        vatOpen: false,
        vatError: '',
        vatBusy: false,
        // The bank rows with the VAT quarter each pays marked on them
        // (cashflow.js markVatPayments): what every sum here reads.
        txRows: [],
        // The costs card, unfolded to edit the fixed and planned costs.
        costsOpen: false,
        // Recurring payments in Bookkeeping that no fixed cost covers yet.
        suggestions: [],
        // This year's result so far and where it ends (cashflow.js yearResult).
        year: null,
        // Unfolded to their details: the year card (revenue and costs behind
        // the two results), the liquidity card (low point, buffer), and the
        // months gone by in the table (one summary row when folded), and the
        // paid invoices (only the open ones when folded).
        folds: { year: false, liquidity: false, past: false, lastYear: false, invoices: false },
        openMonths: new Set(),
        // A debt being added or edited (its detail view): a draft, id null for new.
        debtDraft: null,
        debtError: '',
        showPastPlanned: false,
        // Our own invoices (invoice-list.js) and the year the card shows
        // (null: the newest there is).
        invoices: [],
        invYear: null,
        invError: '',
        // Our invoices Claude is reading again for the contact and due date:
        // once per visit, so a failure does not repeat on every load.
        invReading: new Set(),
        invReadTried: false,
        // The companies (companies.js), for finding an invoice's company.
        companies: [],
        // The invoice whose project and company are being linked (its number).
        invLink: null,
        // Adding invoices from the invoice list: { text } while open.
        invImport: null,
        invBusy: false,
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
    const round2 = n => Math.round(n * 100) / 100;
    /** "+1.200 €" / "−300 €" / "0 €". */
    const signed = n => (Math.round(n) > 0 ? '+' : Math.round(n) < 0 ? MINUS : '') + PP.euro(Math.abs(Math.round(n)));
    /** "57,5k €", with a minus when below zero - for the chart's axis. */
    const short = n => RF.moneyShort(n);
    const plural = (n, word, many) => n + ' ' + (n === 1 ? word : (many || word + 's'));

    /**
     * A rectangle with squircle corners, as an SVG path: the chart's version of
     * the 60% corner smoothing the stylesheets give everything (design.css).
     * The curve starts 1.6x the radius in from each corner; the handles sit
     * 0.155 of that from the corner, which puts the corner's middle where a
     * plain arc of the radius would have it.
     */
    function squirclePath(x, y, w, h, r) {
        const a = Math.max(0, Math.min(r * 1.6, w / 2, h / 2));
        const k = a * 0.155;
        const R = x + w, B = y + h;
        const n = v => Math.round(v * 100) / 100;
        return `M${n(x + a)} ${n(y)}H${n(R - a)}C${n(R - k)} ${n(y)} ${n(R)} ${n(y + k)} ${n(R)} ${n(y + a)}`
            + `V${n(B - a)}C${n(R)} ${n(B - k)} ${n(R - k)} ${n(B)} ${n(R - a)} ${n(B)}`
            + `H${n(x + a)}C${n(x + k)} ${n(B)} ${n(x)} ${n(B - k)} ${n(x)} ${n(B - a)}`
            + `V${n(y + a)}C${n(x)} ${n(y + k)} ${n(x + k)} ${n(y)} ${n(x + a)} ${n(y)}Z`;
    }

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
        up: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
        down: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l10 10M17 9v8H9"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
        repeat: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13"/><path d="M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/></svg>',
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
            'finInvoices', 'finDebts', 'finForecast', 'finScenario', 'finAdjust'].forEach(id => { els[id] = document.getElementById(id); });

        try {
            const stored = localStorage.getItem(HORIZON_KEY);
            if (stored === 'year') state.horizon = 'year';
            else if (CF.HORIZONS.indexOf(Number(stored)) >= 0) state.horizon = Number(stored);
        } catch (e) { /* no storage: a year */ }
        try { Object.keys(state.folds).forEach(k => { state.folds[k] = localStorage.getItem(FOLD_KEY + k) === '1'; }); } catch (e) { /* folded */ }

        Card.init(els.finForecast, { name: 'financials', controls: els.finScenario, adjust: els.finAdjust });
        // The forecast looks as far ahead as the rest of the page.
        state.months = monthsFor(state.horizon);
        Card.setMonths(state.months, periodText());
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
            const [projects, overview, tx, companies] = await fetchAll(true);
            if (token !== state.token) return;
            state.companies = companies;
            state.projects = projects;
            state.overview = overview;
            state.tx = tx;
            state.error = null;
            Card.setProjects(projects);
            state.loaded = true;
            compute();
            render();
            fillCompanyDetails();
            readOldInvoices().then(fillCompanyDetails);
        } catch (error) {
            if (token !== state.token) return;
            state.error = error.message || 'Could not load';
            renderError();
        } finally {
            if (token === state.token) state.loading = false;
        }
    }

    /** What the page is drawn from: projects, Financials, Bookkeeping, the companies. */
    function fetchAll(freshCompanies) {
        return Promise.all([
            getJson('api/projects.php?' + new URLSearchParams({ search: '', sort: 'name', order: 'ASC' })).then(r => r.data || []),
            getJson(`${API}?action=overview`).then(r => r.data),
            (window.Bookkeeping && window.Bookkeeping.transactions
                ? window.Bookkeeping.transactions()
                : Promise.resolve({ rows: [], amountColumn: null }))
                .catch(error => ({ rows: [], amountColumn: null, error: error.message || 'unavailable' })),
            (window.CRMCompany ? window.CRMCompany.list(freshCompanies) : Promise.resolve([])).catch(() => [])
        ]);
    }

    /**
     * Our invoices: Bookkeeping's and the archived ones (invoice list), each
     * with its company and project - linked by hand, or found (invoice-list.js).
     */
    function buildInvoices(ctx) {
        const c = ctx || { overview: state.overview, tx: state.tx, companies: state.companies, projects: state.projects };
        const reminders = ((c.overview && c.overview.settings) || {}).invoice_reminders || {};
        const today = todayIso();
        const fromBookkeeping = c.tx && c.tx.invoices ? IL.build(c.tx.invoices, reminders, today) : [];
        const archived = IL.fromArchive((c.overview && c.overview.invoice_archive) || [], reminders, today);
        return IL.attach(IL.merge(fromBookkeeping, archived), {
            companies: c.companies || [],
            projects: c.projects || [],
            links: (c.overview && c.overview.invoice_links) || {}
        });
    }

    /** How many months a horizon shows, this one included. */
    function monthsFor(horizon) {
        return horizon === 'year' ? 12 - RF.monthOf(new Date()).month : horizon;
    }

    /** "in next 12 months", or "until Dec" for the year - under the forecast's total. */
    function periodText() {
        return state.horizon === 'year' ? 'until Dec' : `in next ${plural(state.months, 'month')}`;
    }

    /** "over the next 12 months", or "until Dec 2026" for the year. */
    function horizonText() {
        return state.horizon === 'year'
            ? `until Dec ${RF.monthOf(new Date()).year}`
            : `over the next ${plural(state.months, 'month')}`;
    }

    function compute() {
        state.months = monthsFor(state.horizon);
        state.txRows = CF.markVatPayments(state.tx.rows, (state.overview.settings || {}).vat_links);
        const input = {
            projects: state.projects,
            costs: state.overview.costs,
            balances: state.overview.balances,
            transactions: state.txRows,
            debts: state.overview.debts || [],
            settings: state.overview.settings,
            scenario: Card.getSettings(),
            months: state.months,
            now: RF.monthOf(new Date()),
            today: todayIso()
        };
        state.plan = CF.plan(input);
        // Worst and best around the scenario in use: the band in the chart.
        state.band = {
            worst: CF.plan(Object.assign({}, input, { scenario: RF.settingsFor('worst') })),
            realistic: CF.plan(Object.assign({}, input, { scenario: RF.settingsFor('realistic') })),
            best: CF.plan(Object.assign({}, input, { scenario: RF.settingsFor('best') }))
        };
        // The year's end needs the plan to reach December, whatever is shown.
        // A year ahead, whatever is shown: for the year's end, and for the
        // cost cards' other figure while the page shows only until December.
        const twelve = state.months === 12 ? state.plan : CF.plan(Object.assign({}, input, { months: 12 }));
        state.next12 = twelve.kpis;
        const toDecember = state.months >= 12 - input.now.month ? state.plan : twelve;
        state.year = CF.yearResult(state.txRows, toDecember, input.now);
        state.lastYear = CF.lastYearMonths(state.txRows, input.now, toDecember.balance);
        state.invoices = buildInvoices();
        state.suggestions = CF.recurringSuggestions(state.txRows, state.overview.costs,
            (state.overview.settings || {}).dismissed_recurring || [], todayIso());
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    /**
     * The page as it will look while its data loads: the months switch in
     * the header, the three figures in their own markup (label, number,
     * line, two tiles, "Show details") and the chart's card.
     */
    function renderSkeleton() {
        const S = window.Skel;
        els.finPage.setAttribute('aria-busy', 'true');
        renderHead();
        const t = w => (S ? S.text(w) : '');
        const tile = () => `
            <div class="fin-tile">
                <span class="fin-tile-label">${t('56px')}</span>
                <strong class="fin-tile-value">${t('76px')}</strong>
                <small class="fin-tile-sub">${t('64px')}</small>
            </div>`;
        els.finKpis.innerHTML = [0, 1, 2].map(i => `
            <article class="fin-kpi is-skeleton" aria-hidden="true">
                <span class="fin-kpi-label">${t('84px')}</span>
                <span class="fin-kpi-value">${t(['150px', '130px', '110px'][i])}</span>
                <span class="fin-kpi-sub">${t('120px')}</span>
                <div class="fin-tiles">${tile()}${tile()}</div>
                <span class="fin-kpi-toggle">${t('84px')}</span>
            </article>`).join('');
        els.finChart.innerHTML = `
            <div class="fin-card-head"><h2 class="fin-card-title">Cashflow</h2></div>
            <div class="fin-plot-wrap"><div class="fin-skel is-chart"></div></div>`;
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
        renderInvoices();
        renderDebts();

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
            <div class="fin-tool fin-months">
                ${segmented('months', 'Months ahead', CF.HORIZONS.map(n => ({ key: n, label: n + 'M', hint: n + ' months ahead' }))
                    .concat({ key: 'year', label: String(RF.monthOf(new Date()).year), hint: 'Until December' }), state.horizon)}
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

    // ---- The three figures on top ----

    function renderKpis() {
        const p = state.plan;
        const k = p.kpis;

        renderHead();

        const span = horizonText();
        const suggestions = state.suggestions.length;
        const now = RF.monthOf(new Date());
        const plannedCount = state.overview.costs.filter(c => {
            const o = c.kind === 'once' ? RF.offsetOf(c.start_month, now) : null;
            return o !== null && o >= 0 && o < p.months;
        }).length;
        // Loan repayments in these months count as planned costs.
        const repayments = repaymentsAhead();
        const plannedNote = [plannedCount ? plural(plannedCount, 'cost') : '', repayments.length ? plural(repayments.length, 'repayment') : '']
            .filter(Boolean).join(' · ') || '0 costs';
        const total = k.fixedTotal + k.plannedTotal + k.debtTotal;

        // The costs card unfolds downwards to edit what is in it, as the
        // balance and the buffer do on the liquidity card.
        els.finKpis.innerHTML = `
            ${yearCard()}
            <article class="fin-kpi fin-kpi--costs${state.costsOpen ? ' is-open' : ''}">
                <span class="fin-kpi-label">Fixed costs</span>
                <span class="fin-kpi-value">${esc(euro(k.fixedPerMonth))}<span class="fin-kpi-unit">per month</span></span>
                <span class="fin-kpi-sub" title="Fixed and planned costs and repayments"><strong>${esc(euro(total))}</strong> ${esc(span)}</span>
                ${tiles([
                    { label: 'Fixed', value: euro(k.fixedTotal), sub: `${euro(k.fixedPerMonth)}/month` },
                    { label: 'Planned', value: euro(k.plannedTotal + k.debtTotal), sub: plannedNote }
                ])}
                ${suggestions && !state.costsOpen ? `<button type="button" class="fin-suggest-pill" data-fin-costs data-fin-focus="costs-suggest"
                    title="Recurring payments in Bookkeeping that are not among the fixed costs yet">${ICON.repeat}${esc(plural(suggestions, 'suggestion'))}</button>` : ''}
                ${state.costsOpen ? costsPanel() : ''}
                <button type="button" class="fin-kpi-toggle" data-fin-costs data-fin-focus="costs" aria-expanded="${state.costsOpen}">
                    ${state.costsOpen ? 'Hide details' : 'Show details'}${ICON.chevron}
                </button>
            </article>
            ${liquidityCard()}`;
    }

    /**
     * Liquidity: today's bank balance, how long it lasts under the scenario
     * (the last month before it would fall below zero), the low point, and
     * the buffer. Its details hold what is changed from here: the buffer
     * (its tile) and the balance (the form under them).
     */
    function liquidityCard() {
        const p = state.plan;
        const k = p.kpis;
        const b = p.balance;
        const now = RF.monthOf(new Date());
        const money = v => (v < 0 ? MINUS : '') + euro(Math.abs(v));

        let lasts = '—';
        let lastsTone = '';
        if (b) {
            if (b.amount < 0) {
                lasts = 'below zero now';
                lastsTone = 'is-neg';
            } else if (k.belowZero) {
                lasts = k.belowZero.offset === 0 ? 'this month' : RF.monthName(k.belowZero.offset - 1, now);
                lastsTone = k.belowZero.offset < 6 ? 'is-neg' : 'is-warn';
            } else {
                lasts = state.horizon === 'year' ? 'past December' : `past ${p.rows[p.rows.length - 1].label}`;
                lastsTone = 'is-pos';
            }
        }
        const low = k.lowest;
        const lowTone = !low ? '' : low.amount < 0 ? 'is-neg' : (k.belowBuffer ? 'is-warn' : '');

        return `
            <article class="fin-kpi fin-kpi--liquidity${state.folds.liquidity ? ' is-open' : ''}">
                <span class="fin-kpi-label">Liquidity</span>
                <span class="fin-kpi-value${b && b.amount < 0 ? ' is-neg' : ''}">${b ? esc(money(b.amount)) : '—'}</span>
                <span class="fin-kpi-sub" title="${esc(balanceNote())}">${b ? 'Bank balance today' : 'Enter today’s balance to plan from it'}</span>
                ${tiles([
                    vatTile(),
                    { label: 'Lasts until', value: lasts, valueCls: lastsTone, tone: lastsTone, subHtml: scenarioChip(),
                        title: 'The last month before the balance would fall below zero' }
                ])}
                ${state.vatOpen ? vatPanel() : ''}
                ${state.folds.liquidity ? tiles([
                    { label: 'Low point', value: low && b ? money(low.amount) : '—', sub: low ? low.label : '', valueCls: lowTone },
                    { label: 'Buffer', sub: p.settings.buffer > 0 ? 'always keep' : '',
                        valueHtml: `<button type="button" class="fin-link fin-balance-link" data-fin-buffer data-fin-focus="buffer" aria-expanded="${state.bufferOpen}"
                            title="The least that should always be in the account; the chart and the low point warn below it">${p.settings.buffer > 0 ? esc(euro(p.settings.buffer)) : 'Set'}</button>` }
                ]) : ''}
                ${state.bufferOpen ? bufferForm() : ''}
                ${state.folds.liquidity ? `<p class="fin-balance-note">${esc(balanceNote())}</p>${balanceForm()}` : ''}
                ${foldToggle('liquidity')}
            </article>`;
    }


    // ---- VAT: what the tax office gets, quarter by quarter ----

    /** "−1.900 €" to pay, "+200 €" back - to the cent, as the tax office counts. */
    const vatAmount = owed => (owed > 0.005 ? MINUS : owed < -0.005 ? '+' : '') + cents(Math.abs(owed));

    /**
     * Beside the balance: the VAT the tax office still gets - every quarter
     * not settled, today's as far as it has run - and when the next one is
     * due. A tile that opens the quarters.
     */
    function vatTile() {
        const k = state.plan.kpis;
        const next = k.vatNext;
        const owed = k.vatOwed;
        // Short enough for half a card: "Q4 so far, due Feb 15"; in full on hover.
        const q = next ? next.label.split(' ')[0] : '';
        const day = next ? dayName(next.due).replace(/,? \d{4}$/, '') : '';
        let sub;
        let full;
        if (!next) sub = full = 'nothing open';
        else if (next.overdue) { sub = `${q} overdue since ${day}`; full = `${next.label} was due ${dayName(next.due)} and is not linked to a payment yet`; }
        else if (next.running) { sub = `${q} so far, due ${day}`; full = `${next.label} so far, due ${dayName(next.due)}`; }
        else { sub = `${q} due ${day}`; full = `${next.label} due ${dayName(next.due)}`; }
        return {
            label: owed < -0.005 ? 'VAT back' : 'VAT owed',
            value: vatAmount(owed),
            sub,
            tone: next && next.overdue ? 'is-warn' : '',
            title: `${full}. Opens each quarter and the bank entries that paid it.`,
            button: `data-fin-vat data-fin-focus="vat" aria-expanded="${state.vatOpen}"`
        };
    }

    /** One bank row as a choice: "Nov 14, Finanzamt Österreich, −2.600 €". */
    function rowText(t) {
        return [dayName(t.date), t.party || (t.amount < 0 ? 'Payment' : 'Incoming payment'), (t.amount < 0 ? MINUS : '+') + cents(Math.abs(t.amount))].join(', ');
    }

    function vatQuarterRow(q) {
        const off = state.vatBusy ? ' disabled' : '';
        let status;
        if (q.payments.length) status = q.payments.map(t => `
                <span class="fin-vat-paid">${ICON.bank}<span>${esc(rowText(t))}</span>
                    <button type="button" class="fin-link" data-fin-vat-unlink="${esc(q.key)}" data-row="${esc(t.id)}"${off}>Unlink</button></span>`).join('');
        else if (q.manual) status = `<span class="fin-vat-paid"><span>Settled without a bank entry</span>
                    <button type="button" class="fin-link" data-fin-vat-unlink="${esc(q.key)}" data-row=""${off}>Undo</button></span>`;
        else if (q.running) status = `<span class="fin-muted">Still running, due ${esc(dayName(q.due))}</span>`;
        else if (q.nil) status = '<span class="fin-muted">Nothing to pay</span>';
        else status = `<span class="${q.overdue ? 'fin-vat-late' : 'fin-muted'}">${q.overdue ? 'Was due' : 'Due'} ${esc(dayName(q.due))}</span>`;

        // Paid more or less than the quarter comes to: other taxes on the
        // same transfer, or a correction - said, not judged.
        const diff = q.payments.length ? round2(Math.abs(q.paid) - Math.abs(q.owed)) : 0;
        const diffNote = Math.abs(diff) > 1
            ? `<p class="fin-vat-note">${esc(cents(Math.abs(diff)))} ${diff > 0 ? 'more' : 'less'} than the VAT${diff > 0 ? ', other taxes paid with it?' : ''}</p>` : '';

        let link = '';
        if (!q.settled && !q.nil && !q.running) {
            const sug = CF.vatSuggestion(q, state.txRows);
            const choices = CF.vatCandidates(q, state.txRows, 12);
            link = `
                ${sug ? `<button type="button" class="fin-vat-suggest" data-fin-vat-link="${esc(q.key)}" data-row="${esc(sug.row.id)}"${off}>
                    ${ICON.bank}<span>${esc(rowText(sug.row))}</span><strong>Link</strong></button>` : ''}
                <div class="fin-vat-actions">
                    ${choices.length ? `<select class="form-select fin-vat-select" data-fin-vat-pick="${esc(q.key)}" aria-label="Link a bank entry to ${esc(q.label)}"${off}>
                        <option value="">${sug ? 'Another bank entry…' : 'Link a bank entry…'}</option>
                        ${choices.map(c => `<option value="${esc(c.row.id)}">${esc(rowText(c.row))}</option>`).join('')}
                    </select>` : '<span class="fin-muted">No payment in Bookkeeping yet</span>'}
                    <button type="button" class="fin-link" data-fin-vat-settle="${esc(q.key)}"${off}
                        title="Paid or offset without a bank entry here, e.g. against a credit on the tax account">Settled otherwise</button>
                </div>`;
        }

        return `
            <li class="fin-vat-q${q.settled ? ' is-settled' : ''}${q.overdue ? ' is-late' : ''}">
                <div class="fin-vat-q-head">
                    <strong>${esc(q.label)}</strong>
                    <span class="fin-vat-q-amount${q.owed < -0.005 ? ' is-pos' : ''}">${esc(vatAmount(q.owed))}</span>
                </div>
                <div class="fin-vat-q-meta"
                    title="VAT on our invoices ${esc(cents(q.collected))}, VAT on what we paid ${esc(cents(q.deductible))}">
                    ${status}
                </div>
                ${q.open ? `<p class="fin-vat-note is-warn">${esc(plural(q.open, 'entry', 'entries'))} without invoice, not final</p>` : ''}
                ${diffNote}
                ${link}
            </li>`;
    }

    /** The quarters, newest first, and from which one on they are tracked. */
    function vatPanel() {
        const quarters = state.plan.vat.slice().reverse();
        const settings = state.overview.settings || {};
        const current = CF.quarterOf(todayIso());
        const from = CF.vatFrom(settings, todayIso());
        const keys = [];
        for (let i = 0; i <= 8; i++) keys.push(CF.shiftQuarter(current, -i));
        // Tracked from longer ago than the last two years: that one too.
        if (from < keys[keys.length - 1]) keys.push(from);
        const options = keys.map(key => `<option value="${esc(key)}"${key === from ? ' selected' : ''}>${esc(CF.quarterLabel(key))}</option>`);
        return `
            <div class="fin-balance-form fin-vat-panel">
                <ul class="fin-vat-list">${quarters.map(vatQuarterRow).join('')}</ul>
                ${state.vatError ? `<p class="fin-form-error">${esc(state.vatError)}</p>` : ''}
                <label class="fin-vat-from">
                    <span>Tracked from</span>
                    <select class="form-select" data-fin-vat-from aria-label="First quarter tracked"${state.vatBusy ? ' disabled' : ''}>${options.join('')}</select>
                </label>
            </div>`;
    }

    async function saveVat(payload) {
        state.vatBusy = true;
        state.vatError = '';
        renderKpis();
        try {
            const result = await post('save-settings', payload);
            state.overview = result.data;
            compute();
            state.vatBusy = false;
            render();
        } catch (error) {
            state.vatBusy = false;
            state.vatError = error.message;
            renderKpis();
        }
        const again = els.finKpis.querySelector('[data-fin-focus="vat"]');
        if (again) again.focus();
    }

    /** "Realistic", or "custom" for a scenario adjusted by hand. */
    function scenarioName() {
        const key = RF.activePreset(Card.getSettings());
        const preset = key ? RF.presetByKey(key) : null;
        return preset ? preset.label : 'Custom';
    }

    /**
     * The first card: this year's result so far - profit or loss without the
     * VAT, from Bookkeeping (so it matches the balance) - and
     * the year's result as the scenario projects it. Folded it shows just
     * those two; unfolded, the revenue and costs behind each.
     */
    function yearCard() {
        const y = state.year;
        const open = state.folds.year;
        return `
            <article class="fin-kpi fin-kpi--year${open ? ' is-open' : ''}">
                <span class="fin-kpi-label">Net result YTD</span>
                <span class="fin-kpi-value ${tone(y.actual)}">${esc(signed(y.actual))}</span>
                <span class="fin-kpi-sub">Jan 1 – ${esc(dayName(todayIso()))}, without VAT</span>
                ${tiles([
                    { label: `Projected ${y.year}`, value: signed(y.projected), valueCls: tone(y.projected), tone: tone(y.projected),
                        subHtml: scenarioChip(), title: 'Where the year ends: the result so far plus what the plan nets until December' },
                    { label: 'Until December', value: signed(y.planned), valueCls: tone(y.planned), sub: 'what the plan still nets',
                        title: `${euro(y.incomeRest)} still to come in, ${euro(y.costsRest)} still to pay` }
                ])}
                ${open ? tiles([
                    { label: 'Received', icon: ICON.up, cls: 'is-up', value: signed(y.income), sub: `${euro(y.revenue)} for ${y.year}`,
                        title: `Jan – Dec ${y.year}: ${euro(y.income)} so far + ${euro(y.incomeRest)} open` },
                    { label: 'Paid', icon: ICON.down, cls: 'is-down', value: signed(-y.costs), sub: `${euro(y.costsYear)} for ${y.year}`,
                        title: `Paid so far, from Bookkeeping. Jan – Dec ${y.year}: ${euro(y.costs)} so far + ${euro(y.costsRest)} open` }
                ]) : ''}
                ${foldToggle('year')}
            </article>`;
    }

    /** "Show details" / "Hide details" under a card that folds. */
    function foldToggle(key) {
        const open = state.folds[key];
        return `<button type="button" class="fin-kpi-toggle" data-fin-fold="${key}" data-fin-focus="fold-${key}" aria-expanded="${open}">
                    ${open ? 'Hide details' : 'Show details'}${ICON.chevron}
                </button>`;
    }

    /** "is-pos" / "is-neg" / "" for a result, by its whole euros. */
    function tone(v) {
        return Math.round(v) > 0 ? 'is-pos' : Math.round(v) < 0 ? 'is-neg' : '';
    }

    /**
     * Two figures side by side on soft tiles inside a card:
     * [{ label, value, sub?, icon?, cls?, valueCls?, title?, valueHtml?,
     *    subHtml?, tone? (tints the tile: is-pos / is-neg / is-warn),
     *    button? (attributes: the whole tile is a button) }].
     * Every tile has its three lines, so tiles side by side - and on the
     * cards beside each other - are the same height.
     */
    function tiles(list) {
        return `<div class="fin-tiles">${list.map(t => {
            const tag = t.button ? 'button' : 'div';
            const attrs = (t.button ? ` type="button" ${t.button}` : '') + (t.title ? ` title="${esc(t.title)}"` : '');
            return `
            <${tag} class="fin-tile${t.tone ? ' ' + t.tone : ''}${t.button ? ' is-button' : ''}"${attrs}>
                <span class="fin-tile-label ${t.cls || ''}">${t.icon || ''}${esc(t.label)}${t.button ? ICON.chevron : ''}</span>
                <strong class="fin-tile-value ${t.valueCls || ''}">${t.valueHtml || esc(t.value)}</strong>
                <small class="fin-tile-sub">${t.subHtml || esc(t.sub || '')}</small>
            </${tag}>`;
        }).join('')}</div>`;
    }

    /** The scenario a figure rests on, as a chip that leads to the forecast's switch. */
    function scenarioChip() {
        return `<button type="button" class="fin-band-chip" data-fin-scenario-jump title="The forecast scenario this rests on - change it in the revenue forecast">${esc(scenarioName())}</button>`;
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
                <p class="fin-hint">The least that should always be in the account. The chart and the low point warn below it; 0 turns it off.</p>
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
        const alerts = [];
        // Below zero or below the buffer is on the "Lowest balance" card
        // already, in its colour; a banner repeating it was one too many.
        // Overdue payments show in the month detail and the forecast;
        // no banner for them here.
        if (!p.hasBalance) {
            alerts.push({ tone: 'info', html: '<strong>No bank balance yet.</strong> The balance line starts at zero until you enter one under Liquidity, Show details.' });
        }
        els.finAlerts.innerHTML = alerts.length
            ? `<div class="fin-alerts">${alerts.map(a => `<p class="fin-alert is-${a.tone}">${ICON.warn}<span>${a.html}</span></p>`).join('')}</div>`
            : '';
    }

    // ---- The cashflow chart ----

    /** Past months (actuals) then the plan, as columns. */
    function chartColumns() {
        const p = state.plan;
        // A past month's net is its result without VAT where Bookkeeping
        // gives it (this year and last), otherwise what came in less what went out.
        const result = o => {
            const m = (state.year ? state.year.months : []).concat(state.lastYear || []).find(x => x.offset === o);
            return m ? m.result : null;
        };
        return p.past.map(m => {
            const r = result(m.offset);
            return { past: true, label: m.label, offset: m.offset, in: m.income, out: m.expenses, net: r !== null ? r : m.income - m.expenses, closing: m.closing };
        }).concat(p.rows.map(r => ({ past: false, label: r.label, offset: r.offset, in: r.in, out: r.out, net: r.net, closing: p.hasBalance ? r.closing : null, row: r })));
    }

    /** Each planned month's balance under worst and best: the band's edges. */
    function bandPoints() {
        const p = state.plan;
        if (!p.hasBalance || !state.band) return [];
        return p.rows.map((r, i) => {
            const all = [r.closing, state.band.worst.rows[i].closing, state.band.best.rows[i].closing];
            return { lo: Math.min(...all), hi: Math.max(...all) };
        });
    }

    function renderChart() {
        // The line is the balance, red below zero; the band around it runs
        // from the worst to the best scenario; the buffer line carries its
        // own label.
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
            <span><span>Net</span><strong class="${c.net < 0 ? 'is-neg' : 'is-pos'}">${esc(signed(c.net))}</strong></span>
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
     * below - with "Today" marked on it, worst to best as a band around it
     * with the three scenarios as faint lines named at their ends, and each
     * month's money in (up) and out (down) as bars. Hovering a month reads
     * its in, out and net above the chart.
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
        // On the right, room for the scenarios' names at the ends of their lines.
        const padL = 48, padR = p.hasBalance && state.band ? 70 : 12;
        const top = 16, H1 = narrow ? 190 : 250, axisH = 30;
        const H = top + H1 + axisH;
        const cw = (W - padL - padR) / n;
        const cx = i => padL + cw * (i + 0.5);
        const todayX = padL + cw * p.past.length;

        const band = bandPoints();
        const values = cols.filter(c => c.closing !== null).map(c => c.closing)
            .concat(cols.map(c => c.in), cols.map(c => -c.out), band.flatMap(x => [x.lo, x.hi]));
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
        // Grid, zero line, the red below it, the lines and the band all end
        // together, just past the last month's bars, so no bar is cut.
        const barW = Math.max(3, Math.min(16, cw * 0.32));
        const right = cx(n - 1) + barW / 2 + 3;
        const tail = pts => pts.concat([[right, pts[pts.length - 1][1]]]);

        const parts = [];
        parts.push(`<defs>
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
        // Each month's money in as a bar up from zero, money out as one down.
        cols.forEach((c, i) => {
            const past = c.past ? ' is-past' : '';
            if (c.in > 0.5) {
                parts.push(`<path class="fin-flow-bar is-in${past}" d="${squirclePath(cx(i) - barW / 2, y1(c.in), barW, Math.max(1, y0 - y1(c.in)), 2)}"/>`);
            }
            if (c.out > 0.5) {
                parts.push(`<path class="fin-flow-bar is-out${past}" d="${squirclePath(cx(i) - barW / 2, y0, barW, Math.max(1, y1(-c.out) - y0), 2)}"/>`);
            }
        });
        // Drawn at x 0 and moved under the hovered month with a transform.
        parts.push(`<path class="fin-hover-band" data-fin-band d="${squirclePath(0, top - 6, cw, H1 + 12, 8)}" visibility="hidden"/>`);

        if (p.hasBalance) {
            const pastPts = cols.map((c, i) => (c.past && c.closing !== null ? [cx(i), y1(c.closing)] : null)).filter(Boolean);
            const todayPt = [todayX, y1(p.balance.amount)];
            const futurePts = tail([todayPt].concat(cols.map((c, i) => (!c.past ? [cx(i), y1(c.closing)] : null)).filter(Boolean)));
            const line = smoothPath(futurePts);

            // Worst to best, as a band around the line.
            if (band.length) {
                const firstFuture = cols.findIndex(c => !c.past);
                const upper = tail([todayPt].concat(band.map((x, j) => [cx(firstFuture + j), y1(x.hi)])));
                const lower = tail([todayPt].concat(band.map((x, j) => [cx(firstFuture + j), y1(x.lo)]))).reverse();
                parts.push(`<path class="fin-scenario-band" d="${smoothPath(upper)} ${smoothPath(lower).replace(/^M/, 'L')} Z"/>`);

                // The three scenarios as faint lines in it, each named where
                // it ends; names pushed apart when the ends lie close.
                const ends = [];
                ['worst', 'realistic', 'best'].forEach(key => {
                    const rows = state.band[key].rows;
                    const pts = tail([todayPt].concat(rows.map((r, j) => [cx(firstFuture + j), y1(r.closing)])));
                    parts.push(`<path class="fin-scenario-line is-${key}" d="${smoothPath(pts)}"/>`);
                    ends.push({ key, x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] });
                });
                ends.sort((a, b) => a.y - b.y);
                for (let j = 1; j < ends.length; j++) ends[j].y = Math.max(ends[j].y, ends[j - 1].y + 12);
                ends.forEach(e => {
                    parts.push(`<text class="fin-scenario-label is-${e.key}" x="${e.x + 6}" y="${e.y + 4}">${esc(RF.presetByKey(e.key).label)}</text>`);
                });
            }

            if (pastPts.length) parts.push(`<path class="fin-line is-past" d="${smoothPath(pastPts.concat([todayPt]))}"/>`);
            // No fill under the line: the band around it says enough.
            parts.push(`<path class="fin-line" d="${line}" clip-path="url(#finAbove)"/>`);
            parts.push(`<path class="fin-line is-neg" d="${line}" clip-path="url(#finBelow)"/>`);

            // Today: a dotted line down from its point.
            parts.push(`<line class="fin-today" x1="${todayX}" x2="${todayX}" y1="${todayPt[1]}" y2="${top + H1}"/>`);
            parts.push(`<circle class="fin-dot-mark" cx="${todayPt[0]}" cy="${todayPt[1]}" r="6"/>`);

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
        band.setAttribute('transform', `translate(${g.padL + g.cw * i} 0)`);
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

        // This year's months gone by, as their actual result from Bookkeeping:
        // one summary row, unfolded to the single months.
        const dash = '<span class="fin-muted">—</span>';
        const months = state.year.months.filter(m => m.offset < 0);
        const pastOpen = state.folds.past;
        const monthRows = list => list.map(m => {
            const open = state.openMonths.has(m.offset);
            return `
                <tr class="fin-month is-past${open ? ' is-open' : ''}">
                    <th scope="row">
                        ${m.rows ? `<button type="button" class="fin-month-toggle" data-fin-month="${m.offset}" data-fin-focus="month-${m.offset}" aria-expanded="${open}">
                            ${ICON.chevron}<span>${esc(m.label)}</span><span class="fin-tag">actual</span>
                        </button>` : `<span class="fin-month-label"><span>${esc(m.label)}</span><span class="fin-tag">actual</span></span>`}
                    </th>
                    <td class="is-pos">${m.income > 0.005 ? esc(signed(m.income)) : dash}</td>
                    <td>${m.costs > 0.005 ? esc(signed(-m.costs)) : dash}</td>
                    <td class="${m.result < 0 ? 'is-neg' : 'is-pos'}">${m.rows ? `<strong>${esc(signed(m.result))}</strong>` : dash}</td>
                    <td class="fin-col-balance ${m.rows && m.closing !== null ? balClass(m.closing) : ''}">${m.rows && m.closing !== null ? esc((m.closing < 0 ? MINUS : '') + euro(Math.abs(m.closing))) : dash}</td>
                </tr>
                ${open ? `<tr class="fin-month-detail"><td colspan="5">${monthDetail(m.offset, null)}</td></tr>` : ''}`;
        }).join('');
        // Last year, closed: one row above, so it stays in reach after New Year.
        const last = (state.lastYear || []).some(m => m.rows) ? state.lastYear : [];
        const lastOpen = state.folds.lastYear;
        const past = (last.length ? pastSummary(last, lastOpen, balClass, 'lastYear') + (lastOpen ? monthRows(last) : '') : '')
            + (months.length ? pastSummary(months, pastOpen, balClass, 'past') + (pastOpen ? monthRows(months) : '') : '');

        const sofar = state.year.months.find(m => m.offset === 0);
        const body = past + p.rows.map(r => {
            const open = state.openMonths.has(r.offset);
            // This month counts in full: what Bookkeeping already has (net)
            // plus what the plan still expects - not only what is left.
            const now = r.offset === 0 && sofar;
            const inV = r.in + (now ? sofar.income : 0);
            // Every cost of the month: what Bookkeeping has paid plus what is
            // still open.
            // VAT to the tax office is in r.out too; a refund in r.in.
            const outV = r.out + (now ? sofar.costs : 0);
            const net = inV - outV;
            return `
                <tr class="fin-month${open ? ' is-open' : ''}${r.offset === 0 ? ' is-now' : ''}"${now ? ' title="Already in Bookkeeping this month plus what is still planned"' : ''}>
                    <th scope="row">
                        <button type="button" class="fin-month-toggle" data-fin-month="${r.offset}" data-fin-focus="month-${r.offset}" aria-expanded="${open}">
                            ${ICON.chevron}<span>${esc(r.label)}</span>${r.offset === 0 ? '<span class="fin-tag">now</span>' : ''}
                        </button>
                    </th>
                    <td class="is-pos">${inV > 0.005 ? esc(signed(inV)) : '<span class="fin-muted">—</span>'}</td>
                    <td>${outV > 0.005 ? esc(signed(-outV)) : '<span class="fin-muted">—</span>'}</td>
                    <td class="${net < 0 ? 'is-neg' : 'is-pos'}"><strong>${esc(signed(net))}</strong></td>
                    <td class="fin-col-balance ${p.hasBalance ? balClass(r.closing) : ''}">${p.hasBalance ? esc((r.closing < 0 ? MINUS : '') + euro(Math.abs(r.closing))) : '<span class="fin-muted">—</span>'}</td>
                </tr>
                ${open ? `<tr class="fin-month-detail"><td colspan="5">${monthDetail(r.offset, r)}</td></tr>` : ''}`;
        }).join('');

        els.finMonths.innerHTML = `
            <div class="fin-card-head">
                <h2 class="fin-card-title">Month by month</h2>
            </div>
            <div class="fin-table-scroll">
                <table class="fin-table">
                    <thead><tr>
                        <th scope="col">Month</th><th scope="col">In</th><th scope="col" title="From this month on: costs, loan repayments and VAT to the tax office">Costs</th>
                        <th scope="col" title="Past months: the actual result, without VAT. From this month on: what the plan nets">Net</th><th scope="col">Balance</th>
                    </tr></thead>
                    <tbody>${body}</tbody>
                </table>
            </div>`;
    }

    /** "Jan – Oct 2026": months gone by, in one row with their totals; fold: its key in state.folds. */
    function pastSummary(months, open, balClass, fold) {
        const first = months[0];
        const last = months[months.length - 1];
        const label = months.length === 1 ? last.label
            : first.label.replace(/\s\d{4}$/, '') + ' – ' + last.label;
        const income = months.reduce((n, m) => n + m.income, 0);
        const costs = months.reduce((n, m) => n + m.costs, 0);
        const result = income - costs;
        const withBalance = months.filter(m => m.rows && m.closing !== null);
        const closing = withBalance.length ? withBalance[withBalance.length - 1].closing : null;
        const dash = '<span class="fin-muted">—</span>';
        return `
                <tr class="fin-month is-past is-summary${open ? ' is-open' : ''}">
                    <th scope="row">
                        <button type="button" class="fin-month-toggle" data-fin-fold="${fold}" data-fin-focus="fold-${fold}" aria-expanded="${open}"
                            title="${open ? 'Fold the months gone by' : 'Show each month gone by'}">
                            ${ICON.chevron}<span>${esc(label)}</span><span class="fin-tag">actual</span>
                        </button>
                    </th>
                    <td class="is-pos">${income > 0.005 ? esc(signed(income)) : dash}</td>
                    <td>${costs > 0.005 ? esc(signed(-costs)) : dash}</td>
                    <td class="${result < 0 ? 'is-neg' : 'is-pos'}"><strong>${esc(signed(result))}</strong></td>
                    <td class="fin-col-balance ${closing !== null ? balClass(closing) : ''}">${closing !== null ? esc((closing < 0 ? MINUS : '') + euro(Math.abs(closing))) : dash}</td>
                </tr>`;
    }

    /**
     * A month's bank rows from Bookkeeping, net of VAT like the month's
     * totals, largest first: { in: [...], out: [...] }.
     */
    function bookedRows(offset) {
        const key = monthKey(offset, RF.monthOf(new Date()));
        const net = t => t.amount + (Number(t.vat) || 0);
        const all = (state.txRows || []).filter(t => !t.excluded && String(t.date).slice(0, 7) === key);
        // VAT to or from the tax office is neither income nor a cost: apart.
        const rows = all.filter(t => !t.vatQuarter);
        const item = (t, fallback, sign) => ({ name: t.party || fallback, date: t.date, amount: sign * net(t), open: !!t.open });
        return {
            in: rows.filter(t => t.amount > 0).map(t => item(t, 'Incoming payment', 1)).sort((a, b) => b.amount - a.amount),
            out: rows.filter(t => t.amount < 0).map(t => item(t, 'Payment', -1)).sort((a, b) => b.amount - a.amount),
            vat: all.filter(t => t.vatQuarter)
        };
    }

    const BOOKED_LIMIT = 8;

    /**
     * An unfolded month: income on one side, costs on the other - each
     * split into what has already flowed (Bookkeeping) and what is still to
     * come (the plan), with its sum. The two columns add up to the month's
     * In and Costs in the table.
     *   offset: the month; r: its plan row, or null for a month gone by
     */
    function monthDetail(offset, r) {
        const booked = offset <= 0 ? bookedRows(offset) : { in: [], out: [], vat: [] };
        const sumOf = (list, fn) => list.reduce((t, x) => t + fn(x), 0);

        const line = (name, meta, amount, cls) => `
            <li class="fin-flow-item${cls ? ' ' + cls : ''}">
                <span class="fin-flow-name">${name}${meta ? `<span class="fin-flow-meta">${meta}</span>` : ''}</span>
                <span class="fin-flow-amount">${amount}</span>
            </li>`;

        const bookedList = (rows, sign) => {
            const shown = rows.slice(0, BOOKED_LIMIT);
            const rest = rows.slice(BOOKED_LIMIT);
            return shown.map(t => line(esc(t.name), esc(dayName(t.date)), esc(signed(sign * t.amount)))).join('')
                + (rest.length ? `<li class="fin-flow-more">${esc(plural(rest.length, 'more'))} · ${esc(signed(sign * sumOf(rest, t => t.amount)))}</li>` : '');
        };

        const group = (title, total, sign, body, cls) => body ? `
            <div class="fin-flow-group${cls ? ' ' + cls : ''}">
                <p class="fin-flow-group-title"><span>${esc(title)}</span><strong>${esc(signed(sign * total))}</strong></p>
                <ul class="fin-flow-list">${body}</ul>
            </div>` : '';

        // Income: what came in, then what is still open.
        const expected = r ? r.items.income : [];
        const received = group('Received', sumOf(booked.in, t => t.amount), 1, bookedList(booked.in, 1));
        const openIn = group('Open', sumOf(expected, x => x.expected), 1, expected.map(x => line(
            `<a href="#" data-crm-action="open-project-overview" data-project-id="${esc(x.projectId)}">${esc(x.name)}</a>`,
            esc([incomeKind(x), x.factor < 1 ? `${Math.round(x.factor * 100)}% of ${euro(x.net)}` : ''].filter(Boolean).join(' · '))
                + (x.overdue ? '<span class="fin-flow-late">overdue</span>' : ''),
            esc(signed(x.expected)))).join(''), 'is-open');
        // A quarter's VAT: out to the tax office, or back from it.
        const vatItems = r ? r.items.vat : [];
        const vatMeta = q => (q.running ? `${q.label} so far, due ${dayName(q.due)}` : `due ${dayName(q.due)}`)
            + (q.overdue ? '<span class="fin-flow-late">overdue</span>' : '');
        const vatIn = vatItems.filter(q => q.owed < 0);
        const vatOut = vatItems.filter(q => q.owed > 0);
        const refunds = group('VAT back', -sumOf(vatIn, q => q.owed), 1, vatIn.map(q => line(
            esc(`VAT ${q.label}`), vatMeta(q), esc(signed(-q.owed)))).join(''), 'is-open');
        const inTotal = sumOf(booked.in, t => t.amount) + sumOf(expected, x => x.expected) - sumOf(vatIn, q => q.owed);

        // Costs: what Bookkeeping has paid this month, then what is still
        // open - a cost whose day has passed but that is not booked yet is
        // open, marked due.
        const costs = r ? r.items.costs : [];
        const toCome = costs.filter(c => !c.paid);
        const debts = r ? r.items.debts : [];
        const paidTotal = sumOf(booked.out, t => t.amount);
        const paid = group('Paid', paidTotal, -1, bookedList(booked.out, -1));
        const openTotal = sumOf(toCome, c => c.amount) + sumOf(debts, d => d.amount) + sumOf(vatOut, q => q.owed);
        const openOut = group('Open', openTotal, -1, toCome.map(c => line(esc(c.cost.name),
            esc([c.cost.category, c.cost.kind === 'once' ? 'planned' : rhythm(c.cost)].filter(Boolean).join(' · '))
                + (c.due ? '<span class="fin-flow-late">due</span>' : ''),
            esc(signed(-c.amount)))).join('')
            + debts.map(d => line(esc(d.debt.name), esc(`repayment ${euro(d.principal)} + ${euro(d.interest)} interest`),
                esc(signed(-d.amount)))).join('')
            + vatOut.map(q => line(esc(`VAT ${q.label}`), 'to the tax office, ' + vatMeta(q), esc(signed(-q.owed)))).join(''), 'is-open');
        // VAT already paid to (or back from) the tax office this month: shown,
        // but not counted as a cost or income - it only passes through.
        const vatBooked = group('VAT settled', sumOf(booked.vat, t => t.amount), 1, booked.vat.map(t => line(esc(t.party || 'Tax office'),
            esc(`${CF.quarterLabel(t.vatQuarter)}, ${dayName(t.date)}`), esc(signed(t.amount)))).join(''), 'is-aside');
        const outTotal = paidTotal + openTotal;

        const empty = '<p class="fin-flow-empty">Nothing</p>';
        if (!received && !openIn && !refunds && !paid && !openOut && !vatBooked) {
            return '<p class="fin-muted fin-detail-empty">Nothing booked or planned this month.</p>';
        }
        return `
            <div class="fin-flow">
                <section class="fin-flow-col is-in" aria-label="Income">
                    <header class="fin-flow-head"><span>Income</span><strong>${esc(signed(inTotal))}</strong></header>
                    ${received + openIn + refunds || empty}
                </section>
                <section class="fin-flow-col is-out" aria-label="Costs">
                    <header class="fin-flow-head"><span>Costs</span><strong>${esc(signed(-outTotal))}</strong></header>
                    ${paid + openOut || (vatBooked ? '' : empty)}
                    ${vatBooked}
                </section>
            </div>`;
    }

    function incomeKind(x) {
        if (x.kind === 'payment') return x.full ? 'Payment in full' : 'Expected payment';
        return x.partial ? 'Rest of budget' : 'Final invoice';
    }

    // ---- Debts ----

    /** "Mar 1, 2025": loans run over years, so always with the year. */
    const fullDay = iso => (iso ? window.CRMFormat.date(iso, { year: true }) : '');

    /** "4,5 %" */
    const ratePct = r => String(Math.round((Number(r) || 0) * 1000) / 1000).replace('.', ',') + ' %';

    /** Interest with cents: on a loan they add up and are checked to the cent. */
    const cents = n => PP.euro(Math.round(n * 100) / 100);

    /**
     * Debts: every loan with whom it is owed to, its dates and rate, and the
     * interest it has run up until today - and will have by its repayment.
     * A loan opens into its detail view to change it.
     */
    // ---- Our invoices ----

    const STATUS = {
        paid: { label: 'Paid', tone: 'paid' },
        late: { label: 'Paid late', tone: 'late' },
        partial: { label: 'Part paid', tone: 'partial' },
        open: { label: 'Invoiced', tone: 'open' },
        overdue: { label: 'Overdue', tone: 'overdue' },
        reminded: { label: 'Reminded', tone: 'reminded' }
    };

    const ICON_BELL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8.5a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 14.5 6 8.5"/><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0"/></svg>';

    /** The status pill, with the days behind it in its tooltip. */
    function invoiceStatus(i) {
        const s = STATUS[i.status];
        const hint = [];
        if (i.due) hint.push(`Due ${fullDay(i.due)}`);
        if (i.daysLate) hint.push(i.paid ? `paid ${plural(i.daysLate, 'day')} late` : `${plural(i.daysLate, 'day')} overdue`);
        if (i.reminded) hint.push(`reminder sent ${fullDay(i.reminded)}`);
        if (i.status === 'partial') hint.push(`${cents(i.outstanding)} still open`);
        return `<span class="fin-inv-status is-${s.tone}"${hint.length ? ` title="${esc(hint.join(', '))}"` : ''}>${esc(s.label)}</span>`;
    }

    const ICON_LINK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13.5a4 4 0 0 0 5.7.3l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.6"/><path d="M14 10.5a4 4 0 0 0-5.7-.3L5.5 13a4 4 0 0 0 5.7 5.7l1.3-1.3"/></svg>';
    const ICON_PASTE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="4.5" width="13" height="16" rx="2"/><path d="M9 4.5V3.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v.7"/><path d="M9 11h6M9 14.5h6"/></svg>';

    /** The customer: its company, which opens the company's sheet, or the name as written. */
    function invoiceCustomer(i) {
        if (i.company) {
            return `<button type="button" class="fin-inv-link" data-open-company="${i.company.id}" data-company-name="${esc(i.company.name)}"
                title="${esc(i.customer && i.customer !== i.company.name ? `${i.customer} on the invoice` : i.company.name)}">${esc(i.company.name)}</button>`;
        }
        return `<span class="fin-inv-plain" title="${esc(i.customer ? `${i.customer}: no company linked` : '')}">${esc(i.customer)}</span>`;
    }

    /** The project, which opens its sheet; what the invoice says it is for in the tooltip. */
    function invoiceProject(i) {
        const what = i.subject ? `On the invoice: ${i.subject}` : '';
        const link = `<button type="button" class="fin-icon-btn fin-inv-linkbtn${i.project ? '' : ' is-empty'}" data-fin-inv-link="${esc(i.number)}"
            data-fin-focus="link-${esc(i.number)}" aria-expanded="${state.invLink === i.number}"
            title="Link to a project and company" aria-label="Link ${esc(i.number)} to a project">${ICON_LINK}</button>`;
        const name = i.project
            ? `<a href="#" class="fin-inv-link" data-crm-action="open-project-overview" data-project-id="${i.project.id}" title="${esc(what)}">${esc(i.project.name)}</a>`
            : `<span class="fin-inv-plain fin-muted" title="${esc(what)}">${esc(i.subject || '—')}</span>`;
        return `<span class="fin-inv-project">${name}${link}</span>`;
    }

    /** Under an invoice: link it to a project and a company by hand. */
    function invoiceLinkRow(i) {
        const link = ((state.overview.invoice_links || {})[i.number]) || {};
        const pick = v => (v === null || v === undefined ? '' : String(v));
        const auto = (found, what) => `Automatic${found ? `: ${found}` : `, none found`}`;
        // What the match finds on its own, without the hand-made link.
        const found = IL.attach([Object.assign({}, i, { company: null, project: null })], {
            companies: state.companies, projects: state.projects, links: {}
        })[0];
        const companyId = link.company_id || (i.company && i.company.id) || null;
        const own = state.projects.filter(p => (p.companies || []).some(c => Number(c.id) === Number(companyId)));
        const other = state.projects.filter(p => own.indexOf(p) < 0);
        const option = (value, label, current) => `<option value="${esc(value)}"${String(value) === current ? ' selected' : ''}>${esc(label)}</option>`;
        const projectOptions = list => list.map(p => option(p.id, p.name + (p.stage === 'Complete' ? '' : ` (${p.stage})`), pick(link.project_id))).join('');
        return `
            <tr class="fin-inv-linkrow"><td colspan="12">
                <div class="fin-inv-linkform" data-fin-inv-linkform="${esc(i.number)}">
                    ${i.subject ? `<p class="fin-inv-linkwhat">${esc(i.customer)}: ${esc(i.subject)}</p>` : ''}
                    <label class="fin-field">
                        <span>Company</span>
                        <select class="form-select" name="company_id" data-fin-focus="link-company">
                            ${option('', auto(found.company && found.company.name), pick(link.company_id))}
                            ${option('0', 'None', pick(link.company_id))}
                            ${state.companies.map(c => option(c.id, c.name, pick(link.company_id))).join('')}
                        </select>
                    </label>
                    <label class="fin-field">
                        <span>Project</span>
                        <select class="form-select" name="project_id">
                            ${option('', auto(found.project && found.project.name), pick(link.project_id))}
                            ${option('0', 'None', pick(link.project_id))}
                            ${own.length ? `<optgroup label="${esc(i.company ? i.company.name : 'This company')}">${projectOptions(own)}</optgroup>` : ''}
                            <optgroup label="${own.length ? 'Other projects' : 'Projects'}">${projectOptions(other)}</optgroup>
                        </select>
                    </label>
                    <div class="fin-form-actions">
                        ${i.archived ? `<button type="button" class="fin-link is-danger" data-fin-archive-delete="${i.archiveId}" title="Take this invoice out of the list">Remove</button>` : ''}
                        <button type="button" class="btn btn-secondary btn-small" data-fin-inv-link-cancel>Cancel</button>
                        <button type="button" class="btn btn-primary btn-small" data-fin-inv-link-save="${esc(i.number)}"${state.invBusy ? ' disabled' : ''}>Save</button>
                    </div>
                </div>
            </td></tr>`;
    }

    function invoiceRow(i) {
        const money = n => (n === null ? '<span class="fin-muted">—</span>' : esc((n < 0 ? MINUS : '') + cents(Math.abs(n))));
        const day = iso => (iso ? esc(window.CRMFormat.date(iso)) : '<span class="fin-muted">—</span>');
        const unpaid = i.outstanding > 0.005;
        const reading = state.invReading.has(i.id);
        return `
            <tr class="fin-inv${i.credit ? ' is-credit' : ''}${i.overdue || (i.reminded && unpaid) ? ' is-overdue' : ''}${state.invLink === i.number ? ' is-linking' : ''}">
                <th scope="row">
                    ${i.archived
                        ? `<span class="fin-inv-num" title="From the invoice list: no PDF, not in Bookkeeping">${esc(i.number)}</span>`
                        : `<button type="button" class="fin-inv-open" data-fin-inv-open="${i.id}" data-fin-focus="inv-${i.id}" title="Open the invoice">${esc(i.number)}</button>`}
                </th>
                <td>${day(i.date)}</td>
                <td>${reading ? '<span class="bk-reading-spinner" aria-label="Claude is reading"></span>' : day(i.due)}</td>
                <td class="fin-inv-state">${invoiceStatus(i)}</td>
                <td>${i.paid ? day(i.paid.date) : ''}</td>
                <td class="fin-inv-text">${invoiceCustomer(i)}</td>
                <td class="fin-inv-text">${esc(i.contact)}</td>
                <td class="fin-inv-text is-wide">${invoiceProject(i)}</td>
                <td>${money(i.net)}</td>
                <td>${money(i.vat)}</td>
                <td><strong>${money(i.gross)}</strong></td>
                <td class="fin-inv-act">${unpaid ? `<button type="button" class="fin-icon-btn${i.reminded ? ' is-on' : ''}" data-fin-inv-remind="${esc(i.number)}" data-fin-focus="remind-${i.id}"
                    aria-pressed="${!!i.reminded}" title="${i.reminded ? `Reminder sent ${esc(fullDay(i.reminded))}. Click to take it back` : 'Reminder sent today'}"
                    aria-label="${i.reminded ? 'Take back the reminder' : 'Reminder sent today'}">${ICON_BELL}</button>` : ''}</td>
            </tr>${state.invLink === i.number ? invoiceLinkRow(i) : ''}`;
    }

    /** Adding our invoices from before Bookkeeping: rows pasted from the invoice list. */
    function invoiceImportPanel() {
        const imp = state.invImport;
        const parsed = IL.parseListRows(imp.text);
        const known = new Set(state.invoices.filter(i => !i.archived).map(i => i.number));
        const inBookkeeping = parsed.rows.filter(r => known.has(r.invoice_number)).length;
        const fresh = parsed.rows.length - inBookkeeping;
        const note = parsed.rows.length
            ? `${plural(fresh, 'invoice')} to add${inBookkeeping ? `, ${inBookkeeping} already in Bookkeeping (skipped)` : ''}`
            : '';
        return `
            <div class="fin-balance-form fin-inv-import">
                <textarea class="form-input" rows="5" data-fin-inv-import-text data-fin-focus="inv-import-text" spellcheck="false"
                    placeholder="Rows from the invoice list: number, date, due, status, paid on, customer, contact, subject, net, VAT, gross">${esc(imp.text)}</textarea>
                <p class="fin-hint">For the list and the customer figures only: not in Bookkeeping, VAT or cashflow. A number already here is replaced.</p>
                <div data-fin-inv-import-live>
                    <p class="fin-inv-import-note">${esc(note)}</p>
                    ${parsed.errors.length ? `<p class="fin-form-error">${parsed.errors.map(esc).join('<br>')}</p>` : ''}
                    ${state.invError ? `<p class="fin-form-error">${esc(state.invError)}</p>` : ''}
                    <div class="fin-form-actions">
                        <button type="button" class="btn btn-secondary btn-small" data-fin-inv-import-cancel>Cancel</button>
                        <button type="button" class="btn btn-primary btn-small" data-fin-inv-import-save${fresh && !state.invBusy ? '' : ' disabled'}>Add</button>
                    </div>
                </div>
            </div>`;
    }

    async function importInvoices() {
        const parsed = IL.parseListRows(state.invImport ? state.invImport.text : '');
        const known = new Set(state.invoices.filter(i => !i.archived).map(i => i.number));
        const rows = parsed.rows.filter(r => !known.has(r.invoice_number));
        if (!rows.length) return;
        state.invBusy = true;
        state.invError = '';
        renderInvoices();
        try {
            const result = await post('archive-invoices', { rows });
            state.overview = result.data;
            state.invImport = null;
            const years = rows.map(r => IL.parseNumber(r.invoice_number)).filter(Boolean).map(x => x.year);
            if (years.length) state.invYear = Math.max.apply(null, years);
            compute();
            render();
            if (window.CRMCompany) window.CRMCompany.refresh();
        } catch (error) {
            state.invError = error.message;
        } finally {
            state.invBusy = false;
            renderInvoices();
        }
    }

    async function saveInvoiceLink(number) {
        const form = els.finInvoices.querySelector(`[data-fin-inv-linkform="${CSS.escape(number)}"]`);
        if (!form) return;
        const read = name => {
            const v = form.querySelector(`[name="${name}"]`).value;
            return v === '' ? null : Number(v);
        };
        state.invBusy = true;
        state.invError = '';
        try {
            const result = await post('link-invoice', { number, company_id: read('company_id'), project_id: read('project_id') });
            state.overview = result.data;
            state.invLink = null;
            state.invoices = buildInvoices();
        } catch (error) {
            state.invError = error.message;
        } finally {
            state.invBusy = false;
            renderInvoices();
            const again = els.finInvoices.querySelector(`[data-fin-focus="link-${CSS.escape(number)}"]`);
            if (again) again.focus();
        }
    }

    async function deleteArchived(id) {
        if (!(await window.CRMDialog.confirm('Take this invoice out of the list?', { confirm: 'Remove', danger: true }))) return;
        try {
            const result = await post('delete-archived', { id });
            state.overview = result.data;
            state.invLink = null;
            state.invoices = buildInvoices();
        } catch (error) {
            state.invError = error.message;
        }
        renderInvoices();
    }

    function renderInvoices() {
        if (!els.finInvoices) return;
        const all = state.invoices;
        const years = IL.years(all);
        if (!years.length && !state.invImport) {
            Card.setInvoiced(0);
            // No invoices yet: only the way to add some from the invoice list.
            els.finInvoices.hidden = false;
            els.finInvoices.innerHTML = `
                <div class="fin-card-head">
                    <h2 class="fin-card-title">Invoices</h2>
                    <button type="button" class="fin-icon-btn" data-fin-inv-import data-fin-focus="inv-import" aria-expanded="false"
                        title="Add invoices from the invoice list" aria-label="Add invoices from the invoice list">${ICON_PASTE}</button>
                </div>`;
            return;
        }
        els.finInvoices.hidden = false;
        if (!years.length) years.push(new Date().getFullYear());
        const year = years.indexOf(state.invYear) >= 0 ? state.invYear : years[0];
        // Folded: every invoice still to be paid, whatever its year - an
        // unpaid one of last year must not vanish with the first of the new
        // one. Unfolded: the chosen year, paid ones too.
        const open = state.folds.invoices;
        const unpaid = all.filter(i => i.outstanding > 0.005);
        const items = open ? all.filter(i => i.year === year) : unpaid;
        const sum = IL.summary(items);
        const shown = items;
        const settled = all.length - unpaid.length;
        const gaps = IL.gaps(all, year);
        const bankUntil = state.tx.invoices && state.tx.invoices.bankUntil;

        const head = [];
        // Net, like the projects' amounts; what is owed counts all years.
        const owed = IL.summary(unpaid);
        // The same sum under the revenue forecast's total.
        Card.setInvoiced(owed.open.amount);
        // Rounded like every figure above the table; the table itself has the cents.
        if (owed.open.amount > 0.005) head.push(`<strong>${esc(euro(owed.open.amount))}</strong> open`);
        if (owed.overdue.amount > 0.005) head.push(`<strong class="is-neg">${esc(euro(owed.overdue.amount))}</strong> overdue`);

        els.finInvoices.innerHTML = `
            <div class="fin-card-head">
                <div>
                    <h2 class="fin-card-title">Invoices</h2>
                    ${head.length ? `<p class="fin-card-sub fin-inv-sums" title="Net${bankUntil ? `, payments booked until ${esc(fullDay(bankUntil))}` : ''}">${head.join(', ')}</p>` : ''}
                </div>
                <div class="fin-inv-tools">
                    ${open && years.length > 1 ? segmented('inv-year', 'Year', years.map(y => ({ key: y, label: String(y) })), year) : ''}
                    <button type="button" class="fin-icon-btn" data-fin-inv-import data-fin-focus="inv-import" aria-expanded="${!!state.invImport}"
                        title="Add invoices from the invoice list" aria-label="Add invoices from the invoice list">${ICON_PASTE}</button>
                </div>
            </div>
            ${state.invImport ? invoiceImportPanel() : ''}
            ${gaps.length ? `<p class="fin-alert is-warn fin-inv-gap">${ICON.warn}<span>Numbers missing: ${esc(gaps.join(', '))}</span></p>` : ''}
            ${state.invError ? `<p class="fin-alert is-danger fin-inv-gap">${ICON.warn}<span>${esc(state.invError)}</span></p>` : ''}
            <div class="fin-table-scroll">
                <table class="fin-table fin-inv-table">
                    <thead><tr>
                        <th scope="col">No.</th><th scope="col">Date</th><th scope="col">Due</th><th scope="col">Status</th>
                        <th scope="col" title="The day the payment reached the bank">Paid</th>
                        <th scope="col">Customer</th><th scope="col">Contact</th><th scope="col">Project</th>
                        <th scope="col">Net</th><th scope="col">VAT</th><th scope="col">Gross</th><th scope="col"><span class="sr-only">Reminder</span></th>
                    </tr></thead>
                    <tbody>${shown.map(invoiceRow).join('')}${shown.length ? '' : `
                        <tr class="fin-inv-none"><td colspan="12">${open || !all.length ? 'No invoices yet' : 'All paid'}</td></tr>`}</tbody>
                    <tfoot><tr>
                        <th scope="row" colspan="8">${esc(plural(sum.count, 'invoice'))}</th>
                        <td>${esc(cents(sum.net))}</td><td>${esc(cents(sum.vat))}</td><td><strong>${esc(cents(sum.gross))}</strong></td><td></td>
                    </tr></tfoot>
                </table>
            </div>
            ${settled > 0 ? `<button type="button" class="fin-kpi-toggle fin-inv-toggle" data-fin-fold="invoices" data-fin-focus="fold-invoices" aria-expanded="${open}">
                ${open ? 'Only open ones' : `All of ${year}`}${ICON.chevron}
            </button>` : ''}`;
    }

    async function toggleReminder(number) {
        const item = state.invoices.find(i => i.number === number);
        if (!item) return;
        state.invError = '';
        try {
            const result = await post('save-settings', { invoice_reminder: { number, day: item.reminded ? null : todayIso() } });
            state.overview = result.data;
            compute();
            render();
        } catch (error) {
            state.invError = error.message;
            renderInvoices();
        }
    }

    /**
     * Our invoices Claude read before it also took the contact and the due
     * date from the payment terms ("zahlbar binnen 14 Tagen"): read once
     * more, two at a time, the card filling in as they come back.
     */
    /**
     * What our invoices say about a company - its name as on the invoice,
     * its address and VAT ID where it has none - written into the company
     * (IL.companyDetails says when). Each company tried once per visit.
     */
    const detailsTried = new Set();
    async function fillCompanyDetails() {
        if (!window.CRMCompany || !state.loaded) return;
        const changes = IL.companyDetails(state.invoices, state.companies).filter(c => !detailsTried.has(c.id));
        if (!changes.length) return;
        for (const change of changes) {
            detailsTried.add(change.id);
            const body = {};
            ['name', 'invoice_name', 'address', 'vat_id'].forEach(k => { if (change[k]) body[k] = change[k]; });
            try {
                await fetch(`api/companies.php?id=${change.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
                    body: JSON.stringify(body)
                });
            } catch (e) { /* tried again on the next visit */ }
        }
        await window.CRMCompany.refresh();
    }

    async function readOldInvoices() {
        const info = state.tx.invoices;
        if (state.invReadTried || !info || !info.reader) return;
        const ids = IL.needsReading(info);
        if (!ids.length) return;
        state.invReadTried = true;
        ids.forEach(id => state.invReading.add(id));
        renderInvoices();

        const readOne = async id => {
            try {
                const response = await fetch('api/bookkeeping.php?action=read-invoice', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
                    body: JSON.stringify({ id, again: true })
                });
                const result = await response.json();
                if (response.ok && result.invoice) {
                    info.files.forEach(f => { if (f.id === id) f.invoice = result.invoice; });
                }
            } catch (e) { /* stays as it was; tried again on the next visit */ }
            state.invReading.delete(id);
            if (!state.loaded) return;
            state.invoices = buildInvoices();
            renderInvoices();
        };
        const queue = ids.slice();
        const worker = async () => { while (queue.length) await readOne(queue.shift()); };
        await Promise.all([worker(), worker()]);
    }

    function renderDebts() {
        if (!els.finDebts) return;
        const debts = state.overview.debts || [];
        const today = todayIso();
        const sum = CF.debtSummary(debts, today);
        const draft = state.debtDraft;

        const rows = sum.list.map(d => {
            if (draft && draft.id === d.id) return `<li>${debtForm(draft)}</li>`;
            const i = d.interest;
            const when = fullDay(d.start_date) + (d.end_date ? ' – ' + fullDay(d.end_date) : '');
            return `
                <li>
                    <button type="button" class="fin-debt${i.repaid ? ' is-repaid' : ''}" data-fin-debt-edit="${d.id}" data-fin-focus="debt-${d.id}">
                        <span class="fin-debt-main">
                            <span class="fin-debt-name">${esc(d.name)}${i.repaid ? '<span class="fin-tag">repaid</span>' : ''}</span>
                            <span class="fin-debt-meta">${esc(when)}</span>
                        </span>
                        <span class="fin-debt-figures">
                            <strong>${esc(euro(d.amount))}</strong>
                            <span>${i.started ? `${esc(signed(-i.toDate))} interest so far` : 'not started yet'}</span>
                        </span>
                    </button>
                </li>`;
        }).join('');

        const stats = sum.count ? `
            <dl class="fin-debt-stats">
                <div><dt>Owed</dt><dd>${esc(euro(sum.outstanding))}</dd></div>
                <div title="Amount × rate p.a. × days / 365, until today"><dt>Interest so far</dt><dd class="is-neg">${esc(signed(-sum.interestToDate))}</dd></div>
            </dl>` : '';

        els.finDebts.innerHTML = `
            <div class="fin-card-head">
                <h2 class="fin-card-title">Debts</h2>
                <button type="button" class="ov-add-btn" data-fin-debt-add data-fin-focus="debt-add">${ICON.plus}Add debt</button>
            </div>
            ${draft && draft.id === null ? debtForm(draft) : ''}
            ${stats}
            ${rows ? `<ul class="fin-debt-list">${rows}</ul>` : (draft ? '' : '<p class="fin-muted fin-panel-empty">No debts entered.</p>')}`;
    }

    /** The interest a draft would run up, worked out as it is typed. */
    function debtPreview(d) {
        const amount = readAmount(d.amount);
        const rate = d.rate === '' ? 0 : readAmount(d.rate);
        if (amount === null || Number.isNaN(amount) || amount <= 0 || Number.isNaN(rate) || !d.start_date) {
            return '<p class="fin-hint">Enter the amount, rate and start date to see the interest.</p>';
        }
        const i = CF.debtInterest({ amount, rate, start_date: d.start_date, end_date: d.end_date || null }, todayIso());
        const parts = [
            `<div><dt>Per day</dt><dd>${esc(cents(i.daily))}</dd></div>`,
            `<div><dt>So far · ${esc(plural(i.days, 'day'))}</dt><dd>${esc(cents(i.toDate))}</dd></div>`,
            i.total !== null
                ? `<div><dt>By repayment${i.daysLeft ? ' · ' + esc(plural(i.daysLeft, 'day')) + ' left' : ''}</dt><dd>${esc(cents(i.total))}</dd></div>`
                : '<div><dt>By repayment</dt><dd class="fin-muted">no date set</dd></div>'
        ];
        return `<dl class="fin-debt-preview" data-fin-debt-preview>${parts.join('')}</dl>`;
    }

    function debtForm(d) {
        return `
            <form class="fin-cost-form fin-debt-form" data-fin-debt-form aria-label="${d.id ? 'Edit debt' : 'New debt'}">
                <p class="fin-form-title">${d.id ? 'Debt' : 'New debt'}</p>
                <div class="fin-field-grid">
                    <label class="fin-field is-wide"><span>Name</span>
                        <input type="text" class="form-input" name="name" value="${esc(d.name)}" maxlength="255" required placeholder="e.g. Bank loan, shareholder loan" data-fin-focus="debt-name"></label>
                    <label class="fin-field is-wide"><span>Owed to</span>
                        <input type="text" class="form-input" name="lender" value="${esc(d.lender || '')}" maxlength="255" placeholder="Who lent us the money, e.g. Erste Bank"></label>
                    <label class="fin-field"><span>Amount</span>
                        <span class="fin-amount"><input type="text" class="form-input" name="amount" value="${esc(d.amount)}" required data-amount inputmode="decimal" autocomplete="off" placeholder="0"><span aria-hidden="true">€</span></span></label>
                    <label class="fin-field"><span>Interest rate p.a.</span>
                        <span class="fin-amount"><input type="text" class="form-input" name="rate" value="${esc(d.rate)}" inputmode="decimal" autocomplete="off" placeholder="0"><span aria-hidden="true">%</span></span></label>
                    <label class="fin-field"><span>Start date</span>
                        <input type="date" class="form-input" name="start_date" value="${esc(d.start_date)}" required></label>
                    <label class="fin-field"><span>Repayment date <em class="fin-optional">optional</em></span>
                        <input type="date" class="form-input" name="end_date" value="${esc(d.end_date || '')}"></label>
                    <label class="fin-field is-wide"><span>Note <em class="fin-optional">optional</em></span>
                        <textarea class="form-input" name="note" rows="2" maxlength="2000" placeholder="Terms, contract number, …">${esc(d.note || '')}</textarea></label>
                </div>
                <div data-fin-debt-preview-wrap>${debtPreview(d)}</div>
                ${state.debtError ? `<p class="fin-form-error">${esc(state.debtError)}</p>` : ''}
                <div class="fin-form-actions">
                    ${d.id ? `<button type="button" class="btn btn-secondary btn-small fin-delete" data-fin-debt-delete="${d.id}">${ICON.trash}Delete</button>` : ''}
                    <span class="fin-spacer"></span>
                    <button type="button" class="btn btn-secondary btn-small" data-fin-debt-cancel>Cancel</button>
                    <button type="submit" class="btn btn-primary btn-small">${d.id ? 'Save' : 'Add debt'}</button>
                </div>
            </form>`;
    }

    function readDebtForm(form) {
        const f = new FormData(form);
        const d = Object.assign({}, state.debtDraft);
        ['name', 'lender', 'amount', 'rate', 'start_date', 'end_date', 'note'].forEach(k => {
            if (f.has(k)) d[k] = f.get(k);
        });
        return d;
    }

    async function saveDebt(form) {
        const d = readDebtForm(form);
        state.debtDraft = d;
        const amount = readAmount(d.amount);
        const rate = String(d.rate).trim() === '' ? 0 : readAmount(d.rate);
        const fail = (message, field) => {
            state.debtError = message;
            renderDebts();
            const el = els.finDebts.querySelector(`[data-fin-debt-form] [name="${field}"]`);
            if (el) el.focus();
        };
        if (amount === null || Number.isNaN(amount) || amount <= 0) return fail('Enter an amount above 0, e.g. 50.000', 'amount');
        if (rate === null || Number.isNaN(rate) || rate < 0) return fail('Enter the interest rate per year, e.g. 4,5', 'rate');
        try {
            const result = await post('save-debt', {
                id: d.id, name: d.name, lender: d.lender, amount, rate,
                start_date: d.start_date, end_date: d.end_date || null, note: d.note
            });
            state.overview = result.data;
            state.debtDraft = null;
            state.debtError = '';
            renderDebts();
            const saved = els.finDebts.querySelector(`[data-fin-debt-edit="${result.id}"]`);
            if (saved) saved.focus();
        } catch (error) {
            fail(error.message, 'name');
        }
    }

    async function deleteDebt(id) {
        if (!(await CRMDialog.confirm('Delete this debt?', { confirm: 'Delete', danger: true }))) return;
        try {
            const result = await post('delete-debt', { id });
            state.overview = result.data;
            state.debtDraft = null;
            state.debtError = '';
            renderDebts();
        } catch (error) {
            state.debtError = error.message;
            renderDebts();
        }
    }

    // ---- Costs ----

    function rhythm(c) {
        const iv = INTERVALS.find(x => x.value === Number(c.interval_months)) || INTERVALS[0];
        const day = Number(c.day);
        return iv.short + (day >= 31 ? ' at month end' : day > 1 ? ` on the ${ordinal(day)}` : '');
    }

    function monthLabelOf(key) {
        return key ? PP.monthName(key) : '';
    }

    /** Planned costs from this month on, soonest first. */
    function upcomingPlanned() {
        const current = monthKey(0, RF.monthOf(new Date()));
        return state.overview.costs.filter(c => c.kind === 'once' && c.start_month >= current)
            .sort((a, b) => (a.start_month < b.start_month ? -1 : a.start_month > b.start_month ? 1 : 0));
    }

    /**
     * Loan repayments in the months planned - principal and interest at the
     * repayment date - as planned costs: [{ debt, offset, amount }].
     */
    function repaymentsAhead() {
        const out = [];
        (state.plan ? state.plan.rows : []).forEach(r => (r.items.debts || []).forEach(x => {
            out.push({ debt: x.debt, offset: r.offset, label: r.label, amount: x.amount, interest: x.interest });
        }));
        return out;
    }

    /** A repayment among the planned costs: opens the loan in Debts. */
    function repaymentRow(x) {
        return `
            <li>
                <button type="button" class="fin-cost" data-fin-debt-edit="${x.debt.id}" title="From Debts - edit it there">
                    <span class="fin-cost-main">
                        <span class="fin-cost-name">${esc(x.debt.name)}<span class="fin-chip">Repayment</span></span>
                        <span class="fin-cost-meta">${esc(x.label)} · incl. ${esc(euro(x.interest))} interest</span>
                    </span>
                    <span class="fin-cost-amount"><strong>${esc(euro(x.amount))}</strong></span>
                </button>
            </li>`;
    }

    function costRow(c) {
        const current = monthKey(0, RF.monthOf(new Date()));
        const once = c.kind === 'once';
        const ended = !once && c.end_month && c.end_month < current;
        const meta = once
            ? monthLabelOf(c.start_month)
            : `${rhythm(c)} · ${monthLabelOf(c.start_month)}${c.end_month ? ' – ' + monthLabelOf(c.end_month) : ' onwards'}${ended ? ' · ended' : ''}`;
        return `
            <li>
                <button type="button" class="fin-cost${ended ? ' is-ended' : ''}" data-fin-edit="${c.id}" data-fin-focus="cost-${c.id}">
                    <span class="fin-cost-main">
                        <span class="fin-cost-name">${esc(c.name)}${c.category ? `<span class="fin-chip">${esc(c.category)}</span>` : ''}</span>
                        <span class="fin-cost-meta">${esc(meta)}</span>
                    </span>
                    <span class="fin-cost-amount"><strong>${esc(euro(c.amount))}</strong>${!once && Number(c.interval_months) > 1 ? `<span>≈ ${esc(euro(c.amount / c.interval_months))} / month</span>` : ''}</span>
                </button>
            </li>`;
    }

    const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
    const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

    /**
     * A recurring payment from Bookkeeping, to take on as a fixed cost or
     * turn down - with the same round reject / accept buttons as Claude's
     * proposals (review.css), though no Claude is involved.
     */
    function suggestionRow(s) {
        const iv = INTERVALS.find(x => x.value === s.interval) || INTERVALS[0];
        return `
            <li class="fin-suggestion">
                <button type="button" class="fin-cost" data-fin-suggest-edit="${esc(s.key)}" data-fin-focus="suggest-${esc(s.key)}"
                    title="Adjust it before adding">
                    <span class="fin-cost-main">
                        <span class="fin-cost-name">${esc(s.name)}</span>
                        <span class="fin-cost-meta">${esc(iv.short)} ${s.day >= 31 ? 'at month end' : `on the ${esc(ordinal(s.day))}`} · paid ${s.count}× since ${esc(dayName(s.first))}</span>
                    </span>
                    <span class="fin-cost-amount"><strong>${esc(euro(s.amount))}</strong><span>${s.net ? 'excl. VAT' : 'as paid'}</span></span>
                </button>
                <span class="review-inline">
                    <button type="button" class="review-inline-btn review-inline-btn--reject" data-fin-dismiss="${esc(s.key)}" title="Not a fixed cost" aria-label="Turn down ${esc(s.name)}">${ICON_X}</button>
                    <button type="button" class="review-inline-btn review-inline-btn--accept" data-fin-accept="${esc(s.key)}" title="Add as a fixed cost" aria-label="Add ${esc(s.name)} as a fixed cost">${ICON_CHECK}</button>
                </span>
            </li>`;
    }

    function costsPanel() {
        return `<div class="fin-kpi-panel">${fixedSection()}${plannedSection()}</div>`;
    }

    function fixedSection() {
        const fixed = state.overview.costs.filter(c => c.kind !== 'once');
        const draft = state.draft && state.draft.kind !== 'once' ? state.draft : null;
        return `
                ${state.suggestions.length ? `
                <section class="fin-group">
                    <h3 class="fin-group-title"><span>${ICON.repeat} Suggested from Bookkeeping</span></h3>
                    <ul class="fin-cost-list">${state.suggestions.map(suggestionRow).join('')}</ul>
                </section>` : ''}
                <section class="fin-group">
                    <h3 class="fin-group-title"><span>Fixed costs</span>
                        <button type="button" class="ov-add-btn" data-fin-add="recurring" data-fin-focus="add-recurring">${ICON.plus}Add</button></h3>
                    ${draft ? costForm(draft) : ''}
                    ${fixed.length ? `<ul class="fin-cost-list">${fixed.map(costRow).join('')}</ul>`
                        : (draft ? '' : '<p class="fin-muted fin-panel-empty">No fixed costs yet.</p>')}
                </section>`;
    }

    function plannedSection() {
        const current = monthKey(0, RF.monthOf(new Date()));
        const upcoming = upcomingPlanned();
        const repayments = repaymentsAhead();
        const past = state.overview.costs.filter(c => c.kind === 'once' && c.start_month < current);
        const draft = state.draft && state.draft.kind === 'once' ? state.draft : null;
        return `
                <section class="fin-group">
                    <h3 class="fin-group-title"><span>Planned costs</span>
                        <button type="button" class="ov-add-btn" data-fin-add="once" data-fin-focus="add-once">${ICON.plus}Add</button></h3>
                    ${draft ? costForm(draft) : ''}
                    ${upcoming.length || repayments.length ? `<ul class="fin-cost-list">${upcoming.map(costRow).join('')}${repayments.map(repaymentRow).join('')}</ul>`
                        : (draft ? '' : '<p class="fin-muted fin-panel-empty">Nothing planned.</p>')}
                    ${past.length ? `<button type="button" class="fin-link" data-fin-past>${state.showPastPlanned ? 'Hide' : 'Show'} ${esc(plural(past.length, 'past planned cost'))}</button>
                        ${state.showPastPlanned ? `<ul class="fin-cost-list is-past">${past.map(costRow).join('')}</ul>` : ''}` : ''}
                </section>`;
    }

    /** The day of the month a fixed cost is paid: the 1st to the 30th, or the last day (31). */
    function dayOptions(selected) {
        const out = [];
        for (let day = 1; day <= 30; day++) {
            out.push(`<option value="${day}"${day === selected ? ' selected' : ''}>the ${ordinal(day)}</option>`);
        }
        out.push(`<option value="31"${selected >= 31 ? ' selected' : ''}>the last day</option>`);
        return out.join('');
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
                    <label class="fin-field"><span>Paid on</span>
                        <select class="form-select" name="day">${dayOptions(Number(d.day) || 1)}</select></label>
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
            renderKpis();
            const field = els.finKpis.querySelector('[data-fin-cost-form] [name="amount"]');
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
            const saved = els.finKpis.querySelector(`[data-fin-edit="${result.id}"]`);
            if (saved) saved.focus();
        } catch (error) {
            state.draftError = error.message;
            renderKpis();
            const name = els.finKpis.querySelector('[data-fin-focus="draft-name"]');
            if (name && !d.name) name.focus();
        }
    }

    async function deleteCost(id) {
        if (!(await CRMDialog.confirm('Delete this cost?', { confirm: 'Delete', danger: true }))) return;
        try {
            const result = await post('delete-cost', { id });
            state.overview = result.data;
            state.draft = null;
            compute();
            render();
        } catch (error) {
            state.draftError = error.message;
            renderKpis();
        }
    }

    /** Take a recurring payment on as a fixed cost, as it was spotted. */
    async function acceptSuggestion(key) {
        const sug = state.suggestions.find(x => x.key === key);
        if (!sug) return;
        try {
            const result = await post('save-cost', {
                id: null, name: sug.name, category: '', amount: sug.amount,
                kind: 'recurring', interval_months: sug.interval, day: sug.day,
                start_month: sug.start_month, end_month: null
            });
            state.overview = result.data;
            compute();
            render();
        } catch (error) {
            state.draftError = error.message;
            renderKpis();
        }
    }

    /** Not a fixed cost: it does not come back. */
    async function dismissSuggestion(key) {
        try {
            const result = await post('save-settings', { dismiss_recurring: key });
            state.overview = result.data;
            compute();
            renderKpis();
            const next = els.finKpis.querySelector('[data-fin-accept]') || els.finKpis.querySelector('[data-fin-focus="fixed"]');
            if (next) next.focus();
        } catch (error) {
            state.draftError = error.message;
            renderKpis();
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
        if (!(await CRMDialog.confirm('Delete this balance entry?', { confirm: 'Delete', danger: true }))) return;
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
            } else if (t.hasAttribute('data-fin-costs')) {
                // The suggestions open the card too, and stay at its top.
                state.costsOpen = !state.costsOpen || t.classList.contains('fin-suggest-pill');
                if (!state.costsOpen) state.draft = null;
                renderKpis();
                const again = els.finKpis.querySelector('[data-fin-focus="costs"]');
                if (again) again.focus();
            } else if (t.hasAttribute('data-fin-accept')) {
                acceptSuggestion(t.getAttribute('data-fin-accept'));
            } else if (t.hasAttribute('data-fin-dismiss')) {
                dismissSuggestion(t.getAttribute('data-fin-dismiss'));
            } else if (t.hasAttribute('data-fin-suggest-edit')) {
                const sug = state.suggestions.find(x => x.key === t.getAttribute('data-fin-suggest-edit'));
                if (!sug) return;
                state.draft = Object.assign(newDraft('recurring'), {
                    name: sug.name, amount: showAmount(sug.amount), interval_months: sug.interval,
                    day: sug.day, start_month: sug.start_month
                });
                state.draftError = '';
                renderKpis();
                const name = els.finKpis.querySelector('[data-fin-focus="draft-name"]');
                if (name) name.focus();
            } else if (t.hasAttribute('data-fin-months')) {
                const value = t.getAttribute('data-fin-months');
                state.horizon = value === 'year' ? 'year' : Number(value);
                state.months = monthsFor(state.horizon);
                try { localStorage.setItem(HORIZON_KEY, String(state.horizon)); } catch (err) { /* fine */ }
                Card.setMonths(state.months, periodText());
                compute();
                render();
            } else if (t.hasAttribute('data-fin-balance')) {
                state.balanceOpen = !state.balanceOpen;
                state.balanceError = '';
                renderKpis();
                const field = els.financialsView.querySelector('[data-fin-focus="balance-amount"]');
                if (field) { field.focus(); field.select(); }
            } else if (t.hasAttribute('data-fin-balance-cancel')) {
                // The balance form is the details' last part: Cancel folds them.
                state.folds.liquidity = false;
                state.bufferOpen = false;
                try { localStorage.setItem(FOLD_KEY + 'liquidity', '0'); } catch (err) { /* this visit only */ }
                renderKpis();
                const btn = els.finKpis.querySelector('[data-fin-fold="liquidity"]');
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
            } else if (t.hasAttribute('data-fin-vat')) {
                state.vatOpen = !state.vatOpen;
                state.vatError = '';
                renderKpis();
                const again = els.finKpis.querySelector('[data-fin-focus="vat"]');
                if (again) again.focus();
            } else if (t.hasAttribute('data-fin-vat-link')) {
                saveVat({ vat_link: { quarter: t.getAttribute('data-fin-vat-link'), row_id: Number(t.getAttribute('data-row')) } });
            } else if (t.hasAttribute('data-fin-vat-unlink')) {
                const row = t.getAttribute('data-row');
                saveVat({ vat_unlink: { quarter: t.getAttribute('data-fin-vat-unlink'), row_id: row ? Number(row) : null } });
            } else if (t.hasAttribute('data-fin-vat-settle')) {
                saveVat({ vat_settle: { quarter: t.getAttribute('data-fin-vat-settle') } });
            } else if (t.hasAttribute('data-fin-balance-delete')) {
                deleteBalance(Number(t.getAttribute('data-fin-balance-delete')));
            } else if (t.hasAttribute('data-fin-fold')) {
                const key = t.getAttribute('data-fin-fold');
                state.folds[key] = !state.folds[key];
                if (key === 'liquidity' && !state.folds[key]) state.bufferOpen = false;
                try { localStorage.setItem(FOLD_KEY + key, state.folds[key] ? '1' : '0'); } catch (e) { /* this visit only */ }
                const months = key === 'past' || key === 'lastYear';
                const host = months ? els.finMonths : key === 'invoices' ? els.finInvoices : els.finKpis;
                if (months) renderMonths(); else if (key === 'invoices') renderInvoices(); else renderKpis();
                const again = host.querySelector(`[data-fin-fold="${key}"]`);
                if (again) again.focus();
            } else if (t.hasAttribute('data-fin-scenario-jump')) {
                if (els.finScenario) {
                    els.finScenario.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const first = els.finScenario.querySelector('button, select, input');
                    if (first) first.focus({ preventScroll: true });
                }
            } else if (t.hasAttribute('data-fin-inv-year')) {
                state.invYear = Number(t.getAttribute('data-fin-inv-year'));
                renderInvoices();
                const again = els.finInvoices.querySelector(`[data-fin-inv-year="${state.invYear}"]`);
                if (again) again.focus();
            } else if (t.hasAttribute('data-fin-inv-open')) {
                const item = state.invoices.find(i => i.id === Number(t.getAttribute('data-fin-inv-open')));
                if (item && window.Bookkeeping) window.Bookkeeping.preview(`api/bookkeeping.php?action=download-pdf&id=${item.id}`, item.file);
            } else if (t.hasAttribute('data-fin-inv-link')) {
                const number = t.getAttribute('data-fin-inv-link');
                state.invLink = state.invLink === number ? null : number;
                state.invError = '';
                renderInvoices();
                const first = els.finInvoices.querySelector(state.invLink ? '[data-fin-focus="link-company"]' : `[data-fin-focus="link-${CSS.escape(number)}"]`);
                if (first) first.focus();
            } else if (t.hasAttribute('data-fin-inv-link-cancel')) {
                const number = state.invLink;
                state.invLink = null;
                renderInvoices();
                const again = number && els.finInvoices.querySelector(`[data-fin-focus="link-${CSS.escape(number)}"]`);
                if (again) again.focus();
            } else if (t.hasAttribute('data-fin-inv-link-save')) {
                saveInvoiceLink(t.getAttribute('data-fin-inv-link-save'));
            } else if (t.hasAttribute('data-fin-archive-delete')) {
                deleteArchived(Number(t.getAttribute('data-fin-archive-delete')));
            } else if (t.hasAttribute('data-fin-inv-import')) {
                state.invImport = state.invImport ? null : { text: '' };
                state.invError = '';
                renderInvoices();
                const box = els.finInvoices.querySelector(state.invImport ? '[data-fin-inv-import-text]' : '[data-fin-inv-import]');
                if (box) box.focus();
            } else if (t.hasAttribute('data-fin-inv-import-cancel')) {
                state.invImport = null;
                state.invError = '';
                renderInvoices();
            } else if (t.hasAttribute('data-fin-inv-import-save')) {
                importInvoices();
            } else if (t.hasAttribute('data-fin-inv-remind')) {
                toggleReminder(t.getAttribute('data-fin-inv-remind'));
            } else if (t.hasAttribute('data-fin-month')) {
                const o = Number(t.getAttribute('data-fin-month'));
                if (state.openMonths.has(o)) state.openMonths.delete(o); else state.openMonths.add(o);
                renderMonths();
                const again = els.finMonths.querySelector(`[data-fin-month="${o}"]`);
                if (again) again.focus();
            } else if (t.hasAttribute('data-fin-add')) {
                state.draft = newDraft(t.getAttribute('data-fin-add'));
                state.costsOpen = true;
                state.draftError = '';
                renderKpis();
                const name = els.finKpis.querySelector('[data-fin-focus="draft-name"]');
                if (name) name.focus();
            } else if (t.hasAttribute('data-fin-edit')) {
                const cost = state.overview.costs.find(c => c.id === Number(t.getAttribute('data-fin-edit')));
                if (!cost) return;
                state.draft = Object.assign({}, cost, { end_month: cost.end_month || '', amount: showAmount(cost.amount) });
                state.draftError = '';
                renderKpis();
                const name = els.finKpis.querySelector('[data-fin-focus="draft-name"]');
                if (name) name.focus();
            } else if (t.hasAttribute('data-fin-cancel')) {
                const id = state.draft && state.draft.id;
                state.draft = null;
                state.draftError = '';
                renderKpis();
                const back = id ? els.finKpis.querySelector(`[data-fin-edit="${id}"]`) : null;
                if (back) back.focus();
            } else if (t.hasAttribute('data-fin-delete')) {
                deleteCost(Number(t.getAttribute('data-fin-delete')));
            } else if (t.hasAttribute('data-fin-past')) {
                state.showPastPlanned = !state.showPastPlanned;
                renderKpis();
            } else if (t.hasAttribute('data-fin-debt-add')) {
                state.debtDraft = { id: null, name: '', lender: '', amount: '', rate: '', start_date: todayIso(), end_date: '', note: '' };
                state.debtError = '';
                renderDebts();
                const name = els.finDebts.querySelector('[data-fin-focus="debt-name"]');
                if (name) name.focus();
            } else if (t.hasAttribute('data-fin-debt-edit')) {
                const debt = (state.overview.debts || []).find(d => d.id === Number(t.getAttribute('data-fin-debt-edit')));
                if (!debt) return;
                state.debtDraft = Object.assign({}, debt, {
                    amount: showAmount(debt.amount),
                    rate: String(debt.rate).replace('.', ','),
                    end_date: debt.end_date || '', lender: debt.lender || '', note: debt.note || ''
                });
                state.debtError = '';
                renderDebts();
                const name = els.finDebts.querySelector('[data-fin-focus="debt-name"]');
                if (name) name.focus();
            } else if (t.hasAttribute('data-fin-debt-cancel')) {
                const id = state.debtDraft && state.debtDraft.id;
                state.debtDraft = null;
                state.debtError = '';
                renderDebts();
                const back = els.finDebts.querySelector(id ? `[data-fin-debt-edit="${id}"]` : '[data-fin-debt-add]');
                if (back) back.focus();
            } else if (t.hasAttribute('data-fin-debt-delete')) {
                deleteDebt(Number(t.getAttribute('data-fin-debt-delete')));
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
            } else if (e.target.matches('[data-fin-debt-form]')) {
                e.preventDefault();
                saveDebt(e.target);
            }
        });

        // Keep what is typed in the cost form when the page redraws; a debt's
        // interest is worked out again as it is typed.
        const onDebtInput = e => {
            const debtForm = e.target.closest('[data-fin-debt-form]');
            if (debtForm && state.debtDraft) {
                state.debtDraft = readDebtForm(debtForm);
                const wrap = debtForm.querySelector('[data-fin-debt-preview-wrap]');
                if (wrap) wrap.innerHTML = debtPreview(state.debtDraft);
            }
        };
        view.addEventListener('input', e => {
            if (e.target.matches('[data-fin-inv-import-text]') && state.invImport) {
                state.invImport.text = e.target.value;
                // Everything under the text box, so typing is not interrupted.
                const live = e.target.closest('.fin-inv-import').querySelector('[data-fin-inv-import-live]');
                const fresh = document.createElement('div');
                fresh.innerHTML = invoiceImportPanel();
                live.innerHTML = fresh.querySelector('[data-fin-inv-import-live]').innerHTML;
                return;
            }
            const form = e.target.closest('[data-fin-cost-form]:not([data-fin-debt-form])');
            if (form && state.draft) state.draft = readCostForm(form);
            onDebtInput(e);
        });
        view.addEventListener('change', e => {
            onDebtInput(e);
            const pick = e.target.closest('[data-fin-vat-pick]');
            if (pick && pick.value) {
                saveVat({ vat_link: { quarter: pick.getAttribute('data-fin-vat-pick'), row_id: Number(pick.value) } });
            }
            const from = e.target.closest('[data-fin-vat-from]');
            if (from) saveVat({ vat_from: from.value });
        });

        view.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            if (state.debtDraft && e.target.closest('[data-fin-debt-form]')) {
                const id = state.debtDraft.id;
                state.debtDraft = null;
                renderDebts();
                const back = els.finDebts.querySelector(id ? `[data-fin-debt-edit="${id}"]` : '[data-fin-debt-add]');
                if (back) back.focus();
            } else if (state.draft && e.target.closest('[data-fin-cost-form]')) {
                state.draft = null;
                renderKpis();
            } else if (e.target.closest('.fin-kpi-panel')) {
                state.costsOpen = false;
                renderKpis();
                const btn = els.finKpis.querySelector('[data-fin-focus="costs"]');
                if (btn) btn.focus();
            } else if (state.bufferOpen && e.target.closest('[data-fin-buffer-form]')) {
                state.bufferOpen = false;
                renderKpis();
                const btn = els.finKpis.querySelector('[data-fin-buffer]');
                if (btn) btn.focus();
            } else if (state.folds.liquidity && e.target.closest('[data-fin-balance-form]')) {
                state.folds.liquidity = false;
                try { localStorage.setItem(FOLD_KEY + 'liquidity', '0'); } catch (err) { /* this visit only */ }
                renderKpis();
                const btn = els.finKpis.querySelector('[data-fin-fold="liquidity"]');
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

    // ---- Our invoices for a company's sheet (companies.js) ----

    let companyCache = null;

    /**
     * One company's invoices and figures. From the page when it is loaded,
     * otherwise read once a minute - only where Financials is (admins).
     */
    async function allInvoices() {
        if (state.loaded) {
            if (window.CRMCompany) state.companies = window.CRMCompany.cached();
            return buildInvoices();
        }
        if (!companyCache || Date.now() - companyCache.at > 60000) {
            const [projects, overview, tx, companies] = await fetchAll(false);
            companyCache = { at: Date.now(), items: buildInvoices({ overview, tx, companies, projects }) };
        }
        return companyCache.items;
    }

    /** Per company id: { net, overdue, count } - for the rows of the contacts list. */
    async function invoicesByCompany() {
        if (!document.getElementById('finInvoices')) return null;
        const items = await allInvoices();
        const out = new Map();
        items.forEach(i => {
            if (!i.company) return;
            const m = out.get(i.company.id) || { net: 0, overdue: 0, count: 0 };
            m.net += Number(i.net) || 0;
            if (i.overdue) m.overdue += i.outstandingNet || 0;
            if (!i.credit) m.count++;
            out.set(i.company.id, m);
        });
        return out;
    }

    async function invoicesForCompany(company) {
        if (!document.getElementById('finInvoices') || !company) return null;
        const items = await allInvoices();
        const id = Number(company.id);
        return { items: items.filter(i => i.company && i.company.id === id), stats: IL.companyStats(items, id) };
    }

    // A company merged, renamed or added: the invoices find theirs again.
    document.addEventListener('crm:companies-changed', () => {
        companyCache = null;
        if (!state.loaded || !window.CRMCompany) return;
        state.companies = window.CRMCompany.cached();
        state.invoices = buildInvoices();
        renderInvoices();
    });

    // items: every invoice with its company and project, for the Insights tab.
    window.CompanyInvoices = { forCompany: invoicesForCompany, all: invoicesByCompany, items: allInvoices };
    window.Financials = { load };
})();
