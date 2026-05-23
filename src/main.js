const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const mainLocales = {
  'zh-CN': {
    menu: {
      aboutSXSEditor: '关于 SXSEditor',
      quit: '退出',
      edit: '编辑',
      undo: '撤销',
      redo: '重做',
      cut: '剪切',
      copy: '复制',
      paste: '粘贴',
      selectAll: '全选',
      settings: '设置',
      resourceManager: '资源管理器',
      view: '视图',
      reload: '重新加载',
      forceReload: '强制重新加载',
      devTools: '开发者工具',
      resetZoom: '重置缩放',
      zoomIn: '放大',
      zoomOut: '缩小',
      fullscreen: '全屏',
    },
    dialog: {
      saveSingerFile: '保存歌手文件',
      selectModelDownloadLocation: '选择模型文件下载位置（默认位置无需管理员权限）',
      selectFolder: '选择此文件夹',
      importMidi: '导入MIDI文件',
    },
    error: {
      pathNotAllowed: '不允许访问该路径',
      svsNotInitialized: 'SVS Pipeline 未初始化',
      fragmentSvsNotInitialized: 'Fragment SVS Pipeline 未初始化',
    },
    about: {
      soulXSingerEditor: 'SoulX Singer 编辑器',
      aiSvsWorkbench: '基于 ONNX Runtime / DirectML 的 AI 歌声合成工作台',
      version: '版本',
    },
    resourceManager: {
      title: '资源管理器',
    },
  },
  'en': {
    menu: {
      aboutSXSEditor: 'About SXSEditor',
      quit: 'Quit',
      edit: 'Edit',
      undo: 'Undo',
      redo: 'Redo',
      cut: 'Cut',
      copy: 'Copy',
      paste: 'Paste',
      selectAll: 'Select All',
      settings: 'Settings',
      resourceManager: 'Resource Manager',
      view: 'View',
      reload: 'Reload',
      forceReload: 'Force Reload',
      devTools: 'Developer Tools',
      resetZoom: 'Reset Zoom',
      zoomIn: 'Zoom In',
      zoomOut: 'Zoom Out',
      fullscreen: 'Fullscreen',
    },
    dialog: {
      saveSingerFile: 'Save Singer File',
      selectModelDownloadLocation: 'Select model file download location (default location doesn\'t require admin privileges)',
      selectFolder: 'Select This Folder',
      importMidi: 'Import MIDI File',
    },
    error: {
      pathNotAllowed: 'Access to this path is not allowed',
      svsNotInitialized: 'SVS Pipeline not initialized',
      fragmentSvsNotInitialized: 'Fragment SVS Pipeline not initialized',
    },
    about: {
      soulXSingerEditor: 'SoulX Singer Editor',
      aiSvsWorkbench: 'AI Singing Voice Synthesis Workbench based on ONNX Runtime / DirectML',
      version: 'Version',
    },
    resourceManager: {
      title: 'Resource Manager',
    },
  },
};

let mainLocale = 'zh-CN';

function loadMainLocale() {
  try {
    const configPath = path.join(app.getPath('userData'), 'sxseditor-locale.json');
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data.locale && mainLocales[data.locale]) {
        mainLocale = data.locale;
      }
    }
  } catch (_) {}
}

function t(key, params) {
  const resolve = (obj, k) => k.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : undefined), obj);
  let value = resolve(mainLocales[mainLocale], key);
  if (value === undefined) value = resolve(mainLocales['zh-CN'], key);
  if (value === undefined) return key;
  if (params) {
    return value.replace(/\{(\w+)\}/g, (_, name) => params[name] !== undefined ? params[name] : `{${name}}`);
  }
  return value;
}

if (require('electron-squirrel-startup')) {
  app.quit();
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const { OnnxSVSPipeline, SAMPLE_RATE, enumerateDMLDevices } = require('./inference/nativeSvsPipeline');
const { RmvpePitchDetector, RMVPE_SAMPLE_RATE } = require('./inference/rmvpePitchDetector');
const { BasicPitchDetector } = require('./inference/basicPitch');
const { parseMidiFile } = require('./inference/midiParser');
const { AudioOutputManager } = require('./audio/audioOutputManager');
const { checkMissingFiles, downloadMissingFiles, DEFAULT_PRECISION } = require('./modelManager');
const { getModelGroups } = require('./modelRegistry');

let svsPipeline = null;
let rmvpeDetector = null;
let basicPitchDetector = null;
let mainWindow = null;
let settingsWindow = null;
let resourceManagerWindow = null;
let cachedDMLDevices = null;
let isDirty = false;
let closePending = false;

const ALLOWED_SAVE_DIRS = [
  () => app.getPath('userData'),
  () => app.getPath('documents'),
  () => app.getPath('desktop'),
  () => app.getPath('home'),
  () => app.getPath('temp'),
];

const dialogAuthorizedPaths = new Set();

function authorizePath(filePath) {
  if (typeof filePath === 'string' && filePath.length > 0) {
    dialogAuthorizedPaths.add(path.resolve(filePath));
    const dir = path.dirname(path.resolve(filePath));
    dialogAuthorizedPaths.add(dir);
  }
}

function isPathAllowed(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (dialogAuthorizedPaths.has(resolved)) return true;
    if (dialogAuthorizedPaths.has(path.dirname(resolved))) return true;
    return ALLOWED_SAVE_DIRS.some(dirFn => {
      try {
        return resolved.startsWith(path.resolve(dirFn()));
      } catch (_) {
        return false;
      }
    });
  } catch (_) {
    return false;
  }
}

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const filePath = getSettingsFilePath();
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    console.warn('[Main] 加载设置失败，将使用默认设置:', err.message);
  }
  return {};
}

