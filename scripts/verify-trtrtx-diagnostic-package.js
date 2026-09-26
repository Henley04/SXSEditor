'use strict';

const fs = require('node:fs');
const path = require('node:path');

const required = [
  path.resolve('.webpack/main/inference/winml/trtDiagnosticRunner.js'),
  path.resolve('.webpack/main/inference/winml/trtDiagnostic.js'),
];

const missing = required.filter(file => !fs.existsSync(file));
if (missing.length) {
  console.error('[TRTRTX] diagnostic files missing from webpack output:');
  for (const file of missing) console.error(`  ${file}`);
  process.exit(1);
}

for (const file of required) {
  console.log(`[TRTRTX] packaged ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
}
