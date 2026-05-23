/**
 * 判断字符是否为 CJK（中日韩）字符
 */
function isCJK(char) {
  const code = char.codePointAt(0) || 0;
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0x20000 && code <= 0x2A6DF) ||
    (code >= 0x3040 && code <= 0x309F) ||
    (code >= 0x30A0 && code <= 0x30FF) ||
    (code >= 0xAC00 && code <= 0xD7AF)
  );
}

/**
 * 将歌词字符串分词为音素单元
 */
function tokenizeLyric(text) {
  if (!text || text.trim().length === 0) return [];
  const cleaned = text.trim();
  const tokens = [];
  let word = '';
  for (const char of cleaned) {
    if (/\s/.test(char)) {
      if (word) { tokens.push(word); word = ''; }
      continue;
    }
    if (isCJK(char)) {
      if (word) { tokens.push(word); word = ''; }
      tokens.push(char);
      continue;
    }
    word += char;
  }
  if (word) tokens.push(word);
  return tokens;
}

module.exports = { isCJK, tokenizeLyric };
