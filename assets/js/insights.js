/**
 * The Insights tab (admins): how the company developed, from history only.
 *
 * Three views - Overview, Sales, Customers - over one period (a year, the
 * last 12 months or all). The figures come from insights-calc.js; here they
 * are drawn. Read: the projects (api/projects.php), their history and the
 * archived ones (api/insights.php), the companies (companies.js) and our
 * invoices as Financials matches them to companies and projects
 * (financials.js, CompanyInvoices.items).
 *
 * A project's dot opens its sheet, a customer opens the company's.
 */
(function () {
    'use strict';

    const IC = window.InsightsCalc;
    const F = window.CRMFormat;
    const VIEWS = [['overview', 'Overview'], ['sales', 'Sales'], ['customers', 'Customers']];
    const VIEW_KEY = 'crm.insights.view';
    const PERIOD_KEY = 'crm.insights.period';
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const STAGE_TONE = {
        Lead: 'var(--stage-lead)', Negotiation: 'var(--stage-negotiation)', Proposal: 'var(--stage-proposal)',
        'In Progress': 'var(--stage-progress)', Won: 'var(--stage-progress)'
    };
    const NONE_TONE = 'var(--product-none)';

    const state = {
        view: stored(VIEW_KEY, 'overview'),
        period: stored(PERIOD_KEY, null),
        data: null,
        parts: null,
        reasons: {},
        loading: false,
        error: null
    };
    let els = null;

    function stored(key, fallback) {
        try {
            return localStorage.getItem(key) || fallback;
        } catch (e) {
            return fallback;
        }
    }

    function store(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // Not remembering it is fine.
        }
    }

    const esc = value => String(value == null ? '' : value)
        .replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const money = v => F.amountShort(v || 0);
    const pct = v => (v === null || v === undefined ? '–' : Math.round(v * 100) + '%');
    const P = v => (Math.round(v * 10000) / 100) + '%';
    const days = n => (n === null || n === undefined ? '–' : Math.round(n) + (Math.round(n) === 1 ? ' day' : ' days'));
    const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

    /** "3 of 8" while there are few, "46%" with a small "19 of 41" once there are enough. */
    function rate(part, whole) {
        if (!whole) return '–';
        if (whole < 10) return `${part} of ${whole}`;
        return `${pct(part / whole)}<small>${part} of ${whole}</small>`;
    }

    function signed(v) {
        const n = Math.round(v * 100);
        return (n > 0 ? '+' : n < 0 ? F.MINUS : '') + Math.abs(n) + '%';
    }

    function monthLabel(m) {
        return MONTHS[+m.slice(5, 7) - 1];
    }

    /** A clean top for an axis and its steps: 0 to max in 2 to 5 steps. */
    function scale(max, steps) {
        const top = Math.max(max, 1);
        const raw = top / (steps || 4);
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw) || 10 * mag;
        const ticks = [];
        for (let v = 0; v <= top + step * 0.001; v += step) ticks.push(v);
        if (ticks[ticks.length - 1] < top) ticks.push(ticks[ticks.length - 1] + step);
        return { max: ticks[ticks.length - 1], ticks };
    }

    /** Text on a coloured block: white on a dark one, navy on a light one. */
    function inkOn(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m) return 'is-dark';
        const n = parseInt(m[1], 16);
        const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
        return lum > 0.6 ? 'is-dark' : 'is-light';
    }

    function productColor(name) {
        const p = (state.data ? state.data.products : []).find(x => x.name === name);
        return p && p.color ? p.color : null;
    }

    // ------------------------------------------------------------------
    // Pieces every chart is made of
    // ------------------------------------------------------------------

    function grid(sc, fmt) {
        return sc.ticks.map(v => {
            const top = P(1 - v / sc.max);
            return `<span class="ins-gl${v === 0 ? ' is-base' : ''}" style="top:${top}"></span><span class="ins-yl" style="top:${top}">${esc(v === 0 ? '0' : fmt(v))}</span>`;
        }).join('');
    }

    function xLabels(list) {
        return list.map(x => `<span class="ins-xl${x.cls ? ' ' + x.cls : ''}" style="left:${x.left}">${esc(x.label)}</span>`).join('');
    }

    function path(points) {
        return points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    }

    function card(cls, head, body, note) {
        return `<section class="ins-card${cls ? ' ' + cls : ''}">${head}${body}${note ? `<p class="ins-note">${note}</p>` : ''}</section>`;
    }

    function head(title, sub, right) {
        return `<div class="ins-head"><div><h2 class="ins-h">${esc(title)}</h2>${sub ? `<p class="ins-sub">${esc(sub)}</p>` : ''}</div>${right || ''}</div>`;
    }

    function legend(items) {
        return `<div class="ins-legend">${items.map(([key, label]) => `<span>${key}${esc(label)}</span>`).join('')}</div>`;
    }

    const sw = color => `<span class="ins-sw" style="background:${color}"></span>`;
    const lk = color => `<span class="ins-lk" style="background:${color}"></span>`;
    const dot = cls => `<span class="ins-kd ${cls || ''}"></span>`;

    function empty(text) {
        return `<p class="ins-empty">${esc(text)}</p>`;
    }

    /** "+52% on 2025 (73,3k €)", or nothing without a period before. */
    function delta(cur, prev, good, fmt) {
        const p = state.parts.period;
        if (prev === null || prev === undefined || !p.prev) return '';
        const vs = p.kind === 'year' ? 'on ' + (p.year - 1) : 'on the 12 months before';
        if (!prev) return `${vs}: ${esc(fmt ? fmt(prev) : prev)}`;
        const d = (cur - prev) / Math.abs(prev);
        const up = d >= 0;
        const cls = Math.abs(d) < 0.005 ? '' : ((up === (good !== false)) ? 'is-up' : 'is-down');
        return `<span class="${cls}">${signed(d)}</span> ${vs}${fmt ? ' (' + esc(fmt(prev)) + ')' : ''}`;
    }

    function kpi(label, value, sub, extra) {
        return `<div class="ins-kpi"><span class="ins-kpi-l">${esc(label)}</span><span class="ins-kpi-v">${value}</span>${sub ? `<span class="ins-kpi-s">${sub}</span>` : ''}${extra || ''}</div>`;
    }

    // ------------------------------------------------------------------
    // Overview
    // ------------------------------------------------------------------

    const ICONS = {
        good: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
        warn: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.5h.01"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'
    };

    function highlights(list) {
        if (!list.length) return '';
        return card('ins-span-12', head('Highlights'), `<div class="ins-ins">${list.map(h => `
            <button type="button" class="ins-in" data-goto="${esc(h.view)}">
                <svg class="ins-ic is-${h.tone}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[h.tone] || ICONS.info}</svg>
                <span class="ins-in-t">${h.parts.map(([text, style]) => style === 'b' ? `<b>${esc(text)}</b>` : esc(text)).join('')}</span>
                <svg class="ins-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
            </button>`).join('')}</div>`);
    }

    function overviewKpis(k, cumulative) {
        const p = state.parts.period;
        const spark = cumulative.cur.length ? sparkBars() : '';
        return `<div class="ins-kpis ins-span-12">
            ${kpi('Revenue', esc(money(k.revenue)), delta(k.revenue, k.revenuePrev, true, money), spark)}
            ${kpi('Cash in', esc(money(k.cash)), delta(k.cash, k.cashPrev, true, money))}
            ${kpi('Customers', String(k.customers), `${k.newCustomers} new, ${k.returning} returning${k.customersPrev !== null && p.prev ? ` (${p.kind === 'year' ? p.year - 1 : 'before'}: ${k.customersPrev})` : ''}`)}
            ${kpi('Won', `${k.won}<small>${k.won === 1 ? 'project' : 'projects'}</small>`, k.wonVolume ? `${esc(money(k.wonVolume))} in orders` : '')}
            ${kpi('Win rate', k.decided >= 10 ? pct(k.winRate) : (k.decided ? `${k.won}<small>of ${k.decided}</small>` : '–'), !k.decided ? 'Nothing decided yet' : (k.decided >= 10 ? `${k.won} of ${k.decided} decided` : 'Won of decided'))}
            ${kpi('Time to win', k.timeToWin === null ? '–' : `${Math.round(k.timeToWin)}<small>days</small>`, k.timeToWinN ? `Median of ${k.timeToWinN}, first entry to order` : 'No order yet')}
        </div>`;
    }

    /** Revenue per month over the last 12, for the tile. */
    function sparkBars() {
        const data = state.data;
        const end = data.today.slice(0, 7);
        const months = [];
        for (let i = 11; i >= 0; i--) months.push(IC.addMonths(end, -i));
        const values = months.map(m => data.invoices.filter(x => x.date.slice(0, 7) === m).reduce((s, x) => s + x.net, 0));
        const max = Math.max.apply(null, values.concat([1]));
        const p = state.parts.period;
        return `<div class="ins-spark" role="img" aria-label="Revenue per month over the last 12 months">${values.map((v, i) => {
            const inPeriod = months[i] + '-01' >= p.start.slice(0, 7) + '-01' && months[i] + '-01' <= p.end;
            return `<span class="ins-sb${inPeriod ? '' : ' is-prev'}" style="left:${P(i / 12)};height:${P(Math.max(0, v) / max)}" title="${esc(monthLabel(months[i]) + ' ' + months[i].slice(0, 4) + ': ' + money(v))}"></span>`;
        }).join('')}</div>`;
    }

    function revenueCard(c) {
        const p = state.parts.period;
        const n = c.months.length;
        const values = c.cur.map(x => x.value).concat(c.prev ? c.prev.map(x => x.value) : []);
        const sc = scale(Math.max.apply(null, values.concat([1])), 5);
        const pt = x => [x.x / n * 1000, 300 - Math.max(0, x.value) / sc.max * 300];
        const cur = c.cur.length ? [[0, 300]].concat(c.cur.map(pt)) : [];
        const prev = c.prev && c.prev.length ? [[0, 300]].concat(c.prev.map(pt)) : null;
        const last = c.cur[c.cur.length - 1];
        const prevLast = c.prev && c.prev[c.prev.length - 1];
        const every = n > 12 ? Math.ceil(n / 12) : 1;
        const labels = c.months.map((m, i) => ({ left: P((i + 0.5) / n), label: n > 12 ? monthLabel(m) + ' ' + m.slice(2, 4) : monthLabel(m) }))
            .filter((x, i) => i % every === 0);
        const prevName = p.kind === 'year' ? String(p.year - 1) : 'Before';
        const curName = p.kind === 'year' ? String(p.year) : (p.kind === '12m' ? 'Last 12 months' : 'All');
        const marks = c.cur.map((x, i) => `<span class="ins-hit" style="left:${P(x.x / n)};top:${P(1 - Math.max(0, x.value) / sc.max)}" title="${esc(monthLabel(x.month) + ' ' + x.month.slice(0, 4) + ': ' + money(x.value) + (c.prev && c.prev[i] ? ' (' + prevName + ': ' + money(c.prev[i].value) + ')' : ''))}"></span>`).join('');
        const body = !last ? empty('No invoices in this period.') : `
            <div class="ins-chart">
                <div class="ins-plot" style="height:250px" role="img" aria-label="${esc('Revenue added up: ' + money(last.value) + (prevLast ? ', ' + prevName + ' ' + money(prevLast.value) : ''))}">
                    ${grid(sc, money)}
                    <svg class="ins-svg" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
                        <path class="ins-area" d="${path(cur)} L${cur[cur.length - 1][0].toFixed(1)} 300 Z"/>
                        ${prev ? `<path class="ins-ln is-prev" d="${path(prev)}"/>` : ''}
                        <path class="ins-ln is-acc" d="${path(cur)}"/>
                    </svg>
                    ${marks}
                    ${prevLast ? `<span class="ins-pt is-prev" style="left:${P(prevLast.x / n)};top:${P(1 - prevLast.value / sc.max)}"></span>
                        <span class="ins-lab is-muted is-left" style="left:${P(prevLast.x / n)};top:${P(1 - prevLast.value / sc.max)}">${esc(prevName + ': ' + money(prevLast.value))}</span>` : ''}
                    <span class="ins-pt" style="left:${P(last.x / n)};top:${P(1 - last.value / sc.max)}"></span>
                    <span class="ins-lab${last.x / n > 0.85 ? ' is-left' : ''}" style="left:${P(last.x / n)};top:${P(1 - last.value / sc.max)}">${esc(money(last.value))}</span>
                    ${xLabels(labels)}
                </div>
            </div>`;
        return card('ins-span-8', head(p.kind === 'year' && p.running ? 'Revenue year to date' : 'Revenue added up', 'Net, by invoice date',
            prev ? legend([[lk('var(--c-accent)'), curName], [lk('var(--ins-prev)'), prevName]]) : ''), body);
    }

    function quartersCard(qs) {
        const sc = scale(Math.max.apply(null, qs.map(q => q.value).concat([1])), 3);
        const n = qs.length;
        const best = qs.reduce((b, q, i) => (q.value > qs[b].value ? i : b), 0);
        const years = [];
        qs.forEach((q, i) => {
            const y = years.find(x => x.year === q.year);
            if (y) y.to = i; else years.push({ year: q.year, from: i, to: i });
        });
        const body = `
            <div class="ins-chart is-two-rows">
                <div class="ins-plot" style="height:250px" role="img" aria-label="Revenue per quarter">
                    ${grid(sc, money)}
                    ${qs.map((q, i) => `<span class="ins-col${q.inPeriod ? '' : ' is-prev'}${q.partial ? ' is-part' : ''}" style="left:${P((i + 0.5) / n)};height:${P(Math.max(0, q.value) / sc.max)}" title="${esc(q.label + ' ' + q.year + ': ' + money(q.value) + (q.partial ? ' so far' : ''))}"></span>`).join('')}
                    ${qs[best].value > 0 ? `<span class="ins-cap" style="left:${P((best + 0.5) / n)};bottom:${P(qs[best].value / sc.max)}">${esc(money(qs[best].value))}</span>` : ''}
                    ${qs[n - 1].partial && best !== n - 1 ? `<span class="ins-cap is-muted" style="left:${P((n - 0.5) / n)};bottom:${P(Math.max(0, qs[n - 1].value) / sc.max)}">so far</span>` : ''}
                    ${xLabels(qs.map((q, i) => ({ left: P((i + 0.5) / n), label: q.label })))}
                    ${xLabels(years.map(y => ({ left: P(((y.from + y.to) / 2 + 0.5) / n), label: y.year, cls: 'is-y2' })))}
                </div>
            </div>`;
        return card('ins-span-4', head('Revenue per quarter', 'Net, by invoice date'), body);
    }

    function mixRow(label, mix) {
        let at = 0;
        const segs = mix.parts.map(part => {
            const color = part.color || NONE_TONE;
            const html = `<span class="ins-mseg ${part.color ? inkOn(part.color) : 'is-dark'}" style="left:calc(${P(at)} + 1px);width:calc(${P(part.share)} - 2px);background:${color}" title="${esc(part.name + ': ' + pct(part.share) + ' (' + money(part.net) + ')')}">${part.share >= 0.08 ? esc(pct(part.share)) : ''}</span>`;
            at += part.share;
            return html;
        }).join('');
        return `<div class="ins-mix-row"><span class="ins-mix-y">${esc(label)}</span><div class="ins-mix-bar" role="img" aria-label="${esc(label + ': ' + mix.parts.map(x => x.name + ' ' + pct(x.share)).join(', '))}">${segs}</div><span class="ins-mix-t">${esc(money(mix.total))}</span></div>`;
    }

    function mixCard(m) {
        const p = state.parts.period;
        if (!m.cur.parts.length) return card('ins-span-6', head('Product mix', 'Share of revenue'), empty('No invoices in this period.'));
        const names = [];
        [m.cur].concat(m.prev && m.prev.parts.length ? [m.prev] : []).forEach(x => x.parts.forEach(part => { if (!names.find(n => n.name === part.name)) names.push(part); }));
        const order = state.data.products.map(x => x.name).concat([IC.NO_PRODUCT]);
        names.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
        const none = m.cur.parts.find(x => x.name === IC.NO_PRODUCT);
        const note = none && none.share >= 0.2
            ? `<b>${pct(none.share)}</b> of the revenue is not linked to a project with a product yet (Financials, Invoices).`
            : '';
        const rows = (m.prev && m.prev.parts.length ? mixRow(p.kind === 'year' ? String(p.year - 1) : 'Before', m.prev) : '') + mixRow(p.kind === 'year' ? String(p.year) : (p.kind === '12m' ? '12 months' : 'All'), m.cur);
        return card('ins-span-6', head('Product mix', 'Share of revenue'),
            `<div class="ins-mix">${rows}</div>${legend(names.map(x => [sw(x.color || NONE_TONE), x.name]))}`, note);
    }

    function miniBars(list, key, sc, label, below) {
        const n = list.length;
        const lastIndex = n - 1;
        return `<div class="ins-mini"><span class="ins-mini-l">${esc(label)}</span>
            <div class="ins-plot" role="img" aria-label="${esc(label + ' per month')}">
                <span class="ins-gl is-base" style="top:100%"></span>
                ${list.map((x, i) => `<span class="ins-col${i >= n - 3 ? '' : ' is-prev'}" style="left:${P((i + 0.5) / n)};height:${P(x[key] / sc)};width:${n > 14 ? 8 : 16}px" title="${esc(monthLabel(x.month) + ' ' + x.month.slice(0, 4) + ': ' + x[key])}"></span>`).join('')}
                ${n ? `<span class="ins-cap" style="left:${P((lastIndex + 0.5) / n)};bottom:${P(list[lastIndex][key] / sc)}">${list[lastIndex][key]}</span>` : ''}
                ${below || ''}
            </div></div>`;
    }

    function inflowCard(list) {
        if (!list.length) return card('ins-span-6', head('Inflow', 'New projects and offers sent per month'), empty('Nothing in this period yet.'));
        const sc = Math.max.apply(null, list.map(x => Math.max(x.leads, x.offers)).concat([1]));
        const n = list.length;
        const every = n > 12 ? Math.ceil(n / 12) : 1;
        const last3 = list.slice(-3);
        const before = list.slice(-6, -3);
        const s = (arr, k) => arr.reduce((t, x) => t + x[k], 0);
        const note = before.length === 3
            ? `Last 3 months: <b>${plural(s(last3, 'leads'), 'new project', 'new projects')} and ${plural(s(last3, 'offers'), 'offer', 'offers')}</b>, against ${s(before, 'leads')} and ${s(before, 'offers')} in the 3 before.`
            : '';
        const body = `${miniBars(list, 'leads', sc, 'New projects')}
            <div class="ins-mini-gap"></div>
            ${miniBars(list, 'offers', sc, 'Offers sent', xLabels(list.map((x, i) => ({ left: P((i + 0.5) / n), label: n > 12 ? monthLabel(x.month) + ' ' + x.month.slice(2, 4) : monthLabel(x.month) })).filter((x, i) => i % every === 0)))}`;
        return card('ins-span-6', head('Inflow', 'New projects and offers sent per month'), body, note);
    }

    function renderOverview(parts) {
        return `${highlights(parts.highlights)}
            ${overviewKpis(parts.kpis, parts.cumulative)}
            ${revenueCard(parts.cumulative)}
            ${quartersCard(parts.quarters)}
            ${mixCard(parts.mix)}
            ${inflowCard(parts.inflow)}`;
    }

    // ------------------------------------------------------------------
    // Sales
    // ------------------------------------------------------------------

    const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15"/><path d="M13 6l6 6-6 6"/></svg>';

    function funnelCard(f) {
        if (!f.entered) return card('ins-span-12', head('From lead to order'), empty('No projects entered in this period.'));
        const stage = (s, i) => {
            const tone = STAGE_TONE[s.name];
            const won = i === 3;
            return `<div class="ins-stage">
                <span class="ins-stage-bar" style="background:${tone}"></span>
                <span class="ins-stage-n">${s.reached}</span>
                <span class="ins-stage-l">${esc(s.name)}</span>
                ${won ? `<span class="ins-stage-o">${f.winRate === null ? 'Nothing decided yet' : esc(pct(f.winRate)) + ' of decided'}</span>${f.wonVolume ? `<span class="ins-stage-o is-tight">${esc(money(f.wonVolume))} in orders</span>` : ''}`
                    : `${s.lost ? `<span class="ins-stage-x">${dot('is-lost')}${s.lost} lost</span>` : ''}${s.open ? `<span class="ins-stage-o">${s.open} open</span>` : ''}`}
            </div>`;
        };
        const step = s => `<div class="ins-step"><b>${s.next === null ? '–' : pct(s.next)}</b>${ARROW}<span>${s.days === null ? '' : esc(days(s.days))}</span></div>`;
        const html = f.steps.map((s, i) => stage(s, i) + (i < 3 ? step(s) : '')).join('');
        return card('ins-span-12', head('From lead to order',
            `${plural(f.entered, 'project', 'projects')} entered in this period, by the furthest stage they reached${f.unclear ? `; ${f.unclear} archived without a reason` : ''}`,
            legend([[dot('is-lost'), 'Lost at this stage']])), `<div class="ins-flow">${html}</div>`);
    }

    function cohortCard(list) {
        if (!list.length) return card('ins-span-6', head('Outcome by quarter entered', 'Each square is a project'), empty('No projects entered in this period.'));
        const rows = list.map(r => `<div class="ins-urow">
            <span class="ins-urow-l">${esc(r.label)}<small>${plural(r.deals.length, 'project', 'projects')}</small></span>
            <div class="ins-units">${r.deals.map(d => unit(d)).join('')}</div>
            <span class="ins-urow-v">${r.decided ? `<b>${r.won} of ${r.decided}</b> won` : 'open'}</span>
        </div>`).join('');
        return card('ins-span-6', head('Outcome by quarter entered', 'Each square is a project',
            legend([[sw('var(--c-success)'), 'Won'], [sw('var(--c-tint-2)'), 'Open'], ['<span class="ins-sw is-lost"></span>', 'Lost'], ['<span class="ins-sw is-unclear"></span>', 'No reason']])), `<div class="ins-rows">${rows}</div>`);
    }

    function unit(d) {
        const word = { won: 'won', open: 'open', lost: 'lost', unclear: 'archived without a reason' }[d.outcome];
        return `<button type="button" class="ins-u is-${d.outcome}" ${d.archived ? 'disabled' : `data-project="${d.id}"`} title="${esc(d.name + ': ' + word)}" aria-label="${esc(d.name + ': ' + word)}"></button>`;
    }

    /** A project as a dot; it opens the project's sheet (an archived one cannot be opened). */
    function dealDot(d, left, title, extra, cls) {
        const attrs = d.archived ? 'disabled' : `data-project="${d.id}"`;
        return `<button type="button" class="ins-dd${cls ? ' ' + cls : ''}" style="left:${left}${extra || ''}" ${attrs} title="${esc(title)}" aria-label="${esc(title)}"></button>`;
    }

    function axis(ticks, labelOf) {
        return `<div class="ins-axis" aria-hidden="true">${ticks.map(t => `<span style="left:${t.left}">${esc(labelOf(t))}</span>`).join('')}</div>`;
    }

    function timeToWinCard(rows) {
        const all = rows.reduce((list, r) => list.concat(r.items), []);
        if (!all.length) return card('ins-span-6', head('Time to win', 'Days from first entry to order, each dot a project'), empty('No order won in this period from a project entered as a lead.'));
        const sc = scale(Math.max.apply(null, all.map(x => x.days).concat([30])), 4);
        const body = rows.map(r => `<div class="ins-hrow">
            <span class="ins-hrow-l">${esc(r.name)}</span>
            <div class="ins-track is-line">
                ${r.items.length > 1 ? `<span class="ins-med" style="left:${P(r.median / sc.max)}"></span>` : ''}
                ${r.items.map(x => dealDot(x.deal, P(x.days / sc.max), x.deal.name + ': ' + days(x.days))).join('')}
            </div>
            <span class="ins-hrow-v">${esc(days(r.median))}<small>${r.items.length} won</small></span>
        </div>`).join('');
        return card('ins-span-6', head('Time to win', 'Days from first entry to order, each dot a project',
            legend([[dot('is-acc'), 'Project'], ['<span class="ins-lk is-tick"></span>', 'Median']])),
            `<div class="ins-rows">${body}</div>${axis(sc.ticks.map(v => ({ left: P(v / sc.max), v })), t => (t.v === sc.max ? t.v + ' days' : String(t.v)))}`);
    }

    function calibrationCard(c) {
        if (!c.n) return card('ins-span-6', head('Estimates against outcome', 'Last chance entered before the decision'), empty('No decided project with an estimate in this period.'));
        const rows = c.rows.map(r => {
            if (!r.n) return `<div class="ins-hrow"><span class="ins-hrow-l">${esc(r.label)}</span><div class="ins-track is-line"></div><span class="ins-hrow-v is-muted">–</span></div>`;
            const lo = Math.min(r.estimated, r.actual);
            return `<div class="ins-hrow">
                <span class="ins-hrow-l">${esc(r.label)}<small>${plural(r.n, 'project', 'projects')}</small></span>
                <div class="ins-track is-line">
                    <span class="ins-conn" style="left:${P(lo)};width:${P(Math.abs(r.estimated - r.actual))}"></span>
                    <span class="ins-dd is-ring" style="left:${P(r.estimated)}" title="${esc('Estimated ' + pct(r.estimated) + ' on average')}"></span>
                    <span class="ins-dd" style="left:${P(r.actual)}" title="${esc(r.won + ' of ' + r.n + ' won')}"></span>
                </div>
                <span class="ins-hrow-v">${r.won} of ${r.n}</span>
            </div>`;
        }).join('');
        const note = c.weighted > 0
            ? `Weighted by chance, these projects stood at <b>${esc(money(c.weighted))}</b>. Won were <b>${esc(money(c.wonVolume))}</b>, ${pct(c.wonVolume / c.weighted)} of it.`
            : '';
        return card('ins-span-6', head('Estimates against outcome', 'Last chance entered before the decision',
            legend([[dot('is-hollow'), 'Estimated'], [dot('is-acc'), 'Came true']])),
            `<div class="ins-rows">${rows}</div>${axis([0, 0.5, 1].map(v => ({ left: P(v), v })), t => pct(t.v))}`, note);
    }

    function curvePanel(title, group, end) {
        const x = d => (d + 90) / 90 * 1000;
        const y = v => 300 - v * 3;
        const step = line => line.map((pt, i) => (i ? 'H' + x(pt[0]).toFixed(1) + ' V' + y(pt[1]).toFixed(1) : 'M' + x(pt[0]).toFixed(1) + ' ' + y(pt[1]).toFixed(1))).join(' ');
        const lines = group.lines.map(c => step(c.line)).join(' ');
        const med = group.median.length > 1 ? step(group.median) : '';
        return `<div>
            <p class="ins-panel-t">${esc(title)}<small>${group.lines.length}${group.total > group.lines.length ? ' of ' + group.total : ''}</small></p>
            ${group.lines.length ? `<div class="ins-chart is-small">
                <div class="ins-plot" style="height:160px" role="img" aria-label="${esc(title + ': chance in the 90 days before')}">
                    ${grid({ max: 100, ticks: [0, 50, 100] }, v => v + '%')}
                    <svg class="ins-svg" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
                        <path class="ins-ln is-faint" d="${lines}"/>
                        ${med ? `<path class="ins-ln is-ink" d="${med}"/>` : ''}
                    </svg>
                    ${xLabels([{ left: '0%', label: '90 days', cls: 'is-start' }, { left: '50%', label: '45' }, { left: '100%', label: end, cls: 'is-end' }])}
                </div>
            </div>` : empty('No chance recorded before these decisions.')}
        </div>`;
    }

    function curvesCard(c) {
        if (!c.won.total && !c.lost.total) return card('ins-span-6', head('Chance before the decision', 'The 90 days before a project was won or lost'), empty('Nothing decided in this period.'));
        const note = c.lostMonthN >= 3
            ? `A month before they were lost, projects stood at a median chance of <b>${Math.round(c.lostMonthBefore)}%</b>.`
            : 'Recorded since 20 Nov 2026; earlier changes were rebuilt from the log and are sparse.';
        return card('ins-span-6', head('Chance before the decision', 'The 90 days before a project was won or lost',
            legend([[lk('var(--c-line-strong)'), 'Project'], [lk('var(--c-ink)'), 'Median']])),
            `<div class="ins-pair">${curvePanel('Won', c.won, 'Won')}${curvePanel('Lost', c.lost, 'Lost')}</div>`, note);
    }

    function lossesCard(l) {
        const sub = 'Chance when the project was archived, by stage';
        if (!l.total) {
            return card('ins-span-6', head('Where we lose', sub), empty(l.unclear
                ? `No project archived as lost in this period. ${plural(l.unclear, 'archived project has', 'archived projects have')} no reason yet.`
                : 'No project lost in this period.'));
        }
        const rows = l.stages.map(s => {
            const seen = {};
            const dots = s.items.filter(x => x.chance !== null).map(x => {
                const n = (seen[x.chance] = (seen[x.chance] || 0) + 1) - 1;
                const dy = [0, -7, 7][n % 3];
                return dealDot(x.deal, P(x.chance / 100), x.deal.name + ': ' + x.chance + '%', `;top:calc(50% + ${dy}px)`, 'is-lost');
            }).join('');
            return `<div class="ins-hrow"><span class="ins-hrow-l">${esc(s.name)}</span><div class="ins-track is-line">${dots}</div><span class="ins-hrow-v">${s.items.length}</span></div>`;
        }).join('');
        const max = Math.max.apply(null, l.why.map(w => w.n).concat([1]));
        const why = l.why.length ? `<p class="ins-panel-t ins-why">Why</p><div class="ins-rows">${l.why.map(w => `
            <div class="ins-hrow"><span class="ins-hrow-l">${esc(w.label)}</span><div class="ins-track"><span class="ins-hb is-ink" style="width:${P(w.n / max)}"></span></div><span class="ins-hrow-v">${w.n}</span></div>`).join('')}</div>` : '';
        return card('ins-span-6', head('Where we lose', sub, legend([[dot('is-lost'), 'Lost project']])),
            `<div class="ins-rows">${rows}</div>${axis([0, 0.5, 1].map(v => ({ left: P(v), v })), t => pct(t.v))}${why}`,
            l.unclear ? `${plural(l.unclear, 'archived project has', 'archived projects have')} no reason yet. <button type="button" class="ins-link" data-goto="archive">Add the reasons</button>` : '');
    }

    function pipelineCard(list) {
        if (!list.length || !list.some(x => x.open > 0)) return card('ins-span-6', head('Open pipeline at month end', 'Budgets of open projects, and weighted by chance'), empty('No open project with a budget in this period.'));
        const n = list.length;
        const sc = scale(Math.max.apply(null, list.map(x => x.open).concat([1])), 3);
        const pt = (i, v) => [(i + 0.5) / n * 1000, 300 - v / sc.max * 300];
        const last = list[n - 1];
        const every = n > 12 ? Math.ceil(n / 12) : 1;
        const body = `<div class="ins-chart">
            <div class="ins-plot" style="height:230px" role="img" aria-label="${esc('Open pipeline at month end, ' + money(last.open) + ' open and ' + money(last.weighted) + ' weighted at the end')}">
                ${grid(sc, money)}
                <svg class="ins-svg" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
                    <path class="ins-ln is-prev" d="${path(list.map((x, i) => pt(i, x.open)))}"/>
                    <path class="ins-ln is-acc" d="${path(list.map((x, i) => pt(i, x.weighted)))}"/>
                </svg>
                ${list.map((x, i) => `<span class="ins-hit" style="left:${P((i + 0.5) / n)};top:${P(1 - x.open / sc.max)}" title="${esc(monthLabel(x.month) + ' ' + x.month.slice(0, 4) + ': ' + money(x.open) + ' open, ' + money(x.weighted) + ' weighted, ' + plural(x.count, 'project', 'projects'))}"></span>`).join('')}
                <span class="ins-pt is-prev" style="left:${P((n - 0.5) / n)};top:${P(1 - last.open / sc.max)}"></span>
                <span class="ins-lab is-muted is-left" style="left:${P((n - 0.5) / n)};top:${P(1 - last.open / sc.max)}">${esc(money(last.open))}</span>
                <span class="ins-pt" style="left:${P((n - 0.5) / n)};top:${P(1 - last.weighted / sc.max)}"></span>
                <span class="ins-lab is-left" style="left:${P((n - 0.5) / n)};top:${P(1 - last.weighted / sc.max)}">${esc(money(last.weighted))}</span>
                ${xLabels(list.map((x, i) => ({ left: P((i + 0.5) / n), label: n > 12 ? monthLabel(x.month) + ' ' + x.month.slice(2, 4) : monthLabel(x.month) })).filter((x, i) => i % every === 0))}
            </div></div>`;
        return card('ins-span-6', head('Open pipeline at month end', 'Budgets of open projects, and weighted by chance',
            legend([[lk('var(--ins-prev)'), 'Open'], [lk('var(--c-accent)'), 'Weighted']])), body);
    }

    function productTable(t) {
        if (!t.rows.length) return card('ins-span-12', head('By product', 'Projects entered in this period'), empty('No projects in this period.'));
        const row = (name, color, r, cls) => `<div class="ins-tr${cls || ''}">
            <span class="ins-pn">${color !== undefined ? sw(color || NONE_TONE) : ''}${esc(name)}</span>
            <span class="ins-num">${r.won}</span>
            <span class="ins-num">${rate(r.won, r.decided)}</span>
            <span class="ins-num">${r.order ? esc(money(r.order)) : '–'}</span>
            <span class="ins-num">${esc(days(r.days))}</span>
            <span class="ins-num">${esc(money(r.revenue))}</span>
        </div>`;
        return card('ins-span-12', head('By product', 'Projects entered in this period, revenue invoiced in it'), `<div class="ins-tbl">
            <div class="ins-tr is-th"><span>Product</span><span class="ins-num">Won</span><span class="ins-num">Win rate</span><span class="ins-num">Median order</span><span class="ins-num">Time to win</span><span class="ins-num">Revenue</span></div>
            ${t.rows.map(r => row(r.name, r.color, r)).join('')}
            ${row('All products', undefined, t.total, ' is-total')}
        </div>`);
    }

    function renderSales(parts) {
        return `${funnelCard(parts.funnel)}
            ${cohortCard(parts.cohorts)}
            ${timeToWinCard(parts.timeToWin)}
            ${calibrationCard(parts.calibration)}
            ${curvesCard(parts.curves)}
            ${lossesCard(parts.losses)}
            ${pipelineCard(parts.pipeline)}
            ${productTable(parts.byProduct)}`;
    }

    // ------------------------------------------------------------------
    // Customers
    // ------------------------------------------------------------------

    function customerKpis(c) {
        const p = state.parts.period;
        const prevName = p.kind === 'year' ? String(p.year - 1) : 'before';
        // Less of the revenue with the biggest customers is good: less depends on them.
        const shareSub = (cur, prev) => {
            if (prev === null || prev === undefined || cur === null) return '';
            const when = p.kind === 'year' ? 'in ' + prevName : 'before';
            if (Math.round(cur * 100) === Math.round(prev * 100)) return `Same as ${when}`;
            return `${cur < prev ? '<span class="is-up">Down</span>' : '<span class="is-down">Up</span>'} from ${pct(prev)} ${when}`;
        };
        return `<div class="ins-kpis is-five ins-span-12">
            ${kpi('Customers', String(c.customers), c.customersPrev !== null ? `${prevName}: ${c.customersPrev}` : '')}
            ${kpi('New', String(c.newCount), c.newShare !== null ? `${pct(c.newShare)} of revenue` : '')}
            ${kpi('Bought again', c.prevCount ? `${c.again}<small>of ${c.prevCount}</small>` : '–', c.prevCount ? `Customers from ${prevName}` : 'No customers before')}
            ${kpi('Biggest customer', pct(c.shares.top1), shareSub(c.shares.top1, c.sharesPrev ? c.sharesPrev.top1 : null))}
            ${kpi('Top 3 customers', pct(c.shares.top3), shareSub(c.shares.top3, c.sharesPrev ? c.sharesPrev.top3 : null))}
        </div>`;
    }

    function byCustomerCard(c) {
        const paying = c.list.filter(x => x.net > 0);
        if (!paying.length) return card('ins-span-6', head('Revenue by customer', 'Net, by invoice date'), empty('No invoices in this period.'));
        const top = paying.slice(0, 8);
        const rest = paying.slice(8);
        const restNet = rest.reduce((s, x) => s + x.net, 0);
        const max = Math.max(top[0].net, restNet);
        const row = (x, label, sub, cls, attrs) => `<div class="ins-hrow">
            <span class="ins-hrow-l">${attrs ? `<button type="button" class="ins-name" ${attrs}>${esc(label)}</button>` : esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
            <div class="ins-track"><span class="ins-hb${cls}" style="width:${P(x / max)}"></span></div>
            <span class="ins-hrow-v">${esc(money(x))}<small>${pct(c.total > 0 ? x / c.total : null)}</small></span>
        </div>`;
        const rows = top.map(x => row(x.net, x.name, [x.sector, x.isNew ? 'new' : ''].filter(Boolean).join(', '), '', x.companyId ? `data-company="${x.companyId}"` : '')).join('')
            + (rest.length ? row(restNet, plural(rest.length, 'other', 'others'), '', ' is-grey', '') : '');
        return card('ins-span-6', head('Revenue by customer', 'Net, by invoice date'), `<div class="ins-rows">${rows}</div>`);
    }

    function newReturningCard(list) {
        if (!list.some(x => x.returning + x.fresh > 0)) return card('ins-span-6', head('New and returning', 'Revenue per quarter, by whether the customer bought before'), empty('No invoices in this period.'));
        const n = list.length;
        const sc = scale(Math.max.apply(null, list.map(x => Math.max(0, x.returning) + Math.max(0, x.fresh)).concat([1])), 3);
        const total = list.reduce((s, x) => s + x.returning + x.fresh, 0);
        const fresh = list.reduce((s, x) => s + x.fresh, 0);
        const body = `<div class="ins-chart">
            <div class="ins-plot" style="height:250px" role="img" aria-label="Revenue per quarter from returning and new customers">
                ${grid(sc, money)}
                ${list.map((x, i) => {
                    const r = Math.max(0, x.returning) / sc.max;
                    const f = Math.max(0, x.fresh) / sc.max;
                    return `<span class="ins-col is-navy${f > 0 ? ' is-flat' : ''}" style="left:${P((i + 0.5) / n)};height:${P(r)};width:28px" title="${esc(x.label + ', returning: ' + money(x.returning))}"></span>`
                        + (f > 0 ? `<span class="ins-col is-light" style="left:${P((i + 0.5) / n)};bottom:calc(${P(r)} + ${r > 0 ? 2 : 0}px);height:calc(${P(f)} - ${r > 0 ? 2 : 0}px);width:28px" title="${esc(x.label + ', new: ' + money(x.fresh))}"></span>` : '');
                }).join('')}
                ${xLabels(list.map((x, i) => ({ left: P((i + 0.5) / n), label: x.label })))}
            </div></div>`;
        return card('ins-span-6', head('New and returning', 'Revenue per quarter, by whether the customer bought before',
            legend([[sw('var(--ins-navy)'), 'Returning'], [sw('var(--ins-light)'), 'New']])), body,
            total > 0 ? `New customers brought <b>${pct(fresh / total)}</b> of revenue.` : '');
    }

    function lanesCard(l) {
        if (!l.rows.length) return card('ins-span-12', head('How customers grew', 'Their projects over the last 24 months'), empty('No customer with invoices in this period yet.'));
        const size = b => (8 + Math.sqrt(Math.max(0, b || 0) / 1000) * 3.2).toFixed(1) + 'px';
        const lane = r => `<div class="ins-lane">
            <span class="ins-lane-l"><button type="button" class="ins-name" data-company="${r.companyId}">${esc(r.name)}</button>${r.sector ? `<small>${esc(r.sector)}</small>` : ''}</span>
            <div class="ins-ltrack">
                ${l.today !== null ? `<span class="ins-today" style="left:${P(l.today)}"></span>` : ''}
                ${r.events.map(e => {
                    const d = e.deal;
                    const attrs = d.archived ? 'disabled' : `data-project="${d.id}"`;
                    if (e.kind === 'lost') return `<button type="button" class="ins-ev is-lost" style="left:${P(e.x)}" ${attrs} title="${esc(d.name + ': lost')}" aria-label="${esc(d.name + ': lost')}"></button>`;
                    if (e.kind === 'talk') return `<button type="button" class="ins-ev is-talk" style="left:${P(e.x)}" ${attrs} title="${esc(d.name)}" aria-label="${esc(d.name)}"></button>`;
                    const color = productColor(d.product) || 'var(--c-accent)';
                    return `<button type="button" class="ins-ev" style="left:${P(e.x)};width:${size(e.budget)};height:${size(e.budget)};background:${color}" ${attrs} title="${esc(d.name + ': ' + (d.product || 'won') + ', ' + money(e.budget))}" aria-label="${esc(d.name)}"></button>`;
                }).join('')}
            </div>
        </div>`;
        const start = l.start;
        // Quarters along the bottom, January with its year.
        const ticks = [];
        for (let i = 0; i < 24; i++) {
            const m = IC.addMonths(start, i);
            if ((+m.slice(5) - 1) % 3) continue;
            ticks.push({ left: P(i / 24), label: m.slice(5) === '01' ? m.slice(0, 4) : monthLabel(m), year: m.slice(5) === '01' });
        }
        const products = state.data.products.filter(p => l.rows.some(r => r.events.some(e => e.kind === 'won' && e.deal.product === p.name)));
        return card('ins-span-12', head('How customers grew', 'Their projects over the last 24 months, sized by the order',
            legend(products.map(p => [`<span class="ins-kd" style="background:${p.color}"></span>`, p.name]).concat([[dot('is-small'), 'Talk or unpaid'], [dot('is-lost'), 'Lost']]))),
            `${l.rows.map(lane).join('')}<div class="ins-laxis" aria-hidden="true">${ticks.map(t => `<span class="${t.year ? 'is-year' : ''}" style="left:${t.left}">${esc(t.label)}</span>`).join('')}</div>`);
    }

    function doorsCard(d) {
        const sub = 'Talks and unpaid work at a customer without a paid order before';
        if (!d.items.length) return card('ins-span-4', head('Talks that opened doors', sub), empty('No talk in this period at a customer we had no order from.'));
        return card('ins-span-4', head('Talks that opened doors', sub), `
            <p class="ins-big">${d.hits}<small>of ${d.items.length}</small></p>
            <p class="ins-sub ins-big-sub">led to a paid project within 12 months</p>
            <div class="ins-units">${d.items.map(x => `<button type="button" class="ins-u is-round ${x.order ? 'is-hit' : 'is-miss'}" ${x.talk.archived ? 'disabled' : `data-project="${x.talk.id}"`} title="${esc(x.talk.name + (x.order ? ' → ' + x.order.name : ''))}" aria-label="${esc(x.talk.name)}"></button>`).join('')}</div>
            <ul class="ins-list">
                <li><span>Median time to the order</span><span>${d.months === null ? '–' : Math.round(d.months) + (Math.round(d.months) === 1 ? ' month' : ' months')}</span></li>
                <li><span>Orders that followed</span><span>${esc(money(d.volume))}</span></li>
            </ul>`);
    }

    function paymentsCard(p) {
        const qs = p.perQuarter;
        const known = qs.filter(q => q.days !== null);
        if (!known.length) return card('ins-span-4', head('Days to payment', 'Median per quarter, from invoice to bank'), empty('No paid invoice yet.'));
        const sc = scale(Math.max.apply(null, known.map(q => q.days).concat([10])), 2);
        const n = qs.length;
        const years = [];
        qs.forEach((q, i) => {
            const y = years.find(x => x.year === q.year);
            if (y) y.to = i; else years.push({ year: q.year, from: i, to: i });
        });
        const last = qs.map((q, i) => [q, i]).filter(([q]) => q.days !== null).pop();
        const body = `<div class="ins-chart is-two-rows" style="margin-left:58px">
            <div class="ins-plot" style="height:150px" role="img" aria-label="Median days to payment per quarter">
                ${grid(sc, v => v + ' days')}
                ${qs.map((q, i) => q.days === null ? '' : `<span class="ins-col${q.inPeriod ? '' : ' is-prev'}" style="left:${P((i + 0.5) / n)};height:${P(q.days / sc.max)};width:16px" title="${esc(q.label + ' ' + q.year + ': ' + days(q.days) + ', ' + plural(q.n, 'invoice', 'invoices'))}"></span>`).join('')}
                ${last ? `<span class="ins-cap" style="left:${P((last[1] + 0.5) / n)};bottom:${P(last[0].days / sc.max)}">${Math.round(last[0].days)}</span>` : ''}
                ${xLabels(qs.map((q, i) => ({ left: P((i + 0.5) / n), label: q.label })))}
                ${xLabels(years.map(y => ({ left: P(((y.from + y.to) / 2 + 0.5) / n), label: y.year, cls: 'is-y2' })))}
            </div></div>
            <ul class="ins-list">
                <li><span>Paid late or overdue</span><span>${p.late} of ${p.count}</span></li>
                ${p.slowest.map((s, i) => `<li><span>${i ? '' : 'Slowest: '}${s.companyId ? `<button type="button" class="ins-name" data-company="${s.companyId}">${esc(s.name)}</button>` : esc(s.name)}</span><span>${esc(days(s.days))}</span></li>`).join('')}
            </ul>`;
        return card('ins-span-4', head('Days to payment', 'Median per quarter, from invoice to bank'), body);
    }

    function sectorsCard(s) {
        const sub = 'Share of revenue, and orders won';
        if (!s.withSector) {
            return card('ins-span-4', head('By sector', sub), empty('No company has a sector yet. Add it in a company\'s sheet, under Edit.'));
        }
        const rows = s.rows.concat(s.none ? [s.none] : []);
        const max = Math.max.apply(null, rows.map(r => r.share || 0).concat([0.01]));
        return card('ins-span-4', head('By sector', sub), `<div class="ins-rows">${rows.map(r => `
            <div class="ins-srow${r.name === IC.NO_SECTOR ? ' is-none' : ''}">
                <div class="ins-srow-t"><span>${esc(r.name)}</span><span>${pct(r.share)}${r.decided ? `<small>won ${r.won} of ${r.decided}</small>` : ''}</span></div>
                <div class="ins-track is-thin"><span class="ins-hb${r.name === IC.NO_SECTOR ? ' is-grey' : ''}" style="width:${P((r.share || 0) / max)}"></span></div>
            </div>`).join('')}</div>`,
            s.none && s.none.share >= 0.2 ? `<b>${pct(s.none.share)}</b> of revenue comes from companies without a sector.` : '');
    }

    function renderCustomers(parts) {
        return `${customerKpis(parts.customers)}
            ${byCustomerCard(parts.customers)}
            ${newReturningCard(parts.newReturning)}
            ${lanesCard(parts.lanes)}
            ${doorsCard(parts.doors)}
            ${paymentsCard(parts.payments)}
            ${sectorsCard(parts.sectors)}`;
    }

    // ------------------------------------------------------------------
    // The page
    // ------------------------------------------------------------------

    function periodOptions() {
        const years = state.data ? IC.years(state.data) : [new Date().getFullYear().toString()];
        return years.slice(0, 3).map(y => ['year:' + y, y]).concat([['12m', '12 months'], ['all', 'All']]);
    }

    function renderTools() {
        const views = VIEWS.map(([key, label]) => `<button type="button" class="segmented-btn${state.view === key ? ' active' : ''}" data-ins-view="${key}" aria-pressed="${state.view === key}">${label}</button>`).join('');
        const periods = periodOptions().map(([key, label]) => `<button type="button" class="segmented-btn${state.period === key ? ' active' : ''}" data-ins-period="${key}" aria-pressed="${state.period === key}">${esc(label)}</button>`).join('');
        els.tools.innerHTML = `<div class="segmented ins-views" role="group" aria-label="Insights views">${views}</div>
            <div class="segmented ins-periods" role="group" aria-label="Period">${periods}</div>`;
    }

    function render() {
        if (!els) return;
        renderTools();
        if (state.error) {
            els.page.innerHTML = `<section class="ins-card ins-span-12">${empty('The figures could not be loaded: ' + state.error)}</section>`;
            return;
        }
        if (!state.data) return;
        const options = periodOptions().map(o => o[0]);
        if (!options.includes(state.period)) state.period = options[0];
        state.parts = IC.compute(state.data, state.period, state.reasons);
        renderTools();
        const html = state.view === 'sales' ? renderSales(state.parts)
            : state.view === 'customers' ? renderCustomers(state.parts)
                : renderOverview(state.parts);
        els.page.innerHTML = html;
        els.page.removeAttribute('aria-busy');
    }

    function skeleton() {
        const S = window.Skel;
        if (!S) return;
        const block = (h, span) => `<section class="ins-card ${span}"><div class="ins-head">${S.text('34%')}</div>${S.block('100%', h + 'px')}</section>`;
        const tile = `<div class="ins-kpi">${S.text('50%')}${S.block('62%', '26px')}${S.text('70%')}</div>`;
        els.page.innerHTML = `${block(96, 'ins-span-12')}<div class="ins-kpis ins-span-12">${tile.repeat(6)}</div>${block(260, 'ins-span-8')}${block(260, 'ins-span-4')}`;
        els.page.setAttribute('aria-busy', 'true');
    }

    async function getJson(url) {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || 'Request failed');
        return result;
    }

    async function load() {
        if (!bind() || state.loading) return;
        state.loading = true;
        if (!state.data) skeleton();
        try {
            const [projects, extra, companies, invoices] = await Promise.all([
                getJson('api/projects.php?' + new URLSearchParams({ search: '', sort: 'name', order: 'ASC' })).then(r => r.data || []),
                getJson('api/insights.php?action=data').then(r => r.data),
                window.CRMCompany ? window.CRMCompany.list(true).catch(() => []) : Promise.resolve([]),
                window.CompanyInvoices && window.CompanyInvoices.items ? window.CompanyInvoices.items().catch(() => []) : Promise.resolve([])
            ]);
            const products = window.CRMProducts ? window.CRMProducts.list() : [];
            const today = new Date();
            const iso = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
            state.reasons = extra.reasons || {};
            state.data = IC.prepare({
                invoices, projects, history: extra.history || [], archived: extra.archived || [],
                companies: (companies || []).map(c => ({ id: Number(c.id), name: c.name, sector: c.sector || null })),
                products: products.map(p => ({ name: p.name, color: p.color })),
                today: iso
            });
            if (!state.period) state.period = 'year:' + iso.slice(0, 4);
            state.error = null;
        } catch (error) {
            state.error = error.message || 'unknown error';
        } finally {
            state.loading = false;
        }
        render();
    }

    function goto(target) {
        if (target === 'archive') {
            if (window.CRM && window.CRM.switchView) window.CRM.switchView('projects');
            setTimeout(() => {
                const section = document.getElementById('deletedProjects');
                if (section) {
                    section.open = true;
                    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 400);
            return;
        }
        if (VIEWS.some(v => v[0] === target) && target !== state.view) {
            state.view = target;
            store(VIEW_KEY, target);
            render();
            els.page.scrollIntoView({ block: 'start' });
        }
    }

    function bind() {
        if (els) return true;
        const view = document.getElementById('insightsView');
        if (!view) return false;
        els = { view, tools: document.getElementById('insTools'), page: document.getElementById('insPage') };
        els.tools.addEventListener('click', e => {
            const v = e.target.closest('[data-ins-view]');
            const p = e.target.closest('[data-ins-period]');
            if (v) {
                state.view = v.dataset.insView;
                store(VIEW_KEY, state.view);
                render();
            } else if (p) {
                state.period = p.dataset.insPeriod;
                store(PERIOD_KEY, state.period);
                render();
            }
        });
        els.page.addEventListener('click', e => {
            const project = e.target.closest('[data-project]');
            const company = e.target.closest('[data-company]');
            const go = e.target.closest('[data-goto]');
            if (project && window.CRM) window.CRM.openProjectOverview(Number(project.dataset.project));
            else if (company && window.CRMCompany) window.CRMCompany.open(Number(company.dataset.company));
            else if (go) goto(go.dataset.goto);
        });
        return true;
    }

    window.Insights = { load };
})();
