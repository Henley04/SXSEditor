'use strict';
/**
 * 插件运行时入口（utilityProcess）。
 *
 * 这个文件是**裸拷贝**的（webpack.main.config.js 的 CopyPlugin），按路径被
 * `utilityProcess.fork()` 拉起，因此：
 *   · 必须是 CJS，不能有 ESM import；
 *   · 不能依赖 webpack 的别名或 bundle 内的模块图；
 *   · 需要的东西要么是 Node 内置、要么是同目录的兄弟文件、要么是 node_modules。
 *
 * 协议（与主进程 PluginRuntimeManager 对应）：
 *   main → runtime  { kind:'init', plugin, permissions, entry, capabilities }
 *   runtime → main  { kind:'ready' } | { kind:'init-error', error }
 *   main → runtime  { kind:'req', id, method, params }
 *   runtime → main  { kind:'res', id, ok, result | error }
 *   main → runtime  { kind:'event', event, payload }
 *   runtime → main  { kind:'evt', event, payload }
 *   runtime → main  { kind:'host', id, method, params }      （runtime 反向索要宿主能力）
 *   main → runtime  { kind:'host-res', id, ok, result | error }
 *
 * 为什么反向调用不用同一个 id 空间：两侧各自自增，混用会在日志里无法区分方向，
 * 排查"谁在等谁"时非常痛苦。kind 就足够区分了。
 */
const path = require('node:path');

const { OrtRunner } = require('./ortRunner.js');
const { FsSandbox } = require('./sandbox.js');
const { installNetworkGuard } = require('./netGuard.js');

function parentPort() {
  // Electron utilityProcess 提供 process.parentPort；worker_threads 没有。
  if (process.parentPort && typeof process.parentPort.postMessage === 'function') {
    return process.parentPort;
  }
  return null;
}

const port = parentPort();
const pendingHost = new Map();
let hostSeq = 0;

/**
 * 在途的模型调用。key 是插件自己生成的 streamKey。
 *
 * 为什么不用 handleId 做 key：主进程的 start 事件可能比 hostCall 的返回值更早到，
 * 那时我们还没有 handleId。streamKey 是插件在发请求之前就有的，天然能对上。
 */
const modelStreams = new Map();
let modelStreamSeq = 0;

function post(message) {
  if (port) {
    port.postMessage(message);
    return;
  }
  if (typeof process.send === 'function') process.send(message);
}

