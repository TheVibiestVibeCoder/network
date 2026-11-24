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
 * A customer's name opens the company's sheet.
 */
(function () {
    'use strict';

    const IC = window.InsightsCalc;
    const F = window.CRMFormat;
    const VIEWS = [['overview', 'Overview'], ['sales', 'Sales'], ['customers', 'Customers']];
    const VIEW_KEY = 'crm.insights.view';
    const PERIOD_KEY = 'crm.insights.period';
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const NONE_TONE = 'var(--product-none)';

    const state = {
        view: stored(VIEW_KEY, 'overview'),
        // A year is not kept: the page opens on the running one, also after New Year.
        period: /^(12m|all)$/.test(stored(PERIOD_KEY, '')) ? stored(PERIOD_KEY, '') : null,
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

    /** A card's title, a line below it (text, or { html }) and a legend on the right. */
    function head(title, sub, right) {
        const line = sub && sub.html ? sub.html : esc(sub);
        return `<div class="ins-head"><div><h2 class="ins-h">${esc(title)}</h2>${sub ? `<p class="ins-sub">${line}</p>` : ''}</div>${right || ''}</div>`;
    }

    function legend(items) {
        return `<div class="ins-legend">${items.map(([key, label]) => `<span>${key}${esc(label)}</span>`).join('')}</div>`;
    }

    const sw = color => `<span class="ins-sw" style="background:${color}"></span>`;
    const lk = color => `<span class="ins-lk" style="background:${color}"></span>`;

    function empty(text) {
        return `<p class="ins-empty">${esc(text)}</p>`;
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

    /** The findings as cards: what it is about, its figure big, the sentence; a click goes where it is shown. */
    function highlights(list) {
        if (!list.length) return '';
        return `<div class="ins-hls ins-span-12">${list.map(h => {
            const inner = `<span class="ins-hl-top"><svg class="ins-hl-ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[h.tone] || ICONS.info}</svg>${esc(h.title)}</span>
                <span class="ins-hl-f">${esc(h.figure)}</span>
                <span class="ins-hl-s">${h.parts.map(([text, style]) => style === 'b' ? `<b>${esc(text)}</b>` : esc(text)).join('')}</span>`;
            // A finding without a card of its own to go to stays where it is.
            return h.view
                ? `<button type="button" class="ins-hl is-${h.tone}" data-goto="${esc(h.view)}">${inner}<svg class="ins-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>`
                : `<div class="ins-hl is-${h.tone} is-static">${inner}</div>`;
        }).join('')}</div>`;
    }

    /** The period and the one before as two bars, the earlier one pale. */
    function compareBars(cur, prev) {
        const p = state.parts.period;
        if (!p.prev || prev === null || prev === undefined) return '';
        const max = Math.max(cur, prev, 1);
        const line = (label, v, cls) => `<span class="ins-cmp-y">${esc(label)}</span>
            <span class="ins-cmp-t">${v > 0 ? `<span class="ins-cmp-b${cls}" style="width:${P(v / max)}"></span>` : ''}</span>
            <span class="ins-cmp-v">${v}</span>`;
        const names = p.kind === 'year' ? [String(p.year - 1), p.running ? p.year + ' so far' : String(p.year)] : ['Before', '12 months'];
        return `<div class="ins-cmp" aria-hidden="true">${line(names[0], prev, ' is-prev')}${line(names[1], cur, '')}</div>`;
    }

    function overviewKpis(k) {
        const plain = (cur, prev) => {
            const p = state.parts.period;
            if (!p.prev || prev === null || !prev) return '';
            const d = (cur - prev) / prev;
            return ` <span class="${Math.abs(d) < 0.005 ? '' : (d > 0 ? 'is-up' : 'is-down')}">${signed(d)}</span>`;
        };
        return `<div class="ins-kpis is-two ins-span-12">
            ${kpi('Customers', String(k.customers), `${k.newCustomers} new, ${k.returning} returning${plain(k.customers, k.customersPrev)}`, compareBars(k.customers, k.customersPrev))}
            ${kpi('Won', `${k.won}<small>${k.won === 1 ? 'project' : 'projects'}</small>`, `${k.wonVolume ? esc(money(k.wonVolume)) + ' in orders' : 'No order yet'}${plain(k.won, k.wonPrev)}`, compareBars(k.won, k.wonPrev))}
        </div>`;
    }

    /** "+52% on 2025 to the same day": the period's revenue against the one before. */
    function revenueChange(k) {
        const p = state.parts.period;
        if (!p.prev || !k.revenuePrev) return '';
        const d = (k.revenue - k.revenuePrev) / Math.abs(k.revenuePrev);
        const cls = Math.abs(d) < 0.005 ? '' : (d > 0 ? 'is-up' : 'is-down');
        const vs = p.kind === 'year' ? 'on ' + (p.year - 1) + (p.running ? ' to the same day' : '') : 'on the 12 months before';
        return `<span class="ins-chg ${cls}">${signed(d)}</span> ${vs}, net by invoice date`;
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
        const change = revenueChange(state.parts.kpis);
        return card('ins-span-8', head(p.kind === 'year' && p.running ? 'Revenue year to date' : 'Revenue added up', change ? { html: change } : 'Net, by invoice date',
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
            ${overviewKpis(parts.kpis)}
            ${revenueCard(parts.cumulative)}
            ${quartersCard(parts.quarters)}
            ${mixCard(parts.mix)}
            ${inflowCard(parts.inflow)}`;
    }

    // ------------------------------------------------------------------
    // Sales
    // ------------------------------------------------------------------

    /**
     * From lead to order as a sankey: each stage a block in its colour, as
     * tall as the projects that reached it, centred on one line. A block is
     * stacked: on top those that went on to the next stage, with the pale
     * stream and its share leading there; below them, lighter, those still
     * open; at the foot those archived in this stage - lost in red, without
     * a reason in grey. Counts sit in their part, or beside it when it is
     * too low.
     */
    function funnelCard(f) {
        const sub = `${plural(f.entered, 'project', 'projects')} entered in this period, by the furthest stage they reached`;
        if (!f.entered) return card('ins-span-12', head('From lead to order'), empty('No projects entered in this period.'));
        const TONES = ['var(--stage-lead)', 'var(--stage-negotiation)', 'var(--stage-proposal)', 'var(--stage-progress)'];
        const PARTS = [{ key: 'open', word: 'open', cls: 'is-open' }, { key: 'unclear', word: 'no reason', cls: 'is-unclear' }, { key: 'lost', word: 'lost', cls: 'is-lost' }];
        const NW = 196;
        const GAP = 2;
        const TOP = 8;
        const MAIN = 220;
        const MID = TOP + MAIN / 2;
        const k = MAIN / f.entered;
        const h = n => (n > 0 ? Math.max(3, n * k) : 0);
        const xs = [0, 1, 2, 3].map(i => i * (1000 - NW) / 3);
        const left = x => P(x / 1000);
        const f1 = n => n.toFixed(1);

        // Each block's parts, the last stage first: a block is the next one plus what stopped here.
        const parts = f.steps.map((st, i) => (i === 3 ? [] : PARTS.map(x => Object.assign({ n: (st.stopped || {})[x.key] || 0 }, x)).filter(x => x.n)));
        const hs = [];
        for (let i = 3; i >= 0; i--) hs[i] = (i === 3 ? h(f.steps[3].reached) : hs[i + 1]) + parts[i].reduce((t, x) => t + h(x.n), 0);
        const tops = hs.map(x => MID - x / 2);

        let svg = '';
        let html = '';
        let bottom = TOP + MAIN;
        f.steps.forEach((st, i) => {
            const x = xs[i];
            const on = i < 3 ? hs[i + 1] : hs[i];
            // The part that went on, in the stage's colour; name and count in it.
            svg += `<rect x="${f1(x)}" y="${f1(tops[i])}" width="${NW}" height="${f1(Math.max(1, on - (parts[i].length ? GAP : 0)))}" style="fill:${TONES[i]}"><title>${esc(i < 3 ? `${st.name}: ${st.reached}, ${f.steps[i + 1].reached} on to ${f.steps[i + 1].name}` : `${st.name}: ${st.reached}`)}</title></rect>`;
            const inside = on >= 44;
            html += `<span class="ins-sk-stage${inside ? '' : ' is-out'}${i >= 2 ? ' is-dark' : ''}" style="left:${left(inside ? x + NW / 2 : x + NW)};top:${f1(inside ? tops[i] + on / 2 : MID)}px">${esc(st.name)}<b>${st.reached}</b></span>`;

            // Below it: still open, then archived without a reason, then lost.
            let y = tops[i] + on;
            let besideY = -Infinity;
            parts[i].forEach((part, j) => {
                const hh = h(part.n);
                const last = j === parts[i].length - 1;
                svg += `<rect class="ins-sk-part ${part.cls}" x="${f1(x)}" y="${f1(y)}" width="${NW}" height="${f1(Math.max(1, hh - (last ? 0 : GAP)))}"${part.key === 'open' ? ` style="fill:${TONES[i]}"` : ''}><title>${esc(part.n + ' ' + part.word + ' at ' + st.name)}</title></rect>`;
                const label = `<b>${part.n}</b> ${esc(part.word)}`;
                if (hh >= 18) {
                    html += `<span class="ins-sk-in ${part.cls}" style="left:${left(x + NW / 2)};top:${f1(y + (hh - (last ? 0 : GAP)) / 2)}px">${label}</span>`;
                } else {
                    besideY = Math.max(y + hh / 2, besideY + 15);
                    html += `<span class="ins-sk-side ${part.cls}" style="left:${left(x + NW)};top:${f1(besideY)}px">${label}</span>`;
                    bottom = Math.max(bottom, besideY + 9);
                }
                y += hh;
            });
            if (i === 3) return;

            // The stream on, from the top part to the whole next block.
            const sx = x + NW;
            const nx = xs[i + 1];
            const mx = (sx + nx) / 2;
            const t0 = tops[i + 1];
            const t1 = tops[i + 1] + hs[i + 1];
            svg += `<path class="ins-sk-flow" d="M${f1(sx)} ${f1(tops[i])} C${f1(mx)} ${f1(tops[i])} ${f1(mx)} ${f1(t0)} ${f1(nx)} ${f1(t0)} L${f1(nx)} ${f1(t1)} C${f1(mx)} ${f1(t1)} ${f1(mx)} ${f1(tops[i] + on)} ${f1(sx)} ${f1(tops[i] + on)} Z" style="fill:${TONES[i]}"><title>${esc(f.steps[i + 1].reached + ' on to ' + f.steps[i + 1].name)}</title></path>`;
            html += `<span class="ins-sk-rate" style="left:${left(mx)};top:${f1((tops[i] + t0) / 2 + on / 2)}px"><b>${st.next === null ? '–' : pct(st.next)}</b>${st.days === null ? '' : `<small>${esc(days(st.days))}</small>`}</span>`;
        });

        const H = Math.ceil(bottom + 10);
        return card('ins-span-12', head('From lead to order', f.unclear ? `${sub}; ${f.unclear} archived without a reason` : sub),
            `<div class="ins-sk-wrap"><div class="ins-sk" style="height:${H}px" role="img" aria-label="${esc(f.steps.map(st => st.name + ' ' + st.reached).join(', '))}">
                <svg viewBox="0 0 1000 ${H}" preserveAspectRatio="none" aria-hidden="true">${svg}</svg>
                ${html}
            </div></div>`);
    }

    /** A ring of shares, 2px apart: [{ share, color, title }]. */
    function donut(parts, center) {
        const shown = parts.filter(x => x.share > 0.0005);
        const gap = shown.length > 1 ? 0.6 : 0;
        let at = 0;
        const rings = shown.map(x => {
            const len = x.share * 100;
            const html = `<circle cx="70" cy="70" r="58" pathLength="100" stroke="${x.color}" stroke-dasharray="${Math.max(0.01, len - gap).toFixed(2)} 100" stroke-dashoffset="${(-at).toFixed(2)}"><title>${esc(x.title)}</title></circle>`;
            at += len;
            return html;
        }).join('');
        return `<div class="ins-donut" role="img" aria-label="${esc(shown.map(x => x.title).join(', '))}">
            <svg viewBox="0 0 140 140" aria-hidden="true"><circle class="ins-donut-bg" cx="70" cy="70" r="58" pathLength="100"/>${rings}</svg>
            <span class="ins-donut-c">${center}</span>
        </div>`;
    }

    /** Revenue by product as a ring; beside it each product with its won, order size and time to win. */
    function productCard(t) {
        const sub = 'Revenue invoiced and projects decided in this period';
        if (!t.rows.length) return card('ins-span-12', head('By product', sub), empty('Nothing invoiced or decided in this period.'));
        const rows = t.rows.slice().sort((a, b) => (a.name === IC.NO_PRODUCT) - (b.name === IC.NO_PRODUCT) || b.revenue - a.revenue);
        const color = r => r.color || NONE_TONE;
        const ring = donut(rows.filter(r => r.revenue > 0).map(r => ({ share: r.share || 0, color: color(r), title: r.name + ': ' + pct(r.share) + ' (' + money(r.revenue) + ')' })),
            `<b>${esc(money(t.total.revenue))}</b><small>revenue</small>`);
        const facts = r => [
            r.decided ? `${r.won} of ${r.decided} won` : (r.won ? `${r.won} won` : ''),
            r.order ? `median order ${money(r.order)}` : '',
            r.days !== null ? `${Math.round(r.days)} days to win` : ''
        ].filter(Boolean).join(', ');
        const list = rows.map(r => `<li class="ins-prow${r.name === IC.NO_PRODUCT ? ' is-none' : ''}">
            <span class="ins-prow-n">${sw(color(r))}<span>${esc(r.name)}</span></span>
            <span class="ins-prow-v">${esc(money(r.revenue))}${r.revenue > 0 && r.share !== null ? `<small>${pct(r.share)}</small>` : ''}</span>
            ${facts(r) ? `<span class="ins-prow-s">${esc(facts(r))}</span>` : ''}
        </li>`).join('');
        return card('ins-span-12', head('By product', sub), `<div class="ins-byp">${t.total.revenue > 0 ? ring : ''}<ul class="ins-plist">${list}</ul></div>`);
    }

    function renderSales(parts) {
        return `${funnelCard(parts.funnel)}
            ${productCard(parts.byProduct)}`;
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

    /**
     * Shares of a whole as a ring, the parts listed beside it: the biggest
     * in their own colour, the rest folded into one grey part whose members
     * are listed below it. slices: [{ name, net, share, nameHtml, after }].
     */
    const SLICES = ['var(--ins-c1)', 'var(--ins-c2)', 'var(--ins-c3)', 'var(--ins-c4)'];

    function shareRing(slices, rest, center, extra) {
        const total = slices.concat(rest ? [rest] : []).concat(extra ? [extra] : []);
        const ring = donut(total.map(x => ({ share: x.share || 0, color: x.color, title: x.name + ': ' + pct(x.share) + ' (' + money(x.net) + ')' })), center);
        const row = (x, cls) => `<li class="ins-sl${cls || ''}">
            <span class="ins-sl-n">${sw(x.color)}${x.nameHtml || `<span>${esc(x.name)}</span>`}</span>
            <span class="ins-sl-v">${esc(money(x.net))}<small>${pct(x.share)}</small></span>
            ${x.after ? `<span class="ins-sl-a">${x.after}</span>` : ''}
        </li>`;
        const members = rest && rest.items ? `<li class="ins-sl-more">${rest.items.slice(0, 6).map(m => `<span>${m.nameHtml || esc(m.name)} <small>${esc(money(m.net))}</small></span>`).join('')}${rest.items.length > 6 ? `<span>and ${rest.items.length - 6} more</span>` : ''}</li>` : '';
        return `<div class="ins-byp is-share">${ring}<ul class="ins-slist">${slices.map(x => row(x)).join('')}${rest ? row(rest, ' is-rest') + members : ''}${extra ? row(extra, ' is-none') : ''}</ul></div>`;
    }

    const companyName = (name, companyId) => (companyId
        ? `<button type="button" class="ins-name" data-company="${companyId}" title="${esc(name)}">${esc(name)}</button>`
        : `<span>${esc(name)}</span>`);

    function byCustomerCard(c) {
        const sub = 'Net, by invoice date';
        const paying = c.list.filter(x => x.net > 0);
        if (!paying.length) return card('ins-span-6', head('Revenue by customer', sub), empty('No invoices in this period.'));
        const whole = paying.reduce((t, x) => t + x.net, 0);
        // A fifth customer gets no colour of its own: four, and the rest together.
        const own = paying.length <= SLICES.length + 1 ? paying.length : SLICES.length;
        const slices = paying.slice(0, Math.min(own, SLICES.length)).map((x, i) => ({
            name: x.name, net: x.net, share: x.net / whole, color: SLICES[i],
            nameHtml: companyName(x.name, x.companyId) + (x.isNew ? '<span class="ins-chip">New</span>' : '')
        }));
        const others = paying.slice(slices.length);
        const restNet = others.reduce((t, x) => t + x.net, 0);
        const rest = others.length ? {
            name: others.length === 1 ? others[0].name : plural(others.length, 'other', 'others'),
            nameHtml: others.length === 1 ? companyName(others[0].name, others[0].companyId) : null,
            net: restNet, share: restNet / whole, color: 'var(--ins-rest)',
            items: others.length > 1 ? others.map(x => ({ name: x.name, net: x.net, nameHtml: companyName(x.name, x.companyId) })) : null
        } : null;
        return card('ins-span-6', head('Revenue by customer', sub),
            shareRing(slices, rest, `<b>${esc(money(whole))}</b><small>${plural(paying.length, 'customer', 'customers')}</small>`));
    }

    function newReturningCard(list) {
        if (!list.some(x => x.returning + x.fresh > 0)) return card('ins-span-4', head('New and returning', 'Revenue per quarter, by whether the customer bought before'), empty('No invoices in this period.'));
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
        return card('ins-span-4', head('New and returning', 'Revenue per quarter, by whether the customer bought before',
            legend([[sw('var(--ins-navy)'), 'Returning'], [sw('var(--ins-light)'), 'New']])), body,
            total > 0 ? `New customers brought <b>${pct(fresh / total)}</b> of revenue.` : '');
    }

    /** "+52%", "New" or "–": the last year against the one before. */
    function changeOf(r) {
        if (r.isNew) return '<span class="ins-chip">New</span>';
        if (r.change === null || r.change === undefined) return '<span class="ins-gr-x">–</span>';
        const cls = Math.abs(r.change) < 0.005 ? '' : (r.change > 0 ? 'is-up' : 'is-down');
        return `<span class="${cls}">${signed(r.change)}</span>`;
    }

    /**
     * How customers grew: per customer one bar per year, one above the
     * other on one scale, the years before pale, the last one dark; each
     * with its amount, the change on the right.
     */
    function growthCard(g) {
        const sub = 'Revenue per year, net by invoice date';
        const cls = 'ins-span-8 ins-rows-2';
        if (!g.rows.length) return card(cls, head('How customers grew', sub), empty('No invoices in these years.'));
        const n = g.years.length;
        const yearName = y => (y.running ? y.year + ' so far' : String(y.year));
        const max = Math.max.apply(null, g.rows.reduce((list, r) => list.concat(r.values), []).concat([1]));
        const bars = r => r.values.map((v, i) => {
            const zero = Math.abs(v) < 0.005;
            return `<span class="ins-gr-line" title="${esc(r.name + ', ' + yearName(g.years[i]) + ': ' + (zero ? 'nothing' : money(v)))}">
                ${zero ? '' : `<span class="ins-gr-b${i < n - 1 ? ' is-prev' : ''}" style="width:calc((100% - 72px) * ${(Math.max(0, v) / max).toFixed(4)})"></span>`}
                <span class="ins-gr-v${zero ? ' is-zero' : ''}${i < n - 1 ? ' is-prev' : ''}">${zero ? '–' : esc(money(v))}</span>
            </span>`;
        }).join('');
        const rows = g.rows.map(r => `<div class="ins-gr">
            <span class="ins-gr-n">${companyName(r.name, r.companyId)}</span>
            <div class="ins-gr-bars">${bars(r)}</div>
            ${n > 1 ? `<span class="ins-gr-c">${changeOf(r)}</span>` : ''}
        </div>`).join('');
        const lastYear = g.years[n - 1];
        const changeTitle = lastYear.running ? `${lastYear.year} so far against ${lastYear.year - 1} to the same day` : `${lastYear.year} against ${lastYear.year - 1}`;
        const total = `<div class="ins-gr is-total">
            <span class="ins-gr-n">${esc(g.more ? `All customers (${g.more} more)` : 'All customers')}</span>
            <span class="ins-gr-sum">${g.totals.map((v, i) => `<span${i < n - 1 ? ' class="is-prev"' : ''}>${esc(yearName(g.years[i]))} <b>${esc(money(v))}</b></span>`).join('')}</span>
            ${n > 1 ? `<span class="ins-gr-c" title="${esc(changeTitle)}">${changeOf({ change: g.change })}</span>` : ''}
        </div>`;
        const keys = legend(g.years.map((y, i) => [sw(i < n - 1 ? 'var(--ins-prev)' : 'var(--c-accent)'), yearName(y)]));
        return card(cls, head('How customers grew', sub, keys), `<div class="ins-grs">${rows}${total}</div>`);
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
        const sub = 'Share of revenue, by the customer\'s sector';
        if (!s.withSector) {
            return card('ins-span-6', head('By sector', sub), empty(s.anySector
                ? 'No revenue in this period from a company with a sector.'
                : 'No company has a sector yet. Add it in a company\'s sheet, under Edit.'));
        }
        const p = state.parts.period;
        const vs = p.prev ? (p.kind === 'year' ? (p.year - 1) + (p.running ? ' to the same day' : '') : 'the 12 months before') : '';
        const own = s.rows.length <= SLICES.length + 1 ? s.rows.length : SLICES.length;
        const slice = (r, color) => Object.assign({}, r, { color, after: p.prev ? changeOf(r) : '' });
        const slices = s.rows.slice(0, Math.min(own, SLICES.length)).map((r, i) => slice(r, SLICES[i]));
        const others = s.rows.slice(slices.length);
        const restNet = others.reduce((t, x) => t + x.net, 0);
        const rest = others.length === 1 ? slice(others[0], 'var(--ins-rest)')
            : others.length ? { name: plural(others.length, 'other sector', 'other sectors'), net: restNet, share: restNet / s.total, color: 'var(--ins-rest)', items: others } : null;
        const none = s.none ? Object.assign({}, s.none, { color: NONE_TONE }) : null;
        return card('ins-span-6', head('By sector', vs ? { html: `${esc(sub)}; change on ${esc(vs)}` } : sub),
            shareRing(slices, rest, `<b>${esc(money(s.total))}</b><small>${plural(s.rows.length, 'sector', 'sectors')}</small>`, none),
            none && none.share >= 0.2 ? `<b>${pct(none.share)}</b> of the revenue comes from companies without a sector.` : '');
    }

    function renderCustomers(parts) {
        // How customers grew is two rows high: New and returning and Days to payment beside it.
        return `${customerKpis(parts.customers)}
            ${byCustomerCard(parts.customers)}
            ${sectorsCard(parts.sectors)}
            ${growthCard(parts.growth)}
            ${newReturningCard(parts.newReturning)}
            ${paymentsCard(parts.payments)}`;
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
        els.page.innerHTML = `${block(96, 'ins-span-12')}<div class="ins-kpis is-two ins-span-12">${tile.repeat(2)}</div>${block(260, 'ins-span-8')}${block(260, 'ins-span-4')}`;
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
                store(PERIOD_KEY, /^year:/.test(state.period) ? 'year' : state.period);
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
