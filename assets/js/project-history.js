/**
 * A project's history in its sheet (api/projects.php?action=history):
 * the chance of success over the days since the project was created, as a
 * step line, and the stages it went through, as one bar with the time it
 * spent in each.
 *
 * window.ProjectHistory.load(projectId, section)  fills the section (#projectHistorySection)
 */
(function () {
    'use strict';

    const DAY = 86400000;
    let token = 0;

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Server timestamps are UTC ("2026-10-01 11:00:00"). */
    const time = at => new Date(String(at).replace(' ', 'T') + (String(at).length <= 19 ? 'Z' : '')).getTime();
    const day = ms => window.CRMFormat.date(new Date(ms));
    const days = n => (n === 1 ? '1 day' : `${n} days`);
    const stageClass = stage => String(stage || 'Lead').toLowerCase().replace(/ /g, '-');

    async function load(projectId, section) {
        if (!section) return;
        const mine = ++token;
        section.hidden = true;
        try {
            const response = await fetch(`api/projects.php?action=history&id=${encodeURIComponent(projectId)}`, { headers: { Accept: 'application/json' } });
            const result = await response.json();
            if (mine !== token || !response.ok || !result.data) return;
            render(result.data, section);
        } catch (e) {
            // The sheet stands without it.
        }
    }

    function render(h, section) {
        const body = section.querySelector('[data-history-body]');
        const start = time(h.created_at);
        const now = Date.now();
        const span = Math.max(1, Math.ceil((now - start) / DAY));
        const chart = chanceChart(h.chance || [], start, now, span);
        const stages = stageTimeline(h.stage || [], start, now);
        if (!chart && !stages) return;
        const rebuilt = (h.stage || []).concat(h.chance || []).some(r => r.source === 'reconstructed');
        // Side by side where there is room: the chance left, the stages right.
        body.innerHTML = `
            <div class="ph-cols">${chart}${stages}</div>
            ${rebuilt ? '<p class="ph-note">Before it was recorded: rebuilt from Claude\'s proposals and the activity log.</p>' : ''}`;
        section.hidden = false;
    }

    /** The chance over the days since the project was created: a step line. */
    function chanceChart(rows, start, now, span) {
        const points = rows.filter(r => r.value !== null && r.value !== undefined)
            .map(r => ({ d: Math.max(0, (time(r.at) - start) / DAY), v: Number(r.value), r }));
        if (!points.length) return '';
        const W = 460;
        const H = 160;
        const L = 40;
        const R = 10;
        const T = 10;
        const B = 122;
        const x = d => L + (W - L - R) * Math.min(d, span) / span;
        const y = v => B - (B - T) * Math.max(0, Math.min(100, v)) / 100;

        let path = `M ${x(points[0].d).toFixed(1)} ${y(points[0].v).toFixed(1)}`;
        for (let i = 1; i < points.length; i++) {
            path += ` H ${x(points[i].d).toFixed(1)} V ${y(points[i].v).toFixed(1)}`;
        }
        path += ` H ${x(span).toFixed(1)}`;
        const area = `${path} V ${B} H ${x(points[0].d).toFixed(1)} Z`;

        const grid = [0, 50, 100].map(v => `
            <line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="ph-grid${v === 0 ? ' is-base' : ''}"/>
            <text x="${L - 8}" y="${y(v) + 4}" class="ph-label" text-anchor="end">${v}%</text>`).join('');
        const ticks = [0, Math.round(span / 2), span].filter((v, i, a) => a.indexOf(v) === i).map((d, i, a) => `
            <text x="${x(d)}" y="${H - 6}" class="ph-label" text-anchor="${i === 0 ? 'start' : i === a.length - 1 ? 'end' : 'middle'}">${d === 0 ? 'Created' : days(d)}</text>`).join('');

        return `
            <div class="ph-block">
                <p class="ph-title">Chance</p>
                <svg class="ph-chart" viewBox="0 0 ${W} ${H}" role="img"
                     aria-label="${esc('Chance: ' + points.map(p => `${p.v}% from ${day(time(p.r.at))}`).join(', '))}">
                    ${grid}
                    <path d="${area}" class="ph-area"/>
                    <path d="${path}" class="ph-line"/>
                    ${ticks}
                </svg>
            </div>`;
    }

    /** The stages one after another: a bar by time spent, and each with its dates. */
    function stageTimeline(rows, start, now) {
        const periods = rows.filter(r => r.value).map((r, i, all) => {
            const from = Math.max(start, time(r.at));
            const to = i + 1 < all.length ? time(all[i + 1].at) : now;
            return { stage: r.value, from, to, current: i + 1 === all.length, r };
        });
        if (!periods.length) return '';
        const total = Math.max(1, periods.reduce((s, p) => s + Math.max(0, p.to - p.from), 0));
        const bar = periods.map(p => `
            <span class="ph-seg stage-${esc(stageClass(p.stage))}" style="flex-grow:${Math.max(0.01, (p.to - p.from) / total)}"
                  title="${esc(`${p.stage}: ${day(p.from)} – ${p.current ? 'today' : day(p.to)}`)}"></span>`).join('');
        const list = periods.slice().reverse().map(p => {
            const n = Math.max(0, Math.round((p.to - p.from) / DAY));
            return `
                <li class="ph-step${p.current ? ' is-current' : ''}">
                    <span class="ph-step-dot stage-${esc(stageClass(p.stage))}"></span>
                    <span class="ph-step-stage">${esc(window.CRMFormat.stage(p.stage))}</span>
                    <span class="ph-step-when">${esc(p.current ? `since ${day(p.from)}` : `${day(p.from)} – ${day(p.to)}`)}</span>
                    <span class="ph-step-days">${esc(days(n))}</span>
                </li>`;
        }).join('');
        return `
            <div class="ph-block">
                <p class="ph-title">Stages</p>
                <div class="ph-bar">${bar}</div>
                <ul class="ph-steps">${list}</ul>
            </div>`;
    }

    window.ProjectHistory = { load };
})();
