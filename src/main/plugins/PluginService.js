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
const { app, dialog, BrowserWindow, Menu } = require('electron');
const { getLocale } = require('../locale');

const { TIMEOUTS, ERR, RUNTIME_LIMITS } = require('../../shared/pluginApi.js');
const { validateManifest, isLegacyManifest } = require('../../shared/pluginManifest.js');
const { PluginRegistry } = require('./PluginRegistry.js');
const { PluginRuntimeManager } = require('./PluginRuntimeManager.js');
const { PluginLeakProbe } = require('./PluginLeakProbe.js');
const { evaluateKeybindings, collectMenuChords } = require('./PluginKeybindings.js');
const installer = require('./PluginInstaller.js');
const store = require('./PluginStateStore.js');
const ipcFacade = require('./PluginIpcV2.js');
const { buildPluginsMenu, pickTitle } = require('./PluginMenu.js');
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
    /**
     * 插件通过 `ui.status` 覆盖的状态栏文案（itemId → text）。
     * 不落盘：状态栏表达的是"这次运行时的进展"，重启后应回到 manifest 里声明的静态文案。
     */
    this._statusText = new Map();

    this.runtimes.onEvent = (pluginId, event, payload) => {
      ipcFacade.broadcastEvent(pluginId, event, payload);
      if (event === 'log' && payload && (payload.level === 'error' || payload.level === 'warn')) {
        console.warn(`[plugin:${pluginId}] ${payload.message}`);
      }
    };
    this.runtimes.onExit = (pluginId, code) => {
      const record = this.registry.getPlugin(pluginId);
      if (!record) return;
      // 崩溃次数必须从落盘状态读：record.state 是 addPlugin 时的快照，整个生命周期
      // 不会变。之前用它累加，每次崩溃都算出 1，maxCrashes 的隔离阈值永远够不到。
      const registry = store.readRegistry();
      const persisted = store.getPluginState(registry, pluginId);
      const crashes = (persisted.crashes || 0) + 1;
      this.registry.updatePlugin(pluginId, {
        runtimeAlive: false,
        state: { ...(record.state || {}), crashes },
      });
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
    // 模型调用面（可选）：没接的时候插件调 models.* 会得到 UNSUPPORTED，
    // 而不是一个空指针崩溃 —— 单测与精简构建不必为了跑插件系统起整套网关。
    this.models = options.models || null;
    if (this.models) {
      // 惰性取：插件什么时候被停用/卸载都不是这里说了算，缓存一份必然过期。
      this.models.setPreferenceSource(() => this._collectModelPreferences());
    }

    const p = store.ensureDirs();
    this._pluginsDir = p.plugins;

    this.loadAll();

    this.ipc = ipcFacade.registerPluginHostIpc(this, { probe: this.probe });
    // 窗口就绪 → 补发一次投影（冷启动竞态，见 pushSnapshotOnWindowLoad 注释）
    this._pushDisposable = ipcFacade.pushSnapshotOnWindowLoad(this);
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

  /**
   * 汇总各插件在 `contributes.models.preferred` 里标的 ★。
   *
   * 只用于设置页展示，**不参与路由**：插件不知道用户装了哪些端点，也没资格替用户
   * 决定用哪个。条目可以按 `endpoint`（精确）或 `provider`（同厂商任意端点）指定，
   * 后者是插件唯一能合理预判的东西。
   */
  _collectModelPreferences() {
    const out = [];
    for (const record of this.registry.listPlugins()) {
      // 'loaded' 是正常启用态；'disabled' / 'quarantined' 的插件不该再影响界面。
      if (record.status !== 'loaded' && record.status !== 'degraded') continue;
      const declared = record.manifest && record.manifest.contributes && record.manifest.contributes.models;
      const list = declared && Array.isArray(declared.preferred) ? declared.preferred : [];
      for (const p of list) {
        out.push({
          pluginId: record.id,
          task: p.task,
          endpoint: p.endpoint || null,
          provider: p.provider || null,
          note: p.note || '',
        });
      }
    }
    return out;
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
      // manifest 里的 title 是 { en, 'zh-CN' } 对象；渲染层只会把它塞进
      // textContent，拿不到也不该拿语言表，所以在边界处就解析成字符串。
      title: pickTitle(panel.title, getLocale()),
      width: panel.width,
      url,
    });
    if (!sent) return { ok: false, error: '主窗口不可用' };
    store.audit('panel-open', pluginId, { panelId });
    return { ok: true, url };
  }

  /** 撤掉某插件在状态栏上的运行时文案（停用/卸载/重载都要调）。 */
  _clearStatusText(pluginId) {
    for (const key of [...this._statusText.keys()]) {
      if (key.startsWith(`${pluginId}.`)) this._statusText.delete(key);
    }
  }

  _reportCommandError(result) {    const win = this.mainWindowGetter();
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

    // ---- M2 界面贡献点 ----
    // 每类单独一张表，键都用全局 id；卸载时 removeContributions 按 pluginId 一扫而空，
    // 插件即使不配合也留不下东西。
    for (const item of c.toolbar) {
      this.registry.register('toolbar', item.id, { ...item, pluginId: record.id });
    }
    for (const item of c.statusBar) {
      this.registry.register('statusBar', item.id, { ...item, pluginId: record.id });
    }
    for (const item of c.contextMenus) {
      this.registry.register('contextMenu', item.id, { ...item, pluginId: record.id });
    }
    for (const item of c.timelineOverlays) {
      this.registry.register('overlay', item.id, { ...item, pluginId: record.id });
    }
    for (const item of c.keybindings) {
      this.registry.register('keybinding', item.id, { ...item, pluginId: record.id });
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
    return this.registry.snapshot(this._contributionExtras());
  }

  adminSnapshot() {
    const extras = this._contributionExtras();
    // 管理器需要"为什么这条组合不生效"，所以 admin 里给完整仲裁结果而不是只给生效项
    const byPlugin = new Map();
    for (const binding of extras.bindings) {
      if (!byPlugin.has(binding.pluginId)) byPlugin.set(binding.pluginId, []);
      byPlugin.get(binding.pluginId).push(binding);
    }
    return {
      ...this.registry.adminSnapshot({ keybindings: byPlugin }),
      pluginsDir: this.getPluginsDir(),
      appVersion: app.getVersion(),
      runtimes: this.runtimes.list(),
      pendingProjectApply: ipcFacade.pendingProjectApplyCount(),
    };
  }

  /**
   * 投影用的派生数据：快捷键仲裁结果 + 状态栏运行时文案。
   *
   * 宿主快捷键每次重新收集：菜单会随插件安装/卸载重建，缓存下来就会漏掉
   * "插件装完之前不存在的 accelerator"。
   */
  _contributionExtras() {
    let hostChords = null;
    try {
      hostChords = collectMenuChords(Menu.getApplicationMenu());
    } catch (_) {
      hostChords = new Set();
    }
    const registryState = store.readRegistry();
    const enabled = (pluginId) => !!store.getPluginState(registryState, pluginId).keybindingsEnabled;
    const result = evaluateKeybindings({
      registry: this.registry,
      isEnabled: enabled,
      hostChords,
    });
    const byPlugin = new Map();
    for (const binding of result.bindings) {
      if (!byPlugin.has(binding.pluginId)) byPlugin.set(binding.pluginId, []);
      // 投影只给渲染层要用的字段；reason/conflictWith 只对管理器有意义
      byPlugin.get(binding.pluginId).push({
        chord: binding.chord,
        command: binding.command,
        when: binding.when,
        status: binding.status === 'candidate' ? 'active' : binding.status,
      });
    }
    return { keybindings: byPlugin, bindings: result.bindings, statusText: this._statusText };
  }

  getLog(limit) {
    return store.readAudit(Math.max(1, Math.min(1000, Number(limit) || 200)));
  }

  // ------------------------------------------------------------ M2：界面贡献点
  /**
   * 设置页需要的"当前值"：manifest 里的 default 叠加用户改过的值。
   * 只返回 schema 里声明过的键 —— 用户不该看到一个插件自己都没定义过的设置项。
   */
  getSettings(pluginId) {
    const record = this.registry.getPlugin(pluginId);
    if (!record) return { ok: false, error: `未安装：${pluginId}` };
    const registry = store.readRegistry();
    const state = store.getPluginState(registry, pluginId);
    const values = {};
    for (const section of record.manifest.contributes.settings) {
      for (const field of section.fields) {
        values[field.key] = Object.prototype.hasOwnProperty.call(state.settings, field.key)
          ? state.settings[field.key]
          : field.default;
      }
    }
    return { ok: true, values };
  }

  /**
   * 写入设置。按 schema 做类型收敛（而不是信渲染层传来的任何东西），
   * 落盘后再通知 runtime —— 插件可以在自己进程里监听 `settings.changed`。
   */
  setSettings(pluginId, patch) {
    const record = this.registry.getPlugin(pluginId);
    if (!record) return { ok: false, error: `未安装：${pluginId}` };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'patch 必须是对象' };
    }
    const fields = new Map();
    for (const section of record.manifest.contributes.settings) {
      for (const field of section.fields) fields.set(field.key, field);
    }
    const next = {};
    for (const [key, raw] of Object.entries(patch)) {
      const field = fields.get(key);
      if (!field) return { ok: false, error: `未声明的设置项：${key}` };
      next[key] = this._coerceField(field, raw);
    }

    const registry = store.readRegistry();
    const state = store.getPluginState(registry, pluginId);
    store.setPluginState(registry, pluginId, { settings: { ...state.settings, ...next } });
    store.writeRegistry(registry);

    // 运行中的插件需要知道配置变了；没在跑就等它下次启动读设置快照。
    // 用事件而不是请求：插件没监听设置变化是合法的，不该因此报超时。
    this.runtimes.sendEvent(pluginId, 'settings.changed', { values: { ...state.settings, ...next } });
    return { ok: true, values: next };
  }

  _coerceField(field, raw) {
    switch (field.type) {
      case 'boolean':
        return raw === true;
      case 'number': {
        let value = Number(raw);
        if (!Number.isFinite(value)) value = field.default;
        if (field.min !== null) value = Math.max(field.min, value);
        if (field.max !== null) value = Math.min(field.max, value);
        return value;
      }
      case 'select':
        return field.options.some((opt) => opt.value === raw) ? raw : field.default;
      default:
        return typeof raw === 'string' ? raw.slice(0, 2000) : String(raw ?? '').slice(0, 2000);
    }
  }

  /** 用户是否为该插件启用快捷键（默认关闭）。 */
  setKeybindingsEnabled(pluginId, enabled) {
    const record = this.registry.getPlugin(pluginId);
    if (!record) return { ok: false, error: `未安装：${pluginId}` };
    const registry = store.readRegistry();
    store.setPluginState(registry, pluginId, { keybindingsEnabled: !!enabled });
    store.writeRegistry(registry);
    this.registry.updatePlugin(pluginId, { state: { ...(record.state || {}), keybindingsEnabled: !!enabled } });
    store.audit('keybindings', pluginId, { enabled: !!enabled });
    // 注册表内容没变，但投影里的 keybindings[].status 变了 → 必须主动推一次
    ipcFacade.broadcastSnapshot(this);
    return { ok: true, enabled: !!enabled };
  }

  /**
   * 时间轴浮层的 iframe 地址。与面板同一条 mint 逻辑：entry 只在主进程可见，
   * 渲染层拿到的永远是成型 URL；每次挂载换 nonce，旧 URL 不会长期有效。
   */
  overlayUrl(pluginId, overlayId) {
    const record = this.registry.getPlugin(pluginId);
    const overlay = this.registry.get('overlay', `${pluginId}.${overlayId}`);
    if (!record || record.status !== 'loaded' || !overlay) {
      return { ok: false, error: `浮层未注册：${pluginId}.${overlayId}` };
    }
    return {
      ok: true,
      url: panelUrl(pluginId, overlay.entry, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`),
    };
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
    this._clearStatusText(id);

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
    return {
      ok: true,
      removedContributions: removedContribs,
      removedDir: removed.removedDir,
      // 文件被占用时目录可能还在；界面据此提示"重启后自动清理"，而不是假装干净
      fileError: removed.fileError,
    };
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
      this._clearStatusText(id);
      this.registry.updatePlugin(id, {
        status: 'disabled',
        runtimeAlive: false,
        error: '',
        // 记录里的 state 是扫描时读的副本，不跟着改的话管理器仍以 enabled:true
        // 判断，按钮会一直显示"停用"，用户再也点不回"启用"。
        state: { ...(record.state || {}), enabled: false },
      });
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
    this._statusText.clear();
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
      const result = await this._call(
        pluginId, 'panel.rpc', { panelId, method, params: params || {} },
        panel.timeoutMs || TIMEOUTS.panelRpc,
      );
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
    const persisted = store.getPluginState(store.readRegistry(), pluginId);
    await this.runtimes.start({
      id: pluginId,
      name: record.manifest.name,
      version: record.manifest.version,
      dir: record.dir,
      dataDir,
      entry: record.manifest.main,
      locale: this._locale,
      permissions: record.manifest.permissions,
      // 启动快照：插件在 initialize() 里就能读到用户配置，不必先等一次事件
      settings: persisted.settings || {},
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
        const result = await ipcFacade.requestProjectApply(
          this.mainWindowGetter(), ipcFacade.nextProjectApplyId(pluginId, 'read'), null,
        );
        return result;
      }
      case 'project.apply': {
        if (!(perms.project || []).includes('write')) {
          throw Object.assign(new Error('缺少权限 project:write'), { code: ERR.PERMISSION_DENIED });
        }
        const ops = Array.isArray(params && params.operations) ? params.operations : [];
        if (!ops.length) throw new Error('operations 为空');
        if (ops.length > 500) throw new Error('单次最多 500 个操作');
        return ipcFacade.requestProjectApply(
          this.mainWindowGetter(), ipcFacade.nextProjectApplyId(pluginId, 'apply'), ops, 60000,
        );
      }
      case 'ui.notify': {
        const payload = params || {};
        ipcFacade.broadcastEvent(pluginId, 'notify', {
          message: String(payload.message || '').slice(0, 500),
          level: payload.level === 'error' || payload.level === 'warn' ? payload.level : 'info',
        });
        return { ok: true };
      }
      case 'models.list': {
        if (!(perms.models || []).includes('consume')) {
          throw Object.assign(new Error('缺少权限 models:consume'), { code: ERR.PERMISSION_DENIED });
        }
        if (!this.models) throw Object.assign(new Error('模型服务未启用'), { code: ERR.UNSUPPORTED });
        return this.models.list(`plugin:${pluginId}`, { task: params && params.task });
      }
      case 'models.invoke': {
        if (!(perms.models || []).includes('consume')) {
          throw Object.assign(new Error('缺少权限 models:consume'), { code: ERR.PERMISSION_DENIED });
        }
        if (!this.models) throw Object.assign(new Error('模型服务未启用'), { code: ERR.UNSUPPORTED });
        const payload = params || {};
        const streamKey = String(payload.streamKey || '');
        if (!streamKey) throw Object.assign(new Error('缺少 streamKey'), { code: ERR.INVALID_REQUEST });
        // 事件不在这里推：ModelService 的 eventSink 统一按 subject 路由，否则
        // 插件会收到两份（这里一份、sink 一份），表现为每个 chunk 都重复。
        const r = this.models.invoke(`plugin:${pluginId}`, payload, {
          via: 'plugin',
          streamKey,
        });
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return { handleId: r.handleId };
      }
      case 'models.cancel': {
        if (!this.models) throw Object.assign(new Error('模型服务未启用'), { code: ERR.UNSUPPORTED });
        return this.models.cancel(`plugin:${pluginId}`, String((params && params.handleId) || ''));
      }
      case 'models.ack': {
        if (!this.models) throw Object.assign(new Error('模型服务未启用'), { code: ERR.UNSUPPORTED });
        return this.models.ack(`plugin:${pluginId}`, String((params && params.handleId) || ''), (params && params.bytes) || 0);
      }
      case 'ui.status': {
        // 状态栏文案由插件自己更新（"已处理 3/10"）。只允许改自己声明的条目：
        // 否则一个插件能把另一个插件的状态栏改成任意文字。
        const payload = params || {};
        const itemId = `${pluginId}.${String(payload.itemId || '')}`;
        if (!this.registry.get('statusBar', itemId)) {
          throw Object.assign(new Error(`未声明的状态栏条目：${payload.itemId}`), { code: ERR.NOT_FOUND });
        }
        const text = String(payload.text ?? '').slice(0, 160);
        if (text) this._statusText.set(itemId, text);
        else this._statusText.delete(itemId);
        ipcFacade.broadcastSnapshot(this);
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
    if (this._pushDisposable) {
      this._pushDisposable();
      this._pushDisposable = null;
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
