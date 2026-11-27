'use strict';
/**
 * 计划 4.6：独占输出模式的实时 M/S。
 *
 * 独占只有一条 PCM 流，M/S 变化必须按当前可听性重建人声混音并从耳朵听到的
 * 位置续播（40ms 防抖合并快速连点），播放头 / 传输态不跳变。
 *
 *   · _buildAudibleVocalMono：有 segments 时只叠加可听轨；无 segments 时回退
 *     currentAudioData（向后兼容）。
 *   · 伴奏随 Solo 静音（computeAudibility 规则 3）。
 *   · trackGainMixer 在无 WebAudio 节点（独占模式）时也要通知订阅者——这是
 *     本次修正的语义，否则 M/S 在独占模式收不到重建信号。
 *   · 订阅回调只在独占在播时响应；共享模式靠 GainNode 零中断，不重启。
 */
const { expect } = require('chai');
const sinon = require('sinon');

if (!global.requestAnimationFrame) {
  global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
  global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
}

const { state, trackManager } = require('../src/renderer/state.js');
const {
  startExclusivePlayback,
  stopExclusivePlayback,
} = require('../src/renderer/audioPlayback.js');
const {
  applyAudibility,
  clearTrackGains,
  subscribeAudibilityChange,
} = require('../src/renderer/trackGainMixer.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installMinimalElectronApi(onPlay) {
  let seq = 0;
  global.window.electronAPI = {
    audioStop: async () => ({ success: true }),
    audioPlay: async (data, options) => {
      seq += 1;
      if (onPlay) onPlay({ data, options, seq });
      return { success: true };
    },
    onAudioEnded: () => () => {},
  };
}

describe('独占输出：按可听性重建 PCM（4.6）', () => {
  let rafStub;

  beforeEach(() => {
    rafStub = sinon.stub(global, 'requestAnimationFrame').returns(1);
    trackManager.clearAll();
    clearTrackGains();
    state.isSynthesizing = false;
    state.synthesisCancelled = false;
    state.isPlaying = false;
    state.playbackPauseOffset = 0;
    state.playbackStartTime = 0;
    state.currentAudioSource = null;
    state.audioContext = null;
    state.currentAudioData = null;
    state.currentAudioChannels = null;
    state.currentAudioBuffer = null;
    state.trackSegments = [];
    state.trackSegmentsReady = false;
    state.streamingSources = [];
    state.streamingFinished = false;
    state.playheadRaf = null;
    state.exclusivePlaybackRaf = null;
    state.useExclusiveMode = true;
    state.audioSettings = {};
    state.project = { bpm: 120 };
  });

  afterEach(() => {
    stopExclusivePlayback();
    rafStub.restore();
    trackManager.clearAll();
    clearTrackGains();
    state.trackSegments = [];
    state.trackSegmentsReady = false;
    state.currentAudioData = null;
    state.isPlaying = false;
  });

  it('有 segments 时只把可听轨的分片混进独占 PCM（Mute 轨被排除）', async () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    const s2 = trackManager.addSinger({ name: 's2', type: 'singer', mute: true });
    state.trackSegments = [
      { trackId: s1.id, startSample: 0, audio: new Float32Array(64).fill(0.2) },
      { trackId: s2.id, startSample: 0, audio: new Float32Array(64).fill(0.7) },
    ];
    state.trackSegmentsReady = true;

    let sent = null;
    installMinimalElectronApi(({ data }) => { sent = data; });

    await startExclusivePlayback(0);

    expect(sent).to.be.instanceOf(Float32Array);
    // 静音轨 0.7 未进混音，只有 s1 的 0.2
    expect(sent[0], 'Mute 轨分片不得进入独占 PCM').to.be.closeTo(0.2, 1e-5);
  });

  it('Solo 时其余人声与伴奏都被排除，只有 Solo 轨发声', async () => {
    const solo = trackManager.addSinger({ name: 'solo', type: 'singer', solo: true });
    const other = trackManager.addSinger({ name: 'other', type: 'singer' });
    const acc = trackManager.addSinger({ type: 'accompaniment', accompanimentStartTime: 0, accompanimentVolume: 1 });
    const accBuf = new Float32Array(64).fill(0.9);
    acc.audioBuffer = accBuf;
    acc.audioChannels = [accBuf];
    state.trackSegments = [
      { trackId: solo.id, startSample: 0, audio: new Float32Array(64).fill(0.3) },
      { trackId: other.id, startSample: 0, audio: new Float32Array(64).fill(0.6) },
    ];
    state.trackSegmentsReady = true;

    let sent = null;
    installMinimalElectronApi(({ data }) => { sent = data; });

    await startExclusivePlayback(0);

    // 只有 solo 轨 0.3；other 与伴奏 0.9 都不在
    expect(sent[0], 'Solo 时只应听到被 Solo 轨').to.be.closeTo(0.3, 1e-5);
  });

  it('无 segments 时回退 currentAudioData，保持向后兼容', async () => {
    state.currentAudioData = new Float32Array(48).fill(0.15);
    state.trackSegmentsReady = false;
    installMinimalElectronApi();

    let sent = null;
    global.window.electronAPI.audioPlay = async (data) => { sent = data; return { success: true }; };

    await startExclusivePlayback(0);

    expect(sent).to.be.instanceOf(Float32Array);
    expect(sent[0]).to.be.closeTo(0.15, 1e-5);
  });

  it('segment 起点按 startSample 对齐到绝对时间轴', async () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    state.trackSegments = [
      // 从 sample 32（bpm=120 下 = 0.0167s）开始，长 32
      { trackId: s1.id, startSample: 32, audio: new Float32Array(32).fill(0.4) },
    ];
    state.trackSegmentsReady = true;
    state.currentAudioData = new Float32Array(64);

    let sent = null;
    installMinimalElectronApi(({ data }) => { sent = data; });

    await startExclusivePlayback(0);

    expect(sent[0]).to.be.closeTo(0, 1e-5);
    expect(sent[32], '分片需在 startSample 处开始').to.be.closeTo(0.4, 1e-5);
  });

  it('独占 PCM 长度包含长于人声的伴奏尾奏', async () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    const acc = trackManager.addSinger({ name: 'acc', type: 'accompaniment', accompanimentStartTime: 0, accompanimentVolume: 1 });
    const accBuf = new Float32Array(24000 * 3).fill(0.1);
    acc.audioBuffer = accBuf;
    acc.audioChannels = [accBuf];
    acc.audioSampleRate = 24000;
    state.trackSegments = [
      { trackId: s1.id, startSample: 0, audio: new Float32Array(24000).fill(0.2) },
    ];
    state.trackSegmentsReady = true;
    state.currentAudioData = new Float32Array(24000);

    let sent = null;
    installMinimalElectronApi(({ data }) => { sent = data; });

    await startExclusivePlayback(0);

    expect(sent.length, '独占 PCM 应保留完整 3s 伴奏尾奏').to.equal(24000 * 3);
    expect(sent[24000 * 2], '人声结束后伴奏仍应在 PCM 中').to.be.closeTo(0.1, 1e-5);
  });
});

