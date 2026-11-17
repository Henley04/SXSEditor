/**
 * 帮助 → 「环境检测」弹层。
 *
 * 与 mcpSetupDialog 同构（自建弹层 + 双通道复制），差异在于数据来源：
 *   - 先 await 一次 getEnvReport()（纯内存快照，毫秒级）把主体画出来；
 *   - GPU 还没跑到 full 时每 800ms 重取一次快照，最多等 16s（主进程 worker
 *     自带 15s 兜底）；
 *   - probes（原生桥 / EP 枚举）在后台跑，回来后只重绘，不阻塞首屏。
 *
 * 不用 uiControls 的 createDialog：那个工厂点任何按钮都会关窗，而复制需要在
 * 原地给出成功/失败反馈；复制失败时弹层消失，用户就丢了整份报告。
 */
import { t } from '../i18n/index.js';
import {
  buildEnvCheckView,
  GPU_POLL_INTERVAL_MS,
  GPU_POLL_DEADLINE_MS,
} from './envCheckFormat.js';

// 「探测中（...）（..）（.）」省略号动画的三帧。只作用于 DOM，不进 plainText，
// 所以复制出来的报告始终是稳定的 `detecting` 文案，不会抓到某个中间帧。
const PROBE_FRAMES = ['...', '..', '.'];
const PROBE_TICK_MS = 400;

