const { expect } = require('chai');
const pp = require('../src/inference/pitchPostprocess');
const {
  beatsPerMeasureOf,
  isMeasureBoundary,
  measureNumberAt,
} = require('../src/shared/timeSignature.js');
const { state } = require('../src/audioPreprocess/state.js');
const {
  getPlayheadXForTime,
  xToWaveformTime,
} = require('../src/audioPreprocess/canvasRenderer.js');
const { PIANO_KEY_WIDTH, BEAT_WIDTH } = require('../src/audioPreprocess/constants.js');

/**
 * 确定性伪随机（避免 Math.random 让测试偶发失败）。
 * @param {number} seed
 * @returns {() => number}
 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 合成节拍轨：每拍一个指数衰减的鼓点，可选八分音符弱拍。
 * @param {number} bpm
 * @param {object} [opts]
 * @returns {Float32Array}
 */
function clickTrack(bpm, opts = {}) {
  const sr = opts.sr || 44100;
  const dur = opts.dur || 12;
  const rand = lcg(opts.seed || 1);
  const n = Math.floor(sr * dur);
  const audio = new Float32Array(n);
  const beatSamples = (sr * 60) / bpm;
  const hit = (at, gain) => {
    const i = Math.round(at);
    for (let j = 0; j < 400 && i + j < n; j++) {
      audio[i + j] += Math.exp(-j / 80) * gain;
    }
  };
  for (let p = 0; p < n; p += beatSamples) {
    hit(p, 1);
    if (opts.offbeat) hit(p + beatSamples / 2, 0.35);
  }
  for (let i = 0; i < n; i++) audio[i] += (rand() - 0.5) * 0.002;
  return audio;
}

describe('BPM detection (inference/pitchPostprocess.detectBpm)', () => {
  it('returns the fallback for audio shorter than a couple of frames', () => {
    expect(pp.detectBpm(new Float32Array(100), 44100, 118)).to.equal(118);
    expect(pp.detectBpm(new Float32Array(0), 44100, 118)).to.equal(118);
  });

  it('returns the fallback for silence', () => {
    expect(pp.detectBpm(new Float32Array(44100 * 5), 44100, 96)).to.equal(96);
  });

  // 旧实现把 120 测成 60、180 测成 90（都用"最强相关峰"且未做倍频裁决）。
  // 这组断言把整个常用区间钉住，误差 3% 以内。
  for (const bpm of [60, 72, 85, 96, 110, 120, 128, 140, 150, 160, 180]) {
    it(`detects ${bpm} BPM within 3%`, () => {
      const got = pp.detectBpm(clickTrack(bpm), 44100, 120);
      expect(got).to.be.closeTo(bpm, bpm * 0.03);
    });
  }

  it('does not flip the 55 BPM boundary up an octave', () => {
    // 搜索下界是 55；lag 取整会让结果落在 54.9，旧版判断 `bpm < 55` 就翻倍成 110。
    const got = pp.detectBpm(clickTrack(55), 44100, 120);
    expect(got).to.be.closeTo(55, 2);
  });

  it('prefers the beat over the two-beat period (no half-tempo error)', () => {
    // 4/4 里底鼓在 1、3 拍，2 拍间隔的相关值天然比 1 拍更高。
    const got = pp.detectBpm(clickTrack(168), 44100, 120);
    expect(got).to.be.closeTo(168, 168 * 0.03);
  });

  it('keeps sub-frame precision instead of integer BPM', () => {
    // 旧版 Math.round 到整数；127.4 变 127 在 5 分钟里累计约 1 秒偏移。
    const got = pp.detectBpm(clickTrack(127), 44100, 120);
    expect(got).to.be.closeTo(127, 127 * 0.02);
    // 一位小数精度：0.1 的倍数即可（不要求一定带小数位，127.0 也是合法结果）。
    expect(Math.abs(got * 10 - Math.round(got * 10))).to.be.lessThan(1e-6);
  });

  it('behaves the same at 24 kHz (analysis window is time-based)', () => {
    const got = pp.detectBpm(clickTrack(96, { sr: 24000 }), 24000, 120);
    expect(got).to.be.closeTo(96, 96 * 0.03);
  });

  it('treats eighth-note pulse as a valid beat (documented ambiguity)', () => {
    // 72 BPM + 八分音符弱拍与 144 BPM 在信号上等价；这里只要求落在其中一个。
    const got = pp.detectBpm(clickTrack(72, { offbeat: true }), 44100, 120);
    const ok = Math.abs(got - 72) <= 72 * 0.03 || Math.abs(got - 144) <= 144 * 0.03;
    expect(ok, `got ${got}`).to.equal(true);
  });
});

