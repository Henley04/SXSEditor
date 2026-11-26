/**
 * 中文歌词整句上下文 G2P 消歧 + 标点归一（对齐官方预处理 g2pM / g2p.py）。
 *
 * 背景：App 此前逐 note 调 pinyin(char, { multiple: true }) 按常用度取首读音，
 * 多音字「银行」会被读成 yin2 xing2、「音乐」读成 yin1 le4，与官方整句消歧
 * 的训练分布不符。标点 / 非中英文歌词此前落到 <UNK>（训练分布外 embedding），
 * 官方 g2p.py 对 ? . ! , 删除、其余非中英文落 <SP>。
 */
const { expect } = require('chai');
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');
const { Preprocessing } = require('../src/inference/pipeline/preprocessing');
const {
  resolveChineseContextReadings,
  CJK_SINGLE,
} = require('../src/inference/pipeline/zhG2pContext');

describe('中文歌词整句上下文消歧（zhG2pContext）', () => {
  let tp, prep, idx2phone;

  before(() => {
    tp = new TextProcessing();
    prep = new Preprocessing(tp);
    idx2phone = {};
    for (const [name, id] of Object.entries(tp.phone2idx)) idx2phone[id] = name;
  });

  // 从 noteTextSeq 中抽出实际送进 note_text_encoder 的音素名（跳过结构标记）
  function phonemesOf(lyrics) {
    const notes = lyrics.map((lyric, i) => ({ start: i, duration: 1, pitch: 60, lyric }));
    const seq = prep.notesToSequences(notes, 120, null, null);
    const skip = new Set(['<PAD>', '<BOW>', '<EOW>', '<SEP>']);
    return Array.from(seq.noteTextSeq, (id) => idx2phone[id])
      .filter((name) => name && !skip.has(name));
  }

  describe('resolveChineseContextReadings 纯函数', () => {
    it('连续单字中文拼成一句整句消歧，按 note 索引返回读音', () => {
      const readings = resolveChineseContextReadings(['银', '行']);
      expect(readings.get(0)).to.equal('yin2');
      expect(readings.get(1)).to.equal('hang2');
    });

    it('非单字中文歌词（英文/休止/音素标注/多字词）作为句子边界', () => {
      const readings = resolveChineseContextReadings(['银', '行', '<SP>', '音', '乐']);
      expect(readings.get(0)).to.equal('yin2');
      expect(readings.get(1)).to.equal('hang2');
      expect(readings.has(2)).to.equal(false); // <SP> 不参与
      expect(readings.get(3)).to.equal('yin1');
      expect(readings.get(4)).to.equal('yue4');
    });

    it('单字段也照常返回，结果与逐字一致', () => {
      const readings = resolveChineseContextReadings(['行']);
      expect(readings.get(0)).to.equal('xing2');
    });

    it('带声调标注 / zh_ 音素前缀 / 多字词不参与整句消歧', () => {
      const readings = resolveChineseContextReadings(['银2', 'zh_hang2', '银行']);
      expect(readings.size).to.equal(0);
    });

    it('注入的 pinyinFn 抛错或返回错位时安全降级（不抛、不写错映射）', () => {
      const throwing = () => { throw new Error('boom'); };
      expect(() => resolveChineseContextReadings(['银', '行'], throwing)).to.not.throw();
      expect(resolveChineseContextReadings(['银', '行'], throwing).size).to.equal(0);
      const misaligned = () => ['yin2'];
      expect(resolveChineseContextReadings(['银', '行'], misaligned).size).to.equal(0);
    });

    it('空 / 非数组输入返回空 Map', () => {
      expect(resolveChineseContextReadings([]).size).to.equal(0);
      expect(resolveChineseContextReadings(null).size).to.equal(0);
      expect(resolveChineseContextReadings([null, undefined, '']).size).to.equal(0);
    });

    it('CJK_SINGLE 只匹配单个汉字', () => {
      expect(CJK_SINGLE.test('银')).to.equal(true);
      expect(CJK_SINGLE.test('银行')).to.equal(false);
      expect(CJK_SINGLE.test('银2')).to.equal(false);
      expect(CJK_SINGLE.test('a')).to.equal(false);
      expect(CJK_SINGLE.test('，')).to.equal(false);
    });
  });

  describe('notesToSequences 多音字整句消歧', () => {
    const cases = [
      [['银', '行'], ['zh_yin2', 'zh_hang2']],
      [['音', '乐'], ['zh_yin1', 'zh_yue4']],
      [['长', '大'], ['zh_zhang3', 'zh_da4']],
      [['重', '复'], ['zh_chong2', 'zh_fu4']],
      [['着', '凉'], ['zh_zhao2', 'zh_liang2']],
      [['归', '还'], ['zh_gui1', 'zh_huan2']],
      [['一', '行'], ['zh_yi4', 'zh_hang2']],
    ];
    for (const [lyrics, expected] of cases) {
      it(`${lyrics.join('')} → ${expected.join(' ')}（逐字首读音本会读错）`, () => {
        expect(phonemesOf(lyrics)).to.deep.equal(expected);
      });
    }

    it('标点把句子分段，两侧仍各自正确消歧', () => {
      expect(phonemesOf(['你', '好', ',', '银', '行']))
        .to.deep.equal(['zh_ni3', 'zh_hao3', '<SP>', 'zh_yin2', 'zh_hang2']);
    });

    it('非中文歌词（英文 / 显式音素标注）行为不回归', () => {
      // 英文单词仍走英文 G2P；显式 zh_ 音素标注不被上下文覆盖
      const en = phonemesOf(['la']);
      expect(en.every((n) => n.startsWith('en_') || n === '<SEP>')).to.equal(true);
      expect(phonemesOf(['zh_yin2'])).to.include('zh_yin2');
    });
  });

  describe('标点 / 非中英文歌词归一为 <SP>', () => {
    const spId = () => tp.phone2idx['<SP>'];
    for (const p of ['，', '。', '？', '！', ',', '.', '?', '!', '、', '……']) {
      it(`歌词 ${JSON.stringify(p)} → <SP>（不再是 <UNK>）`, () => {
        const orig = console.warn; console.warn = () => {};
        let id;
        try { id = tp._lookupPhonemeId(p); } finally { console.warn = orig; }
        expect(id).to.equal(spId());
      });
    }

    it('守卫不放宽：含字母/数字的乱码与拼错的音素名仍落 <UNK>', () => {
      const unkId = tp.phone2idx['<UNK>'];
      const orig = console.warn; console.warn = () => {};
      let a, b;
      try {
        a = tp._lookupPhonemeId('~~~not-a-phoneme~~~');
        b = tp._lookupPhonemeId('en_ZZZZZ999');
      } finally { console.warn = orig; }
      expect(a).to.equal(unkId);
      expect(b).to.equal(unkId);
    });

    it('连音 - / 空歌词 / <SP> 既有归一不受影响', () => {
      const orig = console.warn; console.warn = () => {};
      try {
        expect(tp._lookupPhonemeId('-')).to.equal(spId());
        expect(tp._lookupPhonemeId('')).to.equal(spId());
        expect(tp._lookupPhonemeId('<SP>')).to.equal(spId());
      } finally { console.warn = orig; }
    });
  });

  describe('_zhSyllableToPhonemeId 三层兜底', () => {
    it('精确命中词表读音', () => {
      expect(tp._zhSyllableToPhonemeId('hang2')).to.equal(tp.phone2idx['zh_hang2']);
    });
    it('轻声 0 归一到 5 后命中', () => {
      expect(tp._zhSyllableToPhonemeId('zhe0')).to.equal(tp.phone2idx['zh_zhe5']);
    });
    it('带 ü 的音节按词表冒号写法命中', () => {
      expect(tp._zhSyllableToPhonemeId('lü4')).to.equal(tp.phone2idx['zh_lu:4']);
    });
    it('非法输入返回 null（调用方回退逐字逻辑）', () => {
      expect(tp._zhSyllableToPhonemeId(null)).to.equal(null);
      expect(tp._zhSyllableToPhonemeId('')).to.equal(null);
    });
  });
});
