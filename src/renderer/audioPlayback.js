import { state, dom, trackManager } from './state.js';
import { SAMPLE_RATE } from './constants.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { buildFragmentPitchCurveF0 } from './f0Utils.js';
import { formatTime } from './uiControls.js';
import { drawPlayheadLine, drawPausedPlayheadAt, clearPlayheadLine, playbackTimeToX, PLAYHEAD_HIT_WIDTH } from './timelineRenderer.js';

// visibilitychange handler: pause rAF-driven UI updates when tab hidden
// (audio playback continues via WebAudio/WASAPI in background).
// Registered once per module; update fns stored for resume.
let _visibilityHandlerRegistered = false;
let _exclusiveUpdateFn = null;
let _sharedUpdateFn = null;

function _ensureVisibilityHandler() {
  if (_visibilityHandlerRegistered) return;
  _visibilityHandlerRegistered = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.exclusivePlaybackRaf) {
        cancelAnimationFrame(state.exclusivePlaybackRaf);
        state.exclusivePlaybackRaf = null;
      }
      if (state.playheadRaf) {
        cancelAnimationFrame(state.playheadRaf);
        state.playheadRaf = null;
      }
    } else {
      if (state.isPlaying && state.useExclusiveMode && _exclusiveUpdateFn && !state.exclusivePlaybackRaf) {
        state.exclusivePlaybackRaf = requestAnimationFrame(_exclusiveUpdateFn);
      } else if (state.isPlaying && !state.useExclusiveMode && _sharedUpdateFn && !state.playheadRaf) {
        state.playheadRaf = requestAnimationFrame(_sharedUpdateFn);
      }
    }
  });
}

export async function ensurePipelineInitialized() {
  if (state.pipelineInitialized) return;
  if (state.pipelineInitPromise) {
    await state.pipelineInitPromise;
    return;
  }
  state.pipelineInitPromise = window.electronAPI.initSVSPipeline();
  try {
    await state.pipelineInitPromise;
    state.pipelineInitialized = true;
  } catch (err) {
    state.pipelineInitPromise = null;
    throw err;
  }
}

