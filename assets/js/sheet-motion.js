/**
 * Sheets and dialogs grow out of what was clicked, and shrink back into it.
 *
 * On a desktop every .modal opens in the middle of the screen; this file
 * moves it there from the element that opened it - a project card, a to-do
 * row, a button - and on closing back the same way (or, when that element
 * is gone, fades it out in place).
 *
 * The box is never stretched. It stands at its full size and is revealed
 * through a rounded window (a clip-path polygon) that starts as the clicked
 * element's rectangle and opens to the whole box, while the box glides from
 * the element's place to the middle. The window's corners are the box's own
 * - radius and curve (the stylesheet's superellipse corners) - so they stay
 * the same the whole way and nothing jumps at the end; nothing inside is
 * distorted. Apple's ease-in-out, baked into the frames.
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

    function radiusOf(box) {
        const r = parseFloat(getComputedStyle(box).borderTopLeftRadius);
        return Number.isFinite(r) ? r : 16;
    }

    /**
     * The corners' exponent: the stylesheet draws them as superellipses
     * (corner-shape: superellipse(K), exponent 2^K) where the browser can,
     * else as plain arcs (2).
     */
    function cornerExponent(box) {
        const shape = getComputedStyle(box).getPropertyValue('corner-shape') || '';
        const m = /superellipse\(\s*([-\d.]+)\s*\)/.exec(shape);
        if (m) return Math.pow(2, Number(m[1]));
        return /squircle/.test(shape) ? 4 : 2;
    }

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

    const CORNER_POINTS = 10;

    /**
     * A rounded rectangle as a polygon, its corners the same curve the
     * browser draws (|x|^n + |y|^n = 1 over the radius): rectangle `w` x `h`
     * at (x, y) inside the box. Always the same number of points, so one
     * shape can turn into the next.
     */
    function roundedRect(x, y, w, h, radius, n) {
        const r = Math.max(0, Math.min(radius, w / 2, h / 2));
        const pts = [];
        const corner = (cx, cy, sx, sy, from) => {
            for (let i = 0; i <= CORNER_POINTS; i++) {
                const t = (from + i / CORNER_POINTS) * Math.PI / 2;
                const ex = Math.pow(Math.abs(Math.cos(t)), 2 / n);
                const ey = Math.pow(Math.abs(Math.sin(t)), 2 / n);
                pts.push(`${(cx + sx * r * ex).toFixed(2)}px ${(cy + sy * r * ey).toFixed(2)}px`);
            }
        };
        corner(x + r, y + r, -1, -1, 0);         // top left: from the left edge up to the top
        corner(x + w - r, y + r, 1, -1, 0);      // top right
        corner(x + w - r, y + h - r, 1, 1, 0);   // bottom right
        corner(x + r, y + h - r, -1, 1, 0);      // bottom left
        // Each corner from its horizontal to its vertical point, in turn.
        return `polygon(${orderCorners(pts).join(', ')})`;
    }

    /** The four corners' points so the outline runs once around, clockwise. */
    function orderCorners(pts) {
        const k = CORNER_POINTS + 1;
        const tl = pts.slice(0, k);              // (left, y) .. (x, top) when walked backwards
        const tr = pts.slice(k, 2 * k);
        const br = pts.slice(2 * k, 3 * k);
        const bl = pts.slice(3 * k, 4 * k);
        // tl runs from the left edge (t=0) to the top (t=90deg): left edge first is right for clockwise.
        // tr runs from the right edge to the top: reverse it, top first.
        // br runs from the right edge to the bottom: right edge first.
        // bl runs from the left edge to the bottom: reverse it, bottom first.
        return tl.concat(tr.slice().reverse(), br, bl.slice().reverse());
    }

    /**
     * The box's way between rectangle `from` (the clicked element) and its
     * own place `box`, frame by frame with Apple's ease-in-out baked in: it
     * glides so its middle moves from the element's to its own, and is cut
     * to a rounded window that grows from the element's size to its own -
     * corners the box's own radius and curve all the way, so nothing jumps
     * when the window is gone.
     */
    function frames(from, box, radius, n, closing) {
        const W = box.width;
        const H = box.height;
        const w0 = Math.min(from.width, W);
        const h0 = Math.min(from.height, H);
        const tx0 = (from.left + from.width / 2) - (box.left + W / 2);
        const ty0 = (from.top + from.height / 2) - (box.top + H / 2);
        const out = [];
        const N = 24;
        for (let i = 0; i <= N; i++) {
            const e = easeInOut(i / N);
            const k = closing ? e : 1 - e; // how far towards the element
            const w = W + (w0 - W) * k;
            const h = H + (h0 - H) * k;
            out.push({
                offset: i / N,
                transform: `translate(${(tx0 * k).toFixed(2)}px, ${(ty0 * k).toFixed(2)}px)`,
                clipPath: roundedRect((W - w) / 2, (H - h) / 2, w, h, radius, n)
            });
        }
        return out;
    }

    function stopAll(s) {
        (s.anims || []).forEach(a => { try { a.cancel(); } catch (e) { /* done */ } });
        s.anims = [];
        settle(s);
    }

    /**
     * While it moves: the element it grows out of hidden - the card becomes
     * the sheet, rather than a sheet coming out of a card that stays.
     */
    function lift(s, box, origin) {
        settle(s);
        s.box = box;
        box.style.willChange = 'transform, clip-path';
        if (origin && origin.style) {
            s.hidden = origin;
            s.hiddenWas = origin.style.visibility;
            origin.style.visibility = 'hidden';
        }
    }

    function settle(s) {
        if (s.box) s.box.style.willChange = '';
        if (s.hidden) s.hidden.style.visibility = s.hiddenWas || '';
        s.box = null;
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
        const parts = Array.from(box.children);

        if (origin) {
            const way = frames(origin.rect, box.getBoundingClientRect(), radiusOf(box), cornerExponent(box), false);
            lift(s, box, origin.el);
            // The window would cut the box's shadow: it comes in at the end.
            const shadow = getComputedStyle(box).boxShadow;
            const grow = box.animate(way, { duration: OPEN_MS, easing: 'linear' });
            s.anims.push(grow);
            // The card grows empty; its content comes in at the end, growing a
            // little with it, rather than being there all along behind the window.
            parts.forEach(part => s.anims.push(part.animate([
                { opacity: 0, transform: 'scale(0.96)', transformOrigin: '50% 0' },
                { opacity: 0, transform: 'scale(0.96)', transformOrigin: '50% 0', offset: 0.6 },
                { opacity: 1, transform: 'none', transformOrigin: '50% 0' }
            ], { duration: OPEN_MS + 60, easing: EASE })));
            grow.onfinish = () => {
                settle(s);
                if (shadow && shadow !== 'none') {
                    s.anims.push(box.animate([{ boxShadow: 'none' }, { boxShadow: shadow }], { duration: 140, easing: EASE }));
                }
            };
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

        let main;
        if (back) {
            const way = frames(back, box.getBoundingClientRect(), radiusOf(box), cornerExponent(box), true);
            lift(s, box, s.origin);
            main = box.animate(way, { duration: CLOSE_MS, easing: 'linear', fill: 'forwards' });
            // The content leaves first, shrinking a little; then the empty card goes back.
            Array.from(box.children).forEach(part => s.anims.push(part.animate([
                { opacity: 1, transform: 'none', transformOrigin: '50% 0' },
                { opacity: 0, transform: 'scale(0.96)', transformOrigin: '50% 0', offset: 0.3 },
                { opacity: 0, transform: 'scale(0.96)', transformOrigin: '50% 0' }
            ], { duration: CLOSE_MS, easing: EASE, fill: 'forwards' })));
        } else {
            lift(s, box, null);
            main = box.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(8px) scale(0.98)', opacity: 0 }],
                { duration: CLOSE_MS, easing: EASE, fill: 'forwards' });
        }
        s.anims.push(main);
        if (backdrop) {
            s.anims.push(backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: EASE, fill: 'forwards' }));
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
