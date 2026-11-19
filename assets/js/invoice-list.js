/**
 * Our own invoices, as the Financials tab lists them.
 *
 * Nothing is kept here: the list is read from the invoice files in
 * Bookkeeping (Bookkeeping.transactions().invoices) - every file Claude read
 * (includes/InvoiceReader.php) that we issued and that carries a number. One
 * still in the drop zone is not paid yet; one filed on a bank entry was paid
 * on that entry's day. Only the reminders are stored (Financials settings,
 * invoice_reminders), by invoice number.
 *
 * Pure functions, no DOM: financials.js draws, tests/invoice-list.test.js
 * checks.
 */
(function (root) {
    'use strict';

    // Words that say what kind of company it is, not which one - as in
    // bookkeeping.js, which learns ownWord the same way.
    const NAME_NOISE = new Set(['gmbh', 'ltd', 'limited', 'inc', 'llc', 'ag', 'kg', 'og', 'eu', 'co', 'bv', 'sarl', 'se', 'srl',
        'und', 'and', 'the', 'der', 'die', 'das', 'von', 'for', 'für']);

    const round2 = n => Math.round(n * 100) / 100;

    function nameWords(name) {
        return String(name ?? '').trim().toLowerCase()
            .split(/[^a-z0-9äöüß]+/)
            .filter(word => word.length >= 3 && !NAME_NOISE.has(word));
    }

    /** One we issued: our name among the issuer's words. */
    function isOwn(invoice, ownWord) {
        return !!(invoice && ownWord && nameWords(invoice.issuer).includes(ownWord));
    }

    /** An invoice or credit note of ours with a number - a receipt or a letter is not listed. */
    function isListed(invoice, ownWord) {
        return isOwn(invoice, ownWord)
            && (invoice.kind === 'invoice' || invoice.kind === 'credit_note')
            && !!invoice.invoice_number;
    }

    /** "0015/2026" -> { seq: 15, year: 2026, width: 4 }, or null for another pattern. */
    function parseNumber(number) {
        const m = /^\s*(\d+)\s*[/\-]\s*(\d{4})\s*$/.exec(String(number || ''));
        return m ? { seq: Number(m[1]), year: Number(m[2]), width: m[1].length } : null;
    }

    function daysBetween(from, to) {
        const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
        const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
        return Math.round((b - a) / 86400000);
    }

    /**
     * Where an invoice stands:
     *   paid     paid in full, on time or without a due date
     *   late     paid in full after the due date
     *   partial  a bank entry pays less than the invoice
     *   open     sent, not due yet (or no due date)
     *   overdue  past its due date, unpaid
     *   reminded unpaid, a reminder went out
     */
    function statusOf(item, today) {
        if (item.paid) {
            if (Math.abs(item.paid.amount) + 0.01 < Math.abs(item.gross)) return 'partial';
            return item.due && item.paid.date > item.due ? 'late' : 'paid';
        }
        if (item.reminded) return 'reminded';
        return item.due && today > item.due ? 'overdue' : 'open';
    }

    /**
     * Our invoices from Bookkeeping's files, oldest number first.
     *
     * data: { files: [{ id, name, invoice, row: { id, date, amount } | null }], ownWord }
     * reminders: { "0011/2026": "2026-10-02" }
     */
    function build(data, reminders, today) {
        const ownWord = data && data.ownWord;
        const byNumber = new Map();
        ((data && data.files) || []).forEach(file => {
            const invoice = file.invoice;
            if (!isListed(invoice, ownWord)) return;
            const number = invoice.invoice_number.trim();
            const earlier = byNumber.get(number);
            // The same invoice twice (uploaded again): the one on a bank entry counts.
            if (earlier && (earlier.row || !file.row)) return;
            byNumber.set(number, file);
        });

        const items = [];
        byNumber.forEach((file, number) => {
            const invoice = file.invoice;
            const credit = invoice.kind === 'credit_note';
            const sign = credit ? -1 : 1;
            const parsed = parseNumber(number);
            const amount = file.row && file.row.amount !== null && file.row.amount !== undefined ? Number(file.row.amount) : null;
            const item = {
                id: file.id,
                file: file.name,
                number,
                seq: parsed ? parsed.seq : null,
                year: parsed ? parsed.year : (invoice.invoice_date ? Number(invoice.invoice_date.slice(0, 4)) : null),
                credit,
                date: invoice.invoice_date || null,
                due: invoice.due_date || null,
                customer: invoice.recipient || '',
                contact: invoice.contact || '',
                subject: invoice.subject || '',
                currency: invoice.currency || 'EUR',
                net: invoice.net === null || invoice.net === undefined ? null : sign * invoice.net,
                vat: invoice.vat === null || invoice.vat === undefined ? null : sign * invoice.vat,
                gross: invoice.gross === null || invoice.gross === undefined ? null : sign * invoice.gross,
                // Filed on a bank entry: paid that day, with that amount.
                paid: file.row ? { row: file.row.id, date: file.row.date, amount: amount === null ? (invoice.gross || 0) * sign : amount } : null,
                reminded: (reminders && reminders[number]) || null
            };
            if (item.gross === null) item.gross = round2((item.net || 0) + (item.vat || 0));
            item.status = statusOf(item, today);
            item.daysLate = item.due && !item.paid && today > item.due ? daysBetween(item.due, today)
                : item.due && item.paid && item.paid.date > item.due ? daysBetween(item.due, item.paid.date) : 0;
            // What is still to come in: all of it, or what a part payment left -
            // gross, and net (a part payment's share of the net).
            item.outstanding = !item.paid ? item.gross
                : item.status === 'partial' ? round2(item.gross - item.paid.amount) : 0;
            item.outstandingNet = item.net === null || !item.gross ? item.outstanding
                : round2(item.net * item.outstanding / item.gross);
            // Past its due date with money still to come in.
            item.overdue = item.outstanding > 0.005 && !!item.due && today > item.due;
            items.push(item);
        });

        return items.sort((a, b) => (a.year || 0) - (b.year || 0)
            || (a.seq === null) - (b.seq === null)
            || (a.seq || 0) - (b.seq || 0)
            || String(a.date || '').localeCompare(String(b.date || ''))
            || a.number.localeCompare(b.number));
    }

    /** The years there are invoices for, newest first. */
    function years(items) {
        return Array.from(new Set(items.map(i => i.year).filter(Boolean))).sort((a, b) => b - a);
    }

    /**
     * Numbers missing between the year's lowest and highest - an invoice
     * written but never put into Bookkeeping: ["0015/2026"].
     */
    function gaps(items, year) {
        const numbered = items.map(i => parseNumber(i.number)).filter(p => p && p.year === year);
        if (numbered.length < 2) return [];
        const have = new Set(numbered.map(p => p.seq));
        const width = numbered[0].width;
        const low = Math.min.apply(null, numbered.map(p => p.seq));
        const high = Math.max.apply(null, numbered.map(p => p.seq));
        const out = [];
        for (let n = low + 1; n < high && out.length < 50; n++) {
            if (!have.has(n)) out.push(String(n).padStart(width, '0') + '/' + year);
        }
        return out;
    }

    /**
     * Sums over a list: invoiced (net, VAT, gross), and what is still open
     * and overdue - net, as the card shows them.
     */
    function summary(items) {
        const sum = (list, f) => round2(list.reduce((s, i) => s + (Number(f(i)) || 0), 0));
        const open = items.filter(i => i.outstanding > 0.005);
        const overdue = open.filter(i => i.overdue);
        return {
            count: items.length,
            net: sum(items, i => i.net),
            vat: sum(items, i => i.vat),
            gross: sum(items, i => i.gross),
            open: { count: open.length, amount: sum(open, i => i.outstandingNet) },
            overdue: { count: overdue.length, amount: sum(overdue, i => i.outstandingNet) }
        };
    }

    /**
     * Our invoices read before the reader also took the contact and the due
     * date from the payment terms: their file ids, to be read once more.
     */
    function needsReading(data) {
        const ownWord = data && data.ownWord;
        return ((data && data.files) || [])
            .filter(file => isListed(file.invoice, ownWord) && !Object.prototype.hasOwnProperty.call(file.invoice, 'contact'))
            .map(file => file.id);
    }

    root.InvoiceList = { isOwn, parseNumber, statusOf, build, years, gaps, summary, needsReading, daysBetween };
})(typeof window !== 'undefined' ? window : globalThis);
