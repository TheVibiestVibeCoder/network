/**
 * My Work
 *
 * One screen answering one question: what is on my plate? A slim "New for you"
 * line, then two cards: the to-dos - by priority, by day, and as a list - and
 * the projects, by stage. Bookkeeping rows still waiting on an invoice and the
 * contacts somebody made you responsible for sit under the projects. The
 * numbers come from home-dashboard.js; this file draws and wires them.
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

        const date = new Date(value + 'T00:00:00');
        if (isNaN(date.getTime())) return String(value);

        return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
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

        // The narrow column: projects, then whatever else is handed over -
        // bookkeeping rows waiting on a PDF, contacts to look after.
        let side = projectsCard(projects, todos);
        if (bookkeeping.length) {
            side += listCard('bookkeeping', 'Bookkeeping', bookkeeping.map(bookkeepingRow).join(''), bookkeeping.length);
        }
        if (contacts.length) {
            side += listCard('contact', 'Contacts', contacts.map(contactRow).join(''), contacts.length);
        }

        els.body.innerHTML = newsBox()
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

    function cardHead(title, go) {
        return `
            <div class="home-card-head">
                <h2 class="home-card-title">${escapeHtml(title)}</h2>
                ${go ? `<button type="button" class="home-link" data-home-go="${go}">View all</button>` : ''}
            </div>`;
    }

    /**
     * The ring beside a legend. Hidden from screen readers: the legend
     * buttons beside it carry the same numbers in words.
     */
    function donut(segments, tones, value, label) {
        const r = HD.DONUT_RADIUS;
        const circumference = HD.DONUT_CIRCUMFERENCE.toFixed(2);
        const arcs = segments.map((segment, i) => segment.length > 0
            ? `<circle class="home-donut-arc${segment.dimmed ? ' is-dim' : ''}" data-tone="${tones[i]}" cx="46" cy="46" r="${r}"
                       stroke-dasharray="${segment.length.toFixed(2)} ${circumference}" stroke-dashoffset="${segment.offset.toFixed(2)}"></circle>`
            : '').join('');

        return `
            <span class="home-donut" aria-hidden="true">
                <svg viewBox="0 0 92 92" width="84" height="84" focusable="false">
                    <circle class="home-donut-track" cx="46" cy="46" r="${r}"></circle>${arcs}
                </svg>
                <span class="home-donut-center">
                    <span class="home-donut-value">${value}</span>
                    <span class="home-donut-label">${escapeHtml(label)}</span>
                </span>
            </span>`;
    }

    /** One legend entry: a filter button with its dot, name and count. */
    function legendButton(kind, key, label, tone, count, selected) {
        const pressed = selected === key;
        const dim = (selected && !pressed) || count === 0;

        return `
            <button type="button" class="home-legend-btn${pressed ? ' is-active' : ''}${dim ? ' is-dim' : ''}"
                    data-home-${kind}="${escapeHtml(key)}" data-fk="${kind}-${escapeHtml(key)}" aria-pressed="${pressed}">
                <span class="home-dot" data-tone="${tone}"></span>
                <span class="home-legend-name">${escapeHtml(label)}</span>
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
     * tick moves the donut, the legend, the badges and the list together.
     */
    function todosCard(todos, openTodos, today) {
        const ui = state.ui;
        const filters = { prio: ui.prio, day: dayFilter(today) };
        const summary = HD.todoSummary(openTodos, ui.prio, today);

        // Donut and legend. "No priority" only shows up when there is some.
        const priorities = HD.PRIORITIES.filter(p => p.key !== 'none' || summary.priorities.none > 0 || ui.prio === 'none');
        const segments = HD.donutSegments(
            priorities.map(p => summary.priorities[p.key]),
            priorities.findIndex(p => p.key === ui.prio)
        );
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
                    ${cardHead(cardTitle('to-dos'), 'todos')}
                    <div class="home-summary">
                        <div class="home-breakdown">
                            ${donut(segments, priorities.map(p => p.key), summary.open, 'open')}
                            <div class="home-legend">${legend}</div>
                        </div>
                        <div class="home-week">
                            <div class="home-week-head">
                                <span class="home-week-title">Next 7 days</span>
                                <span class="home-week-due"><strong>${summary.due}</strong> due${overdue}</span>
                            </div>
                            <div class="home-week-days">${days}</div>
                        </div>
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

    function todoRow(entry) {
        const todo = entry.todo;
        const id = Number(todo.id);
        const done = !HD.isOpen(todo);
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
            <li class="home-todo${done ? ' is-done' : ''}" data-workload-open="todo" data-id="${id}">
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
                            </button>${newTag('todo', id)}${window.TodoLinks ? window.TodoLinks.quickLink(todo, { compact: true }) : ''}
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
        const segments = HD.donutSegments(
            HD.STAGES.map(s => counts[s.key]),
            HD.STAGES.findIndex(s => s.key === ui.stage)
        );
        const legend = HD.STAGES.map(s =>
            legendButton('stage', s.key, s.label, s.tone, counts[s.key], ui.stage)
        ).join('');

        const filtered = HD.filterProjects(projects, ui.stage);
        const shown = ui.allProjects ? filtered : filtered.slice(0, LIST_LIMIT);
        const stage = HD.STAGES.find(s => s.key === ui.stage);
        const label = stage ? `${stage.label} · ${filtered.length}`.toUpperCase() : 'ALL PROJECTS';

        const list = filtered.length
            ? `<ul class="home-list">${shown.map(p => projectRow(p, todos)).join('')}</ul>`
            : emptyLine(stage ? 'Nothing here' : 'No active projects.');

        return `
            <article class="home-card home-projects" aria-label="${escapeHtml(cardTitle('projects'))}">
                <div class="home-card-top">
                    ${cardHead(cardTitle('projects'), 'projects')}
                    <div class="home-breakdown">
                        ${donut(segments, HD.STAGES.map(s => s.tone), active.length, 'active')}
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
                <button type="button" class="home-project" data-workload-open="project" data-id="${project.id}">
                    <span class="home-project-bar" data-tone="${stage.tone}"></span>
                    <span class="home-row-body">
                        <span class="home-row-title">${escapeHtml(project.name || '')}${newTag('project', project.id)}</span>
                        <span class="home-row-context">${context}</span>
                    </span>
                    <span class="home-pill${open ? ' has-todos' : ''}">${open ? open + (open === 1 ? ' to-do' : ' to-dos') : 'No to-dos'}</span>
                </button>
            </li>`;
    }

    // ---- Bookkeeping and contacts -------------------------------------

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

    const NEWS_LABELS = { todo: 'to-do', project: 'project', contact: 'contact', bookkeeping: 'bookkeeping row' };

    function isNew(type, id) {
        const items = state.news && state.news.items;
        return !!items && items.some(item => item.type === type && item.id === Number(id));
    }

    function newTag(type, id) {
        return isNew(type, id) ? '<span class="workload-new">New</span>' : '';
    }

    /**
     * What has been assigned to you since you last looked: one slim line per
     * item - the title, then who handed it over, on what, and when - each one
     * click from its record. The first few show; "+N more" opens the rest.
     * "Got it" clears it.
     */
    function newsBox() {
        const news = state.news;
        if (!news || !news.items || news.items.length === 0) return '';

        const items = state.ui.allNews ? news.items : news.items.slice(0, NEWS_LIMIT);

        const rows = items.map(item => {
            const type = NEWS_LABELS[item.type] ? item.type : 'todo';
            let meta = 'new ' + NEWS_LABELS[type];
            if (item.assigned_by_name) meta += ' from ' + item.assigned_by_name;
            if (item.context) meta += (type === 'todo' ? ' on ' : ' · ') + item.context;
            const when = describeWhen(item.assigned_at);
            if (when) meta += ' · ' + when;

            return `
                <li>
                    <button type="button" class="home-news-row" data-workload-open="${type}" data-id="${item.id}">
                        <strong class="home-news-title">${escapeHtml(item.title)}</strong>
                        <span class="home-news-meta">· ${escapeHtml(meta)}</span>
                    </button>
                </li>`;
        }).join('');

        // Up to twenty arrive; beyond that the feed only knows how many.
        const hidden = news.total - items.length;
        let more = '';
        if (news.items.length > NEWS_LIMIT) {
            more = `<button type="button" class="home-news-more" data-home-more="news" data-fk="more-news" aria-expanded="${state.ui.allNews}">
                        ${state.ui.allNews ? 'Show less' : `+${hidden} more`}
                    </button>`;
        } else if (hidden > 0) {
            more = `<span class="home-news-rest">and ${hidden} more</span>`;
        }

        return `
            <section class="home-news" aria-label="New for you" title="Assigned to you since you last looked">
                <span class="home-news-icon" aria-hidden="true">${ICON_NEW}</span>
                <ul class="home-news-list">${rows}</ul>
                <span class="home-news-actions">
                    ${more}
                    <button type="button" class="home-news-dismiss" data-workload-news-seen>Got it</button>
                </span>
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
        return date.toLocaleDateString('en-US', { timeZone: HD.TIME_ZONE, month: 'short', day: 'numeric' });
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
                <span class="home-skel is-donut"></span>
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
        } else if ((el = t.closest('[data-home-go]'))) {
            goTo(el.getAttribute('data-home-go'));
        } else {
            return;
        }

        event.stopPropagation();
    }

    /** "View all" and "Completed": the full lists, for the person shown. */
    function goTo(where) {
        const crm = window.CRM;
        if (!crm) return;

        if (where === 'projects') {
            crm.switchView('projects');
        } else if (crm.openTodos) {
            crm.openTodos({ status: where === 'completed' ? 'completed' : 'open', assigned: state.who });
        } else {
            crm.switchView('todos');
        }
    }

    // "New for you": a bell.
    const ICON_NEW = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';

    // The small cards' icons: one per kind of thing.
    const TYPE_ICONS = {
        contact: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
        bookkeeping: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19.5 3.5 18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2v20l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5V2l-1.5 1.5zM17 19H7V5h10v14zM8 13h8v2H8v-2zm0-4h8v2H8V9z"/></svg>'
    };

    const ICON_CHECK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    const ICON_RECEIPT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19.5 3.5 18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2v20l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5V2l-1.5 1.5zM17 19H7V5h10v14zM8 13h8v2H8v-2zm0-4h8v2H8V9z"/></svg>';
    // The empty list: a check in a circle.
    const ICON_DONE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5 5-5.5"/></svg>';
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
        // screen until the new list is ready, instead of flashing placeholders.
        if (!quiet || !state.loaded) {
            els.body.innerHTML = skeleton();
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
            if (todoId) setCompletion(todoId, check.getAttribute('data-done') !== '1');
        });

        // The dashboard's filters, folds and "View all" links.
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
