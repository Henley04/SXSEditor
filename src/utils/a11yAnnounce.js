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
 * R20: 节流 + 重复文本重播。
 * 节流：同一容器在 throttleMs 内最多写入一次（渲染循环里可能每帧都变）。
 * 相同文本：超过节流间隔后仍会重新播报 —— 否则"选中音符 3"这类状态在用户
 * 重复同一操作时完全静默。为了触发 aria-live 的 DOM 变更，重复文本会追加
 * 一个交替的零宽哨兵（ZWSP / ZWNJ），屏幕阅读器读到的内容不变。
 *
 * @param {string} id 容器元素 id
 * @param {string} text 要播报的文本
 * @param {number} [throttleMs] 节流间隔
 * @returns {boolean} 是否真的写入了
 */
function announce(id, text, throttleMs = THROTTLE_MS) {
  if (typeof document === 'undefined' || !id) return false;
  const el = document.getElementById(id);
  if (!el) return false;

  const now = Date.now();
  const prev = _last.get(id);
  // 节流：窗口内不写（含相同内容）
  if (prev && now - prev.at < throttleMs) return false;

  if (prev && prev.text === text) {
    // 相同文本：交替零宽哨兵，保证内容确实变化从而触发播报
    el.textContent = text + (prev.flip ? '\u200C' : '\u200B');
    _last.set(id, { text, at: now, flip: !prev.flip });
  } else {
    el.textContent = text;
    _last.set(id, { text, at: now, flip: false });
  }
  return true;
}

/** 测试/切换语言时清空节流记录。 */
function _resetAnnounceCache() {
  _last.clear();
}

module.exports = { announce, _resetAnnounceCache };
