const { BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { t } = require('./locale');

const isDev = !require('electron').app.isPackaged;

let mainWindow = null;
let settingsWindow = null;
let resourceManagerWindow = null;
let modelDownloadWindow = null;
let fragmentWindows = {};
let pendingFragmentData = {};
let singerCreatorWindow = null;
let audioPreprocessWindow = null;
let pendingPreprocessData = null;
let preprocessWavBuffer = null;

let isDirty = false;
let closePending = false;

function getMainWindow() { return mainWindow; }
function getSettingsWindow() { return settingsWindow; }
function getResourceManagerWindow() { return resourceManagerWindow; }
function getModelDownloadWindow() { return modelDownloadWindow; }
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
      label: 'SXSEditor',
      submenu: [
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'SXSEditor',
    icon: path.join(__dirname, '..', 'SXS.png'),
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  mainWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (isDev) {
    mainWindow.webContents.openDevTools();
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
    width: 600,
    height: 860,
    title: t('menu.settings'),
    icon: path.join(__dirname, '..', 'SXS.png'),
    resizable: true,
    minimizable: false,
    maximizable: false,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      preload: SETTINGS_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  settingsWindow.loadURL(SETTINGS_WINDOW_WEBPACK_ENTRY);
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
    webPreferences: {
      preload: RESOURCE_MANAGER_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  resourceManagerWindow.loadURL(RESOURCE_MANAGER_WINDOW_WEBPACK_ENTRY);
  resourceManagerWindow.setMenu(null);
  resourceManagerWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  resourceManagerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  resourceManagerWindow.on('closed', () => {
    resourceManagerWindow = null;
  });
}

function createModelDownloadWindow(missingFiles, precision, DEFAULT_PRECISION) {
  if (modelDownloadWindow) {
    modelDownloadWindow.focus();
    return;
  }

  const currentPrecision = precision || DEFAULT_PRECISION;

  modelDownloadWindow = new BrowserWindow({
    width: 520,
    height: 700,
    minWidth: 420,
    minHeight: 500,
    title: '模型文件下载',
    icon: path.join(__dirname, '..', 'SXS.png'),
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    parent: mainWindow,
    webPreferences: {
      preload: MODEL_DOWNLOAD_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  modelDownloadWindow.loadURL(MODEL_DOWNLOAD_WINDOW_WEBPACK_ENTRY);
  modelDownloadWindow.setMenu(null);
  modelDownloadWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  modelDownloadWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  modelDownloadWindow.webContents.once('did-finish-load', () => {
    modelDownloadWindow.webContents.send('model-download:missing-files', missingFiles);
    modelDownloadWindow.webContents.send('model-download:precision', currentPrecision);
    modelDownloadWindow.focus();
  });

  modelDownloadWindow.on('closed', () => {
    modelDownloadWindow = null;
  });
}

function setModelDownloadWindow(win) {
  modelDownloadWindow = win;
}

function openFragmentEditor(fragment, project, wavBuffer) {
  const sendData = { fragment, project, wavBuffer };
  if (fragmentWindows[fragment.id]) {
    fragmentWindows[fragment.id].focus();
    fragmentWindows[fragment.id].webContents.send('loadFragment', sendData);
    return;
  }

  pendingFragmentData[fragment.id] = sendData;

  const fragmentWindow = new BrowserWindow({
    width: 1000,
    height: 600,
    title: `分片编辑 - ${fragment.name}`,
    icon: path.join(__dirname, '..', 'SXS.png'),
    webPreferences: {
      preload: FRAGMENT_EDITOR_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  fragmentWindow.loadURL(`${FRAGMENT_EDITOR_WINDOW_WEBPACK_ENTRY}#fragmentId=${encodeURIComponent(fragment.id)}`);
  fragmentWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  fragmentWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (isDev) {
    fragmentWindow.webContents.openDevTools();
  }

  fragmentWindows[fragment.id] = fragmentWindow;

  fragmentWindow.webContents.once('did-finish-load', () => {
    fragmentWindow.webContents.send('loadFragment', sendData);
  });

  fragmentWindow.on('closed', () => {
    delete fragmentWindows[fragment.id];
    delete pendingFragmentData[fragment.id];
  });
}

function openSingerCreator() {
  if (singerCreatorWindow) {
    singerCreatorWindow.focus();
    return;
  }

  singerCreatorWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: '歌手创建',
    icon: path.join(__dirname, '..', 'SXS.png'),
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: SINGER_CREATOR_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  singerCreatorWindow.loadURL(SINGER_CREATOR_WINDOW_WEBPACK_ENTRY);
  singerCreatorWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  singerCreatorWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  singerCreatorWindow.on('closed', () => {
    singerCreatorWindow = null;
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
    title: '音频预处理',
    icon: path.join(__dirname, '..', 'SXS.png'),
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: AUDIO_PREPROCESS_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  audioPreprocessWindow.loadURL(AUDIO_PREPROCESS_WINDOW_WEBPACK_ENTRY);
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
      if (fragmentWindows[fragmentId]) {
        fragmentWindows[fragmentId].webContents.send('fragmentDataSaved', { fragmentId, ...data });
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fragmentDataSaved', { fragmentId, ...data });
      }
      return true;
    } catch (err) {
      console.error('[Main] 保存片段数据失败:', err);
      return false;
    }
  });

  ipcMain.handle('saveFragmentData', async (event, fragmentId, data) => {
    if (fragmentWindows[fragmentId]) {
      fragmentWindows[fragmentId].webContents.send('fragmentDataSaved', { fragmentId, ...data });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fragmentDataSaved', { fragmentId, ...data });
    }
    return { success: true };
  });

  ipcMain.handle('updateFragmentBounds', async (event, fragmentId, data) => {
    if (fragmentWindows[fragmentId]) {
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

  ipcMain.handle('openAudioPreprocess', async (event, data) => {
    openAudioPreprocess(data);
  });

  ipcMain.handle('sendPreprocessData', async (event, data) => {
    if (singerCreatorWindow && !singerCreatorWindow.isDestroyed()) {
      singerCreatorWindow.webContents.send('preprocessDataSaved', data);
    }
    return { success: true };
  });

  ipcMain.on('set-dirty', (event, dirty) => {
    isDirty = dirty;
  });

  ipcMain.on('close-confirmed', () => {
    if (closePending && mainWindow && !mainWindow.isDestroyed()) {
      closePending = false;
      isDirty = false;
      mainWindow.close();
    }
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
  openFragmentEditor,
  openSingerCreator,
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
};
