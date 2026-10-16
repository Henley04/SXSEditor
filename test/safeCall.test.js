const { expect } = require('chai');
const { safeCall, safeCallAsync, safeCleanup, _resetCounts, _counts } = require('../src/shared/safeCall');

/**
 * 2.4：渲染进程静默 catch 的统一兜底。
 * 这些用例锁住三条契约：不抛、有 fallback、失败留痕且不会刷屏。
 */
describe('safeCall (2.4)', function () {
  beforeEach(function () {
    _resetCounts();
  });

  it('同步调用成功时返回函数结果', function () {
    expect(safeCall('t.ok', () => 42, 0)).to.equal(42);
  });

  it('同步调用抛错时返回 fallback 且不外抛', function () {
    const r = safeCall('t.throw', () => { throw new Error('boom'); }, 'fallback');
    expect(r).to.equal('fallback');
    expect(_counts.get('t.throw')).to.equal(1);
  });

  it('返回 undefined 时回退到 fallback', function () {
    expect(safeCall('t.undef', () => undefined, 'fb')).to.equal('fb');
  });

  it('异步调用抛错时返回 fallback', async function () {
    const r = await safeCallAsync('t.async', async () => { throw new Error('async boom'); }, null);
    expect(r).to.equal(null);
    expect(_counts.get('t.async')).to.equal(1);
  });

  it('异步调用正常时透传结果', async function () {
    expect(await safeCallAsync('t.asyncOk', async () => 'ok', null)).to.equal('ok');
  });

  it('safeCleanup 返回执行是否成功', function () {
    expect(safeCleanup('t.cleanupOk', () => {})).to.equal(true);
    expect(safeCleanup('t.cleanupFail', () => { throw new Error('x'); })).to.equal(false);
  });

  it('重复失败被计数而不是逐条刷屏', function () {
    const warnings = [];
    const orig = console.warn;
    console.warn = (m) => warnings.push(m);
    try {
      for (let i = 0; i < 12; i++) safeCall('t.spam', () => { throw new Error('x'); }, null);
    } finally {
      console.warn = orig;
    }
    // 前 3 次逐条打印，之后被抑制
    expect(_counts.get('t.spam')).to.equal(12);
    expect(warnings.length).to.be.lessThan(12);
  });
});
