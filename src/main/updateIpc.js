const { ipcMain, shell, app } = require('electron');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { loadSettings, saveSettingsFile } = require('./settings');
const { checkAllUpdates, recordCheckTime, shouldShowNotification } = require('./updateChecker');
const { openUpdateNotificationWindow, getUpdateNotificationWindow } = require('./windowManager');

// In-app installer download state.
// GitHub release assets redirect (302) to objects.githubusercontent.com, so we
// must follow redirects manually via https.request. The downloaded installer
// is written to a temp dir and then spawned detached so the InnoSetup wizard
// can take over after the app quits.
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min socket timeout
const PROGRESS_THROTTLE_MS = 100;
// Installer temp dir under os.tmpdir(). All downloaded installers land here
// so they can be cleaned up centrally (old files are pruned on app start and
// before each new download).
const UPDATE_TMP_DIR = path.join(os.tmpdir(), 'sxseditor-update');
// Leftover installers older than this are considered stale and removed on
// app startup. 7 days is long enough for the user to retry a failed install
// while still reclaiming disk space from forgotten downloads.
const STALE_INSTALLER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let currentDownload = null; // { abortController, filePath }

function _getUpdateWindow() {
  const win = getUpdateNotificationWindow && getUpdateNotificationWindow();
  return win && !win.isDestroyed() ? win : null;
}

function _sendProgress(progress) {
  const win = _getUpdateWindow();
  if (win) win.webContents.send('update:download-progress', progress);
}

function _sendComplete(payload) {
  const win = _getUpdateWindow();
  if (win) win.webContents.send('update:download-complete', payload);
}

function _sendError(payload) {
  const win = _getUpdateWindow();
  if (win) win.webContents.send('update:download-error', payload);
}

/**
 * Remove leftover installer .exe files from UPDATE_TMP_DIR.
 *
 * - With `mode === 'all'`: removes every .exe in the dir (used right before a
 *   new download so we don't accumulate stale installers).
 * - With `mode === 'stale'`: removes only files older than STALE_INSTALLER_TTL_MS
 *   (used on app startup to reclaim disk from forgotten downloads).
 *
 * Files currently being written or locked by the installer are skipped
 * silently — fs.unlinkSync errors are swallowed because the OS will reap
 * them later, and we never want cleanup to break a running download.
 */
function cleanupInstallerTempFiles(mode) {
  try {
    if (!fs.existsSync(UPDATE_TMP_DIR)) return;
    const entries = fs.readdirSync(UPDATE_TMP_DIR);
    const now = Date.now();
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.exe')) continue;
      const filePath = path.join(UPDATE_TMP_DIR, name);
      // Never touch the file currently being downloaded.
      if (currentDownload && currentDownload.filePath === filePath) continue;
      try {
        const stat = fs.statSync(filePath);
        if (mode === 'all') {
          try { fs.unlinkSync(filePath); } catch (_) {}
        } else if (mode === 'stale') {
          if (now - stat.mtimeMs > STALE_INSTALLER_TTL_MS) {
            try { fs.unlinkSync(filePath); } catch (_) {}
          }
        }
      } catch (_) {
        // stat failed (file vanished or locked) — skip
      }
    }
  } catch (_) {
    // readdirSync failed — temp dir inaccessible, nothing to clean
  }
}

/**
 * Download a GitHub release asset to destPath, following redirects.
 * Resolves with { filePath, size }. Rejects on HTTP/network error or abort.
 * Sends 'update:download-progress' events to the update window.
 */
function _downloadFile(url, destPath, abortController) {
  return new Promise((resolve, reject) => {
    let redirectCount = 0;
    let received = 0;
    let total = 0;
    let writeStream = null;
    let lastProgressTime = 0;
    let settled = false;

    const cleanup = () => {
      if (writeStream) {
        try { writeStream.close(); } catch (_) {}
        writeStream = null;
      }
      try { fs.unlinkSync(destPath); } catch (_) {}
    };

    const doRequest = (targetUrl) => {
      const req = https.request(targetUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'SXSEditor-Updater' },
      }, (res) => {
        const status = res.statusCode;
        if (
          (status === 301 || status === 302 || status === 307 || status === 308) &&
          res.headers.location &&
          redirectCount < MAX_REDIRECTS
        ) {
          redirectCount++;
          res.resume();
          doRequest(res.headers.location);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          if (!settled) { settled = true; reject(new Error(`HTTP ${status}`)); }
          return;
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        received = 0;
        writeStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (now - lastProgressTime > PROGRESS_THROTTLE_MS || (total > 0 && received >= total)) {
            lastProgressTime = now;
            const percent = total > 0 ? (received / total) * 100 : 0;
            _sendProgress({ percent, received, total });
          }
        });

        res.pipe(writeStream);
        writeStream.on('finish', () => {
          writeStream.close((err) => {
            if (settled) return;
            if (err) {
              settled = true;
              cleanup();
              reject(err);
            } else {
              settled = true;
              resolve({ filePath: destPath, size: received });
            }
          });
        });
        writeStream.on('error', (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        });
      });

      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      abortController.signal.addEventListener('abort', () => {
        if (settled) return;
        settled = true;
        req.destroy(new Error('aborted'));
        cleanup();
        reject(new Error('aborted'));
      }, { once: true });

      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        if (settled) return;
        settled = true;
        req.destroy(new Error('download timeout'));
        cleanup();
        reject(new Error('download timeout'));
      });

      req.end();
    };

    doRequest(url);
  });
}

