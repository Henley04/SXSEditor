// Splash window manager.
//
// Shows a small frameless splash window while the main window boots.
// The splash reads build-info.json (generated at package time by
// scripts/generate-build-info.js) and the bundled app icon, and
// serves both to the splash renderer via IPC.
//
// Timing strategy:
//   - The splash window is shown IMMEDIATELY on creation (show: true)
//     with a dark backgroundColor so the user sees *something* right
//     away, before the SVG even paints.
//   - did-finish-load fires once the splash's SVG has rendered; we
//     record that timestamp so the main process can enforce a minimum
//     *visible* splash duration measured from when content actually
//     appeared (not from when the empty window was created).

const { BrowserWindow, ipcMain, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let splashWindow = null;
let splashReadyAt = 0; // ms timestamp when splash content first painted

// Cached values (loaded once per process)
let cachedBuildInfo = null;
let cachedIconDataUrl = null;

function readBuildInfo() {
  if (cachedBuildInfo) return cachedBuildInfo;

  // In both dev (electron-forge start) and packaged mode, the main
  // process runs from .webpack/main, where webpack copies build-info.json.
  const candidate = path.join(__dirname, 'build-info.json');
  const fallback = {
    productName: 'SXSEditor',
    version: app.getVersion() || '0.0.0',
    buildDate: '',
    buildDateISO: '',
  };

  try {
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf8');
      cachedBuildInfo = { ...fallback, ...JSON.parse(raw) };
    } else {
      cachedBuildInfo = fallback;
    }
  } catch (err) {
    console.warn('[Splash] Failed to read build-info.json:', err.message);
    cachedBuildInfo = fallback;
  }
  return cachedBuildInfo;
}

function readIconDataUrl() {
  if (cachedIconDataUrl) return cachedIconDataUrl;

  // webpack.main.config.js copies assets/SXS.png to .webpack/main/SXS.png
  const candidate = path.join(__dirname, 'SXS.png');
  try {
    if (fs.existsSync(candidate)) {
      const buf = fs.readFileSync(candidate);
      cachedIconDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    }
  } catch (err) {
    console.warn('[Splash] Failed to read app icon:', err.message);
  }
  if (!cachedIconDataUrl) cachedIconDataUrl = '';
  return cachedIconDataUrl;
}

function registerSplashIpc() {
  ipcMain.handle('splash:getBuildInfo', async () => readBuildInfo());
  ipcMain.handle('splash:getIconDataUrl', async () => readIconDataUrl());
}

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.focus();
    return splashWindow;
  }

  splashReadyAt = 0;

  splashWindow = new BrowserWindow({
    width: 440,
    height: 280,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Show IMMEDIATELY. The window paints backgroundColor first, then
    // the SVG renders on top once did-finish-load fires. This avoids
    // the "splash appears after main is already done" race.
    show: true,
    transparent: false,
    alwaysOnTop: false,
    center: true,
    // Matches the SVG's solid fill (THEME.bgApp = #14141f, same as
    // --bg-app in dark-aurora.theme.json) so the empty window and the
    // painted SVG blend seamlessly.
    backgroundColor: '#14141f',
    icon: path.join(__dirname, 'SXS.png'),
    webPreferences: {
      preload: SPLASH_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  splashWindow.loadURL(SPLASH_WINDOW_WEBPACK_ENTRY);

  splashWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  splashWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Record when the splash content actually finishes painting.
  splashWindow.webContents.once('did-finish-load', () => {
    splashReadyAt = Date.now();
  });

  splashWindow.on('closed', () => {
    splashWindow = null;
  });

  return splashWindow;
}

function getSplashWindow() {
  return splashWindow;
}

function getSplashReadyAt() {
  return splashReadyAt;
}

function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

module.exports = {
  createSplashWindow,
  closeSplashWindow,
  getSplashWindow,
  getSplashReadyAt,
  registerSplashIpc,
  readBuildInfo,
  readIconDataUrl,
};
