/**
 * 歌词语言检测（纯函数，无副作用）
 *
 * 从 svsIpc.js 提取，便于单独测试与复用。
 * 决定 SVS 管线切换 JP LoRA 模型还是 base multilingual 模型。
 */

/**
 * 检测歌词中是否包含日文。
 * 判定依据：jp_ 前缀（日语音素标记）或日文假名/片假名字符。
 * @param {Array<{lyric?: string}>} notes
 * @returns {boolean}
 */
function detectJapaneseNotes(notes) {
  if (!notes || !Array.isArray(notes)) return false;
  for (const note of notes) {
    const lyric = note.lyric || '';
    if (!lyric) continue;
    if (lyric.startsWith('jp_') || lyric.includes('jp_')) return true;
    if (/[ぁ-ゟァ-ヿ]/.test(lyric)) return true;
  }
  return false;
}

/**
 * 检测歌词中是否包含英文（拉丁字母）。
 * JP LoRA 模型的训练数据完全没有英文音素，对英文+多音素 note 会 OOD 崩溃
 * （例如 apples → 只发出 P AH0）。因此检测到英文时必须回退到 base 模型。
 * jp_ 前缀和日文假名不算英文。
 * @param {Array<{lyric?: string}>} notes
 * @returns {boolean}
 */
function detectEnglishNotes(notes) {
  if (!notes || !Array.isArray(notes)) return false;
  for (const note of notes) {
    const lyric = note.lyric || '';
    if (!lyric) continue;
    // 跳过 jp_ 前缀（日语音素）和日文假名
    if (lyric.startsWith('jp_') || lyric.includes('jp_')) continue;
    if (/[ぁ-ゟァ-ヿ]/.test(lyric)) continue;
    // 跳过静音/呼吸标记（SP=<SP>, AP=<AP>），它们不是英文歌词
    const norm = lyric.replace(/[<>]/g, '').toUpperCase();
    if (norm === 'SP' || norm === 'AP') continue;
    // 检测拉丁字母（英文）
    if (/[a-zA-Z]/.test(lyric)) return true;
  }
  return false;
}

/**
 * 根据歌词决定使用的语言模型：
 * - 纯日文 → 'ja'（JP LoRA 模型）
 * - 含英文（含日英混合）→ null（base multilingual 模型，含英文训练数据）
 * - 其他 → null（base 模型）
 *
 * 当 japaneseVocalization === 'en-phonemes' 时，日文歌词使用英语音素在 base 模型上合成，
 * 永远返回 null（不切换 JP LoRA 模型）。
 *
 * @param {Array<{lyric?: string}>} notes
 * @param {string} [japaneseVocalization='en-phonemes'] - 'en-phonemes' | 'jp-lora'
 * @returns {string|null} 'ja' 或 null
 */
function resolveLanguage(notes, japaneseVocalization = 'en-phonemes') {
  // en-phonemes 模式：日文歌词用英语音素在 base 模型上合成，不切换 JP LoRA
  if (japaneseVocalization === 'en-phonemes') return null;
  // jp-lora 模式：使用原有逻辑检测语言
  const isJapanese = detectJapaneseNotes(notes);
  const hasEnglish = detectEnglishNotes(notes);
  if (hasEnglish) return null; // 含英文 → base 模型（JP 模型对英文 OOD）
  if (isJapanese) return 'ja'; // 纯日文 → JP 模型
  return null;
}

module.exports = {
  detectJapaneseNotes,
  detectEnglishNotes,
  resolveLanguage,
};
