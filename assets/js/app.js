/**
 * Simple CRM - Frontend Application
 * Handles map, list view, and contact management
 */

(function() {
    'use strict';

    // ============================================
    // Custom Map Marker Icon
    // ============================================

    const markerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40"><path d="M14 0C6.268 0 0 6.268 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.268 21.732 0 14 0zm0 20a6 6 0 1 1 0-12 6 6 0 0 1 0 12z" fill="%23ffffff" stroke="%23000" stroke-width="1"/><circle cx="14" cy="14" r="4" fill="%23000"/></svg>`;

    const customIcon = L.icon({
        iconUrl: 'data:image/svg+xml,' + encodeURIComponent(markerSvg.replace(/%23/g, '#')),
        iconSize: [28, 40],
        iconAnchor: [14, 40],
        popupAnchor: [0, -36]
    });

    // ============================================
    // State Management
    // ============================================

    const state = {
        currentView: 'map',
        contacts: [],
        mapContacts: [],
        sortField: 'name',
        sortOrder: 'ASC',
        searchQuery: '',
        editingContactId: null,
        viewingContactId: null,
        viewingContact: null,
        map: null,
        markers: null,
        groupBy: 'company', // 'company' or 'tags'
        allTags: [],
        taggedData: null,
        selectedImportFile: null,
        // Calendar state
        calendarMode: 'month', // 'month', 'week', 'day'
        calendarDate: new Date(),
        calendarNotes: [],
        calendarSearch: '',
        calendarTagFilter: '',
        // Project state
        projects: [],
        projectSortField: 'name',
        projectSortOrder: 'ASC',
        projectSearchQuery: '',
        editingProjectId: null,
        viewingProjectId: null,
        viewingProject: null
    };

    // ============================================
    // DOM Elements
    // ============================================

    const elements = {
        // Views
        mapView: document.getElementById('mapView'),
        listView: document.getElementById('listView'),
        calendarView: document.getElementById('calendarView'),
        mapContainer: document.getElementById('map'),

        // Calendar elements
        calendarBody: document.getElementById('calendarBody'),
        calTitle: document.getElementById('calTitle'),
        calPrev: document.getElementById('calPrev'),
        calNext: document.getElementById('calNext'),
        calToday: document.getElementById('calToday'),
        calModeBtns: document.querySelectorAll('.cal-mode-btn'),
        calSearchInput: document.getElementById('calSearchInput'),
        calTagFilter: document.getElementById('calTagFilter'),
        calFilterToggle: document.getElementById('calFilterToggle'),
        calendarFilters: document.getElementById('calendarFilters'),

        // Toggle buttons
        toggleBtns: document.querySelectorAll('.toggle-btn'),

        // List controls
        searchInput: document.getElementById('searchInput'),
        sortField: document.getElementById('sortField'),
        sortOrderBtn: document.getElementById('sortOrderBtn'),
        sortOrderIcon: document.getElementById('sortOrderIcon'),
        contactsList: document.getElementById('contactsList'),
        groupBtns: document.querySelectorAll('.group-btn'),

        // Tag elements in overview modal
        contactTags: document.getElementById('contactTags'),
        newTagInput: document.getElementById('newTagInput'),
        tagSuggestions: document.getElementById('tagSuggestions'),
        addTagBtn: document.getElementById('addTagBtn'),

        // Contact modal
        contactModal: document.getElementById('contactModal'),
        modalTitle: document.getElementById('modalTitle'),
        contactForm: document.getElementById('contactForm'),
        contactId: document.getElementById('contactId'),
        addContactBtn: document.getElementById('addContactBtn'),
        closeModal: document.getElementById('closeModal'),
        cancelBtn: document.getElementById('cancelBtn'),
        deleteBtn: document.getElementById('deleteBtn'),
        saveBtn: document.getElementById('saveBtn'),
        expandToggle: document.getElementById('expandToggle'),
        expandableFields: document.getElementById('expandableFields'),

        // Delete modal
        deleteModal: document.getElementById('deleteModal'),
        deleteContactName: document.getElementById('deleteContactName'),
        closeDeleteModal: document.getElementById('closeDeleteModal'),
        cancelDeleteBtn: document.getElementById('cancelDeleteBtn'),
        confirmDeleteBtn: document.getElementById('confirmDeleteBtn'),

        // Overview modal
        overviewModal: document.getElementById('overviewModal'),
        overviewAvatar: document.getElementById('overviewAvatar'),
        overviewName: document.getElementById('overviewName'),
        overviewCompany: document.getElementById('overviewCompany'),
        overviewDetails: document.getElementById('overviewDetails'),
        contactProjects: document.getElementById('contactProjects'),
        notesTimeline: document.getElementById('notesTimeline'),
        newNoteContent: document.getElementById('newNoteContent'),
        addNoteBtn: document.getElementById('addNoteBtn'),
        closeOverviewModal: document.getElementById('closeOverviewModal'),
        closeOverviewBtn: document.getElementById('closeOverviewBtn'),
        editContactBtn: document.getElementById('editContactBtn'),

        // Company notes modal
        companyNotesModal: document.getElementById('companyNotesModal'),
        companyNotesTitle: document.getElementById('companyNotesTitle'),
        companyNotesTimeline: document.getElementById('companyNotesTimeline'),
        closeCompanyNotesModal: document.getElementById('closeCompanyNotesModal'),
        closeCompanyNotesBtn: document.getElementById('closeCompanyNotesBtn'),

        // Import/Export modal
        importExportBtn: document.getElementById('importExportBtn'),
        importExportModal: document.getElementById('importExportModal'),
        closeImportExportModal: document.getElementById('closeImportExportModal'),
        closeImportExportBtn: document.getElementById('closeImportExportBtn'),
        exportBtn: document.getElementById('exportBtn'),
        downloadTemplateBtn: document.getElementById('downloadTemplateBtn'),
        fileUploadArea: document.getElementById('fileUploadArea'),
        importFileInput: document.getElementById('importFileInput'),
        uploadFileInfo: document.getElementById('uploadFileInfo'),
        uploadFileName: document.getElementById('uploadFileName'),
        removeFileBtn: document.getElementById('removeFileBtn'),
        importBtn: document.getElementById('importBtn'),
        importResults: document.getElementById('importResults'),
        importProgress: document.getElementById('importProgress'),
        importSuccess: document.getElementById('importSuccess'),
        importSuccessText: document.getElementById('importSuccessText'),
        importErrors: document.getElementById('importErrors'),
        importErrorList: document.getElementById('importErrorList'),

        // Projects view
        projectsView: document.getElementById('projectsView'),
        projectsList: document.getElementById('projectsList'),
        searchProjectsInput: document.getElementById('searchProjectsInput'),
        projectSortField: document.getElementById('projectSortField'),
        projectSortOrderBtn: document.getElementById('projectSortOrderBtn'),
        projectSortOrderIcon: document.getElementById('projectSortOrderIcon'),
        addProjectBtn: document.getElementById('addProjectBtn'),

        // Project modal
        projectModal: document.getElementById('projectModal'),
        projectModalTitle: document.getElementById('projectModalTitle'),
        projectForm: document.getElementById('projectForm'),
        projectId: document.getElementById('projectId'),
        projectCompany: document.getElementById('projectCompany'),
        projectCompanySuggestions: document.getElementById('projectCompanySuggestions'),
        closeProjectModal: document.getElementById('closeProjectModal'),
        cancelProjectBtn: document.getElementById('cancelProjectBtn'),
        deleteProjectBtn: document.getElementById('deleteProjectBtn'),
        saveProjectBtn: document.getElementById('saveProjectBtn'),

        // Delete project modal
        deleteProjectModal: document.getElementById('deleteProjectModal'),
        deleteProjectName: document.getElementById('deleteProjectName'),
        closeDeleteProjectModal: document.getElementById('closeDeleteProjectModal'),
        cancelDeleteProjectBtn: document.getElementById('cancelDeleteProjectBtn'),
        confirmDeleteProjectBtn: document.getElementById('confirmDeleteProjectBtn'),

        // Project overview modal
        projectOverviewModal: document.getElementById('projectOverviewModal'),
        projectOverviewName: document.getElementById('projectOverviewName'),
        projectOverviewCompany: document.getElementById('projectOverviewCompany'),
        projectOverviewStartDate: document.getElementById('projectOverviewStartDate'),
        projectOverviewStage: document.getElementById('projectOverviewStage'),
        projectOverviewBudget: document.getElementById('projectOverviewBudget'),
        projectOverviewSuccessChance: document.getElementById('projectOverviewSuccessChance'),
        projectOverviewEstCompletion: document.getElementById('projectOverviewEstCompletion'),
        projectOverviewDescription: document.getElementById('projectOverviewDescription'),
        projectTags: document.getElementById('projectTags'),
        newProjectTagInput: document.getElementById('newProjectTagInput'),
        projectTagSuggestions: document.getElementById('projectTagSuggestions'),
        addProjectTagBtn: document.getElementById('addProjectTagBtn'),
        projectContacts: document.getElementById('projectContacts'),
        newProjectContactInput: document.getElementById('newProjectContactInput'),
        projectContactSuggestions: document.getElementById('projectContactSuggestions'),
        addProjectContactBtn: document.getElementById('addProjectContactBtn'),
        closeProjectOverviewModal: document.getElementById('closeProjectOverviewModal'),
        closeProjectOverviewBtn: document.getElementById('closeProjectOverviewBtn'),
        editProjectBtn: document.getElementById('editProjectBtn')
    };

    // ============================================
    // CSRF Token Helper
    // ============================================

    function getCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    // ============================================
    // API Functions
    // ============================================

    const api = {
        async getContacts(search = '', sort = 'name', order = 'ASC') {
            const params = new URLSearchParams({ search, sort, order });
            const response = await fetch(`api/contacts.php?${params}`);
            return response.json();
        },

        async getMapContacts() {
            const response = await fetch('api/contacts.php?action=map');
            return response.json();
        },

        async getContact(id) {
            const response = await fetch(`api/contacts.php?id=${id}`);
            return response.json();
        },

        async createContact(data) {
            const response = await fetch('api/contacts.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async updateContact(id, data) {
            const response = await fetch(`api/contacts.php?id=${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async deleteContact(id) {
            const response = await fetch(`api/contacts.php?id=${id}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': getCsrfToken() }
            });
            return response.json();
        },

        // Notes API
        async getNotes(contactId) {
            const response = await fetch(`api/notes.php?contact_id=${contactId}`);
            return response.json();
        },

        async getCompanyNotes(company) {
            const response = await fetch(`api/notes.php?company=${encodeURIComponent(company)}`);
            return response.json();
        },

        async createNote(contactId, content) {
            const response = await fetch('api/notes.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ contact_id: contactId, content })
            });
            return response.json();
        },

        async deleteNote(id) {
            const response = await fetch(`api/notes.php?id=${id}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': getCsrfToken() }
            });
            return response.json();
        },

        // Tags API
        async getAllTags() {
            const response = await fetch('api/tags.php');
            return response.json();
        },

        async getContactTags(contactId) {
            const response = await fetch(`api/tags.php?action=contact&contact_id=${contactId}`);
            return response.json();
        },

        async getTaggedContacts() {
            const response = await fetch('api/tags.php?action=grouped');
            return response.json();
        },

        async createTag(name, color = '#3b82f6') {
            const response = await fetch('api/tags.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ name, color })
            });
            return response.json();
        },

        async assignTag(contactId, tagId) {
            const response = await fetch('api/tags.php?action=assign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ contact_id: contactId, tag_id: tagId })
            });
            return response.json();
        },

        async unassignTag(contactId, tagId) {
            const response = await fetch('api/tags.php?action=unassign', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ contact_id: contactId, tag_id: tagId })
            });
            return response.json();
        },

        async updateTag(id, data) {
            const response = await fetch(`api/tags.php?id=${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async deleteTag(id) {
            const response = await fetch(`api/tags.php?id=${id}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': getCsrfToken() }
            });
            return response.json();
        },

        // Calendar API
        async getCalendarNotes(start, end, search = '', tagId = '') {
            const params = new URLSearchParams();
            if (start) params.set('start', start);
            if (end) params.set('end', end);
            if (search) params.set('search', search);
            if (tagId) params.set('tag_id', tagId);
            const response = await fetch(`api/calendar.php?${params}`);
            return response.json();
        },

        // Projects API
        async getProjects(search = '', sort = 'name', order = 'ASC') {
            const params = new URLSearchParams({ search, sort, order });
            const response = await fetch(`api/projects.php?${params}`);
            return response.json();
        },

        async getProject(id) {
            const response = await fetch(`api/projects.php?id=${id}`);
            return response.json();
        },

        async getProjectsByContact(contactId) {
            const response = await fetch(`api/projects.php?action=contact&contact_id=${contactId}`);
            return response.json();
        },

        async getProjectsByCompany(company) {
            const response = await fetch(`api/projects.php?action=company&company=${encodeURIComponent(company)}`);
            return response.json();
        },

        async getProjectContacts(projectId) {
            const response = await fetch(`api/projects.php?action=contacts&id=${projectId}`);
            return response.json();
        },

        async getProjectTags(projectId) {
            const response = await fetch(`api/projects.php?action=tags&id=${projectId}`);
            return response.json();
        },

        async createProject(data) {
            const response = await fetch('api/projects.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async updateProject(id, data) {
            const response = await fetch(`api/projects.php?id=${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async deleteProject(id) {
            const response = await fetch(`api/projects.php?id=${id}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': getCsrfToken() }
            });
            return response.json();
        },

        async assignProjectContact(projectId, contactId) {
            const response = await fetch('api/projects.php?action=assign-contact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ project_id: projectId, contact_id: contactId })
            });
            return response.json();
        },

        async unassignProjectContact(projectId, contactId) {
            const response = await fetch('api/projects.php?action=unassign-contact', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ project_id: projectId, contact_id: contactId })
            });
            return response.json();
        },

        async assignProjectTag(projectId, tagId) {
            const response = await fetch('api/projects.php?action=assign-tag', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ project_id: projectId, tag_id: tagId })
            });
            return response.json();
        },

        async unassignProjectTag(projectId, tagId) {
            const response = await fetch('api/projects.php?action=unassign-tag', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ project_id: projectId, tag_id: tagId })
            });
            return response.json();
        }
    };

    // ============================================
    // Map Functions
    // ============================================

    function initMap() {
        // Initialize the map centered on a world view
        // Explicitly enable all interaction options for mobile and desktop
        state.map = L.map(elements.mapContainer, {
            center: [30, 0],
            zoom: 2,
            zoomControl: true,
            attributionControl: false,
            scrollWheelZoom: true,
            doubleClickZoom: true,
            touchZoom: true,
            dragging: true,
            tap: true,
            boxZoom: true,
            keyboard: true
        });

        // Add dark CartoDB Dark Matter tile layer (no labels variant for cleaner look)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(state.map);

        // Add labels as a separate layer on top (so pins sit between base and labels)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd',
            maxZoom: 20,
            pane: 'shadowPane'
        }).addTo(state.map);

        // Add zoom control to bottom right for better mobile UX
        state.map.zoomControl.setPosition('bottomright');

        // Initialize marker cluster group with smooth zoom animation
        state.markers = L.markerClusterGroup({
            chunkedLoading: true,
            spiderfyOnMaxZoom: true,
            showCoverageOnHover: false,
            zoomToBoundsOnClick: false, // We'll handle this manually for smooth animation
            maxClusterRadius: 50,
            animate: true,
            animateAddingMarkers: true
        });

        // Handle cluster click with smooth zoom animation
        state.markers.on('clusterclick', function(event) {
            const cluster = event.layer;
            const bounds = cluster.getBounds();

            // Smoothly zoom to the cluster's bounds with animation
            state.map.fitBounds(bounds, {
                padding: [40, 40],
                animate: true,
                duration: 0.5
            });
        });

        state.map.addLayer(state.markers);

        // Load initial markers
        loadMapMarkers();
    }

    async function loadMapMarkers() {
        try {
            const result = await api.getMapContacts();

            if (result.success) {
                state.mapContacts = result.data;
                updateMapMarkers();
            }
        } catch (error) {
            console.error('Error loading map contacts:', error);
        }
    }

    function updateMapMarkers() {
        // Clear existing markers
        state.markers.clearLayers();

        // Add markers for each contact with coordinates
        state.mapContacts.forEach(contact => {
            if (contact.latitude && contact.longitude) {
                const marker = L.marker([contact.latitude, contact.longitude], { icon: customIcon });

                // Create popup content
                const popupContent = createPopupContent(contact);
                marker.bindPopup(popupContent);

                // Store contact ID on marker
                marker.contactId = contact.id;

                state.markers.addLayer(marker);
            }
        });

        // Fit map to markers if there are any
        if (state.mapContacts.length > 0) {
            const bounds = state.markers.getBounds();
            if (bounds.isValid()) {
                state.map.fitBounds(bounds, { padding: [50, 50] });
            }
        }
    }

    function createPopupContent(contact) {
        let html = `<div class="map-popup">`;
        html += `<h4>${escapeHtml(contact.name)}</h4>`;

        if (contact.company) {
            html += `<p class="popup-company">${escapeHtml(contact.company)}</p>`;
        }

        if (contact.location) {
            html += `<p class="popup-location">${escapeHtml(contact.location)}</p>`;
        }

        if (contact.note) {
            html += `<p class="popup-note">${escapeHtml(contact.note)}</p>`;
        }

        html += `<div class="popup-buttons">`;
        html += `<button class="popup-btn popup-details-btn" onclick="window.CRM.openOverview(${contact.id})">Details</button>`;
        html += `<button class="popup-btn popup-edit-btn" onclick="window.CRM.editContact(${contact.id})">Edit</button>`;
        html += `</div>`;
        html += `</div>`;

        return html;
    }

    // ============================================
    // List Functions
    // ============================================

    async function loadContacts() {
        try {
            if (state.groupBy === 'tags') {
                // Load tag-grouped contacts
                const result = await api.getTaggedContacts();
                if (result.success) {
                    state.taggedData = result.data;
                    renderContactsListByTags();
                }
            } else {
                // Load company-grouped contacts
                const result = await api.getContacts(
                    state.searchQuery,
                    state.sortField,
                    state.sortOrder
                );

                if (result.success) {
                    state.contacts = result.data;
                    renderContactsListByCompany();
                }
            }
        } catch (error) {
            console.error('Error loading contacts:', error);
            elements.contactsList.innerHTML = '<div class="error-message">Error loading contacts</div>';
        }
    }

    function renderContactsListByCompany() {
        if (state.contacts.length === 0) {
            elements.contactsList.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                    </svg>
                    <h3>Keine Kontakte gefunden</h3>
                    <p>${state.searchQuery ? 'Versuche einen anderen Suchbegriff' : 'Füge deinen ersten Kontakt hinzu'}</p>
                </div>
            `;
            return;
        }

        // Group contacts by company
        const grouped = groupContactsByCompany(state.contacts);
        let html = '';

        grouped.forEach(group => {
            if (group.company) {
                // Company group with header
                html += `<div class="company-group">`;
                html += `<div class="company-header" data-company="${escapeHtml(group.company)}" title="Klicken für Firmen-Notizen">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z"/>
                    </svg>
                    <span>${escapeHtml(group.company)}</span>
                    <span class="company-count">${group.contacts.length}</span>
                </div>`;
                html += group.contacts.map(contact => createContactCard(contact, true)).join('');
                html += `</div>`;
            } else {
                // Contacts without company (individual)
                html += group.contacts.map(contact => createContactCard(contact, false)).join('');
            }
        });

        elements.contactsList.innerHTML = html;
        addContactListEventHandlers();
    }

    /**
     * Sort an array of contacts client-side using state.sortField / state.sortOrder
     */
    function sortContacts(contacts) {
        const field = state.sortField;
        const desc = state.sortOrder === 'DESC';

        return contacts.slice().sort((a, b) => {
            const valA = (a[field] || '').toString().toLowerCase();
            const valB = (b[field] || '').toString().toLowerCase();
            let cmp = valA.localeCompare(valB);
            return desc ? -cmp : cmp;
        });
    }

    function contactMatchesSearch(contact, query) {
        if (!query) return true;
        const q = query.toLowerCase();
        return (contact.name || '').toLowerCase().includes(q)
            || (contact.company || '').toLowerCase().includes(q)
            || (contact.location || '').toLowerCase().includes(q)
            || (contact.email || '').toLowerCase().includes(q)
            || (contact.phone || '').toLowerCase().includes(q);
    }

    function renderContactsListByTags() {
        const data = state.taggedData;
        if (!data) return;

        const query = state.searchQuery;

        // Filter contacts within each tag group by search query
        // If the tag name itself matches, show all its contacts
        const q = query ? query.toLowerCase() : '';
        const filteredTags = data.tags.map(tag => {
            const tagNameMatches = q && tag.name.toLowerCase().includes(q);
            return {
                ...tag,
                contacts: tagNameMatches ? tag.contacts : tag.contacts.filter(c => contactMatchesSearch(c, query))
            };
        });
        const filteredUntagged = data.untagged.filter(c => contactMatchesSearch(c, query));

        const totalContacts = filteredTags.reduce((sum, t) => sum + t.contacts.length, 0) + filteredUntagged.length;

        if (totalContacts === 0) {
            elements.contactsList.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                    </svg>
                    <h3>Keine Kontakte gefunden</h3>
                    <p>${query ? 'Versuche einen anderen Suchbegriff' : 'Füge deinen ersten Kontakt hinzu'}</p>
                </div>
            `;
            return;
        }

        let html = '';

        // Render tagged groups, sorting contacts within each tag
        filteredTags.forEach(tag => {
            if (tag.contacts.length > 0) {
                const sorted = sortContacts(tag.contacts);
                html += `<div class="tag-group">`;
                html += `<div class="tag-header" style="border-left-color: ${tag.color}">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="${tag.color}">
                        <path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>
                    </svg>
                    <span>${escapeHtml(tag.name)}</span>
                    <span class="tag-count" style="background-color: ${tag.color}">${tag.contacts.length}</span>
                    <span class="tag-actions">
                        <button class="tag-action-btn tag-edit-btn" data-tag-id="${tag.id}" data-tag-name="${escapeHtml(tag.name)}" data-tag-color="${tag.color}" title="Tag bearbeiten">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 000-1.42l-2.34-2.33a1.003 1.003 0 00-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.83z"/></svg>
                        </button>
                        <button class="tag-action-btn tag-delete-btn" data-tag-id="${tag.id}" data-tag-name="${escapeHtml(tag.name)}" title="Tag l&ouml;schen">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                        </button>
                    </span>
                </div>`;
                html += sorted.map(contact => createContactCard(contact, true)).join('');
                html += `</div>`;
            }
        });

        // Render untagged contacts
        if (filteredUntagged.length > 0) {
            html += `<div class="tag-group untagged-group">`;
            html += `<div class="tag-header tag-header-untagged">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>
                </svg>
                <span>Ohne Tag</span>
                <span class="tag-count">${filteredUntagged.length}</span>
            </div>`;
            html += sortContacts(filteredUntagged).map(contact => createContactCard(contact, true)).join('');
            html += `</div>`;
        }

        elements.contactsList.innerHTML = html;
        addContactListEventHandlers();
    }

    function addContactListEventHandlers() {
        // Add click handlers to contact cards - open overview modal
        elements.contactsList.querySelectorAll('.contact-card').forEach(card => {
            card.addEventListener('click', () => {
                const id = parseInt(card.dataset.id, 10);
                openOverviewModal(id);
            });
        });

        // Add click handlers to company headers - open company notes modal
        elements.contactsList.querySelectorAll('.company-header').forEach(header => {
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                const company = header.dataset.company;
                openCompanyNotesModal(company);
            });
        });

        // Tag edit buttons
        elements.contactsList.querySelectorAll('.tag-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tagId = parseInt(btn.dataset.tagId, 10);
                const tagName = btn.dataset.tagName;
                const tagColor = btn.dataset.tagColor;
                openTagEditInline(btn.closest('.tag-header'), tagId, tagName, tagColor);
            });
        });

        // Tag delete buttons
        elements.contactsList.querySelectorAll('.tag-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tagId = parseInt(btn.dataset.tagId, 10);
                const tagName = btn.dataset.tagName;
                confirmDeleteTag(tagId, tagName);
            });
        });
    }

    /**
     * Group contacts by company
     * Returns array of { company: string|null, contacts: array }
     */
    function groupContactsByCompany(contacts) {
        const companyMap = new Map();
        const noCompany = [];

        contacts.forEach(contact => {
            const company = contact.company ? contact.company.trim() : '';

            if (company) {
                if (!companyMap.has(company)) {
                    companyMap.set(company, []);
                }
                companyMap.get(company).push(contact);
            } else {
                noCompany.push(contact);
            }
        });

        const groups = [];
        const field = state.sortField;
        const desc = state.sortOrder === 'DESC';

        // Sort company groups based on the active sort field & direction
        const companyKeys = Array.from(companyMap.keys());

        companyKeys.sort((a, b) => {
            const contactsA = companyMap.get(a);
            const contactsB = companyMap.get(b);

            let valA, valB;

            if (field === 'company') {
                valA = a.toLowerCase();
                valB = b.toLowerCase();
            } else {
                // Sort groups by the first contact's value for the chosen field
                valA = (contactsA[0][field] || '').toString().toLowerCase();
                valB = (contactsB[0][field] || '').toString().toLowerCase();
            }

            let cmp = valA.localeCompare(valB);
            return desc ? -cmp : cmp;
        });

        companyKeys.forEach(company => {
            groups.push({
                company: company,
                contacts: companyMap.get(company)
            });
        });

        // Add contacts without company
        if (noCompany.length > 0) {
            const ungrouped = {
                company: null,
                contacts: noCompany
            };
            // For DESC, put ungrouped first; for ASC, put at end
            if (desc) {
                groups.unshift(ungrouped);
            } else {
                groups.push(ungrouped);
            }
        }

        return groups;
    }

    function createContactCard(contact, inGroup = false) {
        // Show at most one secondary line: company (if not in group) or location
        let secondaryLine = '';
        if (!inGroup && contact.company) {
            secondaryLine = `<p class="contact-company">${escapeHtml(contact.company)}</p>`;
        } else if (contact.location) {
            secondaryLine = `<p class="contact-location">${escapeHtml(contact.location)}</p>`;
        }

        return `
            <div class="contact-card${inGroup ? ' in-group' : ''}" data-id="${contact.id}">
                <div class="contact-avatar">
                    ${getInitials(contact.name)}
                </div>
                <div class="contact-info">
                    <h3 class="contact-name">${escapeHtml(contact.name)}</h3>
                    ${secondaryLine}
                </div>
                <div class="contact-actions">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                        <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/>
                    </svg>
                </div>
            </div>
        `;
    }

    // ============================================
    // View Toggle Functions
    // ============================================

    function switchView(view) {
        state.currentView = view;

        // Update toggle buttons
        elements.toggleBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });

        // Update view panels
        elements.mapView.classList.toggle('active', view === 'map');
        elements.listView.classList.toggle('active', view === 'list');
        elements.calendarView.classList.toggle('active', view === 'calendar');
        elements.projectsView.classList.toggle('active', view === 'projects');

        // Refresh data for the active view
        if (view === 'map') {
            // Force map to recalculate size after becoming visible
            setTimeout(() => {
                state.map.invalidateSize();
            }, 100);
            loadMapMarkers();
        } else if (view === 'calendar') {
            loadCalendarNotes();
        } else if (view === 'projects') {
            loadProjects();
        } else {
            loadContacts();
        }
    }

    // ============================================
    // Modal Functions
    // ============================================

    function openContactModal(contact = null) {
        state.editingContactId = contact ? contact.id : null;

        // Reset form
        elements.contactForm.reset();
        elements.expandableFields.classList.remove('expanded');
        elements.expandToggle.querySelector('.expand-icon').style.transform = '';

        if (contact) {
            // Editing existing contact
            elements.modalTitle.textContent = 'Edit Contact';
            elements.deleteBtn.style.display = 'block';

            // Fill form fields
            elements.contactId.value = contact.id;
            document.getElementById('contactName').value = contact.name || '';
            document.getElementById('contactCompany').value = contact.company || '';
            document.getElementById('contactLocation').value = contact.location || '';
            document.getElementById('contactNote').value = contact.note || '';
            document.getElementById('contactEmail').value = contact.email || '';
            document.getElementById('contactPhone').value = contact.phone || '';
            document.getElementById('contactWebsite').value = contact.website || '';
            document.getElementById('contactAddress').value = contact.address || '';

            // Expand additional fields if any are filled
            if (contact.email || contact.phone || contact.website || contact.address) {
                elements.expandableFields.classList.add('expanded');
                elements.expandToggle.querySelector('.expand-icon').style.transform = 'rotate(45deg)';
            }
        } else {
            // Adding new contact
            elements.modalTitle.textContent = 'Add Contact';
            elements.deleteBtn.style.display = 'none';
            elements.contactId.value = '';
        }

        // Show modal
        elements.contactModal.classList.add('active');
        document.getElementById('contactName').focus();
    }

    function closeContactModal() {
        elements.contactModal.classList.remove('active');
        state.editingContactId = null;
    }

    function openDeleteModal() {
        const contact = state.contacts.find(c => c.id === state.editingContactId) ||
                       state.mapContacts.find(c => c.id === state.editingContactId);

        if (contact) {
            elements.deleteContactName.textContent = contact.name;
            elements.deleteModal.classList.add('active');
        }
    }

    function closeDeleteModal() {
        elements.deleteModal.classList.remove('active');
    }

    // ============================================
    // Overview Modal Functions
    // ============================================

    async function openOverviewModal(contactId) {
        try {
            const result = await api.getContact(contactId);

            if (!result.success) {
                alert('Error loading contact');
                return;
            }

            const contact = result.data;
            state.viewingContactId = contactId;
            state.viewingContact = contact;

            // Populate header
            elements.overviewAvatar.textContent = getInitials(contact.name);
            elements.overviewName.textContent = contact.name;
            elements.overviewCompany.textContent = contact.company || '';
            elements.overviewCompany.style.display = contact.company ? 'block' : 'none';

            // Populate details
            renderOverviewDetails(contact);

            // Load and render tags
            await loadContactTags(contactId);

            // Load and render notes
            await loadNotes(contactId);

            // Load and render related projects
            await loadContactProjects(contactId);

            // Show modal
            elements.overviewModal.classList.add('active');

        } catch (error) {
            console.error('Error opening overview:', error);
            alert('Error loading contact');
        }
    }

    function renderOverviewDetails(contact) {
        let html = '<div class="detail-grid">';

        if (contact.location) {
            const hasCoords = contact.latitude && contact.longitude;
            const geoWarning = !hasCoords ? `<span class="geocode-warning" title="Adresse konnte nicht auf der Karte gefunden werden">(!)</span>` : '';
            html += `
                <div class="detail-item">
                    <span class="detail-icon">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                        </svg>
                    </span>
                    <div class="detail-content">
                        <span class="detail-label">Location ${geoWarning}</span>
                        <span class="detail-value">${escapeHtml(contact.location)}</span>
                    </div>
                </div>
            `;
        }

        if (contact.email) {
            html += `
                <div class="detail-item">
                    <span class="detail-icon">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                        </svg>
                    </span>
                    <div class="detail-content">
                        <span class="detail-label">Email</span>
                        <a href="mailto:${escapeHtml(contact.email)}" class="detail-value detail-link">${escapeHtml(contact.email)}</a>
                    </div>
                </div>
            `;
        }

        if (contact.phone) {
            html += `
                <div class="detail-item">
                    <span class="detail-icon">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
                        </svg>
                    </span>
                    <div class="detail-content">
                        <span class="detail-label">Phone</span>
                        <a href="tel:${escapeHtml(contact.phone)}" class="detail-value detail-link">${escapeHtml(contact.phone)}</a>
                    </div>
                </div>
            `;
        }

        if (contact.website) {
            html += `
                <div class="detail-item">
                    <span class="detail-icon">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z"/>
                        </svg>
                    </span>
                    <div class="detail-content">
                        <span class="detail-label">Website</span>
                        <a href="${escapeHtml(normalizeUrl(contact.website))}" target="_blank" class="detail-value detail-link">${escapeHtml(contact.website)}</a>
                    </div>
                </div>
            `;
        }

        if (contact.address) {
            const hasCoords = contact.latitude && contact.longitude;
            const addressGeoWarning = (!hasCoords && !contact.location) ? `<span class="geocode-warning" title="Adresse konnte nicht auf der Karte gefunden werden">(!)</span>` : '';
            html += `
                <div class="detail-item detail-item-full">
                    <span class="detail-icon">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
                        </svg>
                    </span>
                    <div class="detail-content">
                        <span class="detail-label">Address ${addressGeoWarning}</span>
                        <span class="detail-value">${escapeHtml(contact.address).replace(/\n/g, '<br>')}</span>
                    </div>
                </div>
            `;
        }

        if (contact.note) {
            html += `
                <div class="detail-item detail-item-full">
                    <span class="detail-icon">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
                        </svg>
                    </span>
                    <div class="detail-content">
                        <span class="detail-label">Note</span>
                        <span class="detail-value">${escapeHtml(contact.note)}</span>
                    </div>
                </div>
            `;
        }

        html += '</div>';

        // Show empty state if no details
        if (!contact.location && !contact.email && !contact.phone && !contact.website && !contact.address && !contact.note) {
            html = '<p class="no-details">No contact details available</p>';
        }

        elements.overviewDetails.innerHTML = html;
    }

    async function loadNotes(contactId) {
        try {
            const result = await api.getNotes(contactId);

            if (result.success) {
                renderNotesTimeline(result.data);
            }
        } catch (error) {
            console.error('Error loading notes:', error);
        }
    }

    function renderNotesTimeline(notes) {
        if (!notes || notes.length === 0) {
            elements.notesTimeline.innerHTML = `
                <div class="notes-empty">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
                        <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
                    </svg>
                    <p>No notes yet</p>
                </div>
            `;
            return;
        }

        let html = '';

        notes.forEach(note => {
            const date = new Date(note.created_at);
            const formattedDate = formatDate(date);
            const isCompanyNote = note.source === 'company';
            const contactName = note.contact_name || '';

            html += `
                <div class="note-item ${isCompanyNote ? 'note-company' : ''}">
                    <div class="note-header">
                        <span class="note-date">${formattedDate}</span>
                        ${isCompanyNote ? `<span class="note-source">von ${escapeHtml(contactName)}</span>` : ''}
                        <button class="note-delete-btn" data-note-id="${note.id}" title="Delete note">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="note-content">${escapeHtml(note.content)}</div>
                </div>
            `;
        });

        elements.notesTimeline.innerHTML = html;

        // Add delete handlers
        elements.notesTimeline.querySelectorAll('.note-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const noteId = parseInt(btn.dataset.noteId, 10);
                await deleteNote(noteId);
            });
        });
    }

    function formatDate(date) {
        const now = new Date();
        const diff = now - date;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 7) {
            return date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
            });
        } else if (days > 0) {
            return days === 1 ? 'Yesterday' : `${days} days ago`;
        } else if (hours > 0) {
            return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
        } else if (minutes > 0) {
            return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
        } else {
            return 'Just now';
        }
    }

    async function addNote() {
        const content = elements.newNoteContent.value.trim();

        if (!content) {
            return;
        }

        if (!state.viewingContactId) {
            return;
        }

        elements.addNoteBtn.disabled = true;
        elements.addNoteBtn.innerHTML = 'Adding...';

        try {
            const result = await api.createNote(state.viewingContactId, content);

            if (result.success) {
                elements.newNoteContent.value = '';
                await loadNotes(state.viewingContactId);
            } else {
                alert(result.error || 'Error adding note');
            }
        } catch (error) {
            console.error('Error adding note:', error);
            alert('Error adding note');
        } finally {
            elements.addNoteBtn.disabled = false;
            elements.addNoteBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
                Add Note
            `;
        }
    }

    async function deleteNote(noteId) {
        if (!confirm('Delete this note?')) {
            return;
        }

        try {
            const result = await api.deleteNote(noteId);

            if (result.success) {
                await loadNotes(state.viewingContactId);
            } else {
                alert(result.error || 'Error deleting note');
            }
        } catch (error) {
            console.error('Error deleting note:', error);
            alert('Error deleting note');
        }
    }

    async function loadContactProjects(contactId) {
        try {
            const result = await api.getProjectsByContact(contactId);

            if (result.success) {
                renderContactProjects(result.data);
            }
        } catch (error) {
            console.error('Error loading contact projects:', error);
        }
    }

    function renderContactProjects(projects) {
        if (!projects || projects.length === 0) {
            elements.contactProjects.innerHTML = '<p class="empty-hint">No related projects</p>';
            return;
        }

        const html = projects.map(project => `
            <div class="project-mini-card" onclick="window.CRM.openProjectOverview(${project.id})">
                <div class="project-mini-header">
                    <h4 class="project-mini-name">${escapeHtml(project.name)}</h4>
                    <span class="project-stage-badge stage-${project.stage.toLowerCase().replace(' ', '-')}">${escapeHtml(project.stage)}</span>
                </div>
                ${project.company ? `<p class="project-mini-company">${escapeHtml(project.company)}</p>` : ''}
                <p class="project-mini-desc">${escapeHtml(project.description).substring(0, 100)}${project.description.length > 100 ? '...' : ''}</p>
            </div>
        `).join('');

        elements.contactProjects.innerHTML = html;
    }

    function closeOverviewModal() {
        elements.overviewModal.classList.remove('active');
        state.viewingContactId = null;
        state.viewingContact = null;
        elements.newNoteContent.value = '';
    }

    function openEditFromOverview() {
        if (state.viewingContact) {
            const contact = state.viewingContact;
            closeOverviewModal();
            openContactModal(contact);
        }
    }

    // ============================================
    // Tag Functions
    // ============================================

    async function loadAllTags() {
        try {
            const result = await api.getAllTags();
            if (result.success) {
                state.allTags = result.data;
            }
        } catch (error) {
            console.error('Error loading tags:', error);
        }
    }

    async function loadContactTags(contactId) {
        try {
            const result = await api.getContactTags(contactId);
            if (result.success) {
                renderContactTags(result.data);
            }
        } catch (error) {
            console.error('Error loading contact tags:', error);
        }
    }

    function renderContactTags(tags) {
        if (!tags || tags.length === 0) {
            elements.contactTags.innerHTML = '<span class="no-tags">Keine Tags</span>';
            return;
        }

        let html = '';
        tags.forEach(tag => {
            html += `
                <span class="tag" style="background-color: ${tag.color}20; color: ${tag.color}; border-color: ${tag.color}">
                    ${escapeHtml(tag.name)}
                    <button class="tag-remove" data-tag-id="${tag.id}" title="Tag entfernen">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </span>
            `;
        });

        elements.contactTags.innerHTML = html;

        // Add remove handlers
        elements.contactTags.querySelectorAll('.tag-remove').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const tagId = parseInt(btn.dataset.tagId, 10);
                await removeTagFromContact(tagId);
            });
        });
    }

    async function removeTagFromContact(tagId) {
        if (!state.viewingContactId) return;

        try {
            const result = await api.unassignTag(state.viewingContactId, tagId);
            if (result.success) {
                await loadContactTags(state.viewingContactId);
            }
        } catch (error) {
            console.error('Error removing tag:', error);
        }
    }

    function showTagSuggestions(query) {
        const filtered = state.allTags.filter(tag =>
            tag.name.toLowerCase().includes(query.toLowerCase())
        );

        let html = '';

        // Show matching existing tags
        filtered.forEach(tag => {
            html += `
                <div class="tag-suggestion" data-tag-id="${tag.id}">
                    <span class="tag-dot" style="background-color: ${tag.color}"></span>
                    ${escapeHtml(tag.name)}
                </div>
            `;
        });

        // Show create option if query doesn't match exactly
        if (query && !state.allTags.some(t => t.name.toLowerCase() === query.toLowerCase())) {
            html += `
                <div class="tag-suggestion tag-create" data-create="true">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                    </svg>
                    Neuer Tag: "${escapeHtml(query)}"
                </div>
            `;
        }

        elements.tagSuggestions.innerHTML = html;
        elements.tagSuggestions.classList.toggle('visible', html.length > 0);

        // Add click handlers
        elements.tagSuggestions.querySelectorAll('.tag-suggestion').forEach(item => {
            item.addEventListener('click', async () => {
                if (item.dataset.create) {
                    await createAndAssignTag(query);
                } else {
                    const tagId = parseInt(item.dataset.tagId, 10);
                    await assignTagToContact(tagId);
                }
            });
        });
    }

    async function createAndAssignTag(name) {
        if (!state.viewingContactId || !name.trim()) return;

        try {
            // Create the tag
            const createResult = await api.createTag(name.trim());
            if (createResult.success) {
                const tag = createResult.data;
                // Assign to contact
                await api.assignTag(state.viewingContactId, tag.id);
                // Refresh
                await loadAllTags();
                populateCalendarTagFilter();
                await loadContactTags(state.viewingContactId);
                elements.newTagInput.value = '';
                elements.tagSuggestions.classList.remove('visible');
            }
        } catch (error) {
            console.error('Error creating tag:', error);
        }
    }

    async function assignTagToContact(tagId) {
        if (!state.viewingContactId) return;

        try {
            const result = await api.assignTag(state.viewingContactId, tagId);
            if (result.success) {
                await loadContactTags(state.viewingContactId);
                elements.newTagInput.value = '';
                elements.tagSuggestions.classList.remove('visible');
            }
        } catch (error) {
            console.error('Error assigning tag:', error);
        }
    }

    // ============================================
    // Tag Edit / Delete Functions
    // ============================================

    function openTagEditInline(headerEl, tagId, tagName, tagColor) {
        // Prevent double-opening
        if (headerEl.querySelector('.tag-edit-form')) return;

        const originalHTML = headerEl.innerHTML;

        headerEl.innerHTML = `
            <form class="tag-edit-form" data-tag-id="${tagId}">
                <input type="color" class="tag-edit-color" value="${tagColor}" title="Farbe">
                <input type="text" class="tag-edit-name" value="${escapeHtml(tagName)}" maxlength="100" required placeholder="Tag-Name">
                <button type="submit" class="tag-edit-save" title="Speichern">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                </button>
                <button type="button" class="tag-edit-cancel" title="Abbrechen">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
            </form>
        `;

        const form = headerEl.querySelector('.tag-edit-form');
        const nameInput = headerEl.querySelector('.tag-edit-name');
        nameInput.focus();
        nameInput.select();

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newName = nameInput.value.trim();
            const newColor = headerEl.querySelector('.tag-edit-color').value;
            if (!newName) return;

            try {
                const result = await api.updateTag(tagId, { name: newName, color: newColor });
                if (result.success) {
                    await loadAllTags();
                    populateCalendarTagFilter();
                    await loadContactsList();
                }
            } catch (error) {
                console.error('Error updating tag:', error);
                headerEl.innerHTML = originalHTML;
            }
        });

        headerEl.querySelector('.tag-edit-cancel').addEventListener('click', () => {
            headerEl.innerHTML = originalHTML;
            addContactListEventHandlers();
        });
    }

    async function confirmDeleteTag(tagId, tagName) {
        if (!confirm(`Tag "${tagName}" wirklich l\u00f6schen?\n\nDer Tag wird von allen Kontakten entfernt.`)) {
            return;
        }

        try {
            const result = await api.deleteTag(tagId);
            if (result.success) {
                await loadAllTags();
                populateCalendarTagFilter();
                await loadContactsList();
            }
        } catch (error) {
            console.error('Error deleting tag:', error);
        }
    }

    // ============================================
    // Company Notes Modal Functions
    // ============================================

    async function openCompanyNotesModal(company) {
        try {
            elements.companyNotesTitle.textContent = company;

            // Show loading state
            elements.companyNotesTimeline.innerHTML = `
                <div class="notes-empty">
                    <p>Loading notes...</p>
                </div>
            `;

            // Show modal
            elements.companyNotesModal.classList.add('active');

            // Load notes
            const result = await api.getCompanyNotes(company);

            if (result.success) {
                renderCompanyNotesTimeline(result.data);
            } else {
                elements.companyNotesTimeline.innerHTML = `
                    <div class="notes-empty">
                        <p>Error loading notes</p>
                    </div>
                `;
            }
        } catch (error) {
            console.error('Error loading company notes:', error);
            elements.companyNotesTimeline.innerHTML = `
                <div class="notes-empty">
                    <p>Error loading notes</p>
                </div>
            `;
        }
    }

    function renderCompanyNotesTimeline(notes) {
        if (!notes || notes.length === 0) {
            elements.companyNotesTimeline.innerHTML = `
                <div class="notes-empty">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
                        <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
                    </svg>
                    <p>No notes yet for this company</p>
                </div>
            `;
            return;
        }

        let html = '';

        notes.forEach(note => {
            const date = new Date(note.created_at);
            const formattedDate = formatDate(date);
            const contactName = note.contact_name || 'Unknown';

            html += `
                <div class="note-item">
                    <div class="note-header">
                        <span class="note-date">${formattedDate}</span>
                        <span class="note-source">von ${escapeHtml(contactName)}</span>
                    </div>
                    <div class="note-content">${escapeHtml(note.content)}</div>
                </div>
            `;
        });

        elements.companyNotesTimeline.innerHTML = html;
    }

    function closeCompanyNotesModal() {
        elements.companyNotesModal.classList.remove('active');
    }

    // ============================================
    // Import/Export Functions
    // ============================================

    function openImportExportModal() {
        // Reset the modal state
        resetImportState();
        elements.importExportModal.classList.add('active');
    }

    function closeImportExportModal() {
        elements.importExportModal.classList.remove('active');
        resetImportState();
    }

    function resetImportState() {
        state.selectedImportFile = null;
        elements.importFileInput.value = '';
        elements.fileUploadArea.querySelector('.upload-content').style.display = 'flex';
        elements.uploadFileInfo.style.display = 'none';
        elements.importBtn.disabled = true;
        elements.importResults.style.display = 'none';
        elements.importProgress.style.display = 'none';
        elements.importSuccess.style.display = 'none';
        elements.importErrors.style.display = 'none';
        elements.fileUploadArea.classList.remove('drag-over', 'has-file');
    }

    function handleFileSelect(file) {
        if (!file) return;

        const validExtensions = ['.xlsx', '.xls'];
        const fileName = file.name.toLowerCase();
        const isValid = validExtensions.some(ext => fileName.endsWith(ext));

        if (!isValid) {
            alert('Please select an Excel file (.xlsx or .xls)');
            return;
        }

        state.selectedImportFile = file;
        elements.uploadFileName.textContent = file.name;
        elements.fileUploadArea.querySelector('.upload-content').style.display = 'none';
        elements.uploadFileInfo.style.display = 'flex';
        elements.fileUploadArea.classList.add('has-file');
        elements.importBtn.disabled = false;
    }

    function removeSelectedFile() {
        state.selectedImportFile = null;
        elements.importFileInput.value = '';
        elements.fileUploadArea.querySelector('.upload-content').style.display = 'flex';
        elements.uploadFileInfo.style.display = 'none';
        elements.fileUploadArea.classList.remove('has-file');
        elements.importBtn.disabled = true;
    }

    async function exportContacts() {
        elements.exportBtn.disabled = true;
        elements.exportBtn.innerHTML = `
            <div class="spinner-small"></div>
            Exporting...
        `;

        try {
            // Trigger download by navigating to the export endpoint
            window.location.href = 'api/import-export.php?action=export';
        } catch (error) {
            console.error('Error exporting contacts:', error);
            alert('Error exporting contacts');
        } finally {
            // Reset button after a short delay
            setTimeout(() => {
                elements.exportBtn.disabled = false;
                elements.exportBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                    </svg>
                    Export All Contacts
                `;
            }, 1000);
        }
    }

    function downloadTemplate() {
        window.location.href = 'api/import-export.php?action=template';
    }

    async function importContacts() {
        if (!state.selectedImportFile) {
            alert('Please select a file first');
            return;
        }

        // Show progress
        elements.importResults.style.display = 'block';
        elements.importProgress.style.display = 'flex';
        elements.importSuccess.style.display = 'none';
        elements.importErrors.style.display = 'none';
        elements.importBtn.disabled = true;

        const formData = new FormData();
        formData.append('file', state.selectedImportFile);

        try {
            const response = await fetch('api/import-export.php?action=import', {
                method: 'POST',
                headers: { 'X-CSRF-Token': getCsrfToken() },
                body: formData
            });

            const result = await response.json();

            elements.importProgress.style.display = 'none';

            if (result.success) {
                elements.importSuccess.style.display = 'flex';
                elements.importSuccessText.textContent = `Successfully imported ${result.imported} of ${result.total_rows} contacts`;

                // Show errors if any
                if (result.errors && result.errors.length > 0) {
                    elements.importErrors.style.display = 'block';
                    elements.importErrorList.innerHTML = result.errors
                        .map(err => `<li>Row ${err.row}: ${escapeHtml(err.error)}</li>`)
                        .join('');
                }

                // Refresh data
                refreshData();
                updateContactCount();
            } else {
                elements.importErrors.style.display = 'block';
                elements.importErrorList.innerHTML = `<li>${escapeHtml(result.error)}</li>`;
            }

        } catch (error) {
            console.error('Error importing contacts:', error);
            elements.importProgress.style.display = 'none';
            elements.importErrors.style.display = 'block';
            elements.importErrorList.innerHTML = '<li>Error uploading file. Please try again.</li>';
        } finally {
            elements.importBtn.disabled = false;
        }
    }

    function initImportExportEvents() {
        // Open modal
        elements.importExportBtn.addEventListener('click', openImportExportModal);

        // Close modal
        elements.closeImportExportModal.addEventListener('click', closeImportExportModal);
        elements.closeImportExportBtn.addEventListener('click', closeImportExportModal);
        elements.importExportModal.querySelector('.modal-backdrop').addEventListener('click', closeImportExportModal);

        // Export button
        elements.exportBtn.addEventListener('click', exportContacts);

        // Download template
        elements.downloadTemplateBtn.addEventListener('click', downloadTemplate);

        // File input change
        elements.importFileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFileSelect(e.target.files[0]);
            }
        });

        // Click on upload area to browse
        elements.fileUploadArea.addEventListener('click', (e) => {
            if (!elements.uploadFileInfo.contains(e.target)) {
                elements.importFileInput.click();
            }
        });

        // Drag and drop
        elements.fileUploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            elements.fileUploadArea.classList.add('drag-over');
        });

        elements.fileUploadArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            elements.fileUploadArea.classList.remove('drag-over');
        });

        elements.fileUploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            elements.fileUploadArea.classList.remove('drag-over');

            if (e.dataTransfer.files.length > 0) {
                handleFileSelect(e.dataTransfer.files[0]);
            }
        });

        // Remove file button
        elements.removeFileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeSelectedFile();
        });

        // Import button
        elements.importBtn.addEventListener('click', importContacts);
    }

    // ============================================
    // Contact CRUD Functions
    // ============================================

    async function editContact(id) {
        try {
            const result = await api.getContact(id);

            if (result.success) {
                openContactModal(result.data);
            } else {
                alert('Error loading contact');
            }
        } catch (error) {
            console.error('Error loading contact:', error);
            alert('Error loading contact');
        }
    }

    async function saveContact(event) {
        event.preventDefault();

        const formData = {
            name: document.getElementById('contactName').value.trim(),
            company: document.getElementById('contactCompany').value.trim(),
            location: document.getElementById('contactLocation').value.trim(),
            note: document.getElementById('contactNote').value.trim(),
            email: document.getElementById('contactEmail').value.trim(),
            phone: document.getElementById('contactPhone').value.trim(),
            website: document.getElementById('contactWebsite').value.trim(),
            address: document.getElementById('contactAddress').value.trim()
        };

        if (!formData.name) {
            alert('Name is required');
            return;
        }

        // Show loading state
        elements.saveBtn.disabled = true;
        elements.saveBtn.textContent = 'Saving...';

        try {
            let result;

            if (state.editingContactId) {
                result = await api.updateContact(state.editingContactId, formData);
            } else {
                result = await api.createContact(formData);
            }

            if (result.success) {
                closeContactModal();
                refreshData();
                updateContactCount();
            } else {
                alert(result.error || 'Error saving contact');
            }
        } catch (error) {
            console.error('Error saving contact:', error);
            alert('Error saving contact');
        } finally {
            elements.saveBtn.disabled = false;
            elements.saveBtn.textContent = 'Save Contact';
        }
    }

    async function deleteContact() {
        if (!state.editingContactId) return;

        elements.confirmDeleteBtn.disabled = true;
        elements.confirmDeleteBtn.textContent = 'Deleting...';

        try {
            const result = await api.deleteContact(state.editingContactId);

            if (result.success) {
                closeDeleteModal();
                closeContactModal();
                refreshData();
                updateContactCount();
            } else {
                alert(result.error || 'Error deleting contact');
            }
        } catch (error) {
            console.error('Error deleting contact:', error);
            alert('Error deleting contact');
        } finally {
            elements.confirmDeleteBtn.disabled = false;
            elements.confirmDeleteBtn.textContent = 'Delete';
        }
    }

    // ============================================
    // Calendar Functions
    // ============================================

    function getCalendarDateRange() {
        const d = state.calendarDate;
        const mode = state.calendarMode;
        let start, end;

        if (mode === 'month') {
            start = new Date(d.getFullYear(), d.getMonth(), 1);
            // Include days from previous month that appear in the grid
            const dayOfWeek = start.getDay();
            const offset = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Monday start
            start = new Date(start);
            start.setDate(start.getDate() - offset);

            end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
            const endDow = end.getDay();
            const endOffset = endDow === 0 ? 0 : 7 - endDow;
            end = new Date(end);
            end.setDate(end.getDate() + endOffset);
            end.setHours(23, 59, 59);
        } else if (mode === 'week') {
            start = new Date(d);
            const dow = start.getDay();
            const mondayOffset = dow === 0 ? -6 : 1 - dow;
            start.setDate(start.getDate() + mondayOffset);
            start.setHours(0, 0, 0, 0);
            end = new Date(start);
            end.setDate(end.getDate() + 6);
            end.setHours(23, 59, 59);
        } else {
            start = new Date(d);
            start.setHours(0, 0, 0, 0);
            end = new Date(d);
            end.setHours(23, 59, 59);
        }

        // Format using local time (not UTC) to avoid timezone offset shifting dates
        function toLocalDatetime(dt) {
            const y = dt.getFullYear();
            const m = String(dt.getMonth() + 1).padStart(2, '0');
            const d = String(dt.getDate()).padStart(2, '0');
            const h = String(dt.getHours()).padStart(2, '0');
            const min = String(dt.getMinutes()).padStart(2, '0');
            const s = String(dt.getSeconds()).padStart(2, '0');
            return `${y}-${m}-${d} ${h}:${min}:${s}`;
        }

        return {
            start: toLocalDatetime(start),
            end: toLocalDatetime(end),
            startDate: start,
            endDate: end
        };
    }

    async function loadCalendarNotes() {
        const range = getCalendarDateRange();
        try {
            const result = await api.getCalendarNotes(
                range.start,
                range.end,
                state.calendarSearch,
                state.calendarTagFilter
            );
            if (result.success) {
                state.calendarNotes = result.data;
                renderCalendar();
            }
        } catch (error) {
            console.error('Error loading calendar notes:', error);
        }
    }

    function renderCalendar() {
        updateCalendarTitle();
        if (state.calendarMode === 'month') {
            renderMonthView();
        } else if (state.calendarMode === 'week') {
            renderWeekView();
        } else {
            renderDayView();
        }
    }

    function updateCalendarTitle() {
        const d = state.calendarDate;
        const months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
                        'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
        const weekdays = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

        if (state.calendarMode === 'month') {
            elements.calTitle.textContent = `${months[d.getMonth()]} ${d.getFullYear()}`;
        } else if (state.calendarMode === 'week') {
            const range = getCalendarDateRange();
            const s = range.startDate;
            const e = range.endDate;
            const sStr = `${s.getDate()}. ${months[s.getMonth()].substring(0, 3)}`;
            const eStr = `${e.getDate()}. ${months[e.getMonth()].substring(0, 3)} ${e.getFullYear()}`;
            elements.calTitle.textContent = `${sStr} – ${eStr}`;
        } else {
            elements.calTitle.textContent = `${weekdays[d.getDay()]}, ${d.getDate()}. ${months[d.getMonth()]} ${d.getFullYear()}`;
        }
    }

    function toLocalDateKey(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function groupNotesByDate(notes) {
        const grouped = {};
        notes.forEach(note => {
            // Parse the created_at string as local time and format as local date key
            const dateKey = note.created_at.substring(0, 10); // YYYY-MM-DD from DB
            if (!grouped[dateKey]) grouped[dateKey] = [];
            grouped[dateKey].push(note);
        });
        return grouped;
    }

    function renderNoteChip(note) {
        const name = escapeHtml(note.contact_name || '');
        const company = note.contact_company ? escapeHtml(note.contact_company) : '';
        const content = escapeHtml(note.content.length > 60 ? note.content.substring(0, 60) + '...' : note.content);
        const tagDots = note.tags.map(t =>
            `<span class="cal-tag-dot" style="background:${t.color}" title="${escapeHtml(t.name)}"></span>`
        ).join('');

        return `<div class="cal-note-chip" data-contact-id="${note.contact_id}">
            <div class="cal-note-chip-header">
                <span class="cal-note-person">${name}</span>
                ${company ? `<span class="cal-note-company">${company}</span>` : ''}
                ${tagDots ? `<span class="cal-note-tags">${tagDots}</span>` : ''}
            </div>
            <div class="cal-note-text">${content}</div>
        </div>`;
    }

    function renderMonthView() {
        const d = state.calendarDate;
        const today = new Date();
        const currentMonth = d.getMonth();
        const range = getCalendarDateRange();
        const notesByDate = groupNotesByDate(state.calendarNotes);

        const dayLabels = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
        let html = '<div class="cal-month-grid">';

        // Header row
        html += '<div class="cal-month-header">';
        dayLabels.forEach(label => {
            html += `<div class="cal-month-header-cell">${label}</div>`;
        });
        html += '</div>';

        // Day cells
        html += '<div class="cal-month-body">';
        const cursor = new Date(range.startDate);
        while (cursor <= range.endDate) {
            const dateKey = toLocalDateKey(cursor);
            const isToday = cursor.toDateString() === today.toDateString();
            const isOtherMonth = cursor.getMonth() !== currentMonth;
            const dayNotes = notesByDate[dateKey] || [];

            html += `<div class="cal-month-cell${isToday ? ' cal-today' : ''}${isOtherMonth ? ' cal-other-month' : ''}" data-date="${dateKey}">`;
            html += `<div class="cal-month-day-num">${cursor.getDate()}</div>`;
            if (dayNotes.length > 0) {
                html += '<div class="cal-month-notes">';
                const maxShow = 3;
                dayNotes.slice(0, maxShow).forEach(note => {
                    const name = escapeHtml(note.contact_name || '');
                    const tagDot = note.tags.length > 0
                        ? `<span class="cal-tag-dot-sm" style="background:${note.tags[0].color}"></span>`
                        : '';
                    html += `<div class="cal-month-note-dot" data-contact-id="${note.contact_id}" title="${escapeHtml(note.content)}">
                        ${tagDot}<span class="cal-month-note-label">${name}</span>
                    </div>`;
                });
                if (dayNotes.length > maxShow) {
                    html += `<div class="cal-month-more">+${dayNotes.length - maxShow} weitere</div>`;
                }
                html += '</div>';
            }
            html += '</div>';
            cursor.setDate(cursor.getDate() + 1);
        }
        html += '</div></div>';

        elements.calendarBody.innerHTML = html;
        addCalendarClickHandlers();
    }

    function renderWeekView() {
        const range = getCalendarDateRange();
        const today = new Date();
        const notesByDate = groupNotesByDate(state.calendarNotes);
        const dayNames = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
        const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

        let html = '<div class="cal-week-grid">';

        const cursor = new Date(range.startDate);
        for (let i = 0; i < 7; i++) {
            const dateKey = toLocalDateKey(cursor);
            const isToday = cursor.toDateString() === today.toDateString();
            const dayNotes = notesByDate[dateKey] || [];

            html += `<div class="cal-week-day${isToday ? ' cal-today' : ''}" data-date="${dateKey}">`;
            html += `<div class="cal-week-day-header">
                <span class="cal-week-day-name">${dayNames[i]}</span>
                <span class="cal-week-day-date">${cursor.getDate()}. ${months[cursor.getMonth()]}</span>
                ${dayNotes.length > 0 ? `<span class="cal-week-day-count">${dayNotes.length}</span>` : ''}
            </div>`;
            html += '<div class="cal-week-day-body">';
            dayNotes.forEach(note => {
                html += renderNoteChip(note);
            });
            if (dayNotes.length === 0) {
                html += '<div class="cal-week-empty">Keine Notizen</div>';
            }
            html += '</div></div>';
            cursor.setDate(cursor.getDate() + 1);
        }

        html += '</div>';
        elements.calendarBody.innerHTML = html;
        addCalendarClickHandlers();
    }

    function renderDayView() {
        const d = state.calendarDate;
        const dateKey = toLocalDateKey(d);
        const notesByDate = groupNotesByDate(state.calendarNotes);
        const dayNotes = notesByDate[dateKey] || [];

        let html = '<div class="cal-day-view">';

        if (dayNotes.length === 0) {
            html += `<div class="cal-day-empty">
                <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor">
                    <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/>
                </svg>
                <p>Keine Notizen an diesem Tag</p>
            </div>`;
        } else {
            dayNotes.forEach(note => {
                const time = note.created_at.substring(11, 16);
                const name = escapeHtml(note.contact_name || '');
                const company = note.contact_company ? escapeHtml(note.contact_company) : '';
                const content = escapeHtml(note.content);
                const tagBadges = note.tags.map(t =>
                    `<span class="cal-day-tag" style="background:${t.color}20;color:${t.color};border-color:${t.color}">${escapeHtml(t.name)}</span>`
                ).join('');

                html += `<div class="cal-day-note" data-contact-id="${note.contact_id}">
                    <div class="cal-day-note-time">${time}</div>
                    <div class="cal-day-note-body">
                        <div class="cal-day-note-meta">
                            <span class="cal-day-note-name">${name}</span>
                            ${company ? `<span class="cal-day-note-company">${company}</span>` : ''}
                            ${tagBadges ? `<div class="cal-day-note-tags">${tagBadges}</div>` : ''}
                        </div>
                        <div class="cal-day-note-content">${content}</div>
                    </div>
                </div>`;
            });
        }

        html += '</div>';
        elements.calendarBody.innerHTML = html;
        addCalendarClickHandlers();
    }

    function addCalendarClickHandlers() {
        // Click on note chips -> open contact overview
        elements.calendarBody.querySelectorAll('[data-contact-id]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const contactId = parseInt(el.dataset.contactId, 10);
                if (contactId) openOverviewModal(contactId);
            });
        });

        // Click on day cells in month view -> switch to day view
        if (state.calendarMode === 'month') {
            elements.calendarBody.querySelectorAll('.cal-month-cell').forEach(cell => {
                cell.addEventListener('click', (e) => {
                    if (e.target.closest('[data-contact-id]')) return;
                    const dateStr = cell.dataset.date;
                    if (dateStr) {
                        state.calendarDate = new Date(dateStr + 'T12:00:00');
                        state.calendarMode = 'day';
                        elements.calModeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === 'day'));
                        loadCalendarNotes();
                    }
                });
            });
        }
    }

    function navigateCalendar(direction) {
        const d = state.calendarDate;
        if (state.calendarMode === 'month') {
            d.setMonth(d.getMonth() + direction);
        } else if (state.calendarMode === 'week') {
            d.setDate(d.getDate() + (direction * 7));
        } else {
            d.setDate(d.getDate() + direction);
        }
        state.calendarDate = new Date(d);
        loadCalendarNotes();
    }

    function populateCalendarTagFilter() {
        const select = elements.calTagFilter;
        // Keep the first "all" option
        while (select.options.length > 1) {
            select.remove(1);
        }
        state.allTags.forEach(tag => {
            const opt = document.createElement('option');
            opt.value = tag.id;
            opt.textContent = tag.name;
            select.appendChild(opt);
        });
    }

    function initCalendarEvents() {
        elements.calPrev.addEventListener('click', () => navigateCalendar(-1));
        elements.calNext.addEventListener('click', () => navigateCalendar(1));
        elements.calToday.addEventListener('click', () => {
            state.calendarDate = new Date();
            loadCalendarNotes();
        });

        elements.calModeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                state.calendarMode = btn.dataset.mode;
                elements.calModeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === state.calendarMode));
                loadCalendarNotes();
            });
        });

        const debouncedCalSearch = debounce(() => {
            state.calendarSearch = elements.calSearchInput.value.trim();
            loadCalendarNotes();
        }, 300);
        elements.calSearchInput.addEventListener('input', debouncedCalSearch);

        elements.calTagFilter.addEventListener('change', () => {
            state.calendarTagFilter = elements.calTagFilter.value;
            loadCalendarNotes();
        });

        // Mobile filter toggle
        elements.calFilterToggle.addEventListener('click', () => {
            elements.calendarFilters.classList.toggle('filters-open');
            elements.calFilterToggle.classList.toggle('active');
        });
    }

    // ============================================
    // Project Functions
    // ============================================

    async function loadProjects() {
        try {
            const result = await api.getProjects(
                state.projectSearchQuery,
                state.projectSortField,
                state.projectSortOrder
            );

            if (result.success) {
                state.projects = result.data;
                renderProjects(state.projects);
            } else {
                console.error('Failed to load projects:', result.error);
            }
        } catch (error) {
            console.error('Error loading projects:', error);
        }
    }

    function renderProjects(projects) {
        if (!projects || projects.length === 0) {
            elements.projectsList.innerHTML = '<div class="empty-state">No projects found</div>';
            return;
        }

        const html = projects.map(project => createProjectCard(project)).join('');
        elements.projectsList.innerHTML = html;

        // Add click event listeners to project cards
        elements.projectsList.querySelectorAll('.project-card').forEach(card => {
            card.addEventListener('click', () => {
                const projectId = parseInt(card.dataset.id, 10);
                openProjectOverview(projectId);
            });
        });
    }

    function createProjectCard(project) {
        // Format date as absolute date (e.g., "Jan 15, 2024")
        const startDate = project.start_date ? new Date(project.start_date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }) : 'N/A';

        const budget = project.budget_min && project.budget_max
            ? `$${parseFloat(project.budget_min).toFixed(0)} - $${parseFloat(project.budget_max).toFixed(0)}`
            : project.budget_min
            ? `$${parseFloat(project.budget_min).toFixed(0)}`
            : 'N/A';
        const successChance = project.success_chance ? `${project.success_chance}%` : 'N/A';

        return `
            <div class="project-card" data-id="${project.id}">
                <div class="project-card-header">
                    <div class="contact-info">
                        <h3 class="contact-name">${escapeHtml(project.name)}</h3>
                        ${project.company ? `<p class="contact-company">${escapeHtml(project.company)}</p>` : ''}
                    </div>
                    <span class="project-stage-badge stage-${project.stage.toLowerCase().replace(/ /g, '-')}">${escapeHtml(project.stage)}</span>
                </div>
                <div class="project-details">
                    <div class="detail-item">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/>
                        </svg>
                        <span>${startDate}</span>
                    </div>
                    <div class="detail-item">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>
                        </svg>
                        <span>${budget}</span>
                    </div>
                    <div class="detail-item">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                        </svg>
                        <span>${successChance} chance</span>
                    </div>
                </div>
                <p class="contact-note">${escapeHtml(project.description).substring(0, 150)}${project.description.length > 150 ? '...' : ''}</p>
            </div>
        `;
    }

    function openProjectModal(project = null) {
        // Debug logging
        console.log('openProjectModal called with project:', project);

        state.editingProjectId = project && project.id ? project.id : null;
        console.log('state.editingProjectId set to:', state.editingProjectId);

        // Reset form
        elements.projectForm.reset();

        if (project && project.id) {
            // Editing existing project
            elements.projectModalTitle.textContent = 'Edit Project';
            elements.deleteProjectBtn.style.display = 'block';

            // Fill form fields
            elements.projectId.value = project.id;
            document.getElementById('projectName').value = project.name || '';
            document.getElementById('projectStartDate').value = project.start_date || '';
            document.getElementById('projectDescription').value = project.description || '';
            document.getElementById('projectCompany').value = project.company || '';
            document.getElementById('projectBudgetMin').value = project.budget_min || '';
            document.getElementById('projectBudgetMax').value = project.budget_max || '';
            document.getElementById('projectSuccessChance').value = project.success_chance || '';
            document.getElementById('projectStage').value = project.stage || 'Lead';
            document.getElementById('projectEstimatedCompletion').value = project.estimated_completion || '';
        } else {
            // Adding new project
            elements.projectModalTitle.textContent = 'Add Project';
            elements.deleteProjectBtn.style.display = 'none';
            // Set default start date to today
            document.getElementById('projectStartDate').value = new Date().toISOString().split('T')[0];
        }

        elements.projectModal.classList.add('active');
    }

    function closeProjectModal() {
        elements.projectModal.classList.remove('active');
        state.editingProjectId = null;
    }

    async function saveProject(e) {
        e.preventDefault();

        console.log('saveProject called, state.editingProjectId:', state.editingProjectId);

        const formData = {
            name: document.getElementById('projectName').value.trim(),
            start_date: document.getElementById('projectStartDate').value,
            description: document.getElementById('projectDescription').value.trim(),
            company: document.getElementById('projectCompany').value.trim() || null,
            budget_min: document.getElementById('projectBudgetMin').value || null,
            budget_max: document.getElementById('projectBudgetMax').value || null,
            success_chance: document.getElementById('projectSuccessChance').value || null,
            stage: document.getElementById('projectStage').value,
            estimated_completion: document.getElementById('projectEstimatedCompletion').value || null
        };

        try {
            let result;
            if (state.editingProjectId) {
                console.log('Updating project:', state.editingProjectId, formData);
                result = await api.updateProject(state.editingProjectId, formData);
            } else {
                console.log('Creating new project:', formData);
                result = await api.createProject(formData);
            }

            console.log('Save result:', result);

            if (result.success) {
                closeProjectModal();
                loadProjects();
            } else {
                alert('Error: ' + result.error);
            }
        } catch (error) {
            console.error('Error saving project:', error);
            alert('An error occurred while saving the project');
        }
    }

    function openDeleteProjectModal() {
        const projectName = document.getElementById('projectName').value;
        elements.deleteProjectName.textContent = projectName;
        elements.deleteProjectModal.classList.add('active');
    }

    function closeDeleteProjectModal() {
        elements.deleteProjectModal.classList.remove('active');
    }

    async function deleteProject() {
        try {
            const result = await api.deleteProject(state.editingProjectId);

            if (result.success) {
                closeDeleteProjectModal();
                closeProjectModal();
                loadProjects();
            } else {
                alert('Error: ' + result.error);
            }
        } catch (error) {
            console.error('Error deleting project:', error);
            alert('An error occurred while deleting the project');
        }
    }

    async function openProjectOverview(projectId) {
        try {
            state.viewingProjectId = projectId;

            const [projectResult, contactsResult, tagsResult] = await Promise.all([
                api.getProject(projectId),
                api.getProjectContacts(projectId),
                api.getProjectTags(projectId)
            ]);

            if (projectResult.success) {
                state.viewingProject = projectResult.data;
                renderProjectOverview(projectResult.data, contactsResult.data || [], tagsResult.data || []);
                elements.projectOverviewModal.classList.add('active');
            } else {
                alert('Error: ' + projectResult.error);
            }
        } catch (error) {
            console.error('Error opening project overview:', error);
            alert('An error occurred while loading the project');
        }
    }

    function renderProjectOverview(project, contacts, tags) {
        elements.projectOverviewName.textContent = project.name;
        elements.projectOverviewCompany.textContent = project.company || 'No company assigned';

        // Format dates as absolute dates
        elements.projectOverviewStartDate.textContent = project.start_date
            ? new Date(project.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : 'N/A';
        elements.projectOverviewStage.textContent = project.stage || 'N/A';

        const budget = project.budget_min && project.budget_max
            ? `$${parseFloat(project.budget_min).toFixed(0)} - $${parseFloat(project.budget_max).toFixed(0)}`
            : project.budget_min
            ? `$${parseFloat(project.budget_min).toFixed(0)}`
            : 'N/A';
        elements.projectOverviewBudget.textContent = budget;

        elements.projectOverviewSuccessChance.textContent = project.success_chance ? `${project.success_chance}%` : 'N/A';
        elements.projectOverviewEstCompletion.textContent = project.estimated_completion
            ? new Date(project.estimated_completion).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : 'N/A';
        elements.projectOverviewDescription.textContent = project.description || 'No description';

        // Render tags
        renderProjectTags(tags);

        // Render contacts
        renderProjectContacts(contacts);
    }

    function renderProjectTags(tags) {
        if (!tags || tags.length === 0) {
            elements.projectTags.innerHTML = '<p class="empty-hint">No tags assigned</p>';
            return;
        }

        const html = tags.map(tag => `
            <span class="tag" style="background-color: ${tag.color}20; color: ${tag.color};">
                ${escapeHtml(tag.name)}
                <button class="tag-remove" onclick="window.CRM.removeProjectTag(${tag.id})" title="Remove tag">&times;</button>
            </span>
        `).join('');

        elements.projectTags.innerHTML = html;
    }

    function renderProjectContacts(contacts) {
        if (!contacts || contacts.length === 0) {
            elements.projectContacts.innerHTML = '<p class="empty-hint">No contacts assigned</p>';
            return;
        }

        const html = contacts.map(contact => `
            <div class="project-contact-item">
                <div class="contact-avatar">${getInitials(contact.name)}</div>
                <div class="contact-info">
                    <div class="contact-name">${escapeHtml(contact.name)}</div>
                    ${contact.company ? `<div class="contact-company">${escapeHtml(contact.company)}</div>` : ''}
                </div>
                <button class="btn btn-icon btn-small" onclick="window.CRM.removeProjectContact(${contact.id})" title="Remove contact">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                    </svg>
                </button>
            </div>
        `).join('');

        elements.projectContacts.innerHTML = html;
    }

    function closeProjectOverview() {
        elements.projectOverviewModal.classList.remove('active');
        state.viewingProjectId = null;
        state.viewingProject = null;
    }

    async function addProjectTag(tagName) {
        if (!tagName || !state.viewingProjectId) return;

        try {
            // First, create or get the tag
            const tagResult = await api.createTag(tagName);
            if (!tagResult.success) {
                alert('Error: ' + tagResult.error);
                return;
            }

            const tag = tagResult.data;

            // Then assign it to the project
            const assignResult = await api.assignProjectTag(state.viewingProjectId, tag.id);
            if (assignResult.success) {
                // Reload project tags
                const tagsResult = await api.getProjectTags(state.viewingProjectId);
                if (tagsResult.success) {
                    renderProjectTags(tagsResult.data);
                }
                elements.newProjectTagInput.value = '';
                elements.projectTagSuggestions.style.display = 'none';
            } else {
                alert('Error: ' + assignResult.error);
            }
        } catch (error) {
            console.error('Error adding tag to project:', error);
        }
    }

    async function removeProjectTag(tagId) {
        if (!state.viewingProjectId) return;

        try {
            const result = await api.unassignProjectTag(state.viewingProjectId, tagId);
            if (result.success) {
                const tagsResult = await api.getProjectTags(state.viewingProjectId);
                if (tagsResult.success) {
                    renderProjectTags(tagsResult.data);
                }
            } else {
                alert('Error: ' + result.error);
            }
        } catch (error) {
            console.error('Error removing tag from project:', error);
        }
    }

    async function addProjectContact(contactId) {
        if (!contactId || !state.viewingProjectId) return;

        try {
            const result = await api.assignProjectContact(state.viewingProjectId, contactId);
            if (result.success) {
                const contactsResult = await api.getProjectContacts(state.viewingProjectId);
                if (contactsResult.success) {
                    renderProjectContacts(contactsResult.data);
                }
                elements.newProjectContactInput.value = '';
                elements.projectContactSuggestions.style.display = 'none';
            } else {
                alert('Error: ' + result.error);
            }
        } catch (error) {
            console.error('Error assigning contact to project:', error);
        }
    }

    async function removeProjectContact(contactId) {
        if (!state.viewingProjectId) return;

        try {
            const result = await api.unassignProjectContact(state.viewingProjectId, contactId);
            if (result.success) {
                const contactsResult = await api.getProjectContacts(state.viewingProjectId);
                if (contactsResult.success) {
                    renderProjectContacts(contactsResult.data);
                }
            } else {
                alert('Error: ' + result.error);
            }
        } catch (error) {
            console.error('Error removing contact from project:', error);
        }
    }

    function showProjectTagSuggestions(query) {
        if (!state.allTags || state.allTags.length === 0) {
            elements.projectTagSuggestions.style.display = 'none';
            return;
        }

        const lowerQuery = query.toLowerCase();
        const filtered = state.allTags.filter(tag =>
            tag.name.toLowerCase().includes(lowerQuery)
        ).slice(0, 10);

        if (filtered.length === 0 && query.length > 0) {
            elements.projectTagSuggestions.innerHTML = `
                <div class="tag-suggestion" onclick="window.CRM.addProjectTag('${escapeHtml(query)}')">
                    <span>Create "${escapeHtml(query)}"</span>
                </div>
            `;
            elements.projectTagSuggestions.style.display = 'block';
            return;
        }

        const html = filtered.map(tag => `
            <div class="tag-suggestion" onclick="window.CRM.addProjectTag('${escapeHtml(tag.name)}')">
                <span class="tag-color" style="background-color: ${tag.color};"></span>
                <span>${escapeHtml(tag.name)}</span>
            </div>
        `).join('');

        if (html) {
            elements.projectTagSuggestions.innerHTML = html;
            elements.projectTagSuggestions.style.display = 'block';
        } else {
            elements.projectTagSuggestions.style.display = 'none';
        }
    }

    function showProjectContactSuggestions(query) {
        if (!state.contacts || state.contacts.length === 0) {
            elements.projectContactSuggestions.style.display = 'none';
            return;
        }

        const lowerQuery = query.toLowerCase();
        const filtered = state.contacts.filter(contact =>
            contact.name.toLowerCase().includes(lowerQuery) ||
            (contact.company && contact.company.toLowerCase().includes(lowerQuery))
        ).slice(0, 10);

        if (filtered.length === 0) {
            elements.projectContactSuggestions.style.display = 'none';
            return;
        }

        const html = filtered.map(contact => `
            <div class="contact-suggestion" onclick="window.CRM.addProjectContact(${contact.id})">
                <div class="contact-avatar">${getInitials(contact.name)}</div>
                <div class="contact-info">
                    <div class="contact-name">${escapeHtml(contact.name)}</div>
                    ${contact.company ? `<div class="contact-company">${escapeHtml(contact.company)}</div>` : ''}
                </div>
            </div>
        `).join('');

        elements.projectContactSuggestions.innerHTML = html;
        elements.projectContactSuggestions.style.display = 'block';
    }

    function showCompanySuggestions(query) {
        if (!state.contacts || state.contacts.length === 0) {
            if (elements.projectCompanySuggestions) {
                elements.projectCompanySuggestions.classList.remove('visible');
            }
            return;
        }

        const lowerQuery = query.toLowerCase();
        // Get unique companies from contacts
        const companies = [...new Set(state.contacts
            .filter(c => c.company && c.company.toLowerCase().includes(lowerQuery))
            .map(c => c.company)
        )].slice(0, 10);

        if (companies.length === 0) {
            if (elements.projectCompanySuggestions) {
                elements.projectCompanySuggestions.classList.remove('visible');
            }
            return;
        }

        const html = companies.map(company => `
            <div class="autocomplete-suggestion" onclick="window.CRM.selectCompany('${escapeHtml(company).replace(/'/g, "\\'")}')">
                ${escapeHtml(company)}
            </div>
        `).join('');

        if (elements.projectCompanySuggestions) {
            elements.projectCompanySuggestions.innerHTML = html;
            elements.projectCompanySuggestions.classList.add('visible');
        }
    }

    function selectCompany(company) {
        if (elements.projectCompany) {
            elements.projectCompany.value = company;
            if (elements.projectCompanySuggestions) {
                elements.projectCompanySuggestions.classList.remove('visible');
            }
        }
    }

    // ============================================
    // Helper Functions
    // ============================================

    function refreshData() {
        if (state.currentView === 'map') {
            loadMapMarkers();
        } else if (state.currentView === 'calendar') {
            loadCalendarNotes();
        } else if (state.currentView === 'projects') {
            loadProjects();
        } else {
            loadContacts();
        }
    }

    function updateContactCount() {
        // Reload the page to update the contact count in the header
        // This is a simple approach; could be optimized with an API call
        api.getContacts().then(result => {
            if (result.success) {
                const count = result.data.length;
                const countElement = document.querySelector('.contact-count');
                if (countElement) {
                    countElement.textContent = `${count} contact${count !== 1 ? 's' : ''}`;
                }
            }
        });
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function normalizeUrl(url) {
        if (!url) return url;
        url = url.trim();
        if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(url)) return url;
        return 'https://' + url;
    }

    function getInitials(name) {
        if (!name) return '?';
        const parts = name.trim().split(/\s+/);
        if (parts.length === 1) {
            return parts[0].charAt(0).toUpperCase();
        }
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }

    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // ============================================
    // Event Listeners
    // ============================================

    function initEventListeners() {
        // View toggle
        elements.toggleBtns.forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.view));
        });

        // Search input (debounced)
        const debouncedSearch = debounce(() => {
            state.searchQuery = elements.searchInput.value.trim();
            if (state.groupBy === 'tags' && state.taggedData) {
                renderContactsListByTags();
            } else {
                loadContacts();
            }
        }, 300);

        elements.searchInput.addEventListener('input', debouncedSearch);

        // Sort field
        elements.sortField.addEventListener('change', () => {
            state.sortField = elements.sortField.value;
            loadContacts();
        });

        // Sort order toggle
        elements.sortOrderBtn.addEventListener('click', () => {
            state.sortOrder = state.sortOrder === 'ASC' ? 'DESC' : 'ASC';
            elements.sortOrderIcon.style.transform = state.sortOrder === 'DESC' ? 'rotate(180deg)' : '';
            loadContacts();
        });

        // Group by toggle (Company/Tags)
        elements.groupBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                state.groupBy = btn.dataset.group;
                elements.groupBtns.forEach(b => b.classList.toggle('active', b.dataset.group === state.groupBy));
                loadContacts();
            });
        });

        // Tag input - show suggestions
        elements.newTagInput.addEventListener('input', () => {
            const query = elements.newTagInput.value.trim();
            if (query.length > 0) {
                showTagSuggestions(query);
            } else {
                elements.tagSuggestions.classList.remove('visible');
            }
        });

        // Tag input - focus shows all tags
        elements.newTagInput.addEventListener('focus', () => {
            if (elements.newTagInput.value.trim().length === 0 && state.allTags.length > 0) {
                showTagSuggestions('');
            }
        });

        // Hide suggestions when clicking outside
        document.addEventListener('click', (e) => {
            if (!elements.newTagInput.contains(e.target) && !elements.tagSuggestions.contains(e.target)) {
                elements.tagSuggestions.classList.remove('visible');
            }
        });

        // Add tag button
        elements.addTagBtn.addEventListener('click', async () => {
            const query = elements.newTagInput.value.trim();
            if (query) {
                await createAndAssignTag(query);
            }
        });

        // List filter toggle (mobile - collapsible controls)
        const listFilterToggle = document.getElementById('listFilterToggle');
        const listControls = document.getElementById('listControls');

        if (listFilterToggle && listControls) {
            listFilterToggle.addEventListener('click', () => {
                listControls.classList.toggle('open');
                listFilterToggle.classList.toggle('active');
            });
        }

        // Add contact button (desktop)
        elements.addContactBtn.addEventListener('click', () => openContactModal());

        // Mobile menu toggle
        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        const mobileMenu = document.getElementById('mobileMenu');

        if (mobileMenuBtn && mobileMenu) {
            mobileMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                mobileMenu.classList.toggle('open');
            });

            // Close mobile menu when clicking outside
            document.addEventListener('click', (e) => {
                if (!mobileMenu.contains(e.target) && !mobileMenuBtn.contains(e.target)) {
                    mobileMenu.classList.remove('open');
                }
            });

            // Mobile: Add Contact
            const addContactBtnMobile = document.getElementById('addContactBtnMobile');
            if (addContactBtnMobile) {
                addContactBtnMobile.addEventListener('click', () => {
                    mobileMenu.classList.remove('open');
                    openContactModal();
                });
            }

            // Mobile: Import/Export
            const importExportBtnMobile = document.getElementById('importExportBtnMobile');
            if (importExportBtnMobile) {
                importExportBtnMobile.addEventListener('click', () => {
                    mobileMenu.classList.remove('open');
                    openImportExportModal();
                });
            }
        }

        // Modal close buttons
        elements.closeModal.addEventListener('click', closeContactModal);
        elements.cancelBtn.addEventListener('click', closeContactModal);
        elements.contactModal.querySelector('.modal-backdrop').addEventListener('click', closeContactModal);

        // Expandable fields toggle
        elements.expandToggle.addEventListener('click', () => {
            elements.expandableFields.classList.toggle('expanded');
            const isExpanded = elements.expandableFields.classList.contains('expanded');
            elements.expandToggle.querySelector('.expand-icon').style.transform = isExpanded ? 'rotate(45deg)' : '';
        });

        // Contact form submission
        elements.contactForm.addEventListener('submit', saveContact);

        // Delete button
        elements.deleteBtn.addEventListener('click', openDeleteModal);

        // Delete modal
        elements.closeDeleteModal.addEventListener('click', closeDeleteModal);
        elements.cancelDeleteBtn.addEventListener('click', closeDeleteModal);
        elements.deleteModal.querySelector('.modal-backdrop').addEventListener('click', closeDeleteModal);
        elements.confirmDeleteBtn.addEventListener('click', deleteContact);

        // Overview modal
        elements.closeOverviewModal.addEventListener('click', closeOverviewModal);
        elements.closeOverviewBtn.addEventListener('click', closeOverviewModal);
        elements.overviewModal.querySelector('.modal-backdrop').addEventListener('click', closeOverviewModal);
        elements.editContactBtn.addEventListener('click', openEditFromOverview);
        elements.addNoteBtn.addEventListener('click', addNote);

        // Company notes modal
        elements.closeCompanyNotesModal.addEventListener('click', closeCompanyNotesModal);
        elements.closeCompanyNotesBtn.addEventListener('click', closeCompanyNotesModal);
        elements.companyNotesModal.querySelector('.modal-backdrop').addEventListener('click', closeCompanyNotesModal);

        // Allow Enter key in note textarea to add note (with Ctrl/Cmd)
        elements.newNoteContent.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                addNote();
            }
        });

        // ===== Project Event Listeners =====

        // Project search input (debounced)
        const debouncedProjectSearch = debounce(() => {
            state.projectSearchQuery = elements.searchProjectsInput.value.trim();
            loadProjects();
        }, 300);

        if (elements.searchProjectsInput) {
            elements.searchProjectsInput.addEventListener('input', debouncedProjectSearch);
        }

        // Project sort field
        if (elements.projectSortField) {
            elements.projectSortField.addEventListener('change', () => {
                state.projectSortField = elements.projectSortField.value;
                loadProjects();
            });
        }

        // Project sort order toggle
        if (elements.projectSortOrderBtn) {
            elements.projectSortOrderBtn.addEventListener('click', () => {
                state.projectSortOrder = state.projectSortOrder === 'ASC' ? 'DESC' : 'ASC';
                elements.projectSortOrderIcon.style.transform = state.projectSortOrder === 'DESC' ? 'rotate(180deg)' : '';
                loadProjects();
            });
        }

        // Add project button
        if (elements.addProjectBtn) {
            elements.addProjectBtn.addEventListener('click', () => openProjectModal());
        }

        // Project modal close buttons
        if (elements.closeProjectModal) {
            elements.closeProjectModal.addEventListener('click', closeProjectModal);
        }
        if (elements.cancelProjectBtn) {
            elements.cancelProjectBtn.addEventListener('click', closeProjectModal);
        }
        if (elements.projectModal) {
            elements.projectModal.querySelector('.modal-backdrop').addEventListener('click', closeProjectModal);
        }

        // Project form submission
        if (elements.projectForm) {
            elements.projectForm.addEventListener('submit', saveProject);
        }

        // Delete project button
        if (elements.deleteProjectBtn) {
            elements.deleteProjectBtn.addEventListener('click', openDeleteProjectModal);
        }

        // Delete project modal
        if (elements.closeDeleteProjectModal) {
            elements.closeDeleteProjectModal.addEventListener('click', closeDeleteProjectModal);
        }
        if (elements.cancelDeleteProjectBtn) {
            elements.cancelDeleteProjectBtn.addEventListener('click', closeDeleteProjectModal);
        }
        if (elements.deleteProjectModal) {
            elements.deleteProjectModal.querySelector('.modal-backdrop').addEventListener('click', closeDeleteProjectModal);
        }
        if (elements.confirmDeleteProjectBtn) {
            elements.confirmDeleteProjectBtn.addEventListener('click', deleteProject);
        }

        // Project overview modal
        if (elements.closeProjectOverviewModal) {
            elements.closeProjectOverviewModal.addEventListener('click', closeProjectOverview);
        }
        if (elements.closeProjectOverviewBtn) {
            elements.closeProjectOverviewBtn.addEventListener('click', closeProjectOverview);
        }
        if (elements.projectOverviewModal) {
            const backdrop = elements.projectOverviewModal.querySelector('.modal-backdrop');
            if (backdrop) {
                backdrop.addEventListener('click', closeProjectOverview);
            }
        }
        if (elements.editProjectBtn) {
            elements.editProjectBtn.addEventListener('click', () => {
                closeProjectOverview();
                openProjectModal(state.viewingProject);
            });
        }

        // Project tag add button
        if (elements.addProjectTagBtn) {
            elements.addProjectTagBtn.addEventListener('click', () => {
                const tagName = elements.newProjectTagInput.value.trim();
                if (tagName) {
                    addProjectTag(tagName);
                }
            });
        }

        // Project contact add button
        if (elements.addProjectContactBtn) {
            elements.addProjectContactBtn.addEventListener('click', () => {
                const query = elements.newProjectContactInput.value.trim();
                if (query) {
                    // Try to find exact match
                    const contacts = state.contacts.filter(c =>
                        c.name.toLowerCase() === query.toLowerCase()
                    );
                    if (contacts.length > 0) {
                        assignProjectContact(contacts[0].id);
                    }
                }
            });
        }

        // Company autocomplete
        if (elements.projectCompany) {
            elements.projectCompany.addEventListener('input', () => {
                const query = elements.projectCompany.value.trim();
                if (query.length > 0) {
                    showCompanySuggestions(query);
                } else {
                    if (elements.projectCompanySuggestions) {
                        elements.projectCompanySuggestions.classList.remove('visible');
                    }
                }
            });

            // Hide suggestions when clicking outside
            document.addEventListener('click', (e) => {
                if (elements.projectCompanySuggestions &&
                    !elements.projectCompany.contains(e.target) &&
                    !elements.projectCompanySuggestions.contains(e.target)) {
                    elements.projectCompanySuggestions.classList.remove('visible');
                }
            });
        }

        // Project tag input
        if (elements.newProjectTagInput) {
            elements.newProjectTagInput.addEventListener('input', () => {
                const query = elements.newProjectTagInput.value.trim();
                if (query.length > 0) {
                    showProjectTagSuggestions(query);
                } else {
                    elements.projectTagSuggestions.style.display = 'none';
                }
            });

            elements.newProjectTagInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const tagName = elements.newProjectTagInput.value.trim();
                    if (tagName) {
                        addProjectTag(tagName);
                    }
                }
            });
        }

        // Project contact input
        if (elements.newProjectContactInput) {
            elements.newProjectContactInput.addEventListener('input', () => {
                const query = elements.newProjectContactInput.value.trim();
                if (query.length > 0) {
                    showProjectContactSuggestions(query);
                } else {
                    elements.projectContactSuggestions.style.display = 'none';
                }
            });
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Escape to close modals
            if (e.key === 'Escape') {
                if (elements.deleteModal.classList.contains('active')) {
                    closeDeleteModal();
                } else if (elements.deleteProjectModal.classList.contains('active')) {
                    closeDeleteProjectModal();
                } else if (elements.projectOverviewModal.classList.contains('active')) {
                    closeProjectOverview();
                } else if (elements.projectModal.classList.contains('active')) {
                    closeProjectModal();
                } else if (elements.importExportModal.classList.contains('active')) {
                    closeImportExportModal();
                } else if (elements.companyNotesModal.classList.contains('active')) {
                    closeCompanyNotesModal();
                } else if (elements.overviewModal.classList.contains('active')) {
                    closeOverviewModal();
                } else if (elements.contactModal.classList.contains('active')) {
                    closeContactModal();
                }
            }

            // Ctrl/Cmd + N to add new contact
            if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
                e.preventDefault();
                openContactModal();
            }
        });
    }

    // ============================================
    // Initialization
    // ============================================

    function init() {
        initEventListeners();
        initImportExportEvents();
        initCalendarEvents();
        initMap();

        // Load all tags for suggestions and calendar filter
        loadAllTags().then(() => {
            populateCalendarTagFilter();
        });

        // Load initial data based on current view
        if (state.currentView === 'map') {
            loadMapMarkers();
        } else if (state.currentView === 'calendar') {
            loadCalendarNotes();
        } else {
            loadContacts();
        }
    }

    // Expose functions globally for map popup buttons and onclick handlers
    window.CRM = {
        editContact: editContact,
        openOverview: openOverviewModal,
        openProjectOverview: openProjectOverview,
        addProjectTag: addProjectTag,
        removeProjectTag: removeProjectTag,
        addProjectContact: addProjectContact,
        removeProjectContact: removeProjectContact,
        selectCompany: selectCompany
    };

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
