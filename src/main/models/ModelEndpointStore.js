'use strict';

/**
 * 端点与任务绑定的存储。
 *
 * 两类数据分开存，理由不是洁癖：
 *
 *   endpoints.json  端点元数据（id / baseUrl / provider / adapter / locality ...）
 *   secrets.enc     密钥，经 safeStorage 加密
 *
 * 元数据要能被设置页直接读、被导出做诊断；密钥不能。混在一个文件里，任何一次
 * "把这个配置发给我看看"都会连 key 一起发出去。
 *
 * Electron 依赖从构造参数进来（`secrets` 适配器），这样整个模块是纯 Node 的，
 * 单测不用起窗口。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  ADAPTERS, ADAPTER_TASKS, OWNERS, LOCALITIES, TASKS, ERR, LIMITS,
  parseEndpointId, localityOf,
} = require('../../shared/modelContract');

const STORE_VERSION = 1;

function emptyState() {
  return { version: STORE_VERSION, endpoints: [], bindings: [] };
}

function sanitizeTitle(s) {
  return String(s || '').trim().slice(0, 64);
}

/** 端点对外的脱敏视图：不含 baseUrl 之外的任何连接细节，也不含密钥。 */
function publicView(ep) {
  const locality = localityOf(ep);
  return {
    id: ep.id,
    title: ep.title,
    owner: ep.owner,
    provider: ep.provider,
    adapter: ep.adapter,
    locality,
    enabled: ep.enabled !== false,
    hasSecret: !!ep.hasSecret,
    models: Array.isArray(ep.models) ? [...ep.models] : [],
  };
}

/**
 * 设置页视图：在脱敏视图上补回"只有配置者才需要"的字段。
 *
 * baseUrl 不是秘密（它就写在用户的配置文件里），但对调用方没意义，所以
 * publicView 不带它。设置页必须带 —— 否则编辑端点时表单里 Base URL 是空的，
 * 用户只改个名字都会被校验打回"必须是 http(s) 地址"，或者在保存时把地址抹掉。
 */
function settingsView(ep) {
  return {
    ...publicView(ep),
    baseUrl: ep.baseUrl || '',
    localityOverride: ep.localityOverride || null,
    idleTimeoutMs: ep.idleTimeoutMs || 0,
    maxDurationMs: ep.maxDurationMs || 0,
    authKind: ep.authKind || 'none',
    authLabel: ep.authLabel || '',
    helpUrl: ep.helpUrl || '',
  };
}

