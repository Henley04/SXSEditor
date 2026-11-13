'use strict';
/**
 * 把各格式解析出的"中间谱面"落成宿主的工程文档。
 *
 * 三个格式（vsqx / vpr / svp）的差异只在"怎么读"，读出来之后的映射完全一致，
 * 所以这里承担了导入链路里最大的一块复用：拍号/速度、轨道→歌手、分片、
 * 音符清洗、音高曲线采样。各格式的 reader 只需要产出：
 *
 *   { bpm, timeSignature: {numerator, denominator}, tracks: [{
 *       name, color,
 *       parts: [{
 *         name, startBeat, durationBeat,
 *         notes: [{ startBeat, durationBeat, pitch, lyric, vibrato? }],
 *         pitchOffsets: [{ beat, semitones }],   // 绝对拍位置，可为空
 *       }],
 *   }], warnings: [] }
 *
 * 所有时间在 reader 里就已经换算成"拍"（quarter note）。
 */

const TIME_EPSILON = 1e-6;
const MAX_ANCHORS = 2000;
const MIN_ANCHOR_STEP = 1 / 16;
const MAX_PITCH = 127;

// ---------------------------------------------------------------------------
// 呼吸音标记转译
//
// Synthesizer V 与 VOCALOID 用歌词 "br" 表示可听见的呼吸（breath）音符。宿主
// 的推理音素表 phone_set.json 把可发声的吸气/气声记为 <AP>（另见用户指南
// "Type the literal token <AP> for an audible breath" 与 preprocessing.js 对
// <AP> 为清音、无谐波音高的说明）。两者语义一致，但字面不同：直接把 "br"
// 当普通歌词交给宿主，会被按拼读规则转换成辅音串并唱出实词，而不是换气声。
//
// 因此导入时统一成 <AP>，写回外部格式时还原成 "br" —— 双向对称，round-trip
// 不会把标记漂移成别的字面量。<SP>（数字静音）与 <AP> 是不同概念，不在此列。
const HOST_ASPIRATION = '<AP>';
const SOURCE_BREATH = 'br';
const BREATH_RE = /^br$/i;
// 扩展域的命名空间。宿主不解析 ext 内容，只在打开/保存之间原样携带，
// 因此源工程里带不回来的元数据可以放在这里，不必挤进核心模型。
const PLUGIN_ID = 'official-project-import';

function importLyric(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return BREATH_RE.test(text) ? HOST_ASPIRATION : text;
}

function exportLyric(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.toUpperCase() === HOST_ASPIRATION ? SOURCE_BREATH : text;
}

function roundTime(v) {
  return Math.round(v * 480) / 480;
}

function roundPitch(v) {
  return Math.round(v * 1000) / 1000;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** 0xAARRGGBB / "0xFF7C9CFF" / "#7c9cff" → "#7c9cff"；无法识别时返回 undefined。 */
function normalizeColor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    const m = /^(?:0x|#)?([0-9a-fA-F]{6,8})$/.exec(text);
    if (m) return `#${m[1].slice(-6).toLowerCase()}`;
  }
  return undefined;
}

function safeLyric(value, fallback) {
  // 先把源格式的呼吸标记转成宿主吸气 token，再做长度裁剪：
  // "<AP>" 只有 4 个字符，裁剪不会破坏它。
  const text = importLyric(value);
  return (text || fallback).slice(0, 24);
}

/**
 * 音符清洗：排序、裁掉与后一个音符重叠的尾巴（宿主编辑器假定音符不重叠）、
 * 丢掉非法/零长度音符，并分配片段内唯一 id。
 */
function normalizeNotes(rawNotes, partStartBeat) {
  const list = [];
  for (const raw of Array.isArray(rawNotes) ? rawNotes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const pitch = Number(raw.pitch);
    const start = Number(raw.startBeat) - partStartBeat;
    const duration = Number(raw.durationBeat);
    if (!Number.isFinite(pitch) || pitch < 0 || pitch > MAX_PITCH) continue;
    if (!Number.isFinite(start) || start < -TIME_EPSILON) continue;
    if (!Number.isFinite(duration) || duration <= TIME_EPSILON) continue;
    list.push({
      start: Math.max(0, start),
      duration,
      pitch: Math.round(pitch),
      lyric: safeLyric(raw.lyric, 'la'),
      // 音符颤音由 SVP reader 换算好，随音符一起穿过排序与重叠裁剪。
      // 只认普通对象，避免把非法值带进宿主文档（cloneJson 也会再过滤一层）。
      ...(raw.vibrato && typeof raw.vibrato === 'object' && !Array.isArray(raw.vibrato)
        ? { vibrato: raw.vibrato } : {}),
    });
  }
  list.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const note = list[i];
    const next = list[i + 1];
    let duration = note.duration;
    if (next) duration = Math.min(duration, next.start - note.start);
    if (duration <= TIME_EPSILON) continue;
    out.push({
      id: out.length + 1,
      pitch: note.pitch,
      start: roundTime(note.start),
      duration: roundTime(duration),
      lyric: note.lyric,
      ...(note.vibrato ? { vibrato: note.vibrato } : {}),
    });
  }
  return out;
}

