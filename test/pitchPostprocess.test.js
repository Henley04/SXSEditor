const { expect } = require('chai');
const pp = require('../src/inference/pitchPostprocess');

describe('inference/pitchPostprocess', () => {
  describe('pitch math', () => {
    it('hzToMidi / midiToHz are inverse', () => {
      expect(pp.midiToHz(pp.hzToMidi(440))).to.be.closeTo(440, 0.001);
      expect(pp.midiToHz(pp.hzToMidi(220))).to.be.closeTo(220, 0.001);
      expect(pp.hzToMidi(440)).to.be.closeTo(69, 0.001);
    });

    it('medianOf returns correct median', () => {
      expect(pp.medianOf([3, 1, 2])).to.equal(2);
      expect(pp.medianOf([1, 2, 3, 4])).to.equal(2.5);
      expect(pp.medianOf([])).to.equal(0);
    });
  });

  describe('analyzeLevel', () => {
    it('detects peak and rms', () => {
      const res = pp.analyzeLevel(new Float32Array([0.5, -0.3, 0.0, 0.2]));
      expect(res.peak).to.be.closeTo(0.5, 1e-6);
      expect(res.peakDb).to.be.closeTo(20 * Math.log10(0.5), 1e-6);
      expect(res.clipped).to.equal(false);
    });

    it('detects clipping', () => {
      const res = pp.analyzeLevel(new Float32Array([1.0, 0.5, 0.3]));
      expect(res.clipped).to.equal(true);
      expect(res.clippedSamples).to.be.greaterThan(0);
    });

    it('handles empty array without NaN', () => {
      const res = pp.analyzeLevel(new Float32Array(0));
      expect(res.peak).to.equal(0);
      expect(Number.isFinite(res.rmsDb)).to.equal(true);
    });
  });

  describe('normalizeToTargetDb', () => {
    it('normalizes peak to target dB', () => {
      const audio = new Float32Array([0.5, 0.25, -0.5]);
      const out = pp.normalizeToTargetDb(audio, -6);
      const targetPeak = Math.pow(10, -6 / 20);
      expect(Math.max(...out)).to.be.closeTo(targetPeak, 1e-4);
      // does not mutate input
      expect(audio[0]).to.equal(0.5);
    });

    it('returns identical-length array', () => {
      const out = pp.normalizeToTargetDb(new Float32Array([0.1, 0.2]), -4.5);
      expect(out.length).to.equal(2);
    });
  });

  describe('computeFrameRms / gateByThreshold', () => {
    it('gates frames below threshold to silence', () => {
      const sr = 1000;
      const frameDur = 0.02; // 20 samples
      const audio = new Float32Array(80);
      // frames 0-19 loud, rest silent
      for (let i = 0; i < 20; i++) audio[i] = 0.5;
      const rms = pp.computeFrameRms(audio, sr, frameDur);
      const f0Array = [
        { time: 0, f0: 200 },
        { time: 0.02, f0: 200 },
        { time: 0.04, f0: 200 },
        { time: 0.06, f0: 200 },
      ];
      const gated = pp.gateByThreshold(f0Array, rms, 0.1);
      expect(gated[0].f0).to.equal(200); // loud frame kept
      expect(gated[1].f0).to.equal(0);
      expect(gated[2].f0).to.equal(0);
      expect(gated[3].f0).to.equal(0);
    });

    it('does not raise silent frames above threshold', () => {
      const audio = new Float32Array(40).fill(0.001);
      const rms = pp.computeFrameRms(audio, 1000, 0.02);
      const f0Array = [{ time: 0, f0: 200 }, { time: 0.02, f0: 200 }];
      const gated = pp.gateByThreshold(f0Array, rms, 0.1);
      gated.forEach((f) => expect(f.f0).to.equal(0));
    });
  });

  describe('gateByRange', () => {
    it('zeroes out-of-range F0', () => {
      const arr = [
        { time: 0, f0: 50 },
        { time: 0.02, f0: 300 },
        { time: 0.04, f0: 1000 },
      ];
      const gated = pp.gateByRange(arr, 80, 880);
      expect(gated[0].f0).to.equal(0);
      expect(gated[1].f0).to.equal(300);
      expect(gated[2].f0).to.equal(0);
    });
  });

  describe('f0RangeStats / autoRangeFromStats', () => {
    it('computes percentiles', () => {
      const arr = [];
      for (let i = 0; i < 100; i++) arr.push({ time: i * 0.02, f0: 200 + i });
      const stats = pp.f0RangeStats(arr);
      expect(stats.voicedCount).to.equal(100);
      expect(stats.p2).to.be.greaterThanOrEqual(200);
      expect(stats.p98).to.be.lessThanOrEqual(299);
    });

    it('auto range expands safely', () => {
      const stats = { p2: 100, p98: 500, voicedCount: 50 };
      const range = pp.autoRangeFromStats(stats);
      expect(range.f0Min).to.be.lessThanOrEqual(90);
      expect(range.f0Max).to.be.greaterThanOrEqual(525);
    });

    it('returns fallback range when no voiced frames', () => {
      const range = pp.autoRangeFromStats({ voicedCount: 0 });
      expect(range.f0Min).to.equal(80);
      expect(range.f0Max).to.equal(880);
    });
  });

  describe('medianFilterF0', () => {
    it('smooths a spike while keeping silence boundaries', () => {
      const arr = [
        { time: 0, f0: 200 },
        { time: 0.02, f0: 210 },
        { time: 0.04, f0: 600 }, // spike in the middle
        { time: 0.06, f0: 205 },
        { time: 0.08, f0: 200 },
      ];
      const out = pp.medianFilterF0(arr, 3);
      expect(out[2].f0).to.be.lessThan(300); // spike removed
      expect(out[2].f0).to.be.greaterThan(190); // stays near neighbors
      // all frames stay within the original~neighbor range (no spike bleed)
      out.forEach((f) => expect(f.f0).to.be.lessThan(300));
    });

    it('preserves silence frames as zero', () => {
      const arr = [
        { time: 0, f0: 0 },
        { time: 0.02, f0: 200 },
        { time: 0.04, f0: 0 },
      ];
      const out = pp.medianFilterF0(arr, 3);
      expect(out[0].f0).to.equal(0);
      expect(out[2].f0).to.equal(0);
    });

    it('returns same object when windowSize <= 1', () => {
      const arr = [{ time: 0, f0: 200 }];
      expect(pp.medianFilterF0(arr, 1)).to.equal(arr);
    });
  });

  describe('smoothingWindow', () => {
    it('maps levels to window sizes', () => {
      expect(pp.smoothingWindow('low')).to.equal(3);
      expect(pp.smoothingWindow('medium')).to.equal(5);
      expect(pp.smoothingWindow('high')).to.equal(9);
      expect(pp.smoothingWindow('unknown')).to.equal(5);
    });
  });

  describe('segmentNotes (strict)', () => {
    // 0.02s/frame, bpm 120 -> beatDur 0.5s
    const frameDur = 0.02;
    function makeNote(midi, frames, startIdx) {
      const hz = pp.midiToHz(midi);
      const arr = [];
      for (let i = 0; i < frames; i++) {
        arr.push({ time: (startIdx + i) * frameDur, f0: hz });
      }
      return arr;
    }

    it('splits two distinct notes', () => {
      const f0 = [
        ...makeNote(60, 10, 0),
        { time: 10 * frameDur, f0: 0 }, // gap
        ...makeNote(64, 10, 11),
      ];
      const { notes } = pp.segmentNotes(f0, { quantization: 'strict', bpm: 120, minNoteDuration: 0.05 });
      expect(notes.length).to.equal(2);
      expect(notes[0].pitch).to.equal(60);
      expect(notes[1].pitch).to.equal(64);
    });

    it('filters notes shorter than minNoteDuration', () => {
      const f0 = makeNote(60, 2, 0); // 0.04s < 0.05s
      const { notes } = pp.segmentNotes(f0, { quantization: 'strict', bpm: 120, minNoteDuration: 0.05 });
      expect(notes).to.have.length(0);
    });

    it('returns empty for empty input', () => {
      const { notes, pitchBends } = pp.segmentNotes([], {});
      expect(notes).to.have.length(0);
      expect(pitchBends).to.have.length(0);
    });
  });

  describe('segmentNotes (pitchbend)', () => {
    it('emits pitch bends for a glide', () => {
      const hzStart = pp.midiToHz(60);
      const hzEnd = pp.midiToHz(63);
      const f0 = [];
      for (let i = 0; i < 20; i++) {
        const t = i / 19;
        f0.push({ time: i * 0.02, f0: hzStart + (hzEnd - hzStart) * t });
      }
      const { notes, pitchBends } = pp.segmentNotes(f0, {
        quantization: 'pitchbend', bpm: 120, minNoteDuration: 0.05,
      });
      expect(notes.length).to.equal(1);
      expect(pitchBends.length).to.be.greaterThan(0);
      const bend = pitchBends[0].bends;
      bend.forEach((b) => expect(Math.abs(b.cents)).to.be.lessThanOrEqual(400));
    });
  });

  describe('detectVoiceQuality', () => {
    it('alerts when almost no voice', () => {
      const f0 = [];
      for (let i = 0; i < 100; i++) f0.push({ time: i * 0.02, f0: 0 });
      const q = pp.detectVoiceQuality(f0, 2);
      expect(q.warnings).to.include('noVoice');
    });

    it('alerts when first 3s silent', () => {
      const f0 = [];
      // first 3s silent (0..2.99s), then voiced
      for (let i = 0; i < 150; i++) f0.push({ time: i * 0.02, f0: 0 });
      for (let i = 150; i < 200; i++) f0.push({ time: i * 0.02, f0: 220 });
      const q = pp.detectVoiceQuality(f0, 4);
      expect(q.warnings).to.include('first3Silent');
    });

    it('returns no warnings for healthy voice', () => {
      const f0 = [];
      for (let i = 0; i < 200; i++) f0.push({ time: i * 0.02, f0: 220 });
      const q = pp.detectVoiceQuality(f0, 4);
      expect(q.warnings).to.have.length(0);
    });
  });

  describe('detectBpm', () => {
    it('returns fallback for too-short audio', () => {
      const audio = new Float32Array(100);
      expect(pp.detectBpm(audio, 44100, 120)).to.equal(120);
    });

    it('returns a BPM within valid range for synthetic beat', () => {
      const sr = 44100;
      const beatBpm = 120;
      const beatInterval = sr * 60 / beatBpm; // samples per beat
      const durSec = 10;
      const n = sr * durSec;
      const audio = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        // periodic impulse train
        const beatPos = i % beatInterval;
        audio[i] = beatPos < 100 ? 1.0 : 0.0;
      }
      const bpm = pp.detectBpm(audio, sr, 120);
      expect(bpm).to.be.greaterThanOrEqual(60);
      expect(bpm).to.be.lessThanOrEqual(180);
    });
  });
});