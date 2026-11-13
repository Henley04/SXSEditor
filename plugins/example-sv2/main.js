'use strict';
/**
 * SV2 工程格式的示例 codec（跑在独立 utilityProcess 里，CommonJS）。
 *
 * 关键点：**宿主读文件、插件解析内容、宿主写盘。**
 * 宿主把用户选中的那个文件的字节送进来（`bytes`），插件不碰文件系统 ——
 * 即使它声明了 `userPicked:read`，那也只是"允许宿主把用户选的文件给你"，
 * 不是"你可以自己遍历磁盘"。保存同理：插件返回字节，由宿主原子写落盘。
 *
 * 返回的 `document` 必须是宿主的工程文档形状（project / singers / fragments）。
 * 宿主还会再校验一遍（validateProjectDocument）：规模、类型、原型污染都在那里
 * 兜底，插件返回什么脏东西都进不了编辑器状态。
 *
 * SV2 是这里现造的一个极简文本格式，用来演示"外部工程 ↔ 编辑器"的双向链路：
 *   { "format": "sv2", "bpm": 96, "meta": {...},
 *     "tracks": [{ "name": "Lead", "start": 0,
 *                  "notes": [{ "start": 0, "duration": 1, "pitch": 60,
 *                              "lyric": "la", "phonemes": ["l", "a"] }] }] }
 * 拍长以拍为单位，pitch 是 MIDI 音高。
 *
 * 这个示例刻意演示了三件容易被做错的事：
 *   1. 宿主不认识的数据（`meta`）走 ext 原样保留，保存时写回；
 *   2. 宿主不认识其合法性的数据（音素）声明成只读，界面上置灰但能看见；
 *   3. 表达不了的东西（音素微调、颤音）**显式告警**，而不是静默丢弃。
 */

const FORMAT_ID = 'sv2';

/** ext 的命名空间。用插件 id，让用户能看出"这段数据来自谁"。 */
const EXT_ID = 'example-sv2';

/**
 * 这个插件进程活到现在处理过什么。
 *
 * 只活在内存里：进程一重建就归零，因为它的用途是"让自动化调用方能观察到
 * 插件确实跑了"，不是一个持久统计。真要做持久统计得写进插件自己的数据目录
 * （`fs: pluginData`），那会把示例复杂化到掩盖重点。
 */
const stats = { read: 0, written: 0, lastFile: '' };
const startedAt = Date.now();

/**
 * 给宿主看的声明：这份文档里哪些东西宿主可以呈现。
 *
 * `kind: 'phonemes'` 让宿主知道该按音素切分显示，而不是当成一坨文本；
 * `editable: false` 是因为 SV2 的音素符号表与宿主按歌词推导出来的那一套不同 ——
 * 宿主无从判断 `["tS","a"]` 合不合法，所以不给改，但原样保留并回写。
 */
const EXT_SCHEMA = {
  [EXT_ID]: {
    note: {
      phonemes: { kind: 'phonemes', editable: false, maxLength: 200 },
      // 力度曲线：`t` 是音符内的相对位置（0..1），`v` 是插件的量纲（这里 0..1）。
      // 宿主不知道它是"力度"还是别的什么，只按声明画一条只读折线 —— 这正是
      // 曲线字段存在的意义：让数据可见，但不假装宿主懂它。
      dynamics: {
        kind: 'curve',
        label: '力度曲线',
        curve: { interp: 'smooth', clamp: [0, 1] },
      },
    },
  },
};

/**
 * 状态栏文案。
 *
 * 直接用纯文本而不是 `@key`：`@key` 只支持字典里的整键替换，没有插值，
 * 而这里要显示文件名。状态栏本来就是给人扫一眼的，不需要翻译。
 */
