/**
 * a11yAnnounce —— 给 canvas 这类"画出来的 UI"补一个读屏可见的状态播报（U3）。
 *
 * 钢琴卷帘与分片时间轴都是 canvas：内容是用 2D context 画出来的，DOM 里没有
 * 任何节点，读屏软件只能看到一行 aria-label。用户改了音符、选了分片、播放头
 * 移动了，读屏全无感知。
 *
 * 做法：HTML 里放一个 `.sr-only` + `aria-live="polite"` 的容器，状态变化时把
 * 一句简短的中文/英文摘要写进去，读屏会自动播报。写入做了节流（默认 500ms），
 * 避免在渲染循环里高频改动 DOM。
 *
 * 模块格式：CommonJS（渲染侧用 default import；主进程不需要）。
 */

const _last = new Map();
const THROTTLE_MS = 500;

/**
 * 更新一个 aria-live 容器的文本。
 *
 * @param {string} id 容器元素 id
 * @param {string} text 要播报的文本；重复内容自动跳过
 * @param {number} [throttleMs] 节流间隔
 * @returns {boolean} 是否真的写入了
 */
function announce(id, text, throttleMs = THROTTLE_MS) {
  if (typeof document === 'undefined' || !id) return false;
  const el = document.getElementById(id);
  if (!el) return false;

  const now = Date.now();
  const prev = _last.get(id);
  // 相同内容不重复播报；不同内容也要受节流保护（渲染循环里可能每帧都变）
  if (prev && prev.text === text) return false;
  if (prev && now - prev.at < throttleMs) return false;

  el.textContent = text;
  _last.set(id, { text, at: now });
  return true;
}

/** 测试/切换语言时清空节流记录。 */
function _resetAnnounceCache() {
  _last.clear();
}

module.exports = { announce, _resetAnnounceCache };
