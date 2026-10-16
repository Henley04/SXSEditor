/**
 * 拷贝树依赖闭包守卫 —— CopyPlugin 原样拷贝的文件必须在 .webpack 里自洽。
 *
 * 背景（真实故障）：审查修复把 IPC 通道改成 `IPC_CHANNELS.X` 常量后，
 * `src/inference/pipeline/index.js` 新增了 `require('../../shared/ipcChannels')`，
 * `textProcessing.js` 新增了 `require('../../shared/jpPhonemeMap')`，
 * `src/main/pluginWorker.js` 新增了 `require('../shared/pluginPermissions.js')`。
 *
 * 这些文件都是**按路径裸加载**的（worker_threads / fork 直接跑 .webpack 下的
 * 原始副本，不经过 webpack 解析），而 CopyPlugin 从来没有拷过 src/shared 目录，
 * 于是打包后运行即 MODULE_NOT_FOUND —— svs:init 直接失败，整个合成链路起不来。
 * 单元测试全绿也测不出来：测试 require 的是 src/ 源码，不是 .webpack 副本。
 *
 * 本测试从 webpack.main.config.js 里读出真实的 CopyPlugin patterns，重建
 * "哪些文件会被拷到哪里"，然后从**裸加载入口**出发做相对 require 的传递闭包，
 * 断言每个依赖都落在拷贝集合内。任何"新增跨树 require 但没同步拷贝配置"
 * 的改动都会在这里失败，而不是等到用户点播放才发现。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(ROOT, 'src');
const MAIN_OUT = path.join(ROOT, '.webpack', 'main');

const webpackMain = require(path.join(ROOT, 'webpack.main.config.js'));
const configs = Array.isArray(webpackMain) ? webpackMain : [webpackMain];

/**
 * 裸加载入口 = 单独（而非随目录）拷贝的 .js 文件，外加少量显式登记项。
 *
 * CopyPlugin 里被逐文件拷贝的这些文件，全部是 worker/fork 的真实入口 ——
 * 运行时按路径直接 new Worker / fork，不经过 webpack 的模块解析，所以它们
 * 及其 require 闭包必须完全落在拷贝集合内。随目录拷贝的文件（src/main/**、
 * src/inference/** 等）同时也被 webpack 打进 bundle，走的是 bundle 内的
 * require 解析，不属于裸加载，**不能**拿它们当入口 —— 否则每个 IPC 模块都会
 * 被误报（它们 require 的是 src/main 内互相引用，解析基准是 src 而不是 .webpack）。
 */
const EXTRA_RAW_ENTRIES = [
  // pluginWorker.js 落在 `src/main` 目录拷贝范围内，但它是 worker 入口
  // （见 pluginHost.js 的 WORKER_ENTRY_CANDIDATES），必须按路径裸加载。
  path.join(MAIN_OUT, 'main', 'pluginWorker.js'),
];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** 把 `**<star>` / `**<star>/a/b.js` 这类 ignore glob（前缀是递归通配）翻译成判定函数。 */
function ignoreMatcher(patterns) {
  const list = patterns || [];
  return (relPosix) =>
    list.some((raw) => {
      const g = toPosix(raw);
      if (g.startsWith('**/')) {
        const rest = g.slice(3);
        return relPosix === rest || relPosix.endsWith('/' + rest);
      }
      return relPosix === g;
    });
}

function walkFiles(dir, isIgnored, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out; // 源目录不存在（如 clean clone 缺 native/ 预编译产物）
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = toPosix(path.relative(dir, abs));
    if (isIgnored(rel)) continue;
    if (e.isDirectory()) walkFiles(abs, isIgnored, out);
    else out.push(abs);
  }
  return out;
}

/** dest 绝对路径 -> src 绝对路径；并记录哪些 dest 来自"逐文件"pattern（裸加载入口）。 */
function collectCopiedFiles() {
  const map = new Map();
  const fileEntries = [];
  for (const cfg of configs) {
    for (const plugin of cfg.plugins || []) {
      const patterns = plugin && plugin.patterns;
      if (!Array.isArray(patterns)) continue;
      for (const pat of patterns) {
        const from = pat.from;
        const to = pat.to;
        let st;
        try {
          st = fs.statSync(from);
        } catch (_) {
          continue; // noErrorOnMissing：源不存在时构建不报错，这里也不该失败
        }
        if (st.isDirectory()) {
          const isIgnored = ignoreMatcher(pat.globOptions && pat.globOptions.ignore);
          for (const srcFile of walkFiles(from, isIgnored)) {
            const rel = path.relative(from, srcFile);
            map.set(path.join(to, rel), srcFile);
          }
        } else {
          map.set(to, from);
          fileEntries.push(to);
        }
      }
    }
  }
  return { map, fileEntries };
}

