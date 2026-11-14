// B2: wavEncoder.js is now CommonJS — use require instead of ESM import.
const { encodeWav, applyEnvelopesToAudio } = require('../audio/wavEncoder.js');
// 2.4: 清理型副作用统一走 safeCleanup，失败留痕不打断主流程（原先是 12 处空 catch）
import safeCallModule from '../shared/safeCall.js';

const { safeCleanup } = safeCallModule;
import { showAlertDialog } from '../alertDialog.js';
import { t } from '../i18n/index.js';
import { setLabel } from '../icons/iconHelper.js';
import { initPipeline, getFragmentPreviewInferenceOptions, getFragmentExportInferenceOptions } from './pipeline.js';
import { StreamingScheduler } from '../shared/streamingScheduler.js';
// 播放头必须按"耳朵听到的位置"走，而不是渲染线程的 currentTime
// （输出设备缓冲会让声音晚 20–120 ms 到喇叭 → 指示器稳定跑在声音前面）。
import { getAudibleElapsedSec } from '../shared/audioOutputClock.js';
import {
  getSampleRate,
  getFragmentAudioContext, setFragmentAudioContext,
  getFragmentAudioSource, setFragmentAudioSource,
  getFragmentAudioData, setFragmentAudioData,
  getFragmentIsPlaying, setFragmentIsPlaying,
  getFragmentIsSynthesizing, setFragmentIsSynthesizing,
  getFragmentIsAutoInferring, setFragmentIsAutoInferring,
  getFragmentIsExporting, setFragmentIsExporting,
  getFragmentPlaybackStartTime, setFragmentPlaybackStartTime,
  getFragmentPlaybackOffset, setFragmentPlaybackOffset,
  getFragmentPlayheadRaf, setFragmentPlayheadRaf,
  getFragmentCurrentTime, setFragmentCurrentTime,
  getFragmentGainNode, setFragmentGainNode,
  getFragmentUseExclusiveMode, setFragmentUseExclusiveMode,
  getFragmentExclusiveRaf, setFragmentExclusiveRaf,
  getFragmentAudioSettings, setFragmentAudioSettings,
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
import { getClippedNotes, buildPitchCurveF0Data, isScorePitchMode, render } from './canvasRenderer.js';
import { firstNoteStart } from '../shared/activeNotes.js';
// 哈希算法与主进程合成缓存键、主窗口播放签名共用一份（src/shared/hashSignature.js）。
import { hashNumberArray, hashString } from '../shared/hashSignature.js';
import { computePromptCondSignature } from '../shared/promptCondSignature.js';
import { buildMelPostprocessPayload, serializePostprocessForSignature } from './postprocessAccess.js';
import { updateFragmentPlayButton } from './uiControls.js';

// 独占模式 onAudioEnded 退订函数的模块级持有。旧实现只在 rAF 闭包内能退订，
// stop/pause/seek（均经 stopFragmentPlayback → stopFragmentExclusivePlayback）
// cancel rAF 后监听器永远泄漏——每次播放累积一个 IPC 监听。
let _fragmentRemoveEndedListener = null;
function _detachFragmentEndedListener() {
  if (_fragmentRemoveEndedListener) {
    safeCleanup('fragmentAudio.detachEndedListener', _fragmentRemoveEndedListener);
    _fragmentRemoveEndedListener = null;
  }
}

/**
 * 把当前分片的后端声明挂到合成 options 上（options.backend）。
 *
 * 约定见 src/main/svsIpc.js 的 _resolvePluginBackend()：只要 options.backend.type
 * === 'plugin'，主进程就把这一个 options 引用整体交给插件，不再走内置 pipeline。
 * 分片编辑器此前完全没接这条线 —— 插件轨道在这里的预览播放 / 后台推理 / 导出
 * 会静默跑内置 SoulX-Singer，与轨道上显示的插件名不符。
 *
 * 两条纪律（与 src/renderer/audioPlayback.js 的 attachPluginBackend 保持一致）：
 *   · 内置后端不留痕：{type:'sxs'} 时压根不写 backend 字段，内置链路零差异。
 *   · 其余参数一个都不删：需求要求"给模型的参数都要能传给插件"，这里只追加。
 *
 * @param {object} options
 * @returns {object} options 本身
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
 * 跳过 fadeIn=0 且 fadeOut=0 的 note，节省计算。
 * 时间单位：start/duration 用 beats，fadeIn/fadeOut 用秒。
 */
function _buildNoteFadesForExport() {
  const notes = getClippedNotes();
  const out = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const fadeInSec = (n.fadeIn && n.fadeIn > 0) ? n.fadeIn / 1000 : 0;
    const fadeOutSec = (n.fadeOut && n.fadeOut > 0) ? n.fadeOut / 1000 : 0;
    if (fadeInSec <= 0 && fadeOutSec <= 0) continue;
    out.push({
      startBeat: n.start,
      durationBeats: n.duration,
      fadeInSec,
      fadeOutSec,
    });
  }
  return out;
}

/**
 * 计算实时播放时 per-note 渐入/渐出的 WebAudio 自动化调度参数。
 * 返回 [{ atSec, rampEndSec, fromGain, toGain }] 列表，由调用方 setValueAtTime /
 * linearRampToValueAtTime 应用到 fadeGainNode。
 * 仅包含 fadeIn>0 或 fadeOut>0 的 note。
 *
 * 重要：fadeOut 后增益会停留在 0，导致后续无 fadeIn 的音符静音。
 * 调用方 _scheduleFadeAutomation 会在每个 fadeOut ramp 结束后插入恢复事件
 * (setValueAtTime(1, rampEndSec)) 把增益拉回 1。
 */
function _buildNoteFadesForRealtime(bpm) {
  const notes = getClippedNotes();
  const out = [];
  const secondsPerBeat = 60 / bpm;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const noteStartSec = n.start * secondsPerBeat;
    const noteEndSec = noteStartSec + n.duration * secondsPerBeat;
    if (n.fadeIn && n.fadeIn > 0) {
      const fadeInSec = n.fadeIn / 1000;
      out.push({
        atSec: noteStartSec,
        rampEndSec: noteStartSec + fadeInSec,
        fromGain: 0,
        toGain: 1,
      });
    }
    if (n.fadeOut && n.fadeOut > 0) {
      const fadeOutSec = n.fadeOut / 1000;
      out.push({
        atSec: Math.max(noteStartSec, noteEndSec - fadeOutSec),
        rampEndSec: noteEndSec,
        fromGain: 1,
        toGain: 0,
      });
    }
  }
  return out;
}

/**
 * 将 fade 事件调度到 fadeGainNode 上。
 *
 * 修复 fadeOut 静音 bug：fadeOut ramp 把增益降到 0 后，如果后续音符没有 fadeIn，
 * 增益会一直保持 0，导致后续音符完全静音。解决方案是在每个 fadeOut ramp 结束后
 * 立即调度 setValueAtTime(1, rampEndSec) 把增益恢复为 1。
 *
 * 事件顺序保证：WebAudio 同一时刻的事件按调度顺序处理。fadeOut 的 restore 事件
 * 在 fadeOut ramp 之后调度，若下一个 fadeIn 的 setValueAtTime(0, noteStartSec)
 * 在 restore 之后调度且 noteStartSec === rampEndSec，则 gain 最终为 0（fadeIn 正确）。
 * 若后续无 fadeIn，gain 保持 1（正确）。
 *
 * 注意：重叠音符场景下，单增益节点无法同时表达多个音符的独立 fade。
 * 导出路径 (wavEncoder) 对重叠音符的 fade gain 做乘积，实时路径用单增益曲线，
 * 两者行为在重叠时不同。非重叠 SVS 场景（正常情况）两者一致。
 */
function _scheduleFadeAutomation(fadeGainNode, ctx, fades, startOffset) {
  if (!fades || fades.length === 0) return;
  const now = ctx.currentTime;
  fadeGainNode.gain.setValueAtTime(1, now);
  // 按 atSec 排序，确保 restore 事件与后续 fadeIn 事件的调度顺序正确
  const sorted = [...fades].sort((a, b) => a.atSec - b.atSec);
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    // 仅调度 startOffset 之后的事件；起播位置之前的自动化直接跳过
    if (f.rampEndSec <= startOffset) continue;
    const atSec = Math.max(f.atSec, startOffset);
    const fromGain = f.atSec <= startOffset
      // 起播位置落在 fade 内：估算起播点处的 gain
      ? (f.toGain - f.fromGain) * Math.max(0, Math.min(1, (startOffset - f.atSec) / Math.max(0.0001, f.rampEndSec - f.atSec))) + f.fromGain
      : f.fromGain;
    fadeGainNode.gain.setValueAtTime(fromGain, now + (atSec - startOffset));
    fadeGainNode.gain.linearRampToValueAtTime(f.toGain, now + (f.rampEndSec - startOffset));
    // fadeOut 结束后恢复增益为 1，防止后续音符静音
    if (f.toGain === 0) {
      fadeGainNode.gain.setValueAtTime(1, now + (f.rampEndSec - startOffset));
    }
  }
}

/**
 * 对单声道音频就地应用 per-note fade（用于独占模式，该模式不经 WebAudio 图）。
 * 逻辑与 wavEncoder.applyEnvelopesToAudio 的 fade 部分一致：每个音符在自己的
 * 采样区间内施加 fadeIn/fadeOut 包络，区间外保持 1。重叠音符的 gain 做乘积。
 * 返回新的 Float32Array（不修改输入）。
 */
