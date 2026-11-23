/**
 * StreamingScheduler 解冻失败语义回归（报告 #7）。
 *
 * 旧实现 `_resumeContext()` 吞掉 `ctx.resume()` 异常且没有返回值，
 * `resumeFromWait()` 又无条件清 `_waitingForInference` 并回调
 * `onWaitStateChange(false)`。结果是 AudioContext 仍 suspended，调度器却认为
 * 已恢复，后续 chunk 继续往冻结的时钟里排 —— 表现为"偶发卡住 / 永久无声"。
 */
const { expect } = require('chai');
const { StreamingScheduler } = require('../src/shared/streamingScheduler.js');

function makeScheduler(ctx) {
  const waitStates = [];
  const scheduler = new StreamingScheduler({
    getCtx: () => ctx,
    getElapsed: () => 0,
    onWaitStateChange: (v) => waitStates.push(v),
  });
  scheduler._waitingForInference = true;
  scheduler._contextSuspended = true;
  return { scheduler, waitStates };
}

describe('StreamingScheduler 解冻失败（#7）', () => {
  it('resume() 抛异常：保持 waiting，不回调 onWaitStateChange(false)', async () => {
    const ctx = {
      state: 'suspended',
      currentTime: 0,
      resume: async () => { throw new Error('device lost'); },
    };
    const { scheduler, waitStates } = makeScheduler(ctx);

    const ok = await scheduler.resumeFromWait();

    expect(ok, '解冻失败必须返回 false').to.equal(false);
    expect(scheduler.isWaiting, '必须保持 waiting 让 watchdog 重试').to.equal(true);
    expect(waitStates, '不得声明已恢复').to.deep.equal([]);
  });

  it('resume() 成功但 ctx.state 仍是 suspended：同样视为失败', async () => {
    const ctx = {
      state: 'suspended',
      currentTime: 0,
      resume: async () => {}, // 返回成功但设备没恢复
    };
    const { scheduler, waitStates } = makeScheduler(ctx);

    const ok = await scheduler.resumeFromWait();

    expect(ok).to.equal(false);
    expect(scheduler.isWaiting).to.equal(true);
    expect(waitStates).to.deep.equal([]);
  });

  it('resume() 成功且 ctx.state === running：清 waiting 并回调一次 false', async () => {
    const ctx = {
      state: 'suspended',
      currentTime: 0,
      resume: async function resume() { this.state = 'running'; },
    };
    const { scheduler, waitStates } = makeScheduler(ctx);

    const ok = await scheduler.resumeFromWait();

    expect(ok).to.equal(true);
    expect(scheduler.isWaiting).to.equal(false);
    expect(waitStates).to.deep.equal([false]);
  });
});
