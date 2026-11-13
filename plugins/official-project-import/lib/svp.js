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
 *  - 音符颤音参数在 note.attributes（tF0VbrStart / tF0VbrLeft / tF0VbrRight /
 *    dF0Vbr / fF0Vbr / pF0Vbr），缺省值可能来自 mainRef.voice；组级颤音强度
 *    包络在 group.parameters.vibratoEnv。
 *  - 宿主用「音符颤音」表达正弦颤音（深度、频率、起点、时长、渐入），换算见
 *    lib/vibrato.js；组级包络、起始相位与渐出没有对应设置，导入时逐类告警，
 *    写回时尽量沿用原值。
 *  - 伴奏是 **instrumental track**：track 的 mainRef 或 groups[] 里的 ref 带
 *    `isInstrumental: true` 与 `audio: { filename, duration }`，filename 是相对
 *    工程文件所在目录的路径，duration 单位为秒（见 OpenUtau 的 SVP.cs 与真实
 *    instrumental.svp）。SVP 本身是纯 JSON，音频不内嵌 —— 所以写回时把 WAV
 *    作为 codec.write 的旁挂文件放到工程同目录，用相对文件名引用。
 */

const { BLICK_PER_BEAT, normalizeColor, roundTime } = require('./score.js');
const { parseWav } = require('./wav.js');
const {
  svpToHostVibrato, hostToSvpAttributes,
  hasNonTrivialVibratoEnv, collectNoteAttributes,
} = require('./vibrato.js');

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

/**
 * 一个音符组 → 中间谱面音符。
 *
 * SV 只在用户手动改过参数时才写 note.attributes，自动生成（未写 attributes）
 * 的颤音不在这里出现，因此也就不导入 —— 否则会把 SV 的默认自动颤音套到每个
 * 音符上，与宿主自己的音高层叠加成双重颤音。换算结果累加到 stats，供
 * parseSvp 汇总有损告警。
 */
function groupNotes(group, ref, bpm, stats) {
  const blickOffset = Number(ref && ref.blickOffset) || 0;
  const pitchOffset = Number(ref && ref.pitchOffset) || 0;
  const voice = (ref && ref.voice) || (group && group.voice) || null;
  const secPerBeat = 60 / (Number(bpm) > 0 ? Number(bpm) : 120);
  const notes = Array.isArray(group && group.notes) ? group.notes : [];
  return notes.map((note) => {
    const durationBeat = (Number(note && note.duration) || 0) / BLICK_PER_BEAT;
    const { vibrato, lossy } = svpToHostVibrato(
      note && note.attributes, voice, durationBeat * secPerBeat,
    );
    if (vibrato) {
      stats.imported += 1;
      for (const kind of lossy) stats.lossy[kind] = (stats.lossy[kind] || 0) + 1;
    }
    return {
      startBeat: ((Number(note && note.onset) || 0) + blickOffset) / BLICK_PER_BEAT,
      durationBeat,
      pitch: (Number(note && note.pitch) || 0) + pitchOffset,
      lyric: note && note.lyrics,
      ...(vibrato ? { vibrato } : {}),
    };
  });
}

/** SVP 的 dB → 宿主线性增益；缺失或非有限值按 1（0dB）处理。 */
function gainFromDb(value) {
  const db = Number(value);
  if (!Number.isFinite(db)) return 1;
  return Math.max(0, Math.min(4, 10 ** (db / 20)));
}

/** 宿主线性增益 → SVP 的 dB；0 用 -120 近似 -∞。 */
function gainToDb(value) {
  const g = Number(value);
  if (!Number.isFinite(g) || g <= 0) return -120;
  return Math.round(20 * Math.log10(g) * 100) / 100;
}

/** 只保留体量可控的标量/浅对象，用于伴奏轨结构快照。 */
function snapValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 16)) {
      if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
        out[key] = item;
      } else if (item && typeof item === 'object' && !Array.isArray(item)) {
        const inner = {};
        for (const [k, v] of Object.entries(item).slice(0, 8)) {
          if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) inner[k] = v;
        }
        if (Object.keys(inner).length) out[key] = inner;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