export async function playAll() {
  // 重入保护：防止连续调用导致前一次 finally 提前把 isSynthesizing 置 false，
  // 使后续进度回调失效（进度百分比偶发不显示的根因之一）。
  if (state.isSynthesizing) return;
  state.isSynthesizing = true;
  dom.btnPlay.disabled = true;
  dom.btnPlay.textContent = t('main.synthesizing');

  // 注册推理进度监听：更新按钮文本显示百分比（与分片编辑器对齐）
  let playProgressCleanup = null;
  try {
    playProgressCleanup = window.electronAPI.onSVSProgress((progress) => {
      if (state.isSynthesizing) {
        dom.btnPlay.textContent = t('main.synthesizingProgress', { progress });
      }
    });
  } catch (_) {}

  try {
    await loadAudioSettings();

    const fragments = trackManager.getFragments();
    const singers = trackManager.getSingers();
    const singerMap = new Map();
    singers.forEach(s => singerMap.set(s.id, s));

    // 收集所有有 notes 的 fragments，按 startTime 排序后逐个合成。
    // 复用分片编辑器的逻辑：每个 fragment 用相对 notes（clippedNotes）
    // + 该 fragment 自己的 pitchCurve（buildFragmentPitchCurveF0），
    // 确保与分片编辑器播放结果完全一致。
    const allFragments = fragments
      .filter(f => f.notes && f.notes.length > 0)
      .sort((a, b) => a.startTime - b.startTime);

    if (allFragments.length === 0) {
      showAlertDialog(t('main.noFragmentsToPlay'));
      return;
    }

    let globalFirstStart = Infinity;
    let globalLastEnd = 0;
    for (const f of allFragments) {
      if (f.startTime < globalFirstStart) globalFirstStart = f.startTime;
      const fragEnd = f.startTime + f.duration;
      if (fragEnd > globalLastEnd) globalLastEnd = fragEnd;
    }

    await ensurePipelineInitialized();

    const inferenceOpts = getPreviewInferenceOptions();

    if (inferenceOpts.diffStepChunk) {
      // === 流式合成路径 ===
      // 启用分块时使用 synthesizeMultiStreaming：按全局时间顺序交错推理各分片的 chunk，
      // 边推理边推送音频，实现多分片时间交错流式播放。
      // 示例：T1chunk1 → T2chunk1 → T1chunk2 → T2chunk2
      const multiFragments = [];
      for (const fragment of allFragments) {
        const singer = singerMap.get(fragment.singerId);
        if (!singer) continue;
        const fragDuration = fragment.duration;
        const clippedNotes = [];
        for (const note of fragment.notes) {
          if (note.start >= fragDuration) continue;
          const noteEnd = note.start + note.duration;
          if (noteEnd > fragDuration) {
            clippedNotes.push({ ...note, duration: fragDuration - note.start });
          } else {
            clippedNotes.push(note);
          }
        }
        if (clippedNotes.length === 0) continue;
        const pitchCurveF0 = buildFragmentPitchCurveF0(fragment, clippedNotes, state.project.bpm);
        multiFragments.push({
          notes: clippedNotes,
          startTimeBeat: fragment.startTime,
          durationBeats: fragment.duration,
          options: {
            f0Envelope: null,
            pitchCurveF0,
            refAudioWavBuffer: singer?.wavBuffer || null,
            refMidiNotes: singer?.midiNotes || null,
            refF0Data: singer?.f0Data || null,
            singerId: singer?.id || null,
            autoShift: dom.autoShiftCheck.checked,
            nSteps: inferenceOpts.nSteps,
            cfg: inferenceOpts.cfg,
            cfgRescale: inferenceOpts.cfgRescale,
            diffStepChunk: true,
            diffStepChunkFrames: inferenceOpts.diffStepChunkFrames,
            diffStepOverlapFrames: inferenceOpts.diffStepOverlapFrames,
          },
        });
      }

      if (multiFragments.length === 0) {
        showAlertDialog(t('main.noFragmentsToPlay'));
        return;
      }

      // 流式播放状态：仅在 playbackPauseOffset === 0 时启用流式播放。
      // 若用户已拖拽 playhead 设置了起始位置，则等合成完成后从该位置整段播放。
      const canStreamPlayback = state.playbackPauseOffset === 0;
      let streamingChunkCleanup = null;
      let streamingStarted = false;
      let streamingStartCtxTime = 0;
      state.streamingSources = [];
      state.streamingFinished = false;

      if (canStreamPlayback) {
        streamingChunkCleanup = window.electronAPI.onSVSChunkAudio(async (chunkInfo) => {
          try {
            if (!chunkInfo || !chunkInfo.audio || chunkInfo.audio.length === 0) return;
            if (state.streamingFinished) return;

            const ctx = getAudioContext();
            const audioBuffer = ctx.createBuffer(1, chunkInfo.audio.length, SAMPLE_RATE);
            audioBuffer.getChannelData(0).set(chunkInfo.audio);
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(state.gainNode);

            // 第一个 chunk 立即开始播放
            if (!streamingStarted) {
              streamingStarted = true;
              streamingStartCtxTime = ctx.currentTime + 0.05; // 50ms 延迟避免调度抖动
              state.playbackStartTime = streamingStartCtxTime;
              state.playbackPauseOffset = 0;
              state.isPlaying = true;
              startPlayheadAnimation();
            }

            // 按绝对时间调度：每个 chunk 在其全局时间位置播放，
            // 多分片同时段的 chunk 会叠加播放（而非顺序播放）
            const chunkStartSec = chunkInfo.sampleOffset / SAMPLE_RATE;
            const scheduleTime = streamingStartCtxTime + chunkStartSec;
            const minTime = ctx.currentTime + 0.01;
            source.start(Math.max(scheduleTime, minTime));

            // 最后一个 chunk：结束时清理状态
            if (chunkInfo.isLast) {
              source.onended = () => {
                if (!state.streamingFinished) {
                  state.streamingFinished = true;
                  state.isPlaying = false;
                  state.playbackPauseOffset = 0;
                  state.streamingSources = [];
                  stopPlayheadAnimation();
                  dom.timeDisplay.textContent = formatTime(0);
                  clearPlayheadLine();
                }
              };
            }
            state.streamingSources.push(source);
          } catch (e) {
            console.warn('[Audio] Streaming chunk playback failed:', e.message);
          }
        });
      }

      try {
        const mixedAudio = await window.electronAPI.synthesizeMultiStreaming({
          fragments: multiFragments,
          bpm: state.project.bpm,
        });

        // 合成完成：移除 chunk 监听器
        if (streamingChunkCleanup) { try { streamingChunkCleanup(); } catch (_) {} streamingChunkCleanup = null; }

        state.currentAudioData = mixedAudio;
        state.currentAudioBuffer = null; // 流式播放无整段 buffer，置空避免 playhead 动画误判

        if (!streamingStarted) {
          // 流式未启动（offset > 0 或无 chunk 到达）：回退到整段播放
          dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
          if (state.playbackPauseOffset > 0) {
            drawPausedPlayheadAt(state.playbackPauseOffset);
          }
          await startAudioPlayback(state.playbackPauseOffset);
        } else {
          // 流式播放已启动，playhead 动画已在运行
          dom.timeDisplay.textContent = formatTime(0);
        }
      } catch (error) {
        if (streamingChunkCleanup) { try { streamingChunkCleanup(); } catch (_) {} streamingChunkCleanup = null; }
        // 停止已调度的流式 source
        state.streamingFinished = true;
        for (const src of state.streamingSources) { try { src.onended = null; src.stop(); } catch (_) {} }
        state.streamingSources = [];
        throw error;
      }
    } else {
      // === 顺序合成路径（未启用分块） ===
      const totalSeconds = ((globalLastEnd - globalFirstStart) / state.project.bpm) * 60;
      const totalFrags = allFragments.length;
      let completedFrags = 0;

      const audioResults = [];

      for (const fragment of allFragments) {
        const singer = singerMap.get(fragment.singerId);
        if (!singer) { completedFrags++; continue; }

        // clippedNotes：相对 fragment 的 notes，截断到 fragment.duration（与分片编辑器 getClippedNotes 一致）
        const fragDuration = fragment.duration;
        const clippedNotes = [];
        for (const note of fragment.notes) {
          if (note.start >= fragDuration) continue;
          const noteEnd = note.start + note.duration;
          if (noteEnd > fragDuration) {
            clippedNotes.push({ ...note, duration: fragDuration - note.start });
          } else {
            clippedNotes.push(note);
          }
        }
        if (clippedNotes.length === 0) { completedFrags++; continue; }

        // 该 fragment 的 pitchCurveF0（与分片编辑器 buildPitchCurveF0Data 等价）
        const pitchCurveF0 = buildFragmentPitchCurveF0(fragment, clippedNotes, state.project.bpm);

        const audioData = await window.electronAPI.synthesizeSVS({
          notes: clippedNotes,
          bpm: state.project.bpm,
          options: {
            f0Envelope: null,
            pitchCurveF0,
            refAudioWavBuffer: singer?.wavBuffer || null,
            refMidiNotes: singer?.midiNotes || null,
            refF0Data: singer?.f0Data || null,
            singerId: singer?.id || null,
            autoShift: dom.autoShiftCheck.checked,
            nSteps: inferenceOpts.nSteps,
            cfg: inferenceOpts.cfg,
            cfgRescale: inferenceOpts.cfgRescale,
            diffStepChunk: false,
            diffStepChunkFrames: inferenceOpts.diffStepChunkFrames,
            diffStepOverlapFrames: inferenceOpts.diffStepOverlapFrames,
          },
        });

        // padding 到 fragment 时长，确保混音时长对齐
        const expectedSamples = Math.ceil((fragDuration / state.project.bpm) * 60 * SAMPLE_RATE);
        let paddedAudio = audioData;
        if (audioData.length < expectedSamples) {
          paddedAudio = new Float32Array(expectedSamples);
          paddedAudio.set(audioData);
        }
        audioResults.push({
          audioData: paddedAudio,
          startTimeBeat: fragment.startTime,
        });

        completedFrags++;
        const overallProgress = (completedFrags / totalFrags) * 100;
        const currentSeconds = (overallProgress / 100) * totalSeconds;
        dom.timeDisplay.textContent = t('main.synthesizingShort') + ': ' + formatTime(currentSeconds) + ' / ' + formatTime(totalSeconds);
      }

      const maxEndBeat = globalLastEnd;
      const totalSamples = Math.ceil(((maxEndBeat / state.project.bpm) * 60) * SAMPLE_RATE);
      const mixedAudio = new Float32Array(totalSamples);

      for (const result of audioResults) {
        const startSample = Math.round((result.startTimeBeat / state.project.bpm * 60) * SAMPLE_RATE);
        const samplesToMix = result.audioData.length;
        for (let i = 0; i < samplesToMix; i++) {
          const targetIndex = startSample + i;
          if (targetIndex < totalSamples) {
            mixedAudio[targetIndex] += result.audioData[i];
          }
        }
      }

      state.currentAudioData = mixedAudio;

      // 不重置 playbackPauseOffset：若用户在合成前已通过拖拽 playhead 设置了起始位置，
      // 则从该位置开始播放。stopPlayback / 自然结束时已重置为 0。
      dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
      if (state.playbackPauseOffset > 0) {
        drawPausedPlayheadAt(state.playbackPauseOffset);
      }
      await startAudioPlayback(state.playbackPauseOffset);
    }

  } catch (error) {
    console.error('Synthesis failed:', error);
    showAlertDialog(t('main.synthesisFailed') + ': ' + error.message);
    dom.timeDisplay.textContent = formatTime(0);
  } finally {
    state.isSynthesizing = false;
    dom.btnPlay.textContent = t('main.play');
    dom.btnPlay.disabled = false;
    if (playProgressCleanup) { try { playProgressCleanup(); } catch (_) {} playProgressCleanup = null; }
  }
}

