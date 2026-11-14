const { expect } = require('chai');

const {
  normalizeExtSchema,
  normalizeExtData,
  summarizeExt,
  fieldsFor,
  findField,
  EXT_LIMITS,
} = require('../src/shared/pluginExt.js');
const { validateProjectDocument } = require('../src/shared/projectFormat.js');

/**
 * 扩展域（ext）。
 *
 * 这层的关键不是"校验得多严"，而是**声明与数据分开**：声明决定界面上长什么样、
 * 能不能改、参不参与渲染；数据只是被搬运。所以断言分成两组：
 *   · 声明里宿主不认识的东西必须被丢掉（否则渲染层要处理无穷多种方言）；
 *   · 数据里宿主不需要理解的东西必须被原样留下（否则用户丢数据）。
 */
describe('pluginExt — extSchema 归一化', () => {
  it('保留合法的字段声明与渲染声明', () => {
    const warnings = [];
    const schema = normalizeExtSchema({
      'com.example.demo': {
        note: {
          phonemes: { kind: 'phonemes', editable: false, maxLength: 64 },
          tension: { kind: 'number', min: 0, max: 1, step: 0.01, unit: '', digits: 2 },
        },
        fragment: { style: { kind: 'enum', options: ['soft', 'power'], editable: true } },
        render: { hook: 'postWaveform', order: 20 },
        curve: { interp: 'step', quantize: 1, clamp: [0, 127] },
      },
    }, warnings);

    expect(warnings).to.deep.equal([]);
    const entry = schema['com.example.demo'];
    expect(entry.note.phonemes.kind).to.equal('phonemes');
    expect(entry.note.phonemes.editable).to.equal(false);
    expect(entry.note.tension.max).to.equal(1);
    expect(entry.fragment.style.options).to.deep.equal(['soft', 'power']);
    expect(entry.render).to.deep.equal({ hook: 'postWaveform', order: 20 });
    expect(entry.curve).to.deep.equal({ interp: 'step', quantize: 1, clamp: [0, 127] });
  });

  it('丢弃宿主不认识的 kind，但不影响同一条目的其它字段', () => {
    const warnings = [];
    const schema = normalizeExtSchema({
      'a.b': {
        note: {
          weird: { kind: 'hologram' },
          ok: { kind: 'text' },
        },
      },
    }, warnings);

    expect(schema['a.b'].note).to.not.have.property('weird');
    expect(schema['a.b'].note.ok.kind).to.equal('text');
    expect(warnings.join()).to.match(/hologram/);
  });

  it('enum 缺少 options 视为无效', () => {
    const warnings = [];
    const schema = normalizeExtSchema({
      'a.b': { note: { mode: { kind: 'enum', options: [] } } },
    }, warnings);
    expect(schema).to.deep.equal({});
    expect(warnings.join()).to.match(/enum/);
  });

  it('非法插件 id 与非法 render 被跳过', () => {
    const warnings = [];
    const schema = normalizeExtSchema({
      '__proto__': { note: { a: { kind: 'text' } } },
      'has space': { note: { a: { kind: 'text' } } },
      'ok.id': { render: { hook: 123 } },
    }, warnings);

    expect(Object.keys(schema)).to.deep.equal([]);
    expect(warnings.join()).to.match(/不是合法插件 id/);
    expect(warnings.join()).to.match(/render/);
  });

  it('未知的 curve.interp 退化为 linear 并告警', () => {
    const warnings = [];
    const schema = normalizeExtSchema({ 'a.b': { curve: { interp: 'bezier' } } }, warnings);
    expect(schema['a.b'].curve.interp).to.equal('linear');
    expect(warnings.join()).to.match(/bezier/);
  });

  it('non-object 输入不抛错', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(normalizeExtSchema(bad, [])).to.deep.equal({});
    }
  });
});

describe('pluginExt — ext 数据归一化', () => {
  it('保留宿主看不懂的结构（这是它存在的理由）', () => {
    const payload = {
      phonemes: ['tS', 'a'],
      nested: { deep: [{ x: 1 }, { y: [1, 2, 3] }] },
      flag: true,
      nothing: null,
    };
    const out = normalizeExtData({ 'a.b': payload }, []);
    expect(out['a.b']).to.deep.equal(payload);
  });

  it('丢弃函数 / TypedArray / 危险键', () => {
    const warnings = [];
    // __proto__ 必须经 JSON.parse 才会成为自有键 —— 对象字面量里的 `__proto__:`
    // 改的是原型链，压根不会出现在 Object.keys 里。
    const raw = JSON.parse('{"a.b":{"fn":1,"keep":"yes","__proto__":{"polluted":true}}}');
    raw['a.b'].typed = new Uint8Array([1, 2, 3]);
    raw['a.b'].fn = () => 1;
    const out = normalizeExtData(raw, warnings);

    expect(out['a.b']).to.deep.equal({ keep: 'yes' });
    expect({}.polluted).to.equal(undefined);
    expect(warnings.join()).to.match(/__proto__/);
  });

  it('单条超过上限被丢弃，其余保留', () => {
    const warnings = [];
    const huge = 'x'.repeat(EXT_LIMITS.entryBytes + 10);
    const out = normalizeExtData({ 'a.big': { blob: huge }, 'a.small': { ok: 1 } }, warnings);

    expect(out).to.not.have.property('a.big');
    expect(out['a.small']).to.deep.equal({ ok: 1 });
    expect(warnings.join()).to.match(/超过/);
  });

  it('超过插件数上限时只保留前面的', () => {
    const warnings = [];
    const raw = {};
    for (let i = 0; i < EXT_LIMITS.plugins + 3; i++) raw[`p${i}`] = { i };
    const out = normalizeExtData(raw, warnings);
    expect(Object.keys(out).length).to.equal(EXT_LIMITS.plugins);
    expect(warnings.join()).to.match(/超过/);
  });
});

