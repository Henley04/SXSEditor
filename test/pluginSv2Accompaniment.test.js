'use strict';
/**
 * example-sv2 —— 自造 SV2 格式里的伴奏。
 *
 * SV2 是纯文本 JSON（不是商业格式），所以音频两种承载方式都支持：
 *   embedded —— WAV 以 base64 存在 `audio.data`，工程文件自包含；
 *   file     —— `audio.name` 引用同目录 WAV，工程文件很小。
 * 这条链路要锁住：
 *   ① 两种方式打开后都进 `type: 'accompaniment'` 的伴奏轨；
 *   ② 写回沿用源文件的承载方式（内嵌的不会突然变成旁挂，反之亦然）；
 *   ③ 缺素材 / 无字节 / 同名都不能写坏工程；
 *   ④ 伴奏不会变成一条没有音符的"人声轨"。
 */

const { expect } = require('chai');

const plugin = require('../plugins/example-sv2/main.js');
const { validateProjectDocument } = require('../src/shared/projectFormat.js');

function makeContext() {
  const notices = [];
  return {
    notices,
    ctx: {
      plugin: { locale: 'zh-CN' },
      log: { info() {}, warn() {}, error() {} },
      ui: {
        async status() {},
        async notify(text, level) { notices.push({ text, level }); },
      },
    },
  };
}

/** 最小 16bit PCM WAV，写入可识别的正弦波以便逐字节比对。 */
function makeWav({ seconds = 0.4, sampleRate = 44100, channels = 2 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const dataSize = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 7000);
    for (let c = 0; c < channels; c++) buf.writeInt16LE(v, 44 + (i * channels + c) * 2);
  }
  return buf;
}

function makeSingerTrack() {
  return {
    name: 'Lead',
    start: 0,
    notes: [{ start: 0, duration: 1, pitch: 62, lyric: 'a' }],
  };
}

function makeSv2({ accomp = [] } = {}) {
  return Buffer.from(JSON.stringify({
    format: 'sv2',
    bpm: 100,
    timeSignature: [4, 4],
    tracks: [makeSingerTrack()],
    ...(accomp.length ? { accompaniments: accomp } : {}),
  }), 'utf8');
}

function embeddedAccomp(overrides = {}) {
  const { wav = makeWav(), ...rest } = overrides;
  return {
    name: 'Backing',
    start: 2,
    volume: 0.5,
    mute: false,
    ...rest,
    audio: {
      mode: 'embedded',
      name: 'backing.wav',
      data: wav.toString('base64'),
      ...(rest.audio || {}),
    },
  };
}

function fileAccomp(overrides = {}) {
  return {
    name: 'Backing',
    start: 2,
    volume: 0.5,
    mute: false,
    ...overrides,
    audio: { mode: 'file', name: 'backing.wav', duration: 0.4, ...(overrides.audio || {}) },
  };
}