function _applyFadesToMonoAudio(audioData, bpm) {
  const notes = getClippedNotes();
  const fades = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const fadeInSec = (n.fadeIn && n.fadeIn > 0) ? n.fadeIn / 1000 : 0;
    const fadeOutSec = (n.fadeOut && n.fadeOut > 0) ? n.fadeOut / 1000 : 0;
    if (fadeInSec <= 0 && fadeOutSec <= 0) continue;
    fades.push({
      startBeat: n.start,
      durationBeats: n.duration,
      fadeInSec,
      fadeOutSec,
    });
  }
  if (fades.length === 0) return audioData;

  const sampleRate = getSampleRate();
  const numSamples = audioData.length;
  const out = new Float32Array(numSamples);
  out.set(audioData);
  const secondsPerBeat = 60 / bpm;
  for (let f = 0; f < fades.length; f++) {
    const nf = fades[f];
    const noteStartSec = nf.startBeat * secondsPerBeat;
    const noteDurSec = nf.durationBeats * secondsPerBeat;
    const noteEndSec = noteStartSec + noteDurSec;
    const startSample = Math.max(0, Math.floor(noteStartSec * sampleRate));
    const endSample = Math.min(numSamples, Math.ceil(noteEndSec * sampleRate));
    const fadeInSamples = Math.max(1, Math.floor(nf.fadeInSec * sampleRate));
    const fadeOutSamples = Math.max(1, Math.floor(nf.fadeOutSec * sampleRate));
    for (let i = startSample; i < endSample; i++) {
      let g = 1;
      if (nf.fadeInSec > 0 && i < startSample + fadeInSamples) {
        g = (i - startSample) / fadeInSamples;
      }
      if (nf.fadeOutSec > 0 && i > endSample - fadeOutSamples) {
        const fo = Math.max(0, (endSample - i) / fadeOutSamples);
        if (fo < g) g = fo;
      }
      if (g < 0) g = 0;
      if (g > 1) g = 1;
      out[i] *= g;
    }
  }
  return out;
}

// 流式播放状态（vocoder chunk 边合成边播放）
// streamingSources: 已调度的 AudioBufferSourceNode 列表（按顺序）
// streamingCleanup: chunk 监听器 cleanup 函数
// streamingFadeGainNode: 流式播放共享的 fade 增益节点，所有 chunk source 经它
//   连接到 master gain。首个 chunk 到达时创建并调度 fade 自动化，使流式播放
//   也应用 per-note fade（与 playFragmentShared 一致）。
let streamingSources = [];
let streamingCleanup = null;
let streamingNextStart = 0;
let streamingFinished = false;
let streamingFadeGainNode = null;
// 用户主动停止标记：stopFragmentPlayback 置位后，playFragment 的"合成完成兜底播放"
// 不再自动开播（否则点停止 → 合成完成 → 又自动开始播放）。
let _streamingUserStopped = false;
// 合成进行中用户拖拽播放头时记录的新位置：合成完成后由 playFragment 从该位置
// 播放新音频。合成中不能用旧缓存音频重启播放（旧音频与新音符不匹配 → 错位/杂音，
// 且会与合成完成后的兜底播放叠加成双路音频）。
let _pendingSeekStartTime = null;
// 播放会话代际。取消推理 / 新一轮播放会自增：在途 playFragment 的 catch / finally
// 据此判断"自己是否还是当前会话"，旧会话的收尾不得再改动共享播放状态
// （否则旧会话的错误处理会把新一轮刚排好的音频一起停掉）。
let _playSessionSeq = 0;

// Buffer underrun protection: shared infrastructure (AudioContext suspend/resume,
// watchdog, underrun detection, source counting) via StreamingScheduler.
let _streamingStarted = false;            // true after first chunk initializes playback
let _streamingFirstChunkAudioOffset = 0; // playStartPosition > firstNoteStartSec 时需跳过的前导音频秒数
let _scheduler = null;

function _createFragmentScheduler() {
  _scheduler = new StreamingScheduler({
    getCtx: () => getFragmentAudioContext(),
    getElapsed: () => {
      // 必须与 rAF 路径（_checkFragmentStreamingUnderrun）同基准：绝对播放位置
      // = playbackOffset + (ctx.currentTime - playbackStartTime)。漏加 offset 时
      // watchdog 传出的 elapsed 比真实播放头小 playbackOffset 秒 —— 从中段起播
      // 时 watchdog 要多等 offset 秒才触发，窗口最小化时 AudioContext 不会被
      // suspend，播放头直接冲进静音区无人接管。
      const ctx = getFragmentAudioContext();
      return ctx ? getFragmentPlaybackOffset() + (ctx.currentTime - getFragmentPlaybackStartTime()) : 0;
    },
    onWaitStateChange: (isWaiting) => {
      if (isWaiting) {
        // 进入等待推理（rAF / watchdog 两条路径统一入口）：
        // 取消 playhead rAF（恢复时由 chunk 回调重启，避免双循环叠加），
        // 并在按钮上给出"等待推理"反馈——否则用户只会看到播放头无端冻住。
        const raf = getFragmentPlayheadRaf();
        if (raf) { cancelAnimationFrame(raf); setFragmentPlayheadRaf(null); }
        const btn = document.getElementById('btn-play-fragment');
        if (btn) setLabel(btn, t('fragment.waitingForInference'), { icon: 'stop' });
      } else {
        updateFragmentPlayButton();
        // 等待结束（新 chunk 到达 / setInferenceDone 解冻）后必须重启播放头循环：
        // 进入等待时 rAF 已被取消，而 setInferenceDone 路径不会再经过 chunk 回调，
        // 漏了这一步就会出现"声音继续放、播放头永远停在接缝处"。
        if (getFragmentIsPlaying() && !getFragmentPlayheadRaf()
          && !(_scheduler && _scheduler.isWaiting)) {
          updateFragmentPlayhead();
        }
      }
    },
    // watchdog 兜底检测带 0.3s 提前量（>= 250ms tick 周期 + suspend 延迟），
    // 使冻结发生在 buffer 前沿之前：恢复时 chunk 的原始调度时间仍在未来，
    // 按原位无缝衔接，播放头不会先冲过前沿再回跳（可听静音缝 + 视觉跳动）。
    watchdogMarginSec: 0.3,
    onFinish: _onFragmentStreamingFinished,
  });
}

function _onFragmentStreamingFinished() {
  streamingFinished = true;
  streamingSources = [];
  setFragmentIsPlaying(false);
  _cancelFragmentSharedRaf();
  setFragmentCurrentTime(0);
  setFragmentPlayStartPosition(0);
  updateFragmentPlayButton();
  render();
}

// visibilitychange handler: pause rAF-driven UI updates when tab hidden
// (audio playback continues via WebAudio/WASAPI in background).
// Registered once per module; update fns stored for resume.
let _visibilityHandlerRegistered = false;
let _exclusiveUpdateFn = null;
let _sharedUpdateFn = null;

/**
 * 播放头循环「活性探针」—— 与主窗口 renderer/audioPlayback.js 同一套根因：
 * `getFragmentExclusiveRaf()` / `getFragmentPlayheadRaf()` 里有 id 不代表回调
 * 还会执行。窗口最小化时 Chromium 挂起已排队的回调，恢复后不保证重新派发，
 * 而 id 仍非空 → 「id 为空才重启」会跳过重启；短时间最小化反过来会把 id
 * 清成 null 但心跳还新鲜。两种都不能只看 id。
 *
 * 声音在 decibri 子进程（独占）/ WebAudio 音频线程（共享）里继续，
 * 只有播放头与时间码靠 rAF —— 卡住时表现为「有声、进度与时间永久冻结」。
 */
const LOOP_STALL_MS = 700;
const LOOP_WATCHDOG_INTERVAL_MS = 400;
let _lastExclusiveTickAt = 0;
let _lastSharedTickAt = 0;
let _loopWatchdogTimer = null;

function _cancelFragmentExclusiveRaf() {
  const raf = getFragmentExclusiveRaf();
  if (raf) {
    cancelAnimationFrame(raf);
    setFragmentExclusiveRaf(null);
  }
  // 取消 = 心跳归零。留着旧时间戳会让「id 空但心跳新鲜」的瞬间被误判成
  // 循环还活着，从而跳过重启。
  _lastExclusiveTickAt = 0;
}

function _cancelFragmentSharedRaf() {
  const raf = getFragmentPlayheadRaf();
  if (raf) {
    cancelAnimationFrame(raf);
    setFragmentPlayheadRaf(null);
  }
  _lastSharedTickAt = 0;
}

function _exclusiveLoopAlive(now) {
  return _lastExclusiveTickAt > 0 && (now - _lastExclusiveTickAt) < LOOP_STALL_MS;
}

function _sharedLoopAlive(now) {
  return _lastSharedTickAt > 0 && (now - _lastSharedTickAt) < LOOP_STALL_MS;
}

