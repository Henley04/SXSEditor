'use strict';
/**
 * Local automation bridge (HTTP).
 *
 * Endpoints (loopback only, Bearer token):
 *   GET  /health            liveness + version
 *   GET  /schema            method table with JSON Schema + examples
 *   GET  /events            server-sent events (ui / project / job events)
 *   GET  /jobs, /jobs/:id   background job status
 *   POST /automation        {method, params, async?} -> result or job id
 *
 * The bridge owns validation, auth, rate limiting, auditing and job scheduling;
 * the actual work happens in the renderer (or in mcpWindowOps for things that
 * touch BrowserWindow). Keeping the policy here means every caller — stdio MCP
 * gateway, curl, an agent — gets identical behaviour.
 */

const { IPC_CHANNELS } = require('../shared/ipcChannels');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, BrowserWindow } = require('electron');

const { schema, getMethod, methodNames } = require('../shared/mcpSchema');
const { mapPluginErrorCode } = require('../shared/pluginAutomation');
const { ERR } = require('../shared/modelContract');
const { validateParams } = require('./mcpValidate');
const { McpError, normalizeError } = require('./mcpErrors');
const jobs = require('./mcpJobs');
const windowOps = require('./mcpWindowOps');
const { isSystemPath } = require('./security');

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const LONG_TIMEOUT_MS = 600 * 1000;
const MIDI_MAX_BYTES = 64 * 1024 * 1024;
const RATE_LIMIT = { windowMs: 10 * 1000, max: 120 };

const pending = new Map();

/**
 * 在途 job 的取消开关。job → AbortController。
 *
 * `jobs.cancel` 只改状态是不够的：一个跑十分钟的插件任务必须真的被叫停，
 * 否则"取消"只是让调用方看不到结果，机器还在烧。控制器往 dispatch 里传，
 * 插件侧会收到 abort（见 PluginRuntimeManager.call）。
 */
const activeAborts = new Map();
const sseClients = new Set();
const rateBuckets = new Map();
// token -> { id, name, models }
// models 是 token 的**上限**：'*' | 'provider:<name>' | 'endpoint:<id>'。
// 未配置（[]）= 不能用模型，而不是"不限"——漏配的默认值必须是拒绝。
const tokens = new Map();
let modelService = null;
let modelStreamSeq = 0;
/**
 * 插件自动化方法（M5）。
 *
 * 由 `main.js` 在插件服务初始化后注入：`{ list(): {name: def}, run(name, params) }`。
 * 桥接层不 require 插件服务 —— 那个依赖是双向的（插件服务会用到桥接的事件），
 * 而且单测里要能塞一个假的 provider。
 *
 * **插件方法只走主进程**：它们跑在插件的 utilityProcess 里，不需要任何窗口，
 * 这正是"无界面自动化"的意义。转发给渲染层会让主窗口成为前提，MCP 客户端
 * 关掉窗口就调不动插件了。
 */
let pluginAutomation = null;

function setPluginAutomation(provider) {
  pluginAutomation = provider && typeof provider.list === 'function' && typeof provider.run === 'function'
    ? provider
    : null;
}

/** 当前可用的插件方法表（每次现取：装/卸/停用之后要立刻反映）。 */
function pluginMethodDefs() {
  if (!pluginAutomation) return {};
  try {
    return pluginAutomation.list() || {};
  } catch (err) {
    // 插件服务自己坏了不能连带整张 MCP 方法表一起消失
    console.warn('[MCP] 读取插件自动化方法失败:', err && err.message);
    return {};
  }
}

/** 内置方法优先：插件不能顶掉 `project.get` 这类名字（校验期已拦，这里是兜底）。 */
function resolveMethod(name) {
  return getMethod(name) || pluginMethodDefs()[name] || null;
}

/**
 * 未知方法的提示。
 *
 * 插件方法会随插件消失（停用/卸载/重载），这时"看 /schema"是错的方向 ——
 * 调用方手里那份 schema 可能还是五分钟前的，而它现在调的方法确实不存在了。
 * 分开提示，省掉一轮"我明明在 schema 里见过它"的排查。
 */
function unknownMethodHint(method) {
  if (!getMethod(method) && /^[a-z0-9][a-z0-9._-]*\./.test(String(method || ''))) {
    return 'plugin-provided methods disappear when their plugin is disabled or removed; call capabilities for the current list';
  }
  return 'see GET /schema';
}

