/**
 * Simple CRM - Frontend Application
 * Handles map, list view, and contact management
 */

(function() {
    'use strict';

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
        selectedImportFile: null
    };

    // ============================================
    // DOM Elements
    // ============================================

    const elements = {
        // Views
        mapView: document.getElementById('mapView'),
        listView: document.getElementById('listView'),
        mapContainer: document.getElementById('map'),

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
        importErrorList: document.getElementById('importErrorList')
    };

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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async updateContact(id, data) {
            const response = await fetch(`api/contacts.php?id=${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async deleteContact(id) {
            const response = await fetch(`api/contacts.php?id=${id}`, {
                method: 'DELETE'
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contact_id: contactId, content })
            });
            return response.json();
        },

        async deleteNote(id) {
            const response = await fetch(`api/notes.php?id=${id}`, {
                method: 'DELETE'
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color })
            });
            return response.json();
        },

        async assignTag(contactId, tagId) {
            const response = await fetch('api/tags.php?action=assign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contact_id: contactId, tag_id: tagId })
            });
            return response.json();
        },

        async unassignTag(contactId, tagId) {
            const response = await fetch('api/tags.php?action=unassign', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contact_id: contactId, tag_id: tagId })
            });
            return response.json();
        },

        async deleteTag(id) {
            const response = await fetch(`api/tags.php?id=${id}`, {
                method: 'DELETE'
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
            scrollWheelZoom: true,
            doubleClickZoom: true,
            touchZoom: true,
            dragging: true,
            tap: true,
            boxZoom: true,
            keyboard: true
        });

        // Add dark CartoDB Dark Matter tile layer
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
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
                const marker = L.marker([contact.latitude, contact.longitude]);

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

    function renderContactsListByTags() {
        const data = state.taggedData;
        if (!data) return;

        const totalContacts = data.tags.reduce((sum, t) => sum + t.contacts.length, 0) + data.untagged.length;

        if (totalContacts === 0) {
            elements.contactsList.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                    </svg>
                    <h3>Keine Kontakte gefunden</h3>
                    <p>Füge deinen ersten Kontakt hinzu</p>
                </div>
            `;
            return;
        }

        let html = '';

        // Render tagged groups
        data.tags.forEach(tag => {
            if (tag.contacts.length > 0) {
                html += `<div class="tag-group">`;
                html += `<div class="tag-header" style="border-left-color: ${tag.color}">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="${tag.color}">
                        <path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>
                    </svg>
                    <span>${escapeHtml(tag.name)}</span>
                    <span class="tag-count" style="background-color: ${tag.color}">${tag.contacts.length}</span>
                </div>`;
                html += tag.contacts.map(contact => createContactCard(contact, true)).join('');
                html += `</div>`;
            }
        });

        // Render untagged contacts
        if (data.untagged.length > 0) {
            html += `<div class="tag-group untagged-group">`;
            html += `<div class="tag-header tag-header-untagged">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>
                </svg>
                <span>Ohne Tag</span>
                <span class="tag-count">${data.untagged.length}</span>
            </div>`;
            html += data.untagged.map(contact => createContactCard(contact, true)).join('');
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

        // Convert to array and sort by company name
        const groups = [];

        // Add company groups first (sorted by company name)
        const sortedCompanies = Array.from(companyMap.keys()).sort((a, b) =>
            a.toLowerCase().localeCompare(b.toLowerCase())
        );

        sortedCompanies.forEach(company => {
            groups.push({
                company: company,
                contacts: companyMap.get(company)
            });
        });

        // Add contacts without company at the end
        if (noCompany.length > 0) {
            groups.push({
                company: null,
                contacts: noCompany
            });
        }

        return groups;
    }

    function createContactCard(contact, inGroup = false) {
        const hasLocation = contact.latitude && contact.longitude;

        return `
            <div class="contact-card${inGroup ? ' in-group' : ''}" data-id="${contact.id}">
                <div class="contact-avatar">
                    ${getInitials(contact.name)}
                </div>
                <div class="contact-info">
                    <h3 class="contact-name">${escapeHtml(contact.name)}</h3>
                    ${!inGroup && contact.company ? `<p class="contact-company">${escapeHtml(contact.company)}</p>` : ''}
                    ${contact.location ? `
                        <p class="contact-location">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                            </svg>
                            ${escapeHtml(contact.location)}
                            ${hasLocation ? '<span class="location-badge">On Map</span>' : ''}
                        </p>
                    ` : ''}
                    ${contact.email ? `<p class="contact-email">${escapeHtml(contact.email)}</p>` : ''}
                    ${contact.phone ? `<p class="contact-phone">${escapeHtml(contact.phone)}</p>` : ''}
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

        // Refresh data for the active view
        if (view === 'map') {
            // Force map to recalculate size after becoming visible
            setTimeout(() => {
                state.map.invalidateSize();
            }, 100);
            loadMapMarkers();
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
            html += `
                <div class="detail-item">
                    <span class="detail-icon">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                        </svg>
                    </span>
                    <div class="detail-content">
                        <span class="detail-label">Location</span>
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
                        <a href="${escapeHtml(contact.website)}" target="_blank" class="detail-value detail-link">${escapeHtml(contact.website)}</a>
                    </div>
                </div>
            `;
        }

        if (contact.address) {
            html += `
                <div class="detail-item detail-item-full">
                    <span class="detail-icon">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
                        </svg>
                    </span>
                    <div class="detail-content">
                        <span class="detail-label">Address</span>
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
    // Helper Functions
    // ============================================

    function refreshData() {
        if (state.currentView === 'map') {
            loadMapMarkers();
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
            loadContacts();
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

        // Add contact button
        elements.addContactBtn.addEventListener('click', () => openContactModal());

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

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Escape to close modals
            if (e.key === 'Escape') {
                if (elements.deleteModal.classList.contains('active')) {
                    closeDeleteModal();
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
        initMap();

        // Load all tags for suggestions
        loadAllTags();

        // Load initial data based on current view
        if (state.currentView === 'map') {
            loadMapMarkers();
        } else {
            loadContacts();
        }
    }

    // Expose functions globally for map popup buttons
    window.CRM = {
        editContact: editContact,
        openOverview: openOverviewModal
    };

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
