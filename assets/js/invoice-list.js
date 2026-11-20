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

    // ------------------------------------------------------------------
    // Invoices from before Bookkeeping (the archive, InvoiceArchive.php)
    // ------------------------------------------------------------------

    /**
     * Archived invoices as list items, the same shape build() gives. Paid on
     * the paid date the invoice list carries; amounts are signed already.
     */
    function fromArchive(rows, reminders, today) {
        return (rows || []).map(row => {
            const number = String(row.invoice_number || '').trim();
            const parsed = parseNumber(number);
            const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
            const item = {
                id: 'a' + row.id,
                archiveId: row.id,
                archived: true,
                file: null,
                number,
                seq: parsed ? parsed.seq : null,
                year: parsed ? parsed.year : (row.invoice_date ? Number(row.invoice_date.slice(0, 4)) : null),
                credit: row.kind === 'credit_note',
                date: row.invoice_date || null,
                due: row.due_date || null,
                customer: row.customer || '',
                contact: row.contact || '',
                subject: row.subject || '',
                currency: 'EUR',
                net: num(row.net),
                vat: num(row.vat),
                gross: num(row.gross),
                paid: null,
                reminded: (reminders && reminders[number]) || null
            };
            if (item.gross === null) item.gross = round2((item.net || 0) + (item.vat || 0));
            if (row.paid_date) item.paid = { row: null, date: row.paid_date, amount: item.gross };
            item.status = statusOf(item, today);
            item.daysLate = item.due && !item.paid && today > item.due ? daysBetween(item.due, today)
                : item.due && item.paid && item.paid.date > item.due ? daysBetween(item.due, item.paid.date) : 0;
            item.outstanding = item.paid || item.credit ? 0 : item.gross;
            item.outstandingNet = item.paid || item.credit ? 0 : (item.net === null ? item.gross : item.net);
            item.overdue = item.outstanding > 0.005 && !!item.due && today > item.due;
            return item;
        });
    }

    /**
     * Bookkeeping's invoices and the archived ones in one list, oldest
     * number first. An invoice in both counts once, from Bookkeeping.
     */
    function merge(fromBookkeeping, archived) {
        const known = new Set(fromBookkeeping.map(i => i.number));
        return fromBookkeeping.concat(archived.filter(i => !known.has(i.number)))
            .sort((a, b) => (a.year || 0) - (b.year || 0)
                || (a.seq === null) - (b.seq === null)
                || (a.seq || 0) - (b.seq || 0)
                || String(a.date || '').localeCompare(String(b.date || ''))
                || a.number.localeCompare(b.number));
    }

    /** "16.000,00 €" -> 16000; "-1.250,5" -> -1250.5; '' -> null. */
    function parseAmount(text) {
        let t = String(text == null ? '' : text).replace(/[€\s ]/g, '').replace(/[−–]/g, '-');
        if (!t) return null;
        if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.');
        const n = Number(t);
        return Number.isFinite(n) ? n : NaN;
    }

    /** "08.09.2026" -> "2026-09-08", '' -> null, anything else -> false. */
    function parseDay(text) {
        const t = String(text == null ? '' : text).trim();
        if (!t) return null;
        let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
        if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
        return m ? t : false;
    }

    /**
     * Rows pasted from Livio's invoice list (tab-separated, the columns of
     * the rechnungszeile skill): number, date, due, status, paid on,
     * customer, contact, subject, net, VAT, gross. A header line is skipped.
     * Returns { rows, errors: ["Line 3: ..."] }.
     */
    function parseListRows(text) {
        const rows = [];
        const errors = [];
        String(text || '').split(/\r?\n/).forEach((line, i) => {
            if (!line.trim()) return;
            const cells = line.split('\t').map(c => c.trim());
            if (i === 0 && !parseNumber(cells[0]) && /rechnung|number|nr/i.test(cells[0])) return;
            const at = `Line ${i + 1}`;
            if (cells.length < 9) {
                errors.push(`${at}: ${cells.length} columns, expected 11 (tab-separated)`);
                return;
            }
            const [number, date, due, status, paidOn, customer, contact, subject, net, vat, gross] = cells;
            const days = { date: parseDay(date), due: parseDay(due), paid: parseDay(paidOn) };
            const amounts = { net: parseAmount(net), vat: parseAmount(vat), gross: parseAmount(gross) };
            if (!number) { errors.push(`${at}: no invoice number`); return; }
            if (Object.values(days).some(d => d === false)) { errors.push(`${at}: a date is not DD.MM.YYYY`); return; }
            if (Object.values(amounts).some(n => Number.isNaN(n))) { errors.push(`${at}: an amount is not a number`); return; }
            rows.push({
                invoice_number: number,
                invoice_date: days.date,
                due_date: days.due,
                // "Versendet" with no date is open; a paid status needs its day.
                paid_date: days.paid,
                status: status || '',
                customer: customer || '',
                contact: contact || '',
                subject: subject || '',
                net: amounts.net,
                vat: amounts.vat,
                gross: amounts.gross
            });
        });
        return { rows, errors };
    }

    // ------------------------------------------------------------------
    // Which company and project an invoice belongs to
    // ------------------------------------------------------------------

    const COMPANY_NOISE = new Set(['gmbh', 'ltd', 'limited', 'inc', 'llc', 'ag', 'kg', 'og', 'eu', 'co', 'bv', 'sarl', 'se', 'srl',
        'mbh', 'gesmbh', 'gesellschaft', 'ug', 'ev', 'und', 'and', 'the', 'der', 'die', 'das', 'von', 'for', 'für']);

    /** "Disinfo Combat GmbH" -> "disinfocombat", as Company::nameKey. */
    function companyKey(name) {
        const words = String(name || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        const kept = words.filter(w => !COMPANY_NOISE.has(w));
        return (kept.length ? kept : words).join('');
    }

    /** The company an invoice's customer name is: the same name, or the one name inside the other. */
    function matchCompany(customer, companies) {
        const key = companyKey(customer);
        if (!key) return null;
        const exact = companies.filter(c => companyKey(c.name) === key);
        if (exact.length === 1) return exact[0];
        if (exact.length > 1) return null;
        const near = companies.filter(c => {
            const k = companyKey(c.name);
            return k.length >= 4 && key.length >= 4 && (k.indexOf(key) >= 0 || key.indexOf(k) >= 0);
        });
        return near.length === 1 ? near[0] : null;
    }

    const WORD_NOISE = new Set(['und', 'and', 'the', 'der', 'die', 'das', 'für', 'for', 'mit', 'von', 'zur', 'zum', 'auftrag',
        'rechnung', 'teilrechnung', 'akonto', 'online', 'std', 'min']);
    const wordsOf = text => new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
        .filter(w => w.length >= 3 && !WORD_NOISE.has(w) && !/^\d+$/.test(w)));

    /**
     * The project an invoice belongs to, among its company's projects: the
     * only one, or the one that fits clearly best - words of the subject in
     * the project's name, the net amount among its payments or budget, the
     * date within its run. Null when nothing or more than one fits.
     */
    function matchProject(item, projects, companyId) {
        if (!companyId) return null;
        const own = (projects || []).filter(p => p.review_status !== 'pending'
            && (p.companies || []).some(c => Number(c.id) === Number(companyId)));
        if (own.length <= 1) return own[0] || null;

        const words = wordsOf(item.subject);
        const net = Math.abs(Number(item.net) || 0);
        const scored = own.map(p => {
            let score = 0;
            wordsOf(p.name).forEach(w => { if (words.has(w)) score += 2; });
            const payments = Array.isArray(p.payments) ? p.payments : [];
            if (net && payments.some(x => Math.abs(Number(x.amount) - net) < 1)) score += 3;
            if (net && [p.budget_min, p.budget_max].some(b => b !== null && b !== '' && Math.abs(Number(b) - net) < 1)) score += 2;
            if (item.date && p.start_date) {
                const end = p.estimated_completion || p.start_date;
                if (daysBetween(p.start_date, item.date) >= -30 && daysBetween(end, item.date) <= 120) score += 1;
            }
            return { p, score };
        }).sort((a, b) => b.score - a.score);
        return scored[0].score > 0 && scored[0].score > scored[1].score ? scored[0].p : null;
    }

    /**
     * Each invoice with its company and project: { company: { id, name,
     * auto } | null, project: { id, name, auto } | null }. A link made by
     * hand wins (links[number]: an id, or 0 for none); without one the
     * customer's name finds the company, and the company's projects the
     * project. A project linked by hand brings its company along when the
     * name found none.
     */
    function attach(items, ctx) {
        const companies = (ctx && ctx.companies) || [];
        const projects = (ctx && ctx.projects) || [];
        const links = (ctx && ctx.links) || {};
        const companyById = new Map(companies.map(c => [Number(c.id), c]));
        const projectById = new Map(projects.map(p => [Number(p.id), p]));
        return items.map(item => {
            const link = links[item.number] || {};
            let company = null;
            if (link.company_id) {
                const c = companyById.get(Number(link.company_id));
                if (c) company = { id: Number(c.id), name: c.name, auto: false };
            } else if (link.company_id !== 0) {
                const c = matchCompany(item.customer, companies);
                if (c) company = { id: Number(c.id), name: c.name, auto: true };
            }
            let project = null;
            if (link.project_id) {
                const p = projectById.get(Number(link.project_id));
                if (p) project = { id: Number(p.id), name: p.name, auto: false };
            } else if (link.project_id !== 0 && company) {
                const p = matchProject(item, projects, company.id);
                if (p) project = { id: Number(p.id), name: p.name, auto: true };
            }
            if (!company && link.company_id !== 0 && project) {
                const p = projectById.get(project.id);
                const first = p && p.companies && p.companies.length === 1 ? p.companies[0] : null;
                if (first) company = { id: Number(first.id), name: first.name, auto: true };
            }
            return Object.assign({}, item, { company, project });
        });
    }

    /**
     * What we have with one company, from its invoices (attach() first):
     * how much, since when, how fast it pays, what is open, per year, and
     * its share of all we invoiced.
     */
    function companyStats(items, companyId) {
        const mine = items.filter(i => i.company && Number(i.company.id) === Number(companyId));
        const sumNet = list => round2(list.reduce((s, i) => s + (Number(i.net) || 0), 0));
        const invoices = mine.filter(i => !i.credit);
        const paid = invoices.filter(i => i.paid && i.paid.date && i.date);
        const days = paid.map(i => daysBetween(i.date, i.paid.date));
        const late = paid.filter(i => i.due && i.paid.date > i.due);
        const byYear = new Map();
        mine.forEach(i => { if (i.year) byYear.set(i.year, round2((byYear.get(i.year) || 0) + (Number(i.net) || 0))); });
        const total = sumNet(items);
        const dates = mine.map(i => i.date).filter(Boolean).sort();
        return {
            count: invoices.length,
            net: sumNet(mine),
            since: dates[0] || null,
            paidCount: paid.length,
            avgDays: days.length ? days.reduce((s, d) => s + d, 0) / days.length : null,
            lateCount: late.length,
            avgLate: late.length ? late.reduce((s, i) => s + daysBetween(i.due, i.paid.date), 0) / late.length : 0,
            open: round2(mine.reduce((s, i) => s + (i.outstanding > 0.005 ? i.outstandingNet : 0), 0)),
            overdue: round2(mine.reduce((s, i) => s + (i.overdue ? i.outstandingNet : 0), 0)),
            years: Array.from(byYear.entries()).sort((a, b) => a[0] - b[0]).map(([year, net]) => ({ year, net })),
            share: total > 0.005 && mine.length ? sumNet(mine) / total : null
        };
    }

    root.InvoiceList = {
        isOwn, parseNumber, statusOf, build, years, gaps, summary, needsReading, daysBetween,
        fromArchive, merge, parseAmount, parseDay, parseListRows,
        companyKey, matchCompany, matchProject, attach, companyStats
    };
})(typeof window !== 'undefined' ? window : globalThis);
