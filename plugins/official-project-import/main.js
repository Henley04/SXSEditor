'use strict';
/**
 * 官方工程导入插件（VOCALOID .vsqx/.vpr、Synthesizer V .svp）。
 *
 * 数据面约定：宿主读文件并把字节交进来，或把校验过的工程文档交进来，
 * 插件只做解析与映射，返回宿主工程文档或目标格式字节；不碰文件系统、不联网。
 * 三种格式共用 lib/score.js 的映射管线（轨道→歌手、分片、音符清洗、音高
 * 曲线采样及其逆变换），各自只实现"怎么读"与"怎么写"。
 *
 * 写回是有损的：VOCALOID 的歌手/风格，SV 的组级颤音强度包络、颤音起始相位
 * 与渐出、音素属性，以及变速变拍号等在宿主里没有等价字段。音符颤音的主参数
 * 可以双向转换；能精简保存的元数据经 document.ext 带回并合并进生成的文件，
 * 其余部分逐条告警。需要完整保留编辑结果时应另存为宿主原生格式，插件不会把
 * 有损写回伪装成无损。
 */

const {
  buildDocument, documentToScore, readSourceMeta, PLUGIN_ID,
} = require('./lib/score.js');
const { parseSvp, encodeSvp } = require('./lib/svp.js');
const { parseVsqx, parseVpr, encodeVsqx, encodeVpr } = require('./lib/vocaloid.js');

const stats = { read: 0, write: 0, lastFile: '', lastFormat: '' };

/** 各格式的读取器、写入器与人类可读名称。 */
const FORMATS = {
  '.vsqx': { id: 'vsqx', parse: parseVsqx, encode: encodeVsqx, label: 'VOCALOID3/4' },
  '.vpr': { id: 'vpr', parse: parseVpr, encode: encodeVpr, label: 'VOCALOID5/6' },
  '.svp': { id: 'svp', parse: parseSvp, encode: encodeSvp, label: 'Synthesizer V' },
};

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

function statusText(ctx, verb, name) {
  return msg(ctx, `${verb}工程：${name}`, `${verb === '导入' ? 'Imported' : 'Saved'}: ${name}`);
}

/** 写回必然丢失的字段：按格式列出，作为显式告警返回给宿主。 */
function saveWarnings(ctx, formatId) {
  const w = [];
  w.push(msg(ctx,
    '写回外部工程格式是有损的：源工程的歌手库、音色与风格设置、音素属性，以及颤音的组级强度包络、起始相位与渐出无法在宿主中表达，不会写入；音符颤音的深度、频率、起点与渐入会按宿主设置写回。',
    'Saving back to an external project format is lossy: voice libraries, singer styles, phoneme attributes, and vibrato depth envelopes, start phase and fade-out have no equivalent in the host and are not written. Note vibrato depth, rate, start and fade-in are written back from the host settings.',
  ));
  if (formatId === 'svp') {
    w.push(msg(ctx,
      '变速与拍号变化已折叠为全局 BPM 与单一拍号；音符的呼吸标记按宿主吸气音素写回。',
      'Tempo and meter changes are folded into one global BPM and meter; breath notes are written back as the host aspiration token.',
    ));
  } else {
    w.push(msg(ctx,
      '变速与拍号变化、前导小节、PBS 灵敏度曲线已折叠为全局 BPM、单一拍号与默认灵敏度。',
      'Tempo and meter changes, the pre-measure offset and the pitch-bend sensitivity curve are folded into one global BPM, meter and default sensitivity.',
    ));
  }
  w.push(msg(ctx,
    '需要完整保留编辑结果时，请另存为宿主原生工程格式。',
    'To keep every edit without loss, save as the host native project format instead.',
  ));
  return w;
}

/**
 * 生成 codec.read：解析字节 → 中间谱面 → 宿主工程文档。
 * 解析出的源工程元数据随文档扩展域一并返回，供后续写回合并。
 */
