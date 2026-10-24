const { BrowserWindow, dialog, shell } = require('electron');
const path = require('node:path');
const { t } = require('./locale');
// 文档入口：本地优先（随应用分发的 docs/），线上版本作为独立入口
const { openDoc, openOnlineDoc, DOC_ENTRIES } = require('./docs');

const isDev = !require('electron').app.isPackaged;
const { safeHandle } = require('./ipcSafe');
const { IPC_CHANNELS } = require('../shared/ipcChannels');

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

/**
 * 通知某个窗口的渲染进程"内容区尺寸可能已变化，请重新布局"。
 *
 * 用于修复：停靠式 DevTools 打开后再关闭，BrowserWindow 的 bounds 不变、
 * window 'resize' 也不一定触发，页面 canvas 仍按旧尺寸绘制，表现为
 * "开发者工具关闭后页面没有自动刷新，必须手动操作一下才正常"。
 *
 * DevTools 关闭后 Chromium 需要若干帧才把新尺寸应用到宿主视图，所以这里
 * 发送多次（0 / 60 / 200ms），由渲染进程自行去重。
 *
 * @param {import('electron').BrowserWindow} win
 */
function notifyRelayout(win) {
  if (!win || win.isDestroyed()) return;
  const send = () => {
    try {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.RELAYOUT);
    } catch (_) {}
  };
  send();
  setTimeout(send, 60);
  setTimeout(send, 200);
}

/**
 * 给窗口挂上"尺寸/DevTools 变化 → 通知渲染进程重排"的监听。
 *
 * 必须在窗口创建后尽早调用，否则会漏掉 devtools-opened/closed。
 *
 * @param {import('electron').BrowserWindow} win
 */
function attachRelayoutListeners(win) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  try {
    wc.on('devtools-opened', () => notifyRelayout(win));
    wc.on('devtools-closed', () => notifyRelayout(win));
  } catch (_) {}
  try {
    win.on('resize', () => notifyRelayout(win));
    win.on('enter-full-screen', () => notifyRelayout(win));
    win.on('leave-full-screen', () => notifyRelayout(win));
    win.on('maximize', () => notifyRelayout(win));
    win.on('unmaximize', () => notifyRelayout(win));
  } catch (_) {}
}

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
              mainWindow.webContents.send(IPC_CHANNELS.MAIN_MENU_SAVE_REQUEST);
            }
          },
        },
        {
          label: t('menu.saveAs'),
          accelerator: 'CommandOrControl+Shift+S',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC_CHANNELS.MAIN_MENU_SAVE_AS_REQUEST);
            }
          },
        },
        {
          label: t('menu.editSinger'),
          click: () => {
            // 延迟 require：singerIpc 依赖本模块（getMainWindow / openAudioPreprocess），
            // 顶层互相 require 会形成循环。
            const { openSingerFileForEdit } = require('./singerIpc');
            openSingerFileForEdit().then((res) => {
              if (res && res.success === false && !res.canceled) {
                const { dialog } = require('electron');
                const opts = { type: 'error', message: t('menu.editSinger'), detail: res.error || '' };
                if (mainWindow && !mainWindow.isDestroyed()) {
                  dialog.showMessageBox(mainWindow, opts);
                } else {
                  dialog.showMessageBox(opts);
                }
              }
            }).catch((err) => console.error('[Menu] open singer editor failed:', err));
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
          // 项目主页：GitHub 仓库（文档站首页由下面的「在线文档」入口承担）
          label: t('menu.website'),
          click: () => {
            try {
              require('electron').shell.openExternal('https://github.com/Henley04/SXSEditor/');
            } catch (err) {
              console.warn('[Menu] Open website failed:', err.message);
            }
          },
        },
        {
          // 本地文档：随应用分发的 docs/user/quick-start.html，缺失时回退线上
          label: t('menu.userDocs'),
          click: () => {
            openDoc(DOC_ENTRIES.quickStart).catch((err) => {
              console.warn('[Menu] Open user docs failed:', err && err.message);
            });
          },
        },
        {
          // 本地文档：随应用分发的 docs/dev/build.html，缺失时回退线上
          label: t('menu.devDocs'),
          click: () => {
            openDoc(DOC_ENTRIES.devBuild).catch((err) => {
              console.warn('[Menu] Open dev docs failed:', err && err.message);
            });
          },
        },
        {
          // 线上版本单独入口：始终打开 GitHub Pages 上的最新版文档
          label: t('menu.onlineDocs'),
          click: () => {
            openOnlineDoc('').catch((err) => {
              console.warn('[Menu] Open online docs failed:', err && err.message);
            });
          },
        },
        { type: 'separator' },
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
      // 安全加固：渲染进程开 OS 级沙箱。preload（src/preload.js）只 require
      // electron 的 contextBridge / ipcRenderer，不使用任何 Node 内建模块，
      // 因此在 sandbox:true 下仍可正常工作。此前为 false，意味着一旦渲染进程
      // 被攻陷（Chromium 漏洞 / 依赖链 XSS / 市场窗口渲染的远端内容），缺少
      // 第二层 OS 拦截。
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  attachRelayoutListeners(mainWindow);
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
      mainWindow.webContents.send(IPC_CHANNELS.CLOSE_CONFIRM);
    }
  });

  // 菜单构建从 createWindow() 挪出（见下方 buildAppMenuDeferred 的说明）：
  // 30+ 个菜单项、每项走 t() 的逐级查表，此前压在主窗口 reveal 的关键路径上。
  // 调用方（main.js）在窗口显示之后再补上，功能不变。
  return mainWindow;
}

