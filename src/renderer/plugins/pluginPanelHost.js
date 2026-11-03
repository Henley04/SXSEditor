/**
 * 插件面板宿主（主窗口侧）。
 *
 * 一个面板 = 一个 `plugin://<pluginId>/<entry>` 的 sandbox iframe，停在窗口右侧的
 * 浮动抽屉里。插件 UI **完全**跑在 iframe 里，宿主页面与插件之间只有 postMessage：
 *
 *   面板 → 宿主   {v:2, id, kind:'req', method, params}
 *   宿主 → 面板   {v:2, id, kind:'res', ok:true, result} | {v:2, id, kind:'res', ok:false, error}
 *   宿主 → 面板   {v:2, kind:'evt', event, payload}
 *   宿主 → 面板   {v:2, kind:'welcome', pluginId, panelId, locale, theme}
 *
 * 隔离的三道闸：
 *   1. iframe 的 sandbox **只有 allow-scripts** —— 不给 allow-same-origin，于是
 *      面板文档是 opaque origin：读不到宿主 DOM、读不到 localStorage、读不到 cookie；
 *   2. 面板的 CSP 由 plugin:// 协议层下发（禁 connect-src、禁外链脚本），插件
 *      连不上网、加载不了远端代码；
 *   3. 每条 RPC 都要过主进程 `panelRpc`，那里按 manifest 声明的 apiScopes 校验
 *      —— 面板声明的能力之外一律 PERMISSION_DENIED。
 *
 * 因此这里**不做**任何权限判断：渲染层判权限等于把锁挂在门框上，插件只要
 * 不通过本文件走 RPC 就绕过了。真正的闸门在主进程。
 */

const RPC_TIMEOUT_MS = 30000;

/** 只允许绝对 URL 且协议为 plugin:。防止伪造 payload 把 iframe 指向远端。 */
function isPluginUrl(url) {
  try {
    return new URL(String(url)).protocol === 'plugin:';
  } catch (_) {
    return false;
  }
}

/**
 * 面板标题兜底解析。
 *
 * 主进程下发前已经按当前语言解析过（见 PluginService.openPanel），正常拿到的是
 * 字符串；这里再兜一层是为了让"以后有别的路径直接把 manifest 里的 title 透传
 * 过来"时不会在抽屉标题上显示 [object Object]。
 */
function panelTitle(payload) {
  const raw = payload && payload.title;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object') {
    const lang = document.documentElement.lang || 'en';
    return raw[lang] || raw[lang.split('-')[0]] || raw.en || Object.values(raw)[0] || payload.panelId;
  }
  return (payload && payload.panelId) || '';
}

function createEl(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * 把宿主当前的主题整理成一组**具体颜色**发给面板。
 *
 * 为什么不是直接发 CSS 变量：面板是 opaque origin，跨不过去 —— `<iframe>` 里的
 * 文档读不到宿主的 `:root` 自定义属性，样式表也不会继承。所以只能由宿主读出来
 * 计算值，作为普通字符串传过去。
 *
 * 只发面板真正需要的几个（背景 / 前景 / 强调色 / 边框 / 明暗），不发全部 200+
 * 个 token：发多了等于把宿主的设计系统固化成一个对外的 ABI。
 */
export function hostTheme() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const scheme = String(cs.getPropertyValue('--color-scheme') || '').trim();
    const mode = scheme.includes('dark') ? 'dark' : (scheme.includes('light') ? 'light' : '');
    return {
      mode,
      bg: cs.getPropertyValue('--bg-app').trim(),
      panel: cs.getPropertyValue('--bg-panel').trim(),
      fg: cs.getPropertyValue('--fg-primary').trim(),
      fgMuted: cs.getPropertyValue('--fg-muted').trim(),
      accent: cs.getPropertyValue('--accent').trim(),
      border: cs.getPropertyValue('--border-default').trim(),
    };
  } catch (_) {
    return {};
  }
}

