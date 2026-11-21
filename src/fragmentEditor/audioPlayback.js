// B2: wavEncoder.js is now CommonJS — use require instead of ESM import.
const { encodeWav, applyEnvelopesToAudio } = require('../audio/wavEncoder.js');
import safeCallModule from '../shared/safeCall.js';

const { safeCleanup } = safeCallModule;
import { showAlertDialog } from '../alertDialog.js';
import { t } from '../i18n/index.js';
import { setLabel } from '../icons/iconHelper.js';
import { initPipeline, getFragmentPreviewInferenceOptions, getFragmentExportInferenceOptions } from './pipeline.js';
import {
  getSampleRate,
  getFragmentAudioData, setFragmentAudioData,
  getFragmentIsPlaying,
  getFragmentIsSynthesizing, setFragmentIsSynthesizing,
  getFragmentIsAutoInferring, setFragmentIsAutoInferring,
  getFragmentIsExporting, setFragmentIsExporting,
  getFragmentCurrentTime, setFragmentCurrentTime,
  getFragmentUseExclusiveMode,
  getFragmentAudioSettings,
  getFragmentPlayStartPosition, setFragmentPlayStartPosition,
  getFragmentAudioDataSignature, setFragmentAudioDataSignature,
  getPipelineInitialized,
  getWavFileBuffer,
  getSingerAnnotation,
  getCurrentProject,
  getCurrentFragment,
  getEnvelopes,
  getTrackBackend,
} from './state.js';
import { getClippedNotes, buildPitchCurveF0Data, isScorePitchMode, render, resetPlayheadFollow } from './canvasRenderer.js';
import { firstNoteStart } from '../shared/activeNotes.js';
// 哈希算法与主进程合成缓存键、主窗口播放签名共用一份（src/shared/hashSignature.js）。
import { hashNumberArray, hashString } from '../shared/hashSignature.js';
import { computePromptCondSignature } from '../shared/promptCondSignature.js';
import { buildMelPostprocessPayload, serializePostprocessForSignature } from './postprocessAccess.js';
import { updateFragmentPlayButton } from './uiControls.js';
// 播放侧的全部状态与行为都在 playbackSession.js（会话独占）。本文件只负责
// 合成编排：缓存签名、IPC 调用、结果落地、导出、后台推理。
import {
  createSession, getCurrentSession, stopPlayback, playheadTick,
  getFragmentAudioContextInternal, loadFragmentAudioSettings,
} from './playbackSession.js';

export { getFragmentAudioContextInternal, loadFragmentAudioSettings };
/** 兼容旧调用名：播放头循环现在由会话驱动。 */
export const updateFragmentPlayhead = playheadTick;

/**
 * 把当前分片的后端声明挂到合成 options 上（options.backend）。
 *
 * 约定见 src/main/svsIpc.js 的 _resolvePluginBackend()：只要 options.backend.type
 * === 'plugin'，主进程就把这一个 options 引用整体交给插件，不再走内置 pipeline。
 *
 * 两条纪律（与 src/renderer/audioPlayback.js 的 attachPluginBackend 保持一致）：
 *   · 内置后端不留痕：{type:'sxs'} 时压根不写 backend 字段，内置链路零差异。
 *   · 其余参数一个都不删：需求要求"给模型的参数都要能传给插件"，这里只追加。
 */
function attachPluginBackend(options) {
  if (!options) return options;
  const backend = getTrackBackend();
  if (backend && backend.type === 'plugin') {
    // 浅拷贝：主进程把同一个 options 引用交给插件，插件改写不能透回
    // 模块级的 trackBackend（那是工程数据）。
    options.backend = { ...backend };
  }
  return options;
}

/**
 * 构建导出用的 per-note 渐入/渐出列表（与 wavEncoder.applyEnvelopesToAudio 对接）。
 * 时间单位：start/duration 用 beats，fadeIn/fadeOut 用秒。
 */
