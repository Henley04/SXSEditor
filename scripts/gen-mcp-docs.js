#!/usr/bin/env node
'use strict';
// Generates docs/MCP.md from src/shared/mcpSchema.js.
// Run: npm run mcp:docs
const fs = require('node:fs');
const path = require('node:path');
const { schema, VERSION } = require('../src/shared/mcpSchema');
const { CODES } = require('../src/main/mcpErrors');

const out = path.join(__dirname, '..', 'docs', 'MCP.md');

function typeOf(s) {
  if (!s) return 'any';
  if (s.enum) return s.enum.map((v) => `\`${v}\``).join(' | ');
  if (s.type === 'array') return `${typeOf(s.items)}[]`;
  if (s.type === 'object' && s.properties) return 'object';
  return s.type || 'any';
}

function paramRows(params) {
  const props = (params && params.properties) || {};
  const required = new Set((params && params.required) || []);
  const rows = Object.entries(props).map(([name, s]) => {
    const bits = [typeOf(s), required.has(name) ? 'required' : 'optional'];
    if (s.description) bits.push(s.description);
    if (s.minimum !== undefined || s.maximum !== undefined) {
      bits.push(`range ${s.minimum !== undefined ? s.minimum : '-∞'}..${s.maximum !== undefined ? s.maximum : '∞'}`);
    }
    return `| \`${name}\` | ${bits.join(' · ')} |`;
  });
  return rows.length ? ['| Parameter | Type / notes |', '|---|---|', ...rows].join('\n') : '_No parameters._';
}

function example(name, def) {
  const p = (def.params && def.params.properties) || {};
  const args = {};
  for (const [key, s] of Object.entries(p)) {
    if (s.type === 'string') args[key] = s.enum ? s.enum[0] : `\${${key}}`;
    else if (s.type === 'number' || s.type === 'integer') args[key] = 1;
    else if (s.type === 'boolean') args[key] = true;
    else if (s.type === 'array') args[key] = [];
    else if (s.type === 'object') args[key] = {};
  }
  return JSON.stringify({ method: name, params: args }, null, 2);
}

