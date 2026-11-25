/**
 * Tests for assets/js/project-payments.js - a project's invoices against
 * its expected payments.
 *
 * No framework and no build step. In a terminal on macOS, with the
 * JavaScriptCore shell:
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *       assets/js/format.js assets/js/project-payments.js tests/project-payments.test.js
 */
(function (root) {
    'use strict';

    const PP = root.ProjectPayments;
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

    const pay = (month, amount, paid) => ({ month, amount, paid: !!paid });
    const inv = (number, date, net, more) => Object.assign({ number, date, net, gross: net * 1.2, credit: false, outstanding: 0, outstandingNet: 0 }, more || {});
    const numbers = list => list.map(i => (i ? i.number : null));

    test('an invoice goes to the payment of its amount, the nearest month first', () => {
        const payments = [pay('2026-06', 6000, true), pay('2026-08', 6000, true), pay('2026-10', 4500)];
        const invoices = [
            inv('10/2025', '2025-10-16', 6000), inv('16/2025', '2026-02-13', 6000),
            inv('15/2026', '2026-06-23', 6000), inv('17/2026', '2026-09-21', 6000)
        ];
        eq(numbers(PP.matchInvoices(payments, invoices)), ['15/2026', '17/2026', null],
            'last year\'s invoices of the same amount do not take this year\'s payments; none fits the 4.500');
    });

    test('another amount fits only within two months; credit notes never', () => {
        const payments = [pay('2026-11', 3000), pay('2027-03', 5000)];
        eq(numbers(PP.matchInvoices(payments, [inv('1/2026', '2026-12-02', 3200)])), ['1/2026', null], 'a month apart');
        eq(numbers(PP.matchInvoices(payments, [inv('1/2026', '2026-06-02', 3200)])), [null, null], 'five months apart');
        eq(numbers(PP.matchInvoices(payments, [inv('1/2026', '2026-11-02', -3000, { credit: true })])), [null, null], 'a credit note');
        eq(numbers(PP.matchInvoices(payments, [])), [null, null], 'no invoices');
    });

    test('each invoice and each payment only once', () => {
        const payments = [pay('2026-11', 3000), pay('2026-12', 3000)];
        eq(numbers(PP.matchInvoices(payments, [inv('1/2026', '2026-11-20', 3000)])), ['1/2026', null]);
        eq(numbers(PP.matchInvoices(payments, [inv('1/2026', '2026-11-20', 3000), inv('2/2026', '2026-12-18', 3000)])), ['1/2026', '2/2026']);
    });

    test('invoiced and open: the net still owed, credit notes and paid ones left out', () => {
        eq(PP.invoicedOpen([
            inv('1/2026', '2026-11-01', 3000, { outstanding: 3600, outstandingNet: 3000 }),
            inv('2/2026', '2026-11-02', 2000, { outstanding: 1200, outstandingNet: 1000 }),
            inv('3/2026', '2026-11-03', 5000),
            inv('4/2026', '2026-11-04', -500, { credit: true, outstanding: 0 })
        ]), 4000);
        eq(PP.invoicedOpen(null), 0);
    });

    const failed = results.filter(r => !r.ok);
    results.forEach(r => print((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.ok ? '' : '\n         ' + r.message)));
    print('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
})(typeof window !== 'undefined' ? window : globalThis);
