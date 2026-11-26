#!/usr/bin/env node
'use strict';
/**
 * End-to-end smoke test against a running SXSEditor.
 *
 *   npm run mcp:selftest
 *
 * Deliberately read-only: it never mutates the open project, so it is safe to
 * run at any time. Checks the transport, the schema, structured errors and the
 * window/job surfaces.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function endpoint() {
  const p = process.env.SXSEDITOR_MCP_ENDPOINT
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'SXSEditor', 'mcp-endpoint.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function req(ep, method, urlPath, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${ep.token}` };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const r = http.request({ hostname: '127.0.0.1', port: ep.port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    if (payload) r.write(payload);
    r.end();
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  let ep;
  try {
    ep = endpoint();
  } catch (_err) {
    console.error('No endpoint file. Start SXSEditor first.');
    process.exit(2);
  }

  const health = await req(ep, 'GET', '/health');
  check('GET /health', health.status === 200 && health.json && health.json.ok, `v${health.json && health.json.version}`);

  const schema = await req(ep, 'GET', '/schema');
  const methods = schema.json && schema.json.result && schema.json.result.methods;
  check('GET /schema', schema.status === 200 && methods && Object.keys(methods).length > 20, `${methods ? Object.keys(methods).length : 0} methods`);

  const hasEditor = methods && methods['editor.setView'];
  check('schema advertises editor.setView', !!hasEditor);

  const caps = await req(ep, 'POST', '/automation', { method: 'capabilities' });
  check('capabilities', caps.status === 200 && caps.json.result && Array.isArray(caps.json.result.methods), `models=${caps.json.result && caps.json.result.features && caps.json.result.features.models}`);

  const project = await req(ep, 'POST', '/automation', { method: 'project.get', params: { includeNotes: false } });
  check('project.get (summary)', project.status === 200 && project.json.result && Array.isArray(project.json.result.singers), `${project.json.result && project.json.result.singers.length} singers`);

  const wins = await req(ep, 'POST', '/automation', { method: 'ui.windows' });
  check('ui.windows', wins.status === 200 && Array.isArray(wins.json.result.windows), `${wins.json.result && wins.json.result.windows.length} windows`);

  const jobs = await req(ep, 'GET', '/jobs');
  check('GET /jobs', jobs.status === 200 && Array.isArray(jobs.json.result.jobs));

  const bad = await req(ep, 'POST', '/automation', { method: 'fragment.open', params: { fragmentId: '__definitely_missing__' } });
  const err = bad.json && bad.json.error;
  check('structured NOT_FOUND', bad.status === 404 && err && err.code === 'NOT_FOUND' && !!err.hint, err && err.hint);

  const invalid = await req(ep, 'POST', '/automation', { method: 'playback.seek', params: {} });
  const verr = invalid.json && invalid.json.error;
  check('structured VALIDATION_ERROR', invalid.status === 400 && verr && verr.code === 'VALIDATION_ERROR' && verr.field === 'seconds', verr && verr.field);

  const unknown = await req(ep, 'POST', '/automation', { method: 'nope.nope' });
  check('unknown method', unknown.status === 404 && unknown.json.error.code === 'UNKNOWN_METHOD');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(3);
});
