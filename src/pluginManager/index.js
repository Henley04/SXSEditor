import '../common.css';
import './pluginManager.css';
import { t, initI18n, applyLocale } from '../i18n/index.js';
import { initWindowTheme } from '../themes/themeInit.js';
import { formatChordForDisplay } from '../shared/pluginKeys.js';
import { isMac } from '../renderer/platformInfo.js';

/**
 * 插件管理器窗口的渲染层。
 *
 * 原则：
 *   · 这里只读投影（plugin-host:admin），不做任何权限或状态判定 —— 判定全在主进程；
 *   · 插件提供的字符串（name / description / error）一律走 textContent，
 *     绝不拼进 innerHTML。插件包是第三方内容，等同不可信输入；
 *   · 所有监听都收进 cleanups，窗口销毁时统一摘掉（与本窗口生命周期同长，
 *     但仍按项目惯例显式回收，避免以后被复制到长生命周期的地方）。
 */

const api = window.electronAPI?.pluginHost;
const cleanups = [];

const dom = {
  count: document.getElementById('pmCount'),
  install: document.getElementById('pmInstall'),
  reload: document.getElementById('pmReload'),
  openFolder: document.getElementById('pmOpenFolder'),
  tabs: Array.from(document.querySelectorAll('.pm-tab')),
  paneInstalled: document.getElementById('pmPaneInstalled'),
  paneLog: document.getElementById('pmPaneLog'),
  empty: document.getElementById('pmEmpty'),
  list: document.getElementById('pmList'),
  logEmpty: document.getElementById('pmLogEmpty'),
  logTable: document.getElementById('pmLogTable'),
  logBody: document.getElementById('pmLogBody'),
  logCount: document.getElementById('pmLogCount'),
  logRefresh: document.getElementById('pmLogRefresh'),
  toast: document.getElementById('pmToast'),
};

const state = {
  admin: null,
  log: [],
  tab: 'installed',
  /** pluginId → true，表示该卡片的"卸载确认条"正在展开 */
  confirming: new Set(),
  focus: null,
  toastTimer: 0,
};

// ---------------------------------------------------------------- 小工具

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function toast(message, isError) {
  if (!dom.toast) return;
  dom.toast.textContent = message;
  dom.toast.classList.toggle('is-error', !!isError);
  dom.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { dom.toast.hidden = true; }, isError ? 6000 : 3200);
}

function statusLabel(status) {
  switch (status) {
    case 'loaded': return t('plugins.statusLoaded');
    case 'disabled': return t('plugins.statusDisabled');
    case 'quarantined': return t('plugins.statusQuarantined');
    default: return t('plugins.statusError') || status;
  }
}

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function eventLabel(name) {
  const map = {
    install: 'plugins.logEventInstall',
    reload: 'plugins.logEventReload',
    shutdown: 'plugins.logEventShutdown',
    crash: 'plugins.logEventCrash',
    leak: 'plugins.logEventLeak',
    uninstall: 'plugins.logEventUninstall',
    automation: 'plugins.logEventAutomation',
  };
  const key = map[name];
  return key ? t(key) : String(name || '-');
}

// ---------------------------------------------------------------- 渲染

function renderCount() {
  const plugins = state.admin?.plugins || [];
  dom.count.textContent = plugins.length ? t('plugins.count', { n: plugins.length }) : '';
}

function renderPermissionChips(permissions) {
  const wrap = el('div', 'pm-row-value');
  const entries = Object.entries(permissions || {}).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return !!value;
  });
  if (!entries.length) {
    wrap.appendChild(el('span', 'pm-chip', t('plugins.noPermissions')));
    return wrap;
  }
  for (const [key, value] of entries) {
    const label = Array.isArray(value) ? `${key}: ${value.join(', ')}` : key;
    wrap.appendChild(el('span', 'pm-chip', label));
  }
  return wrap;
}

