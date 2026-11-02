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
  HOOK_STAGES, HOOK_KINDS,
} = require('./pluginApi.js');

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
    out.push({
      id: `${pluginId}.${panel.id}`,
      localId: panel.id,
      pluginId,
      title: String(panel.title || panel.id).slice(0, 120),
      entry: entry.value,
      apiScopes: [...new Set(scopes)],
      width: Math.max(280, Math.min(1600, Number(panel.width) || 420)),
    });
  }
  return { ok: true, value: out };
}

function validateFileTypes(list) {
  const out = [];
  for (const ft of list) {
    if (!ft || typeof ft !== 'object') return fail('fileTypes 的每一项必须是对象');
    let ext = String(ft.ext || '').trim().toLowerCase();
    if (ext && !ext.startsWith('.')) ext = `.${ext}`;
    if (!/^\.[a-z0-9]{1,16}$/.test(ext)) return fail(`fileTypes.ext 非法：${JSON.stringify(ft.ext)}`);
    if (ext === '.sxsproj') return fail('不能注册 .sxsproj：内置工程格式不允许被插件接管');
    const role = ft.role === 'save' || ft.role === 'both' ? ft.role : 'open';
    out.push({
      ext,
      role,
      filters: Array.isArray(ft.filters) ? ft.filters.filter((s) => typeof s === 'string').slice(0, 4) : [],
    });
  }
  return { ok: true, value: out };
}

function validateSettings(list, pluginId) {
  const out = [];
  for (const section of list) {
    if (!section || typeof section !== 'object') return fail('settings 的每一项必须是对象');
    if (!COMMAND_ID_RE.test(section.id || '')) return fail(`settings.id 非法：${JSON.stringify(section.id)}`);
    const entry = section.entry ? relPath(section.entry, `settings('${section.id}').entry`) : null;
    if (entry && !entry.ok) return fail(entry.error);
    const fields = Array.isArray(section.fields) ? section.fields : [];
    for (const f of fields) {
      if (!f || typeof f !== 'object' || typeof f.key !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(f.key)) {
        return fail(`settings('${section.id}') 的字段 key 非法`);
      }
    }
    out.push({
      id: `${pluginId}.${section.id}`,
      localId: section.id,
      pluginId,
      title: String(section.title || section.id).slice(0, 120),
      entry: entry && entry.ok ? entry.value : null,
      fields: fields.slice(0, 64),
    });
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
    if (key === 'pipeline' || key === 'synthesis' || key === 'services' || key === 'automation' || key === 'llm') continue;
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

  const settings = validateSettings(arr('settings', LIMITS.settings), id);
  if (!settings.ok) return settings;

  if (arrayError) return fail(arrayError);

  const pipeline = validatePipeline(contributes.pipeline);
  if (!pipeline.ok) return pipeline;

  const automation = validateAutomation(contributes.automation);
  if (!automation.ok) return automation;

  const services = validateServices(contributes.services);
  if (!services.ok) return services;

  // 尚未在 M1 落地的贡献点：接受但不生效，管理器里会标注"未实现"
  const pending = [];
  for (const key of ['keybindings', 'toolbar', 'statusBar', 'contextMenus', 'timelineOverlays', 'intents', 'llm', 'synthesis']) {
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
        settings: settings.value,
        pipeline: pipeline.value,
        services: services.value,
        automation: automation.value,
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
