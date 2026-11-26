'use strict';

/**
 * 密钥存储适配器（主进程专用）。
 *
 * 优先用 Electron 的 safeStorage（macOS Keychain / Windows DPAPI / Linux libsecret）。
 * Linux 上没有密钥环时 `isEncryptionAvailable()` 返回 false —— 这时**不静默降级**：
 * 还是要存，但要把 `encrypted:false` 报给调用方，由 UI/日志明写"本机未启用系统密钥环，
 * 密钥以明文存储"。让用户知道，比让用户以为安全要好。
 *
 * 为什么两个调用方（模型端点、插件密钥）共用这一份：加密、0600、tmp→rename、以及
 * "降级时必须说出来"这四件事，任何一处实现漂移都会变成安全问题。共用一份就只有一个
 * 地方需要被审。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {{file:string, safeStorage?:object, logger?:object, label?:string}} opts
 */
function createSafeStorageSecrets(opts) {
  const file = opts.file;
  const safe = opts.safeStorage || null;
  const log = opts.logger || console;
  const label = opts.label || 'secrets';
  /** @type {Map<string, string>} */
  const memory = new Map();
  let encrypted = !!(safe && safe.isEncryptionAvailable && safe.isEncryptionAvailable());

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      encrypted = parsed.encrypted !== false;
      const body = parsed.data || {};
      for (const [id, value] of Object.entries(body)) {
        if (typeof value !== 'string') continue;
        try {
          memory.set(id, encrypted && safe ? safe.decryptString(Buffer.from(value, 'base64')) : value);
        } catch (err) {
          // 单条解密失败不能拖垮整个存储：最常见的原因是系统密钥环换了（换机、
          // 重装、从备份恢复 userData）。跳过这一条并留痕，其余条目照常可用。
          log.warn(`[${label}] 密钥 ${id} 解密失败（系统密钥环可能已更换）：`, err && err.message);
        }
      }
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') log.warn(`[${label}] 密钥文件读取失败：`, err.message);
  }

  function persist() {
    const body = {};
    let plaintext = !encrypted || !safe;

    if (!plaintext) {
      try {
        for (const [id, value] of memory) {
          body[id] = safe.encryptString(value).toString('base64');
        }
      } catch (err) {
        // "声称可加密、实际加密失败"是 Linux 上真实存在的状态（keyring 在构造后
        // 掉线）。此时不能留下半加密文件 —— 整体降级为明文，并把 encrypted 改掉，
        // 下次读取时才不会拿明文去 decrypt。
        log.warn(`[${label}] 加密失败，降级为明文存储：`, err && err.message);
        plaintext = true;
        encrypted = false;
      }
    }
    if (plaintext) {
      for (const [id, value] of memory) body[id] = value;
    }

    try {
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // mkdir 的 mode 只对"新建"生效；插件数据目录通常是 installer 用默认 umask
      // 建的（755），不改的话同机其他用户能列出"这个插件存了密钥文件"。
      try { fs.chmodSync(dir, 0o700); } catch (_) { /* Windows 上可能不支持 */ }
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, encrypted, data: body }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn(`[${label}] 密钥落盘失败：`, err && err.message);
    }
  }

  return {
    get: (id) => (memory.has(id) ? memory.get(id) : null),
    has: (id) => memory.has(id),
    set: (id, value) => { memory.set(id, String(value)); persist(); },
    delete: (id) => {
      const existed = memory.delete(id);
      if (existed) persist();
      return existed;
    },
    /** 只回 key 名，不回值 —— 用于"这个插件存了哪些密钥"的展示与上限检查。 */
    keys: () => [...memory.keys()].sort(),
    size: () => memory.size,
    isEncrypted: () => encrypted,
    file,
  };
}

module.exports = { createSafeStorageSecrets };
