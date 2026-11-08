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
    meta: collectSvpMeta(raw, tracksRaw),
  };
}

// ---------------------------------------------------------------------------
// 写入
//
// 与 parseSvp 严格对称：read 认下来的音符、歌词、音高、速度、拍号与分片起点，
// write 必须能原样吐回去。源工程里宿主没有等价字段的部分（音色库引用、渲染开关、
// 音符颤音与音素属性）由 collectSvpMeta 收成一份精简快照，经 document.ext 带回，
// 保存时合并进生成的工程；带不回来的在 main.js 里逐条告警，绝不静默丢弃。

/** 只保留体量可控、深度可控的值，避免把整份原始工程塞进扩展域。 */
function smallValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return Number.isFinite(value) || typeof value !== 'number' ? value : null;
  }
  if (Array.isArray(value) && value.length <= 64
    && value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length <= 16 && keys.every((key) => (
      value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key])
    ))) return value;
  }
  return undefined;
}

/** 去掉音符与曲线后剩下的组级元数据（音色库、渲染设置等）。 */
function stripGroup(group) {
  const out = {};
  if (!group || typeof group !== 'object') return out;
  for (const [key, value] of Object.entries(group)) {
    if (key === 'notes' || key === 'parameters') continue;
    const kept = smallValue(value);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

function collectSvpMeta(raw, tracksRaw) {
  const rootExtras = {};
  for (const [key, value] of Object.entries(raw)) {
    if (['version', 'time', 'library', 'tracks'].includes(key)) continue;
    const kept = smallValue(value);
    if (kept !== undefined) rootExtras[key] = kept;
  }

  const library = Array.isArray(raw.library) ? raw.library : [];
  const libraryExtras = library.slice(0, 64).map(stripGroup);
  const tracks = [];
  const groups = [];
  for (const track of tracksRaw) {
    const scalars = {};
    for (const [key, value] of Object.entries(track || {})) {
      if (key === 'mainGroup' || key === 'groups' || key === 'notes') continue;
      const kept = smallValue(value);
      if (kept !== undefined) scalars[key] = kept;
    }
    tracks.push(scalars);

    const own = [];
    if (track && track.mainGroup) own.push(stripGroup(track.mainGroup));
    for (const ref of Array.isArray(track && track.groups) ? track.groups : []) {
      const source = library.find((g) => g && g.uuid === (ref && ref.groupID));
      own.push(source ? stripGroup(source) : {});
    }
    groups.push(own);
  }
  return { format: 'svp', version: Number(raw.version) || 200, rootExtras, libraryExtras, tracks, groups };
}

/**
 * @param {object} score documentToScore 的输出
 * @param {object} meta collectSvpMeta 的快照（经 document.ext 带回，可能缺失）
 * @returns {Buffer} .svp 文件字节
 */
function encodeSvp(score, meta) {
  const m = meta && meta.format === 'svp' ? meta : {};
  const blick = (beat) => Math.round((Number(beat) || 0) * BLICK_PER_BEAT);
  const cent = (semitones) => Math.round((Number(semitones) || 0) * 100);

  const library = [];
  const tracks = (Array.isArray(score.tracks) ? score.tracks : []).map((track, ti) => {
    const trackMeta = (m.tracks || [])[ti] || {};
    const groupMeta = (m.groups || [])[ti] || [];
    const parts = Array.isArray(track.parts) ? track.parts : [];

    const makeGroup = (part, pi) => {
      const startBeat = Number(part.startBeat) || 0;
      const notes = (Array.isArray(part.notes) ? part.notes : []).map((n) => ({
        onset: blick((Number(n.startBeat) || 0) - startBeat),
        duration: Math.max(1, blick(Number(n.durationBeat) || 0)),
        pitch: Math.round(Number(n.pitch) || 60),
        lyrics: String(n.lyric || 'la'),
      }));
      const points = [];
      for (const offset of (Array.isArray(part.pitchOffsets) ? part.pitchOffsets : [])) {
        points.push(
          blick((Number(offset.beat) || 0) - startBeat),
          cent(Number(offset.semitones) || 0),
        );
      }
      const saved = groupMeta[pi] || {};
      return {
        ...saved,
        name: 'main',
        uuid: `import-group-${ti + 1}-${pi + 1}`,
        notes,
        parameters: { pitchDelta: { mode: 'cubic', points } },
      };
    };

    const mainPart = parts[0] || { startBeat: 0, notes: [], pitchOffsets: [] };
    const mainGroup = makeGroup(mainPart, 0);
    const mainRef = {
      ...(trackMeta.mainRef || {}),
      groupID: mainGroup.uuid,
      blickOffset: blick(Number(mainPart.startBeat) || 0),
      pitchOffset: Number((trackMeta.mainRef || {}).pitchOffset) || 0,
    };

    const groups = [];
    for (let pi = 1; pi < parts.length; pi++) {
      const group = makeGroup(parts[pi], pi);
      library.push(group);
      groups.push({
        groupID: group.uuid,
        blickOffset: blick(Number(parts[pi].startBeat) || 0),
        pitchOffset: 0,
        isInstrumental: false,
      });
    }

    return {
      ...trackMeta,
      name: track.name,
      dispColor: trackMeta.dispColor !== undefined ? trackMeta.dispColor : (track.color || '0xFF3366CC'),
      dispOrder: Number.isFinite(Number(trackMeta.dispOrder)) ? Number(trackMeta.dispOrder) : ti,
      renderEnabled: trackMeta.renderEnabled !== false,
      mainRef,
      mainGroup,
      groups,
    };
  });

  // 源工程的音色库条目若没有被新生成的组引用，作为元数据保留在 library 里：
  // 它们不带音符，不会被 parseSvp 当成可导入的音符组，但外部软件仍能读到。
  for (const extra of (m.libraryExtras || [])) {
    if (extra && extra.uuid && !library.some((g) => g.uuid === extra.uuid)) {
      library.push({ ...extra, notes: [], parameters: {} });
    }
  }

  const raw = {
    ...(m.rootExtras || {}),
    version: Number(m.version) || 200,
    time: {
      meter: [{
        index: 0,
        numerator: score.timeSignature.numerator,
        denominator: score.timeSignature.denominator,
      }],
      tempo: [{ position: 0, bpm: score.bpm }],
    },
    library,
    tracks,
  };
  return Buffer.from(JSON.stringify(raw, null, 2), 'utf8');
}

module.exports = { parseSvp, encodeSvp, collectSvpMeta };
