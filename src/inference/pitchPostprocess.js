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

/**
 * 增量中值（P1）：维护一个有序数组，push 用二分插入，median 为 O(1)。
 *
 * 音符切分时每来一帧都要"当前已收帧的中值"：原实现每帧 `medianOf(cur.map(...))`
 * （slice + sort），单音符段整体 O(n² log n)。这里把排序摊到插入上，输出与
 * medianOf 完全一致（偶数长度取中间两数的算术平均，奇数取中位）。
 */
function createIncrementalMedian() {
  const sorted = [];
  return {
    push(value) {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < value) lo = mid + 1;
        else hi = mid;
      }
      sorted.splice(lo, 0, value);
    },
    value() {
      const n = sorted.length;
      if (n === 0) return 0;
      const m = n >> 1;
      return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    },
  };
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
function splitSegmentStrict(segment, minNoteFrames) {
  const sub = [];
  let cur = [];
  let curMedian = createIncrementalMedian();
  for (let i = 0; i < segment.length; i++) {
    const f = segment[i];
    if (cur.length === 0) { cur.push(f); curMedian.push(hzToMidi(f.f0)); continue; }
    const curMed = curMedian.value();
    const midi = hzToMidi(f.f0);
    if (Math.abs(midi - curMed) <= 0.5) {
      cur.push(f);
      curMedian.push(midi);
    } else if (lookaheadStable(segment, i, minNoteFrames, midi)) {
      sub.push(cur);
      cur = [f];
      curMedian = createIncrementalMedian();
      curMedian.push(midi);
    } else {
      cur.push(f); // 短暂抖动，视为颤音的一部分
      curMedian.push(midi);
    }
  }
  if (cur.length) sub.push(cur);
  return sub;
}

/**
 * 保留滑音/Pitch Bend：音符内允许更大滑移（slideTolerance 半音内），
 * 音符中心取中值，逐帧记录偏离中心的 cents 作为 Pitch Bend。
 */
