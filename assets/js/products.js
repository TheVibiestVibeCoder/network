/**
 * The products our projects are about, kept in the CRM (table products,
 * api/projects.php?action=products) so a new one is added right from the
 * product field: its last option, "New product…", asks for the name.
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
        if (how.includes('new')) html += `<option value="${NEW}">New product…</option>`;
        select.innerHTML = html;
        select.value = names().includes(value) ? value : '';
        select.dataset.previous = select.value;
    }

    /** "New product…": ask for the name, add it, choose it; cancelled, the choice before stays. */
    async function onChange(event) {
        const select = event.target.closest('select[data-product-select]');
        if (!select) return;
        if (select.value !== NEW) {
            select.dataset.previous = select.value;
            return;
        }
        event.stopImmediatePropagation();
        const previous = select.dataset.previous || '';
        select.value = previous;
        const name = await window.CRMDialog.prompt('New product', { confirm: 'Add', placeholder: 'Name, e.g. Media Training' });
        if (!name) {
            select.focus();
            return;
        }
        try {
            const product = await add(name);
            select.value = product.name;
            select.dataset.previous = product.name;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (error) {
            window.CRMDialog.alert(error.message);
        }
        select.focus();
    }

    document.addEventListener('change', onChange, true);
    // What was chosen when the field was entered: back to it if "New product…" is cancelled.
    document.addEventListener('focusin', e => {
        const select = e.target.closest && e.target.closest('select[data-product-select]');
        if (select && select.value !== NEW) select.dataset.previous = select.value;
    });

    window.CRMProducts = { names, short, list: () => products.slice(), load, add, fillSelect };

    writeStyles();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { changed(); load(); });
    } else {
        changed();
        load();
    }
})();
