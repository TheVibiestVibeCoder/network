/**
 * Amounts as people type and paste them.
 *
 * A browser number field takes "1234.56" and nothing else, so pasting
 * "1.234,56" or "1,234.56" from a bank statement or an invoice fails. Every
 * money field in the CRM is a plain text field marked data-amount instead;
 * parse() reads what is in it, and leaving the field shows the amount the
 * German way ("1.234,56"), so it is clear what was understood.
 *
 * Pure parse/format on top (tested in tests/amount-input.test.js), the
 * page wiring below.
 */
(function (root) {
    'use strict';

    /**
     * "1.234,56", "1,234.56", "1234,5", "1 234", "€ 1.234", "-500" -> a
     * number; '' -> null; anything that is not an amount -> NaN.
     *
     * With both separators, the last one is the decimal point. With only
     * one kind: used more than once, or followed by exactly three digits,
     * it groups thousands ("1.234" = 1234, "1,234" = 1234); otherwise it is
     * the decimal point ("1234,5", "12.50").
     */
    function parse(raw) {
        let s = String(raw == null ? '' : raw)
            .replace(/[€\s  ']/g, '')
            .replace(/^EUR|EUR$/i, '')
            .replace(/[−–]/g, '-');
        if (s === '') return null;

        let sign = 1;
        if (/^-/.test(s)) { sign = -1; s = s.slice(1); }
        else if (/^\+/.test(s)) { s = s.slice(1); }
        if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return NaN;

        const lastDot = s.lastIndexOf('.');
        const lastComma = s.lastIndexOf(',');
        let decimal = null;
        if (lastDot >= 0 && lastComma >= 0) {
            decimal = lastDot > lastComma ? '.' : ',';
        } else if (lastDot >= 0 || lastComma >= 0) {
            const sep = lastDot >= 0 ? '.' : ',';
            const count = s.split(sep).length - 1;
            const after = s.length - s.lastIndexOf(sep) - 1;
            decimal = (count > 1 || after === 3) ? null : sep;
        }

        let intPart = s;
        let fracPart = '';
        if (decimal) {
            const at = s.lastIndexOf(decimal);
            intPart = s.slice(0, at);
            fracPart = s.slice(at + 1);
            if (/[.,]/.test(fracPart)) return NaN;
        }
        // Thousands groups must be groups of three.
        const groups = intPart.split(/[.,]/);
        if (groups.length > 1 && (groups[0] === '' || groups.slice(1).some(g => g.length !== 3))) return NaN;

        const n = parseFloat(groups.join('') + (fracPart ? '.' + fracPart : ''));
        return Number.isFinite(n) ? sign * n : NaN;
    }

    /** 1234.5 -> "1.234,50"; 1234 -> "1.234"; null -> ''. */
    function format(n) {
        if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '';
        const v = Math.round(Number(n) * 100) / 100;
        const cents = Math.round(Math.abs(v) * 100) % 100 !== 0;
        return v.toLocaleString('de-DE', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
    }

    /** What a data-amount field holds: a number, null when empty, NaN when unreadable. */
    function read(input) {
        return input ? parse(input.value) : null;
    }

    root.CRMAmount = { parse, format, read };

    // ------------------------------------------------------------------
    // Page wiring: tidy the amount when the field is left
    // ------------------------------------------------------------------

    if (typeof document === 'undefined') return;

    document.addEventListener('focusout', e => {
        const input = e.target;
        if (!input || !input.matches || !input.matches('input[data-amount]')) return;
        const n = parse(input.value);
        if (n === null) {
            input.classList.remove('is-invalid');
        } else if (Number.isNaN(n)) {
            input.classList.add('is-invalid');
        } else {
            input.classList.remove('is-invalid');
            const tidy = format(n);
            if (tidy !== input.value) {
                input.value = tidy;
                // Listeners that recompute on typing see the tidied value too.
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    });

    document.addEventListener('input', e => {
        const input = e.target;
        if (input && input.matches && input.matches('input[data-amount].is-invalid') && !Number.isNaN(parse(input.value))) {
            input.classList.remove('is-invalid');
        }
    });
})(typeof window !== 'undefined' ? window : globalThis);
