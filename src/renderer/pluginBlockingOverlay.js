/**
 * 插件播放侧接线（渲染进程）：阻滞播放浮层 + 插件输出通道。
 *
 * 需求原文："允许插件阻滞播放以允许部分推理/拼接插件的运行时间（且在阻塞播放时
 * 显示信息）"。主进程在插件调用 ctx.blockPlayback() 时推送三个事件：
 *   · plugin:blocking-start  {ticketId, pluginId, title, message, progress, cancellable}
 *   · plugin:blocking-update 同上（message / progress 可变）
 *   · plugin:blocking-end    同上 + {reason, cancelled}
 * 本文件把它们翻译成一个**纯视觉**浮层：不做 alert()、不阻塞 UI 线程、不改播放
 * 状态机——真正的等待是调用方 await 插件合成自然产生的。
 *
 * 四条设计约束：
 *   1. 零预建 DOM：没有 start 事件时只有几个 IPC 监听器，完全不碰 document；
 *   2. 插件文本一律外部数据：只走 textContent + truncateText()，绝不拼 innerHTML；
 *   3. 兜底不缺席：每个 ticket 自带"静默超时"与"硬上限"两个定时器，end 事件丢失
 *      或插件挂死时浮层自动收起并留 console 告警，UI 不会被永久卡住；
 *   4. 可测：状态机在 createPluginBlockingOverlay() 里，document / 时钟 / 定时器
 *      全部靠 options 注入，安装层只负责订阅与拆除。
 *
 * 已知未接：ctx.emitAudio()（plugin:audio）暂不进主播放链路，见 installPluginPlaybackBridge
 * 的注释 —— 当前插件走通的路径是"整段 pcm 作为 synthesize 结果返回"。
 */

import { t } from '../i18n/index.js';
import { truncateText } from './pluginBackend.js';

/** 插件文本展示上限（截断口径与 pluginBackend.js 一致）。 */
const MAX_TITLE_LEN = 48;
const MAX_MESSAGE_LEN = 160;
const MAX_DIAG_LEN = 160;

/** 兜底①：ticket 多久没有任何 update 就判定插件失联（默认 60s）。 */
export const DEFAULT_STALL_TIMEOUT_MS = 60 * 1000;
/** 兜底②：ticket 的绝对寿命上限，与宿主侧 watchdog 同一量级（默认 10 分钟）。 */
export const DEFAULT_HARD_TIMEOUT_MS = 10 * 60 * 1000;

/** 取预置插件 API（单测 / 旧版 preload 下返回 null）。 */
function _defaultApi() {
  if (typeof window === 'undefined' || !window.electronAPI) return null;
  return window.electronAPI.pluginAPI || null;
}

/** 建元素并一次性套好内联样式（不生成 HTML 字符串，天然免疫注入）。 */
function _makeEl(doc, tag, style) {
  const el = doc.createElement(tag);
  if (style) Object.assign(el.style, style);
  return el;
}

/** 把任意插件输入收敛成 0..100 的整数百分比。 */
function _clampProgress(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return 0;
  return Math.round(Math.min(100, Math.max(0, num)));
}

/** 外部文本 → 字符串（非字符串先转，再由调用方截断）。 */
function _asText(raw) {
  return typeof raw === 'string' ? raw : String(raw ?? '');
}

/**
 * 诊断对象摘要：只挑几个可预期字段，其余忽略。
 * 诊断对象是插件自定义结构，可能很大也可能带有循环引用，绝不能整颗塞进 UI。
 * @param {unknown} diag
 * @returns {string}
 */