async function saveSettingsFile(settings) {
  try {
    const filePath = getSettingsFilePath();
    await fs.promises.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Main] 保存设置失败:', err);
  }
}

const isDev = !app.isPackaged;

function buildAppMenu() {
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

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'SXSEditor',
    icon: path.join(__dirname, 'SXS.png'),
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

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
};

async function showAboutDialog() {
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

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 860,
    title: t('menu.settings'),
    icon: path.join(__dirname, 'SXS.png'),
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
    icon: path.join(__dirname, 'SXS.png'),
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

  resourceManagerWindow.on('closed', () => {
    resourceManagerWindow = null;
  });
}

async function queryGPUVRAMUsage() {
  try {
    const gpu = require('@oxmc/node-gpuinfo');
    const count = gpu.getGpuCount();
    if (count <= 0) return [];

    const allInfo = gpu.getAllGpuInfo();
    return allInfo.map((info, idx) => ({
      adapterIndex: idx,
      name: info.name || '',
      totalBytes: (info.memoryTotal || 0) * 1024 * 1024, // MB → Bytes
      usageBytes: (info.memoryUsed || 0) * 1024 * 1024,
      budgetBytes: (info.memoryTotal || 0) * 1024 * 1024,
    }));
  } catch (e) {
    console.warn('[Main] node-gpuinfo VRAM 查询失败:', e.message);
    return [];
  }
}

let modelDownloadWindow = null;
let downloadAbortController = null;
let customModelDir = null;

