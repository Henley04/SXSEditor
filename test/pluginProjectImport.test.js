'use strict';
/**
 * 官方导入插件（VOCALOID .vsqx/.vpr、Synthesizer V .svp）的导入链路测试。
 *
 * 这三个样例都是按格式规范构造的最小工程（VPR 是真实的 ZIP + sequence.json
 * 容器），断言的是"源文件里的音符/歌词/音高/速度/拍号确实到了工程文档里"，
 * 而不只是"没抛异常"。宿主校验函数也会跑一遍，确保结果能进编辑器。
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const plugin = require('../plugins/official-project-import/main.js');
const { validateProjectDocument } = require('../src/shared/projectFormat.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'plugin-import');

function makeContext() {
  const notices = [];
  const statuses = [];
  return {
    notices,
    statuses,
    ctx: {
      plugin: { locale: 'zh-CN' },
      log: { info() {}, warn() {}, error() {} },
      ui: {
        async status(id, text) { statuses.push(text); },
        async notify(text, level) { notices.push({ text, level }); },
      },
    },
  };
}

async function readFixture(ext, fileName) {
  const { ctx, notices, statuses } = makeContext();
  const bytes = fs.readFileSync(path.join(FIXTURES, fileName));
  const result = await plugin.codecs[ext].read(ctx, { name: fileName, bytes });
  const validated = validateProjectDocument(result.document);
  expect(validated.ok, validated.error).to.equal(true);
  return { document: validated.document, warnings: result.warnings, notices, statuses };
}

function anchorsOf(fragment) {
  return (fragment.pitchCurve && fragment.pitchCurve.anchorPoints) || [];
}

describe('official-project-import — Synthesizer V (.svp)', () => {
  it('音符、歌词、音高曲线、速度与轨道都映射进工程', async () => {
    const { document, warnings, notices } = await readFixture('.svp', 'sample.svp');

    expect(document.project.bpm).to.equal(100);
    expect(document.project.timeSignature).to.deep.equal([4, 4]);

    expect(document.singers).to.have.length(1);
    expect(document.singers[0].trackName).to.equal('主唱');
    expect(document.singers[0].color.toLowerCase()).to.equal('#3366cc');

    expect(document.fragments).to.have.length(1);
    const fragment = document.fragments[0];
    // 音符组 blickOffset = 1 拍
    expect(fragment.startTime).to.equal(1);
    expect(fragment.duration).to.equal(2);
    expect(fragment.pitchMode).to.equal('manual');
    expect(fragment.notes.map((n) => [n.pitch, n.start, n.duration, n.lyric])).to.deep.equal([
      [60, 0, 1, '啊'],
      [62, 1, 1, '呀'],
    ]);

    const anchors = anchorsOf(fragment);
    const pitchAt = (time) => anchors.find((a) => Math.abs(a.time - time) < 1e-6);
    // 第一个包络点之前偏移为 0，不能把 50 音分平移到分片开头
    expect(pitchAt(0).pitch).to.equal(60);
    // 0.5 拍处用户画了 +50 音分
    expect(pitchAt(0.5).pitch).to.be.closeTo(60.5, 1e-3);
    // 第二个音符（62）叠加同一偏移
    expect(pitchAt(1).pitch).to.be.closeTo(62.5, 1e-3);

    expect(warnings.join('\n')).to.match(/time-signature|拍号/);
    expect(warnings.join('\n')).to.match(/tempo|变速/);
    expect(notices).to.have.length(1);
    expect(notices[0].level).to.equal('warn');
  });
});

describe('official-project-import — VOCALOID4 (.vsqx)', () => {
  it('减掉 preMeasure 偏移，导入速度/拍号/音符/弯音', async () => {
    const { document, warnings } = await readFixture('.vsqx', 'sample.vsqx');

    expect(document.project.bpm).to.equal(90);
    expect(document.project.timeSignature).to.deep.equal([3, 4]);

    expect(document.singers).to.have.length(1);
    expect(document.singers[0].trackName).to.equal('Lead');

    expect(document.fragments).to.have.length(1);
    const fragment = document.fragments[0];
    // part 的 t=1920，preMeasure(1 小节 3/4)=1440 → 起始 1 拍
    expect(fragment.startTime).to.equal(1);
    expect(fragment.name).to.equal('Verse');
    expect(fragment.notes.map((n) => [n.pitch, n.start, n.duration, n.lyric])).to.deep.equal([
      [60, 0, 1, 'la'],
      [64, 1, 1, 'li'],
      [67, 2, 2, 'lu'],
    ]);

    const anchors = anchorsOf(fragment);
    const pitchAt = (time) => anchors.find((a) => Math.abs(a.time - time) < 1e-6);
    expect(pitchAt(0).pitch).to.equal(60);
    // PIT=4096, PBS=2 → +1 半音，落在第二个音符上
    expect(pitchAt(1).pitch).to.be.closeTo(65, 5e-2);
    expect(warnings.join('\n')).to.match(/tempo|变速/);
  });
});

describe('official-project-import — VOCALOID5/6 (.vpr)', () => {
  it('读取 ZIP 内的 Project/sequence.json', async () => {
    const { document, warnings } = await readFixture('.vpr', 'sample.vpr');

    expect(document.project.bpm).to.equal(90);
    expect(document.project.timeSignature).to.deep.equal([4, 4]);

    expect(document.singers).to.have.length(1);
    expect(document.singers[0].trackName).to.equal('Vocal');

    expect(document.fragments).to.have.length(1);
    const fragment = document.fragments[0];
    expect(fragment.startTime).to.equal(0);
    expect(fragment.duration).to.equal(2);
    expect(fragment.notes.map((n) => [n.pitch, n.lyric])).to.deep.equal([
      [60, 'do'],
      [64, 're'],
    ]);

    const anchors = anchorsOf(fragment);
    const pitchAt = (time) => anchors.find((a) => Math.abs(a.time - time) < 1e-6);
    expect(pitchAt(0).pitch).to.equal(60);
    // pitchBend 8191 / PBS 2 → +2 半音
    expect(pitchAt(1).pitch).to.be.closeTo(66, 5e-2);
    expect(warnings.join('\n')).to.match(/tempo|变速/);
  });
});

describe('official-project-import — 错误处理', () => {
  it('字节不是工程时给出可读错误，而不是崩溃', async () => {
    const { ctx } = makeContext();
    for (const ext of ['.vsqx', '.vpr', '.svp']) {
      let error = null;
      try {
        await plugin.codecs[ext].read(ctx, { name: 'broken', bytes: Buffer.from('not a project') });
      } catch (err) {
        error = err;
      }
      expect(error, ext).to.be.ok;
      expect(error.code, ext).to.equal('INVALID_REQUEST');
    }
  });

  it('工程里没有音符时明确报错', async () => {
    const { ctx } = makeContext();
    const empty = JSON.stringify({
      version: 200,
      time: { meter: [{ index: 0, numerator: 4, denominator: 4 }], tempo: [{ position: 0, bpm: 120 }] },
      tracks: [],
      library: [],
    });
    let error = null;
    try {
      await plugin.codecs['.svp'].read(ctx, { name: 'empty.svp', bytes: Buffer.from(empty) });
    } catch (err) {
      error = err;
    }
    expect(error).to.be.ok;
    expect(error.message).to.match(/音符|notes/i);
  });
});

describe('official-project-import — manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'plugins', 'official-project-import', 'manifest.json'),
    'utf8',
  ));
  const declared = manifest.contributes.fileTypes.map((ft) => ft.ext).sort();

  it('声明的扩展名与实现的 codec 一一对应，读与写都实现', () => {
    expect(declared).to.deep.equal(Object.keys(plugin.codecs).sort());
    for (const ext of declared) {
      expect(plugin.codecs[ext].read, `${ext}.read`).to.be.a('function');
      expect(plugin.codecs[ext].write, `${ext}.write`).to.be.a('function');
    }
    expect(manifest.author).to.equal('SXSEditor Official');
  });

  it('三种格式都声明为可打开可保存，并申请写盘权限', () => {
    for (const ft of manifest.contributes.fileTypes) {
      expect(ft.role, `${ft.ext}.role`).to.equal('both');
    }
    expect(manifest.permissions.fs).to.include('userPicked:write');
    expect(manifest.version).to.equal('1.1.0');
  });
});

// ------------------------------------------------------------------ 保存 / 写回

/** 在锚点之间线性插值取音高，用于比较时间网格不完全相同的两条曲线。 */
function pitchAt(fragment, time) {
  const a = anchorsOf(fragment);
  if (!a.length) return null;
  if (time <= a[0].time) return a[0].pitch;
  for (let i = 1; i < a.length; i++) {
    if (time <= a[i].time) {
      const span = a[i].time - a[i - 1].time;
      if (span <= 1e-9) return a[i].pitch;
      return a[i - 1].pitch + ((a[i].pitch - a[i - 1].pitch) * (time - a[i - 1].time)) / span;
    }
  }
  return a[a.length - 1].pitch;
}

