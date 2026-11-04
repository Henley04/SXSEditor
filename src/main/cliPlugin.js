'use strict';
/**
 * `--cli plugin` —— 插件自动化面的命令行入口。
 *
 * 为什么不是"再写一套插件加载逻辑"：插件方法能不能调，取决于**运行中的那个
 * 进程**（插件是否被加载、插件进程是否活着、用户开关是否打开），而磁盘上的
 * registry.json 只是快照。所以这里的默认路径是**转发给已运行的实例**，走的是
 * MCP 用的同一条 `/automation` 通道 —— 同一个 `dispatch`、同一套权限门、同一份
 * 审计。CLI 只是"不需要配 token 的 MCP 客户端"。
 *
 * 只有当探测不到运行实例时才 `--local`：起一个临时 PluginService，跑完就拆。
 * 它会 fork 自己的一套插件进程，因此不能和 GUI 共享插件内存状态；这一条在
 * 输出里会说清楚，不含糊。
 *
 * 三条通道的分工：
 *   · `list`      —— 元数据读磁盘（装了什么是磁盘事实），运行态来自 capabilities
 *                    （现在能调什么是运行时事实）。两列并排，不混为一谈。
 *   · `methods`   —— live：读 `/schema` 里 `target: "plugin"` 的条目，与 agent
 *                    看到的能力表逐字一致；本地：init 后走 `listAutomationMethods`。
 *   · `call`      —— live：POST `/automation`；本地：`runAutomationMethod`。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { validateManifest, isLegacyManifest } = require('../shared/pluginManifest.js');

const PROBE_TIMEOUT_MS = 1500;

/**
 * 宿主版本参与 manifest 的 engines 校验。
 *
 * 单独抽出来并留一个测试钩子：单测里 `require('electron')` 拿到的是可执行文件
 * 路径字符串，不是 `{ app }`。返回 '0.0.0' 会让所有插件在 engines 检查里判死，
 * 于是"列插件"这一层就完全测不到了。
 */
let _appVersionForTests = null;
function hostAppVersion() {
  if (_appVersionForTests) return _appVersionForTests;
  try {
    const { app } = require('electron');
    if (app && typeof app.getVersion === 'function') return app.getVersion();
  } catch (_) { /* 不在 Electron 里 */ }
  return '0.0.0';
}
function _setAppVersionForTests(v) { _appVersionForTests = v || null; }
// 插件命令在宿主侧的上限是 60s（TIMEOUTS.command），客户端留一点余量。
const CALL_TIMEOUT_MS = 65000;

// ---------------------------------------------------------------- 端点发现

/**
 * 与 scripts/sxseditor-mcp.js 相同的候选路径。
 *
 * 这里不 require 那个脚本：它是 stdio 网关的入口，加载即执行；为了三行路径解析
 * 把整个 MCP server 拉进 CLI 进程不划算。
 */
function endpointCandidates() {
  const out = [];
  if (process.env.SXSEDITOR_MCP_ENDPOINT) out.push(process.env.SXSEDITOR_MCP_ENDPOINT);
  if (process.platform === 'win32' && process.env.APPDATA) {
    out.push(path.join(process.env.APPDATA, 'SXSEditor', 'mcp-endpoint.json'));
  }
  if (process.platform === 'darwin') {
    out.push(path.join(os.homedir(), 'Library', 'Application Support', 'SXSEditor', 'mcp-endpoint.json'));
  }
  out.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'SXSEditor', 'mcp-endpoint.json'));
  return out;
}

function readEndpointFile() {
  // 显式指定就只认它：否则测试/脚本指向一个"故意不存在"的文件时，会继续去读
  // 用户真实的 endpoint 并悄悄连上 GUI —— 那是最难查的一类行为。
  if (process.env.SXSEDITOR_MCP_ENDPOINT) {
    try {
      const e = JSON.parse(fs.readFileSync(process.env.SXSEDITOR_MCP_ENDPOINT, 'utf8'));
      if (e && e.port && e.token) return { ...e, file: process.env.SXSEDITOR_MCP_ENDPOINT };
    } catch (_) { /* 指定了但不可用 → 当作没有实例 */ }
    return null;
  }
  for (const p of endpointCandidates()) {
    try {
      const e = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (e && e.port && e.token) return { ...e, file: p };
    } catch (_) { /* 下一个 */ }
  }
  return null;
}

