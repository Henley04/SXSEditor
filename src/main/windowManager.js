const { BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { t } = require('./locale');

const isDev = !require('electron').app.isPackaged;

let mainWindow = null;
let settingsWindow = null;
let resourceManagerWindow = null;
let modelDownloadWindow = null;
let updateNotificationWindow = null;
let fragmentWindows = {};
let pendingFragmentData = {};
let singerCreatorWindow = null;
let singerMarketWindow = null;
let audioPreprocessWindow = null;
let pendingPreprocessData = null;
let preprocessWavBuffer = null;

let isDirty = false;
let closePending = false;

function getMainWindow() { return mainWindow; }
function getSettingsWindow() { return settingsWindow; }
function getResourceManagerWindow() { return resourceManagerWindow; }
function getModelDownloadWindow() { return modelDownloadWindow; }
function getUpdateNotificationWindow() { return updateNotificationWindow; }
function setUpdateNotificationWindow(win) { updateNotificationWindow = win; }
function getFragmentWindows() { return fragmentWindows; }
function getSingerCreatorWindow() { return singerCreatorWindow; }
function getAudioPreprocessWindow() { return audioPreprocessWindow; }
function getPendingPreprocessData() { return pendingPreprocessData; }
function getPreprocessWavBuffer() { return preprocessWavBuffer; }
function setPreprocessWavBuffer(buf) { preprocessWavBuffer = buf; }

function setIsDirty(dirty) { isDirty = dirty; }
function getIsDirty() { return isDirty; }
function setClosePending(pending) { closePending = pending; }
function getClosePending() { return closePending; }

function buildAppMenu() {
  const { Menu } = require('electron');
  const menuTemplate = [
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.save'),
          accelerator: 'CommandOrControl+S',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('main-menu:save-request');
            }
          },
        },
        {
          label: t('menu.saveAs'),
          accelerator: 'CommandOrControl+Shift+S',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('main-menu:save-as-request');
            }
          },
        },
        { type: 'separator' },
        {
          label: t('menu.aboutSXSEditor'),
          click: () => { showAboutDialog(); },
        },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit') },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.settings'),
      submenu: [
        {
          label: t('menu.settings'),
          click: () => { openSettingsWindow(); },
        },
        {
          label: t('menu.resourceManager'),
          click: () => { openResourceManagerWindow(); },
        },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        { role: 'forceReload', label: t('menu.forceReload') },
        { role: 'toggleDevTools', label: t('menu.devTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.resetZoom') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.openLogDir'),
          click: () => {
            try {
              const nodePath = require('node:path');
              const logDir = nodePath.join(require('electron').app.getPath('userData'), 'logs');
              require('electron').shell.openPath(logDir);
            } catch (err) {
              console.warn('[Menu] Open log dir failed:', err.message);
            }
          },
        },
        {
          label: t('menu.openDumpDir'),
          click: () => {
            try {
              const nodePath = require('node:path');
              const dumpDir = nodePath.join(require('electron').app.getPath('userData'), 'dumps');
              require('electron').shell.openPath(dumpDir);
            } catch (err) {
              console.warn('[Menu] Open dump dir failed:', err.message);
            }
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

async function showAboutDialog() {
  const { app } = require('electron');
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: t('menu.aboutSXSEditor'),
    message: 'SXSEditor',
    detail: [
      `${t('about.version')}: ${app.getVersion()}`,
      '',
      t('about.soulXSingerEditor'),
      t('about.aiSvsWorkbench'),
      '',
      '© 2024-2026 SXSEditor Dev',
    ].join('\n'),
    buttons: ['OK'],
    noLink: true,
  });
}

function createWindow(opts = {}) {
  const { show = true } = opts;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'SXSEditor',
    icon: path.join(__dirname, '..', 'SXS.png'),
    backgroundColor: '#14141f',
    show,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  mainWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Defer openDevTools until did-finish-load. Opening it earlier causes
  // Chromium to reject internal blink.mojom.WidgetHost IPC messages during
  // the initial renderer bootstrap (visible as "Message N rejected by
  // interface blink.mojom.WidgetHost" errors on the console).
  if (isDev) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.openDevTools();
    });
  }

  mainWindow.on('close', (e) => {
    if (isDirty) {
      e.preventDefault();
      closePending = true;
      mainWindow.webContents.send('close-confirm');
    }
  });

  buildAppMenu();
  return mainWindow;
}

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 960,
    height: 860,
    minWidth: 960,
    minHeight: 720,
    title: t('menu.settings'),
    icon: path.join(__dirname, '..', 'SXS.png'),
    resizable: true,
    minimizable: false,
    maximizable: false,
    parent: mainWindow,
    modal: true,
    backgroundColor: '#14141f',
    show: false,
    webPreferences: {
      preload: SETTINGS_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });

  settingsWindow.loadURL(SETTINGS_WINDOW_WEBPACK_ENTRY);
  settingsWindow.once('ready-to-show', () => { settingsWindow.show(); });
  settingsWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function openResourceManagerWindow() {
  if (resourceManagerWindow) {
    resourceManagerWindow.focus();
    return;
  }

  resourceManagerWindow = new BrowserWindow({
    width: 700,
    height: 750,
    title: t('resourceManager.title'),
    icon: path.join(__dirname, '..', 'SXS.png'),
    resizable: true,
    minimizable: true,
    maximizable: false,
    parent: mainWindow,
    backgroundColor: '#14141f',
    show: false,
    webPreferences: {
      preload: RESOURCE_MANAGER_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });

  resourceManagerWindow.loadURL(RESOURCE_MANAGER_WINDOW_WEBPACK_ENTRY);
  resourceManagerWindow.once('ready-to-show', () => { resourceManagerWindow.show(); });
  resourceManagerWindow.setMenu(null);
  resourceManagerWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  resourceManagerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  resourceManagerWindow.on('closed', () => {
    resourceManagerWindow = null;
  });
}

function createModelDownloadWindow(missingFiles, precision, DEFAULT_PRECISION, revision) {
  if (modelDownloadWindow) {
    modelDownloadWindow.focus();
    return;
  }

  const currentPrecision = precision || DEFAULT_PRECISION;

  modelDownloadWindow = new BrowserWindow({
    width: 600,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    // W20: use i18n key instead of hardcoded Chinese window title.
    title: t('modelDownload.title'),
    icon: path.join(__dirname, '..', 'SXS.png'),
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    parent: mainWindow,
    backgroundColor: '#14141f',
    show: false,
    webPreferences: {
      preload: MODEL_DOWNLOAD_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });

  modelDownloadWindow.loadURL(MODEL_DOWNLOAD_WINDOW_WEBPACK_ENTRY);
  modelDownloadWindow.once('ready-to-show', () => { modelDownloadWindow.show(); });
  modelDownloadWindow.setMenu(null);
  modelDownloadWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  modelDownloadWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  modelDownloadWindow.webContents.once('did-finish-load', () => {
    modelDownloadWindow.webContents.send('model-download:missing-files', missingFiles);
    modelDownloadWindow.webContents.send('model-download:precision', currentPrecision);
    if (revision) {
      modelDownloadWindow.webContents.send('model-download:revision', revision);
    }
    modelDownloadWindow.focus();
  });

  modelDownloadWindow.on('closed', () => {
    modelDownloadWindow = null;
    // 通知所有窗口（特别是设置窗口）：模型下载窗口已关闭，
    // 让设置页面可以刷新模型状态总览区，反映最新下载/更新结果。
    for (const wc of getAllWebContents()) {
      try { wc.send('model-download:window-closed'); } catch (_) {}
    }
  });
}

function setModelDownloadWindow(win) {
  modelDownloadWindow = win;
}

function openUpdateNotificationWindow(data) {
  if (updateNotificationWindow) {
    updateNotificationWindow.focus();
    return;
  }

  updateNotificationWindow = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 420,
    minHeight: 520,
    title: t('update.title'),
    icon: path.join(__dirname, '..', 'SXS.png'),
    resizable: true,
    minimizable: false,
    maximizable: false,
    parent: mainWindow,
    modal: true,
    backgroundColor: '#14141f',
    show: false,
    webPreferences: {
      preload: UPDATE_NOTIFICATION_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });

  updateNotificationWindow.loadURL(UPDATE_NOTIFICATION_WINDOW_WEBPACK_ENTRY);
  updateNotificationWindow.once('ready-to-show', () => { updateNotificationWindow.show(); });
  updateNotificationWindow.setMenu(null);
  updateNotificationWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  updateNotificationWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  updateNotificationWindow.webContents.once('did-finish-load', () => {
    updateNotificationWindow.webContents.send('update:notification-show', data);
  });

  updateNotificationWindow.on('closed', () => {
    updateNotificationWindow = null;
  });
}

function openFragmentEditor(fragment, project, wavBuffer) {
  const sendData = { fragment, project, wavBuffer };
  if (fragmentWindows[fragment.id] && !fragmentWindows[fragment.id].isDestroyed()) {
    fragmentWindows[fragment.id].focus();
    fragmentWindows[fragment.id].webContents.send('loadFragment', sendData);
    // 窗口复用时也更新 pendingFragmentData 快照，确保 fallback getFragmentData
    // 拿到的是最新数据，避免分片编辑器在守卫放行后仍读到旧快照。
    pendingFragmentData[fragment.id] = sendData;
    return;
  }

  pendingFragmentData[fragment.id] = sendData;

  const fragmentWindow = new BrowserWindow({
    width: 1000,
    height: 600,
    // W20: use i18n key with name param instead of hardcoded Chinese title.
    title: t('fragment.title', { name: fragment.name }),
    icon: path.join(__dirname, '..', 'SXS.png'),
    backgroundColor: '#14141f',
    show: false,
    webPreferences: {
      preload: FRAGMENT_EDITOR_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });

  fragmentWindow.loadURL(`${FRAGMENT_EDITOR_WINDOW_WEBPACK_ENTRY}#fragmentId=${encodeURIComponent(fragment.id)}`);
  fragmentWindow.once('ready-to-show', () => { fragmentWindow.show(); });
  fragmentWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  fragmentWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Defer openDevTools until did-finish-load (see createWindow for rationale).
  if (isDev) {
    fragmentWindow.webContents.once('did-finish-load', () => {
      fragmentWindow.webContents.openDevTools();
    });
  }

  fragmentWindows[fragment.id] = fragmentWindow;

  fragmentWindow.webContents.once('did-finish-load', () => {
    fragmentWindow.webContents.send('loadFragment', sendData);
  });

  fragmentWindow.on('closed', () => {
    // W23: stop audio from the closing fragment window. The fragment audio
    // manager is shared across all fragment windows; without this the audio
    // keeps playing after the window closes and the onEnded callback can no
    // longer reach a live sender. stop() is a no-op when not playing, so this
    // is safe even if no audio was active. Lazy-require to avoid a circular
    // dependency with audioIpc.js (which requires getFragmentWindows from here).
    try {
      const { getFragmentAudioManager } = require('./audioIpc');
      getFragmentAudioManager().stop();
    } catch (_) {}
    delete fragmentWindows[fragment.id];
    delete pendingFragmentData[fragment.id];
  });
}

function buildSingerCreatorMenu(win) {
  const { Menu } = require('electron');
  const menuTemplate = [
    {
      label: t('singerCreator.fileMenu'),
      submenu: [
        {
          label: t('singerCreator.save'),
          accelerator: 'CommandOrControl+S',
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.send('singer-creator:save-request');
            }
          },
        },
        {
          label: t('singerCreator.saveAs'),
          accelerator: 'CommandOrControl+Shift+S',
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.send('singer-creator:save-as-request');
            }
          },
        },
        { type: 'separator' },
        {
          label: t('singerCreator.close'),
          role: 'close',
        },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        { role: 'forceReload', label: t('menu.forceReload') },
        { role: 'toggleDevTools', label: t('menu.devTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.resetZoom') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  win.setMenu(menu);
}

function openSingerCreator() {
  if (singerCreatorWindow) {
    singerCreatorWindow.focus();
    return;
  }

  singerCreatorWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: t('singerCreator.title'),
    icon: path.join(__dirname, '..', 'SXS.png'),
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#14141f',
    show: false,
    webPreferences: {
      preload: SINGER_CREATOR_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });

  singerCreatorWindow.loadURL(SINGER_CREATOR_WINDOW_WEBPACK_ENTRY);
  singerCreatorWindow.once('ready-to-show', () => { singerCreatorWindow.show(); });
  singerCreatorWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  singerCreatorWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  buildSingerCreatorMenu(singerCreatorWindow);

  singerCreatorWindow.on('closed', () => {
    singerCreatorWindow = null;
  });
}

function openSingerMarket() {
  if (singerMarketWindow) {
    singerMarketWindow.focus();
    return;
  }

  singerMarketWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: t('singerMarket.title'),
    icon: path.join(__dirname, '..', 'SXS.png'),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14141f',
    show: false,
    webPreferences: {
      preload: SINGER_MARKET_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });

  singerMarketWindow.loadURL(SINGER_MARKET_WINDOW_WEBPACK_ENTRY);
  singerMarketWindow.once('ready-to-show', () => { singerMarketWindow.show(); });
  singerMarketWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  singerMarketWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  singerMarketWindow.on('closed', () => {
    singerMarketWindow = null;
  });
}

