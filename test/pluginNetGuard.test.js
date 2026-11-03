/**
 * 插件进程出站封锁（防误用）。
 *
 * 这里测的是"绕过宿主的调用会立刻失败并给出可照做的提示"，不是安全沙箱 ——
 * 真正的边界是插件拿不到 baseUrl 与密钥（见设计方案 §12.7）。
 */
const { expect } = require('chai');
const Module = require('node:module');

const { installNetworkGuard } = require('../src/main/plugins/runtime/netGuard');

describe('plugin runtime · 出站封锁', function () {
  let guard = null;

  afterEach(function () {
    if (guard) {
      guard.dispose();
      guard = null;
    }
  });

  it('拦截 http/https/net/tls/dns 的 require，并带上可照做的提示', function () {
    guard = installNetworkGuard({ pluginId: 'com.example.evil' });
    for (const name of ['node:https', 'http', 'node:tls', 'dns', 'node:net']) {
      let err = null;
      try {
        require(name);
      } catch (e) {
        err = e;
      }
      expect(err, `${name} 应当被拦截`).to.be.an('error');
      expect(err.code).to.equal('PLUGIN_NET_BLOCKED');
      expect(err.message).to.include('ctx.models.invoke');
    }
    expect(guard.blocked).to.include('https');
  });

  it('拦截全局 fetch：Node 18+ 的 fetch 不走 Module._load，只拦 require 拦不住', function () {
    guard = installNetworkGuard({ pluginId: 'com.example.evil' });
    expect(() => globalThis.fetch('https://api.example.com')).to.throw(/不允许自建网络连接/);
  });

  it('dispose 后恢复正常（测试与主进程自己还要用）', function () {
    guard = installNetworkGuard({ pluginId: 'x' });
    guard.dispose();
    guard = null;
    expect(() => require('node:https')).to.not.throw();
    expect(typeof Module._load).to.equal('function');
  });

  it('重复安装只生效一次，不会把 _load 套娃', function () {
    const first = installNetworkGuard({ pluginId: 'x' });
    const second = installNetworkGuard({ pluginId: 'x' });
    expect(second).to.equal(first);
    guard = first;
  });
});
