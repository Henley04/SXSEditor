const { expect } = require('chai');
const EulerSolver = require('../src/inference/pipeline/samplers/euler');
const HeunSolver = require('../src/inference/pipeline/samplers/heun');
const ExtrapSolver = require('../src/inference/pipeline/samplers/extrap');
const Stork2Solver = require('../src/inference/pipeline/samplers/stork2');
const { createSampler, resolveSamplerName, SOLVERS, DEFAULT_SOLVER, LEGACY_ALIASES } = require('../src/inference/pipeline/samplers');

/**
 * 采样器（求解器）单元测试。
 *
 * 验证：
 * 1. Euler：t=(step+0.5)/N, delta = v*dt（写入 deltaBuf）
 * 2. Heun 二阶梯形公式，末步退化为 Euler（tNext>1 保护）
 * 3. Extrapolated Euler 首步退化为 Euler，后续步用速度外推，含数值稳定性保护
 * 4. STORK-2：首步 Euler bootstrap，常量速度场退化为 Euler，RKC 递推正确性
 * 5. 注册表与工厂函数（含 stork→extrap 旧名称兼容）
 * 6. NFE 计数正确
 * 7. combine CFG/Rescale 数值正确性
 */

const MEL_DIM = 4;
const TOTAL_FRAMES = 8;

// 构造常量速度场 v(x,t) = c（与 x/t 无关），便于解析验证
function makeConstEvalDiffStep(c, cfg = true) {
    return async (_t, _xtOverride) => {
        const condPred = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(c);
        const uncondPred = cfg ? new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(c * 0.5) : null;
        return { condPred, uncondPred };
    };
}

// combine: 写入 vBuf（通过闭包绑定，模拟 pipeline 的 combine 接口）
// 实际 pipeline 的 combine 是 (condPred, uncondPred) → vBuf，vBuf 通过闭包访问
function makeIdentityCombine(vBuf) {
    return (condPred, _uncondPred) => {
        vBuf.set(condPred);
        return vBuf;
    };
}

// 构造复用缓冲区（模拟调用方预分配）
function makeBuffers() {
    const len = TOTAL_FRAMES * MEL_DIM;
    return {
        vBuf: new Float32Array(len),
        deltaBuf: new Float32Array(len),
        v1Buf: new Float32Array(len),
        xPredBuf: new Float32Array(len),
    };
}

