/**
 * From Claude
 *
 * Everything Claude writes through the MCP API is a proposal until a person
 * decides. This module is where that happens:
 *
 *   - the "From Claude" screen: one row per proposal, grouped like the other
 *     lists in the CRM, with accept and reject at the end of the row and the
 *     details (before/after, Claude's note, edit) one click away; plus a
 *     history of what was decided and by whom;
 *   - the small "Claude" marks and accept/reject buttons that app.js and
 *     bookkeeping.js put on proposed records where they are listed;
 *   - the box in a contact's or project's detail view listing the open
 *     proposals about it.
 *
 * A proposed NEW record already exists (marked pending), so accepting it only
 * clears the mark and rejecting deletes it - both on the server. A proposed
 * CHANGE to an existing record is applied here, through the same endpoints a
 * manual edit uses, so it gets the same validation, geocoding and logging and
 * is attributed to the person who accepted it. Only then is it marked resolved.
 *
 * Every signed-in person may decide; there is no separate permission for it.
 */
(function () {
    'use strict';

    const API = 'api/review.php';

    const TYPE_LABEL = {
        contact: 'contact',
        project: 'project',
        todo: 'to-do',
        contact_note: 'note',
        project_note: 'project note',
        bookkeeping_pdf: 'invoice'
    };

    const FIELD_LABEL = {
        name: 'Name', company: 'Company', location: 'Location', email: 'Email', phone: 'Phone',
        website: 'Website', address: 'Address', note: 'Note', description: 'Description',
        start_date: 'Start date', estimated_completion: 'Planned finish', stage: 'Stage',
        budget_min: 'Budget from', budget_max: 'Budget to', success_chance: 'Chance (%)',
        title: 'Title', due_date: 'Due', priority: 'Priority', is_completed: 'Done', content: 'Text'
    };

    // What can be edited before accepting, per proposed record type.
    const EDITABLE = {
        contact: ['name', 'company', 'email', 'phone', 'location', 'website', 'address', 'note'],
        project: ['name', 'company', 'stage', 'start_date', 'estimated_completion', 'budget_min', 'budget_max', 'success_chance', 'description'],
        todo: ['title', 'due_date', 'priority', 'description'],
        contact_note: ['content'],
        project_note: ['content']
    };

    const STAGES = ['Lead', 'Proposal', 'Negotiation', 'In Progress', 'Complete'];
    const PRIORITIES = ['', 'low', 'medium', 'high'];
    const LONG_FIELDS = ['note', 'address', 'description', 'content'];
    const DATE_FIELDS = ['start_date', 'estimated_completion', 'due_date'];
    const NUMBER_FIELDS = ['budget_min', 'budget_max', 'success_chance'];

    // The record types api/assign.php knows.
    const ASSIGN_TYPE = { contact: 'contact', project: 'project', todo: 'todo' };

    const state = {
        tab: 'pending',
        items: [],
        loading: false,
        busy: new Set(),
        open: new Set(),
        editing: new Set(),
        errors: {},
        pollTimer: null
    };

    const els = {};

    // ------------------------------------------------------------------
    // Utilities
    // ------------------------------------------------------------------

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    function encodeUtf8Base64(value) {
        const bytes = new TextEncoder().encode(value);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
    }

    async function request(url, options = {}) {
        const opts = Object.assign({ headers: {} }, options);
        opts.headers = Object.assign({ 'X-CSRF-Token': getCsrfToken() }, opts.headers);
        if (opts.json !== undefined) {
            opts.body = JSON.stringify(opts.json);
            opts.headers['Content-Type'] = 'application/json';
            delete opts.json;
        }

        const response = await fetch(url, opts);
        const text = await response.text();
        let payload = {};
        try {
            payload = text ? JSON.parse(text) : {};
        } catch (e) {
            throw new Error(response.status === 403
                ? 'The web server blocked this request.'
                : 'The server returned an unexpected response.');
        }

        if (!response.ok || payload.error || payload.success === false) {
            throw new Error(payload.error || payload.message || 'Request failed.');
        }
        return payload;
    }

    /** SQLite stores UTC as "YYYY-MM-DD HH:MM:SS". */
    function parseUtc(value) {
        if (!value) return null;
        const date = new Date(String(value).replace(' ', 'T') + 'Z');
        return isNaN(date.getTime()) ? null : date;
    }

    function timeAgo(value) {
        const date = parseUtc(value);
        if (!date) return '';
        const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
        if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
        if (seconds < 7 * 86400) return Math.floor(seconds / 86400) + ' d ago';
        return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function fullDate(value) {
        const date = parseUtc(value);
        return date ? date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    }

    function formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return Math.round(n / 1024) + ' KB';
        return n + ' B';
    }

    function isEmpty(value) {
        return value === null || value === undefined || String(value).trim() === '';
    }

    function displayValue(field, value) {
        if (field === 'is_completed') {
            return value === true || value === 1 || value === '1' ? 'Yes' : 'No';
        }
        if (isEmpty(value)) return '—';
        if (field === 'priority') return String(value).charAt(0).toUpperCase() + String(value).slice(1);
        return String(value);
    }

    function sameValue(a, b) {
        const norm = v => {
            if (v === null || v === undefined) return '';
            if (typeof v === 'boolean') return v ? '1' : '0';
            const s = String(v).trim();
            return s !== '' && !isNaN(Number(s)) ? String(Number(s)) : s;
        };
        return norm(a) === norm(b);
    }

    function joinParts(parts) {
        return parts.filter(v => !isEmpty(v)).join(' · ');
    }

    function excerpt(text, length = 140) {
        const flat = String(text || '').replace(/\s+/g, ' ').trim();
        return flat.length > length ? flat.slice(0, length - 1) + '…' : flat;
    }

    function budgetText(r) {
        return [r.budget_min, r.budget_max].filter(v => !isEmpty(v)).map(v => Number(v).toLocaleString('de-AT') + ' €').join(' – ');
    }

    // ------------------------------------------------------------------
    // Describing a proposal
    // ------------------------------------------------------------------

    /** The record as it is now, or - once it is gone - what Claude proposed. */
    function source(item) {
        return item.record || item.payload || {};
    }

    function kindLabel(item) {
        switch (item.kind) {
            case 'create': return 'New ' + (TYPE_LABEL[item.entity_type] || 'record');
            case 'update': return 'Change';
            case 'delete': return 'Delete';
            case 'link': return 'Add to project';
            case 'unlink': return 'Remove from project';
            case 'tag': return 'Add tag';
            case 'untag': return 'Remove tag';
            case 'assign': return 'Assign';
            default: return 'Proposal';
        }
    }

    /** Which colour the row's mark takes: what kind of decision, or how it ended. */
    function tone(item) {
        if (item.status === 'accepted') return 'accepted';
        if (item.status === 'rejected') return 'rejected';
        if (item.status !== 'pending') return 'neutral';
        if (item.kind === 'create') return 'new';
        if (item.kind === 'delete' || item.kind === 'unlink' || item.kind === 'untag') return 'remove';
        return 'change';
    }

    function titleFor(item) {
        const r = item.record || {};
        const label = String(item.entity_label || '');
        switch (item.entity_type) {
            case 'contact':
            case 'project':
                return r.name || label;
            case 'todo':
                return r.title || label;
            case 'contact_note':
                return r.contact_name || label.split(':')[0];
            case 'project_note':
                return r.project_name || label.split(':')[0];
            case 'bookkeeping_pdf':
                return r.original_name || label;
            default:
                return label;
        }
    }

    /** One line that says what the proposal is, readable without opening it. */
    function summaryFor(item) {
        const s = source(item);
        const p = item.payload || {};
        const r = item.record || {};

        switch (item.kind) {
            case 'create':
                switch (item.entity_type) {
                    case 'contact': return joinParts([s.company, s.email, s.phone, s.location]);
                    case 'project': return joinParts([s.company, s.stage, budgetText(s)]);
                    case 'todo': return joinParts([
                        r.contact_name ? 'For ' + r.contact_name : (r.project_name ? 'Project ' + r.project_name : ''),
                        s.due_date ? 'Due ' + s.due_date : '',
                        s.priority ? displayValue('priority', s.priority) + ' priority' : ''
                    ]);
                    case 'contact_note':
                    case 'project_note': return excerpt(s.content);
                    case 'bookkeeping_pdf': return joinParts([formatBytes(r.file_size || p.size), 'Bookkeeping drop zone']);
                    default: return '';
                }
            case 'update':
                return Object.keys(p).map(field => (FIELD_LABEL[field] || field) + ' → ' + displayValue(field, p[field])).join(' · ');
            case 'delete':
                return 'Claude suggests deleting this ' + (TYPE_LABEL[item.entity_type] || 'record');
            case 'link':
            case 'unlink': {
                const contact = (item.related || {}).contact;
                return (item.kind === 'link' ? '+ ' : '− ') + (contact ? contact.name : 'a contact that no longer exists');
            }
            case 'tag':
                return '+ ' + (p.tag_name || '');
            case 'untag':
                return '− ' + (p.tag_name || '');
            case 'assign':
                return ((item.previous || {}).assigned_to_name || 'Nobody') + ' → ' + (p.assigned_to_name || 'nobody');
            default:
                return '';
        }
    }

    /** Whether somebody changed the record after Claude proposed a change to it. */
    function isStale(item) {
        if (item.kind !== 'update' || !item.record) return false;
        const previous = item.previous || {};
        return Object.keys(item.payload || {}).some(field => !sameValue(previous[field], item.record[field]));
    }

    function factsList(pairs) {
        const rows = pairs.filter(([, value]) => !isEmpty(value)).map(([label, value, long]) => `
            <div class="review-fact${long ? ' review-fact--long' : ''}">
                <dt>${escapeHtml(label)}</dt>
                <dd>${escapeHtml(value)}</dd>
            </div>`).join('');
        return rows ? `<dl class="review-facts">${rows}</dl>` : '';
    }

    function pdfLink(pdfId, label) {
        return `<a class="review-link" href="api/bookkeeping.php?action=download-pdf&id=${encodeURIComponent(pdfId)}" target="_blank" rel="noopener">${escapeHtml(label || 'View PDF')}</a>`;
    }

    /** The details behind the row: every field, the before/after, the warnings. */
    function detailFor(item) {
        const s = source(item);
        const p = item.payload || {};
        const r = item.record || {};

        switch (item.kind) {
            case 'create':
                if (item.entity_type === 'contact') {
                    return factsList([
                        ['Company', s.company], ['Email', s.email], ['Phone', s.phone], ['Location', s.location],
                        ['Website', s.website], ['Address', s.address, true], ['Note', s.note, true]
                    ]);
                }
                if (item.entity_type === 'project') {
                    return factsList([
                        ['Company', s.company], ['Stage', s.stage], ['Start', s.start_date], ['Planned finish', s.estimated_completion],
                        ['Budget', budgetText(s)], ['Chance', isEmpty(s.success_chance) ? '' : s.success_chance + ' %'],
                        ['Description', s.description, true]
                    ]);
                }
                if (item.entity_type === 'todo') {
                    return factsList([
                        ['Due', s.due_date], ['Priority', isEmpty(s.priority) ? '' : displayValue('priority', s.priority)],
                        ['Description', s.description, true]
                    ]);
                }
                if (item.entity_type === 'contact_note' || item.entity_type === 'project_note') {
                    return `<p class="review-quote-text">${escapeHtml(s.content || '')}</p>`;
                }
                if (item.entity_type === 'bookkeeping_pdf') {
                    return item.record
                        ? `<p class="review-line">${pdfLink(item.entity_id)} <span class="review-muted">· Filing it on its bank entry accepts it too.</span></p>`
                        : '';
                }
                return '';

            case 'update': {
                const previous = item.previous || {};
                const rows = Object.keys(p).map(field => {
                    const was = previous[field];
                    const now = r[field];
                    const stale = item.record && !sameValue(was, now);
                    return `
                        <tr>
                            <th scope="row">${escapeHtml(FIELD_LABEL[field] || field)}</th>
                            <td class="review-old">${escapeHtml(displayValue(field, was))}${stale ? `<span class="review-stale">changed since, now: ${escapeHtml(displayValue(field, now))}</span>` : ''}</td>
                            <td class="review-arrow" aria-hidden="true">→</td>
                            <td class="review-new">${escapeHtml(displayValue(field, p[field]))}</td>
                        </tr>`;
                }).join('');
                return `<table class="review-diff"><tbody>${rows}</tbody></table>`;
            }

            case 'delete': {
                const snapshot = item.previous || {};
                const facts = factsList(Object.keys(snapshot).map(field => [FIELD_LABEL[field] || field, displayValue(field, snapshot[field]), LONG_FIELDS.includes(field)]));
                const goesWith = item.entity_type === 'contact' ? ' Its notes, to-dos, tags and project links go with it.'
                    : item.entity_type === 'project' ? ' Its notes, to-dos and tags go with it.' : '';
                return `${facts}${item.status === 'pending' ? `<p class="review-warning">Accepting deletes it for good.${goesWith}</p>` : ''}`;
            }

            case 'link':
            case 'unlink': {
                const contact = (item.related || {}).contact;
                return factsList([
                    ['Contact', contact ? joinParts([contact.name, contact.company]) : ''],
                    ['Project', r.name || item.entity_label]
                ]);
            }

            case 'tag':
            case 'untag':
                return factsList([['Tag', p.tag_name], [TYPE_LABEL[item.entity_type] === 'project' ? 'Project' : 'Contact', r.name]]);

            case 'assign':
                return factsList([
                    ['Before', (item.previous || {}).assigned_to_name || 'Nobody'],
                    ['After', p.assigned_to_name || 'Nobody']
                ]);

            default:
                return '';
        }
    }

    function canEdit(item) {
        return item.status === 'pending' && ((item.kind === 'create' && EDITABLE[item.entity_type]) || item.kind === 'update');
    }

    function canOpen(item) {
        return !!item.record && item.status !== 'obsolete'
            && ['contact', 'project', 'todo', 'contact_note', 'project_note', 'bookkeeping_pdf'].includes(item.entity_type);
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
    const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
    const ICON_SPARK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z"/></svg>';
    const ICON_CHEVRON = '<svg class="review-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
    const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

    function fieldInput(field, value) {
        const id = 'rv-' + field + '-' + Math.random().toString(36).slice(2, 8);
        const label = `<label for="${id}">${escapeHtml(FIELD_LABEL[field] || field)}</label>`;
        const v = value === null || value === undefined ? '' : String(value);

        if (field === 'stage') {
            return `<div class="review-field">${label}<select id="${id}" class="form-select" data-field="stage">${STAGES.map(s => `<option value="${s}"${s === v ? ' selected' : ''}>${s}</option>`).join('')}</select></div>`;
        }
        if (field === 'priority') {
            return `<div class="review-field">${label}<select id="${id}" class="form-select" data-field="priority">${PRIORITIES.map(s => `<option value="${s}"${s === v ? ' selected' : ''}>${s ? s.charAt(0).toUpperCase() + s.slice(1) : 'No priority'}</option>`).join('')}</select></div>`;
        }
        if (field === 'is_completed') {
            const on = v === '1' || v === 'true';
            return `<div class="review-field review-field--check"><label><input type="checkbox" data-field="is_completed"${on ? ' checked' : ''}> Done</label></div>`;
        }
        if (LONG_FIELDS.includes(field)) {
            return `<div class="review-field review-field--wide">${label}<textarea id="${id}" class="form-input" rows="3" data-field="${field}">${escapeHtml(v)}</textarea></div>`;
        }
        const type = DATE_FIELDS.includes(field) ? 'date' : (NUMBER_FIELDS.includes(field) ? 'number' : (field === 'email' ? 'email' : 'text'));
        return `<div class="review-field">${label}<input id="${id}" type="${type}" class="form-input" data-field="${field}" value="${escapeHtml(v)}"></div>`;
    }

    function editForm(item) {
        const fields = item.kind === 'create' ? EDITABLE[item.entity_type] : Object.keys(item.payload || {});
        const values = item.kind === 'create' ? (item.record || {}) : (item.payload || {});
        const primary = item.kind === 'create' ? 'Save & accept' : 'Apply & accept';

        return `
            <form class="review-edit" data-review-form>
                <div class="review-edit-grid">${fields.map(f => fieldInput(f, values[f])).join('')}</div>
                <div class="review-detail-actions">
                    <button type="submit" class="btn btn-primary btn-small">${primary}</button>
                    ${item.kind === 'create' ? '<button type="button" class="btn btn-secondary btn-small" data-review-act="save" title="Keep your edits, decide later">Save only</button>' : ''}
                    <button type="button" class="btn btn-secondary btn-small" data-review-act="cancel">Cancel</button>
                </div>
            </form>`;
    }

    function statusPill(item) {
        const who = item.resolved_by_name || 'someone';
        switch (item.status) {
            case 'accepted': return `<span class="review-pill review-pill--accepted">Accepted · ${escapeHtml(who)}</span>`;
            case 'rejected': return `<span class="review-pill review-pill--rejected">Rejected · ${escapeHtml(who)}</span>`;
            case 'withdrawn': return '<span class="review-pill">Withdrawn by Claude</span>';
            case 'obsolete': return '<span class="review-pill" title="The record was removed in the meantime">No longer relevant</span>';
            default: return '';
        }
    }

    function renderRow(item) {
        const pending = item.status === 'pending';
        const busy = state.busy.has(item.id);
        const editing = pending && state.editing.has(item.id);
        const open = editing || state.open.has(item.id);
        const error = state.errors[item.id];
        const stale = isStale(item);
        const summary = summaryFor(item);
        const when = pending ? item.created_at : (item.resolved_at || item.created_at);

        const end = pending ? `
            <div class="review-row-actions">
                <button type="button" class="review-act review-act--accept" data-review-act="accept" title="Accept" aria-label="Accept"${busy ? ' disabled' : ''}>${ICON_CHECK}</button>
                <button type="button" class="review-act review-act--reject" data-review-act="reject" title="Reject" aria-label="Reject"${busy ? ' disabled' : ''}>${ICON_X}</button>
            </div>` : `<div class="review-row-status">${statusPill(item)}</div>`;

        let detail = '';
        if (open) {
            const tools = [
                canEdit(item) && !editing ? `<button type="button" class="btn btn-secondary btn-small" data-review-act="edit">${ICON_EDIT}<span>Edit</span></button>` : '',
                canOpen(item) ? '<button type="button" class="btn btn-secondary btn-small" data-review-act="open">Open</button>' : ''
            ].filter(Boolean).join('');

            detail = `
                <div class="review-row-detail">
                    ${editing ? editForm(item) : detailFor(item)}
                    ${item.comment ? `<p class="review-reason"><span class="review-reason-label">${ICON_SPARK} Claude's note</span>${escapeHtml(item.comment)}</p>` : ''}
                    ${!pending ? `<p class="review-line review-muted">Proposed ${escapeHtml(fullDate(item.created_at))}${item.resolved_at ? ' · decided ' + escapeHtml(fullDate(item.resolved_at)) : ''}</p>` : ''}
                    ${tools && !editing ? `<div class="review-detail-actions">${tools}</div>` : ''}
                </div>`;
        }

        return `
            <article class="review-row review-row--${tone(item)}${open ? ' is-open' : ''}${busy ? ' is-busy' : ''}" data-review-id="${item.id}">
                <div class="review-row-head">
                    <button type="button" class="review-row-toggle" data-review-act="toggle" aria-expanded="${open ? 'true' : 'false'}">
                        <span class="review-row-mark" aria-hidden="true"></span>
                        <span class="review-row-text">
                            <span class="review-row-line">
                                <span class="review-row-title">${escapeHtml(titleFor(item))}</span>
                                <span class="review-row-kind">${escapeHtml(kindLabel(item))}</span>
                            </span>
                            <span class="review-row-summary">${stale ? `<span class="review-row-warn" title="Changed by someone since Claude proposed this">${ICON_WARN}</span>` : ''}${item.comment ? `<span class="review-row-note" title="${escapeHtml(item.comment)}">${ICON_SPARK}</span>` : ''}<span class="review-row-summary-text">${escapeHtml(summary)}</span></span>
                        </span>
                        <span class="review-row-when" title="${escapeHtml(fullDate(when))}">${escapeHtml(timeAgo(when))}</span>
                        ${ICON_CHEVRON}
                    </button>
                    ${end}
                </div>
                ${error ? `<p class="review-error" role="alert">${escapeHtml(error)}</p>` : ''}
                ${detail}
            </article>`;
    }

    function listCard(items) {
        return `<div class="review-list-card">${items.map(renderRow).join('')}</div>`;
    }

    const GROUPS = [
        { title: 'New contacts', match: i => i.kind === 'create' && i.entity_type === 'contact' },
        { title: 'New projects', match: i => i.kind === 'create' && i.entity_type === 'project' },
        { title: 'New to-dos', match: i => i.kind === 'create' && i.entity_type === 'todo' },
        { title: 'New notes', match: i => i.kind === 'create' && (i.entity_type === 'contact_note' || i.entity_type === 'project_note') },
        { title: 'Invoices', match: i => i.entity_type === 'bookkeeping_pdf' },
        { title: 'Changes to existing records', match: () => true }
    ];

    function render() {
        if (!els.list) return;
        updateTabs();

        if (state.loading && state.items.length === 0) {
            els.list.innerHTML = '<div class="review-empty"><p>Loading…</p></div>';
            return;
        }

        if (state.items.length === 0) {
            els.list.innerHTML = state.tab === 'pending' ? `
                <div class="review-empty">
                    ${ICON_SPARK}
                    <h3>Nothing waiting</h3>
                    <p>When Claude adds or changes something in the CRM, it appears here first - and only becomes permanent once someone accepts it.</p>
                </div>` : `
                <div class="review-empty">
                    <h3>No decisions yet</h3>
                    <p>Accepted and rejected proposals are listed here.</p>
                </div>`;
            return;
        }

        if (state.tab === 'resolved') {
            els.list.innerHTML = `<section class="review-group">${listCard(state.items)}</section>`;
            return;
        }

        const used = new Set();
        els.list.innerHTML = GROUPS.map(group => {
            const items = state.items.filter(i => !used.has(i.id) && group.match(i));
            items.forEach(i => used.add(i.id));
            if (!items.length) return '';
            return `
                <section class="review-group" aria-label="${escapeHtml(group.title)}">
                    <h2 class="review-group-title">${escapeHtml(group.title)} <span class="review-group-count">${items.length}</span></h2>
                    ${listCard(items)}
                </section>`;
        }).join('');
    }

    function updateTabs() {
        document.querySelectorAll('[data-review-tab]').forEach(btn => {
            const active = btn.dataset.reviewTab === state.tab;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    function rerenderRow(id) {
        const item = findItem(id);
        if (!item) return;
        document.querySelectorAll(`.review-row[data-review-id="${id}"]`).forEach(node => {
            node.outerHTML = renderRow(item);
        });
    }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    async function load(tab) {
        if (tab) state.tab = tab;
        state.loading = true;
        render();
        try {
            const result = await request(`${API}?action=list&status=${state.tab === 'resolved' ? 'resolved' : 'pending'}`);
            state.items = Array.isArray(result.data) ? result.data : [];
            state.errors = {};
            state.editing.clear();
            state.open.clear();
        } catch (error) {
            state.items = [];
            if (els.list) els.list.innerHTML = `<div class="review-empty"><p class="review-error">${escapeHtml(error.message)}</p></div>`;
            state.loading = false;
            return;
        }
        state.loading = false;
        render();
        if (state.tab === 'pending') setBadge(state.items.length);
    }

    function setBadge(count) {
        document.querySelectorAll('[data-review-badge]').forEach(node => {
            node.textContent = String(count);
            node.hidden = count === 0;
        });
        if (els.subtitle) {
            els.subtitle.textContent = count > 0
                ? `${count} waiting for a decision. Nothing Claude proposes is permanent until someone accepts it.`
                : 'Everything Claude adds or changes waits here until someone on the team accepts it.';
        }
    }

    async function refreshBadge() {
        try {
            const result = await request(`${API}?action=summary`);
            setBadge((result.data && result.data.total) || 0);
        } catch (e) {
            // A missed badge refresh is not worth bothering anyone about.
        }
    }

    // ------------------------------------------------------------------
    // Deciding
    // ------------------------------------------------------------------

    function findItem(id) {
        return state.items.find(i => i.id === id) || panelItems.get(id) || null;
    }

    function readForm(form) {
        const values = {};
        form.querySelectorAll('[data-field]').forEach(input => {
            const field = input.dataset.field;
            if (input.type === 'checkbox') {
                values[field] = input.checked ? 1 : 0;
            } else if (NUMBER_FIELDS.includes(field)) {
                values[field] = input.value.trim() === '' ? null : Number(input.value);
            } else {
                values[field] = input.value.trim() === '' ? null : input.value.trim();
            }
        });
        return values;
    }

    async function putContact(id, values) {
        const current = (await request(`api/contacts.php?id=${id}`)).data || {};
        const merged = Object.assign({}, current, values);
        await request(`api/contacts.php?id=${id}`, {
            method: 'PUT',
            json: {
                payload: encodeUtf8Base64(JSON.stringify({
                    n: merged.name ?? '', c: merged.company ?? '', l: merged.location ?? '',
                    lat: merged.latitude ?? null, lng: merged.longitude ?? null, o: merged.note ?? '',
                    e: merged.email ?? '', p: merged.phone ?? '', w: merged.website ?? '', a: merged.address ?? ''
                }))
            }
        });
    }

    async function putProject(id, values) {
        const current = (await request(`api/projects.php?id=${id}`)).data || {};
        const merged = Object.assign({}, current, values);
        await request(`api/projects.php?id=${id}`, {
            method: 'PUT',
            json: {
                name: merged.name, start_date: merged.start_date, description: merged.description,
                company: merged.company, budget_min: merged.budget_min, budget_max: merged.budget_max,
                success_chance: merged.success_chance, stage: merged.stage,
                estimated_completion: merged.estimated_completion
            }
        });
    }

    async function putTodo(id, values) {
        await request(`api/todos.php?id=${id}`, { method: 'PUT', json: values });
    }

    /** Write edited values into a record Claude proposed (it stays pending). */
    async function saveProposedRecord(item, values) {
        const id = item.entity_id;
        switch (item.entity_type) {
            case 'contact': return putContact(id, values);
            case 'project': return putProject(id, values);
            case 'todo': return putTodo(id, values);
            case 'contact_note':
            case 'project_note':
                return request(`${API}?action=edit-note`, { method: 'POST', json: { entity_type: item.entity_type, entity_id: id, content: values.content } });
            default:
                throw new Error('This kind of proposal cannot be edited.');
        }
    }

    /** Apply a change to an existing record through the ordinary endpoints. */
    async function applyChange(item, values) {
        const id = item.entity_id;

        if (item.kind === 'update') {
            const changes = values || item.payload || {};
            if (item.entity_type === 'contact') return putContact(id, changes);
            if (item.entity_type === 'project') return putProject(id, changes);
            if (item.entity_type === 'todo') return putTodo(id, changes);
        }

        if (item.kind === 'delete') {
            const urls = {
                contact: `api/contacts.php?id=${id}`,
                project: `api/projects.php?id=${id}`,
                todo: `api/todos.php?id=${id}`,
                contact_note: `api/notes.php?id=${id}`,
                project_note: `api/projects.php?action=delete-note&id=${id}`
            };
            if (!urls[item.entity_type]) throw new Error('This record cannot be deleted from here.');
            return request(urls[item.entity_type], { method: 'DELETE' });
        }

        if (item.kind === 'assign') {
            return request('api/assign.php', {
                method: 'POST',
                json: { type: ASSIGN_TYPE[item.entity_type], id, assigned_to: (item.payload || {}).assigned_to ?? null }
            });
        }

        throw new Error('Unknown kind of change.');
    }

    function confirmText(item, action) {
        const name = titleFor(item) || item.entity_label || '';
        if (action === 'reject' && item.kind === 'create' && (item.entity_type === 'contact' || item.entity_type === 'project')) {
            return `Remove the proposed ${TYPE_LABEL[item.entity_type]} "${name}"? Anything added to it goes too.`;
        }
        if (action === 'accept' && item.kind === 'delete') {
            return `Delete the ${TYPE_LABEL[item.entity_type]} "${name}" for good?`;
        }
        return null;
    }

    async function decide(id, action, values = null) {
        const item = findItem(id);
        if (!item || state.busy.has(id)) return;

        const question = confirmText(item, action);
        if (question && !window.confirm(question)) return;

        state.busy.add(id);
        delete state.errors[id];
        rerenderRow(id);

        try {
            if (action === 'reject') {
                await request(`${API}?action=reject`, { method: 'POST', json: { id } });
            } else if (item.applied_by === 'client') {
                await applyChange(item, values);
                await request(`${API}?action=resolve`, { method: 'POST', json: { id } });
            } else {
                if (values && item.kind === 'create') {
                    await saveProposedRecord(item, values);
                }
                await request(`${API}?action=accept`, { method: 'POST', json: { id } });
            }

            state.busy.delete(id);
            state.editing.delete(id);
            state.open.delete(id);
            removeItem(id);
            toast(action === 'reject' ? 'Rejected' : 'Accepted');
            notifyChanged({ id, action, entity_type: item.entity_type, entity_id: item.entity_id });
        } catch (error) {
            state.busy.delete(id);
            state.errors[id] = error.message;
            rerenderRow(id);
        }
    }

    async function saveOnly(id, values) {
        const item = findItem(id);
        if (!item || state.busy.has(id)) return;

        state.busy.add(id);
        delete state.errors[id];
        try {
            await saveProposedRecord(item, values);
            state.busy.delete(id);
            state.editing.delete(id);
            toast('Saved - still waiting for a decision');
            await load();
            notifyChanged({ id, action: 'edit', entity_type: item.entity_type, entity_id: item.entity_id });
        } catch (error) {
            state.busy.delete(id);
            state.errors[id] = error.message;
            rerenderRow(id);
        }
    }

    function removeItem(id) {
        state.items = state.items.filter(i => i.id !== id);
        panelItems.delete(id);
        document.querySelectorAll(`.review-row[data-review-id="${id}"]`).forEach(node => {
            node.classList.add('is-leaving');
            setTimeout(() => {
                const group = node.closest('.review-group');
                const panel = node.closest('.review-record-slot');
                node.remove();
                if (group && !group.querySelector('.review-row')) group.remove();
                if (panel && !panel.querySelector('.review-row')) panel.hidden = true;
                if (els.list && state.tab === 'pending' && state.items.length === 0) render();
            }, 180);
        });
        if (state.tab === 'pending' && els.list) {
            els.list.querySelectorAll('.review-group').forEach(group => {
                const count = group.querySelectorAll('.review-row:not(.is-leaving)').length;
                const badge = group.querySelector('.review-group-count');
                if (badge) badge.textContent = String(count);
            });
        }
    }

    function openRecord(item) {
        // app.js exposes its openers as window.CRM.
        const crm = window.CRM || {};
        const r = item.record || {};
        switch (item.entity_type) {
            case 'contact': return crm.openOverview && crm.openOverview(item.entity_id);
            case 'project': return crm.openProjectOverview && crm.openProjectOverview(item.entity_id);
            case 'todo':
                if (r.contact_id && crm.openOverview) return crm.openOverview(r.contact_id);
                if (r.project_id && crm.openProjectOverview) return crm.openProjectOverview(r.project_id);
                return null;
            case 'contact_note': return r.contact_id && crm.openOverview && crm.openOverview(r.contact_id);
            case 'project_note': return r.project_id && crm.openProjectOverview && crm.openProjectOverview(r.project_id);
            case 'bookkeeping_pdf':
                if (r.row_id && crm.openBookkeepingRow) return crm.openBookkeepingRow(r.row_id);
                return crm.switchView && crm.switchView('bookkeeping');
            default: return null;
        }
    }

    // ------------------------------------------------------------------
    // Telling the rest of the app
    // ------------------------------------------------------------------

    function notifyChanged(detail) {
        refreshBadge();
        document.dispatchEvent(new CustomEvent('crm:review-changed', { detail }));
    }

    let toastTimer = null;
    function toast(message) {
        let node = document.getElementById('reviewToast');
        if (!node) {
            node = document.createElement('div');
            node.id = 'reviewToast';
            node.className = 'review-toast';
            node.setAttribute('role', 'status');
            document.body.appendChild(node);
        }
        node.textContent = message;
        node.classList.add('is-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2200);
    }

    // ------------------------------------------------------------------
    // Pieces other modules put on records
    // ------------------------------------------------------------------

    /** The mark on a proposed record in a list. */
    function badge(record) {
        if (!record || record.review_status !== 'pending') return '';
        return `<span class="review-badge" title="Proposed by Claude - not accepted yet">${ICON_SPARK}<span>Claude</span></span>`;
    }

    /** Accept / reject buttons for a proposed note, to-do or invoice, where it is listed. */
    function inlineActions(entityType, id) {
        return `
            <span class="review-inline" data-review-inline-type="${escapeHtml(entityType)}" data-review-inline-id="${Number(id)}">
                <button type="button" class="review-inline-btn review-inline-btn--accept" data-review-inline="accept" title="Accept Claude's proposal" aria-label="Accept Claude's proposal">${ICON_CHECK}</button>
                <button type="button" class="review-inline-btn review-inline-btn--reject" data-review-inline="reject" title="Reject Claude's proposal" aria-label="Reject Claude's proposal">${ICON_X}</button>
            </span>`;
    }

    const panelItems = new Map();

    /**
     * The open proposals about one contact or project, shown in its detail view.
     */
    async function renderRecordPanel(entityType, entityId, slot) {
        if (!slot) return;
        slot.hidden = true;
        slot.innerHTML = '';
        slot.dataset.entityType = entityType;
        slot.dataset.entityId = String(entityId);

        let items = [];
        try {
            const result = await request(`${API}?action=list&entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`);
            items = Array.isArray(result.data) ? result.data : [];
        } catch (e) {
            return;
        }

        // The detail view may have moved on to another record meanwhile.
        if (slot.dataset.entityType !== entityType || slot.dataset.entityId !== String(entityId) || items.length === 0) return;

        items.forEach(item => panelItems.set(item.id, item));
        const isNew = items.some(i => i.kind === 'create');
        slot.innerHTML = `
            <div class="review-panel">
                <div class="review-panel-head">
                    ${ICON_SPARK}
                    <span>${isNew ? `This ${TYPE_LABEL[entityType]} was proposed by Claude and is not accepted yet.` : `Claude proposes ${items.length === 1 ? 'a change' : items.length + ' changes'} here.`}</span>
                </div>
                ${listCard(items)}
            </div>`;
        slot.hidden = false;
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function bind() {
        els.list = document.getElementById('reviewList');
        els.subtitle = document.getElementById('reviewSubtitle');

        document.querySelectorAll('[data-review-tab]').forEach(btn => {
            btn.addEventListener('click', () => load(btn.dataset.reviewTab));
        });

        // One delegated handler for every row, wherever it is rendered.
        document.addEventListener('click', event => {
            const actBtn = event.target.closest('[data-review-act]');
            if (actBtn) {
                const row = actBtn.closest('.review-row');
                if (!row) return;
                const id = Number(row.dataset.reviewId);
                const act = actBtn.dataset.reviewAct;
                const item = findItem(id);
                if (!item) return;

                if (act === 'accept' || act === 'reject') {
                    event.preventDefault();
                    decide(id, act);
                } else if (act === 'toggle') {
                    if (state.open.has(id) || state.editing.has(id)) {
                        state.open.delete(id);
                        state.editing.delete(id);
                    } else {
                        state.open.add(id);
                    }
                    rerenderRow(id);
                } else if (act === 'edit') {
                    state.open.add(id);
                    state.editing.add(id);
                    rerenderRow(id);
                    const first = document.querySelector(`.review-row[data-review-id="${id}"] [data-field]`);
                    if (first) first.focus();
                } else if (act === 'cancel') {
                    state.editing.delete(id);
                    rerenderRow(id);
                } else if (act === 'save') {
                    event.preventDefault();
                    saveOnly(id, readForm(row.querySelector('[data-review-form]')));
                } else if (act === 'open') {
                    openRecord(item);
                }
                return;
            }

            const inlineBtn = event.target.closest('[data-review-inline]');
            if (inlineBtn) {
                // These sit inside clickable rows; the click is only this one.
                event.preventDefault();
                event.stopPropagation();
                const wrap = inlineBtn.closest('[data-review-inline-type]');
                decideInline(wrap.dataset.reviewInlineType, Number(wrap.dataset.reviewInlineId), inlineBtn.dataset.reviewInline, inlineBtn);
            }
        }, true);

        document.addEventListener('submit', event => {
            const form = event.target.closest('[data-review-form]');
            if (!form) return;
            event.preventDefault();
            const row = form.closest('.review-row');
            decide(Number(row.dataset.reviewId), 'accept', readForm(form));
        });

        refreshBadge();
        // Claude may propose things while the page is open; keep the badge honest.
        state.pollTimer = setInterval(() => {
            if (document.visibilityState === 'visible') refreshBadge();
        }, 90000);
    }

    async function decideInline(entityType, entityId, action, button) {
        const wrap = button.closest('.review-inline');
        if (wrap) wrap.classList.add('is-busy');
        try {
            await request(`${API}?action=${action === 'reject' ? 'reject' : 'accept'}`, {
                method: 'POST',
                json: { entity_type: entityType, entity_id: entityId }
            });
            toast(action === 'reject' ? 'Rejected' : 'Accepted');
            notifyChanged({ action, entity_type: entityType, entity_id: entityId });
        } catch (error) {
            if (wrap) wrap.classList.remove('is-busy');
            window.alert(error.message);
        }
    }

    window.CRMReview = {
        load,
        refreshBadge,
        renderRecordPanel,
        badge,
        inlineActions
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
