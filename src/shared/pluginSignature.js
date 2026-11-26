'use strict';
/**
 * `.sxsp` 的签名与完整性校验（M6）。
 *
 * 这一层只做纯计算：给定"包内文件 + 校验清单 + 签名 + 信任的公钥"，回答
 * "这个包是谁做的、装进来之后有没有被换过"。信任库、策略、UI 都在别处。
 *
 * 签名覆盖什么
 * ------------
 * 签名不直接覆盖文件，而是覆盖**由 checksums.json 重建出来的一段文本**：
 *
 *     sxsp-signature-v1
 *     <sha256>  manifest.json
 *     <sha256>  main.js
 *
 * 为什么用文本而不是再序列化一遍 JSON：JSON 的空白、键序、转义都有多种写法，
 * 换一个序列化实现就可能算出不同结果，于是"签名看起来失效了"。固定成一行一条
 * 的清单文本，任何语言都能用十行代码复现，作者也能 grep 出到底哪个文件被动过。
 *
 * 为什么不把文件清单再抄进 signature.json：同一份清单存两处，就有"两处不一致
 * 时信谁"的问题。签名里只留 `digest`（清单文本的 sha256）用于人眼核对。
 *
 * keyId 与公钥绑定
 * ----------------
 * keyId = `ed25519-` + 公钥 DER 的 sha256 前 16 位。宿主收到签名后**自己从公钥
 * 算一遍**，与签名里写的 keyId 比对。否则攻击者可以把 keyId 改成某个已信任
 * 的名字，把签名挂到另一把私钥上。
 */
const crypto = require('node:crypto');

const SIGNATURE_FORMAT = 1;
const SIGNATURE_ALGORITHM = 'ed25519';
/** 清单文本第一行。改格式必须改这行，否则旧签名会在新实现下"神奇地"仍然有效。 */
const CANON_HEADER = 'sxsp-signature-v1';

/** 签名判定结果。前两个是"能装"，后三个是"不能装"。 */
const SIGNATURE_STATUS = Object.freeze({
  /** 验签通过，且密钥在信任库里。 */
  VERIFIED: 'verified',
  /** 没有签名。是否允许安装由策略决定。 */
  UNSIGNED: 'unsigned',
  /** 有签名但验不过：内容被改过、字段被改过、或签名格式不对。 */
  INVALID: 'invalid',
  /** 签名本身有效，但签名用的密钥不在信任库里。 */
  UNKNOWN_KEY: 'unknown-key',
  /** 没有签名，而当前策略要求必须有。 */
  REQUIRED: 'required',
});

const PASS_STATUS = new Set([SIGNATURE_STATUS.VERIFIED, SIGNATURE_STATUS.UNSIGNED]);

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 把 `{path: sha256}` 变成被签名的规范文本。
 * 路径按字典序，哈希一律小写，行尾固定 `\n`（含最后一行）——这三条是跨平台/跨语言复现的前提。
 */
function canonicalList(files) {
  const lines = Object.keys(files || {})
    .sort()
    .map((p) => `${String(files[p]).toLowerCase()}  ${p}`);
  return `${CANON_HEADER}\n${lines.join('\n')}\n`;
}

/** checksums.json → 文件表；形状不对时抛错（调用方统一翻成 INVALID）。 */
function filesOf(checksums) {
  if (!checksums || typeof checksums !== 'object') throw new Error('校验清单不是对象');
  if (checksums.algorithm && String(checksums.algorithm).toLowerCase() !== 'sha256') {
    throw new Error(`不支持摘要算法 ${checksums.algorithm}`);
  }
  const files = checksums.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('校验清单缺少 files');
  const out = {};
  for (const [p, hash] of Object.entries(files)) {
    if (!/^[0-9a-fA-F]{64}$/.test(String(hash))) throw new Error(`校验清单里的摘要格式不对：${p}`);
    out[p] = String(hash).toLowerCase();
  }
  return out;
}

/** 公钥（PEM 字符串或 KeyObject）→ 指纹（sha256 of SPKI DER，全小写 hex）。 */
function keyFingerprint(publicKey) {
  const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;
  const der = key.export({ type: 'spki', format: 'der' });
  return sha256hex(der);
}

