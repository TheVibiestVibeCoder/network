/**
 * My Work
 *
 * One screen answering one question: what is on my plate? To-dos first, because
 * they are the things with deadlines, then bookkeeping rows still waiting on an
 * invoice, then the projects and contacts somebody made you responsible for.
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
        counts: {},   // assignee key -> { todos, projects, contacts, bookkeeping }
        loaded: false,
        doneOpen: false,  // whether the "Completed" fold is expanded
        busy: new Set()   // to-do ids with a check-off request in flight
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
            text: due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            overdue: false
        };
    }

    /**
     * A plain date, for things that have one without having a deadline.
     */
    function formatDate(value) {
        if (!value) return '';

        const date = new Date(value + 'T00:00:00');
        if (isNaN(date.getTime())) return String(value);

        return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function render() {
        if (!els.body || !state.data) return;

        const { todos, projects, contacts } = state.data;
        const bookkeeping = state.data.bookkeeping || [];
        const openTodos = todos.filter(t => Number(t.is_completed) === 0);
        const doneTodos = todos.filter(t => Number(t.is_completed) === 1);

        renderHead(openTodos.length, projects.length, contacts.length, bookkeeping.length);
        renderStats(openTodos, projects);

        if (openTodos.length === 0 && doneTodos.length === 0
            && projects.length === 0 && contacts.length === 0 && bookkeeping.length === 0) {
            els.body.innerHTML = emptyState();
            return;
        }

        let html = '';

        html += section('To-dos', openTodos.length, openTodos.map(todoRow).join(''),
            'Nothing open right now.');

        if (bookkeeping.length) {
            html += section('Bookkeeping', bookkeeping.length,
                bookkeeping.map(bookkeepingRow).join(''), '');
        }

        if (projects.length) {
            html += section('Projects', projects.length, projects.map(projectRow).join(''), '');
        }

        if (contacts.length) {
            html += section('Contacts', contacts.length, contacts.map(contactRow).join(''), '');
        }

        // Completed work is kept, but folded away - it is reference, not a task.
        if (doneTodos.length) {
            html += `
                <details class="workload-section workload-done"${state.doneOpen ? ' open' : ''}>
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

    /**
     * Four numbers across the top: what is open, what is late, what is due
     * this week, and how many projects are on this plate.
     *
     * Computed from the rows already loaded, so the tiles can never disagree
     * with the list underneath them.
     */
    function renderStats(openTodos, projects) {
        const stats = $('workloadStats');
        if (!stats) return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const weekEnd = new Date(today);
        weekEnd.setDate(weekEnd.getDate() + 7);

        let overdue = 0;
        let thisWeek = 0;
        openTodos.forEach(todo => {
            if (!todo.due_date) return;
            const due = new Date(todo.due_date + 'T00:00:00');
            if (isNaN(due.getTime())) return;
            if (due < today) overdue++;
            else if (due <= weekEnd) thisWeek++;
        });

        const tile = (value, label, alert) => `
            <div class="workload-stat">
                <span class="workload-stat-value${alert ? ' is-alert' : ''}">${value}</span>
                <span class="workload-stat-label">${escapeHtml(label)}</span>
            </div>
        `;

        stats.innerHTML =
            tile(openTodos.length, openTodos.length === 1 ? 'Open to-do' : 'Open to-dos', false) +
            tile(overdue, 'Overdue', overdue > 0) +
            tile(thisWeek, 'Due this week', false) +
            tile(projects.length, projects.length === 1 ? 'Project' : 'Projects', false);

        stats.hidden = false;
    }

    function renderHead(openCount, projectCount, contactCount, bookkeepingCount) {
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
        if (bookkeepingCount) bits.push(bookkeepingCount + (bookkeepingCount === 1 ? ' bookkeeping row' : ' bookkeeping rows'));
        if (projectCount) bits.push(projectCount + (projectCount === 1 ? ' project' : ' projects'));
        if (contactCount) bits.push(contactCount + (contactCount === 1 ? ' contact' : ' contacts'));

        // The tiles below carry the counts now, so the line under the name
        // orients instead: which day it is, or whose plate you are looking at.
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
        els.summary.textContent = person.unassigned
            ? 'Work nobody has picked up yet'
            : (isMe ? today : (bits.length ? bits.join(' · ') : 'Nothing assigned yet'));
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

        const title = escapeHtml(todo.title || '');
        // The control is a checkbox, so it is named after the to-do; the
        // tooltip is where the action goes.
        const checkName = title || 'To-do';
        const checkHint = done ? 'Mark as open' : 'Mark as done';
        const busy = state.busy.has(Number(todo.id));

        // Two controls, not one: the mark checks the to-do off, the rest of the
        // row still opens whatever the to-do hangs off.
        return `
            <div class="workload-row${done ? ' is-done' : ''}">
                <button type="button" class="workload-row-mark workload-check${done ? ' is-done' : ''}"
                        data-workload-toggle="${todo.id}" role="checkbox"
                        aria-checked="${done ? 'true' : 'false'}"
                        aria-label="${checkName}" title="${checkHint}"${busy ? ' disabled' : ''}>
                    ${done ? ICON_CHECK : `<span class="workload-check-hint">${ICON_CHECK}</span>`}
                </button>
                <button type="button" class="workload-row-main"
                        data-workload-open="todo" data-id="${todo.id}"
                        data-contact-id="${todo.contact_id || ''}" data-project-id="${todo.project_id || ''}">
                    <span class="workload-row-body">
                        <span class="workload-row-title">${title}</span>
                        ${context ? `<span class="workload-row-context">${context}</span>` : ''}
                    </span>
                    <span class="workload-row-meta">
                        ${priorityChip}
                        ${due.text ? `<span class="workload-due${due.overdue ? ' is-overdue' : ''}">${escapeHtml(due.text)}</span>` : ''}
                    </span>
                </button>
            </div>
        `;
    }

    /**
     * A bookkeeping row somebody has been handed: a bank entry still missing
     * its PDF. There is no tick box because there is nothing to tick -
     * attaching the invoice is what finishes it, and that happens in the
     * Bookkeeping tab, which is where the row leads.
     */
    function bookkeepingRow(entry) {
        // A bank entry's date is when the money moved, not a deadline, so it
        // is printed plainly rather than run through the "3 days overdue"
        // phrasing the to-dos use.
        const date = formatDate(entry.row_date);

        return `
            <button type="button" class="workload-row" data-workload-open="bookkeeping" data-id="${entry.id}">
                <span class="workload-row-mark is-icon">${ICON_RECEIPT}</span>
                <span class="workload-row-body">
                    <span class="workload-row-title">${escapeHtml(entry.summary || '')}</span>
                    <span class="workload-row-context">${entry.no_pdf_needed ? 'Marked as needing no PDF' : 'PDF missing'}</span>
                </span>
                <span class="workload-row-meta">
                    ${date ? `<span class="workload-due">${escapeHtml(date)}</span>` : ''}
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
    const ICON_RECEIPT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19.5 3.5 18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2v20l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5V2l-1.5 1.5zM17 19H7V5h10v14zM8 13h8v2H8v-2zm0-4h8v2H8V9z"/></svg>';
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

        const total = (bucket.todos || 0) + (bucket.projects || 0)
            + (bucket.contacts || 0) + (bucket.bookkeeping || 0);
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
    // Checking to-dos off
    // ------------------------------------------------------------------

    function showToast(message, isError) {
        const toast = $('bkToast');
        if (!toast) return;

        toast.textContent = message;
        toast.classList.toggle('bk-toast-error', !!isError);
        toast.classList.add('visible');
        clearTimeout(showToast._timer);
        showToast._timer = setTimeout(() => toast.classList.remove('visible'), 3000);
    }

    /**
     * Check a to-do off, or put it back.
     *
     * The row is moved the moment it is clicked, because waiting on the network
     * to see a tick appear feels broken; if the write fails the row moves back
     * and says so. Only master rows reach this view, so the id stays valid even
     * though the server rebuilds a project to-do's per-contact copies.
     */
    async function setCompletion(todoId, completed) {
        if (!state.data || state.busy.has(todoId)) return;

        const todo = state.data.todos.find(t => Number(t.id) === todoId);
        if (!todo) return;

        const previous = Number(todo.is_completed) === 1;
        if (previous === completed) return;

        // Re-rendering replaces the mark that was just clicked, so keyboard
        // users get their place back rather than being dropped to the top.
        const hadFocus = document.activeElement
            && document.activeElement.getAttribute
            && document.activeElement.getAttribute('data-workload-toggle') === String(todoId);

        const repaint = () => {
            render();
            if (!hadFocus) return;
            const mark = els.body.querySelector('[data-workload-toggle="' + todoId + '"]');
            if (mark && !mark.disabled) mark.focus();
        };

        todo.is_completed = completed ? 1 : 0;
        // A to-do checked off disappears into the fold, so open it: the row
        // should still be somewhere the person can see, and undo.
        if (completed) state.doneOpen = true;
        state.busy.add(todoId);
        repaint();

        let error = null;
        try {
            const response = await fetch('api/todos.php?id=' + encodeURIComponent(todoId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ is_completed: completed ? 1 : 0 })
            });

            const text = await response.text();
            let payload;
            try {
                payload = text ? JSON.parse(text) : {};
            } catch (e) {
                payload = {};
            }

            if (!response.ok || !payload.success) {
                error = payload.error || 'Could not update this to-do.';
            }
        } catch (e) {
            error = 'Could not reach the server.';
        }

        state.busy.delete(todoId);

        if (error) {
            todo.is_completed = previous ? 1 : 0;
            repaint();
            showToast(error, true);
            return;
        }

        repaint();

        // The nav badge and the per-person counts both count open to-dos.
        refreshBadge();
        loadCounts().then(populateSwitcher);
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
        // The count appears on the sidebar entry and on the phone tab bar.
        const badges = document.querySelectorAll('[data-workload-badge]');
        if (!badges.length) return;

        const paint = (text, hidden) => badges.forEach(badge => {
            badge.textContent = text;
            badge.hidden = hidden;
        });

        try {
            const result = await api('?action=workload&user=me');
            const counts = result.counts || {};
            const open = (counts.todos_open || 0) + (counts.bookkeeping || 0);

            paint(open > 99 ? '99+' : String(open), open === 0);
        } catch (e) {
            paint('0', true);
        }
    }

    // ------------------------------------------------------------------
    // The team, in the sidebar
    // ------------------------------------------------------------------

    /**
     * List everyone in the sidebar, each one click from their workload.
     *
     * The same people the "Showing" switch offers, surfaced where they are
     * always visible - so "what is Anna working on?" is one click, not a
     * dropdown hunt. Hidden entirely until there is somebody besides you.
     */
    function renderTeam() {
        const wrap = $('sidebarTeamWrap');
        const list = $('sidebarTeam');
        if (!wrap || !list || !window.CRMPeople) return;

        const people = window.CRMPeople.list();
        const meKey = window.CRMPeople.meKey();
        const others = people.filter(person => {
            const key = person.id === null ? 'owner' : String(person.id);
            return key !== meKey;
        });

        if (!others.length) {
            wrap.hidden = true;
            return;
        }

        list.innerHTML = others.map(person => {
            const key = person.id === null ? 'owner' : String(person.id);
            const face = person.avatar_url
                ? `<span class="team-face has-photo"><img src="${escapeHtml(person.avatar_url)}" alt=""></span>`
                : `<span class="team-face">${escapeHtml(getInitials(person.name))}</span>`;

            return `
                <button type="button" class="team-item" data-team-person="${escapeHtml(key)}" title="Open ${escapeHtml(person.name)}'s work">
                    ${face}
                    <span class="team-name">${escapeHtml(person.name)}</span>
                    ${countBadge(key)}
                </button>
            `;
        }).join('');

        wrap.hidden = false;
    }

    /**
     * A small count of open items for one person, or nothing.
     */
    function countBadge(key) {
        const bucket = state.counts[key === 'owner' ? '0' : key];
        if (!bucket) return '';

        const total = (bucket.todos || 0) + (bucket.projects || 0)
            + (bucket.contacts || 0) + (bucket.bookkeeping || 0);

        return total ? `<span class="team-count">${total}</span>` : '';
    }

    async function refreshTeam() {
        await loadCounts();
        renderTeam();
    }

    /**
     * Open one teammate's workload from the sidebar.
     */
    function openPerson(key) {
        if (window.CRM && window.CRM.switchView) {
            window.CRM.switchView('workload');
        }
        load(key);
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

        els.who.addEventListener('change', () => load(els.who.value));

        const team = $('sidebarTeam');
        if (team) {
            team.addEventListener('click', (event) => {
                const item = event.target.closest('[data-team-person]');
                if (item) openPerson(item.getAttribute('data-team-person'));
            });
        }

        // profile.js announces whenever it has (re)loaded the directory, which
        // is when names and faces for the team list are known.
        window.addEventListener('crm:people', refreshTeam);
        if (window.CRMPeople && window.CRMPeople.ready()) {
            refreshTeam();
        }

        // Checking a to-do off, before the rule that opens records: the mark
        // sits inside a row, and clicking it means only this.
        els.body.addEventListener('click', function (event) {
            const check = event.target.closest('[data-workload-toggle]');
            if (!check) return;

            event.stopPropagation();
            const todoId = Number(check.getAttribute('data-workload-toggle'));
            if (todoId) setCompletion(todoId, check.getAttribute('aria-checked') !== 'true');
        });

        // Remember whether "Completed" is folded open, so a re-render does not
        // slam it shut under someone reading it. Toggle does not bubble.
        els.body.addEventListener('toggle', function (event) {
            const details = event.target;
            if (details && details.classList && details.classList.contains('workload-done')) {
                state.doneOpen = details.open;
            }
        }, true);

        // Rows open the record they stand for, using the handles app.js exposes.
        els.body.addEventListener('click', function (event) {
            if (event.target.closest('[data-workload-toggle]')) return;

            const row = event.target.closest('[data-workload-open]');
            if (!row) return;

            const kind = row.getAttribute('data-workload-open');
            const id = Number(row.getAttribute('data-id'));
            if (!window.CRM || !id) return;

            if (kind === 'contact') {
                window.CRM.openOverview(id);
            } else if (kind === 'project') {
                window.CRM.openProjectOverview(id);
            } else if (kind === 'bookkeeping') {
                window.CRM.openBookkeepingRow(id);
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
