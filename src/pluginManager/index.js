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
  paneSecurity: document.getElementById('pmPaneSecurity'),
  paneLog: document.getElementById('pmPaneLog'),
  empty: document.getElementById('pmEmpty'),
  list: document.getElementById('pmList'),
  logEmpty: document.getElementById('pmLogEmpty'),
  logTable: document.getElementById('pmLogTable'),
  logBody: document.getElementById('pmLogBody'),
  logCount: document.getElementById('pmLogCount'),
  logRefresh: document.getElementById('pmLogRefresh'),
  toast: document.getElementById('pmToast'),
  // ---- M6：签名与信任 ----
  requireSignature: document.getElementById('pmRequireSignature'),
  keyList: document.getElementById('pmKeyList'),
  trustBanner: document.getElementById('pmTrustBanner'),
  trustBannerTitle: document.getElementById('pmTrustBannerTitle'),
  trustBannerSub: document.getElementById('pmTrustBannerSub'),
  trustAccept: document.getElementById('pmTrustAccept'),
  trustCancel: document.getElementById('pmTrustCancel'),
};

const state = {
  admin: null,
  log: [],
  tab: 'installed',
  /** pluginId → true，表示该卡片的"卸载确认条"正在展开 */
  confirming: new Set(),
  focus: null,
  /**
   * 渲染后要把键盘焦点放回哪里。
   *
   * 列表每次刷新都是整段重建（textContent = '' 再 appendChild），点掉的按钮
   * 已经不在文档里，焦点会掉到 body —— 键盘用户的下一 Tab 从页面开头重数。
   * 形如 `{ pluginId, action, wait? }`，action 指的是"重建后应该落在哪个按钮上"：
   * · 'cancel'  展开确认条 → 进确认条，落在最不危险的那个按钮；
   * · 'remove'  取消确认 / 卸载失败 → 回该卡的卸载按钮；
   * · 'toggle'  信任并安装成功 → 落在新卡片的停用按钮（wait 等卡片出现）；
   * · 'install' 没有卡片可落 → 回"安装插件…"。
   */
  restoreFocus: null,
  toastTimer: 0,
  /**
   * 待确认的"签名有效但密钥未知"的安装。
   * 形如 `{ packagePath, pendingKey: { keyId, publicKey, publisher } }`。
   * 不落盘：这是一个交互状态，用户不点就等于没发生。
   */
  pendingTrust: null,
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
    // degraded = 装了、启用了，但缺依赖服务。它不等于"异常"：插件本身没坏，
    // 只是它的前提不在了。用"异常"会让用户去查插件日志，方向完全错。
    case 'degraded': return t('plugins.statusDegraded');
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

/**
 * 审计事件名 → 界面文案。
 *
 * 这张表曾经只覆盖 M1 的 7 个事件，M6 新增的 `install-rejected` / `trust-add` /
 * `market-*` 全部漏在外面：日志里一半中文一半英文码，而"安装被拒"恰恰是用户
 * 最需要读懂的一条。没映射的名字仍然原样显示 —— 宁可露出原始码，也不要假装
 * 认识它而显示成空白。
 */
function eventLabel(name) {
  const map = {
    install: 'plugins.logEventInstall',
    'install-rejected': 'plugins.logEventInstallRejected',
    uninstall: 'plugins.logEventUninstall',
    reload: 'plugins.logEventReload',
    shutdown: 'plugins.logEventShutdown',
    crash: 'plugins.logEventCrash',
    leak: 'plugins.logEventLeak',
    automation: 'plugins.logEventAutomation',
    verify: 'plugins.logEventVerify',
    'trust-add': 'plugins.logEventTrustAdd',
    'trust-remove': 'plugins.logEventTrustRemove',
    'trust-policy': 'plugins.logEventTrustPolicy',
    'market-source-add': 'plugins.logEventMarketSourceAdd',
    'market-source-remove': 'plugins.logEventMarketSourceRemove',
    'market-download': 'plugins.logEventMarketDownload',
    'market-preview': 'plugins.logEventMarketPreview',
    'market-install': 'plugins.logEventMarketInstall',
    'trust-update': 'plugins.logEventTrustUpdate',
    'plugin-install': 'plugins.logEventPluginInstall',
    'plugin-self-update': 'plugins.logEventPluginSelfUpdate',
    'plugin-cycle': 'plugins.logEventPluginCycle',
    'service-gone': 'plugins.logEventServiceGone',
    'panel-open': 'plugins.logEventPanelOpen',
    'file-open': 'plugins.logEventFileOpen',
    'file-save': 'plugins.logEventFileSave',
    'audio-export': 'plugins.logEventAudioExport',
    'service-denied': 'plugins.logEventServiceDenied',
    'service-conflict': 'plugins.logEventServiceConflict',
    'service-cycle': 'plugins.logEventServiceCycle',
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

/**
 * 签名行：这个包是谁签的、什么时候验的、还能不能重新核一遍。
 *
 * 只显示"安装时验过"而不是"现在是好的"：文件在磁盘上可能早被改过，
 * 说成"已签名"会给人一个它没承诺过的保证。想确认就点"重新校验"。
 */
function renderSignature(plugin) {
  const row = el('div', 'pm-row');
  row.appendChild(el('span', 'pm-row-label', t('plugins.sectionSignature')));

  const value = el('div', 'pm-row-value');
  const sig = plugin.state?.signature || null;
  const verified = sig && sig.status === 'verified';
  const chip = el('span', `pm-chip pm-sig ${verified ? 'is-verified' : 'is-unsigned'}`,
    verified
      ? t('plugins.sigVerified', { who: sig.publisher || sig.keyId || '' })
      : t('plugins.sigUnsigned'));
  value.appendChild(chip);

  if (verified && sig.keyId) {
    const detail = el('span', 'pm-chip', sig.keyId);
    detail.title = sig.keyId;
    value.appendChild(detail);
  }

  // 文件夹安装没有清单可核对，按钮只会给一句"没有可比对的清单"，不出现在这里。
  if (plugin.state?.source === 'package') {
    const verify = el('button', 'pm-btn pm-btn-small', t('plugins.verifyInstall'));
    verify.type = 'button';
    verify.addEventListener('click', async () => {
      verify.disabled = true;
      const result = await safeCall(() => api.verifyInstall(plugin.id));
      verify.disabled = false;
      if (!result) return;
      if (result.status === 'unrecorded') toast(result.message || '');
      else if (result.ok) toast(t('plugins.verifyOk'));
      else toast(t('plugins.verifyModified', { n: (result.mismatched?.length || 0) + (result.missing?.length || 0) }), true);
    });
    value.appendChild(verify);
  }

  row.appendChild(value);
  return row;
}

/**
 * 自动化块：开关 + 说明 + 这个插件实际暴露的方法名。
 *
 * 列出方法名而不是只给一个开关，是因为用户要判断的正是"哪个能力被外面看见了"。
 * 只写"允许外部自动化调用"的话，用户面对的是一个抽象承诺，只能凭信任点下去。
 */
function renderAutomation(plugin) {
  const box = el('div', 'pm-kb');
  const head = el('div', 'pm-kb-head');
  head.appendChild(el('span', 'pm-row-label', t('plugins.automationLabel')));

  const enabled = plugin.state ? plugin.state.automationExpose !== false : true;
  const toggleLabel = el('label', 'pm-kb-toggle');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = enabled;
  checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;
    const result = await safeCall(() => api.setAutomation(plugin.id, checkbox.checked));
    checkbox.disabled = false;
    if (result && result.ok === false) {
      toast(t('plugins.automationToggleFailed', { error: (result && result.error) || '' }), true);
      checkbox.checked = !checkbox.checked;
    }
    await refresh();
  });
  toggleLabel.appendChild(checkbox);
  toggleLabel.appendChild(document.createTextNode(t('plugins.automationToggle')));
  head.appendChild(toggleLabel);
  box.appendChild(head);

  const methods = plugin.automationMethods || [];
  if (methods.length) {
    const list = el('div', 'pm-auto-list');
    for (const localId of methods) {
      const row = el('div', 'pm-auto-row');
      row.appendChild(el('code', 'pm-auto-method', `${plugin.id}.${localId}`));
      row.appendChild(el(
        'span',
        `pm-auto-status ${enabled ? 'is-on' : 'is-off'}`,
        enabled ? t('plugins.automationStatusOn') : t('plugins.automationStatusOff'),
      ));
      list.appendChild(row);
    }
    box.appendChild(list);
  } else {
    box.appendChild(el('p', 'pm-note', t('plugins.automationNoneDeclared')));
  }

  box.appendChild(el('p', 'pm-note', t('plugins.automationNote')));
  return box;
}

/**
 * 跨插件服务块：我提供什么、我依赖谁、依赖现在满不满足。
 *
 * 依赖状态必须是**实时解析结果**而不是 manifest 里的字面量：用户卸载提供方
 * 之后，这里要立刻变成"不可用"，否则管理器会承诺一个已经不存在的端点。
 */
function renderServices(plugin) {
  const svc = plugin.services;
  if (!svc || (!(svc.provides || []).length && !(svc.consumes || []).length)) return null;

  const box = el('div', 'pm-kb');
  const head = el('div', 'pm-kb-head');
  head.appendChild(el('span', 'pm-row-label', t('plugins.servicesLabel')));
  box.appendChild(head);

  for (const p of svc.provides || []) {
    const row = el('div', 'pm-auto-row');
    row.appendChild(el('code', 'pm-auto-method', p.id));
    row.appendChild(el(
      'span',
      `pm-auto-status ${p.active ? 'is-on' : 'is-off'}`,
      p.active
        ? t('plugins.serviceProviding', { version: p.version })
        : t('plugins.serviceConflict', { plugin: p.spokenFor || '?' }),
    ));
    box.appendChild(row);
    if ((p.methods || []).length) {
      box.appendChild(el('p', 'pm-note', `${t('plugins.servicesProvides')}: ${p.methods.join(' · ')}`));
    }
  }

  for (const c of svc.consumes || []) {
    const row = el('div', 'pm-auto-row');
    row.appendChild(el('code', 'pm-auto-method', `${c.id} ${c.range}`));
    row.appendChild(el(
      'span',
      `pm-auto-status ${c.available ? 'is-on' : 'is-off'}`,
      c.available
        ? t('plugins.serviceConsumed', { plugin: c.provider, version: c.version })
        : t('plugins.serviceMissing', { reason: c.message || c.reason || '' }),
    ));
    box.appendChild(row);
    if (c.optional) box.appendChild(el('p', 'pm-note', t('plugins.serviceOptional')));
  }

  box.appendChild(el('p', 'pm-note', t('plugins.servicesNote')));
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
  toggle.dataset.act = 'toggle';
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
  remove.dataset.act = 'remove';
  remove.addEventListener('click', () => {
    state.confirming.add(plugin.id);
    // 展开确认条之后，"卸载"按钮被替换掉了；焦点必须主动挪进确认条，
    // 否则它落在 body 上，键盘用户要靠 Tab 从头找。
    state.restoreFocus = { pluginId: plugin.id, action: 'cancel' };
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
    confirm.dataset.act = 'confirm';
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      const name = plugin.name || plugin.id;
      const result = await safeCall(() => api.uninstall(plugin.id, false));
      state.confirming.delete(plugin.id);
      // 成功时卡片会消失，由 renderInstalled 的兜底把焦点收到列表里；
      // 失败时卡片还在，回到那一条的卸载按钮上。
      state.restoreFocus = { pluginId: plugin.id, action: 'remove' };
      if (result && result.ok) toast(t('plugins.uninstalled', { name }));
      else toast(t('plugins.uninstallFailed', { error: (result && result.error) || '' }), true);
      await refresh();
    });
    const keep = el('button', 'pm-btn', t('plugins.uninstallKeepData'));
    keep.type = 'button';
    keep.dataset.act = 'keep';
    keep.title = t('plugins.uninstallConfirmKeep');
    keep.addEventListener('click', async () => {
      keep.disabled = true;
      const name = plugin.name || plugin.id;
      const result = await safeCall(() => api.uninstall(plugin.id, true));
      state.confirming.delete(plugin.id);
      state.restoreFocus = { pluginId: plugin.id, action: 'remove' };
      if (result && result.ok) toast(t('plugins.uninstalled', { name }));
      else toast(t('plugins.uninstallFailed', { error: (result && result.error) || '' }), true);
      await refresh();
    });
    const cancel = el('button', 'pm-btn', t('common.cancel'));
    cancel.type = 'button';
    cancel.dataset.act = 'cancel';
    cancel.addEventListener('click', () => {
      state.confirming.delete(plugin.id);
      state.restoreFocus = { pluginId: plugin.id, action: 'remove' };
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

  body.appendChild(renderSignature(plugin));

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
    body.appendChild(renderAutomation(plugin));
  }

  const serviceBox = renderServices(plugin);
  if (serviceBox) body.appendChild(serviceBox);

  card.appendChild(body);
  return card;
}

function renderInstalled() {
  const plugins = state.admin?.plugins || [];
  // 列表是整段重建的：每次 refresh（主进程一推 sync 就一次）都会把卡片节点
  // 全部换掉，正在聚焦的那个按钮随之消失，焦点掉到 body。
  // 所以在清空之前先记下"焦点在哪个卡的哪个按钮上"，重建完再放回去。
  // 显式设置的 state.restoreFocus 优先（它可能是刚装好、还没渲染出来的卡）。
  const keepFocus = state.restoreFocus ? null : snapshotCardFocus();
  dom.list.textContent = '';
  dom.empty.hidden = plugins.length > 0;

  for (const plugin of plugins) {
    dom.list.appendChild(renderCard(plugin));
  }
  if (keepFocus) state.restoreFocus = keepFocus;
  applyRestoreFocus();

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

/**
 * 读当前焦点落在哪张卡的哪个按钮上（`data-act`）。
 * 不在列表里、或不是卡片按钮 → null，不做任何"归还"。
 */
function snapshotCardFocus() {
  const active = document.activeElement;
  if (!active || !dom.list.contains(active) || !active.dataset || !active.dataset.act) return null;
  const card = active.closest('.pm-card');
  return { pluginId: (card && card.dataset.pluginId) || '', action: active.dataset.act, wait: true };
}

/**
 * 把键盘焦点还给"重建前它该在的地方"。
 *
 * 三种来源：两段式卸载确认的转折点、信任横幅关闭、列表重建前的快照
 * （见 build 前的 snapshotCardFocus）。目标卡片不存在时退而求其次落到列表首项，
 * 列表空了则落到空态上 —— 目的只有一个：焦点不落在 body，下一 Tab 不从页面开头数。
 */
function applyRestoreFocus() {
  const want = state.restoreFocus;
  if (!want) return;

  if (want.action === 'install') {
    state.restoreFocus = null;
    if (dom.install) dom.install.focus();
    return;
  }

  const card = dom.list.querySelector(`[data-plugin-id="${CSS.escape(want.pluginId)}"]`);
  const target = card && card.querySelector(`[data-act="${want.action}"]`);
  if (target) {
    state.restoreFocus = null;
    target.focus();
    return;
  }

  // `wait` 用于"卡片还没渲染出来"：安装是异步的，中途会有几次 sync 触发的
  // 重绘，早于新卡片出现的 render 不应该把意图吃掉 —— 否则等到卡片真的出现，
  // 已经没有东西可聚焦了。给 5 次机会就够（实测 1~2 次），到点仍找不到就
  // 当卡片不存在，按兜底走，避免一个坏 id 让标志位永远挂着。
  if (want.wait) {
    want.tries = (want.tries || 0) + 1;
    if (want.tries < 5) return;
  }
  state.restoreFocus = null;

  const first = dom.list.querySelector('[data-act="toggle"]');
  if (first) {
    first.focus();
    return;
  }
  if (dom.empty && !dom.empty.hidden) {
    dom.empty.tabIndex = -1;
    dom.empty.focus();
  }
}

/**
 * 安全页：策略 + 信任的密钥。
 *
 * 这一页存在的理由：安装失败时用户看到的是"密钥不在信任列表里"，
 * 如果没有一个地方能看见/删除信任列表，那条错误就只是一堵墙。
 */
function renderSecurity() {
  const trust = state.admin?.trust || { requireSignature: false, keys: [] };
  dom.requireSignature.checked = !!trust.requireSignature;
  dom.keyList.textContent = '';

  if (!trust.keys.length) {
    const empty = el('li', 'pm-key-empty', t('plugins.trustedKeysEmpty'));
    dom.keyList.appendChild(empty);
    return;
  }

  for (const key of trust.keys) {
    const li = el('li', 'pm-key');
    const info = el('div', 'pm-key-info');
    info.appendChild(el('span', 'pm-key-name', key.name || t('plugins.keyUnnamed')));
    // 指纹单独一行：用户核对的就是它，不能和名字混在一行被跳过
    const fp = el('span', 'pm-key-fp', key.fingerprint || key.keyId);
    fp.title = key.keyId;
    info.appendChild(fp);
    li.appendChild(info);

    const remove = el('button', 'pm-btn pm-btn-small pm-btn-danger', t('plugins.keyRemove'));
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      const result = await safeCall(() => api.trustRemove(key.keyId));
      remove.disabled = false;
      if (result && result.ok) toast(t('plugins.keyRemoved'));
      else toast(t('plugins.actionFailed', { error: (result && result.error) || '' }), true);
      await refresh();
    });
    li.appendChild(remove);
    dom.keyList.appendChild(li);
  }
}

function renderTrustBanner() {
  const pending = state.pendingTrust;
  if (!pending) {
    dom.trustBanner.hidden = true;
    return;
  }
  const who = pending.pendingKey.publisher || t('plugins.keyUnnamed');
  dom.trustBannerTitle.textContent = t('plugins.trustBannerTitle', { who });
  dom.trustBannerSub.textContent = t('plugins.trustBannerSub', {
    keyId: pending.pendingKey.keyId,
    file: pending.packagePath.split(/[\\/]/).pop() || pending.packagePath,
  });
  // 只在"从隐藏到出现"这一下抢焦点。renderTrustBanner 每次刷新都会调，
  // 每次都 focus 会把用户正在读列表的焦点反复拽回来。
  const wasHidden = dom.trustBanner.hidden;
  dom.trustBanner.hidden = false;
  if (wasHidden) {
    // 焦点落在横幅本身（tabindex=-1），读屏会把标题与指纹一起念出来，
    // 然后用户按 Tab 进到"信任并安装/取消"。不默认聚焦按钮：
    // 这会诱导用户直接按回车放行一把陌生密钥。
    try { dom.trustBanner.focus(); } catch (_) { /* 已隐藏 */ }
  }
}

async function acceptPendingTrust() {
  const pending = state.pendingTrust;
  if (!pending) return;
  dom.trustAccept.disabled = true;
  const added = await safeCall(() => api.trustAdd({
    publicKey: pending.pendingKey.publicKey,
    name: pending.pendingKey.publisher || '',
  }));
  if (added && added.ok) {
    const retry = await safeCall(() => api.installFromPath(pending.packagePath));
    if (retry && retry.ok) {
      state.pendingTrust = null;
      // 横幅一藏，焦点就落在 body 上（按钮跟着一起藏了）。把焦点交给刚装好的
      // 那张卡，同时让它闪一下 —— 用户既知道装成了，也知道装到哪去了。
      state.focus = retry.id || null;
      state.restoreFocus = { pluginId: retry.id || '', action: 'toggle', wait: true };
      renderTrustBanner();
      toast(t('plugins.installDone', { name: retry.id || '' }));
    } else {
      // 信任成功但安装仍失败：多半是包本身有问题（签名损坏/清单不一致），
      // 这时不该把 banner 留在"信任并安装"上，会让用户反复点。
      state.pendingTrust = null;
      state.restoreFocus = { pluginId: '', action: 'install' };
      renderTrustBanner();
      toast(t('plugins.installFailed', { error: (retry && retry.error) || '' }), true);
    }
  } else {
    toast(t('plugins.trustFailed', { error: (added && added.error) || '' }), true);
  }
  dom.trustAccept.disabled = false;
  await refresh();
}

/**
 * 安装结果的统一出口。
 *
 * "签名有效但密钥未知"不是失败，是一次待决定：留在 banner 里让用户看着指纹选，
 * 而不是把包丢掉再让他重新找一遍文件。
 */
async function handleInstallResult(result) {
  if (!result || result.canceled) return;
  if (result.ok) {
    toast(t('plugins.installDone', { name: result.id || '' }));
    await refresh();
    return;
  }
  if (result.pendingKey && result.packagePath) {
    state.pendingTrust = { packagePath: result.packagePath, pendingKey: result.pendingKey };
    renderTrustBanner();
    return;
  }
  toast(t('plugins.installFailed', { error: result.error || '' }), true);
  await refresh();
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
  dom.paneSecurity.classList.toggle('pm-pane-hidden', state.tab !== 'security');
  dom.paneLog.classList.toggle('pm-pane-hidden', state.tab !== 'log');
  for (const tab of dom.tabs) {
    const active = tab.dataset.tab === state.tab;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    // roving tabindex：整组只占一个 Tab 位，组内靠方向键移动。
    tab.tabIndex = active ? 0 : -1;
  }
  if (state.tab === 'installed') renderInstalled();
  else if (state.tab === 'security') renderSecurity();
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
  state.tab = tab === 'log' || tab === 'security' ? tab : 'installed';
  render();
  if (state.tab === 'log') refreshLog();
}

/**
 * tablist 的键盘语义（WAI-ARIA tabs，自动激活）。
 *
 * ←/→ 在组内移动并**立刻**切换，Home/End 跳到首尾。为什么用自动激活而不是
 * "先移动、回车再切"：这三个面板都是本地即时视图，切换没有副作用（不发请求、
 * 不丢草稿），多一次回车只会让键盘用户更累。
 */
function onTabKeydown(event) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const tabs = dom.tabs;
  const current = tabs.indexOf(event.currentTarget);
  if (current === -1) return;
  event.preventDefault();

  let next = current;
  if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else next = tabs.length - 1;

  const target = tabs[next];
  if (!target) return;
  setTab(target.dataset.tab);
  // 焦点跟着选中项走：否则 roving tabindex 把 tabindex 挪到新项之后，
  // 焦点留在一个 tabindex=-1 的旧项上，下一次 Tab 会从奇怪的位置继续。
  target.focus();
}

