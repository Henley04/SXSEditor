// 扩散采样求解器接口与实现
//
// 本项目 Flow Matching 模型输出 flow_pred = v(x, t)（速度场），采样即求解 ODE:
//   dx/dt = v(x, t),  t 从 1（噪声）到 0（数据），但本项目实现为 t 从 0 到 1，
//   xt 沿速度场方向累积，等价于反向积分。
//
// 求解器只负责"何时调用 diffStep、怎么组合预测得到 xt 增量"，
// CFG / Rescale / 张量生命周期仍由调用方（pipeline/diffusion.js 与
// webnn/diffusion.js）管理，保证两路径共用同一份算法逻辑。
//
// 每个求解器实现 step()，返回本轮（可能多次 diffStep 调用）的 xt 增量。
// 调用方提供 evalDiffStep(t) -> Promise<{condPred, uncondPred}>（已处理 cond/uncond
// 两个分支的 diffStep 推理与张量释放，返回独立的 Float32Array 副本），
// 以及 cfgCombine(condPred, uncondPred) -> Float32Array（合并为 CFG 后的 v(x,t)）。

const EulerSolver = require('./euler');
const HeunSolver = require('./heun');
const StorkSolver = require('./stork');

// 求解器注册表：value -> {label, descKey, create(samplerArgs)}
const SOLVERS = {
    euler: {
        label: 'Euler',
        labelKey: 'main.exportDialog.samplerEuler',
        descKey: 'main.exportDialog.samplerEulerDesc',
        create: () => new EulerSolver(),
    },
    heun: {
        label: 'Heun',
        labelKey: 'main.exportDialog.samplerHeun',
        descKey: 'main.exportDialog.samplerHeunDesc',
        create: () => new HeunSolver(),
    },
    stork: {
        label: 'STORK-2',
        labelKey: 'main.exportDialog.samplerStork',
        descKey: 'main.exportDialog.samplerStorkDesc',
        create: () => new StorkSolver(2),
    },
};

const DEFAULT_SOLVER = 'euler';
const VALID_SOLVERS = Object.keys(SOLVERS);

/**
 * 求解器名称校验与归一化
 * @param {string} [name] - 求解器名称
 * @returns {string} 合法求解器名，非法或缺失时返回 DEFAULT_SOLVER
 */
function resolveSamplerName(name) {
    if (typeof name === 'string' && SOLVERS.hasOwnProperty(name)) return name;
    return DEFAULT_SOLVER;
}

/**
 * 实例化求解器
 * @param {string} [name] - 求解器名称
 * @returns {Object} 求解器实例，需实现 step() 接口
 */
function createSampler(name) {
    const resolved = resolveSamplerName(name);
    return SOLVERS[resolved].create();
}

module.exports = {
    EulerSolver,
    HeunSolver,
    StorkSolver,
    SOLVERS,
    DEFAULT_SOLVER,
    VALID_SOLVERS,
    resolveSamplerName,
    createSampler,
};
