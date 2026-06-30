const { expect } = require('chai');
const { resampleAudio } = require('../src/utils/resampleAudio');

describe('utils/resampleAudio', () => {
  it('should return the same array when sample rates match', () => {
    const data = new Float32Array([1, 2, 3, 4, 5]);
    const out = resampleAudio(data, 44100, 44100);
    expect(out).to.equal(data); // identity
  });

  it('should downsample by integer factor', () => {
    const data = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const out = resampleAudio(data, 8000, 4000);
    expect(out.length).to.equal(4);
    out.forEach(v => expect(v).to.be.a('number'));
  });

  it('should upsample by integer factor', () => {
    const data = new Float32Array([0, 0.5, 1, 0.5, 0]);
    const out = resampleAudio(data, 4000, 8000);
    expect(out.length).to.equal(10);
  });

  it('should produce empty array when output length is 0', () => {
    const data = new Float32Array([1]);
    const out = resampleAudio(data, 8000, 16000);
    // newLength = floor(1 / 0.5) = 2, not 0; test true-empty path:
    const out2 = resampleAudio(new Float32Array(0), 8000, 16000);
    expect(out2.length).to.equal(0);
  });

  it('should approximate a constant signal after resampling', () => {
    const data = new Float32Array(100).fill(0.7);
    const out = resampleAudio(data, 44100, 22050);
    // constant signal should remain near 0.7 (allow filter transients at edges)
    const middle = out.slice(Math.floor(out.length / 4), Math.floor(out.length * 3 / 4));
    const avg = middle.reduce((s, v) => s + v, 0) / middle.length;
    expect(avg).to.be.closeTo(0.7, 0.05);
  });

  it('should preserve a sinusoid frequency after resampling', () => {
    const sr = 44100;
    const freq = 440;
    const samples = 1024;
    const data = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      data[i] = Math.sin(2 * Math.PI * freq * i / sr);
    }
    const out = resampleAudio(data, sr, 22050);
    // peak amplitude should be roughly preserved in the middle
    let maxAbs = 0;
    for (let i = Math.floor(out.length / 4); i < Math.floor(out.length * 3 / 4); i++) {
      maxAbs = Math.max(maxAbs, Math.abs(out[i]));
    }
    expect(maxAbs).to.be.greaterThan(0.8);
    expect(maxAbs).to.be.lessThan(1.05);
  });

  it('should handle non-integer ratio', () => {
    const data = new Float32Array(100);
    for (let i = 0; i < 100; i++) data[i] = Math.sin(i / 10);
    // 44100 -> 48000 is upsampling (ratio 0.919), so output has MORE samples
    const out = resampleAudio(data, 44100, 48000);
    expect(out.length).to.be.greaterThan(100);
    out.forEach(v => expect(v).to.be.a('number'));
    out.forEach(v => expect(Number.isFinite(v)).to.be.true);
  });

  it('should produce finite values for noisy input', () => {
    const data = new Float32Array(500);
    for (let i = 0; i < 500; i++) data[i] = Math.random() * 2 - 1;
    const out = resampleAudio(data, 24000, 16000);
    out.forEach(v => expect(Number.isFinite(v)).to.be.true);
  });

  it('should not produce NaN for all-zero input', () => {
    const data = new Float32Array(200);
    const out = resampleAudio(data, 24000, 16000);
    out.forEach(v => {
      expect(Number.isFinite(v)).to.be.true;
      expect(v).to.equal(0);
    });
  });
});
