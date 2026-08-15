const path = require('node:path');
const ort = require('onnxruntime-node');
const { resampleAudio } = require('../utils/resampleAudio');
const { buildSessionOptions } = require('./shared/ortOptions');

// float16 patch 由 nativeSvsPipeline.js 统一执行，此处不再重复
let _noteIdCounter = 0;

// Float32 <-> Float16 转换工具
function float32ToF16Buffer(f32Data) {
    const f16 = new Float16Array(f32Data.length);
    for (let i = 0; i < f32Data.length; i++) {
        f16[i] = f32Data[i];
    }
    return new Uint16Array(f16.buffer, f16.byteOffset, f16.length);
}

function f16BufferToFloat32(u16Data) {
    const f16 = new Float16Array(u16Data.buffer, u16Data.byteOffset, u16Data.length);
    const f32 = new Float32Array(f16.length);
    for (let i = 0; i < f16.length; i++) {
        f32[i] = f16[i];
    }
    return f32;
}

function createFloatTensor(type, f32Data, dims) {
    if (type === 'float16') {
        return new ort.Tensor('float16', float32ToF16Buffer(f32Data), dims);
    }
    return new ort.Tensor('float32', f32Data, dims);
}

function outputToFloat32(tensor) {
    if (tensor.type === 'float16') {
        return f16BufferToFloat32(tensor.data);
    }
    return new Float32Array(tensor.data);
}

const FCPE_SAMPLE_RATE = 16000;
const FCPE_HOP_SIZE = 160; // 10ms at 16kHz
const F0_MIN = 50;
const F0_MAX = 1100;
const TARGET_SAMPLE_RATE = 24000;
const TARGET_HOP_SIZE = 480;
const MAX_DURATION = 300;

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

  async extractF0(audioData, sampleRate = 44100) {
    if (!this.initialized) {
      await this.init();
    }

    const resampledAudio = sampleRate !== FCPE_SAMPLE_RATE
      ? resampleAudio(audioData, sampleRate, FCPE_SAMPLE_RATE)
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

    const rawF0 = new Float32Array(timeFrames);
    for (let t = 0; t < timeFrames; t++) {
      rawF0[t] = pitchData[t];
    }

    // Release output tensor (data already copied)
    try { if (typeof pitchOutput.dispose === 'function') pitchOutput.dispose(); } catch (_) {}

    const interpolatedF0 = FcpePitchDetector.interpolateF0(
      rawF0, resampledAudio.length, FCPE_SAMPLE_RATE, TARGET_SAMPLE_RATE, TARGET_HOP_SIZE
    );

    const frameDuration = TARGET_HOP_SIZE / TARGET_SAMPLE_RATE;
    const f0Array = [];

    for (let i = 0; i < interpolatedF0.length; i++) {
      f0Array.push({
        time: i * frameDuration,
        f0: interpolatedF0[i],
        confidence: 0,
      });
    }

    return f0Array;
  }

  static interpolateF0(f0Data, originalLength, originalSr, targetSr, hopSize) {
    const srcHop = FCPE_HOP_SIZE;
    const srcSr = FCPE_SAMPLE_RATE;

    const batchMaxLength = Math.floor(MAX_DURATION * targetSr / hopSize);
    const durationInSeconds = originalLength / originalSr;
    const effectiveTargetLength = Math.floor(durationInSeconds * targetSr);
    const originalFrames = Math.ceil(effectiveTargetLength / hopSize);
    const targetFrames = Math.min(originalFrames, batchMaxLength);

    const result = new Float32Array(targetFrames);

    if (f0Data.length === 0) {
      return result;
    }

    if (f0Data.length === 1) {
      result[0] = f0Data[0];
      return result;
    }

    const srcStep = srcHop / srcSr;
    const tgtStep = hopSize / targetSr;
    const tSrcMax = (f0Data.length - 1) * srcStep;

    for (let i = 0; i < targetFrames; i++) {
      const t = i * tgtStep;

      if (t > tSrcMax) {
        result[i] = 0;
        continue;
      }

      const srcFloatIdx = t / srcStep;
      const srcIdx = Math.floor(srcFloatIdx);

      if (srcIdx >= f0Data.length - 1) {
        result[i] = f0Data[f0Data.length - 1];
      } else {
        const frac = srcFloatIdx - srcIdx;
        result[i] = f0Data[srcIdx] * (1 - frac) + f0Data[srcIdx + 1] * frac;
      }
    }

    return result;
  }

  f0ToMidi(f0) {
    if (f0 <= 0 || f0 < F0_MIN) return 0;
    return Math.round(69 + 12 * Math.log2(f0 / 440));
  }

  f0ToNotes(f0Array, bpm = 120, minNoteDuration = 0.1, f0Threshold = 50) {
    const notes = [];
    if (f0Array.length === 0) return notes;

    const activeFrames = [];
    for (const frame of f0Array) {
      if (frame.f0 > f0Threshold) {
        activeFrames.push(frame);
      } else {
        if (activeFrames.length > 0) {
          const segments = this.groupIntoNotes(activeFrames, minNoteDuration, bpm);
          notes.push(...segments);
          activeFrames.length = 0;
        }
      }
    }

    if (activeFrames.length > 0) {
      const segments = this.groupIntoNotes(activeFrames, minNoteDuration, bpm);
      notes.push(...segments);
    }

    return notes;
  }

  groupIntoNotes(frames, minNoteDuration, bpm) {
    const notes = [];
    if (frames.length === 0) return notes;

    let currentGroup = [frames[0]];

    for (let i = 1; i < frames.length; i++) {
      const frame = frames[i];
      const prevFrame = frames[i - 1];
      const currentMidi = this.f0ToMidi(frame.f0);
      const prevMidi = this.f0ToMidi(prevFrame.f0);

      if (currentMidi === prevMidi && Math.abs(frame.f0 - prevFrame.f0) / prevFrame.f0 < 0.1) {
        currentGroup.push(frame);
      } else {
        const note = this.createNoteFromGroup(currentGroup, minNoteDuration, bpm);
        if (note) notes.push(note);
        currentGroup = [frame];
      }
    }

    const lastNote = this.createNoteFromGroup(currentGroup, minNoteDuration, bpm);
    if (lastNote) notes.push(lastNote);

    return notes;
  }

  createNoteFromGroup(group, minNoteDuration, bpm) {
    if (group.length === 0) return null;

    const avgF0 = group.reduce((sum, f) => sum + f.f0, 0) / group.length;
    const midiPitch = this.f0ToMidi(avgF0);

    if (midiPitch < 24 || midiPitch > 108) return null;

    const startTime = group[0].time;
    const endTime = group[group.length - 1].time + (TARGET_HOP_SIZE / TARGET_SAMPLE_RATE);
    const duration = endTime - startTime;

    if (duration < minNoteDuration) return null;

    const beatDuration = (60 / bpm);
    const noteDurationBeats = duration / beatDuration;

    return {
      id: ++_noteIdCounter,
      pitch: midiPitch,
      start: startTime / beatDuration,
      duration: noteDurationBeats,
      lyric: 'la',
    };
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
