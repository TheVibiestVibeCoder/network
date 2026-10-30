/**
 * Meeting assistant (TEST) - the weekly project meeting, one project at a time.
 *
 * "Start meeting" on the Projects tab opens a window over the CRM: the
 * project's details on one side, a field for what Claude should do on the
 * other. Moving to the previous or next project, or ending the meeting,
 * hands what was typed to Claude in the background (api/meeting.php); its
 * to-dos, notes and changes appear under "From Claude" for the team to
 * accept or reject.
 *
 * Nothing typed is lost: the meeting - position, drafts, what Claude did -
 * is kept in this browser (localStorage) until it is finished, so closing
 * the window, reloading or closing the page picks up where it was. The
 * window can also shrink into a small panel in the corner (project and text
 * field only) while something else in the CRM is looked up.
 *
 * To remove the test, see the list at the top of includes/MeetingAssistant.php.
 */
(function () {
    'use strict';

    const API = 'api/meeting.php';
    const STORAGE_KEY = 'crm-meeting';
    // A meeting left alone this long is not picked up again.
    const STALE_MS = 3 * 24 * 60 * 60 * 1000;
    const KIND_LABELS = {
        todo: 'To-do',
        note: 'Note',
        update_project: 'Change',
        complete_todo: 'Done',
        assign_project: 'Responsible',
        reassign_todo: 'Reassign',
        link_contact: 'Contact',
        unlink_contact: 'Contact out'
    };

    // The CRM's own sheets, opened over the meeting to edit what it shows.
    const SHEETS = ['projectOverviewModal', 'todoDetailModal'];

    const ICON_PREV = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m11 6-6 6 6 6"/></svg>';
    const ICON_NEXT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
    const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
    // Picture in picture: the meeting goes to a small window in the corner.
    const ICON_MINIMIZE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12.5" y="12" width="6" height="4.5" rx="1" fill="currentColor" stroke="none"/></svg>';
    const ICON_EXPAND = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 3.5h6v6"/><path d="M20.5 3.5 14 10"/><path d="M9.5 20.5h-6v-6"/><path d="M3.5 20.5 10 14"/></svg>';
    // Claude's mark, as on "From Claude" in the sidebar.
    const ICON_CLAUDE = '<svg class="meeting-claude-mark" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>';
    // A tray: what was proposed stays waiting under From Claude.
    const ICON_KEEP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/><path d="M5.5 5.5h13l2 8v4.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-4.5z"/></svg>';
    const ICON_DONE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

    const state = {
        active: false,
        ended: false,
        // 'open' (the big window), 'mini' (the corner panel) or 'hidden'.
        mode: 'hidden',
        projects: [],
        index: 0,
        context: null,
        // What was typed per project and not yet handed to Claude.
        drafts: {},
        // Everything handed to Claude in this meeting:
        // { id, projectId, projectName, text, status, result, error }
        // status: 'working' | 'done' | 'failed' | 'interrupted' (the page
        // closed while Claude worked - the outcome is unknown here).
        jobs: [],
        // The From Claude proposals this meeting made, for the summary:
        // { items: [...review items], loading, error }.
        review: { items: [], loading: false, error: '' }
    };

    let modal = null;
    let mini = null;
    let jobSeq = 0;

    // ------------------------------------------------------------------
    // Helpers
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

    async function request(url, options = {}) {
        const init = { method: options.method || 'GET', headers: {} };
        if (init.method !== 'GET') init.headers['X-CSRF-Token'] = getCsrfToken();
        if (options.json !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(options.json);
        }
        const response = await fetch(url, init);
        let payload = null;
        try {
            payload = await response.json();
        } catch (e) {
            payload = null;
        }
        if (!response.ok || !payload || payload.success === false || payload.error) {
            throw new Error((payload && payload.error) || `Request failed (${response.status})`);
        }
        return payload;
    }

    function stageClass(stage) {
        return String(stage || 'Lead').toLowerCase().replace(/ /g, '-');
    }

    function formatDate(value) {
        if (!value) return '';
        const date = new Date(String(value).slice(0, 10) + 'T00:00:00');
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function formatMoney(value) {
        if (value === null || value === undefined || value === '') return '';
        return Number(value).toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' €';
    }

    function currentProject() {
        return state.projects[state.index] || null;
    }

    function jobsFor(projectId) {
        return state.jobs.filter(job => job.projectId === projectId);
    }

    function working() {
        return state.jobs.filter(job => job.status === 'working').length;
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    // ------------------------------------------------------------------
    // Keeping the meeting in this browser
    // ------------------------------------------------------------------

    function persist() {
        try {
            if (!state.active) {
                localStorage.removeItem(STORAGE_KEY);
                return;
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                savedAt: Date.now(),
                ended: state.ended,
                mode: state.mode,
                projects: state.projects,
                index: state.index,
                drafts: state.drafts,
                jobs: state.jobs.map(({ id, projectId, projectName, text, status, result, error }) =>
                    ({ id, projectId, projectName, text, status, result, error }))
            }));
        } catch (e) {
            // Private mode or full storage: the meeting still works, only
            // without surviving a reload.
        }
    }

    /** Pick up a meeting this browser had open, with everything typed in it. */
    function restore() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        } catch (e) {
            saved = null;
        }
        if (!saved || !Array.isArray(saved.projects) || !saved.projects.length) return;

        const hasText = Object.values(saved.drafts || {}).some(text => text && text.trim());
        if (Date.now() - (saved.savedAt || 0) > STALE_MS && !hasText) {
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to clean */ }
            return;
        }

        state.active = true;
        state.ended = !!saved.ended;
        state.projects = saved.projects;
        state.index = Math.min(Math.max(0, saved.index || 0), saved.projects.length - 1);
        state.drafts = saved.drafts || {};
        state.jobs = (saved.jobs || []).map(job => ({
            ...job,
            // A request the page did not see the end of.
            status: job.status === 'working' ? 'interrupted' : job.status
        }));
        jobSeq = state.jobs.reduce((max, job) => Math.max(max, job.id || 0), 0);
        state.mode = 'hidden';

        updateStartButton();
        // The corner panel comes back as it was; the big window waits for
        // "Continue meeting".
        if (saved.mode === 'mini' && !state.ended) {
            buildElements();
            minimize();
            loadContext();
        }
    }

    // ------------------------------------------------------------------
    // The meeting
    // ------------------------------------------------------------------

    /** Start a meeting, or come back to the one still open. */
    async function start() {
        buildElements();
        if (state.active) {
            open();
            if (state.ended) loadProposals();
            else if (!state.context) loadContext();
            return;
        }

        state.ended = false;
        state.index = 0;
        state.drafts = {};
        state.jobs = [];
        try {
            state.projects = (await request(`${API}?action=projects`)).data || [];
        } catch (error) {
            alert(error.message);
            return;
        }
        if (state.projects.length === 0) {
            alert('There are no open projects to go through.');
            return;
        }

        state.active = true;
        open();
        await loadContext();
    }

    function open() {
        saveDraft();
        state.mode = 'open';
        mini.hidden = true;
        modal.classList.add('active');
        render();
        persist();
        updateStartButton();
        focusText();
    }

    /** Into the corner: project and text field only, the CRM usable behind. */
    function minimize() {
        saveDraft();
        state.mode = 'mini';
        modal.classList.remove('active');
        mini.hidden = false;
        render();
        persist();
        updateStartButton();
        const input = mini.querySelector('.meeting-draft');
        if (input) input.focus();
    }

    /** Put the meeting away; it stays where it was, with what was typed. */
    function hide() {
        saveDraft();
        state.mode = 'hidden';
        modal.classList.remove('active');
        mini.hidden = true;
        persist();
        updateStartButton();
    }

    async function loadContext() {
        const project = currentProject();
        state.context = null;
        render();
        if (!project) return;
        try {
            const result = await request(`${API}?action=context&id=${encodeURIComponent(project.id)}`);
            if (currentProject() === project) state.context = result.data;
        } catch (error) {
            if (currentProject() === project) state.context = { error: error.message };
        }
        render();
        if (state.mode === 'open') focusText();
    }

    /** Fetch the project again after a change, keeping what is on screen meanwhile. */
    async function refreshContext() {
        const project = currentProject();
        if (!project) return;
        try {
            const result = await request(`${API}?action=context&id=${encodeURIComponent(project.id)}`);
            if (currentProject() === project) {
                state.context = result.data;
                render();
            }
        } catch (error) {
            // The old view stays; the next move loads it fresh anyway.
        }
    }

    // ------------------------------------------------------------------
    // Working on the project from the meeting
    // ------------------------------------------------------------------

    let sheetWatch = null;

    function sheetOpen() {
        return SHEETS.some(id => {
            const sheet = document.getElementById(id);
            return sheet && sheet.classList.contains('active');
        });
    }

    /**
     * Open one of the CRM's own sheets over the meeting: the meeting steps
     * behind it, and comes back - showing the changes - once it is closed.
     */
    function overSheet(openSheet) {
        if (!window.CRM) return;
        saveDraft();
        persist();
        modal.classList.add('is-under');
        if (!sheetWatch) {
            sheetWatch = new MutationObserver(() => {
                if (modal.classList.contains('is-under') && !sheetOpen()) {
                    modal.classList.remove('is-under');
                    refreshContext();
                    focusText();
                }
            });
            SHEETS.forEach(id => {
                const sheet = document.getElementById(id);
                if (sheet) sheetWatch.observe(sheet, { attributes: true, attributeFilter: ['class'] });
            });
        }
        openSheet(window.CRM);
    }

    async function completeTodo(todoId, checkbox) {
        const row = checkbox.closest('.ptodo');
        if (row) row.classList.add('todo-completed');
        try {
            await request(`api/todos.php?id=${encodeURIComponent(todoId)}`, { method: 'PUT', json: { is_completed: 1 } });
        } catch (error) {
            if (row) row.classList.remove('todo-completed');
            checkbox.checked = false;
            alert(error.message);
            return;
        }
        // A moment to see it ticked before it leaves the open list.
        setTimeout(refreshContext, 600);
    }

    async function removeContact(contactId, name) {
        const project = currentProject();
        if (!project || !confirm(`Remove ${name} from ${project.name}?`)) return;
        try {
            await request('api/projects.php?action=unassign-contact', {
                method: 'DELETE',
                json: { project_id: project.id, contact_id: contactId }
            });
        } catch (error) {
            alert(error.message);
            return;
        }
        refreshContext();
    }

    /** Hand what was typed for the project on screen to Claude, if anything. */
    function submitCurrent() {
        saveDraft();
        const project = currentProject();
        if (!project) return;
        const text = (state.drafts[project.id] || '').trim();
        if (!text) return;
        state.drafts[project.id] = '';
        // Emptied in the fields too, or the next drawing would keep it again.
        document.querySelectorAll('.meeting-draft').forEach(input => { input.value = ''; });
        runJob({ id: ++jobSeq, projectId: project.id, projectName: project.name, text, status: 'working' });
    }

    async function runJob(job) {
        if (!state.jobs.includes(job)) state.jobs.push(job);
        job.status = 'working';
        job.error = '';
        render();
        persist();
        try {
            const result = await request(`${API}?action=submit`, { method: 'POST', json: { project_id: job.projectId, text: job.text } });
            job.result = result.data;
            job.status = 'done';
        } catch (error) {
            job.error = error.message;
            job.status = 'failed';
        }
        // A meeting finished meanwhile has nothing left to keep.
        if (state.jobs.includes(job)) {
            render();
            persist();
            if (state.ended) loadProposals();
        }

        // The proposals count in the "From Claude" badge and on the project cards.
        if (job.status === 'done') {
            if (window.CRMReview && window.CRMReview.refreshBadge) window.CRMReview.refreshBadge();
            if (state.mode !== 'open') {
                document.dispatchEvent(new CustomEvent('crm:review-changed', { detail: { action: 'meeting' } }));
            }
        }
    }

    function go(step) {
        const next = state.index + step;
        if (next < 0 || next >= state.projects.length) return;
        submitCurrent();
        state.index = next;
        persist();
        loadContext();
    }

    function end() {
        submitCurrent();
        state.ended = true;
        if (state.mode !== 'open') open(); else render();
        persist();
        loadProposals();
    }

    /** After the summary: the meeting is over and forgotten here. */
    function finish() {
        const stillWorking = working();
        state.active = false;
        state.ended = false;
        state.mode = 'hidden';
        state.jobs = [];
        state.drafts = {};
        meetingOrigins.clear();
        modal.classList.remove('active');
        mini.hidden = true;
        persist();
        updateStartButton();
        if (!stillWorking) {
            document.dispatchEvent(new CustomEvent('crm:review-changed', { detail: { action: 'meeting' } }));
        }
    }

    /** Keep what is in the field on screen, for the project it was drawn for. */
    function saveDraft() {
        // Put away, neither field is the one being typed in; the drafts were
        // taken when it was put away.
        if (state.mode === 'hidden') return;
        let input = null;
        if (state.mode === 'mini' && mini) input = mini.querySelector('.meeting-draft');
        else if (modal) input = modal.querySelector('.meeting-draft');
        if (input && input.dataset.projectId) state.drafts[input.dataset.projectId] = input.value;
    }

    function focusText() {
        const input = modal && modal.querySelector('.meeting-draft');
        if (input && state.mode === 'open') input.focus();
    }

    function updateStartButton() {
        const label = document.getElementById('startMeetingLabel');
        if (label) label.textContent = state.active ? 'Continue meeting' : 'Start meeting';
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    function buildElements() {
        if (modal) return;
        modal = document.createElement('div');
        modal.className = 'modal meeting-modal';
        modal.id = 'meetingModal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', 'Project meeting');
        modal.innerHTML = '<div class="modal-backdrop" data-meeting-close></div><div class="modal-content meeting-content"></div>';
        document.body.appendChild(modal);

        mini = document.createElement('div');
        mini.className = 'meeting-mini';
        mini.id = 'meetingMini';
        mini.hidden = true;
        mini.setAttribute('role', 'region');
        mini.setAttribute('aria-label', 'Project meeting');
        document.body.appendChild(mini);

        bindElements();
    }

    function render() {
        if (!modal) return;
        saveDraft();
        if (state.mode === 'mini') {
            mini.innerHTML = miniHtml();
        } else {
            modal.querySelector('.meeting-content').innerHTML = state.ended ? summaryHtml() : projectHtml();
        }
    }

    function draftField(project, extraClass, rows) {
        return `<textarea class="form-input meeting-draft ${extraClass}" maxlength="8000" ${rows ? `rows="${rows}"` : ''}
                          data-project-id="${project.id}" aria-label="For Claude"
                          placeholder="What is new, what is next, who does it?&#10;&#10;e.g. Kickoff went well. Anna does the moodboard by Friday, Livio sends the offer. Budget up to 24k.">${escapeHtml(state.drafts[project.id] || '')}</textarea>`;
    }

    function projectHtml() {
        const project = currentProject();
        if (!project) return '';
        const ctx = state.context;
        const count = state.projects.length;
        const busy = working();

        return `
            <header class="meeting-head">
                <div class="meeting-head-main">
                    <div class="meeting-head-meta">
                        <span class="meeting-stage stage-${stageClass(project.stage)}">${escapeHtml(project.stage)}</span>
                        <span class="meeting-position">Project ${state.index + 1} of ${count}</span>
                        <span class="meeting-test-tag">Test</span>
                    </div>
                    <h2 class="meeting-title">${escapeHtml(project.name)}</h2>
                    ${project.company ? `<p class="meeting-company">${escapeHtml(project.company)}</p>` : ''}
                </div>
                <div class="meeting-head-actions">
                    <button type="button" class="meeting-icon-btn" data-meeting-minimize title="Minimize - keep typing while you look something up" aria-label="Minimize">${ICON_MINIMIZE}</button>
                    <button type="button" class="meeting-icon-btn" data-meeting-close title="Close - the meeting and your text stay" aria-label="Close">${ICON_CLOSE}</button>
                </div>
            </header>

            <div class="meeting-body">
                <section class="meeting-details" aria-label="Project details">
                    ${ctx ? (ctx.error ? `<p class="meeting-error">${escapeHtml(ctx.error)}</p>` : detailsHtml(ctx)) : '<p class="empty-hint">Loading…</p>'}
                </section>

                <section class="meeting-input">
                    <span class="meeting-label">For Claude</span>
                    ${draftField(project, 'meeting-text')}
                    <p class="meeting-hint">${ICON_CLAUDE}<span>When you move on, Claude turns this into to-dos, notes and changes under <strong>From Claude</strong>.</span></p>
                    ${jobsHtml(jobsFor(project.id))}
                </section>
            </div>

            <footer class="meeting-foot">
                <button type="button" class="btn btn-secondary" data-meeting-end>End meeting</button>
                <span class="meeting-status" role="status">${busy ? `<span class="meeting-spinner" aria-hidden="true"></span>Claude is working on ${plural(busy, 'project')}` : ''}</span>
                <div class="meeting-nav">
                    <button type="button" class="btn btn-secondary" data-meeting-prev ${state.index === 0 ? 'disabled' : ''}>${ICON_PREV}<span>Previous</span></button>
                    <button type="button" class="btn btn-primary" data-meeting-next ${state.index === count - 1 ? 'disabled' : ''} title="${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} + Enter"><span>Next project</span>${ICON_NEXT}</button>
                </div>
            </footer>`;
    }

    function miniHtml() {
        const project = currentProject();
        if (!project) return '';
        const busy = working();
        return `
            <div class="meeting-mini-head">
                <span class="meeting-mini-dot stage-${stageClass(project.stage)}" aria-hidden="true"></span>
                <div class="meeting-mini-title">
                    <span class="meeting-mini-name">${escapeHtml(project.name)}</span>
                    <span class="meeting-mini-meta">Project ${state.index + 1} of ${state.projects.length}${busy ? ` · <span class="meeting-spinner" aria-hidden="true"></span> Claude working` : ''}</span>
                </div>
                <button type="button" class="meeting-icon-btn" data-meeting-expand title="Back to the meeting" aria-label="Expand">${ICON_EXPAND}</button>
                <button type="button" class="meeting-icon-btn" data-meeting-close title="Close - the meeting and your text stay" aria-label="Close">${ICON_CLOSE}</button>
            </div>
            ${draftField(project, 'meeting-mini-text', 4)}`;
    }

    /** Two letters, as on every face without a photo (app.js getInitials). */
    function initials(name) {
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        return (parts.length === 1 ? parts[0].substring(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function personChip(id, name) {
        if (!name) return '';
        const key = Number(id) === 0 ? 'owner' : String(id);
        const url = window.CRMPeople && window.CRMPeople.avatarFor ? window.CRMPeople.avatarFor(key, name) : null;
        return `<span class="assignee-chip${url ? ' has-photo' : ''}" title="Assigned to ${escapeHtml(name)}">${url ? `<img src="${escapeHtml(url)}" alt="">` : escapeHtml(initials(name))}</span>`;
    }

    /** The project as its own detail sheet shows it, read-only. */
    function detailsHtml(ctx) {
        const p = ctx.project;
        const budget = p.budget_min || p.budget_max
            ? [formatMoney(p.budget_min), formatMoney(p.budget_max)].filter(Boolean).join(' – ')
            : '';
        const fact = (label, value) => `
            <div class="overview-detail-item">
                <span class="detail-label">${label}</span>
                <span class="detail-value">${value}</span>
            </div>`;
        const priorityWord = { high: 'High', medium: 'Medium', low: 'Low' };

        return `
            <div class="overview-section">
                <div class="ov-section-head">
                    <h3 class="overview-section-title">Project Information</h3>
                    <button type="button" class="ov-add-btn" data-meeting-open-project data-mode="edit" title="Edit the project">Edit</button>
                </div>
                <div class="overview-details">
                    ${fact('Stage', `<span class="meeting-stage stage-${stageClass(p.stage)}">${escapeHtml(p.stage)}</span>`)}
                    ${fact('Responsible', p.assigned_to_name
                        ? `<span class="meeting-person">${personChip(p.assigned_to, p.assigned_to_name)}${escapeHtml(p.assigned_to_name)}</span>`
                        : 'Nobody')}
                    ${fact('Budget', escapeHtml(budget || 'N/A'))}
                    ${fact('Success Chance', escapeHtml(p.success_chance !== null ? p.success_chance + '%' : 'N/A'))}
                    ${fact('Start Date', escapeHtml(p.start_date ? formatDate(p.start_date) : 'N/A'))}
                    ${fact('Est. Completion', escapeHtml(p.estimated_completion ? formatDate(p.estimated_completion) : 'N/A'))}
                    <div class="overview-detail-item full-width">
                        <span class="detail-label">Description</span>
                        <span class="detail-value meeting-description">${escapeHtml(p.description || 'No description')}</span>
                    </div>
                </div>
            </div>

            <div class="overview-section">
                <div class="ov-section-head">
                    <h3 class="overview-section-title">Assigned Contacts</h3>
                    <button type="button" class="ov-add-btn" data-meeting-open-project title="Add contacts in the project">Add</button>
                </div>
                ${ctx.contacts && ctx.contacts.length ? `<div class="project-contacts-list">${ctx.contacts.map(c => `
                    <span class="pcontact-chip" title="${escapeHtml(c.company ? `${c.name} · ${c.company}` : c.name)}">
                        <span class="pcontact-avatar">${escapeHtml(initials(c.name))}</span>
                        <span class="pcontact-name">${escapeHtml(c.name)}</span>
                        <button type="button" class="pcontact-remove" data-meeting-remove-contact="${c.id}" data-name="${escapeHtml(c.name)}" title="Remove from the project" aria-label="Remove ${escapeHtml(c.name)}">&times;</button>
                    </span>`).join('')}</div>` : '<p class="empty-hint">No contacts assigned</p>'}
            </div>

            <div class="overview-section">
                <h3 class="overview-section-title">To-Dos</h3>
                ${ctx.todos.length ? `<div class="ptodo-card">${ctx.todos.map(t => `
                    <div class="todo-item ptodo" data-todo-id="${t.id}">
                        <div class="ptodo-row">
                            <label class="todo-check" title="Mark as completed">
                                <input type="checkbox" data-meeting-toggle-todo="${t.id}">
                                <span class="todo-check-indicator"></span>
                            </label>
                            <button type="button" class="ptodo-title" data-meeting-open-todo="${t.id}" title="Open to edit or reassign">${escapeHtml(t.title)}</button>
                            <span class="ptodo-meta">
                                ${t.priority ? `<span class="todo-priority todo-priority--${escapeHtml(t.priority)}">${escapeHtml(priorityWord[t.priority] || t.priority)}</span>` : ''}
                                ${t.due_date ? `<span class="todo-due">${escapeHtml(formatDate(t.due_date))}</span>` : ''}
                                ${personChip(t.assigned_to, t.assigned_to_name) || '<span class="ptodo-no-assignee" aria-hidden="true"></span>'}
                            </span>
                        </div>
                    </div>`).join('')}</div>` : '<p class="empty-hint">No open to-dos</p>'}
            </div>

            <div class="overview-section">
                <h3 class="overview-section-title">Notes</h3>
                ${ctx.notes.length ? `<div class="meeting-notes">${ctx.notes.slice(0, 3).map(n => `
                    <div class="note-item" data-meeting-note title="Show all">
                        <div class="note-header">
                            <span class="note-date">${escapeHtml(formatDate(n.created_at))}</span>
                            ${n.author_name ? `<span class="meeting-note-author">${escapeHtml(n.author_name)}</span>` : ''}
                        </div>
                        <div class="note-content">${escapeHtml(n.content)}</div>
                    </div>`).join('')}</div>` : '<p class="empty-hint">No notes yet</p>'}
            </div>`;
    }

    function jobHead(job) {
        switch (job.status) {
            case 'working':
                return '<span class="meeting-spinner" aria-hidden="true"></span><span>Claude is working on this…</span>';
            case 'done':
                return `${ICON_DONE}<span>${job.result.created.length ? `${plural(job.result.created.length, 'proposal')} under From Claude` : 'Nothing to change'}</span>`;
            case 'interrupted':
                return `<span>The page closed while Claude worked on this. Check From Claude before sending it again.</span>
                        <button type="button" class="btn btn-secondary btn-small" data-meeting-retry="${job.id}">Send again</button>`;
            default:
                return `<span>Not processed: ${escapeHtml(job.error)}</span>
                        <button type="button" class="btn btn-secondary btn-small" data-meeting-retry="${job.id}">Try again</button>`;
        }
    }

    /** What was already handed to Claude for this project in this meeting. */
    function jobsHtml(jobs) {
        if (!jobs.length) return '';
        return `<div class="meeting-jobs">${jobs.map(job => `
            <div class="meeting-job meeting-job--${job.status}">
                <div class="meeting-job-head">${jobHead(job)}</div>
                <p class="meeting-job-text">${escapeHtml(job.text)}</p>
                ${job.status === 'done' && job.result.created.length ? `<ul class="meeting-job-items">${job.result.created.map(item => `
                    <li><span class="meeting-kind">${escapeHtml(KIND_LABELS[item.type] || item.type)}</span>${escapeHtml(item.label)}</li>`).join('')}</ul>` : ''}
                ${job.status === 'done' && job.result.failed.length ? `<p class="meeting-job-failed">${escapeHtml(job.result.failed.join(' '))}</p>` : ''}
            </div>`).join('')}</div>`;
    }

    // ------------------------------------------------------------------
    // The summary: what the meeting proposed, project by project
    // ------------------------------------------------------------------

    // Proposals tied to their project by their reason (originByReason).
    const meetingOrigins = new Map();

    /** Which project each proposal of this meeting came from, by review id. */
    function proposalOrigins() {
        const origins = new Map(meetingOrigins);
        state.jobs.forEach(job => {
            ((job.result && job.result.review_ids) || []).forEach(id => origins.set(Number(id), job.projectId));
        });
        return origins;
    }

    /**
     * A proposal's reason quotes what was typed ("From the project meeting on
     * 30.10.2026: "..."), which ties it to its job even when the job did not
     * keep the ids - one sent before they were kept, say. Only this meeting's
     * texts match, so older proposals never come along.
     */
    function originByReason(item) {
        const comment = String(item.comment || '');
        if (!comment.startsWith('From the project meeting on ')) return null;
        const job = state.jobs.find(j => j.status === 'done' && j.text && comment.includes('"' + j.text.trim().slice(0, 200)));
        return job ? job.projectId : null;
    }

    /** Load this meeting's proposals as From Claude has them now, decided or not. */
    async function loadProposals() {
        const origins = proposalOrigins();
        if (!state.jobs.some(job => job.status === 'done')) {
            state.review = { items: [], loading: false, error: '' };
            render();
            return;
        }
        state.review.loading = true;
        render();
        try {
            const [pending, resolved] = await Promise.all([
                request('api/review.php?action=list&status=pending'),
                request('api/review.php?action=list&status=resolved')
            ]);
            // In the order they were made, decided or not, so nothing jumps around.
            const items = (pending.data || []).concat(resolved.data || [])
                .filter(item => {
                    if (origins.has(Number(item.id))) return true;
                    const projectId = originByReason(item);
                    if (projectId === null) return false;
                    meetingOrigins.set(Number(item.id), projectId);
                    return true;
                })
                .sort((a, b) => a.id - b.id);
            state.review = { items, loading: false, error: '' };
        } catch (error) {
            state.review = { items: state.review.items, loading: false, error: error.message };
        }
        render();
    }

    function openProposals(items) {
        const review = window.CRMReview;
        return items.filter(item => item.status === 'pending' && !(review && review.isHeld(item.id)));
    }

    /**
     * Accept everything this meeting proposed that still waits - through
     * From Claude itself, with its questions and its Undo - and finish.
     * Backing out of a question leaves the meeting open.
     */
    async function finishAccepting() {
        const review = window.CRMReview;
        const open = openProposals(state.review.items);
        if (open.length && review && review.decideItems) {
            if (!(await review.decideItems(open, 'accept'))) return;
        }
        finish();
    }

    function summaryHtml() {
        const review = window.CRMReview;
        const busy = working();
        // Decided a moment ago and waiting out its Undo: on its way out.
        const items = state.review.items.filter(item => !(item.status === 'pending' && review && review.isHeld(item.id)));
        const open = items.filter(item => item.status === 'pending');
        const origins = proposalOrigins();
        const failedJobs = state.jobs.filter(job => job.status === 'failed' || job.status === 'interrupted');
        const unsent = state.projects.filter(p => (state.drafts[p.id] || '').trim());
        const draw = list => (review && review.renderItems ? review.renderItems(list) : '');

        // Projects in meeting order, each with what was proposed for it.
        const groups = state.projects.map(project => ({
            project,
            items: items.filter(item => origins.get(Number(item.id)) === project.id),
            jobs: state.jobs.filter(job => job.projectId === project.id)
        })).filter(group => group.items.length || group.jobs.length);

        const groupHtml = groups.map(({ project, items: groupItems, jobs }) => {
            const waiting = groupItems.filter(item => item.status === 'pending');
            const decided = groupItems.filter(item => item.status !== 'pending');
            const running = jobs.some(job => job.status === 'working');
            const problems = jobs.filter(job => job.status === 'failed' || job.status === 'interrupted');
            const nothing = !groupItems.length && !running && !problems.length;
            return `
                <section class="review-group mrev-group" aria-label="${escapeHtml(project.name)}">
                    <div class="mrev-group-head">
                        <h2 class="review-group-title">
                            <span class="meeting-stage stage-${stageClass(project.stage)}">${escapeHtml(project.stage)}</span>
                            ${escapeHtml(project.name)}
                            ${waiting.length ? `<span class="review-group-count">${waiting.length}</span>` : ''}
                        </h2>
                    </div>
                    ${running ? '<p class="mrev-note"><span class="meeting-spinner" aria-hidden="true"></span>Claude is still working on this project…</p>' : ''}
                    ${waiting.length ? draw(waiting) : ''}
                    ${decided.length ? `
                        <div class="review-subgroup mrev-decided">
                            <h3 class="review-subgroup-title">Decided <span class="review-subgroup-count">${decided.length}</span></h3>
                            ${draw(decided)}
                        </div>` : ''}
                    ${nothing ? '<p class="mrev-note">Claude found nothing to change here.</p>' : ''}
                    ${problems.map(job => `
                        <div class="mrev-problem">
                            <span>${job.status === 'interrupted' ? 'The page closed while Claude worked on this - check From Claude.' : 'Not processed: ' + escapeHtml(job.error)}</span>
                            <button type="button" class="btn btn-secondary btn-small" data-meeting-retry="${job.id}">${job.status === 'interrupted' ? 'Send again' : 'Try again'}</button>
                        </div>`).join('')}
                </section>`;
        }).join('');

        const decidedCount = items.length - open.length;
        return `
            <header class="meeting-head">
                <div class="meeting-head-main">
                    <div class="meeting-head-meta"><span class="meeting-test-tag">Test</span></div>
                    <h2 class="meeting-title">Meeting finished</h2>
                    <p class="meeting-company">${busy
                        ? `Claude is still working on ${plural(busy, 'project')} - its proposals appear here when it is done.`
                        : items.length
                            ? `Everything Claude proposed in this meeting, project by project: ${open.length
                                ? plural(open.length, 'proposal') + ' waiting' + (decidedCount ? `, ${decidedCount} decided` : '')
                                : `all ${decidedCount} decided`}.`
                            : 'Claude proposed no changes in this meeting.'}</p>
                </div>
                <div class="meeting-head-actions">
                    <button type="button" class="meeting-icon-btn" data-meeting-close title="Close - you can come back to this" aria-label="Close">${ICON_CLOSE}</button>
                </div>
            </header>
            <div class="meeting-summary">
                ${state.review.error ? `<p class="meeting-error">${escapeHtml(state.review.error)}</p>` : ''}
                ${state.review.loading && !items.length ? '<p class="empty-hint">Loading the proposals…</p>' : ''}
                <div class="review-list">
                    ${groupHtml || (state.jobs.length ? '' : '<p class="empty-hint">Nothing was handed to Claude in this meeting.</p>')}
                </div>
                ${unsent.length ? `<p class="meeting-hint mrev-unsent">Text not sent yet: ${unsent.map(p => escapeHtml(p.name)).join(', ')}. <button type="button" class="btn btn-secondary btn-small" data-meeting-resume>Back to the meeting</button></p>` : ''}
                ${failedJobs.length ? '<p class="meeting-hint">Projects that did not go through keep their text here until you finish the meeting.</p>' : ''}
            </div>
            <footer class="meeting-foot">
                <button type="button" class="btn btn-primary meeting-claude-btn" data-meeting-review ${busy ? 'disabled' : ''}>${ICON_CLAUDE}<span>Go to From Claude</span></button>
                <span class="meeting-status"></span>
                <div class="meeting-nav">
                    <button type="button" class="btn btn-secondary" data-meeting-finish ${busy ? 'disabled' : ''}
                            title="${open.length ? 'Finish; the proposals stay open under From Claude' : 'Finish the meeting'}">${open.length ? `${ICON_KEEP}<span>Finish, keep open</span>` : `${ICON_DONE}<span>Finish meeting</span>`}</button>
                    ${open.length ? `<button type="button" class="btn btn-primary meeting-accept-btn" data-meeting-finish-accept ${busy ? 'disabled' : ''}
                            title="Accept all ${open.length} waiting proposals from this meeting, then finish">${ICON_DONE}<span>Finish & accept all ${open.length}</span></button>` : ''}
                </div>
            </footer>`;
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function handleClick(event) {
        const target = event.target;
        if (target.closest('[data-meeting-close]')) hide();
        else if (target.closest('[data-meeting-minimize]')) minimize();
        else if (target.closest('[data-meeting-expand]')) open();
        else if (target.closest('[data-meeting-prev]')) go(-1);
        else if (target.closest('[data-meeting-next]')) go(1);
        else if (target.closest('[data-meeting-end]')) end();
        else if (target.closest('[data-meeting-finish]')) finish();
        else if (target.closest('[data-meeting-open-project]')) {
            const project = currentProject();
            if (!project) return;
            // "Add" (contacts) opens the sheet to pick someone; "Edit" goes
            // straight to editing and comes back here once saved.
            const editing = target.closest('[data-meeting-open-project]').dataset.mode === 'edit';
            overSheet(crm => crm.openProjectOverview(project.id, editing ? { edit: true, closeAfterEdit: true } : {}));
        } else if (target.closest('[data-meeting-open-todo]')) {
            const id = Number(target.closest('[data-meeting-open-todo]').dataset.meetingOpenTodo);
            overSheet(crm => crm.openTodoDetail(id));
        } else if (target.closest('[data-meeting-remove-contact]')) {
            const button = target.closest('[data-meeting-remove-contact]');
            removeContact(Number(button.dataset.meetingRemoveContact), button.dataset.name || 'this contact');
        } else if (target.closest('[data-meeting-note]')) {
            target.closest('[data-meeting-note]').classList.toggle('is-open');
        }
        else if (target.closest('[data-meeting-resume]')) {
            state.ended = false;
            open();
        } else if (target.closest('[data-meeting-finish-accept]')) {
            finishAccepting();
        } else if (target.closest('[data-meeting-review]')) {
            finish();
            const reviewNav = document.querySelector('.toggle-btn[data-view="review"]');
            if (reviewNav) reviewNav.click();
        } else {
            const retry = target.closest('[data-meeting-retry]');
            if (retry) {
                const job = state.jobs.find(j => j.id === Number(retry.dataset.meetingRetry));
                if (job) runJob(job);
            }
        }
    }

    function bindElements() {
        [modal, mini].forEach(el => {
            el.addEventListener('click', handleClick);
            // Every keystroke is kept, so nothing typed is lost to a reload.
            el.addEventListener('input', event => {
                if (event.target.classList.contains('meeting-draft')) {
                    saveDraft();
                    persist();
                }
            });
        });

        modal.addEventListener('change', event => {
            const checkbox = event.target.closest('[data-meeting-toggle-todo]');
            if (checkbox && checkbox.checked) completeTodo(Number(checkbox.dataset.meetingToggleTodo), checkbox);
        });

        modal.addEventListener('keydown', event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !state.ended) {
                event.preventDefault();
                if (state.index < state.projects.length - 1) go(1);
            }
        });

        // Escape puts the big window away before anything underneath reacts;
        // the corner panel leaves Escape to the CRM.
        document.addEventListener('keydown', event => {
            // With a project or to-do sheet open over it, Escape is that sheet's.
            if (event.key !== 'Escape' || !modal.classList.contains('active') || modal.classList.contains('is-under')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            hide();
        }, true);
    }

    function bind() {
        const button = document.getElementById('startMeetingBtn');
        if (button) button.addEventListener('click', start);

        // A decision made (or undone) - here or anywhere - shows in the summary.
        document.addEventListener('crm:review-changed', event => {
            if (!state.active || !state.ended || !modal || !modal.classList.contains('active')) return;
            if (event.detail && event.detail.action === 'meeting') return;
            loadProposals();
        });

        // Whatever is in a field when the page goes is kept; a request still
        // under way is the one thing a reload can cut short, so ask first.
        window.addEventListener('beforeunload', event => {
            if (!state.active) return;
            saveDraft();
            persist();
            if (working()) {
                event.preventDefault();
                event.returnValue = '';
            }
        });
        window.addEventListener('pagehide', () => {
            if (!state.active) return;
            saveDraft();
            persist();
        });

        restore();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