/**
 * `GET /schema` 的完整内容：内置表 + 插件贡献。
 *
 * 合并发生在**读取时**而不是启动时：插件可以在应用运行中装卸，schema 是一份
 * 会被 agent 缓存的文档，缓存的唯一可靠版本永远是"现在这一刻"。
 */
function publicSchema() {
  const base = schema();
  const pluginDefs = pluginMethodDefs();
  if (Object.keys(pluginDefs).length) {
    // 不覆盖内置：撞名在 manifest 校验期就被拒了，这里再让一次仍然安全
    for (const [name, def] of Object.entries(pluginDefs)) {
      if (!base.methods[name]) base.methods[name] = def;
    }
  }
  return base;
}

/** 供设置页展示：只给 id/名称/范围，永远不回传 token 本身。 */
function listTokens() {
  return [...tokens.values()].map((info) => ({
    id: info.id, name: info.name, models: Array.isArray(info.models) ? [...info.models] : [],
  }));
}

/** 注入模型服务（main.js 装配后调用）。 */
function setModelService(svc) {
  modelService = svc || null;
}

function tokenIdentity(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

function normalizeModelScopes(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((v) => String(v || '').trim())
    .filter((v) => v === '*' || /^(provider|endpoint):[A-Za-z0-9._:-]{1,160}$/.test(v));
}

/**
 * token scope 只认三种形态，不做前缀通配。
 * `provider:` 只匹配 owner ∈ {builtin,user}：插件注册的端点即使自称 provider=openai，
 * 也不能蹭用户对 OpenAI 的批量授权。
 */
function modelScopeAllows(tokenInfo, endpoint) {
  if (!tokenInfo || !Array.isArray(tokenInfo.models) || !tokenInfo.models.length) return false;
  const scopes = tokenInfo.models;
  if (scopes.includes('*')) return true;
  if (scopes.includes(`endpoint:${endpoint.id}`)) return true;
  if (endpoint.owner !== 'plugin' && scopes.includes(`provider:${endpoint.provider}`)) return true;
  return false;
}

/**
 * 模型域错误码 → MCP 错误码。
 *
 * 两套词表是分开演进的：`PERMISSION_DENIED` / `BACKPRESSURE_OVERFLOW` 这些在
 * 模型契约里各有精确含义，但 McpError 只认自己那张表，不认识的一律塌成
 * INTERNAL/500 —— 客户端就没法区分"被拒了"和"上游炸了"，重试策略全错。
 * 原始码保留在 details.modelCode 里，需要细粒度判断的调用方仍然拿得到。
 */
const MODEL_ERROR_TO_MCP = {
  NEED_ENDPOINT: 'PRECONDITION_FAILED',
  ENDPOINT_UNAVAILABLE: 'PRECONDITION_FAILED',
  ADAPTER_UNSUPPORTED: 'PRECONDITION_FAILED',
  INVALID_REQUEST: 'VALIDATION_ERROR',
  INVALID_RESPONSE: 'INTERNAL',
  PERMISSION_DENIED: 'FORBIDDEN',
  CONSENT_REQUIRED: 'FORBIDDEN',
  CONSENT_TIMEOUT: 'FORBIDDEN',
  BACKPRESSURE_OVERFLOW: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  HANDLE_EXPIRED: 'NOT_FOUND',
  PROTOCOL_VIOLATION: 'INTERNAL',
  UPSTREAM_ERROR: 'INTERNAL',
  CANCELLED: 'CANCELLED',
};

function modelErrorToMcp(info) {
  const src = (info && info.code) || 'UPSTREAM_ERROR';
  const code = MODEL_ERROR_TO_MCP[src] || 'INTERNAL';
  return new McpError(code, (info && info.message) || 'Model call failed', {
    hint: info && info.hint,
    details: { modelCode: src, retryable: info ? info.retryable === true : false },
  });
}


let server = null;
let endpointFile = null;
let sequence = 0;
let auditStream = null;

// ---------------------------------------------------------------- rendering

function mainWindow() {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return wins.find((w) => String(w.webContents.getURL()).includes('/main_window/')) || wins[0] || null;
}

function editorWindow() {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return wins.find((w) => String(w.webContents.getURL()).includes('/fragment_editor_window/')) || null;
}

function targetWindow(target) {
  return target === 'editor' ? editorWindow() : mainWindow();
}

function callRenderer(target, method, params, timeoutMs) {
  const win = targetWindow(target);
  if (!win) {
    throw new McpError('PRECONDITION_FAILED', target === 'editor'
      ? 'No fragment editor window is open; call fragment.open first'
      : 'The main window is unavailable');
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new McpError('TIMEOUT', `Automation timeout after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method, senderId: win.webContents.id });
    win.webContents.send(IPC_CHANNELS.MCP_AUTOMATION_REQUEST, { id, method, params });
  });
}

function registerMcpReplyIpc(ipc) {
  (ipc || ipcMain).on(IPC_CHANNELS.MCP_AUTOMATION_RESPONSE, (e, m) => {
    const p = pending.get(m && m.id);
    if (!p) return;
    // Only the window the request was sent to may answer it: every renderer
    // gets the same IPC channel, and a compromised low-privilege window should
    // not be able to forge results for the main window.
    if (p.senderId !== undefined && e.sender && e.sender.id !== p.senderId) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else {
      const err = m.error && typeof m.error === 'object'
        ? new McpError(m.error.code || 'INTERNAL', m.error.message || 'Automation failed', m.error)
        : new McpError('INTERNAL', String(m.error || 'Automation failed'));
      p.reject(err);
    }
  });

  // Renderer-emitted lifecycle events (project.changed, fragment.opened, …).
  (ipc || ipcMain).on(IPC_CHANNELS.MCP_AUTOMATION_EVENT, (_e, evt) => {
    if (!evt || typeof evt !== 'object') return;
    emit(evt.type || 'event', evt.data || {});
  });
}

// ------------------------------------------------------------------- events

function emit(type, data) {
  const payload = { type, data, at: Date.now() };
  const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch (_) { sseClients.delete(res); }
  }
  return payload;
}

// -------------------------------------------------------------------- audit

function audit(entry) {
  try {
    const file = path.join(app.getPath('userData'), 'mcp-audit.log');
    try {
      const st = fs.statSync(file);
      if (st.size > 5 * 1024 * 1024) {
        // Close before renaming, otherwise the open handle keeps writing to the
        // rotated file and the new log stays empty until restart.
        if (auditStream) { try { auditStream.end(); } catch (_) {} auditStream = null; }
        fs.renameSync(file, `${file}.1`);
      }
    } catch (_) {}
    if (!auditStream) auditStream = fs.createWriteStream(file, { flags: 'a' });
    auditStream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (_) {
    // Auditing must never break the request path.
  }
}

// -------------------------------------------------------------- rate limiting

function rateLimited(token) {
  const now = Date.now();
  const bucket = rateBuckets.get(token) || { start: now, count: 0 };
  if (now - bucket.start > RATE_LIMIT.windowMs) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(token, bucket);
  if (bucket.count > RATE_LIMIT.max) {
    return Math.ceil((bucket.start + RATE_LIMIT.windowMs - now) / 1000);
  }
  return 0;
}

// -------------------------------------------------------------- preconditions

function modelsAvailable() {
  try {
    const { getModelDir } = require('./modelDir');
    const dir = getModelDir();
    const candidates = ['diff_step_dml.onnx', 'diff_step.onnx'];
    return candidates.some((f) => fs.existsSync(path.join(dir, f)));
  } catch (_) {
    return false;
  }
}

function checkPreconditions(def) {
  const requires = def.requires || [];
  if (requires.includes('models') && !modelsAvailable()) {
    throw new McpError('PRECONDITION_FAILED', 'Inference models are not installed', {
      hint: 'open the model download window (ui.open target=modelDownload) and install a precision first',
      details: { requires },
    });
  }
  if (requires.includes('project') && !mainWindow()) {
    throw new McpError('PRECONDITION_FAILED', 'No project window is open');
  }
}

// ---------------------------------------------------------------- dispatch

async function dispatchMain(method, params, ctx = {}) {
  switch (method) {
    case 'schema.get':
      return publicSchema();
    case 'capabilities': {
      const extra = Object.keys(pluginMethodDefs());
      return {
        schemaVersion: schema().version,
        methods: [...methodNames().filter((m) => !getMethod(m).internal), ...extra],
        features: {
          models: modelsAvailable(),
          backend: process.platform === 'win32' ? 'directml-or-cpu' : 'cpu',
          platform: process.platform,
          // 插件可能随时装卸：这个数字让调用方知道要不要重新拉一次 /schema
          pluginMethods: extra.length,
        },
        limits: { rateLimit: RATE_LIMIT, defaultTimeoutMs: DEFAULT_TIMEOUT_MS, longTimeoutMs: LONG_TIMEOUT_MS },
        schemaUrl: '/schema',
        eventsUrl: '/events',
        jobsUrl: '/jobs',
      };
    }
    case 'session.grantRoot':
      return windowOps.grantRoot(params);
    case 'session.roots':
      return windowOps.listRoots();
    case 'session.revokeRoots':
      return windowOps.revokeRoots(params);
    case 'ui.windows':
      return { windows: windowOps.listWindows() };
    case 'ui.resize':
      return windowOps.resizeWindow(params);
    case 'ui.reload':
      return windowOps.reloadWindow(params);
    case 'ui.locale':
      return windowOps.setLocale(params);
    case 'ui.screenshot':
      return windowOps.captureWindow(params);
    case 'jobs.list':
      return { jobs: jobs.list() };
    case 'jobs.get': {
      const job = jobs.get(params.jobId);
      if (!job) throw new McpError('NOT_FOUND', `Unknown job ${params.jobId}`);
      return job;
    }
    case 'jobs.cancel': {
      const r = jobs.cancel(params.jobId);
      if (!r) throw new McpError('NOT_FOUND', `Unknown job ${params.jobId}`);
      // 正在跑的任务：先 abort（真实停止），再把"已经开始停了"告诉调用方。
      // jobs.cancel() 只改状态，返回的 reason 是"跑着的任务停不下来" —— 那是
      // 没有 abort 通道时的老实话。现在真的能停了，就不能把这句话再回给调用方。
      const ac = activeAborts.get(params.jobId);
      if (ac) {
        try { ac.abort(); } catch (_) { /* ignore */ }
        return {
          ...r,
          cancelled: true,
          interrupted: true,
          reason: 'cancellation delivered; the job will settle as cancelled',
        };
      }
      return r;
    }
    case 'midi.importFile':
      return importMidiFile(params);

    case 'model.list': {
      if (!modelService) throw new McpError('UNAVAILABLE', 'Model service is not enabled');
      const listed = modelService.list(ctx.subject, { task: params && params.task });
      const visible = listed.endpoints.filter((ep) => modelScopeAllows(ctx.tokenInfo, ep));
      return { endpoints: visible };
    }

    case 'model.invoke': {
      if (!modelService) throw new McpError('UNAVAILABLE', 'Model service is not enabled');
      const resolved = modelService.resolveEndpoint(params.task, params.endpointId);
      if (!resolved.ok) {
        // 走 modelErrorToMcp，不要直接把模型域错误码塞进 McpError：
        // McpError 只认自己那张表，NEED_ENDPOINT 这类会被塌成 INTERNAL/500，
        // 调用方就分不清"去设置里绑端点"和"宿主炸了"。
        throw modelErrorToMcp({
          code: resolved.error,
          message: resolved.message || 'No endpoint',
          hint: resolved.candidates && resolved.candidates.length
            ? `bind one of: ${resolved.candidates.join(', ')}`
            : 'configure an endpoint for this task in Settings → Models',
        });
      }
      if (!modelScopeAllows(ctx.tokenInfo, resolved.endpoint)) {
        throw new McpError('FORBIDDEN', 'This token is not scoped to that endpoint', {
          hint: `endpoint ${resolved.endpoint.id} is outside the token's model scope`,
        });
      }
      return invokeModelAggregated(modelService, ctx, params);
    }
    case 'model.read': {
      if (!modelService) throw new McpError('UNAVAILABLE', 'Model service is not enabled');
      if (!params || !params.handle) throw new McpError('VALIDATION_ERROR', 'handle is required', { field: 'handle' });
      let r;
      try {
        r = modelService.read(ctx.subject, params.handle);
      } catch (err) {
        // 归属失败与过期必须能分清：前者是越权，后者是"来晚了，重跑一次"
        throw new McpError(err && err.code === ERR.HANDLE_EXPIRED ? 'NOT_FOUND' : 'FORBIDDEN',
          (err && err.message) || 'Cannot read handle',
          { details: { modelCode: err && err.code } });
      }
      if (params.saveAs) {
        if (!path.isAbsolute(String(params.saveAs))) {
          throw new McpError('VALIDATION_ERROR', 'saveAs must be an absolute path', { field: 'saveAs' });
        }
        if (isSystemPath(params.saveAs)) {
          throw new McpError('FORBIDDEN', 'System path not allowed', { field: 'saveAs' });
        }
        await fs.promises.mkdir(path.dirname(params.saveAs), { recursive: true });
        await fs.promises.writeFile(params.saveAs, Buffer.from(r.base64, 'base64'));
        return { size: r.size, mime: r.mime, path: params.saveAs };
      }
      return { size: r.size, mime: r.mime, base64: r.base64 };
    }

    // pipeline.* 管的是本机 ONNX 管线里的模型（显存里有没有加载某个 session），
    // 与 model.* 的远程推理端点完全是两回事。这里复用资源管理器的加载/卸载
    // 辅助函数，不另起一套实现；注册表校验放在主进程，非法 id 直接拒绝。
    case 'pipeline.status': {
      const { getPipelineStatus } = require('./resourceManagerIpc');
      return getPipelineStatus();
    }

    case 'pipeline.load':
    case 'pipeline.unload': {
      const isLoad = method === 'pipeline.load';
      const p = params || {};
      const { getModelGroups, getModelDef } = require('../modelRegistry');
      let targets = null; // null 表示 all:true
      if (p.all !== true) {
        if (!p.group || !p.model) {
          throw new McpError('VALIDATION_ERROR',
            'group and model are required unless all:true is set', { field: 'group' });
        }
        if (!getModelGroups().some((g) => g.id === p.group)) {
          throw new McpError('VALIDATION_ERROR', `Unknown group: ${p.group}`, { field: 'group' });
        }
        if (!getModelDef(p.group, p.model)) {
          throw new McpError('VALIDATION_ERROR',
            `Unknown model: ${p.group}/${p.model}`, { field: 'model' });
        }
        targets = { group: p.group, model: p.model };
      }
      const rm = require('./resourceManagerIpc');
      let result;
      try {
        result = targets === null
          ? await (isLoad ? rm.loadAllPipelineModels() : rm.unloadAllPipelineModels())
          : await (isLoad
            ? rm.loadSingleModel(targets.group, targets.model)
            : rm.unloadSingleModel(targets.group, targets.model));
      } catch (err) {
        // 模型文件缺失 / 未安装是"前置条件不满足"，不是宿主内部故障。原样冒泡
        // 会被 normalizeError 塌成 INTERNAL/500，调用方会把"去下载模型"误判成
        // "宿主炸了"，重试策略必然做错（与 model.invoke 的 NEED_ENDPOINT 同类）。
        const msg = String((err && err.message) || err);
        const precondition = /Model file does not exist|ENOENT|not installed|not found/i.test(msg);
        throw new McpError(precondition ? 'PRECONDITION_FAILED' : 'INTERNAL', msg,
          precondition ? { hint: 'install the local ONNX models first (ui.open target=modelDownload)' } : {});
      }
      if (result && result.success === false) {
        throw new McpError('PRECONDITION_FAILED', result.error || `${method} failed`);
      }
      return { ok: true, target: targets || 'all', errors: (result && result.errors) || [] };
    }

    default:
      throw new McpError('UNKNOWN_METHOD', `Unknown method ${method}`, { hint: 'see GET /schema' });
  }
}