/** 包内/旁挂音频文件名：只取 basename，去掉路径分隔符与非法字符。 */
function safeAudioName(raw, index) {
  let name = String(raw || '').split(/[\\/]/).pop() || '';
  name = name.replace(/[^\w.\-()\u4e00-\u9fa5 ]/g, '_').replace(/^\.+/, '').trim();
  if (!name) name = `accompaniment-${index + 1}.wav`;
  if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += '.wav';
  return name.slice(0, 120);
}

/**
 * 收集一条 track 里所有 instrumental ref（`mainRef` 与 `groups[]`）。
 * OpenUtau 的 SVP.cs 遍历的就是这两处，这里保持一致。
 */
function instrumentalRefs(track) {
  const refs = [];
  if (track.mainRef && track.mainRef.isInstrumental === true) refs.push(track.mainRef);
  for (const ref of Array.isArray(track.groups) ? track.groups : []) {
    if (ref && ref.isInstrumental === true) refs.push(ref);
  }
  return refs;
}

/**
 * instrumental ref → 宿主伴奏轨。
 *
 * `audio.filename` 可能是 `../sine.wav` 这类相对路径。宿主只把工程文件**同目录**
 * 的伴生文件送进来（`codec.read` 的 `files`），所以这里按 basename 匹配；
 * 目录穿越的路径既读不到也不接受 —— 插件没有目录遍历能力，越界引用只能跳过。
 * 匹配不到时明确告警，不生成引用不存在素材的空轨。
 */
function collectSvpAccompaniments(tracksRaw, files, warnings, t) {
  const byName = new Map();
  for (const item of Array.isArray(files) ? files : []) {
    if (!item || typeof item.name !== 'string') continue;
    const bytes = item.bytes;
    if (Buffer.isBuffer(bytes) && bytes.length) byName.set(item.name.toLowerCase(), bytes);
    else if (bytes && bytes.length && typeof bytes !== 'string') {
      byName.set(item.name.toLowerCase(), Buffer.from(bytes));
    }
  }

  const out = [];
  let seq = 0;
  for (const track of tracksRaw) {
    if (!track || typeof track !== 'object') continue;
    for (const ref of instrumentalRefs(track)) {
      const audio = ref.audio && typeof ref.audio === 'object' ? ref.audio : {};
      const rawName = String(audio.filename || '').trim();
      if (!rawName) continue;
      const base = rawName.split(/[\\/]/).pop();
      const wav = byName.get(base.toLowerCase());
      const displayName = String(track.name || base.replace(/\.[^.]+$/, '') || `Accompaniment ${seq + 1}`);
      if (!wav) {
        warnings.push(t(
          `伴奏「${displayName}」引用的音频 ${rawName} 不在工程文件同目录，已跳过；请把音频放在 .svp 旁边再打开。`,
          `The backing track "${displayName}" references ${rawName}, which is not next to the .svp file; it was skipped. Place the audio beside the .svp and reopen.`,
        ));
        continue;
      }
      const info = parseWav(wav);
      const beginBlick = Number(ref.blickAbsoluteBegin) > 0
        ? Number(ref.blickAbsoluteBegin) : (Number(ref.blickOffset) || 0);
      const mixer = track.mixer && typeof track.mixer === 'object' ? track.mixer : {};
      seq += 1;
      out.push({
        id: `import-accompaniment-${seq}`,
        trackName: displayName.slice(0, 60),
        startBeat: Math.max(0, beginBlick / BLICK_PER_BEAT),
        mute: mixer.mute === true,
        volume: gainFromDb(mixer.gainDecibel),
        audioFileName: base.slice(0, 120),
        duration: info.ok ? info.duration : (Number.isFinite(Number(audio.duration)) ? Number(audio.duration) : null),
        sampleRate: info.ok ? info.sampleRate : null,
        channels: info.ok ? info.channels : null,
        wavBuffer: wav,
        // 结构快照挂在伴奏轨自己身上，增删/重排之后仍然对得上。
        svp: {
          groupID: typeof ref.groupID === 'string' ? ref.groupID : `instrumental-ref-${seq}`,
          refExtras: snapValue(Object.fromEntries(
            Object.entries(ref).filter(([k]) => !['isInstrumental', 'audio', 'groupID', 'blickOffset', 'blickAbsoluteBegin'].includes(k)),
          )) || {},
          audioExtras: snapValue(Object.fromEntries(
            Object.entries(audio).filter(([k]) => !['filename', 'duration'].includes(k)),
          )) || {},
          track: snapValue(Object.fromEntries(
            Object.entries(track).filter(([k]) => !['mainRef', 'mainGroup', 'groups', 'name', 'dispOrder', 'mixer'].includes(k)),
          )) || {},
          displayName,
        },
      });
    }
  }
  return out;
}

