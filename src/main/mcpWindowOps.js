'use strict';
/**
 * Main-process side of the automation surface: window discovery, resize,
 * reload, language switching, screenshots and session-scoped path grants.
 *
 * These live in main (not the renderer) because they act on BrowserWindow /
 * webContents themselves, and because a screenshot has to be taken outside the
 * page's own JS context.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
const { McpError, normalizeError } = require('./mcpErrors');
const security = require('./security');

function allWindows() {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
}

function describe(win) {
  const wc = win.webContents;
  const bounds = win.getBounds();
  let url = '';
  try { url = wc.getURL(); } catch (_) {}
  let title = '';
  try { title = wc.getTitle(); } catch (_) {}
  return {
    id: win.id,
    title,
    url,
    visible: win.isVisible(),
    focused: win.isFocused(),
    bounds,
  };
}

function listWindows() {
  return allWindows().map(describe);
}

function findWindow(selector) {
  const wins = allWindows();
  if (!selector) {
    const main = wins.find((w) => String(w.webContents.getURL()).includes('/main_window/'));
    if (main) return main;
    return wins[0] || null;
  }
  const asNumber = Number(selector);
  if (Number.isInteger(asNumber)) {
    const byId = wins.find((w) => w.id === asNumber);
    if (byId) return byId;
  }
  const needle = String(selector).toLowerCase();
  const byUrl = wins.find((w) => String(w.webContents.getURL()).toLowerCase().includes(needle));
  if (byUrl) return byUrl;
  const byTitle = wins.find((w) => String(w.webContents.getTitle()).toLowerCase().includes(needle));
  if (byTitle) return byTitle;
  throw new McpError('NOT_FOUND', `No window matches "${selector}"`, {
    hint: `open windows: ${wins.map((w) => `${w.id}:${w.webContents.getTitle()}`).join(' | ')}`,
  });
}

function requireWindow(selector) {
  const win = findWindow(selector);
  if (!win) throw new McpError('PRECONDITION_FAILED', 'No application window is open');
  return win;
}

function resizeWindow({ window: selector, width, height }) {
  const win = requireWindow(selector);
  // setContentSize keeps the renderer viewport at exactly width x height; the
  // OS may clamp it to the work area, which is why screenshots still emulate.
  win.setContentSize(Math.round(width), Math.round(height));
  return { window: describe(win), requested: { width, height } };
}

function reloadWindow({ window: selector }) {
  const win = requireWindow(selector);
  win.webContents.reload();
  return { window: describe(win), reloaded: true };
}

async function setLocale({ locale }) {
  const { writeJsonConfig } = require('./configStore');
  const localeModule = require('./locale');
  await writeJsonConfig('locale', { locale });
  localeModule.setLocale(locale);

  const results = [];
  for (const win of allWindows()) {
    if (win.isDestroyed()) continue;
    try {
      // initI18n() prefers localStorage, so it has to be updated before reload.
      await Promise.race([
        win.webContents.executeJavaScript(
          `localStorage.setItem('sxseditor-locale', ${JSON.stringify(locale)});`,
          true,
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('renderer did not respond in 3s')), 3000)),
      ]);
      win.webContents.reload();
      results.push({ id: win.id, title: win.webContents.getTitle(), reloaded: true });
    } catch (err) {
      results.push({ id: win.id, reloaded: false, error: normalizeError(err).message });
    }
  }
  return { locale, windows: results };
}

async function captureWindow({ window: selector, width, height, scale = 2, path: outPath, keepSize }) {
  const win = requireWindow(selector);
  const wc = win.webContents;
  const dbg = wc.debugger;

  // Reuse the DevTools protocol instead of capturePage(): capturePage returns
  // the window's physical pixel size, so a 1x Xvfb display would give a 1x PNG
  // even when the caller asked for 2x.
  let attachedHere = false;
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      attachedHere = true;
    }
  } catch (err) {
    throw new McpError('PRECONDITION_FAILED', `Cannot attach to the window: ${err.message}`);
  }

  const originalBounds = win.getContentSize();
  let resized = false;
  try {
    // Resize the real window first: when the visible size and the emulated
    // viewport differ, Chromium paints a "1200px x 700px" HUD into the
    // screenshot. Matching them keeps the capture clean; if the OS clamps the
    // window (small screen), the emulation still wins and the HUD may appear.
    const wantW = Math.round(width || 0);
    const wantH = Math.round(height || 0);
    if (wantW && wantH && !keepSize) {
      win.setContentSize(wantW, wantH);
      resized = true;
      await new Promise((r) => setTimeout(r, 250));
    }

    const view = await new Promise((resolve) => {
      wc.executeJavaScript('[window.innerWidth, window.innerHeight]', true)
        .then(([cw, ch]) => resolve({ cw, ch }))
        .catch(() => resolve({ cw: width || 1440, ch: height || 900 }));
    });
    const cw = Math.round(width || view.cw);
    const ch = Math.round(height || view.ch);

    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: cw,
      height: ch,
      deviceScaleFactor: scale,
      mobile: false,
      dontSetVisibleSize: true,
    });
    await new Promise((r) => setTimeout(r, 350));
    const shot = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const buffer = Buffer.from(shot.data, 'base64');
    if (outPath) {
      const abs = path.resolve(outPath);
      if (!security.isPathAllowed(abs)) {
        throw new McpError('FORBIDDEN', `Path is not authorized: ${abs}`, {
          hint: 'call session.grantRoot with the target directory first',
        });
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buffer);
      return { path: abs, width: cw, height: ch, scale, bytes: buffer.length };
    }
    return { mime: 'image/png', width: cw, height: ch, scale, bytes: buffer.length, base64: buffer.toString('base64') };
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw normalizeError(err);
  } finally {
    if (dbg.isAttached()) {
      try { await dbg.sendCommand('Emulation.clearDeviceMetricsOverride'); } catch (_) {}
    }
    if (attachedHere && dbg.isAttached()) {
      try { dbg.detach(); } catch (_) {}
    }
    if (resized && originalBounds && !keepSize) {
      try { win.setContentSize(originalBounds[0], originalBounds[1]); } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------- session

const SENSITIVE_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.password-store', '.npmrc', '.netrc']);

function hasUnsafeSegment(abs) {
  const parts = abs.split(path.sep).filter(Boolean);
  return parts.some((seg) => SENSITIVE_SEGMENTS.has(seg.toLowerCase()) || (seg.startsWith('.') && seg !== '.'));
}

function grantRoot({ path: dirPath }) {
  const abs = path.resolve(dirPath);
  let stat;
  let real;
  try {
    real = fs.realpathSync.native(abs);
    stat = fs.statSync(real);
  } catch (_) {
    throw new McpError('NOT_FOUND', `Directory does not exist: ${abs}`);
  }
  if (!stat.isDirectory()) throw new McpError('VALIDATION_ERROR', `Not a directory: ${abs}`, { field: 'path' });

  // Validate the resolved path, not the string we were handed: a symlink in a
  // friendly location must not turn into a grant for something else.
  if (security.isSystemPath(real)) {
    throw new McpError('FORBIDDEN', 'Refusing to grant a system directory', { field: 'path', hint: real });
  }
  if (hasUnsafeSegment(real)) {
    throw new McpError('FORBIDDEN', 'Refusing to grant a hidden or sensitive directory', { field: 'path', hint: real });
  }
  const home = path.resolve(os.homedir());
  if (real === path.parse(real).root || real === home || home.startsWith(real + path.sep)) {
    throw new McpError('FORBIDDEN', 'Refusing to grant the home directory or one of its ancestors', {
      field: 'path',
      hint: `grant a project folder instead, e.g. ${path.join(home, 'SXSEditor')}`,
    });
  }

  const granted = security.grantSessionRoot(real);
  return { path: granted, roots: security.listSessionRoots() };
}

function listRoots() {
  return { roots: security.listSessionRoots() };
}

function revokeRoots({ path: dirPath }) {
  return security.revokeSessionRoots(dirPath ? path.resolve(dirPath) : undefined);
}

module.exports = {
  listWindows,
  findWindow,
  resizeWindow,
  reloadWindow,
  setLocale,
  captureWindow,
  grantRoot,
  listRoots,
  revokeRoots,
  appVersion: () => app.getVersion(),
};
