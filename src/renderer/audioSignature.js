/**
 * 播放缓存签名 —— 判断「手上这份 currentAudioData 还能不能播」。
 *
 * 为什么需要它：主窗口只有 `state.currentAudioData` 一个字段，按下 Play 时
 * 只要它非空就 `startAudioPlayback()` 直接续播，完全不校验这份音频是用什么
 * 输入算出来的。于是任何「改了输入但没有重新合成」的操作，都会让用户听到
 * 改动之前的旧声音：
 *   · 把分片拖到另一个歌手轨道 —— 旧歌手的音色继续响；
 *   · 改了音符 / 歌词 / 音高曲线 —— 声音不变；
 *   · 换了歌手的音色文件 —— 同上。
 * 主进程的合成缓存键（audioSegmentation.computeSynthCacheKey）本来就带
 * singerId 等字段，命中与否的判断是对的；问题在于渲染层根本没有走到那一步。
 *
 * 设计取舍：
 *   · **放在哈希对比上，而不是逐个改动点调 invalidate**。改动点遍布拖拽、
 *     撤销/重做、分片编辑器 IPC、插件后端切换、设置面板…… 漏一处就是一个
 *     静默 bug。签名是"输入的函数"，新增编辑路径不需要任何人记得登记。
 *   · **只覆盖真正影响人声音频的输入**。伴奏是独立 source + 独立增益
 *     （见 audioPlayback 的 _buildPlaybackChannels(vocalMono, bpm, false)），
 *     改伴奏音量/起始位置不影响人声 buffer，因此不进签名 —— 否则导一次伴奏
 *     就要把整首重推一遍。
 *   · **纯函数**：不读全局 state、不碰 DOM，便于单测锁住字段覆盖。
 *
 * 字段覆盖对照（任一变化都必须改变签名）：
 *   分片：id / singerId / startTime / duration / 音符内容 / 音高模式 /
 *         音高曲线 F0 / 频谱后处理载荷
 *   歌手：后端（内置 or 插件 + 参数）/ 参考音频字节 / 参考 MIDI / 参考 F0
 *   全局：bpm / 自动变调 / 扩散步数与引导强度 / 分块参数 / CFG 调度 /
 *         动态阈值
 */

import { hashNumberArray, hashString } from '../shared/hashSignature.js';
import { computeActiveClippedNotes } from '../shared/activeNotes.js';
import { buildMelPostprocessPayload, hasF0PostprocessEffect } from '../shared/postprocessCurves.js';
import { fragmentPitchMode } from '../shared/pitchControl.js';
import { buildFragmentPitchCurveF0 } from './f0Utils.js';
import { SAMPLE_RATE, SVS_HOP_SIZE } from './constants.js';

/** JSON 序列化兜底：后端参数是插件自定义域，可能有循环引用。 */
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return '[unserializable]';
  }
}

/**
 * 参考音频字节的哈希。输入可能是 ArrayBuffer、TypedArray 或 null。
 * 与主进程一致地走 FNV 采样（>2000 元素按步长抽样 + 补尾部），
 * 因此换一份同长度、同格式的参考音频不会再被判成"没变"。
 */
function hashBuffer(buf) {
  if (!buf) return 0;
  if (buf instanceof ArrayBuffer) return hashNumberArray(new Uint8Array(buf));
  if (ArrayBuffer.isView(buf)) return hashNumberArray(buf);
  if (Array.isArray(buf)) return hashNumberArray(buf);
  return 0;
}

/**
 * 音符序列哈希 —— 覆盖所有会改变合成结果的字段。
 *
 * 逐个 note 拼串后滚动哈希：字段之间用 `|` 分隔，避免"歌词里带数字"这类
 * 歧义拼串把两个不同序列折成同一个串。
 */
export function hashNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return 0;
  let h = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (!n) continue;
    let s = `${n.lyric || ''}|${n.pitch}|${n.start}|${n.duration}`
      + `|${n.isSlur ? 1 : 0}|${n.isContinuation ? 1 : 0}|t${n.noteType || 0}`;
    // 音素时长/偏移与音量点直接改写 mel 的帧分配
    if (n.phonemeAdjustments) {
      for (const adj of n.phonemeAdjustments) {
        s += `|dr:${adj.durationRatio}|or:${adj.offsetRatio || 0}`;
        if (adj.volumePoints) {
          for (const vp of adj.volumePoints) s += `:${vp.t}:${vp.v}`;
        }
      }
    }
    // 颤音改变 F0
    if (n.vibrato && n.vibrato.enabled) {
      s += `|vib:${n.vibrato.depth}:${n.vibrato.rate}:${n.vibrato.start}:${n.vibrato.length}:${n.vibrato.fadeIn}`;
    }
    h = hashString(s, h);
  }
  return h;
}

/**
 * 歌手的音色身份 —— 换人、换后端、换参考音频都必须改变它。
 *
 * singerId 本身不足以表达"同一条轨道换了音色文件"：编辑歌手时 id 不变，
 * 只有 wavBuffer / backend 变。
 */