function _buildNoteFadesForExport() {
  const notes = getClippedNotes();
  const out = [];
  for (const n of notes) {
    const fadeInSec = (n.fadeIn && n.fadeIn > 0) ? n.fadeIn / 1000 : 0;
    const fadeOutSec = (n.fadeOut && n.fadeOut > 0) ? n.fadeOut / 1000 : 0;
    if (fadeInSec <= 0 && fadeOutSec <= 0) continue;
    out.push({ startBeat: n.start, durationBeats: n.duration, fadeInSec, fadeOutSec });
  }
  return out;
}

export function stopFragmentPlayback() {
  stopPlayback();
}

/**
 * 取消正在进行的推理（与主页面 stopPlayback 的"合成中取消"语义一致）。
 *
 * 分片编辑器此前只停本地音频、从不通知主进程：用户点停止后 GPU 仍会把整段
 * 推理跑完（长分片几十秒），期间按钮停在"合成中"且不可点，下一次播放被
 * `isSynthesizing` 的守卫静默挡住 —— 也就是"停止停不掉推理"。
 *
 * @returns {boolean} 是否确实取消了在途推理
 */
export function cancelFragmentSynthesis() {
  if (!getFragmentIsSynthesizing()) return false;
  // 模型加载阶段不能发 cancel：主进程会落到"无活跃任务 → resetSvsPipeline()"，
  // 把正在初始化的 lazy 实例作废，下次播放要重新加载（与主页面同一守卫）。
  if (getPipelineInitialized() && window.electronAPI?.cancelSVSSynthesis) {
    window.electronAPI.cancelSVSSynthesis().catch(() => {});
  }
  // 立即放开重入锁：否则 IDLE 下按钮可点、playFragment 的 guard 却静默 return，
  // 用户看到的是"点了没反应"。旧会话会在最近的检查点（sess.isCurrent）退出。
  setFragmentIsSynthesizing(false);
  // dispose 会话 → 在途 chunk / 收尾 / 兜底播放全部作废
  stopPlayback();
  updateFragmentPlayButton();
  return true;
}

/**
 * 播放中拖拽 playhead 时跳转到新位置。
 * 不重新合成：直接复用已缓存的 fragmentAudioData，从 newStartTime 开始播放。
 */
export async function seekFragmentPlayback(newStartTime) {
  // 用户刚拖动过播放头 = 一次明确的"人在这里"，视口应当跟上（不受 3s 门控）
  resetPlayheadFollow({ reveal: true });

  // 合成进行中的拖拽：不能用旧缓存音频重启播放（与新音符不匹配，且会与合成
  // 完成后的兜底播放叠加成双路音频）。只停掉当前出声并记住新位置，合成完成后
  // 由 playFragment 从该位置整段播放新音频。
  const cur = getCurrentSession();
  if (getFragmentIsSynthesizing() && cur && !cur.disposed) {
    cur.requestSeekDuringSynthesis(newStartTime);
    return;
  }

  setFragmentPlayStartPosition(newStartTime);
  const audioData = getFragmentAudioData();
  if (!audioData || audioData.length === 0) {
    // 无可播音频：不能静默返回 —— 播放状态已停但视觉未更新，用户会以为点击无效。
    stopPlayback();
    setFragmentCurrentTime(newStartTime);
    render();
    updateFragmentPlayButton();
    return;
  }

  const exclusive = getFragmentAudioSettings()?.audioOutputMode === 'exclusive';
  const sess = createSession(exclusive ? 'exclusive' : 'full');
  if (exclusive) await sess.playExclusive(audioData);
  else await sess.playFullBuffer(audioData);
}

