/**
 * 纯 Node 测试环境屏蔽 Electron 二进制依赖。
 *
 * `node_modules/electron/index.js` 在 `path.txt` 缺失时会**当场**去 GitHub
 * Releases 下载 100MB+ 的安装包；下载失败就抛
 * "Electron failed to install correctly"。CI run 273 就是这样整轮 mocha 崩在
 * 加载阶段：npm ci 期间的下载连续 504，随后 test/cliPlugin.test.js 加载
 * cli.js（当时顶部有 `const { app } = require('electron')`）触发重试下载并抛错。
 *
 * src/main/** 里有一批模块在顶部 require('electron')，逐个改惰性不现实，也不该
 * 为了跑单测去改生产代码的加载语义。这里在测试进程最早期短路掉它：
 *
 *   · 只在二进制确实缺失时接管，本地装好了就完全不介入；
 *   · 返回值与"装好了"时 require('electron') 一致（可执行文件路径字符串），
 *     因此本地与 CI 的断言行为完全相同；
 *   · 各测试自己写的桩优先：require.cache 命中先返回，之后才是兜底值；
 *     测试里再包一层 Module._load 也照常生效（它包在我们外层）。
 *
 * 注意 `require.resolve` 只解析路径、不执行 index.js，因此本模块自身绝不会
 * 触发下载。
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

let uninstall = null;

/** electron 包根目录下的标记文件；装好二进制后由 install.js 写出。 */
function binaryMarkerPath() {
  try {
    return path.join(path.dirname(require.resolve('electron')), 'path.txt');
  } catch (_) {
    return null; // 连包都没装，交给调用方自己处理
  }
}

function isBinaryMissing(marker = binaryMarkerPath(), existsSync = fs.existsSync) {
  return !!marker && !existsSync(marker);
}

/**
 * 安装兜底。幂等：进程内只装一次，重复调用返回 false（已被自己安装过则 true）。
 *
 * @param {{force?: boolean, existsSync?: Function, cache?: object}} [opts]
 *   force / existsSync / cache 都是给单测用的注入点，生产（setup.js）不传。
 * @returns {boolean} 本次调用后兜底是否生效
 */
function installFallback(opts = {}) {
  if (uninstall) return true;
  const existsSync = opts.existsSync || fs.existsSync;
  if (!opts.force && !isBinaryMissing(binaryMarkerPath(), existsSync)) return false;

  const electronEntry = require.resolve('electron');
  const fakeBinary = path.join(
    path.dirname(electronEntry), 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  );
  const cache = opts.cache || require.cache;
  const originalLoad = Module._load;

  const patchedElectronLoad = function (request) {
    if (request === 'electron') {
      const cached = cache[electronEntry];
      if (cached) return cached.exports;
      return fakeBinary;
    }
    return originalLoad.apply(this, arguments);
  };
  Module._load = patchedElectronLoad;

  uninstall = function restore() {
    if (Module._load === patchedElectronLoad) Module._load = originalLoad;
    uninstall = null;
  };
  return true;
}

function uninstallFallback() {
  if (uninstall) uninstall();
}

module.exports = {
  binaryMarkerPath,
  isBinaryMissing,
  installFallback,
  uninstallFallback,
};
