'use strict';
/**
 * 官方工程导入插件（VOCALOID .vsqx/.vpr、Synthesizer V .svp）。
 *
 * 数据面约定：宿主读文件并把字节交进来，插件只做解析与映射，返回宿主工程文档；
 * 不碰文件系统、不联网。三种格式共用 lib/score.js 的映射管线（轨道→歌手、
 * 分片、音符清洗、音高曲线采样），各自只实现"怎么读"。
 *
 * 只实现 read：这些外部格式无法无损写回（VOCALOID 的歌手/风格、SV 的颤音等
 * 在宿主里没有等价字段），所以它只出现在"打开工程"对话框里，不在"另存为"。
 */

const { buildDocument } = require('./lib/score.js');
const { parseSvp } = require('./lib/svp.js');
const { parseVsqx, parseVpr } = require('./lib/vocaloid.js');

const stats = { read: 0, lastFile: '', lastFormat: '' };

function localeOf(ctx) {
  return String((ctx && ctx.plugin && ctx.plugin.locale) || 'zh-CN').toLowerCase();
}

function msg(ctx, zh, en) {
  return localeOf(ctx).startsWith('zh') ? zh : en;
}

function failure(ctx, message) {
  return Object.assign(new Error(message), { code: 'INVALID_REQUEST' });
}

function summarizeWarnings(ctx, warnings) {
  if (!warnings.length) return '';
  const head = warnings.slice(0, 3).join('\n');
  const rest = warnings.length > 3
    ? msg(ctx, `\n…另有 ${warnings.length - 3} 条告警，详见插件日志`, `\n…and ${warnings.length - 3} more warning(s), see the plugin log`)
    : '';
  return head + rest;
}

function statusText(ctx, name) {
  return msg(ctx, `导入工程：${name}`, `Imported: ${name}`);
}

function makeRead(parse, formatId) {
  return async function read(ctx, { name, bytes }) {
    const translatable = (zh, en) => msg(ctx, zh, en);
    if (!bytes || !bytes.length) {
      throw failure(ctx, msg(ctx, '文件是空的', 'The file is empty'));
    }

    let score;
    try {
      score = parse(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), translatable);
    } catch (err) {
      if (!err || !err.code) {
        if (err) err.code = 'INVALID_REQUEST';
      }
      throw err;
    }
    const document = buildDocument(score);

    if (!document.fragments.length) {
      throw failure(ctx, msg(
        ctx,
        '工程里没有可导入的音符（可能只有音频轨，或音符为空）',
        'The project has no importable notes (audio-only track or empty notes)',
      ));
    }

    stats.read += 1;
    stats.lastFile = name;
    stats.lastFormat = formatId;

    await ctx.ui.status('state', statusText(ctx, name));
    ctx.log.info(
      `导入 ${formatId} ${name}：${document.singers.length} 轨 / ${document.fragments.length} 段 / `
      + `${document.fragments.reduce((sum, f) => sum + f.notes.length, 0)} 个音符，`
      + `${score.warnings.length} 条告警`,
    );

    const warningText = summarizeWarnings(ctx, score.warnings);
    if (warningText) {
      ctx.log.warn(warningText);
      try {
        await ctx.ui.notify(warningText, 'warn');
      } catch (_) {
        // 通知失败不影响导入结果
      }
    }

    return { document, warnings: score.warnings };
  };
}

module.exports = {
  initialize(ctx) {
    ctx.log.info('official-project-import 已就绪：.vsqx / .vpr / .svp 会路由到这里');
  },

  codecs: {
    '.vsqx': { read: makeRead(parseVsqx, 'vsqx') },
    '.vpr': { read: makeRead(parseVpr, 'vpr') },
    '.svp': { read: makeRead(parseSvp, 'svp') },
  },
};
