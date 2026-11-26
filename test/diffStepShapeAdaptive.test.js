const { expect } = require('chai');
// 与 vocoderPrecisionDetection.test.js 同源：本文件会连带加载 onnxruntime-node，
// CI 上原生模块不可用时应整体跳过而不是让 job 崩在收集阶段。
let OnnxSVSPipeline = null;
let ortLoadable = true;
try {
  require('onnxruntime-node');
  ({ OnnxSVSPipeline } = require('../src/inference/pipeline'));
} catch (err) {
  ortLoadable = false;
  console.warn(`[test] 跳过 diffStepShapeAdaptive：onnxruntime-node 不可用（${err && err.message}）`);
}

/**
 * diff_step 形状自适应回归测试。
 *
 * 背景：int8 / int8-npu 的**基础模型**（note_*_encoder / f0_encoder / preflow /
 * cond_emb / mel_transform）是静态 [1, NPU_STATIC_SEQ_LEN] 上图，而 int8 v2
 * （W8A32）的 **diff_step** 是动态导出 —— 同一个目录里两种形状并存。
 *
 * 曾经用一个 useStaticShapes 同时管这两件事，两个方向都会错：
 *   · 动态 diff_step 被按静态 pad 到 2048 → 白算 + 长片段被钳尾丢内容；
 *   · 反过来把 useStaticShapes 关掉去适配 diff_step → 静态 encoder 收到 [1,13]
 *     直接报 “Got: 13 Expected: 2048”（int8 v2 首次端到端验证就撞到这条）。
 *
 * 现在的契约：
 *   useStaticShapes        = 基础模型是否静态（决定 encoder padding 与 2048 分段/钳制）
 *   diffStepStaticShapes   = diff_step 是否静态（只决定 diffusion 的 padding）
 * 判定一律以模型签名为准，非 int8/int8-npu 精度不参与调整。
 */
const describeOrSkip = ortLoadable ? describe : describe.skip;

function session(shape, type = 'float32') {
  return {
    inputNames: ['xt_input', 't', 'cond', 'xt_mask'],
    inputMetadata: [
      { name: 'xt_input', isTensor: true, type, shape },
      { name: 't', isTensor: true, type: 'float32', shape: [] },
      { name: 'cond', isTensor: true, type, shape: [1, shape && shape[1], 1024] },
      { name: 'xt_mask', isTensor: true, type: 'bool', shape: [1, shape && shape[1]] },
    ],
  };
}

describeOrSkip('diff_step 形状自适应（与基础模型分开判定）', () => {
  it('int8 + 动态 diff_step → 只关 diffStepStaticShapes，基础模型仍按静态填充', () => {
    const p = new OnnxSVSPipeline('/fake/model/dir/', { modelPrecision: 'int8' });
    expect(p.useStaticShapes).to.equal(true, '基础模型仍是静态 2048');
    expect(p.diffStepStaticShapes).to.equal(true, '构造期先跟随 useStaticShapes');
    p.sessions = { diffStep: session([1, -1, 128]) };
    p._detectDiffStepPrecision();
    expect(p.diffStepStaticShapes).to.equal(false, 'diff_step 动态，不能再 pad 到 2048');
    // 关键：不能连带关掉基础模型的静态处理，否则 encoder 会收到短序列
    expect(p.useStaticShapes).to.equal(true);
    expect(p.diffStepLegacyInt8Incompatible).to.equal(false);
  });

  it('int8 + 静态 [1,2048,128] 签名 → 两个标志都保持开启（旧 v1 模型）', () => {
    const p = new OnnxSVSPipeline('/fake/model/dir/', { modelPrecision: 'int8' });
    p.sessions = { diffStep: session([1, 2048, 128]) };
    p._detectDiffStepPrecision();
    expect(p.diffStepStaticShapes).to.equal(true);
    expect(p.useStaticShapes).to.equal(true);
  });

  it('int8-npu + 静态签名 → 保持开启', () => {
    const p = new OnnxSVSPipeline('/fake/model/dir/', { modelPrecision: 'int8-npu' });
    p.sessions = { diffStep: session([1, 2048, 128]) };
    p._detectDiffStepPrecision();
    expect(p.diffStepStaticShapes).to.equal(true);
    expect(p.useStaticShapes).to.equal(true);
  });

  it('int8 旧模型（legacy 签名 + cond=512）仍置不兼容标志', () => {
    const p = new OnnxSVSPipeline('/fake/model/dir/', { modelPrecision: 'int8' });
    const s = session([1, 2048, 128]);
    s.inputMetadata[2].shape = [1, 2048, 512];
    p.sessions = { diffStep: s };
    p._detectDiffStepPrecision();
    expect(p.diffStepLegacyInt8Incompatible).to.equal(true);
  });

  it('fp16 不受形状自适应影响', () => {
    const p = new OnnxSVSPipeline('/fake/model/dir/', { modelPrecision: 'fp16' });
    const p2 = new OnnxSVSPipeline('/fake/model/dir/', { modelPrecision: 'fp16' });
    expect(p.useStaticShapes).to.equal(false);
    expect(p.diffStepStaticShapes).to.equal(false);
    p2.sessions = { diffStep: session([1, 2048, 128], 'float16') };
    p2._detectDiffStepPrecision();
    expect(p2.useStaticShapes).to.equal(false);
    expect(p2.diffStepStaticShapes).to.equal(false, 'fp32/fp16 不参与形状自适应');
    expect(p2.diffStepIsFP16).to.equal(true);
  });

  it('没有 diffStep 会话时回落到基础模型标志（避免残留旧值）', () => {
    const p = new OnnxSVSPipeline('/fake/model/dir/', { modelPrecision: 'int8' });
    p.diffStepStaticShapes = false;   // 模拟上一次加载动态模型后的残留
    p.sessions = {};
    p._detectDiffStepPrecision();
    expect(p.diffStepStaticShapes).to.equal(p.useStaticShapes);
  });
});
