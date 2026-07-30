const { expect } = require('chai');
const { wsolaCrossfade, wsolaCrossfadeMel } = require('../src/inference/pipeline/wsola');

/**
 * WSOLA (Waveform Similarity Overlap-Add) crossfade tests.
 *
 * Verifies:
 *   1. Time-domain: phase-continuous sine chunks crossfade smoothly (no boundary
 *      discontinuity / spectral sidebands).
 *   2. Time-domain: chunks with a phase offset are aligned by WSOLA (smoother
 *      than a naive Hann OLA which would leave the discontinuity in place).
 *   3. Mel-domain: per-frame cosine similarity picks the best alignment.
 */
describe('WSOLA crossfade', () => {
  const SAMPLE_RATE = 24000;

  describe('wsolaCrossfade (time domain)', () => {
    it('returns the correct output length (prevTail + currHead - overlap)', () => {
      const prevTail = new Float32Array(100);
      const currHead = new Float32Array(100);
      const out = wsolaCrossfade(prevTail, currHead, 100, SAMPLE_RATE);
      // 100 + 100 - 100 = 100 (just the crossfaded overlap region)
      expect(out.length).to.equal(100);

      const out2 = wsolaCrossfade(prevTail, currHead, 40, SAMPLE_RATE);
      // 100 + 100 - 40 = 160 (prefix + overlap + suffix)
      expect(out2.length).to.equal(160);
    });

    it('sine wave (phase-continuous) → smooth output, no boundary discontinuity', () => {
      const freq = 440;
      const O = 300;
      const sineAt = (i) => Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE);
      // prevTail = sine[T-O, T), currHead = sine[T, T+O) — phase-continuous.
      const prevTail = new Float32Array(O);
      const currHead = new Float32Array(O);
      for (let i = 0; i < O; i++) {
        prevTail[i] = sineAt(1000 + i);
        currHead[i] = sineAt(1000 + O + i);
      }
      const result = wsolaCrossfade(prevTail, currHead, O, SAMPLE_RATE);
      expect(result.length).to.equal(O);
      // No NaN / Inf
      for (let i = 0; i < O; i++) {
        expect(Number.isFinite(result[i])).to.equal(true);
      }
      // Smoothness: max |second difference| over the crossfade should be small
      // (a phase discontinuity would create a spike ~2×amplitude). For a 440 Hz
      // sine at 24 kHz the natural max |second diff| is ~0.007, so 0.1 leaves
      // ample headroom while still rejecting any discontinuity.
      let maxSecondDiff = 0;
      for (let i = 1; i < O - 1; i++) {
        const d2 = Math.abs(result[i + 1] - 2 * result[i] + result[i - 1]);
        if (d2 > maxSecondDiff) maxSecondDiff = d2;
      }
      expect(maxSecondDiff).to.be.lessThan(0.1);
    });

    it('aperiodic signal with phase offset → WSOLA aligns (output ≈ ideal, naive is not)', () => {
      // Aperiodic signal (440 + 700 Hz) so the cross-correlation has a UNIQUE
      // peak (no periodicity ambiguity like a pure sine). currHead is shifted
      // by `phaseShift` samples relative to prevTail, simulating a vocoder
      // chunk-boundary phase mismatch. WSOLA should recover the offset and
      // produce an output close to prevTail (the aligned signal), while a naive
      // Hann OLA of the unaligned segments deviates significantly.
      const f1 = 440, f2 = 700;
      const O = 400;
      const phaseShift = 14; // ~1/4 period of the 440 Hz component
      const sig = (t) => Math.sin(2 * Math.PI * f1 * t / SAMPLE_RATE)
        + 0.5 * Math.sin(2 * Math.PI * f2 * t / SAMPLE_RATE);
      const prevTail = new Float32Array(O);
      const currHead = new Float32Array(O);
      for (let i = 0; i < O; i++) {
        prevTail[i] = sig(2000 + i);
        currHead[i] = sig(2000 + phaseShift + i);
      }

      const wsolaResult = wsolaCrossfade(prevTail, currHead, O, SAMPLE_RATE);

      // Naive Hann OLA (no alignment) for comparison.
      const naive = new Float32Array(O);
      for (let i = 0; i < O; i++) {
        const w = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (O + 1)));
        naive[i] = prevTail[i] * (1 - w) + currHead[i] * w;
      }

      // Deviation from the ideal aligned signal (prevTail). WSOLA recovers the
      // offset → alignedCurr ≈ prevTail → output ≈ prevTail (deviation ≈ 0,
      // only edge-clamp at the first `phaseShift` samples where w ≈ 0).
      // Naive crossfades unaligned segments → large deviation at the centre.
      let wsolaMaxDev = 0, naiveMaxDev = 0;
      for (let i = 0; i < O; i++) {
        const wd = Math.abs(wsolaResult[i] - prevTail[i]);
        const nd = Math.abs(naive[i] - prevTail[i]);
        if (wd > wsolaMaxDev) wsolaMaxDev = wd;
        if (nd > naiveMaxDev) naiveMaxDev = nd;
      }
      // WSOLA deviation should be far smaller than naive.
      expect(wsolaMaxDev).to.be.lessThan(naiveMaxDev * 0.1);
    });
  });

  describe('wsolaCrossfadeMel (mel domain)', () => {
    const MEL_DIM = 8;

    // Build a unit basis vector e_k of length MEL_DIM.
    function basis(k) {
      const v = new Float32Array(MEL_DIM);
      v[k % MEL_DIM] = 1.0;
      return v;
    }

    it('identical prevTail/currHead → cosine similarity picks offset 0, output ≈ prevTail', () => {
      const O = 6;
      const prevTail = new Float32Array(O * MEL_DIM);
      for (let f = 0; f < O; f++) prevTail.set(basis(f), f * MEL_DIM);
      // currHead identical to prevTail.
      const currHead = new Float32Array(prevTail);

      const result = wsolaCrossfadeMel(prevTail, currHead, O, MEL_DIM);
      expect(result.length).to.equal(O * MEL_DIM);
      // With offset 0 picked everywhere, alignedCurr = currHead = prevTail, and
      // the Hann crossfade of two identical signals equals the signal itself.
      for (let f = 0; f < O; f++) {
        for (let d = 0; d < MEL_DIM; d++) {
          expect(result[f * MEL_DIM + d]).to.be.closeTo(prevTail[f * MEL_DIM + d], 1e-5);
        }
      }
    });

    it('shifted currHead → cosine similarity picks offset -1, output close to prevTail', () => {
      const O = 6;
      const prevTail = new Float32Array(O * MEL_DIM);
      for (let f = 0; f < O; f++) prevTail.set(basis(f), f * MEL_DIM);
      // currHead shifted by +1: currHead[f] = basis(f+1) → best alignment for
      // prevTail frame f is currHead[f-1] = basis(f) (offset -1, cosine sim = 1).
      const currHead = new Float32Array(O * MEL_DIM);
      for (let f = 0; f < O; f++) currHead.set(basis(f + 1), f * MEL_DIM);

      const result = wsolaCrossfadeMel(prevTail, currHead, O, MEL_DIM);
      expect(result.length).to.equal(O * MEL_DIM);
      // For frames f >= 1, offset -1 is within the search window (±floor(O/4)=±1)
      // and gives cosine similarity 1 → alignedCurr[f] = basis(f) = prevTail[f],
      // so the crossfade equals prevTail. Frame 0 cannot use offset -1 (out of
      // range) so it may differ; only assert frames 1..O-1.
      for (let f = 1; f < O; f++) {
        for (let d = 0; d < MEL_DIM; d++) {
          expect(result[f * MEL_DIM + d]).to.be.closeTo(prevTail[f * MEL_DIM + d], 1e-5);
        }
      }
    });
  });
});
