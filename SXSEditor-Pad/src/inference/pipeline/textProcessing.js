/**
 * textProcessing.js
 * Text processing for the SXSEditor-Pad SVS pipeline.
 *
 * Handles Chinese, English, and Japanese text-to-phoneme conversion.
 * Uses pinyin-pro for Chinese pinyin conversion and a simple G2P
 * (grapheme-to-phoneme) mapping for English.
 *
 * @module inference/pipeline/textProcessing
 */

import { VOCAB_SIZE } from './constants.js';

// ==================== Phoneme Mappings ====================

/**
 * Chinese pinyin to phoneme mapping (SoulX-Singer format).
 * Maps initials + finals to phoneme IDs.
 */
const PINYIN_TO_PHONEME = {
  // Initials
  b: 1, p: 2, m: 3, f: 4,
  d: 5, t: 6, n: 7, l: 8,
  g: 9, k: 10, h: 11,
  j: 12, q: 13, x: 14,
  zh: 15, ch: 16, sh: 17, r: 18,
  z: 19, c: 20, s: 21,
  y: 22, w: 23,

  // Finals
  a: 24, o: 25, e: 26, i: 27, u: 28, v: 29,
  ai: 30, ei: 31, ui: 32,
  ao: 33, ou: 34, iu: 35,
  ie: 36, ve: 37, er: 38,
  an: 39, en: 40, in: 41, un: 42, vn: 43,
  ang: 44, eng: 45, ing: 46, ong: 47,
  ia: 48, iao: 49, ian: 50, iang: 51,
  ua: 52, uo: 53, uai: 54, uan: 55, uang: 56,
  // Special
  sil: 57, sp: 58, ap: 59,
};

/**
 * English phoneme mapping (ARPABET-like → SoulX-Singer IDs).
 */
const EN_TO_PHONEME = {
  AA: 60, AE: 61, AH: 62, AO: 63, AW: 64,
  AY: 65, B: 66, CH: 67, D: 68, DH: 69,
  EH: 70, ER: 71, EY: 72, F: 73, G: 74,
  HH: 75, IH: 76, IY: 77, JH: 78, K: 79,
  L: 80, M: 81, N: 82, NG: 83, OW: 84,
  OY: 85, P: 86, R: 87, S: 88, SH: 89,
  T: 90, TH: 91, UH: 92, UW: 93, V: 94,
  W: 95, Y: 96, Z: 97, ZH: 98,
  sil: 57, sp: 58,
};

/**
 * Japanese phoneme mapping (simple romaji → SoulX-Singer IDs).
 */
const JP_TO_PHONEME = {
  a: 24, i: 27, u: 28, e: 26, o: 25,
  ka: 99, ki: 100, ku: 101, ke: 102, ko: 103,
  sa: 104, shi: 105, su: 106, se: 107, so: 108,
  ta: 109, chi: 110, tsu: 111, te: 112, to: 113,
  na: 114, ni: 115, nu: 116, ne: 117, no: 118,
  ha: 119, hi: 120, fu: 121, he: 122, ho: 123,
  ma: 124, mi: 125, mu: 126, me: 127, mo: 128,
  ya: 129, yu: 130, yo: 131,
  ra: 132, ri: 133, ru: 134, re: 135, ro: 136,
  wa: 137, wo: 138, n: 139,
  ga: 140, gi: 141, gu: 142, ge: 143, go: 144,
  za: 145, ji: 146, zu: 147, ze: 148, zo: 149,
  sil: 57, sp: 58,
  // Extended for SoulX-Singer JP
  kya: 150, kyu: 151, kyo: 152,
  sha: 153, shu: 154, sho: 155,
  cha: 156, chu: 157, cho: 158,
  nya: 159, nyu: 160, nyo: 161,
  hya: 162, hyu: 163, hyo: 164,
  mya: 165, myu: 166, myo: 167,
  rya: 168, ryu: 169, ryo: 170,
  gya: 171, gyu: 172, gyo: 173,
  ja: 174, ju: 175, jo: 176,
  bya: 177, byu: 178, byo: 179,
  pya: 180, pyu: 181, pyo: 182,
};

// ==================== Language Detection ====================

/**
 * Detect the language of a text string.
 *
 * @param {string} text
 * @returns {'zh'|'en'|'ja'|'unknown'}
 */
