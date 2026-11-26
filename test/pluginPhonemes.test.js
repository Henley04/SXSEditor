const { expect } = require('chai');

const {
  normalizePhonemeList,
  isHostPhonemeName,
  readPhonemeField,
  MAX_PHONEMES_PER_NOTE,
  MAX_PHONEME_NAME,
} = require('../src/shared/pluginPhonemes.js');
const { normalizeExtSchema } = require('../src/shared/pluginExt.js');

/**
 * 插件音素的呈现层。
 *
 * 这一层的契约只有一句话：**把插件给的东西整理成能画的数组，但绝不替插件
 * 判断语义**。所以断言分三组：
 *   · 形态宽容 —— 字符串数组 / 对象数组 / 空格分隔字符串都能进来；
 *   · 规模收敛 —— 一条 note 上的音素数量和单个名字长度都有硬上限；
 *   · 归属清晰 —— 哪些名字落在宿主的命名空间里，界面据此决定灰到什么程度。
 *
 * 特别要守住的是"不合并重复"：`["a","a"]` 是两个音节，不是去重后的一个。
 */
describe('pluginPhonemes — 音素列表归一化', () => {
  it('字符串数组原样变成 {name, display}', () => {
    const { phonemes } = normalizePhonemeList(['l', 'a']);
    expect(phonemes.map((p) => p.name)).to.deep.equal(['l', 'a']);
    expect(phonemes.map((p) => p.display)).to.deep.equal(['l', 'a']);
  });

  it('保留重复音素（序列语义，不是集合）', () => {
    const { phonemes } = normalizePhonemeList(['a', 'a', 'a']);
    expect(phonemes).to.have.length(3);
  });

  it('对象数组带显示名时两个都留', () => {
    const { phonemes } = normalizePhonemeList([{ name: 'tS', display: 'ch' }]);
    expect(phonemes[0]).to.deep.include({ name: 'tS', display: 'ch' });
  });

  it('对象缺 display 时退回 name', () => {
    const { phonemes } = normalizePhonemeList([{ name: 'en_AA1' }]);
    expect(phonemes[0].display).to.equal('en_AA1');
  });

  it('空格 / 逗号分隔的字符串也能拆', () => {
    const { phonemes } = normalizePhonemeList('l a, k  ');
    expect(phonemes.map((p) => p.name)).to.deep.equal(['l', 'a', 'k']);
  });

  it('丢掉空串与非字符串项，并计数', () => {
    const r = normalizePhonemeList(['l', '', '  ', 123, null, { name: '' }, 'a']);
    expect(r.phonemes.map((p) => p.name)).to.deep.equal(['l', 'a']);
    expect(r.dropped).to.equal(5);
  });

  it('超过条数上限时截断并标记', () => {
    const many = Array.from({ length: MAX_PHONEMES_PER_NOTE + 10 }, (_, i) => `p${i}`);
    const r = normalizePhonemeList(many);
    expect(r.phonemes).to.have.length(MAX_PHONEMES_PER_NOTE);
    expect(r.truncated).to.equal(true);
  });

  it('单个名字超长时截断而不是丢弃', () => {
    const long = 'x'.repeat(200);
    const r = normalizePhonemeList([long]);
    expect(r.phonemes[0].name).to.have.lengthOf(MAX_PHONEME_NAME);
  });

  it('非数组非字符串一律返回空表', () => {
    for (const v of [undefined, null, 42, {}, true]) {
      expect(normalizePhonemeList(v).phonemes).to.deep.equal([]);
    }
  });
});

describe('pluginPhonemes — 宿主命名空间判定', () => {
  it('四个语言前缀都认', () => {
    for (const n of ['en_AA1', 'jp_a', 'zh_ma', 'yue_gaa1']) {
      expect(isHostPhonemeName(n), n).to.equal(true);
    }
  });

  it('控制符认', () => {
    for (const n of ['<SP>', '<AP>', '<PAD>']) {
      expect(isHostPhonemeName(n), n).to.equal(true);
    }
  });

  it('别家的方言不认', () => {
    for (const n of ['tS', 'a', 'CH', 'sil', 'en_', '<sp>']) {
      expect(isHostPhonemeName(n), n).to.equal(false);
    }
  });

  it('空值与空白不认', () => {
    for (const n of ['', '   ', null, undefined, 0]) {
      expect(isHostPhonemeName(n)).to.equal(false);
    }
  });
});

describe('pluginPhonemes — 从 ext 反查音素字段', () => {
  const schema = normalizeExtSchema({
    'com.example.demo': {
      note: {
        phonemes: { kind: 'phonemes', editable: false, maxLength: 200 },
        tension: { kind: 'number', min: 0, max: 1 },
      },
    },
    'com.example.vocaloid': {
      note: { phonemes: { kind: 'phonemes', editable: true } },
    },
  });

  it('找得到声明为 phonemes 的字段', () => {
    const hit = readPhonemeField(
      { 'com.example.demo': { phonemes: ['l', 'a'], tension: 0.5 } },
      schema,
    );
    expect(hit).to.not.equal(null);
    expect(hit.pluginId).to.equal('com.example.demo');
    expect(hit.field).to.equal('phonemes');
    expect(hit.editable).to.equal(false);
    expect(hit.phonemes.map((p) => p.name)).to.deep.equal(['l', 'a']);
  });

  it('没有 schema 时不呈现（数据仍在，宿主只是不画）', () => {
    expect(readPhonemeField({ 'com.example.demo': { phonemes: ['l'] } }, null)).to.equal(null);
  });

  it('字段值不是音素形态时返回 null', () => {
    expect(readPhonemeField({ 'com.example.demo': { phonemes: [] } }, schema)).to.equal(null);
    expect(readPhonemeField({ 'com.example.demo': { phonemes: 42 } }, schema)).to.equal(null);
  });

  it('未声明的插件即便带了数据也不呈现', () => {
    expect(readPhonemeField({ 'com.unknown': { phonemes: ['l'] } }, schema)).to.equal(null);
  });

  it('多个插件都声明时取第一个有值的', () => {
    const hit = readPhonemeField(
      { 'com.unknown': { phonemes: ['z'] }, 'com.example.vocaloid': { phonemes: ['a'] } },
      schema,
    );
    expect(hit.pluginId).to.equal('com.example.vocaloid');
  });

  it('把 host 标记一并带出，界面据此决定灰的程度', () => {
    const hit = readPhonemeField(
      { 'com.example.demo': { phonemes: ['en_AA1', 'tS'] } },
      schema,
    );
    expect(hit.phonemes.map((p) => p.host)).to.deep.equal([true, false]);
  });
});
