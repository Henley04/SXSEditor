'use strict';
/**
 * 插件服务 —— 主进程侧的门面与编排者。
 *
 * 职责边界：
 *   · PluginInstaller 负责磁盘上有没有这个插件；
 *   · PluginRegistry 负责"它贡献了什么"；
 *   · PluginRuntimeManager 负责"它的代码在哪跑"；
 *   · 本文件只做编排：加载、卸载、派发命令、转发 RPC、退出时拆干净。
 *
 * 卸载顺序（不可颠倒）：
 *   1. 撤 UI / 菜单（renderer 投影 + native menu）
 *   2. 停 runtime（dispose → kill）
 *   3. 注册表摘除
 *   4. 删文件
 *   5. 泄漏断言（失败只记审计，因为前面的步骤已经保证了正确性）
 */
const { app, dialog, BrowserWindow } = require('electron');

const { TIMEOUTS, ERR, RUNTIME_LIMITS } = require('../../shared/pluginApi.js');
const { validateManifest, isLegacyManifest } = require('../../shared/pluginManifest.js');
const { PluginRegistry } = require('./PluginRegistry.js');
const { PluginRuntimeManager } = require('./PluginRuntimeManager.js');
const { PluginLeakProbe } = require('./PluginLeakProbe.js');
const installer = require('./PluginInstaller.js');
const store = require('./PluginStateStore.js');
const ipcFacade = require('./PluginIpcV2.js');
const { buildPluginsMenu } = require('./PluginMenu.js');
const { panelUrl } = require('./PluginProtocol.js');

class PluginService {
  constructor() {
    this.registry = new PluginRegistry();
    this.runtimes = new PluginRuntimeManager({
      hostHandler: (id, method, params) => this._handleHostCall(id, method, params),
    });
    this.probe = new PluginLeakProbe({
      registry: this.registry,
      runtimeManager: this.runtimes,
      getWindows: () => BrowserWindow.getAllWindows(),
      enabled: !app.isPackaged,
    });
    this.initialized = false;
    this.ipc = null;
    this.mainWindowGetter = () => null;
    this._menuDirtyHandler = null;
    this._changeDisposable = null;
    this._pluginDirs = new Map();
    this._locale = 'zh-CN';

    this.runtimes.onEvent = (pluginId, event, payload) => {
      ipcFacade.broadcastEvent(pluginId, event, payload);
      if (event === 'log' && payload && (payload.level === 'error' || payload.level === 'warn')) {
        console.warn(`[plugin:${pluginId}] ${payload.message}`);
      }
    };
    this.runtimes.onExit = (pluginId, code) => {
      const record = this.registry.getPlugin(pluginId);
      if (!record) return;
      const crashes = (record.state.crashes || 0) + 1;
      this.registry.updatePlugin(pluginId, { runtimeAlive: false });
      const registry = store.readRegistry();
      store.setPluginState(registry, pluginId, { crashes });
      if (crashes >= RUNTIME_LIMITS.maxCrashes) {
        store.setPluginState(registry, pluginId, {
          quarantined: true,
          quarantineReason: `连续 ${crashes} 次异常退出（最后一次 code=${code}）`,
        });
        this.registry.updatePlugin(pluginId, { status: 'quarantined', error: '连续崩溃，已隔离' });
        store.audit('crash', pluginId, { code, quarantined: true });
      } else {
        store.audit('crash', pluginId, { code });
      }
      store.writeRegistry(registry);
      this._notify();
    };
  }

  // ------------------------------------------------------------ 初始化
  init(options = {}) {
    if (this.initialized) return this;
    this.mainWindowGetter = options.getMainWindow || (() => null);
    this._locale = options.locale || 'zh-CN';

    const p = store.ensureDirs();
    this._pluginsDir = p.plugins;

    this.loadAll();

    this.ipc = ipcFacade.registerPluginHostIpc(this, { probe: this.probe });
    this._changeDisposable = this.registry.onDidChange(() => {
      ipcFacade.broadcastSnapshot(this);
      if (this._menuDirtyHandler) {
        try { this._menuDirtyHandler(); } catch (err) { console.warn('[plugins] menu rebuild failed:', err && err.message); }
      }
    });

    this.initialized = true;
    return this;
  }

