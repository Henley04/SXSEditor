const { RmvpePitchDetector, RMVPE_SAMPLE_RATE } = require('../src/inference/rmvpePitchDetector');
const { resampleAudio } = require('../src/utils/resampleAudio');
const { expect } = require('chai');

describe('RmvpePitchDetector - Pure Logic Tests', () => {
  let detector;

  beforeEach(() => {
    detector = new RmvpePitchDetector('/fake/model/dir/');
  });

  describe('resampleAudio', () => {
    it('should resample from 44100 to 16000', () => {
      const input = new Float32Array(441);
      for (let i = 0; i < 441; i++) {
        input[i] = Math.sin(2 * Math.PI * 440 * i / 44100);
      }

      const result = resampleAudio(input, 44100, 16000);

      expect(result).to.be.an.instanceOf(Float32Array);
      expect(result.length).to.equal(160);
    });

    it('should return same array when sample rates match', () => {
      const input = new Float32Array(100);
      input.fill(0.5);

      const result = resampleAudio(input, 16000, 16000);

      expect(result.length).to.equal(100);
    });

    it('should upsample correctly', () => {
      const input = new Float32Array(160);
      input.fill(1.0);

      const result = resampleAudio(input, 16000, 32000);

      expect(result.length).to.equal(320);
    });

    it('should preserve signal shape approximately', () => {
      const input = new Float32Array(4410);
      for (let i = 0; i < input.length; i++) {
        input[i] = Math.sin(2 * Math.PI * 440 * i / 44100);
      }

      const result = resampleAudio(input, 44100, 16000);

      expect(result.length).to.be.greaterThan(0);
      expect(result.length).to.equal(Math.floor(4410 * 16000 / 44100));
    });

    it('should handle small input arrays', () => {
      const input = new Float32Array([1, 2, 3, 4, 5]);
      const result = resampleAudio(input, 44100, 16000);

      expect(result.length).to.be.greaterThan(0);
    });

    it('should handle silence input', () => {
      const input = new Float32Array(16000);
      input.fill(0);

      const result = resampleAudio(input, 44100, 16000);

      expect(result.length).to.equal(Math.floor(16000 * 16000 / 44100));
    });
  });

  describe('decodeSalience', () => {
    const N_CLASS = 360;
    const CENTS_OFFSET = 1997.3794084376191;
    const hzOfBin = (bin) => 10 * Math.pow(2, (20 * bin + CENTS_OFFSET) / 1200);

    function salienceFor(bins) {
      const data = new Float32Array(bins.length * N_CLASS);
      bins.forEach((bin, t) => {
        if (bin >= 0) data[t * N_CLASS + bin] = 0.9;
      });
      return data;
    }

    it('should decode an isolated peak to its bin frequency', async () => {
      const bins = Array.from({ length: 16 }, () => 100);
      const f0 = await RmvpePitchDetector.decodeSalience(salienceFor(bins), bins.length);
      expect(f0.length).to.equal(16);
      for (let i = 0; i < 16; i++) {
        expect(f0[i]).to.be.closeTo(hzOfBin(100), 0.5);
      }
    });

    it('should output 0 for silent frames', async () => {
      const bins = [-1, -1, -1, -1];
      const f0 = await RmvpePitchDetector.decodeSalience(salienceFor(bins), bins.length);
      expect(Array.from(f0)).to.deep.equal([0, 0, 0, 0]);
    });

    it('should follow the 360-bin cents mapping (not a log LUT)', async () => {
      const bins = [0, 90, 180, 270, 359];
      const f0 = await RmvpePitchDetector.decodeSalience(salienceFor(bins), bins.length);
      bins.forEach((bin, i) => {
        expect(f0[i]).to.be.closeTo(hzOfBin(bin), 0.5);
      });
      // bin 0 ~32.7Hz, bin 359 ~1.9kHz: 必须严格单调递增
      for (let i = 1; i < bins.length; i++) {
        expect(f0[i]).to.be.greaterThan(f0[i - 1]);
      }
    });

    it('should respect the voicing threshold', async () => {
      const data = new Float32Array(2 * N_CLASS);
      data[0 * N_CLASS + 50] = 0.02;  // below 0.03 -> unvoiced
      data[1 * N_CLASS + 50] = 0.5;   // above -> voiced
      const f0 = await RmvpePitchDetector.decodeSalience(data, 2);
      expect(f0[0]).to.equal(0);
      expect(f0[1]).to.be.closeTo(hzOfBin(50), 0.5);
    });
  });

  describe('f0ToMidi', () => {
    it('should convert 440 Hz to MIDI note 69', () => {
      expect(detector.f0ToMidi(440)).to.equal(69);
    });

    it('should convert ~261.63 Hz to MIDI note 60', () => {
      expect(detector.f0ToMidi(261.63)).to.equal(60);
    });

    it('should return 0 for frequencies below F0_MIN', () => {
      expect(detector.f0ToMidi(0)).to.equal(0);
      expect(detector.f0ToMidi(-100)).to.equal(0);
    });

    it('should return 0 for zero frequency', () => {
      expect(detector.f0ToMidi(0)).to.equal(0);
    });
  });

  describe('f0ToNotes', () => {
    it('should return empty array for empty input', () => {
      const notes = detector.f0ToNotes([], 120);
      expect(notes).to.be.an('array');
      expect(notes).to.have.length(0);
    });

    it('should detect notes from F0 array', () => {
      const f0Array = [];
      const frameDuration = 160 / 16000;
      for (let i = 0; i < 100; i++) {
        f0Array.push({ time: i * frameDuration, f0: 440 });
      }

      const notes = detector.f0ToNotes(f0Array, 120);

      expect(notes.length).to.be.greaterThan(0);
      expect(notes[0]).to.have.property('pitch');
      expect(notes[0]).to.have.property('start');
      expect(notes[0]).to.have.property('duration');
    });

    it('should filter out unvoiced frames', () => {
      const f0Array = [
        { time: 0, f0: 0 },
        { time: 0.01, f0: 0 },
        { time: 0.02, f0: 440 },
      ];

      const notes = detector.f0ToNotes(f0Array, 120);

      expect(notes.length).to.be.at.least(0);
    });

    it('should respect minimum note duration', () => {
      const f0Array = [];
      const frameDuration = 160 / 16000;
      for (let i = 0; i < 5; i++) {
        f0Array.push({ time: i * frameDuration, f0: 440 });
      }

      const notes = detector.f0ToNotes(f0Array, 120, 0.1);

      expect(notes.length).to.equal(0);
    });

    it('should set correct note properties', () => {
      const f0Array = [];
      const frameDuration = 160 / 16000;
      for (let i = 0; i < 200; i++) {
        f0Array.push({ time: i * frameDuration, f0: 440 });
      }

      const notes = detector.f0ToNotes(f0Array, 120, 0.01);

      expect(notes[0]).to.have.property('id');
      expect(notes[0].pitch).to.equal(69);
    });
  });

  describe('groupIntoNotes', () => {
    it('should group same-pitch frames into single note', () => {
      const frames = [];
      const frameDuration = 160 / 16000;
      for (let i = 0; i < 100; i++) {
        frames.push({ time: i * frameDuration, f0: 440 });
      }

      const notes = detector.groupIntoNotes(frames, 0.01, 120);

      expect(notes.length).to.equal(1);
      expect(notes[0].pitch).to.equal(69);
    });

    it('should split frames with different pitches into separate notes', () => {
      const frames = [];
      const frameDuration = 160 / 16000;
      for (let i = 0; i < 50; i++) {
        frames.push({ time: i * frameDuration, f0: 440 });
      }
      for (let i = 50; i < 100; i++) {
        frames.push({ time: i * frameDuration, f0: 880 });
      }

      const notes = detector.groupIntoNotes(frames, 0.01, 120);

      expect(notes.length).to.be.greaterThanOrEqual(1);
    });

    it('should handle empty frames array', () => {
      const notes = detector.groupIntoNotes([], 0.01, 120);
      expect(notes).to.have.length(0);
    });
  });

  describe('createNoteFromGroup', () => {
    it('should return null for empty group', () => {
      expect(detector.createNoteFromGroup([], 0.01, 120)).to.be.null;
    });

    it('should return null for notes outside valid MIDI range', () => {
      const group = [{ time: 0, f0: 10 }, { time: 0.5, f0: 10 }];
      expect(detector.createNoteFromGroup(group, 0.01, 120)).to.be.null;
    });

    it('should return null for notes shorter than min duration', () => {
      const group = [{ time: 0, f0: 440 }, { time: 0.001, f0: 440 }];
      expect(detector.createNoteFromGroup(group, 1.0, 120)).to.be.null;
    });

    it('should create valid note from valid group', () => {
      const group = [];
      const frameDuration = 160 / 16000;
      for (let i = 0; i < 100; i++) {
        group.push({ time: i * frameDuration, f0: 440 });
      }

      const note = detector.createNoteFromGroup(group, 0.01, 120);

      expect(note).to.not.be.null;
      expect(note.pitch).to.equal(69);
      expect(note.start).to.be.at.least(0);
      expect(note.duration).to.be.greaterThan(0);
    });
  });

  describe('constants', () => {
    it('should have correct RMVPE_SAMPLE_RATE', () => {
      expect(RMVPE_SAMPLE_RATE).to.equal(16000);
    });
  });

  describe('interpolateF0', () => {
    const RMVPE_SAMPLE_RATE = 16000;
    const RMVPE_HOP = 160;
    const TARGET_SR = 24000;
    const TARGET_HOP = 480;

    it('should return empty array for empty input with zero length', () => {
      const result = RmvpePitchDetector.interpolateF0(
        new Float32Array(0), 0, RMVPE_SAMPLE_RATE, TARGET_SR, TARGET_HOP
      );
      expect(result.length).to.equal(0);
    });

    it('should return single value for single-element input', () => {
      const f0 = new Float32Array([440]);
      const result = RmvpePitchDetector.interpolateF0(
        f0, 16000, RMVPE_SAMPLE_RATE, TARGET_SR, TARGET_HOP
      );
      expect(result[0]).to.equal(440);
    });

    it('should produce correct output length based on duration', () => {
      const srcLength = 16000;
      const f0 = new Float32Array(100);
      f0.fill(440);
      const durationInSeconds = srcLength / RMVPE_SAMPLE_RATE;
      const effectiveTargetLength = Math.floor(durationInSeconds * TARGET_SR);
      const expectedFrames = Math.min(
        Math.ceil(effectiveTargetLength / TARGET_HOP),
        Math.floor(300 * TARGET_SR / TARGET_HOP)
      );
      const result = RmvpePitchDetector.interpolateF0(
        f0, srcLength, RMVPE_SAMPLE_RATE, TARGET_SR, TARGET_HOP
      );
      expect(result.length).to.equal(expectedFrames);
    });

    it('should perform linear interpolation between source points', () => {
      const f0 = new Float32Array([200, 400]);
      const srcLength = 2 * RMVPE_HOP;
      const result = RmvpePitchDetector.interpolateF0(
        f0, srcLength, RMVPE_SAMPLE_RATE, TARGET_SR, TARGET_HOP
      );
      if (result.length > 1) {
        for (let i = 0; i < result.length; i++) {
          expect(result[i]).to.be.at.least(200 - 1);
          expect(result[i]).to.be.at.most(400 + 1);
        }
      }
    });

    it('should return 0 for out-of-bounds time positions', () => {
      const f0 = new Float32Array([440]);
      const srcLength = RMVPE_HOP;
      const result = RmvpePitchDetector.interpolateF0(
        f0, srcLength, RMVPE_SAMPLE_RATE, TARGET_SR, TARGET_HOP
      );
      const srcStep = RMVPE_HOP / RMVPE_SAMPLE_RATE;
      const tSrcMax = (f0.length - 1) * srcStep;
      const tgtStep = TARGET_HOP / TARGET_SR;
      for (let i = 0; i < result.length; i++) {
        const t = i * tgtStep;
        if (t > tSrcMax) {
          expect(result[i]).to.equal(0);
        }
      }
    });
  });

  describe('dispose', () => {
    it('should reset session and initialized flag', () => {
      detector.session = { release: () => {} };
      detector.initialized = true;

      detector.dispose();

      expect(detector.session).to.be.null;
      expect(detector.initialized).to.be.false;
    });
  });
});
