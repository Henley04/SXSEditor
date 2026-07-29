import '../common.css';
import '../audioPreprocess.css';
import { initI18n, applyLocale, getLocale } from '../i18n/index.js';
import { initWindowTheme } from '../themes/themeInit.js';
import { hydrateIcons } from '../icons/iconHelper.js';
import { initDomRefs, state } from './state.js';
import { setupEventHandlers } from './eventHandlers.js';
import { setupIpcHandlers } from './ipcHandlers.js';

// Initialize DOM references
initDomRefs();

// Setup event handlers
setupEventHandlers();

// Setup IPC handlers
setupIpcHandlers();

// Initialize i18n
initI18n().then(() => {
  applyLocale();
  document.documentElement.lang = getLocale();
  hydrateIcons(document);
});

// Apply saved theme
initWindowTheme();

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  // W21: remove registered IPC listeners (mirrors fragmentEditor pattern).
  if (state._ipcCleanups) {
    for (const cleanup of state._ipcCleanups) {
      try { cleanup(); } catch (_) {}
    }
    state._ipcCleanups.length = 0;
  }
  // W21: stop pending playback rAF loop and close the audio context so
  // resources are released on unload.
  if (state.playbackRaf) {
    cancelAnimationFrame(state.playbackRaf);
    state.playbackRaf = null;
  }
  if (state.audioContext) {
    try { state.audioContext.close(); } catch (_) {}
    state.audioContext = null;
  }
  if (state.pianoRoll && state.pianoRoll.destroy) state.pianoRoll.destroy();
});
