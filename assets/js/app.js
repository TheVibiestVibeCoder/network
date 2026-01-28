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
        map: null,
        markers: null
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
        confirmDeleteBtn: document.getElementById('confirmDeleteBtn')
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
        }
    };

    // ============================================
    // Map Functions
    // ============================================

    function initMap() {
        // Initialize the map centered on a world view
        state.map = L.map(elements.mapContainer).setView([30, 0], 2);

        // Add OpenStreetMap tile layer
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19
        }).addTo(state.map);

        // Initialize marker cluster group
        state.markers = L.markerClusterGroup({
            chunkedLoading: true,
            spiderfyOnMaxZoom: true,
            showCoverageOnHover: false,
            zoomToBoundsOnClick: true,
            maxClusterRadius: 50
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

                // Store contact ID on marker for editing
                marker.contactId = contact.id;

                // Add click handler to edit contact
                marker.on('click', function() {
                    // Popup opens automatically, but we can add additional behavior here
                });

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

        html += `<button class="popup-edit-btn" onclick="window.CRM.editContact(${contact.id})">Edit Contact</button>`;
        html += `</div>`;

        return html;
    }

    // ============================================
    // List Functions
    // ============================================

    async function loadContacts() {
        try {
            const result = await api.getContacts(
                state.searchQuery,
                state.sortField,
                state.sortOrder
            );

            if (result.success) {
                state.contacts = result.data;
                renderContactsList();
            }
        } catch (error) {
            console.error('Error loading contacts:', error);
            elements.contactsList.innerHTML = '<div class="error-message">Error loading contacts</div>';
        }
    }

    function renderContactsList() {
        if (state.contacts.length === 0) {
            elements.contactsList.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                    </svg>
                    <h3>No contacts found</h3>
                    <p>${state.searchQuery ? 'Try a different search term' : 'Add your first contact to get started'}</p>
                </div>
            `;
            return;
        }

        const html = state.contacts.map(contact => createContactCard(contact)).join('');
        elements.contactsList.innerHTML = html;

        // Add click handlers to contact cards
        elements.contactsList.querySelectorAll('.contact-card').forEach(card => {
            card.addEventListener('click', () => {
                const id = parseInt(card.dataset.id, 10);
                editContact(id);
            });
        });
    }

    function createContactCard(contact) {
        const hasLocation = contact.latitude && contact.longitude;

        return `
            <div class="contact-card" data-id="${contact.id}">
                <div class="contact-avatar">
                    ${getInitials(contact.name)}
                </div>
                <div class="contact-info">
                    <h3 class="contact-name">${escapeHtml(contact.name)}</h3>
                    ${contact.company ? `<p class="contact-company">${escapeHtml(contact.company)}</p>` : ''}
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

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Escape to close modals
            if (e.key === 'Escape') {
                if (elements.deleteModal.classList.contains('active')) {
                    closeDeleteModal();
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
        initMap();

        // Load initial data based on current view
        if (state.currentView === 'map') {
            loadMapMarkers();
        } else {
            loadContacts();
        }
    }

    // Expose editContact function globally for map popup buttons
    window.CRM = {
        editContact: editContact
    };

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
