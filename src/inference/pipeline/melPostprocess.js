/**
 * Mel 频谱后处理（vocoder 之前执行）。
 *
 * 两项处理，各自由分片编辑器的"频谱"参数曲线驱动：
 *
 * 1. 时频平滑 —— 可分离二维高斯：时间轴 σ_t 抑制帧间毛刺（气声抖动、扩散噪声），
 *    频率轴 σ_f 抑制高频谐波边缘的锯齿。σ 逐帧可调（曲线），实现上按"最大 σ 预模糊 +
 *    逐帧按比例混合"，因为高斯核不能逐帧重算（O(N·K) 会爆），而线性混合两个已模糊版本
 *    在感知上等价于介于两者之间的平滑度，且严格保持单调。
 *
 * 2. 频谱插值 —— 在音符 / 音素过渡帧，把两侧的平均频谱包络做线性插值后按升余弦窗
 *    混回过渡帧，使频谱形状跨边界连续，消除"瞬态换音"造成的咔哒感与音色断层。
 *
 * 全部为纯函数（不 mutate 入参），便于单测；未启用时返回原数组（快路径零开销）。
 */

/** 过渡插值的默认半窗（mel 帧，hop 480 @24k ≈ 20ms，3 帧 ≈ 60ms） */
const TRANSITION_HALF_WIDTH = 3;

// 逐帧参数的安全上限。σ 上限同时约束高斯核半径（radius = ceil(3σ)），
// 防止越界/恶意载荷触发巨额核分配与超长循环； blend 上限 100%。
const MAX_SIGMA = 8;
const MAX_BLEND_PCT = 100;

/**
 * 校验并规范化渲染进程传来的逐帧参数。
 * @param {object|null} raw { frames, sigmaT, sigmaF, blend, boundaries, startBeat?, bpm? }
 * @returns {object|null} 规范化结果；无效或全零时返回 null（走快路径）
 *
 * startBeat / bpm：载荷的时间锚点。mel 帧号 0 对应分片的第一个音符（startBeat），
 * 管线据此把"本次 vocoder 输入的 mel 起始拍"换算成 frameOffset（见
 * computeMelFrameOffset），使曲线在多段 / 多 region / 单音符 padding 等
 * re-base 路径下仍按真实时间对齐。旧载荷（无 startBeat）按 0 处理，行为不变。
 */
function normalizeMelPostprocessOptions(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const frames = Math.max(0, Math.floor(Number(raw.frames) || 0));
  const sigmaT = _toFloatArray(raw.sigmaT, MAX_SIGMA);
  const sigmaF = _toFloatArray(raw.sigmaF, MAX_SIGMA);
  const blend = _toFloatArray(raw.blend, MAX_BLEND_PCT);
  if (!sigmaT && !sigmaF && !blend) return null;
  let maxT = 0;
  let maxF = 0;
  let maxBlend = 0;
  if (sigmaT) for (let i = 0; i < sigmaT.length; i++) if (sigmaT[i] > maxT) maxT = sigmaT[i];
  if (sigmaF) for (let i = 0; i < sigmaF.length; i++) if (sigmaF[i] > maxF) maxF = sigmaF[i];
  if (blend) for (let i = 0; i < blend.length; i++) if (blend[i] > maxBlend) maxBlend = blend[i];
  if (maxT <= 0 && maxF <= 0 && maxBlend <= 0) return null;
  let boundaries = [];
  if (raw.boundaries) {
    boundaries = Array.from(raw.boundaries, (v) => Math.floor(Number(v) || 0))
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
  }
  const startBeat = Number(raw.startBeat);
  const bpm = Number(raw.bpm);
  return {
    frames,
    sigmaT,
    sigmaF,
    blend,
    boundaries,
    maxSigmaT: maxT,
    maxSigmaF: maxF,
    maxBlend,
    // 时间锚点：缺失（旧载荷）时为 null → computeMelFrameOffset 返回 0
    startBeat: Number.isFinite(startBeat) ? startBeat : null,
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
  };
}

