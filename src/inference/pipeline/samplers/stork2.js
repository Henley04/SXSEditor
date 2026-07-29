// STORK-2 求解器（Stabilized Taylor Orthogonal Runge-Kutta, 2nd order）
//
// 论文：STORK: Faster Diffusion and Flow Matching Sampling by Resolving both
// Stiffness and Structure-Dependence (Tan et al., ICLR 2026 Poster, arXiv:2505.24210)
// 官方实现：https://github.com/ZT220501/STORK/blob/main/STORKScheduler.py
//
// 本实现严格遵循论文的 step_flow_matching_2 方法（solver_order=2,
// derivative_order=1），使用 Runge-Kutta-Gegenbauer 二阶递推构造 s 个 sub-stage，
// 通过 Taylor 展开在 sub-stage 间复用速度场，实现 1 NFE/super-step 的 virtual NFE。
//
// ===== 算法 =====
//
// 记号：sample = x_n (当前状态), v = model_output at t_n (1 次 NFE),
//       dt = t_n - t_{n+1} > 0 (向后积分步长), s = sub-stage 数。
//
// Step 0 (Euler bootstrap，无历史速度):
//   delta = -v * dt
//   存储 v 到 velocity_predictions
//
// Step 1+ (主循环, derivative_order=1):
//   h1 = 上一步的 dt
//   v_deriv = (v_prev - v) / h1           // 一阶有限差分
//
//   RKC 递推 (j = 1..s):
//     Y_0 = Y_1 = sample
//     j=1:  mu_tilde = 6 / ((s+4)(s-1))
//           Y_j = Y_{j-1} - dt * mu_tilde * v
//     j>=2: mu      = (2j+1) * b(j) / (j * b(j-1))
//           nu      = -(j+1) * b(j) / (j * b(j-2))
//           mu_tilde = mu * 6 / ((s+4)(s-1))
//           gamma_tilde = -mu_tilde * (1 - j(j+1) b(j-1) / 2)
//           fraction = (j==2) ? 4/(3(s²+s-2)) : ((j-1)²+(j-1)-2)/(s²+s-2)
//           diff = -fraction * dt
//           v_taylor = v + diff * v_deriv   // Taylor 一阶展开
//           Y_j = mu*Y_{j-1} + nu*Y_{j-2} + (1-mu-nu)*sample
//                 - dt*mu_tilde*v_taylor - dt*gamma_tilde*v
//
//   delta = Y_s - sample
//
// b_coeff(j) (Runge-Kutta-Gegenbauer 二阶系数, 闭式):
//   b(0) = 1, b(1) = 1/3,
//   b(j) = 4(j-1)(j+4) / (3j(j+1)(j+2)(j+3))   for j >= 2
//
// ===== 符号约定 =====
// 论文的 flow matching 向后积分: img_next = sample - v * dt (dt > 0, t 递减)
// 本项目的向前积分约定:        delta = +v * dt, xt += delta (t 递增)
// 两者物理等价（t 参数化方向相反）。因此本实现的递推中，速度项取 + 号，
// 与项目内 Euler/Heun/Extrap 保持一致。
//
// ===== 性能 =====
// - NFE: 1 per super-step（s 个 sub-stage 纯代数运算，不调模型）
// - 内存: 3 个 Y buffer + 1 个 v_deriv buffer + 1 个历史 v buffer
// - 计算: s 趟全数组遍历/super-step（s=8 时约 8 * targetLen 次乘加）
// combine 写入 vBuf（复用），delta 写入 deltaBuf（复用）。
// 跨步状态: _velPreds 跨步复用，分块推理时每 chunk 新建实例（边界退化为 Euler）。

/**
 * STORK-2 求解器
 */
class Stork2Solver {
    /**
     * @param {number} [s=8] - sub-stage 数（RKC 递推步数）。
     *   论文默认 50（针对高分辨率图像）；音频扩散向量维度较小、stiffness 特性不同，
     *   8 是保守默认（稳定性域扩展 ~2s²=128 倍，计算开销适中）。
     *   s 越大稳定性越好但每 super-step 代数运算越多；s=1 退化为 Euler。
     */
    constructor(s = 8) {
        if (s < 2) {
            // s=1 会导致 muTildeBase = 6/((s+4)(s-1)) 除零；s=1 无稳定性增益
            console.warn(`[Stork2Solver] s=${s} too small (requires s>=2), fallback to s=8`);
            s = 8;
        }
        this.s = s;
        // 历史速度预测（derivative_order=1 只需 1 个，但保留数组结构便于扩展）
        this._velPreds = [];
        // 内部缓冲区（首步延迟分配，按 targetLen 大小）
        this._Yj = null;
        this._Yj1 = null;
        this._Yj2 = null;
        this._vDeriv = null;
    }

    /**
     * Runge-Kutta-Gegenbauer 二阶系数 b(j)
     * 来源: https://www.sciencedirect.com/science/article/pii/S0021999120306537
     * @param {number} j
     * @returns {number}
     */
    _bCoeff(j) {
        if (j < 0) throw new Error(`b_coeff: j=${j} must be non-negative`);
        if (j === 0) return 1;
        if (j === 1) return 1 / 3;
        return (4 * (j - 1) * (j + 4)) / (3 * j * (j + 1) * (j + 2) * (j + 3));
    }

