import { state, dom } from './state.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { drawWaveformWithPlayhead } from './canvasRenderer.js';
import { initPianoRoll } from './pianoRoll.js';
import { processWavBuffer } from './audioLoader.js';
import { setStatus } from './panel.js';

// 加载时对输入做电平/削波检查，提示用户是否需归一化
function checkInputLevel(buffer) {
  const data = buffer.getChannelData(0);
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
    if (a >= 0.999) clipped++;
  }
  const rms = Math.sqrt(sumSq / (n || 1));
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120;
  const levelInfo = { peak, rms, peakDb, rmsDb, clipped, clippedRatio: n ? clipped / n : 0 };
  state.levelInfo = levelInfo;

  const warnings = [];
  if (levelInfo.clippedRatio > 0.0001) warnings.push(t('preprocess.warn.clipped'));
  if (peakDb > -1) warnings.push(t('preprocess.warn.hot'));
  if (rmsDb < -40 || peakDb < -20) warnings.push(t('preprocess.warn.weak'));
  if (warnings.length) {
    setStatus(t('preprocess.levelStatus') + `: ${peakDb.toFixed(1)}dBFS / ${rmsDb.toFixed(1)}dBFS`);
    showAlertDialog(t('preprocess.levelWarnTitle') + '\n\n' + warnings.join('\n'));
  }
  return levelInfo;
}

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

          checkInputLevel(state.wavAudioBuffer);

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
