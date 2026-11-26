'use strict';
/**
 * Synthesizer V 工程（.svp）读写 —— SV1 / SV2 双世代。
 *
 * 结构依据开源实现 UtaFormatix（Apache-2.0）、LibreSVIP 与真实工程样本：
 *  - 文件是 JSON 文本；SV 允许一个文件里用 "\u0000" 串联多份工程，
 *    解析时取 version 最大的那一份（与 UtaFormatix 行为一致）。
 *  - 时间单位是 blick：每拍 705600000（= 480 × 1470000），
 *    与宿主工程的 480 tick/拍正好整除。
 *  - time.meter[].index 是拍号生效的小节序号，time.tempo[].position 是 blick。
 *  - 音符在 group 内：onset/duration 是相对 group 起点（mainRef.blickOffset）的 blick，
 *    pitch 为 MIDI 音高，lyrics 为歌词。
 *  - 附加 group 通过 track.groups[].groupID 到 project.library[].uuid 里取内容。
 *
 * 两个世代的音高/音素参数完全不同（详见 lib/svpSchema.js）：
 *  - SV1：音高曲线是 group.parameters.pitchDelta.points（扁平 [blick, cent, ...]，
 *    cent 相对基础音高）；音素时长在 note.attributes.dur（比例乘数）。
 *  - SV2：音高表达板是 group.pitchControls（分段绝对 MIDI 音高）；音素时序在
 *    note.attributes.phonemes[].leftOffset（秒，相对 onset）。两者导入宿主音高
 *    曲线时都有损，写回时按目标世代重建各自的结构。
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
  hasNonTrivialVibratoEnv,
} = require('./vibrato.js');
const {
  SVP_GENERATION, detectGeneration, resolveWriteTarget, cloneBounded,
  stripForGeneration, parsePitchControls, buildPitchControls,
} = require('./svpSchema.js');

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
  // 世代靠特征字段探测，不看 version 数字；sourceVersion / NUL 容器事实一并记录，
  // 随 sourceMeta 经 document.ext 带到写回端，让「沿用源版本」能原样回写。
  const gen = detectGeneration(raw, bytes);

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
  // SV2 音高表达板被折叠为宿主相对曲线的组数（有损，需告警）。
  let pitchControlGroups = 0;
  const tracks = [];
  // instrumental ref 不是音符组：它没有对应的 library.uuid，若照常走 group 查找
  // 会误报「音符组找不到」。这些轨道的音频由 collectSvpAccompaniments 单独接管，
  // 这里只保留承载人声的轨道进 tracks，保证 collectSvpMeta 的下标与 tracks 对齐。
  const vocalTracksRaw = [];
  // 与 tracks[i].parts 一一对应的源 {ref, group}。collectSvpMeta 按这份对齐表
  // 收结构化快照，绝不自己再去 library 里 find —— 否则「引用找不到 / 空组被跳过」
  // 会让 noteExtras 索引整体错位，正是丢键的根源。
  const trackSources = [];

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
    const partSources = [];
    for (const { ref, group } of refs) {
      const notes = groupNotes(group, ref, bpm, vibratoStats);
      if (!notes.length) continue;
      if (hasNonTrivialVibratoEnv(group.parameters)) vibratoEnvGroups += 1;
      const startBeat = (Number(ref && ref.blickOffset) || 0) / BLICK_PER_BEAT;
      const lastEnd = notes.reduce(
        (max, note) => Math.max(max, note.startBeat + note.durationBeat),
        startBeat,
      );
      // SV2 的 pitchControls 是分段绝对音高表达板，SV1 的 pitchDelta 是相对曲线。
      // 按世代各取各的；SV2 有 pitchControls 时优先它（SV2 里 pitchDelta 通常不再写）。
      let pitchOffsets;
      if (gen.generation === SVP_GENERATION.SV2
        && Array.isArray(group.pitchControls) && group.pitchControls.length) {
        const pc = parsePitchControls(group, ref, notes, BLICK_PER_BEAT, roundTime);
        pitchOffsets = pc.offsets;
        if (pc.lossy) pitchControlGroups += 1;
      } else {
        pitchOffsets = toPitchOffsets(
          group.parameters && group.parameters.pitchDelta,
          Number(ref && ref.blickOffset) || 0,
        );
      }
      parts.push({
        name: group.name && group.name !== 'main' ? group.name : track.name,
        startBeat,
        durationBeat: Math.max(lastEnd - startBeat, 0),
        notes,
        pitchOffsets,
      });
      partSources.push({ ref, group });
    }

    if (!parts.length) return;
    vocalTracksRaw.push(track);
    trackSources.push(partSources);
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
  if (pitchControlGroups > 0) {
    warnings.push(t(
      `${pitchControlGroups} 个音符组的 SV2 音高表达板（pitchControls，分段绝对音高）已折叠为宿主音高曲线，分段结构有损；按源版本写回时重建为 SV2 表达板。`,
      `${pitchControlGroups} SV2 pitch control board(s) (segmented absolute pitch) were folded into the host pitch curve; segment structure is lossy and is rebuilt on write-back to the same version.`,
    ));
  }
  if (gen.generation === SVP_GENERATION.SV2 && gen.markers.length) {
    // 宿主没有等价字段、合成也不消费的 SV2 专有参数，结构化保真回写而不是丢掉。
    warnings.push(t(
      '这是 SV2 工程：vocal modes、retakes、音素时序（leftOffset）、音符/引用 UUID、口型与效果器参数等在 SXSEditor 中没有可编辑等价物，将按原结构保真回写（另存为 SV1 兼容版本时会逐类告警并舍弃）。',
      'This is an SV2 project: vocal modes, retakes, phoneme timing (leftOffset), note/ref UUIDs, mouth opening and effect parameters have no editable equivalent in SXSEditor; they are preserved structurally on write-back (and listed as losses when saving as SV1-compatible).',
    ));
  }
  if (gen.chunkCount > 1) {
    warnings.push(t(
      `文件用 NUL 串联了 ${gen.chunkCount} 份工程，已取 version 最大的一份导入；写回只保留这一份，不伪造历史份。`,
      `The file chains ${gen.chunkCount} projects with NUL; the one with the highest version was imported and only that one is written back (no fabricated history).`,
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
    meta: collectSvpMeta(raw, vocalTracksRaw, trackSources, gen),
  };
}

// ---------------------------------------------------------------------------
// 写入
//
// 与 parseSvp 严格对称：read 认下来的音符、歌词、音高、速度、拍号与分片起点，
// write 必须能原样吐回去。宿主没有等价字段、编辑器也不消费的 SV2 专有参数
// （vocal modes / retakes / phonemes.leftOffset / uuid / mouthOpening / fxParams
// / projectMixer …）不再走「精简标量快照」——那种做法会把嵌套对象与未知键悄悄
// 丢掉，正是「能打开却存不回去」的根源。collectSvpMeta 现在按**原结构**有界
// 深克隆收进 document.ext，encodeSvp 按目标世代合并回生成的工程；只有宿主有
// 语义等价的（音符主字段、颤音主参数、pitchDelta / pitchControls）才用宿主
// 当前值覆盖，其余原样保真。带不回来的在 main.js 里逐条告警，绝不静默丢弃。

/**
 * SV2 升级路径里源工程没有 uuid 时补一个确定性的占位 UUID：十六进制编码
 * 轨道/组/音符下标，保证 read → write → read 稳定；源工程自带 uuid 一律优先
 * 原样保留（见 noteExtras / mainRef / groupRefs / libraryExtras）。
 */
