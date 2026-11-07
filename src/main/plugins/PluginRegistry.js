'use strict';
/**
 * 插件贡献点的注册表 —— **唯一权威**。
 *
 * 为什么把权威放在主进程：
 *   · 菜单是主进程的 native Menu，只有这里能重建；
 *   · 动态 IPC handler 只有这里能注册/移除；
 *   · 卸载时即使插件不配合（iframe 里留着定时器、runtime 不响应 dispose），
 *     宿主仍然能从这张表把它的每一项删干净 —— 这是"可逆性"最后的兜底。
 *
 * 渲染进程与 runtime 拿到的都是投影（snapshot），不持有真源，重载时整体替换。
 */
const { Disposable } = require('../../shared/pluginDisposable.js');

class PluginRegistry {
  constructor() {
    /** @type {Map<string, object>} id -> 插件记录 */
    this._plugins = new Map();
    /** @type {Map<string, Map<string, object>>} 贡献类型 -> (id -> 条目) */
    this._contrib = new Map();
    this._listeners = new Set();
    this.revision = 0;
    for (const type of [
      'command', 'menu', 'panel', 'fileType', 'exporter', 'setting', 'hook',
      // M2：界面贡献点。与命令分开存，卸载时按 pluginId 一律清掉，
      // 不依赖插件自己报"我往工具栏塞了什么"。
      // M5：暴露给 MCP / CLI 的命令。与 command 表分开存：命令存在 ≠ 允许
      // 无界面调用，两张表分开，卸载/停用时也能一起扫干净。
      'automation',
      // M5：跨插件 service。键是 service id（全局命名空间），一个 id 只能有
      // 一个提供方 —— 冲突在 PluginService 里按插件 id 字典序裁决，结果仍落在这张表。
      'service',
      'toolbar', 'statusBar', 'contextMenu', 'overlay', 'keybinding',
    ]) {
      this._contrib.set(type, new Map());
    }
  }

  // -------------------------------------------------------------- 插件记录
  /**
   * @param {{id:string, manifest:object, dir:string, state:object}} record
   */
  addPlugin(record) {
    this._plugins.set(record.id, {
      id: record.id,
      manifest: record.manifest,
      dir: record.dir,
      state: record.state,
      status: 'loaded',
      error: '',
      legacy: false,
      runtimeAlive: false,
    });
    this._bump();
    return this._plugins.get(record.id);
  }

  getPlugin(id) {
    return this._plugins.get(id) || null;
  }

  listPlugins() {
    return [...this._plugins.values()];
  }

  updatePlugin(id, patch) {
    const record = this._plugins.get(id);
    if (!record) return null;
    Object.assign(record, patch);
    this._bump();
    return record;
  }

  /**
   * 只摘掉贡献，保留插件记录（停用用这条）。
   *
   * 停用不能走 removePlugin：记录一删，管理器里连条目都没有了，用户再也点不到
   * "启用"，只能重启应用。两者的差别正是"这个插件还安不安全地待在列表里"。
   * @returns {number} 被删除的贡献数量
   */
  removeContributions(pluginId) {
    let removed = 0;
    // 遍历所有贡献类型：插件的每一项贡献都带着 pluginId，按它过滤，
    // 不需要插件自己报"我注册了什么"—— 这也是卸载能兜底的原因。
    for (const map of this._contrib.values()) {
      for (const [key, entry] of [...map]) {
        if (entry.pluginId === pluginId) {
          map.delete(key);
          removed++;
        }
      }
    }
    if (removed > 0) this._bump();
    return removed;
  }

  /** 删除插件及其全部贡献。返回被删除的贡献数量，供审计与断言使用。 */
  removePlugin(id) {
    const removed = this.removeContributions(id);
    this._plugins.delete(id);
    this._bump();
    return removed;
  }

  // -------------------------------------------------------------- 贡献点
  /**
   * 登记一个贡献项。重复 id 直接覆盖（便于 reload），返回 Disposable 以便插件主动撤销。
   * @param {'command'|'menu'|'panel'|'fileType'|'setting'|'hook'} type
   * @param {string} key 全局唯一键（command 用 fullId，panel 用 fullId，menu 用 pluginId:index）
   */
  register(type, key, entry) {
    const map = this._contrib.get(type);
    if (!map) throw new Error(`未知贡献类型 ${type}`);
    map.set(key, entry);
    this._bump();
    return new Disposable(() => {
      if (map.get(key) === entry) {
        map.delete(key);
        this._bump();
      }
    });
  }

  unregister(type, key) {
    const map = this._contrib.get(type);
    if (!map) return false;
    const ok = map.delete(key);
    if (ok) this._bump();
    return ok;
  }

  list(type) {
    const map = this._contrib.get(type);
    return map ? [...map.values()] : [];
  }

  get(type, key) {
    const map = this._contrib.get(type);
    return map ? map.get(key) || null : null;
  }

  /** 命令查找：fullId = `${pluginId}.${localId}` */
  findCommand(fullId) {
    return this.get('command', fullId);
  }

