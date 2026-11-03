'use strict';

/**
 * 模型端点的访问控制（ACL）。
 *
 * 一条记录 = (subject, endpointId) → { decision, scope, fingerprint, grantedAt }
 *
 * 三个刻意的设计：
 *
 * 1. **没有记录 = ask**，不是 allow 也不是 deny。allow 太松（装个插件就把付费端点
 *    交出去），deny 太硬（每个插件都要先去设置页手配一遍，用户会直接放弃）。
 * 2. **指纹变化即失效**。授权绑的是"这个地址 + 这家服务 + 这种协议"这一串属性，
 *    而不是一个字符串 id：否则插件把 baseUrl 从 api.example.com 改成 api.evil.com，
 *    还能沿用上次那句"允许"。
 * 3. **once / session 不落盘**。once 用完即删，session 随进程消失。只有用户明确
 *    点过"始终允许"才写磁盘 —— 这条是"减少手滑永久授权"的唯一保障。
 */

const crypto = require('node:crypto');
const { DECISIONS, SCOPES } = require('../../shared/modelContract');

/** 端点属性指纹。任一变化都视为"另一个端点"。 */
function fingerprintOf(endpoint) {
  if (!endpoint) return '';
  const raw = [
    String(endpoint.baseUrl || '').replace(/\/+$/, '').toLowerCase(),
    String(endpoint.provider || '').toLowerCase(),
    String(endpoint.adapter || '').toLowerCase(),
  ].join('\n');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function keyOf(subject, endpointId) {
  return `${subject}\u0000${endpointId}`;
}

class ModelAcl {
  /**
   * @param {{store?:{load:Function,save:Function}, now?:Function}} opts
   *   store 为 null 时纯内存（单测与临时会话用）
   */
  constructor(opts = {}) {
    this._store = opts.store || null;
    this._now = opts.now || (() => Date.now());
    /** @type {Map<string, {subject:string, endpointId:string, decision:string, scope:string, fingerprint:string, grantedAt:number}>} */
    this._records = new Map();
    /** subject 级总开关：只允许 'deny'（连问都不问）。 */
    this._subjectPolicy = new Map();
    this._load();
  }

  _load() {
    if (!this._store) return;
    let rows = [];
    try {
      rows = this._store.load() || [];
    } catch (_) {
      rows = [];
    }
    for (const r of rows) {
      if (!r || !r.subject || !r.endpointId) continue;
      // 只认 always：磁盘上不该出现 session/once，出现说明上一版写错了，直接丢
      if (r.scope !== 'always') continue;
      if (!DECISIONS.includes(r.decision)) continue;
      this._records.set(keyOf(r.subject, r.endpointId), {
        subject: r.subject,
        endpointId: r.endpointId,
        decision: r.decision,
        scope: 'always',
        fingerprint: String(r.fingerprint || ''),
        grantedAt: Number(r.grantedAt) || 0,
      });
    }
  }

  _save() {
    if (!this._store) return;
    const rows = [];
    for (const r of this._records.values()) {
      if (r.scope === 'always') rows.push(r);
    }
    try {
      this._store.save(rows);
    } catch (_) {
      // 落盘失败不能影响本次调用：权限判定还活着，只是重启后要重新问一遍
    }
  }

  /** 该 subject 的整体策略。目前只有 deny 一种。 */
  setSubjectPolicy(subject, policy) {
    if (policy === 'deny') this._subjectPolicy.set(subject, 'deny');
    else this._subjectPolicy.delete(subject);
  }

  getSubjectPolicy(subject) {
    return this._subjectPolicy.get(subject) || null;
  }

  /**
   * 判定一次调用。
   *
   * @param {string} subject `plugin:<id>` / `mcp:<tokenId>` / `host`
   * @param {object} endpoint 端点记录（需含 id / baseUrl / provider / adapter）
   * @param {{bypassAll?:boolean, localFree?:boolean}} [opts]
   *   bypassAll：MCP token 级"跳过所有确认"；localFree：本地端点免确认总开关
   * @returns {{decision:'allow'|'deny'|'ask', scope:string, reason:string}}
   */
  decide(subject, endpoint, opts = {}) {
    if (!endpoint || !endpoint.id) return { decision: 'deny', scope: '', reason: 'no-endpoint' };

    if (this._subjectPolicy.get(subject) === 'deny') {
      return { decision: 'deny', scope: '', reason: 'subject-deny' };
    }

    if (opts.bypassAll) {
      return { decision: 'allow', scope: 'bypass-all', reason: 'bypass-all' };
    }

    const key = keyOf(subject, endpoint.id);
    const rec = this._records.get(key);
    const fp = fingerprintOf(endpoint);

    if (rec) {
      // 指纹不符 = 端点被改过。旧授权不能继承，直接作废并重新问。
      if (rec.fingerprint && fp && rec.fingerprint !== fp) {
        this._records.delete(key);
        this._save();
        return { decision: 'ask', scope: '', reason: 'fingerprint-changed' };
      }
      return { decision: rec.decision, scope: rec.scope, reason: 'granted' };
    }

    // 本地端点免确认：只对 device 生效。lan 必须用户显式标记成 device 才走这里，
    // 因为"内网服务器"可能计费、可能是别人管的机器。
    if (opts.localFree && endpoint.locality === 'device') {
      return { decision: 'allow', scope: 'local-bypass', reason: 'local-bypass' };
    }

    return { decision: 'ask', scope: '', reason: 'no-record' };
  }

  /** 写入一条授权。scope 必填，默认 session（不落盘）。 */
  grant(subject, endpoint, decision, scope = 'session') {
    if (!endpoint || !endpoint.id) throw new Error('grant 需要端点');
    if (!DECISIONS.includes(decision)) throw new Error(`未知 decision：${decision}`);
    if (!SCOPES.includes(scope)) throw new Error(`未知 scope：${scope}`);
    this._records.set(keyOf(subject, endpoint.id), {
      subject,
      endpointId: endpoint.id,
      decision,
      scope,
      fingerprint: fingerprintOf(endpoint),
      grantedAt: this._now(),
    });
    if (scope === 'always') this._save();
    return this.get(subject, endpoint.id);
  }

  get(subject, endpointId) {
    return this._records.get(keyOf(subject, endpointId)) || null;
  }

  /** 撤销一条。返回是否真的删掉了。 */
  revoke(subject, endpointId) {
    const key = keyOf(subject, endpointId);
    const rec = this._records.get(key);
    if (!rec) return false;
    this._records.delete(key);
    if (rec.scope === 'always') this._save();
    return true;
  }

  /** 一次性授权的消费：调用结束后删掉，下次重新问。 */
  consumeOnce(subject, endpointId) {
    const rec = this.get(subject, endpointId);
    if (rec && rec.scope === 'once') {
      this._records.delete(keyOf(subject, endpointId));
      return true;
    }
    return false;
  }

  /** 端点被删除时级联清理。 */
  revokeAllForEndpoint(endpointId) {
    let n = 0;
    for (const [key, rec] of [...this._records]) {
      if (rec.endpointId === endpointId) {
        this._records.delete(key);
        n++;
      }
    }
    if (n) this._save();
    return n;
  }

  /** 插件卸载 / token 吊销时级联清理。 */
  revokeAllForSubject(subject) {
    let n = 0;
    for (const [key, rec] of [...this._records]) {
      if (rec.subject === subject) {
        this._records.delete(key);
        n++;
      }
    }
    this._subjectPolicy.delete(subject);
    if (n) this._save();
    return n;
  }

  /** 供设置页展示：某个 subject 的全部授权。 */
  listForSubject(subject) {
    const out = [];
    for (const rec of this._records.values()) {
      if (rec.subject === subject) out.push({ ...rec });
    }
    return out.sort((a, b) => b.grantedAt - a.grantedAt);
  }

  /** 供端点页展示"谁被授权过"。 */
  listForEndpoint(endpointId) {
    const out = [];
    for (const rec of this._records.values()) {
      if (rec.endpointId === endpointId) out.push({ ...rec });
    }
    return out.sort((a, b) => b.grantedAt - a.grantedAt);
  }

  /** 全量快照（设置页一次性读）。 */
  snapshot() {
    const subjects = new Map();
    for (const rec of this._records.values()) {
      if (!subjects.has(rec.subject)) subjects.set(rec.subject, []);
      subjects.get(rec.subject).push({ ...rec });
    }
    return {
      subjects: [...subjects].map(([subject, grants]) => ({
        subject,
        policy: this.getSubjectPolicy(subject),
        grants: grants.sort((a, b) => b.grantedAt - a.grantedAt),
      })),
    };
  }
}

module.exports = { ModelAcl, fingerprintOf };