function hostCall(method, params, timeoutMs = 30000) {
  const id = `h${++hostSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHost.delete(id);
      reject(Object.assign(new Error(`宿主调用超时：${method}`), { code: 'PLUGIN_TIMEOUT' }));
    }, timeoutMs);
    pendingHost.set(id, { resolve, reject, timer });
    post({ kind: 'host', id, method, params });
  });
}

// ---------------------------------------------------------------- 宿主能力
function createContext(init) {
  const { plugin, permissions, capabilities } = init;
  const cleanups = [];
  // 用户设置的可变快照：`settings.changed` 到达时就地替换（插件不必自己缓存）。
  let settings = { ...(init.settings || {}) };
  const settingsListeners = [];

  const log = (level) => (message, detail) => {
    post({
      kind: 'evt',
      event: 'log',
      payload: {
        level,
        message: String(message == null ? '' : message).slice(0, 4000),
        detail: detail === undefined ? undefined : safe(detail),
      },
    });
  };

  const sandbox = new FsSandbox({
    dataDir: plugin.dataDir,
    pluginDir: plugin.dir,
    perms: permissions,
    log: (level, msg) => log(level)(msg),
  });

  const ort = new OrtRunner({
    allowedEps: Array.isArray(permissions.ort) ? permissions.ort : ['cpu'],
    deviceId: capabilities && capabilities.deviceId,
    log: (level, msg) => log(level)(msg),
  });

  const ctx = {
    apiVersion: 2,
    plugin: {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      dir: plugin.dir,
      dataDir: plugin.dataDir,
      locale: plugin.locale || 'zh-CN',
    },
    capabilities: capabilities || {},
    log: {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },
    fs: {
      readText: (p) => sandbox.readText(p),
      readBinary: (p) => sandbox.readBinary(p),
      writeText: (p, text) => sandbox.writeText(p, text),
      writeBinary: (p, buf) => sandbox.writeBinary(p, buf),
      exists: (p) => sandbox.exists(p),
      list: (p) => sandbox.list(p),
    },
    state: {
      get: (key) => sandbox.readStateKey(key),
      set: (key, value) => sandbox.writeStateKey(key, value),
      delete: (key) => sandbox.writeStateKey(key, undefined),
      all: () => sandbox.readState(),
    },
    ort: {
      load: (modelPath, options) => {
        // 模型路径必须落在插件目录内：允许插件读自己的 .onnx，但不许读系统任意位置
        const resolved = path.resolve(plugin.dir, modelPath);
        if (!resolved.startsWith(path.resolve(plugin.dir) + path.sep)) {
          throw new Error(`模型路径越界：${modelPath}`);
        }
        return ort.load(resolved, options);
      },
      run: (handle, feeds, options) => ort.run(handle, feeds, options),
      unload: (handle) => ort.unload(handle),
      devices: () => (capabilities && capabilities.hardware) || null,
    },
    project: {
      /** 读当前工程的只读快照（由宿主转发给主窗口）。 */
      read: () => hostCall('project.read', {}),
      /** 写入工程；ops 语义与 MCP 的 project.apply 完全一致。 */
      apply: (ops) => hostCall('project.apply', { operations: ops }, 60000),
    },
    ui: {
      notify: (message, level) => hostCall('ui.notify', { message: String(message || '').slice(0, 500), level: level || 'info' }),
      progress: (value, text) => post({ kind: 'evt', event: 'progress', payload: { value, text } }),
      /**
       * 更新自己声明的状态栏条目（manifest.contributes.statusBar[].id）。
       * 宿主按 pluginId 前缀校验归属，插件改不了别人的条目。
       */
      status: (itemId, text) => hostCall('ui.status', { itemId: String(itemId || ''), text: String(text == null ? '' : text) }),
    },
    /**
     * 模型调用。调用方只说 task，不关心背后是本地还是云端。
     *
     *   const h = ctx.models.invoke({ task: 'chat', input: '...' }, { onChunk: (t) => ... });
     *   await h.done;              // { text, endpointId } | { cancelled: true }
     *   h.cancel();                // 主动取消 → done 以 { cancelled: true } 结算
     *
     * 没给 onChunk 时中间分片仍会被聚合，只是你不需要处理。
     */
    models: {
      list: (options) => hostCall('models.list', { task: options && options.task }),
      invoke: (req, handlers) => startModelStream(req, handlers),
      /** 只要最终结果：内部仍走同一条流，但调用方不必处理分片。 */
      invokeOnce: (req, handlers) => startModelStream(req, handlers).done,
    },
    /** 用户设置（settings 分区里填的值）。只读快照 + 变更事件。 */
    settings: {
      get: (key) => settings[key],
      all: () => ({ ...settings }),
    },
    onSettingsChanged: (fn) => {
      if (typeof fn !== 'function') return;
      settingsListeners.push(fn);
    },
    hardware: () => (capabilities && capabilities.hardware) || null,
    onDispose: (fn) => {
      if (typeof fn === 'function') cleanups.push(fn);
    },
  };

  /** 宿主推来新设置时调用（见 onMessage 的 event 分支）。 */
  ctx.__setSettings = (values) => {
    settings = { ...(values || {}) };
    for (const fn of settingsListeners) {
      try { fn(ctx, { ...settings }); } catch (err) { ctx.log.warn(`settings listener failed: ${err && err.message}`); }
    }
  };

  ctx.__cleanup = async () => {    cancelModelStreams();
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch (err) {
        log('warn')(`dispose hook failed: ${err && err.message}`);
      }
    }
    await ort.dispose();
  };

  return ctx;
}

function safe(value, depth = 0) {
  if (depth > 6) return null;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'undefined' || typeof value === 'function') return undefined;
  if (ArrayBuffer.isView(value)) {
    return { __typed: value.constructor.name, data: Array.from(value.slice(0, 1e6)) };
  }
  if (Array.isArray(value)) return value.slice(0, 1000).map((v) => safe(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('__')) continue;
      out[k] = safe(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

// ---------------------------------------------------------------- 生命周期
let ctx = null;
let moduleExports = null;
let disposed = false;

async function handleInit(msg) {
  const { plugin, entry } = msg;
  ctx = createContext(msg);

  // 必须在 require 插件入口之前装好：插件完全可能在模块顶层就 require('https')
  // 发一个"初始化"请求，那时候再拦已经晚了。
  installNetworkGuard({
    pluginId: plugin.id,
    log: (level, message) => ctx.log[level] ? ctx.log[level](message) : undefined,
  });

  const entryPath = path.resolve(plugin.dir, entry);
  if (!entryPath.startsWith(path.resolve(plugin.dir) + path.sep)) {
    throw Object.assign(new Error(`入口路径越界：${entry}`), { code: 'INVALID_MANIFEST' });
  }

  // 每个插件进程只 require 一次；reload 走"杀进程重建"，不做 require 缓存清理 ——
  // 那是最容易漏掉闭包引用的一步，重建进程反而是最干净的方案。
  moduleExports = require(entryPath);
  if (moduleExports && typeof moduleExports.initialize === 'function') {
    await moduleExports.initialize(ctx);
  }
  post({ kind: 'ready', pluginId: plugin.id });
}

async function handleRequest(msg) {
  if (disposed) {
    post({ kind: 'res', id: msg.id, ok: false, error: { code: 'PLUGIN_UNLOADED', message: '插件已卸载' } });
    return;
  }
  try {
    const { method, params } = msg;
    let result;
    switch (method) {
      case 'ping':
        result = { ok: true, pid: process.pid };
        break;
      case 'command.run': {
        const handlers = (moduleExports && moduleExports.commands) || {};
        const fn = handlers[params.commandId];
        if (typeof fn !== 'function') {
          throw Object.assign(new Error(`插件没有实现命令 '${params.commandId}'`), { code: 'NOT_FOUND' });
        }
        result = await fn(ctx, params.args || {});
        break;
      }
      case 'panel.rpc': {
        // 面板 RPC 的入口有三种写法，按"越具体越优先"的顺序解析：
        //   1. panels.<panelId>.rpc(ctx, method, params)  —— 一个面板一个 dispatcher
        //   2. panels.rpc(ctx, method, params)            —— 所有面板共用一个 dispatcher
        //   3. onPanelRpc(ctx, panelId, method, params)   —— 平铺的函数式写法
        // 示例插件用的是第 2 种（它的注释也那么写），而此前只实现了第 1、3 种，
        // 于是示例面板每一条 RPC 都报“插件没有实现面板 'main' (NOT_FOUND)”。
        const panels = (moduleExports && moduleExports.panels) || {};
        const panel = panels[params.panelId];
        if (panel && typeof panel.rpc === 'function') {
          result = await panel.rpc(ctx, params.method, params.params || {});
        } else if (typeof panels.rpc === 'function') {
          result = await panels.rpc(ctx, params.method, params.params || {});
        } else if (moduleExports && typeof moduleExports.onPanelRpc === 'function') {
          result = await moduleExports.onPanelRpc(ctx, params.panelId, params.method, params.params || {});
        } else {
          throw Object.assign(new Error(`插件没有实现面板 '${params.panelId}'`), { code: 'NOT_FOUND' });
        }
        break;
      }
      case 'dispose':
        result = await dispose();
        break;
      default:
        throw Object.assign(new Error(`未知方法 ${method}`), { code: 'UNSUPPORTED' });
    }
    post({ kind: 'res', id: msg.id, ok: true, result: safe(result) });
  } catch (err) {
    post({
      kind: 'res',
      id: msg.id,
      ok: false,
      error: { code: (err && err.code) || 'INTERNAL', message: String((err && err.message) || err).slice(0, 2000) },
    });
  }
}

async function dispose() {
  if (disposed) return { ok: true };
  disposed = true;
  try {
    if (moduleExports && typeof moduleExports.dispose === 'function') await moduleExports.dispose(ctx);
  } catch (err) {
    ctx.log.warn(`dispose failed: ${err && err.message}`);
  }
  try {
    if (ctx) await ctx.__cleanup();
  } catch (_) { /* ignore */ }
  return { ok: true };
}

/**
 * 发起一次模型调用，返回 { id, cancel(), done }。
 * 事件由主进程经 `models.event` 推回，按 streamKey 认领。
 */
function startModelStream(req, handlers = {}) {
  if (!req || typeof req !== 'object') {
    throw Object.assign(new Error('models.invoke 需要请求对象'), { code: 'INVALID_REQUEST' });
  }
  const streamKey = `ms${++modelStreamSeq}`;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const entry = {
    handlers: handlers || {},
    chunks: [],
    handleId: null,
    cancelRequested: false,
    resolveDone,
    rejectDone,
  };
  modelStreams.set(streamKey, entry);

  const handle = {
    get id() { return entry.handleId; },
    cancel() {
      if (entry.handleId) {
        hostCall('models.cancel', { handleId: entry.handleId }).catch(() => { /* 已结束 */ });
      } else {
        // 启动还没回来：等 handleId 到手再取消（见下面成功分支）
        entry.cancelRequested = true;
      }
    },
    done,
  };

  hostCall('models.invoke', { ...req, streamKey }, 60000).then((result) => {
    if (!result || !result.handleId) {
      modelStreams.delete(streamKey);
      rejectDone(Object.assign(new Error('模型调用未启动'), { code: 'INTERNAL' }));
      return;
    }
    entry.handleId = result.handleId;
    if (entry.cancelRequested) handle.cancel();
  }).catch((err) => {
    modelStreams.delete(streamKey);
    rejectDone(err);
  });

  return handle;
}

function handleModelEvent(evt) {
  const entry = modelStreams.get(evt.streamKey);
  if (!entry) return;
  const h = entry.handlers || {};
  try {
    if (evt.type === 'start') {
      entry.handleId = evt.handleId || entry.handleId;
      if (h.onStart) h.onStart(evt);
      return;
    }
    if (evt.type === 'chunk') {
      entry.chunks.push(evt.data == null ? '' : String(evt.data));
      if (h.onChunk) h.onChunk(evt.data, evt);
      // 背压回执：网关按未确认的条数/字节数暂停生产方
      if (entry.handleId) {
        hostCall('models.ack', { handleId: entry.handleId, bytes: evt.bytes || 0 }).catch(() => { /* 已结束 */ });
      }
      return;
    }
    if (evt.type === 'progress') {
      if (h.onProgress) h.onProgress(evt);
      return;
    }
    if (evt.type === 'done') {
      modelStreams.delete(evt.streamKey);
      entry.resolveDone({ text: entry.chunks.join(''), endpointId: evt.endpointId || '' });
      return;
    }
    if (evt.type === 'cancelled') {
      modelStreams.delete(evt.streamKey);
      entry.resolveDone({ cancelled: true, text: entry.chunks.join('') });
      return;
    }
    if (evt.type === 'error') {
      modelStreams.delete(evt.streamKey);
      const info = evt.error || {};
      const err = Object.assign(new Error(info.message || '模型调用失败'), {
        code: info.code || 'INTERNAL',
        retryable: info.retryable === true,
      });
      if (info.hint) err.hint = info.hint;
      entry.rejectDone(err);
    }
  } catch (err) {
    ctx && ctx.log && ctx.log.warn(`models handler failed: ${err && err.message}`);
  }
}

/** 插件被卸载/停用时取消它所有在途调用，避免宿主还在往一个死进程里推事件。 */
function cancelModelStreams() {
  for (const [streamKey, entry] of [...modelStreams]) {
    modelStreams.delete(streamKey);
    try { entry.resolveDone({ cancelled: true, text: '' }); } catch (_) { /* ignore */ }
    if (entry.handleId) hostCall('models.cancel', { handleId: entry.handleId }).catch(() => {});
  }
}

function onMessage(raw) {
  const msg = raw && raw.data ? raw.data : raw;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.kind) {
    case 'init':
      handleInit(msg).catch((err) => {
        post({
          kind: 'init-error',
          error: { code: (err && err.code) || 'INTERNAL', message: String((err && err.message) || err).slice(0, 2000) },
        });
      });
      break;
    case 'req':
      handleRequest(msg);
      break;
    case 'host-res': {
      const pending = pendingHost.get(msg.id);
      if (!pending) return;
      pendingHost.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(Object.assign(new Error((msg.error && msg.error.message) || '宿主调用失败'), {
        code: (msg.error && msg.error.code) || 'INTERNAL',
      }));
      break;
    }
    case 'event':
      try {
        if (msg.event === 'settings.changed' && ctx) {
          ctx.__setSettings((msg.payload && msg.payload.values) || {});
          return;
        }
        if (msg.event === 'models.event') {
          handleModelEvent(msg.payload || {});
          return;
        }
        if (moduleExports && typeof moduleExports.onHostEvent === 'function') {
          moduleExports.onHostEvent(ctx, msg.event, msg.payload);
        }
      } catch (err) {
        ctx && ctx.log.warn(`onHostEvent failed: ${err && err.message}`);
      }
      break;
    default:
      break;
  }
}

if (port) {
  port.on('message', onMessage);
} else if (typeof process.on === 'function') {
  process.on('message', onMessage);
}

process.on('uncaughtException', (err) => {
  post({ kind: 'evt', event: 'uncaught', payload: { message: String(err && err.message).slice(0, 2000) } });
  // 让宿主的 exit 处理器接管：这里不自杀，避免把未完成的 RPC 变成永远 pending
});

process.on('unhandledRejection', (reason) => {
  post({ kind: 'evt', event: 'unhandled', payload: { message: String(reason && reason.message || reason).slice(0, 2000) } });
});

module.exports = { _onMessageForTests: onMessage };
