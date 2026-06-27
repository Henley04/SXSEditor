// Generates src/build-info.json with package-time metadata
// (build date, version, package name). Runs via the prepackage /
// prepackage:lite npm scripts so the splash screen can display it.
//
// Usage: node scripts/generate-build-info.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

// Format: YYYY-MM-DD HH:mm:ss (local time, +ZZ:ZZ offset)
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const offsetMin = -now.getTimezoneOffset();
const sign = offsetMin >= 0 ? '+' : '-';
const absMin = Math.abs(offsetMin);
const offsetStr = `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;

const buildDate =
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
  ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
  ` ${offsetStr}`;

// ISO8601 timestamp (machine-readable) plus epoch ms
const buildDateISO = now.toISOString();
const buildTimestamp = now.getTime();

const info = {
  productName: pkg.productName || pkg.name,
  version: pkg.version,
  buildDate,
  buildDateISO,
  buildTimestamp,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
};

const outPath = path.join(root, 'src', 'build-info.json');
fs.writeFileSync(outPath, JSON.stringify(info, null, 2) + '\n', 'utf8');

console.log(`[build-info] wrote ${path.relative(root, outPath)}`);
console.log(`[build-info] version=${info.version} buildDate=${info.buildDate}`);
