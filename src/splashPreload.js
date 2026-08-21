// Splash window preload - exposes only what the splash screen needs.
// Kept intentionally minimal so the splash window cannot access the
// full electronAPI surface.
//
// The icon is no longer fetched via IPC — the inline SVG in splash.html
// references ./SXS.png directly (copied to the splash_window renderer
// folder by webpack.renderer.config.js), so the icon loads in parallel
// with HTML parse on the renderer side, removing the IPC round-trip
// from the critical path to first paint.

const { contextBridge, ipcRenderer } = require('electron');

// Forward splash renderer errors to main process for centralized logging.
// The splash window is minimal but still can throw errors during early
// startup; without this they would be silent.
(function attachSplashErrorForwarding() {
  try {
    const fwd = (level, message) => {
      try { ipcRenderer.send('crash:log', { level, source: 'splash', message }); } catch (_) {}
    };
    const fmt = (e) => {
      if (e instanceof Error) return e.stack || e.message;
      if (typeof e === 'object' && e !== null) {
        try { return JSON.stringify(e); } catch { return String(e); }
      }
      return String(e);
    };
    window.addEventListener('error', (event) => {
      fwd('ERROR', `[splash:onerror] ${event.message || ''} @ ${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}` + (event.error ? '\n' + fmt(event.error) : ''));
    });
    window.addEventListener('unhandledrejection', (event) => {
      fwd('ERROR', `[splash:unhandledrejection] ${fmt(event.reason)}`);
    });
  } catch (_) {}
})();

contextBridge.exposeInMainWorld('splashAPI', {
  getBuildInfo: () => ipcRenderer.invoke('splash:getBuildInfo'),
});
