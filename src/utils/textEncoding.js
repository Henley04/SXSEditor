'use strict';

let iconv = null;
try { iconv = require('iconv-lite'); } catch (_) {}

const MIDI_TEXT_ENCODINGS = ['gb18030', 'shift_jis', 'big5', 'windows-1252'];
const COMMON_CJK = new Set('的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理世车价始院北热额效改头界门利海受听表德少克代员许稽繁體歌詞你好吗呢啊吧着什麼么国语乐爱梦声唱哭笑怕等找说忍恨陪心世界');

function _scoreText(text) {
  if (!text) return -1000;
  let score = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (ch === '\uFFFD') score -= 30;
    else if ((cp < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r') || (cp >= 0x7f && cp <= 0x9f)) score -= 8;
    else if (cp >= 0x3040 && cp <= 0x30ff) score += 6;
    else if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af)) {
      score += 3;
      if (COMMON_CJK.has(ch)) score += 3;
    }
    else if (/\p{L}|\p{N}|\p{P}|\p{Z}/u.test(ch)) score += 1;
  }
  // Frequent mojibake markers produced when UTF-8 Chinese is decoded as GBK.
  const suspicious = text.match(/[ÃÂâ€鍚鍛鍟鍢鐨鐫涔]/g);
  if (suspicious) score -= suspicious.length * 4;
  return score;
}

function _decode(bytes, encoding, fatal = false) {
  try {
    const decoded = new TextDecoder(encoding, { fatal }).decode(bytes);
    // Small-ICU Node/Electron builds may accept a legacy label but replace
    // every non-ASCII byte. Prefer iconv-lite when that happens.
    if (!fatal && decoded.includes('\uFFFD') && iconv) {
      try { return iconv.decode(Buffer.from(bytes), encoding); } catch (_) {}
    }
    return decoded;
  } catch (_) {
    // A fatal decode is used as a validity probe; never replace invalid
    // bytes in that mode or every legacy charset would look like UTF-8.
    if (fatal || !iconv) return null;
    try { return iconv.decode(Buffer.from(bytes), encoding); } catch (_) { return null; }
  }
}

/** Decode a MIDI text/lyric meta event without assuming a single charset. */
function decodeMidiText(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length === 0) return '';

  // UTF BOMs are authoritative.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return _decode(bytes.subarray(3), 'utf-8') || '';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return _decode(bytes.subarray(2), 'utf-16le') || '';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return _decode(bytes.subarray(2), 'utf-16be') || '';

  // Valid UTF-8 must win. This preserves UTF-8 MIDI exactly and avoids
  // heuristic misclassification of ordinary ASCII/Unicode text.
  const utf8 = _decode(bytes, 'utf-8', true);
  if (utf8 !== null) return utf8.replace(/^\uFEFF/, '');

  let best = '';
  let bestScore = -Infinity;
  for (const encoding of MIDI_TEXT_ENCODINGS) {
    const decoded = _decode(bytes, encoding, false);
    if (decoded === null) continue;
    const score = _scoreText(decoded);
    if (score > bestScore) { best = decoded; bestScore = score; }
  }
  return best || _decode(bytes, 'utf-8', false) || '';
}

/**
 * Repair a lyric already mojibaked by decoding UTF-8 bytes as GBK/Big5/etc.
 * Returns the original string unless a round-trip candidate is clearly better.
 */
function repairMojibake(text) {
  if (typeof text !== 'string' || text.length === 0 || !iconv) return text;
  const originalScore = _scoreText(text);
  let best = text;
  let bestScore = originalScore;
  for (const mistakenEncoding of ['gbk', 'gb18030', 'big5', 'shift_jis', 'windows-1252']) {
    try {
      const bytes = iconv.encode(text, mistakenEncoding);
      const repaired = _decode(bytes, 'utf-8', true);
      if (!repaired || repaired.includes('\uFFFD')) continue;
      const score = _scoreText(repaired);
      if (score >= bestScore + 4) { best = repaired; bestScore = score; }
    } catch (_) {}
  }
  return best;
}

module.exports = { decodeMidiText, repairMojibake };