function _toFloatArray(v, max) {
  if (!v) return null;
  const cap = Number.isFinite(max) ? max : Infinity;
  const conv = (x) => {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(cap, n));
  };
  if (v instanceof Float32Array) {
    let needsCopy = false;
    for (let i = 0; i < v.length; i++) {
      const n = v[i];
      if (!Number.isFinite(n) || n < 0 || n > cap) { needsCopy = true; break; }
    }
    if (!needsCopy) return v;
  }
  if (Array.isArray(v) || v instanceof Float32Array || v instanceof Float64Array) {
    const arr = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) arr[i] = conv(v[i]);
    return arr;
  }
  return null;
}

/**
 * 把"本次 vocoder 输入 mel 的首音符绝对拍"换算为载荷帧索引偏移。
 *
 * 载荷的第 i 帧对应绝对拍 startBeat + i·(bpm/60)/fps。本次 mel 的第 0 帧对应
 * absFirstNoteBeat，因此先把拍差换算成秒（1 拍 = 60/bpm 秒），再换算成帧：
 *
 *   frameOffset = (absFirstNoteBeat - startBeat) × (60 / bpm) × fps
 *
 * 注意方向：拍 → 秒是 ×(60/bpm)，秒 → 拍才是 ×(bpm/60)。两者写反会让偏移按
 * (bpm/60)² 缩放（bpm=120 时放大 4 倍，bpm=60 时恰好相等而被掩盖）。
 * 结果可能为负（如单音符 contextPadding 在音符前垫了 1 拍休止），applyMelPostprocess
 * 的 sample() 会向 0 夹紧，边界换算同样成立。
 *
 * @param {object|null} opts normalizeMelPostprocessOptions 的结果
 * @param {number} absFirstNoteBeat 本次 mel 第 0 帧对应的绝对拍（分片坐标系）
 * @param {number} fps mel 帧率（SAMPLE_RATE / HOP_SIZE）
 * @returns {number}
 */
function computeMelFrameOffset(opts, absFirstNoteBeat, fps) {
  if (!opts || !Number.isFinite(opts.startBeat) || !(opts.bpm > 0) || !(fps > 0)) return 0;
  if (!Number.isFinite(absFirstNoteBeat)) return 0;
  return Math.round((absFirstNoteBeat - opts.startBeat) * (60 / opts.bpm) * fps);
}

// 高斯核缓存：σ 来自曲线采样，同一个分片内每帧都不同，但半径只由 ceil(3σ) 决定，
// 逐帧重建核（含 exp() 与归一化）是纯浪费。按 σ 量化到 0.01 缓存复用 —— 该精度
// 远低于听感可辨差异，不会改变输出。
const _kernelCache = new Map();
const _KERNEL_CACHE_MAX = 64;

/** 一维归一化高斯核（半径 = ceil(3σ)，σ≤0 返回 null）。 */
function gaussianKernel1D(sigma) {
  const s = Number(sigma);
  if (!(s > 0)) return null;
  const key = Math.round(s * 100);
  const hit = _kernelCache.get(key);
  if (hit) return hit;
  const radius = Math.max(1, Math.ceil(s * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * s * s));
    kernel[k + radius] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  // 简单 FIFO：满了就整体清空。缓存项很小（≤49 个 float），重建成本低于
  // 维护 LRU 的复杂度。
  if (_kernelCache.size >= _KERNEL_CACHE_MAX) _kernelCache.clear();
  _kernelCache.set(key, kernel);
  return kernel;
}

function _reflectIndex(i, len) {
  if (len <= 1) return 0;
  let idx = i;
  while (idx < 0 || idx >= len) {
    if (idx < 0) idx = -idx - 1;
    else idx = len * 2 - idx - 1;
  }
  return idx;
}

// 镜像索引表缓存：模糊内层每帧每 bin 都要算 (2r+1) 次 _reflectIndex，
// 40000 帧 × 128 bin × 49 taps ≈ 2.5 亿次调用。表化后变成一次查表。
// 表本身 len × taps 个 int32，用条目数上限兜住内存（默认 ≤2M 条目 ≈ 8MB）。
const _reflectTables = new Map();
const _REFLECT_TABLE_MAX = 4;
const _REFLECT_TABLE_MAX_ENTRIES = 2 * 1024 * 1024;

/**
 * 取 [len][tap] 的镜像索引表；过大时返回 null（调用方退回逐次 _reflectIndex）。
 * @returns {Int32Array|null}
 */
