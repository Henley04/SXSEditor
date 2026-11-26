const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

/**
 * 插件方法的长任务形态（M5 第 5 段）。
 *
 * 三条断言是三件事：
 *   · `long: true` 才允许 `async: true` 提交成 job（其余方法不该被"异步化"）；
 *   · 进度按请求 id 回到发起人，而不是广播给所有窗口；
 *   · 取消真的到达插件进程，并且宿主立刻结算 —— 不等插件配合。
 */

const jobs = require('../src/main/mcpJobs');
const { buildAutomationDef } = require('../src/shared/pluginAutomation');
const { validateManifest } = require('../src/shared/pluginManifest');

// ---------------------------------------------------------------- job 进度
describe('mcpJobs — 进度', function () {
  it('running 的 job 记录最后一条进度，完成/取消后不再接受', function () {
    const job = jobs.create('demo.long');
    expect(jobs.progress(job.id, { value: 0.1, text: 'start' })).to.deep.include({ value: 0.1, text: 'start' });
    expect(jobs.get(job.id).progress.value).to.equal(0.1);

    jobs.start(job.id);
    jobs.progress(job.id, { value: 0.5, text: 'half' });
    const snap = jobs.get(job.id);
    expect(snap.progress).to.deep.include({ value: 0.5, text: 'half' });
    expect(snap.progress.at).to.be.a('number');

    jobs.finish(job.id, { result: { ok: true } });
    expect(jobs.progress(job.id, { value: 1 })).to.equal(null);
    // 完成后进度仍然留在快照里：客户端拿到最终结果时还能看到"跑到了哪"
    expect(jobs.get(job.id).progress.value).to.equal(0.5);
  });

  it('非数值 progress 被归一成 null，而不是写进 NaN', function () {
    const job = jobs.create('demo.long');
    jobs.start(job.id);
    jobs.progress(job.id, { value: 'abc', text: 42 });
    const p = jobs.get(job.id).progress;
    expect(p.value).to.equal(null);
    expect(p.text).to.equal('42');
    jobs.cancel(job.id);
  });
});

// ---------------------------------------------------------------- schema
describe('pluginAutomation — 长任务标记', function () {
  it('long 命令暴露 async:true，普通命令不是', function () {
    const long = buildAutomationDef({
      pluginId: 'demo', localId: 'render', title: 'Render', long: true,
    });
    expect(long.def.long).to.equal(true);
    expect(long.def.async).to.equal(true);
    expect(long.def.description).to.match(/Long-running/);

    const short = buildAutomationDef({ pluginId: 'demo', localId: 'ping', title: 'Ping' });
    expect(short.def.long).to.equal(true); // 桥接层超时始终宽于插件自己的
    expect(short.def.async).to.equal(false);
    expect(short.def.description).to.not.match(/Long-running/);
  });

  it('manifest 的 long 只在布尔 true 时生效', function () {
    const r = validateManifest({
      apiVersion: 2,
      id: 'demo-long',
      name: 'Demo',
      version: '1.0.0',
      main: 'main.js',
      engines: { app: '>=2.0.0' },
      permissions: {},
      contributes: {
        commands: [
          { id: 'yes', title: 'Yes', long: true },
          { id: 'no', title: 'No', long: 'yes' },
        ],
      },
    }, { dirName: 'demo-long', appVersion: '9.9.9' });
    expect(r.ok, r.error).to.equal(true);
    const byId = Object.fromEntries(r.value.contributes.commands.map((c) => [c.localId, c.long]));
    expect(byId).to.deep.equal({ yes: true, no: false });
  });
});

// ---------------------------------------------------------------- runtime
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.sent = [];
    this.stderr = new EventEmitter();
  }

  postMessage(msg) {
    this.sent.push(msg);
    if (msg.kind === 'init') setTimeout(() => this.emit('message', { kind: 'ready' }), 0);
  }

  kill() {
    setTimeout(() => this.emit('exit', 0), 0);
  }
}

