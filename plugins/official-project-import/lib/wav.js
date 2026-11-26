'use strict';
/**
 * 最小 WAV 读写：只做三件事 —— 读头、按毫秒裁剪、重新拼回 RIFF。
 *
 * 为什么需要它：VOCALOID 的音频轨在 `sequence.json` 里用 `region: {begin, end}`
 * （毫秒）记录"用了源文件的哪一段"。宿主没有"音频裁剪偏移"这个概念，只有
 * 起始拍与整段音频，所以裁剪必须在导入时做掉，否则伴奏整体平移。
 *
 * 只处理 PCM 家族（fmt 里 blockAlign / byteRate 自洽的那些）。裁剪按整帧对齐，
 * 因此不需要解释采样，也不需要重采样；真正的解码由宿主用 WebAudio 做。
 */

/** @returns {{ok:boolean, format:number, channels:number, sampleRate:number,
 *             bitsPerSample:number, blockAlign:number, dataOffset:number,
 *             dataSize:number, duration:number, fmtChunk:{offset:number, size:number}}} */
function parseWav(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buf.length < 44) return { ok: false };
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    return { ok: false };
  }

  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        offset: off,
        size,
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // 声明长度可能超出实际（文件被截断）：取两者较小值，宁可少一点也不要越界。
      data = { offset: body, size: Math.min(size, Math.max(0, buf.length - body)) };
      break;
    }
    off = body + size + (size % 2);
  }

  if (!fmt || !data || !fmt.channels || !fmt.sampleRate || !fmt.blockAlign) return { ok: false };
  const frames = Math.floor(data.size / fmt.blockAlign);
  return {
    ok: true,
    format: fmt.format,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    blockAlign: fmt.blockAlign,
    dataOffset: data.offset,
    dataSize: data.size,
    duration: frames / fmt.sampleRate,
    fmtChunk: { offset: fmt.offset, size: fmt.size },
  };
}

/**
 * 按毫秒裁剪出一段新的 WAV。
 *
 * 只重建 RIFF/WAVE + fmt + data 三个块：源文件的 JUNK、LIST、cue 之类的附加块
 * 对播放没有影响，带着它们反而要重新算每个块的长度。
 *
 * @param {Buffer} bytes 源 WAV
 * @param {object} info parseWav 的返回值
 * @param {number} startMs
 * @param {number} endMs
 * @returns {Buffer}
 */
function sliceWav(bytes, info, startMs, endMs) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!info || !info.ok) return buf;

  const frames = Math.floor(info.dataSize / info.blockAlign);
  const toFrame = (ms, fallback) => {
    const value = Number(ms);
    if (!Number.isFinite(value)) return fallback;
    return clamp(Math.round((value / 1000) * info.sampleRate), 0, frames);
  };
  const startFrame = toFrame(startMs, 0);
  const endFrame = Math.max(startFrame, toFrame(endMs, frames));
  if (startFrame === 0 && endFrame === frames) return buf;

  const from = info.dataOffset + startFrame * info.blockAlign;
  const to = info.dataOffset + endFrame * info.blockAlign;
  const pcm = buf.subarray(from, Math.min(to, buf.length));

  const fmtSize = Math.min(info.fmtChunk.size, buf.length - info.fmtChunk.offset - 8);
  const fmtBody = buf.subarray(info.fmtChunk.offset + 8, info.fmtChunk.offset + 8 + fmtSize);

  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + 8 + fmtBody.length + 8 + pcm.length + (fmtBody.length % 2), 4);
  header.write('WAVE', 8, 'latin1');

  const fmtHeader = Buffer.alloc(8);
  fmtHeader.write('fmt ', 0, 'latin1');
  fmtHeader.writeUInt32LE(fmtBody.length, 4);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'latin1');
  dataHeader.writeUInt32LE(pcm.length, 4);

  const parts = [header, fmtHeader, fmtBody];
  if (fmtBody.length % 2) parts.push(Buffer.alloc(1));
  parts.push(dataHeader, pcm);
  if (pcm.length % 2) parts.push(Buffer.alloc(1));
  return Buffer.concat(parts);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = { parseWav, sliceWav };
