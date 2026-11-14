'use strict';
/**
 * official-project-import —— .svp 的 SV1 / SV2 双世代版本行为。
 *
 * 用户要求：SV1 与 SV2 都是 .svp，但 schema 互不兼容；不能凭空造一个新格式，
 * 而要在 .svp 上「按源 JSON 的版本号行为保存」，另存为 .svp 时才询问按哪个
 * 版本行为写。这里锁住四件事：
 *   ① 世代靠结构特征探测（version 数字不参与）——历史样本 version:200 是纯 SV1；
 *   ② SV2 专有参数 read → write(keep) → read 不丢键（结构化保真回写）；
 *   ③ 三档另存为的 version 值与 schema 世代分派正确；
 *   ④ SV2→SV1 降级逐类告警、容器 NUL 按源保真、升级不伪造专有参数。
 *
 * 样本依据：Dreamtonics 官方手册「另存为（与 1.10.0 兼容）」、LibreSVIP 的
 * SVProject schema / 版本兼容枚举、公开的 SV1 v153 / SV2 v196 格式考据构造。
 * **不是**真实商业 SV2 工程样本，测试也不伪称用了真实工程验证。
 */

const { expect } = require('chai');

const plugin = require('../plugins/official-project-import/main.js');
const schema = require('../plugins/official-project-import/lib/svpSchema.js');
const { validateProjectDocument } = require('../src/shared/projectFormat.js');

const BLICK = 705600000;

function makeContext(locale = 'zh-CN') {
  const notices = [];
  return {
    notices,
    ctx: {
      plugin: { locale },
      log: { info() {}, warn() {}, error() {} },
      ui: {
        async status() {},
        async notify(text, level) { notices.push({ text, level }); },
      },
    },
  };
}

/** 纯 SV1 骨架：version 数字故意用 200，验证「不看数字判世代」。 */
function makeSv1(overrides = {}) {
  return {
    version: 200,
    instantMode: true,
    time: {
      meter: [{ index: 0, numerator: 4, denominator: 4 }],
      tempo: [{ position: 0, bpm: 120 }],
    },
    library: [],
    tracks: [{
      name: 'SV1 Lead',
      dispColor: 'ff3366cc',
      dispOrder: 0,
      renderEnabled: true,
      mainRef: { groupID: 'g1', blickOffset: 0, pitchOffset: 0, isInstrumental: false },
      mainGroup: {
        name: 'main', uuid: 'g1',
        parameters: {
          pitchDelta: { mode: 'cubic', points: [0, 0, BLICK, 50] },
          vibratoEnv: { mode: 'cubic', points: [0, 1] },
        },
        notes: [
          { onset: 0, duration: BLICK, pitch: 60, lyrics: 'a', instantMode: false,
            attributes: { dur: [1, 1], dF0Vbr: 1.0, pF0Vbr: 0.4 } },
          { onset: BLICK, duration: BLICK, pitch: 62, lyrics: 'i' },
        ],
      },
      groups: [],
    }],
    ...overrides,
  };
}

