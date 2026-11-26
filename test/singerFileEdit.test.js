const { expect } = require('chai');
const {
  buildSingerEditPayload,
  sniffImageMime,
  validateSingerFileData,
} = require('../src/shared/singerFileEdit');

// 最小合法 WAV：44 字节头 + 少量样本
function tinyWavBase64(bytes = 64) {
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(bytes, 40);
  return buf.toString('base64');
}

function makeSingerFile(overrides = {}) {
  return JSON.stringify({
    formatVersion: '1.0.0',
    singerName: '测试歌手',
    color: '#3498db',
    avatarBase64: null,
    wavFileName: 'vocal.wav',
    wavDuration: 3.5,
    isPreprocessed: true,
    midiNotes: [
      { id: 1, pitch: 60, start: 0, duration: 0.5, lyric: 'la' },
      { id: 2, pitch: 64, start: 0.5, duration: 0.5, lyric: 'la' },
    ],
    f0Data: [{ time: 0, f0: 261.6 }],
    singerData: { note_pitch: '60 64', f0: '261.6' },
    wavBase64: tinyWavBase64(),
    ...overrides,
  });
}

describe('singerFileEdit.buildSingerEditPayload', () => {
  it('parses a valid singer file into preprocessing payload', () => {
    const res = buildSingerEditPayload(makeSingerFile(), '/tmp/singer.sxssinger');
    expect(res.ok).to.equal(true);
    expect(res.payload.singerName).to.equal('测试歌手');
    expect(res.payload.wavFileName).to.equal('vocal.wav');
    expect(res.payload.duration).to.equal(3.5);
    expect(res.payload.wavBuffer).to.be.instanceOf(ArrayBuffer);
    expect(res.payload.wavBuffer.byteLength).to.be.greaterThan(44);
    expect(res.payload.edit.filePath).to.equal('/tmp/singer.sxssinger');
    expect(res.payload.edit.midiNotes).to.have.length(2);
    expect(res.payload.edit.midiNotes[1].pitch).to.equal(64);
    expect(res.payload.edit.f0Data).to.have.length(1);
    expect(res.payload.edit.singerData.note_pitch).to.equal('60 64');
  });

  it('defaults missing note / f0 / singerData to empty values', () => {
    const raw = makeSingerFile({ midiNotes: undefined, f0Data: undefined, singerData: undefined });
    const res = buildSingerEditPayload(raw, '/tmp/a.sxssinger');
    expect(res.ok).to.equal(true);
    expect(res.payload.edit.midiNotes).to.deep.equal([]);
    expect(res.payload.edit.f0Data).to.deep.equal([]);
    expect(res.payload.edit.singerData).to.equal(null);
  });

  it('falls back to the file name when wavFileName is absent', () => {
    const raw = makeSingerFile({ wavFileName: undefined });
    const res = buildSingerEditPayload(raw, '/data/MySinger.sxssinger');
    expect(res.ok).to.equal(true);
    expect(res.payload.wavFileName).to.equal('MySinger.sxssinger');
  });

  it('rejects malformed JSON', () => {
    const res = buildSingerEditPayload('{not json', '/tmp/x.sxssinger');
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal('INVALID_JSON');
  });

  it('rejects empty content', () => {
    const res = buildSingerEditPayload('', '/tmp/x.sxssinger');
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal('EMPTY');
  });

  it('rejects a file without wavBase64', () => {
    const res = buildSingerEditPayload(makeSingerFile({ wavBase64: undefined }), '/tmp/x.sxssinger');
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal('INVALID_DATA');
    expect(res.error).to.match(/wavBase64/);
  });

  it('rejects a file without singerName', () => {
    const res = buildSingerEditPayload(makeSingerFile({ singerName: '   ' }), '/tmp/x.sxssinger');
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal('INVALID_DATA');
  });

  it('turns a base64 avatar into a data URL with sniffed mime', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const res = buildSingerEditPayload(
      makeSingerFile({ avatarBase64: png.toString('base64') }),
      '/tmp/x.sxssinger'
    );
    expect(res.ok).to.equal(true);
    expect(res.payload.avatarImageData).to.match(/^data:image\/png;base64,/);
    expect(res.payload.edit.avatarImageData).to.equal(res.payload.avatarImageData);
  });
});

describe('singerFileEdit.sniffImageMime', () => {
  it('detects png / jpeg / gif / webp', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).to.equal('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).to.equal('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a______', 'ascii'))).to.equal('image/gif');
    const webp = Buffer.concat([Buffer.from('RIFF0000WEBP', 'ascii'), Buffer.alloc(4)]);
    expect(sniffImageMime(webp)).to.equal('image/webp');
  });
});

describe('singerFileEdit.validateSingerFileData', () => {
  it('accepts a minimal valid object', () => {
    const res = validateSingerFileData({
      singerName: 'A',
      wavBase64: tinyWavBase64(),
    });
    expect(res.valid).to.equal(true);
  });

  it('warns but does not reject bad color / long duration', () => {
    const res = validateSingerFileData({
      singerName: 'A',
      wavBase64: tinyWavBase64(),
      color: 'red',
      wavDuration: 120,
    });
    expect(res.valid).to.equal(true);
    expect(res.warnings.length).to.be.greaterThan(0);
  });
});