/** 独占循环停摆时重启；隐藏状态下不重启（那时本就该停，省电）。 */
function _resumeExclusiveIfStalled() {
  if (document.hidden) return false;
  if (!getFragmentIsPlaying() || !getFragmentUseExclusiveMode() || !_exclusiveUpdateFn) return false;
  // 活着 = 有 id 且最近真的跑过；只有 id（死 id）或只有心跳（刚被 cancel）
  // 都必须重启。
  const raf = getFragmentExclusiveRaf();
  if (raf && _exclusiveLoopAlive(Date.now())) return false;
  _cancelFragmentExclusiveRaf();
  // 乐观心跳：新帧最快要下一帧才跑，先占位避免同一毫秒内 visibility/focus
  // 与看门狗各重启一次（互相 cancel，白扔一帧）。
  _lastExclusiveTickAt = Date.now();
  setFragmentExclusiveRaf(requestAnimationFrame(_exclusiveUpdateFn));
  return true;
}

/** 共享模式（WebAudio）的同类自愈。 */
function _resumeSharedIfStalled() {
  if (document.hidden) return false;
  if (!getFragmentIsPlaying() || getFragmentUseExclusiveMode()) return false;
  // 等待推理（underrun 冻结）时循环是**故意**停的，由 chunk 回调/onFinish 恢复。
  if (_scheduler && _scheduler.isWaiting) return false;
  const raf = getFragmentPlayheadRaf();
  if (raf && _sharedLoopAlive(Date.now())) return false;
  _cancelFragmentSharedRaf();
  _lastSharedTickAt = Date.now(); // 乐观心跳，避免同毫秒多路同时重启
  // 首帧还没跑过时 _sharedUpdateFn 仍是 null（只在 tick 内赋值），此时用
  // 模块级导出函数起链——否则「首帧的 rAF 被丢弃」永远没有第二次机会。
  setFragmentPlayheadRaf(requestAnimationFrame(_sharedUpdateFn || updateFragmentPlayhead));
  return true;
}

/** 看门狗：rAF 之外的心跳，不依赖 visibilitychange 一定送达。 */
function _ensureLoopWatchdog() {
  if (_loopWatchdogTimer) return;
  _loopWatchdogTimer = setInterval(() => {
    if (!getFragmentIsPlaying() || document.hidden) return;
    if (getFragmentUseExclusiveMode()) _resumeExclusiveIfStalled();
    else _resumeSharedIfStalled();
  }, LOOP_WATCHDOG_INTERVAL_MS);
  if (typeof _loopWatchdogTimer?.unref === 'function') _loopWatchdogTimer.unref();
}

function _teardownLoopWatchdog() {
  if (_loopWatchdogTimer) {
    clearInterval(_loopWatchdogTimer);
    _loopWatchdogTimer = null;
  }
}

function _resumeLoopsIfNeeded() {
  if (document.hidden) return;
  if (getFragmentUseExclusiveMode()) _resumeExclusiveIfStalled();
  else _resumeSharedIfStalled();
}

function _onVisibilityChange() {
  if (document.hidden) {
    // 主动取消比让 Chromium 挂起更可靠：挂起的 id 会误导"循环还活着"。
    _cancelFragmentExclusiveRaf();
    _cancelFragmentSharedRaf();
    return;
  }
  _resumeLoopsIfNeeded();
}

function _onBeforeUnloadForVisibility() {
  if (_visibilityHandlerRegistered) {
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    window.removeEventListener('focus', _resumeLoopsIfNeeded);
    window.removeEventListener('pageshow', _resumeLoopsIfNeeded);
    _visibilityHandlerRegistered = false;
  }
  _teardownLoopWatchdog();
}

function _ensureVisibilityHandler() {
  if (_visibilityHandlerRegistered) return;
  _visibilityHandlerRegistered = true;
  document.addEventListener('visibilitychange', _onVisibilityChange);
  // 最小化恢复时 focus 比 visibilitychange 可靠（实测存在只发 blur/focus 的路径）
  window.addEventListener('focus', _resumeLoopsIfNeeded);
  window.addEventListener('pageshow', _resumeLoopsIfNeeded);
  window.addEventListener('beforeunload', _onBeforeUnloadForVisibility, { once: true });
}

function stopStreamingPlayback() {
  // 与主页面 stopPlayback 语义一致：设 streamingFinished=true 拦截已在事件队列中
  // 排队的 onChunkAudio 回调（IPC 监听器虽已移除，但已派发的回调仍可能到达）。
  // playFragment 开头会显式重置为 false 启动新一轮流式合成。
  streamingFinished = true;
  _streamingStarted = false;
  _streamingFirstChunkAudioOffset = 0;
  for (const src of streamingSources) {
    if (!src) continue;  // 已 onended 释放的中间 chunk 跳过
    safeCleanup('fragmentAudio.src.stop', () => { src.onended = null; src.stop(); });
  }
  streamingSources = [];
  if (streamingCleanup) {
    safeCleanup('fragmentAudio.streamingCleanup', streamingCleanup);
    streamingCleanup = null;
  }
  // 断开并释放流式 fade 增益节点
  if (streamingFadeGainNode) {
    safeCleanup('fragmentAudio.streamingFadeGain.disconnect', () => streamingFadeGainNode.disconnect());
    streamingFadeGainNode = null;
  }
  // 停止 scheduler：解除 AudioContext 冻结 + 取消 watchdog
  if (_scheduler) _scheduler.deactivate();
}

export async function getFragmentAudioContextInternal() {
  let ctx = getFragmentAudioContext();
  if (!ctx || ctx.state === 'closed') {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: getSampleRate() });
    setFragmentAudioContext(ctx);
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    setFragmentGainNode(gainNode);
    await applyFragmentAudioSettings();
  }
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  return ctx;
}

export async function loadFragmentAudioSettings() {
  try {
    const settings = await window.electronAPI.getSettings();
    setFragmentAudioSettings(settings);
    setFragmentUseExclusiveMode(settings?.audioOutputMode === 'exclusive');
  } catch (_e) {
    setFragmentAudioSettings({});
  }
}

async function applyFragmentAudioSettings() {
  const settings = getFragmentAudioSettings();
  if (!settings) return;

  const gainNode = getFragmentGainNode();
  if (gainNode && settings.audioVolume !== undefined) {
    gainNode.gain.value = settings.audioVolume;
  }

  const ctx = getFragmentAudioContext();
  if (ctx && settings.audioOutputDevice !== undefined && settings.audioOutputDevice !== -1) {
    const sinkId = String(settings.audioOutputDevice);
    if (ctx.setSinkId && typeof ctx.setSinkId === 'function') {
      try {
        await ctx.setSinkId(sinkId);
      } catch (err) {
        console.warn('[FragmentAudio] 设置输出设备失败:', err.message);
      }
    }
  }
}

export function stopFragmentPlayback() {
  // 用户主动停止：标记后合成完成时的兜底路径不会自动重新开播
  _streamingUserStopped = true;
  // 清理流式播放（边合成边播的 chunk sources）
  stopStreamingPlayback();
  const source = getFragmentAudioSource();
  if (source) {
    try {
      source.onended = null;
      source.stop();
    } catch (_e) {}
    setFragmentAudioSource(null);
  }
  stopFragmentExclusivePlayback();
  setFragmentIsPlaying(false);
  const raf = getFragmentPlayheadRaf();
  if (raf) {
    cancelAnimationFrame(raf);
    setFragmentPlayheadRaf(null);
  }
  updateFragmentPlayButton();
}

/**
 * 取消正在进行的推理（与主页面 stopPlayback 的"合成中取消"语义一致）。
 *
 * 分片编辑器此前只停本地音频、从不通知主进程：用户点停止后 GPU 仍会把整段
 * 推理跑完（长分片几十秒），期间按钮停在"合成中"且不可点，下一次播放被
 * `isSynthesizing` 的守卫静默挡住 —— 也就是"停止停不掉推理"。
 *
 * 与 stopFragmentPlayback 的分工：本函数只在**推理中**才有额外动作（通知主进程
 * 协作式取消 + 释放重入锁），普通"停播放"仍走 stopFragmentPlayback。
 *
 * @returns {boolean} 是否确实取消了在途推理
 */
export function cancelFragmentSynthesis() {
  if (!getFragmentIsSynthesizing()) return false;
  // 先置停止标记：拦截已排队的 chunk 回调、合成完成后的兜底播放，
  // 并让 catch 把 SYNTHESIS_CANCELLED 当成正常收尾而不是失败。
  _streamingUserStopped = true;
  _pendingSeekStartTime = null;
  // 代际自增：在途 playFragment 的 catch / finally 不再改动共享播放状态
  _playSessionSeq += 1;
  // 模型加载阶段不能发 cancel：主进程会落到"无活跃任务 → resetSvsPipeline()"，
  // 把正在初始化的 lazy 实例作废，下次播放要重新加载（与主页面同一守卫）。
  if (getPipelineInitialized() && window.electronAPI?.cancelSVSSynthesis) {
    window.electronAPI.cancelSVSSynthesis().catch(() => {});
  }
  // 立即放开重入锁：否则 IDLE 下按钮可点、playFragment 的 guard 却静默 return，
  // 用户看到的是"点了没反应"。旧会话会在最近的检查点退出。
  setFragmentIsSynthesizing(false);
  stopFragmentPlayback();
  updateFragmentPlayButton();
  return true;
}

/**
 * 播放中拖拽 playhead 时跳转到新位置。
 * 不重新合成：直接复用已缓存的 fragmentAudioData，从 newStartTime 开始播放。
 * 需要先停止当前播放（source.stop / audioStop），再用现有 audioData 重启。
 */
