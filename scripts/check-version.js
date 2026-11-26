// The highest semver tag is the latest published version. package.json may
// name a newer release target (including a major version); an older or malformed
// target is version drift. CI publishes a newer target, otherwise bumps patch.
//
// Usage: node scripts/check-version.js

'use strict';

const { execFileSync } = require('node:child_process');

const pkg = require('../package.json');

function latestSemverTag() {
  try {
    return execFileSync('git', ['tag', '--list', '[0-9]*.[0-9]*.[0-9]*', '--sort=-v:refname'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\r?\n/)[0];
  } catch (_) {
    // No git / not a repo / shallow clone without tags.
    return '';
  }
}

const last = latestSemverTag();
if (!last) {
  console.log('[check-version] no semver tag found (shallow clone or no tags); skipping.');
  process.exit(0);
}

const parse = (value) => {
  const parts = String(value).split('.');
  return parts.length === 3 && parts.every((part) => /^\d+$/.test(part))
    ? parts.map(Number)
    : null;
};
const current = parse(pkg.version);
const released = parse(last);
const isNewer = current && released && (
  current[0] > released[0]
  || (current[0] === released[0] && (
    current[1] > released[1]
    || (current[1] === released[1] && current[2] > released[2])
  ))
);

if (!current || !isNewer) {
  console.error(`[check-version] package.json version (${pkg.version}) must be newer than latest semver tag (${last}).`);
  process.exit(1);
}

console.log(`[check-version] OK: ${pkg.version} (release target; latest tag ${last})`);
