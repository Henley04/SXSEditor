const { expect } = require('chai');
const { Diffusion } = require('../src/inference/pipeline/diffusion');
const { MEL_DIM, COND_DIM } = require('../src/inference/pipeline/constants');

/**
 * runDiffusionLoopChunked 分块推理回归测试。
 *
 * 验证：
 * 1. 分块数量正确（totalFrames > chunkFrames 时分块，<= 时不分块）
 * 2. 推理调用次数 = chunks × steps × (cfgStrength > 0 ? 2 : 1)
 * 3. 输出长度 = totalFrames × MEL_DIM
 * 4. 重叠区交叉淡入淡出不产生 NaN
 * 5. 边界条件：chunkFrames >= totalFrames 时回退整段推理
 */
describe('Diffusion.runDiffusionLoopChunked - 分块扩散推理测试', () => {
  let diffusion;
  let runCalls;

  beforeEach(() => {
    diffusion = new Diffusion();
    runCalls = [];
  });

  // 构造 mock sessions：记录每次 diffStep.run 的输入 seqLen，返回对应长度的 flow_pred。
  // flow_pred 填充 0.01（非零），使扩散更新产生有限值。
  function makeSessions(fillValue = 0.01) {
    return {
      diffStep: {
        inputMetadata: [
          { name: 'xt_input', type: 'float32', shape: [1, -1, MEL_DIM] },
          { name: 't', type: 'float32', shape: [1] },
          { name: 'cond', type: 'float32', shape: [1, -1, COND_DIM] },
          { name: 'xt_mask', type: 'float32', shape: [1, -1] },
        ],
        async run(inputs) {
          const seqLen = inputs.xt_input.dims[1];
          runCalls.push({ seqLen });
          const data = new Float32Array(seqLen * MEL_DIM);
          data.fill(fillValue);
          return {
            flow_pred: {
              type: 'float32',
              data,
              dims: [1, seqLen, MEL_DIM],
              dispose() {},
            },
          };
        },
      },
    };
  }

  it('chunkFrames >= totalFrames 时回退整段推理（单次循环）', async () => {
    const totalFrames = 100;
    const ptFrameCount = 10;
    const chunkFrames = 200; // > totalFrames
    const overlapFrames = 20;
    const totalSteps = 2;
    const cfgStrength = 0; // 1 run/step

    const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
    const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
    const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

    await diffusion.runDiffusionLoopChunked(
      makeSessions(), xt, totalFrames, ptMelData, ptFrameCount,
      combinedCond, totalSteps, cfgStrength, 0.75, false,
      () => {}, 0, 100, false, chunkFrames, overlapFrames
    );

    // 回退到整段：1 chunk × 2 steps × 1 run (cfg=0) = 2 runs
    expect(runCalls).to.have.lengthOf(2);
    // 输出长度不变
    expect(xt.data.length).to.equal(totalFrames * MEL_DIM);
  });

  it('totalFrames = 2 * chunkFrames, overlap > 0 时产生 3 个分块', async () => {
    const totalFrames = 200;
    const ptFrameCount = 10;
    const chunkFrames = 100;
    const overlapFrames = 20;
    const totalSteps = 2;
    const cfgStrength = 0;

    const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
    const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
    const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

    await diffusion.runDiffusionLoopChunked(
      makeSessions(), xt, totalFrames, ptMelData, ptFrameCount,
      combinedCond, totalSteps, cfgStrength, 0.75, false,
      () => {}, 0, 100, false, chunkFrames, overlapFrames
    );

    // 步长 = chunkFrames - overlap = 80
    // chunk 0: [0,100), chunk 1: [80,180), chunk 2: [160,200) → 3 chunks
    // 3 chunks × 2 steps × 1 run (cfg=0) = 6 runs
    expect(runCalls).to.have.lengthOf(6);
    expect(xt.data.length).to.equal(totalFrames * MEL_DIM);
    // 输出不应包含 NaN
    let nanCount = 0;
    for (let i = 0; i < xt.data.length; i++) {
      if (Number.isNaN(xt.data[i])) nanCount++;
    }
    expect(nanCount).to.equal(0);
  });

  it('CFG > 0 时每个 step 产生 2 次推理（cond + uncond）', async () => {
    const totalFrames = 250;
    const ptFrameCount = 10;
    const chunkFrames = 100;
    const overlapFrames = 20;
    const totalSteps = 2;
    const cfgStrength = 3.0; // CFG on → 2 runs/step

    const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
    const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
    const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

    await diffusion.runDiffusionLoopChunked(
      makeSessions(), xt, totalFrames, ptMelData, ptFrameCount,
      combinedCond, totalSteps, cfgStrength, 0.75, false,
      () => {}, 0, 100, false, chunkFrames, overlapFrames
    );

    // chunk 0: [0,100), chunk 1: [80,180), chunk 2: [160,250) → 3 chunks
    // 3 chunks × 2 steps × 2 runs (cfg>0) = 12 runs
    expect(runCalls).to.have.lengthOf(12);
    expect(xt.data.length).to.equal(totalFrames * MEL_DIM);
  });

  it('overlapFrames = 0 时不重叠（直接覆盖）', async () => {
    const totalFrames = 200;
    const ptFrameCount = 10;
    const chunkFrames = 100;
    const overlapFrames = 0;
    const totalSteps = 1;
    const cfgStrength = 0;

    const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
    const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
    const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

    await diffusion.runDiffusionLoopChunked(
      makeSessions(), xt, totalFrames, ptMelData, ptFrameCount,
      combinedCond, totalSteps, cfgStrength, 0.75, false,
      () => {}, 0, 100, false, chunkFrames, overlapFrames
    );

    // chunk 0: [0,100), chunk 1: [100,200) → 2 chunks, no overlap
    expect(runCalls).to.have.lengthOf(2);
    expect(xt.data.length).to.equal(totalFrames * MEL_DIM);
  });

  it('末尾 chunk 不足 chunkFrames 时正确截断', async () => {
    const totalFrames = 250;
    const ptFrameCount = 10;
    const chunkFrames = 100;
    const overlapFrames = 20;
    const totalSteps = 1;
    const cfgStrength = 0;

    const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
    const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
    const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

    await diffusion.runDiffusionLoopChunked(
      makeSessions(), xt, totalFrames, ptMelData, ptFrameCount,
      combinedCond, totalSteps, cfgStrength, 0.75, false,
      () => {}, 0, 100, false, chunkFrames, overlapFrames
    );

    // chunk 0: [0,100), chunk 1: [80,180), chunk 2: [160,250) → 3 chunks
    // 末尾 chunk 仅 90 帧 < chunkFrames=100
    expect(runCalls).to.have.lengthOf(3);
    // 验证每次 run 的 seqLen = ptFrameCount + chunkFrames（末尾更小）
    // cond 分支：seqLen = pt + chunkFrames; uncond 分支：seqLen = chunkFrames
    // cfg=0 时只有 cond 分支
    expect(runCalls[0].seqLen).to.equal(ptFrameCount + 100);
    expect(runCalls[1].seqLen).to.equal(ptFrameCount + 100);
    expect(runCalls[2].seqLen).to.equal(ptFrameCount + 90); // 末尾截断
    expect(xt.data.length).to.equal(totalFrames * MEL_DIM);
  });

  it('overlap >= chunkFrames 时自动限制为 chunkFrames/2', async () => {
    const totalFrames = 300;
    const ptFrameCount = 10;
    const chunkFrames = 100;
    const overlapFrames = 150; // > chunkFrames, 应被限制为 50
    const totalSteps = 1;
    const cfgStrength = 0;

    const xt = diffusion.randomNoise(totalFrames, MEL_DIM);
    const ptMelData = new Float32Array(ptFrameCount * MEL_DIM).fill(0.1);
    const combinedCond = new Float32Array((ptFrameCount + totalFrames) * COND_DIM).fill(0.1);

    await diffusion.runDiffusionLoopChunked(
      makeSessions(), xt, totalFrames, ptMelData, ptFrameCount,
      combinedCond, totalSteps, cfgStrength, 0.75, false,
      () => {}, 0, 100, false, chunkFrames, overlapFrames
    );

    // overlap 被限制为 50，步长 = 100 - 50 = 50
    // chunk 0: [0,100), chunk 1: [50,150), chunk 2: [100,200), chunk 3: [150,250), chunk 4: [200,300)
    // → 5 chunks
    expect(runCalls).to.have.lengthOf(5);
    expect(xt.data.length).to.equal(totalFrames * MEL_DIM);
    let nanCount = 0;
    for (let i = 0; i < xt.data.length; i++) {
      if (Number.isNaN(xt.data[i])) nanCount++;
    }
    expect(nanCount).to.equal(0);
  });
});
