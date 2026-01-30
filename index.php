<?php
/**
 * Simple CRM - Main Entry Point
 * A contact management system with map visualization
 */

define('APP_ROOT', __DIR__);

require_once APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/includes/database.php';
require_once APP_ROOT . '/includes/auth.php';
require_once APP_ROOT . '/includes/Contact.php';

// Start session
Auth::startSession();

// Handle actions
$action = $_GET['action'] ?? '';

// Handle logout
if ($action === 'logout') {
    Auth::logout();
    header('Location: index.php');
    exit;
}

// Handle login form submission
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'login') {
    $password = $_POST['password'] ?? '';

    if (Auth::login($password)) {
        header('Location: index.php');
        exit;
    } else {
        $loginError = 'Invalid password. Please try again.';
    }
}

// Check if authenticated
$isAuthenticated = Auth::isAuthenticated();

// Get contact count for dashboard
$contactCount = 0;
if ($isAuthenticated) {
    $contactModel = new Contact();
    $contactCount = $contactModel->count();
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars(APP_NAME) ?></title>

    <!-- Inter Font -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

    <!-- Leaflet CSS -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">

    <!-- Leaflet MarkerCluster CSS -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.css">
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.Default.css">

    <!-- Application CSS -->
    <link rel="stylesheet" href="assets/css/style.css">
</head>
<body>
    <?php if (!$isAuthenticated): ?>
        <!-- Login Screen -->
        <div class="login-container">
            <div class="login-box">
                <h1><?= htmlspecialchars(APP_NAME) ?></h1>
                <p class="login-subtitle">Please enter your password to continue</p>

                <?php if (isset($loginError)): ?>
                    <div class="alert alert-error"><?= htmlspecialchars($loginError) ?></div>
                <?php endif; ?>

                <form method="POST" action="index.php?action=login" class="login-form">
                    <div class="form-group">
                        <input type="password"
                               name="password"
                               placeholder="Enter password"
                               required
                               autofocus
                               class="form-input">
                    </div>
                    <button type="submit" class="btn btn-primary btn-block">Login</button>
                </form>
            </div>
        </div>
    <?php else: ?>
        <!-- Main Application -->
        <div class="app-container">
            <!-- Header -->
            <header class="app-header">
                <div class="header-left">
                    <h1 class="app-title"><?= htmlspecialchars(APP_NAME) ?></h1>
                    <span class="contact-count"><?= $contactCount ?> contact<?= $contactCount !== 1 ? 's' : '' ?></span>
                </div>
                <div class="header-center">
                    <!-- View Toggle -->
                    <div class="view-toggle">
                        <button type="button" class="toggle-btn active" data-view="map">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                <path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/>
                            </svg>
                            Map
                        </button>
                        <button type="button" class="toggle-btn" data-view="list">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/>
                            </svg>
                            List
                        </button>
                        <button type="button" class="toggle-btn" data-view="calendar">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/>
                            </svg>
                            Kalender
                        </button>
                    </div>
                </div>
                <div class="header-right">
                    <!-- Desktop buttons (hidden on mobile) -->
                    <button type="button" class="btn btn-secondary header-desktop-only" id="importExportBtn" title="Import/Export Contacts">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                        </svg>
                        <span>Import/Export</span>
                    </button>
                    <button type="button" class="btn btn-primary header-desktop-only" id="addContactBtn">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                        </svg>
                        <span>Add Contact</span>
                    </button>
                    <a href="index.php?action=logout" class="btn btn-secondary header-desktop-only">Logout</a>

                    <!-- Mobile menu button (hidden on desktop) -->
                    <button type="button" class="btn btn-icon header-mobile-only" id="mobileMenuBtn" aria-label="Menu">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                            <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                        </svg>
                    </button>

                    <!-- Mobile dropdown menu -->
                    <div class="mobile-menu" id="mobileMenu">
                        <button type="button" class="mobile-menu-item" id="addContactBtnMobile">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                            </svg>
                            Add Contact
                        </button>
                        <button type="button" class="mobile-menu-item" id="importExportBtnMobile">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                            Import / Export
                        </button>
                        <div class="mobile-menu-divider"></div>
                        <a href="index.php?action=logout" class="mobile-menu-item mobile-menu-danger">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
                            </svg>
                            Logout
                        </a>
                    </div>
                </div>
            </header>

            <!-- Main Content -->
            <main class="app-main">
                <!-- Map View -->
                <div class="view-panel active" id="mapView">
                    <div id="map"></div>
                </div>

                <!-- Calendar View -->
                <div class="view-panel" id="calendarView">
                    <div class="calendar-container">
                        <div class="calendar-toolbar">
                            <div class="calendar-toolbar-left">
                                <button type="button" class="btn btn-icon" id="calPrev" title="Zurück">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                        <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
                                    </svg>
                                </button>
                                <button type="button" class="btn btn-secondary btn-small" id="calToday">Heute</button>
                                <button type="button" class="btn btn-icon" id="calNext" title="Weiter">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                        <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
                                    </svg>
                                </button>
                                <h2 class="calendar-title" id="calTitle"></h2>
                            </div>
                            <div class="calendar-toolbar-right">
                                <div class="calendar-mode-toggle">
                                    <button type="button" class="cal-mode-btn active" data-mode="month">Monat</button>
                                    <button type="button" class="cal-mode-btn" data-mode="week">Woche</button>
                                    <button type="button" class="cal-mode-btn" data-mode="day">Tag</button>
                                </div>
                            </div>
                        </div>
                        <div class="calendar-filters" id="calendarFilters">
                            <div class="calendar-search-box">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" class="cal-search-icon">
                                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                                </svg>
                                <input type="text" id="calSearchInput" placeholder="Name oder Firma suchen..." class="cal-search-input">
                            </div>
                            <div class="calendar-tag-filter">
                                <select id="calTagFilter" class="form-select">
                                    <option value="">Alle Tags</option>
                                </select>
                            </div>
                            <button type="button" class="btn btn-icon calendar-filter-toggle-btn" id="calFilterToggle" title="Filter">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                    <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
                                </svg>
                            </button>
                        </div>
                        <div class="calendar-body" id="calendarBody">
                            <!-- Calendar grid rendered by JS -->
                        </div>
                    </div>
                </div>

                <!-- List View -->
                <div class="view-panel" id="listView">
                    <div class="list-header">
                        <div class="list-header-top">
                            <div class="search-box">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" class="search-icon">
                                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                                </svg>
                                <input type="text" id="searchInput" placeholder="Search contacts..." class="search-input">
                            </div>
                            <button type="button" class="btn btn-icon list-filter-toggle" id="listFilterToggle" title="Filters">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                    <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
                                </svg>
                            </button>
                        </div>
                        <div class="list-controls" id="listControls">
                            <!-- Group By Toggle -->
                            <div class="group-toggle">
                                <button type="button" class="group-btn active" data-group="company" title="Group by Company">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                        <path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z"/>
                                    </svg>
                                    <span>Firma</span>
                                </button>
                                <button type="button" class="group-btn" data-group="tags" title="Group by Tags">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                        <path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>
                                    </svg>
                                    <span>Tags</span>
                                </button>
                            </div>
                            <div class="sort-controls">
                                <label>Sort:</label>
                                <select id="sortField" class="form-select">
                                    <option value="name">Name</option>
                                    <option value="company">Company</option>
                                    <option value="location">Location</option>
                                    <option value="created_at">Date Added</option>
                                </select>
                                <button type="button" id="sortOrderBtn" class="btn btn-icon" title="Toggle sort order">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" id="sortOrderIcon">
                                        <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="contacts-list" id="contactsList">
                        <!-- Contacts will be loaded here -->
                    </div>
                </div>
            </main>
        </div>

        <!-- Contact Modal -->
        <div class="modal" id="contactModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content">
                <div class="modal-header">
                    <h2 id="modalTitle">Add Contact</h2>
                    <button type="button" class="modal-close" id="closeModal">&times;</button>
                </div>
                <form id="contactForm">
                    <input type="hidden" id="contactId" name="id">

                    <div class="modal-body">
                        <!-- Required Fields -->
                        <div class="form-section">
                            <h3>Basic Information</h3>

                            <div class="form-group">
                                <label for="contactName">Name *</label>
                                <input type="text" id="contactName" name="name" required class="form-input">
                            </div>

                            <div class="form-group">
                                <label for="contactCompany">Company</label>
                                <input type="text" id="contactCompany" name="company" class="form-input">
                            </div>

                            <div class="form-group">
                                <label for="contactLocation">Location</label>
                                <input type="text" id="contactLocation" name="location" class="form-input" placeholder="City, Country or Address">
                                <small class="form-hint">Enter a location to show this contact on the map</small>
                            </div>

                            <div class="form-group">
                                <label for="contactNote">Note</label>
                                <textarea id="contactNote" name="note" class="form-input" rows="3"></textarea>
                            </div>
                        </div>

                        <!-- Expandable Additional Fields -->
                        <div class="form-section expandable">
                            <button type="button" class="expand-toggle" id="expandToggle">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" class="expand-icon">
                                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                </svg>
                                Add More Details
                            </button>

                            <div class="expandable-content" id="expandableFields">
                                <div class="form-group">
                                    <label for="contactEmail">Email</label>
                                    <input type="email" id="contactEmail" name="email" class="form-input">
                                </div>

                                <div class="form-group">
                                    <label for="contactPhone">Phone</label>
                                    <input type="tel" id="contactPhone" name="phone" class="form-input">
                                </div>

                                <div class="form-group">
                                    <label for="contactWebsite">Website</label>
                                    <input type="text" id="contactWebsite" name="website" class="form-input" placeholder="www.example.com">
                                </div>

                                <div class="form-group">
                                    <label for="contactAddress">Full Address</label>
                                    <textarea id="contactAddress" name="address" class="form-input" rows="2"></textarea>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" id="cancelBtn">Cancel</button>
                        <button type="button" class="btn btn-danger" id="deleteBtn" style="display: none;">Delete</button>
                        <button type="submit" class="btn btn-primary" id="saveBtn">Save Contact</button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Delete Confirmation Modal -->
        <div class="modal" id="deleteModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-small">
                <div class="modal-header">
                    <h2>Delete Contact</h2>
                    <button type="button" class="modal-close" id="closeDeleteModal">&times;</button>
                </div>
                <div class="modal-body">
                    <p>Are you sure you want to delete <strong id="deleteContactName"></strong>?</p>
                    <p class="text-muted">This action cannot be undone.</p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="cancelDeleteBtn">Cancel</button>
                    <button type="button" class="btn btn-danger" id="confirmDeleteBtn">Delete</button>
                </div>
            </div>
        </div>

        <!-- Contact Overview Modal -->
        <div class="modal" id="overviewModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <div class="overview-header-info">
                        <div class="overview-avatar" id="overviewAvatar"></div>
                        <div class="overview-title-info">
                            <h2 id="overviewName"></h2>
                            <p class="overview-company" id="overviewCompany"></p>
                        </div>
                    </div>
                    <button type="button" class="modal-close" id="closeOverviewModal">&times;</button>
                </div>
                <div class="modal-body overview-body">
                    <!-- Contact Details Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Contact Information</h3>
                        <div class="overview-details" id="overviewDetails">
                            <!-- Details will be populated by JS -->
                        </div>
                    </div>

                    <!-- Tags Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Tags</h3>
                        <div class="tags-container" id="contactTags">
                            <!-- Tags will be populated by JS -->
                        </div>
                        <div class="add-tag-form">
                            <div class="tag-input-wrapper">
                                <input type="text" id="newTagInput" class="form-input" placeholder="Add or create tag..." autocomplete="off">
                                <div class="tag-suggestions" id="tagSuggestions"></div>
                            </div>
                            <button type="button" class="btn btn-secondary" id="addTagBtn">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                                </svg>
                                Add
                            </button>
                        </div>
                    </div>

                    <!-- Notes Timeline Section -->
                    <div class="overview-section">
                        <h3 class="overview-section-title">Notes Timeline</h3>
                        <div class="notes-timeline" id="notesTimeline">
                            <!-- Notes will be populated by JS -->
                        </div>

                        <!-- Add Note Form -->
                        <div class="add-note-form">
                            <textarea id="newNoteContent" class="form-input" placeholder="Add a note..." rows="3"></textarea>
                            <button type="button" class="btn btn-primary" id="addNoteBtn">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                                </svg>
                                Add Note
                            </button>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="closeOverviewBtn">Close</button>
                    <button type="button" class="btn btn-secondary" id="editContactBtn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                        Edit Contact
                    </button>
                </div>
            </div>
        </div>

        <!-- Company Notes Modal -->
        <div class="modal" id="companyNotesModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <div class="overview-header-info">
                        <div class="company-avatar">
                            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                                <path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z"/>
                            </svg>
                        </div>
                        <div class="overview-title-info">
                            <h2 id="companyNotesTitle"></h2>
                            <p class="overview-company">All notes from this company</p>
                        </div>
                    </div>
                    <button type="button" class="modal-close" id="closeCompanyNotesModal">&times;</button>
                </div>
                <div class="modal-body overview-body">
                    <div class="notes-timeline" id="companyNotesTimeline">
                        <!-- Notes will be populated by JS -->
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="closeCompanyNotesBtn">Close</button>
                </div>
            </div>
        </div>

        <!-- Import/Export Modal -->
        <div class="modal" id="importExportModal">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-large">
                <div class="modal-header">
                    <div class="overview-header-info">
                        <div class="import-export-icon">
                            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                        </div>
                        <div class="overview-title-info">
                            <h2>Import / Export Contacts</h2>
                            <p class="overview-company">Bulk import from Excel or export all contacts</p>
                        </div>
                    </div>
                    <button type="button" class="modal-close" id="closeImportExportModal">&times;</button>
                </div>
                <div class="modal-body">
                    <!-- Export Section -->
                    <div class="import-export-section">
                        <h3>
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                            Export Contacts
                        </h3>
                        <p class="section-description">Download all your contacts as an Excel file (.xlsx)</p>
                        <button type="button" class="btn btn-primary" id="exportBtn">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                            Export All Contacts
                        </button>
                    </div>

                    <div class="import-export-divider"></div>

                    <!-- Import Section -->
                    <div class="import-export-section">
                        <h3>
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                            </svg>
                            Import Contacts
                        </h3>
                        <p class="section-description">Upload an Excel file to bulk import contacts</p>

                        <!-- Excel Format Instructions -->
                        <div class="import-instructions">
                            <h4>Excel File Format</h4>
                            <p>Your Excel file should have these columns in the <strong>first row</strong> (header row):</p>
                            <div class="column-list">
                                <div class="column-item required">
                                    <span class="column-name">Name</span>
                                    <span class="column-badge">Required</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Company</span>
                                    <span class="column-desc">Company or organization</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Location</span>
                                    <span class="column-desc">City or address (for map)</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Email</span>
                                    <span class="column-desc">Email address</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Phone</span>
                                    <span class="column-desc">Phone number</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Website</span>
                                    <span class="column-desc">Website URL</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Address</span>
                                    <span class="column-desc">Full postal address</span>
                                </div>
                                <div class="column-item">
                                    <span class="column-name">Note</span>
                                    <span class="column-desc">Additional notes</span>
                                </div>
                            </div>
                            <div class="import-tips">
                                <p><strong>Tips:</strong></p>
                                <ul>
                                    <li>Column order doesn't matter - headers are matched by name</li>
                                    <li>Empty cells are allowed and will be skipped</li>
                                    <li>Rows without a name will be skipped</li>
                                    <li>German column names are also supported (Firma, Telefon, etc.)</li>
                                </ul>
                            </div>
                            <button type="button" class="btn btn-secondary btn-small" id="downloadTemplateBtn">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                                    <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
                                </svg>
                                Download Template
                            </button>
                        </div>

                        <!-- File Upload Area -->
                        <div class="file-upload-area" id="fileUploadArea">
                            <input type="file" id="importFileInput" accept=".xlsx,.xls" hidden>
                            <div class="upload-content">
                                <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                                    <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                                </svg>
                                <p class="upload-text">Drop your Excel file here or <span class="upload-link">browse</span></p>
                                <p class="upload-hint">Supports .xlsx and .xls files</p>
                            </div>
                            <div class="upload-file-info" id="uploadFileInfo" style="display: none;">
                                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                                    <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
                                </svg>
                                <span class="file-name" id="uploadFileName"></span>
                                <button type="button" class="file-remove" id="removeFileBtn">&times;</button>
                            </div>
                        </div>

                        <!-- Import Button -->
                        <button type="button" class="btn btn-primary" id="importBtn" disabled>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                            </svg>
                            Import Contacts
                        </button>

                        <!-- Import Progress/Results -->
                        <div class="import-results" id="importResults" style="display: none;">
                            <div class="import-progress" id="importProgress">
                                <div class="spinner"></div>
                                <span>Importing contacts...</span>
                            </div>
                            <div class="import-success" id="importSuccess" style="display: none;">
                                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                                </svg>
                                <span id="importSuccessText"></span>
                            </div>
                            <div class="import-errors" id="importErrors" style="display: none;">
                                <h4>Import Errors:</h4>
                                <ul id="importErrorList"></ul>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="closeImportExportBtn">Close</button>
                </div>
            </div>
        </div>

        <!-- Leaflet JS -->
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>

        <!-- Leaflet MarkerCluster JS -->
        <script src="https://unpkg.com/leaflet.markercluster@1.4.1/dist/leaflet.markercluster.js"></script>

        <!-- Application JS -->
        <script src="assets/js/app.js"></script>
    <?php endif; ?>
</body>
</html>