function renderContributions(plugin) {
  const wrap = el('div', 'pm-row-value');
  const chips = [];
  if (plugin.commands?.length) chips.push(t('plugins.contribCommands', { n: plugin.commands.length }));
  if (plugin.panels?.length) chips.push(t('plugins.contribPanels', { n: plugin.panels.length }));
  if (plugin.fileTypes?.length) chips.push(t('plugins.contribFileTypes', { n: plugin.fileTypes.length }));
  if (plugin.settings?.length) chips.push(t('plugins.contribSettings', { n: plugin.settings.length }));
  // M2：界面贡献点只显示数量。管理器不预览按钮/状态栏，给数量是为了让用户
  // 在安装前就能判断"这个插件会往我的顶栏塞多少东西"。
  const ui = plugin.uiContributions || {};
  if (ui.toolbar) chips.push(t('plugins.contribToolbar', { n: ui.toolbar }));
  if (ui.statusBar) chips.push(t('plugins.contribStatusBar', { n: ui.statusBar }));
  if (ui.contextMenus) chips.push(t('plugins.contribContextMenus', { n: ui.contextMenus }));
  if (ui.overlays) chips.push(t('plugins.contribOverlays', { n: ui.overlays }));
  if (!chips.length) {
    wrap.appendChild(el('span', 'pm-chip', t('plugins.noContributions')));
    return wrap;
  }
  for (const chip of chips) wrap.appendChild(el('span', 'pm-chip', chip));
  return wrap;
}

/**
 * 快捷键块：总开关 + 每条组合的状态。
 *
 * 状态文案必须解释"为什么没生效"：只显示一个灰色 chord，用户会以为插件坏了；
 * 写清"与宿主冲突/与某插件冲突"才知道下一步该做什么（关掉另一个插件）。
 */
function renderKeybindings(plugin) {
  const bindings = plugin.keybindings || [];
  if (!bindings.length) return null;

  const box = el('div', 'pm-kb');
  const head = el('div', 'pm-kb-head');
  head.appendChild(el('span', 'pm-row-label', t('plugins.keybindingsSection')));

  const toggleLabel = el('label', 'pm-kb-toggle');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !!plugin.keybindingsEnabled;
  checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;
    const result = await safeCall(() => api.setKeybindings(plugin.id, checkbox.checked));
    checkbox.disabled = false;
    if (result && result.ok === false) {
      toast(t('plugins.keybindingToggleFailed', { error: (result && result.error) || '' }), true);
      checkbox.checked = !checkbox.checked;
    }
    await refresh();
  });
  toggleLabel.appendChild(checkbox);
  toggleLabel.appendChild(document.createTextNode(t('plugins.keybindingsEnable')));
  head.appendChild(toggleLabel);
  box.appendChild(head);
  box.appendChild(el('p', 'pm-note', t('plugins.keybindingsHint')));

  const list = el('div', 'pm-kb-list');
  for (const binding of bindings) {
    const row = el('div', 'pm-kb-row');
    // 规范形里的 Mod 是抽象修饰键，直接印出来用户不知道该按什么
    const key = el('kbd', 'pm-kbd', formatChordForDisplay(binding.chord, isMac));
    row.appendChild(key);

    let statusText = t('plugins.keybindingStatusActive');
    let statusClass = 'is-active';
    if (binding.status === 'disabled') {
      statusText = t('plugins.keybindingStatusDisabled');
      statusClass = 'is-off';
    } else if (binding.status === 'conflict') {
      statusText = binding.reason === 'host'
        ? t('plugins.keybindingConflictHost')
        : t('plugins.keybindingConflictPlugin', { plugins: (binding.conflictWith || []).join(', ') });
      statusClass = 'is-conflict';
    }
    const status = el('span', `pm-kb-status ${statusClass}`, statusText);
    row.appendChild(status);
    row.appendChild(el('span', 'pm-kb-command', binding.command || ''));
    list.appendChild(row);
  }
  box.appendChild(list);
  return box;
}