export function detectLanguage(text) {
  if (!text || text.length === 0) return 'unknown';

  // Count character types
  let cjkCount = 0;
  let latinCount = 0;
  let kanaCount = 0;

  for (const char of text) {
    const code = char.codePointAt(0);
    if (code >= 0x4E00 && code <= 0x9FFF) {
      cjkCount++;
    } else if (code >= 0x3040 && code <= 0x30FF) {
      kanaCount++;
    } else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
      latinCount++;
    }
  }

  if (kanaCount > 0) return 'ja';
  if (cjkCount > latinCount) return 'zh';
  if (latinCount > 0) return 'en';
  return 'unknown';
}

// ==================== Chinese Processing ====================

/**
 * Convert Chinese text to phoneme IDs using pinyin-pro.
 *
 * @param {string} text - Chinese text
 * @param {object} [pinyinPro] - The pinyin-pro module (dynamically imported)
 * @returns {Promise<number[]>} Array of phoneme IDs
 */
export async function chineseToPhonemes(text, pinyinPro) {
  if (!pinyinPro) {
    try {
      pinyinPro = await import('pinyin-pro');
    } catch {
      console.warn('[textProcessing] pinyin-pro not available, falling back to basic mapping');
      return basicChineseToPhonemes(text);
    }
  }

  const result = [];
  // Add silence at start
  result.push(PINYIN_TO_PHONEME.sil);

  // Split text into characters and convert each
  for (const char of text) {
    if (char.trim() === '') {
      result.push(PINYIN_TO_PHONEME.sp);
      continue;
    }

    try {
      // Get pinyin for the character
      const pinyin = pinyinPro.pinyin(char, { toneType: 'none', type: 'array' });
      if (pinyin && pinyin.length > 0) {
        for (const py of pinyin) {
          const phoneId = PINYIN_TO_PHONEME[py];
          if (phoneId !== undefined) {
            result.push(phoneId);
          }
        }
      }
    } catch {
      // Skip characters that can't be converted
    }
  }

  // Add silence at end
  result.push(PINYIN_TO_PHONEME.sil);
  return result;
}

/**
 * Basic Chinese to phoneme conversion without pinyin-pro.
 * Maps common characters directly.
 *
 * @param {string} text
 * @returns {number[]}
 */
function basicChineseToPhonemes(text) {
  const result = [];
  result.push(PINYIN_TO_PHONEME.sil);

  for (const char of text) {
    if (char.trim() === '') {
      result.push(PINYIN_TO_PHONEME.sp);
      continue;
    }
    // In basic mode, each character gets a placeholder vowel
    result.push(PINYIN_TO_PHONEME.a);
  }

  result.push(PINYIN_TO_PHONEME.sil);
  return result;
}

// ==================== English Processing ====================

/**
 * Simple English G2P (grapheme-to-phoneme) conversion.
 * Uses a basic lookup-based approach.
 *
 * @param {string} text - English text
 * @returns {number[]} Array of phoneme IDs
 */
