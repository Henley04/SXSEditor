const { expect } = require('chai');
const { Postprocessing } = require('../src/inference/pipeline/postprocessing');
const {
  MEL_DIM,
  HOP_SIZE,
  VOCODER_CHUNK_FRAMES,
  VOCODER_OVERLAP_FRAMES,
} = require('../src/inference/pipeline/constants');

/**
 * 针对 runVocoderChunked 分块循环终止逻辑的回归测试。
 *
 * 背景：旧实现的 framePos 推进规则 `chunkIdx === 0 ? chunkEnd : chunkEnd - overlapFrames`
 * 在末尾 chunk（chunkEnd 被 totalFrames 截断）时会反复回退导致死循环。
 * 几乎所有 > chunkSize 帧的音频都会触发。本测试用 mock vocoder 覆盖边界条件，
 * 确保循环正常终止、chunk 数量正确、输出长度正确。
 */
describe('Postprocessing.runVocoderChunked - 分块循环终止回归测试', () => {
  let pp;
  let runCalls;

  beforeEach(() => {
    pp = new Postprocessing();
    runCalls = [];
  });

  // 构造 mock sessions：记录每次 vocoder.run 的输入帧数，返回对应长度的波形。
  // 默认填充 0.5（非零），因为 validateVocoderOutput 会拦截全零输出（DML silent failure）。
  // createFloatTensor 会创建真实 ort.Tensor（仅构造，不触发推理），mock run 通过 inputs.mel.dims 取帧数。
  function makeSessions(fillValue = 0.5) {
    return {
      vocoder: {
        async run(inputs) {
          const vocSeqLen = inputs.mel.dims[1];
          runCalls.push({ vocSeqLen });
          const waveLen = vocSeqLen * HOP_SIZE;
          const data = new Float32Array(waveLen);
          data.fill(fillValue);
          return { waveform: { type: 'float32', data } };
        },
      },
    };
  }

  it('totalFrames = chunkSize（边界，走提前 return 分支，单次推理）', async () => {
    const totalFrames = VOCODER_CHUNK_FRAMES; // 1008
    const melData = new Float32Array(totalFrames * MEL_DIM);
    const out = await pp.runVocoderChunked(
      makeSessions(), melData, totalFrames, false, false, 'default', null, false
    );
    expect(runCalls).to.have.lengthOf(1);
    expect(out.length).to.equal(totalFrames * HOP_SIZE);
  });

  it('totalFrames = chunkSize + 1（刚触发分块，2 个 chunk，无死循环）', async () => {
    const totalFrames = VOCODER_CHUNK_FRAMES + 1; // 1009
    const melData = new Float32Array(totalFrames * MEL_DIM);
    const out = await pp.runVocoderChunked(
      makeSessions(), melData, totalFrames, false, false, 'default', null, false
    );
    // chunk 0: [0, 1008) framePos→1008；chunk 1: [1000, 1009) isLast→break
    expect(runCalls).to.have.lengthOf(2);
    expect(out.length).to.equal(totalFrames * HOP_SIZE);
  });

  it('totalFrames = 2 * chunkSize（步长 1000 不整除 2016，3 个 chunk）', async () => {
    const totalFrames = VOCODER_CHUNK_FRAMES * 2; // 2016
    const melData = new Float32Array(totalFrames * MEL_DIM);
    const out = await pp.runVocoderChunked(
      makeSessions(), melData, totalFrames, false, false, 'default', null, false
    );
    // chunk 推进步长 = chunkSize - overlap = 1000（非 1008），2016 不能被 1000 整除：
    // chunk 0: [0, 1008)    framePos→1008
    // chunk 1: [1000, 2008) framePos→2008（2008 < 2016，非末尾）
    // chunk 2: [2000, 2016) isLast→break
    expect(runCalls).to.have.lengthOf(3);
    expect(out.length).to.equal(totalFrames * HOP_SIZE);
  });

  it('totalFrames = chunkSize + step（步长整除情形，2 个 chunk）', async () => {
    // T = 1008 + 1000 = 2008，使 (T - 1008) 正好被 step=1000 整除
    const totalFrames = VOCODER_CHUNK_FRAMES + (VOCODER_CHUNK_FRAMES - VOCODER_OVERLAP_FRAMES); // 2008
    const melData = new Float32Array(totalFrames * MEL_DIM);
    const out = await pp.runVocoderChunked(
      makeSessions(), melData, totalFrames, false, false, 'default', null, false
    );
    // chunk 0: [0, 1008)    framePos→1008
    // chunk 1: [1000, 2008) chunkEnd=2008>=2008 isLast→break
    expect(runCalls).to.have.lengthOf(2);
    expect(out.length).to.equal(totalFrames * HOP_SIZE);
  });

  it('totalFrames = 2 * chunkSize + 1（3 个 chunk）', async () => {
    const totalFrames = VOCODER_CHUNK_FRAMES * 2 + 1; // 2017
    const melData = new Float32Array(totalFrames * MEL_DIM);
    const out = await pp.runVocoderChunked(
      makeSessions(), melData, totalFrames, false, false, 'default', null, false
    );
    // chunk 0: [0, 1008) framePos→1008
    // chunk 1: [1000, 2008) framePos→2008
    // chunk 2: [2000, 2017) isLast→break
    expect(runCalls).to.have.lengthOf(3);
    expect(out.length).to.equal(totalFrames * HOP_SIZE);
  });

  it('totalFrames = 5000（多个 chunk，无死循环）', async () => {
    const totalFrames = 5000;
    const melData = new Float32Array(totalFrames * MEL_DIM);
    const out = await pp.runVocoderChunked(
      makeSessions(), melData, totalFrames, false, false, 'default', null, false
    );
    // 每 chunk 推进 1000 帧（chunkSize - overlap = 1000）
    // chunk 0: [0, 1008)    -> framePos=1008
    // chunk 1: [1000, 2008) -> framePos=2008
    // chunk 2: [2000, 3008) -> framePos=3008
    // chunk 3: [3000, 4008) -> framePos=4008
    // chunk 4: [4000, 5000) isLast -> break
    expect(runCalls).to.have.lengthOf(5);
    expect(out.length).to.equal(totalFrames * HOP_SIZE);
  });

  it('所有样本都被写入（weightSum > 0，归一化后无零样本）', async () => {
    const totalFrames = VOCODER_CHUNK_FRAMES * 2 + 1; // 2017
    const melData = new Float32Array(totalFrames * MEL_DIM);
    const out = await pp.runVocoderChunked(
      makeSessions(0.5), melData, totalFrames, false, false, 'default', null, false
    );
    expect(out.length).to.equal(totalFrames * HOP_SIZE);
    let zeroCount = 0;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i]) < 1e-8) zeroCount++;
    }
    // 所有样本应被至少一个 chunk 覆盖，归一化后非零
    expect(zeroCount).to.equal(0);
  });

  it('chunk 数量上限保护：极大 totalFrames 也能在有限步内终止', async () => {
    // 100000 帧 ≈ 33 分钟音频，旧逻辑会死循环；新逻辑应产生有限 chunk 数
    const totalFrames = 100000;
    const melData = new Float32Array(totalFrames * MEL_DIM);
    const out = await pp.runVocoderChunked(
      makeSessions(), melData, totalFrames, false, false, 'default', null, false
    );
    // 每 chunk 推进 1000 帧（首 chunk 推进 1008），预期 chunk 数 ≈ ceil((100000-1008)/1000) + 1 = 100
    expect(runCalls.length).to.be.lessThan(200);
    expect(runCalls.length).to.be.greaterThan(90);
    expect(out.length).to.equal(totalFrames * HOP_SIZE);
  });

  it('全零输出应抛错（DML silent failure 边界保护）', async () => {
    const totalFrames = VOCODER_CHUNK_FRAMES;
    const melData = new Float32Array(totalFrames * MEL_DIM);
    // fillValue=0.0 模拟 DML 显存耗尽后的 silent failure（返回全零波形不抛错）
    let thrownErr = null;
    try {
      await pp.runVocoderChunked(
        makeSessions(0.0), melData, totalFrames, false, false, 'default', null, false
      );
    } catch (e) {
      thrownErr = e;
    }
    expect(thrownErr).to.not.be.null;
    expect(thrownErr.message).to.match(/all-zero|empty waveform/i);
  });

  it('NaN 输出应抛错（GPU device removed 边界保护）', async () => {
    const totalFrames = VOCODER_CHUNK_FRAMES;
    const melData = new Float32Array(totalFrames * MEL_DIM);
    // fillValue=NaN 模拟 GPU device removed 后的 NaN 输出
    let thrownErr = null;
    try {
      await pp.runVocoderChunked(
        makeSessions(NaN), melData, totalFrames, false, false, 'default', null, false
      );
    } catch (e) {
      thrownErr = e;
    }
    expect(thrownErr).to.not.be.null;
    expect(thrownErr.message).to.match(/nan/i);
  });
});
