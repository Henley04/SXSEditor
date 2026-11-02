'use strict';
/**
 * 无依赖的 zip 读写（CJS）—— `.sxsp` 包格式的底座。
 *
 * 为什么不引第三方库：安装器要跑在用户机器上，第三方 zip 库的 zip-slip / 压缩炸弹
 * 历史问题不少；这里只需要「deflate + 中央目录」这一小撮功能，自己写反而能把
 * 安全校验（绝对路径、`..`、符号链接、条目数与体积上限）钉死在解析环节。
 *
 * 支持范围：store(0) 与 deflate(8)，UTF-8 文件名，无 zip64（>4GB 的单文件直接拒绝，
 * 对插件包没有意义）。写侧的产物可被 Windows 资源管理器 / macOS 归档工具解开。
 */
const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * 归一化 zip 内部路径，拒绝一切可能逃出目标目录的写法。
 * @returns {string|null} null 表示该条目非法，整个包应被拒绝
 */
function normalizeEntryPath(name) {
  if (typeof name !== 'string' || !name) return null;
  const p = name.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;   // 绝对路径
  const parts = p.split('/');
  if (parts.some((seg) => seg === '..')) return null;           // 目录穿越
  if (parts[0] === '.git' || p.includes('/.git/')) return null; // 无意义的版本库残留
  return parts.filter((s) => s && s !== '.').join('/');
}

/**
 * 解析 zip。
 * @param {Buffer} buf
 * @param {{maxEntries?:number,maxTotalBytes?:number,maxSingleFileBytes?:number}} [limits]
 * @returns {{entries: Array<{path:string, data:Buffer, isDirectory:boolean}>}}
 */
function readZip(buf, limits = {}) {
  const maxEntries = limits.maxEntries || 20000;
  const maxTotalBytes = limits.maxTotalBytes || 512 * 1024 * 1024;
  const maxSingle = limits.maxSingleFileBytes || 256 * 1024 * 1024;

  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip：文件过短');
  if (buf.readUInt32LE(0) !== SIG_LOCAL && buf.readUInt32LE(0) !== SIG_CENTRAL) {
    // 允许空 zip（只有 EOCD）以外的所有正常情况
    throw new Error('不是有效的 zip：缺少本地文件头');
  }

  // 从尾部向前找 EOCD（注释最长 65535）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw new Error(`zip 条目过多（${count} > ${maxEntries}）`);
  if (cdOffset >= buf.length) throw new Error('zip 中央目录偏移越界');

  const entries = [];
  let total = 0;
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error('zip 中央目录损坏');
    }
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttr = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const rawName = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');

    const path = normalizeEntryPath(rawName);
    const isDirectory = /\/$/.test(rawName) || (externalAttr & 0x10) !== 0;

    // 符号链接：unix 模式下 externalAttr 高 16 位是 st_mode
    const unixMode = (externalAttr >>> 16) & 0xffff;
    if (unixMode && (unixMode & 0xf000) === 0xa000) {
      throw new Error(`zip 含符号链接条目：${rawName}`);
    }

    if (path === null) {
      throw new Error(`zip 含非法路径条目：${rawName}`);
    }
    if (path === '') {
      pos += 46 + nameLen + extraLen + commentLen;
      continue;
    }

    if (uncompSize > maxSingle) throw new Error(`zip 条目过大：${path}`);
    total += uncompSize;
    if (total > maxTotalBytes) throw new Error('zip 解压后总大小超过上限');

    if (!isDirectory) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
        throw new Error(`zip 本地头损坏：${path}`);
      }
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const dataEnd = dataStart + compSize;
      if (dataEnd > buf.length) throw new Error(`zip 数据越界：${path}`);
      const raw = buf.slice(dataStart, dataEnd);

      let data;
      if (method === 0) {
        data = Buffer.from(raw);
      } else if (method === 8) {
        try {
          data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(uncompSize, 1024) * 2 });
        } catch (err) {
          throw new Error(`zip 解压失败：${path}（${err.message}）`);
        }
      } else {
        throw new Error(`不支持的压缩方式 ${method}：${path}`);
      }
      if (data.length !== uncompSize) {
        throw new Error(`zip 条目大小不符：${path}（声明 ${uncompSize}，实际 ${data.length}）`);
      }
      entries.push({ path, data, isDirectory: false });
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return { entries };
}

/**
 * 生成 zip。目录通过条目名末尾的 `/` 隐式表达，不需要单独写入。
 * @param {Array<{path:string, data:Buffer|string}>} files
 * @returns {Buffer}
 */
function createZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const path = normalizeEntryPath(file.path);
    if (!path) throw new Error(`非法条目路径：${file.path}`);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const nameBuf = Buffer.from(path, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0, 12);          // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attr
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attr: -rw-r--r--
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = { readZip, createZip, crc32, normalizeEntryPath };
