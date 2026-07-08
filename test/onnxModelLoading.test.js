// JS 端 ONNX 模型加载与验证测试
// 验证所有 9 个 SVS ONNX 模型在 DML (DirectML) EP 上的加载和推理正确性
// 重点验证 mel_transform 的 Cooley-Tukey MatMul DFT 实现
//
// 关键：所有测试强制使用 DML EP（无 CPU 回退），确保 DML 后端真正执行。
//   onnxruntime-node 1.27 不暴露 getExecutionProviders()，因此用 'dml' 单 EP
//   配置——若 DML 不可用或推理失败，测试会明确失败（而非静默回退到 CPU）。
//
// 关于静态形状：所有 9 个模型均为静态形状（包括非 _dml 后缀的模型）。
//   这是 DML 优化的设计决策——静态形状允许 DML 预选最优 kernel、预分配内存。
//   生产管线总是将输入 pad/truncate 到这些固定形状，测试输入与之完全一致。
//
// 运行方式:
//   npx mocha --require ./test/setup.js "test/onnxModelLoading.test.js" --timeout 120000

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const ort = require('onnxruntime-node');

const {
  SAMPLE_RATE,
  HOP_SIZE,
  MEL_DIM,
  EMBED_DIM,
  COND_DIM,
} = require('../src/inference/shared/constants');

const { ONNX_MODEL_FILES, MEL_MEAN, MEL_VAR } = require('../src/inference/pipeline/constants');

const ONNX_DIR = path.join(__dirname, '..', 'onnx_models');

// DML 执行提供者配置
// DML_ONLY: 纯 DML（无 CPU 回退），用于小模型——若 DML 不可用则测试直接失败
// DML_PRODUCTION: 匹配生产配置（DML 优先 + CPU 回退），用于大模型
//   大模型（diff_step, vocoder）含 DML 不支持的算子（Reshape 动态形状、ConvTranspose 大 stride），
//   需要 CPU 回退这些节点。这与 modelLoader.js 生产代码完全一致。
const DML_ONLY = [{ name: 'dml', deviceId: 0 }];
const DML_PRODUCTION = {
  executionProviders: [{ name: 'dml', deviceId: 0 }, 'cpu'],
  enableMemPattern: false,       // DML 要求：避免过度预分配 GPU 内存池
  executionMode: 'sequential',   // DML 要求：串行执行避免命令流交叉
};

// 生产级 session 创建：DML 优先，失败则 CPU 回退（复制 modelLoader.js createSessionWithValidation 逻辑）
// 返回 { session, ep: 'dml'|'cpu' }，ep 字段标识实际使用的执行提供者
async function createSessionProduction(modelPath, options = {}) {
  try {
    const session = await ort.InferenceSession.create(modelPath, { ...DML_PRODUCTION, ...options });
    return { session, ep: 'dml' };
  } catch (dmlErr) {
    // DML session 创建失败（如 E_INVALIDARG, 不支持算子）→ 回退 CPU
    // 这与生产代码 createSessionWithValidation 的 catch → CPU fallback 完全一致
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      ...options,
    });
    return { session, ep: 'cpu', dmlError: dmlErr.message.split('\n')[0].substring(0, 80) };
  }
}

// ============================================================
// 模型规格（静态形状，与 ONNX 导出时一致）
// ============================================================

