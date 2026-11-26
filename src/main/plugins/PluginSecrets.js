'use strict';

/**
 * 插件密钥（`permissions.secrets`）的归属、校验与上限。
 *
 * 三个决定：
 *   1. **每个插件一个文件** `<userData>/plugin-data/<id>/secrets.enc`。不用一张大表，
 *      是因为卸载/保留数据、备份、以及"只删某个插件的密钥"都要按插件粒度操作；
 *      一张大表会让一次误删波及所有人。
 *   2. **值只在宿主与插件之间走内存**，不落日志、不进审计、不进快照。审计只记
 *      key 名与动作 —— "谁在什么时候改了哪个密钥"是可回答的，"值是什么"不可回答。
 *   3. **上限是产品特性而不是限制**：密钥不是数据库。64 个 key × 8KB 足以覆盖
 *      token / cookie / 本地证书，超过这个量级说明插件在拿它当存储用。
 *
 * 这里不做权限判断：权限门在 PluginService（它才知道 manifest）。本类只负责
 * "数据放哪、长什么样、能不能写"。
 */

const path = require('node:path');
const { createSafeStorageSecrets } = require('../secretsStore.js');

const LIMITS = Object.freeze({
  maxKeys: 64,
  maxValueBytes: 8192,
  maxKeyLength: 64,
});

// 与命令 id 同一套字符集：允许点号做分层（`cloud.apiKey`），不允许斜杠与 `..` 之外
// 的花样 —— key 会出现在审计与界面里，能一眼读懂的才是好 key。
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function checkKey(key) {
  if (typeof key !== 'string' || !key) return { ok: false, error: '密钥名必须是非空字符串' };
  if (key.length > LIMITS.maxKeyLength) {
    return { ok: false, error: `密钥名最长 ${LIMITS.maxKeyLength} 个字符` };
  }
  if (!KEY_RE.test(key)) {
    return { ok: false, error: '密钥名只能包含字母、数字、点、下划线、连字符，且以字母或数字开头' };
  }
  return { ok: true, value: key };
}

function checkValue(value) {
  if (typeof value !== 'string') return { ok: false, error: '密钥值必须是字符串' };
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > LIMITS.maxValueBytes) {
    return { ok: false, error: `密钥值最长 ${LIMITS.maxValueBytes} 字节（当前 ${bytes}）` };
  }
  return { ok: true, value };
}

class PluginSecrets {
  /**
   * @param {{dir:string, safeStorage?:object, logger?:object}} opts
   *        dir 是 `plugin-data` 根目录，每个插件在其下有一个子目录。
   */
  constructor(opts) {
    this.dir = path.resolve(opts.dir);
    this.safeStorage = opts.safeStorage || null;
    this.logger = opts.logger || console;
    /** @type {Map<string, object>} 已打开的文件缓存：密钥文件很小，读一次就够 */
    this._stores = new Map();
  }

  file(pluginId) {
    return path.join(this.dir, pluginId, 'secrets.enc');
  }

  _store(pluginId) {
    let s = this._stores.get(pluginId);
    if (!s) {
      s = createSafeStorageSecrets({
        file: this.file(pluginId),
        safeStorage: this.safeStorage,
        logger: this.logger,
        label: `plugin:${pluginId}`,
      });
      this._stores.set(pluginId, s);
    }
    return s;
  }

  /** 读一个密钥。不存在时 `value: null`（空字符串是"存在但为空"，两者必须能分）。 */
  get(pluginId, key) {
    const k = checkKey(key);
    if (!k.ok) return { ok: false, error: k.error };
    const value = this._store(pluginId).get(k.value);
    return { ok: true, value: value === undefined ? null : value };
  }

  /**
   * 写一个密钥。新增时检查数量上限；覆盖已有 key 不受上限影响。
   * @returns {{ok:true, created:boolean, encrypted:boolean}|{ok:false, error:string, code?:string}}
   */
  set(pluginId, key, value) {
    const k = checkKey(key);
    if (!k.ok) return { ok: false, error: k.error, code: 'INVALID_REQUEST' };
    const v = checkValue(value);
    if (!v.ok) return { ok: false, error: v.error, code: 'INVALID_REQUEST' };

    const store = this._store(pluginId);
    const created = !store.has(k.value);
    if (created && store.size() >= LIMITS.maxKeys) {
      return { ok: false, error: `每个插件最多 ${LIMITS.maxKeys} 个密钥`, code: 'LIMIT_EXCEEDED' };
    }
    store.set(k.value, v.value);
    return { ok: true, created, encrypted: store.isEncrypted() };
  }

  /** @returns {{ok:true, existed:boolean}|{ok:false, error:string, code?:string}} */
  delete(pluginId, key) {
    const k = checkKey(key);
    if (!k.ok) return { ok: false, error: k.error, code: 'INVALID_REQUEST' };
    return { ok: true, existed: this._store(pluginId).delete(k.value) };
  }

  /** 只回名字，不回值。 */
  keys(pluginId) {
    const store = this._store(pluginId);
    return { ok: true, keys: store.keys(), encrypted: store.isEncrypted() };
  }

  /**
   * 只丢内存缓存，磁盘文件保留。重装/重载后必须调：否则同一个 id 会拿到上一份
   * 内存里的旧密钥（文件已经换了，缓存还活着）。
   */
  invalidate(pluginId) {
    this._stores.delete(pluginId);
  }

  /**
   * 丢掉内存缓存与磁盘文件。卸载时用（`keepData:false` 时其实整目录已经删了，
   * 这里主要处理 keepData 之外的显式清理与缓存失效）。
   */
  clear(pluginId) {
    this._stores.delete(pluginId);
    try {
      const fs = require('node:fs');
      fs.rmSync(this.file(pluginId), { force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /** 当前机器是否真的在加密（Linux 无 keyring 时为 false，界面必须如实告知）。 */
  isEncrypted(pluginId) {
    return this._store(pluginId).isEncrypted();
  }
}

module.exports = { PluginSecrets, LIMITS, checkKey, checkValue };
