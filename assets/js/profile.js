/**
 * Profile pictures
 *
 * Two jobs:
 *   1. The popover behind the chip at the foot of the sidebar: your picture
 *      (click the face for upload / remove), your name, and the menu. You can
 *      only ever change your own - the endpoint takes no "whose" parameter.
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
            if (isError) window.CRMDialog.alert(message);
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

            // Faces already on screen may have been drawn with initials while
            // this was loading - bring them up to date.
            refreshRenderedFaces();

            // Other modules (the sidebar team list) paint from this directory.
            window.dispatchEvent(new CustomEvent('crm:people'));
        } catch (e) {
            // A missing directory just means initials everywhere - not an error
            // worth interrupting anyone over.
        }
    }

    const CLAUDE_AVATAR = 'assets/img/claude-avatar.svg';

    /** Whether an attribution without an account id is Claude's. */
    function isClaude(actorName) {
        const meta = document.querySelector('meta[name="claude-actor-name"]');
        const claudeName = meta ? meta.getAttribute('content') : 'Claude';
        return !!actorName && !!claudeName && String(actorName).toLowerCase() === claudeName.toLowerCase();
    }

    /**
     * The picture URL for an actor, or null when there is none.
     */
    function avatarFor(actorId, actorName) {
        if (actorId !== null && actorId !== undefined && actorId !== '') {
            const person = state.people.get(String(actorId));
            if (person && person.avatar_url) return person.avatar_url;
        } else if (isClaude(actorName)) {
            // Claude writes without an account, under its own name (api/mcp.php),
            // and wears its own mark as its picture.
            return CLAUDE_AVATAR;
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

        // Without a picture, the face keeps showing that it can be clicked.
        if (els.face) els.face.classList.toggle('is-empty', !url);
        if (els.removeBtn) els.removeBtn.hidden = !url;
        if (els.photoBtnLabel) els.photoBtnLabel.textContent = url ? 'Upload new photo' : 'Upload photo';
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
        if (els.face) els.face.classList.add('is-busy');

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
            if (els.face) els.face.classList.remove('is-busy');
            if (els.input) els.input.value = '';
        }
    }

    async function removePhoto() {
        closePhotoMenu();
        if (state.busy) return;
        state.busy = true;
        if (els.face) els.face.classList.add('is-busy');

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
            if (els.face) els.face.classList.remove('is-busy');
        }
    }

    // ------------------------------------------------------------------
    // My own name
    // ------------------------------------------------------------------

    function startRename() {
        if (!els.nameForm) return;
        closePhotoMenu();
        els.nameInput.value = els.name.textContent.trim();
        els.nameForm.hidden = false;
        els.nameEdit.hidden = true;
        els.nameInput.focus();
        els.nameInput.select();
    }

    function stopRename() {
        if (!els.nameForm || els.nameForm.hidden) return false;
        els.nameForm.hidden = true;
        els.nameEdit.hidden = false;
        return true;
    }

    async function saveName() {
        const name = els.nameInput.value.trim();
        if (!name || state.busy) return;
        if (name === els.name.textContent.trim()) {
            stopRename();
            return;
        }

        state.busy = true;
        els.nameSave.disabled = true;
        try {
            const result = await api('?action=name', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            applyMyName(result.name);
            stopRename();
            await loadDirectory();
            showToast('Name updated.');
        } catch (e) {
            showToast(e.message, true);
        } finally {
            state.busy = false;
            els.nameSave.disabled = false;
        }
    }

    /** The new name everywhere it was printed into the page. */
    function applyMyName(name) {
        if (state.me) state.me.name = name;
        els.name.textContent = name;
        document.querySelectorAll('.user-chip-name').forEach(node => { node.textContent = name; });
        // The initials stand in for a missing picture.
        applyMyAvatar(state.me ? state.me.avatar_url : null);
    }

    /**
     * Swap in freshly uploaded pictures on by-lines that are already on screen,
     * so the change is visible without a reload.
     */
    function refreshRenderedFaces() {
        // Attribution faces and assignee faces carry the same data-actor-*
        // attributes; both are repainted, so a list drawn before the directory
        // arrived catches up instead of keeping its initials.
        document.querySelectorAll('.by-line-avatar[data-actor-name], .assignee-chip[data-actor-name]').forEach(node => {
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
        closePhotoMenu();
        stopRename();
        els.pop.hidden = true;
        els.chip.setAttribute('aria-expanded', 'false');
    }

    function openPhotoMenu() {
        if (!els.photoMenu || state.busy) return;
        stopRename();
        els.photoMenu.hidden = false;
        els.face.setAttribute('aria-expanded', 'true');
    }

    function closePhotoMenu() {
        if (!els.photoMenu || els.photoMenu.hidden) return false;
        els.photoMenu.hidden = true;
        els.face.setAttribute('aria-expanded', 'false');
        return true;
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
        els.face = $('profilePhotoToggle');
        els.photoMenu = $('profilePhotoMenu');
        els.photoBtn = $('profilePhotoBtn');
        els.photoBtnLabel = $('profilePhotoBtnLabel');
        els.removeBtn = $('profileRemoveBtn');
        els.input = $('profilePhotoInput');
        els.name = $('profilePopName');
        els.nameEdit = $('profileNameEdit');       // Not there for the owner login.
        els.nameForm = $('profileNameForm');
        els.nameInput = $('profileNameInput');
        els.nameSave = $('profileNameSave');

        if (!els.chip) return; // Not signed in.

        els.chip.addEventListener('click', function (event) {
            event.stopPropagation();
            togglePop();
        });

        if (els.face) {
            els.face.addEventListener('click', () => (els.photoMenu.hidden ? openPhotoMenu() : closePhotoMenu()));
        }

        if (els.photoBtn) {
            els.photoBtn.addEventListener('click', function () {
                closePhotoMenu();
                if (els.input) els.input.click();
            });
        }

        if (els.input) {
            els.input.addEventListener('change', function () {
                if (this.files && this.files[0]) uploadPhoto(this.files[0]);
            });
        }

        if (els.removeBtn) {
            els.removeBtn.addEventListener('click', removePhoto);
        }

        if (els.nameForm) {
            els.nameEdit.addEventListener('click', startRename);
            $('profileNameCancel').addEventListener('click', stopRename);
            els.nameForm.addEventListener('submit', function (event) {
                event.preventDefault();
                saveName();
            });
        }

        // Going to the Users page from the menu puts the menu away; a click
        // anywhere else in the popover puts the picture menu away.
        els.pop.addEventListener('click', function (event) {
            if (event.target.closest('[data-view]')) closePop();
            else if (!event.target.closest('#profilePhotoMenu, #profilePhotoToggle')) closePhotoMenu();
        });

        // Click outside or press Escape to dismiss.
        document.addEventListener('click', function (event) {
            if (els.pop && !els.pop.hidden && !els.pop.contains(event.target)) {
                closePop();
            }
        });
        // Escape steps back one level: the picture menu or the name field first.
        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape' || !els.pop || els.pop.hidden) return;
            if (closePhotoMenu()) {
                els.face.focus();
            } else if (stopRename()) {
                els.nameEdit.focus();
            } else {
                closePop();
            }
        });

        loadDirectory();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /**
     * Everyone who can be assigned work, alphabetically as the endpoint
     * returned them.
     *
     * The owner login is left out: it is the recovery account behind
     * APP_PASSWORD, not a person on the team, so it is not offered in the team
     * list or any assignment picker. It stays in the directory itself, so
     * records already assigned to it still show its name and face.
     */
    function list() {
        return Array.from(state.people.values()).filter(person => person.id !== null);
    }

    /**
     * The signed-in identity, as the assignment picker needs it: the owner has
     * no numeric id, so it is addressed by the string 'owner'.
     */
    function meKey() {
        if (!state.me) return null;
        return state.me.is_owner ? 'owner' : String(state.me.id);
    }

    // Consumed by app.js (by-lines, assignment) and users.js (the admin list).
    window.CRMPeople = {
        avatarFor: avatarFor,
        list: list,
        me: () => state.me,
        meKey: meKey,
        ready: () => state.people.size > 0,
        reload: loadDirectory,
        refresh: refreshRenderedFaces
    };
})();
