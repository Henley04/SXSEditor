'use strict';
/**
 * 把插件目录打成 `.sxsp` 安装包（可选签名）。
 *
 *   node scripts/package-plugin.js                      # 打 plugins/example-hello
 *   node scripts/package-plugin.js <pluginDir> [-o out]
 *   node scripts/package-plugin.js <pluginDir> --key publisher.key --publisher "某某"
 *   node scripts/package-plugin.js --gen-key keys/      # 生成一对 Ed25519 密钥
 *
 * 产物 = zip（manifest.json + 插件文件 + 生成出来的 checksums.json [+ signature.json]）。
 * 之所以自己打而不是让作者手动压缩：checksums.json 必须与文件内容一一对应，
 * 手工维护必然漂移；安装器会用它核对，并在有签名时验签（见 PluginInstaller）。
 *
 * 签名顺序很关键：先算 checksums（覆盖除自己与 signature.json 之外的所有文件），
 * 再对由 checksums 重建出来的规范文本签名。签名覆盖清单，清单覆盖文件，
 * 于是"文件 → 清单 → 签名"是一条不断的链。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createZip } = require('../src/shared/pluginZip.js');
const { validateManifest } = require('../src/shared/pluginManifest.js');
const { PACKAGE } = require('../src/shared/pluginApi.js');
const signature = require('../src/shared/pluginSignature.js');

const REPO = path.resolve(__dirname, '..');

function usage() {
  console.log(`用法: node scripts/package-plugin.js [pluginDir] [-o <outDir>] [--key <pem>] [--publisher <name>]

  pluginDir   插件目录（含 manifest.json），默认 plugins/example-hello
  -o          输出目录，默认 dist-plugins
  --key       私钥文件（PEM，Ed25519）。给了就签名，不给就打未签名包
  --publisher 发布者显示名，写进签名文件（仅展示，不参与判定）
  --gen-key   生成一对 Ed25519 密钥到指定目录，然后退出
`);
}

function parseArgs(argv) {
  const out = { dir: null, outDir: path.join(REPO, 'dist-plugins'), key: null, publisher: '', genKey: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '-o' || arg === '--out') {
      out.outDir = path.resolve(REPO, argv[++i] || '');
      continue;
    }
    if (arg === '--key') { out.key = argv[++i] || ''; continue; }
    if (arg === '--publisher') { out.publisher = argv[++i] || ''; continue; }
    if (arg === '--gen-key') {
      // 允许省略目录：此时用 ./keys
      const next = argv[i + 1];
      out.genKey = next && !next.startsWith('-') ? (i++, next) : 'keys';
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

/**
 * 生成密钥对。
 *
 * 私钥写 0600：它是"以你的名义发布插件"的唯一凭据，和任何私钥一样
 * 不该被同机其他用户读到。
 */
function generateKeyPair(dir) {
  const abs = path.resolve(REPO, dir);
  fs.mkdirSync(abs, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPath = path.join(abs, 'plugin-signing.key');
  const pubPath = path.join(abs, 'plugin-signing.pub');
  fs.writeFileSync(privPath, privPem, { mode: 0o600 });
  fs.writeFileSync(pubPath, pubPem, { mode: 0o644 });
  const keyId = signature.keyIdFor(pubPem);
  console.log(`已生成密钥对：
  私钥  ${path.relative(REPO, privPath)}（0600，不要提交到版本库）
  公钥  ${path.relative(REPO, pubPath)}
  keyId ${keyId}

把这个 keyId 与公钥交给使用者，让他们在插件管理器里信任它（或
\`--cli plugin trust add ${path.relative(REPO, pubPath)}\`）。
只把公钥发出去就够了，私钥永远不要离开这台机器。`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.genKey) {
    generateKeyPair(args.genKey);
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

  let signed = null;
  if (args.key) {
    const keyPath = path.resolve(REPO, args.key);
    let privateKey;
    try {
      privateKey = fs.readFileSync(keyPath, 'utf8');
    } catch (err) {
      console.error(`读不到私钥 ${keyPath}：${err.message}`);
      process.exit(1);
    }
    try {
      signed = signature.signChecksums({ checksums, privateKey, publisher: args.publisher });
    } catch (err) {
      console.error(`签名失败：${err.message}`);
      process.exit(1);
    }
    files.push({
      path: PACKAGE.signature,
      data: Buffer.from(JSON.stringify(signed, null, 2), 'utf8'),
    });
  }

  const zip = createZip(files);
  fs.mkdirSync(args.outDir, { recursive: true });
  const target = path.join(args.outDir, `${checked.value.id}-${checked.value.version}${PACKAGE.ext}`);
  fs.writeFileSync(target, zip);

  const kb = (zip.length / 1024).toFixed(1);
  console.log(`已生成 ${path.relative(REPO, target)}（${files.length} 个文件，${kb} KB）`);
  console.log(`插件 id=${checked.value.id} version=${checked.value.version} api=${checked.value.apiVersion}`);
  if (signed) {
    console.log(`已签名 keyId=${signed.keyId} publisher=${signed.publisher || '(未填)'} digest=${signed.digest.slice(0, 16)}…`);
  } else {
    console.log('未签名：安装时会被标注为"未签名"；要求签名的设置下会被拒绝。');
  }
}

main();
