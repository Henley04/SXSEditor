const path = require('node:path');
// 惰性 ORT：见 ortRuntime.js。
const { lazyOrt: ort } = require('./ortRuntime.js');
const { resampleAudio } = require('../utils/resampleAudio');
const { buildSessionOptions } = require('./shared/ortOptions');
const {
    TARGET_SAMPLE_RATE,
    TARGET_HOP_SIZE,
    requireSampleRate,
    createFloatTensor,
    outputToFloat32,
    resampleF0Frames,
    framesToF0Array,
    f0ToMidi,
    f0ToNotes,
    groupIntoNotes,
    createNoteFromGroup,
} = require('./shared/pitchF0Utils');

// float16 patch 由 nativeSvsPipeline.js 统一执行，此处不再重复。
// 张量工具、F0 后处理与采样率校验已收敛到 ./shared/pitchF0Utils（审查项 2.2/2.3），
// 此前与 fcpePitchDetector.js 逐字重复的 108 行不再各存一份。

const RMVPE_SAMPLE_RATE = 16000;
const RMVPE_HOP_SIZE = 160; // 10ms at 16kHz
// U-Net 有 5 次 stride-2 下采样，mel 帧数必须是 32 的倍数，否则
// AvgPool2d 向下取整、Decoder 的 concat 尺寸对不上，整个 session 直接报错。
const RMVPE_FRAME_ALIGN = 32;
// RMVPE 的 360 个音高 bin：cents = 20 * bin + 1997.3794084376191
const N_CLASS = 360;
const CENTS_OFFSET = 1997.3794084376191;
// voicing 阈值：帧内最大 salience 低于它就视为清音（与 RVC 的 decode 默认值一致）
const VOICING_THRESHOLD = 0.03;
const F0_MIN = 30;

class RmvpePitchDetector {
  constructor(modelDir, options = {}) {
    this.modelDir = modelDir;
    this.deviceId = options.deviceId;
    this.session = null;
    this.initialized = false;
    this.isFP16 = false;
    this.usingDML = false;
    this._outputName = null;
  }

