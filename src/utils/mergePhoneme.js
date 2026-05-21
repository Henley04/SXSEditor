/**
 * mergePhoneme - 合并连续的 SP（静音）音符
 * 将连续的、相同音高的 SP 音符合并为一个，减少冗余音素。
 * <AP> 会被统一替换为 <SP>。
 */

function mergePhoneme(notes) {
  const merged = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const lyric = (n.lyric || '').replace('<AP>', '<SP>');
    const isSP = !lyric.trim() || lyric === '<SP>';
    const hasLyric = lyric.trim().length > 0 && !isSP;
    const isSlur = n.isSlur || n.isContinuation;
    let noteType;
    if (!hasLyric && isSP) {
      noteType = 1;
    } else if (isSlur) {
      noteType = 3;
    } else {
      noteType = 2;
    }
    if (
      i > 0 &&
      merged.length > 0 &&
      isSP &&
      !merged[merged.length - 1].hasLyric &&
      merged[merged.length - 1].isSP &&
      noteType === merged[merged.length - 1].noteType &&
      n.pitch === merged[merged.length - 1].pitch
    ) {
      merged[merged.length - 1].duration += n.duration;
    } else {
      merged.push({
        lyric: isSP ? '<SP>' : lyric,
        pitch: n.pitch,
        duration: n.duration,
        start: n.start,
        id: n.id,
        isSlur: isSlur,
        isContinuation: n.isContinuation,
        hasLyric: hasLyric,
        isSP: isSP,
        noteType: noteType,
      });
    }
  }
  return merged.map(m => ({
    lyric: m.isSP ? '' : m.lyric,
    pitch: m.pitch,
    duration: m.duration,
    start: m.start,
    id: m.id,
    isSlur: m.isSlur,
    isContinuation: m.isContinuation,
  }));
}

module.exports = { mergePhoneme };
