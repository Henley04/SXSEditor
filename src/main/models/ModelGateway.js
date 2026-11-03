'use strict';

/**
 * 模型调用网关。
 *
 * 所有调用（插件 / 面板 / MCP / 宿主自身）都从这里过，理由只有一条：授权、审计、
 * 限流、取消、超时这些事只要有一处旁路，就等于没有。
 *
 * 一次调用的完整生命周期：
 *
 *   校验 → 去重 → 解析端点 → ACL → （必要时）用户确认 → adapter → 流 → 终止 → 审计
 *
 * 三个必须守住的不变量：
 *
 *   1. **终止事件恰好一个**。done / error / cancelled 之后不允许再有任何事件；
 *      违约就断流并记 PROTOCOL_VIOLATION，结果作废。
 *   2. **背压不丢数据**。消费方慢时暂停生产；不可暂停的通道在上限处明确失败，
 *      绝不静默丢弃（LLM 丢 token 会破坏文本，生成类丢数据会破坏文件）。
 *   3. **不自动兜底**。没有默认端点就报 NEED_ENDPOINT，不挑第一个可用的 ——
 *      端点之间价差可能两个数量级，自动兜底等于替用户花钱。
 */

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const {
  EVENTS, TERMINAL_EVENTS, ERR, LIMITS, TASK_SPECS,
  validateInvokeRequest, inputBytes, localityOf,
} = require('../../shared/modelContract');

class ModelError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'ModelError';
    this.code = code;
    this.retryable = extra.retryable === true;
    if (extra.hint) this.hint = extra.hint;
    if (extra.details) this.details = extra.details;
  }
}

function errPayload(err) {
  if (!err) return { code: ERR.UPSTREAM_ERROR, message: 'unknown' };
  return {
    code: err.code || ERR.UPSTREAM_ERROR,
    message: err.message || String(err),
    retryable: err.retryable === true,
    ...(err.hint ? { hint: err.hint } : {}),
    ...(err.details ? { details: err.details } : {}),
  };
}

/**
 * 一次调用的句柄。调用方通过它取消，通过事件回调拿结果。
 */
class ModelHandle extends EventEmitter {
  constructor(id, subject, req) {
    super();
    this.id = id;
    this.subject = subject;
    this.task = req.task;
    this.state = 'pending';
    this.startedAt = 0;
    this.endedAt = 0;
    this._terminalSent = false;
    this._cancelFn = null;
    this._acks = { chunks: 0, bytes: 0 };
  }

  /** 消费方回执。网关据此放行生产方。 */
  ack(bytes = 0) {
    this._acks.chunks = Math.max(0, this._acks.chunks - 1);
    this._acks.bytes = Math.max(0, this._acks.bytes - bytes);
    this.emit('__ack', { chunks: this._acks.chunks, bytes: this._acks.bytes });
  }

  cancel(reason = 'user') {
    if (this.state !== 'pending' && this.state !== 'running') return false;
    this._cancelReason = reason;
    try {
      if (this._cancelFn) this._cancelFn(reason);
    } catch (_) { /* adapter 取消失败也要把状态置为 cancelled */ }
    return true;
  }

  get terminal() {
    return this._terminalSent;
  }
}

class ModelGateway {
  /**
   * @param {{
   *   store: object, acl: object, adapters: Map<string, object>,
   *   audit?: {record:Function}, consent?: Function, settings?: object,
   *   logger?: object, now?: Function
   * }} opts
   */
  constructor(opts) {
    this.store = opts.store;
    this.acl = opts.acl;
    this.adapters = opts.adapters || new Map();
    this.audit = opts.audit || { record: () => {} };
    this.consent = opts.consent || (async () => 'deny');
    /**
     * 全局开关（来自设置页）：
     *   localFree   本地端点免确认（插件与 MCP 共用），默认 true
     *   tokenBypass Map<tokenId, boolean> "跳过所有确认"
     */
    this.settings = Object.assign({ localFree: true, tokenBypass: new Map() }, opts.settings);
    this.log = opts.logger || console;
    this._now = opts.now || (() => Date.now());
    /** @type {Map<string, {handle:ModelHandle, createdAt:number, done:boolean, events:Array, result:any}>} */
    this._dedupe = new Map();
    this._seq = 0;
  }

