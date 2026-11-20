/**
 * Sheets and dialogs grow out of what was clicked, and shrink back into it.
 *
 * On a desktop every .modal opens in the middle of the screen; this file
 * moves it there from the element that opened it - a project card, a to-do
 * row, a button - and on closing back the same way (or, when that element
 * is gone, fades it out in place).
 *
 * How, the way iOS does it: an empty surface - the sheet's colour, corners
 * and shadow, drawn by the browser itself, so the corners never change -
 * grows from the clicked element's rectangle to the sheet's. The sheet's
 * content rides inside it, scaled evenly to fit (never stretched) and
 * fading in from halfway; on closing the other way round. Nothing big
 * slides across the screen, so it looks the same wherever the element was.
 * Apple's ease-in-out, baked into the frames.
 *
 * Nothing that opens or closes a modal needs to know: it watches every
 * .modal's "active" class. On phones the sheets keep rising from the bottom
 * (design.css), and with reduced motion nothing moves.
 */
(function () {
    'use strict';

    const EASE = 'cubic-bezier(0.42, 0, 0.58, 1)';
    const OPEN_MS = 320;
    const CLOSE_MS = 260;

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

    const onScreen = r => r && r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < window.innerHeight;

    /** cubic-bezier(x1, y1, x2, y2) as a function of time, 0..1 -> 0..1. */
    function bezier(x1, y1, x2, y2) {
        const a = (p1, p2) => 1 - 3 * p2 + 3 * p1;
        const b = (p1, p2) => 3 * p2 - 6 * p1;
        const c = p1 => 3 * p1;
        const at = (t, p1, p2) => ((a(p1, p2) * t + b(p1, p2)) * t + c(p1)) * t;
        const slope = (t, p1, p2) => 3 * a(p1, p2) * t * t + 2 * b(p1, p2) * t + c(p1);
        return x => {
            let t = x;
            for (let i = 0; i < 8; i++) {
                const d = slope(t, x1, x2);
                if (Math.abs(d) < 1e-6) break;
                t -= (at(t, x1, x2) - x) / d;
            }
            return at(Math.min(1, Math.max(0, t)), y1, y2);
        };
    }
    const easeInOut = bezier(0.42, 0, 0.58, 1);

    /** The sheet's own rectangle on screen, whatever it is moved by (offsets ignore transforms). */
    function layoutRect(box) {
        let left = 0;
        let top = 0;
        for (let el = box; el; el = el.offsetParent) {
            left += el.offsetLeft;
            top += el.offsetTop;
        }
        return { left, top, width: box.offsetWidth, height: box.offsetHeight };
    }

    /**
     * One step of the way between rectangle `from` (the clicked element) and
     * the sheet as it is laid out now - read at every frame, as a sheet that
     * is still filling in grows and, being centred, moves. `k` is how far
     * towards the element (1 there, 0 at the sheet). The surface takes the
     * in-between rectangle; the content is moved onto it, scaled evenly to
     * fit inside, and cut to it, so it never shows outside.
     */
    function place(s, from, k, shown) {
        const to = layoutRect(s.box);
        const x = to.left + (from.left - to.left) * k;
        const y = to.top + (from.top - to.top) * k;
        const w = to.width + (from.width - to.width) * k;
        const h = to.height + (from.height - to.height) * k;
        const st = s.surface.style;
        st.left = `${x.toFixed(2)}px`;
        st.top = `${y.toFixed(2)}px`;
        st.width = `${w.toFixed(2)}px`;
        st.height = `${h.toFixed(2)}px`;

        const scale = Math.max(0.05, Math.min(w / to.width, h / to.height));
        const cx = to.left + to.width / 2;
        const cy = to.top + to.height / 2;
        const tx = (x + w / 2) - cx;
        const ty = (y + h / 2) - cy;
        const b = s.box.style;
        b.transformOrigin = '50% 50%';
        b.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;
        b.opacity = shown.toFixed(3);
        // The surface in the sheet's own (unscaled) coordinates: the cut.
        const left = (x - (cx + tx)) / scale + to.width / 2;
        const top = (y - (cy + ty)) / scale + to.height / 2;
        const right = to.width - (left + w / scale);
        const bottom = to.height - (top + h / scale);
        const radius = s.radius / scale;
        b.clipPath = `inset(${Math.max(0, top).toFixed(1)}px ${Math.max(0, right).toFixed(1)}px ${Math.max(0, bottom).toFixed(1)}px ${Math.max(0, left).toFixed(1)}px round ${radius.toFixed(1)}px)`;
    }

    /** Run the way frame by frame; `done` when it has arrived. */
    function run(s, from, closing, duration, done) {
        const start = performance.now();
        const step = now => {
            const t = Math.min(1, Math.max(0, (now - start) / duration));
            const e = easeInOut(t);
            const k = closing ? e : 1 - e;
            // In from about halfway on the way in; out in the first third on the way out.
            const shown = closing ? Math.max(0, 1 - t / 0.35) : Math.max(0, (t - 0.4) / 0.6);
            place(s, from, k, easeInOut(Math.min(1, shown)));
            if (t < 1) s.raf = requestAnimationFrame(step);
            else { s.raf = null; done(); }
        };
        step(start);
    }

    /** The empty surface that grows: the sheet's colour, corners and shadow. */
    function surfaceFor(modal, box) {
        const st = getComputedStyle(box);
        const el = document.createElement('div');
        el.className = 'sheet-surface';
        el.setAttribute('aria-hidden', 'true');
        el.style.background = st.backgroundColor;
        el.style.borderRadius = st.borderTopLeftRadius;
        el.style.boxShadow = st.boxShadow;
        modal.insertBefore(el, box);
        return el;
    }

    function stopAll(s) {
        (s.anims || []).forEach(a => { try { a.cancel(); } catch (e) { /* done */ } });
        s.anims = [];
        if (s.raf) cancelAnimationFrame(s.raf);
        s.raf = null;
        settle(s);
    }

    /**
     * While it moves: the element it grows out of hidden - the card becomes
     * the sheet, rather than a sheet coming out of a card that stays - and
     * the sheet itself see-through (.is-riding), its surface drawn by the
     * growing one under it. All put back when it is done.
     */
    function lift(s, box, origin) {
        settle(s);
        s.box = box;
        box.style.willChange = 'transform, opacity';
        if (origin && origin.style) {
            s.hidden = origin;
            s.hiddenWas = origin.style.visibility;
            origin.style.visibility = 'hidden';
        }
    }

    function settle(s) {
        if (s.box) {
            const b = s.box.style;
            b.willChange = '';
            b.transform = '';
            b.transformOrigin = '';
            b.opacity = '';
            b.clipPath = '';
            s.box.classList.remove('is-riding');
        }
        if (s.surface) s.surface.remove();
        if (s.hidden) s.hidden.style.visibility = s.hiddenWas || '';
        s.box = null;
        s.surface = null;
        s.hidden = null;
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

        const backdrop = modal.querySelector(':scope > .modal-backdrop');
        if (backdrop) s.anims.push(backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: EASE }));
        if (origin) {
            lift(s, box, origin.el);
            s.radius = parseFloat(getComputedStyle(box).borderTopLeftRadius) || 20;
            s.surface = surfaceFor(modal, box);
            box.classList.add('is-riding');
            run(s, origin.rect, false, OPEN_MS, () => settle(s));
        } else {
            lift(s, box, null);
            const appear = box.animate([
                { transform: 'translateY(10px) scale(0.98)', opacity: 0 },
                { transform: 'none', opacity: 1 }
            ], { duration: OPEN_MS, easing: EASE });
            s.anims.push(appear);
            appear.onfinish = () => settle(s);
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
        const target = s.origin && s.origin.isConnected ? s.origin.getBoundingClientRect() : null;
        const back = onScreen(target) ? target : null;
        const backdrop = modal.querySelector(':scope > .modal-backdrop');

        const finish = () => {
            if (modal.classList.contains('active')) return;
            modal.classList.remove('is-closing');
            stopAll(s);
        };
        let main = null;
        if (back) {
            lift(s, box, s.origin);
            s.radius = parseFloat(getComputedStyle(box).borderTopLeftRadius) || 20;
            s.surface = surfaceFor(modal, box);
            box.classList.add('is-riding');
            run(s, back, true, CLOSE_MS, finish);
        } else {
            lift(s, box, null);
            main = box.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(8px) scale(0.98)', opacity: 0 }],
                { duration: CLOSE_MS, easing: EASE, fill: 'forwards' });
        }
        if (main) {
            s.anims.push(main);
            main.onfinish = finish;
        }
        if (backdrop) {
            s.anims.push(backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: EASE, fill: 'forwards' }));
        }
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