  async init() {
    if (this.initialized) return true;

    const modelPath = path.join(this.modelDir, 'preprocess', 'rmvpe_model.onnx');
    console.log('[RmvpePitchDetector] attempting to load model:', modelPath);

    // 检查文件是否存在
    const fs = require('fs');
    if (!fs.existsSync(modelPath)) {
      const errMsg = `[RmvpePitchDetector] model file does not exist: ${modelPath}`;
      console.error(errMsg);
      const err = new Error(errMsg);
      err.code = 'MODEL_NOT_FOUND';
      err.modelPath = modelPath;
      throw err;
    }

    const stats = fs.statSync(modelPath);
    console.log(`[RmvpePitchDetector] model file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    try {
      // sessionOptions 由 buildSessionOptions() 依据设置生成；
      // RMVPE 模型较小，DML 路径下是否启用 memPattern 由 ortForceMemPatternOnDml 决定
      let sessionOptions = buildSessionOptions({
        executionProviders: ['cpu'],
      });
      
      try {
        const dmlEp = typeof this.deviceId === 'number'
          ? { name: 'dml', deviceId: this.deviceId }
          : 'dml';
        const dmlOptions = buildSessionOptions({
          executionProviders: [dmlEp],
        });
        this.session = await ort.InferenceSession.create(modelPath, dmlOptions);
        this.usingDML = true;
        const deviceTag = typeof this.deviceId === 'number' ? ` [DML deviceId=${this.deviceId}]` : ' [DML]';
        console.log(`[RmvpePitchDetector] model loaded successfully${deviceTag}`);
      } catch (dmlErr) {
        console.log('[RmvpePitchDetector] DirectML unavailable, falling back to CPU:', dmlErr.message);
        this.session = await ort.InferenceSession.create(modelPath, sessionOptions);
        this.usingDML = false;
        console.log('[RmvpePitchDetector] model loaded successfully [CPU]');
      }
      
      this.initialized = true;

      // 检测模型精度：通过检查输入类型判断是否为 FP16 模型
      const inputMetadata = this.session.inputMetadata;
      const audioInputMeta = inputMetadata.find(m => m.name === 'audio') || inputMetadata[0];
      this.isFP16 = audioInputMeta?.type === 'float16';
      console.log(`[RmvpePitchDetector] model precision: ${this.isFP16 ? 'FP16 (half precision)' : 'FP32 (full precision)'}`);

      // 输出名固定优先 'salience'，其余情况退回第一个输出
      this._outputName = this.session.outputNames.includes('salience')
        ? 'salience'
        : this.session.outputNames[0];

      console.log('[RmvpePitchDetector] input names:', this.session.inputNames);
      console.log('[RmvpePitchDetector] output names:', this.session.outputNames);

      // 模型契约校验：输出必须是 (batch, time, 360) 的 salience。
      // 老版本模型（固定 15s 输入、输出被误当成 (T, 2560)）在这里就会失败，
      // 而不是在 extractF0 里静默退化成一条 30Hz 的直线。
      this._validateOutputSignature();
      return true;
    } catch (err) {
      console.error('[RmvpePitchDetector] model load failed:', err.message);
      err.modelPath = modelPath;
      throw err;
    }
  }

  /**
   * 校验模型输出签名。ONNX 里 time 维通常是动态的（-1），只强校验最后一维 = 360。
   * 不匹配直接抛错，避免下游拿到"看起来正常"的错误 F0。
   */
  _validateOutputSignature() {
    const meta = this.session.outputMetadata;
    if (!meta || meta.length === 0) return; // 运行时未暴露 metadata 时不阻断，extractF0 里还有一次校验
    const out = meta.find(m => m.name === this._outputName) || meta[0];
    const dims = out?.dimensions;
    if (!Array.isArray(dims) || dims.length === 0) return;
    const last = dims[dims.length - 1];
    if (typeof last === 'number' && last > 0 && last !== N_CLASS) {
      const err = new Error(
        `[RmvpePitchDetector] 模型输出类别数不符：期望 ${N_CLASS}，实际 ${last}（${JSON.stringify(dims)}）。` +
        '该模型不是修复版（旧版输出被误当成 (T, 2560)，会退化成 30Hz 直线）。'
      );
      err.code = 'INVALID_MODEL_OUTPUT';
      throw err;
    }
  }

  /**
   * Destroy the current DML session and recreate a CPU-only session.
   * Called when DML inference fails at runtime (e.g. GRU E_INVALIDARG).
   */
  async _rebuildAsCpu() {
    const modelPath = path.join(this.modelDir, 'preprocess', 'rmvpe_model.onnx');
    if (this.session) {
      try { this.session.release(); } catch (_) {}
      this.session = null;
    }
    this.usingDML = false;
    this.isFP16 = false; // CPU session uses FP32; re-detect from metadata
    this.session = await ort.InferenceSession.create(modelPath,
      buildSessionOptions({ executionProviders: ['cpu'] }));

    // Re-detect model precision from the new session's metadata
    const inputMetadata = this.session.inputMetadata;
    const audioInputMeta = inputMetadata.find(m => m.name === 'audio') || inputMetadata[0];
    this.isFP16 = audioInputMeta?.type === 'float16';
    console.log('[RmvpePitchDetector] fell back to CPU inference');
  }

  async extractF0(audioData, sampleRate) {
    if (!this.initialized) {
      await this.init();
    }
    // 2.3: 不再用 `= 44100` 兜底 —— 漏传采样率会让 24kHz 音频被按 44.1kHz
    // 重采样（F0 时间轴偏快 1.8375 倍）且不报错。改为显式失败。
    const sr = requireSampleRate(sampleRate, 'RmvpePitchDetector.extractF0');

    const resampledAudio = sr !== RMVPE_SAMPLE_RATE
      ? resampleAudio(audioData, sr, RMVPE_SAMPLE_RATE)
      : audioData;

    // 帧数对齐到 32 的倍数：center=True 的 STFT 给出 T = 1 + floor(N/160) 帧。
    // 末尾补零不会改变已有帧的 mel（只有最后 ~1 帧受边界影响），帧数少时尤其重要。
    const sourceFrames = 1 + Math.floor(resampledAudio.length / RMVPE_HOP_SIZE);
    const alignedFrames = Math.max(
      RMVPE_FRAME_ALIGN,
      Math.ceil(sourceFrames / RMVPE_FRAME_ALIGN) * RMVPE_FRAME_ALIGN
    );
    const paddedLength = Math.max((alignedFrames - 1) * RMVPE_HOP_SIZE, resampledAudio.length);
    let modelInput = resampledAudio;
    if (paddedLength !== resampledAudio.length) {
      modelInput = new Float32Array(paddedLength);
      modelInput.set(resampledAudio);
    }

    const tensorType = this.isFP16 ? 'float16' : 'float32';
    const inputTensor = createFloatTensor(tensorType, modelInput, [1, paddedLength]);

    const feeds = { audio: inputTensor };
    let outputs;

    let inputTensorDisposed = false;
    try {
      outputs = await this.session.run(feeds);
    } catch (runErr) {
      // DML may fail on GRU/RNN nodes (E_INVALIDARG 0x80070057) due to
      // incompatible operator parameters with dynamic sequence lengths.
      // Fall back to CPU session and retry — same pattern as rosvotDetector.js.
      if (this.usingDML) {
        console.warn('[RmvpePitchDetector] DML inference failed, falling back to CPU:', runErr.message);
        try { if (typeof inputTensor.dispose === 'function') inputTensor.dispose(); } catch (_) {}
        inputTensorDisposed = true;
        await this._rebuildAsCpu();
        // Rebuild input tensor (previous one may have been disposed or bound to DML context)
        const retryTensor = createFloatTensor('float32', modelInput, [1, paddedLength]);
        outputs = await this.session.run({ audio: retryTensor });
        try { if (typeof retryTensor.dispose === 'function') retryTensor.dispose(); } catch (_) {}
      } else {
        try { if (typeof inputTensor.dispose === 'function') inputTensor.dispose(); } catch (_) {}
        inputTensorDisposed = true;
        throw runErr;
      }
    }

    // 释放输入张量（性能审查 #3 中优先级：RMVPE 输入泄漏）
    // 跳过已在 catch 块中释放的情况，避免双重释放
    if (!inputTensorDisposed) {
      try { if (typeof inputTensor.dispose === 'function') inputTensor.dispose(); } catch (_) {}
    }

    const pitchOutput = outputs[this._outputName] || Object.values(outputs)[0];
    const salience = outputToFloat32(pitchOutput);
    const dims = pitchOutput.dims;

    // 期望 (1, T, 360)。旧模型是 (1, 1504, 360) 但固定 15s 输入、且被错读成
    // (T, 2560) —— 这里显式拒绝任何不是 360 类的输出。
    const nClass = dims[dims.length - 1];
    if (dims.length !== 3 || nClass !== N_CLASS) {
      try { if (typeof pitchOutput.dispose === 'function') pitchOutput.dispose(); } catch (_) {}
      const err = new Error(
        `[RmvpePitchDetector] 模型输出形状 ${JSON.stringify(dims)} 不符合 (1, T, ${N_CLASS})。` +
        '请更新 preprocess/rmvpe_model.onnx 到修复版。'
      );
      err.code = 'INVALID_MODEL_OUTPUT';
      throw err;
    }

    const timeFrames = dims[1];
    const expected = timeFrames * N_CLASS;
    if (salience.length < expected) {
      try { if (typeof pitchOutput.dispose === 'function') pitchOutput.dispose(); } catch (_) {}
      const err = new Error(
        `[RmvpePitchDetector] 输出数据长度 ${salience.length} < ${expected}（${timeFrames} 帧 × ${N_CLASS} 类）。`
      );
      err.code = 'INVALID_MODEL_OUTPUT';
      throw err;
    }
    // 释放输出张量（salience 已是独立拷贝）
    try { if (typeof pitchOutput.dispose === 'function') pitchOutput.dispose(); } catch (_) {}

    const rawF0 = await RmvpePitchDetector.decodeSalience(salience, Math.min(timeFrames, sourceFrames));

    const interpolatedF0 = RmvpePitchDetector.interpolateF0(
      rawF0, resampledAudio.length, RMVPE_SAMPLE_RATE, TARGET_SAMPLE_RATE, TARGET_HOP_SIZE
    );

    return framesToF0Array(interpolatedF0, TARGET_HOP_SIZE, TARGET_SAMPLE_RATE);
  }

  /**
   * 把 (T, 360) 的 salience 解码成 Hz。
   *
   * 与 RVC `RMVPE.to_local_average_cents` 等价：
   *   1. argmax 得到中心 bin；
   *   2. 在 ±4 个 bin 的窗口上按 salience 加权平均 cents（边界外权重为 0）；
   *   3. 帧内最大 salience <= 阈值 → 清音，F0 = 0。
   *
   * @param {Float32Array} salience 展平的 (T, 360) 数据
   * @param {number} frames 参与解码的帧数
   * @param {number} [threshold] voicing 阈值
   * @returns {Promise<Float32Array>} 长度 frames 的 F0（Hz，0 = 清音）
   */
  static async decodeSalience(salience, frames, threshold = VOICING_THRESHOLD) {
    const rawF0 = new Float32Array(frames);
    const CHUNK = 256; // 每 256 帧让出一次事件循环，避免长音频阻塞主进程

    for (let t = 0; t < frames; t++) {
      const base = t * N_CLASS;
      let maxProb = -Infinity;
      let maxIndex = 0;

      for (let c = 0; c < N_CLASS; c++) {
        const prob = salience[base + c];
        if (prob > maxProb) {
          maxProb = prob;
          maxIndex = c;
        }
      }

      if (maxProb > threshold) {
        let weightSum = 0;
        let centsSum = 0;
        const start = Math.max(0, maxIndex - 4);
        const end = Math.min(N_CLASS - 1, maxIndex + 4);
        for (let i = start; i <= end; i++) {
          const w = salience[base + i];
          weightSum += w;
          centsSum += w * (20 * i + CENTS_OFFSET);
        }
        if (weightSum > 0) {
          rawF0[t] = 10 * Math.pow(2, (centsSum / weightSum) / 1200);
        }
      }

      if ((t & (CHUNK - 1)) === CHUNK - 1 && t + 1 < frames) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return rawF0;
  }

  static interpolateF0(f0Data, originalLength, originalSr, targetSr, hopSize) {
    return resampleF0Frames(
      f0Data, originalLength, originalSr, targetSr, hopSize,
      RMVPE_HOP_SIZE, RMVPE_SAMPLE_RATE
    );
  }

  f0ToMidi(f0) {
    return f0ToMidi(f0, F0_MIN);
  }

  f0ToNotes(f0Array, bpm = 120, minNoteDuration = 0.1, f0Threshold = 50) {
    return f0ToNotes(f0Array, F0_MIN, { bpm, minNoteDuration, f0Threshold });
  }

  groupIntoNotes(frames, minNoteDuration, bpm) {
    return groupIntoNotes(frames, F0_MIN, minNoteDuration, bpm);
  }

  createNoteFromGroup(group, minNoteDuration, bpm) {
    return createNoteFromGroup(group, F0_MIN, minNoteDuration, bpm);
  }

  dispose() {
    if (this.session) {
      try {
        this.session.release();
      } catch (e) {
        console.warn('[RmvpePitchDetector] session release failed:', e.message);
      }
      this.session = null;
      this.initialized = false;
    }
  }
}

module.exports = { RmvpePitchDetector, RMVPE_SAMPLE_RATE, N_CLASS, VOICING_THRESHOLD };