  /** windowManager 注册重建菜单的回调（避免两边循环 require）。 */
  setMenuDirtyHandler(fn) {
    this._menuDirtyHandler = fn;
  }

  getMenuFragment() {
    if (!this.initialized) return null;
    return buildPluginsMenu({
      registry: this.registry,
      runCommand: (id) => { this.runCommand(id, {}).then((r) => { if (r && r.ok === false) this._reportCommandError(r); }); },
      openPanel: (pluginId, panelId) => this.openPanel(pluginId, panelId),
      openManager: (opts) => this.openManagerWindow(opts),
      installFromFile: () => this._installViaDialog(),
      reloadAll: () => this.reloadAll({ reason: 'menu' }),
      openFolder: () => this.openPluginsFolder(),
      openLog: () => { this.openManagerWindow({ tab: 'log' }); },
    });
  }

  /**
   * 打开插件面板：把 URL 算好后下发给主窗口，由渲染层挂 iframe。
   *
   * 面板的 entry 路径只在主进程可见（manifest 由主进程读、主进程校验），
   * 渲染层拿到的永远是一个已经成型的 `plugin://` URL —— 少一层"信任渲染层
   * 拼的路径"的风险。
   */
  openPanel(pluginId, panelId) {
    const key = `${pluginId}.${panelId}`;
    const panel = this.registry.get('panel', key);
    const record = this.registry.getPlugin(pluginId);
    if (!panel || !record || record.status !== 'loaded') {
      return { ok: false, error: `面板未注册：${key}` };
    }
    const url = panelUrl(pluginId, panel.entry, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    const sent = ipcFacade.requestOpenPanel(this.mainWindowGetter(), {
      pluginId,
      panelId,
      title: panel.title,
      width: panel.width,
      url,
    });
    if (!sent) return { ok: false, error: '主窗口不可用' };
    store.audit('panel-open', pluginId, { panelId });
    return { ok: true, url };
  }

  _reportCommandError(result) {
    const win = this.mainWindowGetter();
    const message = (result && result.error && result.error.message) || '插件命令执行失败';
    try {
      if (win && !win.isDestroyed()) {
        dialog.showMessageBox(win, { type: 'error', message: '插件命令执行失败', detail: message });
      }
    } catch (_) { /* ignore */ }
  }

  // ------------------------------------------------------------ 加载
  /**
   * 扫描并加载所有 v2 插件。v1（歌声后端）由 legacy pluginHost 处理，这里跳过 ——
   * 两套注册表同时接管同一批目录会产生"同一插件出现两次"的诡异现象。
   */
  loadAll() {
    const records = installer.scanPlugins();
    const registry = store.readRegistry();

    for (const item of records) {
      if (!item.manifest) {
        if (item.error) console.warn(`[plugins] ${item.dirName}: ${item.error}`);
        continue;
      }
      if (isLegacyManifest(item.manifest)) continue;

      const checked = validateManifest(item.manifest, {
        dirName: item.dirName,
        appVersion: app.getVersion(),
      });
      if (!checked.ok) {
        console.warn(`[plugins] ${item.dirName}: ${checked.error}`);
        continue;
      }

      const state = store.getPluginState(registry, checked.value.id);
      const record = this.registry.addPlugin({
        id: checked.value.id,
        manifest: checked.value,
        dir: item.dir,
        state,
      });
      this._pluginDirs.set(checked.value.id, item.dir);

      if (state.quarantined) {
        this.registry.updatePlugin(record.id, { status: 'quarantined', error: state.quarantineReason });
        continue;
      }
      if (!state.enabled) {
        this.registry.updatePlugin(record.id, { status: 'disabled' });
        continue;
      }

      this._registerContributions(record);
    }

    store.writeRegistry(registry);
    return this.registry.stats();
  }

  _registerContributions(record) {
    const { manifest } = record;
    const c = manifest.contributes;

    for (const cmd of c.commands) {
      this.registry.register('command', cmd.id, { ...cmd, pluginId: record.id });
    }
    for (const [index, menu] of c.menus.entries()) {
      this.registry.register('menu', `${record.id}:${index}`, { ...menu, pluginId: record.id, index });
    }
    for (const panel of c.panels) {
      this.registry.register('panel', panel.id, { ...panel, pluginId: record.id });
    }
    for (const fileType of c.fileTypes) {
      this.registry.register('fileType', `${record.id}:${fileType.ext}`, { ...fileType, pluginId: record.id });
    }
    for (const section of c.settings) {
      this.registry.register('setting', section.id, { ...section, pluginId: record.id });
    }
    for (const hook of c.pipeline) {
      this.registry.register('hook', `${record.id}:${hook.stage}:${hook.order}`, { ...hook, pluginId: record.id });
    }
  }

  // ------------------------------------------------------------ 查询
  getPluginsDir() {
    return this._pluginsDir || store.ensureDirs().plugins;
  }

  getMainWindow() {
    return this.mainWindowGetter();
  }

  snapshot() {
    return this.registry.snapshot();
  }

  adminSnapshot() {
    return {
      ...this.registry.adminSnapshot(),
      pluginsDir: this.getPluginsDir(),
      appVersion: app.getVersion(),
      runtimes: this.runtimes.list(),
      pendingProjectApply: ipcFacade.pendingProjectApplyCount(),
    };
  }

  getLog(limit) {
    return store.readAudit(Math.max(1, Math.min(1000, Number(limit) || 200)));
  }

  // ------------------------------------------------------------ 安装 / 卸载
  async _installViaDialog() {
    const win = this.mainWindowGetter();
    const { dialog: d } = require('electron');
    const picked = await d.showOpenDialog(win && !win.isDestroyed() ? win : null, {
      title: 'Install Plugin',
      properties: ['openFile'],
      filters: [{ name: 'SXSEditor Plugin', extensions: ['sxsp'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    return this.installFromPackage(picked.filePaths[0]);
  }

  async installFromPackage(filePath) {
    // 审计由 PluginInstaller 写（它更清楚是 folder 还是 package 来源），
    // 这里不再重复记一条，否则管理器日志里每次安装都是两行。
    const result = installer.installFromPackage(filePath, { appVersion: app.getVersion() });
    if (!result.ok) return result;
    await this.reloadAll({ reason: 'install' });
    return result;
  }

  /**
   * 卸载：先拆运行时与 UI，再删文件。任一步失败都不回滚删除（文件是最后一步）。
   */
  async uninstall(id, options = {}) {
    const record = this.registry.getPlugin(id);
    if (!record) return { ok: false, error: `未安装：${id}` };

    const before = await this.probe.snapshot(id);

    // 1. 撤 UI 与菜单：registry.removePlugin 会触发 _notify → renderer 重新投影 + 菜单重建
    const removedContribs = this.registry.removePlugin(id);
    this._pluginDirs.delete(id);

    // 2. 停运行时
    await this.runtimes.stop(id);

    // 3. 删文件
    const removed = installer.uninstall(id, { keepData: !!options.keepData });

    // 4. 断言（失败只记录：此时内存与磁盘都已干净，计数偏差来自异步回收）
    try {
      const verdict = await this.probe.assertClean(before, id);
      if (!verdict.ok) {
        store.audit('leak', id, verdict.deltas);
        const registry = store.readRegistry();
        const state = store.getPluginState(registry, id);
        // 已卸载，state 里不会有该条目；泄漏只在日志中留痕
        void state;
      }
    } catch (err) {
      console.warn('[plugins] leak probe failed:', err && err.message);
    }

    this._notify();
    return { ok: true, removedContributions: removedContribs, removedDir: removed.removedDir };
  }

  async setEnabled(id, enabled) {
    const record = this.registry.getPlugin(id);
    if (!record) return { ok: false, error: `未安装：${id}` };

    const registry = store.readRegistry();
    store.setPluginState(registry, id, { enabled });
    store.writeRegistry(registry);

    if (!enabled) {
      await this.runtimes.stop(id);
      // 停用只撤贡献、保留记录 —— 记录一删，管理器里就没这条了，用户无法再启用。
      this.registry.removeContributions(id);
      this.registry.updatePlugin(id, { status: 'disabled', runtimeAlive: false, error: '' });
    } else {
      await this.reloadAll({ reason: 'enable' });
    }
    this._notify();
    return { ok: true, enabled };
  }

  /**
   * 重载全部：杀进程 → 清注册表 → 重新扫描。
   * 不做热替换：require 缓存、闭包、定时器都不可靠，重建进程是最便宜的正确性。
   */
  async reloadAll(options = {}) {
    await this.runtimes.stopAll();
    for (const record of this.registry.listPlugins()) {
      this.registry.removePlugin(record.id);
    }
    this._pluginDirs.clear();
    this.loadAll();
    store.audit('reload', null, { reason: (options && options.reason) || 'manual' });
    this._notify();
    return { ok: true, stats: this.registry.stats() };
  }

  // ------------------------------------------------------------ 命令与面板
  async runCommand(commandId, args) {
    const cmd = this.registry.findCommand(commandId);
    if (!cmd) return { ok: false, error: { code: ERR.NOT_FOUND, message: `未知命令：${commandId}` } };
    try {
      const result = await this._call(cmd.pluginId, 'command.run', {
        commandId: cmd.localId,
        args: args || {},
      }, TIMEOUTS.command);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: { code: err.code || ERR.INTERNAL, message: err.message } };
    }
  }

  /**
   * iframe 面板的 RPC 入口。method 必须在该面板声明的 apiScopes 里 ——
   * 这是面板之间、面板与宿主之间的最小权限边界。
   */
  async panelRpc(request) {
    const { pluginId, panelId, method, params } = request || {};
    const panel = pluginId ? this.registry.get('panel', `${pluginId}.${panelId}`) : null;
    if (!panel) return { ok: false, error: { code: ERR.NOT_FOUND, message: '面板未注册' } };
    if (!panel.apiScopes.includes(method)) {
      return { ok: false, error: { code: ERR.PERMISSION_DENIED, message: `面板未申请能力：${method}` } };
    }
    try {
      const result = await this._call(pluginId, 'panel.rpc', { panelId, method, params: params || {} }, TIMEOUTS.panelRpc);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: { code: err.code || ERR.INTERNAL, message: err.message } };
    }
  }

  async _call(pluginId, method, params, timeoutMs) {
    const record = this.registry.getPlugin(pluginId);
    if (!record) throw Object.assign(new Error(`插件未加载：${pluginId}`), { code: ERR.NOT_FOUND });
    if (record.status !== 'loaded') {
      throw Object.assign(new Error(`插件状态为 ${record.status}`), { code: ERR.PLUGIN_QUARANTINED });
    }
    await this._ensureRuntime(pluginId);
    return this.runtimes.call(pluginId, method, params, { timeoutMs });
  }

  async _ensureRuntime(pluginId) {
    if (this.runtimes.isAlive(pluginId)) return;
    const record = this.registry.getPlugin(pluginId);
    if (!record) throw Object.assign(new Error(`插件未加载：${pluginId}`), { code: ERR.NOT_FOUND });

    const live = this.runtimes.list().length;
    if (live >= RUNTIME_LIMITS.maxLiveRuntimes) {
      // 超出上限时回收最久未使用的那个（M1 简化：按 id 顺序，后续接 LRU）
      const victim = this.runtimes.list()[0];
      if (victim) await this.runtimes.stop(victim.id);
    }

    const dataDir = installer.ensureDataDir(pluginId);
    await this.runtimes.start({
      id: pluginId,
      name: record.manifest.name,
      version: record.manifest.version,
      dir: record.dir,
      dataDir,
      entry: record.manifest.main,
      locale: this._locale,
      permissions: record.manifest.permissions,
      capabilities: {
        deviceId: undefined,
        hardware: this._hardwareSnapshot(),
      },
    });
    this.registry.updatePlugin(pluginId, { runtimeAlive: true });
    this._notify();
  }

  _hardwareSnapshot() {
    try {
      const { loadSettings } = require('../settings');
      const s = loadSettings() || {};
      const os = require('node:os');
      return {
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
        totalMemGb: Math.round(os.totalmem() / 1024 ** 3),
        deviceMode: s.deviceMode || 'smart',
        modelPrecision: s.modelPrecision || 'fp16',
        gpuDeviceName: s.gpuDeviceName || '',
        appVersion: app.getVersion(),
      };
    } catch (_) {
      return { platform: process.platform, arch: process.arch, appVersion: app.getVersion() };
    }
  }

  // ------------------------------------------------------------ 宿主能力
  /**
   * runtime 反向调用宿主。返回前必须完成权限判定 —— 这是 project:write 的唯一闸门。
   */
  async _handleHostCall(pluginId, method, params) {
    const record = this.registry.getPlugin(pluginId);
    if (!record) throw Object.assign(new Error('插件未加载'), { code: ERR.NOT_FOUND });
    const perms = record.manifest.permissions;

    switch (method) {
      case 'project.read': {
        if (!(perms.project || []).includes('read')) {
          throw Object.assign(new Error('缺少权限 project:read'), { code: ERR.PERMISSION_DENIED });
        }
        // 同一条往返通道，`operations === null` 表示"只要快照，不写"。
        // 复用一条通道的理由：渲染层只需要实现一个处理器，就不会出现
        // "读走了 apply 通道、写走了 read 通道"这类接线错误。
        const result = await ipcFacade.requestProjectApply(this.mainWindowGetter(), `plugin:${pluginId}:read:${Date.now()}`, null);
        return result;
      }
      case 'project.apply': {
        if (!(perms.project || []).includes('write')) {
          throw Object.assign(new Error('缺少权限 project:write'), { code: ERR.PERMISSION_DENIED });
        }
        const ops = Array.isArray(params && params.operations) ? params.operations : [];
        if (!ops.length) throw new Error('operations 为空');
        if (ops.length > 500) throw new Error('单次最多 500 个操作');
        return ipcFacade.requestProjectApply(this.mainWindowGetter(), `plugin:${pluginId}:apply:${Date.now()}`, ops, 60000);
      }
      case 'ui.notify': {
        const payload = params || {};
        ipcFacade.broadcastEvent(pluginId, 'notify', {
          message: String(payload.message || '').slice(0, 500),
          level: payload.level === 'error' || payload.level === 'warn' ? payload.level : 'info',
        });
        return { ok: true };
      }
      default:
        throw Object.assign(new Error(`未实现宿主能力：${method}`), { code: ERR.UNSUPPORTED });
    }
  }

  resolveProjectApply(payload) {
    return ipcFacade.settleProjectApply(payload);
  }

  // ------------------------------------------------------------ 窗口
  openManagerWindow(options = {}) {
    try {
      const { openPluginManagerWindow } = require('../windowManager');
      openPluginManagerWindow(options);
    } catch (err) {
      console.warn('[plugins] 打开管理器失败:', err && err.message);
    }
  }

  openPluginsFolder() {
    const { shell } = require('electron');
    shell.openPath(this.getPluginsDir());
  }

  /** 面板 URL 解析：只有已加载插件才允许被 plugin:// 读取。 */
  resolvePluginDir(id) {
    const record = this.registry.getPlugin(id);
    if (!record || record.status !== 'loaded') return null;
    return record.dir;
  }

  getPanel(pluginId, panelId) {
    return this.registry.get('panel', `${pluginId}.${panelId}`);
  }

  // ------------------------------------------------------------ 退出
  async disposeAll() {
    if (!this.initialized) return;
    const t0 = Date.now();
    try {
      await this.runtimes.stopAll();
    } catch (err) {
      console.warn('[plugins] 停止运行时失败:', err && err.message);
    }
    if (this.ipc) {
      try { this.ipc.dispose(); } catch (_) { /* ignore */ }
      this.ipc = null;
    }
    if (this._changeDisposable) {
      this._changeDisposable.dispose();
      this._changeDisposable = null;
    }
    for (const record of this.registry.listPlugins()) {
      this.registry.removePlugin(record.id);
    }
    this.initialized = false;
    store.audit('shutdown', null, { ms: Date.now() - t0 });
  }

  _notify() {
    // registry 的变更已经会触发 onDidChange；这里只处理"状态变化但贡献没变"的情况
    if (!this._changeDisposable) return;
    ipcFacade.broadcastSnapshot(this);
  }
}

let _instance = null;
function getPluginService() {
  if (!_instance) _instance = new PluginService();
  return _instance;
}

module.exports = { PluginService, getPluginService };
