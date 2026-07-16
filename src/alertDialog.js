/**
 * 非阻塞的 alert 对话框，替代原生 alert()
 *
 * 原生 alert() 在 Electron 渲染进程中会导致输入框无法聚焦：
 * - alert() 是同步阻塞的，会暂停渲染进程的所有 JavaScript 执行
 * - 弹出的原生模态对话框会从 Electron 窗口"抢走"操作系统焦点
 * - 关闭对话框后，Electron 无法正确将焦点归还给窗口内的输入元素
 */

import { t } from './i18n/index.js';
import { escapeHtml } from './utils/escapeHtml.js';

function getThemeVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * 显示非阻塞的 alert 对话框
 * @param {string} message - 要显示的消息
 * @param {Function} [onClose] - 关闭对话框后的回调
 */
export function showAlertDialog(message, onClose) {
  const overlay = document.createElement('div');
  overlay.className = 'alert-dialog-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--overlay-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    backdrop-filter: blur(4px);
    animation: sxs-overlay-in 0.25s ease;
  `;

  const dialog = document.createElement('div');
  dialog.className = 'alert-dialog-box';
  dialog.style.cssText = `
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    clip-path: var(--clip-panel, none);
    padding: 20px;
    min-width: 280px;
    max-width: 420px;
    color: var(--fg-primary);
    box-shadow: 0 16px 48px var(--shadow-color-strong), 0 0 40px var(--accent-softer);
    animation: sxs-dialog-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  `;

  dialog.innerHTML = `
    <div style="margin-bottom: 16px; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(message)}</div>
    <div style="display: flex; justify-content: flex-end;">
      <button class="alert-ok-btn" style="
        padding: 6px 20px;
        background: var(--bg-button-primary);
        border: none;
        border-radius: 6px;
        clip-path: var(--clip-button, none);
        color: var(--fg-on-accent);
        cursor: pointer;
        font-weight: 500;
        transition: all 0.15s ease;
      ">${t('common.confirm') || 'OK'}</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Inject animation keyframes if not already present
  ensureAnimationStyles();

  const okBtn = dialog.querySelector('.alert-ok-btn');

  // Button hover/press micro-interactions
  okBtn.addEventListener('mouseenter', () => {
    okBtn.style.boxShadow = '0 2px 12px var(--accent-glow)';
    okBtn.style.transform = 'translateY(-1px)';
  });
  okBtn.addEventListener('mouseleave', () => {
    okBtn.style.boxShadow = 'none';
    okBtn.style.transform = 'translateY(0)';
  });
  okBtn.addEventListener('mousedown', () => {
    okBtn.style.transform = 'translateY(0) scale(0.97)';
    okBtn.style.transitionDuration = '0.06s';
  });
  okBtn.addEventListener('mouseup', () => {
    okBtn.style.transitionDuration = '0.15s';
  });

  const close = () => {
    // Exit animation
    dialog.style.animation = 'sxs-dialog-exit 0.2s ease forwards';
    overlay.style.animation = 'sxs-overlay-out 0.2s ease forwards';
    setTimeout(() => {
      if (overlay.parentElement) overlay.remove();
      if (onClose) onClose();
    }, 200);
  };

  okBtn.addEventListener('click', close);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  requestAnimationFrame(() => {
    okBtn.focus();
  });
}

/**
 * 显示非阻塞的 confirm 对话框，替代原生 confirm()
 * @param {string} message - 要显示的消息
 * @returns {Promise<boolean>} 用户是否点击了确认
 */
export function showConfirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--overlay-scrim);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      backdrop-filter: blur(4px);
      animation: sxs-overlay-in 0.25s ease;
    `;

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog-box';
    dialog.style.cssText = `
      background: var(--bg-elevated);
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      clip-path: var(--clip-panel, none);
      padding: 20px;
      min-width: 280px;
      max-width: 420px;
      color: var(--fg-primary);
      box-shadow: 0 16px 48px var(--shadow-color-strong), 0 0 40px var(--accent-softer);
      animation: sxs-dialog-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    `;

    dialog.innerHTML = `
      <div style="margin-bottom: 16px; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(message)}</div>
      <div style="display: flex; justify-content: flex-end; gap: 8px;">
        <button class="confirm-cancel-btn" style="
          padding: 6px 20px;
          background: var(--bg-button);
          border: 1px solid var(--border-strong);
          border-radius: 6px;
          clip-path: var(--clip-button, none);
          color: var(--fg-muted);
          cursor: pointer;
          font-weight: 500;
          transition: all 0.15s ease;
        ">${t('common.cancel') || 'Cancel'}</button>
        <button class="confirm-ok-btn" style="
          padding: 6px 20px;
          background: var(--bg-button-danger);
          border: none;
          border-radius: 6px;
          clip-path: var(--clip-button, none);
          color: var(--fg-on-accent);
          cursor: pointer;
          font-weight: 500;
          transition: all 0.15s ease;
        ">${t('common.confirm') || 'OK'}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Inject animation keyframes if not already present
    ensureAnimationStyles();

    const okBtn = dialog.querySelector('.confirm-ok-btn');
    const cancelBtn = dialog.querySelector('.confirm-cancel-btn');

    // Button hover/press micro-interactions
    [okBtn, cancelBtn].forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        btn.style.transform = 'translateY(-1px)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.transform = 'translateY(0)';
        btn.style.boxShadow = 'none';
      });
      btn.addEventListener('mousedown', () => {
        btn.style.transform = 'translateY(0) scale(0.97)';
        btn.style.transitionDuration = '0.06s';
      });
      btn.addEventListener('mouseup', () => {
        btn.style.transitionDuration = '0.15s';
      });
    });

    okBtn.addEventListener('mouseenter', () => {
      okBtn.style.boxShadow = '0 2px 12px var(--danger-glow)';
    });

    const close = (result) => {
      dialog.style.animation = 'sxs-dialog-exit 0.2s ease forwards';
      overlay.style.animation = 'sxs-overlay-out 0.2s ease forwards';
      setTimeout(() => {
        if (overlay.parentElement) overlay.remove();
        resolve(result);
      }, 200);
    };

    okBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
    });

    requestAnimationFrame(() => {
      cancelBtn.focus();
    });
  });
}

/**
 * Ensure animation keyframes are injected into the document (once).
 */
function ensureAnimationStyles() {
  if (document.getElementById('sxs-dialog-anim-keyframes')) return;
  const style = document.createElement('style');
  style.id = 'sxs-dialog-anim-keyframes';
  style.textContent = `
    @keyframes sxs-overlay-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes sxs-overlay-out {
      from { opacity: 1; }
      to { opacity: 0; }
    }
    @keyframes sxs-dialog-enter {
      from {
        opacity: 0;
        transform: translateY(12px) scale(0.97);
        filter: blur(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
        filter: blur(0);
      }
    }
    @keyframes sxs-dialog-exit {
      from {
        opacity: 1;
        transform: translateY(0) scale(1);
        filter: blur(0);
      }
      to {
        opacity: 0;
        transform: translateY(8px) scale(0.98);
        filter: blur(3px);
      }
    }
  `;
  document.head.appendChild(style);
}