/**
 * 延后构建应用菜单。
 *
 * 为什么延后：Menu.buildFromTemplate + Menu.setApplicationMenu 要构造 30+ 个菜单
 * 项，每项再走一次 t() 的 split('.').reduce() 逐级查表。这段同步工作原本在
 * createWindow() 末尾，也就是在主窗口 show() 之前，直接加在冷启动的关键路径上。
 * 菜单是用户交互才用到的东西，窗口先出来再补菜单完全无感。
 *
 * 幂等：重复调用不会重复 setApplicationMenu。
 */
let _appMenuBuilt = false;
function buildAppMenuDeferred() {
  if (_appMenuBuilt) return;
  _appMenuBuilt = true;
  try {
    buildAppMenu();
  } catch (err) {
    // 菜单失败不能影响主窗口可用性
    console.warn('[Menu] buildAppMenu failed:', err && err.message);
  }
}

function openSettingsWindow() {
  // 模态设置窗口会禁用主窗口输入（用户点不了暂停/停止），但主窗口的
  // WebAudio 播放、rAF、流式推理与 underrun 恢复全部继续在后台运行。
  // 若不暂停，用户关闭设置后会面对"播放被无视继续跑"且播放头已推进到
  // 未知位置（长间隔场景尤其明显）。打开设置即暂停：记录当前位置，
  // 回到主窗口后可从暂停点手动继续。
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(IPC_CHANNELS.SETTINGS_WINDOW_OPENED); } catch (_) {}
  }
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
      sandbox: true,
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
      sandbox: true,
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
      sandbox: true,
      spellcheck: false,
    },
  });

  modelDownloadWindow.loadURL(MODEL_DOWNLOAD_WINDOW_WEBPACK_ENTRY);
  modelDownloadWindow.once('ready-to-show', () => { modelDownloadWindow.show(); });
  modelDownloadWindow.setMenu(null);
  modelDownloadWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  modelDownloadWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  modelDownloadWindow.webContents.once('did-finish-load', () => {
    modelDownloadWindow.webContents.send(IPC_CHANNELS.MODEL_DOWNLOAD_MISSING_FILES, missingFiles);
    modelDownloadWindow.webContents.send(IPC_CHANNELS.MODEL_DOWNLOAD_PRECISION, currentPrecision);
    if (revision) {
      modelDownloadWindow.webContents.send(IPC_CHANNELS.MODEL_DOWNLOAD_REVISION, revision);
    }
    modelDownloadWindow.focus();
  });

  modelDownloadWindow.on('closed', () => {
    modelDownloadWindow = null;
    // 通知所有窗口（特别是设置窗口）：模型下载窗口已关闭，
    // 让设置页面可以刷新模型状态总览区，反映最新下载/更新结果。
    for (const wc of getAllWebContents()) {
      try { wc.send(IPC_CHANNELS.MODEL_DOWNLOAD_WINDOW_CLOSED); } catch (_) {}
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
      sandbox: true,
      spellcheck: false,
    },
  });

  updateNotificationWindow.loadURL(UPDATE_NOTIFICATION_WINDOW_WEBPACK_ENTRY);
  updateNotificationWindow.once('ready-to-show', () => { updateNotificationWindow.show(); });
  updateNotificationWindow.setMenu(null);
  updateNotificationWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  updateNotificationWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  updateNotificationWindow.webContents.once('did-finish-load', () => {
    updateNotificationWindow.webContents.send(IPC_CHANNELS.UPDATE_NOTIFICATION_SHOW, data);
  });

  updateNotificationWindow.on('closed', () => {
    updateNotificationWindow = null;
  });
}

