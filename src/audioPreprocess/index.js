import '../common.css';
import '../audioPreprocess.css';
import { initI18n, applyLocale, getLocale } from '../i18n/index.js';
import { initWindowTheme } from '../themes/themeInit.js';
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
});

// Apply saved theme
initWindowTheme();

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  if (state.pianoRoll && state.pianoRoll.destroy) state.pianoRoll.destroy();
});
