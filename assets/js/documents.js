/**
 * Project documents
 *
 * The Documents section of a project's detail view: the files attached to the
 * project, each under one label (Angebot, Hintergrund, Rechnung), with drag &
 * drop to add more.
 *
 * Self-contained module; app.js only calls window.ProjectDocuments.load() when
 * a project's detail view is drawn and .reset() when it closes.
 */
(function () {
    'use strict';

    const API = 'api/documents.php';

    const state = {
        projectId: null,
        projectName: '',
        documents: [],
        // Labels, limits and allowed types come from the server with the list,
        // so they are decided in one place (includes/ProjectDocument.php).
        labels: [],
        limits: { maxUploadBytes: 0, maxUploadLabel: '', extensions: [] },
        uploading: false,
        // The label the file picker was opened for.
        pickerLabel: null,
        // Guards against a slow answer for a project that is no longer on screen.
        token: 0
    };

    const els = {};

    const ICON_UPLOAD = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>';
    const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
    const ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

    // ------------------------------------------------------------------
    // Utilities
    // ------------------------------------------------------------------

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        // File names reach the DOM through title="..." and aria-label="..."
        // attributes as well as text, so " and ' are encoded too.
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

    function formatSize(bytes) {
        if (!bytes) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * SQLite stores UTC as "YYYY-MM-DD HH:MM:SS". The year is only written
     * when it is not this one, as on the notes timeline.
     */
    function formatDay(value) {
        if (!value) return '';
        const date = new Date(String(value).replace(' ', 'T') + 'Z');
        if (isNaN(date.getTime())) return '';

        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
        });
    }

    function extensionOf(name) {
        const match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
        return match ? match[1].toLowerCase() : '';
    }

    function fileUrl(doc, inline = false) {
        return `${API}?action=download&id=${encodeURIComponent(doc.id)}${inline ? '&inline=1' : ''}`;
    }

    async function request(action, { query = {}, ...options } = {}) {
        const params = new URLSearchParams(Object.assign({ action }, query));
        const response = await fetch(`${API}?${params}`, options);
        const text = await response.text();

        let result = null;
        try {
            result = JSON.parse(text);
        } catch (e) {
            // Not JSON: the server (or something in front of it) refused the request.
        }

        if (!result) {
            throw new Error(response.status === 413
                ? 'The upload was too large for the server.'
                : `Server returned an unreadable response (HTTP ${response.status}).`);
        }
        if (!response.ok || result.error) {
            throw new Error(result.error || 'Request failed');
        }
        return result;
    }

    function postJson(action, payload) {
        return request(action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
            body: JSON.stringify(payload)
        });
    }

    /** The one toast element the page has (index.php), shared with Bookkeeping. */
    let toastTimer = null;
    function toast(message, isError = false) {
        const node = document.getElementById('bkToast');
        if (!node) return;
        node.textContent = message;
        node.classList.toggle('bk-toast-error', isError);
        node.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove('visible'), isError ? 6000 : 3500);
    }

    // ------------------------------------------------------------------
    // Loading & rendering
    // ------------------------------------------------------------------

    function load(projectId, projectName) {
        if (!els.section) return Promise.resolve();

        if (state.projectId !== projectId) {
            state.documents = [];
            els.list.innerHTML = '';
            els.count.hidden = true;
        }
        state.projectId = projectId;
        state.projectName = projectName || '';

        return refresh();
    }

    async function refresh() {
        const projectId = state.projectId;
        if (!projectId) return;
        const token = ++state.token;

        try {
            const result = await request('list', { query: { project_id: projectId } });
            if (token !== state.token || state.projectId !== projectId) return;

            const data = result.data || {};
            state.documents = Array.isArray(data.documents) ? data.documents : [];
            state.labels = Array.isArray(data.labels) ? data.labels : [];
            state.limits = {
                maxUploadBytes: (data.limits && data.limits.max_upload_bytes) || 0,
                maxUploadLabel: (data.limits && data.limits.max_upload_label) || '',
                extensions: (data.limits && data.limits.extensions) || []
            };
            render();
        } catch (error) {
            if (token !== state.token) return;
            els.list.innerHTML = `<p class="empty-hint">Documents could not be loaded: ${escapeHtml(error.message)}</p>`;
        }
    }

    function reset() {
        state.projectId = null;
        state.projectName = '';
        state.documents = [];
        state.token++;
        hideDrop();
        if (els.list) els.list.innerHTML = '';
        if (els.count) els.count.hidden = true;
    }

    function render() {
        renderList();
        renderAdd();
    }

    function renderList() {
        const count = state.documents.length;
        els.count.textContent = String(count);
        els.count.hidden = count === 0;

        els.list.innerHTML = count === 0
            ? '<p class="empty-hint">No documents yet</p>'
            : `<div class="pdoc-card">${state.documents.map(rowHtml).join('')}</div>`;
    }

    function rowHtml(doc) {
        // A file that arrived through an upload link from Claude is marked
        // until somebody accepts it, like a proposed note.
        const review = window.CRMReview;
        const proposed = doc.review_status === 'pending' && !!review;
        const name = escapeHtml(doc.name);
        const meta = [['size', formatSize(doc.size)], ['who', doc.uploaded_by_name], ['date', formatDay(doc.created_at)]]
            .filter(([, text]) => text)
            .map(([part, text]) => `<span class="pdoc-meta-part pdoc-meta-${part}">${escapeHtml(text)}</span>`)
            .join('');

        return `
            <div class="pdoc-item${proposed ? ' is-proposed' : ''}" data-doc-id="${doc.id}">
                <span class="pdoc-type" aria-hidden="true">${escapeHtml(extensionOf(doc.name))}</span>
                <div class="pdoc-info">
                    <a class="pdoc-name" href="${fileUrl(doc)}" data-doc-open="${doc.id}" title="${name}">${name}</a>
                    <div class="pdoc-meta">
                        ${labelSelect(doc)}
                        ${meta}
                        ${proposed ? review.badge(doc) : ''}
                    </div>
                </div>
                <div class="pdoc-tools">
                    ${proposed ? review.inlineActions('project_document', doc.id) : ''}
                    <a class="pdoc-act" href="${fileUrl(doc)}" download title="Download" aria-label="Download ${name}">${ICON_DOWNLOAD}</a>
                    <button type="button" class="pdoc-act pdoc-act--danger" data-doc-delete="${doc.id}" title="Delete" aria-label="Delete ${name}">${ICON_TRASH}</button>
                </div>
            </div>`;
    }

    /** The label as a small select: it shows what the file is, and changes it. */
    function labelSelect(doc) {
        const index = state.labels.indexOf(doc.label);
        const options = state.labels.map(label =>
            `<option value="${escapeHtml(label)}"${label === doc.label ? ' selected' : ''}>${escapeHtml(label)}</option>`
        ).join('');
        // A label that has left the list still shows, rather than the file
        // quietly appearing under another one.
        const stray = index === -1
            ? `<option value="${escapeHtml(doc.label)}" selected>${escapeHtml(doc.label)}</option>`
            : '';

        return `
            <span class="pdoc-label" data-label-index="${index}">
                <select class="pdoc-label-select" data-doc-label="${doc.id}" aria-label="Label of ${escapeHtml(doc.name)}">${stray}${options}</select>
            </span>`;
    }

    function renderAdd() {
        const limit = state.limits.maxUploadLabel ? ` · up to ${state.limits.maxUploadLabel} each` : '';
        const chips = state.labels.map((label, index) =>
            `<button type="button" class="pdoc-chip" data-doc-add="${escapeHtml(label)}" data-label-index="${index}">${escapeHtml(label)}</button>`
        ).join('');

        els.add.innerHTML = `
            <div class="pdoc-add-row">
                <span class="pdoc-add-text">${ICON_UPLOAD}<span>Drag files in, or add as</span></span>
                <span class="pdoc-add-labels">${chips}</span>
            </div>
            <p class="pdoc-add-hint">PDF, Word, Excel, PowerPoint, text and images${escapeHtml(limit)}</p>`;

        els.input.accept = state.limits.extensions.map(extension => '.' + extension).join(',');
        setBusy(state.uploading);
    }

    function setBusy(busy) {
        els.section.classList.toggle('is-busy', busy);
        els.section.setAttribute('aria-busy', busy ? 'true' : 'false');
        els.add.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    }

    // ------------------------------------------------------------------
    // Adding
    // ------------------------------------------------------------------

    /** Why a file cannot be uploaded, checked before it travels - or null. */
    function problemWith(file) {
        const allowed = state.limits.extensions;
        if (allowed.length > 0 && !allowed.includes(extensionOf(file.name))) {
            return `"${file.name}" is not a kind of file that can be attached.`;
        }
        const max = state.limits.maxUploadBytes;
        if (max && file.size > max) {
            return `"${file.name}" is ${formatSize(file.size)}, larger than the limit of ${state.limits.maxUploadLabel}.`;
        }
        return null;
    }

    async function upload(fileList, label) {
        const projectId = state.projectId;
        const files = Array.from(fileList || []);
        if (!projectId || !label || files.length === 0 || state.uploading) return;

        const problems = [];
        const ready = [];
        files.forEach(file => {
            const problem = problemWith(file);
            if (problem) problems.push(problem);
            else ready.push(file);
        });

        state.uploading = true;
        setBusy(true);

        // One request per file. Several large files in a single POST would
        // run into post_max_size, which PHP reports by discarding all of it.
        let added = 0;
        for (let i = 0; i < ready.length; i++) {
            const file = ready[i];
            toast(ready.length > 1 ? `Uploading ${i + 1} of ${ready.length}: ${file.name}` : `Uploading ${file.name}…`);

            const form = new FormData();
            form.append('project_id', String(projectId));
            form.append('label', label);
            form.append('document', file);
            form.append('csrf_token', getCsrfToken());

            try {
                await request('upload', { method: 'POST', body: form });
                added++;
            } catch (error) {
                problems.push(`${file.name}: ${error.message}`);
            }
        }

        state.uploading = false;
        setBusy(false);

        // The sheet may show another project by now; its list is not ours to redraw.
        if (added > 0 && state.projectId === projectId) {
            await refresh();
        }

        if (problems.length > 0) {
            toast((added > 0 ? `${added} added. ` : '') + problems.join(' / '), true);
        } else {
            toast(`${added} document${added === 1 ? '' : 's'} added as ${label}`);
        }
    }

    // ------------------------------------------------------------------
    // Opening, relabelling, removing
    // ------------------------------------------------------------------

    function findDocument(id) {
        return state.documents.find(doc => doc.id === Number(id)) || null;
    }

    /**
     * A PDF or an image opens in the preview dialog; anything else is a
     * download, which is what the link does on its own.
     */
    function open(event, doc) {
        const previewable = doc.kind === 'pdf' || doc.kind === 'image';
        const plainClick = event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
        if (!previewable || !plainClick || !window.Bookkeeping || !window.Bookkeeping.preview) return;

        event.preventDefault();
        window.Bookkeeping.preview(fileUrl(doc, true), doc.name, doc.kind);
    }

    async function setLabel(select) {
        const doc = findDocument(select.dataset.docLabel);
        if (!doc || select.value === doc.label) return;

        select.disabled = true;
        try {
            await postJson('set-label', { id: doc.id, label: select.value });
            await refresh();
        } catch (error) {
            toast(error.message, true);
            // Put the control back to what is actually stored.
            renderList();
        }
    }

    async function remove(id) {
        const doc = findDocument(id);
        if (!doc) return;
        if (!window.confirm(`Delete "${doc.name}"? This cannot be undone.`)) return;

        try {
            await postJson('delete', { id: doc.id });
            toast(`"${doc.name}" deleted`);
            await refresh();
        } catch (error) {
            toast(error.message, true);
        }
    }

    // ------------------------------------------------------------------
    // Drag & drop
    //
    // A file dragged over the sheet covers it with one drop target per label,
    // so the file is labelled by where it is let go - wherever the sheet
    // happens to be scrolled to.
    // ------------------------------------------------------------------

    let dropClearTimer = null;

    function isFileDrag(event) {
        return !!event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
    }

    function showDrop() {
        if (!els.drop) {
            els.drop = document.createElement('div');
            els.drop.className = 'pdoc-drop';
            els.drop.hidden = true;
            els.modal.querySelector('.modal-content').appendChild(els.drop);
        }
        if (!els.drop.hidden) return;

        const targets = state.labels.map((label, index) => `
            <div class="pdoc-drop-target" data-doc-drop="${escapeHtml(label)}" data-label-index="${index}">
                <span class="pdoc-dot" aria-hidden="true"></span>
                <span>${escapeHtml(label)}</span>
            </div>`).join('');

        els.drop.innerHTML = `
            <p class="pdoc-drop-title">Add to <strong>${escapeHtml(state.projectName || 'this project')}</strong> as</p>
            <div class="pdoc-drop-targets">${targets}</div>`;
        els.drop.hidden = false;
    }

    function hideDrop() {
        clearTimeout(dropClearTimer);
        if (els.drop) els.drop.hidden = true;
    }

    function markTarget(target) {
        els.drop.querySelectorAll('.pdoc-drop-target').forEach(node => {
            node.classList.toggle('is-over', node === target);
        });
    }

    function bindDrops() {
        const onDrag = event => {
            if (!isFileDrag(event) || !state.projectId || state.labels.length === 0) return;

            // Always claimed while files are over the sheet: left alone, the
            // browser would open a file dropped beside a target and navigate
            // away from the CRM.
            event.preventDefault();
            clearTimeout(dropClearTimer);

            if (state.uploading) {
                event.dataTransfer.dropEffect = 'none';
                return;
            }

            showDrop();
            const target = event.target.closest('[data-doc-drop]');
            markTarget(target);
            event.dataTransfer.dropEffect = target ? 'copy' : 'none';
        };

        els.modal.addEventListener('dragenter', onDrag);
        els.modal.addEventListener('dragover', onDrag);

        // dragleave fires on every child boundary, and Safari often reports no
        // relatedTarget, so a leave alone cannot tell "left the sheet" from
        // "moved onto a child". Clear a moment later; the dragover that
        // follows any move inside the sheet cancels it.
        els.modal.addEventListener('dragleave', () => {
            clearTimeout(dropClearTimer);
            dropClearTimer = setTimeout(hideDrop, 80);
        });

        els.modal.addEventListener('drop', event => {
            if (!isFileDrag(event)) return;
            event.preventDefault();

            const target = event.target.closest('[data-doc-drop]');
            hideDrop();
            if (target) {
                upload(event.dataTransfer.files, target.dataset.docDrop);
            }
        });

        // A drag cancelled with Escape, or dropped outside the window.
        document.addEventListener('dragend', hideDrop);
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function bind() {
        Object.assign(els, {
            modal: document.getElementById('projectOverviewModal'),
            section: document.getElementById('projectDocuments'),
            list: document.getElementById('projectDocumentsList'),
            add: document.getElementById('projectDocumentsAdd'),
            count: document.getElementById('projectDocumentsCount'),
            input: document.getElementById('projectDocumentsInput')
        });
        if (!els.modal || !els.section) return;

        els.section.addEventListener('click', event => {
            const addButton = event.target.closest('[data-doc-add]');
            if (addButton) {
                state.pickerLabel = addButton.dataset.docAdd;
                els.input.click();
                return;
            }

            const deleteButton = event.target.closest('[data-doc-delete]');
            if (deleteButton) {
                remove(deleteButton.dataset.docDelete);
                return;
            }

            const link = event.target.closest('[data-doc-open]');
            const doc = link ? findDocument(link.dataset.docOpen) : null;
            if (doc) open(event, doc);
        });

        els.section.addEventListener('change', event => {
            const select = event.target.closest('[data-doc-label]');
            if (select) setLabel(select);
        });

        els.input.addEventListener('change', () => {
            const files = Array.from(els.input.files);
            // Emptied before the upload starts, so picking the same file
            // again later still fires a change.
            els.input.value = '';
            upload(files, state.pickerLabel);
        });

        bindDrops();
    }

    window.ProjectDocuments = { load, reset };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
