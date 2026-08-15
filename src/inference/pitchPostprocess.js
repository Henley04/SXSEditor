'use strict';

/**
 * FCPE 音高曲线后处理管线（纯函数，无状态、可单测）。
 *
 * 目标：把 FCPE 输出的逐帧 F0 曲线转成"听感干净"的 MIDI 音符。
 * 处理顺序：
 *   1. 电平分析 / 归一化（弱信号会导致 FCPE 漏判音高）
 *   2. 逐帧 RMS 静音门限（threshold，默认 0.006）
 *   3. F0 量程门限（f0Min / f0Max）
 *   4. 中值滤波（平滑，消除跳变噪音）
 *   5. 音符切分 + 量化（严格量化 / 保留滑音 Pitch Bend）
 *   6. 最短音符过滤
 *   7. 有效人声 / 静音段检测（提示 UVR 分离质量）
 *   8. 可选自动 BPM 检测
 */

// ==================== 音高数学 ====================

function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function medianOf(arr) {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ==================== 1. 电平分析 / 归一化 ====================

/**
 * 分析音频电平，检测削波与过小信号。
 * @param {Float32Array} audio
 */
function analyzeLevel(audio) {
  let peak = 0;
  let sumSq = 0;
  let clippedSamples = 0;
  const n = audio.length;
  for (let i = 0; i < n; i++) {
    const v = audio[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
    if (a >= 0.999) clippedSamples++;
  }
  const rms = Math.sqrt(sumSq / (n || 1));
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120;
  return {
    peak,
    rms,
    peakDb,
    rmsDb,
    clippedSamples,
    clipped: n > 0 && clippedSamples / n > 0.0001,
  };
}

/**
 * 将音频峰值归一化到目标 dBFS（默认 -4.5dB，落在 -3 ~ -6dB 区间）。
 * 只做线性增益，不引入削波。
 * @param {Float32Array} audio
 * @param {number} targetPeakDb
 * @returns {Float32Array}
 */
function normalizeToTargetDb(audio, targetPeakDb = -4.5) {
  const { peak } = analyzeLevel(audio);
  if (peak <= 0) return new Float32Array(audio);
  const targetPeak = Math.pow(10, targetPeakDb / 20);
  const gain = targetPeak / peak;
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) out[i] = audio[i] * gain;
  return out;
}

// ==================== 2. 静音门限 ====================

/**
 * 按帧计算 RMS 包络。帧长与 F0 帧长一致（默认 20ms）。
 * @param {Float32Array} audio
 * @param {number} sampleRate
 * @param {number} frameDuration 秒
 * @returns {Float32Array} 每帧 RMS
 */
function computeFrameRms(audio, sampleRate, frameDuration) {
  const hop = Math.max(1, Math.round(frameDuration * sampleRate));
  const nFrames = Math.ceil(audio.length / hop);
  const rms = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const start = i * hop;
    const end = Math.min(audio.length, start + hop);
    const len = end - start;
    let sum = 0;
    for (let j = start; j < end; j++) sum += audio[j] * audio[j];
    rms[i] = len > 0 ? Math.sqrt(sum / len) : 0;
  }
  return rms;
}

/**
 * 用 RMS 静音门限把低于阈值的帧强制置为静音（f0=0）。
 * @param {Array<{time:number,f0:number}>} f0Array
 * @param {Float32Array} rmsArray
 * @param {number} threshold
 */
function gateByThreshold(f0Array, rmsArray, threshold) {
  const out = new Array(f0Array.length);
  for (let i = 0; i < f0Array.length; i++) {
    const f = f0Array[i];
    const r = rmsArray[i] !== undefined ? rmsArray[i] : 0;
    if (f.f0 > 0 && r >= threshold) {
      out[i] = { time: f.time, f0: f.f0 };
    } else {
      out[i] = { time: f.time, f0: 0 };
    }
  }
  return out;
}

// ==================== 3. F0 量程门限 ====================

function gateByRange(f0Array, f0Min, f0Max) {
  const out = new Array(f0Array.length);
  for (let i = 0; i < f0Array.length; i++) {
    const f = f0Array[i];
    if (f.f0 > 0 && (f.f0 < f0Min || f.f0 > f0Max)) {
      out[i] = { time: f.time, f0: 0 };
    } else {
      out[i] = { time: f.time, f0: f.f0 };
    }
  }
  return out;
}

/**
 * 统计已发声帧的 F0 分布，用于"自动适配音域"。
 * @returns {{p2:number, p98:number, min:number, max:number, voicedCount:number}}
 */
function f0RangeStats(f0Array) {
  const voiced = [];
  for (const f of f0Array) if (f.f0 > 0) voiced.push(f.f0);
  if (voiced.length === 0) return { p2: 55, p98: 880, min: 0, max: 0, voicedCount: 0 };
  voiced.sort((a, b) => a - b);
  const p2 = voiced[Math.floor(voiced.length * 0.02)];
  const p98 = voiced[Math.min(voiced.length - 1, Math.floor(voiced.length * 0.98))];
  return { p2, p98, min: voiced[0], max: voiced[voiced.length - 1], voicedCount: voiced.length };
}

