'use strict';
/**
 * 面板侧的宿主桥（自己实现，不依赖任何 SDK）。
 *
 * 只有两个动作：
 *   parent.postMessage({v:2, id, kind:'req', method, params}, '*')   ← 请求
 *   window.onmessage 里认 {v:2, id, kind:'res'}                      ← 回包
 *
 * 为什么 targetOrigin 是 '*'：本页是 sandbox iframe（没有 allow-same-origin），
 * 自己的 origin 是 opaque（"null"），没法用具体 origin 收窄。安全性由宿主侧
 * 的 `event.source === iframe.contentWindow` 保证 —— 反过来这里也校验
 * `event.source === window.parent`。
 */

const out = document.getElementById('out');
let seq = 0;
const pending = new Map();

function log(text) {
  out.textContent = `${new Date().toLocaleTimeString()}  ${text}\n` + out.textContent;
}

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ v: 2, id, kind: 'req', method, params: params || {} }, '*');
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`宿主没有在 15s 内回应 ${method}`));
    }, 15000);
  });
}

window.addEventListener('message', (event) => {
  // 只认自己的父窗口，避免同页面其它 frame 假冒宿主
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== 2) return;

  if (data.kind === 'welcome') {
    applyTheme(data.theme);
    log(`已连接宿主：plugin=${data.pluginId} panel=${data.panelId} locale=${data.locale} theme=${(data.theme && data.theme.mode) || '-'}`);
    return;
  }
  if (data.kind === 'evt') {
    if (data.event === 'theme') applyTheme(data.payload);
    log(`事件 ${data.event}: ${JSON.stringify(data.payload)}`);
    return;
  }
  if (data.kind === 'res') {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(Object.assign(new Error((data.error && data.error.message) || '调用失败'), {
      code: data.error && data.error.code,
    }));
  }
});

/**
 * 跟随宿主主题。宿主把 token 算成具体颜色发过来（面板是 opaque origin，
 * 读不到它的 CSS 变量），这里落到自己的 CSS 变量上。
 */
function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return;
  const map = {
    '--host-bg': theme.bg,
    '--host-panel': theme.panel,
    '--host-fg': theme.fg,
    '--host-fg-muted': theme.fgMuted,
    '--host-accent': theme.accent,
    '--host-border': theme.border,
  };
  const root = document.documentElement;
  for (const [key, value] of Object.entries(map)) {
    if (value) root.style.setProperty(key, value);
  }
  if (theme.mode) root.dataset.mode = theme.mode;
}

/** 按钮统一包一层：禁用 + 落日志，避免连点打出一堆并行 RPC。 */function bind(id, method, buildParams) {
  const btn = document.getElementById(id);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const result = await call(method, buildParams ? buildParams() : {});
      log(`${method} → ${JSON.stringify(result).slice(0, 600)}`);
    } catch (err) {
      log(`${method} 失败：${err.message}${err.code ? ` (${err.code})` : ''}`);
    } finally {
      btn.disabled = false;
    }
  });
}

bind('btnRead', 'project.read');
bind('btnBump', 'project.apply', () => ({ operations: [{ op: 'set_project', value: { bpm: 132 } }] }));
bind('btnCount', 'state.get', () => ({ key: 'greetCount' }));

// 打招呼：告诉宿主"我加载完了"，宿主会回一条 welcome（带 locale / theme）
parent.postMessage({ v: 2, kind: 'hello' }, '*');