describe('projectFormat — ext 进入文档', () => {
  const base = () => ({
    project: { bpm: 100, timeSignature: [4, 4] },
    singers: [{ id: 's1', trackName: 'T' }],
    fragments: [{ id: 'f1', singerId: 's1', notes: [{ pitch: 60, start: 0, duration: 1, lyric: 'la' }] }],
  });

  it('四层都能带 ext，空 ext 被删掉', () => {
    const raw = base();
    raw.ext = { 'a.b': { title: 'root' } };
    raw.extSchema = { 'a.b': { note: { phonemes: { kind: 'phonemes' } } } };
    raw.singers[0].ext = { 'a.b': { voice: 'v1' } };
    raw.fragments[0].ext = { 'a.b': { style: 'soft' } };
    raw.fragments[0].notes[0].ext = { 'a.b': { phonemes: ['tS', 'a'] } };
    raw.fragments[0].notes.push({ pitch: 62, start: 1, duration: 1, lyric: 'a', ext: {} });

    const r = validateProjectDocument(raw);
    expect(r.ok).to.equal(true);
    expect(r.document.ext).to.deep.equal({ 'a.b': { title: 'root' } });
    expect(r.document.extSchema['a.b'].note.phonemes.kind).to.equal('phonemes');
    expect(r.document.singers[0].ext['a.b'].voice).to.equal('v1');
    expect(r.document.fragments[0].ext['a.b'].style).to.equal('soft');
    expect(r.document.fragments[0].notes[0].ext['a.b'].phonemes).to.deep.equal(['tS', 'a']);
    // 空 ext 不留空壳
    expect(r.document.fragments[0].notes[1]).to.not.have.property('ext');
  });

  it('汇报扩展数据的规模，供保存时提示', () => {
    const raw = base();
    raw.fragments[0].notes[0].ext = { 'a.b': { phonemes: ['x'] } };
    const r = validateProjectDocument(raw);
    expect(r.extStats.plugins).to.deep.equal(['a.b']);
    expect(r.extStats.notes).to.equal(1);
    expect(r.extStats.bytes).to.be.greaterThan(0);
    expect(r.extStats.truncated).to.equal(false);
  });

  it('单条超限的数据被丢弃但工程仍能打开', () => {
    const raw = base();
    raw.fragments[0].notes[0].ext = { 'a.b': { blob: 'y'.repeat(EXT_LIMITS.entryBytes + 10) } };
    const r = validateProjectDocument(raw);
    expect(r.ok).to.equal(true);
    expect(r.document.fragments[0].notes[0]).to.not.have.property('ext');
    expect(r.warnings.join()).to.match(/超过/);
  });
});

describe('pluginExt — fieldsFor', () => {
  it('按插件与层取字段表', () => {
    const schema = { 'a.b': { note: { phonemes: { kind: 'phonemes' } } } };
    expect(fieldsFor(schema, 'a.b', 'note')).to.have.property('phonemes');
    expect(fieldsFor(schema, 'a.b', 'fragment')).to.deep.equal({});
    expect(fieldsFor(schema, 'nope', 'note')).to.deep.equal({});
    expect(fieldsFor(null, 'a.b', 'note')).to.deep.equal({});
  });
});

describe('pluginExt — summarizeExt', () => {
  it('统计各层与音符数', () => {
    const doc = {
      ext: { a: { x: 1 } },
      singers: [{ ext: { a: { y: 2 } } }],
      fragments: [
        { ext: { a: { z: 3 } }, notes: [{ ext: { a: { n: 1 } } }, {}, { ext: { b: { n: 2 } } }] },
      ],
    };
    const s = summarizeExt(doc);
    expect(s.plugins.sort()).to.deep.equal(['a', 'b']);
    expect(s.notes).to.equal(2);
    expect(s.bytes).to.be.greaterThan(0);
  });
});

describe('pluginExt — findField', () => {
  const schema = {
    'a.b': {
      note: {
        phonemes: { kind: 'phonemes', editable: false },
        label: { kind: 'text', editable: true },
      },
    },
  };

  it('按 kind 反查到具体值，并带出可编辑性', () => {
    const note = { ext: { 'a.b': { phonemes: ['tS', 'a'], label: 'x' } } };
    const r = findField(note.ext, schema, 'note', 'phonemes');
    expect(r.pluginId).to.equal('a.b');
    expect(r.field).to.equal('phonemes');
    expect(r.value).to.deep.equal(['tS', 'a']);
    expect(r.editable).to.equal(false);

    const t = findField(note.ext, schema, 'note', 'text');
    expect(t.value).to.equal('x');
    expect(t.editable).to.equal(true);
  });

  it('没有这类数据时返回 null（而不是空对象）', () => {
    expect(findField(null, schema, 'note', 'phonemes')).to.equal(null);
    expect(findField({ 'a.b': {} }, schema, 'note', 'phonemes')).to.equal(null);
    expect(findField({ 'a.b': { phonemes: ['x'] } }, {}, 'note', 'phonemes')).to.equal(null);
  });
});