export async function seekFragmentPlayback(newStartTime) {
  // 合成进行中的拖拽：不能用旧缓存音频重启播放。
  // 流式合成期间 getFragmentAudioData 是上一次合成的旧音频，与新音符不匹配
  // （拖拽后立刻听到旧音频 → 与画布音符错位），且稍后合成完成时的兜底播放会
  // 与这里重启的播放叠加成双路音频（杂音/重叠）。改为只停止当前播放并记录
  // 新位置，合成完成后由 playFragment 的 _pendingSeekStartTime 分支从新位置
  // 播放新音频。
  if (getFragmentIsSynthesizing()) {
    stopFragmentPlayback();
    // stopFragmentPlayback 会置 _streamingUserStopped（拦截合成完成兜底），
    // 但 seek 语义仍期望合成完成后从新位置自动播放，这里复位该标记。
    _streamingUserStopped = false;
    // 丢弃后续 chunk：合成完成后统一从新位置整段播放，不再续播流式队列
    streamingFinished = true;
    setFragmentPlayStartPosition(newStartTime);
    setFragmentCurrentTime(newStartTime);
    _pendingSeekStartTime = newStartTime;
    render();
    return;
  }
  // 停止当前播放（不重置 playStartPosition）
  stopStreamingPlayback();
  const source = getFragmentAudioSource();
  if (source) {
    try { source.onended = null; source.stop(); } catch (_e) {}
    setFragmentAudioSource(null);
  }
  stopFragmentExclusivePlayback();
  setFragmentIsPlaying(false);
  const raf = getFragmentPlayheadRaf();
  if (raf) {
    cancelAnimationFrame(raf);
    setFragmentPlayheadRaf(null);
  }

  // 设置新的起始位置
  setFragmentPlayStartPosition(newStartTime);

  // 复用已缓存的 audioData 重启播放
  const audioData = getFragmentAudioData();
  if (!audioData || audioData.length === 0) {
    // 无可播音频：不能静默返回 —— 播放状态已停但视觉未更新，用户会以为
    // 点击无效。渲染一次让停止态立即生效。
    render();
    updateFragmentPlayButton();
    return;
  }

  if (getFragmentUseExclusiveMode()) {
    await playFragmentExclusive();
  } else {
    await playFragmentShared();
  }
}

function stopFragmentExclusivePlayback() {
  _cancelFragmentExclusiveRaf();
  // 在此统一退订 onAudioEnded：所有停止/暂停/跳转路径都经过本函数，
  // rAF 已被 cancel，不能再依赖 rAF 闭包退订。
  _detachFragmentEndedListener();
  window.electronAPI.audioStop().catch(() => {});
}

/**
 * Buffer underrun detection: when the playhead reaches the furthest received
 * audio position and inference is not yet complete, freeze the playhead.
 * Uses StreamingScheduler for AudioContext suspend/resume and state tracking.
 * Returns true when the wait state was entered (caller must stop its own loop).
 */
function _checkFragmentStreamingUnderrun() {
  if (!_streamingStarted || !_scheduler) return false;
  if (!getFragmentIsPlaying()) return false;
  const ctx = getFragmentAudioContext();
  if (!ctx) return false;
  // underrun 是"渲染域"事件（缓冲是否被吃空），必须与 watchdog 的 getElapsed
  // 同基准用 ctx.currentTime；不要换成可听时间（见 audioOutputClock 使用边界）。
  const elapsed = ctx.currentTime - getFragmentPlaybackStartTime();
  const curTime = getFragmentPlaybackOffset() + elapsed;
  return _scheduler.checkUnderrun(curTime, () => {
    // Freeze playhead at buffer frontier (not at elapsed which has already
    // advanced past the received audio into silence).
    setFragmentCurrentTime(_scheduler.bufferEndSec);
    const raf = getFragmentPlayheadRaf();
    if (raf) { cancelAnimationFrame(raf); setFragmentPlayheadRaf(null); }
    render();
  });
}

export function updateFragmentPlayhead() {
  _ensureVisibilityHandler();
  _sharedUpdateFn = updateFragmentPlayhead;
  if (!getFragmentIsPlaying()) return;
  // 活性心跳：看门狗与恢复逻辑据此判断循环是否真的在跑（rAF id 不算数）。
  _lastSharedTickAt = Date.now();
  const ctx = getFragmentAudioContext();
  if (!ctx) return;

  // 播放头取"耳朵听到的位置"：渲染时钟减去设备输出延迟（见 audioOutputClock）。
  const elapsed = getAudibleElapsedSec(ctx, getFragmentPlaybackStartTime());
  setFragmentCurrentTime(getFragmentPlaybackOffset() + elapsed);

  // Buffer underrun detection (see _checkFragmentStreamingUnderrun).
  // 窗口最小化时 rAF 会被挂起，由 StreamingScheduler.watchdog 兜底检测。
  if (_checkFragmentStreamingUnderrun()) return;

  // 流式播放期间跳过 duration 检查：
  // setFragmentAudioData 在 synthesizeFragmentSVS 返回后才更新，流式期间
  // getFragmentAudioData 返回上一次合成的旧 audioData，旧 duration 可能短于
  // 当前流式时长，导致 currentTime >= duration 误判并提前 stopFragmentPlayback。
  // 流式结束由 source.onended 计数判定触发，不依赖此处的 duration 检查。
  const audioData = getFragmentAudioData();
  if (audioData && !_streamingStarted) {
    const duration = audioData.length / getSampleRate();
    if (getFragmentCurrentTime() >= duration) {
      stopFragmentPlayback();
      setFragmentCurrentTime(0);
      setFragmentPlayStartPosition(0);
    }
  }

  render();

  setFragmentPlayheadRaf(requestAnimationFrame(updateFragmentPlayhead));
}

async function playFragmentShared() {
  const ctx = await getFragmentAudioContextInternal();
  const audioData = getFragmentAudioData();
  const audioBuffer = ctx.createBuffer(1, audioData.length, getSampleRate());
  audioBuffer.getChannelData(0).set(audioData);
  stopFragmentPlayback();
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;

  const envGainNode = ctx.createGain();
  const fadeGainNode = ctx.createGain();
  const panNode = ctx.createStereoPanner();

  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const audioDuration = audioData.length / getSampleRate();
  const envelopes = getEnvelopes();
  const volumeEnv = envelopes.volume;
  const panEnv = envelopes.pan;

  // 播放起始位置（秒），由用户拖拽 playhead 设置。加下界 0：
  // audioDuration - 0.01 可能为负（极短音频），会得到负的 start offset。
  const startOffset = Math.max(0, Math.min(getFragmentPlayStartPosition(), audioDuration - 0.01));

  if (volumeEnv && volumeEnv.keyframes && volumeEnv.keyframes.length > 0) {
    const now = ctx.currentTime;
    const sortedKfs = [...volumeEnv.keyframes].sort((a, b) => a.time - b.time);
    // 从 startOffset 处的包络值开始
    const startVal = _interpolateEnvValue(sortedKfs, startOffset);
    envGainNode.gain.setValueAtTime(startVal, now);
    for (let i = 0; i < sortedKfs.length; i++) {
      const kf = sortedKfs[i];
      const timeSec = (kf.time / bpm) * 60;
      if (timeSec > startOffset && timeSec <= audioDuration) {
        envGainNode.gain.linearRampToValueAtTime(kf.value, now + (timeSec - startOffset));
      }
    }
    const lastKf = sortedKfs[sortedKfs.length - 1];
    const lastTimeSec = (lastKf.time / bpm) * 60;
    if (lastTimeSec < audioDuration) {
      envGainNode.gain.linearRampToValueAtTime(lastKf.value, now + (audioDuration - startOffset));
    }
  }

  // Per-note 渐入/渐出（与导出时 wavEncoder.applyEnvelopesToAudio 一致）：
  // fadeGainNode 接在 envGainNode 之后、panNode 之前，作为片段级音量包络之外的
  // per-note amplitude 调制。仅当某 note 启用 fade 时才调度自动化，否则保持 1。
  // _scheduleFadeAutomation 会在每个 fadeOut 后恢复增益为 1，防止后续音符静音。
  const fades = _buildNoteFadesForRealtime(bpm);
  if (fades.length > 0) {
    _scheduleFadeAutomation(fadeGainNode, ctx, fades, startOffset);
  }

  if (panEnv && panEnv.keyframes && panEnv.keyframes.length > 0) {
    const now = ctx.currentTime;
    const sortedKfs = [...panEnv.keyframes].sort((a, b) => a.time - b.time);
    const startVal = _interpolateEnvValue(sortedKfs, startOffset);
    panNode.pan.setValueAtTime(startVal, now);
    for (let i = 0; i < sortedKfs.length; i++) {
      const kf = sortedKfs[i];
      const timeSec = (kf.time / bpm) * 60;
      if (timeSec > startOffset && timeSec <= audioDuration) {
        panNode.pan.linearRampToValueAtTime(kf.value, now + (timeSec - startOffset));
      }
    }
    const lastKf = sortedKfs[sortedKfs.length - 1];
    const lastTimeSec = (lastKf.time / bpm) * 60;
    if (lastTimeSec < audioDuration) {
      panNode.pan.linearRampToValueAtTime(lastKf.value, now + (audioDuration - startOffset));
    }
  }

  const gainNode = getFragmentGainNode();
  source.connect(envGainNode).connect(fadeGainNode).connect(panNode).connect(gainNode);
  source.onended = () => {
    // 每次播放新建的中间节点在此断开，避免自然结束后 env/fade/pan 三个节点
    // 仍挂在共享 gainNode 下随播放次数累积（stop() 路径会先置 onended=null，
    // 节点随 source 一起释放）。
    safeCleanup('fragmentAudio.panNode.disconnect', () => panNode.disconnect());
    safeCleanup('fragmentAudio.fadeGainNode.disconnect', () => fadeGainNode.disconnect());
    safeCleanup('fragmentAudio.envGainNode.disconnect', () => envGainNode.disconnect());
    setFragmentIsPlaying(false);
    const raf = getFragmentPlayheadRaf();
    if (raf) {
      cancelAnimationFrame(raf);
      setFragmentPlayheadRaf(null);
    }
    setFragmentCurrentTime(0);
    setFragmentPlayStartPosition(0);
    updateFragmentPlayButton();
    render();
  };
  // source.start(when, offset) — offset 是音频缓冲区内的时间偏移。
  // 时间基准取 start 前的 currentTime 并用 start(when) 精确对齐：start(0) 只
  // 保证"下一个渲染量子"（24 kHz 下 ≈5 ms），基准取 start 之后会让播放头略超前。
  const startAt = ctx.currentTime;
  source.start(startAt, Math.max(0, startOffset));
  setFragmentAudioSource(source);
  setFragmentIsPlaying(true);
  setFragmentPlaybackStartTime(startAt);
  setFragmentPlaybackOffset(startOffset);
  setFragmentCurrentTime(startOffset);
  updateFragmentPlayhead();
  updateFragmentPlayButton();
}

