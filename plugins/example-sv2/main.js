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
 * 把 SV2 文本翻成工程文档。
 *
 * 容错取向：坏音符跳过、空轨道保留 —— 用户手上是一个真实文件，"打不开"比
 * "少两个音符"难受得多。真正无法继续的只有一种：文件根本不是 SV2。
 */
function translate(raw, fileName) {
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
      if (Array.isArray(n.phonemes) && n.phonemes.length) {
        const list = n.phonemes
          .filter((p) => typeof p === 'string' && p.length > 0 && p.length <= 24)
          .slice(0, 32);
        if (list.length) note.ext = { [EXT_ID]: { phonemes: list } };
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
  return document;
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
        if (Array.isArray(n.phonemeAdjustments) && n.phonemeAdjustments.length) unportedAdjustments++;
        if (n.vibrato && n.vibrato.enabled) unportedVibrato++;
        notes.push(note);
      }
    }
    return { name, start: roundTime(trackStart), notes };
  };

  const tracks = singers.map((s) => buildTrack(
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
      async read(ctx, { name, bytes }) {
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

        const document = translate(raw, name);
        await ctx.ui.status('state', statusText(name));
        ctx.log.info(`解码 ${name}：${document.singers.length} 轨 / ${document.fragments.length} 段`);
        return { document };
      },

      async write(ctx, { name, document }) {
        const { bytes, warnings } = encode(ctx, document);
        await ctx.ui.status('state', statusText(name));
        ctx.log.info(`编码 ${name}：${bytes.length} 字节，${warnings.length} 条告警`);
        return { bytes, warnings };
      },
    },
  },

  commands: {
    async about(ctx) {
      await ctx.ui.notify('@sv2About', 'info');
      return { ok: true };
    },
  },
};
