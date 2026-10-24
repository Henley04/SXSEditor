import { state, dom } from './state.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { drawWaveformWithPlayhead } from './canvasRenderer.js';
import { initPianoRoll } from './pianoRoll.js';
import { processWavBuffer } from './audioLoader.js';
import { setStatus } from './panel.js';
import { updateMidiInfo } from './uiControls.js';

/**
 * 歌手编辑模式的窗口外观：标题显示「编辑 · 歌手名 · 文件名」。
 * 保存按钮文案保持原样（它带 data-icon，直接改 textContent 会把图标吃掉）。
 */
function applyEditModeChrome(edit) {
  const render = () => {
    const titleEl = document.getElementById('page-title');
    if (!titleEl) return;
    const parts = [t('preprocess.editTitle')];
    if (edit.singerName) parts.push(edit.singerName);
    const fileName = (state.wavFileName || '').split(/[\\/]/).pop();
    if (fileName) parts.push(fileName);
    // 去掉 data-i18n，否则语言切换时 applyLocale 会把标题覆盖回「音频预处理」。
    titleEl.removeAttribute('data-i18n');
    titleEl.textContent = parts.join(' · ');
    document.title = titleEl.textContent;
  };
  render();
  document.addEventListener('localeChanged', render);
  state._ipcCleanups.push(() => document.removeEventListener('localeChanged', render));
}

/** 恢复到普通「音频预处理」标题（窗口被复用于新建歌手时）。 */
function resetEditModeChrome() {
  const titleEl = document.getElementById('page-title');
  if (!titleEl) return;
  titleEl.setAttribute('data-i18n', 'preprocess.audioPreprocess');
  titleEl.textContent = t('preprocess.audioPreprocess');
  document.title = titleEl.textContent;
}

/** 把 .sxssinger 里已有的音符与 F0 恢复到钢琴卷轴。 */
function restoreEditContent(edit) {
  if (!edit || !state.pianoRoll) return;

  const notes = (edit.midiNotes || []).map((n, i) => ({
    id: n.id ?? (Date.now() + i),
    pitch: n.pitch ?? 60,
    start: n.start ?? 0,
    duration: n.duration ?? 0.25,
    lyric: n.lyric || '',
    noteType: n.noteType,
  }));
  if (notes.length > 0) {
    state.pianoRoll.notes = notes;
    state.pianoRoll._staticCacheDirty = true;
    state.pianoRoll.render();
    // 视口默认停在最高音区（scrollY = 0），C4 附近的音符全在屏幕外。
    // 载入后把音域滚到可视区中部，否则用户会以为文件没加载出来。
    const pitches = notes.map((n) => n.pitch);
    state.pianoRoll.scrollPitchRangeIntoView(
      Math.min(...pitches) - 2,
      Math.max(...pitches) + 2
    );
  }

  if (Array.isArray(edit.f0Data) && edit.f0Data.length > 0) {
    state.f0Data = edit.f0Data;
    // 文件里的 F0 不记来源。标成 rmvpe，避免下次「提取 MIDI」时被 FCPE
    // 顺带算出的 F0 顶掉（midiExtraction 只在 f0Source !== 'rmvpe' 时覆盖）。
    state.f0Source = 'rmvpe';
    state.pianoRoll.f0Data = state.f0Data;
    state.pianoRoll._staticCacheDirty = true;
    state.pianoRoll.render();
  }

  updateMidiInfo();
}

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

        // 同一窗口会被复用（先编辑 A，再新建 B）。每次灌数据都必须先清掉
        // 上一次的编辑上下文，否则新歌手会被错误地写回上一个文件。
        state.editFilePath = null;
        state.editSingerData = null;
        state.f0Data = null;
        state.f0Source = null;
        if (state.pianoRoll) {
          state.pianoRoll.notes = [];
          state.pianoRoll.f0Data = null;
          state.pianoRoll._staticCacheDirty = true;
        }

        // 歌手编辑模式：把文件里已有的音符 / F0 / singerData 一并恢复
        const edit = data.data?.edit || null;
        if (edit && edit.filePath) {
          state.editFilePath = edit.filePath;
          state.editSingerData = edit.singerData || null;
          applyEditModeChrome(edit);
        } else {
          resetEditModeChrome();
        }

        dom.wavFileNameEl.textContent = state.wavFileName;
        dom.midiInfoEl.textContent = t('preprocess.waitingForExtraction');

        processWavBuffer(state.wavFileBuffer).then((buffer) => {
          state.wavAudioBuffer = buffer;
          state.wavDuration = state.wavAudioBuffer.duration;

          checkInputLevel(state.wavAudioBuffer);

          drawWaveformWithPlayhead(0);

          initPianoRoll().then(() => {
            console.log(t('preprocess.consoleStarted'));
            // 钢琴卷轴就绪后再灌入音符 / F0，避免 init 过程把它们清空。
            if (edit) restoreEditContent(edit);
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
