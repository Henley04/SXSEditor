// Extrapolated Euler 求解器（速度场外推法）
//
// 设计灵感来自 STORK (ICLR 2026 Poster, arXiv:2505.24210) 的"跨步速度复用"
// 思想，但这是一个简化版本，并非论文的完整 stabilized Runge-Kutta 多 stage
// 格式。论文 STORK-k 使用 Chebyshev 正交多项式构造 k 个 stage 实现高阶收敛，
// 而本实现仅用上一步速度做线性外推，是一个 1 NFE/step 的启发式方法。
//
// 算法：
//   1. v1 = v(x_n, t_n)                               （1 次 diffStep）
//   2. 若有 v_prev：v2 ≈ v1 + γ*(v1 - v_prev)        （线性外推，0 NFE）
//      若无 v_prev（首步）：v2 = v1                    （退化为 Euler）
//   3. delta = 0.5 * dt * (v1 + v2)
//
// γ=0.5 时，v2 = v1 + 0.5*(v1 - v_prev) 是对速度场时间变化的一阶差分近似。
// 当速度场缓变时 v2 ≈ v1，退化为 Euler；当速度场快变时外推提供额外的校正项。
// 注意：该外推不保证严格的二阶精度（中心差分需要 v_{n-1} 与 v_{n+1} 对称），
// 仅在速度场时间相关性较强时提供改善。
//
// 数值稳定性：
//   - 速度突变检测：|v1 - v_prev| / (|v1|+eps) > 2 时外推不可靠，退化为 Euler
//   - 外推幅度检测：|v2| / (|v1|+eps) > 3 或 v2 与 v1 反号且 |v2| > |v1| 时退化
//   - NaN/Inf 检测：v2 含非有限值时退化
//
// 性能：combine 写入 vBuf（复用），delta 写入 deltaBuf（复用）。
// 跨步状态：_vPrev 跨步复用，分块推理时每 chunk 新建实例（边界退化为 Euler）。

class ExtrapSolver {
    /**
     * @param {number} [order=2] - 保留参数兼容性，当前仅支持 2
     */
    constructor(order = 2) {
        if (order !== 2) {
            console.warn(`[ExtrapSolver] order=${order} not supported, fallback to order=2`);
            order = 2;
        }
        this.order = order;
        this._vPrev = null;
        // 外推系数 γ ∈ [0, 1]：控制 v_prev 差分权重
        this._gamma = 0.5;
    }

    /**
     * @param {Object} ctx
     * @param {Function} ctx.evalDiffStep
     * @param {Function} ctx.combine - 写入 ctx.buffers.vBuf
     * @param {number} ctx.step
     * @param {number} ctx.totalSteps
     * @param {Object} ctx.buffers - { vBuf, deltaBuf }
     * @returns {Promise<{nfe: number}>}
     */
    async step({ evalDiffStep, combine, step, totalSteps, buffers }) {
        const tVal = (step + 0.5) / totalSteps;
        const dt = 1.0 / totalSteps;

        // 1. 唯一一次 diffStep 评估 → combine 写入 vBuf
        const { condPred, uncondPred } = await evalDiffStep(tVal);
        const v1 = combine(condPred, uncondPred);

        let v2;
        if (this._vPrev === null || this._vPrev.length !== v1.length) {
            // 首步无历史：退化为 Euler
            v2 = v1;
        } else {
            // 速度突变检测：若 |v1 - v_prev| / |v1| 过大，外推不可靠
            let maxChangeRatio = 0;
            for (let i = 0; i < v1.length; i++) {
                const change = Math.abs(v1[i] - this._vPrev[i]);
                const base = Math.abs(v1[i]) + 1e-8;
                const r = change / base;
                if (r > maxChangeRatio) maxChangeRatio = r;
            }
            if (maxChangeRatio > 2.0) {
                // 速度变化过大，外推不安全
                v2 = v1;
            } else {
                // 线性外推: v2 = v1 + γ*(v1 - v_prev)
                v2 = new Float32Array(v1.length);
                const g = this._gamma;
                for (let i = 0; i < v1.length; i++) {
                    v2[i] = v1[i] + g * (v1[i] - this._vPrev[i]);
                }
            }
        }

        // 数值稳定性保护
        let v2Safe = v2;
        let needsFallback = false;

        // NaN/Inf 检测
        if (v2 !== v1) {
            for (let i = 0; i < v2.length; i++) {
                if (!Number.isFinite(v2[i])) { needsFallback = true; break; }
            }
        }

        // 幅度 + 符号检测：|v2|/|v1| > 3 或 v2 与 v1 反号且 |v2| > |v1|
        if (!needsFallback && v2 !== v1) {
            for (let i = 0; i < v1.length; i++) {
                const a = Math.abs(v2[i]);
                const b = Math.abs(v1[i]) + 1e-8;
                if (a / b > 3.0) { needsFallback = true; break; }
                // 符号翻转且幅度增大：v1*v2 < 0 且 |v2| > |v1|
                if (v1[i] * v2[i] < 0 && a > b) { needsFallback = true; break; }
            }
        }

        if (needsFallback) {
            v2Safe = v1;
        }

        // 2. delta = 0.5 * dt * (v1 + v2Safe) → 写入 deltaBuf
        const delta = buffers.deltaBuf;
        for (let i = 0; i < v1.length; i++) {
            delta[i] = 0.5 * dt * (v1[i] + v2Safe[i]);
        }

        // 3. 更新 v_prev 供下一步使用
        if (this._vPrev === null || this._vPrev.length !== v1.length) {
            this._vPrev = new Float32Array(v1.length);
        }
        this._vPrev.set(v1);

        return { nfe: 1 };
    }

    /**
     * 重置跨步状态（新一轮合成前调用）
     */
    reset() {
        this._vPrev = null;
    }
}

module.exports = ExtrapSolver;