function padAudioToFragmentDuration(audioData) {
  const fragment = getCurrentFragment();
  if (!fragment || !fragment.duration || !audioData || audioData.length === 0) return audioData;
  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const expectedSamples = Math.ceil((fragment.duration / bpm) * 60 * getSampleRate());
  // synthesizeFragmentSVS 返回的 audioData[0] 对应 filledNotes[0].start（首音符起点
  // 相对 fragment），而非 fragment 起点。前置 firstNoteOffsetSample 个零样本使
  // paddedAudio[0] 对齐到 fragment 起点，这样下游 startOffset / currentTime 都以
  // fragment 起点为参考，与 canvas 中 note.start 的 beat 坐标一致。
  const clippedNotes = getClippedNotes();
  const firstNoteOffsetSample = clippedNotes.length > 0
    ? Math.floor((firstNoteStart(clippedNotes) / bpm) * 60 * getSampleRate())
    : 0;
  const requiredLength = Math.max(expectedSamples, firstNoteOffsetSample + audioData.length);
  if (requiredLength <= audioData.length && firstNoteOffsetSample === 0) return audioData;
  const padded = new Float32Array(requiredLength);
  padded.set(audioData, firstNoteOffsetSample);
  return padded;
}

/**
 * 与服务端 AudioSegmentation.hashArray 语义一致的 FNV-1a 32-bit 哈希。
 * 算法本体在 src/shared/hashSignature.js，三处消费方调同一个函数。
 */
function _hashArrayFNV(arr) {
  return hashNumberArray(arr);
}

/**
 * 下发给管线的音高来源。
 * score 时 pitchCurveF0 已经是 null，这里再带一个显式标记 —— 否则管线分不清
 * "没有曲线"和"要 score"，会把 note.pitch 填成逐音符恒定的平直 F0。
 */
function currentPitchControl() {
  return isScorePitchMode() ? 'score' : 'manual';
}

/**
 * 计算当前 fragment 合成输入的签名（notes + 选项）。
 * 与服务端 computeSynthCacheKey 覆盖的字段一致。
 * 注意：签名不包含 playStartPosition — 起始位置变化不影响音频内容。
 */
