/**
 * 主窗口"推理进行中再次播放"的语义回归。
 *
 * 背景（用户报告）：分片流式推理开始后拖拽进度条，即使拖到已经推理过的位置也
 * 播不出声音，按播放按钮也没反应；只有先按"取消推理"再按播放才能从头重播。
 *
 * 三条成因，本测试各钉一条：
 *   1. playAll() 开头是 `if (state.isSynthesizing) return;` —— 流式播放被拖拽
 *      暂停后传输条已是 PAUSED（Play 可点、文案"播放"），点下去被这行静默吞掉。
 *      现在必须"放弃旧会话、从当前起点重来"。
 *   2. 放弃旧会话若不做，新请求会排在主进程 _withSynthMutex 后面等旧任务跑完，
 *      用户看到的仍是"没反应"。必须真的发 cancel。
 *   3. 旧实现唯一的出口是 stopPlayback()，它把 playbackPauseOffset 清成 0 ——
 *      于是下一次播放只能"从头"。放弃会话必须保留用户选定的起点。
 *
 * 注：这里只覆盖"放弃会话"这一段可观测契约（不涉及真实音频/AudioContext），
 * 音画对齐由 test/multiSegmentStreamEmitter.test.js 与 streamingScheduler 相关
 * 用例负责。
 */
const { expect } = require('chai');

// jsdom 的 rAF 挂在 window 上；alertDialog 等模块直接用全局 requestAnimationFrame
if (!global.requestAnimationFrame) {
  global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
  global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
}

const { state, dom, trackManager } = require('../src/renderer/state.js');
const { playAll, stopPlayback } = require('../src/renderer/audioPlayback.js');
const { TRANSPORT, setTransport, getTransportState } = require('../src/renderer/transport.js');

/** 造一个可观测的假 AudioBufferSourceNode */
function makeFakeSource() {
  return {
    stopped: false,
    onended: null,
    stop() { this.stopped = true; },
  };
}

/** jsdom 没有 WebAudio；只提供 chunk 排程会用到的最小接口。 */
function installFakeAudioContext() {
  let sourceCount = 0;
  class FakeGain {
    constructor() { this.gain = { value: 1, setValueAtTime() {}, setTargetAtTime() {} }; }
    connect() { return this; }
    disconnect() {}
  }
  class FakeBuffer {
    constructor(length) { this.length = length; this.duration = length / 24000; this._data = new Float32Array(length); }
    getChannelData() { return this._data; }
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
    createBufferSource() { sourceCount++; return new FakeSource(); }
    suspend() { return Promise.resolve(); }
    resume() { return Promise.resolve(); }
  }
  window.AudioContext = function () { return new FakeCtx(); };
  return { get sourceCount() { return sourceCount; } };
}

function installElectronApi(overrides = {}) {
  const calls = { cancel: 0, settings: 0, synth: 0 };
  global.window.electronAPI = {
    cancelSVSSynthesis: async () => { calls.cancel++; return { success: true }; },
    getSettings: async () => { calls.settings++; return {}; },
    audioStop: async () => ({ success: true }),
    initSVSPipeline: async () => ({ success: true }),
    onSVSProgress: () => () => {},
    onSVSChunkAudio: () => () => {},
    synthesizeMultiStreaming: async () => { calls.synth++; return new Float32Array(0); },
    synthesizeSVS: async () => { calls.synth++; return new Float32Array(0); },
    ...overrides,
  };
  return calls;
}

function resetState() {
  // 工程必需为空：playAll 才会走"没有分片"的早退分支。trackManager 是跨测试
  // 文件共享的模块级单例（别的文件会往里塞 3 轨 × 4 分片），不清掉这里就会真的
  // 走到推理/混音路径（需要 AudioContext 与完整 DOM）。
  trackManager.clearAll();
  state.isSynthesizing = false;
  state.synthesisCancelled = false;
  state.isPlaying = false;
  state.playbackPauseOffset = 0;
  state.currentAudioData = null;
  state.currentAudioChannels = null;
  state.currentAudioBuffer = null;
  state.streamingSources = [];
  state.streamingFinished = false;
  state.pipelineInitialized = true;
  state.pipelineInitPromise = null;
  state.audioSettings = {};
  state.playheadRaf = null;
  state.audioContext = null;
  state.gainNode = null;
  dom.autoShiftCheck = null;
  // 工程为空：playAll 会走"没有分片"的早退分支，避免真的去建管线
  if (global.window.alert) global.window.alert = () => {};
}