async function importMidiFile(params) {
  if (isSystemPath(params.path)) throw new McpError('FORBIDDEN', 'System path not allowed', { field: 'path' });
  const st = await fs.promises.stat(params.path).catch(() => null);
  if (!st || !st.isFile()) throw new McpError('NOT_FOUND', 'File not found', { field: 'path' });
  if (st.size > MIDI_MAX_BYTES) {
    throw new McpError('VALIDATION_ERROR', `MIDI file exceeds ${MIDI_MAX_BYTES / 1024 / 1024} MiB`, { field: 'path' });
  }
  const b = await fs.promises.readFile(params.path);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const { parseMidiFile, parseMidiFileMultiTrack, parseMidiProjectInfo } = require('../inference/midiParser');
  const tracks = params.multiTrack === false
    ? [{ name: params.name || 'MIDI', notes: parseMidiFile(ab) }]
    : parseMidiFileMultiTrack(ab);
  let projectInfo = null;
  try { projectInfo = parseMidiProjectInfo(ab); } catch (_) {}
  return callRenderer('renderer', 'midi.importParsed', { ...params, tracks, projectInfo }, LONG_TIMEOUT_MS);
}

function withTimeout(promise, ms, method) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new McpError('TIMEOUT', `Timeout after ${ms}ms: ${method}`)), ms);
      // Do not keep the event loop alive just for the timer.
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

