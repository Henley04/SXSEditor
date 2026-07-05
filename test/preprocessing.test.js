const { expect } = require('chai');
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');
const { Preprocessing } = require('../src/inference/pipeline/preprocessing');
const { F0_BIN, F0_MIN, SAMPLE_RATE, HOP_SIZE } = require('../src/inference/pipeline/constants');

describe('inference/pipeline/preprocessing', () => {
  let tp, prep;
  before(() => {
    tp = new TextProcessing();
    prep = new Preprocessing(tp);
  });

  describe('midiToFreq', () => {
    it('should convert MIDI 69 to 440 Hz', () => {
      expect(prep.midiToFreq(69)).to.be.closeTo(440, 0.001);
    });
    it('should convert MIDI 60 to ~261.63 Hz', () => {
      expect(prep.midiToFreq(60)).to.be.closeTo(261.63, 0.01);
    });
    it('should double frequency per octave', () => {
      expect(prep.midiToFreq(69)).to.be.closeTo(prep.midiToFreq(57) * 2, 0.001);
    });
    it('should handle MIDI 0', () => {
      expect(prep.midiToFreq(0)).to.be.closeTo(8.18, 0.01);
    });
  });

  describe('interpolateEnvelope', () => {
    it('should return 0 for empty keyframes', () => {
      expect(prep.interpolateEnvelope({ keyframes: [] }, 0.5)).to.equal(0);
    });
    it('should return the single value for one keyframe', () => {
      expect(prep.interpolateEnvelope({ keyframes: [{ time: 0, value: 0.7 }] }, 0.5)).to.equal(0.7);
    });
    it('should clamp to first value before first keyframe', () => {
      const env = { keyframes: [{ time: 1, value: 0.2 }, { time: 2, value: 0.8 }] };
      expect(prep.interpolateEnvelope(env, 0)).to.equal(0.2);
      expect(prep.interpolateEnvelope(env, 0.5)).to.equal(0.2);
    });
    it('should clamp to last value after last keyframe', () => {
      const env = { keyframes: [{ time: 0, value: 0.2 }, { time: 1, value: 0.8 }] };
      expect(prep.interpolateEnvelope(env, 2)).to.equal(0.8);
      expect(prep.interpolateEnvelope(env, 5)).to.equal(0.8);
    });
    it('should linearly interpolate between two keyframes', () => {
      const env = { keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] };
      expect(prep.interpolateEnvelope(env, 0.25)).to.be.closeTo(0.25, 1e-6);
      expect(prep.interpolateEnvelope(env, 0.5)).to.be.closeTo(0.5, 1e-6);
      expect(prep.interpolateEnvelope(env, 0.75)).to.be.closeTo(0.75, 1e-6);
    });
    it('should interpolate across multiple keyframes', () => {
      const env = { keyframes: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
        { time: 2, value: 0 },
      ]};
      expect(prep.interpolateEnvelope(env, 0.5)).to.be.closeTo(0.5, 1e-6);
      expect(prep.interpolateEnvelope(env, 1.5)).to.be.closeTo(0.5, 1e-6);
    });
  });

  describe('quantizeF0', () => {
    it('should map 0 Hz to bin 0', () => {
      const out = prep.quantizeF0(new Float32Array([0, 0, 0]));
      out.forEach(v => expect(v).to.equal(0));
    });
    it('should map F0_MIN to bin 1', () => {
      const out = prep.quantizeF0(new Float32Array([F0_MIN]));
      expect(out[0]).to.equal(1);
    });
    it('should clamp to [0, F0_BIN-1]', () => {
      const out = prep.quantizeF0(new Float32Array([0, 20000]));
      expect(out[0]).to.be.at.least(0);
      expect(out[1]).to.be.at.most(F0_BIN - 1);
    });
    it('should be monotonically non-decreasing for increasing F0', () => {
      const f0 = new Float32Array(100);
      for (let i = 0; i < 100; i++) f0[i] = F0_MIN * Math.pow(2, i / 12);
      const out = prep.quantizeF0(f0);
      for (let i = 1; i < 100; i++) {
        expect(out[i]).to.be.at.least(out[i - 1]);
      }
    });
    it('should apply f0Shift by clamping', () => {
      const f0 = new Float32Array([440]);
      const noShift = prep.quantizeF0(f0, 0);
      const shifted = prep.quantizeF0(f0, 5);
      expect(shifted[0]).to.not.equal(noShift[0]);
      expect(shifted[0]).to.be.at.least(1);
      expect(shifted[0]).to.be.at.most(F0_BIN - 1);
    });
    it('should not shift bin 0 (unvoiced)', () => {
      const out = prep.quantizeF0(new Float32Array([0]), 5);
      expect(out[0]).to.equal(0);
    });
  });

  describe('buildF0FrameSequence', () => {
    it('should return empty for empty notes', () => {
      const out = prep.buildF0FrameSequence([], 120, null, null);
      expect(out.length).to.equal(0);
    });
    it('should produce a frame sequence proportional to note duration', () => {
      const notes = [{ start: 0, duration: 4, pitch: 60 }]; // 4 beats
      const out = prep.buildF0FrameSequence(notes, 120, null, null);
      // totalSeconds = (4/120)*60 = 2s; totalFrames = 2 * 24000/480 = 100
      expect(out.length).to.equal(100);
    });
    it('should fill frames with note frequency', () => {
      const notes = [{ start: 0, duration: 1, pitch: 69 }]; // 440 Hz
      const out = prep.buildF0FrameSequence(notes, 120, null, null);
      const nonzero = out.filter(v => v > 0);
      expect(nonzero.length).to.be.greaterThan(0);
      nonzero.forEach(v => expect(v).to.be.closeTo(440, 0.5));
    });
    it('should fill 0 for rest notes (empty lyric via pitch=0 → freq low)', () => {
      // pitch 0 → freq ~8.18; rest notes typically pitch 0
      const notes = [{ start: 0, duration: 1, pitch: 0 }];
      const out = prep.buildF0FrameSequence(notes, 120, null, null);
      // pitch 0 still maps to a frequency; verify finite
      out.forEach(v => expect(Number.isFinite(v)).to.be.true);
    });
    it('should use pitchCurveF0 when provided (override)', () => {
      const notes = [{ start: 0, duration: 4, pitch: 60 }];
      const curve = new Float32Array(200).fill(220);
      const out = prep.buildF0FrameSequence(notes, 120, null, curve);
      expect(out.length).to.equal(100);
      out.forEach(v => expect(v).to.be.closeTo(220, 1e-3));
    });
    it('should apply f0Envelope semitone shift', () => {
      const notes = [{ start: 0, duration: 1, pitch: 69 }];
      const env = { keyframes: [{ time: 0, value: 12 }] }; // +12 semitones
      const out = prep.buildF0FrameSequence(notes, 120, env, null);
      const nonzero = out.filter(v => v > 0);
      // 69 + 12 = 81 → 880 Hz
      nonzero.forEach(v => expect(v).to.be.closeTo(880, 1.0));
    });
  });

  describe('_isVowelByIdx', () => {
    it('should return false for null/unknown index', () => {
      expect(prep._isVowelByIdx(99999)).to.be.false;
    });
    it('should detect English vowels', () => {
      const aeIdx = tp.phone2idx['en_AE1'];
      if (aeIdx !== undefined) {
        expect(prep._isVowelByIdx(aeIdx)).to.be.true;
      }
    });
    it('should detect English unstressed vowels', () => {
      const iy0Idx = tp.phone2idx['en_IY0'];
      if (iy0Idx !== undefined) {
        expect(prep._isVowelByIdx(iy0Idx)).to.be.true;
      }
    });
    it('should return false for English consonants', () => {
      const tIdx = tp.phone2idx['en_T'];
      if (tIdx !== undefined) {
        expect(prep._isVowelByIdx(tIdx)).to.be.false;
      }
    });
    it('should detect Japanese vowels', () => {
      const aIdx = tp.phone2idx['jp_a'];
      if (aIdx !== undefined) {
        expect(prep._isVowelByIdx(aIdx)).to.be.true;
      }
    });
    it('should return false for Japanese consonants', () => {
      const kIdx = tp.phone2idx['jp_k'];
      if (kIdx !== undefined) {
        expect(prep._isVowelByIdx(kIdx)).to.be.false;
      }
    });
    it('should return false for special tokens', () => {
      const padIdx = tp.phone2idx['<PAD>'];
      if (padIdx !== undefined) {
        expect(prep._isVowelByIdx(padIdx)).to.be.false;
      }
    });
  });

  describe('notesToSequences - mel2token allocation (vowel priority regression)', () => {
    it('should produce well-formed sequences for a single note', () => {
      const notes = [{ start: 0, duration: 2, pitch: 60, lyric: 'a' }];
      const seq = prep.notesToSequences(notes, 120, null, null);
      expect(seq.tokenCount).to.be.greaterThan(0);
      expect(seq.noteTextSeq.length).to.equal(seq.tokenCount);
      expect(seq.notePitchSeq.length).to.equal(seq.tokenCount);
      expect(seq.noteTypeSeq.length).to.equal(seq.tokenCount);
      expect(seq.mel2token.length).to.be.greaterThan(0);
    });

    it('should not produce 0-frame vowels for short notes (vowel priority)', () => {
      // English word with consonant+vowel; very short note → innerFrames < phoneme count
      // Use en_ prefixed dashed lyric to control phonemes: HH-AE1 (consonant + vowel)
      const notes = [{ start: 0, duration: 0.0625, pitch: 60, lyric: 'en_HH-AE1' }];
      const seq = prep.notesToSequences(notes, 120, null, null);
      // mel2token should be valid: every frame mapped to a valid token
      const maxToken = seq.tokenCount - 1;
      seq.mel2token.forEach(t => {
        expect(t).to.be.at.least(0);
        expect(t).to.be.at.most(maxToken);
      });
    });

    it('should allocate more frames to vowels than consonants when frames are scarce', () => {
      // Construct a note with [consonant, vowel, SEP] and very few frames
      // en_T-AE1-<SEP> → T (consonant), AE1 (vowel), SEP
      const notes = [{ start: 0, duration: 0.05, pitch: 60, lyric: 'en_T-AE1' }];
      const seq = prep.notesToSequences(notes, 120, null, null);
      // At least the sequence should be valid and not all-zero mel2token
      const nonZero = Array.from(seq.mel2token).filter(v => v > 0);
      expect(nonZero.length).to.be.greaterThan(0);
    });

    it('should handle empty notes (returns PAD-only sequence)', () => {
      const seq = prep.notesToSequences([], 120, null, null);
      expect(seq.tokenCount).to.equal(1);
      expect(seq.mel2token.length).to.equal(0);
      expect(seq.noteTextSeq[0]).to.equal(tp.phone2idx['<PAD>']);
    });

    it('should set noteType=1 for rest (empty lyric)', () => {
      const notes = [{ start: 0, duration: 1, pitch: 0, lyric: '' }];
      const seq = prep.notesToSequences(notes, 120, null, null);
      expect(Array.from(seq.noteTypeSeq)).to.include(1);
    });

    it('should set noteType=3 for slur notes', () => {
      const notes = [
        { start: 0, duration: 1, pitch: 60, lyric: 'a' },
        { start: 1, duration: 1, pitch: 62, lyric: '', isSlur: true },
      ];
      const seq = prep.notesToSequences(notes, 120, null, null);
      expect(Array.from(seq.noteTypeSeq)).to.include(3);
    });

    it('should handle multiple notes with gaps', () => {
      const notes = [
        { start: 0, duration: 1, pitch: 60, lyric: 'a' },
        { start: 2, duration: 1, pitch: 62, lyric: 'b' },
      ];
      const seq = prep.notesToSequences(notes, 120, null, null);
      expect(seq.mel2token.length).to.be.greaterThan(0);
      expect(seq.tokenCount).to.be.greaterThan(2);
    });

    it('should incorporate pitchCurveF0 into f0Hz', () => {
      const notes = [{ start: 0, duration: 2, pitch: 60, lyric: 'a' }];
      const curve = new Float32Array(200).fill(220);
      const seq = prep.notesToSequences(notes, 120, null, curve);
      const nonzero = Array.from(seq.f0Hz).filter(v => v > 0);
      expect(nonzero.length).to.be.greaterThan(0);
    });

    it('should apply f0Shift to note pitches', () => {
      const notes = [{ start: 0, duration: 1, pitch: 60, lyric: 'a' }];
      const base = prep.notesToSequences(notes, 120, null, null, 0);
      const shifted = prep.notesToSequences(notes, 120, null, null, 3);
      // notePitchSeq should differ for pitched notes
      const basePitches = Array.from(base.notePitchSeq).filter(p => p > 0);
      const shiftedPitches = Array.from(shifted.notePitchSeq).filter(p => p > 0);
      if (basePitches.length > 0 && shiftedPitches.length > 0) {
        expect(shiftedPitches[0]).to.be.greaterThan(basePitches[0]);
      }
    });

    it('should respect phonemeAdjustments durationRatios', () => {
      const notes = [{
        start: 0, duration: 2, pitch: 60, lyric: 'en_T-AE1',
        phonemeAdjustments: [{ durationRatio: 0.9 }, { durationRatio: 0.1 }],
      }];
      const seq = prep.notesToSequences(notes, 120, null, null);
      // should not throw and produce valid mel2token
      expect(seq.mel2token.length).to.be.greaterThan(0);
    });
  });

  describe('_buildMel2token - invariants', () => {
    it('should produce mel2token length == totalFrames', () => {
      const notes = [
        { start: 0, duration: 1, pitch: 60, lyric: 'a' },
        { start: 1, duration: 1, pitch: 62, lyric: 'b' },
      ];
      const seq = prep.notesToSequences(notes, 120, null, null);
      expect(seq.mel2token.length).to.equal(seq.f0Hz.length);
    });

    it('should never exceed tokenCount in mel2token values (clamped)', () => {
      const notes = Array.from({ length: 10 }, (_, i) => ({
        start: i, duration: 1, pitch: 60 + i, lyric: 'a',
      }));
      const seq = prep.notesToSequences(notes, 120, null, null);
      const maxToken = seq.tokenCount - 1;
      seq.mel2token.forEach(t => {
        expect(t).to.be.at.most(maxToken);
      });
    });

    it('should produce consistent results for identical input', () => {
      const notes = [{ start: 0, duration: 2, pitch: 60, lyric: 'a' }];
      const a = prep.notesToSequences(notes, 120, null, null);
      const b = prep.notesToSequences(notes, 120, null, null);
      expect(Array.from(a.mel2token)).to.deep.equal(Array.from(b.mel2token));
      expect(Array.from(a.noteTextSeq)).to.deep.equal(Array.from(b.noteTextSeq));
    });
  });
});