export function computeFragmentAudioSignature() {
  const notes = getClippedNotes();
  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const previewOpts = getFragmentPreviewInferenceOptions();
  // 签名只需要"输入变了"的哈希：F0 后处理链的结果已由下方 ppHash 单独覆盖，
  // 这里跳过整条滤波（400ms 自动推理轮询会反复调用本函数）。
  const pitchCurveF0 = buildPitchCurveF0Data({ postprocess: false });
  const refAudioWavBuffer = getWavFileBuffer();
  const autoShiftEl = document.getElementById('autoShiftCheck');
  const autoShift = autoShiftEl ? autoShiftEl.checked : false;
  const singerId = getCurrentFragment()?.singerId || null;

  // notes hash — 与服务端 computeSynthCacheKey 保持一致的字段拼接
  // （含 noteType：3=连音。MIDI 导入的连音音符只带 noteType、没有 isSlur 标志。）
  let notesHash = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    let s = `${n.lyric || ''}|${n.pitch}|${n.start}|${n.duration}|${n.isSlur ? 1 : 0}|${n.isContinuation ? 1 : 0}|t${n.noteType || 0}`;
    if (n.phonemeAdjustments) {
      for (const adj of n.phonemeAdjustments) {
        s += `|dr:${adj.durationRatio}|or:${adj.offsetRatio || 0}`;
        if (adj.volumePoints) {
          for (const vp of adj.volumePoints) s += `:${vp.t}:${vp.v}`;
        }
      }
    }
    if (n.vibrato && n.vibrato.enabled) {
      s += `|vib:${n.vibrato.enabled ? 1 : 0}:${n.vibrato.depth}:${n.vibrato.rate}:${n.vibrato.start}:${n.vibrato.length}:${n.vibrato.fadeIn}`;
    }
    for (let j = 0; j < s.length; j++) {
      notesHash = ((notesHash << 5) - notesHash + s.charCodeAt(j)) | 0;
    }
  }

  const f0Hash = pitchCurveF0 ? _hashArrayFNV(pitchCurveF0) : 0;

  // 音色 / 后处理曲线 hash：频谱后处理不改变 F0，必须单独进签名。
  let ppHash = 0;
  const ppSignature = serializePostprocessForSignature();
  for (let i = 0; i < ppSignature.length; i++) {
    ppHash = ((ppHash << 5) - ppHash + ppSignature.charCodeAt(i)) | 0;
  }

  // refAudioWavBuffer hash — FNV-1a 全量采样 + 长度折叠，与服务端一致。
  let refHash = 0;
  if (refAudioWavBuffer) {
    const refBytes = refAudioWavBuffer instanceof ArrayBuffer
      ? new Uint8Array(refAudioWavBuffer)
      : refAudioWavBuffer;
    refHash = _hashArrayFNV(refBytes);
  }

  const singerAnn = getSingerAnnotation() || {};
  const promptHash = hashString(computePromptCondSignature(
    singerAnn.singerData,
    singerAnn.midiNotes,
    singerAnn.f0Data,
    undefined
  ));

  // 音高来源也必须进签名：manual 空曲线与 score 都产出 pitchCurveF0=null。
  const pitchControl = currentPitchControl();
  // 与主进程 computeSynthCacheKey 的字段集保持一致：采样器 / Q-Drift / 精度 /
  // CFG 曲线 / 动态阈值都会改变输出，漏进签名就会"改了设置却播旧音频"。
  const schedSig = `${previewOpts.cfgScheduleMode || 'constant'}:${previewOpts.cfgStrengthStart ?? ''}:${JSON.stringify(previewOpts.cfgScheduleKeyframes || null)}`;
  const dynSig = previewOpts.dynamicThresholdEnabled ? `1:${previewOpts.dynamicThresholdPercentile}` : '0';
  return `${notesHash}_${bpm}_${f0Hash}_${refHash}_p${promptHash}_${previewOpts.nSteps}_${previewOpts.cfg}_${previewOpts.cfgRescale}_${autoShift}_${singerId || 'noid'}_${previewOpts.diffStepChunk ? 1 : 0}_${previewOpts.diffStepChunkFrames || 500}_${previewOpts.diffStepOverlapFrames !== undefined ? previewOpts.diffStepOverlapFrames : 50}_pp${ppHash}_${pitchControl}_sm${previewOpts.sampler || 'euler'}_qd${previewOpts.qdrift ? 1 : 0}_pm${previewOpts.modelPrecision || 'fp32'}_cs${schedSig}_dt${dynSig}`;
}

/** 合成 options 的公共部分（预览 / 后台推理共用，避免两处字段漂移）。 */
function buildPreviewOptions(previewOpts, extra) {
  return attachPluginBackend({
    f0Envelope: null,
    pitchCurveF0: buildPitchCurveF0Data() || null,
    pitchControl: currentPitchControl(),
    refAudioWavBuffer: getWavFileBuffer() || null,
    refSingerData: (getSingerAnnotation() || {}).singerData || null,
    refMidiNotes: (getSingerAnnotation() || {}).midiNotes || null,
    refF0Data: (getSingerAnnotation() || {}).f0Data || null,
    singerId: getCurrentFragment()?.singerId || null,
    autoShift: document.getElementById('autoShiftCheck').checked,
    nSteps: previewOpts.nSteps,
    cfg: previewOpts.cfg,
    cfgRescale: previewOpts.cfgRescale,
    // 采样器 / Q-Drift / 精度：必须与主窗口同口径下发。它们既改变输出，
    // 也进主进程缓存键 —— 漏传会让两条路径各推一份且缓存互不命中。
    sampler: previewOpts.sampler,
    qdrift: previewOpts.qdrift,
    modelPrecision: previewOpts.modelPrecision,
    diffStepChunk: previewOpts.diffStepChunk,
    diffStepChunkFrames: previewOpts.diffStepChunkFrames,
    diffStepOverlapFrames: previewOpts.diffStepOverlapFrames,
    cfgScheduleMode: previewOpts.cfgScheduleMode,
    cfgStrengthStart: previewOpts.cfgStrengthStart,
    cfgScheduleKeyframes: previewOpts.cfgScheduleKeyframes,
    dynamicThresholdEnabled: previewOpts.dynamicThresholdEnabled,
    dynamicThresholdPercentile: previewOpts.dynamicThresholdPercentile,
    melPostprocess: buildMelPostprocessPayload(
      getClippedNotes(),
      getCurrentProject() ? getCurrentProject().bpm : 120,
      getSampleRate(),
      480,
    ),
    ...extra,
  });
}

