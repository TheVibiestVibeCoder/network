/**
 * The CRM's own "Are you sure?" and message popups
 *
 * One look for every question and notice, instead of the browser's own
 * confirm() and alert() boxes, which look different in every browser and
 * cannot be styled:
 *
 *   if (!(await CRMDialog.confirm('Delete this note?', { confirm: 'Delete', danger: true }))) return;
 *   CRMDialog.alert('The project could not be saved.');
 *
 * Both return a promise. confirm() resolves true for the main button and
 * false for Cancel, Escape or a click beside the popup; alert() resolves
 * once it is closed. prompt() asks for one line of text and resolves to it
 * (trimmed), or null when cancelled or left empty:
 *
 *   const name = await CRMDialog.prompt('New product', { confirm: 'Add', placeholder: 'Name' });
 *
 * One popup at a time: a second one waits for the first.
 */
(function () {
    'use strict';

    let queue = Promise.resolve();
    let root = null;

    function build() {
        if (root) return root;
        root = document.createElement('div');
        root.className = 'modal crm-dialog';
        root.innerHTML = `
            <div class="modal-backdrop" data-dialog-cancel></div>
            <div class="modal-content modal-small" role="alertdialog" aria-modal="true" aria-labelledby="crmDialogTitle" aria-describedby="crmDialogText">
                <div class="modal-header">
                    <h2 class="crm-dialog-title" id="crmDialogTitle"></h2>
                    <button type="button" class="modal-close" data-dialog-cancel aria-label="Close">&times;</button>
                </div>
                <div class="modal-body crm-dialog-body">
                    <p class="crm-dialog-text" id="crmDialogText"></p>
                    <input type="text" class="form-input crm-dialog-input" maxlength="80" autocomplete="off" hidden>
                </div>
                <div class="modal-footer crm-dialog-actions"></div>
            </div>`;
        document.body.appendChild(root);
        return root;
    }

    function show(kind, message, options) {
        const opts = options || {};
        const run = () => new Promise(resolve => {
            const el = build();
            const title = el.querySelector('.crm-dialog-title');
            const text = el.querySelector('.crm-dialog-text');
            const actions = el.querySelector('.crm-dialog-actions');
            const returnFocus = document.activeElement;

            // Without its own title the message is the title; long ones
            // (several lines) read better as text under a short heading.
            const msg = String(message === undefined || message === null ? '' : message);
            const heading = opts.title || (kind === 'confirm' ? msg : (msg.length > 90 || msg.includes('\n') ? 'Something went wrong' : msg));
            title.textContent = heading;
            text.textContent = heading === msg ? (opts.text || '') : msg;
            const input = el.querySelector('.crm-dialog-input');
            input.hidden = kind !== 'prompt';
            input.value = opts.value || '';
            input.placeholder = opts.placeholder || '';
            text.hidden = !text.textContent;
            el.querySelector('.crm-dialog-body').hidden = !text.textContent && kind !== 'prompt';

            const okLabel = opts.confirm || 'OK';
            actions.innerHTML = (kind === 'confirm' || kind === 'prompt'
                ? `<button type="button" class="btn btn-secondary" data-dialog-cancel>${escapeHtml(opts.cancel || 'Cancel')}</button>` : '')
                + `<button type="button" class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-dialog-ok>${escapeHtml(okLabel)}</button>`;

            const finish = value => {
                el.classList.remove('active');
                el.removeEventListener('click', onClick);
                document.removeEventListener('keydown', onKey, true);
                if (returnFocus && document.body.contains(returnFocus) && typeof returnFocus.focus === 'function') {
                    returnFocus.focus({ preventScroll: true });
                }
                resolve(value);
            };
            const answer = () => {
                if (kind !== 'prompt') return true;
                const v = input.value.trim();
                return v === '' ? null : v;
            };
            const onClick = event => {
                if (event.target.closest('[data-dialog-ok]')) finish(answer());
                else if (event.target.closest('[data-dialog-cancel]')) finish(kind === 'prompt' ? null : false);
            };
            // Before every other Escape handler: only the popup closes.
            const onKey = event => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    finish(kind === 'prompt' ? null : false);
                } else if (event.key === 'Enter' && kind === 'prompt' && event.target === input) {
                    event.preventDefault();
                    finish(answer());
                } else if (event.key === 'Tab') {
                    const buttons = (kind === 'prompt' ? [input] : []).concat(Array.from(actions.querySelectorAll('button')));
                    const i = buttons.indexOf(document.activeElement);
                    event.preventDefault();
                    buttons[(i + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
                }
            };
            el.addEventListener('click', onClick);
            document.addEventListener('keydown', onKey, true);
            el.classList.add('active');
            // A dangerous action does not get the focus: Enter alone must not delete.
            const focus = kind === 'prompt' ? input
                : kind === 'confirm' && opts.danger ? actions.querySelector('[data-dialog-cancel]') : actions.querySelector('[data-dialog-ok]');
            focus.focus();
        });
        const next = queue.then(run, run);
        queue = next.then(() => undefined, () => undefined);
        return next;
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    window.CRMDialog = {
        confirm: (message, options) => show('confirm', message, options),
        alert: (message, options) => show('alert', message, options),
        prompt: (message, options) => show('prompt', message, options),
    };
})();
