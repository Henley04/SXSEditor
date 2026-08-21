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
    quiet: false,
    ignore: (file) => {
      if (!file) return false;
      // Normalize: strip leading slash/backslash, convert backslashes to forward slashes.
      // electron-packager passes paths without leading slashes (e.g. '.webpack/main/index.js'),
      // but be defensive and handle both formats.
      const normalized = file.replace(/^[\\/]+/, '').replace(/\\/g, '/');
      const keepList = ['.webpack', 'node_modules'];
      if (!skipOnnxModels) {
        keepList.push('onnx_models');
      }
      const keep = keepList.some(prefix =>
        normalized === prefix || normalized.startsWith(prefix + '/')
      );
      return !keep;
    },
    icon: './assets/SXS',
    // Keep only Chromium locales that match the app's supported UI languages
    // (src/i18n ships 'zh-CN' and 'en'). All other *.pak locale files would
    // otherwise account for ~45 MB of dead bytes in out/SXSEditor-win32-x64/locales.
    // Electron falls back to en-US.pak if the OS locale is missing, so keeping
    // zh-CN + en-US (+ their regional variants) is sufficient.
    // Note: electron-packager's `locales` option is not honored by every
    // @electron-forge/plugin-webpack version, so we additionally prune the
    // leftovers via `afterExtract` below.
    locales: ['zh-CN', 'zh-TW', 'en-US', 'en-GB'],
    // Prune Chromium locale .pak files that the app does not ship translations
    // for (src/i18n only carries 'zh-CN' and 'en'). Each .pak is ~0.8-1 MB and
    // there are 50+ of them, so this saves ~40 MB.
    afterExtract: [
      (buildPath, electronVersion, platform, arch, callback) => {
        try {
          const fs = require('node:fs');
          const path = require('node:path');
          const keep = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
          const localesDir = path.join(buildPath, 'locales');
          if (fs.existsSync(localesDir)) {
            for (const file of fs.readdirSync(localesDir)) {
              if (file.endsWith('.pak') && !keep.has(file)) {
                fs.unlinkSync(path.join(localesDir, file));
              }
            }
          }
          callback();
        } catch (err) {
          callback(err);
        }
      },
    ],
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
              html: './src/singerMarket.html',
              js: './src/singerMarket.js',
              name: 'singer_market_window',
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
            {
              html: './src/splash.html',
              js: './src/splash.js',
              name: 'splash_window',
              preload: {
                js: './src/splashPreload.js',
              },
            },
            {
              html: './src/updateNotification.html',
              js: './src/updateNotification.js',
              name: 'update_notification_window',
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
