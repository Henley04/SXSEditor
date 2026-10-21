import { state, dom } from './state.js';
import { BPM } from './constants.js';
import { t } from '../i18n/index.js';
import { showAlertDialog, showConfirmDialog } from '../alertDialog.js';
import { buildSingerFields, showLoading, hideLoading, updateMidiInfo } from './uiControls.js';
import { collectOptions, setStatus } from './panel.js';
import { saveOptions, resolveOptions } from './extractionOptions.js';

const STAGES = [
  { key: 'analyze', pct: 8 },
  { key: 'extract', pct: 55 },
  { key: 'smooth', pct: 72 },
  { key: 'segment', pct: 88 },
  { key: 'quantize', pct: 96 },
];

function stageLabel(key) {
  return t(`preprocess.stage.${key}`) || t('preprocess.processing');
}

function runPacedProgress(handle, textPrefix) {
  let i = 0;
  let lastPct = 0;
  const t0 = performance.now();
  const timer = setInterval(() => {
    if (i < STAGES.length) {
      const st = STAGES[i];
      lastPct = st.pct;
      handle.setProgress(st.pct, `${textPrefix} ${stageLabel(st.key)}`);
      i++;
    }
  }, 260);
  const finish = (extraMsg) => {
    clearInterval(timer);
    handle.setProgress(100, extraMsg || '');
  };
  // 估算剩余时间（基于已用时间外推）
  const etaTimer = setInterval(() => {
    const elapsed = (performance.now() - t0) / 1000;
    const remaining = Math.max(0.5, elapsed * 0.6);
    handle.setProgress(lastPct, `${textPrefix} ${t('preprocess.eta')} ~${remaining.toFixed(1)}s`);
  }, 500);
  return {
    finish,
    stopEta: () => clearInterval(etaTimer),
  };
}

function showQualityWarnings(warnings) {
  if (!warnings || warnings.length === 0) return;
  const msgs = warnings.map((w) => t(`preprocess.warn.${w}`)).filter(Boolean);
  if (msgs.length) showAlertDialog(t('preprocess.qualityWarnTitle') + '\n\n' + msgs.join('\n'));
}

export async function importMidiFile() {
  try {
    const result = await window.electronAPI.importMidi();
    if (!result.success) {
      if (!result.canceled) {
        showAlertDialog(t('preprocess.midiImportFailed') + ': ' + (result.error || t('preprocess.extractionFailed')));
      }
      return;
    }

    const notes = (result.notes || []).map((n, i) => ({
      id: n.id ?? (Date.now() + i),
      pitch: n.pitch ?? 60,
      start: n.start ?? 0,
      duration: n.duration ?? 0.25,
      lyric: n.lyric || '',
      noteType: n.noteType,
    }));

    // 导入会整体覆盖当前音符：已有音符时先确认，避免误操作丢失编辑。
    const existingCount = state.pianoRoll ? state.pianoRoll.notes.length : 0;
    if (existingCount > 0) {
      const ok = await showConfirmDialog(t('preprocess.midiImportOverwriteConfirm', { count: existingCount }));
      if (!ok) return;
    }

    if (state.pianoRoll) {
      state.pianoRoll.notes = notes;
      state.pianoRoll._staticCacheDirty = true;
      state.pianoRoll.render();
      updateMidiInfo();
    }

    const fields = buildSingerFields(notes);
    const importTrimOffsetMs = Math.floor((state.trimOffsetSec || 0) * 1000);
    state.singerData = {
      index: `vocal_${Math.floor(state.wavDuration * 1000)}`,
      language: 'Mandarin',
      time: [importTrimOffsetMs, importTrimOffsetMs + Math.floor(state.wavDuration * 1000)],
      trimOffsetSec: state.trimOffsetSec || 0,
      duration: notes.map((n) => (n.duration * (60 / BPM)).toFixed(2)).join(' '),
      text: fields.text,
      phoneme: fields.phoneme,
      note_pitch: notes.map((n) => n.pitch).join(' '),
      note_type: fields.note_type,
      f0: (state.f0Data || []).map((f) => f.f0.toFixed(1)).join(' '),
    };

    updateMidiInfo();
    showAlertDialog(t('preprocess.midiImportComplete'));
  } catch (err) {
    console.error('MIDI import failed:', err);
    showAlertDialog(t('preprocess.midiImportFailed') + ': ' + err.message);
  }
}

