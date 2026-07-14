const { ipcMain, shell } = require('electron');
const { loadSettings, saveSettingsFile, invalidateSettingsCache } = require('./settings');
const { checkAllUpdates, recordCheckTime, shouldShowNotification } = require('./updateChecker');
const { openUpdateNotificationWindow, getMainWindow } = require('./windowManager');

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
}

module.exports = { registerUpdateIpc };