function createModelDownloadWindow(missingFiles, precision) {
  if (modelDownloadWindow) {
    modelDownloadWindow.focus();
    return;
  }

  const currentPrecision = precision || DEFAULT_PRECISION;

  modelDownloadWindow = new BrowserWindow({
    width: 520,
    height: 560,
    title: '模型文件下载',
    icon: path.join(__dirname, 'SXS.png'),
    resizable: false,
    minimizable: true,
    maximizable: false,
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

  modelDownloadWindow.webContents.once('did-finish-load', () => {
    modelDownloadWindow.webContents.send('model-download:missing-files', missingFiles);
    modelDownloadWindow.webContents.send('model-download:precision', currentPrecision);
    modelDownloadWindow.focus();
  });

  modelDownloadWindow.on('closed', () => {
    if (downloadAbortController) {
      downloadAbortController.abort();
      downloadAbortController = null;
    }
    modelDownloadWindow = null;
  });
}

async function startModelDownload(modelDir, missingFiles, precision) {
  downloadAbortController = new AbortController();
  const abortSignal = downloadAbortController.signal;
  const currentPrecision = precision || DEFAULT_PRECISION;

  try {
    await downloadMissingFiles(modelDir, missingFiles, {
      abortSignal,
      precision: currentPrecision,
      onProgress: (data) => {
        if (modelDownloadWindow && !modelDownloadWindow.isDestroyed()) {
          modelDownloadWindow.webContents.send('model-download:progress', data);
        }
      },
      onFileStart: (filePath, fileIndex, totalFiles) => {
        if (modelDownloadWindow && !modelDownloadWindow.isDestroyed()) {
          modelDownloadWindow.webContents.send('model-download:file-start', { filePath, fileIndex, totalFiles });
        }
      },
      onFileComplete: (filePath, fileIndex, totalFiles) => {
        if (modelDownloadWindow && !modelDownloadWindow.isDestroyed()) {
          modelDownloadWindow.webContents.send('model-download:file-complete', { filePath, fileIndex, totalFiles });
        }
      },
    });

    if (modelDownloadWindow && !modelDownloadWindow.isDestroyed()) {
      modelDownloadWindow.webContents.send('model-download:complete');
    }
    console.log('[Main] 所有模型文件下载完成');
  } catch (err) {
    if (err.message === 'Download cancelled') {
      console.log('[Main] 模型下载已取消');
    } else {
      console.error('[Main] 模型下载失败:', err);
      if (modelDownloadWindow && !modelDownloadWindow.isDestroyed()) {
        modelDownloadWindow.webContents.send('model-download:error', { message: err.message });
      }
    }
  } finally {
    downloadAbortController = null;
  }
}

async function checkAndDownloadModels() {
  if (app.isPackaged) {
    const settings = loadSettings();
    if (settings.modelDir && typeof settings.modelDir === 'string') {
      try {
        fs.mkdirSync(settings.modelDir, { recursive: true });
        customModelDir = settings.modelDir;
      } catch (_) {
        customModelDir = null;
      }
    }
  }

  const modelDir = getModelDir();
  const precision = loadSettings().modelPrecision || DEFAULT_PRECISION;
  console.log('[Main] 检查模型文件，目录:', modelDir, '精度:', precision);
  const { missing, existing } = checkMissingFiles(modelDir);

  if (missing.length === 0) {
    console.log('[Main] 所有模型文件已就绪');
    return true;
  }

  if (app.isPackaged && !customModelDir) {
    const defaultDir = path.join(app.getPath('userData'), 'onnx_models');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.selectModelDownloadLocation'),
      defaultPath: defaultDir,
      properties: ['openDirectory'],
      buttonLabel: t('dialog.selectFolder'),
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      console.log('[Main] 用户取消了模型下载位置选择');
      return false;
    }

    let downloadDir = result.filePaths[0];
    if (!downloadDir.endsWith(path.sep)) {
      downloadDir = downloadDir + path.sep;
    }

    customModelDir = downloadDir;
    const settings = loadSettings();
    settings.modelDir = downloadDir;
    await saveSettingsFile(settings);

    try {
      fs.mkdirSync(downloadDir, { recursive: true });
    } catch (_) {}

    const recheck = checkMissingFiles(downloadDir);
    if (recheck.missing.length === 0) {
      console.log('[Main] 所选目录中模型文件已就绪');
      return true;
    }

    console.log(`[Main] 缺少 ${recheck.missing.length} 个模型文件:`, recheck.missing.map(f => f.filePath));
    createModelDownloadWindow(recheck.missing, precision);
    return false;
  }

  console.log(`[Main] 缺少 ${missing.length} 个模型文件:`, missing.map(f => f.filePath));
  createModelDownloadWindow(missing, precision);
  return false;
}

ipcMain.handle('model-download:start', async (event, precision) => {
  const modelDir = getModelDir();
  const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
  const { missing } = checkMissingFiles(modelDir);
  if (missing.length === 0) return { success: true };
  await startModelDownload(modelDir, missing, currentPrecision);
  return { success: true };
});

ipcMain.handle('model-download:cancel', async () => {
  if (downloadAbortController) {
    downloadAbortController.abort();
    downloadAbortController = null;
  }
  return { success: true };
});

ipcMain.handle('model-download:check', async () => {
  const modelDir = getModelDir();
  const { missing, existing } = checkMissingFiles(modelDir);
  return { missing, existing };
});

ipcMain.handle('model-download:change-dir', async () => {
  const defaultDir = customModelDir || path.join(app.getPath('userData'), 'onnx_models');
  const result = await dialog.showOpenDialog(modelDownloadWindow || mainWindow, {
    title: t('dialog.selectModelDownloadLocation'),
    defaultPath: defaultDir,
    properties: ['openDirectory'],
    buttonLabel: t('dialog.selectFolder'),
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true };
  }

  let downloadDir = result.filePaths[0];
  if (!downloadDir.endsWith(path.sep)) {
    downloadDir = downloadDir + path.sep;
  }

  customModelDir = downloadDir;
  const settings = loadSettings();
  settings.modelDir = downloadDir;
  await saveSettingsFile(settings);

  try {
    fs.mkdirSync(downloadDir, { recursive: true });
  } catch (_) {}

  const { missing, existing } = checkMissingFiles(downloadDir);
  return { canceled: false, modelDir: downloadDir, missing, existing };
});

ipcMain.handle('model-download:get-dir', async () => {
  return getModelDir();
});

ipcMain.handle('model-download:open', async (event, precision) => {
  const currentPrecision = precision || loadSettings().modelPrecision || DEFAULT_PRECISION;
  const modelDir = getModelDir();
  const { missing } = checkMissingFiles(modelDir);
  createModelDownloadWindow(missing, currentPrecision);
  return { success: true, missingCount: missing.length };
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  loadMainLocale();
  createWindow();
  // 预加载GPU设备枚举，避免首次设置页面打开时阻塞
  enumerateDMLDevices(getModelDir()).then(devices => {
    cachedDMLDevices = devices;
    console.log(`[Main] GPU设备预加载完成: ${devices.length} 个设备`);
  }).catch(err => {
    console.warn('[Main] GPU设备预加载失败:', err.message);
  });
  await checkAndDownloadModels();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(err => {
  console.error('[Main] 应用初始化失败:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (svsPipeline) { try { svsPipeline.dispose(); } catch (_) {} svsPipeline = null; }
  if (rmvpeDetector) { try { rmvpeDetector.dispose(); } catch (_) {} rmvpeDetector = null; }
  if (basicPitchDetector) { try { basicPitchDetector.dispose(); } catch (_) {} basicPitchDetector = null; }
  if (_audioManager) { try { _audioManager.stop(); } catch (_) {} }
  if (_fragmentAudioManager) { try { _fragmentAudioManager.stop(); } catch (_) {} }
  for (const id in fragmentWindows) {
    if (fragmentWindows[id] && !fragmentWindows[id].isDestroyed()) {
      fragmentWindows[id].destroy();
    }
  }
  fragmentWindows = {};
});

ipcMain.handle('dialog:showSaveDialog', async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const safeOptions = {
    title: typeof options.title === 'string' ? options.title : undefined,
    defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : undefined,
    filters: Array.isArray(options.filters) ? options.filters : undefined,
  };
  const result = await dialog.showSaveDialog(win, safeOptions);
  if (!result.canceled && result.filePath) {
    authorizePath(result.filePath);
  }
  return result;
});

ipcMain.handle('dialog:showOpenDialog', async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const safeOptions = {
    title: typeof options.title === 'string' ? options.title : undefined,
    defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : undefined,
    filters: Array.isArray(options.filters) ? options.filters : undefined,
    properties: Array.isArray(options.properties) ? options.properties.filter(p =>
      ['openFile', 'openDirectory', 'multiSelections'].includes(p)
    ) : ['openFile'],
  };
  const result = await dialog.showOpenDialog(win, safeOptions);
  if (!result.canceled && result.filePaths) {
    result.filePaths.forEach(fp => authorizePath(fp));
  }
  return result;
});

ipcMain.handle('file:saveFile', async (event, filePath, data) => {
  if (!isPathAllowed(filePath)) {
    return { success: false, error: t('error.pathNotAllowed') };
  }
  try {
    await fs.promises.writeFile(filePath, data);
    return { success: true };
  } catch (err) {
    console.error('[Main] 文件保存失败:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file:readFile', async (event, filePath) => {
  if (!isPathAllowed(filePath)) {
    throw new Error(t('error.pathNotAllowed'));
  }
  try {
    const data = await fs.promises.readFile(filePath, 'utf-8');
    return data;
  } catch (err) {
    console.error('[Main] 文件读取失败:', err.message);
    throw err;
  }
});

ipcMain.handle('file:readFileBuffer', async (event, filePath) => {
  if (!isPathAllowed(filePath)) {
    throw new Error(t('error.pathNotAllowed'));
  }
  try {
    const buffer = await fs.promises.readFile(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  } catch (err) {
    console.error('[Main] 文件读取(Buffer)失败:', err.message);
    throw err;
  }
});

function getUnpackedModelDir() {
  let appPath = app.getAppPath();
  if (appPath.endsWith('.asar')) {
    appPath = appPath + '.unpacked';
  }
  return path.join(appPath, 'onnx_models') + path.sep;
}

function getModelDir() {
  if (!app.isPackaged) {
    return getUnpackedModelDir();
  }

  if (customModelDir) {
    try {
      fs.mkdirSync(customModelDir, { recursive: true });
    } catch (_) {}
    return customModelDir;
  }

  const unpackedDir = getUnpackedModelDir();
  const { missing } = checkMissingFiles(unpackedDir);
  if (missing.length === 0) {
    console.log('[Main] 在 app.asar.unpacked 中找到完整模型文件');
    return unpackedDir;
  }

  console.log('[Main] app.asar.unpacked 中模型文件不完整，缺少', missing.length, '个文件');
  const userDataDir = app.getPath('userData');
  const modelDir = path.join(userDataDir, 'onnx_models');
  fs.mkdirSync(modelDir, { recursive: true });
  return modelDir + path.sep;
}

ipcMain.handle('settings:getDMLDevices', async () => {
  try {
    if (!cachedDMLDevices) {
      const modelDir = getModelDir();
      console.log('[Main] 枚举 DML 设备，模型目录:', modelDir);
      cachedDMLDevices = await enumerateDMLDevices(modelDir);
    }
    return cachedDMLDevices;
  } catch (err) {
    console.error('[Main] 枚举 DML 设备失败:', err);
    return [];
  }
});

ipcMain.handle('settings:getCurrentHardware', async () => {
  try {
    if (svsPipeline && svsPipeline.initialized) {
      return svsPipeline.getHardwareInfo();
    }
    return null;
  } catch (err) {
    console.error('[Main] 获取当前硬件信息失败:', err);
    return null;
  }
});

ipcMain.handle('settings:getSettings', async () => {
  return loadSettings();
});

ipcMain.handle('app:getVersion', async () => {
  return app.getVersion();
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

ipcMain.handle('settings:saveSettings', async (event, settings) => {
  const current = loadSettings();
  const merged = { ...current, ...settings };
  await saveSettingsFile(merged);

  if (settings.locale && mainLocales[settings.locale]) {
    mainLocale = settings.locale;
    try {
      const configPath = path.join(app.getPath('userData'), 'sxseditor-locale.json');
      await fs.promises.writeFile(configPath, JSON.stringify({ locale: settings.locale }), 'utf8');
    } catch (_) {}
  }

  if (svsPipeline) {
    console.log('[Main] 设置已更新，需要重新初始化 SVS Pipeline 才能生效');
    try { svsPipeline.dispose(); } catch (_) {}
    svsPipeline = null;
  }

  if (rmvpeDetector) {
    console.log('[Main] 设置已更新，需要重新初始化 RMVPE Pitch Detector 才能生效');
    try { rmvpeDetector.dispose(); } catch (_) {}
    rmvpeDetector = null;
  }

  if (basicPitchDetector) {
    console.log('[Main] 设置已更新，需要重新初始化 Basic Pitch Detector 才能生效');
    try { basicPitchDetector.dispose(); } catch (_) {}
    basicPitchDetector = null;
  }

  cachedDMLDevices = null;

  return { success: true };
});

ipcMain.handle('get-locale', async () => {
  return mainLocale;
});

ipcMain.handle('save-locale', async (event, locale) => {
  try {
    const configPath = path.join(app.getPath('userData'), 'sxseditor-locale.json');
    await fs.promises.writeFile(configPath, JSON.stringify({ locale }), 'utf8');
    if (mainLocales[locale]) {
      mainLocale = locale;
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('reload-main-window', async () => {
  buildAppMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('locale-changed');
    mainWindow.reload();
  }
});

let fragmentWindows = {};
let pendingFragmentData = {};

ipcMain.handle('openFragmentEditor', async (event, { fragment, project, wavBuffer }) => {
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
    icon: path.join(__dirname, 'SXS.png'),
    webPreferences: {
      preload: FRAGMENT_EDITOR_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  fragmentWindow.loadURL(`${FRAGMENT_EDITOR_WINDOW_WEBPACK_ENTRY}#fragmentId=${fragment.id}`);
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

let singerCreatorWindow = null;
let audioPreprocessWindow = null;
let pendingPreprocessData = null;
let preprocessWavBuffer = null;

ipcMain.handle('openSingerCreator', async () => {
  if (singerCreatorWindow) {
    singerCreatorWindow.focus();
    return;
  }

  singerCreatorWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: '歌手创建',
    icon: path.join(__dirname, 'SXS.png'),
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

  singerCreatorWindow.on('closed', () => {
    singerCreatorWindow = null;
  });
});

ipcMain.handle('openAudioPreprocess', async (event, data) => {
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
    icon: path.join(__dirname, 'SXS.png'),
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

  audioPreprocessWindow.webContents.once('did-finish-load', () => {
    audioPreprocessWindow.webContents.send('loadPreprocessData', { data: pendingPreprocessData, wavBuffer: preprocessWavBuffer });
    preprocessWavBuffer = null;
  });

  audioPreprocessWindow.on('closed', () => {
    audioPreprocessWindow = null;
    pendingPreprocessData = null;
    preprocessWavBuffer = null;
  });
});

ipcMain.handle('sendPreprocessData', async (event, data) => {
  if (singerCreatorWindow && !singerCreatorWindow.isDestroyed()) {
    singerCreatorWindow.webContents.send('preprocessDataSaved', data);
  }
  return { success: true };
});

const SXSSINGER_FORMAT_VERSION = '1.0.0';

function validateSingerFileData(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    errors.push('文件内容不是有效的JSON对象');
    return { valid: false, errors, warnings };
  }

  if (!data.singerName || typeof data.singerName !== 'string') {
    errors.push('缺少歌手名称(singerName)或格式不正确');
  } else if (data.singerName.trim().length === 0) {
    errors.push('歌手名称(singerName)不能为空');
  } else if (data.singerName.length > 100) {
    warnings.push('歌手名称(singerName)过长，可能显示异常');
  }

  if (data.color !== undefined && data.color !== null) {
    if (typeof data.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(data.color)) {
      warnings.push('颜色(color)格式不正确，应为#RRGGBB格式，将使用默认颜色');
    }
  }

  if (!data.wavBase64 || typeof data.wavBase64 !== 'string') {
    errors.push('缺少参考音频数据(wavBase64)或格式不正确');
  } else {
    try {
      const wavBuf = Buffer.from(data.wavBase64, 'base64');
      if (wavBuf.length < 44) {
        errors.push('参考音频数据(wavBase64)过小，不是有效的WAV文件');
      } else if (wavBuf.length > 50 * 1024 * 1024) {
        warnings.push('参考音频数据(wavBase64)超过50MB，可能导致性能问题');
      }
    } catch (e) {
      errors.push('参考音频数据(wavBase64)Base64解码失败');
    }
  }

  if (data.wavDuration !== undefined && data.wavDuration !== null) {
    if (typeof data.wavDuration !== 'number' || data.wavDuration <= 0) {
      warnings.push('音频时长(wavDuration)格式不正确，将尝试从音频数据推断');
    } else if (data.wavDuration > 60) {
      warnings.push('音频时长超过60秒，建议使用较短的参考音频');
    }
  }

  if (data.midiNotes !== undefined && data.midiNotes !== null) {
    if (!Array.isArray(data.midiNotes)) {
      warnings.push('MIDI音符数据(midiNotes)格式不正确，将被忽略');
    } else {
      for (let i = 0; i < data.midiNotes.length; i++) {
        const note = data.midiNotes[i];
        if (!note || typeof note !== 'object') {
          warnings.push(`第${i + 1}个MIDI音符数据格式不正确`);
          break;
        }
        if (typeof note.pitch !== 'number' || note.pitch < 0 || note.pitch > 127) {
          warnings.push(`第${i + 1}个MIDI音符的pitch值异常(${note.pitch})`);
          break;
        }
      }
    }
  }

  if (data.f0Data !== undefined && data.f0Data !== null) {
    if (!Array.isArray(data.f0Data)) {
      warnings.push('F0数据(f0Data)格式不正确，将被忽略');
    }
  }

  if (data.singerData !== undefined && data.singerData !== null) {
    if (typeof data.singerData !== 'object') {
      warnings.push('歌手推理数据(singerData)格式不正确，将被忽略');
    }
  }

  if (data.avatarBase64 !== undefined && data.avatarBase64 !== null) {
    if (typeof data.avatarBase64 !== 'string') {
      warnings.push('头像数据(avatarBase64)格式不正确，将被忽略');
    }
  }

  if (data.formatVersion !== undefined && typeof data.formatVersion !== 'string') {
    warnings.push('版本号(formatVersion)格式不正确');
  }

  return { valid: errors.length === 0, errors, warnings };
}

ipcMain.handle('saveSingerFile', async (event, singerData) => {
  try {
    const result = await dialog.showSaveDialog({
      title: t('dialog.saveSingerFile'),
      defaultPath: `${(singerData.singerName || '未命名歌手').replace(/[\\/:*?"<>|]/g, '_')}.sxssinger`,
      filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: '用户取消保存' };
    }

    const hasPreprocessResult = singerData.preprocessResult && singerData.preprocessResult.singerData;
    const midiNotesToSave = hasPreprocessResult ? singerData.preprocessResult.midiNotes : null;
    const f0DataToSave = hasPreprocessResult ? singerData.preprocessResult.f0Data : null;
    const singerDataToSave = hasPreprocessResult ? singerData.preprocessResult.singerData : null;

    const wavBase64 = Buffer.from(singerData.wavBuffer).toString('base64');

    let avatarBase64 = null;
    if (singerData.avatarImageData && singerData.avatarImageName) {
      const avatarDataUrl = singerData.avatarImageData;
      avatarBase64 = avatarDataUrl.split(',')[1];
    }

    const singerFileContent = JSON.stringify({
      formatVersion: SXSSINGER_FORMAT_VERSION,
      singerName: singerData.singerName,
      color: singerData.color,
      avatarBase64,
      wavBase64,
      wavFileName: singerData.wavFileName,
      wavDuration: singerData.duration,
      isPreprocessed: singerData.isPreprocessed,
      midiNotes: midiNotesToSave,
      f0Data: f0DataToSave,
      singerData: singerDataToSave,
    }, null, 2);

    await fs.promises.writeFile(result.filePath, singerFileContent);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('singerCreated', {
        filePath: result.filePath,
        singerName: singerData.singerName,
        color: singerData.color,
        avatarPath: avatarBase64,
        wavPath: null,
        midiPath: null,
        wavBuffer: singerData.wavBuffer,
        midiNotes: midiNotesToSave,
        f0Data: f0DataToSave,
        singerData: singerDataToSave,
      });
    }

    return { success: true };
  } catch (err) {
    console.error('保存歌手文件失败:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('getModelDir', async () => {
  return getModelDir();
});

let _svsPipelineInitPromise = null;

async function ensureSVSPipeline() {
  if (svsPipeline && svsPipeline.initialized) return svsPipeline;
  if (_svsPipelineInitPromise) return _svsPipelineInitPromise;

  const modelPath = getModelDir();
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? undefined;
  console.log(`[Main] 初始化SVS Pipeline (ONNX Runtime), 模型路径: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : '自动'}`);

  _svsPipelineInitPromise = (async () => {
    try {
      svsPipeline = new OnnxSVSPipeline(modelPath, { deviceId });
      await svsPipeline.init();
      return svsPipeline;
    } catch (err) {
      svsPipeline = null;
      throw err;
    } finally {
      _svsPipelineInitPromise = null;
    }
  })();

  return _svsPipelineInitPromise;
}

ipcMain.handle('svs:init', async () => {
  await ensureSVSPipeline();
  return { success: true };
});

ipcMain.handle('svs:synthesize', async (event, { notes, bpm, options }) => {
  if (!svsPipeline) {
    throw new Error(t('error.svsNotInitialized'));
  }
  return await svsPipeline.synthesize(notes, bpm, options);
});

ipcMain.handle('svs:dispose', async () => {
  if (svsPipeline) {
    try { svsPipeline.dispose(); } catch (_) {}
    svsPipeline = null;
  }
  return { success: true };
});

ipcMain.handle('fragment-svs:getSampleRate', async () => {
  return SAMPLE_RATE;
});

ipcMain.handle('fragment-svs:init', async () => {
  await ensureSVSPipeline();
  return { success: true };
});

ipcMain.handle('fragment-svs:synthesize', async (event, { notes, bpm, options }) => {
  if (!svsPipeline) {
    throw new Error(t('error.fragmentSvsNotInitialized'));
  }
  const win = event.sender;
  const opts = options || {};
  opts.onProgress = (progress) => {
    try {
      if (!win.isDestroyed()) {
        win.send('fragment-svs:progress', { progress });
      }
    } catch (_) {}
  };
  return await svsPipeline.synthesize(notes, bpm, opts);
});

ipcMain.handle('fragment-svs:dispose', async () => {
  // fragment 编辑器共享 svsPipeline 全局实例，不应在此释放
  // svsPipeline 的生命周期由 svs:dispose 和 before-quit 管理
  return { success: true };
});

ipcMain.handle('extractF0:onnx', async (event, { audioData, sampleRate, bpm }) => {
  try {
    if (!rmvpeDetector) {
      const modelPath = getModelDir();
      const settings = loadSettings();
      const deviceId = settings.deviceId ?? undefined;
      console.log(`[Main] 初始化 RMVPE Pitch Detector, 模型路径: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : '自动'}`);
      try {
        rmvpeDetector = new RmvpePitchDetector(modelPath, { deviceId });
        await rmvpeDetector.init();
      } catch (err) {
        rmvpeDetector = null;
        throw err;
      }
    }

    const f0Array = await rmvpeDetector.extractF0(new Float32Array(audioData), sampleRate || 44100);
    const notes = rmvpeDetector.f0ToNotes(f0Array, bpm || 120);

    return {
      success: true,
      f0Array: f0Array,
      notes: notes,
    };
  } catch (err) {
    console.error('[Main] F0提取失败:', err);
    return {
      success: false,
      error: err.message,
    };
  }
});

ipcMain.handle('file:exists', async (event, filePath) => {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
});

ipcMain.handle('file:authorizePath', async (event, dirPath) => {
  const resolvedPath = path.resolve(dirPath);
  // 禁止授权系统关键目录
  const forbiddenPrefixes = [
    path.resolve('C:\\Windows'),
    path.resolve('C:\\Program Files'),
    path.resolve('C:\\Program Files (x86)'),
    path.resolve('C:\\ProgramData'),
  ];
  if (forbiddenPrefixes.some(prefix => resolvedPath.startsWith(prefix + path.sep) || resolvedPath === prefix)) {
    return { success: false, error: 'Cannot authorize system directories' };
  }
  authorizePath(resolvedPath);
  return { success: true };
});

ipcMain.handle('resolvePath', async (event, basePath, relativePath) => {
  const resolved = path.resolve(basePath, relativePath);
  const normalizedBase = path.resolve(basePath);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error('路径遍历被阻止');
  }
  return resolved;
});

ipcMain.handle('getDirName', async (event, filePath) => {
  return path.dirname(filePath);
});

ipcMain.handle('extractF0:basicPitch', async (event, { audioData, sampleRate, bpm }) => {
  try {
    if (!basicPitchDetector) {
      const modelPath = getModelDir();
      console.log(`[Main] 初始化 Basic Pitch Detector, 模型路径: ${modelPath}`);
      try {
        basicPitchDetector = new BasicPitchDetector(modelPath);
        await basicPitchDetector.init();
      } catch (err) {
        basicPitchDetector = null;
        throw err;
      }
    }

    const result = await basicPitchDetector.extractF0AndNotes(new Float32Array(audioData), sampleRate || 44100, bpm || 120);

    return {
      success: true,
      f0Array: result.f0Array,
      notes: result.notes,
    };
  } catch (err) {
    console.error('[Main] Basic Pitch 提取失败:', err);
    return {
      success: false,
      error: err.message,
    };
  }
});

ipcMain.handle('midi:import', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: t('dialog.importMidi'),
      filters: [
        { name: 'MIDI Files', extensions: ['mid', 'midi'] },
      ],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const filePath = result.filePaths[0];
    const buffer = await fs.promises.readFile(filePath);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const notes = parseMidiFile(arrayBuffer);

    return { success: true, notes };
  } catch (err) {
    console.error('[Main] MIDI导入失败:', err);
    return { success: false, error: err.message };
  }
});

let _audioManager = null;
let _fragmentAudioManager = null;

function getAudioManager() {
  if (!_audioManager) {
    _audioManager = new AudioOutputManager();
  }
  return _audioManager;
}

function getFragmentAudioManager() {
  if (!_fragmentAudioManager) {
    _fragmentAudioManager = new AudioOutputManager();
  }
  return _fragmentAudioManager;
}

function _getAudioManagerForSender(event) {
  // 片段编辑器窗口使用独立的 manager
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (senderWin) {
    for (const id in fragmentWindows) {
      if (fragmentWindows[id] === senderWin) {
        return getFragmentAudioManager();
      }
    }
  }
  return getAudioManager();
}

ipcMain.handle('audio:getDevices', async () => {
  try {
    const [devices, isAvailable] = await Promise.all([
      AudioOutputManager.getDevices(),
      AudioOutputManager.isAvailable(),
    ]);
    return { success: true, devices, isAvailable };
  } catch (err) {
    console.error('[Main] 获取音频设备失败:', err);
    return { success: false, devices: [], isAvailable: false, error: err.message };
  }
});

ipcMain.handle('audio:play', async (event, { audioData, options }) => {
  try {
    const manager = _getAudioManagerForSender(event);
    // 先清除旧的 onEnded 回调，防止残留回调在错误时机触发
    manager.onEnded(null);
    const result = await manager.start(audioData, options);

    manager.onEnded(() => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send('audio:ended', {});
        }
      } catch (_) {}
    });

    return { ...result };
  } catch (err) {
    console.error('[Main] 音频播放失败:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('audio:stop', async (event) => {
  try {
    const manager = _getAudioManagerForSender(event);
    await manager.stop();
    return { success: true };
  } catch (err) {
    console.error('[Main] 音频停止失败:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('audio:getPosition', async (event) => {
  try {
    const manager = _getAudioManagerForSender(event);
    if (manager.isPlaying()) {
      return { success: true, position: manager.getPosition(), duration: manager.getDuration() };
    }
    return { success: true, position: 0, duration: 0 };
  } catch (err) {
    return { success: false, position: 0, duration: 0, error: err.message };
  }
});

ipcMain.handle('audio:isAvailable', async () => {
  const available = await AudioOutputManager.isAvailable();
  return { available };
});

// ===== 资源管理器 IPC =====

// #9: 缓存文件检查结果
let modelFilesCache = null;
let modelFilesCacheDir = null;

function invalidateModelFilesCache() {
  modelFilesCache = null;
  modelFilesCacheDir = null;
}

async function getModelFilesInfo() {
  const modelDir = getModelDir();
  if (modelFilesCache && modelFilesCacheDir === modelDir) {
    return modelFilesCache;
  }

  const groups = getModelGroups();
  const cache = {};

  for (const group of groups) {
    for (const model of group.models) {
      let totalFileSize = 0;
      let filesExist = true;
      for (const file of model.files) {
        const fullPath = path.join(modelDir, file);
        try {
          const stats = await fs.promises.stat(fullPath);
          totalFileSize += stats.size;
        } catch (_) {
          filesExist = false;
        }
      }
      cache[`${group.id}/${model.id}`] = { fileSize: totalFileSize, filesExist };
    }
  }

  modelFilesCache = cache;
  modelFilesCacheDir = modelDir;
  return cache;
}

// #6: 抽取公共的模型加载/卸载辅助函数
async function loadSingleModel(groupId, modelId) {
  if (groupId === 'svs') {
    if (!svsPipeline || !svsPipeline.initialized) {
      await ensureSVSPipeline();
    }
    const modelDef = getModelGroups().find(g => g.id === 'svs')?.models.find(m => m.id === modelId);
    if (!modelDef) return { success: false, error: 'Model not found in registry' };
    return svsPipeline.loadModel(modelDef.sessionKey);
  } else if (groupId === 'rmvpe') {
    if (!rmvpeDetector) {
      const modelPath = getModelDir();
      const settings = loadSettings();
      const deviceId = settings.deviceId ?? undefined;
      try {
        rmvpeDetector = new RmvpePitchDetector(modelPath, { deviceId });
        await rmvpeDetector.init();
      } catch (err) {
        rmvpeDetector = null;
        throw err;
      }
    }
    return { success: true };
  } else if (groupId === 'basicPitch') {
    if (!basicPitchDetector) {
      const modelPath = getModelDir();
      try {
        basicPitchDetector = new BasicPitchDetector(modelPath);
        await basicPitchDetector.init();
      } catch (err) {
        basicPitchDetector = null;
        throw err;
      }
    }
    return { success: true };
  }
  return { success: false, error: `Unknown group: ${groupId}` };
}

async function unloadSingleModel(groupId, modelId) {
  if (groupId === 'svs') {
    if (!svsPipeline || !svsPipeline.initialized) {
      return { success: false, error: 'SVS Pipeline not initialized' };
    }
    const modelDef = getModelGroups().find(g => g.id === 'svs')?.models.find(m => m.id === modelId);
    if (!modelDef) return { success: false, error: 'Model not found in registry' };
    return svsPipeline.unloadModel(modelDef.sessionKey);
  } else if (groupId === 'rmvpe') {
    if (rmvpeDetector) {
      try { rmvpeDetector.dispose(); } catch (_) {}
      rmvpeDetector = null;
    }
    return { success: true };
  } else if (groupId === 'basicPitch') {
    if (basicPitchDetector) {
      try { basicPitchDetector.dispose(); } catch (_) {}
      basicPitchDetector = null;
    }
    return { success: true };
  }
  return { success: false, error: `Unknown group: ${groupId}` };
}

function cleanupOnLoadFailure(groupId) {
  if (groupId === 'rmvpe') { try { if (rmvpeDetector) { rmvpeDetector.dispose(); } } catch (_) {} rmvpeDetector = null; }
  if (groupId === 'basicPitch') { try { if (basicPitchDetector) { basicPitchDetector.dispose(); } } catch (_) {} basicPitchDetector = null; }
}

ipcMain.handle('resmgr:open', async () => {
  openResourceManagerWindow();
  return { success: true };
});

ipcMain.handle('resmgr:getGPUInfo', async () => {
  try {
    const vramData = await queryGPUVRAMUsage();
    const devices = cachedDMLDevices || await enumerateDMLDevices(getModelDir());
    if (!cachedDMLDevices) cachedDMLDevices = devices;

    const gpuList = devices.map(d => {
      const vramInfo = vramData.find(v => v.adapterIndex === d.dxgiAdapterNumber);
      const usageBytes = vramInfo ? vramInfo.usageBytes : 0;
      const budgetBytes = vramInfo ? vramInfo.budgetBytes : 0;
      return {
        name: d.name,
        isDiscrete: d.isDiscrete,
        vram: d.vram,
        vramBytes: d.vramBytes,
        vendor: d.vendor,
        dxgiAdapterNumber: d.dxgiAdapterNumber,
        currentUsageBytes: usageBytes,
        budgetBytes: budgetBytes > 0 ? budgetBytes : d.vramBytes,
      };
    });

    return { success: true, gpus: gpuList };
  } catch (err) {
    console.error('[Main] 获取GPU信息失败:', err);
    return { success: false, gpus: [], error: err.message };
  }
});

ipcMain.handle('resmgr:getModelGroups', async () => {
  const groups = getModelGroups();
  const filesInfo = await getModelFilesInfo();

  const result = [];
  for (const group of groups) {
    const groupResult = {
      id: group.id,
      name: group.name,
      nameEn: group.nameEn,
      description: group.description,
      descriptionEn: group.descriptionEn,
      required: group.required,
      pipelineRef: group.pipelineRef,
      models: [],
    };

    for (const model of group.models) {
      const cacheKey = `${group.id}/${model.id}`;
      const { fileSize, filesExist } = filesInfo[cacheKey] || { fileSize: 0, filesExist: false };

      let loaded = false;
      let ep = null;

      if (group.id === 'svs' && svsPipeline && svsPipeline.initialized) {
        loaded = svsPipeline.isModelLoaded(model.sessionKey);
        ep = svsPipeline.sessionEPs[model.sessionKey] || null;
      } else if (group.id === 'rmvpe') {
        loaded = !!(rmvpeDetector && rmvpeDetector.initialized);
        ep = rmvpeDetector ? 'cpu' : null;
      } else if (group.id === 'basicPitch') {
        loaded = !!(basicPitchDetector && basicPitchDetector.initialized);
        ep = 'tfjs';
      }

      groupResult.models.push({
        id: model.id,
        name: model.name,
        nameEn: model.nameEn,
        description: model.description,
        descriptionEn: model.descriptionEn,
        sessionKey: model.sessionKey,
        files: model.files,
        fileSize,
        filesExist,
        loaded,
        ep,
      });
    }

    result.push(groupResult);
  }

  return { success: true, groups: result };
});

ipcMain.handle('resmgr:loadModel', async (event, { groupId, modelId }) => {
  try {
    return await loadSingleModel(groupId, modelId);
  } catch (err) {
    console.error(`[Main] 加载模型失败 (${groupId}/${modelId}):`, err.message);
    cleanupOnLoadFailure(groupId);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('resmgr:unloadModel', async (event, { groupId, modelId }) => {
  try {
    return await unloadSingleModel(groupId, modelId);
  } catch (err) {
    console.error(`[Main] 卸载模型失败 (${groupId}/${modelId}):`, err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('resmgr:loadGroup', async (event, { groupId }) => {
  try {
    if (groupId === 'svs') {
      // #4: 加载全部SVS模型，而非仅初始化pipeline
      if (!svsPipeline || !svsPipeline.initialized) {
        await ensureSVSPipeline();
      }
      await svsPipeline.ensureAllModelsLoaded();
      return { success: true };
    }
    // 单模型组直接加载
    const group = getModelGroups().find(g => g.id === groupId);
    if (!group) return { success: false, error: `Unknown group: ${groupId}` };
    for (const model of group.models) {
      await loadSingleModel(groupId, model.id);
    }
    return { success: true };
  } catch (err) {
    console.error(`[Main] 加载模型组失败 (${groupId}):`, err.message);
    cleanupOnLoadFailure(groupId);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('resmgr:unloadGroup', async (event, { groupId }) => {
  try {
    if (groupId === 'svs') {
      // #5: 逐个卸载SVS模型，而非dispose整个pipeline
      if (svsPipeline && svsPipeline.initialized) {
        const group = getModelGroups().find(g => g.id === 'svs');
        if (group) {
          for (const model of group.models) {
            try { svsPipeline.unloadModel(model.sessionKey); } catch (_) {}
          }
        }
      }
      return { success: true };
    }
    // 单模型组直接卸载
    const group = getModelGroups().find(g => g.id === groupId);
    if (!group) return { success: false, error: `Unknown group: ${groupId}` };
    for (const model of group.models) {
      await unloadSingleModel(groupId, model.id);
    }
    return { success: true };
  } catch (err) {
    console.error(`[Main] 卸载模型组失败 (${groupId}):`, err.message);
    return { success: false, error: err.message };
  }
});
