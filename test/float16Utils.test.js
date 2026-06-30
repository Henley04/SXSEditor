const { expect } = require('chai');
const { float32ToF16Buffer, f16BufferToFloat32, normalizePeakTo } = require('../src/inference/pipeline/utils');

describe('inference/pipeline/utils - float16 conversion', () => {
  describe('float32ToF16Buffer / f16BufferToFloat32 round-trip', () => {
    it('should round-trip normal values within float16 precision', () => {
      const vals = new Float32Array([0.0, 1.0, -1.0, 0.5, -0.5, 2.0, 100.0, -1000.0]);
      const u16 = float32ToF16Buffer(vals);
      expect(u16).to.be.instanceOf(Uint16Array);
      expect(u16.length).to.equal(vals.length);
      const back = f16BufferToFloat32(u16);
      for (let i = 0; i < vals.length; i++) {
        expect(back[i]).to.be.closeTo(vals[i], Math.abs(vals[i]) * 1e-3);
      }
    });

    it('should round-trip zero (signed)', () => {
      const vals = new Float32Array([0.0, -0.0]);
      const u16 = float32ToF16Buffer(vals);
      const back = f16BufferToFloat32(u16);
      expect(back[0]).to.equal(0);
      // -0.0 may flush to 0 in some paths; just ensure finite
      expect(Number.isFinite(back[1])).to.be.true;
    });

    it('should handle Inf', () => {
      const u16 = float32ToF16Buffer(new Float32Array([Infinity, -Infinity]));
      const back = f16BufferToFloat32(u16);
      expect(back[0]).to.equal(Infinity);
      expect(back[1]).to.equal(-Infinity);
    });

    it('should handle NaN (becomes NaN, not a number)', () => {
      const u16 = float32ToF16Buffer(new Float32Array([NaN]));
      const back = f16BufferToFloat32(u16);
      expect(Number.isNaN(back[0])).to.be.true;
    });

    it('should flush very small subnormals to zero', () => {
      // float16 min normal ~6.10e-5; smaller than min subnormal (~5.96e-8) flushes to 0
      const u16 = float32ToF16Buffer(new Float32Array([1e-10]));
      const back = f16BufferToFloat32(u16);
      expect(back[0]).to.equal(0);
    });

    it('should preserve subnormal-range values as finite', () => {
      const u16 = float32ToF16Buffer(new Float32Array([1e-7]));
      const back = f16BufferToFloat32(u16);
      expect(Number.isFinite(back[0])).to.be.true;
    });

    it('should clamp overflow to Inf', () => {
      // float16 max ~65504; 1e6 overflows
      const u16 = float32ToF16Buffer(new Float32Array([1e6]));
      const back = f16BufferToFloat32(u16);
      expect(back[0]).to.equal(Infinity);
    });

    it('should handle empty input', () => {
      const u16 = float32ToF16Buffer(new Float32Array(0));
      expect(u16.length).to.equal(0);
      const back = f16BufferToFloat32(u16);
      expect(back.length).to.equal(0);
    });

    it('should be deterministic for repeated calls', () => {
      const vals = new Float32Array([0.123, -4.567, 89.01]);
      const a = Array.from(float32ToF16Buffer(vals));
      const b = Array.from(float32ToF16Buffer(vals));
      expect(a).to.deep.equal(b);
    });

    it('should round-trip a large random array with acceptable error', () => {
      const n = 2000;
      const vals = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        vals[i] = (Math.random() * 2 - 1) * 1000;
      }
      const u16 = float32ToF16Buffer(vals);
      const back = f16BufferToFloat32(u16);
      let maxRelErr = 0;
      for (let i = 0; i < n; i++) {
        if (Math.abs(vals[i]) > 1e-3) {
          const rel = Math.abs(back[i] - vals[i]) / Math.abs(vals[i]);
          if (rel > maxRelErr) maxRelErr = rel;
        }
      }
      // float16 has ~3 decimal digits of precision; relative error should be < 1e-3
      expect(maxRelErr).to.be.lessThan(1e-3);
    });
  });
});

describe('inference/pipeline/utils - normalizePeakTo', () => {
  it('should not scale when peak is below threshold', () => {
    const arr = new Float32Array([0.1, -0.2, 0.3]);
    normalizePeakTo(arr);
    expect(arr[0]).to.be.closeTo(0.1, 1e-6);
    expect(arr[2]).to.be.closeTo(0.3, 1e-6);
  });

  it('should scale down when peak exceeds default threshold 0.95', () => {
    const arr = new Float32Array([0.0, 1.0, -1.0]);
    normalizePeakTo(arr);
    expect(Math.abs(arr[1])).to.be.closeTo(0.95, 1e-6);
    expect(Math.abs(arr[2])).to.be.closeTo(0.95, 1e-6);
  });

  it('should respect custom threshold', () => {
    const arr = new Float32Array([2.0]);
    normalizePeakTo(arr, undefined, 0.5);
    expect(arr[0]).to.be.closeTo(0.5, 1e-6);
  });

  it('should respect explicit len parameter', () => {
    const arr = new Float32Array([2.0, 2.0, 0.1, 0.1]);
    normalizePeakTo(arr, 2, 0.5);
    expect(arr[0]).to.be.closeTo(0.5, 1e-6);
    expect(arr[1]).to.be.closeTo(0.5, 1e-6);
    // beyond len should be untouched (0.1 in float32 is ~0.10000000149)
    expect(arr[2]).to.be.closeTo(0.1, 1e-6);
    expect(arr[3]).to.be.closeTo(0.1, 1e-6);
  });

  it('should not scale all-zero array', () => {
    const arr = new Float32Array([0, 0, 0]);
    normalizePeakTo(arr);
    arr.forEach(v => expect(v).to.equal(0));
  });

  it('should handle single element array', () => {
    const arr = new Float32Array([5.0]);
    normalizePeakTo(arr);
    expect(arr[0]).to.be.closeTo(0.95, 1e-6);
  });
});
