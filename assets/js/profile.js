/**
 * Profile pictures
 *
 * Two jobs:
 *   1. The popover behind the header chip, where you set or clear your own
 *      picture. You can only ever change your own - the endpoint takes no
 *      "whose" parameter at all.
 *   2. A small directory of everyone's name and picture, published as
 *      window.CRMPeople, so attribution lines elsewhere can show a face
 *      instead of initials.
 */
(function () {
    'use strict';

    const API = 'api/profile.php';

    const state = {
        people: new Map(),   // id (or 'owner') -> { name, avatar_url }
        byName: new Map(),   // lowercased name -> avatar_url, for legacy rows
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

    async function api(path, options = {}) {
        const headers = Object.assign({ 'X-CSRF-Token': getCsrfToken() }, options.headers || {});
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
    // Directory
    // ------------------------------------------------------------------

    /**
     * Load everyone's name and picture once per page load.
     *
     * Attribution is stored as an id plus a name snapshot, so lookups try the
     * id first and fall back to the name. That second path is what keeps a
     * face on rows written before the person had an account - and on rows
     * whose account has since been deleted, where only the name survives.
     */
    async function loadDirectory() {
        try {
            const result = await api('?action=directory');

            state.people.clear();
            state.byName.clear();

            (result.data || []).forEach(person => {
                const key = person.id === null ? 'owner' : String(person.id);
                state.people.set(key, person);
                if (person.name) {
                    state.byName.set(String(person.name).toLowerCase(), person.avatar_url || null);
                }
            });

            state.me = result.me || null;
            applyMyAvatar(state.me ? state.me.avatar_url : null);
        } catch (e) {
            // A missing directory just means initials everywhere - not an error
            // worth interrupting anyone over.
        }
    }

    /**
     * The picture URL for an actor, or null when there is none.
     */
    function avatarFor(actorId, actorName) {
        if (actorId !== null && actorId !== undefined && actorId !== '') {
            const person = state.people.get(String(actorId));
            if (person && person.avatar_url) return person.avatar_url;
        }

        if (actorName) {
            const byName = state.byName.get(String(actorName).toLowerCase());
            if (byName) return byName;
        }

        return null;
    }

    // ------------------------------------------------------------------
    // My own picture
    // ------------------------------------------------------------------

    /**
     * Paint the current picture into the header chip and the popover, or fall
     * back to initials.
     */
    function applyMyAvatar(url) {
        const name = state.me ? state.me.name : '';
        const initials = getInitials(name);

        [els.chipAvatar, els.popAvatar].forEach(node => {
            if (!node) return;

            if (url) {
                node.textContent = '';
                node.classList.add('has-photo');
                const img = document.createElement('img');
                img.src = url;
                img.alt = '';
                node.appendChild(img);
            } else {
                node.classList.remove('has-photo');
                node.textContent = initials;
            }
        });

        if (els.removeBtn) els.removeBtn.hidden = !url;
        if (els.photoBtnLabel) els.photoBtnLabel.textContent = url ? 'Change photo' : 'Upload photo';
    }

    async function uploadPhoto(file) {
        if (!file || state.busy) return;

        // Checked again on the server; this is only so an obvious mistake gets
        // an instant answer instead of a round trip.
        if (file.size > 5 * 1024 * 1024) {
            showToast('Please choose an image under 5 MB.', true);
            return;
        }

        state.busy = true;
        if (els.photoBtn) els.photoBtn.disabled = true;

        try {
            const form = new FormData();
            form.append('avatar', file);
            form.append('csrf_token', getCsrfToken());

            const result = await api('?action=avatar', { method: 'POST', body: form });

            applyMyAvatar(result.avatar_url);
            await loadDirectory();
            refreshRenderedFaces();
            showToast('Profile picture updated.');
        } catch (e) {
            showToast(e.message, true);
        } finally {
            state.busy = false;
            if (els.photoBtn) els.photoBtn.disabled = false;
            if (els.input) els.input.value = '';
        }
    }

    async function removePhoto() {
        if (state.busy) return;
        state.busy = true;

        try {
            await api('?action=avatar', { method: 'DELETE' });
            applyMyAvatar(null);
            await loadDirectory();
            refreshRenderedFaces();
            showToast('Profile picture removed.');
        } catch (e) {
            showToast(e.message, true);
        } finally {
            state.busy = false;
        }
    }

    /**
     * Swap in freshly uploaded pictures on by-lines that are already on screen,
     * so the change is visible without a reload.
     */
    function refreshRenderedFaces() {
        document.querySelectorAll('.by-line-avatar[data-actor-name]').forEach(node => {
            const url = avatarFor(node.getAttribute('data-actor-id'), node.getAttribute('data-actor-name'));
            const existing = node.querySelector('img');

            if (url && (!existing || existing.getAttribute('src') !== url)) {
                node.textContent = '';
                node.classList.add('has-photo');
                const img = document.createElement('img');
                img.src = url;
                img.alt = '';
                node.appendChild(img);
            } else if (!url && existing) {
                node.classList.remove('has-photo');
                node.textContent = getInitials(node.getAttribute('data-actor-name'));
            }
        });
    }

    // ------------------------------------------------------------------
    // Popover
    // ------------------------------------------------------------------

    function openPop() {
        if (!els.pop) return;
        els.pop.hidden = false;
        els.chip.setAttribute('aria-expanded', 'true');
    }

    function closePop() {
        if (!els.pop) return;
        els.pop.hidden = true;
        els.chip.setAttribute('aria-expanded', 'false');
    }

    function togglePop() {
        if (!els.pop) return;
        els.pop.hidden ? openPop() : closePop();
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function init() {
        els.chip = $('userChip');
        els.chipAvatar = $('userChipAvatar');
        els.pop = $('profilePop');
        els.popAvatar = $('profilePopAvatar');
        els.photoBtn = $('profilePhotoBtn');
        els.photoBtnLabel = $('profilePhotoBtnLabel');
        els.removeBtn = $('profileRemoveBtn');
        els.input = $('profilePhotoInput');

        if (!els.chip) return; // Not signed in.

        els.chip.addEventListener('click', function (event) {
            event.stopPropagation();
            togglePop();
        });

        if (els.photoBtn) {
            els.photoBtn.addEventListener('click', () => els.input && els.input.click());
        }

        if (els.input) {
            els.input.addEventListener('change', function () {
                if (this.files && this.files[0]) uploadPhoto(this.files[0]);
            });
        }

        if (els.removeBtn) {
            els.removeBtn.addEventListener('click', removePhoto);
        }

        // Click outside or press Escape to dismiss.
        document.addEventListener('click', function (event) {
            if (els.pop && !els.pop.hidden && !els.pop.contains(event.target)) {
                closePop();
            }
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && els.pop && !els.pop.hidden) closePop();
        });

        loadDirectory();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Consumed by app.js (attribution by-lines) and users.js (the admin list).
    window.CRMPeople = {
        avatarFor: avatarFor,
        reload: loadDirectory,
        refresh: refreshRenderedFaces
    };
})();
