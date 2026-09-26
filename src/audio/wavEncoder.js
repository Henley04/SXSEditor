/**
 * WAV 编码工具
 * 将 Float32Array 音频数据编码为 32-bit float PCM WAV 文件
 */

// B2: use CommonJS require to match the rest of src/audio (audioWorker.js is
// forked directly and copied via CopyPlugin; mixing ESM/CJS can break under
// packaging config changes). smoothstep.js already exports via CommonJS.
const { smoothstep } = require('../utils/smoothstep.js');

const _TRIG_LUT_SIZE = 1024;
const _cosLut = new Float32Array(_TRIG_LUT_SIZE);
const _sinLut = new Float32Array(_TRIG_LUT_SIZE);
for (let i = 0; i < _TRIG_LUT_SIZE; i++) {
    const a = (i / _TRIG_LUT_SIZE) * 2 * Math.PI;
    _cosLut[i] = Math.cos(a);
    _sinLut[i] = Math.sin(a);
}
const _trigLutScale = _TRIG_LUT_SIZE / (2 * Math.PI);
const _PI4 = 0.7853981633974483;

/**
 * WAV 编码内部实现
 * @param {Float32Array} audioData 音频数据（单声道或交错立体声）
 * @param {number} sampleRate 采样率
 * @param {number} numChannels 声道数（1 或 2）
 * @param {16|24|32} bitDepth 位深度：16/24 为整型 PCM，32 为 IEEE float（默认，向后兼容）
 * @returns {Uint8Array} WAV 文件数据
 */
