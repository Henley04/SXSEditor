const { encodeWav, applyEnvelopesToAudio } = require('../src/audio/wavEncoder');
const { expect } = require('chai');

describe('wavEncoder', () => {
  describe('encodeWav', () => {
    it('should produce valid WAV header with correct magic bytes', () => {
      const audio = new Float32Array(100);
      const result = encodeWav(audio, 24000);
      const view = new DataView(result.buffer);

      expect(String.fromCharCode(...result.slice(0, 4))).to.equal('RIFF');
      expect(String.fromCharCode(...result.slice(8, 12))).to.equal('WAVE');
      expect(String.fromCharCode(...result.slice(12, 16))).to.equal('fmt ');
      expect(String.fromCharCode(...result.slice(36, 40))).to.equal('data');
    });

    it('should set correct audio format (3 = IEEE float)', () => {
      const audio = new Float32Array(100);
      const result = encodeWav(audio, 24000);
      const view = new DataView(result.buffer);

      expect(view.getUint16(20, true)).to.equal(3);
    });

    it('should set correct number of channels (1 = mono)', () => {
      const audio = new Float32Array(100);
      const result = encodeWav(audio, 24000);
      const view = new DataView(result.buffer);

      expect(view.getUint16(22, true)).to.equal(1);
    });

    it('should set correct sample rate', () => {
      const audio = new Float32Array(100);
      const result = encodeWav(audio, 44100);
      const view = new DataView(result.buffer);

      expect(view.getUint32(24, true)).to.equal(44100);
    });

    it('should set correct bits per sample (32)', () => {
      const audio = new Float32Array(100);
      const result = encodeWav(audio, 24000);
      const view = new DataView(result.buffer);

      expect(view.getUint16(34, true)).to.equal(32);
    });

    it('should calculate correct byte rate', () => {
      const audio = new Float32Array(100);
      const sampleRate = 24000;
      const result = encodeWav(audio, sampleRate);
      const view = new DataView(result.buffer);

      const expectedByteRate = (sampleRate * 1 * 32) / 8;
      expect(view.getUint32(28, true)).to.equal(expectedByteRate);
    });

    it('should calculate correct block align', () => {
      const audio = new Float32Array(100);
      const result = encodeWav(audio, 24000);
      const view = new DataView(result.buffer);

      expect(view.getUint16(32, true)).to.equal(4);
    });

    it('should set correct data chunk size', () => {
      const audio = new Float32Array(100);
      const result = encodeWav(audio, 24000);
      const view = new DataView(result.buffer);

      expect(view.getUint32(40, true)).to.equal(400);
    });

    it('should set correct RIFF chunk size', () => {
      const audio = new Float32Array(100);
      const result = encodeWav(audio, 24000);
      const view = new DataView(result.buffer);

      const dataSize = 100 * 4;
      expect(view.getUint32(4, true)).to.equal(36 + dataSize);
    });

    it('should produce correct total file size', () => {
      const audio = new Float32Array(256);
      const result = encodeWav(audio, 24000);

      expect(result.length).to.equal(44 + 256 * 4);
    });

    it('should write audio data correctly', () => {
      const audio = new Float32Array([0.5, -0.5, 1.0, -1.0, 0.0]);
      const result = encodeWav(audio, 24000);
      const view = new DataView(result.buffer);

      for (let i = 0; i < audio.length; i++) {
        const sample = view.getFloat32(44 + i * 4, true);
        expect(sample).to.be.closeTo(audio[i], 0.0001);
      }
    });

    it('should handle empty audio input', () => {
      const audio = new Float32Array(0);
      const result = encodeWav(audio, 24000);

      expect(result.length).to.equal(44);
      const view = new DataView(result.buffer);
      expect(view.getUint32(40, true)).to.equal(0);
    });

    it('should handle large audio input', () => {
      const size = 24000 * 30;
      const audio = new Float32Array(size);
      for (let i = 0; i < size; i++) {
        audio[i] = Math.sin(i * 0.01) * 0.5;
      }
      const result = encodeWav(audio, 24000);

      expect(result.length).to.equal(44 + size * 4);
    });

    it('should encode silence (all zeros) correctly', () => {
      const audio = new Float32Array(1000);
      audio.fill(0);
      const result = encodeWav(audio, 24000);
      const view = new DataView(result.buffer);

      for (let i = 0; i < audio.length; i++) {
        expect(view.getFloat32(44 + i * 4, true)).to.equal(0);
      }
    });

    it('should use little-endian byte order', () => {
      const audio = new Float32Array([1.0]);
      const result = encodeWav(audio, 24000);

      const expected = new ArrayBuffer(4);
      new DataView(expected).setFloat32(0, 1.0, true);
      expect(new Uint8Array(result.slice(44, 48))).to.deep.equal(new Uint8Array(expected));
    });
  });

  describe('encodeWav stereo', () => {
    it('should produce stereo WAV with 2 channels', () => {
      const stereoData = new Float32Array(200);
      const result = encodeWav(stereoData, 24000, 2);
      const view = new DataView(result.buffer);

      expect(String.fromCharCode(...result.slice(0, 4))).to.equal('RIFF');
      expect(view.getUint16(22, true)).to.equal(2);
      expect(view.getUint32(24, true)).to.equal(24000);
    });

    it('should calculate correct byte rate for stereo', () => {
      const stereoData = new Float32Array(200);
      const sampleRate = 24000;
      const result = encodeWav(stereoData, sampleRate, 2);
      const view = new DataView(result.buffer);

      const expectedByteRate = (sampleRate * 2 * 32) / 8;
      expect(view.getUint32(28, true)).to.equal(expectedByteRate);
    });

    it('should calculate correct block align for stereo', () => {
      const stereoData = new Float32Array(200);
      const result = encodeWav(stereoData, 24000, 2);
      const view = new DataView(result.buffer);

      expect(view.getUint16(32, true)).to.equal(8);
    });

    it('should pad odd-length stereo input with a zero sample (B4)', () => {
      // B4: stereo with odd length would otherwise produce a corrupt WAV
      // (header numChannels=2 but data not a multiple of blockAlign=8).
      const oddStereo = new Float32Array([0.1, 0.2, 0.3]); // length 3, odd
      const result = encodeWav(oddStereo, 24000, 2);
      const view = new DataView(result.buffer);

      // Header still says 2 channels.
      expect(view.getUint16(22, true)).to.equal(2);
      // Data size must be a multiple of blockAlign (8) for stereo 32-bit.
      const dataSize = view.getUint32(40, true);
      expect(dataSize % 8).to.equal(0);
      // Total length = 44 header + 4 padded samples * 4 bytes.
      expect(result.length).to.equal(44 + 4 * 4);
      // Original samples are preserved.
      expect(view.getFloat32(44 + 0 * 4, true)).to.be.closeTo(0.1, 0.0001);
      expect(view.getFloat32(44 + 1 * 4, true)).to.be.closeTo(0.2, 0.0001);
      expect(view.getFloat32(44 + 2 * 4, true)).to.be.closeTo(0.3, 0.0001);
      // Padded trailing sample is zero.
      expect(view.getFloat32(44 + 3 * 4, true)).to.equal(0);
    });
  });

  describe('applyEnvelopesToAudio', () => {
    it('should produce stereo output with double the sample count', () => {
      const mono = new Float32Array(100);
      mono.fill(0.5);
      const volumeEnv = { keyframes: [{ time: 0, value: 1 }] };
      const panEnv = { keyframes: [{ time: 0, value: 0 }] };
      const result = applyEnvelopesToAudio(mono, 24000, 120, volumeEnv, panEnv);

      expect(result.length).to.equal(200);
    });

    it('should apply volume envelope correctly', () => {
      const mono = new Float32Array(100);
      mono.fill(1.0);
      const volumeEnv = { keyframes: [{ time: 0, value: 0.5 }] };
      const panEnv = { keyframes: [{ time: 0, value: 0 }] };
      const result = applyEnvelopesToAudio(mono, 24000, 120, volumeEnv, panEnv);

      const leftSample = result[0];
      const rightSample = result[1];
      expect(leftSample).to.be.closeTo(0.5 * Math.cos(Math.PI / 4), 0.001);
      expect(rightSample).to.be.closeTo(0.5 * Math.sin(Math.PI / 4), 0.001);
    });

    it('should pan full left when pan = -1', () => {
      const mono = new Float32Array(100);
      mono.fill(1.0);
      const volumeEnv = { keyframes: [{ time: 0, value: 1 }] };
      const panEnv = { keyframes: [{ time: 0, value: -1 }] };
      const result = applyEnvelopesToAudio(mono, 24000, 120, volumeEnv, panEnv);

      const leftSample = result[0];
      const rightSample = result[1];
      expect(leftSample).to.be.closeTo(1.0, 0.001);
      expect(rightSample).to.be.closeTo(0.0, 0.001);
    });

    it('should pan full right when pan = 1', () => {
      const mono = new Float32Array(100);
      mono.fill(1.0);
      const volumeEnv = { keyframes: [{ time: 0, value: 1 }] };
      const panEnv = { keyframes: [{ time: 0, value: 1 }] };
      const result = applyEnvelopesToAudio(mono, 24000, 120, volumeEnv, panEnv);

      const leftSample = result[0];
      const rightSample = result[1];
      expect(leftSample).to.be.closeTo(0.0, 0.001);
      expect(rightSample).to.be.closeTo(1.0, 0.001);
    });

    it('should center when pan = 0', () => {
      const mono = new Float32Array(100);
      mono.fill(1.0);
      const volumeEnv = { keyframes: [{ time: 0, value: 1 }] };
      const panEnv = { keyframes: [{ time: 0, value: 0 }] };
      const result = applyEnvelopesToAudio(mono, 24000, 120, volumeEnv, panEnv);

      const leftSample = result[0];
      const rightSample = result[1];
      expect(leftSample).to.be.closeTo(rightSample, 0.001);
    });

    it('should mute when volume = 0', () => {
      const mono = new Float32Array(100);
      mono.fill(1.0);
      const volumeEnv = { keyframes: [{ time: 0, value: 0 }] };
      const panEnv = { keyframes: [{ time: 0, value: 0 }] };
      const result = applyEnvelopesToAudio(mono, 24000, 120, volumeEnv, panEnv);

      expect(result[0]).to.equal(0);
      expect(result[1]).to.equal(0);
    });

    it('should default to volume=1 and pan=0 when envelopes are null', () => {
      const mono = new Float32Array(100);
      mono.fill(1.0);
      const result = applyEnvelopesToAudio(mono, 24000, 120, null, null);

      const leftSample = result[0];
      const rightSample = result[1];
      expect(leftSample).to.be.closeTo(rightSample, 0.001);
      expect(leftSample).to.be.closeTo(Math.cos(Math.PI / 4), 0.001);
    });
  });
});