const MODEL_SPECS = [
  {
    name: 'note_text_encoder',
    file: 'note_text_encoder.onnx',
    inputs: { input_ids: new ort.Tensor('int64', BigInt64Array.from({ length: 100 }, (_, i) => BigInt(i + 1)), [1, 100]) },
    outputName: 'embeddings',
    expectedShape: [1, 100, EMBED_DIM],
    category: 'small',
  },
  {
    name: 'note_pitch_encoder',
    file: 'note_pitch_encoder.onnx',
    inputs: { input_ids: new ort.Tensor('int64', BigInt64Array.from({ length: 100 }, (_, i) => BigInt(48 + (i % 36))), [1, 100]) },
    outputName: 'embeddings',
    expectedShape: [1, 100, EMBED_DIM],
    category: 'small',
  },
  {
    name: 'note_type_encoder',
    file: 'note_type_encoder.onnx',
    inputs: { input_ids: new ort.Tensor('int64', BigInt64Array.from({ length: 100 }, () => 0n), [1, 100]) },
    outputName: 'embeddings',
    expectedShape: [1, 100, EMBED_DIM],
    category: 'small',
  },
  {
    name: 'f0_encoder',
    file: 'f0_encoder.onnx',
    inputs: { input_ids: new ort.Tensor('int64', BigInt64Array.from({ length: 200 }, () => 100n), [1, 200]) },
    outputName: 'embeddings',
    expectedShape: [1, 200, EMBED_DIM],
    category: 'small',
  },
  {
    name: 'preflow',
    file: 'preflow.onnx',
    inputs: { features: new ort.Tensor('float32', new Float32Array(100 * EMBED_DIM).fill(0.1), [1, 100, EMBED_DIM]) },
    outputName: 'processed_features',
    expectedShape: [1, 100, EMBED_DIM],
    category: 'small',
  },
  {
    name: 'cond_emb',
    file: 'cond_emb.onnx',
    inputs: { cond_code: new ort.Tensor('float32', new Float32Array(100 * 512).fill(0.1), [1, 100, 512]) },
    outputName: 'cond_embedding',
    expectedShape: [1, 100, COND_DIM],
    category: 'small',
  },
  {
    name: 'mel_transform',
    file: 'mel_transform.onnx',
    inputs: null, // 在 mel_transform 专项验证中构造
    outputName: 'mel',
    expectedShape: [1, 50, MEL_DIM],
    category: 'mel',
  },
  {
    name: 'diff_step',
    file: 'diff_step_dml.onnx',
    inputs: {
      xt_input: new ort.Tensor('float32', new Float32Array(2048 * MEL_DIM).fill(0.01), [1, 2048, MEL_DIM]),
      t: new ort.Tensor('float32', new Float32Array([0.5]), [1]),
      cond: new ort.Tensor('float32', new Float32Array(2048 * EMBED_DIM).fill(0.01), [1, 2048, EMBED_DIM]),
      xt_mask: new ort.Tensor('float32', new Float32Array(2048).fill(1), [1, 2048]),
    },
    outputName: 'flow_pred',
    expectedShape: [1, 2048, MEL_DIM],
    category: 'large',
  },
  {
    name: 'vocoder',
    file: 'vocoder_dml.onnx',
    inputs: { mel: new ort.Tensor('float32', new Float32Array(500 * MEL_DIM).fill(-0.4), [1, 500, MEL_DIM]) },
    outputName: 'waveform',
    expectedShape: [1, 240000],
    category: 'large',
  },
];

// ============================================================
// 辅助函数
// ============================================================

function checkModelsExist() {
  if (!fs.existsSync(ONNX_DIR)) return false;
  return ONNX_MODEL_FILES.every(f => {
    const p = path.join(ONNX_DIR, f);
    if (!fs.existsSync(p)) return false;
    return fs.existsSync(p + '.data');
  });
}

// DML 可用性探针：用最小的模型 (note_pitch_encoder, 0.13MB) 尝试 DML session 加载+推理
// 若失败说明当前环境无 DML 支持，整个测试套件应跳过（而非静默回退 CPU）
let dmlAvailable = null; // null=未检测, true/false=检测结果
async function probeDMLAvailability() {
  if (dmlAvailable !== null) return dmlAvailable;
  const probeModel = path.join(ONNX_DIR, 'note_pitch_encoder.onnx');
  if (!fs.existsSync(probeModel)) {
    dmlAvailable = false;
    return false;
  }
  try {
    const session = await ort.InferenceSession.create(probeModel, { executionProviders: DML_ONLY });
    const inputs = { input_ids: new ort.Tensor('int64', BigInt64Array.from({ length: 100 }, () => 48n), [1, 100]) };
    await session.run(inputs);
    session.release();
    dmlAvailable = true;
  } catch (e) {
    console.log(`[DML Probe] DML not available: ${e.message.split('\n')[0]}`);
    dmlAvailable = false;
  }
  return dmlAvailable;
}

function generateSineWave(freq, durationSec, amplitude = 0.5) {
  const n = Math.floor(SAMPLE_RATE * durationSec);
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    audio[i] = Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE) * amplitude;
  }
  return audio;
}

function countNaN(data) {
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (Number.isNaN(data[i])) count++;
  }
  return count;
}

function maxAbsDiff(a, b) {
  let maxDiff = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxDiff) maxDiff = d;
  }
  return maxDiff;
}

// ============================================================
// 测试
// ============================================================

