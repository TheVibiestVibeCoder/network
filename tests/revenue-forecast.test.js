/**
 * Tests for assets/js/revenue-forecast.js - the numbers on the revenue
 * forecast card (Projects page).
 *
 * No framework and no build step. Two ways to run them:
 *   - in a browser: open tests/revenue-forecast.test.html straight from disk (file://)
 *   - in a terminal on macOS, with the JavaScriptCore shell:
 *       /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *           assets/js/project-payments.js assets/js/revenue-forecast.js tests/revenue-forecast.test.js
 *
 * The current month is fixed at October 2026.
 */
(function (root) {
    'use strict';

    const RF = root.RevenueForecast;
    const PP = root.ProjectPayments;
    const NOW = { year: 2026, month: 9 };
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

    function near(actual, expected, label) {
        if (Math.abs(actual - expected) > 0.01) throw new Error(`${label || 'value'}: expected ~${expected}, got ${actual}`);
    }

    let nextId = 1;
    function project(stage, min, max, chance, start, end, extra) {
        return Object.assign({
            id: nextId++, name: 'Project ' + nextId, company: 'Client', stage,
            budget_min: min, budget_max: max, success_chance: chance,
            start_date: start, estimated_completion: end
        }, extra || {});
    }

    // The three worked examples from the brief.
    function examples() {
        nextId = 1;
        return [
            project('In Progress', 48000, 48000, 100, '2026-06-01', '2027-03-31'),   // A
            project('Proposal', 24000, 30000, 70, '2026-12-01', '2027-05-31'),       // B
            project('Negotiation', 3500, 5000, 40, '2026-11-01', '2026-11-30')       // C
        ];
    }

    // The mockup's "Busy" pipeline: ten projects across all four stages.
    function busy() {
        nextId = 1;
        return [
            project('In Progress', 48000, 48000, 100, '2026-06-01', '2027-03-31'),
            project('In Progress', 18000, 22000, 100, '2026-09-01', '2027-01-31'),
            project('In Progress', 9500, 9500, 100, '2026-10-01', '2026-11-30'),
            project('Proposal', 60000, 90000, 50, '2027-01-01', '2027-12-31'),
            project('Proposal', 24000, 30000, 70, '2026-12-01', '2027-05-31'),
            project('Proposal', 15000, 20000, 60, '2027-02-01', '2027-06-30'),
            project('Negotiation', 3500, 5000, 40, '2026-11-01', '2026-11-30'),
            project('Negotiation', 35000, 45000, 35, '2027-01-01', '2027-09-30'),
            project('Lead', 8000, 12000, 15, '2027-03-01', '2027-06-30'),
            project('Lead', 20000, 30000, 10, '2027-04-01', '2027-12-31')
        ];
    }

    const run = (rows, settings) => {
        const { items } = RF.prepare(rows, NOW);
        return RF.forecast(items, settings || RF.settingsFor('realistic'));
    };

    // ------------------------------------------------------------------
    // Worked examples
    // ------------------------------------------------------------------

    test('A: started in June, the full €48k spread over October to March -> €8k a month', () => {
        const f = run([examples()[0]]);
        near(f.current.totals[0], 8000, 'Oct');
        near(f.current.totals[5], 8000, 'Mar');
        near(f.current.totals[6], 0, 'Apr');
        near(f.current.total, 48000, 'total');
    });

    test('B: €27k x 0.7 = €18.9k, €3.15k a month December to May', () => {
        const f = run([examples()[1]]);
        near(f.current.totals[1], 0, 'Nov');
        near(f.current.totals[2], 3150, 'Dec');
        near(f.current.totals[7], 3150, 'May');
        near(f.current.totals[8], 0, 'Jun');
        near(f.current.total, 18900, 'total');
    });

    test('C: start = end is one month, €4.25k x 0.4 = €1.7k in November', () => {
        const f = run([examples()[2]]);
        near(f.current.totals[1], 1700, 'Nov');
        near(f.current.total, 1700, 'total');
    });

    test('A + B + C stack per stage in the same month', () => {
        const f = run(examples());
        near(f.current.byStage['In Progress'][2], 8000, 'Dec in progress');
        near(f.current.byStage.Proposal[2], 3150, 'Dec proposal');
        near(f.current.total, 48000 + 18900 + 1700, 'total');
    });

    // ------------------------------------------------------------------
    // Presets
    // ------------------------------------------------------------------

    test('preset totals for the worked examples', () => {
        const f = run(examples());
        // Worst: in progress only, low end -> A only.
        near(f.presets.worst.total, 48000, 'worst');
        near(f.presets.realistic.total, 68600, 'realistic');
        // Best: 100%, high end: A 48k + B 30k + C 5k.
        near(f.presets.best.total, 83000, 'best');
    });

    test('preset totals for the busy pipeline', () => {
        const f = run(busy());
        // Worst: the three in-progress budgets in full, 48k + 18k + 9.5k.
        near(f.presets.worst.total, 75500, 'worst');
        near(f.presets.realistic.total, 164100, 'realistic');
        near(f.presets.best.total, 311500, 'best');
        eq(RF.money(f.presets.realistic.total), '€164k', 'realistic label');
    });

    test('busiest month and hover readout numbers', () => {
        const f = run(busy());
        eq(RF.monthName(f.busiest, NOW), 'Jan 2027', 'busiest');
        eq(RF.money(f.current.totals[f.busiest]), '€20.8k', 'busiest value');
        // Feb 2027 = offset 4: A 8k | BfS 3.125k + Krisen 3.15k + Pflege 2.1k | Social 1.56k
        eq(RF.money(f.current.totals[4]), '€17.9k', 'Feb total');
        eq(RF.money(f.current.byStage['In Progress'][4]), '€8k', 'Feb in progress');
        eq(RF.money(f.current.byStage.Proposal[4]), '€8.4k', 'Feb proposal');
        eq(RF.money(f.current.byStage.Negotiation[4]), '€1.6k', 'Feb negotiation');
        eq(RF.money(f.ceiling.totals[4]), '€29.5k', 'Feb ceiling');
    });

    test('picking a preset gives exactly its controls and clears switches', () => {
        eq(RF.settingsFor('worst'), { chance: 'as', budget: 'low', stages: ['In Progress'], excluded: {} });
        eq(RF.settingsFor('best').chance, 'all');
        eq(RF.settingsFor('nonsense').budget, 'mid', 'unknown key falls back to realistic');
    });

    // ------------------------------------------------------------------
    // Custom scenario
    // ------------------------------------------------------------------

    test('controls matching a preset highlight it', () => {
        eq(RF.activePreset(RF.settingsFor('worst')), 'worst');
        eq(RF.activePreset(RF.settingsFor('realistic')), 'realistic');
        eq(RF.activePreset(RF.settingsFor('best')), 'best');
        // Stage order does not matter.
        const s = RF.settingsFor('realistic');
        s.stages = s.stages.slice().reverse();
        eq(RF.activePreset(s), 'realistic', 'reordered stages');
    });

    test('any change away from a preset is a custom scenario', () => {
        const s = RF.settingsFor('realistic');
        s.budget = 'high';
        eq(RF.activePreset(s), null, 'budget changed');

        const t = RF.settingsFor('best');
        t.stages = ['Proposal', 'In Progress'];
        eq(RF.activePreset(t), null, 'stage hidden');
    });

    test('a switched-off project makes it custom, even with preset controls', () => {
        const s = RF.settingsFor('realistic');
        s.excluded = { 3: true };
        eq(RF.activePreset(s), null);
        s.excluded = { 3: false };
        eq(RF.activePreset(s), 'realistic', 'a false entry is not a switch');
    });

    // ------------------------------------------------------------------
    // Stage toggles and project switches
    // ------------------------------------------------------------------

    test('switching a stage off drops its projects', () => {
        const s = RF.settingsFor('realistic');
        s.stages = ['In Progress', 'Negotiation'];
        const f = run(examples(), s);
        near(f.current.total, 48000 + 1700, 'total');
        eq(f.counted, 2, 'counted');
        eq(f.current.perProject[2].counted, false, 'B not counted');
    });

    test('switching one project off drops it from the scenario, not the presets', () => {
        const s = RF.settingsFor('realistic');
        s.excluded = { 1: true };
        const f = run(examples(), s);
        near(f.current.total, 18900 + 1700, 'scenario');
        near(f.presets.realistic.total, 68600, 'preset for comparison');
        eq(f.counted, 2, 'counted');
    });

    test('"All 100%" counts the full budget', () => {
        const s = RF.settingsFor('realistic');
        s.chance = 'all';
        near(run([examples()[1]], s).current.total, 27000);
    });

    // ------------------------------------------------------------------
    // Past months and the axis
    // ------------------------------------------------------------------

    test('a project still open past its end month is due now, all of it this month', () => {
        nextId = 1;
        const f = run([project('In Progress', 12000, 12000, 100, '2026-01-01', '2026-09-30')]);
        near(f.current.totals[0], 12000, 'Oct');
        near(f.current.total, 12000, 'total');
    });

    test('a project ending this month that started earlier counts its full budget now', () => {
        nextId = 1;
        const f = run([project('In Progress', 3000, 3000, 100, '2026-08-01', '2026-10-31')]);
        near(f.current.totals[0], 3000, 'Oct');
        near(f.current.total, 3000, 'total');
    });

    test('a project starting later is spread over its own months only', () => {
        const f = run([examples()[1]]);
        near(f.current.totals[1], 0, 'Nov, before it starts');
        near(f.current.totals[2], 3150, 'Dec');
    });

    test('the axis runs at least 12 months, longer when a project ends later', () => {
        eq(run(examples()).months, 12, 'short pipeline');
        eq(run(busy()).months, 15, 'until Dec 2027');
    });

    // ------------------------------------------------------------------
    // Fixed y-scale
    // ------------------------------------------------------------------

    test('the y-scale rounds up to a clean step', () => {
        eq(RF.scale(950), { step: 1000, max: 1000 });
        eq(RF.scale(7400), { step: 2000, max: 8000 });
        eq(RF.scale(26300), { step: 10000, max: 30000 });
        eq(RF.scale(0), { step: 1000, max: 1000 });
    });

    test('the y-scale comes from the Best case, whatever the scenario', () => {
        const a = run(busy(), RF.settingsFor('worst')).scale;
        const b = run(busy(), RF.settingsFor('best')).scale;
        const s = RF.settingsFor('realistic');
        s.stages = ['Lead'];
        const c = run(busy(), s).scale;
        eq(a, b, 'worst vs best');
        eq(a, c, 'custom vs best');
    });

    // ------------------------------------------------------------------
    // Data edge cases
    // ------------------------------------------------------------------

    test('min > max is swapped and a missing end of the range copies the other', () => {
        nextId = 1;
        const { items } = RF.prepare([
            project('Proposal', 30000, 24000, 50, '2026-10-01', '2026-10-31'),
            project('Proposal', null, 5000, 50, '2026-10-01', '2026-10-31')
        ], NOW);
        eq([items[0].min, items[0].max], [24000, 30000], 'swapped');
        eq([items[1].min, items[1].max], [5000, 5000], 'fixed');
    });

    test('chance outside 0–100 is clamped', () => {
        nextId = 1;
        const { items } = RF.prepare([
            project('Lead', 1000, 1000, 140, '2026-10-01', '2026-10-31'),
            project('Lead', 1000, 1000, -5, '2026-10-01', '2026-10-31')
        ], NOW);
        eq(items.map(p => p.chance), [100, 0]);
    });

    test('projects missing a date, budget or chance are listed, not guessed', () => {
        nextId = 1;
        const { items, missing } = RF.prepare([
            project('Proposal', null, null, 50, '2026-10-01', '2026-12-31'),
            project('Proposal', 1000, 2000, 50, '2026-10-01', null),
            project('Lead', 1000, 2000, null, '', '2026-12-31'),
            project('Lead', 0, 0, 20, '2026-10-01', '2026-12-31'),
            project('Lead', 1000, 1000, 20, '2026-12-01', '2026-10-31'),
            project('Proposal', 1000, 2000, 50, '2026-10-01', '2026-12-31'),
            project('Lead', 1000, 2000, 50, null, null),
            project('Lead', 1000, 2000, 50, null, '2026-12-31')
        ], NOW);
        eq(items.map(p => p.id), [2, 6, 7, 8], 'usable');
        eq(items.map(p => p.undated), [true, false, true, false], 'no end date is undated');
        eq(missing.map(p => p.gaps), [
            ['budget'], ['chance'], ['budget'], ['end before start']
        ]);
    });

    test('no start date: the whole budget is due in the end month', () => {
        nextId = 1;
        const f = run([project('In Progress', 6000, 6000, 100, null, '2027-01-31')]);
        near(f.current.totals[2], 0, 'Dec');
        near(f.current.totals[3], 6000, 'Jan');
        near(f.current.total, 6000, 'total');
        eq(RF.periodLabel(null, 3, NOW), 'Ends Jan ’27');
    });

    test('no start date and an end month in the past: due now', () => {
        nextId = 1;
        const f = run([project('In Progress', 6000, 6000, 100, '', '2026-05-31')]);
        near(f.current.totals[0], 6000, 'Oct');
    });

    // ------------------------------------------------------------------
    // Projects without an end date
    // ------------------------------------------------------------------

    test('no end date: the whole budget x chance goes into the undated sum', () => {
        nextId = 1;
        const f = run(examples().concat([project('Proposal', 10000, 20000, 50, '2026-11-01', null)]));
        near(f.current.undated, 7500, 'undated');
        near(f.current.undatedByStage.Proposal, 7500, 'by stage');
        near(f.current.totals.reduce((a, b) => a + b, 0), 68600, 'months unchanged');
        near(f.current.total, 68600 + 7500, 'total');
        near(f.ceiling.undated, 20000, 'best');
        eq(f.hasUndated, true, 'bar shown');
        eq(f.months, 12, 'axis unchanged');
    });

    test('without undated projects there is no undated bar', () => {
        const f = run(examples());
        eq(f.hasUndated, false);
        near(f.current.undated, 0);
    });

    test('undated projects follow stages and switches', () => {
        nextId = 1;
        const rows = [project('Lead', 10000, 10000, 100, null, null)];
        const s = RF.settingsFor('realistic');
        s.excluded = { 1: true };
        const f = run(rows, s);
        near(f.current.undated, 0, 'switched off');
        eq(f.hasUndated, true, 'bar still shown');
        near(run(rows, RF.settingsFor('worst')).current.undated, 0, 'stage off');
    });

    test('the y-scale covers the undated bar', () => {
        nextId = 1;
        const f = run([project('Proposal', 100000, 100000, 50, null, null)]);
        eq(f.scale, { step: 25000, max: 100000 });
    });

    test('complete and pending projects are not part of the forecast', () => {
        nextId = 1;
        const { items, missing } = RF.prepare([
            project('Complete', 1000, 1000, 100, '2026-10-01', '2026-10-31'),
            project('Proposal', 1000, 1000, 50, '2026-10-01', '2026-10-31', { review_status: 'pending' }),
            project('Complete', null, null, null, null, null)
        ], NOW);
        eq(items.length + missing.length, 0);
    });

    test('stored settings are cleaned up', () => {
        eq(RF.normalizeSettings(null), RF.settingsFor('realistic'), 'nothing stored');
        eq(RF.normalizeSettings({ chance: 'x', budget: 'huge', stages: ['Lead', 'Bogus'], excluded: { 4: true, 5: 0 } }),
            { chance: 'as', budget: 'mid', stages: ['Lead'], excluded: { 4: true } });
    });

    // ------------------------------------------------------------------
    // Number formats
    // ------------------------------------------------------------------

    test('money: one decimal below €100k, none for whole thousands', () => {
        eq(RF.money(18900), '€18.9k');
        eq(RF.money(48000), '€48k');
        eq(RF.money(141200), '€141k');
        eq(RF.money(950), '€950');
        eq(RF.money(99960), '€100k');
        eq(RF.money(1250000), '€1.3M');
        eq(RF.moneyFull(48000), '€48,000');
    });

    test('budget and period labels', () => {
        eq(RF.budgetLabel(24000, 30000), '€24–30k');
        eq(RF.budgetLabel(48000, 48000), '€48k');
        eq(RF.budgetLabel(500, 2000), '€500–2k');
        eq(RF.periodLabel(2, 7, NOW), 'Dec ’26 – May ’27');
        eq(RF.periodLabel(1, 1, NOW), 'Nov ’26');
        eq(RF.periodLabel(2, null, NOW), 'From Dec ’26');
        eq(RF.periodLabel(null, null, NOW), 'No dates');
    });

    // ------------------------------------------------------------------
    // Expected payments
    // ------------------------------------------------------------------

    const pay = (month, amount, paid) => ({ month, amount, paid: !!paid });

    test('payments count in their month; the rest of the budget is spread', () => {
        nextId = 1;
        // €12k over Oct-Jan, €5k expected in Nov: €7k left -> €1.75k a month.
        const f = run([project('In Progress', 12000, 12000, 100, '2026-10-01', '2027-01-31',
            { payments: JSON.stringify([pay('2026-11', 5000)]) })]);
        near(f.current.totals[0], 1750, 'Oct');
        near(f.current.totals[1], 1750 + 5000, 'Nov');
        near(f.current.totals[3], 1750, 'Jan');
        near(f.current.total, 12000, 'total');
    });

    test('payments covering the budget leave nothing to spread', () => {
        nextId = 1;
        const f = run([project('In Progress', 10000, 10000, 100, '2026-10-01', '2027-03-31',
            { payments: [pay('2026-12', 4000), pay('2027-03', 6000)] })]);
        near(f.current.totals[0], 0, 'Oct');
        near(f.current.totals[2], 4000, 'Dec');
        near(f.current.totals[5], 6000, 'Mar');
        near(f.current.total, 10000, 'total');
    });

    test('payments above the budget count in full', () => {
        nextId = 1;
        const f = run([project('In Progress', 10000, 10000, 100, '2026-10-01', '2026-12-31',
            { payments: [pay('2026-11', 12000)] })]);
        near(f.current.total, 12000);
    });

    test('a budget range: the rest depends on Low / Mid / High', () => {
        nextId = 1;
        const rows = [project('In Progress', 20000, 30000, 100, '2026-10-01', '2026-11-30',
            { payments: [pay('2026-10', 22000)] })];
        near(run(rows, RF.settingsFor('worst')).current.total, 22000, 'low: payments are above the min');
        near(run(rows).current.total, 25000, 'mid: 3k rest');
        near(run(rows, RF.settingsFor('best')).current.total, 30000, 'high: 8k rest');
    });

    test('paid payments are not forecast but still reduce the rest', () => {
        nextId = 1;
        // €10k Oct-Nov; €4k already paid, €2k expected in Nov: €4k rest, €2k a month.
        const f = run([project('In Progress', 10000, 10000, 100, '2026-10-01', '2026-11-30',
            { payments: [pay('2026-09', 4000, true), pay('2026-11', 2000)] })]);
        near(f.current.totals[0], 2000, 'Oct');
        near(f.current.totals[1], 4000, 'Nov');
        near(f.current.total, 6000, 'total');
    });

    test('an unpaid payment in a past month is due now', () => {
        nextId = 1;
        const f = run([project('In Progress', 3000, 3000, 100, '2026-06-01', '2026-12-31',
            { payments: [pay('2026-07', 3000)] })]);
        near(f.current.totals[0], 3000);
    });

    test('payments are weighted by chance like the budget', () => {
        nextId = 1;
        const f = run([project('Proposal', 10000, 10000, 50, '2026-10-01', '2026-10-31',
            { payments: [pay('2026-10', 4000)] })]);
        near(f.current.total, 5000, 'as set');
        near(run([project('Proposal', 10000, 10000, 50, '2026-10-01', '2026-10-31',
            { payments: [pay('2026-10', 4000)] })], RF.settingsFor('best')).current.total, 10000, 'all 100%');
    });

    test('a payment after the end date stretches the axis', () => {
        nextId = 1;
        const f = run([project('In Progress', 5000, 5000, 100, '2026-10-01', '2026-12-31',
            { payments: [pay('2028-01', 5000)] })]);
        eq(f.months, 16);
        near(f.current.totals[15], 5000);
    });

    test('payments without a budget are forecast on their own', () => {
        nextId = 1;
        const { items, missing } = RF.prepare([project('In Progress', null, null, 100, '2026-10-01', '2026-12-31',
            { payments: [pay('2026-11', 2500)] })], NOW);
        eq(missing.length, 0, 'not missing');
        near(RF.forecast(items, RF.settingsFor('realistic')).current.total, 2500);
    });

    test('undated project: payments in their months, only the rest in the undated bar', () => {
        nextId = 1;
        const f = run([project('In Progress', 10000, 10000, 100, '2026-10-01', null,
            { payments: [pay('2026-12', 4000)] })]);
        near(f.current.totals[2], 4000, 'Dec');
        near(f.current.undated, 6000, 'undated');
        eq(f.hasUndated, true);
        const covered = run([project('In Progress', 10000, 10000, 100, '2026-10-01', null,
            { payments: [pay('2026-12', 10000)] })]);
        eq(covered.hasUndated, false, 'fully planned: no undated bar');
    });

    test('summary against the budget: above, below, unplanned and open', () => {
        const sum = PP.summarize({ budget_min: 24000, budget_max: 30000 },
            [pay('2026-11', 5000, true), pay('2027-01', 7000)]);
        eq([sum.count, sum.planned, sum.paid], [2, 12000, 5000], 'counts');
        eq(sum.below, 12000, 'below min');
        eq(sum.above, 0, 'not above');
        eq(sum.unplanned, { min: 12000, max: 18000 }, 'not planned yet');
        eq(sum.open, { min: 19000, max: 25000 }, 'still open');

        const over = PP.summarize({ budget_min: 10000, budget_max: 10000 }, [pay('2026-11', 12000, true)]);
        eq([over.above, over.open.min, over.open.max], [2000, 0, 0], 'above and fully paid');

        const none = PP.summarize({ budget_min: null, budget_max: null }, [pay('2026-11', 3000)]);
        eq([none.budget, none.open.min], [null, 3000], 'no budget');
    });

    test('payment months: the project range, 24 months without an end, outside months kept', () => {
        const r = PP.monthOptions('2026-10-15', '2027-01-31', ['2027-04'], '2026-10-09');
        eq(r.map(o => o.value), ['2026-10', '2026-11', '2026-12', '2027-01', '2027-04']);
        eq(r[4].outside, true, 'outside marked');
        eq(PP.monthOptions('2026-10-15', null, [], '2026-10-09').length, 25, 'no end date');
        eq(PP.isOutside('2027-02', '2026-10-15', '2027-01-31', '2026-10-09'), true);
        eq(PP.monthName('2027-02'), 'Feb 2027');
    });

    test('stored payments are read leniently and junk is dropped', () => {
        eq(PP.parse('not json'), []);
        eq(PP.parse(null), []);
        eq(PP.parse([{ month: '2026-13', amount: 5 }, { month: '2026-11', amount: '1500.5', paid: 1 }, { month: '2026-12', amount: 0 }]),
            [{ month: '2026-11', amount: 1500.5, paid: true }]);
    });

    test('euro formats as in the project sheet', () => {
        eq(PP.euro(18000).replace(/\s/g, ' '), '18.000 €');
        eq(PP.euro(18450.5).replace(/\s/g, ' '), '18.450,50 €');
        eq(PP.euroRange({ min: 4000, max: 10000 }).replace(/\s/g, ' '), '4.000 – 10.000 €');
        eq(PP.euroRange({ min: 4000, max: 4000 }).replace(/\s/g, ' '), '4.000 €');
    });

    root.revenueForecastTestResults = results;

    if (typeof document === 'undefined') {
        const failed = results.filter(r => !r.ok);
        const out = typeof print === 'function' ? print : console.log;
        results.forEach(r => out((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '\n     ' + r.message)));
        out(`\n${results.length - failed.length}/${results.length} passed`);
        if (failed.length && typeof quit === 'function') quit(1);
    }
})(typeof window !== 'undefined' ? window : globalThis);
