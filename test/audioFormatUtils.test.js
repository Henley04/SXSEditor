const { expect } = require('chai');
const {
  platformHostAPI,
  resolveDtype,
  isSupportedBitDepth,
  buildPcmBuffer,
  mapDevicesToLegacy,
  resolveDeviceOption,
  buildSpeakerOptions,
} = require('../src/audio/audioFormatUtils');

describe('audioFormatUtils', () => {
  describe('platformHostAPI', () => {
    it('returns WASAPI for win32', () => {
      expect(platformHostAPI('win32')).to.equal('WASAPI');
    });
    it('returns CoreAudio for darwin', () => {
      expect(platformHostAPI('darwin')).to.equal('CoreAudio');
    });
    it('returns ALSA for linux', () => {
      expect(platformHostAPI('linux')).to.equal('ALSA');
    });
    it('returns Unknown for other platforms', () => {
      expect(platformHostAPI('solaris')).to.equal('Unknown');
    });
    it('defaults to current process.platform', () => {
      expect(platformHostAPI()).to.be.a('string');
    });
  });

  describe('resolveDtype', () => {
    it('keeps int16', () => {
      expect(resolveDtype('int16')).to.equal('int16');
    });
    it('keeps float32', () => {
      expect(resolveDtype('float32')).to.equal('float32');
    });
    it('downgrades int24 to float32', () => {
      expect(resolveDtype('int24')).to.equal('float32');
    });
    it('downgrades int32 to float32', () => {
      expect(resolveDtype('int32')).to.equal('float32');
    });
    it('defaults to float32 for unknown / missing values', () => {
      expect(resolveDtype('whatever')).to.equal('float32');
      expect(resolveDtype(undefined)).to.equal('float32');
      expect(resolveDtype(null)).to.equal('float32');
    });
  });

  describe('isSupportedBitDepth', () => {
    it('returns true for int16 and float32', () => {
      expect(isSupportedBitDepth('int16')).to.be.true;
      expect(isSupportedBitDepth('float32')).to.be.true;
    });
    it('returns false for int24/int32 and others', () => {
      expect(isSupportedBitDepth('int24')).to.be.false;
      expect(isSupportedBitDepth('int32')).to.be.false;
      expect(isSupportedBitDepth('foo')).to.be.false;
    });
  });

  describe('buildPcmBuffer', () => {
    const samples = new Float32Array([0.5, -0.5, 1.0, -1.0, 0.25]);

    it('returns a Buffer for float32 with volume 1.0', () => {
      const buf = buildPcmBuffer(samples, 'float32', 1.0, 0);
      expect(buf).to.be.an.instanceOf(Buffer);
      expect(buf.length).to.equal(samples.length * 4);
      const view = new Float32Array(buf.buffer, buf.byteOffset, samples.length);
      expect(Array.from(view)).to.deep.equal(Array.from(samples));
    });

    it('applies volume to float32', () => {
      const buf = buildPcmBuffer(samples, 'float32', 0.5, 0);
      const view = new Float32Array(buf.buffer, buf.byteOffset, samples.length);
      expect(view[0]).to.be.closeTo(0.25, 1e-6);
      expect(view[1]).to.be.closeTo(-0.25, 1e-6);
    });

    it('converts to int16 correctly', () => {
      const buf = buildPcmBuffer(samples, 'int16', 1.0, 0);
      expect(buf.length).to.equal(samples.length * 2);
      const view = new Int16Array(buf.buffer, buf.byteOffset, samples.length);
      // 实现使用 Int16Array 赋值（向零截断），与标准 PCM 转换一致
      expect(view[0]).to.equal(Math.trunc(0.5 * 0x7FFF));   // 16383
      expect(view[1]).to.equal(Math.trunc(-0.5 * 0x8000));  // -16384
    });

    it('applies volume to int16', () => {
      const buf = buildPcmBuffer(samples, 'int16', 0.5, 0);
      const view = new Int16Array(buf.buffer, buf.byteOffset, samples.length);
      expect(view[0]).to.equal(Math.trunc(0.25 * 0x7FFF));  // 8191
    });

    it('respects startSample offset', () => {
      const buf = buildPcmBuffer(samples, 'float32', 1.0, 2);
      const view = new Float32Array(buf.buffer, buf.byteOffset, samples.length - 2);
      expect(Array.from(view)).to.deep.equal([1.0, -1.0, 0.25]);
    });

    it('clamps startSample beyond length to empty', () => {
      const buf = buildPcmBuffer(samples, 'float32', 1.0, 100);
      expect(buf.length).to.equal(0);
    });

    it('clamps volume above 1 to 1.0', () => {
      const buf = buildPcmBuffer(samples, 'float32', 2.0, 0);
      const view = new Float32Array(buf.buffer, buf.byteOffset, samples.length);
      expect(view[0]).to.be.closeTo(0.5, 1e-6);
    });

    it('clamps negative volume to 0 (silence)', () => {
      const buf = buildPcmBuffer(samples, 'float32', -1.0, 0);
      const view = new Float32Array(buf.buffer, buf.byteOffset, samples.length);
      expect(view[0]).to.equal(0);
    });
  });

  describe('mapDevicesToLegacy', () => {
    it('filters out devices with no output channels', () => {
      const devices = [
        { index: 0, name: 'A', id: 'a', maxOutputChannels: 2, defaultSampleRate: 48000, isDefault: true },
        { index: 1, name: 'B', id: 'b', maxOutputChannels: 0, defaultSampleRate: 48000, isDefault: false },
      ];
      const result = mapDevicesToLegacy(devices, 'win32');
      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('A');
    });

    it('maps decibri fields to legacy shape', () => {
      const devices = [
        { index: 2, name: 'Speakers', id: 'wasapi:xxx', maxOutputChannels: 2, defaultSampleRate: 48000, isDefault: true },
      ];
      const result = mapDevicesToLegacy(devices, 'win32');
      expect(result[0]).to.deep.include({
        id: 2,
        name: 'Speakers',
        maxOutputChannels: 2,
        defaultSampleRate: 48000,
        hostAPI: 'WASAPI',
        isDefault: true,
      });
    });

    it('returns empty array for null/undefined input', () => {
      expect(mapDevicesToLegacy(null, 'win32')).to.deep.equal([]);
      expect(mapDevicesToLegacy(undefined, 'win32')).to.deep.equal([]);
    });

    it('uses platform argument for hostAPI', () => {
      const devices = [{ index: 0, name: 'X', id: 'x', maxOutputChannels: 1, defaultSampleRate: 44100 }];
      expect(mapDevicesToLegacy(devices, 'darwin')[0].hostAPI).to.equal('CoreAudio');
      expect(mapDevicesToLegacy(devices, 'linux')[0].hostAPI).to.equal('ALSA');
    });
  });

  describe('resolveDeviceOption', () => {
    it('returns null for -1 (system default)', () => {
      expect(resolveDeviceOption(-1)).to.be.null;
    });
    it('returns null for undefined/null', () => {
      expect(resolveDeviceOption(undefined)).to.be.null;
      expect(resolveDeviceOption(null)).to.be.null;
    });
    it('returns numeric index as-is', () => {
      expect(resolveDeviceOption(0)).to.equal(0);
      expect(resolveDeviceOption(2)).to.equal(2);
    });
    it('returns string name as-is', () => {
      expect(resolveDeviceOption('USB')).to.equal('USB');
    });
  });

  describe('buildSpeakerOptions', () => {
    it('uses defaults when no options provided', () => {
      const opts = buildSpeakerOptions();
      expect(opts.sampleRate).to.equal(24000);
      expect(opts.channels).to.equal(1);
      expect(opts.dtype).to.equal('float32');
      expect(opts).to.not.have.property('device');
    });

    it('includes device when deviceId is a real index', () => {
      const opts = buildSpeakerOptions({ deviceId: 1, sampleRate: 48000, channels: 2, bitDepth: 'int16' });
      expect(opts.device).to.equal(1);
      expect(opts.sampleRate).to.equal(48000);
      expect(opts.channels).to.equal(2);
      expect(opts.dtype).to.equal('int16');
    });

    it('omits device when deviceId is -1', () => {
      const opts = buildSpeakerOptions({ deviceId: -1 });
      expect(opts).to.not.have.property('device');
    });

    it('downgrades int24 bitDepth to float32 dtype', () => {
      const opts = buildSpeakerOptions({ bitDepth: 'int24' });
      expect(opts.dtype).to.equal('float32');
    });

    it('downgrades int32 bitDepth to float32 dtype', () => {
      const opts = buildSpeakerOptions({ bitDepth: 'int32' });
      expect(opts.dtype).to.equal('float32');
    });
  });
});