function makeRead(format) {
  return async function read(ctx, { name, bytes }) {
    const translatable = (zh, en) => msg(ctx, zh, en);
    if (!bytes || !bytes.length) {
      throw failure(ctx, msg(ctx, '文件是空的', 'The file is empty'));
    }

    let score;
    try {
      score = format.parse(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), translatable);
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
    stats.lastFormat = format.id;

    await ctx.ui.status('state', statusText(ctx, '导入', name));
    const vibratoNote = Number(score.vibratoImported) > 0
      ? `，其中 ${score.vibratoImported} 个音符带颤音参数`
      : '';
    ctx.log.info(
      `导入 ${format.id} ${name}：${document.singers.length} 轨 / ${document.fragments.length} 段 / `
      + `${document.fragments.reduce((sum, f) => sum + f.notes.length, 0)} 个音符`
      + `${vibratoNote}，${score.warnings.length} 条告警`,
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

/**
 * 生成 codec.write：校验过的宿主文档 → 中间谱面 → 目标格式字节。
 * 元数据只在格式一致时沿用；跨格式另存按全新工程生成并告警。
 */
function makeWrite(format) {
  return async function write(ctx, { name, document }) {
    if (!document || typeof document !== 'object' || !Array.isArray(document.fragments)) {
      throw failure(ctx, msg(ctx, '没有可保存的工程文档', 'No project document to save'));
    }

    let score;
    try {
      score = documentToScore(document);
    } catch (err) {
      throw failure(ctx, msg(ctx, `工程文档无法转换：${err.message}`, `Cannot convert the project document: ${err.message}`));
    }

    const meta = readSourceMeta(document, format.id);
    const warnings = saveWarnings(ctx, format.id);
    if (!meta) {
      warnings.push(msg(ctx,
        '源工程元数据未沿用（目标格式与源文件不同，或该工程不是由本插件导入），将按全新工程生成。',
        'Source project metadata was not reused (target format differs, or the project was not imported by this plugin); a fresh project is generated.',
      ));
    }
    if (score.orphanCount > 0) {
      warnings.push(msg(ctx,
        `${score.orphanCount} 个分片没有对应的歌手轨道，已归入一条 Untitled 轨道。`,
        `${score.orphanCount} fragment(s) have no singer track and were placed on an Untitled track.`,
      ));
    }

    let bytes;
    try {
      bytes = format.encode(score, meta);
    } catch (err) {
      throw failure(ctx, msg(ctx, `生成 ${format.label} 文件失败：${err.message}`, `Failed to build the ${format.label} file: ${err.message}`));
    }
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw failure(ctx, msg(ctx, '编码器没有产出有效字节', 'The encoder produced no valid bytes'));
    }

    stats.write += 1;
    stats.lastFile = name;
    stats.lastFormat = format.id;

    await ctx.ui.status('state', statusText(ctx, '保存', name));
    ctx.log.info(
      `保存 ${format.id} ${name}：${score.tracks.length} 轨 / ${document.fragments.length} 段，`
      + `${warnings.length} 条告警`,
    );
    const warningText = summarizeWarnings(ctx, warnings);
    if (warningText) {
      ctx.log.warn(warningText);
      try {
        await ctx.ui.notify(warningText, 'warn');
      } catch (_) {
        // 通知失败不影响保存结果
      }
    }

    // 宿主把 bytes 原子写盘；插件不接触路径。ext 里只放源工程元数据，
    // 不回写宿主插件标识以外的东西。
    void PLUGIN_ID;
    return { bytes, warnings };
  };
}

const codecs = {};
for (const [ext, format] of Object.entries(FORMATS)) {
  codecs[ext] = { read: makeRead(format), write: makeWrite(format) };
}

module.exports = {
  initialize(ctx) {
    ctx.log.info('official-project-import 已就绪：.vsqx / .vpr / .svp 会路由到这里（打开与保存）');
  },
  codecs,
};
