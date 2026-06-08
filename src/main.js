const { app, BrowserWindow, ipcMain, dialog, Menu, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 启用 WebNN API，使渲染进程可通过 onnxruntime-web WebNN EP 使用 NPU 推理
app.commandLine.appendSwitch('enable-features', 'WebMachineLearningNeuralNetwork');

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
  } catch (err) { console.warn('[Main] 加载 locale 配置失败:', err.message); }
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
const { RosvotDetector } = require('./inference/rosvotDetector');
const { parseMidiFile } = require('./inference/midiParser');
const { AudioOutputManager } = require('./audio/audioOutputManager');
const { checkMissingFiles, checkMissingFilesAsync, deleteModelFiles, downloadMissingFiles, DEFAULT_PRECISION } = require('./modelManager');
const { getModelGroups } = require('./modelRegistry');
const themeStorage = require('./themes/themeStorage');
const BUILTIN_THEMES = require('./themes/builtins/index.js');

let svsPipeline = null;
let rmvpeDetector = null;
let basicPitchDetector = null;
let rosvotDetector = null;
let _rmvpeInitPromise = null;
let _basicPitchInitPromise = null;
let _rosvotInitPromise = null;
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
    if (dialogAuthorizedPaths.size > 1000) {
      const entries = [...dialogAuthorizedPaths];
      dialogAuthorizedPaths.clear();
      for (let i = Math.floor(entries.length / 2); i < entries.length; i++) {
        dialogAuthorizedPaths.add(entries[i]);
      }
    }
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

let _settingsCache = null;

const DEFAULT_THEME = 'dark-aurora';
const DEFAULT_THEME_PER_WINDOW = {};

function loadSettings() {
  if (_settingsCache) return _settingsCache;
  try {
    const filePath = getSettingsFilePath();
    if (fs.existsSync(filePath)) {
      _settingsCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else {
      _settingsCache = {};
    }
  } catch (err) {
    console.warn('[Main] 加载设置失败，将使用默认设置:', err.message);
    _settingsCache = {};
  }
  // Merge defaults for theme fields
  if (typeof _settingsCache.theme !== 'string') {
    _settingsCache.theme = DEFAULT_THEME;
  }
  if (typeof _settingsCache.themePerWindow !== 'object' || _settingsCache.themePerWindow === null || Array.isArray(_settingsCache.themePerWindow)) {
    _settingsCache.themePerWindow = { ...DEFAULT_THEME_PER_WINDOW };
  }

  // Migration: old deviceId (number) → deviceMode + preferredDeviceId + preferredDeviceType
  if (_settingsCache.deviceMode === undefined) {
    if (typeof _settingsCache.deviceId === 'number') {
      _settingsCache.deviceMode = 'manual';
      _settingsCache.preferredDeviceId = _settingsCache.deviceId;
      // Try to look up deviceType from cachedDMLDevices
      if (cachedDMLDevices) {
        const matched = cachedDMLDevices.find(d => d.dxgiAdapterNumber === _settingsCache.deviceId);
        if (matched && matched.deviceType) {
          _settingsCache.preferredDeviceType = matched.deviceType;
        }
      }
    } else {
      // deviceId is null/undefined and no deviceMode set
      _settingsCache.deviceMode = 'smart';
    }
  }

  return _settingsCache;
}

async function saveSettingsFile(settings) {
  try {
    const filePath = getSettingsFilePath();
    await fs.promises.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf-8');
    _settingsCache = null;
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
  mainWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 设备丢失检测：主窗口加载完成后校验用户指定的设备
  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      const settings = loadSettings();
      const deviceMode = settings.deviceMode || (settings.deviceId !== undefined && settings.deviceId !== null ? 'manual' : 'smart');

      if (deviceMode === 'manual' || deviceMode === 'advanced') {
        const gpuInfo = await ensureGPUInfo();
        const dmlDevices = cachedDMLDevices || [];
        const allDevices = [...dmlDevices];
        for (const c of gpuInfo) {
          if (!allDevices.find(d => d.name === c.model)) {
            const vramBytes = (c.memoryTotal || c.vram || 0) * 1024 * 1024;
            const deviceType = classifyDeviceFromName(c.model, vramBytes);
            allDevices.push({ name: c.model, deviceType, isDiscrete: deviceType === 'discrete-gpu', vramBytes, source: 'systeminformation' });
          }
        }

        const npuAvailable = allDevices.some(d => d.deviceType === 'npu');

        if (deviceMode === 'manual') {
          const preferredId = settings.preferredDeviceId ?? settings.deviceId;
          const preferredType = settings.preferredDeviceType;
          const found = preferredId !== undefined && preferredId !== null
            ? allDevices.find(d => d.dxgiAdapterNumber === preferredId)
            : null;

          if (!found || (preferredType === 'npu' && !npuAvailable)) {
            const deviceName = found ? found.name : `deviceId=${preferredId}`;
            dialog.showMessageBoxSync(mainWindow, {
              type: 'warning',
              title: 'Device Not Found',
              message: `Previously selected device "${deviceName}" was not found. Switched to smart mode.`,
              buttons: ['OK'],
            });
            // 切换到智能模式
            const newSettings = { ...settings, deviceMode: 'smart' };
            delete newSettings.preferredDeviceId;
            delete newSettings.preferredDeviceType;
            await saveSettingsFile(newSettings);
          }
        } else if (deviceMode === 'advanced' && settings.modelDeviceMapping) {
          const newMapping = { ...settings.modelDeviceMapping };
          let changed = false;
          for (const [groupId, mapping] of Object.entries(newMapping)) {
            if (typeof mapping === 'object' && mapping.deviceType === 'npu' && !npuAvailable) {
              newMapping[groupId] = 'auto';
              changed = true;
            }
          }
          if (changed) {
            dialog.showMessageBoxSync(mainWindow, {
              type: 'warning',
              title: 'NPU Not Available',
              message: 'NPU device not found. Model groups assigned to NPU have been switched to auto.',
              buttons: ['OK'],
            });
            await saveSettingsFile({ ...settings, modelDeviceMapping: newMapping });
          }
        }
      }
    } catch (err) {
      console.warn('[Main] Device validation failed:', err.message);
    }
  });

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
  resourceManagerWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  resourceManagerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  resourceManagerWindow.on('closed', () => {
    resourceManagerWindow = null;
  });
}

