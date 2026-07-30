const { expect } = require('chai');
const { resolveCfgAtStep, resolveScheduleMode, VALID_MODES, DEFAULT_MODE } = require('../src/inference/pipeline/cfgSchedule');

/**
 * Task 11: CFG 强度曲线调度测试。
 *
 * 验证：
 * 1. constant 模式返回 cfgStrength（与改造前字节级一致）
 * 2. linear 模式：start + (end-start) * step / (totalSteps-1)
 * 3. cosine 模式：start + (end-start) * (1-cos(π*step/(totalSteps-1)))/2
 * 4. custom 模式：keyframes 分段线性插值
 * 5. 默认值：cfgStrengthStart=null → cfgStrength*0.5, cfgStrengthEnd=null → cfgStrength
 * 6. 边界：totalSteps=1 时返回 end
 * 7. 非法 mode 回退到 DEFAULT_MODE
 */
describe('cfgSchedule - Task 11 CFG strength scheduling', () => {
    const CFG = 3.0;
    const TOTAL_STEPS = 32;

    describe('resolveScheduleMode', () => {
        it('should return valid modes as-is', () => {
            for (const m of VALID_MODES) {
                expect(resolveScheduleMode(m)).to.equal(m);
            }
        });

        it('should fall back to DEFAULT_MODE for invalid/missing mode', () => {
            expect(resolveScheduleMode(undefined)).to.equal(DEFAULT_MODE);
            expect(resolveScheduleMode(null)).to.equal(DEFAULT_MODE);
            expect(resolveScheduleMode('invalid')).to.equal(DEFAULT_MODE);
            expect(resolveScheduleMode(123)).to.equal(DEFAULT_MODE);
        });
    });

    describe('constant mode (byte-identical to pre-Task-11)', () => {
        it('should return cfgStrength exactly (no floating point error)', () => {
            for (let step = 0; step < TOTAL_STEPS; step++) {
                const result = resolveCfgAtStep({
                    mode: 'constant', cfgStrength: CFG, step, totalSteps: TOTAL_STEPS,
                });
                expect(result).to.equal(CFG);
            }
        });

        it('should be byte-identical regardless of step/totalSteps', () => {
            // constant mode must NOT perform any arithmetic on cfgStrength
            const r1 = resolveCfgAtStep({ mode: 'constant', cfgStrength: CFG, step: 0, totalSteps: 16 });
            const r2 = resolveCfgAtStep({ mode: 'constant', cfgStrength: CFG, step: 15, totalSteps: 16 });
            const r3 = resolveCfgAtStep({ mode: 'constant', cfgStrength: CFG, step: 100, totalSteps: 200 });
            expect(r1).to.equal(CFG);
            expect(r2).to.equal(CFG);
            expect(r3).to.equal(CFG);
        });
    });

    describe('linear mode', () => {
        it('should compute start + (end-start) * step / (totalSteps-1)', () => {
            const start = 1.5;
            const end = 3.0;
            const totalSteps = 32;
            // step 0 → start
            expect(resolveCfgAtStep({ mode: 'linear', cfgStrength: CFG, cfgStrengthStart: start, cfgStrengthEnd: end, step: 0, totalSteps })).to.be.closeTo(start, 1e-10);
            // step totalSteps-1 → end
            expect(resolveCfgAtStep({ mode: 'linear', cfgStrength: CFG, cfgStrengthStart: start, cfgStrengthEnd: end, step: totalSteps - 1, totalSteps })).to.be.closeTo(end, 1e-10);
            // step 16 → midpoint
            const expected = start + (end - start) * 16 / 31;
            expect(resolveCfgAtStep({ mode: 'linear', cfgStrength: CFG, cfgStrengthStart: start, cfgStrengthEnd: end, step: 16, totalSteps })).to.be.closeTo(expected, 1e-10);
        });

        it('should default start to cfgStrength*0.5 and end to cfgStrength when null', () => {
            const expectedStart = CFG * 0.5;
            const expectedEnd = CFG;
            expect(resolveCfgAtStep({ mode: 'linear', cfgStrength: CFG, cfgStrengthStart: null, cfgStrengthEnd: null, step: 0, totalSteps: TOTAL_STEPS })).to.be.closeTo(expectedStart, 1e-10);
            expect(resolveCfgAtStep({ mode: 'linear', cfgStrength: CFG, cfgStrengthStart: null, cfgStrengthEnd: null, step: TOTAL_STEPS - 1, totalSteps: TOTAL_STEPS })).to.be.closeTo(expectedEnd, 1e-10);
        });
    });

    describe('cosine mode', () => {
        it('should compute start + (end-start) * (1-cos(π*step/(totalSteps-1)))/2', () => {
            const start = 1.0;
            const end = 4.0;
            const totalSteps = 32;
            // step 0 → start (cos(0)=1, (1-1)/2=0)
            expect(resolveCfgAtStep({ mode: 'cosine', cfgStrength: CFG, cfgStrengthStart: start, cfgStrengthEnd: end, step: 0, totalSteps })).to.be.closeTo(start, 1e-10);
            // step totalSteps-1 → end (cos(π)=-1, (1-(-1))/2=1)
            expect(resolveCfgAtStep({ mode: 'cosine', cfgStrength: CFG, cfgStrengthStart: start, cfgStrengthEnd: end, step: totalSteps - 1, totalSteps })).to.be.closeTo(end, 1e-10);
            // step 16 → midpoint (cos(π/2)=0, (1-0)/2=0.5)
            const expected = start + (end - start) * (1 - Math.cos(Math.PI * 16 / 31)) / 2;
            expect(resolveCfgAtStep({ mode: 'cosine', cfgStrength: CFG, cfgStrengthStart: start, cfgStrengthEnd: end, step: 16, totalSteps })).to.be.closeTo(expected, 1e-10);
        });
    });

    describe('custom mode (keyframes)', () => {
        it('should interpolate linearly between keyframes', () => {
            const keyframes = [
                { step: 0, value: 1.0 },
                { step: 16, value: 3.0 },
                { step: 31, value: 2.0 },
            ];
            // step 0 → 1.0
            expect(resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 0, totalSteps: 32 })).to.be.closeTo(1.0, 1e-10);
            // step 16 → 3.0
            expect(resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 16, totalSteps: 32 })).to.be.closeTo(3.0, 1e-10);
            // step 8 → midpoint between 1.0 and 3.0 = 2.0
            expect(resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 8, totalSteps: 32 })).to.be.closeTo(2.0, 1e-10);
            // step 24 → between keyframe 16 (3.0) and 31 (2.0): t=(24-16)/(31-16)=8/15
            // value = 3.0 + (2.0-3.0) * 8/15 = 3.0 - 0.5333... = 2.4667
            const expected24 = 3.0 + (2.0 - 3.0) * (24 - 16) / (31 - 16);
            expect(resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 24, totalSteps: 32 })).to.be.closeTo(expected24, 1e-10);
        });

        it('should clamp to first/last keyframe outside range', () => {
            const keyframes = [
                { step: 5, value: 1.5 },
                { step: 25, value: 3.5 },
            ];
            expect(resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 0, totalSteps: 32 })).to.be.closeTo(1.5, 1e-10);
            expect(resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 31, totalSteps: 32 })).to.be.closeTo(3.5, 1e-10);
        });

        it('should fall back to linear when keyframes empty/null', () => {
            const r1 = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes: null, cfgStrengthStart: 1.0, cfgStrengthEnd: 3.0, step: 0, totalSteps: 32 });
            expect(r1).to.be.closeTo(1.0, 1e-10);
            const r2 = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes: [], cfgStrengthStart: 1.0, cfgStrengthEnd: 3.0, step: 31, totalSteps: 32 });
            expect(r2).to.be.closeTo(3.0, 1e-10);
        });

        it('should handle unsorted keyframes by sorting internally', () => {
            const keyframes = [
                { step: 31, value: 2.0 },
                { step: 0, value: 1.0 },
                { step: 16, value: 3.0 },
            ];
            expect(resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 8, totalSteps: 32 })).to.be.closeTo(2.0, 1e-10);
        });
    });

    describe('edge cases', () => {
        it('should return end when totalSteps <= 1', () => {
            const r = resolveCfgAtStep({ mode: 'linear', cfgStrength: CFG, cfgStrengthStart: 1.0, cfgStrengthEnd: 3.0, step: 0, totalSteps: 1 });
            expect(r).to.equal(3.0);
        });

        it('should clamp step to [0, totalSteps-1]', () => {
            const start = 1.0, end = 3.0;
            const r1 = resolveCfgAtStep({ mode: 'linear', cfgStrength: CFG, cfgStrengthStart: start, cfgStrengthEnd: end, step: -5, totalSteps: 32 });
            expect(r1).to.be.closeTo(start, 1e-10);
            const r2 = resolveCfgAtStep({ mode: 'linear', cfgStrength: CFG, cfgStrengthStart: start, cfgStrengthEnd: end, step: 100, totalSteps: 32 });
            expect(r2).to.be.closeTo(end, 1e-10);
        });

        it('should handle undefined mode (falls back to DEFAULT_MODE=linear)', () => {
            const r = resolveCfgAtStep({ cfgStrength: CFG, cfgStrengthStart: 1.0, cfgStrengthEnd: 3.0, step: 0, totalSteps: 32 });
            expect(r).to.be.closeTo(1.0, 1e-10);
        });
    });

    // M11: keyframe parsing/filtering edge cases.
    //
    // The exportDialog.js UI parses keyframe TEXT ("0:1.5,16:3.0,31:3.0" →
    // [{step,value}]) in DOM event handlers. exportDialog.js does not export
    // those functions and is out of scope for this review-fix pass, so the
    // text→array parsing cannot be unit-tested here without a DOM harness
    // (jsdom is available in devDeps, but the parsing is inline in unexported
    // handlers). Instead we strengthen coverage of the keyframe DATA logic that
    // cfgSchedule.js DOES export: `interpolateKeyframes` (via custom mode)
    // filters invalid entries, sorts, clamps to first/last, and falls back to
    // linear when no valid keyframes remain. These are the edge cases the UI
    // parsing feeds into, so validating them here covers the contract the UI
    // relies on.
    describe('M11: keyframe parsing/filtering edge cases', () => {
        it('should filter out keyframes with non-number step/value', () => {
            const keyframes = [
                { step: 0, value: 1.0 },
                { step: 'bad', value: 2.0 },      // non-number step → filtered
                { step: 16, value: 'nope' },      // non-number value → filtered
                { step: null, value: 3.0 },        // non-number step → filtered
                { step: 31, value: 2.0 },
            ];
            // Valid keyframes: [{0,1.0},{31,2.0}]. step 16 → between → linear
            // interp: 1.0 + (2.0-1.0) * 16/31 ≈ 1.516
            const r = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 16, totalSteps: 32 });
            const expected = 1.0 + (2.0 - 1.0) * 16 / 31;
            expect(r).to.be.closeTo(expected, 1e-10);
        });

        it('should filter out keyframes with NaN/Infinity step/value', () => {
            const keyframes = [
                { step: 0, value: 1.0 },
                { step: NaN, value: 2.0 },         // NaN step → filtered
                { step: 16, value: Infinity },     // Infinity value → filtered
                { step: 31, value: 2.0 },
            ];
            const r = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 16, totalSteps: 32 });
            const expected = 1.0 + (2.0 - 1.0) * 16 / 31;
            expect(r).to.be.closeTo(expected, 1e-10);
        });

        it('should handle a single valid keyframe (clamp to its value)', () => {
            const keyframes = [{ step: 10, value: 1.5 }];
            // step <= 10 → 1.5; step >= 10 → 1.5 (only one keyframe)
            expect(resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 0, totalSteps: 32 })).to.be.closeTo(1.5, 1e-10);
            expect(resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 10, totalSteps: 32 })).to.be.closeTo(1.5, 1e-10);
            expect(resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 31, totalSteps: 32 })).to.be.closeTo(1.5, 1e-10);
        });

        it('should handle duplicate-step keyframes (last one wins via sort stability / boundary check)', () => {
            const keyframes = [
                { step: 0, value: 1.0 },
                { step: 16, value: 3.0 },
                { step: 16, value: 4.0 },  // duplicate step
                { step: 31, value: 2.0 },
            ];
            // At step 16 the boundary check `step >= b.step` lands exactly on
            // the 16-keyframe; both duplicates have step 16. The loop returns
            // b.value when step == b.step within a segment. Either 3.0 or 4.0
            // is acceptable (sort order of equal keys is not guaranteed), so we
            // just assert it equals one of the duplicate values.
            const r = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 16, totalSteps: 32 });
            expect(r === 3.0 || r === 4.0).to.equal(true);
            // Off the duplicate: step 8 → between 0 (1.0) and 16 → 1.0 + (v16-1.0)*0.5
            const r8 = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 8, totalSteps: 32 });
            const v16 = r; // value at step 16
            expect(r8).to.be.closeTo(1.0 + (v16 - 1.0) * 0.5, 1e-10);
        });

        it('should fall back to linear when all keyframes are invalid', () => {
            const keyframes = [
                { step: 'x', value: 1.0 },
                { step: 16, value: null },
                { step: NaN, value: undefined },
            ];
            // No valid keyframes → interpolateKeyframes falls back to linear.
            const r = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, cfgStrengthStart: 1.0, cfgStrengthEnd: 3.0, step: 0, totalSteps: 32 });
            expect(r).to.be.closeTo(1.0, 1e-10);
            const rEnd = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, cfgStrengthStart: 1.0, cfgStrengthEnd: 3.0, step: 31, totalSteps: 32 });
            expect(rEnd).to.be.closeTo(3.0, 1e-10);
        });

        it('should handle keyframes with non-integer steps (fractional boundaries)', () => {
            const keyframes = [
                { step: 0, value: 1.0 },
                { step: 15.5, value: 2.5 },
                { step: 31, value: 3.0 },
            ];
            // step 8 → between 0 and 15.5: t = 8/15.5; v = 1 + 1.5*8/15.5
            const r8 = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 8, totalSteps: 32 });
            expect(r8).to.be.closeTo(1.0 + 1.5 * 8 / 15.5, 1e-10);
            // step 20 → between 15.5 and 31: t = (20-15.5)/(31-15.5) = 4.5/15.5
            const r20 = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 20, totalSteps: 32 });
            expect(r20).to.be.closeTo(2.5 + (3.0 - 2.5) * 4.5 / 15.5, 1e-10);
        });

        it('should ignore null/undefined entries in the keyframes array', () => {
            const keyframes = [
                { step: 0, value: 1.0 },
                null,
                undefined,
                { step: 31, value: 2.0 },
            ];
            const r = resolveCfgAtStep({ mode: 'custom', cfgStrength: CFG, keyframes, step: 16, totalSteps: 32 });
            expect(r).to.be.closeTo(1.0 + (2.0 - 1.0) * 16 / 31, 1e-10);
        });
    });

    describe('integration: monotonic increase for linear/cosine defaults', () => {
        it('linear mode with default start/end should be monotonically increasing', () => {
            let prev = -Infinity;
            for (let step = 0; step < TOTAL_STEPS; step++) {
                const v = resolveCfgAtStep({ mode: 'linear', cfgStrength: CFG, cfgStrengthStart: null, cfgStrengthEnd: null, step, totalSteps: TOTAL_STEPS });
                expect(v).to.be.at.least(prev);
                prev = v;
            }
            // Final value should equal CFG
            expect(prev).to.be.closeTo(CFG, 1e-10);
        });

        it('cosine mode with default start/end should be monotonically increasing', () => {
            let prev = -Infinity;
            for (let step = 0; step < TOTAL_STEPS; step++) {
                const v = resolveCfgAtStep({ mode: 'cosine', cfgStrength: CFG, cfgStrengthStart: null, cfgStrengthEnd: null, step, totalSteps: TOTAL_STEPS });
                expect(v).to.be.at.least(prev);
                prev = v;
            }
            expect(prev).to.be.closeTo(CFG, 1e-10);
        });
    });
});
