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
        currentView: 'projects',
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
        mapBaseLayer: null,
        mapLabelLayer: null,
        theme: 'light',
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
        allProjects: [],
        projectSortField: 'name',
        projectSortOrder: 'ASC',
        projectSearchQuery: '',
        editingProjectId: null,
        viewingProjectId: null,
        viewingProject: null,
        // To-do state
        todos: [],
        todoSearchQuery: '',
        todoStatusFilter: 'open',
        todoContactFilterId: '',
        todoProjectFilterId: '',
        todoSortBy: 'default',
        todoFilterOptionsInitialized: false,
        editingTodoId: null,
        todoModalContext: null
    };

    // ============================================
    // DOM Elements
    // ============================================

    const elements = {
        // Views
        mapView: document.getElementById('mapView'),
        listView: document.getElementById('listView'),
        calendarView: document.getElementById('calendarView'),
        todoView: document.getElementById('todoView'),
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
        themeToggleBtn: document.getElementById('themeToggleBtn'),

        // List controls
        searchInput: document.getElementById('searchInput'),
        sortField: document.getElementById('sortField'),
        sortOrderBtn: document.getElementById('sortOrderBtn'),
        sortOrderIcon: document.getElementById('sortOrderIcon'),
        contactsList: document.getElementById('contactsList'),
        groupBtns: document.querySelectorAll('.group-btn'),

        // To-do view
        todosList: document.getElementById('todosList'),
        searchTodosInput: document.getElementById('searchTodosInput'),
        todoContactFilter: document.getElementById('todoContactFilter'),
        todoProjectFilter: document.getElementById('todoProjectFilter'),
        todoStatusFilter: document.getElementById('todoStatusFilter'),
        todoSort: document.getElementById('todoSort'),
        addTodoBtn: document.getElementById('addTodoBtn'),

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
        contactTodosList: document.getElementById('contactTodosList'),
        addContactTodoBtn: document.getElementById('addContactTodoBtn'),
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
        projectTodosList: document.getElementById('projectTodosList'),
        addProjectTodoBtn: document.getElementById('addProjectTodoBtn'),
        projectNotesTimeline: document.getElementById('projectNotesTimeline'),
        newProjectNoteContent: document.getElementById('newProjectNoteContent'),
        addProjectNoteBtn: document.getElementById('addProjectNoteBtn'),
        newProjectContactInput: document.getElementById('newProjectContactInput'),
        projectContactSuggestions: document.getElementById('projectContactSuggestions'),
        addProjectContactBtn: document.getElementById('addProjectContactBtn'),
        closeProjectOverviewModal: document.getElementById('closeProjectOverviewModal'),
        closeProjectOverviewBtn: document.getElementById('closeProjectOverviewBtn'),
        deleteProjectOverviewBtn: document.getElementById('deleteProjectOverviewBtn'),
        editProjectBtn: document.getElementById('editProjectBtn'),

        // To-do modal
        todoModal: document.getElementById('todoModal'),
        todoModalTitle: document.getElementById('todoModalTitle'),
        todoForm: document.getElementById('todoForm'),
        todoTitle: document.getElementById('todoTitle'),
        todoDescription: document.getElementById('todoDescription'),
        todoDueDate: document.getElementById('todoDueDate'),
        todoPriority: document.getElementById('todoPriority'),
        todoAssignType: document.getElementById('todoAssignType'),
        todoAssigneeId: document.getElementById('todoAssigneeId'),
        closeTodoModal: document.getElementById('closeTodoModal'),
        cancelTodoBtn: document.getElementById('cancelTodoBtn'),
        saveTodoBtn: document.getElementById('saveTodoBtn')
    };

    // ============================================
    // CSRF Token Helper
    // ============================================

    function getCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    function encodeUtf8Base64(value) {
        const bytes = new TextEncoder().encode(value);
        let binary = '';
        const chunkSize = 0x8000;

        for (let index = 0; index < bytes.length; index += chunkSize) {
            const chunk = bytes.subarray(index, index + chunkSize);
            binary += String.fromCharCode(...chunk);
        }

        return btoa(binary);
    }

    function buildContactTransportPayload(data) {
        return {
            payload: encodeUtf8Base64(JSON.stringify({
                n: data.name ?? '',
                c: data.company ?? '',
                l: data.location ?? '',
                lat: data.latitude ?? null,
                lng: data.longitude ?? null,
                o: data.note ?? '',
                e: data.email ?? '',
                p: data.phone ?? '',
                w: data.website ?? '',
                a: data.address ?? ''
            }))
        };
    }

    async function parseApiResponse(response, fallbackMessage = 'Request failed') {
        const responseText = await response.text();
        const contentType = response.headers.get('content-type') || '';

        if (responseText === '') {
            return response.ok ? { success: true } : { error: fallbackMessage };
        }

        if (contentType.includes('application/json')) {
            try {
                return JSON.parse(responseText);
            } catch (error) {
                throw new Error(`${fallbackMessage}: server returned invalid JSON.`);
            }
        }

        if (response.status === 403) {
            throw new Error(`${fallbackMessage}: the web server blocked this request before the app could process it.`);
        }

        throw new Error(`${fallbackMessage}: server returned ${response.status}.`);
    }

    // ============================================
    // Theme Functions
    // ============================================

    const THEME_STORAGE_KEY = 'crm-theme';

    function getStoredTheme() {
        try {
            const stored = localStorage.getItem(THEME_STORAGE_KEY);
            return stored === 'light' || stored === 'dark' ? stored : 'light';
        } catch (e) {
            return 'light';
        }
    }

    function getThemeToggleMarkup(theme) {
        if (theme === 'light') {
            return `
                <svg class="theme-toggle-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M9.37 5.51A7 7 0 0 0 17.49 13.63 7 7 0 1 1 9.37 5.51z"/>
                </svg>
                <span class="theme-toggle-label">Dark Mode</span>
            `;
        }

        return `
            <svg class="theme-toggle-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4"></circle>
                <line x1="12" y1="1.5" x2="12" y2="4.5"></line>
                <line x1="12" y1="19.5" x2="12" y2="22.5"></line>
                <line x1="1.5" y1="12" x2="4.5" y2="12"></line>
                <line x1="19.5" y1="12" x2="22.5" y2="12"></line>
                <line x1="4.2" y1="4.2" x2="6.3" y2="6.3"></line>
                <line x1="17.7" y1="17.7" x2="19.8" y2="19.8"></line>
                <line x1="17.7" y1="6.3" x2="19.8" y2="4.2"></line>
                <line x1="4.2" y1="19.8" x2="6.3" y2="17.7"></line>
            </svg>
            <span class="theme-toggle-label">Light Mode</span>
        `;
    }

    function updateThemeToggleButton() {
        if (!elements.themeToggleBtn) {
            return;
        }

        const nextTheme = state.theme === 'light' ? 'dark' : 'light';
        elements.themeToggleBtn.innerHTML = getThemeToggleMarkup(state.theme);
        elements.themeToggleBtn.setAttribute('aria-label', `Switch to ${nextTheme} mode`);
        elements.themeToggleBtn.setAttribute('title', `Switch to ${nextTheme} mode`);
    }

    function applyTheme(theme, persist = true) {
        state.theme = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', state.theme);

        if (persist) {
            try {
                localStorage.setItem(THEME_STORAGE_KEY, state.theme);
            } catch (e) {
                // Ignore storage errors; theme still works for current session
            }
        }

        updateThemeToggleButton();
        updateMapTheme();
    }

    function toggleTheme() {
        applyTheme(state.theme === 'light' ? 'dark' : 'light');
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
                body: JSON.stringify(buildContactTransportPayload(data))
            });
            return parseApiResponse(response, 'Error creating contact');
        },

        async updateContact(id, data) {
            const response = await fetch(`api/contacts.php?id=${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify(buildContactTransportPayload(data))
            });
            return parseApiResponse(response, 'Error updating contact');
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

        async getProjectNotes(projectId) {
            const response = await fetch(`api/projects.php?action=notes&id=${projectId}`);
            return response.json();
        },

        async createProjectNote(projectId, content) {
            const response = await fetch('api/projects.php?action=add-note', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ project_id: projectId, content })
            });
            return response.json();
        },

        async deleteProjectNote(noteId) {
            const response = await fetch(`api/projects.php?action=delete-note&id=${noteId}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': getCsrfToken() }
            });
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
        },

        // To-dos API
        async getTodos(params = {}) {
            const query = new URLSearchParams();
            if (params.contact_id) query.set('contact_id', params.contact_id);
            if (params.project_id) query.set('project_id', params.project_id);
            if (params.status) query.set('status', params.status);
            if (params.search) query.set('search', params.search);
            if (params.sort) query.set('sort', params.sort);

            const url = query.toString() ? `api/todos.php?${query}` : 'api/todos.php';
            const response = await fetch(url);
            return response.json();
        },

        async getTodo(id) {
            const response = await fetch(`api/todos.php?id=${id}`);
            return response.json();
        },

        async createTodo(data) {
            const response = await fetch('api/todos.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async updateTodo(id, data) {
            const response = await fetch(`api/todos.php?id=${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async deleteTodo(id) {
            const response = await fetch(`api/todos.php?id=${id}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': getCsrfToken() }
            });
            return response.json();
        }
    };

    // ============================================
    // Map Functions
    // ============================================

    function updateMapTheme() {
        if (!state.map) {
            return;
        }

        if (state.mapBaseLayer) {
            state.map.removeLayer(state.mapBaseLayer);
            state.mapBaseLayer = null;
        }

        if (state.mapLabelLayer) {
            state.map.removeLayer(state.mapLabelLayer);
            state.mapLabelLayer = null;
        }

        if (state.theme === 'light') {
            state.mapBaseLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
                subdomains: 'abcd',
                maxZoom: 20
            });

            state.mapLabelLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
                subdomains: 'abcd',
                maxZoom: 20,
                pane: 'shadowPane'
            });
        } else {
            state.mapBaseLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
                subdomains: 'abcd',
                maxZoom: 20
            });

            state.mapLabelLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
                subdomains: 'abcd',
                maxZoom: 20,
                pane: 'shadowPane'
            });
        }

        state.mapBaseLayer.addTo(state.map);
        state.mapLabelLayer.addTo(state.map);
    }

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

        // Apply themed map tile layers
        updateMapTheme();

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

    // Load all contacts without rendering (for autocomplete in projects)
    async function loadAllContacts() {
        try {
            const result = await api.getContacts('', 'name', 'ASC');
            if (result.success) {
                state.contacts = result.data;
                populateTodoOwnerFilters();
            }
        } catch (error) {
            console.error('Error loading all contacts:', error);
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
                // Contacts without company get their own section for cleaner visual rhythm
                html += `<div class="company-group company-group--ungrouped">`;
                html += `<div class="company-header company-header--muted">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                    </svg>
                    <span>No Company</span>
                    <span class="company-count">${group.contacts.length}</span>
                </div>`;
                html += group.contacts.map(contact => createContactCard(contact, false)).join('');
                html += `</div>`;
            }
        });

        elements.contactsList.innerHTML = html;
        addContactListEventHandlers();
        triggerContactDeckAnimation();
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
        triggerContactDeckAnimation();
    }

    function triggerContactDeckAnimation() {
        if (!elements.contactsList) {
            return;
        }

        const cards = elements.contactsList.querySelectorAll('.contact-card');
        if (!cards || cards.length === 0) {
            return;
        }

        cards.forEach((card, index) => {
            card.style.setProperty('--deck-order', Math.min(index, 24));
            card.classList.remove('contact-card--deck-enter');
        });

        // Reflow ensures animation restarts during fast search/filter updates.
        void elements.contactsList.offsetWidth;

        requestAnimationFrame(() => {
            cards.forEach((card) => {
                card.classList.add('contact-card--deck-enter');
            });
        });
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
                if (!company) {
                    return;
                }
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
        const company = (contact.company || '').trim();
        const location = (contact.location || '').trim();
        const fallbackText = inGroup ? 'No location set' : 'No company set';
        const subtitleText = (!inGroup && company) ? company : (location || fallbackText);

        const flags = [];
        if (contact.email) flags.push('Email');
        if (contact.phone) flags.push('Phone');
        if (contact.website) flags.push('Web');
        if (contact.note) flags.push('Note');

        const flagHtml = flags.length > 0
            ? `<div class="contact-card-flags">${flags.slice(0, 3).map(flag => `<span class="contact-card-flag">${flag}</span>`).join('')}</div>`
            : '';

        return `
            <div class="contact-card${inGroup ? ' in-group' : ''}" data-id="${contact.id}">
                <div class="contact-card-main">
                    <div class="contact-avatar">
                        ${getInitials(contact.name)}
                    </div>
                    <div class="contact-card-content">
                        <h3 class="contact-card-name">${escapeHtml(contact.name)}</h3>
                        <p class="contact-card-subtitle">${escapeHtml(subtitleText)}</p>
                        ${flagHtml}
                    </div>
                </div>
                <div class="contact-card-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
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
        elements.todoView.classList.toggle('active', view === 'todos');
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
        } else if (view === 'todos') {
            loadTodos();
        } else if (view === 'projects') {
            loadProjects();
            // Also load contacts for autocomplete in project assignment
            if (!state.contacts || state.contacts.length === 0) {
                loadAllContacts();
            }
        } else {
            loadContacts();
        }
    }

    // ============================================
    // To-Do Functions
    // ============================================

    async function loadAllProjectsForAssignment() {
        try {
            const result = await api.getProjects('', 'name', 'ASC');
            if (result.success) {
                state.allProjects = result.data || [];
                populateTodoOwnerFilters();
            }
        } catch (error) {
            console.error('Error loading projects for to-do assignment:', error);
        }
    }

    async function loadTodos() {
        if (!elements.todosList) {
            return;
        }

        try {
            if (!state.todoFilterOptionsInitialized) {
                await ensureTodoAssignmentData(true);
                state.todoFilterOptionsInitialized = true;
            } else {
                await ensureTodoAssignmentData();
            }
            populateTodoOwnerFilters();

            const result = await api.getTodos({
                status: state.todoStatusFilter,
                search: state.todoSearchQuery,
                contact_id: state.todoContactFilterId || '',
                project_id: state.todoProjectFilterId || '',
                sort: state.todoSortBy || 'default'
            });

            if (result.success) {
                state.todos = result.data || [];
                renderGroupedTodosList(elements.todosList, state.todos);
            } else {
                elements.todosList.innerHTML = '<div class="empty-state">Error loading to-dos</div>';
            }
        } catch (error) {
            console.error('Error loading to-dos:', error);
            elements.todosList.innerHTML = '<div class="empty-state">Error loading to-dos</div>';
        }
    }

    async function loadContactTodos(contactId) {
        if (!elements.contactTodosList) {
            return;
        }

        try {
            const result = await api.getTodos({ contact_id: contactId, status: 'all' });
            if (result.success) {
                renderTodoCollection(elements.contactTodosList, result.data || [], {
                    showContext: false,
                    emptyMessage: 'No to-dos yet for this contact'
                });
            } else {
                renderTodoCollection(elements.contactTodosList, [], {
                    showContext: false,
                    emptyMessage: 'No to-dos yet for this contact'
                });
            }
        } catch (error) {
            console.error('Error loading contact to-dos:', error);
        }
    }

    async function loadProjectTodos(projectId) {
        if (!elements.projectTodosList) {
            return;
        }

        try {
            const result = await api.getTodos({ project_id: projectId, status: 'all' });
            if (result.success) {
                renderTodoCollection(elements.projectTodosList, result.data || [], {
                    showContext: false,
                    emptyMessage: 'No to-dos yet for this project'
                });
            } else {
                renderTodoCollection(elements.projectTodosList, [], {
                    showContext: false,
                    emptyMessage: 'No to-dos yet for this project'
                });
            }
        } catch (error) {
            console.error('Error loading project to-dos:', error);
        }
    }

    function populateTodoOwnerFilters() {
        if (elements.todoContactFilter) {
            const contacts = (state.contacts || []).slice().sort((a, b) => {
                return (a.name || '').localeCompare((b.name || ''), undefined, { sensitivity: 'base' });
            });

            let contactOptions = '<option value="">All People</option>';
            contacts.forEach(contact => {
                const label = contact.company
                    ? `${contact.name} (${contact.company})`
                    : contact.name;
                contactOptions += `<option value="${contact.id}">${escapeHtml(label)}</option>`;
            });

            elements.todoContactFilter.innerHTML = contactOptions;
            elements.todoContactFilter.value = state.todoContactFilterId ? String(state.todoContactFilterId) : '';
        }

        if (elements.todoProjectFilter) {
            const projects = (state.allProjects || []).slice().sort((a, b) => {
                return (a.name || '').localeCompare((b.name || ''), undefined, { sensitivity: 'base' });
            });

            let projectOptions = '<option value="">All Projects</option>';
            projects.forEach(project => {
                projectOptions += `<option value="${project.id}">${escapeHtml(project.name || `Project #${project.id}`)}</option>`;
            });

            elements.todoProjectFilter.innerHTML = projectOptions;
            elements.todoProjectFilter.value = state.todoProjectFilterId ? String(state.todoProjectFilterId) : '';
        }
    }

    function renderTodoCollection(container, todos, options = {}) {
        if (!container) {
            return;
        }

        const showContext = options.showContext === true;
        const emptyMessage = options.emptyMessage || 'No to-dos yet';

        if (!todos || todos.length === 0) {
            container.innerHTML = `
                <div class="notes-empty">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
                    </svg>
                    <p>${escapeHtml(emptyMessage)}</p>
                </div>
            `;
            return;
        }

        const html = todos.map(todo => createTodoItemMarkup(todo, { showContext })).join('');
        container.innerHTML = html;
    }

    function getTodoGroupMeta(todo) {
        const hasProject = !!todo.project_id;
        const hasContact = !!todo.contact_id;

        const projectLabel = todo.project_name || `Project #${todo.project_id}`;
        const contactLabel = todo.contact_name || `Contact #${todo.contact_id}`;

        if (hasProject && hasContact) {
            return {
                key: `project:${todo.project_id}|contact:${todo.contact_id}`,
                title: projectLabel,
                subtitle: contactLabel,
                kind: 'project-contact',
                projectId: Number(todo.project_id),
                contactId: Number(todo.contact_id)
            };
        }

        if (hasProject) {
            return {
                key: `project:${todo.project_id}`,
                title: projectLabel,
                subtitle: 'Project',
                kind: 'project',
                projectId: Number(todo.project_id),
                contactId: null
            };
        }

        return {
            key: `contact:${todo.contact_id}`,
            title: contactLabel,
            subtitle: 'Contact',
            kind: 'contact',
            projectId: null,
            contactId: Number(todo.contact_id)
        };
    }

    function renderGroupedTodosList(container, todos) {
        if (!container) {
            return;
        }

        if (!todos || todos.length === 0) {
            renderTodoCollection(container, [], {
                showContext: false,
                emptyMessage: 'No to-dos found'
            });
            triggerTodoDeckAnimation(container);
            return;
        }

        const groupMap = new Map();
        todos.forEach(todo => {
            const meta = getTodoGroupMeta(todo);
            if (!groupMap.has(meta.key)) {
                groupMap.set(meta.key, {
                    meta,
                    items: []
                });
            }
            groupMap.get(meta.key).items.push(todo);
        });

        const groups = Array.from(groupMap.values());

        const html = groups.map(group => {
            const { meta, items } = group;

            const typeLabel = meta.kind === 'project-contact'
                ? 'Project + Contact'
                : (meta.kind === 'project' ? 'Project' : 'Contact');

            const headerActions = `
                <div class="todo-group-actions">
                    ${meta.projectId ? `<button type="button" class="btn btn-secondary btn-small" data-todo-open-project="${meta.projectId}">Open Project</button>` : ''}
                    ${meta.contactId ? `<button type="button" class="btn btn-secondary btn-small" data-todo-open-contact="${meta.contactId}">Open Contact</button>` : ''}
                </div>
            `;

            return `
                <div class="todo-group">
                    <div class="todo-group-header">
                        <div class="todo-group-title-wrap">
                            <h3 class="todo-group-title">${escapeHtml(meta.title)}</h3>
                            <p class="todo-group-subtitle">${escapeHtml(meta.subtitle)}</p>
                        </div>
                        <div class="todo-group-meta">
                            <span class="todo-group-type">${escapeHtml(typeLabel)}</span>
                            <span class="todo-group-count">${items.length}</span>
                        </div>
                    </div>
                    ${headerActions}
                    <div class="todo-group-items">
                        ${items.map(todo => createTodoItemMarkup(todo, { showContext: false })).join('')}
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;
        triggerTodoDeckAnimation(container);
    }

    function triggerTodoDeckAnimation(container = elements.todosList) {
        if (!container) {
            return;
        }

        const animTargets = container.querySelectorAll('.todo-group, .todo-item, .notes-empty');
        if (!animTargets || animTargets.length === 0) {
            return;
        }

        animTargets.forEach((el, index) => {
            el.style.setProperty('--todo-deck-order', Math.min(index, 24));
            el.classList.remove('todo-deck-enter');
        });

        // Reflow ensures animation restarts during rapid filter/search updates.
        void container.offsetWidth;

        requestAnimationFrame(() => {
            animTargets.forEach((el) => {
                el.classList.add('todo-deck-enter');
            });
        });
    }

    function createTodoItemMarkup(todo, options = {}) {
        const showContext = options.showContext === true;
        const isCompleted = Number(todo.is_completed) === 1;
        const dueDate = parseTodoDueDate(todo.due_date);
        const priorityMeta = getTodoPriorityMeta(todo.priority);
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const isOverdue = dueDate && !isCompleted && dueDate < startOfToday;

        let dueText = 'No due date';
        if (dueDate) {
            dueText = `Due ${dueDate.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            })}`;
        }

        let contextLabel = '';
        let contextClass = '';
        if (todo.contact_id) {
            contextLabel = `Contact: ${todo.contact_name || `#${todo.contact_id}`}`;
            contextClass = 'todo-context--contact';
        } else if (todo.project_id) {
            contextLabel = `Project: ${todo.project_name || `#${todo.project_id}`}`;
            contextClass = 'todo-context--project';
        }

        const openButtons = showContext ? `
            <div class="todo-open-links">
                ${todo.contact_id ? `<button type="button" class="btn btn-secondary btn-small" data-todo-open-contact="${todo.contact_id}">Open Contact</button>` : ''}
                ${todo.project_id ? `<button type="button" class="btn btn-secondary btn-small" data-todo-open-project="${todo.project_id}">Open Project</button>` : ''}
            </div>
        ` : '';

        return `
            <div class="todo-item${isCompleted ? ' todo-completed' : ''}" data-todo-id="${todo.id}">
                <div class="todo-main">
                    <label class="todo-check" title="${isCompleted ? 'Mark as open' : 'Mark as completed'}">
                        <input type="checkbox" data-todo-toggle="${todo.id}" ${isCompleted ? 'checked' : ''}>
                        <span class="todo-check-indicator"></span>
                    </label>
                    <div class="todo-content">
                        <div class="todo-title-row">
                            <h4 class="todo-title">${escapeHtml(todo.title || '')}</h4>
                            ${showContext && contextLabel ? `<span class="todo-context ${contextClass}">${escapeHtml(contextLabel)}</span>` : ''}
                        </div>
                        ${todo.description ? `<p class="todo-description">${escapeHtml(todo.description)}</p>` : ''}
                        <div class="todo-meta">
                            ${priorityMeta ? `<span class="todo-priority todo-priority--${priorityMeta.key}">${escapeHtml(priorityMeta.label)}</span>` : ''}
                            <span class="todo-due${isOverdue ? ' todo-due-overdue' : ''}">${escapeHtml(dueText)}</span>
                        </div>
                        ${openButtons}
                    </div>
                    <div class="todo-actions">
                        <button type="button" class="btn btn-secondary btn-small todo-edit-btn" data-todo-edit="${todo.id}">
                            Bearbeiten
                        </button>
                        <button type="button" class="btn btn-icon btn-small todo-delete-btn" data-todo-delete="${todo.id}" title="Delete to-do">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    function getTodoPriorityMeta(priorityValue) {
        if (!priorityValue || typeof priorityValue !== 'string') {
            return null;
        }

        const normalized = priorityValue.trim().toLowerCase();
        if (normalized === 'high') {
            return { key: 'high', label: 'High Priority' };
        }

        if (normalized === 'medium') {
            return { key: 'medium', label: 'Medium Priority' };
        }

        if (normalized === 'low') {
            return { key: 'low', label: 'Low Priority' };
        }

        return null;
    }

    function parseTodoDueDate(value) {
        if (!value || typeof value !== 'string') {
            return null;
        }

        const parsed = new Date(`${value}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) {
            return null;
        }

        return parsed;
    }

    async function ensureTodoAssignmentData(forceReload = false) {
        const tasks = [];

        if (forceReload || !state.contacts || state.contacts.length === 0) {
            tasks.push(loadAllContacts());
        }

        if (forceReload || !state.allProjects || state.allProjects.length === 0) {
            tasks.push(loadAllProjectsForAssignment());
        }

        if (tasks.length > 0) {
            await Promise.all(tasks);
        }
    }

    function populateTodoAssigneeOptions(assignType, selectedId = null) {
        if (!elements.todoAssigneeId) {
            return;
        }

        const safeType = assignType === 'project' ? 'project' : 'contact';
        const options = safeType === 'project' ? (state.allProjects || []) : (state.contacts || []);
        const placeholder = safeType === 'project' ? 'Select project...' : 'Select contact...';

        let html = `<option value="">${placeholder}</option>`;
        options.forEach(item => {
            const label = safeType === 'project'
                ? (item.name || `Project #${item.id}`)
                : (item.company ? `${item.name} (${item.company})` : item.name);
            html += `<option value="${item.id}">${escapeHtml(label)}</option>`;
        });

        if (selectedId && !options.some(item => Number(item.id) === Number(selectedId))) {
            html += `<option value="${selectedId}">Selected item not found</option>`;
        }

        elements.todoAssigneeId.innerHTML = html;
        elements.todoAssigneeId.value = selectedId ? String(selectedId) : '';
    }

    function updateTodoModalForMode(isEditMode) {
        if (!elements.todoModalTitle || !elements.saveTodoBtn) {
            return;
        }

        if (isEditMode) {
            elements.todoModalTitle.textContent = 'To-Do Bearbeiten';
            elements.saveTodoBtn.textContent = 'Speichern';
        } else {
            elements.todoModalTitle.textContent = 'New To-Do';
            elements.saveTodoBtn.textContent = 'Create To-Do';
        }
    }

    async function openTodoModal(context = null, todoData = null) {
        if (!elements.todoModal || !elements.todoForm) {
            return;
        }

        const isEditMode = !!(todoData && todoData.id);

        state.todoModalContext = context;
        state.editingTodoId = isEditMode ? Number(todoData.id) : null;
        elements.todoForm.reset();
        elements.todoAssignType.disabled = false;
        elements.todoAssigneeId.disabled = false;
        updateTodoModalForMode(isEditMode);

        await ensureTodoAssignmentData(true);

        let assignType = 'contact';
        let assigneeId = null;

        if (isEditMode) {
            if (todoData.project_id) {
                assignType = 'project';
                assigneeId = todoData.project_id;
            } else if (todoData.contact_id) {
                assignType = 'contact';
                assigneeId = todoData.contact_id;
            }
        } else if (context && context.type === 'project') {
            assignType = 'project';
            assigneeId = context.id || null;
            elements.todoModalTitle.textContent = 'New To-Do for Project';
        } else if (context && context.type === 'contact') {
            assignType = 'contact';
            assigneeId = context.id || null;
            elements.todoModalTitle.textContent = 'New To-Do for Contact';
        }

        elements.todoAssignType.value = assignType;
        populateTodoAssigneeOptions(assignType, assigneeId);

        if (!isEditMode && context && context.locked) {
            elements.todoAssignType.disabled = true;
            elements.todoAssigneeId.disabled = true;
        }

        if (isEditMode) {
            elements.todoTitle.value = todoData.title || '';
            elements.todoDescription.value = todoData.description || '';
            elements.todoDueDate.value = todoData.due_date || '';
            if (elements.todoPriority) {
                elements.todoPriority.value = todoData.priority || '';
            }
        }

        elements.todoModal.classList.add('active');
        elements.todoTitle.focus();
    }

    async function openTodoEditModal(todoId) {
        if (!Number.isInteger(todoId) || todoId <= 0) {
            return;
        }

        try {
            const result = await api.getTodo(todoId);
            if (!result.success) {
                alert(result.error || 'Error loading to-do');
                return;
            }

            await openTodoModal(null, result.data);
        } catch (error) {
            console.error('Error loading to-do for editing:', error);
            alert('Error loading to-do');
        }
    }

    function closeTodoModal() {
        if (!elements.todoModal) {
            return;
        }

        elements.todoModal.classList.remove('active');
        state.todoModalContext = null;
        state.editingTodoId = null;
        if (elements.todoForm) {
            elements.todoForm.reset();
        }
        updateTodoModalForMode(false);
    }

    async function saveTodo(e) {
        e.preventDefault();

        const title = elements.todoTitle ? elements.todoTitle.value.trim() : '';
        const description = elements.todoDescription ? elements.todoDescription.value.trim() : '';
        const dueDate = elements.todoDueDate ? elements.todoDueDate.value : '';
        const priority = elements.todoPriority ? elements.todoPriority.value : '';
        const assignType = elements.todoAssignType ? elements.todoAssignType.value : 'contact';
        const assigneeIdRaw = elements.todoAssigneeId ? elements.todoAssigneeId.value : '';
        const assigneeId = parseInt(assigneeIdRaw, 10);

        if (!title) {
            alert('Please provide a title for the to-do.');
            return;
        }

        if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
            alert('Please choose a valid contact or project assignment.');
            return;
        }

        const payload = {
            title,
            description: description || null,
            due_date: dueDate || null,
            priority: priority || null,
            contact_id: null,
            project_id: null
        };

        if (assignType === 'project') {
            payload.project_id = assigneeId;
        } else {
            payload.contact_id = assigneeId;
        }

        if (elements.saveTodoBtn) {
            elements.saveTodoBtn.disabled = true;
            elements.saveTodoBtn.textContent = state.editingTodoId ? 'Saving...' : 'Creating...';
        }

        try {
            const result = state.editingTodoId
                ? await api.updateTodo(state.editingTodoId, payload)
                : await api.createTodo(payload);

            if (result.success) {
                closeTodoModal();
                await refreshVisibleTodoLists();
            } else {
                alert(result.error || (state.editingTodoId ? 'Error updating to-do' : 'Error creating to-do'));
            }
        } catch (error) {
            console.error(state.editingTodoId ? 'Error updating to-do:' : 'Error creating to-do:', error);
            alert(state.editingTodoId ? 'Error updating to-do' : 'Error creating to-do');
        } finally {
            if (elements.saveTodoBtn) {
                elements.saveTodoBtn.disabled = false;
                updateTodoModalForMode(!!state.editingTodoId);
            }
        }
    }

    async function setTodoCompletion(todoId, completed) {
        try {
            const result = await api.updateTodo(todoId, { is_completed: completed ? 1 : 0 });
            if (result.success) {
                await refreshVisibleTodoLists();
                return true;
            }

            alert(result.error || 'Error updating to-do');
            return false;
        } catch (error) {
            console.error('Error updating to-do:', error);
            alert('Error updating to-do');
            return false;
        }
    }

    async function removeTodo(todoId) {
        if (!confirm('Delete this to-do?')) {
            return false;
        }

        try {
            const result = await api.deleteTodo(todoId);
            if (result.success) {
                await refreshVisibleTodoLists();
                return true;
            }

            alert(result.error || 'Error deleting to-do');
            return false;
        } catch (error) {
            console.error('Error deleting to-do:', error);
            alert('Error deleting to-do');
            return false;
        }
    }

    async function refreshVisibleTodoLists() {
        const tasks = [];

        if (state.currentView === 'todos') {
            tasks.push(loadTodos());
        }

        if (state.viewingContactId) {
            tasks.push(loadContactTodos(state.viewingContactId));
        }

        if (state.viewingProjectId) {
            tasks.push(loadProjectTodos(state.viewingProjectId));
        }

        if (tasks.length > 0) {
            await Promise.all(tasks);
        }
    }

    function bindTodoListInteractions(container) {
        if (!container) {
            return;
        }

        container.addEventListener('change', async (e) => {
            const checkbox = e.target.closest('[data-todo-toggle]');
            if (!checkbox) {
                return;
            }

            const todoId = parseInt(checkbox.dataset.todoToggle, 10);
            if (!Number.isInteger(todoId)) {
                return;
            }

            const previousState = !checkbox.checked;
            const success = await setTodoCompletion(todoId, checkbox.checked);
            if (!success) {
                checkbox.checked = previousState;
            }
        });

        container.addEventListener('click', async (e) => {
            const editBtn = e.target.closest('[data-todo-edit]');
            if (editBtn) {
                const todoId = parseInt(editBtn.dataset.todoEdit, 10);
                if (Number.isInteger(todoId)) {
                    await openTodoEditModal(todoId);
                }
                return;
            }

            const deleteBtn = e.target.closest('[data-todo-delete]');
            if (deleteBtn) {
                const todoId = parseInt(deleteBtn.dataset.todoDelete, 10);
                if (Number.isInteger(todoId)) {
                    await removeTodo(todoId);
                }
                return;
            }

            const openContactBtn = e.target.closest('[data-todo-open-contact]');
            if (openContactBtn) {
                const contactId = parseInt(openContactBtn.dataset.todoOpenContact, 10);
                if (Number.isInteger(contactId)) {
                    openOverviewModal(contactId);
                }
                return;
            }

            const openProjectBtn = e.target.closest('[data-todo-open-project]');
            if (openProjectBtn) {
                const projectId = parseInt(openProjectBtn.dataset.todoOpenProject, 10);
                if (Number.isInteger(projectId)) {
                    openProjectOverview(projectId);
                }
            }
        });
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

            // Load and render to-dos
            await loadContactTodos(contactId);

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
        if (elements.contactTodosList) {
            elements.contactTodosList.innerHTML = '';
        }
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
            alert(error.message || 'Error saving contact');
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

        triggerCalendarDeckAnimation();
    }

    function triggerCalendarDeckAnimation() {
        if (!elements.calendarBody) {
            return;
        }

        let selector;
        if (state.calendarMode === 'month') {
            selector = '.cal-month-header-cell, .cal-month-cell';
        } else if (state.calendarMode === 'week') {
            selector = '.cal-week-day';
        } else {
            selector = '.cal-day-note, .cal-day-empty';
        }

        const animTargets = elements.calendarBody.querySelectorAll(selector);
        if (!animTargets || animTargets.length === 0) {
            return;
        }

        animTargets.forEach((el, index) => {
            el.style.setProperty('--cal-deck-order', Math.min(index, 26));
            el.classList.remove('calendar-anim-enter');
        });

        // Reflow ensures animation restarts when toggling modes quickly.
        void elements.calendarBody.offsetWidth;

        requestAnimationFrame(() => {
            animTargets.forEach((el) => {
                el.classList.add('calendar-anim-enter');
            });
        });
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

    function groupNotesByDate(entries) {
        const grouped = {};
        entries.forEach(entry => {
            if (!entry || !entry.created_at) {
                return;
            }
            const dateKey = entry.created_at.substring(0, 10);
            if (!grouped[dateKey]) {
                grouped[dateKey] = [];
            }
            grouped[dateKey].push(entry);
        });
        return grouped;
    }

    function getCalendarEntryType(entry) {
        const type = entry && entry.entry_type ? String(entry.entry_type) : '';
        if (type === 'project_note' || type === 'todo' || type === 'contact_activity' || type === 'project_activity') {
            return type;
        }
        return 'contact_note';
    }

    function getCalendarEntryTypeClass(entry) {
        const type = getCalendarEntryType(entry);
        if (type === 'project_note') return 'project-note';
        if (type === 'todo') return 'todo';
        if (type === 'contact_activity') return 'contact-activity';
        if (type === 'project_activity') return 'project-activity';
        return 'contact-note';
    }

    function getCalendarEntryTypeLabel(entry) {
        const type = getCalendarEntryType(entry);
        if (type === 'project_note') return 'Projekt-Notiz';
        if (type === 'todo') return 'To-do';
        if (type === 'contact_activity') return 'Kontakt-Update';
        if (type === 'project_activity') return 'Projekt-Update';
        return 'Kontakt-Notiz';
    }

    function getCalendarEntryTags(entry) {
        return Array.isArray(entry && entry.tags) ? entry.tags : [];
    }

    function getCalendarEntryContext(entry) {
        const type = getCalendarEntryType(entry);

        if (type === 'project_note' || type === 'project_activity') {
            return {
                primary: entry.project_name || 'Projekt',
                secondary: entry.project_company || ''
            };
        }

        if (type === 'todo') {
            if (entry.project_name) {
                const secondary = entry.contact_name
                    ? `${entry.contact_name}${entry.contact_company ? ` (${entry.contact_company})` : ''}`
                    : (entry.project_company || '');
                return {
                    primary: entry.project_name,
                    secondary: secondary
                };
            }

            return {
                primary: entry.contact_name || 'Kontakt',
                secondary: entry.contact_company || ''
            };
        }

        return {
            primary: entry.contact_name || 'Kontakt',
            secondary: entry.contact_company || ''
        };
    }

    function getCalendarEntryText(entry, maxLength = null) {
        const type = getCalendarEntryType(entry);
        let text = '';

        if (type === 'todo') {
            const title = (entry.title || '').trim();
            const description = (entry.description || '').trim();

            if (title && description) {
                text = `${title}: ${description}`;
            } else {
                text = title || description || (entry.content || '');
            }
        } else {
            text = (entry.content || '').trim();
        }

        if (!text) {
            if (type === 'todo') {
                text = 'To-do';
            } else if (type === 'contact_activity' || type === 'project_activity') {
                text = 'Aktivität';
            } else {
                text = 'Notiz';
            }
        }

        if (typeof maxLength === 'number' && maxLength > 0 && text.length > maxLength) {
            return `${text.substring(0, maxLength)}...`;
        }

        return text;
    }

    function getCalendarEntryMonthLabel(entry) {
        const type = getCalendarEntryType(entry);
        if (type === 'todo') {
            return entry.title || 'To-do';
        }

        const context = getCalendarEntryContext(entry);
        return context.primary;
    }

    function getCalendarEntryNavigationAttrs(entry) {
        const attrs = ['data-calendar-entry="1"'];
        const contactId = parseInt(entry.contact_id, 10);
        const projectId = parseInt(entry.project_id, 10);

        if (Number.isInteger(contactId) && contactId > 0) {
            attrs.push(`data-contact-id="${contactId}"`);
        }
        if (Number.isInteger(projectId) && projectId > 0) {
            attrs.push(`data-project-id="${projectId}"`);
        }

        return attrs.join(' ');
    }

    function isCalendarTodoCompleted(entry) {
        return getCalendarEntryType(entry) === 'todo' && Number(entry.is_completed) === 1;
    }

    function renderNoteChip(entry) {
        const context = getCalendarEntryContext(entry);
        const primary = escapeHtml(context.primary || '');
        const secondary = context.secondary ? escapeHtml(context.secondary) : '';
        const typeClass = getCalendarEntryTypeClass(entry);
        const typeLabel = escapeHtml(getCalendarEntryTypeLabel(entry));
        const content = escapeHtml(getCalendarEntryText(entry, 60));
        const tags = getCalendarEntryTags(entry);
        const navAttrs = getCalendarEntryNavigationAttrs(entry);
        const completedClass = isCalendarTodoCompleted(entry) ? ' is-completed' : '';
        const tagDots = tags.map(tag =>
            `<span class="cal-tag-dot" style="background:${tag.color}" title="${escapeHtml(tag.name)}"></span>`
        ).join('');

        return `<div class="cal-note-chip cal-note-chip--${typeClass}${completedClass}" ${navAttrs}>
            <div class="cal-note-chip-header">
                <span class="cal-note-person">${primary}</span>
                ${secondary ? `<span class="cal-note-company">${secondary}</span>` : ''}
                <span class="cal-note-type cal-note-type--${typeClass}">${typeLabel}</span>
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
                dayNotes.slice(0, maxShow).forEach(entry => {
                    const label = escapeHtml(getCalendarEntryMonthLabel(entry));
                    const preview = escapeHtml(getCalendarEntryText(entry, 140));
                    const tags = getCalendarEntryTags(entry);
                    const typeClass = getCalendarEntryTypeClass(entry);
                    const navAttrs = getCalendarEntryNavigationAttrs(entry);
                    const completedClass = isCalendarTodoCompleted(entry) ? ' is-completed' : '';
                    const tagDot = tags.length > 0
                        ? `<span class="cal-tag-dot-sm" style="background:${tags[0].color}"></span>`
                        : '';

                    html += `<div class="cal-month-note-dot cal-month-note-dot--${typeClass}${completedClass}" ${navAttrs} title="${preview}">
                        ${tagDot}<span class="cal-month-note-label">${label}</span>
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
            dayNotes.forEach(entry => {
                html += renderNoteChip(entry);
            });
            if (dayNotes.length === 0) {
                html += '<div class="cal-week-empty">Keine Aktivitaeten</div>';
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
                <p>Keine Aktivitaeten an diesem Tag</p>
            </div>`;
        } else {
            dayNotes.forEach(entry => {
                const time = entry.created_at ? entry.created_at.substring(11, 16) : '--:--';
                const context = getCalendarEntryContext(entry);
                const name = escapeHtml(context.primary || '');
                const company = context.secondary ? escapeHtml(context.secondary) : '';
                const typeClass = getCalendarEntryTypeClass(entry);
                const typeLabel = escapeHtml(getCalendarEntryTypeLabel(entry));
                const completedClass = isCalendarTodoCompleted(entry) ? ' is-completed' : '';
                const content = escapeHtml(getCalendarEntryText(entry));
                const navAttrs = getCalendarEntryNavigationAttrs(entry);
                const tags = getCalendarEntryTags(entry);
                const tagBadges = tags.map(tag =>
                    `<span class="cal-day-tag" style="background:${tag.color}20;color:${tag.color};border-color:${tag.color}">${escapeHtml(tag.name)}</span>`
                ).join('');
                const todoMeta = getCalendarEntryType(entry) === 'todo'
                    ? `<span class="cal-day-note-extra">${Number(entry.is_completed) === 1 ? 'Erledigt' : 'Offen'}${entry.due_date ? ` - Faellig ${escapeHtml(entry.due_date)}` : ''}</span>`
                    : '';

                html += `<div class="cal-day-note cal-day-note--${typeClass}${completedClass}" ${navAttrs}>
                    <div class="cal-day-note-time">${time}</div>
                    <div class="cal-day-note-body">
                        <div class="cal-day-note-meta">
                            <span class="cal-day-note-name">${name}</span>
                            ${company ? `<span class="cal-day-note-company">${company}</span>` : ''}
                            <span class="cal-day-note-type cal-day-note-type--${typeClass}">${typeLabel}</span>
                            ${todoMeta}
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
        // Click on activity cards -> open project or contact overview
        elements.calendarBody.querySelectorAll('[data-calendar-entry]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const projectId = parseInt(el.dataset.projectId, 10);
                const contactId = parseInt(el.dataset.contactId, 10);
                if (Number.isInteger(projectId) && projectId > 0) {
                    openProjectOverview(projectId);
                    return;
                }
                if (Number.isInteger(contactId) && contactId > 0) {
                    openOverviewModal(contactId);
                }
            });
        });

        // Click on day cells in month view -> switch to day view
        if (state.calendarMode === 'month') {
            elements.calendarBody.querySelectorAll('.cal-month-cell').forEach(cell => {
                cell.addEventListener('click', (e) => {
                    if (e.target.closest('[data-calendar-entry]')) return;
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

    function updateProjectsDashboard(projects) {
        const total = projects.length;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const STAGE_MODEL = {
            'Lead':        { base: 0.12, blend: 0.45, spread: 0.28 },
            'Proposal':    { base: 0.32, blend: 0.35, spread: 0.22 },
            'Negotiation': { base: 0.58, blend: 0.25, spread: 0.16 },
            'In Progress': { base: 0.82, blend: 0.12, spread: 0.10 },
            'Complete':    { base: 1.00, blend: 0.00, spread: 0.00 }
        };

        function clamp(value, min, max) {
            return Math.max(min, Math.min(max, value));
        }

        function parseNumber(v) {
            if (v === null || v === '' || v === undefined) {
                return null;
            }
            const num = parseFloat(v);
            return Number.isFinite(num) ? num : null;
        }

        function parseDate(dateValue) {
            if (!dateValue) {
                return null;
            }
            const date = new Date(`${dateValue}T00:00:00`);
            if (Number.isNaN(date.getTime())) {
                return null;
            }
            date.setHours(0, 0, 0, 0);
            return date;
        }

        function parseProjectBudget(project) {
            const minRaw = parseNumber(project.budget_min);
            const maxRaw = parseNumber(project.budget_max);

            if (minRaw === null && maxRaw === null) {
                return null;
            }

            let low = minRaw !== null ? minRaw : maxRaw;
            let high = maxRaw !== null ? maxRaw : minRaw;

            low = Math.max(0, low);
            high = Math.max(0, high);

            if (high < low) {
                const tmp = low;
                low = high;
                high = tmp;
            }

            return {
                low: low,
                high: high,
                mid: (low + high) / 2,
                isUndetermined: low === 0 && high === 0
            };
        }

        function getChanceModel(project) {
            const stageCfg = STAGE_MODEL[project.stage] || STAGE_MODEL.Lead;
            const chanceRaw = parseNumber(project.success_chance);
            const userP = chanceRaw === null ? null : clamp(chanceRaw / 100, 0, 1);

            let blendedP = userP === null
                ? stageCfg.base
                : (userP * (1 - stageCfg.blend)) + (stageCfg.base * stageCfg.blend);

            let timelineFactor = 1;
            let timelineSpread = 0;

            const completionDate = parseDate(project.estimated_completion);
            const startDate = parseDate(project.start_date);

            if (completionDate !== null) {
                const daysToCompletion = Math.round((completionDate - today) / 86400000);

                if (daysToCompletion > 365) {
                    timelineFactor = 0.91;
                    timelineSpread += 0.07;
                } else if (daysToCompletion > 180) {
                    timelineFactor = 0.95;
                    timelineSpread += 0.04;
                } else if (daysToCompletion > 90) {
                    timelineFactor = 0.98;
                    timelineSpread += 0.02;
                } else if (daysToCompletion < -30) {
                    timelineFactor = 0.94;
                    timelineSpread += 0.05;
                }
            } else {
                timelineFactor = 0.96;
                timelineSpread += 0.05;

                if (startDate !== null) {
                    const daysToStart = Math.round((startDate - today) / 86400000);
                    if (daysToStart > 90) {
                        timelineFactor *= 0.95;
                        timelineSpread += 0.03;
                    }
                }
            }

            let prob = clamp(blendedP * timelineFactor, 0, 1);

            if (project.stage === 'Complete' || userP === 1) {
                prob = 1;
            } else if (userP === 0) {
                prob = 0;
            }

            const spread = (project.stage === 'Complete' || userP === 1)
                ? 0
                : clamp(stageCfg.spread + timelineSpread + (userP === null ? 0.03 : 0), 0.05, 0.40);

            return {
                prob: prob,
                spread: spread,
                userP: userP
            };
        }

        function formatBudget(n) {
            if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
            if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
            return n.toFixed(0);
        }

        function formatCurrency(n) {
            return `${formatBudget(Math.round(n))} EUR`;
        }

        let sumMinPotential = 0;
        let sumMaxPotential = 0;
        let projectsWithBudget = 0;
        let guaranteedAtMax = 0;

        let weightedChanceSum = 0;
        let weightedChanceWeight = 0;

        let projConservative = 0;
        let projRealistic = 0;
        let projOptimistic = 0;
        let projIncluded = 0;
        let projExcluded = 0;
        const openProjects = projects.filter(p => p.stage !== 'Complete').length;

        projects.forEach((project) => {
            const budget = parseProjectBudget(project);
            const isOpen = project.stage !== 'Complete';

            if (!budget || budget.isUndetermined) {
                if (isOpen) {
                    projExcluded++;
                }
                return;
            }

            const chance = getChanceModel(project);
            const isGuaranteedMax = chance.userP === 1;

            projectsWithBudget++;
            if (isGuaranteedMax) {
                sumMinPotential += budget.high;
                sumMaxPotential += budget.high;
                guaranteedAtMax++;
            } else {
                sumMinPotential += budget.low;
                sumMaxPotential += budget.high;
            }

            if (!isOpen) {
                return;
            }

            const mode = budget.low + ((budget.high - budget.low) * chance.prob);
            const expectedBudget = (budget.low + budget.high + mode) / 3;
            const weight = expectedBudget > 0 ? expectedBudget : 1;

            weightedChanceSum += (chance.prob * 100) * weight;
            weightedChanceWeight += weight;

            if (isGuaranteedMax || chance.prob === 1) {
                projConservative += budget.high;
                projRealistic += budget.high;
                projOptimistic += budget.high;
            } else {
                const pLow = clamp(chance.prob - chance.spread, 0, 1);
                const pHigh = clamp(chance.prob + chance.spread, 0, 1);

                projConservative += budget.low * pLow;
                projRealistic += expectedBudget * chance.prob;
                projOptimistic += budget.high * pHigh;
            }

            projIncluded++;
        });

        const projectsUndetermined = total - projectsWithBudget;
        const avgChance = weightedChanceWeight > 0
            ? Math.round(weightedChanceSum / weightedChanceWeight)
            : null;

        const chanceText = avgChance !== null ? `${avgChance}%` : 'N/A';

        let potentialText;
        if (projectsWithBudget === 0 || (sumMinPotential === 0 && sumMaxPotential === 0)) {
            potentialText = 'Undetermined';
        } else if (sumMinPotential !== sumMaxPotential) {
            potentialText = `${formatBudget(sumMinPotential)} - ${formatBudget(sumMaxPotential)} EUR`;
        } else {
            potentialText = `${formatBudget(sumMaxPotential)} EUR`;
        }

        // Update expanded card view
        document.getElementById('dashTotalProjects').textContent = total;
        document.getElementById('dashTotalPotential').textContent = potentialText;
        document.getElementById('dashSuccessChance').textContent = chanceText;

        const potentialSub = document.getElementById('dashPotentialSub');
        if (potentialSub) {
            if (projectsWithBudget === 0) {
                potentialSub.textContent = 'No budget data available';
            } else {
                const parts = [`${projectsWithBudget} of ${total} projects with budget`];
                if (projectsUndetermined > 0) {
                    parts.push(`${projectsUndetermined} undetermined`);
                }
                if (guaranteedAtMax > 0) {
                    parts.push(`${guaranteedAtMax} at 100% counted with max budget`);
                }
                potentialSub.textContent = parts.join(' - ');
            }
        }

        // Update compact bar stats
        const dashBarProjects = document.getElementById('dashBarProjects');
        const dashBarPotential = document.getElementById('dashBarPotential');
        const dashBarChance = document.getElementById('dashBarChance');
        if (dashBarProjects) dashBarProjects.textContent = total;
        if (dashBarPotential) dashBarPotential.textContent = potentialText;
        if (dashBarChance) dashBarChance.textContent = chanceText;

        const hasProjection = projIncluded > 0 && projOptimistic > 0;
        const projConText = hasProjection ? formatCurrency(projConservative) : '--';
        const projRelText = hasProjection ? formatCurrency(projRealistic) : '--';
        const projOptText = hasProjection ? formatCurrency(projOptimistic) : '--';

        let projSubText;
        if (projIncluded === 0) {
            projSubText = 'No open projects with usable budget data';
        } else {
            const projParts = [`${projIncluded} of ${openProjects} open projects included`];
            if (projExcluded > 0) {
                projParts.push(`${projExcluded} missing budget data`);
            }
            if (guaranteedAtMax > 0) {
                projParts.push(`100% projects fixed at max budget`);
            }
            projSubText = projParts.join(' - ');
        }

        ['dashProjConservative', 'dashProjRealistic', 'dashProjOptimistic', 'dashProjSub'].forEach((id, idx) => {
            const el = document.getElementById(id);
            if (!el) {
                return;
            }

            if (idx === 0) el.textContent = projConText;
            if (idx === 1) el.textContent = projRelText;
            if (idx === 2) el.textContent = projOptText;
            if (idx === 3) el.textContent = projSubText;
        });

        const dashBarProjection = document.getElementById('dashBarProjection');
        if (dashBarProjection) {
            dashBarProjection.textContent = hasProjection ? `~${formatCurrency(projRealistic)}` : '--';
        }
    }
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
                updateProjectsDashboard(state.projects);
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

        triggerProjectDeckAnimation();
    }

    function triggerProjectDeckAnimation() {
        if (!elements.projectsList) {
            return;
        }

        const cards = elements.projectsList.querySelectorAll('.project-card');
        if (!cards || cards.length === 0) {
            return;
        }

        cards.forEach((card, index) => {
            card.style.setProperty('--deck-order', Math.min(index, 18));
            card.classList.remove('project-card--deck-enter');
        });

        // Reflow ensures animation restarts consistently after fast filter updates.
        void elements.projectsList.offsetWidth;

        requestAnimationFrame(() => {
            cards.forEach((card) => {
                card.classList.add('project-card--deck-enter');
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

        const bMin = (project.budget_min !== null && project.budget_min !== '' && project.budget_min !== undefined) ? parseFloat(project.budget_min) : null;
        const bMax = (project.budget_max !== null && project.budget_max !== '' && project.budget_max !== undefined) ? parseFloat(project.budget_max) : null;

        const formatAmount = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);

        let budget;
        if (bMin === null && bMax === null) {
            budget = 'N/A';
        } else if (bMin === 0 && bMax === 0) {
            budget = 'Undetermined';
        } else if (bMin !== null && bMax !== null) {
            budget = bMin === bMax
                ? `${formatAmount(bMin)} EUR`
                : `${formatAmount(bMin)} - ${formatAmount(bMax)} EUR`;
        } else if (bMin !== null) {
            budget = `${formatAmount(bMin)} EUR`;
        } else {
            budget = `${formatAmount(bMax)} EUR`;
        }

        const chanceRaw = project.success_chance !== null && project.success_chance !== '' ? parseFloat(project.success_chance) : null;
        const chanceValue = Number.isFinite(chanceRaw) ? Math.max(0, Math.min(100, chanceRaw)) : null;
        const successChance = chanceValue !== null ? `${Math.round(chanceValue)}%` : 'N/A';

        const descriptionText = (project.description || '').trim();
        const summary = descriptionText
            ? `${escapeHtml(descriptionText).substring(0, 140)}${descriptionText.length > 140 ? '...' : ''}`
            : 'No description yet';

        const stageLabel = project.stage || 'Lead';
        const stageClass = stageLabel.toLowerCase().replace(/ /g, '-');

        const progressMarkup = chanceValue !== null ? `
            <div class="project-card-progress">
                <div class="project-card-progress-track">
                    <div class="project-card-progress-fill" style="width: ${chanceValue}%;"></div>
                </div>
                <span class="project-card-progress-label">${Math.round(chanceValue)}% confidence</span>
            </div>
        ` : `
            <div class="project-card-progress project-card-progress--empty">
                <span class="project-card-progress-label">Success chance not set</span>
            </div>
        `;

        return `
            <div class="project-card" data-id="${project.id}">
                <div class="project-card-head">
                    <div class="project-card-title-wrap">
                        <h3 class="project-card-title">${escapeHtml(project.name)}</h3>
                        <p class="project-card-company${project.company ? '' : ' is-empty'}">${project.company ? escapeHtml(project.company) : '&nbsp;'}</p>
                    </div>
                    <span class="project-stage-badge stage-${stageClass}">${escapeHtml(stageLabel)}</span>
                </div>
                <div class="project-card-metrics">
                    <span class="project-metric-chip">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/>
                        </svg>
                        <span>${startDate}</span>
                    </span>
                    <span class="project-metric-chip">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>
                        </svg>
                        <span>${budget}</span>
                    </span>
                    <span class="project-metric-chip">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                        </svg>
                        <span>${successChance} chance</span>
                    </span>
                </div>
                ${progressMarkup}
                <p class="project-card-description">${summary}</p>
                <div class="project-card-footer">
                    <span class="project-card-cta">Open details</span>
                </div>
            </div>
        `;
    }

    function openProjectModal(project = null) {
        state.editingProjectId = project && project.id ? project.id : null;

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
                result = await api.updateProject(state.editingProjectId, formData);
            } else {
                result = await api.createProject(formData);
            }

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
                // Only close project modal if it's currently open
                if (elements.projectModal.classList.contains('active')) {
                    closeProjectModal();
                }
                state.editingProjectId = null;
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

            // Ensure contacts are loaded for autocomplete
            if (!state.contacts || state.contacts.length === 0) {
                await loadAllContacts();
            }

            const [projectResult, contactsResult, tagsResult, notesResult, todosResult] = await Promise.all([
                api.getProject(projectId),
                api.getProjectContacts(projectId),
                api.getProjectTags(projectId),
                api.getProjectNotes(projectId),
                api.getTodos({ project_id: projectId, status: 'all' })
            ]);

            if (projectResult.success) {
                state.viewingProject = projectResult.data;
                renderProjectOverview(
                    projectResult.data,
                    contactsResult.data || [],
                    tagsResult.data || [],
                    notesResult.success ? (notesResult.data || []) : [],
                    todosResult.success ? (todosResult.data || []) : []
                );
                elements.projectOverviewModal.classList.add('active');
            } else {
                alert('Error: ' + projectResult.error);
            }
        } catch (error) {
            console.error('Error opening project overview:', error);
            alert('An error occurred while loading the project');
        }
    }

    function renderProjectOverview(project, contacts, tags, notes = [], todos = []) {
        elements.projectOverviewName.textContent = project.name;
        elements.projectOverviewCompany.textContent = project.company || 'No company assigned';

        // Format dates as absolute dates
        elements.projectOverviewStartDate.textContent = project.start_date
            ? new Date(project.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : 'N/A';
        elements.projectOverviewStage.textContent = project.stage || 'N/A';

        const ovBMin = (project.budget_min !== null && project.budget_min !== '' && project.budget_min !== undefined) ? parseFloat(project.budget_min) : null;
        const ovBMax = (project.budget_max !== null && project.budget_max !== '' && project.budget_max !== undefined) ? parseFloat(project.budget_max) : null;
        let budget;
        if (ovBMin === null && ovBMax === null) {
            budget = 'N/A';
        } else if (ovBMin === 0 && ovBMax === 0) {
            budget = 'Undetermined';
        } else if (ovBMin !== null && ovBMax !== null) {
            budget = ovBMin === ovBMax
                ? `${ovBMin.toFixed(0)} €`
                : `${ovBMin.toFixed(0)} – ${ovBMax.toFixed(0)} €`;
        } else if (ovBMin !== null) {
            budget = `${ovBMin.toFixed(0)} €`;
        } else {
            budget = `${ovBMax.toFixed(0)} €`;
        }
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

        // Render to-dos
        renderTodoCollection(elements.projectTodosList, todos, {
            showContext: false,
            emptyMessage: 'No to-dos yet for this project'
        });

        // Render notes
        renderProjectNotesTimeline(notes);
    }

    function renderProjectTags(tags) {
        if (!tags || tags.length === 0) {
            elements.projectTags.innerHTML = '<p class="empty-hint">No tags assigned</p>';
            return;
        }

        const html = tags.map(tag => `
            <span class="tag" style="background-color: ${tag.color}20; color: ${tag.color};">
                ${escapeHtml(tag.name)}
                <button class="tag-remove" data-remove-tag="${tag.id}" title="Remove tag">&times;</button>
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
                <button class="btn btn-icon btn-small" data-remove-contact="${contact.id}" title="Remove contact">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                    </svg>
                </button>
            </div>
        `).join('');

        elements.projectContacts.innerHTML = html;
    }

    async function loadProjectNotes(projectId) {
        if (!elements.projectNotesTimeline) {
            return;
        }

        try {
            const result = await api.getProjectNotes(projectId);
            if (result.success) {
                renderProjectNotesTimeline(result.data || []);
            } else {
                renderProjectNotesTimeline([]);
            }
        } catch (error) {
            console.error('Error loading project notes:', error);
        }
    }

    function renderProjectNotesTimeline(notes) {
        if (!elements.projectNotesTimeline) {
            return;
        }

        if (!notes || notes.length === 0) {
            elements.projectNotesTimeline.innerHTML = `
                <div class="notes-empty">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
                        <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
                    </svg>
                    <p>No notes yet for this project</p>
                </div>
            `;
            return;
        }

        let html = '';
        notes.forEach(note => {
            const date = new Date(note.created_at);
            const formattedDate = formatDate(date);

            html += `
                <div class="note-item">
                    <div class="note-header">
                        <span class="note-date">${formattedDate}</span>
                        <button class="note-delete-btn project-note-delete-btn" data-note-id="${note.id}" title="Delete note">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="note-content">${escapeHtml(note.content)}</div>
                </div>
            `;
        });

        elements.projectNotesTimeline.innerHTML = html;

        elements.projectNotesTimeline.querySelectorAll('.project-note-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const noteId = parseInt(btn.dataset.noteId, 10);
                await deleteProjectNote(noteId);
            });
        });
    }

    async function addProjectNote() {
        if (!elements.newProjectNoteContent || !state.viewingProjectId) {
            return;
        }

        const content = elements.newProjectNoteContent.value.trim();
        if (!content) {
            return;
        }

        if (elements.addProjectNoteBtn) {
            elements.addProjectNoteBtn.disabled = true;
            elements.addProjectNoteBtn.innerHTML = 'Adding...';
        }

        try {
            const result = await api.createProjectNote(state.viewingProjectId, content);
            if (result.success) {
                elements.newProjectNoteContent.value = '';
                await loadProjectNotes(state.viewingProjectId);
            } else {
                alert(result.error || 'Error adding note');
            }
        } catch (error) {
            console.error('Error adding project note:', error);
            alert('Error adding note');
        } finally {
            if (elements.addProjectNoteBtn) {
                elements.addProjectNoteBtn.disabled = false;
                elements.addProjectNoteBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                    </svg>
                    Add Note
                `;
            }
        }
    }

    async function deleteProjectNote(noteId) {
        if (!confirm('Delete this note?')) {
            return;
        }

        try {
            const result = await api.deleteProjectNote(noteId);
            if (result.success) {
                if (state.viewingProjectId) {
                    await loadProjectNotes(state.viewingProjectId);
                }
            } else {
                alert(result.error || 'Error deleting note');
            }
        } catch (error) {
            console.error('Error deleting project note:', error);
            alert('Error deleting note');
        }
    }

    function closeProjectOverview() {
        elements.projectOverviewModal.classList.remove('active');
        state.viewingProjectId = null;
        state.viewingProject = null;

        if (elements.newProjectNoteContent) {
            elements.newProjectNoteContent.value = '';
        }

        if (elements.projectNotesTimeline) {
            elements.projectNotesTimeline.innerHTML = '';
        }

        if (elements.projectTodosList) {
            elements.projectTodosList.innerHTML = '';
        }
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
        const lowerQuery = query.toLowerCase();
        const filtered = (state.allTags || []).filter(tag =>
            tag.name.toLowerCase().includes(lowerQuery)
        ).slice(0, 10);

        if (filtered.length === 0) {
            // Show "create new" option when no match
            elements.projectTagSuggestions.innerHTML = `
                <div class="tag-suggestion" data-tag-name="${escapeHtml(query)}">
                    <span>Create "${escapeHtml(query)}"</span>
                </div>
            `;
            elements.projectTagSuggestions.style.display = 'block';
            return;
        }

        const html = filtered.map(tag => `
            <div class="tag-suggestion" data-tag-name="${escapeHtml(tag.name)}">
                <span class="tag-color" style="background-color: ${tag.color};"></span>
                <span>${escapeHtml(tag.name)}</span>
            </div>
        `).join('');

        elements.projectTagSuggestions.innerHTML = html;
        elements.projectTagSuggestions.style.display = 'block';
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

        // Use data-contact-id attributes instead of inline onclick (avoids pointer-event issues)
        const html = filtered.map(contact => `
            <div class="contact-suggestion" data-contact-id="${contact.id}">
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

        // Use data-company attributes instead of inline onclick
        const html = companies.map(company => `
            <div class="autocomplete-suggestion" data-company="${escapeHtml(company)}">
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

        // To-do search (debounced)
        const debouncedTodoSearch = debounce(() => {
            state.todoSearchQuery = elements.searchTodosInput.value.trim();
            loadTodos();
        }, 300);

        if (elements.searchTodosInput) {
            elements.searchTodosInput.addEventListener('input', debouncedTodoSearch);
        }

        if (elements.todoContactFilter) {
            elements.todoContactFilter.addEventListener('change', () => {
                state.todoContactFilterId = elements.todoContactFilter.value;
                loadTodos();
            });
        }

        if (elements.todoProjectFilter) {
            elements.todoProjectFilter.addEventListener('change', () => {
                state.todoProjectFilterId = elements.todoProjectFilter.value;
                loadTodos();
            });
        }

        if (elements.todoStatusFilter) {
            elements.todoStatusFilter.addEventListener('change', () => {
                state.todoStatusFilter = elements.todoStatusFilter.value;
                loadTodos();
            });
        }

        if (elements.todoSort) {
            elements.todoSort.addEventListener('change', () => {
                state.todoSortBy = elements.todoSort.value || 'default';
                loadTodos();
            });
        }

        if (elements.addTodoBtn) {
            elements.addTodoBtn.addEventListener('click', () => openTodoModal());
        }

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

        // To-do filter toggle (mobile - collapsible controls)
        const todoFilterToggle = document.getElementById('todoFilterToggle');
        const todoFilterControls = document.getElementById('todoFilterControls');

        if (todoFilterToggle && todoFilterControls) {
            todoFilterToggle.addEventListener('click', () => {
                todoFilterControls.classList.toggle('open');
                todoFilterToggle.classList.toggle('active');
            });
        }

        // Project controls toggle (mobile - collapsible controls)
        const projectFilterToggle = document.getElementById('projectFilterToggle');
        const projectControls = document.getElementById('projectControls');

        if (projectFilterToggle && projectControls) {
            projectFilterToggle.addEventListener('click', () => {
                projectControls.classList.toggle('open');
                projectFilterToggle.classList.toggle('active');
            });
        }

        if (elements.addContactBtn) {
            elements.addContactBtn.addEventListener('click', () => openContactModal());
        }

        if (elements.themeToggleBtn) {
            elements.themeToggleBtn.addEventListener('click', toggleTheme);
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
        if (elements.addContactTodoBtn) {
            elements.addContactTodoBtn.addEventListener('click', () => {
                if (!state.viewingContactId) {
                    return;
                }
                openTodoModal({ type: 'contact', id: state.viewingContactId, locked: true });
            });
        }

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

        // Dashboard collapse/expand toggle
        const dashboardBar = document.getElementById('dashboardBar');
        const dashboardToggleBtn = document.getElementById('dashboardToggleBtn');
        if (dashboardBar) {
            const wrapper = document.getElementById('dashboardWrapper');
            if (wrapper) {
                const isExpanded = wrapper.classList.contains('expanded');
                dashboardBar.setAttribute('aria-expanded', String(isExpanded));
                if (dashboardToggleBtn) {
                    dashboardToggleBtn.setAttribute('aria-expanded', String(isExpanded));
                }
            }

            dashboardBar.addEventListener('click', () => {
                const wrapperEl = document.getElementById('dashboardWrapper');
                if (!wrapperEl) {
                    return;
                }

                const isExpanding = wrapperEl.classList.contains('collapsed');
                wrapperEl.classList.toggle('collapsed', !isExpanding);
                wrapperEl.classList.toggle('expanded', isExpanding);

                dashboardBar.setAttribute('aria-expanded', String(isExpanding));
                if (dashboardToggleBtn) {
                    dashboardToggleBtn.setAttribute('aria-expanded', String(isExpanding));
                }
            });
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

        if (elements.addProjectNoteBtn) {
            elements.addProjectNoteBtn.addEventListener('click', addProjectNote);
        }

        if (elements.addProjectTodoBtn) {
            elements.addProjectTodoBtn.addEventListener('click', () => {
                if (!state.viewingProjectId) {
                    return;
                }
                openTodoModal({ type: 'project', id: state.viewingProjectId, locked: true });
            });
        }

        if (elements.newProjectNoteContent) {
            elements.newProjectNoteContent.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    addProjectNote();
                }
            });
        }

        // Delete from overview — opens the same confirmation modal
        if (elements.deleteProjectOverviewBtn) {
            elements.deleteProjectOverviewBtn.addEventListener('click', () => {
                if (state.viewingProject) {
                    const project = state.viewingProject;
                    // Set editingProjectId so deleteProject() knows which to delete
                    state.editingProjectId = project.id;
                    elements.deleteProjectName.textContent = project.name;
                    closeProjectOverview();
                    elements.deleteProjectModal.classList.add('active');
                }
            });
        }

        if (elements.editProjectBtn) {
            elements.editProjectBtn.addEventListener('click', () => {
                // Save project BEFORE closeProjectOverview() nulls it
                const projectToEdit = state.viewingProject;
                closeProjectOverview();
                openProjectModal(projectToEdit);
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

        // Project contact add button — match first suggestion if any
        if (elements.addProjectContactBtn) {
            elements.addProjectContactBtn.addEventListener('click', () => {
                const query = elements.newProjectContactInput.value.trim();
                if (!query) return;

                if (!state.contacts || state.contacts.length === 0) {
                    alert('No contacts loaded. Please wait and try again.');
                    return;
                }

                // First try exact match, then partial match
                const exactMatch = state.contacts.find(c =>
                    c.name.toLowerCase() === query.toLowerCase()
                );
                const partialMatch = state.contacts.find(c =>
                    c.name.toLowerCase().includes(query.toLowerCase())
                );
                const contact = exactMatch || partialMatch;

                if (contact) {
                    addProjectContact(contact.id);
                } else {
                    alert('Contact not found. Please select from the suggestions dropdown.');
                }
            });
        }

        // Company autocomplete
        if (elements.projectCompany) {
            elements.projectCompany.addEventListener('input', () => {
                const query = elements.projectCompany.value.trim();
                if (query.length > 0) {
                    // Ensure contacts are loaded for company suggestions
                    if (!state.contacts || state.contacts.length === 0) {
                        loadAllContacts().then(() => showCompanySuggestions(query));
                    } else {
                        showCompanySuggestions(query);
                    }
                } else {
                    if (elements.projectCompanySuggestions) {
                        elements.projectCompanySuggestions.classList.remove('visible');
                    }
                }
            });

            elements.projectCompany.addEventListener('blur', () => {
                // Small delay so mousedown on a suggestion can fire first
                setTimeout(() => {
                    if (elements.projectCompanySuggestions) {
                        elements.projectCompanySuggestions.classList.remove('visible');
                    }
                }, 150);
            });
        }

        // Mousedown on company suggestions (fires before blur, bypasses overflow clipping)
        if (elements.projectCompanySuggestions) {
            elements.projectCompanySuggestions.addEventListener('mousedown', (e) => {
                e.preventDefault(); // prevent input blur
                const item = e.target.closest('[data-company]');
                if (item) {
                    selectCompany(item.dataset.company);
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

            elements.newProjectTagInput.addEventListener('blur', () => {
                // Delay so mousedown on a suggestion fires first
                setTimeout(() => {
                    elements.projectTagSuggestions.style.display = 'none';
                }, 150);
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

        // Project contact input + suggestion selection via mousedown delegation
        if (elements.newProjectContactInput) {
            elements.newProjectContactInput.addEventListener('input', () => {
                const query = elements.newProjectContactInput.value.trim();
                if (query.length > 0) {
                    showProjectContactSuggestions(query);
                } else {
                    elements.projectContactSuggestions.style.display = 'none';
                }
            });

            elements.newProjectContactInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const first = elements.projectContactSuggestions.querySelector('[data-contact-id]');
                    if (first) {
                        addProjectContact(parseInt(first.dataset.contactId, 10));
                    }
                }
            });
        }

        // Mousedown on contact suggestions (fires before blur, bypasses overflow clipping)
        if (elements.projectContactSuggestions) {
            elements.projectContactSuggestions.addEventListener('mousedown', (e) => {
                e.preventDefault(); // prevent input blur
                const item = e.target.closest('[data-contact-id]');
                if (item) {
                    addProjectContact(parseInt(item.dataset.contactId, 10));
                }
            });
        }

        // Mousedown on tag suggestions (same pattern — prevents blur, works inside overflow)
        if (elements.projectTagSuggestions) {
            elements.projectTagSuggestions.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const item = e.target.closest('[data-tag-name]');
                if (item) {
                    addProjectTag(item.dataset.tagName);
                }
            });
        }

        // Delegation for contact remove buttons (rendered dynamically)
        if (elements.projectContacts) {
            elements.projectContacts.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-remove-contact]');
                if (btn) {
                    removeProjectContact(parseInt(btn.dataset.removeContact, 10));
                }
            });
        }

        // Delegation for tag remove buttons (rendered dynamically)
        if (elements.projectTags) {
            elements.projectTags.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-remove-tag]');
                if (btn) {
                    removeProjectTag(parseInt(btn.dataset.removeTag, 10));
                }
            });
        }

        // To-do list interactions
        bindTodoListInteractions(elements.todosList);
        bindTodoListInteractions(elements.contactTodosList);
        bindTodoListInteractions(elements.projectTodosList);

        // To-do modal
        if (elements.closeTodoModal) {
            elements.closeTodoModal.addEventListener('click', closeTodoModal);
        }
        if (elements.cancelTodoBtn) {
            elements.cancelTodoBtn.addEventListener('click', closeTodoModal);
        }
        if (elements.todoModal) {
            const todoBackdrop = elements.todoModal.querySelector('.modal-backdrop');
            if (todoBackdrop) {
                todoBackdrop.addEventListener('click', closeTodoModal);
            }
        }
        if (elements.todoForm) {
            elements.todoForm.addEventListener('submit', saveTodo);
        }
        if (elements.todoAssignType) {
            elements.todoAssignType.addEventListener('change', () => {
                populateTodoAssigneeOptions(elements.todoAssignType.value);
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
                } else if (elements.todoModal.classList.contains('active')) {
                    closeTodoModal();
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
        applyTheme(getStoredTheme(), false);

        initEventListeners();
        initImportExportEvents();
        initCalendarEvents();
        initMap();

        // Load all tags for suggestions and calendar filter
        loadAllTags().then(() => {
            populateCalendarTagFilter();
        });

        // Load initial data based on current view
        if (state.currentView === 'projects') {
            loadProjects();
            loadAllContacts();
        } else if (state.currentView === 'todos') {
            loadTodos();
        } else if (state.currentView === 'map') {
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







