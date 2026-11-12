/**
 * Team calendar - docs/kalender-spec.md, section 3
 *
 * Everyone's calendars from the mail server in one grid with a column per
 * day: the week is the main view, a single day the closer look. Each
 * appointment carries the profile pictures of the team members in it. The
 * ones the signed-in person takes part in - alone or with others - are filled
 * in the accent colour; everyone else's stay light, Private ones grey.
 * People can be hidden and shown.
 *
 * A meeting in several calendars (the same UID) arrives as one appointment
 * with several people. All-day entries, and timed ones of a day or longer,
 * run as bars above the grid.
 *
 * An appointment opens in its sheet (#eventSheet) - view, edit and new in
 * one, as for projects and to-dos - from the grid, an empty spot in it, a
 * found free slot, and the contact and project sheets (renderLinked).
 *
 * Everything comes from api/calendar.php, which has already reduced what this
 * person may not see to "Private". Nothing here decides about
 * privacy or who may change what. Times are shown in the calendar's time
 * zone (data-tz), whatever the browser's own is.
 */
(function () {
    'use strict';

    const root = document.getElementById('teamCalendar');
    if (!root) {
        return;
    }

    const API = 'api/calendar.php';
    const TZ = root.dataset.tz || 'Europe/Vienna';
    const HOUR_PX = 48;
    const GUTTER_PX = 52;
    // Narrowest a day may get before the week scrolls sideways (days off: less).
    const COL_PX = 92;
    const COL_OFF_PX = 56;
    const DAY_MS = 24 * 60 * 60 * 1000;
    // The team writes its appointments in German: hyphenate titles that way
    // when a narrow card has to break them, instead of mid-word anywhere.
    const TITLE_LANG = ' lang="de"';
    const SYNC_EVERY_MS = 30 * 1000;
    const REFRESH_EVERY_MS = 3 * 60 * 1000;
    // v2: a column per day instead of per person; earlier preferences
    // (the day view as default, hidden people) start over.
    const PREFS_KEY = 'crm.teamCalendar.v2';

    const els = {
        body: document.getElementById('tcalBody'),
        date: document.getElementById('tcalDate'),
        people: document.getElementById('tcalPeople'),
        sync: document.getElementById('tcalSync'),
        free: document.getElementById('tcalFree'),
        settings: document.getElementById('tcalSettings'),
        scrim: document.getElementById('tcalScrim'),
        settingsBtn: root.querySelector('[data-tcal="settings"]'),
        freeBtn: root.querySelector('[data-tcal="free"]'),
        newBtn: root.querySelector('[data-tcal="new"]'),
        panel: document.getElementById('calendarView'),
        sheet: document.getElementById('eventSheet'),
        sheetHead: document.getElementById('esheetHead'),
        sheetBody: document.getElementById('esheetBody'),
        sheetFoot: document.getElementById('esheetFoot'),
        sheetActions: document.getElementById('esheetActions'),
    };

    // =========================================================================
    // Time, in the calendar's time zone
    // =========================================================================

    const wallFmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    // Local dates ("2026-11-12") are formatted as noon UTC, which is the same
    // calendar day everywhere.
    const longDayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    // The day view's heading, as short as the week's, so switching never moves the toolbar.
    const dayTitleFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const shortDayFmt =new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
    const weekdayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });
    const dayMonthFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
    const dayMonthYearFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

    /** A moment as its local date and minutes since local midnight. */
    function wall(date) {
        const p = {};
        wallFmt.formatToParts(date).forEach(part => { p[part.type] = part.value; });
        return { key: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
    }

    function todayKey() {
        return wall(new Date()).key;
    }

    function keyDate(key) {
        return new Date(key + 'T12:00:00Z');
    }

    function addDays(key, days) {
        const d = keyDate(key);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
    }

    /** ISO weekday, 1 = Monday. */
    function isoWeekday(key) {
        return ((keyDate(key).getUTCDay() + 6) % 7) + 1;
    }

    function weekStart(key) {
        return addDays(key, 1 - isoWeekday(key));
    }

    function fmtTime(iso) {
        return timeFmt.format(new Date(iso));
    }

    function pad(n) {
        return String(n).padStart(2, '0');
    }

    function minutesLabel(minutes) {
        return pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
    }

    function durationLabel(minutes) {
        if (minutes < 60) return minutes + ' min';
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return h + ' h' + (m ? ' ' + m + ' min' : '');
    }

    /** "now", "5m", "3h", "2d": how long ago, as short as it gets. */
    function ago(ts) {
        const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (seconds < 60) return 'now';
        if (seconds < 3600) return Math.round(seconds / 60) + 'm';
        if (seconds < 86400) return Math.round(seconds / 3600) + 'h';
        return Math.round(seconds / 86400) + 'd';
    }

    function relative(ts) {
        const seconds = Math.round((Date.now() - ts) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
        if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
        return 'on ' + dayMonthFmt.format(new Date(ts));
    }

    // =========================================================================
    // State - after the formatters above, which todayKey() needs
    // =========================================================================

    const prefs = readPrefs();
    const state = {
        // The week unless chosen otherwise; a phone starts with the day.
        mode: prefs.mode === 'day' || prefs.mode === 'week' ? prefs.mode
            : (window.matchMedia('(max-width: 640px)').matches ? 'day' : 'week'),
        date: todayKey(),
        hidden: new Set(Array.isArray(prefs.hidden) ? prefs.hidden : []),
        data: null,
        loadedAt: 0,
        requestSeq: 0,
        syncing: false,
        lastSyncTry: 0,
        slots: [],
        free: { open: false, people: null, minutes: 60, range: 'week', results: null, busy: false, error: null, searched: null },
        settings: null,
        scrollMode: null,
        refreshTimer: null,
    };

    // =========================================================================
    // Small helpers
    // =========================================================================

    function esc(value) {
        return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }

    /** Plain text with its web links clickable - everything else stays escaped. */
    function linkify(text) {
        const parts = String(text || '').split(/(https?:\/\/[^\s<>"']+)/g);
        return parts.map((part, i) => (i % 2 === 1
            ? `<a href="${esc(part)}" target="_blank" rel="noopener noreferrer">${esc(part)}</a>`
            : esc(part))).join('');
    }

    function csrf() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    function toast(message, isError) {
        const el = document.getElementById('bkToast');
        if (!el) {
            if (isError) window.alert(message);
            return;
        }
        el.textContent = message;
        el.classList.toggle('bk-toast-error', !!isError);
        el.classList.add('visible');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => el.classList.remove('visible'), 3500);
    }

    function readPrefs() {
        try {
            return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
        } catch (e) {
            return {};
        }
    }

    function savePrefs() {
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: state.mode, hidden: Array.from(state.hidden) }));
        } catch (e) {
            // A remembered view is a convenience; nothing breaks without it.
        }
    }

    async function api(params, options) {
        const opts = options || {};
        const query = new URLSearchParams(params || {}).toString();
        const headers = Object.assign({ 'X-CSRF-Token': csrf() }, opts.body ? { 'Content-Type': 'application/json' } : {});
        const response = await fetch(API + (query ? '?' + query : ''), Object.assign({ credentials: 'same-origin' }, opts, { headers }));
        let payload = null;
        try {
            payload = await response.json();
        } catch (e) {
            payload = null;
        }
        if (!response.ok || !payload || payload.success === false) {
            const error = new Error((payload && payload.error) || `The calendar could not be loaded (${response.status}).`);
            error.status = response.status;
            error.payload = payload;
            throw error;
        }
        return payload.data;
    }

    function person(email) {
        return (state.data && state.data.people.find(p => p.email === email)) || null;
    }

    function visiblePeople() {
        return state.data ? state.data.people.filter(p => !state.hidden.has(p.email)) : [];
    }

    // =========================================================================
    // Faces
    // =========================================================================

    /** A person's profile picture, or their initials in their colour. */
    function face(p) {
        if (!p) return '';
        const inner = p.avatar_url
            ? `<img src="${esc(p.avatar_url)}" alt="" loading="lazy" decoding="async">`
            : esc(p.initials);
        return `<span class="tcal-face${p.avatar_url ? ' has-photo' : ''}" style="--person:${esc(p.color)}"
                    data-initials="${esc(p.initials)}" title="${esc(p.name)}">${inner}</span>`;
    }

    /** The team members in an appointment, in the team's order. */
    function peopleIn(item) {
        const emails = item.masked ? item.owners : item.people;
        return state.data.people.filter(p => emails.includes(p.email));
    }

    /** Up to `max` faces, the rest as "+n". */
    function faces(item, max) {
        const list = peopleIn(item);
        if (!list.length) return '';
        const shown = list.length > max ? list.slice(0, max - 1) : list;
        const rest = list.slice(shown.length);
        const more = rest.length
            ? `<span class="tcal-face tcal-face--more" title="${esc(rest.map(p => p.name).join(', '))}">+${rest.length}</span>` : '';
        return `<span class="tcal-faces">${shown.map(face).join('')}${more}</span>`;
    }

    // =========================================================================
    // Loading and syncing
    // =========================================================================

    function viewDays() {
        if (state.mode === 'day') return [state.date];
        const start = weekStart(state.date);
        return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }

    async function load(options) {
        const opts = options || {};
        const days = viewDays();
        const from = days[0];
        const to = addDays(days[days.length - 1], 1);
        const seq = ++state.requestSeq;
        if (!state.data) {
            els.body.innerHTML = '<div class="tcal-loading">Loading the calendar…</div>';
        }
        root.classList.add('is-loading');
        try {
            const data = await api({ from, to });
            if (seq !== state.requestSeq) return;
            state.data = data;
            state.loadedAt = Date.now();
            render();
            if (!opts.skipSync) {
                maybeSync(false);
            }
        } catch (e) {
            if (seq !== state.requestSeq) return;
            els.body.innerHTML = `<div class="empty-state tcal-empty"><p>${esc(e.message)}</p></div>`;
        } finally {
            if (seq === state.requestSeq) root.classList.remove('is-loading');
        }
    }

    /** Opening the calendar syncs too, at most every 30 seconds. */
    async function maybeSync(force) {
        if (state.syncing || !state.data || !state.data.configured) return;
        const last = state.data.sync && state.data.sync.last_sync_at ? Date.parse(state.data.sync.last_sync_at) : 0;
        if (!force && (Date.now() - last < SYNC_EVERY_MS || Date.now() - state.lastSyncTry < SYNC_EVERY_MS)) return;

        state.syncing = true;
        state.lastSyncTry = Date.now();
        renderSync();
        try {
            const result = await api({ action: 'sync' }, { method: 'POST' });
            state.data.sync = { last_sync_at: result.last_sync_at, error: result.error };
            if (result.changed > 0) {
                await load({ skipSync: true });
            }
        } catch (e) {
            if (force) toast(e.message, true);
        } finally {
            state.syncing = false;
            renderSync();
        }
    }

    function startRefresh() {
        if (state.refreshTimer) return;
        state.refreshTimer = setInterval(() => {
            if (document.hidden || !els.panel || !els.panel.classList.contains('active')) return;
            load({ skipSync: true });
        }, REFRESH_EVERY_MS);
    }

    // =========================================================================
    // Rendering: frame
    // =========================================================================

    function render() {
        renderTitle();
        renderModes();
        renderPeople();
        renderSync();
        if (els.settingsBtn) {
            els.settingsBtn.hidden = !(state.data && state.data.me && state.data.me.can_configure);
        }
        if (els.newBtn) {
            els.newBtn.hidden = !canCreate();
        }
        if (!state.data) return;

        // Stay at the same time of day while moving through weeks and days.
        const scroller = els.body.querySelector('.tcal-scroll');
        const keep = scroller && state.scrollMode === state.mode
            ? { top: scroller.scrollTop, left: scroller.scrollLeft } : null;

        if (!state.data.configured) {
            els.body.innerHTML = emptyState('The team calendar is not connected yet.',
                state.data.me.is_admin ? 'Set the calendar account in .env (CALDAV_BASE_URL, CALENDAR_ACCOUNT, CALENDAR_ACCOUNT_PASSWORD).' : 'An admin still has to connect it.');
        } else if (!state.data.people.length) {
            els.body.innerHTML = emptyState('No calendars yet.',
                'Each person shares their calendars with the calendar account in webmail: the work calendar to read and write, the private one to read only.'
                + (state.data.me.is_admin ? ' Then look for them in the calendar settings.' : ''));
        } else if (!visiblePeople().length) {
            els.body.innerHTML = emptyState('Everyone is hidden.', 'Pick a person above to show their calendar.');
        } else {
            renderGrid();
            const scroll = els.body.querySelector('.tcal-scroll');
            if (scroll) {
                if (keep) {
                    scroll.scrollTop = keep.top;
                    scroll.scrollLeft = keep.left;
                } else {
                    scroll.scrollTop = Math.max(0, (workingMinutes()[0] - 30) * HOUR_PX / 60);
                }
                state.scrollMode = state.mode;
            }
        }
        if (state.free.open) {
            renderFree();
        }
    }

    function emptyState(title, text) {
        return `<div class="empty-state tcal-empty"><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
    }

    function renderTitle() {
        if (state.mode === 'week') {
            const start = weekStart(state.date);
            const end = addDays(start, 6);
            const a = keyDate(start);
            const b = keyDate(end);
            let label;
            if (a.getUTCFullYear() !== b.getUTCFullYear()) {
                label = dayMonthYearFmt.format(a) + ' – ' + dayMonthYearFmt.format(b);
            } else if (a.getUTCMonth() !== b.getUTCMonth()) {
                label = dayMonthFmt.format(a) + ' – ' + dayMonthYearFmt.format(b);
            } else {
                label = a.getUTCDate() + ' – ' + dayMonthYearFmt.format(b);
            }
            els.date.textContent = label;
        } else {
            els.date.textContent = dayTitleFmt.format(keyDate(state.date));
        }
    }

    function renderModes() {
        root.querySelectorAll('[data-tcal-mode]').forEach(btn => {
            const on = btn.dataset.tcalMode === state.mode;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function renderPeople() {
        const people = state.data ? state.data.people : [];
        els.people.innerHTML = people.map(p => personToggle(p, !state.hidden.has(p.email), 'data-tcal-person')).join('');
    }

    /**
     * A person to switch on or off: a small pill with the profile picture and
     * a tick or a cross - the name comes on hover. The same in the calendar
     * and in "Find a free slot".
     */
    function personToggle(p, on, attribute) {
        const name = p.name + (p.is_me ? ' (you)' : '');
        const mark = on
            ? '<path d="m5 12.5 4.5 4.5L19 7.5"/>'
            : '<path d="M7 7l10 10M17 7 7 17"/>';
        return `<button type="button" class="tcal-pick${on ? ' is-on' : ''}" ${attribute}="${esc(p.email)}"
                    aria-pressed="${on ? 'true' : 'false'}" aria-label="${esc(name)}" title="${esc(name)}">${face(p)}<svg class="tcal-pick-mark" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mark}</svg></button>`;
    }

    function renderSync() {
        if (!state.data || !state.data.configured) {
            els.sync.innerHTML = '';
            return;
        }
        const sync = state.data.sync || {};
        // Short beside the button ("5m"), in full on hover.
        const at = sync.last_sync_at ? Date.parse(sync.last_sync_at) : null;
        const text = state.syncing ? '…' : (at ? ago(at) : '–');
        const full = state.syncing ? 'Syncing…' : (at ? 'Synced ' + relative(at) : 'Not synced yet');
        const problem = sync.error
            ? `<span class="tcal-sync-problem" title="Last sync had a problem: ${esc(sync.error)}">!</span>`
            : '';
        els.sync.innerHTML = `${problem}<span class="tcal-sync-text" title="${esc(full)}">${esc(text)}</span>
            <button type="button" class="tcal-sync-btn" data-tcal="sync" title="${esc(full)} · sync now" aria-label="Sync now"${state.syncing ? ' disabled' : ''}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/></svg>
            </button>`;
    }

    // =========================================================================
    // What goes where
    // =========================================================================

    /** Shown while at least one of its people is. */
    function shown(item) {
        const emails = item.masked ? item.owners : item.people.concat(item.owners);
        return emails.some(email => !state.hidden.has(email));
    }

    /** All-day entries, and timed ones of a day or more, run as bars above the grid. */
    function isBar(item) {
        return item.all_day || Date.parse(item.end) - Date.parse(item.start) >= DAY_MS;
    }

    function isPast(item) {
        return item.all_day ? item.end <= todayKey() : Date.parse(item.end) <= Date.now();
    }

    function itemClasses(item) {
        const classes = [];
        if (item.masked) classes.push('is-masked');
        else if (item.mine) classes.push('is-mine');
        if (item.transparent) classes.push('is-free');
        if (isPast(item)) classes.push('is-past');
        return classes;
    }

    function tooltip(item) {
        return [whenLabel(item), item.title, peopleIn(item).map(p => p.name).join(', ')].filter(Boolean).join(' · ');
    }

    /** The part of a timed appointment on one local day, in minutes. */
    function segment(item, day) {
        const s = wall(new Date(item.start));
        const e = wall(new Date(item.end));
        if (s.key > day || e.key < day) return null;
        const start = s.key < day ? 0 : s.minutes;
        let end = e.key > day ? 1440 : e.minutes;
        if (e.key === day && e.minutes === 0 && s.key < day) return null; // ended at midnight
        if (end <= start) {
            if (end < start) return null;
            end = Math.min(1440, start + 15); // no length at all: show a sliver
        }
        return { start, end };
    }

    function overlaps(a, b) {
        return a.start < b.end && b.start < a.end;
    }

    /**
     * Overlapping appointments side by side: a lane each, and as many lanes
     * to the right as are free for its whole time.
     */
    function assignLanes(list) {
        list.sort((a, b) => a.seg.start - b.seg.start || b.seg.end - a.seg.end);
        let cluster = [];
        let clusterEnd = -1;
        const flush = () => {
            const lanes = cluster.reduce((max, block) => Math.max(max, block.lane + 1), 1);
            cluster.forEach(block => {
                block.lanes = lanes;
                let span = 1;
                while (block.lane + span < lanes
                    && !cluster.some(other => other.lane === block.lane + span && overlaps(other.seg, block.seg))) {
                    span++;
                }
                block.span = span;
            });
            cluster = [];
            clusterEnd = -1;
        };
        list.forEach(block => {
            if (cluster.length && block.seg.start >= clusterEnd) flush();
            const used = new Set(cluster.filter(other => other.seg.end > block.seg.start).map(other => other.lane));
            let lane = 0;
            while (used.has(lane)) lane++;
            block.lane = lane;
            cluster.push(block);
            clusterEnd = Math.max(clusterEnd, block.seg.end);
        });
        if (cluster.length) flush();
    }

    /** Bars above the grid: first and last column, and a row each without overlaps. */
    function layoutBars(items, days) {
        const first = days[0];
        const last = days[days.length - 1];
        const bars = [];
        items.forEach(item => {
            let startKey;
            let endKey; // the last day it covers
            if (item.all_day) {
                startKey = item.start;
                endKey = addDays(item.end, -1);
            } else {
                startKey = wall(new Date(item.start)).key;
                const end = wall(new Date(item.end));
                endKey = end.minutes === 0 ? addDays(end.key, -1) : end.key;
            }
            if (endKey < first || startKey > last || endKey < startKey) return;
            const from = startKey < first ? 0 : days.indexOf(startKey);
            const to = endKey > last ? days.length - 1 : days.indexOf(endKey);
            bars.push({ item, from, to, cutStart: startKey < first, cutEnd: endKey > last });
        });
        bars.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from) || Number(b.item.mine) - Number(a.item.mine));
        const rows = [];
        bars.forEach(bar => {
            let row = 0;
            while (rows[row] && rows[row].some(other => other.from <= bar.to && bar.from <= other.to)) row++;
            if (!rows[row]) rows[row] = [];
            rows[row].push(bar);
            bar.row = row;
        });
        return bars;
    }

    function workingDay(day) {
        return (state.data.working_hours.days || []).includes(isoWeekday(day));
    }

    function workingMinutes() {
        const toMinutes = value => {
            const [h, m] = String(value || '00:00').split(':').map(Number);
            return h * 60 + m;
        };
        return [toMinutes(state.data.working_hours.start), toMinutes(state.data.working_hours.end)];
    }

    /** Free slots found by the search that fall on this day, in minutes, with their place in the list. */
    function slotsOn(day) {
        return state.slots.map((slot, index) => ({ seg: segment({ start: slot.start, end: slot.end }, day), index }))
            .filter(found => found.seg);
    }

    /** Whether this person may add appointments, and has somewhere to put them. */
    function canCreate() {
        if (state.data && state.data.me) {
            return !!state.data.me.can_edit && (state.data.me.calendars || []).length > 0;
        }
        return root.dataset.canEdit === '1';
    }

    // =========================================================================
    // The grid: a column per day
    // =========================================================================

    function renderGrid() {
        const days = viewDays();
        const week = state.mode === 'week';
        const today = todayKey();
        const items = state.data.items.filter(shown);
        const [workStart, workEnd] = workingMinutes();

        // Days off are narrower in the week, so the working days get the room.
        // Head and grid share one template and one minimum width, so their
        // columns line up even when a phone scrolls the week sideways.
        const narrow = days.map(day => week && !workingDay(day));
        const template = `grid-template-columns: ${GUTTER_PX}px `
            + narrow.map(off => (off ? `minmax(${COL_OFF_PX}px, 0.55fr)` : `minmax(${COL_PX}px, 1fr)`)).join(' ')
            + `;min-width:${GUTTER_PX + narrow.reduce((sum, off) => sum + (off ? COL_OFF_PX : COL_PX), 0)}px;`;

        const heads = days.map((day, i) => {
            const date = keyDate(day);
            const classes = 'tcal-dayhead' + (day === today ? ' is-today' : '') + (workingDay(day) ? '' : ' is-off');
            const label = `<span class="tcal-dayhead-name">${esc(weekdayFmt.format(date))}</span><span class="tcal-dayhead-num">${date.getUTCDate()}</span>`;
            return week
                ? `<button type="button" class="${classes}" data-tcal-day="${day}" style="grid-column:${i + 2}" title="Open ${esc(longDayFmt.format(date))}">${label}</button>`
                : `<div class="${classes}" style="grid-column:${i + 2}">${label}</div>`;
        }).join('');

        const bars = layoutBars(items.filter(isBar), days);
        const rows = bars.reduce((max, bar) => Math.max(max, bar.row + 1), 0);
        const allDay = rows ? `<div class="tcal-allday-label" style="grid-row: 2 / span ${rows}">All day</div>
                ${days.map((day, i) => `<div class="tcal-allday-cell${workingDay(day) ? '' : ' is-off'}" style="grid-column:${i + 2};grid-row: 2 / span ${rows}"></div>`).join('')}
                ${bars.map(barHtml).join('')}` : '';

        const hours = Array.from({ length: 24 }, (_, h) => `<div class="tcal-hour" style="top:${h * HOUR_PX}px"><span>${pad(h)}:00</span></div>`).join('');
        const now = wall(new Date()).minutes;
        const create = canCreate();
        const columns = days.map((day, i) => {
            const blocks = items.filter(item => !isBar(item))
                .map(item => ({ item, seg: segment(item, day) }))
                .filter(block => block.seg);
            assignLanes(blocks);
            // Behind the appointments: outside working hours, found free slots.
            const off = workingDay(day)
                ? `<div class="tcal-offhours" style="top:0;height:${workStart * HOUR_PX / 60}px"></div><div class="tcal-offhours" style="top:${workEnd * HOUR_PX / 60}px;bottom:0"></div>`
                : '<div class="tcal-offhours" style="top:0;bottom:0"></div>';
            const slots = slotsOn(day).map(({ seg, index }) => `<button type="button" class="tcal-slot" data-tcal-slot-mark="${index}"
                    style="top:${seg.start * HOUR_PX / 60}px;height:${(seg.end - seg.start) * HOUR_PX / 60}px"${create ? ' title="Book this time"' : ' tabindex="-1"'}>
                    <span>Free ${minutesLabel(seg.start)}–${minutesLabel(seg.end)}</span></button>`).join('');
            const line = day === today
                ? `<div class="tcal-now" style="top:${now * HOUR_PX / 60}px"></div><div class="tcal-now-dot" style="top:${now * HOUR_PX / 60}px"></div>` : '';
            return `<div class="tcal-daycol${day === today ? ' is-today' : ''}" data-tcal-col="${day}" style="grid-column:${i + 2}">${off}${slots}${blocks.map(eventHtml).join('')}${line}</div>`;
        }).join('');

        // The head scrolls sideways with the grid and sticks to the top, so the
        // columns stay aligned whatever the scrollbars do.
        els.body.innerHTML = `<div class="tcal-cal tcal-cal--${state.mode}${create ? ' can-create' : ''}">
                <div class="tcal-scroll">
                    <div class="tcal-head" style="${template}">
                        <div class="tcal-corner"></div>
                        ${heads}
                        ${allDay}
                    </div>
                    <div class="tcal-grid" style="${template};height:${24 * HOUR_PX}px">
                        <div class="tcal-gutter">${hours}</div>
                        ${columns}
                    </div>
                </div>
            </div>`;
    }

    function barHtml(bar) {
        const { item } = bar;
        const classes = ['tcal-bar'].concat(itemClasses(item));
        if (bar.cutStart) classes.push('is-cut-start');
        if (bar.cutEnd) classes.push('is-cut-end');
        const time = !item.all_day && !bar.cutStart ? `<span class="tcal-bar-time">${esc(fmtTime(item.start))}</span>` : '';
        return `<button type="button" class="${classes.join(' ')}" data-tcal-item="${esc(item.id)}"
                    style="grid-column:${bar.from + 2} / ${bar.to + 3};grid-row:${bar.row + 2}" title="${esc(tooltip(item))}">
                    ${faces(item, 3)}${time}<span class="tcal-bar-title"${TITLE_LANG}>${esc(item.title)}</span>
                </button>`;
    }

    function eventHtml(block) {
        const { item, seg } = block;
        const top = seg.start * HOUR_PX / 60;
        const height = Math.max(18, (seg.end - seg.start) * HOUR_PX / 60 - 2);
        const left = block.lane / block.lanes * 100;
        const width = block.span / block.lanes * 100;
        const geometry = `top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px)`;
        const classes = ['tcal-ev'].concat(itemClasses(item));
        const attrs = `data-tcal-item="${esc(item.id)}" style="${geometry}" title="${esc(tooltip(item))}"`;

        // Under three quarters of an hour: one line.
        if (height < 38) {
            classes.push('is-compact');
            return `<button type="button" class="${classes.join(' ')}" ${attrs}>
                    ${faces(item, 3)}<span class="tcal-ev-title"${TITLE_LANG}>${esc(item.title)}</span><span class="tcal-ev-time">${esc(fmtTime(item.start))}</span>
                </button>`;
        }
        if (height >= 66) classes.push('is-tall');
        const extras = item.masked ? '' : (item.video_url ? videoIcon() : '') + guestsBadge(item);
        const place = !item.masked && item.location && height >= 66 && !/^https?:\/\//i.test(item.location)
            ? `<span class="tcal-ev-place">${esc(item.location)}</span>` : '';
        return `<button type="button" class="${classes.join(' ')}" ${attrs}>
                <span class="tcal-ev-title"${TITLE_LANG}>${esc(item.title)}</span>
                <span class="tcal-ev-meta">${faces(item, 3)}<span class="tcal-ev-time">${esc(fmtTime(item.start))}–${esc(fmtTime(item.end))}</span>${extras}</span>
                ${place}
            </button>`;
    }

    function videoIcon() {
        return '<span class="tcal-video" title="Video call" aria-label="Video call"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="m15.5 10.5 5-3v9l-5-3"/></svg></span>';
    }


    /** How many people from outside the team are invited. */
    function guestsBadge(item) {
        if (!item.externals) return '';
        const label = item.externals + (item.externals > 1 ? ' guests' : ' guest') + ' from outside';
        return `<span class="tcal-guests" title="${esc(label)}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>${item.externals}</span>`;
    }

    // =========================================================================
    // The appointment sheet - view, edit and new in one (#eventSheet)
    // =========================================================================

    const ANSWER_LABELS = {
        'ACCEPTED': ['is-yes', 'Accepted'],
        'DECLINED': ['is-no', 'Declined'],
        'TENTATIVE': ['is-maybe', 'Maybe'],
        'DELEGATED': ['is-maybe', 'Delegated'],
        'NEEDS-ACTION': ['is-open', 'No answer yet'],
        'ORGANIZER': ['is-yes', 'Organizer'],
    };
    const REMINDER_CHOICES = [['', 'No reminder'], ['0', 'At the start'], ['5', '5 minutes before'], ['10', '10 minutes before'],
        ['15', '15 minutes before'], ['30', '30 minutes before'], ['60', '1 hour before'], ['120', '2 hours before'], ['1440', '1 day before']];
    const REPEAT_CHOICES = [['NONE', 'Does not repeat'], ['DAILY', 'Every day'], ['WEEKLY', 'Every week'], ['MONTHLY', 'Every month']];

    const sheet = {
        mode: null,          // 'view' | 'edit' | 'new' | 'masked'
        data: null,          // the appointment as api/calendar.php?action=event sends it
        form: null,          // what the fields say while editing
        busy: false,
        confirm: null,       // 'save-scope' | 'cancel' | 'cancel-scope'
        conflict: null,      // {kind, current, action, body, scope}
        pendingLinks: [],    // links chosen for a new appointment, saved with it
        picker: { open: false, query: '', results: [], seq: 0, timer: null },
        returnFocus: null,
        seq: 0,
    };

    function whenLabel(item) {
        if (item.all_day) {
            const last = addDays(item.end, -1);
            return last === item.start
                ? longDayFmt.format(keyDate(item.start)) + ' · all day'
                : shortDayFmt.format(keyDate(item.start)) + ' – ' + shortDayFmt.format(keyDate(last)) + ' · all day';
        }
        const s = wall(new Date(item.start));
        const e = wall(new Date(item.end));
        const day = shortDayFmt.format(keyDate(s.key));
        if (s.key === e.key || (e.minutes === 0 && addDays(s.key, 1) === e.key)) {
            return `${day} · ${fmtTime(item.start)}–${fmtTime(item.end)}`;
        }
        return `${day}, ${fmtTime(item.start)} – ${shortDayFmt.format(keyDate(e.key))}, ${fmtTime(item.end)}`;
    }

    // ---- Local times as the sheet holds them: "2026-11-13T09:30" ---------

    /** Minutes added to a local "Y-m-dTH:i", calendar arithmetic without zones. */
    function addMinutes(local, minutes) {
        const [date, time] = local.split('T');
        const [y, m, d] = date.split('-').map(Number);
        const [h, i] = (time || '00:00').split(':').map(Number);
        const t = new Date(Date.UTC(y, m - 1, d, h, i) + minutes * 60000);
        return t.toISOString().slice(0, 10) + 'T' + t.toISOString().slice(11, 16);
    }

    function minutesBetween(a, b) {
        const toMs = local => {
            const [date, time] = local.split('T');
            const [y, m, d] = date.split('-').map(Number);
            const [h, i] = (time || '00:00').split(':').map(Number);
            return Date.UTC(y, m - 1, d, h, i);
        };
        return Math.round((toMs(b) - toMs(a)) / 60000);
    }

    /** A moment as local "Y-m-dTH:i" in the calendar's zone. */
    function localOf(iso) {
        const w = wall(new Date(iso));
        return w.key + 'T' + minutesLabel(w.minutes);
    }

    /** The next full hour today - or 09:00 on the day the calendar shows. */
    function defaultStart() {
        const today = todayKey();
        const day = state.date && state.date !== today ? state.date : today;
        if (day !== today) return day + 'T09:00';
        const minutes = Math.min(23 * 60, (Math.floor(wall(new Date()).minutes / 60) + 1) * 60);
        return today + 'T' + minutesLabel(minutes);
    }

    /** "When" of the sheet's own data (local strings; all-day end inclusive). */
    function sheetWhen(d) {
        if (d.all_day) {
            return d.start === d.end
                ? longDayFmt.format(keyDate(d.start)) + ' · all day'
                : shortDayFmt.format(keyDate(d.start)) + ' – ' + shortDayFmt.format(keyDate(d.end)) + ' · all day';
        }
        const [sd, st] = d.start.split('T');
        const [ed, et] = d.end.split('T');
        return sd === ed
            ? `${shortDayFmt.format(keyDate(sd))} · ${st}–${et}`
            : `${shortDayFmt.format(keyDate(sd))}, ${st} – ${shortDayFmt.format(keyDate(ed))}, ${et}`;
    }

    // ---- Opening and closing -------------------------------------------

    function sheetOpen() {
        return !!(els.sheet && els.sheet.classList.contains('active'));
    }

    function resetSheet(mode) {
        sheet.mode = mode;
        sheet.data = null;
        sheet.form = null;
        sheet.busy = false;
        sheet.confirm = null;
        sheet.conflict = null;
        sheet.pendingLinks = [];
        sheet.picker = { open: false, query: '', results: [], seq: 0, timer: null };
    }

    function showSheet() {
        if (!sheetOpen()) sheet.returnFocus = document.activeElement;
        els.sheet.classList.add('active');
    }

    function closeSheet() {
        if (!els.sheet) return;
        els.sheet.classList.remove('active', 'is-editing', 'is-new');
        sheet.mode = null;
        sheet.seq++;
        const back = sheet.returnFocus;
        sheet.returnFocus = null;
        if (back && document.body.contains(back) && typeof back.focus === 'function') {
            back.focus({ preventScroll: true });
        }
    }

    function sheetLoading(text) {
        els.sheetHead.innerHTML = '<h2 id="esheetTitle" class="esheet-title-loading">Appointment</h2>';
        els.sheetBody.innerHTML = `<p class="esheet-loading">${esc(text)}</p>`;
        els.sheetFoot.innerHTML = '';
        els.sheetActions.innerHTML = '';
    }

    /** The team, the right to add and where to: what the calendar loads anyway. */
    async function basics() {
        if (!state.data) {
            await load({ skipSync: true });
        }
        if (!state.data) throw new Error('The calendar could not be loaded.');
        return state.data;
    }

    /** One appointment, in view mode (or straight into editing it). */
    async function openEvent(uid, occurrence, options) {
        if (!els.sheet || !uid) return;
        const opts = options || {};
        resetSheet('view');
        const seq = ++sheet.seq;
        showSheet();
        sheetLoading('Loading…');
        try {
            await basics();
            const data = await api({ action: 'event', uid, occurrence: occurrence || '' });
            if (seq !== sheet.seq) return;
            sheet.data = data;
            if (opts.edit && data.can.edit) {
                startEdit();
            } else {
                renderSheet();
            }
        } catch (e) {
            if (seq === sheet.seq) sheetLoading(e.message);
        }
    }

    /** Private from the grid: there is nothing to load or show but the time. */
    function openMasked(item) {
        resetSheet('masked');
        sheet.data = item;
        showSheet();
        renderSheet();
    }

    /**
     * A new appointment. prefill: start/end ("Y-m-dTH:i"), allDay, title,
     * attendees (addresses), organizer, links ([{type, target_id, name}]).
     */
    async function openNewEvent(prefill) {
        if (!els.sheet) return;
        const p = prefill || {};
        resetSheet('new');
        const seq = ++sheet.seq;
        showSheet();
        sheetLoading('Loading…');
        try {
            await basics();
        } catch (e) {
            if (seq === sheet.seq) sheetLoading(e.message);
            return;
        }
        if (seq !== sheet.seq) return;
        const calendars = (state.data.me && state.data.me.calendars) || [];
        if (!state.data.me.can_edit || !calendars.length) {
            sheetLoading('There is no calendar you may add appointments to.');
            return;
        }
        const organizer = (calendars.find(c => c.email === p.organizer) || calendars.find(c => c.mine) || calendars[0]).email;
        const start = p.start || defaultStart();
        const end = p.end && p.end > start ? p.end : addMinutes(start, 60);
        sheet.form = {
            title: p.title || '',
            all_day: !!p.allDay,
            start_date: start.slice(0, 10), start_time: start.slice(11, 16) || '09:00',
            end_date: end.slice(0, 10), end_time: end.slice(11, 16) || '10:00',
            freq: 'NONE', until: '',
            organizer,
            attendees: new Set((p.attendees || []).filter(email => email !== organizer)),
            location: '', url: '', reminder: '', description: '',
        };
        sheet.pendingLinks = (p.links || []).slice();
        renderSheet();
        focusField('title');
    }

    function startEdit() {
        const d = sheet.data;
        const [sd, st] = d.start.split('T');
        const [ed, et] = d.end.split('T');
        sheet.form = {
            title: d.title,
            all_day: d.all_day,
            start_date: sd, start_time: st || '09:00',
            end_date: ed, end_time: et || '10:00',
            freq: d.repeat ? d.repeat.freq : 'NONE',
            until: d.repeat && d.repeat.until ? d.repeat.until : '',
            organizer: d.calendar.email,
            attendees: new Set(d.attendees.filter(a => !a.organizer).map(a => a.email)),
            location: d.location || '',
            url: d.url || '',
            description: d.description || '',
            reminder: d.reminder_custom ? 'custom' : (d.reminder === null ? '' : String(d.reminder)),
        };
        sheet.mode = 'edit';
        sheet.confirm = null;
        renderSheet();
        focusField('title');
    }

    function focusField(name) {
        const field = els.sheet.querySelector(`[data-ef="${name}"]`);
        if (field) field.focus({ preventScroll: true });
    }

    // ---- Rendering -------------------------------------------------------

    function renderSheet() {
        if (!sheetOpen() || !sheet.mode) return;
        const focused = document.activeElement && els.sheet.contains(document.activeElement) ? document.activeElement.dataset.ef : null;
        const editing = sheet.mode === 'edit' || sheet.mode === 'new';
        els.sheet.classList.toggle('is-editing', editing);
        els.sheet.classList.toggle('is-new', sheet.mode === 'new');

        if (sheet.mode === 'masked') {
            const item = sheet.data;
            const owner = person(item.owners[0]);
            els.sheetHead.innerHTML = `<h2 id="esheetTitle">${esc(item.title)}</h2><p class="overview-company esheet-when">${esc(whenLabel(item))}</p>`;
            els.sheetBody.innerHTML = owner ? `<p class="esheet-owner">${face(owner)}<span>${esc(owner.name)}</span></p>` : '';
            els.sheetFoot.innerHTML = '';
            els.sheetActions.innerHTML = '';
            return;
        }

        els.sheetHead.innerHTML = editing
            ? `<input type="text" id="esheetTitle" class="form-input ov-edit-title" data-ef="title" value="${esc(sheet.form.title)}" placeholder="What is it about?" maxlength="255" aria-label="Title">`
            : `<h2 id="esheetTitle">${esc(sheet.data.title)}</h2><p class="overview-company esheet-when">${esc(sheetWhen(sheet.data))}${sheet.data.series ? ' · ' + esc(repeatText(sheet.data)) : ''}</p>`;
        els.sheetBody.innerHTML = (sheet.conflict ? conflictHtml() : '') + (editing ? formHtml() : viewHtml());
        renderFoot();
        if (focused) focusField(focused);
    }

    /** Edit and delete sit in the header as icons; the footer only holds
     *  forms (Save, Create) and confirmations. */
    function renderFoot() {
        els.sheetFoot.innerHTML = footHtml();
        els.sheetActions.innerHTML = actionsHtml();
    }

    function actionsHtml() {
        const d = sheet.data;
        if (sheet.mode !== 'view' || sheet.confirm || !d || !d.can) return '';
        const off = sheet.busy ? ' disabled' : '';
        const shared = d.attendees.length > 1;
        const parts = [];
        if (d.can.edit) {
            parts.push(`<button type="button" class="ov-icon-btn" data-esheet="edit" title="Edit" aria-label="Edit"${off}>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 5.5l4 4"/><path d="M4 20l1-4.5L16 4.5a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2L8.5 19z"/></svg></button>`);
        }
        if (d.can.cancel) {
            const label = shared ? 'Cancel appointment' : 'Delete';
            parts.push(`<button type="button" class="ov-icon-btn ov-icon-danger" data-esheet="cancel" title="${label}" aria-label="${label}"${off}>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 7h15"/><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12"/></svg></button>`);
        }
        return parts.join('');
    }

    function repeatText(d) {
        if (d.repeat_custom) return 'repeats as set on the phone';
        if (!d.repeat) return 'repeats';
        const label = { DAILY: 'every day', WEEKLY: 'every week', MONTHLY: 'every month' }[d.repeat.freq] || 'repeats';
        return label + (d.repeat.until ? ' until ' + dayMonthYearFmt.format(keyDate(d.repeat.until)) : '');
    }

    function reminderText(d) {
        if (d.reminder_custom) return 'As set on the phone';
        const found = REMINDER_CHOICES.find(([value]) => value === String(d.reminder));
        return found ? found[1] : 'No reminder';
    }

    function fact(label, value, wide) {
        return `<div class="overview-detail-item${wide ? ' full-width' : ''}"><span class="detail-label">${esc(label)}</span><span class="detail-value">${value}</span></div>`;
    }

    // Glyphs for the facts of an appointment: an icon says what a line is,
    // the label comes on hover.
    const FACT_ICONS = {
        calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8.5 3v4M15.5 3v4"/>',
        reminder: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
        place: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
        video: '<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="m15.5 10.5 5-3v9l-5-3"/>',
        people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c0-3.3 2.5-5.8 5.5-5.8s5.5 2.5 5.5 5.8"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 6.1M17.5 13.9c1.9.7 3 2.8 3 5.6"/>',
        notes: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12h6M9 15.5h6"/>'
    };

    function iconFact(icon, label, value) {
        return `<div class="esheet-fact"><span class="esheet-fact-icon" title="${esc(label)}" aria-label="${esc(label)}" role="img">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${FACT_ICONS[icon]}</svg>
            </span><div class="esheet-fact-value">${value}</div></div>`;
    }

    function viewHtml() {
        const d = sheet.data;
        const parts = [];
        if (d.can.respond) {
            parts.push(`<div class="esheet-answer" role="group" aria-label="Your answer">
                    <span class="esheet-answer-label">Will you be there?</span>
                    ${[['ACCEPTED', 'Yes'], ['TENTATIVE', 'Maybe'], ['DECLINED', 'No']].map(([value, label]) => `<button type="button"
                        class="esheet-answer-btn${d.my_answer === value ? ' is-on' : ''}" data-esheet-answer="${value}" aria-pressed="${d.my_answer === value}"${sheet.busy ? ' disabled' : ''}>${label}</button>`).join('')}
                </div>`);
        }

        // One line per fact, an icon in front instead of a label.
        const facts = [];
        // A place that is only the video link is said once, by the button.
        if (d.location && d.location.trim() !== d.video_url) facts.push(iconFact('place', 'Where', linkify(d.location)));
        if (d.video_url) {
            facts.push(iconFact('video', 'Video call', `<a class="btn btn-primary btn-small esheet-join" href="${esc(d.video_url)}" target="_blank" rel="noopener noreferrer">Join video call</a>`));
        }
        const people = d.attendees.map(a => personRow(a, person(a.email))).concat(d.guests.map(g => personRow(g, null)));
        facts.push(iconFact('people', 'Who', `<ul class="esheet-people">${people.join('')}</ul>
            ${d.guests.length && d.can.edit ? '<p class="esheet-note">Outside guests don\'t hear about changes made here.</p>' : ''}`));
        if (d.description) facts.push(iconFact('notes', 'Notes', `<div class="esheet-desc">${linkify(d.description)}</div>`));
        facts.push(iconFact('calendar', 'Calendar', esc(d.calendar.name)));
        if (d.reminder !== null || d.reminder_custom) facts.push(iconFact('reminder', 'Reminder', esc(reminderText(d))));
        parts.push(`<div class="overview-section esheet-facts">${facts.join('')}</div>`);
        parts.push(linksHtml(d.links, d.suggestions, d.can.link));
        return parts.join('');
    }

    function personRow(entry, p) {
        const label = ANSWER_LABELS[entry.answer] || ANSWER_LABELS['NEEDS-ACTION'];
        const name = (p && p.name) || entry.name || entry.email;
        const avatar = p ? face(p) : `<span class="tcal-face tcal-face--guest">${esc(name.slice(0, 1).toUpperCase())}</span>`;
        return `<li class="esheet-person">${avatar}
                <span class="esheet-person-name" title="${esc(entry.email)}">${esc(name)}${p && p.is_me ? ' <span class="esheet-you">you</span>' : ''}${p ? '' : ' <span class="esheet-you">guest</span>'}</span>
                <span class="tcal-status ${label[0]}">${esc(label[1])}</span>
            </li>`;
    }

    function linksHtml(links, suggestions, canLink) {
        const picker = sheet.picker;
        const chips = links.map(link => `<span class="esheet-link">
                <button type="button" class="esheet-link-open" data-esheet-open="${link.type}:${link.target_id}" title="Open the ${link.type}">
                    ${linkIcon(link.type)}<span>${esc(link.name)}</span>${link.detail ? `<span class="esheet-link-detail">${esc(link.detail)}</span>` : ''}
                </button>
                ${canLink ? `<button type="button" class="esheet-link-remove" data-esheet-unlink="${link.id === undefined ? 'p:' + link.type + ':' + link.target_id : link.id}" aria-label="Remove the link to ${esc(link.name)}">×</button>` : ''}
            </span>`).join('');
        const suggested = (suggestions || []).filter(s => !links.some(l => l.type === s.type && l.target_id === s.target_id)).map(s => `<p class="esheet-suggest">
                ${linkIcon('contact')}<span><strong>${esc(s.name)}</strong> is a guest and a contact in the CRM.</span>
                <button type="button" class="btn btn-secondary btn-small" data-esheet-link="${s.type}:${s.target_id}" data-name="${esc(s.name)}">Link</button>
            </p>`).join('');
        const search = picker.open ? `<div class="esheet-picker">
                <input type="search" class="form-input" data-esheet-link-q value="${esc(picker.query)}" placeholder="Search contacts and projects…" aria-label="Contact or project" autocomplete="off">
                <div class="esheet-picker-results">${pickerResults()}</div>
            </div>` : '';
        return `<div class="overview-section ov-section esheet-links-section">
                <div class="ov-section-head">
                    <h3 class="overview-section-title">Linked to</h3>
                    ${canLink ? `<button type="button" class="ov-add-btn" data-esheet="link-open" aria-expanded="${picker.open}">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                        Link</button>` : ''}
                </div>
                ${search}
                ${chips ? `<div class="esheet-link-list">${chips}</div>` : (picker.open || suggested ? '' : '<p class="esheet-empty">No contact or project yet.</p>')}
                ${canLink ? suggested : ''}
            </div>`;
    }

    function pickerResults() {
        const picker = sheet.picker;
        if (!picker.query.trim()) return '<p class="esheet-empty">Type a name or company.</p>';
        if (!picker.results.length) return '<p class="esheet-empty">Nothing found.</p>';
        return picker.results.map(r => `<button type="button" class="esheet-picker-item" data-esheet-link="${r.type}:${r.target_id}" data-name="${esc(r.name)}">
                ${linkIcon(r.type)}<span class="esheet-picker-name">${esc(r.name)}</span>${r.detail ? `<span class="esheet-link-detail">${esc(r.detail)}</span>` : ''}
            </button>`).join('');
    }

    function linkIcon(type) {
        return type === 'project'
            ? '<svg class="esheet-link-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5h17v11a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M8.5 7.5V5.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v2"/></svg>'
            : '<svg class="esheet-link-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>';
    }

    function formHtml() {
        const f = sheet.form;
        const d = sheet.data;
        const isNew = sheet.mode === 'new';
        const series = !!(d && d.series);
        const calendars = (state.data.me && state.data.me.calendars) || [];
        const team = state.data.people.filter(p => p.email !== f.organizer);
        const repeatLocked = !!(d && d.repeat_custom);

        const time = name => (f.all_day ? '' : `<input type="time" class="form-input" data-ef="${name}_time" value="${esc(f[name + '_time'])}" step="900" aria-label="${name === 'start' ? 'Start time' : 'End time'}">`);
        const rows = [];
        rows.push(`<label class="esheet-check"><input type="checkbox" data-ef="all_day"${f.all_day ? ' checked' : ''}${series ? ' disabled' : ''}> All day</label>`);
        rows.push(`<div class="esheet-pair">
                <label class="esheet-field"><span>${f.all_day ? 'From' : 'Starts'}</span><span class="esheet-dt">
                    <input type="date" class="form-input" data-ef="start_date" value="${esc(f.start_date)}" aria-label="Start date">${time('start')}</span></label>
                <label class="esheet-field"><span>${f.all_day ? 'To' : 'Ends'}</span><span class="esheet-dt">
                    <input type="date" class="form-input" data-ef="end_date" value="${esc(f.end_date)}" aria-label="End date">${time('end')}</span></label>
            </div>`);
        if (series) {
            rows.push('<p class="esheet-note">This appointment repeats. When you save, choose whether the change is for this one or for the whole series.</p>');
        }
        if (repeatLocked) {
            rows.push(`<div class="esheet-field"><span>Repeats</span><p class="esheet-static">${esc(repeatText(d))}</p></div>`);
        } else {
            rows.push(`<div class="esheet-pair">
                    <label class="esheet-field"><span>Repeats</span><select class="form-select" data-ef="freq">
                        ${REPEAT_CHOICES.map(([value, label]) => `<option value="${value}"${f.freq === value ? ' selected' : ''}>${label}</option>`).join('')}
                    </select></label>
                    ${f.freq !== 'NONE' ? `<label class="esheet-field"><span>Until (optional)</span><input type="date" class="form-input" data-ef="until" value="${esc(f.until)}"></label>` : '<span></span>'}
                </div>`);
        }
        if (isNew) {
            rows.push(`<label class="esheet-field"><span>Calendar</span><select class="form-select" data-ef="organizer">
                    ${calendars.map(c => `<option value="${esc(c.email)}"${c.email === f.organizer ? ' selected' : ''}>${esc(c.name)}${c.mine ? ' (you)' : ''}</option>`).join('')}
                </select></label>`);
        }
        rows.push(`<div class="esheet-field"><span>Participants</span><div class="esheet-choose">
                ${team.length ? team.map(p => `<label class="esheet-choose-person${f.attendees.has(p.email) ? ' is-on' : ''}">
                    <input type="checkbox" data-ef-person="${esc(p.email)}"${f.attendees.has(p.email) ? ' checked' : ''}>${face(p)}<span>${esc(p.name)}</span></label>`).join('')
                    : '<span class="esheet-empty">Nobody else in the team has a calendar here yet.</span>'}
            </div></div>`);
        rows.push(`<div class="esheet-pair">
                <label class="esheet-field"><span>Where</span><input type="text" class="form-input" data-ef="location" value="${esc(f.location)}" maxlength="500" placeholder="Office, address…"></label>
                <label class="esheet-field"><span>Video link</span><input type="url" class="form-input" data-ef="url" value="${esc(f.url)}" maxlength="500" placeholder="https://meet.google.com/…"></label>
            </div>`);
        rows.push(`<label class="esheet-field esheet-field--short"><span>Reminder</span><select class="form-select" data-ef="reminder">
                ${f.reminder === 'custom' ? '<option value="custom" selected>As set on the phone</option>' : ''}
                ${REMINDER_CHOICES.map(([value, label]) => `<option value="${value}"${f.reminder === value ? ' selected' : ''}>${label}</option>`).join('')}
            </select></label>`);
        rows.push(`<label class="esheet-field"><span>Notes</span><textarea class="form-input" data-ef="description" rows="4" maxlength="10000">${esc(f.description)}</textarea></label>`);

        const links = isNew
            ? linksHtml(sheet.pendingLinks, [], true)
            : linksHtml(d.links, d.suggestions, d.can.link);
        const guests = d && d.guests.length
            ? '<p class="esheet-note">Guests from outside the team were invited on a phone. Changes made here do not reach them.</p>' : '';
        return `<div class="overview-section"><div class="esheet-form">${rows.join('')}${guests}</div></div>${links}`;
    }

    function conflictHtml() {
        const c = sheet.conflict;
        if (c.kind === 'deleted' || !c.current) {
            return `<div class="esheet-banner is-gone"><p><strong>Deleted in the meantime.</strong> Somebody removed this appointment - on a phone or in the CRM. Nothing was saved.</p>
                <div class="esheet-banner-actions"><button type="button" class="btn btn-secondary btn-small" data-esheet="close">Close</button></div></div>`;
        }
        return `<div class="esheet-banner"><p><strong>Changed in the meantime.</strong> Somebody changed this appointment while you were at it - on a phone or in the CRM. Nothing was saved${c.action === 'update' ? '; your changes are still here' : ''}.</p>
                <div class="esheet-banner-actions">
                    <button type="button" class="btn btn-secondary btn-small" data-esheet="conflict-show">Show the new version</button>
                    <button type="button" class="btn btn-primary btn-small" data-esheet="conflict-force">${c.action === 'cancel' ? 'Cancel it anyway' : 'Save mine anyway'}</button>
                </div></div>`;
    }

    function footHtml() {
        const off = sheet.busy ? ' disabled' : '';
        if (sheet.mode === 'new') {
            return `<button type="button" class="btn btn-secondary" data-esheet="close"${off}>Cancel</button>
                <button type="button" class="btn btn-primary" data-esheet="save"${off}>${sheet.busy ? 'Creating…' : 'Create appointment'}</button>`;
        }
        if (sheet.mode === 'edit') {
            if (sheet.confirm === 'save-scope') {
                return `<span class="esheet-confirm">Change only this one, or every appointment in the series?</span>
                    <button type="button" class="btn btn-secondary" data-esheet="back"${off}>Back</button>
                    <button type="button" class="btn btn-secondary" data-esheet="save-occurrence"${off}>Only this one</button>
                    <button type="button" class="btn btn-primary" data-esheet="save-series"${off}>The whole series</button>`;
            }
            return `<button type="button" class="btn btn-secondary" data-esheet="edit-cancel"${off}>Cancel</button>
                <button type="button" class="btn btn-primary" data-esheet="save"${off}>${sheet.busy ? 'Saving…' : 'Save'}</button>`;
        }
        const d = sheet.data;
        if (!d || !d.can) return '';
        const shared = d.attendees.length > 1;
        if (sheet.confirm === 'cancel') {
            return `<span class="esheet-confirm">${shared ? 'Cancel it for everyone? It disappears from every calendar.' : 'Delete this appointment?'}</span>
                <button type="button" class="btn btn-secondary" data-esheet="back"${off}>Back</button>
                <button type="button" class="btn btn-danger" data-esheet="cancel-series"${off}>${shared ? 'Cancel for everyone' : 'Delete'}</button>`;
        }
        if (sheet.confirm === 'cancel-scope') {
            return `<span class="esheet-confirm">Cancel only this one, or the whole series${shared ? ' for everyone' : ''}?</span>
                <button type="button" class="btn btn-secondary" data-esheet="back"${off}>Back</button>
                <button type="button" class="btn btn-secondary" data-esheet="cancel-occurrence"${off}>Only this one</button>
                <button type="button" class="btn btn-danger" data-esheet="cancel-series-all"${off}>The whole series</button>`;
        }
        return '';
    }

    // ---- What changed, and saving ---------------------------------------

    function formTimes(f) {
        if (f.all_day) return { start: f.start_date, end: f.end_date };
        return { start: f.start_date + 'T' + f.start_time, end: f.end_date + 'T' + f.end_time };
    }

    function fullBody(f) {
        const times = formTimes(f);
        return {
            title: f.title.trim(), all_day: f.all_day, start: times.start, end: times.end,
            location: f.location.trim(), url: f.url.trim(), description: f.description,
            attendees: Array.from(f.attendees),
            repeat: f.freq === 'NONE' ? null : { freq: f.freq, until: f.until || null },
            reminder: f.reminder === '' || f.reminder === 'custom' ? null : Number(f.reminder),
        };
    }

    /** Only what the person changed - so a change made meanwhile elsewhere survives in every other field. */
    function changedBody() {
        const d = sheet.data;
        const f = sheet.form;
        const body = {};
        if (f.title.trim() !== d.title) body.title = f.title.trim();
        if (f.location.trim() !== (d.location || '')) body.location = f.location.trim();
        if (f.url.trim() !== (d.url || '')) body.url = f.url.trim();
        if (f.description !== (d.description || '')) body.description = f.description;
        const times = formTimes(f);
        if (times.start !== d.start || times.end !== d.end || f.all_day !== d.all_day) {
            Object.assign(body, { start: times.start, end: times.end, all_day: f.all_day });
        }
        const before = d.attendees.filter(a => !a.organizer).map(a => a.email).sort().join(',');
        const after = Array.from(f.attendees).sort().join(',');
        if (before !== after) body.attendees = Array.from(f.attendees);
        if (!d.repeat_custom) {
            const was = d.repeat ? d.repeat.freq + '|' + (d.repeat.until || '') : 'NONE|';
            const now = f.freq === 'NONE' ? 'NONE|' : f.freq + '|' + (f.until || '');
            if (was !== now) body.repeat = f.freq === 'NONE' ? null : { freq: f.freq, until: f.until || null };
        }
        if (f.reminder !== 'custom') {
            const reminder = f.reminder === '' ? null : Number(f.reminder);
            if (d.reminder_custom || reminder !== d.reminder) body.reminder = reminder;
        }
        return body;
    }

    function warnings(list, done) {
        if (list && list.length) {
            toast(list.join(' '), true);
        } else if (done) {
            toast(done);
        }
    }

    /** The calendar, and the contact or project sheet underneath, show what changed. */
    function afterChange() {
        if (state.data) load({ skipSync: true });
        refreshLinked();
    }

    async function submit(request, done, context) {
        if (sheet.busy) return;
        sheet.busy = true;
        renderFoot();
        try {
            const result = await request();
            sheet.busy = false;
            done(result);
        } catch (e) {
            sheet.busy = false;
            if (e.status === 409 && context) {
                sheet.conflict = Object.assign({ kind: e.payload.conflict, current: e.payload.current }, context);
                sheet.confirm = null;
                renderSheet();
                els.sheetBody.scrollTop = 0;
                return;
            }
            toast(e.message, true);
            if (sheetOpen()) renderFoot();
        }
    }

    function saveSheet(scope) {
        const f = sheet.form;
        if (!f.title.trim()) {
            toast('Give the appointment a title.', true);
            focusField('title');
            return;
        }
        if (sheet.mode === 'new') {
            const body = Object.assign(fullBody(f), {
                organizer: f.organizer,
                links: sheet.pendingLinks.map(l => ({ type: l.type, target_id: l.target_id })),
            });
            submit(() => api({ action: 'event' }, { method: 'POST', body: JSON.stringify(body) }), result => {
                warnings(result.warnings, 'Appointment created.');
                afterChange();
                openEvent(result.uid, result.occurrence);
            });
            return;
        }
        const body = changedBody();
        if (!Object.keys(body).length) {
            sheet.mode = 'view';
            renderSheet();
            return;
        }
        const d = sheet.data;
        if (d.series && !scope) {
            if (body.attendees || 'repeat' in body) {
                scope = 'series';
            } else {
                sheet.confirm = 'save-scope';
                renderFoot();
                return;
            }
        }
        sendUpdate(Object.assign(body, { base: d.base }), scope || 'series');
    }

    function sendUpdate(body, scope) {
        const d = sheet.data;
        submit(() => api({ action: 'event', uid: d.uid, occurrence: d.occurrence || '', scope }, { method: 'PATCH', body: JSON.stringify(body) }), result => {
            warnings(result.warnings, 'Saved.');
            afterChange();
            // Moving a whole series moves the occurrence too: show the calendar.
            if (d.series && scope === 'series' && 'start' in body) {
                closeSheet();
            } else {
                openEvent(d.uid, d.occurrence);
            }
        }, { action: 'update', body, scope });
    }

    function cancelEvent(scope, base) {
        const d = sheet.data;
        submit(() => api({ action: 'event', uid: d.uid, occurrence: d.occurrence || '', scope, base: base || d.base }, { method: 'DELETE' }), result => {
            warnings(result.warnings, result.cancelled === 'occurrence' ? 'This one is cancelled.' : (d.attendees.length > 1 ? 'Cancelled for everyone.' : 'Deleted.'));
            afterChange();
            closeSheet();
        }, { action: 'cancel', body: null, scope });
    }

    function answer(value) {
        const d = sheet.data;
        submit(() => api({ action: 'respond', uid: d.uid }, { method: 'POST', body: JSON.stringify({ answer: value }) }), result => {
            warnings(result.warnings, 'Answer saved.');
            afterChange();
            openEvent(d.uid, d.occurrence);
        });
    }

    // ---- Links -------------------------------------------------------------

    async function addLink(type, targetId, name) {
        sheet.picker.open = false;
        sheet.picker.query = '';
        sheet.picker.results = [];
        if (sheet.mode === 'new') {
            if (!sheet.pendingLinks.some(l => l.type === type && l.target_id === targetId)) {
                sheet.pendingLinks.push({ type, target_id: targetId, name });
            }
            renderSheet();
            return;
        }
        try {
            const result = await api({ action: 'link' }, { method: 'POST', body: JSON.stringify({ uid: sheet.data.uid, type, target_id: targetId }) });
            sheet.data.links = result.links;
            renderSheet();
            refreshLinked();
        } catch (e) {
            toast(e.message, true);
        }
    }

    async function removeLink(key) {
        if (key.startsWith('p:')) {
            const [, type, id] = key.split(':');
            sheet.pendingLinks = sheet.pendingLinks.filter(l => !(l.type === type && String(l.target_id) === id));
            renderSheet();
            return;
        }
        try {
            const result = await api({ action: 'link', id: key }, { method: 'DELETE' });
            sheet.data.links = result.links;
            renderSheet();
            refreshLinked();
        } catch (e) {
            toast(e.message, true);
        }
    }

    function searchTargets(query) {
        const picker = sheet.picker;
        picker.query = query;
        clearTimeout(picker.timer);
        const seq = ++picker.seq;
        const results = () => els.sheetBody.querySelector('.esheet-picker-results');
        if (!query.trim()) {
            picker.results = [];
            if (results()) results().innerHTML = pickerResults();
            return;
        }
        picker.timer = setTimeout(async () => {
            try {
                const found = await api({ action: 'link_targets', q: query.trim() });
                if (seq !== picker.seq) return;
                picker.results = found;
                if (results()) results().innerHTML = pickerResults();
            } catch (e) {
                // A failed search just shows nothing.
            }
        }, 180);
    }

    // ---- Contact and project sheets: their appointments --------------------

    const linkedView = { type: null, id: null, el: null, seq: 0 };

    async function renderLinked(type, id, el) {
        if (!el) return;
        Object.assign(linkedView, { type, id, el });
        const seq = ++linkedView.seq;
        const section = el.closest('.overview-section');
        const add = section ? section.querySelector('[data-tcal-new-for]') : null;
        if (add) {
            add.hidden = !canCreate();
            add.dataset.targetId = String(id);
        }
        el.innerHTML = '<p class="tcal-linked-empty">Loading…</p>';
        try {
            const data = await api({ action: 'linked', type, id });
            if (seq !== linkedView.seq) return;
            el.innerHTML = linkedHtml(data);
        } catch (e) {
            if (seq === linkedView.seq) el.innerHTML = `<p class="tcal-linked-empty">${esc(e.message)}</p>`;
        }
    }

    function refreshLinked() {
        const { type, id, el } = linkedView;
        const modal = el ? el.closest('.modal') : null;
        if (type && el && (!modal || modal.classList.contains('active'))) {
            renderLinked(type, id, el);
        }
    }

    function linkedHtml(data) {
        const people = data.people || [];
        const row = item => {
            const list = people.filter(p => item.people.includes(p.email));
            const when = item.all_day ? shortDayFmt.format(keyDate(item.start)) + ' · all day' : shortDayFmt.format(keyDate(wall(new Date(item.start)).key)) + ' · ' + fmtTime(item.start);
            return `<button type="button" class="tcal-linked-item${item.mine ? ' is-mine' : ''}" data-tcal-open="${esc(item.uid)}" data-occurrence="${esc(item.occurrence || '')}">
                    <span class="tcal-linked-when">${esc(when)}</span>
                    <span class="tcal-linked-title">${esc(item.title)}</span>
                    <span class="tcal-faces">${list.slice(0, 4).map(face).join('')}</span>
                </button>`;
        };
        if (!data.upcoming.length && !data.past.length) {
            return '<p class="tcal-linked-empty">No appointments linked yet.</p>';
        }
        return (data.upcoming.length ? `<div class="tcal-linked-group"><span class="tcal-linked-label">Coming up</span>${data.upcoming.map(row).join('')}</div>` : '')
            + (data.past.length ? `<div class="tcal-linked-group"><span class="tcal-linked-label">Earlier</span>${data.past.map(row).join('')}</div>` : '');
    }

    // =========================================================================
    // Find a free slot
    // =========================================================================

    const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    /** As CalendarSettings::BUFFERS. */
    const BUFFERS = [0, 10, 15, 30, 45, 60];

    function freeRange() {
        const today = todayKey();
        if (state.free.range === 'week') {
            const start = weekStart(state.date);
            return [start < today ? today : start, addDays(start, 7)];
        }
        return [today, addDays(today, Number(state.free.range) || 7)];
    }

    function renderFree() {
        if (!state.data) return;
        const people = state.data.people;
        const chosen = state.free.people || visiblePeople().map(p => p.email);
        const minutes = [30, 45, 60, 90, 120, 180];
        const ranges = [['week', 'This week'], ['7', 'Next 7 days'], ['14', 'Next 14 days'], ['31', 'Next 31 days']];

        let results = '';
        if (state.free.busy) {
            results = '<p class="tcal-free-note">Looking…</p>';
        } else if (state.free.error) {
            results = `<p class="tcal-free-note is-error">${esc(state.free.error)}</p>`;
        } else if (state.free.results) {
            if (!state.free.results.length) {
                results = '<p class="tcal-free-note">No common free time in that range.</p>';
            } else {
                const byDay = new Map();
                state.free.results.forEach((slot, index) => {
                    const key = wall(new Date(slot.start)).key;
                    if (!byDay.has(key)) byDay.set(key, []);
                    byDay.get(key).push({ slot, index });
                });
                results = '<div class="tcal-free-list">' + Array.from(byDay.entries()).map(([key, list]) => `
                        <div class="tcal-free-day">
                            <span class="tcal-free-dayname">${esc(shortDayFmt.format(keyDate(key)))}</span>
                            <span class="tcal-free-slots">${list.map(({ slot, index }) => `<button type="button" class="tcal-free-slot" data-tcal-slot="${index}">
                                ${esc(fmtTime(slot.start))}–${esc(fmtTime(slot.end))}<span class="tcal-free-len">${esc(durationLabel(slot.minutes))}</span>
                            </button>`).join('')}</span>
                        </div>`).join('') + '</div>';
            }
        }

        els.free.innerHTML = `<div class="tcal-free-card">
                <div class="tcal-free-controls">
                    <div class="tcal-free-group">
                        <span class="tcal-free-label">Who</span>
                        <div class="tcal-picks" role="group" aria-label="Who">${people.map(p => personToggle(p, chosen.includes(p.email), 'data-tcal-free-person')).join('')}</div>
                    </div>
                    <div class="tcal-free-group">
                        <label class="tcal-free-label" for="tcalFreeMinutes">How long</label>
                        <select id="tcalFreeMinutes" class="form-select" data-tcal-free="minutes">
                            ${minutes.map(m => `<option value="${m}"${m === state.free.minutes ? ' selected' : ''}>${esc(durationLabel(m))}</option>`).join('')}
                        </select>
                    </div>
                    <div class="tcal-free-group">
                        <label class="tcal-free-label" for="tcalFreeRange">When</label>
                        <select id="tcalFreeRange" class="form-select" data-tcal-free="range">
                            ${ranges.map(([value, label]) => `<option value="${value}"${value === state.free.range ? ' selected' : ''}>${esc(label)}</option>`).join('')}
                        </select>
                    </div>
                    <button type="button" class="btn btn-primary btn-small" data-tcal="free-search"${state.free.busy ? ' disabled' : ''}>Find</button>
                    ${state.slots.length ? '<button type="button" class="btn btn-secondary btn-small" data-tcal="free-clear">Clear</button>' : ''}
                </div>
                ${freeHint()}
                ${results}
            </div>`;
    }

    /** Working hours and buffer in one line; admins can change them right there. */
    function freeHint() {
        const wh = state.data.working_hours;
        const buffer = wh.buffer ? `${esc(durationLabel(wh.buffer))} buffer before &amp; after appointments` : 'no buffer';
        const change = state.data.me && state.data.me.is_admin
            ? ' <button type="button" class="tcal-free-change" data-tcal="change-hours">Change</button>' : '';
        return `<p class="tcal-free-hint">Working hours: ${esc(wh.start)}–${esc(wh.end)}; ${buffer}.${change}</p>`;
    }

    async function searchFree() {
        const chosen = state.free.people || visiblePeople().map(p => p.email);
        if (!chosen.length) {
            state.free.error = 'Choose at least one person.';
            renderFree();
            return;
        }
        const [from, to] = freeRange();
        state.free.busy = true;
        state.free.error = null;
        renderFree();
        try {
            const result = await api({ action: 'free_slots', people: chosen.join(','), minutes: state.free.minutes, from, to });
            state.free.results = result.slots;
            state.free.searched = { people: result.people, minutes: state.free.minutes };
            state.slots = result.slots;
        } catch (e) {
            state.free.error = e.message;
            state.free.results = null;
        } finally {
            state.free.busy = false;
            render();
        }
    }

    function toggleFree(open) {
        state.free.open = open === undefined ? !state.free.open : open;
        els.free.hidden = !state.free.open;
        if (els.freeBtn) {
            els.freeBtn.setAttribute('aria-expanded', state.free.open ? 'true' : 'false');
            els.freeBtn.classList.toggle('is-active', state.free.open);
        }
        if (state.free.open) renderFree();
    }

    /** Show the week (or day) of a found slot, scrolled to it. */
    function showSlot(slot) {
        state.date = wall(new Date(slot.start)).key;
        load({ skipSync: true }).then(() => {
            const scroll = els.body.querySelector('.tcal-scroll');
            if (scroll) scroll.scrollTop = Math.max(0, wall(new Date(slot.start)).minutes - 45) * HOUR_PX / 60;
        });
    }

    // =========================================================================
    // Settings
    // =========================================================================

    const VISIBILITY_LABELS = { details: 'Details', private: 'Private' };
    // Show or hide a calendar in the CRM.
    const EYE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
    const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-2.6 3.4M6.3 6.9C3.9 8.5 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1"/><path d="M9.9 10a2.8 2.8 0 0 0 4 4"/><path d="m3.5 3.5 17 17"/></svg>';

    /** focus: 'hours' opens it at the working hours and buffer. */
    async function openSettings(focus) {
        els.scrim.hidden = false;
        els.settings.hidden = false;
        els.settings.innerHTML = '<div class="tcal-drawer-loading">Loading…</div>';
        try {
            state.settings = await api({ action: 'settings' });
            renderSettings();
            const section = focus === 'hours' && els.settings.querySelector('[data-tcal-set="hours"]');
            if (section) {
                section.scrollIntoView({ block: 'start' });
                const field = section.querySelector('[data-tcal-hours="start"]');
                if (field) field.focus({ preventScroll: true });
            }
        } catch (e) {
            els.settings.innerHTML = `<div class="tcal-drawer-loading">${esc(e.message)}</div>`;
        }
    }

    function closeSettings() {
        els.settings.hidden = true;
        els.scrim.hidden = true;
        els.settings.innerHTML = '';
    }

    function renderSettings() {
        const s = state.settings;
        if (!s) return;
        const admin = !!s.is_admin;
        const peopleList = admin ? s.people : (state.data ? state.data.people : []);
        const known = state.data ? state.data.people : [];
        const ownerHead = email => {
            const p = peopleList.find(x => x.email === email);
            const shown = known.find(x => x.email === email);
            return `${shown ? face(shown) : ''}<span>${esc(p ? p.name : email)}</span>`;
        };
        const select = (attrs, options, current, label) => `<select class="form-select tcal-set-select" ${attrs} aria-label="${esc(label)}">
                ${options.map(([value, text]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(text)}</option>`).join('')}
            </select>`;

        // Calendars: one row each - shown or not, name, kind, what others see.
        const byOwner = new Map();
        s.sources.forEach(source => {
            if (!byOwner.has(source.owner_email)) byOwner.set(source.owner_email, []);
            byOwner.get(source.owner_email).push(source);
        });
        const grid = admin ? 'is-admin' : '';
        const calendars = byOwner.size ? `
                <div class="tcal-set-cols ${grid}" aria-hidden="true">
                    <span></span>${admin ? '<span>Kind</span>' : ''}<span>Others see</span>${admin ? '<span></span>' : ''}
                </div>` + Array.from(byOwner.entries()).map(([owner, sources]) => `
                <div class="tcal-set-owner">
                    <div class="tcal-set-owner-name">${ownerHead(owner)}</div>
                    ${sources.map(source => `<div class="tcal-set-cal ${grid}${source.enabled ? '' : ' is-off'}">
                        <span class="tcal-set-cal-name">${esc(source.name)}${source.writable ? '' : ' <span class="tcal-set-muted" title="The calendar account may only read it">read only</span>'}</span>
                        ${admin ? select(`data-tcal-source="${source.id}" data-field="kind"`, [['work', 'Work'], ['private', 'Private']], source.kind, 'Kind') : ''}
                        ${select(`data-tcal-source="${source.id}" data-field="visibility"`, Object.entries(VISIBILITY_LABELS), source.visibility, 'Others see')}
                        ${admin ? `<button type="button" class="tcal-set-icon tcal-set-eye" data-tcal-toggle-source="${source.id}" data-enabled="${source.enabled ? 1 : 0}"
                            title="${source.enabled ? 'Hide in the CRM' : 'Show in the CRM'}" aria-label="${source.enabled ? 'Hide' : 'Show'} ${esc(source.name)}" aria-pressed="${source.enabled ? 'false' : 'true'}">
                            ${source.enabled ? EYE_ICON : EYE_OFF_ICON}
                        </button>` : ''}
                        ${source.last_error ? `<p class="tcal-set-error">${esc(source.last_error)}</p>` : ''}
                    </div>`).join('')}
                </div>`).join('') : '<p class="tcal-set-muted">None shared yet.</p>';

        let adminSections = '';
        if (admin) {
            const accounts = s.accounts || [];
            const arrow = d => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
            const people = (s.people || []).map((p, i, all) => `<div class="tcal-set-person${p.user_id === null || p.user_id === undefined ? ' has-name' : ''}">
                    <label class="tcal-set-color" style="--swatch:${esc(p.color)}" title="Colour, where there is no profile picture">
                        <input type="color" value="${esc(p.color)}" data-tcal-person-field="color" data-email="${esc(p.email)}" aria-label="Colour of ${esc(p.name)}">
                    </label>
                    ${p.user_id === null || p.user_id === undefined
                        ? `<input type="text" class="form-input tcal-set-name" value="${esc(p.name)}" maxlength="80" data-tcal-person-field="name" data-email="${esc(p.email)}" aria-label="Name" title="Without a CRM account: the name the calendar shows">`
                        : ''}
                    ${select(`data-tcal-person-field="user_id" data-email="${esc(p.email)}"`, [['', 'No CRM account']].concat(accounts.map(a => [String(a.id), a.name])), p.user_id === null || p.user_id === undefined ? '' : String(p.user_id), 'CRM account')}
                    <span class="tcal-set-move">
                        <button type="button" class="tcal-set-icon" data-tcal-move="up" data-email="${esc(p.email)}" title="Move up" aria-label="Move up"${i === 0 ? ' disabled' : ''}>${arrow('m6 14.5 6-6 6 6')}</button>
                        <button type="button" class="tcal-set-icon" data-tcal-move="down" data-email="${esc(p.email)}" title="Move down" aria-label="Move down"${i === all.length - 1 ? ' disabled' : ''}>${arrow('m6 9.5 6 6 6-6')}</button>
                    </span>
                </div>`).join('');

            // Working hours save as soon as something changes.
            const wh = s.working_hours;
            adminSections = `
                <section class="tcal-set-section">
                    <h4>People</h4>
                    ${people || '<p class="tcal-set-muted">Nobody yet.</p>'}
                </section>
                <section class="tcal-set-section" data-tcal-set="hours">
                    <h4>Working hours</h4>
                    <div class="tcal-set-days" role="group" aria-label="Working days">${DAY_NAMES.map((name, i) => `<label class="tcal-set-day" title="${name}">
                        <input type="checkbox" data-tcal-hours-day="${i + 1}"${wh.days.includes(i + 1) ? ' checked' : ''}><span>${name.slice(0, 2)}</span></label>`).join('')}</div>
                    <div class="tcal-set-times">
                        <input type="time" class="form-input tcal-set-select" data-tcal-hours="start" value="${esc(wh.start)}" step="900" aria-label="From">
                        <span class="tcal-set-dash">–</span>
                        <input type="time" class="form-input tcal-set-select" data-tcal-hours="end" value="${esc(wh.end)}" step="900" aria-label="To">
                        <label class="tcal-set-buffer"><span>Buffer</span>${select('data-tcal-hours="buffer"', BUFFERS.map(m => [String(m), m ? durationLabel(m) : 'None']), String(wh.buffer), 'Buffer before and after appointments')}</label>
                    </div>
                </section>`;
        }

        const discoverBtn = admin
            ? `<button type="button" class="ov-icon-btn tcal-discover" data-tcal="discover" title="Look for new shares (also once a day by itself)" aria-label="Look for new shares">
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/></svg>
                </button>`
            : '';

        els.settings.innerHTML = `<div class="tcal-drawer-head">
                <h3>Calendar settings</h3>
                <div class="ov-head-actions">${discoverBtn}<button type="button" class="modal-close" data-tcal="close-settings" aria-label="Close">&times;</button></div>
            </div>
            <div class="tcal-drawer-body">
                <section class="tcal-set-section">
                    <h4>${admin ? 'Calendars' : 'Your calendars'}</h4>
                    ${calendars}
                </section>
                ${adminSections}
            </div>`;
    }

    async function updateSource(id, field, value) {
        try {
            await api({ action: 'source', id }, { method: 'PATCH', body: JSON.stringify({ [field]: value }) });
            state.settings = await api({ action: 'settings' });
            renderSettings();
            load({ skipSync: true });
            toast('Saved.');
        } catch (e) {
            toast(e.message, true);
            if (state.settings) renderSettings();
        }
    }

    async function updatePerson(email, body) {
        try {
            await api({ action: 'person', email }, { method: 'PATCH', body: JSON.stringify(body) });
            state.settings = await api({ action: 'settings' });
            renderSettings();
            load({ skipSync: true });
        } catch (e) {
            toast(e.message, true);
            if (state.settings) renderSettings();
        }
    }

    async function saveHours() {
        const days = Array.from(els.settings.querySelectorAll('[data-tcal-hours-day]')).filter(box => box.checked).map(box => Number(box.dataset.tcalHoursDay));
        const start = els.settings.querySelector('[data-tcal-hours="start"]').value;
        const end = els.settings.querySelector('[data-tcal-hours="end"]').value;
        const buffer = Number(els.settings.querySelector('[data-tcal-hours="buffer"]').value);
        try {
            await api({ action: 'working_hours' }, { method: 'PATCH', body: JSON.stringify({ days, start, end, buffer }) });
            state.settings = await api({ action: 'settings' });
            renderSettings();
            load({ skipSync: true });
            toast('Saved.');
        } catch (e) {
            toast(e.message, true);
        }
    }

    async function discover(button) {
        if (button) {
            button.disabled = true;
            button.classList.add('is-busy');
        }
        try {
            const result = await api({ action: 'discover' }, { method: 'POST' });
            toast(result.discovered ? `Found ${result.discovered} new calendar${result.discovered > 1 ? 's' : ''}.` : 'No new calendars.');
            state.settings = await api({ action: 'settings' });
            renderSettings();
            load({ skipSync: true });
        } catch (e) {
            toast(e.message, true);
            if (state.settings) renderSettings();
        }
    }

    // =========================================================================
    // Events
    // =========================================================================

    function go(direction) {
        state.date = direction === 0 ? todayKey() : addDays(state.date, direction * (state.mode === 'week' ? 7 : 1));
        load();
    }

    function setMode(mode) {
        if (mode === state.mode) return;
        state.mode = mode;
        savePrefs();
        load();
    }

    root.addEventListener('click', event => {
        const target = event.target.closest('[data-tcal], [data-tcal-mode], [data-tcal-person], [data-tcal-free-person], [data-tcal-item], [data-tcal-day], [data-tcal-slot], [data-tcal-slot-mark], [data-tcal-col]');
        if (!target || !root.contains(target)) return;

        if (target.dataset.tcalFreePerson) {
            const email = target.dataset.tcalFreePerson;
            const chosen = new Set(state.free.people || visiblePeople().map(p => p.email));
            if (chosen.has(email)) chosen.delete(email); else chosen.add(email);
            state.free.people = Array.from(chosen);
            renderFree();
            return;
        }

        if (target.dataset.tcalItem) {
            const item = state.data && state.data.items.find(i => i.id === target.dataset.tcalItem);
            if (!item) return;
            if (item.masked || !item.uid) {
                openMasked(item);
            } else {
                openEvent(item.uid, item.occurrence);
            }
            return;
        }
        if (target.dataset.tcalSlotMark !== undefined) {
            // A free slot found by the search: book it, with the people searched for.
            const slot = state.slots[Number(target.dataset.tcalSlotMark)];
            if (slot && canCreate()) {
                const searched = state.free.searched || { people: [], minutes: 60 };
                const start = localOf(slot.start);
                openNewEvent({ start, end: addMinutes(start, Math.min(searched.minutes, Math.max(15, minutesBetween(start, localOf(slot.end))))), attendees: searched.people });
            }
            return;
        }
        if (target.dataset.tcalCol) {
            // An empty spot in a day: a new appointment there, on the half hour.
            if (!canCreate()) return;
            const rect = target.getBoundingClientRect();
            const minutes = Math.max(0, Math.min(23 * 60 + 30, Math.floor((event.clientY - rect.top) / HOUR_PX * 2) * 30));
            const start = target.dataset.tcalCol + 'T' + minutesLabel(minutes);
            openNewEvent({ start, end: addMinutes(start, 60) });
            return;
        }
        if (target.dataset.tcalDay && !target.dataset.tcal) {
            // A day's heading in the week opens that day.
            state.date = target.dataset.tcalDay;
            state.mode = 'day';
            savePrefs();
            load();
            return;
        }
        if (target.dataset.tcalMode) {
            setMode(target.dataset.tcalMode);
            return;
        }
        if (target.dataset.tcalPerson) {
            const email = target.dataset.tcalPerson;
            if (state.hidden.has(email)) state.hidden.delete(email); else state.hidden.add(email);
            savePrefs();
            render();
            return;
        }
        if (target.dataset.tcalSlot !== undefined && state.free.results) {
            const slot = state.free.results[Number(target.dataset.tcalSlot)];
            if (slot) showSlot(slot);
            return;
        }

        switch (target.dataset.tcal) {
            case 'prev': go(-1); break;
            case 'next': go(1); break;
            case 'today': go(0); break;
            case 'sync': maybeSync(true); break;
            case 'new': openNewEvent({}); break;
            case 'free': toggleFree(); break;
            case 'free-search': searchFree(); break;
            case 'free-clear':
                state.slots = [];
                state.free.results = null;
                state.free.searched = null;
                render();
                break;
            case 'settings': openSettings(); break;
            case 'change-hours': openSettings('hours'); break;
            default: break;
        }
    });

    root.addEventListener('change', event => {
        const target = event.target;
        if (target.dataset.tcalFree === 'minutes') {
            state.free.minutes = Number(target.value);
        } else if (target.dataset.tcalFree === 'range') {
            state.free.range = target.value;
        }
    });

    // A profile picture that cannot be loaded falls back to the initials -
    // in the calendar, the sheet and the contact and project sheets alike.
    // (No inline onerror: the CSP does not allow inline handlers.)
    document.addEventListener('error', event => {
        const img = event.target;
        const holder = img instanceof HTMLImageElement ? img.closest('.tcal-face') : null;
        if (!holder) return;
        holder.classList.remove('has-photo');
        holder.textContent = holder.dataset.initials || '?';
    }, true);

    // ---- The sheet ---------------------------------------------------------

    if (els.sheet) {
        els.sheet.addEventListener('click', event => {
            const target = event.target.closest('[data-esheet], [data-esheet-answer], [data-esheet-link], [data-esheet-unlink], [data-esheet-open]');
            if (!target || sheet.busy) return;
            if (target.dataset.esheetAnswer) {
                answer(target.dataset.esheetAnswer);
                return;
            }
            if (target.dataset.esheetLink) {
                const [type, id] = target.dataset.esheetLink.split(':');
                addLink(type, Number(id), target.dataset.name || '');
                return;
            }
            if (target.dataset.esheetUnlink) {
                removeLink(target.dataset.esheetUnlink);
                return;
            }
            if (target.dataset.esheetOpen) {
                // A linked contact or project: its own sheet.
                const [type, id] = target.dataset.esheetOpen.split(':');
                if (sheet.mode === 'edit' || sheet.mode === 'new') return;
                closeSheet();
                if (window.CRM) {
                    if (type === 'contact' && window.CRM.openOverview) window.CRM.openOverview(Number(id));
                    if (type === 'project' && window.CRM.openProjectOverview) window.CRM.openProjectOverview(Number(id));
                }
                return;
            }
            switch (target.dataset.esheet) {
                case 'close':
                    // The backdrop does not throw away what is being typed.
                    if (target.classList.contains('modal-backdrop') && (sheet.mode === 'edit' || sheet.mode === 'new')) return;
                    closeSheet();
                    break;
                case 'edit': startEdit(); break;
                case 'edit-cancel':
                    sheet.mode = 'view';
                    sheet.conflict = null;
                    sheet.confirm = null;
                    renderSheet();
                    break;
                case 'save': saveSheet(null); break;
                case 'save-occurrence': saveSheet('occurrence'); break;
                case 'save-series': saveSheet('series'); break;
                case 'back':
                    sheet.confirm = null;
                    renderFoot();
                    break;
                case 'cancel':
                    sheet.confirm = sheet.data.series && sheet.data.occurrence ? 'cancel-scope' : 'cancel';
                    renderFoot();
                    break;
                case 'cancel-series': cancelEvent('series'); break;
                case 'cancel-series-all': cancelEvent('series'); break;
                case 'cancel-occurrence': cancelEvent('occurrence'); break;
                case 'conflict-show':
                    sheet.data = sheet.conflict.current;
                    sheet.conflict = null;
                    sheet.mode = 'view';
                    renderSheet();
                    break;
                case 'conflict-force': {
                    const c = sheet.conflict;
                    sheet.conflict = null;
                    if (c.action === 'cancel') {
                        sheet.data = c.current;
                        renderSheet();
                        cancelEvent(c.scope, c.current.base);
                    } else {
                        // Mine on top of the new version: only what I changed.
                        const keep = { uid: sheet.data.uid, occurrence: sheet.data.occurrence };
                        sheet.data = Object.assign({}, c.current, keep);
                        sendUpdate(Object.assign({}, c.body, { base: c.current.base }), c.scope);
                    }
                    break;
                }
                case 'link-open':
                    sheet.picker.open = !sheet.picker.open;
                    renderSheet();
                    if (sheet.picker.open) {
                        const input = els.sheet.querySelector('[data-esheet-link-q]');
                        if (input) input.focus();
                    }
                    break;
                default: break;
            }
        });

        els.sheet.addEventListener('input', event => {
            const target = event.target;
            if (target.matches('[data-esheet-link-q]')) {
                searchTargets(target.value);
                return;
            }
            const field = target.dataset.ef;
            if (!field || !sheet.form) return;
            if (['title', 'location', 'url', 'description'].includes(field)) {
                sheet.form[field] = target.value;
            }
        });

        els.sheet.addEventListener('change', event => {
            const target = event.target;
            if (!sheet.form) return;
            if (target.dataset.efPerson) {
                if (target.checked) sheet.form.attendees.add(target.dataset.efPerson); else sheet.form.attendees.delete(target.dataset.efPerson);
                const chip = target.closest('.esheet-choose-person');
                if (chip) chip.classList.toggle('is-on', target.checked);
                return;
            }
            const field = target.dataset.ef;
            if (!field) return;
            const f = sheet.form;
            if (field === 'all_day') {
                f.all_day = target.checked;
                if (f.end_date < f.start_date) f.end_date = f.start_date;
                renderSheet();
            } else if (field === 'start_date' || field === 'start_time') {
                // Moving the start keeps the length.
                const before = formTimes(f);
                const length = f.all_day ? minutesBetween(before.start + 'T00:00', before.end + 'T00:00') : minutesBetween(before.start, before.end);
                f[field] = target.value;
                if (!f.start_date || (!f.all_day && !f.start_time)) return;
                const startLocal = f.start_date + 'T' + (f.all_day ? '00:00' : f.start_time);
                const end = addMinutes(startLocal, Math.max(f.all_day ? 0 : 15, length));
                f.end_date = end.slice(0, 10);
                if (!f.all_day) f.end_time = end.slice(11, 16);
                renderSheet();
            } else if (field === 'end_date' || field === 'end_time') {
                f[field] = target.value;
            } else if (field === 'freq') {
                f.freq = target.value;
                renderSheet();
            } else if (field === 'until' || field === 'reminder') {
                f[field] = target.value;
            } else if (field === 'organizer') {
                f.organizer = target.value;
                f.attendees.delete(f.organizer);
                renderSheet();
            } else if (['title', 'location', 'url', 'description'].includes(field)) {
                f[field] = target.value;
            }
        });
    }

    // Before the CRM's own Escape handling: the sheet sits on top of the
    // contact and project sheets, and only it should react.
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !sheetOpen()) return;
        event.stopImmediatePropagation();
        event.preventDefault();
        if (sheet.picker.open) {
            sheet.picker.open = false;
            renderSheet();
        } else if (sheet.confirm) {
            sheet.confirm = null;
            renderFoot();
        } else if (sheet.mode === 'edit') {
            sheet.mode = 'view';
            sheet.conflict = null;
            renderSheet();
        } else {
            closeSheet();
        }
    }, true);

    // Appointments in the contact and project sheets.
    document.addEventListener('click', event => {
        const open = event.target.closest('[data-tcal-open]');
        if (open) {
            openEvent(open.dataset.tcalOpen, open.dataset.occurrence || null);
            return;
        }
        const add = event.target.closest('[data-tcal-new-for]');
        if (add && add.dataset.targetId) {
            const type = add.dataset.tcalNewFor;
            const id = Number(add.dataset.targetId);
            const modal = add.closest('.modal');
            const titleEl = modal ? modal.querySelector('h2') : null;
            openNewEvent({ links: [{ type, target_id: id, name: titleEl ? titleEl.textContent.trim() : '' }] });
        }
    });

    // ---- Settings ----------------------------------------------------------

    els.settings.addEventListener('click', event => {
        const target = event.target.closest('[data-tcal], [data-tcal-move], [data-tcal-toggle-source]');
        if (!target) return;
        if (target.dataset.tcalToggleSource) {
            updateSource(target.dataset.tcalToggleSource, 'enabled', target.dataset.enabled !== '1');
        } else if (target.dataset.tcalMove) {
            updatePerson(target.dataset.email, { move: target.dataset.tcalMove });
        } else if (target.dataset.tcal === 'close-settings') {
            closeSettings();
        } else if (target.dataset.tcal === 'discover') {
            discover(target);
        }
    });

    els.settings.addEventListener('change', event => {
        const target = event.target;
        if (target.dataset.tcalSource) {
            const value = target.type === 'checkbox' ? target.checked : target.value;
            updateSource(target.dataset.tcalSource, target.dataset.field, value);
        } else if (target.dataset.tcalPersonField) {
            const field = target.dataset.tcalPersonField;
            let value = target.value;
            if (field === 'user_id') value = value === '' ? null : Number(value);
            if (field === 'name' && !value.trim()) {
                renderSettings();
                return;
            }
            updatePerson(target.dataset.email, { [field]: value });
        } else if (target.dataset.tcalHoursDay || target.dataset.tcalHours) {
            saveHours();
        }
    });

    els.scrim.addEventListener('click', closeSettings);

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !els.settings.hidden) closeSettings();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden || !els.panel || !els.panel.classList.contains('active')) return;
        if (Date.now() - state.loadedAt > 60 * 1000) load();
    });

    // =========================================================================

    function open() {
        startRefresh();
        if (!state.data || Date.now() - state.loadedAt > 60 * 1000) {
            load();
        } else {
            render();
            maybeSync(false);
        }
    }

    window.CRMCalendar = { open, openEvent, openNewEvent, renderLinked };
})();
