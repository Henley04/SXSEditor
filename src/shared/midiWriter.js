/**
 * Standard MIDI File 编码基元 —— 全仓唯一一份。
 *
 * 为什么抽出来：分片编辑器已有一份单轨（format 0）编码器，项目级导出需要
 * 多轨（format 1）。如果各写一份 vlq / meta / 拍号编码，两边对"同 tick 事件
 * 谁先"、"结束标记放哪"这类细节的理解迟早分叉，导出的 MIDI 在不同 DAW 里
 * 表现不一致，而且这种差异很难在代码评审里看出来。
 *
 * 本模块无 DOM、无 state，主窗口与分片编辑器共用。
 */

/** 每四分音符 480 tick：够细（三连音、64 分音符都能整除），也是常见默认值。 */
export const MIDI_PPQ = 480;

/** 音量统一 96：工程里没有力度概念，写满 127 会让所有音符听起来像敲击。 */
export const MIDI_DEFAULT_VELOCITY = 96;

export function midiU16(value) {
  return [(value >>> 8) & 0xff, value & 0xff];
}

export function midiU32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function midiAscii(text) {
  return Array.from(text, c => c.charCodeAt(0));
}

export function midiUtf8(text) {
  // 走 globalThis 取 TextEncoder：本模块在渲染层、主进程、worker 三处共用，
  // 直接引用全局名在部分 lint 环境里会被判为未定义符号。
  return Array.from(new globalThis.TextEncoder().encode(text));
}

/**
 * 可变长度数量（VLQ）：MIDI 里 delta-time 与 meta 长度都用它。
 * 每字节 7 位有效，最高位表示"还有后续字节"。
 */
export function midiVlq(value) {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
}

export function midiMeta(type, data) {
  return [0xff, type, ...midiVlq(data.length), ...data];
}

/**
 * 拍号编码：[分子, log2(分母), 24, 8]
 * （24 = 每分钟节拍器点击对应的 MIDI clock 数，8 = 每四分音符的 32 分音符数）。
 * 分母取最近的 2 的幂并夹到 0..7 —— 超出范围的值会让部分宿主直接拒绝加载。
 */
export function midiTimeSignatureBytes(timeSignature) {
  const num = Number(timeSignature?.[0]);
  const den = Number(timeSignature?.[1]);
  const numerator = Number.isFinite(num) && num > 0 ? Math.max(1, Math.min(255, Math.round(num))) : 4;
  const denominator = Number.isFinite(den) && den > 0 ? Math.round(den) : 4;
  const dd = Math.max(0, Math.min(7, Math.round(Math.log2(denominator))));
  return [numerator, dd, 24, 8];
}

/**
 * 把事件序列编码成一条 MTrk 数据（含末尾 end-of-track）。
 *
 * @param {Array<{tick:number, order:number, bytes:number[]}>} events
 *   order 决定同一 tick 内的先后：0 = 音符结束/元事件，1 = 音符开始。
 *   同一音高的 off 必须先于 on，否则会得到"零长度音符"或悬挂音符。
 * @returns {number[]}
 */
export function encodeMidiTrack(events) {
  const sorted = events.slice().sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes = [];
  let previousTick = 0;
  for (const event of sorted) {
    bytes.push(...midiVlq(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  bytes.push(0x00, 0xff, 0x2f, 0x00);
  return bytes;
}

/**
 * 组装完整 SMF。
 *
 * @param {Object} opts
 * @param {0|1} [opts.format=1] 0 = 单轨，1 = 多轨（每条 MTrk 独立）
 * @param {number} [opts.ppq=MIDI_PPQ]
 * @param {number[][]} opts.tracks 每条轨已编码好的 MTrk 数据
 * @returns {Uint8Array}
 */
export function assembleMidiFile({ format = 1, ppq = MIDI_PPQ, tracks }) {
  const chunks = Array.isArray(tracks) ? tracks : [];
  const out = [
    ...midiAscii('MThd'), ...midiU32(6),
    ...midiU16(format), ...midiU16(chunks.length), ...midiU16(ppq),
  ];
  for (const track of chunks) {
    out.push(...midiAscii('MTrk'), ...midiU32(track.length), ...track);
  }
  return new Uint8Array(out);
}
