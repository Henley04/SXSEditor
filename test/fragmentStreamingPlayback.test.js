/**
 * 回归：分片编辑器流式预览的两个致命问题（用户报告）
 *
 *   1. 停止按钮不能像主页面那样取消推理：
 *      · 首个 chunk 到达前按钮被禁用，流式期间点停止也不通知主进程 →
 *        GPU 仍把整段推理跑完，期间无法再次播放。
 *   2. 只能播放第一段音频，第二段起播放条继续走但没有声音：
 *      underrun 恢复时旧实现"先解冻 + 重启播放头，再排程/推进前沿"，重启的
 *      rAF 立刻用**旧**前沿判定 underrun（curTime 正好停在前沿上），刚解冻的
 *      context 又被 suspend，新到的 chunk 虽然 start() 了却始终不出声。
 *
 * 本文件用假 AudioContext 驱动真实的 fragmentEditor/audioPlayback.js：
 * 时间可手动推进，suspend/resume 可观测，chunk 通过 onFragmentSVSChunkAudio
 * 回调注入。
 */
const { expect } = require('chai');
const sinon = require('sinon');

const SAMPLE_RATE = 24000;

// audioPlayback.js 用裸全局 requestAnimationFrame / Node（jsdom 把它们挂在 window 上）
global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
global.Node = global.window.Node;
global.Element = global.window.Element;
global.HTMLElement = global.window.HTMLElement;

// 模块加载期就需要存在的 DOM（canvasRenderer / audioPlayback 直接 getElementById）
function ensureDom() {
  // 其他用例会整块替换 document.body（如 fragmentMidiExport 重建 canvas），
  // 所以每个用例开始前都要补齐这些节点，不能只在文件加载时建一次。
  for (const id of ['piano-roll', 'piano-keys']) {
    if (!document.getElementById(id)) {
      const c = document.createElement('canvas');
      c.id = id;
      document.body.appendChild(c);
    }
  }
  if (!document.getElementById('autoShiftCheck')) {
    const autoShiftCheck = document.createElement('input');
    autoShiftCheck.type = 'checkbox';
    autoShiftCheck.id = 'autoShiftCheck';
    document.body.appendChild(autoShiftCheck);
  }
  if (!document.getElementById('btn-play-fragment')) {
    const btn = document.createElement('button');
    btn.id = 'btn-play-fragment';
    document.body.appendChild(btn);
  }
}
ensureDom();

