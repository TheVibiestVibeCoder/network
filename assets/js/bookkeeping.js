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

    const state = {
        columns: [],
        rows: [],
        pool: [],
        settings: { selected_columns: [], date_column: null },
        limits: { maxUploadBytes: 0, maxUploadLabel: '' },
        selection: new Set(),
        loaded: false,
        csv: null, // { headers, rows, fileName }
        pdfModalRowId: null,
        initialized: false,
        filterQuery: '',
        sortColumn: DATE_SORT_KEY,
        sortDirection: 'asc',
        // Import preview (step 2 of the import modal)
        importStep: 'columns',
        previewColumns: [],
        previewExcludedColumns: new Set(),
        previewDateColumn: null,
        previewRows: [] // [{ data, isDuplicate, selected }]
    };

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
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
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

    function load() {
        init();
        loadPromise = (async () => {
            try {
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
            }
        })();
        return loadPromise;
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
        const stillExists = state.sortColumn === DATE_SORT_KEY || state.columns.some(c => c.name === state.sortColumn);
        if (!stillExists) {
            state.sortColumn = DATE_SORT_KEY;
            state.sortDirection = 'asc';
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
     * state.sortColumn/state.sortDirection. Defaults to date order (undated
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

        rows = [...rows].sort((a, b) => {
            let cmp;

            if (byDate) {
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
        const colCount = state.columns.length + 3; // checkbox + columns + pdf + actions

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

        let html = '<table class="bk-table"><thead><tr>';
        html += `<th class="bk-col-check"><input type="checkbox" id="bkSelectAll" title="Select all" ${displayRows.length > 0 && displayRows.every(r => state.selection.has(r.id)) ? 'checked' : ''}></th>`;
        state.columns.forEach(col => {
            const active = col.name === activeSortCol;
            html += `<th class="bk-sortable-th ${active ? 'bk-sort-active' : ''}" data-sort-key="${escapeHtml(col.name)}" title="Sort by ${escapeHtml(col.name)}">
                <span>${escapeHtml(col.name)}</span>${active ? dirIndicator : ''}
            </th>`;
        });
        html += '<th class="bk-col-pdf">PDF / Invoice</th><th class="bk-col-actions"></th></tr></thead><tbody>';

        let previousMonth = null;
        displayRows.forEach(row => {
            if (groupByMonth) {
                const month = monthLabel(row.row_date);
                if (month !== previousMonth) {
                    html += `<tr class="bk-month-row"><td colspan="${colCount}">${escapeHtml(month)}</td></tr>`;
                    previousMonth = month;
                }
            }

            const ok = !!row.pdf || row.no_pdf_needed;
            const selected = state.selection.has(row.id);
            html += `<tr class="bk-row ${ok ? 'bk-row-ok' : 'bk-row-missing'} ${selected ? 'bk-row-selected' : ''}" data-row-id="${row.id}">`;
            html += `<td class="bk-col-check"><input type="checkbox" class="bk-row-check" data-row-id="${row.id}" ${selected ? 'checked' : ''}></td>`;
            state.columns.forEach(col => {
                const value = row.data[col.name] ?? '';
                html += `<td class="${amountClass(value, col.name)}">${escapeHtml(value)}</td>`;
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

            // Actions cell
            html += '<td class="bk-col-actions"><div class="bk-row-actions">';
            if (!row.pdf) {
                html += `
                    <button type="button" class="bk-icon-btn" data-action="upload" data-row-id="${row.id}" title="Upload PDF for this row">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
                    </button>`;
                html += `
                    <button type="button" class="bk-icon-btn ${row.no_pdf_needed ? 'bk-icon-btn-active' : ''}" data-action="toggle-nopdf" data-row-id="${row.id}" title="${row.no_pdf_needed ? 'Mark as: PDF required' : 'Mark as: no PDF needed'}">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="3.5" y1="20.5" x2="20.5" y2="3.5"/></svg>
                    </button>`;
            }
            html += `
                <button type="button" class="bk-icon-btn bk-icon-btn-danger" data-action="delete-row" data-row-id="${row.id}" title="Delete row">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>`;
            html += '</div></td>';
            html += '</tr>';
        });

        html += '</tbody></table>';
        wrap.innerHTML = html;
    }

    function renderPool() {
        const count = state.pool.length;
        els.poolCount.textContent = count === 1 ? '1 file' : `${count} files`;

        if (count === 0) {
            els.poolList.innerHTML = '<p class="bk-pool-empty">No unassigned PDFs.<br>Drop files here to store them until the matching bank entry is imported.</p>';
            return;
        }

        els.poolList.innerHTML = state.pool.map(pdf => `
            <div class="bk-pool-item" draggable="true" data-pdf-id="${pdf.id}" title="Drag onto a table row to assign">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" class="bk-pool-item-icon"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
                <div class="bk-pool-item-info">
                    <a class="bk-pool-item-name" href="#" data-action="preview-pdf" data-pdf-id="${pdf.id}" data-pdf-name="${escapeHtml(pdf.name)}">${escapeHtml(pdf.name)}</a>
                    <span class="bk-pool-item-size">${formatSize(pdf.size)}</span>
                </div>
                <button type="button" class="bk-icon-btn bk-icon-btn-danger" data-action="delete-pool-pdf" data-pdf-id="${pdf.id}" title="Delete PDF">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
            </div>
        `).join('');
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
     * Flags rows that look like they might already exist, checked against
     * both the table's current rows and other rows in this same import
     * batch. Prefers matching on "Betrag"/amount + "Partnername"/payee
     * columns (the fields that most reliably identify a duplicate bank
     * transaction); falls back to comparing every imported column's value
     * when those aren't present.
     */
    function computeDuplicateFlags(candidateRows, selectedColumns) {
        const amountCol = findColumnByNames(selectedColumns, ['betrag', 'amount', 'sum', 'value']);
        const partyCol = findColumnByNames(selectedColumns, ['partnername', 'partner', 'payee', 'empfänger', 'empfaenger', 'beschreibung', 'description']);
        const useSpecificKey = amountCol && partyCol;

        const keyOf = (getValue) => useSpecificKey
            ? `${normalizeForCompare(getValue(amountCol))}|${normalizeForCompare(getValue(partyCol))}`
            : selectedColumns.map(c => normalizeForCompare(getValue(c))).join('|');

        const existingKeys = new Set();
        state.rows.forEach(row => {
            const key = keyOf(col => row.data[col]);
            if (key.replace(/\|/g, '') !== '') existingKeys.add(key);
        });

        const seenInBatch = new Set();
        return candidateRows.map(row => {
            const key = keyOf(col => row[col]);
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

        const dupFlags = computeDuplicateFlags(candidateData, selectedColumns);

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
        const dupFlags = computeDuplicateFlags(state.previewRows.map(r => r.data), cols);
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

    function openPdfPreview(pdfId, pdfName) {
        if (!pdfId) return;
        const url = `${API}?action=download-pdf&id=${pdfId}`;
        els.pdfPreviewTitle.textContent = pdfName || 'PDF';
        els.pdfPreviewFrame.src = url;
        els.pdfPreviewOpenBtn.href = url;
        els.pdfPreviewModal.classList.add('active');
    }

    function closePdfPreview() {
        els.pdfPreviewModal.classList.remove('active');
        // Release the embedded document so it stops rendering in the background.
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
            await postForm('upload-pdf', formData);
            closePdfModal();
            showToast(`PDF "${file.name}" assigned`);
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
    function dragLooksLikeCsv(dataTransfer) {
        const items = dataTransfer.items;
        if (!items) return false;
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file' && /csv|excel|spreadsheet/i.test(items[i].type || '')) {
                return true;
            }
        }
        return false;
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
                    await postJson('assign-pdf', { pdf_id: pdf.id, row_id: row.id });
                    showToast(`"${pdf.name}" assigned`);
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
                    await postForm('upload-pdf', formData);
                    showToast(`"${file.name}" assigned`);
                    await load();
                }
            }]
        });
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
        els.tableWrap.addEventListener('click', event => {
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
                case 'preview-pdf':
                    event.preventDefault();
                    openPdfPreview(parseInt(actionBtn.dataset.pdfId, 10), actionBtn.dataset.pdfName);
                    break;
                case 'upload':
                    openPdfModal(rowId);
                    break;
                case 'toggle-nopdf':
                    toggleNoPdf(rowId);
                    break;
                case 'delete-row':
                    confirmDeleteRows([rowId]);
                    break;
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

        els.tableWrap.addEventListener('dragover', event => {
            const isInternal = event.dataTransfer.types.includes('application/x-bk-pdf-id');
            const isOsFile = event.dataTransfer.types.includes('Files');
            if (!isInternal && !isOsFile) return;
            // A CSV over the table is an import, so don't offer the per-row
            // PDF affordance for it.
            if (!isInternal && dragLooksLikeCsv(event.dataTransfer)) {
                hideDropPill();
                els.tableWrap.querySelectorAll('tr.bk-drop-target').forEach(tr => tr.classList.remove('bk-drop-target'));
                return;
            }

            const rowEl = event.target.closest('tr.bk-row');
            els.tableWrap.querySelectorAll('tr.bk-drop-target').forEach(tr => {
                if (tr !== rowEl) tr.classList.remove('bk-drop-target');
            });
            if (rowEl) {
                event.preventDefault();
                event.dataTransfer.dropEffect = isInternal ? 'move' : 'copy';
                rowEl.classList.add('bk-drop-target');
                positionDropPill(rowEl);
            } else {
                hideDropPill();
            }
        });
        els.tableWrap.addEventListener('dragleave', event => {
            const rowEl = event.target.closest('tr.bk-row');
            if (rowEl && !rowEl.contains(event.relatedTarget)) {
                rowEl.classList.remove('bk-drop-target');
            }
            if (!els.tableWrap.contains(event.relatedTarget)) {
                hideDropPill();
            }
        });
        els.tableWrap.addEventListener('drop', event => {
            const rowEl = event.target.closest('tr.bk-row');
            els.tableWrap.querySelectorAll('tr.bk-drop-target').forEach(tr => tr.classList.remove('bk-drop-target'));
            hideDropPill();
            if (!rowEl) return;

            const pdfId = event.dataTransfer.getData('application/x-bk-pdf-id');
            if (pdfId) {
                event.preventDefault();
                assignPdfToRow(parseInt(pdfId, 10), parseInt(rowEl.dataset.rowId, 10));
                return;
            }

            const files = event.dataTransfer.files;
            if (files && files.length > 0) {
                // A CSV dropped on the table is an import, never a row
                // attachment - leave it unhandled so it bubbles to the
                // view-level handler.
                if (findCsvFile(files)) return;
                event.preventDefault();
                uploadDroppedFileToRow(files[0], parseInt(rowEl.dataset.rowId, 10));
            }
        });

        // Drop zone: OS file drops + browse + pool item deletion
        ['dragover', 'dragenter'].forEach(type => {
            els.dropzone.addEventListener(type, event => {
                if (event.dataTransfer.types.includes('Files') && !dragLooksLikeCsv(event.dataTransfer)) {
                    event.preventDefault();
                    els.dropzone.classList.add('bk-dropzone-hover');
                }
            });
        });
        els.dropzone.addEventListener('dragleave', event => {
            if (!els.dropzone.contains(event.relatedTarget)) {
                els.dropzone.classList.remove('bk-dropzone-hover');
            }
        });
        els.dropzone.addEventListener('drop', event => {
            els.dropzone.classList.remove('bk-dropzone-hover');
            const files = event.dataTransfer.files;
            if (files && files.length > 0) {
                // Same here: a CSV means import, so let it bubble.
                if (findCsvFile(files)) return;
                event.preventDefault();
                uploadPoolFiles(files);
            }
        });
        els.poolBrowseBtn.addEventListener('click', () => els.poolInput.click());

        // Select-by-date tools
        els.selectMonthBtn.addEventListener('click', selectRowsByMonth);
        els.selectRangeBtn.addEventListener('click', selectRowsByRange);

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

        // Files can be dropped anywhere on the bookkeeping view. The drop zone
        // and table rows handle their own drops first (and call preventDefault
        // when they do); anything they leave unhandled - notably a CSV, which
        // is always an import no matter where it lands - arrives here.
        const bookkeepingView = document.getElementById('bookkeepingView');
        if (bookkeepingView) {
            bookkeepingView.addEventListener('dragover', event => {
                if (!event.dataTransfer.types.includes('Files')) return;
                const overOwnTarget = event.target.closest('#bkDropzone') || event.target.closest('tr.bk-row');
                if (overOwnTarget && !dragLooksLikeCsv(event.dataTransfer)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                bookkeepingView.classList.add('bk-csv-drop-active');
            });
            bookkeepingView.addEventListener('dragleave', event => {
                if (!bookkeepingView.contains(event.relatedTarget)) {
                    bookkeepingView.classList.remove('bk-csv-drop-active');
                }
            });
            bookkeepingView.addEventListener('drop', event => {
                bookkeepingView.classList.remove('bk-csv-drop-active');
                // The drop zone / a table row already dealt with it.
                if (event.defaultPrevented) return;

                const files = event.dataTransfer.files;
                if (!files || files.length === 0) return;
                event.preventDefault();

                const csv = findCsvFile(files);
                if (csv) {
                    handleCsvFile(csv);
                    return;
                }
                if (Array.from(files).some(f => /\.pdf$/i.test(f.name))) {
                    // A PDF dropped on empty space goes to the drop zone pool.
                    uploadPoolFiles(files);
                    return;
                }
                showToast('Drop a .csv file to import, or a .pdf to store it in the drop zone', true);
            });
        }
    }

    window.Bookkeeping = { load };
})();