  /** 文件扩展名 → 打开/保存处理器（大小写不敏感，后注册者不覆盖先注册者）。 */
  findFileType(ext) {
    const target = String(ext || '').toLowerCase();
    return this.list('fileType').find((ft) => ft.ext === target) || null;
  }

  /** 某个 stage 上按 order + pluginId 稳定排序后的 hook 链。 */
  hooksFor(stage) {
    return this.list('hook')
      .filter((h) => h.stage === stage)
      .sort((a, b) => (a.order - b.order) || a.pluginId.localeCompare(b.pluginId));
  }

  /**
   * 单个插件视角的服务视图：我提供什么、我依赖谁、依赖现在满不满足。
   *
   * 解析放在这里而不是 PluginService：管理器与渲染层拿到的投影必须同源，
   * 否则会出现"管理器说可用、插件调用说 SERVICE_GONE"这种自相矛盾的界面。
   */
  serviceView(pluginId) {
    const declared = (this.getPlugin(pluginId) || { manifest: {} }).manifest.contributes || {};
    const raw = declared.services;
    // 老 fixture / 手写注册表里 `services` 可能是数组（M5 之前只校验 provides）。
    // 投影不是校验器：形状不认识就当没声明，别让管理器整页崩掉。
    const decl = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const provides = Array.isArray(decl.provides) ? decl.provides : [];
    const consumes = Array.isArray(decl.consumes) ? decl.consumes : [];
    const providers = this.list('service');
    const { resolveService } = require('../../shared/pluginServices.js');
    const activeIds = new Set(providers.map((s) => s.id));
    return {
      provides: provides.map((p) => ({
        id: p.id, version: p.version, methods: p.methods,
        // 被别人抢注（或自己被停用）时 isActive 为 false，管理器要能看出
        // "我声明了但没生效"，而不是只看到一个空的提供列表。
        active: activeIds.has(p.id) && (this.get('service', p.id) || {}).pluginId === pluginId,
        spokenFor: activeIds.has(p.id) && (this.get('service', p.id) || {}).pluginId !== pluginId
          ? (this.get('service', p.id) || {}).pluginId
          : null,
      })),
      consumes: consumes.map((c) => {
        const r = resolveService({ providers, id: c.id, range: c.range });
        return {
          id: c.id,
          range: c.range,
          optional: c.optional,
          available: r.ok,
          provider: r.ok ? r.provider.pluginId : null,
          version: r.ok ? r.provider.version : null,
          reason: r.ok ? null : r.reason,
          message: r.ok ? null : r.message,
        };
      }),
    };
  }

  // -------------------------------------------------------------- 投影
  /**
   * 渲染进程需要的投影。只含可用（enabled 且非 quarantine）的插件贡献。
   * 注意：不含文件路径与权限细节 —— 渲染层不需要，也不该拿到。
   *
   * @param {{keybindings?: Map<string, object[]>, statusText?: Map<string, string>}} [extras]
   *   keybindings：主进程仲裁后的"该插件当前真正生效/被挡住的组合"；
   *   statusText：插件运行期通过 ui.status 覆盖过的状态栏文案（不落盘）。
   */
  snapshot(extras = {}) {
    const keybindingsByPlugin = extras.keybindings || new Map();
    const statusText = extras.statusText || new Map();
    /**
     * 投影从**贡献表**读，而不是从 manifest 读。
     *
     * 两处读法在"正常加载"时结果一样，但差异恰恰出现在出问题的时候：
     * 停用/重载过程中若只撤掉了注册表而 record 还在，按 manifest 投影就会把
     * 已经不存在的按钮继续画出来 —— 点下去就是 NOT_FOUND。注册表是唯一权威，
     * 投影就必须跟着它。
     */
    const byPlugin = (type) => {
      const map = new Map();
      for (const entry of this.list(type)) {
        if (!map.has(entry.pluginId)) map.set(entry.pluginId, []);
        map.get(entry.pluginId).push(entry);
      }
      return map;
    };
    const tables = {
      command: byPlugin('command'),
      panel: byPlugin('panel'),
      setting: byPlugin('setting'),
      fileType: byPlugin('fileType'),
      exporter: byPlugin('exporter'),
      automation: byPlugin('automation'),
      toolbar: byPlugin('toolbar'),
      statusBar: byPlugin('statusBar'),
      contextMenu: byPlugin('contextMenu'),
      overlay: byPlugin('overlay'),
    };
    const rows = (type, pluginId) => (tables[type].get(pluginId) || []);

    const plugins = [];
    for (const record of this._plugins.values()) {
      const usable = record.status === 'loaded';
      plugins.push({
        id: record.id,
        name: record.manifest.name,
        version: record.manifest.version,
        description: record.manifest.description,
        status: record.status,
        error: record.error,
        legacy: record.legacy,
        runtimeAlive: record.runtimeAlive,
        commands: rows('command', record.id).map((c) => ({
          id: c.id, title: c.title, description: c.description, headless: c.headless,
        })),
        panels: rows('panel', record.id).map((p) => ({
          id: p.id, title: p.title, width: p.width,
        })),
        settings: rows('setting', record.id).map((s) => ({
          id: s.id, localId: s.localId, title: s.title, panel: s.panelId, fields: s.fields,
        })),
        fileTypes: rows('fileType', record.id),
        exporters: rows('exporter', record.id).map((e) => ({
          id: e.id, ext: e.ext, label: e.label, mime: e.mime, description: e.description,
        })),
        // 管理器要能回答"这个插件给自动化开了什么"，用户在装之前也该看得到。
        // 只给方法名与标题，不给参数形状 —— 管理器不渲染参数表单。
        automation: rows('automation', record.id).map((a) => ({
          id: a.id, method: a.method, title: a.title,
        })),
        // 跨插件服务：管理器要能回答"这个插件依赖谁、现在满不满足"。
        // 依赖缺失时插件本身会是 degraded，但光看状态说明不了缺的是哪一个。
        services: this.serviceView(record.id),
        toolbar: rows('toolbar', record.id).map((t) => ({
          id: t.id, localId: t.localId, command: t.command, title: t.title,
          icon: t.icon, group: t.group, when: t.when,
        })),
        statusBar: rows('statusBar', record.id).map((s) => ({
          id: s.id, localId: s.localId, command: s.command, text: s.text, tooltip: s.tooltip,
          alignment: s.alignment, when: s.when,
          runtimeText: statusText.has(s.id) ? statusText.get(s.id) : null,
        })),
        contextMenus: rows('contextMenu', record.id).map((c) => ({
          id: c.id, localId: c.localId, context: c.context, command: c.command,
          title: c.title, when: c.when,
        })),
        overlays: rows('overlay', record.id).map((o) => ({
          id: o.id, localId: o.localId, title: o.title, anchor: o.anchor,
          height: o.height, width: o.width, pointerEvents: o.pointerEvents, when: o.when,
        })),
        keybindings: keybindingsByPlugin.get(record.id) || [],
        i18n: usable ? record.manifest.contributes.i18n : {},
        permissions: usable ? record.manifest.permissions : {},
        pendingContributions: record.manifest.pendingContributions || [],
      });
    }
    return { revision: this.revision, plugins };
  }

