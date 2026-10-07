/**
 * 插件的执行环境（executionMode='worker'，默认模式）。
 *
 * 本文件有两个身份：
 *   1. 被 `new Worker(__filename)` 拉起时的 **worker 入口**：require 插件入口、
 *      执行方法调用、把插件对 host 的调用转发回主进程；
 *   2. 被主进程 pluginHost.js `require()` 时的 **跨线程编解码模块**（导出的
 *      encodeWire / decodeWire 两侧共用；isMainThread 为真时不进消息循环）。
 *
 * ## 为什么要这套东西（P0）
 *
 * 插件裸 require 进主进程时，插件里一个同步忙等 / 死循环会占死主进程事件循环，
 * 宿主那套 `Promise.race + setTimeout` 的"超时"永远不会触发（定时器本身排不上
 * 队），于是所有窗口一起冻结。worker 模式下：
 *   · 插件代码跑在独立线程，主进程事件循环永远不被插件占死；
 *   · 超时到期时主进程 `worker.terminate()` —— 这是真正可抢占的中断（实测对
 *     一个正在忙等的 worker 调用 terminate 只需 ~5ms）；
 *   · worker 被杀掉后，下一次调用会重新拉起一个新的。
 *
 * ## 跨线程怎么保证"插件看到的东西不变"
 *
 * host 对象（emitProgress / emitAudio / log / blockPlayback / isCancelled /
 * diagnostics）在 worker 侧由代理实现：插件照常写 `host.emitProgress(50)`，
 * 代理把它变成一条消息，主进程再调用真正的 host 实现（节流、ticket、IPC 推送
 * 全部留在主进程）。约定：**代理方法的返回值不代表主进程的处理结果**（跨线程
 * 拿不到同步返回值），一律返回 true 或 ticket 句柄；插件不应该用它们的返回值
 * 做分支判断。
 *
 * 请求里的大块音频（options.refAudioWavBuffer / pitchCurveF0 / refF0Data、
 * request.scratch）与返回的 pcm 都进 **transfer list**：ArrayBuffer 所有权直接
 * 搬家，不做 structuredClone 复制（零拷贝）。代价是发送方的 TypedArray 会变成
 * detached（byteLength === 0），调用方不能再用同一个数组发起第二次调用。
 *
 * 函数无法跨线程搬运：`ctx.log` / `ctx.getSetting` / `options.onProgress` /
 * `options.refF0Extractor` 等在主进程保留真身，插件侧拿到的是同名代理，调用它
 * 会把参数带回主进程执行（`await` 能拿到返回值）。Symbol / Map / Set 等不可克隆
 * 值会被登记后丢弃，而不是让整次调用抛错。
 */

'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');

// ---------------------------------------------------------------------------
// 线上标记：跨线程搬运时用这些形状表达"这里原本放不下"
// ---------------------------------------------------------------------------

/** 原本是函数 → 换成回调代理 */
const WIRE_FN = 'fn';
/** 请求里的 host 参数位 → 换成 worker 侧的 host 代理 */
const WIRE_HOST = 'host';
/** 原本是 AbortSignal → 换成受主线程取消控制的布尔代理 */
const WIRE_ABORT = 'abort';
/** 不可克隆值（Symbol / Map / Set / 无枚举字段的 exotic 对象 / 过深）→ 丢弃 */
const WIRE_SKIP = 'skip';

/** 递归深度上限：插件塞一个自引用的巨型结构不应该把这一侧爬到卡死。 */
const MAX_WIRE_DEPTH = 24;
/** 单次消息允许遍历的结构节点上限（正常请求远小于这个量级）。 */
const MAX_WIRE_NODES = 200000;

/**
 * 回调 id 计数器：模块级，保证同一个进程 / 线程里 cbId 全局唯一 —— 主进程侧
 * `initialize` 的 ctx 回调与后续调用的回调共用一张查找表，id 不能重复。
 */
let _wireCbSeq = 0;