function statusText(name) {
  return `SV2 · ${name}`;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 时间统一到 1/480 拍，避免 0.1+0.2 这类浮点尾数堆积到文件里。 */
function roundTime(v) {
  return Math.round(v * 480) / 480;
}

/**
 * 面向用户的错误文案。
 *
 * 插件产生的错误会原样出现在宿主的提示框里，所以文案必须跟着界面语言走 ——
 * 宿主只负责翻译自己的那半句（"插件无法打开该文件："），后面这半句是插件的责任。
 * `ctx.plugin.locale` 是宿主启动时给的语言标签。
 */
function msg(ctx, zh, en) {
  const locale = (ctx && ctx.plugin && ctx.plugin.locale) || 'zh-CN';
  return String(locale).toLowerCase().startsWith('zh') ? zh : en;
}

/**
 * 读 WAV 头，拿时长/声道/采样率。
 *
 * 不是完整的 WAV 解析器：只需要够填伴奏轨的显示字段。任何一步不对就返回
 * null，调用方退回文件里声明的 duration —— 头坏了不该让整条伴奏进不来。
 * @param {Buffer} bytes
 * @returns {{duration:number, sampleRate:number, channels:number}|null}
 */
function wavInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44) return null;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataSize = 0;
  while (pos + 8 <= bytes.length) {
    const id = bytes.toString('latin1', pos, pos + 4);
    const size = bytes.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // 流式 WAV 常把 data 长度写成 0 或 0xFFFFFFFF，此时按剩余字节算
      dataSize = size === 0 || size === 0xFFFFFFFF ? bytes.length - body : Math.min(size, bytes.length - body);
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!sampleRate || !channels || !bits) return null;
  return {
    duration: dataSize / (sampleRate * channels * (bits / 8)),
    sampleRate,
    channels,
  };
}