export function singerVoiceSignature(singer) {
  if (!singer) return 'nos';
  const backend = singer.backend && typeof singer.backend === 'object'
    ? singer.backend
    : { type: 'sxs' };
  // params 是插件自定义域，键序不稳定会让签名抖动 —— 按键名排序后序列化
  let paramsKey = '';
  if (backend.params && typeof backend.params === 'object') {
    const sorted = {};
    for (const k of Object.keys(backend.params).sort()) sorted[k] = backend.params[k];
    paramsKey = safeJson(sorted);
  }
  const backendKey = [
    backend.type || 'sxs',
    backend.pluginId || '',
    backend.kindId || '',
    backend.voiceId || '',
    paramsKey,
  ].join(':');
  return [
    singer.id || 'noid',
    backendKey,
    hashBuffer(singer.wavBuffer),
    hashNotes(singer.midiNotes),
    hashBuffer(singer.f0Data),
  ].join('/');
}

/**
 * 单个分片的签名。
 *
 * 音符取 `computeActiveClippedNotes` 的结果 —— 与真正下发给管线的音符集合
 * 完全一致（未激活的重叠音符、超出分片时长的尾部都不参与合成，改动它们
 * 不该触发重推）。
 *
 * @param {object} fragment
 * @param {object|null} singer 所属轨道（用于音色身份）
 * @param {number} bpm
 * @returns {string}
 */
export function computeFragmentSignature(fragment, singer, bpm) {
  if (!fragment) return 'nofrag';
  const notes = computeActiveClippedNotes(fragment, fragment.notes || []);
  const notesHash = hashNotes(notes);

  const pitchMode = fragmentPitchMode(fragment, hasF0PostprocessEffect);
  let f0Hash = 0;
  if (notes.length > 0 && pitchMode !== 'score') {
    // 曲线求值失败不能让播放卡住：签名退化成 0 只会导致多推一次
    try {
      const f0 = buildFragmentPitchCurveF0(fragment, notes, bpm);
      f0Hash = f0 ? hashNumberArray(f0) : 0;
    } catch (_e) {
      f0Hash = -1;
    }
  }

  // 频谱后处理（音色曲线）只改 vocoder 的输入 mel，不改 F0，
  // 因此必须单独进签名，否则改音色后播的还是老音频。
  let ppKey = 'off';
  try {
    const mp = buildMelPostprocessPayload(
      fragment.postprocess || null,
      notes,
      bpm,
      SAMPLE_RATE,
      SVS_HOP_SIZE,
    );
    if (mp) {
      ppKey = [
        mp.frames || 0,
        Number.isFinite(Number(mp.startBeat)) ? Number(mp.startBeat).toFixed(4) : 'x',
        Number(mp.bpm) || 'x',
        hashNumberArray(mp.sigmaT || []),
        hashNumberArray(mp.sigmaF || []),
        hashNumberArray(mp.blend || []),
        hashNumberArray(mp.boundaries || []),
      ].join(':');
    }
  } catch (_e) {
    ppKey = 'err';
  }

  return [
    fragment.id || 'noid',
    singer ? singerVoiceSignature(singer) : 'nos',
    fragment.startTime,
    fragment.duration,
    notesHash,
    pitchMode,
    f0Hash,
    ppKey,
  ].join('~');
}

/** 全局合成选项里会影响输出音频的字段（顺序固定，便于稳定对比）。 */
function optionsKey(autoShift, opts) {
  const o = opts || {};
  const keyframes = o.cfgScheduleKeyframes ? safeJson(o.cfgScheduleKeyframes) : '';
  return [
    autoShift ? 1 : 0,
    o.nSteps ?? '',
    o.cfg ?? '',
    o.cfgRescale ?? '',
    o.diffStepChunk ? 1 : 0,
    o.diffStepChunkFrames ?? '',
    o.diffStepOverlapFrames ?? '',
    o.cfgScheduleMode ?? '',
    o.cfgStrengthStart ?? '',
    keyframes,
    o.dynamicThresholdEnabled ? 1 : 0,
    o.dynamicThresholdPercentile ?? '',
  ].join(',');
}

/**
 * 整首工程的播放签名。
 *
 * 分片按 (startTime, id) 排序后再拼接，使签名与数组顺序无关 —— trackManager
 * 内部顺序变化（新增/删除其它轨道）不该被误判成"内容变了"。
 *
 * @param {object} input
 * @param {Array} input.fragments 全部轨道上的分片
 * @param {Array|Map} input.singers 轨道列表（或 id→轨道 的 Map）
 * @param {number} input.bpm
 * @param {boolean} [input.autoShift]
 * @param {object} [input.inferenceOpts] getPreviewInferenceOptions() 的返回值
 * @returns {string}
 */
export function computeProjectSignature({ fragments, singers, bpm, autoShift = false, inferenceOpts = null }) {
  const singerMap = singers instanceof Map
    ? singers
    : new Map((singers || []).map((s) => [s.id, s]));

  // 伴奏轨不参与人声合成：跳过（见文件头「只覆盖真正影响人声音频的输入」）。
  const list = (fragments || [])
    .filter((f) => f && f.notes && f.notes.length > 0)
    .filter((f) => singerMap.get(f.singerId)?.type !== 'accompaniment')
    .slice()
    .sort((a, b) => (a.startTime - b.startTime) || String(a.id).localeCompare(String(b.id)));

  const parts = [String(bpm), optionsKey(autoShift, inferenceOpts)];
  for (const f of list) {
    parts.push(computeFragmentSignature(f, singerMap.get(f.singerId) || null, bpm));
  }
  return parts.join('|');
}
