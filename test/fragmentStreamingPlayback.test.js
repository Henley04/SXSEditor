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

/**
 * 带真实采样位置的 chunk（主流水线形态）。
 * @param {number} relStartSec 相对首音符起点的内容起点
 * @param {number} durSec 音频时长
 * @param {boolean} isLast
 */
function makeChunkAt(relStartSec, durSec, isLast) {
  return {
    chunkIndex: 0,
    sampleOffset: Math.round(relStartSec * SAMPLE_RATE),
    sampleEnd: Math.round((relStartSec + durSec) * SAMPLE_RATE),
    audio: new Float32Array(Math.round(durSec * SAMPLE_RATE)).fill(0.1),
    totalSamples: Math.round(32 * SAMPLE_RATE),
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

  it('underrun 恢复后第二段无缝衔接：不重置时间基准、不凭空延迟（播放头连续）', async () => {
    // 回归：rAF 在「播放头到达前沿」处冻结（curTime >= bufferEndSec），此刻
    // ctx.currentTime 已 ≈ streamingNextStart。旧实现的迟到判断在此误命中 →
    // 重置时间基准 → 第二段被推迟 0.05s 且播放头回跳（第二段延迟 + 声画错位）。
    chunkCb(makeChunk(14, false));
    await sleep(60);
    expect(ctx.sources, '首个 chunk 已开播').to.have.lengthOf(1);
    const firstEnd = ctx.sources[0].startWhen + 14; // 0.05 + 14 = 14.05
    const baseBefore = state.getFragmentPlaybackStartTime();

    // 精确推到前沿冻结点：curTime = ctx.t - base = 14 → 冻结
    ctx.t = 14 + baseBefore;
    await sleep(150);
    expect(ctx.state, '播放头到达前沿应冻结').to.equal('suspended');

    chunkCb(makeChunk(12, true));
    await sleep(150);
    expect(ctx.state, '新 chunk 到达后必须解冻').to.equal('running');
    expect(ctx.sources, '第二个 chunk 必须被排程').to.have.lengthOf(2);
    const second = ctx.sources[1];
    // 第二段紧接第一段末端（无缝），不能被推迟到 firstEnd + 0.05
    expect(second.startWhen, '第二段应无缝衔接第一段末端，不得凭空延迟').to.be.at.most(firstEnd + 0.001);
    // 时间基准不动 → 播放头连续，不回跳
    expect(state.getFragmentPlaybackStartTime(), 'underrun 恢复不得重置时间基准').to.equal(baseBefore);

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

    // 旧断言是「冻结期间 rAF 应已取消」——那是实现细节，不是要保的性质。
    // suspend 是异步控制消息：落地之前音频照常出声，此刻掐掉循环会让播放头
    // 比声音早停一段控制延迟（极端负载实测 0.3–0.5s），正是"播放头卡住 +
    // 声画错位"。现在循环保持存活，要保的性质改为：时钟冻结 ⇒ 播放头原地不动。
    const headAtFreeze = state.getFragmentCurrentTime();
    await sleep(120);
    expect(state.getFragmentCurrentTime(), '时钟冻结期间播放头必须原地停住（不得冲进静音区）')
      .to.equal(headAtFreeze);

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

  // ===== 绝对位置调度（回归：声音重复 / 越播越晚 / 播放头回跳） =====

  it('带重叠的分块：同一段内容只放一次，第二段紧接第一段末端', async () => {
    // 扩散分块自带 diffStepOverlapFrames 重叠（默认 50 帧 ≈ 1s）：chunk2 的
    // 内容起点落在 chunk1 末端之前。旧实现按到达顺序"接尾巴"，重叠段会被
    // 再播一遍（用户听到的"声音重复"），且误差逐块累加（播放头与实际越来越远）。
    chunkCb(makeChunkAt(0, 4, false));
    await sleep(60);
    expect(ctx.sources, '首个 chunk 已开播').to.have.lengthOf(1);
    const first = ctx.sources[0];

    chunkCb(makeChunkAt(3, 5, true)); // 内容 3..8，与 0..4 重叠 1s
    await sleep(60);
    expect(ctx.sources, '第二个 chunk 必须被排程').to.have.lengthOf(2);
    const second = ctx.sources[1];

    expect(second.startWhen - first.startWhen, '第二段应紧接第一段末端（不重复 1s）')
      .to.be.closeTo(4, 0.02);
    // 重叠部分在入队前就被裁掉（subarray），缓冲区只剩 4s
    expect(second.buffer.duration, '重叠的 1s 必须从头部裁掉').to.be.closeTo(4, 0.02);
    expect(second.startWhen + second.buffer.duration - second.startOffset, '总时长应为 8s')
      .to.be.closeTo(first.startWhen + 8, 0.02);

    resolveSynth(new Float32Array(8 * SAMPLE_RATE));
    await playPromise;
    await sleep(20);
  });

  it('迟到 chunk 只裁头、不移动时间基准（播放头不回跳）', async () => {
    chunkCb(makeChunkAt(0, 4, false));
    await sleep(60);
    const base = state.getFragmentPlaybackStartTime();
    const firstWhen = ctx.sources[0].startWhen;

    // 播放头越过前沿 → underrun 冻结
    ctx.t = firstWhen + 4 + 0.2;
    await sleep(150);
    expect(ctx.state, '应进入等待推理').to.equal('suspended');

    // 真实时钟不随假 ctx.t，迟到量由 ctx.currentTime 决定：把时钟推进到 5.2
    ctx.t = firstWhen + 5.2;
    chunkCb(makeChunkAt(4, 4, true));
    await sleep(120);

    expect(state.getFragmentPlaybackStartTime(), 'underrun 恢复不得重建时间基准').to.equal(base);
    const second = ctx.sources[1];
    expect(second.startOffset, '迟到 1.2s 应从头部裁掉，内容位置不变').to.be.closeTo(1.2, 0.05);
    expect(second.startWhen, '排程时刻 = 当前时钟（不往后推）').to.be.closeTo(ctx.t, 0.05);

    resolveSynth(new Float32Array(8 * SAMPLE_RATE));
    await playPromise;
    await sleep(20);
  });

  it('起播位置之后的第一个 chunk 从起播点开播，之前的整块丢弃（不丢内容、不回跳）', async () => {
    state.setFragmentPlayStartPosition(8);
    // 已注册的监听在 playFragment 内；重新起一轮以拾取新的起播位置
    audioPlayback.cancelFragmentSynthesis();
    playPromise = audioPlayback.playFragment();
    await sleep(60);
    expect(chunkCb, 'chunk 监听应已重新注册').to.be.a('function');

    chunkCb(makeChunkAt(0, 4, false));  // 全在起播点之前 → 丢弃
    chunkCb(makeChunkAt(4, 4, false));  // 全在起播点之前 → 丢弃
    await sleep(60);
    expect(ctx.sources, '起播点之前的 chunk 不应产生音频').to.have.lengthOf(0);

    chunkCb(makeChunkAt(8, 4, true));   // 命中起播点
    await sleep(60);
    expect(ctx.sources, '起播点所在的 chunk 必须开播').to.have.lengthOf(1);
    const src = ctx.sources[0];
    expect(src.startOffset, '起播点正好是内容起点，无需裁头').to.be.closeTo(0, 0.02);
    expect(src.startWhen, '开播时刻 = 时间基准（播放头立即从 8s 前进）')
      .to.be.closeTo(state.getFragmentPlaybackStartTime(), 0.05);
    expect(state.getFragmentPlaybackStartTime()).to.equal(state.getFragmentPlaybackStartTime());

    resolveSynth(new Float32Array(12 * SAMPLE_RATE));
    await playPromise;
    await sleep(20);
  });

  it('旧会话已在途的 chunk 不得污染有序队列：新会话首块不能被当成重复丢弃', async () => {
    // 监听器移除后，已派发的 IPC 回调仍可能到达（见 stopStreamingPlayback 注释）。
    // 会话守卫若排在 _chunkQueue.push 之后，旧会话块会先推进队列前沿再被下游拒掉，
    // 新会话首块随后被误判为 duplicate 整块丢弃 → 起播静音。
    const staleCb = chunkCb;
    expect(staleCb, '会话 1 监听应已注册').to.be.a('function');

    audioPlayback.cancelFragmentSynthesis();
    playPromise = audioPlayback.playFragment();
    await sleep(60);
    expect(chunkCb, '会话 2 监听应已重新注册').to.be.a('function');
    expect(chunkCb, '应是新一轮的监听器').to.not.equal(staleCb);

    // 旧会话在途块：内容区间与新会话首块完全相同
    staleCb(makeChunkAt(0, 4, false));
    await sleep(30);
    expect(ctx.sources, '旧会话的块不得排程').to.have.lengthOf(0);

    chunkCb(makeChunkAt(0, 4, false));
    await sleep(60);
    expect(ctx.sources, '新会话首块必须开播，不能被旧会话污染成重复').to.have.lengthOf(1);

    resolveSynth(new Float32Array(4 * SAMPLE_RATE));
    await playPromise;
    await sleep(20);
  });
});
