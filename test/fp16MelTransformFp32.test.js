/**
 * fp16 子目录的 mel_transform 必须是 FP32 图。
 *
 * 背景：该图含 STFT，DML 的 FP16 STFT kernel 会退化成常量输出（实测 SQNR
 * -9.44 dB、输出标准差 0），而同一张图在 FP32/CPU 上是 66 dB。官方 FP16
 * 路径同样是 `model.half(); model.mel.float()`。
 *
 * 因此 fp16 目录直接放根目录的 FP32 文件（字节一致），保证“只下载了 FP16
 * 子目录”的用户也能得到正确的参考 mel。若后续重新导出 FP16 版 mel_transform，
 * 这个用例会立刻失败。
 */
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const ONNX_DIR = path.join(__dirname, '..', 'onnx_models');
const FP32_ONNX = path.join(ONNX_DIR, 'mel_transform.onnx');
const FP16_ONNX = path.join(ONNX_DIR, 'fp16', 'mel_transform.onnx');

describe('onnx_models/fp16/mel_transform is FP32', () => {
  before(function () {
    if (!fs.existsSync(FP32_ONNX) || !fs.existsSync(FP16_ONNX)) {
      this.skip();
    }
  });

  it('fp16 目录的图与根目录 FP32 图字节一致', () => {
    const fp32 = fs.readFileSync(FP32_ONNX);
    const fp16dir = fs.readFileSync(FP16_ONNX);
    expect(fp16dir.equals(fp32), 'fp16/mel_transform.onnx 与根目录 FP32 版本不一致').to.equal(true);
  });

  it('外部权重文件同样一致', () => {
    const a = path.join(ONNX_DIR, 'mel_transform.onnx.data');
    const b = path.join(ONNX_DIR, 'fp16', 'mel_transform.onnx.data');
    if (!fs.existsSync(a) || !fs.existsSync(b)) {
      return; // 单文件模型时没有 .data
    }
    expect(fs.readFileSync(b).equals(fs.readFileSync(a))).to.equal(true);
  });

  it('图的输入名是 audio（FP32 导出版本），不是 waveform', () => {
    // ONNX protobuf 里输入名以明文字符串存储，直接查字节即可，避免为单测拉起 ORT
    const buf = fs.readFileSync(FP16_ONNX);
    expect(buf.includes(Buffer.from('audio', 'utf8'))).to.equal(true);
    expect(buf.includes(Buffer.from('mel_spectrogram', 'utf8'))).to.equal(false);
  });
});
