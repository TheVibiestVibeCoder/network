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
        // Set by openPerson() just before it switches to this tab, so the
        // switch opens that person instead of resetting to "me".
        nextWho: null,
        data: null,
        person: null,
        counts: {},   // assignee key -> { todos, projects, contacts, bookkeeping }
        loaded: false,
        doneOpen: false,  // whether the "Completed" fold is expanded
        news: null,       // "New for you": { items, total }, only on your own home
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

        const news = newsBox();

        if (openTodos.length === 0 && doneTodos.length === 0
            && projects.length === 0 && contacts.length === 0 && bookkeeping.length === 0) {
            els.body.innerHTML = news + emptyState();
            return;
        }

        // Two columns: the to-dos - the work itself - take the wide one;
        // what you look after (bookkeeping, projects, contacts) sits beside
        // them in a narrow one. One column on smaller screens.
        let main = section('todo', 'To-dos', openTodos.length, todoGroups(openTodos),
            'Nothing open right now.');

        // Completed work is kept, but folded away - it is reference, not a task.
        if (doneTodos.length) {
            main += `
                <details class="workload-section workload-done"${state.doneOpen ? ' open' : ''}>
                    <summary class="workload-section-head">
                        <span class="workload-section-title">Completed</span>
                        <span class="workload-count">${doneTodos.length}</span>
                    </summary>
                    <div class="workload-list">${doneTodos.map(todoRow).join('')}</div>
                </details>
            `;
        }

        let side = '';
        if (bookkeeping.length) {
            side += section('bookkeeping', 'Bookkeeping', bookkeeping.length,
                bookkeeping.map(bookkeepingRow).join(''), '');
        }
        if (projects.length) {
            side += section('project', 'Projects', projects.length, projects.map(projectRow).join(''), '');
        }
        if (contacts.length) {
            side += section('contact', 'Contacts', contacts.length, contacts.map(contactRow).join(''), '');
        }

        let html = news;
        html += side
            ? `<div class="workload-grid"><div class="workload-main">${main}</div><div class="workload-side">${side}</div></div>`
            : `<div class="workload-grid is-single"><div class="workload-main">${main}</div></div>`;

        els.body.innerHTML = html;
    }

    // Chart order and tone for stages and priorities - the same colours the
    // lists below use for their dots.
    const STAGE_TONES = [
        ['In Progress', 'progress'],
        ['Proposal', 'proposal'],
        ['Negotiation', 'negotiation'],
        ['Lead', 'lead'],
        ['Complete', 'complete']
    ];

    const PRIORITY_TONES = [
        ['high', 'High'],
        ['medium', 'Medium'],
        ['low', 'Low'],
        ['none', 'No priority']
    ];

    /**
     * Three cards across the top: what is due this week (and what is late),
     * how many to-dos are open, and how many projects - each with one line of
     * detail. Computed from the rows already loaded, so the cards can never
     * disagree with the lists underneath. A card jumps to its list.
     */
    function renderStats(openTodos, projects) {
        const stats = $('workloadStats');
        if (!stats) return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let dueThisWeek = 0;
        let overdue = 0;
        // Today and the six days after it: the to-dos due on each.
        const days = Array.from({ length: 7 }, () => []);
        const priorities = { high: 0, medium: 0, low: 0 };

        openTodos.forEach(todo => {
            const priority = (todo.priority || '').toLowerCase();
            if (priority in priorities) priorities[priority]++;

            if (!todo.due_date) return;
            const due = new Date(todo.due_date + 'T00:00:00');
            if (isNaN(due.getTime())) return;

            // Rounded, so a daylight-saving day still counts as one day.
            const offset = Math.round((due - today) / 86400000);
            if (offset < 0) overdue++;
            else if (offset < 7) {
                dueThisWeek++;
                days[offset].push(todo.title || 'To-do');
            }
        });

        priorities.none = openTodos.length - priorities.high - priorities.medium - priorities.low;

        const dot = (tone, text) => `<span class="home-stat-dot" data-tone="${tone}">${escapeHtml(text)}</span>`;

        /**
         * A thin bar split into its parts, with the legend under it - the
         * same height as the week strip, so the three columns line up.
         */
        const bar = (parts, emptyText) => {
            const total = parts.reduce((sum, part) => sum + part.value, 0);
            if (total === 0) {
                return `<span class="home-bar is-empty"><span class="home-bar-track"></span><span class="home-bar-legend"><span>${escapeHtml(emptyText)}</span></span></span>`;
            }
            const segments = parts.map(part =>
                `<span class="home-bar-part" data-tone="${part.tone}" style="flex-grow:${part.value}" title="${escapeHtml(part.label)}: ${part.value}"></span>`
            ).join('');
            const legend = parts.map(part => dot(part.tone, `${part.value} ${part.label.toLowerCase()}`)).join('');
            return `<span class="home-bar"><span class="home-bar-track">${segments}</span><span class="home-bar-legend">${legend}</span></span>`;
        };

        // 1 - Due this week; what is already late sits beside the number.
        const overdueFlag = overdue > 0
            ? `<span class="home-stat-flag">${overdue} overdue</span>`
            : '';

        // 2 - Open to-dos, by priority.
        const priorityBar = bar(
            PRIORITY_TONES
                .filter(([key]) => priorities[key] > 0)
                .map(([key, name]) => ({ tone: key, value: priorities[key], label: key === 'none' ? 'No priority' : name })),
            'Nothing open'
        );

        // 3 - Projects, by stage.
        const stageCounts = {};
        projects.forEach(project => {
            const stage = STAGE_TONES.some(([name]) => name === project.stage) ? project.stage : 'Lead';
            stageCounts[stage] = (stageCounts[stage] || 0) + 1;
        });
        const stageBar = bar(
            STAGE_TONES
                .filter(([name]) => stageCounts[name] > 0)
                .map(([name, tone]) => ({ tone, value: stageCounts[name], label: name })),
            'None assigned'
        );

        // The week, day by day: which days have something due, and how much.
        const week = days.map((titles, i) => {
            const date = new Date(today);
            date.setDate(date.getDate() + i);
            const name = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const tip = titles.length
                ? `${i === 0 ? 'Today' : name}: ${titles.join(', ')}`
                : `${i === 0 ? 'Today' : name}: nothing due`;

            return `
                <span class="home-day${i === 0 ? ' is-today' : ''}${titles.length ? ' has-due' : ''}" title="${escapeHtml(tip)}">
                    <span class="home-day-name">${escapeHtml(i === 0 ? 'Today' : date.toLocaleDateString('en-US', { weekday: 'short' }))}</span>
                    <span class="home-day-count">${titles.length || ''}</span>
                </span>`;
        }).join('');

        // Every column the same three rows: label, number, and a picture of
        // equal height at the bottom.
        const card = (type, target, label, value, flag, visual) => `
            <button type="button" class="home-stat is-${type}" data-workload-jump="${target}">
                <span class="home-stat-label">${escapeHtml(label)}</span>
                <span class="home-stat-figure">
                    <span class="home-stat-value">${value}</span>${flag}
                </span>
                <span class="home-stat-visual">${visual}</span>
            </button>`;

        stats.innerHTML =
            card('due', 'todo', 'Due this week', dueThisWeek, overdueFlag,
                `<span class="home-week" aria-label="Due per day">${week}</span>`)
            + card('todo', 'todo', openTodos.length === 1 ? 'Open to-do' : 'Open to-dos', openTodos.length, '', priorityBar)
            + card('project', 'project', projects.length === 1 ? 'Project' : 'Projects', projects.length, '', stageBar);
        stats.hidden = false;
    }

    function renderHead(openCount, projectCount, contactCount, bookkeepingCount) {
        const person = state.person || {};
        const isMe = state.who === 'me';
        const name = person.unassigned ? 'Unassigned' : (person.name || '');

        // Your own page greets you; anyone else's is titled with their name.
        const hour = new Date().getHours();
        const greeting = hour < 12 ? 'Good morning' : (hour < 18 ? 'Good afternoon' : 'Good evening');
        const firstName = String(name).trim().split(/\s+/)[0] || '';
        els.title.textContent = person.unassigned
            ? 'Unassigned'
            : (isMe ? (firstName ? `${greeting}, ${firstName}` : greeting) : name);

        const head = els.face ? els.face.closest('.workload-head') : null;
        if (head) head.classList.toggle('is-me', isMe && !person.unassigned);

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

    /**
     * A section of the home page. Each kind of thing has its own colour and
     * icon (--wl-type in design.css), on the heading and on every row's
     * mark, so to-dos, projects, contacts and bookkeeping tell apart at a glance.
     */
    function section(type, title, count, rows, emptyText) {
        const body = rows || `<p class="workload-empty-line">${escapeHtml(emptyText)}</p>`;

        return `
            <section class="workload-section is-${type}">
                <div class="workload-section-head">
                    <span class="workload-section-icon" aria-hidden="true">${TYPE_ICONS[type] || ''}</span>
                    <span class="workload-section-title">${escapeHtml(title)}</span>
                    <span class="workload-count">${count}</span>
                </div>
                <div class="workload-list">${body}</div>
            </section>
        `;
    }

    /**
     * Open to-dos in one list, split by when they are due - what is late
     * first - so the list reads top-down as "what now".
     */
    function todoGroups(openTodos) {
        if (openTodos.length === 0) return '';

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const groups = [
            { key: 'overdue', label: 'Overdue', items: [] },
            { key: 'week', label: 'This week', items: [] },
            { key: 'later', label: 'Later', items: [] },
            { key: 'none', label: 'No due date', items: [] }
        ];

        openTodos.forEach(todo => {
            const due = todo.due_date ? new Date(todo.due_date + 'T00:00:00') : null;
            if (!due || isNaN(due.getTime())) {
                groups[3].items.push(todo);
                return;
            }
            const offset = Math.round((due - today) / 86400000);
            groups[offset < 0 ? 0 : (offset < 7 ? 1 : 2)].items.push(todo);
        });

        const used = groups.filter(group => group.items.length);
        // One group needs no label: "This week" over every row says nothing.
        if (used.length === 1 && used[0].key !== 'overdue') {
            return used[0].items.map(todoRow).join('');
        }

        return used.map(group => `
            <div class="workload-group-label is-${group.key}">
                <span>${group.label}</span><span class="workload-group-count">${group.items.length}</span>
            </div>
            ${group.items.map(todoRow).join('')}
        `).join('');
    }

    // ------------------------------------------------------------------
    // New for you
    // ------------------------------------------------------------------

    const NEWS_LABELS = { todo: 'To-do', project: 'Project', contact: 'Contact', bookkeeping: 'Bookkeeping' };

    function isNew(type, id) {
        const items = state.news && state.news.items;
        return !!items && items.some(item => item.type === type && item.id === Number(id));
    }

    function newTag(type, id) {
        return isNew(type, id) ? '<span class="workload-new">New</span>' : '';
    }

    /**
     * What has been assigned to you since you last looked: a box above the
     * lists, each entry one click from its record. "Got it" clears it.
     */
    function newsBox() {
        const news = state.news;
        if (!news || !news.items || news.items.length === 0) return '';

        const rows = news.items.map(item => {
            const by = item.assigned_by_name ? `from ${escapeHtml(item.assigned_by_name)}` : '';
            const when = describeWhen(item.assigned_at);
            const meta = [escapeHtml(NEWS_LABELS[item.type] || ''), item.context ? escapeHtml(item.context) : '', by, when]
                .filter(Boolean).join(' · ');

            return `
                <button type="button" class="workload-news-item" data-workload-open="${escapeHtml(item.type)}" data-id="${item.id}">
                    <span class="workload-news-dot" aria-hidden="true"></span>
                    <span class="workload-news-body">
                        <span class="workload-news-title">${escapeHtml(item.title)}</span>
                        <span class="workload-news-meta">${meta}</span>
                    </span>
                </button>`;
        }).join('');

        const more = news.total > news.items.length
            ? `<p class="workload-news-more">and ${news.total - news.items.length} more</p>`
            : '';
        const count = news.total;

        return `
            <section class="workload-news" aria-label="New for you">
                <div class="workload-news-head">
                    <span class="workload-news-heading">
                        New for you <span class="workload-count">${count}</span>
                    </span>
                    <button type="button" class="workload-news-dismiss" data-workload-news-seen>Got it</button>
                </div>
                <p class="workload-news-sub">Assigned to you since you last looked.</p>
                <div class="workload-news-list">${rows}</div>
                ${more}
            </section>`;
    }

    /** "5 min ago", "Yesterday", "Oct 3" - for when something was assigned. */
    function describeWhen(value) {
        if (!value) return '';
        const date = new Date(String(value).replace(' ', 'T') + 'Z');
        if (isNaN(date.getTime())) return '';

        const minutes = Math.round((Date.now() - date.getTime()) / 60000);
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes} min ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours} h ago`;
        if (hours < 48) return 'yesterday';
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    async function markNewsSeen(button) {
        if (button) button.disabled = true;
        try {
            const response = await fetch(API + '?action=news-seen', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: '{}'
            });
            if (!response.ok) throw new Error('failed');
            state.news = null;
            render();
        } catch (e) {
            if (button) button.disabled = false;
        }
    }

    function todoRow(todo) {
        const done = Number(todo.is_completed) === 1;
        const due = describeDue(todo.due_date);

        const context = todo.project_name
            ? escapeHtml(todo.project_name)
            : (todo.contact_name ? escapeHtml(todo.contact_name) : '');

        const priority = (todo.priority || '').toLowerCase();
        // Priority as a coloured dot; the word is in its tooltip, and the
        // cards at the top say how many of each there are.
        const priorityChip = ['high', 'medium', 'low'].includes(priority)
            ? `<span class="workload-pri workload-pri--${priority}" title="${priority.charAt(0).toUpperCase() + priority.slice(1)} priority" aria-label="${priority} priority"></span>`
            : '';

        const title = escapeHtml(todo.title || '');
        // The control is a checkbox, so it is named after the to-do; the
        // tooltip is where the action goes.
        const checkName = title || 'To-do';
        const checkHint = done ? 'Mark as open' : 'Mark as done';
        const busy = state.busy.has(Number(todo.id));

        // Three controls: the mark checks the to-do off, the row opens the
        // to-do, and its first link (mostly a Drive document) opens directly.
        return `
            <div class="workload-row${done ? ' is-done' : ''}">
                <button type="button" class="workload-row-mark workload-check${done ? ' is-done' : ''}"
                        data-workload-toggle="${todo.id}" role="checkbox"
                        aria-checked="${done ? 'true' : 'false'}"
                        aria-label="${checkName}" title="${checkHint}"${busy ? ' disabled' : ''}>
                    ${done ? ICON_CHECK : `<span class="workload-check-hint">${ICON_CHECK}</span>`}
                </button>
                <button type="button" class="workload-row-main"
                        data-workload-open="todo" data-id="${todo.id}">
                    <span class="workload-row-body">
                        <span class="workload-row-title">${title}${newTag('todo', todo.id)}</span>
                        ${context ? `<span class="workload-row-context">${context}</span>` : ''}
                    </span>
                    <span class="workload-row-meta">
                        ${priorityChip}
                        ${due.text ? `<span class="workload-due${due.overdue ? ' is-overdue' : ''}">${escapeHtml(due.text)}</span>` : ''}
                    </span>
                </button>
                ${window.TodoLinks ? window.TodoLinks.quickLink(todo) : ''}
            </div>
        `;
    }

    /**
     * A bookkeeping row somebody has been handed: a bank entry still missing
     * its PDF. There is no tick box because there is nothing to tick -
     * attaching the invoice is what finishes it: drop the PDF onto the row
     * (bindPdfDrops), or click through to the Bookkeeping tab.
     */
    function bookkeepingRow(entry) {
        // A bank entry's date is when the money moved, not a deadline, so it
        // is printed plainly rather than run through the "3 days overdue"
        // phrasing the to-dos use.
        const date = formatDate(entry.row_date);

        return `
            <button type="button" class="workload-row" data-workload-open="bookkeeping" data-id="${entry.id}"
                    data-drop-label="Drop PDF to attach" title="Open in Bookkeeping, or drop the invoice PDF here">
                <span class="workload-row-mark is-icon">${ICON_RECEIPT}</span>
                <span class="workload-row-body">
                    <span class="workload-row-title">${escapeHtml(entry.summary || '')}${newTag('bookkeeping', entry.id)}</span>
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
                    <span class="workload-row-title">${escapeHtml(project.name || '')}${newTag('project', project.id)}</span>
                    ${project.company ? `<span class="workload-row-context">${escapeHtml(project.company)}</span>` : ''}
                </span>
                <span class="workload-row-meta">
                    <span class="workload-stage" data-stage="${escapeHtml(stageClass)}">${escapeHtml(stage)}</span>
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
                    <span class="workload-row-title">${escapeHtml(contact.name || '')}${newTag('contact', contact.id)}</span>
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

    // The section icons: one per kind of thing.
    const TYPE_ICONS = {
        due: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM7 12h5v5H7z"/></svg>',
        todo: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm-9 14-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
        project: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg>',
        contact: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
        bookkeeping: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19.5 3.5 18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2v20l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5V2l-1.5 1.5zM17 19H7V5h10v14zM8 13h8v2H8v-2zm0-4h8v2H8V9z"/></svg>'
    };

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

    async function load(who, quiet = false) {
        if (who) state.who = who;

        // No-op once it has run; here for the case where this is the first
        // view shown and app.js asks for it before this file has initialized.
        init();
        if (!els.body) return;

        // A quiet reload (after a change made in a sheet) keeps what is on
        // screen until the new list is ready, instead of flashing "Loading".
        if (!quiet || !state.loaded) {
            els.body.innerHTML = '<div class="workload-loading">Loading...</div>';
        }

        try {
            // The directory drives both the switcher and the faces, so make
            // sure it has arrived before drawing either.
            if (window.CRMPeople && !window.CRMPeople.ready()) {
                await window.CRMPeople.reload();
            }
            await loadCounts();
            populateSwitcher();

            // What was assigned to you since you last looked - only on your
            // own home; a missing feed never stops the page from loading.
            const newsRequest = state.who === 'me'
                ? api('?action=news').then(r => r.data).catch(() => null)
                : Promise.resolve(null);

            const result = await api('?action=workload&user=' + encodeURIComponent(state.who));
            state.news = await newsRequest;
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
            // switchView() calls open(), which picks this up - one request.
            state.nextWho = key;
            window.CRM.switchView('workload');
        } else {
            load(key);
        }
    }

    /**
     * The tab was opened from the navigation: always start at the signed-in
     * person, not whoever was looked at last. A refresh of the open tab goes
     * through load() instead and keeps the person on screen.
     */
    function open() {
        const who = state.nextWho || 'me';
        state.nextWho = null;
        return load(who);
    }

    // ------------------------------------------------------------------
    // Dropping an invoice PDF onto a bookkeeping row
    // ------------------------------------------------------------------

    const BOOKKEEPING_API = 'api/bookkeeping.php';

    function isFileDrag(event) {
        return Array.from(event.dataTransfer ? event.dataTransfer.types : []).includes('Files');
    }

    function bookkeepingRowAt(target) {
        return target.closest ? target.closest('[data-workload-open="bookkeeping"]') : null;
    }

    function clearDropTarget() {
        els.body.querySelectorAll('.workload-row.is-drop-target').forEach(row => row.classList.remove('is-drop-target'));
    }

    /**
     * Attach the PDF to the row through the Bookkeeping API, the same call its
     * own tab makes, so size and type checks and "already has a PDF" are
     * enforced in one place. Attaching it also clears the assignment, so the
     * row leaves this list on the reload.
     */
    async function attachPdf(rowEl, files) {
        const pdfs = Array.from(files || []).filter(file => /\.pdf$/i.test(file.name));
        if (pdfs.length === 0) {
            showToast('Only a PDF can be attached to a bookkeeping entry', true);
            return;
        }
        if (pdfs.length > 1) {
            showToast('Drop one PDF per entry', true);
            return;
        }

        const rowId = Number(rowEl.getAttribute('data-id'));
        const formData = new FormData();
        formData.append('row_id', String(rowId));
        formData.append('pdf', pdfs[0]);
        formData.append('csrf_token', getCsrfToken());

        rowEl.classList.add('is-uploading');
        try {
            const response = await fetch(BOOKKEEPING_API + '?action=upload-pdf', {
                method: 'POST',
                headers: { 'X-CSRF-Token': getCsrfToken() },
                body: formData
            });
            // PHP answers an oversized upload with an empty body, not JSON.
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) {
                throw new Error(result.error || (response.status === 413
                    ? 'That file is too large to upload'
                    : 'The PDF could not be attached'));
            }

            showToast(`Attached ${pdfs[0].name}`);
            await load();
            refreshBadge();
            refreshTeam();
        } catch (error) {
            rowEl.classList.remove('is-uploading');
            showToast(error.message, true);
        }
    }

    function bindPdfDrops() {
        els.body.addEventListener('dragover', event => {
            if (!isFileDrag(event)) return;
            // Taken over the whole tab, not just the rows: a file let go next
            // to a row would otherwise make the browser leave the CRM to open it.
            event.preventDefault();

            const row = bookkeepingRowAt(event.target);
            event.dataTransfer.dropEffect = row ? 'copy' : 'none';
            els.body.querySelectorAll('.workload-row.is-drop-target').forEach(other => {
                if (other !== row) other.classList.remove('is-drop-target');
            });
            if (row) row.classList.add('is-drop-target');
        });

        els.body.addEventListener('dragleave', event => {
            const row = bookkeepingRowAt(event.target);
            if (row && !row.contains(event.relatedTarget)) row.classList.remove('is-drop-target');
        });
        document.addEventListener('dragend', clearDropTarget);

        els.body.addEventListener('drop', event => {
            if (!isFileDrag(event)) return;
            event.preventDefault();
            clearDropTarget();

            const row = bookkeepingRowAt(event.target);
            if (row) {
                attachPdf(row, event.dataTransfer.files);
            } else if (els.body.querySelector('[data-workload-open="bookkeeping"]')) {
                showToast('Drop the PDF onto one of the bookkeeping entries', true);
            }
        });
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

        // A card at the top jumps to its list below.
        const stats = $('workloadStats');
        if (stats) {
            stats.addEventListener('click', function (event) {
                const card = event.target.closest('[data-workload-jump]');
                const target = card && els.body.querySelector('.workload-section.is-' + card.getAttribute('data-workload-jump'));
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }

        // Rows open the record they stand for, using the handles app.js exposes.
        els.body.addEventListener('click', function (event) {
            if (event.target.closest('[data-workload-toggle]')) return;

            const seen = event.target.closest('[data-workload-news-seen]');
            if (seen) {
                markNewsSeen(seen);
                return;
            }

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
                // The to-do's own sheet: its details, description and links.
                window.CRM.openTodoDetail(id);
            }
        });

        bindPdfDrops();
        refreshBadge();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.CRMWorkload = {
        open: open,
        load: load,
        refresh: () => load(null, true),
        refreshBadge: refreshBadge
    };
})();
