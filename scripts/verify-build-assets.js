#!/usr/bin/env node
/**
 * verify-build-assets —— 打包前的关键资源存在性校验。
 *
 * 背景（审查项 §5）：webpack.main.config.js / webpack.renderer.config.js 里的
 * CopyPlugin 现在统一带 `noErrorOnMissing: true`——copy-webpack-plugin v14 默认
 * 遇到 ENOENT 会直接让整次构建失败，而"少拷一个字典文件"这种问题本不该表现为
 * 一条晦涩的 webpack 报错。代价是缺失会变成静默：产物里少一个文件，运行时才炸。
 *
 * 因此把"必须存在"的资源清单集中到这里，在 prepackage 阶段显式校验并一次性
 * 列出所有缺失项（而不是拷到第一个就崩），缺失时非零退出阻断打包。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// 主进程 bundle 运行期必需的随包资源（与 webpack.main.config.js 的 patterns 对应）
const REQUIRED_MAIN_ASSETS = [
  'src/inference/phone_set.json',
  'src/inference/en_g2p_dict.json',
  'src/inference/en_phoneme_durations.json',
  'src/inference/pipeline/jpKanjiDict.json',
  'src/audio/audioWorker.js',
  'src/audio/audioFormatUtils.js',
  'src/utils/gpuWorker.js',
  'src/utils/deviceClassifier.js',
  'src/utils/resampleAudio.js',
  'src/inference/svsWorker.js',
  'src/inference/pitchWorker.js',
  'src/inference/rmvpePitchDetector.js',
  'src/inference/pipeline/float16Patch.js',
  'src/inference/winml/trtDiagnostic.js',
  'src/inference/winml/trtDiagnosticRunner.js',
  'assets/SXS.png',
];

// 渲染进程：每个窗口 HTML 都用 <script src="./themes/themeBootstrap.js"> 做首屏
// 防闪烁，缺一个就是一个窗口首屏闪白 + 控制台 404。
const REQUIRED_RENDERER_ASSETS = [
  'src/themes/themeBootstrap.js',
];

// Splash 窗口不走 webpack 渲染入口（forge 的 entryPoints 强制要求 js，splash
// 恰恰要零 JS），HTML 由 webpack.main.config.js 的 CopyPlugin 拷到
// .webpack/main/splash.html，splashManager 用 loadFile() 加载。
//
// 它必须出现在这份清单里：CopyPlugin 的 pattern 带 noErrorOnMissing，生成产物
// src/splash.html 缺失时只会静默跳过拷贝 → 打包成功但启动画面 404（空白窗口）。
// prepackage 里本脚本先于 generate-build-info.js 运行，所以校验的是**模板**
// src/splash.html.template（受版本控制，一定存在）；模板缺失即产物必缺失。
const REQUIRED_SPLASH_ASSETS = [
  'src/splash.html.template',
];

// 可选资源：缺失只警告，不阻断（例如 native 预构建在干净 clone 上不存在）
const OPTIONAL_ASSETS = [
  'native/ort-bridge/build/Release/ort_bridge.node',
  'native/ort-bridge/prebuilt/win32-x64/ort_bridge.node',
];

function check(list) {
  const missing = [];
  for (const rel of list) {
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
  }
  return missing;
}

const missingRequired = check([
  ...REQUIRED_MAIN_ASSETS,
  ...REQUIRED_RENDERER_ASSETS,
  ...REQUIRED_SPLASH_ASSETS,
]);
const missingOptional = check(OPTIONAL_ASSETS);

if (missingOptional.length > 0) {
  console.warn('[verify-build-assets] 可选资源缺失（不阻断打包）：');
  for (const rel of missingOptional) console.warn(`  - ${rel}`);
}

if (missingRequired.length > 0) {
  console.error('[verify-build-assets] 必需资源缺失，打包已中止：');
  for (const rel of missingRequired) console.error(`  - ${rel}`);
  console.error(
    '\n这些文件由 webpack CopyPlugin 随包拷贝。现在 pattern 带 noErrorOnMissing，' +
    '缺文件不会在 webpack 阶段报错，而是在运行时表现为"找不到字典/脚本 404"。\n' +
    '请确认文件是否被 .gitignore 误伤，或在 .github/workflows 的构建步骤里补上生成步骤。'
  );
  process.exit(1);
}

console.log(
  `[verify-build-assets] OK：${REQUIRED_MAIN_ASSETS.length + REQUIRED_RENDERER_ASSETS.length + REQUIRED_SPLASH_ASSETS.length} 个必需资源齐全。`
);
