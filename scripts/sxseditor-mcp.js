#!/usr/bin/env node
'use strict';
// SXSEditor MCP stdio gateway.
// Routes JSON-RPC over stdin/stdout to the running application's local
// automation bridge (127.0.0.1 + Bearer token from the endpoint file).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

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

function call(method, params = {}) {
  const e = endpoint();
  const body = Buffer.from(JSON.stringify({ method, params }));
  return new Promise((resolve, reject) => {
    const q = http.request({
      hostname: '127.0.0.1',
      port: e.port,
      path: '/automation',
      method: 'POST',
      headers: {
        authorization: `Bearer ${e.token}`,
        'content-type': 'application/json',
        'content-length': body.length,
      },
    }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        try {
          const x = JSON.parse(Buffer.concat(chunks));
          if (x.ok) resolve(x.result);
          else reject(new Error(x.error));
        } catch (z) { reject(z); }
      });
    });
    // The bridge itself times out after 600s; keep a slightly larger client
    // timeout so long exports / MIDI extraction are not cut short by us.
    q.setTimeout(605000, () => q.destroy(new Error('Timeout waiting for SXSEditor')));
    q.on('error', reject);
    q.end(body);
  });
}

const obj = { type: 'object', additionalProperties: true };
const tools = [
  ['sxseditor_get_project', 'Read complete project state', { type: 'object', additionalProperties: false }],
  ['sxseditor_apply_operations', 'Edit BPM, singers, accompaniment tracks, fragments, MIDI notes, envelopes, pitch curves and selection with ordered JSON operations', { type: 'object', required: ['operations'], properties: { operations: { type: 'array', items: obj } }, additionalProperties: false }],
  ['sxseditor_replace_project', 'Replace the complete structured project JSON', { type: 'object', required: ['project'], properties: { project: obj }, additionalProperties: false }],
  ['sxseditor_validate_project', 'Validate project JSON', { type: 'object', properties: { project: obj }, additionalProperties: false }],
  ['sxseditor_import_midi', 'Import a local standard MIDI file, including multi-track mapping, tempo and timeline placement', { type: 'object', required: ['path'], properties: { path: { type: 'string' }, multiTrack: { type: 'boolean' }, createTracks: { type: 'boolean' }, singerId: { type: 'string' }, startTime: { type: 'number' }, applyProjectInfo: { type: 'boolean' } }, additionalProperties: false }],
  ['sxseditor_extract_midi', 'Extract MIDI notes (and optionally F0) from a local audio file (WAV/MP3/FLAC/OGG/AAC/M4A)', { type: 'object', required: ['path'], properties: { path: { type: 'string' }, withPitch: { type: 'boolean' }, bpm: { type: 'number' } }, additionalProperties: false }],
  ['sxseditor_import_accompaniment', 'Import and place local accompaniment audio', { type: 'object', required: ['path'], properties: { path: { type: 'string' }, name: { type: 'string' }, startTime: { type: 'number' }, volume: { type: 'number' } }, additionalProperties: false }],
  ['sxseditor_import_singer', 'Import an .sxssinger file', { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false }],
  ['sxseditor_history', 'Undo or redo', { type: 'object', required: ['action'], properties: { action: { enum: ['undo', 'redo'] } }, additionalProperties: false }],
  ['sxseditor_playback', 'Play, pause, stop or seek', { type: 'object', required: ['action'], properties: { action: { enum: ['play', 'pause', 'stop', 'seek'] }, seconds: { type: 'number' } }, additionalProperties: false }],
  ['sxseditor_get_playback', 'Get playback status: whether playing, current position and duration', { type: 'object', additionalProperties: false }],
  ['sxseditor_project_file', 'Load/save with dialogs or explicit paths', { type: 'object', required: ['action'], properties: { action: { enum: ['save', 'saveAs', 'load', 'saveTo', 'loadFrom'] }, path: { type: 'string' }, embedSingerFiles: { type: 'boolean' }, embedAccompanimentAudio: { type: 'boolean' } }, additionalProperties: false }],
  ['sxseditor_export_audio', 'Export through UI or directly to a WAV path', { type: 'object', properties: { path: { type: 'string' }, options: obj }, additionalProperties: false }],
  ['sxseditor_export_fragment', 'Export a single fragment to a WAV path', { type: 'object', required: ['fragmentId', 'path'], properties: { fragmentId: { type: 'string' }, path: { type: 'string' }, options: obj }, additionalProperties: false }],
  ['sxseditor_export_lrc', 'Export the project as an LRC lyrics file (dialog or explicit path)', { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }],
  ['sxseditor_settings', 'Read or update application settings', { type: 'object', required: ['action'], properties: { action: { enum: ['get', 'update'] }, settings: obj }, additionalProperties: false }],
  ['sxseditor_open', 'Open fragment editor or human-facing app windows', { type: 'object', required: ['target'], properties: { target: { enum: ['fragment', 'singerCreator', 'singerMarket', 'modelDownload', 'resourceManager'] }, fragmentId: { type: 'string' }, precision: { type: 'string' } }, additionalProperties: false }],
  ['sxseditor_execute', 'Advanced access to every advertised automation method', { type: 'object', required: ['method'], properties: { method: { type: 'string' }, params: obj }, additionalProperties: false }],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

function route(n, a) {
  const direct = {
    sxseditor_get_project: ['project.get', {}],
    sxseditor_apply_operations: ['project.apply', a],
    sxseditor_replace_project: ['project.replace', a],
    sxseditor_validate_project: ['project.validate', a],
    sxseditor_import_midi: ['midi.importFile', a],
    sxseditor_extract_midi: ['audio.extractMidi', a],
    sxseditor_import_accompaniment: ['accompaniment.import', a],
    sxseditor_import_singer: ['singer.import', a],
  };
  if (direct[n]) return direct[n];
  if (n === 'sxseditor_history') return [`history.${a.action}`, a];
  if (n === 'sxseditor_playback') return [`playback.${a.action}`, a];
  if (n === 'sxseditor_get_playback') return ['playback.get', a];
  if (n === 'sxseditor_project_file') return [`project.${a.action}`, a];
  if (n === 'sxseditor_export_audio') return [a.path ? 'audio.exportTo' : 'audio.export', a];
  if (n === 'sxseditor_export_fragment') return ['fragment.exportTo', a];
  if (n === 'sxseditor_export_lrc') return [a.path ? 'lrc.exportTo' : 'lrc.export', a];
  if (n === 'sxseditor_settings') return [`settings.${a.action}`, a];
  if (n === 'sxseditor_open') return a.target === 'fragment' ? ['fragment.open', a] : ['ui.open', a];
  if (n === 'sxseditor_execute') return [a.method, a.params || {}];
}

// Example schema shown to clients via sxseditor://schema.
const schema = {
  schemaVersion: '1.0',
  project: { bpm: 120, timeSignature: [4, 4] },
  singers: [{ id: 'lead', type: 'singer', trackName: 'Lead', singerName: 'Lead' }],
  fragments: [{
    id: 'verse',
    singerId: 'lead',
    startTime: 0,
    duration: 4,
    name: 'Verse',
    notes: [{ pitch: 60, start: 0, duration: 0.5, lyric: 'la' }],
    envelopes: {
      volume: { keyframes: [{ time: 0, value: 1, smoothness: 0 }] },
      pan: { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
    },
    pitchCurve: { enabled: true, anchorPoints: [], brushSegments: [] },
  }],
};

const RESOURCES = [
  { uri: 'sxseditor://project', name: 'Current project', mimeType: 'application/json' },
  { uri: 'sxseditor://schema', name: 'Project JSON schema example', mimeType: 'application/json' },
  { uri: 'sxseditor://capabilities', name: 'Automation capabilities', mimeType: 'application/json' },
];

function send(x) { process.stdout.write(JSON.stringify(x) + '\n'); }
function ok(id, result) { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message) { send({ jsonrpc: '2.0', id: id !== undefined ? id : null, error: { code, message } }); }

async function handle(x) {
  const { id, method, params = {} } = x;
  try {
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'sxseditor', version: '1.0.0' },
        instructions: 'Read sxseditor://schema and sxseditor://capabilities before editing.',
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools });
    if (method === 'tools/call') {
      const r = route(params.name, params.arguments || {});
      if (!r) throw new Error('Unknown tool');
      const v = await call(...r);
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(v, null, 2) }],
        structuredContent: v,
      });
    }
    if (method === 'resources/list') return ok(id, { resources: RESOURCES });
    if (method === 'resources/read') {
      let v;
      if (params.uri === 'sxseditor://schema') v = schema;
      else if (params.uri === 'sxseditor://project') v = await call('project.get');
      else if (params.uri === 'sxseditor://capabilities') v = await call('capabilities');
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
          content: { type: 'text', text: `Use sxseditor://schema to compose: ${params.arguments?.brief || ''}. Validate, then replace or apply operations.` },
        }],
      });
    }
    return err(id, -32601, 'Method not found');
  } catch (e) {
    if (method === 'tools/call') return ok(id, { content: [{ type: 'text', text: e.message }], isError: true });
    err(id, -32000, e.message);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      err(undefined, -32700, e.message);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();