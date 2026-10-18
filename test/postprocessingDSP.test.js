const { expect } = require('chai');
const {
  parseWavBuffer,
  resampleLinear,
  bessel0,
  bitReversePermute,
  fftRadix2,
  ifftRadix2,
  hzToMel,
  melToHz,
  createMelFilterbank,
} = require('../src/inference/pipeline/postprocessing');

describe('inference/pipeline/postprocessing - DSP', () => {
  describe('parseWavBuffer', () => {
    it('should throw on missing RIFF header', () => {
      const bad = Buffer.alloc(12, 0);
      bad.write('XXXX', 0);
      bad.write('WAVE', 8);
      expect(() => parseWavBuffer(bad)).to.throw(/RIFF/);
    });

    it('should throw on missing WAVE header', () => {
      const bad = Buffer.alloc(12, 0);
      bad.write('RIFF', 0);
      bad.write('XXXX', 8);
      expect(() => parseWavBuffer(bad)).to.throw(/WAVE/);
    });

    it('should parse 32-bit float mono WAV', () => {
      const samples = new Float32Array([0.0, 0.5, -0.5, 1.0]);
      const numChannels = 1;
      const bytesPerSample = 4;
      const dataSize = samples.length * bytesPerSample * numChannels;
      const buf = Buffer.alloc(44 + dataSize);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(36 + dataSize, 4);
      buf.write('WAVE', 8);
      buf.write('fmt ', 12);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(3, 20);  // IEEE float
      buf.writeUInt16LE(numChannels, 22);
      buf.writeUInt32LE(24000, 24);
      buf.writeUInt32LE(24000 * numChannels * bytesPerSample, 28);
      buf.writeUInt16LE(numChannels * bytesPerSample, 32);
      buf.writeUInt16LE(32, 34);
      buf.write('data', 36);
      buf.writeUInt32LE(dataSize, 40);
      for (let i = 0; i < samples.length; i++) {
        buf.writeFloatLE(samples[i], 44 + i * bytesPerSample);
      }
      const parsed = parseWavBuffer(buf);
      expect(parsed.sampleRate).to.equal(24000);
      expect(parsed.data.length).to.equal(samples.length);
      for (let i = 0; i < samples.length; i++) {
        expect(parsed.data[i]).to.be.closeTo(samples[i], 1e-5);
      }
    });

    it('should parse 16-bit PCM mono WAV', () => {
      const samples = new Float32Array([0.0, 0.5, -0.5]);
      const bytesPerSample = 2;
      const dataSize = samples.length * bytesPerSample;
      const buf = Buffer.alloc(44 + dataSize);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(36 + dataSize, 4);
      buf.write('WAVE', 8);
      buf.write('fmt ', 12);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(1, 20); // PCM
      buf.writeUInt16LE(1, 22); // mono
      buf.writeUInt32LE(16000, 24);
      buf.writeUInt32LE(16000 * 2, 28);
      buf.writeUInt16LE(2, 32);
      buf.writeUInt16LE(16, 34);
      buf.write('data', 36);
      buf.writeUInt32LE(dataSize, 40);
      for (let i = 0; i < samples.length; i++) {
        buf.writeInt16LE(Math.round(samples[i] * 32768), 44 + i * 2);
      }
      const parsed = parseWavBuffer(buf);
      expect(parsed.sampleRate).to.equal(16000);
      expect(parsed.data.length).to.equal(3);
      expect(parsed.data[1]).to.be.closeTo(0.5, 1e-3);
    });

    it('should downmix stereo to mono by averaging', () => {
      // build stereo manually
      const bytesPerSample = 4;
      const numFrames = 2;
      const dataSize = numFrames * 2 * bytesPerSample;
      const buf = Buffer.alloc(44 + dataSize);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(36 + dataSize, 4);
      buf.write('WAVE', 8);
      buf.write('fmt ', 12);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(3, 20); // float
      buf.writeUInt16LE(2, 22); // stereo
      buf.writeUInt32LE(24000, 24);
      buf.writeUInt32LE(24000 * 2 * 4, 28);
      buf.writeUInt16LE(2 * 4, 32);
      buf.writeUInt16LE(32, 34);
      buf.write('data', 36);
      buf.writeUInt32LE(dataSize, 40);
      // frame 0: L=0.2, R=0.4 → avg 0.3
      buf.writeFloatLE(0.2, 44);
      buf.writeFloatLE(0.4, 48);
      // frame 1: L=-0.6, R=0.8 → avg 0.1
      buf.writeFloatLE(-0.6, 52);
      buf.writeFloatLE(0.8, 56);
      const parsed = parseWavBuffer(buf);
      expect(parsed.data.length).to.equal(2);
      expect(parsed.data[0]).to.be.closeTo(0.3, 1e-5);
      expect(parsed.data[1]).to.be.closeTo(0.1, 1e-5);
    });
  });

  describe('bessel0', () => {
    it('should return 1 at x=0', () => {
      expect(bessel0(0)).to.be.closeTo(1.0, 1e-6);
    });
    it('should be even (symmetric around 0)', () => {
      for (const x of [1, 2, 3.75, 5, 10]) {
        expect(bessel0(x)).to.be.closeTo(bessel0(-x), 1e-6);
      }
    });
    it('should be monotonically increasing for x>0', () => {
      let prev = 0;
      for (let x = 0; x < 20; x += 0.5) {
        const v = bessel0(x);
        expect(v).to.be.at.least(prev - 1e-9);
        prev = v;
      }
    });
    it('should match known value at x=3.75 (boundary)', () => {
      // continuity across the two approximations
      expect(bessel0(3.749)).to.be.closeTo(bessel0(3.751), 0.05);
    });
  });

  describe('bitReversePermute', () => {
    it('should bit-reverse indices for power-of-2 length', () => {
      const n = 8;
      const real = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
      const imag = new Float32Array(n);
      bitReversePermute(real, imag);
      // bit-reversed order of [0..7]: 0,4,2,6,1,5,3,7
      expect(Array.from(real)).to.deep.equal([0, 4, 2, 6, 1, 5, 3, 7]);
    });
  });

  describe('fftRadix2 / ifftRadix2', () => {
    it('FFT of a pure cosine should have a peak at the corresponding bin', () => {
      const n = 64;
      const k = 8; // frequency bin
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        real[i] = Math.cos(2 * Math.PI * k * i / n);
      }
      fftRadix2(real, imag);
      // magnitude spectrum
      const mag = new Float32Array(n / 2);
      for (let i = 0; i < n / 2; i++) {
        mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
      }
      let maxBin = 0;
      let maxVal = 0;
      for (let i = 0; i < n / 2; i++) {
        if (mag[i] > maxVal) { maxVal = mag[i]; maxBin = i; }
      }
      expect(maxBin).to.equal(k);
    });

    it('FFT→IFFT round-trip should recover the original signal', () => {
      const n = 32;
      const orig = new Float32Array(n);
      for (let i = 0; i < n; i++) orig[i] = Math.sin(i / 3) + 0.3 * Math.cos(i / 7);
      const real = orig.slice();
      const imag = new Float32Array(n);
      fftRadix2(real, imag);
      ifftRadix2(real, imag);
      for (let i = 0; i < n; i++) {
        expect(real[i]).to.be.closeTo(orig[i], 1e-4);
        expect(imag[i]).to.be.closeTo(0, 1e-4);
      }
    });

    it('FFT of DC signal should have all energy in bin 0', () => {
      const n = 16;
      const real = new Float32Array(n).fill(1);
      const imag = new Float32Array(n);
      fftRadix2(real, imag);
      expect(real[0]).to.be.closeTo(n, 1e-4);
      for (let i = 1; i < n; i++) {
        expect(Math.abs(real[i])).to.be.lessThan(1e-4);
        expect(Math.abs(imag[i])).to.be.lessThan(1e-4);
      }
    });

    it('should only accept power-of-2 lengths (no throw for valid)', () => {
      for (const n of [2, 4, 8, 16]) {
        const real = new Float32Array(n);
        const imag = new Float32Array(n);
        expect(() => fftRadix2(real, imag)).to.not.throw();
      }
    });
  });

  describe('hzToMel / melToHz', () => {
    it('should convert 0 Hz to 0 mel', () => {
      expect(hzToMel(0)).to.equal(0);
    });
    it('should round-trip Hz → mel → Hz', () => {
      for (const hz of [100, 440, 1000, 8000]) {
        expect(melToHz(hzToMel(hz))).to.be.closeTo(hz, 0.5);
      }
    });
    it('should be monotonically increasing', () => {
      let prev = -Infinity;
      for (let hz = 0; hz <= 12000; hz += 100) {
        const m = hzToMel(hz);
        expect(m).to.be.greaterThan(prev);
        prev = m;
      }
    });
  });

  describe('createMelFilterbank', () => {
    it('should produce a filterbank of correct shape', () => {
      const numBands = 80;
      const fftSize = 1024;
      const sr = 24000;
      const fb = createMelFilterbank(numBands, fftSize, sr, 0, 12000);
      expect(fb.length).to.equal(numBands * (fftSize / 2 + 1));
    });

    it('should produce triangular filters (peak between left/right)', () => {
      const numBands = 20;
      const fftSize = 512;
      const sr = 24000;
      const fb = createMelFilterbank(numBands, fftSize, sr, 0, 12000);
      const numBins = fftSize / 2 + 1;
      // each band should have at least one non-zero entry
      for (let m = 0; m < numBands; m++) {
        let sum = 0;
        for (let k = 0; k < numBins; k++) sum += fb[m * numBins + k];
        expect(sum).to.be.greaterThan(0);
      }
    });
  });

  describe('resampleLinear', () => {
    it('should return input unchanged when rates match', () => {
      const data = new Float32Array([1, 2, 3]);
      expect(resampleLinear(data, 44100, 44100)).to.equal(data);
    });

    it('should produce finite output for downsampling', () => {
      const data = new Float32Array(500);
      for (let i = 0; i < 500; i++) data[i] = Math.sin(i * 0.1);
      const out = resampleLinear(data, 48000, 24000);
      out.forEach(v => expect(Number.isFinite(v)).to.be.true);
      expect(out.length).to.be.lessThan(500);
    });

    it('should produce finite output for upsampling', () => {
      const data = new Float32Array(100);
      for (let i = 0; i < 100; i++) data[i] = Math.cos(i * 0.2);
      const out = resampleLinear(data, 16000, 48000);
      out.forEach(v => expect(Number.isFinite(v)).to.be.true);
      expect(out.length).to.be.greaterThan(100);
    });

    it('should return empty array for empty input', () => {
      const out = resampleLinear(new Float32Array(0), 48000, 24000);
      expect(out.length).to.equal(0);
    });
  });

  describe('_oversample2xAntiAlias (2× oversampling anti-aliasing)', () => {
    const { oversample2xAntiAlias } = require('../src/inference/pipeline/postprocessing').__test;

    function tone(freq, sr, seconds = 1) {
      const n = Math.round(sr * seconds);
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = Math.sin(2 * Math.PI * freq * i / sr);
      return a;
    }

    function rms(a, skip = 2000) {
      let s = 0, c = 0;
      for (let i = skip; i < a.length; i++) { s += a[i] * a[i]; c++; }
      return Math.sqrt(s / c);
    }

    // 回归：零填充后必须补 L=2 增益，否则整条管线 −6.02 dB（曾导致参考音频
    // mel 整体下移、extractRefF0FromWav 的 minRms 门限把安静段误判为静音）。
    it('should preserve passband level (no −6 dB zero-stuff loss)', () => {
      const x = tone(1000, 48000);
      const y = oversample2xAntiAlias(x, 48000, 24000);
      const gainDb = 20 * Math.log10(rms(y) / rms(x));
      expect(gainDb).to.be.closeTo(0, 0.5);
    });

    it('should keep DC gain at unity', () => {
      const x = new Float32Array(4800).fill(0.5);
      const y = oversample2xAntiAlias(x, 48000, 24000);
      expect(y[y.length - 1]).to.be.closeTo(0.5, 0.01);
    });

    it('should attenuate content above the destination Nyquist', () => {
      const x = tone(20000, 48000);
      const y = oversample2xAntiAlias(x, 48000, 24000);
      const gainDb = 20 * Math.log10(rms(y) / rms(x));
      expect(gainDb).to.be.lessThan(-10);
    });
  });

  describe('_applyStreamGain (streaming preview shared gain)', () => {
    const { applyStreamGain } = require('../src/inference/pipeline/postprocessing').__test;

    function peakOf(arr) {
      let p = 0;
      for (let i = 0; i < arr.length; i++) p = Math.max(p, Math.abs(arr[i]));
      return p;
    }

    it('should leave quiet chunks untouched when nothing exceeds the ceiling', () => {
      const state = { gain: 1 };
      const seg = new Float32Array([0.4, -0.4, 0.2]);
      applyStreamGain(seg, state);
      expect(seg[0]).to.be.closeTo(0.4, 1e-6);
      expect(seg[1]).to.be.closeTo(-0.4, 1e-6);
      expect(seg[2]).to.be.closeTo(0.2, 1e-6);
      expect(state.gain).to.equal(1);
    });

    it('should keep relative dynamics across chunks (no per-chunk flattening)', () => {
      const state = { gain: 1 };
      // 弱唱 → 高潮 → 中段 → 弱尾，对应报告里被压缩 8.4 dB 的序列
      const peaks = [0.40, 2.50, 1.20, 0.50];
      const outPeaks = peaks.map((p) => {
        const seg = new Float32Array(1024).fill(p); // 常值段峰值 = p
        applyStreamGain(seg, state);
        return peakOf(seg);
      });
      // 第一段不被压；后续段统一用同一增益（0.95/2.50 = 0.38）
      expect(outPeaks[0]).to.be.closeTo(0.40, 1e-5);
      expect(outPeaks[1]).to.be.closeTo(0.95, 1e-5);
      expect(outPeaks[2]).to.be.closeTo(1.20 * 0.38, 1e-3);
      expect(outPeaks[3]).to.be.closeTo(0.50 * 0.38, 1e-3);
      // 原始动态 0.40..2.50 = 15.9 dB。逐块独立归一化会把 2.50/1.20 都压到 0.95
      // （15.9 dB → 7.5 dB）；共享增益只让"更响的段"触发一次下调，之后所有段
      // 按同一系数缩放，段间比例保持不变。
      const ratioBefore = peaks[3] / peaks[2];
      const ratioAfter = outPeaks[3] / outPeaks[2];
      expect(ratioAfter).to.be.closeTo(ratioBefore, 1e-3);
    });

    it('should fade in over ~5 ms when the shared gain drops (no boundary step)', () => {
      const state = { gain: 1 };
      const loud = new Float32Array(1024).fill(2.0);
      applyStreamGain(loud, state);
      // 段首从 0 淡入（抹掉阶跃），120 样本后到达新增益 0.95/2.0 → 幅度 0.95
      expect(loud[0]).to.be.closeTo(0, 1e-6);
      expect(loud[120]).to.be.closeTo(0.95, 1e-5);
      expect(state.gain).to.be.closeTo(0.475, 1e-6);
      // 整段不超过 ceiling（不会在设备端硬削波）
      expect(peakOf(loud)).to.be.at.most(0.95 + 1e-5);
      // 下一段用同一增益，边界处没有阶跃
      const nextSeg = new Float32Array(1024).fill(2.0);
      applyStreamGain(nextSeg, state);
      expect(nextSeg[0]).to.be.closeTo(loud[loud.length - 1], 1e-5);
    });

    it('should never raise the gain back (pushed audio cannot be retro-scaled)', () => {
      const state = { gain: 1 };
      const loud = new Float32Array(64).fill(2.0);
      applyStreamGain(loud, state);
      const gainAfterLoud = state.gain;
      const quiet = new Float32Array(64).fill(0.01);
      applyStreamGain(quiet, state);
      expect(state.gain).to.equal(gainAfterLoud);
      expect(peakOf(quiet)).to.be.closeTo(0.01 * gainAfterLoud, 1e-6);
    });
  });
});
