// Euler 求解器（一阶显式，中点时间评估）
//
// 对应原 diffusion.js 的循环逻辑：
//   tVal = (step + 0.5) / totalSteps   （中点取值）
//   x_{n+1} = x_n + v(x_n, t_n) * dt
//
// 每步 1 次 diffStep 评估（CFG 时为 cond+uncond 两个分支，由调用方合并）。
//
// 性能：combine 写入调用方提供的 vBuf（复用），delta 写入 deltaBuf（复用），
// 每步 0 次堆分配。

/**
 * @typedef {Object} SamplerBuffers
 * @property {Float32Array} vBuf - combine 输出缓冲（长度 totalFrames*MEL_DIM）
 * @property {Float32Array} deltaBuf - delta 输出缓冲（长度 totalFrames*MEL_DIM）
 * @property {Float32Array} v1Buf - Heun 保存 v1 用（Euler/Extrap 不使用）
 * @property {Float32Array} xPredBuf - Heun 预测状态用（Euler/Extrap 不使用）
 */

class EulerSolver {
    /**
     * 执行单个求解器超步，delta 写入 buffers.deltaBuf（不分配新数组）。
     *
     * @param {Object} ctx
     * @param {Function} ctx.evalDiffStep - 评估 diffStep 的回调
     * @param {Function} ctx.combine - CFG 合并回调（写入 ctx.buffers.vBuf）
     * @param {number} ctx.step - 当前超步索引（0-based）
     * @param {number} ctx.totalSteps - 总超步数
     * @param {SamplerBuffers} ctx.buffers - 复用缓冲区
     * @returns {Promise<{nfe: number}>} 本步 NFE
     */
    async step({ evalDiffStep, combine, step, totalSteps, buffers }) {
        const tVal = (step + 0.5) / totalSteps;
        const dt = 1.0 / totalSteps;
        const { condPred, uncondPred } = await evalDiffStep(tVal);
        const v = combine(condPred, uncondPred); // 写入 buffers.vBuf
        // delta = v * dt → 写入 deltaBuf
        const delta = buffers.deltaBuf;
        for (let i = 0; i < v.length; i++) delta[i] = v[i] * dt;
        return { nfe: 1 };
    }
}

module.exports = EulerSolver;
