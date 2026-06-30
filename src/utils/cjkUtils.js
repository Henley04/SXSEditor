/**
 * 判断字符是否为 CJK（中日韩）字符
 * 非字符串/空输入返回 false，避免在调用方传入 null/undefined 时抛错。
 */
function isCJK(char) {
  if (typeof char !== 'string' || char.length === 0) return false;
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
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (/\s/.test(char)) {
      if (word) { tokens.push(word); word = ''; }
      continue;
    }
    if (isCJK(char)) {
      if (word) { tokens.push(word); word = ''; }
      let token = char;
      if (i + 1 < cleaned.length && /[1-5]/.test(cleaned[i + 1])) {
        token += cleaned[i + 1];
        i++;
      }
      tokens.push(token);
      continue;
    }
    word += char;
  }
  if (word) tokens.push(word);
  return tokens;
}

module.exports = { isCJK, tokenizeLyric };
