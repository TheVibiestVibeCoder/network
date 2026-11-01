/**
 * Claude summary of a project (includes/ProjectSummary.php), wherever the
 * project's details are shown: under the description in the project sheet,
 * in the meeting window and in the Claude window of a project card.
 *
 * Each place is an element marked data-claude-summary="<project id>". The
 * summary is loaded once per project and kept here; every marked element of
 * that project is drawn from it, and drawn again whenever it changes - so a
 * window that redraws itself (the meeting) shows it at once, and all places
 * follow when Claude has written it anew.
 *
 * check(id) asks whether the stored summary still matches the description
 * and the notes. If they changed since - here, in a meeting, or by accepting
 * one of Claude's proposals - the old summary stays on screen, marked as
 * being updated, while Claude writes it again in the background.
 */
(function () {
    'use strict';

    const API = 'api/projects.php';
    // A summary still behind after this many rounds in a row (the project
    // keeps changing while Claude writes) waits for the next look.
    const MAX_ROUNDS = 2;

    // Claude's mark, as on "From Claude" in the sidebar.
    const ICON_CLAUDE = '<svg class="ov-claude-summary-mark" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>';

    // Per project: { data, status, error } - data as the server has it
    // ({ summary, updated_at, stale, empty }), status '' | 'loading' |
    // 'updating' | 'failed'.
    const cache = new Map();
    // Claude writing a project's summary: { again } per project.
    const running = new Map();

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
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

    async function request(url, method = 'GET') {
        const response = await fetch(url, {
            method,
            headers: method === 'GET' ? {} : { 'X-CSRF-Token': getCsrfToken() }
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || !payload.success) {
            throw new Error((payload && payload.error) || `Request failed (${response.status})`);
        }
        return payload.data;
    }

    /** "Nov 1, 10:42" from the database's UTC timestamp. */
    function formatWhen(value) {
        return value ? window.CRMFormat.dateTime(value) : '';
    }

    /** Claude's plain text: sentences as paragraphs, "- " lines as a list. */
    function textHtml(text) {
        let html = '';
        let list = [];
        const flush = () => {
            if (list.length) html += `<ul>${list.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
            list = [];
        };
        String(text).split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) {
                flush();
            } else if (/^[-•*]\s+/.test(trimmed)) {
                list.push(trimmed.replace(/^[-•*]\s+/, ''));
            } else {
                flush();
                html += `<p>${escapeHtml(trimmed)}</p>`;
            }
        });
        flush();
        return html;
    }

    /** What goes inside a marked element: the label line and the text. */
    function innerHtml(entry) {
        const data = (entry && entry.data) || { summary: '' };
        const status = entry ? entry.status : 'loading';

        let state = '';
        if (status === 'updating') {
            state = '<span class="ov-claude-summary-spinner" aria-hidden="true"></span>Updating…';
        } else if (status === 'failed') {
            state = 'Not updated <button type="button" class="ov-claude-summary-retry" data-summary-retry>Try again</button>';
        } else if (data.updated_at && data.summary) {
            state = `Updated ${escapeHtml(formatWhen(data.updated_at))}`;
        }

        let text;
        if (data.summary) {
            text = textHtml(data.summary);
        } else if (status === 'loading') {
            text = '<p class="ov-claude-summary-hint">Loading…</p>';
        } else if (data.empty) {
            text = '<p class="ov-claude-summary-hint">Appears once the project has a description or notes.</p>';
        } else if (status === 'updating') {
            text = '<p class="ov-claude-summary-hint">Claude is reading the description and the notes…</p>';
        } else if (status === 'failed') {
            text = `<p class="ov-claude-summary-hint">${escapeHtml(entry.error)}</p>`;
        } else {
            text = '<p class="ov-claude-summary-hint">No summary yet.</p>';
        }

        return `
            <span class="detail-label ov-claude-summary-label">${ICON_CLAUDE}<span>Claude summary</span><span class="ov-claude-summary-state">${state}</span></span>
            <div class="detail-value ov-claude-summary-text" aria-live="polite">${text}</div>`;
    }

    function isUpdating(entry) {
        return !!entry && entry.status === 'updating' && !!(entry.data && entry.data.summary);
    }

    /** Draw every place that shows this project's summary. */
    function paint(projectId) {
        const entry = cache.get(projectId);
        document.querySelectorAll(`[data-claude-summary="${projectId}"]`).forEach(node => {
            node.hidden = false;
            node.classList.toggle('is-updating', isUpdating(entry));
            node.title = entry && entry.status === 'failed' ? entry.error : '';
            node.innerHTML = innerHtml(entry);
        });
    }

    function set(projectId, changes) {
        cache.set(projectId, { ...(cache.get(projectId) || { data: null, status: '', error: '' }), ...changes });
        paint(projectId);
    }

    /**
     * Load the stored summary, and have it written again if the project
     * changed since.
     */
    async function check(projectId) {
        const id = Number(projectId);
        if (!id) return;
        if (!cache.has(id)) set(id, { status: 'loading' });

        let data;
        try {
            data = await request(`${API}?action=summary&id=${encodeURIComponent(id)}`);
        } catch (error) {
            set(id, { status: 'failed', error: error.message });
            return;
        }

        // A request already under way for this project shows as such.
        set(id, { data, status: data.stale || running.has(id) ? 'updating' : '', error: '' });
        if (data.stale) refresh(id);
    }

    /** Ask for the summary to be written again; one request per project at a time. */
    async function refresh(projectId, round = 1) {
        const job = running.get(projectId);
        if (job) {
            // Something changed again while Claude writes: once more after.
            job.again = true;
            return;
        }

        const mine = { again: false };
        running.set(projectId, mine);
        let data = null;
        try {
            data = await request(`${API}?action=summary-refresh&id=${encodeURIComponent(projectId)}`, 'POST');
            set(projectId, { data, status: data.stale ? 'updating' : '', error: '' });
        } catch (error) {
            set(projectId, { status: 'failed', error: error.message || 'Could not update' });
        } finally {
            running.delete(projectId);
        }

        // Still behind: the project changed while Claude wrote.
        if (data && (mine.again || data.stale) && round < MAX_ROUNDS) {
            refresh(projectId, round + 1);
        }
    }

    /**
     * A ready-made place for the summary, for windows that build their
     * details as HTML (the meeting): drawn from what is known now, filled in
     * as it arrives. The first time a project is shown it is also checked.
     */
    function block(projectId) {
        const id = Number(projectId);
        if (!id) return '';
        const entry = cache.get(id);
        if (!entry) setTimeout(() => check(id), 0);
        return `<div class="overview-detail-item full-width ov-claude-summary${isUpdating(entry) ? ' is-updating' : ''}" data-claude-summary="${id}">${innerHtml(entry)}</div>`;
    }

    /**
     * The project sheet: its place under the description shows this project
     * (or nothing, for show(null) - no saved project on screen).
     */
    function show(projectId) {
        const item = document.getElementById('projectSummaryItem');
        const id = projectId ? Number(projectId) : null;
        if (!item) return;
        if (!id) {
            item.hidden = true;
            item.removeAttribute('data-claude-summary');
            return;
        }
        item.setAttribute('data-claude-summary', String(id));
        paint(id);
        check(id);
    }

    // ------------------------------------------------------------------
    // The first round: every project without a summary gets one
    // ------------------------------------------------------------------
    // Shortly after an admin opens the CRM, the projects that never had a
    // summary are written one after the other in the background, so the
    // first look at any project finds one. Once all have one there is
    // nothing left to do; a project added later gets its first the same way.
    // One tab at a time: the tab doing it holds a lease in localStorage and
    // renews it per project, so a closed tab's round is taken up again later.

    const BACKFILL_KEY = 'crm-summary-backfill';
    const BACKFILL_LEASE_MS = 3 * 60 * 1000;
    const BACKFILL_DELAY_MS = 4000;
    let backfilling = false;

    function claimBackfill() {
        try {
            const held = Number(localStorage.getItem(BACKFILL_KEY) || 0);
            if (held && Date.now() - held < BACKFILL_LEASE_MS) return false;
            localStorage.setItem(BACKFILL_KEY, String(Date.now()));
        } catch (e) {
            // No storage: this tab just goes ahead.
        }
        return true;
    }

    function renewBackfill() {
        try { localStorage.setItem(BACKFILL_KEY, String(Date.now())); } catch (e) { /* see claimBackfill */ }
    }

    function releaseBackfill() {
        backfilling = false;
        try { localStorage.removeItem(BACKFILL_KEY); } catch (e) { /* see claimBackfill */ }
    }

    async function backfill() {
        const role = document.querySelector('meta[name="current-user-role"]');
        if (!role || role.getAttribute('content') !== 'admin' || !claimBackfill()) return;
        backfilling = true;
        try {
            const ids = await request(`${API}?action=summary-missing`);
            for (const id of ids) {
                if (!backfilling) break;
                renewBackfill();
                // Through refresh(), so a project on screen shows it being
                // written. A failure is left for the next round.
                await refresh(Number(id));
            }
        } catch (error) {
            // Not now; the next time the CRM is opened.
        } finally {
            if (backfilling) releaseBackfill();
        }
    }

    // Leaving mid-round frees it for the next tab at once.
    window.addEventListener('pagehide', () => {
        if (backfilling) releaseBackfill();
    });

    setTimeout(backfill, BACKFILL_DELAY_MS);

    // Still behind after a failed attempt, so checking again tries again.
    document.addEventListener('click', event => {
        const retry = event.target.closest('[data-summary-retry]');
        const place = retry && retry.closest('[data-claude-summary]');
        if (place) check(place.getAttribute('data-claude-summary'));
    });

    window.CRMProjectSummary = { show, check, block };
})();
