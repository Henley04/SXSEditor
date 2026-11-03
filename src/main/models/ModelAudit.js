'use strict';

/**
 * 模型调用的审计。
 *
 * 只记元数据，不记内容：记了 prompt 等于把用户的歌词和构思全部落盘，而这些数据
 * 恰恰是最不该随便留的。审计要能回答的是"谁、在什么时候、调了哪个端点、多少次、
 * 成功没有"，不是"说了什么"。
 *
 * bypass 的调用必须留痕（`scope: 'bypass-all'`）：用户关掉确认是为了效率，不是
 * 为了失去知情权。
 */

const fs = require('node:fs');
const path = require('node:path');

class ModelAudit {
  /**
   * @param {{file?:string, max?:number, now?:Function, flushMs?:number, logger?:object}} opts
   */
  constructor(opts = {}) {
    this.file = opts.file || null;
    this.max = opts.max || 2000;
    this._now = opts.now || (() => Date.now());
    this.log = opts.logger || console;
    /** @type {Array<object>} */
    this.entries = [];
    this._dirty = false;
    this._flushTimer = null;
    this._flushMs = opts.flushMs || 3000;
    if (this.file) this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const rows = JSON.parse(raw);
      if (Array.isArray(rows)) this.entries = rows.slice(-this.max);
    } catch (err) {
      if (err && err.code !== 'ENOENT') this.log.warn('[models] 审计文件读取失败：', err.message);
    }
  }

  record(entry) {
    const row = { ts: this._now(), ...entry };
    this.entries.push(row);
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
    }
    this._dirty = true;
    this._schedule();
    return row;
  }

  _schedule() {
    if (!this.file || this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, this._flushMs);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  flush() {
    if (!this.file || !this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn('[models] 审计落盘失败：', err && err.message);
    }
  }

  /**
   * 读最近记录。
   * @param {{limit?:number, subject?:string, endpointId?:string, kind?:string}} q
   */
  list(q = {}) {
    const limit = Math.min(Number(q.limit) || 100, this.max);
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (q.subject && e.subject !== q.subject) continue;
      if (q.endpointId && e.endpointId !== q.endpointId) continue;
      if (q.kind && e.kind !== q.kind) continue;
      out.push({ ...e });
    }
    return out;
  }

  /** 某 subject 在某端点上的调用次数（设置页用来显示"调过 47 次"）。 */
  countFor(subject, endpointId) {
    let n = 0;
    for (const e of this.entries) {
      if (e.kind !== 'invoke') continue;
      if (e.subject !== subject) continue;
      if (endpointId && e.endpointId !== endpointId) continue;
      n++;
    }
    return n;
  }

  dispose() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    this.flush();
  }
}

module.exports = { ModelAudit };
