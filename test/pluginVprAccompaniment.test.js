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
const { writeZip, readZip } = require('../plugins/official-project-import/lib/zip.js');
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
    trackColor = 0,
    audioTrackName = 'Audio',
    wavExtras = {},
    audioPartExtras = {},
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
        color: trackColor,
        parts: [{ pos: 0, duration: 1920, notes: [{ pos: 0, duration: 480, number: 60, lyric: 'la' }] }],
      },
      {
        type: 1,
        name: audioTrackName,
        isMuted: muted,
        volume: { events: [{ pos: 0, value: volume }] },
        parts: [{
          name: '伴奏', pos: audioPos,
          wav: { name: wavName, originalName, ...wavExtras }, region,
          ...audioPartExtras,
        }],
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

/** 走 codec.write 写回，并顺带把写出的 ZIP 解成「条目表 + sequence.json」。 */
async function writeVprZip(document, name = 'back.vpr') {
  const { ctx, notices } = makeContext();
  const saved = await plugin.codecs['.vpr'].write(ctx, { name, document });
  const bytes = Buffer.from(saved.bytes);
  const { files } = readZip(bytes);
  const seqName = [...files.keys()].find((n) => n.toLowerCase().endsWith('sequence.json'));
  const raw = JSON.parse(files.get(seqName).toString('utf8').replace(/^\uFEFF/, ''));
  return { bytes, files, raw, warnings: saved.warnings, notices };
}

/** 宿主里手工新建的文档：不走导入，用来验证"能打开的类型数据"不止于导入链路。 */
function hostDocumentWithAccompaniment(overrides = {}) {
  const wav = overrides.wav || makeWav({ seconds: 0.4 });
  const singer = {
    id: 'acc-1',
    type: 'accompaniment',
    trackName: overrides.trackName || '自建伴奏',
    singerName: overrides.trackName || '自建伴奏',
    audioFileName: overrides.audioFileName || 'my track.wav',
    audioDuration: 0.4,
    numberOfChannels: 2,
    accompanimentStartTime: 3,
    accompanimentVolume: 0.5,
    mute: true,
    embeddedAudioData: { wavBase64: wav.toString('base64'), audioFileName: 'my track.wav' },
    ...(overrides.ext ? { ext: overrides.ext } : {}),
  };
  return {
    project: { bpm: 120, timeSignature: [4, 4] },
    singers: [
      { id: 'vocal', type: 'singer', trackName: 'Vocal' },
      singer,
    ],
    fragments: [{
      id: 'f1', singerId: 'vocal', startTime: 0, duration: 2, name: 'Verse',
      notes: [{ id: 1, pitch: 60, start: 0, duration: 1, lyric: 'la' }],
    }],
  };
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

});

