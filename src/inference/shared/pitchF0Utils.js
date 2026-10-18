/**
 * pitchF0Utils —— FCPE / RMVPE 两个基频检测器共用的常量与后处理工具。
 *
 * 背景（审查项 2.2 / 2.3）：
 *   · fcpePitchDetector.js:250-357 与 rmvpePitchDetector.js:263-370 曾是 **108 行
 *     逐字相同**的代码（F0 时间轴重采样 + f0ToMidi + f0ToNotes + groupIntoNotes
 *     + createNoteFromGroup）。两份实现靠人工同步，改一处漏一处就会出现
 *     "FCPE 与 RMVPE 切出的音符不一致"的幽灵 bug。这里收敛成单一实现。
 *   · 采样率常量此前在两个文件里各写一遍（TARGET_SAMPLE_RATE / TARGET_HOP_SIZE
 *     / MAX_DURATION），与 src/inference/pipeline/constants.js 里的又一份并存，
 *     共 3 份真源。现在统一由本文件导出。
 *   · extractF0(audioData, sampleRate = 44100) 的默认值是个静默陷阱：漏传
 *     sampleRate 时 24kHz 的音频会被当成 44.1kHz 解释，F0 时间轴偏快 1.8375 倍
 *     且不报任何错。provideSampleRate() 把这个默认值换成了显式报错。
 */
const ort = require('onnxruntime-node');

// ---- 单一真源：F0 后处理的目标网格（24kHz / hop 480 = 20ms） ----
const TARGET_SAMPLE_RATE = 24000;
const TARGET_HOP_SIZE = 480;
const MAX_DURATION = 300; // 单段最长 300s，超过的帧直接截断

// ==================== 采样率校验 ====================

/**
 * 校验并返回一个可用的输入采样率。
 *
 * 历史实现里到处写着 `sampleRate || 44100`：调用方一旦漏传，24kHz 的音频会被
 * 当成 44.1kHz 送进重采样，F0 时间轴整体偏快 1.8375 倍，而调用方拿到的是
 * "看起来正常"的数组，没有任何报错。宁可显式失败。
 *
 * @param {number} sampleRate 调用方传入的采样率
 * @param {string} context 用于错误信息的调用点描述
 * @returns {number}
 */
function requireSampleRate(sampleRate, context = 'pitch extraction') {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new TypeError(
      `[pitch] ${context}: sampleRate 必须显式传入且为正数（收到 ${JSON.stringify(sampleRate)}）。` +
      '漏传会让 24kHz 音频被按 44.1kHz 解释，F0 时间轴偏快 1.8375 倍且不报错。'
    );
  }
  return sampleRate;
}

// ==================== 张量工具（float16/float32） ====================

function float32ToF16Buffer(f32Data) {
  const f16 = new Float16Array(f32Data.length);
  // TypedArray.set 走 native 路径，比逐元素 JS 赋值快一个量级
  f16.set(f32Data);
  return new Uint16Array(f16.buffer, f16.byteOffset, f16.length);
}

