'use strict';
/**
 * SV2 工程格式的示例 codec（跑在独立 utilityProcess 里，CommonJS）。
 *
 * 关键点：**宿主读文件、插件解析内容。**
 * 宿主把用户选中的那个文件的字节送进来（`bytes`），插件不碰文件系统 ——
 * 即使它声明了 `userPicked:read`，那也只是"允许宿主把用户选的文件给你"，
 * 不是"你可以自己遍历磁盘"。
 *
 * 返回的 `document` 必须是宿主的工程文档形状（project / singers / fragments）。
 * 宿主还会再校验一遍（validateProjectDocument）：规模、类型、原型污染都在那里
 * 兜底，插件返回什么脏东西都进不了编辑器状态。
 *
 * SV2 是这里现造的一个极简文本格式，用来演示"外部工程 → 编辑器"：
 *   { "format": "sv2", "bpm": 96,
 *     "tracks": [{ "name": "Lead", "notes": [{ "start": 0, "duration": 1,
 *                                             "pitch": 60, "lyric": "la" }] }] }
 * 拍长以拍为单位，pitch 是 MIDI 音高。
 */

const FORMAT_ID = 'sv2';

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
      notes.push({
        pitch,
        start,
        duration,
        lyric: String(n.lyric || 'la').slice(0, 12),
      });
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

  return {
    // version 交给宿主决定（它会用当前格式版本重写），这里只给个提示值
    version: '1.3.0',
    project: {
      bpm: toNumber(raw.bpm, 120),
      timeSignature: Array.isArray(raw.timeSignature) ? raw.timeSignature : [4, 4],
    },
    singers,
    fragments,
    // 额外字段宿主会忽略；写在这里是为了让示例读起来完整
    source: { format: FORMAT_ID, file: fileName },
  };
}

module.exports = {
  initialize(ctx) {
    ctx.log.info('example-sv2 已就绪：.sv2 文件会路由到这里');
  },

  /**
   * 数据面入口。键是扩展名（小写，带点），宿主按 manifest.fileTypes 路由到它。
   *
   * 只实现 read。若同时实现了 write，宿主在"另存为"时就能把工程写回这个格式；
   * 本示例故意不实现 —— 演示"导入"这一条链路，保存仍落成 .sxsproj。
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
    },
  },

  commands: {
    async about(ctx) {
      await ctx.ui.notify('@sv2About', 'info');
      return { ok: true };
    },
  },
};