export function getAudioContext() {
  if (!state.audioContext || state.audioContext.state === 'closed') {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    if (state.audioContext.sampleRate !== SAMPLE_RATE) {
      console.warn(`[Audio] AudioContext actual sample rate: ${state.audioContext.sampleRate}Hz, target: ${SAMPLE_RATE}Hz, will auto-resample`);
    }
    state.gainNode = state.audioContext.createGain();
    state.gainNode.connect(state.audioContext.destination);
    applyAudioSettings();
  }
  if (state.audioContext.state === 'suspended') {
    state.audioContext.resume().catch(err => {
      console.warn('[Audio] AudioContext resume failed:', err);
    });
  }
  return state.audioContext;
}

export async function loadAudioSettings() {
  try {
    state.audioSettings = await window.electronAPI.getSettings();
    state.useExclusiveMode = state.audioSettings?.audioOutputMode === 'exclusive';
  } catch (e) {
    state.audioSettings = {};
  }
}

export function getPreviewInferenceOptions() {
  return {
    nSteps: state.audioSettings?.previewDiffSteps ?? 16,
    cfg: state.audioSettings?.previewCfgStrength ?? 3.0,
    cfgRescale: state.audioSettings?.previewCfgRescale ?? 0.75,
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
    diffStepChunk: state.audioSettings?.previewDiffStepChunkEnabled === true,
    diffStepChunkFrames: state.audioSettings?.previewDiffStepChunkFrames ?? 500,
    diffStepOverlapFrames: state.audioSettings?.previewDiffStepOverlapFrames ?? 50,
  };
}

