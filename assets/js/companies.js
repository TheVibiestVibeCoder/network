/**
 * Companies: the company sheet, the list behind every company field, and
 * the look-alike names to merge.
 *
 * A company is a record of its own (api/companies.php). Its sheet
 * (#companyNotesModal) shows what we have with it: figures, its projects,
 * its people, our invoices to it (admins, from Bookkeeping) and every note
 * filed under it. It opens from the contacts list, a contact's or a
 * project's company, and the invoices on Financials.
 *
 * window.CRMCompany:
 *   open(idOrName)   the sheet; a name not known as a company shows its notes only
 *   list(force)      every company [{ id, name, contacts, projects }], cached
 *   byName(name)     the company of that name in the cached list, or null
 *   refresh()        reload the list and the look-alikes after a change
 */
(function () {
    'use strict';

    const API = 'api/companies.php';
    const PRODUCTS = ['Workshop', 'Risk Briefing', 'SHIELD', 'RB & SHIELD', 'Other'];
    const RUNNING = ['In Progress'];
    const WON = ['Complete', 'In Progress'];
    const OPEN = ['Lead', 'Proposal', 'Negotiation'];

    const state = {
        list: null,
        listPromise: null,
        similar: [],
        company: null,      // the detail being shown
        name: null,         // a name without a company record (legacy)
        invoices: null,     // { items, total } from CompanyInvoices, admins only
        editing: false,
        busy: false,
        token: 0
    };

    const $ = id => document.getElementById(id);
    let els = null;

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const euro = n => window.CRMFormat.amount(n, { cents: 'never' });
    const day = iso => (iso ? window.CRMFormat.date(iso, { year: true }) : '');
    const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || word + 's')}`;

    function csrf() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    async function request(method, url, body) {
        const options = { method, headers: { Accept: 'application/json' } };
        if (method !== 'GET') {
            options.headers['Content-Type'] = 'application/json';
            options.headers['X-CSRF-Token'] = csrf();
            if (body !== undefined) options.body = JSON.stringify(body);
        }
        const response = await fetch(url, options);
        const result = await response.json().catch(() => ({ error: 'Unexpected answer' }));
        if (!response.ok || result.error) throw new Error(result.error || 'Request failed');
        return result.data;
    }

    // ------------------------------------------------------------------
    // The list
    // ------------------------------------------------------------------

    function list(force) {
        if (state.list && !force) return Promise.resolve(state.list);
        if (state.listPromise && !force) return state.listPromise;
        state.listPromise = request('GET', API)
            .then(rows => { state.list = rows; return rows; })
            .finally(() => { state.listPromise = null; });
        return state.listPromise;
    }

    function byName(name) {
        const key = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
        if (!key || !state.list) return null;
        return state.list.find(c => c.name.toLowerCase() === key) || null;
    }

    async function refresh() {
        await list(true).catch(() => null);
        loadSimilar();
        document.dispatchEvent(new CustomEvent('crm:companies-changed'));
    }

    // ------------------------------------------------------------------
    // The sheet
    // ------------------------------------------------------------------

    async function open(ref) {
        bind();
        const token = ++state.token;
        state.editing = false;
        state.company = null;
        state.invoices = null;
        state.name = null;
        els.modal.classList.remove('is-editing');

        let id = typeof ref === 'number' ? ref : null;
        if (id === null && ref) {
            const known = byName(ref);
            if (known) id = known.id;
            else {
                await list(true).catch(() => null);
                const again = byName(ref);
                if (again) id = again.id;
            }
        }

        els.title.textContent = id === null ? String(ref || '') : '';
        els.sub.textContent = '';
        els.body.innerHTML = '<p class="empty-hint">Loading…</p>';
        els.notes.innerHTML = '';
        els.modal.classList.add('active');

        try {
            if (id === null) {
                state.name = String(ref || '');
                renderHead();
                els.body.innerHTML = '';
            } else {
                const company = await request('GET', `${API}?id=${id}`);
                if (token !== state.token) return;
                state.company = company;
                renderHead();
                render();
                loadInvoices(token);
            }
            loadNotes(token);
        } catch (error) {
            if (token !== state.token) return;
            els.body.innerHTML = `<p class="empty-hint">${esc(error.message)}</p>`;
        }
    }

    function close() {
        if (!els) return;
        state.token++;
        els.modal.classList.remove('active', 'is-editing');
        state.editing = false;
    }

    function renderHead() {
        const c = state.company;
        els.title.textContent = c ? c.name : state.name;
        els.editBtn.hidden = !c;
        if (!c) {
            els.sub.textContent = 'Notes filed under this name';
            return;
        }
        const website = c.website ? String(c.website) : '';
        const href = website && !/^https?:\/\//i.test(website) ? 'https://' + website : website;
        const lines = [];
        if (website) {
            lines.push(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(website.replace(/^https?:\/\//i, '').replace(/\/$/, ''))}</a>`);
        }
        const details = [c.address ? String(c.address).replace(/\s*\n\s*/g, ', ') : '', c.vat_id ? `UID ${c.vat_id}` : ''].filter(Boolean);
        if (details.length) lines.push(`<span class="co-head-details">${esc(details.join(', '))}</span>`);
        els.sub.innerHTML = lines.join('');
    }

    /** A project's budget as one figure: the middle of its range. */
    function budgetMid(p) {
        const min = p.budget_min === null || p.budget_min === '' ? null : Number(p.budget_min);
        const max = p.budget_max === null || p.budget_max === '' ? null : Number(p.budget_max);
        if (min === null && max === null) return 0;
        if (min === null) return max;
        if (max === null) return min;
        return (min + max) / 2;
    }

    const STAGE_ORDER = ['Complete', 'In Progress', 'Proposal', 'Negotiation', 'Lead'];
    const stageClass = stage => String(stage || 'Lead').toLowerCase().replace(/ /g, '-');
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /**
     * The head of the sheet: the one number that says what the company is
     * worth to us - what we invoiced (admins), otherwise the budgets won -
     * with its share of all we invoiced as a ring.
     */
    function heroHtml() {
        const c = state.company;
        const projects = c.projects || [];
        const inv = state.invoices && state.invoices.stats;
        const won = projects.filter(p => WON.includes(p.stage)).reduce((s, p) => s + budgetMid(p), 0);
        const invoiced = inv && inv.count;
        const value = invoiced ? inv.net : won;
        const sub = invoiced
            ? `invoiced, net${inv.since ? `, since ${window.CRMFormat.month(inv.since)}` : ''}`
            : 'won, by the projects\' budgets';
        let ring = '';
        if (invoiced && inv.share !== null) {
            const pct = Math.max(0, Math.min(1, inv.share));
            const r = 30;
            const len = 2 * Math.PI * r;
            ring = `
                <div class="co-ring" title="${esc(Math.round(pct * 100) + '% of everything we invoiced, net')}">
                    <svg viewBox="0 0 76 76" width="76" height="76" aria-hidden="true">
                        <circle cx="38" cy="38" r="${r}" class="co-ring-track"/>
                        <circle cx="38" cy="38" r="${r}" class="co-ring-value" stroke-dasharray="${(len * pct).toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 38 38)"/>
                    </svg>
                    <span class="co-ring-text"><strong>${esc(pct < 0.01 && pct > 0 ? '<1' : Math.round(pct * 100))}%</strong></span>
                    <span class="co-ring-label">of our revenue</span>
                </div>`;
        }
        return `
            <div class="co-hero">
                <div class="co-hero-main">
                    <span class="co-hero-value">${value ? esc(euro(value)) : '–'}</span>
                    <span class="co-hero-sub">${esc(sub)}</span>
                </div>
                ${ring}
            </div>`;
    }

    /** A soft tile: label, figure, a small picture of it and a line under it. */
    function tile(t) {
        return `
            <div class="co-tile${t.tone ? ' ' + t.tone : ''}"${t.title ? ` title="${esc(t.title)}"` : ''}>
                <span class="co-tile-label">${esc(t.label)}</span>
                <strong class="co-tile-value">${t.value ? esc(t.value) : '–'}</strong>
                ${t.graphic || ''}
                <small class="co-tile-sub">${t.subHtml || esc(t.sub || '')}</small>
            </div>`;
    }

    /** A bar of parts side by side: [{ n, cls?, attr?, title }]. */
    function partsBar(parts) {
        const total = parts.reduce((s, p) => s + p.n, 0);
        if (!total) return '<span class="co-bar is-empty"></span>';
        return `<span class="co-bar">${parts.filter(p => p.n > 0).map(p => `
            <span class="co-bar-part ${p.cls || ''}" ${p.attr || ''} style="flex-grow:${p.n}" title="${esc(p.title)}"></span>`).join('')}</span>`;
    }

    function tiles() {
        const c = state.company;
        const projects = c.projects || [];
        const inv = state.invoices && state.invoices.stats;
        const items = (state.invoices && state.invoices.items) || [];
        const out = [];

        // How it pays: on time against late, over its paid invoices.
        if (inv && inv.count) {
            const paid = items.filter(i => !i.credit && i.paid && i.paid.date && i.due);
            const late = paid.filter(i => i.paid.date > i.due).length;
            const onTime = paid.length - late;
            out.push({
                label: 'Avg. time to pay',
                value: inv.avgDays === null ? '' : plural(Math.round(inv.avgDays), 'day'),
                title: inv.avgDays === null
                    ? 'No invoice paid yet: it counts from the invoice date to the day the money came in'
                    : `From the invoice date to the day the money came in, on average over ${plural(inv.paidCount, 'paid invoice')}`,
                graphic: paid.length ? partsBar([
                    { n: onTime, cls: 'is-good', title: `${onTime} on time` },
                    { n: late, cls: 'is-late', title: `${late} late${inv.avgLate ? `, ${Math.round(inv.avgLate)} days on average` : ''}` }
                ]) : '',
                sub: paid.length ? (late ? `${onTime} on time, ${late} late` : 'always on time') : 'nothing paid yet'
            });
            out.push({
                label: 'Open',
                value: inv.open > 0.005 ? euro(inv.open) : '',
                tone: inv.overdue > 0.005 ? 'is-neg' : '',
                graphic: inv.open > 0.005 ? partsBar([
                    { n: inv.open - inv.overdue, cls: 'is-open', title: `${euro(inv.open - inv.overdue)} not due yet` },
                    { n: inv.overdue, cls: 'is-late', title: `${euro(inv.overdue)} overdue` }
                ]) : '',
                sub: inv.overdue > 0.005 ? `${euro(inv.overdue)} overdue` : (inv.open > 0.005 ? 'not due yet' : 'nothing open')
            });
        } else {
            const won = projects.filter(p => WON.includes(p.stage));
            out.push({ label: 'Won', value: won.length ? plural(won.length, 'project') : '', sub: 'complete or in progress' });
        }

        // Projects, by stage, and what the open ones are worth.
        const open = projects.filter(p => OPEN.includes(p.stage));
        const pipeline = open.reduce((s, p) => s + budgetMid(p) * (Number(p.success_chance) || 0) / 100, 0);
        const byStage = STAGE_ORDER.map(st => ({ st, n: projects.filter(p => (p.stage || 'Lead') === st).length }));
        out.push({
            label: 'Projects',
            value: projects.length ? String(projects.length) : '',
            graphic: projects.length ? partsBar(byStage.map(x => ({
                n: x.n, cls: 'is-stage', attr: `data-stage="${esc(stageClass(x.st))}"`, title: `${x.n} ${x.st}`
            }))) : '',
            title: byStage.filter(x => x.n).map(x => `${x.n} ${x.st.toLowerCase()}`).join(', '),
            sub: projects.length ? `${projects.filter(p => WON.includes(p.stage)).length} won, ${open.length} open` : ''
        });
        const openBudget = open.reduce((s, p) => s + budgetMid(p), 0);
        out.push({
            label: 'Pipeline',
            value: pipeline ? euro(pipeline) : '',
            title: `Open projects: budget × chance. ${euro(openBudget)} if all are won`,
            graphic: openBudget ? partsBar([
                { n: pipeline, cls: 'is-paid', title: `${euro(pipeline)} weighted by chance` },
                { n: openBudget - pipeline, cls: 'is-open', title: `${euro(openBudget)} if all are won` }
            ]) : '',
            sub: open.length ? `of ${euro(openBudget)} open` : 'nothing open'
        });
        return `<div class="co-tiles">${out.map(tile).join('')}</div>`;
    }

    /**
     * Invoiced per month (per year once it spans more than two years): a
     * bar per period, paid in blue, open in light blue, overdue in red.
     */
    function invoiceChart() {
        const items = ((state.invoices && state.invoices.items) || []).filter(i => i.date);
        if (!items.length) return '';
        const now = new Date();
        const first = items.map(i => i.date).sort()[0];
        const startY = Number(first.slice(0, 4));
        const startM = Number(first.slice(5, 7)) - 1;
        const span = (now.getFullYear() - startY) * 12 + now.getMonth() - startM + 1;
        const byYear = span > 24;

        const buckets = [];
        if (byYear) {
            for (let y = startY; y <= now.getFullYear(); y++) buckets.push({ key: String(y), label: String(y), full: String(y) });
        } else {
            const months = Math.max(12, span);
            for (let k = months - 1; k >= 0; k--) {
                const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                buckets.push({ key, label: MONTHS[d.getMonth()].charAt(0), full: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, jan: d.getMonth() === 0 });
            }
        }
        buckets.forEach(b => { b.paid = 0; b.open = 0; b.late = 0; b.count = 0; });
        const index = new Map(buckets.map(b => [b.key, b]));
        items.forEach(i => {
            const b = index.get(byYear ? i.date.slice(0, 4) : i.date.slice(0, 7));
            if (!b) return;
            const net = Number(i.net) || 0;
            b.count++;
            if (i.overdue) b.late += net;
            else if (i.outstanding > 0.005) b.open += net;
            else b.paid += net;
        });
        const max = Math.max.apply(null, buckets.map(b => b.paid + b.open + b.late)) || 1;
        const H = 96;
        const seg = (v, cls) => (v > 0 ? `<span class="co-col-seg ${cls}" style="height:${Math.max(3, Math.round(v / max * H))}px"></span>` : '');
        const cols = buckets.map(b => {
            const total = b.paid + b.open + b.late;
            const tip = total
                ? `${b.full}: ${euro(total)}, ${plural(b.count, 'invoice')}` + (b.open ? `, ${euro(b.open)} open` : '') + (b.late ? `, ${euro(b.late)} overdue` : '')
                : `${b.full}: nothing`;
            return `
                <div class="co-col" title="${esc(tip)}" aria-label="${esc(tip)}" role="img">
                    <span class="co-col-stack">${seg(b.late, 'is-late')}${seg(b.open, 'is-open')}${seg(b.paid, 'is-paid')}</span>
                    <span class="co-col-label${b.jan ? ' is-jan' : ''}">${esc(b.label)}</span>
                </div>`;
        }).join('');
        const has = k => buckets.some(b => b[k] > 0);
        const key = [['paid', 'Paid'], ['open', 'Open'], ['late', 'Overdue']].filter(([k]) => has(k))
            .map(([k, label]) => `<span class="co-key"><span class="co-key-dot is-${k === 'late' ? 'late' : k}"></span>${label}</span>`).join('');
        return `
            <div class="overview-section ov-section">
                <div class="co-chart-head">
                    <h3 class="overview-section-title">Invoiced per ${byYear ? 'year' : 'month'}</h3>
                    <span class="co-chart-max">${esc(euro(max))} max</span>
                </div>
                <div class="co-chart${byYear ? ' is-years' : ''}" style="--co-h:${H}px">${cols}</div>
                <div class="co-keys">${key}</div>
            </div>`;
    }

    /** "KM" for Katharina Moser. */
    const initials = name => String(name || '').split(/\s+/).filter(Boolean).map(w => w.charAt(0)).slice(0, 2).join('').toUpperCase();

    function productChip(product) {
        return product ? `<span class="product-chip" data-product="${esc(product)}">${esc(product)}</span>` : '';
    }

    function render() {
        const c = state.company;
        if (!c) return;
        if (state.editing) {
            els.body.innerHTML = editForm();
            return;
        }
        const projects = c.projects || [];
        const products = PRODUCTS.filter(p => projects.some(x => x.product === p && WON.includes(x.stage)));
        const projectRows = projects.map(p => {
            const stage = p.stage || 'Lead';
            const stageClass = stage.toLowerCase().replace(/ /g, '-');
            const budget = window.CRMFormat.amountRange(p.budget_min, p.budget_max, { cents: 'never' });
            return `
                <li>
                    <button type="button" class="co-row" data-company-project="${p.id}">
                        <span class="co-row-main">
                            <span class="co-row-name">${esc(p.name)}</span>
                            ${p.companies > 1 ? `<span class="co-row-meta" title="This project is for ${p.companies} companies">shared</span>` : ''}
                        </span>
                        <span class="co-row-product">${productChip(p.product)}</span>
                        <span class="project-stage-badge stage-${esc(stageClass)}">${esc(stage)}</span>
                        <span class="co-row-amount${budget ? '' : ' is-empty'}">${esc(budget || '–')}</span>
                    </button>
                </li>`;
        }).join('');

        const contacts = (c.contacts || []).map(k => `
            <button type="button" class="co-person" data-company-contact="${k.id}">
                <span class="co-avatar" aria-hidden="true">${esc(initials(k.name))}</span>
                <span class="co-person-text">
                    <span class="co-person-name">${esc(k.name)}</span>
                    <span class="co-person-meta">${esc(k.last_note ? 'Last note ' + window.CRMFormat.ago(k.last_note) : 'No notes yet')}</span>
                </span>
            </button>`).join('');

        els.body.innerHTML = `
            ${heroHtml()}
            ${tiles()}
            ${invoiceChart()}
            ${products.length ? `
            <div class="overview-section ov-section">
                <h3 class="overview-section-title">Products</h3>
                <div class="co-products">${products.map(productChip).join('')}</div>
            </div>` : ''}
            <div class="overview-section ov-section">
                <h3 class="overview-section-title">Projects</h3>
                ${projectRows ? `<ul class="co-list">${projectRows}</ul>` : '<p class="empty-hint">No projects yet</p>'}
            </div>
            <div class="overview-section ov-section">
                <h3 class="overview-section-title">Contacts</h3>
                ${contacts ? `<div class="co-people">${contacts}</div>` : '<p class="empty-hint">No contacts yet</p>'}
            </div>
            ${invoiceSection()}`;
    }

    function invoiceSection() {
        const inv = state.invoices;
        if (!inv || !inv.items || !inv.items.length) return '';
        const rows = inv.items.slice().reverse().map(i => {
            const late = i.overdue || (i.reminded && i.outstanding > 0.005);
            const status = i.outstanding > 0.005 ? (late ? 'overdue' : 'open') : 'paid';
            const label = status === 'paid'
                ? (i.paid && i.paid.date ? `Paid ${day(i.paid.date)}` : 'Paid')
                : status === 'overdue' ? 'Overdue' : (i.due ? `Due ${day(i.due)}` : 'Open');
            return `
                <li class="co-inv is-${status}">
                    <span class="co-inv-no">${esc(i.number)}</span>
                    <span class="co-inv-date">${esc(day(i.date))}</span>
                    <span class="co-inv-what" title="${esc(i.subject || '')}">${esc(i.subject || '')}</span>
                    <span class="co-inv-state">${esc(label)}</span>
                    <span class="co-inv-amount">${esc(window.CRMFormat.amount(i.net))}</span>
                </li>`;
        }).join('');
        return `
            <div class="overview-section ov-section">
                <h3 class="overview-section-title">Invoices</h3>
                <ul class="co-invoices">${rows}</ul>
            </div>`;
    }

    // ---- Editing ----

    function editForm() {
        const c = state.company;
        const others = (state.list || []).filter(x => x.id !== c.id);
        return `
            <div class="overview-section">
                <div class="overview-details">
                    <div class="overview-detail-item ov-span-2">
                        <label class="detail-label" for="companyEditAddress">Address</label>
                        <textarea id="companyEditAddress" class="form-input ov-field" rows="2" maxlength="2000">${esc(c.address || '')}</textarea>
                    </div>
                    <div class="overview-detail-item">
                        <label class="detail-label" for="companyEditVat">VAT ID</label>
                        <input type="text" id="companyEditVat" class="form-input ov-field" maxlength="64" value="${esc(c.vat_id || '')}">
                    </div>
                </div>
            </div>
            <div class="overview-section ov-section">
              <div class="co-danger">
                <div class="co-merge">
                    <label class="detail-label" for="companyMergeTarget">Merge into</label>
                    <div class="co-merge-row">
                        <select id="companyMergeTarget" class="form-select ov-field">
                            <option value="">Another company…</option>
                            ${others.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}
                        </select>
                        <button type="button" class="btn btn-secondary btn-small" id="companyMergeBtn">Merge</button>
                    </div>
                </div>
                <button type="button" class="btn btn-danger btn-small" id="companyDeleteBtn">Delete company</button>
              </div>
            </div>`;
    }

    async function enterEdit() {
        if (!state.company) return;
        await list().catch(() => null);
        state.editing = true;
        els.nameInput.value = state.company.name || '';
        els.websiteInput.value = state.company.website || '';
        els.modal.classList.add('is-editing');
        render();
        els.nameInput.focus();
    }

    function exitEdit() {
        state.editing = false;
        els.modal.classList.remove('is-editing');
        render();
    }

    async function save() {
        if (state.busy || !state.company) return;
        const name = els.nameInput.value.trim();
        if (!name) {
            els.nameInput.classList.add('is-invalid');
            els.nameInput.focus();
            return;
        }
        els.nameInput.classList.remove('is-invalid');
        const address = $('companyEditAddress');
        const vat = $('companyEditVat');
        state.busy = true;
        els.saveBtn.disabled = true;
        try {
            await request('PUT', `${API}?id=${state.company.id}`, {
                name,
                website: els.websiteInput.value.trim(),
                address: address ? address.value : state.company.address,
                vat_id: vat ? vat.value : state.company.vat_id
            });
            const id = state.company.id;
            await refresh();
            await open(id);
        } catch (error) {
            window.CRMDialog.alert(error.message);
        } finally {
            state.busy = false;
            els.saveBtn.disabled = false;
        }
    }

    async function mergeInto(targetId) {
        const c = state.company;
        const target = (state.list || []).find(x => x.id === targetId);
        if (!c || !target) return;
        const ok = await window.CRMDialog.confirm(
            `Merge “${c.name}” into “${target.name}”? Its contacts, projects and notes move over, and “${c.name}” is gone.`,
            { confirm: 'Merge', danger: true });
        if (!ok) return;
        try {
            await request('POST', `${API}?action=merge`, { from: c.id, into: target.id });
            await refresh();
            await open(target.id);
        } catch (error) {
            window.CRMDialog.alert(error.message);
        }
    }

    async function remove() {
        const c = state.company;
        if (!c) return;
        const ok = await window.CRMDialog.confirm(
            `Delete “${c.name}”? Its contacts and projects stay, without the company.`, { confirm: 'Delete', danger: true });
        if (!ok) return;
        try {
            await request('DELETE', `${API}?id=${c.id}`);
            close();
            await refresh();
        } catch (error) {
            window.CRMDialog.alert(error.message);
        }
    }

    // ---- Notes and invoices ----

    async function loadNotes(token) {
        const name = state.company ? state.company.name : state.name;
        try {
            const response = await fetch(`api/notes.php?company=${encodeURIComponent(name)}`);
            const result = await response.json();
            if (token !== state.token) return;
            const notes = result.success ? result.data || [] : [];
            els.notes.innerHTML = notes.length ? notes.map(note => `
                <div class="note-item">
                    <div class="note-header">
                        <span class="note-date">${esc(window.CRMFormat.dateTime(note.created_at))}</span>
                        ${note.author_name ? `<span class="note-author">${esc(note.author_name)}</span>` : ''}
                        <span class="note-source">${esc(note.contact_name || '')}</span>
                    </div>
                    <div class="note-content">${esc(note.content)}</div>
                </div>`).join('') : '<p class="empty-hint">No notes yet</p>';
        } catch (error) {
            if (token === state.token) els.notes.innerHTML = '<p class="empty-hint">Notes could not be loaded</p>';
        }
    }

    /** Our invoices to this company, for whoever may see them (CompanyInvoices, admins). */
    async function loadInvoices(token) {
        if (!window.CompanyInvoices || !state.company) return;
        try {
            const result = await window.CompanyInvoices.forCompany(state.company);
            if (token !== state.token || !result) return;
            state.invoices = result;
            if (!state.editing) render();
        } catch (error) {
            // The sheet stands without them.
        }
    }

    // ------------------------------------------------------------------
    // Look-alike names
    // ------------------------------------------------------------------

    async function loadSimilar() {
        try {
            state.similar = await request('GET', `${API}?action=similar`);
        } catch (error) {
            state.similar = [];
        }
        renderSimilarButton();
    }

    const ICON_MERGE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4v4a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6v0"/><path d="M18 4v4a6 6 0 0 1-3 5.2"/><path d="m3.5 6.5 2.5-2.5 2.5 2.5M15.5 6.5 18 4l2.5 2.5"/></svg>';

    /** Beside the contacts' view switch, only while there are look-alikes. */
    function renderSimilarButton() {
        const anchor = document.querySelector('[data-contacts-mode]');
        const actions = anchor ? anchor.closest('.list-header-actions') : null;
        if (!actions) return;
        let button = $('companySimilarBtn');
        if (!state.similar.length) {
            if (button) button.remove();
            return;
        }
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.id = 'companySimilarBtn';
            button.className = 'btn btn-icon co-similar-btn';
            button.addEventListener('click', openSimilar);
            actions.insertBefore(button, actions.firstChild);
        }
        const n = state.similar.length;
        button.title = `${plural(n, 'pair')} of companies that look alike`;
        button.setAttribute('aria-label', button.title);
        button.innerHTML = `${ICON_MERGE}<span class="co-similar-count">${n}</span>`;
    }

    function similarModal() {
        let modal = $('companySimilarModal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'companySimilarModal';
        modal.innerHTML = `
            <div class="modal-backdrop" data-similar-close></div>
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Companies that look alike</h2>
                    <button type="button" class="modal-close" data-similar-close aria-label="Close">&times;</button>
                </div>
                <div class="modal-body">
                    <p class="co-pairs-hint">Click the name to keep.</p>
                    <ul class="co-pairs" id="companySimilarList"></ul>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', onSimilarClick);
        return modal;
    }

    function renderSimilar() {
        const target = $('companySimilarList');
        if (!target) return;
        if (!state.similar.length) {
            target.innerHTML = '<li class="empty-hint">Nothing left to check</li>';
            return;
        }
        const side = (c, other) => `
            <button type="button" class="co-pair-side" data-merge-from="${other.id}" data-merge-into="${c.id}" title="Keep “${esc(c.name)}”, merge the other into it">
                <strong>${esc(c.name)}</strong>
                <small>${esc(plural(c.contacts, 'contact'))}, ${esc(plural(c.projects, 'project'))}</small>
            </button>`;
        target.innerHTML = state.similar.map(p => `
            <li class="co-pair">
                ${side(p.a, p.b)}
                ${side(p.b, p.a)}
                <button type="button" class="btn btn-secondary btn-small" data-keep-a="${p.a.id}" data-keep-b="${p.b.id}">Different</button>
            </li>`).join('');
    }

    function openSimilar() {
        const modal = similarModal();
        renderSimilar();
        modal.classList.add('active');
    }

    async function onSimilarClick(e) {
        const modal = $('companySimilarModal');
        if (e.target.closest('[data-similar-close]')) {
            modal.classList.remove('active');
            return;
        }
        const merge = e.target.closest('[data-merge-into]');
        const keep = e.target.closest('[data-keep-a]');
        try {
            if (merge) {
                await request('POST', `${API}?action=merge`, {
                    from: Number(merge.getAttribute('data-merge-from')),
                    into: Number(merge.getAttribute('data-merge-into'))
                });
                await refresh();
                renderSimilar();
                if (window.CRM && window.CRM.refreshContacts) window.CRM.refreshContacts();
            } else if (keep) {
                state.similar = await request('POST', `${API}?action=keep-apart`, {
                    a: Number(keep.getAttribute('data-keep-a')),
                    b: Number(keep.getAttribute('data-keep-b'))
                });
                renderSimilar();
                renderSimilarButton();
            }
        } catch (error) {
            window.CRMDialog.alert(error.message);
        }
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function bind() {
        if (els) return;
        els = {
            modal: $('companyNotesModal'),
            title: $('companyNotesTitle'),
            sub: $('companySub'),
            body: $('companyBody'),
            notes: $('companyNotesTimeline'),
            editBtn: $('companyEditBtn'),
            nameInput: $('companyEditName'),
            websiteInput: $('companyEditWebsite'),
            saveBtn: $('companySaveBtn'),
            cancelBtn: $('companyCancelBtn')
        };
        if (!els.modal) return;

        els.modal.querySelector('.modal-backdrop').addEventListener('click', () => { if (!state.editing) close(); });
        $('closeCompanyNotesModal').addEventListener('click', close);
        els.editBtn.addEventListener('click', enterEdit);
        els.cancelBtn.addEventListener('click', exitEdit);
        els.saveBtn.addEventListener('click', save);
        [els.nameInput, els.websiteInput].forEach(input => input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
        }));

        els.modal.addEventListener('click', e => {
            const project = e.target.closest('[data-company-project]');
            const contact = e.target.closest('[data-company-contact]');
            if (project) {
                close();
                window.CRM.openProjectOverview(Number(project.getAttribute('data-company-project')));
            } else if (contact) {
                close();
                window.CRM.openOverview(Number(contact.getAttribute('data-company-contact')));
            } else if (e.target.closest('#companyMergeBtn')) {
                const select = $('companyMergeTarget');
                if (select && select.value) mergeInto(Number(select.value));
                else if (select) select.focus();
            } else if (e.target.closest('#companyDeleteBtn')) {
                remove();
            }
        });

        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape' || !els.modal.classList.contains('active')) return;
            const similar = $('companySimilarModal');
            if (similar && similar.classList.contains('active')) return;
            if (state.editing) exitEdit(); else close();
        });
    }

    function boot() {
        bind();
        list().then(() => document.dispatchEvent(new CustomEvent('crm:companies-changed'))).catch(() => null);
        loadSimilar();
    }

    /**
     * A company name anywhere - a contact's, a project's, an invoice's -
     * is a button with data-open-company (the id, when known) and
     * data-company-name. The sheet it sits in closes first, as when a
     * project opens a contact.
     */
    document.addEventListener('click', e => {
        const link = e.target.closest('[data-open-company]');
        if (!link) return;
        e.preventDefault();
        const id = Number(link.getAttribute('data-open-company'));
        const name = link.getAttribute('data-company-name') || link.textContent.trim();
        if (link.closest('#overviewModal') && window.CRM) window.CRM.closeOverview();
        if (link.closest('#projectOverviewModal') && window.CRM) window.CRM.closeProjectOverview();
        open(id > 0 ? id : name);
    });

    window.CRMCompany = {
        open, close, list, byName, refresh,
        cached: () => state.list || [],
        isOpen: () => !!(els && els.modal.classList.contains('active'))
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