function openAudioPreprocess(data) {
  pendingPreprocessData = {
    wavFileName: data.wavFileName,
    singerName: data.singerName,
    singerColor: data.singerColor,
    avatarImageData: data.avatarImageData,
    avatarImageName: data.avatarImageName,
  };
  preprocessWavBuffer = data.wavBuffer;

  if (audioPreprocessWindow) {
    audioPreprocessWindow.focus();
    audioPreprocessWindow.webContents.send('loadPreprocessData', { data: pendingPreprocessData, wavBuffer: preprocessWavBuffer });
    return;
  }

  audioPreprocessWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // W20: use i18n key instead of hardcoded Chinese window title.
    title: t('preprocess.title'),
    icon: path.join(__dirname, '..', 'SXS.png'),
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#14141f',
    show: false,
    webPreferences: {
      preload: AUDIO_PREPROCESS_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });

  audioPreprocessWindow.loadURL(AUDIO_PREPROCESS_WINDOW_WEBPACK_ENTRY);
  audioPreprocessWindow.once('ready-to-show', () => { audioPreprocessWindow.show(); });
  audioPreprocessWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  audioPreprocessWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  audioPreprocessWindow.webContents.once('did-finish-load', () => {
    audioPreprocessWindow.webContents.send('loadPreprocessData', { data: pendingPreprocessData, wavBuffer: preprocessWavBuffer });
    preprocessWavBuffer = null;
  });

  audioPreprocessWindow.on('closed', () => {
    audioPreprocessWindow = null;
    pendingPreprocessData = null;
    preprocessWavBuffer = null;
  });
}

