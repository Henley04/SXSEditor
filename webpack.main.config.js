const CopyPlugin = require('copy-webpack-plugin');
const path = require('node:path');

module.exports = {
  entry: './src/main.js',
  // Disable source maps in production builds to shrink app.asar. Dev mode
  // (`npm start`) keeps source maps because NODE_ENV is not set there.
  devtool: process.env.NODE_ENV === 'production' ? false : undefined,
  module: {
    rules: require('./webpack.rules'),
  },
  externals: [
    {
      'onnxruntime-node': 'commonjs onnxruntime-node',
      // TensorFlow.js 以按需子包形式引入（见 package.json 与 src/inference/basicPitch.js）：
      // core 提供 tensor/signal 等基础 API，converter 提供 GraphModel 权重加载，
      // backend-cpu / backend-wasm 提供 setBackend('cpu'|'wasm')。
      // 它们都是纯 JS（+ wasm 二进制），没有原生模块，因此不需要被 webpack 打进主进程
      // bundle。保持 external 后：
      //   - 主 bundle 体积显著下降，打包耗时/内存也更低；
      //   - tfjs 直接从 node_modules 运行时加载（node_modules 由 forge 保留）。
      // 仅 basicPitch（BASIC-PITCH 转谱）会真正 require 它们。
      '@tensorflow/tfjs-core': 'commonjs @tensorflow/tfjs-core',
      '@tensorflow/tfjs-converter': 'commonjs @tensorflow/tfjs-converter',
      '@tensorflow/tfjs-backend-cpu': 'commonjs @tensorflow/tfjs-backend-cpu',
      '@tensorflow/tfjs-backend-wasm': 'commonjs @tensorflow/tfjs-backend-wasm',
      'systeminformation': 'commonjs systeminformation',
      // Native-backed modules must stay outside the bundle so their .node
      // binaries load from node_modules (kept + asar-unpacked by forge).
      'sxs-ort-bridge': 'commonjs sxs-ort-bridge',
      '@microsoft/dynwinrt': 'commonjs @microsoft/dynwinrt',
    },
    // 兜底：任何 @tensorflow/* 子包（tfjs-core、tfjs-converter 等）都不打包
    ({ request }, callback) => (
      /^@tensorflow\//.test(request) ? callback(null, `commonjs ${request}`) : callback()
    ),
  ],
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'src/inference/phone_set.json'),
          to: path.resolve(__dirname, '.webpack/main/phone_set.json'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/inference/en_g2p_dict.json'),
          to: path.resolve(__dirname, '.webpack/main/en_g2p_dict.json'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/inference/en_phoneme_durations.json'),
          to: path.resolve(__dirname, '.webpack/main/en_phoneme_durations.json'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/inference/pipeline/jpKanjiDict.json'),
          to: path.resolve(__dirname, '.webpack/main/jpKanjiDict.json'),
          noErrorOnMissing: true,
        },
        {
          // src/audio 整树拷贝：audioWorker.js 是裸加载的 worker 入口，它在运行时
          // 按路径加载同目录的 audioOutputManager.js（见该文件的 CANDIDATES 探测），
          // 而 audioOutputManager / wavEncoder 又被 src/main/cli.js、audioIpc.js
          // 以 ../audio/xxx 相对引用。逐文件拷贝只覆盖了 worker 本身，闭包是断的。
          from: path.resolve(__dirname, 'src/audio'),
          to: path.resolve(__dirname, '.webpack/main/audio'),
          noErrorOnMissing: true,
        },
        {
          // src/shared 整树拷贝：svsWorker / pitchWorker / pluginWorker 是**按路径
          // 裸加载**的（worker_threads / fork 直接跑 .webpack 下的原始副本，不经过
          // webpack 模块解析）。pipeline/index.js、pipeline/textProcessing.js、
          // pluginWorker.js 现在都 require 了 ../shared 下的模块，缺这一条就是
          // 运行时 MODULE_NOT_FOUND（svs:init 直接失败，整条合成链路起不来）。
          // 单元测试测不出来：测试 require 的是 src/ 源码，不是 .webpack 副本。
          // 守卫：test/copyWebpackClosure.test.js
          from: path.resolve(__dirname, 'src/shared'),
          to: path.resolve(__dirname, '.webpack/main/shared'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/utils/gpuWorker.js'),
          to: path.resolve(__dirname, '.webpack/main/utils/gpuWorker.js'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/utils/deviceClassifier.js'),
          to: path.resolve(__dirname, '.webpack/main/utils/deviceClassifier.js'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/main'),
          to: path.resolve(__dirname, '.webpack/main/main'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/utils'),
          to: path.resolve(__dirname, '.webpack/main/utils'),
          globOptions: { ignore: ['**/gpuWorker.js', '**/deviceClassifier.js'] },
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/inference'),
          to: path.resolve(__dirname, '.webpack/main/inference'),
          globOptions: {
            ignore: ['**/pitchWorker.js', '**/svsWorker.js', '**/rmvpePitchDetector.js', '**/pipeline/float16Patch.js', '**/pipeline/jpKanjiDict.json'],
          },
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/inference/svsWorker.js'),
          to: path.resolve(__dirname, '.webpack/main/inference/svsWorker.js'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/inference/pitchWorker.js'),
          to: path.resolve(__dirname, '.webpack/main/inference/pitchWorker.js'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/inference/rmvpePitchDetector.js'),
          to: path.resolve(__dirname, '.webpack/main/inference/rmvpePitchDetector.js'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/utils/resampleAudio.js'),
          to: path.resolve(__dirname, '.webpack/main/utils/resampleAudio.js'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/inference/pipeline/float16Patch.js'),
          to: path.resolve(__dirname, '.webpack/main/inference/pipeline/float16Patch.js'),
          noErrorOnMissing: true,
        },
        {
          // These files run in an isolated child process and therefore cannot
          // be hidden inside main/index.js. Preserve their relative directory
          // layout so trtDiagnosticRunner can require trtDiagnostic and the
          // existing inference modules beside it.
          from: path.resolve(__dirname, 'src/inference/winml/trtDiagnosticRunner.js'),
          to: path.resolve(__dirname, '.webpack/main/inference/winml/trtDiagnosticRunner.js'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/inference/winml/trtDiagnostic.js'),
          to: path.resolve(__dirname, '.webpack/main/inference/winml/trtDiagnostic.js'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'native/build/Release/executorch_runtime.node'),
          to: path.resolve(__dirname, '.webpack/main/native/executorch_runtime.node'),
          noErrorOnMissing: true,
        },
        {
          // sxs-ort-bridge 预构建二进制：随 bundle 拷贝到固定位置，
          // 避免 file: 依赖在 forge 打包 prune 后内容丢失的问题
          from: path.resolve(__dirname, 'native/ort-bridge/build/Release/ort_bridge.node'),
          to: path.resolve(__dirname, '.webpack/main/native/ort_bridge.node'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'native/ort-bridge/prebuilt/win32-x64/ort_bridge.node'),
          to: path.resolve(__dirname, '.webpack/main/native/ort_bridge_prebuilt.node'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/inference/pipeline/jpKanjiDict.json'),
          to: path.resolve(__dirname, '.webpack/main/inference/pipeline/jpKanjiDict.json'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'assets/SXS.png'),
          to: path.resolve(__dirname, '.webpack/main/SXS.png'),
          noErrorOnMissing: true,
        },
        // Splash 位图 —— splash 窗口走的是 BaseWindow + ImageView（主进程内直接
        // 画 nativeImage，不经过渲染进程），所以既没有 webpack 入口，也没有
        // HTML：只需要把两张 PNG 放到主 bundle 同目录，splashManager 用
        // path.join(__dirname, 'splash@2x.png') 同步读取。
        //
        // 逐字拷贝：不经任何 loader/plugin 处理，像素与生成时完全一致。
        // packagerConfig.ignore 的白名单已包含 .webpack，所以打包后
        // app.asar/.webpack/main/splash@2x.png 存在，readFileSync 可直接读。
        //
        // noErrorOnMissing 是刻意的：两张 PNG 是**生成产物**（.gitignore 忽略），
        // 由 prestart / prepackage 的 scripts/generate-build-info.js →
        // generate-splash-image.js 生成。prepackage 阶段 verify-build-assets.js
        // 会校验生成器存在，缺失时阻断打包，所以这里静默跳过不会掩盖真实问题。
        {
          from: path.resolve(__dirname, 'src/splash@2x.png'),
          to: path.resolve(__dirname, '.webpack/main/splash@2x.png'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/splash@3x.png'),
          to: path.resolve(__dirname, '.webpack/main/splash@3x.png'),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'src/build-info.json'),
          to: path.resolve(__dirname, '.webpack/main/build-info.json'),
          noErrorOnMissing: true,
        },
      ],
    }),
  ],
};
