// Heun 求解器（改进欧拉，二阶显式）
//
// Flow Matching ODE: dx/dt = v(x, t)
// Heun 法（RK2 trapezoidal）：
//   1. 预测: x_pred = x_n + v(x_n, t_n) * dt          （Euler 预测子）
//   2. 校正: x_{n+1} = x_n + 0.5 * (v(x_n, t_n) + v(x_pred, t_{n+1})) * dt
//
// 每步 2 次 diffStep 评估。末步退化为 Euler（避免 tNext > 1 超出模型 t∈[0,1]）。
//
// 性能：combine 写入 vBuf（复用），v1 保存到 v1Buf（复用），预测状态写入
// xPredBuf（复用），delta 写入 deltaBuf（复用）。每步 0 次堆分配。

class HeunSolver {
    /**
     * @param {Object} ctx
     * @param {Function} ctx.evalDiffStep
     * @param {Function} ctx.combine - 写入 ctx.buffers.vBuf
     * @param {number} ctx.step
     * @param {number} ctx.totalSteps
     * @param {Float32Array} ctx.xtData - 当前 xt 状态（target 段）
     * @param {Object} ctx.buffers - { vBuf, deltaBuf, v1Buf, xPredBuf }
     * @returns {Promise<{nfe: number}>}
     */
    async step({ evalDiffStep, combine, step, totalSteps, xtData, buffers }) {
        const tN = (step + 0.5) / totalSteps;
        const dt = 1.0 / totalSteps;

        // 1. 预测子: v1 = v(x_n, t_n) → combine 写入 vBuf
        const { condPred: cond1, uncondPred: uncond1 } = await evalDiffStep(tN);
        const v1 = combine(cond1, uncond1); // v1 指向 buffers.vBuf

        // 末步处理：tNext = (step+1.5)/totalSteps > 1.0，退化为 Euler
        if (step >= totalSteps - 1) {
            const delta = buffers.deltaBuf;
            for (let i = 0; i < v1.length; i++) delta[i] = v1[i] * dt;
            return { nfe: 1 };
        }

        // 保存 v1 到 v1Buf（vBuf 将被第二次 combine 覆盖）
        const v1Buf = buffers.v1Buf;
        v1Buf.set(v1);

        const tNext = (step + 1.5) / totalSteps;

        // 构造预测状态 x_pred = x_n + v1 * dt → 写入 xPredBuf（复用）
        const xPred = buffers.xPredBuf;
        for (let i = 0; i < xtData.length; i++) xPred[i] = xtData[i] + v1[i] * dt;

        // 2. 校正子: v2 = v(x_pred, t_{n+1}) → combine 写入 vBuf（v1 已保存）
        const { condPred: cond2, uncondPred: uncond2 } = await evalDiffStep(tNext, xPred);
        const v2 = combine(cond2, uncond2); // v2 指向 buffers.vBuf

        // 3. delta = 0.5 * (v1 + v2) * dt → 写入 deltaBuf
        const delta = buffers.deltaBuf;
        for (let i = 0; i < v1Buf.length; i++) delta[i] = 0.5 * (v1Buf[i] + v2[i]) * dt;
        return { nfe: 2 };
    }
}

module.exports = HeunSolver;
