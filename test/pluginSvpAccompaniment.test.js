'use strict';
/**
 * official-project-import —— Synthesizer V（.svp）里的 instrumental track。
 *
 * SVP 是纯 JSON，不内嵌音频：伴奏以 `groups[].isInstrumental: true` +
 * `audio.filename` 相对路径引用工程同目录的 WAV（OpenUtau 的 SVP.cs 与真实
 * instrumental.svp 都是这个结构）。这条链路要同时锁住：
 *   ① 打开时宿主读入的同目录 WAV 真的进了伴奏轨（位置/音量/时长/字节）；
 *   ② 写回时生成的是标准 instrumental track，音频作为旁挂文件交宿主落盘；
 *   ③ read → write → read 闭环不丢伴奏 —— 相对路径最容易断在这里；
 *   ④ 缺素材、跨目录引用、无内嵌字节都不能生成引用不存在文件的空轨。
 */

const { expect } = require('chai');

const plugin = require('../plugins/official-project-import/main.js');
const { validateProjectDocument } = require('../src/shared/projectFormat.js');

const BLICK_PER_BEAT = 705600000;

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
function makeWav({ seconds = 0.5, sampleRate = 44100, channels = 2 } = {}) {
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
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    for (let c = 0; c < channels; c++) buf.writeInt16LE(v, 44 + (i * channels + c) * 2);
  }
  return buf;
}

function makeSvpWithAudio(options = {}) {
  const {
    wavName = 'backing.wav',
    startBeat = 2,
    gainDecibel = -6.02,
    muted = false,
    audioDuration = 0.5,
    dispOrder = 1,
  } = options;
  const beginBlick = Math.round(startBeat * BLICK_PER_BEAT);
  const raw = {
    version: 200,
    time: {
      meter: [{ index: 0, numerator: 4, denominator: 4 }],
      tempo: [{ position: 0, bpm: 120 }],
    },
    library: [],
    tracks: [
      {
        name: 'Lead',
        dispColor: 'ff7db235',
        dispOrder: 0,
        renderEnabled: true,
        mainGroup: {
          name: 'main', uuid: 'g1',
          parameters: { pitchDelta: { mode: 'cubic', points: [] } },
          notes: [{ onset: 0, duration: BLICK_PER_BEAT, lyrics: 'la', pitch: 60 }],
        },
        mainRef: { groupID: 'g1', blickOffset: 0, pitchOffset: 0, isInstrumental: false },
        groups: [],
      },
      {
        name: 'Backing',
        dispColor: 'ff3366cc',
        dispOrder,
        renderEnabled: false,
        mixer: { gainDecibel, pan: 0, mute: muted, solo: false, display: true },
        groups: [{
          groupID: 'instrumental-ref-1',
          blickOffset: beginBlick,
          blickAbsoluteBegin: beginBlick,
          isInstrumental: true,
          audio: { filename: wavName, duration: audioDuration },
        }],
      },
    ],
  };
  return Buffer.from(JSON.stringify(raw, null, 2), 'utf8');
}