/**
 * MCP 是请求-响应：把流聚合成一个结果再返回。
 * 真正长的生成建议客户端用 async:true 提交成 job（def.long = true 时可用）。
 */
function invokeModelAggregated(service, ctx, params) {
  const streamKey = `mcp${++modelStreamSeq}`;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const r = service.invoke(ctx.subject, params, {
      via: 'mcp',
      streamKey,
      onEvent: (evt) => {
        if (evt.type === 'chunk') {
          chunks.push(evt.data == null ? '' : String(evt.data));
          // 聚合模式也必须回执：不回执的话网关会认为消费方卡住，32 个分片后
          // 就把生产方暂停，最后变成一个莫名其妙的总时长超时。
          if (evt.handleId) service.ack(ctx.subject, evt.handleId, evt.bytes || 0);
          return;
        }
        if (evt.type === 'done') {
          const out = { text: chunks.join(''), endpointId: evt.endpointId || '' };
          // 二进制结果二选一：小的内联 base64，大的给句柄（再走 model.read）
          if (evt.binary) out.binary = evt.binary;
          if (evt.handle) out.handle = evt.handle;
          done(resolve, out);
          return;
        }
        if (evt.type === 'error') {
          done(reject, modelErrorToMcp(evt.error));
          return;
        }
        if (evt.type === 'cancelled') {
          done(reject, new McpError('CANCELLED', 'Model call cancelled'));
        }
      },
    });
    if (r && r.error) {
      done(reject, modelErrorToMcp(r.error));
    }
  });
}

