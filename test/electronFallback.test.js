const { expect } = require('chai');
const fs = require('node:fs');
const Module = require('node:module');

const fallback = require('./electronBinaryFallback');
const cliPath = require.resolve('../src/main/cli');
const setupPath = require.resolve('./setup');

/**
 * CI run 273：npm ci 期间 Electron 二进制下载连续 504 → 测试加载阶段任何一次
 * `require('electron')` 都会让 node_modules/electron/index.js 再下载一次并抛错 →
 * 整个 test job 崩在 "Electron failed to install correctly"。
 *
 * 这里守两条独立防线：测试进程最早期把 electron 短路掉（setup.js），以及 CLI
 * 本身在纯 Node 下可用（cli.js 不再顶部 require electron）。
 */
describe('Electron 二进制独立性', function () {
  describe('setup.js 的兜底', function () {
    afterEach(function () {
      fallback.uninstallFallback();
    });

    it('setup.js 在加载阶段就安装了兜底', function () {
      const src = fs.readFileSync(setupPath, 'utf8');
      expect(src).to.include("require('./electronBinaryFallback').installFallback()");
    });

    it('二进制缺失时短路 require("electron")，不执行 index.js', function () {
      const electronEntry = require.resolve('electron');
      const before = require.cache[electronEntry];
      // 空 cache 强制走兜底分支（本地若已加载过 index.js 会掩盖它）
      expect(fallback.installFallback({ force: true, cache: {} })).to.equal(true);

      const value = require('electron');
      expect(value).to.be.a('string');
      expect(value).to.match(/electron/);
      // 关键：没有真的加载 node_modules/electron/index.js，也就不会触发下载
      expect(require.cache[electronEntry]).to.equal(before);
    });

    it('测试自己写进 require.cache 的 electron 桩优先于兜底值', function () {
      const electronEntry = require.resolve('electron');
      const stub = { app: { getPath: () => 'STUB_PATH' } };
      fallback.installFallback({
        force: true,
        cache: { [electronEntry]: { exports: stub } },
      });

      expect(require('electron').app.getPath('userData')).to.equal('STUB_PATH');
    });

    it('卸载后 Module._load 恢复原样', function () {
      const original = Module._load;
      fallback.installFallback({ force: true });
      expect(Module._load).to.not.equal(original);
      fallback.uninstallFallback();
      expect(Module._load).to.equal(original);
    });

    it('本机装好二进制时兜底不介入', function () {
      if (fallback.isBinaryMissing()) this.skip(); // CI 上二进制缺失，此用例不适用
      expect(fallback.installFallback()).to.equal(false);
      expect(Module._load.name).to.not.equal('patchedElectronLoad');
    });
  });

  describe('CLI 在纯 Node 下可用', function () {
    it('加载 cli.js 不会 require electron', function () {
      const seen = [];
      const original = Module._load;
      Module._load = function spyLoad(request) {
        if (request === 'electron') seen.push(request);
        return original.apply(this, arguments);
      };
      try {
        delete require.cache[cliPath];
        require(cliPath);
      } finally {
        Module._load = original;
        delete require.cache[cliPath];
      }
      expect(seen).to.deep.equal([]);
    });

    it('--cli info 在 Electron 不可用时仍返回 0 并说明原因', async function () {
      const original = Module._load;
      const originalWrite = process.stdout.write;
      const writes = [];
      Module._load = function blockedLoad(request) {
        if (request === 'electron') throw new Error('Electron binary missing');
        return original.apply(this, arguments);
      };
      process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
      try {
        delete require.cache[cliPath];
        const { runCli } = require(cliPath);
        const code = await runCli(['--cli', 'info']);
        expect(code).to.equal(0);
        expect(writes.join('')).to.include('n/a (not running under Electron)');
      } finally {
        Module._load = original;
        process.stdout.write = originalWrite;
        delete require.cache[cliPath];
      }
    });
  });
});