  // ---------------------------------------------------------------- 公开 API
  /**
   * 发起一次调用。立即返回 handle，事件通过 onEvent 回调推送。
   *
   * @param {string} subject `plugin:<id>` / `mcp:<tokenId>` / `host`
   * @param {object} req { task, endpointId?, model?, input, clientRequestId? }
   * @param {{onEvent?:Function, via?:string}} opts
   */
  invoke(subject, req, opts = {}) {
    const reject = validateInvokeRequest(req);
    if (reject) {
      const h = new ModelHandle(`mh_${++this._seq}`, subject, req || { task: 'chat' });
      queueMicrotask(() => {
        h.state = 'error';
        h._terminalSent = true;
        this._emit(h, EVENTS.ERROR, { error: { code: ERR.INVALID_REQUEST, message: reject } }, opts);
      });
      return h;
    }

    const dedupeKey = req.clientRequestId
      ? `${subject}\u0000${req.clientRequestId}`
      : null;
    if (dedupeKey) {
      const hit = this._dedupe.get(dedupeKey);
      if (hit) {
        if (!hit.done) return hit.handle; // 在途：直接共用同一个 handle
        // 已完成：新开一个 handle，但把同样的终态补发过去，不再真的调一次
        const replay = new ModelHandle(hit.handle.id, subject, req);
        queueMicrotask(() => {
          replay.state = 'running';
          this._emit(replay, EVENTS.START, { replayed: true }, opts);
          replay.state = hit.handle.state;
          replay._terminalSent = true;
          for (const evt of hit.events) this._emit(replay, evt.type, evt.payload, opts);
        });
        return replay;
      }
    }

    const handle = new ModelHandle(`mh_${++this._seq}`, subject, req);
    if (dedupeKey) {
      this._dedupe.set(dedupeKey, { handle, createdAt: this._now(), done: false, events: [] });
      this._pruneDedupe();
    }
    this._run(handle, subject, req, opts, dedupeKey).catch((err) => {
      this._finish(handle, EVENTS.ERROR, { error: errPayload(err) }, opts, dedupeKey);
    });
    return handle;
  }

  /** 设置页开关变更时同步。 */
  setSettings(patch) {
    Object.assign(this.settings, patch);
  }