/** 公钥 → keyId。签名文件里写的必须是这个值。 */
function keyIdFor(publicKey) {
  return `${SIGNATURE_ALGORITHM}-${keyFingerprint(publicKey).slice(0, 16)}`;
}

/**
 * 取公钥 PEM。私钥与公钥都接受。
 *
 * 作者常常把私钥文件直接甩过来（"这就是我的签名密钥"），而信任库只该存公钥；
 * 两处各自判断一次，迟早有一处忘了判。收敛在这一个函数里。
 */
function publicKeyPem(keyLike) {
  const key = typeof keyLike === 'string' ? crypto.createPublicKey(keyLike) : keyLike;
  const pub = key.type === 'private' ? crypto.createPublicKey(key) : key;
  return pub.export({ type: 'spki', format: 'pem' });
}

function assertEd25519(key) {
  if (key.asymmetricKeyType !== SIGNATURE_ALGORITHM) {
    throw new Error(`只支持 ${SIGNATURE_ALGORITHM} 密钥，收到 ${key.asymmetricKeyType}`);
  }
}

/**
 * 生成签名对象（打包器用）。
 * @param {{checksums:object, privateKey:string|object, publisher?:string, signedAt?:string}} input
 */
function signChecksums(input) {
  const key = typeof input.privateKey === 'string'
    ? crypto.createPrivateKey(input.privateKey)
    : input.privateKey;
  assertEd25519(key);

  const text = canonicalList(filesOf(input.checksums));
  const signature = crypto.sign(null, Buffer.from(text, 'utf8'), key);
  const publicPem = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  return {
    format: SIGNATURE_FORMAT,
    algorithm: SIGNATURE_ALGORITHM,
    keyId: keyIdFor(crypto.createPublicKey(key)),
    publisher: typeof input.publisher === 'string' ? input.publisher.slice(0, 120) : '',
    signedAt: input.signedAt || new Date().toISOString(),
    digest: sha256hex(Buffer.from(text, 'utf8')),
    // 公钥放在签名文件里，让"信任这把密钥"不需要用户再去找发布者要 PEM。
    publicKey: publicPem,
    signature: signature.toString('base64'),
  };
}

/** 校验清单与包内文件是否一一对应（双向）。返回 { missing, extra, mismatched }。 */
function checkCoverage(entries, files) {
  const hashByPath = new Map();
  for (const entry of entries) {
    if (entry.path === 'checksums.json' || entry.path === 'signature.json') continue;
    hashByPath.set(entry.path, sha256hex(entry.data));
  }
  const listed = new Set(Object.keys(files));
  const missing = [];
  const extra = [];
  const mismatched = [];
  for (const p of listed) {
    if (!hashByPath.has(p)) missing.push(p);
    else if (hashByPath.get(p) !== files[p]) mismatched.push(p);
  }
  for (const p of hashByPath.keys()) {
    if (!listed.has(p)) extra.push(p);
  }
  return { missing, extra, mismatched };
}

function readJsonEntry(entries, name) {
  const entry = entries.find((e) => e.path === name);
  if (!entry) return { present: false, value: null, error: '' };
  try {
    return { present: true, value: JSON.parse(entry.data.toString('utf8')), error: '' };
  } catch (err) {
    return { present: true, value: null, error: `${name} 不是合法 JSON：${err.message}` };
  }
}

/**
 * 校验一个包。
 *
 * @param {Array<{path:string,data:Buffer}>} entries 包内文件
 * @param {{keys?:Record<string,{publicKey:string}>, requireSignature?:boolean}} options
 *        `keys` 是信任库（keyId → { publicKey: PEM }），不是公钥数组 —— 用 map 是
 *        为了让"这个 keyId 对应哪把公钥"这件事只有一种答案。
 * @returns {{
 *   ok:boolean, status:string, message:string,
 *   keyId?:string, publisher?:string, signedAt?:string, digest?:string,
 *   pendingKey?:{keyId:string, publicKey:string, publisher:string}
 * }}
 */
