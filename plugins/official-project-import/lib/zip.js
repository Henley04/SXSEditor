'use strict';
/**
 * 最小 ZIP 读取器：只解压，不写包、不校验 CRC。
 *
 * VOCALOID5/6 的 .vpr 其实是 ZIP（中央目录里是 `Project/sequence.json`），
 * 而插件进程不允许带 node_modules，所以这里按 PKZIP 规范自己读中央目录。
 * 支持 stored(0) / deflate(8) 两种存储方式，这两者覆盖了 VOCALOID 的实际输出。
 *
 * 按需解压：`.vpr` 里除了工程 JSON，还常有 `Project/Audio/*.wav` 这类素材
 * （带伴奏的工程必然有）。它们对宿主毫无用处，却动辄几十 MB —— 无差别解压
 * 既白烧内存，也会被下面的体积上限连坐成"带伴奏就打不开"。所以 readZip
 * 接受一个 `accept` 谓词：不接受的条目只从中央目录读出名字与声明大小，
 * 记进 `skipped` 后原样放过，一个字节都不解压。
 */
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRY_SIZE = 32 * 1024 * 1024;
const MAX_TOTAL_SIZE = 64 * 1024 * 1024;
const MAX_ENTRIES = 1024;

function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIG;
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buffer
 * @param {{accept?: (name: string, size: number) => boolean,
 *          maxEntrySize?: number, maxTotalSize?: number, maxEntries?: number}} [options]
 *   `accept` 返回 false 的条目不解压，只记进返回值的 `skipped`；
 *   `size` 是中央目录声明的大小（写入器省略时为压缩后大小，仅作量级参考）。
 * @returns {{files: Map<string, Buffer>, skipped: Array<{name: string, size: number}>}}
 *   `files` 归一化成正斜杠的路径 → 内容
 */
function readZip(buffer, options = {}) {
  if (!isZip(buffer)) throw new Error('不是 ZIP 容器');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('ZIP 缺少中央目录（文件可能被截断）');

  const accept = typeof options.accept === 'function' ? options.accept : null;
  const maxEntrySize = Number(options.maxEntrySize) > 0 ? Number(options.maxEntrySize) : MAX_ENTRY_SIZE;
  const maxTotalSize = Number(options.maxTotalSize) > 0 ? Number(options.maxTotalSize) : MAX_TOTAL_SIZE;
  const maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : MAX_ENTRIES;

  const count = buffer.readUInt16LE(eocd + 10);
  const dirSize = buffer.readUInt32LE(eocd + 12);
  const dirOffset = buffer.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw new Error('ZIP 条目数量异常');
  if (dirOffset + dirSize > buffer.length) throw new Error('ZIP 中央目录越界');

  const files = new Map();
  const skipped = [];
  let total = 0;
  let pos = dirOffset;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CENTRAL_SIG) {
      throw new Error('ZIP 中央目录损坏');
    }
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen).replace(/\\/g, '/');
    pos += 46 + nameLen + extraLen + commentLen;

    // VOCALOID 的输出总会填 uncompressedSize；但 data descriptor（标志位 3）
    // 允许写入器把它留空 —— 那种情况下压缩后大小是唯一的下界，用它做量级判断。
    const declaredSize = uncompressedSize || compressedSize;

    if (accept && !accept(name, declaredSize)) {
      skipped.push({ name, size: declaredSize });
      continue;
    }

    if (declaredSize > maxEntrySize) throw new Error(`ZIP 条目过大：${name}`);
    total += declaredSize;
    if (total > maxTotalSize) throw new Error('ZIP 解压后体积超出上限');

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`ZIP 本地头损坏：${name}`);
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`ZIP 条目越界：${name}`);
    const raw = buffer.subarray(dataStart, dataEnd);

    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = zlib.inflateRawSync(raw, { maxOutputLength: maxEntrySize });
    } else {
      throw new Error(`ZIP 压缩方式不支持（${method}）：${name}`);
    }
    files.set(name, data);
  }
  return { files, skipped };
}

let CRC_TABLE = null;

/** PKZIP 要求的 CRC-32（IEEE 802.3 多项式）。 */
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 最小 ZIP 写入器（与 readZip 对称）。
 *
 * VOCALOID5/6 的 .vpr 是 ZIP，工程内容在 `Project/sequence.json`。插件进程不能带
 * node_modules，也不能写文件，所以这里自己按 PKZIP 规范组包，把字节交回宿主写盘。
 * 只实现 stored(0) / deflate(8) 两种，恰好覆盖 readZip 支持的范围。
 *
 * @param {Array<{name:string, data:Buffer|string}>|Map<string,Buffer|string>} files
 * @param {{method?:'stored'|'deflate'}} [options]
 * @returns {Buffer}
 */
function writeZip(files, options = {}) {
  const list = (files instanceof Map)
    ? [...files.entries()].map(([name, data]) => ({ name, data }))
    : (Array.isArray(files) ? files : []);
  const method = options.method === 'stored' ? 0 : 8;
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let centralSize = 0;

  for (const entry of list) {
    const name = String(entry.name || '').replace(/\\/g, '/');
    if (!name) continue;
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data == null ? '' : entry.data), 'utf8');
    const payload = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags：无数据描述符、无加密
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x21, 12);       // mod date：1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra length
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0, 8);         // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra length
    central.writeUInt16LE(0, 32);        // comment length
    central.writeUInt16LE(0, 34);        // disk number start
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);   // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
    centralSize += central.length + nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);   // entries on this disk
  eocd.writeUInt16LE(list.length, 10);  // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);       // central directory offset
  eocd.writeUInt16LE(0, 20);            // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

module.exports = { isZip, readZip, writeZip, crc32 };