function openFragmentEditor(fragment, project, wavBuffer, backend) {
  // backend 缺省按内置后端：老工程 / 内置轨道没有这个字段。
  const trackBackend = backend && typeof backend === 'object' ? backend : { type: 'sxs' };
  const sendData = { fragment, project, wavBuffer, backend: trackBackend };
  if (fragmentWindows[fragment.id] && !fragmentWindows[fragment.id].isDestroyed()) {
    fragmentWindows[fragment.id].focus();
    fragmentWindows[fragment.id].webContents.send(IPC_CHANNELS.LOAD_FRAGMENT, sendData);
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
      sandbox: true,
      spellcheck: false,
    },
  });

  fragmentWindow.loadURL(`${FRAGMENT_EDITOR_WINDOW_WEBPACK_ENTRY}#fragmentId=${encodeURIComponent(fragment.id)}`);
  attachRelayoutListeners(fragmentWindow);
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
    fragmentWindow.webContents.send(IPC_CHANNELS.LOAD_FRAGMENT, sendData);
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
              win.webContents.send(IPC_CHANNELS.SINGER_CREATOR_SAVE_REQUEST);
            }
          },
        },
        {
          label: t('singerCreator.saveAs'),
          accelerator: 'CommandOrControl+Shift+S',
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.SINGER_CREATOR_SAVE_AS_REQUEST);
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
      sandbox: true,
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