/**
 * @param {Buffer} bytes
 * @param {(zh:string, en:string)=>string} t
 * @param {Array<{name:string, bytes:Buffer}>} [files] 同目录伴生文件（宿主读入）
 */
function parseSvp(bytes, t, files) {
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

  // 颤音换算统计：导入了多少个音符、哪些字段有损、多少组用了组级包络。
  const vibratoStats = { imported: 0, lossy: {} };
  let vibratoEnvGroups = 0;
  const tracks = [];
  // instrumental ref 不是音符组：它没有对应的 library.uuid，若照常走 group 查找
  // 会误报「音符组找不到」。这些轨道的音频由 collectSvpAccompaniments 单独接管，
  // 这里只保留承载人声的轨道进 tracks，保证 collectSvpMeta 的下标与 tracks 对齐。
  const vocalTracksRaw = [];

  tracksRaw.forEach((track, index) => {
    if (!track || typeof track !== 'object') return;

    const refs = [];
    const isInstrumentalRef = (ref) => ref && ref.isInstrumental === true;
    if (track.mainGroup && track.mainRef && !isInstrumentalRef(track.mainRef)) {
      refs.push({ ref: track.mainRef, group: track.mainGroup });
    }
    for (const ref of Array.isArray(track.groups) ? track.groups : []) {
      if (isInstrumentalRef(ref)) continue;
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
      const notes = groupNotes(group, ref, bpm, vibratoStats);
      if (!notes.length) continue;
      if (hasNonTrivialVibratoEnv(group.parameters)) vibratoEnvGroups += 1;
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
    vocalTracksRaw.push(track);
    tracks.push({
      name: String(track.name || `Track ${index + 1}`),
      color: normalizeColor(track.dispColor),
      parts,
    });
  });

  // 颤音换算里「承载不了」的部分逐类告警，绝不静默丢弃。成功导入的主参数不
  // 打扰用户，只在插件日志里记数；这里只报真正有损的项目。
  const structuralLossy = ['phase', 'easeOut']
    .filter((kind) => (vibratoStats.lossy[kind] || 0) > 0);
  if (structuralLossy.length) {
    warnings.push(t(
      '音符颤音的起始相位与渐出过程在 SXSEditor 中没有对应设置，未能导入；写回外部工程时会尽量沿用原值。',
      'Vibrato start phase and fade-out have no equivalent in SXSEditor and were not imported; the original values are kept when writing back where possible.',
    ));
  }
  const clamped = ['depth', 'rate', 'start', 'length', 'fadeIn']
    .reduce((sum, kind) => sum + (vibratoStats.lossy[kind] || 0), 0);
  if (clamped > 0) {
    warnings.push(t(
      `${clamped} 项颤音参数超出 SXSEditor 的可调范围，已取最接近的边界值。`,
      `${clamped} vibrato parameter(s) exceeded the SXSEditor range and were clamped to the nearest bound.`,
    ));
  }
  if (vibratoEnvGroups > 0) {
    warnings.push(t(
      `${vibratoEnvGroups} 个音符组使用了随时间变化的颤音强度包络，SXSEditor 不支持，未导入。`,
      `${vibratoEnvGroups} note group(s) use a time-varying vibrato depth envelope, which SXSEditor does not support; it was not imported.`,
    ));
  }

  return {
    format: 'svp',
    bpm,
    timeSignature,
    tracks,
    accompaniments: collectSvpAccompaniments(tracksRaw, files, warnings, t),
    warnings,
    vibratoImported: vibratoStats.imported,
    meta: collectSvpMeta(raw, vocalTracksRaw),
  };
}

// ---------------------------------------------------------------------------
// 写入
//
// 与 parseSvp 严格对称：read 认下来的音符、歌词、音高、速度、拍号与分片起点，
// write 必须能原样吐回去。源工程里宿主没有等价字段的部分（音色库引用、渲染开关、
// 组级参数与音素属性，以及宿主承载不了的颤音起始相位与渐出）由 collectSvpMeta
// 收成一份精简快照，经 document.ext 带回，保存时合并进生成的工程；音符颤音的
// 主参数由 note.vibrato 反向写回 note.attributes。带不回来的在 main.js 里逐条
// 告警，绝不静默丢弃。

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

    // 每个组额外带一份精简的音符颤音属性快照：宿主承载不了的起始相位与渐出
    // 等字段，写回 .svp 时用它还原，避免在宿主里调一次颤音就抹掉源工程参数。
    const own = [];
    const pushGroup = (source) => {
      const saved = source ? stripGroup(source) : {};
      const noteAttributes = collectNoteAttributes(source);
      if (noteAttributes) saved.noteAttributes = noteAttributes;
      own.push(saved);
    };
    if (track && track.mainGroup) pushGroup(track.mainGroup);
    for (const ref of Array.isArray(track && track.groups) ? track.groups : []) {
      const source = library.find((g) => g && g.uuid === (ref && ref.groupID));
      pushGroup(source);
    }
    groups.push(own);
  }
  return { format: 'svp', version: Number(raw.version) || 200, rootExtras, libraryExtras, tracks, groups };
}

