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
  dom.trustBanner.hidden = false;
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
      renderTrustBanner();
      toast(t('plugins.installDone', { name: retry.id || '' }));
    } else {
      // 信任成功但安装仍失败：多半是包本身有问题（签名损坏/清单不一致），
      // 这时不该把 banner 留在"信任并安装"上，会让用户反复点。
      state.pendingTrust = null;
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
    renderTrustBanner();
  });

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
  state.tab = ['log', 'security'].includes(params.tab) ? params.tab : 'installed';

  await refresh();
  if (state.tab === 'log') await refreshLog();
  render();
}

boot();