export function installPluginPanelHost() {
  const api = window.electronAPI?.pluginHost;
  if (!api || typeof api.onOpenPanel !== 'function') return () => {};

  /** @type {null | {pluginId:string, panelId:string, title:string}} */
  let current = null;
  let dock = null;
  let frame = null;
  let titleEl = null;
  let bodyEl = null;

  // ------------------------------------------------------------ DOM

  function ensureDom() {
    if (dock && dock.isConnected) return;
    dock = createEl('aside', 'plugin-panel-dock');
    dock.hidden = true;

    const header = createEl('header', 'plugin-panel-head');
    titleEl = createEl('h2', 'plugin-panel-title');
    header.appendChild(titleEl);

    const close = createEl('button', 'plugin-panel-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'close');
    close.textContent = '×';
    close.addEventListener('click', () => closePanel());
    header.appendChild(close);
    dock.appendChild(header);

    bodyEl = createEl('div', 'plugin-panel-body');
    dock.appendChild(bodyEl);

    document.body.appendChild(dock);
  }

  function teardownFrame() {
    if (frame) {
      try { frame.remove(); } catch (_) { /* ignore */ }
      frame = null;
    }
    if (bodyEl) bodyEl.textContent = '';
    // 抽屉是复用的（关闭时只 hidden），属性必须随面板一起失效。
    // 泄漏探针按 [data-plugin-id] 数残留节点，若这里不清，正常关面板也会被
    // 记成"还留着一个节点"；反过来，若打开时不打标记，残留的 iframe 又数不到。
    if (dock) delete dock.dataset.pluginId;
  }

  // ------------------------------------------------------------ 通信

  function postToPanel(message) {
    if (!frame || !frame.contentWindow) return;
    try {
      // 面板是 opaque origin，targetOrigin 只能是 '*'；对端的可信性由
      // 「event.source === frame.contentWindow」保证（见 onMessage）。
      frame.contentWindow.postMessage(message, '*');
    } catch (_) { /* iframe 正在销毁 */ }
  }

  function withTimeout(promise) {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, error: { code: 'TIMEOUT', message: '宿主响应超时' } }),
        RPC_TIMEOUT_MS,
      );
      Promise.resolve(promise).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => {
          clearTimeout(timer);
          resolve({ ok: false, error: { code: 'INTERNAL', message: (err && err.message) || String(err) } });
        },
      );
    });
  }

  async function handleRequest(data) {
    if (!current) return;
    const id = data.id;
    const method = String(data.method || '');
    if (!method) {
      postToPanel({ v: 2, id, kind: 'res', ok: false, error: { code: 'BAD_REQUEST', message: '缺少 method' } });
      return;
    }
    const target = { pluginId: current.pluginId, panelId: current.panelId };
    const response = await withTimeout(api.panelRpc({
      pluginId: target.pluginId,
      panelId: target.panelId,
      method,
      params: data.params || {},
    }));
    // 等待期间面板可能被关掉/切走：此时不该再往新面板灌旧响应
    if (!current || current.pluginId !== target.pluginId || current.panelId !== target.panelId) return;
    postToPanel({
      v: 2,
      id,
      kind: 'res',
      ok: !!response.ok,
      result: response.result,
      error: response.ok ? undefined : (response.error || { code: 'INTERNAL', message: '调用失败' }),
    });
  }

  function onMessage(event) {
    if (!frame || event.source !== frame.contentWindow) return;
    if (!current) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.v !== 2) return;

    if (data.kind === 'hello') {
      postToPanel({
        v: 2,
        kind: 'welcome',
        pluginId: current.pluginId,
        panelId: current.panelId,
        locale: document.documentElement.lang || 'en',
        theme: hostTheme(),
      });
      return;
    }
    if (data.kind === 'req') {
      if (typeof data.id !== 'number') return;
      // 交给微任务，避免阻塞 message 事件本身
      Promise.resolve().then(() => handleRequest(data));
    }
  }

  // ------------------------------------------------------------ 打开 / 关闭

  function closePanel(options = {}) {
    teardownFrame();
    current = null;
    if (dock) dock.hidden = true;
    if (titleEl) titleEl.textContent = '';
    // 用户主动关面板 → 保留空容器，下次打开省一次 DOM 构建；
    // 插件被卸载/停用/重载 → 连容器一起移除，否则"卸载干净"之后
    // body 里还挂着一个空 <aside>（探针数不到，但肉眼与 DOM 快照看得到）。
    if (options.destroy && dock) {
      try { dock.remove(); } catch (_) { /* ignore */ }
      dock = null;
      titleEl = null;
      bodyEl = null;
    }
  }

  function openPanel(payload) {
    if (!payload || !payload.pluginId || !payload.panelId) return;
    if (!isPluginUrl(payload.url)) {
      console.warn('[plugin-panel] 拒绝非 plugin:// 面板地址:', payload.url);
      return;
    }
    // 已经开着同一个面板 → 只把它顶到前面，不重载（重载会丢掉面板内状态）
    if (current && current.pluginId === payload.pluginId && current.panelId === payload.panelId) {
      if (dock) dock.hidden = false;
      return;
    }

    ensureDom();
    teardownFrame();
    if (dock) dock.hidden = true;

    const title = panelTitle(payload);
    titleEl.textContent = title;

    const iframe = createEl('iframe', 'plugin-panel-frame');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('allow', '');
    iframe.title = title;
    const width = Math.max(280, Math.min(900, Number(payload.width) || 420));
    if (dock) dock.style.setProperty('--plugin-panel-width', `${width}px`);
    iframe.src = payload.url;

    bodyEl.appendChild(iframe);
    frame = iframe;
    // 面板节点带插件归属，卸载时主进程的泄漏探针才数得到（见 PluginLeakProbe）。
    iframe.dataset.pluginId = payload.pluginId;
    if (dock) dock.dataset.pluginId = payload.pluginId;
    current = {
      pluginId: payload.pluginId,
      panelId: payload.panelId,
      title,
    };
    dock.hidden = false;
  }

  // ------------------------------------------------------------ 事件订阅

  const offOpen = api.onOpenPanel((payload) => openPanel(payload));
  window.addEventListener('message', onMessage);

  // 插件被卸载 / 停用 / 重载 → 立刻把面板收掉。
  // 只依赖投影变化，不依赖卸载路径记得通知渲染层 —— 这是"漏了也不会残留"的写法。
  const offSync = typeof api.onSync === 'function'
    ? api.onSync((snapshot) => {
      if (!current) return;
      const alive = (snapshot?.plugins || []).some((p) => (
        p.id === current.pluginId && p.status === 'loaded'
      ));
      if (!alive) closePanel({ destroy: true });
    })
    : null;

  const offEvent = typeof api.onEvent === 'function'
    ? api.onEvent((data) => {
      if (!current || !data || data.pluginId !== current.pluginId) return;
      postToPanel({ v: 2, kind: 'evt', event: data.event, payload: data.payload });
    })
    : null;

  const onTheme = () => {
    postToPanel({ v: 2, kind: 'evt', event: 'theme', payload: hostTheme() });
  };
  window.addEventListener('theme:changed', onTheme);

  return () => {
    closePanel();
    try { offOpen && offOpen(); } catch (_) { /* ignore */ }
    try { offSync && offSync(); } catch (_) { /* ignore */ }
    try { offEvent && offEvent(); } catch (_) { /* ignore */ }
    window.removeEventListener('message', onMessage);
    window.removeEventListener('theme:changed', onTheme);
    if (dock) {
      try { dock.remove(); } catch (_) { /* ignore */ }
      dock = null;
    }
  };
}
