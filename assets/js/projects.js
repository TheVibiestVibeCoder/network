/**
 * Project Management Frontend
 * Adds project cards + per-project notes timeline in list view
 */

(function() {
    'use strict';

    const state = {
        currentEntity: 'contacts',
        projects: [],
        editingProjectId: null,
        viewingProjectId: null,
        viewingProject: null,
        projectSearchQuery: '',
        projectSortField: 'name',
        projectSortOrder: 'ASC'
    };

    const elements = {
        // Entity switching
        entityBtns: document.querySelectorAll('.entity-btn'),
        entityCountBadge: document.getElementById('entityCountBadge'),
        contactListToolbar: document.getElementById('contactListToolbar'),
        projectListToolbar: document.getElementById('projectListToolbar'),
        contactsList: document.getElementById('contactsList'),
        projectsList: document.getElementById('projectsList'),

        // Header controls
        addContactBtn: document.getElementById('addContactBtn'),
        addProjectBtn: document.getElementById('addProjectBtn'),
        importExportBtn: document.getElementById('importExportBtn'),
        mapToggleBtn: document.querySelector('.toggle-btn[data-view="map"]'),
        listToggleBtn: document.querySelector('.toggle-btn[data-view="list"]'),

        // Project list controls
        projectSearchInput: document.getElementById('projectSearchInput'),
        projectSortField: document.getElementById('projectSortField'),
        projectSortOrderBtn: document.getElementById('projectSortOrderBtn'),
        projectSortOrderIcon: document.getElementById('projectSortOrderIcon'),

        // Project modal
        projectModal: document.getElementById('projectModal'),
        projectModalTitle: document.getElementById('projectModalTitle'),
        projectForm: document.getElementById('projectForm'),
        projectId: document.getElementById('projectId'),
        closeProjectModal: document.getElementById('closeProjectModal'),
        cancelProjectBtn: document.getElementById('cancelProjectBtn'),
        deleteProjectBtn: document.getElementById('deleteProjectBtn'),
        saveProjectBtn: document.getElementById('saveProjectBtn'),

        // Project delete modal
        projectDeleteModal: document.getElementById('projectDeleteModal'),
        deleteProjectName: document.getElementById('deleteProjectName'),
        closeProjectDeleteModal: document.getElementById('closeProjectDeleteModal'),
        cancelProjectDeleteBtn: document.getElementById('cancelProjectDeleteBtn'),
        confirmProjectDeleteBtn: document.getElementById('confirmProjectDeleteBtn'),

        // Project overview modal
        projectOverviewModal: document.getElementById('projectOverviewModal'),
        projectOverviewAvatar: document.getElementById('projectOverviewAvatar'),
        projectOverviewName: document.getElementById('projectOverviewName'),
        projectOverviewSubtitle: document.getElementById('projectOverviewSubtitle'),
        projectOverviewDetails: document.getElementById('projectOverviewDetails'),
        projectNotesTimeline: document.getElementById('projectNotesTimeline'),
        newProjectNoteContent: document.getElementById('newProjectNoteContent'),
        addProjectNoteBtn: document.getElementById('addProjectNoteBtn'),
        closeProjectOverviewModal: document.getElementById('closeProjectOverviewModal'),
        closeProjectOverviewBtn: document.getElementById('closeProjectOverviewBtn'),
        editProjectBtn: document.getElementById('editProjectBtn')
    };

    const api = {
        async getProjects(search = '', sort = 'name', order = 'ASC') {
            const params = new URLSearchParams({ search, sort, order });
            const response = await fetch(`api/projects.php?${params}`);
            return response.json();
        },

        async getProject(id) {
            const response = await fetch(`api/projects.php?id=${id}`);
            return response.json();
        },

        async createProject(data) {
            const response = await fetch('api/projects.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async updateProject(id, data) {
            const response = await fetch(`api/projects.php?id=${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return response.json();
        },

        async deleteProject(id) {
            const response = await fetch(`api/projects.php?id=${id}`, {
                method: 'DELETE'
            });
            return response.json();
        },

        async getProjectNotes(projectId) {
            const response = await fetch(`api/project-notes.php?project_id=${projectId}`);
            return response.json();
        },

        async createProjectNote(projectId, content) {
            const response = await fetch('api/project-notes.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_id: projectId, content })
            });
            return response.json();
        },

        async deleteProjectNote(id) {
            const response = await fetch(`api/project-notes.php?id=${id}`, {
                method: 'DELETE'
            });
            return response.json();
        }
    };

    function init() {
        if (!elements.entityBtns.length || !elements.projectsList) {
            return;
        }

        initEventListeners();
        updateEntityUI();
    }

    function initEventListeners() {
        elements.entityBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                switchEntity(btn.dataset.entity);
            });
        });

        const debouncedProjectSearch = debounce(() => {
            state.projectSearchQuery = elements.projectSearchInput.value.trim();
            loadProjects();
        }, 300);

        elements.projectSearchInput.addEventListener('input', debouncedProjectSearch);

        elements.projectSortField.addEventListener('change', () => {
            state.projectSortField = elements.projectSortField.value;
            loadProjects();
        });

        elements.projectSortOrderBtn.addEventListener('click', () => {
            state.projectSortOrder = state.projectSortOrder === 'ASC' ? 'DESC' : 'ASC';
            elements.projectSortOrderIcon.style.transform = state.projectSortOrder === 'DESC' ? 'rotate(180deg)' : '';
            loadProjects();
        });

        elements.addProjectBtn.addEventListener('click', () => openProjectModal());

        elements.closeProjectModal.addEventListener('click', closeProjectModal);
        elements.cancelProjectBtn.addEventListener('click', closeProjectModal);
        elements.projectModal.querySelector('.modal-backdrop').addEventListener('click', closeProjectModal);

        elements.projectForm.addEventListener('submit', saveProject);
        elements.deleteProjectBtn.addEventListener('click', openProjectDeleteModal);

        elements.closeProjectDeleteModal.addEventListener('click', closeProjectDeleteModal);
        elements.cancelProjectDeleteBtn.addEventListener('click', closeProjectDeleteModal);
        elements.projectDeleteModal.querySelector('.modal-backdrop').addEventListener('click', closeProjectDeleteModal);
        elements.confirmProjectDeleteBtn.addEventListener('click', deleteProject);

        elements.closeProjectOverviewModal.addEventListener('click', closeProjectOverviewModal);
        elements.closeProjectOverviewBtn.addEventListener('click', closeProjectOverviewModal);
        elements.projectOverviewModal.querySelector('.modal-backdrop').addEventListener('click', closeProjectOverviewModal);
        elements.editProjectBtn.addEventListener('click', openEditFromProjectOverview);
        elements.addProjectNoteBtn.addEventListener('click', addProjectNote);

        elements.newProjectNoteContent.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                addProjectNote();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') {
                return;
            }

            if (elements.projectDeleteModal.classList.contains('active')) {
                closeProjectDeleteModal();
            } else if (elements.projectOverviewModal.classList.contains('active')) {
                closeProjectOverviewModal();
            } else if (elements.projectModal.classList.contains('active')) {
                closeProjectModal();
            }
        });
    }

    function switchEntity(entity) {
        if (entity !== 'contacts' && entity !== 'projects') {
            return;
        }

        if (state.currentEntity === entity) {
            return;
        }

        state.currentEntity = entity;
        updateEntityUI();

        if (entity === 'projects') {
            loadProjects();
        }
    }

    function updateEntityUI() {
        const isProjects = state.currentEntity === 'projects';

        elements.entityBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.entity === state.currentEntity);
        });

        elements.contactListToolbar.style.display = isProjects ? 'none' : 'flex';
        elements.projectListToolbar.style.display = isProjects ? 'flex' : 'none';

        elements.contactsList.style.display = isProjects ? 'none' : 'block';
        elements.projectsList.style.display = isProjects ? 'block' : 'none';

        elements.addContactBtn.style.display = isProjects ? 'none' : 'inline-flex';
        elements.addProjectBtn.style.display = isProjects ? 'inline-flex' : 'none';
        elements.importExportBtn.style.display = isProjects ? 'none' : 'inline-flex';

        if (isProjects) {
            if (!document.getElementById('listView').classList.contains('active')) {
                elements.listToggleBtn.click();
            }
            elements.mapToggleBtn.disabled = true;
            elements.mapToggleBtn.classList.add('disabled');
            elements.mapToggleBtn.title = 'Projects are available in list view';
        } else {
            elements.mapToggleBtn.disabled = false;
            elements.mapToggleBtn.classList.remove('disabled');
            elements.mapToggleBtn.removeAttribute('title');
        }

        updateEntityCountBadge();
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
                renderProjectsList();

                if (!state.projectSearchQuery) {
                    elements.entityCountBadge.dataset.projectCount = String(state.projects.length);
                }

                if (state.currentEntity === 'projects') {
                    updateEntityCountBadge();
                }
            } else {
                elements.projectsList.innerHTML = '<div class="error-message">Error loading projects</div>';
            }
        } catch (error) {
            console.error('Error loading projects:', error);
            elements.projectsList.innerHTML = '<div class="error-message">Error loading projects</div>';
        }
    }

    function renderProjectsList() {
        if (state.projects.length === 0) {
            elements.projectsList.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                        <path d="M3 5h18v2H3V5zm0 6h12v2H3v-2zm0 6h18v2H3v-2z"/>
                    </svg>
                    <h3>No projects found</h3>
                    <p>${state.projectSearchQuery ? 'Try a different search term' : 'Create your first project'}</p>
                    ${state.projectSearchQuery ? '' : '<button type="button" class="btn btn-primary" id="emptyAddProjectBtn">Add Project</button>'}
                </div>
            `;

            const emptyAddButton = document.getElementById('emptyAddProjectBtn');
            if (emptyAddButton) {
                emptyAddButton.addEventListener('click', () => openProjectModal());
            }
            return;
        }

        const html = state.projects.map(project => createProjectCard(project)).join('');
        elements.projectsList.innerHTML = html;

        elements.projectsList.querySelectorAll('.project-card').forEach(card => {
            card.addEventListener('click', () => {
                const projectId = parseInt(card.dataset.id, 10);
                openProjectOverviewModal(projectId);
            });
        });
    }

    function createProjectCard(project) {
        const status = project.status || 'Planning';
        const statusClass = `status-${status.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const updatedAt = project.updated_at || project.created_at;

        return `
            <div class="project-card" data-id="${project.id}">
                <div class="project-avatar">${getInitials(project.name)}</div>
                <div class="project-info">
                    <div class="project-top-row">
                        <h3 class="project-name">${escapeHtml(project.name)}</h3>
                        <span class="project-status ${statusClass}">${escapeHtml(status)}</span>
                    </div>
                    ${project.client ? `<p class="project-client">${escapeHtml(project.client)}</p>` : ''}
                    ${project.description ? `<p class="project-description">${escapeHtml(truncate(project.description, 120))}</p>` : ''}
                    <p class="project-updated">Updated ${formatDate(new Date(updatedAt))}</p>
                </div>
                <div class="project-actions">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                        <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/>
                    </svg>
                </div>
            </div>
        `;
    }

    function openProjectModal(project = null) {
        state.editingProjectId = project ? project.id : null;

        elements.projectForm.reset();

        if (project) {
            elements.projectModalTitle.textContent = 'Edit Project';
            elements.deleteProjectBtn.style.display = 'block';

            elements.projectId.value = project.id;
            document.getElementById('projectName').value = project.name || '';
            document.getElementById('projectClient').value = project.client || '';
            document.getElementById('projectStatus').value = project.status || 'Planning';
            document.getElementById('projectDescription').value = project.description || '';
        } else {
            elements.projectModalTitle.textContent = 'Add Project';
            elements.deleteProjectBtn.style.display = 'none';
            elements.projectId.value = '';
            document.getElementById('projectStatus').value = 'Planning';
        }

        elements.projectModal.classList.add('active');
        document.getElementById('projectName').focus();
    }

    function closeProjectModal() {
        elements.projectModal.classList.remove('active');
        state.editingProjectId = null;
    }

    function openProjectDeleteModal() {
        const project = state.projects.find(item => item.id === state.editingProjectId);

        if (project) {
            elements.deleteProjectName.textContent = project.name;
            elements.projectDeleteModal.classList.add('active');
        }
    }

    function closeProjectDeleteModal() {
        elements.projectDeleteModal.classList.remove('active');
    }

    async function saveProject(event) {
        event.preventDefault();

        const payload = {
            name: document.getElementById('projectName').value.trim(),
            client: document.getElementById('projectClient').value.trim(),
            status: document.getElementById('projectStatus').value,
            description: document.getElementById('projectDescription').value.trim()
        };

        if (!payload.name) {
            alert('Project name is required');
            return;
        }

        elements.saveProjectBtn.disabled = true;
        elements.saveProjectBtn.textContent = 'Saving...';

        try {
            let result;

            if (state.editingProjectId) {
                result = await api.updateProject(state.editingProjectId, payload);
            } else {
                result = await api.createProject(payload);
            }

            if (result.success) {
                closeProjectModal();
                await loadProjects();
                await refreshProjectCount();
            } else {
                alert(result.error || 'Error saving project');
            }
        } catch (error) {
            console.error('Error saving project:', error);
            alert('Error saving project');
        } finally {
            elements.saveProjectBtn.disabled = false;
            elements.saveProjectBtn.textContent = 'Save Project';
        }
    }

    async function deleteProject() {
        if (!state.editingProjectId) {
            return;
        }

        elements.confirmProjectDeleteBtn.disabled = true;
        elements.confirmProjectDeleteBtn.textContent = 'Deleting...';

        try {
            const result = await api.deleteProject(state.editingProjectId);

            if (result.success) {
                closeProjectDeleteModal();
                closeProjectModal();
                await loadProjects();
                await refreshProjectCount();
            } else {
                alert(result.error || 'Error deleting project');
            }
        } catch (error) {
            console.error('Error deleting project:', error);
            alert('Error deleting project');
        } finally {
            elements.confirmProjectDeleteBtn.disabled = false;
            elements.confirmProjectDeleteBtn.textContent = 'Delete';
        }
    }

    async function openProjectOverviewModal(projectId) {
        try {
            const result = await api.getProject(projectId);

            if (!result.success) {
                alert('Error loading project');
                return;
            }

            const project = result.data;
            state.viewingProjectId = projectId;
            state.viewingProject = project;

            elements.projectOverviewAvatar.textContent = getInitials(project.name);
            elements.projectOverviewName.textContent = project.name;

            const subtitleParts = [];
            if (project.client) {
                subtitleParts.push(project.client);
            }
            if (project.status) {
                subtitleParts.push(project.status);
            }
            elements.projectOverviewSubtitle.textContent = subtitleParts.join(' · ');
            elements.projectOverviewSubtitle.style.display = subtitleParts.length > 0 ? 'block' : 'none';

            renderProjectOverviewDetails(project);
            await loadProjectNotes(projectId);

            elements.projectOverviewModal.classList.add('active');
        } catch (error) {
            console.error('Error opening project overview:', error);
            alert('Error loading project');
        }
    }

    function closeProjectOverviewModal() {
        elements.projectOverviewModal.classList.remove('active');
        state.viewingProjectId = null;
        state.viewingProject = null;
        elements.newProjectNoteContent.value = '';
    }

    function openEditFromProjectOverview() {
        if (!state.viewingProject) {
            return;
        }

        const project = state.viewingProject;
        closeProjectOverviewModal();
        openProjectModal(project);
    }

    function renderProjectOverviewDetails(project) {
        let html = '<div class="detail-grid">';

        if (project.client) {
            html += `
                <div class="detail-item">
                    <span class="detail-icon">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z"/>
                        </svg>
                    </span>
                    <div class="detail-content">
                        <span class="detail-label">Client</span>
                        <span class="detail-value">${escapeHtml(project.client)}</span>
                    </div>
                </div>
            `;
        }

        html += `
            <div class="detail-item">
                <span class="detail-icon">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 9H6V6h12v6z"/>
                    </svg>
                </span>
                <div class="detail-content">
                    <span class="detail-label">Status</span>
                    <span class="detail-value">${escapeHtml(project.status || 'Planning')}</span>
                </div>
            </div>
        `;

        html += `
            <div class="detail-item">
                <span class="detail-icon">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/>
                    </svg>
                </span>
                <div class="detail-content">
                    <span class="detail-label">Created</span>
                    <span class="detail-value">${formatDate(new Date(project.created_at))}</span>
                </div>
            </div>
        `;

        html += `
            <div class="detail-item">
                <span class="detail-icon">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M12 8V4l8 8-8 8v-4H4V8h8z"/>
                    </svg>
                </span>
                <div class="detail-content">
                    <span class="detail-label">Last Updated</span>
                    <span class="detail-value">${formatDate(new Date(project.updated_at || project.created_at))}</span>
                </div>
            </div>
        `;

        if (project.description) {
            html += `
                <div class="detail-item detail-item-full">
                    <span class="detail-icon">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
                        </svg>
                    </span>
                    <div class="detail-content">
                        <span class="detail-label">Description</span>
                        <span class="detail-value">${escapeHtml(project.description).replace(/\n/g, '<br>')}</span>
                    </div>
                </div>
            `;
        }

        html += '</div>';

        elements.projectOverviewDetails.innerHTML = html;
    }

    async function loadProjectNotes(projectId) {
        try {
            const result = await api.getProjectNotes(projectId);

            if (result.success) {
                renderProjectNotesTimeline(result.data);
            } else {
                elements.projectNotesTimeline.innerHTML = `
                    <div class="notes-empty">
                        <p>Error loading notes</p>
                    </div>
                `;
            }
        } catch (error) {
            console.error('Error loading project notes:', error);
            elements.projectNotesTimeline.innerHTML = `
                <div class="notes-empty">
                    <p>Error loading notes</p>
                </div>
            `;
        }
    }

    function renderProjectNotesTimeline(notes) {
        if (!notes || notes.length === 0) {
            elements.projectNotesTimeline.innerHTML = `
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

            html += `
                <div class="note-item">
                    <div class="note-header">
                        <span class="note-date">${formattedDate}</span>
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

        elements.projectNotesTimeline.innerHTML = html;

        elements.projectNotesTimeline.querySelectorAll('.note-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (event) => {
                event.stopPropagation();
                const noteId = parseInt(btn.dataset.noteId, 10);
                await deleteProjectNote(noteId);
            });
        });
    }

    async function addProjectNote() {
        const content = elements.newProjectNoteContent.value.trim();

        if (!content || !state.viewingProjectId) {
            return;
        }

        elements.addProjectNoteBtn.disabled = true;
        elements.addProjectNoteBtn.textContent = 'Adding...';

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
            elements.addProjectNoteBtn.disabled = false;
            elements.addProjectNoteBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
                Add Note
            `;
        }
    }

    async function deleteProjectNote(noteId) {
        if (!confirm('Delete this note?')) {
            return;
        }

        try {
            const result = await api.deleteProjectNote(noteId);

            if (result.success) {
                await loadProjectNotes(state.viewingProjectId);
            } else {
                alert(result.error || 'Error deleting note');
            }
        } catch (error) {
            console.error('Error deleting project note:', error);
            alert('Error deleting note');
        }
    }

    async function refreshProjectCount() {
        try {
            const result = await api.getProjects();
            if (result.success) {
                elements.entityCountBadge.dataset.projectCount = String(result.data.length);
                if (state.currentEntity === 'projects') {
                    updateEntityCountBadge();
                }
            }
        } catch (error) {
            console.error('Error refreshing project count:', error);
        }
    }

    function updateEntityCountBadge() {
        if (!elements.entityCountBadge) {
            return;
        }

        if (state.currentEntity === 'projects') {
            const count = parseInt(elements.entityCountBadge.dataset.projectCount || '0', 10);
            elements.entityCountBadge.textContent = `${count} project${count !== 1 ? 's' : ''}`;
        } else {
            const count = parseInt(elements.entityCountBadge.dataset.contactCount || '0', 10);
            elements.entityCountBadge.textContent = `${count} contact${count !== 1 ? 's' : ''}`;
        }
    }

    function escapeHtml(text) {
        if (!text) {
            return '';
        }

        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function getInitials(name) {
        if (!name) {
            return '?';
        }

        const parts = name.trim().split(/\s+/);
        if (parts.length === 1) {
            return parts[0].charAt(0).toUpperCase();
        }

        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }

    function truncate(text, maxLength) {
        if (!text || text.length <= maxLength) {
            return text;
        }

        return `${text.slice(0, maxLength - 1)}...`;
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
        }

        if (days > 0) {
            return days === 1 ? 'Yesterday' : `${days} days ago`;
        }

        if (hours > 0) {
            return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
        }

        if (minutes > 0) {
            return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
        }

        return 'Just now';
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
