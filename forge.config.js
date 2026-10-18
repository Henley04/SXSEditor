const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const skipOnnxModels = process.env.SKIP_ONNX_MODELS === '1';
// docs/ 随应用分发（约 5.6 MB）。设置 SKIP_DOCS=1 可跳过，此时帮助菜单的
// 文档入口会自动回退到线上文档站。
const skipDocs = process.env.SKIP_DOCS === '1';

// ---------------------------------------------------------------------------
// 打包期死重裁剪（P0）
//
// electron-packager 默认把 node_modules 整棵依赖树塞进 app.asar，而其中很大一部分
// 在本应用里永远不会被加载。这里在 ignore 白名单之上加一层黑名单，只砍"确定用不到"
// 的东西，不碰任何运行时依赖。
//
// 实测依据（onnxruntime-node@1.27.0 / onnxruntime-web@1.27.0，均在本机 node_modules
// 里量过，而非估算）：
//   · onnxruntime-node 解压 259 MB，其中 darwin 75 MB + linux 57 MB +
//     win32/arm64 67 MB 全是死重 —— Inno 的 ArchitecturesAllowed=x64compatible
//     决定只发 x64，Windows-on-Arm 走 x64 模拟并加载 x64 DLL。
//   · onnxruntime-web 解压 133 MB：渲染层只通过 <script src> 加载 UMD 的
//     ort.all.min.js（见 src/inference/webnn/ortSetup.js），全仓没有任何
//     require('onnxruntime-web')，也不在 webpack externals 里
//     （见 webpack.main.config.js），运行时文件由 CopyPlugin 拷进 .webpack。
//   · @types/* 是纯类型声明，运行时不需要。
//   · node_modules/.cache/ 是 @babel/register 的**开发期**转译缓存
//     （package.json 里 @babel/register 是 devDependency，全仓 src/ 零引用，
//     运行期没有任何代码读它）。实测该目录在本机 node_modules 下有 64 MB，
//     其中 @babel/register/.babel.*.development.json 单文件 54.3 MB。
//   · *.map 源映射：生产构建 devtool:false（见 webpack.*.config.js），
//    残留的 .map 全部来自 node_modules 里的第三方包，运行时不用。
//
// 重要：这些排除只在 **Windows 发行** 上生效。仓库仍保留 maker-zip(deb/rpm/darwin)
// 作为"源码构建"目标（README 明确标注 macOS/Linux 为 source-build / CPU-only），
// 对那些目标 onnxruntime-node 的 darwin / linux 二进制恰恰是**必需**的。
// 因此这里按 process.platform 分支，而不是无条件砍掉。
//
// ⚠️ 启动性能：asar 体积直接决定冷启动成本 —— Electron 每次启动都要
// 读取并 JSON.parse 整个 asar header（本包header 1.12 MB / 4292 条），
// 而 Windows Defender 实时保护还要扫描这些字节。裁掉 ~118 MB 死重
// 既减小安装体积，也缩短冷启动 I/O 与杀软扫描时间。
// ---------------------------------------------------------------------------
const isWindowsTarget = process.platform === 'win32';

// 仅在 Windows 目标上生效的死重前缀。
const WINDOWS_DEAD_WEIGHT_PREFIXES = [
  // onnxruntime-node：非 win32-x64 的 ORT 运行时。
  'node_modules/onnxruntime-node/bin/napi-v6/darwin/',
  'node_modules/onnxruntime-node/bin/napi-v6/linux/',
  'node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/',
  // onnxruntime-web 整包：运行时只用到 CopyPlugin 拷进 .webpack 的那几个文件。
  'node_modules/onnxruntime-web/',
  // 纯类型声明。
  'node_modules/@types/',
  // 开发期转译缓存（@babel/register 等），运行期零引用。约 64 MB。
  'node_modules/.cache/',
];

// 死重后缀（按整条路径判定，与目录前缀无关）。
const WINDOWS_DEAD_WEIGHT_SUFFIXES = [
  // 第三方包自带的 source map。生产构建 devtool:false，自有 bundle 不带
  // .map；残留的 143 个 .map（约 47.8 MB）全部来自 node_modules。
  '.map',
];

/**
 * 命中上述前缀或后缀即视为死重。
 * @param {string} normalized 前导斜杠已剥离、反斜杠已转正斜杠的相对路径
 * @returns {boolean}
 */
function isDeadWeight(normalized) {
  if (!isWindowsTarget) return false;
  if (WINDOWS_DEAD_WEIGHT_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return true;
  }
  // 只砍 node_modules 下的 .map：.webpack/ 是我们自己产出的，构建配置
  // （devtool）已经管过，不在这里重复干预。
  return normalized.startsWith('node_modules/')
    && WINDOWS_DEAD_WEIGHT_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

module.exports = {

  packagerConfig: {
    asar: {
      // 审查项 §5：原来只 unpack .node/.dll，漏掉了 wasm。
      // onnxruntime-web（ort-wasm-simd-threaded*.wasm）与 tfjs-backend-wasm
      // （tfjs-backend-wasm-threaded-simd.wasm）都是**二进制**而不是文本：
      // 塞进 asar 后由 file:// 加载时会被当成待解压文本，轻则解码失败、
      // 重则整个 WebNN/CPU 推理后端起不来。与 .node/.dll 同等对待即可。
      unpack: '**/*.{node,dll,wasm}',
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
      // 黑名单优先：确认是死重就不再进入白名单判定。
      if (isDeadWeight(normalized)) return true;
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
    // Ship the documentation site (docs/) next to the app (resources/docs).
    // It must live OUTSIDE app.asar: the docs are opened with the system
    // default browser via file:// and a browser cannot read inside an asar.
    // src/main/docs.js resolves this directory at runtime.
    ...(skipDocs ? {} : { extraResource: ['docs'] }),
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
    // NOTE: only the Windows (squirrel) path is exercised by CI
    // (.github/workflows/ci.yml runs on windows-latest only) and shipped as an
    // installer. The darwin/deb/rpm makers below are untested convenience
    // targets: macOS/Linux builds are source-build, CPU-only and unverified.
    // Keep this in sync with the platform claim in README.md / docs/index.html.
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
          // ⚠️ 这里**故意没有** splash_window 入口。
          //
          // 启动画面要求首帧零JS：无 preload、无 renderer bundle，整个载荷是
          // 一段内联 SVG + 构建期替换好的版本号/日期/图标。这样可以把 before-
          // first-paint 路径上的 preload 编译+执行（实测约 100ms 的渲染进程
          // 启动开销）整段去掉。
          //
          // 但 @electron-forge/plugin-webpack 无法表达"有 HTML 入口、没有 JS
          // 入口"：WebpackConfig.js:230 无条件执行
          // `entry[name] = (prefixedEntries||[]).concat([entryPoint.js])`，
          // 缺 js 会得到 `entry.splash_window = [undefined]`，webpack schema
          // 校验直接报 "should be a non-empty string"，整个 dev server 起不来
          // （渲染入口数组在这里是整体校验的，坏一个全盘失败）。
          //
          // 所以 splash 走**旁路**：webpack.main.config.js 的 CopyPlugin 把
          // 生成产物 src/splash.html 拷到 .webpack/main/splash.html，
          // splashManager 用 loadFile() 直接加载。见 src/main/splashManager.js
          // 顶部说明。
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
