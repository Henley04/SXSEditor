'use strict';
/**
 * 分片级 MIDI 导出（format 0，单轨）。
 *
 * 背景：SMF 编码基元已上收到 src/shared/midiWriter.js，供分片导出与项目级
 * 多轨导出共用。这次重构没有改变行为，但也没有任何用例守着它 —— 重新跑一遍
 * header / 轨数 / end-of-track，防止"抽公共代码"时把单轨写成了多轨。
 */
const { expect } = require('chai');

let encodeFragmentMidi;
before(async () => {
  // canvasRenderer 在模块加载时就取 #piano-roll / #piano-keys 的 context。
  // mocha 会先加载全部用例文件再执行，body 可能已被别的文件替换过，
  // 所以在 import 之前按需重建。
  document.body.innerHTML =
    '<canvas id="piano-roll"></canvas><canvas id="piano-keys"></canvas>';
  ({ encodeFragmentMidi } = await import('../src/fragmentEditor/midiExport.js'));
});

const NOTES = [
  { pitch: 60, start: 0, duration: 1, lyric: 'la' },
  { pitch: 62, start: 1, duration: 1, lyric: '-' },
];

describe('encodeFragmentMidi — 单轨 SMF', () => {
  it('format 0、单轨、PPQ 480，并以 end-of-track 收尾', () => {
    const bytes = encodeFragmentMidi(NOTES, 120, 'Frag', [4, 4], null);
    expect(Buffer.from(bytes.subarray(0, 4)).toString('ascii')).to.equal('MThd');
    const format = (bytes[8] << 8) | bytes[9];
    const ntrks = (bytes[10] << 8) | bytes[11];
    const ppq = (bytes[12] << 8) | bytes[13];
    expect(format).to.equal(0);
    expect(ntrks).to.equal(1);
    expect(ppq).to.equal(480);
    expect(Buffer.from(bytes.subarray(-4)).toString('hex')).to.equal('00ff2f00');
  });

  it('包含两个音符的开与关，速度元事件按 BPM 换算', () => {
    const bytes = encodeFragmentMidi(NOTES, 120, 'Frag', [4, 4], null);
    const hex = Buffer.from(bytes).toString('hex');
    expect(hex).to.include('903c60'); // note on  pitch 0x3c=60 vel 0x60=96
    expect(hex).to.include('803c00'); // note off pitch 60
    expect(hex).to.include('903e60'); // note on  pitch 0x3e=62
    // 120 BPM → 500000 µs/quarter → 0x07A120
    expect(hex).to.include('ff510307a120');
  });

  it('MTrk 声明长度与实际数据一致', () => {
    const bytes = encodeFragmentMidi(NOTES, 90, 'Frag', [6, 8], null);
    expect(Buffer.from(bytes.subarray(14, 18)).toString('ascii')).to.equal('MTrk');
    const len = ((bytes[18] << 24) | (bytes[19] << 16) | (bytes[20] << 8) | bytes[21]) >>> 0;
    expect(bytes.length).to.equal(22 + len);
  });
});
