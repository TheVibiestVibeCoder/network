/**
 * Tests for assets/js/amount-input.js - how typed and pasted amounts are read.
 *
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *       assets/js/amount-input.js tests/amount-input.test.js
 */
(function (root) {
    'use strict';

    const A = root.CRMAmount;
    const results = [];
    const same = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

    function check(input, expected) {
        const got = A.parse(input);
        results.push({ name: JSON.stringify(input) + ' -> ' + expected, ok: same(got, expected), message: 'got ' + got });
    }

    // German
    check('1.234,56', 1234.56);
    check('12.345', 12345);
    check('1.234.567', 1234567);
    check('1234,5', 1234.5);
    check('0,5', 0.5);
    // English
    check('1,234.56', 1234.56);
    check('1,234', 1234);
    check('12.50', 12.5);
    check('1234.56', 1234.56);
    // Plain, signs, currency, spaces
    check('1234', 1234);
    check('-500', -500);
    check('−1.200,00', -1200);
    check('€ 1.234,56', 1234.56);
    check('1.234,56 €', 1234.56);
    check('1 234,56', 1234.56);
    check('EUR 99', 99);
    check("1'234.50", 1234.5);
    // Empty and nonsense
    check('', null);
    check('   ', null);
    check('abc', NaN);
    check('1.23.4', NaN);
    check('1,2,3', NaN);
    check('1.23,4,5', NaN);

    // Formatting round-trips
    [[1234.5, '1.234,50'], [1234, '1.234'], [0.5, '0,50'], [1234567.891, '1.234.567,89'], [null, '']].forEach(([n, text]) => {
        const got = A.format(n);
        results.push({ name: `format ${n} -> ${text}`, ok: got === text, message: 'got ' + got });
        if (n !== null) results.push({ name: `round trip ${text}`, ok: A.parse(got) === Math.round(n * 100) / 100, message: 'got ' + A.parse(got) });
    });

    root.amountInputTestResults = results;

    if (typeof document === 'undefined') {
        const failed = results.filter(r => !r.ok);
        const out = typeof print === 'function' ? print : console.log;
        results.forEach(r => out((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '\n     ' + r.message)));
        out(`\n${results.length - failed.length}/${results.length} passed`);
        if (failed.length && typeof quit === 'function') quit(1);
    }
})(typeof window !== 'undefined' ? window : globalThis);
