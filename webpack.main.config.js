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
  externals: {
    'onnxruntime-node': 'commonjs onnxruntime-node',
    '@tensorflow/tfjs-backend-wasm': 'commonjs @tensorflow/tfjs-backend-wasm',
    'systeminformation': 'commonjs systeminformation',
    // Native-backed modules must stay outside the bundle so their .node
    // binaries load from node_modules (kept + asar-unpacked by forge).
    'sxs-ort-bridge': 'commonjs sxs-ort-bridge',
    '@microsoft/dynwinrt': 'commonjs @microsoft/dynwinrt',
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'src/inference/phone_set.json'),
          to: path.resolve(__dirname, '.webpack/main/phone_set.json'),
        },
        {
          from: path.resolve(__dirname, 'src/inference/en_g2p_dict.json'),
          to: path.resolve(__dirname, '.webpack/main/en_g2p_dict.json'),
        },
        {
          from: path.resolve(__dirname, 'src/inference/en_phoneme_durations.json'),
          to: path.resolve(__dirname, '.webpack/main/en_phoneme_durations.json'),
        },
        {
          from: path.resolve(__dirname, 'src/inference/pipeline/jpKanjiDict.json'),
          to: path.resolve(__dirname, '.webpack/main/jpKanjiDict.json'),
        },
        {
          from: path.resolve(__dirname, 'src/audio/audioWorker.js'),
          to: path.resolve(__dirname, '.webpack/main/audio/audioWorker.js'),
        },
        {
          from: path.resolve(__dirname, 'src/audio/audioFormatUtils.js'),
          to: path.resolve(__dirname, '.webpack/main/audio/audioFormatUtils.js'),
        },
        {
          from: path.resolve(__dirname, 'src/utils/gpuWorker.js'),
          to: path.resolve(__dirname, '.webpack/main/utils/gpuWorker.js'),
        },
        {
          from: path.resolve(__dirname, 'src/utils/deviceClassifier.js'),
          to: path.resolve(__dirname, '.webpack/main/utils/deviceClassifier.js'),
        },
        {
          from: path.resolve(__dirname, 'src/main'),
          to: path.resolve(__dirname, '.webpack/main/main'),
        },
        {
          from: path.resolve(__dirname, 'src/utils'),
          to: path.resolve(__dirname, '.webpack/main/utils'),
          globOptions: { ignore: ['**/gpuWorker.js', '**/deviceClassifier.js'] },
        },
        {
          from: path.resolve(__dirname, 'src/inference'),
          to: path.resolve(__dirname, '.webpack/main/inference'),
          globOptions: {
            ignore: ['**/pitchWorker.js', '**/svsWorker.js', '**/rmvpePitchDetector.js', '**/pipeline/float16Patch.js', '**/pipeline/jpKanjiDict.json'],
          },
        },
        {
          from: path.resolve(__dirname, 'src/inference/svsWorker.js'),
          to: path.resolve(__dirname, '.webpack/main/inference/svsWorker.js'),
        },
        {
          from: path.resolve(__dirname, 'src/inference/pitchWorker.js'),
          to: path.resolve(__dirname, '.webpack/main/inference/pitchWorker.js'),
        },
        {
          from: path.resolve(__dirname, 'src/inference/rmvpePitchDetector.js'),
          to: path.resolve(__dirname, '.webpack/main/inference/rmvpePitchDetector.js'),
        },
        {
          from: path.resolve(__dirname, 'src/utils/resampleAudio.js'),
          to: path.resolve(__dirname, '.webpack/main/utils/resampleAudio.js'),
        },
        {
          from: path.resolve(__dirname, 'src/inference/pipeline/float16Patch.js'),
          to: path.resolve(__dirname, '.webpack/main/inference/pipeline/float16Patch.js'),
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
        },
        {
          from: path.resolve(__dirname, 'assets/SXS.png'),
          to: path.resolve(__dirname, '.webpack/main/SXS.png'),
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
