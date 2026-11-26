/**
 * SVS_INIT / FRAGMENT_SVS_INIT 的 needsBuiltin:false 短路。
 *
 * 真跑主进程 handler：把 ipcSafe.safeHandle 换成"收集 handler"，把
 * svsPipelineLazy.get 打桩计数。短路路径必须零调用 get，且不进
 * _withLoadProgress（连进度条都不该出现）；未传 options 时原逻辑逐字不变。
 */
const { expect } = require('chai');
const path = require('node:path');
const Module = require('node:module');
const sinon = require('sinon');

const CHANNELS = ['svs:init', 'fragment-svs:init'];

describe('svs init 守卫 — 纯插件工程不加载内置模型', function () {
  this.timeout(30000);

  const handlers = new Map();
  const fakeEvent = { sender: { isDestroyed: () => false, send() {} } };
  let svsIpc;
  let getStub;
  let originalLoad;

  before(function () {
    originalLoad = Module._load;
    Module._load = function (request, parent) {
      const fromSvsIpc = parent && parent.filename
        && parent.filename.endsWith(path.join('main', 'svsIpc.js'));
      if (fromSvsIpc && request === './ipcSafe') {
        return { safeHandle: (channel, listener) => { handlers.set(channel, listener); } };
      }
      if (fromSvsIpc && request === './pluginIpc') {
        return { runPluginBackend: async () => ({ ok: false }), registerPluginIpc() {} };
      }
      return originalLoad.apply(this, arguments);
    };
    // 其它测试可能已用真实 ipcSafe 加载过 svsIpc，删缓存才能让上面的拦截生效。
    try {
      delete require.cache[require.resolve('../src/main/svsIpc.js')];
      svsIpc = require('../src/main/svsIpc.js');
    } finally {
      Module._load = originalLoad;
    }
    svsIpc.registerSvsIpc();
  });

  after(function () {
    sinon.restore();
    delete require.cache[require.resolve('../src/main/svsIpc.js')];
  });

  beforeEach(function () {
    getStub = sinon.stub(svsIpc.svsPipelineLazy, 'get').resolves({});
  });

  afterEach(function () {
    getStub.restore();
  });

  /** _withLoadProgress 会动态 require('electron')，只在调用期间拦成"无窗口"。 */
  async function callHandler(channel, options) {
    const handler = handlers.get(channel);
    expect(handler, `未注册 ${channel}`).to.be.a('function');
    const saved = Module._load;
    Module._load = function (request) {
      if (request === 'electron') {
        return { BrowserWindow: { fromWebContents: () => null } };
      }
      return saved.apply(this, arguments);
    };
    try {
      return await handler(fakeEvent, options);
    } finally {
      Module._load = saved;
    }
  }

  for (const channel of CHANNELS) {
    it(`${channel} 收到 needsBuiltin:false → skipped 且 lazy.get 零调用`, async function () {
      const r = await callHandler(channel, { needsBuiltin: false });
      expect(r).to.deep.include({
        success: true, skipped: true, diffStepLegacyInt8Incompatible: false,
      });
      expect(getStub.callCount).to.equal(0);
    });

    it(`${channel} 未传 options → 仍走原逻辑初始化`, async function () {
      const r = await callHandler(channel, undefined);
      expect(r.success).to.equal(true);
      expect(r.skipped).to.equal(undefined);
      expect(getStub.callCount).to.equal(1);
    });

    it(`${channel} 传 needsBuiltin:true → 仍走原逻辑`, async function () {
      const r = await callHandler(channel, { needsBuiltin: true });
      expect(r.success).to.equal(true);
      expect(r.skipped).to.equal(undefined);
      expect(getStub.callCount).to.equal(1);
    });
  }

  it('两个通道注册的是同一套跳过语义', function () {
    for (const channel of CHANNELS) expect(handlers.has(channel)).to.equal(true);
  });
});
