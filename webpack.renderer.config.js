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
      presets: ['@babel/preset-env'],
    },
  },
});

// onnxruntime-web 文件复制模式
// 使用 globOptions 以正确处理 glob 模式
const ortDistDir = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist');
const onnxruntimeWasmPatterns = ONNX_WINDOW_NAMES.flatMap((name) => [
  {
    from: '*.wasm',
    to: path.resolve(__dirname, `.webpack/renderer/${name}/[name][ext]`),
    context: ortDistDir,
  },
  {
    from: 'ort-wasm*.{js,mjs}',
    to: path.resolve(__dirname, `.webpack/renderer/${name}/[name][ext]`),
    context: ortDistDir,
  },
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
