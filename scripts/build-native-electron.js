const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const nativeDir = path.join(root, 'native', 'ort-bridge');
const electronVersion = require('electron/package.json').version;
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
const arch = process.env.npm_config_arch || process.arch;

console.log(`[native] building ort_bridge for Electron ${electronVersion} ${arch}`);
const result = spawnSync(process.execPath, [
  nodeGyp, 'rebuild',
  `--target=${electronVersion}`,
  `--arch=${arch}`,
  '--dist-url=https://electronjs.org/headers',
], { cwd: nativeDir, stdio: 'inherit', env: process.env });
if (result.status !== 0) process.exit(result.status || 1);

const addon = path.join(nativeDir, 'build', 'Release', 'ort_bridge.node');
if (!fs.existsSync(addon) || fs.statSync(addon).size < 10 * 1024) {
  throw new Error(`native addon missing or invalid: ${addon}`);
}
console.log(`[native] ready ${addon} (${fs.statSync(addon).size} bytes)`);