class FakeGain {
  constructor() { this.gain = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }; }
  connect(n) { return n; }
  disconnect() {}
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.sampleRate = SAMPLE_RATE;
    this.t = 0;
    this.destination = {};
    this.outputLatency = 0.02;
    this.baseLatency = 0.01;
    this.sources = [];
    this.suspendCalls = 0;
    this.resumeCalls = 0;
  }
  get currentTime() { return this.t; }
  createGain() { return new FakeGain(); }
  createStereoPanner() {
    return {
      pan: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} },
      connect(n) { return n; },
      disconnect() {},
    };
  }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return {
      length,
      numberOfChannels: channels,
      sampleRate: rate,
      duration: length / rate,
      getChannelData: () => data,
    };
  }
  createBufferSource() {
    const ctx = this;
    const src = {
      buffer: null,
      onended: null,
      startWhen: null,
      startOffset: null,
      stopped: false,
      connect(n) { this.dest = n; return n; },
      start(when, offset) {
        this.startWhen = when;
        this.startOffset = offset || 0;
        ctx.sources.push(this);
      },
      stop() { this.stopped = true; },
    };
    return src;
  }
  async suspend() { this.suspendCalls += 1; this.state = 'suspended'; }
  async resume() { this.resumeCalls += 1; this.state = 'running'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeChunk(seconds, isLast) {
  return {
    chunkIndex: 0,
    sampleOffset: 0,
    sampleEnd: 0,
    audio: new Float32Array(Math.round(seconds * SAMPLE_RATE)).fill(0.1),
    totalSamples: 0,
    isLast,
  };
}

describe('分片编辑器流式播放（underrun 恢复 / 取消推理）', () => {
  let ctx;
  let state;
  let alertModule;
  let electronAPI;
  let chunkCb = null;
  let resolveSynth = null;
  let rejectSynth = null;
  let playPromise = null;
  let audioPlayback;

  beforeEach(async () => {
    ensureDom();
    ctx = new FakeAudioContext();
    const shared = ctx;
    global.window.AudioContext = function () { return shared; };
    global.AudioContext = global.window.AudioContext;

    chunkCb = null;
    resolveSynth = null;
    rejectSynth = null;
    electronAPI = {
      getSettings: sinon.stub().resolves({
        audioOutputMode: 'shared',
        audioVolume: 1,
        previewDiffStepChunkEnabled: true,
      }),
      onFragmentSVSChunkAudio: sinon.stub().callsFake((cb) => {
        chunkCb = cb;
        return () => { chunkCb = null; };
      }),
      synthesizeFragmentSVS: sinon.stub().callsFake(() => new Promise((res, rej) => {
        resolveSynth = res;
        rejectSynth = rej;
      })),
      onAudioEnded: sinon.stub().returns(() => {}),
      audioStop: sinon.stub().resolves({ success: true }),
      getFragmentSVSSampleRate: sinon.stub().resolves(SAMPLE_RATE),
      cancelSVSSynthesis: sinon.stub().resolves({ success: true }),
    };
    global.window.electronAPI = electronAPI;

    state = require('../src/fragmentEditor/state.js');
    state.setPipelineInitialized(true);
    state.setSampleRate(SAMPLE_RATE);
    state.setFragmentAudioSettings({
      audioOutputMode: 'shared',
      audioVolume: 1,
      previewDiffStepChunkEnabled: true,
    });
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
    // 同进程内其他用例可能留下导出/后台推理标记（playFragment 会据此提前返回）
    state.setFragmentIsExporting(false);
    state.setFragmentIsAutoInferring(false);
    // 音频上下文是模块级缓存：不清掉的话本用例会复用上一个用例的假 ctx，
    // 断言拿不到新排的 source。
    state.setFragmentAudioContext(null);
    state.setFragmentGainNode(null);
    state.setFragmentAudioSource(null);

    alertModule = require('../src/alertDialog.js');
    audioPlayback = require('../src/fragmentEditor/audioPlayback.js');
    playPromise = audioPlayback.playFragment();
    await sleep(60);
  });

  afterEach(() => {
    // 收尾：取消在途推理并复位，避免用例之间互相污染
    if (state.getFragmentIsSynthesizing()) audioPlayback.cancelFragmentSynthesis();
    else audioPlayback.stopFragmentPlayback();
    if (rejectSynth) rejectSynth(new Error('Synthesis cancelled'));
    rejectSynth = null;
    // 吞掉未完成的 playFragment promise
    if (playPromise) playPromise.catch(() => {});
    playPromise = null;
    global.window.electronAPI = undefined;
  });

  it('第二个 chunk 在 underrun 冻结后到达：解除冻结并排程，不能再被挂起', async () => {
    expect(chunkCb, 'chunk 监听应已注册').to.be.a('function');

    chunkCb(makeChunk(14, false));
    await sleep(60);
    expect(ctx.sources, '首个 chunk 已开播').to.have.lengthOf(1);

    // 播放头跑到已交付音频的末端 → underrun 冻结
    ctx.t = 14.2;
    await sleep(150);
    expect(ctx.state, '到达缓冲前沿后应冻结 context').to.equal('suspended');

    // 第二段推理完成
    chunkCb(makeChunk(12, true));
    await sleep(150);

    expect(ctx.state, '新 chunk 到达后必须解冻，否则第二段永远没声音').to.equal('running');
    expect(ctx.sources, '第二个 chunk 必须被排程').to.have.lengthOf(2);
    const second = ctx.sources[1];
    expect(second.startWhen).to.be.greaterThan(14);
    expect(second.startWhen).to.be.lessThan(15);
    expect(ctx.suspendCalls, '不得出现"解冻 → 立刻再挂起"的自锁').to.equal(1);

    resolveSynth(new Float32Array(26 * SAMPLE_RATE));
    await playPromise;
    await sleep(20);
  });

  it('合成结束（后续无 chunk）时解除冻结并重启播放头循环', async () => {
    chunkCb(makeChunk(14, true));
    await sleep(60);
    ctx.t = 14.2;
    await sleep(150);
    expect(ctx.state, '到达缓冲前沿后应冻结 context').to.equal('suspended');
    expect(state.getFragmentPlayheadRaf(), '冻结期间播放头 rAF 应已取消').to.equal(null);

    // 这一段就是最后一个 chunk：不会再有回调来解冻，只能靠 setInferenceDone
    resolveSynth(new Float32Array(14 * SAMPLE_RATE));
    await playPromise;
    await sleep(60);

    expect(ctx.state, '合成结束必须解冻').to.equal('running');
    expect(state.getFragmentPlayheadRaf(), '解冻后播放头要接着走，不能停在接缝处').to.be.a('number');
  });

  it('停止（取消推理）通知主进程取消，立即释放重入锁且不弹失败框', async () => {
    expect(state.getFragmentIsSynthesizing()).to.equal(true);

    const alertStub = sinon.stub(alertModule, 'showAlertDialog').resolves();
    try {
      const cancelled = audioPlayback.cancelFragmentSynthesis();
      expect(cancelled).to.equal(true);
      expect(electronAPI.cancelSVSSynthesis.calledOnce, '必须通知主进程停止推理').to.equal(true);
      expect(state.getFragmentIsSynthesizing(), '重入锁要立即释放').to.equal(false);
      expect(state.getFragmentIsPlaying()).to.equal(false);

      // 主进程协作式取消 → IPC 拒绝
      rejectSynth(new Error('Synthesis cancelled'));
      await playPromise;
      await sleep(10);
      expect(alertStub.called, '取消不是失败，不能弹"合成失败"').to.equal(false);
      expect(state.getFragmentIsSynthesizing()).to.equal(false);
    } finally {
      alertStub.restore();
    }
  });

  it('取消后立即重播：旧会话的收尾不得停掉新一轮播放', async () => {
    const alertStub = sinon.stub(alertModule, 'showAlertDialog').resolves();
    try {
      audioPlayback.cancelFragmentSynthesis();
      const oldPromise = playPromise;
      const oldReject = rejectSynth;

      // 新一轮播放
      playPromise = audioPlayback.playFragment();
      await sleep(50);
      const newReject = rejectSynth;
      expect(newReject, '新一轮应重新进入合成').to.be.a('function');

      // 旧会话此刻才收到取消异常
      oldReject(new Error('Synthesis cancelled'));
      await oldPromise;
      await sleep(20);
      expect(state.getFragmentIsSynthesizing(), '旧会话不得清掉新一轮的重入锁').to.equal(true);

      audioPlayback.cancelFragmentSynthesis();
      newReject(new Error('Synthesis cancelled'));
      await playPromise;
      expect(alertStub.called).to.equal(false);
    } finally {
      alertStub.restore();
    }
  });
});