/**
 * 由 F0 分布自动推导量程（扩展一点余量并夹到安全区间）。
 */
function autoRangeFromStats(stats, clampMin = 50, clampMax = 1200) {
  if (stats.voicedCount === 0) return { f0Min: 80, f0Max: 880 };
  const lo = Math.max(clampMin, Math.floor(stats.p2 * 0.9));
  const hi = Math.min(clampMax, Math.ceil(stats.p98 * 1.05));
  return { f0Min: lo, f0Max: Math.max(lo + 1, hi) };
}

// ==================== 4. 中值滤波（平滑） ====================

/**
 * 对已发声帧做中值滤波，消除跳变噪音。静音帧保持不变（保留音符边界）。
 * @param {Array<{time:number,f0:number}>} f0Array
 * @param {number} windowSize 奇数窗口大小
 */
function medianFilterF0(f0Array, windowSize) {
  if (!f0Array || f0Array.length === 0 || windowSize <= 1) return f0Array;
  const half = Math.floor(windowSize / 2);
  const out = new Array(f0Array.length);
  for (let i = 0; i < f0Array.length; i++) {
    const cur = f0Array[i];
    if (!cur.f0 || cur.f0 <= 0) {
      out[i] = { time: cur.time, f0: 0 };
      continue;
    }
    const lo = Math.max(0, i - half);
    const hi = Math.min(f0Array.length - 1, i + half);
    const vals = [];
    for (let j = lo; j <= hi; j++) {
      if (f0Array[j].f0 > 0) vals.push(f0Array[j].f0);
    }
    out[i] = { time: cur.time, f0: vals.length ? medianOf(vals) : 0 };
  }
  return out;
}

/**
 * 平滑档位 -> 中值窗口大小（帧长 20ms）。
 * @param {'low'|'medium'|'high'} smoothing
 */
function smoothingWindow(smoothing) {
  switch (smoothing) {
    case 'low': return 3;
    case 'high': return 9;
    case 'medium':
    default: return 5;
  }
}

// ==================== 5. 音符切分 + 量化 ====================

/**
 * 前瞻检测：从 startIdx 起连续 minNoteFrames 帧都稳定靠近 newMidi，才判定为真正换音。
 */
function lookaheadStable(segment, startIdx, minNoteFrames, newMidi) {
  const end = Math.min(segment.length, startIdx + minNoteFrames);
  for (let i = startIdx; i < end; i++) {
    if (Math.abs(hzToMidi(segment[i].f0) - newMidi) > 0.5) return false;
  }
  return true;
}

/**
 * 严格量化：所有音高强制对齐到半音。颤音（±0.5 半音内抖动）保留在同一音符。
 */
function splitSegmentStrict(segment, frameDur, minNoteFrames) {
  const sub = [];
  let cur = [];
  for (let i = 0; i < segment.length; i++) {
    const f = segment[i];
    if (cur.length === 0) { cur.push(f); continue; }
    const curMed = medianOf(cur.map((c) => hzToMidi(c.f0)));
    const midi = hzToMidi(f.f0);
    if (Math.abs(midi - curMed) <= 0.5) {
      cur.push(f);
    } else if (lookaheadStable(segment, i, minNoteFrames, midi)) {
      sub.push(cur);
      cur = [f];
    } else {
      cur.push(f); // 短暂抖动，视为颤音的一部分
    }
  }
  if (cur.length) sub.push(cur);
  return sub;
}

/**
 * 保留滑音/Pitch Bend：音符内允许更大滑移（slideTolerance 半音内），
 * 音符中心取中值，逐帧记录偏离中心的 cents 作为 Pitch Bend。
 */
function splitSegmentPitchBend(segment, frameDur, minNoteFrames, slideToleranceSemitones) {
  const sub = [];
  let cur = [];
  for (let i = 0; i < segment.length; i++) {
    const f = segment[i];
    if (cur.length === 0) { cur.push(f); continue; }
    const curMed = medianOf(cur.map((c) => hzToMidi(c.f0)));
    const midi = hzToMidi(f.f0);
    if (Math.abs(midi - curMed) <= slideToleranceSemitones) {
      cur.push(f);
    } else if (lookaheadStable(segment, i, minNoteFrames, midi)) {
      sub.push(cur);
      cur = [f];
    } else {
      cur.push(f);
    }
  }
  if (cur.length) sub.push(cur);
  return sub;
}

/**
 * 将 F0 帧数组切分为音符。
 * @param {Array<{time:number,f0:number}>} f0Array 已门限/平滑后的曲线
 * @param {object} options
 * @param {'strict'|'pitchbend'} options.quantization
 * @param {number} options.minNoteDuration 秒
 * @param {number} options.bpm
 * @param {number} options.maxBendCents 最大 Pitch Bend（cents），超出截断
 * @param {number} options.slideToleranceSemitones pitchbend 模式下滑音容差
 * @returns {{notes:Array, pitchBends:Array}}
 */