/**
 * 线性插值计算 envelope 在指定时间的值（用于播放起始偏移处的包络初始化）。
 * sortedKfs 必须已按 time 升序排序。time 单位为秒。
 */
function _interpolateEnvValue(sortedKfs, timeSec) {
  if (!sortedKfs || sortedKfs.length === 0) return 1;
  if (sortedKfs.length === 1) return sortedKfs[0].value;
  if (timeSec <= sortedKfs[0].time) return sortedKfs[0].value;
  if (timeSec >= sortedKfs[sortedKfs.length - 1].time) return sortedKfs[sortedKfs.length - 1].value;
  for (let i = 0; i < sortedKfs.length - 1; i++) {
    if (timeSec >= sortedKfs[i].time && timeSec <= sortedKfs[i + 1].time) {
      const t = (timeSec - sortedKfs[i].time) / (sortedKfs[i + 1].time - sortedKfs[i].time);
      return sortedKfs[i].value + t * (sortedKfs[i + 1].value - sortedKfs[i].value);
    }
  }
  return sortedKfs[sortedKfs.length - 1].value;
}

async function playFragmentExclusive() {
  stopFragmentPlayback();

  try {
    const settings = getFragmentAudioSettings();
    const rawAudioData = getFragmentAudioData();
    const audioDuration = rawAudioData.length / getSampleRate();
    // 播放起始位置（秒），由用户拖拽 playhead 设置
    const startOffset = Math.min(getFragmentPlayStartPosition(), audioDuration - 0.01);
    // 独占模式不经 WebAudio 图，无法用 gain 自动化应用 per-note fade。
    // 在传入 audioPlay 前对音频数据预乘 fade gain（与导出路径逻辑一致）。
    const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
    const audioData = _applyFadesToMonoAudio(rawAudioData, bpm);
    const options = {
      deviceId: settings?.audioOutputDevice ?? -1,
      sampleRate: settings?.audioSampleRate ?? getSampleRate(),
      sourceSampleRate: getSampleRate(),
      channels: 1,
      bitDepth: settings?.audioBitDepth ?? 'float32',
      bufferSize: settings?.audioBufferSize ?? 1024,
      exclusiveMode: true,
      volume: settings?.audioVolume ?? 1.0,
      offset: Math.max(0, startOffset),
    };

    const result = await window.electronAPI.audioPlay(audioData, options);

    if (!result.success) {
      console.warn('[FragmentAudio] WASAPI 独占模式失败，回退到共享模式:', result.error);
      setFragmentUseExclusiveMode(false);
      await playFragmentShared();
      return;
    }

    setFragmentIsPlaying(true);
    setFragmentPlaybackStartTime(performance.now());
    setFragmentPlaybackOffset(startOffset);
    setFragmentCurrentTime(startOffset);

    // 先退订上一轮可能泄漏的监听，再注册新监听并存入模块级持有。
    _detachFragmentEndedListener();
    _fragmentRemoveEndedListener = window.electronAPI.onAudioEnded(() => {
      setFragmentIsPlaying(false);
      const raf = getFragmentPlayheadRaf();
      if (raf) {
        cancelAnimationFrame(raf);
        setFragmentPlayheadRaf(null);
      }
      setFragmentCurrentTime(0);
      setFragmentPlayStartPosition(0);
      updateFragmentPlayButton();
      render();
    });

    updateFragmentExclusivePlayhead(_detachFragmentEndedListener);
    updateFragmentPlayButton();
  } catch (err) {
    console.error('[FragmentAudio] 独占模式启动失败，回退到共享模式:', err);
    setFragmentUseExclusiveMode(false);
    await playFragmentShared();
  }
}

function updateFragmentExclusivePlayhead(removeEndedListener) {
  _ensureVisibilityHandler();
  function update() {
    _exclusiveUpdateFn = update;
    if (!getFragmentIsPlaying()) {
      if (removeEndedListener) removeEndedListener();
      return;
    }

    const elapsed = (performance.now() - getFragmentPlaybackStartTime()) / 1000 + getFragmentPlaybackOffset();
    const audioData = getFragmentAudioData();
    const duration = audioData ? audioData.length / getSampleRate() : 0;

    if (elapsed >= duration) {
      setFragmentIsPlaying(false);
      setFragmentCurrentTime(0);
      setFragmentPlayStartPosition(0);
      stopFragmentExclusivePlayback();
      const raf = getFragmentPlayheadRaf();
      if (raf) {
        cancelAnimationFrame(raf);
        setFragmentPlayheadRaf(null);
      }
      updateFragmentPlayButton();
      render();
      if (removeEndedListener) removeEndedListener();
      return;
    }

    setFragmentCurrentTime(elapsed);
    render();
    setFragmentExclusiveRaf(requestAnimationFrame(update));
  }

  _exclusiveUpdateFn = update;
  setFragmentExclusiveRaf(requestAnimationFrame(update));
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
  // F2：取 min(start) —— getClippedNotes 现已排序，但这里仍显式求最小值，
  // 避免未来改动排序规则时又退化成"首元素假设"。
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
 * 与服务端 AudioSegmentation.hashArray（src/inference/pipeline/audioSegmentation.js）
 * 语义一致的 FNV-1a 32-bit 哈希：短数组（≤2000 元素）全量、长数组 2000 采样 +
 * 尾部补偿 + 长度折叠，float64 字节展开保留小数编辑。
 *
 * 算法本体已移到 src/shared/hashSignature.js，三处消费方（主进程合成缓存键、
 * 主窗口播放签名、本文件预览签名）调同一个函数，不再依赖"改一处记得改另一处"。
 * 保留 _hashArrayFNV 这个名字是因为本文件有十来个调用点，改名没有收益。
 */
function _hashArrayFNV(arr) {
  return hashNumberArray(arr);
}

/**
 * 计算当前 fragment 合成输入的签名（notes + 选项）。
 * 与服务端 computeSynthCacheKey 覆盖的字段一致：notes 内容、bpm、pitchCurveF0、
 * refAudioWavBuffer 内容、autoShift、nSteps、cfg、cfgRescale、singerId。
 * 用于判断 fragmentAudioData 是否可复用，避免重复 IPC 合成调用。
 * 注意：签名不包含 playStartPosition — 起始位置变化不影响音频内容。
 */
/**
 * 下发给管线的音高来源。
 *
 * score 时 pitchCurveF0 已经是 null（buildPitchCurveF0Data 里直接返回），
 * 这里再带一个显式标记 —— 否则管线分不清"没有曲线"和"要 score"，
 * 会把 note.pitch 填成逐音符恒定的平直 F0 再喂给模型。
 */
function currentPitchControl() {
  return isScorePitchMode() ? 'score' : 'manual';
}

export function computeFragmentAudioSignature() {
  const notes = getClippedNotes();
  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const previewOpts = getFragmentPreviewInferenceOptions();
  // 签名只需要"输入变了"的哈希：F0 后处理链的结果已由下方 ppHash（曲线序列化）
  // 单独覆盖，这里跳过整条滤波（400ms 自动推理轮询会反复调用本函数，
  // 长分片实测每次 7–15ms），真正的合成路径（playFragment 等）仍走完整后处理。
  const pitchCurveF0 = buildPitchCurveF0Data({ postprocess: false });
  const refAudioWavBuffer = getWavFileBuffer();
  const autoShiftEl = document.getElementById('autoShiftCheck');
  const autoShift = autoShiftEl ? autoShiftEl.checked : false;
  const singerId = getCurrentFragment()?.singerId || null;

  // notes hash — 与服务端 computeSynthCacheKey 保持一致的字段拼接
  // （含 noteType：3=连音。MIDI 导入的连音音符只带 noteType、没有 isSlur 标志，
  //   漏掉它会"签名没变"→ 不重新合成，连音改动听不出来。）
  let notesHash = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    let s = `${n.lyric || ''}|${n.pitch}|${n.start}|${n.duration}|${n.isSlur ? 1 : 0}|${n.isContinuation ? 1 : 0}|t${n.noteType || 0}`;
    if (n.phonemeAdjustments) {
      for (const adj of n.phonemeAdjustments) {
        s += `|dr:${adj.durationRatio}|or:${adj.offsetRatio || 0}`;
        if (adj.volumePoints) {
          for (const vp of adj.volumePoints) {
            s += `:${vp.t}:${vp.v}`;
          }
        }
      }
    }
    // 颤音字段进入签名：颤音改变 F0，必须重新合成
    if (n.vibrato && n.vibrato.enabled) {
      s += `|vib:${n.vibrato.enabled ? 1 : 0}:${n.vibrato.depth}:${n.vibrato.rate}:${n.vibrato.start}:${n.vibrato.length}:${n.vibrato.fadeIn}`;
    }
    for (let j = 0; j < s.length; j++) {
      notesHash = ((notesHash << 5) - notesHash + s.charCodeAt(j)) | 0;
    }
  }

  // pitchCurveF0 hash — FNV-1a，与服务端 hashArray 一致（消除下采样盲区）
  const f0Hash = pitchCurveF0 ? _hashArrayFNV(pitchCurveF0) : 0;

  // 音色 / 后处理曲线 hash：F0 平滑已体现在 f0Hash 里，但频谱后处理
  // （mel 平滑 / 过渡插值）不改变 F0，必须单独进签名，否则改曲线后仍播旧音频。
  let ppHash = 0;
  const ppSignature = serializePostprocessForSignature();
  for (let i = 0; i < ppSignature.length; i++) {
    ppHash = ((ppHash << 5) - ppHash + ppSignature.charCodeAt(i)) | 0;
  }

  // refAudioWavBuffer hash — FNV-1a 全量采样 + 长度折叠，与服务端一致。
  // 旧实现仅用 byteLength：换同长度参考音频时签名不变，会直接播旧音频。
  let refHash = 0;
  if (refAudioWavBuffer) {
    const refBytes = refAudioWavBuffer instanceof ArrayBuffer
      ? new Uint8Array(refAudioWavBuffer)
      : refAudioWavBuffer;
    refHash = _hashArrayFNV(refBytes);
  }

  // prompt cond 由 singerData + midiNotes + f0Data 三者共同决定；使用与服务端
  // 缓存键相同的签名实现，避免任何一份标注变化后仍复用旧 fragmentAudioData。
  const singerAnn = getSingerAnnotation() || {};
  const promptHash = hashString(computePromptCondSignature(
    singerAnn.singerData,
    singerAnn.midiNotes,
    singerAnn.f0Data,
    undefined
  ));

  // 音高来源也必须进签名：manual 空曲线（平直 F0）与 score（f0 条件全 0）都
  // 产出 pitchCurveF0=null、f0Hash 都是 0，只靠曲线哈希区分不出来 —— 切模式后
  // 会命中上一模式的音频，听起来像"切换没生效"。
  const pitchControl = currentPitchControl();
  return `${notesHash}_${bpm}_${f0Hash}_${refHash}_p${promptHash}_${previewOpts.nSteps}_${previewOpts.cfg}_${previewOpts.cfgRescale}_${autoShift}_${singerId || 'noid'}_${previewOpts.diffStepChunk ? 1 : 0}_${previewOpts.diffStepChunkFrames || 500}_${previewOpts.diffStepOverlapFrames !== undefined ? previewOpts.diffStepOverlapFrames : 50}_pp${ppHash}_${pitchControl}`;
}