/** 音符起点为阶跃函数的"基础音高"查询器（调用方按时间递增访问）。 */
function makeBasePitchLookup(notes) {
  let index = 0;
  return (relativeBeat) => {
    if (!notes.length) return null;
    while (index + 1 < notes.length && notes[index + 1].start <= relativeBeat + TIME_EPSILON) index++;
    const current = notes[index];
    if (relativeBeat < current.start && index === 0) return current.pitch;
    return current.pitch;
  };
}

/** 线性插值；超出两端时取端点值。points 需按 beat 升序。 */
function interpolateOffset(points, beat) {
  if (!points.length) return 0;
  if (beat <= points[0].beat) return points[0].semitones;
  if (beat >= points[points.length - 1].beat) return points[points.length - 1].semitones;
  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (points[mid].beat <= beat) low = mid;
    else high = mid;
  }
  const a = points[low];
  const b = points[high];
  const span = b.beat - a.beat;
  if (span <= TIME_EPSILON) return b.semitones;
  const ratio = (beat - a.beat) / span;
  return a.semitones + (b.semitones - a.semitones) * ratio;
}

/**
 * 采样成宿主可编辑的音高锚点（片段内相对时间 + 绝对 MIDI 音高）。
 *
 * 没有音高偏移数据时返回 null：让宿主用自己的自动音高曲线，比给一条
 * 完全平直的假曲线更接近源工程的听感。
 */
function buildAnchors(part, notes, fragmentStart, fragmentDuration) {
  const offsets = Array.isArray(part.pitchOffsets) ? part.pitchOffsets : [];
  if (!offsets.length || !notes.length) return null;

  const step = Math.max(MIN_ANCHOR_STEP, fragmentDuration / MAX_ANCHORS);
  const basePitchAt = makeBasePitchLookup(notes);
  const anchors = [];
  for (let t = 0; t <= fragmentDuration + TIME_EPSILON; t += step) {
    const base = basePitchAt(t);
    if (base === null) continue;
    const pitch = base + interpolateOffset(offsets, fragmentStart + t);
    anchors.push({ time: roundTime(t), pitch: roundPitch(pitch) });
  }
  if (anchors.length && anchors[anchors.length - 1].time < fragmentDuration - TIME_EPSILON) {
    const base = basePitchAt(fragmentDuration);
    if (base !== null) {
      anchors.push({
        time: roundTime(fragmentDuration),
        pitch: roundPitch(base + interpolateOffset(offsets, fragmentStart + fragmentDuration)),
      });
    }
  }
  return anchors.length >= 2 ? anchors : null;
}

/**
 * 伴奏轨 → 宿主 singer（`type: 'accompaniment'`）。
 *
 * 宿主把伴奏音频以 base64 内嵌在工程里（`embeddedAudioData`），这也是
 * `.sxsproj` 在用户勾选"嵌入伴奏音频"时的落盘形态 —— 宿主装载侧本来就认它，
 * 所以插件只需要把字节摆在这个位置，解码与波形由宿主完成。
 *
 * 音频字节在这里转 base64：插件进程不写盘，宿主 `codec.read` 也只接受文档，
 * 没有第二条能传二进制的通道。体积代价是 4/3，由宿主侧的文档校验单独预算。
 *
 * 源工程里"能打开但宿主模型没有独立字段"的结构（VPR 音频轨的 `type`、
 * `part.wav.name` / `originalName`、`region`；SVP instrumental ref 的
 * `groupID`、`audio` 与轨道标量）收进轨道级 `ext`，随伴奏轨一起穿过编辑器
 * 状态。写回时由 documentToScore 取回，重建音频轨与素材 —— 挂在轨道上而不是
 * 文档级 ext，才能在用户增删、重排伴奏轨之后仍然对得上。
 *
 * @param {{id?:string, trackName?:string, startBeat?:number, mute?:boolean,
 *          volume?:number, audioFileName?:string, duration?:number,
 *          sampleRate?:number, channels?:number, wavBuffer?:Buffer,
 *          vpr?:object, svp?:object}} acc
 * @param {number} index
 * @returns {object}
 */