/**
 * 伴奏轨 → SVP instrumental track + 旁挂 WAV。
 *
 * SVP 是纯 JSON，音频不内嵌：`audio.filename` 用相对文件名引用工程同目录的
 * 素材，WAV 字节通过 codec.write 的 `files` 交宿主写到那个目录。文件名安全化
 * 并去重，避免路径穿越与同名覆盖；没有音频数据的伴奏不生成引用不存在素材的
 * 空轨（由 main.js 按 dropped 统计告警）。
 */
function encodeSvpAccompaniments(score, vocalTrackCount) {
  const tracks = [];
  const files = [];
  const used = new Set();
  const stats = { written: 0, dropped: 0, created: 0 };

  const accompaniments = Array.isArray(score.accompaniments) ? score.accompaniments : [];
  accompaniments.forEach((acc, index) => {
    let wav = null;
    if (acc && typeof acc.wavBase64 === 'string' && acc.wavBase64) {
      try {
        wav = Buffer.from(acc.wavBase64, 'base64');
      } catch (_) {
        wav = null;
      }
    }
    if (!wav || !wav.length) {
      stats.dropped += 1;
      return;
    }

    const snap = acc && acc.svp && typeof acc.svp === 'object' && !Array.isArray(acc.svp)
      ? acc.svp : null;
    if (!snap) stats.created += 1;

    let wavName = safeAudioName((snap && snap.audioFileName) || acc.audioFileName, index);
    if (used.has(wavName.toLowerCase())) {
      const ext = /(\.[a-z0-9]{1,5})$/i.exec(wavName);
      const stem = ext ? wavName.slice(0, -ext[0].length) : wavName;
      const suffix = ext ? ext[0] : '.wav';
      let seq = 2;
      while (used.has(`${stem}-${seq}${suffix}`.toLowerCase())) seq += 1;
      wavName = `${stem}-${seq}${suffix}`;
    }
    used.add(wavName.toLowerCase());

    const info = parseWav(wav);
    const duration = Number.isFinite(acc.audioDuration) && acc.audioDuration > 0
      ? acc.audioDuration : (info.ok ? info.duration : 0);
    const beginBlick = Math.round(Math.max(0, Number(acc.startTime) || 0) * BLICK_PER_BEAT);

    const ref = {
      ...(snap && snap.refExtras && typeof snap.refExtras === 'object' ? snap.refExtras : {}),
      groupID: (snap && typeof snap.groupID === 'string' && snap.groupID)
        || `instrumental-ref-${index + 1}`,
      blickOffset: beginBlick,
      blickAbsoluteBegin: beginBlick,
      isInstrumental: true,
      audio: {
        ...(snap && snap.audioExtras && typeof snap.audioExtras === 'object' ? snap.audioExtras : {}),
        filename: wavName,
        duration,
      },
    };
    tracks.push({
      ...(snap && snap.track && typeof snap.track === 'object' ? snap.track : {}),
      name: String(acc.trackName || (snap && snap.displayName) || 'Audio').slice(0, 60),
      dispOrder: vocalTrackCount + index,
      renderEnabled: false,
      mixer: {
        gainDecibel: gainToDb(Number(acc.volume)),
        pan: 0,
        mute: acc.mute === true,
        solo: false,
        display: true,
      },
      groups: [ref],
    });
    files.push({ name: wavName, bytes: wav });
    stats.written += 1;
  });

  return { tracks, files, stats };
}