export async function playFragment() {
  // 重入保护：防止连续调用导致前一次 finally 提前把 fragmentIsSynthesizing
  // 置 false，使后续进度回调失效（进度百分比偶发不显示的根因之一）。
  if (getFragmentIsSynthesizing() || getFragmentIsExporting()) return;
  // 本次播放的会话号：取消推理 / 新一轮播放会让它失效（见 _playSessionSeq）。
  const mySession = ++_playSessionSeq;
  setFragmentIsSynthesizing(true);
  updateFragmentPlayButton();
  // 清理上一次流式播放状态
  stopStreamingPlayback();
  streamingFinished = false;
  streamingSources = [];
  streamingNextStart = 0;
  _streamingStarted = false;
  _streamingFirstChunkAudioOffset = 0;
  _streamingUserStopped = false;
  _pendingSeekStartTime = null;
  _createFragmentScheduler();

  try {
    if (!getPipelineInitialized()) {
      await initPipeline();
    }

    await loadFragmentAudioSettings();

    // 缓存优化：计算当前合成输入签名，若与上次相同且已有 fragmentAudioData，
    // 直接复用缓存音频从 playStartPosition 开始播放，跳过 IPC 合成调用。
    // 这样即使起始位置不同，只要 notes/options 未变就能秒播。
    const currentSignature = computeFragmentAudioSignature();
    const cachedAudio = getFragmentAudioData();
    const canReuseCache = cachedAudio && cachedAudio.length > 0 &&
                         getFragmentAudioDataSignature() === currentSignature;

    if (canReuseCache) {
      // 复用缓存：无需注册 chunk 监听，直接整段播放
      setFragmentUseExclusiveMode(getFragmentAudioSettings()?.audioOutputMode === 'exclusive');
      if (getFragmentUseExclusiveMode()) {
        await playFragmentExclusive();
      } else {
        await playFragmentShared();
      }
      return;
    }

    // 注册 chunk 监听：vocoder 每完成一个 chunk 即开始播放（边合成边播）。
    // IPC 按发送顺序派发，但回调体内有 await（getFragmentAudioContextInternal /
    // resumeFromWait 会让出事件循环）——若并发执行，chunk B 可能在 chunk A 更新
    // streamingNextStart 之前基于同一个值调度 → 音频错序/重叠（underrun 恢复
    // 瞬间的高危竞态）。用 promise 链串行化：每个 chunk 完整处理完才处理下一个。
    const handleStreamingChunk = async (chunkInfo) => {
      try {
        if (!chunkInfo || !chunkInfo.audio || chunkInfo.audio.length === 0) return;
        if (streamingFinished) return;
        const ctx = await getFragmentAudioContextInternal();
        if (streamingFinished) return; // re-check after async: may have been stopped

        // 第一个 chunk 初始化播放：计算首音符偏移和播放起始位置
        // chunk 音频从 filledNotes[0].start（首音符起点）开始，pipeline 已截掉前导休止符。
        // 需要让播放头从 playStartPosition 开始移动，而非直接跳到 firstNoteStartSec。
        if (!_streamingStarted) {
          _streamingStarted = true;
          const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
          const clippedNotes = getClippedNotes();
          const firstNoteStartSec = clippedNotes.length > 0
            ? (firstNoteStart(clippedNotes) / bpm) * 60
            : 0;
          const playStartPosition = getFragmentPlayStartPosition();

          // chunk 音频从 firstNoteStartSec 开始，播放头从 playStartPosition 开始：
          // - playStartPosition < firstNoteStartSec：延迟 chunk 播放，让播放头先走完
          //   前导静音段，到达 firstNoteStartSec 时音频正好开始。
          // - playStartPosition > firstNoteStartSec：跳过 chunk 内前导音频（下方处理）。
          let chunkDelaySec = 0;
          if (playStartPosition < firstNoteStartSec) {
            chunkDelaySec = firstNoteStartSec - playStartPosition;
          } else if (playStartPosition > firstNoteStartSec) {
            _streamingFirstChunkAudioOffset = playStartPosition - firstNoteStartSec;
          }
          streamingNextStart = ctx.currentTime + 0.05 + chunkDelaySec;

          // per-note fade：atSec 是相对 fragment 起点的绝对时间，
          // startOffset 传 playStartPosition 使起播位置之前的 fade 事件被跳过。
          const fades = _buildNoteFadesForRealtime(bpm);
          if (fades.length > 0) {
            streamingFadeGainNode = ctx.createGain();
            const masterGain = getFragmentGainNode();
            if (masterGain) streamingFadeGainNode.connect(masterGain);
            else streamingFadeGainNode.connect(ctx.destination);
            _scheduleFadeAutomation(streamingFadeGainNode, ctx, fades, playStartPosition);
          }
          setFragmentIsPlaying(true);
          setFragmentPlaybackStartTime(ctx.currentTime + 0.05);
          setFragmentPlaybackOffset(playStartPosition);
          setFragmentCurrentTime(playStartPosition);
          updateFragmentPlayButton();
          // 启动 playhead rAF 动画循环
          updateFragmentPlayhead();
          // 启动后台 watchdog：窗口最小化时 rAF 挂起，需用定时器兜底
          // 检测 buffer underrun，保证等待推理在后台同样生效。
          _scheduler.activate();
        }

        // 处理 playStartPosition > firstNoteStartSec：跳过 chunk 前导音频
        let chunkAudio = chunkInfo.audio;
        if (_streamingFirstChunkAudioOffset > 0) {
          const skipSec = Math.min(_streamingFirstChunkAudioOffset, chunkAudio.length / getSampleRate());
          const skipSamples = Math.floor(skipSec * getSampleRate());
          if (skipSamples >= chunkAudio.length) {
            // 整个 chunk 都在跳过范围内：不创建 source，减少剩余偏移后跳过此 chunk
            _streamingFirstChunkAudioOffset -= chunkAudio.length / getSampleRate();
            // 仍需处理 isLast 标记
            if (chunkInfo.isLast && _scheduler) {
              _scheduler.markLastReceived();
            }
            return;
          }
          chunkAudio = chunkAudio.subarray(skipSamples);
          _streamingFirstChunkAudioOffset = 0;
        }

        const audioBuffer = ctx.createBuffer(1, chunkAudio.length, getSampleRate());
        audioBuffer.getChannelData(0).set(chunkAudio);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const effectiveChunkDuration = chunkAudio.length / getSampleRate();

        // Buffer underrun recovery（顺序调度 + 时间基准重置设计）：
        // - 等待推理恢复：AudioContext 解冻，共享时钟（playbackStartTime）不变。
        //   watchdogMarginSec=0.3 使冻结点落在前沿之前，chunk 的原始调度时间
        //   仍在未来 → 直接按原位无缝衔接，无需任何调整。
        // - 迟到 chunk：调度时间已过 → 钳到当前时刻，并把时间基准同步前移，
        //   让播放头与音频一起回退 δ 秒。后续 chunk 排在本次之后
        //   （streamingNextStart += dur），无重叠、无内容丢失。
        //
        // 顺序纪律（务必保留）：**先排程 + 推进前沿，最后才解除等待**。
        // 旧实现先 resumeFromWait 再重启播放头，重启的 rAF 立刻用**旧**前沿判定
        // underrun（此时 curTime 正好停在前沿上）→ 刚解冻的 context 又被 suspend，
        // 新 chunk 虽然 start() 了却始终不出声：第一段之后整段静音（长分片尤其明显）。
        const wasWaiting = !!(_scheduler && _scheduler.isWaiting);
        if (streamingNextStart < ctx.currentTime + 0.01) {
          // Late chunk: clamp scheduling time to now, adjust time base.
          const offsetFromPlayStart = streamingNextStart - getFragmentPlaybackStartTime();
          setFragmentPlaybackStartTime(ctx.currentTime + 0.05 - offsetFromPlayStart);
          streamingNextStart = ctx.currentTime + 0.05;
        }

        // Update buffer frontier (furthest audio end in playhead seconds)
        const chunkEndSec = (getFragmentPlaybackOffset() + (streamingNextStart - getFragmentPlaybackStartTime())) + effectiveChunkDuration;
        if (_scheduler) _scheduler.updateBufferFrontier(chunkEndSec);

        // chunk source 经 streamingFadeGainNode（如有）连接到 master gain，
        // 使流式播放也应用 per-note fade。无 fade 时直接连 master gain。
        if (streamingFadeGainNode) {
          source.connect(streamingFadeGainNode);
        } else {
          const gainNode = getFragmentGainNode();
          if (gainNode) source.connect(gainNode);
          else source.connect(ctx.destination);
        }
        source.start(streamingNextStart);
        streamingNextStart += effectiveChunkDuration;

        // 解除推理等待：前沿已覆盖本 chunk，此时重启 rAF 不会再次触发 underrun。
        if (wasWaiting && _scheduler) {
          await _scheduler.resumeFromWait();
          // 幂等守卫防止与残留循环叠加成双 rAF 链。
          if (getFragmentIsPlaying() && !getFragmentPlayheadRaf()) {
            updateFragmentPlayhead();
          }
        }

        // Unified onended: decrement active source count and release reference.
        // When isLast has been received AND all sources have ended, mark
        // streaming complete. This is more robust than relying solely on the
        // isLast chunk's onended — if a non-last chunk (longer audio) is still
        // playing when the isLast chunk ends, we correctly wait for it.
        if (_scheduler) _scheduler.addSource();
        if (chunkInfo.isLast && _scheduler) {
          _scheduler.markLastReceived();
        }
        const sourceIdx = streamingSources.length;
        streamingSources.push(source);
        source.onended = () => {
          if (_scheduler) _scheduler.sourceEnded();
          if (streamingSources[sourceIdx] === source) {
            streamingSources[sourceIdx] = null;
          }
        };
      } catch (e) {
        console.warn('[FragmentAudio] Streaming chunk playback failed:', e.message);
      }
    };
    let chunkQueue = Promise.resolve();
    streamingCleanup = window.electronAPI.onFragmentSVSChunkAudio((chunkInfo) => {
      chunkQueue = chunkQueue
        .then(() => handleStreamingChunk(chunkInfo))
        .catch((e) => console.warn('[FragmentAudio] Streaming chunk queue error:', e && e.message));
    });

    const pitchCurveF0 = buildPitchCurveF0Data();
    const pitchCurveF0Serializable = pitchCurveF0 || null;

    const previewOpts = getFragmentPreviewInferenceOptions();

    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes: getClippedNotes(),
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: attachPluginBackend({
        f0Envelope: null,
        pitchCurveF0: pitchCurveF0Serializable,
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
        diffStepChunk: previewOpts.diffStepChunk,
        diffStepChunkFrames: previewOpts.diffStepChunkFrames,
        diffStepOverlapFrames: previewOpts.diffStepOverlapFrames,
        cfgScheduleMode: previewOpts.cfgScheduleMode,
        cfgStrengthStart: previewOpts.cfgStrengthStart,
        cfgScheduleKeyframes: previewOpts.cfgScheduleKeyframes,
        dynamicThresholdEnabled: previewOpts.dynamicThresholdEnabled,
        dynamicThresholdPercentile: previewOpts.dynamicThresholdPercentile,
        // 频谱后处理（时频平滑 / 过渡频谱插值）：逐帧参数在主进程 vocoder 之前应用。
        // 未启用时 buildMelPostprocessPayload 返回 null，管线走零开销快路径。
        melPostprocess: buildMelPostprocessPayload(
          getClippedNotes(),
          getCurrentProject() ? getCurrentProject().bpm : 120,
          getSampleRate(),
          480,
        ),
      }),
    });
    // 会话已被取消/取代（用户点了停止）：结果作废，不写入缓存也不开播。
    if (mySession !== _playSessionSeq) return;
    setFragmentAudioData(padAudioToFragmentDuration(audioData));
    // 合成成功后更新签名，后续播放可复用此缓存
    setFragmentAudioDataSignature(currentSignature);

    // 合成期间用户拖拽了播放头（seekFragmentPlayback 的合成中分支）：
    // 流式播放已停止、后续 chunk 已丢弃，这里直接从新位置开始播放新音频。
    // 若拖拽后用户又点了停止（_streamingUserStopped），则不再自动播放。
    if (_pendingSeekStartTime !== null && !_streamingUserStopped) {
      const seekPos = _pendingSeekStartTime;
      _pendingSeekStartTime = null;
      if (_scheduler) await _scheduler.setInferenceDone();
      if (streamingCleanup) {
        safeCleanup('fragmentAudio.streamingCleanup', streamingCleanup);
        streamingCleanup = null;
      }
      setFragmentPlayStartPosition(seekPos);
      setFragmentUseExclusiveMode(getFragmentAudioSettings()?.audioOutputMode === 'exclusive');
      if (getFragmentUseExclusiveMode()) {
        await playFragmentExclusive();
      } else {
        await playFragmentShared();
      }
      return;
    }

    // 标记推理完成：后续不再触发 buffer underrun 等待
    if (_scheduler) await _scheduler.setInferenceDone();

    // 仅当合成返回时正处于 underrun 冻结（最后一批 chunk 已收到但 playhead 仍冻结），
    // 才重置时间基准使 playhead 从 buffer 前沿继续。
    // 修复：旧逻辑无条件重置 playbackStartTime —— 当推理快于播放（buffer 前沿远超
    // 播放头）时，会把播放头直接拉到前沿，造成播放头与声音脱节（声画错位）。
    if (_streamingStarted && _scheduler && _scheduler.isWaiting) {
      const ctx = getFragmentAudioContext();
      if (ctx) {
        setFragmentPlaybackStartTime(ctx.currentTime - _scheduler.bufferEndSec + getFragmentPlaybackOffset());
        updateFragmentPlayhead();
      }
    }

    // 移除 chunk 监听（避免内存泄漏），但保留已调度的 source 继续播放。
    // 注意：必须在 inferenceDone 设置之后移除，否则 underrun 检测
    // 仍会等待（推理未完成标记）。
    // 先让出一轮宏任务：主进程的 chunk 事件与 invoke 的返回值走不同通道，
    // 合成结果可能先于最后几个 chunk 到达渲染进程。立即摘监听会把仍在队列里的
    // chunk 永久丢弃 —— 表现为"前面有声音、后面整段静音"（与主页面 playAll 同一处理）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (streamingCleanup) {
      safeCleanup('fragmentAudio.streamingCleanup', streamingCleanup);
      streamingCleanup = null;
    }

    // 如果流式播放从未启动（如缓存命中或单 chunk 未触发回调），回退到整段播放。
    // 使用 _streamingStarted 而非 streamingSources.length 判断，避免异步竞态：
    // chunk 回调可能还在 await getFragmentAudioContextInternal() 中尚未 push source，
    // 但 _streamingStarted 已在第一个 chunk 到达时设置为 true。
    // 修复：用户已主动停止（_streamingUserStopped）或当前仍在播放时不再兜底开播，
    // 避免"点停止 → 合成完成 → 又自动开始播放"与双路音频叠加（杂音/错位）。
    if (!_streamingStarted && !_streamingUserStopped && !getFragmentIsPlaying()) {
      setFragmentUseExclusiveMode(getFragmentAudioSettings()?.audioOutputMode === 'exclusive');
      if (getFragmentUseExclusiveMode()) {
        await playFragmentExclusive();
      } else {
        await playFragmentShared();
      }
    }
  } catch (error) {
    // 已被取消 / 已被新一轮播放接管：这是正常收尾，不是失败。
    // 既不能弹"合成失败"，也不能停掉新一轮刚排好的音频。
    if (mySession !== _playSessionSeq) return;
    const msg = String((error && error.message) || '');
    // 协作式取消（主进程 SYNTHESIS_CANCELLED / 被新请求取代）不是错误。
    const cancelled = /cancel|superseded|abort/i.test(msg);
    if (cancelled) {
      console.log('[FragmentAudio] Synthesis cancelled');
    } else {
      console.error(t('fragment.synthesisFailed') + ':', error);
      // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
      showAlertDialog(t('fragment.synthesisFailedDetail', { detail: error.message }));
    }
    stopStreamingPlayback();
    // stopStreamingPlayback 只清理流式资源，不重置播放状态。异常路径若不补这些
    // 清理，会留下 isPlaying=true + audioData 为空的组合：后续 seek/点击走空
    // 分支静默 return 且无渲染，播放头完全不动（"点击无响应"的根因之一）；
    // rAF 残留也会持续空转。
    setFragmentIsPlaying(false);
    const raf = getFragmentPlayheadRaf();
    if (raf) { cancelAnimationFrame(raf); setFragmentPlayheadRaf(null); }
    updateFragmentPlayButton();
  } finally {
    // 只有"当前会话"才允许收尾：取消后用户可能已经开了新一轮播放，
    // 旧会话在这里把 isSynthesizing 置 false 会把新一轮的重入锁拆掉。
    if (mySession === _playSessionSeq) {
      setFragmentIsSynthesizing(false);
      // 合成流程结束（成功或失败）后清除待跳转标记，避免残留影响下一次播放
      _pendingSeekStartTime = null;
      updateFragmentPlayButton();
    }
  }
}