describe('official-project-import — VPR 伴奏写回（read → write → read）', () => {
  it('伴奏音频与音频轨一起写回：ZIP 条目、字节、位置、音量、静音与文件名都在', async () => {
    const wav = makeWav({ seconds: 0.5 });
    const { document } = await readVprZip(makeVprWithAudio({ wav, volume: -600 }));
    const saved = await writeVprZip(document);

    // 不再谎报"伴奏不会写回"；有损项仍然照常告警
    expect(saved.warnings.join('\n')).to.not.match(/不会写回|are not written back/);
    expect(saved.warnings.join('\n')).to.match(/有损|lossy/i);

    expect([...saved.files.keys()]).to.include('Project/Audio/a1b2c3d4.wav');
    const writtenWav = saved.files.get('Project/Audio/a1b2c3d4.wav');
    expect(writtenWav.equals(wav)).to.equal(true);

    // 源工程里"能打开"的键都要回去
    expect(saved.raw.version).to.deep.equal({ major: 6, minor: 0, revision: 0 });
    expect(saved.raw.vender).to.equal('Yamaha corporation');
    expect(saved.raw.title).to.equal('带伴奏的工程');
    expect(saved.raw.masterTrack.samplingRate).to.equal(44100);
    expect(saved.raw.tracks).to.have.length(2);
    const audioTrack = saved.raw.tracks[1];
    expect(audioTrack.type).to.equal(1);
    expect(audioTrack.name).to.equal('Audio');
    expect(audioTrack.isMuted).to.equal(false);
    expect(audioTrack.volume.events[0].value).to.equal(-600);
    const audioPart = audioTrack.parts[0];
    expect(audioPart.name).to.equal('伴奏');
    expect(audioPart.pos).to.equal(960);
    expect(audioPart.wav.name).to.equal('a1b2c3d4.wav');
    expect(audioPart.wav.originalName).to.equal('伴奏.wav');
    expect(audioPart.region.end).to.equal(500);

    // 再打开一次：伴奏轨、音频字节、位置、音量、静音都回来
    const again = await readVprZip(saved.bytes);
    const acc = again.document.singers.find((s) => s.type === 'accompaniment');
    expect(acc).to.be.ok;
    expect(Buffer.from(acc.embeddedAudioData.wavBase64, 'base64').equals(wav)).to.equal(true);
    expect(acc.accompanimentStartTime).to.equal(2);
    expect(acc.accompanimentVolume).to.be.closeTo(0.501, 1e-3);
    expect(acc.mute).to.equal(false);
    expect(acc.audioFileName).to.equal('伴奏.wav');
    expect(again.document.fragments).to.have.length(1);
    expect(again.document.singers[0].trackName).to.equal('Vocal');
  });

  it('人声轨的 color 与 type 也写回，源标量键不因音频轨插队而错位', async () => {
    const { document } = await readVprZip(makeVprWithAudio({ trackColor: 0xff3366cc }));
    const saved = await writeVprZip(document);
    expect(saved.raw.tracks[0].color).to.equal(0xff3366cc);
    expect(saved.raw.tracks[0].type).to.equal(0);
    expect(saved.raw.tracks[1].type).to.equal(1);
  });

  it('region 裁剪写回后不二次平移：音频长度与重新导入的时长一致', async () => {
    const wav = makeWav({ seconds: 1 });
    const { document } = await readVprZip(makeVprWithAudio({
      wav, region: { begin: 200, end: 500 },
    }));
    const saved = await writeVprZip(document);
    const region = saved.raw.tracks[1].parts[0].region;
    expect(region.begin).to.equal(0);
    expect(region.end).to.be.closeTo(300, 15);
    expect(saved.warnings.join('\n')).to.match(/region|烘焙/);

    const again = await readVprZip(saved.bytes);
    const acc = again.document.singers.find((s) => s.type === 'accompaniment');
    expect(acc.audioDuration).to.be.closeTo(0.3, 5e-3);
    // 写回的 WAV 与导入时裁剪后的字节完全一致，没有被再次裁短
    const written = saved.files.get('Project/Audio/a1b2c3d4.wav');
    expect(written.equals(Buffer.from(acc.embeddedAudioData.wavBase64, 'base64'))).to.equal(true);
  });

  it('宿主里新建的伴奏轨（无源快照）也能写回，并说明按新建音频轨生成', async () => {
    const wav = makeWav({ seconds: 0.4 });
    const document = hostDocumentWithAccompaniment({ wav });
    const saved = await writeVprZip(document);

    expect(saved.warnings.join('\n')).to.match(/新建|fresh/i);
    expect(saved.raw.tracks).to.have.length(2);
    expect(saved.raw.tracks[1].type).to.equal(1);
    expect(saved.raw.tracks[1].isMuted).to.equal(true);
    expect(saved.raw.tracks[1].parts[0].pos).to.equal(3 * 480);
    expect(saved.raw.tracks[1].parts[0].wav.originalName).to.equal('my track.wav');
    const entries = [...saved.files.keys()];
    expect(entries.some((n) => n.startsWith('Project/Audio/'))).to.equal(true);
    expect([...saved.files.values()].some((b) => b.equals(wav))).to.equal(true);

    const again = await readVprZip(saved.bytes);
    expect(again.document.singers.filter((s) => s.type === 'accompaniment')).to.have.length(1);
  });

  it('包名带路径穿越时安全化，同名伴奏去重，不产生指向不存在素材的引用', async () => {
    const document = hostDocumentWithAccompaniment();
    document.singers[1].embeddedAudioData.audioFileName = 'my track.wav';
    // 伪装成从旧版插件导入、但 wav.name 是恶意路径的源结构
    document.singers[1].ext = {
      'official-project-import': {
        vpr: {
          track: { type: 1, name: 'Audio' },
          part: { pos: 1440 },
          wav: { name: '../../evil.wav', originalName: 'evil.wav' },
          region: null,
        },
      },
    };
    const second = { ...document.singers[1], id: 'acc-2' };
    document.singers.push(second);

    const saved = await writeVprZip(document);
    const audioEntries = [...saved.files.keys()].filter((n) => n.startsWith('Project/Audio/'));
    expect(audioEntries).to.have.length(2);
    for (const name of audioEntries) expect(name).to.not.match(/\.\.|\\/);
    const names = saved.raw.tracks.filter((t) => t.type === 1).map((t) => t.parts[0].wav.name);
    expect(new Set(names).size).to.equal(2);
    for (const name of names) expect(saved.files.has(`Project/Audio/${name}`)).to.equal(true);
  });

  it('没有内嵌音频字节时不写空引用，并明确告警', async () => {
    const document = hostDocumentWithAccompaniment();
    document.singers[1].embeddedAudioData = null;
    const saved = await writeVprZip(document);
    expect(saved.raw.tracks).to.have.length(1);
    expect([...saved.files.keys()].filter((n) => n.startsWith('Project/Audio/'))).to.have.length(0);
    expect(saved.warnings.join('\n')).to.match(/没有可写入的音频|no writable audio/i);
  });

  it('另存为 .svp / .vsqx 时伴奏仍明确告警不会写回（格式无音频容器）', async () => {
    const { document } = await readVprZip(makeVprWithAudio());
    for (const ext of ['.svp', '.vsqx']) {
      const { ctx } = makeContext();
      const saved = await plugin.codecs[ext].write(ctx, { name: `cross${ext}`, document });
      expect(saved.warnings.join('\n'), ext).to.match(/伴奏.*不会写回|accompaniment track\(s\) are not written back/);
    }
  });

  it('文档级 ext 丢失时元数据告警未沿用，伴奏结构仍随轨快照写回', async () => {
    const { document } = await readVprZip(makeVprWithAudio());
    // 抹掉文档级 ext（模拟"不是本插件导入"），伴奏轨的随轨快照仍在
    delete document.ext;
    const saved = await writeVprZip(document);
    expect(saved.warnings.join('\n')).to.match(/源工程元数据未沿用|not reused/i);
    expect(saved.raw.tracks).to.have.length(2);
    expect(saved.raw.tracks[1].parts[0].wav.name).to.equal('a1b2c3d4.wav');
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
