/**
 * 播放期伴奏增益表。
 *
 * 为什么单独一个模块：音量滑块在 timelineRenderer，GainNode 在 audioPlayback
 * 创建，而 audioPlayback 本来就 import 了 timelineRenderer（播放头绘制）。
 * 让 timelineRenderer 反向 import audioPlayback 会形成 ESM 循环依赖，这里用
 * 一个不依赖任何模块的"信箱"打破环——两边都只依赖它。
 *
 * 生命周期：播放开始注册，stopAudioSource / 播放结束清空。表为空时
 * setAccompanimentVolume 返回 false，调用方无需判断当前是否在播放。
 */

/** @type {Map<string, GainNode>} singerId → 播放中的伴奏增益节点 */
const _gains = new Map();

/**
 * 注册一条伴奏轨的增益节点（播放调度时调用）。
 * @param {string} singerId
 * @param {GainNode} gainNode
 */
export function registerAccompanimentGain(singerId, gainNode) {
    if (!singerId || !gainNode) return;
    _gains.set(singerId, gainNode);
}

/** 清空（停止播放 / 重新调度前调用）。不负责 stop() source。 */
export function clearAccompanimentGains() {
    _gains.clear();
}

/**
 * 实时改变某条伴奏轨的音量。
 *
 * 15ms 的时间常数既能避免阶跃造成的爆音，又足够"跟手"（听感上等同即时）。
 *
 * @param {string} singerId
 * @param {number} value 0–2
 * @returns {boolean} 是否命中了一条正在播放的伴奏轨
 */
export function setAccompanimentVolume(singerId, value) {
    const gain = _gains.get(singerId);
    if (!gain) return false;
    const v = Math.max(0, Math.min(2, Number(value)));
    if (!Number.isFinite(v)) return false;
    try {
        gain.gain.setTargetAtTime(v, gain.context.currentTime, 0.015);
    } catch (_) {
        gain.gain.value = v;
    }
    return true;
}

/** 当前是否有伴奏轨正在播（供 UI 判断是否值得提示"实时生效"）。 */
export function hasLiveAccompaniment() {
    return _gains.size > 0;
}