/**
 * 后台静默合成：只重算音频并写入 fragmentAudioData，不播放、不弹错误对话框。
 * 供"编辑后自动实时推理"（设置项 autoRealtimeInference）使用。
 *
 * 与已有分段缓存的协同（关键）：
 *   - 主进程 OnnxSVSPipeline 的多 segment 路径用 _computeSegmentCacheKey 为每个
 *     segment 计算缓存键（notes/bpm/f0/ref/singerId/步数/segStartBeat/segF0Shift），
 *     未改动的 segment 直接 _segCacheGet 命中、跳过 diffusion+vocoder。
 *   - 因此这里刻意不调用任何清缓存操作；每次自动推理实际只会重算被用户改动的那几个
 *     分段，其余分段零成本复用。
 *   - options.priorityTimeSec 传入播放进度条位置，告诉主进程优先从哪个 segment 开始
 *     推理（缺失时主进程退化为"第一个未命中缓存的分段"）。
 *
 * @param {{priorityTimeSec?: number}} [opts] priorityTimeSec：相对分片起点的秒数
 * @returns {Promise<'ok'|'skip'|'error'>} ok = 完成了一次推理；skip = 主动放弃（前台忙 /
 *          内容无变化 / 结果过期），可立即重试；error = 推理本身失败，需要冷却
 */