describe('renderer playAll — 推理进行中再次播放', () => {
  beforeEach(() => {
    resetState();
    setTransport(TRANSPORT.IDLE);
  });

  afterEach(() => {
    resetState();
    setTransport(TRANSPORT.IDLE);
  });

  it('取消在跑的推理并保留用户选定的起点（不再静默 return、也不会"从头"）', async () => {
    const calls = installElectronApi();
    const fake = makeFakeSource();
    state.isSynthesizing = true;
    state.isPlaying = true;
    state.playbackPauseOffset = 12.5;
    state.streamingSources = [fake];
    // 模拟"流式播放被拖拽暂停后"的传输条状态
    setTransport(TRANSPORT.PAUSED);

    await playAll();

    expect(calls.cancel, '必须真的向主进程发取消，否则新请求排队等旧任务跑完').to.equal(1);
    expect(fake.stopped, '旧的流式 source 必须停掉，不能与新会话叠音').to.equal(true);
    expect(state.streamingSources.length).to.equal(0);
    expect(state.playbackPauseOffset, '拖拽/暂停位置是新会话的起点，不能被清成 0').to.equal(12.5);
  });

  it('模型加载中（LOADING）不允许中断：取消会作废正在初始化的 pipeline 实例', async () => {
    const calls = installElectronApi();
    state.isSynthesizing = true;
    setTransport(TRANSPORT.LOADING);

    await playAll();

    expect(calls.cancel).to.equal(0);
    expect(getTransportState(), '加载态保持不动').to.equal(TRANSPORT.LOADING);
  });

  it('没有在跑的推理时不会误发 cancel', async () => {
    const calls = installElectronApi();
    state.playbackPauseOffset = 3;
    setTransport(TRANSPORT.IDLE);

    await playAll();

    expect(calls.cancel).to.equal(0);
  });

  // 用户报告：主页面加载模型时按"停止推理"，界面回到 IDLE，但模型加载完成后
  // playAll 从 await 处续跑，继续推理；旧会话 chunk 还会重启播放头与播放。
  function addOneFragment() {
    const singer = trackManager.addSinger({ id: 's-load-stop', type: 'singer' });
    trackManager.addFragment({
      id: 'f-load-stop',
      singerId: singer.id,
      startTime: 0,
      duration: 4,
      notes: [{ id: 'n-load-stop', start: 0, duration: 2, pitch: 60, lyric: 'a' }],
    });
  }

  function installPendingInit() {
    let signalInitCalled;
    let releaseInit;
    const initCalled = new Promise((resolve) => { signalInitCalled = resolve; });
    const initGate = new Promise((resolve) => { releaseInit = resolve; });
    const calls = installElectronApi({
      initSVSPipeline: async () => { signalInitCalled(); return initGate; },
    });
    state.pipelineInitialized = false;
    state.pipelineInitPromise = null;
    return { calls, initCalled, releaseInit };
  }

  it('模型加载中按停止：加载完成后不得继续推理，也不得重启播放头', async () => {
    const { calls, initCalled, releaseInit } = installPendingInit();
    addOneFragment();

    const pending = playAll();
    await initCalled;
    expect(getTransportState(), '加载阶段必须可见').to.equal(TRANSPORT.LOADING);

    stopPlayback();
    expect(getTransportState()).to.equal(TRANSPORT.IDLE);
    // LOADING 阶段不能发 cancel IPC：主进程会 reset 正在初始化的 lazy 实例。
    expect(calls.cancel).to.equal(0);

    releaseInit({ success: true });
    await pending;

    expect(calls.synth, '加载完成后旧会话不得发起推理').to.equal(0);
    expect(state.isSynthesizing).to.equal(false);
    expect(state.isPlaying).to.equal(false);
    expect(getTransportState()).to.equal(TRANSPORT.IDLE);
    expect(state.playheadRaf, '播放头动画不得被旧会话重启').to.equal(null);
  });

  it('加载中停止后立刻重新播放：新会话照常推理，旧会话不再插手', async () => {
    const { calls, initCalled, releaseInit } = installPendingInit();
    // jsdom 没有 index.html 里的复选框，这个字段只被读取 checked。
    dom.autoShiftCheck = { checked: false };
    // 走流式路径：空 chunk 结果不会触发真实 AudioContext（jsdom 没有 WebAudio）。
    window.electronAPI.getSettings = async () => ({ previewDiffStepChunkEnabled: true });
    addOneFragment();

    const stale = playAll();
    await initCalled;
    stopPlayback();
    const fresh = playAll();
    releaseInit({ success: true });
    await Promise.all([stale, fresh]);

    expect(calls.synth, '只有新会话允许发起一次推理').to.equal(1);
    expect(state.isSynthesizing).to.equal(false);
    expect(getTransportState()).to.equal(TRANSPORT.IDLE);
    stopPlayback(); // 清掉流式 watchdog，避免 timer 泄漏到后续用例
  });

  it('停止后迟到的流式 chunk 不得重启播放头与重复播放', async () => {
    let emitChunk;
    let releaseSynth;
    const synthGate = new Promise((resolve) => { releaseSynth = resolve; });
    installElectronApi({
      getSettings: async () => ({ previewDiffStepChunkEnabled: true }),
      onSVSChunkAudio: (handler) => { emitChunk = handler; return () => { emitChunk = null; }; },
      synthesizeMultiStreaming: async () => synthGate,
    });
    dom.autoShiftCheck = { checked: false };
    addOneFragment();
    const audio = installFakeAudioContext();

    const pending = playAll();
    await new Promise((resolve) => setImmediate(resolve)); // 等 chunk 监听器注册
    expect(emitChunk, '流式会话必须已注册 chunk 监听器').to.be.a('function');

    await emitChunk({ audio: new Float32Array(4410), sampleOffset: 0, sampleEnd: 4410 });
    expect(state.isPlaying, '首个 chunk 正常起播').to.equal(true);
    expect(audio.sourceCount).to.equal(1);
    const firstStart = state.playbackStartTime;

    stopPlayback();
    expect(state.isPlaying).to.equal(false);
    await emitChunk({ audio: new Float32Array(4410), sampleOffset: 4410, sampleEnd: 8820 });
    expect(state.isPlaying, '停止后的迟到 chunk 不得重新起播').to.equal(false);
    expect(audio.sourceCount, '迟到 chunk 不得再排新的音频 source').to.equal(1);
    expect(state.playbackStartTime, '时间基准不得被迟到 chunk 重置').to.equal(firstStart);
    expect(getTransportState()).to.equal(TRANSPORT.IDLE);

    releaseSynth(new Float32Array(0));
    await pending;
  });
});
