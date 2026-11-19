/**
 * Tests for assets/js/invoice-list.js - our own invoices on the Financials tab.
 *
 * No framework and no build step. In a terminal on macOS, with the
 * JavaScriptCore shell:
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *       assets/js/invoice-list.js tests/invoice-list.test.js
 *
 * Today is fixed at 19 November 2026.
 */
(function (root) {
    'use strict';

    const IL = root.InvoiceList;
    const TODAY = '2026-11-19';
    const results = [];

    function test(name, fn) {
        try {
            fn();
            results.push({ name, ok: true });
        } catch (e) {
            results.push({ name, ok: false, message: e && e.message ? e.message : String(e) });
        }
    }

    function eq(actual, expected, label) {
        const a = JSON.stringify(actual);
        const b = JSON.stringify(expected);
        if (a !== b) throw new Error(`${label || 'value'}: expected ${b}, got ${a}`);
    }

    let nextId = 1;
    function ours(number, date, due, recipient, net, vat, extra) {
        return Object.assign({
            kind: 'invoice', issuer: 'Disinfo Combat GmbH', recipient, contact: '', invoice_number: number,
            invoice_date: date, due_date: due, subject: 'Workshop', currency: 'EUR', net, vat, gross: net + vat
        }, extra || {});
    }
    const file = (invoice, row) => ({ id: nextId++, name: 'x.pdf', invoice, row: row || null });
    const paidOn = (date, amount) => ({ id: nextId++, date, amount });

    const files = [
        // Paid on time
        file(ours('0012/2026', '2026-10-01', '2026-10-31', 'Europäisches Parlament', 2500, 0), paidOn('2026-10-08', 2500)),
        // Paid late
        file(ours('0014/2026', '2026-10-12', '2026-10-19', 'Wiener Zeitung GmbH', 400, 80), paidOn('2026-10-29', 480)),
        // In the drop zone, past due
        file(ours('0011/2026', '2026-09-18', '2026-09-25', 'Wiener Zeitung GmbH', 2500, 500)),
        // In the drop zone, not due yet
        file(ours('0016/2026', '2026-11-16', '2026-12-16', 'Europäisches Parlament', 3200, 0)),
        // No due date, paid
        file(ours('0010/2026', '2026-09-16', null, 'Ameropa AG', 2500, 0), paidOn('2026-09-18', 2500)),
        // Not ours
        file({ kind: 'invoice', issuer: 'Adobe Systems', recipient: 'Disinfo Combat GmbH', invoice_number: 'A-1', invoice_date: '2026-10-01', net: 50, vat: 10, gross: 60 }),
        file({ kind: 'invoice', issuer: 'Hotel Alpenblick', recipient: 'Disinfo Combat GmbH', invoice_number: 'H-7', invoice_date: '2026-10-02', net: 100, vat: 10, gross: 110 }),
        // Ours, but without a number: a refund note, not an invoice we sent
        file({ kind: 'credit_note', issuer: 'Disinfo Combat GmbH', recipient: 'Markus', invoice_number: null, invoice_date: '2026-03-30', net: null, vat: null, gross: 22 })
    ];
    const data = { files, ownWord: 'disinfo' };

    test('lists only our numbered invoices, by number', () => {
        const items = IL.build(data, {}, TODAY);
        eq(items.map(i => i.number), ['0010/2026', '0011/2026', '0012/2026', '0014/2026', '0016/2026']);
    });

    test('status from the bank entry and the due date', () => {
        const by = Object.fromEntries(IL.build(data, {}, TODAY).map(i => [i.number, i.status]));
        eq(by, { '0010/2026': 'paid', '0011/2026': 'overdue', '0012/2026': 'paid', '0014/2026': 'late', '0016/2026': 'open' });
    });

    test('a reminder marks an unpaid invoice, and is kept by number', () => {
        const items = IL.build(data, { '0011/2026': '2026-10-02', '0012/2026': '2026-10-05' }, TODAY);
        eq(items.find(i => i.number === '0011/2026').status, 'reminded');
        eq(items.find(i => i.number === '0011/2026').reminded, '2026-10-02');
        // Paid anyway: paid wins.
        eq(items.find(i => i.number === '0012/2026').status, 'paid');
    });

    test('days late: unpaid until today, paid until the payment', () => {
        const items = IL.build(data, {}, TODAY);
        eq(items.find(i => i.number === '0011/2026').daysLate, 55);
        eq(items.find(i => i.number === '0014/2026').daysLate, 10);
        eq(items.find(i => i.number === '0012/2026').daysLate, 0);
    });

    test('a part payment leaves the rest outstanding', () => {
        const items = IL.build({ ownWord: 'disinfo', files: [
            file(ours('0004/2026', '2026-06-10', '2026-06-24', 'Caritas', 10000, 2000), paidOn('2026-06-12', 6000))
        ] }, {}, TODAY);
        eq(items[0].status, 'partial');
        eq(items[0].outstanding, 6000);
    });

    test('the same invoice twice: the copy on a bank entry counts', () => {
        const items = IL.build({ ownWord: 'disinfo', files: [
            file(ours('0005/2026', '2026-07-01', null, 'FREDA', 2800, 560)),
            file(ours('0005/2026', '2026-07-01', null, 'FREDA', 2800, 560), paidOn('2026-07-03', 3360))
        ] }, {}, TODAY);
        eq(items.length, 1);
        eq(items[0].status, 'paid');
    });

    test('a credit note counts against the sums', () => {
        const items = IL.build({ ownWord: 'disinfo', files: [
            file(ours('0001/2026', '2026-02-02', null, 'A', 1000, 200)),
            file(ours('0002/2026', '2026-02-10', null, 'A', 300, 60, { kind: 'credit_note' }))
        ] }, {}, TODAY);
        const s = IL.summary(items);
        eq([s.net, s.vat, s.gross], [700, 140, 840]);
    });

    test('gaps in the numbering are found', () => {
        const items = IL.build(data, {}, TODAY);
        eq(IL.gaps(items, 2026), ['0013/2026', '0015/2026']);
        eq(IL.gaps(items, 2025), []);
    });

    test('summary: open and overdue', () => {
        const s = IL.summary(IL.build(data, {}, TODAY));
        eq(s.count, 5);
        eq(s.open, { count: 2, amount: 6200 });
        eq(s.overdue, { count: 1, amount: 3000 });
        eq(s.gross, 2500 + 3000 + 2500 + 480 + 3200);
    });

    test('years, newest first', () => {
        const items = IL.build({ ownWord: 'disinfo', files: [
            file(ours('0009/2025', '2025-12-01', null, 'A', 1, 0)),
            file(ours('0001/2026', '2026-01-10', null, 'A', 1, 0))
        ] }, {}, TODAY);
        eq(IL.years(items), [2026, 2025]);
    });

    test('our invoices read before "contact" existed are read again', () => {
        const old = ours('0003/2026', '2026-05-27', '2026-06-26', 'EP', 3500, 0);
        delete old.contact;
        const f = file(old);
        eq(IL.needsReading({ ownWord: 'disinfo', files: [f, files[0], files[5]] }), [f.id]);
    });

    test('without our name known nothing is listed', () => {
        eq(IL.build({ files, ownWord: null }, {}, TODAY), []);
    });

    const failed = results.filter(r => !r.ok);
    const out = results.map(r => (r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '\n       ' + r.message)).join('\n')
        + `\n\n${results.length - failed.length}/${results.length} passed`;
    if (typeof print === 'function') print(out);
    else if (typeof console !== 'undefined') console.log(out);
})(typeof window !== 'undefined' ? window : globalThis);