export async function synthesizeFragmentInBackground(opts = {}) {
  // 与手动合成/播放/导出互斥：前台正在做事时不插队。
  if (getFragmentIsPlaying() || getFragmentIsSynthesizing() || getFragmentIsExporting()) return 'skip';
  // 已有后台任务在跑：本次改动会被它结束时再次检测到的新签名覆盖，直接跳过。
  if (getFragmentIsAutoInferring()) return 'skip';

  const notes = getClippedNotes();
  if (!notes || notes.length === 0) return 'skip';

  // 只有已经合成过（存在旧预览音频）时"改动"才有意义。首次预览仍由用户手动点击播放
  // 触发，避免刚打开分片什么都没做就后台跑一整次推理。
  if (getFragmentAudioDataSignature() === null) return 'skip';

  const currentSignature = computeFragmentAudioSignature();
  if (currentSignature === getFragmentAudioDataSignature()) return 'skip';

  setFragmentIsAutoInferring(true);
  updateFragmentPlayButton();
  try {
    if (!getPipelineInitialized()) {
      await initPipeline();
    }
    await loadFragmentAudioSettings();

    // 异步间隙里状态可能已变（用户按下播放 / 又开始导出 / 内容被再次修改）：
    // 一律放弃本次后台推理，让下一次检测重新决策。
    if (getFragmentIsPlaying() || getFragmentIsSynthesizing() || getFragmentIsExporting()) return 'skip';
    if (computeFragmentAudioSignature() !== currentSignature) return 'skip';

    const pitchCurveF0 = buildPitchCurveF0Data();
    const previewOpts = getFragmentPreviewInferenceOptions();

    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes,
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: attachPluginBackend({
        // 后台推理：主进程不下发流式 chunk，避免无意义的分片间 IPC 拷贝
        background: true,
        f0Envelope: null,
        pitchCurveF0: pitchCurveF0 || null,
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
        diffStepChunk: previewOpts.diffStepChunk,
        diffStepChunkFrames: previewOpts.diffStepChunkFrames,
        diffStepOverlapFrames: previewOpts.diffStepOverlapFrames,
        cfgScheduleMode: previewOpts.cfgScheduleMode,
        cfgStrengthStart: previewOpts.cfgStrengthStart,
        cfgScheduleKeyframes: previewOpts.cfgScheduleKeyframes,
        dynamicThresholdEnabled: previewOpts.dynamicThresholdEnabled,
        dynamicThresholdPercentile: previewOpts.dynamicThresholdPercentile,
        melPostprocess: buildMelPostprocessPayload(
          notes,
          getCurrentProject() ? getCurrentProject().bpm : 120,
          getSampleRate(),
          480,
        ),
        // 优先推理：播放进度条所在分段（0 = 交给主进程按"第一个改动分段"决定）
        priorityTimeSec: Number.isFinite(opts.priorityTimeSec) ? opts.priorityTimeSec : 0,
      }),
    });

    // 推理期间状态可能已变：
    //   - 内容被再次改动 → 结果已过期，丢弃（稍后会再次触发）
    //   - 用户手动播放已开始 → 交给 playFragment 自己写入，避免并发覆盖流式状态
    if (computeFragmentAudioSignature() !== currentSignature) return 'skip';
    if (getFragmentIsPlaying() || getFragmentIsSynthesizing()) return 'skip';

    setFragmentAudioData(padAudioToFragmentDuration(audioData));
    setFragmentAudioDataSignature(currentSignature);
    console.log('[FragmentAudio] Background inference done (preview audio refreshed)');
    return 'ok';
  } catch (error) {
    // 取消/被取代不算推理失败：SVS_SUPERSEDED（worker 端排队期间被更新请求
    // 取代）与 SYNTHESIS_CANCELLED（协作式取消安全点抛出）都是主动放弃，
    // 归为 'skip' —— 归为 'error' 会误触发 15 秒冷却，冷却期间用户的编辑
    // 不再自动推理。error.code 可能经 IPC 序列化丢失，同时匹配消息文本兜底。
    const code = (error && error.code) || '';
    const msg = (error && error.message) || '';
    const isCancelled = code === 'SVS_SUPERSEDED' || code === 'SYNTHESIS_CANCELLED'
      || /superseded|cancelled|canceled|abort/i.test(msg);
    if (isCancelled) return 'skip';
    // 后台失败不打扰用户：失败可能是模型缺失、显存不足等，
    // 下次手动播放会以正常路径报错提示。
    console.warn('[FragmentAudio] Background inference failed:', error && error.message);
    return 'error';
  } finally {
    setFragmentIsAutoInferring(false);
    updateFragmentPlayButton();
  }
}

export async function exportFragment() {
  // 重入保护：与 playFragment 互斥，避免合成/导出并发导致状态错乱
  if (getFragmentIsSynthesizing() || getFragmentIsExporting()) return;
  const btnExportFragment = document.getElementById('btn-export-fragment');
  const originalText = btnExportFragment.textContent;
  btnExportFragment.disabled = true;
  setLabel(btnExportFragment, t('fragment.exporting'), { icon: 'download' });
  setFragmentIsExporting(true);
  try {
    if (!getPipelineInitialized()) {
      await initPipeline();
    }

    await loadFragmentAudioSettings();

    const pitchCurveF0 = buildPitchCurveF0Data();
    const pitchCurveF0Serializable = pitchCurveF0 || null;

    const exportOpts = getFragmentExportInferenceOptions();

    const audioData = await window.electronAPI.synthesizeFragmentSVS({
      notes: getClippedNotes(),
      bpm: getCurrentProject() ? getCurrentProject().bpm : 120,
      options: attachPluginBackend({
        f0Envelope: null,
        pitchCurveF0: pitchCurveF0Serializable,
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
    // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
    showAlertDialog(t('fragment.exportFailedDetail', { detail: error.message }));
  } finally {
    setFragmentIsExporting(false);
    btnExportFragment.disabled = false;
    setLabel(btnExportFragment, originalText, { icon: 'download' });
  }
}
