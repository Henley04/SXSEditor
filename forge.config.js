const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {

  packagerConfig: {
    asar: {
      unpack: '**/*.{node,dll}',
      unpackDir: 'onnx_models'
    },
    prune: true,
    ignore: (file) => {
      if (!file) return false;
      // 保留 .webpack、node_modules、onnx_models 目录
      const keep = file.startsWith('/.webpack') || 
                   file.startsWith('/node_modules') ||
                   file.startsWith('/onnx_models');
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
              js: './src/renderer.js',
              name: 'main_window',
              preload: {
                js: './src/preload.js',
              },
            },
            {
              html: './src/fragmentEditor.html',
              js: './src/fragmentEditor.js',
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
              js: './src/audioPreprocess.js',
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
