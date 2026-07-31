// Midpoint 求解器（显式中点法 / RK2 midpoint，二阶显式）
//
// Flow Matching ODE: dx/dt = v(x, t)
// 显式中点法（RK2 midpoint）：
//   1. 预测: x_mid = x_n + 0.5 * v(x_n, t_n) * dt        （半步 Euler 预测）
//   2. 校正: x_{n+1} = x_n + v(x_mid, t_n + 0.5*dt) * dt  （用中点速度走全步）
//
// 与 Heun（trapezoidal RK2）同为二阶、2 NFE，但中点法对 flow matching 的
// 直线轨迹更贴合：rectified flow 的理想轨迹是直线，中点评估在 t+0.5*dt 处
// 取速度，对线性速度场精确，对轻微弯曲轨迹的截断误差系数优于 trapezoidal。
//
// 适用性：与 Euler/Heun 一样是通用 RK 法，对 flow matching 适用（不依赖 DM ODE
// 半线性结构）。保留作为可选采样器；默认仍是 STORK-2（1 NFE 二阶）。
//
// 每步 2 次 diffStep 评估。末步退化为 Euler（避免 t+0.5*dt 在边界外评估，
// 虽然 t+0.5*dt < t+dt <= 1 严格成立，仍保留末步退化与 Heun 行为一致，
// 减少最后一步的额外评估开销）。
//
// 性能：combine 写入 vBuf（复用），v1 保存到 v1Buf（复用），预测状态写入
// xPredBuf（复用），delta 写入 deltaBuf（复用）。每步 0 次堆分配。

class MidpointSolver {
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

        // 1. v1 = v(x_n, t_n) → combine 写入 vBuf
        const { condPred: cond1, uncondPred: uncond1 } = await evalDiffStep(tN);
        const v1 = combine(cond1, uncond1); // v1 指向 buffers.vBuf

        // 末步退化为 Euler（与 Heun 行为一致，减少最后一步评估）
        if (step >= totalSteps - 1) {
            const delta = buffers.deltaBuf;
            for (let i = 0; i < v1.length; i++) delta[i] = v1[i] * dt;
            return { nfe: 1 };
        }

        // 保存 v1 到 v1Buf（vBuf 将被第二次 combine 覆盖）
        const v1Buf = buffers.v1Buf;
        v1Buf.set(v1);

        // 构造中点状态 x_mid = x_n + 0.5 * v1 * dt → 写入 xPredBuf（复用）
        const xMid = buffers.xPredBuf;
        for (let i = 0; i < xtData.length; i++) xMid[i] = xtData[i] + 0.5 * v1[i] * dt;

        // 2. v_mid = v(x_mid, t_n + 0.5*dt) → combine 写入 vBuf（v1 已保存）
        const tMid = tN + 0.5 * dt;
        const { condPred: cond2, uncondPred: uncond2 } = await evalDiffStep(tMid, xMid);
        const vMid = combine(cond2, uncond2); // vMid 指向 buffers.vBuf

        // 3. delta = v_mid * dt → 写入 deltaBuf（中点速度走全步）
        const delta = buffers.deltaBuf;
        for (let i = 0; i < vMid.length; i++) delta[i] = vMid[i] * dt;
        return { nfe: 2 };
    }
}

module.exports = MidpointSolver;
