/**
 * 回归：独占播放的 UI 会话号裁决。
 *
 * 用户报告的现象：暂停后按"继续"没反应（播放头/状态不动）但声音在放；
 * 再按停止，声音停了、状态复位，却"又在一个范围内播了一遍"才恢复正常。
 *
 * 根因链（三处，各有对应断言）：
 *   1. worker 的 start 被 decibri 的同步 write/end 钉死（见
 *      audioWorkerNonBlockingStart.test.js）；
 *   2. start 回执迟到时，渲染层会拿失败结果回退到共享播放 —— 相当于把用户
 *      刚停掉的声音重新放出来（见 exclusivePlaybackRecovery.test.js）；
 *   3. 排队中的旧 play 在 stop 之后才轮到执行，也会把声音放出来。
 *
 * 本文件钉第 3 条：主进程按会话号丢弃过期命令。
 */
const { expect } = require('chai');
const { createSessionGate } = require('../src/audio/uiSession');

describe('UI 会话号裁决（createSessionGate）', () => {
  it('接受单调递增的会话号', () => {
    const gate = createSessionGate();
    expect(gate.accept(1)).to.be.true;
    expect(gate.accept(2)).to.be.true;
    expect(gate.accept(3)).to.be.true;
    expect(gate.lastSessionId()).to.equal(3);
  });

  it('停止（更新的会话号）之后，排队中的旧 play 被丢弃', () => {
    const gate = createSessionGate();
    expect(gate.accept(5), 'play 先到').to.be.true;
    expect(gate.accept(6), 'stop 后到，推进会话号').to.be.true;
    expect(gate.accept(5), '排队的旧 play 轮到执行时必须被丢弃').to.be.false;
  });

  it('旧 stop 不会掐掉新会话刚开始的声音', () => {
    const gate = createSessionGate();
    expect(gate.accept(6), 'stop').to.be.true;
    expect(gate.accept(7), '停止之后用户又点了播放').to.be.true;
    expect(gate.accept(6), '迟到的旧 stop 必须放过').to.be.false;
  });

  it('同一个会话号重复到达不算过期（play 锁内外各判一次）', () => {
    const gate = createSessionGate();
    expect(gate.accept(9)).to.be.true;
    expect(gate.accept(9), '入队时判一次、轮到自己时再判一次').to.be.true;
  });

  it('不带会话号（老调用方 / 共享模式）一律接受且不推进', () => {
    const gate = createSessionGate();
    expect(gate.accept(undefined)).to.be.true;
    expect(gate.accept(null)).to.be.true;
    expect(gate.accept(NaN)).to.be.true;
    expect(gate.lastSessionId()).to.equal(0);
    expect(gate.accept(1)).to.be.true;
    expect(gate.accept(undefined), '不参与裁决，不该被上一条会话号挡住').to.be.true;
  });

  it('两个 manager 各自独立（主窗口 / 分片编辑器互不干扰）', () => {
    const main = createSessionGate();
    const fragment = createSessionGate();
    expect(main.accept(100)).to.be.true;
    expect(fragment.accept(1), '分片编辑器的会话号从 1 开始也不能被主窗口挡住').to.be.true;
  });
});