async function dispatch(method, params, ctx = {}) {
  const def = resolveMethod(method);
  if (!def || def.internal) {
    throw new McpError('UNKNOWN_METHOD', `Unknown method ${method}`, { hint: unknownMethodHint(method) });
  }

  const checked = validateParams(def, params);
  if (!checked.ok) {
    const first = checked.errors[0];
    throw new McpError('VALIDATION_ERROR', `${first.field}: ${first.message}`, {
      field: first.field,
      hint: first.hint,
      details: { errors: checked.errors.slice(0, 20) },
    });
  }
  checkPreconditions(def);

  const timeoutMs = def.long ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

  // 插件方法：直接派发到插件运行时，不经任何窗口。
  if (def.target === 'plugin') {
    if (!pluginAutomation) {
      throw new McpError('PRECONDITION_FAILED', 'The plugin system is not available', {
        hint: 'plugin automation methods come from installed plugins; start the app with plugins enabled',
      });
    }
    const r = await withTimeout(pluginAutomation.run(method, checked.value, {
      // 进度与取消只在长任务上有实际效果；短命令忽略这两个字段即可。
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    }), timeoutMs, method);
    if (!r || r.ok !== true) {
      const info = (r && r.error) || {};
      throw new McpError(mapPluginErrorCode(info.code), info.message || `Plugin method ${method} failed`, {
        details: { pluginCode: info.code || null, method },
      });
    }
    return { result: r.result === undefined ? null : r.result, warnings: checked.warnings };
  }

  const result = def.target === 'main'
    ? await withTimeout(dispatchMain(method, checked.value, ctx), timeoutMs, method)
    : await callRenderer(def.target, method, checked.value, timeoutMs);

  return { result, warnings: checked.warnings };
}