function closeFragmentEditor(fragmentId) {
  const win = fragmentWindows[fragmentId];
  if (win && !win.isDestroyed()) {
    win.destroy();
  }
  delete fragmentWindows[fragmentId];
  delete pendingFragmentData[fragmentId];
}

function closeAllFragmentEditors() {
  for (const id in fragmentWindows) {
    closeFragmentEditor(id);
  }
}

function getAllWebContents() {
  return BrowserWindow.getAllWindows().map(w => w.webContents).filter(Boolean);
}

function registerWindowIpc() {
  ipcMain.handle('openFragmentEditor', async (event, { fragment, project, wavBuffer }) => {
    openFragmentEditor(fragment, project, wavBuffer);
  });

  ipcMain.handle('getFragmentData', async (event, fragmentId) => {
    return pendingFragmentData[fragmentId] || null;
  });

  ipcMain.handle('saveFragmentDataSync', async (event, fragmentId, data) => {
    try {
      if (fragmentWindows[fragmentId] && !fragmentWindows[fragmentId].isDestroyed()) {
        fragmentWindows[fragmentId].webContents.send('fragmentDataSaved', { fragmentId, ...data });
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fragmentDataSaved', { fragmentId, ...data });
      }
      return true;
    } catch (err) {
      console.error('[Main] Failed to save fragment data:', err);
      return false;
    }
  });

  ipcMain.handle('saveFragmentData', async (event, fragmentId, data) => {
    if (fragmentWindows[fragmentId] && !fragmentWindows[fragmentId].isDestroyed()) {
      fragmentWindows[fragmentId].webContents.send('fragmentDataSaved', { fragmentId, ...data });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fragmentDataSaved', { fragmentId, ...data });
    }
    return { success: true };
  });

  ipcMain.handle('fragment:close', async (event, fragmentId) => {
    closeFragmentEditor(fragmentId);
    return { success: true };
  });

  ipcMain.handle('fragment:closeAll', async () => {
    closeAllFragmentEditors();
    return { success: true };
  });

  ipcMain.handle('updateFragmentBounds', async (event, fragmentId, data) => {
    // 同步刷新 pendingFragmentData 快照里的边界，避免分片编辑器在 currentFragment
    // 就绪前收到 fragmentBoundsChanged 被守卫丢弃后，又用旧快照覆盖 currentFragment，
    // 导致主页面对分片长度/结尾的修改偶现不同步。
    const pending = pendingFragmentData[fragmentId];
    if (pending && pending.fragment) {
      if (data.startTime !== undefined) pending.fragment.startTime = data.startTime;
      if (data.duration !== undefined) pending.fragment.duration = data.duration;
    }
    if (fragmentWindows[fragmentId] && !fragmentWindows[fragmentId].isDestroyed()) {
      fragmentWindows[fragmentId].webContents.send('fragmentBoundsChanged', { fragmentId, ...data });
    }
    return { success: true };
  });

  ipcMain.handle('updateProjectSettings', async (event, projectData) => {
    for (const id in fragmentWindows) {
      if (fragmentWindows[id] && !fragmentWindows[id].isDestroyed()) {
        fragmentWindows[id].webContents.send('projectSettingsChanged', projectData);
      }
    }
    return { success: true };
  });

  ipcMain.handle('openSingerCreator', async () => {
    openSingerCreator();
  });

  ipcMain.handle('openSingerMarket', async () => {
    openSingerMarket();
  });

  ipcMain.handle('openAudioPreprocess', async (event, data) => {
    openAudioPreprocess(data);
  });

  ipcMain.handle('sendPreprocessData', async (event, data) => {
    if (singerCreatorWindow && !singerCreatorWindow.isDestroyed()) {
      singerCreatorWindow.webContents.send('preprocessDataSaved', data);
    }
    return { success: true };
  });


  ipcMain.handle('set-dirty', async (event, dirty) => {
    isDirty = dirty;
    return { success: true };
  });

  ipcMain.handle('close-confirmed', async () => {
    if (closePending && mainWindow && !mainWindow.isDestroyed()) {
      closePending = false;
      isDirty = false;
      mainWindow.close();
    }
    return { success: true };
  });

  ipcMain.handle('reload-main-window', async () => {
    buildAppMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('locale-changed');
      mainWindow.reload();
    }
  });
}

module.exports = {
  createWindow,
  openSettingsWindow,
  openResourceManagerWindow,
  createModelDownloadWindow,
  setModelDownloadWindow,
  openUpdateNotificationWindow,
  getUpdateNotificationWindow,
  setUpdateNotificationWindow,
  openFragmentEditor,
  openSingerCreator,
  openSingerMarket,
  openAudioPreprocess,
  showAboutDialog,
  buildAppMenu,
  getAllWebContents,
  registerWindowIpc,
  getMainWindow,
  getSettingsWindow,
  getResourceManagerWindow,
  getModelDownloadWindow,
  getFragmentWindows,
  getSingerCreatorWindow,
  getAudioPreprocessWindow,
  getPendingPreprocessData,
  getPreprocessWavBuffer,
  setPreprocessWavBuffer,
  setIsDirty,
  getIsDirty,
  setClosePending,
  getClosePending,
  closeAllFragmentEditors,
  closeFragmentEditor,
};
