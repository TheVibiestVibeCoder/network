/**
 * From Claude
 *
 * Everything Claude writes through the MCP API is a proposal until a person
 * decides. This module is where that happens:
 *
 *   - the "From Claude" screen: one row per proposal, grouped like the other
 *     lists in the CRM, with accept and reject at the end of the row; plus a
 *     history of what was decided and by whom;
 *   - the proposal sheet: a click on a row opens it on the right, like the
 *     contact, project and to-do sheets - every field, before and after,
 *     Claude's note, and editing before accepting;
 *   - the small "Claude" marks and accept/reject buttons that app.js,
 *     bookkeeping.js and documents.js put on proposed records where they are
 *     listed;
 *   - the box in a contact's or project's detail view listing the open
 *     proposals about it.
 *
 * A proposed NEW record already exists (marked pending), so accepting it only
 * clears the mark and rejecting deletes it - both on the server. A proposed
 * CHANGE to an existing record is applied here, through the same endpoints a
 * manual edit uses, so it gets the same validation, geocoding and logging and
 * is attributed to the person who accepted it. Only then is it marked resolved.
 *
 * Every signed-in person may decide; there is no separate permission for it.
 */
(function () {
    'use strict';

    const API = 'api/review.php';

    const TYPE_LABEL = {
        contact: 'contact',
        project: 'project',
        todo: 'to-do',
        contact_note: 'note',
        project_note: 'project note',
        bookkeeping_pdf: 'invoice',
        project_document: 'document'
    };

    const FIELD_LABEL = {
        name: 'Name', company: 'Company', location: 'Location', email: 'Email', phone: 'Phone',
        website: 'Website', address: 'Address', note: 'Note', description: 'Description',
        start_date: 'Start date', estimated_completion: 'Planned finish', stage: 'Stage',
        budget_min: 'Budget from', budget_max: 'Budget to', success_chance: 'Chance (%)',
        title: 'Title', due_date: 'Due', priority: 'Priority', is_completed: 'Done', content: 'Text'
    };

    // A field as it reads in "Change to stage".
    const FIELD_NOUN = {
        name: 'name', company: 'company', location: 'location', email: 'email', phone: 'phone',
        website: 'website', address: 'address', note: 'note', description: 'description',
        start_date: 'start date', estimated_completion: 'planned finish', stage: 'stage',
        budget_min: 'budget', budget_max: 'budget', success_chance: 'chance',
        title: 'title', due_date: 'due date', priority: 'priority', is_completed: 'status', content: 'text'
    };

    // What can be edited before accepting, per proposed record type.
    const EDITABLE = {
        contact: ['name', 'company', 'email', 'phone', 'location', 'website', 'address', 'note'],
        project: ['name', 'company', 'stage', 'start_date', 'estimated_completion', 'budget_min', 'budget_max', 'success_chance', 'description'],
        todo: ['title', 'due_date', 'priority', 'description'],
        contact_note: ['content'],
        project_note: ['content']
    };

    // Top to bottom, as in the project sheet's stage select.
    const STAGES = ['Complete', 'In Progress', 'Proposal', 'Negotiation', 'Lead'];
    const PRIORITIES = ['', 'low', 'medium', 'high'];
    const LONG_FIELDS = ['note', 'address', 'description', 'content'];
    const DATE_FIELDS = ['start_date', 'estimated_completion', 'due_date'];
    const NUMBER_FIELDS = ['budget_min', 'budget_max', 'success_chance'];

    // The record types api/assign.php knows.
    const ASSIGN_TYPE = { contact: 'contact', project: 'project', todo: 'todo' };

    const state = {
        tab: 'pending',
        items: [],
        loading: false,
        busy: new Set(),
        errors: {},
        pollTimer: null,
        // { action, total, done, failed } while "Accept all" / "Reject all" runs
        bulk: null,
        // 'accept' | 'reject' right after the list was cleared in one go, so
        // the empty state can mark the moment once
        cleared: null
    };

    // The proposal open in the sheet, and whether it is being edited.
    const sheet = { id: null, editing: false };

    const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    const els = {};

    // ------------------------------------------------------------------
    // Utilities
    // ------------------------------------------------------------------

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    function encodeUtf8Base64(value) {
        const bytes = new TextEncoder().encode(value);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
    }

    async function request(url, options = {}) {
        const opts = Object.assign({ headers: {} }, options);
        opts.headers = Object.assign({ 'X-CSRF-Token': getCsrfToken() }, opts.headers);
        if (opts.json !== undefined) {
            opts.body = JSON.stringify(opts.json);
            opts.headers['Content-Type'] = 'application/json';
            delete opts.json;
        }

        const response = await fetch(url, opts);
        const text = await response.text();
        let payload = {};
        try {
            payload = text ? JSON.parse(text) : {};
        } catch (e) {
            throw new Error(response.status === 403
                ? 'The web server blocked this request.'
                : 'The server returned an unexpected response.');
        }

        if (!response.ok || payload.error || payload.success === false) {
            throw new Error(payload.error || payload.message || 'Request failed.');
        }
        return payload;
    }

    /** SQLite stores UTC as "YYYY-MM-DD HH:MM:SS". */
    function parseUtc(value) {
        if (!value) return null;
        const date = new Date(String(value).replace(' ', 'T') + 'Z');
        return isNaN(date.getTime()) ? null : date;
    }

    function timeAgo(value) {
        const date = parseUtc(value);
        if (!date) return '';
        const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
        if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
        if (seconds < 7 * 86400) return Math.floor(seconds / 86400) + ' d ago';
        return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function fullDate(value) {
        const date = parseUtc(value);
        return date ? date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    }

    function formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return Math.round(n / 1024) + ' KB';
        return n + ' B';
    }

    function isEmpty(value) {
        return value === null || value === undefined || String(value).trim() === '';
    }

    /** "2026-10-15" as "Oct 15, 2026", the way the other sheets show dates. */
    function formatDay(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
        if (!match) return String(value || '');
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function displayValue(field, value) {
        if (field === 'is_completed') {
            return value === true || value === 1 || value === '1' ? 'Yes' : 'No';
        }
        if (isEmpty(value)) return '—';
        if (field === 'priority') return String(value).charAt(0).toUpperCase() + String(value).slice(1);
        if (DATE_FIELDS.includes(field)) return formatDay(value);
        if ((field === 'budget_min' || field === 'budget_max') && !isNaN(Number(value))) return Number(value).toLocaleString('de-AT') + ' €';
        if (field === 'success_chance' && !isNaN(Number(value))) return Number(value) + ' %';
        return String(value);
    }

    function sameValue(a, b) {
        const norm = v => {
            if (v === null || v === undefined) return '';
            if (typeof v === 'boolean') return v ? '1' : '0';
            const s = String(v).trim();
            return s !== '' && !isNaN(Number(s)) ? String(Number(s)) : s;
        };
        return norm(a) === norm(b);
    }

    function joinParts(parts) {
        return parts.filter(v => !isEmpty(v)).join(' · ');
    }

    function excerpt(text, length = 140) {
        const flat = String(text || '').replace(/\s+/g, ' ').trim();
        return flat.length > length ? flat.slice(0, length - 1) + '…' : flat;
    }

    function budgetText(r) {
        return [r.budget_min, r.budget_max].filter(v => !isEmpty(v)).map(v => Number(v).toLocaleString('de-AT') + ' €').join(' – ');
    }

    // ------------------------------------------------------------------
    // Describing a proposal
    // ------------------------------------------------------------------

    /** The record as it is now, or - once it is gone - what Claude proposed. */
    function source(item) {
        return item.record || item.payload || {};
    }

    function kindLabel(item) {
        switch (item.kind) {
            case 'create': return 'New ' + (TYPE_LABEL[item.entity_type] || 'record');
            case 'update': {
                const fields = Object.keys(item.payload || {});
                const nouns = [...new Set(fields.map(f => FIELD_NOUN[f] || f))];
                if (nouns.length === 1) return 'Change to ' + nouns[0];
                if (nouns.length === 2) return 'Change to ' + nouns[0] + ' & ' + nouns[1];
                return nouns.length ? 'Change to ' + nouns.length + ' fields' : 'Change';
            }
            case 'delete': return item.entity_type === 'project' ? 'Archive' : 'Delete';
            case 'link': return 'Add to project';
            case 'unlink': return 'Remove from project';
            case 'tag': return 'Add tag';
            case 'untag': return 'Remove tag';
            case 'assign': return 'Change to assignee';
            default: return 'Proposal';
        }
    }

    /** Which colour the row's mark takes: what kind of decision, or how it ended. */
    function tone(item) {
        if (item.status === 'accepted') return 'accepted';
        if (item.status === 'rejected') return 'rejected';
        if (item.status !== 'pending') return 'neutral';
        // A new record is green; a note or document added to one is blue.
        if (item.kind === 'create') return ATTACHED_TYPES.includes(item.entity_type) ? 'new' : 'created';
        if (item.kind === 'delete' || item.kind === 'unlink' || item.kind === 'untag') return 'remove';
        return 'change';
    }

    function titleFor(item) {
        const r = item.record || {};
        const label = String(item.entity_label || '');
        switch (item.entity_type) {
            case 'contact':
            case 'project':
                return r.name || label;
            case 'todo':
                return r.title || label;
            case 'contact_note':
                return r.contact_name || label.split(':')[0];
            case 'project_note':
                return r.project_name || label.split(':')[0];
            case 'bookkeeping_pdf':
                return r.original_name || label;
            case 'project_document':
                return r.original_name || (item.payload || {}).name || label;
            default:
                return label;
        }
    }

    /** One line that says what the proposal is, readable without opening it. */
    function summaryFor(item) {
        const s = source(item);
        const p = item.payload || {};
        const r = item.record || {};

        switch (item.kind) {
            case 'create':
                switch (item.entity_type) {
                    case 'contact': return joinParts([s.company, s.email, s.phone, s.location]);
                    case 'project': return joinParts([s.company, s.stage, budgetText(s)]);
                    case 'todo': return joinParts([
                        r.contact_name ? 'For ' + r.contact_name : (r.project_name ? 'Project ' + r.project_name : ''),
                        s.due_date ? 'Due ' + formatDay(s.due_date) : '',
                        s.priority ? displayValue('priority', s.priority) + ' priority' : ''
                    ]);
                    case 'contact_note':
                    case 'project_note': return excerpt(s.content);
                    case 'bookkeeping_pdf': return joinParts([formatBytes(r.file_size || p.size), 'Bookkeeping drop zone']);
                    case 'project_document': return joinParts([
                        s.label,
                        formatBytes(r.file_size || p.size),
                        r.project_name ? 'Project ' + r.project_name : ''
                    ]);
                    default: return '';
                }
            case 'update':
                return Object.keys(p).map(field => (FIELD_LABEL[field] || field) + ' → ' + displayValue(field, p[field])).join(' · ');
            case 'delete':
                return item.entity_type === 'project'
                    ? 'Claude suggests archiving this project'
                    : 'Claude suggests deleting this ' + (TYPE_LABEL[item.entity_type] || 'record');
            case 'link':
            case 'unlink': {
                const contact = (item.related || {}).contact;
                return (item.kind === 'link' ? '+ ' : '− ') + (contact ? contact.name : 'a contact that no longer exists');
            }
            case 'tag':
                return '+ ' + (p.tag_name || '');
            case 'untag':
                return '− ' + (p.tag_name || '');
            case 'assign':
                return ((item.previous || {}).assigned_to_name || 'Nobody') + ' → ' + (p.assigned_to_name || 'nobody');
            default:
                return '';
        }
    }

    /** Old value struck through, then the new one: "~~Proposal~~ → Negotiation". */
    function valuePair(was, now) {
        const old = was === '—'
            ? '<span class="review-was is-empty">—</span>'
            : `<del class="review-was">${escapeHtml(was)}</del>`;
        return `<span class="review-pair">${old}<span class="review-pair-arrow" aria-label="to">→</span><span class="review-now">${escapeHtml(now)}</span></span>`;
    }

    /** A field named in a sentence or a row: "Chance", "Due date". */
    function fieldName(field) {
        if (field === 'budget_min') return 'Budget from';
        if (field === 'budget_max') return 'Budget to';
        const noun = FIELD_NOUN[field] || field;
        return noun.charAt(0).toUpperCase() + noun.slice(1);
    }

    /** A value short enough for a row. */
    function rowValue(field, value) {
        const text = displayValue(field, value);
        return LONG_FIELDS.includes(field) ? excerpt(text, 40) : text;
    }

    /**
     * The row's second line as HTML. Changes show what was there and what
     * Claude proposes; the field is already named in the kind label when
     * there is only one, so it is only repeated when there are several.
     */
    function summaryHtml(item) {
        const p = item.payload || {};
        const previous = item.previous || {};

        if (item.kind === 'update') {
            const fields = Object.keys(p);
            // A budget's two ends are one proposal: show them as a range.
            if (fields.length === 2 && fields.includes('budget_min') && fields.includes('budget_max')) {
                const range = v => isEmpty(v.budget_min) && isEmpty(v.budget_max) ? '—' : budgetText(v);
                return valuePair(range(previous), range(p));
            }
            return fields.map(field => {
                const pair = valuePair(rowValue(field, previous[field]), rowValue(field, p[field]));
                return fields.length > 1 ? `<span class="review-pair-field">${escapeHtml(fieldName(field))}</span> ${pair}` : pair;
            }).join('<span class="review-pair-sep">·</span>');
        }
        if (item.kind === 'assign') {
            return valuePair(previous.assigned_to_name || 'Nobody', p.assigned_to_name || 'Nobody');
        }
        return escapeHtml(summaryFor(item));
    }

    /** The fields somebody changed since Claude proposed, with their value now. */
    function staleFields(item) {
        if (item.kind !== 'update' || !item.record) return [];
        const previous = item.previous || {};
        return Object.keys(item.payload || {})
            .filter(field => !sameValue(previous[field], item.record[field]))
            .map(field => ({ field, label: fieldName(field), now: displayValue(field, item.record[field]) }));
    }

    /** Whether somebody changed the record after Claude proposed a change to it. */
    function isStale(item) {
        if (item.kind !== 'update' || !item.record) return false;
        const previous = item.previous || {};
        return Object.keys(item.payload || {}).some(field => !sameValue(previous[field], item.record[field]));
    }

    function pdfLink(pdfId, label) {
        return `<a class="review-link" href="api/bookkeeping.php?action=download-pdf&id=${encodeURIComponent(pdfId)}" target="_blank" rel="noopener">${escapeHtml(label || 'View PDF')}</a>`;
    }

    /** A project document: PDFs and images open in the tab, anything else downloads. */
    function documentLink(documentId) {
        return `<a class="review-link" href="api/documents.php?action=download&id=${encodeURIComponent(documentId)}&inline=1" target="_blank" rel="noopener">View document</a>`;
    }

    function canEdit(item) {
        return item.status === 'pending' && ((item.kind === 'create' && EDITABLE[item.entity_type]) || item.kind === 'update');
    }

    function canOpen(item) {
        return !!item.record && item.status !== 'obsolete'
            && ['contact', 'project', 'todo', 'contact_note', 'project_note', 'bookkeeping_pdf', 'project_document'].includes(item.entity_type);
    }

    /** What the "Open" button in the sheet leads to. */
    function openLabel(item) {
        switch (item.entity_type) {
            case 'contact':
            case 'contact_note': return 'Open contact';
            case 'project':
            case 'project_note':
            case 'project_document': return 'Open project';
            case 'todo': return 'Open to-do';
            case 'bookkeeping_pdf': return 'Open in Bookkeeping';
            default: return 'Open';
        }
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
    const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
    const ICON_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    const ICON_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>';
    // Claude's mark - the same one the sidebar's "From Claude" entry uses.
    const ICON_SPARK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>';
    const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

    // What kind of record a proposal is about, as a small line icon.
    const TYPE_ICON = {
        contact: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
        project: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 13h18"/>',
        todo: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-4.9"/>',
        contact_note: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
        project_note: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
        bookkeeping_pdf: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
        project_document: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'
    };

    // Notes and documents belong to a contact or project and carry its icon.
    const ATTACHED_TYPES = ['contact_note', 'project_note', 'project_document'];
    const ICON_OF = { contact_note: 'contact', project_note: 'project', project_document: 'project' };

    function typeIcon(item) {
        const type = ICON_OF[item.entity_type] || item.entity_type;
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TYPE_ICON[type] || TYPE_ICON.contact_note}</svg>`;
    }

    function statusPill(item) {
        const who = item.resolved_by_name || 'someone';
        switch (item.status) {
            case 'accepted': return `<span class="review-pill review-pill--accepted">Accepted · ${escapeHtml(who)}</span>`;
            case 'rejected': return `<span class="review-pill review-pill--rejected">Rejected · ${escapeHtml(who)}</span>`;
            case 'withdrawn': return '<span class="review-pill">Withdrawn by Claude</span>';
            case 'obsolete': return '<span class="review-pill" title="The record was removed in the meantime">No longer relevant</span>';
            default: return '';
        }
    }

    /**
     * One proposal as a row: what it is about, what Claude proposes, and the
     * two buttons most proposals need. Everything else is in the sheet the
     * row opens.
     */
    function renderRow(item) {
        const pending = item.status === 'pending';
        const busy = state.busy.has(item.id);
        const error = state.errors[item.id];
        const stale = pending && isStale(item);
        const summary = summaryHtml(item);
        const staleTitle = stale
            ? 'Changed since Claude proposed this - ' + staleFields(item).map(f => f.label + ' is now ' + f.now).join(', ')
            : '';
        const when = pending ? item.created_at : (item.resolved_at || item.created_at);

        const end = pending ? `
            <div class="review-row-actions">
                <button type="button" class="review-act review-act--reject" data-review-act="reject" title="Reject" aria-label="Reject"${busy ? ' disabled' : ''}>${ICON_X}</button>
                <button type="button" class="review-act review-act--accept" data-review-act="accept" title="Accept" aria-label="Accept"${busy ? ' disabled' : ''}>${ICON_CHECK}</button>
            </div>` : `<div class="review-row-status">${statusPill(item)}</div>`;

        return `
            <article class="review-row review-tone--${tone(item)}${sheet.id === item.id ? ' is-current' : ''}${busy ? ' is-busy' : ''}" data-review-id="${item.id}">
                <div class="review-row-head">
                    <button type="button" class="review-row-open" data-review-act="sheet" aria-haspopup="dialog">
                        <span class="review-type-icon">${typeIcon(item)}</span>
                        <span class="review-row-text">
                            <span class="review-row-title">${escapeHtml(titleFor(item))}</span>
                            <span class="review-row-summary">
                                <span class="review-kind">${escapeHtml(kindLabel(item))}</span>
                                ${stale ? `<span class="review-outdated" title="${escapeHtml(staleTitle)}">${ICON_WARN}Outdated</span>` : ''}
                                ${summary ? `<span class="review-row-summary-text">${summary}</span>` : ''}
                            </span>
                        </span>
                        <span class="review-row-when" title="${escapeHtml(fullDate(when))}">${escapeHtml(timeAgo(when))}</span>
                    </button>
                    ${end}
                </div>
                ${error ? `<p class="review-error" role="alert">${escapeHtml(error)}</p>` : ''}
            </article>`;
    }

    function listCard(items) {
        return `<div class="review-list-card">${items.map(renderRow).join('')}</div>`;
    }

    // ------------------------------------------------------------------
    // The sheet
    // ------------------------------------------------------------------

    /** Where the record belongs, for the line under the sheet's title. */
    function contextFor(item) {
        const s = source(item);
        const r = item.record || {};
        switch (item.entity_type) {
            case 'contact':
            case 'project': return s.company || '';
            case 'todo': return r.project_name ? 'Project ' + r.project_name : (r.contact_name ? 'For ' + r.contact_name : '');
            case 'project_document': return r.project_name ? 'Project ' + r.project_name : '';
            case 'bookkeeping_pdf': return 'Bookkeeping drop zone';
            default: return '';
        }
    }

    /** The same two letters as getInitials() in app.js. */
    function initials(name) {
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        return (parts.length === 1 ? parts[0].substring(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    /** "Proposed by [Claude] 6 d ago" - the same line app.js draws as "Last edited by". */
    function personLine(label, name, actorId, when) {
        const people = window.CRMPeople;
        const url = people && people.avatarFor ? people.avatarFor(actorId, name) : null;
        const id = actorId === null || actorId === undefined ? '' : escapeHtml(actorId);
        return `<span class="edited-by">${escapeHtml(label)} <span class="by-line"><span class="by-line-avatar${url ? ' has-photo' : ''}" data-actor-id="${id}" data-actor-name="${escapeHtml(name)}">${url ? `<img src="${escapeHtml(url)}" alt="">` : escapeHtml(initials(name))}</span><span class="by-line-name">${escapeHtml(name)}</span></span>${when ? `<span class="edited-by-when" title="${escapeHtml(fullDate(when))}">${escapeHtml(timeAgo(when))}</span>` : ''}</span>`;
    }

    function section(title, body) {
        return `
            <section class="overview-section">
                <h3 class="overview-section-title">${escapeHtml(title)}</h3>
                ${body}
            </section>`;
    }

    /**
     * Label over value, in the grid every other sheet uses: three to a row for
     * short facts, as on the project and to-do sheets, two for longer ones.
     */
    function facts(pairs, columns = 2) {
        const items = pairs.filter(([, value]) => !isEmpty(value)).map(([label, value, long]) => `
            <div class="overview-detail-item${long ? ' full-width' : ''}">
                <span class="detail-label">${escapeHtml(label)}</span>
                <span class="detail-value${long ? ' review-sheet-long' : ''}">${escapeHtml(value)}</span>
            </div>`).join('');
        return items ? `<div class="overview-details${columns === 3 ? ' review-facts-3' : ''}">${items}</div>` : '<p class="empty-hint">Nothing filled in.</p>';
    }

    /** Before and after, one field per line. */
    function changeList(rows) {
        return `<div class="review-changes">${rows.map(row => `
            <div class="review-change">
                <span class="detail-label">${escapeHtml(row.label)}</span>
                <div class="review-change-values">
                    <span class="review-change-old">${escapeHtml(row.was)}</span>
                    <span class="review-change-arrow">${ICON_ARROW}</span>
                    <span class="review-change-new">${escapeHtml(row.now)}</span>
                </div>
                ${row.stale ? `<span class="review-stale">${ICON_WARN}Changed since - now ${escapeHtml(row.stale)}</span>` : ''}
            </div>`).join('')}</div>`;
    }

    function callout(toneName, icon, text) {
        return `<div class="review-callout review-callout--${toneName}">${icon}<p>${text}</p></div>`;
    }

    /** The heart of the sheet: what the proposal would add, change or remove. */
    function mainSection(item) {
        const s = source(item);
        const p = item.payload || {};
        const r = item.record || {};
        const pending = item.status === 'pending';

        switch (item.kind) {
            case 'create':
                if (item.entity_type === 'contact') {
                    return section('Details', facts([
                        ['Company', s.company], ['Email', s.email], ['Phone', s.phone], ['Location', s.location],
                        ['Website', s.website], ['Address', s.address, true], ['Note', s.note, true]
                    ]));
                }
                if (item.entity_type === 'project') {
                    return section('Details', facts([
                        ['Stage', s.stage], ['Start', isEmpty(s.start_date) ? '' : formatDay(s.start_date)],
                        ['Planned finish', isEmpty(s.estimated_completion) ? '' : formatDay(s.estimated_completion)],
                        ['Budget', budgetText(s)], ['Chance', isEmpty(s.success_chance) ? '' : s.success_chance + ' %'],
                        ['Company', s.company], ['Description', s.description, true]
                    ], 3));
                }
                if (item.entity_type === 'todo') {
                    return section('Details', facts([
                        ['Belongs to', r.project_name || r.contact_name],
                        ['Due', isEmpty(s.due_date) ? '' : formatDay(s.due_date)],
                        ['Priority', isEmpty(s.priority) ? '' : displayValue('priority', s.priority)],
                        ['Description', s.description, true]
                    ], 3));
                }
                if (item.entity_type === 'contact_note' || item.entity_type === 'project_note') {
                    return section('Note', `<div class="review-sheet-text">${escapeHtml(s.content || '')}</div>`);
                }
                if (item.entity_type === 'bookkeeping_pdf') {
                    return section('Invoice', facts([
                        ['File', r.original_name || p.name], ['Size', formatBytes(r.file_size || p.size)]
                    ]) + (item.record ? `<p class="review-sheet-hint">${pdfLink(item.entity_id)} · Filing it on its bank entry accepts it too.</p>` : ''));
                }
                if (item.entity_type === 'project_document') {
                    return section('Document', facts([
                        ['File', r.original_name || p.name], ['Filed as', r.label || s.label],
                        ['Size', formatBytes(r.file_size || p.size)], ['Project', r.project_name]
                    ]) + (item.record ? `<p class="review-sheet-hint">${documentLink(item.entity_id)}</p>` : ''));
                }
                return '';

            case 'update': {
                const previous = item.previous || {};
                return section('Proposed changes', changeList(Object.keys(p).map(field => ({
                    label: FIELD_LABEL[field] || field,
                    was: displayValue(field, previous[field]),
                    now: displayValue(field, p[field]),
                    stale: pending && item.record && !sameValue(previous[field], r[field]) ? displayValue(field, r[field]) : ''
                }))));
            }

            case 'delete': {
                const snapshot = item.previous || {};
                const warning = item.entity_type === 'project'
                    ? 'Accepting moves it to Archived projects, where it can be restored with everything in it.'
                    : 'Accepting deletes it for good.' + (item.entity_type === 'contact' ? ' Its notes, to-dos, tags and project links go with it.' : '');
                return (pending ? callout('danger', ICON_WARN, escapeHtml(warning)) : '')
                    + section(item.entity_type === 'project' ? 'The project' : 'What would be deleted',
                        facts(Object.keys(snapshot).map(field => [FIELD_LABEL[field] || field, displayValue(field, snapshot[field]), LONG_FIELDS.includes(field)])));
            }

            case 'link':
            case 'unlink': {
                const contact = (item.related || {}).contact;
                return section(item.kind === 'link' ? 'Add to project' : 'Remove from project', facts([
                    ['Contact', contact ? joinParts([contact.name, contact.company]) : 'A contact that no longer exists'],
                    ['Project', r.name || item.entity_label]
                ]));
            }

            case 'tag':
            case 'untag':
                return section(item.kind === 'tag' ? 'Add tag' : 'Remove tag', facts([
                    ['Tag', p.tag_name],
                    [item.entity_type === 'project' ? 'Project' : 'Contact', r.name || item.entity_label]
                ]));

            case 'assign':
                return section('Proposed change', changeList([{
                    label: 'Assigned to',
                    was: (item.previous || {}).assigned_to_name || 'Nobody',
                    now: p.assigned_to_name || 'Nobody'
                }]));

            default:
                return '';
        }
    }

    function fieldInput(field, value) {
        const id = 'rv-' + field;
        const label = `<label class="detail-label" for="${id}">${escapeHtml(FIELD_LABEL[field] || field)}</label>`;
        const v = value === null || value === undefined ? '' : String(value);
        const wide = LONG_FIELDS.includes(field);
        let control;

        if (field === 'stage') {
            control = `<select id="${id}" class="form-select ov-field" data-field="stage">${STAGES.map(s => `<option value="${s}"${s === v ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
        } else if (field === 'priority') {
            control = `<select id="${id}" class="form-select ov-field" data-field="priority">${PRIORITIES.map(s => `<option value="${s}"${s === v ? ' selected' : ''}>${s ? s.charAt(0).toUpperCase() + s.slice(1) : 'No priority'}</option>`).join('')}</select>`;
        } else if (field === 'is_completed') {
            const on = v === '1' || v === 'true';
            control = `<label class="review-check"><input type="checkbox" id="${id}" data-field="is_completed"${on ? ' checked' : ''}> Done</label>`;
        } else if (wide) {
            control = `<textarea id="${id}" class="form-input ov-field" rows="4" data-field="${field}">${escapeHtml(v)}</textarea>`;
        } else {
            const type = DATE_FIELDS.includes(field) ? 'date' : (NUMBER_FIELDS.includes(field) ? 'number' : (field === 'email' ? 'email' : 'text'));
            control = `<input id="${id}" type="${type}" class="form-input ov-field" data-field="${field}" value="${escapeHtml(v)}">`;
        }

        return `<div class="overview-detail-item${wide ? ' full-width' : ''}">${label}${control}</div>`;
    }

    function editForm(item) {
        const fields = item.kind === 'create' ? EDITABLE[item.entity_type] : Object.keys(item.payload || {});
        const values = item.kind === 'create' ? (item.record || {}) : (item.payload || {});
        return section(item.kind === 'create' ? 'Details' : 'Proposed changes', `
            <form class="review-sheet-form" id="reviewSheetForm" data-review-form novalidate>
                <div class="overview-details">${fields.map(f => fieldInput(f, values[f])).join('')}</div>
            </form>`);
    }

    function sheetBody(item, editing) {
        const pending = item.status === 'pending';
        const error = state.errors[item.id];
        const parts = [];

        if (error) parts.push(`<p class="review-error" role="alert">${escapeHtml(error)}</p>`);

        if (!pending) {
            const outcome = item.status === 'accepted' ? 'success' : (item.status === 'rejected' ? 'danger' : 'neutral');
            const decided = item.resolved_at ? ' · ' + escapeHtml(fullDate(item.resolved_at)) : '';
            parts.push(`<div class="review-outcome review-outcome--${outcome}">${statusPill(item)}<span>${decided ? decided.slice(3) : ''}</span></div>`);
        }

        if (pending && isStale(item)) {
            parts.push(callout('warning', ICON_WARN, 'Someone has changed this record since Claude proposed this. Check the values before accepting.'));
        }

        parts.push(editing ? editForm(item) : mainSection(item));

        if (item.comment) {
            parts.push(section('Claude\'s note', `<div class="review-sheet-note">${ICON_SPARK}<p>${escapeHtml(item.comment)}</p></div>`));
        }

        return parts.join('');
    }

    function sheetFooter(item, editing, busy) {
        const off = busy ? ' disabled' : '';

        if (editing) {
            return `
                <button type="button" class="btn btn-secondary" data-review-act="cancel"${off}>Cancel</button>
                ${item.kind === 'create' ? `<button type="button" class="btn btn-secondary" data-review-act="save" title="Keep your edits, decide later"${off}>Save only</button>` : ''}
                <button type="submit" class="btn btn-primary" form="reviewSheetForm"${off}>${ICON_CHECK}${item.kind === 'create' ? 'Save & accept' : 'Apply & accept'}</button>`;
        }

        const open = canOpen(item)
            ? `<button type="button" class="btn btn-secondary" data-review-act="open">${ICON_OPEN}${escapeHtml(openLabel(item))}</button>`
            : '';

        if (item.status !== 'pending') {
            return open;
        }

        return `
            <button type="button" class="btn btn-secondary ov-delete-btn" data-review-act="reject"${off}>${ICON_X}Reject</button>
            ${open}
            ${canEdit(item) ? `<button type="button" class="btn btn-secondary" data-review-act="edit"${off}>${ICON_EDIT}Edit</button>` : ''}
            <button type="button" class="btn btn-primary" data-review-act="accept"${off}>${ICON_CHECK}Accept</button>`;
    }

    function renderSheet() {
        if (!els.sheet || sheet.id === null) return;
        const item = findItem(sheet.id);
        if (!item) {
            closeSheet();
            return;
        }

        const editing = sheet.editing && canEdit(item);
        const busy = state.busy.has(item.id);
        const context = contextFor(item);

        els.sheet.classList.toggle('is-editing', editing);
        els.sheet.classList.toggle('is-busy', busy);
        els.sheetContent.dataset.reviewId = String(item.id);
        els.sheetIcon.className = `review-sheet-icon review-type-icon review-tone--${tone(item)}`;
        els.sheetIcon.innerHTML = typeIcon(item);
        els.sheetTitle.textContent = titleFor(item) || 'Proposal';
        els.sheetContext.innerHTML = `<span class="review-kind review-tone--${tone(item)}">${escapeHtml(kindLabel(item))}</span>${context ? `<span class="review-sheet-context-sep">·</span>${escapeHtml(context)}` : ''}`;
        els.sheetBy.innerHTML = personLine('Proposed by', item.source || 'Claude', null, item.created_at);
        els.sheetBody.innerHTML = sheetBody(item, editing);
        els.sheetFooter.innerHTML = sheetFooter(item, editing, busy);
    }

    function markCurrentRow() {
        document.querySelectorAll('.review-row').forEach(row => {
            row.classList.toggle('is-current', Number(row.dataset.reviewId) === sheet.id);
        });
    }

    function openSheet(id, { edit = false } = {}) {
        if (!els.sheet || !findItem(id) || state.bulk) return;
        const switching = sheet.id !== id;
        sheet.id = id;
        sheet.editing = edit;
        renderSheet();
        if (switching) els.sheetBody.scrollTop = 0;
        els.sheet.classList.add('active');
        markCurrentRow();
        if (edit) focusFirstField();
    }

    function closeSheet() {
        if (!els.sheet) return;
        els.sheet.classList.remove('active', 'is-editing', 'is-busy');
        sheet.id = null;
        sheet.editing = false;
        markCurrentRow();
    }

    function focusFirstField() {
        const first = els.sheetBody && els.sheetBody.querySelector('[data-field]');
        if (first) first.focus();
    }

    // One section per kind of record; within it what is new, then changes,
    // then what would go.
    // Notes and documents are listed with what they belong to.
    const GROUPS = [
        { title: 'Contacts', types: ['contact', 'contact_note'] },
        { title: 'Projects', types: ['project', 'project_note', 'project_document'] },
        { title: 'To-dos', types: ['todo'] },
        { title: 'Invoices', types: ['bookkeeping_pdf'] }
    ];

    const SUBGROUPS = [
        { key: 'new', title: 'New' },
        { key: 'notes', title: 'Notes' },
        { key: 'documents', title: 'Documents' },
        { key: 'change', title: 'Changes' },
        { key: 'delete', title: 'Deletions' }
    ];

    const NOTE_TYPES = ['contact_note', 'project_note'];

    /** The record a proposal is about, e.g. "todo:16". */
    function recordKey(item) {
        return item.entity_type + ':' + item.entity_id;
    }

    /** New first, then changes, then what would go. */
    function kindRank(item) {
        return item.kind === 'create' ? 0 : (item.kind === 'delete' ? 2 : 1);
    }

    /**
     * Where a record's proposals go: notes together, documents together;
     * otherwise with the new records if it is itself new, with the deletions
     * if one of them removes it, else with the changes.
     */
    function subgroupOf(proposals) {
        if (NOTE_TYPES.includes(proposals[0].entity_type)) return 'notes';
        if (proposals[0].entity_type === 'project_document') return 'documents';
        if (proposals.some(i => i.kind === 'create')) return 'new';
        if (proposals.some(i => i.kind === 'delete')) return 'delete';
        return 'change';
    }

    /**
     * A section's rows, split into new / changes / deletions. Proposals about
     * the same record stay together, as one cluster.
     */
    function groupBody(group, items) {
        const byRecord = new Map();
        items.forEach(item => {
            const key = recordKey(item);
            if (!byRecord.has(key)) byRecord.set(key, []);
            byRecord.get(key).push(item);
        });
        const records = [...byRecord.values()].map(list => list.sort((a, b) => kindRank(a) - kindRank(b)));

        return SUBGROUPS.map(sub => {
            const mine = records.filter(list => subgroupOf(list) === sub.key);
            if (!mine.length) return '';
            const count = mine.reduce((n, list) => n + list.length, 0);
            // Deleting a project archives it.
            const title = sub.key === 'delete' && group.types[0] === 'project' ? 'Archiving' : sub.title;
            return `
                <div class="review-subgroup review-subgroup--${sub.key}">
                    <h3 class="review-subgroup-title">${escapeHtml(title)} <span class="review-subgroup-count" data-review-count>${count}</span></h3>
                    <div class="review-list-card">${mine.map(list => list.length > 1 ? renderCluster(list) : renderRow(list[0])).join('')}</div>
                </div>`;
        }).join('');
    }

    const SUBGROUP_TONE = { new: 'created', notes: 'new', documents: 'new', change: 'change', delete: 'remove' };

    /**
     * Several proposals about one record: a row like any other for the record
     * - its name, how many proposals, accept all / reject all - with its
     * proposals indented beneath it, each still decided on its own if wanted.
     */
    function renderCluster(list) {
        const first = list[0];
        const key = recordKey(first);
        const n = list.length;
        const off = state.bulk ? ' disabled' : '';
        return `
            <div class="review-cluster" data-review-cluster="${escapeHtml(key)}">
                <div class="review-row-head review-cluster-head">
                    <div class="review-row-open">
                        <span class="review-type-icon review-tone--${SUBGROUP_TONE[subgroupOf(list)]}">${typeIcon(first)}</span>
                        <span class="review-row-text">
                            <span class="review-row-title">${escapeHtml(titleFor(first))}</span>
                            <span class="review-row-summary">
                                <span class="review-kind"><span data-review-count>${n}</span> proposals</span>
                                <span class="review-row-summary-text">${escapeHtml(list.map(kindLabel).join(' · '))}</span>
                            </span>
                        </span>
                    </div>
                    <div class="review-row-actions">
                        <button type="button" class="review-act review-act--reject" data-review-cluster-act="reject" title="Reject all" aria-label="Reject all ${n} proposals"${off}>${ICON_X}</button>
                        <button type="button" class="review-act review-act--accept" data-review-cluster-act="accept" title="Accept all" aria-label="Accept all ${n} proposals"${off}>${ICON_CHECK}</button>
                    </div>
                </div>
                ${list.map(renderRow).join('')}
            </div>`;
    }

    function render() {
        if (!els.list) return;
        updateTabs();
        renderBulk();

        if (state.loading && state.items.length === 0) {
            els.list.innerHTML = '<div class="review-empty"><p>Loading…</p></div>';
            return;
        }

        if (state.items.length === 0 && state.tab === 'pending' && state.cleared) {
            // Straight after "Accept all" / "Reject all": a check that draws itself.
            const accepted = state.cleared === 'accept';
            state.cleared = null;
            els.list.innerHTML = `
                <div class="review-empty review-empty--cleared review-empty--${accepted ? 'accept' : 'reject'}">
                    <svg class="review-done-mark" viewBox="0 0 52 52" aria-hidden="true">
                        <circle class="review-done-ring" cx="26" cy="26" r="23"/>
                        <path class="review-done-check" d="m15.5 27 7 7 14-15"/>
                    </svg>
                    <h3>${accepted ? 'All accepted' : 'All rejected'}</h3>
                    <p>${accepted ? 'Everything Claude proposed is now part of the CRM.' : 'Nothing Claude proposed was kept.'} New proposals will show up here.</p>
                </div>`;
            return;
        }

        if (state.items.length === 0) {
            els.list.innerHTML = state.tab === 'pending' ? `
                <div class="review-empty">
                    ${ICON_SPARK}
                    <h3>Nothing waiting</h3>
                    <p>When Claude adds or changes something in the CRM, it appears here first - and only becomes permanent once someone accepts it.</p>
                </div>` : `
                <div class="review-empty">
                    <h3>No decisions yet</h3>
                    <p>Accepted and rejected proposals are listed here.</p>
                </div>`;
            return;
        }

        if (state.tab === 'resolved') {
            els.list.innerHTML = `<section class="review-group">${listCard(state.items)}</section>`;
            return;
        }

        els.list.innerHTML = GROUPS.map(group => {
            const items = state.items.filter(i => group.types.includes(i.entity_type));
            if (!items.length) return '';
            return `
                <section class="review-group" aria-label="${escapeHtml(group.title)}">
                    <h2 class="review-group-title">${escapeHtml(group.title)} <span class="review-group-count">${items.length}</span></h2>
                    ${groupBody(group, items)}
                </section>`;
        }).join('');
    }

    function updateTabs() {
        document.querySelectorAll('[data-review-tab]').forEach(btn => {
            const active = btn.dataset.reviewTab === state.tab;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    function rerenderRow(id) {
        const item = findItem(id);
        if (!item) return;
        document.querySelectorAll(`.review-row[data-review-id="${id}"]`).forEach(node => {
            node.outerHTML = renderRow(item);
        });
        if (sheet.id === id) renderSheet();
    }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    async function load(tab) {
        if (tab) state.tab = tab;
        state.loading = true;
        render();
        try {
            const result = await request(`${API}?action=list&status=${state.tab === 'resolved' ? 'resolved' : 'pending'}`);
            // A decision still waiting for Undo keeps its proposals off the screen.
            state.items = (Array.isArray(result.data) ? result.data : []).filter(i => !isHeld(i));
            state.errors = {};
        } catch (error) {
            state.items = [];
            if (els.list) els.list.innerHTML = `<div class="review-empty"><p class="review-error">${escapeHtml(error.message)}</p></div>`;
            state.loading = false;
            return;
        }
        state.loading = false;
        render();
        if (state.tab === 'pending') setBadge(state.items.length);
        // The open sheet follows the fresh copy, or closes if it is gone.
        if (sheet.id !== null) {
            if (findItem(sheet.id)) {
                renderSheet();
            } else {
                closeSheet();
            }
        }
    }

    function setBadge(count) {
        document.querySelectorAll('[data-review-badge]').forEach(node => {
            node.textContent = String(count);
            node.hidden = count === 0;
        });
        if (els.subtitle) {
            els.subtitle.textContent = count > 0
                ? `${count} waiting for a decision. Nothing Claude proposes is permanent until someone accepts it.`
                : 'Everything Claude adds or changes waits here until someone on the team accepts it.';
        }
    }

    async function refreshBadge() {
        try {
            const result = await request(`${API}?action=summary`);
            setBadge((result.data && result.data.total) || 0);
        } catch (e) {
            // A missed badge refresh is not worth bothering anyone about.
        }
    }

    // ------------------------------------------------------------------
    // Deciding
    // ------------------------------------------------------------------

    function findItem(id) {
        return state.items.find(i => i.id === id) || panelItems.get(id) || null;
    }

    function readForm(form) {
        const values = {};
        form.querySelectorAll('[data-field]').forEach(input => {
            const field = input.dataset.field;
            if (input.type === 'checkbox') {
                values[field] = input.checked ? 1 : 0;
            } else if (NUMBER_FIELDS.includes(field)) {
                values[field] = input.value.trim() === '' ? null : Number(input.value);
            } else {
                values[field] = input.value.trim() === '' ? null : input.value.trim();
            }
        });
        return values;
    }

    async function putContact(id, values) {
        const current = (await request(`api/contacts.php?id=${id}`)).data || {};
        const merged = Object.assign({}, current, values);
        await request(`api/contacts.php?id=${id}`, {
            method: 'PUT',
            json: {
                payload: encodeUtf8Base64(JSON.stringify({
                    n: merged.name ?? '', c: merged.company ?? '', l: merged.location ?? '',
                    lat: merged.latitude ?? null, lng: merged.longitude ?? null, o: merged.note ?? '',
                    e: merged.email ?? '', p: merged.phone ?? '', w: merged.website ?? '', a: merged.address ?? ''
                }))
            }
        });
    }

    async function putProject(id, values) {
        const current = (await request(`api/projects.php?id=${id}`)).data || {};
        const merged = Object.assign({}, current, values);
        await request(`api/projects.php?id=${id}`, {
            method: 'PUT',
            json: {
                name: merged.name, start_date: merged.start_date, description: merged.description,
                company: merged.company, budget_min: merged.budget_min, budget_max: merged.budget_max,
                success_chance: merged.success_chance, stage: merged.stage,
                estimated_completion: merged.estimated_completion
            }
        });
    }

    async function putTodo(id, values) {
        await request(`api/todos.php?id=${id}`, { method: 'PUT', json: values });
    }

    /** Write edited values into a record Claude proposed (it stays pending). */
    async function saveProposedRecord(item, values) {
        const id = item.entity_id;
        switch (item.entity_type) {
            case 'contact': return putContact(id, values);
            case 'project': return putProject(id, values);
            case 'todo': return putTodo(id, values);
            case 'contact_note':
            case 'project_note':
                return request(`${API}?action=edit-note`, { method: 'POST', json: { entity_type: item.entity_type, entity_id: id, content: values.content } });
            default:
                throw new Error('This kind of proposal cannot be edited.');
        }
    }

    /** Apply a change to an existing record through the ordinary endpoints. */
    async function applyChange(item, values) {
        const id = item.entity_id;

        if (item.kind === 'update') {
            const changes = values || item.payload || {};
            if (item.entity_type === 'contact') return putContact(id, changes);
            if (item.entity_type === 'project') return putProject(id, changes);
            if (item.entity_type === 'todo') return putTodo(id, changes);
        }

        if (item.kind === 'delete') {
            const urls = {
                contact: `api/contacts.php?id=${id}`,
                project: `api/projects.php?id=${id}`,
                todo: `api/todos.php?id=${id}`,
                contact_note: `api/notes.php?id=${id}`,
                project_note: `api/projects.php?action=delete-note&id=${id}`
            };
            if (!urls[item.entity_type]) throw new Error('This record cannot be deleted from here.');
            return request(urls[item.entity_type], { method: 'DELETE' });
        }

        if (item.kind === 'assign') {
            return request('api/assign.php', {
                method: 'POST',
                json: { type: ASSIGN_TYPE[item.entity_type], id, assigned_to: (item.payload || {}).assigned_to ?? null }
            });
        }

        throw new Error('Unknown kind of change.');
    }

    /**
     * What to ask before a decision, or null when Undo is enough. Asked only
     * where the result outlasts the few seconds Undo has: something deleted
     * for good, a new contact or project removed with everything added to
     * it, or a newer value overwritten.
     */
    function confirmFor(items, action) {
        const name = escapeHtml(titleFor(items[0]) || items[0].entity_label || '');
        const parts = [];
        let title = '';
        let label = '';

        if (action === 'accept') {
            const del = items.find(i => i.kind === 'delete' && i.entity_type !== 'project');
            if (del) {
                title = 'Delete for good?';
                label = 'Delete';
                parts.push(`Accepting deletes the ${escapeHtml(TYPE_LABEL[del.entity_type] || 'record')} <strong>${name}</strong> for good.`
                    + (del.entity_type === 'contact' ? ' Its notes, to-dos, tags and project links go with it.' : ''));
            }
            const stale = items.filter(isStale);
            if (stale.length) {
                title = title || 'Overwrite newer changes?';
                label = label || 'Accept anyway';
                const fields = stale.flatMap(staleFields);
                parts.push(`Someone changed <strong>${name}</strong> since Claude proposed this: `
                    + fields.map(f => `${escapeHtml(f.label)} is now <strong>${escapeHtml(f.now)}</strong>`).join(', ')
                    + '. Accepting replaces it with Claude\'s value.');
            }
        } else {
            const created = items.find(i => i.kind === 'create' && (i.entity_type === 'contact' || i.entity_type === 'project'));
            if (created) {
                title = `Remove the proposed ${TYPE_LABEL[created.entity_type]}?`;
                label = 'Remove';
                parts.push(`<strong>${name}</strong> is removed, along with anything added to it.`);
            }
        }

        if (!parts.length) return null;
        return { title, message: parts.map(text => `<p>${text}</p>`).join(''), confirmLabel: label, danger: action === 'reject' || label === 'Delete' };
    }

    /**
     * The network half of a decision, shared by a single click and by
     * "Accept all" / "Reject all", so both take exactly the same path:
     * changes the browser applies go through the ordinary endpoints first.
     */
    async function performDecision(item, action, values = null) {
        const id = item.id;
        if (action === 'reject') {
            await request(`${API}?action=reject`, { method: 'POST', json: { id } });
        } else if (item.applied_by === 'client') {
            await applyChange(item, values);
            await request(`${API}?action=resolve`, { method: 'POST', json: { id } });
        } else {
            if (values && item.kind === 'create') {
                await saveProposedRecord(item, values);
            }
            await request(`${API}?action=accept`, { method: 'POST', json: { id } });
        }
    }

    async function decide(id, action, values = null) {
        const item = findItem(id);
        if (!item || state.busy.has(id) || state.bulk) return;

        const ask = confirmFor([item], action);
        if (ask && !(await askConfirm(ask))) return;

        if (sheet.id === id) closeSheet();
        hold([item], action, values, action === 'reject' ? 'Rejected' : 'Accepted');
    }

    // ------------------------------------------------------------------
    // Undo: a decision waits a few seconds before it is sent
    // ------------------------------------------------------------------

    const UNDO_MS = 5000;

    // The decision that can still be undone: { items, action, values, timer },
    // or { inline: {entityType, entityId, host}, action, timer } for the
    // buttons on a proposed record where it is listed. Only one at a time;
    // the next decision sends it straight away.
    let held = null;
    // Proposals decided but not sent yet, kept off the screen meanwhile.
    const heldIds = new Set();
    // The same for the inline buttons, which only know the record: "type:id".
    const heldInline = new Set();

    function inlineKey(entityType, entityId) {
        return `${entityType}:${Number(entityId)}`;
    }

    function isHeld(item) {
        return heldIds.has(item.id)
            || (item.kind === 'create' && heldInline.has(inlineKey(item.entity_type, item.entity_id)));
    }

    function hold(items, action, values, message) {
        flushHeld();
        const entry = { items, action, values, timer: null };
        items.forEach(item => {
            heldIds.add(item.id);
            delete state.errors[item.id];
            removeItem(item.id, action);
        });
        entry.timer = setTimeout(() => commitHeld(entry), UNDO_MS);
        held = entry;
        toast(message, { undo: true });
    }

    /** Send the decision that is waiting now, without waiting any longer. */
    function flushHeld() {
        if (!held) return;
        clearTimeout(held.timer);
        commitHeld(held);
    }

    function undoHeld() {
        if (!held) return;
        const entry = held;
        held = null;
        clearTimeout(entry.timer);
        if (entry.inline) {
            heldInline.delete(inlineKey(entry.inline.entityType, entry.inline.entityId));
            showInlineHeld(entry.inline, null);
        } else {
            entry.items.forEach(item => heldIds.delete(item.id));
        }
        hideToast();
        // Nothing was sent: the proposals are simply still open.
        load();
        notifyChanged({ action: 'undo' });
    }

    async function commitHeld(entry) {
        if (held === entry) held = null;
        if (entry.inline) {
            await commitInline(entry);
            return;
        }
        const items = entry.items;
        const failed = [];

        for (const item of items.length > 1 ? clusterOrder(items, entry.action) : items) {
            try {
                await performDecision(item, entry.action, items.length === 1 ? entry.values : null);
            } catch (error) {
                failed.push({ item, message: error.message });
            }
        }
        items.forEach(item => heldIds.delete(item.id));

        if (failed.length) {
            // Back on the screen, with the reason.
            toast(failed.length === items.length
                ? 'Could not be saved - ' + failed[0].message
                : `${items.length - failed.length} of ${items.length} done - ${failed.length} need${failed.length === 1 ? 's' : ''} a look`);
            await load();
            failed.forEach(f => { if (findItem(f.item.id)) state.errors[f.item.id] = f.message; });
            render();
        } else if (items.length > 1) {
            // Deciding together can settle other proposals on the server.
            await load();
        }

        const first = items[0];
        notifyChanged({
            id: items.length === 1 ? first.id : undefined,
            action: entry.action,
            kind: items.some(i => i.kind === 'create') ? 'create' : (items.some(i => i.kind === 'delete') ? 'delete' : first.kind),
            entity_type: first.entity_type,
            entity_id: first.entity_id
        });
    }

    async function saveOnly(id, values) {
        const item = findItem(id);
        if (!item || state.busy.has(id)) return;

        state.busy.add(id);
        delete state.errors[id];
        try {
            await saveProposedRecord(item, values);
            state.busy.delete(id);
            // A proposal opened from a contact's or project's box is not in the
            // list load() fetches; show the saved values on it right away.
            if (item.record) Object.assign(item.record, values);
            if (sheet.id === id) sheet.editing = false;
            toast('Saved - still waiting for a decision');
            await load();
            notifyChanged({ id, action: 'edit', entity_type: item.entity_type, entity_id: item.entity_id });
        } catch (error) {
            state.busy.delete(id);
            state.errors[id] = error.message;
            rerenderRow(id);
        }
    }

    /**
     * Take a decided row off the screen. With an outcome it takes on a faint
     * tint of it, lifts and fades, then the gap closes; with "reduce motion"
     * set, or no outcome, it simply fades.
     */
    function removeItem(id, outcome = null) {
        state.items = state.items.filter(i => i.id !== id);
        panelItems.delete(id);
        const still = reduceMotion() || !outcome;
        const fade = still ? 0 : 220;     // tint + lift, before the gap closes
        const collapse = still ? 180 : 260;

        document.querySelectorAll(`.review-row[data-review-id="${id}"]`).forEach(node => {
            // A fixed height to collapse from; 'auto' cannot be animated.
            node.style.height = `${node.offsetHeight}px`;
            node.classList.add('is-leaving');
            if (!still) node.classList.add(`is-leaving--${outcome}`);

            setTimeout(() => node.classList.add('is-collapsing'), fade);
            setTimeout(() => {
                const group = node.closest('.review-group');
                const sub = node.closest('.review-subgroup');
                const cluster = node.closest('.review-cluster');
                const panel = node.closest('.review-record-slot');
                node.remove();
                if (cluster && !cluster.querySelector('.review-row')) cluster.remove();
                if (sub && !sub.querySelector('.review-row')) sub.remove();
                if (group && !group.querySelector('.review-row')) group.remove();
                if (panel && !panel.querySelector('.review-row')) panel.hidden = true;
                if (els.list && state.tab === 'pending' && state.items.length === 0 && !state.bulk) render();
            }, fade + collapse);
        });
        if (state.tab === 'pending' && els.list) {
            els.list.querySelectorAll('.review-group, .review-subgroup, .review-cluster').forEach(group => {
                const count = group.querySelectorAll('.review-row:not(.is-leaving)').length;
                const badge = group.querySelector(':scope > h2 > .review-group-count, :scope > h3 > [data-review-count], :scope > .review-cluster-head [data-review-count]');
                if (badge) badge.textContent = String(count);
            });
        }
    }

    // ------------------------------------------------------------------
    // Accept all / Reject all
    // ------------------------------------------------------------------

    function renderBulk() {
        if (!els.bulk) return;
        const pending = state.tab === 'pending' && !state.loading && (state.items.length > 0 || state.bulk);
        els.bulk.hidden = !pending;
        els.bulk.classList.toggle('is-running', !!state.bulk);
        if (els.list) els.list.classList.toggle('is-bulk-running', !!state.bulk);

        els.bulk.querySelectorAll('[data-review-bulk]').forEach(btn => { btn.disabled = !!state.bulk; });
        if (els.list) els.list.querySelectorAll('[data-review-cluster-act]').forEach(btn => { btn.disabled = !!state.bulk; });
        // Switching tab mid-run would reload the list under the loop and
        // silently skip whatever was left, so the tabs wait too.
        document.querySelectorAll('[data-review-tab]').forEach(btn => { btn.disabled = !!state.bulk; });

        const bulk = state.bulk;
        if (bulk) {
            els.bulk.dataset.action = bulk.action;
            els.bulkBar.style.transform = `scaleX(${bulk.total ? bulk.done / bulk.total : 0})`;
            els.bulkStatus.textContent = `${bulk.action === 'accept' ? 'Accepting' : 'Rejecting'} ${Math.min(bulk.done + 1, bulk.total)} of ${bulk.total}…`;
        } else {
            delete els.bulk.dataset.action;
            els.bulkBar.style.transform = 'scaleX(0)';
            els.bulkStatus.textContent = '';
        }
    }

    function bulkQuestion(action, items, outdated) {
        const n = items.length;
        const what = n === 1 ? 'the 1 proposal' : `all ${n} proposals`;
        if (action === 'accept') {
            const deletes = items.filter(i => i.kind === 'delete' && i.entity_type !== 'project').length;
            return {
                title: n === 1 ? 'Accept 1 proposal?' : `Accept ${n} proposals?`,
                message: `<p>Accept ${what} from Claude?</p>`
                    + (deletes ? `<p>${deletes === 1 ? 'One of them deletes a record' : deletes + ' of them delete records'} for good.</p>` : '')
                    + (outdated ? `<p>${outdated === 1 ? '1 outdated proposal is' : outdated + ' outdated proposals are'} left for you to check: someone has changed those records since.</p>` : ''),
                confirmLabel: 'Accept all',
                danger: deletes > 0
            };
        }
        return {
            title: n === 1 ? 'Reject 1 proposal?' : `Reject ${n} proposals?`,
            message: `<p>Reject ${what} from Claude?</p><p>New records Claude proposed are removed, along with anything added to them, and proposed changes are discarded.</p>`,
            confirmLabel: 'Reject all',
            danger: true
        };
    }

    /**
     * Records proposed on top of other proposals (a note on a proposed
     * contact) need their parent settled the right way round: accepting goes
     * parents first, rejecting children first - rejecting a proposed contact
     * already takes everything attached to it along.
     */
    function bulkOrder(items, action) {
        const isParent = i => i.kind === 'create' && (i.entity_type === 'contact' || i.entity_type === 'project');
        const parents = items.filter(isParent);
        const rest = items.filter(i => !isParent(i));
        // A record has to be changed before it is deleted, not after.
        return action === 'accept'
            ? parents.concat(rest.filter(i => i.kind !== 'delete'), rest.filter(i => i.kind === 'delete'))
            : rest.concat(parents);
    }

    // ------------------------------------------------------------------
    // Accept all / Reject all for one record
    // ------------------------------------------------------------------

    /**
     * Accepting goes new record first, deletion last; rejecting leaves the
     * new record for last, since rejecting it removes everything about it.
     */
    function clusterOrder(items, action) {
        const sorted = items.slice().sort((a, b) => kindRank(a) - kindRank(b));
        return action === 'accept' ? sorted : sorted.filter(i => i.kind !== 'create').concat(sorted.filter(i => i.kind === 'create'));
    }

    async function decideCluster(key, action) {
        if (state.bulk) return;
        const items = state.items.filter(i => i.status === 'pending' && recordKey(i) === key && !state.busy.has(i.id));
        if (items.length === 0) return;

        const ask = confirmFor(items, action);
        if (ask && !(await askConfirm(ask))) return;

        if (items.some(i => i.id === sheet.id)) closeSheet();
        hold(items, action, null, `${action === 'reject' ? 'Rejected' : 'Accepted'} all ${items.length}`);
    }

    async function decideAll(action) {
        if (state.bulk) return;
        flushHeld();
        const open = state.items.filter(i => i.status === 'pending' && !state.busy.has(i.id));
        // Accepting everything leaves out what someone has changed since:
        // those need a look of their own. Rejecting overwrites nothing.
        const outdated = action === 'accept' ? open.filter(isStale).length : 0;
        const items = action === 'accept' ? open.filter(i => !isStale(i)) : open;
        if (items.length === 0) {
            if (outdated) toast('Only outdated proposals are left - check them one by one');
            return;
        }
        if (!(await askConfirm(bulkQuestion(action, items, outdated)))) return;

        state.bulk = { action, total: items.length, done: 0, failed: 0 };
        closeSheet();
        renderBulk();

        for (const item of bulkOrder(items, action)) {
            // Taken along by an earlier decision (a child of a rejected record).
            if (!findItem(item.id)) {
                state.bulk.done++;
                renderBulk();
                continue;
            }

            state.busy.add(item.id);
            delete state.errors[item.id];
            rerenderRow(item.id);

            try {
                await performDecision(item, action);
                state.busy.delete(item.id);
                removeItem(item.id, action);
            } catch (error) {
                state.busy.delete(item.id);
                state.errors[item.id] = error.message;
                state.bulk.failed++;
                rerenderRow(item.id);
            }

            state.bulk.done++;
            renderBulk();
            // A beat between rows, so a fast connection still reads as a
            // cascade rather than everything vanishing at once.
            if (!reduceMotion()) await wait(90);
        }

        const { failed, total } = state.bulk;
        // Let the last rows finish leaving before the list is rebuilt.
        await wait(reduceMotion() ? 200 : 520);
        state.bulk = null;

        const verb = action === 'accept' ? 'Accepted' : 'Rejected';
        if (failed > 0) {
            toast(`${total - failed} of ${total} done - ${failed} need${failed === 1 ? 's' : ''} a look`);
        } else if (outdated) {
            toast(`${verb} ${total} - ${outdated} outdated left for you`);
        } else {
            state.cleared = action;
            toast(`${verb} ${total === 1 ? '1 proposal' : 'all ' + total}`);
        }

        // Reload rather than trust the local list: decisions can settle other
        // proposals on the server (a rejected contact takes its notes along).
        // An empty result shows the "all done" mark, which consumes the flag.
        // load() starts from a clean slate; keep the reason on any row that failed.
        const errors = { ...state.errors };
        await load();
        state.cleared = null;
        if (failed > 0) {
            Object.keys(errors).forEach(id => {
                if (findItem(Number(id))) state.errors[id] = errors[id];
            });
            render();
        }
        notifyChanged({ action, bulk: true });
    }

    // ------------------------------------------------------------------
    // Asking first, in the CRM's own dialog
    // ------------------------------------------------------------------

    let confirmResolve = null;

    /** Resolves true for the confirm button, false for Cancel, Escape or the backdrop. */
    function askConfirm({ title, message, confirmLabel, danger }) {
        if (!els.confirm) return Promise.resolve(true);
        if (confirmResolve) confirmResolve(false);
        els.confirmTitle.textContent = title;
        els.confirmMessage.innerHTML = message;
        els.confirmOk.textContent = confirmLabel || 'OK';
        els.confirmOk.classList.toggle('btn-danger', !!danger);
        els.confirmOk.classList.toggle('btn-primary', !danger);
        els.confirm.classList.add('active');
        els.confirmOk.focus();
        return new Promise(resolve => { confirmResolve = resolve; });
    }

    function closeConfirm(answer) {
        if (!els.confirm) return;
        els.confirm.classList.remove('active');
        const resolve = confirmResolve;
        confirmResolve = null;
        if (resolve) resolve(answer);
    }

    function openRecord(item) {
        // app.js exposes its openers as window.CRM.
        const crm = window.CRM || {};
        const r = item.record || {};
        switch (item.entity_type) {
            case 'contact': return crm.openOverview && crm.openOverview(item.entity_id);
            case 'project': return crm.openProjectOverview && crm.openProjectOverview(item.entity_id);
            case 'todo':
                if (crm.openTodoDetail) return crm.openTodoDetail(item.entity_id);
                if (r.contact_id && crm.openOverview) return crm.openOverview(r.contact_id);
                if (r.project_id && crm.openProjectOverview) return crm.openProjectOverview(r.project_id);
                return null;
            case 'contact_note': return r.contact_id && crm.openOverview && crm.openOverview(r.contact_id);
            case 'project_note':
            case 'project_document':
                return r.project_id && crm.openProjectOverview && crm.openProjectOverview(r.project_id);
            case 'bookkeeping_pdf':
                if (r.row_id && crm.openBookkeepingRow) return crm.openBookkeepingRow(r.row_id);
                return crm.switchView && crm.switchView('bookkeeping');
            default: return null;
        }
    }

    // ------------------------------------------------------------------
    // Telling the rest of the app
    // ------------------------------------------------------------------

    function notifyChanged(detail) {
        refreshBadge();
        document.dispatchEvent(new CustomEvent('crm:review-changed', { detail }));
    }

    let toastTimer = null;
    /** A short confirmation at the bottom; with { undo: true } it offers Undo while the decision waits. */
    function toast(message, { undo = false } = {}) {
        let node = document.getElementById('reviewToast');
        if (!node) {
            node = document.createElement('div');
            node.id = 'reviewToast';
            node.className = 'review-toast';
            node.setAttribute('role', 'status');
            document.body.appendChild(node);
        }
        node.innerHTML = `<span>${escapeHtml(message)}</span>`
            + (undo ? '<button type="button" class="review-toast-undo" data-review-undo>Undo</button>' : '');
        node.classList.toggle('has-action', undo);
        node.classList.add('is-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(hideToast, undo ? UNDO_MS : 2200);
    }

    function hideToast() {
        const node = document.getElementById('reviewToast');
        if (node) node.classList.remove('is-visible', 'has-action');
        clearTimeout(toastTimer);
    }

    // ------------------------------------------------------------------
    // Pieces other modules put on records
    // ------------------------------------------------------------------

    /** The mark on a proposed record in a list. */
    function badge(record) {
        if (!record || record.review_status !== 'pending') return '';
        // Says what it means, not just who: the point is that nobody has accepted it yet.
        return `<span class="review-badge" title="Proposed by Claude - not accepted yet">${ICON_SPARK}<span>Awaiting review</span></span>`;
    }

    /**
     * The quieter mark on an accepted to-do or project Claude proposes to
     * change (record.pending_changes: the kinds, e.g. ['assign']). Deciding happens
     * in the record's own sheet, which lists the proposals.
     */
    function changeBadge(record, entityType = 'todo') {
        const kinds = (record && Array.isArray(record.pending_changes)) ? record.pending_changes : [];
        if (kinds.length === 0 || record.review_status === 'pending') return '';
        const words = {
            update: 'Change', assign: 'Reassignment',
            delete: entityType === 'project' ? 'Archiving' : 'Deletion',
            link: 'New contact', unlink: 'Contact removal', tag: 'Tag change', untag: 'Tag change'
        };
        const label = kinds.length === 1
            ? (words[kinds[0]] || 'Change') + ' proposed'
            : kinds.length + ' changes proposed';
        return `<span class="review-change-badge" title="Claude proposes ${kinds.length === 1 ? 'a change' : kinds.length + ' changes'} here - open it to accept or reject">${ICON_SPARK}<span>${escapeHtml(label)}</span></span>`;
    }

    /**
     * Reject / accept buttons for a proposed note, to-do, invoice or document,
     * where it is listed. Reject first and accept last, as everywhere else.
     */
    function inlineActions(entityType, id) {
        // Drawn again while its decision waits for Undo: nothing to decide.
        if (heldInline.has(inlineKey(entityType, id))) return '';
        return `
            <span class="review-inline" data-review-inline-type="${escapeHtml(entityType)}" data-review-inline-id="${Number(id)}">
                <button type="button" class="review-inline-btn review-inline-btn--reject" data-review-inline="reject" title="Reject Claude's proposal" aria-label="Reject Claude's proposal">${ICON_X}</button>
                <button type="button" class="review-inline-btn review-inline-btn--accept" data-review-inline="accept" title="Accept Claude's proposal" aria-label="Accept Claude's proposal">${ICON_CHECK}</button>
            </span>`;
    }

    const panelItems = new Map();

    /**
     * The open proposals about one contact or project, shown in its detail view.
     */
    async function renderRecordPanel(entityType, entityId, slot) {
        if (!slot) return;
        slot.hidden = true;
        slot.innerHTML = '';
        slot.dataset.entityType = entityType;
        slot.dataset.entityId = String(entityId);

        let items = [];
        try {
            const result = await request(`${API}?action=list&entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`);
            items = (Array.isArray(result.data) ? result.data : []).filter(i => !isHeld(i));
        } catch (e) {
            return;
        }

        // The detail view may have moved on to another record meanwhile.
        if (slot.dataset.entityType !== entityType || slot.dataset.entityId !== String(entityId) || items.length === 0) return;

        items.forEach(item => panelItems.set(item.id, item));
        const isNew = items.some(i => i.kind === 'create');
        slot.innerHTML = `
            <div class="review-panel">
                <div class="review-panel-head">
                    ${ICON_SPARK}
                    <span>${isNew ? `This ${TYPE_LABEL[entityType]} was proposed by Claude and is not accepted yet.` : `Claude proposes ${items.length === 1 ? 'a change' : items.length + ' changes'} here.`}</span>
                </div>
                ${listCard(items)}
            </div>`;
        slot.hidden = false;
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function bind() {
        els.list = document.getElementById('reviewList');
        els.subtitle = document.getElementById('reviewSubtitle');
        els.bulk = document.getElementById('reviewBulk');
        els.bulkBar = document.getElementById('reviewBulkBar');
        els.bulkStatus = document.getElementById('reviewBulkStatus');
        els.sheet = document.getElementById('reviewDetailModal');
        if (els.sheet) {
            els.sheetContent = els.sheet.querySelector('.modal-content');
            els.sheetIcon = document.getElementById('reviewSheetIcon');
            els.sheetTitle = document.getElementById('reviewSheetTitle');
            els.sheetContext = document.getElementById('reviewSheetContext');
            els.sheetBy = document.getElementById('reviewSheetBy');
            els.sheetBody = document.getElementById('reviewSheetBody');
            els.sheetFooter = document.getElementById('reviewSheetFooter');
        }
        els.confirm = document.getElementById('reviewConfirmModal');
        if (els.confirm) {
            els.confirmTitle = document.getElementById('reviewConfirmTitle');
            els.confirmMessage = document.getElementById('reviewConfirmMessage');
            els.confirmOk = document.getElementById('reviewConfirmOk');
            els.confirm.addEventListener('click', event => {
                if (event.target.closest('#reviewConfirmOk')) closeConfirm(true);
                else if (event.target.closest('[data-review-confirm-cancel]')) closeConfirm(false);
            });
        }

        if (els.bulk) {
            els.bulk.addEventListener('click', event => {
                const btn = event.target.closest('[data-review-bulk]');
                if (btn) decideAll(btn.dataset.reviewBulk);
            });
        }

        document.querySelectorAll('[data-review-tab]').forEach(btn => {
            btn.addEventListener('click', () => load(btn.dataset.reviewTab));
        });

        // One delegated handler for every row, wherever it is rendered, and
        // for the sheet - both carry the proposal's id.
        document.addEventListener('click', event => {
            if (event.target.closest('[data-review-undo]')) {
                undoHeld();
                return;
            }

            if (event.target.closest('[data-review-sheet-close]')) {
                closeSheet();
                return;
            }

            const clusterBtn = event.target.closest('[data-review-cluster-act]');
            if (clusterBtn) {
                event.preventDefault();
                const cluster = clusterBtn.closest('[data-review-cluster]');
                if (cluster) decideCluster(cluster.dataset.reviewCluster, clusterBtn.dataset.reviewClusterAct);
                return;
            }

            const actBtn = event.target.closest('[data-review-act]');
            if (actBtn) {
                const holder = actBtn.closest('[data-review-id]');
                if (!holder) return;
                const id = Number(holder.dataset.reviewId);
                const act = actBtn.dataset.reviewAct;
                const item = findItem(id);
                if (!item) return;

                if (act === 'accept' || act === 'reject') {
                    event.preventDefault();
                    decide(id, act);
                } else if (act === 'sheet') {
                    openSheet(id);
                } else if (act === 'edit') {
                    openSheet(id, { edit: true });
                } else if (act === 'cancel') {
                    sheet.editing = false;
                    renderSheet();
                } else if (act === 'save') {
                    event.preventDefault();
                    saveOnly(id, readForm(els.sheet.querySelector('[data-review-form]')));
                } else if (act === 'open') {
                    // The record's own sheet takes this one's place.
                    closeSheet();
                    openRecord(item);
                }
                return;
            }

            const inlineBtn = event.target.closest('[data-review-inline]');
            if (inlineBtn) {
                // These sit inside clickable rows; the click is only this one.
                event.preventDefault();
                event.stopPropagation();
                const wrap = inlineBtn.closest('[data-review-inline-type]');
                decideInline(wrap.dataset.reviewInlineType, Number(wrap.dataset.reviewInlineId), inlineBtn.dataset.reviewInline, inlineBtn);
            }
        }, true);

        document.addEventListener('submit', event => {
            const form = event.target.closest('[data-review-form]');
            if (!form) return;
            event.preventDefault();
            const holder = form.closest('[data-review-id]');
            decide(Number(holder.dataset.reviewId), 'accept', readForm(form));
        });

        // Escape on the question answers it with Cancel, and nothing else.
        window.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !els.confirm || !els.confirm.classList.contains('active')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            closeConfirm(false);
        }, true);

        // A decision still waiting for Undo is sent when the page goes; should
        // the request not make it, the proposal simply stays open.
        window.addEventListener('pagehide', flushHeld);

        // Escape: leave editing first, then close. Captured ahead of app.js,
        // which would otherwise close the contact or project sheet underneath.
        window.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !els.sheet || !els.sheet.classList.contains('active')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (sheet.editing) {
                sheet.editing = false;
                renderSheet();
            } else {
                closeSheet();
            }
        }, true);

        refreshBadge();
        // Claude may propose things while the page is open; keep the badge honest.
        state.pollTimer = setInterval(() => {
            if (document.visibilityState === 'visible') refreshBadge();
        }, 90000);
    }

    /**
     * The buttons on a proposed record where it is listed hold their decision
     * for Undo like the From Claude screen does. Meanwhile the buttons make
     * way and a rejected record fades; the lists catch up once it is sent.
     */
    function decideInline(entityType, entityId, action, button) {
        const wrap = button.closest('.review-inline');
        const host = wrap && (wrap.closest('.todo-item, .ptodo, .note-item, .pdoc-item, .bk-pool-item, .home-todo') || wrap.parentElement);

        flushHeld();
        const inline = { entityType, entityId, host };
        heldInline.add(inlineKey(entityType, entityId));
        showInlineHeld(inline, action);

        const entry = { inline, action, timer: null };
        entry.timer = setTimeout(() => commitHeld(entry), UNDO_MS);
        held = entry;
        toast(action === 'reject' ? 'Rejected' : 'Accepted', { undo: true });
    }

    /** Mark the record as decided (action) or put it back as it was (null). */
    function showInlineHeld(inline, action) {
        const host = inline.host;
        if (!host || !host.isConnected) return;
        host.classList.remove('review-held', 'review-held--accept', 'review-held--reject');
        if (action) host.classList.add('review-held', `review-held--${action}`);
    }

    async function commitInline(entry) {
        const { entityType, entityId } = entry.inline;
        try {
            await request(`${API}?action=${entry.action === 'reject' ? 'reject' : 'accept'}`, {
                method: 'POST',
                json: { entity_type: entityType, entity_id: entityId }
            });
        } catch (error) {
            toast('Could not be saved - ' + error.message);
        }
        heldInline.delete(inlineKey(entityType, entityId));
        showInlineHeld(entry.inline, null);
        notifyChanged({ action: entry.action, kind: 'create', entity_type: entityType, entity_id: entityId });
    }

    window.CRMReview = {
        load,
        refreshBadge,
        renderRecordPanel,
        badge,
        changeBadge,
        inlineActions
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