function _reflectTable(len, radius) {
  const taps = radius * 2 + 1;
  if (len <= 0 || len * taps > _REFLECT_TABLE_MAX_ENTRIES) return null;
  const key = `${len}:${radius}`;
  const hit = _reflectTables.get(key);
  if (hit) return hit;
  const table = new Int32Array(len * taps);
  for (let i = 0; i < len; i++) {
    const base = i * taps;
    for (let k = -radius; k <= radius; k++) {
      table[base + (k + radius)] = _reflectIndex(i + k, len);
    }
  }
  if (_reflectTables.size >= _REFLECT_TABLE_MAX) _reflectTables.clear();
  _reflectTables.set(key, table);
  return table;
}

/**
 * 沿时间轴高斯平滑（边界镜像延拓），返回新数组。
 * @param {Float32Array} mel [frame, bin] 展平
 * @param {number} frames
 * @param {number} dim
 * @param {number} sigma
 */
function blurAlongTime(mel, frames, dim, sigma) {
  const kernel = gaussianKernel1D(sigma);
  if (!kernel || frames <= 1) return new Float32Array(mel);
  const radius = (kernel.length - 1) / 2;
  const taps = radius * 2 + 1;
  const table = _reflectTable(frames, radius);
  const out = new Float32Array(mel.length);
  for (let f = 0; f < frames; f++) {
    const base = f * dim;
    const tBase = table ? f * taps : 0;
    for (let b = 0; b < dim; b++) {
      let acc = 0;
      if (table) {
        for (let k = 0; k < taps; k++) {
          acc += kernel[k] * mel[table[tBase + k] * dim + b];
        }
      } else {
        for (let k = -radius; k <= radius; k++) {
          const sf = _reflectIndex(f + k, frames);
          acc += kernel[k + radius] * mel[sf * dim + b];
        }
      }
      out[base + b] = acc;
    }
  }
  return out;
}

/** 沿频率轴高斯平滑（边界镜像延拓），返回新数组。 */
function blurAlongFreq(mel, frames, dim, sigma) {
  const kernel = gaussianKernel1D(sigma);
  if (!kernel || dim <= 1) return new Float32Array(mel);
  const radius = (kernel.length - 1) / 2;
  const taps = radius * 2 + 1;
  // dim 固定 128，表一定建得出来，且帧间完全复用
  const table = _reflectTable(dim, radius);
  const out = new Float32Array(mel.length);
  for (let f = 0; f < frames; f++) {
    const base = f * dim;
    for (let b = 0; b < dim; b++) {
      let acc = 0;
      if (table) {
        const tBase = b * taps;
        for (let k = 0; k < taps; k++) {
          acc += kernel[k] * mel[base + table[tBase + k]];
        }
      } else {
        for (let k = -radius; k <= radius; k++) {
          const sb = _reflectIndex(b + k, dim);
          acc += kernel[k + radius] * mel[base + sb];
        }
      }
      out[base + b] = acc;
    }
  }
  return out;
}

function _meanSpectrum(mel, dim, from, to, out) {
  const n = to - from;
  if (n <= 0) return false;
  out.fill(0);
  for (let f = from; f < to; f++) {
    const base = f * dim;
    for (let b = 0; b < dim; b++) out[b] += mel[base + b];
  }
  for (let b = 0; b < dim; b++) out[b] /= n;
  return true;
}

/**
 * 过渡帧频谱插值。
 * @param {Float32Array} mel
 * @param {number} frames
 * @param {number} dim
 * @param {number[]} boundaries 局部帧索引（已减去 frameOffset，升序）
 * @param {(frame:number)=>number} weightAt 返回该帧的插值强度 0..1
 * @param {number} [halfWidth]
 * @returns {Float32Array}
 */
