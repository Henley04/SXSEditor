'use strict';
/**
 * 插件系统的 IPC 门面（主进程侧）。
 *
 * 通道分两类：
 *   · 静态通道（invoke）：列表、安装、卸载、启停、重载、跑命令、面板 RPC、日志；
 *   · 推送通道（send）：sync（全量投影）、event（日志/进度）、project-apply（向主窗口
 *     索要工程写权限的一次往返）。
 *
 * 动态通道在这里不需要：插件 runtime 与主进程走 utilityProcess 的 MessagePort，
 * 不占 ipcMain。这一点直接消掉了"每个插件注册一堆 IPC 通道、卸载时忘了删"的整类问题。
 */
const { app, ipcMain, dialog, shell, BrowserWindow } = require('electron');
const path = require('node:path');

const { IPC_CHANNELS } = require('../../shared/ipcChannels');
const { safeHandle } = require('../ipcSafe');
const { TIMEOUTS } = require('../../shared/pluginApi.js');

function registerPluginHostIpc(service, options = {}) {
  const probe = options.probe;
  const channels = [];

  /**
   * 注册一个 handler 并记账（供 dispose 精确摘除）。
   *
   * ⚠️ `safeHandle` 必须**逐条直接调用**，不要包进循环或辅助函数：
   * scripts/check-ipc-channels.js 靠 `safeHandle(IPC_CHANNELS.X` 这个字面形态
   * 做静态核对（见该脚本 CONST_RE 分支）。包一层之后这些通道在检查器眼里会变成
   * "渲染进程 invoke 了、主进程没人处理"，那正好是它唯一能拦住的事故类型，
   * 不能让它失效。
   */
  const track = (channel) => {
    channels.push(channel);
    if (probe) probe.noteIpcAdded();
  };

  safeHandle(IPC_CHANNELS.PLUGINHOST_LIST, async () => service.snapshot());
  track(IPC_CHANNELS.PLUGINHOST_LIST);
  safeHandle(IPC_CHANNELS.PLUGINHOST_ADMIN, async () => service.adminSnapshot());
  track(IPC_CHANNELS.PLUGINHOST_ADMIN);
  safeHandle(IPC_CHANNELS.PLUGINHOST_RELOAD, async () => service.reloadAll({ reason: 'user' }));
  track(IPC_CHANNELS.PLUGINHOST_RELOAD);
  safeHandle(IPC_CHANNELS.PLUGINHOST_RUN_COMMAND, async (_event, commandId, args) => (
    service.runCommand(commandId, args || {})
  ));
  track(IPC_CHANNELS.PLUGINHOST_RUN_COMMAND);
  safeHandle(IPC_CHANNELS.PLUGINHOST_PANEL_RPC, async (_event, request) => service.panelRpc(request || {}));
  track(IPC_CHANNELS.PLUGINHOST_PANEL_RPC);
  safeHandle(IPC_CHANNELS.PLUGINHOST_SET_ENABLED, async (_event, id, enabled) => (
    service.setEnabled(id, !!enabled)
  ));
  track(IPC_CHANNELS.PLUGINHOST_SET_ENABLED);
  safeHandle(IPC_CHANNELS.PLUGINHOST_GET_LOG, async (_event, limit) => service.getLog(limit));
  track(IPC_CHANNELS.PLUGINHOST_GET_LOG);

  // ---- M2：界面贡献点 ----
  safeHandle(IPC_CHANNELS.PLUGINHOST_SETTINGS_GET, async (_event, pluginId) => (
    service.getSettings(pluginId)
  ));
  track(IPC_CHANNELS.PLUGINHOST_SETTINGS_GET);

  safeHandle(IPC_CHANNELS.PLUGINHOST_SETTINGS_SET, async (_event, pluginId, patch) => (
    service.setSettings(pluginId, patch)
  ));
  track(IPC_CHANNELS.PLUGINHOST_SETTINGS_SET);

  safeHandle(IPC_CHANNELS.PLUGINHOST_SET_KEYBINDINGS, async (_event, pluginId, enabled) => (
    service.setKeybindingsEnabled(pluginId, !!enabled)
  ));
  track(IPC_CHANNELS.PLUGINHOST_SET_KEYBINDINGS);

  safeHandle(IPC_CHANNELS.PLUGINHOST_SET_AUTOMATION, async (_event, pluginId, enabled) => (
    service.setAutomationExpose(pluginId, !!enabled)
  ));
  track(IPC_CHANNELS.PLUGINHOST_SET_AUTOMATION);

  safeHandle(IPC_CHANNELS.PLUGINHOST_OVERLAY_URL, async (_event, pluginId, overlayId) => (
    service.overlayUrl(pluginId, overlayId)
  ));
  track(IPC_CHANNELS.PLUGINHOST_OVERLAY_URL);

  safeHandle(IPC_CHANNELS.PLUGINHOST_OPEN_PANEL_REQUEST, async (_event, pluginId, panelId) => (
    service.openPanel(pluginId, panelId)
  ));
  track(IPC_CHANNELS.PLUGINHOST_OPEN_PANEL_REQUEST);

  // ---- M4：数据面 ----
  safeHandle(IPC_CHANNELS.PLUGINHOST_OPEN_DOCUMENT, async (_event, filePath) => (
    service.openDocument(String(filePath || ''))
  ));
  track(IPC_CHANNELS.PLUGINHOST_OPEN_DOCUMENT);

  // 保存/导出：渲染层把当前工程文档交过来，主进程问插件要字节并写盘。
  // document 是结构化克隆过来的（Uint8Array / 普通对象都能过），不经过 JSON。
  safeHandle(IPC_CHANNELS.PLUGINHOST_SAVE_DOCUMENT, async (_event, filePath, document, options) => (
    service.saveDocument(String(filePath || ''), document, {
      target: options && options.target === 'export' ? 'export' : 'save',
    })
  ));
  track(IPC_CHANNELS.PLUGINHOST_SAVE_DOCUMENT);

  safeHandle(IPC_CHANNELS.PLUGINHOST_FILE_FILTERS, async (_event, role) => (
    service.fileFilters(role === 'save' ? 'save' : 'open')
  ));
  track(IPC_CHANNELS.PLUGINHOST_FILE_FILTERS);

  // 工程级渲染意图：打开/新建工程后由渲染层推一次。pipeline hook 执行器在主进程，
  // 这里只做"把声明放到执行器手上"，不解释内容。
  safeHandle(IPC_CHANNELS.PLUGINHOST_SET_RENDER_INTENT, async (_event, intent) => (
    service.setRenderIntent(intent)
  ));
  track(IPC_CHANNELS.PLUGINHOST_SET_RENDER_INTENT);

  // M4 第 4 段：成品导出。清单给导出对话框填下拉，执行把音频交给插件编码。
  safeHandle(IPC_CHANNELS.PLUGINHOST_LIST_EXPORTERS, async () => service.listExporters());
  track(IPC_CHANNELS.PLUGINHOST_LIST_EXPORTERS);

  safeHandle(IPC_CHANNELS.PLUGINHOST_EXPORT_AUDIO, async (_event, filePath, ref, audio) => (
    service.exportAudio(String(filePath || ''), ref || {}, audio || {})
  ));
  track(IPC_CHANNELS.PLUGINHOST_EXPORT_AUDIO);

  safeHandle(IPC_CHANNELS.PLUGINHOST_INSTALL, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || service.getMainWindow();
    const picked = await dialog.showOpenDialog(win || null, {
      title: 'Install Plugin',
      properties: ['openFile'],
      filters: [{ name: 'SXSEditor Plugin', extensions: ['sxsp'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    return service.installFromPackage(picked.filePaths[0]);
  });
  track(IPC_CHANNELS.PLUGINHOST_INSTALL);

  safeHandle(IPC_CHANNELS.PLUGINHOST_INSTALL_PATH, async (_event, filePath) => (
    service.installFromPackage(filePath)
  ));
  track(IPC_CHANNELS.PLUGINHOST_INSTALL_PATH);

  safeHandle(IPC_CHANNELS.PLUGINHOST_UNINSTALL, async (_event, id, keepData) => (
    service.uninstall(id, { keepData: !!keepData })
  ));
  track(IPC_CHANNELS.PLUGINHOST_UNINSTALL);

  safeHandle(IPC_CHANNELS.PLUGINHOST_OPEN_DIR, async () => {
    const dir = service.getPluginsDir();
    shell.openPath(dir);
    return { ok: true, dir };
  });
  track(IPC_CHANNELS.PLUGINHOST_OPEN_DIR);

  // 主窗口回复 project.apply 的结果
  const onApplyResult = (_event, payload) => {
    service.resolveProjectApply(payload);
  };
  ipcMain.on(IPC_CHANNELS.PLUGINHOST_PROJECT_APPLY_RESULT, onApplyResult);
  if (probe) probe.noteIpcAdded();

  const dispose = () => {
    for (const channel of channels) {
      try { ipcMain.removeHandler(channel); } catch (_) { /* ignore */ }
      if (probe) probe.noteIpcRemoved();
    }
    try {
      ipcMain.removeListener(IPC_CHANNELS.PLUGINHOST_PROJECT_APPLY_RESULT, onApplyResult);
      if (probe) probe.noteIpcRemoved();
    } catch (_) { /* ignore */ }
    channels.length = 0;
  };

  return { dispose, channels };
}

/** 把最新投影推给所有窗口（管理器与主窗口都要）。 */
function broadcastSnapshot(service) {
  let snapshot;
  try {
    snapshot = service.snapshot();
  } catch (_) {
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC_CHANNELS.PLUGINHOST_SYNC, snapshot);
    } catch (_) { /* 窗口正在销毁 */ }
  }
}

/**
 * 每个窗口"加载完成"时补发一次投影。
 *
 * 冷启动的竞态：插件在窗口还空着的时候就加载完了，那次 broadcastSnapshot 没有
 * 任何监听者；渲染层随后自己 invoke 一次 list()，但那时主进程可能还在加载
 * （拿到的是一份空投影），而加载结束不会再广播 —— 结果就是"插件明明在跑，
 * 工具栏却空着，直到手动重载窗口"。
 *
 * 这里把"窗口就绪"当成一次明确的订阅握手：此时 registry 一定已经有最终结果，
 * 推一次即可，比渲染层定时轮询干净。
 */
function pushSnapshotOnWindowLoad(service) {
  // 单测里 electron 是桩（没有 app.on），退化成空实现即可
  if (!app || typeof app.on !== 'function') return () => {};
  const onCreated = (_event, win) => {
    if (!win.webContents || typeof win.webContents.on !== 'function') return;
    if (!win || !win.webContents) return;
    win.webContents.on('did-finish-load', () => {
      let snapshot;
      try { snapshot = service.snapshot(); } catch (_) { return; }
      try { win.webContents.send(IPC_CHANNELS.PLUGINHOST_SYNC, snapshot); } catch (_) { /* 窗口正在销毁 */ }
    });
  };
  app.on('browser-window-created', onCreated);
  return () => { try { app.removeListener('browser-window-created', onCreated); } catch (_) { /* ignore */ } };
}

/** 插件事件（日志 / 进度 / 通知）转发给所有窗口，由渲染层决定要不要显示。 */
function broadcastEvent(pluginId, event, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC_CHANNELS.PLUGINHOST_EVENT, { pluginId, event, payload });
    } catch (_) { /* ignore */ }
  }
}

