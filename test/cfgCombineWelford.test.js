const { expect } = require('chai');

/**
 * Task 7: CFG combine Welford 单趟在线方差 vs 三趟 two-pass 数值一致性测试。
 *
 * pipeline/diffusion.js 的 combine 函数使用 Welford 在线算法在单次遍历中计算
 * posMean/posM2（cond 分支）与 cfgAdjMean/cfgAdjM2（CFG 调整后），
 * 然后用 Bessel 校正（N-1 分母）计算 std 与 rescale。
 *
 * 本测试对比 Welford 单趟实现与经典 two-pass 实现在随机数据上的数值一致性，
 * 验证 rescale 与最终 combine 输出在 1e-7 内一致。
 *
 * M8 LIMITATION (重要): The Welford (`combineWelford`) and two-pass
 * (`combineTwoPass`) implementations below are INLINED COPIES of the algorithm,
 * NOT imports of the production `combine` closure from pipeline/diffusion.js
 * (or webnn/diffusion.js). The production `combine` is a closure inside
 * `runDiffusionLoop` and is not exported, so it cannot be unit-tested directly
 * without refactoring diffusion.js (out of scope for this change). Consequently
 * this test validates ALGORITHM CORRECTNESS (Welford == two-pass) but will NOT
 * detect production code drift — if someone edits the closure in diffusion.js
 * to use a different formula, this test still passes.
 *
 * TODO(M8): Extract `combine` into a standalone, exported helper
 * `combineCfgWelford(condPred, uncondPred, cfgStrength, cfgRescale, targetLen,
 * cfgPredBuf, vBuf)` (or a shared `pipeline/cfgCombine.js` module imported by
 * both pipeline/diffusion.js and webnn/diffusion.js), then refactor this test
 * to import and exercise the REAL production function so drift is caught.
 * (This requires touching diffusion.js / webnn/diffusion.js, which is out of
 * scope for the current review-fix pass.)
 *
 * To compensate for the indirection, the random-seed and edge-case coverage
 * below is deliberately broad (many seeds, large arrays, degenerate inputs)
 * so the algorithm correctness is thoroughly validated.
 */

/**
 * Welford 单趟实现（复制自 pipeline/diffusion.js combine 函数 Task 7 逻辑）。
 * 返回 { v, posStd, cfgAdjStd, rescale }。
 */
function combineWelford(condPred, uncondPred, cfgStrength, cfgRescale) {
    const targetLen = condPred.length;
    const v = new Float32Array(targetLen);
    const cfgPredBuf = new Float32Array(targetLen);
    let posMean = 0, posM2 = 0;
    let cfgAdjMean = 0, cfgAdjM2 = 0;
    let n = 0;
    for (let i = 0; i < targetLen; i++) {
        const condVal = condPred[i];
        const uncondVal = uncondPred[i];
        const cfgVal = condVal + cfgStrength * (condVal - uncondVal);
        cfgPredBuf[i] = cfgVal;
        n++;
        const posDelta = condVal - posMean;
        posMean += posDelta / n;
        posM2 += posDelta * (condVal - posMean);
        const cfgDelta = cfgVal - cfgAdjMean;
        cfgAdjMean += cfgDelta / n;
        cfgAdjM2 += cfgDelta * (cfgVal - cfgAdjMean);
    }
    const posStd = Math.sqrt(Math.max(0, posM2) / Math.max(1, n - 1));
    const cfgAdjStd = Math.sqrt(Math.max(0, cfgAdjM2) / Math.max(1, n - 1));
    const rescale = posStd / (cfgAdjStd + 1e-8);
    for (let i = 0; i < targetLen; i++) {
        const cfgVal = cfgPredBuf[i];
        v[i] = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
    }
    return { v, posStd, cfgAdjStd, rescale };
}

/**
 * 经典 two-pass 实现（原三趟逻辑：pass1 算 cfgVal+sum，pass2 算方差，pass3 rescale）。
 * 返回 { v, posStd, cfgAdjStd, rescale }。
 */
