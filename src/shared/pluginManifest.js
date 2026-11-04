'use strict';
/**
 * manifest v2 校验（CJS，纯函数）。
 *
 * 原则：
 *   · 所有校验在**加载之前**完成，运行期不再猜字段类型；
 *   · 非法就是拒绝，不静默纠正（拼写错误的贡献点会让插件"看起来装好了但不生效"，
 *     比直接报错难受得多）；
 *   · 未知的 contributes 键直接拒绝，并在错误里列出允许的键。
 *
 * v1（既有歌声后端）不在这里处理：调用方用 isLegacyManifest() 分流到 legacy host，
 * 避免两套注册表同时接管同一批插件。
 */
const {
  API_VERSION, CONTRIBUTION_KEYS, LIMITS, PERMISSION_GROUPS, PANEL_SCOPES,
  HOOK_STAGES, HOOK_KINDS, TIMEOUTS,
  CONTEXT_AREAS, STATUS_ALIGNMENTS, OVERLAY_ANCHORS, WHEN_CLAUSES,
} = require('./pluginApi.js');
const { normalizeChord } = require('./pluginKeys.js');
const { TASKS, parseEndpointId } = require('./modelContract.js');

const ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const COMMAND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REL_PATH_RE = /^(?!\/)(?!.*\.\.)(?!.*:)[\w./-]+$/;
const RESERVED_IDS = new Set(['builtin', 'sxs', 'sxseditor', 'app']);

/** 插件 id 是否合法（小写反向域名风格，且不能占用内置名称）。 */
function isValidPluginId(id) {
  return typeof id === 'string' && ID_RE.test(id) && !RESERVED_IDS.has(id);
}

/** 是否 v1 清单（交由 legacy host 处理）。 */
function isLegacyManifest(manifest) {
  return !!manifest && typeof manifest === 'object' && manifest.apiVersion === 1;
}

// ------------------------------------------------------------ 版本比较
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 极简 semver 范围求值：支持 `*`、`1.2.3`、`>=1.0.0 <3.0.0`、`^1.2.0`、`~1.2.0`。
 * 不引 semver 依赖：这里只需要回答"这个 app 版本满足不满足"，不需要预发布语义。
 */
function satisfiesVersion(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  const text = String(range || '*').trim();
  if (!text || text === '*') return true;
  // 空格分隔的多段（AND 语义）
  const tokens = text.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(token);
    if (!m) return false;
    const op = m[1] || '=';
    const target = [Number(m[2]), Number(m[3] || 0), Number(m[4] || 0)];
    const cmp = compareVersion(v, target);
    switch (op) {
      case '>=': if (cmp < 0) return false; break;
      case '>': if (cmp <= 0) return false; break;
      case '<=': if (cmp > 0) return false; break;
      case '<': if (cmp >= 0) return false; break;
      case '=': if (cmp !== 0) return false; break;
      case '^': {
        // 主版本相同即可（0.x 视为次要版本锁定，够用）
        if (target[0] === 0) {
          if (cmp < 0 || target[1] !== v[1]) return false;
        } else if (cmp < 0 || v[0] !== target[0]) return false;
        break;
      }
      case '~': {
        if (cmp < 0 || v[0] !== target[0] || v[1] !== target[1]) return false;
        break;
      }
      default: return false;
    }
  }
  return true;
}

// ------------------------------------------------------------ 工具
function fail(error) { return { ok: false, error }; }

function relPath(value, field) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: `${field} 必须是非空字符串` };
  const p = value.trim().replace(/\\/g, '/');
  if (!REL_PATH_RE.test(p)) return { ok: false, error: `${field} 必须是插件目录内的相对路径：${value}` };
  return { ok: true, value: p };
}

function asArray(value, field, max) {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: `${field} 必须是数组` };
  if (value.length > max) return { ok: false, error: `${field} 数量超过上限 ${max}` };
  return { ok: true, value };
}

function localizedTitle(value, field) {
  if (typeof value === 'string' && value.trim()) return { ok: true, value: { en: value.trim(), 'zh-CN': value.trim() } };
  if (value && typeof value === 'object') {
    const out = {};
    for (const [lang, text] of Object.entries(value)) {
      if (typeof text === 'string' && text.trim()) out[lang] = text.trim().slice(0, 120);
    }
    if (Object.keys(out).length) return { ok: true, value: out };
  }
  return { ok: false, error: `${field} 必须是字符串或 { en, 'zh-CN' } 对象` };
}

/**
 * 显示条件：封闭的布尔子句，`!` 取反，`&&` 连接。
 * 空串/缺省 = 永远显示。
 */
