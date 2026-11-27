'use strict';
/**
 * 流式播放自然结束的收尾契约（P1）与非法 bpm 的边界兜底（P2）。
 *
 * 背景：`startPlayheadAnimation()` 的"播放头越过内容末尾"兜底分支原本只调
 * `_finishNaturally()`。位置是对的，但绕过了 `_finishStreamingPlayback()` 的四件
 * 收尾工作 —— 清分轨/伴奏增益表、丢弃 `state.streamingSources`、复位
 * `_streamingVocalEndSec` / `_streamingAccEndSec`、`_scheduler.deactivate()`。
 * 由于 `_scheduler` 只在 `_createScheduler()` 里赋值、从不置回 null，而
 * `getPlaybackContentEndSeconds()` 只看 `_streamingActive` 决定是否计入流式前沿，
 * `_streamingActive` 一旦残留为 true，下一轮播放就会把上一首的 `bufferEndSec`
 * 当成内容末尾（播放头不收尾，或停在上一首歌的时长处），看门狗也会一直空转。
 *
 * 另外这条路径必须停在"统一内容末尾"（含长于人声的伴奏 outro），而不是人声末端。
 *
 * P2：`projectManager` 用 `obj.project.bpm ?? 120` 载入工程，`??` 不挡 0，
 * bpm=0 时节拍→秒换算得到 Infinity，结束判定永不成立。
 *
 * 测试策略：真跑一遍 `playAll()` 的分块流式路径（`synthesizeMultiStreaming` 用
 * 假 IPC 顶掉），手动泵 rAF 帧，断言收尾后的可观测状态。
 */
const { expect } = require('chai');
const sinon = require('sinon');

// jsdom 的 rAF 挂在 window 上；本文件把它换成手动泵帧的队列。
if (!global.requestAnimationFrame) {
  global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
  global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
}

const { state, dom, trackManager } = require('../src/renderer/state.js');
const { clearTrackGains, hasLiveTracks } = require('../src/renderer/trackGainMixer.js');
const { StreamingScheduler } = require('../src/shared/streamingScheduler.js');
const ap = require('../src/renderer/audioPlayback.js');
const { TRANSPORT, setTransport } = require('../src/renderer/transport.js');
const { resetFollowForTest } = require('../src/renderer/timelineRenderer.js');

const SR = 24000;

/** 手动泵帧的 rAF：返回队列，测试自己决定跑第几帧。 */
function installManualRaf() {
  const queue = [];
  const raf = (cb) => { queue.push(cb); return queue.length; };
  const caf = () => {};
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = caf;
  global.window.requestAnimationFrame = raf;
  global.window.cancelAnimationFrame = caf;
  return queue;
}

/** 可控制 currentTime 的最小 WebAudio 替身。 */
function installFakeAudioContext() {
  const ctx = {
    state: 'running',
    currentTime: 0,
    sampleRate: SR,
    destination: {},
    outputLatency: 0,
    baseLatency: 0,
    createGain() {
      return {
        gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; }, setValueAtTime() {} },
        connect(dest) { return dest; },
        disconnect() {},
      };
    },
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate || SR,
        duration: length / (rate || SR),
        getChannelData: () => data,
      };
    },
    createBufferSource() {
      return {
        buffer: null,
        onended: null,
        connect(dest) { return dest; },
        disconnect() {},
        start() {},
        stop() {},
      };
    },
    resume() { return Promise.resolve(); },
    suspend() { return Promise.resolve(); },
  };
  global.window.AudioContext = function () { return ctx; };
  global.AudioContext = global.window.AudioContext;
  state.audioContext = null;
  state.gainNode = null;
  return ctx;
}

/** 人声 0–2s（4 拍 @120bpm）+ 伴奏 0–6s：伴奏 outro 比人声长 4s。 */
function addVocalAndLongAccompaniment() {
  const singer = trackManager.addSinger({ id: 's-end', name: 's-end', type: 'singer' });
  trackManager.addFragment({
    id: 'f-end',
    singerId: singer.id,
    startTime: 0,
    duration: 4,
    notes: [{ id: 'n-end', start: 0, duration: 2, pitch: 60, lyric: 'a' }],
  });
  const acc = trackManager.addSinger({ id: 'acc-end', name: 'acc-end', type: 'accompaniment' });
  acc.audioChannels = [new Float32Array(SR * 6)];
  acc.audioSampleRate = SR;
  acc.accompanimentStartTime = 0;
  acc.accompanimentVolume = 1;
  return { singer, acc };
}

/**
 * 顶掉主进程：`synthesizeMultiStreaming` 先按 0–2s 推一个 isLast chunk（触发
 * 首 chunk 分支 → 建立播放基准、调度伴奏、启动 rAF），再返回整段混音。
 */
function installStreamingElectronApi(vocalSamples) {
  const calls = { chunks: 0 };
  global.window.electronAPI = {
    getSettings: async () => ({}),
    audioStop: async () => ({ success: true }),
    initSVSPipeline: async () => ({ success: true }),
    onSVSProgress: () => () => {},
    onSVSLoadProgress: () => () => {},
    onSVSChunkAudio: (cb) => { calls.handler = cb; return () => {}; },
    synthesizeMultiStreaming: async () => {
      calls.chunks++;
      await calls.handler({
        audio: new Float32Array(vocalSamples).fill(0.1),
        sampleOffset: 0,
        sampleEnd: vocalSamples,
        trackId: 's-end',
        streamKey: 'default',
        streamLast: true,
        isLast: true,
      });
      return {
        audio: new Float32Array(vocalSamples),
        segments: [{ trackId: 's-end', startSample: 0, audio: new Float32Array(vocalSamples) }],
      };
    },
  };
  return calls;
}

