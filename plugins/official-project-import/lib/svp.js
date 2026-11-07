'use strict';
/**
 * Synthesizer V / SV2 工程（.svp）读取。
 *
 * 结构依据开源实现 UtaFormatix（Apache-2.0）中的 SVP 实现与真实工程样本：
 *  - 文件是 JSON 文本；SV 允许一个文件里用 "\u0000" 串联多份工程，
 *    解析时取 version 最大的那一份（与 UtaFormatix 行为一致）。
 *  - 时间单位是 blick：每拍 705600000（= 480 × 1470000），
 *    与宿主工程的 480 tick/拍正好整除。
 *  - time.meter[].index 是拍号生效的小节序号，time.tempo[].position 是 blick。
 *  - 音符在 group 内：onset/duration 是相对 group 起点（mainRef.blickOffset）的 blick，
 *    pitch 为 MIDI 音高，lyrics 为歌词。
 *  - 音高曲线是 group.parameters.pitchDelta.points，扁平数组 [blick, cent, ...]，
 *    blick 相对 group 起点，cent 是相对基础音高的偏移。
 *  - 附加 group 通过 track.groups[].groupID 到 project.library[].uuid 里取内容。
 *
 * 已知取舍：SVP 的颤音（vibratoEnv / 音符颤音属性）没有等价字段，导入时明确告警。
 */

const { BLICK_PER_BEAT, normalizeColor, roundTime } = require('./score.js');

