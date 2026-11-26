/**
 * 回归：窗口最小化再恢复后，声音继续但进度条 / 时间码卡死。
 *
 * 根因不是时钟，而是「循环是否活着」的判断依据错了：
 * `state.exclusivePlaybackRaf` 里存着 rAF id 并不代表回调还会执行 ——
 * 窗口最小化时 Chromium 会挂起已排队的回调，恢复后不保证重新派发；
 * 反过来，hidden 分支主动 cancel 之后 id 变 null，但心跳仍新鲜。
 * 旧逻辑只看 id 是否为空，两种情形都会漏判：
 *   · 死 id（非空但不再执行）→ 恢复时跳过重启，永久冻结；
 *   · 刚 cancel（id 为空但心跳新）→ 共享模式同理。
 *
 * 另外真实环境存在「只发 blur/focus、不发 visibilitychange」的最小化路径
 * （本机 Electron 42 复现过），所以必须有 rAF 之外的心跳兜底。
 */
const { expect } = require('chai');
const sinon = require('sinon');

const { state } = require('../src/renderer/state.js');
const {
  startExclusivePlayheadAnimation,
  stopExclusivePlayback,
  startPlayheadAnimation,
  stopPlayheadAnimation,
} = require('../src/renderer/audioPlayback.js');

const SAMPLE_RATE = 24000;

describe('最小化恢复后播放头循环自愈', () => {
  let clock;
  let rafQueue;
  let nextRafId;
  let cancelledIds;
  let hidden;
  let savedRaf;
  let savedCancel;

  function fakeRaf(cb) {
    const id = ++nextRafId;
    rafQueue.push({ id, cb });
    return id;
  }
  function fakeCancel(id) {
    cancelledIds.push(id);
    rafQueue = rafQueue.filter((e) => e.id !== id);
  }
  /** 手动跑掉当前排队的一帧（模拟一次 rAF 派发） */
  function flushFrame() {
    const q = rafQueue;
    rafQueue = [];
    for (const e of q) e.cb();
    return q.length;
  }
  function setHidden(v) {
    hidden = v;
    document.dispatchEvent(new window.Event('visibilitychange'));
  }
  function setHiddenSilently(v) {
    hidden = v;
  }

  beforeEach(() => {
    // 上一个用例若留下真实 timer 建的看门狗，必须在启用 fake timers 之前清掉，
    // 否则 clearInterval 会拿 fake 实现去清原生 timer（sinon 会告警且清不掉）。
    window.dispatchEvent(new window.Event('beforeunload'));

    hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });

    savedRaf = global.requestAnimationFrame;
    savedCancel = global.cancelAnimationFrame;
    rafQueue = [];
    nextRafId = 100;
    cancelledIds = [];
    global.requestAnimationFrame = fakeRaf;
    global.cancelAnimationFrame = fakeCancel;

    state.isPlaying = true;
    state.useExclusiveMode = true;
    state.playbackStartTime = Date.now() / 1000 - 1;
    state.playbackPauseOffset = 0;
    state.exclusivePlaybackRaf = null;
    state.playheadRaf = null;
    state.currentAudioData = new Float32Array(SAMPLE_RATE * 30);
    state.currentAudioBuffer = null;
    state.streamingSources = [];
    state.streamingFinished = false;
    state.audioSettings = {};
    // jsdom 没有 AudioContext：给一个最小替身，让共享模式 tick 能算时钟
    state.audioContext = { state: 'running', currentTime: 3, outputLatency: 0, baseLatency: 0 };
    state.gainNode = null;

    clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    // 触发 once:true 的 beforeunload：拆掉监听并停掉看门狗，避免测试间串扰
    window.dispatchEvent(new window.Event('beforeunload'));
    state.isPlaying = false;
    state.audioContext = null;
    stopExclusivePlayback();
    stopPlayheadAnimation();
    clock.restore();
    global.requestAnimationFrame = savedRaf;
    global.cancelAnimationFrame = savedCancel;
    delete document.hidden;
    delete document.visibilityState;
  });

  it('独占模式：id 残留但回调已不派发（死 id）时，恢复可见会重启循环', () => {
    startExclusivePlayheadAnimation(null, Date.now());
    expect(flushFrame(), '首帧应被执行').to.equal(1);
    expect(flushFrame(), '循环自链第二帧').to.equal(1);

    // 最小化：Chromium 挂起回调，但**没有**派发 visibilitychange → id 留在 state 上，
    // 队列里那一帧永远不会被执行
    setHiddenSilently(true);
    clock.tick(1500); // 心跳过期（> LOOP_STALL_MS），且看门狗因 hidden 跳过
    expect(rafQueue.length, '挂起的帧仍在队列里，说明它不会被派发').to.equal(1);

    // 恢复：只发 focus（真实环境里最小化不一定有 visibilitychange）
    setHiddenSilently(false);
    const staleId = state.exclusivePlaybackRaf;
    window.dispatchEvent(new window.Event('focus'));

    expect(cancelledIds, '旧的死 id 必须被取消，否则重启会叠出第二条循环').to.include(staleId);
    expect(rafQueue.length, '恢复后必须重新排上一帧，否则进度条永久冻结').to.equal(1);
    expect(rafQueue[0].id).to.not.equal(staleId);
    expect(flushFrame(), '重启后的帧应能正常执行').to.equal(1);
    expect(state.exclusivePlaybackRaf).to.be.a('number');
  });

  it('独占模式：长最小化 + 无 focus/visibilitychange，看门狗也能自愈', () => {
    startExclusivePlayheadAnimation(null, Date.now());
    flushFrame();

    setHiddenSilently(true);
    clock.tick(3000);
    setHiddenSilently(false); // 恢复，但不派发任何事件

    clock.tick(500); // 过一个看门狗周期
    expect(flushFrame(), '心跳兜底必须在无事件的情况下重启循环').to.equal(1);
  });

  it('共享模式：hidden 取消后心跳仍新鲜时，恢复可见也必须重启（id 为空不算活着）', () => {
    state.useExclusiveMode = false;
    startPlayheadAnimation();
    expect(flushFrame(), '首帧').to.equal(1);

    // 短时间内最小化再恢复：hidden 分支 cancel 掉 id，但距上一帧 < LOOP_STALL_MS
    setHidden(true);
    expect(state.playheadRaf, 'hidden 时主动取消，避免留下挂起的死 id').to.be.null;
    setHidden(false);

    expect(flushFrame(), '心跳新鲜但 id 已空 → 仍然要重启').to.equal(1);
  });

  it('看门狗重启不会在 hidden 期间叠帧', () => {
    startExclusivePlayheadAnimation(null, Date.now());
    flushFrame();

    setHiddenSilently(true);
    const before = rafQueue.length;
    clock.tick(2000); // 看门狗跑了多轮，但 hidden 时必须全部跳过
    window.dispatchEvent(new window.Event('focus')); // 隐藏时的 focus 也不该重启
    expect(rafQueue.length).to.equal(before);
    expect(cancelledIds, 'hidden 期间不应取消/重启任何东西').to.be.empty;
  });
});