function resetState() {
  trackManager.clearAll();
  state.isSynthesizing = false;
  state.synthesisCancelled = false;
  state.isPlaying = false;
  state.playbackPauseOffset = 0;
  state.currentAudioData = null;
  state.currentAudioSignature = null;
  state.currentAudioChannels = null;
  state.currentAudioBuffer = null;
  state.currentAudioSource = null;
  state.trackSegments = [];
  state.trackSegmentsReady = false;
  state.streamingSources = [];
  state.streamingFinished = false;
  state.trackSources = [];
  state.playheadRaf = null;
  state.pipelineInitialized = true;
  state.pipelineInitPromise = null;
  state.audioSettings = {};
  state.audioContext = null;
  state.gainNode = null;
  state.useExclusiveMode = false;
  dom.autoShiftCheck = { checked: false };
}

describe('流式播放自然结束的收尾与 bpm 兜底', () => {
  let queue;
  let ctx;
  let deactivateSpy;

  beforeEach(() => {
    resetState();
    setTransport(TRANSPORT.IDLE);
    clearTrackGains();
    queue = installManualRaf();
    ctx = installFakeAudioContext();
    // 每个用例都要重新挂钩：scheduler 实例由 playAll 内部创建，只能拦原型方法。
    deactivateSpy = sinon.spy(StreamingScheduler.prototype, 'deactivate');
  });

  afterEach(() => {
    try { ap.stopPlayback(); } catch (_) { /* ignore */ }
    sinon.restore();
    resetState();
    clearTrackGains();
    setTransport(TRANSPORT.IDLE);
    resetFollowForTest();
  });

  /** 跑一轮流式播放直到"推理完成、播放头仍在走"的状态。 */
  async function startStreamingSession() {
    addVocalAndLongAccompaniment();
    installStreamingElectronApi(SR * 2);
    await ap.playAll();
    // 首 chunk 已建立基准（playbackStartTime = ctx.currentTime + 0.05）
    expect(state.isPlaying, '流式播放应已启动').to.be.true;
    expect(hasLiveTracks(), '播放中分轨增益表必须非空').to.be.true;
    expect(state.streamingSources.length, '流式 source 应仍在册').to.be.greaterThan(0);
  }

  it('P1: 播放头越过统一末尾时走完整收尾（清增益表、丢 source、停看门狗）', async () => {
    await startStreamingSession();

    // 播到伴奏 outro 之后、但仍在旧代码 0.5s 容差窗口之内（内容末尾 6s，人声只
    // 到 2s）：这正是修复前后行为分岔的那一帧。
    ctx.currentTime = 6.1;
    queue[queue.length - 1]();

    expect(state.isPlaying, '越过内容末尾应停止播放').to.be.false;
    expect(state.playbackPauseOffset, '应停在统一末尾 6s，不是人声末端 2s').to.be.closeTo(6, 0.01);
    expect(state.streamingSources.length, '收尾必须丢弃流式 source').to.equal(0);
    expect(hasLiveTracks(), '收尾必须清空分轨/伴奏增益表（否则滑块"有值但无声"）').to.be.false;
    expect(deactivateSpy.called, '收尾必须停用 scheduler（否则看门狗永久空转）').to.be.true;
    expect(getTransportStateForTest(), 'transport 应回到 IDLE').to.equal(TRANSPORT.IDLE);
  });

  it('P1: 收尾后不再把上一轮的流式前沿算进内容末尾', async () => {
    await startStreamingSession();
    ctx.currentTime = 6.1;
    queue[queue.length - 1]();

    const afterEnd = ap.getPlaybackContentEndSeconds();
    // 人声 2s + 伴奏 6s → 统一末尾仍是 6s；若 _streamingActive 残留，这里会把
    // 上一轮的 bufferEndSec / _streamingAccEndSec 继续计入（值相同则更难发现，
    // 因此同时断言"改短工程后边界会跟着变"）。
    expect(afterEnd, '收尾后边界不应被流式前沿放大').to.be.closeTo(6, 0.01);

    trackManager.getSingers()
      .filter((s) => s.type === 'accompaniment')
      .forEach((s) => { s.audioChannels = [new Float32Array(SR * 3)]; });
    state.trackSegments = [{ trackId: 's-end', startSample: 0, audio: new Float32Array(SR * 2) }];
    state.trackSegmentsReady = true;
    state.currentAudioData = new Float32Array(SR * 2);
    expect(ap.getPlaybackContentEndSeconds(), '伴奏改短后边界必须跟着缩短')
      .to.be.closeTo(3, 0.01);
  });

  it('P2: bpm=0 的工程（文件可写入）内容末尾仍为有限值且能正常收尾', async () => {
    state.project = { bpm: 0 };
    addVocalAndLongAccompaniment();
    installStreamingElectronApi(SR * 2);
    await ap.playAll();

    const end = ap.getPlaybackContentEndSeconds();
    expect(Number.isFinite(end), '非法 bpm 不得把内容末尾变成 Infinity').to.be.true;
    expect(end, 'bpm 兜底为 120 → 4 拍人声 = 2s，伴奏 outro 6s').to.be.closeTo(6, 0.01);

    ctx.currentTime = 6.1;
    queue[queue.length - 1]();
    expect(state.isPlaying, 'bpm=0 时播放头也必须能收尾').to.be.false;
  });
});

function getTransportStateForTest() {
  // 单独 require 以避免顶部循环依赖噪音
  return require('../src/renderer/transport.js').getTransportState();
}
