'use strict';
/**
 * official-project-import —— VOCALOID5/6（.vpr）里的伴奏轨。
 *
 * 带伴奏的工程在 ZIP 里躺着一份 `Project/Audio/*.wav`（44.1k/16bit 立体声约
 * 10MB 每分钟）。这条链路曾经在"ZIP 条目过大"上整份打不开，所以这里同时锁定：
 *   ① 音频真的进了宿主的伴奏轨（位置、音量、声道、字节都对）；
 *   ② 体积再大也不能把整个工程挡在门外 —— 超限就只丢伴奏并说清原因。
 */

const { expect } = require('chai');

const plugin = require('../plugins/official-project-import/main.js');
const { writeZip } = require('../plugins/official-project-import/lib/zip.js');
const { parseWav } = require('../plugins/official-project-import/lib/wav.js');
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

/** 最小 16bit PCM WAV（静音），够宿主解析头、够校验长度。 */
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
  return buf;
}

/** 改写中央目录里某个条目声明的解压后大小（不必真的造出 200MB 数据）。 */
function patchDeclaredSize(zip, entryName, size) {
  const out = Buffer.from(zip);
  const CENTRAL = 0x02014b50;
  for (let pos = 0; pos + 46 <= out.length; pos++) {
    if (out.readUInt32LE(pos) !== CENTRAL) continue;
    const nameLen = out.readUInt16LE(pos + 28);
    if (out.toString('utf8', pos + 46, pos + 46 + nameLen) === entryName) {
      out.writeUInt32LE(size, pos + 24);
      return out;
    }
  }
  throw new Error(`patchDeclaredSize: ${entryName} not found`);
}

function makeVprWithAudio(options = {}) {
  const {
    wavName = 'a1b2c3d4.wav',
    originalName = '伴奏.wav',
    audioPos = 960,
    volume = -600,
    muted = false,
    region = { begin: 0, end: 500 },
    wav = makeWav(),
    declaredSize = null,
  } = options;

  const sequence = {
    version: { major: 6, minor: 0, revision: 0 },
    vender: 'Yamaha corporation',
    title: '带伴奏的工程',
    masterTrack: {
      samplingRate: 44100,
      tempo: { events: [{ pos: 0, value: 12000 }] },
      timeSig: { events: [{ bar: 0, numer: 4, denom: 4 }] },
    },
    tracks: [
      {
        type: 0,
        name: 'Vocal',
        color: 0,
        parts: [{ pos: 0, duration: 1920, notes: [{ pos: 0, duration: 480, number: 60, lyric: 'la' }] }],
      },
      {
        type: 1,
        name: 'Audio',
        isMuted: muted,
        volume: { events: [{ pos: 0, value: volume }] },
        parts: [{ name: '伴奏', pos: audioPos, wav: { name: wavName, originalName }, region }],
      },
    ],
  };

  const entries = [{ name: 'Project/sequence.json', data: JSON.stringify(sequence) }];
  if (wav) entries.push({ name: `Project/Audio/${wavName}`, data: wav });
  const zip = writeZip(entries);
  return declaredSize ? patchDeclaredSize(zip, `Project/Audio/${wavName}`, declaredSize) : zip;
}

async function readVprZip(bytes) {
  const { ctx, notices } = makeContext();
  const result = await plugin.codecs['.vpr'].read(ctx, { name: 'with-audio.vpr', bytes });
  const validated = validateProjectDocument(result.document);
  expect(validated.ok, validated.error).to.equal(true);
  return { document: validated.document, warnings: result.warnings, notices };
}