function _encodeWavBase(audioData, sampleRate, numChannels, bitDepth = 32) {
  // 非法值回退到 32-bit float（历史行为）
  if (![16, 24, 32].includes(bitDepth)) bitDepth = 32;
  const bytesPerSample = bitDepth / 8;
  const bitsPerSample = bitDepth;
  // WAV 格式码：1 = 整型 PCM，3 = IEEE float
  const formatCode = bitDepth === 32 ? 3 : 1;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = audioData.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, formatCode, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  if (bitDepth === 32) {
    // 一次性 memcpy 替代逐样本 setFloat32（性能审查 §4 中优先级）
    new Float32Array(buffer, 44, audioData.length).set(audioData);
  } else {
    // 16/24-bit：逐样本转换并做对称削波（clip 到 [-1, 1]）
    const maxPositive = bitDepth === 16 ? 0x7FFF : 0x7FFFFF;
    // 负向刻度比正向多 1（二进制补码不对称）：-1 映射到最小值
    const maxNegative = bitDepth === 16 ? 0x8000 : 0x800000;
    let offset = 44;
    for (let i = 0; i < audioData.length; i++) {
      let s = audioData[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      const v = Math.round(s < 0 ? s * maxNegative : s * maxPositive);
      if (bitDepth === 16) {
        view.setInt16(offset, v, true);
        offset += 2;
      } else {
        // 24-bit little-endian，逐字节写入（DataView 无 setInt24）
        view.setUint8(offset, v & 0xFF);
        view.setUint8(offset + 1, (v >> 8) & 0xFF);
        view.setUint8(offset + 2, (v >> 16) & 0xFF);
        offset += 3;
      }
    }
  }

  return new Uint8Array(buffer);
}

/**
 * 将 Float32Array 编码为 WAV 文件的 Uint8Array
 * @param {Float32Array} float32Array 单声道音频数据，范围 [-1, 1]
 * @param {number} sampleRate 采样率（如 24000）
 * @param {number} numChannels 声道数（1 或 2）
 * @param {16|24|32} bitDepth 位深度（默认 32 = IEEE float，与历史行为一致）
 * @returns {Uint8Array} WAV 文件数据
 */
function encodeWav(float32Array, sampleRate, numChannels = 1, bitDepth = 32) {
  // B4: stereo WAV requires interleaved L,R sample pairs, so the data length
  // must be a multiple of numChannels (blockAlign). If the length is not a
  // multiple (e.g. odd-length array for stereo), pad with zero samples at the
  // end so the WAV header matches the data length. Padding preserves all
  // original audio data and is backwards-compatible.
  if (numChannels === 2 && float32Array.length % 2 !== 0) {
    const padded = new Float32Array(float32Array.length + 1);
    padded.set(float32Array);
    return _encodeWavBase(padded, sampleRate, 2, bitDepth);
  }
  return _encodeWavBase(float32Array, sampleRate, numChannels, bitDepth);
}

function encodeWavStereo(interleavedStereo, sampleRate) {
  return _encodeWavBase(interleavedStereo, sampleRate, 2);
}

function applyEnvelopesToAudio(monoAudio, sampleRate, bpm, volumeEnvelope, panEnvelope, noteFades) {
  const numSamples = monoAudio.length;
  const stereoData = new Float32Array(numSamples * 2);

  const hasVolume = volumeEnvelope && volumeEnvelope.keyframes && volumeEnvelope.keyframes.length > 0;
  const hasPan = panEnvelope && panEnvelope.keyframes && panEnvelope.keyframes.length > 0;

  // Precompute beat time increment to avoid per-sample division
  const beatTimeInc = bpm / (60 * sampleRate);
  let beatTime = 0;

  // Envelope segment cursors: keyframes are time-sorted and beatTime advances
  // monotonically, so the active segment index only moves forward. This
  // replaces the old per-sample O(log n) binary search (millions of searches
  // on a multi-minute export froze the renderer for seconds).
  const volCursor = hasVolume ? _createEnvCursor(volumeEnvelope) : null;
  const panCursor = hasPan ? _createEnvCursor(panEnvelope) : null;

  // Note fades as a sweep line instead of a full-length gain array
  // (~numSamples*4 bytes, e.g. ~14MB for 5min@48k). Events are sorted by
  // start sample; the active list normally holds 0-1 notes. Overlapping note
  // gains multiply exactly as the old array implementation did.
  const fadeState = _buildFadeState(noteFades, bpm, sampleRate, numSamples);

  for (let i = 0; i < numSamples; i++) {
    let volume = 1;
    if (volCursor) {
      volume = _interpEnvAt(volCursor, beatTime);
    }

    let pan = 0;
    if (panCursor) {
      pan = _interpEnvAt(panCursor, beatTime);
    }

    const fadeGain = fadeState ? _fadeGainAt(fadeState, i) : 1;

    const sample = monoAudio[i] * volume * fadeGain;
    // LUT lookup for equal-power panning gains.
    // angle = (pan+1) * π/4 ∈ [0, π/2] for pan ∈ [-1, 1], within LUT coverage [0, 2π).
    const angle = (pan + 1) * _PI4;
    const lutIdx = ((angle * _trigLutScale) | 0) & (_TRIG_LUT_SIZE - 1);
    const leftGain = _cosLut[lutIdx];
    const rightGain = _sinLut[lutIdx];

    stereoData[i * 2] = sample * leftGain;
    stereoData[i * 2 + 1] = sample * rightGain;
    beatTime += beatTimeInc;
  }

  return stereoData;
}

function _createEnvCursor(envelope) {
  return { kfs: envelope.keyframes, len: envelope.keyframes.length, seg: 0 };
}

// Interpolate envelope value at a monotonically non-decreasing `time`.
// The segment cursor only advances forward (keyframes are time-sorted).
function _interpEnvAt(cursor, time) {
  const kfs = cursor.kfs;
  const len = cursor.len;
  if (len === 0) return 0;
  if (len === 1) return kfs[0].value;
  if (time <= kfs[0].time) return kfs[0].value;
  if (time >= kfs[len - 1].time) return kfs[len - 1].value;

  let seg = cursor.seg;
  if (seg > len - 2) seg = len - 2;
  while (seg < len - 2 && kfs[seg + 1].time <= time) seg++;
  cursor.seg = seg;

  const t = (time - kfs[seg].time) / (kfs[seg + 1].time - kfs[seg].time);
  const smoothness = (kfs[seg].smoothness || 0) / 100;
  const smoothT = smoothstep(t, smoothness);
  return kfs[seg].value + smoothT * (kfs[seg + 1].value - kfs[seg].value);
}

function _buildFadeState(noteFades, bpm, sampleRate, numSamples) {
  if (!noteFades || noteFades.length === 0) return null;
  const secondsPerBeat = 60 / bpm;
  const events = [];
  for (let f = 0; f < noteFades.length; f++) {
    const nf = noteFades[f];
    if (!nf) continue;
    const fadeInSec = nf.fadeInSec > 0 ? nf.fadeInSec : 0;
    const fadeOutSec = nf.fadeOutSec > 0 ? nf.fadeOutSec : 0;
    if (fadeInSec <= 0 && fadeOutSec <= 0) continue;
    const noteStartSec = nf.startBeat * secondsPerBeat;
    const noteDurSec = nf.durationBeats * secondsPerBeat;
    const noteEndSec = noteStartSec + noteDurSec;
    events.push({
      startSample: Math.max(0, Math.floor(noteStartSec * sampleRate)),
      endSample: Math.min(numSamples, Math.ceil(noteEndSec * sampleRate)),
      fadeInSamples: fadeInSec > 0 ? Math.max(1, Math.floor(fadeInSec * sampleRate)) : 0,
      fadeOutSamples: fadeOutSec > 0 ? Math.max(1, Math.floor(fadeOutSec * sampleRate)) : 0,
    });
  }
  if (events.length === 0) return null;
  events.sort((a, b) => a.startSample - b.startSample);
  return { events, active: [], nextEvent: 0 };
}

// Gain product of all fades active at sample i. Events activate/expire via
// monotonic sweep, so over the whole export this is O(n + fades).
function _fadeGainAt(state, i) {
  while (state.nextEvent < state.events.length &&
    state.events[state.nextEvent].startSample <= i) {
    state.active.push(state.events[state.nextEvent]);
    state.nextEvent++;
  }
  let g = 1;
  for (let k = state.active.length - 1; k >= 0; k--) {
    const e = state.active[k];
    if (i >= e.endSample) {
      state.active.splice(k, 1);
      continue;
    }
    let ng = 1;
    if (e.fadeInSamples > 0 && i < e.startSample + e.fadeInSamples) {
      ng = (i - e.startSample) / e.fadeInSamples;
    }
    if (e.fadeOutSamples > 0 && i > e.endSample - e.fadeOutSamples) {
      const fo = Math.max(0, (e.endSample - i) / e.fadeOutSamples);
      if (fo < ng) ng = fo;
    }
    if (ng < 0) ng = 0;
    if (ng > 1) ng = 1;
    g *= ng;
  }
  return g;
}

function _interpEnv(envelope, time) {
  const kfs = envelope.keyframes;
  const len = kfs.length;
  if (len === 0) return 0;
  if (len === 1) return kfs[0].value;
  if (time <= kfs[0].time) return kfs[0].value;
  if (time >= kfs[len - 1].time) return kfs[len - 1].value;

  // Binary search for the segment containing `time`
  let lo = 0, hi = len - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (kfs[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const t = (time - kfs[lo].time) / (kfs[lo + 1].time - kfs[lo].time);
  const smoothness = (kfs[lo].smoothness || 0) / 100;
  const smoothT = smoothstep(t, smoothness);
  return kfs[lo].value + smoothT * (kfs[lo + 1].value - kfs[lo].value);
}

// B2: use CommonJS module.exports to match the rest of src/audio modules.
module.exports = { encodeWav, applyEnvelopesToAudio };
