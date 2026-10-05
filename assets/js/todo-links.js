/**
 * Links on to-dos: how they look wherever a to-do is shown.
 *
 * A link to Google Drive (Docs, Sheets, Slides, a folder) carries the Drive
 * mark; anything else a plain link icon. The API hands each to-do its links
 * (includes/TodoLink.php), each with a name - the document's own where it
 * could be read, otherwise a readable fallback such as "Google Doc".
 *
 * Used by app.js (to-do lists, project sheet, to-do detail sheet) and
 * workload.js (home page), so it loads before both.
 */
(function () {
    'use strict';

    const GOOGLE_KINDS = ['doc', 'sheet', 'slides', 'form', 'folder', 'drive'];

    // The Google Drive mark, in its own colours.
    const ICON_DRIVE = '<svg class="tlink-icon" viewBox="0 0 87.3 78" aria-hidden="true">'
        + '<path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>'
        + '<path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>'
        + '<path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>'
        + '<path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>'
        + '<path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>'
        + '<path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>'
        + '</svg>';

    const ICON_LINK = '<svg class="tlink-icon tlink-icon--web" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
        + '<path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>'
        + '</svg>';

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Only http(s) addresses become links; the server checks this too. */
    function safeUrl(url) {
        return /^https?:\/\//i.test(String(url || '')) ? String(url) : '#';
    }

    function isGoogle(link) {
        return !!link && GOOGLE_KINDS.includes(link.kind);
    }

    function icon(link) {
        return isGoogle(link) ? ICON_DRIVE : ICON_LINK;
    }

    /** What a link is, in words: "Google Doc", "Drive folder", the host. */
    function kindLabel(link) {
        switch (link && link.kind) {
            case 'doc': return 'Google Doc';
            case 'sheet': return 'Google Sheet';
            case 'slides': return 'Google Slides';
            case 'form': return 'Google Form';
            case 'folder': return 'Drive folder';
            case 'drive': return 'Google Drive';
        }
        try {
            return new URL(link.url).hostname.replace(/^www\./, '');
        } catch (e) {
            return '';
        }
    }

    /**
     * The quick way to a to-do's document: its first link as a small button
     * with the Drive mark and the document's name; "+2" when there are more.
     * compact: the mark alone, the name in the tooltip.
     */
    function quickLink(todo, options = {}) {
        const links = (todo && todo.links) || [];
        if (links.length === 0) return '';

        const first = links[0];
        const more = links.length > 1
            ? `<span class="tlink-more" title="${links.length} links - open the to-do to see all">+${links.length - 1}</span>`
            : '';

        return `
            <span class="tlink-quick${options.compact ? ' is-compact' : ''}">
                <a class="tlink-pill" href="${escapeHtml(safeUrl(first.url))}" target="_blank" rel="noopener noreferrer"
                   title="Open “${escapeHtml(first.title)}”" data-tlink-open>
                    ${icon(first)}${options.compact ? '' : `<span class="tlink-pill-name">${escapeHtml(first.title)}</span>`}
                </a>${more}
            </span>`;
    }

    /** A link as a row in the to-do detail sheet. */
    function row(link) {
        return `
            <div class="tlink-row" data-link-id="${link.id}">
                <span class="tlink-row-icon">${icon(link)}</span>
                <a class="tlink-row-main" href="${escapeHtml(safeUrl(link.url))}" target="_blank" rel="noopener noreferrer">
                    <span class="tlink-row-name">${escapeHtml(link.title)}</span>
                    <span class="tlink-row-kind">${escapeHtml(kindLabel(link))}</span>
                </a>
                <a class="btn btn-secondary btn-small tlink-row-open" href="${escapeHtml(safeUrl(link.url))}" target="_blank" rel="noopener noreferrer">Open</a>
                <button type="button" class="pdoc-act pdoc-act--danger" data-link-delete="${link.id}" title="Remove link" aria-label="Remove ${escapeHtml(link.title)}">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
            </div>`;
    }

    window.TodoLinks = { icon, isGoogle, kindLabel, quickLink, row };
})();