export function summarizeDiagnostics(diag) {
  if (!diag || typeof diag !== 'object') return '';
  const parts = [];
  for (const key of ['message', 'stage', 'detail', 'error']) {
    const value = diag[key];
    if (typeof value === 'string' && value) parts.push(truncateText(value, 80));
    else if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${key}=${value}`);
  }
  if (parts.length > 0) return truncateText(parts.join(' · '), MAX_DIAG_LEN);
  try {
    return truncateText(JSON.stringify(diag).slice(0, MAX_DIAG_LEN), MAX_DIAG_LEN);
  } catch (_) {
    // 循环引用等极端情况：宁可不显示，也不能让 UI 崩。
    return '';
  }
}

/**
 * 阻滞浮层的状态机（不依赖模块级 document，便于用 DOM stub 单测）。
 *
 * 状态：每个 ticket 独立，Map<ticketId, ticket>；"当前活跃"= 最近 start 的那个，
 * 它 end 之后回退到剩余里最早的那个（Map 的插入顺序）。Map 空 → 浮层整棵摘除。
 *
 * @param {object} [options]
 * @param {Document}  [options.document]        DOM 宿主（注入式，便于测试）
 * @param {()=>number} [options.now]            时钟
 * @param {(fn:Function, ms:number)=>any} [options.setTimer]
 * @param {(id:any)=>void} [options.clearTimer]
 * @param {number} [options.stallTimeoutMs]     静默超时（兜底①）
 * @param {number} [options.hardTimeoutMs]      绝对上限（兜底②）
 * @param {(ticketId:string)=>void} [options.cancelTicket] 取消按钮的动作
 * @param {(ticketId:string, reason:string)=>void} [options.onStalled] 兜底触发钩子（测试用）
 * @returns {object} 状态机句柄
 */
export function createPluginBlockingOverlay(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer || ((id) => clearTimeout(id));
  const stallTimeoutMs = Number.isFinite(options.stallTimeoutMs)
    ? options.stallTimeoutMs : DEFAULT_STALL_TIMEOUT_MS;
  const hardTimeoutMs = Number.isFinite(options.hardTimeoutMs)
    ? options.hardTimeoutMs : DEFAULT_HARD_TIMEOUT_MS;
  const cancelTicket = typeof options.cancelTicket === 'function' ? options.cancelTicket : null;
  const onStalled = typeof options.onStalled === 'function' ? options.onStalled : null;

  /** @type {Map<string, object>} ticketId -> ticket */
  const tickets = new Map();
  /** 当前显示在浮层上的 ticketId（null = 没有活跃 ticket） */
  let activeId = null;
  /** 浮层根节点：懒建，最后一个 ticket 收尾时整棵移除 */
  let root = null;
  let refs = null;

  // -------------------------------------------------------------------
  // DOM：只在第一次需要显示时创建
  // -------------------------------------------------------------------

  function _ensureDom() {
    if (root || !doc || !doc.body) return;
    root = _makeEl(doc, 'div', {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      zIndex: '9999',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-overlay, rgba(8, 10, 14, 0.45))',
      pointerEvents: 'auto',
    });
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');

    const panel = _makeEl(doc, 'div', {
      minWidth: '320px',
      maxWidth: '520px',
      padding: '20px 22px',
      borderRadius: '12px',
      boxShadow: 'var(--shadow-xl, 0 18px 48px rgba(0, 0, 0, 0.35))',
      background: 'var(--bg-panel, #1b1f27)',
      border: '1px solid var(--border-default, rgba(255, 255, 255, 0.12))',
      color: 'var(--fg-primary, #f2f4f8)',
      font: '14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    });

    const title = _makeEl(doc, 'div', { fontSize: '15px', fontWeight: '600' });
    const message = _makeEl(doc, 'div', { color: 'var(--fg-secondary, #b9bfcb)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' });

    const barOuter = _makeEl(doc, 'div', {
      height: '6px',
      borderRadius: '3px',
      overflow: 'hidden',
      background: 'var(--bg-input, rgba(255, 255, 255, 0.10))',
    });
    const barFill = _makeEl(doc, 'div', {
      height: '100%',
      width: '0%',
      background: 'var(--accent, #4c8dff)',
      transition: 'width 120ms linear',
    });
    barOuter.appendChild(barFill);

    const percent = _makeEl(doc, 'div', { fontSize: '12px', color: 'var(--fg-secondary, #b9bfcb)' });
    const count = _makeEl(doc, 'div', { fontSize: '12px', color: 'var(--fg-secondary, #b9bfcb)', display: 'none' });
    const diagnostic = _makeEl(doc, 'div', {
      fontSize: '12px',
      color: 'var(--fg-secondary, #b9bfcb)',
      display: 'none',
      wordBreak: 'break-word',
    });

    const cancel = _makeEl(doc, 'button', {
      alignSelf: 'flex-end',
      padding: '6px 14px',
      borderRadius: '6px',
      cursor: 'pointer',
      border: '1px solid var(--border-default, rgba(255, 255, 255, 0.18))',
      background: 'var(--bg-button, rgba(255, 255, 255, 0.08))',
      color: 'var(--fg-primary, #f2f4f8)',
      display: 'none',
    });
    cancel.setAttribute('type', 'button');
    cancel.addEventListener('click', () => {
      const ticket = activeId ? tickets.get(activeId) : null;
      if (!ticket || ticket.cancellable !== true || ticket.cancelRequested) return;
      ticket.cancelRequested = true;
      cancel.disabled = true;
      if (cancelTicket) {
        try {
          cancelTicket(ticket.ticketId);
        } catch (err) {
          console.warn('[plugins] 取消阻滞 ticket 失败：', err && err.message ? err.message : err);
        }
      }
    });

    panel.appendChild(title);
    panel.appendChild(message);
    panel.appendChild(barOuter);
    panel.appendChild(percent);
    panel.appendChild(count);
    panel.appendChild(diagnostic);
    panel.appendChild(cancel);
    root.appendChild(panel);
    doc.body.appendChild(root);

    refs = { panel, title, message, barOuter, barFill, percent, count, diagnostic, cancel };
  }

  function _destroyDom() {
    if (root && root.parentNode) {
      try { root.parentNode.removeChild(root); } catch (_) {}
    }
    root = null;
    refs = null;
  }

  // -------------------------------------------------------------------
  // 渲染：全部走 textContent
  // -------------------------------------------------------------------

  function _render() {
    const ticket = activeId ? tickets.get(activeId) : null;
    if (!ticket) {
      _destroyDom();
      return;
    }
    _ensureDom();
    if (!refs) return;

    refs.title.textContent = ticket.title || t('main.plugin.blockingTitle');
    refs.message.textContent = ticket.message;
    const progress = _clampProgress(ticket.progress);
    refs.barFill.style.width = `${progress}%`;
    refs.percent.textContent = t('main.synthesizingProgress', { progress });

    const others = tickets.size - 1;
    refs.count.style.display = others > 0 ? 'block' : 'none';
    refs.count.textContent = others > 0 ? t('main.plugin.blockingMore', { count: others }) : '';

    const cancellable = ticket.cancellable === true;
    refs.cancel.style.display = cancellable ? 'block' : 'none';
    refs.cancel.disabled = ticket.cancelRequested === true;
    refs.cancel.textContent = t('main.plugin.blockingCancel');

    if (ticket.diagnostic) {
      refs.diagnostic.style.display = 'block';
      refs.diagnostic.textContent = t('main.plugin.diagnosticsSummary', { summary: ticket.diagnostic });
    } else {
      refs.diagnostic.style.display = 'none';
      refs.diagnostic.textContent = '';
    }
  }

  // -------------------------------------------------------------------
  // 兜底定时器
  // -------------------------------------------------------------------

  function _clearWatchers(ticket) {
    if (!ticket) return;
    if (ticket.stallTimer != null) {
      try { clearTimer(ticket.stallTimer); } catch (_) {}
      ticket.stallTimer = null;
    }
    if (ticket.hardTimer != null) {
      try { clearTimer(ticket.hardTimer); } catch (_) {}
      ticket.hardTimer = null;
    }
  }

  /**
   * 重新武装静默定时器（start 与每次 update 都调）：插件每说一句话就多续一会儿命。
   * 注意——硬上限定时器不在这里重置，否则它就退化成第二个静默定时器了。
   */
  function _armStallWatcher(ticket) {
    if (ticket.stallTimer != null) {
      try { clearTimer(ticket.stallTimer); } catch (_) {}
      ticket.stallTimer = null;
    }
    if (stallTimeoutMs <= 0) return;
    ticket.stallTimer = setTimer(() => {
      console.warn(`[plugins] 阻滞 ticket ${ticket.ticketId} 超过 ${stallTimeoutMs}ms 无更新，已收起浮层（插件可能卡死或忘记 end）`);
      if (onStalled) onStalled(ticket.ticketId, 'stall-timeout');
      _forget(ticket.ticketId);
    }, stallTimeoutMs);
  }

  /**
   * 武装绝对寿命上限：**只在 ticket 创建时挂一次**，update 不续命。
   * 它兜的是"插件一直在说话却永远不 end"这种情况，被 update 重置就失去意义了。
   */
  function _armHardWatcher(ticket) {
    if (ticket.hardTimer != null || hardTimeoutMs <= 0) return;
    ticket.hardTimer = setTimer(() => {
      console.warn(`[plugins] 阻滞 ticket ${ticket.ticketId} 存活超过 ${hardTimeoutMs}ms，已强制收起浮层`);
      if (onStalled) onStalled(ticket.ticketId, 'hard-timeout');
      _forget(ticket.ticketId);
    }, hardTimeoutMs);
  }

  /** 回收单个 ticket（幂等），必要时重选活跃 ticket 并重绘。 */
  function _forget(ticketId) {
    const ticket = tickets.get(ticketId);
    if (!ticket) return;
    _clearWatchers(ticket);
    tickets.delete(ticketId);
    if (activeId === ticketId) {
      // 回退到仍在等待的最早一个 ticket，没有就收摊。
      activeId = tickets.size > 0 ? tickets.keys().next().value : null;
    }
    _render();
  }

  // -------------------------------------------------------------------
  // 事件处理（三个 IPC 回调的本体）
  // -------------------------------------------------------------------

  function handleBlockingStart(payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const ticketId = typeof data.ticketId === 'string' && data.ticketId ? data.ticketId : null;
    if (!ticketId) return;
    // 重复 start（插件/宿主重放）：按更新处理，不新建 map 项。
    const existing = tickets.get(ticketId);
    const ticket = existing || {
      ticketId,
      title: '',
      message: '',
      progress: 0,
      cancellable: false,
      cancelRequested: false,
      diagnostic: '',
      startedAt: now(),
      stallTimer: null,
      hardTimer: null,
    };
    ticket.pluginId = truncateText(_asText(data.pluginId), MAX_TITLE_LEN);
    if (typeof data.title === 'string') ticket.title = truncateText(data.title, MAX_TITLE_LEN);
    if (typeof data.message === 'string') ticket.message = truncateText(data.message, MAX_MESSAGE_LEN);
    if (Number.isFinite(Number(data.progress))) ticket.progress = _clampProgress(data.progress);
    if (typeof data.cancellable === 'boolean') ticket.cancellable = data.cancellable;
    ticket.lastUpdateAt = now();
    tickets.set(ticketId, ticket);
    // 最近 start 的 ticket 成为活跃项（"显示当前活跃的那个"）。
    activeId = ticketId;
    _armStallWatcher(ticket);
    _armHardWatcher(ticket);
    _render();
  }

  function handleBlockingUpdate(payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const ticketId = typeof data.ticketId === 'string' ? data.ticketId : null;
    const ticket = ticketId ? tickets.get(ticketId) : null;
    // 未 start / 已 end 的 ticket 的迟到更新直接丢弃，不接受凭空出现的浮层。
    if (!ticket) return;
    if (typeof data.title === 'string') ticket.title = truncateText(data.title, MAX_TITLE_LEN);
    if (typeof data.message === 'string') ticket.message = truncateText(data.message, MAX_MESSAGE_LEN);
    if (Number.isFinite(Number(data.progress))) ticket.progress = _clampProgress(data.progress);
    if (typeof data.cancellable === 'boolean') ticket.cancellable = data.cancellable;
    ticket.lastUpdateAt = now();
    _armStallWatcher(ticket);
    if (ticketId === activeId) _render();
  }

  function handleBlockingEnd(payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const ticketId = typeof data.ticketId === 'string' ? data.ticketId : null;
    if (!ticketId) return;
    _forget(ticketId);
  }

  /**
   * 把一段诊断摘要挂到当前活跃 ticket 上（浮层可见时显示一行）。
   * @param {string} text 已截断的纯文本
   */
  function setDiagnostic(text) {
    if (!text) return;
    const ticket = activeId ? tickets.get(activeId) : null;
    if (!ticket) return; // 浮层没显示就不为了一行诊断去建 DOM
    ticket.diagnostic = truncateText(_asText(text), MAX_DIAG_LEN);
    _render();
  }

  /** 强制收起全部 ticket（卸载 / 停止播放时兜底）。 */
  function clear(reason) {
    for (const ticket of [...tickets.values()]) {
      const id = ticket.ticketId;
      _clearWatchers(ticket);
      tickets.delete(id);
      // Map 为空时循环体不执行，正常路径不会产生噪音日志。
      console.warn(`[plugins] 阻滞浮层被强制清理（reason=${reason || 'manual'}，ticket=${id}）`);
    }
    activeId = null;
    _render();
  }

  return {
    handleBlockingStart,
    handleBlockingUpdate,
    handleBlockingEnd,
    setDiagnostic,
    clear,
    /** 调试/自测用快照。 */
    getState: () => ({
      size: tickets.size,
      ids: [...tickets.keys()],
      activeTicketId: activeId,
      visible: !!root,
    }),
  };
}

/** 安装期句柄：供 stopPlayback 等外部清理点调用（未安装时是 no-op）。 */
let _installed = null;

/**
 * 安装插件播放侧的全部接线：阻滞浮层 + progress / diagnostics 输出通道。
 *
 * 返回值是 removeListener 的组合函数，**必须在合适的生命周期调用**：
 * index.js 把它推进 state._ipcCleanups（那里已有 beforeunload 统一回收，见
 * renderer/eventHandlers.js），另外 stopPlayback() 会调用下面的
 * clearPluginBlockingOverlay() 在播放结束时兜底收摊。
 *
 * @param {object} [options]
 * @param {object} [options.api]                插件 API（默认 window.electronAPI.pluginAPI）
 * @param {()=>HTMLElement|null} [options.getTimeDisplay] "合成中 xx%" 的展示位
 * 其余字段透传给 createPluginBlockingOverlay()（clock / timers / document …）。
 * @returns {() => void} 取消注册函数
 */
export function installPluginPlaybackBridge(options = {}) {
  const api = options.api || _defaultApi();
  if (!api) return () => {};

  const getTimeDisplay = typeof options.getTimeDisplay === 'function'
    ? options.getTimeDisplay : () => null;

  const overlay = createPluginBlockingOverlay({
    ...options,
    cancelTicket: typeof options.cancelTicket === 'function'
      ? options.cancelTicket
      : (typeof api.cancelTicket === 'function' ? (id) => api.cancelTicket(id) : null),
  });

  const cleanups = [];
  if (typeof api.onBlockingStart === 'function') {
    cleanups.push(api.onBlockingStart((data) => overlay.handleBlockingStart(data)));
  }
  if (typeof api.onBlockingUpdate === 'function') {
    cleanups.push(api.onBlockingUpdate((data) => overlay.handleBlockingUpdate(data)));
  }
  if (typeof api.onBlockingEnd === 'function') {
    cleanups.push(api.onBlockingEnd((data) => overlay.handleBlockingEnd(data)));
  }

  // ---- 输出通道 ----
  if (typeof api.onProgress === 'function') {
    cleanups.push(api.onProgress((data) => {
      const progress = Number(data && data.progress);
      if (!Number.isFinite(progress)) return;
      const el = getTimeDisplay();
      // 与既有"合成中 xx%"同一展示位；timeDisplay 是纯文本元素，用 textContent
      // （只有带图标的按钮才需要 setLabel）。
      if (el) el.textContent = t('main.plugin.synthesizingProgress', { progress: _clampProgress(progress) });
    }));
  }
  if (typeof api.onDiagnostics === 'function') {
    cleanups.push(api.onDiagnostics((data) => {
      const diag = data && data.diagnostics;
      const summary = summarizeDiagnostics(diag);
      const pluginId = data && data.pluginId ? data.pluginId : '?';
      console.info('[plugins] 诊断上报', pluginId, diag);
      if (summary) overlay.setDiagnostic(summary);
    }));
  }
  // ctx.emitAudio()（plugin:audio）**未接入**：见文件头说明。这里刻意不订阅，
  // 免得给"已经实现"的错觉。

  _installed = overlay;

  return () => {
    for (const off of cleanups) {
      try { off(); } catch (_) {}
    }
    cleanups.length = 0;
    overlay.clear('dispose');
    if (_installed === overlay) _installed = null;
  };
}

/**
 * 外部清理钩子：播放结束 / 窗口卸载时收掉可能残留的阻滞浮层。
 * 未安装时是 no-op，因此调用方不需要判空。
 * @param {string} [reason]
 */
export function clearPluginBlockingOverlay(reason) {
  if (!_installed) return;
  try { _installed.clear(reason || 'playback-stopped'); } catch (_) {}
}
