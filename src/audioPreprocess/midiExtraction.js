import { state, dom } from './state.js';
import { BPM } from './constants.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
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

    if (state.pianoRoll) {
      state.pianoRoll.notes = notes;
      state.pianoRoll._staticCacheDirty = true;
      state.pianoRoll.render();
      updateMidiInfo();
    }

    const fields = buildSingerFields(notes);
    state.singerData = {
      index: `vocal_${Math.floor(state.wavDuration * 1000)}`,
      language: 'Mandarin',
      time: [0, Math.floor(state.wavDuration * 1000)],
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
    const resolvedOptions = midiTool === 'fcpe' ? resolveOptions(collectOptions()) : null;
    paced = runPacedProgress(loading, loadingMsg);

    let result;
    if (midiTool === 'rmvpe') {
      result = await window.electronAPI.extractMidiRosvot({
        audioData: audioData,
        sampleRate,
        bpm: BPM,
      });
    } else if (midiTool === 'fcpe') {
      result = await window.electronAPI.extractMidiFcpe({
        audioData: audioData,
        sampleRate,
        bpm: BPM,
        options: resolvedOptions,
      });
    } else {
      result = await window.electronAPI.extractF0BasicPitch({
        audioData: audioData,
        sampleRate,
        bpm: BPM,
      });
    }

    if (!result.success) {
      throw new Error(result.error || 'MIDI extraction failed');
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
      }
      // UVR 分离质量提示
      showQualityWarnings(result.warnings);
    }

    const notes = (result.notes || []).map((n, i) => ({
      id: n.id ?? (Date.now() + i),
      pitch: n.pitch ?? 60,
      start: n.start ?? 0,
      duration: n.duration ?? 0.25,
      lyric: n.lyric || n.text || 'la',
    }));

    if (result.f0Array && result.f0Array.length > 0) {
      state.f0Data = result.f0Array;
    }

    if (state.pianoRoll) {
      state.pianoRoll.notes = notes;
      if (state.f0Data) {
        state.pianoRoll.f0Data = state.f0Data;
      }
      state.pianoRoll.render();
      updateMidiInfo();
    }

    const currentF0 = state.f0Data || [];
    const fields = buildSingerFields(notes);
    state.singerData = {
      index: `vocal_${Math.floor(state.wavDuration * 1000)}`,
      language: 'Mandarin',
      time: [0, Math.floor(state.wavDuration * 1000)],
      duration: notes.map((n) => (n.duration * (60 / BPM)).toFixed(2)).join(' '),
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