    /**
     * @param {Object} ctx
     * @param {Function} ctx.evalDiffStep
     * @param {Function} ctx.combine - 写入 ctx.buffers.vBuf
     * @param {number} ctx.step
     * @param {number} ctx.totalSteps
     * @param {Float32Array} ctx.xtData
     * @param {Object} ctx.buffers - { vBuf, deltaBuf }
     * @returns {Promise<{nfe: number}>}
     */
    async step({ evalDiffStep, combine, step, totalSteps, xtData, buffers }) {
        const dt = 1.0 / totalSteps;
        // 论文使用 t_n = sigmas[step]（向后递减），本项目使用向前递增的 midpoint t。
        // 两种参数化等价（见文件头说明），t 值传给 evalDiffStep 供模型内部缩放使用。
        const tVal = (step + 0.5) / totalSteps;
        const n = xtData.length;

        // 1. 唯一一次 NFE 评估 → combine 写入 vBuf
        const { condPred, uncondPred } = await evalDiffStep(tVal);
        const v = combine(condPred, uncondPred); // 指向 buffers.vBuf

        // 延迟分配内部缓冲区
        if (this._Yj === null || this._Yj.length !== n) {
            this._Yj = new Float32Array(n);
            this._Yj1 = new Float32Array(n);
            this._Yj2 = new Float32Array(n);
            this._vDeriv = new Float32Array(n);
        }

        const delta = buffers.deltaBuf;
        const s = this.s;

        // 2. Bootstrap: 首步无历史速度，退化为 Euler
        if (this._velPreds.length === 0) {
            // delta = v * dt （项目向前积分约定，等价于论文的 -v*dt）
            for (let i = 0; i < n; i++) {
                delta[i] = v[i] * dt;
            }
            // 保存 v 供下一步求导
            const vStored = new Float32Array(n);
            vStored.set(v);
            this._velPreds.push(vStored);
            return { nfe: 1 };
        }

        // 3. 计算速度一阶导数（有限差分）
        // 论文: velocity_derivative = (v_prev - v) / h1
        // （论文的 v_prev 是上一步 model_output，h1 是上一步 dt；均匀步长下 h1 = dt）
        const vPrev = this._velPreds[this._velPreds.length - 1];
        const vDeriv = this._vDeriv;
        const invH1 = 1.0 / dt; // 均匀步长
        for (let i = 0; i < n; i++) {
            vDeriv[i] = (vPrev[i] - v[i]) * invH1;
        }

        // 4. RKC 递推（s 个 sub-stage）
        // Y_0 = Y_1 = sample
        this._Yj1.set(xtData);
        this._Yj2.set(xtData);

        // 预计算常量
        const sSq = s * s;
        const muTildeBase = 6.0 / ((s + 4) * (s - 1));
        const fracDenom = sSq + s - 2;

        for (let j = 1; j <= s; j++) {
            if (j === 1) {
                // Y_1 = Y_0 + dt * muTildeBase * v  （项目向前约定: + 号）
                const muTilde = muTildeBase;
                const Yj = this._Yj;
                const Yj1 = this._Yj1;
                for (let i = 0; i < n; i++) {
                    Yj[i] = Yj1[i] + dt * muTilde * v[i];
                }
            } else {
                // 递推系数
                const bj = this._bCoeff(j);
                const bj1 = this._bCoeff(j - 1);
                const bj2 = this._bCoeff(j - 2);
                const mu = ((2 * j + 1) * bj) / (j * bj1);
                const nu = (-(j + 1) * bj) / (j * bj2);
                const muTilde = mu * muTildeBase;
                const gammaTilde = -muTilde * (1 - (j * (j + 1) * bj1) / 2);

                // fraction: sub-stage 在 [t_n, t_{n+1}] 内的相对位置
                let fraction;
                if (j === 2) {
                    fraction = 4 / (3 * fracDenom);
                } else {
                    fraction = ((j - 1) * (j - 1) + (j - 1) - 2) / fracDenom;
                }
                // 论文: diff = -fraction * (t - t_next) = -fraction * dt
                // 在向前约定下，diff 表示 sub-stage 相对 t_n 的偏移量
                const diff = -fraction * dt;

                // Taylor 一阶展开: v_taylor = v + diff * v_deriv
                // （diff < 0 表示在 t_n 之前的位置，与论文向后积分一致）
                const Yj = this._Yj;
                const Yj1 = this._Yj1;
                const Yj2 = this._Yj2;
                const oneMinusMuNu = 1 - mu - nu;
                for (let i = 0; i < n; i++) {
                    const vTaylor = v[i] + diff * vDeriv[i];
                    // 向前约定: 速度项取 + 号（论文取 - 号）
                    Yj[i] = mu * Yj1[i] + nu * Yj2[i] + oneMinusMuNu * xtData[i]
                        + dt * muTilde * vTaylor + dt * gammaTilde * v[i];
                }
            }

            // 滚动 Y buffer: Y_{j-2} <- Y_{j-1}, Y_{j-1} <- Y_j
            // 用交换引用避免拷贝
            const tmp = this._Yj2;
            this._Yj2 = this._Yj1;
            this._Yj1 = this._Yj;
            this._Yj = tmp;
        }

        // 5. delta = Y_s - sample → 写入 deltaBuf
        // 循环结束后，最终结果在 this._Yj1 中（因为上一步做了滚动交换）
        const Ys = this._Yj1;
        for (let i = 0; i < n; i++) {
            delta[i] = Ys[i] - xtData[i];
        }

        // 6. 保存 v 供下一步求导（derivative_order=1 只需 1 个历史值）
        // 直接写入已存储的 buffer 避免再分配
        if (this._velPreds.length > 0) {
            this._velPreds[0].set(v);
        } else {
            const vStored = new Float32Array(n);
            vStored.set(v);
            this._velPreds.push(vStored);
        }

        return { nfe: 1 };
    }

    /**
     * 重置跨步状态（新一轮合成前调用）
     */
    reset() {
        this._velPreds = [];
        this._Yj = null;
        this._Yj1 = null;
        this._Yj2 = null;
        this._vDeriv = null;
    }
}

module.exports = Stork2Solver;