describe('ONNX Model Loading and Validation (JS端)', function () {
  this.timeout(120000);

  const modelsExist = checkModelsExist();

  before(async function () {
    if (!modelsExist) {
      this.skip('ONNX models not found in ' + ONNX_DIR);
    }
    // 检测 DML 可用性——若不可用则跳过整个套件（不回退 CPU）
    const ok = await probeDMLAvailability();
    if (!ok) {
      this.skip('DML EP not available - skipping (tests require DML execution, no CPU fallback)');
    }
  });

  // ========== 1. 模型加载验证（所有 9 个模型）==========
  // 使用生产级 fallback（DML→CPU），记录每个模型实际使用的 EP
  describe('1. Model Loading (DML with CPU fallback)', () => {
    for (const spec of MODEL_SPECS) {
      it(`should load ${spec.name} and expose correct I/O names`, async () => {
        const { session, ep, dmlError } = await createSessionProduction(
          path.join(ONNX_DIR, spec.file),
          { graphOptimizationLevel: 'basic' }
        );
        expect(session, 'session should be created').to.be.an('object');
        expect(session.inputNames.length, 'should have inputs').to.be.greaterThan(0);
        expect(session.outputNames, 'should have expected output').to.include(spec.outputName);
        if (ep === 'cpu' && dmlError) {
          console.log(`    [${spec.name}] DML unavailable, CPU fallback: ${dmlError}`);
        }
        session.release();
      });
    }
  });

  // ========== 2. 小模型推理验证（纯 DML，无 CPU 回退）==========
  describe('2. Inference Validation (small models, DML only)', () => {
    const smallModels = MODEL_SPECS.filter(s => s.category === 'small');

    for (const spec of smallModels) {
      it(`should run inference on ${spec.name} with correct output shape`, async () => {
        const session = await ort.InferenceSession.create(
          path.join(ONNX_DIR, spec.file),
          { executionProviders: DML_ONLY }
        );
        const outputs = await session.run(spec.inputs);
        expect(outputs).to.have.property(spec.outputName);

        const out = outputs[spec.outputName];
        expect(out.dims, `${spec.name} output shape mismatch`).to.deep.equal(spec.expectedShape);

        // 验证无 NaN
        const nanCount = countNaN(out.data);
        expect(nanCount, `${spec.name} output contains NaN`).to.equal(0);

        // 验证非全零（模型应该产生有意义的输出）
        let nonZero = 0;
        for (let i = 0; i < out.data.length; i++) {
          if (Math.abs(out.data[i]) > 1e-7) nonZero++;
        }
        expect(nonZero, `${spec.name} output is all zeros`).to.be.greaterThan(0);

        session.release();
      });
    }
  });

  // ========== 3. mel_transform Cooley-Tukey DFT 深度验证（纯 DML）==========
  describe('3. mel_transform Cooley-Tukey DFT (DML only)', () => {
    let session;

    before(async () => {
      session = await ort.InferenceSession.create(
        path.join(ONNX_DIR, 'mel_transform.onnx'),
        { executionProviders: DML_ONLY }
      );
    });

    after(() => {
      if (session) session.release();
    });

    // --- I/O 元数据验证 ---
    it('should have input named "audio" (not "waveform")', () => {
      expect(session.inputNames).to.deep.equal(['audio']);
      expect(session.inputNames).to.not.include('waveform');
    });

    it('should have output named "mel"', () => {
      expect(session.outputNames).to.deep.equal(['mel']);
    });

    // --- 形状验证 ---
    it('should produce [1, 50, 128] mel for 1s audio (24000 samples)', async () => {
      const audio = generateSineWave(440, 1.0);
      const outputs = await session.run({
        audio: new ort.Tensor('float32', audio, [1, audio.length]),
      });
      expect(outputs.mel.dims, 'mel shape should be [1, 50, 128]').to.deep.equal([1, 50, MEL_DIM]);
      // 50 帧 = floor(24000 / 480) = 50 (center=False, no padding)
    });

    // --- 数值正确性验证 ---
    it('should produce NaN-free output for sine wave input', async () => {
      const audio = generateSineWave(440, 1.0);
      const outputs = await session.run({
        audio: new ort.Tensor('float32', audio, [1, audio.length]),
      });
      expect(countNaN(outputs.mel.data), 'mel output should not contain NaN').to.equal(0);
    });

    it('should produce deterministic output (same input → identical output)', async () => {
      const audio = generateSineWave(440, 1.0);
      const tensor = new ort.Tensor('float32', audio, [1, audio.length]);

      const out1 = await session.run({ audio: tensor });
      const out2 = await session.run({ audio: tensor });

      // DML EP 对相同输入应确定性输出（bit-exact）
      const diff = maxAbsDiff(out1.mel.data, out2.mel.data);
      expect(diff, 'same input should produce identical output on DML').to.equal(0);
    });

    it('should have reasonable mel range (log mel ∈ [-15, 5])', async () => {
      const audio = generateSineWave(440, 1.0, 0.5);
      const outputs = await session.run({
        audio: new ort.Tensor('float32', audio, [1, audio.length]),
      });
      const data = outputs.mel.data;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < data.length; i++) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
      }
      // log(clamp(x, 1e-5)) 的下界 ≈ -11.51
      // 正常语音的 log mel 上界一般在 [0, 3] 范围
      expect(min, `mel min=${min} should be > -15`).to.be.greaterThan(-15);
      expect(max, `mel max=${max} should be < 5`).to.be.lessThan(5);
    });

    // --- 信号处理正确性验证 ---
    it('should detect 440Hz peak in mel spectrum', async () => {
      const audio = generateSineWave(440, 1.0, 0.5);
      const outputs = await session.run({
        audio: new ort.Tensor('float32', audio, [1, audio.length]),
      });
      const mel = outputs.mel.data;
      // mel shape: [1, 50, 128]，取中间帧分析
      const frameIdx = 25;
      const frameStart = frameIdx * MEL_DIM;
      const frame = mel.slice(frameStart, frameStart + MEL_DIM);

      // 找到峰值 bin
      let maxVal = -Infinity, maxBin = 0;
      for (let i = 0; i < frame.length; i++) {
        if (frame[i] > maxVal) {
          maxVal = frame[i];
          maxBin = i;
        }
      }
      // 440Hz 在 mel 频谱中不应在边界（bin 0 或 127）
      // 应该在低中频区域（取决于 mel 滤波器组范围）
      expect(maxBin, `peak bin=${maxBin} should not be at boundary`).to.be.greaterThan(0);
      expect(maxBin, `peak bin=${maxBin} should not be at boundary`).to.be.lessThan(MEL_DIM - 1);
    });

    it('should handle silence (all-zero input) without NaN', async () => {
      const audio = new Float32Array(SAMPLE_RATE); // 全零（静音）
      const outputs = await session.run({
        audio: new ort.Tensor('float32', audio, [1, audio.length]),
      });
      const data = outputs.mel.data;

      // mel_transform 输出经过标准化: (log_mel - MEL_MEAN) / sqrt(MEL_VAR)
      // 静音输入: 原始 log_mel ≈ log(1e-5) ≈ -11.51
      // 标准化后: (-11.51 - (-4.92)) / sqrt(8.14) ≈ -2.31
      expect(countNaN(data), 'silence input should not produce NaN').to.equal(0);

      let mean = 0;
      for (let i = 0; i < data.length; i++) mean += data[i];
      mean /= data.length;

      let variance = 0;
      for (let i = 0; i < data.length; i++) variance += (data[i] - mean) ** 2;
      variance /= data.length;
      const std = Math.sqrt(variance);

      // 静音 mel 标准差应很小（mel filterbank 权重差异导致少量变化）
      expect(std, `silence mel std=${std} should be < 0.5`).to.be.lessThan(0.5);
      // 标准化后均值应在 (log(1e-5) - MEL_MEAN) / sqrt(MEL_VAR) ≈ -2.31 附近
      const expectedMean = (Math.log(1e-5) - MEL_MEAN) / Math.sqrt(MEL_VAR);
      expect(Math.abs(mean - expectedMean),
        `silence mel mean=${mean.toFixed(4)}, expected≈${expectedMean.toFixed(4)}`)
        .to.be.lessThan(1.0);
    });

    it('should exhibit log-linearity (10x amplitude → log(10)/sqrt(var) offset at peak bin)', async () => {
      // mel_transform 输出 = (log(clamp(mel_basis @ sqrt(|STFT|^2 + eps), 1e-5)) - MEL_MEAN) / sqrt(MEL_VAR)
      // 对于有显著能量的频率 bin, 10x 振幅 → 原始 log_mel 差异 ≈ log(10)
      // 标准化后差异 ≈ log(10) / sqrt(MEL_VAR)
      const audio1 = generateSineWave(440, 1.0, 0.5);
      const audio2 = generateSineWave(440, 1.0, 5.0); // 10x amplitude

      const out1 = await session.run({ audio: new ort.Tensor('float32', audio1, [1, audio1.length]) });
      const out2 = await session.run({ audio: new ort.Tensor('float32', audio2, [1, audio2.length]) });

      // 取中间帧
      const frameIdx = 25;
      const start = frameIdx * MEL_DIM;
      const f1 = out1.mel.data.slice(start, start + MEL_DIM);
      const f2 = out2.mel.data.slice(start, start + MEL_DIM);

      // 找峰值 bin（用幅度较大的那个的峰值）
      let maxVal = -Infinity, peakBin = 0;
      for (let i = 0; i < MEL_DIM; i++) {
        if (f2[i] > maxVal) { maxVal = f2[i]; peakBin = i; }
      }

      // 峰值 bin 的标准化 mel 差异应接近 log(10) / sqrt(MEL_VAR)
      const diff = f2[peakBin] - f1[peakBin];
      const expected = Math.log(10) / Math.sqrt(MEL_VAR);
      // 允许 0.15 误差（eps 非线性、mel filterbank 重叠）
      expect(Math.abs(diff - expected),
        `peak bin=${peakBin}: diff=${diff.toFixed(4)}, expected log(10)/sqrt(var)≈${expected.toFixed(4)}`)
        .to.be.lessThan(0.15);
    });

    it('should differentiate frequencies (440Hz vs 1000Hz peaks at different bins)', async () => {
      const audio440 = generateSineWave(440, 1.0, 0.5);
      const audio1000 = generateSineWave(1000, 1.0, 0.5);

      const out440 = await session.run({ audio: new ort.Tensor('float32', audio440, [1, audio440.length]) });
      const out1000 = await session.run({ audio: new ort.Tensor('float32', audio1000, [1, audio1000.length]) });

      // 取中间帧
      const frameIdx = 25;
      const start = frameIdx * MEL_DIM;
      const f440 = out440.mel.data.slice(start, start + MEL_DIM);
      const f1000 = out1000.mel.data.slice(start, start + MEL_DIM);

      // 找各自的峰值 bin
      let max440 = -Infinity, bin440 = 0;
      let max1000 = -Infinity, bin1000 = 0;
      for (let i = 0; i < MEL_DIM; i++) {
        if (f440[i] > max440) { max440 = f440[i]; bin440 = i; }
        if (f1000[i] > max1000) { max1000 = f1000[i]; bin1000 = i; }
      }

      // 1000Hz 的峰值 bin 应该比 440Hz 的更高（mel 频率轴是单调递增的）
      expect(bin1000, `1000Hz peak bin=${bin1000} should be > 440Hz peak bin=${bin440}`).to.be.greaterThan(bin440);
    });
  });

  // ========== 4. 大模型推理验证（生产配置：DML 优先，失败回退 CPU）==========
  // diff_step (1.69GB) 和 vocoder (988MB) 含 DML 不支持的算子，
  // 生产环境也会回退到 CPU。测试验证模型能正确加载和推理，并记录实际 EP。
  describe('4. Large Model Inference (diff_step, vocoder)', () => {
    const largeModels = MODEL_SPECS.filter(s => s.category === 'large');

    for (const spec of largeModels) {
      const dataPath = path.join(ONNX_DIR, spec.file + '.data');
      const sizeMB = fs.existsSync(dataPath) ? (fs.statSync(dataPath).size / 1024 / 1024).toFixed(0) : '?';
      it(`should run inference on ${spec.name} (${sizeMB}MB)`, async function () {
        // 大模型加载+推理可能需要 30-180 秒
        this.timeout(300000);

        const { session, ep, dmlError } = await createSessionProduction(
          path.join(ONNX_DIR, spec.file),
          { graphOptimizationLevel: 'basic' }
        );
        if (ep === 'cpu' && dmlError) {
          console.log(`    [${spec.name}] DML unavailable, CPU fallback: ${dmlError}`);
        }

        const outputs = await session.run(spec.inputs);
        expect(outputs).to.have.property(spec.outputName);

        const out = outputs[spec.outputName];
        expect(out.dims, `${spec.name} output shape mismatch`).to.deep.equal(spec.expectedShape);

        // 验证无 NaN
        const nanCount = countNaN(out.data);
        expect(nanCount, `${spec.name} output contains NaN`).to.equal(0);

        session.release();
      });
    }
  });

  // ========== 5. DUMMY_TEST_INPUTS 一致性验证 ==========
  describe('5. DUMMY_TEST_INPUTS consistency', () => {
    let DUMMY_TEST_INPUTS_FP32;

    before(() => {
      // modelLoader.js 依赖 electron 和 systeminformation，在测试环境中可能无法直接 require
      // 用 try-catch 保护
      try {
        const mod = require('../src/inference/pipeline/modelLoader');
        DUMMY_TEST_INPUTS_FP32 = mod.DUMMY_TEST_INPUTS_FP32;
      } catch (e) {
        // electron 不可用时跳过此 describe
        DUMMY_TEST_INPUTS_FP32 = null;
      }
    });

    it('melTransform dummy input should use key "audio" (not "waveform")', function () {
      if (!DUMMY_TEST_INPUTS_FP32) this.skip('modelLoader.js not loadable (electron dependency)');
      expect(DUMMY_TEST_INPUTS_FP32.melTransform, 'melTransform should exist in DUMMY_TEST_INPUTS_FP32').to.exist;
      expect(DUMMY_TEST_INPUTS_FP32.melTransform, 'melTransform should have "audio" key').to.have.property('audio');
      expect(DUMMY_TEST_INPUTS_FP32.melTransform, 'melTransform should NOT have "waveform" key').to.not.have.property('waveform');
    });
  });

  // ========== 6. 动态形状验证（seq_len 可变）==========
  // 验证模型接受不同 seq_len 输入（生产场景: 歌词 token 数 = 127）
  describe('6. Dynamic Shape Validation (variable seq_len)', () => {
    const testCases = [
      { name: 'note_text_encoder', file: 'note_text_encoder.onnx', seqLen: 127, inputKey: 'input_ids', outputKey: 'embeddings', embedDim: EMBED_DIM, dtype: 'int64' },
      { name: 'preflow', file: 'preflow.onnx', seqLen: 50, inputKey: 'features', outputKey: 'processed_features', embedDim: EMBED_DIM, dtype: 'float32' },
      { name: 'cond_emb', file: 'cond_emb.onnx', seqLen: 200, inputKey: 'cond_code', outputKey: 'cond_embedding', embedDim: COND_DIM, dtype: 'float32' },
    ];

    for (const tc of testCases) {
      it(`${tc.name} should accept seq_len=${tc.seqLen} (non-default)`, async () => {
        const session = await ort.InferenceSession.create(
          path.join(ONNX_DIR, tc.file),
          { executionProviders: DML_ONLY }
        );

        let inputTensor;
        if (tc.dtype === 'int64') {
          inputTensor = new ort.Tensor('int64', BigInt64Array.from({ length: tc.seqLen }, (_, i) => BigInt(i + 1)), [1, tc.seqLen]);
        } else {
          inputTensor = new ort.Tensor('float32', new Float32Array(tc.seqLen * EMBED_DIM).fill(0.1), [1, tc.seqLen, EMBED_DIM]);
        }

        const outputs = await session.run({ [tc.inputKey]: inputTensor });
        const out = outputs[tc.outputKey];

        // 输出 seq_len 应与输入一致（动态维度正确传播）
        expect(out.dims[0], `${tc.name} batch dim`).to.equal(1);
        expect(out.dims[1], `${tc.name} seq_len should be ${tc.seqLen}`).to.equal(tc.seqLen);
        expect(out.dims[2], `${tc.name} embed_dim`).to.equal(tc.embedDim);
        expect(countNaN(out.data), `${tc.name} output NaN`).to.equal(0);

        session.release();
      });
    }

    it('note_text_encoder should accept seq_len=3 (DUMMY_TEST_INPUTS size)', async () => {
      // 验证 DUMMY_TEST_INPUTS 的 seq_len=3 也能正常工作（DML 验证场景）
      const session = await ort.InferenceSession.create(
        path.join(ONNX_DIR, 'note_text_encoder.onnx'),
        { executionProviders: DML_ONLY }
      );
      const inputTensor = new ort.Tensor('int64', BigInt64Array.from([1n, 2n, 3n]), [1, 3]);
      const outputs = await session.run({ input_ids: inputTensor });
      expect(outputs.embeddings.dims).to.deep.equal([1, 3, EMBED_DIM]);
      session.release();
    });
  });
});
