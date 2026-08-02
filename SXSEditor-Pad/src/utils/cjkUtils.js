/**
 * cjkUtils.js
 * CJK (Chinese/Japanese/Korean) text utilities for SXSEditor-Pad.
 *
 * @module utils/cjkUtils
 */

// Unicode ranges for CJK characters
const CJK_RANGES = [
  [0x4E00, 0x9FFF],   // CJK Unified Ideographs
  [0x3400, 0x4DBF],   // CJK Unified Ideographs Extension A
  [0x2E80, 0x2EFF],   // CJK Radicals Supplement
  [0x3000, 0x303F],   // CJK Symbols and Punctuation
  [0x31C0, 0x31EF],   // CJK Strokes
  [0x2F00, 0x2FDF],   // Kangxi Radicals
  [0xF900, 0xFAFF],   // CJK Compatibility Ideographs
  [0xFE30, 0xFE4F],   // CJK Compatibility Forms
  [0x20000, 0x2A6DF],  // CJK Unified Ideographs Extension B
  [0x2A700, 0x2B73F],  // CJK Unified Ideographs Extension C
  [0x2B740, 0x2B81F],  // CJK Unified Ideographs Extension D
  [0x2B820, 0x2CEAF],  // CJK Unified Ideographs Extension E
  [0x2CEB0, 0x2EBEF],  // CJK Unified Ideographs Extension F
  [0x30000, 0x3134F],  // CJK Unified Ideographs Extension G
  [0x31350, 0x323AF],  // CJK Unified Ideographs Extension H
];

// Hiragana, Katakana, and Hangul ranges
const JAPANESE_RANGES = [
  [0x3040, 0x309F],   // Hiragana
  [0x30A0, 0x30FF],   // Katakana
  [0x31F0, 0x31FF],   // Katakana Phonetic Extensions
];

const KOREAN_RANGES = [
  [0xAC00, 0xD7AF],   // Hangul Syllables
  [0x1100, 0x11FF],   // Hangul Jamo
  [0x3130, 0x318F],   // Hangul Compatibility Jamo
  [0xA960, 0xA97F],   // Hangul Jamo Extended-A
  [0xD7B0, 0xD7FF],   // Hangul Jamo Extended-B
];

/**
 * Check if a character falls within any of the given Unicode ranges.
 * @param {string} char - Single character to check
 * @param {number[][]} ranges - Array of [start, end] Unicode ranges
 * @returns {boolean}
 */
function inRanges(char, ranges) {
  const code = char.charCodeAt(0);
  // Handle surrogate pairs
  const fullCode = code >= 0xD800 && code <= 0xDBFF
    ? ((code - 0xD800) * 0x400) + 0x10000
    : code;
  return ranges.some(([start, end]) => fullCode >= start && fullCode <= end);
}

/**
 * Detect if text contains CJK characters.
 * @param {string} text - Input text
 * @returns {boolean} True if text contains any CJK character
 */
export function hasCJK(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    if (inRanges(text[i], CJK_RANGES)) return true;
  }
  return false;
}

/**
 * Detect if text contains Japanese characters (Hiragana/Katakana).
 * @param {string} text - Input text
 * @returns {boolean}
 */
export function hasJapanese(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    if (inRanges(text[i], JAPANESE_RANGES)) return true;
  }
  return false;
}

/**
 * Detect if text contains Korean characters (Hangul).
 * @param {string} text - Input text
 * @returns {boolean}
 */
export function hasKorean(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    if (inRanges(text[i], KOREAN_RANGES)) return true;
  }
  return false;
}

/**
 * Check if a single character is a CJK character.
 * @param {string} char - Single character
 * @returns {boolean}
 */
export function isCJK(char) {
  if (typeof char !== 'string' || char.length === 0) return false;
  return inRanges(char, CJK_RANGES);
}

/**
 * Split text into alternating CJK and non-CJK segments.
 * Each segment is an object with { text, type } where type is 'cjk' or 'non-cjk'.
 * @param {string} text - Input text
 * @returns {Array<{text: string, type: 'cjk' | 'non-cjk'}>}
 */
export function splitCJK(text) {
  if (typeof text !== 'string') return [];

  const segments = [];
  let current = '';
  let currentType = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const isCJKChar = isCJK(char);
    const type = isCJKChar ? 'cjk' : 'non-cjk';

    if (currentType === null) {
      currentType = type;
      current = char;
    } else if (currentType === type) {
      current += char;
    } else {
      segments.push({ text: current, type: currentType });
      current = char;
      currentType = type;
    }
  }

  if (current) {
    segments.push({ text: current, type: currentType });
  }

  return segments;
}

/**
 * Convert full-width characters to half-width equivalents.
 * Covers letters, digits, and common symbols.
 * @param {string} str - Input string with possible full-width characters
 * @returns {string} String with full-width characters converted to half-width
 */
export function fullwidthToHalfwidth(str) {
  if (typeof str !== 'string') return '';

  return str.replace(/[\uFF01-\uFF5E]/g, (char) => {
    const code = char.charCodeAt(0);
    // Full-width range maps to ASCII range 0x21-0x7E
    return String.fromCharCode(code - 0xFEE0);
  }).replace(/\u3000/g, ' '); // Full-width space to half-width space
}

/**
 * Convert half-width characters to full-width equivalents.
 * Covers letters, digits, and common symbols.
 * @param {string} str - Input string with possible half-width characters
 * @returns {string} String with half-width characters converted to full-width
 */
export function halfwidthToFullwidth(str) {
  if (typeof str !== 'string') return '';

  return str.replace(/[\u0021-\u007E]/g, (char) => {
    const code = char.charCodeAt(0);
    return String.fromCharCode(code + 0xFEE0);
  }).replace(/ /g, '\u3000'); // Half-width space to full-width space
}

/**
 * Count the number of CJK characters in a string.
 * @param {string} text - Input text
 * @returns {number} Count of CJK characters
 */
export function countCJK(text) {
  if (typeof text !== 'string') return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCJK(text[i])) count++;
  }
  return count;
}

/**
 * Get the display width of a string (CJK chars count as 2, others as 1).
 * Useful for aligning text in monospace contexts.
 * @param {string} text - Input text
 * @returns {number} Display width
 */
export function getDisplayWidth(text) {
  if (typeof text !== 'string') return 0;
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    width += isCJK(text[i]) ? 2 : 1;
  }
  return width;
}

export default {
  hasCJK,
  hasJapanese,
  hasKorean,
  isCJK,
  splitCJK,
  fullwidthToHalfwidth,
  halfwidthToFullwidth,
  countCJK,
  getDisplayWidth,
};