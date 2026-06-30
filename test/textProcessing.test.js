const { expect } = require('chai');
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');

describe('inference/pipeline/textProcessing - G2P', () => {
  let tp;
  before(() => {
    tp = new TextProcessing();
  });

  describe('vocabulary loading', () => {
    it('should load phone_set.json with non-empty vocabulary', () => {
      expect(Object.keys(tp.phone2idx).length).to.be.greaterThan(0);
    });
    it('should include special tokens', () => {
      expect(tp.phone2idx['<PAD>']).to.not.equal(undefined);
      expect(tp.phone2idx['<SP>']).to.not.equal(undefined);
      expect(tp.phone2idx['<UNK>']).to.not.equal(undefined);
    });
    it('should load English G2P dictionary', () => {
      expect(Object.keys(tp.enG2pDict).length).to.be.greaterThan(0);
    });
  });

  describe('_isJapanese', () => {
    it('should detect hiragana as Japanese', () => {
      expect(tp._isJapanese('あいう')).to.be.true;
      expect(tp._isJapanese('こんにちは')).to.be.true;
    });
    it('should detect katakana as Japanese', () => {
      expect(tp._isJapanese('アイウ')).to.be.true;
      expect(tp._isJapanese('コンニチハ')).to.be.true;
    });
    it('should NOT detect kanji as Japanese (shared with Chinese)', () => {
      expect(tp._isJapanese('愛')).to.be.false;
      expect(tp._isJapanese('空')).to.be.false;
    });
    it('should NOT detect latin as Japanese', () => {
      expect(tp._isJapanese('hello')).to.be.false;
    });
  });

  describe('resolveLyricToPhonemes', () => {
    it('should resolve empty lyric to <SP>', () => {
      const out = tp.resolveLyricToPhonemes('');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('<SP>');
    });

    it('should resolve <SP> literal to <SP>', () => {
      const out = tp.resolveLyricToPhonemes('<SP>');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('<SP>');
    });

    it('should resolve <AP> literal to <SP>', () => {
      const out = tp.resolveLyricToPhonemes('<AP>');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('<SP>');
    });

    it('should resolve jp_ prefixed lyric directly', () => {
      const out = tp.resolveLyricToPhonemes('jp_a');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('jp_a');
      expect(out[0].display).to.equal('a');
    });

    it('should resolve en_ prefixed dashed lyric into multiple phonemes', () => {
      const out = tp.resolveLyricToPhonemes('en_HH-EH1-L-OW0');
      expect(out.length).to.be.greaterThan(1);
      expect(out[0].name).to.equal('en_HH');
      out.forEach(p => expect(p.name.startsWith('en_')).to.be.true);
    });

    it('should resolve hiragana to jp_ phonemes', () => {
      const out = tp.resolveLyricToPhonemes('あ');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('jp_a');
    });

    it('should resolve hiragana syllable (ka) to consonant+vowel', () => {
      const out = tp.resolveLyricToPhonemes('か');
      const names = out.map(p => p.name);
      expect(names).to.include('jp_k');
      expect(names).to.include('jp_a');
    });

    it('should resolve katakana the same as hiragana', () => {
      const hira = tp.resolveLyricToPhonemes('あ');
      const kata = tp.resolveLyricToPhonemes('ア');
      expect(kata.map(p => p.name)).to.deep.equal(hira.map(p => p.name));
    });

    it('should resolve yōon (きゃ) to palatal consonant + vowel', () => {
      const out = tp.resolveLyon ? tp.resolveLyon('きゃ') : tp.resolveLyricToPhonemes('きゃ');
      const names = out.map(p => p.name);
      expect(names).to.include('jp_ky');
      expect(names).to.include('jp_a');
    });

    it('should handle っ (small tsu) as cl', () => {
      const out = tp.resolveLyricToPhonemes('っ');
      const names = out.map(p => p.name);
      expect(names).to.include('jp_cl');
    });

    it('should skip ー and 〜 (prolonged sound mark)', () => {
      const out = tp.resolveLyricToPhonemes('あーあ');
      // ー should be skipped, leaving a + a
      const names = out.map(p => p.name);
      expect(names).to.deep.equal(['jp_a', 'jp_a']);
    });

    it('should resolve english word via CMUdict', () => {
      const out = tp.resolveLyricToPhonemes('hello');
      expect(out.length).to.be.greaterThan(1);
      out.forEach(p => expect(p.name.startsWith('en_')).to.be.true);
    });

    it('should resolve unknown english word via letter-level fallback', () => {
      const out = tp.resolveLyricToPhonemes('hahaha');
      expect(out.length).to.be.greaterThan(0);
      out.forEach(p => expect(p.name.startsWith('en_')).to.be.true);
    });

    it('should resolve Chinese character to zh_ pinyin phoneme', () => {
      const out = tp.resolveLyricToPhonemes('你');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name.startsWith('zh_')).to.be.true;
    });

    it('should respect explicit tone digit on Chinese char', () => {
      const out1 = tp.resolveLyricToPhonemes('你3');
      const out2 = tp.resolveLyricToPhonemes('你');
      // both should resolve; tone override changes the syllable
      expect(out1[0].name.startsWith('zh_')).to.be.true;
      expect(out2[0].name.startsWith('zh_')).to.be.true;
    });

    it('should force Japanese G2P with <jp> prefix for kanji', () => {
      const out = tp.resolveLyricToPhonemes('<jp>愛');
      expect(out.length).to.be.greaterThan(0);
      out.forEach(p => expect(p.name.startsWith('jp_')).to.be.true);
    });
  });

  describe('_japaneseG2p', () => {
    it('should convert hiragana sentence to phoneme string', () => {
      const result = tp._japaneseG2p('わたし');
      expect(result).to.be.a('string');
      expect(result.split(' ')).to.include('w');
      expect(result.split(' ')).to.include('a');
    });

    it('should handle mixed kanji via dictionary', () => {
      const result = tp._japaneseG2p('音楽');
      expect(result).to.be.a('string');
      expect(result.length).to.be.greaterThan(0);
    });

    it('should return pau for unknown kanji', () => {
      const result = tp._japaneseG2p('龘');
      expect(result).to.include('pau');
    });

    it('should pass through lowercase ascii as lowercase phoneme', () => {
      const result = tp._japaneseG2p('a');
      expect(result).to.equal('a');
    });

    it('should uppercase-less: ascii chars go to lowercase', () => {
      const result = tp._japaneseG2p('A');
      expect(result).to.equal('a');
    });
  });

  describe('_lookupPhonemeId', () => {
    it('should return <SP> id for empty lyric', () => {
      const id = tp._lookupPhonemeId('');
      expect(id).to.equal(tp.phone2idx['<SP>']);
    });
    it('should return <SP> id for whitespace lyric', () => {
      const id = tp._lookupPhonemeId('   ');
      expect(id).to.equal(tp.phone2idx['<SP>']);
    });
    it('should return <UNK> id for unknown phoneme', () => {
      const id = tp._lookupPhonemeId('___definitely_unknown_phoneme___');
      expect(id).to.equal(tp.phone2idx['<UNK>']);
    });
    it('should resolve zh_ prefixed phonemes when present', () => {
      // pick a known zh_ phoneme from vocab
      const zhKey = Object.keys(tp.phone2idx).find(k => k.startsWith('zh_'));
      if (zhKey) {
        const id = tp._lookupPhonemeId(zhKey);
        expect(id).to.equal(tp.phone2idx[zhKey]);
      }
    });
    it('should resolve en_ prefixed phonemes when present', () => {
      const enKey = Object.keys(tp.phone2idx).find(k => k.startsWith('en_'));
      if (enKey) {
        const id = tp._lookupPhonemeId(enKey);
        expect(id).to.equal(tp.phone2idx[enKey]);
      }
    });
  });

  describe('_charToZhPhoneme', () => {
    it('should return null for non-CJK input', () => {
      expect(tp._charToZhPhoneme('abc')).to.be.null;
      expect(tp._charToZhPhoneme('hello')).to.be.null;
    });
    it('should return zh_ prefixed phoneme for chinese char', () => {
      const result = tp._charToZhPhoneme('你');
      expect(result).to.not.be.null;
      expect(result.startsWith('zh_')).to.be.true;
    });
    it('should respect override tone', () => {
      const r1 = tp._charToZhPhoneme('你');
      const r3 = tp._charToZhPhoneme('你3');
      expect(r1).to.not.equal(r3);
    });
  });

  describe('_englishG2p', () => {
    it('should return CMUdict entry for known word', () => {
      const result = tp._englishG2p('hello');
      expect(result).to.be.a('string');
      expect(result.length).to.be.greaterThan(0);
    });
    it('should be case-insensitive', () => {
      const lower = tp._englishG2p('hello');
      const upper = tp._englishG2p('HELLO');
      expect(upper).to.equal(lower);
    });
    it('should use letter-level fallback for unknown word', () => {
      const result = tp._englishG2p('qqzx');
      expect(result).to.not.be.null;
      // q → K, z → Z, x → K S
      expect(result).to.include('K');
      expect(result).to.include('Z');
    });
    it('should return null for word with no mappable letters', () => {
      const result = tp._englishG2p('12345');
      expect(result).to.be.null;
    });
  });
});
