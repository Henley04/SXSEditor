const { expect } = require('chai');
const EulerSolver = require('../src/inference/pipeline/samplers/euler');
const HeunSolver = require('../src/inference/pipeline/samplers/heun');
const StorkSolver = require('../src/inference/pipeline/samplers/stork');
const { createSampler, resolveSamplerName, SOLVERS, DEFAULT_SOLVER } = require('../src/inference/pipeline/samplers');

/**
 * 采样器（求解器）单元测试。
 *
 * 验证：
 * 1. Euler 等价于原实现：t=(step+0.5)/N, delta = v*dt
 * 2. Heun 二阶梯形公式，末步退化为 Euler（tNext>1 保护）
 * 3. STORK-2 首步退化为 Euler，后续步用 Taylor 外推，含数值稳定性保护
 * 4. 注册表与工厂函数
 * 5. NFE 计数正确
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

// combine: 无 CFG 时直接返回 condPred；有 CFG 时返回 condPred（忽略 uncond，简化测试）
function makeIdentityCombine(useCfg) {
    return (condPred, _uncondPred) => {
        if (!useCfg) return condPred;
        // 简化：直接返回 condPred，不实际做 CFG 合并
        return condPred;
    };
}

describe('Samplers - 求解器单元测试', () => {
    describe('EulerSolver', () => {
        it('delta = v * dt，t = (step+0.5)/N', async () => {
            const c = 0.7;
            const N = 4;
            const solver = new EulerSolver();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            const { delta, nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(false),
                step: 1, totalSteps: N, xtData,
            });
            // dt = 1/4 = 0.25, delta = c * dt = 0.7 * 0.25 = 0.175
            expect(nfe).to.equal(1);
            for (let i = 0; i < delta.length; i++) {
                expect(delta[i]).to.be.closeTo(0.175, 1e-6);
            }
        });

        it('累加 N 步后 x = sum(v*dt) = v', async () => {
            const c = 1.0;
            const N = 10;
            const solver = new EulerSolver();
            let xt = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            for (let s = 0; s < N; s++) {
                const { delta } = await solver.step({
                    evalDiffStep: makeConstEvalDiffStep(c, false),
                    combine: makeIdentityCombine(false),
                    step: s, totalSteps: N, xtData: xt,
                });
                for (let i = 0; i < xt.length; i++) xt[i] += delta[i];
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
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            const { delta, nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(false),
                step: 0, totalSteps: N, xtData,
            });
            // 常量场：v1 = v2 = c, delta = 0.5*(c+c)*dt = c*dt = 0.5*0.25 = 0.125
            expect(nfe).to.equal(2);
            for (let i = 0; i < delta.length; i++) {
                expect(delta[i]).to.be.closeTo(0.125, 1e-6);
            }
        });

        it('末步退化为 Euler（nfe=1，避免 tNext>1）', async () => {
            const c = 0.5;
            const N = 4;
            const solver = new HeunSolver();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(false),
                step: N - 1, totalSteps: N, xtData,
            });
            expect(nfe).to.equal(1);
        });

        it('非末步 nfe=2', async () => {
            const solver = new HeunSolver();
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            const { nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(0.5, false),
                combine: makeIdentityCombine(false),
                step: 0, totalSteps: 4, xtData,
            });
            expect(nfe).to.equal(2);
        });
    });

    describe('StorkSolver', () => {
        it('首步退化为 Euler（无 v_prev）', async () => {
            const c = 0.6;
            const N = 4;
            const solver = new StorkSolver(2);
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            const { delta, nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(false),
                step: 0, totalSteps: N, xtData,
            });
            // 首步 v2 = v1 = c, delta = 0.5*(c+c)*dt = c*dt
            expect(nfe).to.equal(1);
            for (let i = 0; i < delta.length; i++) {
                expect(delta[i]).to.be.closeTo(c / N, 1e-6);
            }
        });

        it('常量速度场后续步 delta = v*dt（v1=v_prev，外推无变化）', async () => {
            const c = 0.6;
            const N = 4;
            const solver = new StorkSolver(2);
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            // 首步填充 v_prev
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(false),
                step: 0, totalSteps: N, xtData,
            });
            // 第二步：v1 = v_prev = c，v2 = c + 0.5*(c-c) = c，delta = c*dt
            const { delta, nfe } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(c, false),
                combine: makeIdentityCombine(false),
                step: 1, totalSteps: N, xtData,
            });
            expect(nfe).to.equal(1);
            for (let i = 0; i < delta.length; i++) {
                expect(delta[i]).to.be.closeTo(c / N, 1e-6);
            }
        });

        it('reset() 清空 v_prev 状态', async () => {
            const solver = new StorkSolver(2);
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(0.5, false),
                combine: makeIdentityCombine(false),
                step: 0, totalSteps: 4, xtData,
            });
            solver.reset();
            expect(solver._vPrev).to.be.null;
        });

        it('不支持的高阶自动降级到 2', () => {
            const solver = new StorkSolver(3);
            expect(solver.order).to.equal(2);
        });

        it('数值稳定性保护：v_prev 突变时退化为 Euler', async () => {
            const solver = new StorkSolver(2);
            const xtData = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(0);
            // 首步：v = 0.001（小值），建立 v_prev
            await solver.step({
                evalDiffStep: makeConstEvalDiffStep(0.001, false),
                combine: makeIdentityCombine(false),
                step: 0, totalSteps: 4, xtData,
            });
            // 第二步：v = 10（大值），v_prev=0.001，外推 v2 = 10 + 0.5*(10-0.001) = 14.9995
            // ratio = 14.9995 / 10 ≈ 1.5 < 3，不会触发 fallback
            // 改用更极端：v=100，v2 = 100 + 0.5*(100-0.001) = 149.9995，ratio ≈ 1.5 仍不触发
            // 用 v_prev=0.001, v=0.001 但手动注入大 v_prev 测试 fallback 路径
            // 直接验证 needsFallback 逻辑：构造 v_prev 使 ratio > 3
            solver._vPrev = new Float32Array(TOTAL_FRAMES * MEL_DIM).fill(1000);
            const { delta } = await solver.step({
                evalDiffStep: makeConstEvalDiffStep(1.0, false),
                combine: makeIdentityCombine(false),
                step: 1, totalSteps: 4, xtData,
            });
            // v1=1.0, v_prev=1000, v2 = 1 + 0.5*(1-1000) = -499，|v2|/|v1| = 499 > 3 → fallback
            // fallback 后 v2=v1=1.0, delta = 0.5*(1+1)*dt = dt = 0.25
            for (let i = 0; i < delta.length; i++) {
                expect(delta[i]).to.be.closeTo(0.25, 1e-6);
            }
        });
    });

    describe('注册表与工厂', () => {
        it('DEFAULT_SOLVER = "euler"', () => {
            expect(DEFAULT_SOLVER).to.equal('euler');
        });

        it('SOLVERS 包含 euler/heun/stork', () => {
            expect(SOLVERS).to.have.property('euler');
            expect(SOLVERS).to.have.property('heun');
            expect(SOLVERS).to.have.property('stork');
        });

        it('resolveSamplerName 合法值原样返回', () => {
            expect(resolveSamplerName('euler')).to.equal('euler');
            expect(resolveSamplerName('heun')).to.equal('heun');
            expect(resolveSamplerName('stork')).to.equal('stork');
        });

        it('resolveSamplerName 非法值回退到默认', () => {
            expect(resolveSamplerName('dpm')).to.equal('euler');
            expect(resolveSamplerName(undefined)).to.equal('euler');
            expect(resolveSamplerName(null)).to.equal('euler');
            expect(resolveSamplerName(123)).to.equal('euler');
        });

        it('createSampler 返回正确类型', () => {
            expect(createSampler('euler')).to.be.instanceOf(EulerSolver);
            expect(createSampler('heun')).to.be.instanceOf(HeunSolver);
            expect(createSampler('stork')).to.be.instanceOf(StorkSolver);
            // 非法值返回 Euler
            expect(createSampler('invalid')).to.be.instanceOf(EulerSolver);
        });
    });
});