function decodeUtf8(bytes) {
  let buf = Buffer.from(bytes);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

function pickProject(bytes) {
  const text = decodeUtf8(bytes);
  const chunks = text
    .split('\u0000')
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  let best = null;
  for (const chunk of chunks) {
    let raw;
    try {
      raw = JSON.parse(chunk);
    } catch (_) {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    if (!Array.isArray(raw.tracks) || !raw.time) continue;
    const version = Number(raw.version) || 0;
    if (!best || version > best.version) best = { raw, version };
  }
  return best ? best.raw : null;
}

/** 扁平 [t, v, t, v...] → [{beat, semitones}]，按拍排序并按位置合并。 */
function toPitchOffsets(pitchDelta, blickOffset) {
  const points = pitchDelta && Array.isArray(pitchDelta.points) ? pitchDelta.points : [];
  const byBeat = new Map();
  for (let i = 0; i + 1 < points.length; i += 2) {
    const tick = Number(points[i]);
    const cent = Number(points[i + 1]);
    if (!Number.isFinite(tick) || !Number.isFinite(cent)) continue;
    const beat = (tick + blickOffset) / BLICK_PER_BEAT;
    const semitones = cent / 100;
    byBeat.set(roundTime(beat), semitones);
  }
  // 第一个包络点之前的偏移是 0（不是"第一点的值"）：否则整段开头会被平白
  // 抬高/压低，听起来像跑调。
  const startBeat = blickOffset / BLICK_PER_BEAT;
  if (byBeat.size && Math.min(...byBeat.keys()) > startBeat) {
    byBeat.set(roundTime(startBeat), 0);
  }
  return [...byBeat.entries()]
    .map(([beat, semitones]) => ({ beat, semitones }))
    .sort((a, b) => a.beat - b.beat);
}

function groupNotes(group, ref) {
  const blickOffset = Number(ref && ref.blickOffset) || 0;
  const pitchOffset = Number(ref && ref.pitchOffset) || 0;
  const notes = Array.isArray(group && group.notes) ? group.notes : [];
  return notes.map((note) => ({
    startBeat: ((Number(note.onset) || 0) + blickOffset) / BLICK_PER_BEAT,
    durationBeat: (Number(note.duration) || 0) / BLICK_PER_BEAT,
    pitch: (Number(note.pitch) || 0) + pitchOffset,
    lyric: note.lyrics,
  }));
}

/**
 * @param {Buffer} bytes
 * @param {(zh:string, en:string)=>string} t
 */
function parseSvp(bytes, t) {
  const raw = pickProject(bytes);
  if (!raw) throw new Error(t(
    '不是有效的 Synthesizer V 工程（缺少 tracks / time）',
    'Not a Synthesizer V project (missing tracks/time)',
  ));

  const warnings = [];

  const meters = Array.isArray(raw.time.meter) ? raw.time.meter.slice() : [];
  meters.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  const firstMeter = meters[0];
  const timeSignature = firstMeter
    ? { numerator: Number(firstMeter.numerator) || 4, denominator: Number(firstMeter.denominator) || 4 }
    : { numerator: 4, denominator: 4 };
  if (meters.length > 1) {
    warnings.push(t(
      `工程内有 ${meters.length} 处拍号变化，SXSEditor 只支持全局拍号，已使用 ${timeSignature.numerator}/${timeSignature.denominator}`,
      `${meters.length} time-signature changes found; SXSEditor supports one global meter, using ${timeSignature.numerator}/${timeSignature.denominator}`,
    ));
  }

  const tempos = (Array.isArray(raw.time.tempo) ? raw.time.tempo.slice() : [])
    .filter((e) => e && Number.isFinite(Number(e.bpm)))
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  const bpm = tempos.length ? Number(tempos[0].bpm) : 120;
  if (tempos.length > 1) {
    warnings.push(t(
      `工程内有 ${tempos.length} 处变速，SXSEditor 只支持全局 BPM，已使用第一处 ${bpm}`,
      `${tempos.length} tempo changes found; SXSEditor supports one global BPM, using the first (${bpm})`,
    ));
  }

  const library = Array.isArray(raw.library) ? raw.library : [];
  const groupsByUuid = new Map();
  for (const group of library) {
    if (group && typeof group.uuid === 'string') groupsByUuid.set(group.uuid, group);
  }

  const tracksRaw = (Array.isArray(raw.tracks) ? raw.tracks : []).slice();
  tracksRaw.sort((a, b) => (Number(a.dispOrder) || 0) - (Number(b.dispOrder) || 0));

  let unportedVibrato = 0;
  const tracks = [];

  tracksRaw.forEach((track, index) => {
    if (!track || typeof track !== 'object') return;

    const refs = [];
    if (track.mainGroup && track.mainRef) refs.push({ ref: track.mainRef, group: track.mainGroup });
    for (const ref of Array.isArray(track.groups) ? track.groups : []) {
      const group = ref && groupsByUuid.get(ref.groupID);
      if (!group) {
        warnings.push(t(
          `轨道「${track.name || index + 1}」有 1 个音符组在 library 中找不到，已跳过`,
          `A note group of track "${track.name || index + 1}" was missing from library and was skipped`,
        ));
        continue;
      }
      refs.push({ ref, group });
    }

    const parts = [];
    for (const { ref, group } of refs) {
      const notes = groupNotes(group, ref);
      if (!notes.length) continue;
      for (const note of group.notes || []) {
        const attributes = note && note.attributes;
        if (attributes && (Number(attributes.dF0Vbr) > 0 || Number(attributes.tF0VbrStart) > 0)) {
          unportedVibrato++;
        }
      }
      const startBeat = (Number(ref && ref.blickOffset) || 0) / BLICK_PER_BEAT;
      const lastEnd = notes.reduce(
        (max, note) => Math.max(max, note.startBeat + note.durationBeat),
        startBeat,
      );
      const pitchOffsets = toPitchOffsets(group.parameters && group.parameters.pitchDelta, Number(ref && ref.blickOffset) || 0);
      parts.push({
        name: group.name && group.name !== 'main' ? group.name : track.name,
        startBeat,
        durationBeat: Math.max(lastEnd - startBeat, 0),
        notes,
        pitchOffsets,
      });
    }

    if (!parts.length) return;
    tracks.push({
      name: String(track.name || `Track ${index + 1}`),
      color: normalizeColor(track.dispColor),
      parts,
    });
  });

  if (unportedVibrato > 0) {
    warnings.push(t(
      `${unportedVibrato} 个音符带颤音设置，SXSEditor 没有等价字段，未导入（可在编辑器里重画）`,
      `Vibrato settings on ${unportedVibrato} note(s) have no equivalent and were not imported`,
    ));
  }

  return {
    format: 'svp',
    bpm,
    timeSignature,
    tracks,
    warnings,
  };
}

module.exports = { parseSvp };