describe('独占输出：M/S 变化触发防抖重建（4.6）', () => {
  beforeEach(() => {
    sinon.stub(global, 'requestAnimationFrame').returns(1);
    trackManager.clearAll();
    clearTrackGains();
    Object.assign(state, {
      isSynthesizing: false, synthesisCancelled: false, isPlaying: false,
      playbackPauseOffset: 0, playbackStartTime: 0, currentAudioSource: null,
      audioContext: null, currentAudioData: null, currentAudioChannels: null,
      currentAudioBuffer: null, trackSegments: [], trackSegmentsReady: false,
      streamingSources: [], streamingFinished: false, playheadRaf: null,
      exclusivePlaybackRaf: null, useExclusiveMode: true, audioSettings: {},
      project: { bpm: 120 },
    });
  });

  afterEach(() => {
    stopExclusivePlayback();
    sinon.restore();
    trackManager.clearAll();
    clearTrackGains();
    state.trackSegments = [];
    state.trackSegmentsReady = false;
    state.currentAudioData = null;
    state.isPlaying = false;
  });

  it('独占在播时 M/S 变化 → 40ms 后重新 audioPlay，且从当前位置续播', async () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    state.trackSegments = [{ trackId: s1.id, startSample: 0, audio: new Float32Array(48000) }];
    state.trackSegmentsReady = true;

    const plays = [];
    installMinimalElectronApi((p) => plays.push(p));

    await startExclusivePlayback(0);
    expect(plays.length).to.equal(1);
    state.isPlaying = true;
    // 模拟已播放 2 秒
    state.playbackStartTime = Date.now() / 1000 - 2;

    const beforeStart = state.playbackStartTime;
    s1.mute = true;
    applyAudibility(trackManager.getSingers());

    // 防抖窗口内不应立即重启
    expect(plays.length, '40ms 防抖窗口内不重启').to.equal(1);

    await delay(70); // 超过 40ms 防抖

    expect(plays.length, 'M/S 变化应触发一次重建').to.equal(2);
    const lastOptions = plays[plays.length - 1].options;
    expect(lastOptions.offset, '续播起点应接近当前 2 秒位置').to.be.at.least(1.9);
    expect(state.playbackStartTime, 'playbackStartTime 应被更新').to.be.greaterThan(beforeStart);
    expect(state.isPlaying, '传输态保持 PLAYING').to.equal(true);
  });

  it('40ms 内多次 M/S 快速连点只重启一次', async () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    state.trackSegments = [{ trackId: s1.id, startSample: 0, audio: new Float32Array(48000) }];
    state.trackSegmentsReady = true;

    const plays = [];
    installMinimalElectronApi((p) => plays.push(p));
    await startExclusivePlayback(0);
    state.isPlaying = true;
    state.playbackStartTime = Date.now() / 1000 - 1;

    // 快速连点：mute → unmute → mute，每次改变可听性
    s1.mute = true;
    applyAudibility(trackManager.getSingers());
    s1.mute = false;
    applyAudibility(trackManager.getSingers());
    s1.mute = true;
    applyAudibility(trackManager.getSingers());

    await delay(70);

    expect(plays.length, '防抖应把多次连点合并为一次重建').to.equal(2);
  });

  it('共享模式在播时不因 M/S 变化重启独占输出', async () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    const plays = [];
    installMinimalElectronApi((p) => plays.push(p));
    state.useExclusiveMode = false;
    state.isPlaying = true;

    s1.mute = true;
    applyAudibility(trackManager.getSingers());
    await delay(70);

    expect(plays.length, '共享模式零中断，不应重启').to.equal(0);
  });

  it('没有 WebAudio 增益节点（独占模式）时 applyAudibility 仍通知订阅者', () => {
    // 独占模式不注册任何 GainNode：_gains 为空
    clearTrackGains();
    let notified = 0;
    const unsub = subscribeAudibilityChange(() => { notified += 1; });
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });

    applyAudibility(trackManager.getSingers()); // 首次：键从无到有
    applyAudibility(trackManager.getSingers()); // 缓存命中
    expect(notified).to.equal(1);
    s1.mute = true;
    applyAudibility(trackManager.getSingers()); // M/S 变化
    expect(notified, '无 gain 节点也必须通知独占重建订阅者').to.equal(2);
    unsub();
  });
});
