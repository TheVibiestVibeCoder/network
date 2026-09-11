/**
 * Small, quiet charts for the summary bands on Home and Projects.
 *
 * Plain HTML and CSS - no chart library, no canvas - so every chart follows
 * the theme tokens, scales with its container and needs nothing beyond what
 * the Content-Security-Policy already allows. Each chart carries a text
 * label for screen readers; the key underneath it is ordinary text.
 *
 * Everything returned is an HTML string with every piece of text escaped.
 */
(function () {
    'use strict';

    function esc(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Tones are fixed words chosen by the callers; anything else falls back to
    // the neutral tone rather than landing in a class attribute.
    const TONES = ['progress', 'proposal', 'negotiation', 'lead', 'complete',
        'high', 'medium', 'low', 'none', 'late', 'accent'];

    function tone(name) {
        return TONES.includes(name) ? name : 'none';
    }

    // A fraction for a style attribute: always a plain number between 0 and 1.
    function fraction(value, total) {
        if (!(total > 0) || !(value > 0)) return 0;
        return Math.min(1, value / total);
    }

    function fixed(value) {
        return (Math.round(value * 1000) / 1000).toString();
    }

    function percent(value, total) {
        if (!(total > 0) || !(value > 0)) return '0%';
        const pct = (value / total) * 100;
        return pct < 1 ? '<1%' : Math.round(pct) + '%';
    }

    /**
     * One bar split into parts, widths in proportion to value.
     * parts: [{ tone, value, title }]
     */
    function stack(parts, label) {
        const shown = parts.filter(part => part.value > 0);
        const total = shown.reduce((sum, part) => sum + part.value, 0);

        if (total <= 0) {
            return `<div class="kc-stack is-empty" role="img" aria-label="${esc(label)}"></div>`;
        }

        const segments = shown.map(part =>
            `<span class="kc-seg kc-tone-${tone(part.tone)}" style="flex-grow:${fixed(part.value / total * 100)}" title="${esc(part.title || '')}"></span>`
        ).join('');

        return `<div class="kc-stack" role="img" aria-label="${esc(label)}">${segments}</div>`;
    }

    /**
     * A row of columns over a short run of periods.
     * cols: [{ label, short, value, text, title, tone, current }]
     * options.min keeps a single small value from filling the whole height.
     */
    function columns(cols, label, options) {
        const floor = options && options.min ? options.min : 0;
        const max = Math.max(floor, ...cols.map(col => col.value || 0));

        const html = cols.map(col => {
            const classes = ['kc-col'];
            if (!(col.value > 0)) classes.push('is-zero');
            if (col.current) classes.push('is-current');
            if (col.tone) classes.push('kc-tone-' + tone(col.tone));

            const short = col.short || col.label;

            return `
                <span class="${classes.join(' ')}" title="${esc(col.title || '')}">
                    <span class="kc-col-plot">
                        <span class="kc-col-num">${col.value > 0 ? esc(col.text) : ''}</span>
                        <span class="kc-col-bar" style="--h:${fixed(fraction(col.value, max))}"></span>
                    </span>
                    <span class="kc-col-label"><span class="kc-long">${esc(col.label)}</span><span class="kc-short">${esc(short)}</span></span>
                </span>`;
        }).join('');

        return `<div class="kc-cols" role="img" aria-label="${esc(label)}">${html}</div>`;
    }

    /**
     * A single share of a whole, 0 to 1.
     */
    function meter(value, label) {
        const f = Math.max(0, Math.min(1, Number(value) || 0));
        return `<div class="kc-meter" role="img" aria-label="${esc(label)}"><span class="kc-meter-fill" style="--f:${fixed(f)}"></span></div>`;
    }

    /**
     * The key under a chart: a coloured dot, a name, a figure.
     * items: [{ tone, label, text }]
     */
    function legend(items) {
        const html = items.map(item => `
            <li><span class="kc-dot kc-tone-${tone(item.tone)}" aria-hidden="true"></span>${esc(item.label)}${item.text !== undefined && item.text !== '' ? ` <b>${esc(item.text)}</b>` : ''}</li>`
        ).join('');

        return `<ul class="kc-legend">${html}</ul>`;
    }

    function note(text) {
        return `<p class="kc-note">${esc(text)}</p>`;
    }

    /**
     * One tile of a summary band. label, meta, value, unit and flag are text;
     * chart and foot are HTML from the helpers above. split: the number may
     * sit beside its chart when the tile has a wide row to itself.
     */
    function tile(options) {
        const o = options || {};

        return `
            <div class="kpi${o.split ? ' kpi--split' : ''}">
                <div class="kpi-head">
                    <span class="kpi-label">${esc(o.label)}</span>
                    ${o.meta ? `<span class="kpi-meta">${esc(o.meta)}</span>` : ''}
                </div>
                <div class="kpi-value">
                    <span class="kpi-number">${esc(o.value)}</span>
                    ${o.unit ? `<span class="kpi-unit">${esc(o.unit)}</span>` : ''}
                    ${o.flag ? `<span class="kpi-flag">${esc(o.flag)}</span>` : ''}
                </div>
                <div class="kpi-chart">${o.chart || ''}</div>
                ${o.foot ? `<div class="kpi-foot">${o.foot}</div>` : ''}
            </div>`;
    }

    window.CRMCharts = { esc, fraction, fixed, percent, stack, columns, meter, legend, note, tile };
})();
