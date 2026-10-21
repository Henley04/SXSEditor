// Comprehensive crash/error logging for SXSEditor.
//
// Captures:
//   - Native crashes (Electron crashReporter → minidump .dmp files)
//   - Main-process JS exceptions (uncaughtException / unhandledRejection)
//   - Renderer-process crashes (render-process-gone)
//   - Renderer console warnings/errors + window.onerror + unhandledrejection
//     (forwarded via IPC 'crash:log')
//   - All main-process console.log/info/warn/error output (mirrored to file)
//
// File layout (under app.getPath('userData')):
//   logs/sxseditor-YYYYMMDD-HHmmss-<pid>.log   (current session log; older kept up to MAX_LOGS)
//   dumps/<name>.dmp                            (crash minidumps; older kept up to MAX_DUMPS)
//
// This module MUST be required and init()'d as early as possible in main.js
// (before app.whenReady) so crashReporter.start() and app.setPath('crashDumps')
// run pre-ready — required by Electron to capture renderer native crashes.

const { app, crashReporter, ipcMain, shell, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { safeHandle } = require('./ipcSafe');
const { IPC_CHANNELS } = require('../shared/ipcChannels');

const MAX_LOGS = 10;
const MAX_DUMPS = 3;

let LOG_DIR = null;
let DUMP_DIR = null;
let currentLogFileName = null;
let currentLogStream = null;
let initialized = false;
let deferredInitialized = false;
let bootedAt = Date.now();

function ensureDirs() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(DUMP_DIR, { recursive: true }); } catch (_) {}
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function listLogs() {
  if (!LOG_DIR) return [];
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((f) => /^sxseditor-.*\.log$/.test(f))
      .map((f) => {
        const fp = path.join(LOG_DIR, f);
        try {
          const s = fs.statSync(fp);
          return { name: f, path: fp, mtime: s.mtimeMs, size: s.size };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

function listDumps() {
  if (!DUMP_DIR) return [];
  try {
    return fs.readdirSync(DUMP_DIR)
      .filter((f) => /\.dmp$/i.test(f))
      .map((f) => {
        const fp = path.join(DUMP_DIR, f);
        try {
          const s = fs.statSync(fp);
          return { name: f, path: fp, mtime: s.mtimeMs, size: s.size };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

function rotateLogs() {
  const logs = listLogs();
  // Keep MAX_LOGS most recent. The current session log is opened *after* rotation,
  // so it's not yet in the listing.
  for (let i = MAX_LOGS; i < logs.length; i++) {
    try { fs.unlinkSync(logs[i].path); } catch (_) {}
  }
}

function rotateDumps() {
  const dumps = listDumps();
  for (let i = MAX_DUMPS; i < dumps.length; i++) {
    try { fs.unlinkSync(dumps[i].path); } catch (_) {}
  }
}

function writeLog(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}\n`;
  // 流不可用（FATAL 收尾窗口、重开失败）时回退到同步追加，避免日志静默丢失。
  if (!currentLogStream || !currentLogFileName) {
    if (!currentLogFileName) return;
    try { fs.appendFileSync(path.join(LOG_DIR, currentLogFileName), line); } catch (_) {}
    return;
  }
  try { currentLogStream.write(line); } catch (_) {}
}

// Synchronous write used for FATAL events where the process may exit immediately
// after the handler returns. Async writes can be lost if the process dies before
// the kernel flushes the buffer.
function writeLogSync(level, msg) {
  if (!currentLogFileName) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, currentLogFileName), line); } catch (_) {}
}

function safeStringify(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

function patchConsole() {
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try {
        const text = args.map(safeStringify).join(' ');
        writeLog(level.toUpperCase(), text);
      } catch (_) {}
      try { orig(...args); } catch (_) {}
    };
  }
}

// 打开（或重开）当前会话日志流：追加模式、同一文件。
// FATAL 后 currentLogStream 会被 end()，进程又按产品策略继续运行，
// 必须重新打开，否则之后所有异步日志都会丢失。
function openLogStream() {
  if (!currentLogFileName) return;
  try {
    currentLogStream = fs.createWriteStream(path.join(LOG_DIR, currentLogFileName), { flags: 'a' });
    // 避免流 error 事件无监听者升级成 uncaughtException，进而在 handleFatal 里递归。
    currentLogStream.on('error', () => { currentLogStream = null; });
  } catch (e) {
    currentLogStream = null;
    try { process.stderr.write(`[crashReporter] Failed to open log: ${e.message}\n`); } catch (_) {}
  }
}

function handleFatal(err, kind) {
  try {
    writeLogSync('FATAL', `[${kind}] ${err && err.stack || err}`);
    // Flush the async stream so partial buffered data also reaches disk.
    if (currentLogStream) {
      try { currentLogStream.end(); } catch (_) {}
      currentLogStream = null;
    }
    // 进程不退出（既有产品策略），立刻重开同一日志文件，保证后续日志不丢。
    openLogStream();
    // Log latest dump info so it shows up adjacent to the fatal entry.
    const dumps = listDumps();
    if (dumps.length > 0) {
      writeLogSync('FATAL', `Latest crash dump: ${dumps[0].name} at ${dumps[0].path}`);
      writeLogSync('FATAL', 'Please attach this dump file (and the current log file) when reporting the issue.');
    }
  } catch (_) {}
}

function logBootBanner() {
  writeLog('INFO', `==== SXSEditor starting (pid=${process.pid}) ====`);
  try { writeLog('INFO', `Version: ${app.getVersion()}`); } catch (_) {}
  writeLog('INFO', `Electron: ${process.versions.electron}, Node: ${process.versions.node}, Chrome: ${process.versions.chrome}`);
  writeLog('INFO', `Platform: ${os.platform()} ${os.release()} ${os.arch()}`);
  if (currentLogFileName) writeLog('INFO', `Log file: ${path.join(LOG_DIR, currentLogFileName)}`);
  writeLog('INFO', `Dump dir: ${DUMP_DIR}`);

  // If pre-existing dump files are present, log them and ask the user to
  // attach them when reporting an issue. This makes the dump info visible
  // in the log file itself (requirement: "转储文件信息要显示在日志里").
  const dumps = listDumps();
  if (dumps.length > 0) {
    writeLog('WARN', `==== ${dumps.length} crash dump(s) detected from previous session(s) ====`);
    dumps.forEach((d, i) => {
      writeLog('WARN', `Dump #${i + 1}: ${d.name} (size=${d.size} bytes, mtime=${new Date(d.mtime).toISOString()})`);
      writeLog('WARN', `  Path: ${d.path}`);
    });
    writeLog('WARN', 'When submitting a bug report, please attach:');
    writeLog('WARN', '  1. The most recent .dmp file(s) listed above');
    writeLog('WARN', '  2. The log file from the crash session');
    writeLog('WARN', `  Log dir:  ${LOG_DIR}`);
    writeLog('WARN', `  Dump dir: ${DUMP_DIR}`);
  }
}

function getRendererLabel(webContents) {
  try {
    const url = webContents.getURL() || '';
    if (url.includes('fragmentEditor')) return 'fragment';
    if (url.includes('settings') || url.includes('settings_window')) return 'settings';
    if (url.includes('singerCreator')) return 'singerCreator';
    if (url.includes('audioPreprocess')) return 'audioPreprocess';
    if (url.includes('modelDownload')) return 'modelDownload';
    if (url.includes('resourceManager')) return 'resourceManager';
    if (url.includes('splash')) return 'splash';
    if (url.includes('updateNotification')) return 'updateNotification';
    if (url.includes('index.html') || url.includes('main_window')) return 'main';
  } catch (_) {}
  return 'renderer';
}

function attachRendererErrorHandler(webContents) {
  if (!webContents || typeof webContents.on !== 'function') return;
  try {
    webContents.on('render-process-gone', (_event, details) => {
      const label = getRendererLabel(webContents);
      writeLog('FATAL', `[Renderer:${label}] render-process-gone: reason=${details.reason}, exitCode=${details.exitCode}`);
      const dumps = listDumps();
      if (dumps.length > 0) {
        writeLog('FATAL', `Latest crash dump: ${dumps[0].name}`);
        writeLog('FATAL', `  Path: ${dumps[0].path}`);
        writeLog('FATAL', 'Please attach this dump file (and the current log file) when reporting the issue.');
      }
    });
  } catch (_) {}
  try {
    webContents.on('console-message', (_event, details) => {
      const { level, message, lineNumber, sourceId } = details;
      // Electron console-message levels: 0=verbose, 1=info, 2=warning, 3=error.
      // Only persist warnings and errors to keep log size manageable.
      if (level >= 2) {
        const levels = ['LOG', 'INFO', 'WARN', 'ERROR'];
        const lv = levels[level] || 'LOG';
        const label = getRendererLabel(webContents);
        writeLog(lv, `[Renderer:${label}] ${message} (${sourceId}:${lineNumber})`);
      }
    });
  } catch (_) {}
}

function registerIpc() {
  // Renderer → main log forwarding (used by preload's window.onerror /
  // unhandledrejection / console.error listeners).
  ipcMain.on(IPC_CHANNELS.CRASH_LOG, (_event, payload) => {
    try {
      const { level = 'INFO', message = '', source = 'renderer' } = payload || {};
      writeLog(String(level).toUpperCase(), `[${source}] ${message}`);
    } catch (_) {}
  });

  safeHandle(IPC_CHANNELS.CRASH_GET_REPORT_INFO, async () => ({
    logDir: LOG_DIR,
    dumpDir: DUMP_DIR,
    currentLog: currentLogFileName,
    logs: listLogs(),
    dumps: listDumps(),
    bootedAt,
  }));

  safeHandle(IPC_CHANNELS.CRASH_OPEN_LOG_DIR, async () => {
    try { shell.openPath(LOG_DIR); return true; } catch { return false; }
  });

  safeHandle(IPC_CHANNELS.CRASH_OPEN_DUMP_DIR, async () => {
    try { shell.openPath(DUMP_DIR); return true; } catch { return false; }
  });
}

function init() {
  if (initialized) return;
  initialized = true;

  // ---- pre-ready 最小集（必须在 app.ready 前完成）----
  //
  // Electron 要求 crashReporter.start() 与 app.setPath('crashDumps') 在
  // app.ready 之前调用，否则渲染进程的原生崩溃不会被捕获。这两项是本函数
  // 唯一不能延后的部分。
  //
  // 其余工作（建目录、日志轮转、开日志流、patchConsole）合计实测 ~10ms，
  // 全部同步阻塞在 whenReady 之前 —— 而 splash 窗口是在 whenReady 回调的
  // 第一行才创建的，所以这段时间用户屏幕上什么都没有。它们对崩溃捕获也
  // 不是必需的（start() 自己会用 DUMP_DIR），因此延后到 ready 之后。
  LOG_DIR = path.join(app.getPath('userData'), 'logs');
  DUMP_DIR = path.join(app.getPath('userData'), 'dumps');

  // DUMP_DIR 必须**立刻**建出来：crashReporter.start() 下面就会往这个
  // 目录写 minidump，目录不存在时原生崩溃会静默丢失。mkdirSync 实测
  // ~0.9ms（已存在时立即返回），留在 pre-ready 无害。
  // LOG_DIR 只被日志流用，交给 initDeferred。
  try { fs.mkdirSync(DUMP_DIR, { recursive: true }); } catch (_) {}

  try {
    app.setPath('crashDumps', DUMP_DIR);
  } catch (e) {
    // setPath 尚未生效时 writeLog 还没有日志流可用，直接写 stderr。
    try { process.stderr.write(`[crashReporter] setPath('crashDumps') failed: ${e.message}\n`); } catch (_) {}
  }
  try {
    crashReporter.start({
      productName: 'SXSEditor',
      companyName: 'SXSEditor',
      uploadToServer: false,
      ignoreSystemCrashHandler: true,
    });
  } catch (e) {
    try { process.stderr.write(`[crashReporter] crashReporter.start failed: ${e.message}\n`); } catch (_) {}
  }

  // 剩余初始化挪到 app.ready 之后立刻执行（见 initDeferred）。
  if (app.isReady()) {
    initDeferred();
  } else {
    app.once('ready', initDeferred);
  }

  // Process-level error handlers. These replace the minimal stderr-only
  // handlers in main.js with full log-file + dump-info recording.
  // 注册在 pre-ready：ready 之前崩溃时至少还有 uncaughtException 兜底。
  process.on('uncaughtException', (err) => {
    handleFatal(err, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    handleFatal(reason, 'unhandledRejection');
  });

  // Attach render-process-gone + console-message listeners to every
  // BrowserWindow created from now on (covers main, fragment, settings,
  // modelDownload, resourceManager, singerCreator, audioPreprocess, splash,
  // updateNotification — present and future).
  app.on('browser-window-created', (_event, win) => {
    try { attachRendererErrorHandler(win.webContents); } catch (_) {}
  });
  // Also attach to any windows that already exist (defensive — normally
  // none exist when init() runs in main.js).
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      attachRendererErrorHandler(win.webContents);
    }
  } catch (_) {}

  registerIpc();
}

// 建目录 / 轮转 / 开日志流 / patchConsole。
//
// 由 app 'ready' 事件触发（在 main.js 的 whenReady 回调之外注册，所以不会
// 和 splash 创建抢同一个微任务队列的头部）。做完这步 main.js 才继续
// 加载模块并显示窗口 —— 日志系统因此仍能覆盖启动期的绝大多数事件，只是
// 少了 pre-ready 那几毫秒内的 console 输出。
function initDeferred() {
  if (deferredInitialized) return;
  deferredInitialized = true;

  ensureDirs();
  rotateLogs();
  rotateDumps();

  // Open log file for this session (append mode; one file per launch).
  currentLogFileName = `sxseditor-${timestamp()}-${process.pid}.log`;
  openLogStream();

  logBootBanner();

  // Mirror all main-process console output to the log file.
  patchConsole();

  writeLog('INFO', `Crash reporter started (native dumps -> ${DUMP_DIR})`);
}

module.exports = {
  init,
  attachRendererErrorHandler,
  listLogs,
  listDumps,
  getLogDir: () => LOG_DIR,
  getDumpDir: () => DUMP_DIR,
  getCurrentLogFileName: () => currentLogFileName,
};
