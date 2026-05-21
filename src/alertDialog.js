/**
 * 非阻塞的 alert 对话框，替代原生 alert()
 *
 * 原生 alert() 在 Electron 渲染进程中会导致输入框无法聚焦：
 * - alert() 是同步阻塞的，会暂停渲染进程的所有 JavaScript 执行
 * - 弹出的原生模态对话框会从 Electron 窗口"抢走"操作系统焦点
 * - 关闭对话框后，Electron 无法正确将焦点归还给窗口内的输入元素
 */

import { t } from './i18n/index.js';

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 8px;
    padding: 20px;
    min-width: 280px;
    max-width: 420px;
    color: #fff;
  `;

  dialog.innerHTML = `
    <div style="margin-bottom: 16px; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(message)}</div>
    <div style="display: flex; justify-content: flex-end;">
      <button class="alert-ok-btn" style="
        padding: 6px 20px;
        background: #3498db;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
      ">${t('common.confirm') || 'OK'}</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const okBtn = dialog.querySelector('.alert-ok-btn');

  const close = () => {
    if (overlay.parentElement) overlay.remove();
    if (onClose) onClose();
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