export function englishToPhonemes(text) {
  const result = [];
  result.push(EN_TO_PHONEME.sil);

  const words = text
    .toUpperCase()
    .replace(/[^A-Z\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  for (const word of words) {
    // Simple letter-to-phoneme approximation
    const letters = word.split('');
    for (const letter of letters) {
      // Map letters to approximate phonemes
      if (letter in EN_TO_PHONEME) {
        result.push(EN_TO_PHONEME[letter]);
      }
    }
    result.push(EN_TO_PHONEME.sp);
  }

  result.push(EN_TO_PHONEME.sil);
  return result;
}

// ==================== Japanese Processing ====================

/**
 * Convert Japanese text (romaji or kana) to phoneme IDs.
 *
 * @param {string} text - Japanese text (preferably romaji)
 * @returns {number[]} Array of phoneme IDs
 */
export function japaneseToPhonemes(text) {
  const result = [];
  result.push(JP_TO_PHONEME.sil);

  // Normalise: convert hiragana/katakana to romaji approximation
  const romaji = kanaToBasicRomaji(text);

  // Split into mora (syllables)
  const moraPattern = /([kgszjtdhbpmnryw]?[ゃゅょ]?[あいうえおかきくけこがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽまみむめもやゆよらりるれろわをん]|[aiueon])/g;
  const moras = romaji.match(moraPattern) || [];

  for (const mora of moras) {
    if (mora.trim() === '') continue;
    const phoneId = JP_TO_PHONEME[mora];
    if (phoneId !== undefined) {
      result.push(phoneId);
    }
  }

  result.push(JP_TO_PHONEME.sil);
  return result;
}

/**
 * Simple kana (hiragana/katakana) to basic romaji conversion.
 * This is a minimal mapping; for production use a proper kana-to-romaji library.
 *
 * @param {string} text
 * @returns {string} Romaji approximation
 */
function kanaToBasicRomaji(text) {
  // If already romaji (only latin letters), return as-is
  if (/^[a-zA-Z\s]+$/.test(text)) {
    return text.toLowerCase();
  }

  // Simple hiragana/katakana to romaji mapping
  const kanaMap = {
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
    'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
    'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
    'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
    'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
    'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
    'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
    'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
    'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
    'わ': 'wa', 'を': 'wo', 'ん': 'n',
    'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
    'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
    'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
    'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
    'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
    'ア': 'a', 'イ': 'i', 'ウ': 'u', 'エ': 'e', 'オ': 'o',
    'カ': 'ka', 'キ': 'ki', 'ク': 'ku', 'ケ': 'ke', 'コ': 'ko',
    'サ': 'sa', 'シ': 'shi', 'ス': 'su', 'セ': 'se', 'ソ': 'so',
    'タ': 'ta', 'チ': 'chi', 'ツ': 'tsu', 'テ': 'te', 'ト': 'to',
    'ナ': 'na', 'ニ': 'ni', 'ヌ': 'nu', 'ネ': 'ne', 'ノ': 'no',
    'ハ': 'ha', 'ヒ': 'hi', 'フ': 'fu', 'ヘ': 'he', 'ホ': 'ho',
    'マ': 'ma', 'ミ': 'mi', 'ム': 'mu', 'メ': 'me', 'モ': 'mo',
    'ヤ': 'ya', 'ユ': 'yu', 'ヨ': 'yo',
    'ラ': 'ra', 'リ': 'ri', 'ル': 'ru', 'レ': 're', 'ロ': 'ro',
    'ワ': 'wa', 'ヲ': 'wo', 'ン': 'n',
    'ガ': 'ga', 'ギ': 'gi', 'グ': 'gu', 'ゲ': 'ge', 'ゴ': 'go',
    'ザ': 'za', 'ジ': 'ji', 'ズ': 'zu', 'ゼ': 'ze', 'ゾ': 'zo',
    'ダ': 'da', 'ヂ': 'ji', 'ヅ': 'zu', 'デ': 'de', 'ド': 'do',
    'バ': 'ba', 'ビ': 'bi', 'ブ': 'bu', 'ベ': 'be', 'ボ': 'bo',
    'パ': 'pa', 'ピ': 'pi', 'プ': 'pu', 'ペ': 'pe', 'ポ': 'po',
  };

  let romaji = '';
  for (const char of text) {
    romaji += kanaMap[char] || char;
  }

  return romaji;
}

// ==================== Phoneme Resolution ====================

/**
 * Resolve phoneme IDs from text, auto-detecting language.
 *
 * @param {string} text - Input text
 * @param {object} [options]
 * @param {'auto'|'zh'|'en'|'ja'} [options.language='auto'] - Force a specific language
 * @param {object} [options.pinyinPro] - Pre-imported pinyin-pro module
 * @returns {Promise<{ phonemes: number[], language: string }>}
 */
export async function resolvePhonemes(text, options = {}) {
  const { language = 'auto', pinyinPro } = options;

  const lang = language === 'auto' ? detectLanguage(text) : language;

  let phonemes;
  switch (lang) {
    case 'zh':
      phonemes = await chineseToPhonemes(text, pinyinPro);
      break;
    case 'en':
      phonemes = englishToPhonemes(text);
      break;
    case 'ja':
      phonemes = japaneseToPhonemes(text);
      break;
    default:
      // Default to English-like processing
      phonemes = englishToPhonemes(text);
      break;
  }

  // Validate phoneme IDs are within vocabulary range
  const validPhonemes = phonemes.filter((id) => id >= 0 && id < VOCAB_SIZE);

  return {
    phonemes: validPhonemes,
    language: lang,
  };
}

/**
 * Convert phoneme IDs back to a human-readable representation (for debugging).
 *
 * @param {number[]} phonemeIds
 * @returns {string}
 */
export function phonemeIdsToString(phonemeIds) {
  const reverseMap = {};
  for (const [key, value] of Object.entries(PINYIN_TO_PHONEME)) {
    reverseMap[value] = key;
  }
  for (const [key, value] of Object.entries(EN_TO_PHONEME)) {
    reverseMap[value] = key;
  }

  return phonemeIds.map((id) => reverseMap[id] || `?${id}`).join(' ');
}

export default {
  detectLanguage,
  chineseToPhonemes,
  englishToPhonemes,
  japaneseToPhonemes,
  resolvePhonemes,
  phonemeIdsToString,
};