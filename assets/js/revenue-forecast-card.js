/**
 * Revenue forecast card (Projects page): turns RevenueForecast's numbers
 * into HTML and wires up its controls.
 *
 * The card is drawn whole from state on every change - settings, expanded or
 * not, the projects - and keeps the keyboard where it was. Hovering a month
 * only touches the readout line, so moving the mouse never redraws the card.
 *
 * The controls come in two levels on purpose: the Scenario switch (Worst /
 * Realistic / Best) in the header sets every assumption at once; the
 * assumptions - chance, budget and stages behind "Adjust", single projects
 * in the table - fine-tune it, and any change there
 * turns the scenario into a custom one.
 */
(function (root) {
    'use strict';

    const RF = root.RevenueForecast;
    const STORAGE_KEY = 'crm.revenueForecast.v1';

    const CHART_H = { compact: 110, expanded: 210 };

    const CHANCE_OPTIONS = [
        { key: 'as', label: 'As set', hint: 'Each project counts with its chance of success' },
        { key: 'all', label: 'All 100%', hint: 'Treat every project as won' }
    ];
    const BUDGET_OPTIONS = [
        { key: 'low', label: 'Low', hint: 'Low end of each budget range' },
        { key: 'mid', label: 'Mid', hint: 'Middle of each budget range' },
        { key: 'high', label: 'High', hint: 'High end of each budget range' }
    ];
    const PRESET_HINTS = {
        worst: 'Only projects in progress, at the low end of their budget',
        realistic: 'All projects, middle of the budget × their chance',
        best: 'Every project won, at the high end of its budget'
    };

    // The bar for projects without an end date, after the months.
    const UNDATED_LABEL = 'No end date';

    const toneOf = key => (RF.STAGES.find(s => s.key === key) || {}).tone || 'lead';
    const labelOf = key => (RF.STAGES.find(s => s.key === key) || {}).label || key;

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const CHEVRON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    const state = {
        el: null,
        loading: true,
        projects: [],
        settings: RF.settingsFor(RF.DEFAULT_PRESET),
        expanded: false,
        adjustOpen: false,
        focusMonth: 0,
        hover: null
    };

    function loadStored() {
        try {
            const raw = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || 'null');
            if (raw) {
                state.settings = RF.normalizeSettings(raw.settings);
                state.expanded = !!raw.expanded;
            }
        } catch (e) { /* no storage: defaults */ }
    }

    function store() {
        try {
            root.localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: state.settings, expanded: state.expanded }));
        } catch (e) { /* no storage: fine */ }
    }

    // ------------------------------------------------------------------
    // Pieces
    // ------------------------------------------------------------------

    function segmented(group, options, current, extraClass) {
        return `<div class="segmented ${extraClass || ''}" role="group" aria-label="${esc(group.label)}">${
            options.map(o => {
                const on = o.key === current;
                return `<button type="button" class="segmented-btn${on ? ' active' : ''}" aria-pressed="${on}"
                    data-rf-${group.kind}="${esc(o.key)}" data-rf-focus="${group.kind}-${esc(o.key)}"
                    title="${esc(o.hint)}">${esc(o.label)}</button>`;
            }).join('')
        }</div>`;
    }

    const SLIDERS = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>';

    /**
     * The header's controls. The scenario is always in view; the assumptions
     * it stands for (chance, budget, stages) sit behind "Adjust", because they
     * are fine-tuning.
     */
    function controls(ctx) {
        const custom = !ctx.f.active;
        const presets = segmented({ kind: 'preset', label: 'Scenario' },
            RF.PRESETS.map(p => ({ key: p.key, label: p.label, hint: PRESET_HINTS[p.key] })),
            ctx.f.active, 'rf-presets');

        return `
            <div class="rf-tools">
                ${presets}
                <button type="button" class="rf-adjust${custom ? ' is-custom' : ''}" data-rf-adjust data-rf-focus="adjust"
                    aria-expanded="${state.adjustOpen}" aria-controls="rfAdjust" title="Adjust chance, budget and stages">
                    ${SLIDERS}<span>${custom ? 'Custom' : 'Adjust'}</span>
                </button>
            </div>`;
    }

    /**
     * What "Adjust" opens: one slim row under the header that pushes the
     * chart down rather than covering it.
     */
    function adjustPanel(ctx) {
        if (!state.adjustOpen) return '';
        const s = state.settings;
        return `
            <div class="rf-adjust-panel" id="rfAdjust" role="group" aria-label="Assumptions">
                <div class="rf-adj-field">
                    <span class="rf-adj-label">Chance</span>
                    ${segmented({ kind: 'chance', label: 'Chance of success' }, CHANCE_OPTIONS, s.chance, 'rf-seg-sm')}
                </div>
                <div class="rf-adj-field">
                    <span class="rf-adj-label">Budget</span>
                    ${segmented({ kind: 'budget', label: 'Budget' }, BUDGET_OPTIONS, s.budget, 'rf-seg-sm')}
                </div>
                <div class="rf-adj-field">
                    <span class="rf-adj-label">Stages</span>
                    ${stageToggles(ctx)}
                </div>
                ${ctx.f.active ? '' : `<button type="button" class="rf-link rf-adj-reset" data-rf-preset="${RF.DEFAULT_PRESET}" data-rf-focus="reset" title="Back to the Realistic scenario">Reset</button>`}
            </div>`;
    }

    function stageCounts(ctx) {
        const counts = {};
        ctx.all.forEach(p => { counts[p.stage] = (counts[p.stage] || 0) + 1; });
        return counts;
    }

    /** The stage switches, in the Adjust panel with chance and budget. */
    function stageToggles(ctx) {
        const s = state.settings;
        const counts = stageCounts(ctx);
        return `<div class="rf-adj-stages" role="group" aria-label="Stages included">${RF.STAGES.map(st => {
            const on = s.stages.indexOf(st.key) >= 0;
            const n = counts[st.key] || 0;
            return `<button type="button" class="rf-stage${on ? ' is-on' : ''}" data-tone="${st.tone}"
                aria-pressed="${on}" ${n ? '' : 'disabled'} data-rf-stage="${esc(st.key)}" data-rf-focus="stage-${st.tone}"
                title="${esc((on ? 'Leave out ' : 'Count ') + st.label.toLowerCase() + ' projects')}">
                <span class="rf-stage-dot" aria-hidden="true"></span>${esc(st.label)}<span class="rf-stage-count">${n}</span>
            </button>`;
        }).join('')}</div>`;
    }

    /** The chart's colour key; stages that are switched off are greyed. */
    function stageLegend(ctx) {
        const s = state.settings;
        const counts = stageCounts(ctx);
        return `<div class="rf-legend">${RF.STACK.filter(key => counts[key]).map(key => {
            const st = RF.STAGES.find(x => x.key === key);
            const on = s.stages.indexOf(key) >= 0;
            return `<span class="rf-key${on ? ' is-on' : ''}" data-tone="${st.tone}">
                <span class="rf-stage-dot" aria-hidden="true"></span>${esc(st.label)}${on ? '' : '<span class="rf-sr"> (not counted)</span>'}
            </span>`;
        }).join('')}</div>`;
    }

    function summary(ctx) {
        const f = ctx.f;
        const now = ctx.now;
        const preset = f.active ? RF.presetByKey(f.active).label + ' case' : 'Custom scenario';
        const compare = RF.PRESETS.map(p => `
            <span class="rf-compare-item${f.active === p.key ? ' is-active' : ''}">${esc(p.label)}
                <strong>${esc(RF.money(f.presets[p.key].total))}</strong></span>`).join('');

        return `
            <div class="rf-summary">
                <span class="rf-summary-label">${esc(preset)} · ${f.counted} of ${ctx.items.length} ${ctx.items.length === 1 ? 'project' : 'projects'}</span>
                <span class="rf-hero" aria-label="${esc(RF.moneyFull(f.current.total))}">${esc(RF.money(f.current.total))}</span>
                <span class="rf-hero-sub">expected ${esc(RF.monthName(0, now))} – ${esc(RF.monthName(f.months - 1, now))}${
                    f.current.undated > 0 ? ` · ${esc(RF.money(f.current.undated))} without end date` : ''}</span>
                <span class="rf-compare">${compare}</span>
            </div>`;
    }

    /** Columns on the chart: the months, then the undated bar if there is one. */
    const columnCount = f => f.months + (f.hasUndated ? 1 : 0);

    /** One column's numbers from a compute() result: a month, or the undated bar. */
    function columnOf(f, result, i) {
        if (i >= f.months) return { total: result.undated, stage: k => result.undatedByStage[k] };
        return { total: result.totals[i], stage: k => result.byStage[k][i] };
    }

    const columnName = (ctx, i) => (i >= ctx.f.months ? UNDATED_LABEL : RF.monthName(i, ctx.now));

    /** The line above the chart: the busiest month, or the column in focus. */
    function readout(ctx, month) {
        const f = ctx.f;
        if (month === null || month === undefined) {
            if (f.current.total <= 0) {
                return '<span>Nothing counted in this scenario</span>';
            }
            const busiest = f.current.totals[f.busiest] > 0
                ? `<span>Busiest month: ${esc(RF.monthName(f.busiest, ctx.now))} · </span><strong>${esc(RF.money(f.current.totals[f.busiest]))}</strong>`
                : `<span>${esc(UNDATED_LABEL)} · </span><strong>${esc(RF.money(f.current.undated))}</strong>`;
            return busiest
                + '<span> · <span class="rf-key-ghost" aria-hidden="true"></span>grey = everything won at the top of its budget</span>';
        }
        const col = columnOf(f, f.current, month);
        const parts = RF.STACK.filter(k => col.stage(k) > 0)
            .map(k => `${labelOf(k)} ${RF.money(col.stage(k))}`);
        return `<span>${esc(columnName(ctx, month))} · </span><strong>${esc(RF.money(col.total))}</strong>`
            + `<span>${parts.length ? esc(' (' + parts.join(' · ') + ')') : ''} · up to ${esc(RF.money(columnOf(f, f.ceiling, month).total))}</span>`;
    }

    function chart(ctx) {
        const f = ctx.f;
        const now = ctx.now;
        const H = state.expanded ? CHART_H.expanded : CHART_H.compact;
        const px = v => Math.round((v / f.scale.max) * H);
        const focus = Math.min(state.focusMonth, columnCount(f) - 1);

        const ticks = [];
        if (state.expanded) {
            for (let v = 0; v <= f.scale.max; v += f.scale.step) {
                ticks.push(`<span class="rf-tick${v === 0 ? ' is-base' : ''}" style="bottom:${px(v)}px"><span>${esc(RF.money(v))}</span></span>`);
            }
        }

        const cols = [];
        const labels = [];
        for (let i = 0; i < columnCount(f); i++) {
            const undated = i >= f.months;
            const col = columnOf(f, f.current, i);
            const segs = RF.STACK
                .map(k => ({ k, h: px(col.stage(k)) }))
                .filter(x => x.h > 0)
                .map(x => `<span class="rf-seg" data-tone="${toneOf(x.k)}" style="height:${x.h}px"></span>`)
                .join('');
            const ghost = px(columnOf(f, f.ceiling, i).total);
            const parts = RF.STACK.filter(k => col.stage(k) > 0)
                .map(k => `, ${labelOf(k)} ${RF.moneyFull(col.stage(k))}`).join('');

            cols.push(`<button type="button" class="rf-col${undated ? ' is-undated' : ''}" data-rf-month="${i}" tabindex="${i === focus ? 0 : -1}"
                data-rf-focus="month-${undated ? 'undated' : i}" aria-label="${esc(columnName(ctx, i) + ': ' + RF.moneyFull(col.total) + parts)}">
                ${ghost > 0 ? `<span class="rf-ghost" style="height:${ghost}px"></span>` : ''}
                <span class="rf-stack">${segs}</span>
            </button>`);

            if (undated) {
                labels.push(`<span class="rf-axis-label is-undated" data-rf-label="${i}">`
                    + '<span class="rf-m-long">No date</span><span class="rf-m-short">?</span>'
                    + `${state.expanded ? '<span class="rf-axis-year"></span>' : ''}</span>`);
                continue;
            }

            const c = RF.calendarMonth(i, now);
            const name = RF.MONTHS_SHORT[c.month];
            const year = state.expanded && (i === 0 || c.month === 0) ? c.year : '';
            // "Oct", unless the chart is too narrow (CSS falls back to "O").
            labels.push(`<span class="rf-axis-label${i === 0 ? ' is-now' : ''}" data-rf-label="${i}">`
                + `<span class="rf-m-long">${esc(name)}</span><span class="rf-m-short">${esc(name.charAt(0))}</span>`
                + `${state.expanded ? `<span class="rf-axis-year">${year}</span>` : ''}</span>`);
        }

        return `
            <div class="rf-chart">
                <div class="rf-readout" data-rf-readout>${readout(ctx, null)}</div>
                <div class="rf-plot-wrap" style="height:${H}px">
                    ${ticks.join('')}
                    <div class="rf-plot" role="group" aria-label="Revenue per month">${cols.join('')}</div>
                </div>
                <div class="rf-axis" aria-hidden="true">${labels.join('')}</div>
                ${stageLegend(ctx)}
            </div>`;
    }

    function table(ctx) {
        const f = ctx.f;
        const now = ctx.now;
        const s = state.settings;
        const maxBest = Math.max(1, ...ctx.items.map(p => f.ceiling.perProject[p.id].value));
        const excluded = RF.excludedCount(s) > 0;

        const rows = ctx.items.map(p => {
            const c = f.current.perProject[p.id];
            const off = !!s.excluded[p.id];
            const stageOff = s.stages.indexOf(p.stage) < 0;
            return { p, c, off, stageOff };
        // Ordered by what each project could bring at best, which no control
        // changes: switching a project or a stage never moves a row.
        }).sort((a, b) => (f.ceiling.perProject[b.p.id].value - f.ceiling.perProject[a.p.id].value)
            || String(a.p.name).localeCompare(String(b.p.name)));

        const body = rows.map(({ p, c, off, stageOff }) => {
            const value = c.counted ? RF.money(c.value) : (off ? 'Off' : (stageOff ? 'Stage off' : 'Off'));
            const width = c.counted ? (c.value / maxBest) * 100 : 0;
            return `
                <tr class="rf-row${c.counted ? '' : ' is-off'}" data-tone="${toneOf(p.stage)}">
                    <td><button type="button" class="rf-switch" role="switch" aria-checked="${!off}"
                        data-rf-project="${esc(p.id)}" data-rf-focus="project-${esc(p.id)}"
                        aria-label="${esc('Count ' + p.name)}"><span class="rf-switch-knob"></span></button></td>
                    <td class="rf-cell-project">
                        <span class="rf-row-bar" aria-hidden="true"></span>
                        <span class="rf-row-text">
                            <a href="#" class="rf-row-name" data-crm-action="open-project-overview" data-project-id="${esc(p.id)}">${esc(p.name)}</a>
                            <span class="rf-row-meta">${esc([p.company, labelOf(p.stage),
                                p.payments ? p.payments + (p.payments === 1 ? ' payment' : ' payments') : ''].filter(Boolean).join(' · '))}</span>
                        </span>
                    </td>
                    <td>${p.max > 0 ? esc(RF.budgetLabel(p.min, p.max)) : '<span class="rf-muted">–</span>'}</td>
                    <td>${p.chance}%</td>
                    <td class="rf-cell-runs">${esc(RF.periodLabel(p.s, p.e, now))}</td>
                    <td class="rf-cell-value">
                        <span class="rf-value-track" aria-hidden="true"><span class="rf-value-bar" style="width:${width.toFixed(1)}%"></span></span>
                        <span class="rf-value">${esc(value)}</span>
                    </td>
                </tr>`;
        }).join('');

        return `
            <div class="rf-detail" id="rfDetail">
                <div class="rf-detail-bar">
                    <span>Projects · ${f.counted} of ${ctx.items.length} counted</span>
                    ${excluded ? '<button type="button" class="rf-link" data-rf-include-all data-rf-focus="include-all">Include all</button>' : ''}
                </div>
                ${ctx.items.length ? `
                <div class="rf-table-scroll">
                    <table class="rf-table">
                        <thead><tr>
                            <th scope="col"><span class="rf-sr">Counted</span></th>
                            <th scope="col">Project</th><th scope="col">Budget</th><th scope="col">Chance</th>
                            <th scope="col">Runs</th><th scope="col">Counted</th>
                        </tr></thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>` : ''}
                ${missingNote(ctx)}
                <p class="rf-foot">The full budget counts, spread evenly over the months a project has left; one past its end date counts in this month,
                    one without a start date in its end month, one without an end date in the “No date” bar after the months.
                    Expected payments count in their own month instead; only the part of the budget they leave open is spread, and paid ones are left out.
                    <strong>Worst</strong>: only projects in progress, low end of the budget.
                    <strong>Realistic</strong>: all projects, middle of the budget × chance.
                    <strong>Best</strong>: every project won, high end of the budget.</p>
            </div>`;
    }

    function missingNote(ctx) {
        if (!ctx.missing.length) return '';
        const list = ctx.missing.map(p => `<li><a href="#" data-crm-action="open-project-overview" data-project-id="${esc(p.id)}">${esc(p.name)}</a>
            <span>no ${esc(p.gaps.join(', no ').replace('no end before start', 'end before start'))}</span></li>`).join('');
        const n = ctx.missing.length;
        return `<details class="rf-missing">
                <summary>${n} ${n === 1 ? 'project' : 'projects'} missing data, not in the forecast</summary>
                <ul>${list}</ul>
            </details>`;
    }

    function skeleton() {
        return `
            <div class="rf-top">
                <div class="rf-head"><h2 class="rf-title">Revenue forecast</h2></div>
                <div class="rf-body">
                    <div class="rf-summary">
                        <span class="rf-skel rf-skel--line"></span>
                        <span class="rf-skel rf-skel--hero"></span>
                        <span class="rf-skel rf-skel--line"></span>
                    </div>
                    <div class="rf-chart"><div class="rf-skel rf-skel--chart"></div></div>
                </div>
            </div>`;
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    function context() {
        const now = RF.monthOf(new Date());
        const prepared = RF.prepare(state.projects, now);
        const items = prepared.items;
        return {
            now,
            items,
            missing: prepared.missing,
            all: items.concat(prepared.missing),
            f: RF.forecast(items, state.settings)
        };
    }

    let current = null;

    function render() {
        const el = state.el;
        if (!el) return;

        el.setAttribute('aria-busy', String(state.loading));
        if (state.loading) {
            el.innerHTML = skeleton();
            return;
        }

        const active = document.activeElement;
        const focusKey = active && el.contains(active) ? active.getAttribute('data-rf-focus') : null;

        const ctx = context();
        current = ctx;
        state.hover = null;
        const expandBtn = `<button type="button" class="btn btn-secondary btn-small rf-expand" data-rf-expand data-rf-focus="expand"
            aria-expanded="${state.expanded}" aria-controls="rfDetail">${state.expanded ? 'Collapse' : 'Expand'}${CHEVRON}</button>`;

        if (!ctx.items.length) {
            el.innerHTML = `
                <div class="rf-top">
                    <div class="rf-head"><h2 class="rf-title">Revenue forecast</h2></div>
                    <p class="rf-empty">No active projects to forecast</p>
                    ${ctx.missing.length ? `<div class="rf-empty-missing">${missingNote(ctx)}</div>` : ''}
                </div>`;
            return;
        }

        el.innerHTML = `
            <div class="rf-top">
                <div class="rf-head">
                    <h2 class="rf-title">Revenue forecast</h2>
                    ${controls(ctx)}
                    ${expandBtn}
                </div>
                ${adjustPanel(ctx)}
                <div class="rf-body${state.expanded ? ' is-expanded' : ''}">
                    ${summary(ctx)}
                    ${chart(ctx)}
                </div>
            </div>
            ${state.expanded ? table(ctx) : ''}`;

        if (focusKey) {
            // "Reset" disappears once it has done its job; the keyboard goes back to Adjust.
            const again = el.querySelector(`[data-rf-focus="${focusKey}"]`) || el.querySelector('[data-rf-adjust]');
            if (again) again.focus();
        }
    }

    function showMonth(month) {
        if (!current || !state.el) return;
        state.hover = month;
        const line = state.el.querySelector('[data-rf-readout]');
        if (line) line.innerHTML = readout(current, month);
        state.el.querySelectorAll('[data-rf-month]').forEach(col => {
            col.classList.toggle('is-hover', Number(col.getAttribute('data-rf-month')) === month);
        });
        state.el.querySelectorAll('[data-rf-label]').forEach(lab => {
            lab.classList.toggle('is-hover', Number(lab.getAttribute('data-rf-label')) === month);
        });
    }

    function update(change) {
        change();
        store();
        render();
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    function bind(el) {
        el.addEventListener('click', e => {
            const t = e.target.closest('button');
            if (!t || !el.contains(t)) return;
            const s = state.settings;

            if (t.hasAttribute('data-rf-adjust')) {
                state.adjustOpen = !state.adjustOpen;
                render();
            } else if (t.hasAttribute('data-rf-expand')) {
                update(() => { state.expanded = !state.expanded; });
            } else if (t.hasAttribute('data-rf-preset')) {
                update(() => { state.settings = RF.settingsFor(t.getAttribute('data-rf-preset')); });
            } else if (t.hasAttribute('data-rf-chance')) {
                update(() => { s.chance = t.getAttribute('data-rf-chance'); });
            } else if (t.hasAttribute('data-rf-budget')) {
                update(() => { s.budget = t.getAttribute('data-rf-budget'); });
            } else if (t.hasAttribute('data-rf-stage')) {
                const key = t.getAttribute('data-rf-stage');
                update(() => {
                    s.stages = s.stages.indexOf(key) >= 0
                        ? s.stages.filter(k => k !== key)
                        : RF.STAGE_KEYS.filter(k => k === key || s.stages.indexOf(k) >= 0);
                });
            } else if (t.hasAttribute('data-rf-project')) {
                const id = t.getAttribute('data-rf-project');
                update(() => {
                    if (s.excluded[id]) delete s.excluded[id];
                    else s.excluded[id] = true;
                });
            } else if (t.hasAttribute('data-rf-include-all')) {
                update(() => { s.excluded = {}; });
            }
        });

        // Months: hover and focus show the month; leaving goes back to the busiest.
        el.addEventListener('mouseover', e => {
            const col = e.target.closest('[data-rf-month]');
            const month = col ? Number(col.getAttribute('data-rf-month')) : null;
            // The 2px gaps between columns still belong to the chart.
            if (month !== state.hover && (col || !e.target.closest('.rf-plot'))) showMonth(month);
        });
        el.addEventListener('mouseleave', () => { if (state.hover !== null) showMonth(null); });
        el.addEventListener('focusin', e => {
            const col = e.target.closest('[data-rf-month]');
            if (col) {
                state.focusMonth = Number(col.getAttribute('data-rf-month'));
                showMonth(state.focusMonth);
            }
        });
        el.addEventListener('focusout', e => {
            const into = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-rf-month]');
            if (e.target.closest('[data-rf-month]') && !into) showMonth(null);
        });

        // The months are one tab stop; the arrow keys walk through them.
        el.addEventListener('keydown', e => {
            const col = e.target.closest('[data-rf-month]');
            if (!col) return;
            const cols = Array.from(el.querySelectorAll('[data-rf-month]'));
            const i = cols.indexOf(col);
            let next = null;
            if (e.key === 'ArrowRight') next = Math.min(cols.length - 1, i + 1);
            else if (e.key === 'ArrowLeft') next = Math.max(0, i - 1);
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = cols.length - 1;
            if (next === null) return;
            e.preventDefault();
            col.tabIndex = -1;
            cols[next].tabIndex = 0;
            cols[next].focus();
        });
    }

    // ------------------------------------------------------------------
    // Public
    // ------------------------------------------------------------------

    function init(el) {
        if (!el || state.el === el) return;
        state.el = el;
        loadStored();
        bind(el);
        render();
    }

    /** Hand the card the whole company's projects (all stages; it filters). */
    function setProjects(projects) {
        state.projects = Array.isArray(projects) ? projects : [];
        state.loading = false;
        // Switches for projects that are gone are dropped.
        const ids = {};
        state.projects.forEach(p => { ids[p.id] = true; });
        Object.keys(state.settings.excluded).forEach(id => { if (!ids[id]) delete state.settings.excluded[id]; });
        render();
    }

    root.RevenueForecastCard = { init, setProjects };
})(window);
