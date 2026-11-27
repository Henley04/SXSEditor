'use strict';
/**
 * P1-2 / P1-3 回归：共享播放的末尾语义与自然结束收尾。
 *
 *   · 播完（或拖到末尾）再按 Play：offset 落在内容末尾 → 回 0 重播，绝不假播放；
 *   · 自然结束：人声 + 伴奏全部 source 结束才收尾，停在统一内容末尾（含伴奏 outro）；
 *   · 收尾时停掉仍在响的伴奏 source；
 *   · Pause 不能只看 currentAudioSource（分轨路径它可能已 onended 被清零）。
 */
const { expect } = require('chai');
const sinon = require('sinon');

const { state, trackManager } = require('../src/renderer/state.js');
const { clearTrackGains, getOrCreateTrackGain } = require('../src/renderer/trackGainMixer.js');
const ap = require('../src/renderer/audioPlayback.js');
const { resetFollowForTest } = require('../src/renderer/timelineRenderer.js');

if (!global.requestAnimationFrame) {
  global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
  global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
}

/** 记录型 AudioContext：source 记录 start/stop 调用与 onended。 */
function installRecordingAudioContext() {
  const created = { sources: [], gains: [] };
  class FakeGain {
    constructor() {
      this.gain = { value: 1, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; } };
      created.gains.push(this);
    }
    connect(dest) { return dest; }
    disconnect() {}
  }
  class FakeBuffer {
    constructor(ch, len, rate) {
      this.numberOfChannels = ch;
      this.length = len;
      this.sampleRate = rate;
      this.duration = len / rate;
      this._data = Array.from({ length: ch }, () => new Float32Array(len));
    }
    getChannelData(i) { return this._data[i]; }
  }
  class FakeSource {
    constructor() {
      this.onended = null;
      this.buffer = null;
      this.startArgs = null;
      this.stopped = false;
      created.sources.push(this);
    }
    connect(dest) { return dest; }
    start(when, offset, dur) { this.startArgs = { when, offset: offset || 0, dur }; }
    stop() { this.stopped = true; }
  }
  const ctx = {
    state: 'running',
    currentTime: 0,
    sampleRate: 24000,
    destination: {},
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

function addAccompaniment(seconds) {
  const t = trackManager.addSinger({ name: 'acc', type: 'accompaniment' });
  t.audioChannels = [new Float32Array(24000 * seconds)];
  t.audioSampleRate = 24000;
  t.accompanimentStartTime = 0;
  t.accompanimentVolume = 1;
  return t;
}

describe('共享播放末尾语义与自然结束收尾（P1-2 / P1-3）', () => {
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
    state.currentAudioData = new Float32Array(24000); // 1s 人声混音
    state.currentAudioSignature = null;
    state.currentAudioChannels = null;
    state.currentAudioBuffer = null;
    global.window.electronAPI = { audioStop: async () => ({ success: true }) };
  });

  afterEach(() => {
    stopSafely();
    clearTrackGains();
    state.trackSegments = [];
    state.trackSegmentsReady = false;
    // P3 测试隔离：本套件 stub 过 performance.now 并触发自然结束重置锚点。
    resetFollowForTest();
    sinon.restore();
  });

  function stopSafely() {
    try { ap.stopPlayback(); } catch (_) { /* ignore */ }
  }

  it('P1-2: offset 落在内容末尾 → 回 0 重播，不进入假播放', () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    state.trackSegments = [
      { trackId: s1.id, startSample: 0, audio: new Float32Array(24000) }, // 0–1s
    ];
    state.trackSegmentsReady = true;
    // currentAudioData 1s → contentEndSec = 1
    ap.startSharedPlayback(1.0);

    expect(state.isPlaying, '末尾再播应真正进入播放态').to.be.true;
    expect(state.playbackPauseOffset, 'offset 应回 0').to.equal(0);
    expect(created.sources.length, '应有 source 被调度，不能假播放').to.be.greaterThan(0);
    expect(created.sources[0].startArgs.offset, '应从片段开头播').to.be.closeTo(0, 0.01);
  });

  it('P1-2: 所有分片都在 offset 之前且无伴奏 → settle 保持暂停，不假播放', () => {
    // 场景：只有人声片段 0–0.5s，offset=1s 在其之后，无伴奏轨。
    // 没有任何 source 被调度时，修复后不能再置 isPlaying=true（那会假播放、Pause 失效）。
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    state.trackSegments = [
      { trackId: s1.id, startSample: 0, audio: new Float32Array(12000) }, // 0–0.5s
    ];
    state.trackSegmentsReady = true;
    state.currentAudioData = new Float32Array(48000); // currentAudioData 2s → contentEnd=2s
    ap.startSharedPlayback(1.0); // offset < 2s，不触发回 0

    expect(created.sources.length).to.equal(0);
    expect(state.isPlaying, '零 source 不能进入假播放').to.be.false;
  });

  it('P1-2: currentAudioSource 为 null 但 trackSources 仍有活跃 source 时 Pause 生效', () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    state.trackSegments = [
      { trackId: s1.id, startSample: 0, audio: new Float32Array(24000) },
    ];
    state.trackSegmentsReady = true;
    ap.startSharedPlayback(0);
    state.isPlaying = true;
    // 模拟代表 source 已 onended 被清零，但 trackSources 里仍有一条在播。
    state.currentAudioSource = null;
    state.trackSources[0] = { onended: null, stop() {} };

    ap.pausePlayback();
    expect(state.isPlaying, 'Pause 应成功（不因 currentAudioSource 缺失而失效）').to.be.false;
    expect(state.playbackPauseOffset).to.be.a('number');
  });

  it('P3: 有 trackId 但轨道已删除的 segment 增益为 0（可听性统一约定）', () => {
    // 无轨道匹配的 segment 必须视为不可听（安全默认），避免删轨后残留片段仍出声。
    state.trackSegments = [
      { trackId: 'deleted-singer', startSample: 0, audio: new Float32Array(24000) },
    ];
    state.trackSegmentsReady = true;
    ap.startSharedPlayback(0);
    const gain = getOrCreateTrackGain('deleted-singer');
    expect(gain, '该轨 gain 应已注册').to.exist;
    expect(gain.gain.value, '已删轨的 segment 增益应为 0').to.equal(0);
  });

  it('P1-3: 人声先结束但伴奏仍在响 → 不收尾；伴奏结束才停在末尾并停伴奏', () => {
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    addAccompaniment(2); // 伴奏 2s，长于 1s 人声
    state.trackSegments = [
      { trackId: s1.id, startSample: 0, audio: new Float32Array(24000) }, // 1s
    ];
    state.trackSegmentsReady = true;

    ap.startSharedPlayback(0);
    // 调度出的 source：人声(1) + 伴奏(1)
    expect(created.sources.length).to.be.greaterThanOrEqual(2);
    const accSource = created.sources[created.sources.length - 1];

    sinon.stub(performance, 'now').callsFake(() => 1e9);
    try {
      // 先触发所有人声分片 onended（当前实现只有一条人声）。
      for (const src of state.trackSources.slice()) {
        if (src && src.onended) src.onended();
      }
      // 人声先结束但伴奏仍在响 → 绝不能提前收尾（旧代码在此置 IDLE、伴奏继续响）。
      expect(state.isPlaying, '伴奏未结束时不应收尾').to.be.true;
      expect(state.playbackPauseOffset, '人声结束时不应把暂停点停到 1s').to.equal(0);

      // 伴奏也结束 → 统一收尾。
      accSource.onended();
    } finally {
      performance.now.restore();
    }

    expect(state.isPlaying, '全部 source 结束后应收尾').to.be.false;
    // contentEndSec = max(人声 1s, currentAudioData 1s, 伴奏 2s) = 2s
    expect(state.playbackPauseOffset, '应停在统一内容末尾 2s，不是人声末尾 1s').to.be.closeTo(2, 0.01);
  });

  it('统一内容末尾包含静音伴奏，且 seek 不会被人声长度截断', async () => {
    const acc = trackManager.addSinger({ name: 'muted-acc', type: 'accompaniment', mute: true });
    acc.audioChannels = [new Float32Array(24000 * 3)];
    acc.audioSampleRate = 24000;
    acc.accompanimentStartTime = 0;
    acc.accompanimentVolume = 1;
    state.currentAudioData = new Float32Array(24000); // 1s 人声

    expect(ap.getPlaybackContentEndSeconds(), '静音伴奏也应参与播放边界').to.be.closeTo(3, 0.01);

    await ap.seekPlayback(2.99);
    expect(state.playbackPauseOffset, 'seek 应钳到伴奏末尾前 50ms').to.be.closeTo(2.95, 0.01);
    expect(state.isPlaying, 'seek 后应从伴奏内继续播放').to.be.true;
    expect(created.sources.length, '应只调度仍在播放的伴奏 source').to.equal(1);
    expect(created.sources[0].startArgs.offset, '伴奏续播偏移应使用统一时间轴').to.be.closeTo(2.95, 0.01);
  });

  it('无人声缓存时 seek 仍按伴奏统一边界钳制', async () => {
    const acc = trackManager.addSinger({ name: 'acc', type: 'accompaniment' });
    acc.audioChannels = [new Float32Array(24000 * 2)];
    acc.audioSampleRate = 24000;
    acc.accompanimentStartTime = 0;
    acc.accompanimentVolume = 1;
    state.currentAudioData = null;

    await ap.seekPlayback(5);
    expect(state.playbackPauseOffset).to.be.closeTo(1.95, 0.01);
  });

  it('fallback 混音已播完但伴奏未结束时只清空人声 buffer，继续调度伴奏', () => {
    addAccompaniment(3);
    state.currentAudioData = new Float32Array(24000); // 1s
    state.currentAudioChannels = null;
    state.trackSegments = [];
    state.trackSegmentsReady = false;

    ap.startSharedPlayback(1.5);

    expect(state.currentAudioBuffer, '人声已越过末尾，不得残留旧 buffer').to.equal(null);
    expect(state.currentAudioSource, '人声已越过末尾，不得残留旧 source').to.equal(null);
    expect(state.isPlaying, '伴奏仍在内容范围内，应继续播放').to.be.true;
    expect(created.sources.length, '只应调度伴奏 source').to.equal(1);
    expect(created.sources[0].startArgs.offset, '应从伴奏 1.5s 处续播').to.be.closeTo(1.5, 0.01);
  });

  it('getCurrentPlaybackSeconds 不超过统一内容末尾', () => {
    addAccompaniment(3);
    state.currentAudioData = new Float32Array(24000);
    state.isPlaying = false;
    state.playbackPauseOffset = 5;

    expect(ap.getCurrentPlaybackSeconds()).to.be.closeTo(3, 0.01);
  });
});