function buildAccompanimentSinger(acc, index) {
  const name = String(acc.trackName || acc.audioFileName || `Accompaniment ${index + 1}`).slice(0, 60);
  const audioFileName = String(acc.audioFileName || `${name}.wav`).slice(0, 120);
  const wavBase64 = Buffer.isBuffer(acc.wavBuffer) ? acc.wavBuffer.toString('base64') : null;
  const duration = Number.isFinite(acc.duration) ? acc.duration : null;
  const singer = {
    id: acc.id || `import-accompaniment-${index + 1}`,
    type: 'accompaniment',
    trackName: name,
    singerName: name,
    audioFileName,
    audioDuration: duration,
    numberOfChannels: Number.isFinite(acc.channels) ? acc.channels : 1,
    accompanimentStartTime: Math.max(0, roundTime(Number(acc.startBeat) || 0)),
    accompanimentVolume: Number.isFinite(acc.volume) ? clamp(acc.volume, 0, 1) : 1,
    mute: acc.mute === true,
    embeddedAudioData: null,
  };
  if (wavBase64) {
    singer.embeddedAudioData = { wavBase64, audioFileName, audioDuration: duration };
  }
  const source = {};
  if (acc.vpr && typeof acc.vpr === 'object' && !Array.isArray(acc.vpr)) source.vpr = acc.vpr;
  if (acc.svp && typeof acc.svp === 'object' && !Array.isArray(acc.svp)) source.svp = acc.svp;
  if (Object.keys(source).length) {
    singer.ext = { [PLUGIN_ID]: source };
  }
  return singer;
}

/**
 * @param {object} score 见文件头
 * @returns {object} 宿主工程文档
 */
function buildDocument(score) {
  const singers = [];
  const fragments = [];
  let fragmentSeq = 0;

  for (const track of score.tracks) {
    const parts = (track.parts || []).filter((part) => Array.isArray(part.notes) && part.notes.length);
    if (!parts.length) continue;

    const trackIndex = singers.length;
    const trackName = String(track.name || `Track ${trackIndex + 1}`).slice(0, 60);
    const singerId = `import-track-${trackIndex + 1}`;
    singers.push({
      id: singerId,
      type: 'singer',
      trackName,
      singerName: trackName,
      ...(track.color ? { color: track.color } : {}),
    });

    for (const part of parts) {
      const start = Math.max(0, roundTime(Number(part.startBeat) || 0));
      const notes = normalizeNotes(part.notes, Number(part.startBeat) || 0);
      if (!notes.length) continue;

      const lastEnd = notes.reduce((max, n) => Math.max(max, n.start + n.duration), 0);
      const duration = Math.max(roundTime(Number(part.durationBeat) || 0), roundTime(lastEnd), 1);

      fragmentSeq++;
      const fragment = {
        id: `import-fragment-${fragmentSeq}`,
        singerId,
        startTime: start,
        duration,
        name: String(part.name || trackName).slice(0, 60),
        notes,
      };

      const anchors = buildAnchors(part, notes, start, duration);
      if (anchors) {
        fragment.pitchCurve = { enabled: true, anchorPoints: anchors };
        fragment.pitchMode = 'manual';
      }
      fragments.push(fragment);
    }
  }

  const bpm = clamp(Number(score.bpm) || 120, 20, 400);
  const ts = score.timeSignature || {};
  const numerator = clamp(Math.round(Number(ts.numerator) || 4), 1, 32);
  const denominator = clamp(Math.round(Number(ts.denominator) || 4), 2, 32);

  const document = {
    version: '1.3.0',
    project: { bpm: Math.round(bpm * 100) / 100, timeSignature: [numerator, denominator] },
    singers,
    fragments,
  };
  // 伴奏轨接在歌手轨后面：顺序与源工程一致（音频轨通常排在最后），也让
  // 导入后第一条被选中的仍是人声。
  for (const [index, acc] of (Array.isArray(score.accompaniments) ? score.accompaniments : []).entries()) {
    document.singers.push(buildAccompanimentSinger(acc, index));
  }
  // 把源工程元数据放进文档级扩展域。宿主校验会用 cloneJson 完整保留 ext
  // 子树（深度 12、单条 512KB），保存时再交回给 writer 合并，尽量让源
  // 工程在外部软件里仍可用。没有元数据的格式不写这个字段。
  if (score.meta && typeof score.meta === 'object') {
    document.ext = { [PLUGIN_ID]: { sourceMeta: score.meta } };
  }
  return document;
}