function parseSv2(bytes) {
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

async function readSv2(bytes, files = []) {
  const { ctx, notices } = makeContext();
  const result = await plugin.codecs['.sv2'].read(ctx, { name: 'in.sv2', bytes, files });
  const validated = validateProjectDocument(result.document);
  expect(validated.ok, validated.error).to.equal(true);
  return { document: validated.document, warnings: result.warnings, notices };
}

async function writeSv2(document) {
  const { ctx } = makeContext();
  return plugin.codecs['.sv2'].write(ctx, { name: 'out.sv2', document });
}

describe('example-sv2 — 伴奏（内嵌 / 相对路径）', () => {
  it('内嵌伴奏打开后进入伴奏轨：位置、音量、时长、声道、字节都对', async () => {
    const wav = makeWav();
    const { document, warnings } = await readSv2(makeSv2({ accomp: [embeddedAccomp({ wav })] }));
    expect(warnings).to.have.length(0);
    const acc = document.singers.filter((s) => s.type === 'accompaniment');
    expect(acc).to.have.length(1);
    expect(document.singers[0].type).to.equal('singer');
    expect(acc[0].trackName).to.equal('backing.wav');
    expect(acc[0].accompanimentStartTime).to.equal(2);
    expect(acc[0].accompanimentVolume).to.equal(0.5);
    expect(acc[0].audioDuration).to.equal(0.4);
    expect(acc[0].numberOfChannels).to.equal(2);
    expect(Buffer.from(acc[0].embeddedAudioData.wavBase64, 'base64')).to.deep.equal(wav);
    expect(acc[0].ext['example-sv2'].audioMode).to.equal('embedded');
  });

  it('相对路径伴奏从同目录 files 读入', async () => {
    const wav = makeWav();
    const { document, warnings } = await readSv2(makeSv2({ accomp: [fileAccomp()] }), [{ name: 'backing.wav', bytes: wav }]);
    expect(warnings).to.have.length(0);
    const acc = document.singers.filter((s) => s.type === 'accompaniment');
    expect(acc).to.have.length(1);
    expect(Buffer.from(acc[0].embeddedAudioData.wavBase64, 'base64')).to.deep.equal(wav);
    expect(acc[0].ext['example-sv2'].audioMode).to.equal('file');
  });

  it('写回沿用内嵌：不产生旁挂文件，JSON 里带 base64', async () => {
    const wav = makeWav();
    const { document: d1 } = await readSv2(makeSv2({ accomp: [embeddedAccomp({ wav })] }));
    const saved = await writeSv2(d1);
    expect(saved.files || []).to.deep.equal([]);
    const raw = parseSv2(saved.bytes);
    expect(raw.accompaniments).to.have.length(1);
    expect(raw.accompaniments[0].audio.mode).to.equal('embedded');
    expect(raw.accompaniments[0].audio.data).to.equal(wav.toString('base64'));
    expect(raw.accompaniments[0].audio.name).to.equal('backing.wav');
    expect(raw.accompaniments[0].start).to.equal(2);
    expect(raw.accompaniments[0].volume).to.equal(0.5);
  });

  it('写回沿用相对路径：JSON 不带字节，WAV 走 files 旁挂', async () => {
    const wav = makeWav();
    const { document: d1 } = await readSv2(makeSv2({ accomp: [fileAccomp()] }), [{ name: 'backing.wav', bytes: wav }]);
    const saved = await writeSv2(d1);
    expect(saved.files).to.have.length(1);
    expect(saved.files[0].name).to.equal('backing.wav');
    expect(Buffer.from(saved.files[0].bytes)).to.deep.equal(wav);
    const raw = parseSv2(saved.bytes);
    expect(raw.accompaniments[0].audio.mode).to.equal('file');
    expect(raw.accompaniments[0].audio.data).to.equal(undefined);
    expect(raw.accompaniments[0].audio.duration).to.equal(0.4);
  });

  it('read → write → read 闭环：两种承载方式都不丢伴奏', async () => {
    for (const [label, accomp, files] of [
      ['embedded', embeddedAccomp(), []],
      ['file', fileAccomp(), [{ name: 'backing.wav', bytes: makeWav() }]],
    ]) {
      const { document: d1 } = await readSv2(makeSv2({ accomp: [accomp] }), files);
      const saved = await writeSv2(d1);
      const { document: d2 } = await readSv2(Buffer.from(saved.bytes), saved.files || []);
      const acc = d2.singers.filter((s) => s.type === 'accompaniment');
      expect(acc, label).to.have.length(1);
      expect(acc[0].accompanimentStartTime, label).to.equal(2);
      expect(acc[0].accompanimentVolume, label).to.equal(0.5);
      expect(Buffer.from(acc[0].embeddedAudioData.wavBase64, 'base64'), label).to.deep.equal(makeWav());
    }
  });

  it('伴奏不会变成没有音符的人声轨', async () => {
    const { document } = await readSv2(makeSv2({ accomp: [embeddedAccomp()] }));
    const saved = await writeSv2(document);
    const raw = parseSv2(saved.bytes);
    expect(raw.tracks).to.have.length(1);
    expect(raw.tracks[0].name).to.equal('Lead');
    expect(raw.accompaniments).to.have.length(1);
  });

  it('相对路径引用的 WAV 缺失时告警跳过，不生成引用不存在文件的伴奏轨', async () => {
    const { document, warnings } = await readSv2(makeSv2({ accomp: [fileAccomp()] }), []);
    expect(document.singers.filter((s) => s.type === 'accompaniment')).to.have.length(0);
    expect(warnings.join('\n')).to.match(/不在工程同目录/);
  });

  it('跨目录引用只按 basename 匹配同目录文件，不接受路径穿越', async () => {
    const wav = makeWav();
    const { document, warnings } = await readSv2(
      makeSv2({ accomp: [fileAccomp({ audio: { name: '../elsewhere/backing.wav' } })] }),
      [{ name: 'backing.wav', bytes: wav }],
    );
    expect(warnings).to.have.length(0);
    const acc = document.singers.filter((s) => s.type === 'accompaniment');
    expect(acc).to.have.length(1);
    const saved = await writeSv2(document);
    expect(saved.files[0].name).to.equal('backing.wav');
    expect(parseSv2(saved.bytes).accompaniments[0].audio.name).to.equal('backing.wav');
  });

  it('没有音频字节时不写空引用，并明确告警', async () => {
    const { document: d1 } = await readSv2(makeSv2({ accomp: [embeddedAccomp()] }));
    d1.singers.find((s) => s.type === 'accompaniment').embeddedAudioData = null;
    const saved = await writeSv2(d1);
    expect(parseSv2(saved.bytes).accompaniments).to.equal(undefined);
    expect(saved.warnings.join('\n')).to.match(/没有可写入的音频/);
  });

  it('多条伴奏文件名安全化并去重，不互相覆盖', async () => {
    const { document: d1 } = await readSv2(makeSv2({ accomp: [fileAccomp()] }), [{ name: 'backing.wav', bytes: makeWav() }]);
    const acc = d1.singers.find((s) => s.type === 'accompaniment');
    const second = JSON.parse(JSON.stringify(acc));
    second.id = 'acc-2';
    second.trackName = 'Backing 2';
    d1.singers.push(second);
    const saved = await writeSv2(d1);
    expect(saved.files).to.have.length(2);
    expect(saved.files[0].name).to.not.equal(saved.files[1].name);
    const names = parseSv2(saved.bytes).accompaniments.map((a) => a.audio.name);
    expect(new Set(names).size).to.equal(2);
  });

  it('新建伴奏（无源快照）默认内嵌，单文件自包含', async () => {
    const { document } = await readSv2(makeSv2());
    document.singers.push({
      id: 'new-acc',
      type: 'accompaniment',
      trackName: 'Imported',
      singerName: 'Imported',
      audioFileName: 'imported.wav',
      audioDuration: 0.4,
      numberOfChannels: 2,
      accompanimentStartTime: 0,
      accompanimentVolume: 1,
      mute: false,
      embeddedAudioData: { wavBase64: makeWav().toString('base64'), audioFileName: 'imported.wav', audioDuration: 0.4 },
    });
    const saved = await writeSv2(document);
    expect(saved.files || []).to.deep.equal([]);
    const raw = parseSv2(saved.bytes);
    expect(raw.accompaniments[0].audio.mode).to.equal('embedded');
    expect(Buffer.from(raw.accompaniments[0].audio.data, 'base64')).to.deep.equal(makeWav());
  });
});
