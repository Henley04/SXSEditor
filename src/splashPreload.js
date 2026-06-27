// Splash window preload - exposes only what the splash screen needs.
// Kept intentionally minimal so the splash window cannot access the
// full electronAPI surface.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashAPI', {
  getBuildInfo: () => ipcRenderer.invoke('splash:getBuildInfo'),
  getIconDataUrl: () => ipcRenderer.invoke('splash:getIconDataUrl'),
});
