/**
 * Tests for assets/js/insights-calc.js - the figures of the Insights tab.
 *
 * No framework and no build step. In a terminal on macOS, with the
 * JavaScriptCore shell:
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *       assets/js/insights-calc.js tests/insights-calc.test.js
 *
 * Today is fixed at 23 November 2026.
 */
(function (root) {
    'use strict';

    const IC = root.InsightsCalc;
    const TODAY = '2026-11-23';
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

    const near = (a, b, label) => {
        if (Math.abs(a - b) > 0.001) throw new Error(`${label || 'value'}: expected ${b}, got ${a}`);
    };

    const PRODUCTS = [{ name: 'Workshop', color: '#30599D' }, { name: 'Risk Briefing', color: '#1C3258' }, { name: 'Vortragstätigkeit', color: '#8FB4E4' }];
    const COMPANIES = [{ id: 1, name: 'Alpha GmbH', sector: 'Energy' }, { id: 2, name: 'Beta', sector: null }, { id: 3, name: 'Gamma AG', sector: 'Media' }];

    const h = (id, field, value, at, source) => ({ project_id: id, field, value: value === null ? null : String(value), changed_at: at + ' 10:00:00', source: source || 'live' });

    function project(id, extra) {
        return Object.assign({
            id, name: 'P' + id, stage: 'Lead', product: null, budget_min: null, budget_max: null, success_chance: null,
            created_at: '2026-02-01 09:00:00', start_date: '2026-02-01', companies: [{ id: 1, name: 'Alpha GmbH' }], review_status: null
        }, extra || {});
    }

    function fixture() {
        const projects = [
            // Won: Lead in Feb, Proposal in Mar, In Progress in Apr.
            project(1, { stage: 'In Progress', product: 'Workshop', budget_min: 4000, budget_max: 6000, success_chance: 100 }),
            // Open in Proposal.
            project(2, { stage: 'Proposal', product: 'Risk Briefing', budget_min: 10000, budget_max: 10000, success_chance: 60, created_at: '2026-05-10 09:00:00', companies: [{ id: 2, name: 'Beta' }] }),
            // A talk, won in March; then a paid order at the same company in June.
            project(3, { stage: 'Complete', product: 'Vortragstätigkeit', budget_min: 0, budget_max: 0, success_chance: 100, created_at: '2026-03-01 09:00:00', companies: [{ id: 3, name: 'Gamma AG' }] }),
            project(4, { stage: 'Complete', product: 'Workshop', budget_min: 3000, budget_max: 3000, success_chance: 100, created_at: '2026-05-01 09:00:00', companies: [{ id: 3, name: 'Gamma AG' }] }),
            // Claude's proposal, not accepted yet: left out.
            project(5, { review_status: 'pending' })
        ];
        const history = [
            h(1, 'stage', 'Lead', '2026-02-01'), h(1, 'chance', 30, '2026-02-01'),
            h(1, 'stage', 'Proposal', '2026-03-01'), h(1, 'chance', 70, '2026-03-01'),
            h(1, 'stage', 'In Progress', '2026-04-01'), h(1, 'chance', 100, '2026-04-01'),
            h(2, 'stage', 'Lead', '2026-05-10'), h(2, 'chance', 20, '2026-05-10'), h(2, 'budget_min', 5000, '2026-05-10'), h(2, 'budget_max', 5000, '2026-05-10'),
            h(2, 'stage', 'Proposal', '2026-08-15'), h(2, 'chance', 60, '2026-08-15'), h(2, 'budget_min', 10000, '2026-08-15'), h(2, 'budget_max', 10000, '2026-08-15'),
            h(3, 'stage', 'Negotiation', '2026-03-01'), h(3, 'stage', 'Complete', '2026-03-10'),
            h(4, 'stage', 'Lead', '2026-05-01'), h(4, 'chance', 80, '2026-05-01'), h(4, 'stage', 'In Progress', '2026-06-15')
        ];
        const archived = [
            // Lost in Proposal at 70%.
            { id: 10, project_id: 20, name: 'Lost one', company: 'Alpha GmbH', stage: 'Proposal', reason: 'went_elsewhere', deleted_at: '2026-07-01 12:00:00',
                project: { created_at: '2026-04-01 09:00:00', product: 'Workshop', budget_min: 8000, budget_max: 8000, success_chance: 70 },
                companies: [1], history: [{ field: 'stage', value: 'Lead', changed_at: '2026-04-01 09:00:00' }, { field: 'chance', value: '50', changed_at: '2026-04-01 09:00:00' },
                    { field: 'stage', value: 'Proposal', changed_at: '2026-05-01 09:00:00' }, { field: 'chance', value: '70', changed_at: '2026-05-01 09:00:00' }] },
            // Finished work tidied away: won.
            { id: 11, project_id: 21, name: 'Done one', company: 'Beta', stage: 'Complete', reason: null, deleted_at: '2026-10-05 12:00:00',
                project: { created_at: '2026-01-10 09:00:00', start_date: '2026-01-20', product: 'Risk Briefing', budget_min: 9000, budget_max: 9000, success_chance: 100 }, companies: [], history: [] },
            // Archived from Lead without a reason: unclear.
            { id: 12, project_id: 22, name: 'Odd one', company: null, stage: 'Lead', reason: null, deleted_at: '2026-10-14 12:00:00',
                project: { created_at: '2026-10-01 09:00:00' }, companies: [], history: [] },
            // A test: left out.
            { id: 13, project_id: 23, name: 'TEST', company: null, stage: 'Negotiation', reason: 'mistake', deleted_at: '2026-11-18 12:00:00',
                project: { created_at: '2026-11-01 09:00:00' }, companies: [], history: [] }
        ];
        const inv = (number, date, net, company, project, paid) => ({
            number, date, net, gross: net * 1.2, credit: false, due: null,
            company: company ? { id: company, name: COMPANIES[company - 1].name } : null,
            project: project ? { id: project } : null,
            customer: company ? COMPANIES[company - 1].name : 'Somebody', paid: paid ? { date: paid, amount: net * 1.2 } : null
        });
        const invoices = [
            inv('1/2025', '2025-03-01', 10000, 1, null, '2025-03-20'),
            inv('2/2025', '2025-06-01', 2000, 2, null, '2025-06-11'),
            inv('3/2025', '2025-12-01', 4000, 1, null, '2025-12-15'),
            inv('1/2026', '2026-04-15', 5000, 1, 1, '2026-05-05'),
            inv('2/2026', '2026-07-01', 3000, 3, 4, '2026-07-21'),
            inv('3/2026', '2026-10-20', 9000, 2, 21, null),
            inv('4/2026', '2026-11-02', 1000, null, null, null)
        ];
        return IC.prepare({ invoices, projects, history, archived, companies: COMPANIES, products: PRODUCTS, today: TODAY });
    }

    // ------------------------------------------------------------------

    test('periods: a running year is compared with the same days a year before', () => {
        const p = IC.period('year:2026', TODAY, '2025-01-01');
        eq([p.start, p.end, p.prev.start, p.prev.end], ['2026-01-01', TODAY, '2025-01-01', '2025-11-23']);
        eq(p.months.length, 12, 'a whole year of months');
        const past = IC.period('year:2025', TODAY, '2025-01-01');
        eq([past.end, past.prev.end], ['2025-12-31', '2024-12-31'], 'a past year');
        const m = IC.period('12m', TODAY, '2025-01-01');
        eq([m.start, m.months[0], m.months[11]], ['2025-12-01', '2025-12', '2026-11'], '12 months');
        eq(IC.period('all', TODAY, '2025-03-14').start, '2025-03-01', 'all from the first data');
    });

    test('every project is one deal with an outcome; pending and tests are left out', () => {
        const data = fixture();
        const by = name => data.deals.find(d => d.name === name);
        eq(data.deals.length, 7, 'four live, three archived');
        eq(by('P1').outcome, 'won');
        eq(by('P1').decidedAt, '2026-04-01', 'won when it reached In Progress');
        eq(by('P2').outcome, 'open');
        eq(by('Lost one').outcome, 'lost');
        eq(by('Lost one').decidedAt, '2026-07-01', 'lost when archived');
        eq(by('Done one').outcome, 'won', 'Complete without a reason is finished work');
        eq(by('Done one').decidedAt, '2026-01-20', 'without a history: its start');
        eq(by('Done one').companyIds, [2], 'found by its company text');
        eq(by('Odd one').outcome, 'unclear');
        eq(by('P3').talk, true, 'a talk');
        eq(data.unclear, 1);
    });

    test('overview figures for 2026 against the same days of 2025', () => {
        const data = fixture();
        const k = IC.kpis(data, IC.period('year:2026', TODAY, data.first));
        eq([k.revenue, k.revenuePrev], [18000, 12000], 'revenue');
        eq(k.cash, 8000, 'cash in: paid in 2026, net');
        eq([k.customers, k.newCustomers, k.returning], [4, 2, 2], 'customers');
        eq([k.won, k.wonVolume], [4, 5000 + 0 + 3000 + 9000], 'won and their budgets');
        eq(k.wonPrev, 0, 'nothing won by 23 Nov 2025');
        eq([k.decided, k.winRate], [5, 0.8], 'won against lost');
        eq(k.timeToWin, 45, 'median of 59, 9 and 45 days, of those entered open');
    });

    test('revenue added up, with the year before', () => {
        const data = fixture();
        const c = IC.cumulative(data, IC.period('year:2026', TODAY, data.first));
        eq(c.cur.length, 11, 'to November');
        eq(c.cur[3].value, 5000, 'April');
        eq(c.cur[10].value, 18000, 'November');
        near(c.cur[10].x, 10 + 23 / 30, 'the running month ends today');
        eq(c.prev.length, 12, 'the whole year before');
        eq(c.prev[11].value, 16000, '2025 in total');
    });

    test('product mix by the invoice\'s project', () => {
        const data = fixture();
        const mix = IC.productMix(data, IC.period('year:2026', TODAY, data.first));
        eq(mix.parts.map(x => [x.name, x.net]), [['Workshop', 8000], ['Risk Briefing', 9000], ['No product', 1000]]);
    });

    test('from lead to order', () => {
        const data = fixture();
        const f = IC.funnel(data, IC.period('year:2026', TODAY, data.first));
        eq(f.entered, 7, 'entered in 2026 (the test left out)');
        eq(f.steps.map(s => s.reached), [7, 6, 6, 4], 'reached this stage or later');
        eq(f.steps.map(s => s.lost), [0, 0, 1, 0], 'lost at Proposal');
        eq(f.steps.map(s => s.open), [0, 0, 1, 0], 'still open; the unclear one is not');
        eq(f.unclear, 1);
        eq(f.winRate, 0.8);
        eq(f.steps[0].days, 30, 'median of 28, 97, 0, 45 and 30 days out of Lead');
        eq(f.steps.slice(0, 3).map(s => s.stopped), [{ lost: 0, open: 0, unclear: 1 }, { lost: 0, open: 0, unclear: 0 }, { lost: 1, open: 1, unclear: 0 }], 'got no further: the flows out of the sankey');
    });

    test('moves rebuilt from the log give no durations', () => {
        const data = fixture();
        const p2 = data.deals.find(d => d.name === 'P2');
        p2.reachedLive[1] = false;
        p2.reachedLive[2] = false;
        const f = IC.funnel(data, IC.period('year:2026', TODAY, data.first));
        eq(f.steps[0].days, 29, 'P2\'s 97 days left out');
    });

    test('estimates against outcome use the last chance before the decision', () => {
        const data = fixture();
        const c = IC.calibration(data, IC.period('year:2026', TODAY, data.first));
        eq(c.rows.map(r => [r.n, r.won]), [[0, 0], [0, 0], [3, 2], [0, 0]], 'P1 at 70, P4 at 80 won, the lost one at 70');
        near(c.weighted, 5000 * 0.7 + 3000 * 0.8 + 8000 * 0.7, 'weighted');
        eq(c.wonVolume, 8000, 'won of those');
    });

    test('pipeline at month end takes stage, chance and budget as they were', () => {
        const data = fixture();
        const p = IC.pipeline(data, IC.period('year:2026', TODAY, data.first));
        const at = m => p.find(x => x.month === m);
        eq(at('2026-06').open, 5000 + 8000, 'June: P2 at 5k, the lost one at 8k');
        near(at('2026-06').weighted, 5000 * 0.2 + 8000 * 0.7, 'weighted then');
        eq(at('2026-09').open, 10000, 'after the budget changed');
        eq(at('2026-03').count, 1, 'March: only P1, P3 was won on the 10th');
    });

    test('customers: shares, new ones, who bought again', () => {
        const data = fixture();
        const c = IC.customerFigures(data, IC.period('year:2026', TODAY, data.first));
        eq(c.list.map(x => [x.name, x.net, x.isNew]), [['Beta', 9000, false], ['Alpha GmbH', 5000, false], ['Gamma AG', 3000, true], ['Somebody', 1000, true]]);
        near(c.shares.top1, 0.5, 'biggest');
        near(c.sharesPrev.top1, 10000 / 12000, 'biggest the year before');
        eq([c.again, c.prevCount], [2, 2], 'both from 2025 bought again');
        eq(c.list[0].sector, null);
    });

    test('a talk that opened a door', () => {
        const data = fixture();
        const d = IC.doors(data, IC.period('year:2026', TODAY, data.first));
        eq(d.items.length, 1);
        eq(d.hits, 1);
        eq(d.volume, 3000);
    });

    test('sectors: revenue per year, 2026 against the same days of 2025', () => {
        const data = fixture();
        const s = IC.sectors(data, IC.period('year:2026', TODAY, data.first));
        eq(s.years.map(y => [y.year, y.running]), [[2025, false], [2026, true]], 'from the first data on');
        eq(s.rows.map(r => [r.name, r.values]), [['Energy', [14000, 5000]], ['Media', [0, 3000]]], 'biggest in 2026 first');
        near(s.rows[0].change, -0.5, 'Energy: 5k against 10k by 23 Nov 2025');
        eq(s.rows[1].change, null, 'nothing from Media the year before');
        eq(s.none.values, [2000, 10000], 'no sector yet');
        eq(s.totals, [16000, 18000]);
        near(s.change, 0.5, 'all: 18k against 12k');
    });

    test('sector shares: the period against the one before', () => {
        const data = fixture();
        const s = IC.sectorShares(data, IC.period('year:2026', TODAY, data.first));
        eq(s.rows.map(r => [r.name, r.net, r.isNew]), [['Energy', 5000, false], ['Media', 3000, true]], 'biggest first');
        near(s.rows[0].share, 5000 / 18000, 'of all revenue');
        near(s.rows[0].change, -0.5, 'Energy: 5k against 10k by 23 Nov 2025');
        eq(s.rows[1].change, null, 'nothing from Media the year before');
        eq([s.none.name, s.none.net], ['No sector', 10000]);
        eq(s.total, 18000);
        const all = IC.sectorShares(data, IC.period('all', TODAY, data.first));
        eq(all.rows.map(r => r.isNew), [false, false], 'nothing before all');
    });

    test('how customers grew: revenue per year, new ones marked', () => {
        const data = fixture();
        const g = IC.customerYears(data, IC.period('12m', TODAY, data.first), 8);
        eq(g.rows.map(r => [r.name, r.values, r.isNew]), [
            ['Alpha GmbH', [14000, 5000], false], ['Beta', [2000, 9000], false], ['Gamma AG', [0, 3000], true], ['Somebody', [0, 1000], true]
        ], 'biggest over both years first');
        near(g.rows[1].change, 3.5, 'Beta: 9k against 2k');
        const past = IC.customerYears(data, IC.period('year:2025', TODAY, data.first), 8);
        eq(past.years.map(y => y.year), [2025], 'a past year: no years before the first data');
        eq(past.rows[0].change, null, 'nothing to compare with');
    });

    test('by product: what was decided and invoiced in the period', () => {
        const data = fixture();
        const t = IC.byProduct(data, IC.period('year:2026', TODAY, data.first));
        const row = name => t.rows.find(r => r.name === name);
        eq([row('Workshop').won, row('Workshop').decided, row('Workshop').revenue], [2, 3, 8000], 'P1 and P4 won, the lost one');
        eq(row('Workshop').order, 4000, 'median of 5k and 3k');
        eq(row('Workshop').days, 52, 'median of 59 and 45 days');
        near(row('Risk Briefing').share, 0.5, '9k of 18k');
        eq([t.total.won, t.total.decided], [4, 5]);
    });

    test('losses and reasons', () => {
        const data = fixture();
        const l = IC.losses(data, IC.period('year:2026', TODAY, data.first), { went_elsewhere: 'Went elsewhere' });
        eq(l.total, 1);
        eq(l.stages.map(s => [s.name, s.items.length]), [['Lead', 0], ['Negotiation', 0], ['Proposal', 1]]);
        eq(l.stages[2].items[0].chance, 70);
        eq(l.why, [{ key: 'went_elsewhere', label: 'Went elsewhere', n: 1 }]);
        eq(l.unclear, 1);
    });

    test('highlights: a value against the one before, or a short note', () => {
        const data = fixture();
        const parts = IC.compute(data, 'year:2026', {});
        const h = parts.highlights;
        eq([h[0].title, h[0].value, h[0].prev, h[0].tone], ['Revenue', 18000, 12000, 'good'], 'revenue against the same days of 2025');
        const archive = h.find(x => x.title === 'Archive');
        eq([archive.value, archive.note], [1, 'without a reason'], 'the unclear one');
    });

    test('average order per quarter: the budgets of the projects won, talks left out', () => {
        const data = fixture();
        const qs = IC.orderSizes(data, IC.period('year:2026', TODAY, data.first));
        eq(qs.map(q => q.label + ' ' + q.year), ['Q1 2025', 'Q2 2025', 'Q3 2025', 'Q4 2025', 'Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026'], 'the year and the four quarters before');
        eq(qs.slice(0, 4).map(q => q.value), [null, null, null, null], 'nothing won in 2025');
        eq([qs[4].n, qs[4].value], [1, 9000], 'Q1: the finished one');
        eq([qs[5].n, qs[5].value], [2, 4000], 'Q2: 5.000 (the middle of 4.000-6.000) and 3.000; the talk in Q1 does not count');
        eq([qs[6].value, qs[7].value, qs[7].partial], [null, null, true], 'no order: no figure; the running quarter is marked');
    });

    test('compute runs for every period kind, also without any data', () => {
        const data = fixture();
        ['year:2026', 'year:2025', '12m', 'all'].forEach(key => IC.compute(data, key, {}));
        const empty = IC.prepare({ invoices: [], projects: [], history: [], archived: [], companies: [], products: PRODUCTS, today: TODAY });
        ['year:2026', '12m', 'all'].forEach(key => IC.compute(empty, key, {}));
        eq(IC.years(data), ['2026', '2025']);
    });

    // ------------------------------------------------------------------

    const failed = results.filter(r => !r.ok);
    results.forEach(r => print((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.ok ? '' : '\n         ' + r.message)));
    print('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
})(typeof window !== 'undefined' ? window : globalThis);