/** 按当前输出设置整段播放（缓存命中 / 流式未启动的兜底 / seek 后续播）。 */
async function playWholeBuffer(sess, audioData) {
  const exclusive = getFragmentAudioSettings()?.audioOutputMode === 'exclusive';
  if (exclusive) await sess.playExclusive(audioData);
  else await sess.playFullBuffer(audioData);
}

export async function playFragment() {
  // 重入保护：防止连续调用导致前一次 finally 提前把 fragmentIsSynthesizing
  // 置 false，使后续进度回调失效。
  if (getFragmentIsSynthesizing() || getFragmentIsExporting()) return;
  // 新一轮播放：清掉上一次会话残留的分页动画；若播放头在视口外，第一帧就回填。
  resetPlayheadFollow({ reveal: true });

  // 作废旧会话并开新一轮。会话号即身份：所有异步续体据此判断自己是否过期。
  const sess = createSession('stream');
  sess.beginStreaming();
  setFragmentIsSynthesizing(true);
  updateFragmentPlayButton();

  try {
    if (!getPipelineInitialized()) await initPipeline();
    await loadFragmentAudioSettings();
    if (!sess.isCurrent) return;

    // 缓存优化：签名相同且已有音频 → 直接整段播放，跳过 IPC 合成。
    const currentSignature = computeFragmentAudioSignature();
    const cachedAudio = getFragmentAudioData();
    if (cachedAudio && cachedAudio.length > 0 && getFragmentAudioDataSignature() === currentSignature) {
      await playWholeBuffer(sess, cachedAudio);
      return;
    }

    // chunk 监听归会话所有：直到会话 dispose 才摘除。
    // 旧实现在 invoke 回执后立刻摘监听，而 chunk 与回执走不同 IPC 通道，
    // 仍在队列里的块被永久丢弃 → "前面有声音、后面整段静音"。
    sess.chunkCleanup = window.electronAPI.onFragmentSVSChunkAudio((chunkInfo) => {
      sess.pushChunk(chunkInfo);
    });

    const previewOpts = getFragmentPreviewInferenceOptions();
    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes: getClippedNotes(),
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: buildPreviewOptions(previewOpts),
    });
    // 会话已被取消/取代（用户点了停止 / 又开了新一轮）：结果作废。
    if (!sess.isCurrent) return;

    // 推理期间用户改了音符 / 音高曲线 / 音色：这份音频属于**旧输入**。
    // 无条件写签名会把旧音频标成"当前内容"的缓存，之后每次播放都命中它。
    if (computeFragmentAudioSignature() !== currentSignature) {
      console.warn('[FragmentAudio] Inputs changed during synthesis — discarding result');
      setFragmentAudioDataSignature(null);
      await sess.setInferenceDone();
      return;
    }

    const padded = padAudioToFragmentDuration(audioData);
    setFragmentAudioData(padded);
    setFragmentAudioDataSignature(currentSignature);

    // 标记推理完成：后续不再触发 buffer underrun 等待；已在等待则立即解冻。
    await sess.setInferenceDone();
    if (!sess.isCurrent) return;

    // 让出一轮宏任务：chunk 事件与 invoke 回执走不同通道，回执可能先到。
    // 随后等队列排空 —— 监听器仍在，队列里剩下的块都会被处理。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sess.drain();
    if (!sess.isCurrent) return;

    // 合成期间用户拖拽了播放头：从新位置整段播放新音频。
    if (sess.pendingSeek !== null) {
      const pos = sess.pendingSeek;
      sess.pendingSeek = null;
      sess.startPositionSec = pos;
      setFragmentPlayStartPosition(pos);
      await playWholeBuffer(sess, padded);
      return;
    }

    // 流式从未启动（插件后端 / 单块未触发回调 / 全部块都在起播点之前）：整段兜底。
    if (!sess.streamStarted && !getFragmentIsPlaying()) {
      await playWholeBuffer(sess, padded);
    }
  } catch (error) {
    if (!sess.isCurrent) return;
    const msg = String((error && error.message) || '');
    // 协作式取消（SYNTHESIS_CANCELLED / 被新请求取代）不是错误。
    if (/cancel|superseded|abort/i.test(msg)) {
      console.log('[FragmentAudio] Synthesis cancelled');
    } else {
      console.error(t('fragment.synthesisFailed') + ':', error);
      showAlertDialog(t('fragment.synthesisFailedDetail', { detail: error.message }));
    }
    stopPlayback();
    setFragmentCurrentTime(0);
    updateFragmentPlayButton();
  } finally {
    // 只有"当前会话"才允许收尾：取消后用户可能已经开了新一轮播放，
    // 旧会话在这里把 isSynthesizing 置 false 会把新一轮的重入锁拆掉。
    if (sess.isCurrent) {
      setFragmentIsSynthesizing(false);
      updateFragmentPlayButton();
    }
  }
}

