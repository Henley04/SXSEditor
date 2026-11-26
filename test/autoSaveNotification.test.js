'use strict';
/**
 * 自动保存失败通知去重的回归测试。
 *
 * 场景来自真实缺陷：官方工程插件打开 .svp 后，旧副本没有 codec.write，
 * `saveDocument` 恒返回 NOT_HANDLED。自动保存每 400ms 触发一次，用户每拖
 * 一个音符就会收到一条「工程自动保存失败…请尽快手动保存」。60s 时间节流
 * 仍会每分钟弹一次，而手动保存走同一条分派，一样失败 —— 文案误导且刷屏。
 */
const { expect } = require('chai');

describe('自动保存失败通知去重', () => {
  let shouldNotifyAutoSaveFailure;
  let resetAutoSaveNotification;

  before(async () => {
    ({ shouldNotifyAutoSaveFailure, resetAutoSaveNotification } =
      await import('../src/renderer/autoSaveNotification.js'));
  });

  beforeEach(() => resetAutoSaveNotification());

  it('同一个失败原因只通知一次（后续 400ms 的重复失败不再弹窗）', () => {
    const key = '/tmp/song.svp|NOT_HANDLED';
    expect(shouldNotifyAutoSaveFailure(key, 100000)).to.equal(true);
    for (let t = 100400; t <= 400000; t += 400) {
      expect(shouldNotifyAutoSaveFailure(key, t), `t=${t} 不应重复弹窗`).to.equal(false);
    }
  });

  it('不同失败原因仍会提示，但受 60s 节流保护', () => {
    expect(shouldNotifyAutoSaveFailure('/tmp/a.svp|NOT_HANDLED', 100000)).to.equal(true);
    // 换了一个原因，但距上次不足 60s —— 不刷屏。
    expect(shouldNotifyAutoSaveFailure('/tmp/a.svp|PERMISSION_DENIED', 130000)).to.equal(false);
    // 超过 60s 后，新原因可以提示。
    expect(shouldNotifyAutoSaveFailure('/tmp/a.svp|PERMISSION_DENIED', 160001)).to.equal(true);
  });

  it('复位后（保存成功 / 换工程 / 另存为）同一原因能重新提示', () => {
    const key = '/tmp/song.svp|NOT_HANDLED';
    expect(shouldNotifyAutoSaveFailure(key, 100000)).to.equal(true);
    expect(shouldNotifyAutoSaveFailure(key, 200000)).to.equal(false);

    resetAutoSaveNotification();
    expect(shouldNotifyAutoSaveFailure(key, 200400)).to.equal(true);
  });

  it('换了目标文件算新原因，不会被旧文件吞掉', () => {
    expect(shouldNotifyAutoSaveFailure('/tmp/old.svp|NOT_HANDLED', 100000)).to.equal(true);
    expect(shouldNotifyAutoSaveFailure('/tmp/new.svp|NOT_HANDLED', 100400)).to.equal(false);
    // 仍受节流；但复位后新文件可以提示（模拟另存为换格式）。
    resetAutoSaveNotification();
    expect(shouldNotifyAutoSaveFailure('/tmp/new.svp|NOT_HANDLED', 100400)).to.equal(true);
  });

  it('首次失败不受「上次弹窗时间」影响（-Infinity 初值）', () => {
    expect(shouldNotifyAutoSaveFailure('/tmp/x.svp|NOT_HANDLED', 0)).to.equal(true);
  });
});