function parseSvp(bytes) {
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

async function readSvp(bytes, files = []) {
  const { ctx, notices } = makeContext();
  const result = await plugin.codecs['.svp'].read(ctx, { name: 'in.svp', bytes, files });
  const validated = validateProjectDocument(result.document);
  expect(validated.ok, validated.error).to.equal(true);
  return { document: validated.document, warnings: result.warnings, notices };
}

async function writeSvp(document) {
  const { ctx } = makeContext();
  return plugin.codecs['.svp'].write(ctx, { name: 'out.svp', document });
}

describe('official-project-import — SVP instrumental track（相对路径伴奏）', () => {
  it('打开时同目录 WAV 进入伴奏轨：位置、音量、时长、声道、字节都对', async () => {
    const wav = makeWav();
    const { document, warnings } = await readSvp(makeSvpWithAudio(), [{ name: 'backing.wav', bytes: wav }]);
    expect(warnings).to.have.length(0);
    const acc = document.singers.filter((s) => s.type === 'accompaniment');
    expect(acc).to.have.length(1);
    expect(document.singers[0].type).to.equal('singer');
    expect(document.fragments).to.have.length(1);
    expect(acc[0].trackName).to.equal('Backing');
    expect(acc[0].accompanimentStartTime).to.equal(2);
    expect(acc[0].accompanimentVolume).to.be.closeTo(0.5, 0.001);
    expect(acc[0].audioDuration).to.equal(0.5);
    expect(acc[0].numberOfChannels).to.equal(2);
    expect(acc[0].mute).to.equal(false);
    expect(Buffer.from(acc[0].embeddedAudioData.wavBase64, 'base64')).to.deep.equal(wav);
    const ext = (acc[0].ext || {})['official-project-import'];
    expect(ext.svp.groupID).to.equal('instrumental-ref-1');
    expect(ext.svp.displayName).to.equal('Backing');
  });

  it('instrumental track 不被误当成音符组（没有 library 缺失告警）', async () => {
    const { document, warnings } = await readSvp(makeSvpWithAudio(), [{ name: 'backing.wav', bytes: makeWav() }]);
    expect(warnings.join('\n')).to.not.match(/音符组.*找不到|missing from library/);
    expect(document.singers.filter((s) => s.type === 'singer')).to.have.length(1);
  });

  it('read → write → read 闭环：伴奏、音频字节与结构都不丢', async () => {
    const wav = makeWav();
    const { document: d1 } = await readSvp(makeSvpWithAudio(), [{ name: 'backing.wav', bytes: wav }]);
    const saved = await writeSvp(d1);
    expect(saved.files).to.have.length(1);
    expect(saved.files[0].name).to.equal('backing.wav');
    expect(Buffer.from(saved.files[0].bytes)).to.deep.equal(wav);

    const raw = parseSvp(saved.bytes);
    const inst = raw.tracks.find((t) => (t.groups || []).some((g) => g.isInstrumental));
    expect(inst, '应生成标准 instrumental track').to.exist;
    const ref = inst.groups.find((g) => g.isInstrumental);
    expect(ref.audio.filename).to.equal('backing.wav');
    expect(ref.audio.duration).to.equal(0.5);
    expect(ref.blickOffset).to.equal(2 * BLICK_PER_BEAT);
    expect(inst.mixer.mute).to.equal(false);
    expect(inst.mixer.gainDecibel).to.be.closeTo(-6.02, 0.1);
    // instrumental track 排在人声轨之后，dispOrder 连续
    expect(raw.tracks[0].name).to.equal('Lead');
    expect(inst.dispOrder).to.be.at.least(raw.tracks.length - 1);

    const { document: d2, warnings: w2 } = await readSvp(Buffer.from(saved.bytes), saved.files);
    expect(w2).to.have.length(0);
    const acc = d2.singers.filter((s) => s.type === 'accompaniment');
    expect(acc).to.have.length(1);
    expect(acc[0].accompanimentStartTime).to.equal(2);
    expect(Buffer.from(acc[0].embeddedAudioData.wavBase64, 'base64')).to.deep.equal(wav);
  });

  it('mainRef 上的 instrumental 也能导入（OpenUtau 会遍历 mainRef + groups）', async () => {
    const raw = parseSvp(makeSvpWithAudio());
    const instTrack = raw.tracks[1];
    instTrack.mainRef = instTrack.groups[0];
    instTrack.groups = [];
    const { document } = await readSvp(Buffer.from(JSON.stringify(raw)), [{ name: 'backing.wav', bytes: makeWav() }]);
    expect(document.singers.filter((s) => s.type === 'accompaniment')).to.have.length(1);
  });

  it('只有伴奏没有人声的工程也能打开（音频轨合法工程）', async () => {
    const raw = parseSvp(makeSvpWithAudio());
    raw.tracks = [raw.tracks[1]];
    const { document } = await readSvp(Buffer.from(JSON.stringify(raw)), [{ name: 'backing.wav', bytes: makeWav() }]);
    expect(document.singers.filter((s) => s.type === 'accompaniment')).to.have.length(1);
    expect(document.fragments).to.have.length(0);
  });

  it('伴生 WAV 缺失时明确告警，不生成引用不存在文件的伴奏轨', async () => {
    const { document, warnings } = await readSvp(makeSvpWithAudio(), []);
    expect(document.singers.filter((s) => s.type === 'accompaniment')).to.have.length(0);
    expect(warnings.join('\n')).to.match(/不在工程文件同目录|not next to the \.svp/);
  });

  it('跨目录引用只按 basename 匹配同目录文件，不接受路径穿越', async () => {
    const wav = makeWav();
    const { document, warnings } = await readSvp(
      makeSvpWithAudio({ wavName: '../elsewhere/backing.wav' }),
      [{ name: 'backing.wav', bytes: wav }],
    );
    expect(document.singers.filter((s) => s.type === 'accompaniment')).to.have.length(1);
    expect(warnings).to.have.length(0);
    // 写回用纯文件名，绝不把 ../ 路径带进产物
    const saved = await writeSvp(document);
    expect(saved.files[0].name).to.equal('backing.wav');
    const inst = parseSvp(saved.bytes).tracks.find((t) => (t.groups || []).some((g) => g.isInstrumental));
    expect(inst.groups[0].audio.filename).to.equal('backing.wav');
  });

  it('没有内嵌音频字节时不写空引用，并明确告警', async () => {
    const { document: d1 } = await readSvp(makeSvpWithAudio(), [{ name: 'backing.wav', bytes: makeWav() }]);
    d1.singers.find((s) => s.type === 'accompaniment').embeddedAudioData = null;
    const saved = await writeSvp(d1);
    // 没有音频时插件不返回 files 字段（宿主按"无旁挂文件"处理），
    // 关键是不能生成引用不存在 wav 的 instrumental track。
    expect(saved.files || []).to.have.length(0);
    expect(parseSvp(saved.bytes).tracks.some((t) => (t.groups || []).some((g) => g.isInstrumental))).to.equal(false);
    expect(saved.warnings.join('\n')).to.match(/没有可写入的音频|no writable audio/i);
  });

  it('多条伴奏文件名安全化并去重，不互相覆盖', async () => {
    const { document: d1 } = await readSvp(makeSvpWithAudio(), [{ name: 'backing.wav', bytes: makeWav() }]);
    const acc = d1.singers.find((s) => s.type === 'accompaniment');
    const second = JSON.parse(JSON.stringify(acc));
    second.id = 'acc-2';
    second.trackName = 'Backing 2';
    d1.singers.push(second);
    const saved = await writeSvp(d1);
    expect(saved.files).to.have.length(2);
    expect(saved.files[0].name).to.not.equal(saved.files[1].name);
    const instTracks = parseSvp(saved.bytes).tracks.filter((t) => (t.groups || []).some((g) => g.isInstrumental));
    expect(instTracks).to.have.length(2);
    const names = instTracks.map((t) => t.groups[0].audio.filename);
    expect(new Set(names).size).to.equal(2);
  });

  it('写回告警说明相对路径依赖，不谎报无损', async () => {
    const { document } = await readSvp(makeSvpWithAudio(), [{ name: 'backing.wav', bytes: makeWav() }]);
    const saved = await writeSvp(document);
    expect(saved.warnings.join('\n')).to.match(/相对路径引用同目录|relative path to WAV files beside/);
    expect(saved.warnings.join('\n')).to.not.match(/不会写回|not written back/);
  });
});
