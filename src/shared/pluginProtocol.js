'use strict';
/**
 * 插件 RPC 的消息形状与错误约定（CJS）。
 *
 * 三种消息共用一套 id 空间，方向由 kind 决定：
 *   { v:2, kind:'req', id, method, params }
 *   { v:2, kind:'res', id, ok:true, result } | { ok:false, error:{code,message,detail} }
 *   { v:2, kind:'evt', event, payload }
 *
 * 约定：
 *   · id 单调递增，由发起方生成，回包必须原样带回；
 *   · 任何字段都可能为空；跨进程边界一律按"不可信输入"处理；
 *   · 错误只携带脱敏后的 message（路径不落地到插件的可见域之外）。
 */
const { API_VERSION, ERR, MSG } = require('./pluginApi.js');

class PluginError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'PluginError';
    this.code = code || ERR.INTERNAL;
    this.detail = detail;
  }

  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

function makeRequest(id, method, params) {
  return { v: API_VERSION, kind: MSG.REQ, id, method, params };
}

function makeResult(id, result) {
  return { v: API_VERSION, kind: MSG.RES, id, ok: true, result };
}

function makeError(id, err) {
  const code = (err && err.code) || ERR.INTERNAL;
  const message = (err && err.message) || String(err);
  return {
    v: API_VERSION,
    kind: MSG.RES,
    id,
    ok: false,
    error: { code, message: String(message).slice(0, 2000), detail: err && err.detail },
  };
}

function makeEvent(event, payload) {
  return { v: API_VERSION, kind: MSG.EVT, event, payload };
}

/** 判断一条入站消息是否是可处理的结构（防插件向宿主注入畸形对象）。 */
function isMessage(msg) {
  return !!msg && typeof msg === 'object' && msg.kind === MSG.REQ
    && typeof msg.id !== 'undefined' && typeof msg.method === 'string';
}

/**
 * 只保留可结构化克隆的部分。structuredClone 会在遇到函数/Proxy 时抛错，
 * 这里降级成 JSON 语义，避免一条坏回包把整条通道打挂。
 */
function sanitizeForWire(value, depth = 0) {
  if (depth > 8) return null;
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (ArrayBuffer.isView(value)) {
    // 视图按底层 buffer 的副本传，避免把整个 ArrayBuffer 拖过去
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) {
      const s = sanitizeForWire(v, depth + 1);
      out.push(s === undefined ? null : s);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const s = sanitizeForWire(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

module.exports = {
  PluginError,
  makeRequest,
  makeResult,
  makeError,
  makeEvent,
  isMessage,
  sanitizeForWire,
};
