/**
 * prompt cond 输入签名 —— 三个缓存判断点共用同一口径。
 *
 * prompt cond 由三份可独立变化的数据共同决定：
 *   · refSingerData：歌词/F0 字符串/trimOffset 等 .sxssinger 标注；
 *   · refMidiNotes：buildPromptSequence 实际优先使用的 start/duration/lyric；
 *   · refF0Data：buildPromptSequence 实际优先使用的逐帧 F0。
 * 任何一份变化都必须让 mel/音频缓存失效，否则用户改歌词、改音符或重提 F0
 * 之后会继续听到旧结果。三处消费方（主进程合成缓存、主窗口播放签名、
 * 分片编辑器预览签名）必须调用本函数，避免各自漏字段。
 */

import { hashNumberArray, hashString } from './hashSignature.js';

function finiteOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {object|null} refSingerData
 * @param {Array|null} refMidiNotes
 * @param {Array|null} refF0Data
 * @param {number|undefined} maxPromptFrames
 * @returns {string} 可直接拼进缓存键的稳定签名
 */
export function computePromptCondSignature(refSingerData, refMidiNotes, refF0Data, maxPromptFrames) {
  const sd = refSingerData && typeof refSingerData === 'object' ? refSingerData : null;
  const sdSig = sd
    ? [
      sd.text || '',
      sd.phoneme || '',
      sd.note_pitch || '',
      sd.duration || '',
      sd.note_type || '',
      sd.f0 || '',
      sd.trimOffsetSec !== undefined ? sd.trimOffsetSec : '',
      Array.isArray(sd.time) ? sd.time.join(',') : '',
    ].join('|')
    : '';

  let midiSig = '';
  if (Array.isArray(refMidiNotes) && refMidiNotes.length > 0) {
    midiSig = refMidiNotes.map((n) => {
      if (!n || typeof n !== 'object') return '';
      return [
        n.lyric || '',
        finiteOrZero(n.pitch),
        finiteOrZero(n.start),
        finiteOrZero(n.duration),
        n.isSlur ? 1 : 0,
        n.isContinuation ? 1 : 0,
        finiteOrZero(n.noteType),
      ].join(',');
    }).join(';');
  }

  let f0Hash = 0;
  let f0TimeHash = 0;
  if (Array.isArray(refF0Data) && refF0Data.length > 0) {
    const vals = new Float32Array(refF0Data.length);
    const times = new Float32Array(refF0Data.length);
    for (let i = 0; i < refF0Data.length; i++) {
      const frame = refF0Data[i];
      vals[i] = finiteOrZero(frame && frame.f0);
      times[i] = finiteOrZero(frame && frame.time);
    }
    f0Hash = hashNumberArray(vals);
    f0TimeHash = hashNumberArray(times);
  }

  const cap = Number.isFinite(maxPromptFrames) && maxPromptFrames > 0
    ? Math.floor(maxPromptFrames)
    : 0;

  return `${hashString(sdSig)}_${hashString(midiSig)}_${f0Hash}_${f0TimeHash}_${cap}`;
}