function request(endpoint, method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { authorization: `Bearer ${endpoint.token}` };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port: endpoint.port,
      path: urlPath,
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = { raw: text }; }
        if (res.statusCode >= 400 || parsed.ok === false) {
          const info = parsed.error || { code: 'HTTP_ERROR', message: `HTTP ${res.statusCode}` };
          const err = new Error(`${info.code || 'ERROR'}: ${info.message || text}`);
          Object.assign(err, info, { status: res.statusCode });
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`TIMEOUT: ${urlPath} 超过 ${timeoutMs}ms 未响应`), { code: 'TIMEOUT' }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 探测运行中的实例。
 *
 * 只信"真能应答"的端点：端口文件可能是上次崩溃留下的，connect 被拒就当作没有
 * 实例（而不是让命令悬在那里等超时）。`/health` 也要 token —— 这正是我们要验的
 * 第二件事：token 过期（重启后重写）时应该立刻落到本地路径，而不是报 401。
 */
async function probeLive() {
  const endpoint = readEndpointFile();
  if (!endpoint) return null;
  try {
    const health = await request(endpoint, 'GET', '/health', undefined, PROBE_TIMEOUT_MS);
    return { ...endpoint, health: health.result || health };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- 本地实例

/**
 * 起一个临时 PluginService。
 *
 * `getMainWindow: () => null`：CLI 没有窗口，插件的 `ctx.ui.*` 会广播给零个窗口，
 * 这是预期行为（不是错误）。`models: null`：插件调 `models.*` 会得到 UNSUPPORTED，
 * 而不是为了跑一条 `stats` 命令去起整套模型网关。
 */
async function withLocalService(fn) {
  const { PluginService } = require('./plugins/PluginService.js');
  const { getLocale } = require('./locale');
  const service = new PluginService();
  service.init({ getMainWindow: () => null, locale: getLocale(), models: null });
  try {
    return await fn(service);
  } finally {
    // 必须显式拆：CLI 走 app.exit()，不会触发 before-quit，漏掉这一步会留下
    // utilityProcess 子进程，表现为"命令结束了但进程还在"。
    try { await service.disposeAll(); } catch (_) { /* 退出路径不抛 */ }
  }
}

// ---------------------------------------------------------------- 磁盘快照

/**
 * 只读扫描：装了哪些插件、磁盘上的启用状态。
 *
 * 不做 init —— 列个名字不该 fork 每个插件的进程。代价是这里只能报"磁盘状态"
 * （enabled / disabled / quarantined），不能报 loaded：后者是运行时事实，
 * 由 `list` 的 live 列负责。
 */
function scanInstalled() {
  const installer = require('./plugins/PluginInstaller.js');
  const store = require('./plugins/PluginStateStore.js');
  const registry = store.readRegistry();
  const rows = [];

  for (const item of installer.scanPlugins()) {
    if (!item.manifest || isLegacyManifest(item.manifest)) continue;
    const checked = validateManifest(item.manifest, {
      dirName: item.dirName,
      appVersion: hostAppVersion(),
    });
    if (!checked.ok) {
      rows.push({
        id: item.dirName,
        name: item.dirName,
        version: '',
        status: 'invalid',
        error: checked.error,
        automation: null,
        declaredMethods: [],
      });
      continue;
    }
    const m = checked.value;
    const state = store.getPluginState(registry, m.id);
    let status = 'enabled';
    if (state.quarantined) status = 'quarantined';
    else if (state.enabled === false) status = 'disabled';

    const auto = m.contributes.automation || { methods: [], expose: true };
    const declared = auto.expose === false ? [] : auto.methods;
    rows.push({
      id: m.id,
      name: pickName(m.name, m.id),
      version: m.version,
      status,
      // 用户开关是"事后说不"；作品声明是"事前说可以"。两者都开才算暴露。
      automation: declared.length === 0
        ? null
        : (state.automationExpose === false ? 'off' : 'on'),
      declaredMethods: declared.map((localId) => `${m.id}.${localId}`),
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

function pickName(name, fallback) {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') return name['zh-CN'] || name.en || fallback;
  return fallback;
}

// ---------------------------------------------------------------- 输出

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printTable(rows, liveMethods) {
  if (!rows.length) {
    process.stdout.write('No plugins installed.\n');
    return;
  }
  const idW = Math.max(...rows.map((r) => r.id.length), 4);
  const verW = Math.max(...rows.map((r) => (r.version || '-').length), 3);
  const stW = Math.max(...rows.map((r) => r.status.length), 6);

  for (const r of rows) {
    const live = liveMethods
      ? liveMethods.filter((m) => m.startsWith(`${r.id}.`))
      : null;
    const parts = [
      r.id.padEnd(idW),
      `v${(r.version || '-').padEnd(verW)}`,
      r.status.padEnd(stW),
      `automation:${r.automation || '--'}`.padEnd(19),
      live ? `live:${live.length ? ` ${live.join(' ')}` : ' (none)'}` : 'live: ?',
    ];
    process.stdout.write(`  ${parts.join('  ')}${r.error ? `\n    ! ${r.error}` : ''}\n`);
  }
}

// ---------------------------------------------------------------- 命令实现

async function cmdList(opts) {
  const rows = scanInstalled();
  const live = opts.local ? null : await probeLive();

  let liveMethods = null;
  if (live) {
    try {
      // 不能用 capabilities.methods：那是全部方法名（含 project.get 这类内置的），
      // 按"带点"筛会把内置方法也算成插件方法。/schema 的 target 才是权威标记。
      const s = await request(live, 'GET', '/schema', undefined, 5000);
      const methods = (s.result && s.result.methods) || {};
      liveMethods = Object.keys(methods).filter((n) => methods[n] && methods[n].target === 'plugin');
    } catch (_) { /* 探测成功但 /schema 失败：当作没有 live 列 */ }
  }

  if (opts.json) {
    printJson({
      instance: live ? { port: live.port, pid: live.health.pid, version: live.health.version } : null,
      plugins: rows.map((r) => ({
        ...r,
        // 运行态只在真的拿到 capabilities 时才有意义，否则是 null 而不是 false。
        live: liveMethods ? liveMethods.filter((m) => m.startsWith(`${r.id}.`)) : null,
      })),
    });
    return 0;
  }

  const online = live
    ? `live instance on port ${live.port} (pid ${live.health.pid || '?'})`
    : 'no running instance (disk state only)';
  process.stdout.write(`SXSEditor plugins — ${rows.length} on disk, ${online}\n\n`);
  printTable(rows, liveMethods);
  if (!live) {
    process.stdout.write('\nRun with the app open, or use `--local` for a temporary instance.\n');
  }
  return 0;
}

async function cmdMethods(opts) {
  const live = opts.local ? null : await probeLive();
  let entries = [];

  if (live) {
    // 与 agent 看到的是同一份：/schema 里 target === 'plugin' 的条目。
    const schema = await request(live, 'GET', '/schema', undefined, 5000);
    const methods = (schema.result && schema.result.methods) || {};
    for (const [name, def] of Object.entries(methods)) {
      if (!def || def.target !== 'plugin') continue;
      entries.push({
        name,
        summary: def.summary || '',
        description: def.description || '',
        pluginId: def.pluginId || (def.source || '').replace(/^plugin:/, ''),
        source: def.source || '',
      });
    }
  } else {
    entries = await withLocalService((service) => {
      const defs = service.listAutomationMethods();
      return Object.entries(defs).map(([name, def]) => ({
        name,
        summary: def.summary || '',
        description: def.description || '',
        pluginId: def.pluginId || '',
        source: def.source || '',
      }));
    });
  }

  if (opts.plugin) {
    entries = entries.filter((e) => e.pluginId === opts.plugin);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (opts.json) {
    printJson({ instance: live ? { port: live.port } : null, methods: entries });
    return 0;
  }

  if (!entries.length) {
    process.stdout.write(opts.plugin
      ? `No automation methods exposed by ${opts.plugin}.\n`
      : 'No automation methods exposed by any installed plugin.\n');
    return 0;
  }

  const w = Math.max(...entries.map((e) => e.name.length));
  for (const e of entries) {
    process.stdout.write(`  ${e.name.padEnd(w)}  ${e.summary}\n`);
    if (e.description) process.stdout.write(`  ${' '.repeat(w)}  ${e.description}\n`);
    process.stdout.write(`  ${' '.repeat(w)}  [${e.source}]\n`);
  }
  process.stdout.write(`\n${entries.length} method(s)${live ? '' : ' (temporary local instance — plugin state is not shared with the GUI)'}\n`);
  return 0;
}

async function cmdCall(opts) {
  const method = opts._[0];
  if (!method) {
    process.stderr.write('[ARG ERROR] plugin call 需要方法名，例如 example-sv2.stats\n');
    return 2;
  }
  if (!/^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*$/i.test(method)) {
    process.stderr.write(`[ARG ERROR] 方法名必须是 <pluginId>.<commandId>：${method}\n`);
    return 2;
  }

  let params = {};
  if (opts.params !== undefined) {
    if (opts.params === '-') {
      params = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } else {
      params = JSON.parse(opts.params);
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      process.stderr.write('[ARG ERROR] --params 必须是 JSON 对象\n');
      return 2;
    }
  }

  const live = opts.local ? null : await probeLive();
  let result;
  let warnings = null;

  if (live) {
    process.stderr.write(`[via live instance :${live.port}]\n`);
    const r = await request(live, 'POST', '/automation', { method, params }, CALL_TIMEOUT_MS);
    result = r.result;
    warnings = r.warnings || null;
  } else {
    process.stderr.write('[via temporary local instance]\n');
    const r = await withLocalService((service) => service.runAutomationMethod(method, params));
    if (!r || r.ok !== true) {
      const err = (r && r.error) || { code: 'INTERNAL', message: '插件调用失败' };
      process.stderr.write(`[ERROR] ${err.code}: ${err.message}\n`);
      return 1;
    }
    result = r.result;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, result, ...(warnings ? { warnings } : {}) })}\n`);
  } else {
    printJson(result === undefined ? null : result);
  }
  for (const w of warnings || []) process.stderr.write(`[WARN] ${w}\n`);
  return 0;
}

async function cmdAutomation(opts) {
  const [pluginId, action] = opts._;
  if (!pluginId || !action || !['on', 'off'].includes(action)) {
    process.stderr.write('[ARG ERROR] 用法：plugin automation <pluginId> on|off\n');
    return 2;
  }
  const enabled = action === 'on';

  // 只写状态，不起 PluginService：为了改一个布尔值去 fork 每个插件的进程没有意义，
  // 而且 init() 的 loadAll 还会反过来用磁盘状态覆盖返回值。
  const store = require('./plugins/PluginStateStore.js');
  const row = scanInstalled().find((r) => r.id === pluginId);
  if (!row) {
    process.stderr.write(`[ERROR] NOT_FOUND: 未安装插件 ${pluginId}\n`);
    return 1;
  }
  const registry = store.readRegistry();
  store.setPluginState(registry, pluginId, { automationExpose: enabled });
  store.writeRegistry(registry);
  // `via` 进审计：同一天里 GUI 点的开关与脚本写的开关必须能分开。
  store.audit('automation', pluginId, { expose: enabled, via: 'cli' });

  // 运行中的实例读的是自己的内存投影，改文件不会让它重新读盘。这里不假装
  // 生效了 —— 用户需要重载插件或重启，才能让"关掉"真的挡住调用。
  const live = opts.local ? null : await probeLive();
  const note = live
    ? `已写入；运行中的实例（:${live.port}）需要重载插件或重启后生效。`
    : '已写入。';

  if (opts.json) {
    printJson({ ok: true, pluginId, expose: enabled, needsReload: !!live, runningInstancePort: live ? live.port : null });
  } else {
    process.stdout.write(`${pluginId}: automation ${enabled ? 'on' : 'off'} — ${note}\n`);
  }
  if (live) process.stderr.write(`[WARN] ${note}\n`);
  return 0;
}

// ---------------------------------------------------------------- 分发

/**
 * @param {string[]} rest `plugin` 之后的 token
 * @param {object} opts   cli.js 解析出的通用选项
 */
async function runPluginCommand(rest, opts) {
  const sub = rest[0] || 'list';
  const tail = rest.slice(1);
  const merged = { ...opts, _: tail };

  try {
    switch (sub) {
      case 'list': case 'ls': return await cmdList(merged);
      case 'methods': case 'method': return await cmdMethods(merged);
      case 'call': case 'invoke': return await cmdCall(merged);
      case 'automation': return await cmdAutomation(merged);
      default:
        process.stderr.write(`Unknown plugin subcommand: ${sub}\n`);
        process.stderr.write('Usage: --cli plugin <list|methods|call|automation> [options]\n');
        return 2;
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      process.stderr.write(`[ARG ERROR] JSON 解析失败：${err.message}\n`);
      return 2;
    }
    process.stderr.write(`[ERROR] ${err.code ? `${err.code}: ` : ''}${err.message}\n`);
    return 1;
  }
}

module.exports = { runPluginCommand, scanInstalled, _setAppVersionForTests };