function notesOf(document) {
  return document.fragments.map((f) => f.notes.map((n) => [n.pitch, n.start, n.duration, n.lyric]));
}

async function roundTrip(ext, fileName) {
  const { ctx } = makeContext();
  const bytes = fs.readFileSync(path.join(FIXTURES, fileName));

  const first = await plugin.codecs[ext].read(ctx, { name: fileName, bytes });
  const validated = validateProjectDocument(first.document);
  expect(validated.ok, validated.error).to.equal(true);

  const saved = await plugin.codecs[ext].write(ctx, {
    name: `round${ext}`, document: validated.document,
  });
  const out = Buffer.isBuffer(saved.bytes) ? saved.bytes : Buffer.from(saved.bytes);
  expect(out.length, `${ext} 写回字节`).to.be.greaterThan(0);

  const second = await plugin.codecs[ext].read(ctx, { name: `round${ext}`, bytes: out });
  const restored = validateProjectDocument(second.document);
  expect(restored.ok, restored.error).to.equal(true);

  return { original: validated.document, restored: restored.document, warnings: saved.warnings, bytes: out };
}

describe('official-project-import — 三种格式 read → write → read', () => {
  const cases = [
    ['.svp', 'sample.svp', 'Synthesizer V'],
    ['.vsqx', 'sample.vsqx', 'VOCALOID4'],
    ['.vpr', 'sample.vpr', 'VOCALOID5/6'],
  ];

  for (const [ext, file, label] of cases) {
    it(`${label}：音符、速度、拍号与音高曲线在写回后保持一致`, async () => {
      const { original, restored, warnings } = await roundTrip(ext, file);

      expect(restored.project.bpm).to.equal(original.project.bpm);
      expect(restored.project.timeSignature).to.deep.equal(original.project.timeSignature);
      expect(restored.singers).to.have.length(original.singers.length);
      expect(restored.fragments).to.have.length(original.fragments.length);
      expect(notesOf(restored)).to.deep.equal(notesOf(original));

      for (let i = 0; i < original.fragments.length; i++) {
        const a = original.fragments[i];
        const b = restored.fragments[i];
        expect(anchorsOf(b), `${ext} 锚点数`).to.have.length(anchorsOf(a).length);
        const end = Math.max(a.duration, b.duration);
        for (let t = 0; t <= end + 1e-9; t += 0.25) {
          const pa = pitchAt(a, t);
          const pb = pitchAt(b, t);
          if (pa === null || pb === null) continue;
          expect(pb, `${ext} t=${t}`).to.be.closeTo(pa, 0.1);
        }
      }

      // 有损写回必须显式告警，而不是悄悄丢字段。
      expect(warnings.join('\n')).to.match(/有损|lossy/i);
      expect(warnings.join('\n')).to.match(/另存为|native/i);
    });
  }

  it('写回产物是对应容器，能被再次解析（不是空壳）', async () => {
    const vpr = await roundTrip('.vpr', 'sample.vpr');
    expect(vpr.bytes.slice(0, 2).toString()).to.equal('PK');
    const vsqx = await roundTrip('.vsqx', 'sample.vsqx');
    expect(vsqx.bytes.toString('utf8')).to.match(/^\s*<\?xml/);
  });
});

