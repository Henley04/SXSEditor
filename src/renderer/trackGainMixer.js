/**
 * 播放期"一轨一增益节点"的统一管理（计划 4.1，替换 accompanimentMixer）。
 *
 * 为什么单独一个模块：
 *   · 音量滑块在 timelineRenderer，GainNode 在 audioPlayback 创建，M/S 按钮也在
 *     timelineRenderer —— 让 timelineRenderer 反向 import audioPlayback 会形成 ESM
 *     循环依赖；这里只依赖纯函数 shared/trackAudibility.js，是个"信箱"。
 *   · 伴奏音量、人声 Mute/Solo 都收敛到 applyAudibility() 一个出口：声音先变、
 *     UI 后重绘。所有入口（点击 / 撤销 / 重做 / 工程加载 / 插件改轨）经 refreshAll
 *     自动覆盖。
 *
 * 设计要点：
 *   · 每条轨一个 GainNode（不能改 master gain —— 那会连伴奏和所有轨一起变）；
 *   · M/S 只改 GainNode target（12ms 斜坡防爆音），不停 source、不重推、不移动播放头；
 *   · 伴奏轨 target = 可听 ? accompanimentVolume : 0；人声轨 target = 可听 ? baseGain : 0；
 *   · 缓存键相同不重复写增益（播放循环每帧/每次 refreshAll 都可能调用）；
 *   · applyAudibility 返回 changed 并通知订阅者（独占模式据此重建 PCM）。
 */

import { computeAudibility } from '../shared/trackAudibility.js';

const RAMP_SECONDS = 0.012;

/** @type {Map<string, {gainNode: GainNode, baseGain: number}>} trackId → 增益节点 + 基础音量 */
const _gains = new Map();

/** 上一次 applyAudibility 算出的逐轨可听性（供 setTrackBaseGain 判断要不要立即生效）。 */
let _lastAudibleById = new Map();
/** 上一次写入的缓存键。 */
let _lastCacheKey = null;

/** 订阅者（独占模式重建 PCM 用）。 */
const _subscribers = new Set();

function _clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(2, n));
}

function _now(gainNode) {
  try {
    return gainNode.context ? gainNode.context.currentTime : 0;
  } catch (_) {
    return 0;
  }
}

/** 把目标增益写到节点：先取消在途斜坡，再 12ms 过渡到目标（防爆音）。 */
function _ramp(entry, target) {
  const gain = entry.gainNode && entry.gainNode.gain;
  if (!gain) return;
  const now = _now(entry.gainNode);
  try {
    if (typeof gain.cancelScheduledValues === 'function') gain.cancelScheduledValues(now);
    if (typeof gain.setTargetAtTime === 'function') {
      gain.setTargetAtTime(target, now, RAMP_SECONDS);
    } else if ('value' in gain) {
      gain.value = target;
    }
  } catch (_) {
    try { gain.value = target; } catch (_e) { /* 节点已失效，忽略 */ }
  }
}

/**
 * 注册一条轨的增益节点（播放调度时调用）。
 *
 * @param {string} trackId
 * @param {GainNode} gainNode
 * @param {number} [baseGain=1] 基础音量（伴奏轨传 accompanimentVolume）
 * @param {boolean} [initialAudible=true] 注册即设置初始值（静音轨首个 chunk 不漏音）
 */
export function registerTrackGain(trackId, gainNode, baseGain = 1, initialAudible = true) {
  if (!trackId || !gainNode) return;
  const v = _clamp01(baseGain);
  const entry = { gainNode, baseGain: v == null ? 1 : v };
  _gains.set(trackId, entry);
  // 新节点加入 → 缓存键失效，下一次 applyAudibility 必须重算（否则静音轨沿用默认 1 漏音）。
  _lastCacheKey = null;
  // 注册即写死初值（不用斜坡）：首个 chunk/source.start 之前就位，杜绝漏音窗口。
  try {
    if (gainNode.gain && 'value' in gainNode.gain) {
      gainNode.gain.value = initialAudible ? entry.baseGain : 0;
    }
  } catch (_) { /* 忽略 */ }
}