/**
 * 错误收敛：跨线程只传文本，不带堆栈。
 * @param {unknown} err
 */
function describeError(err) {
  if (!err) return 'unknown plugin error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name;
  if (typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

/**
 * 是否"普通对象"（Object.prototype 或无原型）。
 * 空对象必须能被原样搬过去（`options: {}` 是合法入参），所以只有**非普通对象**
 * 又没有可枚举字段时（Map / Set / Error / 自定义类实例）才判定搬不动。
 * @param {object} value
 */
function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 是否 AbortSignal（鸭子类型判定，`instanceof` 跨 realm 不可靠）。
 * @param {unknown} v
 */
function isAbortSignalLike(v) {
  return !!v && typeof v === 'object'
    && typeof v.aborted === 'boolean'
    && typeof v.addEventListener === 'function';
}

/**
 * 创建编码上下文。
 * @param {(hint:string)=>void} [onSkip] 丢弃不可克隆值时的回调（可选）
 */
function newEncodeContext(onSkip) {
  return {
    /** @type {Set<ArrayBuffer>} 需要 transfer 的底层内存块（去重） */
    transfer: new Set(),
    /**
     * @type {Map<number, {fn:Function, trail:string}>} cbId -> 回调槽位。
     * 编码侧把真函数留在这里并只把 cbId 送过线程边界；对侧调用时按 cbId 回来找。
     */
    callbacks: new Map(),
    skipped: [],
    nodeCount: 0,
    onSkip: typeof onSkip === 'function' ? onSkip : null,
  };
}

/**
 * 登记一次"这个值被丢掉了"，让宿主能把它写进日志 —— 插件作者不会莫名其妙
 * 地少收到一个字段。
 * @param {object} ctx
 * @param {string} trail 字段路径，如 `options.refF0Extractor`
 * @param {string} kind
 */
function noteSkip(ctx, trail, kind) {
  if (ctx.skipped.length < 32) ctx.skipped.push(`${trail}(${kind})`);
  if (ctx.onSkip) ctx.onSkip(`${trail}(${kind})`);
}

/**
 * @param {string} kind
 * @returns {{__pluginWire:string, kind:string}}
 */
function skipMarker(kind) {
  return { __pluginWire: WIRE_SKIP, kind };
}

/**
 * 编码：把任意入参折叠成可 structuredClone 的形态。
 *
 *   · TypedArray / ArrayBuffer：保持**同一个实例**并把底层 ArrayBuffer 登记进
 *     transfer 集合 → postMessage 零拷贝搬家，发送方随之 detach；
 *   · 函数：换成回调代理标记；
 *   · Symbol / Map / Set / 深不见底的结构：换成 skip 标记（对侧看到 undefined），
 *     不让整次调用因为一个不可克隆值而失败。
 *
 * @param {unknown} value
 * @param {object} ctx newEncodeContext() 的结果
 * @param {string} [trail]
 * @param {number} [depth]
 * @returns {unknown}
 */
function encodeWire(value, ctx, trail, depth) {
  const at = trail || '$';
  const level = depth || 0;
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return value;

  if (t === 'function') {
    const cbId = ++_wireCbSeq;
    ctx.callbacks.set(cbId, { fn: value, trail: at });
    return { __pluginWire: WIRE_FN, cbId, name: value.name || '' };
  }
  if (t === 'symbol') {
    noteSkip(ctx, at, 'symbol');
    return skipMarker('symbol');
  }
  if (level > MAX_WIRE_DEPTH) {
    noteSkip(ctx, at, 'too-deep');
    return skipMarker('too-deep');
  }
  if (++ctx.nodeCount > MAX_WIRE_NODES) {
    noteSkip(ctx, at, 'too-many-nodes');
    return skipMarker('too-many-nodes');
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => encodeWire(item, ctx, `${at}[${i}]`, level + 1));
  }
  if (value instanceof Date || value instanceof RegExp) return value;
  if (value instanceof ArrayBuffer) {
    ctx.transfer.add(value);
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    // SharedArrayBuffer 不可 transfer（也不能 detach），按其本来形态传递
    const buf = value.buffer;
    if (buf instanceof ArrayBuffer) ctx.transfer.add(buf);
    return value;
  }

  if (typeof value === 'object') {
    // 标记透传：调用方可能直接塞标记进来（例如 host 参数位）
    if (typeof value.__pluginWire === 'string') return { ...value };
    if (isAbortSignalLike(value)) return { __pluginWire: WIRE_ABORT };
    if (!isPlainObject(value) && Object.keys(value).length === 0) {
      // 搬不动：字段全在原型上或内部槽里（Map / Set / Error / 自定义类实例），
      // 转过去也是个空壳，宁可明确丢弃并记日志，也不要让对侧收到一个假 `{}`。
      const name = value.constructor && value.constructor.name ? value.constructor.name : 'object';
      noteSkip(ctx, at, `unsupported:${name}`);
      return skipMarker(name);
    }
    const out = {};
    for (const key of Object.keys(value)) out[key] = encodeWire(value[key], ctx, `${at}.${key}`, level + 1);
    return out;
  }

  noteSkip(ctx, at, `unsupported:${t}`);
  return skipMarker(String(t));
}

/**
 * 解码：把标记还原成对侧能直接用的东西（TypedArray 已由 structuredClone 还原，
 * 函数 → 回调代理，host / abortSignal → 本地代理对象）。
 *
 * @param {unknown} value
 * @param {object} ctx {linkFn(cbId):Function, host:object, abortSignal:object}
 * @param {number} [depth]
 */
function decodeWire(value, ctx, depth) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (typeof value.__pluginWire === 'string') {
    switch (value.__pluginWire) {
      case WIRE_FN: return ctx.linkFn(value.cbId);
      case WIRE_HOST: return ctx.host;
      case WIRE_ABORT: return ctx.abortSignal;
      case WIRE_SKIP: return undefined;
      default: return value;
    }
  }
  const level = depth || 0;
  if (Array.isArray(value)) return value.map((item) => decodeWire(item, ctx, level + 1));
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (value instanceof Date || value instanceof RegExp) return value;
  if (level > MAX_WIRE_DEPTH) return undefined;

  const out = {};
  for (const key of Object.keys(value)) out[key] = decodeWire(value[key], ctx, level + 1);
  return out;
}

