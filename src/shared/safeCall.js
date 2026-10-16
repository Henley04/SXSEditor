/**
 * safeCall —— 统一的"吞掉异常但留下痕迹"入口（审查项 2.4）。
 *
 * 背景：全库有 968 个 catch，其中 434 个（44.8%）是空体或只有注释，集中在
 * src/inference/pipeline/index.js（41 处）、src/modelManager.js（34 处）、
 * src/renderer/audioPlayback.js（14 处）。这些"静默异常"带来两个后果：
 *   · 推理失败可能一路静默返回空音频，用户只看到"没声音"，日志里什么都没有；
 *   · 排障时无从下手 —— 出问题的那一行根本没留下任何痕迹。
 *
 * 主进程有 safeHandle 做 IPC 层的脱敏与兜底，但渲染进程没有对应策略。这里补上：
 *   · 同步：safeCall(label, fn, fallback)
 *   · 异步：safeCallAsync(label, fn, fallback)
 * 两者都保证"不抛、有返回值、失败时留一条可检索的日志"，并把同一 label 的
 * 重复失败做计数抑制（避免每帧刷屏）。
 *
 * 模块格式：CommonJS（src/shared/ 下的 ESM 文件不能被主进程 require；渲染侧用
 * default import 即可，webpack 与 node ESM 都支持）。
 */

const _counts = new Map();
// 同一个 label 超过这个次数后不再逐条打印，只在每 SUPPRESS_FACTOR 次汇总一次
const MAX_VERBOSE_PER_LABEL = 3;
const SUPPRESS_FACTOR = 50;

function _note(label, err) {
  const n = (_counts.get(label) || 0) + 1;
  _counts.set(label, n);
  const msg = (err && err.message) ? err.message : String(err);
  if (n <= MAX_VERBOSE_PER_LABEL || n % SUPPRESS_FACTOR === 0) {
    const suffix = n > MAX_VERBOSE_PER_LABEL ? `（第 ${n} 次，已抑制同类日志）` : '';
    console.warn(`[safeCall] ${label} 失败${suffix}：${msg}`);
  }
  return n;
}

/**
 * 同步安全调用。
 * @param {string} label 便于检索的调用点标识，如 'audioPlayback.stopSource'
 * @param {Function} fn
 * @param {*} [fallback] 失败时的返回值
 * @returns {*} fn 的返回值，或 fallback
 */
function safeCall(label, fn, fallback) {
  try {
    const r = fn();
    return r === undefined ? fallback : r;
  } catch (err) {
    _note(label, err);
    return fallback;
  }
}

/**
 * 异步安全调用。
 * @param {string} label
 * @param {Function} fn 返回 Promise（或同步值）
 * @param {*} [fallback]
 * @returns {Promise<*>}
 */
async function safeCallAsync(label, fn, fallback) {
  try {
    const r = await fn();
    return r === undefined ? fallback : r;
  } catch (err) {
    _note(label, err);
    return fallback;
  }
}

/**
 * 把一段"清理型"副作用包起来（最常见的空 catch 场景：disconnect / stop /
 * removeListener）。清理失败通常不影响主流程，但也不该完全无声。
 * @param {string} label
 * @param {Function} fn
 * @returns {boolean} 是否成功执行
 */
function safeCleanup(label, fn) {
  try {
    fn();
    return true;
  } catch (err) {
    _note(`cleanup:${label}`, err);
    return false;
  }
}

/** 测试用：清空失败计数。 */
function _resetCounts() {
  _counts.clear();
}

module.exports = { safeCall, safeCallAsync, safeCleanup, _resetCounts, _counts };
