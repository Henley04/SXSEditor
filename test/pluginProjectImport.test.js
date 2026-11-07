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
  it('声明的扩展名与实现的 codec 一一对应', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'plugins', 'official-project-import', 'manifest.json'),
      'utf8',
    ));
    const declared = manifest.contributes.fileTypes.map((ft) => ft.ext).sort();
    expect(declared).to.deep.equal(Object.keys(plugin.codecs).sort());
    for (const ext of declared) expect(plugin.codecs[ext].read).to.be.a('function');
    expect(manifest.author).to.equal('SXSEditor Official');
  });
});
