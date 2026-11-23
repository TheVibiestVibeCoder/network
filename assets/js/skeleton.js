/**
 * Loading placeholders, shared by every page (styles: "Loading placeholders"
 * at the end of design.css).
 *
 * A page draws its placeholders with its own markup - the same cards, rows
 * and classes as the real content - and puts these shapes where the text and
 * controls will be, so the layout does not move when the data arrives.
 */
(function () {
    'use strict';

    // Widths that vary from row to row, so a list does not look like a grid.
    const WIDTHS = ['62%', '48%', '71%', '55%', '66%', '44%', '58%'];

    const Skel = {
        /** A placeholder inside a line of text, as wide as given ('120px', '60%'). */
        text(width) {
            return `<span class="skel is-text" style="width:${width}" aria-hidden="true"></span>`;
        },

        /** A block of its own size, e.g. a button, a chart or an avatar. */
        block(width, height, extra) {
            return `<span class="skel${extra ? ' ' + extra : ''}" style="width:${width};height:${height}" aria-hidden="true"></span>`;
        },

        /** A circle of the given size. */
        round(size) {
            return Skel.block(size, size, 'is-round');
        },

        /** The i-th of a set of varied widths, optionally scaled (0.6 = 60% of it). */
        width(i, scale) {
            const w = parseFloat(WIDTHS[i % WIDTHS.length]);
            return Math.round(w * (scale || 1)) + '%';
        },

        /** n copies of a row, each told its index. */
        rows(n, row) {
            return Array.from({ length: n }, (_, i) => row(i)).join('');
        },

        /** What a screen reader hears instead of the shapes. */
        label(text) {
            return `<span class="sr-only">${text || 'Loading'}</span>`;
        }
    };

    window.Skel = Skel;
})();