/** 依据官方手册 + LibreSVIP schema + SV2 考据构造的完整 SV2 工程。 */
function makeSv2(overrides = {}) {
  return {
    version: 196,
    instantModeEnabled: false,
    projectMixer: { gainDecibel: 0, pan: 0, mute: false },
    renderConfig: { aspiration: 0.5 },
    time: {
      meter: [{ index: 0, numerator: 4, denominator: 4 }],
      tempo: [{ position: 0, bpm: 120 }],
    },
    // 未被任何 track 引用的库组：宿主不导入，写回必须连 notes / parameters 一起保真。
    library: [{
      name: 'unused', uuid: 'lib-unused',
      parameters: { mouthOpening: { mode: 'cubic', points: [0, 0.2] } },
      notes: [{ onset: 0, duration: BLICK, pitch: 60, lyrics: 'x', uuid: 'lib-note-1' }],
    }],
    tracks: [{
      name: 'SV2 Lead',
      dispColor: 'ff3366cc',
      dispOrder: 0,
      renderEnabled: true,
      mixer: {
        gainDecibel: -3, pan: 0, mute: false, solo: false, display: true,
        fxPresetName: 'Default', fxParams: { reverb: 0.3 },
      },
      mainRef: {
        groupID: 'g-main', blickOffset: 0, pitchOffset: 0, isInstrumental: false,
        uuid: 'ref-main-uuid', takes: [{ id: 'ref-take' }],
      },
      mainGroup: {
        name: 'main', uuid: 'g-main',
        vocalModes: [{ id: 'mode-1', strength: 0.7 }],
        musicalScale: { key: 'C', scale: 'major' },
        pitchControls: [{
          type: 'curve', id: 'pc-1', pos: 0, pitch: 60,
          points: [0, 0, BLICK / 2, 50],
        }],
        parameters: {
          mouthOpening: { mode: 'cubic', points: [0, 0.5] },
          toneShift: { mode: 'cubic', points: [0, 0] },
        },
        notes: [
          {
            onset: 0, duration: BLICK, pitch: 60, lyrics: 'a',
            uuid: 'note-uuid-1',
            takes: [{ id: 't1', seed: 42 }],
            systemAttributes: { foo: 'bar' },
            attributes: {
              phonemes: [{ symbol: 'a', leftOffset: -0.05 }],
              dur: [1.0],
              dF0Vbr: 1.0, pF0Vbr: 0.4, tF0VbrRight: 0.2,
            },
          },
          {
            onset: BLICK, duration: BLICK, pitch: 62, lyrics: 'i',
            uuid: 'note-uuid-2',
            attributes: { phonemes: [{ symbol: 'i', leftOffset: 0 }] },
          },
        ],
      },
      groups: [],
    }],
    ...overrides,
  };
}

function toBytes(raw, trailingNul = false) {
  return Buffer.from(JSON.stringify(raw, null, 2) + (trailingNul ? '\u0000' : ''), 'utf8');
}

/** 解析写回字节（兼容带尾 NUL 的容器），不做 JSON.parse 直读的假设。 */
function parseOut(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  return JSON.parse(text.split('\u0000').find((c) => c.trim()));
}

async function readSvp(bytes) {
  const { ctx, notices } = makeContext();
  const result = await plugin.codecs['.svp'].read(ctx, { name: 'in.svp', bytes });
  const validated = validateProjectDocument(result.document);
  expect(validated.ok, validated.error).to.equal(true);
  return { document: validated.document, warnings: result.warnings, notices };
}

async function writeSvp(document, svpVersion) {
  const { ctx } = makeContext();
  return plugin.codecs['.svp'].write(ctx, { name: 'out.svp', document, svpVersion });
}

// ------------------------------------------------------------------ 纯函数层