/** 文件名只留 basename，去掉路径分隔符与 `..`，避免引用逃出工程目录。 */
function safeAudioName(raw, fallback) {
  const base = String(raw || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  if (!cleaned || cleaned.includes('..')) return fallback;
  return cleaned.slice(0, 120);
}

/**
 * 把 SV2 文本翻成工程文档。
 *
 * 容错取向：坏音符跳过、空轨道保留 —— 用户手上是一个真实文件，"打不开"比
 * "少两个音符"难受得多。真正无法继续的只有一种：文件根本不是 SV2。
 *
 * `files` 是宿主从工程同目录读到的伴生音频（按插件 manifest 的
 * `companionExts` 声明才扫描）。伴奏两种承载方式：
 *   embedded —— WAV 以 base64 存在 `audio.data`，单文件自包含；
 *   file     —— `audio.name` 指向同目录 wav，工程文件本身很小。
 */
function translate(ctx, raw, fileName, files) {
  const warnings = [];
  const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  const singers = [];
  const fragments = [];

  tracks.forEach((track, index) => {
    if (!track || typeof track !== 'object') return;
    const singerId = `sv2-${index + 1}`;
    const trackName = String(track.name || `SV2 ${index + 1}`).slice(0, 60);
    singers.push({
      id: singerId,
      type: 'singer',
      trackName,
      singerName: trackName,
      color: track.color || undefined,
    });

    const notes = [];
    let end = 0;
    for (const n of Array.isArray(track.notes) ? track.notes : []) {
      if (!n || typeof n !== 'object') continue;
      const pitch = Math.round(toNumber(n.pitch, NaN));
      const start = toNumber(n.start, 0);
      const duration = toNumber(n.duration, 1);
      if (!Number.isFinite(pitch) || pitch < 0 || pitch > 127) continue;
      if (start < 0 || duration <= 0) continue;

      const note = {
        pitch,
        start,
        duration,
        lyric: String(n.lyric || 'la').slice(0, 12),
      };
      // 音素：宿主不认识的符号表，进 ext。它不会参与宿主的歌词→音素推导，
      // 所以用户改歌词时这里也不会被静默覆盖。
      if (Array.isArray(n.dynamics) && n.dynamics.length >= 2) {
        // 只收 [[t, v], ...] 形状；t 超出 0..1 的由宿主丢弃（它比这里更该管这件事）
        note.ext = note.ext || { [EXT_ID]: {} };
        note.ext[EXT_ID].dynamics = n.dynamics
          .filter((pt) => Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
          .slice(0, 512)
          .map((pt) => [pt[0], pt[1]]);
      }
      if (Array.isArray(n.phonemes) && n.phonemes.length) {
        const list = n.phonemes
          .filter((p) => typeof p === 'string' && p.length > 0 && p.length <= 24)
          .slice(0, 32);
        if (list.length) {
          // 合并而不是覆盖：同一个 note 上可能已经有 dynamics，覆盖会让它静默消失
          note.ext = note.ext || { [EXT_ID]: {} };
          note.ext[EXT_ID].phonemes = list;
        }
      }
      notes.push(note);
      end = Math.max(end, start + duration);
    }

    fragments.push({
      id: `sv2-fragment-${index + 1}`,
      singerId,
      startTime: toNumber(track.start, 0),
      // 不给 duration 时按最后一个音符的结束时间算，至少一拍 —— 空轨道也要看得见
      duration: Math.max(1, end - toNumber(track.start, 0)),
      name: trackName,
      notes,
    });
  });

  const document = {
    // version 交给宿主决定（它会用当前格式版本重写），这里只给个提示值
    version: '1.3.0',
    project: {
      bpm: toNumber(raw.bpm, 120),
      timeSignature: Array.isArray(raw.timeSignature) ? raw.timeSignature : [4, 4],
    },
    singers,
    fragments,
    extSchema: EXT_SCHEMA,
  };

  // `meta`（作者、注释、自定义标签……）宿主没有任何字段能装下它。
  // 不保留的话，"打开再保存"就会永久删掉用户的元数据，而且完全没有痕迹。
  if (raw.meta && typeof raw.meta === 'object') {
    document.ext = { [EXT_ID]: { meta: raw.meta } };
  }

  // 写在这里是为了让示例读起来完整；宿主不认识这个字段，也不会读它
  document.source = { format: FORMAT_ID, file: fileName };

  // 伴奏：宿主里是 `type: 'accompaniment'` 的"歌手"，没有音符分片。
  // 与 VPR 不同，SV2 是自造格式，音频可以内嵌也可以旁挂，读的时候两种都认。
  const available = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    const key = String((f && f.name) || '').split(/[\\/]/).pop().toLowerCase();
    if (key) available.set(key, f.bytes);
  }
  const accompRaw = Array.isArray(raw.accompaniments) ? raw.accompaniments : [];
  accompRaw.slice(0, 64).forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const audio = item.audio && typeof item.audio === 'object' ? item.audio : {};
    const mode = audio.mode === 'file' ? 'file' : 'embedded';
    const name = safeAudioName(audio.name || `accompaniment-${index + 1}.wav`, `accompaniment-${index + 1}.wav`);
    let bytes = null;
    if (mode === 'embedded') {
      const data = typeof audio.data === 'string' ? audio.data : '';
      if (data) {
        try {
          bytes = Buffer.from(data, 'base64');
        } catch (_) {
          bytes = null;
        }
      }
      if (!bytes || !bytes.length) {
        warnings.push(msg(ctx, `伴奏「${name}」没有可解码的内嵌音频，已跳过`, `Accompaniment "${name}" has no decodable embedded audio and was skipped`));
        return;
      }
    } else {
      bytes = available.get(name.toLowerCase()) || null;
      if (!bytes) {
        warnings.push(msg(ctx, `伴奏「${name}」引用的音频不在工程同目录，已跳过`, `Accompaniment "${name}" references a file that is not next to the .sv2, skipped`));
        return;
      }
    }
    const info = wavInfo(bytes);
    const declared = toNumber(audio.duration, NaN);
    const duration = info ? info.duration : (Number.isFinite(declared) && declared > 0 ? declared : null);
    const singer = {
      id: `sv2-accompaniment-${index + 1}`,
      type: 'accompaniment',
      trackName: name.slice(0, 60),
      singerName: name.slice(0, 60),
      audioFileName: name,
      audioDuration: duration,
      numberOfChannels: info ? info.channels : 1,
      accompanimentStartTime: Math.max(0, roundTime(toNumber(item.start, 0))),
      accompanimentVolume: Math.min(1, Math.max(0, toNumber(item.volume, 1))),
      mute: item.mute === true,
      embeddedAudioData: {
        wavBase64: bytes.toString('base64'),
        audioFileName: name,
        audioDuration: duration,
      },
      // 写回沿用源文件的承载方式：内嵌的保持内嵌，旁挂的保持旁挂。
      // 用户新建的伴奏没有这个标记，默认内嵌（单文件自包含，最不容易丢）。
      ext: { [EXT_ID]: { audioMode: mode } },
    };
    singers.push(singer);
  });

  return { document, warnings };
}