const lines = [];
lines.push('# Automation API (MCP)');
lines.push('');
lines.push(`Schema version **${VERSION}** — generated from \`src/shared/mcpSchema.js\` by \`npm run mcp:docs\`. Do not edit by hand.`);
lines.push('');
lines.push('SXSEditor exposes a loopback HTTP bridge so agents and scripts can drive the editor.');
lines.push('The stdio MCP server (`npm run mcp`) wraps the same API; both share one schema.');
lines.push('');
lines.push('## Endpoints');
lines.push('');
lines.push('| Method | Path | Purpose |');
lines.push('|---|---|---|');
lines.push('| GET | `/health` | Liveness, app + schema version (Bearer token still required) |');
lines.push('| GET | `/schema` | Method table with JSON Schema |');
lines.push('| GET | `/events` | Server-sent events (`?token=` allowed, EventSource cannot set headers) |');
lines.push('| GET | `/jobs`, `/jobs/:id` | Background job status |');
lines.push('| POST | `/automation` | `{method, params, requestId?, async?}` |');
lines.push('');
lines.push('Discovery file: `<userData>/mcp-endpoint.json` (mode `0600`) with `port`, `token`');
lines.push('(the default token only), `pid`, `version`, `schemaVersion`, and `urls`. Named tokens');
lines.push('stay in `<userData>/mcp-tokens.json` — readers of the discovery file cannot impersonate');
lines.push('every configured client.');
lines.push('');
lines.push('## Calling');
lines.push('');
lines.push('```bash');
lines.push('EP=$(node -p "require(process.env.HOME+\'/.config/SXSEditor/mcp-endpoint.json\').port")');
lines.push('TOKEN=$(node -p "require(process.env.HOME+\'/.config/SXSEditor/mcp-endpoint.json\').token")');
lines.push('curl -s localhost:$EP/automation -H "Authorization: Bearer $TOKEN" \\');
lines.push('  -H "content-type: application/json" \\');
lines.push('  -d \'{"method":"project.get","params":{"includeNotes":false}}\'');
lines.push('```');
lines.push('');
lines.push('Every response is `{ok, result, warnings?, requestId?}` or');
lines.push('`{ok:false, error:{code, message, field?, hint?, details?}}`.');
lines.push('');
lines.push('## Errors');
lines.push('');
lines.push('| Code | HTTP | Meaning |');
lines.push('|---|---|---|');
const CODE_MEANINGS = {
  VALIDATION_ERROR: 'params failed JSON Schema validation (see `field` / `details.errors`)',
  UNKNOWN_METHOD: 'method not in the schema (hint: `see GET /schema`)',
  NOT_FOUND: 'referenced job, file, fragment or singer does not exist',
  CONFLICT: 'state conflict with the current project / job',
  PRECONDITION_FAILED: 'inference models not installed, or no project window open',
  FORBIDDEN: 'non-loopback client, system path, or path outside granted roots',
  UNAUTHORIZED: 'missing or invalid Bearer token',
  RATE_LIMITED: 'too many requests (see `retry` hint)',
  TIMEOUT: 'automation call exceeded its timeout',
  CANCELLED: 'job was cancelled',
  INTERNAL: 'unexpected error',
};
for (const [code, status] of Object.entries(CODES)) {
  lines.push(`| \`${code}\` | ${status} | ${CODE_MEANINGS[code] || '—'} |`);
}
lines.push('');
lines.push('## Events');
lines.push('');
lines.push('`/events` streams `event: <type>` frames. Current types: `bridge.started`,');
lines.push('`project.changed`, `project.saved`, `fragment.opened`, `playback.state`,');
lines.push('`ui.opened`, `job.started`, `job.completed`, `job.failed`.');
lines.push('');
lines.push('## Jobs');
lines.push('');
lines.push('Add `"async": true` to `POST /automation` for long methods (export, synthesis, MIDI extraction).');
lines.push('The call returns `202 {jobId, poll}`; poll `GET /jobs/<id>` for `status`');
lines.push('(`queued` → `running` → `completed` / `failed` / `cancelled`) plus `result` or `error`.');
lines.push('');
lines.push('## Methods');
lines.push('');

for (const [name, def] of Object.entries(schema().methods)) {
  lines.push(`### \`${name}\``);
  lines.push('');
  lines.push(def.summary);
  if (def.description) {
    lines.push('');
    lines.push(def.description);
  }
  const meta = [`target: \`${def.target}\``];
  if (def.mutates) meta.push('mutates project');
  if (def.long) meta.push('long-running (job-able)');
  if (def.requires && def.requires.length) meta.push(`requires: ${def.requires.map((r) => `\`${r}\``).join(', ')}`);
  lines.push('');
  lines.push(`_${meta.join(' · ')}_`);
  lines.push('');
  lines.push(paramRows(def.params));
  if (def.aliases && Object.keys(def.aliases).length) {
    lines.push('');
    lines.push('Legacy aliases: ' + Object.entries(def.aliases).map(([from, to]) => `\`${from}\` → \`${to}\``).join(', ') + ' (accepted with a deprecation warning).');
  }
  lines.push('');
  lines.push('```json');
  lines.push(example(name, def));
  lines.push('```');
  lines.push('');
}

lines.push('## Notes');
lines.push('');
lines.push('- Parameters are flat: the document for `project.replace` goes directly under `params.project`.');
lines.push('- File paths must be inside a directory granted with `session.grantRoot` (or one of the');
lines.push('  app\'s default save roots). Grants are session-scoped and disappear on exit.');
lines.push('  The renderer additionally self-authorizes individually whitelisted media/project files');
lines.push('  (`.wav`, `.sxssinger`, `.sxsproj`, `.mid`, `.lrc`) through the same path rules as the dialogs.');
lines.push('- `project.apply` validates every operation before mutating and rolls back on failure');
lines.push('  (`atomic: false` opts out). `dryRun: true` returns the plan without touching state.');
lines.push('- Note ids are derived from note content, so identical payloads produce identical ids.');
lines.push('');

fs.writeFileSync(out, lines.join('\n'));
console.log(`wrote ${path.relative(process.cwd(), out)} (${Object.keys(schema().methods).length} methods)`);