function registerUpdateIpc() {
  ipcMain.handle('update:check-now', async () => {
    const s = loadSettings();
    const channel = s.updateChannel || 'release';
    const result = await checkAllUpdates(channel);
    await recordCheckTime();
    // Manual check: open notification window if update found (dontRemind does NOT block manual)
    if (shouldShowNotification(result.app, result.models, loadSettings(), true)) {
      openUpdateNotificationWindow(result);
    }
    return result;
  });

  ipcMain.handle('update:get-status', async () => {
    const s = loadSettings();
    return {
      updateChannel: s.updateChannel,
      autoCheckUpdates: s.autoCheckUpdates,
      skippedAppVersion: s.skippedAppVersion,
      dontRemindAppUpdates: s.dontRemindAppUpdates,
      lastUpdateCheckTime: s.lastUpdateCheckTime,
      currentVersion: require('electron').app.getVersion(),
    };
  });

  ipcMain.handle('update:skip-version', async (event, version) => {
    const s = loadSettings();
    s.skippedAppVersion = (typeof version === 'string') ? version : null;
    await saveSettingsFile(s);
    return { success: true };
  });

  ipcMain.handle('update:dont-remind', async () => {
    const s = loadSettings();
    s.dontRemindAppUpdates = true;
    await saveSettingsFile(s);
    return { success: true };
  });

  ipcMain.handle('update:open-download-page', async (event, url) => {
    const ALLOWED = ['https://github.com/Henley04/SXSEditor/', 'https://henley04.github.io/SXSEditor/'];
    if (!url || typeof url !== 'string') return { success: false };
    const ok = ALLOWED.some((p) => url.startsWith(p));
    if (!ok) return { success: false, error: 'URL not allowed' };
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('update:open-model-download', async () => {
    // Open the model download window so the user can update any model group
    // (main / JP / SiFiGAN). Passing an empty missing list lets the window
    // perform its own checks and display the current state of all groups.
    const { createModelDownloadWindow } = require('./windowManager');
    const { DEFAULT_PRECISION } = require('../modelManager');
    const s = loadSettings();
    const precision = s.modelPrecision || DEFAULT_PRECISION;
    createModelDownloadWindow([], precision, DEFAULT_PRECISION);
    return { success: true };
  });

  /**
   * Start downloading the app installer in-app. Progress events are pushed
   * to the update notification window via 'update:download-progress'.
   * On success, 'update:download-complete' is emitted with the file path.
   */
  ipcMain.handle('update:download-installer', async (event, payload) => {
    if (currentDownload) {
      return { success: false, error: 'download_in_progress' };
    }
    const url = payload && typeof payload.url === 'string' ? payload.url : null;
    const version = payload && typeof payload.version === 'string' ? payload.version : null;
    if (!url) {
      return { success: false, error: 'invalid_url' };
    }

    try {
      fs.mkdirSync(UPDATE_TMP_DIR, { recursive: true });
    } catch (e) {
      return { success: false, error: `mkdir_failed: ${e.message}` };
    }
    // Purge any previous installers so we don't accumulate stale .exe files
    // across versions (the InnoSetup installer has already run for those).
    cleanupInstallerTempFiles('all');

    const safeVersion = (version || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
    const fileName = `sxsinstaller-${safeVersion}.exe`;
    const filePath = path.join(UPDATE_TMP_DIR, fileName);

    const abortController = new AbortController();
    currentDownload = { abortController, filePath };

    try {
      const result = await _downloadFile(url, filePath, abortController);
      currentDownload = null;
      _sendComplete({ filePath: result.filePath, size: result.size, version });
      return { success: true, filePath: result.filePath, size: result.size };
    } catch (err) {
      currentDownload = null;
      const aborted = err.message === 'aborted';
      if (!aborted) {
        _sendError({ error: err.message });
      }
      return { success: false, error: aborted ? 'cancelled' : err.message };
    }
  });

  ipcMain.handle('update:cancel-download', async () => {
    if (currentDownload) {
      try { currentDownload.abortController.abort(); } catch (_) {}
      return { success: true };
    }
    return { success: false, error: 'no_download' };
  });

  /**
   * Launch the downloaded installer (InnoSetup .exe) detached and quit the app.
   * The installer takes over the upgrade flow, including file replacement and
   * optionally relaunching the app via its [Run] section.
   */
  ipcMain.handle('update:install-installer', async (event, payload) => {
    const filePath = payload && typeof payload.filePath === 'string' ? payload.filePath : null;
    if (!filePath) {
      return { success: false, error: 'invalid_path' };
    }
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: 'file_not_found' };
    }
    if (!resolvedPath.toLowerCase().endsWith('.exe')) {
      return { success: false, error: 'not_exe' };
    }

    try {
      // Spawn the InnoSetup installer detached so it survives app.quit().
      // stdio:'ignore' + windowsHide:false lets the wizard UI show normally.
      const child = spawn(resolvedPath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      // Quit the app after a short delay so the installer can take over.
      // The InnoSetup script's [Run] section handles relaunching the app.
      setTimeout(() => {
        try { app.quit(); } catch (_) {}
      }, 500);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerUpdateIpc, cleanupInstallerTempFiles };