/**
 * 三种格式的歌词都经过 lib/score.js 的 safeLyric → importLyric / exportLyric，
 * 是同一条共用映射。这里先用纯函数锁定双向语义（含 <SP> 静音不受影响），
 * 再用 SVP 走一遍真实的"字节 → 文档 → 字节"，证明转译落到了编解码链路上。
 */
describe('official-project-import — 呼吸标记 br ↔ 宿主吸气音素', () => {
  const score = require('../plugins/official-project-import/lib/score.js');

  it('转译双向对称，且不把 <SP> 静音当成吸气', () => {
    expect(score.importLyric('br')).to.equal('<AP>');
    expect(score.importLyric('BR')).to.equal('<AP>');
    expect(score.importLyric(' br ')).to.equal('<AP>');
    expect(score.importLyric('<SP>')).to.equal('<SP>');
    expect(score.importLyric('la')).to.equal('la');
    expect(score.exportLyric('<AP>')).to.equal('br');
    expect(score.exportLyric('<ap>')).to.equal('br');
    expect(score.exportLyric('<SP>')).to.equal('<SP>');
    expect(score.exportLyric('la')).to.equal('la');
  });

  it('SVP 里 br 导入为 <AP>，写回仍是 br', async () => {
    const { ctx } = makeContext();
    const svp = {
      version: 200,
      time: {
        meter: [{ index: 0, numerator: 4, denominator: 4 }],
        tempo: [{ position: 0, bpm: 120 }],
      },
      library: [],
      tracks: [{
        name: 'Breath',
        mainRef: { groupID: 'g1', blickOffset: 0 },
        mainGroup: {
          name: 'main', uuid: 'g1',
          notes: [
            { onset: 0, duration: 705600000, pitch: 60, lyrics: 'a' },
            { onset: 705600000, duration: 705600000, pitch: 60, lyrics: 'br' },
          ],
        },
        groups: [],
      }],
    };
    const read = await plugin.codecs['.svp'].read(ctx, {
      name: 'breath.svp', bytes: Buffer.from(JSON.stringify(svp)),
    });
    const doc = validateProjectDocument(read.document);
    expect(doc.ok, doc.error).to.equal(true);
    expect(doc.document.fragments[0].notes.map((n) => n.lyric)).to.deep.equal(['a', '<AP>']);

    const saved = await plugin.codecs['.svp'].write(ctx, {
      name: 'breath.svp', document: doc.document,
    });
    const out = JSON.parse(Buffer.from(saved.bytes).toString('utf8'));
    expect(out.tracks[0].mainGroup.notes.map((n) => n.lyrics)).to.deep.equal(['a', 'br']);
  });
});
