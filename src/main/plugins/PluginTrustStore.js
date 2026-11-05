'use strict';
/**
 * 插件签名信任库。
 *
 * 存在 `plugins-state/trust.json`：
 *
 *     { "version": 1, "requireSignature": false,
 *       "keys": { "ed25519-1a2b…": { "keyId", "name", "publicKey", "addedAt", "source" } } }
 *
 * 几条刻意的取舍：
 *
 *  · **只存公钥**。私钥永远不进这个进程；打包器签名是作者在自己的机器上做的。
 *  · **没有"信任全部"开关**。信任是逐把密钥的，因为"谁签的"正是要回答的问题。
 *  · **删掉密钥不会卸载已装插件**。安装期校验是历史事实：当时确实验过了。
 *    删密钥只影响"以后还能不能装用它签的包"。
 *  · **策略与密钥同文件**。它们只有一起读才有意义（"要求签名"配"没有任何密钥"
 *    等于装不了任何插件），分两个文件会让 UI 更难说清当前状态。
 */
const { sha256hex } = require('../../shared/pluginSignature.js');
const { keyIdFor, publicKeyPem } = require('../../shared/pluginSignature.js');
const store = require('./PluginStateStore.js');

const FILE_VERSION = 1;

function emptyState() {
  return { version: FILE_VERSION, requireSignature: false, keys: {} };
}

function file() {
  return `${store.paths().state}/trust.json`;
}

function read() {
  const data = store.readJson(file(), null);
  if (!data || typeof data !== 'object' || !data.keys || typeof data.keys !== 'object') {
    return emptyState();
  }
  return {
    version: FILE_VERSION,
    requireSignature: !!data.requireSignature,
    keys: { ...data.keys },
  };
}

function write(state) {
  store.writeJsonAtomic(file(), {
    version: FILE_VERSION,
    requireSignature: !!state.requireSignature,
    keys: state.keys || {},
  });
}

/** 信任库视图（给 UI/CLI 用）。不含任何私钥信息，本来也不会有。 */
function list() {
  const state = read();
  const keys = Object.keys(state.keys)
    .map((id) => {
      const k = state.keys[id];
      return {
        keyId: id,
        name: k.name || '',
        // 指纹即 keyId 的主体部分：用户核对的就是这 16 位
        fingerprint: id.replace(/^[a-z0-9]+-/, ''),
        addedAt: k.addedAt || 0,
        source: k.source || 'import',
        publicKey: k.publicKey || '',
      };
    })
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  return { requireSignature: state.requireSignature, keys };
}

/**
 * 加一把公钥。
 * @param {{publicKey:string, name?:string, source?:string}} input
 */
function addKey(input = {}) {
  let pem;
  try {
    // publicKeyPem 接受私钥也接受公钥：作者常常直接把私钥文件指过来。
    // 这里只取公钥部分，私钥不会落到信任库里。
    pem = publicKeyPem(input.publicKey || '');
  } catch (err) {
    return { ok: false, error: `无法解析公钥：${err.message}` };
  }
  const keyId = keyIdFor(pem);
  const state = read();
  const existing = state.keys[keyId];
  state.keys[keyId] = {
    keyId,
    name: String(input.name || (existing && existing.name) || '').slice(0, 120),
    publicKey: pem,
    addedAt: (existing && existing.addedAt) || Date.now(),
    source: input.source || 'import',
  };
  write(state);
  store.audit(existing ? 'trust-update' : 'trust-add', null, {
    keyId, name: state.keys[keyId].name, fingerprint: keyId.replace(/^[a-z0-9]+-/, ''),
  });
  return { ok: true, key: { keyId, name: state.keys[keyId].name }, replaced: !!existing };
}

function removeKey(keyId) {
  const state = read();
  if (!state.keys[keyId]) return { ok: false, error: `信任列表里没有 ${keyId}` };
  const name = state.keys[keyId].name || '';
  delete state.keys[keyId];
  write(state);
  store.audit('trust-remove', null, { keyId, name });
  return { ok: true };
}

/** 只允许安装已签名插件。开这个开关时，未签名的包会在校验阶段被拒。 */
function setRequireSignature(enabled) {
  const state = read();
  state.requireSignature = !!enabled;
  write(state);
  store.audit('trust-policy', null, { requireSignature: state.requireSignature });
  return { ok: true, requireSignature: state.requireSignature };
}

/** 给签名校验用的 keyId → { publicKey } 映射。 */
function keyMap() {
  const state = read();
  const out = {};
  for (const [id, k] of Object.entries(state.keys)) out[id] = { publicKey: k.publicKey, name: k.name };
  return out;
}

/** 公钥派生指纹的便捷导出：CLI 与测试都要用同一份实现。 */
function fingerprintOf(pem) {
  return keyIdFor(pem).replace(/^[a-z0-9]+-/, '');
}

module.exports = {
  read,
  write,
  list,
  addKey,
  removeKey,
  setRequireSignature,
  keyMap,
  fingerprintOf,
  _internal: { sha256hex, emptyState },
};
