const path = require('node:path');
const ort = require('onnxruntime-node');
const { resampleAudio } = require('../utils/resampleAudio');
const { buildSessionOptions } = require('./shared/ortOptions');

let _noteIdCounter = 0;

/**
 * 释放 feeds 对象中的所有输入张量。
 * 用于 RosVot 推理后释放 wav/pitch/uv/word_bd 张量，防止内存累积。
 * @param {Object} feeds - session.run() 的输入对象
 */
function _disposeFeeds(feeds) {
    if (!feeds) return;
    for (const key of Object.keys(feeds)) {
        const t = feeds[key];
        try { if (t && typeof t.dispose === 'function') t.dispose(); } catch (_) {}
    }
}

const ROSVOT_SAMPLE_RATE = 24000;
const ROSVOT_HOP_SIZE = 128;
const ROSVOT_MAX_FRAMES = 4000;
const ROSVOT_MAX_SAMPLES = ROSVOT_MAX_FRAMES * ROSVOT_HOP_SIZE; // 512000
const F0_THRESHOLD = 50;

class RosvotDetector {
  constructor(modelDir, options = {}) {
    this.modelDir = modelDir;
    this.deviceId = options.deviceId;
    this.session = null;
    this.initialized = false;
    this.usingDML = false;
  }

  async init() {
    if (this.initialized) return true;

    const modelPath = path.join(this.modelDir, 'preprocess', 'rosvot_model.onnx');
    console.log('[RosvotDetector] attempting to load model:', modelPath);

    const fs = require('fs');
    if (!fs.existsSync(modelPath)) {
      const errMsg = `[RosvotDetector] model file does not exist: ${modelPath}`;
      console.error(errMsg);
      const err = new Error(errMsg);
      err.code = 'MODEL_NOT_FOUND';
      err.modelPath = modelPath;
      throw err;
    }

    const stats = fs.statSync(modelPath);
    console.log(`[RosvotDetector] model file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    try {
      // RosVot 模型包含 ConvTranspose 等不兼容 DML 的算子，直接使用 CPU
      const sessionOptions = buildSessionOptions({
        executionProviders: ['cpu'],
      });
      this.session = await ort.InferenceSession.create(modelPath, sessionOptions);
      this.usingDML = false;
      console.log('[RosvotDetector] model loaded successfully [CPU] (ConvTranspose incompatible with DML)');

      this.initialized = true;
      console.log('[RosvotDetector] input names:', [...this.session.inputNames]);
      console.log('[RosvotDetector] output names:', [...this.session.outputNames]);
      return true;
    } catch (err) {
      console.error('[RosvotDetector] model load failed:', err.message);
      err.modelPath = modelPath;
      throw err;
    }
  }

  /**
   * 将 RMVPE 提取的 F0 数组转换为 RosVot 模型所需的 pitch 和 uv 输入
   * @param {Array} f0Array - RMVPE 输出的 F0 数组 [{time, f0, confidence}, ...]
   * @param {number} targetFrames - 目标帧数 (4000)
   * @param {number} audioSampleRate - 原始音频采样率
   * @param {number} audioLength - 原始音频样本数
   * @returns {{pitch: BigInt64Array, uv: BigInt64Array}}
   */
  f0ToRosvotInput(f0Array, targetFrames, _audioSampleRate, _audioLength) {
    const pitch = new BigInt64Array(targetFrames);
    const uv = new BigInt64Array(targetFrames);

    if (f0Array.length === 0) {
      uv.fill(1n);
      return { pitch, uv };
    }

    const frameDuration = ROSVOT_HOP_SIZE / ROSVOT_SAMPLE_RATE;

    for (let i = 0; i < targetFrames; i++) {
      const frameTime = i * frameDuration;

      // 在 f0Array 中找到最近的帧
      const f0Idx = this._findClosestF0Index(f0Array, frameTime);
      const f0Value = f0Array[f0Idx].f0;

      if (f0Value > F0_THRESHOLD) {
        // 有声音帧：将 F0 转换为 MIDI 音符号
        const midiNote = Math.round(69 + 12 * Math.log2(f0Value / 440));
        pitch[i] = BigInt(Math.max(0, Math.min(127, midiNote)));
        uv[i] = 0n; // 有声音
      } else {
        pitch[i] = 0n;
        uv[i] = 1n; // 无声音
      }
    }

    return { pitch, uv };
  }

  _findClosestF0Index(f0Array, targetTime) {
    let lo = 0;
    let hi = f0Array.length - 1;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (f0Array[mid].time < targetTime) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    if (lo > 0 && Math.abs(f0Array[lo - 1].time - targetTime) < Math.abs(f0Array[lo].time - targetTime)) {
      return lo - 1;
    }
    return lo;
  }

  /**
   * 使用 RosVot 模型从音频和 F0 数据中提取 MIDI 音符
   * @param {Float32Array} audioData - 原始音频数据
   * @param {number} sampleRate - 音频采样率
   * @param {Array} f0Array - RMVPE 提取的 F0 数组
   * @param {number} bpm - 节拍速度
   * @returns {Array} MIDI 音符数组
   */
  extractNotes(audioData, sampleRate, f0Array, bpm = 120) {
    if (!this.initialized) {
      throw new Error('RosvotDetector not initialized');
    }

    // 1. 重采样音频到 24kHz
    const resampledAudio = sampleRate !== ROSVOT_SAMPLE_RATE
      ? resampleAudio(audioData, sampleRate, ROSVOT_SAMPLE_RATE)
      : audioData;

    // 2. 计算实际帧数和需要的填充
    const actualFrames = Math.min(
      Math.floor(resampledAudio.length / ROSVOT_HOP_SIZE),
      ROSVOT_MAX_FRAMES
    );
    const actualSamples = actualFrames * ROSVOT_HOP_SIZE;

    // 3. 填充音频到固定长度
    const wavPadded = new Float32Array(ROSVOT_MAX_SAMPLES);
    wavPadded.set(resampledAudio.subarray(0, actualSamples));

    // 4. 将 F0 转换为 pitch 和 uv
    const { pitch, uv } = this.f0ToRosvotInput(
      f0Array, ROSVOT_MAX_FRAMES, sampleRate, audioData.length
    );

    // 5. word_bd 全部设为 0（无词边界信息）
    const word_bd = new BigInt64Array(ROSVOT_MAX_FRAMES);

    // 6. 运行模型推理
    const feeds = {
      wav: new ort.Tensor('float32', wavPadded, [1, ROSVOT_MAX_SAMPLES]),
      pitch: new ort.Tensor('int64', pitch, [1, ROSVOT_MAX_FRAMES]),
      uv: new ort.Tensor('int64', uv, [1, ROSVOT_MAX_FRAMES]),
      word_bd: new ort.Tensor('int64', word_bd, [1, ROSVOT_MAX_FRAMES]),
    };

    // 同步运行（在 async 方法中需要用 run）
    return this._runInference(feeds, actualFrames, bpm);
  }

  async _runInference(feeds, actualFrames, bpm) {
    let results;
    try {
      results = await this.session.run(feeds);
    } catch (runErr) {
      // DML 可能在 ConvTranspose 等节点上失败，回退到 CPU
      if (this.usingDML) {
        console.warn('[RosvotDetector] DML inference failed, falling back to CPU:', runErr.message);
        try {
          this.session.release();
        } catch (_) {}
        this.session = null;
        this.usingDML = false;

        const modelPath = path.join(this.modelDir, 'preprocess', 'rosvot_model.onnx');
        this.session = await ort.InferenceSession.create(modelPath,
          buildSessionOptions({ executionProviders: ['cpu'] }));
        console.log('[RosvotDetector] fell back to CPU inference');
        results = await this.session.run(feeds);
      } else {
        // 释放输入张量后重新抛出
        _disposeFeeds(feeds);
        throw runErr;
      }
    }

    // 释放输入张量（性能审查 #3 中优先级：RosVot 输入泄漏）
    _disposeFeeds(feeds);

    const noteBdPred = results.note_bd_pred;
    const notePred = results.note_pred;
    const noteLengths = results.note_lengths;

    const numNotes = Number(noteLengths.data[0]);
    const boundaries = noteBdPred.data;
    const notePitches = notePred.data;

    // 解析 note boundary 预测，找到音符边界
    const noteBoundaryFrames = [];
    for (let i = 0; i < actualFrames; i++) {
      if (Number(boundaries[i]) !== 0) {
        noteBoundaryFrames.push(i);
      }
    }

    // 根据 note_bd_pred 和 note_pred 构建 MIDI 音符
    const notes = this._buildNotesFromBoundaries(
      noteBoundaryFrames, notePitches, numNotes, actualFrames, bpm
    );

    // 释放输出张量
    noteBdPred.dispose();
    notePred.dispose();
    noteLengths.dispose();

    return notes;
  }

  _buildNotesFromBoundaries(boundaryFrames, notePitches, numNotes, actualFrames, bpm) {
    const notes = [];
    const frameDuration = ROSVOT_HOP_SIZE / ROSVOT_SAMPLE_RATE;
    const beatDuration = 60 / bpm;

    if (numNotes <= 0 || boundaryFrames.length === 0) {
      return notes;
    }

    // 将边界帧转换为时间点
    const boundaryTimes = boundaryFrames.map(f => f * frameDuration);

    // 每两个相邻边界之间是一个音符
    for (let i = 0; i < boundaryTimes.length - 1; i++) {
      const startTime = boundaryTimes[i];
      const endTime = boundaryTimes[i + 1];
      const duration = endTime - startTime;

      // 获取该音符的音高
      const pitchIdx = Math.min(i, numNotes - 1);
      const midiPitch = Number(notePitches[pitchIdx]);

      if (midiPitch <= 0 || midiPitch > 127) continue;
      if (duration < 0.05) continue;

      notes.push({
        id: ++_noteIdCounter,
        pitch: midiPitch,
        start: startTime / beatDuration,
        duration: duration / beatDuration,
        lyric: 'la',
      });
    }

    return notes;
  }

  dispose() {
    if (this.session) {
      try {
        this.session.release();
      } catch (e) {
        console.warn('[RosvotDetector] session release failed:', e.message);
      }
      this.session = null;
      this.initialized = false;
      this.usingDML = false;
    }
  }
}

module.exports = { RosvotDetector, ROSVOT_SAMPLE_RATE, ROSVOT_HOP_SIZE, ROSVOT_MAX_FRAMES };