/**
 * 获取已注册的增益节点；不存在时可选地用 factory 创建并注册（流式 chunk 路由用）。
 *
 * @param {string} trackId
 * @param {() => GainNode} [factory] 创建函数（通常是 () => ctx.createGain()）
 * @param {number} [baseGain=1]
 * @param {boolean} [initialAudible=true]
 * @returns {GainNode|null}
 */
export function getOrCreateTrackGain(trackId, factory, baseGain = 1, initialAudible = true) {
  const existing = _gains.get(trackId);
  if (existing) return existing.gainNode;
  if (typeof factory !== 'function') return null;
  let node = null;
  try { node = factory(); } catch (_) { return null; }
  if (!node) return null;
  registerTrackGain(trackId, node, baseGain, initialAudible);
  return node;
}

/** 清空增益表（停止播放 / 重新调度前调用）。不负责 stop() source。 */
export function clearTrackGains() {
  _gains.clear();
  _lastAudibleById = new Map();
  _lastCacheKey = null;
}

/**
 * 实时改某条轨的基础音量（伴奏音量滑块）。静音状态下只更新 base，不解除静音。
 *
 * @returns {boolean} 是否命中了一条正在播放的轨
 */
export function setTrackBaseGain(trackId, value) {
  const entry = _gains.get(trackId);
  const v = _clamp01(value);
  if (!entry || v == null) return false;
  entry.baseGain = v;
  _lastCacheKey = null;
  // 当前可听才立即生效；静音轨只改 base，保持 0。
  if (_lastAudibleById.get(trackId) !== false) {
    _ramp(entry, v);
  }
  return true;
}

/**
 * 按当前轨道 Mute/Solo 状态重算所有增益。
 *
 * 缓存键由 anySolo + 每轨 mute/solo + 每轨 baseGain 组成，键不变直接返回，
 * 避免 refreshAll / 播放循环每帧重复写增益。
 *
 * @param {Array} tracks trackManager.getSingers() 的结果
 * @returns {{changed: boolean, anySolo: boolean}}
 */
export function applyAudibility(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const aud = computeAudibility(list);

  const keyParts = [aud.anySolo ? 'S' : '-'];
  for (const t of list) {
    if (!t || t.id === undefined) continue;
    keyParts.push(`${t.id}:${t.mute ? 1 : 0}:${t.solo ? 1 : 0}:${t.type || 'singer'}`);
  }
  for (const [id, entry] of _gains) {
    keyParts.push(`g:${id}:${entry.baseGain}`);
  }
  const key = keyParts.join('|');
  if (key === _lastCacheKey) {
    return { changed: false, anySolo: aud.anySolo };
  }
  _lastCacheKey = key;

  // 先记下逐轨可听性（供 setTrackBaseGain 使用），再写增益。
  const nextAudible = new Map();
  for (const t of list) {
    if (t && t.id !== undefined) nextAudible.set(t.id, aud.audible(t));
  }
  _lastAudibleById = nextAudible;

  // 走到这里说明缓存键变了 = 可听性真的发生了变化。不能用 _gains 是否非空
  // 来判断 changed：独占输出模式下根本没有 WebAudio 增益节点（_gains 为空），
  // 但订阅者（独占 PCM 重建）仍必须被通知，否则 M/S 在独占模式不生效（4.6）。
  const changed = true;
  for (const [id, entry] of _gains) {
    // 轨道已从工程删除：按不可听处理（不再出声）。
    const audible = nextAudible.has(id) ? nextAudible.get(id) : false;
    _ramp(entry, audible ? entry.baseGain : 0);
  }

  for (const fn of _subscribers) {
    try { fn({ anySolo: aud.anySolo, audibleById: new Map(nextAudible) }); } catch (_err) { /* 订阅者异常不影响增益 */ }
  }
  return { changed, anySolo: aud.anySolo };
}

/** 订阅可听性变化（独占模式重建 PCM）。返回退订函数。 */
export function subscribeAudibilityChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

/** 当前是否有轨正在播放（供 UI 判断）。 */
export function hasLiveTracks() {
  return _gains.size > 0;
}

/** 诊断/测试用：当前逐轨可听性快照。 */
export function getAudibleSnapshot() {
  return new Map(_lastAudibleById);
}
