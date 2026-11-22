/**
 * 回归：播放时打开设置 → 退出设置按播放 → 出现"停不掉的清唱"，再按暂停
 * 又把之前带伴奏的播放放出来（用户报告 + 主进程日志 `Command timeout: start`）。
 *
 * 三条成因，本文件各钉一条：
 *   1. 独占输出（主进程 decibri）的 start 命令没有回执时，worker 可能已经在
 *      出声，但父进程 _isPlaying 仍是 false。带 _isPlaying 守卫的 stop() 会
 *      静默跳过 → 幽灵播放永远停不掉。超时必须终止子进程释放设备。
 *   2. 渲染层只在 `useExclusiveMode === true` 时才发 audioStop；而 start 失败
 *      回退已经把这个标志改回 false，于是 Stop/Pause 再也碰不到那路输出。
 *   3. 独占输出只收到一份 Float32Array（纯人声），伴奏是 WebAudio 侧独立
 *      BufferSource，根本不在这份数据里 → 独占模式永远只有清唱。
 */
const { expect } = require('chai');
const sinon = require('sinon');
const child_process = require('child_process');

// jsdom 的 rAF 挂在 window 上；audioPlayback.js 用的是全局 requestAnimationFrame
if (!global.requestAnimationFrame) {
  global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
  global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
}

const { AudioOutputManager } = require('../src/audio/audioOutputManager');
const { state, trackManager } = require('../src/renderer/state.js');
const { stopPlayback, startExclusivePlayback } = require('../src/renderer/audioPlayback.js');
const { TRANSPORT, getTransportState } = require('../src/renderer/transport.js');

/**
 * jsdom 没有 AudioContext：给一个最小替身。
 * 用途是让"回退到共享播放"这条错误路径可观察 —— 若它被走到，
 * startSharedPlayback 会真的建 buffer/source 并置 isPlaying。
 */
function installFakeAudioContext() {
  class FakeGain {
    constructor() { this.gain = { value: 1, setValueAtTime() {}, setTargetAtTime() {} }; }
    connect() { return this; }
    disconnect() {}
  }
  class FakeBuffer {
    constructor(length) { this.duration = length / 24000; this._length = length; }
    getChannelData() { return new Float32Array(this._length); }
  }
  class FakeSource {
    constructor() { this.onended = null; }
    connect() { return this; }
    start() {}
    stop() {}
  }
  class FakeCtx {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.sampleRate = 24000;
      this.destination = {};
      this.outputLatency = 0;
      this.baseLatency = 0;
    }
    createGain() { return new FakeGain(); }
    createBuffer(channels, length) { return new FakeBuffer(length); }
    createBufferSource() { return new FakeSource(); }
    resume() { return Promise.resolve(); }
  }
  global.window.AudioContext = FakeCtx;
  global.AudioContext = FakeCtx;
  state.audioContext = null;
  state.gainNode = null;
}

function createFakeWorker() {
  const handlers = {};
  return {
    send: sinon.stub(),
    on: sinon.stub().callsFake((event, cb) => { handlers[event] = cb; }),
    kill: sinon.stub(),
    removeAllListeners: sinon.stub(),
    _emit: (event, msg) => { if (handlers[event]) handlers[event](msg); },
  };
}

