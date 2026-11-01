/**
 * Claude summary under a project's description (includes/ProjectSummary.php).
 *
 * The project sheet calls show(id) whenever it shows a project or the
 * project's notes change (app.js). The stored summary appears at once. If the
 * description or the notes changed since it was written - here, in a meeting,
 * or by accepting one of Claude's proposals - it stays on screen, marked as
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

    // The project on screen, and the requests to Claude under way, by project.
    let current = null;
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

    function parts() {
        return {
            item: document.getElementById('projectSummaryItem'),
            label: document.getElementById('projectSummaryLabel'),
            text: document.getElementById('projectSummaryText')
        };
    }

    /** "Nov 1, 10:42" from the database's UTC timestamp. */
    function formatWhen(value) {
        if (!value) return '';
        const date = new Date(String(value).replace(' ', 'T') + 'Z');
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            + ', ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
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

    /**
     * Draw the field. status: '' (current), 'updating' or an error message.
     */
    function render(data, status) {
        const { item, label, text } = parts();
        if (!item) return;
        item.hidden = false;

        const updating = status === 'updating';
        const failed = status && !updating;
        let state = '';
        if (updating) {
            state = '<span class="ov-claude-summary-spinner" aria-hidden="true"></span>Updating…';
        } else if (failed) {
            state = `Not updated <button type="button" class="ov-claude-summary-retry" data-summary-retry>Try again</button>`;
        } else if (data.updated_at && data.summary) {
            state = `Updated ${escapeHtml(formatWhen(data.updated_at))}`;
        }
        label.innerHTML = `${ICON_CLAUDE}<span>Claude summary</span><span class="ov-claude-summary-state">${state}</span>`;

        item.classList.toggle('is-updating', updating && !!data.summary);
        if (data.empty && !data.summary) {
            text.innerHTML = '<p class="ov-claude-summary-hint">Appears once the project has a description or notes.</p>';
        } else if (!data.summary) {
            text.innerHTML = updating
                ? '<p class="ov-claude-summary-hint">Claude is reading the description and the notes…</p>'
                : `<p class="ov-claude-summary-hint">${failed ? escapeHtml(status) : 'No summary yet.'}</p>`;
        } else {
            text.innerHTML = textHtml(data.summary);
        }
        item.title = failed ? status : '';
    }

    function hide() {
        const { item } = parts();
        if (item) item.hidden = true;
    }

    /**
     * Show the project's summary, and have it written again if it is behind.
     * show(null) when no saved project is on screen.
     */
    async function show(projectId) {
        current = projectId ? Number(projectId) : null;
        if (!current) {
            hide();
            return;
        }

        const id = current;
        let data;
        try {
            data = await request(`${API}?action=summary&id=${encodeURIComponent(id)}`);
        } catch (error) {
            if (current === id) hide();
            return;
        }
        if (current !== id) return;

        // A request already under way for this project shows as such.
        const busy = running.has(id);
        render(data, data.stale || busy ? 'updating' : '');
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
            if (current === projectId) render(data, data.stale ? 'updating' : '');
        } catch (error) {
            if (current === projectId) {
                const stored = await request(`${API}?action=summary&id=${encodeURIComponent(projectId)}`).catch(() => null);
                if (current === projectId) render(stored || { summary: '' }, error.message || 'Could not update');
            }
        } finally {
            running.delete(projectId);
        }

        // Still behind: the project changed while Claude wrote.
        if (data && (mine.again || data.stale) && round < MAX_ROUNDS) {
            refresh(projectId, round + 1);
        }
    }

    // Still behind after a failed attempt, so showing it again tries again.
    document.addEventListener('click', event => {
        if (event.target.closest('[data-summary-retry]') && current) show(current);
    });

    window.CRMProjectSummary = { show };
})();
