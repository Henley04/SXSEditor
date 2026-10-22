#!/usr/bin/env node
'use strict';
// SXSEditor MCP stdio gateway.
//
// Bridges JSON-RPC (stdin/stdout) to the running application's local automation
// bridge. Tool definitions are generated from src/shared/mcpSchema.js, so the
// schemas an MCP client sees are the same ones the bridge validates against —
// there is no second hand-maintained list to drift.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { schema } = require('../src/shared/mcpSchema');

function endpoint() {
  const candidates = [];
  if (process.env.SXSEDITOR_MCP_ENDPOINT) candidates.push(process.env.SXSEDITOR_MCP_ENDPOINT);
  if (process.platform === 'win32' && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'SXSEditor', 'mcp-endpoint.json'));
  if (process.platform === 'darwin') candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'SXSEditor', 'mcp-endpoint.json'));
  candidates.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'SXSEditor', 'mcp-endpoint.json'));
  for (const p of candidates) {
    try {
      const e = JSON.parse(fs.readFileSync(p));
      if (e.port && e.token) return e;
    } catch (_) {}
  }
  throw new Error('Start SXSEditor first; MCP endpoint not found');
}

function request(method, urlPath, body) {
  const e = endpoint();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${e.token}` };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port: e.port,
      path: urlPath,
      method,
      headers,
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
        resolve(parsed.result !== undefined ? parsed.result : parsed);
      });
    });
    // The bridge's own timeout is 600s for long methods; stay slightly above it.
    req.setTimeout(605000, () => req.destroy(new Error('Timeout waiting for SXSEditor')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const call = (method, params = {}) => request('POST', '/automation', { method, params });

// ---------------------------------------------------------------- tool table

const METHOD_ALIASES = {
  sxseditor_get_project: 'project.get',
  sxseditor_apply_operations: 'project.apply',
  sxseditor_replace_project: 'project.replace',
  sxseditor_validate_project: 'project.validate',
  sxseditor_import_midi: 'midi.importFile',
  sxseditor_extract_midi: 'audio.extractMidi',
  sxseditor_import_accompaniment: 'accompaniment.import',
  sxseditor_import_singer: 'singer.import',
  sxseditor_get_playback: 'playback.get',
  sxseditor_export_fragment: 'fragment.exportTo',
};

const tools = [];
const toolMethod = new Map();

for (const [method, def] of Object.entries(schema().methods)) {
  const name = `sxs_${method.replace(/\./g, '_')}`;
  toolMethod.set(name, method);
  tools.push({
    name,
    description: def.description ? `${def.summary} — ${def.description}` : def.summary,
    inputSchema: { ...def.params, $schema: 'http://json-schema.org/draft-07/schema#' },
  });
}

for (const [name, method] of Object.entries(METHOD_ALIASES)) {
  const def = schema().methods[method];
  if (!def) continue;
  toolMethod.set(name, method);
  tools.push({ name, description: `${def.summary} (alias for ${method})`, inputSchema: def.params });
}

const obj = { type: 'object', additionalProperties: true };
tools.push(
  { name: 'sxseditor_schema', description: 'Return the automation method table (JSON Schema)', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'sxseditor_execute', description: 'Advanced: call any advertised automation method directly', inputSchema: { type: 'object', required: ['method'], properties: { method: { type: 'string' }, params: obj }, additionalProperties: false } },
);

// Multi-action tools keep their convenience surface, routing to one method.
// Each mapper must drop the selector key (`action` / `target`): the underlying
// method schema uses additionalProperties:false and would reject it.
const MULTI = {
  sxseditor_history: (a) => [`history.${a.action}`, {}],
  sxseditor_playback: (a) => {
    if (a.action === 'seek') return ['playback.seek', { seconds: a.seconds }];
    return [`playback.${a.action}`, {}];
  },
  sxseditor_project_file: (a) => {
    if (a.action === 'saveTo') {
      return ['project.saveTo', { path: a.path, embedSingerFiles: a.embedSingerFiles, embedAccompanimentAudio: a.embedAccompanimentAudio }];
    }
    if (a.action === 'loadFrom') return ['project.loadFrom', { path: a.path }];
    return [`project.${a.action}`, {}];
  },
  sxseditor_export_audio: (a) => (a.path ? ['audio.exportTo', { path: a.path, options: a.options }] : ['audio.export', {}]),
  sxseditor_export_lrc: (a) => (a.path ? ['lrc.exportTo', { path: a.path }] : ['lrc.export', {}]),
  sxseditor_settings: (a) => (a.action === 'update' ? ['settings.update', { settings: a.settings }] : ['settings.get', {}]),
  sxseditor_open: (a) => (a.target === 'fragment'
    ? ['fragment.open', { fragmentId: a.fragmentId }]
    : ['ui.open', { target: a.target, precision: a.precision }]),
};
tools.push(
  { name: 'sxseditor_history', description: 'Undo or redo', inputSchema: { type: 'object', required: ['action'], properties: { action: { enum: ['undo', 'redo'] } }, additionalProperties: false } },
  { name: 'sxseditor_playback', description: 'Play, pause, stop or seek', inputSchema: { type: 'object', required: ['action'], properties: { action: { enum: ['play', 'pause', 'stop', 'seek'] }, seconds: { type: 'number' } }, additionalProperties: false } },
  { name: 'sxseditor_project_file', description: 'Load/save with dialogs or explicit paths', inputSchema: { type: 'object', required: ['action'], properties: { action: { enum: ['save', 'saveAs', 'load', 'saveTo', 'loadFrom'] }, path: { type: 'string' }, embedSingerFiles: { type: 'boolean' }, embedAccompanimentAudio: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'sxseditor_export_audio', description: 'Export through UI or directly to a WAV path', inputSchema: { type: 'object', properties: { path: { type: 'string' }, options: obj }, additionalProperties: false } },
  { name: 'sxseditor_export_lrc', description: 'Export the project as an LRC lyrics file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'sxseditor_settings', description: 'Read or update application settings', inputSchema: { type: 'object', required: ['action'], properties: { action: { enum: ['get', 'update'] }, settings: obj }, additionalProperties: false } },
  { name: 'sxseditor_open', description: 'Open the fragment editor or a secondary window', inputSchema: { type: 'object', required: ['target'], properties: { target: { enum: ['fragment', 'singerCreator', 'singerMarket', 'modelDownload', 'resourceManager'] }, fragmentId: { type: 'string' }, precision: { type: 'string' } }, additionalProperties: false } },
);

function route(name, args) {
  if (name === 'sxseditor_schema') return ['schema.get', {}];
  if (name === 'sxseditor_execute') return [args.method, args.params || {}];
  if (MULTI[name]) return MULTI[name](args);
  const method = toolMethod.get(name);
  return method ? [method, args] : null;
}

const RESOURCES = [
  { uri: 'sxseditor://project', name: 'Current project', mimeType: 'application/json' },
  { uri: 'sxseditor://schema', name: 'Automation method table', mimeType: 'application/json' },
  { uri: 'sxseditor://capabilities', name: 'Runtime capabilities', mimeType: 'application/json' },
  { uri: 'sxseditor://jobs', name: 'Background jobs', mimeType: 'application/json' },
];

function send(x) { process.stdout.write(JSON.stringify(x) + '\n'); }
function ok(id, result) { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message, data) {
  send({ jsonrpc: '2.0', id: id !== undefined ? id : null, error: { code, message, data } });
}

function toolResult(v) {
  return { content: [{ type: 'text', text: JSON.stringify(v, null, 2) }], structuredContent: v };
}

function toolError(e) {
  const payload = { code: e.code || 'ERROR', message: e.message, field: e.field, hint: e.hint };
  return {
    content: [{ type: 'text', text: `Error ${payload.code}: ${payload.message}${payload.field ? ` (field: ${payload.field})` : ''}${payload.hint ? `\nHint: ${payload.hint}` : ''}` }],
    structuredContent: { error: payload },
    isError: true,
  };
}

async function handle(x) {
  const { id, method, params = {} } = x;
  try {
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'sxseditor', version: '2.0.0' },
        instructions: 'Call sxs_capabilities first, then sxs_schema for parameter schemas. '
          + 'Use sxs_project_get with fields/includeNotes to limit payloads, and async=true for long exports.',
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools });
    if (method === 'tools/call') {
      const r = route(params.name, params.arguments || {});
      if (!r) throw Object.assign(new Error('Unknown tool'), { code: 'UNKNOWN_TOOL' });
      try {
        const v = await call(r[0], r[1]);
        return ok(id, toolResult(v));
      } catch (e) {
        return ok(id, toolError(e));
      }
    }
    if (method === 'resources/list') return ok(id, { resources: RESOURCES });
    if (method === 'resources/read') {
      let v;
      if (params.uri === 'sxseditor://schema') v = await request('GET', '/schema');
      else if (params.uri === 'sxseditor://project') v = await call('project.get', { includeNotes: false });
      else if (params.uri === 'sxseditor://capabilities') v = await call('capabilities');
      else if (params.uri === 'sxseditor://jobs') v = await request('GET', '/jobs');
      else return err(id, -32002, 'Unknown resource');
      return ok(id, { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(v, null, 2) }] });
    }
    if (method === 'prompts/list') {
      return ok(id, {
        prompts: [{
          name: 'compose_singing_project',
          description: 'Create a structured singing project',
          arguments: [{ name: 'brief', required: true }],
        }],
      });
    }
    if (method === 'prompts/get') {
      return ok(id, {
        messages: [{
          role: 'user',
          content: { type: 'text', text: `Call sxs_schema, compose the project for: ${params.arguments && params.arguments.brief ? params.arguments.brief : ''}. Validate with sxs_project_validate, then sxs_project_replace.` },
        }],
      });
    }
    return err(id, -32601, 'Method not found');
  } catch (e) {
    if (method === 'tools/call') return ok(id, toolError(e));
    err(id, -32000, e.message);
  }
}

let buf = '';
const inFlight = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const p = handle(JSON.parse(line));
      inFlight.add(p);
      p.finally(() => inFlight.delete(p));
    } catch (e) {
      err(undefined, -32700, e.message);
    }
  }
});
process.stdin.on('end', async () => {
  // A client may close stdin right after writing: give in-flight calls a chance
  // to finish, otherwise their responses are dropped and the call looks hung.
  if (inFlight.size) await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((r) => setTimeout(r, 10000)),
  ]);
  process.exit(0);
});