/**
 * 后台静默合成：只重算音频并写入 fragmentAudioData，不播放、不弹错误对话框。
 * 供"编辑后自动实时推理"（设置项 autoRealtimeInference）使用。
 *
 * 与已有分段缓存的协同：主进程多 segment 路径按 segment 计算缓存键，未改动的
 * segment 直接命中、跳过 diffusion+vocoder。因此这里刻意不清缓存。
 *
 * @param {{priorityTimeSec?: number}} [opts]
 * @returns {Promise<'ok'|'skip'|'error'>}
 */
export async function synthesizeFragmentInBackground(opts = {}) {
  if (getFragmentIsPlaying() || getFragmentIsSynthesizing() || getFragmentIsExporting()) return 'skip';
  if (getFragmentIsAutoInferring()) return 'skip';

  const notes = getClippedNotes();
  if (!notes || notes.length === 0) return 'skip';
  // 只有已经合成过（存在旧预览音频）时"改动"才有意义。
  if (getFragmentAudioDataSignature() === null) return 'skip';

  const currentSignature = computeFragmentAudioSignature();
  if (currentSignature === getFragmentAudioDataSignature()) return 'skip';

  setFragmentIsAutoInferring(true);
  updateFragmentPlayButton();
  try {
    if (!getPipelineInitialized()) await initPipeline();
    await loadFragmentAudioSettings();

    if (getFragmentIsPlaying() || getFragmentIsSynthesizing() || getFragmentIsExporting()) return 'skip';
    if (computeFragmentAudioSignature() !== currentSignature) return 'skip';

    const previewOpts = getFragmentPreviewInferenceOptions();
    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes,
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: buildPreviewOptions(previewOpts, {
        // 后台推理：主进程不下发流式 chunk，避免无意义的分片间 IPC 拷贝。
        background: true,
        priorityTimeSec: Number.isFinite(opts.priorityTimeSec) ? opts.priorityTimeSec : 0,
      }),
    });

    if (computeFragmentAudioSignature() !== currentSignature) return 'skip';
    if (getFragmentIsPlaying() || getFragmentIsSynthesizing()) return 'skip';

    setFragmentAudioData(padAudioToFragmentDuration(audioData));
    setFragmentAudioDataSignature(currentSignature);
    console.log('[FragmentAudio] Background inference done (preview audio refreshed)');
    return 'ok';
  } catch (error) {
    // 取消/被取代不算推理失败（归为 'error' 会误触发 15 秒冷却）。
    const code = (error && error.code) || '';
    const msg = (error && error.message) || '';
    const isCancelled = code === 'SVS_SUPERSEDED' || code === 'SYNTHESIS_CANCELLED'
      || /superseded|cancelled|canceled|abort/i.test(msg);
    if (isCancelled) return 'skip';
    // 远程 API 的失败必须显式提示：401/403、429、超时、网络不通都是用户能
    // 立刻处理的问题，静默吞掉会让用户以为"合成还在跑"或"没声音"。
    if (/\[API[ \]]/i.test(msg)) {
      try {
        showAlertDialog(t('fragment.synthesisFailedDetail', { detail: msg }));
      } catch (_) { /* 弹窗失败也要保留下面的 warn 日志 */ }
    }
    console.warn('[FragmentAudio] Background inference failed:', error && error.message);
    return 'error';
  } finally {
    setFragmentIsAutoInferring(false);
    updateFragmentPlayButton();
  }
}

