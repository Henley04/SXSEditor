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
            'src/inference/rosvotDetector.js',
            'src/audio/**/*.js',
            'src/utils/**/*.js',
            'src/shared/ipcChannels.js',
            'src/modelManager.js',
            'src/modelRegistry.js',
            'src/preload.js',
            'src/main.js',
            'test/**/*.js',
            'scripts/**/*.js',
            '*.config.js',
            'eslint.config.cjs',
        ],
        // 排除实际为 ESM 的文件（虽在 utils/audio 目录，但使用 export 语法）
        ignores: [
            'src/audio/wavEncoder.js',
            'src/utils/escapeHtml.js',
            'src/utils/gpuCache.js',
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
            },
        },
    },
    // 渲染进程 + 部分 ESM 工具：ESM + 浏览器 globals
    {
        files: [
            'src/renderer/**/*.js',
            'src/fragmentEditor/**/*.js',
            'src/audioPreprocess/**/*.js',
            'src/editor/**/*.js',
            'src/inference/webnn/**/*.js',
            'src/inference/shared/**/*.js',
            'src/themes/**/*.js',
            'src/i18n/**/*.js',
            'src/icons/**/*.js',
            'src/singerCreator.js',
            'src/settings.js',
            'src/modelDownload.js',
            'src/resourceManager.js',
            'src/alertDialog.js',
            'src/splash.js',
            'src/splashPreload.js',
            // 这些文件使用 ESM export 语法，但被主进程 require（webpack interop）
            'src/audio/wavEncoder.js',
            'src/utils/escapeHtml.js',
            'src/utils/gpuCache.js',
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
];
