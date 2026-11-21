/**
 * 分片编辑器播放会话回归 —— 钉住"多次修复都没修好"的几个结构性根因。
 *
 *   1. 冷启动 AudioContext 时 invoke 回执先于首块处理到达：
 *      scheduler.activate() 不得把已经置位的 inferenceDone 抹掉，
 *      否则末尾 underrun 冻结后无人解冻 → 全程静音 + 播放头永久卡死。
 *   2. 收尾不得早于"仍在出声"：isLast 的重复块被丢弃时不能把播放头按回 0。
 *   3. 独占输出设置下流式预览仍走 WebAudio：播放头看门狗必须按**实际输出
 *      方式**自愈，而不是看设置开关（否则最小化恢复后播放头永久冻住）。
 *   4. 合成中拖拽播放头：合成完成后从新位置整段播放，且只有一路出声。
 *   5. invoke 回执之后才派发的 chunk 不得被丢弃（监听器归会话所有）。
 */
const { expect } = require('chai');
const sinon = require('sinon');

const SAMPLE_RATE = 24000;

global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
global.Node = global.window.Node;
global.Element = global.window.Element;
global.HTMLElement = global.window.HTMLElement;

function ensureDom() {
  for (const id of ['piano-roll', 'piano-keys', 'param-roll', 'velocity-roll', 'pitch-roll']) {
    if (!document.getElementById(id)) {
      const c = document.createElement('canvas');
      c.id = id;
      document.body.appendChild(c);
    }
  }
  for (const id of ['autoShiftCheck', 'btn-play-fragment', 'btn-export-fragment']) {
    if (!document.getElementById(id)) {
      const el = document.createElement(id === 'autoShiftCheck' ? 'input' : 'button');
      if (id === 'autoShiftCheck') el.type = 'checkbox';
      el.id = id;
      document.body.appendChild(el);
    }
  }
}
ensureDom();

class FakeGain {
  constructor() { this.gain = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }; }
  connect(n) { return n; }
  disconnect() {}
}

