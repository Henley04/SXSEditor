const { expect } = require('chai');
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');

describe('inference/pipeline/textProcessing - G2P', () => {
  // tpJp: JP LoRA mode (jp_ phonemes) — preserves original behavior
  // tpEn: English phoneme migration mode (en_ phonemes) — new default
  // tpHybrid: Hybrid mode (improved ARPAbet mapping: L for ら行, AO for お段)
  let tpJp, tpEn, tpHybrid;
  before(() => {
    tpJp = new TextProcessing({ japaneseVocalization: 'jp-lora' });
    tpEn = new TextProcessing({ japaneseVocalization: 'en-phonemes' });
    tpHybrid = new TextProcessing({ japaneseVocalization: 'hybrid' });
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

    it('should repeat preceding vowel on ー (long vowel) and skip 〜', () => {
      const out = tpJp.resolveLyricToPhonemes('あーあ');
      const names = out.map(p => p.name);
      // あ → jp_a, ー → repeats jp_a (long vowel), あ → jp_a
      expect(names).to.deep.equal(['jp_a', 'jp_a', 'jp_a']);
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

    it('should repeat preceding vowel on ー (long vowel) in en-phonemes mode', () => {
      const out = tpEn.resolveLyricToPhonemes('あーあ');
      const names = out.map(p => p.name);
      // あ → en_AA1, ー → repeats en_AA1, あ → en_AA1
      expect(names).to.deep.equal(['en_AA1', 'en_AA1', 'en_AA1']);
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

  describe('resolveLyricToPhonemes (hybrid mode)', () => {
    // Hybrid mode key differences from en-phonemes:
    //   ら行 (r) → L (not R) — closer to Japanese tap [ɾ]
    //   お段 (o) → AO1 (not OW1) — pure vowel, not diphthong
    //   り拗音 (ry) → L Y (not R Y)
    // All other phonemes match en-phonemes mode.

    it('should resolve jp_ prefixed vowel to English phoneme (same as en-phonemes for a)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('jp_a');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('en_AA1');
    });

    it('should map jp_o to AO1 in hybrid mode (not OW1)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('jp_o');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('en_AO1');
    });

    it('should map jp_r to L in hybrid mode (not R)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('jp_r');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('en_L');
    });

    it('should map jp_ry to L Y in hybrid mode (not R Y)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('jp_ry');
      expect(out).to.have.lengthOf(2);
      expect(out[0].name).to.equal('en_L');
      expect(out[1].name).to.equal('en_Y');
    });

    it('should resolve hiragana お to yue_o1 in hybrid mode (Cantonese pure vowel)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('お');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('yue_o1');
    });

    it('should resolve hiragana ら to yue_laa1 in hybrid mode (Cantonese l for Japanese r)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('ら');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('yue_laa1');
    });

    it('should resolve hiragana ろ to yue_lo1 in hybrid mode', () => {
      const out = tpHybrid.resolveLyricToPhonemes('ろ');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('yue_lo1');
    });

    it('should resolve りょ to L Y AO1 in hybrid mode (yōon falls back to ARPAbet)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('りょ');
      const names = out.map(p => p.name);
      expect(names).to.deep.equal(['en_L', 'en_Y', 'en_AO1']);
    });

    it('should map か (ka) to yue_gaa1 in hybrid mode (Cantonese unaspirated g)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('か');
      expect(out).to.have.lengthOf(1);
      expect(out[0].name).to.equal('yue_gaa1');
    });

    it('should map つ (ts) to T + S same as en-phonemes (no Cantonese /su/)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('つ');
      const names = out.map(p => p.name);
      expect(names).to.deep.equal(['en_T', 'en_S', 'en_UW1']);
    });

    it('should fall back to ARPAbet when lyric contains が (no Cantonese voiced /g/)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('ありがとう');
      expect(out.length).to.be.greaterThan(2);
      out.forEach(p => expect(p.name.startsWith('en_') || p.name === '<SP>').to.be.true);
    });

    it('should differ from en-phonemes for ら (Cantonese yue_laa1 vs en_R + en_AA1)', () => {
      const hybridOut = tpHybrid.resolveLyricToPhonemes('ら');
      const enOut = tpEn.resolveLyricToPhonemes('ら');
      const hybridNames = hybridOut.map(p => p.name);
      const enNames = enOut.map(p => p.name);
      // hybrid uses Cantonese syllable-level yue_laa1, en-phonemes uses ARPAbet R + AA1
      expect(hybridNames).to.deep.equal(['yue_laa1']);
      expect(enNames).to.deep.equal(['en_R', 'en_AA1']);
    });

    it('should differ from en-phonemes for お (Cantonese yue_o1 vs en_OW1)', () => {
      const hybridOut = tpHybrid.resolveLyricToPhonemes('お');
      const enOut = tpEn.resolveLyricToPhonemes('お');
      expect(hybridOut[0].name).to.equal('yue_o1');
      expect(enOut[0].name).to.equal('en_OW1');
    });

    it('should attach duration weights to mapped phonemes (incl. yue_)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('か');
      out.forEach(p => expect(p).to.have.property('weight'));
    });

    it('should handle っ (small tsu) same as en-phonemes (T)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('っ');
      const names = out.map(p => p.name);
      expect(names).to.include('en_T');
    });

    it('should repeat preceding vowel on ー (long vowel) in hybrid mode', () => {
      const out = tpHybrid.resolveLyricToPhonemes('あーあ');
      const names = out.map(p => p.name);
      // あ → yue_aa1, ー → repeats yue_aa1, あ → yue_aa1
      expect(names).to.deep.equal(['yue_aa1', 'yue_aa1', 'yue_aa1']);
    });

    it('should force Japanese→English with <jp> prefix for kanji', () => {
      const out = tpHybrid.resolveLyricToPhonemes('<jp>愛');
      expect(out.length).to.be.greaterThan(0);
      out.forEach(p => expect(p.name.startsWith('en_') || p.name === '<SP>').to.be.true);
    });
  });

  describe('resolveLyricToPhonemes (hybrid mode — Cantonese yue_ mapping)', () => {
    // Hybrid mode now mixes Cantonese yue_ (syllable-level) and English ARPAbet
    // (phoneme-level) phonemes, picking whichever is phonetically closer to each
    // Japanese kana. Kanji, voiced rows (が/ざ/だ/ば), yōon (拗音), っ, ん all
    // fall back to ARPAbet since Cantonese has no close equivalent.

    it('should map あ row vowels to Cantonese pure vowels where available', () => {
      expect(tpHybrid.resolveLyricToPhonemes('あ')[0].name).to.equal('yue_aa1');
      expect(tpHybrid.resolveLyricToPhonemes('お')[0].name).to.equal('yue_o1');
      expect(tpHybrid.resolveLyricToPhonemes('を')[0].name).to.equal('yue_o1');
    });

    it('should map い/う/え to ARPAbet (no pure Cantonese /i//u//e/)', () => {
      expect(tpHybrid.resolveLyricToPhonemes('い')[0].name).to.equal('en_IY1');
      expect(tpHybrid.resolveLyricToPhonemes('う')[0].name).to.equal('en_UW1');
      expect(tpHybrid.resolveLyricToPhonemes('え')[0].name).to.equal('en_EH1');
    });

    it('should map か行 (k) to Cantonese g* (unaspirated /k/)', () => {
      expect(tpHybrid.resolveLyricToPhonemes('か')[0].name).to.equal('yue_gaa1');
      expect(tpHybrid.resolveLyricToPhonemes('く')[0].name).to.equal('yue_gu1');
      expect(tpHybrid.resolveLyricToPhonemes('こ')[0].name).to.equal('yue_go1');
      // き/け fall back to ARPAbet (no pure Cantonese /ki//ke/)
      const kiOut = tpHybrid.resolveLyricToPhonemes('き').map(p => p.name);
      expect(kiOut).to.deep.equal(['en_K', 'en_IY1']);
      const keOut = tpHybrid.resolveLyricToPhonemes('け').map(p => p.name);
      expect(keOut).to.deep.equal(['en_K', 'en_EH1']);
    });

    it('should map さ行 (s) to Cantonese s* for pure /sV/ syllables', () => {
      expect(tpHybrid.resolveLyricToPhonemes('さ')[0].name).to.equal('yue_saa1');
      expect(tpHybrid.resolveLyricToPhonemes('せ')[0].name).to.equal('yue_se1');
      expect(tpHybrid.resolveLyricToPhonemes('そ')[0].name).to.equal('yue_so1');
      // し → ARPAbet SH+IY1 (Japanese /ɕi/ palatalized, closer to English /ʃ/)
      const shiOut = tpHybrid.resolveLyricToPhonemes('し').map(p => p.name);
      expect(shiOut).to.deep.equal(['en_SH', 'en_IY1']);
      // す → ARPAbet S+UW1 (no Cantonese /su/)
      const suOut = tpHybrid.resolveLyricToPhonemes('す').map(p => p.name);
      expect(suOut).to.deep.equal(['en_S', 'en_UW1']);
    });

    it('should map た行 (t) to Cantonese d* (unaspirated /t/)', () => {
      expect(tpHybrid.resolveLyricToPhonemes('た')[0].name).to.equal('yue_daa1');
      expect(tpHybrid.resolveLyricToPhonemes('て')[0].name).to.equal('yue_de1');
      expect(tpHybrid.resolveLyricToPhonemes('と')[0].name).to.equal('yue_do1');
      // ち → ARPAbet CH+IY1; つ → ARPAbet T+S+UW1
      const chiOut = tpHybrid.resolveLyricToPhonemes('ち').map(p => p.name);
      expect(chiOut).to.deep.equal(['en_CH', 'en_IY1']);
      const tsuOut = tpHybrid.resolveLyricToPhonemes('つ').map(p => p.name);
      expect(tsuOut).to.deep.equal(['en_T', 'en_S', 'en_UW1']);
    });

    it('should map な行 (n) to Cantonese n* where available', () => {
      expect(tpHybrid.resolveLyricToPhonemes('な')[0].name).to.equal('yue_naa4');
      expect(tpHybrid.resolveLyricToPhonemes('ね')[0].name).to.equal('yue_ne1');
      expect(tpHybrid.resolveLyricToPhonemes('の')[0].name).to.equal('yue_no4');
      // に → ARPAbet N+Y+IY1 (G2P yields 'ny i', hybrid maps ny→N+Y, i→IY1)
      const niOut = tpHybrid.resolveLyricToPhonemes('に').map(p => p.name);
      expect(niOut).to.deep.equal(['en_N', 'en_Y', 'en_IY1']);
      const nuOut = tpHybrid.resolveLyricToPhonemes('ぬ').map(p => p.name);
      expect(nuOut).to.deep.equal(['en_N', 'en_UW1']);
    });

    it('should map は行 (h) to Cantonese h* / fu1', () => {
      expect(tpHybrid.resolveLyricToPhonemes('は')[0].name).to.equal('yue_haa1');
      expect(tpHybrid.resolveLyricToPhonemes('ひ')[0].name).to.equal('yue_hi1');
      expect(tpHybrid.resolveLyricToPhonemes('ふ')[0].name).to.equal('yue_fu1');
      expect(tpHybrid.resolveLyricToPhonemes('へ')[0].name).to.equal('yue_he3');
      expect(tpHybrid.resolveLyricToPhonemes('ほ')[0].name).to.equal('yue_ho1');
    });

    it('should map ま行 (m) to Cantonese m* where available', () => {
      expect(tpHybrid.resolveLyricToPhonemes('ま')[0].name).to.equal('yue_maa1');
      expect(tpHybrid.resolveLyricToPhonemes('め')[0].name).to.equal('yue_me1');
      expect(tpHybrid.resolveLyricToPhonemes('も')[0].name).to.equal('yue_mo1');
      // み → ARPAbet M+Y+IY1 (G2P yields 'my i', hybrid maps my→M+Y, i→IY1)
      const miOut = tpHybrid.resolveLyricToPhonemes('み').map(p => p.name);
      expect(miOut).to.deep.equal(['en_M', 'en_Y', 'en_IY1']);
      const muOut = tpHybrid.resolveLyricToPhonemes('む').map(p => p.name);
      expect(muOut).to.deep.equal(['en_M', 'en_UW1']);
    });

    it('should map や/よ to Cantonese j* (and ゆ to ARPAbet)', () => {
      expect(tpHybrid.resolveLyricToPhonemes('や')[0].name).to.equal('yue_jaa1');
      expect(tpHybrid.resolveLyricToPhonemes('よ')[0].name).to.equal('yue_jo1');
      const yuOut = tpHybrid.resolveLyricToPhonemes('ゆ').map(p => p.name);
      expect(yuOut).to.deep.equal(['en_Y', 'en_UW1']);
    });

    it('should map ら行 (r) to Cantonese l* (closest to Japanese tap /ɾ/)', () => {
      expect(tpHybrid.resolveLyricToPhonemes('ら')[0].name).to.equal('yue_laa1');
      expect(tpHybrid.resolveLyricToPhonemes('り')[0].name).to.equal('yue_li1');
      expect(tpHybrid.resolveLyricToPhonemes('れ')[0].name).to.equal('yue_le4');
      expect(tpHybrid.resolveLyricToPhonemes('ろ')[0].name).to.equal('yue_lo1');
      // る → ARPAbet (no Cantonese /lu/)
      const ruOut = tpHybrid.resolveLyricToPhonemes('る').map(p => p.name);
      expect(ruOut).to.deep.equal(['en_L', 'en_UW1']);
    });

    it('should map わ to Cantonese waa1', () => {
      expect(tpHybrid.resolveLyricToPhonemes('わ')[0].name).to.equal('yue_waa1');
    });

    it('should map ぱ行 (p) to Cantonese p* (aspirated /pʰ/)', () => {
      expect(tpHybrid.resolveLyricToPhonemes('ぱ')[0].name).to.equal('yue_paa3');
      expect(tpHybrid.resolveLyricToPhonemes('ぽ')[0].name).to.equal('yue_po3');
      // ぴ → ARPAbet P+Y+IY1 (G2P yields 'py i', hybrid maps py→P+Y, i→IY1)
      const piOut = tpHybrid.resolveLyricToPhonemes('ぴ').map(p => p.name);
      expect(piOut).to.deep.equal(['en_P', 'en_Y', 'en_IY1']);
    });

    it('should fall back to ARPAbet for が/ざ/だ/ば行 (voiced stops)', () => {
      const gaOut = tpHybrid.resolveLyricToPhonemes('が').map(p => p.name);
      expect(gaOut).to.deep.equal(['en_G', 'en_AA1']);
      const zaOut = tpHybrid.resolveLyricToPhonemes('ざ').map(p => p.name);
      expect(zaOut).to.deep.equal(['en_Z', 'en_AA1']);
      const daOut = tpHybrid.resolveLyricToPhonemes('だ').map(p => p.name);
      expect(daOut).to.deep.equal(['en_D', 'en_AA1']);
      const baOut = tpHybrid.resolveLyricToPhonemes('ば').map(p => p.name);
      expect(baOut).to.deep.equal(['en_B', 'en_AA1']);
    });

    it('should fall back to ARPAbet for ん (universal nasal)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('ん').map(p => p.name);
      expect(out).to.deep.equal(['en_N']);
    });

    it('should fall back to ARPAbet for っ (gemination marker)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('っ').map(p => p.name);
      expect(out).to.deep.equal(['en_T']);
    });

    it('should fall back to ARPAbet for yōon (palatalized consonants)', () => {
      const kyaOut = tpHybrid.resolveLyricToPhonemes('きゃ').map(p => p.name);
      expect(kyaOut).to.deep.equal(['en_K', 'en_Y', 'en_AA1']);
      const ryoOut = tpHybrid.resolveLyricToPhonemes('りょ').map(p => p.name);
      expect(ryoOut).to.deep.equal(['en_L', 'en_Y', 'en_AO1']);
    });

    it('should map multi-kana lyrics to mixed yue_ sequence when all kanas are covered', () => {
      // さくら = さ + く + ら → all in Cantonese map
      const out = tpHybrid.resolveLyricToPhonemes('さくら').map(p => p.name);
      expect(out).to.deep.equal(['yue_saa1', 'yue_gu1', 'yue_laa1']);
    });

    it('should fall back to ARPAbet for multi-kana lyrics with any uncovered kana', () => {
      // さくらが = さ + く + ら + が → が not in Cantonese map → all ARPAbet
      const out = tpHybrid.resolveLyricToPhonemes('さくらが');
      expect(out.length).to.be.greaterThan(3);
      out.forEach(p => expect(p.name.startsWith('en_') || p.name === '<SP>').to.be.true);
    });

    it('should map katakana to same Cantonese phonemes as hiragana', () => {
      expect(tpHybrid.resolveLyricToPhonemes('カ')[0].name).to.equal('yue_gaa1');
      expect(tpHybrid.resolveLyricToPhonemes('サ')[0].name).to.equal('yue_saa1');
      expect(tpHybrid.resolveLyricToPhonemes('ラ')[0].name).to.equal('yue_laa1');
    });

    it('should attach weight=1.0 to yue_ phonemes (durationStats has no yue_ entries)', () => {
      const out = tpHybrid.resolveLyricToPhonemes('さくら');
      out.forEach(p => {
        expect(p).to.have.property('weight');
        if (p.name.startsWith('yue_')) {
          expect(p.weight).to.equal(1.0);
        }
      });
    });

    it('should fall back to ARPAbet for kanji input (with <jp> prefix)', () => {
      // 愛 is a kanji — _isJapanese() only matches kana, so <jp> prefix is needed
      // to force the Japanese G2P path. Without <jp>, 愛 would be treated as
      // Chinese (zh_ai4) by _charToZhPhoneme.
      const out = tpHybrid.resolveLyricToPhonemes('<jp>愛');
      expect(out.length).to.be.greaterThan(0);
      out.forEach(p => expect(p.name.startsWith('en_') || p.name === '<SP>').to.be.true);
    });

    it('should not affect en-phonemes mode (still pure ARPAbet)', () => {
      // en-phonemes mode should NOT use Cantonese mapping
      const out = tpEn.resolveLyricToPhonemes('か').map(p => p.name);
      expect(out).to.deep.equal(['en_K', 'en_AA1']);
      const raOut = tpEn.resolveLyricToPhonemes('ら').map(p => p.name);
      expect(raOut).to.deep.equal(['en_R', 'en_AA1']);
    });

    it('should not affect jp-lora mode (still uses jp_ phonemes)', () => {
      const out = tpJp.resolveLyricToPhonemes('か').map(p => p.name);
      expect(out).to.deep.equal(['jp_k', 'jp_a']);
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
