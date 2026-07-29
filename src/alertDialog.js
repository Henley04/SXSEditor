/**
 * 非阻塞的 alert 对话框，替代原生 alert()
 *
 * 原生 alert() 在 Electron 渲染进程中会导致输入框无法聚焦：
 * - alert() 是同步阻塞的，会暂停渲染进程的所有 JavaScript 执行
 * - 弹出的原生模态对话框会从 Electron 窗口"抢走"操作系统焦点
 * - 关闭对话框后，Electron 无法正确将焦点归还给窗口内的输入元素
 */

// W25: use tOr() instead of t() || 'fallback'. t() returns the raw key string
// on a miss (never undefined), so `t(key) || 'fallback'` is dead code that can
// leak raw key names to users. tOr() returns the fallback only on a genuine miss.
import { tOr } from './i18n/index.js';
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
      ">${tOr('common.confirm', 'OK')}</button>
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
        ">${tOr('common.cancel', 'Cancel')}</button>
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
        ">${tOr('common.confirm', 'OK')}</button>
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
 * Show a non-blocking dialog that asks the user which project-level fields
 * to import from a MIDI file (BPM, time signature). Returns a promise that
 * resolves to:
 *   - { applyBpm: bool, applyTimeSig: bool }  — user clicked OK
 *   - null                                       — user clicked Cancel
 *
 * Both checkboxes are checked by default. When the MIDI file does not
 * provide one of the fields, the corresponding checkbox is hidden so the
 * user can only choose to import fields that actually exist.
 *
 * @param {{bpm:number|null, timeSignature:[number,number]|null}} projectInfo
 * @param {{currentBpm:number, currentTimeSignature:[number,number]}} current
 * @returns {Promise<{applyBpm:boolean, applyTimeSig:boolean}|null>}
 */
export function showProjectInfoImportDialog(projectInfo, current) {
  return new Promise((resolve) => {
    const hasBpm = projectInfo.bpm != null;
    const hasTimeSig = projectInfo.timeSignature != null;

    // Nothing to ask about — short-circuit with both flags off.
    if (!hasBpm && !hasTimeSig) {
      resolve(null);
      return;
    }

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
      min-width: 320px;
      max-width: 460px;
      color: var(--fg-primary);
      box-shadow: 0 16px 48px var(--shadow-color-strong), 0 0 40px var(--accent-softer);
      animation: sxs-dialog-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    `;

    const title = tOr('main.midiProjectInfoTitle', 'Import Project Info');
    const desc = tOr('main.midiProjectInfoDesc', 'Select which fields to sync from the MIDI file:');

    const bpmRow = hasBpm ? `
      <label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;">
        <input type="checkbox" id="midi-info-bpm" checked style="cursor:pointer;" />
        <span><strong>${tOr('main.midiProjectInfoBpm', 'BPM')}</strong>: ${escapeHtml(String(projectInfo.bpm))} → ${escapeHtml(String(current.currentBpm))}</span>
      </label>` : '';
    const tsRow = hasTimeSig ? `
      <label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;margin-top:8px;">
        <input type="checkbox" id="midi-info-timesig" checked style="cursor:pointer;" />
        <span><strong>${tOr('main.midiProjectInfoTimeSig', 'Time Signature')}</strong>: ${escapeHtml(projectInfo.timeSignature.join('/'))} → ${escapeHtml(current.currentTimeSignature.join('/'))}</span>
      </label>` : '';

    dialog.innerHTML = `
      <div style="margin-bottom:12px;font-size:15px;font-weight:600;">${escapeHtml(title)}</div>
      <div style="margin-bottom:14px;line-height:1.5;white-space:pre-wrap;color:var(--fg-muted);">${escapeHtml(desc)}</div>
      <div>
        ${bpmRow}
        ${tsRow}
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
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
        ">${tOr('common.cancel', 'Cancel')}</button>
        <button class="confirm-ok-btn" style="
          padding: 6px 20px;
          background: var(--accent, #4a90e2);
          border: none;
          border-radius: 6px;
          clip-path: var(--clip-button, none);
          color: var(--fg-on-accent, #fff);
          cursor: pointer;
          font-weight: 500;
          transition: all 0.15s ease;
        ">${tOr('common.confirm', 'OK')}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    ensureAnimationStyles();

    const okBtn = dialog.querySelector('.confirm-ok-btn');
    const cancelBtn = dialog.querySelector('.confirm-cancel-btn');
    const bpmCheckbox = dialog.querySelector('#midi-info-bpm');
    const tsCheckbox = dialog.querySelector('#midi-info-timesig');

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

    const close = (result) => {
      dialog.style.animation = 'sxs-dialog-exit 0.2s ease forwards';
      overlay.style.animation = 'sxs-overlay-out 0.2s ease forwards';
      setTimeout(() => {
        if (overlay.parentElement) overlay.remove();
        resolve(result);
      }, 200);
    };

    okBtn.addEventListener('click', () => close({
      applyBpm: hasBpm && bpmCheckbox.checked,
      applyTimeSig: hasTimeSig && tsCheckbox.checked,
    }));
    cancelBtn.addEventListener('click', () => close(null));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
    });

    requestAnimationFrame(() => {
      okBtn.focus();
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
