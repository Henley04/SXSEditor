'use strict';
/**
 * 自动保存失败通知的「是否该弹窗」判定。
 *
 * 为什么要单独一个模块：自动保存每 400ms 触发一次，而有些失败是**永久性**的
 * （典型：目标格式没有插件能写、路径未授权）。用户继续编辑只会以同一个原因
 * 反复失败，60s 时间节流仍会每分钟弹一次；文案里的「请尽快手动保存」对这类
 * 错误也毫无帮助 —— 手动保存走同一条分派，一样会失败。
 *
 * 这里把判定收敛成纯逻辑（只有时间与最近一次 key，不碰 DOM / electronAPI），
 * 由 projectManager 在 catch 里调用。规则：
 *   · 同一个 key（path|code）只通知一次；
 *   · 不同 key 之间仍保留 60s 节流，避免错误原因反复横跳时刷屏；
 *   · 保存成功、手动保存成功、另存为换格式、换工程时由调用方 reset()。
 *
 * 手动 Ctrl+S 的失败不走这里，照常由上层提示 —— 去重只针对后台自动保存。
 */

const THROTTLE_MS = 60000;
let _notifiedKey = null;
let _lastAlertAt = -Infinity;

/**
 * @param {string} key 失败原因标识，形如 `${path}|${code}`
 * @param {number} [now] 可注入的时间，便于单测
 * @returns {boolean} 是否应该弹窗
 */
export function shouldNotifyAutoSaveFailure(key, now = Date.now()) {
  if (key === _notifiedKey) return false;
  if (now - _lastAlertAt <= THROTTLE_MS) return false;
  _lastAlertAt = now;
  _notifiedKey = key;
  return true;
}

/** 复位：保存成功 / 换格式 / 换工程后，新的失败应能重新提示。 */
export function resetAutoSaveNotification() {
  _notifiedKey = null;
  _lastAlertAt = -Infinity;
}