export async function extractF0BasicPitch() {
  if (!state.wavAudioBuffer) {
    showAlertDialog(t('preprocess.pleaseLoadAudio'));
    return;
  }

  const settings = await window.electronAPI.getSettings();
  const midiTool = (settings?.midiExtractTool === 'rosvot' ? 'rmvpe' : settings?.midiExtractTool) || 'fcpe';
  const loadingMsg = midiTool === 'rmvpe'
    ? t('preprocess.extractingMidiRmvpe')
    : midiTool === 'fcpe'
    ? t('preprocess.extractingMidiFcpe')
    : t('preprocess.extractingMidiBasicPitch');
  const loading = showLoading(loadingMsg);
  let paced = null;

  try {
    const channelData = state.wavAudioBuffer.getChannelData(0);
    const audioData = channelData.buffer;
    const sampleRate = state.wavAudioBuffer.sampleRate;
    // 三种提取工具都使用面板/设置里的 BPM（原先硬编码 BPM=120，忽略用户设置）。
    const resolvedOptions = resolveOptions(collectOptions());
    // 实际生效的 BPM（自动测速回填后会更新），用于音符 beat→秒换算。
    let effectiveBpm = resolvedOptions.bpm;
    paced = runPacedProgress(loading, loadingMsg);

    let result;
    if (midiTool === 'rmvpe') {
      result = await window.electronAPI.extractMidiRosvot({
        audioData: audioData,
        sampleRate,
        bpm: resolvedOptions.bpm,
      });
    } else if (midiTool === 'fcpe') {
      result = await window.electronAPI.extractMidiFcpe({
        audioData: audioData,
        sampleRate,
        bpm: resolvedOptions.bpm,
        options: resolvedOptions,
      });
    } else {
      result = await window.electronAPI.extractF0BasicPitch({
        audioData: audioData,
        sampleRate,
        bpm: resolvedOptions.bpm,
      });
    }

    if (!result.success) {
      // FCPE model not downloaded yet — prompt the user and open the model
      // download page so they can install the optional FCPE model.
      if (result.code === 'MODEL_NOT_FOUND') {
        showAlertDialog(t('preprocess.fcpeModelMissing'));
        try { await window.electronAPI.updateAPI.openModelDownload(); } catch (_) {}
        return;
      }
      throw new Error(result.error || 'MIDI extraction failed');
    }

    // Detector frame counts may be based on resampled/padded model input. Map
    // the returned timeline back to the decoded WAV duration once, then use the
    // same scale for F0 and notes so waveform, preview curve and MIDI agree.
    let timeScale = 1;
    if (result.f0Array && result.f0Array.length > 1 && state.wavDuration > 0) {
      const step = Math.max(1e-6, result.f0Array[1].time - result.f0Array[0].time);
      const detectorDuration = result.f0Array[result.f0Array.length - 1].time + step;
      if (detectorDuration > 0) timeScale = state.wavDuration / detectorDuration;
      result.f0Array = result.f0Array.map(frame => ({ ...frame, time: Math.max(0, frame.time * timeScale) }));
    }
    if (result.notes && Math.abs(timeScale - 1) > 1e-6) {
      result.notes = result.notes.map(note => ({
        ...note,
        start: Math.max(0, (note.start || 0) * timeScale),
        duration: Math.max(0.01, (note.duration || 0.01) * timeScale),
      }));
    }

    if (midiTool === 'fcpe') {
      // 设备/速度提示
      const deviceTag = result.device === 'DML' ? 'DML (GPU)' : 'CPU';
      setStatus(`${t('preprocess.deviceLabel')}: ${deviceTag}`);
      // 自动 BPM：回填到面板
      if (resolvedOptions.autoBpm && result.bpm && result.bpm > 0) {
        const opts = collectOptions();
        opts.bpm = result.bpm;
        if (dom.bpmInput) dom.bpmInput.value = result.bpm;
        saveOptions(opts);
        state.extractOptions = resolveOptions(opts);
        // 主进程在本次提取里已经用检测到的 BPM 完成秒→beat 换算
        // （pitchMidiIpc → segmentNotes({ bpm: useBpm })），因此 result.notes
        // 无需再按新 BPM 重算；这里只需同步生效 BPM，让后续提取 / beat→秒
        // 换算（singerData、试听、钢琴卷轴）都使用新值。
        effectiveBpm = result.bpm;
        if (state.pianoRoll) state.pianoRoll.bpm = result.bpm;
      }
      // UVR 分离质量提示
      showQualityWarnings(result.warnings);
    }

    const rawNotes = result.notes || [];
    const notes = rawNotes.map((n, i) => {
      const previous = i > 0 ? rawNotes[i - 1] : null;
      const gap = previous ? (n.start ?? 0) - ((previous.start ?? 0) + (previous.duration ?? 0)) : Infinity;
      // FCPE may split one sustained syllable at a stable pitch transition.
      // Mark only practically gapless follow-up notes as slurs; users enter the
      // lyric on the first note and continuation notes use '-'.
      const continuation = midiTool === 'fcpe' && previous && gap <= 0.03;
      return {
        id: n.id ?? (Date.now() + i),
        pitch: n.pitch ?? 60,
        start: n.start ?? 0,
        duration: n.duration ?? 0.25,
        lyric: n.lyric || n.text || (continuation ? '' : 'la'),
        noteType: continuation ? 3 : (n.noteType ?? 2),
        isContinuation: continuation,
      };
    });

    if (result.f0Array && result.f0Array.length > 0) {
      state.f0Data = result.f0Array;
    }

    if (state.pianoRoll) {
      // beat↔秒换算（f0 曲线、播放头、试听）统一使用本次提取的 BPM，
      // 否则面板 BPM ≠ 120 时音符与 f0 曲线在时间轴上错位。
      state.pianoRoll.bpm = effectiveBpm;
      state.pianoRoll.notes = notes;
      if (state.f0Data) {
        state.pianoRoll.f0Data = state.f0Data;
      }
      // 替换 notes/f0 后必须失效静态缓存，否则首帧仍绘制旧内容。
      state.pianoRoll._staticCacheDirty = true;
      state.pianoRoll.render();
      updateMidiInfo();
    }

    const currentF0 = state.f0Data || [];
    const fields = buildSingerFields(notes);
    // 音符时值是 beat，换算秒必须用本次提取的 BPM（而非常量 BPM）。
    const activeBpm = (state.pianoRoll && state.pianoRoll.bpm) || BPM;
    // 音频可能被裁剪掉前导静音，singerData 需回到原始时间轴。
    const trimOffsetMs = Math.floor((state.trimOffsetSec || 0) * 1000);
    state.singerData = {
      index: `vocal_${Math.floor(state.wavDuration * 1000)}`,
      language: 'Mandarin',
      time: [trimOffsetMs, trimOffsetMs + Math.floor(state.wavDuration * 1000)],
      trimOffsetSec: state.trimOffsetSec || 0,
      duration: notes.map((n) => (n.duration * (60 / activeBpm)).toFixed(2)).join(' '),
      text: fields.text,
      phoneme: fields.phoneme,
      note_pitch: notes.map((n) => n.pitch).join(' '),
      note_type: fields.note_type,
      f0: currentF0.map((f) => f.f0.toFixed(1)).join(' '),
    };

    updateMidiInfo();
    showAlertDialog(t('preprocess.midiExtractionComplete'));
  } catch (err) {
    console.error('Extraction failed:', err);
    showAlertDialog(t('preprocess.extractionFailed') + ': ' + err.message);
  } finally {
    if (paced) { paced.finish(''); paced.stopEta(); }
    hideLoading(loading);
  }
}
