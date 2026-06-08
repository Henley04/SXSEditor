const rules = require('./webpack.rules');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
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
];

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

module.exports = {
  // Put your normal webpack config below here
  module: {
    rules,
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
