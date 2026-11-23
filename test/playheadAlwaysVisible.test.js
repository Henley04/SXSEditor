'use strict';
/**
 * 播放头"始终可见"契约（计划 4.9 / 4.12）。
 *
 * 覆盖：空工程 / 0 秒 / 未播放时画 0 秒播放头；Stop 回 0 仍可见；自然结束停在末尾。
 */
const { expect } = require('chai');
const sinon = require('sinon');

const { state, dom, trackManager } = require('../src/renderer/state.js');
const {
  renderFragmentTimeline,
  playbackTimeToX,
} = require('../src/renderer/timelineRenderer.js');
const ap = require('../src/renderer/audioPlayback.js');

function installDom() {
  document.body.innerHTML = `
    <div id="singer-list"></div>
    <div id="fragment-canvas-container">
      <canvas id="fragment-canvas"></canvas>
      <canvas id="fragment-playhead-canvas"></canvas>
    </div>
  `;
  const container = document.getElementById('fragment-canvas-container');
  Object.defineProperty(container, 'clientWidth', { value: 1200, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 460, configurable: true });
  dom.singerListEl = document.getElementById('singer-list');
  dom.fragmentContainer = container;
  dom.fragmentCanvas = document.getElementById('fragment-canvas');
  dom.fragmentPlayheadCanvas = document.getElementById('fragment-playhead-canvas');
}

function playheadCtx() {
  return document.getElementById('fragment-playhead-canvas').getContext('2d');
}
function playheadX() {
  const moves = playheadCtx().__ops('moveTo');
  return moves.length ? moves[0].args[0] : null;
}

function installFakeAudioContext() {
  if (!global.requestAnimationFrame) {
    global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
    global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
  }
  class FakeGain {
    constructor() { this.gain = { value: 1, setValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} }; }
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

function seed() {
  trackManager.clearAll();
  const s = trackManager.addSinger({ name: 'S', type: 'singer' });
  trackManager.addFragment({
    singerId: s.id, startTime: 0, duration: 16, name: 'F',
    notes: [{ start: 0, duration: 2, pitch: 60, lyric: 'la' }],
  });
  state.project = { bpm: 120, timeSignature: [4, 4] };
  state.fragmentZoomX = 1;
  state.fragmentScrollX = 0;
  state.fragmentScrollY = 0;
}

describe('播放头始终可见 — 空工程 / 0 秒 / Stop / 自然结束', () => {
  beforeEach(() => {
    installDom();
    seed();
    state.isPlaying = false;
    state.isSynthesizing = false;
    state.playbackPauseOffset = 0;
    state.currentAudioData = null;
    state.currentAudioSource = null;
    state.audioContext = null;
    state.streamingSources = [];
    state.playheadRaf = null;
    state.exclusivePlaybackRaf = null;
    global.window.electronAPI = {
      audioStop: async () => ({ success: true }),
    };
    playheadCtx().__reset();
  });

  it('空工程未播放：renderFragmentTimeline 后 0 秒播放头可见', () => {
    trackManager.clearAll();
    renderFragmentTimeline();
    expect(playheadX()).to.be.a('number');
    expect(playheadX()).to.be.closeTo(playbackTimeToX(0), 0.001);
  });

  it('Stop 回 0 秒后播放头仍可见', () => {
    state.isPlaying = true;
    state.currentAudioData = new Float32Array(24000); // 1s @24k
    state.playbackPauseOffset = 0.5;
    state.currentAudioSource = { onended: null, stop() {} };
    ap.stopPlayback();
    expect(state.playbackPauseOffset).to.equal(0);
    expect(playheadX(), 'Stop 后 0 秒播放头必须可见').to.be.a('number');
    expect(playheadX()).to.be.closeTo(playbackTimeToX(0) - state.fragmentScrollX, 0.001);
  });

  it('自然播完：播放头停在末尾，不回 0，且跟随锚点复位', () => {
    installFakeAudioContext();
    state.currentAudioData = new Float32Array(48000); // 2s @24k
    state.isPlaying = true;
    state.playbackPauseOffset = 0;
    state.currentAudioSource = {
      onended: null,
      stop() {},
    };
    ap.startSharedPlayback(0);
    const src = state.currentAudioSource;
    // 模拟非"刚启动就结束"的自然结束。用极大墙钟值而不是固定 5000：
    // startSharedPlayback 记录的 playbackStartWallTime 在全量套件里可能已很大
    // （套件跑了 1 分钟 → ~60000ms），固定 5000 会算出负的 realElapsed，被
    // 误判成"刚启动就结束"而保留 pauseOffset=0，测试才会偶发失败。
    sinon.stub(performance, 'now').callsFake(() => 1e9);
    try {
      src.onended();
    } finally {
      performance.now.restore();
    }
    expect(state.isPlaying).to.be.false;
    expect(state.playbackPauseOffset, '自然结束停在 2s 末尾，不回 0').to.be.closeTo(2, 0.01);
    expect(playheadX(), '自然结束播放头保持可见').to.be.a('number');
  });

  it('工程装载事件把播放状态严格复位到 0', () => {
    state.isPlaying = true;
    state.currentAudioData = new Float32Array(48000);
    state.currentAudioSignature = 'stale';
    state.playbackPauseOffset = 1.2;
    document.dispatchEvent(new (global.CustomEvent)('sxse:project-applied', {
      detail: { filePath: null },
    }));
    expect(state.isPlaying).to.be.false;
    expect(state.playbackPauseOffset).to.equal(0);
    expect(state.currentAudioData).to.equal(null);
    expect(state.currentAudioSignature).to.equal(null);
    expect(state.trackSegments).to.deep.equal([]);
    expect(playheadX(), '复位后 0 秒播放头可见').to.be.a('number');
  });
});