function runJob(job, method, params, ctx = {}) {
  if (job.cancelRequested) return;
  const ac = new AbortController();
  activeAborts.set(job.id, ac);
  jobs.start(job.id);
  emit('job.started', { jobId: job.id, method });
  dispatch(method, params, {
    ...ctx,
    signal: ac.signal,
    // 进度直接进 job 快照，同时通过 /events 广播：轮询与订阅两种客户端
    // 都该看到同一条进度，而不是只有订阅者能看见。
    onProgress: (p) => {
      const saved = jobs.progress(job.id, p);
      if (saved) emit('job.progress', { jobId: job.id, method, progress: saved });
    },
  })
    .then(({ result, warnings }) => {
      const done = jobs.finish(job.id, { result: warnings && warnings.length ? { result, warnings } : result });
      if (done) emit('job.completed', { jobId: job.id, method, status: done.status });
    })
    .catch((err) => {
      const e = normalizeError(err);
      const done = jobs.finish(job.id, { error: e.toJSON() });
      if (done) emit('job.failed', { jobId: job.id, method, status: done.status, error: e.toJSON() });
    })
    .finally(() => activeAborts.delete(job.id));
}

// ------------------------------------------------------------------- http

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err, requestId) {
  const e = normalizeError(err);
  sendJson(res, e.status, { ok: false, error: e.toJSON(), requestId });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new McpError('VALIDATION_ERROR', 'Request exceeds 32 MiB'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch (e) { reject(new McpError('VALIDATION_ERROR', `Invalid JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function tokenFrom(req, url) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1];
  // EventSource cannot set headers; the SSE endpoint accepts ?token= instead.
  if (url && url.pathname === '/events') return url.searchParams.get('token') || '';
  return '';
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const remote = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Loopback only' } });
  }

  const token = tokenFrom(req, url);
  if (!tokens.has(token)) {
    return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } });
  }
  const tokenInfo = tokens.get(token);
  const tokenName = tokenInfo.name;

  if (url.pathname !== '/health') {
    const retryAfter = rateLimited(token);
    if (retryAfter) {
      audit({ token: tokenName, method: 'rate-limited', ok: false, code: 'RATE_LIMITED' });
      res.setHeader('retry-after', String(retryAfter));
      return sendJson(res, 429, {
        ok: false,
        error: { code: 'RATE_LIMITED', message: `Too many requests; retry in ${retryAfter}s` },
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, version: app.getVersion(), schemaVersion: schema().version, pid: process.pid, uptime: process.uptime() });
  }

  if (req.method === 'GET' && url.pathname === '/schema') {
    return sendJson(res, 200, { ok: true, result: publicSchema() });
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, version: schema().version })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 20000);
    const cleanup = () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    };
    req.on('close', cleanup);
    // Socket errors are asynchronous: emit()'s try/catch cannot see them, and an
    // unhandled 'error' on the response would take the main process down.
    res.on('error', cleanup);
    res.on('close', cleanup);
    return undefined;
  }

  if (req.method === 'GET' && url.pathname === '/jobs') {
    return sendJson(res, 200, { ok: true, result: { jobs: jobs.list() } });
  }

  const jobMatch = /^\/jobs\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) return sendError(res, new McpError('NOT_FOUND', 'Unknown job'), null);
    return sendJson(res, 200, { ok: true, result: job });
  }

  if (req.method === 'POST' && url.pathname === '/automation') {
    const started = Date.now();
    let requestId = null;
    let methodName = 'unknown';
    try {
      const body = await readBody(req);
      requestId = body.requestId || null;
      if (!body.method || typeof body.method !== 'string') {
        throw new McpError('VALIDATION_ERROR', 'method is required', { field: 'method' });
      }
      methodName = body.method;

      // Forgiving alias: `async` belongs at the top level, but clients routinely
      // put it inside params. Hoist it rather than failing with "unknown parameter".
      let isAsync = body.async === true;
      if (body.params && typeof body.params === 'object' && body.params.async !== undefined) {
        isAsync = body.params.async === true;
        delete body.params.async;
      }

      const def = resolveMethod(methodName);
      if (!def || def.internal) {
        throw new McpError('UNKNOWN_METHOD', `Unknown method ${methodName}`, { hint: unknownMethodHint(methodName) });
      }

      if (isAsync) {
        const checked = validateParams(def, body.params);
        if (!checked.ok) {
          const first = checked.errors[0];
          throw new McpError('VALIDATION_ERROR', `${first.field}: ${first.message}`, { field: first.field, details: { errors: checked.errors.slice(0, 20) } });
        }
        checkPreconditions(def);
        // 插件方法只在作者声明 `long: true` 时可异步提交。这条限制不是出于
        // 安全考虑，而是"job 是给等不起的调用用的"：一旦所有方法都可异步，
        // agent 会习惯于全部 async 提交，从而丢掉"这条到底慢不慢"的信号。
        if (def.target === 'plugin' && def.async !== true) {
          throw new McpError('VALIDATION_ERROR', `${methodName} cannot be submitted as a job`, {
            field: 'async',
            hint: 'the plugin command must declare "long": true to be submitted with async:true',
          });
        }
        const job = jobs.create(methodName);
        sendJson(res, 202, { ok: true, result: { jobId: job.id, status: job.status, poll: `/jobs/${job.id}` }, requestId });
        runJob(job, methodName, checked.value, { tokenInfo, subject: `mcp:${tokenInfo.id}` });
        audit({ token: tokenName, method: methodName, ok: true, async: true, jobId: job.id, ms: Date.now() - started });
        return undefined;
      }

      const { result, warnings } = await dispatch(methodName, body.params || {}, {
        tokenInfo, subject: `mcp:${tokenInfo.id}`,
      });
      audit({ token: tokenName, method: methodName, ok: true, ms: Date.now() - started });
      return sendJson(res, 200, { ok: true, result, warnings: warnings.length ? warnings : undefined, requestId });
    } catch (err) {
      const e = normalizeError(err);
      audit({ token: tokenName, method: methodName, ok: false, code: e.code, ms: Date.now() - started, message: e.message });
      return sendError(res, e, requestId);
    }
  }

  return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
}

// ------------------------------------------------------------------ startup

function loadTokens(primary) {
  // 主 token 是用户自己从设置里复制的那个，给全量模型范围；真正的花钱动作仍要过
  // ACL 的首次确认，所以"给 * "不会静默扣费。
  tokens.set(primary, { id: tokenIdentity(primary), name: 'default', models: ['*'] });
  try {
    const file = path.join(app.getPath('userData'), 'mcp-tokens.json');
    const extra = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const t of extra.tokens || []) {
      if (t && typeof t.token === 'string' && t.token.length >= 16) {
        tokens.set(t.token, {
          id: tokenIdentity(t.token),
          name: t.name || 'extra',
          // 没写 models 的 token = 不能调模型（默认拒绝，不是默认全开）
          models: normalizeModelScopes(t.models),
        });
      }
    }
  } catch (_) {
    // Optional file; absence is the normal case.
  }
}

async function startMcpBridge() {
  if (server) return;
  const primary = crypto.randomBytes(32).toString('hex');
  loadTokens(primary);

  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try { sendError(res, err, null); } catch (_) {}
    });
  });

  // Generous headers timeout: a synthesis call can legitimately sit for minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 65 * 1000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  endpointFile = path.join(app.getPath('userData'), 'mcp-endpoint.json');
  const tmp = `${endpointFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    port,
    token: primary,
    pid: process.pid,
    version: app.getVersion(),
    schemaVersion: schema().version,
    // Only the default token is published. Named tokens stay in mcp-tokens.json
    // so a reader of this file cannot impersonate every configured client.
    urls: { schema: '/schema', events: '/events', jobs: '/jobs', automation: '/automation' },
  }), { mode: 0o600 });
  fs.renameSync(tmp, endpointFile);

  emit('bridge.started', { port, schemaVersion: schema().version });
  console.log(`[MCP] bridge listening on 127.0.0.1:${port} (schema ${schema().version})`);
}

function stopMcpBridge() {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new McpError('CANCELLED', 'MCP stopped'));
  }
  pending.clear();
  for (const res of sseClients) {
    try { res.end(); } catch (_) {}
  }
  sseClients.clear();
  if (auditStream) {
    try { auditStream.end(); } catch (_) {}
    auditStream = null;
  }
  if (server) server.close();
  server = null;
  try { if (endpointFile) fs.unlinkSync(endpointFile); } catch (_) {}
}

module.exports = {
  setModelService,
  setPluginAutomation,
  listTokens,
  registerMcpReplyIpc,
  startMcpBridge,
  stopMcpBridge,
  emit,
  // exported for tests / diagnostics
  _internal: {
    dispatch, handle, tokens, modelsAvailable, modelScopeAllows, normalizeModelScopes,
    publicSchema, pluginMethodDefs, resolveMethod, setPluginAutomation, modelErrorToMcp,
  },
};
