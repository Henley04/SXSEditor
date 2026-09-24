const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OnnxSVSPipeline } = require('../src/inference/pipeline');

/**
 * Vocoder 精度自动检测回归测试。
 *
 * 背景：WinMLSession(ortBridge) / onnxruntime-node 的 inputMetadata 都是数组
 *   [{name,type,shape}]，旧实现误按对象 meta['mel'] 索引，恒为 undefined，
 *   误退回文件大小启发式。W16A32 vocoder（权重 FP16、mel 输入 float32，
 *   external data 名 vocoder_w16a32.onnx.data，graph 常被改名为
 *   vocoder_dml.onnx）体积 ~495MB < 700MB 阈值，被错判成 float16 输入，
 *   给 TRT-RTX 等严格 EP 喂 float16 而报
 *   "Unexpected input data type. Actual: float16, expected: float"。
 */
describe('Vocoder precision detection (_detectVocoderPrecision)', () => {
  let pipeline;
  let tmpDir;

  beforeEach(() => {
    pipeline = new OnnxSVSPipeline('/fake/model/dir/', {});
    pipeline.isFP16 = true; // 全局精度为 fp16，验证 vocoder 检测能独立得出不同结论
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voc-prec-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  // 构造一个 graph 字节内含 external_data.location 字符串的伪 onnx 文件
  function writeFakeGraph(fileName, markerText = '') {
    const filePath = path.join(tmpDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(`ONNX fake graph ${markerText}`, 'latin1'));
    return filePath;
  }

  function winmlSession(melType) {
    return {
      inputNames: ['mel'],
      // WinMLSession 形态：数组
      inputMetadata: [{ name: 'mel', isTensor: true, type: melType, shape: [1, -1, 128] }],
    };
  }

  it('W16A32 模型（数组 metadata 声明 mel=float32，proto 含 w16a32 标记）→ vocoderIsFP16=false', async () => {
    // 复现用户部署：graph 改名 vocoder_dml.onnx，但 internal location 仍是 w16a32 文件名
    const modelPath = writeFakeGraph('vocoder_dml.onnx', 'vocoder_w16a32.onnx.data');
    await pipeline._detectVocoderPrecision(winmlSession('float32'), modelPath);
    expect(pipeline.vocoderIsW16A32, 'W16A32 marker should be detected from proto bytes').to.equal(true);
    expect(pipeline.vocoderIsFP16, 'W16A32 mel input is float32').to.equal(false);
  });

  it('数组 metadata 声明 mel=float16 时以会话契约为准（即使全局 isFP16=false 的反例同理）', async () => {
    pipeline.isFP16 = false;
    await pipeline._detectVocoderPrecision(winmlSession('float16'), path.join(tmpDir, 'vocoder_dml.onnx'));
    expect(pipeline.vocoderIsFP16).to.equal(true);
    expect(pipeline.vocoderIsW16A32).to.equal(false);
  });

  it('兼容历史对象形态 metadata {mel:{type}}', async () => {
    const session = {
      inputNames: ['mel'],
      inputMetadata: { mel: { name: 'mel', type: 'float32', shape: [1, -1, 128] } },
    };
    await pipeline._detectVocoderPrecision(session, path.join(tmpDir, 'vocoder_dml.onnx'));
    expect(pipeline.vocoderIsFP16).to.equal(false);
  });

  it('metadata 缺失但文件含 W16A32 标记 → 固定 float32，不走文件大小误判', async () => {
    const modelPath = writeFakeGraph('vocoder_dml.onnx', 'vocoder_w16a32.onnx.data');
    const session = { inputNames: ['mel'] }; // 无 inputMetadata
    await pipeline._detectVocoderPrecision(session, modelPath);
    expect(pipeline.vocoderIsW16A32).to.equal(true);
    expect(pipeline.vocoderIsFP16).to.equal(false);
  });

  it('metadata 缺失且无标记时保留文件大小启发式（小文件 → FP16）', async () => {
    const modelPath = writeFakeGraph('vocoder_dml.onnx');
    const session = { inputNames: ['mel'] };
    await pipeline._detectVocoderPrecision(session, modelPath);
    expect(pipeline.vocoderIsW16A32).to.equal(false);
    expect(pipeline.vocoderIsFP16).to.equal(true);
  });

  it('graph 文件名本身含 w16a32 时也能识别标记', async () => {
    const modelPath = writeFakeGraph('vocoder_w16a32.onnx');
    await pipeline._detectVocoderPrecision(winmlSession('float32'), modelPath);
    expect(pipeline.vocoderIsW16A32).to.equal(true);
    expect(pipeline.vocoderIsFP16).to.equal(false);
  });

  it('_inspectVocoderModelFile 能从 proto 字节提取 external data 文件名', () => {
    const modelPath = writeFakeGraph('vocoder_dml.onnx', 'xxx vocoder_w16a32.onnx.data yyy');
    const info = pipeline._inspectVocoderModelFile(modelPath);
    expect(info.w16a32).to.equal(true);
    expect(info.dataFiles).to.include('vocoder_w16a32.onnx.data');
  });

  it('SiFiGAN 仍按文件名判定精度（fp16 变体 → true）', async () => {
    const modelPath = path.join(tmpDir, 'sifigan_vocoder_dml_fp16.onnx');
    fs.writeFileSync(modelPath, Buffer.from('fake'));
    await pipeline._detectVocoderPrecision(
      { inputNames: ['mel', 'f0'], inputMetadata: [
        { name: 'mel', type: 'float32' }, { name: 'f0', type: 'float32' },
      ] },
      modelPath
    );
    expect(pipeline.vocoderIsFP16).to.equal(true);
    expect(pipeline.vocoderIsW16A32).to.equal(false);
  });
});