export function getExportInferenceOptions() {
  return {
    nSteps: state.audioSettings?.exportDiffSteps ?? 32,
    cfg: state.audioSettings?.exportCfgStrength ?? 3.0,
    cfgRescale: state.audioSettings?.exportCfgRescale ?? 0.75,
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
  };
}

export function applyAudioSettings() {
  if (!state.audioSettings) return;

  if (state.gainNode && state.audioSettings.audioVolume !== undefined) {
    state.gainNode.gain.value = state.audioSettings.audioVolume;
  }

  if (state.audioContext && state.audioSettings.audioOutputDevice !== undefined && state.audioSettings.audioOutputDevice !== -1) {
    const sinkId = String(state.audioSettings.audioOutputDevice);
    if (state.audioContext.setSinkId && typeof state.audioContext.setSinkId === 'function') {
      state.audioContext.setSinkId(sinkId).catch(err => {
      // TODO: translate garbled log
      });
    }
  }
}

export async function startAudioPlayback(offset) {
  if (!state.currentAudioData || state.currentAudioData.length === 0) {
    return;
  }

  await loadAudioSettings();
  state.useExclusiveMode = state.audioSettings?.audioOutputMode === 'exclusive';

  if (state.useExclusiveMode) {
    await startExclusivePlayback(offset);
  } else {
    startSharedPlayback(offset);
  }
}