class ModelEndpointStore {
  /**
   * @param {{
   *   dir: string,
   *   secrets: { get:(id:string)=>string|null, set:(id:string,v:string)=>void, delete:(id:string)=>void, isEncrypted:()=>boolean },
   *   now?: ()=>number,
   *   logger?: {warn:Function, info?:Function}
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.dir) throw new Error('ModelEndpointStore 需要 dir');
    this.dir = opts.dir;
    this.metaFile = path.join(this.dir, 'model-endpoints.json');
    this.secrets = opts.secrets;
    this._now = opts.now || (() => Date.now());
    this.log = opts.logger || console;
    this.state = emptyState();
    this._load();
  }

  // ------------------------------------------------------------ 持久化
  _load() {
    try {
      const raw = fs.readFileSync(this.metaFile, 'utf8');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.endpoints)) throw new Error('结构不符');
      this.state = {
        version: STORE_VERSION,
        endpoints: data.endpoints.filter((e) => e && typeof e.id === 'string'),
        bindings: Array.isArray(data.bindings) ? data.bindings.filter((b) => b && b.task && b.endpointId) : [],
      };
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // 文件坏了不能静默重置：用户的端点配置会凭空消失。挪到一边留证据。
        try {
          fs.renameSync(this.metaFile, `${this.metaFile}.corrupt-${this._now()}`);
          this.log.warn('[models] model-endpoints.json 无法解析，已备份并重置：', err.message);
        } catch (_) { /* 备份失败就让它留在原地 */ }
      }
      this.state = emptyState();
    }
    // 回填 hasSecret（键在 secrets 里，元数据里只存布尔，避免每次读盘都解一次密）
    for (const ep of this.state.endpoints) {
      ep.hasSecret = !!(this.secrets && this.secrets.get(ep.id));
    }
  }

  _persist() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.metaFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmp, this.metaFile);
    } catch (err) {
      this.log.warn('[models] 端点配置落盘失败：', err && err.message);
    }
  }

  // ------------------------------------------------------------ 端点
  list() {
    return this.state.endpoints.map((ep) => ({ ...ep, locality: localityOf(ep) }));
  }

  get(id) {
    const ep = this.state.endpoints.find((e) => e.id === id);
    return ep ? { ...ep, locality: localityOf(ep) } : null;
  }

  /**
   * 新建或更新端点。返回 { ok, endpoint } 或 { ok:false, error }。
   * 更新时若 baseUrl/provider/adapter 变化，指纹随之变化（ACL 自动失效，见 ModelAcl）。
   */
  upsert(input) {
    if (!input || typeof input !== 'object') return { ok: false, error: '端点必须是对象' };
    const parsed = parseEndpointId(input.id);
    if (!parsed) return { ok: false, error: `非法 id：${input.id}` };
    if (!ADAPTERS.includes(input.adapter)) return { ok: false, error: `未知 adapter：${input.adapter}` };
    if (!OWNERS.includes(parsed.owner)) return { ok: false, error: `未知 owner：${parsed.owner}` };

    const title = sanitizeTitle(input.title);
    if (!title) return { ok: false, error: '标题不能为空' };

    let baseUrl = '';
    if (input.adapter !== 'local-process') {
      baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: 'baseUrl 必须是 http(s) 地址' };
      try { new URL(baseUrl); } catch (_) { return { ok: false, error: 'baseUrl 无法解析' }; }
    }

    const provider = String(input.provider || 'custom').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(provider)) return { ok: false, error: `非法 provider：${provider}` };

    let localityOverride = null;
    if (input.localityOverride != null) {
      if (!LOCALITIES.includes(input.localityOverride)) return { ok: false, error: `非法 locality：${input.localityOverride}` };
      localityOverride = input.localityOverride;
    }

    // 超时预算：idle 允许端点调大（MIDI 常几十秒无输出），总时长只允许调小 ——
    // 否则插件声明 24h 就把全局硬上限架空了。
    let idleTimeoutMs = 0;
    if (input.idleTimeoutMs != null) {
      const v = Number(input.idleTimeoutMs);
      if (!Number.isFinite(v) || v < 1000) return { ok: false, error: 'idleTimeoutMs 至少 1000' };
      idleTimeoutMs = Math.min(v, LIMITS.maxDurationMs);
    }
    let maxDurationMs = 0;
    if (input.maxDurationMs != null) {
      const v = Number(input.maxDurationMs);
      if (!Number.isFinite(v) || v < 1000) return { ok: false, error: 'maxDurationMs 至少 1000' };
      if (v > LIMITS.maxDurationMs) return { ok: false, error: 'maxDurationMs 不能超过宿主上限' };
      maxDurationMs = v;
    }

    const existing = this.state.endpoints.find((e) => e.id === input.id);
    const record = {
      id: input.id,
      title,
      owner: parsed.owner,
      provider,
      adapter: input.adapter,
      baseUrl,
      localityOverride,
      idleTimeoutMs: idleTimeoutMs || (existing ? existing.idleTimeoutMs || 0 : 0),
      maxDurationMs: maxDurationMs || (existing ? existing.maxDurationMs || 0 : 0),
      enabled: input.enabled !== false,
      models: Array.isArray(input.models) ? input.models.filter((m) => typeof m === 'string').slice(0, 64) : [],
      authKind: input.authKind || (input.adapter === 'local-process' ? 'none' : 'bearer'),
      authLabel: String(input.authLabel || '').slice(0, 64),
      helpUrl: String(input.helpUrl || '').slice(0, 300),
      // local-process 的后端键。宿主自建端点（歌声后端投影）用它指到具体实现；
      // 用户手建的本地端点没有这个字段，adapter 会退回用 id。
      localBackend: input.adapter === 'local-process'
        ? (String(input.localBackend || '') || (existing ? existing.localBackend || '' : ''))
        : '',
      createdAt: existing ? existing.createdAt : this._now(),
      updatedAt: this._now(),
    };

    // 密钥：undefined = 不改；null = 清除；string = 覆盖
    if (input.secret !== undefined) {
      if (input.secret === null || input.secret === '') {
        this.secrets.delete(record.id);
        record.hasSecret = false;
      } else {
        this.secrets.set(record.id, String(input.secret));
        record.hasSecret = true;
      }
    } else {
      record.hasSecret = existing ? !!existing.hasSecret : false;
    }

    if (existing) {
      Object.assign(existing, record);
    } else {
      this.state.endpoints.push(record);
    }
    this._persist();
    return { ok: true, endpoint: { ...record, locality: localityOf(record) } };
  }

  /** 删除端点：级联删除它的全部 binding。ACL 由调用方清（需要 acl 实例）。 */
  remove(id) {
    const idx = this.state.endpoints.findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, error: '端点不存在' };
    this.state.endpoints.splice(idx, 1);
    const before = this.state.bindings.length;
    this.state.bindings = this.state.bindings.filter((b) => b.endpointId !== id);
    try { this.secrets.delete(id); } catch (_) { /* 已不存在 */ }
    this._persist();
    return { ok: true, removedBindings: before - this.state.bindings.length };
  }

  getSecret(id) {
    return this.secrets.get(id);
  }

  /** 是否有可用凭据（local-process 或 authKind=none 视为有）。 */
  _hasCredential(ep) {
    if (!ep) return false;
    if (ep.adapter === 'local-process' || ep.authKind === 'none') return true;
    return !!this.secrets.get(ep.id);
  }

  // ------------------------------------------------------------ 绑定
  listBindings(task) {
    const rows = task ? this.state.bindings.filter((b) => b.task === task) : this.state.bindings;
    return rows.map((b) => ({ ...b, endpoint: this.get(b.endpointId) }));
  }

  /** 绑定 task → endpoint。isDefault 时会把同 task 的其他绑定降级。 */
  bind({ task, endpointId, model = null, isDefault = false }) {
    if (!TASKS.includes(task)) return { ok: false, error: `未知 task：${task}` };
    const ep = this.get(endpointId);
    if (!ep) return { ok: false, error: '端点不存在' };
    // 只允许绑"这个协议干得了的活"。绑错了要到调用时才炸，错误信息还来自上游，
    // 用户根本看不出是自己配错了。
    if (!ADAPTER_TASKS[ep.adapter].includes(task)) {
      return { ok: false, error: `${ep.adapter} 不支持 task=${task}` };
    }

    const existing = this.state.bindings.find((b) => b.task === task && b.endpointId === endpointId);
    if (existing) {
      existing.model = model || null;
      if (isDefault) this._clearDefault(task);
      existing.isDefault = !!isDefault || existing.isDefault;
    } else {
      if (isDefault) this._clearDefault(task);
      this.state.bindings.push({ task, endpointId, model: model || null, isDefault: !!isDefault });
    }
    this._persist();
    return { ok: true, binding: this.state.bindings.find((b) => b.task === task && b.endpointId === endpointId) };
  }

  _clearDefault(task) {
    for (const b of this.state.bindings) if (b.task === task) b.isDefault = false;
  }

  setDefault(task, endpointId) {
    const row = this.state.bindings.find((b) => b.task === task && b.endpointId === endpointId);
    if (!row) return { ok: false, error: '绑定不存在' };
    this._clearDefault(task);
    row.isDefault = true;
    this._persist();
    return { ok: true };
  }

  unbind(task, endpointId) {
    const before = this.state.bindings.length;
    this.state.bindings = this.state.bindings.filter((b) => !(b.task === task && b.endpointId === endpointId));
    if (this.state.bindings.length === before) return { ok: false, error: '绑定不存在' };
    this._persist();
    return { ok: true };
  }

  /**
   * 解析一次调用的目标端点。
   *
   * 三级：显式 endpointId → 该 task 的默认绑定 → NEED_ENDPOINT（**不自动挑第一个**）。
   * 端点被禁用或缺凭据时返回 ENDPOINT_UNAVAILABLE，而不是继续往下找 —— 静默换端点
   * 会让用户以为自己用的是 A，其实走了 B。
   */
  resolve(task, endpointId) {
    if (endpointId) {
      const ep = this.get(endpointId);
      if (!ep) return { ok: false, error: ERR.NEED_ENDPOINT, message: '端点不存在' };
      if (ep.enabled === false) return { ok: false, error: ERR.ENDPOINT_UNAVAILABLE, message: '端点已被禁用' };
      if (!ADAPTER_TASKS[ep.adapter].includes(task)) {
        return { ok: false, error: ERR.INVALID_REQUEST, message: `${ep.adapter} 不支持 task=${task}` };
      }
      if (!this._hasCredential(ep)) return { ok: false, error: ERR.ENDPOINT_UNAVAILABLE, message: '缺少凭据' };
      return { ok: true, endpoint: ep, binding: null, explicit: true };
    }

    const row = this.state.bindings.find((b) => b.task === task && b.isDefault);
    if (!row) {
      return {
        ok: false,
        error: ERR.NEED_ENDPOINT,
        message: `task=${task} 没有默认端点`,
        candidates: this.state.bindings.filter((b) => b.task === task).map((b) => b.endpointId),
      };
    }
    const ep = this.get(row.endpointId);
    if (!ep) return { ok: false, error: ERR.NEED_ENDPOINT, message: '默认端点已被删除' };
    if (ep.enabled === false) return { ok: false, error: ERR.ENDPOINT_UNAVAILABLE, message: '默认端点已被禁用' };
    if (!this._hasCredential(ep)) return { ok: false, error: ERR.ENDPOINT_UNAVAILABLE, message: '默认端点缺少凭据' };
    return { ok: true, endpoint: ep, binding: row, explicit: false };
  }

  /** 插件卸载时清掉它注册的端点与绑定。 */
  removeAllForOwner(owner, ownerId) {
    const ids = this.state.endpoints
      .filter((e) => e.owner === owner && parseEndpointId(e.id)?.ownerId === ownerId)
      .map((e) => e.id);
    for (const id of ids) this.remove(id);
    return ids;
  }

  /**
   * 能力发现：只返回调用方"该看见"的端点。
   *
   * 规则（设计方案 §12.6）：
   *   · 自己注册的 → 完整（但仍然不含 baseUrl，插件不需要知道自己的地址）
   *   · ACL=allow  → 可见
   *   · ACL=ask    → 可见，标 requiresConsent（否则插件没法"先列出来让用户选"）
   *   · ACL=deny   → 不可见
   *   · 别人的端点 → 可见（否则"借用他人能力"不成立）
   */
  listForCaller(subject, acl, opts = {}) {
    const out = [];
    for (const ep of this.list()) {
      if (ep.enabled === false) continue;
      const view = publicView(ep);
      const verdict = acl ? acl.decide(subject, ep, opts) : { decision: 'ask', reason: 'no-acl' };
      if (verdict.decision === 'deny') continue;
      view.requiresConsent = verdict.decision !== 'allow';
      view.ready = this._hasCredential(ep);
      if (opts.tasks) {
        const wanted = Array.isArray(opts.tasks) ? opts.tasks : [opts.tasks];
        if (!wanted.some((t) => ADAPTER_TASKS[ep.adapter].includes(t))) continue;
      }
      out.push(view);
    }
    return out;
  }

  snapshot() {
    return {
      encrypted: this.secrets.isEncrypted ? this.secrets.isEncrypted() : true,
      // 设置页是唯一的写入口，它需要 baseUrl 才能编辑；plugins/MCP 走 list()，
      // 拿到的仍是脱敏视图。
      endpoints: this.list().map((ep) => settingsView(ep)),
      bindings: this.listBindings().map((b) => ({
        task: b.task, endpointId: b.endpointId, model: b.model, isDefault: b.isDefault,
      })),
    };
  }
}

module.exports = { ModelEndpointStore, publicView, settingsView };