// ---------------------------------------------------------------- 接线

function installHandlers() {
  dom.install.addEventListener('click', async () => {
    dom.install.disabled = true;
    const result = await safeCall(() => api.install());
    dom.install.disabled = false;
    await handleInstallResult(result);
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

  dom.requireSignature.addEventListener('change', async () => {
    dom.requireSignature.disabled = true;
    const result = await safeCall(() => api.setRequireSignature(dom.requireSignature.checked));
    dom.requireSignature.disabled = false;
    if (result && result.ok) toast(t('plugins.requireSignatureSaved'));
    else {
      dom.requireSignature.checked = !dom.requireSignature.checked;
      toast(t('plugins.actionFailed', { error: (result && result.error) || '' }), true);
    }
  });

  dom.trustAccept.addEventListener('click', () => { acceptPendingTrust(); });
  dom.trustCancel.addEventListener('click', () => {
    state.pendingTrust = null;
    // 取消之后不会重新渲染，焦点必须在藏起横幅之前先交出去，
    // 否则它跟着按钮一起消失，落到 body 上。
    const hadFocus = dom.trustBanner.contains(document.activeElement);
    renderTrustBanner();
    if (hadFocus) dom.install.focus();
  });

  for (const tab of dom.tabs) {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
    tab.addEventListener('keydown', onTabKeydown);
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
  state.tab = ['log', 'security'].includes(params.tab) ? params.tab : 'installed';

  await refresh();
  if (state.tab === 'log') await refreshLog();
  render();
}

boot();
