/**
 * The products our projects are about, kept in the CRM (table products,
 * api/projects.php?action=products) so they are changed right from the
 * product field.
 *
 * The product field's last option, "Edit products…", opens the editor:
 * add, rename, reorder or remove products and give each its colour - the
 * colour is then the product's everywhere.
 *
 * Each product has its colour; this file writes the rules that give every
 * [data-product="…"] its --product-tone, so chips, dots and the forecast's
 * bars take it, a new product included.
 *
 * window.CRMProducts:
 *   names()            the names, in their order
 *   short(name)        its short form for tight places ("WS")
 *   list()             [{ id, name, color, position }]
 *   load()             read them again
 *   add(name)          add one; resolves to it
 *   edit()             the editor: names, short forms, colours, order
 *   fillSelect(select, { none, any, allowNew })   the options of a product select
 *
 * 'crm:products-changed' goes out on document whenever they change.
 */
(function () {
    'use strict';

    // Until the server answers: the products it starts with.
    let products = [
        { id: 0, name: 'Workshop', short: 'WS', color: '#30599D', position: 0 },
        { id: 0, name: 'Risk Briefing', short: 'RB', color: '#1C3258', position: 1 },
        { id: 0, name: 'SHIELD', short: 'SH', color: '#1C7E7E', position: 2 },
        { id: 0, name: 'RB & SHIELD', short: 'RB+SH', color: '#63A375', position: 3 },
        { id: 0, name: 'Other', short: 'Other', color: '#8A94A6', position: 4 }
    ];

    const NEW = '__new_product__';

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const names = () => products.map(p => p.name);

    /** A product's short form ("WS"), or its name when it has none. */
    const short = name => {
        const p = products.find(x => x.name === name);
        return (p && p.short) || String(name || '');
    };

    /** The colour rules: one per product, a lighter tone of it in dark mode. */
    function writeStyles() {
        let tag = document.getElementById('crmProductStyles');
        if (!tag) {
            tag = document.createElement('style');
            tag.id = 'crmProductStyles';
            document.head.appendChild(tag);
        }
        const attr = name => String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const color = c => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#8A94A6');
        tag.textContent = products.map(p => `[data-product="${attr(p.name)}"] { --product-tone: ${color(p.color)}; }
:root[data-theme="dark"] [data-product="${attr(p.name)}"] { --product-tone: color-mix(in srgb, ${color(p.color)} 62%, #ffffff); }`).join('\n');
    }

    function changed() {
        writeStyles();
        if (window.RevenueForecast && window.RevenueForecast.setProducts) window.RevenueForecast.setProducts(names());
        document.querySelectorAll('select[data-product-select]').forEach(select => fillSelect(select));
        document.dispatchEvent(new CustomEvent('crm:products-changed'));
    }

    async function load() {
        try {
            const response = await fetch('api/projects.php?action=products', { headers: { Accept: 'application/json' } });
            const result = await response.json();
            if (response.ok && Array.isArray(result.data) && result.data.length) {
                products = result.data;
                changed();
            }
        } catch (e) {
            // The ones it starts with stay.
        }
        return products;
    }

    async function add(name) {
        const meta = document.querySelector('meta[name="csrf-token"]');
        const response = await fetch('api/projects.php?action=add-product', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': meta ? meta.content : '' },
            body: JSON.stringify({ name })
        });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || 'The product could not be added');
        products = result.products;
        changed();
        return result.data;
    }

    /**
     * The options of a product select, keeping what is chosen. Its
     * data-product-select says how: "none" (a "None" first), "any" (an
     * "Any product" first), "new" (with "New product…" last); space-separated.
     */
    function fillSelect(select) {
        const how = String(select.getAttribute('data-product-select') || '').split(/\s+/);
        const value = select.value;
        let html = '';
        if (how.includes('none')) html += '<option value="">None</option>';
        if (how.includes('any')) html += '<option value="">Any product</option>';
        html += products.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
        if (how.includes('new')) html += `<option value="${NEW}">Edit products…</option>`;
        select.innerHTML = html;
        select.value = names().includes(value) ? value : '';
        select.dataset.previous = select.value;
    }

    /** "Edit products…": the editor; the choice before stays. */
    async function onChange(event) {
        const select = event.target.closest('select[data-product-select]');
        if (!select) return;
        if (select.value !== NEW) {
            select.dataset.previous = select.value;
            return;
        }
        event.stopImmediatePropagation();
        select.value = select.dataset.previous || '';
        await openEditor();
        select.focus();
    }

    // ------------------------------------------------------------------
    // The editor: name, short form, colour and order of every product
    // ------------------------------------------------------------------

    // Colours to pick from: the company palette and tones that sit with it.
    const SWATCHES = ['#1C3258', '#30599D', '#5B7DB8', '#8FB4E4', '#1C7E7E', '#2E8B9A', '#63A375', '#3F8F6B',
        '#D76262', '#B07A3A', '#D08440', '#7A6FB0', '#9A5B7A', '#8A94A6', '#AAB5C5'];

    let editor = null;
    let draft = [];
    let openSwatch = -1;
    let resolveEditor = null;

    function buildEditor() {
        if (editor) return editor;
        editor = document.createElement('div');
        editor.className = 'modal product-editor';
        editor.id = 'productEditorModal';
        editor.innerHTML = `
            <div class="modal-backdrop" data-pe-cancel></div>
            <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="productEditorTitle">
                <div class="modal-header">
                    <h2 id="productEditorTitle">Products</h2>
                    <button type="button" class="modal-close" data-pe-cancel aria-label="Close">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="pe-head" aria-hidden="true"><span></span><span>Name</span><span>Short</span><span></span></div>
                    <ul class="pe-list" id="productEditorList"></ul>
                    <button type="button" class="ov-add-btn pe-add" data-pe-add>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                        Add product
                    </button>
                    <p class="pe-error" id="productEditorError" hidden></p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-pe-cancel>Cancel</button>
                    <button type="button" class="btn btn-primary" data-pe-save>Save</button>
                </div>
            </div>`;
        document.body.appendChild(editor);
        editor.addEventListener('click', onEditorClick);
        editor.addEventListener('input', onEditorInput);
        editor.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); closeEditor(); }
        });
        return editor;
    }

    function openEditor() {
        buildEditor();
        draft = products.map(p => ({ id: p.id, name: p.name, short: p.short || '', color: p.color }));
        openSwatch = -1;
        renderEditor();
        editor.querySelector('#productEditorError').hidden = true;
        editor.classList.add('active');
        const first = editor.querySelector('.pe-name');
        if (first) first.focus();
        return new Promise(resolve => { resolveEditor = resolve; });
    }

    function closeEditor() {
        if (!editor) return;
        editor.classList.remove('active');
        if (resolveEditor) { resolveEditor(); resolveEditor = null; }
    }

    function renderEditor() {
        const list = editor.querySelector('#productEditorList');
        list.innerHTML = draft.map((p, i) => `
            <li class="pe-row">
                <div class="pe-line">
                    <button type="button" class="pe-color" data-pe-color="${i}" style="--pe-color:${esc(p.color)}" aria-expanded="${openSwatch === i}"
                        title="Colour" aria-label="Colour of ${esc(p.name || 'this product')}"></button>
                    <input type="text" class="form-input pe-name" data-pe-name="${i}" value="${esc(p.name)}" maxlength="80" placeholder="Name" aria-label="Name">
                    <input type="text" class="form-input pe-short" data-pe-short="${i}" value="${esc(p.short)}" maxlength="12" placeholder="Auto" aria-label="Short form">
                    <span class="pe-actions">
                        <button type="button" class="pe-icon" data-pe-up="${i}" title="Up" aria-label="Move up"${i === 0 ? ' disabled' : ''}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button>
                        <button type="button" class="pe-icon" data-pe-down="${i}" title="Down" aria-label="Move down"${i === draft.length - 1 ? ' disabled' : ''}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
                        <button type="button" class="pe-icon is-danger" data-pe-remove="${i}" title="Remove" aria-label="Remove ${esc(p.name)}">&times;</button>
                    </span>
                </div>
                ${openSwatch === i ? `
                <div class="pe-swatches">
                    ${SWATCHES.map(c => `<button type="button" class="pe-swatch${c.toUpperCase() === String(p.color).toUpperCase() ? ' is-on' : ''}" data-pe-pick="${i}" data-color="${c}" style="--pe-color:${c}" aria-label="${c}"></button>`).join('')}
                    <label class="pe-custom" title="Any colour"><input type="color" data-pe-custom="${i}" value="${esc(p.color)}" aria-label="Any colour"><span>Other…</span></label>
                </div>` : ''}
            </li>`).join('');
    }

    function onEditorInput(e) {
        const t = e.target;
        if (t.hasAttribute('data-pe-name')) draft[Number(t.getAttribute('data-pe-name'))].name = t.value;
        else if (t.hasAttribute('data-pe-short')) draft[Number(t.getAttribute('data-pe-short'))].short = t.value;
        else if (t.hasAttribute('data-pe-custom')) {
            const i = Number(t.getAttribute('data-pe-custom'));
            draft[i].color = t.value.toUpperCase();
            const btn = editor.querySelector(`[data-pe-color="${i}"]`);
            if (btn) btn.style.setProperty('--pe-color', draft[i].color);
        }
    }

    /** The next colour no product has yet. */
    function freeColor() {
        const used = new Set(draft.map(p => String(p.color).toUpperCase()));
        return SWATCHES.find(c => !used.has(c)) || SWATCHES[draft.length % SWATCHES.length];
    }

    async function onEditorClick(e) {
        const t = e.target.closest('button, [data-pe-cancel]');
        if (!t) return;
        const at = name => Number(t.getAttribute(name));
        if (t.hasAttribute('data-pe-cancel')) {
            closeEditor();
        } else if (t.hasAttribute('data-pe-color')) {
            const i = at('data-pe-color');
            openSwatch = openSwatch === i ? -1 : i;
            renderEditor();
        } else if (t.hasAttribute('data-pe-pick')) {
            draft[at('data-pe-pick')].color = t.getAttribute('data-color');
            openSwatch = -1;
            renderEditor();
        } else if (t.hasAttribute('data-pe-up') || t.hasAttribute('data-pe-down')) {
            const i = t.hasAttribute('data-pe-up') ? at('data-pe-up') : at('data-pe-down');
            const j = t.hasAttribute('data-pe-up') ? i - 1 : i + 1;
            if (j < 0 || j >= draft.length) return;
            [draft[i], draft[j]] = [draft[j], draft[i]];
            openSwatch = -1;
            renderEditor();
            const again = editor.querySelector(t.hasAttribute('data-pe-up') ? `[data-pe-up="${j}"]` : `[data-pe-down="${j}"]`);
            if (again && !again.disabled) again.focus();
        } else if (t.hasAttribute('data-pe-remove')) {
            draft.splice(at('data-pe-remove'), 1);
            openSwatch = -1;
            renderEditor();
        } else if (t.hasAttribute('data-pe-add')) {
            draft.push({ id: null, name: '', short: '', color: freeColor() });
            openSwatch = -1;
            renderEditor();
            const inputs = editor.querySelectorAll('.pe-name');
            if (inputs.length) inputs[inputs.length - 1].focus();
        } else if (t.hasAttribute('data-pe-save')) {
            saveEditor(t);
        }
    }

    async function saveEditor(button) {
        const error = editor.querySelector('#productEditorError');
        const list = draft.filter(p => p.name.trim() !== '' || p.id);
        const removed = products.filter(p => !list.some(d => d.id === p.id));
        if (removed.length) {
            const ok = await window.CRMDialog.confirm(
                `Remove ${removed.map(p => p.name).join(', ')}? Projects with ${removed.length === 1 ? 'it' : 'them'} will have no product.`,
                { confirm: 'Remove', danger: true });
            if (!ok) return;
        }
        button.disabled = true;
        try {
            const meta = document.querySelector('meta[name="csrf-token"]');
            const response = await fetch('api/projects.php?action=save-products', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': meta ? meta.content : '' },
                body: JSON.stringify({ products: list.map(p => ({ id: p.id || null, name: p.name, short: p.short, color: p.color })) })
            });
            const result = await response.json();
            if (!response.ok || result.error) throw new Error(result.error || 'The products could not be saved');
            products = result.data;
            changed();
            closeEditor();
        } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
        } finally {
            button.disabled = false;
        }
    }

    document.addEventListener('change', onChange, true);
    // What was chosen when the field was entered: back to it if "New product…" is cancelled.
    document.addEventListener('focusin', e => {
        const select = e.target.closest && e.target.closest('select[data-product-select]');
        if (select && select.value !== NEW) select.dataset.previous = select.value;
    });

    window.CRMProducts = { names, short, list: () => products.slice(), load, add, fillSelect, edit: openEditor };

    writeStyles();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { changed(); load(); });
    } else {
        changed();
        load();
    }
})();