export function startSharedPlayback(offset) {
  stopAudioSource();

  const context = getAudioContext();
  const audioBuffer = context.createBuffer(1, state.currentAudioData.length, SAMPLE_RATE);
  const channelData = audioBuffer.getChannelData(0);
  channelData.set(state.currentAudioData);

  state.currentAudioBuffer = audioBuffer;

  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(state.gainNode);

  source.onended = () => {
    if (state.isPlaying) {
      state.isPlaying = false;
      state.playbackPauseOffset = 0;
      stopPlayheadAnimation();
      dom.timeDisplay.textContent = formatTime(0);
      clearPlayheadLine();
    }
  };

  source.start(0, offset);
  state.currentAudioSource = source;
  state.isPlaying = true;
  state.playbackStartTime = context.currentTime - offset;
  state.playbackPauseOffset = offset;

  startPlayheadAnimation();
}

export async function startExclusivePlayback(offset) {
  stopAudioSource();
  stopExclusivePlayback();

  try {
    const options = {
      deviceId: state.audioSettings?.audioOutputDevice ?? -1,
      sampleRate: state.audioSettings?.audioSampleRate ?? SAMPLE_RATE,
      channels: 1,
      bitDepth: state.audioSettings?.audioBitDepth ?? 'float32',
      bufferSize: state.audioSettings?.audioBufferSize ?? 1024,
      exclusiveMode: true,
      volume: state.audioSettings?.audioVolume ?? 1.0,
      offset: offset,
    };

    const result = await window.electronAPI.audioPlay(state.currentAudioData, options);

    if (!result.success) {
      console.warn('[Audio] WASAPI exclusive mode failed, falling back to shared:', result.error);
      state.useExclusiveMode = false;
      startSharedPlayback(offset);
      return;
    }

    state.isPlaying = true;
    state.playbackStartTime = Date.now() / 1000 - offset;
    state.playbackPauseOffset = offset;

    const removeEndedListener = window.electronAPI.onAudioEnded(() => {
      if (state.isPlaying) {
        state.isPlaying = false;
        state.playbackPauseOffset = 0;
        stopExclusivePlayback();
        stopPlayheadAnimation();
        dom.timeDisplay.textContent = formatTime(0);
        clearPlayheadLine();
      }
    });

    startExclusivePlayheadAnimation(removeEndedListener);
  } catch (err) {
      // TODO: translate garbled log
    state.useExclusiveMode = false;
    startSharedPlayback(offset);
  }
}

export function startExclusivePlayheadAnimation(removeEndedListener) {
  _ensureVisibilityHandler();
  function updatePlayhead() {
    _exclusiveUpdateFn = updatePlayhead;
    if (!state.isPlaying) {
      if (removeEndedListener) removeEndedListener();
      return;
    }

    const elapsed = Date.now() / 1000 - state.playbackStartTime;
    const duration = state.currentAudioData ? state.currentAudioData.length / SAMPLE_RATE : 0;

    if (elapsed >= duration) {
      state.isPlaying = false;
      state.playbackPauseOffset = 0;
      stopExclusivePlayback();
      stopPlayheadAnimation();
      dom.timeDisplay.textContent = formatTime(0);
      clearPlayheadLine();
      if (removeEndedListener) removeEndedListener();
      return;
    }

    dom.timeDisplay.textContent = formatTime(elapsed);
    drawPlayheadLine(elapsed);
    state.exclusivePlaybackRaf = requestAnimationFrame(updatePlayhead);
  }

  _exclusiveUpdateFn = updatePlayhead;
  state.exclusivePlaybackRaf = requestAnimationFrame(updatePlayhead);
}

export function stopExclusivePlayback() {
  if (state.exclusivePlaybackRaf) {
    cancelAnimationFrame(state.exclusivePlaybackRaf);
    state.exclusivePlaybackRaf = null;
  }
  window.electronAPI.audioStop().catch(err => {
    console.warn('[Audio] Failed to stop exclusive playback:', err);
  });
}