function renderCard(plugin) {
  const card = el('li', 'pm-card');
  card.dataset.pluginId = plugin.id;
  if (plugin.status !== 'loaded') card.classList.add('is-disabled');

  // ---- 头部
  const head = el('div', 'pm-card-head');
  const titles = el('div', 'pm-card-titles');

  const nameRow = el('h2', 'pm-card-name');
  nameRow.appendChild(document.createTextNode(plugin.name || plugin.id));
  const badge = el('span', 'pm-badge', statusLabel(plugin.status));
  badge.classList.add(`is-${plugin.status}`);
  nameRow.appendChild(badge);
  titles.appendChild(nameRow);

  const meta = el('div', 'pm-card-meta');
  const metaParts = [`${plugin.id}`, `v${plugin.version}`];
  if (plugin.apiVersion) metaParts.push(`api ${plugin.apiVersion}`);
  if (plugin.author) metaParts.push(plugin.author);
  meta.textContent = metaParts.join(' · ');
  titles.appendChild(meta);
  head.appendChild(titles);

  // ---- 操作
  const actions = el('div', 'pm-card-actions');
  // 以状态为准：state.enabled 是磁盘上的开关，status 是这次运行的真实结果，
  // 两者不一致时（例如上一次停用只改了磁盘）按 status 走，否则按钮会永远停在
  // "停用"上，用户没法把插件重新打开。
  const enabled = plugin.status !== 'disabled' && plugin.status !== 'quarantined'
    && plugin.state?.enabled !== false;

  const toggle = el('button', 'pm-btn', enabled ? t('plugins.disable') : t('plugins.enable'));
  toggle.type = 'button';
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    const result = await safeCall(() => api.setEnabled(plugin.id, !enabled));
    toggle.disabled = false;
    if (result && result.ok === false) toast(result.error || t('plugins.actionFailed', { error: '' }), true);
    await refresh();
  });
  actions.appendChild(toggle);

  const remove = el('button', 'pm-btn pm-btn-danger', t('plugins.uninstall'));
  remove.type = 'button';
  remove.addEventListener('click', () => {
    state.confirming.add(plugin.id);
    render();
  });
  actions.appendChild(remove);
  head.appendChild(actions);
  card.appendChild(head);

  // ---- 描述
  if (plugin.description) {
    card.appendChild(el('p', 'pm-card-desc', plugin.description));
  }

  // ---- 卸载确认条
  if (state.confirming.has(plugin.id)) {
    const bar = el('div', 'pm-card-body');
    bar.appendChild(el('p', 'pm-note', t('plugins.uninstallConfirmDetail')));
    const row = el('div', 'pm-card-actions');
    // 两个按钮语义不同：默认删数据，`keep` 保留数据目录
    const confirm = el('button', 'pm-btn pm-btn-danger', t('plugins.uninstall'));
    confirm.type = 'button';
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      const name = plugin.name || plugin.id;
      const result = await safeCall(() => api.uninstall(plugin.id, false));
      state.confirming.delete(plugin.id);
      if (result && result.ok) toast(t('plugins.uninstalled', { name }));
      else toast(t('plugins.uninstallFailed', { error: (result && result.error) || '' }), true);
      await refresh();
    });
    const keep = el('button', 'pm-btn', t('plugins.uninstallKeepData'));
    keep.type = 'button';
    keep.title = t('plugins.uninstallConfirmKeep');
    keep.addEventListener('click', async () => {
      keep.disabled = true;
      const name = plugin.name || plugin.id;
      const result = await safeCall(() => api.uninstall(plugin.id, true));
      state.confirming.delete(plugin.id);
      if (result && result.ok) toast(t('plugins.uninstalled', { name }));
      else toast(t('plugins.uninstallFailed', { error: (result && result.error) || '' }), true);
      await refresh();
    });
    const cancel = el('button', 'pm-btn', t('common.cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      state.confirming.delete(plugin.id);
      render();
    });
    row.appendChild(confirm);
    row.appendChild(keep);
    row.appendChild(cancel);
    bar.appendChild(row);
    card.appendChild(bar);
    return card;
  }

  // ---- 明细
  const body = el('div', 'pm-card-body');

  const contribRow = el('div', 'pm-row');
  contribRow.appendChild(el('span', 'pm-row-label', t('plugins.sectionContributions')));
  contribRow.appendChild(renderContributions(plugin));
  body.appendChild(contribRow);

  const permRow = el('div', 'pm-row');
  permRow.appendChild(el('span', 'pm-row-label', t('plugins.sectionPermissions')));
  permRow.appendChild(renderPermissionChips(plugin.permissions));
  body.appendChild(permRow);

  const runtimeRow = el('div', 'pm-row');
  runtimeRow.appendChild(el('span', 'pm-row-label', t('plugins.sectionDetails')));
  const runtimeValue = el('div', 'pm-row-value');
  runtimeValue.appendChild(el('span', 'pm-chip', plugin.runtimeAlive ? t('plugins.runtimeAlive') : t('plugins.runtimeIdle')));
  runtimeValue.appendChild(el('span', 'pm-chip', plugin.dir || ''));
  runtimeRow.appendChild(runtimeValue);
  body.appendChild(runtimeRow);

  const keybindingBox = renderKeybindings(plugin);
  if (keybindingBox) body.appendChild(keybindingBox);

  if (plugin.pendingContributions?.length) {
    body.appendChild(el('p', 'pm-note', t('plugins.pendingContributions', { list: plugin.pendingContributions.join(', ') })));
  }

  if (plugin.error) {
    body.appendChild(el('p', 'pm-note pm-note-error', plugin.error));
  }

  // 有命令的插件才提示自动化外露：没有命令的插件没什么可被外部调用
  if (plugin.commands?.length) {
    body.appendChild(el('p', 'pm-note', t('plugins.automationNote')));
  }

  card.appendChild(body);
  return card;
}