const { Worker } = require('node:worker_threads');

// GPU 信息后台缓存
let _gpuInfoCache = null;
let _gpuInfoPending = null;

/**
 * 统一设备分类函数 — 与 nativeSvsPipeline.js 中的 classifyDevice 保持同步
 * @param {string} name - 设备名称
 * @param {number} vramBytes - 显存大小（字节），0 表示未知
 * @param {boolean|undefined} dmlDiscreteFlag - DirectML 报告的 Discrete 标志
 * @returns {'discrete-gpu'|'integrated-gpu'|'npu'|'cpu'}
 */
function classifyDeviceFromName(name, vramBytes = 0, dmlDiscreteFlag = undefined) {
  const n = (name || '').toLowerCase();

  // 1. NPU 名称匹配（最高优先级）
  const npuKeywords = [
    'npu', 'neural processing', 'neural compute',
    'intel ai boost', 'intel neural', 'intel npu',
    'amd xdna', 'amd ryzen ai', 'amd ai engine',
    'qualcomm hexagon', 'qcom npu', 'hexagon npu',
    'snapdragon neural', 'mediatek apu', 'rockchip npu',
  ];
  for (const kw of npuKeywords) {
    if (n.includes(kw)) return 'npu';
  }

  // 2. GPU 独显名称匹配
  const discreteGpuKeywords = [
    { includes: ['nvidia'] }, { includes: ['geforce'] },
    { includes: ['rtx'] }, { includes: ['gtx'] }, { includes: ['quadro'] },
    { includes: ['radeon', 'rx'] }, { includes: ['radeon', 'pro'] },
    { includes: ['radeon', 'instinct'] },
    { includes: ['amd', 'rx '] }, { includes: ['amd', 'pro w'] }, { includes: ['amd', 'pro v'] },
  ];
  for (const rule of discreteGpuKeywords) {
    if (rule.includes.every(kw => n.includes(kw))) return 'discrete-gpu';
  }
  if (n.includes('intel') && n.includes('arc') && /\barc\s*a\d/i.test(n)) return 'discrete-gpu';

  // 3. GPU 核显名称匹配
  const integratedGpuKeywords = [
    { includes: ['intel', 'uhd'] }, { includes: ['intel', 'iris'] },
    { includes: ['intel', 'xe'] }, { includes: ['intel', 'hd graphics'] },
  ];
  for (const rule of integratedGpuKeywords) {
    if (rule.includes.every(kw => n.includes(kw))) return 'integrated-gpu';
  }
  if (n.includes('radeon') && !n.includes('rx') && !n.includes('pro') && !n.includes('instinct')) return 'integrated-gpu';
  if (n.includes('microsoft') && n.includes('basic')) return 'integrated-gpu';

  // 4. DML Discrete 标志
  if (dmlDiscreteFlag === true) return 'discrete-gpu';
  if (dmlDiscreteFlag === false) return 'integrated-gpu';

  // 5. 显存阈值兜底（>= 512MB 视为独显）
  if (vramBytes > 0 && vramBytes >= 512 * 1024 * 1024) return 'discrete-gpu';
  if (vramBytes > 0) return 'integrated-gpu';

  return 'cpu';
}

function startGPUPreload() {
  _gpuInfoPending = new Promise((resolve) => {
    try {
      const worker = new Worker(path.join(__dirname, 'utils/gpuWorker.js'));
      worker.once('message', (msg) => {
        if (msg.success) {
          _gpuInfoCache = msg.data;
          console.log(`[Main] GPU 信息预加载完成: ${msg.data.length} 个设备`);
        } else {
          console.warn('[Main] GPU 信息预加载失败:', msg.error);
        }
        resolve();
      });
      worker.once('error', (err) => {
        console.warn('[Main] GPU worker 错误:', err.message);
        resolve();
      });
    } catch (e) {
      console.warn('[Main] GPU worker 启动失败:', e.message);
      resolve();
    }
  });
}

