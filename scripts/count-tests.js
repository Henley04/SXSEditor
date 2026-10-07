// Prints the current test-suite counts so docs (test/README.md, CLAUDE.md,
// docs/dev/testing-cli.html) can be kept accurate instead of drifting.
//
// Usage: node scripts/count-tests.js
//
// The "ci" line excludes test/onnxModelLoading.test.js, matching the
// --ignore flag in the `test:ci` npm script.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'test');
const CI_IGNORE = 'test/onnxModelLoading.test.js';

function collectTestFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

function countCases(file) {
  const text = fs.readFileSync(file, 'utf8');
  return (text.match(/^\s*(it|test)\(/gm) || []).length;
}

const files = collectTestFiles(testDir).sort();
let total = 0;
let ciTotal = 0;
for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const cases = countCases(file);
  total += cases;
  if (rel !== CI_IGNORE) ciTotal += cases;
}

console.log(`test files: ${files.length}`);
console.log(`test cases: ${total}`);
console.log(`test cases (CI, excluding ${CI_IGNORE}): ${ciTotal}`);
