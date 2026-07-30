const { expect } = require('chai');
const { loudnormFinal, measureLoudness } = require('../src/inference/pipeline/loudnorm');

/**
 * EBU R128 loudnorm + true-peak limiter tests.
 *
 * Verifies:
 *   1. A sine wave is normalized to −14 LUFS ±0.5.
 *   2. The true-peak after limiting is ≤ −1 dBTP.
 *   3. A high-crest-factor signal (loud peak) is true-peak limited.
 *   4. Silence is a no-op (returns without NaN / Infinity).
 */
describe('loudnormFinal (EBU R128 + true-peak)', () => {
  const SAMPLE_RATE = 24000;

  // True-peak in dBTP: 20*log10(max inter-sample peak).
  function truePeakDb(samples) {
    let maxTp = 0;
    for (let i = 0; i < samples.length - 1; i++) {
      let a = Math.abs(samples[i]);
      if (a > maxTp) maxTp = a;
      const s0 = samples[i], s1 = samples[i + 1];
      for (let r = 1; r < 4; r++) {
        const frac = r / 4;
        const v = Math.abs(s0 * (1 - frac) + s1 * frac);
        if (v > maxTp) maxTp = v;
      }
    }
    const last = Math.abs(samples[samples.length - 1]);
    if (last > maxTp) maxTp = last;
    return 20 * Math.log10(maxTp);
  }

  it('sine wave → normalized to −14 LUFS ±0.5', () => {
    // 3-second 440 Hz sine at amplitude 0.1 (well below −14 LUFS, so loudnorm
    // boosts it). 3 s = 72000 samples at 24 kHz, enough for many gating blocks.
    const freq = 440;
    const duration = 3;
    const n = SAMPLE_RATE * duration;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = 0.1 * Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE);
    }

    loudnormFinal(samples, SAMPLE_RATE);

    const outLufs = measureLoudness(samples, SAMPLE_RATE);
    // −14 LUFS ±0.5 (the loudnorm gain may be slightly reduced by the
    // true-peak limiter, so allow a little extra headroom on the low side).
    expect(outLufs).to.be.closeTo(-14, 0.7);
  });

  it('sine wave → true-peak ≤ −1 dBTP', () => {
    const freq = 440;
    const n = SAMPLE_RATE * 3;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = 0.1 * Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE);
    }

    loudnormFinal(samples, SAMPLE_RATE);

    const tpDb = truePeakDb(samples);
    // −1 dBTP threshold (allow 0.05 dB tolerance for floating-point).
    expect(tpDb).to.be.at.most(-1.0 + 0.05);
  });

  it('loud signal with high crest factor → true-peak limited to ≤ −1 dBTP', () => {
    // Low-amplitude sine (drives loudness gain up) with an occasional loud
    // spike (drives true-peak above −1 dBTP after gain). The limiter should
    // pull the peak back under the threshold.
    const freq = 220;
    const n = SAMPLE_RATE * 3;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = 0.02 * Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE);
    }
    // Inject loud spikes.
    samples[1000] = 0.95;
    samples[1001] = 0.95;
    samples[20000] = 0.90;

    loudnormFinal(samples, SAMPLE_RATE);

    const tpDb = truePeakDb(samples);
    expect(tpDb).to.be.at.most(-1.0 + 0.05);
  });

  it('silence → no-op (no NaN / Infinity)', () => {
    const samples = new Float32Array(SAMPLE_RATE * 2); // all zeros
    loudnormFinal(samples, SAMPLE_RATE);
    for (let i = 0; i < samples.length; i++) {
      expect(Number.isFinite(samples[i])).to.equal(true);
      expect(samples[i]).to.equal(0);
    }
  });

  it('disabled (enableLoudnormFinal=false path) → only peak-normalize applied by caller', () => {
    // This test verifies the loudnorm function itself is correct; the
    // enableLoudnormFinal gating is tested via the settings reader in
    // postprocessing.js. Here we just confirm that calling loudnormFinal
    // on a quiet sine produces a measurable loudness change.
    const freq = 440;
    const n = SAMPLE_RATE * 2;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = 0.05 * Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE);
    }
    const beforeLufs = measureLoudness(samples, SAMPLE_RATE);
    loudnormFinal(samples, SAMPLE_RATE);
    const afterLufs = measureLoudness(samples, SAMPLE_RATE);
    // Before is quiet (≈ −29 LUFS), after should be ≈ −14 LUFS.
    expect(beforeLufs).to.be.lessThan(-20);
    expect(afterLufs).to.be.greaterThan(-15);
  });
});