/** 把同一拍位置上的重复偏移合并：生成控制器事件时一个位置只允许一个值。 */
function dedupeOffsets(list) {
  const byBeat = new Map();
  for (const item of list) byBeat.set(roundTime(item.beat), item.semitones);
  return [...byBeat.entries()]
    .map(([beat, semitones]) => ({ beat, semitones }))
    .sort((a, b) => a.beat - b.beat);
}

/**
 * 音高曲线锚点 → 相对半音偏移。
 *
 * buildAnchors 写入的是「音符基础音高 + 偏移」的绝对 MIDI 音高，写回外部格式
 * 时需要的却是相对量（VOCALOID 的 PIT、SVP 的 pitchDelta 都是相对基础音高）。
 * 这里按 buildAnchors 完全相同的「当前音符」查找规则反推，避免把音符切换处的
 * 跳音误算成一次弯音。
 */
function anchorsToOffsets(fragment, startBeat) {
  const curve = fragment.pitchCurve;
  if (!curve || !curve.enabled || fragment.pitchMode !== 'manual') return [];
  const anchors = Array.isArray(curve.anchorPoints) ? curve.anchorPoints : [];
  const notes = (Array.isArray(fragment.notes) ? fragment.notes : [])
    .filter((n) => n && typeof n === 'object')
    .slice()
    .sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
  if (!anchors.length || !notes.length) return [];

  let index = 0;
  const baseAt = (time) => {
    while (index + 1 < notes.length
      && (Number(notes[index + 1].start) || 0) <= time + TIME_EPSILON) index++;
    return Math.round(Number(notes[index].pitch) || 60);
  };

  const out = [];
  for (const anchor of anchors) {
    const time = Number(anchor.time);
    const pitch = Number(anchor.pitch);
    if (!Number.isFinite(time) || !Number.isFinite(pitch)) continue;
    out.push({
      beat: roundTime(startBeat + time),
      semitones: roundPitch(pitch - baseAt(time)),
    });
  }
  return dedupeOffsets(out);
}

/**
 * 从文档扩展域取回导入时保存的源工程元数据。
 *
 * 只有 format 与目标格式一致才返回：用户把 .svp 另存为 .vpr 时，SVP 的
 * 音色库/组结构不能套到 VOCALOID 容器上，硬合并只会产出外部软件打不开的
 * 文件。此时返回 null，writer 按全新工程生成，并在告警里说明元数据未沿用。
 * @param {object} document
 * @param {string} format 'svp' | 'vsqx' | 'vpr'
 */
function readSourceMeta(document, format) {
  const bag = document && document.ext && document.ext[PLUGIN_ID];
  const meta = bag && bag.sourceMeta;
  if (!meta || typeof meta !== 'object' || meta.format !== format) return null;
  return meta;
}

/**
 * buildDocument 的逆变换：宿主工程文档 → 各格式 writer 共用的中间谱面。
 *
 * 保存时宿主交给插件的是**校验过的文档**：分片已经按歌手分组、音符时间是分片内
 * 相对拍、音高曲线是绝对 MIDI 音高。这里把它们还原成 reader 产出时的绝对拍谱面，
 * 三个 writer 才能共用同一份映射，不必各自实现一遍「分片怎么拼回轨道」。
 *
 * 没有对应歌手的分片不会丢：单独收进一条 Untitled 轨道，并由调用方显式告警。
 * 伴奏轨同样原样交给 writer（含内嵌音频字节与随轨携带的源结构快照）：
 * 支持音频轨的格式由 writer 写回，不支持的格式由调用方按格式告警，绝不在这里
 * 提前丢掉 —— 那是"能打开却存不回去"的根源。
 */