async function copyText(text, textarea) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* 权限不足时退回 execCommand */ }
  try {
    textarea.focus();
    textarea.select();
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch (_) {
    return false;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 打开环境检测弹层。
 * @returns {Promise<() => void>} close 函数（测试与调用方主动收起用）
 */
export async function showEnvCheckDialog() {
  // 单例：菜单连点两次不应该叠出两个遮罩。
  if (document.querySelector('[data-testid="env-check-dialog"]')) return () => {};

  const overlay = el('div', 'modal-overlay');
  overlay.setAttribute('role', 'presentation');

  const dialog = el('div', 'modal-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('data-testid', 'env-check-dialog');
  dialog.style.cssText = [
    'width: min(720px, 92vw)',
    'max-width: min(720px, 92vw)',
    'max-height: 86vh',
    'display: flex',
    'flex-direction: column',
    'overflow: hidden',
  ].join(';');

  const title = el('div', 'modal-title', t('envCheck.title'));
  const hint = el('div', 'modal-hint', t('envCheck.description'));

  const body = el('div');
  body.setAttribute('data-testid', 'env-check-body');
  body.style.cssText = 'flex: 1 1 auto; min-height: 120px; overflow-y: auto; padding-right: 4px;';

  // 纯文本预览：既是「复制了什么」的透明展示，也是剪贴板不可用时的兜底。
  const preview = document.createElement('details');
  preview.style.cssText = 'margin-top: 12px; font-size: 12px; color: var(--fg-muted);';
  const summary = el('summary', null, t('envCheck.preview'));
  summary.style.cursor = 'pointer';
  preview.appendChild(summary);

  const previewArea = document.createElement('textarea');
  previewArea.readOnly = true;
  previewArea.setAttribute('data-testid', 'env-check-preview');
  previewArea.style.cssText = [
    'width: 100%',
    'box-sizing: border-box',
    'height: 160px',
    'margin-top: 8px',
    'padding: 10px',
    'background: var(--bg-input, var(--bg-elevated))',
    'color: var(--fg-primary)',
    'border: 1px solid var(--border-strong)',
    'border-radius: var(--radius-md)',
    'font-family: ui-monospace, SFMono-Regular, Consolas, monospace',
    'font-size: 11px',
    'line-height: 1.5',
    'white-space: pre',
  ].join(';');
  preview.appendChild(previewArea);

  const feedback = el('div');
  feedback.setAttribute('data-testid', 'env-check-feedback');
  feedback.style.cssText = 'min-height: 18px; margin-top: 6px; font-size: 12px; color: var(--fg-muted);';

  const actions = el('div');
  actions.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px;';

  const copyBtn = el('button', null, t('envCheck.copy'));
  copyBtn.type = 'button';
  copyBtn.setAttribute('data-testid', 'env-check-copy');
  copyBtn.style.cssText = [
    'padding: 6px 16px',
    'background: var(--bg-button-primary)',
    'border: none',
    'border-radius: var(--radius-md)',
    'color: var(--fg-on-accent)',
    'cursor: pointer',
    'opacity: 0.6',
  ].join(';');
  copyBtn.disabled = true;

  const closeBtn = el('button', null, t('envCheck.close'));
  closeBtn.type = 'button';
  closeBtn.setAttribute('data-testid', 'env-check-close');
  closeBtn.style.cssText = [
    'padding: 6px 16px',
    'background: var(--bg-button)',
    'border: 1px solid var(--button-secondary-border)',
    'border-radius: var(--radius-md)',
    'color: var(--fg-primary)',
    'cursor: pointer',
  ].join(';');

  actions.appendChild(copyBtn);
  actions.appendChild(closeBtn);

  dialog.appendChild(title);
  dialog.appendChild(hint);
  dialog.appendChild(body);
  dialog.appendChild(preview);
  dialog.appendChild(feedback);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);

  let report = null;
  let probes = null;
  let view = null;
  let disposed = false;
  let gpuTimedOut = false;
  let pollTimer = null;
  let restoreTimer = null;
  let probeTimer = null;
  let probeFrame = 0;

  /** 探测中文案：带省略号动画，仅用于 DOM 展示，绝不写入 plainText。 */
  const probeLabel = () => t('envCheck.probeFrame', { dots: PROBE_FRAMES[probeFrame] });

  /**
   * 启动/停止省略号动画。所有处于等待态的 value 节点共用一个定时器：每次 tick
   * 只更新带 `data-probe` 标记的节点，不整表重绘，避免滚动位置跳动。
   */
  const syncProbeAnimation = () => {
    const nodes = body.querySelectorAll('[data-probe]');
    if (nodes.length === 0 || disposed) {
      if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
      }
      return;
    }
    if (probeTimer) return;
    probeTimer = setInterval(() => {
      if (disposed) {
        clearInterval(probeTimer);
        probeTimer = null;
        return;
      }
      probeFrame = (probeFrame + 1) % PROBE_FRAMES.length;
      const label = probeLabel();
      body.querySelectorAll('[data-probe]').forEach((node) => {
        node.textContent = label;
      });
    }, PROBE_TICK_MS);
  };

  /** 生成一个等待态 value 节点：初值即动画文案，并打标记交给 syncProbeAnimation。 */
  const probeNode = () => {
    const node = el('span', null, probeLabel());
    node.setAttribute('data-probe', '1');
    return node;
  };

  const render = () => {
    if (disposed) return;
    const scrollTop = body.scrollTop;
    body.textContent = '';

    if (!report) {
      body.appendChild(probeNode());
      syncProbeAnimation();
      return;
    }

    view = buildEnvCheckView(report, probes, t, { gpuTimedOut });
    for (const section of view.sections) {
      const block = el('section');
      block.setAttribute('data-section', section.key);
      block.style.cssText = 'margin-bottom: 14px;';

      const heading = el('div', null, section.title);
      heading.style.cssText = [
        'font-size: 12px',
        'font-weight: 600',
        'color: var(--fg-muted)',
        'letter-spacing: 0.04em',
        'margin-bottom: 6px',
      ].join(';');
      block.appendChild(heading);

      for (const row of section.rows) {
        const line = el('div');
        line.style.cssText = 'display: flex; gap: 10px; padding: 2px 0; font-size: 13px; line-height: 1.55;';

        const label = el('span', null, row.label);
        label.style.cssText = 'flex: 0 0 120px; color: var(--fg-muted);';

        // 只有「检测中…」是进行态，用省略号动画节点；「检测超时」是终态，
        // 保持静态文案。plainText 始终取 row.value，不受动画帧影响。
        const pending = row.value === t('envCheck.detecting');
        const value = pending ? probeNode() : el('span', null, row.value);
        value.style.cssText = 'flex: 1 1 auto; color: var(--fg-primary); word-break: break-word;';

        line.appendChild(label);
        line.appendChild(value);
        block.appendChild(line);
      }
      body.appendChild(block);
    }

    body.scrollTop = scrollTop;
    previewArea.value = view.plainText;
    copyBtn.disabled = false;
    copyBtn.style.opacity = '1';
    syncProbeAnimation();
  };

  const api = typeof window !== 'undefined' ? window.electronAPI : null;

  const startGpuPolling = () => {
    if (!report || !report.gpu || !report.gpu.supported) return;
    if (report.gpu.phase === 'full') return;
    if (!api || typeof api.envCheckGetReport !== 'function') return;

    const startedAt = Date.now();
    pollTimer = setInterval(async () => {
      if (disposed) {
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      if (Date.now() - startedAt > GPU_POLL_DEADLINE_MS) {
        clearInterval(pollTimer);
        pollTimer = null;
        gpuTimedOut = true;
        render();
        return;
      }
      try {
        const next = await api.envCheckGetReport();
        if (disposed || !next) return;
        report = next;
        if (next.gpu && next.gpu.phase === 'full') {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        render();
      } catch (_) { /* 单次轮询失败不致命，下一拍再试 */ }
    }, GPU_POLL_INTERVAL_MS);
  };

  const loadReport = async () => {
    if (!api || typeof api.envCheckGetReport !== 'function') return;
    try {
      report = await api.envCheckGetReport();
    } catch (_) {
      report = null;
    }
    if (disposed) return;
    if (!report) {
      body.textContent = '';
      body.appendChild(el('div', null, t('envCheck.loadFailed')));
      return;
    }
    render();
    startGpuPolling();
  };

  const loadProbes = async () => {
    if (!api || typeof api.envCheckGetProbes !== 'function') return;
    try {
      const next = await api.envCheckGetProbes();
      if (disposed || !next) return;
      probes = next;
      render();
    } catch (_) { /* 探测失败就保持快照视图，不弹错误框 */ }
  };

  const close = () => {
    if (disposed) return;
    disposed = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      restoreTimer = null;
    }
    document.removeEventListener('keydown', onKeydown);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  };

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  copyBtn.addEventListener('click', async () => {
    const text = view && view.plainText ? view.plainText : '';
    if (!text) return;
    const ok = await copyText(text, previewArea);
    if (disposed) return;
    if (ok) {
      copyBtn.textContent = t('envCheck.copied');
      feedback.textContent = t('envCheck.copiedHint');
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        if (!disposed) copyBtn.textContent = t('envCheck.copy');
      }, 2000);
    } else {
      // 复制失败时把预览展开，用户可手动全选——弹层绝不自动关闭。
      feedback.textContent = t('envCheck.copyFailed');
      preview.open = true;
    }
  });

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown);

  document.body.appendChild(overlay);
  render();

  await loadReport();
  if (!disposed) void loadProbes();

  return close;
}