function segmentNotes(f0Array, options) {
  const {
    quantization = 'strict',
    minNoteDuration = 0.05,
    bpm = 120,
    maxBendCents = 400,
    slideToleranceSemitones = 6,
  } = options;

  const notes = [];
  const pitchBends = [];
  if (!f0Array || f0Array.length === 0) return { notes, pitchBends };

  const frameDur = f0Array.length > 1 ? f0Array[1].time - f0Array[0].time : 0.02;
  const minNoteFrames = Math.max(1, Math.round(minNoteDuration / (frameDur || 0.02)));
  const beatDur = 60 / bpm;

  // 切分出连续发声段
  let segment = [];
  const flush = () => {
    if (segment.length === 0) return;
    const subs = quantization === 'pitchbend'
      ? splitSegmentPitchBend(segment, frameDur, minNoteFrames, slideToleranceSemitones)
      : splitSegmentStrict(segment, frameDur, minNoteFrames);
    for (const sub of subs) {
      const note = subsegmentToNote(sub, frameDur, minNoteDuration, beatDur);
      if (!note) continue;
      notes.push(note);
      if (quantization === 'pitchbend') {
        const bends = sub.map((f) => {
          const cents = (hzToMidi(f.f0) - note.pitch) * 100;
          const clamped = Math.max(-maxBendCents, Math.min(maxBendCents, cents));
          return { time: f.time, cents: clamped };
        }).filter((b) => Math.abs(b.cents) >= 5);
        if (bends.length) {
          note.bend = bends;
          pitchBends.push({ noteIndex: notes.length - 1, bends });
        }
      }
    }
    segment = [];
  };

  for (const f of f0Array) {
    if (f.f0 > 0) segment.push(f);
    else flush();
  }
  flush();
  return { notes, pitchBends };
}

function subsegmentToNote(sub, frameDur, minNoteDuration, beatDur) {
  const midis = sub.map((c) => hzToMidi(c.f0));
  const pitch = Math.round(medianOf(midis));
  if (pitch < 21 || pitch > 108) return null;
  const startSec = sub[0].time;
  const endSec = sub[sub.length - 1].time + frameDur;
  const durSec = endSec - startSec;
  if (durSec < minNoteDuration) return null;
  return {
    pitch,
    start: startSec / beatDur,
    duration: durSec / beatDur,
    startSec,
    durationSec: durSec,
    lyric: 'la',
  };
}

// ==================== 7. 有效人声检测 ====================

function detectVoiceQuality(f0Array, _durationSec) {
  let voiced = 0;
  let first3Voiced = 0;
  let first3Total = 0;
  for (const f of f0Array) {
    if (f.time < 3) {
      first3Total++;
      if (f.f0 > 0) first3Voiced++;
    }
    if (f.f0 > 0) voiced++;
  }
  const total = f0Array.length || 1;
  const voicedRatio = voiced / total;
  const first3Ratio = first3Total > 0 ? first3Voiced / first3Total : 0;
  const warnings = [];
  if (voicedRatio < 0.05) warnings.push('noVoice');
  else if (voicedRatio < 0.2) warnings.push('lowVoice');
  if (first3Total >= 5 && first3Ratio < 0.05) warnings.push('first3Silent');
  return { voicedRatio, first3Ratio, warnings };
}

// ==================== 8. 自动 BPM 检测 ====================

/**
 * 基于短时能量包络 + 自相关的轻量 BPM 估计。失稳时返回 fallback。
 * @param {Float32Array} audio
 * @param {number} sampleRate
 * @param {number} fallback
 */
function detectBpm(audio, sampleRate, fallback = 120) {
  const win = 1024;
  const hop = 512;
  const nWindows = Math.floor((audio.length - win) / hop);
  if (nWindows < 20) return fallback;

  const energy = new Float32Array(nWindows);
  for (let i = 0; i < nWindows; i++) {
    let s = 0;
    const start = i * hop;
    for (let j = start; j < start + win; j++) s += audio[j] * audio[j];
    energy[i] = s / win;
  }
  const onset = new Float32Array(nWindows - 1);
  for (let i = 1; i < nWindows; i++) {
    const d = energy[i] - energy[i - 1];
    onset[i - 1] = d > 0 ? d : 0;
  }
  const frameRate = sampleRate / hop;
  const minLag = Math.max(1, Math.floor(frameRate * 60 / 180));
  const maxLag = Math.ceil(frameRate * 60 / 55);
  let bestLag = -1;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag && lag < onset.length; lag++) {
    let score = 0;
    let count = 0;
    for (let i = 0; i + lag < onset.length; i++) {
      score += onset[i] * onset[i + lag];
      count++;
    }
    const norm = count > 0 ? score / count : 0;
    if (norm > bestScore) { bestScore = norm; bestLag = lag; }
  }
  if (bestLag <= 0 || bestScore < 1e-7) return fallback;
  let bpm = frameRate * 60 / bestLag;
  while (bpm < 60) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}

module.exports = {
  hzToMidi,
  midiToHz,
  medianOf,
  analyzeLevel,
  normalizeToTargetDb,
  computeFrameRms,
  gateByThreshold,
  gateByRange,
  f0RangeStats,
  autoRangeFromStats,
  medianFilterF0,
  smoothingWindow,
  segmentNotes,
  detectVoiceQuality,
  detectBpm,
};