/**
 * 向主窗口索要一次工程写入。
 * 用独立通道而不是复用 MCP 的自动化通道：那条通道的消费者（mcpBridge）会按 id
 * 竞争回包，混用会让"谁该收到这个响应"变得不可判定。
 */
function requestProjectApply(mainWindow, id, operations, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      reject(new Error('主窗口不可用'));
      return;
    }
    const timer = setTimeout(() => reject(new Error('工程写入超时')), timeoutMs);
    const entry = { resolve, reject, timer };
    requestProjectApply._pending.set(id, entry);
    try {
      mainWindow.webContents.send(IPC_CHANNELS.PLUGINHOST_PROJECT_APPLY, { id, operations });
    } catch (err) {
      requestProjectApply._pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}
requestProjectApply._pending = new Map();

/**
 * 生成一次工程往返的请求 id。
 *
 * 不能只用 Date.now()：同一个插件在同一毫秒内发两次 apply（面板连点、批量脚本）
 * 会得到相同 id，后者覆盖前者在 _pending 里的条目，先发的那个 Promise 永远等不到
 * 响应，只能挂到 60s 超时。加一个进程内自增序号即可保证唯一。
 */
let _applySeq = 0;
function nextProjectApplyId(pluginId, kind) {
  _applySeq += 1;
  return `plugin:${pluginId}:${kind}:${Date.now().toString(36)}:${_applySeq}`;
}

