// Euler 求解器（一阶显式，中点时间评估）
//
// 对应原 diffusion.js 的循环逻辑：
//   tVal = (step + 0.5) / totalSteps   （中点取值）
//   x_{n+1} = x_n + v(x_n, t_n) * dt
//
// 每步 1 次 diffStep 评估（CFG 时为 cond+uncond 两个分支，由调用方合并）。

/**
 * @typedef {Object} EvalResult
 * @property {Float32Array} condPred - cond 分支 flow_pred（target 段，长度 totalFrames*MEL_DIM）
 * @property {Float32Array|null} uncondPred - uncond 分支 flow_pred（CFG=0 时为 null）
 */

/**
 * @callback EvalDiffStep
 * @param {number} t - 评估时间点
 * @returns {Promise<EvalResult>}
 */

/**
 * @callback CombinePred
 * @param {Float32Array} condPred
 * @param {Float32Array|null} uncondPred
 * @returns {Float32Array} CFG 合并后的 v(x, t)
 */

class EulerSolver {
    /**
     * 执行单个求解器超步，返回 xt 增量（不原地修改 xt.data，由调用方累加）
     *
     * @param {Object} ctx
     * @param {EvalDiffStep} ctx.evalDiffStep - 评估 diffStep 的回调
     * @param {CombinePred} ctx.combine - CFG 合并回调
     * @param {number} ctx.step - 当前超步索引（0-based）
     * @param {number} ctx.totalSteps - 总超步数
     * @returns {Promise<{delta: Float32Array, nfe: number}>} xt 增量与本步 NFE
     */
    async step({ evalDiffStep, combine, step, totalSteps }) {
        const tVal = (step + 0.5) / totalSteps;
        const dt = 1.0 / totalSteps;
        const { condPred, uncondPred } = await evalDiffStep(tVal);
        const v = combine(condPred, uncondPred);
        // delta = v * dt
        const delta = new Float32Array(v.length);
        for (let i = 0; i < v.length; i++) delta[i] = v[i] * dt;
        return { delta, nfe: 1 };
    }
}

module.exports = EulerSolver;
