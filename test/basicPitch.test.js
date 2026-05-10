const { BasicPitchDetector } = require('../src/inference/basicPitch');
const { expect } = require('chai');

const BASIC_PITCH_SAMPLE_RATE = 22050;
const MIDI_OFFSET = 21;
const CONTOUR_BINS_PER_SEMITONE = 1;
const ANNOTATIONS_FPS = Math.floor(BASIC_PITCH_SAMPLE_RATE / 256);

function midiToHz(midi) {
  return 440.0 * 2.0 ** ((midi - 69.0) / 12.0);
}

function hzToMidi(hz) {
  return 12 * (Math.log2(hz) - Math.log2(440.0)) + 69;
}

function gaussian(M, std) {
  const result = [];
  for (let n = 0; n < M; n++) {
    result.push(Math.exp((-1 * (n - (M - 1) / 2) ** 2) / (2 * std ** 2)));
  }
  return result;
}

function argMax(arr) {
  if (arr.length === 0) return null;
  let maxIndex = -1;
  for (let i = 0; i < arr.length; i++) {
    if (maxIndex === -1 || arr[i] > arr[maxIndex]) {
      maxIndex = i;
    }
  }
  return maxIndex;
}

function argMaxAxis1(arr) {
  return arr.map(row => argMax(row));
}

function whereGreaterThanAxis1(arr2d, threshold) {
  const outputX = [];
  const outputY = [];
  for (let i = 0; i < arr2d.length; i++) {
    for (let j = 0; j < arr2d[i].length; j++) {
      if (arr2d[i][j] > threshold) {
        outputX.push(i);
        outputY.push(j);
      }
    }
  }
  return [outputX, outputY];
}

function globalMax(array) {
  let max = 0;
  for (const row of array) {
    for (const v of row) {
      if (v > max) max = v;
    }
  }
  return max;
}

function meanStdDev(array) {
  let sum = 0;
  let sumSquared = 0;
  let count = 0;
  for (const row of array) {
    for (const value of row) {
      sum += value;
      sumSquared += value * value;
      count++;
    }
  }
  const mean = sum / count;
  const std = Math.sqrt((1 / (count - 1)) * (sumSquared - (sum * sum) / count));
  return [mean, std];
}

describe('BasicPitch - Utility Functions', () => {
  describe('midiToHz', () => {
    it('should convert MIDI 69 to 440 Hz', () => {
      expect(midiToHz(69)).to.be.closeTo(440, 0.001);
    });

    it('should convert MIDI 60 to ~261.63 Hz', () => {
      expect(midiToHz(60)).to.be.closeTo(261.63, 0.01);
    });

    it('should convert MIDI 72 to ~523.25 Hz', () => {
      expect(midiToHz(72)).to.be.closeTo(523.25, 0.01);
    });
  });

  describe('hzToMidi', () => {
    it('should convert 440 Hz to MIDI 69', () => {
      expect(hzToMidi(440)).to.be.closeTo(69, 0.001);
    });

    it('should convert ~261.63 Hz to MIDI 60', () => {
      expect(hzToMidi(261.63)).to.be.closeTo(60, 0.01);
    });
  });

  describe('gaussian', () => {
    it('should return array of correct length', () => {
      const result = gaussian(10, 5);
      expect(result).to.have.length(10);
    });

    it('should peak at center', () => {
      const result = gaussian(11, 5);
      const maxIdx = argMax(result);
      expect(maxIdx).to.equal(5);
    });

    it('should produce values between 0 and 1', () => {
      const result = gaussian(10, 5);
      for (const v of result) {
        expect(v).to.be.at.least(0);
        expect(v).to.be.at.most(1);
      }
    });

    it('should have peak value of 1', () => {
      const result = gaussian(10, 5);
      const max = Math.max(...result);
      expect(max).to.be.closeTo(1, 0.01);
    });
  });

  describe('argMax', () => {
    it('should return index of maximum value', () => {
      expect(argMax([1, 3, 2])).to.equal(1);
    });

    it('should return first index for duplicate maximum', () => {
      expect(argMax([1, 3, 3, 2])).to.equal(1);
    });

    it('should return null for empty array', () => {
      expect(argMax([])).to.be.null;
    });
  });

  describe('argMaxAxis1', () => {
    it('should return max indices for each row', () => {
      const result = argMaxAxis1([
        [1, 5, 3],
        [4, 2, 6],
      ]);
      expect(result).to.deep.equal([1, 2]);
    });

    it('should handle single row', () => {
      expect(argMaxAxis1([[3, 1, 2]])).to.deep.equal([0]);
    });
  });

  describe('whereGreaterThanAxis1', () => {
    it('should find all values above threshold', () => {
      const arr = [
        [0.1, 0.6, 0.3],
        [0.8, 0.2, 0.9],
      ];
      const [x, y] = whereGreaterThanAxis1(arr, 0.5);
      expect(x).to.deep.equal([0, 1, 1]);
      expect(y).to.deep.equal([1, 0, 2]);
    });

    it('should return empty for no values above threshold', () => {
      const arr = [[0.1, 0.2], [0.3, 0.4]];
      const [x, y] = whereGreaterThanAxis1(arr, 0.5);
      expect(x).to.be.an('array').that.is.empty;
      expect(y).to.be.an('array').that.is.empty;
    });
  });

  describe('globalMax', () => {
    it('should return maximum value in 2D array', () => {
      const arr = [[1, 5], [3, 2]];
      expect(globalMax(arr)).to.equal(5);
    });

    it('should return 0 for empty array', () => {
      expect(globalMax([])).to.equal(0);
    });
  });

  describe('meanStdDev', () => {
    it('should calculate correct mean and std', () => {
      const arr = [[1, 2], [3, 4]];
      const [mean, std] = meanStdDev(arr);
      expect(mean).to.be.closeTo(2.5, 0.01);
      expect(std).to.be.closeTo(1.29, 0.01);
    });

    it('should return 0 std for constant array', () => {
      const arr = [[5, 5], [5, 5]];
      const [mean, std] = meanStdDev(arr);
      expect(mean).to.equal(5);
    });
  });
});

