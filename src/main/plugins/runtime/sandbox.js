'use strict';
/**
 * 插件 runtime 的受限 IO：文件路径夹紧 + 每插件独立的状态文件。
 *
 * 诚实声明：这不是沙箱。插件仍然可以 `require('node:fs')` 绕过这里。
 * 这一层的价值是（1）让正常插件不用自己拼路径，（2）让越权访问变成"被审计的失败"
 * 而不是"无声的越界"。真正的边界是 utilityProcess + 安装时的权限告知。
 */
const fs = require('node:fs');
const path = require('node:path');

function isInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

class FsSandbox {
  /**
   * @param {{dataDir:string, pluginDir:string, perms:object, log?:Function}} opts
   */
  constructor(opts) {
    this.dataDir = path.resolve(opts.dataDir);
    this.pluginDir = path.resolve(opts.pluginDir);
    this.perms = opts.perms || {};
    this.log = opts.log || (() => {});
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  get fsPerms() {
    return Array.isArray(this.perms.fs) ? this.perms.fs : [];
  }

  _allowWrite() {
    return this.fsPerms.includes('pluginData');
  }

  /** 解析为绝对路径并夹紧到允许的根。 */
  _resolve(relPath, mode) {
    if (typeof relPath !== 'string' || !relPath) throw new Error('路径必须是非空字符串');
    const target = path.resolve(mode === 'read' ? this.pluginDir : this.dataDir, relPath);
    const roots = mode === 'read' ? [this.pluginDir, this.dataDir] : [this.dataDir];
    for (const root of roots) {
      if (isInside(root, target)) {
        // 软链穿透检查：父目录 realpath 之后仍要在根内
        try {
          const realParent = fs.realpathSync(path.dirname(target));
          if (!isInside(fs.realpathSync(root), realParent)) break;
        } catch (_) { /* 父目录不存在，交给调用方创建 */ }
        return target;
      }
    }
    throw new Error(`路径越界：${relPath}`);
  }

  readText(relPath) {
    return fs.readFileSync(this._resolve(relPath, 'read'), 'utf8');
  }

  readBinary(relPath) {
    return fs.readFileSync(this._resolve(relPath, 'read'));
  }

  writeText(relPath, text) {
    if (!this._allowWrite()) throw new Error('缺少权限 fs:pluginData');
    const target = this._resolve(relPath, 'write');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(text), 'utf8');
    return target;
  }

  writeBinary(relPath, buffer) {
    if (!this._allowWrite()) throw new Error('缺少权限 fs:pluginData');
    const target = this._resolve(relPath, 'write');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(buffer));
    return target;
  }

  exists(relPath) {
    try {
      return fs.existsSync(this._resolve(relPath, 'read'));
    } catch (_) {
      return false;
    }
  }

  list(relPath = '.') {
    const dir = this._resolve(relPath, 'read');
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  }

  /** 插件自己的状态文件（JSON）。与 fs 权限解耦：state 永远可用，体积极小。 */
  stateFile() {
    return path.join(this.dataDir, 'state.json');
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'));
    } catch (_) {
      return {};
    }
  }

  readStateKey(key) {
    return this.readState()[key];
  }

  writeStateKey(key, value) {
    const all = this.readState();
    if (value === undefined) delete all[key];
    else all[key] = value;
    const file = this.stateFile();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  }
}

module.exports = { FsSandbox, isInside };