function verifyPackage(entries, options = {}) {
  const keys = options.keys || {};
  const requireSignature = !!options.requireSignature;

  const checksumsEntry = readJsonEntry(entries, 'checksums.json');
  const sigEntry = readJsonEntry(entries, 'signature.json');

  // 没有签名：是否放行只看策略。这里**不**因为"有校验清单"就当成已校验 ——
  // 校验清单解决的是"传输损坏"，签名解决的是"谁做的、有没有被换过"。
  if (!sigEntry.present) {
    if (requireSignature) {
      return {
        ok: false,
        status: SIGNATURE_STATUS.REQUIRED,
        message: '当前设置只允许安装已签名的插件，而这个包没有签名',
      };
    }
    return { ok: true, status: SIGNATURE_STATUS.UNSIGNED, message: '未签名' };
  }

  if (sigEntry.error) {
    return { ok: false, status: SIGNATURE_STATUS.INVALID, message: sigEntry.error };
  }
  const sig = sigEntry.value;
  if (!sig || typeof sig !== 'object') {
    return { ok: false, status: SIGNATURE_STATUS.INVALID, message: 'signature.json 不是对象' };
  }
  if (Number(sig.format) !== SIGNATURE_FORMAT) {
    return { ok: false, status: SIGNATURE_STATUS.INVALID, message: `不支持的签名格式：${sig.format}` };
  }
  if (String(sig.algorithm).toLowerCase() !== SIGNATURE_ALGORITHM) {
    return { ok: false, status: SIGNATURE_STATUS.INVALID, message: `不支持的签名算法：${sig.algorithm}` };
  }
  if (typeof sig.signature !== 'string' || !sig.signature) {
    return { ok: false, status: SIGNATURE_STATUS.INVALID, message: '签名内容为空' };
  }

  // 签名覆盖的是校验清单；没有清单就无法把"文件"和"签名"连起来。
  if (!checksumsEntry.present) {
    return {
      ok: false,
      status: SIGNATURE_STATUS.INVALID,
      message: '包里有签名但没有 checksums.json，签名无法覆盖任何文件',
    };
  }
  if (checksumsEntry.error) {
    return { ok: false, status: SIGNATURE_STATUS.INVALID, message: checksumsEntry.error };
  }

  let files;
  try {
    files = filesOf(checksumsEntry.value);
  } catch (err) {
    return { ok: false, status: SIGNATURE_STATUS.INVALID, message: err.message };
  }

  // 清单必须覆盖包内每一个会被落盘的文件。只查"清单里列的都在"是不够的：
  // 那样往包里加一个没被列出的 main.js 也能装进去——签名对，内容已经不是签名时的内容。
  const coverage = checkCoverage(entries, files);
  if (coverage.missing.length) {
    return {
      ok: false,
      status: SIGNATURE_STATUS.INVALID,
      message: `校验清单引用了包里不存在的文件：${coverage.missing.slice(0, 3).join(', ')}`,
    };
  }
  if (coverage.extra.length) {
    return {
      ok: false,
      status: SIGNATURE_STATUS.INVALID,
      message: `包里有未列入校验清单的文件：${coverage.extra.slice(0, 3).join(', ')}`,
    };
  }
  if (coverage.mismatched.length) {
    return {
      ok: false,
      status: SIGNATURE_STATUS.INVALID,
      message: `文件内容与校验清单不一致：${coverage.mismatched.slice(0, 3).join(', ')}`,
    };
  }

  if (!sig.keyId || typeof sig.keyId !== 'string') {
    return { ok: false, status: SIGNATURE_STATUS.INVALID, message: '签名缺少 keyId' };
  }

  // 包里带公钥，是为了让"未知密钥"这条路能走完：用户看到指纹与发布者，
  // 决定要不要信任。公钥不是秘密，带不带都不影响签名强度；真正决定放不放行的
  // 是信任库，而不是这个包自称的发布者。
  if (typeof sig.publicKey !== 'string' || !sig.publicKey.includes('BEGIN PUBLIC KEY')) {
    return { ok: false, status: SIGNATURE_STATUS.INVALID, message: '签名缺少公钥（publicKey）' };
  }

  let packageKey;
  try {
    packageKey = crypto.createPublicKey(sig.publicKey);
    assertEd25519(packageKey);
  } catch (err) {
    return { ok: false, status: SIGNATURE_STATUS.INVALID, message: `签名里的公钥无法解析：${err.message}` };
  }

  // keyId 必须由公钥算出来。否则把 keyId 改成已信任的名字、签名用自己的私钥，
  // 就能让"信任列表里有这个 keyId"变成一句空话。
  const expectedKeyId = keyIdFor(packageKey);
  if (expectedKeyId !== sig.keyId) {
    return {
      ok: false,
      status: SIGNATURE_STATUS.INVALID,
      message: `签名里的 keyId 与公钥不匹配（${sig.keyId} ≠ ${expectedKeyId}）`,
    };
  }

  const trusted = keys[sig.keyId];
  if (!trusted) {
    return {
      ok: false,
      status: SIGNATURE_STATUS.UNKNOWN_KEY,
      message: `签名用的密钥 ${sig.keyId} 不在信任列表里`,
      keyId: sig.keyId,
      publisher: typeof sig.publisher === 'string' ? sig.publisher : '',
      // 交给调用方决定要不要问用户"信任这把密钥"。这里只陈述事实，不做决定。
      pendingKey: {
        keyId: sig.keyId,
        publicKey: sig.publicKey,
        publisher: typeof sig.publisher === 'string' ? sig.publisher : '',
      },
    };
  }

  let publicKey;
  try {
    // 验签用**信任库里的**公钥，而不是包里那份：两者指纹相同（上面已比对 keyId），
    // 但"用我信任的那把来验"在语义上更直接，也不依赖包里公钥的字节形态。
    publicKey = crypto.createPublicKey(trusted.publicKey || trusted.pem);
    assertEd25519(publicKey);
  } catch (err) {
    // 信任库里的公钥本身有问题：这不是这个包的错，但也不能放行。
    return {
      ok: false,
      status: SIGNATURE_STATUS.UNKNOWN_KEY,
      message: `信任列表里的密钥 ${sig.keyId} 无法使用：${err.message}`,
      keyId: sig.keyId,
    };
  }

  const text = canonicalList(files);
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(text, 'utf8'),
      publicKey,
      Buffer.from(sig.signature, 'base64'),
    );
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    return {
      ok: false,
      status: SIGNATURE_STATUS.INVALID,
      message: '签名校验失败：包内容与签名不一致',
      keyId: sig.keyId,
      publisher: typeof sig.publisher === 'string' ? sig.publisher : '',
    };
  }

  return {
    ok: true,
    status: SIGNATURE_STATUS.VERIFIED,
    message: '签名校验通过',
    keyId: sig.keyId,
    publisher: typeof sig.publisher === 'string' ? sig.publisher : '',
    signedAt: typeof sig.signedAt === 'string' ? sig.signedAt : '',
    digest: sha256hex(Buffer.from(text, 'utf8')),
    files,
  };
}

