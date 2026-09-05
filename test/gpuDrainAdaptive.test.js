const { expect } = require('chai');
const { gpuDrainAdaptive, markGpuOom } = require('../src/inference/pipeline/utils');

/**
 * 自适应 GPU 排空（gpuDrainAdaptive）测试 — Task 8.4。
 *
 * 自 aab3fbe 起，GPU 排空不再施加任何 wall-clock sleep（包括 OOM 恢复等待），
 * 全部改为 setImmediate yield，让 DML 资源回收依赖 ORT 同步与事件循环轮转。
 *
 * 验证：
 *   1. 正常路径（无 OOM）：< 5ms（仅 setImmediate yield，无 50ms 等待）。
 *   2. OOM 后：markGpuOom → 下次 gpuDrainAdaptive() 依旧快速（< 5ms）并清除标志。
 *   3. OOM drain 后恢复：标志清除，再下次 < 5ms。
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

  it('OOM 后：markGpuOom → 下次 gpuDrainAdaptive() 依旧快速（< 5ms）并清除标志', async () => {
    markGpuOom();
    const t0 = performance.now();
    await gpuDrainAdaptive();
    const elapsed = performance.now() - t0;
    expect(elapsed).to.be.lessThan(5);
  });

  it('OOM drain 后恢复：标志清除，再下次 < 5ms', async () => {
    markGpuOom();
    await gpuDrainAdaptive(); // 快速 yield + 清除标志

    const t0 = performance.now();
    await gpuDrainAdaptive();
    const elapsed = performance.now() - t0;
    expect(elapsed).to.be.lessThan(5);
  });
});