describe('独占音频 start 超时后的恢复', () => {
  let forkStub;
  let fakeWorker;
  let mgr;

  beforeEach(() => {
    fakeWorker = createFakeWorker();
    forkStub = sinon.stub(child_process, 'fork').returns(fakeWorker);
    mgr = new AudioOutputManager();
  });

  afterEach(() => {
    if (mgr) { mgr.destroy(); mgr = null; }
    if (forkStub) { forkStub.restore(); forkStub = null; }
  });

  it('start 超时后终止 worker、清空 pending，不留可出声的幽灵播放', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const promise = mgr.start(new Float32Array(100), { sampleRate: 24000 });
      await clock.tickAsync(0);
      expect(fakeWorker.send.calledWithMatch({ type: 'start' })).to.be.true;

      await clock.tickAsync(9000);
      let err;
      try { await promise; } catch (e) { err = e; }
      expect(err && err.message).to.match(/timeout/i);
      expect(fakeWorker.kill.called, '卡住的 worker 必须被 kill，否则音频设备继续出声').to.be.true;
      expect(mgr.isPlaying()).to.be.false;
      expect(mgr._pendingRequests.size).to.equal(0);
    } finally {
      clock.restore();
    }
  });

  it('ended 早于 start 回执时不得把 _isPlaying 反转回 true', async () => {
    mgr._ensureWorker();
    fakeWorker._emit('message', { type: 'ready', isAvailable: true });
    const promise = mgr.start(new Float32Array(100), { sampleRate: 24000 });
    await Promise.resolve();
    await Promise.resolve();
    const cmd = fakeWorker.send.lastCall.args[0];
    expect(cmd.type).to.equal('start');

    // 短音频：worker 先报 ended，start 回执随后才到。
    fakeWorker._emit('message', { type: 'ended' });
    fakeWorker._emit('message', { id: cmd.id, type: 'start', result: { success: true } });
    await promise;
    expect(mgr.isPlaying(), '迟到的 start 回执不能覆盖先到的 ended').to.be.false;
  });

  it('forceStop 在父进程未标记 playing 时仍向 worker 发 stop', async () => {
    mgr._ensureWorker(); // 模拟"worker 已在播、父进程却没标记 playing"
    expect(mgr.isPlaying()).to.be.false;

    const promise = mgr.forceStop();
    await Promise.resolve();
    fakeWorker._emit('message', { id: 1, type: 'stop', result: { success: true } });
    const result = await promise;

    expect(result.success).to.be.true;
    expect(fakeWorker.send.calledWithMatch({ type: 'stop' })).to.be.true;
  });

  it('从未 fork 过 worker 时 forceStop 是 no-op，不会凭空创建子进程', async () => {
    const result = await mgr.forceStop();
    expect(result.success).to.be.true;
    expect(forkStub.called).to.be.false;
  });

  it('被替换的旧 worker 迟到的 exit 不会污染新 worker 状态', async () => {
    const available = mgr.isAvailable();
    fakeWorker._emit('message', { type: 'ready', isAvailable: true });
    await available;
    expect(mgr._workerReady).to.be.true;

    // 模拟 start 超时终止：旧进程还没上报 exit，用户已经再次点播放
    mgr._killUnresponsiveWorker();
    const secondWorker = createFakeWorker();
    forkStub.returns(secondWorker);
    expect(mgr._ensureWorker()).to.equal(secondWorker);
    secondWorker._emit('message', { type: 'ready', isAvailable: true });

    fakeWorker._emit('exit', 0); // 迟到事件

    expect(mgr._worker, '新 worker 不能被旧 exit 清成 null').to.equal(secondWorker);
    expect(mgr._workerCrashed).to.be.false;
    expect(mgr._workerReady).to.be.true;
  });

  it('超时终止后能重新 fork 并成功播放（不被 _workerCrashed 永久卡死）', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const first = mgr.start(new Float32Array(100), {});
      await clock.tickAsync(0);
      await clock.tickAsync(9000);
      await first.catch(() => {});

      // 主动终止要被识别为"预期退出"，否则下一次播放会被判成崩溃而拒绝 fork
      fakeWorker._emit('exit', 0);
      expect(mgr._workerCrashed).to.be.false;

      const secondWorker = createFakeWorker();
      forkStub.returns(secondWorker);
      const second = mgr.start(new Float32Array(100), {});
      await clock.tickAsync(0);
      secondWorker._emit('message', { type: 'ready', isAvailable: true });
      secondWorker._emit('message', { id: 2, type: 'start', result: { success: true } });
      const result = await second;

      expect(result.success).to.be.true;
      expect(mgr.isPlaying()).to.be.true;
    } finally {
      clock.restore();
    }
  });
});

