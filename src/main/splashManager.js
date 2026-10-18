// Splash window manager.
//
// Shows a small frameless splash window while the main window boots.
//
// The splash payload is a self-contained HTML file (generated from
// src/splash.html.template by scripts/generate-build-info.js) whose entire
// visible content is an INLINE SVG, with the version string, build date and
// app-icon URL substituted at build time. There is deliberately no renderer
// bundle and no preload: first paint is pure HTML parse.
//
// Why that matters: a preload script must be compiled and executed before the
// page paints, and it runs in a renderer process that has to start up first.
// An A/B measurement of splash-with-preload vs splash-without on this machine
// put that cost at ~100ms of renderer startup on the critical path — time the
// user spends looking at nothing. Removing it is the single largest win in the
// splash's first-paint latency.
//
// (An earlier version used a preload + splash.js to fetch build info over IPC
// and patch the SVG after paint. That round-trip is gone.)
//
// How the HTML gets here — and why NOT through webpack:
//   The obvious way to serve a renderer HTML in electron-forge is to register
//   it as an entryPoint in forge.config.js. That does not work for the splash:
//   @electron-forge/plugin-webpack unconditionally builds
//   `entry[name] = (prefixedEntries||[]).concat([entryPoint.js])`, so an
//   entryPoint without `js` yields `entry.splash_window = [undefined]` and
//   webpack's schema validation rejects the whole config ("should be a
//   non-empty string") — the dev server never starts. Forge has no way to
//   express "an HTML entry with no JS".
//
//   So the splash bypasses the renderer pipeline entirely:
//     · webpack.main.config.js's CopyPlugin copies the generated
//       src/splash.html verbatim to .webpack/main/splash.html (next to
//       SXS.png, which is what the template's relative "./SXS.png" resolves
//       to — same relative path works in dev and in the packaged app);
//     · this window loads it with loadFile() instead of loadURL().
//
//   Side benefit: because the file is copied byte-for-byte, no
//   HtmlWebpackPlugin post-processing runs, so nothing injects a
//   <script defer src="index.js"> back into it.
//
//   Consequence: this file is the ONE window that does not use a
//   `*_WEBPACK_ENTRY` constant. If you ever need script in the splash, either
//   give it a real preload + bundle via entryPoints (and eat the ~100ms), or
//   inline a <script> into the template (it will be copied through as-is) —
//   measure before adding either.
//
// Timing strategy:
//   - The splash window is shown IMMEDIATELY on creation (show: true)
//     with a dark backgroundColor so the user sees *something* right
//     away, before the SVG even paints.
//   - did-finish-load fires once the splash's HTML (with inline SVG)
//     has parsed; we record that timestamp so the main process can
//     enforce a minimum *visible* splash duration measured from when
//     content actually appeared (not from when the empty window was
//     created).

const { BrowserWindow } = require('electron');
const path = require('node:path');

let splashWindow = null;
let splashReadyAt = 0; // ms timestamp when splash content first painted
let splashReadyResolvers = []; // resolved when splash content first paints

// No build-info IPC handler is registered any more. The splash window has no
// preload and no renderer bundle, so there is nothing left to ask: its version
// / build date / icon are substituted into the HTML at build time by
// scripts/generate-build-info.js. Registering a handler for a channel with no
// consumer would only be dead surface area (and the IPC channel registry in
// shared/ipcChannels.js is asserted by scripts/check-ipc-channels.js).

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.focus();
    return splashWindow;
  }

  splashReadyAt = 0;
  splashReadyResolvers = [];

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
      // No preload. The splash HTML is a self-contained inline SVG whose
      // version/date/icon are substituted at BUILD time
      // (scripts/generate-build-info.js), so first paint needs zero
      // JavaScript. Dropping the preload removes its compile+execute from
      // the before-first-paint path — measured at ~100ms of renderer startup.
      nodeIntegration: false,
      contextIsolation: true,
      // 安全加固：渲染进程开 OS 级沙箱。该窗口不加载 preload，因此这里没有
      // "preload 需要 Node 内建模块" 的兼容性问题（其余窗口的 preload 只用
      // electron 的 contextBridge / ipcRenderer，在 sandbox:true 下同样正常）。
      sandbox: true,
      spellcheck: false,
    },
  });

  // loadFile, not loadURL: this window has no webpack entry (see the header
  // comment), so there is no *_WEBPACK_ENTRY constant for it. The file is the
  // byte-for-byte CopyPlugin copy of the generated src/splash.html, sitting
  // next to SXS.png in the same directory — which is exactly what the
  // template's relative "./SXS.png" resolves against.
  //
  // resolve() so a stray relative __dirname (shouldn't happen: webpack.main
  // sets node.__filename/__dirname to false, so __dirname is the real
  // .webpack/main) can't silently produce a bad path.
  splashWindow.loadFile(path.resolve(__dirname, 'splash.html'));

  splashWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  splashWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Record when the splash content actually finishes painting.
  splashWindow.webContents.once('did-finish-load', () => {
    splashReadyAt = Date.now();
    // Resolve any waiters so the main process can proceed with
    // revealing the main window only after the splash has painted.
    const waiters = splashReadyResolvers;
    splashReadyResolvers = [];
    for (const resolve of waiters) resolve();
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

// Returns a promise that resolves once the splash's content has
// painted (did-finish-load fired). Used to guarantee the splash is
// actually visible before the main window is revealed, even when the
// minimum visible duration is 0. Resolves immediately if the splash
// has already painted, was never created, or has been destroyed.
function waitForSplashReady() {
  if (splashReadyAt > 0) return Promise.resolve();
  if (!splashWindow || splashWindow.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    splashReadyResolvers.push(resolve);
  });
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
  waitForSplashReady,
};