function generatedUuid(parts) {
  const h = parts.map((v) => Math.abs(Math.trunc(Number(v) || 0)).toString(16).padStart(4, '0'));
  return `00000000-0000-4000-8000-${h.join('').slice(0, 12).padEnd(12, '0')}`;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 把源工程完整收成结构化快照（JSON-safe），随 document.ext 往返。
 * 结构契约与 svpSchema.stripForGeneration 严格一致，两边必须同步修改。
 *
 * @param {object} raw pickProject 取出的源工程
 * @param {object[]} tracksRaw 只有人声的轨道（与 score.tracks 对齐）
 * @param {Array<Array<{ref:object,group:object}>>} trackSources 与 parts 一一对应
 * @param {object} gen detectGeneration 的结果
 */
function collectSvpMeta(raw, tracksRaw, trackSources, gen) {
  let truncated = false;
  const take = (value) => {
    const r = cloneBounded(value);
    if (r.truncated) truncated = true;
    return r.value;
  };
  const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const omit = (obj, keys) => {
    const out = {};
    for (const [k, v] of Object.entries(isObject(obj) ? obj : {})) {
      if (keys.includes(k) || DANGEROUS_KEYS.has(k)) continue;
      out[k] = take(v);
    }
    return out;
  };

  // 顶层除容器四键之外的所有键：projectMixer / renderConfig / instantModeEnabled
  // / uuid 等 SV2 顶层字段，以及任何未来新增的未知键，全部按原结构保留。
  const rootExtras = omit(raw, ['version', 'time', 'library', 'tracks']);

  const tracks = (Array.isArray(tracksRaw) ? tracksRaw : []).map((track, ti) => {
    const src = isObject(track) ? track : {};
    const sources = (Array.isArray(trackSources) && Array.isArray(trackSources[ti]))
      ? trackSources[ti] : [];
    return {
      scalars: omit(src, ['mainGroup', 'groups', 'mainRef', 'mixer', 'notes']),
      mixer: isObject(src.mixer) ? take(src.mixer) : {},
      mainRef: take(isObject(src.mainRef) ? src.mainRef : {}),
      // parts[1..] 对应 groups[] 里能找到 library group 的 ref；用对齐表取，
      // 不重新遍历 track.groups（里面可能含被跳过或 instrumental 的 ref）。
      groupRefs: sources.slice(1).map((s) => take(isObject(s && s.ref) ? s.ref : {})),
    };
  });

  const groups = (Array.isArray(trackSources) ? trackSources : []).map((sources) => (
    (Array.isArray(sources) ? sources : []).map(({ group }) => {
      const g = isObject(group) ? group : {};
      const params = isObject(g.parameters) ? g.parameters : {};
      const notes = Array.isArray(g.notes) ? g.notes : [];
      return {
        saved: omit(g, ['notes', 'parameters']),
        parameterExtras: omit(params, ['pitchDelta']),
        // 源 pitchDelta 单独留一份：宿主没有生成音高曲线时原样写回，
        // 不凭空造一条空曲线覆盖源工程的弯音。
        sourcePitchDelta: params.pitchDelta !== undefined ? take(params.pitchDelta) : null,
        // 每个音符除宿主映射的四个主字段外全部保留：uuid / takes /
        // systemAttributes / instantMode / attributes（含 phonemes.leftOffset、
        // dur、颤音相位与渐出）。
        noteExtras: notes.map((note) => omit(note, ['onset', 'duration', 'pitch', 'lyrics'])),
      };
    })
  ));

  // library 里未被任何 track 引用的组：整块（含 notes / parameters）保真，
  // 宿主根本没导入它们，写回时原样吐回去，绝不写成 notes:[] 的空壳。
  const library = Array.isArray(raw.library) ? raw.library : [];
  const libraryExtras = library.map((g) => {
    const group = isObject(g) ? g : {};
    return {
      saved: omit(group, ['notes', 'parameters']),
      parameters: take(isObject(group.parameters) ? group.parameters : {}),
      notes: take(Array.isArray(group.notes) ? group.notes : []),
    };
  });

  return {
    format: 'svp',
    generation: gen.generation,
    sourceVersion: gen.sourceVersion,
    version: gen.sourceVersion, // 兼容旧字段；写回版本统一由 resolveWriteTarget 决定
    trailingNul: gen.trailingNul,
    chunkCount: gen.chunkCount,
    sv2Markers: gen.markers.slice(),
    snapshotTruncated: truncated,
    rootExtras,
    tracks,
    groups,
    libraryExtras,
  };
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
 * @param {object|null} meta collectSvpMeta 的快照（经 document.ext 带回，可能缺失）
 * @param {string} [targetVersion] 'keep' | 'sv2' | 'sv1'（另存为 .svp 时用户选择）
 * @returns {{bytes: Buffer, files: Array<{name:string, bytes:Buffer}>, writeTarget: object}}
 */
function encodeSvp(score, meta, targetVersion) {
  const m = meta && meta.format === 'svp' ? meta : null;
  const target = resolveWriteTarget(m, targetVersion);
  const snap = stripForGeneration(m, target.generation);
  const sv2 = target.generation === SVP_GENERATION.SV2;
  const blick = (beat) => Math.round((Number(beat) || 0) * BLICK_PER_BEAT);
  const cent = (semitones) => Math.round((Number(semitones) || 0) * 100);
  const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

  const library = [];
  const usedGroupUuids = new Set();

  const tracks = (Array.isArray(score.tracks) ? score.tracks : []).map((track, ti) => {
    const tm = snap.tracks[ti] || {};
    const scalars = isObject(tm.scalars) ? tm.scalars : {};
    const groupMeta = Array.isArray(snap.groups[ti]) ? snap.groups[ti] : [];
    const parts = Array.isArray(track.parts) ? track.parts : [];

    const makeGroup = (part, pi) => {
      const startBeat = Number(part.startBeat) || 0;
      const secPerBeat = 60 / (Number(score.bpm) > 0 ? Number(score.bpm) : 120);
      const gm = groupMeta[pi] || {};
      const saved = isObject(gm.saved) ? gm.saved : {};
      const parameterExtras = isObject(gm.parameterExtras) ? gm.parameterExtras : {};
      const noteExtras = Array.isArray(gm.noteExtras) ? gm.noteExtras : [];

      // 宿主映射的四个主字段用当前值覆盖；源 note 的其余键（uuid / takes /
      // systemAttributes / instantMode / attributes 全字段）按原结构铺回来。
      // attributes 以源对象为底稿、再用宿主颤音换算结果覆盖主参数 —— 否则
      // hostToSvpAttributes 只认颤音键，会把 phonemes[].leftOffset / dur /
      // 相位 / 渐出过滤掉，那正是「能打开却存不回去」。
      const notes = (Array.isArray(part.notes) ? part.notes : []).map((n, ni) => {
        const original = isObject(noteExtras[ni]) ? noteExtras[ni] : {};
        const { attributes: originalAttributes, ...rest } = original;
        const durationSec = (Number(n && n.durationBeat) || 0) * secPerBeat;
        const vibrato = hostToSvpAttributes(n && n.vibrato, durationSec, originalAttributes);
        const mergedAttributes = {
          ...(isObject(originalAttributes) ? originalAttributes : {}),
          ...(vibrato || {}),
        };
        const note = {
          ...rest,
          onset: blick((Number(n && n.startBeat) || 0) - startBeat),
          duration: Math.max(1, blick(Number(n && n.durationBeat) || 0)),
          pitch: Math.round(Number(n && n.pitch) || 60),
          lyrics: String((n && n.lyric) || 'la'),
        };
        if (sv2) {
          note.uuid = typeof rest.uuid === 'string' && rest.uuid
            ? rest.uuid : generatedUuid([ti, pi, ni, 1]);
        }
        if (Object.keys(mergedAttributes).length) note.attributes = mergedAttributes;
        return note;
      });

      const points = [];
      for (const offset of (Array.isArray(part.pitchOffsets) ? part.pitchOffsets : [])) {
        points.push(
          blick((Number(offset.beat) || 0) - startBeat),
          cent(Number(offset.semitones) || 0),
        );
      }

      const uuid = typeof saved.uuid === 'string' && saved.uuid
        ? saved.uuid : `import-group-${ti + 1}-${pi + 1}`;
      usedGroupUuids.add(uuid);
      const group = {
        ...saved,
        name: saved.name !== undefined ? saved.name : 'main',
        uuid,
      };
      if (sv2) {
        // SV2 用音高表达板；宿主有曲线数据时按当前编辑结果重建（分段结构有损，
        // 已在导入时告警），否则原样沿用源表达板，绝不静默丢字段。SV2 不写
        // pitchDelta，parameters 只放 mouthOpening / toneShift 等专有曲线。
        const rebuilt = buildPitchControls(part, BLICK_PER_BEAT, roundTime);
        if (rebuilt.length) group.pitchControls = rebuilt;
        else if (saved.pitchControls !== undefined) group.pitchControls = saved.pitchControls;
        group.parameters = { ...parameterExtras };
      } else {
        // SV1 用相对 pitchDelta；宿主没有曲线时沿用源 pitchDelta，不伪造空曲线。
        const parameters = { ...parameterExtras };
        if (points.length) parameters.pitchDelta = { mode: 'cubic', points };
        else if (isObject(gm.sourcePitchDelta)) parameters.pitchDelta = gm.sourcePitchDelta;
        else parameters.pitchDelta = { mode: 'cubic', points: [] };
        group.parameters = parameters;
      }
      group.notes = notes;
      return group;
    };

    const mainPart = parts[0] || { startBeat: 0, notes: [], pitchOffsets: [] };
    const mainGroup = makeGroup(mainPart, 0);
    const mainRef = {
      ...(isObject(tm.mainRef) ? tm.mainRef : {}),
      groupID: mainGroup.uuid,
      blickOffset: blick(Number(mainPart.startBeat) || 0),
      pitchOffset: Number(isObject(tm.mainRef) ? tm.mainRef.pitchOffset : 0) || 0,
    };
    if (sv2 && !mainRef.uuid) mainRef.uuid = generatedUuid([ti, 0, 0, 2]);

    const groupRefs = Array.isArray(tm.groupRefs) ? tm.groupRefs : [];
    const groups = [];
    for (let pi = 1; pi < parts.length; pi++) {
      const group = makeGroup(parts[pi], pi);
      library.push(group);
      const ref = {
        ...(isObject(groupRefs[pi - 1]) ? groupRefs[pi - 1] : {}),
        groupID: group.uuid,
        blickOffset: blick(Number(parts[pi].startBeat) || 0),
        pitchOffset: 0,
        isInstrumental: false,
      };
      if (sv2 && !ref.uuid) ref.uuid = generatedUuid([ti, pi, 0, 3]);
      groups.push(ref);
    }

    return {
      ...scalars,
      name: track.name,
      dispColor: scalars.dispColor !== undefined ? scalars.dispColor : (track.color || '0xFF3366CC'),
      dispOrder: Number.isFinite(Number(scalars.dispOrder)) ? Number(scalars.dispOrder) : ti,
      renderEnabled: scalars.renderEnabled !== false,
      ...(isObject(tm.mixer) && Object.keys(tm.mixer).length ? { mixer: tm.mixer } : {}),
      mainRef,
      mainGroup,
      groups,
    };
  });

  // 源 library 里未被任何重建组引用的条目整块回写：宿主没导入过它们，
  // 写回时连 notes / parameters 一起原样吐回，不写成 notes:[] 的空壳。
  for (const extra of (Array.isArray(snap.libraryExtras) ? snap.libraryExtras : [])) {
    const s = extra && isObject(extra.saved) ? extra.saved : null;
    if (!s) continue;
    if (s.uuid && (usedGroupUuids.has(s.uuid) || library.some((g) => g.uuid === s.uuid))) continue;
    library.push({
      ...s,
      ...(isObject(extra.parameters) ? { parameters: extra.parameters } : {}),
      ...(Array.isArray(extra.notes) ? { notes: extra.notes } : {}),
    });
  }

  // instrumental track 接在人声轨后面；dispOrder 从人声轨条数续起，保证
  // parseSvp 排序后顺序不变。统计借 score 回传给 writer 生成告警（与 VPR 同构）。
  const acc = encodeSvpAccompaniments(score, tracks.length);
  score.svpWriteStats = acc.stats;

  const raw = {
    ...(snap.rootExtras || {}),
    version: target.version,
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
  // NUL 是「一个文件里串联多份工程历史」的分隔机制，不是世代标志。容器按源
  // 保真：源带尾 NUL 才写，绝不主动 append 伪造历史份（也不会把单份工程变成
  // JSON.parse 读不了的内容）。
  let text = JSON.stringify(raw, null, 2);
  if (target.trailingNul) text += '\u0000';
  return {
    bytes: Buffer.from(text, 'utf8'),
    files: acc.files,
    writeTarget: target,
  };
}

module.exports = { parseSvp, encodeSvp, collectSvpMeta };
