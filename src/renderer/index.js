import '../common.css';
import '../index.css';

// Import state and DOM references (initializes trackManager, history, and DOM elements)
import './state.js';

// Import all modules to register event handlers and IPC handlers
import './eventHandlers.js';
import './ipcHandlers.js';

// Import and run initialization
import { updateProjectSettings } from './projectManager.js';
import { refreshAll } from './timelineRenderer.js';
import { state, dom } from './state.js';
import { initWindowTheme } from '../themes/themeInit.js';
import { hydrateIcons } from '../icons/iconHelper.js';

// Hydrate [data-icon] elements as soon as the DOM is parsed (script is deferred).
hydrateIcons(document);

// Initialize theme before first render so canvas reads correct tokens
initWindowTheme(state._ipcCleanups).then(() => {
  updateProjectSettings();
  refreshAll();
});

// Display app version
(async () => {
  try {
    const version = await window.electronAPI.getAppVersion();
    if (dom.versionDisplay) dom.versionDisplay.textContent = `v${version}`;
  } catch (_) {
    if (dom.versionDisplay) dom.versionDisplay.textContent = 'v1.0.0';
  }
})();

console.log('SXSEditor renderer started');