describe('svpSchema — 世代探测（结构特征，不看 version 数字）', () => {
  it('version:200 但纯 SV1 骨架仍判 SV1，sourceVersion 原值保留', () => {
    const gen = schema.detectGeneration(makeSv1(), toBytes(makeSv1()));
    expect(gen.generation).to.equal('sv1');
    expect(gen.sourceVersion).to.equal(200);
    expect(gen.markers).to.deep.equal([]);
    expect(gen.trailingNul).to.equal(false);
    expect(gen.chunkCount).to.equal(1);
  });

  it('SV2 特征字段命中即判 SV2，标记覆盖各层级', () => {
    const raw = makeSv2();
    const gen = schema.detectGeneration(raw, toBytes(raw));
    expect(gen.generation).to.equal('sv2');
    expect(gen.sourceVersion).to.equal(196);
    for (const marker of [
      'root.projectMixer', 'group.pitchControls', 'group.vocalModes', 'group.musicalScale',
      'parameters.mouthOpening', 'parameters.toneShift', 'note.uuid', 'note.takes',
      'note.systemAttributes', 'attributes.phonemes.leftOffset', 'ref.uuid', 'ref.takes',
      'mixer.fxPresetName', 'mixer.fxParams',
    ]) {
      expect(gen.markers, marker).to.include(marker);
    }
  });

  it('NUL 是串联份数机制，不是世代标志', () => {
    const raw = makeSv1();
    const gen = schema.detectGeneration(raw, toBytes(raw, true));
    expect(gen.generation).to.equal('sv1');
    expect(gen.trailingNul).to.equal(true);
    expect(gen.chunkCount).to.equal(1);

    const chained = Buffer.concat([toBytes(raw), Buffer.from('\u0000'), toBytes(raw)]);
    expect(schema.detectGeneration(raw, chained).chunkCount).to.equal(2);
  });

  it('cloneBounded 深克隆嵌套对象、过滤危险键并保持数组长度', () => {
    const evil = JSON.parse('{"a":{"b":[1,2,3]},"__proto__":{"polluted":true}}');
    const r = schema.cloneBounded(evil);
    expect(r.value.a.b).to.deep.equal([1, 2, 3]);
    // 不能写 r.value.__proto__ === undefined：普通对象的原型链上本来就有它，
    // 要断言的是「没有把危险键写成自有属性」。
    expect(Object.prototype.hasOwnProperty.call(r.value, '__proto__')).to.equal(false);
    expect(r.truncated).to.equal(false);
    const arr = schema.cloneBounded([1, { x: 2 }, 3]);
    expect(arr.value).to.have.length(3);
  });
});

describe('svpSchema — 写回决策与降级损失分类', () => {
  const meta = {
    generation: 'sv2', sourceVersion: 196, trailingNul: false,
    sv2Markers: schema.detectGeneration(makeSv2()).markers,
    rootExtras: { projectMixer: {}, renderConfig: {}, instantModeEnabled: false },
  };

  it('keep 沿用源世代与 version 原值；sv2 / sv1 写兼容目标值', () => {
    expect(schema.resolveWriteTarget(meta, 'keep')).to.include({ generation: 'sv2', version: 196, requested: 'keep' });
    expect(schema.resolveWriteTarget(meta, 'sv2')).to.include({ generation: 'sv2', version: 182, isDowngrade: false });
    const down = schema.resolveWriteTarget(meta, 'sv1');
    expect(down).to.include({ generation: 'sv1', version: 135, isDowngrade: true });
    expect(down.losses.length).to.be.greaterThan(0);
  });

  it('非法 svpVersion 归一为 keep，不注入', () => {
    expect(schema.resolveWriteTarget(meta, '__proto__').requested).to.equal('keep');
    expect(schema.resolveWriteTarget(meta, 'sv9').version).to.equal(196);
  });

  it('降级损失只列源工程实际出现的类别', () => {
    const losses = schema.downgradeLosses(meta).map((l) => l.zh).join('\n');
    for (const keyword of ['音高表达板', 'take', 'vocal modes', '口型', 'UUID', '音素时序', '效果器', '顶层 SV2 字段']) {
      expect(losses, keyword).to.match(new RegExp(keyword));
    }
    expect(schema.downgradeLosses({ generation: 'sv1', sv2Markers: [], rootExtras: {} })).to.deep.equal([]);
  });

  it('SV1 目标世代的快照过滤会摘掉 SV2 专有键', () => {
    const snap = schema.stripForGeneration({
      rootExtras: { projectMixer: {}, renderConfig: {}, keepMe: 1 },
      tracks: [{ scalars: { name: 'T' }, mixer: { fxParams: {}, gainDecibel: -3 },
        mainRef: { uuid: 'r', groupID: 'g' }, groupRefs: [{ uuid: 'r2' }] }],
      groups: [[{ saved: { pitchControls: [] }, parameterExtras: { mouthOpening: {} },
        noteExtras: [{ uuid: 'n', attributes: { phonemes: [], dur: [1] }, instantMode: false }] }]],
      libraryExtras: [{ saved: { uuid: 'lib' }, parameters: { toneShift: {} },
        notes: [{ uuid: 'ln', attributes: { phonemes: [] } }] }],
    }, 'sv1');
    expect(snap.rootExtras).to.deep.equal({ keepMe: 1 });
    expect(snap.tracks[0].mixer).to.not.have.property('fxParams');
    expect(snap.tracks[0].mainRef).to.not.have.property('uuid');
    expect(snap.groups[0][0].saved).to.not.have.property('pitchControls');
    expect(snap.groups[0][0].parameterExtras).to.not.have.property('mouthOpening');
    expect(snap.groups[0][0].noteExtras[0]).to.not.have.property('uuid');
    expect(snap.groups[0][0].noteExtras[0].attributes).to.not.have.property('phonemes');
    expect(snap.groups[0][0].noteExtras[0].attributes).to.have.property('dur');
    expect(snap.libraryExtras[0].parameters).to.not.have.property('toneShift');
    expect(snap.libraryExtras[0].notes[0]).to.not.have.property('uuid');
  });
});

