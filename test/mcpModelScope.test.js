const os = require('node:os');
const Module = require('node:module');
const { expect } = require('chai');

/**
 * MCP token 的模型范围（设计方案 §12.6）。
 *
 * 这个判定的关键是**来源隔离**：插件注册的端点即使自称 provider=openai，
 * 也不能被 `provider:openai` 覆盖 —— 否则插件冒用厂商名就能蹭到用户对
 * "我的 OpenAI" 那次授权。
 */

const electronStub = {
  app: { getVersion: () => '0.0.0', getPath: () => os.tmpdir(), on: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
};

describe('MCP token 的模型 scope', function () {
  let modelScopeAllows;
  let normalizeModelScopes;
  const originalLoad = Module._load;

  before(function () {
    Module._load = function (request) {
      if (request === 'electron') return electronStub;
      return originalLoad.apply(this, arguments);
    };
    const bridge = require('../src/main/mcpBridge');
    modelScopeAllows = bridge._internal.modelScopeAllows;
    normalizeModelScopes = bridge._internal.normalizeModelScopes;
  });

  after(function () {
    Module._load = originalLoad;
  });

  const userOpenAI = { id: 'user:local.7f3a', owner: 'user', provider: 'openai' };
  const pluginFake = { id: 'plugin:evil.gen', owner: 'plugin', provider: 'openai' };
  const builtinLocal = { id: 'builtin:singing.rvc', owner: 'builtin', provider: 'local' };

  it("'*' 覆盖全部端点", function () {
    const t = { models: ['*'] };
    expect(modelScopeAllows(t, userOpenAI)).to.equal(true);
    expect(modelScopeAllows(t, pluginFake)).to.equal(true);
    expect(modelScopeAllows(t, builtinLocal)).to.equal(true);
  });

  it('provider: 只匹配 owner 为 builtin/user 的端点', function () {
    const t = { models: ['provider:openai'] };
    expect(modelScopeAllows(t, userOpenAI)).to.equal(true);
    // 插件端点冒充同一 provider 不能蹭授权
    expect(modelScopeAllows(t, pluginFake)).to.equal(false);
  });

  it('endpoint: 精确匹配，不区分 owner', function () {
    const t = { models: ['endpoint:plugin:evil.gen'] };
    expect(modelScopeAllows(t, pluginFake)).to.equal(true);
    expect(modelScopeAllows(t, userOpenAI)).to.equal(false);
  });

  it('未配置 scope 等于不能用（默认拒绝）', function () {
    expect(modelScopeAllows({ models: [] }, userOpenAI)).to.equal(false);
    expect(modelScopeAllows({}, userOpenAI)).to.equal(false);
    expect(modelScopeAllows(null, userOpenAI)).to.equal(false);
  });

  it('非法 scope 在加载时就被丢掉，不做前缀通配', function () {
    const out = normalizeModelScopes(['openai:*', 'provider:openai', 'endpoint:user:a.b', '*', 'bogus']);
    expect(out).to.deep.equal(['provider:openai', 'endpoint:user:a.b', '*']);
  });

  it('provider 变更视为新 scope（授权不继承）', function () {
    const before = { id: 'user:local.7f3a', owner: 'user', provider: 'openai' };
    const after = { ...before, provider: 'evil' };
    const t = { models: ['provider:openai'] };
    expect(modelScopeAllows(t, before)).to.equal(true);
    expect(modelScopeAllows(t, after)).to.equal(false);
  });
});
