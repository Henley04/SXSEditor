import { state, dom } from './state.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { drawWaveformWithPlayhead } from './canvasRenderer.js';
import { initPianoRoll } from './pianoRoll.js';
import { processWavBuffer } from './audioLoader.js';
import { updateMidiInfo } from './uiControls.js';

// W21: IPC cleanup tracking array (mirrors renderer/fragmentEditor _ipcCleanups
// pattern). Each registered IPC listener pushes its unsubscribe function here
// so beforeunload can remove the listeners.
state._ipcCleanups = state._ipcCleanups || [];

export function setupIpcHandlers() {
  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const ipc = window.electronAPI;

      function initializeWithData(data) {
        if (!data || !data.wavBuffer) {
          showAlertDialog(t('preprocess.noAudioReceived'));
          return;
        }

        state.wavFileBuffer = data.wavBuffer;
        state.wavFileName = data.data?.wavFileName || 'audio.wav';
        state.singerName = data.data?.singerName || '未命名歌手';
        state.singerColor = data.data?.singerColor || '#3498db';
        state.avatarImageData = data.data?.avatarImageData;
        state.avatarImageName = data.data?.avatarImageName;

        dom.wavFileNameEl.textContent = state.wavFileName;
        dom.midiInfoEl.textContent = t('preprocess.waitingForExtraction');

        processWavBuffer(state.wavFileBuffer).then((buffer) => {
          state.wavAudioBuffer = buffer;
          state.wavDuration = state.wavAudioBuffer.duration;

          drawWaveformWithPlayhead(0);

          initPianoRoll().then(() => {
            console.log(t('preprocess.consoleStarted'));
          });
        }).catch((err) => {
          console.error(t('preprocess.initFailed'), err);
          showAlertDialog(t('preprocess.initFailed') + ': ' + err.message);
        });
      }

      // W21: capture the unsubscribe function returned by onLoadPreprocessData
      // and track it so beforeunload can remove the IPC listener.
      const cleanupLoad = ipc.onLoadPreprocessData((data) => {
        initializeWithData(data);
      });
      if (cleanupLoad) state._ipcCleanups.push(cleanupLoad);

      const initialData = window._pendingPreprocessData;
      if (initialData) {
        initializeWithData(initialData);
      }
    } catch (err) {
      console.error(t('preprocess.initFailed'), err);
      showAlertDialog(t('preprocess.initFailed') + ': ' + err.message);
    }
  });
}
