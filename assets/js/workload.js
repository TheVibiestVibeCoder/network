/**
 * My Work
 *
 * One screen answering one question: what is on my plate? A slim "New for you"
 * line; the bookkeeping entries still waiting on an invoice, across the full
 * width so they are not missed; then two cards: the to-dos - by priority, by
 * day, and as a list - and the projects, by stage. The contacts somebody made
 * you responsible for sit under the projects. The numbers come from
 * home-dashboard.js; this file draws and wires them.
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
        loaded: false,
        news: null,       // "New for you": { items, total }, only on your own home
        busy: new Set(),  // to-do ids with a check-off request in flight
        // To-dos ticked off since the last load: they stay in the list, struck
        // through, until the next refresh, so a slip of the mouse is undone
        // where it happened. Every count already treats them as done.
        lingering: new Set(),
        // The dashboard's filters and folds. Local to the page; the filters
        // are mirrored into the address bar (writeUrl) so a reload keeps them.
        ui: {
            prio: null,      // 'high' | 'medium' | 'low' | 'none'
            day: null,       // 'YYYY-MM-DD', one of the seven days in the strip
            stage: null,     // 'In Progress' | 'Proposal' | 'Negotiation'
            allTodos: false,
            allProjects: false,
            allNews: false
        }
    };

    // Rows shown before "Show N more", per card; news rows before "+N more".
    const LIST_LIMIT = 8;
    const NEWS_LIMIT = 3;

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
     * A plain date, for things that have one without having a deadline.
     */
    function formatDate(value) {
        if (!value) return '';
        return window.CRMFormat.date(value) || String(value);
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    const HD = window.HomeDashboard;

    /**
     * Draw the page, then put keyboard focus back where it was: every control
     * that can survive a redraw carries a data-fk key. `fallback` is the key
     * to focus when the focused control is gone (a "Clear filter" that just
     * cleared itself away).
     */
    function paint(fallback) {
        const active = document.activeElement;
        const key = active && els.body && els.body.contains(active)
            ? active.getAttribute('data-fk')
            : null;

        render();

        const target = (key && focusable(key)) || (key && fallback && focusable(fallback));
        if (target) target.focus();
    }

    function focusable(key) {
        const escaped = window.CSS && CSS.escape ? CSS.escape(key) : key;
        const el = els.body.querySelector('[data-fk="' + escaped + '"]');
        return el && !el.disabled ? el : null;
    }

    function render() {
        if (!els.body || !state.data) return;

        const { todos, projects, contacts } = state.data;
        const bookkeeping = state.data.bookkeeping || [];
        const openTodos = todos.filter(HD.isOpen);
        const today = HD.viennaToday();

        renderHead(openTodos.length, projects.length, contacts.length, bookkeeping.length);

        // The narrow column: projects, then the contacts to look after.
        let side = projectsCard(projects, todos);
        if (contacts.length) {
            side += listCard('contact', 'Contacts', contacts.map(contactRow).join(''), contacts.length);
        }

        els.body.innerHTML = newsBox()
            + bookkeepingBand(bookkeeping)
            + `<section class="home-dash" aria-label="Dashboard">
                   ${todosCard(todos, openTodos, today)}
                   <div class="home-side">${side}</div>
               </section>`;

        writeUrl();
    }

    /** The day filter as an offset into the week strip, or null. */
    function dayFilter(today) {
        if (!state.ui.day) return null;
        const offset = HD.dayOffset(state.ui.day, today);
        // A day that has slipped out of the strip (the page was left open
        // overnight) is no longer a filter anyone can see or clear.
        if (offset === null || offset < 0 || offset >= HD.WINDOW_DAYS) {
            state.ui.day = null;
            return null;
        }
        return offset;
    }

    // ---- Shared pieces ------------------------------------------------

    /**
     * "My to-dos" on your own page; "Anna's to-dos" on a teammate's, and
     * "Unassigned to-dos" for the work nobody has picked up.
     */
    function cardTitle(what) {
        const person = state.person || {};
        if (person.unassigned) return 'Unassigned ' + what;
        if (state.who === 'me') return 'My ' + what;
        const first = String(person.name || '').trim().split(/\s+/)[0];
        if (!first) return what.charAt(0).toUpperCase() + what.slice(1);
        return first + (/s$/i.test(first) ? '\u2019 ' : '\u2019s ') + what;
    }

    /** A card's title, with "Create new" opening the same sheet as everywhere else. */
    function cardHead(title, create) {
        return `
            <div class="home-card-head">
                <h2 class="home-card-title">${escapeHtml(title)}</h2>
                ${create ? `<button type="button" class="home-link" data-home-create="${create}">Create new</button>` : ''}
            </div>`;
    }

    /**
     * The count beside a legend, as a plain number. Hidden from screen
     * readers: the legend buttons beside it carry the same numbers in words.
     */
    function total(value, label) {
        return `
            <span class="home-total" aria-hidden="true">
                <span class="home-total-value">${value}</span>
                <span class="home-total-label">${escapeHtml(label)}</span>
            </span>`;
    }

    /** One filter entry: its value as the same coloured pill as in the lists, and the count. */
    function legendButton(kind, key, label, tone, count, selected) {
        const pressed = selected === key;
        const dim = (selected && !pressed) || count === 0;

        return `
            <button type="button" class="home-legend-btn${pressed ? ' is-active' : ''}${dim ? ' is-dim' : ''}"
                    data-home-${kind}="${escapeHtml(key)}" data-fk="${kind}-${escapeHtml(key)}" aria-pressed="${pressed}">
                <span class="home-legend-name"><span class="home-legend-pill" data-tone="${tone}">${escapeHtml(label)}</span></span>
                <span class="home-legend-count">${count}</span>
            </button>`;
    }

    function filterBar(label, clearKey, active) {
        return `
            <div class="home-filterbar">
                <span class="home-filterbar-label">${escapeHtml(label)}</span>
                ${active ? `<button type="button" class="home-clear" data-home-clear="${clearKey}" data-fk="clear-${clearKey}">Clear filter</button>` : ''}
            </div>`;
    }

    function emptyLine(text) {
        return `<p class="home-empty">${ICON_DONE}<span>${escapeHtml(text)}</span></p>`;
    }

    function moreButton(key, expanded, hidden) {
        return `<button type="button" class="home-more" data-home-more="${key}" data-fk="more-${key}" aria-expanded="${expanded}">
                    ${expanded ? 'Show less' : `Show ${hidden} more`}
                </button>`;
    }

    // ---- To-dos -------------------------------------------------------

    /**
     * The To-dos card: priorities and the week on top, the list under them.
     * Every number comes from the same open to-dos (HomeDashboard), so a
     * tick moves the count, the legend, the badges and the list together.
     */
    function todosCard(todos, openTodos, today) {
        const ui = state.ui;
        const filters = { prio: ui.prio, day: dayFilter(today) };
        const summary = HD.todoSummary(openTodos, ui.prio, today);

        // Count and legend. "No priority" only shows up when there is some.
        const priorities = HD.PRIORITIES.filter(p => p.key !== 'none' || summary.priorities.none > 0 || ui.prio === 'none');
        const legend = priorities.map(p =>
            legendButton('prio', p.key, p.label, p.key, summary.priorities[p.key], ui.prio)
        ).join('');

        // The week strip: each day a filter, its badge counting the to-dos
        // due that day at the selected priority.
        const days = HD.week(today).map(day => {
            const count = summary.days[day.offset];
            const pressed = filters.day === day.offset;
            const dim = filters.day !== null && !pressed;
            const classes = ['home-day-btn'];
            if (day.offset === 0) classes.push('is-today');
            if (pressed) classes.push('is-active');
            if (dim) classes.push('is-dim');

            return `
                <button type="button" class="${classes.join(' ')}" data-home-day="${day.date}" data-fk="day-${day.offset}"
                        aria-pressed="${pressed}" aria-label="${escapeHtml(day.longLabel)}, ${count} due">
                    <span class="home-day-initial">${day.initial}</span>
                    <span class="home-day-num">${day.dayOfMonth}</span>
                    <span class="home-day-badge${count ? ' has-due' : ''}">${count || ''}</span>
                </button>`;
        }).join('');

        const overdue = summary.overdue
            ? ` <span class="home-week-overdue">· ${summary.overdue} overdue</span>`
            : '';

        // A week with nothing due is only empty dots: left out then, unless
        // one of its days is the filter in use.
        const weekShown = summary.due > 0 || filters.day !== null;

        // The list: open to-dos plus the ones just ticked off here.
        const listed = todos.filter(t => HD.isOpen(t) || state.lingering.has(Number(t.id)));
        const filtered = HD.filterTodos(listed, filters, today);
        const shown = ui.allTodos ? filtered : filtered.slice(0, LIST_LIMIT);
        const filtering = !!filters.prio || filters.day !== null;

        const list = filtered.length
            ? HD.groupTodos(shown, today).map(group => `
                <div class="home-group-head${group.urgent ? ' is-urgent' : ''}">
                    <span class="home-group-name">${escapeHtml(group.head)}</span>
                    ${group.sub ? `<span class="home-group-date">${escapeHtml(group.sub)}</span>` : ''}
                </div>
                <ul class="home-list">${group.items.map(todoRow).join('')}</ul>`).join('')
            : emptyLine(filtering ? 'Nothing here' : 'Nothing open right now.');

        const doneCount = todos.length - openTodos.length;

        return `
            <article class="home-card home-todos" aria-label="${escapeHtml(cardTitle('to-dos'))}">
                <div class="home-card-top">
                    ${cardHead(cardTitle('to-dos'), 'todo')}
                    <div class="home-summary">
                        <div class="home-breakdown">
                            ${total(summary.open, 'open')}
                            <div class="home-legend">${legend}</div>
                        </div>
                        ${weekShown ? `<div class="home-week">
                            <div class="home-week-head">
                                <span class="home-week-title">Next 7 days</span>
                                <span class="home-week-due"><strong>${summary.due}</strong> due${overdue}</span>
                            </div>
                            <div class="home-week-days">${days}</div>
                        </div>` : ''}
                    </div>
                </div>
                ${filterBar(HD.todoListLabel(filters, filtered.length, today), 'todos', filtering)}
                <div class="home-list-wrap">${list}</div>
                <div class="home-card-foot">
                    ${filtered.length > LIST_LIMIT ? moreButton('todos', ui.allTodos, filtered.length - LIST_LIMIT) : ''}
                    <button type="button" class="home-foot-link" data-home-go="completed">Completed ${doneCount}</button>
                </div>
            </article>`;
    }

    /**
     * Claude's proposal, marked as on the other pages (review.js): the badge,
     * and for a to-do the accept / reject buttons beside it.
     */
    function isProposed(record) {
        return !!record && record.review_status === 'pending';
    }

    function reviewMarks(type, record) {
        const review = window.CRMReview;
        if (!review || !isProposed(record)) return '';
        return type === 'todo' ? review.pill(record, 'todo', Number(record.id)) : review.badge(record);
    }

    function todoRow(entry) {
        const todo = entry.todo;
        const id = Number(todo.id);
        const done = !HD.isOpen(todo);
        const proposed = isProposed(todo);
        const busy = state.busy.has(id);
        const title = escapeHtml(todo.title || '');

        const context = [todo.project_name || todo.contact_name || '', entry.dueNote]
            .filter(Boolean).map(escapeHtml).join(' · ');

        const priority = HD.priorityOf(todo);
        const priorityLabel = priority === 'none' ? '' : priority.charAt(0).toUpperCase() + priority.slice(1);

        // Three controls: the circle checks the to-do off, the title opens the
        // to-do, and its first link (mostly a Drive document), right after the
        // title, opens directly. A link cannot sit inside a button, so the
        // title is the button; the rest of the row opens the to-do too, for
        // the mouse (the row carries data-workload-open as well).
        return `
            <li class="home-todo${done ? ' is-done' : ''}${proposed ? ' is-proposed' : ''}" data-workload-open="todo" data-id="${id}">
                <button type="button" class="home-check${done ? ' is-done' : ''}"
                        data-workload-toggle="${id}" data-done="${done ? 1 : 0}" data-fk="check-${id}"
                        aria-label="${done ? 'Mark as open' : 'Mark as done'}: ${title || 'To-do'}"
                        title="${done ? 'Mark as open' : 'Mark as done'}"${busy ? ' disabled' : ''}>
                    ${ICON_CHECK}
                </button>
                <span class="home-todo-main">
                    <span class="home-row-body">
                        <span class="home-todo-titleline">
                            <button type="button" class="home-todo-open" data-workload-open="todo" data-id="${id}">
                                <span class="home-row-title">${title}</span>
                            </button>${newTag('todo', id)}${proposed ? reviewMarks('todo', todo) : ''}${window.TodoLinks ? window.TodoLinks.quickLink(todo) : ''}
                        </span>
                        ${context ? `<span class="home-row-context">${context}</span>` : ''}
                    </span>
                    ${priorityLabel ? `<span class="home-prio-pill" data-tone="${priority}">${priorityLabel}</span>` : ''}
                </span>
            </li>`;
    }

    // ---- Projects -----------------------------------------------------

    function projectsCard(projects, todos) {
        const ui = state.ui;
        const counts = HD.stageCounts(projects);
        const active = HD.filterProjects(projects, null);
        const legend = HD.STAGES.map(s =>
            legendButton('stage', s.key, s.label, s.tone, counts[s.key], ui.stage)
        ).join('');

        const filtered = HD.filterProjects(projects, ui.stage);
        const shown = ui.allProjects ? filtered : filtered.slice(0, LIST_LIMIT);
        const stage = HD.STAGES.find(s => s.key === ui.stage);
        const label = stage ? `${stage.label} · ${filtered.length}` : 'All projects';

        const list = filtered.length
            ? `<ul class="home-list">${shown.map(p => projectRow(p, todos)).join('')}</ul>`
            : emptyLine(stage ? 'Nothing here' : 'No active projects.');

        return `
            <article class="home-card home-projects" aria-label="${escapeHtml(cardTitle('projects'))}">
                <div class="home-card-top">
                    ${cardHead(cardTitle('projects'), 'project')}
                    <div class="home-breakdown">
                        ${total(active.length, 'active')}
                        <div class="home-legend">${legend}</div>
                    </div>
                </div>
                ${filterBar(label, 'projects', !!stage)}
                <div class="home-list-wrap">${list}</div>
                ${filtered.length > LIST_LIMIT
                    ? `<div class="home-card-foot">${moreButton('projects', ui.allProjects, filtered.length - LIST_LIMIT)}</div>`
                    : ''}
            </article>`;
    }

    function projectRow(project, todos) {
        const stage = HD.stageOf(project);
        const open = HD.projectOpenTodos(project, todos);
        const context = [project.company || '', stage.label].filter(Boolean).map(escapeHtml).join(' · ');

        return `
            <li>
                <button type="button" class="home-project${isProposed(project) ? ' is-proposed' : ''}" data-workload-open="project" data-id="${project.id}">
                    <span class="home-project-bar" data-tone="${stage.tone}"></span>
                    <span class="home-row-body">
                        <span class="home-row-title">${escapeHtml(project.name || '')}${newTag('project', project.id)}${reviewMarks('project', project)}</span>
                        <span class="home-row-context">${context}</span>
                    </span>
                    <span class="home-pill${open ? ' has-todos' : ''}">${open ? open + (open === 1 ? ' to-do' : ' to-dos') : 'No to-dos'}</span>
                </button>
            </li>`;
    }

    // ---- Bookkeeping and contacts -------------------------------------

    /**
     * Bank entries still missing their invoice, above the to-dos and projects
     * and across the full width: each one is money that cannot be booked
     * until somebody finds the PDF, and in the side column they went unseen.
     * Built like the other small cards (listCard), its rows side by side.
     * Every entry is a drop target for its PDF (bindPdfDrops).
     */
    function bookkeepingBand(entries) {
        if (!entries.length) return '';

        return `
            <section class="home-card home-mini is-bookkeeping home-bk" aria-labelledby="homeBkHeading">
                <div class="home-card-head">
                    <h2 class="home-card-title" id="homeBkHeading">
                        <span class="home-mini-icon" aria-hidden="true">${ICON_RECEIPT}</span>
                        Bookkeeping
                        <span class="home-mini-count">${entries.length}</span>
                    </h2>
                    <button type="button" class="home-link" data-home-go="bookkeeping">Open Bookkeeping</button>
                </div>
                <div class="workload-list home-bk-list">${entries.map(bookkeepingRow).join('')}</div>
            </section>`;
    }

    /**
     * A compact card for the other things a person can be handed. Each kind
     * keeps its colour and icon (--wl-type in design.css).
     */
    function listCard(type, title, rows, count) {
        return `
            <article class="home-card home-mini is-${type}" aria-label="${escapeHtml(title)}">
                <div class="home-card-head">
                    <h2 class="home-card-title">
                        <span class="home-mini-icon" aria-hidden="true">${TYPE_ICONS[type] || ''}</span>
                        ${escapeHtml(title)}
                        <span class="home-mini-count">${count}</span>
                    </h2>
                </div>
                <div class="workload-list">${rows}</div>
            </article>`;
    }

    function renderHead(openCount, projectCount, contactCount, bookkeepingCount) {
        const person = state.person || {};
        const isMe = state.who === 'me';
        const name = person.unassigned ? 'Unassigned' : (person.name || '');

        // Your own page greets you; anyone else's is titled with their name.
        const hour = HD.viennaHour();
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

        // The cards below carry the counts, so the line above the name
        // orients instead: which day it is, or whose plate you are looking at.
        const today = new Date().toLocaleDateString('en-US', {
            timeZone: HD.TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long'
        });
        els.summary.textContent = person.unassigned
            ? 'Work nobody has picked up yet'
            : (isMe ? today : (bits.length ? bits.join(' · ') : 'Nothing assigned yet'));
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
     * What has been assigned to you since you last looked. A small card: a
     * head with the count and "Mark as seen", then one row per item - its
     * kind, its title and what it belongs to, and who handed it over when -
     * each one click from its record. The first few show; "+N more" opens
     * the rest.
     */
    function newsBox() {
        const news = state.news;
        if (!news || !news.items || news.items.length === 0) return '';

        const items = state.ui.allNews ? news.items : news.items.slice(0, NEWS_LIMIT);

        const rows = items.map(item => {
            const type = NEWS_LABELS[item.type] ? item.type : 'todo';
            const by = item.assigned_by_name ? 'from ' + item.assigned_by_name : '';
            const meta = [by, describeWhen(item.assigned_at)].filter(Boolean).join(' · ');

            return `
                <li>
                    <button type="button" class="home-news-row" data-workload-open="${type}" data-id="${item.id}">
                        <span class="home-news-type" data-type="${type}">${NEWS_LABELS[type]}</span>
                        <span class="home-news-main">
                            <span class="home-news-title">${escapeHtml(item.title)}</span>
                            ${item.context ? `<span class="home-news-context">${escapeHtml(item.context)}</span>` : ''}
                        </span>
                        ${meta ? `<span class="home-news-meta">${escapeHtml(meta)}</span>` : ''}
                    </button>
                </li>`;
        }).join('');

        // Up to twenty arrive; beyond that the feed only knows how many.
        const hidden = news.total - items.length;
        let more = '';
        if (news.items.length > NEWS_LIMIT) {
            more = `<button type="button" class="home-news-more" data-home-more="news" data-fk="more-news" aria-expanded="${state.ui.allNews}">
                        ${state.ui.allNews ? 'Show less' : `Show ${hidden} more`}
                    </button>`;
        } else if (hidden > 0) {
            more = `<span class="home-news-rest">and ${hidden} more</span>`;
        }

        return `
            <section class="home-news" aria-labelledby="homeNewsHeading">
                <div class="home-news-head">
                    <span class="home-news-icon" aria-hidden="true">${ICON_NEW}</span>
                    <h2 class="home-news-heading" id="homeNewsHeading">New for you</h2>
                    <span class="home-news-count" title="Assigned to you since you last looked">${news.total}</span>
                    <button type="button" class="home-news-dismiss" data-workload-news-seen>Mark as seen</button>
                </div>
                <ul class="home-news-list">${rows}</ul>
                ${more ? `<div class="home-news-foot">${more}</div>` : ''}
            </section>`;
    }

    /** "5 minutes ago", "Yesterday", "Oct 3" - for when something was assigned. */
    function describeWhen(value) {
        return value ? window.CRMFormat.ago(value) : '';
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
            state.ui.allNews = false;
            render();
        } catch (e) {
            if (button) button.disabled = false;
        }
    }

    /**
     * A bookkeeping row somebody has been handed: a bank entry still missing
     * its PDF. There is no tick box because there is nothing to tick -
     * attaching the invoice is what finishes it: drop the PDF onto the row
     * (bindPdfDrops), or click through to the Bookkeeping tab.
     */
    function bookkeepingRow(entry) {
        // A bank entry's date is when the money moved, not a deadline, so it
        // is printed plainly rather than as "3 days overdue".
        const date = formatDate(entry.row_date);

        return `
            <button type="button" class="workload-row" data-workload-open="bookkeeping" data-id="${entry.id}"
                    data-drop-label="Drop PDF to attach" title="Open in Bookkeeping, or drop the invoice PDF here">
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

    function contactRow(contact) {
        const sub = contact.company || contact.location || contact.email || '';

        return `
            <button type="button" class="workload-row${isProposed(contact) ? ' is-proposed' : ''}" data-workload-open="contact" data-id="${contact.id}">
                <span class="workload-row-body">
                    <span class="workload-row-title">${escapeHtml(contact.name || '')}${newTag('contact', contact.id)}${reviewMarks('contact', contact)}</span>
                    ${sub ? `<span class="workload-row-context">${escapeHtml(sub)}</span>` : ''}
                </span>
                <span class="workload-row-meta"></span>
            </button>
        `;
    }

    /**
     * Placeholders in the shape of the two cards, shown while a person's work
     * loads, so nothing jumps when it arrives.
     */
    function skeleton() {
        const bar = (width, extra) => `<span class="home-skel${extra ? ' ' + extra : ''}" style="width:${width}"></span>`;
        const legend = n => Array.from({ length: n }, () => bar('100%', 'is-line')).join('');
        const rows = n => Array.from({ length: n }, (_, i) => `
            <div class="home-skel-row">
                ${bar('22px', 'is-round')}
                <span class="home-skel-lines">${bar(['70%', '55%', '62%', '48%', '66%'][i % 5])}${bar('38%', 'is-small')}</span>
            </div>`).join('');
        const breakdown = `
            <div class="home-breakdown">
                <span class="home-skel is-total"></span>
                <div class="home-legend">${legend(3)}</div>
            </div>`;

        return `
            <section class="home-dash is-loading" aria-label="Loading" aria-busy="true">
                <div class="home-card home-todos">
                    <div class="home-card-top">
                        <div class="home-card-head">${bar('72px', 'is-title')}</div>
                        <div class="home-summary">
                            ${breakdown}
                            <div class="home-week">
                                <div class="home-week-head">${bar('80px', 'is-small')}</div>
                                <div class="home-week-days">${Array.from({ length: 7 }, () => bar('100%', 'is-day')).join('')}</div>
                            </div>
                        </div>
                    </div>
                    <div class="home-filterbar">${bar('160px', 'is-small')}</div>
                    <div class="home-list-wrap">${rows(5)}</div>
                </div>
                <div class="home-side">
                    <div class="home-card home-projects">
                        <div class="home-card-top">
                            <div class="home-card-head">${bar('80px', 'is-title')}</div>
                            ${breakdown}
                        </div>
                        <div class="home-filterbar">${bar('100px', 'is-small')}</div>
                        <div class="home-list-wrap">${rows(4)}</div>
                    </div>
                </div>
            </section>`;
    }

    // ------------------------------------------------------------------
    // Filters, folds and the address bar
    // ------------------------------------------------------------------

    function setUi(changes, fallback) {
        Object.assign(state.ui, changes);
        paint(fallback);
    }

    /**
     * Mirror the filters into the query string (?prio=high&day=2026-10-09),
     * so a reload or a shared link opens the same view. Only while Home is
     * on screen; leaving it takes them off again.
     */
    function writeUrl() {
        if (!window.history || !window.history.replaceState) return;

        const url = new URL(window.location.href);
        ['prio', 'day', 'stage'].forEach(key => url.searchParams.delete(key));

        if (shownView === 'workload') {
            if (state.ui.prio) url.searchParams.set('prio', state.ui.prio);
            if (state.ui.day) url.searchParams.set('day', state.ui.day);
            if (state.ui.stage) url.searchParams.set('stage', state.ui.stage);
        }

        if (url.href !== window.location.href) {
            window.history.replaceState(window.history.state, '', url.href);
        }
    }

    function readUrl() {
        const params = new URLSearchParams(window.location.search);
        const prio = params.get('prio');
        const day = params.get('day');
        const stage = params.get('stage');

        if (HD.PRIORITIES.some(p => p.key === prio)) state.ui.prio = prio;
        if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) state.ui.day = day;  // range-checked in dayFilter()
        if (HD.STAGES.some(s => s.key === stage)) state.ui.stage = stage;
    }

    /**
     * The dashboard's own controls: the legend and day filters, "Clear
     * filter", "Show more", and the links to the full lists.
     */
    function handleDashboardClick(event) {
        const t = event.target;
        const ui = state.ui;
        let el;

        if ((el = t.closest('[data-home-prio]'))) {
            const key = el.getAttribute('data-home-prio');
            setUi({ prio: ui.prio === key ? null : key, allTodos: false });
        } else if ((el = t.closest('[data-home-day]'))) {
            const date = el.getAttribute('data-home-day');
            setUi({ day: ui.day === date ? null : date, allTodos: false });
        } else if ((el = t.closest('[data-home-stage]'))) {
            const key = el.getAttribute('data-home-stage');
            setUi({ stage: ui.stage === key ? null : key, allProjects: false });
        } else if ((el = t.closest('[data-home-clear]'))) {
            if (el.getAttribute('data-home-clear') === 'projects') {
                setUi({ stage: null, allProjects: false }, 'stage-' + HD.STAGES[0].key);
            } else {
                setUi({ prio: null, day: null, allTodos: false }, 'prio-high');
            }
        } else if ((el = t.closest('[data-home-more]'))) {
            const key = el.getAttribute('data-home-more');
            const prop = key === 'news' ? 'allNews' : (key === 'projects' ? 'allProjects' : 'allTodos');
            setUi({ [prop]: !ui[prop] });
        } else if ((el = t.closest('[data-home-create]'))) {
            create(el.getAttribute('data-home-create'));
        } else if ((el = t.closest('[data-home-go]'))) {
            goTo(el.getAttribute('data-home-go'));
        } else {
            return;
        }

        event.stopPropagation();
    }

    /** "Create new": the project or to-do sheet, ready to fill in. */
    function create(what) {
        const crm = window.CRM;
        if (!crm) return;

        if (what === 'project' && crm.openNewProject) {
            crm.openNewProject();
        } else if (what === 'todo' && crm.openNewTodo) {
            crm.openNewTodo();
        }
    }

    /** "Completed": the full list, for the person shown. */
    function goTo(where) {
        const crm = window.CRM;
        if (!crm) return;

        if (where === 'bookkeeping') {
            crm.switchView('bookkeeping');
        } else if (crm.openTodos) {
            crm.openTodos({ status: where === 'completed' ? 'completed' : 'open', assigned: state.who });
        } else {
            crm.switchView('todos');
        }
    }

    // "New for you": a bell.
    const ICON_NEW = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';

    // The small cards' icons: one per kind of thing.
    const TYPE_ICONS = {
        contact: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>',
        bookkeeping: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-2.5-1.6L14 21l-2-1.6L10 21l-2.5-1.6L5 21V4.5a1 1 0 0 1 1-1z"/><path d="M9 8.5h6M9 12.5h6"/></svg>'
    };

    const ICON_CHECK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
    const ICON_RECEIPT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-2.5-1.6L14 21l-2-1.6L10 21l-2.5-1.6L5 21V4.5a1 1 0 0 1 1-1z"/><path d="M9 8.5h6M9 12.5h6"/></svg>';
    // The empty list: a check in a circle.
    const ICON_DONE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5 5-5.5"/></svg>';
    const ICON_INBOX = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/><path d="M5.5 5h13l2 8.5V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-5.5z"/></svg>';

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
     * The tick shows the moment it is clicked, and every count on the page
     * moves with it, because waiting on the network to see a tick appear
     * feels broken; if the write fails the row goes back and says so. Only
     * master rows reach this view, so the id stays valid even though the
     * server rebuilds a project to-do's per-contact copies.
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
        // A to-do checked off stays in the list, struck through, until the
        // next load: the row should still be where the person can see it,
        // and undo it.
        if (completed) state.lingering.add(todoId);
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

        // The nav badge counts open to-dos.
        refreshBadge();
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
        // screen until the new list is ready, instead of flashing placeholders.
        if (!quiet || !state.loaded) {
            els.body.innerHTML = skeleton();
        }

        try {
            // The directory drives the faces, so make sure it has arrived
            // before drawing them.
            if (window.CRMPeople && !window.CRMPeople.ready()) {
                await window.CRMPeople.reload();
            }

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

            // What was open in this load: the project pills count from it
            // (HomeDashboard.projectOpenTodos). A fresh load also lets the
            // to-dos ticked off since the last one leave the list.
            state.data.todos.forEach(todo => { todo.loaded_open = HD.isOpen(todo); });
            state.lingering.clear();

            paint();
            syncNav();
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
     * The way to anyone else's plate: "what is Anna working on?" is one
     * click. Only people who can sign in now: invited and disabled
     * accounts stay out. Hidden entirely until there is somebody besides you.
     */
    function renderTeam() {
        const wrap = $('sidebarTeamWrap');
        const list = $('sidebarTeam');
        if (!wrap || !list || !window.CRMPeople) return;

        const people = window.CRMPeople.list();
        const meKey = window.CRMPeople.meKey();
        const others = people.filter(person => {
            const key = person.id === null ? 'owner' : String(person.id);
            return key !== meKey && person.active !== false;
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
                </button>
            `;
        }).join('');

        wrap.hidden = false;
    }

    function refreshTeam() {
        renderTeam();
        syncNav();
    }

    /**
     * Which sidebar entry is lit: Home on your own page, the teammate when
     * you are looking at theirs. app.js calls this on every view change.
     */
    let shownView = 'workload';
    function syncNav(view) {
        if (view) {
            shownView = view;
            // The filters in the address bar belong to Home alone.
            writeUrl();
        }

        const onHome = shownView === 'workload';
        const meKey = window.CRMPeople && window.CRMPeople.meKey ? window.CRMPeople.meKey() : null;
        const who = String(state.who);
        const teammate = onHome && who !== 'me' && who !== meKey
            ? document.querySelector('[data-team-person="' + (window.CSS && CSS.escape ? CSS.escape(who) : who) + '"]')
            : null;

        document.querySelectorAll('[data-team-person]').forEach(item => {
            item.classList.toggle('active', item === teammate);
            if (item === teammate) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });

        // Home stays lit for your own page and for "Unassigned", which has
        // no entry of its own in the sidebar.
        document.querySelectorAll('.toggle-btn[data-view="workload"]').forEach(btn => {
            btn.classList.toggle('active', onHome && !teammate);
        });
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
            if (todoId) setCompletion(todoId, check.getAttribute('data-done') !== '1');
        });

        // The dashboard's filters, folds and "Create new" / "Completed" links.
        els.body.addEventListener('click', handleDashboardClick);

        // Rows open the record they stand for, using the handles app.js exposes.
        els.body.addEventListener('click', function (event) {
            if (event.target.closest('[data-workload-toggle]')) return;
            // A link inside a to-do row (its Drive document) opens itself only.
            if (event.target.closest('a[href]')) return;

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

    // Filters from the address bar, so a reload opens the same view. Read
    // now, before app.js switches to the starting tab and syncNav() rewrites
    // the address from state.
    readUrl();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.CRMWorkload = {
        open: open,
        load: load,
        refresh: () => load(null, true),
        syncNav: syncNav,
        refreshBadge: refreshBadge
    };
})();
