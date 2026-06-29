import { state } from './state.js';
import { BPM } from './constants.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { buildSingerFields, showLoading, hideLoading, updateMidiInfo } from './uiControls.js';

export async function extractF0AndPitch() {
  if (!state.wavAudioBuffer) {
    showAlertDialog(t('preprocess.pleaseLoadAudio'));
    return;
  }

  const loading = showLoading(t('preprocess.extractingF0Rmvpe'));

  try {
    const channelData = state.wavAudioBuffer.getChannelData(0);
    const audioData = channelData.buffer;

    const result = await window.electronAPI.extractF0({
      audioData: audioData,
      sampleRate: state.wavAudioBuffer.sampleRate,
    });

    if (!result.success) {
      throw new Error(result.error || 'RMVPE inference failed');
    }

    state.f0Data = result.f0Array;

    if (state.pianoRoll) {
      state.pianoRoll.f0Data = state.f0Data;
      state.pianoRoll.render();
      updateMidiInfo();
    }

    // RMVPE只提取F0，不生成MIDI音符
    const currentNotes = state.pianoRoll ? state.pianoRoll.notes : [];
    const fields = buildSingerFields(currentNotes);
    state.singerData = {
      index: `vocal_${Math.floor(state.wavDuration * 1000)}`,
      language: 'Mandarin',
      time: [0, Math.floor(state.wavDuration * 1000)],
      duration: currentNotes.map((n) => (n.duration * (60 / BPM)).toFixed(2)).join(' '),
      text: fields.text,
      phoneme: fields.phoneme,
      note_pitch: currentNotes.map((n) => n.pitch).join(' '),
      note_type: fields.note_type,
      f0: state.f0Data.map((f) => f.f0.toFixed(1)).join(' '),
    };

    updateMidiInfo();
    showAlertDialog(t('preprocess.f0ExtractionComplete'));
  } catch (err) {
    console.error('Extraction failed:', err);
    showAlertDialog(t('preprocess.extractionFailed') + ': ' + err.message);
  } finally {
    hideLoading(loading);
  }
}