describe('svpSchema — pitchControls ↔ 宿主曲线（有损换算）', () => {
  it('分段绝对音高折叠为相对半音，并标记 lossy', () => {
    const group = {
      pitchControls: [{ pos: 0, pitch: 60, points: [0, 0, BLICK / 2, 50] }],
    };
    const notes = [{ startBeat: 0, pitch: 60 }, { startBeat: 1, pitch: 62 }];
    const r = schema.parsePitchControls(group, { blickOffset: 0, pitchOffset: 0 },
      notes, BLICK, (v) => Math.round(v * 480) / 480);
    expect(r.segments).to.equal(1);
    expect(r.lossy).to.equal(true);
    expect(r.offsets[0]).to.deep.include({ beat: 0, semitones: 0 });
    expect(r.offsets[1]).to.deep.include({ beat: 0.5, semitones: 50 });
  });

  it('宿主曲线重建为 SV2 一段 curve，绝对拍换算不错位', () => {
    const part = {
      startBeat: 1,
      notes: [{ startBeat: 1, pitch: 60 }, { startBeat: 2, pitch: 62 }],
      pitchOffsets: [{ beat: 1, semitones: 0 }, { beat: 1.5, semitones: 0.5 }],
    };
    const pcs = schema.buildPitchControls(part, BLICK, (v) => v);
    expect(pcs).to.have.length(1);
    expect(pcs[0]).to.include({ type: 'curve', pos: 0, pitch: 60 });
    expect(pcs[0].points[0]).to.deep.equal({ offset: 0, value: 0 });
    expect(pcs[0].points[1]).to.deep.equal({ offset: BLICK / 2, value: 0.5 });
  });
});

// ------------------------------------------------------------------ 端到端链路