/**
 * @param {object} score documentToScore 的输出
 * @param {object} meta collectSvpMeta 的快照（经 document.ext 带回，可能缺失）
 * @returns {{bytes: Buffer, files: Array<{name:string, bytes:Buffer}>}} .svp 字节与伴生素材
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
      const secPerBeat = 60 / (Number(score.bpm) > 0 ? Number(score.bpm) : 120);
      // noteAttributes 是导入时保存的私有快照，不能 spread 进生成的组里。
      // 它与音符按序尽力对齐：宿主的音符清洗会排序/裁掉重叠音符，对不上的
      // 索引按「无原值」处理，只写宿主能表达的主参数，不伪造相位或渐出。
      const { noteAttributes, ...saved } = groupMeta[pi] || {};
      const original = Array.isArray(noteAttributes) ? noteAttributes : [];
      const notes = (Array.isArray(part.notes) ? part.notes : []).map((n, ni) => {
        const durationSec = (Number(n && n.durationBeat) || 0) * secPerBeat;
        const attributes = hostToSvpAttributes(n && n.vibrato, durationSec, original[ni]);
        return {
          onset: blick((Number(n && n.startBeat) || 0) - startBeat),
          duration: Math.max(1, blick(Number(n && n.durationBeat) || 0)),
          pitch: Math.round(Number(n && n.pitch) || 60),
          lyrics: String((n && n.lyric) || 'la'),
          ...(attributes ? { attributes } : {}),
        };
      });
      const points = [];
      for (const offset of (Array.isArray(part.pitchOffsets) ? part.pitchOffsets : [])) {
        points.push(
          blick((Number(offset.beat) || 0) - startBeat),
          cent(Number(offset.semitones) || 0),
        );
      }
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

  // instrumental track 接在人声轨后面；dispOrder 从人声轨条数续起，保证
  // parseSvp 排序后顺序不变。统计借 score 回传给 writer 生成告警（与 VPR 同构）。
  const acc = encodeSvpAccompaniments(score, tracks.length);
  score.svpWriteStats = acc.stats;

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
    tracks: [...tracks, ...acc.tracks],
  };
  return {
    bytes: Buffer.from(JSON.stringify(raw, null, 2), 'utf8'),
    files: acc.files,
  };
}

module.exports = { parseSvp, encodeSvp, collectSvpMeta };
