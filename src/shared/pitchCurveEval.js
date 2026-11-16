/**
 * 音高曲线 → 逐帧 F0 的**唯一**求值入口（纯函数，无 DOM、无 state）。
 *
 * 历史上同一件事有三份实现（分片编辑器 buildPitchCurveF0Data、主窗口
 * buildFragmentPitchCurveF0、@internal computePitchCurveF0），三份在
 * bakedSegments / 后处理 / 后置表达上各有出入，是"显示与 F0 不一致"的根源。
 * 现在三处消费方（编辑器播放/自动推理、主窗口预览/导出、测试守护）都走这里：
 *
 *   曲线层（手动作用域 > 自动 > note.pitch 回退，shared/autoPitchCurve）
 *   → 手动颤音叠加
 *   → F0 后处理（中值 / Savitzky-Golay / 贝塞尔过渡，含 glideOwnership）
 *   → 后置表达（jitterStage='post' 的抖动 + 自动颤音，不被滤波削弱）
 *
 * 音符外一律 0（unvoiced），与推理侧 f0 <= 0 的 UV 规则同构。
 */

import { normalizePitchCurve } from './pitchCurveState.js';
import {
  createPitchResolver,
  applyExpressionToF0,
  resolvePitchRanges,
  findNoteAtBeat,
} from './autoPitchCurve.js';
import { lastNoteEnd } from './activeNotes.js';
import {
  buildF0PostprocessParams,
  applyGlideOwnership,
} from './postprocessCurves.js';
import { applyF0Postprocess } from '../fragmentEditor/f0Smoothing.js';

/** 手动颤音偏移（半音）。与 note.vibrato 的语义一致：depth 单位是音分。 */
function manualVibratoOffset(note, beat, bpm) {
  const v = note.vibrato;
  if (!v || !v.enabled || note.duration <= 0) return 0;
  const start = note.start + v.start * note.duration;
  const length = v.length * note.duration;
  if (length <= 0 || beat < start || beat > start + length) return 0;
  const pos = (beat - start) / length;
  const env = v.fadeIn > 0 && pos < v.fadeIn ? pos / v.fadeIn : 1;
  const seconds = ((beat - start) / bpm) * 60;
  return (v.depth / 100) * Math.sin(2 * Math.PI * v.rate * seconds) * env;
}

/**
 * 由曲线 + 音符求逐帧 F0（Hz，0 = unvoiced）。
 *
 * @param {object} args
 * @param {object} args.pitchCurve 音高曲线（原始或已归一化均可，内部归一化）
 * @param {Array} args.notes 参与合成的音符（已过滤 inactive / 裁剪，拍坐标系）
 * @param {number} args.bpm
 * @param {object|null} [args.postprocess] F0 后处理：raw `{defaults,curves}` 状态，
 *   或 buildF0PostprocessParams 的预构建参数（含 .smooth 数组）；null = 不处理
 * @param {{min:number,max:number}|null} [args.ranges] 模型音域（缺省按歌词语言推导）
 * @param {number} [args.seedSalt] 轨道 salt（多轨叠唱的抖动/颤音去相关）
 * @param {number} [args.sampleRate=24000]
 * @param {number} [args.hopSize=480]
 * @param {number} [args.durationBeats=Infinity] 分片时长上限（拍）
 * @param {boolean} [args.applyPostprocess=true] false 时跳过后处理链
 *   （签名哈希路径：后处理结果已由 ppHash 单独覆盖，无需反复跑滤波）
 * @returns {Float32Array}
 */