function settleProjectApply(payload) {
  const entry = payload && payload.id ? requestProjectApply._pending.get(payload.id) : null;
  if (!entry) return false;
  requestProjectApply._pending.delete(payload.id);
  clearTimeout(entry.timer);
  if (payload.ok) entry.resolve(payload.result);
  else entry.reject(Object.assign(new Error((payload.error && payload.error.message) || '工程写入失败'), {
    code: (payload.error && payload.error.code) || 'INTERNAL',
  }));
  return true;
}

function pendingProjectApplyCount() {
  return requestProjectApply._pending.size;
}

/**
 * 请主窗口把某个插件面板挂起来。
 * 面板 URL 在主进程拼（渲染层拿不到插件目录，也不该拿）：
 *   · entry 来自 manifest，只有主进程读过并校验过；
 *   · 卸载后 resolvePluginDir 返回 null，plugin:// 立刻 404，iframe 自然变空白，
 *     不会出现"已卸载的插件还显示着旧界面"。
 */
function requestOpenPanel(mainWindow, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    mainWindow.webContents.send(IPC_CHANNELS.PLUGINHOST_OPEN_PANEL, payload);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  registerPluginHostIpc,
  broadcastSnapshot,
  pushSnapshotOnWindowLoad,
  broadcastEvent,
  requestProjectApply,
  settleProjectApply,
  pendingProjectApplyCount,
  nextProjectApplyId,
  requestOpenPanel,
  _paths: { path, TIMEOUTS },
};