export function pausePlayback() {
  if (!state.isPlaying) {
    return;
  }

  // 流式播放暂停：停止所有流式 source，记录当前位置
  if (state.streamingSources && state.streamingSources.length > 0) {
    const context = getAudioContext();
    const elapsed = context.currentTime - state.playbackStartTime;
    state.playbackPauseOffset = Math.max(0, elapsed);
    state.streamingFinished = true;
    for (const src of state.streamingSources) {
      try { src.onended = null; src.stop(); } catch (_) {}
    }
    state.streamingSources = [];
    state.isPlaying = false;
    if (state.playheadRaf) {
      cancelAnimationFrame(state.playheadRaf);
      state.playheadRaf = null;
    }
    dom.timeDisplay.textContent = t('main.paused') + ': ' + formatTime(elapsed);
    drawPausedPlayheadAt(elapsed);
    return;
  }

  if (state.useExclusiveMode) {
    const elapsed = Date.now() / 1000 - state.playbackStartTime;
    state.playbackPauseOffset = elapsed;
    stopExclusivePlayback();
    state.isPlaying = false;
    // 仅取消 rAF，不清除 playhead 视觉——保留显示"已暂停位置"的虚线播放头
    if (state.exclusivePlaybackRaf) {
      cancelAnimationFrame(state.exclusivePlaybackRaf);
      state.exclusivePlaybackRaf = null;
    }
    dom.timeDisplay.textContent = t('main.paused') + ': ' + formatTime(elapsed);
    drawPausedPlayheadAt(elapsed);
  } else {
    if (!state.currentAudioSource) return;
    const context = getAudioContext();
    const elapsed = context.currentTime - state.playbackStartTime;
    state.playbackPauseOffset = elapsed;
    stopAudioSource();
    state.isPlaying = false;
    // stopAudioSource 已 cancel rAF，但不会清除画布；这里手动绘制暂停态播放头
    dom.timeDisplay.textContent = t('main.paused') + ': ' + formatTime(elapsed);
    drawPausedPlayheadAt(elapsed);
  }
}

export function stopPlayback() {
  // 停止流式播放
  if (state.streamingSources && state.streamingSources.length > 0) {
    state.streamingFinished = true;
    for (const src of state.streamingSources) {
      try { src.onended = null; src.stop(); } catch (_) {}
    }
    state.streamingSources = [];
  }
  if (state.useExclusiveMode) {
    stopExclusivePlayback();
  }
  stopAudioSource();
  state.isPlaying = false;
  state.playbackPauseOffset = 0;
  stopPlayheadAnimation();
  state.currentAudioData = null;
  state.currentAudioBuffer = null;
  dom.timeDisplay.textContent = formatTime(0);
}

/**
 * 实时跳转到新的播放位置（不重新合成）。
 * 复用已缓存的 state.currentAudioData，从 newOffset 开始播放。
 * 播放中拖拽 playhead 时调用，避免重新合成的延迟。
 *
 * 如果未在播放，仅更新 playbackPauseOffset 和暂停态播放头视觉，
 * 等用户点击 Play 时从该位置开始。
 */
export async function seekPlayback(newOffset) {
  // 流式播放中拖拽 playhead：停止流式播放，记录位置。
  // 合成仍在后台进行，完成后 state.currentAudioData 会被设置，用户可从该位置按 Play 继续播放。
  if (state.streamingSources && state.streamingSources.length > 0) {
    state.streamingFinished = true;
    for (const src of state.streamingSources) {
      try { src.onended = null; src.stop(); } catch (_) {}
    }
    state.streamingSources = [];
    state.isPlaying = false;
    if (state.playheadRaf) {
      cancelAnimationFrame(state.playheadRaf);
      state.playheadRaf = null;
    }
    state.playbackPauseOffset = Math.max(0, newOffset);
    drawPausedPlayheadAt(state.playbackPauseOffset);
    dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
    return;
  }

  const audioData = state.currentAudioData;
  if (!audioData || audioData.length === 0) {
    // 没有缓存的音频：仅记录用户选择的位置，等合成后从这里开始
    state.playbackPauseOffset = Math.max(0, newOffset);
    drawPausedPlayheadAt(state.playbackPauseOffset);
    dom.timeDisplay.textContent = formatTime(state.playbackPauseOffset);
    return;
  }

  // 限制到 [0, duration)
  const duration = audioData.length / SAMPLE_RATE;
  const clamped = Math.max(0, Math.min(duration - 0.001, newOffset));

  // 停止当前播放（保留 currentAudioData，不 null）
  if (state.useExclusiveMode) {
    if (state.exclusivePlaybackRaf) {
      cancelAnimationFrame(state.exclusivePlaybackRaf);
      state.exclusivePlaybackRaf = null;
    }
    window.electronAPI.audioStop().catch(() => {});
  } else {
    stopAudioSource();
  }
  state.isPlaying = false;

  // 设置新的起始位置
  state.playbackPauseOffset = clamped;

  // 从新位置重新启动播放
  await startAudioPlayback(clamped);
}