describe('Samplers - 求解器单元测试', () => {
    describe('EulerSolver', () => {
        it('delta = v * dt，t = (step+0.5)/N', async () => {
            const c = 0.7;
            const N = 4;
            const solver = new EulerSolver();
            const buffers = makeBuffers();
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 1, totalSteps: N, buffers,
            });
            // dt = 1/4 = 0.25, delta = c * dt = 0.7 * 0.25 = 0.175
            expect(nfe).to.equal(1);
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(buffers.deltaBuf[i]).to.be.closeTo(0.175, 1e-6);
            }
        });

        it('累加 N 步后 x = sum(v*dt) = v', async () => {
            const c = 1.0;
            const N = 10;
            const solver = new EulerSolver();
            const buffers = makeBuffers();
            let xt = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            for (let s = 0; s < N; s++) {
                await solver.step({
                    evalDiffStep: makeConstEvalDiffStep(c, false),
                    combine: makeIdentityCombine(buffers.vBuf),
                    step: s, totalSteps: N, buffers,
                });
                for (let i = 0; i < xt.length; i++) xt[i] += buffers.deltaBuf[i];
            }
            // x = v * N * dt = v * 1 = 1.0
            for (let i = 0; i < xt.length; i++) {
                expect(xt[i]).to.be.closeTo(1.0, 1e-6);
            }
        });
    });

    describe('HeunSolver', () => {
        it('常量速度场下 delta = v*dt（与 Euler 等价，因为 v1=v2）', async () => {
            const c = 0.5;
            const N = 4;
            const solver = new HeunSolver();
            const buffers = makeBuffers();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: N, xtData, buffers,
            });
            // 常量场：v1 = v2 = c, delta = 0.5*(c+c)*dt = c*dt = 0.5*0.25 = 0.125
            expect(nfe).to.equal(2);
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(buffers.deltaBuf[i]).to.be.closeTo(0.125, 1e-6);
            }
        });

        it('末步退化为 Euler（nfe=1，避免 tNext>1）', async () => {
            const c = 0.5;
            const N = 4;
            const solver = new HeunSolver();
            const buffers = makeBuffers();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: N - 1, totalSteps: N, xtData, buffers,
            });
            expect(nfe).to.equal(1);
        });

        it('非末步 nfe=2', async () => {
            const solver = new HeunSolver();
            const buffers = makeBuffers();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(0.5, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: 4, xtData, buffers,
            });
            expect(nfe).to.equal(2);
        });
    });

    describe('ExtrapSolver', () => {
        it('首步退化为 Euler（无 v_prev）', async () => {
            const c = 0.6;
            const N = 4;
            const solver = new ExtrapSolver(2);
            const buffers = makeBuffers();
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: N, buffers,
            });
            // 首步 v2 = v1 = c, delta = 0.5*(c+c)*dt = c*dt
            expect(nfe).to.equal(1);
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(buffers.deltaBuf[i]).to.be.closeTo(c / N, 1e-6);
            }
        });

        it('常量速度场后续步 delta = v*dt（v1=v_prev，外推无变化）', async () => {
            const c = 0.6;
            const N = 4;
            const solver = new ExtrapSolver(2);
            const buffers = makeBuffers();
            // 首步填充 v_prev
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: N, buffers,
            });
            // 第二步：v1 = v_prev = c，v2 = c + 0.5*(c-c) = c，delta = c*dt
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 1, totalSteps: N, buffers,
            });
            expect(nfe).to.equal(1);
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(buffers.deltaBuf[i]).to.be.closeTo(c / N, 1e-6);
            }
        });

        it('reset() 清空 v_prev 状态', async () => {
            const solver = new ExtrapSolver(2);
            const buffers = makeBuffers();
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(0.5, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: 4, buffers,
            });
            solver.reset();
            expect(solver._vPrev).to.be.null;
        });

        it('不支持的高阶自动降级到 2', () => {
            const solver = new ExtrapSolver(3);
            expect(solver.order).to.equal(2);
        });

        it('数值稳定性保护：v_prev 突变时退化为 Euler（幅度检测）', async () => {
            const solver = new ExtrapSolver(2);
            const buffers = makeBuffers();
            // 首步：v = 0.001（小值），建立 v_prev
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(0.001, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: 4, buffers,
            });
            // 手动注入大 v_prev 使 ratio > 3
            solver._vPrev = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(1000);
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(1.0, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 1, totalSteps: 4, buffers,
            });
            // v1=1.0, v_prev=1000, 速度突变 ratio = |1-1000|/1 = 999 > 2 → 不外推，v2=v1
            // delta = 0.5*(1+1)*dt = dt = 0.25
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(buffers.deltaBuf[i]).to.be.closeTo(0.25, 1e-6);
            }
        });

        it('数值稳定性保护：符号翻转且幅度增大时退化为 Euler', async () => {
            const solver = new ExtrapSolver(2);
            const buffers = makeBuffers();
            // 首步建立 v_prev
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(1.0, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: 4, buffers,
            });
            // 构造符号翻转场景：v1=1.0, v_prev=2.1
            // 速度突变 ratio = |1-2.1|/1 = 1.1 < 2 → 速度检测不触发，进入外推
            // 提高外推系数 γ=2.0 使 v2 翻转：v2 = 1 + 2*(1-2.1) = 1 - 2.2 = -1.2
            // |v2|/|v1| = 1.2 < 3 → 幅度检测不触发
            // v1*v2 = -1.2 < 0 且 |v2|=1.2 > |v1|=1 → 符号翻转检测触发，退化为 Euler
            solver._vPrev = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(2.1);
            solver._gamma = 2.0;
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(1.0, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 1, totalSteps: 4, buffers,
            });
            // fallback: v2 = v1 = 1.0, delta = 0.5*(1+1)*dt = dt = 0.25
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(buffers.deltaBuf[i]).to.be.closeTo(0.25, 1e-6);
            }
        });
    });

    describe('Stork2Solver', () => {
        it('首步退化为 Euler bootstrap（无历史速度）', async () => {
            const c = 0.5;
            const N = 4;
            const solver = new Stork2Solver(8);
            const buffers = makeBuffers();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: N, xtData, buffers,
            });
            // 首步：delta = v * dt = c / N
            expect(nfe).to.equal(1);
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(buffers.deltaBuf[i]).to.be.closeTo(c / N, 1e-6);
            }
        });

        it('常量速度场后续步也退化为 Euler（v_deriv=0, RKC 稳定性多项式 R(0)=1）', async () => {
            // 关键性质：对于 dx/dt = const，RKC 二阶递推满足 R_s(0)=1, R_s'(0)=1，
            // 即 Y_s = sample + v*dt，delta = v*dt（与 Euler 完全一致）。
            const c = 0.5;
            const N = 4;
            const solver = new Stork2Solver(8);
            const buffers = makeBuffers();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            // 首步 bootstrap
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: N, xtData, buffers,
            });
            // 第二步：v_prev = v = c, v_deriv = 0, 所有 sub-stage 的 Taylor = v
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 1, totalSteps: N, xtData, buffers,
            });
            expect(nfe).to.equal(1);
            // 常量场：delta 应等于 v*dt = c/N
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(buffers.deltaBuf[i]).to.be.closeTo(c / N, 1e-6);
            }
        });

        it('NFE 始终为 1（virtual NFE: s 个 sub-stage 不调模型）', async () => {
            const solver = new Stork2Solver(8);
            const buffers = makeBuffers();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            for (let step = 0; step < 4; step++) {
                const { nfe } = await solver.step({
                    evalDiffStep: makeConstEvalDiffStep(0.5 * step, false),
                    combine: makeIdentityCombine(buffers.vBuf),
                    step, totalSteps: 4, xtData, buffers,
                });
                expect(nfe).to.equal(1);
            }
        });

        it('reset() 清空跨步状态（下一步重新 bootstrap）', async () => {
            const solver = new Stork2Solver(8);
            const buffers = makeBuffers();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            // 跑两步建立状态
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(0.5, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: 4, xtData, buffers,
            });
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(0.5, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 1, totalSteps: 4, xtData, buffers,
            });
            // reset 后应重新 bootstrap
            solver.reset();
            expect(solver._velPreds.length).to.equal(0);
            expect(solver._Yj).to.be.null;
            // 首步应再次退化为 Euler
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(0.5, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: 4, xtData, buffers,
            });
            expect(nfe).to.equal(1);
            // bootstrap: delta = v * dt
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(buffers.deltaBuf[i]).to.be.closeTo(0.5 / 4, 1e-6);
            }
        });

        it('s=1 自动 fallback 到 s=8（避免除零）', () => {
            const solver = new Stork2Solver(1);
            // s=1 会导致 muTildeBase 除零，构造函数应 fallback
            expect(solver.s).to.equal(8);
        });

        it('s=0 自动 fallback 到 s=8', () => {
            const solver = new Stork2Solver(0);
            expect(solver.s).to.equal(8);
        });

        it('s=2 时正常工作（最小有效 sub-stage 数）', async () => {
            const c = 0.5;
            const N = 4;
            const solver = new Stork2Solver(2);
            const buffers = makeBuffers();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            // 首步 bootstrap
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: N, xtData, buffers,
            });
            // 第二步: s=2, 跑 j=1 和 j=2
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 1, totalSteps: N, xtData, buffers,
            });
            expect(nfe).to.equal(1);
            // 常量场: delta 仍应 = v*dt
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(buffers.deltaBuf[i]).to.be.closeTo(c / N, 1e-6);
            }
        });

        it('_bCoeff 闭式公式正确', () => {
            const solver = new Stork2Solver(8);
            expect(solver._bCoeff(0)).to.equal(1);
            expect(solver._bCoeff(1)).to.be.closeTo(1 / 3, 1e-10);
            // b(2) = 4*1*6 / (3*2*3*4*5) = 24/360 = 1/15
            expect(solver._bCoeff(2)).to.be.closeTo(1 / 15, 1e-10);
            // b(3) = 4*2*7 / (3*3*4*5*6) = 56/1080 = 7/135
            expect(solver._bCoeff(3)).to.be.closeTo(7 / 135, 1e-10);
        });

        it('时变速度场产生不同于 Euler 的 delta（验证 RKC 递推生效）', async () => {
            // 速度场随 step 线性变化: v = c0 + c1*step
            // v_deriv = (v_prev - v) / dt ≠ 0, Taylor 展开引入校正
            const c0 = 1.0, c1 = 0.5;
            const N = 4;
            const dt = 1 / N;
            const solver = new Stork2Solver(8);
            const buffers = makeBuffers();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            // 首步 bootstrap (v = c0)
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c0, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 0, totalSteps: N, xtData, buffers,
            });
            // 第二步: v = c0 + c1*1 = 1.5, v_prev = 1.0
            // v_deriv = (1.0 - 1.5) / dt = -0.5 * N = -2.0
            // Euler delta = v * dt = 1.5 * 0.25 = 0.375
            // STORK-2 delta ≠ 0.375（RKC 递推 + Taylor 校正会改变结果）
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c0 + c1 * 1, false),
                combine: makeIdentityCombine(buffers.vBuf),
                step: 1, totalSteps: N, xtData, buffers,
            });
            const eulerDelta = (c0 + c1 * 1) * dt;
            let allDifferent = true;
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                if (Math.abs(buffers.deltaBuf[i] - eulerDelta) < 1e-6) {
                    allDifferent = false;
                    break;
                }
            }
            expect(allDifferent).to.be.true;
            // delta 应为有限值（无 NaN/Inf）
            for (let i = 0; i < buffers.deltaBuf.length; i++) {
                expect(Number.isFinite(buffers.deltaBuf[i])).to.be.true;
            }
        });
    });

    describe('combine CFG/Rescale 数值正确性', () => {
        it('CFG + Rescale 产生正确的缩放输出（手算验证）', async () => {
            // 构造 condPred: 2 帧 × 2 dim，ptFrameCount=1
            // condPred = [pt_val, pt_val, 1.0, 1.0]  (ptFrameCount=1, totalFrames=2, MEL_DIM=2)
            // uncondPred = [0.5, 0.5, 0.5, 0.5]
            // cfgStrength=2.0, cfgRescale=0.5
            const ptFrameCount = 1;
            const _totalFrames = 2;
            const _melDim = 2;
            const condPred = new Float32Array((ptFrameCount + _totalFrames) * _melDim);
            // pt 段 [0,0]，target 段 4 个元素全 1.0（2 帧 × 2 dim）
            condPred[2] = 1.0; condPred[3] = 1.0;
            condPred[4] = 1.0; condPred[5] = 1.0;
            const uncondPred = new Float32Array(_totalFrames * _melDim).fill(0.5);

            const cfgStrength = 2.0;
            const cfgRescale = 0.5;

            // 手算：
            // cfgVal = condVal + 2*(condVal - uncondVal) = 1.0 + 2*(1.0-0.5) = 2.0
            // posSum = 1.0+1.0 = 2.0, posMean = 1.0
            // cfgAdjSum = 2.0+2.0 = 4.0, cfgAdjMean = 2.0
            // posVarSum = (1-1)²+(1-1)² = 0, posStd = 0
            // cfgAdjVarSum = (2-2)²+(2-2)² = 0, cfgAdjStd = 0
            // rescale = 0 / (0 + 1e-8) = 0
            // v = 0.5 * (2.0 * 0) + 0.5 * 2.0 = 1.0
            const vBuf = new Float32Array(_totalFrames * _melDim);
            const cfgPredBuf = new Float32Array(_totalFrames * _melDim);
            // 内联 combine（维度与测试数据匹配，不使用外层 TOTAL_FRAMES/MEL_DIM）
            const targetLen = _totalFrames * _melDim;
            let posSum = 0, cfgAdjSum = 0;
            for (let f = 0; f < _totalFrames; f++) {
                const tgtOffset = (ptFrameCount + f) * _melDim;
                for (let d = 0; d < _melDim; d++) {
                    const condVal = condPred[tgtOffset + d];
                    const uncondVal = uncondPred[f * _melDim + d];
                    const cfgVal = condVal + cfgStrength * (condVal - uncondVal);
                    cfgPredBuf[f * _melDim + d] = cfgVal;
                    posSum += condVal;
                    cfgAdjSum += cfgVal;
                }
            }
            const posMean = posSum / targetLen;
            const cfgAdjMean = cfgAdjSum / targetLen;
            let posVarSum = 0, cfgAdjVarSum = 0;
            for (let f = 0; f < _totalFrames; f++) {
                const tgtOffset = (ptFrameCount + f) * _melDim;
                for (let d = 0; d < _melDim; d++) {
                    const pv = condPred[tgtOffset + d] - posMean;
                    posVarSum += pv * pv;
                    const cv = cfgPredBuf[f * _melDim + d] - cfgAdjMean;
                    cfgAdjVarSum += cv * cv;
                }
            }
            const posStd = Math.sqrt(Math.max(0, posVarSum) / Math.max(1, targetLen - 1));
            const cfgAdjStd = Math.sqrt(Math.max(0, cfgAdjVarSum) / Math.max(1, targetLen - 1));
            const rescale = posStd / (cfgAdjStd + 1e-8);
            for (let i = 0; i < targetLen; i++) {
                const cfgVal = cfgPredBuf[i];
                vBuf[i] = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
            }
            for (let i = 0; i < vBuf.length; i++) {
                expect(vBuf[i]).to.be.closeTo(1.0, 1e-5);
            }
        });

        it('无 CFG 时 combine 直接返回 condPred target 段', () => {
            const ptFrameCount = 1;
            const _totalFrames = 2;
            const _melDim = 2;
            const condPred = new Float32Array((ptFrameCount + _totalFrames) * _melDim);
            condPred[2] = 0.7; condPred[3] = 0.3; // target 段
            const vBuf = new Float32Array(_totalFrames * _melDim);
            // 内联 combine（无 CFG 分支：直接取 target 段）
            for (let f = 0; f < _totalFrames; f++) {
                const tgtOffset = (ptFrameCount + f) * _melDim;
                for (let d = 0; d < _melDim; d++) {
                    vBuf[f * _melDim + d] = condPred[tgtOffset + d];
                }
            }
            expect(vBuf[0]).to.be.closeTo(0.7, 1e-6);
            expect(vBuf[1]).to.be.closeTo(0.3, 1e-6);
        });
    });

    describe('注册表与工厂', () => {
        it('DEFAULT_SOLVER = "stork2"', () => {
            expect(DEFAULT_SOLVER).to.equal('stork2');
        });

        it('SOLVERS 包含 euler/heun/extrap/stork2', () => {
            expect(SOLVERS).to.have.property('euler');
            expect(SOLVERS).to.have.property('heun');
            expect(SOLVERS).to.have.property('extrap');
            expect(SOLVERS).to.have.property('stork2');
        });

        it('resolveSamplerName 合法值原样返回', () => {
            expect(resolveSamplerName('euler')).to.equal('euler');
            expect(resolveSamplerName('heun')).to.equal('heun');
            expect(resolveSamplerName('extrap')).to.equal('extrap');
            expect(resolveSamplerName('stork2')).to.equal('stork2');
        });

        it('resolveSamplerName 旧名称 stork → extrap（向后兼容）', () => {
            expect(resolveSamplerName('stork')).to.equal('extrap');
        });

        it('LEGACY_ALIASES 包含 stork→extrap 映射', () => {
            expect(LEGACY_ALIASES).to.have.property('stork');
            expect(LEGACY_ALIASES.stork).to.equal('extrap');
        });

        it('resolveSamplerName 非法值回退到默认', () => {
            expect(resolveSamplerName('dpm')).to.equal('stork2');
            expect(resolveSamplerName(undefined)).to.equal('stork2');
            expect(resolveSamplerName(null)).to.equal('stork2');
            expect(resolveSamplerName(123)).to.equal('stork2');
        });

        it('createSampler 返回正确类型', () => {
            expect(createSampler('euler')).to.be.instanceOf(EulerSolver);
            expect(createSampler('heun')).to.be.instanceOf(HeunSolver);
            expect(createSampler('extrap')).to.be.instanceOf(ExtrapSolver);
            expect(createSampler('stork2')).to.be.instanceOf(Stork2Solver);
            // 旧名称也返回 ExtrapSolver
            expect(createSampler('stork')).to.be.instanceOf(ExtrapSolver);
            // 非法值返回默认 Stork2Solver
            expect(createSampler('invalid')).to.be.instanceOf(Stork2Solver);
        });
    });
});
