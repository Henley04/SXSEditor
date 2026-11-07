'use strict';
/**
 * 最小 ZIP 读取器：只解压，不写包、不校验 CRC。
 *
 * VOCALOID5/6 的 .vpr 其实是 ZIP（中央目录里是 `Project/sequence.json`），
 * 而插件进程不允许带 node_modules，所以这里按 PKZIP 规范自己读中央目录。
 * 支持 stored(0) / deflate(8) 两种存储方式，这两者覆盖了 VOCALOID 的实际输出。
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
 * @returns {Map<string, Buffer>} 归一化成正斜杠的路径 → 内容
 */
function readZip(buffer) {
  if (!isZip(buffer)) throw new Error('不是 ZIP 容器');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('ZIP 缺少中央目录（文件可能被截断）');

  const count = buffer.readUInt16LE(eocd + 10);
  const dirSize = buffer.readUInt32LE(eocd + 12);
  const dirOffset = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('ZIP 条目数量异常');
  if (dirOffset + dirSize > buffer.length) throw new Error('ZIP 中央目录越界');

  const files = new Map();
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

    if (uncompressedSize > MAX_ENTRY_SIZE) throw new Error(`ZIP 条目过大：${name}`);
    total += uncompressedSize;
    if (total > MAX_TOTAL_SIZE) throw new Error('ZIP 解压后体积超出上限');

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
      data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_SIZE });
    } else {
      throw new Error(`ZIP 压缩方式不支持（${method}）：${name}`);
    }
    files.set(name, data);
  }
  return files;
}

module.exports = { isZip, readZip };
