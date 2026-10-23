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

const { state, trackManager } = require('../src/renderer/state.js');
const { playAll } = require('../src/renderer/audioPlayback.js');
const { TRANSPORT, setTransport, getTransportState } = require('../src/renderer/transport.js');

/** 造一个可观测的假 AudioBufferSourceNode */
function makeFakeSource() {
  return {
    stopped: false,
    onended: null,
    stop() { this.stopped = true; },
  };
}

function installElectronApi(overrides = {}) {
  const calls = { cancel: 0, settings: 0, synth: 0 };
  global.window.electronAPI = {
    cancelSVSSynthesis: async () => { calls.cancel++; return { success: true }; },
    getSettings: async () => { calls.settings++; return {}; },
    audioStop: async () => ({ success: true }),
    initSVSPipeline: async () => ({ success: true }),
    onSVSProgress: () => () => {},
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
  state.playheadRaf = null;
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
});
