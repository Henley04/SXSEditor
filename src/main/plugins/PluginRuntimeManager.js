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
const { RUNTIME_LIMITS, TIMEOUTS, ERR, HOST_CALL_METHODS } = require('../../shared/pluginApi.js');
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
    /** 主动 stop() 置位：此时 exit 是预期内的，不能算崩溃。 */
    this.stopping = false;
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
      // 不能设 ELECTRON_RUN_AS_NODE=1：utilityProcess.fork 拉起的就是 Electron
      // 的 utility 进程（`--type=utility`、`--utility-sub-type=node.mojom.NodeService`
      // 由框架自己拼），一旦置了 RUN_AS_NODE，二进制会以纯 Node 模式启动，
      // 把这些 Chromium 开关当成 node 的非法选项直接退出：
      //   /proc/self/exe: bad option: --type=utility
      // 结果就是 init 握手永远等不到，命令调用统一报 PLUGIN_TIMEOUT。
      // "隔离调试开关"的正确做法是删掉继承来的 ELECTRON_* 变量，而不是打开它。
      env: (() => {
        const env = { ...process.env, SXS_PLUGIN_ID: plugin.id };
        for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_ENABLE_STACK_DUMPING']) {
          delete env[key];
        }
        return env;
      })(),
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
    // 会话级回调必须显式接线：_onMessage/_onExit 读的是 session.onEvent/onExit，
    // 而 manager 上的 onEvent/onExit 是构造之后由 PluginService 赋值的。
    // 少了这一步，插件的 ctx.log / ui.progress 事件全部静默丢弃，崩溃也不进审计。
    // 用转发闭包而不是直接赋值，是为了让"后设置 manager 回调"也能生效。
    session.onEvent = (id, event, payload) => {
      if (typeof this.onEvent === 'function') this.onEvent(id, event, payload);
    };
    session.onExit = (id, code, detail) => {
      if (typeof this.onExit === 'function') this.onExit(id, code, detail);
    };
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
      // 设置页里用户填过的值（manifest.settings[].fields）。启动时给一份快照，
      // 之后的变化通过 `settings.changed` 事件推给插件（见 PluginService.setSettings）。
      settings: plugin.settings || {},
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
      if (pending.onDone) pending.onDone();
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
      // 插件反向索要宿主能力（project.apply / ui.notify）。
      // 第一道闸门：runtime 是第三方进程，不能假设它只会发白名单内的方法。
      // 第二道在 PluginService._handleHostCall（那里还做权限校验），两处都拦是
      // 有意的 —— 新增宿主能力时必须同时登记，漏一处会被另一处挡住而不是静默放行。
      if (!HOST_CALL_METHODS.includes(data.method)) {
        session.child.postMessage({
          kind: 'host-res',
          id: data.id,
          ok: false,
          error: { code: ERR.UNSUPPORTED, message: `未实现宿主能力：${data.method}` },
        });
        return;
      }
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
      // 进度事件带 reqId：只送给"发起这次调用的人"，不进广播。
      // 不进广播的理由：插件可能在同一个进程里既跑面板又跑命令，把某次命令的
      // 进度推到所有窗口只会让界面显示一个与当前操作无关的进度条。
      const payload = data.payload || {};
      if (data.event === 'progress' && payload.reqId) {
        const pending = session.pending.get(payload.reqId);
        if (pending && typeof pending.onProgress === 'function') {
          try {
            pending.onProgress(payload);
          } catch (err) {
            this.logger.warn(`[plugin:${session.id}] progress handler failed:`, err && err.message);
          }
        }
      }
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
      if (pending.onDone) pending.onDone();
      pending.reject(new PluginError(ERR.PLUGIN_UNLOADED, '插件进程已退出'));
      session.pending.delete(id);
    }
    this.sessions.delete(session.id);
    // 主动 stop() 之后的 exit 是预期行为，交给 stop() 自己收尾；
    // 若也走 onExit，卸载/停用会被记成崩溃，三次正常停用就触发隔离。
    if (!session.stopping && session.onExit) {
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
      const settle = () => {
        session.pending.delete(reqId);
        clearTimeout(timer);
        if (options.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        settle();
        reject(new PluginError(ERR.PLUGIN_TIMEOUT, `插件调用超时（${method}, ${timeoutMs}ms）`));
      }, timeoutMs);

      /**
       * 取消：先告诉插件"别干了"（它会 abort 对应的 ctx.signal），再在本地结算。
       *
       * 两边都做是刻意的。只发消息的话，一个不检查 signal 的插件会把调用方
       * 拖到超时；只在本地结算的话，插件的活儿还在跑（算力白烧，还可能继续
       * 往磁盘写）。本地结算保证"取消立刻生效"，消息则给配合的插件省下算力。
       */
      let onAbort = null;
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          reject(new PluginError(ERR.CANCELLED, '调用已取消'));
          return;
        }
        onAbort = () => {
          try {
            session.child.postMessage({ kind: 'cancel', id: reqId });
          } catch (_) { /* 进程已退出，下面照样结算 */ }
          session.pending.delete(reqId);
          clearTimeout(timer);
          reject(new PluginError(ERR.CANCELLED, '调用已取消'));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      session.pending.set(reqId, {
        resolve, reject, timer, onProgress: options.onProgress, onDone: settle,
      });
      session.child.postMessage({ kind: 'req', id: reqId, method, params });
    });
  }

  /** 向插件推一条事件（不等回复）。插件没监听就自然丢弃。 */
  sendEvent(id, event, payload) {
    const session = this.sessions.get(id);
    if (!session || session.exited || !session.ready) return false;
    try {
      session.child.postMessage({ kind: 'event', event, payload });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 优雅停止：先 dispose，再等进程退出，超时强杀。 */
  async stop(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.stopping = true;
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
