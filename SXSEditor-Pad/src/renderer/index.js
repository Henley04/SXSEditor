import { getAppVersion, initIpcHandlers } from './ipcHandlers.js';
import { initDOM, getDOM, markDirty } from './state.js';
import { initRenderer, requestRender } from './timelineRenderer.js';
import { initEventHandlers, destroyEventHandlers } from './eventHandlers.js';
import { destroyAudioPlayback } from './audioPlayback.js';
import { showExportDialog } from './exportDialog.js';
import { loadProject, newProject, saveProject, saveProjectAs, confirmSaveBeforeAction } from './projectManager.js';
import { importMidiFile, importAudioFile, selectAllFragments } from './fragmentOperations.js';

// ==================== App State ====================

let appInitialized = false;
let currentTheme = 'dark';

// ==================== Custom Event Handlers ====================

/**
 * Register all custom event listeners for the application.
 */
function setupCustomEvents() {
  // Load project
  window.addEventListener('sxs:load-project', async () => {
    const proceed = await confirmSaveBeforeAction('load');
    if (proceed) {
      await loadProject();
    }
  });

  // Save project
  window.addEventListener('sxs:save-project', async () => {
    await saveProject();
  });

  // New project
  window.addEventListener('sxs:new-project', async () => {
    const proceed = await confirmSaveBeforeAction('new');
    if (proceed) {
      newProject();
    }
  });

  // Export
  window.addEventListener('sxs:export', () => {
    showExportDialog();
  });

  // Undo
  window.addEventListener('sxs:undo', () => {
    console.log('[sxs:undo] Undo triggered — hook your undo system here');
    // Placeholder for undo integration
  });

  // Select all
  window.addEventListener('sxs:select-all', () => {
    selectAllFragments();
  });

  // Audio to MIDI
  window.addEventListener('sxs:audio-to-midi', () => {
    console.log('[sxs:audio-to-midi] Audio to MIDI triggered — hook inference here');
  });

  // Import MIDI
  window.addEventListener('sxs:import-midi', async () => {
    await importMidiFile();
  });

  // Import audio
  window.addEventListener('sxs:import-audio', async () => {
    await importAudioFile();
  });

  // Singer market
  window.addEventListener('sxs:singer-market', () => {
    console.log('[sxs:singer-market] Singer market triggered — open singer market page');
  });

  // Context menu (for UI layer to handle)
  window.addEventListener('sxs:context-menu', (e) => {
    const { fragmentId, x, y } = e.detail;
    console.log(`[sxs:context-menu] Fragment ${fragmentId} at (${x}, ${y})`);
    // Future: show a custom context menu
  });
}

// ==================== Theme Management ====================

/**
 * Apply a theme to the document.
 */
function applyTheme(themeId) {
  currentTheme = themeId || 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
}

/**
 * Load theme settings from the backend.
 */
async function loadTheme() {
  try {
    const { listThemes } = await import('./ipcHandlers.js');
    const themes = await listThemes();
    if (themes.length > 0) {
      applyTheme(themes[0].id);
    }
  } catch (err) {
    // Fall back to default dark theme
    applyTheme('dark');
  }
}

// ==================== Version Display ====================

/**
 * Update the version display in the DOM.
 */
async function updateVersionDisplay() {
  const dom = getDOM();
  if (dom.versionDisplay) {
    const version = await getAppVersion();
    dom.versionDisplay.textContent = `v${version}`;
  }
}

// ==================== Settings ====================

/**
 * Load settings from the backend and apply them.
 */
async function loadSettings() {
  try {
    const { getSettings } = await import('./ipcHandlers.js');
    const settings = await getSettings();
    if (settings) {
      if (settings.theme_id) {
        applyTheme(settings.theme_id);
      }
      if (settings.locale) {
        document.documentElement.setAttribute('lang', settings.locale);
      }
    }
  } catch (err) {
    console.warn('[index] Failed to load settings:', err);
  }
}

// ==================== Main Init ====================

/**
 * Initialize the entire renderer application.
 */
export async function init() {
  if (appInitialized) {
    console.warn('[index] App already initialized');
    return;
  }

  console.log('[index] Initializing SXSEditor-Pad renderer...');

  try {
    // 1. Initialize DOM references
    initDOM();

    // 2. Apply theme
    applyTheme('dark');

    // 3. Load settings
    await loadSettings();

    // 4. Load theme
    await loadTheme();

    // 5. Initialize IPC handlers
    await initIpcHandlers();

    // 6. Initialize the timeline renderer
    initRenderer();

    // 7. Initialize event handlers
    initEventHandlers();

    // 8. Set up custom event listeners
    setupCustomEvents();

    // 9. Update version display
    updateVersionDisplay();

    // 10. Initial render
    requestRender();

    appInitialized = true;
    console.log('[index] SXSEditor-Pad renderer initialized successfully');
  } catch (err) {
    console.error('[index] Failed to initialize renderer:', err);
  }
}

/**
 * Clean up the renderer on app exit.
 */
export function destroy() {
  console.log('[index] Destroying SXSEditor-Pad renderer...');

  destroyEventHandlers();
  destroyAudioPlayback();

  const { destroyExportDialog } = import('./exportDialog.js');
  destroyExportDialog();

  appInitialized = false;
  console.log('[index] SXSEditor-Pad renderer destroyed');
}

// ==================== Auto-Init on DOMContentLoaded ====================

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
    });
  } else {
    // DOM is already ready
    init();
  }
}

// ==================== Hot Module Replacement ====================

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.log('[index] HMR update — reinitializing');
    destroy();
    init();
  });
}