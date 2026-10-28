/**
 * ESLint Flat Config（ESLint 9+）
 *
 * 项目混用 CommonJS（主进程 src/main、src/inference/pipeline）与
 * ESM（渲染进程 src/inference/webnn、src/renderer、src/fragmentEditor 等），
 * 通过多档配置区分两类环境的 globals 与 sourceType。
 *
 * 规则集：eslint:recommended（捕获未定义变量、未使用变量、空匹配等低级错误）
 * 不引入风格规则（如 indent / quotes），避免与现有代码风格冲突。
 */
const globals = require('globals');

module.exports = [
    {
        ignores: [
            'node_modules/**',
            // dynwinrt-codegen 生成的 WinRT 绑定代码 —— 自动生成，不参与 lint
            'src/inference/winml/winrt-bindings/**',
            '.webpack/**',
            '.webpack_cache/**',
            'out/**',
            'build/**',
            'onnx_models/**',
            'docs/preview/**',
            '**/*.onnx',
        ],
    },
    // 通用基础配置
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.es2022,
            },
        },
        rules: {
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-undef': 'error',
            'no-redeclare': 'error',
            'no-unreachable': 'warn',
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-console': 'off',
            // 风格类关闭以兼容现有代码
            'indent': 'off',
            'quotes': 'off',
            'semi': 'off',
            'comma-dangle': 'off',
            'eol-last': 'off',
            'no-trailing-spaces': 'off',
            'arrow-parens': 'off',
            'object-curly-spacing': 'off',
            'space-before-function-paren': 'off',
        },
    },
    // 主进程 / 测试 / 构建脚本：CommonJS
    {
        files: [
            'src/main/**/*.js',
            'src/inference/pipeline/**/*.js',
            'src/inference/basicPitch.js',
            'src/inference/midiParser.js',
            'src/inference/rmvpePitchDetector.js',
            // FCPE 与 RMVPE 同为 CJS 的 ONNX 检测器；此前漏在列表外，导致整个
            // 文件从未被 lint 覆盖（require/console 全被判 no-undef）。
            'src/inference/fcpePitchDetector.js',
            'src/inference/rosvotDetector.js',
            'src/inference/pitchWorker.js',
            'src/inference/svsWorker.js',
            'src/inference/pitchPostprocess.js',
            // ORT 惰性加载入口：主进程 CJS（新建文件必须显式登记，否则会落到
            // 未覆盖任何分档的默认档，require/module 全被判 no-undef）
            'src/inference/ortRuntime.js',
            // WinML 后端：主进程 CJS（此前漏在分档外，整个目录的 require/console
            // 全被判 no-undef，等于完全没有 lint 覆盖）
            'src/inference/winml/**/*.js',
            'src/audio/**/*.js',
            'src/utils/**/*.js',
            'src/shared/ipcChannels.js',
            'src/shared/mcpSchema.js',
            'src/shared/mcpModel.js',
            'src/shared/jpPhonemeMap.js',
            'src/shared/pluginPermissions.js',
            // 主进程与渲染进程共用的异常兜底工具（CJS，default import 给渲染侧）
            'src/shared/safeCall.js',
            // .sxssinger 解析（主进程用，纯函数便于单测）
            'src/shared/singerFileEdit.js',
            'src/modelManager.js',
            'src/modelRegistry.js',
            'src/preload.js',
            'src/main.js',
            'test/**/*.js',
            'scripts/**/*.js',
            'scripts/**/*.cjs',
            '*.config.js',
            'eslint.config.cjs',
        ],
        // 排除实际为 ESM 的文件（虽在 utils/audio 目录，但使用 export 语法）
        ignores: [
            'src/inference/winml/winrt-bindings/**/*.js',
            'src/audio/wavEncoder.js',
            'src/utils/escapeHtml.js',
            'src/inference/pipeline/qdrift/defaults.js',
        ],
        languageOptions: {
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.commonjs,
                ...globals.mocha,
                // 测试用 jsdom 模拟 DOM，需要浏览器全局变量
                ...globals.browser,
                // Float16Array 是较新提案，globals.browser 尚未收录
                Float16Array: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
                // Webpack/Forge 注入的全局（windowManager 等主进程模块引用入口点）
                __non_webpack_require__: 'readonly',
                MAIN_WINDOW_WEBPACK_ENTRY: 'readonly',
                MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                FRAGMENT_EDITOR_WINDOW_WEBPACK_ENTRY: 'readonly',
                FRAGMENT_EDITOR_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                SINGER_CREATOR_WINDOW_WEBPACK_ENTRY: 'readonly',
                SINGER_CREATOR_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                AUDIO_PREPROCESS_WINDOW_WEBPACK_ENTRY: 'readonly',
                AUDIO_PREPROCESS_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                SETTINGS_WINDOW_WEBPACK_ENTRY: 'readonly',
                SETTINGS_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                MODEL_DOWNLOAD_WINDOW_WEBPACK_ENTRY: 'readonly',
                MODEL_DOWNLOAD_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                RESOURCE_MANAGER_WINDOW_WEBPACK_ENTRY: 'readonly',
                RESOURCE_MANAGER_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                SPLASH_WINDOW_WEBPACK_ENTRY: 'readonly',
                SPLASH_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                UPDATE_NOTIFICATION_WINDOW_WEBPACK_ENTRY: 'readonly',
                UPDATE_NOTIFICATION_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                SINGER_MARKET_WINDOW_WEBPACK_ENTRY: 'readonly',
                SINGER_MARKET_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
            },
        },
    },
    // 渲染进程 + 部分 ESM 工具：ESM + 浏览器 globals
    {
        files: [
            'src/renderer/**/*.js',
            'src/fragmentEditor/**/*.js',
            // 仅渲染进程引用的共享模块（使用 window/document/ResizeObserver 等浏览器全局）
            'src/shared/autoRelayout.js',
            // 插件契约：ESM，被主进程 pluginHost 与渲染层共用（含 console.warn）
            'src/shared/pluginContract.js',
            // 流式调度器：ESM，被渲染层 bundle（watchdog 用 setTimeout/console）
            'src/shared/streamingScheduler.js',
            'src/audioPreprocess/**/*.js',
            'src/editor/**/*.js',
            'src/inference/webnn/**/*.js',
            'src/inference/shared/**/*.js',
            'src/themes/**/*.js',
            'src/i18n/**/*.js',
            'src/icons/**/*.js',
            'src/singerCreator.js',
            'src/singerMarket.js',
            'src/settings.js',
            'src/modelDownload.js',
            'src/resourceManager.js',
            'src/alertDialog.js',
            'src/updateNotification.js',
            // 这些文件使用 ESM export 语法，但被主进程 require（webpack interop）
            'src/audio/wavEncoder.js',
            'src/utils/escapeHtml.js',
            // Q-Drift 默认策略：ESM 纯函数，被主进程 CJS 与渲染层共用
            'src/inference/pipeline/qdrift/defaults.js',
            // 独立仿真/验证脚本（.mjs 是 ESM）。此前落在默认档，require/console
            // 全被判 no-undef，等于这些脚本从未被 lint 覆盖。
            'scripts/**/*.mjs',
        ],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
                // Electron renderer preload 环境允许的 CJS 全局（webpack interop）
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                __non_webpack_require__: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                setImmediate: 'readonly',
                clearImmediate: 'readonly',
                // Float16Array 是较新提案，globals.browser 尚未收录
                Float16Array: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
                // Webpack 注入的入口点全局变量
                MAIN_WINDOW_WEBPACK_ENTRY: 'readonly',
                MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                FRAGMENT_EDITOR_WINDOW_WEBPACK_ENTRY: 'readonly',
                FRAGMENT_EDITOR_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                SINGER_CREATOR_WINDOW_WEBPACK_ENTRY: 'readonly',
                SINGER_CREATOR_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                AUDIO_PREPROCESS_WINDOW_WEBPACK_ENTRY: 'readonly',
                AUDIO_PREPROCESS_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                SETTINGS_WINDOW_WEBPACK_ENTRY: 'readonly',
                SETTINGS_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                MODEL_DOWNLOAD_WINDOW_WEBPACK_ENTRY: 'readonly',
                MODEL_DOWNLOAD_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                RESOURCE_MANAGER_WINDOW_WEBPACK_ENTRY: 'readonly',
                RESOURCE_MANAGER_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                SPLASH_WINDOW_WEBPACK_ENTRY: 'readonly',
                SPLASH_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
            },
        },
    },
    // 用 ESM 写的新测试（其余 test/ 文件是 CJS，靠上面的 commonjs 档覆盖）。
    // babel/mocha 两种写法都支持，但 eslint 需要知道 sourceType。
    {
        files: ['test/naturalness.test.js', 'test/autoPitchNaturalness.test.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.mocha,
                ...globals.browser,
            },
        },
    },
];
