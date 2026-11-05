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
const trustStore = require('./PluginTrustStore.js');
const store = require('./PluginStateStore.js');
const ipcFacade = require('./PluginIpcV2.js');
const { buildPluginsMenu, pickTitle } = require('./PluginMenu.js');
const { panelUrl } = require('./PluginProtocol.js');
const { PipelineHooks } = require('./PipelineHooks.js');
const { PluginDataPlane } = require('./PluginDataPlane.js');
const { PluginSecrets } = require('./PluginSecrets.js');
const { buildAutomationDef } = require('../../shared/pluginAutomation.js');
const { resolveService, findCycles, MAX_CALL_DEPTH, SERVICE_ERR } = require('../../shared/pluginServices.js');

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
    /**
     * 跨插件服务的调用计数（不落盘）。
     *
     * 为什么不像自动化方法那样每次调用都写审计：服务调用是插件之间的内部流量，
     * 可能一秒几十次（每一帧都比一次），写进 jsonl 只会把真正要看的事件冲掉。
     * 失败与拒绝仍然写审计 —— 那些是低频且必须留痕的。这份计数给管理器看
     * "谁在调谁、调了多少次、慢不慢"，够用。
     */
    this._serviceStats = new Map();
    /** 依赖缺失导致的 degraded（重算时要能撤回，不能把别人的 degraded 覆盖掉）。 */
    this._serviceDegraded = new Set();
    /** 依赖环（只报告，不拒绝加载，见 pluginServices.js 的说明）。 */
    this._serviceCycles = [];

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

    // 密钥：每个插件一个文件，宿主只负责存放与权限门。
    // safeStorage 在 Linux 无 keyring 时会报"不可用"，PluginSecrets 会如实带出
    // encrypted:false —— 这里不拦，拦了插件就只能把 token 写进自己的 state.json。
    this.secrets = new PluginSecrets({
      dir: p.data,
      safeStorage: safeStorageOrNull(),
      logger: console,
    });

    // 数据面：文件 → 插件 codec → 工程文档。构造在这里、用在这里，
    // 但它依赖的 registry 在构造期就有了，所以不涉及初始化顺序问题。
    this.dataPlane = new PluginDataPlane({
      service: this,
      registry: this.registry,
      call: (id, method, params, timeoutMs) => this._call(id, method, params, timeoutMs),
      logger: console,
      locale: () => this._locale,
    });

    this.loadAll();
    // 插件加载完才有 fileTypes 可注入；投递链路（fileAssociation）一直在等这份快照
    this._syncFileAssociations();

    this.ipc = ipcFacade.registerPluginHostIpc(this, { probe: this.probe });
    // 窗口就绪 → 补发一次投影（冷启动竞态，见 pushSnapshotOnWindowLoad 注释）
    this._pushDisposable = ipcFacade.pushSnapshotOnWindowLoad(this);
    this._changeDisposable = this.registry.onDidChange(() => {
      ipcFacade.broadcastSnapshot(this);
      // 插件重载会换代码：熔断过的 hook 该再给一次机会
      if (this.pipelineHooks) this.pipelineHooks.reset();
      // 装了/卸了/停用了插件，能双击打开的扩展名就变了
      this._syncFileAssociations();
      if (this._menuDirtyHandler) {
        try { this._menuDirtyHandler(); } catch (err) { console.warn('[plugins] menu rebuild failed:', err && err.message); }
      }
    });

    // pipeline hook 执行器：管线通过 setPipelineHookRunner 拿到它的 run 方法。
    // 放在 registry 建好之后，构造期不需要 this.registry 存在。
    this.pipelineHooks = new PipelineHooks({ service: this, logger: console });

    this.initialized = true;
    return this;
  }

  /** windowManager 注册重建菜单的回调（避免两边循环 require）。 */
  setMenuDirtyHandler(fn) {
    this._menuDirtyHandler = fn;
  }

  /**
   * 把插件声明的扩展名推给投递链路。
   *
   * 推的是"快照"而不是让 fileAssociation 反过来 require 本模块：后者会在
   * main.js 顶层形成环（fileAssociation → PluginService → ... → fileAssociation）。
   * 而且投递链路要能在任意时刻 O(1) 回答"认不认识这个扩展名"，拿快照最直接。
   */
  _syncFileAssociations() {
    if (!this.dataPlane) return;
    try {
      const { setPluginFileTypes, syncWindowsPluginFileAssociations } = require('../fileAssociation');
      setPluginFileTypes(this.dataPlane.listFileTypes().map((ft) => ({
        ext: ft.ext,
        pluginId: ft.pluginId,
        label: pickTitle(ft.label, this._locale)
          || `${ft.ext.slice(1).toUpperCase()} (${ft.pluginName})`,
      })));
      // 装/卸/停用之后，系统里"哪些扩展名归我"也跟着变了。这个调用在非
      // Windows 或未打包时直接返回 —— 开发机上不该碰注册表。
      syncWindowsPluginFileAssociations().catch((err) => {
        console.warn('[plugins] 同步系统文件关联失败:', err && err.message);
      });
    } catch (err) {
      console.warn('[plugins] 同步文件关联失败:', err && err.message);
    }
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
    // 重载时旧的一轮降级/环必须作废，否则"上一次缺依赖"会一直挂在界面上。
    this._serviceDegraded.clear();
    this._serviceCycles = [];

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

    // 所有插件都进表之后再解析依赖：边注册边解析会让先加载的消费方全部误判。
    this._resolveServiceDependencies();

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
    // 导出器：键带插件 id 前缀，因为 `id` 只在插件内唯一（两个插件都能有 "flac"）
    for (const exporter of c.exporters || []) {
      this.registry.register('exporter', `${record.id}:${exporter.id}`, { ...exporter, pluginId: record.id });
    }
    for (const section of c.settings) {
      this.registry.register('setting', section.id, { ...section, pluginId: record.id });
    }
    for (const hook of c.pipeline) {
      this.registry.register('hook', `${record.id}:${hook.stage}:${hook.order}`, { ...hook, pluginId: record.id });
    }

    // ---- M5：自动化方法 ----
    // 键就是完整命令 id，它同时也是 MCP 方法名（见 pluginAutomation.js 里的
    // 命名规则）。expose=false 的插件一个也不登记 —— 注册表里没有，桥接层就
    // 查不到，方法在自动化面上等于不存在。
    const automation = c.automation || { methods: [], expose: true };
    if (automation.expose !== false) {
      for (const localId of automation.methods) {
        const id = `${record.id}.${localId}`;
        this.registry.register('automation', id, {
          id, method: id, localId, pluginId: record.id,
        });
      }
    }

    // ---- M5：跨插件 service ----
    this._registerServices(record);

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

  /**
   * 注册插件声明的服务端点。
   *
   * **冲突裁决按插件 id 字典序，而不是装得晚的赢。**
   * 宿主无法判断两个 `sv2.codec` 谁更"正确"，但必须给出一个与安装顺序无关的
   * 答案：否则同一份插件集在两台机器上（扫描顺序不同）会解析到不同的实现，
   * 而作者与用户看到的现象完全对不上。字典序没有语义，但它**确定**；
   * 输的一方标 degraded 并写明原因，用户能看见冲突而不是默默用着别人的实现。
   */
  _registerServices(record) {
    const decl = record.manifest.contributes.services;
    const provides = decl && Array.isArray(decl.provides) ? decl.provides : [];
    if (!provides.length) return;

    for (const svc of provides) {
      const existing = this.registry.get('service', svc.id);
      if (existing && existing.pluginId !== record.id) {
        const winnerId = existing.pluginId < record.id ? existing.pluginId : record.id;
        const loserId = winnerId === record.id ? existing.pluginId : record.id;
        store.audit('service-conflict', record.id, {
          service: svc.id, existing: existing.pluginId, winner: winnerId,
        });
        if (loserId === record.id) {
          // 自己输：服务照常由对方提供，但这个插件要能被用户看见"我声明了却没生效"
          this._degrade(record.id, `service '${svc.id}' 已由插件 ${existing.pluginId} 提供（同名冲突）`);
          continue;
        }
        // 自己赢：对方的条目撤掉，换成自己的
        this.registry.unregister('service', svc.id);
        this._degrade(loserId, `service '${svc.id}' 已由插件 ${record.id} 提供（同名冲突）`);
      }
      this.registry.register('service', svc.id, {
        id: svc.id,
        version: svc.version,
        methods: svc.methods,
        description: svc.description,
        pluginId: record.id,
      });
    }
  }

  /** 标记为 degraded（保留原状态语义：quarantined / disabled 不被覆盖）。 */
  _degrade(pluginId, message) {
    const rec = this.registry.getPlugin(pluginId);
    if (!rec) return;
    if (rec.status === 'quarantined' || rec.status === 'disabled') return;
    this._serviceDegraded.add(pluginId);
    this.registry.updatePlugin(pluginId, { status: 'degraded', error: message });
  }

  /**
   * 加载完成后统一解析依赖：缺必需服务 → degraded；有环 → 记录并审计。
   *
   * 为什么不在 `_registerContributions` 里边注册边解析：那时后面的插件还没
   * 进注册表，先加载的消费方会全部误判为"依赖缺失"。
   */
  _resolveServiceDependencies() {
    const plugins = this.registry.listPlugins().filter((r) => r.status !== 'quarantined' && r.status !== 'disabled');
    const providers = this.registry.list('service');
    const edges = new Map();
    const missing = new Map();

    for (const rec of plugins) {
      const decl = rec.manifest.contributes.services;
      const consumes = decl && Array.isArray(decl.consumes) ? decl.consumes : [];
      if (!consumes.length) continue;
      const deps = [];
      const gaps = [];
      for (const dep of consumes) {
        const r = resolveService({ providers, id: dep.id, range: dep.range });
        if (r.ok) {
          // 只把"装着且启用的插件"算进依赖图：指向一个被停用的插件的边，
          // 不是环，而是另一个问题（缺依赖），混在一起报会误导用户。
          if (this.registry.getPlugin(r.provider.pluginId)) deps.push(r.provider.pluginId);
        } else if (!dep.optional) {
          gaps.push(r.message);
        }
      }
      if (deps.length) edges.set(rec.id, deps);
      if (gaps.length) missing.set(rec.id, gaps);
    }

    this._serviceCycles = findCycles(edges);
    if (this._serviceCycles.length) {
      store.audit('service-cycle', null, { cycles: this._serviceCycles });
    }

    for (const rec of plugins) {
      const gaps = missing.get(rec.id);
      if (gaps && gaps.length) {
        this._degrade(rec.id, `缺少依赖服务：${gaps.join('；')}`);
        continue;
      }
      // 之前因为缺依赖被降级的，现在补齐了要能回到 loaded —— 否则用户装上
      // 提供方之后必须重启，而界面上还写着"缺少依赖"。
      if (this._serviceDegraded.has(rec.id)) {
        this._serviceDegraded.delete(rec.id);
        this.registry.updatePlugin(rec.id, { status: 'loaded', error: '' });
      }
    }
  }

  /** service id → 当前提供方（含版本匹配）。解析结果每次现算，不做缓存。 */
  resolveService(id, range) {
    return resolveService({ providers: this.registry.list('service'), id, range });
  }

  /**
   * 消费方发起的跨插件调用。主进程在这里做完全部判定，再转发给提供方进程。
   *
   * 不直接让两个插件进程互相发消息：那需要它们先交换对方的 pid/端口，
   * 于是"卸载一个插件"就变成了"另一个插件持有一个可能随时失效的句柄"。
   * 走主进程中转，卸载时这里同步就知道端点没了，可以立刻给出 SERVICE_GONE。
   */
  async callService(callerId, req) {
    const { service, method, args, depth } = req || {};
    const caller = this.registry.getPlugin(callerId);
    if (!caller) throw Object.assign(new Error('调用方插件未加载'), { code: ERR.NOT_FOUND });

    const decl = (caller.manifest.contributes.services || {});
    const consumes = Array.isArray(decl.consumes) ? decl.consumes : [];
    const declared = consumes.find((c) => c.id === service);
    if (!declared) {
      store.audit('service-denied', callerId, { service, method, reason: 'undeclared' });
      throw Object.assign(new Error(`未在 contributes.services.consumes 里声明 '${service}'`), {
        code: ERR.PERMISSION_DENIED,
      });
    }
    if (!(caller.manifest.permissions.services || []).includes('consume')) {
      store.audit('service-denied', callerId, { service, method, reason: 'no-permission' });
      throw Object.assign(new Error('缺少权限 services:consume'), { code: ERR.PERMISSION_DENIED });
    }
    if ((depth || 0) >= MAX_CALL_DEPTH) {
      store.audit('service-denied', callerId, { service, method, reason: 'recursion', depth });
      throw Object.assign(new Error(`服务调用链过深（> ${MAX_CALL_DEPTH}），疑似循环调用`), {
        code: SERVICE_ERR.RECURSION,
      });
    }

    const resolved = this.resolveService(service, declared.range);
    if (!resolved.ok) {
      // 提供方可能只是被停用了；对消费方来说和"没装"是同一件事：端点不在。
      store.audit('service-gone', callerId, { service, method, reason: resolved.reason });
      throw Object.assign(new Error(resolved.message), { code: ERR.SERVICE_GONE });
    }
    const provider = this.registry.getPlugin(resolved.provider.pluginId);
    if (!provider || (provider.status !== 'loaded' && provider.status !== 'degraded')) {
      store.audit('service-gone', callerId, {
        service, method, provider: resolved.provider.pluginId, status: provider ? provider.status : 'missing',
      });
      throw Object.assign(new Error(`service '${service}' 的提供方当前不可用`), { code: ERR.SERVICE_GONE });
    }
    if (!resolved.provider.methods.includes(method)) {
      throw Object.assign(new Error(`service '${service}' 没有声明方法 '${method}'`), { code: ERR.NOT_FOUND });
    }

    const key = `${service}.${method}`;
    const stat = this._serviceStats.get(key) || { calls: 0, errors: 0, totalMs: 0, lastMs: 0, lastAt: 0 };
    const started = Date.now();
    try {
      const result = await this._call(provider.id, 'service.call', {
        service,
        method,
        args: args === undefined ? null : args,
        // 调用方信息交给提供方：提供方可以据此做审计或白名单，但它只是"信息"，
        // 真正的闸门在主进程（未声明的 consume 到不了这里）。
        caller: { id: callerId, version: caller.manifest.version },
        depth: (depth || 0) + 1,
      }, TIMEOUTS.service);
      stat.calls++;
      stat.lastMs = Date.now() - started;
      stat.totalMs += stat.lastMs;
      stat.lastAt = Date.now();
      this._serviceStats.set(key, stat);
      return result;
    } catch (err) {
      stat.calls++;
      stat.errors++;
      stat.lastMs = Date.now() - started;
      stat.totalMs += stat.lastMs;
      stat.lastAt = Date.now();
      this._serviceStats.set(key, stat);
      // 提供方进程退出/被停用 → 对消费方来说是端点消失，而不是"我调错了"。
      // 这个区分决定了消费方该重试还是该降级。
      if (err.code === ERR.PLUGIN_UNLOADED || err.code === ERR.PLUGIN_TIMEOUT) {
        store.audit('service-gone', callerId, { service, method, provider: provider.id, code: err.code });
        throw Object.assign(new Error(`service '${service}' 调用失败：${err.message}`), {
          code: ERR.SERVICE_GONE,
        });
      }
      throw err;
    }
  }

  /** 管理器/诊断用：谁在调谁、调了多少次、平均多慢。 */
  serviceStats() {
    return [...this._serviceStats.entries()].map(([key, s]) => ({
      key,
      calls: s.calls,
      errors: s.errors,
      avgMs: s.calls ? Math.round(s.totalMs / s.calls) : 0,
      lastMs: s.lastMs,
      lastAt: s.lastAt,
    })).sort((a, b) => b.calls - a.calls);
  }

  /**
   * 某插件消失（卸载/停用/重载）后，通知依赖它的消费方。
   *
   * 不做的话消费方只会在下一次调用时才发现 —— 而它可能已经缓存了服务返回的
   * 句柄或路径。事件是"现在就不能用了"，比等下一次调用失败更早、更准。
   */
  _broadcastServiceGone(pluginId, serviceIds) {
    const ids = new Set(serviceIds || []);
    if (!ids.size) return;
    for (const rec of this.registry.listPlugins()) {
      if (rec.id === pluginId) continue;
      const decl = rec.manifest.contributes.services;
      const consumes = decl && Array.isArray(decl.consumes) ? decl.consumes : [];
      for (const c of consumes) {
        if (!ids.has(c.id)) continue;
        this.runtimes.sendEvent(rec.id, 'service.changed', { id: c.id, available: false });
      }
    }
  }

  /** 卸载/停用前先把"我提供了哪些服务"记下来，撤表之后就查不到了。 */
  _providedServiceIds(record) {
    const decl = (record && record.manifest && record.manifest.contributes.services) || {};
    const provides = Array.isArray(decl.provides) ? decl.provides : [];
    return provides.map((p) => p.id);
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
      // 管线后处理 hook：管理器要能看到"谁挂了、熔断没有"，
      // 否则一个失败的 hook 只表现为"合成结果听起来不对"。
      pipelineHooks: this.pipelineHooks ? this.pipelineHooks.snapshot() : [],
      // 跨插件服务的依赖环与调用计数：环只报告（见 pluginServices.js），
      // 计数只在内存里，用来回答"谁在调谁、慢不慢"。
      serviceCycles: this._serviceCycles,
      serviceStats: this.serviceStats(),
      // M6：签名策略与信任的密钥。管理器要能解释"为什么装不上"，
      // 也要让用户看见自己信任了谁。
      trust: trustStore.list(),
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
   * 用户级自动化开关（管理器的勾选框）。
   *
   * 与 manifest 的 `permissions.automation` 是两道不同的门：
   *   · 权限门是**作者**在安装前声明"我要被外部调用"；
   *   · 这个开关是**用户**事后说"我不要它被外部调用"。
   * 只有前者的话，用户要么接受、要么卸载插件；只有后者的话，作者可以从用户
   * 没看过的权限清单里偷偷暴露命令。两者都必要。
   *
   * 关掉只影响自动化面（MCP/CLI），不影响插件自己的菜单/按钮 —— 用户要的是
   * "别让外面的脚本动我的工程"，不是"别让我自己用这个插件"。
   */
  setAutomationExpose(pluginId, enabled) {
    const record = this.registry.getPlugin(pluginId);
    if (!record) return { ok: false, error: `未安装：${pluginId}` };
    const registry = store.readRegistry();
    store.setPluginState(registry, pluginId, { automationExpose: !!enabled });
    store.writeRegistry(registry);
    this.registry.updatePlugin(pluginId, { state: { ...(record.state || {}), automationExpose: !!enabled } });
    store.audit('automation', pluginId, { expose: !!enabled });
    // 注册表条目没变（方法仍在表里），变的是"这一份投影里它算不算数"，
    // 所以主动推一次，管理器与其它窗口的计数才不会停在旧值。
    ipcFacade.broadcastSnapshot(this);
    return { ok: true, expose: !!enabled };
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

  // ------------------------------------------------------------ 签名与信任
  /**
   * 信任库视图。管理器要能回答"为什么这个包装不上"，所以连策略一起给。
   */
  listTrust() {
    return trustStore.list();
  }

  /**
   * 信任一把公钥。
   *
   * 这里刻意不接受"信任全部"或"信任发布者名字"：名字是包自称的，
   * 能核对的是密钥指纹。管理器展示指纹，用户核对后决定。
   */
  trustKey(input) {
    const result = trustStore.addKey(input || {});
    if (result.ok) ipcFacade.broadcastSnapshot(this);
    return result;
  }

  forgetKey(keyId) {
    const result = trustStore.removeKey(keyId);
    if (result.ok) ipcFacade.broadcastSnapshot(this);
    return result;
  }

  setRequireSignature(enabled) {
    const result = trustStore.setRequireSignature(!!enabled);
    ipcFacade.broadcastSnapshot(this);
    return result;
  }

  /** 按需重验：核对安装目录是否还是安装时那份内容。 */
  verifyInstalled(id) {
    if (!this.registry.getPlugin(id)) return { ok: false, error: `未安装：${id}` };
    return installer.verifyInstalled(id);
  }

  /**
   * 卸载：先拆运行时与 UI，再删文件。任一步失败都不回滚删除（文件是最后一步）。
   */
  async uninstall(id, options = {}) {
    const record = this.registry.getPlugin(id);
    if (!record) return { ok: false, error: `未安装：${id}` };

    const before = await this.probe.snapshot(id);

    // 1. 撤 UI 与菜单：registry.removePlugin 会触发 _notify → renderer 重新投影 + 菜单重建
    const provided = this._providedServiceIds(record);
    const removedContribs = this.registry.removePlugin(id);
    this._pluginDirs.delete(id);
    this._clearStatusText(id);
    // 端点没了要主动告诉消费方：它们的下一次调用会失败，但缓存了返回值的人
    // 只有收到事件才知道该重算。
    this._broadcastServiceGone(id, provided);

    // 2. 停运行时
    await this.runtimes.stop(id);

    // 3. 删文件
    const removed = installer.uninstall(id, { keepData: !!options.keepData });
    // 密钥是敏感数据：不保留数据时连内存缓存一起丢；keepData 时文件随目录保留，
    // 但缓存仍要失效 —— 不然重装同一个 id 会拿到上一份内存里的旧密钥。
    if (!options.keepData) {
      try { this.secrets.clear(id); } catch (_) { /* 目录已被删，忽略 */ }
    } else if (this.secrets) {
      this.secrets.invalidate(id);
    }

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
      const provided = this._providedServiceIds(record);
      await this.runtimes.stop(id);
      // 停用只撤贡献、保留记录 —— 记录一删，管理器里就没这条了，用户无法再启用。
      this.registry.removeContributions(id);
      this._broadcastServiceGone(id, provided);
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
  async runCommand(commandId, args, opts = {}) {
    const cmd = this.registry.findCommand(commandId);
    if (!cmd) return { ok: false, error: { code: ERR.NOT_FOUND, message: `未知命令：${commandId}` } };
    // 超时按命令自己的声明选：长任务在插件侧就该有更宽的预算，而不是让
    // 桥接层（600s）和插件（60s）赛跑，最后返回一条谁都不知道发生了什么的 TIMEOUT。
    const timeoutMs = opts.timeoutMs || (cmd.long ? TIMEOUTS.longCommand : TIMEOUTS.command);
    try {
      const result = await this._call(cmd.pluginId, 'command.run', {
        commandId: cmd.localId,
        args: args || {},
      }, timeoutMs, { onProgress: opts.onProgress, signal: opts.signal });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: { code: err.code || ERR.INTERNAL, message: err.message } };
    }
  }

  /**
   * 自动化方法表 —— `GET /schema`、capabilities 里"插件贡献"的那一半。
   *
   * 从**注册表**读而不是从 manifest 读：停用、重载、卸载之后注册表是最先被
   * 清理的，按 manifest 投影会让已经调不通的方法继续出现在 agent 的工具列表里。
   * 那种"工具在、调用就 500"的状态比根本不出现更糟 —— agent 会一直重试。
   *
   * `headless: false` 的命令不导出：作者用这个字段明确说了"这条命令需要有人
   * 看着界面才有意义"（例如弹一个向导），自动化调用它只会卡在没人点的对话框上。
   */
  listAutomationMethods() {
    const defs = {};
    for (const entry of this.registry.list('automation')) {
      const record = this.registry.getPlugin(entry.pluginId);
      if (!record || (record.status !== 'loaded' && record.status !== 'degraded')) continue;
      // 用户在管理器里关掉的插件，方法直接从表里消失 —— 不是"调用时报错"，
      // 而是根本不出现。agent 看到的能力表就应该是真实可用的那一份。
      if (record.state && record.state.automationExpose === false) continue;
      const cmd = this.registry.findCommand(entry.id);
      if (!cmd || cmd.headless === false) continue;
      const built = buildAutomationDef({
        pluginId: entry.pluginId,
        localId: entry.localId,
        title: cmd.title,
        description: cmd.description,
        pluginName: record.manifest.name,
        pluginVersion: record.manifest.version,
        long: cmd.long === true,
      });
      defs[built.name] = built.def;
    }
    return defs;
  }

  /**
   * 跑一个插件自动化方法。
   *
   * 返回 `{ok, result}` / `{ok:false, error}` —— 与 `runCommand` 同形，桥接层
   * 负责把它翻成 MCP 错误。这里不抛异常：MCP 的传输层不该看到插件的堆栈，
   * 那既没意义（调用方读不懂）也会把内部路径泄出去。
   *
   * 每次调用都写审计：自动化面是"别人替用户点按钮"，出了事必须能回答
   * "谁在什么时候调了哪个插件的哪个方法"。
   */
  async runAutomationMethod(name, params, options = {}) {
    const entry = this.registry.get('automation', name);
    if (!entry) {
      return { ok: false, error: { code: ERR.NOT_FOUND, message: `未暴露的自动化方法：${name}` } };
    }
    const record = this.registry.getPlugin(entry.pluginId);
    if (!record || (record.status !== 'loaded' && record.status !== 'degraded')) {
      return {
        ok: false,
        error: { code: ERR.PERMISSION_DENIED, message: `插件 ${entry.pluginId} 当前不可用（${record ? record.status : 'missing'}）` },
      };
    }
    const cmd = this.registry.findCommand(name);
    if (!cmd) {
      return { ok: false, error: { code: ERR.NOT_FOUND, message: `方法对应的命令已不存在：${name}` } };
    }
    if (record.state && record.state.automationExpose === false) {
      return {
        ok: false,
        error: { code: ERR.PERMISSION_DENIED, message: `用户已在插件管理器里关闭 ${entry.pluginId} 的自动化调用` },
      };
    }
    if (cmd.headless === false) {
      return {
        ok: false,
        error: { code: ERR.PERMISSION_DENIED, message: `命令 ${cmd.localId} 声明了 headless:false，不能经自动化调用` },
      };
    }
    const started = Date.now();
    // 取消与进度只在长任务上有意义：短命令的 onProgress 永远不会被调用，
    // signal 也来不及被别人 abort，传下去不增加任何风险。
    const r = await this.runCommand(name, params || {}, {
      onProgress: options.onProgress,
      signal: options.signal,
    });
    store.audit('automation-invoke', entry.pluginId, {
      method: name,
      ok: r.ok,
      code: r.ok ? null : (r.error && r.error.code) || null,
      ms: Date.now() - started,
      ...(cmd.long ? { long: true } : {}),
    });
    return r;
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

  /**
   * 调一次 pipeline hook。波形整段传过去（structured clone，不做 JSON），
   * 所以插件侧拿到的是真正的 Float32Array，不是数组。
   */
  callPipelineHook(pluginId, hookId, payload, timeoutMs) {
    return this._call(pluginId, 'pipeline.hook', { hookId, ...payload }, timeoutMs || TIMEOUTS.command);
  }

  /**
   * 当前工程的渲染意图（`extSchema[*].render`）。
   *
   * 由渲染层在打开工程后推过来：pipeline 跑在主进程，而工程文档在渲染层，
   * 中间没有别的通道能让"这份工程要 postWaveform 处理"这件事传达到 hook 执行器。
   * 失败不抛 —— 意图没传到最多是"顺序按默认走"，不该拦住工程打开。
   */
  setRenderIntent(intent) {
    if (!this.pipelineHooks) return { ok: false };
    try {
      this.pipelineHooks.setRenderIntent(intent);
      return { ok: true };
    } catch (err) {
      console.warn('[plugins] setRenderIntent failed:', err && err.message);
      return { ok: false };
    }
  }

  /** 走查 / 管理界面用：当前生效的渲染意图。 */
  getRenderIntent() {
    return this.pipelineHooks ? this.pipelineHooks.getRenderIntent() : null;
  }

  // ------------------------------------------------------------ 数据面
  /**
   * 用插件打开一个文件，返回校验过的工程文档（M4）。
   *
   * 失败不抛：返回值里的 `code` 就是给界面的分支依据（没插件接管 / 没权限 /
   * 文件太大 / 文档非法），抛异常只剩一句 message，界面只能弹"打开失败"。
   */
  openDocument(filePath) {
    if (!this.dataPlane) {
      return Promise.resolve({ ok: false, code: ERR.UNSUPPORTED, message: '插件系统未初始化' });
    }
    return this.dataPlane.openDocument(filePath);
  }

  /**
   * 用插件保存一个文件（M4 第 2 段）。
   *
   * 与 openDocument 对称：扩展名归属、权限、文档校验、写盘都在 dataPlane 里，
   * 这里只做"插件系统没初始化"的兜底。
   */
  saveDocument(filePath, document, options) {
    if (!this.dataPlane) {
      return Promise.resolve({ ok: false, code: ERR.UNSUPPORTED, message: '插件系统未初始化' });
    }
    return this.dataPlane.saveDocument(filePath, document, options);
  }

  /** 对话框过滤器：插件声明的文件格式（由 dialogIpc 合并到宿主过滤器之后）。 */  fileFilters(role) {
    if (!this.dataPlane) return [];
    return this.dataPlane.fileFilters(role, (label, fallback) => pickTitle(label, this._locale) || fallback);
  }

  /** 插件文件格式清单（管理器"文件类型"区用，测试也用它断言注册结果）。 */
  listFileTypes(role) {
    if (!this.dataPlane) return [];
    return this.dataPlane.listFileTypes({ role });
  }

  /**
   * 音频导出器（M4 第 4 段）：成品格式清单与执行。
   *
   * 与 `fileTypes` 分开两个方法而不是合成一个 "formats"：导出对话框要的是
   * "我选了 flac 之后该问谁"（pluginId + id），而另存为对话框要的是"扩展名归谁"。
   * 两个问题形状不同，混在一起会让界面层到处 if。
   */
  listExporters() {
    if (!this.dataPlane) return [];
    return this.dataPlane.listExporters((label, fallback) => pickTitle(label, this._locale) || fallback);
  }

  exportAudio(filePath, ref, audio) {
    if (!this.dataPlane) {
      return Promise.resolve({ ok: false, code: ERR.UNSUPPORTED, message: '插件系统未初始化' });
    }
    return this.dataPlane.exportAudio(filePath, ref, audio);
  }

  async _call(pluginId, method, params, timeoutMs, options = {}) {    const record = this.registry.getPlugin(pluginId);
    if (!record) throw Object.assign(new Error(`插件未加载：${pluginId}`), { code: ERR.NOT_FOUND });
    // degraded 是"装了、启用了，但缺依赖服务"——它的代码照样能跑，缺什么由它
    // 自己在调用时报（`ctx.services.get` 抛 SERVICE_GONE）。在这里一刀切拒绝，
    // 用户只会看到一句"插件状态为 degraded"，既不知道缺什么，也没法降级处理。
    // quarantined / disabled 才是真的不能跑。
    if (record.status !== 'loaded' && record.status !== 'degraded') {
      const code = record.status === 'quarantined' ? ERR.PLUGIN_QUARANTINED : ERR.PLUGIN_UNLOADED;
      throw Object.assign(new Error(`插件状态为 ${record.status}`), { code });
    }
    await this._ensureRuntime(pluginId);
    return this.runtimes.call(pluginId, method, params, { timeoutMs, ...options });
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
        // 服务清单在 init 时给一份快照：`ctx.services.get()` 必须能同步返回
        // 一个带方法名的代理，而"问宿主有哪些方法"是异步的 —— 那会让每个
        // 插件在启动时多一次往返，还会在服务晚到时产生两套写法。
        // 之后的变化通过 `service.changed` 事件推（见 _broadcastServiceGone）。
        services: this._serviceSnapshotFor(pluginId),
      },
    });
    this.registry.updatePlugin(pluginId, { runtimeAlive: true });
    this._notify();
  }

  /** 给插件进程的启动快照：它提供了什么、依赖谁、依赖当前是否可用。 */
  _serviceSnapshotFor(pluginId) {
    const rec = this.registry.getPlugin(pluginId);
    const raw = rec && rec.manifest.contributes.services;
    const decl = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const provides = Array.isArray(decl.provides) ? decl.provides : [];
    const consumes = Array.isArray(decl.consumes) ? decl.consumes : [];
    if (!provides.length && !consumes.length) return { provides: [], consumes: [] };
    const providers = this.registry.list('service');
    return {
      provides: provides.map((p) => ({ id: p.id, version: p.version, methods: p.methods })),
      consumes: consumes.map((c) => {
        const r = resolveService({ providers, id: c.id, range: c.range });
        return {
          id: c.id,
          range: c.range,
          optional: c.optional,
          available: r.ok,
          version: r.ok ? r.provider.version : null,
          provider: r.ok ? r.provider.pluginId : null,
          methods: r.ok ? r.provider.methods : [],
          reason: r.ok ? null : r.reason,
        };
      }),
    };
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

    // 拒绝也要留痕：一个没有 secrets 权限的插件反复尝试读密钥，是权限声明写错了，
    // 还是它在试探边界？审计里能看出频次，这比只看一次异常有用。
    const needSecretsPerm = (mode, action, key) => {
      if ((perms.secrets || []).includes(mode)) return;
      store.audit('secret-denied', pluginId, {
        action, key: key === null || key === undefined ? null : String(key).slice(0, 64),
      });
      throw Object.assign(new Error(`缺少权限 secrets:${mode}`), { code: ERR.PERMISSION_DENIED });
    };

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
      case 'models.read': {
        // 读大结果（音频 / MIDI）。不要求 fs 权限：句柄本身就是授权凭证，
        // 归属由 ModelHandleStore 按 subject 判，与文件系统权限无关。
        if (!(perms.models || []).includes('consume')) {
          throw Object.assign(new Error('缺少权限 models:consume'), { code: ERR.PERMISSION_DENIED });
        }
        if (!this.models) throw Object.assign(new Error('模型服务未启用'), { code: ERR.UNSUPPORTED });
        return this.models.read(`plugin:${pluginId}`, params && params.handle);
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
      // ---- 密钥 ----
      // 值只在这一条往返里出现：不进审计、不进日志、不进快照。
      // 读与写分成两个权限，是因为"能读"与"能改"在威胁模型里不是一回事：
      // 一个只读的展示面板没有理由能覆盖用户的 token。
      case 'secrets.get': {
        needSecretsPerm('read', 'get', params && params.key);
        const r = this.secrets.get(pluginId, params && params.key);
        if (!r.ok) throw Object.assign(new Error(r.error), { code: ERR.INVALID_REQUEST });
        return r.value;
      }
      case 'secrets.set': {
        needSecretsPerm('write', 'set', params && params.key);
        const payload = params || {};
        const r = this.secrets.set(pluginId, payload.key, payload.value);
        if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code || ERR.INVALID_REQUEST });
        store.audit('secret', pluginId, {
          action: 'set', key: String(payload.key), created: r.created, encrypted: r.encrypted,
        });
        return { ok: true, created: r.created, encrypted: r.encrypted };
      }
      case 'secrets.delete': {
        needSecretsPerm('write', 'delete', params && params.key);
        const payload = params || {};
        const r = this.secrets.delete(pluginId, payload.key);
        if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code || ERR.INVALID_REQUEST });
        store.audit('secret', pluginId, { action: 'delete', key: String(payload.key), existed: r.existed });
        return { ok: true, existed: r.existed };
      }
      case 'secrets.keys': {
        needSecretsPerm('read', 'keys', null);
        const r = this.secrets.keys(pluginId);
        return { keys: r.keys, encrypted: r.encrypted };
      }
      // ---- M5：跨插件服务 ----
      case 'service.call':
        return this.callService(pluginId, {
          service: params && params.service,
          method: params && params.method,
          args: params && params.args,
          depth: params && params.depth,
        });
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

function safeStorageOrNull() {
  try {
    const { safeStorage } = require('electron');
    return safeStorage || null;
  } catch (_) {
    return null;
  }
}

let _instance = null;
function getPluginService() {
  if (!_instance) _instance = new PluginService();
  return _instance;
}

module.exports = { PluginService, getPluginService };
