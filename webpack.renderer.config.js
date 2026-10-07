const baseRules = require('./webpack.rules');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

// Exclude native module asset relocator from renderer (renderer uses preload bridge, no direct native module imports)
const rules = baseRules.filter(r => !r.use || r.use.loader !== '@vercel/webpack-asset-relocator-loader');
const CopyPlugin = require('copy-webpack-plugin');
const path = require('node:path');

const WINDOW_NAMES = [
  'main_window',
  'fragment_editor_window',
  'singer_creator_window',
  'audio_preprocess_window',
  'settings_window',
  'model_download_window',
  'resource_manager_window',
  'splash_window',
  'singer_market_window',
];

// Windows that need onnxruntime-web wasm/JS files copied alongside.
//
// Only `main_window` actually loads onnxruntime-web: it is the sole renderer
// that imports `src/inference/webnn/index.js` (see src/renderer/ipcHandlers.js).
// All other windows either have no inference (settings, model_download,
// resource_manager, update_notification, splash) or delegate inference to the
// main process via IPC (fragment_editor, singer_creator, audio_preprocess).
//
// Copying the ort UMD + 4 wasm variants (~76.84 MB) to every non-splash window
// used to cost ~538 MB of duplicated bytes inside app.asar. Restricting the
// copy to `main_window` keeps the same runtime behaviour while shaving that
// duplication.
const ONNX_WINDOW_NAMES = ['main_window'];

rules.push({
  test: /\.css$/,
  use: [
    MiniCssExtractPlugin.loader,
    { loader: 'css-loader' },
  ],
});

rules.push({
  test: /\.js$/,
  exclude: /(node_modules|\.webpack)/,
  use: {
    loader: 'babel-loader',
    options: {
      presets: [['@babel/preset-env', { targets: { electron: '42' }, modules: false, bugfixes: true }]],
    },
  },
});

// onnxruntime-web 文件复制模式
// 使用 globOptions 以正确处理 glob 模式
const ortDistDir = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist');
//
// P2：wasm 变体收窄。原先 `from: '*.wasm'` 会把 dist 下**全部** wasm 变体拷进每个
// 渲染进程目录（jsep 26.8 MB + asyncify 24.3 MB + jspi 15.0 MB + 基础 13.5 MB
// ≈ 80 MB，且对 ONNX_WINDOW_NAMES 里的每个窗口各拷一份）。
//
// 收窄依据（对本仓库实际安装的 onnxruntime-web@1.27.0 做过核查，不是推测）：
//   · ort.all.min.js 里唯一硬编码的 loader 文件名是 "ort-wasm-simd-threaded.jsep.mjs"
//     （`grep -o "ort-wasm[a-zA-Z0-9._-]*" dist/ort.all.min.js` 只命中
//     ort-wasm-proxy-worker 与 ort-wasm-simd-threaded.jsep.mjs）；
//   · 它对应的 .mjs 只引用 ort-wasm-simd-threaded.jsep.wasm；
//   · 本应用在 src/inference/webnn/ortSetup.js 里设 ort.env.wasm.wasmPaths = './'，
//     文件名由上面这个 loader 自己拼，不会去探测 asyncify / jspi 变体。
// 因此 asyncify 与 jspi 两个实验性变体（合计 39.3 MB/窗口）是纯死重。
// 保留 jsep（WebNN/WebGPU 路径实际使用）与基础变体（纯 CPU 兜底）。
const ORT_WASM_VARIANTS = [
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.wasm',
];
// 与 wasm 一一对应的 loader 脚本。注意 onnxruntime-web@1.27 的 dist 里
// 只有 .mjs loader（没有同名 .js），这一点已用 fs.existsSync 逐个核过：
//   ort-wasm-simd-threaded.jsep.mjs ✔   ort-wasm-simd-threaded.jsep.js ✘
//   ort-wasm-simd-threaded.mjs     ✔   ort-wasm-simd-threaded.js     ✘
// 所以这里只列 .mjs；写上 .js 会让 copy-webpack-plugin 报 ENOENT。
const ORT_LOADER_VARIANTS = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.mjs',
];

const onnxruntimeWasmPatterns = ONNX_WINDOW_NAMES.flatMap((name) => [
  ...ORT_WASM_VARIANTS.map((file) => ({
    from: file,
    to: path.resolve(__dirname, `.webpack/renderer/${name}/[name][ext]`),
    context: ortDistDir,
  })),
  ...ORT_LOADER_VARIANTS.map((file) => ({
    from: file,
    to: path.resolve(__dirname, `.webpack/renderer/${name}/[name][ext]`),
    context: ortDistDir,
  })),
  // 复制包含 WebNN 的 onnxruntime-web UMD 包（通过 script 标签加载，绕过 webpack）
  {
    from: path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.all.min.js'),
    to: path.resolve(__dirname, `.webpack/renderer/${name}/ort.all.min.js`),
  },
]);

module.exports = {
  // Put your normal webpack config below here
  // Disable source maps in production builds to shrink app.asar (~21 MB of
  // *.map files used to ship inside the packaged app). Dev mode (`npm start`)
  // keeps source maps because NODE_ENV is not set there.
  devtool: process.env.NODE_ENV === 'production' ? false : undefined,
  module: {
    rules,
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  plugins: [
    new MiniCssExtractPlugin({
      filename: '[name]/style.css',
    }),
    new CopyPlugin({
      patterns: WINDOW_NAMES.flatMap((name) => [
        {
          from: path.resolve(__dirname, 'src/themes/themeBootstrap.js'),
          to: path.resolve(__dirname, `.webpack/renderer/${name}/themes/themeBootstrap.js`),
        },
      ]).concat(onnxruntimeWasmPatterns).concat([
        // Splash window icon: the inline SVG in splash.html references
        // ./SXS.png via a relative URL so the icon loads in parallel
        // with HTML parse (no IPC round-trip on the critical path to
        // first paint). Only the splash_window needs this copy because
        // other windows don't render the splash SVG.
        {
          from: path.resolve(__dirname, 'assets/SXS.png'),
          to: path.resolve(__dirname, '.webpack/renderer/splash_window/SXS.png'),
        },
      ]),
    }),
  ],
  resolve: {
    fallback: {
      fs: false,
      path: false,
    },
  },
};
