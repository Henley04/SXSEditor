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

  it('后台定时器停摆（窗口被遮挡）：最后一块播完必须由 onended 冻结，休止后首块不得被裁头', async () => {
    setup();
    playPromise = audioPlayback.playFragment();
    await sleep(40);

    chunkCb(chunkAt(0, 4, false));
    await sleep(40);
    expect(ctx.sources).to.have.lengthOf(1);

    // 模拟窗口被遮挡：rAF 被丢弃（id 还在但永不回调）、250ms 看门狗被节流到
    // ~1 次/分钟 —— 测试里不等待任何定时器。音频线程仍会在缓冲播完时触发 onended。
    const deadId = state.getFragmentPlayheadRaf();
    if (deadId) cancelAnimationFrame(deadId);
    state.setFragmentPlayheadRaf(999999);

    // 时钟推进到第一块末端（anchor 0.05 + 4s）。若无 onended 冻结，
    // 此刻播放头会继续前进；长休止后到达的块就会整段被当作"迟到"裁掉。
    ctx.advanceTo(4.05);
    expect(ctx.suspendCalls, 'onended 必须触发一次冻结').to.equal(1);
    expect(ctx.state, '时钟应停在前沿').to.equal('suspended');
    expect(state.getFragmentIsPlaying(), '是等待推理，不是收尾').to.equal(true);

    // 长休止后的第一块此刻才到达（真实场景里可能是几十秒后）：
    // 必须按原绝对时间从头部完整接上。
    chunkCb(chunkAt(4, 4, true));
    await sleep(20);
    ctx.releaseResume();
    await sleep(40);

    expect(ctx.sources).to.have.lengthOf(2);
    const second = ctx.sources[1];
    expect(second.startOffset, '休止后的首块不得被裁头').to.be.closeTo(0, 0.001);
    expect(second.startWhen, '按原绝对时间接上').to.be.closeTo(4.05, 0.02);
    expect(ctx.state, '下一块到达后应解冻').to.equal('running');
    expect(state.getFragmentIsPlaying()).to.equal(true);
  });

  describe('播放一致性自检（推理结束/交付领先时不得停在等待）', () => {
    it('播放头之后已有交付内容却停在 waiting → 必须解冻并推进前沿', async () => {
      setup();
      playPromise = audioPlayback.playFragment();
      await sleep(40);
      // 两块连续音频都已交付；播放头仍在起点（后续内容已排程）。
      chunkCb(chunkAt(0, 4, false));
      await sleep(40);
      chunkCb(chunkAt(4, 4, false));
      await sleep(40);

      const sess = sessionModule.getCurrentSession();
      expect(sess, '会话存在').to.be.ok;
      // 模拟解冻控制消息丢失：scheduler 停在 waiting、设备时钟仍冻结，
      // 而 timeline 已交付到 8s（播放头之后还有内容）。
      sess.scheduler._waitingForInference = true;
      sess.scheduler._contextSuspended = true;
      ctx.state = 'suspended';

      const repair = sess._repairPlaybackConsistency('test');
      await sleep(10);
      ctx.releaseResume();
      await repair;
      expect(sess.scheduler.isWaiting, '不得停在等待').to.equal(false);
      expect(ctx.state, '设备时钟必须恢复').to.equal('running');
      expect(sess.scheduler.bufferEndSec, '前沿不得落后于已交付内容').to.be.at.least(8);
    });

    it('合法的 underrun 等待（无已交付剩余、推理未结束）不得被自检解冻', async () => {
      setup();
      playPromise = audioPlayback.playFragment();
      await sleep(40);
      chunkCb(chunkAt(0, 4, false));
      await sleep(40);

      // 播到前沿：onended 立刻冻结，尚无后续块 —— 这是合法等待。
      ctx.advanceTo(4.05);
      const sess = sessionModule.getCurrentSession();
      expect(sess.scheduler.isWaiting).to.equal(true);

      await sess._repairPlaybackConsistency('test');
      expect(sess.scheduler.isWaiting, '无内容可播时保持冻结').to.equal(true);
      expect(ctx.state).to.equal('suspended');

      // 推理结束：没有任何后续 chunk 会来，自检必须解冻。
      sess.inferenceDone = true;
      const repair = sess._repairPlaybackConsistency('test');
      await sleep(10);
      ctx.releaseResume();
      await repair;
      expect(sess.scheduler.isWaiting, '推理结束后不得再等待').to.equal(false);
      expect(ctx.state).to.equal('running');
    });

    it('setInferenceDone() 在等待态下解冻并留下可继续的会话', async () => {
      setup();
      playPromise = audioPlayback.playFragment();
      await sleep(40);
      chunkCb(chunkAt(0, 4, false));
      await sleep(40);
      ctx.advanceTo(4.05);

      const sess = sessionModule.getCurrentSession();
      expect(sess.scheduler.isWaiting).to.equal(true);

      const done = sess.setInferenceDone();
      await sleep(10);
      ctx.releaseResume();
      await done;
      expect(sess.scheduler.isWaiting, '推理结束后必须解冻').to.equal(false);
      expect(ctx.state).to.equal('running');
    });
  });
});

