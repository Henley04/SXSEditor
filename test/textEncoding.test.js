const { expect } = require('chai');
const iconv = require('iconv-lite');
const { decodeMidiText, repairMojibake } = require('../src/utils/textEncoding');

describe('MIDI text encoding', () => {
  it('preserves valid UTF-8 lyrics', () => {
    expect(decodeMidiText(Buffer.from('着吧吗 UTF-8', 'utf8'))).to.equal('着吧吗 UTF-8');
  });

  it('detects common legacy Chinese MIDI encodings', () => {
    expect(decodeMidiText(iconv.encode('你好世界', 'gbk'))).to.equal('你好世界');
    expect(decodeMidiText(iconv.encode('繁體歌詞', 'big5'))).to.equal('繁體歌詞');
  });

  it('detects Shift-JIS MIDI lyrics', () => {
    expect(decodeMidiText(iconv.encode('かなカナ', 'shift_jis'))).to.equal('かなカナ');
  });

  it('repairs reversible UTF-8-as-GBK mojibake', () => {
    expect(repairMojibake('鐫€')).to.equal('着');
    expect(repairMojibake('正常歌词')).to.equal('正常歌词');
  });
});
