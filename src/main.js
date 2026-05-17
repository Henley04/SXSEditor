const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

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
const { checkMissingFiles, downloadMissingFiles } = require('./modelManager');

let svsPipeline = null;
let rmvpeDetector = null;
let basicPitchDetector = null;
let mainWindow = null;
let settingsWindow = null;
let cachedDMLDevices = null;

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

  const menuTemplate = [
    {
      label: 'SXSEditor',
      submenu: [
        {
          label: '关于 SXSEditor',
          click: () => { showAboutDialog(); },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '设置',
      submenu: [
        {
          label: 'Settings',
          click: () => { openSettingsWindow(); },
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
};

async function showAboutDialog() {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于 SXSEditor',
    message: 'SXSEditor',
    detail: [
      `版本: ${app.getVersion()}`,
      '',
      'SoulX Singer 编辑器',
      '基于 ONNX Runtime / DirectML 的 AI 歌声合成工作台',
      '',
      '© 2024-2026 SXSEditor Dev',
    ].join('\n'),
    buttons: ['确定'],
    noLink: true,
  });
}

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 580,
    height: 700,
    title: '设置',
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

let modelDownloadWindow = null;
let downloadAbortController = null;

function createModelDownloadWindow(missingFiles) {
  if (modelDownloadWindow) {
    modelDownloadWindow.focus();
    return;
  }

  modelDownloadWindow = new BrowserWindow({
    width: 520,
    height: 500,
    title: '模型文件下载',
    icon: path.join(__dirname, 'SXS.png'),
    resizable: false,
    minimizable: true,
    maximizable: false,
    closable: true,
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
  });

  modelDownloadWindow.on('closed', () => {
    if (downloadAbortController) {
      downloadAbortController.abort();
      downloadAbortController = null;
    }
    modelDownloadWindow = null;
  });
}

async function startModelDownload(modelDir, missingFiles) {
  downloadAbortController = new AbortController();
  const abortSignal = downloadAbortController.signal;

  try {
    await downloadMissingFiles(modelDir, missingFiles, {
      abortSignal,
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
  const modelDir = getModelDir();
  console.log('[Main] 检查模型文件，目录:', modelDir);
  const { missing, existing } = checkMissingFiles(modelDir);

  if (missing.length === 0) {
    console.log('[Main] 所有模型文件已就绪');
    return true;
  }

  console.log(`[Main] 缺少 ${missing.length} 个模型文件:`, missing.map(f => f.filePath));
  createModelDownloadWindow(missing);
  return false;
}

ipcMain.handle('model-download:start', async () => {
  const modelDir = getModelDir();
  const { missing } = checkMissingFiles(modelDir);
  if (missing.length === 0) return { success: true };
  await startModelDownload(modelDir, missing);
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

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  createWindow();
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
    return { success: false, error: '不允许访问该路径' };
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
    throw new Error('不允许访问该路径');
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
    throw new Error('不允许访问该路径');
  }
  try {
    const buffer = await fs.promises.readFile(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  } catch (err) {
    console.error('[Main] 文件读取(Buffer)失败:', err.message);
    throw err;
  }
});

function getModelDir() {
  if (!app.isPackaged) {
    let appPath = app.getAppPath();
    if (appPath.endsWith('.asar')) {
      appPath = appPath + '.unpacked';
    }
    return path.join(appPath, 'onnx_models') + path.sep;
  }
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

ipcMain.handle('settings:saveSettings', async (event, settings) => {
  const current = loadSettings();
  const merged = { ...current, ...settings };
  await saveSettingsFile(merged);

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

ipcMain.handle('saveFragmentData', async (event, fragmentId, data) => {
  if (fragmentWindows[fragmentId]) {
    fragmentWindows[fragmentId].webContents.send('fragmentDataSaved', { fragmentId, ...data });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fragmentDataSaved', { fragmentId, ...data });
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
      title: '保存歌手文件',
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
    throw new Error('SVS Pipeline 未初始化');
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
    throw new Error('Fragment SVS Pipeline 未初始化');
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

ipcMain.handle('file:authorizePath', async (event, filePath) => {
  authorizePath(filePath);
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
      title: '导入MIDI文件',
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

function getAudioManager() {
  if (!_audioManager) {
    _audioManager = new AudioOutputManager();
  }
  return _audioManager;
}

ipcMain.handle('audio:getDevices', async () => {
  try {
    const devices = await AudioOutputManager.getDevices();
    return { success: true, devices, isAvailable: AudioOutputManager.isAvailable() };
  } catch (err) {
    console.error('[Main] 获取音频设备失败:', err);
    return { success: false, devices: [], isAvailable: false, error: err.message };
  }
});

ipcMain.handle('audio:play', async (event, { audioData, options }) => {
  try {
    const manager = getAudioManager();
    const float32Data = new Float32Array(audioData);
    const result = await manager.start(float32Data, options);

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

ipcMain.handle('audio:stop', async () => {
  try {
    const manager = getAudioManager();
    manager.stop();
    return { success: true };
  } catch (err) {
    console.error('[Main] 音频停止失败:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('audio:getPosition', async () => {
  try {
    const manager = getAudioManager();
    if (manager.isPlaying()) {
      return { success: true, position: manager.getPosition(), duration: manager.getDuration() };
    }
    return { success: true, position: 0, duration: 0 };
  } catch (err) {
    return { success: false, position: 0, duration: 0, error: err.message };
  }
});

ipcMain.handle('audio:isAvailable', async () => {
  return { available: AudioOutputManager.isAvailable() };
});