function renderInstalled() {
  const plugins = state.admin?.plugins || [];
  dom.list.textContent = '';
  dom.empty.hidden = plugins.length > 0;

  for (const plugin of plugins) {
    dom.list.appendChild(renderCard(plugin));
  }

  if (state.focus) {
    const target = dom.list.querySelector(`[data-plugin-id="${CSS.escape(state.focus)}"]`);
    if (target) {
      target.scrollIntoView({ block: 'nearest' });
      target.classList.add('is-focused');
      setTimeout(() => target.classList.remove('is-focused'), 1200);
    }
    state.focus = null;
  }
  renderCount();
}

function renderLog() {
  const rows = state.log || [];
  dom.logBody.textContent = '';
  dom.logEmpty.hidden = rows.length > 0;
  dom.logTable.hidden = rows.length === 0;
  dom.logCount.textContent = rows.length ? String(rows.length) : '';

  for (const entry of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', '', formatTime(entry.time || entry.ts)));
    tr.appendChild(el('td', '', eventLabel(entry.event)));
    tr.appendChild(el('td', '', entry.pluginId || '-'));
    const detail = entry.detail === undefined || entry.detail === null
      ? ''
      : (typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail));
    tr.appendChild(el('td', 'pm-log-detail', detail));
    dom.logBody.appendChild(tr);
  }
}

