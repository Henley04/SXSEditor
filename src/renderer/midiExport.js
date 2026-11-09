import { state, trackManager } from './state.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { planMidiTracks, encodeProjectMidi } from '../shared/midiExportPlan.js';
import { MIDI_PPQ } from '../shared/midiWriter.js';

/** 工程文件名去掉扩展名，用作 .mid 的默认文件名。 */
function projectStem(fallback) {
  const raw = state.currentProjectFilePath || '';
  const base = raw.split(/[\\/]/).pop().replace(/\.(sxsproj|sxs)$/i, '');
  return base || fallback;
}

/**
 * 导出项目为多轨 MIDI（每歌手一轨）。
 *
 * 只写音符信息：音高、时值、位置、歌词。音色（参考音频 / 推理后端）
 * 在 MIDI 里没有对应物，用它去别的歌声合成器时音色需要各自再选。
 */
export async function exportProjectMidi() {
  const tracks = planMidiTracks({
    singers: trackManager.getSingers(),
    fragments: trackManager.getFragments(),
    ppq: MIDI_PPQ,
  });
  if (tracks.length === 0) {
    showAlertDialog(t('main.midiNoTracks'));
    return;
  }

  const stem = projectStem(t('main.exportMidiProject'));
  const result = await window.electronAPI.showSaveDialog({
    title: t('main.exportMidiProject'),
    defaultPath: `${stem}.mid`,
    filters: [{ name: 'MIDI', extensions: ['mid', 'midi'] }],
  });
  if (result.canceled || !result.filePath) return;

  try {
    const data = encodeProjectMidi({
      tracks,
      bpm: state.project.bpm,
      timeSignature: state.project.timeSignature,
      name: stem,
      ppq: MIDI_PPQ,
    });
    const saved = await window.electronAPI.saveFile(result.filePath, data);
    if (saved && saved.success === false) throw new Error(saved.error || '');
  } catch (error) {
    console.error('[Project MIDI Export]', error);
    showAlertDialog(t('main.midiExportFailed', { detail: error.message || String(error) }));
  }
}
