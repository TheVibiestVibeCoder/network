/**
 * How the CRM writes amounts and dates - one way each, everywhere.
 *
 * Amounts: the German way, the euro sign after - "12.000 €", "1.950,50 €"
 * (cents only when there are any, unless asked for), "4.000 – 10.000 €",
 * "+1.200 €", "−300 €" (a real minus sign).
 *
 * Dates: the month by its short name - "Sep 19" in the current year,
 * "Sep 19, 2025" in any other. With a time, the 24-hour clock: "Sep 19,
 * 13:55". Recent moments relative: "Just now", "5 minutes ago", "3 hours
 * ago", "Yesterday", "4 days ago"; after a week the date.
 *
 * Plain functions on window.CRMFormat; loaded right after amount-input.js,
 * before everything that draws.
 */
(function (root) {
    'use strict';

    const MINUS = '−';
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // ------------------------------------------------------------------
    // Amounts
    // ------------------------------------------------------------------

    function toNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * 1234.5 -> "1.234,50 €". Options: cents 'auto' (default: only when
     * there are any), 'always' or 'never'; sign: true for "+" on positives;
     * unit: false to leave the euro sign off. null -> ''.
     */
    function amount(value, options = {}) {
        const n = toNumber(value);
        if (n === null) return '';

        const mode = options.cents || 'auto';
        const rounded = mode === 'never' ? Math.round(n) : Math.round(n * 100) / 100;
        const abs = Math.abs(rounded);
        const cents = mode === 'always' || (mode === 'auto' && Math.round(abs * 100) % 100 !== 0);
        const digits = abs.toLocaleString('de-DE', {
            minimumFractionDigits: cents ? 2 : 0,
            maximumFractionDigits: cents ? 2 : 0
        });

        let sign = '';
        if (rounded < 0) sign = MINUS;
        else if (options.sign && rounded > 0) sign = '+';

        return sign + digits + (options.unit === false ? '' : ' €');
    }

    /** "4.000 – 10.000 €"; one end missing or both equal -> that amount. */
    function amountRange(min, max, options = {}) {
        const a = toNumber(min);
        const b = toNumber(max);
        if (a === null && b === null) return '';
        if (a === null || b === null || a === b) return amount(a === null ? b : a, options);
        return amount(a, Object.assign({}, options, { unit: false })) + ' – ' + amount(b, options);
    }

    /** For a chart axis, where space is short: "60k €", "1,2M €", "950 €". */
    function amountShort(value) {
        const n = toNumber(value);
        if (n === null) return '';
        const abs = Math.abs(n);
        const sign = n < 0 ? MINUS : '';
        const one = v => (Math.round(v * 10) / 10).toLocaleString('de-DE', { maximumFractionDigits: 1 });
        if (abs >= 999500) return sign + one(abs / 1e6) + 'M €';
        if (abs >= 1000) return sign + one(abs / 1000) + 'k €';
        return sign + Math.round(abs) + ' €';
    }

    // ------------------------------------------------------------------
    // Dates
    // ------------------------------------------------------------------

    /**
     * A Date from what the API and imports hand over:
     *   "2026-09-19"            a calendar day, taken as that local day
     *   "2026-09-19 13:55:00"   a database timestamp, which is UTC
     *   "2026-09-19T13:55:00Z"  as written
     *   "19.09.2026"            a bank statement's day
     * Anything unreadable -> null.
     */
    function toDate(value) {
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
        if (value === null || value === undefined || value === '') return null;
        const text = String(value).trim();

        let m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

        m = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));

        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)) {
            const d = new Date(text.replace(' ', 'T') + 'Z');
            return Number.isNaN(d.getTime()) ? null : d;
        }

        const d = new Date(text);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    /** True for a plain calendar day ("2026-09-19", "19.09.2026"). */
    function isDayOnly(value) {
        return typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})$/.test(value.trim());
    }

    /**
     * "Sep 19" this year, "Sep 19, 2025" otherwise. Options: year: true to
     * always show it; weekday: true for "Fri, Sep 19".
     */
    function date(value, options = {}) {
        const d = toDate(value);
        if (!d) return '';
        const showYear = options.year || d.getFullYear() !== new Date().getFullYear();
        return (options.weekday ? WEEKDAYS[d.getDay()] + ', ' : '')
            + MONTHS[d.getMonth()] + ' ' + d.getDate()
            + (showYear ? ', ' + d.getFullYear() : '');
    }

    /** "Sep 1 – Nov 13", "Dec 1, 2026 – Feb 8, 2027", or one end. */
    function dateRange(start, end) {
        const a = toDate(start);
        const b = toDate(end);
        if (!a && !b) return '';
        if (!a) return 'Until ' + date(b);
        if (!b) return 'From ' + date(a);
        const sameYear = a.getFullYear() === b.getFullYear();
        const left = sameYear ? MONTHS[a.getMonth()] + ' ' + a.getDate() : date(a, { year: true });
        return left + ' – ' + date(b, { year: !sameYear || b.getFullYear() !== new Date().getFullYear() });
    }

    /** "13:55" */
    function time(value) {
        const d = toDate(value);
        if (!d) return '';
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    /** "Sep 19, 13:55" (a calendar day alone stays a date). */
    function dateTime(value) {
        const d = toDate(value);
        if (!d) return '';
        if (isDayOnly(value)) return date(d);
        return date(d) + ', ' + time(d);
    }

    /** "Nov 2026" */
    function month(value) {
        const d = toDate(value);
        return d ? MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '';
    }

    /** "Just now", "5 minutes ago", "Yesterday", "4 days ago", then the date. */
    function ago(value) {
        const d = toDate(value);
        if (!d) return '';
        const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
        if (seconds < 60) return 'Just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes === 1 ? '1 minute ago' : minutes + ' minutes ago';
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours === 1 ? '1 hour ago' : hours + ' hours ago';
        const days = Math.floor(hours / 24);
        if (days === 1) return 'Yesterday';
        if (days < 7) return days + ' days ago';
        return date(d);
    }

    root.CRMFormat = {
        MINUS, MONTHS,
        amount, amountRange, amountShort,
        toDate, date, dateRange, time, dateTime, month, ago
    };
})(typeof window !== 'undefined' ? window : this);