function render() {
  dom.paneInstalled.classList.toggle('pm-pane-hidden', state.tab !== 'installed');
  dom.paneLog.classList.toggle('pm-pane-hidden', state.tab !== 'log');
  for (const tab of dom.tabs) {
    const active = tab.dataset.tab === state.tab;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (state.tab === 'installed') renderInstalled();
  else renderLog();
}

// ---------------------------------------------------------------- 数据

async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(t('plugins.actionFailed', { error: (err && err.message) || String(err) }), true);
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function refresh() {
  if (!api) return;
  try {
    state.admin = await api.admin();
  } catch (err) {
    console.warn('[plugin-manager] 读取插件列表失败:', err && err.message);
    return;
  }
  render();
}

async function refreshLog() {
  if (!api) return;
  try {
    state.log = await api.getLog(200);
  } catch (err) {
    console.warn('[plugin-manager] 读取日志失败:', err && err.message);
    state.log = [];
  }
  if (state.tab === 'log') renderLog();
}

function setTab(tab) {
  state.tab = tab === 'log' ? 'log' : 'installed';
  render();
  if (state.tab === 'log') refreshLog();
}

// ---------------------------------------------------------------- 接线

function installHandlers() {
  dom.install.addEventListener('click', async () => {
    dom.install.disabled = true;
    const result = await safeCall(() => api.install());
    dom.install.disabled = false;
    if (!result) return;
    if (result.canceled) return;
    if (result.ok) toast(t('plugins.installDone', { name: result.id || '' }));
    else toast(t('plugins.installFailed', { error: result.error || '' }), true);
    await refresh();
  });

  dom.reload.addEventListener('click', async () => {
    dom.reload.disabled = true;
    const result = await safeCall(() => api.reload());
    dom.reload.disabled = false;
    if (result && result.ok) toast(t('plugins.reloadDone', { n: result.stats?.plugins ?? 0 }));
    else toast(t('plugins.actionFailed', { error: (result && result.error) || '' }), true);
    await refresh();
  });

  dom.openFolder.addEventListener('click', () => { safeCall(() => api.openPluginsFolder()); });

  dom.logRefresh.addEventListener('click', () => { refreshLog(); });

  for (const tab of dom.tabs) {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  }

  // 主进程每次投影变化都会推一次 sync；管理器只需重新拉一遍 admin（含状态细节）
  const offSync = api.onSync(() => { refresh(); });
  if (typeof offSync === 'function') cleanups.push(offSync);

  // 主进程对已存在的窗口用自定义事件下发参数（tab / focus），见 windowManager
  const onParams = (event) => {
    const detail = (event && event.detail) || {};
    if (detail.tab) setTab(detail.tab);
    if (detail.focus) {
      state.focus = detail.focus;
      if (state.tab !== 'installed') setTab('installed');
      else renderInstalled();
    }
  };
  window.addEventListener('plugin-manager:params', onParams);
  cleanups.push(() => window.removeEventListener('plugin-manager:params', onParams));

  // 语言在管理器打开期间被切换（设置窗口改语言）→ 重画，保持文案一致
  const onLocale = () => { applyLocale(); render(); };
  document.addEventListener('localeChanged', onLocale);
  cleanups.push(() => document.removeEventListener('localeChanged', onLocale));

  window.addEventListener('beforeunload', () => {
    for (const off of cleanups.splice(0)) {
      try { off(); } catch (_) { /* ignore */ }
    }
  });
}

function readHashParams() {
  const out = {};
  try {
    const hash = String(location.hash || '').replace(/^#/, '');
    if (!hash) return out;
    for (const [key, value] of new URLSearchParams(hash)) out[key] = value;
  } catch (_) { /* ignore */ }
  return out;
}

async function boot() {
  try {
    await initI18n();
    applyLocale();
  } catch (err) {
    console.warn('[plugin-manager] i18n 初始化失败:', err && err.message);
  }

  try {
    await initWindowTheme(cleanups);
  } catch (err) {
    console.warn('[plugin-manager] 主题初始化失败:', err && err.message);
  }

  if (!api) {
    dom.empty.hidden = false;
    const title = dom.empty.querySelector('.pm-empty-title');
    if (title) title.textContent = t('plugins.actionFailed', { error: 'pluginHost 不可用' });
    return;
  }

  installHandlers();

  const params = readHashParams();
  if (params.focus) state.focus = params.focus;
  state.tab = params.tab === 'log' ? 'log' : 'installed';

  await refresh();
  if (state.tab === 'log') await refreshLog();
  render();
}

boot();