describe('time signature → beats per measure', () => {
  it('converts simple and compound meters to quarter-note beats', () => {
    expect(beatsPerMeasureOf([4, 4])).to.equal(4);
    expect(beatsPerMeasureOf([3, 4])).to.equal(3);
    // 2/2 是"每小节 2 个二分音符"，换算成 MIDI 的四分音符拍仍是 4 拍。
    expect(beatsPerMeasureOf([2, 2])).to.equal(4);
    expect(beatsPerMeasureOf([6, 8])).to.equal(3);
    expect(beatsPerMeasureOf([9, 8])).to.equal(4.5);
    expect(beatsPerMeasureOf([12, 8])).to.equal(6);
  });

  it('falls back to 4/4 for missing or invalid input', () => {
    expect(beatsPerMeasureOf(null)).to.equal(4);
    expect(beatsPerMeasureOf([])).to.equal(4);
    expect(beatsPerMeasureOf([0, 4])).to.equal(4);
    expect(beatsPerMeasureOf([4, 0])).to.equal(4);
    expect(beatsPerMeasureOf('4/4')).to.equal(4);
  });

  it('puts measure lines every 3 beats in 6/8 (not every 6)', () => {
    expect(isMeasureBoundary(0, 3)).to.equal(true);
    expect(isMeasureBoundary(3, 3)).to.equal(true);
    expect(isMeasureBoundary(6, 3)).to.equal(true);
    expect(isMeasureBoundary(2, 3)).to.equal(false);
    // 旧实现用 timeSignature[0] = 6：第 3 拍不会被认成小节线。
    expect(isMeasureBoundary(3, 6)).to.equal(false);
  });

  it('numbers measures from 1 and respects compound meters', () => {
    expect(measureNumberAt(0, 4)).to.equal(1);
    expect(measureNumberAt(3.99, 4)).to.equal(1);
    expect(measureNumberAt(4, 4)).to.equal(2);
    expect(measureNumberAt(9, 3)).to.equal(4); // 6/8 下第 9 拍 = 第 4 小节
  });
});

describe('waveform / playhead time base follows pianoRoll.bpm', () => {
  const fakeBuffer = { getChannelData: () => new Float32Array(16) };

  function withPianoRoll(bpm) {
    const prevBuffer = state.wavAudioBuffer;
    const prevRoll = state.pianoRoll;
    state.wavAudioBuffer = fakeBuffer;
    state.pianoRoll = { bpm, zoomX: 1, scrollX: 0, getCurrentTime: () => 0 };
    return () => {
      state.wavAudioBuffer = prevBuffer;
      state.pianoRoll = prevRoll;
    };
  }

  it('places the playhead by the actual BPM, not the 120 constant', () => {
    const restore = withPianoRoll(96);
    try {
      // 60 秒 @96 BPM = 96 拍
      const x = getPlayheadXForTime(60);
      expect(x).to.be.closeTo(PIANO_KEY_WIDTH + 96 * BEAT_WIDTH, 0.5);
      expect(x).to.not.be.closeTo(PIANO_KEY_WIDTH + 120 * BEAT_WIDTH, 1);
    } finally {
      restore();
    }
  });

  it('round-trips pixel → seconds with the same BPM', () => {
    const restore = withPianoRoll(96);
    try {
      const sec = xToWaveformTime(PIANO_KEY_WIDTH + 96 * BEAT_WIDTH);
      expect(sec).to.be.closeTo(60, 0.01);
    } finally {
      restore();
    }
  });

  it('falls back to the panel BPM when the roll is not ready', () => {
    const prevBuffer = state.wavAudioBuffer;
    const prevRoll = state.pianoRoll;
    const prevOpts = state.extractOptions;
    state.wavAudioBuffer = fakeBuffer;
    state.pianoRoll = null;
    state.extractOptions = { bpm: 60 };
    try {
      const x = getPlayheadXForTime(60); // 60 秒 @60 BPM = 60 拍
      expect(x).to.be.closeTo(PIANO_KEY_WIDTH + 60 * BEAT_WIDTH, 0.5);
    } finally {
      state.wavAudioBuffer = prevBuffer;
      state.pianoRoll = prevRoll;
      state.extractOptions = prevOpts;
    }
  });
});