function documentToScore(document) {
  const singers = Array.isArray(document.singers) ? document.singers : [];
  const fragments = Array.isArray(document.fragments) ? document.fragments : [];
  const singerIds = new Set(singers.map((s) => s && s.id));
  const grouped = new Map();
  const orphans = [];
  for (const f of fragments) {
    if (!f || typeof f !== 'object') continue;
    if (f.singerId && singerIds.has(f.singerId)) {
      if (!grouped.has(f.singerId)) grouped.set(f.singerId, []);
      grouped.get(f.singerId).push(f);
    } else {
      orphans.push(f);
    }
  }

  const buildParts = (list) => list.map((f) => {
    const start = Math.max(0, Number(f.startTime) || 0);
    const notes = (Array.isArray(f.notes) ? f.notes : []).map((n) => ({
      startBeat: roundTime(start + (Number(n && n.start) || 0)),
      durationBeat: roundTime(Math.max(Number(n && n.duration) || 0, 1 / 480)),
      pitch: Math.round(Number(n && n.pitch) || 60),
      // 与导入相反：宿主的吸气 token 写回源工程时还原成 "br"，否则外部软件
      // 会把 "<AP>" 当成普通歌词拼读。
      lyric: exportLyric(n && n.lyric) || 'la',
      // 音符颤音的主参数交给 SVP writer 反向写回 note.attributes；相位与渐出
      // 由 writer 从源工程元数据快照里还原。
      ...(n && n.vibrato && typeof n.vibrato === 'object' && !Array.isArray(n.vibrato)
        ? { vibrato: n.vibrato } : {}),
    }));
    const lastEnd = notes.reduce((max, n) => Math.max(max, n.startBeat + n.durationBeat), start);
    return {
      name: String(f.name || '').slice(0, 60),
      startBeat: start,
      durationBeat: Math.max(roundTime(Number(f.duration) || 0), roundTime(lastEnd - start), 1),
      notes,
      pitchOffsets: anchorsToOffsets(f, start),
    };
  });

  const tracks = [];
  const accompaniments = [];
  for (const s of singers) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'accompaniment') {
      const bag = s.embeddedAudioData && typeof s.embeddedAudioData === 'object'
        ? s.embeddedAudioData : {};
      const wavBase64 = typeof bag.wavBase64 === 'string' && bag.wavBase64 ? bag.wavBase64 : null;
      const ext = (s.ext && s.ext[PLUGIN_ID]) || {};
      const vpr = ext.vpr && typeof ext.vpr === 'object' && !Array.isArray(ext.vpr)
        ? ext.vpr : null;
      const svp = ext.svp && typeof ext.svp === 'object' && !Array.isArray(ext.svp)
        ? ext.svp : null;
      accompaniments.push({
        id: s.id,
        trackName: s.trackName || s.singerName || '',
        audioFileName: s.audioFileName || '',
        audioDuration: Number.isFinite(Number(s.audioDuration)) ? Number(s.audioDuration) : null,
        numberOfChannels: Number.isFinite(Number(s.numberOfChannels)) ? Number(s.numberOfChannels) : 1,
        startTime: Math.max(0, Number(s.accompanimentStartTime) || 0),
        volume: Number.isFinite(Number(s.accompanimentVolume))
          ? clamp(Number(s.accompanimentVolume), 0, 1) : 1,
        mute: s.mute === true,
        wavBase64,
        vpr,
        svp,
      });
      continue;
    }
    tracks.push({
      name: String(s.trackName || s.singerName || s.id || 'Track').slice(0, 60),
      color: s.color,
      parts: buildParts(grouped.get(s.id) || []),
    });
  }
  if (orphans.length) tracks.push({ name: 'Untitled', parts: buildParts(orphans) });

  const project = document.project || {};
  const ts = Array.isArray(project.timeSignature) ? project.timeSignature : [4, 4];
  return {
    bpm: clamp(Number(project.bpm) || 120, 20, 400),
    timeSignature: {
      numerator: clamp(Math.round(Number(ts[0]) || 4), 1, 32),
      denominator: clamp(Math.round(Number(ts[1]) || 4), 2, 32),
    },
    tracks,
    accompaniments,
    orphanCount: orphans.length,
    accompanimentCount: accompaniments.length,
  };
}

module.exports = {
  TICKS_PER_BEAT: 480,
  BLICK_PER_BEAT: 705600000,
  HOST_ASPIRATION,
  SOURCE_BREATH,
  PLUGIN_ID,
  importLyric,
  exportLyric,
  readSourceMeta,
  buildDocument,
  documentToScore,
  normalizeNotes,
  normalizeColor,
  interpolateOffset,
  roundTime,
  clamp,
};
