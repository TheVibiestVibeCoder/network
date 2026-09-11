/**
 * My Work
 *
 * One screen answering one question: what is on my plate? To-dos first, because
 * they are the things with deadlines, then the projects and contacts somebody
 * made you responsible for.
 *
 * It defaults to the signed-in user and can be pointed at any colleague, or at
 * "Unassigned" to see what nobody has picked up. It is a different arrangement
 * of records everyone can already read, not a new level of access.
 */
(function () {
    'use strict';

    const API = 'api/assign.php';

    const state = {
        who: 'me',
        data: null,
        person: null,
        counts: {},   // assignee key -> { todos, projects, contacts }
        loaded: false
    };

    const els = {};
    let initialized = false;

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

    /**
     * Escapes for text nodes and quoted attribute values alike - names, company
     * names and to-do titles all land in title="..." here.
     */
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
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

    async function api(path) {
        const response = await fetch(API + path, {
            headers: { 'X-CSRF-Token': getCsrfToken() }
        });
        const text = await response.text();

        let payload;
        try {
            payload = text ? JSON.parse(text) : {};
        } catch (e) {
            throw new Error('The server returned an unexpected response.');
        }

        if (!response.ok || payload.error) {
            throw new Error(payload.error || 'Could not load this view.');
        }

        return payload;
    }

    /**
     * Due dates, phrased the way a person would say them.
     */
    function describeDue(value) {
        if (!value) return { text: '', overdue: false };

        const due = new Date(value + 'T00:00:00');
        if (isNaN(due.getTime())) return { text: '', overdue: false };

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const days = Math.round((due - today) / 86400000);

        if (days < 0) return { text: days === -1 ? 'Yesterday' : `${Math.abs(days)} days overdue`, overdue: true };
        if (days === 0) return { text: 'Today', overdue: false };
        if (days === 1) return { text: 'Tomorrow', overdue: false };
        if (days <= 7) return { text: `In ${days} days`, overdue: false };

        return {
            text: due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
            overdue: false
        };
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function render() {
        if (!els.body || !state.data) return;

        const { todos, projects, contacts } = state.data;
        const openTodos = todos.filter(t => Number(t.is_completed) === 0);
        const doneTodos = todos.filter(t => Number(t.is_completed) === 1);

        renderHead(openTodos.length, projects.length, contacts.length);

        if (openTodos.length === 0 && doneTodos.length === 0
            && projects.length === 0 && contacts.length === 0) {
            els.body.innerHTML = emptyState();
            return;
        }

        let html = '';

        html += section('To-dos', openTodos.length, openTodos.map(todoRow).join(''),
            'Nothing open right now.');

        if (projects.length) {
            html += section('Projects', projects.length, projects.map(projectRow).join(''), '');
        }

        if (contacts.length) {
            html += section('Contacts', contacts.length, contacts.map(contactRow).join(''), '');
        }

        // Completed work is kept, but folded away - it is reference, not a task.
        if (doneTodos.length) {
            html += `
                <details class="workload-section workload-done">
                    <summary class="workload-section-head">
                        <span class="workload-section-title">Completed</span>
                        <span class="workload-count">${doneTodos.length}</span>
                    </summary>
                    <div class="workload-list">${doneTodos.map(todoRow).join('')}</div>
                </details>
            `;
        }

        els.body.innerHTML = html;
    }

    function renderHead(openCount, projectCount, contactCount) {
        const person = state.person || {};
        const isMe = state.who === 'me';
        const name = person.unassigned ? 'Unassigned' : (person.name || '');

        els.title.textContent = person.unassigned
            ? 'Unassigned'
            : (isMe ? 'My Work' : name);

        // The face is meaningless for the unassigned bucket.
        if (person.unassigned) {
            els.face.className = 'workload-person-face is-empty';
            els.face.innerHTML = ICON_INBOX;
        } else {
            const key = person.id === null || person.id === undefined
                ? ''
                : (Number(person.id) === 0 ? 'owner' : String(person.id));
            const url = window.CRMPeople ? window.CRMPeople.avatarFor(key, name) : null;

            if (url) {
                els.face.className = 'workload-person-face has-photo';
                els.face.innerHTML = '';
                const img = document.createElement('img');
                img.src = url;
                img.alt = '';
                els.face.appendChild(img);
            } else {
                els.face.className = 'workload-person-face';
                els.face.textContent = getInitials(name);
            }
        }

        const bits = [];
        if (openCount) bits.push(openCount + (openCount === 1 ? ' open to-do' : ' open to-dos'));
        if (projectCount) bits.push(projectCount + (projectCount === 1 ? ' project' : ' projects'));
        if (contactCount) bits.push(contactCount + (contactCount === 1 ? ' contact' : ' contacts'));

        els.summary.textContent = bits.length ? bits.join(' · ') : 'Nothing assigned yet';
    }

    function section(title, count, rows, emptyText) {
        const body = rows || `<p class="workload-empty-line">${escapeHtml(emptyText)}</p>`;

        return `
            <section class="workload-section">
                <div class="workload-section-head">
                    <span class="workload-section-title">${escapeHtml(title)}</span>
                    <span class="workload-count">${count}</span>
                </div>
                <div class="workload-list">${body}</div>
            </section>
        `;
    }

    function todoRow(todo) {
        const done = Number(todo.is_completed) === 1;
        const due = describeDue(todo.due_date);

        const context = todo.project_name
            ? escapeHtml(todo.project_name)
            : (todo.contact_name ? escapeHtml(todo.contact_name) : '');

        const priority = (todo.priority || '').toLowerCase();
        const priorityChip = ['high', 'medium', 'low'].includes(priority)
            ? `<span class="workload-chip workload-chip--${priority}">${priority}</span>`
            : '';

        return `
            <button type="button" class="workload-row${done ? ' is-done' : ''}"
                    data-workload-open="todo" data-id="${todo.id}"
                    data-contact-id="${todo.contact_id || ''}" data-project-id="${todo.project_id || ''}">
                <span class="workload-row-mark${done ? ' is-done' : ''}">${done ? ICON_CHECK : ''}</span>
                <span class="workload-row-body">
                    <span class="workload-row-title">${escapeHtml(todo.title || '')}</span>
                    ${context ? `<span class="workload-row-context">${context}</span>` : ''}
                </span>
                <span class="workload-row-meta">
                    ${priorityChip}
                    ${due.text ? `<span class="workload-due${due.overdue ? ' is-overdue' : ''}">${escapeHtml(due.text)}</span>` : ''}
                </span>
            </button>
        `;
    }

    function projectRow(project) {
        const stage = project.stage || 'Lead';
        const stageClass = String(stage).toLowerCase().replace(/ /g, '-');

        return `
            <button type="button" class="workload-row" data-workload-open="project" data-id="${project.id}">
                <span class="workload-row-mark is-icon">${ICON_PROJECT}</span>
                <span class="workload-row-body">
                    <span class="workload-row-title">${escapeHtml(project.name || '')}</span>
                    ${project.company ? `<span class="workload-row-context">${escapeHtml(project.company)}</span>` : ''}
                </span>
                <span class="workload-row-meta">
                    <span class="project-stage-badge stage-${escapeHtml(stageClass)}">${escapeHtml(stage)}</span>
                </span>
            </button>
        `;
    }

    function contactRow(contact) {
        const sub = contact.company || contact.location || contact.email || '';

        return `
            <button type="button" class="workload-row" data-workload-open="contact" data-id="${contact.id}">
                <span class="workload-row-mark is-initials">${escapeHtml(getInitials(contact.name))}</span>
                <span class="workload-row-body">
                    <span class="workload-row-title">${escapeHtml(contact.name || '')}</span>
                    ${sub ? `<span class="workload-row-context">${escapeHtml(sub)}</span>` : ''}
                </span>
                <span class="workload-row-meta"></span>
            </button>
        `;
    }

    function emptyState() {
        const person = state.person || {};
        const who = person.unassigned
            ? 'Nothing is waiting to be picked up.'
            : (state.who === 'me'
                ? 'Nothing is assigned to you yet.'
                : 'Nothing is assigned to ' + escapeHtml(person.name || 'them') + ' yet.');

        return `
            <div class="workload-empty">
                <div class="workload-empty-icon">${ICON_INBOX}</div>
                <p class="workload-empty-title">All clear</p>
                <p class="workload-empty-text">${who}</p>
                <p class="workload-empty-hint">
                    Open any contact, project or to-do and pick someone under &ldquo;Assigned to&rdquo;.
                </p>
            </div>
        `;
    }

    const ICON_CHECK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    const ICON_PROJECT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg>';
    const ICON_INBOX = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H4.99V5H19v10z"/></svg>';

    // ------------------------------------------------------------------
    // The person switcher
    // ------------------------------------------------------------------

    function populateSwitcher() {
        if (!els.who) return;

        const people = window.CRMPeople ? window.CRMPeople.list() : [];
        const meKey = window.CRMPeople ? window.CRMPeople.meKey() : null;

        let html = `<option value="me">Me${countSuffix(meKey)}</option>`;

        people.forEach(person => {
            const key = person.id === null ? 'owner' : String(person.id);
            // "Me" already covers the signed-in identity; listing it twice
            // would just be a way to pick the same thing by another name.
            if (meKey && key === meKey) return;
            html += `<option value="${escapeHtml(key)}">${escapeHtml(person.name)}${countSuffix(key)}</option>`;
        });

        html += '<option value="unassigned">Unassigned</option>';

        els.who.innerHTML = html;
        els.who.value = state.who;
    }

    /**
     * " (3)" for somebody carrying three open items, or nothing at all.
     *
     * The owner is keyed 0 in the database but addressed as 'owner' here, so
     * the lookup translates before reading the bucket.
     */
    function countSuffix(key) {
        if (!key) return '';

        const bucket = state.counts[key === 'owner' ? '0' : key];
        if (!bucket) return '';

        const total = (bucket.todos || 0) + (bucket.projects || 0) + (bucket.contacts || 0);
        return total ? ` (${total})` : '';
    }

    async function loadCounts() {
        try {
            const result = await api('?action=summary');
            state.counts = result.counts || {};
        } catch (e) {
            state.counts = {};
        }
    }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    async function load(who) {
        if (who) state.who = who;

        // No-op once it has run; here for the case where this is the first
        // view shown and app.js asks for it before this file has initialized.
        init();
        if (!els.body) return;

        els.body.innerHTML = '<div class="workload-loading">Loading...</div>';

        try {
            // The directory drives both the switcher and the faces, so make
            // sure it has arrived before drawing either.
            if (window.CRMPeople && !window.CRMPeople.ready()) {
                await window.CRMPeople.reload();
            }
            await loadCounts();
            populateSwitcher();

            const result = await api('?action=workload&user=' + encodeURIComponent(state.who));
            state.data = result.data;
            state.person = result.person;
            state.loaded = true;

            render();
        } catch (error) {
            els.body.innerHTML = `<div class="workload-empty"><p class="workload-empty-text">${escapeHtml(error.message)}</p></div>`;
        }
    }

    /**
     * Keep the badge on the nav button current: it is the number of open to-dos
     * assigned to you, which is the one count worth interrupting someone for.
     */
    async function refreshBadge() {
        if (!els.badge) return;

        try {
            const result = await api('?action=workload&user=me');
            const open = result.counts ? result.counts.todos_open : 0;

            els.badge.textContent = open > 99 ? '99+' : String(open);
            els.badge.hidden = open === 0;
        } catch (e) {
            els.badge.hidden = true;
        }
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function init() {
        // Guarded so it can be called from load() as well as on DOMContentLoaded.
        // app.js opens the starting view from its own DOMContentLoaded handler,
        // which is registered first and therefore runs before this file's - so
        // load() can arrive before the elements below have been looked up, and
        // the listeners here must not be attached twice when it does.
        if (initialized) return;

        els.body = $('workloadBody');
        if (!els.body) return;

        initialized = true;

        els.title = $('workloadTitle');
        els.summary = $('workloadSummary');
        els.face = $('workloadFace');
        els.who = $('workloadWho');
        els.badge = $('workloadBadge');

        els.who.addEventListener('change', () => load(els.who.value));

        // Rows open the record they stand for, using the handles app.js exposes.
        els.body.addEventListener('click', function (event) {
            const row = event.target.closest('[data-workload-open]');
            if (!row) return;

            const kind = row.getAttribute('data-workload-open');
            const id = Number(row.getAttribute('data-id'));
            if (!window.CRM || !id) return;

            if (kind === 'contact') {
                window.CRM.openOverview(id);
            } else if (kind === 'project') {
                window.CRM.openProjectOverview(id);
            } else if (kind === 'todo') {
                // A to-do has no page of its own, so open whatever it hangs off.
                const projectId = Number(row.getAttribute('data-project-id'));
                const contactId = Number(row.getAttribute('data-contact-id'));
                if (projectId) {
                    window.CRM.openProjectOverview(projectId);
                } else if (contactId) {
                    window.CRM.openOverview(contactId);
                }
            }
        });

        refreshBadge();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.CRMWorkload = {
        load: load,
        refreshBadge: refreshBadge
    };
})();