const REQUIRE_RE = /require\(\s*(['"])(\.[^'"]+)\1\s*\)/g;

/** 在 src 侧解析相对 spec（不依赖 .webpack 是否已构建过）。 */
function resolveRelative(srcFile, spec) {
  const base = path.resolve(path.dirname(srcFile), spec);
  const candidates = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

describe('CopyPlugin 拷贝树依赖闭包', () => {
  const { map: copied, fileEntries } = collectCopiedFiles();
  const copiedPosix = new Set([...copied.keys()].map(toPosix));

  const rawEntries = [...new Set([...fileEntries.filter((d) => d.endsWith('.js')), ...EXTRA_RAW_ENTRIES])]
    .filter((dest) => copied.has(dest) || EXTRA_RAW_ENTRIES.includes(dest));

  it('webpack.main.config.js 至少配置了裸加载入口所需的拷贝', () => {
    assert.ok(copied.size > 0, '未从 webpack.main.config.js 解析出任何 CopyPlugin pattern');
    assert.ok(rawEntries.length > 0, '未识别出任何裸加载入口，守卫形同虚设');
  });

  it('src/shared 被拷到 .webpack/main/shared（跨树 require 的落点）', () => {
    // 这条断言把"必须整树拷贝"钉死：只要 inference/main 侧存在对 ../shared 的
    // 相对 require，缺了它整条合成/插件链路在打包版上就是 MODULE_NOT_FOUND。
    assert.ok(
      copied.has(path.join(MAIN_OUT, 'shared', 'ipcChannels.js')),
      'CopyPlugin 未拷贝 src/shared/ipcChannels.js —— svsWorker 会以 MODULE_NOT_FOUND 失败'
    );
    assert.ok(
      copied.has(path.join(MAIN_OUT, 'shared', 'jpPhonemeMap.js')),
      'CopyPlugin 未拷贝 src/shared/jpPhonemeMap.js —— pipeline/textProcessing.js 会失败'
    );
    assert.ok(
      copied.has(path.join(MAIN_OUT, 'shared', 'pluginPermissions.js')),
      'CopyPlugin 未拷贝 src/shared/pluginPermissions.js —— pluginWorker 入口会失败'
    );
  });

  it('裸加载入口的相对 require 闭包全部落在拷贝集合内', () => {
    const problems = [];
    const visited = new Set();
    const queue = rawEntries.slice();

    while (queue.length > 0) {
      const destFile = queue.shift();
      if (visited.has(destFile)) continue;
      visited.add(destFile);

      const srcFile = copied.get(destFile);
      if (!srcFile) {
        problems.push(`${toPosix(path.relative(ROOT, destFile))}：不在 CopyPlugin 拷贝集合内却被当作裸加载入口`);
        continue;
      }
      if (!srcFile.endsWith('.js')) continue;

      const text = fs.readFileSync(srcFile, 'utf8');
      REQUIRE_RE.lastIndex = 0;
      let m;
      while ((m = REQUIRE_RE.exec(text)) !== null) {
        const spec = m[2];
        const resolvedSrc = resolveRelative(srcFile, spec);
        if (!resolvedSrc) {
          problems.push(
            `${toPosix(path.relative(ROOT, srcFile))}：require('${spec}') 在源码里就解析不到`
          );
          continue;
        }
        const relFromSrc = toPosix(path.relative(ROOT, resolvedSrc));
        const copiedDest = path.join(MAIN_OUT, path.relative(SRC_ROOT, resolvedSrc));
        if (!copiedPosix.has(toPosix(copiedDest))) {
          problems.push(
            `${toPosix(path.relative(ROOT, srcFile))}：require('${spec}') 依赖 ${relFromSrc}，` +
              `但该文件不在 CopyPlugin 拷贝集合内（打包后 MODULE_NOT_FOUND）`
          );
          continue;
        }
        queue.push(copiedDest);
      }
    }

    assert.strictEqual(
      problems.length,
      0,
      '裸加载入口存在未被拷贝的依赖：\n  - ' + problems.join('\n  - ')
    );
  });
});