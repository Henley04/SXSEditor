/**
 * mel_transform 输入精度判定。
 *
 * 背景：官方 SoulX-Singer 的 FP16 路径是 `model.half(); model.mel.float()`
 * —— 网络半精度、参考音频的 mel 变换保持 FP32。本应用在 FP16 精度下会把
 * mel_transform 换成根目录的 FP32 版本，此时全局 isFP16 仍为 true。
 * 构造输入张量必须看会话自己声明的类型，否则会喂错 dtype（DML 直接报
 * "Unexpected input data type"）。
 */
const { expect } = require('chai');
const { __test } = require('../src/inference/pipeline/postprocessing');
const { sessionInputFloatType } = __test;

describe('pipeline/melTransform precision selection', () => {
  it('reads float16 from array-style inputMetadata', () => {
    const session = { inputMetadata: [{ name: 'waveform', type: 'float16', shape: [1, 3] }] };
    expect(sessionInputFloatType(session, 'waveform', false)).to.equal('float16');
  });

  it('reads float32 from array-style metadata even when the global precision is fp16', () => {
    // FP16 精度 + 根目录 FP32 mel_transform 的实际组合
    const session = { inputMetadata: [{ name: 'waveform', type: 'float32', shape: [1, 3] }] };
    expect(sessionInputFloatType(session, 'waveform', true)).to.equal('float32');
  });

  it('reads object-style metadata (name -> {type})', () => {
    const session = { inputMetadata: { audio: { type: 'tensor(float16)', shape: [1, 3] } } };
    expect(sessionInputFloatType(session, 'audio', false)).to.equal('float16');
  });

  it('picks the matching entry when several inputs exist', () => {
    const session = {
      inputMetadata: [
        { name: 'audio', type: 'float32' },
        { name: 'waveform', type: 'float16' },
      ],
    };
    expect(sessionInputFloatType(session, 'waveform', false)).to.equal('float16');
  });

  it('falls back to the global precision when metadata is missing', () => {
    expect(sessionInputFloatType({}, 'waveform', true)).to.equal('float16');
    expect(sessionInputFloatType({}, 'waveform', false)).to.equal('float32');
    expect(sessionInputFloatType(null, 'waveform', true)).to.equal('float16');
  });

  it('falls back when metadata has no recognisable type', () => {
    const session = { inputMetadata: [{ name: 'waveform', type: { weird: true } }] };
    expect(sessionInputFloatType(session, 'waveform', false)).to.equal('float32');
  });
});
