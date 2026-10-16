const path = require('node:path');
const ort = require('onnxruntime-node');
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
// 此前与 rmvpePitchDetector.js 逐字重复的 108 行不再各存一份。

const FCPE_SAMPLE_RATE = 16000;
const FCPE_HOP_SIZE = 160; // 10ms at 16kHz
const F0_MIN = 50;
const F0_MAX = 1100;

class FcpePitchDetector {
  constructor(modelDir, options = {}) {
    this.modelDir = modelDir;
    this.deviceId = options.deviceId;
    this.session = null;
    this.initialized = false;
    this.isFP16 = false;
    this.usingDML = false;
    this._inputName = null;
    this._outputName = null;
  }

  async init() {
    if (this.initialized) return true;

    const modelPath = path.join(this.modelDir, 'preprocess', 'fcpe_model.onnx');
    console.log('[FcpePitchDetector] attempting to load model:', modelPath);

    const fs = require('fs');
    if (!fs.existsSync(modelPath)) {
      const errMsg = `[FcpePitchDetector] model file does not exist: ${modelPath}`;
      console.error(errMsg);
      const err = new Error(errMsg);
      err.code = 'MODEL_NOT_FOUND';
      err.modelPath = modelPath;
      throw err;
    }

    const stats = fs.statSync(modelPath);
    console.log(`[FcpePitchDetector] model file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    try {
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
        console.log(`[FcpePitchDetector] model loaded successfully${deviceTag}`);
      } catch (dmlErr) {
        console.log('[FcpePitchDetector] DirectML unavailable, falling back to CPU:', dmlErr.message);
        this.session = await ort.InferenceSession.create(modelPath, sessionOptions);
        this.usingDML = false;
        console.log('[FcpePitchDetector] model loaded successfully [CPU]');
      }

      this.initialized = true;

      // Auto-detect input/output names
      this._inputName = this.session.inputNames[0];
      this._outputName = this.session.outputNames[0];

      // Detect model precision from input metadata
      const inputMetadata = this.session.inputMetadata;
      const audioInputMeta = inputMetadata.find(m => m.name === this._inputName) || inputMetadata[0];
      this.isFP16 = audioInputMeta?.type === 'float16';
      console.log(`[FcpePitchDetector] model precision: ${this.isFP16 ? 'FP16 (half precision)' : 'FP32 (full precision)'}`);

      console.log('[FcpePitchDetector] input names:', this.session.inputNames);
      console.log('[FcpePitchDetector] output names:', this.session.outputNames);

      return true;
    } catch (err) {
      console.error('[FcpePitchDetector] model load failed:', err.message);
      err.modelPath = modelPath;
      throw err;
    }
  }

  /**
   * Destroy the current DML session and recreate a CPU-only session.
   */
  async _rebuildAsCpu() {
    const modelPath = path.join(this.modelDir, 'preprocess', 'fcpe_model.onnx');
    if (this.session) {
      try { this.session.release(); } catch (_) {}
      this.session = null;
    }
    this.usingDML = false;
    this.isFP16 = false;
    this.session = await ort.InferenceSession.create(modelPath,
      buildSessionOptions({ executionProviders: ['cpu'] }));

    const inputMetadata = this.session.inputMetadata;
    const audioInputMeta = inputMetadata.find(m => m.name === this._inputName) || inputMetadata[0];
    this.isFP16 = audioInputMeta?.type === 'float16';
    console.log('[FcpePitchDetector] fell back to CPU inference');
  }

  async extractF0(audioData, sampleRate) {
    if (!this.initialized) {
      await this.init();
    }
    // 2.3: 不再用 `= 44100` 兜底 —— 漏传采样率会让 24kHz 音频被按 44.1kHz
    // 重采样（F0 时间轴偏快 1.8375 倍）且不报错。改为显式失败。
    const sr = requireSampleRate(sampleRate, 'FcpePitchDetector.extractF0');

    const resampledAudio = sr !== FCPE_SAMPLE_RATE
      ? resampleAudio(audioData, sr, FCPE_SAMPLE_RATE)
      : audioData;

    // ONNX model expects input shape (1, n_samples, 1)
    const tensorType = this.isFP16 ? 'float16' : 'float32';
    const inputTensor = createFloatTensor(tensorType, resampledAudio, [1, resampledAudio.length, 1]);

    const feeds = {};
    feeds[this._inputName] = inputTensor;
    let outputs;

    let inputTensorDisposed = false;
    try {
      outputs = await this.session.run(feeds);
    } catch (runErr) {
      if (this.usingDML) {
        console.warn('[FcpePitchDetector] DML inference failed, falling back to CPU:', runErr.message);
        try { if (typeof inputTensor.dispose === 'function') inputTensor.dispose(); } catch (_) {}
        inputTensorDisposed = true;
        await this._rebuildAsCpu();
        const retryTensor = createFloatTensor('float32', resampledAudio, [1, resampledAudio.length, 1]);
        const retryFeeds = {};
        retryFeeds[this._inputName] = retryTensor;
        outputs = await this.session.run(retryFeeds);
        try { if (typeof retryTensor.dispose === 'function') retryTensor.dispose(); } catch (_) {}
      } else {
        try { if (typeof inputTensor.dispose === 'function') inputTensor.dispose(); } catch (_) {}
        inputTensorDisposed = true;
        throw runErr;
      }
    }

    if (!inputTensorDisposed) {
      try { if (typeof inputTensor.dispose === 'function') inputTensor.dispose(); } catch (_) {}
    }

    const pitchOutput = outputs[this._outputName] || Object.values(outputs)[0];
    const pitchData = outputToFloat32(pitchOutput);
    const dims = pitchOutput.dims;

    // ONNX model outputs F0 in Hz directly: shape (1, n_frames, 1)
    // Extract the time dimension (second dim of [1, T, 1])
    let timeFrames;
    if (dims.length === 1) {
      timeFrames = dims[0];
    } else if (dims.length === 2) {
      timeFrames = dims[1]; // [1, T]
    } else {
      timeFrames = dims[1]; // [1, T, 1]
    }

    // outputToFloat32 already returns an independent Float32Array (fresh copy
    // on both the float16 and float32 paths), so no extra element-wise copy is
    // needed — just guard against a trailing length mismatch with subarray.
    const rawF0 = pitchData.length === timeFrames
      ? pitchData
      : pitchData.subarray(0, timeFrames);

    // Release output tensor (data already copied)
    try { if (typeof pitchOutput.dispose === 'function') pitchOutput.dispose(); } catch (_) {}

    const interpolatedF0 = FcpePitchDetector.interpolateF0(
      rawF0, resampledAudio.length, FCPE_SAMPLE_RATE, TARGET_SAMPLE_RATE, TARGET_HOP_SIZE
    );

    return framesToF0Array(interpolatedF0, TARGET_HOP_SIZE, TARGET_SAMPLE_RATE);
  }

  static interpolateF0(f0Data, originalLength, originalSr, targetSr, hopSize) {
    return resampleF0Frames(
      f0Data, originalLength, originalSr, targetSr, hopSize,
      FCPE_HOP_SIZE, FCPE_SAMPLE_RATE
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

  getDeviceInfo() {
    return this.usingDML ? 'DML' : 'CPU';
  }

  dispose() {
    if (this.session) {
      try {
        this.session.release();
      } catch (e) {
        console.warn('[FcpePitchDetector] session release failed:', e.message);
      }
      this.session = null;
      this.initialized = false;
    }
  }
}

module.exports = { FcpePitchDetector, FCPE_SAMPLE_RATE };