export async function exportFragment() {
  if (getFragmentIsSynthesizing() || getFragmentIsExporting()) return;
  const btnExportFragment = document.getElementById('btn-export-fragment');
  const originalText = btnExportFragment.textContent;
  btnExportFragment.disabled = true;
  setLabel(btnExportFragment, t('fragment.exporting'), { icon: 'download' });
  setFragmentIsExporting(true);
  try {
    if (!getPipelineInitialized()) await initPipeline();
    await loadFragmentAudioSettings();

    const exportOpts = getFragmentExportInferenceOptions();
    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes: getClippedNotes(),
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: attachPluginBackend({
        f0Envelope: null,
        pitchCurveF0: buildPitchCurveF0Data() || null,
        pitchControl: currentPitchControl(),
        refAudioWavBuffer: getWavFileBuffer() || null,
        refSingerData: (getSingerAnnotation() || {}).singerData || null,
        refMidiNotes: (getSingerAnnotation() || {}).midiNotes || null,
        refF0Data: (getSingerAnnotation() || {}).f0Data || null,
        singerId: getCurrentFragment()?.singerId || null,
        autoShift: document.getElementById('autoShiftCheck').checked,
        nSteps: exportOpts.nSteps,
        cfg: exportOpts.cfg,
        cfgRescale: exportOpts.cfgRescale,
        sampler: exportOpts.sampler,
        qdrift: exportOpts.qdrift,
        modelPrecision: exportOpts.modelPrecision,
        melPostprocess: buildMelPostprocessPayload(
          getClippedNotes(),
          getCurrentProject() ? getCurrentProject().bpm : 120,
          getSampleRate(),
          480,
        ),
      }),
    });
    const paddedAudio = padAudioToFragmentDuration(audioData);
    const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
    const envelopes = getEnvelopes();
    const noteFades = _buildNoteFadesForExport();
    const stereoData = applyEnvelopesToAudio(paddedAudio, getSampleRate(), bpm, envelopes.volume, envelopes.pan, noteFades);
    const wavData = encodeWav(stereoData, getSampleRate(), 2);
    const result = await window.electronAPI.showSaveDialog({
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });
    if (!result.canceled && result.filePath) {
      await window.electronAPI.saveFile(result.filePath, wavData);
    }
  } catch (error) {
    console.error(t('fragment.exportFailed') + ':', error);
    showAlertDialog(t('fragment.exportFailedDetail', { detail: error.message }));
  } finally {
    setFragmentIsExporting(false);
    btnExportFragment.disabled = false;
    setLabel(btnExportFragment, originalText, { icon: 'download' });
  }
}