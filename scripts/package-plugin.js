'use strict';
/**
 * 把插件目录打成 `.sxsp` 安装包。
 *
 *   node scripts/package-plugin.js                      # 打 plugins/example-hello
 *   node scripts/package-plugin.js <pluginDir> [-o out]
 *
 * 产物 = zip（manifest.json + 插件文件 + 生成出来的 checksums.json）。
 * 之所以自己打而不是让作者手动压缩：checksums.json 必须与文件内容一一对应，
 * 手工维护必然漂移；安装器会用它核对（见 PluginInstaller.verifyChecksums）。
 *
 * 刻意**不**做签名：签名需要密钥与发布身份，等插件市场落地时再接
 * （manifest 里已预留 signature.json 的位置，安装器遇到该文件会跳过不落盘）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createZip } = require('../src/shared/pluginZip.js');
const { validateManifest } = require('../src/shared/pluginManifest.js');
const { PACKAGE } = require('../src/shared/pluginApi.js');

const REPO = path.resolve(__dirname, '..');

function usage() {
  console.log(`用法: node scripts/package-plugin.js [pluginDir] [-o <outDir>]

  pluginDir   插件目录（含 manifest.json），默认 plugins/example-hello
  -o          输出目录，默认 dist-plugins
`);
}

function parseArgs(argv) {
  const out = { dir: null, outDir: path.join(REPO, 'dist-plugins') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '-o' || arg === '--out') {
      out.outDir = path.resolve(REPO, argv[++i] || '');
      continue;
    }
    if (!out.dir) out.dir = path.resolve(REPO, arg);
  }
  if (!out.dir) out.dir = path.join(REPO, 'plugins', 'example-hello');
  return out;
}

/** 递归收集文件，跳过 dotfile（.git / 编辑器的 .DS_Store 之类）。 */
function collectFiles(root, skipNames) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (skipNames.has(rel)) continue;
      out.push({ path: rel, data: fs.readFileSync(abs) });
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const manifestPath = path.join(args.dir, PACKAGE.manifest);
  if (!fs.existsSync(manifestPath)) {
    console.error(`找不到 ${manifestPath}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`${PACKAGE.manifest} 不是合法 JSON：${err.message}`);
    process.exit(1);
  }

  // 与安装器同一套校验：打包时就报错，比装到用户机器上才发现便宜得多
  const checked = validateManifest(manifest, {
    dirName: path.basename(args.dir),
    appVersion: JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version,
  });
  if (!checked.ok) {
    console.error(`manifest 校验失败：${checked.error}`);
    process.exit(1);
  }

  const files = collectFiles(args.dir, new Set([PACKAGE.checksums, PACKAGE.signature]));
  if (!files.some((f) => f.path === PACKAGE.manifest)) {
    console.error('打包文件里没有 manifest.json');
    process.exit(1);
  }

  // 校验清单只覆盖"会被落盘的内容"，不含它自己
  const checksums = { algorithm: 'sha256', files: {} };
  for (const file of files) checksums.files[file.path] = sha256(file.data);
  files.push({
    path: PACKAGE.checksums,
    data: Buffer.from(JSON.stringify(checksums, null, 2), 'utf8'),
  });

  const zip = createZip(files);
  fs.mkdirSync(args.outDir, { recursive: true });
  const target = path.join(args.outDir, `${checked.value.id}-${checked.value.version}${PACKAGE.ext}`);
  fs.writeFileSync(target, zip);

  const kb = (zip.length / 1024).toFixed(1);
  console.log(`已生成 ${path.relative(REPO, target)}（${files.length} 个文件，${kb} KB）`);
  console.log(`插件 id=${checked.value.id} version=${checked.value.version} api=${checked.value.apiVersion}`);
}

main();