  /** 管理器窗口用：含状态、来源、错误、审计摘要。 */
  adminSnapshot(extras = {}) {
    const keybindingsByPlugin = extras.keybindings || new Map();
    return {
      revision: this.revision,
      plugins: [...this._plugins.values()].map((r) => ({
        id: r.id,
        name: r.manifest.name,
        version: r.manifest.version,
        description: r.manifest.description,
        author: r.manifest.author,
        homepage: r.manifest.homepage,
        status: r.status,
        error: r.error,
        legacy: r.legacy,
        dir: r.dir,
        state: r.state,
        runtimeAlive: r.runtimeAlive,
        permissions: r.manifest.permissions,
        permissionsHash: r.manifest.permissionsHash,
        // 插件级部署依赖（不是 services）：管理器要能显示"它还需要谁"。
        dependencies: r.manifest.dependencies || [],
        apiVersion: r.manifest.apiVersion,
        commands: r.manifest.contributes.commands.map((c) => c.localId),
        panels: r.manifest.contributes.panels.map((p) => p.localId),
        fileTypes: r.manifest.contributes.fileTypes,
        // 插件把哪些命令交给了自动化面。管理器直接列出来：这是"别人能替你
        // 操作工程"的入口，用户有权在装完后就看见，而不是等 agent 调通了才知道。
        automationMethods: r.manifest.contributes.automation.methods,
        // 跨插件服务的完整视图（含解析结果与缺失原因）。
        services: this.serviceView(r.id),
        // M2：界面贡献点的条目数与管理器要展示的快捷键状态。
        // 只给数量而不是内容 —— 管理器不渲染工具栏按钮，给内容只会多一份要维护的形状。
        uiContributions: {
          toolbar: r.manifest.contributes.toolbar.length,
          statusBar: r.manifest.contributes.statusBar.length,
          contextMenus: r.manifest.contributes.contextMenus.length,
          overlays: r.manifest.contributes.timelineOverlays.length,
          settings: r.manifest.contributes.settings.length,
        },
        keybindings: keybindingsByPlugin.get(r.id) || [],
        keybindingsEnabled: !!r.state?.keybindingsEnabled,
        pendingContributions: r.manifest.pendingContributions || [],
      })),
    };
  }

  // -------------------------------------------------------------- 变更通知
  onDidChange(listener) {
    this._listeners.add(listener);
    return new Disposable(() => this._listeners.delete(listener));
  }

  _bump() {
    this.revision++;
    for (const fn of [...this._listeners]) {
      try {
        fn(this.revision);
      } catch (err) {
        console.warn('[plugins] registry listener failed:', err && err.message);
      }
    }
  }

  /** 仅供测试：断言卸载后注册表回到初始规模。 */
  stats() {
    const out = { plugins: this._plugins.size };
    for (const [type, map] of this._contrib) out[type] = map.size;
    return out;
  }
}

module.exports = { PluginRegistry };
