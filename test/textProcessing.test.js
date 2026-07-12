const { expect } = require('chai');
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');

describe('inference/pipeline/textProcessing - G2P', () => {
  // tpJp: JP LoRA mode (jp_ phonemes) — preserves original behavior
  // tpEn: English phoneme migration mode (en_ phonemes) — new default
  let tpJp, tpEn;
  before(() => {
    tpJp = new TextProcessing({ japaneseVocalization: 'jp-lora' });
    tpEn = new TextProcessing({ japaneseVocalization: 'en-phonemes' });
  });

  describe('vocabulary loading', () => {
    it('should load phone_set.json with non-empty vocabulary', () => {
      expect(Object.keys(tpEn.phone2idx).length).to.be.greaterThan(0);
    });
    it('should include special tokens', () => {
      expect(tpEn.phone2idx['<PAD>']).to.not.equal(undefined);
      expect(tpEn.phone2idx['<SP>']).to.not.equal(undefined);
      expect(tpEn.phone2idx['<UNK>']).to.not.equal(undefined);
    });
    it('should load English G2P dictionary', () => {
      expect(Object.keys(tpEn.enG2pDict).length).to.be.greaterThan(0);
    });
  });

  describe('_isJapanese', () => {
    it('should detect hiragana as Japanese', () => {
      expect(tpEn._isJapanese('あいう')).to.be.true;
      expect(tpEn._isJapanese('こんにちは')).to.be.true;
    });
    it('should detect katakana as Japanese', () => {
      expect(tpEn._isJapanese('アイウ')).to.be.true;
      expect(tpEn._isJapanese('コンニチハ')).to.be.true;
    });
    it('should NOT detect kanji as Japanese (shared with Chinese)', () => {
      expect(tpEn._isJapanese('愛')).to.be.false;
      expect(tpEn._isJapanese('空')).to.be.false;
    });
    it('should NOT detect latin as Japanese', () => {
      expect(tpEn._isJapanese('hello')).to.be.false;
    });
  });

  describe('resolveLyricToPhonemes (common)', () => {
    it('should resolve empty lyric to <SP>', () => {
      const out = tpEn.resolveLyricToPhonemes('');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('<SP>');
    });

    it('should resolve <SP> literal to <SP>', () => {
      const out = tpEn.resolveLyricToPhonemes('<SP>');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('<SP>');
    });

    it('should resolve <AP> literal to <SP>', () => {
      const out = tpEn.resolveLyricToPhonemes('<AP>');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('<SP>');
    });

    it('should resolve en_ prefixed dashed lyric into multiple phonemes', () => {
      const out = tpEn.resolveLyricToPhonemes('en_HH-EH1-L-OW0');
      expect(out.length).to.be.greaterThan(1);
      expect(out[0].name).to.equal('en_HH');
      out.forEach(p => expect(p.name.startsWith('en_')).to.be.true);
    });

    it('should resolve english word via CMUdict', () => {
      const out = tpEn.resolveLyricToPhonemes('hello');
      expect(out.length).to.be.greaterThan(1);
      out.forEach(p => expect(p.name.startsWith('en_')).to.be.true);
    });

    it('should resolve unknown english word via letter-level fallback', () => {
      const out = tpEn.resolveLyricToPhonemes('hahaha');
      expect(out.length).to.be.greaterThan(0);
      out.forEach(p => expect(p.name.startsWith('en_')).to.be.true);
    });

    it('should resolve Chinese character to zh_ pinyin phoneme', () => {
      const out = tpEn.resolveLyricToPhonemes('你');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name.startsWith('zh_')).to.be.true;
    });

    it('should respect explicit tone digit on Chinese char', () => {
      const out1 = tpEn.resolveLyricToPhonemes('你3');
      const out2 = tpEn.resolveLyricToPhonemes('你');
      // both should resolve; tone override changes the syllable
      expect(out1[0].name.startsWith('zh_')).to.be.true;
      expect(out2[0].name.startsWith('zh_')).to.be.true;
    });
  });

  describe('resolveLyricToPhonemes (jp-lora mode)', () => {
    it('should resolve jp_ prefixed lyric directly to jp_ phoneme', () => {
      const out = tpJp.resolveLyricToPhonemes('jp_a');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('jp_a');
      expect(out[0].display).to.equal('a');
    });

    it('should resolve hiragana to jp_ phonemes', () => {
      const out = tpJp.resolveLyricToPhonemes('あ');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('jp_a');
    });

    it('should resolve hiragana syllable (ka) to consonant+vowel', () => {
      const out = tpJp.resolveLyricToPhonemes('か');
      const names = out.map(p => p.name);
      expect(names).to.include('jp_k');
      expect(names).to.include('jp_a');
    });

    it('should resolve katakana the same as hiragana', () => {
      const hira = tpJp.resolveLyricToPhonemes('あ');
      const kata = tpJp.resolveLyricToPhonemes('ア');
      expect(kata.map(p => p.name)).to.deep.equal(hira.map(p => p.name));
    });

    it('should resolve yōon (きゃ) to palatal consonant + vowel', () => {
      const out = tpJp.resolveLyricToPhonemes('きゃ');
      const names = out.map(p => p.name);
      expect(names).to.include('jp_ky');
      expect(names).to.include('jp_a');
    });

    it('should handle っ (small tsu) as cl', () => {
      const out = tpJp.resolveLyricToPhonemes('っ');
      const names = out.map(p => p.name);
      expect(names).to.include('jp_cl');
    });

    it('should skip ー and 〜 (prolonged sound mark)', () => {
      const out = tpJp.resolveLyricToPhonemes('あーあ');
      const names = out.map(p => p.name);
      expect(names).to.deep.equal(['jp_a', 'jp_a']);
    });

    it('should force Japanese G2P with <jp> prefix for kanji', () => {
      const out = tpJp.resolveLyricToPhonemes('<jp>愛');
      expect(out.length).to.be.greaterThan(0);
      out.forEach(p => expect(p.name.startsWith('jp_')).to.be.true);
    });
  });

  describe('resolveLyricToPhonemes (en-phonemes mode)', () => {
    it('should resolve jp_ prefixed vowel to English phoneme', () => {
      const out = tpEn.resolveLyricToPhonemes('jp_a');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('en_AA1');
    });

    it('should resolve jp_ prefixed consonant to English phoneme', () => {
      const out = tpEn.resolveLyricToPhonemes('jp_k');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('en_K');
    });

    it('should resolve jp_ prefixed affricate (ts) to multiple English phonemes', () => {
      const out = tpEn.resolveLyricToPhonemes('jp_ts');
      expect(out).to.have.lengthOf(2);
      expect(out[0].name).to.equal('en_T');
      expect(out[1].name).to.equal('en_S');
    });

    it('should resolve jp_ prefixed palatal (ky) to consonant + Y', () => {
      const out = tpEn.resolveLyricToPhonemes('jp_ky');
      expect(out).to.have.lengthOf(2);
      expect(out[0].name).to.equal('en_K');
      expect(out[1].name).to.equal('en_Y');
    });

    it('should resolve hiragana vowel to English phoneme', () => {
      const out = tpEn.resolveLyricToPhonemes('あ');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('en_AA1');
    });

    it('should resolve hiragana syllable (ka) to English consonant+vowel', () => {
      const out = tpEn.resolveLyricToPhonemes('か');
      const names = out.map(p => p.name);
      expect(names).to.include('en_K');
      expect(names).to.include('en_AA1');
    });

    it('should resolve katakana the same as hiragana', () => {
      const hira = tpEn.resolveLyricToPhonemes('あ');
      const kata = tpEn.resolveLyricToPhonemes('ア');
      expect(kata.map(p => p.name)).to.deep.equal(hira.map(p => p.name));
    });

    it('should resolve yōon (きゃ) to English palatal sequence', () => {
      const out = tpEn.resolveLyricToPhonemes('きゃ');
      const names = out.map(p => p.name);
      expect(names).to.include('en_K');
      expect(names).to.include('en_Y');
      expect(names).to.include('en_AA1');
    });

    it('should handle っ (small tsu) as English T', () => {
      const out = tpEn.resolveLyricToPhonemes('っ');
      const names = out.map(p => p.name);
      expect(names).to.include('en_T');
    });

    it('should skip ー and 〜 (prolonged sound mark) in en-phonemes mode', () => {
      const out = tpEn.resolveLyricToPhonemes('あーあ');
      const names = out.map(p => p.name);
      expect(names).to.deep.equal(['en_AA1', 'en_AA1']);
    });

    it('should force Japanese→English with <jp> prefix for kanji', () => {
      const out = tpEn.resolveLyricToPhonemes('<jp>愛');
      expect(out.length).to.be.greaterThan(0);
      out.forEach(p => expect(p.name.startsWith('en_')).to.be.true);
    });

    it('should attach duration weights to mapped phonemes', () => {
      const out = tpEn.resolveLyricToPhonemes('か');
      // Each phoneme should have a weight property (from _attachEnglishWeights)
      out.forEach(p => expect(p).to.have.property('weight'));
    });

    it('should map all 5 Japanese vowels to stressed English vowels', () => {
      const vowelMap = {
        'あ': 'en_AA1', // a → AA1
        'い': 'en_IY1', // i → IY1
        'う': 'en_UW1', // u → UW1
        'え': 'en_EH1', // e → EH1
        'お': 'en_OW1', // o → OW1
      };
      for (const [kana, expected] of Object.entries(vowelMap)) {
        const out = tpEn.resolveLyricToPhonemes(kana);
        expect(out).to.have.lengthOf(1);
        expect(out[0].name).to.equal(expected);
      }
    });

    it('should map Japanese consonants to nearest ARPAbet', () => {
      const consonantKana = {
        'か': 'en_K',   // k → K
        'さ': 'en_S',   // s → S
        'た': 'en_T',   // t → T
        'な': 'en_N',   // n → N
        'は': 'en_HH',  // h → HH
        'ま': 'en_M',   // m → M
        'ら': 'en_R',   // r → R
        'が': 'en_G',   // g → G
        'ざ': 'en_Z',   // z → Z
        'だ': 'en_D',   // d → D
        'ば': 'en_B',   // b → B
        'ぱ': 'en_P',   // p → P
      };
      for (const [kana, expected] of Object.entries(consonantKana)) {
        const out = tpEn.resolveLyricToPhonemes(kana);
        const names = out.map(p => p.name);
        expect(names).to.include(expected);
      }
    });

    it('should map し (sh) to English SH', () => {
      const out = tpEn.resolveLyricToPhonemes('し');
      const names = out.map(p => p.name);
      expect(names).to.include('en_SH');
    });

    it('should map ち (ch) to English CH', () => {
      const out = tpEn.resolveLyricToPhonemes('ち');
      const names = out.map(p => p.name);
      expect(names).to.include('en_CH');
    });

    it('should map つ (ts) to English T + S', () => {
      const out = tpEn.resolveLyricToPhonemes('つ');
      const names = out.map(p => p.name);
      expect(names).to.deep.equal(['en_T', 'en_S', 'en_UW1']);
    });

    it('should map じ (j) to English JH', () => {
      const out = tpEn.resolveLyricToPhonemes('じ');
      const names = out.map(p => p.name);
      expect(names).to.include('en_JH');
    });

    it('should map ふ (f) to English F', () => {
      const out = tpEn.resolveLyricToPhonemes('ふ');
      const names = out.map(p => p.name);
      expect(names).to.include('en_F');
    });
  });

  describe('_japaneseG2p', () => {
    it('should convert hiragana sentence to phoneme string', () => {
      const result = tpEn._japaneseG2p('わたし');
      expect(result).to.be.a('string');
      expect(result.split(' ')).to.include('w');
      expect(result.split(' ')).to.include('a');
    });

    it('should handle mixed kanji via dictionary', () => {
      const result = tpEn._japaneseG2p('音楽');
      expect(result).to.be.a('string');
      expect(result.length).to.be.greaterThan(0);
    });

    it('should return pau for unknown kanji', () => {
      const result = tpEn._japaneseG2p('龘');
      expect(result).to.include('pau');
    });

    it('should pass through lowercase ascii as lowercase phoneme', () => {
      const result = tpEn._japaneseG2p('a');
      expect(result).to.equal('a');
    });

    it('should uppercase-less: ascii chars go to lowercase', () => {
      const result = tpEn._japaneseG2p('A');
      expect(result).to.equal('a');
    });
  });

  describe('_japaneseToEnglishPhonemes', () => {
    it('should convert hiragana word to English phoneme sequence', () => {
      const out = tpEn._japaneseToEnglishPhonemes('ありがとう');
      expect(out.length).to.be.greaterThan(2);
      out.forEach(p => expect(p.name.startsWith('en_')).to.be.true);
    });

    it('should map pau (unknown kanji) to <SP>', () => {
      const out = tpEn._japaneseToEnglishPhonemes('龘');
      const spCount = out.filter(p => p.name === '<SP>').length;
      expect(spCount).to.be.greaterThan(0);
    });

    it('should produce different output than jp-lora mode', () => {
      const enOut = tpEn._japaneseToEnglishPhonemes('か');
      const jpOut = tpJp._japaneseG2p('か').split(' ');
      // en-phonemes should have en_ prefix; jp-lora uses jp_ prefix
      enOut.forEach(p => expect(p.name.startsWith('en_') || p.name === '<SP>').to.be.true);
      jpOut.forEach(p => expect(p).to.not.match(/^en_/));
    });
  });

  describe('_lookupPhonemeId', () => {
    it('should return <SP> id for empty lyric', () => {
      const id = tpEn._lookupPhonemeId('');
      expect(id).to.equal(tpEn.phone2idx['<SP>']);
    });
    it('should return <SP> id for whitespace lyric', () => {
      const id = tpEn._lookupPhonemeId('   ');
      expect(id).to.equal(tpEn.phone2idx['<SP>']);
    });
    it('should return <UNK> id for unknown phoneme', () => {
      const id = tpEn._lookupPhonemeId('___definitely_unknown_phoneme___');
      expect(id).to.equal(tpEn.phone2idx['<UNK>']);
    });
    it('should resolve zh_ prefixed phonemes when present', () => {
      const zhKey = Object.keys(tpEn.phone2idx).find(k => k.startsWith('zh_'));
      if (zhKey) {
        const id = tpEn._lookupPhonemeId(zhKey);
        expect(id).to.equal(tpEn.phone2idx[zhKey]);
      }
    });
    it('should resolve en_ prefixed phonemes when present', () => {
      const enKey = Object.keys(tpEn.phone2idx).find(k => k.startsWith('en_'));
      if (enKey) {
        const id = tpEn._lookupPhonemeId(enKey);
        expect(id).to.equal(tpEn.phone2idx[enKey]);
      }
    });
  });

  describe('_charToZhPhoneme', () => {
    it('should return null for non-CJK input', () => {
      expect(tpEn._charToZhPhoneme('abc')).to.be.null;
      expect(tpEn._charToZhPhoneme('hello')).to.be.null;
    });
    it('should return zh_ prefixed phoneme for chinese char', () => {
      const result = tpEn._charToZhPhoneme('你');
      expect(result).to.not.be.null;
      expect(result.startsWith('zh_')).to.be.true;
    });
    it('should respect override tone', () => {
      const r1 = tpEn._charToZhPhoneme('好');
      const rOverride = tpEn._charToZhPhoneme('好1');
      expect(r1).to.not.equal(rOverride);
      expect(rOverride).to.match(/1$/);
      expect(r1).to.match(/3$/);
    });
  });

  describe('_englishG2p', () => {
    it('should return CMUdict entry for known word', () => {
      const result = tpEn._englishG2p('hello');
      expect(result).to.be.a('string');
      expect(result.length).to.be.greaterThan(0);
    });
    it('should be case-insensitive', () => {
      const lower = tpEn._englishG2p('hello');
      const upper = tpEn._englishG2p('HELLO');
      expect(upper).to.equal(lower);
    });
    it('should use letter-level fallback for unknown word', () => {
      const result = tpEn._englishG2p('qqzx');
      expect(result).to.not.be.null;
      expect(result).to.include('K');
      expect(result).to.include('Z');
    });
    it('should return null for word with no mappable letters', () => {
      const result = tpEn._englishG2p('12345');
      expect(result).to.be.null;
    });
  });
});
