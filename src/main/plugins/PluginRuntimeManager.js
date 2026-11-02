'use strict';
/**
 * 每个插件一个 utilityProcess 的生命周期管理。
 *
 * 选 utilityProcess 而不是 worker_threads 的理由（与既有 pluginHost 的取舍相反）：
 *   · 线程无法强杀同步阻塞的代码，只能 terminate，且 terminate 后插件持有的
 *     原生资源（ORT session、文件句柄）不保证回收；
 *   · utilityProcess 是真进程，崩溃不拖垮主进程，退出时内核回收全部句柄；
 *   · 可以给它独立的 V8 堆上限与 env，出问题只影响自己。
 *
 * 代价：跨进程只能传结构化克隆的数据，没有共享内存。所以"热路径 hook"不在这里跑
 * （见 plan §3.1：model hook 在 svsWorker 的 ORT 里执行）。
 */
const path = require('node:path');
const { utilityProcess } = require('electron');
const { RUNTIME_LIMITS, TIMEOUTS, ERR } = require('../../shared/pluginApi.js');
const { PluginError } = require('../../shared/pluginProtocol.js');

function resolveRuntimeEntry() {
  const fs = require('node:fs');
  const candidates = [
    // 打包布局：src/main 整树被 CopyPlugin 拷到 `.webpack/main/main/`，
    // 主进程 bundle 的 __dirname 是 `.webpack/main`，所以入口在这里。
    // 走的是既有的 "src/main 整树拷贝"，不需要为插件另开一条拷贝规则
    // （多开一条会让同一个目录在 .webpack 下出现两份，还要额外维护路径映射）。
    // 守卫：test/copyWebpackClosure.test.js 的 EXTRA_RAW_ENTRIES
    path.join(__dirname, 'main', 'plugins', 'runtime', 'pluginRuntimeEntry.js'),
    // 兼容"src/main 直接拷到 .webpack/main 根"的布局
    path.join(__dirname, 'plugins', 'runtime', 'pluginRuntimeEntry.js'),
    // 源码布局（单测 / 未打包运行时直接 require 本模块）
    path.join(__dirname, 'runtime', 'pluginRuntimeEntry.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* ignore */ }
  }
  throw new Error(`找不到插件运行时入口，已尝试：\n${candidates.join('\n')}`);
}

class RuntimeSession {
  constructor(id, child, meta) {
    this.id = id;
    this.child = child;
    this.meta = meta;
    this.pending = new Map();
    this.seq = 0;
    this.ready = false;
    this.exited = false;
    this.crashes = 0;
    this.lastError = '';
    this.onEvent = null;
    this.onExit = null;
    this.hostHandler = null;
  }
}

class PluginRuntimeManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.entry = null;
    this.logger = options.logger || console;
    this.hostHandler = options.hostHandler || (async () => {
      throw new PluginError(ERR.UNSUPPORTED, '宿主未实现该能力');
    });
  }

  _entry() {
    if (!this.entry) this.entry = resolveRuntimeEntry();
    return this.entry;
  }

  isAlive(id) {
    const s = this.sessions.get(id);
    return !!s && !s.exited;
  }

  list() {
    return [...this.sessions.values()].filter((s) => !s.exited).map((s) => ({
      id: s.id, pid: s.child.pid, ready: s.ready, crashes: s.crashes,
    }));
  }

  /**
   * 启动并完成 init 握手。
   * @param {{id:string, dir:string, dataDir:string, entry:string, name:string,
   *          version:string, permissions:object, capabilities:object}} plugin
   */
  async start(plugin) {
    if (this.isAlive(plugin.id)) return this.sessions.get(plugin.id);

    const child = utilityProcess.fork(this._entry(), [], {
      serviceName: `sxseditor-plugin-${plugin.id}`,
      stdio: 'pipe',
      env: {
        ...process.env,
        SXS_PLUGIN_ID: plugin.id,
        // 插件进程不该继承 Electron 的调试开关
        ELECTRON_RUN_AS_NODE: '1',
      },
      // 插件是第三方代码，给一个明确的堆上限，避免它把整机内存吃光
      execArgv: [`--max-old-space-size=${RUNTIME_LIMITS.maxOldSpaceMb}`],
    });

    const session = new RuntimeSession(plugin.id, child, {
      dir: plugin.dir,
      dataDir: plugin.dataDir,
    });
    this.sessions.set(plugin.id, session);

    child.on('message', (data) => this._onMessage(session, data));
    child.on('exit', (code) => this._onExit(session, code));
    child.stderr && child.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) this.logger.warn(`[plugin:${plugin.id}] ${text.slice(0, 2000)}`);
    });

    // init 握手
    session.hostHandler = this.hostHandler;
    const ready = new Promise((resolve, reject) => {
      session._readyResolve = resolve;
      session._readyReject = reject;
      setTimeout(() => reject(new PluginError(ERR.PLUGIN_TIMEOUT, `插件初始化超时（${TIMEOUTS.init}ms）`)), TIMEOUTS.init);
    });

    child.postMessage({
      kind: 'init',
      plugin: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        dir: plugin.dir,
        dataDir: plugin.dataDir,
        locale: plugin.locale,
      },
      entry: plugin.entry,
      permissions: plugin.permissions || {},
      capabilities: plugin.capabilities || {},
    });

    await ready;
    session.ready = true;
    return session;
  }

  _onMessage(session, data) {
    if (!data || typeof data !== 'object') return;

    if (data.kind === 'ready') {
      session._readyResolve && session._readyResolve();
      session._readyResolve = null;
      return;
    }
    if (data.kind === 'init-error') {
      session.lastError = (data.error && data.error.message) || '初始化失败';
      session._readyReject && session._readyReject(new PluginError(ERR.INTERNAL, session.lastError));
      session._readyReject = null;
      return;
    }
    if (data.kind === 'res') {
      const pending = session.pending.get(data.id);
      if (!pending) return;
      session.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (data.ok) pending.resolve(data.result);
      else {
        pending.reject(new PluginError(
          (data.error && data.error.code) || ERR.INTERNAL,
          (data.error && data.error.message) || '插件调用失败',
        ));
      }
      return;
    }
    if (data.kind === 'host') {
      // 插件反向索要宿主能力（project.apply / ui.notify）
      Promise.resolve()
        .then(() => session.hostHandler(session.id, data.method, data.params))
        .then((result) => session.child.postMessage({ kind: 'host-res', id: data.id, ok: true, result }))
        .catch((err) => session.child.postMessage({
          kind: 'host-res',
          id: data.id,
          ok: false,
          error: { code: (err && err.code) || ERR.INTERNAL, message: String((err && err.message) || err) },
        }));
      return;
    }
    if (data.kind === 'evt') {
      if (session.onEvent) {
        try {
          session.onEvent(session.id, data.event, data.payload);
        } catch (err) {
          this.logger.warn(`[plugin:${session.id}] event handler failed:`, err && err.message);
        }
      }
      return;
    }
  }

  _onExit(session, code) {
    session.exited = true;
    for (const [id, pending] of session.pending) {
      clearTimeout(pending.timer);
      pending.reject(new PluginError(ERR.PLUGIN_UNLOADED, '插件进程已退出'));
      session.pending.delete(id);
    }
    this.sessions.delete(session.id);
    if (session.onExit) {
      try {
        session.onExit(session.id, code, session.lastError);
      } catch (_) { /* ignore */ }
    }
  }

  /** 调用插件的方法。超时即拒绝，但**不杀进程**（杀进程由调用方决定）。 */
  call(id, method, params, options = {}) {
    const session = this.sessions.get(id);
    if (!session || session.exited) {
      return Promise.reject(new PluginError(ERR.PLUGIN_UNLOADED, '插件未运行'));
    }
    if (!session.ready) {
      return Promise.reject(new PluginError(ERR.PLUGIN_UNLOADED, '插件尚未初始化完成'));
    }
    const timeoutMs = options.timeoutMs || TIMEOUTS.command;
    const reqId = `r${++session.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(reqId);
        reject(new PluginError(ERR.PLUGIN_TIMEOUT, `插件调用超时（${method}, ${timeoutMs}ms）`));
      }, timeoutMs);
      session.pending.set(reqId, { resolve, reject, timer });
      session.child.postMessage({ kind: 'req', id: reqId, method, params });
    });
  }

  /** 优雅停止：先 dispose，再等进程退出，超时强杀。 */
  async stop(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      await Promise.race([
        this.call(id, 'dispose', {}, { timeoutMs: TIMEOUTS.killGrace }),
        new Promise((resolve) => setTimeout(resolve, TIMEOUTS.killGrace)),
      ]);
    } catch (_) { /* 插件不配合也无所谓，下面强杀 */ }
    try {
      session.child.kill();
    } catch (err) {
      this.logger.warn(`[plugin:${id}] kill failed:`, err && err.message);
    }
    this.sessions.delete(id);
  }

  async stopAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}

module.exports = { PluginRuntimeManager, resolveRuntimeEntry };