function f16BufferToFloat32(u16Data) {
  const f16 = new Float16Array(u16Data.buffer, u16Data.byteOffset, u16Data.length);
  const f32 = new Float32Array(f16.length);
  f32.set(f16);
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

// ==================== F0 后处理 ====================

/**
 * 把检测器原生网格（srcHop/srcSr）上的 F0 线性插值到目标网格（hopSize/targetSr）。
 *
 * FCPE 与 RMVPE 的原生网格都是 16kHz/160 hop，只是常量名不同；调用方显式传入
 * 即可复用同一份实现。
 */
function resampleF0Frames(f0Data, originalLength, originalSr, targetSr, hopSize, srcHop, srcSr) {
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

/** 把等间隔的 F0 数值数组包装成 {time, f0, confidence}[]。 */
function framesToF0Array(interpolatedF0, hopSize = TARGET_HOP_SIZE, targetSr = TARGET_SAMPLE_RATE) {
  const frameDuration = hopSize / targetSr;
  const f0Array = new Array(interpolatedF0.length);
  for (let i = 0; i < interpolatedF0.length; i++) {
    f0Array[i] = {
      time: i * frameDuration,
      f0: interpolatedF0[i],
      confidence: 0,
    };
  }
  return f0Array;
}

/** Hz → MIDI 音高；低于 f0Min 或非法值返回 0（静音）。 */
function f0ToMidi(f0, f0Min) {
  if (f0 <= 0 || f0 < f0Min) return 0;
  return Math.round(69 + 12 * Math.log2(f0 / 440));
}

// 音符 id 计数器：两个检测器共用，保证跨检测器的 id 也唯一。
let _noteIdCounter = 0;
function nextNoteId() {
  return ++_noteIdCounter;
}

function createNoteFromGroup(group, f0Min, minNoteDuration, bpm) {
  if (group.length === 0) return null;

  const avgF0 = group.reduce((sum, f) => sum + f.f0, 0) / group.length;
  const midiPitch = f0ToMidi(avgF0, f0Min);

  if (midiPitch < 24 || midiPitch > 108) return null;

  const startTime = group[0].time;
  const endTime = group[group.length - 1].time + (TARGET_HOP_SIZE / TARGET_SAMPLE_RATE);
  const duration = endTime - startTime;

  if (duration < minNoteDuration) return null;

  const beatDuration = (60 / bpm);
  const noteDurationBeats = duration / beatDuration;

  return {
    id: nextNoteId(),
    pitch: midiPitch,
    start: startTime / beatDuration,
    duration: noteDurationBeats,
    lyric: 'la',
  };
}

function groupIntoNotes(frames, f0Min, minNoteDuration, bpm) {
  const notes = [];
  if (frames.length === 0) return notes;

  let currentGroup = [frames[0]];

  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    const prevFrame = frames[i - 1];
    const currentMidi = f0ToMidi(frame.f0, f0Min);
    const prevMidi = f0ToMidi(prevFrame.f0, f0Min);

    if (currentMidi === prevMidi && Math.abs(frame.f0 - prevFrame.f0) / prevFrame.f0 < 0.1) {
      currentGroup.push(frame);
    } else {
      const note = createNoteFromGroup(currentGroup, f0Min, minNoteDuration, bpm);
      if (note) notes.push(note);
      currentGroup = [frame];
    }
  }

  const lastNote = createNoteFromGroup(currentGroup, f0Min, minNoteDuration, bpm);
  if (lastNote) notes.push(lastNote);

  return notes;
}

/** 连续有声帧 → 音符列表。 */
function f0ToNotes(f0Array, f0Min, options = {}) {
  const bpm = options.bpm ?? 120;
  const minNoteDuration = options.minNoteDuration ?? 0.1;
  const f0Threshold = options.f0Threshold ?? 50;

  const notes = [];
  if (f0Array.length === 0) return notes;

  const activeFrames = [];
  for (const frame of f0Array) {
    if (frame.f0 > f0Threshold) {
      activeFrames.push(frame);
    } else {
      if (activeFrames.length > 0) {
        const segments = groupIntoNotes(activeFrames, f0Min, minNoteDuration, bpm);
        notes.push(...segments);
        activeFrames.length = 0;
      }
    }
  }

  if (activeFrames.length > 0) {
    const segments = groupIntoNotes(activeFrames, f0Min, minNoteDuration, bpm);
    notes.push(...segments);
  }

  return notes;
}

module.exports = {
  TARGET_SAMPLE_RATE,
  TARGET_HOP_SIZE,
  MAX_DURATION,
  requireSampleRate,
  float32ToF16Buffer,
  f16BufferToFloat32,
  createFloatTensor,
  outputToFloat32,
  resampleF0Frames,
  framesToF0Array,
  f0ToMidi,
  f0ToNotes,
  groupIntoNotes,
  createNoteFromGroup,
  nextNoteId,
};