  // ---------------------------------------------------------------- 主流程
  async _run(handle, subject, req, opts, dedupeKey) {
    handle.startedAt = this._now();
    const spec = TASK_SPECS[req.task];
    const bytesIn = inputBytes(req.input);

    // 1. 解析端点
    const resolved = this.store.resolve(req.task, req.endpointId);
    if (!resolved.ok) {
      throw new ModelError(resolved.error, resolved.message, { details: { candidates: resolved.candidates } });
    }
    const endpoint = resolved.endpoint;
    handle.endpointId = endpoint.id;

    // 2. 授权
    const bypassAll = this._bypassFor(subject);
    const verdict = this.acl.decide(subject, endpoint, { bypassAll, localFree: this.settings.localFree });
    if (verdict.decision === 'deny') {
      throw new ModelError(ERR.PERMISSION_DENIED, `拒绝访问端点 ${endpoint.title || endpoint.id}`, {
        details: { reason: verdict.reason },
      });
    }
    let effective = verdict;
    if (verdict.decision === 'ask') {
      const answer = await this._askConsent({ subject, endpoint, task: req.task, bytesIn, output: spec.output });
      if (answer === 'deny') {
        throw new ModelError(ERR.PERMISSION_DENIED, '用户拒绝了本次调用', { details: { reason: 'consent-denied' } });
      }
      if (answer === 'unattended') {
        // 没有可应答的窗口：不抢焦点弹框，直接按拒绝处理。消息要与"用户按了拒绝"
        // 区分开，否则日志里两种完全不同的情况长得一模一样。
        throw new ModelError(ERR.PERMISSION_DENIED, '没有可应答的窗口，已按拒绝处理', {
          details: { reason: 'unattended' },
        });
      }
      effective = { decision: 'allow', scope: 'consent', reason: 'consent' };
    }

    // 3. 找 adapter
    const adapter = this.adapters.get(endpoint.adapter);
    if (!adapter) {
      throw new ModelError(ERR.ADAPTER_UNSUPPORTED, `宿主不支持 adapter：${endpoint.adapter}`);
    }

    // 4. 超时预算
    const idleMs = Math.min(
      Number(endpoint.idleTimeoutMs) > 0 ? Number(endpoint.idleTimeoutMs) : LIMITS.idleTimeoutMs,
      LIMITS.maxDurationMs,
    );
    const maxMs = Math.min(
      Number(endpoint.maxDurationMs) > 0 ? Number(endpoint.maxDurationMs) : LIMITS.maxDurationMs,
      LIMITS.maxDurationMs,
    );

    handle.state = 'running';
    this._emit(handle, EVENTS.START, {
      handleId: handle.id,
      endpoint: { id: endpoint.id, title: endpoint.title, provider: endpoint.provider, locality: localityOf(endpoint) },
      task: req.task,
      scope: effective.scope || '',
    }, opts);

    const abort = new AbortController();
    handle._cancelFn = (reason) => {
      abort.abort(reason);
      this._finish(handle, EVENTS.CANCELLED, { reason }, opts, dedupeKey);
    };

    let idleTimer = null;
    let maxTimer = null;
    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
      idleTimer = null;
      maxTimer = null;
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abort.abort('idle-timeout');
        this._finish(handle, EVENTS.ERROR, {
          error: { code: ERR.TIMEOUT, message: `超过 ${idleMs}ms 无响应`, retryable: true },
        }, opts, dedupeKey);
      }, idleMs);
    };
    maxTimer = setTimeout(() => {
      abort.abort('max-duration');
      this._finish(handle, EVENTS.ERROR, {
        error: { code: ERR.TIMEOUT, message: `超过总时长上限 ${maxMs}ms`, retryable: false },
      }, opts, dedupeKey);
    }, maxMs);
    armIdle();

    // 5. 跑 adapter，事件经 16ms 合并后下发
    const buffer = [];
    let bufferBytes = 0;
    let flushTimer = null;
    let paused = false;
    let chunkCount = 0;
    /**
     * 每次调用独立的流控句柄。不能挂在 adapter 上：同一个 adapter 会并发服务多个
     * 调用，adapter 级的 pause 会把别人的流一起停掉。
     * adapter 不填 pause/resume 就表示"这条通道不可暂停"（本地原子推理）。
     */
    const control = { pause: null, resume: null };

    const flush = () => {
      flushTimer = null;
      if (!buffer.length) return;
      const payload = buffer.length === 1
        ? buffer[0]
        : { data: buffer.map((b) => b.data).join(''), bytes: bufferBytes };
      buffer.length = 0;
      bufferBytes = 0;
      chunkCount++;
      if (chunkCount > LIMITS.maxChunks) {
        abort.abort('too-many-chunks');
        this._finish(handle, EVENTS.ERROR, {
          error: { code: ERR.PROTOCOL_VIOLATION, message: 'chunk 数量超出上限' },
        }, opts, dedupeKey);
        return;
      }
      handle._acks.chunks += 1;
      handle._acks.bytes += payload.bytes || 0;
      this._emit(handle, EVENTS.CHUNK, payload, opts);
      applyBackpressure();
    };

    const emit = (type, payload) => {
      if (handle.terminal) return;
      armIdle();
      if (type === EVENTS.PROGRESS) {
        this._emit(handle, EVENTS.PROGRESS, payload, opts);
        return;
      }
      if (type !== EVENTS.CHUNK) return;
      buffer.push({ data: payload.data, bytes: payload.bytes || 0 });
      bufferBytes += payload.bytes || 0;
      if (!flushTimer) flushTimer = setTimeout(flush, LIMITS.chunkFlushMs);
    };

    // 背压：ack 由 handle.ack() 触发；不可暂停的 adapter 超上限直接失败
    const applyBackpressure = () => {
      const over = handle._acks.chunks > LIMITS.ackWindowChunks
        || handle._acks.bytes > LIMITS.ackWindowBytes;
      if (!over) {
        if (paused) {
          paused = false;
          if (typeof control.resume === 'function') control.resume();
        }
        return;
      }
      if (typeof control.pause === 'function') {
        if (!paused) {
          paused = true;
          control.pause();
        }
        return;
      }
      // 不可暂停：再给一个窗口的余量，仍然超就失败（不丢数据，明确报错）。
      // 两个维度都要判：小 chunk 先撑爆条数，大 chunk 先撑爆字节。
      if (handle._acks.chunks > LIMITS.ackWindowChunks * 2
        || handle._acks.bytes > LIMITS.ackWindowBytes * 2) {
        abort.abort('backpressure');
        this._finish(handle, EVENTS.ERROR, {
          error: {
            code: ERR.BACKPRESSURE_OVERFLOW,
            message: '消费方读取过慢，缓冲已满',
            retryable: false,
            hint: 'consumer_too_slow',
          },
        }, opts, dedupeKey);
      }
    };
    handle.on('__ack', applyBackpressure);

    try {
      await adapter.invoke({
        endpoint,
        task: req.task,
        model: (resolved.binding && resolved.binding.model) || req.model || null,
        input: req.input,
        signal: abort.signal,
        secret: this.store.getSecret(endpoint.id),
      }, emit, control);
    } catch (err) {
      clearTimers();
      if (handle.terminal) return;
      // 用户取消时 adapter 通常抛 AbortError，别把它记成上游失败
      if (abort.signal.aborted && abort.signal.reason === 'user') {
        this._finish(handle, EVENTS.CANCELLED, { reason: 'user' }, opts, dedupeKey);
        return;
      }
      this._finish(handle, EVENTS.ERROR, { error: errPayload(err) }, opts, dedupeKey);
      return;
    }

    clearTimers();
    if (flushTimer) clearTimeout(flushTimer);
    if (typeof control.resume === 'function') control.resume();
    flush();
    if (handle.terminal) return;
    this._finish(handle, EVENTS.DONE, { endpointId: endpoint.id }, opts, dedupeKey);
  }

  _bypassFor(subject) {
    if (!subject.startsWith('mcp:')) return false;
    const tokenId = subject.slice(4);
    const map = this.settings.tokenBypass;
    return !!(map && typeof map.get === 'function' && map.get(tokenId));
  }

  /** 第一次调用时的确认。返回 'allow' | 'deny'。超时按拒绝处理。 */
  async _askConsent(info) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), LIMITS.consentTimeoutMs);
    });
    try {
      const answer = await Promise.race([
        Promise.resolve(this.consent(info)),
        timeout,
      ]);
      if (answer === 'deny' || answer === 'unattended') {
        // 两种都不是"允许"，但原因不同：一种是用户按了拒绝，一种是压根没人
        // 在电脑前（窗口没有焦点）。分开记，否则事后无法解释这次失败。
        this.audit.record({
          kind: 'consent', subject: info.subject, endpointId: info.endpoint.id,
          outcome: answer === 'unattended' ? 'unattended' : 'denied',
          ...(answer === 'unattended' ? { code: 'CONSENT_UNATTENDED' } : {}),
        });
        return answer;
      }
      if (answer === 'timeout') {
        this.audit.record({
          kind: 'consent', subject: info.subject, endpointId: info.endpoint.id,
          outcome: 'timeout', code: ERR.CONSENT_TIMEOUT,
        });
        return 'deny';
      }
      // once / session / always 都落成 ACL 记录，区别只在 scope
      const scope = answer === 'always' ? 'always' : answer === 'once' ? 'once' : 'session';
      this.acl.grant(info.subject, info.endpoint, 'allow', scope);
      this.audit.record({
        kind: 'consent', subject: info.subject, endpointId: info.endpoint.id,
        outcome: 'granted', scope,
      });
      return 'allow';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 发终止事件。这是唯一允许把 handle 置为终态的地方。 */
  _finish(handle, type, payload, opts, dedupeKey) {
    if (handle.terminal) return;
    handle._terminalSent = true;
    handle.state = type === EVENTS.DONE ? 'done' : type === EVENTS.CANCELLED ? 'cancelled' : 'error';
    handle.endedAt = this._now();
    handle.removeAllListeners('__ack');
    this._emit(handle, type, payload, opts);

    // once 授权用完即删：下次调用重新问
    if (handle.subject && handle.endpointId) {
      try { this.acl.consumeOnce(handle.subject, handle.endpointId); } catch (_) { /* ignore */ }
    }

    this.audit.record({
      kind: 'invoke',
      subject: handle.subject,
      endpointId: handle.endpointId || '',
      task: handle.task,
      outcome: handle.state,
      code: payload && payload.error ? payload.error.code : '',
      ms: handle.endedAt - handle.startedAt,
      via: (opts && opts.via) || 'api',
      handleId: handle.id,
    });

    if (dedupeKey) {
      const row = this._dedupe.get(dedupeKey);
      if (row) {
        // cancelled / failed 不缓存：否则一次网络抖动后，重试永远拿到那个失败结果
        if (handle.state === 'done') {
          row.done = true;
          row.events = [{ type, payload }];
        } else {
          this._dedupe.delete(dedupeKey);
        }
      }
    }
  }

  _emit(handle, type, payload, opts) {
    // 终态之后再来的事件：协议违规。断流并让这次结果作废。
    if (handle.terminal && !TERMINAL_EVENTS.includes(type)) {
      this.audit.record({
        kind: 'protocol', subject: handle.subject, handleId: handle.id, code: ERR.PROTOCOL_VIOLATION,
      });
      return;
    }
    try {
      // streamKey 由调用方给（插件自己生成的请求号）：事件可能比 invoke() 的
      // 返回值更早到达，调用方需要它才能把事件对上自己那次调用。
      const envelope = { type, handleId: handle.id, ...(opts && opts.streamKey ? { streamKey: opts.streamKey } : {}), ...payload };
      if (opts && typeof opts.onEvent === 'function') opts.onEvent(envelope);
      handle.emit('event', envelope);
    } catch (err) {
      this.log.warn('[models] 事件回调抛错：', err && err.message);
    }
  }

  _pruneDedupe() {
    const cutoff = this._now() - LIMITS.dedupeWindowMs;
    for (const [key, row] of this._dedupe) {
      if (row.createdAt < cutoff) this._dedupe.delete(key);
    }
  }

  /** 供审计/诊断：当前在途调用。 */
  get inflight() {
    let n = 0;
    for (const row of this._dedupe.values()) if (!row.done) n++;
    return n;
  }
}

/** 生成一个客户端请求 id（调用方未提供时可用）。 */
function newRequestId() {
  return crypto.randomUUID();
}

module.exports = { ModelGateway, ModelHandle, ModelError, errPayload, newRequestId };