/**
 * 返回当前播放位置（秒）。
 * 播放中：根据 playbackStartTime 实时计算；
 * 未播放：返回 state.playbackPauseOffset（用户拖拽/暂停保留的位置）。
 * 用于事件处理器的 hit-test 与 tooltip 显示。
 */
export function getCurrentPlaybackSeconds() {
  if (state.isPlaying) {
    if (state.useExclusiveMode) {
      return Math.max(0, Date.now() / 1000 - state.playbackStartTime);
    }
    if (state.audioContext) {
      return Math.max(0, state.audioContext.currentTime - state.playbackStartTime);
    }
    return 0;
  }
  return state.playbackPauseOffset || 0;
}

export function stopAudioSource() {
  if (state.currentAudioSource) {
    try {
      state.currentAudioSource.onended = null;
      state.currentAudioSource.stop();
    } catch (e) {
    }
    state.currentAudioSource = null;
  }
  if (state.playheadRaf) {
    cancelAnimationFrame(state.playheadRaf);
    state.playheadRaf = null;
  }
}

export function startPlayheadAnimation() {
  _ensureVisibilityHandler();
  function updatePlayhead() {
    _sharedUpdateFn = updatePlayhead;
    if (!state.isPlaying) return;

    const context = getAudioContext();
    const elapsed = context.currentTime - state.playbackStartTime;

    if (state.currentAudioBuffer) {
      const duration = state.currentAudioBuffer.duration;
      if (elapsed >= duration) {
        stopPlayback();
        dom.timeDisplay.textContent = formatTime(0);
        clearPlayheadLine();
        return;
      }
    }

    dom.timeDisplay.textContent = formatTime(elapsed);
    drawPlayheadLine(elapsed);
    state.playheadRaf = requestAnimationFrame(updatePlayhead);
  }

  _sharedUpdateFn = updatePlayhead;
  state.playheadRaf = requestAnimationFrame(updatePlayhead);
}

export function stopPlayheadAnimation() {
  if (state.playheadRaf) {
    cancelAnimationFrame(state.playheadRaf);
    state.playheadRaf = null;
  }
  clearPlayheadLine();
}

export async function exportAll() {
  // 导出流程现在由导出对话框驱动：
  // 1. 打开对话框让用户配置精度/参数/输出位置
  // 2. 对话框保存设置后调用 runExportJob 执行合成
  // 3. 对话框负责显示进度、保存文件、打开导出位置
  const { openExportDialog } = await import('./exportDialog.js');
  await openExportDialog();
}

/**
 * 执行导出合成任务（由导出对话框调用）。
 * 遍历所有有音符的分片，逐个合成并混音，返回混音后的音频数据。
 *
 * @param {Object} opts - 导出选项
 * @param {number} opts.nSteps - 扩散步数
 * @param {number} opts.cfg - CFG 引导强度
 * @param {number} opts.cfgRescale - CFG Rescale 系数
 * @param {boolean} opts.autoShift - 是否启用 Auto Shift
 * @param {Function} [opts.onFragmentProgress] - 单分片推理进度回调 (progress: 0-100)
 * @param {Function} [opts.onOverallProgress] - 总体进度回调 (progress: 0-100)
 * @param {Function} [opts.onStatus] - 状态文本回调 (statusKey: string, params?: object)
 * @returns {Promise<{mixedAudio: Float32Array, maxDuration: number, fragmentCount: number}>}
 */
