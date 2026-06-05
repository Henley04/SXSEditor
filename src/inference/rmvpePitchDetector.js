const path = require('node:path');
const ort = require('onnxruntime-node');
const { resampleAudio } = require('../utils/resampleAudio');

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

const RMVPE_SAMPLE_RATE = 16000;
const HOP_LENGTH = 160;
const N_CLASS = 2560;
const F0_MIN = 30;
const F0_MAX = 7600;
const TARGET_SAMPLE_RATE = 24000;
const TARGET_HOP_SIZE = 480;
const MAX_DURATION = 300;

class RmvpePitchDetector {
  constructor(modelDir, options = {}) {
    this.modelDir = modelDir;
    this.deviceId = options.deviceId;
    this.session = null;
    this.initialized = false;
    this.isFP16 = false;
    this.usingDML = false;
  }

  async init() {
    if (this.initialized) return true;

    const modelPath = path.join(this.modelDir, 'preprocess', 'rmvpe_model.onnx');
    console.log('[RmvpePitchDetector] 尝试加载模型:', modelPath);

    // 检查文件是否存在
    const fs = require('fs');
    if (!fs.existsSync(modelPath)) {
      const errMsg = `[RmvpePitchDetector] 模型文件不存在: ${modelPath}`;
      console.error(errMsg);
      const err = new Error(errMsg);
      err.code = 'MODEL_NOT_FOUND';
      err.modelPath = modelPath;
      throw err;
    }

    const stats = fs.statSync(modelPath);
    console.log(`[RmvpePitchDetector] 模型文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    try {
      let sessionOptions = {
        executionProviders: ['cpu'],
      };
      
      try {
        const dmlEp = typeof this.deviceId === 'number'
          ? { name: 'dml', deviceId: this.deviceId }
          : 'dml';
        const dmlOptions = {
          executionProviders: [dmlEp],
          enableMemPattern: true,
          enableCpuMemArena: true,
        };
        this.session = await ort.InferenceSession.create(modelPath, dmlOptions);
        this.usingDML = true;
        const deviceTag = typeof this.deviceId === 'number' ? ` [DML deviceId=${this.deviceId}]` : ' [DML]';
        console.log(`[RmvpePitchDetector] 模型加载成功${deviceTag}`);
      } catch (dmlErr) {
        console.log('[RmvpePitchDetector] DirectML不可用，回退到CPU:', dmlErr.message);
        this.session = await ort.InferenceSession.create(modelPath, sessionOptions);
        this.usingDML = false;
        console.log('[RmvpePitchDetector] 模型加载成功 [CPU]');
      }
      
      this.initialized = true;

      // 检测模型精度：通过检查输入类型判断是否为 FP16 模型
      const inputMetadata = this.session.inputMetadata;
      const audioInputMeta = inputMetadata.find(m => m.name === 'audio') || inputMetadata[0];
      this.isFP16 = audioInputMeta?.type === 'float16';
      console.log(`[RmvpePitchDetector] 模型精度: ${this.isFP16 ? 'FP16 (半精度)' : 'FP32 (全精度)'}`);

      console.log('[RmvpePitchDetector] 输入名称:', this.session.inputNames);
      console.log('[RmvpePitchDetector] 输出名称:', this.session.outputNames);
      return true;
    } catch (err) {
      console.error('[RmvpePitchDetector] 模型加载失败:', err.message);
      err.modelPath = modelPath;
      throw err;
    }
  }

  async extractF0(audioData, sampleRate = 44100) {
    if (!this.initialized) {
      await this.init();
    }

    const resampledAudio = sampleRate !== RMVPE_SAMPLE_RATE
      ? resampleAudio(audioData, sampleRate, RMVPE_SAMPLE_RATE)
      : audioData;

    const tensorType = this.isFP16 ? 'float16' : 'float32';
    const inputTensor = createFloatTensor(tensorType, resampledAudio, [1, resampledAudio.length]);

    const outputs = await this.session.run({ audio: inputTensor });

    const pitchOutput = Object.values(outputs)[0];
    const pitchData = outputToFloat32(pitchOutput);
    const timeFrames = pitchOutput.dims[1];

    const rawF0 = new Float32Array(timeFrames);

    for (let t = 0; t < timeFrames; t++) {
      let maxProb = -Infinity;
      let maxIndex = 0;

      for (let c = 0; c < N_CLASS; c++) {
        const prob = pitchData[t * N_CLASS + c];
        if (prob > maxProb) {
          maxProb = prob;
          maxIndex = c;
        }
      }

      rawF0[t] = this.indexToF0(maxIndex);
    }

    const interpolatedF0 = RmvpePitchDetector.interpolateF0(
      rawF0, resampledAudio.length, RMVPE_SAMPLE_RATE, TARGET_SAMPLE_RATE, TARGET_HOP_SIZE
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

  indexToF0(index) {
    return F0_MIN * Math.pow(F0_MAX / F0_MIN, index / (N_CLASS - 1));
  }

  static interpolateF0(f0Data, originalLength, originalSr, targetSr, hopSize) {
    const rmvpeHop = 160;
    const rmvpeSr = 16000;

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

    const srcStep = rmvpeHop / rmvpeSr;
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
        console.warn('[RmvpePitchDetector] 释放会话失败:', e.message);
      }
      this.session = null;
      this.initialized = false;
    }
  }
}

module.exports = { RmvpePitchDetector, RMVPE_SAMPLE_RATE };
