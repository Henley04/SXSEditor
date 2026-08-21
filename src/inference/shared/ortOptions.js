/**
 * ONNX Runtime session options 构造器（主进程 CommonJS 版本）
 *
 * 读取用户在设置界面配置的 ORT 选项，与调用方提供的基础选项合并，
 * 返回最终用于 `ort.InferenceSession.create(modelPath, options)` 的对象。
 *
 * 默认值遵循以下策略（依据 project_memory.md 的经验）：
 *  - DML 执行提供者路径：`enableMemPattern` 默认 false。
 *    原因：DML EP + memory pattern 会导致 DirectML 过度预分配 GPU 内存池，
 *    可能引发 OOM 或 TDR。用户可在设置中显式开启（高风险）。
 *  - CPU / WASM 路径：`enableMemPattern` 默认 true（ORT 官方默认值）。
 *  - `enableCpuMemArena`、`graphOptimizationLevel`、`executionMode` 默认沿用 ORT 官方推荐。
 *  - `intraOpNumThreads` / `interOpNumThreads` / `logSeverityLevel` 默认不设置（undefined），
 *    让 ORT 自动选择；用户显式配置后才会传入。
 *
 * 调用约定：
 *   const opts = buildSessionOptions({ executionProviders: [dmlOpts, 'cpu'] });
 *   const session = await ort.InferenceSession.create(modelPath, opts);
 *
 * 调用方显式传入的字段（如 `graphOptimizationLevel: 'basic'`）会被保留，不会被设置覆盖。
 */

'use strict';

// 延迟加载 settings，避免在 onnxruntime-node 模块初始化阶段触发循环依赖
function _getSettings() {
    try {
        const { loadSettings } = require('../../main/settings');
        return loadSettings();
    } catch (_err) {
        // settings 模块不可用时退化为空对象，让所有选项走 ORT 默认值
        return {};
    }
}

const LOG_SEVERITY_MAP = {
    verbose: 0,
    info: 1,
    warning: 2,
    error: 3,
    fatal: 4,
};

const GRAPH_OPT_LEVELS = ['disabled', 'basic', 'extended', 'all'];

/**
 * 判断 executionProviders 数组中是否包含 DML
 * @param {Array|string|undefined} executionProviders
 * @returns {boolean}
 */
function _usesDml(executionProviders) {
    if (!Array.isArray(executionProviders)) return false;
    return executionProviders.some(ep => {
        if (typeof ep === 'string') return ep === 'dml';
        return ep && ep.name === 'dml';
    });
}

/**
 * 构造 ORT session options。
 *
 * @param {object} [baseOptions] - 调用方提供的基础选项（executionProviders、executionMode 等）
 *   - 显式提供的字段会被保留，不会被用户设置覆盖
 * @param {object} [overrides] - 最后应用的覆盖项（最高优先级）
 * @returns {object} 最终的 session options
 */
function buildSessionOptions(baseOptions = {}, overrides = {}) {
    const settings = _getSettings();
    const opts = { ...baseOptions };

    // executionProviders 在 baseOptions 中传入；这里仅用于推断 DML 路径
    const isDml = _usesDml(opts.executionProviders);

    // 1. enableMemPattern
    //    调用方未显式设置时：DML 路径默认 false（除非用户在设置中开启 ortForceMemPatternOnDml=true），
    //    非 DML 路径默认 true（除非用户在设置中关闭 ortEnableMemPattern=false）
    if (opts.enableMemPattern === undefined) {
        const userEnable = settings.ortEnableMemPattern !== false; // 默认 true
        if (isDml) {
            opts.enableMemPattern = userEnable && settings.ortForceMemPatternOnDml === true;
        } else {
            opts.enableMemPattern = userEnable;
        }
    }

    // 2. enableCpuMemArena
    if (opts.enableCpuMemArena === undefined) {
        opts.enableCpuMemArena = settings.ortEnableCpuMemArena !== false; // 默认 true
    }

    // 3. graphOptimizationLevel
    if (opts.graphOptimizationLevel === undefined) {
        const lvl = settings.ortGraphOptLevel;
        if (GRAPH_OPT_LEVELS.includes(lvl)) {
            opts.graphOptimizationLevel = lvl;
        } else {
            opts.graphOptimizationLevel = 'all'; // ORT 官方默认
        }
    }

    // 4. executionMode
    if (opts.executionMode === undefined) {
        const m = settings.ortExecutionMode;
        opts.executionMode = (m === 'parallel') ? 'parallel' : 'sequential';
    }

    // 5. intraOpNumThreads（仅在用户显式设置 >0 时生效）
    if (opts.intraOpNumThreads === undefined) {
        const n = parseInt(settings.ortIntraOpNumThreads);
        if (Number.isFinite(n) && n > 0) opts.intraOpNumThreads = n;
    }

    // 6. interOpNumThreads（仅在用户显式设置 >0 时生效）
    if (opts.interOpNumThreads === undefined) {
        const n = parseInt(settings.ortInterOpNumThreads);
        if (Number.isFinite(n) && n > 0) opts.interOpNumThreads = n;
    }

    // 7. logSeverityLevel（仅在用户显式设置非 warning 时生效；
    //    默认 warning 由 modelLoader.js 顶部的 ort.env.logLevel='verbose' 全局设置，
    //    session 级别不覆盖，避免与全局冲突）
    if (opts.logSeverityLevel === undefined) {
        const lvl = settings.ortLogSeverityLevel;
        if (lvl && LOG_SEVERITY_MAP[lvl] !== undefined && lvl !== 'warning') {
            opts.logSeverityLevel = LOG_SEVERITY_MAP[lvl];
        }
    }

    // 应用最高优先级覆盖
    return { ...opts, ...overrides };
}

module.exports = {
    buildSessionOptions,
    LOG_SEVERITY_MAP,
    GRAPH_OPT_LEVELS,
};
