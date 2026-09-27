/**
 * From Claude
 *
 * Everything Claude writes through the MCP API is a proposal until a person
 * decides. This module is where that happens:
 *
 *   - the "From Claude" screen: one card per proposal, with Accept, Edit and
 *     Reject, and a history of what was decided and by whom;
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

    // ------------------------------------------------------------------
    // Describing a proposal
    // ------------------------------------------------------------------

    function kindTitle(item) {
        const noun = TYPE_LABEL[item.entity_type] || 'record';
        switch (item.kind) {
            case 'create': return 'New ' + noun;
            case 'update': return 'Change to ' + noun;
            case 'delete': return 'Delete ' + noun;
            case 'link': return 'Add contact to project';
            case 'unlink': return 'Remove contact from project';
            case 'tag': return 'Add tag';
            case 'untag': return 'Remove tag';
            case 'assign': return 'Assign ' + noun;
            default: return 'Proposal';
        }
    }

    function kindTone(item) {
        if (item.kind === 'create') return 'new';
        if (item.kind === 'delete' || item.kind === 'unlink' || item.kind === 'untag') return 'remove';
        return 'change';
    }

    function recordTitle(item) {
        const r = item.record || {};
        if (item.kind === 'create') {
            if (item.entity_type === 'contact' || item.entity_type === 'project') return r.name || item.entity_label;
            if (item.entity_type === 'todo') return r.title || item.entity_label;
            if (item.entity_type === 'bookkeeping_pdf') return r.original_name || item.entity_label;
        }
        return item.entity_label || '';
    }

    function recordSubtitle(item) {
        const r = item.record || {};
        if (item.kind !== 'create') return '';
        if (item.entity_type === 'contact' || item.entity_type === 'project') return r.company || '';
        if (item.entity_type === 'todo') return r.contact_name ? 'For ' + r.contact_name : (r.project_name ? 'For project ' + r.project_name : '');
        if (item.entity_type === 'contact_note') return r.contact_name ? 'On ' + r.contact_name : '';
        if (item.entity_type === 'project_note') return r.project_name ? 'On project ' + r.project_name : '';
        return '';
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

    function bodyFor(item) {
        const r = item.record || {};
        const p = item.payload || {};

        switch (item.kind) {
            case 'create':
                if (item.entity_type === 'contact') {
                    return factsList([
                        ['Email', r.email], ['Phone', r.phone], ['Location', r.location],
                        ['Website', r.website], ['Address', r.address, true], ['Note', r.note, true]
                    ]);
                }
                if (item.entity_type === 'project') {
                    const budget = [r.budget_min, r.budget_max].filter(v => !isEmpty(v)).map(v => Number(v).toLocaleString('de-AT') + ' €').join(' – ');
                    return factsList([
                        ['Stage', r.stage], ['Start', r.start_date], ['Planned finish', r.estimated_completion],
                        ['Budget', budget], ['Chance', isEmpty(r.success_chance) ? '' : r.success_chance + ' %'],
                        ['Description', r.description, true]
                    ]);
                }
                if (item.entity_type === 'todo') {
                    return factsList([
                        ['Due', r.due_date], ['Priority', displayValue('priority', r.priority) === '—' ? '' : displayValue('priority', r.priority)],
                        ['Description', r.description, true]
                    ]);
                }
                if (item.entity_type === 'contact_note' || item.entity_type === 'project_note') {
                    return `<p class="review-quote-text">${escapeHtml(r.content || p.content || '')}</p>`;
                }
                if (item.entity_type === 'bookkeeping_pdf') {
                    return `<p class="review-line">${formatBytes(r.file_size)} · in the bookkeeping drop zone · ${pdfLink(item.entity_id)}</p>
                        <p class="review-line review-muted">Accept keeps it there; filing it on its bank entry accepts it too.</p>`;
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
                            <td class="review-old">${escapeHtml(displayValue(field, was))}${stale ? `<span class="review-stale" title="Changed by someone since Claude proposed this">now: ${escapeHtml(displayValue(field, now))}</span>` : ''}</td>
                            <td class="review-arrow" aria-hidden="true">→</td>
                            <td class="review-new">${escapeHtml(displayValue(field, p[field]))}</td>
                        </tr>`;
                }).join('');
                return `<table class="review-diff"><tbody>${rows}</tbody></table>`;
            }

            case 'delete': {
                const snapshot = item.previous || {};
                const facts = factsList(Object.keys(snapshot).map(field => [FIELD_LABEL[field] || field, displayValue(field, snapshot[field]), LONG_FIELDS.includes(field)]));
                const goesWith = item.entity_type === 'contact' ? 'Its notes, to-dos, tags and project links go with it.'
                    : item.entity_type === 'project' ? 'Its notes, to-dos and tags go with it.' : '';
                return `${facts}<p class="review-warning">Accepting deletes it for good.${goesWith ? ' ' + goesWith : ''}</p>`;
            }

            case 'link':
            case 'unlink': {
                const contact = (item.related || {}).contact;
                const project = r.name || item.entity_label;
                const who = contact ? contact.name + (contact.company ? ' (' + contact.company + ')' : '') : 'a contact that no longer exists';
                return `<p class="review-line">${escapeHtml(who)} <span class="review-arrow">${item.kind === 'link' ? '→' : '↛'}</span> ${escapeHtml(project || '')}</p>`;
            }

            case 'tag':
            case 'untag':
                return `<p class="review-line"><span class="review-tag">${escapeHtml(p.tag_name || '')}</span> ${item.kind === 'tag' ? 'on' : 'off'} ${escapeHtml(r.name || '')}</p>`;

            case 'assign': {
                const before = (item.previous || {}).assigned_to_name || 'nobody';
                const after = p.assigned_to_name || 'nobody';
                return `<p class="review-line">${escapeHtml(before)} <span class="review-arrow">→</span> <strong>${escapeHtml(after)}</strong></p>`;
            }

            default:
                return '';
        }
    }

    function canEdit(item) {
        return (item.kind === 'create' && EDITABLE[item.entity_type]) || item.kind === 'update';
    }

    function canOpen(item) {
        return !!item.record && ['contact', 'project', 'todo', 'contact_note', 'project_note', 'bookkeeping_pdf'].includes(item.entity_type);
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

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
        const source = item.kind === 'create' ? (item.record || {}) : (item.payload || {});
        const primary = item.kind === 'create' ? 'Save & accept' : 'Apply & accept';

        return `
            <form class="review-edit" data-review-form>
                <div class="review-edit-grid">${fields.map(f => fieldInput(f, source[f])).join('')}</div>
                <div class="review-card-actions">
                    <button type="submit" class="btn btn-primary btn-small" data-review-act="save-accept">${primary}</button>
                    ${item.kind === 'create' ? '<button type="button" class="btn btn-secondary btn-small" data-review-act="save" title="Keep your edits, decide later">Save only</button>' : ''}
                    <button type="button" class="btn btn-secondary btn-small" data-review-act="cancel">Cancel</button>
                </div>
            </form>`;
    }

    const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
    const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
    const ICON_SPARK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z"/></svg>';

    function statusLine(item) {
        const who = item.resolved_by_name || 'someone';
        const when = fullDate(item.resolved_at);
        switch (item.status) {
            case 'accepted': return `<span class="review-status review-status--accepted">Accepted by ${escapeHtml(who)}</span><span class="review-when">${escapeHtml(when)}</span>`;
            case 'rejected': return `<span class="review-status review-status--rejected">Rejected by ${escapeHtml(who)}</span><span class="review-when">${escapeHtml(when)}</span>`;
            case 'withdrawn': return `<span class="review-status">Withdrawn by Claude</span><span class="review-when">${escapeHtml(when)}</span>`;
            case 'obsolete': return `<span class="review-status">No longer relevant - the record was removed</span><span class="review-when">${escapeHtml(when)}</span>`;
            default: return '';
        }
    }

    function renderCard(item, options = {}) {
        const compact = options.compact === true;
        const pending = item.status === 'pending';
        const busy = state.busy.has(item.id);
        const editing = pending && !compact && state.editing.has(item.id);
        const title = recordTitle(item);
        const sub = recordSubtitle(item);
        const error = state.errors[item.id];

        const actions = pending ? `
            <div class="review-card-actions">
                <button type="button" class="btn btn-primary btn-small" data-review-act="accept"${busy ? ' disabled' : ''}>${ICON_CHECK}<span>Accept</span></button>
                ${!compact && canEdit(item) ? `<button type="button" class="btn btn-secondary btn-small" data-review-act="edit"${busy ? ' disabled' : ''}>${ICON_EDIT}<span>Edit</span></button>` : ''}
                <button type="button" class="btn btn-secondary btn-small review-btn-reject" data-review-act="reject"${busy ? ' disabled' : ''}>${ICON_X}<span>Reject</span></button>
            </div>` : `<div class="review-card-status">${statusLine(item)}</div>`;

        const openLink = !compact && canOpen(item) && item.status !== 'obsolete'
            ? '<button type="button" class="review-open" data-review-act="open">Open</button>'
            : '';

        return `
            <article class="review-card review-card--${kindTone(item)}${compact ? ' review-card--compact' : ''}${busy ? ' is-busy' : ''}" data-review-id="${item.id}">
                <header class="review-card-head">
                    <span class="review-kind review-kind--${kindTone(item)}">${escapeHtml(kindTitle(item))}</span>
                    <span class="review-head-end">
                        ${openLink}
                        <span class="review-when" title="${escapeHtml(fullDate(item.created_at))}">${escapeHtml(timeAgo(item.created_at))}</span>
                    </span>
                </header>
                ${title && !compact ? `<h3 class="review-card-title">${escapeHtml(title)}</h3>` : ''}
                ${sub && !compact ? `<p class="review-card-sub">${escapeHtml(sub)}</p>` : ''}
                ${editing ? editForm(item) : `<div class="review-card-body">${bodyFor(item)}</div>`}
                ${item.comment ? `<p class="review-reason"><span class="review-reason-label">${ICON_SPARK} Claude's note</span>${escapeHtml(item.comment)}</p>` : ''}
                ${error ? `<p class="review-error" role="alert">${escapeHtml(error)}</p>` : ''}
                ${editing ? '' : actions}
            </article>`;
    }

    const GROUPS = [
        { key: 'new-contact', title: 'New contacts', match: i => i.kind === 'create' && i.entity_type === 'contact' },
        { key: 'new-project', title: 'New projects', match: i => i.kind === 'create' && i.entity_type === 'project' },
        { key: 'new-todo', title: 'New to-dos', match: i => i.kind === 'create' && i.entity_type === 'todo' },
        { key: 'new-note', title: 'New notes', match: i => i.kind === 'create' && (i.entity_type === 'contact_note' || i.entity_type === 'project_note') },
        { key: 'invoices', title: 'Invoices', match: i => i.entity_type === 'bookkeeping_pdf' },
        { key: 'changes', title: 'Changes to existing records', match: () => true }
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
            els.list.innerHTML = `<div class="review-group"><div class="review-cards">${state.items.map(i => renderCard(i)).join('')}</div></div>`;
            return;
        }

        const used = new Set();
        const html = GROUPS.map(group => {
            const items = state.items.filter(i => !used.has(i.id) && group.match(i));
            items.forEach(i => used.add(i.id));
            if (!items.length) return '';
            return `
                <section class="review-group" aria-label="${escapeHtml(group.title)}">
                    <h2 class="review-group-title">${escapeHtml(group.title)} <span class="review-group-count">${items.length}</span></h2>
                    <div class="review-cards">${items.map(i => renderCard(i)).join('')}</div>
                </section>`;
        }).join('');

        els.list.innerHTML = html;
    }

    function updateTabs() {
        document.querySelectorAll('[data-review-tab]').forEach(btn => {
            const active = btn.dataset.reviewTab === state.tab;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    function rerenderCard(id) {
        const item = findItem(id);
        if (!item) return;
        document.querySelectorAll(`.review-card[data-review-id="${id}"]`).forEach(node => {
            const compact = node.classList.contains('review-card--compact');
            node.outerHTML = renderCard(item, { compact });
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
        const name = recordTitle(item) || item.entity_label || '';
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
        rerenderCard(id);

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
            removeItem(id);
            toast(action === 'reject' ? 'Rejected' : 'Accepted');
            notifyChanged({ id, action, entity_type: item.entity_type, entity_id: item.entity_id });
        } catch (error) {
            state.busy.delete(id);
            state.errors[id] = error.message;
            rerenderCard(id);
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
            rerenderCard(id);
        }
    }

    function removeItem(id) {
        state.items = state.items.filter(i => i.id !== id);
        panelItems.delete(id);
        document.querySelectorAll(`.review-card[data-review-id="${id}"]`).forEach(node => {
            node.classList.add('is-leaving');
            setTimeout(() => {
                const group = node.closest('.review-group');
                node.remove();
                if (group && !group.querySelector('.review-card')) group.remove();
                if (els.list && state.tab === 'pending' && state.items.length === 0) render();
                document.querySelectorAll('.review-record-slot').forEach(slot => {
                    if (!slot.querySelector('.review-card')) slot.hidden = true;
                });
            }, 180);
        });
        if (state.tab === 'pending' && els.list) {
            els.list.querySelectorAll('.review-group').forEach(group => {
                const count = group.querySelectorAll('.review-card:not(.is-leaving)').length;
                const badge = group.querySelector('.review-group-count');
                if (badge) badge.textContent = String(count);
            });
        }
    }

    function openRecord(item) {
        // app.js exposes its openers as window.CRM.
        const crm = window.CRM || {};
        const app = {
            openContact: crm.openOverview,
            openProject: crm.openProjectOverview,
            openBookkeepingRow: crm.openBookkeepingRow,
            switchView: crm.switchView
        };
        const r = item.record || {};
        switch (item.entity_type) {
            case 'contact': return app.openContact && app.openContact(item.entity_id);
            case 'project': return app.openProject && app.openProject(item.entity_id);
            case 'todo':
                if (r.contact_id && app.openContact) return app.openContact(r.contact_id);
                if (r.project_id && app.openProject) return app.openProject(r.project_id);
                return null;
            case 'contact_note': return r.contact_id && app.openContact && app.openContact(r.contact_id);
            case 'project_note': return r.project_id && app.openProject && app.openProject(r.project_id);
            case 'bookkeeping_pdf':
                if (r.row_id && app.openBookkeepingRow) return app.openBookkeepingRow(r.row_id);
                return app.switchView && app.switchView('bookkeeping');
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
                ${items.map(i => renderCard(i, { compact: true })).join('')}
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

        // One delegated handler for every card, wherever it is rendered.
        document.addEventListener('click', event => {
            const actBtn = event.target.closest('[data-review-act]');
            if (actBtn) {
                const card = actBtn.closest('.review-card');
                if (!card) return;
                const id = Number(card.dataset.reviewId);
                const act = actBtn.dataset.reviewAct;
                const item = findItem(id);
                if (!item) return;

                if (act === 'accept' || act === 'reject') {
                    event.preventDefault();
                    decide(id, act);
                } else if (act === 'edit') {
                    state.editing.add(id);
                    rerenderCard(id);
                    const first = document.querySelector(`.review-card[data-review-id="${id}"] [data-field]`);
                    if (first) first.focus();
                } else if (act === 'cancel') {
                    state.editing.delete(id);
                    rerenderCard(id);
                } else if (act === 'save') {
                    event.preventDefault();
                    saveOnly(id, readForm(card.querySelector('[data-review-form]')));
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
            const card = form.closest('.review-card');
            decide(Number(card.dataset.reviewId), 'accept', readForm(form));
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