function combineTwoPass(condPred, uncondPred, cfgStrength, cfgRescale) {
    const targetLen = condPred.length;
    const cfgPredBuf = new Float32Array(targetLen);

    // Pass 1: compute cfgVal, posSum, cfgAdjSum
    let posSum = 0, cfgAdjSum = 0;
    for (let i = 0; i < targetLen; i++) {
        const cfgVal = condPred[i] + cfgStrength * (condPred[i] - uncondPred[i]);
        cfgPredBuf[i] = cfgVal;
        posSum += condPred[i];
        cfgAdjSum += cfgVal;
    }
    const posMean = posSum / targetLen;
    const cfgAdjMean = cfgAdjSum / targetLen;

    // Pass 2: two-pass variance (Bessel correction N-1)
    let posVarSum = 0, cfgAdjVarSum = 0;
    for (let i = 0; i < targetLen; i++) {
        const posDiff = condPred[i] - posMean;
        posVarSum += posDiff * posDiff;
        const cfgDiff = cfgPredBuf[i] - cfgAdjMean;
        cfgAdjVarSum += cfgDiff * cfgDiff;
    }
    const posStd = Math.sqrt(posVarSum / Math.max(1, targetLen - 1));
    const cfgAdjStd = Math.sqrt(cfgAdjVarSum / Math.max(1, targetLen - 1));
    const rescale = posStd / (cfgAdjStd + 1e-8);

    // Pass 3: rescale + write
    const v = new Float32Array(targetLen);
    for (let i = 0; i < targetLen; i++) {
        const cfgVal = cfgPredBuf[i];
        v[i] = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
    }
    return { v, posStd, cfgAdjStd, rescale };
}

// 生成随机 Float32Array（确定性 seed，便于回归）
function seededRandom(seed, len) {
    let s = seed;
    const arr = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        // LCG: simple deterministic PRNG
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        arr[i] = (s / 0x7fffffff) * 2 - 1; // range [-1, 1)
    }
    return arr;
}