function interpolateTransitionSpectra(mel, frames, dim, boundaries, weightAt, halfWidth = TRANSITION_HALF_WIDTH) {
  const out = new Float32Array(mel);
  if (!boundaries || boundaries.length === 0) return out;
  const w = Math.max(1, Math.floor(halfWidth));
  const a = new Float32Array(dim);
  const bSpec = new Float32Array(dim);
  const target = new Float32Array(dim);

  for (const bnd of boundaries) {
    if (bnd <= 0 || bnd >= frames) continue;
    const strength = Math.max(0, Math.min(1, Number(weightAt(bnd)) || 0));
    if (strength <= 0) continue;
    const aFrom = Math.max(0, bnd - w);
    const aTo = bnd;
    const bFrom = bnd;
    const bTo = Math.min(frames, bnd + w);
    if (!_meanSpectrum(mel, dim, aFrom, aTo, a)) continue;
    if (!_meanSpectrum(mel, dim, bFrom, bTo, bSpec)) continue;

    for (let f = aFrom; f < bTo; f++) {
      // 升余弦窗：边界处约 0.87（w=3），边缘衰减到 0，避免插值区与外侧产生新的断层
      const d = Math.min(1, Math.abs(f + 0.5 - bnd) / w);
      const win = Math.cos(d * Math.PI * 0.5) ** 2;
      const mix = strength * win;
      if (mix <= 0) continue;
      const ramp = (f + 0.5 - (bnd - w)) / (2 * w);
      const r = Math.max(0, Math.min(1, ramp));
      for (let k = 0; k < dim; k++) target[k] = a[k] + (bSpec[k] - a[k]) * r;
      const base = f * dim;
      for (let k = 0; k < dim; k++) {
        out[base + k] = out[base + k] + (target[k] - out[base + k]) * mix;
      }
    }
  }
  return out;
}

/**
 * 主入口。
 * @param {Float32Array} mel [frame, bin] 展平
 * @param {number} frameCount 本次 vocoder 调用的 mel 帧数
 * @param {number} dim mel 维度
 * @param {object} options normalizeMelPostprocessOptions 的结果
 * @param {number} frameOffset 本次 mel 在整个分片时间轴上的起始帧（默认 0）
 * @returns {Float32Array} 处理后的 mel（未启用时返回原引用）
 */
function applyMelPostprocess(mel, frameCount, dim, options, frameOffset = 0) {
  if (!options || !mel || frameCount <= 0 || dim <= 0) return mel;
  if (mel.length < frameCount * dim) return mel;

  const sample = (arr, absFrame) => {
    if (!arr || arr.length === 0) return 0;
    const idx = Math.max(0, Math.min(arr.length - 1, absFrame));
    return arr[idx];
  };

  let out = mel;

  // 混合阶段把结果**原地写回 blurred**，不再另开一份 mixed。
  // 一份 mel = frameCount × dim × 4B，40000 帧 × 128 bin ≈ 20MB；原本时间/频率
  // 两个方向各要多分配一份，长分片下是明显的 GC 压力。
  // blurAlongTime/Freq 的返回值恒为新数组（即使 kernel 为 null 也返回
  // new Float32Array(mel) 的拷贝），所以写回它不会动到入参 mel。
  if (options.maxSigmaT > 0 && options.sigmaT) {
    const blurred = blurAlongTime(mel, frameCount, dim, options.maxSigmaT);
    for (let f = 0; f < frameCount; f++) {
      const w = Math.max(0, Math.min(1, sample(options.sigmaT, frameOffset + f) / options.maxSigmaT));
      const base = f * dim;
      for (let b = 0; b < dim; b++) {
        blurred[base + b] = mel[base + b] + (blurred[base + b] - mel[base + b]) * w;
      }
    }
    out = blurred;
  }

  if (options.maxSigmaF > 0 && options.sigmaF) {
    const src = out;
    const blurred = blurAlongFreq(src, frameCount, dim, options.maxSigmaF);
    for (let f = 0; f < frameCount; f++) {
      const w = Math.max(0, Math.min(1, sample(options.sigmaF, frameOffset + f) / options.maxSigmaF));
      const base = f * dim;
      for (let b = 0; b < dim; b++) {
        blurred[base + b] = src[base + b] + (blurred[base + b] - src[base + b]) * w;
      }
    }
    out = blurred;
  }

  if (options.maxBlend > 0 && options.boundaries && options.boundaries.length > 0) {
    const local = [];
    for (const bnd of options.boundaries) {
      const lb = bnd - frameOffset;
      if (lb > 0 && lb < frameCount) local.push(lb);
    }
    if (local.length > 0) {
      out = interpolateTransitionSpectra(
        out,
        frameCount,
        dim,
        local,
        (frame) => sample(options.blend, frameOffset + frame) / 100,
      );
    }
  }

  return out;
}

