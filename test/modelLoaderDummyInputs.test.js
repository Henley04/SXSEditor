// modelLoader 的 DUMMY_TEST_INPUTS 纯 JS 校验（不需要 GPU / ONNX 模型文件）。
//
// 从 onnxModelLoading.test.js 拆出：那里的 15 条用例全部要加载真实 ONNX 模型并走
// DML EP，因此 `npm run test:ci` 用 --ignore 整文件跳过；但本文件只读取
// DUMMY_TEST_INPUTS_FP32 的对象键名，不建 session、不做推理、不碰磁盘模型，
// 属于纯 JS 校验，应当留在 CI 里跑。
//
// 运行方式:
//   npx mocha --require ./test/setup.js "test/modelLoaderDummyInputs.test.js" --timeout 30000

const { expect } = require('chai');

describe('modelLoader DUMMY_TEST_INPUTS', () => {
  let DUMMY_TEST_INPUTS_FP32;

  before(() => {
    // modelLoader.js 依赖 electron / systeminformation，在测试环境中可能无法直接 require
    // 用 try-catch 保护（此时下面用例会 skip，而不是报错）
    try {
      const mod = require('../src/inference/pipeline/modelLoader');
      DUMMY_TEST_INPUTS_FP32 = mod.DUMMY_TEST_INPUTS_FP32;
    } catch (_e) {
      // electron 不可用时跳过此 describe
      DUMMY_TEST_INPUTS_FP32 = null;
    }
  });

  it('melTransform dummy input should use key "audio" (not "waveform")', function () {
    if (!DUMMY_TEST_INPUTS_FP32) this.skip('modelLoader.js not loadable (electron dependency)');
    expect(DUMMY_TEST_INPUTS_FP32.melTransform, 'melTransform should exist in DUMMY_TEST_INPUTS_FP32').to.exist;
    expect(DUMMY_TEST_INPUTS_FP32.melTransform, 'melTransform should have "audio" key').to.have.property('audio');
    expect(DUMMY_TEST_INPUTS_FP32.melTransform, 'melTransform should NOT have "waveform" key').to.not.have.property('waveform');
  });
});
