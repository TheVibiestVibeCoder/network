/**
 * Sheets and dialogs grow out of what was clicked, and shrink back into it.
 *
 * On a desktop every .modal opens in the middle of the screen; this file
 * moves it there from the element that opened it - a project card, a to-do
 * row, a button - the box growing from that element's place and size while
 * its content fades in, and on closing goes back the same way (or, when that
 * element is gone, fades out in place).
 *
 * Nothing that opens or closes a modal needs to know: it watches every
 * .modal's "active" class. On phones the sheets keep rising from the
 * bottom (design.css), and with reduced motion nothing moves.
 */
(function () {
    'use strict';

    const OPEN_MS = 420;
    const CLOSE_MS = 260;
    const EASE_OPEN = 'cubic-bezier(0.2, 0.9, 0.25, 1)';
    const EASE_CLOSE = 'cubic-bezier(0.4, 0, 0.7, 0.2)';

    const desktop = window.matchMedia('(min-width: 769px)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const enabled = () => desktop.matches && !reduced.matches && typeof Element.prototype.animate === 'function';

    document.documentElement.classList.add('sheet-motion');

    // What was last pressed: the element a modal opening right after grows from.
    let last = null;
    const ORIGIN = '.project-card, .project-row, .contact-card, .pinned-card, .company-row, .co-row, .co-person, .ptodo, .todo-item, '
        + '.home-todo, .home-project, .workload-row, .fin-inv, .bk-row, tr, li, button, a, [role="button"], [data-id]';
    function remember(target) {
        const el = target && target.closest ? target.closest(ORIGIN) : null;
        if (!el) return;
        last = { el, rect: el.getBoundingClientRect(), at: performance.now() };
    }
    document.addEventListener('pointerdown', e => remember(e.target), true);
    document.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') remember(document.activeElement);
    }, true);

    const state = new WeakMap();

    /** Where to grow from: the element pressed a moment ago, if it is on screen. */
    function originFor(modal) {
        if (!last || performance.now() - last.at > 1500) return null;
        if (modal.contains(last.el)) return null;
        const rect = last.el.isConnected ? last.el.getBoundingClientRect() : last.rect;
        if (!rect || rect.width < 2 || rect.height < 2) return null;
        return { el: last.el, rect };
    }

    /** The transform that puts box `to` onto rectangle `from`. */
    function onto(from, to) {
        const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
        const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
        const sx = Math.max(0.04, from.width / to.width);
        const sy = Math.max(0.04, from.height / to.height);
        return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
    }

    function stopAll(s) {
        (s.anims || []).forEach(a => { try { a.cancel(); } catch (e) { /* done */ } });
        s.anims = [];
    }

    function open(modal) {
        const box = modal.querySelector(':scope > .modal-content');
        if (!box) return;
        const s = state.get(modal) || {};
        stopAll(s);
        modal.classList.remove('is-closing');
        const origin = originFor(modal);
        s.origin = origin ? origin.el : null;
        state.set(modal, s);
        if (!enabled()) return;

        const to = box.getBoundingClientRect();
        const parts = Array.from(box.children);
        if (origin) {
            s.anims.push(box.animate([
                { transform: onto(origin.rect, to), opacity: 0.85, transformOrigin: 'center' },
                { transform: 'none', opacity: 1, transformOrigin: 'center' }
            ], { duration: OPEN_MS, easing: EASE_OPEN }));
            // The content comes in once the box has room for it.
            parts.forEach(part => s.anims.push(part.animate([
                { opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }
            ], { duration: OPEN_MS, easing: 'ease-out' })));
        } else {
            s.anims.push(box.animate([
                { transform: 'translateY(10px) scale(0.97)', opacity: 0 },
                { transform: 'none', opacity: 1 }
            ], { duration: 260, easing: EASE_OPEN }));
        }
    }

    function close(modal) {
        const box = modal.querySelector(':scope > .modal-content');
        const s = state.get(modal) || {};
        stopAll(s);
        state.set(modal, s);
        if (!box || !enabled()) return;

        // Shown a moment longer, for the way back.
        modal.classList.add('is-closing');
        const from = box.getBoundingClientRect();
        const target = s.origin && s.origin.isConnected ? s.origin.getBoundingClientRect() : null;
        const back = target && target.width > 1 && target.height > 1 && target.bottom > 0 && target.top < window.innerHeight
            ? target : null;
        const backdrop = modal.querySelector(':scope > .modal-backdrop');

        const main = box.animate(back
            ? [{ transform: 'none', opacity: 1 }, { transform: onto(back, from), opacity: 0.6 }]
            : [{ transform: 'none', opacity: 1 }, { transform: 'translateY(6px) scale(0.97)', opacity: 0 }],
        { duration: CLOSE_MS, easing: EASE_CLOSE, fill: 'forwards' });
        s.anims.push(main);
        Array.from(box.children).forEach(part => s.anims.push(part.animate([
            { opacity: 1 }, { opacity: 0, offset: 0.45 }, { opacity: 0 }
        ], { duration: CLOSE_MS, fill: 'forwards' })));
        if (backdrop) {
            s.anims.push(backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, fill: 'forwards' }));
        }
        main.onfinish = () => {
            if (modal.classList.contains('active')) return;
            modal.classList.remove('is-closing');
            stopAll(s);
        };
    }

    // Every .modal, also the ones made later (dialogs, the product editor).
    const observer = new MutationObserver(records => {
        const seen = new Map();
        records.forEach(r => {
            const el = r.target;
            if (!el.classList || !el.classList.contains('modal')) return;
            if (!seen.has(el)) seen.set(el, /(^|\s)active(\s|$)/.test(r.oldValue || ''));
        });
        seen.forEach((wasActive, modal) => {
            const isActive = modal.classList.contains('active');
            if (isActive && !wasActive) open(modal);
            else if (!isActive && wasActive) close(modal);
        });
    });
    observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
})();
