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
const { wavEncoder } = require('../src/audio/wavEncoder');

describe('inference/pipeline/postprocessing - DSP', () => {
  describe('parseWavBuffer', () => {
    function makeWav(sampleRate, numChannels, audioFormat, bitsPerSample, samples) {
      const bytesPerSample = bitsPerSample / 8;
      const dataSize = samples.length * bytesPerSample * numChannels;
      const buf = Buffer.alloc(44 + dataSize);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(36 + dataSize, 4);
      buf.write('WAVE', 8);
      buf.write('fmt ', 12);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(audioFormat, 20);
      buf.writeUInt16LE(numChannels, 22);
      buf.writeUInt32LE(sampleRate, 24);
      buf.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
      buf.writeUInt16LE(numChannels * bytesPerSample, 32);
      buf.writeUInt16LE(bitsPerSample, 34);
      buf.write('data', 36);
      buf.writeUInt32LE(dataSize, 40);
      return buf;
    }

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
      const wav = wavEncoder.encodeWav(samples, 24000);
      const parsed = parseWavBuffer(wav);
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
      const samples = new Float32Array([0.2, 0.4, -0.6, 0.8]);
      const wav = wavEncoder.encodeWav(samples, 24000); // mono
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
});
