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

contextBridge.exposeInMainWorld('splashAPI', {
  getBuildInfo: () => ipcRenderer.invoke('splash:getBuildInfo'),
});