describe('PluginRuntimeManager — 进度与取消', function () {
  let child = null;
  let manager = null;

  /**
   * 直接注入会话，不调 `start()`。
   *
   * 理由：本文件只关心 `call()` 的进度路由与取消语义，而 `start()` 会去 fork
   * 真进程。全套测试里 electron 的桩由各文件各自安装，模块级解构在第一次
   * require 时就固定了 —— 谁先 require 决定 fork 行为，这种顺序依赖不该被
   * 一个"测取消"的用例承担。会话结构是 RuntimeSession 的公开字段，注入等价。
   */
  const { PluginRuntimeManager } = require('../src/main/plugins/PluginRuntimeManager');

  beforeEach(function () {
    child = new FakeChild();
    manager = new PluginRuntimeManager({ logger: { warn() {} } });
    const session = {
      id: 'demo',
      child,
      meta: {},
      pending: new Map(),
      seq: 0,
      ready: true,
      exited: false,
      crashes: 0,
      lastError: '',
      onEvent: null,
      onExit: null,
      stopping: false,
      hostHandler: null,
    };
    manager.sessions.set('demo', session);
    // start() 里也是这么接的；这里手工接上，让 res / evt 能进 _onMessage。
    child.on('message', (data) => manager._onMessage(session, data));
  });

  afterEach(function () {
    manager.sessions.clear();
  });


  it('进度事件按 reqId 路由给发起人', async function () {
    const seen = [];
    const p = manager.call('demo', 'command.run', { commandId: 'x' }, {
      onProgress: (evt) => seen.push(evt),
    });
    await new Promise((r) => setTimeout(r, 5));
    const req = child.sent.find((m) => m.kind === 'req');
    expect(req).to.be.ok;

    child.emit('message', {
      kind: 'evt', event: 'progress', payload: { reqId: req.id, value: 0.25, text: 'a' },
    });
    // 别人的 reqId 不该被认领
    child.emit('message', {
      kind: 'evt', event: 'progress', payload: { reqId: 'r999', value: 0.9, text: 'b' },
    });
    child.emit('message', { kind: 'res', id: req.id, ok: true, result: { done: true } });

    expect(await p).to.deep.equal({ done: true });
    expect(seen).to.have.length(1);
    expect(seen[0]).to.deep.include({ value: 0.25, text: 'a' });
  });

  it('abort 之后立刻以 CANCELLED 结算，并把 cancel 发给插件', async function () {
    const ac = new AbortController();
    const p = manager.call('demo', 'command.run', { commandId: 'slow' }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    const req = child.sent.find((m) => m.kind === 'req');

    ac.abort();
    let err;
    try { await p; } catch (e) { err = e; }
    expect(err && err.code).to.equal('CANCELLED');

    const cancel = child.sent.find((m) => m.kind === 'cancel');
    expect(cancel && cancel.id).to.equal(req.id);

    // 插件事后再回一条 res 也不该炸（pending 已经删掉）
    child.emit('message', { kind: 'res', id: req.id, ok: true, result: 1 });
  });

  it('已经 abort 的 signal 直接拒绝，不发给插件', async function () {
    const ac = new AbortController();
    ac.abort();
    let err;
    try { await manager.call('demo', 'ping', {}, { signal: ac.signal }); } catch (e) { err = e; }
    expect(err && err.code).to.equal('CANCELLED');
    expect(child.sent.filter((m) => m.kind === 'req')).to.have.length(0);
  });
});

// ---------------------------------------------------------------- service
describe('PluginService — 长任务超时与 options 透传', function () {
  const electronStub = {
    app: { getVersion: () => '9.9.9', getPath: () => os.tmpdir(), isPackaged: false, on: () => {}, removeListener: () => {}, whenReady: () => Promise.resolve() },
    ipcMain: { handle: () => {}, removeHandler: () => {}, on: () => {}, removeListener: () => {} },
    dialog: { showOpenDialog: () => ({ canceled: true, filePaths: [] }), showMessageBox: () => {} },
    shell: { openPath: () => {} },
    Menu: { getApplicationMenu: () => null, buildFromTemplate: () => ({}) },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    utilityProcess: { fork: () => { throw new Error('本用例不应启动插件进程'); } },
    protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
    safeStorage: null,
  };
  const originalLoad = Module._load;
  function installStub() {
    Module._load = function (request) {
      if (request === 'electron') return electronStub;
      return originalLoad.apply(this, arguments);
    };
  }
  function restoreStub() { Module._load = originalLoad; }

  installStub();
  const { PluginService } = require('../src/main/plugins/PluginService');
  const store = require('../src/main/plugins/PluginStateStore');
  restoreStub();

  const { TIMEOUTS } = require('../src/shared/pluginApi');

  let root;
  let service;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-long-'));
    store._setRootForTests(root);
    installStub();
    service = new PluginService();
    service.init({ getMainWindow: () => null, locale: 'zh-CN', models: null });
  });

  afterEach(async function () {
    try { await service.disposeAll(); } catch (_) { /* ignore */ }
    restoreStub();
    store._setRootForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function add(id, commands, methods) {
    const manifest = validateManifest({
      apiVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      main: 'main.js',
      engines: { app: '>=2.0.0' },
      permissions: { automation: ['expose'] },
      contributes: { commands, automation: { methods } },
    }, { dirName: id, appVersion: '9.9.9' });
    expect(manifest.ok, manifest.error).to.equal(true);
    const record = service.registry.addPlugin({ id, manifest: manifest.value, dir: root, state: {} });
    service._registerContributions(record);
    return record;
  }

  it('long 命令用 longCommand 超时，普通命令用 command 超时', async function () {
    add('demo', [
      { id: 'slow', title: 'Slow', long: true },
      { id: 'fast', title: 'Fast' },
    ], ['slow', 'fast']);

    const seen = [];
    service._call = async (pluginId, method, params, timeoutMs, options) => {
      seen.push({ timeoutMs, options });
      return { ok: true };
    };
    await service.runCommand('demo.slow', {});
    await service.runCommand('demo.fast', {});
    expect(seen[0].timeoutMs).to.equal(TIMEOUTS.longCommand);
    expect(seen[1].timeoutMs).to.equal(TIMEOUTS.command);
  });

  it('runAutomationMethod 把 onProgress / signal 一路传下去，并审计 long', async function () {
    add('demo', [{ id: 'slow', title: 'Slow', long: true }], ['slow']);
    const ac = new AbortController();
    const onProgress = () => {};
    let got = null;
    service._call = async (pluginId, method, params, timeoutMs, options) => {
      got = options;
      return { ok: true };
    };
    const r = await service.runAutomationMethod('demo.slow', {}, { signal: ac.signal, onProgress });
    expect(r.ok).to.equal(true);
    expect(got.signal).to.equal(ac.signal);
    expect(got.onProgress).to.equal(onProgress);
    const audit = store.readAudit().filter((e) => e.event === 'automation-invoke');
    expect(audit[0].detail).to.include({ method: 'demo.slow', long: true });
  });

  it('方法表里 long 命令带 async:true', function () {
    add('demo', [
      { id: 'slow', title: 'Slow', long: true },
      { id: 'fast', title: 'Fast' },
    ], ['slow', 'fast']);
    const defs = service.listAutomationMethods();
    expect(defs['demo.slow'].async).to.equal(true);
    expect(defs['demo.fast'].async).to.equal(false);
  });

  it('取消被翻成 CANCELLED 结果，而不是抛异常', async function () {
    add('demo', [{ id: 'slow', title: 'Slow', long: true }], ['slow']);
    service._call = async () => {
      throw Object.assign(new Error('调用已取消'), { code: 'CANCELLED' });
    };
    const r = await service.runAutomationMethod('demo.slow', {});
    expect(r.ok).to.equal(false);
    expect(r.error.code).to.equal('CANCELLED');
  });
});
