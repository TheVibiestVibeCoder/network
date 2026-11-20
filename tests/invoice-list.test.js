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
        eq(items[0].outstandingNet, 5000);
        eq(items[0].overdue, true);
        eq(IL.summary(items).overdue, { count: 1, amount: 5000 });
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

    test('summary: open and overdue, net', () => {
        const s = IL.summary(IL.build(data, {}, TODAY));
        eq(s.count, 5);
        eq(s.open, { count: 2, amount: 5700 });
        eq(s.overdue, { count: 1, amount: 2500 });
        eq(s.gross, 2500 + 3000 + 2500 + 480 + 3200);
    });

    test('overdue: unpaid past the due date, reminded or not', () => {
        const by = Object.fromEntries(IL.build(data, { '0011/2026': '2026-10-02' }, TODAY).map(i => [i.number, i.overdue]));
        eq(by, { '0010/2026': false, '0011/2026': true, '0012/2026': false, '0014/2026': false, '0016/2026': false });
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

    // ---- The archive, links and company figures ----

    const pasted = [
        'Rechnungsnummer\tRechnungsdatum\tFälligkeit\tZahlstatus\tZahldatum\tKundenname\tKontakt\tBetreff\tSumme netto\tUSt\tSumme brutto',
        '0003/2025\t10.03.2025\t24.03.2025\tFristgerecht bezahlt\t20.03.2025\tWiener Zeitung GmbH\tKatharina Hahn\tWorkshop "Desinformation"\t2.500,00 €\t500,00 €\t3.000,00 €',
        '0004/2025\t01.04.2025\t15.04.2025\tVerspätet bezahlt\t05.05.2025\tAmeropa AG\tLisa Steiner\tRisk Briefing\t11.200,00 €\t0,00 €\t11.200,00 €',
        '0005/2025\t02.12.2025\t16.12.2025\tVersendet\t\tWiener Zeitung GmbH\t\tVortrag\t1.000,00 €\t200,00 €\t1.200,00 €',
        '0006/2025\t13.12.2025\t\tVersendet\t\tX\t\tbad\tzwölf\t\t'
    ].join('\n');

    test('rows pasted from the invoice list are read, a header and a bad line aside', () => {
        const r = IL.parseListRows(pasted);
        eq(r.rows.map(x => x.invoice_number), ['0003/2025', '0004/2025', '0005/2025']);
        eq([r.rows[1].invoice_date, r.rows[1].paid_date, r.rows[1].net, r.rows[0].vat], ['2025-04-01', '2025-05-05', 11200, 500]);
        eq(r.rows[2].paid_date, null, 'sent, not paid');
        eq(r.errors, ['Line 5: an amount is not a number']);
    });

    const archived = () => IL.fromArchive(IL.parseListRows(pasted).rows.map((x, i) => Object.assign({ id: i + 1, kind: 'invoice' }, x)), {}, TODAY);

    test('archived invoices: paid from their paid date, open ones open', () => {
        const by = Object.fromEntries(archived().map(i => [i.number, [i.status, i.outstandingNet, i.daysLate]]));
        eq(by['0003/2025'], ['paid', 0, 0]);
        eq(by['0004/2025'], ['late', 0, 20]);
        eq(by['0005/2025'][0], 'overdue');
        eq(by['0005/2025'][1], 1000);
    });

    test('an invoice in Bookkeeping and the archive counts once, from Bookkeeping', () => {
        const bk = IL.build(data, {}, TODAY);
        const dup = IL.fromArchive([{ id: 9, invoice_number: '0012/2026', invoice_date: '2026-10-01', net: 1, vat: 0, gross: 1 }], {}, TODAY);
        const all = IL.merge(bk, archived().concat(dup));
        eq(all.filter(i => i.number === '0012/2026').length, 1);
        eq(all.find(i => i.number === '0012/2026').archived, undefined);
        eq(all[0].number, '0003/2025', 'oldest first');
    });

    const companies = [{ id: 1, name: 'Wiener Zeitung' }, { id: 2, name: 'Ameropa AG' }, { id: 3, name: 'Europäisches Parlament' }, { id: 4, name: 'Parlament Wien' }];
    const projects = [
        { id: 10, name: 'Workshop Desinformation', companies: [{ id: 1, name: 'Wiener Zeitung' }], budget_min: 2500, budget_max: 2500, start_date: '2025-03-01', estimated_completion: '2025-03-31', payments: [] },
        { id: 11, name: 'Vortrag Medienkompetenz', companies: [{ id: 1, name: 'Wiener Zeitung' }], budget_min: 1000, budget_max: 1000, start_date: '2025-11-01', estimated_completion: '2025-12-01', payments: [] },
        { id: 12, name: 'Briefing', companies: [{ id: 2, name: 'Ameropa AG' }], start_date: '2025-03-01', payments: [] }
    ];

    test('the company from the customer\'s name, legal form aside; unclear names stay open', () => {
        eq(IL.matchCompany('Wiener Zeitung GmbH', companies).id, 1);
        eq(IL.matchCompany('AMEROPA', companies).id, 2);
        eq(IL.matchCompany('Parlament', companies), null, 'inside two names');
        eq(IL.matchCompany('Somebody else', companies), null);
    });

    test('the project among the company\'s: the only one, or the clearly best', () => {
        const items = IL.attach(archived(), { companies, projects, links: {} });
        const by = Object.fromEntries(items.map(i => [i.number, i.project && i.project.id]));
        eq(by['0003/2025'], 10, 'subject words, amount and date');
        eq(by['0004/2025'], 12, 'the only project');
        eq(by['0005/2025'], 11, 'the amount');
    });

    test('a link by hand wins, 0 means none, and a project brings its company', () => {
        const items = IL.attach(archived(), { companies, projects, links: {
            '0003/2025': { project_id: 11, company_id: null },
            '0004/2025': { project_id: 0, company_id: null },
            '0005/2025': { project_id: null, company_id: 0 }
        } });
        const by = Object.fromEntries(items.map(i => [i.number, i]));
        eq([by['0003/2025'].project.id, by['0003/2025'].project.auto], [11, false]);
        eq(by['0004/2025'].project, null);
        eq(by['0004/2025'].company.id, 2, 'company still found');
        eq(by['0005/2025'].company, null);
        const lone = IL.attach([Object.assign({}, archived()[0], { customer: 'unknown' })], { companies, projects, links: { '0003/2025': { project_id: 12 } } });
        eq(lone[0].company.id, 2, 'from the project');
    });

    test('a company\'s figures: volume, since, days to pay, open, per year, share', () => {
        const items = IL.attach(archived(), { companies, projects, links: {} });
        const s = IL.companyStats(items, 1);
        eq([s.count, s.net, s.since, s.paidCount, s.avgDays, s.lateCount], [2, 3500, '2025-03-10', 1, 10, 0]);
        eq([s.open, s.overdue], [1000, 1000]);
        eq(s.years, [{ year: 2025, net: 3500 }]);
        eq(Math.round(s.share * 100), 24);
        const a = IL.companyStats(items, 2);
        eq([a.avgDays, a.lateCount, a.avgLate], [34, 1, 20]);
    });

    const failed = results.filter(r => !r.ok);
    const out = results.map(r => (r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '\n       ' + r.message)).join('\n')
        + `\n\n${results.length - failed.length}/${results.length} passed`;
    if (typeof print === 'function') print(out);
    else if (typeof console !== 'undefined') console.log(out);
})(typeof window !== 'undefined' ? window : globalThis);
