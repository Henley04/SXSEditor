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
// 接口约定：
//   step({ evalDiffStep, combine, step, totalSteps, xtData, buffers }) → { nfe }
//   - evalDiffStep(t, xtOverride?) → Promise<{condPred, uncondPred}>
//   - combine(condPred, uncondPred) → Float32Array（写入 buffers.vBuf，返回 vBuf 引用）
//   - buffers: { vBuf, deltaBuf, v1Buf, xPredBuf }（调用方预分配，跨步复用）
//   - delta 写入 buffers.deltaBuf，调用方累加到 xt.data

const EulerSolver = require('./euler');
const HeunSolver = require('./heun');
const ExtrapSolver = require('./extrap');

// 求解器注册表：value -> {label, labelKey, descKey, create()}
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
    extrap: {
        label: 'Extrapolated Euler',
        labelKey: 'main.exportDialog.samplerExtrap',
        descKey: 'main.exportDialog.samplerExtrapDesc',
        create: () => new ExtrapSolver(2),
    },
};

const DEFAULT_SOLVER = 'euler';
const VALID_SOLVERS = Object.keys(SOLVERS);

// 旧名称兼容映射（用户已保存的 settings 可能含 'stork'）
const LEGACY_ALIASES = { stork: 'extrap' };

/**
 * 求解器名称校验与归一化
 * @param {string} [name] - 求解器名称
 * @returns {string} 合法求解器名，非法或缺失时返回 DEFAULT_SOLVER
 */
function resolveSamplerName(name) {
    if (typeof name === 'string') {
        if (SOLVERS.hasOwnProperty(name)) return name;
        if (LEGACY_ALIASES.hasOwnProperty(name)) return LEGACY_ALIASES[name];
    }
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
    ExtrapSolver,
    SOLVERS,
    DEFAULT_SOLVER,
    VALID_SOLVERS,
    LEGACY_ALIASES,
    resolveSamplerName,
    createSampler,
};
