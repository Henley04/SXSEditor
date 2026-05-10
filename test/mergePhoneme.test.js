const { expect } = require('chai');

function mergePhoneme(notes) {
  const merged = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const lyric = (n.lyric || '').replace('<AP>', '<SP>');
    n.lyric = lyric;
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

describe('mergePhoneme', () => {
  it('should merge two consecutive SP notes with same pitch', () => {
    const notes = [
      { pitch: 0, start: 0, duration: 0.5, lyric: '' },
      { pitch: 0, start: 0.5, duration: 0.5, lyric: '' },
    ];
    const result = mergePhoneme(notes);
    expect(result.length).to.equal(1);
    expect(result[0].duration).to.equal(1);
    expect(result[0].lyric).to.equal('');
  });

  it('should NOT merge two consecutive SP notes with different pitch', () => {
    const notes = [
      { pitch: 0, start: 0, duration: 0.5, lyric: '' },
      { pitch: 60, start: 0.5, duration: 0.5, lyric: '' },
    ];
    const result = mergePhoneme(notes);
    expect(result.length).to.equal(2);
  });

  it('should NOT merge SP note followed by non-SP note', () => {
    const notes = [
      { pitch: 0, start: 0, duration: 0.5, lyric: '' },
      { pitch: 60, start: 0.5, duration: 0.5, lyric: 'a' },
    ];
    const result = mergePhoneme(notes);
    expect(result.length).to.equal(2);
    expect(result[1].lyric).to.equal('a');
  });

  it('should replace <AP> with <SP>', () => {
    const notes = [
      { pitch: 0, start: 0, duration: 0.5, lyric: '<AP>' },
    ];
    const result = mergePhoneme(notes);
    expect(result.length).to.equal(1);
    expect(result[0].lyric).to.equal('');
  });

  it('should merge consecutive <AP> notes with same pitch', () => {
    const notes = [
      { pitch: 0, start: 0, duration: 0.25, lyric: '<AP>' },
      { pitch: 0, start: 0.25, duration: 0.25, lyric: '<AP>' },
    ];
    const result = mergePhoneme(notes);
    expect(result.length).to.equal(1);
    expect(result[0].duration).to.equal(0.5);
  });

  it('should NOT merge consecutive SP notes with different pitch values', () => {
    const notes = [
      { pitch: 0, start: 0, duration: 0.5, lyric: '<SP>' },
      { pitch: 1, start: 0.5, duration: 0.5, lyric: '<SP>' },
    ];
    const result = mergePhoneme(notes);
    expect(result.length).to.equal(2);
  });

  it('should preserve non-SP notes without merging', () => {
    const notes = [
      { pitch: 60, start: 0, duration: 1, lyric: 'a' },
      { pitch: 62, start: 1, duration: 1, lyric: 'b' },
    ];
    const result = mergePhoneme(notes);
    expect(result.length).to.equal(2);
    expect(result[0].lyric).to.equal('a');
    expect(result[1].lyric).to.equal('b');
  });

  it('should handle empty input', () => {
    const result = mergePhoneme([]);
    expect(result.length).to.equal(0);
  });
});