export function evaluatePitchCurveFrames({
  pitchCurve,
  notes,
  bpm,
  postprocess = null,
  ranges = null,
  seedSalt = 0,
  sampleRate = 24000,
  hopSize = 480,
  durationBeats = Infinity,
  applyPostprocess = true,
}) {
  if (!Array.isArray(notes) || notes.length === 0 || !(bpm > 0)) return new Float32Array(0);
  const pc = normalizePitchCurve(pitchCurve);
  const sortedNotes = notes.slice().sort((a, b) => a.start - b.start || b.duration - a.duration);
  // F2：总时长取 max(start+duration)，不取数组末元素
  const totalBeats = Math.min(lastNoteEnd(sortedNotes), durationBeats);
  const totalSeconds = (totalBeats / bpm) * 60;
  const totalFrames = Math.floor(totalSeconds * sampleRate / hopSize);
  const f0Array = new Float32Array(totalFrames);
  if (totalFrames === 0) return f0Array;

  const autoOn = !!(pc.auto && pc.auto.enabled);
  // jitterStage='post'：曲线层不含抖动，放到滤波之后叠加（否则会被 SG/中值削掉）。
  // 自动颤音一律后置（§6.3）：曲线层不含，避免被 f0Smooth 削弱。
  const jitterPost = autoOn && pc.auto.params.jitterStage === 'post';
  const pitchRanges = ranges || resolvePitchRanges(sortedNotes);
  const resolver = createPitchResolver({
    pitchCurve: pc,
    auto: pc.auto,
    sortedNotes,
    bpm,
    ranges: pitchRanges,
    seedSalt,
    includeJitter: !jitterPost,
    includeVibrato: false,
  });

  // 逐帧判断"这一帧是否落在某个音符内"：事件驱动扫描（音符按起点入列、
  // 终点出列），O(frames + notes)，长分片下不再逐帧对全部音符做查找。
  let nextNote = 0;
  const active = [];
  for (let i = 0; i < totalFrames; i++) {
    const frameBeat = (i * hopSize / sampleRate / 60) * bpm;
    while (nextNote < sortedNotes.length && sortedNotes[nextNote].start <= frameBeat) {
      active.push(sortedNotes[nextNote++]);
    }
    if (active.length > 0) {
      let w = 0;
      for (let r = 0; r < active.length; r++) {
        if (frameBeat < active[r].start + active[r].duration) active[w++] = active[r];
      }
      active.length = w;
    }
    if (active.length === 0) {
      f0Array[i] = 0; // 音符外强制 unvoiced
      continue;
    }
    // 统一求值（手动作用域内 > 自动 > 音符音高）+ 手动颤音叠加
    let pitch = resolver.pitchAt(frameBeat);
    const note = findNoteAtBeat(sortedNotes, frameBeat);
    if (note && note.vibrato && note.vibrato.enabled) {
      if (pitch === null) pitch = note.pitch;
      pitch += manualVibratoOffset(note, frameBeat, bpm);
    } else if (pitch === null) {
      pitch = note ? note.pitch : null;
    }
    if (pitch !== null && pitch > 0) {
      f0Array[i] = 440 * Math.pow(2, (pitch - 69) / 12);
    } else {
      f0Array[i] = 0;
    }
  }

  // F0 后处理：中值 → SG → 贝塞尔过渡（raw 状态先构建逐帧参数）
  let out = f0Array;
  if (applyPostprocess && postprocess) {
    const params = postprocess.smooth instanceof Float32Array
      ? postprocess
      : buildF0PostprocessParams(postprocess, totalFrames, bpm, sampleRate, hopSize);
    // 重合处理：auto 接管换音过渡时把 f0Glide 置零，避免双重过冲
    applyGlideOwnership(params, autoOn ? pc.auto : null);
    if (params.active) {
      out = applyF0Postprocess(out, params, { sampleRate, hopSize });
    }
  }

  // 自动表达后置：抖动（jitterStage='post'）与自动颤音在滤波之后叠加
  if (autoOn && out.length > 0) {
    out = applyExpressionToF0(out, {
      sortedNotes, auto: pc.auto, bpm,
      ranges: pitchRanges,
      seedSalt,
    }, { sampleRate, hopSize }, { jitter: jitterPost, vibrato: true });
  }
  return out;
}