describe('渲染层：停止路径与独占输出混音', () => {
  let rafStub;
  let electronApiBackup;

  beforeEach(() => {
    electronApiBackup = global.window.electronAPI;
    trackManager.clearAll();
    state.isSynthesizing = false;
    state.synthesisCancelled = false;
    state.isPlaying = false;
    state.playbackPauseOffset = 0;
    state.currentAudioSource = null;
    state.audioContext = null;
    state.currentAudioData = null;
    state.currentAudioChannels = null;
    state.currentAudioBuffer = null;
    state.streamingSources = [];
    state.streamingFinished = false;
    state.playheadRaf = null;
    state.exclusivePlaybackRaf = null;
    state.useExclusiveMode = false;
    state.audioSettings = {};
    state.project = { bpm: 120 };
    rafStub = sinon.stub(global, 'requestAnimationFrame').returns(1);
  });

  afterEach(() => {
    rafStub.restore();
    global.window.electronAPI = electronApiBackup;
    trackManager.clearAll();
    state.isPlaying = false;
    state.exclusivePlaybackRaf = null;
  });

  it('回退成共享模式（useExclusiveMode=false）后 Stop 仍会掐掉独占输出', () => {
    let stops = 0;
    global.window.electronAPI = {
      audioStop: async () => { stops++; return { success: true }; },
    };
    state.useExclusiveMode = false; // start 超时失败回退后的状态
    state.isPlaying = false;        // 父进程也没认为自己正在播

    stopPlayback();

    expect(stops, 'Stop 必须无条件兜底，不能靠 useExclusiveMode 判断').to.equal(1);
  });

  it('独占输出送出的 PCM 含伴奏，不再是纯人声', async () => {
    const vocal = new Float32Array(64).fill(0.1);
    const acc = new Float32Array(64).fill(0.5);
    const singer = trackManager.addSinger({
      type: 'accompaniment',
      trackName: '伴奏',
      accompanimentStartTime: 0,
      accompanimentVolume: 1,
    });
    singer.audioBuffer = acc;
    singer.audioChannels = [acc];

    state.currentAudioData = vocal;
    state.project = { bpm: 120 };

    let sent = null;
    global.window.electronAPI = {
      audioStop: async () => ({ success: true }),
      audioPlay: async (data) => { sent = data; return { success: true }; },
      onAudioEnded: () => () => {},
    };

    await startExclusivePlayback(0);

    expect(sent).to.be.instanceOf(Float32Array);
    expect(sent.length).to.equal(vocal.length);
    // 人声 0.1 + 伴奏 0.5（两声道下混后不变）= 0.6
    expect(sent[0], '独占模式必须预混伴奏，否则用户只听到清唱').to.be.closeTo(0.6, 1e-5);
  });

  /**
   * 暂停/停止之后"声音自己又响一遍"的回归。
   *
   * start 是 async 的：audioPlay 回执迟到时，用户早已按了停止。旧实现拿到
   * 失败结果就直接 startSharedPlayback() 回退 —— 相当于把刚停掉的声音重新
   * 放出来（用户看到的就是停止后又循环播放一小段）。
   */
  it('停止之后迟到的 start 失败不得回退成共享播放', async () => {
    installFakeAudioContext();
    let resolvePlay;
    global.window.electronAPI = {
      audioStop: async () => ({ success: true }),
      audioPlay: () => new Promise((resolve) => { resolvePlay = resolve; }),
      onAudioEnded: () => () => {},
    };

    state.currentAudioData = new Float32Array(24000).fill(0.1);
    state.playbackPauseOffset = 0;

    const pending = startExclusivePlayback(0);
    // playhead 还停在暂停位置时用户按了停止
    stopPlayback();
    const transportAfterStop = getTransportState();

    resolvePlay({ success: false, error: 'Command timeout: start' });
    await pending;

    expect(state.isPlaying, '停止后不得自己恢复播放').to.be.false;
    expect(getTransportState(), '传输条不能被迟到的回执改回播放/暂停态').to.equal(transportAfterStop);
    expect(state.currentAudioSource, '不得创建共享播放的 source').to.be.null;
  });

  it('停止之后迟到的 start 成功必须被立即掐掉，且不改播放状态', async () => {
    installFakeAudioContext();
    const stops = [];
    let resolvePlay;
    global.window.electronAPI = {
      audioStop: async (token) => { stops.push(token); return { success: true }; },
      audioPlay: () => new Promise((resolve) => { resolvePlay = resolve; }),
      onAudioEnded: () => () => {},
    };

    state.currentAudioData = new Float32Array(24000).fill(0.1);
    state.playbackPauseOffset = 0;

    const pending = startExclusivePlayback(0);
    const stopsBefore = stops.length;
    stopPlayback();
    resolvePlay({ success: true });
    await pending;

    expect(state.isPlaying).to.be.false;
    expect(getTransportState()).to.equal(TRANSPORT.IDLE);
    // 停止本身一条 + 迟到成功后的补救一条：后者保证设备里那一路不会继续出声
    expect(stops.length, '迟到的成功必须补一条停止').to.be.greaterThan(stopsBefore);
  });
});
