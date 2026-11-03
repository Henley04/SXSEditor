'use strict';

/**
 * 二进制结果的句柄存储。
 *
 * 句柄不是"可猜的 jobId + 路径"，而是**不可伪造的 capability**：
 *
 *   { id, subject, jobId, sha256, size, mime, expiresAt, mac }
 *
 * 引用里不含真实路径。读取时校验 mac + subject + sha256 + size，四样全过才返回内容。
 * 只校验"路径存在"等于没判——任何拿到 jobId 的插件都能读别人的输出。
 *
 * 为什么按 subject 判而不是按 fs 权限判：一个纯 UI 插件调了 TTS，它请求的输出理应
 * 能拿回来，哪怕它没有任何文件权限。反过来，它有 fs 权限也不能读别人的音频。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ERR, LIMITS } = require('../../shared/modelContract');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

class ModelHandleStore {
  /**
   * @param {{dir:string, key:Buffer|string, now?:Function, maxBytes?:number, logger?:object}} opts
   */
  constructor(opts) {
    if (!opts || !opts.dir || !opts.key) throw new Error('ModelHandleStore 需要 dir 与 key');
    this.dir = opts.dir;
    this.key = Buffer.isBuffer(opts.key) ? opts.key : Buffer.from(String(opts.key), 'utf8');
    this._now = opts.now || (() => Date.now());
    this.maxBytes = opts.maxBytes || LIMITS.cacheBytes;
    this.log = opts.logger || console;
    /** @type {Map<string, object>} */
    this.index = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _mac(fields) {
    return crypto.createHmac('sha256', this.key)
      .update(JSON.stringify(fields))
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * 写入一份结果，返回句柄。小文件仍会落盘（内联由调用方按 256KB 阈值决定，
   * 这里只做"大对象"的那一半）。
   */
  put({ subject, jobId, data, mime = 'application/octet-stream', ttlMs = LIMITS.handleTtlMs }) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const digest = sha256(buf);
    const id = `h_${crypto.randomBytes(8).toString('hex')}`;
    const jobDir = path.join(this.dir, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const file = path.join(jobDir, `${id}.bin`);
    fs.writeFileSync(file, buf);
    const expiresAt = this._now() + ttlMs;
    const handle = {
      id,
      subject,
      jobId,
      sha256: digest,
      size: buf.length,
      mime,
      expiresAt,
      mac: this._mac([subject, jobId, digest, buf.length, expiresAt]),
    };
    this.index.set(id, { ...handle, file, lastAccess: this._now() });
    this.gc();
    return handle;
  }

  /**
   * 读取。先校验归属，再校验内容，最后才读盘。
   * @returns {Buffer}
   */
  read(handle, subject) {
    if (!handle || !handle.id) {
      throw Object.assign(new Error('句柄无效'), { code: ERR.INVALID_REQUEST });
    }
    const row = this.index.get(handle.id);
    if (!row) {
      throw Object.assign(new Error('句柄已过期或不存在'), { code: ERR.HANDLE_EXPIRED });
    }
    if (this._now() > row.expiresAt) {
      this._drop(handle.id);
      throw Object.assign(new Error('句柄已过期'), { code: ERR.HANDLE_EXPIRED });
    }
    // 归属判定：host 全可读；其余必须与签发时的 subject 完全一致
    if (subject !== 'host' && subject !== row.subject) {
      throw Object.assign(new Error('无权读取该句柄'), { code: ERR.PERMISSION_DENIED });
    }
    const expect = this._mac([row.subject, row.jobId, row.sha256, row.size, row.expiresAt]);
    if (expect !== handle.mac || handle.sha256 !== row.sha256 || Number(handle.size) !== row.size) {
      throw Object.assign(new Error('句柄校验失败'), { code: ERR.PERMISSION_DENIED });
    }
    const buf = fs.readFileSync(row.file);
    if (buf.length !== row.size || sha256(buf) !== row.sha256) {
      throw Object.assign(new Error('句柄内容已被篡改'), { code: ERR.PERMISSION_DENIED });
    }
    row.lastAccess = this._now();
    return buf;
  }

  /** 磁盘占用（字节）。 */
  usage() {
    let total = 0;
    for (const row of this.index.values()) total += row.size;
    return total;
  }

  /** LRU：删过期的，再按最久未用删到上限以内。 */
  gc() {
    const now = this._now();
    for (const [id, row] of [...this.index]) {
      if (now > row.expiresAt) this._drop(id);
    }
    if (this.usage() <= this.maxBytes) return 0;
    const rows = [...this.index.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    let dropped = 0;
    for (const [id] of rows) {
      if (this.usage() <= this.maxBytes) break;
      this._drop(id);
      dropped++;
    }
    return dropped;
  }

  _drop(id) {
    const row = this.index.get(id);
    if (!row) return;
    this.index.delete(id);
    try { fs.unlinkSync(row.file); } catch (_) { /* 已经不在了 */ }
    // 目录空了就一起删，避免 model-cache 下堆一堆空 jobDir
    try {
      const dir = path.dirname(row.file);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (_) { /* ignore */ }
  }

  /** 供测试与诊断。 */
  snapshot() {
    return [...this.index.values()].map((r) => ({
      id: r.id, subject: r.subject, jobId: r.jobId, size: r.size, expiresAt: r.expiresAt,
    }));
  }
}

module.exports = { ModelHandleStore, sha256 };
