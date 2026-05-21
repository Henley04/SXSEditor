const { mergePhoneme } = require('../src/utils/mergePhoneme');
const { expect } = require('chai');

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

  it('should set noteType=3 for slur notes', () => {
    const notes = [
      { pitch: 60, start: 0, duration: 0.5, lyric: 'a' },
      { pitch: 62, start: 0.5, duration: 0.5, lyric: '', isSlur: true },
    ];
    const result = mergePhoneme(notes);
    expect(result.length).to.equal(2);
    expect(result[1].isSlur).to.be.true;
  });

  it('should set noteType=3 for continuation notes', () => {
    const notes = [
      { pitch: 60, start: 0, duration: 0.5, lyric: 'a' },
      { pitch: 62, start: 0.5, duration: 0.5, lyric: '', isContinuation: true },
    ];
    const result = mergePhoneme(notes);
    expect(result.length).to.equal(2);
    expect(result[1].isContinuation).to.be.true;
  });

  it('should handle SP + lyric + slur mixed sequence', () => {
    const notes = [
      { pitch: 0, start: 0, duration: 0.25, lyric: '' },
      { pitch: 0, start: 0.25, duration: 0.25, lyric: '' },
      { pitch: 60, start: 0.5, duration: 0.5, lyric: 'a' },
      { pitch: 62, start: 1.0, duration: 0.5, lyric: '', isSlur: true },
    ];
    const result = mergePhoneme(notes);
    // 前两个 SP 音高相同应合并
    expect(result.length).to.equal(3);
    expect(result[0].duration).to.equal(0.5);
    expect(result[0].lyric).to.equal('');
    expect(result[1].lyric).to.equal('a');
    expect(result[2].isSlur).to.be.true;
  });

  it('should preserve id and start properties after merging', () => {
    const notes = [
      { id: 101, pitch: 0, start: 0, duration: 0.5, lyric: '' },
      { id: 102, pitch: 0, start: 0.5, duration: 0.5, lyric: '' },
      { id: 103, pitch: 60, start: 1.0, duration: 0.5, lyric: 'a' },
    ];
    const result = mergePhoneme(notes);
    // 合并后的 SP 保留第一个音符的 id 和 start
    expect(result[0].id).to.equal(101);
    expect(result[0].start).to.equal(0);
    // 非 SP 音符保留原始 id 和 start
    expect(result[1].id).to.equal(103);
    expect(result[1].start).to.equal(1.0);
  });
});