/** 主进程侧构造"host 参数位"标记 —— 放进 args 里交给 encodeWire。 */
function hostSlot() {
  return { __pluginWire: WIRE_HOST };
}

module.exports = {
  WIRE_FN,
  WIRE_HOST,
  WIRE_ABORT,
  WIRE_SKIP,
  MAX_WIRE_DEPTH,
  MAX_WIRE_NODES,
  newEncodeContext,
  encodeWire,
  decodeWire,
  hostSlot,
  describeError,
};

// ===========================================================================
// 以下只在 worker 线程里执行（被主进程当编解码库 require 时不会进来）
// ===========================================================================

function startWorkerRuntime() {
  /** 插件模块（require 后由 worker 进程内缓存，worker 存活期间同一实例） */
  let pluginModule = null;
  /**
   * 只用于"取消 / 回调"的调用现场表：callId -> { tickets, cancelledRef }。
   * 上限 128 条，超出后丢最旧的 —— 它只影响"调用结束后才姗姗来迟的 host 回调"
   * 能不能被认出来，不参与正确性判断。
   */
  const CALLS_MAX_ENTRIES = 128;
  const calls = new Map();
  /**
   * 主线程回调返回值的等待队列：reqId -> {resolve, reject}
   * （跨线程回调天然异步，插件必须 await 才能拿到返回值）
   */
  const replies = new Map();
  let replySeq = 0;

  /**
   * 发消息给主进程；transfer 失败时降级为复制，不让整次调用崩掉。
   * @param {object} msg
   * @param {ArrayBuffer[]} [transfer]
   */
  function post(msg, transfer) {
    if (!parentPort) return;
    try {
      if (transfer && transfer.length) parentPort.postMessage(msg, transfer);
      else parentPort.postMessage(msg);
    } catch (err) {
      try {
        parentPort.postMessage({ type: 'failed', error: `向主进程投递消息失败：${describeError(err)}` });
      } catch (_) { /* 彻底发不出去也就无能为力了 */ }
    }
  }

  /**
   * 调用主进程的真函数；插件侧拿到的是 Promise（async 回调如 refF0Extractor
   * 用 `await` 即可，语义与 in-process 模式一致）。
   *
   * 只负责把请求发出去： cbId 是否真的存在由主进程判断（这里拿不到真函数表），
   * 查不到时主进程会回 ok:true + undefined，而不是报错。
   * @param {number} cbId
   * @param {Array} args
   */
  function invokeRemote(cbId, args) {
    const reqId = ++replySeq;
    const ctx = newEncodeContext();
    const encodedArgs = args.map((a, i) => encodeWire(a, ctx, `args[${i}]`, 0));
    const promised = new Promise((resolve, reject) => {
      replies.set(reqId, { resolve, reject });
    });
    post({ type: 'callback', cbId, reqId, args: encodedArgs }, [...ctx.transfer]);
    return promised;
  }

  /**
   * 构造插件看到的 host 代理 + abortSignal 代理。
   *
   * 形状必须和 in-process 模式逐字段一致，插件代码不需要也不应该区分自己跑在
   * 哪个模式里。
   *
   * @param {string} callId
   * @param {string[]} ticketPool 主进程预先分配好的 ticket id（够单次调用配额）
   */
  function makeCallProxy(callId, ticketPool) {
    const state = { cancelled: false, tickets: new Set() };

    const host = {
      emitProgress(progress) {
        post({ type: 'host', callId, kind: 'progress', value: progress });
        return true;
      },
      emitAudio(chunk) {
        if (!chunk || typeof chunk !== 'object') return false;
        const ctx = newEncodeContext();
        const payload = encodeWire(chunk, ctx, 'chunk', 0);
        post({
          type: 'host', callId, kind: 'audio',
          value: payload,
        }, [...ctx.transfer]);
        return true;
      },
      log(level, message) {
        post({ type: 'host', callId, kind: 'log', level, message: String(message) });
        return true;
      },
      diagnostics(obj) {
        if (!obj || typeof obj !== 'object') return false;
        const ctx = newEncodeContext();
        post({ type: 'host', callId, kind: 'diagnostics', value: encodeWire(obj, ctx, 'diagnostics', 0) }, [...ctx.transfer]);
        return true;
      },
      blockPlayback(payload) {
        const ticketId = ticketPool && ticketPool.length ? ticketPool.shift() : null;
        if (!ticketId) {
          post({ type: 'host', callId, kind: 'log', level: 'warn', message: 'blockPlayback 超出单次调用的 ticket 配额' });
          return null;
        }
        state.tickets.add(ticketId);
        post({
          type: 'host', callId, kind: 'ticket-start', ticketId,
          value: encodeWire(payload || {}, newEncodeContext(), 'payload', 0),
        });
        return {
          id: ticketId,
          update(next) {
            if (!state.tickets.has(ticketId)) return false;
            post({
              type: 'host', callId, kind: 'ticket-update', ticketId,
              value: encodeWire(next || {}, newEncodeContext(), 'update', 0),
            });
            return true;
          },
          end() {
            if (!state.tickets.has(ticketId)) return false;
            state.tickets.delete(ticketId);
            post({ type: 'host', callId, kind: 'ticket-end', ticketId });
            return true;
          },
          isCancelled() {
            return state.cancelled;
          },
        };
      },
      isCancelled() {
        return state.cancelled;
      },
    };

    return {
      state,
      host,
      linkFn: (cbId) => (...rest) => invokeRemote(cbId, rest),
      abortSignal: {
        get aborted() { return state.cancelled; },
        get reason() { return state.cancelled ? new Error('plugin call cancelled') : undefined; },
        addEventListener() {},
        removeEventListener() {},
        throwIfAborted() { if (state.cancelled) throw new Error('plugin call cancelled'); },
      },
    };
  }

  /**
   * 执行插件方法并把结果搬回主进程。
   * @param {{callId:string, method:string, args:Array, ticketPool:string[]}} msg
   */
  async function runCall(msg) {
    const { callId, method, args } = msg;
    if (!pluginModule || typeof pluginModule[method] !== 'function') {
      post({ type: 'result', callId, ok: false, error: `插件未实现 ${method}()` });
      return;
    }

    const proxy = makeCallProxy(callId, Array.isArray(msg.ticketPool) ? msg.ticketPool : []);
    const entry = {
      tickets: proxy.state.tickets,
      cancelledRef: proxy.state,
    };
    calls.set(callId, entry);
    if (calls.size > CALLS_MAX_ENTRIES) {
      calls.delete(calls.keys().next().value);
    }

    let argv;
    try {
      const wireCtx = {
        host: proxy.host,
        abortSignal: proxy.abortSignal,
        linkFn: proxy.linkFn,
      };
      argv = (args || []).map((a) => decodeWire(a, wireCtx, 0));
    } catch (err) {
      post({ type: 'result', callId, ok: false, error: `参数还原失败：${describeError(err)}` });
      return;
    }

    try {
      const raw = await pluginModule[method](...argv);
      const ctx = newEncodeContext();
      const value = encodeWire(raw, ctx, 'result', 0);
      post({ type: 'result', callId, ok: true, value }, [...ctx.transfer]);
    } catch (err) {
      post({ type: 'result', callId, ok: false, error: describeError(err) });
    }
  }

  /**
   * 载入插件入口，并把契约校验需要的元数据回给主进程 —— 主进程据此校验，
   * 不需要自己 require 插件（require 只发生在这个线程里）。
   * @param {{entry:string}} msg
   */
  function handleInit(msg) {
    let mod;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      mod = require(msg.entry);
    } catch (err) {
      post({ type: 'meta', ok: false, error: `require 入口失败：${describeError(err)}` });
      return;
    }
    if (!mod || typeof mod !== 'object') {
      post({ type: 'meta', ok: false, error: '入口模块必须导出一个对象（module.exports = {...}）' });
      return;
    }
    pluginModule = mod;

    const meta = {
      id: mod.id,
      name: mod.name,
      version: mod.version,
      apiVersion: mod.apiVersion,
      capabilities: mod.capabilities,
      trackKinds: mod.trackKinds,
      has: {
        initialize: typeof mod.initialize === 'function',
        getVoices: typeof mod.getVoices === 'function',
        synthesize: typeof mod.synthesize === 'function',
        dispose: typeof mod.dispose === 'function',
      },
    };
    const ctx = newEncodeContext();
    post({ type: 'meta', ok: true, meta: encodeWire(meta, ctx, 'meta', 0) }, [...ctx.transfer]);
  }

  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'init':
        handleInit(msg);
        break;
      case 'call':
        runCall(msg);
        break;
      case 'callback-result': {
        const entry = replies.get(msg.reqId);
        if (!entry) return;
        replies.delete(msg.reqId);
        if (msg.ok) entry.resolve(msg.value);
        else entry.reject(new Error(msg.error || '主进程回调执行失败'));
        break;
      }
      case 'cancel': {
        const entry = calls.get(msg.callId);
        if (!entry) return;
        entry.cancelledRef.cancelled = true;
        break;
      }
      default:
        break;
    }
  });

  process.on('uncaughtException', (err) => {
    post({ type: 'failed', error: describeError(err) });
  });
}

if (!isMainThread) startWorkerRuntime();
