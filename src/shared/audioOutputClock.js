/**
 * 音频输出时钟 —— 把 AudioContext 的"渲染时间"换算成"耳朵听到的时间"。
 *
 * Web Audio 的 ctx.currentTime 是渲染线程的位置：位于 currentTime 的声音还要
 * 经过设备缓冲（WASAPI 周期 + Chromium 内部队列）才到达喇叭，Windows 上实测
 * 比 currentTime 晚 20–120 ms；采样率与设备不一致时更长（本项目的 24 kHz 上下文
 * 跑在 48 kHz 设备上，还要过一次重采样）。
 *
 * 播放头/时间码若直接用 currentTime，指示器就会稳定地跑在声音**前面** ——
 * 这正是"播放进度条和实际播放位置轻微错位"的成因。
 * AudioContext.outputLatency 就是为这种音画同步场景准备的：它估计了"现在渲染
 * 的帧何时能被听到"。
 *
 * 使用边界（重要）：
 *   · 只用于**显示与人耳位置**：播放头、时间码、暂停/续播位置、hit test。
 *   · 调度域（source.start(when)、chunk 对齐、underrun 前沿、播放结束判定）
 *     必须继续用 ctx.currentTime，否则补偿量会被重复计入，音频真的与时间轴错开。
 */

/** 延迟估计上限：超过这个值视为异常读数（设备卡死/时钟回退），按 0 处理。 */
export const MAX_OUTPUT_LATENCY_SEC = 0.5;

/**
 * EMA 系数。设备延迟会随缓冲区状态小幅抖动，逐帧直接取新值会让播放头肉眼
 * 可见地跳动（2px 线在缩放后 1 ms ≈ 0.1 px 量级，抖动 20 ms 就是台阶）。
 * 0.2 ≈ 5 帧（~80 ms）收敛到新值，既跟得上设备切换，也不抖。
 */
const LATENCY_SMOOTHING = 0.2;

/** ctx -> 已平滑的延迟（秒）。WeakMap 让 AudioContext 关闭后自动释放。 */
const _latencyCache = new WeakMap();

function _clampLatency(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > MAX_OUTPUT_LATENCY_SEC ? MAX_OUTPUT_LATENCY_SEC : value;
}

/**
 * 未经平滑的输出延迟估计（秒）。
 * 优先 outputLatency（含设备缓冲），退化到 baseLatency（仅渲染图内部，
 * 会低估但比 0 更接近真相），都没有则返回 0（不做补偿）。
 */
export function estimateOutputLatencySec(ctx) {
  if (!ctx) return 0;
  if (Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0) {
    return _clampLatency(ctx.outputLatency);
  }
  if (Number.isFinite(ctx.baseLatency) && ctx.baseLatency > 0) {
    return _clampLatency(ctx.baseLatency);
  }
  return 0;
}

/** 平滑后的输出延迟估计（秒），同一 ctx 上跨帧共享。 */
export function getOutputLatencySec(ctx) {
  if (!ctx) return 0;
  const raw = estimateOutputLatencySec(ctx);
  const prev = _latencyCache.get(ctx);
  if (prev === undefined) {
    _latencyCache.set(ctx, raw);
    return raw;
  }
  // 设备延迟瞬间跳到 0（例如设备切换的中间态）时不跟随回落，
  // 只按 EMA 慢慢收敛，避免播放头在半秒内来回抽动。
  const next = prev + (raw - prev) * LATENCY_SMOOTHING;
  _latencyCache.set(ctx, next);
  return next;
}

/**
 * 当前"正在播出"的 AudioContext 时间（秒）。
 * 用它替换 ctx.currentTime 即可得到人耳位置；调度代码不要用它。
 */
export function getAudibleContextTime(ctx) {
  if (!ctx) return 0;
  return ctx.currentTime - getOutputLatencySec(ctx);
}

/**
 * 以 playbackStartTime 为基准的可听播放位置（秒），下限截到 0。
 * 起播瞬间 currentTime 还没走完输出延迟，可听位置是负值 —— 显示 0 才对
 * （此刻确实还没声音）。
 */
export function getAudibleElapsedSec(ctx, playbackStartTime) {
  if (!ctx || !Number.isFinite(playbackStartTime)) return 0;
  return Math.max(0, getAudibleContextTime(ctx) - playbackStartTime);
}

/** 仅供测试：清空某个 ctx 的平滑状态。 */
export function _resetOutputLatencyCache(ctx) {
  if (ctx) _latencyCache.delete(ctx);
}
