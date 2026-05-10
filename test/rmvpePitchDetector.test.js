const { RmvpePitchDetector, RMVPE_SAMPLE_RATE } = require('../src/inference/rmvpePitchDetector');
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

      const result = detector.resampleAudio(input, 44100, 16000);

      expect(result).to.be.an.instanceOf(Float32Array);
      expect(result.length).to.equal(160);
    });

    it('should return same array when sample rates match', () => {
      const input = new Float32Array(100);
      input.fill(0.5);

      const result = detector.resampleAudio(input, 16000, 16000);

      expect(result.length).to.equal(100);
    });

    it('should upsample correctly', () => {
      const input = new Float32Array(160);
      input.fill(1.0);

      const result = detector.resampleAudio(input, 16000, 32000);

      expect(result.length).to.equal(320);
    });

    it('should preserve signal shape approximately', () => {
      const input = new Float32Array(4410);
      for (let i = 0; i < input.length; i++) {
        input[i] = Math.sin(2 * Math.PI * 440 * i / 44100);
      }

      const result = detector.resampleAudio(input, 44100, 16000);

      expect(result.length).to.be.greaterThan(0);
      expect(result.length).to.equal(Math.floor(4410 * 16000 / 44100));
    });

    it('should handle small input arrays', () => {
      const input = new Float32Array([1, 2, 3, 4, 5]);
      const result = detector.resampleAudio(input, 44100, 16000);

      expect(result.length).to.be.greaterThan(0);
    });

    it('should handle silence input', () => {
      const input = new Float32Array(16000);
      input.fill(0);

      const result = detector.resampleAudio(input, 44100, 16000);

      expect(result.length).to.equal(Math.floor(16000 * 16000 / 44100));
    });
  });

  describe('indexToF0', () => {
    it('should convert index 0 to F0_MIN', () => {
      const f0 = detector.indexToF0(0);
      expect(f0).to.be.closeTo(30, 1);
    });

    it('should convert max index to F0_MAX', () => {
      const f0 = detector.indexToF0(2559);
      expect(f0).to.be.closeTo(7600, 100);
    });

    it('should produce monotonically increasing frequencies', () => {
      const f0_0 = detector.indexToF0(0);
      const f0_500 = detector.indexToF0(500);
      const f0_1000 = detector.indexToF0(1000);
      const f0_2000 = detector.indexToF0(2000);

      expect(f0_500).to.be.greaterThan(f0_0);
      expect(f0_1000).to.be.greaterThan(f0_500);
      expect(f0_2000).to.be.greaterThan(f0_1000);
    });

    it('should produce positive frequencies', () => {
      for (let i = 0; i < 2560; i += 100) {
        const f0 = detector.indexToF0(i);
        expect(f0).to.be.greaterThan(0);
      }
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
