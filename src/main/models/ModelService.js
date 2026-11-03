'use strict';

/**
 * 模型调用面的门面（主进程）。
 *
 * 把 store / acl / gateway / adapters / audit 装配起来，对上只暴露三类接口：
 *
 *   调用方（插件 / 面板 / MCP / 宿主）→ invoke / cancel / ack / list
 *   设置页                          → snapshot / 端点 CRUD / 绑定 / 授权
 *   管理器与诊断                     → audit / stats
 *
 * 事件路由不在这里决定"推给谁"：service 只知道"有事件发生"，由外部注入的
 * `eventSink(subject, event)` 选择通道（插件 runtime / 渲染层 / MCP SSE）。
 * 这样 service 可以脱离 Electron 单测。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { ERR, TASKS, LIMITS, localityOf, validateInvokeRequest } = require('../../shared/modelContract');
const { ModelEndpointStore, publicView } = require('./ModelEndpointStore');
const { ModelAcl, fingerprintOf } = require('./ModelAcl');
const { ModelGateway } = require('./ModelGateway');
const { ModelAudit } = require('./ModelAudit');
const { ModelHandleStore } = require('./ModelHandleStore');
const { createAdapters } = require('./adapters');

function readOrCreateKey(file, logger) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw.length >= 32) return Buffer.from(raw, 'hex');
  } catch (err) {
    if (err && err.code !== 'ENOENT') logger.warn('[models] 句柄密钥读取失败：', err.message);
  }
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logger.warn('[models] 句柄密钥落盘失败：', err && err.message);
  }
  return key;
}

class ModelService {
  /**
   * @param {{
   *   dir: string,
   *   secrets: object,
   *   logger?: object,
   *   now?: Function,
   *   fetchImpl?: Function,
   *   localBackends?: Map<string, object>,
   *   consent?: Function,
   *   eventSink?: Function
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.dir) throw new Error('ModelService 需要 dir');
    this.dir = opts.dir;
    this.log = opts.logger || console;
    this._now = opts.now || (() => Date.now());
    this._eventSink = opts.eventSink || (() => {});

    fs.mkdirSync(this.dir, { recursive: true });

    this.audit = new ModelAudit({ file: path.join(this.dir, 'audit.json'), logger: this.log, now: this._now });
    this.store = new ModelEndpointStore({
      dir: this.dir,
      secrets: opts.secrets,
      logger: this.log,
      now: this._now,
    });
    this.acl = new ModelAcl({ store: this._aclStore(), now: this._now });
    this.handles = new ModelHandleStore({
      dir: path.join(this.dir, 'cache'),
      key: readOrCreateKey(path.join(this.dir, 'handle.key'), this.log),
      now: this._now,
      logger: this.log,
    });

    const { adapters, local } = createAdapters({
      fetchImpl: opts.fetchImpl,
      logger: this.log,
      localBackends: opts.localBackends,
    });
    this.adapters = adapters;
    this.local = local;

    this.gateway = new ModelGateway({
      store: this.store,
      acl: this.acl,
      adapters,
      audit: this.audit,
      logger: this.log,
      now: this._now,
      consent: opts.consent || (async () => 'deny'),
      settings: { localFree: true, tokenBypass: new Map() },
    });

    /** @type {Map<string, {handle:object, subject:string}>} */
    this._handles = new Map();
  }

  _aclStore() {
    const file = path.join(this.dir, 'model-acl.json');
    return {
      load: () => {
        try {
          const raw = fs.readFileSync(file, 'utf8');
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
          return [];
        }
      },
      save: (rows) => {
        try {
          const tmp = `${file}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(rows), 'utf8');
          fs.renameSync(tmp, file);
        } catch (err) {
          this.log.warn('[models] 授权记录落盘失败：', err && err.message);
        }
      },
    };
  }

  /** 换掉确认回调（主进程在窗口就绪后接上真正的弹窗）。 */
  setConsentHandler(fn) {
    this.gateway.consent = fn;
  }

  setEventSink(fn) {
    this._eventSink = fn;
  }

  /** 设置页的两个全局开关。 */
  setSettings({ localFree, tokenBypass }) {
    if (typeof localFree === 'boolean') this.gateway.settings.localFree = localFree;
    if (tokenBypass instanceof Map) this.gateway.settings.tokenBypass = tokenBypass;
    else if (Array.isArray(tokenBypass)) {
      this.gateway.settings.tokenBypass = new Map(tokenBypass.map((id) => [id, true]));
    }
  }

  // ------------------------------------------------------------ 调用
  /**
   * @param {string} subject
   * @param {object} req
   * @param {{via?:string, onEvent?:Function}} [opts]
   * @returns {{handleId:string}} 或 { error }
   */
  invoke(subject, req, opts = {}) {
    const bad = validateInvokeRequest(req);
    if (bad) return { error: { code: ERR.INVALID_REQUEST, message: bad } };

    const handle = this.gateway.invoke(subject, req, {
      via: opts.via || 'api',
      streamKey: opts.streamKey,
      onEvent: (evt) => {
        if (typeof opts.onEvent === 'function') {
          try { opts.onEvent(evt); } catch (_) { /* 调用方回调抛错不能拖垮网关 */ }
        }
        this._emit(subject, evt);
      },
    });
    this._handles.set(handle.id, { handle, subject });
    // 终止后保留一小会儿，让迟到的 cancel/ack 不会报"未知 handle"
    const cleanup = () => {
      setTimeout(() => this._handles.delete(handle.id), 60 * 1000).unref?.();
    };
    handle.on('event', (evt) => {
      if (evt.type === 'done' || evt.type === 'error' || evt.type === 'cancelled') cleanup();
    });
    return { handleId: handle.id };
  }

  cancel(subject, handleId) {
    const row = this._handles.get(handleId);
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (row.subject !== subject) return { ok: false, error: ERR.PERMISSION_DENIED };
    return { ok: row.handle.cancel('user') };
  }

  ack(subject, handleId, bytes = 0) {
    const row = this._handles.get(handleId);
    if (!row) return { ok: false };
    if (row.subject !== subject) return { ok: false, error: ERR.PERMISSION_DENIED };
    row.handle.ack(Number(bytes) || 0);
    return { ok: true };
  }

  /** 解析某次调用的目标端点（MCP 需要在调之前做 scope 判定）。 */
  resolveEndpoint(task, endpointId) {
    return this.store.resolve(task, endpointId);
  }

  /** 能力发现。调用方只看见被允许（或可能被允许）的端点。 */
  list(subject, { task, bypassAll = false } = {}) {
    const opts = { localFree: this.gateway.settings.localFree, bypassAll };
    if (task) opts.tasks = task;
    const rows = this.store.listForCaller(subject, this.acl, opts);
    // preferredBy：哪些插件为这个端点标了 ★（只影响展示，不影响路由）
    const prefs = this._preferences();
    for (const row of rows) {
      row.preferredBy = prefs.filter((p) => p.endpoint === row.id).map((p) => ({ task: p.task, note: p.note, pluginId: p.pluginId }));
    }
    return { endpoints: rows };
  }

  /** 插件 manifest 里声明的 modelPreferences，注册时由 PluginService 写进来。 */
  setPreferences(rows) {
    this._prefs = Array.isArray(rows) ? rows : [];
  }

  _preferences() {
    return this._prefs || [];
  }

  _emit(subject, evt) {
    try {
      this._eventSink(subject, evt);
    } catch (err) {
      this.log.warn('[models] 事件推送失败：', err && err.message);
    }
  }

  /** 插件卸载 / token 吊销。 */
  dropSubject(subject) {
    this.acl.revokeAllForSubject(subject);
    for (const [id, row] of [...this._handles]) {
      if (row.subject === subject) {
        row.handle.cancel('subject-unloaded');
        this._handles.delete(id);
      }
    }
  }

  // ------------------------------------------------------------ 设置页
  snapshot() {
    const base = this.store.snapshot();
    return {
      ...base,
      tasks: TASKS,
      acl: this.acl.snapshot(),
      settings: {
        localFree: this.gateway.settings.localFree,
        tokenBypass: [...this.gateway.settings.tokenBypass.keys()],
      },
      limits: {
        idleTimeoutMs: LIMITS.idleTimeoutMs,
        maxDurationMs: LIMITS.maxDurationMs,
        inlineBytes: LIMITS.inlineBytes,
      },
    };
  }

  upsertEndpoint(input) {
    const r = this.store.upsert(input);
    if (!r.ok) return r;
    return { ok: true, endpoint: publicView(r.endpoint) };
  }

  removeEndpoint(id) {
    const r = this.store.remove(id);
    if (!r.ok) return r;
    // 端点没了，授权也失去意义；连带取消在这个端点上跑着的调用
    this.acl.revokeAllForEndpoint(id);
    for (const [handleId, row] of [...this._handles]) {
      if (row.handle.endpointId === id) {
        row.handle.cancel('endpoint-removed');
        this._handles.delete(handleId);
      }
    }
    return r;
  }

  bind(payload) {
    return this.store.bind(payload);
  }

  unbind(task, endpointId) {
    return this.store.unbind(task, endpointId);
  }

  setDefault(task, endpointId) {
    return this.store.setDefault(task, endpointId);
  }

  listBindings(task) {
    return this.store.listBindings(task).map((b) => ({
      task: b.task,
      endpointId: b.endpointId,
      model: b.model,
      isDefault: b.isDefault,
      endpoint: b.endpoint ? publicView(b.endpoint) : null,
    }));
  }

  grant(subject, endpointId, decision, scope) {
    const ep = this.store.get(endpointId);
    if (!ep) return { ok: false, error: '端点不存在' };
    this.acl.grant(subject, ep, decision, scope);
    return { ok: true };
  }

  revoke(subject, endpointId) {
    return { ok: this.acl.revoke(subject, endpointId) };
  }

  setSubjectPolicy(subject, policy) {
    this.acl.setSubjectPolicy(subject, policy);
    return { ok: true };
  }

  auditList(query) {
    return this.audit.list(query);
  }

  dispose() {
    for (const row of this._handles.values()) row.handle.cancel('shutdown');
    this._handles.clear();
    this.audit.dispose();
  }
}

module.exports = { ModelService, fingerprintOf, localityOf };
