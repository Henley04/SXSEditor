// Splash window manager.
//
// Shows a small frameless splash while the main window boots — but NOT through a
// BrowserWindow. It uses Electron's `BaseWindow` + `ImageView`: an `ImageView`
// paints a `nativeImage` straight into a plain window view.
//
// Why that matters:
//   A BrowserWindow needs a renderer process — spawn it, parse HTML, run CSS,
//   decode the image, composite. That is ~100ms of "nothing on screen" before
//   the first pixel, and it was the single biggest chunk of the splash's
//   latency (measured A/B on this machine: dropping the preload alone was worth
//   ~100ms before this change; dropping the renderer entirely is worth more).
//   `ImageView` is created and painted on the main process's UI thread: no
//   renderer, no HTML, no preload, no font matching, no text shaping. The
//   window is up as soon as the PNG decodes.
//
// What is on screen: a build-time artefact. scripts/generate-splash-image.js
// bakes the layout, the acrylic card, the version string and the build timestamp
// into the pixels (see that file for why raster, and why those resolutions), so
// the runtime does literally zero text work. The card's 0.86 opacity and its
// 14px rounded corners are baked into the PNG's alpha too — ImageView/View have
// no opacity API, and BaseWindow's constructor-level `opacity` goes through
// SetLayeredWindowAttributes, which conflicts with the per-pixel alpha a
// transparent window relies on.
//
// DPI: one nativeImage carries two representations (2x and 3x). Electron picks
// the one closest to the window's device scale factor, so a 2x display shows the
// 2x bitmap 1:1 and a 1x display downscales the 2x one by exactly 2 — never the
// "single 4x master" that had to be squashed 4x and looked soft.
//
// History: this window used to be a BrowserWindow loading a generated HTML file
// with an inline SVG (and before that, a preload + IPC round-trip to fill in the
// version). Both are gone; git history has the rationale if the trade-offs ever
// need revisiting.
//
// ⚠️ `ImageView` is marked experimental in Electron's docs ("may be changed or
// removed"). createSplashWindow() therefore degrades to "no splash" instead of
// throwing if the classes are missing or the bitmaps were never generated —
// a missing splash must never keep the app from starting.

const { BaseWindow, ImageView, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let splashWindow = null;
let splashView = null;
let splashReadyAt = 0; // ms timestamp when the splash content first painted
let splashReadyResolvers = []; // resolved when splash content first paints

// Must match LOGICAL_W / LOGICAL_H in scripts/generate-splash-image.js.
const SPLASH_WIDTH = 480;
const SPLASH_HEIGHT = 272;

// Representations in ascending scale factor. 2x covers 1x and 2x displays (1x
// downscales by 2), 3x covers 2.5x/3x.
const SPLASH_REPS = [
  { scaleFactor: 2, file: 'splash@2x.png' },
  { scaleFactor: 3, file: 'splash@3x.png' },
];

/**
 * Skips representations no attached display can use.
 *
 * Attaching the 3x bitmap on a 2x machine would still decode 235 KiB of pixels
 * that never reach the screen — visible as a few extra ms on the critical
 * path. `screen.getAllDisplays()` is a cached lookup after ready, so the filter
 * costs less than the decode it avoids.
 */
function repsForDisplays() {
  let maxScale = 2;
  try {
    for (const d of screen.getAllDisplays()) {
      if (d.scaleFactor > maxScale) maxScale = d.scaleFactor;
    }
  } catch {
    // Screen module unavailable (shouldn't happen after ready) — keep the
    // default so we still show something.
  }
  const wanted = Math.ceil(maxScale + 0.01);
  const reps = SPLASH_REPS.filter((r) => r.scaleFactor <= wanted);
  // 1x displays: nothing matches the filter (there is no 1x bitmap by design),
  // fall back to the smallest available so the window still shows.
  return reps.length ? reps : [SPLASH_REPS[0]];
}

/**
 * Builds the multi-representation image from the generated PNGs next to this
 * bundle (.webpack/main/, copied verbatim by webpack.main.config.js's
 * CopyPlugin). Returns null when none could be read.
 */
function loadSplashImage() {
  const image = nativeImage.createEmpty();
  let added = 0;
  for (const rep of repsForDisplays()) {
    const file = path.join(__dirname, rep.file);
    try {
      image.addRepresentation({
        scaleFactor: rep.scaleFactor,
        buffer: fs.readFileSync(file),
      });
      added += 1;
    } catch (err) {
      // Missing bitmap = no splash (degraded), not a launch failure.
      console.warn(`[splash] 读取 ${rep.file} 失败：${err.message}`);
    }
  }
  return added > 0 ? image : null;
}

function markSplashReady() {
  if (splashReadyAt > 0) return;
  splashReadyAt = Date.now();
  const waiters = splashReadyResolvers;
  splashReadyResolvers = [];
  for (const resolve of waiters) resolve();
}

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.focus();
    return splashWindow;
  }

  splashReadyAt = 0;
  splashReadyResolvers = [];

  // Capability guard: ImageView landed in Electron 32 and is still experimental.
  if (typeof BaseWindow !== 'function' || typeof ImageView !== 'function') {
    console.warn('[splash] 当前 Electron 不提供 BaseWindow/ImageView，跳过启动画面');
    markSplashReady();
    return null;
  }

  const image = loadSplashImage();
  if (!image) {
    console.warn('[splash] 没有可用的启动画面位图（构建期应先跑 npm run splash:image），跳过');
    markSplashReady();
    return null;
  }

  splashWindow = new BaseWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    frame: false,
    // Needed for the rounded corners: outside the card radius the PNG is fully
    // transparent, and only a transparent window lets that through.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Nothing to wait for: the view is painted in-process, so show right away.
    show: true,
    center: true,
  });

  // No webContents exists on this window: no preload to compile, no HTML to
  // parse, no navigation to block. The renderer attack surface is gone rather
  // than configured away.
  splashView = new ImageView();
  splashView.setImage(image);
  splashWindow.setContentView(splashView);
  splashWindow.on('closed', () => {
    splashWindow = null;
    splashView = null;
  });

  // Synchronous paint: unlike did-finish-load, setContentView has already
  // committed the frame by the time it returns (the remaining gap to the
  // compositor is one frame, well below the intervals this timestamp feeds).
  markSplashReady();
  return splashWindow;
}

function getSplashWindow() {
  return splashWindow;
}

function getSplashReadyAt() {
  return splashReadyAt;
}

// Returns a promise that resolves once the splash's content has
// painted. Used to guarantee the splash is actually visible before the
// main window is revealed, even when the minimum visible duration is 0.
// Resolves immediately if the splash has already painted, was never created,
// or has been destroyed.
function waitForSplashReady() {
  if (splashReadyAt > 0) return Promise.resolve();
  if (!splashWindow || splashWindow.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    splashReadyResolvers.push(resolve);
  });
}

function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    const win = splashWindow;
    splashWindow = null;
    splashView = null;
    win.close();
  }
}

module.exports = {
  createSplashWindow,
  closeSplashWindow,
  getSplashWindow,
  getSplashReadyAt,
  waitForSplashReady,
};