function splitSegmentPitchBend(segment, minNoteFrames, slideToleranceSemitones) {
  const sub = [];
  let cur = [];
  let curMedian = createIncrementalMedian();
  for (let i = 0; i < segment.length; i++) {
    const f = segment[i];
    if (cur.length === 0) { cur.push(f); curMedian.push(hzToMidi(f.f0)); continue; }
    const curMed = curMedian.value();
    const midi = hzToMidi(f.f0);
    if (Math.abs(midi - curMed) <= slideToleranceSemitones) {
      cur.push(f);
      curMedian.push(midi);
    } else if (lookaheadStable(segment, i, minNoteFrames, midi)) {
      sub.push(cur);
      cur = [f];
      curMedian = createIncrementalMedian();
      curMedian.push(midi);
    } else {
      cur.push(f);
      curMedian.push(midi);
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
      ? splitSegmentPitchBend(segment, minNoteFrames, slideToleranceSemitones)
      : splitSegmentStrict(segment, minNoteFrames);
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

// ==================== 6. 音符生成 / 最短音符过滤 ====================

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

function detectVoiceQuality(f0Array) {
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

/** BPM 搜索范围。低于 55 的流行歌几乎不存在；高于 180 的多半是八分/十六分音符误判。 */
const BPM_MIN = 55;
const BPM_MAX = 180;
/** 节拍先验中心与宽度（八度）。人写歌集中在 80–150，用对数正态先验压住 55/200 两端。 */
const BPM_PRIOR_CENTER = 110;
const BPM_PRIOR_SIGMA_OCT = 0.85;

/**
 * 基于短时能量包络 + 归一化自相关的轻量 BPM 估计。失稳时返回 fallback。
 *
 * v2 改动（旧版会"有时准有时不准"）：
 *  1. 分析窗按**时间**定长（≈23ms）而不是按样本数，24k 与 48k 下的时间分辨率一致。
 *  2. 包络取 RMS 后做对数压缩。旧版用能量，强拍（底鼓）把弱拍（军鼓/八分音符）
 *     压掉两三个数量级，自相关只认强拍 → 结果常常是真实值的一半（120 测成 60）。
 *  3. 自相关做**归一化**（除以两段能量）。旧版累加后除以 count，长 lag 的样本少、
 *     短 lag 的样本多，天然偏向快的一侧；归一化后各 lag 可比。
 *  4. 乘对数正态先验并做抛物线插值，返回 0.1 精度。旧版 `Math.round` 到整数，
 *     长曲末尾会累积成秒级偏移（120 与 119 相差 3 分钟约 1.5 秒）。
 *
 * @param {Float32Array} audio
 * @param {number} sampleRate
 * @param {number} fallback
 * @returns {number} BPM（0.1 精度）
 */
function detectBpm(audio, sampleRate, fallback = 120) {
  const fb = Number.isFinite(fallback) && fallback > 0 ? fallback : 120;
  if (!audio || audio.length === 0) return fb;
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;

  // 1) 定长分析窗：约 23ms（512 @22.05k / 1024 @44.1k / 2048 @96k）
  const win = Math.max(256, 1 << Math.round(Math.log2(sr * 0.023)));
  // hop 取窗长的 1/4（≈5.8ms）。1/2 时一个 ≈9ms 的鼓点只覆盖一两帧，取整误差
  // 会让 1 拍间隔的相关值比 2 拍还低（2 拍恰好落在整数帧上）；1/4 后 lag 精度
  // 从 3.4% 提到 1.7%，倍频裁决才有可比性。
  const hop = win >> 2;
  const nFrames = Math.floor((audio.length - win) / hop) + 1;
  if (nFrames < 24) return fb;

  const env = new Float32Array(nFrames);
  let maxRms = 0;
  for (let i = 0; i < nFrames; i++) {
    let s = 0;
    const start = i * hop;
    for (let j = start; j < start + win; j++) {
      const v = audio[j];
      s += v * v;
    }
    const rms = Math.sqrt(s / win);
    env[i] = rms;
    if (rms > maxRms) maxRms = rms;
  }
  if (!(maxRms > 1e-7)) return fb;

  // 对数压缩：−60dB 处设软膝，避免把底噪也抬成"弱拍"
  const knee = maxRms * 1e-3;
  for (let i = 0; i < nFrames; i++) env[i] = Math.log(knee + env[i]);

  // 2) onset = 半波整流差分，再减去均值（抑制长音内的缓慢爬升）
  const onset = new Float32Array(nFrames);
  let sum = 0;
  for (let i = 1; i < nFrames; i++) {
    const d = env[i] - env[i - 1];
    if (d > 0) {
      onset[i] = d;
      sum += d;
    }
  }
  const mean = sum / Math.max(1, nFrames - 1);
  for (let i = 1; i < nFrames; i++) {
    onset[i] = Math.max(0, onset[i] - mean);
  }

  const frameRate = sr / hop;
  // 下界放宽到 1.15×BPM_MAX：快歌的 1 拍 lag 正好落在 180 的边界上，相关峰是
  // 一个跨边界的鼓包，贴着边界截断就取不到峰顶（180 BPM 会被判成 90）。
  const minLag = Math.max(2, Math.floor((frameRate * 60) / (BPM_MAX * 1.15)));
  const maxLag = Math.min(onset.length - 1, Math.ceil((frameRate * 60) / BPM_MIN));
  if (maxLag <= minLag) return fb;

  // 3) 归一化自相关
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let ea = 0;
    let eb = 0;
    const n = onset.length - lag;
    for (let i = 0; i < n; i++) {
      const a = onset[i];
      const b = onset[i + lag];
      num += a * b;
      ea += a * a;
      eb += b * b;
    }
    ac[lag] = ea > 0 && eb > 0 ? num / Math.sqrt(ea * eb) : 0;
  }

  // 4) 粗筛：整数 lag 的归一化自相关 × 对数正态先验，收集局部极大
  const prior = (lag) => {
    const bpm = (frameRate * 60) / lag;
    const oct = Math.log2(bpm / BPM_PRIOR_CENTER) / BPM_PRIOR_SIGMA_OCT;
    return Math.exp(-0.5 * oct * oct);
  };
  const peaks = [];
  // 从 minLag 而不是 minLag+1 开始：快歌（≈180 BPM）的 1 拍 lag 正好贴在搜索下界，
  // 跳过下界会把整个"每拍"候选丢掉，只能退而选 2 拍（结果就是一半 BPM）。
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = ac[lag];
    if (v <= 0 || v < ac[lag - 1] || v < ac[lag + 1]) continue; // 只取局部极大
    const bpm = (frameRate * 60) / lag;
    // 边界留 1% 余量：55 与 180 的峰正好压在搜索边界上，取整后会是 54.98 / 180.1。
    if (bpm > BPM_MAX * 1.01 || bpm < BPM_MIN * 0.99) continue;
    peaks.push({ lag, ac: v, score: v * prior(lag) });
  }
  if (peaks.length === 0) return fb;
  peaks.sort((a, b) => b.score - a.score);

  // 5) 细搜：整数 lag 的量化误差在高 BPM 下可达 3%（150 BPM 的 1 拍是 34.45 帧，
  //    取整到 34 就错位 5ms，归一化相关从 0.99 掉到 0.54，于是两拍间隔反而"更像"
  //    节拍）。对前几个候选在 ±1 帧内用线性插值重采 onset，0.1 帧精度求峰值。
  const acAt = (lagF) => {
    const n = Math.floor(onset.length - lagF) - 1;
    if (n <= 0) return 0;
    let num = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lagF;
      const j0 = j | 0;
      const f = j - j0;
      const b = onset[j0] * (1 - f) + onset[j0 + 1] * f;
      const a = onset[i];
      num += a * b;
      ea += a * a;
      eb += b * b;
    }
    return ea > 0 && eb > 0 ? num / Math.sqrt(ea * eb) : 0;
  };

  const refined = [];
  for (const p of peaks.slice(0, 6)) {
    let best = { lag: p.lag, ac: p.ac };
    for (let d = -1; d <= 1.0001; d += 0.1) {
      const lagF = p.lag + d;
      if (lagF < minLag || lagF > maxLag) continue;
      const v = acAt(lagF);
      if (v > best.ac) best = { lag: lagF, ac: v };
    }
    refined.push(best);
  }
  if (refined.length === 0) return fb;

  // 6) 倍频裁决。1 拍与 2 拍间隔在"每拍一个 onset"的信号上几乎同样相关——这是
  //    数学上的同一性，纯节拍信号无法区分，只能看相关值的细微差别：
  //      · 比值 > 0.95：两拍一循环与一拍一循环完全等价，交给先验（保持当前值）；
  //      · 比值 0.7–0.95：一拍位置**确实有** onset，只是被帧量化削掉一截，
  //        真实周期更短，取快的一层（这是 160–180 BPM 常被写成一半的原因）；
  //      · 比值 < 0.7：一拍位置基本没有 onset，当前值就是基本周期。
  //    之前按"相关值 ≥ 0.8×最大值里取最短周期"判断，在 168 BPM 上会失败：
  //    一拍的相关值只有 0.72、两拍是 0.98，差得太多，直接被判成 84。
  const top = refined.reduce((a, b) => (b.ac > a.ac ? b : a), refined[0]);
  let chosen = top;
  const halfLag = top.lag / 2;
  if (halfLag >= minLag) {
    let bestHalf = null;
    for (const r of refined) {
      if (Math.abs(r.lag - halfLag) > 1.5) continue;
      if (!bestHalf || r.ac > bestHalf.ac) bestHalf = r;
    }
    if (bestHalf) {
      const ratio = bestHalf.ac / top.ac;
      const fastBpm = (frameRate * 60) / bestHalf.lag;
      // 细搜后可能比上限高出零点几（180.1），按 1% 容差放行。
      if (ratio >= 0.7 && ratio < 0.95 && fastBpm <= BPM_MAX * 1.01) chosen = bestHalf;
    }
  }

  // 边界留余量：搜索下限 55 时 lag 取整可能落到 54.9，不能用 55 直接判"太慢"，
  // 否则 55 BPM 会被翻成 110。
  let outBpm = (frameRate * 60) / chosen.lag;
  while (outBpm < BPM_MIN * 0.92 && outBpm * 2 <= BPM_MAX) outBpm *= 2;
  while (outBpm > BPM_MAX * 1.08 && outBpm / 2 >= BPM_MIN) outBpm /= 2;
  if (!(outBpm > 0) || !Number.isFinite(outBpm)) return fb;
  return Math.round(outBpm * 10) / 10;
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