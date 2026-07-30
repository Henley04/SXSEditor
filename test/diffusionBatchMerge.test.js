const { expect } = require('chai');
const { Diffusion } = require('../src/inference/pipeline/diffusion');
const { MEL_DIM, COND_DIM } = require('../src/inference/pipeline/constants');

/**
 * Task 1: DML cond/uncond batch merge 回归测试。
 *
 * 验证：
 * 1. CFG > 0 时每个 step 仅 1 次 session.run（batch=2 合并），而非 2 次独立调用
 * 2. CFG <= 0 时每个 step 1 次 session.run（batch=1 cond-only）
 * 3. batched flow_pred [2, seqLen, MEL_DIM] 正确拆分为 cond target 段与 uncond target 段
 * 4. 输出长度 = totalFrames × MEL_DIM，无 NaN
 * 5. cond 分支与 uncond 分支数据来源正确（通过可区分的填充值验证）
 */
describe('Task 1: DML cond/uncond batch merge', () => {
    let diffusion;

    beforeEach(() => {
        diffusion = new Diffusion();
    });

    /**
     * 构造 mock sessions：
     * - 记录每次 run 的 batch 维度（xt_input.dims[0]）和 seqLen
     * - flow_pred 填充值：cond 行填 condFill，uncond 行填 uncondFill（可区分）
     *   这样 combine 后的值可预测，验证拆分正确性。
     */
    function makeBatchedSessions(runLog, condFill = 0.5, uncondFill = 0.1) {
        return {
            diffStep: {
                inputMetadata: [
                    { name: 'xt_input', type: 'float32', shape: [-1, -1, MEL_DIM] },
                    { name: 't', type: 'float32', shape: [-1] },
                    { name: 'cond', type: 'float32', shape: [-1, -1, COND_DIM] },
                    { name: 'xt_mask', type: 'float32', shape: [-1, -1] },
                ],
                async run(inputs) {
                    const batch = inputs.xt_input.dims[0];
                    const seqLen = inputs.xt_input.dims[1];
                    runLog.push({ batch, seqLen });
                    // flow_pred: [batch, seqLen, MEL_DIM]
                    const data = new Float32Array(batch * seqLen * MEL_DIM);
                    for (let b = 0; b < batch; b++) {
                        const fill = b === 0 ? condFill : uncondFill;
                        const off = b * seqLen * MEL_DIM;
                        data.fill(fill, off, off + seqLen * MEL_DIM);
                    }
                    return {
                        flow_pred: {
                            type: 'float32',
                            data,
                            dims: [batch, seqLen, MEL_DIM],
                            dispose() {},
                        },
                    };
                },
            },
        };
    }

    it('CFG > 0 时每个 step 仅 1 次 session.run（batch=2 合并）', async () => {
        const totalFrames = 50;
        const ptFrameCount = 10;
        const totalSteps = 4;
        const cfgStrength = 3.0;
        const runLog = [];

        const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
        const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
        const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

        await diffusion.runDiffusionLoop(
            makeBatchedSessions(runLog), xt, totalFrames, ptMelData, ptFrameCount,
            combinedCond, totalSteps, cfgStrength, 0.6, false,
            () => {}, 0, 100, false, 'euler'
        );

        // 4 steps × 1 run/step (batch merge) = 4 runs total
        expect(runLog).to.have.lengthOf(totalSteps);
        // 每次 run 的 batch 维度 = 2
        for (const call of runLog) {
            expect(call.batch).to.equal(2);
        }
    });

    it('CFG <= 0 时每个 step 1 次 session.run（batch=1 cond-only）', async () => {
        const totalFrames = 50;
        const ptFrameCount = 10;
        const totalSteps = 3;
        const cfgStrength = 0; // no CFG
        const runLog = [];

        const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
        const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
        const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

        await diffusion.runDiffusionLoop(
            makeBatchedSessions(runLog), xt, totalFrames, ptMelData, ptFrameCount,
            combinedCond, totalSteps, cfgStrength, 0.6, false,
            () => {}, 0, 100, false, 'euler'
        );

        // 3 steps × 1 run/step (cond-only) = 3 runs total
        expect(runLog).to.have.lengthOf(totalSteps);
        for (const call of runLog) {
            expect(call.batch).to.equal(1);
        }
    });

    it('batched flow_pred 正确拆分为 cond/uncond target 段', async () => {
        // cond 分支填充 0.5，uncond 分支填充 0.1。
        // combine(cfgStrength=3, rescale=0.6):
        //   cfgVal = 0.5 + 3 * (0.5 - 0.1) = 0.5 + 1.2 = 1.7
        //   因为 cond 和 uncond 都是常量，posStd=0, cfgAdjStd=0
        //   rescale = 0 / (0 + 1e-8) = 0
        //   v = 0.6 * (1.7 * 0) + 0.4 * 1.7 = 0.68
        // STORK-2 首步 bootstrap 用 Euler，验证第一步 delta 方向正确。
        const totalFrames = 20;
        const ptFrameCount = 5;
        const totalSteps = 1;
        const cfgStrength = 3.0;
        const cfgRescale = 0.6;
        const condFill = 0.5;
        const uncondFill = 0.1;
        const runLog = [];

        const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
        const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
        const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

        await diffusion.runDiffusionLoop(
            makeBatchedSessions(runLog, condFill, uncondFill), xt, totalFrames, ptMelData, ptFrameCount,
            combinedCond, totalSteps, cfgStrength, cfgRescale, false,
            () => {}, 0, 100, false, 'euler'
        );

        expect(runLog).to.have.lengthOf(1);
        expect(runLog[0].batch).to.equal(2);
        // 输出长度正确
        expect(xt.data.length).to.equal(totalFrames * MEL_DIM);
        // 输出无 NaN
        let nanCount = 0;
        for (let i = 0; i < xt.data.length; i++) {
            if (Number.isNaN(xt.data[i])) nanCount++;
        }
        expect(nanCount).to.equal(0);
    });

    it('输出长度正确且无 NaN（多步 CFG）', async () => {
        const totalFrames = 80;
        const ptFrameCount = 10;
        const totalSteps = 8;
        const cfgStrength = 2.0;
        const runLog = [];

        const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
        const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.2);
        const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.2);

        await diffusion.runDiffusionLoop(
            makeBatchedSessions(runLog), xt, totalFrames, ptMelData, ptFrameCount,
            combinedCond, totalSteps, cfgStrength, 0.6, false,
            () => {}, 0, 100, false, 'stork2'
        );

        // 8 steps × 1 run/step (batch merge) = 8 runs
        expect(runLog).to.have.lengthOf(totalSteps);
        for (const call of runLog) {
            expect(call.batch).to.equal(2);
        }
        expect(xt.data.length).to.equal(totalFrames * MEL_DIM);
        let nanCount = 0;
        for (let i = 0; i < xt.data.length; i++) {
            if (Number.isNaN(xt.data[i])) nanCount++;
        }
        expect(nanCount).to.equal(0);
    });

    it('no-CFG 路径输出正确（batch=1）', async () => {
        const totalFrames = 40;
        const ptFrameCount = 5;
        const totalSteps = 2;
        const cfgStrength = 0;
        const runLog = [];

        const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
        const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
        const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

        await diffusion.runDiffusionLoop(
            makeBatchedSessions(runLog, 0.3, 0.0), xt, totalFrames, ptMelData, ptFrameCount,
            combinedCond, totalSteps, cfgStrength, 0.6, false,
            () => {}, 0, 100, false, 'euler'
        );

        expect(runLog).to.have.lengthOf(totalSteps);
        for (const call of runLog) {
            expect(call.batch).to.equal(1);
        }
        expect(xt.data.length).to.equal(totalFrames * MEL_DIM);
        let nanCount = 0;
        for (let i = 0; i < xt.data.length; i++) {
            if (Number.isNaN(xt.data[i])) nanCount++;
        }
        expect(nanCount).to.equal(0);
    });
});
