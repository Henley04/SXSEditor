const { expect } = require('chai');
const { gpuDrainAdaptive, markGpuOom } = require('../src/inference/pipeline/utils');

/**
 * 自适应 GPU 排空（gpuDrainAdaptive）测试 — Task 8.4。
 *
 * 验证：
 *   1. 正常路径（无 OOM）：< 5ms（仅 setImmediate yield，无 50ms 等待）。
 *   2. OOM 后：markGpuOom → 下次 gpuDrainAdaptive > 150ms（200ms 长等待）。
 *   3. OOM drain 后恢复：标志清除，下次 < 5ms。
 *
 * 注意：_oomFlag 是模块级状态，测试间通过调用 gpuDrainAdaptive() 清除标志。
 */
describe('gpuDrainAdaptive (自适应 GPU 排空)', () => {
  // 每个测试前先清除可能残留的 OOM 标志（调用一次 drain 即清除）。
  beforeEach(async () => {
    await gpuDrainAdaptive();
  });

  it('正常路径：无 OOM 标志时 < 5ms（仅 setImmediate yield）', async () => {
    const t0 = performance.now();
    await gpuDrainAdaptive();
    const elapsed = performance.now() - t0;
    expect(elapsed).to.be.lessThan(5);
  });

  it('OOM 后：markGpuOom → 下次 gpuDrainAdaptive > 150ms', async () => {
    markGpuOom();
    const t0 = performance.now();
    await gpuDrainAdaptive();
    const elapsed = performance.now() - t0;
    expect(elapsed).to.be.greaterThan(150);
  });

  it('OOM drain 后恢复：标志清除，下次 < 5ms', async () => {
    markGpuOom();
    await gpuDrainAdaptive(); // 200ms 等待 + 清除标志

    const t0 = performance.now();
    await gpuDrainAdaptive();
    const elapsed = performance.now() - t0;
    expect(elapsed).to.be.lessThan(5);
  });
});