function validateWhen(value, field) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${field} 必须是字符串` };
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  if (text.length > 200) return { ok: false, error: `${field} 过长` };
  for (const rawClause of text.split('&&')) {
    const clause = rawClause.trim();
    if (!clause) return { ok: false, error: `${field} 含空的 && 片段` };
    const name = clause.startsWith('!') ? clause.slice(1).trim() : clause;
    if (!WHEN_CLAUSES.includes(name)) {
      return { ok: false, error: `${field} 含未知条件 '${name}'（允许：${WHEN_CLAUSES.join(', ')}）` };
    }
  }
  return { ok: true, value: text };
}

// ------------------------------------------------------------ 权限
function validatePermissions(raw) {
  if (raw === undefined) return { ok: true, value: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('permissions 必须是对象（v2；v1 的数组写法请把 apiVersion 设为 1）');
  }
  const out = {};
  for (const [group, value] of Object.entries(raw)) {
    if (!(group in PERMISSION_GROUPS)) {
      return fail(`未知权限组 '${group}'（允许：${Object.keys(PERMISSION_GROUPS).join(', ')}）`);
    }
    const allowed = PERMISSION_GROUPS[group];
    if (allowed === null) {
      // 自由字符串数组：net 的域名 allowlist
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
        return fail(`permissions.${group} 必须是字符串数组`);
      }
      out[group] = value.map((v) => v.trim().toLowerCase()).slice(0, 64);
      if (out[group].length === 0) return fail(`permissions.${group} 为空数组没有意义，请去掉该键`);
      continue;
    }
    if (value === true) {
      out[group] = [...allowed];
      continue;
    }
    if (!Array.isArray(value)) return fail(`permissions.${group} 必须是数组或 true`);
    for (const item of value) {
      if (!allowed.includes(item)) {
        return fail(`permissions.${group} 含未知取值 '${item}'（允许：${allowed.join(', ')}）`);
      }
    }
    out[group] = [...new Set(value)];
  }
  return { ok: true, value: out };
}

/** 权限集合的稳定指纹，用于"权限变了就重新弹窗"。 */
function permissionsHash(perms) {
  const sorted = {};
  for (const key of Object.keys(perms || {}).sort()) {
    sorted[key] = [...(perms[key] || [])].sort();
  }
  return JSON.stringify(sorted);
}

// ------------------------------------------------------------ 贡献点
function validateCommands(list, pluginId) {
  const out = [];
  for (const cmd of list) {
    if (!cmd || typeof cmd !== 'object') return fail('commands 的每一项必须是对象');
    if (!COMMAND_ID_RE.test(cmd.id || '')) return fail(`command.id 非法：${JSON.stringify(cmd.id)}`);
    const title = localizedTitle(cmd.title, `command('${cmd.id}').title`);
    if (!title.ok) return fail(title.error);
    out.push({
      id: `${pluginId}.${cmd.id}`,
      localId: cmd.id,
      pluginId,
      title: title.value,
      description: typeof cmd.description === 'string' ? cmd.description.slice(0, 500) : '',
      /** true = 允许在无界面（MCP/CLI）下调用，默认跟随 automation 权限 */
      headless: cmd.headless !== false,
    });
  }
  // 重复 id 会让菜单出现两个同名项且卸载只删掉一个
  const seen = new Set();
  for (const c of out) {
    if (seen.has(c.id)) return fail(`command.id 重复：${c.localId}`);
    seen.add(c.id);
  }
  return { ok: true, value: out };
}

function validateMenus(list, pluginId, commandIds) {
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return fail('menus 的每一项必须是对象');
    const path = typeof item.path === 'string' ? item.path.replace(/^\/+|\/+$/g, '') : '';
    if (!path || path.split('/').length > 4) return fail(`menu.path 非法：${JSON.stringify(item.path)}`);
    // 只允许挂在 Plugins 顶级菜单下，避免插件往 File/Edit 里塞东西
    if (path !== 'plugins' && !path.startsWith('plugins/')) {
      return fail(`menu.path 必须以 'plugins' 开头：${path}`);
    }
    if (typeof item.command !== 'string' || !COMMAND_ID_RE.test(item.command)) {
      return fail(`menu.command 非法：${JSON.stringify(item.command)}`);
    }
    const fullId = `${pluginId}.${item.command}`;
    if (commandIds && !commandIds.has(fullId)) {
      return fail(`menu 引用了未声明的命令 '${item.command}'`);
    }
    out.push({ path, command: fullId, when: typeof item.when === 'string' ? item.when : null });
  }
  return { ok: true, value: out };
}

function validatePanels(list, pluginId) {
  const out = [];
  for (const panel of list) {
    if (!panel || typeof panel !== 'object') return fail('panels 的每一项必须是对象');
    if (!COMMAND_ID_RE.test(panel.id || '')) return fail(`panel.id 非法：${JSON.stringify(panel.id)}`);
    const entry = relPath(panel.entry, `panel('${panel.id}').entry`);
    if (!entry.ok) return fail(entry.error);
    const scopes = Array.isArray(panel.apiScopes) ? panel.apiScopes : [];
    for (const scope of scopes) {
      if (!PANEL_SCOPES.includes(scope)) {
        return fail(`panel('${panel.id}') 申请了未知能力 '${scope}'（允许：${PANEL_SCOPES.join(', ')}）`);
      }
    }
    // 标题与命令用同一条规范化路径。此前这里是 `String(panel.title || panel.id)`，
    // 而 v2 的 title 允许 { en, 'zh-CN' } 对象 —— 结果菜单里显示
    // "Open Panel · [object Object]"。标题缺省时才回退到 panel.id。
    const panelTitle = localizedTitle(panel.title || panel.id, `panel('${panel.id}').title`);
    if (!panelTitle.ok) return fail(panelTitle.error);
    out.push({
      id: `${pluginId}.${panel.id}`,
      localId: panel.id,
      pluginId,
      title: panelTitle.value,
      entry: entry.value,
      apiScopes: [...new Set(scopes)],
      width: Math.max(280, Math.min(1600, Number(panel.width) || 420)),
      // pluginApi 的注释承诺了"panel.timeoutMs 可覆盖默认 RPC 超时"，
      // 但校验层此前把它丢了，于是作者写了也不生效。这里保留并夹紧。
      timeoutMs: Math.max(1000, Math.min(120000, Number(panel.timeoutMs) || TIMEOUTS.panelRpc)),
    });
  }
  return { ok: true, value: out };
}

/** 宿主自己接管的扩展名。插件不能抢：工程/歌手文件走的是宿主格式与版本协商，
 *  一旦被插件顶掉，用户双击 .sxsproj 打开的就是别人的解析器。 */
const RESERVED_FILE_EXTS = new Set(['.sxsproj', '.sxs', '.sxssinger', '.sxsp']);

function validateFileTypes(list) {
  const out = [];
  const seen = new Set();
  for (const ft of list) {
    if (!ft || typeof ft !== 'object') return fail('fileTypes 的每一项必须是对象');
    let ext = String(ft.ext || '').trim().toLowerCase();
    if (ext && !ext.startsWith('.')) ext = `.${ext}`;
    if (!/^\.[a-z0-9]{1,16}$/.test(ext)) return fail(`fileTypes.ext 非法：${JSON.stringify(ft.ext)}`);
    if (RESERVED_FILE_EXTS.has(ext)) {
      return fail(`不能注册 ${ext}：内置工程/歌手格式不允许被插件接管`);
    }
    // 同一个 manifest 里声明两遍同一个扩展名，宿主无法判断作者想要哪一种角色，
    // 干脆拒绝 —— 否则两个注册项会同时进注册表，路由结果取决于遍历顺序。
    if (seen.has(ext)) return fail(`fileTypes 重复声明了 ${ext}`);
    seen.add(ext);
    const role = ft.role === 'save' || ft.role === 'both' ? ft.role : 'open';
    const filters = Array.isArray(ft.filters)
      ? ft.filters.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 60)).slice(0, 4)
      : [];
    // label 是对话框过滤器里显示的格式名。M4 之前只有 filters（一个纯字符串数组），
    // 用它当名字也能用，但作者想本地化就没处放，所以补一个显式的本地化标题。
    let label = { ok: true, value: null };
    if (ft.label !== undefined) {
      label = localizedTitle(ft.label, `fileTypes('${ext}').label`);
      if (!label.ok) return fail(label.error);
    }
    out.push({
      ext,
      role,
      filters,
      label: label.value || (filters[0] ? { en: filters[0] } : null),
    });
  }
  return { ok: true, value: out };
}

/**
 * `contributes.exporters`：音频导出格式（M4 第 4 段）。
 *
 * 与 `fileTypes` 的区别容易被混淆，这里划清：
 *   · `fileTypes` 是**工程**格式 —— 打开/保存工程文件，走 codec；
 *   · `exporters` 是**成品**格式 —— 导出音频，入参是浮点采样，出参是字节。
 *
 * 一个插件可以只做后者（"我能把唱好的东西压成 m4a"），不需要接管任何工程格式。
 * 扩展名的保留集合同样生效：导出器不能叫 `.sxsproj`，那会把成品写成工程的样子。
 */
function validateExporters(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') return fail('exporters 的每一项必须是对象');
    const id = String(item.id || '').trim();
    if (!COMMAND_ID_RE.test(id)) return fail(`exporters.id 非法：${JSON.stringify(item.id)}`);
    if (seen.has(id)) return fail(`exporters 重复声明了 ${id}`);
    seen.add(id);

    let ext = String(item.ext || '').trim().toLowerCase();
    if (ext && !ext.startsWith('.')) ext = `.${ext}`;
    if (!/^\.[a-z0-9]{1,16}$/.test(ext)) return fail(`exporters(${id}).ext 非法：${JSON.stringify(item.ext)}`);
    if (RESERVED_FILE_EXTS.has(ext)) {
      return fail(`exporters(${id}) 不能用 ${ext}：那是工程/歌手格式，成品导出不该覆盖它`);
    }

    const label = localizedTitle(item.label, `exporters(${id}).label`);
    if (!label.ok) return fail(label.error);

    let mime = '';
    if (item.mime !== undefined) {
      const m = String(item.mime || '').trim();
      // 只做形状校验：宿主不用它做路由，但导出成功视图与"用默认程序打开"
      // 都靠它。乱填的 mime 会让系统把成品交给错误的程序。
      if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(m) || m.length > 64) {
        return fail(`exporters(${id}).mime 非法：${JSON.stringify(item.mime)}`);
      }
      mime = m.toLowerCase();
    }
    out.push({
      id,
      ext,
      label: label.value,
      mime,
      description: typeof item.description === 'string' ? item.description.slice(0, 300) : '',
    });
  }
  return { ok: true, value: out };
}

const FIELD_TYPES = Object.freeze(['boolean', 'number', 'string', 'select', 'multiline']);

/**
 * 设置字段的规范化。
 *
 * M1 只校验了 key，值直接透传。管理器/设置页要按 schema 渲染出真正的控件，
 * 就必须在加载时把类型、默认值、范围一次性定下来 —— 否则渲染层要为每种
 * "作者可能写错的形状"做兜底，最后变成一堆 if。
 */
function normalizeSettingField(raw, sectionId) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `settings('${sectionId}') 的字段必须是对象` };
  if (typeof raw.key !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(raw.key)) {
    return { ok: false, error: `settings('${sectionId}') 的字段 key 非法` };
  }
  const type = FIELD_TYPES.includes(raw.type) ? raw.type : 'string';
  const label = localizedTitle(raw.label || raw.key, `settings('${sectionId}').${raw.key}.label`);
  if (!label.ok) return fail(label.error);
  let description = { ok: true, value: null };
  if (raw.description !== undefined) {
    description = localizedTitle(raw.description, `settings('${sectionId}').${raw.key}.description`);
    if (!description.ok) return fail(description.error);
  }

  const out = {
    key: raw.key,
    type,
    label: label.value,
    description: description.value,
    min: Number.isFinite(raw.min) ? Number(raw.min) : null,
    max: Number.isFinite(raw.max) ? Number(raw.max) : null,
    step: Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : null,
    options: [],
    default: null,
  };

  if (type === 'select') {
    const list = Array.isArray(raw.options) ? raw.options : [];
    if (!list.length) return fail(`settings('${sectionId}').${raw.key}.options 不能为空`);
    for (const opt of list.slice(0, 32)) {
      if (!opt || typeof opt !== 'object') return fail(`settings('${sectionId}').${raw.key}.options 含非对象项`);
      const value = typeof opt.value === 'number' ? opt.value : String(opt.value ?? '');
      if (!value && value !== 0) return fail(`settings('${sectionId}').${raw.key}.options 含空 value`);
      const optLabel = localizedTitle(opt.label || String(value), `settings('${sectionId}').${raw.key}.option`);
      if (!optLabel.ok) return fail(optLabel.error);
      out.options.push({ value, label: optLabel.value });
    }
    out.default = raw.default === undefined
      ? out.options[0].value
      : (out.options.some((o) => o.value === raw.default) ? raw.default : out.options[0].value);
    return { ok: true, value: out };
  }

  if (type === 'boolean') {
    out.default = raw.default === true;
    return { ok: true, value: out };
  }

  if (type === 'number') {
    let value = Number(raw.default);
    if (!Number.isFinite(value)) value = out.min !== null ? out.min : 0;
    if (out.min !== null) value = Math.max(out.min, value);
    if (out.max !== null) value = Math.min(out.max, value);
    out.default = value;
    return { ok: true, value: out };
  }

  // string / multiline
  out.default = typeof raw.default === 'string' ? raw.default.slice(0, 2000) : '';
  return { ok: true, value: out };
}

function validateSettings(list, pluginId) {
  const out = [];
  for (const section of list) {
    if (!section || typeof section !== 'object') return fail('settings 的每一项必须是对象');
    if (!COMMAND_ID_RE.test(section.id || '')) return fail(`settings.id 非法：${JSON.stringify(section.id)}`);
    // M2 的决定：设置分区只有两种形态 —— 宿主渲染的 schema 表单，或"跳到一个面板"。
    // 曾经的 entry（在设置页里内嵌任意 HTML）被放弃：设置窗口没有面板那套 postMessage
    // 桥与 apiScopes 校验，内嵌 iframe 等于开一个**没有权限闸门**的插件页面。
    // 需要自定义界面就把逻辑写进 panel，再从设置页跳过去。
    if (section.entry !== undefined) {
      return fail(`settings('${section.id}').entry 不受支持：请改用 fields 内联表单，或用 panel 指向一个已注册面板`);
    }
    let panelId = null;
    if (section.panel !== undefined) {
      if (typeof section.panel !== 'string' || !COMMAND_ID_RE.test(section.panel)) {
        return fail(`settings('${section.id}').panel 非法`);
      }
      panelId = `${pluginId}.${section.panel}`;
    }
    const fields = [];
    for (const raw of Array.isArray(section.fields) ? section.fields.slice(0, 64) : []) {
      const field = normalizeSettingField(raw, section.id);
      if (!field.ok) return fail(field.error);
      fields.push(field.value);
    }
    if (!panelId && !fields.length) {
      return fail(`settings('${section.id}') 必须提供 panel 或至少一个 fields`);
    }
    const sectionTitle = localizedTitle(section.title || section.id, `settings('${section.id}').title`);
    if (!sectionTitle.ok) return fail(sectionTitle.error);
    out.push({
      id: `${pluginId}.${section.id}`,
      localId: section.id,
      pluginId,
      title: sectionTitle.value,
      panelId,
      fields,
    });
  }
  return { ok: true, value: out };
}

// ------------------------------------------------------------ 界面贡献点
function requireCommand(commandIds, command, field) {
  if (typeof command !== 'string' || !COMMAND_ID_RE.test(command)) {
    return { ok: false, error: `${field} 非法：${JSON.stringify(command)}` };
  }
  return { ok: true, value: command };
}

function validateToolbar(list, pluginId, commandIds) {
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return fail('toolbar 的每一项必须是对象');
    if (!COMMAND_ID_RE.test(item.id || '')) return fail(`toolbar.id 非法：${JSON.stringify(item.id)}`);
    const command = requireCommand(commandIds, item.command, `toolbar('${item.id}').command`);
    if (!command.ok) return fail(command.error);
    const fullCommand = `${pluginId}.${item.command}`;
    if (commandIds && !commandIds.has(fullCommand)) {
      return fail(`toolbar('${item.id}') 引用了未声明的命令 '${item.command}'`);
    }
    const title = localizedTitle(item.title, `toolbar('${item.id}').title`);
    if (!title.ok) return fail(title.error);
    if (item.icon !== undefined && (typeof item.icon !== 'string' || !/^[a-z0-9-]{1,32}$/.test(item.icon))) {
      return fail(`toolbar('${item.id}').icon 非法（小写字母/数字/连字符）`);
    }
    if (item.group !== undefined && (typeof item.group !== 'string' || !/^[a-z0-9-]{1,32}$/.test(item.group))) {
      return fail(`toolbar('${item.id}').group 非法`);
    }
    const when = validateWhen(item.when, `toolbar('${item.id}').when`);
    if (!when.ok) return fail(when.error);
    out.push({
      id: `${pluginId}.${item.id}`,
      localId: item.id,
      pluginId,
      command: fullCommand,
      title: title.value,
      icon: item.icon || null,
      group: item.group || 'plugins',
      when: when.value,
    });
  }
  return { ok: true, value: out };
}

function validateStatusBar(list, pluginId, commandIds) {
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return fail('statusBar 的每一项必须是对象');
    if (!COMMAND_ID_RE.test(item.id || '')) return fail(`statusBar.id 非法：${JSON.stringify(item.id)}`);
    const text = localizedTitle(item.text, `statusBar('${item.id}').text`);
    if (!text.ok) return fail(text.error);
    let command = null;
    if (item.command !== undefined) {
      const checked = requireCommand(commandIds, item.command, `statusBar('${item.id}').command`);
      if (!checked.ok) return fail(checked.error);
      command = `${pluginId}.${item.command}`;
      if (commandIds && !commandIds.has(command)) {
        return fail(`statusBar('${item.id}') 引用了未声明的命令 '${item.command}'`);
      }
    }
    let tooltip = { ok: true, value: null };
    if (item.tooltip !== undefined) {
      tooltip = localizedTitle(item.tooltip, `statusBar('${item.id}').tooltip`);
      if (!tooltip.ok) return fail(tooltip.error);
    }
    const when = validateWhen(item.when, `statusBar('${item.id}').when`);
    if (!when.ok) return fail(when.error);
    out.push({
      id: `${pluginId}.${item.id}`,
      localId: item.id,
      pluginId,
      text: text.value,
      tooltip: tooltip.value,
      command,
      alignment: STATUS_ALIGNMENTS.includes(item.alignment) ? item.alignment : 'right',
      when: when.value,
    });
  }
  return { ok: true, value: out };
}

function validateContextMenus(list, pluginId, commandIds) {
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return fail('contextMenus 的每一项必须是对象');
    if (!COMMAND_ID_RE.test(item.id || '')) return fail(`contextMenus.id 非法：${JSON.stringify(item.id)}`);
    if (!CONTEXT_AREAS.includes(item.context)) {
      return fail(`contextMenus('${item.id}') 的 context 非法（允许：${CONTEXT_AREAS.join(', ')}）`);
    }
    const checked = requireCommand(commandIds, item.command, `contextMenus('${item.id}').command`);
    if (!checked.ok) return fail(checked.error);
    const fullCommand = `${pluginId}.${item.command}`;
    if (commandIds && !commandIds.has(fullCommand)) {
      return fail(`contextMenus('${item.id}') 引用了未声明的命令 '${item.command}'`);
    }
    const title = localizedTitle(item.title, `contextMenus('${item.id}').title`);
    if (!title.ok) return fail(title.error);
    const when = validateWhen(item.when, `contextMenus('${item.id}').when`);
    if (!when.ok) return fail(when.error);
    out.push({
      id: `${pluginId}.${item.id}`,
      localId: item.id,
      pluginId,
      context: item.context,
      command: fullCommand,
      title: title.value,
      when: when.value,
    });
  }
  return { ok: true, value: out };
}

function validateOverlays(list, pluginId) {
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return fail('timelineOverlays 的每一项必须是对象');
    if (!COMMAND_ID_RE.test(item.id || '')) return fail(`timelineOverlays.id 非法：${JSON.stringify(item.id)}`);
    const entry = relPath(item.entry, `timelineOverlays('${item.id}').entry`);
    if (!entry.ok) return fail(entry.error);
    const title = localizedTitle(item.title || item.id, `timelineOverlays('${item.id}').title`);
    if (!title.ok) return fail(title.error);
    const when = validateWhen(item.when, `timelineOverlays('${item.id}').when`);
    if (!when.ok) return fail(when.error);
    out.push({
      id: `${pluginId}.${item.id}`,
      localId: item.id,
      pluginId,
      entry: entry.value,
      title: title.value,
      anchor: OVERLAY_ANCHORS.includes(item.anchor) ? item.anchor : 'canvas',
      height: Math.max(40, Math.min(800, Number(item.height) || 160)),
      // null = 横向铺满锚点；数字 = 固定宽度（从左侧起）
      width: Number.isFinite(item.width) ? Math.max(80, Math.min(4000, Number(item.width))) : null,
      pointerEvents: item.pointerEvents === 'auto' ? 'auto' : 'none',
      when: when.value,
    });
  }
  return { ok: true, value: out };
}

function validateKeybindings(list, pluginId, commandIds) {
  const out = [];
  const seen = new Map();
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== 'object') return fail('keybindings 的每一项必须是对象');
    const checked = requireCommand(commandIds, item.command, `keybindings[${index}].command`);
    if (!checked.ok) return fail(checked.error);
    const fullCommand = `${pluginId}.${item.command}`;
    if (commandIds && !commandIds.has(fullCommand)) {
      return fail(`keybindings[${index}] 引用了未声明的命令 '${item.command}'`);
    }
    const chord = normalizeChord(item.key);
    if (!chord) return fail(`keybindings[${index}].key 无法识别：${JSON.stringify(item.key)}`);
    let mac = null;
    if (item.mac !== undefined) {
      mac = normalizeChord(item.mac);
      if (!mac) return fail(`keybindings[${index}].mac 无法识别：${JSON.stringify(item.mac)}`);
    }
    const when = validateWhen(item.when, `keybindings[${index}].when`);
    if (!when.ok) return fail(when.error);
    // 同一插件内同一组合声明两次 = 作者写错了，直接拒绝；跨插件冲突交给运行时仲裁
    const dedupeKey = `${chord}|${mac || ''}|${when.value || ''}`;
    if (seen.has(dedupeKey)) {
      return fail(`keybindings 重复绑定 ${chord}（与第 ${seen.get(dedupeKey) + 1} 项相同）`);
    }
    seen.set(dedupeKey, index);
    out.push({
      id: `${pluginId}.kb${index}`,
      index,
      pluginId,
      command: fullCommand,
      chord,
      mac,
      when: when.value,
    });
  }
  return { ok: true, value: out };
}

const LOCALE_RE = /^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/;

/** 插件自带文案：{ 'zh-CN': { greeting: '你好' }, en: {...} }，最多 400 条。 */
function validateI18n(raw) {
  if (raw === undefined) return { ok: true, value: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('i18n 必须是对象');
  const out = {};
  let total = 0;
  for (const [locale, dict] of Object.entries(raw)) {
    if (!LOCALE_RE.test(locale)) return fail(`i18n 的语言标签非法：${JSON.stringify(locale)}`);
    if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return fail(`i18n.${locale} 必须是对象`);
    const flat = {};
    for (const [key, text] of Object.entries(dict)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) return fail(`i18n.${locale} 的键非法：${JSON.stringify(key)}`);
      if (typeof text !== 'string') return fail(`i18n.${locale}.${key} 必须是字符串`);
      flat[key] = text.slice(0, 500);
      total++;
    }
    if (total > 400) return fail('i18n 条目总数超过上限 400');
    out[locale] = flat;
  }
  return { ok: true, value: out };
}


function validatePipeline(raw) {
  if (raw === undefined) return { ok: true, value: [] };
  if (!raw || typeof raw !== 'object') return fail('pipeline 必须是对象');
  const hooks = Array.isArray(raw.hooks) ? raw.hooks : [];
  const out = [];
  for (const hook of hooks) {
    if (!hook || typeof hook !== 'object') return fail('pipeline.hooks 的每一项必须是对象');
    if (!HOOK_STAGES.includes(hook.stage)) {
      return fail(`未知 hook stage '${hook.stage}'（允许：${HOOK_STAGES.join(', ')}）`);
    }
    const kind = HOOK_KINDS.includes(hook.kind) ? hook.kind : 'model';
    const item = {
      stage: hook.stage,
      kind,
      order: Number.isFinite(hook.order) ? Number(hook.order) : 100,
      timeoutMs: Math.max(50, Math.min(10000, Number(hook.timeoutMs) || 2000)),
    };
    if (kind === 'model') {
      const model = relPath(hook.model, `pipeline.hooks(${hook.stage}).model`);
      if (!model.ok) return fail(model.error);
      item.model = model.value;
      item.io = hook.io && typeof hook.io === 'object' ? hook.io : null;
    } else {
      // js hook：指向插件模块里导出的 `pipelineHooks.<id>`。
      // 必须是标识符而不是路径 —— js hook 跑在插件自己的 runtime 里，没有"另一个文件"。
      if (!COMMAND_ID_RE.test(String(hook.hook || ''))) {
        return fail(`pipeline.hooks(${hook.stage}).hook 必须是合法的 hook id`);
      }
      item.hook = String(hook.hook);
    }
    out.push(item);
  }
  return { ok: true, value: out };
}

function validateAutomation(raw) {
  if (raw === undefined) return { ok: true, value: { methods: [], expose: true } };
  if (!raw || typeof raw !== 'object') return fail('automation 必须是对象');
  const methods = Array.isArray(raw.methods) ? raw.methods : [];
  for (const m of methods) {
    if (!COMMAND_ID_RE.test(m)) return fail(`automation.methods 含非法 id：${JSON.stringify(m)}`);
  }
  return {
    ok: true,
    value: { methods: [...new Set(methods)], expose: raw.expose !== false },
  };
}

function validateServices(raw) {
  if (raw === undefined) return { ok: true, value: [] };
  const provides = Array.isArray(raw && raw.provides) ? raw.provides : [];
  const out = [];
  for (const svc of provides) {
    if (!svc || typeof svc !== 'object') return fail('services.provides 的每一项必须是对象');
    if (!COMMAND_ID_RE.test(svc.id || '')) return fail(`service.id 非法：${JSON.stringify(svc.id)}`);
    out.push({ id: svc.id, version: VERSION_RE.test(svc.version || '') ? svc.version : '1.0.0' });
  }
  return { ok: true, value: out };
}

/**
 * `contributes.models`：插件要用模型面时声明什么。
 *
 *   consumes   —— 会调用哪些 task。安装时给用户看的就是这份清单，别漏报。
 *   preferred  —— "哪个端点上跑这个 task 更合适"。仅用于设置页的 ★ 标注，
 *                 **不参与路由**：插件不知道用户装了哪些端点，也没资格替他选。
 *                 按 provider 指定是常态（同厂商任意端点），按 endpoint 精确指定
 *                 只有插件自己注册的端点才有意义。
 *
 * 声明了其中任何一项就必须有 permissions.models: ['consume'] —— 否则用户看到的
 * 权限清单与实际行为对不上。
 */
function validateModels(raw) {
  if (raw === undefined) return { ok: true, value: { consumes: [], preferred: [] } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('contributes.models 必须是对象');

  for (const key of Object.keys(raw)) {
    if (key !== 'consumes' && key !== 'preferred') return fail(`未知的 contributes.models.${key}`);
  }

  const consumesRaw = raw.consumes === undefined ? [] : raw.consumes;
  if (!Array.isArray(consumesRaw)) return fail('contributes.models.consumes 必须是数组');
  if (consumesRaw.length > 8) return fail('contributes.models.consumes 最多 8 项');
  const consumes = [];
  for (const task of consumesRaw) {
    if (!TASKS.includes(task)) return fail(`未知 task：${JSON.stringify(task)}（允许：${TASKS.join(', ')}）`);
    if (!consumes.includes(task)) consumes.push(task);
  }

  const preferredRaw = raw.preferred === undefined ? [] : raw.preferred;
  if (!Array.isArray(preferredRaw)) return fail('contributes.models.preferred 必须是数组');
  if (preferredRaw.length > 16) return fail('contributes.models.preferred 最多 16 项');
  const preferred = [];
  for (const item of preferredRaw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('models.preferred 的每一项必须是对象');
    if (!TASKS.includes(item.task)) {
      return fail(`models.preferred.task 非法：${JSON.stringify(item.task)}`);
    }
    const endpoint = item.endpoint === undefined ? null : String(item.endpoint);
    const provider = item.provider === undefined ? null : String(item.provider).toLowerCase();
    if (!endpoint && !provider) return fail('models.preferred 的每一项要给出 endpoint 或 provider');
    if (endpoint && !parseEndpointId(endpoint)) {
      return fail(`models.preferred.endpoint 不是合法端点 id：${endpoint}`);
    }
    if (provider && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(provider)) {
      return fail(`models.preferred.provider 非法：${provider}`);
    }
    preferred.push({
      task: item.task,
      endpoint,
      provider,
      note: typeof item.note === 'string' ? item.note.slice(0, 140) : '',
    });
  }

  return { ok: true, value: { consumes, preferred } };
}

// ------------------------------------------------------------ 主入口
/**
 * @param {object} manifest
 * @param {{dirName:string, appVersion:string}} ctx
 * @returns {{ok:true, value:object}|{ok:false,error:string}}
 */
function validateManifest(manifest, ctx = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return fail('manifest.json 必须是 JSON 对象');
  }
  if (isLegacyManifest(manifest)) {
    return fail('apiVersion=1 的插件由 legacy host 加载，不走 v2 注册表');
  }
  if (manifest.apiVersion !== API_VERSION) {
    return fail(`apiVersion 不兼容：需要 ${API_VERSION}，插件声明 ${JSON.stringify(manifest.apiVersion)}`);
  }

  const id = manifest.id;
  if (!isValidPluginId(id)) {
    return fail(`manifest.id 非法（小写反向域名风格，且不能是 ${[...RESERVED_IDS].join('/')}）：${JSON.stringify(id)}`);
  }
  if (ctx.dirName && id !== ctx.dirName) {
    return fail(`manifest.id('${id}') 与目录名('${ctx.dirName}') 不一致`);
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) return fail('manifest.name 必填');
  if (!VERSION_RE.test(manifest.version || '')) return fail(`manifest.version 非法：${JSON.stringify(manifest.version)}`);

  const engines = manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : {};
  if (engines.app && ctx.appVersion && !satisfiesVersion(ctx.appVersion, engines.app)) {
    return fail(`插件要求宿主 ${engines.app}，当前 ${ctx.appVersion}`);
  }

  const main = relPath(manifest.main, 'manifest.main');
  if (!main.ok) return fail(main.error);

  const perms = validatePermissions(manifest.permissions);
  if (!perms.ok) return perms;

  const raw = manifest.contributes;
  if (raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    return fail('contributes 必须是对象');
  }
  const contributes = raw || {};

  for (const key of Object.keys(contributes)) {
    if (!CONTRIBUTION_KEYS.includes(key)) {
      return fail(`未知贡献点 'contributes.${key}'（允许：${CONTRIBUTION_KEYS.join(', ')}）`);
    }
  }

  // 先算总数，再逐项校验 —— 一个 512 项的 manifest 不该在校验通过后才被发现太大
  let total = 0;
  for (const [key, value] of Object.entries(contributes)) {
    if (key === 'pipeline' || key === 'synthesis' || key === 'services' || key === 'automation' || key === 'models') continue;
    if (Array.isArray(value)) total += value.length;
  }
  if (total > LIMITS.totalContributions) {
    return fail(`贡献项总数超过上限 ${LIMITS.totalContributions}`);
  }

  // 数组类贡献的读取：出错记在 arrayError，最后统一返回，避免每处都写一遍 if
  let arrayError = null;
  const arr = (key, max) => {
    const r = asArray(contributes[key], `contributes.${key}`, max);
    if (!r.ok) {
      if (!arrayError) arrayError = r.error;
      return [];
    }
    return r.value;
  };

  const commands = validateCommands(arr('commands', LIMITS.commands), id);
  if (!commands.ok) return commands;
  const commandIds = new Set(commands.value.map((c) => c.id));

  const menus = validateMenus(arr('menus', LIMITS.menus), id, commandIds);
  if (!menus.ok) return menus;

  const panels = validatePanels(arr('panels', LIMITS.panels), id);
  if (!panels.ok) return panels;

  const fileTypes = validateFileTypes(arr('fileTypes', LIMITS.fileTypes));
  if (!fileTypes.ok) return fileTypes;

  const exporters = validateExporters(arr('exporters', LIMITS.exporters));
  if (!exporters.ok) return exporters;

  const settings = validateSettings(arr('settings', LIMITS.settings), id);
  if (!settings.ok) return settings;

  const toolbar = validateToolbar(arr('toolbar', LIMITS.toolbar), id, commandIds);
  if (!toolbar.ok) return toolbar;

  const statusBar = validateStatusBar(arr('statusBar', LIMITS.statusBar), id, commandIds);
  if (!statusBar.ok) return statusBar;

  const contextMenus = validateContextMenus(arr('contextMenus', LIMITS.contextMenus), id, commandIds);
  if (!contextMenus.ok) return contextMenus;

  const timelineOverlays = validateOverlays(arr('timelineOverlays', LIMITS.timelineOverlays), id);
  if (!timelineOverlays.ok) return timelineOverlays;

  const keybindings = validateKeybindings(arr('keybindings', LIMITS.keybindings), id, commandIds);
  if (!keybindings.ok) return keybindings;

  if (arrayError) return fail(arrayError);

  const pipeline = validatePipeline(contributes.pipeline);
  if (!pipeline.ok) return pipeline;

  const automation = validateAutomation(contributes.automation);
  if (!automation.ok) return automation;

  const services = validateServices(contributes.services);
  if (!services.ok) return services;

  const modelContrib = validateModels(contributes.models);
  if (!modelContrib.ok) return modelContrib;

  const i18n = validateI18n(contributes.i18n);
  if (!i18n.ok) return i18n;

  // 要用模型面就得先声明 consume：权限清单是给用户看的，不能与实际行为脱节。
  const modelPerms = perms.value.models || [];
  if (!modelPerms.includes('consume')
    && (modelContrib.value.consumes.length || modelContrib.value.preferred.length)) {
    return fail("声明了 contributes.models，但 permissions.models 里没有 'consume'");
  }

  // 界面贡献必须与声明的权限对得上。
  //
  // 不校验的话 permissions 就只是安装弹窗上的一行装饰：插件可以声明"我不要
  // 任何界面权限"，然后往工具栏塞按钮。用户的知情同意必须与实际行为一致。
  const uiPerms = perms.value.ui || [];
  const requiredUi = [
    // [贡献点（manifest 键名，用于报错）, permissions.ui 里的权限名（单数）, 条目数]
    ['menus', 'menu', menus.value.length],
    ['panels', 'panel', panels.value.length],
    ['toolbar', 'toolbar', toolbar.value.length],
    ['statusBar', 'statusBar', statusBar.value.length],
    ['contextMenus', 'contextMenu', contextMenus.value.length],
    ['timelineOverlays', 'overlay', timelineOverlays.value.length],
    ['settings', 'settings', settings.value.length],
  ];
  for (const [contribution, permission, count] of requiredUi) {
    if (count > 0 && !uiPerms.includes(permission)) {
      return fail(`声明了 contributes.${contribution}，但 permissions.ui 里没有 '${permission}'`);
    }
  }

  // 尚未落地的贡献点：接受但不生效，管理器里会标注"未实现"
  const pending = [];
  for (const key of ['services', 'intents', 'synthesis']) {
    if (contributes[key] !== undefined) pending.push(key);
  }

  return {
    ok: true,
    value: {
      id,
      name: manifest.name.trim().slice(0, 120),
      version: manifest.version,
      apiVersion: API_VERSION,
      description: typeof manifest.description === 'string' ? manifest.description.slice(0, 2000) : '',
      author: typeof manifest.author === 'string' ? manifest.author.slice(0, 120) : '',
      homepage: typeof manifest.homepage === 'string' ? manifest.homepage.slice(0, 300) : '',
      main: main.value,
      engines: { app: typeof engines.app === 'string' ? engines.app : '*' },
      permissions: perms.value,
      permissionsHash: permissionsHash(perms.value),
      contributes: {
        commands: commands.value,
        menus: menus.value,
        panels: panels.value,
        fileTypes: fileTypes.value,
        exporters: exporters.value,
        settings: settings.value,
        toolbar: toolbar.value,
        statusBar: statusBar.value,
        contextMenus: contextMenus.value,
        timelineOverlays: timelineOverlays.value,
        keybindings: keybindings.value,
        i18n: i18n.value,
        pipeline: pipeline.value,
        services: services.value,
        automation: automation.value,
        models: modelContrib.value,
      },
      pendingContributions: pending,
    },
  };
}

module.exports = {
  isValidPluginId,
  isLegacyManifest,
  satisfiesVersion,
  permissionsHash,
  validateManifest,
  validatePermissions,
};
