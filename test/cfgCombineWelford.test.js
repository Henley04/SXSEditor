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
});