/**
 * 把工程文档写回 SV2。
 *
 * 与 translate 严格对称：read 认下来的东西，write 必须能原样吐出去，
 * 否则 round-trip 就是单向的，用户第二次保存才会发现文件已经不一样了。
 *
 * @returns {{bytes: Buffer, warnings: string[]}}
 */
function encode(ctx, document) {
  const singers = Array.isArray(document.singers) ? document.singers : [];
  const fragments = Array.isArray(document.fragments) ? document.fragments : [];
  const ext = (document.ext && document.ext[EXT_ID]) || {};
  const warnings = [];

  let unportedAdjustments = 0;
  let unportedVibrato = 0;

  const singerIds = new Set(singers.map((s) => s.id));
  const grouped = new Map();
  const orphans = [];
  for (const f of fragments) {
    if (f && f.singerId && singerIds.has(f.singerId)) {
      if (!grouped.has(f.singerId)) grouped.set(f.singerId, []);
      grouped.get(f.singerId).push(f);
    } else {
      orphans.push(f);
    }
  }

  const buildTrack = (name, ownFragments) => {
    // 一个歌手在宿主里可以有多个分片；SV2 的 track 是"一条轨 + 绝对开始的音符"，
    // 所以先把分片按时间摊平，取最早的分片作为 track.start，其余音符加偏移。
    const starts = ownFragments.map((f) => toNumber(f.startTime, 0));
    const trackStart = starts.length ? Math.min(...starts) : 0;
    const notes = [];
    for (let i = 0; i < ownFragments.length; i++) {
      const f = ownFragments[i];
      const offset = toNumber(f.startTime, 0) - trackStart;
      for (const n of Array.isArray(f.notes) ? f.notes : []) {
        if (!n || typeof n !== 'object') continue;
        const note = {
          start: roundTime(offset + toNumber(n.start, 0)),
          duration: roundTime(toNumber(n.duration, 1)),
          pitch: Math.round(toNumber(n.pitch, 60)),
          lyric: String(n.lyric || 'la').slice(0, 12),
        };
        const phonemes = n.ext && n.ext[EXT_ID] && n.ext[EXT_ID].phonemes;
        if (Array.isArray(phonemes) && phonemes.length) {
          note.phonemes = phonemes.filter((p) => typeof p === 'string').slice(0, 32);
        }
        const dynamics = n.ext && n.ext[EXT_ID] && n.ext[EXT_ID].dynamics;
        if (Array.isArray(dynamics) && dynamics.length >= 2) {
          note.dynamics = dynamics
            .filter((pt) => Array.isArray(pt) && pt.length === 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
            .map((pt) => [Number(pt[0]), Number(pt[1])]);
          if (!note.dynamics.length) delete note.dynamics;
        }
        if (Array.isArray(n.phonemeAdjustments) && n.phonemeAdjustments.length) unportedAdjustments++;
        if (n.vibrato && n.vibrato.enabled) unportedVibrato++;
        notes.push(note);
      }
    }
    return { name, start: roundTime(trackStart), notes };
  };

  // 伴奏在宿主里也是 singer，但它没有人声轨道：不能进 tracks，否则
  // 外部软件会看到一条永远没有音符的空轨。
  const tracks = singers.filter((s) => !s || s.type !== 'accompaniment').map((s) => buildTrack(
    String(s.trackName || s.singerName || s.id).slice(0, 60),
    grouped.get(s.id) || [],
  ));
  if (orphans.length) {
    tracks.push(buildTrack('Untitled', orphans));
    warnings.push(msg(
      ctx,
      `${orphans.length} 个分片没有对应轨道，已写进 "Untitled"`,
      `${orphans.length} fragment(s) had no track and were written to "Untitled"`,
    ));
  }

  const raw = {
    format: FORMAT_ID,
    bpm: toNumber(document.project && document.project.bpm, 120),
    timeSignature: (document.project && document.project.timeSignature) || [4, 4],
  };
  if (ext.meta && typeof ext.meta === 'object') raw.meta = ext.meta;
  raw.tracks = tracks;

  // 伴奏写回：有没有音频字节由文档说了算，不看 singer 存不存在 —— 一条
  // "看得见但没音频"的伴奏轨写出去只会变成引用不存在文件的空引用。
  const accompOut = [];
  const files = [];
  const usedNames = new Set();
  let skippedAccomp = 0;
  for (const s of singers) {
    if (!s || s.type !== 'accompaniment') continue;
    const b64 = s.embeddedAudioData && s.embeddedAudioData.wavBase64;
    const bytes = typeof b64 === 'string' && b64 ? Buffer.from(b64, 'base64') : null;
    if (!bytes || !bytes.length) {
      skippedAccomp++;
      continue;
    }
    const mode = s.ext && s.ext[EXT_ID] && s.ext[EXT_ID].audioMode === 'file' ? 'file' : 'embedded';
    const preferred = safeAudioName(
      s.audioFileName || s.trackName || `accompaniment-${accompOut.length + 1}.wav`,
      `accompaniment-${accompOut.length + 1}.wav`,
    );
    // 多条伴奏可能引用同名文件：改名而不是覆盖，覆盖会让前一条的音频静默消失
    let fname = preferred;
    const dot = preferred.lastIndexOf('.');
    const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
    const extPart = dot > 0 ? preferred.slice(dot) : '';
    for (let n = 2; usedNames.has(fname.toLowerCase()); n++) fname = `${stem}-${n}${extPart}`;
    usedNames.add(fname.toLowerCase());

    const info = wavInfo(bytes);
    const declared = toNumber(s.audioDuration, NaN);
    const duration = info ? info.duration : (Number.isFinite(declared) && declared > 0 ? declared : null);
    const audio = { mode, name: fname };
    if (duration !== null) audio.duration = Number(duration.toFixed(6));
    if (mode === 'file') files.push({ name: fname, bytes });
    else audio.data = bytes.toString('base64');

    accompOut.push({
      name: String(s.trackName || s.singerName || fname).slice(0, 60),
      start: roundTime(toNumber(s.accompanimentStartTime, 0)),
      volume: Math.min(1, Math.max(0, toNumber(s.accompanimentVolume, 1))),
      mute: s.mute === true,
      audio,
    });
  }
  if (accompOut.length) raw.accompaniments = accompOut;
  if (skippedAccomp > 0) {
    warnings.push(msg(
      ctx,
      `${skippedAccomp} 条伴奏没有可写入的音频数据，未写进 SV2（重新载入伴奏音频，或另存为 .sxsproj）`,
      `${skippedAccomp} accompaniment track(s) had no writable audio and were not written to SV2 (reload the audio, or save as .sxsproj)`,
    ));
  }

  // 写不进去的东西必须让用户知道。静默丢弃会在下次打开时表现为"我的调整没了"，
  // 而用户已经保存过一次，连回退的线索都没有。
  if (unportedAdjustments > 0) {
    warnings.push(msg(
      ctx,
      `${unportedAdjustments} 个音符的音素微调未写入（SV2 格式不支持）`,
      `Phoneme adjustments on ${unportedAdjustments} note(s) were not written (unsupported by SV2)`,
    ));
  }
  if (unportedVibrato > 0) {
    warnings.push(msg(
      ctx,
      `${unportedVibrato} 个音符的颤音未写入（SV2 格式不支持）`,
      `Vibrato on ${unportedVibrato} note(s) was not written (unsupported by SV2)`,
    ));
  }

  return {
    bytes: Buffer.from(JSON.stringify(raw, null, 2), 'utf8'),
    warnings,
    files,
  };
}

module.exports = {
  initialize(ctx) {
    ctx.log.info('example-sv2 已就绪：.sv2 文件会路由到这里');
  },

  /**
   * 数据面入口。键是扩展名（小写，带点），宿主按 manifest.fileTypes 路由到它。
   *
   * read 与 write 成对实现，宿主才允许"另存为"选这个格式；只实现 read 时
   * 它只会出现在"打开"对话框里。
   */
  codecs: {
    '.sv2': {
      async read(ctx, { name, bytes, files }) {
        let text;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (_) {
          throw Object.assign(
            new Error(msg(ctx, 'SV2 文件不是合法的 UTF-8 文本', 'The SV2 file is not valid UTF-8 text')),
            { code: 'INVALID_REQUEST' },
          );
        }
        let raw;
        try {
          raw = JSON.parse(text);
        } catch (err) {
          throw Object.assign(
            new Error(msg(ctx, `SV2 文件不是合法 JSON：${err.message}`, `The SV2 file is not valid JSON: ${err.message}`)),
            { code: 'INVALID_REQUEST' },
          );
        }
        if (!raw || typeof raw !== 'object' || raw.format !== FORMAT_ID) {
          throw Object.assign(
            new Error(msg(
              ctx,
              '不是 SV2 工程（缺少 "format": "sv2"）',
              'Not an SV2 project (missing "format": "sv2")',
            )),
            { code: 'INVALID_REQUEST' },
          );
        }

        const { document, warnings } = translate(ctx, raw, name, files);
        stats.read += 1;
        stats.lastFile = name;
        await ctx.ui.status('state', statusText(name));
        ctx.log.info(`解码 ${name}：${document.singers.length} 轨 / ${document.fragments.length} 段`);
        return { document, warnings };
      },

      async write(ctx, { name, document }) {
        const { bytes, warnings, files } = encode(ctx, document);
        stats.written += 1;
        stats.lastFile = name;
        await ctx.ui.status('state', statusText(name));
        ctx.log.info(`编码 ${name}：${bytes.length} 字节，${files.length} 个旁挂音频，${warnings.length} 条告警`);
        return files.length ? { bytes, warnings, files } : { bytes, warnings };
      },
    },
  },

  /**
   * 成品导出器（M4 第 4 段）。
   *
   * 入参是**成品采样**（交错 Float32、已经按用户在导出对话框里选的采样率重采样过），
   * 出参是字节。宿主负责写盘与原子替换，插件不碰文件系统。
   *
   * 这里刻意选裸 PCM 而不是 WAV/FLAC：一是示例不该与宿主内置的 WAV 编码器争夺
   * 同一个扩展名，二是它能顺带说明"导出器要对哪些东西负责"—— 裸 PCM 里没有
   * 采样率和通道数，回放的人必须自己知道，所以这个事实只能写进 warnings。
   */
  exporters: {
    pcm16: {
      async export(ctx, { name, audio }) {
        const { interleaved, channels, sampleRate } = audio;
        const out = new Uint8Array(interleaved.length * 2);
        const view = new DataView(out.buffer);
        for (let i = 0; i < interleaved.length; i++) {
          // 浮点 → int16：先夹再乘，直接乘会让 1.2 之类的越界值回绕成负峰
          const v = Math.max(-1, Math.min(1, interleaved[i]));
          view.setInt16(i * 2, Math.round(v * 32767), true);
        }
        return {
          bytes: out,
          warnings: [
            msg(
              ctx,
              `裸 PCM 不含格式信息：回放时需指定 ${sampleRate}Hz / ${channels} 声道 / 16 位小端`,
              `Raw PCM carries no format info: specify ${sampleRate}Hz / ${channels} ch / 16-bit LE when playing`,
            ),
          ],
        };
      },
    },
  },

  commands: {
    async about(ctx) {
      await ctx.ui.notify('@sv2About', 'info');
      return { ok: true };
    },

    /**
     * 自动化方法的示例实现（`contributes.automation.methods: ['stats']`）。
     *
     * 它演示三件与"能被 agent 调用"直接相关的事：
     *   1. 参数是插件自己定的（这里的 `includeLast`），宿主不校验也不改写；
     *   2. 返回值必须是可以 JSON 化的普通对象 —— 它要穿过 IPC 到主进程，
     *      再变成 MCP 的 result，带函数/循环引用的东西会在这里就炸；
     *   3. 不需要任何窗口。这个方法在应用最小化、主窗口都没有焦点时也能跑，
     *      这就是"暴露给自动化"与"给菜单用"的区别。
     */
    async stats(ctx, args) {
      const includeLast = !args || args.includeLast !== false;
      ctx.log.info(`自动化调用 stats（includeLast=${includeLast}）`);
      return {
        read: stats.read,
        written: stats.written,
        lastFile: includeLast ? stats.lastFile : null,
        uptimeMs: Date.now() - startedAt,
      };
    },
  },
};
