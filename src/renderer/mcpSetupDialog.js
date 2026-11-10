/**
 * 帮助 → 「MCP 连接」对话框。
 *
 * 展示一段可复制的 prompt：里面已经填入按当前安装探测到的真实绝对路径，以及
 * Claude Code / WorkBuddy / OpenCode / Codex 四端各自的配置片段。用户把它粘给
 * 正在使用的 AI 助手，助手就能照着把 MCP 服务器与 skill 装好。
 *
 * 没有复用 createDialog：那个工厂点任何按钮都会无条件关闭弹窗，而「复制」需要
 * 留在原地给出成功/失败反馈 —— 复制失败时如果弹窗消失，用户就丢了整段内容。
 */
import { t, getLocale } from '../i18n/index.js';
import { buildMcpSetupPrompt } from '../shared/mcpSetupPrompt.js';

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

function makeElement(tag, cssText, text) {
  const el = document.createElement(tag);
  if (cssText) el.style.cssText = cssText;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** 打开对话框；返回 close 函数，便于测试与调用方主动收起。 */
export async function showMcpSetupDialog() {
  let info = null;
  try {
    if (window.electronAPI && typeof window.electronAPI.mcpSetupGetInfo === 'function') {
      info = await window.electronAPI.mcpSetupGetInfo();
    }
  } catch (_) {
    info = null;
  }
  const prompt = buildMcpSetupPrompt(info, getLocale());

  const overlay = makeElement('div', [
    'position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
    'background: var(--overlay-scrim);',
    'display: flex; align-items: center; justify-content: center;',
    'z-index: 10000; animation: overlay-fade-in 0.2s ease;',
  ].join(' '));

  const dialog = makeElement('div', [
    'background: var(--bg-elevated);',
    'border: 1px solid var(--border-strong); border-radius: 10px;',
    'padding: 20px; width: min(760px, 92vw);',
    'max-height: 86vh; overflow-y: auto;',
    'color: var(--fg-primary);',
    'box-shadow: 0 12px 40px var(--shadow-color-strong);',
    'animation: dialog-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1);',
  ].join(' '));

  dialog.appendChild(makeElement('div',
    'margin-bottom: 10px; font-weight: 600; font-size: 15px; color: var(--fg-primary);',
    t('mcpSetup.title')));

  const note = info && info.available === false
    ? t('mcpSetup.unavailable')
    : t('mcpSetup.description');
  dialog.appendChild(makeElement('div',
    'margin-bottom: 12px; font-size: 13px; color: var(--fg-muted); line-height: 1.6;',
    note));

  const textarea = makeElement('textarea', [
    'width: 100%; box-sizing: border-box; height: min(46vh, 420px);',
    'resize: vertical; padding: 12px;',
    'background: var(--bg-input, var(--bg-elevated));',
    'color: var(--fg-primary);',
    'border: 1px solid var(--border-strong); border-radius: var(--radius-md);',
    'font-family: ui-monospace, SFMono-Regular, Consolas, monospace;',
    'font-size: 12px; line-height: 1.55; white-space: pre;',
  ].join(' '));
  textarea.readOnly = true;
  textarea.value = prompt;
  textarea.setAttribute('aria-label', t('mcpSetup.title'));
  dialog.appendChild(textarea);

  const feedback = makeElement('div',
    'min-height: 18px; margin-top: 6px; font-size: 12px; color: var(--fg-muted);', '');
  dialog.appendChild(feedback);

  const buttons = makeElement('div',
    'display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;');

  const close = () => {
    if (document.body.contains(overlay)) document.body.removeChild(overlay);
  };

  const copyBtn = makeElement('button', [
    'padding: 6px 16px; background: var(--bg-button-primary); border: none;',
    'border-radius: var(--radius-md); color: var(--fg-on-accent); cursor: pointer;',
  ].join(' '), t('mcpSetup.copy'));
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(prompt, textarea);
    if (ok) {
      copyBtn.textContent = t('mcpSetup.copied');
      feedback.textContent = '';
    } else {
      feedback.textContent = t('mcpSetup.copyFailed');
    }
  });
  buttons.appendChild(copyBtn);

  const closeBtn = makeElement('button', [
    'padding: 6px 16px; background: var(--bg-button);',
    'border: 1px solid var(--button-secondary-border);',
    'border-radius: var(--radius-md); color: var(--fg-primary); cursor: pointer;',
  ].join(' '), t('mcpSetup.close'));
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', close);
  buttons.appendChild(closeBtn);

  dialog.appendChild(buttons);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  textarea.focus();

  return close;
}
