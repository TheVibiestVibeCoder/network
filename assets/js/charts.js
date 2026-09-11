/**
 * Small, quiet charts for the summary bands on Home and Projects.
 *
 * Plain HTML and CSS - no chart library, no canvas - so every chart follows
 * the theme tokens, scales with its container and needs nothing beyond what
 * the Content-Security-Policy already allows. Each chart carries a text
 * label for screen readers; the key above it is ordinary text.
 *
 * Every tile has the same four rows - label, number, key, chart - so the
 * tiles of a band line up with each other whatever they show. Text that has
 * a shorter form (for a narrow tile) is given as { long, short }.
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
        'high', 'medium', 'low', 'none', 'accent'];

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
     * Text with an optional shorter form for narrow tiles. Accepts a string
     * or { long, short }.
     */
    function text(value) {
        if (value && typeof value === 'object') {
            const long = esc(value.long);
            if (value.short === undefined || value.short === value.long) return long;
            return `<span class="kc-long">${long}</span><span class="kc-short">${esc(value.short)}</span>`;
        }
        return esc(value);
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
     * Columns over a short run of periods, and the letters that name them.
     * cols: [{ letter, value, title, current }]
     * options.min keeps a single small value from filling the whole height.
     * Returns { axis, bars }: the letters go in the key row, the columns in
     * the chart row, on the same grid so each letter sits over its column.
     */
    function columns(cols, label, options) {
        const floor = options && options.min ? options.min : 0;
        const max = Math.max(floor, ...cols.map(col => col.value || 0));

        const axis = cols.map(col =>
            `<span${col.current ? ' class="is-current"' : ''}>${esc(col.letter)}</span>`
        ).join('');

        const bars = cols.map(col => {
            const classes = ['kc-col'];
            if (!(col.value > 0)) classes.push('is-zero');
            if (col.current) classes.push('is-current');

            return `<span class="${classes.join(' ')}" title="${esc(col.title || '')}"><span class="kc-col-bar" style="--h:${fixed(fraction(col.value, max))}"></span></span>`;
        }).join('');

        return {
            axis: `<div class="kc-axis" aria-hidden="true">${axis}</div>`,
            bars: `<div class="kc-cols" role="img" aria-label="${esc(label)}">${bars}</div>`
        };
    }

    /**
     * A single share of a whole, 0 to 1.
     */
    function meter(value, label) {
        const f = Math.max(0, Math.min(1, Number(value) || 0));
        return `<div class="kc-meter" role="img" aria-label="${esc(label)}"><span class="kc-meter-fill" style="--f:${fixed(f)}"></span></div>`;
    }

    /**
     * The key: a coloured dot, a name, a figure. On one line; entries that
     * do not fit are left out whole rather than cut, and narrow tiles drop
     * the names and keep dot and figure.
     * items: [{ tone, label, text }]
     */
    function legend(items) {
        const html = items.map(item => `<li><span class="kc-dot kc-tone-${tone(item.tone)}" aria-hidden="true"></span><span class="kc-legend-name">${esc(item.label)}</span><b>${esc(item.text)}</b></li>`).join('');

        return `<ul class="kc-legend">${html}</ul>`;
    }

    function note(value) {
        return `<span class="kc-note">${text(value)}</span>`;
    }

    /**
     * One tile of a summary band.
     * label, value, flag: text or { long, short }. meta, unit: text.
     * key and chart: HTML from the helpers above.
     */
    function tile(o) {
        return `
            <div class="kpi">
                <div class="kpi-head">
                    <span class="kpi-label">${text(o.label)}</span>
                    ${o.meta ? `<span class="kpi-meta">${esc(o.meta)}</span>` : ''}
                </div>
                <div class="kpi-value">
                    <span class="kpi-number">${text(o.value)}</span>
                    ${o.unit ? `<span class="kpi-unit">${esc(o.unit)}</span>` : ''}
                    ${o.flag ? `<span class="kpi-flag">${text(o.flag)}</span>` : ''}
                </div>
                <div class="kpi-key">${o.key || ''}</div>
                <div class="kpi-chart">${o.chart || ''}</div>
            </div>`;
    }

    window.CRMCharts = { esc, fraction, fixed, percent, stack, columns, meter, legend, note, tile };
})();
