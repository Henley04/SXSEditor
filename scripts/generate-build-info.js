// Generates package-time metadata for the app and the splash screen.
//
// Outputs:
//   · src/build-info.json  —— 版本 / 构建时间 / 渠道，运行时由 updateChecker、
//                             cli、settings 等读取；
//   · src/splash@2x.png  —— 启动画面位图（2x/3x，见 scripts/generate-splash-image.js）；
//     src/splash@3x.png
//
// Runs via the prestart / prepackage / prepackage:lite npm scripts so both the
// local `npm run package:lite` and CI produce byte-identical structure (only the
// baked-in timestamp/version differ).
//
// Usage: node scripts/generate-build-info.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

// Format: YYYY-MM-DD HH:mm:ss (local time, +ZZ:ZZ offset)
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const offsetMin = -now.getTimezoneOffset();
const sign = offsetMin >= 0 ? '+' : '-';
const absMin = Math.abs(offsetMin);
const offsetStr = `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;

const buildDate =
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
  ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
  ` ${offsetStr}`;

// ISO8601 timestamp (machine-readable) plus epoch ms
const buildDateISO = now.toISOString();
const buildTimestamp = now.getTime();

// ---------------------------------------------------------------------------
// 启动画面专用的展示格式
// ---------------------------------------------------------------------------
// 截图里的版式是 `Build Date: YY/MM/DD. HH:MM:SS(UTC+X)`，与上面的完整
// buildDate 不是同一种写法，所以单独给出 buildDateDisplay + utcOffset 两个
// 字段，让 generate-splash-image.js 直接拼、不做正则改写。
const buildDateDisplay =
  `${pad(now.getFullYear() % 100)}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}. ` +
  `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

// `UTC+8` / `UTC-5` / `UTC+5:30` —— 整点时区省掉 `:00`，与截图一致。
const utcOffset =
  `UTC${sign}${Math.floor(absMin / 60)}` + (absMin % 60 ? `:${pad(absMin % 60)}` : '');

// 渠道标签（splash 的 `Version X.X.X (Stable/Nightly)`）：
//   · CI 的 release 分支在 `Determine version and tag` 里导出 SXS_CHANNEL=stable；
//   · 其余情况（nightly 分支、本地 package:lite、dev）一律 Nightly —— 本地构建
//     本来就不是正式版，标成 Stable 会误导。
// 只认显式的 `stable`，拼错的值降级为 Nightly 而不是猜。
const channel = String(process.env.SXS_CHANNEL || '').toLowerCase() === 'stable'
  ? 'Stable'
  : 'Nightly';

const info = {
  productName: pkg.productName || pkg.name,
  version: pkg.version,
  buildDate,
  buildDateDisplay,
  utcOffset,
  channel,
  buildYear: now.getFullYear(),
  buildDateISO,
  buildTimestamp,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
};

const outPath = path.join(root, 'src', 'build-info.json');
fs.writeFileSync(outPath, JSON.stringify(info, null, 2) + '\n', 'utf8');
console.log(`[build-info] wrote ${path.relative(root, outPath)}`);
console.log(
  `[build-info] version=${info.version} channel=${info.channel} ` +
  `buildDate=${info.buildDate}`
);

// ---------------------------------------------------------------------------
// 启动画面位图
// ---------------------------------------------------------------------------
// 之前的启动画面是 `src/splash.html.template`（内联 SVG + <text>）在构建期做
// 占位符替换生成 HTML。现在窗口是 BaseWindow + ImageView（没有 HTML、没有
// 渲染进程），版式固定、只有时间/版本/渠道是变量，于是整张烘焙成 PNG
// （src/splash@2x.png / @3x.png，均为构建产物、不入库）。
// 好处是首帧不再依赖字体匹配与字形 shaping，代价是必须每次构建重新生成
// 这两张图 —— 也就是下面这一行。
const { generate } = require('./generate-splash-image.js');
generate();

console.log(`[build-info] done`);