// Singer Market 窗口允许交给系统浏览器打开的域名。
// 原先这里只判断 scheme 就 openExternal，等于 market 页面里任何链接
// （含服务端下发的 license URL、任何一处 DOM 注入）都能把用户送到任意
// 站点。策略与 dialogIpc.js 的 'shell:open-external' 保持一致：只准 https，
// 且主机按"边界匹配"命中白名单（github.com.evil.com 不算命中）。
// 若后续市场新增 license 域名，往这里补一项即可。
const SINGER_MARKET_EXTERNAL_HOSTS = [
  'henley04.github.io',   // 使用条款 DISCLAIMER_URL
  'github.com',
  'github.io',
  'huggingface.co',
  'modelscope.cn',
  'creativecommons.org',  // CC 系列 license 正文
  'opensource.org',       // MIT / Apache 等 license 正文
];

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
      sandbox: true,
      spellcheck: false,
    },
  });

  singerMarketWindow.loadURL(SINGER_MARKET_WINDOW_WEBPACK_ENTRY);
  singerMarketWindow.once('ready-to-show', () => { singerMarketWindow.show(); });
  singerMarketWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  // target="_blank" links in the market UI (terms-of-use disclaimer, license
  // URLs, …) must open in the system browser. A blanket deny made those
  // clicks silently no-op. 但也不能对任意 http(s) 放行：这里改为只准 https
  // 且主机命中 SINGER_MARKET_EXTERNAL_HOSTS，其余一律 deny 并记日志。
  singerMarketWindow.webContents.setWindowOpenHandler(({ url }) => {
    let host = null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') host = parsed.hostname.toLowerCase();
    } catch (_) {
      // 不是合法 URL —— host 保持 null，走 deny 分支
    }
    const allowed = !!host && SINGER_MARKET_EXTERNAL_HOSTS.some(
      domain => host === domain || host.endsWith('.' + domain)
    );
    if (allowed) {
      shell.openExternal(url);
    } else {
      console.warn('[Main] Blocked singer-market external URL:', url);
    }
    return { action: 'deny' };
  });

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
    // 歌手编辑模式：带上已有音符 / F0 / singerData 与目标文件路径。
    // 只有从「编辑歌手文件」入口打开时才有值，正常新建流程为 undefined。
    edit: data.edit || null,
  };
  preprocessWavBuffer = data.wavBuffer;

  if (audioPreprocessWindow) {
    audioPreprocessWindow.focus();
    audioPreprocessWindow.webContents.send(IPC_CHANNELS.LOAD_PREPROCESS_DATA, { data: pendingPreprocessData, wavBuffer: preprocessWavBuffer });
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
      sandbox: true,
      spellcheck: false,
    },
  });

  audioPreprocessWindow.loadURL(AUDIO_PREPROCESS_WINDOW_WEBPACK_ENTRY);
  audioPreprocessWindow.once('ready-to-show', () => { audioPreprocessWindow.show(); });
  audioPreprocessWindow.webContents.on('will-navigate', (e) => { e.preventDefault(); });
  audioPreprocessWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  audioPreprocessWindow.webContents.once('did-finish-load', () => {
    audioPreprocessWindow.webContents.send(IPC_CHANNELS.LOAD_PREPROCESS_DATA, { data: pendingPreprocessData, wavBuffer: preprocessWavBuffer });
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
  safeHandle(IPC_CHANNELS.OPEN_FRAGMENT_EDITOR, async (event, { fragment, project, wavBuffer, backend }) => {
    openFragmentEditor(fragment, project, wavBuffer, backend);
  });

  safeHandle(IPC_CHANNELS.GET_FRAGMENT_DATA, async (event, fragmentId) => {
    return pendingFragmentData[fragmentId] || null;
  });

  safeHandle(IPC_CHANNELS.SAVE_FRAGMENT_DATA_SYNC, async (event, fragmentId, data) => {
    try {
      if (fragmentWindows[fragmentId] && !fragmentWindows[fragmentId].isDestroyed()) {
        fragmentWindows[fragmentId].webContents.send(IPC_CHANNELS.FRAGMENT_DATA_SAVED, { fragmentId, ...data });
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.FRAGMENT_DATA_SAVED, { fragmentId, ...data });
      }
      return true;
    } catch (err) {
      console.error('[Main] Failed to save fragment data:', err);
      return false;
    }
  });

  safeHandle(IPC_CHANNELS.SAVE_FRAGMENT_DATA, async (event, fragmentId, data) => {
    if (fragmentWindows[fragmentId] && !fragmentWindows[fragmentId].isDestroyed()) {
      fragmentWindows[fragmentId].webContents.send(IPC_CHANNELS.FRAGMENT_DATA_SAVED, { fragmentId, ...data });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.FRAGMENT_DATA_SAVED, { fragmentId, ...data });
    }
    return { success: true };
  });

  safeHandle(IPC_CHANNELS.FRAGMENT_CLOSE, async (event, fragmentId) => {
    closeFragmentEditor(fragmentId);
    return { success: true };
  });

  safeHandle(IPC_CHANNELS.FRAGMENT_CLOSE_ALL, async () => {
    closeAllFragmentEditors();
    return { success: true };
  });

  safeHandle(IPC_CHANNELS.UPDATE_FRAGMENT_BOUNDS, async (event, fragmentId, data) => {
    // 同步刷新 pendingFragmentData 快照里的边界，避免分片编辑器在 currentFragment
    // 就绪前收到 fragmentBoundsChanged 被守卫丢弃后，又用旧快照覆盖 currentFragment，
    // 导致主页面对分片长度/结尾的修改偶现不同步。
    const pending = pendingFragmentData[fragmentId];
    if (pending && pending.fragment) {
      if (data.startTime !== undefined) pending.fragment.startTime = data.startTime;
      if (data.duration !== undefined) pending.fragment.duration = data.duration;
    }
    if (fragmentWindows[fragmentId] && !fragmentWindows[fragmentId].isDestroyed()) {
      fragmentWindows[fragmentId].webContents.send(IPC_CHANNELS.FRAGMENT_BOUNDS_CHANGED, { fragmentId, ...data });
    }
    return { success: true };
  });

  safeHandle(IPC_CHANNELS.UPDATE_PROJECT_SETTINGS, async (event, projectData) => {
    for (const id in fragmentWindows) {
      if (fragmentWindows[id] && !fragmentWindows[id].isDestroyed()) {
        fragmentWindows[id].webContents.send(IPC_CHANNELS.PROJECT_SETTINGS_CHANGED, projectData);
      }
    }
    return { success: true };
  });

  safeHandle(IPC_CHANNELS.OPEN_SINGER_CREATOR, async () => {
    openSingerCreator();
  });

  safeHandle('openSingerMarket', async () => {
    openSingerMarket();
  });

  safeHandle(IPC_CHANNELS.OPEN_AUDIO_PREPROCESS, async (event, data) => {
    openAudioPreprocess(data);
  });

  safeHandle(IPC_CHANNELS.SEND_PREPROCESS_DATA, async (event, data) => {
    if (singerCreatorWindow && !singerCreatorWindow.isDestroyed()) {
      singerCreatorWindow.webContents.send(IPC_CHANNELS.PREPROCESS_DATA_SAVED, data);
    }
    return { success: true };
  });


  safeHandle(IPC_CHANNELS.SET_DIRTY, async (event, dirty) => {
    isDirty = dirty;
    return { success: true };
  });

  safeHandle(IPC_CHANNELS.CLOSE_CONFIRMED, async () => {
    if (closePending && mainWindow && !mainWindow.isDestroyed()) {
      closePending = false;
      isDirty = false;
      mainWindow.close();
    }
    return { success: true };
  });

  safeHandle(IPC_CHANNELS.RELOAD_MAIN_WINDOW, async () => {
    buildAppMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Apply locale in place. Reloading destroys the unsaved in-memory project.
      mainWindow.webContents.send(IPC_CHANNELS.LOCALE_CHANGED);
    }
  });
}

module.exports = {
  createWindow,
  buildAppMenuDeferred,
  openSettingsWindow,
  notifyRelayout,
  attachRelayoutListeners,
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