/** 已安装插件重验：按保存下来的清单与签名，核对目录里的文件。 */
function verifyInstalledFiles(dirFiles, record) {
  if (!record || !record.files) return { ok: false, message: '没有可用的校验清单' };
  const files = record.files;
  const missing = [];
  const mismatched = [];
  const seen = new Set();
  for (const [p, hash] of Object.entries(files)) {
    const data = dirFiles[p];
    if (data === undefined) { missing.push(p); continue; }
    seen.add(p);
    if (sha256hex(data) !== hash) mismatched.push(p);
  }
  const extra = Object.keys(dirFiles).filter((p) => !seen.has(p));
  const ok = !missing.length && !mismatched.length && !extra.length;
  return {
    ok,
    missing,
    mismatched,
    extra,
    message: ok ? '文件与安装时的校验清单一致' : '安装目录已被改动',
  };
}

module.exports = {
  SIGNATURE_FORMAT,
  SIGNATURE_ALGORITHM,
  CANON_HEADER,
  SIGNATURE_STATUS,
  PASS_STATUS,
  canonicalList,
  filesOf,
  checkCoverage,
  keyFingerprint,
  keyIdFor,
  publicKeyPem,
  signChecksums,
  verifyPackage,
  verifyInstalledFiles,
  sha256hex,
};