describe('official-project-import — VPR 伴奏轨（Project/Audio/*.wav）', () => {
  it('伴奏音频进入宿主伴奏轨：位置、音量、声道与字节都在', async () => {
    const wav = makeWav({ seconds: 0.5 });
    const { document, warnings } = await readVprZip(makeVprWithAudio({ wav, volume: -600 }));

    expect(document.singers).to.have.length(2);
    expect(document.singers[0].type).to.equal('singer');
    expect(document.fragments).to.have.length(1);

    const acc = document.singers[1];
    expect(acc.type).to.equal('accompaniment');
    expect(acc.trackName).to.equal('伴奏');
    expect(acc.audioFileName).to.equal('伴奏.wav');
    // pos 960 tick / 480 tick 每拍 = 2 拍
    expect(acc.accompanimentStartTime).to.equal(2);
    // -600（0.01dB 定点）→ -6dB → 0.501
    expect(acc.accompanimentVolume).to.be.closeTo(0.501, 1e-3);
    expect(acc.mute).to.equal(false);
    expect(acc.numberOfChannels).to.equal(2);
    expect(acc.audioDuration).to.be.closeTo(0.5, 1e-3);
    expect(parseWav(wav).duration).to.be.closeTo(0.5, 1e-3);

    // 字节必须原样：被 stringLength 截断的 base64 会解出一段废音频，
    // 而用户看到的是"伴奏导进来了，播放却是爆音"。
    const decoded = Buffer.from(acc.embeddedAudioData.wavBase64, 'base64');
    expect(decoded.length).to.equal(wav.length);
    expect(decoded.equals(wav)).to.equal(true);
    expect(warnings.join('\n')).to.not.match(/跳过/);
  });

  it('region（毫秒）指定的片段先裁剪再导入，伴奏不会整体平移', async () => {
    const wav = makeWav({ seconds: 1 });
    const { document, warnings } = await readVprZip(makeVprWithAudio({
      wav,
      region: { begin: 200, end: 500 },
    }));

    const acc = document.singers.find((s) => s.type === 'accompaniment');
    expect(acc.audioDuration).to.be.closeTo(0.3, 5e-3);
    const decoded = Buffer.from(acc.embeddedAudioData.wavBase64, 'base64');
    expect(decoded.length).to.equal(44 + Math.round(0.3 * 44100) * 4);
    expect(decoded.slice(0, 4).toString()).to.equal('RIFF');
    // 裁剪必须让用户知道，否则他会以为源工程的入点是错的
    expect(warnings.join('\n')).to.match(/截取|trim/i);
  });

  it('静音与音量都按源轨道写入（-∞ 时是 0，不是 1）', async () => {
    const { document } = await readVprZip(makeVprWithAudio({ muted: true, volume: -100000 }));
    const acc = document.singers.find((s) => s.type === 'accompaniment');
    expect(acc.mute).to.equal(true);
    expect(acc.accompanimentVolume).to.equal(0);
  });

  it('音频超过单条上限时只丢伴奏，工程照常导入并说清原因', async () => {
    const { document, warnings } = await readVprZip(makeVprWithAudio({ declaredSize: 200 * 1024 * 1024 }));

    expect(document.singers).to.have.length(1);
    expect(document.singers[0].type).to.equal('singer');
    expect(document.fragments).to.have.length(1);
    expect(warnings.join('\n')).to.match(/伴奏/);
    expect(warnings.join('\n')).to.match(/上限|跳过/);
  });

  it('包内缺音频文件时告警，而不是静默丢掉伴奏', async () => {
    const { document, warnings } = await readVprZip(makeVprWithAudio({ wav: null }));
    expect(document.singers).to.have.length(1);
    expect(warnings.join('\n')).to.match(/找不到|no .*wav/i);
  });

  it('写回 VPR 时明确告警"伴奏不会写回"，不假装无损', async () => {
    const { document } = await readVprZip(makeVprWithAudio());
    const { ctx } = makeContext();
    const saved = await plugin.codecs['.vpr'].write(ctx, { name: 'back.vpr', document });
    expect(saved.warnings.join('\n')).to.match(/伴奏/);

    const again = await plugin.codecs['.vpr'].read(ctx, { name: 'back.vpr', bytes: Buffer.from(saved.bytes) });
    expect(again.document.singers.filter((s) => s.type === 'accompaniment')).to.have.length(0);
    // 音符仍在 —— 丢的只有音频
    expect(again.document.fragments).to.have.length(1);
  });
});

describe('projectFormat — 嵌入式音频的校验口径', () => {
  it('wavBase64 不被 stringLength 截断，按 4/3 体积原样通过', () => {
    const wav = makeWav({ seconds: 3 });
    const base64 = wav.toString('base64');
    const checked = validateProjectDocument({
      project: { bpm: 120, timeSignature: [4, 4] },
      singers: [{
        id: 'acc',
        type: 'accompaniment',
        embeddedAudioData: { wavBase64: base64, audioFileName: 'a.wav' },
      }],
      fragments: [],
    });
    expect(checked.ok, checked.error).to.equal(true);
    expect(checked.document.singers[0].embeddedAudioData.wavBase64).to.equal(base64);
    expect(Buffer.from(checked.document.singers[0].embeddedAudioData.wavBase64, 'base64').equals(wav)).to.equal(true);
  });

  it('普通字段仍然按 100k 截断（别把例外扩散成通用规则）', () => {
    const checked = validateProjectDocument({
      project: { bpm: 120, timeSignature: [4, 4] },
      singers: [{ id: 's', trackName: 'x'.repeat(200000) }],
      fragments: [],
    });
    expect(checked.ok, checked.error).to.equal(true);
    expect(checked.document.singers[0].trackName.length).to.equal(100000);
  });
});
