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
                    </div>
                </div>
                <div class="header-right">
                    <button type="button" class="btn btn-primary" id="addContactBtn">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                        </svg>
                        Add Contact
                    </button>
                    <a href="index.php?action=logout" class="btn btn-secondary">Logout</a>
                </div>
            </header>

            <!-- Main Content -->
            <main class="app-main">
                <!-- Map View -->
                <div class="view-panel active" id="mapView">
                    <div id="map"></div>
                </div>

                <!-- List View -->
                <div class="view-panel" id="listView">
                    <div class="list-header">
                        <div class="search-box">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" class="search-icon">
                                <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                            </svg>
                            <input type="text" id="searchInput" placeholder="Search contacts..." class="search-input">
                        </div>
                        <div class="sort-controls">
                            <label>Sort by:</label>
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
                                    <input type="url" id="contactWebsite" name="website" class="form-input" placeholder="https://">
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
                    <button type="button" class="btn btn-primary" id="editContactBtn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                        Edit Contact
                    </button>
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
