// Generates src/build-info.json with package-time metadata
// (build date, version, package name). Runs via the prepackage /
// prepackage:lite npm scripts so the splash screen can display it.
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

const info = {
  productName: pkg.productName || pkg.name,
  version: pkg.version,
  buildDate,
  buildDateISO,
  buildTimestamp,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
};

const outPath = path.join(root, 'src', 'build-info.json');
fs.writeFileSync(outPath, JSON.stringify(info, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------------------
// Splash HTML 占位符替换
//
// 模板是 src/splash.html.template（仓库里唯一的源，带注释与缩进），
// 产物是 src/splash.html（被 .gitignore 忽略，每次构建重新生成）。
//
// src/splash.html 里**不含任何 <script>**：首帧完全靠 HTML 内联 SVG 绘制，
// 版本号/日期在构建期就写死，因此 splash 窗口不需要 preload、不需要 IPC
// 往返 —— 这正是把 splash 首帧从"加载 preload + bundle + 一次 IPC"压缩到
// "纯 HTML parse"的地方。
//
// 为什么用模板 + 产物两份文件，而不是原地改 splash.html：原地改会让脚本
// 不可重入（第二次运行时 token 已被替换，"从原始内容重新生成"无从谈起），
// 也让工作区出现一处永远带构建产物的脏文件。
//
// 幂等：每次都从 .template 重新生成，重复运行结果一致。
// ---------------------------------------------------------------------------

// 图标以相对 URL 引用，由渲染进程直接加载，和 HTML parse 并行，不需要 IPC。
// 打包时 assets/SXS.png 由 webpack.renderer.config.js 的 CopyPlugin 拷到
// .webpack/renderer/splash_window/SXS.png，相对路径在 dev / packaged 下
// 都是 "./SXS.png"。
const SPLASH_ICON = './SXS.png';

const splashTpl = path.join(root, 'src', 'splash.html.template');
if (!fs.existsSync(splashTpl)) {
  throw new Error(`[build-info] 找不到模板 ${splashTpl}`);
}
const html = fs
  .readFileSync(splashTpl, 'utf8')
  .replaceAll('__SPLASH_VERSION__', escapeXmlText(info.version))
  .replaceAll('__SPLASH_BUILD_DATE__', escapeXmlText(info.buildDate))
  .replaceAll('__SPLASH_ICON__', escapeXmlText(SPLASH_ICON));

if (html.includes('__SPLASH_')) {
  throw new Error(
    '[build-info] splash.html.template 仍含未替换的 __SPLASH_*__ 占位符；' +
    '占位符名与本脚本不同步。'
  );
}
const splashOut = path.join(root, 'src', 'splash.html');
fs.writeFileSync(splashOut, html, 'utf8');
console.log(`[build-info] generated ${path.relative(root, splashOut)} from template`);

// 文本节点里的 & < > 必须转义，否则 "1.0.2 <beta>" 之类会破坏 SVG/XML。
function escapeXmlText(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

console.log(`[build-info] wrote ${path.relative(root, outPath)}`);
console.log(`[build-info] version=${info.version} buildDate=${info.buildDate}`);
