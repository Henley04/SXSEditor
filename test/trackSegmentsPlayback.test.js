'use strict';
/**
 * 非流式分轨播放（计划 4.3 / 4.5）：
 *   · startSharedPlayback 用 trackSegments 时一轨一 source 接一轨一 GainNode；
 *   · 静音轨 source 仍被调度但增益为 0；
 *   · currentAudioData 仍是所有 segment 的叠加（时长/导出/MCP 不变）。
 */
const { expect } = require('chai');

const { state, trackManager } = require('../src/renderer/state.js');
const { clearTrackGains } = require('../src/renderer/trackGainMixer.js');
const { startSharedPlayback, stopPlayback, getCurrentPlaybackSeconds } = require('../src/renderer/audioPlayback.js');

if (!global.requestAnimationFrame) {
  global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
  global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
}

/** 记录型 AudioContext：source 记录 connect 目标与 start 参数，gain 记录 value。 */
function installRecordingAudioContext() {
  const created = { sources: [], gains: [], buffers: [] };
  class FakeGain {
    constructor() {
      this.gain = { value: 1, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; } };
      this.connections = [];
      this.context = ctx;
      created.gains.push(this);
    }
    connect(dest) { this.connections.push(dest); return dest; }
    disconnect() {}
  }
  class FakeBuffer {
    constructor(ch, len, rate) {
      this.numberOfChannels = ch;
      this.length = len;
      this.sampleRate = rate;
      this.duration = len / rate;
      this._data = Array.from({ length: ch }, () => new Float32Array(len));
      created.buffers.push(this);
    }
    getChannelData(i) { return this._data[i]; }
  }
  class FakeSource {
    constructor() {
      this.onended = null;
      this.buffer = null;
      this.connects = [];
      this.startArgs = null;
      created.sources.push(this);
    }
    connect(dest) { this.connects.push(dest); return dest; }
    start(when, offset, dur) { this.startArgs = { when, offset: offset || 0, dur }; }
    stop() {}
  }
  const ctx = {
    state: 'running',
    currentTime: 0,
    sampleRate: 24000,
    destination: { id: 'destination' },
    outputLatency: 0,
    baseLatency: 0,
    createGain() { return new FakeGain(); },
    createBuffer(ch, len, rate) { return new FakeBuffer(ch, len, rate); },
    createBufferSource() { return new FakeSource(); },
    resume() { return Promise.resolve(); },
  };
  global.window.AudioContext = function () { return ctx; };
  global.AudioContext = global.window.AudioContext;
  state.audioContext = null;
  state.gainNode = null;
  return created;
}

describe('非流式分轨播放 — 一轨一 source 接一轨一增益', () => {
  let created;

  beforeEach(() => {
    created = installRecordingAudioContext();
    clearTrackGains();
    trackManager.clearAll();
    state.project = { bpm: 120 };
    state.isPlaying = false;
    state.playbackPauseOffset = 0;
    state.playheadRaf = null;
    state.trackSources = [];
    state.streamingSources = [];
    state.currentAudioData = new Float32Array(48000); // 2s
    state.currentAudioSignature = null;
    state.currentAudioChannels = null;
    global.window.electronAPI = { audioStop: async () => ({ success: true }) };
  });

  afterEach(() => {
    stopPlayback();
    clearTrackGains();
    // 防止分轨状态泄漏到后续测试文件（独占混音会读取 trackSegments）。
    state.trackSegments = [];
    state.trackSegmentsReady = false;
  });

  it('trackSegments 每个片段各建一个 source，接到对应轨的 GainNode', () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    const s2 = trackManager.addSinger({ name: 's2', type: 'singer' });
    state.trackSegments = [
      { trackId: s1.id, startSample: 0, audio: new Float32Array(24000) },
      { trackId: s2.id, startSample: 12000, audio: new Float32Array(24000) },
    ];
    state.trackSegmentsReady = true;

    startSharedPlayback(0);

    // 两个分片 source（不含伴奏）
    expect(created.sources.length).to.equal(2);
    // 每个 source 接到一个 gain（增益节点带 .gain 参数对象与 .connect 方法）
    for (const src of created.sources) {
      expect(src.connects.length).to.be.greaterThan(0);
      expect(src.connects[0]).to.have.property('gain');
      expect(src.connects[0].connect).to.be.a('function');
    }
    // 两条轨各一个 gain（+ master gain）
    expect(created.gains.length).to.be.greaterThanOrEqual(2);
  });

  it('静音轨的 source 仍被调度，但增益为 0', () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    const s2 = trackManager.addSinger({ name: 's2', type: 'singer', mute: true });
    state.trackSegments = [
      { trackId: s1.id, startSample: 0, audio: new Float32Array(24000) },
      { trackId: s2.id, startSample: 0, audio: new Float32Array(24000) },
    ];
    state.trackSegmentsReady = true;

    startSharedPlayback(0);

    expect(created.sources.length, '静音轨 source 仍被调度').to.equal(2);
    // s2 静音 → 它的 gain.value === 0；s1 可听 → 1
    const gainValues = created.gains.map((g) => g.gain.value);
    expect(gainValues).to.include(0);
    expect(gainValues).to.include(1);
  });

  it('seek 到片段内部：source.start(when, bufOffset, dur) 的 offset 正确', () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    // 片段从 0.5s 开始，长 1s
    state.trackSegments = [
      { trackId: s1.id, startSample: 12000, audio: new Float32Array(24000) },
    ];
    state.trackSegmentsReady = true;

    startSharedPlayback(0.75); // offset 落在片段内部 0.25s 处

    expect(created.sources.length).to.equal(1);
    const args = created.sources[0].startArgs;
    expect(args.offset, 'bufOffset 应为 0.25s').to.be.closeTo(0.25, 0.01);
    expect(args.dur, '剩余时长应为 0.75s').to.be.closeTo(0.75, 0.01);
  });

  it('片段完全在 offset 之前：跳过不调度', () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    state.trackSegments = [
      { trackId: s1.id, startSample: 0, audio: new Float32Array(12000) }, // 0–0.5s
    ];
    state.trackSegmentsReady = true;

    startSharedPlayback(1.0); // 从其之后开始

    expect(created.sources.length).to.equal(0);
  });

  it('getCurrentPlaybackSeconds 未播放时返回 pauseOffset', () => {
    state.playbackPauseOffset = 1.5;
    expect(getCurrentPlaybackSeconds()).to.equal(1.5);
  });
});