describe('StreamingScheduler.onSourcesDrained', () => {
  const { StreamingScheduler } = require('../src/shared/streamingScheduler.js');

  function makeScheduler() {
    const ctx = {
      state: 'running',
      suspendCalls: 0,
      suspend() { this.suspendCalls += 1; this.state = 'suspended'; return Promise.resolve(); },
      resume() { this.state = 'running'; return Promise.resolve(); },
    };
    const sched = new StreamingScheduler({ getCtx: () => ctx, getElapsed: () => 10 });
    sched.activate();
    sched.updateBufferFrontier(10);
    return { sched, ctx };
  }

  it('最后一块播完且推理未结束 → 立即冻结', () => {
    const { sched, ctx } = makeScheduler();
    sched.addSource();
    sched.sourceEnded();
    expect(sched.onSourcesDrained()).to.equal(true);
    expect(sched.isWaiting, '应进入等待').to.equal(true);
    expect(ctx.suspendCalls).to.equal(1);
    sched.deactivate();
  });

  it('仍在等待 / 推理已结束 / 已收到 isLast / 还有 source → 不重复冻结', () => {
    const { sched } = makeScheduler();
    sched.addSource();
    expect(sched.onSourcesDrained(), '还有 source').to.equal(false);
    sched.sourceEnded();

    sched.inferenceDone = true;
    expect(sched.onSourcesDrained(), '推理已结束').to.equal(false);
    sched.inferenceDone = false;

    sched.isLastReceived = true;
    expect(sched.onSourcesDrained(), '已是末块').to.equal(false);
    sched.isLastReceived = false;

    sched._waitingForInference = true;
    expect(sched.onSourcesDrained(), '已在等待').to.equal(false);
    sched._waitingForInference = false;
    sched.deactivate();
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

/**
 * #3 / #10：END 明确报告"不完整"时，绝不能按正常完成收尾。
 * 旧实现只检查 deliveryDone，seq 1、2、4 + END(lastSeq=4) 会被当成正常播完。
 */
describe('交付缺口收尾（#3 / #10）', () => {
  const { expect } = require('chai');

  function makeGapSession(streamModule) {
    const sess = streamModule.createSession('stream');
    sess.streamId = 'frag-gap';
    sess.protocolMode = 'identified';
    sess.streamStarted = true;
    sess.inferenceDone = true;
    sess.lastChunkAtMs = Date.now() - 5000;
    for (const seq of [1, 2, 4]) sess.seenSeqs.add(seq);
    return sess;
  }

  it('seq 缺口 + END(complete:false)：不走正常 finish，记录 gap 与可听位置', async () => {
    const state = require('../src/fragmentEditor/state.js');
    state.setNotes([]);
    state.setCurrentProject({ bpm: 120 });
    state.setFragmentPlayStartPosition(0);
    state.setFragmentIsPlaying(false);
    state.setFragmentCurrentTime(0);
    state.setFragmentAudioContext(null);
    const streamModule = require('../src/fragmentEditor/playbackSession.js');
    streamModule._resetPlaybackSessions();

    const sess = makeGapSession(streamModule);
    await sess.noteStreamEnd({
      streamId: 'frag-gap',
      lastSeq: 4,
      complete: false,
      status: 'incomplete',
      firstFailedSeq: 4,
    });

    expect(sess.deliveryComplete).to.equal(false);
    expect(sess.deliveryIncomplete).to.equal(true);
    expect(sess.streamEndStatus).to.equal('incomplete');
    expect(sess.firstFailedSeq).to.equal(4);
    expect(sess.finished, '缺口不得走正常 finish').to.equal(false);
    expect(sess.gapDetected).to.equal(false);

    sess._finishWithGap();
    expect(sess.gapDetected, '必须显式记录缺口').to.equal(true);
    expect(sess.gapResumeSec).to.be.a('number');
    expect(sess.finished).to.equal(true);
    expect(sess.gapResumeSec, '续播位置必须落在起播点之后（不倒退）')
      .to.be.at.least(sess.startPositionSec);

    streamModule._resetPlaybackSessions();
  });

  it('END(complete:true) 且 seq 连续：按完整交付处理', async () => {
    const state = require('../src/fragmentEditor/state.js');
    state.setNotes([]);
    state.setCurrentProject({ bpm: 120 });
    state.setFragmentPlayStartPosition(0);
    state.setFragmentIsPlaying(false);
    state.setFragmentCurrentTime(0);
    state.setFragmentAudioContext(null);
    const streamModule = require('../src/fragmentEditor/playbackSession.js');
    streamModule._resetPlaybackSessions();

    const sess = makeGapSession(streamModule);
    sess.seenSeqs.add(3);
    await sess.noteStreamEnd({
      streamId: 'frag-gap',
      lastSeq: 4,
      complete: true,
      status: 'complete',
    });

    expect(sess.deliveryComplete).to.equal(true);
    expect(sess.deliveryIncomplete).to.equal(false);
    expect(sess.streamEndStatus).to.equal('complete');

    streamModule._resetPlaybackSessions();
  });
});