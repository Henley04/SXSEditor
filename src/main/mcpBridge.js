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
const sseClients = new Set();
const rateBuckets = new Map();
const tokens = new Map(); // token -> name

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

async function dispatchMain(method, params) {
  switch (method) {
    case 'schema.get':
      return schema();
    case 'capabilities':
      return {
        schemaVersion: schema().version,
        methods: methodNames().filter((m) => !getMethod(m).internal),
        features: {
          models: modelsAvailable(),
          backend: process.platform === 'win32' ? 'directml-or-cpu' : 'cpu',
          platform: process.platform,
        },
        limits: { rateLimit: RATE_LIMIT, defaultTimeoutMs: DEFAULT_TIMEOUT_MS, longTimeoutMs: LONG_TIMEOUT_MS },
        schemaUrl: '/schema',
        eventsUrl: '/events',
        jobsUrl: '/jobs',
      };
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
      return r;
    }
    case 'midi.importFile':
      return importMidiFile(params);
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

async function dispatch(method, params) {
  const def = getMethod(method);
  if (!def || def.internal) {
    throw new McpError('UNKNOWN_METHOD', `Unknown method ${method}`, { hint: 'see GET /schema' });
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
  const result = def.target === 'main'
    ? await withTimeout(dispatchMain(method, checked.value), timeoutMs, method)
    : await callRenderer(def.target, method, checked.value, timeoutMs);

  return { result, warnings: checked.warnings };
}

function runJob(job, method, params) {
  if (job.cancelRequested) return;
  jobs.start(job.id);
  emit('job.started', { jobId: job.id, method });
  dispatch(method, params)
    .then(({ result, warnings }) => {
      const done = jobs.finish(job.id, { result: warnings && warnings.length ? { result, warnings } : result });
      if (done) emit('job.completed', { jobId: job.id, method, status: done.status });
    })
    .catch((err) => {
      const e = normalizeError(err);
      const done = jobs.finish(job.id, { error: e.toJSON() });
      if (done) emit('job.failed', { jobId: job.id, method, status: done.status, error: e.toJSON() });
    });
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
  const tokenName = tokens.get(token);

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
    return sendJson(res, 200, { ok: true, result: schema() });
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

      const def = getMethod(methodName);
      if (!def || def.internal) {
        throw new McpError('UNKNOWN_METHOD', `Unknown method ${methodName}`, { hint: 'see GET /schema' });
      }

      if (isAsync) {
        const checked = validateParams(def, body.params);
        if (!checked.ok) {
          const first = checked.errors[0];
          throw new McpError('VALIDATION_ERROR', `${first.field}: ${first.message}`, { field: first.field, details: { errors: checked.errors.slice(0, 20) } });
        }
        checkPreconditions(def);
        const job = jobs.create(methodName);
        sendJson(res, 202, { ok: true, result: { jobId: job.id, status: job.status, poll: `/jobs/${job.id}` }, requestId });
        runJob(job, methodName, checked.value);
        audit({ token: tokenName, method: methodName, ok: true, async: true, jobId: job.id, ms: Date.now() - started });
        return undefined;
      }

      const { result, warnings } = await dispatch(methodName, body.params || {});
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
  tokens.set(primary, 'default');
  try {
    const file = path.join(app.getPath('userData'), 'mcp-tokens.json');
    const extra = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const t of extra.tokens || []) {
      if (t && typeof t.token === 'string' && t.token.length >= 16) {
        tokens.set(t.token, t.name || 'extra');
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
  registerMcpReplyIpc,
  startMcpBridge,
  stopMcpBridge,
  emit,
  // exported for tests / diagnostics
  _internal: { dispatch, handle, tokens, modelsAvailable },
};