/**
 * 窗口化 mel 后处理：在**完整 mel**上取 [startFrame, startFrame+frameCount)
 * 区间处理，但模糊/插值可以使用区间外的真实邻居帧。
 *
 * 为什么需要：分块流式路径对每个 diffusion chunk 单独 vocoder，旧实现对 chunk
 * 的 mel 单独做高斯模糊 —— 时间轴模糊在 chunk 边界用镜像延拓，而导出是整段
 * 一次模糊（真实邻居），导致预览与导出在每个 chunk 边界（约每 10s）听感有差异。
 *
 * 做法：把处理窗口向两侧各扩 context = ceil(3σ_t) + 过渡半窗 + 1 帧，窗口内的
 * 输出帧的所有模糊 tap 都落在真实数据上 —— 与整段处理逐位一致。镜像延拓只发生在
 * 完整 mel 的真实边界（frame 0 / totalFrames），与整段路径相同。
 *
 * 边界情况：
 *   - 左侧 context 会读入上一个 chunk 已提交的 mel（真实、最终）；右侧 context
 *     只有当调用方确认 chunk 右边的帧已是最终数据时才启用（最后一个 chunk / 非
 *     分块路径）。右侧不可用时窗口右缘截断在区间末端（镜像延拓，与旧行为一致）。
 *   - 未启用任何处理时返回 null（零开销快路径，调用方沿用原 mel）。
 *
 * @param {Float32Array} fullMel 完整 mel（[totalFrames, dim] 展平）
 * @param {number} totalFrames 完整 mel 帧数
 * @param {number} dim
 * @param {object} options normalizeMelPostprocessOptions 的结果
 * @param {number} startFrame 本次输出区间的起始帧（完整 mel 坐标）
 * @param {number} frameCount 本次输出区间的帧数
 * @param {{left?:boolean, right?:boolean}} [ctxFlags] 两侧是否允许读区间外真实帧
 * @param {number} [payloadBase] 完整 mel 第 0 帧对应的载荷帧索引
 *   （= _melPostprocessFrameOffset(完整 mel 首音符绝对拍)；载荷锚在分片首音符、
 *   完整 mel 锚在 region/segment 首音符时两者相差一个正偏移）
 * @returns {Float32Array|null} 处理后的区间（新数组，长度 frameCount*dim）；未启用时 null
 */
function applyMelPostprocessWindow(fullMel, totalFrames, dim, options, startFrame, frameCount, ctxFlags, payloadBase = 0) {
  if (!options || !fullMel || frameCount <= 0 || dim <= 0) return null;
  if (fullMel.length < totalFrames * dim) return null;
  const start = Math.max(0, Math.min(totalFrames - frameCount, Math.round(startFrame) || 0));
  const flags = ctxFlags || {};
  const useLeft = flags.left !== false;
  const useRight = flags.right !== false;
  const context = Math.ceil(3 * Math.max(options.maxSigmaT || 0)) + TRANSITION_HALF_WIDTH + 1;
  const winStart = useLeft ? Math.max(0, start - context) : start;
  const winEnd = useRight ? Math.min(totalFrames, start + frameCount + context) : start + frameCount;
  const winFrames = winEnd - winStart;
  if (winFrames <= 0) return null;

  const win = fullMel.subarray(winStart * dim, winEnd * dim);
  const processed = applyMelPostprocess(win, winFrames, dim, options, (Math.round(payloadBase) || 0) + winStart);
  if (processed === win) return null; // 未启用任何处理（快路径）

  const out = new Float32Array(frameCount * dim);
  out.set(processed.subarray((start - winStart) * dim, (start - winStart + frameCount) * dim));
  return out;
}

module.exports = {
    TRANSITION_HALF_WIDTH,
    MAX_SIGMA,
    MAX_BLEND_PCT,
    normalizeMelPostprocessOptions,
    gaussianKernel1D,
    blurAlongTime,
    blurAlongFreq,
    interpolateTransitionSpectra,
    applyMelPostprocess,
    applyMelPostprocessWindow,
    computeMelFrameOffset,
};
