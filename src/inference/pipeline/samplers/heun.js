// Heun 求解器（改进欧拉，二阶显式）
//
// Flow Matching ODE: dx/dt = v(x, t)
// Heun 法（RK2 midpoint / trapezoidal 形式）：
//   1. 预测: x_pred = x_n + v(x_n, t_n) * dt          （Euler 预测子）
//   2. 校正: x_{n+1} = x_n + 0.5 * (v(x_n, t_n) + v(x_pred, t_{n+1})) * dt
//
// 每步 2 次 diffStep 评估。注意预测子使用 t_n（中点），校正子使用 t_{n+1}（下一步中点），
// 与本项目 Euler 的中点时间格式 (step+0.5)/totalSteps 保持一致。
//
// 注意：v(x_pred, t_{n+1}) 中的 x_pred 是 x_n + v*dt 后的预测状态，调用方需在 evalDiffStep
// 内部把 x_pred 注入到 xt 输入缓冲区（cond 分支拼接 prompt+target，uncond 分支仅 target）。
// 调用方通过 setXtState(xtData) 回调在每次 evalDiffStep 前更新 xt 输入。

/**
 * @typedef {Object} EvalResult
 * @property {Float32Array} condPred - cond 分支 flow_pred（target 段）
 * @property {Float32Array|null} uncondPred - uncond 分支 flow_pred
 */

/**
 * @callback EvalDiffStep
 * @param {number} t
 * @param {Float32Array} [xtOverride] - 可选的 xt 状态覆盖（用于预测子步骤）
 * @returns {Promise<EvalResult>}
 */

/**
 * @callback CombinePred
 * @param {Float32Array} condPred
 * @param {Float32Array|null} uncondPred
 * @returns {Float32Array} CFG 合并后的 v(x, t)
 */

class HeunSolver {
    /**
     * @param {Object} ctx
     * @param {EvalDiffStep} ctx.evalDiffStep
     * @param {CombinePred} ctx.combine
     * @param {number} ctx.step
     * @param {number} ctx.totalSteps
     * @param {Float32Array} ctx.xtData - 当前 xt 状态（target 段，长度 totalFrames*MEL_DIM）
     * @returns {Promise<{delta: Float32Array, nfe: number}>}
     */
    async step({ evalDiffStep, combine, step, totalSteps, xtData }) {
        const tN = (step + 0.5) / totalSteps;
        const dt = 1.0 / totalSteps;

        // 1. 预测子: v1 = v(x_n, t_n)
        const { condPred: cond1, uncondPred: uncond1 } = await evalDiffStep(tN);
        const v1 = combine(cond1, uncond1);

        // 末步处理：tNext = (step+1.5)/totalSteps 在最后一步会 > 1.0，超出模型 t∈[0,1] 范围。
        // 退化为 Euler（仅用 v1），避免模型外推产生错误。
        if (step >= totalSteps - 1) {
            const delta = new Float32Array(v1.length);
            for (let i = 0; i < v1.length; i++) delta[i] = v1[i] * dt;
            return { delta, nfe: 1 };
        }

        const tNext = (step + 1.5) / totalSteps;

        // 构造预测状态 x_pred = x_n + v1 * dt（target 段）
        const xPred = new Float32Array(xtData.length);
        for (let i = 0; i < xtData.length; i++) xPred[i] = xtData[i] + v1[i] * dt;

        // 2. 校正子: v2 = v(x_pred, t_{n+1})
        const { condPred: cond2, uncondPred: uncond2 } = await evalDiffStep(tNext, xPred);
        const v2 = combine(cond2, uncond2);

        // 3. 合并: delta = 0.5 * (v1 + v2) * dt
        const delta = new Float32Array(v1.length);
        for (let i = 0; i < v1.length; i++) delta[i] = 0.5 * (v1[i] + v2[i]) * dt;
        return { delta, nfe: 2 };
    }
}

module.exports = HeunSolver;
