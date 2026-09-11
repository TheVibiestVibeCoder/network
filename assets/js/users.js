/**
 * User management panel
 *
 * Admin-only. Invite people, change roles, enable/disable and delete accounts.
 * Passwords never pass through here: an invite produces a one-time link and the
 * person on the other end chooses their own.
 *
 * Self-contained module; the panel is opened from the header button, which
 * index.php only renders for administrators.
 */
(function () {
    'use strict';

    const API = 'api/users.php';

    const state = {
        users: [],
        me: null,
        busy: false
    };

    const els = {};

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
     * Escape for both text nodes and quoted attribute values. Names and email
     * addresses are user-supplied and land in title="..." and data-* here.
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

    function showToast(message, isError = false) {
        const toast = $('bkToast');
        if (!toast) {
            if (isError) window.alert(message);
            return;
        }
        toast.textContent = message;
        toast.classList.toggle('bk-toast-error', isError);
        toast.classList.add('visible');
        clearTimeout(showToast._timer);
        showToast._timer = setTimeout(() => toast.classList.remove('visible'), 3500);
    }

    function formatDate(value) {
        if (!value) return null;
        const date = new Date(String(value).replace(' ', 'T') + 'Z');
        if (isNaN(date.getTime())) return null;
        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    /**
     * Call the users API and unwrap the JSON envelope.
     */
    async function api(path, options = {}) {
        const headers = Object.assign(
            { 'X-CSRF-Token': getCsrfToken() },
            options.body ? { 'Content-Type': 'application/json' } : {},
            options.headers || {}
        );

        const response = await fetch(API + path, Object.assign({}, options, { headers }));
        const text = await response.text();

        let payload;
        try {
            payload = text ? JSON.parse(text) : {};
        } catch (e) {
            throw new Error('The server returned an unexpected response.');
        }

        if (!response.ok || payload.error) {
            throw new Error(payload.error || 'Request failed.');
        }

        return payload;
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function render() {
        if (!els.list) return;

        if (state.users.length === 0) {
            els.list.innerHTML =
                '<div class="users-empty">No users yet. Invite someone above to get started.</div>';
            return;
        }

        els.list.innerHTML = state.users.map(renderRow).join('');
    }

    function renderRow(user) {
        const isSelf = state.me && state.me.id !== null && Number(state.me.id) === Number(user.id);
        const isAdmin = user.role === 'admin';
        const isPending = user.status === 'invited';
        const isDisabled = user.status === 'disabled';

        const classes = ['user-row'];
        if (isAdmin) classes.push('is-admin');
        if (isDisabled) classes.push('is-disabled');

        const badges = [];
        if (isSelf) badges.push('<span class="user-badge user-badge-you">You</span>');
        if (isAdmin) badges.push('<span class="user-badge user-badge-admin">Admin</span>');
        if (isPending) badges.push('<span class="user-badge user-badge-pending">Invite pending</span>');
        if (isDisabled) badges.push('<span class="user-badge user-badge-disabled">Disabled</span>');

        const lastLogin = formatDate(user.last_login_at);
        const meta = isPending
            ? 'Has not signed in yet'
            : (lastLogin ? 'Last seen ' + escapeHtml(lastLogin) : 'Never signed in');

        // A role select for everyone but yourself: demoting the account you are
        // standing in would take the panel away mid-action, and the server
        // rejects it anyway.
        const roleControl = isSelf
            ? ''
            : `<select class="form-select user-row-role-select" data-user-action="role" data-user-id="${user.id}" title="Change role">
                   <option value="member"${isAdmin ? '' : ' selected'}>Member</option>
                   <option value="admin"${isAdmin ? ' selected' : ''}>Admin</option>
               </select>`;

        const resendTitle = isPending ? 'Resend invite link' : 'Send a password reset link';

        const toggleBtn = isSelf
            ? ''
            : `<button type="button" class="user-action-btn" data-user-action="${isDisabled ? 'enable' : 'disable'}" data-user-id="${user.id}" title="${isDisabled ? 'Enable account' : 'Disable account'}">
                   ${isDisabled ? ICON_ENABLE : ICON_DISABLE}
               </button>`;

        const deleteBtn = isSelf
            ? ''
            : `<button type="button" class="user-action-btn is-danger" data-user-action="delete" data-user-id="${user.id}" data-user-name="${escapeHtml(user.name)}" title="Delete account">
                   ${ICON_DELETE}
               </button>`;

        // Reuse the directory profile.js already loaded rather than shipping
        // avatar URLs a second time through the users endpoint.
        const photo = window.CRMPeople ? window.CRMPeople.avatarFor(user.id, user.name) : null;
        const avatar = photo
            ? `<div class="user-row-avatar has-photo"><img src="${escapeHtml(photo)}" alt=""></div>`
            : `<div class="user-row-avatar">${escapeHtml(getInitials(user.name))}</div>`;

        return `
            <div class="${classes.join(' ')}">
                ${avatar}
                <div class="user-row-info">
                    <div class="user-row-name">
                        <span>${escapeHtml(user.name)}</span>
                        ${badges.join('')}
                    </div>
                    <div class="user-row-email" title="${escapeHtml(user.email)}">${escapeHtml(user.email)}</div>
                </div>
                <div class="user-row-meta">${meta}</div>
                <div class="user-row-actions">
                    ${roleControl}
                    <button type="button" class="user-action-btn" data-user-action="resend" data-user-id="${user.id}" title="${resendTitle}">
                        ${ICON_LINK}
                    </button>
                    ${toggleBtn}
                    ${deleteBtn}
                </div>
            </div>
        `;
    }

    const ICON_LINK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>';
    const ICON_DISABLE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z"/></svg>';
    const ICON_ENABLE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
    const ICON_DELETE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

    // ------------------------------------------------------------------
    // The one-time link callout
    // ------------------------------------------------------------------

    /**
     * Show the generated link.
     *
     * It is shown whether or not the email went out: shared hosting often
     * cannot send mail, and an admin who can copy the link can still finish
     * setting the account up by hand.
     */
    function showLink(result, name) {
        if (!els.linkBox) return;

        const isReset = result.purpose === 'reset';
        els.linkTitle.textContent = isReset ? 'Password reset link' : 'Invite link';

        const expires = result.invite_expires_at
            ? new Date(result.invite_expires_at * 1000).toLocaleString()
            : null;

        let note = result.mail_sent
            ? 'Emailed to ' + name + '. You can also share this link directly.'
            : 'The email could not be sent - share this link with ' + name + ' instead.';
        if (expires) {
            note += ' It expires on ' + expires + ' and works once.';
        }

        els.linkNote.textContent = note;
        els.linkInput.value = result.invite_link || '';
        els.linkBox.hidden = false;
    }

    function hideLink() {
        if (els.linkBox) els.linkBox.hidden = true;
    }

    async function copyLink() {
        if (!els.linkInput || !els.linkInput.value) return;

        try {
            await navigator.clipboard.writeText(els.linkInput.value);
            showToast('Link copied.');
        } catch (e) {
            // Clipboard access is blocked in some browsers/contexts; selecting
            // the text lets the user copy it themselves.
            els.linkInput.select();
            showToast('Press Ctrl+C to copy.', false);
        }
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    async function load() {
        try {
            const result = await api('');
            state.users = result.data || [];
            state.me = result.me || null;
            render();
        } catch (e) {
            els.list.innerHTML =
                '<div class="users-empty">' + escapeHtml(e.message) + '</div>';
        }
    }

    async function invite(event) {
        event.preventDefault();
        if (state.busy) return;

        const name = els.inviteName.value.trim();
        const email = els.inviteEmail.value.trim();
        const role = els.inviteRole.value;

        if (!name || !email) return;

        state.busy = true;
        els.inviteSubmit.disabled = true;

        try {
            const result = await api('', {
                method: 'POST',
                body: JSON.stringify({ name, email, role })
            });

            els.inviteName.value = '';
            els.inviteEmail.value = '';
            els.inviteRole.value = 'member';

            showLink(result, name);
            showToast(result.mail_sent ? 'Invite sent to ' + email : 'User created - share the link below.');
            await load();
        } catch (e) {
            showToast(e.message, true);
        } finally {
            state.busy = false;
            els.inviteSubmit.disabled = false;
        }
    }

    async function changeRole(userId, role) {
        try {
            await api('?id=' + encodeURIComponent(userId), {
                method: 'PATCH',
                body: JSON.stringify({ role })
            });
            showToast(role === 'admin' ? 'Promoted to admin.' : 'Changed to member.');
            await load();
        } catch (e) {
            showToast(e.message, true);
            await load();
        }
    }

    async function setStatus(userId, status) {
        try {
            await api('?id=' + encodeURIComponent(userId), {
                method: 'PATCH',
                body: JSON.stringify({ status })
            });
            showToast(status === 'disabled' ? 'Account disabled.' : 'Account enabled.');
            await load();
        } catch (e) {
            showToast(e.message, true);
        }
    }

    async function resend(userId) {
        const user = state.users.find(u => Number(u.id) === Number(userId));

        try {
            const result = await api('?id=' + encodeURIComponent(userId) + '&action=resend', {
                method: 'PATCH'
            });
            showLink(result, user ? user.name : 'the user');
            showToast(result.mail_sent ? 'Link emailed.' : 'Link created - copy it below.');
        } catch (e) {
            showToast(e.message, true);
        }
    }

    async function remove(userId, userName) {
        const confirmed = window.confirm(
            'Delete ' + userName + '?\n\n' +
            'They lose access immediately. Everything they created stays, and keeps their name.'
        );
        if (!confirmed) return;

        try {
            await api('?id=' + encodeURIComponent(userId), { method: 'DELETE' });
            showToast(userName + ' deleted.');
            hideLink();
            await load();
        } catch (e) {
            showToast(e.message, true);
        }
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    async function openPanel() {
        if (!els.modal) return;
        els.modal.classList.add('active');
        hideLink();

        // Refresh faces first so the list paints with current pictures.
        if (window.CRMPeople) {
            try {
                await window.CRMPeople.reload();
            } catch (e) {
                // Falling back to initials is fine.
            }
        }

        load();
    }

    function closePanel() {
        if (!els.modal) return;
        els.modal.classList.remove('active');
    }

    function init() {
        els.modal = $('usersModal');
        if (!els.modal) return; // Not an admin - the panel is not in the DOM.

        els.list = $('usersList');
        els.inviteForm = $('inviteUserForm');
        els.inviteName = $('inviteName');
        els.inviteEmail = $('inviteEmail');
        els.inviteRole = $('inviteRole');
        els.inviteSubmit = $('inviteSubmitBtn');
        els.linkBox = $('usersLinkBox');
        els.linkTitle = $('usersLinkTitle');
        els.linkNote = $('usersLinkNote');
        els.linkInput = $('usersLinkInput');

        const openBtn = $('manageUsersBtn');
        if (openBtn) openBtn.addEventListener('click', openPanel);

        const closeBtn = $('closeUsersModal');
        if (closeBtn) closeBtn.addEventListener('click', closePanel);

        const backdrop = els.modal.querySelector('.modal-backdrop');
        if (backdrop) backdrop.addEventListener('click', closePanel);

        els.inviteForm.addEventListener('submit', invite);

        const copyBtn = $('usersLinkCopy');
        if (copyBtn) copyBtn.addEventListener('click', copyLink);

        const dismissBtn = $('usersLinkDismiss');
        if (dismissBtn) dismissBtn.addEventListener('click', hideLink);

        // Delegated, so rows re-rendered after every change stay live without
        // rebinding - and so no inline handler is needed under the CSP.
        els.list.addEventListener('click', function (event) {
            const trigger = event.target.closest('[data-user-action]');
            if (!trigger || trigger.tagName === 'SELECT') return;

            const action = trigger.getAttribute('data-user-action');
            const userId = trigger.getAttribute('data-user-id');

            if (action === 'resend') resend(userId);
            else if (action === 'disable') setStatus(userId, 'disabled');
            else if (action === 'enable') setStatus(userId, 'active');
            else if (action === 'delete') remove(userId, trigger.getAttribute('data-user-name') || 'this user');
        });

        els.list.addEventListener('change', function (event) {
            const select = event.target.closest('select[data-user-action="role"]');
            if (!select) return;
            changeRole(select.getAttribute('data-user-id'), select.value);
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && els.modal.classList.contains('active')) {
                closePanel();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.CRMUsers = { open: openPanel };
})();
