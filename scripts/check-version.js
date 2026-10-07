// Guards against version drift: the highest semver git tag is the source of
// truth for the released version (see .github/workflows/ci.yml, "Determine
// version and tag"), so a committed package.json that disagrees with it means
// someone bumped one side and forgot the other.
//
// Note: this is intentionally NOT wired as a hard CI gate yet. The release
// branch bumps the git tag inside CI without ever committing package.json, so
// right after a release the two legitimately differ until the next commit
// syncs them. Run it manually (`npm run check:version`) or from a pre-commit
// hook; see the comment block below for how to enable it in CI later.
//
// Usage: node scripts/check-version.js

'use strict';

const { execSync } = require('node:child_process');

const pkg = require('../package.json');

function latestSemverTag() {
  try {
    return execSync("git tag --list '[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1", {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
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

if (pkg.version !== last) {
  console.error(`[check-version] package.json version (${pkg.version}) != latest semver tag (${last}).`);
  console.error('[check-version] The git tag is the source of truth; bump package.json or re-tag.');
  process.exit(1);
}

console.log(`[check-version] OK: ${pkg.version}`);