/** 手动时钟 + 可控 resume 的假 AudioContext。 */
class FakeCtx {
  constructor({ cold = false } = {}) {
    this.sampleRate = SAMPLE_RATE;
    this.state = cold ? 'suspended' : 'running';
    this.destination = {};
    this.outputLatency = 0.02;
    this.baseLatency = 0.01;
    this.sources = [];
    this.suspendCalls = 0;
    this.resumeCalls = 0;
    this._clock = 0;
    this._pendingResume = null;
  }
  get currentTime() { return this._clock; }
  createGain() { return new FakeGain(); }
  createStereoPanner() {
    return { pan: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect(n) { return n; }, disconnect() {} };
  }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return { length, numberOfChannels: channels, sampleRate: rate, duration: length / rate, getChannelData: () => data };
  }
  createBufferSource() {
    const ctx = this;
    return {
      buffer: null,
      onended: null,
      startWhen: null,
      startOffset: null,
      stopped: false,
      ended: false,
      connect(n) { this.dest = n; return n; },
      disconnect() {},
      start(when, offset) { this.startWhen = when; this.startOffset = offset || 0; ctx.sources.push(this); },
      stop() { this.stopped = true; },
    };
  }
  suspend() { this.suspendCalls += 1; this.state = 'suspended'; return Promise.resolve(); }
  resume() {
    this.resumeCalls += 1;
    if (this.state === 'running') return Promise.resolve();
    // 冷启动：resume 挂起直到显式放行（模拟设备就绪 / setSinkId 的异步延迟）
    return new Promise((res) => { this._pendingResume = res; });
  }
  releaseResume() {
    this.state = 'running';
    const r = this._pendingResume;
    this._pendingResume = null;
    if (r) r();
  }
  /** 推进时钟并触发到期的 onended。suspended 时时钟冻结（与真实设备一致）。 */
  advanceTo(t) {
    if (this.state !== 'running') return;
    this._clock = t;
    for (const s of this.sources) {
      if (s.ended || s.stopped || s.startWhen === null) continue;
      const dur = s.buffer ? s.buffer.duration - s.startOffset : 0;
      if (t >= s.startWhen + dur) {
        s.ended = true;
        if (s.onended) s.onended();
      }
    }
  }
  /** 小步推进，让 rAF / watchdog 有机会运行（underrun 冻结才会真的发生）。 */
  async runClock(to, step = 0.25, pauseMs = 20) {
    for (let t = this._clock + step; t <= to + 1e-9; t += step) {
      this.advanceTo(t);
      await sleep(pauseMs);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunkAt(relStartSec, durSec, isLast) {
  return {
    chunkIndex: 0,
    sampleOffset: Math.round(relStartSec * SAMPLE_RATE),
    sampleEnd: Math.round((relStartSec + durSec) * SAMPLE_RATE),
    audio: new Float32Array(Math.round(durSec * SAMPLE_RATE)).fill(0.1),
    totalSamples: Math.round(30 * SAMPLE_RATE),
    isLast,
  };
}

describe('分片编辑器播放会话（结构性根因回归）', () => {
  let ctx;
  let state;
  let electronAPI;
  let chunkCb = null;
  let resolveSynth = null;
  let rejectSynth = null;
  let playPromise = null;
  let audioPlayback;
  let sessionModule;

  function setup({ cold = false, outputMode = 'shared' } = {}) {
    ensureDom();
    ctx = new FakeCtx({ cold });
    global.window.AudioContext = function () { return ctx; };
    global.AudioContext = global.window.AudioContext;

    chunkCb = null;
    resolveSynth = null;
    rejectSynth = null;
    electronAPI = {
      getSettings: sinon.stub().resolves({ audioOutputMode: outputMode, audioVolume: 1 }),
      onFragmentSVSChunkAudio: sinon.stub().callsFake((cb) => { chunkCb = cb; return () => { chunkCb = null; }; }),
      synthesizeFragmentSVS: sinon.stub().callsFake(() => new Promise((res, rej) => { resolveSynth = res; rejectSynth = rej; })),
      onAudioEnded: sinon.stub().returns(() => {}),
      audioPlay: sinon.stub().resolves({ success: true }),
      audioStop: sinon.stub().resolves({ success: true }),
      getFragmentSVSSampleRate: sinon.stub().resolves(SAMPLE_RATE),
      cancelSVSSynthesis: sinon.stub().resolves({ success: true }),
    };
    global.window.electronAPI = electronAPI;

    state = require('../src/fragmentEditor/state.js');
    state.setPipelineInitialized(true);
    state.setSampleRate(SAMPLE_RATE);
    state.setFragmentAudioSettings({ audioOutputMode: outputMode, audioVolume: 1 });
    state.setFragmentUseExclusiveMode(outputMode === 'exclusive');
    const notes = [];
    for (let i = 0; i < 12; i += 1) {
      notes.push({ id: i + 1, pitch: 60, start: i * 4, duration: 4, lyric: 'la', fadeIn: 0, fadeOut: 0 });
    }
    state.setNotes(notes);
    state.setCurrentProject({ bpm: 120 });
    state.setCurrentFragment({ id: 'frag1', notes, duration: 48, singerId: null });
    state.setWavFileBuffer(null);
    state.setSingerAnnotation(null);
    state.setTrackBackend({ type: 'sxs' });
    state.setFragmentAudioData(null);
    state.setFragmentAudioDataSignature(null);
    state.setFragmentPlayStartPosition(0);
    state.setFragmentIsPlaying(false);
    state.setFragmentIsSynthesizing(false);
    state.setFragmentIsExporting(false);
    state.setFragmentIsAutoInferring(false);
    state.setFragmentAudioContext(null);
    state.setFragmentGainNode(null);
    state.setFragmentAudioSource(null);
    state.setFragmentCurrentTime(0);

    sessionModule = require('../src/fragmentEditor/playbackSession.js');
    sessionModule._resetPlaybackSessions();
    audioPlayback = require('../src/fragmentEditor/audioPlayback.js');
  }

  afterEach(() => {
    if (state.getFragmentIsSynthesizing()) audioPlayback.cancelFragmentSynthesis();
    else audioPlayback.stopFragmentPlayback();
    if (rejectSynth) rejectSynth(new Error('Synthesis cancelled'));
    rejectSynth = null;
    if (playPromise) playPromise.catch(() => {});
    playPromise = null;
    sessionModule._resetPlaybackSessions();
    global.window.electronAPI = undefined;
  });

  it('冷启动：invoke 回执先于首块处理 → inferenceDone 不被 activate 抹掉，播完不挂死', async () => {
    setup({ cold: true });
    playPromise = audioPlayback.playFragment();
    await sleep(40);
    expect(chunkCb, 'chunk 监听应已注册').to.be.a('function');

    // 首块进入处理，但卡在 ctx.resume()（设备尚未就绪）
    chunkCb(chunkAt(0, 4, false));
    await sleep(20);
    expect(ctx.sources, '首块还没排上（resume 未放行）').to.have.lengthOf(0);

    // invoke 回执此刻到达：setInferenceDone() 先于首块的 activate()
    resolveSynth(new Float32Array(24 * SAMPLE_RATE).fill(0.1));
    await sleep(40);

    ctx.releaseResume();
    await sleep(40);
    expect(ctx.sources, '首块已排程').to.have.lengthOf(1);

    chunkCb(chunkAt(4, 4, true));
    await sleep(40);
    expect(ctx.sources).to.have.lengthOf(2);

    // 逐步推进到末端：若 inferenceDone 被抹掉，播放头会在前沿前 0.3s 被冻结，
    // 此后没有任何 chunk 会来解冻 → 永远停在那里（用户看到的"后面全程静音"）。
    await ctx.runClock(9.5);
    expect(state.getFragmentIsPlaying(), '应自然收尾').to.equal(false);
    expect(ctx.state, '上下文不得留在 suspended').to.equal('running');
    expect(state.getFragmentIsSynthesizing()).to.equal(false);
    expect(ctx.currentTime, '时钟必须真的走到末端').to.be.greaterThan(8);
  });

  it('isLast 的重复块被丢弃时，仍在出声的播放不得被收尾', async () => {
    setup();
    playPromise = audioPlayback.playFragment();
    await sleep(40);

    chunkCb(chunkAt(0, 10, false));
    await sleep(40);
    expect(ctx.sources).to.have.lengthOf(1);

    // 与已交付内容完全重叠的末块：整块丢弃，但 source 仍在播
    chunkCb(chunkAt(0, 10, true));
    await sleep(40);
    expect(state.getFragmentIsPlaying(), '仍有 10s 音频在排程，不得收尾').to.equal(true);

    ctx.advanceTo(5);
    await sleep(40);
    expect(state.getFragmentIsPlaying()).to.equal(true);

    ctx.advanceTo(11);
    await sleep(80);
    expect(state.getFragmentIsPlaying(), '播完后收尾').to.equal(false);
  });

  it('独占设置下的流式预览：播放头循环停摆后看门狗仍重启（按实际输出方式自愈）', async () => {
    setup({ outputMode: 'exclusive' });
    playPromise = audioPlayback.playFragment();
    await sleep(40);
    chunkCb(chunkAt(0, 12, false));
    await sleep(60);
    expect(state.getFragmentIsPlaying()).to.equal(true);
    expect(state.getFragmentUseExclusiveMode(), '设置仍是独占').to.equal(true);

    ctx.advanceTo(1);
    await sleep(60);
    const before = state.getFragmentCurrentTime();

    // 模拟 Chromium 丢弃已排队的 rAF 回调：id 仍在，回调永远不会跑
    const deadId = state.getFragmentPlayheadRaf();
    if (deadId) cancelAnimationFrame(deadId);
    state.setFragmentPlayheadRaf(999999);

    ctx.advanceTo(3);
    await sleep(1400); // 心跳过期 700ms + 看门狗一轮 400ms
    expect(state.getFragmentCurrentTime(), '播放头必须重新前进').to.be.greaterThan(before + 0.5);
    expect(state.getFragmentIsPlaying()).to.equal(true);
  });

  it('合成中拖拽到 8s：合成完成后从新位置整段播放，且只有一路出声', async () => {
    setup();
    playPromise = audioPlayback.playFragment();
    await sleep(40);
    chunkCb(chunkAt(0, 4, false));
    await sleep(40);
    expect(ctx.sources).to.have.lengthOf(1);

    await audioPlayback.seekFragmentPlayback(8);
    await sleep(40);
    expect(state.getFragmentIsPlaying(), '合成中 seek 只停播放').to.equal(false);

    resolveSynth(new Float32Array(20 * SAMPLE_RATE).fill(0.1));
    await sleep(120);

    const live = ctx.sources.filter((s) => !s.stopped);
    expect(live, '只有一路整段播放').to.have.lengthOf(1);
    expect(live[0].startOffset, '从 8s 起播').to.be.closeTo(8, 0.05);
    expect(state.getFragmentIsPlaying()).to.equal(true);
  });

  it('invoke 回执之后才派发的 chunk 仍被排程（监听器归会话所有，不提前摘除）', async () => {
    setup();
    playPromise = audioPlayback.playFragment();
    await sleep(40);
    expect(chunkCb).to.be.a('function');

    resolveSynth(new Float32Array(24 * SAMPLE_RATE).fill(0.1));
    await sleep(20);
    // 回执已处理，但 chunk 还在 IPC 队列里 —— 此刻监听器必须仍在
    expect(chunkCb, '监听器不得在会话结束前摘除').to.be.a('function');
    chunkCb(chunkAt(0, 4, true));
    await sleep(80);

    const live = ctx.sources.filter((s) => !s.stopped);
    expect(live.length, '不得出现双路音频').to.equal(1);
    expect(state.getFragmentIsPlaying()).to.equal(true);
  });
});

describe('StreamingScheduler.activate 非破坏性', () => {
  const { StreamingScheduler } = require('../src/shared/streamingScheduler.js');

  it('activate 不得重置 inferenceDone / 前沿 / 活跃计数', () => {
    const sched = new StreamingScheduler({ getCtx: () => null, getElapsed: () => 0 });
    sched.updateBufferFrontier(12);
    sched.addSource();
    sched.inferenceDone = true;
    sched.activate();
    expect(sched.inferenceDone, 'invoke 回执可能先于首块处理到达').to.equal(true);
    expect(sched.bufferEndSec).to.equal(12);
    expect(sched.activeSourceCount).to.equal(1);
    sched.deactivate();
  });
});