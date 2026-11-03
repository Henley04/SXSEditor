'use strict';

/**
 * 密钥存储适配器（主进程专用）。
 *
 * 优先用 Electron 的 safeStorage（macOS Keychain / Windows DPAPI / Linux libsecret）。
 * Linux 上没有密钥环时 `isEncryptionAvailable()` 返回 false —— 这时**不静默降级**：
 * 还是要存，但要把 `encrypted:false` 报给设置页，由 UI 明写"本机未启用系统密钥环，
 * 密钥以明文存储"。让用户知道，比让用户以为安全要好。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {{file:string, safeStorage?:object, logger?:object}} opts
 */
function createSafeStorageSecrets(opts) {
  const file = opts.file;
  const safe = opts.safeStorage || null;
  const log = opts.logger || console;
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
        memory.set(id, encrypted && safe ? safe.decryptString(Buffer.from(value, 'base64')) : value);
      }
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') log.warn('[models] 密钥文件读取失败：', err.message);
  }

  function persist() {
    const body = {};
    for (const [id, value] of memory) {
      body[id] = encrypted && safe
        ? safe.encryptString(value).toString('base64')
        : value;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, encrypted, data: body }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn('[models] 密钥落盘失败：', err && err.message);
    }
  }

  return {
    get: (id) => (memory.has(id) ? memory.get(id) : null),
    set: (id, value) => { memory.set(id, String(value)); persist(); },
    delete: (id) => { if (memory.delete(id)) persist(); },
    isEncrypted: () => encrypted,
  };
}

module.exports = { createSafeStorageSecrets };