async function ensureGPUInfo() {
  if (_gpuInfoCache) return _gpuInfoCache;
  if (_gpuInfoPending) {
    await _gpuInfoPending;
    return _gpuInfoCache;
  }
  // 兜底：同步加载
  try {
    const si = require('systeminformation');
    const graphics = await si.graphics();
    const controllers = graphics.controllers || [];
    _gpuInfoCache = controllers.map((c, idx) => {
      const vramBytes = (c.memoryTotal || c.vram || 0) * 1024 * 1024;
      const deviceType = classifyDeviceFromName(c.model, vramBytes);
      return {
        adapterIndex: idx,
        model: c.model || '',
        vram: c.vram || 0,
        memoryTotal: c.memoryTotal || c.vram || 0,
        memoryUsed: c.memoryUsed || 0,
        vendor: c.vendor || '',
        deviceType,
        isDiscrete: deviceType === 'discrete-gpu',
      };
    });
  } catch (e) {
    _gpuInfoCache = [];
  }
  return _gpuInfoCache;
}

let _vramUsageCache = null;
let _vramUsageCacheTime = 0;
let _vramUsagePromise = null;
const VRAM_USAGE_TTL = 3000;

async function queryGPUVRAMUsage() {
  const now = Date.now();
  if (_vramUsageCache && now - _vramUsageCacheTime < VRAM_USAGE_TTL) {
    return _vramUsageCache;
  }
  if (_vramUsagePromise) return _vramUsagePromise;

  _vramUsagePromise = (async () => {
    try {
      const si = require('systeminformation');
      const graphics = await si.graphics();
      const controllers = graphics.controllers || [];
      const result = controllers.map((c, idx) => ({
        adapterIndex: idx,
        name: c.model || '',
        totalBytes: (c.memoryTotal || c.vram || 0) * 1024 * 1024,
        usageBytes: (c.memoryUsed || 0) * 1024 * 1024,
        budgetBytes: (c.memoryTotal || c.vram || 0) * 1024 * 1024,
      }));
      _vramUsageCache = result;
      _vramUsageCacheTime = Date.now();
      return result;
    } catch (e) {
      console.warn('[Main] GPU 信息获取失败:', e.message);
      return [];
    } finally {
      _vramUsagePromise = null;
    }
  })();

  return _vramUsagePromise;
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
    height: 700,
    minWidth: 420,
    minHeight: 500,
    title: '模型文件下载',
    icon: path.join(__dirname, 'SXS.png'),
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
    if (settings.modelDir && typeof settings.modelDir === 'string' && isPathAllowed(settings.modelDir)) {
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
  const { missing, existing } = await checkMissingFilesAsync(modelDir);

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

    const recheck = await checkMissingFilesAsync(downloadDir);
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

ipcMain.handle('model-download:delete-and-recheck', async (event, precision) => {
  const modelDir = getModelDir();
  deleteModelFiles(modelDir);
  const { missing } = checkMissingFiles(modelDir);
  // 更新下载窗口的缺失文件列表
  if (modelDownloadWindow && !modelDownloadWindow.isDestroyed()) {
    modelDownloadWindow.webContents.send('model-download:missing-files', missing);
    modelDownloadWindow.webContents.send('model-download:precision', precision || DEFAULT_PRECISION);
  }
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

// 注册自定义 protocol scheme，必须在 app.whenReady() 之前调用
const { protocol } = require('electron');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'onnx',
    privileges: {
      bypassCSP: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);

app.whenReady().then(() => {
  // 注册 onnx:// protocol handler，允许渲染进程安全访问模型文件
  protocol.handle('onnx', (request) => {
    const url = new URL(request.url);
    // URL 格式: onnx://model-path/xxx.onnx
    const modelPath = decodeURIComponent(url.pathname);
    // 安全性验证：只允许访问 onnx_models 目录下的 .onnx 文件
    const modelDir = getModelDir();
    const resolvedPath = path.resolve(modelDir, modelPath.replace(/^\/+/, ''));
    if (!resolvedPath.startsWith(path.resolve(modelDir))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!resolvedPath.endsWith('.onnx')) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(resolvedPath)) {
      return new Response('Not Found', { status: 404 });
    }
    return net.fetch(`file:///${resolvedPath.replace(/\\/g, '/')}`);
  });

  loadMainLocale();
  createWindow();
  // 后台线程预加载GPU信息，不阻塞主线程
  startGPUPreload();
  // 等待GPU信息加载完成后再枚举DML设备
  ensureGPUInfo().then(controllers => {
    return enumerateDMLDevices(getModelDir(), controllers);
  }).then(devices => {
    cachedDMLDevices = devices;
    console.log(`[Main] GPU设备预加载完成: ${devices.length} 个设备`);
  }).catch(err => {
    console.warn('[Main] GPU设备预加载失败:', err.message);
  });
  // 模型检查延后执行，不阻塞窗口显示
  checkAndDownloadModels().catch(err => {
    console.warn('[Main] 模型检查失败:', err.message);
  });

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
  if (rosvotDetector) { try { rosvotDetector.dispose(); } catch (_) {} rosvotDetector = null; }
  if (_audioManager) { try { _audioManager.destroy(); } catch (_) {} _audioManager = null; }
  if (_fragmentAudioManager) { try { _fragmentAudioManager.destroy(); } catch (_) {} _fragmentAudioManager = null; }
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
      const controllers = await ensureGPUInfo();
      cachedDMLDevices = await enumerateDMLDevices(modelDir, controllers);
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

ipcMain.handle('settings:validateDevices', async () => {
  const settings = loadSettings();
  const deviceMode = settings.deviceMode || 'smart';
  const issues = [];

  // 获取当前可用设备
  const gpuInfo = await ensureGPUInfo();
  const dmlDevices = cachedDMLDevices || [];
  const allDevices = [...dmlDevices];

  // 添加 systeminformation 检测到的设备
  for (const c of gpuInfo) {
    if (!allDevices.find(d => d.name === c.model)) {
      const vramBytes = (c.memoryTotal || c.vram || 0) * 1024 * 1024;
      const deviceType = classifyDeviceFromName(c.model, vramBytes);
      allDevices.push({
        name: c.model,
        deviceType,
        isDiscrete: deviceType === 'discrete-gpu',
        vramBytes,
        source: 'systeminformation',
      });
    }
  }

  // 检查 NPU 可用性
  let npuAvailable = false;
  try {
    const npuResult = await ipcMain.handleOnce('__internal:webnnDetectNPU') || {};
    // 通过 WebNN IPC 检测（异步，可能超时）
  } catch (_) {}
  // 简单检查：DML 枚举中是否有 NPU
  npuAvailable = allDevices.some(d => d.deviceType === 'npu');

  if (deviceMode === 'manual') {
    const preferredId = settings.preferredDeviceId;
    const preferredType = settings.preferredDeviceType;
    if (preferredId !== undefined && preferredId !== null) {
      const found = allDevices.find(d => d.dxgiAdapterNumber === preferredId);
      if (!found) {
        issues.push({
          type: 'device-not-found',
          mode: 'manual',
          message: `Previously selected device (deviceId=${preferredId}) not found`,
          fix: { deviceMode: 'smart' },
        });
      }
    }
    if (preferredType === 'npu' && !npuAvailable) {
      issues.push({
        type: 'npu-not-available',
        mode: 'manual',
        message: 'NPU device not available',
        fix: { deviceMode: 'smart' },
      });
    }
  } else if (deviceMode === 'advanced' && settings.modelDeviceMapping) {
    for (const [groupId, mapping] of Object.entries(settings.modelDeviceMapping)) {
      if (mapping === 'auto' || mapping === 'npu-webnn') continue;
      if (typeof mapping === 'object' && mapping.deviceType === 'npu' && !npuAvailable) {
        issues.push({
          type: 'model-group-npu-not-available',
          mode: 'advanced',
          groupId,
          message: `Model group ${groupId} assigned to NPU but NPU not available`,
          fix: { groupId, newMapping: 'auto' },
        });
      }
    }
  }

  return { issues, deviceMode, npuAvailable, devices: allDevices };
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

const ALLOWED_SETTINGS_KEYS = [
  'deviceId', 'modelDir', 'modelPrecision', 'midiExtractTool', 'useRosvot',
  'previewDiffSteps', 'previewCfgStrength', 'previewCfgRescale',
  'exportDiffSteps', 'exportCfgStrength', 'exportCfgRescale',
  'audioOutputMode', 'audioOutputDevice', 'audioSampleRate', 'audioBitDepth',
  'audioBufferSize', 'audioVolume', 'locale',
  'theme', 'themePerWindow',
  'deviceMode', 'preferredDeviceId', 'preferredDeviceType', 'modelDeviceMapping',
];

ipcMain.handle('settings:saveSettings', async (event, settings) => {
  const current = loadSettings();
  const filtered = {};
  for (const key of ALLOWED_SETTINGS_KEYS) {
    if (settings[key] !== undefined) filtered[key] = settings[key];
  }
  const merged = { ...current, ...filtered };
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

  if (rosvotDetector) {
    console.log('[Main] 设置已更新，需要重新初始化 RosvotDetector 才能生效');
    try { rosvotDetector.dispose(); } catch (_) {}
    rosvotDetector = null;
  }

  cachedDMLDevices = null;

  return { success: true };
});

ipcMain.handle('get-locale', async () => {
  return mainLocale;
});

ipcMain.handle('save-locale', async (event, locale) => {
  try {
    if (typeof locale !== 'string' || !mainLocales[locale]) {
      return { success: false, error: 'Invalid locale' };
    }
    const configPath = path.join(app.getPath('userData'), 'sxseditor-locale.json');
    await fs.promises.writeFile(configPath, JSON.stringify({ locale }), 'utf8');
    mainLocale = locale;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ==================== Theme IPC ====================

function listAllThemes() {
  const settings = loadSettings();
  const userDir = app.getPath('userData');
  const { themes: userThemes } = themeStorage.loadUserThemes(userDir);
  return [
    ...BUILTIN_THEMES.BUILTIN_THEMES.map(t => ({
      id: t.id,
      name: t.name || t.id,
      isDark: t.isDark === true,
      author: t.author || 'SXSEditor',
      version: t.version || '1.0.0',
      source: 'builtin',
      description: t.description || '',
    })),
    ...userThemes.map(t => ({
      id: t.id,
      name: t.name || t.id,
      isDark: t.isDark === true,
      author: t.author || '',
      version: t.version || '1.0.0',
      source: 'user',
      description: t.description || '',
    })),
  ];
}

ipcMain.handle('theme:list', async () => {
  return listAllThemes();
});

ipcMain.handle('theme:get', async (event, themeId) => {
  if (!themeId) return null;
  const all = listAllThemes();
  const meta = all.find(t => t.id === themeId);
  if (!meta) return null;
  // Get full theme object (with tokens)
  if (meta.source === 'builtin') {
    const t = BUILTIN_THEMES.BUILTIN_THEMES.find(b => b.id === themeId);
    return t || null;
  }
  const userDir = app.getPath('userData');
  const { themes } = themeStorage.loadUserThemes(userDir);
  return themes.find(t => t.id === themeId) || null;
});

ipcMain.handle('theme:current', async (event, options) => {
  const settings = loadSettings();
  const win = options && options.scope;
  if (win && win !== 'global' && settings.themePerWindow && settings.themePerWindow[win]) {
    return { themeId: settings.themePerWindow[win], scope: win, globalId: settings.theme };
  }
  return { themeId: settings.theme, scope: 'global', globalId: settings.theme };
});

ipcMain.handle('theme:apply', async (event, themeId, options) => {
  if (!themeId || typeof themeId !== 'string') {
    return { success: false, error: 'themeId 必须为字符串' };
  }
  if (!themeStorage.isValidId(themeId)) {
    return { success: false, error: '非法 id' };
  }
  // Validate exists
  const all = listAllThemes();
  if (!all.find(t => t.id === themeId)) {
    return { success: false, error: `主题 "${themeId}" 不存在` };
  }
  const settings = loadSettings();
  const scope = (options && options.scope) || 'global';
  if (scope === 'global') {
    settings.theme = themeId;
    // Clear per-window override for global switches unless explicit
    if (settings.themePerWindow) {
      // Keep per-window map intact; user can reset per-window manually
    }
  } else {
    if (!settings.themePerWindow) settings.themePerWindow = {};
    settings.themePerWindow[scope] = themeId;
  }
  await saveSettingsFile(settings);
  // Broadcast to all windows
  broadcastThemeChanged(themeId, scope);
  return { success: true, themeId, scope };
});

ipcMain.handle('theme:save', async (event, themeObj) => {
  try {
    if (!themeObj || !themeStorage.isValidId(themeObj.id)) {
      return { success: false, error: '非法 id' };
    }
    const userDir = app.getPath('userData');
    const result = themeStorage.saveTheme(userDir, themeObj);
    broadcastThemeListChanged();
    return { success: true, ...result };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('theme:delete', async (event, themeId) => {
  try {
    if (!themeId || !themeStorage.isValidId(themeId)) {
      return { success: false, error: '非法 id' };
    }
    if (themeStorage.BUILTIN_IDS.has(themeId)) {
      return { success: false, error: '不能删除内置主题' };
    }
    const userDir = app.getPath('userData');
    const result = themeStorage.deleteTheme(userDir, themeId);
    // If the deleted theme was the active global, fall back to default
    const settings = loadSettings();
    if (settings.theme === themeId) settings.theme = DEFAULT_THEME;
    if (settings.themePerWindow) {
      for (const k of Object.keys(settings.themePerWindow)) {
        if (settings.themePerWindow[k] === themeId) delete settings.themePerWindow[k];
      }
    }
    await saveSettingsFile(settings);
    broadcastThemeListChanged();
    return { success: true, ...result };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('theme:import', async (event) => {
  try {
    const result = await dialog.showOpenDialog({
      title: '导入主题',
      filters: [
        { name: '主题文件', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const obj = themeStorage.importThemeFromFile(result.filePaths[0]);
    // Save into user themes dir
    const userDir = app.getPath('userData');
    const saved = themeStorage.saveTheme(userDir, obj);
    broadcastThemeListChanged();
    return { success: true, themeId: obj.id, filePath: saved.filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('theme:export', async (event, themeId) => {
  try {
    if (!themeId || !themeStorage.isValidId(themeId)) {
      return { success: false, error: '非法 id' };
    }
    // Get full theme
    let themeObj = null;
    if (themeStorage.BUILTIN_IDS.has(themeId)) {
      themeObj = BUILTIN_THEMES.BUILTIN_THEMES.find(b => b.id === themeId);
    } else {
      const userDir = app.getPath('userData');
      const { themes } = themeStorage.loadUserThemes(userDir);
      themeObj = themes.find(t => t.id === themeId);
    }
    if (!themeObj) return { success: false, error: '主题不存在' };
    const defaultName = `${themeId}.theme.json`;
    const result = await dialog.showSaveDialog({
      title: '导出主题',
      defaultPath: defaultName,
      filters: [{ name: '主题文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    themeStorage.exportThemeToFile({ ...themeObj, source: undefined }, result.filePath);
    return { success: true, filePath: result.filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('theme:reset', async () => {
  const settings = loadSettings();
  settings.theme = DEFAULT_THEME;
  settings.themePerWindow = {};
  await saveSettingsFile(settings);
  broadcastThemeChanged(DEFAULT_THEME, 'global');
  return { success: true, themeId: DEFAULT_THEME };
});

function getAllWebContents() {
  return BrowserWindow.getAllWindows().map(w => w.webContents).filter(Boolean);
}

function broadcastThemeChanged(themeId, scope) {
  for (const wc of getAllWebContents()) {
    try { wc.send('theme:changed', { themeId, scope }); } catch (_) {}
  }
}

function broadcastThemeListChanged() {
  for (const wc of getAllWebContents()) {
    try { wc.send('theme:list-changed'); } catch (_) {}
  }
}

ipcMain.handle('theme:bootstrap', async (event) => {
  const wc = event.sender;
  const settings = loadSettings();
  // Determine the appropriate theme for this window's scope
  let themeId = settings.theme;
  try {
    // Try to identify the window type from URL hash or name
    const win = BrowserWindow.fromWebContents(wc);
    if (win) {
      // We don't have a strict per-window label here; renderer can pass its scope
    }
  } catch (_) {}
  return {
    themeId,
    globalId: settings.theme,
    themePerWindow: settings.themePerWindow,
    available: listAllThemes(),
  };
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
  singerCreatorWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  singerCreatorWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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
  const deviceMode = settings.deviceMode || 'smart';
  const deviceId = settings.preferredDeviceId ?? settings.deviceId ?? undefined;
  const preferredDeviceType = settings.preferredDeviceType || undefined;
  const modelDeviceMapping = settings.modelDeviceMapping || undefined;
  console.log(`[Main] 初始化SVS Pipeline (ONNX Runtime), 模型路径: ${modelPath}, deviceMode: ${deviceMode}, deviceId: ${deviceId !== undefined ? deviceId : '自动'}`);

  _svsPipelineInitPromise = (async () => {
    try {
      svsPipeline = new OnnxSVSPipeline(modelPath, {
        deviceId,
        deviceMode,
        preferredDeviceType,
        modelDeviceMapping,
      });
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

ipcMain.handle('fragment-svs:resolvePhonemes', async (event, { lyrics }) => {
  try {
    if (!svsPipeline || !svsPipeline.initialized) {
      await ensureSVSPipeline();
    }
    return lyrics.map(lyric => svsPipeline.resolveLyricToPhonemes(lyric));
  } catch (err) {
    console.error('[Main] 音素解析失败:', err);
    return lyrics.map(lyric => [{ name: lyric || '<SP>', display: lyric || 'SP' }]);
  }
});

ipcMain.handle('extractF0:onnx', async (event, { audioData, sampleRate }) => {
  try {
    if (!rmvpeDetector) {
      if (_rmvpeInitPromise) {
        await _rmvpeInitPromise;
      } else {
        const modelPath = getModelDir();
        const settings = loadSettings();
        const deviceId = settings.deviceId ?? undefined;
        console.log(`[Main] 初始化 RMVPE Pitch Detector, 模型路径: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : '自动'}`);
        _rmvpeInitPromise = (async () => {
          try {
            rmvpeDetector = new RmvpePitchDetector(modelPath, { deviceId });
            await rmvpeDetector.init();
          } catch (err) {
            rmvpeDetector = null;
            throw err;
          } finally {
            _rmvpeInitPromise = null;
          }
        })();
        await _rmvpeInitPromise;
      }
    }

    const f0Array = await rmvpeDetector.extractF0(new Float32Array(audioData), sampleRate || 44100);

    return {
      success: true,
      f0Array: f0Array,
    };
  } catch (err) {
    console.error('[Main] F0提取失败:', err);
    return {
      success: false,
      error: err.message,
    };
  }
});

ipcMain.handle('extractMidi:rosvot', async (event, { audioData, sampleRate, bpm }) => {
  try {
    // 先用 RMVPE 提取 F0
    if (!rmvpeDetector) {
      if (_rmvpeInitPromise) {
        await _rmvpeInitPromise;
      } else {
        const modelPath = getModelDir();
        const settings = loadSettings();
        const deviceId = settings.deviceId ?? undefined;
        console.log(`[Main] 初始化 RMVPE Pitch Detector, 模型路径: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : '自动'}`);
        _rmvpeInitPromise = (async () => {
          try {
            rmvpeDetector = new RmvpePitchDetector(modelPath, { deviceId });
            await rmvpeDetector.init();
          } catch (err) {
            rmvpeDetector = null;
            throw err;
          } finally {
            _rmvpeInitPromise = null;
          }
        })();
        await _rmvpeInitPromise;
      }
    }

    const f0Array = await rmvpeDetector.extractF0(new Float32Array(audioData), sampleRate || 44100);

    // 默认使用 f0ToNotes 从 F0 曲线提取 MIDI 音符
    let notes;
    const settings = loadSettings();
    const useRosvot = settings?.useRosvot === true;

    if (useRosvot) {
      // 尝试使用 RosVot 模型（实验性功能，当前 ONNX 导出可能有问题）
      const modelPath = getModelDir();
      const rosvotModelPath = path.join(modelPath, 'preprocess', 'rosvot_model.onnx');

      if (fs.existsSync(rosvotModelPath)) {
        try {
          if (!rosvotDetector) {
            if (_rosvotInitPromise) {
              await _rosvotInitPromise;
            } else {
              const deviceId = settings.deviceId ?? undefined;
              console.log(`[Main] 初始化 RosvotDetector, 模型路径: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : '自动'}`);
              _rosvotInitPromise = (async () => {
                try {
                  rosvotDetector = new RosvotDetector(modelPath, { deviceId });
                  await rosvotDetector.init();
                } catch (err) {
                  rosvotDetector = null;
                  throw err;
                } finally {
                  _rosvotInitPromise = null;
                }
              })();
              await _rosvotInitPromise;
            }
          }
          notes = await rosvotDetector.extractNotes(
            new Float32Array(audioData), sampleRate || 44100, f0Array, bpm || 120
          );
          console.log(`[Main] RosVot 提取到 ${notes.length} 个音符`);

          // RosVot 提取结果无效时（空或音高全为0），回退到 f0ToNotes
          const validNotes = notes.filter(n => n.pitch > 0);
          if (validNotes.length === 0) {
            console.log('[Main] RosVot 未提取到有效音符，回退到 f0ToNotes');
            notes = rmvpeDetector.f0ToNotes(f0Array, bpm || 120);
          }
        } catch (rosvotErr) {
          console.warn('[Main] RosVot 模型推理失败，回退到 f0ToNotes:', rosvotErr.message);
          rosvotDetector = null;
          notes = rmvpeDetector.f0ToNotes(f0Array, bpm || 120);
        }
      } else {
        console.log('[Main] RosVot 模型不存在，使用 f0ToNotes 回退');
        notes = rmvpeDetector.f0ToNotes(f0Array, bpm || 120);
      }
    } else {
      // 使用 f0ToNotes（默认方案）
      console.log('[Main] 使用 f0ToNotes 从 F0 曲线提取 MIDI 音符');
      notes = rmvpeDetector.f0ToNotes(f0Array, bpm || 120);
    }

    return {
      success: true,
      f0Array: f0Array,
      notes: notes,
    };
  } catch (err) {
    console.error('[Main] MIDI提取失败:', err);
    return {
      success: false,
      error: err.message,
    };
  }
});

ipcMain.handle('file:exists', async (event, filePath) => {
  if (!isPathAllowed(filePath)) return false;
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
  const forbiddenPrefixes = process.platform === 'win32'
    ? [
        path.resolve('C:\\Windows'),
        path.resolve('C:\\Program Files'),
        path.resolve('C:\\Program Files (x86)'),
        path.resolve('C:\\ProgramData'),
      ]
    : [
        '/etc', '/root', '/sys', '/proc', '/dev', '/boot',
        '/System', '/Library',
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
  if (!isPathAllowed(filePath)) throw new Error(t('error.pathNotAllowed'));
  return path.dirname(filePath);
});

ipcMain.handle('extractF0:basicPitch', async (event, { audioData, sampleRate, bpm }) => {
  try {
    if (!basicPitchDetector) {
      if (_basicPitchInitPromise) {
        await _basicPitchInitPromise;
      } else {
        const modelPath = getModelDir();
        console.log(`[Main] 初始化 Basic Pitch Detector, 模型路径: ${modelPath}`);
        _basicPitchInitPromise = (async () => {
          try {
            basicPitchDetector = new BasicPitchDetector(modelPath);
            await basicPitchDetector.init();
          } catch (err) {
            basicPitchDetector = null;
            throw err;
          } finally {
            _basicPitchInitPromise = null;
          }
        })();
        await _basicPitchInitPromise;
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
      if (_rmvpeInitPromise) {
        await _rmvpeInitPromise;
      } else {
        const modelPath = getModelDir();
        const settings = loadSettings();
        const deviceId = settings.deviceId ?? undefined;
        _rmvpeInitPromise = (async () => {
          try {
            rmvpeDetector = new RmvpePitchDetector(modelPath, { deviceId });
            await rmvpeDetector.init();
          } catch (err) {
            rmvpeDetector = null;
            throw err;
          } finally {
            _rmvpeInitPromise = null;
          }
        })();
        await _rmvpeInitPromise;
      }
    }
    return { success: true };
  } else if (groupId === 'basicPitch') {
    if (!basicPitchDetector) {
      if (_basicPitchInitPromise) {
        await _basicPitchInitPromise;
      } else {
        const modelPath = getModelDir();
        _basicPitchInitPromise = (async () => {
          try {
            basicPitchDetector = new BasicPitchDetector(modelPath);
            await basicPitchDetector.init();
          } catch (err) {
            basicPitchDetector = null;
            throw err;
          } finally {
            _basicPitchInitPromise = null;
          }
        })();
        await _basicPitchInitPromise;
      }
    }
    return { success: true };
  } else if (groupId === 'rosvot') {
    if (!rosvotDetector) {
      if (_rosvotInitPromise) {
        await _rosvotInitPromise;
      } else {
        const modelPath = getModelDir();
        const settings = loadSettings();
        const deviceId = settings.deviceId ?? undefined;
        _rosvotInitPromise = (async () => {
          try {
            rosvotDetector = new RosvotDetector(modelPath, { deviceId });
            await rosvotDetector.init();
          } catch (err) {
            rosvotDetector = null;
            throw err;
          } finally {
            _rosvotInitPromise = null;
          }
        })();
        await _rosvotInitPromise;
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
  } else if (groupId === 'rosvot') {
    if (rosvotDetector) {
      try { rosvotDetector.dispose(); } catch (_) {}
      rosvotDetector = null;
    }
    return { success: true };
  }
  return { success: false, error: `Unknown group: ${groupId}` };
}

function cleanupOnLoadFailure(groupId) {
  if (groupId === 'rmvpe') { try { if (rmvpeDetector) { rmvpeDetector.dispose(); } } catch (_) {} rmvpeDetector = null; }
  if (groupId === 'basicPitch') { try { if (basicPitchDetector) { basicPitchDetector.dispose(); } } catch (_) {} basicPitchDetector = null; }
  if (groupId === 'rosvot') { try { if (rosvotDetector) { rosvotDetector.dispose(); } } catch (_) {} rosvotDetector = null; }
}

ipcMain.handle('resmgr:open', async () => {
  openResourceManagerWindow();
  return { success: true };
});

ipcMain.handle('resmgr:getGPUInfo', async () => {
  try {
    const vramData = await queryGPUVRAMUsage();
    const controllers = await ensureGPUInfo();
    const devices = cachedDMLDevices || await enumerateDMLDevices(getModelDir(), controllers);
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
    // 跳过已禁用的模型组
    if (group.disabled) continue;

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
        ep = rmvpeDetector ? (rmvpeDetector.usingDML ? 'dml' : 'cpu') : null;
      } else if (group.id === 'basicPitch') {
        loaded = !!(basicPitchDetector && basicPitchDetector.initialized);
        ep = 'tfjs';
      } else if (group.id === 'rosvot') {
        loaded = !!(rosvotDetector && rosvotDetector.initialized);
        ep = rosvotDetector ? (rosvotDetector.usingDML ? 'dml' : 'cpu') : null;
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

// ==================== WebNN / NPU IPC ====================
// WebNN 推理在渲染进程中执行，主进程作为 IPC 中转

/**
 * 获取主窗口的 WebContents（用于向渲染进程发送消息）
 */
function getMainWindowWebContents() {
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  return win ? win.webContents : null;
}

// NPU 可用性检测结果缓存
let _npuDetectionCache = null;

ipcMain.handle('webnn:detectNPU', async () => {
  if (_npuDetectionCache) return _npuDetectionCache;

  const wc = getMainWindowWebContents();
  if (!wc) {
    return { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'No renderer window' };
  }

  // 向渲染进程请求 NPU 检测
  return new Promise((resolve) => {
    const requestId = `webnn-detect-${Date.now()}`;
    const timeout = setTimeout(() => {
      _npuDetectionCache = { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'Detection timeout' };
      resolve(_npuDetectionCache);
    }, 15000);

    ipcMain.handleOnce(`webnn:detectNPU:response:${requestId}`, async (_, result) => {
      clearTimeout(timeout);
      _npuDetectionCache = result;
      resolve(result);
    });

    wc.send('webnn:detectNPU:request', { requestId });
  });
});

ipcMain.handle('webnn:loadModel', async (_, modelId, modelPath, options) => {
  const wc = getMainWindowWebContents();
  if (!wc) return { success: false, error: 'No renderer window' };

  return new Promise((resolve) => {
    const requestId = `webnn-load-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => {
      resolve({ success: false, error: 'Load model timeout' });
    }, 120000);

    ipcMain.handleOnce(`webnn:loadModel:response:${requestId}`, async (_, result) => {
      clearTimeout(timeout);
      resolve(result);
    });

    wc.send('webnn:loadModel:request', { requestId, modelId, modelPath, options });
  });
});

ipcMain.handle('webnn:unloadModel', async (_, modelId) => {
  const wc = getMainWindowWebContents();
  if (!wc) return { success: false, error: 'No renderer window' };

  return new Promise((resolve) => {
    const requestId = `webnn-unload-${Date.now()}`;
    const timeout = setTimeout(() => {
      resolve({ success: false, error: 'Unload model timeout' });
    }, 10000);

    ipcMain.handleOnce(`webnn:unloadModel:response:${requestId}`, async (_, result) => {
      clearTimeout(timeout);
      resolve(result);
    });

    wc.send('webnn:unloadModel:request', { requestId, modelId });
  });
});

ipcMain.handle('webnn:runInference', async (_, modelId, inputs) => {
  const wc = getMainWindowWebContents();
  if (!wc) throw new Error('No renderer window');

  return new Promise((resolve, reject) => {
    const requestId = `webnn-infer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => {
      reject(new Error('Inference timeout'));
    }, 120000);

    ipcMain.handleOnce(`webnn:runInference:response:${requestId}`, async (_, result) => {
      clearTimeout(timeout);
      if (result.error) {
        reject(new Error(result.error));
      } else {
        resolve(result);
      }
    });

    wc.send('webnn:runInference:request', { requestId, modelId, inputs });
  });
});

ipcMain.handle('webnn:getStatus', async () => {
  const wc = getMainWindowWebContents();
  if (!wc) return {};

  return new Promise((resolve) => {
    const requestId = `webnn-status-${Date.now()}`;
    const timeout = setTimeout(() => resolve({}), 5000);

    ipcMain.handleOnce(`webnn:getStatus:response:${requestId}`, async (_, result) => {
      clearTimeout(timeout);
      resolve(result);
    });

    wc.send('webnn:getStatus:request', { requestId });
  });
});