describe('official-project-import — .svp SV2 结构化保真回写', () => {
  it('read → write(keep) → read：SV2 专有字段全不丢，version 原值 196 回写', async () => {
    const raw = makeSv2();
    const { document, warnings } = await readSvp(toBytes(raw));
    // 导入侧必须如实告知「有损折叠」与「专有参数结构化保真」，不静默吞掉。
    expect(warnings.join('\n')).to.match(/音高表达板|pitch control/i);
    expect(warnings.join('\n')).to.match(/SV2 工程|SV2 project/i);

    const saved = await writeSvp(document, 'keep');
    const out = parseOut(saved.bytes);
    expect(out.version).to.equal(196);
    // 顶层 / 混音器
    expect(out.projectMixer).to.deep.equal(raw.projectMixer);
    expect(out.instantModeEnabled).to.equal(false);
    expect(out.renderConfig).to.deep.equal(raw.renderConfig);
    const track = out.tracks[0];
    expect(track.mixer.fxPresetName).to.equal('Default');
    expect(track.mixer.fxParams).to.deep.equal({ reverb: 0.3 });
    expect(track.mainRef.uuid).to.equal('ref-main-uuid');
    expect(track.mainRef.takes).to.deep.equal([{ id: 'ref-take' }]);
    // group 级
    const group = track.mainGroup;
    expect(group.vocalModes).to.deep.equal(raw.tracks[0].mainGroup.vocalModes);
    expect(group.musicalScale).to.deep.equal(raw.tracks[0].mainGroup.musicalScale);
    expect(group.pitchControls).to.be.an('array').with.length.greaterThan(0);
    expect(group.parameters.mouthOpening).to.deep.equal({ mode: 'cubic', points: [0, 0.5] });
    expect(group.parameters.toneShift).to.deep.equal({ mode: 'cubic', points: [0, 0] });
    expect(group.parameters).to.not.have.property('pitchDelta'); // SV2 不写 pitchDelta
    // note 级
    const note = group.notes[0];
    expect(note.uuid).to.equal('note-uuid-1');
    expect(note.takes).to.deep.equal([{ id: 't1', seed: 42 }]);
    expect(note.systemAttributes).to.deep.equal({ foo: 'bar' });
    expect(note.attributes.phonemes).to.deep.equal([{ symbol: 'a', leftOffset: -0.05 }]);
    expect(note.attributes.dur).to.deep.equal([1.0]);
    expect(note.attributes.pF0Vbr).to.equal(0.4);
    expect(note.attributes.tF0VbrRight).to.equal(0.2);
    expect(group.notes[1].uuid).to.equal('note-uuid-2');
    expect(group.notes[1].attributes.phonemes).to.deep.equal([{ symbol: 'i', leftOffset: 0 }]);
    // 未被导入的库组整块回写，不能变成 notes:[] 的空壳
    const lib = out.library.find((g) => g.uuid === 'lib-unused');
    expect(lib, '未引用库组应保留').to.exist;
    expect(lib.notes).to.deep.equal(raw.library[0].notes);
    expect(lib.parameters).to.deep.equal(raw.library[0].parameters);

    // 再读一遍：音符与歌词仍一致，版本行为仍是 SV2
    const again = await readSvp(saved.bytes);
    expect(again.document.fragments[0].notes.map((n) => [n.pitch, n.lyric])).to.deep.equal([
      [60, 'a'], [62, 'i'],
    ]);
  });

  it('三档另存为：keep=源值、sv2=182、sv1=135（兼容目标值）', async () => {
    const { document } = await readSvp(toBytes(makeSv2()));
    expect(parseOut((await writeSvp(document, 'keep')).bytes).version).to.equal(196);
    const asSv2 = parseOut((await writeSvp(document, 'sv2')).bytes);
    expect(asSv2.version).to.equal(182);
    expect(asSv2.tracks[0].mainGroup.notes[0].uuid).to.equal('note-uuid-1');
    const asSv1 = parseOut((await writeSvp(document, 'sv1')).bytes);
    expect(asSv1.version).to.equal(135);
    expect(asSv1.tracks[0].mainGroup).to.not.have.property('pitchControls');
  });

  it('SV2 → SV1 降级：逐类告警，且产物摘掉 SV2 专有键', async () => {
    const { document } = await readSvp(toBytes(makeSv2()));
    const saved = await writeSvp(document, 'sv1');
    const out = parseOut(saved.bytes);
    const text = saved.warnings.join('\n');
    for (const keyword of ['降级', '音高表达板', 'take', 'vocal modes', '口型', 'UUID', '音素时序', '效果器']) {
      expect(text, keyword).to.match(new RegExp(keyword));
    }
    expect(text).to.match(/version 写为 135|version 135|兼容目标值/);
    expect(out.tracks[0].mainGroup).to.not.have.property('pitchControls');
    expect(out.tracks[0].mainGroup).to.not.have.property('vocalModes');
    expect(out.tracks[0].mainGroup.parameters).to.not.have.property('mouthOpening');
    expect(out.tracks[0].mainGroup.parameters).to.have.property('pitchDelta'); // SV1 相对曲线
    expect(out.tracks[0].mainGroup.notes[0]).to.not.have.property('uuid');
    expect(out.tracks[0].mainGroup.notes[0]).to.not.have.property('takes');
    expect(out.tracks[0].mainGroup.notes[0].attributes || {}).to.not.have.property('phonemes');
    expect(out.tracks[0].mainRef).to.not.have.property('uuid');
    expect(out.tracks[0].mixer).to.not.have.property('fxParams');
    expect(out).to.not.have.property('projectMixer');
  });

  it('SV1 → SV2 升级：补结构性 UUID、不伪造专有参数，并显式告警', async () => {
    const { document } = await readSvp(toBytes(makeSv1()));
    const saved = await writeSvp(document, 'sv2');
    const out = parseOut(saved.bytes);
    expect(out.version).to.equal(182);
    expect(out.tracks[0].mainGroup.notes[0].uuid).to.be.a('string');
    expect(out.tracks[0].mainRef.uuid).to.be.a('string');
    expect(out.tracks[0].mainGroup).to.not.have.property('pitchDelta');
    expect(out.tracks[0].mainGroup).to.not.have.property('vocalModes');
    expect(out.tracks[0].mainGroup.parameters).to.not.have.property('mouthOpening');
    expect(saved.warnings.join('\n')).to.match(/升级为 SV2|upgrading to SV2/i);
    // 源 SV1 的字段仍保留（instantMode / dur / vibratoEnv）
    expect(out.tracks[0].mainGroup.notes[0].instantMode).to.equal(false);
    expect(out.tracks[0].mainGroup.notes[0].attributes.dur).to.deep.equal([1, 1]);
    expect(out.tracks[0].mainGroup.parameters.vibratoEnv).to.deep.equal({ mode: 'cubic', points: [0, 1] });
  });

  it('就地 Ctrl+S 不传 svpVersion 时默认 keep，源 version 与源 schema 都不变', async () => {
    const { document } = await readSvp(toBytes(makeSv2()));
    const saved = await writeSvp(document, undefined);
    const out = parseOut(saved.bytes);
    expect(out.version).to.equal(196);
    expect(out.tracks[0].mainGroup.notes[0].uuid).to.equal('note-uuid-1');
    expect(saved.warnings.join('\n')).to.match(/按源工程版本行为保存|source project's version behaviour/);
  });

  it('容器 NUL 按源保真：源有则写、源无则纯 JSON（不主动 append 伪造历史）', async () => {
    const withNul = makeSv1();
    const a = await readSvp(toBytes(withNul, true));
    const savedA = await writeSvp(a.document, 'keep');
    expect(Buffer.from(savedA.bytes).toString('utf8').endsWith('\u0000')).to.equal(true);
    expect(parseOut(savedA.bytes).version).to.equal(200);
    // 带 NUL 的产物仍能被插件读回（pickProject 按 NUL 切分）
    expect((await readSvp(savedA.bytes)).document.fragments).to.have.length(1);

    const b = await readSvp(toBytes(makeSv1(), false));
    const savedB = await writeSvp(b.document, 'keep');
    const text = Buffer.from(savedB.bytes).toString('utf8');
    expect(text.includes('\u0000')).to.equal(false);
    expect(() => JSON.parse(text)).to.not.throw();
  });

  it('SV1 骨架就地保存仍沿用 version:200，且 SV2 特征不会凭空出现', async () => {
    const { document } = await readSvp(toBytes(makeSv1()));
    const out = parseOut((await writeSvp(document, 'keep')).bytes);
    expect(out.version).to.equal(200);
    expect(out.tracks[0].mainGroup.notes[0]).to.not.have.property('uuid');
    expect(out.tracks[0].mainGroup.parameters.pitchDelta).to.have.property('points');
    expect(out.instantMode).to.equal(true);
  });
});
