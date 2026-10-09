/**
 * Bookkeeping tab
 * CSV import with column mapping, PDF (invoice) attachments per row,
 * unassigned-PDF drop zone with drag & drop assignment.
 *
 * Self-contained module; app.js only calls window.Bookkeeping.load()
 * when the tab becomes active.
 */
(function () {
    'use strict';

    const API = 'api/bookkeeping.php';

    const DATE_SORT_KEY = '__date__';
    const PDF_SORT_KEY = '__pdf__';

    /**
     * Where a row sits when sorting by its PDF state.
     *
     * Ascending puts the work first: entries still missing an invoice, then the
     * ones marked as not needing one, then the ones already settled. Clicking
     * again reverses it, which is the "everything done" end of the list.
     *
     * These are sentinels, not a scale - only their order matters.
     */
    const PDF_STATUS_MISSING = 0;
    const PDF_STATUS_NOT_NEEDED = 1;
    const PDF_STATUS_ASSIGNED = 2;

    function pdfStatusRank(row) {
        if (row.pdf) return PDF_STATUS_ASSIGNED;
        if (row.no_pdf_needed) return PDF_STATUS_NOT_NEEDED;
        return PDF_STATUS_MISSING;
    }

    const state = {
        columns: [],
        rows: [],
        pool: [],
        settings: { selected_columns: [], date_column: null, month_tax: {} },
        limits: { maxUploadBytes: 0, maxUploadLabel: '' },
        selection: new Set(),
        loaded: false,
        csv: null, // { headers, rows, fileName }
        pdfModalRowId: null,
        initialized: false,
        filterQuery: '',
        sortColumn: DATE_SORT_KEY,
        // Newest first: the entries being worked on are the recent ones.
        sortDirection: 'desc',
        // Import preview (step 2 of the import modal)
        importStep: 'columns',
        previewColumns: [],
        previewExcludedColumns: new Set(),
        previewDateColumn: null,
        previewRows: [] // [{ data, isDuplicate, selected }]
    };

    // ------------------------------------------------------------------
    // Column widths
    // ------------------------------------------------------------------
    // Widths the user dragged are remembered per browser, keyed by column
    // name so they survive a re-import. Every other column is measured once at
    // its natural width; after that the table switches to a fixed layout, so
    // columns also stop jumping around while the filter narrows the rows.

    const COL_WIDTHS_KEY = 'crm-bk-col-widths';
    const COL_MIN_WIDTH = 60;
    const COL_MAX_WIDTH = 1200;
    // The checkbox and menu columns, which are not resizable (see .bk-col-check / .bk-col-menu).
    const FIXED_COLS_WIDTH = 34 + 58;

    // Keyed by column names from an imported file, so the maps have no
    // prototype: a column called "constructor" must not find a built-in.
    const colWidths = {
        stored: readStoredColWidths(),
        measured: Object.create(null)
    };
    let suppressSortClick = false;

    function readStoredColWidths() {
        const widths = Object.create(null);
        try {
            const parsed = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                // Only sane numbers survive; anything else falls back to measuring.
                Object.keys(parsed).forEach(key => {
                    const width = Number(parsed[key]);
                    if (Number.isFinite(width) && width >= COL_MIN_WIDTH && width <= COL_MAX_WIDTH) {
                        widths[key] = Math.round(width);
                    }
                });
            }
        } catch (e) {
            // Unreadable storage: every column is measured instead
        }
        return widths;
    }

    function saveColWidths() {
        try {
            localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(colWidths.stored));
        } catch (e) {
            // Ignore storage errors; the widths still hold until the page reloads
        }
    }

    function colWidth(key) {
        return colWidths.stored[key] || colWidths.measured[key] || null;
    }

    /** Resizable columns in table order: the imported ones, then the PDF column. */
    function resizableColKeys() {
        return state.columns.map(c => c.name).concat(PDF_SORT_KEY);
    }

    function applyColWidths(table) {
        let total = FIXED_COLS_WIDTH;
        table.querySelectorAll('col[data-col-key]').forEach(col => {
            const width = colWidth(col.dataset.colKey);
            col.style.width = `${width}px`;
            total += width;
        });
        table.style.minWidth = `${total}px`;
        table.classList.add('bk-table-fixed');
    }

    /**
     * Measure the columns that have no width yet at their natural size, then
     * fix the layout. Skipped while the view is hidden, where everything
     * measures zero - the next render tries again.
     */
    function measureColWidths(table) {
        table.classList.add('bk-table-measuring');
        const headers = Array.from(table.querySelectorAll('th[data-col-key]'));
        if (headers.length === 0 || headers[0].getBoundingClientRect().width === 0) {
            table.classList.remove('bk-table-measuring');
            return;
        }
        headers.forEach(th => {
            const key = th.dataset.colKey;
            if (colWidth(key) === null) {
                colWidths.measured[key] = Math.max(COL_MIN_WIDTH, Math.ceil(th.getBoundingClientRect().width));
            }
        });
        table.classList.remove('bk-table-measuring');
        applyColWidths(table);
    }

    function startColResize(handle, event) {
        const table = handle.closest('table');
        const key = handle.dataset.colKey;
        const col = table && table.querySelector(`col[data-col-key="${CSS.escape(key)}"]`);
        if (!col) return;

        event.preventDefault();
        if (!table.classList.contains('bk-table-fixed')) measureColWidths(table);

        const startX = event.clientX;
        const startWidth = colWidth(key) || handle.closest('th').getBoundingClientRect().width;
        try {
            // Keeps the drag going when the pointer outruns the 10px handle.
            handle.setPointerCapture(event.pointerId);
        } catch (e) {
            // The pointer is already gone; the listeners below still work while it is over the handle.
        }
        document.body.classList.add('bk-col-resizing');

        const move = e => {
            const width = Math.round(Math.min(COL_MAX_WIDTH, Math.max(COL_MIN_WIDTH, startWidth + e.clientX - startX)));
            colWidths.stored[key] = width;
            applyColWidths(table);
        };
        const end = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            handle.removeEventListener('pointercancel', end);
            document.body.classList.remove('bk-col-resizing');
            saveColWidths();
            // Releasing the mouse over the header also "clicks" it, which
            // would re-sort the table. Swallow that one click.
            suppressSortClick = true;
            setTimeout(() => { suppressSortClick = false; }, 0);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    /** Double-click on a handle: forget that column's width and fit it to its content again. */
    function resetColWidth(key) {
        delete colWidths.stored[key];
        delete colWidths.measured[key];
        saveColWidths();
        renderTable();
    }

    const els = {};

    // ------------------------------------------------------------------
    // Utilities
    // ------------------------------------------------------------------

    function $(id) {
        return document.getElementById(id);
    }

    function getCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        // Escapes the five characters that can break out of either an HTML text
        // node or a quoted attribute value. Uploaded file names reach the DOM
        // through title="..." and data-pdf-name="..." attributes, so " and '
        // have to be encoded here as well.
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getInitials(name) {
        if (!name) return '?';
        const parts = String(name).trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) return '?';
        if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function formatSize(bytes) {
        if (!bytes) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    async function apiJson(action, options = {}) {
        const response = await fetch(`${API}?action=${action}`, options);
        const text = await response.text();

        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            // PHP can emit warnings (e.g. "POST Content-Length exceeds the
            // limit") before our JSON body, which makes the whole response
            // unparsable. Recover the JSON object rather than losing the
            // server's actual error message.
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start !== -1 && end > start) {
                try {
                    result = JSON.parse(text.slice(start, end + 1));
                } catch (inner) {
                    result = null;
                }
            }
            if (!result) {
                throw new Error(
                    response.status === 413
                        ? 'The upload was too large for the server.'
                        : `Server returned an unreadable response (HTTP ${response.status}).`
                );
            }
        }

        if (!response.ok || result.error) {
            throw new Error(result.error || 'Request failed');
        }
        return result;
    }

    function postJson(action, payload) {
        return apiJson(action, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify(payload)
        });
    }

    function postForm(action, formData) {
        formData.append('csrf_token', getCsrfToken());
        return apiJson(action, { method: 'POST', body: formData });
    }

    function showToast(message, isError = false) {
        let toast = $('bkToast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.toggle('bk-toast-error', isError);
        toast.classList.add('visible');
        clearTimeout(showToast._timer);
        showToast._timer = setTimeout(() => toast.classList.remove('visible'), 3500);
    }

    // ------------------------------------------------------------------
    // Generic confirm modal
    // ------------------------------------------------------------------

    function showConfirm({ title, message, actions }) {
        els.confirmTitle.textContent = title;
        els.confirmMessage.innerHTML = message;
        els.confirmActions.innerHTML = '';

        // Actions are listed first (most prominent, at the top of the
        // stacked footer), with Cancel appended last as the safe way out.
        actions.forEach(action => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn ' + (action.className || 'btn-primary');
            btn.textContent = action.label;
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    await action.handler();
                    closeConfirm();
                } catch (error) {
                    btn.disabled = false;
                    showToast(error.message, true);
                }
            });
            els.confirmActions.appendChild(btn);
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', closeConfirm);
        els.confirmActions.appendChild(cancelBtn);

        els.confirmModal.classList.add('active');
    }

    function closeConfirm() {
        els.confirmModal.classList.remove('active');
    }

    // ------------------------------------------------------------------
    // Data loading & rendering
    // ------------------------------------------------------------------

    // Tracks the in-flight/most recent load() call so other code (e.g. the
    // CSV import flow, which needs state.settings to already reflect the
    // server's remembered column selection) can await it instead of racing
    // against a fetch that may not have resolved yet.
    let loadPromise = null;
    let loading = false;

    function load() {
        init();
        loading = true;
        loadPromise = (async () => {
            try {
                // Rows can carry an assignee, and drawing that face needs the
                // people directory - load it first so the first paint is not
                // initials that turn into photos a moment later.
                if (window.CRMPeople && !window.CRMPeople.ready()) {
                    await window.CRMPeople.reload();
                }

                const result = await apiJson('table');
                state.columns = result.data.columns;
                state.rows = result.data.rows;
                state.pool = result.data.pool;
                state.settings = result.data.settings;
                if (result.data.limits) {
                    state.limits = {
                        maxUploadBytes: result.data.limits.max_upload_bytes || 0,
                        maxUploadLabel: result.data.limits.max_upload_label || ''
                    };
                }
                // Drop selections for rows that no longer exist
                const rowIds = new Set(state.rows.map(r => r.id));
                state.selection.forEach(id => { if (!rowIds.has(id)) state.selection.delete(id); });
                state.loaded = true;
                render();
            } catch (error) {
                showToast('Failed to load bookkeeping data: ' + error.message, true);
            } finally {
                loading = false;
            }
        })();
        return loadPromise;
    }

    /**
     * The table, fetching it only when nobody else already is.
     *
     * For arriving at the view, where two things ask for the table at the same
     * moment: switching tab triggers a load, and the home page following one of
     * its rows into the table triggers another right behind it. Anything that
     * has just *changed* something wants load() itself - a fetch that started
     * before the write would answer with the table as it was.
     */
    function loadIfIdle() {
        return loading ? loadPromise : load();
    }

    function render() {
        renderTable();
        renderPool();
        updateToolbar();
        populateSelectTools();
        ensureValidSortColumn();
    }

    /**
     * Falls back to the default date sort if the active sort column was
     * removed (e.g. pruned after its last row was deleted).
     */
    function ensureValidSortColumn() {
        const stillExists = state.sortColumn === DATE_SORT_KEY
            || state.sortColumn === PDF_SORT_KEY
            || state.columns.some(c => c.name === state.sortColumn);
        if (!stillExists) {
            state.sortColumn = DATE_SORT_KEY;
            state.sortDirection = 'desc';
        }
    }

    function rowSummary(row) {
        const parts = [];
        state.columns.forEach(col => {
            const value = (row.data[col.name] || '').trim();
            if (value !== '' && parts.length < 4) {
                parts.push(value);
            }
        });
        return parts.join(' · ') || `Row #${row.id}`;
    }

    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    function monthLabel(dateStr) {
        if (!dateStr) return 'No date';
        const [y, m] = dateStr.split('-').map(Number);
        return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
    }

    /**
     * Read what is typed in a tax box, accepting either decimal convention.
     *
     * Returns null for an empty field, which means "no tax set" rather than
     * zero - the difference decides whether a net line is shown at all.
     */
    function parseTaxInput(text) {
        const raw = String(text ?? '').trim();
        if (raw === '') return null;

        const value = parseDecimalValue(raw);
        if (value !== null) return value;

        // parseDecimalValue deliberately refuses whole numbers (so a date or a
        // reference is never mistaken for an amount). Here the field can only
        // be an amount, so a plain integer is fine.
        const plain = raw.replace(/[\s'.]/g, '').replace(',', '.');
        const num = Number(plain);
        return Number.isFinite(num) ? num : null;
    }

    /**
     * Recompute one month's net line from what is currently in its tax box.
     */
    /**
     * Recompute what a month shows from what is currently in its tax box.
     *
     * Two places move together: the Net line inside the breakdown, and the
     * single figure on the month row behind it - which switches between
     * showing the result and the net as the tax is typed in or cleared.
     */
    function updateNetFor(input) {
        const key = input.dataset.month;
        const totals = monthTotals(getDisplayRows(), detectAmountColumn());
        const sums = totals.get(key);
        if (!sums) return;

        const tax = parseTaxInput(input.value);
        const hasTax = tax !== null && tax !== 0;
        const net = sums.result - (tax ?? 0);

        const netCell = document.querySelector(`[data-net-for="${CSS.escape(key)}"]`);
        if (netCell) {
            netCell.textContent = formatSigned(net);
            netCell.className = signClass(net);
        }

        const shown = hasTax ? net : sums.result;
        const totalCell = document.querySelector(`[data-total-for="${CSS.escape(key)}"]`);
        if (totalCell) {
            totalCell.textContent = formatSigned(shown);
            totalCell.className = signClass(shown);
            const label = totalCell.parentElement.querySelector('.bk-month-stat-label');
            if (label) label.textContent = hasTax ? 'Net' : 'Gross';
        }
    }

    /**
     * Persist one month's tax amount.
     */
    async function saveMonthTax(input) {
        const key = input.dataset.month;
        const tax = parseTaxInput(input.value);

        if (input.value.trim() !== '' && tax === null) {
            // Unparseable: put back whatever was last saved rather than leaving
            // a number on screen that is not the number being used.
            const stored = state.settings.month_tax?.[key];
            input.value = stored ? stored.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
            updateNetFor(input);
            return;
        }

        if (!state.settings.month_tax) state.settings.month_tax = {};
        if (tax === null) {
            delete state.settings.month_tax[key];
        } else {
            state.settings.month_tax[key] = tax;
        }

        // Normalize what is displayed to the stored value.
        input.value = tax === null ? '' : tax.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        updateNetFor(input);

        try {
            await postJson('set-month-tax', { month: key, amount: tax });
        } catch (error) {
            showToast(`Could not save the tax amount: ${error.message}`, true);
        }
    }

    /**
     * "2026-07" for a row, used as the key for month totals and month tax.
     */
    function monthKey(dateStr) {
        return /^\d{4}-\d{2}/.test(String(dateStr || '')) ? String(dateStr).slice(0, 7) : '';
    }

    /**
     * Which column holds the amount.
     *
     * Nothing records this - the import only ever asks which column is the
     * date - so it is inferred the same way the date column is guessed: by
     * looking at the values. The winner is the column where the most values
     * parse as decimals, which on a bank export is the one signed amount
     * column ("Betrag", "Amount", "Umsatz"). A name match is preferred when it
     * also carries numbers, so a stray numeric reference column cannot win.
     */
    function detectAmountColumn() {
        if (!state.columns.length || !state.rows.length) return null;

        const named = /^(betrag|amount|umsatz|summe|value|wert|saldo|total)$/i;
        let best = null;

        state.columns.forEach(col => {
            if (isDateSortColumn(col.name)) return;

            let parsed = 0;
            state.rows.forEach(row => {
                if (parseDecimalValue(row.data[col.name]) !== null) parsed++;
            });
            if (parsed === 0) return;

            // A column has to look like an amount in most of its rows before it
            // is believed at all - one numeric cell in a text column is noise.
            const ratio = parsed / state.rows.length;
            if (ratio < 0.5) return;

            const score = ratio + (named.test(col.name.trim()) ? 1 : 0);
            if (!best || score > best.score) {
                best = { name: col.name, score };
            }
        });

        return best ? best.name : null;
    }

    /**
     * Income, expenses and result per month, over the rows currently shown.
     *
     * Built from the displayed rows rather than every row, so the totals always
     * describe the list underneath them - filter the table and the sums follow.
     *
     * @return {Map<string, {income: number, expenses: number, result: number}>}
     */
    function monthTotals(rows, amountColumn) {
        const totals = new Map();
        if (!amountColumn) return totals;

        rows.forEach(row => {
            const key = monthKey(row.row_date);
            if (!key) return;

            const value = parseDecimalValue(row.data[amountColumn]);
            if (value === null) return;

            if (!totals.has(key)) {
                totals.set(key, { income: 0, expenses: 0, result: 0, excluded: 0 });
            }
            const bucket = totals.get(key);

            // An excluded row still belongs to the month - it is only kept out
            // of the arithmetic. Counting it lets the breakdown say how many
            // entries are being left out, so a total can never quietly
            // disagree with the rows above it.
            if (row.excluded) {
                bucket.excluded += 1;
                return;
            }

            if (value >= 0) {
                bucket.income += value;
            } else {
                bucket.expenses += value;
            }
            bucket.result += value;
        });

        return totals;
    }

    /**
     * The colour class for a signed figure. Zero is neither a gain nor a loss,
     * so it stays in the body colour instead of rendering green.
     */
    function signClass(value) {
        if (!Number.isFinite(value) || Math.abs(value) < 0.005) return '';
        return value < 0 ? 'bk-amount-neg' : 'bk-amount-pos';
    }

    /**
     * Format a signed amount the way the table's own values read: German
     * grouping, two decimals, explicit sign.
     */
    function formatSigned(value) {
        const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
        return sign + Math.abs(value).toLocaleString('de-DE', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    /**
     * A month separator: its name and one number.
     *
     * The line used to carry Income, Expenses, Result, a tax box and Net all
     * at once, which is five figures competing for attention on a row that is
     * mostly a label. Only the conclusion stays out here - labelled Gross
     * while no tax has been entered, and Net once one has - and the workings
     * move into the breakdown popover behind it.
     */
    function monthRowContent(dateStr, label, totals) {
        const key = monthKey(dateStr);
        const sums = key ? totals.get(key) : null;

        if (!sums) {
            // No amount column, or nothing in this month parsed as one: show
            // the month exactly as it used to look, with nothing to add up.
            return `<div class="bk-month-line"><span class="bk-month-name">${escapeHtml(label)}</span></div>`;
        }

        const tax = Number(state.settings.month_tax?.[key] ?? 0);
        const hasTax = Number.isFinite(tax) && tax !== 0;
        const shown = hasTax ? sums.result - tax : sums.result;

        return `
            <div class="bk-month-line">
                <span class="bk-month-name">${escapeHtml(label)}</span>
                <button type="button"
                        class="bk-month-total"
                        data-action="month-breakdown"
                        data-month="${key}"
                        aria-haspopup="dialog"
                        aria-expanded="false"
                        title="Show income, expenses and tax for ${escapeHtml(label)}">
                    <span class="bk-month-stat-label">${hasTax ? 'Net' : 'Gross'}</span>
                    <span class="${signClass(shown)}" data-total-for="${key}">${formatSigned(shown)}</span>
                    ${sums.excluded > 0 ? `<span class="bk-month-excluded-dot" title="${sums.excluded} entr${sums.excluded === 1 ? 'y' : 'ies'} excluded"></span>` : ''}
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" class="bk-month-chevron" aria-hidden="true">
                        <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                    </svg>
                </button>
            </div>`;
    }

    /**
     * The breakdown popover: the workings behind a month's one figure.
     *
     * Rebuilt from current state each time it opens, so it cannot drift from
     * the table, and anchored to the button that opened it.
     */
    function openMonthBreakdown(button) {
        closeMonthBreakdown();

        const key = button.dataset.month;
        const totals = monthTotals(getDisplayRows(), detectAmountColumn());
        const sums = totals.get(key);
        if (!sums) return;

        const tax = Number(state.settings.month_tax?.[key] ?? 0);
        const hasTax = Number.isFinite(tax) && tax !== 0;
        const net = sums.result - tax;

        const panel = document.createElement('div');
        panel.className = 'bk-breakdown';
        panel.id = 'bkMonthBreakdown';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Month breakdown');
        panel.innerHTML = `
            <p class="bk-breakdown-title">${escapeHtml(monthLabel(key + '-01'))}</p>
            <div class="bk-breakdown-row">
                <span>Income</span>
                <span class="${signClass(sums.income)}">${formatSigned(sums.income)}</span>
            </div>
            <div class="bk-breakdown-row">
                <span>Expenses</span>
                <span class="${signClass(sums.expenses)}">${formatSigned(sums.expenses)}</span>
            </div>
            <div class="bk-breakdown-sep"></div>
            <div class="bk-breakdown-row bk-breakdown-row--strong">
                <span>Gross</span>
                <span class="${signClass(sums.result)}">${formatSigned(sums.result)}</span>
            </div>
            <div class="bk-breakdown-row">
                <label for="bkTax-${key}">Tax</label>
                <input type="text"
                       inputmode="decimal"
                       id="bkTax-${key}"
                       class="bk-month-tax-input"
                       data-month="${key}"
                       value="${hasTax ? escapeHtml(tax.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : ''}"
                       placeholder="0,00"
                       title="A flat amount deducted from this month's result. Negative adds it back.">
            </div>
            <div class="bk-breakdown-sep"></div>
            <div class="bk-breakdown-row bk-breakdown-row--strong">
                <span>Net</span>
                <span class="${signClass(net)}" data-net-for="${key}">${formatSigned(net)}</span>
            </div>
            ${sums.excluded > 0 ? `
                <p class="bk-breakdown-note">
                    ${sums.excluded} entr${sums.excluded === 1 ? 'y is' : 'ies are'} excluded from these totals.
                </p>` : ''}
        `;

        document.body.appendChild(panel);

        // Anchored in viewport coordinates on <body> rather than inside the
        // scrolling table, where the cell's own overflow would clip it.
        const r = button.getBoundingClientRect();
        const width = panel.offsetWidth;
        const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
        const below = r.bottom + 6;
        const fitsBelow = below + panel.offsetHeight < window.innerHeight - 8;
        panel.style.left = `${left}px`;
        panel.style.top = fitsBelow ? `${below}px` : `${Math.max(8, r.top - panel.offsetHeight - 6)}px`;

        button.setAttribute('aria-expanded', 'true');
        button.classList.add('is-open');

        const input = panel.querySelector('.bk-month-tax-input');
        if (input) input.focus();
    }

    function closeMonthBreakdown() {
        const panel = document.getElementById('bkMonthBreakdown');
        if (panel) panel.remove();

        els.tableWrap.querySelectorAll('.bk-month-total.is-open').forEach(btn => {
            btn.classList.remove('is-open');
            btn.setAttribute('aria-expanded', 'false');
        });
    }

    /**
     * Keeps the month/year selectors' option lists in sync with the years
     * actually present in the data, preserving the user's current picks
     * where still valid.
     */
    function populateSelectTools() {
        if (!els.selectMonth) return;

        const years = new Set();
        state.rows.forEach(row => {
            if (row.row_date) years.add(parseInt(row.row_date.slice(0, 4), 10));
        });
        if (years.size === 0) {
            years.add(new Date().getFullYear());
        }
        const sortedYears = Array.from(years).sort((a, b) => b - a);

        const prevMonth = els.selectMonth.value;
        const prevYear = els.selectYear.value;

        els.selectMonth.innerHTML = MONTH_NAMES.map((name, index) =>
            `<option value="${index + 1}">${name}</option>`
        ).join('');
        els.selectYear.innerHTML = sortedYears.map(year =>
            `<option value="${year}">${year}</option>`
        ).join('');

        if (prevMonth && parseInt(prevMonth, 10) >= 1 && parseInt(prevMonth, 10) <= 12) {
            els.selectMonth.value = prevMonth;
        }
        if (prevYear && sortedYears.includes(parseInt(prevYear, 10))) {
            els.selectYear.value = prevYear;
        }
    }

    /**
     * The Select popover. Its state lives on the button's aria-expanded and the
     * panel's hidden attribute, so the markup stays the source of truth and
     * assistive tech is told the same thing the styling shows.
     */
    function openSelectTools() {
        if (!els.selectTools) return;
        els.selectTools.hidden = false;
        els.selectToolsBtn.setAttribute('aria-expanded', 'true');
        els.selectToolsBtn.parentElement.classList.add('is-open');
        // Land on the first control, so the popover is usable from the keyboard.
        if (els.selectMonth) els.selectMonth.focus();
    }

    function closeSelectTools() {
        if (!els.selectTools || els.selectTools.hidden) return;
        els.selectTools.hidden = true;
        els.selectToolsBtn.setAttribute('aria-expanded', 'false');
        els.selectToolsBtn.parentElement.classList.remove('is-open');
    }

    function selectRowsByMonth() {
        const month = parseInt(els.selectMonth.value, 10);
        const year = parseInt(els.selectYear.value, 10);
        if (!month || !year) return;

        const prefix = `${year}-${String(month).padStart(2, '0')}`;
        const matches = state.rows.filter(row => row.row_date && row.row_date.startsWith(prefix));

        state.selection = new Set(matches.map(row => row.id));
        render();

        const label = `${MONTH_NAMES[month - 1]} ${year}`;
        showToast(
            matches.length > 0
                ? `Selected ${matches.length} row${matches.length === 1 ? '' : 's'} from ${label}`
                : `No entries found in ${label}`,
            matches.length === 0
        );
    }

    function selectRowsByRange() {
        const from = els.selectFrom.value;
        const to = els.selectTo.value;
        if (!from || !to) {
            showToast('Choose both a start and end date', true);
            return;
        }
        if (from > to) {
            showToast('The start date must be before the end date', true);
            return;
        }

        const matches = state.rows.filter(row => row.row_date && row.row_date >= from && row.row_date <= to);
        state.selection = new Set(matches.map(row => row.id));
        render();

        showToast(
            matches.length > 0
                ? `Selected ${matches.length} row${matches.length === 1 ? '' : 's'} from ${from} to ${to}`
                : 'No entries found in that date range',
            matches.length === 0
        );
    }

    /**
     * Returns state.rows filtered by state.filterQuery and sorted by
     * state.sortColumn/state.sortDirection. Defaults to newest first (undated
     * rows last) regardless of import batch, so entries always line up
     * chronologically no matter when each CSV was uploaded.
     */
    /**
     * Parses a cell value that represents a decimal amount, handling both
     * "1.234,56" and "1,234.56" styles plus currency decoration. Returns null
     * for anything that isn't clearly a decimal number - notably dates
     * ("07.03.2026"), IBANs and plain account numbers, which must not be
     * mistaken for amounts.
     */
    function parseDecimalValue(value) {
        let raw = String(value ?? '').trim();
        if (raw === '') return null;

        raw = raw.replace(/[€$£]|\b(?:EUR|USD|CHF|GBP)\b/gi, '').trim();

        let negatedByParens = false;
        if (/^\(.+\)$/.test(raw)) {
            negatedByParens = true;
            raw = raw.slice(1, -1).trim();
        }

        if (!/^[-+]?[\d.,'\s]+$/.test(raw)) return null;

        const lastSep = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
        if (lastSep === -1) return null; // integers aren't treated as amounts

        const fracPart = raw.slice(lastSep + 1);
        if (!/^\d{1,2}$/.test(fracPart)) return null; // e.g. "07.03.2026" -> not an amount

        const intPart = raw.slice(0, lastSep).replace(/[.,'\s]/g, '');
        if (!/^[-+]?\d*$/.test(intPart)) return null;

        const num = parseFloat(`${intPart === '' || intPart === '+' || intPart === '-' ? intPart + '0' : intPart}.${fracPart}`);
        if (isNaN(num)) return null;

        return negatedByParens ? -num : num;
    }

    /**
     * Strict numeric parse for sorting. Unlike parseFloat, it rejects values
     * that merely *start* with digits - "2026-03-05" and "05.03.2026" are
     * dates, not numbers, and parseFloat would silently turn them into 2026
     * and 5.03 respectively. Returns null when the value isn't a plain number.
     */
    function parseSortableNumber(value) {
        const raw = String(value ?? '')
            .trim()
            .replace(/[€$£\s']/g, '')
            .replace(/\b(?:EUR|USD|CHF|GBP)\b/gi, '');
        if (raw === '') return null;
        if (!/^[-+]?[\d.,]+$/.test(raw)) return null;

        const lastSep = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
        let normalized;
        if (lastSep === -1) {
            normalized = raw;
        } else {
            const frac = raw.slice(lastSep + 1);
            // More than 2 decimals means the separators are grouping marks or
            // this is a date-like value, not a decimal number.
            if (!/^\d{1,2}$/.test(frac)) return null;
            normalized = `${raw.slice(0, lastSep).replace(/[.,]/g, '')}.${frac}`;
        }

        const num = parseFloat(normalized);
        return isNaN(num) ? null : num;
    }

    function amountClass(value, columnName) {
        if (columnName && isDateSortColumn(columnName)) return '';
        const num = parseDecimalValue(value);
        if (num === null || num === 0) return '';
        return num < 0 ? 'bk-amount-neg' : 'bk-amount-pos';
    }

    /**
     * True when sorting by this column should be treated as chronological:
     * it uses each row's normalized row_date (so "07.03.2026" style values
     * sort correctly) and keeps the month separators visible.
     */
    function isDateSortColumn(colName) {
        if (colName === DATE_SORT_KEY) return true;
        if (state.settings.date_column && colName === state.settings.date_column) return true;
        return looksLikeDateColumn(colName);
    }

    function getDisplayRows() {
        let rows = state.rows;

        const query = state.filterQuery.trim().toLowerCase();
        if (query !== '') {
            rows = rows.filter(row => {
                if (String(row.row_date || '').toLowerCase().includes(query)) return true;
                if (row.pdf && row.pdf.name.toLowerCase().includes(query)) return true;
                return state.columns.some(col => String(row.data[col.name] ?? '').toLowerCase().includes(query));
            });
        }

        const dir = state.sortDirection === 'desc' ? -1 : 1;
        const sortCol = state.sortColumn;
        const byDate = isDateSortColumn(sortCol);
        const byPdf = sortCol === PDF_SORT_KEY;

        rows = [...rows].sort((a, b) => {
            let cmp;

            if (byPdf) {
                cmp = pdfStatusRank(a) - pdfStatusRank(b);
                // Within one status the rows are still a statement, so they
                // stay in date order rather than falling back to insertion id.
                // Not multiplied by the direction: reversing the click flips
                // which status leads, while each group stays chronological,
                // which is the order these are actually read in.
                if (cmp === 0) {
                    const va = a.row_date || '';
                    const vb = b.row_date || '';
                    if (va !== vb) {
                        if (va === '' || vb === '') return va === '' ? 1 : -1;
                        return va < vb ? -1 : 1;
                    }
                }
            } else if (byDate) {
                const va = a.row_date || '';
                const vb = b.row_date || '';
                // Rows without a parsable date sort last either way round.
                if (va === '' || vb === '') {
                    if (va === vb) return a.id - b.id;
                    return va === '' ? 1 : -1;
                }
                // row_date is ISO (YYYY-MM-DD), which orders correctly as text.
                cmp = va < vb ? -1 : va > vb ? 1 : 0;
            } else {
                const va = a.data[sortCol] ?? '';
                const vb = b.data[sortCol] ?? '';
                const na = parseSortableNumber(va);
                const nb = parseSortableNumber(vb);
                cmp = (na !== null && nb !== null)
                    ? na - nb
                    : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
            }

            if (cmp === 0) return a.id - b.id;
            return cmp * dir;
        });

        return rows;
    }

    function renderTable() {
        const wrap = els.tableInner;

        // Anchored to a button that is about to be replaced.
        closeRowMenu();

        if (state.rows.length === 0) {
            wrap.innerHTML = `
                <div class="bk-empty">
                    <p><strong>No entries yet.</strong></p>
                    <p>Import a CSV file (e.g. a bank statement) to get started.</p>
                </div>`;
            return;
        }

        const displayRows = getDisplayRows();

        if (displayRows.length === 0) {
            wrap.innerHTML = `
                <div class="bk-empty">
                    <p><strong>No entries match your filter.</strong></p>
                    <p>Try a different search term.</p>
                </div>`;
            return;
        }

        // Month separators stay visible for any chronological sort, not just
        // the implicit default one.
        const groupByMonth = isDateSortColumn(state.sortColumn);
        const colCount = state.columns.length + 4; // checkbox + menu + columns + pdf + filler

        // With the default (implicit) date sort, highlight the date column's
        // own header so the active sort is always visible on a real column.
        const dateColumn = state.columns.find(c => isDateSortColumn(c.name));
        const activeSortCol = state.sortColumn === DATE_SORT_KEY
            ? (dateColumn ? dateColumn.name : null)
            : state.sortColumn;

        // Tight viewBox around the triangle so the rendered size is the arrow
        // size (a 24x24 icon only uses ~20% of its box and looks like a dot).
        const triangleDown = '<svg class="bk-sort-arrow" viewBox="0 0 10 6" width="10.5" height="6.3" fill="currentColor" aria-hidden="true"><path d="M0 0 L5 6 L10 0 Z"/></svg>';
        const triangleUp = '<svg class="bk-sort-arrow" viewBox="0 0 10 6" width="10.5" height="6.3" fill="currentColor" aria-hidden="true"><path d="M0 6 L5 0 L10 6 Z"/></svg>';
        const dirIndicator = state.sortDirection === 'desc' ? triangleUp : triangleDown;

        // Resolved before any markup is built: the header row needs to know
        // which column is the amount, and the month separators need the totals.
        // Totals come from the displayed rows, so filtering the table narrows
        // the sums with it rather than leaving a figure that no longer matches
        // what is on screen.
        const amountColumn = detectAmountColumn();
        const totals = monthTotals(displayRows, amountColumn);
        const isAmountCol = name => amountColumn !== null && name === amountColumn;

        // Once every column has a width the layout is fixed straight away;
        // otherwise it renders naturally first and is measured below.
        const colKeys = resizableColKeys();
        const allSized = colKeys.every(key => colWidth(key) !== null);
        const resizer = key => `<span class="bk-col-resizer" data-col-key="${escapeHtml(key)}" title="Drag to resize, double-click to fit" aria-hidden="true"></span>`;

        let html = `<table class="bk-table"><colgroup><col class="bk-col-check"><col class="bk-col-menu">`;
        colKeys.forEach(key => {
            html += `<col data-col-key="${escapeHtml(key)}">`;
        });
        // The filler takes whatever width the sized columns leave over, so
        // widening one column never squeezes the others.
        html += '<col class="bk-col-fill"></colgroup><thead><tr>';
        html += `<th class="bk-col-check"><input type="checkbox" id="bkSelectAll" title="Select all" ${displayRows.length > 0 && displayRows.every(r => state.selection.has(r.id)) ? 'checked' : ''}></th>`;
        html += '<th class="bk-col-menu"></th>';
        state.columns.forEach(col => {
            const active = col.name === activeSortCol;
            const amount = isAmountCol(col.name) ? ' bk-col-amount' : '';
            html += `<th class="bk-sortable-th${amount} ${active ? 'bk-sort-active' : ''}" data-sort-key="${escapeHtml(col.name)}" data-col-key="${escapeHtml(col.name)}" title="Sort by ${escapeHtml(col.name)}">
                <span>${escapeHtml(col.name)}</span>${active ? dirIndicator : ''}${resizer(col.name)}
            </th>`;
        });
        // Sortable like any other header, but by state rather than by text:
        // "PDF missing" is not a value in a cell, so it needs its own key.
        const pdfActive = state.sortColumn === PDF_SORT_KEY;
        html += `<th class="bk-sortable-th bk-col-pdf ${pdfActive ? 'bk-sort-active' : ''}"
                     data-sort-key="${PDF_SORT_KEY}" data-col-key="${PDF_SORT_KEY}"
                     title="Sort by PDF status">
                <span>PDF / Invoice</span>${pdfActive ? dirIndicator : ''}${resizer(PDF_SORT_KEY)}
            </th>`;
        html += '<th class="bk-col-fill" aria-hidden="true"></th>';
        html += '</tr></thead><tbody>';

        let previousMonth = null;
        displayRows.forEach(row => {
            if (groupByMonth) {
                const month = monthLabel(row.row_date);
                if (month !== previousMonth) {
                    html += `<tr class="bk-month-row"><td colspan="${colCount}">${monthRowContent(row.row_date, month, totals)}</td></tr>`;
                    previousMonth = month;
                }
            }

            const ok = !!row.pdf || row.no_pdf_needed;
            const selected = state.selection.has(row.id);
            html += `<tr class="bk-row ${ok ? 'bk-row-ok' : 'bk-row-missing'} ${selected ? 'bk-row-selected' : ''} ${row.excluded ? 'bk-row-excluded' : ''}" data-row-id="${row.id}">`;
            html += `<td class="bk-col-check"><input type="checkbox" class="bk-row-check" data-row-id="${row.id}" ${selected ? 'checked' : ''}></td>`;
            html += `<td class="bk-col-menu">${rowMenuCell(row)}</td>`;
            state.columns.forEach(col => {
                const value = row.data[col.name] ?? '';
                const classes = [amountClass(value, col.name)];
                if (isAmountCol(col.name)) classes.push('bk-col-amount');
                html += `<td class="${classes.filter(Boolean).join(' ')}">${escapeHtml(value)}</td>`;
            });

            // PDF status cell
            html += '<td class="bk-col-pdf">';
            if (row.pdf) {
                html += `
                    <span class="bk-pdf-chip" title="${escapeHtml(row.pdf.name)}">
                        <a href="#" data-action="preview-pdf" data-pdf-id="${row.pdf.id}" data-pdf-name="${escapeHtml(row.pdf.name)}">${escapeHtml(row.pdf.name)}</a>
                        <button type="button" class="bk-pdf-remove" data-action="remove-pdf" data-row-id="${row.id}" title="Remove PDF">&times;</button>
                    </span>`;
            } else if (row.no_pdf_needed) {
                html += '<span class="bk-badge bk-badge-nopdf">No PDF needed</span>';
            } else {
                html += '<span class="bk-badge bk-badge-missing">PDF missing</span>';
            }
            html += '</td>';
            html += '<td class="bk-col-fill"></td>';

            html += '</tr>';
        });

        html += '</tbody></table>';
        wrap.innerHTML = html;

        const table = wrap.querySelector('table.bk-table');
        if (allSized) {
            applyColWidths(table);
        } else {
            measureColWidths(table);
        }
    }

    function renderPool() {
        const count = state.pool.length;
        els.poolCount.textContent = count === 1 ? '1 file' : `${count} files`;

        if (count === 0) {
            els.poolList.innerHTML = '<p class="bk-pool-empty">No unassigned PDFs.<br>Drop files here to store them until the matching bank entry is imported.</p>';
            return;
        }

        // An invoice Claude uploaded is marked until somebody accepts it -
        // here, or by simply dragging it onto its row.
        const review = window.CRMReview;
        els.poolList.innerHTML = state.pool.map(pdf => `
            <div class="bk-pool-item${pdf.review_status === 'pending' ? ' is-proposed' : ''}" draggable="true" data-pdf-id="${pdf.id}" title="Drag onto a table row to assign">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" class="bk-pool-item-icon"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
                <div class="bk-pool-item-info">
                    <a class="bk-pool-item-name" href="#" data-action="preview-pdf" data-pdf-id="${pdf.id}" data-pdf-name="${escapeHtml(pdf.name)}">${escapeHtml(pdf.name)}</a>
                    <span class="bk-pool-item-size">${formatSize(pdf.size)} ${review ? review.badge(pdf) : ''}</span>
                </div>
                ${pdf.review_status === 'pending' && review ? review.inlineActions('bookkeeping_pdf', pdf.id) : ''}
                <button type="button" class="bk-icon-btn bk-icon-btn-danger" data-action="delete-pool-pdf" data-pdf-id="${pdf.id}" title="Delete PDF">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
            </div>
        `).join('');
    }

    // ------------------------------------------------------------------
    // Row menu
    //
    // Every per-row action lives behind the three dots between the tick box
    // and the first column. A row has half a dozen things you can do to it and
    // the table has hundreds of rows, so as a strip of icons that was a wall of
    // buttons on every line - and one more each time an action was added.
    // ------------------------------------------------------------------

    const ICON_DOTS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>';
    const ICON_UPLOAD = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>';
    const ICON_NOPDF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="3.5" y1="20.5" x2="20.5" y2="3.5"/></svg>';
    const ICON_EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>';
    const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 7a5 5 0 0 1 5 5c0 .65-.13 1.26-.36 1.83l2.92 2.92A11.8 11.8 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2.7 3.42 1.29 4.83l2.53 2.53A11.77 11.77 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.52 0 2.98-.29 4.32-.82l3.02 3.02 1.41-1.41L2.7 3.42zM7.53 11.07A4.6 4.6 0 0 0 7.5 12a4.5 4.5 0 0 0 6.44 4.06l-1.5-1.5A3 3 0 0 1 9 12l-.02-.2-1.45-1.45z"/></svg>';
    const ICON_CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M9.3 6.7 14.6 12l-5.3 5.3 1.4 1.4L17.4 12l-6.7-6.7z"/></svg>';
    const ICON_TICK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    const ICON_PERSON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
    const ICON_NOBODY = '<span class="bk-menu-face is-none"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><line x1="6.1" y1="17.9" x2="17.9" y2="6.1"/></svg></span>';
    const ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

    /**
     * The dots, plus the face of whoever this row is waiting on.
     */
    function rowMenuCell(row) {
        return `
            <div class="bk-row-menu-cell">
                <button type="button" class="bk-row-menu-btn" data-action="row-menu" data-row-id="${row.id}"
                        aria-haspopup="menu" aria-expanded="false" title="Row actions" aria-label="Row actions">
                    ${ICON_DOTS}
                </button>
                ${assigneeFace(row)}
            </div>`;
    }

    /**
     * The small face that says a row is somebody's job. Nothing is drawn for an
     * unassigned row - that is almost every row, and a placeholder on each one
     * would be noise rather than information.
     */
    function assigneeFace(row) {
        const name = row.assigned_to_name;
        if (!name) return '';

        const url = window.CRMPeople ? window.CRMPeople.avatarFor(assigneeKey(row), name) : null;
        const inner = url
            ? `<img src="${escapeHtml(url)}" alt="">`
            : escapeHtml(getInitials(name));

        return `<span class="bk-assignee${url ? ' has-photo' : ''}" title="Waiting on ${escapeHtml(name)}">${inner}</span>`;
    }

    /** The owner is id 0 in the database but 'owner' to the people directory. */
    function assigneeKey(row) {
        const raw = row.assigned_to;
        if (raw === null || raw === undefined || raw === '') return '';
        return Number(raw) === 0 ? 'owner' : String(Number(raw));
    }

    function rowMenuContent(row) {
        // A row that already has its PDF has nothing to hand over, so it is
        // only offered the entry when there is an assignment to undo.
        const canAssign = !row.pdf || row.assigned_to_name;

        // No heading repeating the row: the menu opens against the row it
        // belongs to, which already says what it is.
        let html = '';

        if (canAssign) {
            html += menuItem('assign', ICON_PERSON, 'Waiting on', row.id, '', {
                submenu: true,
                value: row.assigned_to_name || 'Nobody'
            });
            html += '<div class="bk-rowmenu-sep"></div>';
        }

        if (!row.pdf) {
            html += menuItem('upload', ICON_UPLOAD, 'Upload PDF', row.id);
            html += menuItem('toggle-nopdf', ICON_NOPDF,
                row.no_pdf_needed ? 'Mark as: PDF required' : 'Mark as: no PDF needed', row.id,
                row.no_pdf_needed ? 'is-active' : '');
        } else {
            html += menuItem('remove-pdf', ICON_TRASH, 'Remove PDF', row.id);
        }

        html += menuItem('toggle-excluded', row.excluded ? ICON_EYE : ICON_EYE_OFF,
            row.excluded ? 'Include in month totals' : 'Exclude from month totals', row.id,
            row.excluded ? 'is-active' : '');

        html += '<div class="bk-rowmenu-sep"></div>';
        html += menuItem('delete-row', ICON_TRASH, 'Delete row', row.id, 'is-danger');

        return html;
    }

    /**
     * One line of the menu. `options.submenu` turns it into the kind of entry
     * that opens a second panel beside this one, with the current value shown
     * on the way to it - the arrangement the system menus use.
     */
    function menuItem(action, icon, label, rowId, extraClass, options) {
        const opts = options || {};
        const trail = opts.submenu
            ? `<span class="bk-rowmenu-item-value">${escapeHtml(opts.value || '')}</span>`
              + `<span class="bk-rowmenu-item-arrow">${ICON_CHEVRON}</span>`
            : '';

        return `
            <button type="button" class="bk-rowmenu-item${extraClass ? ' ' + extraClass : ''}" role="menuitem"
                    ${opts.submenu ? 'aria-haspopup="menu" aria-expanded="false" data-submenu="1"' : ''}
                    data-action="${action}" data-row-id="${rowId}">
                <span class="bk-rowmenu-item-icon">${icon}</span>
                <span class="bk-rowmenu-item-label">${escapeHtml(label)}</span>
                ${trail}
            </button>`;
    }

    /**
     * The people list, as a menu of its own.
     *
     * Everyone who can be assigned work, plus the way back to nobody, with a
     * tick against whoever has the row now - the same shape as the system
     * submenus, so there is nothing new to learn about how it behaves.
     */
    function assignSubmenuContent(row) {
        const people = window.CRMPeople ? window.CRMPeople.list() : [];
        const current = assigneeKey(row);

        let html = '<p class="bk-rowmenu-subhead">Waiting on</p>';

        html += assignOption(row, '', 'Nobody', ICON_NOBODY, current === '', 'is-nobody');

        people.forEach(person => {
            const key = person.id === null ? 'owner' : String(person.id);
            html += assignOption(row, key, person.name, personFace(key, person.name), key === current);
        });

        // Somebody whose account has since been removed still has to appear,
        // or the row's own assignee would be missing from the list of who has
        // it - and there would be no tick anywhere to explain the face on the
        // row.
        if (current && !people.some(p => (p.id === null ? 'owner' : String(p.id)) === current)) {
            const name = row.assigned_to_name || 'Unknown';
            html += assignOption(row, current, name, personFace(current, name), true);
        }

        html += '<p class="bk-rowmenu-subnote">They see the row on their home page until a PDF is attached.</p>';

        return html;
    }

    function assignOption(row, value, name, icon, isCurrent, extraClass) {
        return `
            <button type="button" class="bk-rowmenu-item bk-rowmenu-option${isCurrent ? ' is-current' : ''}${extraClass ? ' ' + extraClass : ''}"
                    role="menuitemradio" aria-checked="${isCurrent ? 'true' : 'false'}"
                    data-assign-value="${escapeHtml(value)}" data-row-id="${row.id}">
                <span class="bk-rowmenu-item-icon">${icon}</span>
                <span class="bk-rowmenu-item-label">${escapeHtml(name)}</span>
                <span class="bk-rowmenu-item-tick">${isCurrent ? ICON_TICK : ''}</span>
            </button>`;
    }

    /** A person's photo at menu size, or their initials when there is none. */
    function personFace(key, name) {
        const url = window.CRMPeople ? window.CRMPeople.avatarFor(key, name) : null;

        return url
            ? `<span class="bk-menu-face has-photo"><img src="${escapeHtml(url)}" alt=""></span>`
            : `<span class="bk-menu-face">${escapeHtml(getInitials(name))}</span>`;
    }

    /**
     * Anchored to <body> in viewport coordinates, like the month breakdown:
     * inside the scrolling table its own cell would clip it.
     */
    function openRowMenu(button) {
        closeRowMenu();

        const rowId = parseInt(button.dataset.rowId, 10);
        const row = state.rows.find(r => r.id === rowId);
        if (!row) return;

        const panel = document.createElement('div');
        panel.className = 'bk-rowmenu';
        panel.id = 'bkRowMenu';
        panel.setAttribute('role', 'menu');
        panel.setAttribute('aria-label', 'Row actions');
        panel.dataset.rowId = String(rowId);
        panel.innerHTML = rowMenuContent(row);
        document.body.appendChild(panel);

        const r = button.getBoundingClientRect();
        const width = panel.offsetWidth;
        const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
        const below = r.bottom + 6;
        const fitsBelow = below + panel.offsetHeight < window.innerHeight - 8;
        panel.style.left = `${left}px`;
        panel.style.top = fitsBelow ? `${below}px` : `${Math.max(8, r.top - panel.offsetHeight - 6)}px`;

        button.setAttribute('aria-expanded', 'true');
        button.classList.add('is-open');

        panel.addEventListener('click', event => {
            const item = event.target.closest('.bk-rowmenu-item');
            if (!item) return;

            if (item.dataset.submenu) {
                if (item.classList.contains('is-open')) {
                    closeRowSubmenu();
                } else {
                    openAssignSubmenu(item, row);
                }
                return;
            }

            runRowMenuAction(item.dataset.action, parseInt(item.dataset.rowId, 10));
        });

        // Pointing at an entry is how a menu like this is read: the submenu
        // follows the pointer, and moving on to a plain entry puts it away -
        // but only after a beat, because the way over to the submenu passes
        // over the entries below the one that opened it.
        panel.addEventListener('mouseover', event => {
            const item = event.target.closest('.bk-rowmenu-item');
            if (!item) return;

            if (item.dataset.submenu) {
                cancelSubmenuClose();
                if (!item.classList.contains('is-open')) openAssignSubmenu(item, row);
            } else {
                scheduleSubmenuClose();
            }
        });

        const first = panel.querySelector('.bk-rowmenu-item');
        if (first) first.focus();
    }

    let submenuCloseTimer = null;

    function scheduleSubmenuClose() {
        clearTimeout(submenuCloseTimer);
        submenuCloseTimer = setTimeout(closeRowSubmenu, 180);
    }

    function cancelSubmenuClose() {
        clearTimeout(submenuCloseTimer);
    }

    /**
     * The people list, opened beside the menu rather than inside it.
     *
     * Placed to the right of the parent panel and flipped to its left when
     * there is no room, which is the one thing a submenu has to get right.
     */
    function openAssignSubmenu(item, row) {
        closeRowSubmenu();

        const panel = document.getElementById('bkRowMenu');
        if (!panel) return;

        const sub = document.createElement('div');
        sub.className = 'bk-rowmenu bk-rowmenu-sub';
        sub.id = 'bkRowSubmenu';
        sub.setAttribute('role', 'menu');
        sub.setAttribute('aria-label', 'Waiting on');
        sub.innerHTML = assignSubmenuContent(row);
        document.body.appendChild(sub);

        const menuRect = panel.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();

        let left = menuRect.right + 4;
        if (left + sub.offsetWidth > window.innerWidth - 8) {
            left = Math.max(8, menuRect.left - sub.offsetWidth - 4);
        }

        let top = itemRect.top - 6;
        if (top + sub.offsetHeight > window.innerHeight - 8) {
            top = Math.max(8, window.innerHeight - sub.offsetHeight - 8);
        }

        sub.style.left = `${left}px`;
        sub.style.top = `${top}px`;

        item.classList.add('is-open');
        item.setAttribute('aria-expanded', 'true');

        sub.addEventListener('click', event => {
            const option = event.target.closest('[data-assign-value]');
            if (!option) return;

            const id = parseInt(option.dataset.rowId, 10);
            const value = option.dataset.assignValue;
            closeRowMenu();
            assignRow(id, value);
        });

        // Once the pointer is in here, nothing in the parent menu closes it.
        sub.addEventListener('mouseover', cancelSubmenuClose);
    }

    function closeRowSubmenu() {
        cancelSubmenuClose();

        const sub = document.getElementById('bkRowSubmenu');
        if (!sub) return;

        const parent = document.querySelector('.bk-rowmenu-item.is-open');
        const returnFocus = sub.contains(document.activeElement);
        sub.remove();

        if (parent) {
            parent.classList.remove('is-open');
            parent.setAttribute('aria-expanded', 'false');
            if (returnFocus) parent.focus();
        }
    }

    function closeRowMenu() {
        closeRowSubmenu();

        const panel = document.getElementById('bkRowMenu');
        if (!panel) return;

        // Whoever arrived here with the keyboard gets put back on the dots
        // rather than dropped at the top of the document.
        const returnFocus = panel.contains(document.activeElement);
        panel.remove();

        els.tableWrap.querySelectorAll('.bk-row-menu-btn.is-open').forEach(btn => {
            btn.classList.remove('is-open');
            btn.setAttribute('aria-expanded', 'false');
            if (returnFocus && btn.isConnected) btn.focus();
        });
    }

    /**
     * Each of these either opens a dialog of its own or reloads the table, so
     * the menu is out of the way first either way.
     */
    function runRowMenuAction(action, rowId) {
        closeRowMenu();

        switch (action) {
            case 'upload':
                openPdfModal(rowId);
                break;
            case 'toggle-nopdf':
                toggleNoPdf(rowId);
                break;
            case 'toggle-excluded':
                confirmToggleExcluded(rowId);
                break;
            case 'remove-pdf':
                confirmRemovePdf(rowId);
                break;
            case 'delete-row':
                confirmDeleteRows([rowId]);
                break;
        }
    }

    /**
     * Hand a row to somebody, or take it back.
     *
     * The server re-checks that the target is a real, active account, and
     * refuses a row that already has its PDF - there would be nothing for the
     * assignee to do, and the row would never appear on their home page.
     */
    async function assignRow(rowId, value) {
        const row = state.rows.find(r => r.id === rowId);
        if (!row) return;

        try {
            const response = await fetch('api/assign.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({
                    type: 'bookkeeping',
                    id: rowId,
                    assigned_to: value === '' ? null : value
                })
            });

            const text = await response.text();
            let payload;
            try {
                payload = text ? JSON.parse(text) : {};
            } catch (e) {
                throw new Error('The server returned an unexpected response.');
            }

            if (!response.ok || payload.error) {
                throw new Error(payload.error || 'Could not change the assignment.');
            }

            row.assigned_to = payload.data ? payload.data.assigned_to : null;
            row.assigned_to_name = payload.data ? payload.data.assigned_to_name : null;
            render();

            showToast(row.assigned_to_name
                ? `Row is now waiting on ${row.assigned_to_name}`
                : 'Row is no longer assigned');

            // The home tab counts what is on people's plates.
            if (window.CRMWorkload) window.CRMWorkload.refreshBadge();
        } catch (error) {
            showToast(error.message, true);
        }
    }

    /**
     * Open the table on one particular row and light it up briefly.
     *
     * Used by the home page, where an assigned row is listed as work to do and
     * clicking it should land on the row itself rather than on the top of a
     * table with a thousand lines in it.
     */
    async function focusRow(rowId) {
        await loadIfIdle();

        const id = Number(rowId);
        if (!state.rows.some(r => r.id === id)) {
            showToast('That bookkeeping row no longer exists.', true);
            return;
        }

        // A filter left over from earlier can hide the very row we were asked
        // to show, so clear it rather than land on an empty table.
        if (!getDisplayRows().some(r => r.id === id)) {
            state.filterQuery = '';
            if (els.filterInput) els.filterInput.value = '';
            render();
        }

        const tr = els.tableInner.querySelector(`tr.bk-row[data-row-id="${id}"]`);
        if (!tr) return;

        tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
        tr.classList.add('bk-row-flash');
        setTimeout(() => tr.classList.remove('bk-row-flash'), 2200);
    }

    function updateToolbar() {
        const count = state.selection.size;
        els.selectionBar.style.display = count > 0 ? 'flex' : 'none';
        els.selectionCount.textContent = count === 1 ? '1 row selected' : `${count} rows selected`;
        els.rowCount.textContent = state.rows.length === 1 ? '1 entry' : `${state.rows.length} entries`;
    }

    // ------------------------------------------------------------------
    // CSV parsing
    // ------------------------------------------------------------------

    function detectDelimiter(line) {
        const candidates = [';', ',', '\t'];
        let best = ',';
        let bestCount = -1;
        candidates.forEach(delimiter => {
            let count = 0;
            let inQuotes = false;
            for (const ch of line) {
                if (ch === '"') inQuotes = !inQuotes;
                else if (ch === delimiter && !inQuotes) count++;
            }
            if (count > bestCount) {
                bestCount = count;
                best = delimiter;
            }
        });
        return best;
    }

    function parseCsv(text) {
        text = text.replace(/^﻿/, '');
        const firstLineEnd = text.search(/\r\n|\n|\r/);
        const delimiter = detectDelimiter(firstLineEnd === -1 ? text : text.slice(0, firstLineEnd));

        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (text[i + 1] === '"') {
                        field += '"';
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === delimiter) {
                row.push(field);
                field = '';
            } else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && text[i + 1] === '\n') i++;
                row.push(field);
                field = '';
                if (row.some(v => v.trim() !== '')) rows.push(row);
                row = [];
            } else {
                field += ch;
            }
        }
        if (field !== '' || row.length > 0) {
            row.push(field);
            if (row.some(v => v.trim() !== '')) rows.push(row);
        }

        if (rows.length < 2) {
            throw new Error('The CSV file needs a header row and at least one data row');
        }

        const headers = rows[0].map((h, index) => {
            const name = h.trim();
            return name !== '' ? name : `Column ${index + 1}`;
        });
        return { headers, rows: rows.slice(1) };
    }

    async function readFileText(file) {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Some banks export CSV as UTF-16 (common for Windows/Excel compatibility).
        if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
            return new TextDecoder('utf-16le').decode(buffer);
        }
        if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
            return new TextDecoder('utf-16be').decode(buffer);
        }

        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        } catch (e) {
            // Bank exports are often Latin-1 / Windows-1252 encoded
            return new TextDecoder('windows-1252').decode(buffer);
        }
    }

    /**
     * Some bank exports wrap each ENTIRE row in an extra layer of CSV
     * quoting, as if the whole line were itself one quoted field, e.g.
     * `"Name,""IBAN"",""Date"""`. Standard CSV parsing collapses that into
     * a single column. Peel the outer layer off line by line so normal
     * parsing can find the real columns underneath.
     */
    function unwrapDoubleQuotedRows(text) {
        return text.replace(/^﻿/, '').split(/\r\n|\r|\n/).map(line => {
            const trimmed = line.replace(/\s+$/, '');
            if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
                const inner = trimmed.slice(1, -1);
                if (inner.includes('""')) {
                    return inner.replace(/""/g, '"');
                }
            }
            return line;
        }).join('\n');
    }

    function looksLikeBrokenParse(parsed) {
        return parsed.headers.length === 1 && /""|","/.test(parsed.headers[0]);
    }

    // ------------------------------------------------------------------
    // Import modal
    // ------------------------------------------------------------------

    async function handleCsvFile(file) {
        try {
            // Make sure state.settings reflects the server's remembered column
            // selection before we build the modal off of it - otherwise a fast
            // click right after switching tabs could race the initial fetch
            // and silently show an empty (unrestored) selection.
            if (loadPromise) {
                await loadPromise;
            }

            const text = await readFileText(file);
            let parsed = parseCsv(text);

            if (looksLikeBrokenParse(parsed)) {
                try {
                    const retry = parseCsv(unwrapDoubleQuotedRows(text));
                    if (retry.headers.length > parsed.headers.length) {
                        parsed = retry;
                    }
                } catch (e) {
                    // Keep the original parse if the unwrap attempt fails.
                }
            }

            state.csv = { ...parsed, fileName: file.name };
            openImportModal();
        } catch (error) {
            showToast('Could not read CSV: ' + error.message, true);
        }
    }

    function looksLikeDateColumn(name) {
        return /date|datum|valuta|buchung/i.test(name);
    }

    function openImportModal() {
        const { headers, rows, fileName } = state.csv;
        const remembered = state.settings.selected_columns || [];
        // Memory only counts as "relevant" if it actually overlaps with this
        // file's columns - otherwise remembered settings from a completely
        // different CSV format would leave every checkbox unchecked (looking
        // like restoration is broken) while still claiming to have restored
        // something.
        const hasMemory = remembered.some(name => headers.includes(name));

        els.importFileName.textContent = fileName;
        els.importRowCount.textContent = rows.length === 1 ? '1 data row' : `${rows.length} data rows`;

        // Work out the date column first: it is required for the import, so it
        // must always end up checked below. Otherwise a partially-matching
        // remembered selection could leave the guessed date column unchecked,
        // and the import would fail validation the moment the user continues.
        let dateGuessIndex = hasMemory ? headers.findIndex(h => h === state.settings.date_column) : -1;
        if (dateGuessIndex === -1) dateGuessIndex = headers.findIndex(looksLikeDateColumn);
        if (dateGuessIndex === -1) dateGuessIndex = 0;

        els.importColumns.innerHTML = headers.map((header, index) => {
            const checked = index === dateGuessIndex || (hasMemory ? remembered.includes(header) : true);
            return `
                <label class="bk-import-col">
                    <input type="checkbox" data-col-index="${index}" ${checked ? 'checked' : ''}>
                    <span class="bk-import-col-name">${escapeHtml(header)}</span>
                    <span class="bk-import-col-sample">${escapeHtml((rows[0] && rows[0][index]) || '')}</span>
                </label>`;
        }).join('');

        // The option value is the column INDEX rather than the header text, so
        // matching it back to a checkbox can never fail due to duplicate header
        // names or characters that don't round-trip cleanly through an HTML
        // attribute (e.g. a literal quote from escaped CSV text).
        els.importDateColumn.innerHTML = headers.map((header, index) =>
            `<option value="${index}" ${index === dateGuessIndex ? 'selected' : ''}>${escapeHtml(header)}</option>`
        ).join('');

        els.importHint.style.display = hasMemory ? '' : 'none';
        goToColumnsStep();
        els.importModal.classList.add('active');
    }

    function closeImportModal() {
        els.importModal.classList.remove('active');
        els.csvInput.value = '';
        state.csv = null;
        state.previewRows = [];
    }

    function goToColumnsStep() {
        state.importStep = 'columns';
        els.importStepColumns.style.display = '';
        els.importStepPreview.style.display = 'none';
        els.importBackBtn.style.display = 'none';
        els.importConfirmBtn.textContent = 'Preview';
        els.importConfirmBtn.disabled = false;
    }

    /**
     * Finds, among the given columns, the first one whose name matches one
     * of the candidate labels (case-insensitive). Used to locate the
     * amount/counterparty columns for duplicate detection regardless of
     * exact capitalization.
     */
    function findColumnByNames(columns, candidates) {
        const lowerCandidates = candidates.map(c => c.toLowerCase());
        return columns.find(col => lowerCandidates.includes(col.trim().toLowerCase())) || null;
    }

    function normalizeForCompare(value) {
        return String(value ?? '').trim().toLowerCase();
    }

    /**
     * A CSV date as "YYYY-MM-DD", or '' when it cannot be read. The same
     * rules as bkParseDate() in api/bookkeeping.php, which fills row_date on
     * import, so an imported "07.03.2026" compares equal to a stored row.
     */
    function parseBookingDate(raw) {
        const value = String(raw ?? '').trim();
        let y, m, d, match;
        if ((match = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(value))) {
            [, y, m, d] = match;
        } else if ((match = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/.exec(value))) {
            [, d, m, y] = match;
            // If day-first is impossible but month-first is valid, swap.
            if (Number(m) > 12 && Number(d) <= 12) [d, m] = [m, d];
            if (y.length === 2) y = (Number(y) < 70 ? '20' : '19') + y;
        } else {
            return '';
        }
        y = Number(y); m = Number(m); d = Number(d);
        const date = new Date(Date.UTC(y, m - 1, d));
        if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
        return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    /**
     * Flags rows that look like they might already exist, checked against
     * both the table's current rows and other rows in this same import
     * batch. Prefers matching on "Betrag"/amount + "Partnername"/payee
     * columns plus the booking date (the fields that most reliably identify
     * a duplicate bank transaction - without the date, every monthly payment
     * of the same amount to the same payee would look like a duplicate);
     * falls back to comparing every imported column's value, the date
     * column included, when those aren't present.
     */
    function computeDuplicateFlags(candidateRows, selectedColumns, dateColumn) {
        const amountCol = findColumnByNames(selectedColumns, ['betrag', 'amount', 'sum', 'value']);
        const partyCol = findColumnByNames(selectedColumns, ['partnername', 'partner', 'payee', 'empfänger', 'empfaenger', 'beschreibung', 'description']);
        const useSpecificKey = amountCol && partyCol;

        // Dates are compared normalized: stored rows by their row_date, new
        // ones parsed from the chosen date column.
        const keyOf = (getValue, date) => useSpecificKey
            ? `${normalizeForCompare(getValue(amountCol))}|${normalizeForCompare(getValue(partyCol))}|${date}`
            : selectedColumns.map(c => normalizeForCompare(getValue(c))).join('|');

        const existingKeys = new Set();
        state.rows.forEach(row => {
            const key = keyOf(col => row.data[col], row.row_date || '');
            if (key.replace(/\|/g, '') !== '') existingKeys.add(key);
        });

        const seenInBatch = new Set();
        return candidateRows.map(row => {
            const key = keyOf(col => row[col], dateColumn ? parseBookingDate(row[dateColumn]) : '');
            const isDup = key.replace(/\|/g, '') !== '' && (existingKeys.has(key) || seenInBatch.has(key));
            seenInBatch.add(key);
            return isDup;
        });
    }

    function goToPreviewStep() {
        const { headers, rows } = state.csv;
        const selectedIndexes = [];
        els.importColumns.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            if (checkbox.checked) selectedIndexes.push(parseInt(checkbox.dataset.colIndex, 10));
        });

        if (selectedIndexes.length === 0) {
            showToast('Select at least one column to import', true);
            return;
        }

        const dateIndex = parseInt(els.importDateColumn.value, 10);
        if (!selectedIndexes.includes(dateIndex)) {
            showToast('The date column must be one of the imported columns', true);
            return;
        }
        const dateColumn = headers[dateIndex];
        const selectedColumns = selectedIndexes.map(i => headers[i]);

        const candidateData = rows
            .map(row => {
                const obj = {};
                selectedIndexes.forEach(i => {
                    obj[headers[i]] = row[i] != null ? row[i] : '';
                });
                return obj;
            })
            .filter(obj => Object.values(obj).some(v => String(v).trim() !== ''));

        if (candidateData.length === 0) {
            showToast('No non-empty rows found to import', true);
            return;
        }

        const dupFlags = computeDuplicateFlags(candidateData, selectedColumns, dateColumn);

        state.previewColumns = selectedColumns;
        state.previewExcludedColumns = new Set();
        state.previewDateColumn = dateColumn;
        state.previewRows = candidateData.map((data, i) => ({
            data,
            isDuplicate: dupFlags[i],
            selected: true
        }));

        state.importStep = 'preview';
        els.importStepColumns.style.display = 'none';
        els.importStepPreview.style.display = '';
        els.importBackBtn.style.display = '';
        renderImportPreview();
    }

    /** Columns from step 1 that are still included after step-2 toggles. */
    function activePreviewColumns() {
        return state.previewColumns.filter(c => !state.previewExcludedColumns.has(c));
    }

    function renderPreviewColumnChips() {
        els.importPreviewColumns.innerHTML = state.previewColumns.map(col => {
            const isDateCol = col === state.previewDateColumn;
            const off = state.previewExcludedColumns.has(col);
            return `
                <label class="bk-preview-col-chip ${off ? 'bk-col-off' : ''} ${isDateCol ? 'bk-col-locked' : ''}"
                       title="${isDateCol ? 'The date column is required and cannot be excluded' : ''}">
                    <input type="checkbox" data-col="${escapeHtml(col)}" ${off ? '' : 'checked'} ${isDateCol ? 'disabled' : ''}>
                    <span>${escapeHtml(col)}</span>
                </label>`;
        }).join('');
    }

    function renderImportPreview() {
        renderPreviewColumnChips();

        // Duplicate detection depends on which columns are included, so it is
        // recalculated whenever the column selection changes.
        const cols = activePreviewColumns();
        const dupFlags = computeDuplicateFlags(state.previewRows.map(r => r.data), cols, state.previewDateColumn);
        state.previewRows.forEach((row, i) => { row.isDuplicate = dupFlags[i]; });

        const dupCount = state.previewRows.filter(r => r.isDuplicate).length;
        els.importDupWarning.style.display = dupCount > 0 ? '' : 'none';
        if (dupCount > 0) {
            els.importDupWarningText.textContent =
                `Possible duplicates found: ${dupCount} row${dupCount === 1 ? '' : 's'} look like they might already be in the table. Review the highlighted rows below.`;
        }

        let html = '<table class="bk-preview-table"><thead><tr><th class="bk-col-check"></th>';
        cols.forEach(c => html += `<th>${escapeHtml(c)}</th>`);
        html += '<th></th></tr></thead><tbody>';

        state.previewRows.forEach((row, index) => {
            html += `<tr class="${row.isDuplicate ? 'bk-preview-row-dup' : ''}">`;
            html += `<td class="bk-col-check"><input type="checkbox" class="bk-preview-check" data-index="${index}" ${row.selected ? 'checked' : ''}></td>`;
            cols.forEach(c => html += `<td class="${amountClass(row.data[c], c)}">${escapeHtml(row.data[c] || '')}</td>`);
            html += `<td>${row.isDuplicate ? '<span class="bk-preview-dup-badge">Possible duplicate</span>' : ''}</td>`;
            html += '</tr>';
        });

        html += '</tbody></table>';
        els.importPreviewWrap.innerHTML = html;

        updatePreviewSummary();
    }

    function updatePreviewSummary() {
        const total = state.previewRows.length;
        const selectedCount = state.previewRows.filter(r => r.selected).length;
        els.importPreviewCount.textContent = `${selectedCount} of ${total} row${total === 1 ? '' : 's'} selected`;
        els.importPreviewSelectAll.checked = selectedCount === total;
        els.importConfirmBtn.textContent = `Confirm Import (${selectedCount})`;
        els.importConfirmBtn.disabled = selectedCount === 0;
    }

    async function doImport() {
        const cols = activePreviewColumns();
        if (cols.length === 0) {
            showToast('Select at least one column to import', true);
            return;
        }

        const selectedRows = state.previewRows
            .filter(r => r.selected)
            .map(r => {
                const obj = {};
                cols.forEach(c => { obj[c] = r.data[c] ?? ''; });
                return obj;
            });
        if (selectedRows.length === 0) {
            showToast('Select at least one row to import', true);
            return;
        }

        els.importConfirmBtn.disabled = true;
        try {
            const result = await postJson('import', {
                columns: cols,
                date_column: state.previewDateColumn,
                rows: selectedRows
            });
            closeImportModal();
            showToast(`Imported ${result.imported} rows` + (result.new_columns > 0 ? ` (${result.new_columns} new columns added)` : ''));
            await load();
        } catch (error) {
            showToast('Import failed: ' + error.message, true);
        } finally {
            els.importConfirmBtn.disabled = false;
        }
    }

    // ------------------------------------------------------------------
    // PDF preview
    // ------------------------------------------------------------------

    // The preview draws the PDF itself with PDF.js (assets/pdfjs) instead of
    // handing it to the browser's viewer in an iframe. Safari treats a framed
    // PDF as plug-in content and refuses it, while canvases render the same
    // everywhere. Self-hosted, because the CSP only trusts 'self' for workers.
    // Loaded on the first preview, not with the page: it is ~1.8 MB.
    const PDFJS_BASE = new URL('assets/pdfjs/', document.baseURI).href;
    const PDF_PREVIEW_MAX_PAGES = 30;
    let pdfjsPromise = null;
    let previewToken = 0;
    let previewDoc = null;

    function loadPdfJs() {
        if (!pdfjsPromise) {
            pdfjsPromise = import(PDFJS_BASE + 'pdf.min.js')
                .then(lib => {
                    lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
                    return lib;
                })
                .catch(error => {
                    pdfjsPromise = null; // let the next preview try again
                    throw error;
                });
        }
        return pdfjsPromise;
    }

    function openPdfPreview(pdfId, pdfName) {
        if (!pdfId) return;
        return openPreview(`${API}?action=download-pdf&id=${pdfId}`, pdfName);
    }

    /**
     * Show a PDF or an image this site serves in the preview dialog: the
     * invoices here, and a project's documents (documents.js), which reach it
     * through window.Bookkeeping.preview().
     */
    async function openPreview(url, name, kind = 'pdf') {
        // Any preview still rendering stops at its next page.
        const token = ++previewToken;

        els.pdfPreviewTitle.textContent = name || 'PDF';
        els.pdfPreviewOpenBtn.href = url;
        els.pdfPreviewFrame.hidden = true;
        els.pdfPreviewPages.hidden = false;
        els.pdfPreviewPages.innerHTML = '<p class="bk-pdf-preview-status">Loading preview…</p>';
        els.pdfPreviewModal.classList.add('active');

        if (kind === 'image') {
            const image = document.createElement('img');
            image.className = 'bk-pdf-page bk-preview-image';
            image.alt = name || '';
            image.src = url;
            els.pdfPreviewPages.innerHTML = '';
            els.pdfPreviewPages.appendChild(image);
            return;
        }

        try {
            const [lib, data] = await Promise.all([
                loadPdfJs(),
                fetch(url, { credentials: 'same-origin' }).then(response => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.arrayBuffer();
                })
            ]);
            if (token !== previewToken) return;

            const doc = await lib.getDocument({
                data,
                // The CSP forbids eval; without this PDF.js tries it first and logs the refusal.
                isEvalSupported: false,
                // Invoices often use Helvetica/Arial without embedding them.
                standardFontDataUrl: PDFJS_BASE + 'standard_fonts/'
            }).promise;
            if (token !== previewToken) {
                doc.destroy();
                return;
            }
            previewDoc = doc;
            els.pdfPreviewPages.innerHTML = '';

            const ratio = window.devicePixelRatio || 1;
            const available = els.pdfPreviewPages.clientWidth - 32;
            const pageCount = Math.min(doc.numPages, PDF_PREVIEW_MAX_PAGES);

            for (let number = 1; number <= pageCount; number++) {
                const page = await doc.getPage(number);
                if (token !== previewToken) return;

                // Fit the page to the modal's width, rendered at the screen's
                // pixel density so text stays sharp on Retina displays.
                const scale = Math.min(available / page.getViewport({ scale: 1 }).width, 2);
                const viewport = page.getViewport({ scale: scale * ratio });
                const canvas = document.createElement('canvas');
                canvas.className = 'bk-pdf-page';
                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);
                canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
                canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
                els.pdfPreviewPages.appendChild(canvas);

                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            }

            if (doc.numPages > pageCount) {
                const note = document.createElement('p');
                note.className = 'bk-pdf-preview-status';
                note.textContent = `Showing the first ${pageCount} of ${doc.numPages} pages. Open in a new tab to see the rest.`;
                els.pdfPreviewPages.appendChild(note);
            }
        } catch (error) {
            if (token !== previewToken) return;
            console.error('PDF preview failed, falling back to the browser viewer:', error);
            // Fall back to the browser's own viewer - fine everywhere but Safari.
            els.pdfPreviewPages.hidden = true;
            els.pdfPreviewPages.innerHTML = '';
            els.pdfPreviewFrame.hidden = false;
            els.pdfPreviewFrame.src = url;
        }
    }

    function closePdfPreview() {
        els.pdfPreviewModal.classList.remove('active');
        previewToken++;
        if (previewDoc) {
            previewDoc.destroy();
            previewDoc = null;
        }
        // Release the rendered pages / embedded document.
        els.pdfPreviewPages.innerHTML = '';
        els.pdfPreviewFrame.src = 'about:blank';
    }

    // ------------------------------------------------------------------
    // PDF upload to a specific row
    // ------------------------------------------------------------------

    function openPdfModal(rowId) {
        const row = state.rows.find(r => r.id === rowId);
        if (!row) return;

        state.pdfModalRowId = rowId;
        els.pdfRowSummary.innerHTML = buildRowSummaryCard(row);

        const hasPdf = !!row.pdf;
        els.pdfWarning.style.display = hasPdf ? '' : 'none';
        if (hasPdf) {
            els.pdfWarningText.textContent =
                `This row already has "${row.pdf.name}" assigned. It will NOT be overwritten - remove the existing PDF first if you want to replace it.`;
        }
        els.pdfUploadControls.style.display = hasPdf ? 'none' : '';
        els.pdfFileInput.value = '';
        els.pdfUploadBtn.disabled = true;
        els.pdfFileName.textContent = '';
        els.pdfModal.classList.add('active');
    }

    function buildRowSummaryCard(row) {
        let html = '<div class="bk-row-card">';
        state.columns.forEach(col => {
            const value = (row.data[col.name] || '').trim();
            if (value !== '') {
                html += `
                    <div class="bk-row-card-item">
                        <span class="bk-row-card-label">${escapeHtml(col.name)}</span>
                        <span class="bk-row-card-value">${escapeHtml(value)}</span>
                    </div>`;
            }
        });
        html += '</div>';
        return html;
    }

    function closePdfModal() {
        els.pdfModal.classList.remove('active');
        state.pdfModalRowId = null;
    }

    async function doUploadPdf() {
        const file = els.pdfFileInput.files[0];
        if (!file || state.pdfModalRowId == null) return;

        const tooBig = checkUploadSize(file);
        if (tooBig) {
            showToast(tooBig, true);
            return;
        }

        const formData = new FormData();
        formData.append('row_id', String(state.pdfModalRowId));
        formData.append('pdf', file);

        els.pdfUploadBtn.disabled = true;
        try {
            const result = await postForm('upload-pdf', formData);
            closePdfModal();
            showToast(pdfAssignedMessage(file.name, result));
            await load();
        } catch (error) {
            els.pdfUploadBtn.disabled = false;
            showToast('Upload failed: ' + error.message, true);
        }
    }

    // ------------------------------------------------------------------
    // Row / PDF actions
    // ------------------------------------------------------------------

    async function runDeleteRows(ids, deletePdfsToo) {
        const result = await postJson('delete-rows', { ids, delete_pdfs: deletePdfsToo });
        ids.forEach(id => state.selection.delete(id));

        const removedColumns = result.removed_columns || 0;
        const deletedPdfs = result.deleted_pdfs || 0;
        let message = `Deleted ${ids.length} row${ids.length === 1 ? '' : 's'}`;
        if (deletedPdfs > 0) {
            message += ` and ${deletedPdfs} PDF${deletedPdfs === 1 ? '' : 's'}`;
        }
        if (removedColumns > 0) {
            message += ` (${removedColumns} empty column${removedColumns === 1 ? '' : 's'} removed)`;
        }
        showToast(message);
        await load();
    }

    function confirmDeleteRows(ids) {
        const withPdfs = state.rows.filter(r => ids.includes(r.id) && r.pdf).length;
        const label = ids.length === 1 ? 'this row' : `${ids.length} rows`;
        const rowWord = ids.length === 1 ? 'row' : 'rows';
        const pdfWord = withPdfs === 1 ? 'PDF' : 'PDFs';

        const actions = withPdfs > 0
            ? [
                {
                    label: `Delete ${rowWord}, keep ${pdfWord}`,
                    className: 'btn-success',
                    handler: () => runDeleteRows(ids, false)
                },
                {
                    label: `Delete ${rowWord} + ${pdfWord}`,
                    className: 'btn-danger',
                    handler: () => runDeleteRows(ids, true)
                }
            ]
            : [{
                label: 'Delete',
                className: 'btn-danger',
                handler: () => runDeleteRows(ids, false)
            }];

        showConfirm({
            title: ids.length === 1 ? 'Delete Row' : 'Delete Rows',
            message: `Are you sure you want to delete <strong>${label}</strong>?<br>` +
                (withPdfs > 0
                    ? `<span class="text-muted">${withPdfs} attached ${pdfWord.toLowerCase()} found. Choose what should happen to ${withPdfs === 1 ? 'it' : 'them'} below.</span>`
                    : '<span class="text-muted">This action cannot be undone.</span>'),
            actions
        });
    }

    function confirmRemovePdf(rowId) {
        const row = state.rows.find(r => r.id === rowId);
        if (!row || !row.pdf) return;
        const pdf = row.pdf;

        showConfirm({
            title: 'Remove PDF',
            message: `What do you want to do with <strong>${escapeHtml(pdf.name)}</strong>?`,
            actions: [
                {
                    label: 'Move to drop zone',
                    className: 'btn-success',
                    handler: async () => {
                        await postJson('unassign-pdf', { pdf_id: pdf.id });
                        showToast(`"${pdf.name}" moved to drop zone`);
                        await load();
                    }
                },
                {
                    label: 'Delete permanently',
                    className: 'btn-danger',
                    handler: async () => {
                        await postJson('delete-pdfs', { ids: [pdf.id] });
                        showToast(`"${pdf.name}" deleted`);
                        await load();
                    }
                }
            ]
        });
    }

    function confirmDeletePoolPdf(pdfId) {
        const pdf = state.pool.find(p => p.id === pdfId);
        if (!pdf) return;
        showConfirm({
            title: 'Delete PDF',
            message: `Are you sure you want to permanently delete <strong>${escapeHtml(pdf.name)}</strong>?<br><span class="text-muted">This action cannot be undone.</span>`,
            actions: [{
                label: 'Delete',
                className: 'btn-danger',
                handler: async () => {
                    await postJson('delete-pdfs', { ids: [pdfId] });
                    showToast(`"${pdf.name}" deleted`);
                    await load();
                }
            }]
        });
    }

    /**
     * Take a row out of the month's arithmetic, or put it back.
     *
     * Excluding asks first: the row keeps sitting in the list looking normal
     * apart from its styling, so a total silently changing under someone who
     * mis-clicked would be hard to account for later. Putting a row back is
     * not destructive and needs no confirmation.
     */
    function confirmToggleExcluded(rowId) {
        const row = state.rows.find(r => r.id === rowId);
        if (!row) return;

        if (row.excluded) {
            setExcluded(rowId, false);
            return;
        }

        showConfirm({
            title: 'Exclude from totals?',
            message: `<p>This entry stays in the list and keeps any PDF, but stops counting
                      towards its month's income, expenses and result.</p>
                      <div class="bk-row-card">
                          <div class="bk-row-card-item">
                              <span class="bk-row-card-label">Entry</span>
                              <span class="bk-row-card-value">${escapeHtml(rowSummary(row))}</span>
                          </div>
                      </div>`,
            actions: [{
                label: 'Exclude',
                className: 'btn-primary',
                handler: () => setExcluded(rowId, true)
            }]
        });
    }

    async function setExcluded(rowId, value) {
        await postJson('set-excluded', { ids: [rowId], value });
        closeMonthBreakdown();
        await load();
        showToast(value ? 'Entry excluded from the totals' : 'Entry counted again');
    }

    async function toggleNoPdf(rowId) {
        const row = state.rows.find(r => r.id === rowId);
        if (!row) return;
        try {
            await postJson('set-no-pdf', { ids: [rowId], value: !row.no_pdf_needed });
            await load();
        } catch (error) {
            showToast(error.message, true);
        }
    }

    function exportSelected() {
        const ids = Array.from(state.selection);
        const withPdf = state.rows.filter(r => ids.includes(r.id) && r.pdf);
        if (withPdf.length === 0) {
            showToast('None of the selected rows has a PDF attached', true);
            return;
        }
        showToast(`Downloading ${withPdf.length} PDF${withPdf.length === 1 ? '' : 's'} as ZIP...`);
        window.location.href = `${API}?action=export-pdfs&ids=${ids.join(',')}`;
    }

    // ------------------------------------------------------------------
    // Drag & drop
    // ------------------------------------------------------------------

    /**
     * During dragover the browser exposes MIME types but not file names, so
     * this is a best-effort guess used only to pick the right hover
     * affordance. The actual drop decision is made from the file name.
     */
    /**
     * What is being dragged, as far as the browser will say before the drop:
     *   'pool'    - a PDF from the drop zone list, onto a row
     *   'csv'     - a bank statement, which is an import wherever it lands
     *   'pdf'     - one or more PDFs
     *   'unknown' - files whose type is not exposed yet (Safari reports none
     *               until the drop), so either of the above
     *   null      - not files at all (text, links)
     */
    function dragKind(dataTransfer) {
        const types = Array.from(dataTransfer.types || []);
        if (types.includes('application/x-bk-pdf-id')) return 'pool';
        if (!types.includes('Files')) return null;

        const items = Array.from(dataTransfer.items || []).filter(item => item.kind === 'file');
        if (items.some(item => /csv|excel|spreadsheet/i.test(item.type || ''))) return 'csv';
        if (items.length > 0 && items.every(item => item.type === 'application/pdf')) return 'pdf';
        return 'unknown';
    }

    /**
     * Show exactly one drop overlay - the one for where the file will go - and
     * clear the others. Every drag event funnels through here, so two overlays
     * can never be on screen together.
     *
     *   'page'     the whole view: a CSV import (or an unidentified file over
     *              empty space)
     *   'dropzone' the drop zone: PDFs going into the pool
     *   'row'      one table row: a PDF being attached to it
     */
    let dropOverlayClearTimer = null;

    function setDropOverlay(mode, rowEl = null, label = '') {
        clearTimeout(dropOverlayClearTimer);

        const view = document.getElementById('bookkeepingView');
        if (view) {
            view.classList.toggle('bk-csv-drop-active', mode === 'page');
            if (mode === 'page') view.dataset.dropLabel = label;
        }
        els.dropzone.classList.toggle('bk-dropzone-hover', mode === 'dropzone');

        els.tableWrap.querySelectorAll('tr.bk-drop-target').forEach(tr => {
            if (mode !== 'row' || tr !== rowEl) tr.classList.remove('bk-drop-target');
        });
        if (mode === 'row' && rowEl) {
            rowEl.classList.add('bk-drop-target');
            positionDropPill(rowEl);
        } else {
            hideDropPill();
        }
    }

    function bindFileDrops() {
        const view = document.getElementById('bookkeepingView');
        if (!view) return;

        view.addEventListener('dragover', event => {
            const kind = dragKind(event.dataTransfer);
            if (kind === null) return;

            const rowEl = event.target.closest('tr.bk-row');
            const overDropzone = !!event.target.closest('#bkDropzone');
            let mode = null;
            let label = '';

            if (kind === 'pool') {
                mode = rowEl ? 'row' : null;
            } else if (kind === 'csv') {
                mode = 'page';
                label = 'Drop CSV file to import';
            } else if (rowEl) {
                mode = 'row';
            } else if (overDropzone || kind === 'pdf') {
                // A PDF let go over empty space lands in the pool too, so the
                // drop zone is what lights up for it.
                mode = 'dropzone';
            } else {
                mode = 'page';
                label = 'Drop a CSV to import, or PDFs for the drop zone';
            }

            if (mode !== null) {
                event.preventDefault();
                event.dataTransfer.dropEffect = kind === 'pool' ? 'move' : 'copy';
            }
            setDropOverlay(mode, rowEl, label);
        });

        // dragleave fires on every child boundary, and Safari often reports no
        // relatedTarget, so a leave alone cannot tell "left the view" from
        // "moved onto a child". Clear a moment later instead; the dragover
        // that follows any move inside the view cancels it.
        view.addEventListener('dragleave', () => {
            clearTimeout(dropOverlayClearTimer);
            dropOverlayClearTimer = setTimeout(() => setDropOverlay(null), 80);
        });
        // A drag cancelled with Escape, or dropped outside the window.
        document.addEventListener('dragend', () => setDropOverlay(null));

        view.addEventListener('drop', event => {
            setDropOverlay(null);

            const rowEl = event.target.closest('tr.bk-row');
            const pdfId = event.dataTransfer.getData('application/x-bk-pdf-id');
            if (pdfId) {
                event.preventDefault();
                if (rowEl) assignPdfToRow(parseInt(pdfId, 10), parseInt(rowEl.dataset.rowId, 10));
                return;
            }

            const files = event.dataTransfer.files;
            if (!files || files.length === 0) return;
            event.preventDefault();

            // A CSV is always an import, wherever it lands.
            const csv = findCsvFile(files);
            if (csv) {
                handleCsvFile(csv);
                return;
            }
            if (rowEl) {
                uploadDroppedFileToRow(files[0], parseInt(rowEl.dataset.rowId, 10));
                return;
            }
            if (event.target.closest('#bkDropzone') || Array.from(files).some(f => /\.pdf$/i.test(f.name))) {
                uploadPoolFiles(files);
                return;
            }
            showToast('Drop a .csv file to import, or a .pdf to store it in the drop zone', true);
        });
    }

    function findCsvFile(files) {
        return Array.from(files || []).find(f => /\.csv$/i.test(f.name)) || null;
    }

    /**
     * Positions the floating "Drop PDF here" pill just above the given row.
     * Uses pixel coordinates relative to the (position: relative) table wrap
     * rather than a per-row overlay element, so it always tracks the row's
     * real rendered position regardless of table layout quirks.
     */
    function positionDropPill(rowEl) {
        if (!els.dropPill) return;
        const wrapRect = els.tableWrap.getBoundingClientRect();
        const rowRect = rowEl.getBoundingClientRect();
        // Centred on the row itself (not above it), so the label sits directly
        // over the row that will receive the PDF.
        const top = rowRect.top - wrapRect.top + els.tableWrap.scrollTop + rowRect.height / 2;
        const left = rowRect.left - wrapRect.left + els.tableWrap.scrollLeft + rowRect.width / 2;
        els.dropPill.style.top = `${top}px`;
        els.dropPill.style.left = `${left}px`;
        els.dropPill.classList.add('visible');
    }

    function hideDropPill() {
        if (els.dropPill) els.dropPill.classList.remove('visible');
    }

    function assignPdfToRow(pdfId, rowId) {
        const pdf = state.pool.find(p => p.id === pdfId);
        const row = state.rows.find(r => r.id === rowId);
        if (!pdf || !row) return;

        if (row.pdf) {
            showConfirm({
                title: 'Row already has a PDF',
                message: `This row already has <strong>${escapeHtml(row.pdf.name)}</strong> assigned.<br>` +
                    '<span class="text-muted">It will not be overwritten. Remove the existing PDF first if you want to replace it.</span>',
                actions: []
            });
            return;
        }

        showConfirm({
            title: 'Assign PDF',
            message: `Assign <strong>${escapeHtml(pdf.name)}</strong> to this row?` + buildRowSummaryCard(row),
            actions: [{
                label: 'Assign',
                className: 'btn-primary',
                handler: async () => {
                    const result = await postJson('assign-pdf', { pdf_id: pdf.id, row_id: row.id });
                    showToast(pdfAssignedMessage(pdf.name, result));
                    await load();
                }
            }]
        });
    }

    function uploadDroppedFileToRow(file, rowId) {
        const row = state.rows.find(r => r.id === rowId);
        if (!row) return;

        if (!/\.pdf$/i.test(file.name)) {
            showToast('Only PDF files can be dropped onto a row', true);
            return;
        }

        const tooBig = checkUploadSize(file);
        if (tooBig) {
            showToast(tooBig, true);
            return;
        }

        if (row.pdf) {
            showConfirm({
                title: 'Row already has a PDF',
                message: `This row already has <strong>${escapeHtml(row.pdf.name)}</strong> assigned.<br>` +
                    '<span class="text-muted">It will not be overwritten. Remove the existing PDF first if you want to replace it.</span>',
                actions: []
            });
            return;
        }

        showConfirm({
            title: 'Assign PDF',
            message: `Assign <strong>${escapeHtml(file.name)}</strong> to this row?` + buildRowSummaryCard(row),
            actions: [{
                label: 'Assign',
                className: 'btn-primary',
                handler: async () => {
                    const formData = new FormData();
                    formData.append('row_id', String(rowId));
                    formData.append('pdf', file);
                    const result = await postForm('upload-pdf', formData);
                    showToast(pdfAssignedMessage(file.name, result));
                    await load();
                }
            }]
        });
    }

    /**
     * The message for a PDF that has just landed on a row.
     *
     * An invoice is the thing the assignment was waiting for, so the server
     * clears it as the file arrives - which is worth a word, or the face
     * quietly vanishing from the row looks like a bug.
     */
    function pdfAssignedMessage(name, result) {
        const base = `"${name}" assigned`;
        return result && result.unassigned
            ? `${base} - no longer waiting on ${result.unassigned}`
            : base;
    }

    /** Returns an error string if the file exceeds the server's upload limit. */
    function checkUploadSize(file) {
        const max = state.limits.maxUploadBytes;
        if (max && file.size > max) {
            return `"${file.name}" is ${formatSize(file.size)}, larger than the server limit of ${state.limits.maxUploadLabel}.`;
        }
        return null;
    }

    async function uploadPoolFiles(files) {
        const all = Array.from(files);
        const pdfs = all.filter(f => /\.pdf$/i.test(f.name));
        if (pdfs.length === 0) {
            showToast('Only PDF files can be added to the drop zone', true);
            return;
        }

        const errors = [];
        const uploadable = [];
        pdfs.forEach(file => {
            const tooBig = checkUploadSize(file);
            if (tooBig) errors.push(tooBig);
            else uploadable.push(file);
        });

        // One request per file. Uploading them in a single POST would hit
        // post_max_size (and max_file_uploads) once a few large PDFs are
        // selected, which PHP reports by discarding the whole request.
        let uploaded = 0;
        for (let i = 0; i < uploadable.length; i++) {
            const file = uploadable[i];
            if (uploadable.length > 1) {
                showToast(`Uploading ${i + 1} of ${uploadable.length}: ${file.name}`);
            }
            const formData = new FormData();
            formData.append('pdfs[]', file);
            try {
                const result = await postForm('upload-pool', formData);
                uploaded += (result.uploaded || []).length;
                if (result.errors && result.errors.length > 0) {
                    errors.push(...result.errors);
                }
            } catch (error) {
                errors.push(`${file.name}: ${error.message}`);
            }
        }

        if (uploaded > 0) {
            await load();
        }

        if (errors.length > 0) {
            const summary = uploaded > 0 ? `${uploaded} uploaded. ` : '';
            showToast(summary + errors.join(' / '), true);
        } else {
            showToast(`${uploaded} PDF${uploaded === 1 ? '' : 's'} added to drop zone`);
        }
    }

    // ------------------------------------------------------------------
    // Event binding
    // ------------------------------------------------------------------

    function init() {
        if (state.initialized) return;
        state.initialized = true;

        Object.assign(els, {
            tableWrap: $('bkTableWrap'),
            tableInner: $('bkTableInner'),
            dropPill: $('bkRowDropPill'),
            rowCount: $('bkRowCount'),
            selectionBar: $('bkSelectionBar'),
            selectionCount: $('bkSelectionCount'),
            csvInput: $('bkCsvInput'),
            importCsvBtn: $('bkImportCsvBtn'),
            deleteSelectedBtn: $('bkDeleteSelectedBtn'),
            exportSelectedBtn: $('bkExportSelectedBtn'),
            clearSelectionBtn: $('bkClearSelectionBtn'),
            dropzone: $('bkDropzone'),
            poolList: $('bkPoolList'),
            poolCount: $('bkPoolCount'),
            poolInput: $('bkPoolInput'),
            poolBrowseBtn: $('bkPoolBrowseBtn'),
            selectToolsBtn: $('bkSelectToolsBtn'),
            selectTools: $('bkSelectTools'),
            selectMonth: $('bkSelectMonth'),
            selectYear: $('bkSelectYear'),
            selectMonthBtn: $('bkSelectMonthBtn'),
            selectFrom: $('bkSelectFrom'),
            selectTo: $('bkSelectTo'),
            selectRangeBtn: $('bkSelectRangeBtn'),
            filterInput: $('bkFilterInput'),
            // PDF preview modal
            pdfPreviewModal: $('bkPdfPreviewModal'),
            pdfPreviewTitle: $('bkPdfPreviewTitle'),
            pdfPreviewFrame: $('bkPdfPreviewFrame'),
            pdfPreviewPages: $('bkPdfPreviewPages'),
            pdfPreviewOpenBtn: $('bkPdfPreviewOpenBtn'),
            pdfPreviewCloseBtn: $('bkPdfPreviewCloseBtn'),
            pdfPreviewDoneBtn: $('bkPdfPreviewDoneBtn'),
            // Import modal
            importModal: $('bkImportModal'),
            importFileName: $('bkImportFileName'),
            importRowCount: $('bkImportRowCount'),
            importColumns: $('bkImportColumns'),
            importDateColumn: $('bkImportDateColumn'),
            importHint: $('bkImportHint'),
            importStepColumns: $('bkImportStepColumns'),
            importStepPreview: $('bkImportStepPreview'),
            importDupWarning: $('bkImportDupWarning'),
            importDupWarningText: $('bkImportDupWarningText'),
            importPreviewColumns: $('bkImportPreviewColumns'),
            importPreviewSelectAll: $('bkImportPreviewSelectAll'),
            importPreviewCount: $('bkImportPreviewCount'),
            importPreviewWrap: $('bkImportPreviewWrap'),
            importBackBtn: $('bkImportBackBtn'),
            importConfirmBtn: $('bkImportConfirmBtn'),
            importCancelBtn: $('bkImportCancelBtn'),
            importCloseBtn: $('bkImportCloseBtn'),
            // PDF modal
            pdfModal: $('bkPdfModal'),
            pdfRowSummary: $('bkPdfRowSummary'),
            pdfWarning: $('bkPdfWarning'),
            pdfWarningText: $('bkPdfWarningText'),
            pdfUploadControls: $('bkPdfUploadControls'),
            pdfFileInput: $('bkPdfFileInput'),
            pdfFileName: $('bkPdfFileName'),
            pdfBrowseBtn: $('bkPdfBrowseBtn'),
            pdfUploadBtn: $('bkPdfUploadBtn'),
            pdfCancelBtn: $('bkPdfCancelBtn'),
            pdfCloseBtn: $('bkPdfCloseBtn'),
            // Confirm modal
            confirmModal: $('bkConfirmModal'),
            confirmTitle: $('bkConfirmTitle'),
            confirmMessage: $('bkConfirmMessage'),
            confirmActions: $('bkConfirmActions'),
            confirmCloseBtn: $('bkConfirmCloseBtn')
        });

        // CSV import
        els.importCsvBtn.addEventListener('click', () => els.csvInput.click());
        els.csvInput.addEventListener('change', () => {
            if (els.csvInput.files[0]) handleCsvFile(els.csvInput.files[0]);
        });
        els.importConfirmBtn.addEventListener('click', () => {
            if (state.importStep === 'preview') {
                doImport();
            } else {
                goToPreviewStep();
            }
        });
        els.importBackBtn.addEventListener('click', goToColumnsStep);

        // Picking a date column implicitly includes it in the import.
        els.importDateColumn.addEventListener('change', () => {
            const index = els.importDateColumn.value;
            const checkbox = els.importColumns.querySelector(`input[data-col-index="${index}"]`);
            if (checkbox) checkbox.checked = true;
        });
        els.importCancelBtn.addEventListener('click', closeImportModal);
        els.importCloseBtn.addEventListener('click', closeImportModal);

        els.importPreviewColumns.addEventListener('change', event => {
            const checkbox = event.target.closest('input[type="checkbox"]');
            if (!checkbox || checkbox.disabled) return;
            const col = checkbox.dataset.col;
            if (checkbox.checked) {
                state.previewExcludedColumns.delete(col);
            } else {
                state.previewExcludedColumns.add(col);
            }
            renderImportPreview();
        });

        els.importPreviewSelectAll.addEventListener('change', () => {
            const checked = els.importPreviewSelectAll.checked;
            state.previewRows.forEach(r => r.selected = checked);
            renderImportPreview();
        });
        els.importPreviewWrap.addEventListener('change', event => {
            const check = event.target.closest('.bk-preview-check');
            if (!check) return;
            const index = parseInt(check.dataset.index, 10);
            state.previewRows[index].selected = check.checked;
            updatePreviewSummary();
        });

        // Selection toolbar
        els.deleteSelectedBtn.addEventListener('click', () => {
            if (state.selection.size > 0) confirmDeleteRows(Array.from(state.selection));
        });
        els.exportSelectedBtn.addEventListener('click', exportSelected);
        els.clearSelectionBtn.addEventListener('click', () => {
            state.selection.clear();
            render();
        });

        // Table interactions (delegated)
        // The tax box lives inside the table, so it is delegated like everything
        // else here. Typing updates the net figure in place - re-rendering the
        // table on each keystroke would tear the focus out of the field - and
        // the value is only written back when the field is left or Enter is
        // pressed.
        // The tax box lives in the breakdown popover, which is appended to
        // <body> so the scrolling table cannot clip it - so these are delegated
        // from document rather than from the table. Typing updates the figures
        // in place; the value is written back on blur or Enter.
        document.addEventListener('input', event => {
            const taxInput = event.target.closest?.('.bk-month-tax-input');
            if (taxInput) updateNetFor(taxInput);
        });

        document.addEventListener('change', event => {
            const taxInput = event.target.closest?.('.bk-month-tax-input');
            if (taxInput) saveMonthTax(taxInput);
        });

        document.addEventListener('keydown', event => {
            const taxInput = event.target.closest?.('.bk-month-tax-input');
            if (taxInput && event.key === 'Enter') {
                event.preventDefault();
                taxInput.blur(); // fires change, which saves
            }
            if (event.key === 'Escape' && document.getElementById('bkMonthBreakdown')) {
                closeMonthBreakdown();
            }
            if (event.key === 'Escape' && document.getElementById('bkRowSubmenu')) {
                closeRowSubmenu();
            } else if (event.key === 'Escape' && document.getElementById('bkRowMenu')) {
                closeRowMenu();
            }
        });

        // Dismiss the breakdown on any click that is not in it or on the
        // button that opened it.
        document.addEventListener('click', event => {
            if (!document.getElementById('bkMonthBreakdown')) return;
            if (event.target.closest?.('#bkMonthBreakdown')) return;
            if (event.target.closest?.('.bk-month-total')) return;
            closeMonthBreakdown();
        });

        document.addEventListener('click', event => {
            if (!document.getElementById('bkRowMenu')) return;
            if (event.target.closest?.('#bkRowMenu')) return;
            if (event.target.closest?.('#bkRowSubmenu')) return;
            // The dots themselves toggle the menu; leave that to the handler
            // on the table, or this would close what that is about to open.
            if (event.target.closest?.('.bk-row-menu-btn')) return;
            closeRowMenu();
        });

        // Reposition would be wrong once its anchor has moved, so it just closes.
        els.tableWrap.addEventListener('scroll', () => {
            closeMonthBreakdown();
            closeRowMenu();
        }, { passive: true });
        window.addEventListener('resize', () => {
            closeMonthBreakdown();
            closeRowMenu();
        });

        // Column resizing: drag a header's right edge; double-click it to fit.
        els.tableWrap.addEventListener('pointerdown', event => {
            const handle = event.target.closest('.bk-col-resizer');
            if (handle && event.button === 0) startColResize(handle, event);
        });
        els.tableWrap.addEventListener('dblclick', event => {
            const handle = event.target.closest('.bk-col-resizer');
            if (handle) resetColWidth(handle.dataset.colKey);
        });

        els.tableWrap.addEventListener('click', event => {
            const monthTotal = event.target.closest('.bk-month-total');
            if (monthTotal) {
                event.stopPropagation();
                if (monthTotal.classList.contains('is-open')) {
                    closeMonthBreakdown();
                } else {
                    openMonthBreakdown(monthTotal);
                }
                return;
            }

            if (suppressSortClick || event.target.closest('.bk-col-resizer')) return;

            const sortHeader = event.target.closest('.bk-sortable-th');
            if (sortHeader) {
                const key = sortHeader.dataset.sortKey;
                // The implicit default sort (DATE_SORT_KEY) is shown on the
                // date column's own header, so clicking that header should
                // flip the direction rather than restart at ascending.
                const dateColumn = state.columns.find(c => isDateSortColumn(c.name));
                const effectiveActive = state.sortColumn === DATE_SORT_KEY
                    ? (dateColumn ? dateColumn.name : null)
                    : state.sortColumn;

                state.sortDirection = effectiveActive === key
                    ? (state.sortDirection === 'asc' ? 'desc' : 'asc')
                    : 'asc';
                state.sortColumn = key;
                render();
                return;
            }

            const selectAll = event.target.closest('#bkSelectAll');
            if (selectAll) {
                const visibleIds = getDisplayRows().map(r => r.id);
                if (selectAll.checked) {
                    visibleIds.forEach(id => state.selection.add(id));
                } else {
                    visibleIds.forEach(id => state.selection.delete(id));
                }
                render();
                return;
            }

            const check = event.target.closest('.bk-row-check');
            if (check) {
                const id = parseInt(check.dataset.rowId, 10);
                if (check.checked) state.selection.add(id);
                else state.selection.delete(id);
                check.closest('tr').classList.toggle('bk-row-selected', check.checked);
                updateToolbar();
                const selectAllBox = $('bkSelectAll');
                if (selectAllBox) {
                    const visible = getDisplayRows();
                    selectAllBox.checked = visible.length > 0 && visible.every(r => state.selection.has(r.id));
                }
                return;
            }

            const actionBtn = event.target.closest('[data-action]');
            if (!actionBtn) return;
            const rowId = parseInt(actionBtn.dataset.rowId, 10);
            switch (actionBtn.dataset.action) {
                case 'row-menu':
                    // Clicking the dots of the open menu closes it, so the
                    // same button is the way in and the way out.
                    if (actionBtn.classList.contains('is-open')) {
                        closeRowMenu();
                    } else {
                        openRowMenu(actionBtn);
                    }
                    break;
                case 'preview-pdf':
                    event.preventDefault();
                    openPdfPreview(parseInt(actionBtn.dataset.pdfId, 10), actionBtn.dataset.pdfName);
                    break;
                // The cross on the PDF chip - every other row action reaches
                // its handler through the row menu instead.
                case 'remove-pdf':
                    confirmRemovePdf(rowId);
                    break;
            }
        });

        // Drag & drop: pool item -> table row
        els.poolList.addEventListener('dragstart', event => {
            const item = event.target.closest('.bk-pool-item');
            if (!item) return;
            event.dataTransfer.setData('application/x-bk-pdf-id', item.dataset.pdfId);
            event.dataTransfer.effectAllowed = 'move';
            item.classList.add('dragging');
        });
        els.poolList.addEventListener('dragend', event => {
            const item = event.target.closest('.bk-pool-item');
            if (item) item.classList.remove('dragging');
        });

        bindFileDrops();

        els.poolBrowseBtn.addEventListener('click', () => els.poolInput.click());

        // Select-by-date tools, now inside a popover
        els.selectMonthBtn.addEventListener('click', () => { selectRowsByMonth(); closeSelectTools(); });
        els.selectRangeBtn.addEventListener('click', () => { selectRowsByRange(); closeSelectTools(); });

        if (els.selectToolsBtn && els.selectTools) {
            els.selectToolsBtn.addEventListener('click', event => {
                event.stopPropagation();
                els.selectTools.hidden ? openSelectTools() : closeSelectTools();
            });

            // A click anywhere else dismisses it, the way a menu should. The
            // listener is on document so it also catches clicks in the table.
            document.addEventListener('click', event => {
                if (els.selectTools.hidden) return;
                if (els.selectTools.contains(event.target)) return;
                if (els.selectToolsBtn.contains(event.target)) return;
                closeSelectTools();
            });

            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !els.selectTools.hidden) {
                    closeSelectTools();
                    els.selectToolsBtn.focus();
                }
            });
        }

        // Filter (sorting is driven by clicking the column headers)
        els.filterInput.addEventListener('input', () => {
            state.filterQuery = els.filterInput.value;
            renderTable();
        });

        els.poolInput.addEventListener('change', () => {
            if (els.poolInput.files.length > 0) {
                uploadPoolFiles(els.poolInput.files);
                els.poolInput.value = '';
            }
        });
        els.poolList.addEventListener('click', event => {
            const deleteBtn = event.target.closest('[data-action="delete-pool-pdf"]');
            if (deleteBtn) {
                confirmDeletePoolPdf(parseInt(deleteBtn.dataset.pdfId, 10));
                return;
            }

            const previewLink = event.target.closest('[data-action="preview-pdf"]');
            if (previewLink) {
                event.preventDefault();
                openPdfPreview(parseInt(previewLink.dataset.pdfId, 10), previewLink.dataset.pdfName);
            }
        });

        // PDF upload modal
        els.pdfBrowseBtn.addEventListener('click', () => els.pdfFileInput.click());
        els.pdfFileInput.addEventListener('change', () => {
            const file = els.pdfFileInput.files[0];
            els.pdfFileName.textContent = file ? file.name : '';
            els.pdfUploadBtn.disabled = !file;
        });
        els.pdfUploadBtn.addEventListener('click', doUploadPdf);
        els.pdfCancelBtn.addEventListener('click', closePdfModal);
        els.pdfCloseBtn.addEventListener('click', closePdfModal);

        // Confirm modal
        els.confirmCloseBtn.addEventListener('click', closeConfirm);

        // PDF preview modal
        els.pdfPreviewCloseBtn.addEventListener('click', closePdfPreview);
        els.pdfPreviewDoneBtn.addEventListener('click', closePdfPreview);
        els.pdfPreviewModal.querySelector('.modal-backdrop').addEventListener('click', closePdfPreview);

        // Close modals on backdrop click
        [els.importModal, els.pdfModal, els.confirmModal].forEach(modal => {
            modal.querySelector('.modal-backdrop').addEventListener('click', () => {
                modal.classList.remove('active');
            });
        });
    }

    window.Bookkeeping = {
        load,
        focusRow,
        // The preview dialog belongs to this module; init() only wires it up
        // and fetches nothing, so it is safe to call from any view.
        preview(url, name, kind) {
            init();
            return openPreview(url, name, kind);
        }
    };
})();
