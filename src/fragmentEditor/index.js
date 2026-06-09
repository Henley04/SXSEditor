import '../common.css';
import '../fragmentEditor.css';
import { initI18n, applyLocale, getLocale, t } from '../i18n/index.js';
import { initPipeline } from './pipeline.js';
import { resizeCanvases, render } from './canvasRenderer.js';
import { setupEventListeners } from './eventHandlers.js';
import { setupIpcHandlers, loadFragmentFromHash } from './ipcHandlers.js';
import { setupUiControls } from './uiControls.js';
import {
  getAutoSaveTimer, setAutoSaveTimer,
  getIpcCleanups,
  getCurrentFragment,
  getNotes,
  getEnvelopes,
  getPitchCurve,
} from './state.js';
import { saveFragmentData } from './projectIO.js';

// Initialize pipeline
initPipeline();

// Setup window resize
window.addEventListener('resize', resizeCanvases);

// Setup all event listeners
setupEventListeners();

// Setup IPC handlers
setupIpcHandlers();

// Setup UI controls
setupUiControls();

// Load fragment from hash if needed
loadFragmentFromHash();

// Initialize i18n
initI18n();
applyLocale();
document.documentElement.lang = getLocale();

console.log(t('fragment.consoleStarted'));

// Handle beforeunload
window.addEventListener('beforeunload', () => {
  for (const cleanup of getIpcCleanups()) {
    try { cleanup(); } catch (_) {}
  }
  getIpcCleanups().length = 0;
  const autoSaveTimer = getAutoSaveTimer();
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    setAutoSaveTimer(null);
  }
  // Use synchronous save to ensure data is persisted before unload
  try {
    const currentFragment = getCurrentFragment();
    if (currentFragment) {
      currentFragment.notes = getNotes();
      currentFragment.envelopes = getEnvelopes();
      currentFragment.pitchCurve = getPitchCurve();
      if (window.electronAPI?.saveFragmentDataSync) {
        window.electronAPI.saveFragmentDataSync(currentFragment.id, {
          notes: getNotes(),
          envelopes: getEnvelopes(),
          pitchCurve: getPitchCurve(),
          startTime: currentFragment.startTime,
          duration: currentFragment.duration,
        });
      }
    }
  } catch (_) {}
});