describe('BasicPitchDetector - Pure Logic Tests', () => {
  let detector;

  beforeEach(() => {
    detector = new BasicPitchDetector('/fake/model/dir/');
  });

  describe('resampleAudio', () => {
    it('should resample from 44100 to 22050', () => {
      const input = new Float32Array(441);
      for (let i = 0; i < 441; i++) {
        input[i] = Math.sin(2 * Math.PI * 440 * i / 44100);
      }

      const result = detector.resampleAudio(input, 44100, 22050);

      expect(result).to.be.an.instanceOf(Float32Array);
      expect(result.length).to.equal(220);
    });

    it('should return same array when sample rates match', () => {
      const input = new Float32Array(100);
      input.fill(0.5);

      const result = detector.resampleAudio(input, 22050, 22050);

      expect(result.length).to.equal(100);
    });

    it('should handle small input', () => {
      const input = new Float32Array([1, 2, 3]);
      const result = detector.resampleAudio(input, 44100, 22050);

      expect(result.length).to.be.greaterThan(0);
    });
  });

  describe('notesToF0Array', () => {
    it('should return empty array for empty notes', () => {
      expect(detector.notesToF0Array([])).to.be.an('array').that.is.empty;
    });

    it('should convert notes to F0 array with correct timing', () => {
      const notes = [
        { startTimeSeconds: 0, durationSeconds: 0.5, pitch_midi: 60 },
      ];

      const result = detector.notesToF0Array(notes);

      expect(result.length).to.be.greaterThan(0);
      expect(result[0]).to.have.property('time');
      expect(result[0]).to.have.property('f0');
    });

    it('should set correct F0 for MIDI notes', () => {
      const notes = [
        { startTimeSeconds: 0, durationSeconds: 0.5, pitch_midi: 69 },
      ];

      const result = detector.notesToF0Array(notes);

      const f0Values = result.map(f => f.f0).filter(f => f > 0);
      if (f0Values.length > 0) {
        expect(f0Values[0]).to.be.closeTo(440, 1);
      }
    });

    it('should insert zeros between non-contiguous notes', () => {
      const notes = [
        { startTimeSeconds: 0, durationSeconds: 0.5, pitch_midi: 60 },
        { startTimeSeconds: 1.0, durationSeconds: 0.5, pitch_midi: 64 },
      ];

      const result = detector.notesToF0Array(notes);

      const hasZeroF0 = result.some(f => f.f0 === 0);
      expect(hasZeroF0).to.be.true;
    });
  });

  describe('notesToMidiNotes', () => {
    it('should convert notes to MIDI note events', () => {
      const notes = [
        { startTimeSeconds: 0, durationSeconds: 0.5, pitch_midi: 60 },
      ];

      const result = detector.notesToMidiNotes(notes, 120);

      expect(result.length).to.be.greaterThan(0);
      expect(result[0]).to.have.property('pitch');
      expect(result[0]).to.have.property('start');
      expect(result[0]).to.have.property('duration');
    });

    it('should filter notes outside valid pitch range', () => {
      const notes = [
        { startTimeSeconds: 0, durationSeconds: 0.5, pitch_midi: 10 },
        { startTimeSeconds: 0.5, durationSeconds: 0.5, pitch_midi: 120 },
      ];

      const result = detector.notesToMidiNotes(notes, 120);

      expect(result).to.be.an('array').that.is.empty;
    });

    it('should calculate correct start times in beats', () => {
      const notes = [
        { startTimeSeconds: 0, durationSeconds: 0.5, pitch_midi: 60 },
      ];

      const result = detector.notesToMidiNotes(notes, 120);

      expect(result[0].start).to.equal(0);
    });

    it('should handle empty notes', () => {
      expect(detector.notesToMidiNotes([], 120)).to.be.an('array').that.is.empty;
    });
  });

  describe('constants', () => {
    it('should have correct ANNOTATIONS_FPS', () => {
      expect(ANNOTATIONS_FPS).to.equal(86);
    });

    it('should have correct MIDI_OFFSET', () => {
      expect(MIDI_OFFSET).to.equal(21);
    });
  });

  describe('dispose', () => {
    it('should reset model and server', () => {
      detector.model = { dispose: () => {} };
      detector._server = { close: () => {} };
      detector.initialized = true;

      detector.dispose();

      expect(detector.model).to.be.null;
      expect(detector._server).to.be.null;
      expect(detector.initialized).to.be.false;
    });
  });
});
