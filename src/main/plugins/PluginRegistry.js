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
    for (const type of ['command', 'menu', 'panel', 'fileType', 'setting', 'hook']) {
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

  /** 删除插件及其全部贡献。返回被删除的贡献数量，供审计与断言使用。 */
  removePlugin(id) {
    let removed = 0;
    // 遍历所有贡献类型：插件的每一项贡献都带着 pluginId，按它过滤，
    // 不需要插件自己报"我注册了什么"—— 这也是卸载能兜底的原因。
    for (const map of this._contrib.values()) {
      for (const [key, entry] of [...map]) {
        if (entry.pluginId === id) {
          map.delete(key);
          removed++;
        }
      }
    }
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

  // -------------------------------------------------------------- 投影
  /**
   * 渲染进程需要的投影。只含可用（enabled 且非 quarantine）的插件贡献。
   * 注意：不含文件路径与权限细节 —— 渲染层不需要，也不该拿到。
   */
  snapshot() {
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
        commands: usable ? record.manifest.contributes.commands.map((c) => ({
          id: c.id, title: c.title, description: c.description, headless: c.headless,
        })) : [],
        panels: usable ? record.manifest.contributes.panels.map((p) => ({
          id: p.id, title: p.title, width: p.width,
        })) : [],
        settings: usable ? record.manifest.contributes.settings.map((s) => ({
          id: s.id, title: s.title, hasPanel: !!s.entry, fields: s.fields,
        })) : [],
        fileTypes: usable ? record.manifest.contributes.fileTypes : [],
        permissions: usable ? record.manifest.permissions : {},
        pendingContributions: record.manifest.pendingContributions || [],
      });
    }
    return { revision: this.revision, plugins };
  }

  /** 管理器窗口用：含状态、来源、错误、审计摘要。 */
  adminSnapshot() {
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
        apiVersion: r.manifest.apiVersion,
        commands: r.manifest.contributes.commands.map((c) => c.localId),
        panels: r.manifest.contributes.panels.map((p) => p.localId),
        fileTypes: r.manifest.contributes.fileTypes,
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
