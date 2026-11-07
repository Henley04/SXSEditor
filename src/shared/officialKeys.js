'use strict';
/**
 * 内置的官方签名公钥。
 *
 * 这里只有**公钥**：官方插件的签名在发布者的机器上用对应的私钥完成，
 * 私钥不进仓库、也不进这个进程（见 docs/dev/plugins-signing.md）。
 *
 * 为什么内置公钥不会让"任意插件"都被信任：
 *
 *  · 信任的粒度仍然是 keyId（= 公钥指纹）。verifyPackage 会先用包里的公钥
 *    重算 keyId，再与签名里写的 keyId 比对；最后用**信任库里的**公钥验签。
 *    换掉包里公钥、或把 keyId 改成官方指纹，都会在校验阶段被拒。
 *  · 因此只有持有对应私钥的人能产出"keyId 为官方指纹且验签通过"的包。
 *    其它任何密钥签的包仍然走"未知密钥"流程，需要用户显式信任。
 *
 * 新增/轮换官方密钥时，把 PEM 追加进 PUBLIC_KEYS 即可；旧公钥保留一段时间，
 * 让已发布的插件继续可装。
 */
const { keyIdFor, publicKeyPem } = require('./pluginSignature.js');

const OFFICIAL_PUBLISHER = 'SXSEditor Official';

/**
 * 官方公钥表。顺序即 UI 展示顺序。
 * @type {Array<{name:string, publicKey:string, note?:string}>}
 */
const PUBLIC_KEYS = [
  {
    name: OFFICIAL_PUBLISHER,
    // 生成于 2026-11-07，算法 ed25519。指纹见 keyIdFor() 的结果。
    publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyPhnyU0dXqHPqujP+XSnNkha4I9GuGjvnNxkppADHwU=
-----END PUBLIC KEY-----
`,
  },
];

let cache = null;

/**
 * 返回内置官方密钥的信任条目：{ keyId, name, publicKey, official: true, source: 'builtin' }。
 * 公钥解析失败的那一项会被跳过（而不是让整个应用起不来），并留下告警。
 */
function officialKeys() {
  if (cache) return cache;
  const out = [];
  for (const entry of PUBLIC_KEYS) {
    try {
      const pem = publicKeyPem(entry.publicKey);
      out.push({
        keyId: keyIdFor(pem),
        name: entry.name || OFFICIAL_PUBLISHER,
        publicKey: pem,
        official: true,
        source: 'builtin',
        addedAt: 0,
        fingerprint: keyIdFor(pem).replace(/^[a-z0-9]+-/, ''),
      });
    } catch (err) {
      console.warn(`[plugins] 内置官方公钥无法解析，已跳过：${err.message}`);
    }
  }
  cache = out;
  return cache;
}

/** keyId → 官方条目。给信任库合并用。 */
function officialKeyMap() {
  const out = {};
  for (const key of officialKeys()) out[key.keyId] = key;
  return out;
}

module.exports = {
  OFFICIAL_PUBLISHER,
  PUBLIC_KEYS,
  officialKeys,
  officialKeyMap,
};
