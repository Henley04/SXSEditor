const CopyPlugin = require('copy-webpack-plugin');
const path = require('node:path');

module.exports = {
  entry: './src/main.js',
  module: {
    rules: require('./webpack.rules'),
  },
  externals: {
    'onnxruntime-node': 'commonjs onnxruntime-node',
    '@tensorflow/tfjs-backend-wasm': 'commonjs @tensorflow/tfjs-backend-wasm',
    'systeminformation': 'commonjs systeminformation',
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
          from: path.resolve(__dirname, 'native/build/Release/executorch_runtime.node'),
          to: path.resolve(__dirname, '.webpack/main/native/executorch_runtime.node'),
          noErrorOnMissing: true,
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