export async function runExportJob(opts) {
  const {
    nSteps,
    cfg,
    cfgRescale,
    autoShift,
    onFragmentProgress,
    onOverallProgress,
    onStatus,
  } = opts;

  const fragments = trackManager.getFragments();
  if (fragments.length === 0) {
    throw new Error(t('main.exportDialog.noFragments'));
  }

  const singers = trackManager.getSingers();
  const singerMap = new Map();
  singers.forEach(s => singerMap.set(s.id, s));

  // 收集所有有 notes 的 fragments，按 startTime 排序后逐个合成。
  // 与 playAll 一致：每个 fragment 用相对 notes（clippedNotes）
  // + 该 fragment 自己的 pitchCurve（buildFragmentPitchCurveF0），
  // 确保与分片编辑器播放/导出结果完全一致。
  const allFragments = fragments
    .filter(f => f.notes && f.notes.length > 0)
    .sort((a, b) => a.startTime - b.startTime);

  if (allFragments.length === 0) {
    throw new Error(t('main.exportDialog.noNotes'));
  }

  if (onStatus) onStatus('progressPreparing');

  await ensurePipelineInitialized();
  await loadAudioSettings();

  const totalFragments = allFragments.length;
  let audioResults = [];
  let maxDuration = 0;

  // 注册推理进度监听：转换为单分片进度
  let fragmentProgressCleanup = null;
  if (onFragmentProgress) {
    try {
      fragmentProgressCleanup = window.electronAPI.onSVSProgress((progress) => {
        onFragmentProgress(progress);
        // 同时计算总体进度：(已完成分片数 + 当前分片进度) / 总分片数
        if (onOverallProgress) {
          const overall = ((audioResults.length + progress / 100) / totalFragments) * 100;
          onOverallProgress(Math.min(99, overall));
        }
      });
    } catch (_) {}
  }

  try {
    for (const fragment of allFragments) {
      const singer = singerMap.get(fragment.singerId);
      if (!singer) {
        // 跳过找不到歌手的分片，但仍计入进度
        if (onOverallProgress) {
          const overall = ((audioResults.length + 1) / totalFragments) * 100;
          onOverallProgress(Math.min(99, overall));
        }
        continue;
      }

      // clippedNotes：相对 fragment 的 notes，截断到 fragment.duration（与分片编辑器 getClippedNotes 一致）
      const fragDuration = fragment.duration;
      const clippedNotes = [];
      for (const note of fragment.notes) {
        if (note.start >= fragDuration) continue;
        const noteEnd = note.start + note.duration;
        if (noteEnd > fragDuration) {
          clippedNotes.push({ ...note, duration: fragDuration - note.start });
        } else {
          clippedNotes.push(note);
        }
      }
      if (clippedNotes.length === 0) continue;

      const pitchCurveF0 = buildFragmentPitchCurveF0(fragment, clippedNotes, state.project.bpm);

      const audioData = await window.electronAPI.synthesizeSVS({
        notes: clippedNotes,
        bpm: state.project.bpm,
        options: {
          refAudioWavBuffer: singer?.wavBuffer || null,
          refMidiNotes: singer?.midiNotes || null,
          refF0Data: singer?.f0Data || null,
          singerId: singer?.id || null,
          pitchCurveF0,
          autoShift,
          nSteps,
          cfg,
          cfgRescale,
        },
      });

      // padding 到 fragment 时长，确保混音时长对齐
      const expectedSamples = Math.ceil((fragDuration / state.project.bpm) * 60 * SAMPLE_RATE);
      let paddedAudio = audioData;
      if (audioData.length < expectedSamples) {
        paddedAudio = new Float32Array(expectedSamples);
        paddedAudio.set(audioData);
      }
      audioResults.push({
        audioData: paddedAudio,
        startTimeBeat: fragment.startTime,
      });

      const fragEndSec = (fragDuration / state.project.bpm) * 60;
      if (fragEndSec > maxDuration) maxDuration = fragEndSec;

      // 完成一个分片后更新总体进度（onSVSProgress 只在推理过程中触发，
      // 这里补充分片完成后的进度跃迁）
      if (onOverallProgress) {
        const overall = (audioResults.length / totalFragments) * 100;
        onOverallProgress(Math.min(99, overall));
      }
    }
  } finally {
    if (fragmentProgressCleanup) {
      try { fragmentProgressCleanup(); } catch (_) {}
      fragmentProgressCleanup = null;
    }
  }

  if (onStatus) onStatus('progressEncoding');

  const totalSamples = Math.ceil(maxDuration * SAMPLE_RATE);
  const mixedAudio = new Float32Array(totalSamples);

  for (const result of audioResults) {
    const startSample = Math.round((result.startTimeBeat / state.project.bpm * 60) * SAMPLE_RATE);
    const samplesToMix = result.audioData.length;

    for (let i = 0; i < samplesToMix; i++) {
      const targetIndex = startSample + i;
      if (targetIndex < totalSamples) {
        mixedAudio[targetIndex] += result.audioData[i];
      }
    }
  }

  if (onOverallProgress) onOverallProgress(100);

  return {
    mixedAudio,
    maxDuration,
    fragmentCount: audioResults.length,
  };
}