describe('Task 7: CFG combine Welford vs two-pass', () => {
    // Scalar (std/rescale) comparisons use 1e-7 (Welford is mathematically
    // equivalent and scalar accumulation stays within float32 epsilon).
    // Array element comparisons use 1e-6: Welford online mean vs two-pass
    // batch mean differ by ~2e-7 per element at magnitude ~3-5, which is
    // exactly float32 precision (epsilon ≈ 1.2e-7 * magnitude). 1e-6 is the
    // standard tolerance for float32 numerical equivalence.
    const SCALAR_TOL = 1e-7;
    const ARRAY_TOL = 1e-6;

    it('posStd 一致（随机数据，Bessel N-1）', () => {
        const len = 256;
        const condPred = seededRandom(42, len);
        const uncondPred = seededRandom(99, len);
        const w = combineWelford(condPred, uncondPred, 3.0, 0.6);
        const t = combineTwoPass(condPred, uncondPred, 3.0, 0.6);
        expect(w.posStd).to.be.closeTo(t.posStd, SCALAR_TOL);
    });

    it('cfgAdjStd 一致（随机数据，Bessel N-1）', () => {
        const len = 256;
        const condPred = seededRandom(42, len);
        const uncondPred = seededRandom(99, len);
        const w = combineWelford(condPred, uncondPred, 3.0, 0.6);
        const t = combineTwoPass(condPred, uncondPred, 3.0, 0.6);
        expect(w.cfgAdjStd).to.be.closeTo(t.cfgAdjStd, SCALAR_TOL);
    });

    it('rescale 一致（随机数据）', () => {
        const len = 256;
        const condPred = seededRandom(42, len);
        const uncondPred = seededRandom(99, len);
        const w = combineWelford(condPred, uncondPred, 3.0, 0.6);
        const t = combineTwoPass(condPred, uncondPred, 3.0, 0.6);
        expect(w.rescale).to.be.closeTo(t.rescale, SCALAR_TOL);
    });

    it('最终输出 v 逐元素一致（随机数据）', () => {
        const len = 512;
        const condPred = seededRandom(123, len);
        const uncondPred = seededRandom(456, len);
        const w = combineWelford(condPred, uncondPred, 2.5, 0.6);
        const t = combineTwoPass(condPred, uncondPred, 2.5, 0.6);
        for (let i = 0; i < len; i++) {
            expect(w.v[i]).to.be.closeTo(t.v[i], ARRAY_TOL);
        }
    });

    it('不同 cfgStrength 下输出一致', () => {
        const len = 128;
        const condPred = seededRandom(7, len);
        const uncondPred = seededRandom(14, len);
        for (const cfg of [0.5, 1.0, 2.0, 3.0, 5.0]) {
            const w = combineWelford(condPred, uncondPred, cfg, 0.6);
            const t = combineTwoPass(condPred, uncondPred, cfg, 0.6);
            for (let i = 0; i < len; i++) {
                expect(w.v[i], `cfg=${cfg} idx=${i}`).to.be.closeTo(t.v[i], ARRAY_TOL);
            }
        }
    });

    it('不同 cfgRescale 下输出一致', () => {
        const len = 128;
        const condPred = seededRandom(7, len);
        const uncondPred = seededRandom(14, len);
        for (const rescale of [0.0, 0.3, 0.6, 0.75, 1.0]) {
            const w = combineWelford(condPred, uncondPred, 3.0, rescale);
            const t = combineTwoPass(condPred, uncondPred, 3.0, rescale);
            for (let i = 0; i < len; i++) {
                expect(w.v[i], `rescale=${rescale} idx=${i}`).to.be.closeTo(t.v[i], ARRAY_TOL);
            }
        }
    });

    it('常量数据：std=0，rescale=0，输出 = (1-rescale)*cfgVal', () => {
        const len = 64;
        const condPred = new Float32Array(len).fill(0.5);
        const uncondPred = new Float32Array(len).fill(0.1);
        const cfgStrength = 3.0;
        const cfgRescale = 0.6;
        // cfgVal = 0.5 + 3*(0.5-0.1) = 1.7, posStd=0, cfgAdjStd=0
        // rescale = 0/(0+1e-8) = 0
        // v = 0.6*(1.7*0) + 0.4*1.7 = 0.68
        const w = combineWelford(condPred, uncondPred, cfgStrength, cfgRescale);
        const t = combineTwoPass(condPred, uncondPred, cfgStrength, cfgRescale);
        expect(w.posStd).to.equal(0);
        expect(w.cfgAdjStd).to.equal(0);
        expect(w.rescale).to.be.closeTo(0, 1e-6);
        for (let i = 0; i < len; i++) {
            expect(w.v[i]).to.be.closeTo(0.68, 1e-6);
            expect(w.v[i]).to.be.closeTo(t.v[i], ARRAY_TOL);
        }
    });

    it('cfgRescale=0 时输出 = cfgVal（无 rescale 调整）', () => {
        const len = 100;
        const condPred = seededRandom(55, len);
        const uncondPred = seededRandom(66, len);
        const w = combineWelford(condPred, uncondPred, 3.0, 0.0);
        const t = combineTwoPass(condPred, uncondPred, 3.0, 0.0);
        for (let i = 0; i < len; i++) {
            const expectedCfgVal = condPred[i] + 3.0 * (condPred[i] - uncondPred[i]);
            expect(w.v[i]).to.be.closeTo(expectedCfgVal, ARRAY_TOL);
            expect(w.v[i]).to.be.closeTo(t.v[i], ARRAY_TOL);
        }
    });

    it('cfgRescale=1 时输出 = cfgVal * rescale（纯 rescale）', () => {
        const len = 100;
        const condPred = seededRandom(77, len);
        const uncondPred = seededRandom(88, len);
        const w = combineWelford(condPred, uncondPred, 3.0, 1.0);
        const t = combineTwoPass(condPred, uncondPred, 3.0, 1.0);
        for (let i = 0; i < len; i++) {
            expect(w.v[i]).to.be.closeTo(t.v[i], ARRAY_TOL);
        }
    });

    it('大数组（10000 元素）数值一致', () => {
        const len = 10000;
        const condPred = seededRandom(2024, len);
        const uncondPred = seededRandom(2025, len);
        const w = combineWelford(condPred, uncondPred, 3.0, 0.6);
        const t = combineTwoPass(condPred, uncondPred, 3.0, 0.6);
        for (let i = 0; i < len; i++) {
            expect(w.v[i]).to.be.closeTo(t.v[i], ARRAY_TOL);
        }
        expect(w.rescale).to.be.closeTo(t.rescale, ARRAY_TOL);
    });

    // M8: strengthened statistical robustness — many random seeds, verifying
    // Welford == two-pass across diverse inputs (catches seed-specific
    // numerical drift that a single seed would miss).
    it('多个随机种子下 Welford 与 two-pass 逐元素一致（统计稳健性）', function () { this.timeout(15000);
        const len = 512;
        const cfgStrengths = [0.5, 1.5, 3.0, 5.0];
        const cfgRescales = [0.0, 0.3, 0.6, 1.0];
        let seedPairs = 0;
        // 24 independent (condSeed, uncondSeed) pairs × 4 cfgStrength × 4 cfgRescale
        for (let s = 0; s < 24; s++) {
            const condPred = seededRandom(1000 + s, len);
            const uncondPred = seededRandom(5000 + s * 7, len);
            for (const cfg of cfgStrengths) {
                for (const rescale of cfgRescales) {
                    const w = combineWelford(condPred, uncondPred, cfg, rescale);
                    const t = combineTwoPass(condPred, uncondPred, cfg, rescale);
                    expect(w.rescale, `s=${s} cfg=${cfg} rescale=${rescale}`).to.be.closeTo(t.rescale, SCALAR_TOL);
                    for (let i = 0; i < len; i++) {
                        expect(w.v[i], `s=${s} cfg=${cfg} rescale=${rescale} idx=${i}`).to.be.closeTo(t.v[i], ARRAY_TOL);
                    }
                    seedPairs++;
                }
            }
        }
        // Sanity: ensure we actually ran a meaningful number of combinations.
        expect(seedPairs).to.equal(24 * 4 * 4);
    });

    // M8: edge case — single-element array. Bessel correction uses
    // max(1, n-1) = max(1, 0) = 1, so std = sqrt(M2/1). With one sample the
    // mean equals the sample, delta=0, M2=0 → std=0 → rescale=0.
    it('单元素数组：std=0，rescale=0，输出 = (1-rescale)*cfgVal', () => {
        const condPred = new Float32Array([0.7]);
        const uncondPred = new Float32Array([0.2]);
        const w = combineWelford(condPred, uncondPred, 3.0, 0.6);
        const t = combineTwoPass(condPred, uncondPred, 3.0, 0.6);
        expect(w.posStd).to.equal(0);
        expect(w.cfgAdjStd).to.equal(0);
        expect(w.rescale).to.be.closeTo(0, 1e-6);
        // cfgVal = 0.7 + 3*(0.7-0.2) = 2.2; v = 0.6*0 + 0.4*2.2 = 0.88
        expect(w.v[0]).to.be.closeTo(0.88, 1e-6);
        expect(w.v[0]).to.be.closeTo(t.v[0], ARRAY_TOL);
    });

    // M8: edge case — two-element array (n=2, Bessel N-1 = 1).
    it('两元素数组：Welford 与 two-pass 一致', () => {
        const condPred = new Float32Array([0.3, 0.9]);
        const uncondPred = new Float32Array([0.1, 0.4]);
        const w = combineWelford(condPred, uncondPred, 2.0, 0.5);
        const t = combineTwoPass(condPred, uncondPred, 2.0, 0.5);
        expect(w.posStd).to.be.closeTo(t.posStd, SCALAR_TOL);
        expect(w.cfgAdjStd).to.be.closeTo(t.cfgAdjStd, SCALAR_TOL);
        expect(w.rescale).to.be.closeTo(t.rescale, SCALAR_TOL);
        for (let i = 0; i < 2; i++) {
            expect(w.v[i]).to.be.closeTo(t.v[i], ARRAY_TOL);
        }
    });

    // M8: edge case — large variance (values spanning orders of magnitude).
    // Verifies Welford numeric stability is not lost when M2 accumulates
    // large products.
    it('大动态范围数据（跨数量级）数值一致', () => {
        const len = 256;
        const condPred = new Float32Array(len);
        const uncondPred = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            // Mix tiny and large values to stress the variance accumulator.
            condPred[i] = (i % 2 === 0) ? 1e-4 : 1e2;
            uncondPred[i] = (i % 3 === 0) ? -1e1 : 5e-1;
        }
        const w = combineWelford(condPred, uncondPred, 1.5, 0.6);
        const t = combineTwoPass(condPred, uncondPred, 1.5, 0.6);
        expect(w.rescale).to.be.closeTo(t.rescale, ARRAY_TOL);
        for (let i = 0; i < len; i++) {
            // Large magnitudes → relax tolerance to relative 1e-6 scale.
            const tol = Math.max(ARRAY_TOL, Math.abs(t.v[i]) * 1e-6);
            expect(w.v[i], `idx=${i}`).to.be.closeTo(t.v[i], tol);
        }
    });

    // M8: edge case — uncondPred == condPred → cfgVal == condVal, so
    // cfgAdjStd == posStd → rescale == 1 (modulo epsilon). Output should
    // equal cfgVal regardless of cfgRescale.
    it('uncond == cond → cfgVal == condVal，rescale ≈ 1，输出 = cfgVal', () => {
        const len = 128;
        const condPred = seededRandom(333, len);
        const uncondPred = new Float32Array(condPred); // identical
        const w = combineWelford(condPred, uncondPred, 3.0, 0.6);
        const t = combineTwoPass(condPred, uncondPred, 3.0, 0.6);
        // posStd == cfgAdjStd → rescale ≈ 1
        expect(w.rescale).to.be.closeTo(1.0, 1e-4);
        for (let i = 0; i < len; i++) {
            // cfgVal = condVal + 3*(condVal - condVal) = condVal
            expect(w.v[i]).to.be.closeTo(condPred[i], ARRAY_TOL);
            expect(w.v[i]).to.be.closeTo(t.v[i], ARRAY_TOL);
        }
    });

    // M8: edge case — mixed signs / negative values.
    it('混合正负值：Welford 与 two-pass 一致', () => {
        const len = 300;
        const condPred = new Float32Array(len);
        const uncondPred = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            condPred[i] = Math.sin(i * 0.3) * 2.0; // [-2, 2]
            uncondPred[i] = Math.cos(i * 0.21) * 1.5; // [-1.5, 1.5]
        }
        const w = combineWelford(condPred, uncondPred, 2.0, 0.5);
        const t = combineTwoPass(condPred, uncondPred, 2.0, 0.5);
        expect(w.rescale).to.be.closeTo(t.rescale, SCALAR_TOL);
        for (let i = 0; i < len; i++) {
            expect(w.v[i], `idx=${i}`).to.be.closeTo(t.v[i], ARRAY_TOL);
        }
    });
});
