import { state } from './state.js';
import { BPM } from './constants.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { buildSingerFields, showLoading, hideLoading, updateMidiInfo } from './uiControls.js';

export async function extractF0BasicPitch() {
  if (!state.wavAudioBuffer) {
    showAlertDialog(t('preprocess.pleaseLoadAudio'));
    return;
  }

  const settings = await window.electronAPI.getSettings();
  const midiTool = (settings?.midiExtractTool === 'rosvot' ? 'rmvpe' : settings?.midiExtractTool) || 'basicpitch';
  const loadingMsg = midiTool === 'rmvpe'
    ? t('preprocess.extractingMidiRmvpe')
    : t('preprocess.extractingMidiBasicPitch');
  const loading = showLoading(loadingMsg);

  try {
    const channelData = state.wavAudioBuffer.getChannelData(0);
    const audioData = channelData.buffer;

    let result;
    if (midiTool === 'rmvpe') {
      result = await window.electronAPI.extractMidiRosvot({
        audioData: audioData,
        sampleRate: state.wavAudioBuffer.sampleRate,
        bpm: BPM,
      });
    } else {
      result = await window.electronAPI.extractF0BasicPitch({
        audioData: audioData,
        sampleRate: state.wavAudioBuffer.sampleRate,
        bpm: BPM,
      });
    }

    if (!result.success) {
      throw new Error(result.error || 'MIDI extraction failed');
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
    hideLoading(loading);
  }
}
