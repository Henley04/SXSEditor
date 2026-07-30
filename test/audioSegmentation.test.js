const { expect } = require('chai');
const { AudioSegmentation } = require('../src/inference/pipeline/audioSegmentation');

describe('inference/pipeline/audioSegmentation', () => {
  let seg;
  beforeEach(() => { seg = new AudioSegmentation(); });

  describe('fillNoteGaps', () => {
    it('should return input for null/empty/single', () => {
      expect(seg.fillNoteGaps(null)).to.equal(null);
      expect(seg.fillNoteGaps([])).to.deep.equal([]);
      expect(seg.fillNoteGaps([{ start: 0, duration: 1 }])).to.deep.equal([{ start: 0, duration: 1 }]);
    });

    it('should insert rest note in a gap larger than 0.01', () => {
      const notes = [
        { start: 0, duration: 1, lyric: 'a' },
        { start: 2, duration: 1, lyric: 'b' },
      ];
      const out = seg.fillNoteGaps(notes);
      expect(out.length).to.equal(3);
      expect(out[1].lyric).to.equal('');
      expect(out[1].pitch).to.equal(0);
      expect(out[1].start).to.equal(1);
      expect(out[1].duration).to.be.closeTo(1, 1e-6);
    });

    it('should NOT insert rest for tiny gap (<=0.01)', () => {
      const notes = [
        { start: 0, duration: 1, lyric: 'a' },
        { start: 1.005, duration: 1, lyric: 'b' },
      ];
      const out = seg.fillNoteGaps(notes);
      expect(out.length).to.equal(2);
    });

    it('should sort notes by start before filling', () => {
      const notes = [
        { start: 2, duration: 1, lyric: 'b' },
        { start: 0, duration: 1, lyric: 'a' },
      ];
      const out = seg.fillNoteGaps(notes);
      expect(out[0].start).to.equal(0);
      expect(out[out.length - 1].start).to.equal(2);
    });

    it('should handle overlapping notes via Math.max on currentTime', () => {
      const notes = [
        { start: 0, duration: 3, lyric: 'a' },
        { start: 1, duration: 1, lyric: 'b' },
      ];
      const out = seg.fillNoteGaps(notes);
      expect(out.length).to.equal(2);
    });
  });

  describe('buildVocalSegments', () => {
    it('should return single segment for empty notes', () => {
      const out = seg.buildVocalSegments([], 120);
      expect(out.length).to.equal(1);
    });

    it('should return single segment when total duration <= threshold', () => {
      const notes = [{ start: 0, duration: 4, lyric: 'a' }];
      const out = seg.buildVocalSegments(notes, 120);
      expect(out.length).to.equal(1);
      expect(out[0].notes).to.equal(notes);
    });

    it('should split into multiple segments for long audio', () => {
      // build notes spanning > 30s at bpm=60 (1 beat/sec)
      const notes = [];
      for (let i = 0; i < 40; i++) notes.push({ start: i, duration: 1, lyric: 'a' });
      const out = seg.buildVocalSegments(notes, 60);
      expect(out.length).to.be.greaterThan(1);
      // segments should be contiguous (startBeat of next <= endBeat of prev)
      for (let i = 1; i < out.length; i++) {
        expect(out[i].startBeat).to.be.at.most(out[i - 1].endBeat);
      }
    });

    it('should clip notes to segment boundaries', () => {
      const notes = [];
      for (let i = 0; i < 40; i++) notes.push({ start: i, duration: 1, lyric: 'a' });
      const out = seg.buildVocalSegments(notes, 60);
      for (const s of out) {
        for (const n of s.notes) {
          expect(n.start).to.be.at.least(0);
          expect(n.duration).to.be.at.least(0.01);
        }
      }
    });

    it('should prefer rest boundaries for splitting', () => {
      const notes = [];
      // 40 beats with a rest (empty lyric) in the middle
      for (let i = 0; i < 20; i++) notes.push({ start: i, duration: 1, lyric: 'a' });
      notes.push({ start: 20, duration: 2, lyric: '' });
      for (let i = 22; i < 42; i++) notes.push({ start: i, duration: 1, lyric: 'a' });
      const out = seg.buildVocalSegments(notes, 60);
      expect(out.length).to.be.greaterThan(1);
    });
  });

  describe('hashArray', () => {
    it('should return 0 for null', () => {
      expect(seg.hashArray(null)).to.equal(0);
    });

    it('should be deterministic', () => {
      const a = [1, 2, 3, 4, 5];
      expect(seg.hashArray(a)).to.equal(seg.hashArray(a));
    });

    it('should differ for different arrays', () => {
      expect(seg.hashArray([1, 2, 3])).to.not.equal(seg.hashArray([1, 2, 4]));
    });

    it('should differ for arrays differing only in length', () => {
      expect(seg.hashArray([1, 2, 3])).to.not.equal(seg.hashArray([1, 2, 3, 0]));
    });

    it('should handle empty array', () => {
      expect(() => seg.hashArray([])).to.not.throw();
    });

    it('should produce a 32-bit integer', () => {
      const h = seg.hashArray([100, 200, 300]);
      expect(Number.isInteger(h)).to.be.true;
    });

    it('should hash long arrays without full scan (sampling)', () => {
      const big1 = new Array(5000).fill(0);
      const big2 = new Array(5000).fill(0);
      big1[4999] = 1;
      big2[4999] = 2;
      // may or may not collide; just ensure no throw and integer
      expect(Number.isInteger(seg.hashArray(big1))).to.be.true;
      expect(Number.isInteger(seg.hashArray(big2))).to.be.true;
    });
  });

  describe('computeSynthCacheKey', () => {
    it('should produce a string key', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const key = seg.computeSynthCacheKey(notes, 120, {});
      expect(key).to.be.a('string');
      expect(key.length).to.be.greaterThan(0);
    });

    it('should differ when notes change', () => {
      const n1 = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const n2 = [{ lyric: 'b', pitch: 60, start: 0, duration: 1 }];
      expect(seg.computeSynthCacheKey(n1, 120, {})).to.not.equal(seg.computeSynthCacheKey(n2, 120, {}));
    });

    it('should differ when bpm changes', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      expect(seg.computeSynthCacheKey(notes, 120, {})).to.not.equal(seg.computeSynthCacheKey(notes, 100, {}));
    });

    it('should differ when pitchShift changes', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      expect(seg.computeSynthCacheKey(notes, 120, { pitchShift: 0 })).to.not.equal(
        seg.computeSynthCacheKey(notes, 120, { pitchShift: 2 })
      );
    });

    it('should differ when language changes', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      expect(seg.computeSynthCacheKey(notes, 120, { language: 'zh' })).to.not.equal(
        seg.computeSynthCacheKey(notes, 120, { language: 'ja' })
      );
    });

    it('should incorporate phonemeAdjustments (regression: edits must invalidate cache)', () => {
      const baseNote = { lyric: 'a', pitch: 60, start: 0, duration: 1 };
      const withAdj = { ...baseNote, phonemeAdjustments: [{ durationRatio: 0.5, offsetRatio: 0 }] };
      const withAdj2 = { ...baseNote, phonemeAdjustments: [{ durationRatio: 0.7, offsetRatio: 0 }] };
      expect(seg.computeSynthCacheKey([baseNote], 120, {})).to.not.equal(
        seg.computeSynthCacheKey([withAdj], 120, {})
      );
      expect(seg.computeSynthCacheKey([withAdj], 120, {})).to.not.equal(
        seg.computeSynthCacheKey([withAdj2], 120, {})
      );
    });

    it('should incorporate volumePoints in phonemeAdjustments', () => {
      const n1 = { lyric: 'a', pitch: 60, start: 0, duration: 1, phonemeAdjustments: [{ durationRatio: 0.5, volumePoints: [{ t: 0, v: 1 }] }] };
      const n2 = { lyric: 'a', pitch: 60, start: 0, duration: 1, phonemeAdjustments: [{ durationRatio: 0.5, volumePoints: [{ t: 0, v: 0.5 }] }] };
      expect(seg.computeSynthCacheKey([n1], 120, {})).to.not.equal(
        seg.computeSynthCacheKey([n2], 120, {})
      );
    });

    it('should incorporate f0Envelope keyframes', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const opts1 = { f0Envelope: { keyframes: [{ time: 0, value: 0 }] } };
      const opts2 = { f0Envelope: { keyframes: [{ time: 0, value: 2 }] } };
      expect(seg.computeSynthCacheKey(notes, 120, opts1)).to.not.equal(
        seg.computeSynthCacheKey(notes, 120, opts2)
      );
    });

    it('should be deterministic for identical inputs', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const opts = { nSteps: 32, cfg: 3.0, language: 'zh' };
      expect(seg.computeSynthCacheKey(notes, 120, opts)).to.equal(
        seg.computeSynthCacheKey(notes, 120, opts)
      );
    });

    it('should differ when singerId changes (regression: moving fragment to different singer must invalidate cache)', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      expect(seg.computeSynthCacheKey(notes, 120, { singerId: 'singerA' })).to.not.equal(
        seg.computeSynthCacheKey(notes, 120, { singerId: 'singerB' })
      );
    });

    it('should differ when diffStepChunk settings change', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const noChunk = seg.computeSynthCacheKey(notes, 120, {});
      const chunkOn = seg.computeSynthCacheKey(notes, 120, { diffStepChunk: true, diffStepChunkFrames: 500, diffStepOverlapFrames: 50 });
      const chunkDifferentSize = seg.computeSynthCacheKey(notes, 120, { diffStepChunk: true, diffStepChunkFrames: 800, diffStepOverlapFrames: 50 });
      const chunkDifferentOverlap = seg.computeSynthCacheKey(notes, 120, { diffStepChunk: true, diffStepChunkFrames: 500, diffStepOverlapFrames: 100 });
      expect(noChunk).to.not.equal(chunkOn);
      expect(chunkOn).to.not.equal(chunkDifferentSize);
      expect(chunkOn).to.not.equal(chunkDifferentOverlap);
    });

    // Task 14: refHash FNV-1a full-length — two buffers sharing the first 4000
    // bytes (old scan window) but differing later must produce different cache
    // keys. The old "first 4000 bytes with stride" scan would miss the
    // difference and cause a false cache hit on long reference audio.
    it('should differ for ref buffers sharing first 4000 bytes but differing later (Task 14)', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      // Build two 10000-byte buffers that are identical in the first 4000 bytes
      // (covers the old scan window entirely) but differ in bytes 4000..10000.
      const len = 10000;
      const bufA = new Uint8Array(len);
      const bufB = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        // Same low-byte pattern across both buffers for the first 4000 bytes
        const v = (i * 7) & 0xff;
        bufA[i] = v;
        bufB[i] = v;
      }
      // Diverge only after the old 4000-byte scan window
      for (let i = 4000; i < len; i++) {
        bufA[i] = (i * 3) & 0xff;
        bufB[i] = (i * 5) & 0xff;
      }
      const keyA = seg.computeSynthCacheKey(notes, 120, { refAudioWavBuffer: bufA });
      const keyB = seg.computeSynthCacheKey(notes, 120, { refAudioWavBuffer: bufB });
      expect(keyA).to.not.equal(keyB);
    });

    it('should produce identical cache key for identical ref buffers (Task 14 determinism)', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const len = 8000;
      const bufA = new Uint8Array(len);
      const bufB = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bufA[i] = (i * 13) & 0xff;
        bufB[i] = (i * 13) & 0xff;
      }
      const keyA = seg.computeSynthCacheKey(notes, 120, { refAudioWavBuffer: bufA });
      const keyB = seg.computeSynthCacheKey(notes, 120, { refAudioWavBuffer: bufB });
      expect(keyA).to.equal(keyB);
    });
  });

  describe('computeSegmentCacheKey', () => {
    it('should produce a string key extending the synth cache key', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const key = seg.computeSegmentCacheKey(notes, 120, {}, 0, 0, 50);
      expect(key).to.be.a('string');
      expect(key.length).to.be.greaterThan(0);
      // 应包含 segStartBeat / segF0Shift / ptFrameCount 后缀
      expect(key).to.contain('_sb0_fs0_pt50');
    });

    it('should be deterministic for identical inputs', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      expect(seg.computeSegmentCacheKey(notes, 120, {}, 4, 2, 50))
        .to.equal(seg.computeSegmentCacheKey(notes, 120, {}, 4, 2, 50));
    });

    it('should differ when segStartBeat changes (pitchCurveF0 is absolute-time indexed)', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      expect(seg.computeSegmentCacheKey(notes, 120, {}, 0, 0, 50))
        .to.not.equal(seg.computeSegmentCacheKey(notes, 120, {}, 16, 0, 50));
    });

    it('should differ when segF0Shift changes (per-segment f0Shift B2)', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      expect(seg.computeSegmentCacheKey(notes, 120, {}, 0, 0, 50))
        .to.not.equal(seg.computeSegmentCacheKey(notes, 120, {}, 0, 3, 50));
    });

    it('should differ when ptFrameCount changes', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      expect(seg.computeSegmentCacheKey(notes, 120, {}, 0, 0, 50))
        .to.not.equal(seg.computeSegmentCacheKey(notes, 120, {}, 0, 0, 20));
    });

    it('should differ when segment notes change (regression: editing one segment must not hit another segment cache)', () => {
      const n1 = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const n2 = [{ lyric: 'a', pitch: 64, start: 0, duration: 1 }];
      expect(seg.computeSegmentCacheKey(n1, 120, {}, 0, 0, 50))
        .to.not.equal(seg.computeSegmentCacheKey(n2, 120, {}, 0, 0, 50));
    });

    it('should share the base with computeSynthCacheKey (segment key = base + suffix)', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const base = seg.computeSynthCacheKey(notes, 120, { nSteps: 32, cfg: 3.0 });
      const segKey = seg.computeSegmentCacheKey(notes, 120, { nSteps: 32, cfg: 3.0 }, 8, -2, 30);
      expect(segKey.startsWith(base)).to.equal(true);
    });
  });

  describe('median', () => {
    it('should return 0 for null/empty', () => {
      expect(seg.median(null)).to.equal(0);
      expect(seg.median([])).to.equal(0);
    });
    it('should return the element for odd-length array', () => {
      expect(seg.median([5])).to.equal(5);
      expect(seg.median([1, 3, 2])).to.equal(2);
    });
    it('should return the average of two middle elements for even-length', () => {
      expect(seg.median([1, 2, 3, 4])).to.equal(2.5);
    });
    it('should not mutate the input array', () => {
      const arr = [3, 1, 2];
      const snapshot = arr.slice();
      seg.median(arr);
      expect(arr).to.deep.equal(snapshot);
    });
    it('should handle negative numbers', () => {
      expect(seg.median([-3, -1, -2])).to.equal(-2);
    });
  });
});
