const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const skipOnnxModels = process.env.SKIP_ONNX_MODELS === '1';

module.exports = {

  packagerConfig: {
    asar: {
      unpack: '**/*.{node,dll}',
      ...(skipOnnxModels ? {} : { unpackDir: 'onnx_models' })
    },
    prune: true,
    ignore: (file) => {
      if (!file) return false;
      const keepList = ['/.webpack', '/node_modules'];
      if (!skipOnnxModels) {
        keepList.push('/onnx_models');
      }
      const keep = keepList.some(prefix => file.startsWith(prefix));
      return !keep;
    },
    icon: './assets/SXS',
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },//ignore webpack to pack native modules, and use CopyPlugin to copy them to the output directory. package.json:"main": "/src/main.js", to run with no webpack;.webpack/main to run with webpack
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              html: './src/index.html',
              js: './src/renderer/index.js',
              name: 'main_window',
              preload: {
                js: './src/preload.js',
              },
            },
            {
              html: './src/fragmentEditor.html',
              js: './src/fragmentEditor/index.js',
              name: 'fragment_editor_window',
              preload: {
                js: './src/preload.js',
              },
            },
            {
              html: './src/singerCreator.html',
              js: './src/singerCreator.js',
              name: 'singer_creator_window',
              preload: {
                js: './src/preload.js',
              },
            },
            {
              html: './src/audioPreprocess.html',
              js: './src/audioPreprocess/index.js',
              name: 'audio_preprocess_window',
              preload: {
                js: './src/preload.js',
              },
            },
            {
              html: './src/settings.html',
              js: './src/settings.js',
              name: 'settings_window',
              preload: {
                js: './src/preload.js',
              },
            },
            {
              html: './src/modelDownload.html',
              js: './src/modelDownload.js',
              name: 'model_download_window',
              preload: {
                js: './src/preload.js',
              },
            },
            {
              html: './src/resourceManager.html',
              js: './src/resourceManager.js',
              name: 'resource_manager_window',
              preload: {
                js: './src/preload.js',
              },
            },
          ],
        },
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
