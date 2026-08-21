import { state, trackManager } from './state.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';

function formatLrcTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const secs = safe - minutes * 60;
  return `[${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}]`;
}

function normalizeLyric(note, previousLyric) {
  const lyric = String(note.lyric || '').trim();
  if (!lyric || lyric === '<SP>' || lyric === '<AP>') return null;
  if (note.noteType === 3 || lyric === '-') return null;
  if (lyric === previousLyric && note.isContinuation) return null;
  return lyric;
}

export function buildProjectLrc() {
  const bpm = Number(state.project.bpm) || 120;
  const entries = [];
  for (const fragment of trackManager.getFragments()) {
    let previousLyric = '';
    for (const note of fragment.notes || []) {
      const lyric = normalizeLyric(note, previousLyric);
      if (!lyric) continue;
      previousLyric = lyric;
      const beat = (Number(fragment.startTime) || 0) + (Number(note.start) || 0);
      entries.push({ seconds: beat * 60 / bpm, lyric });
    }
  }
  entries.sort((a, b) => a.seconds - b.seconds);
  const seen = new Set();
  const lines = [];
  for (const entry of entries) {
    const key = `${entry.seconds.toFixed(3)}\u0000${entry.lyric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${formatLrcTime(entry.seconds)}${entry.lyric}`);
  }
  return lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

export async function exportProjectLrc() {
  const lrc = buildProjectLrc();
  if (!lrc) {
    showAlertDialog(t('main.lrcNoLyrics'));
    return;
  }
  const sourceName = (state.currentProjectFilePath || 'lyrics')
    .split(/[\\/]/).pop().replace(/\.(sxsproj|sxs)$/i, '') || 'lyrics';
  const result = await window.electronAPI.showSaveDialog({
    title: t('main.exportLrc'),
    defaultPath: `${sourceName}.lrc`,
    filters: [{ name: 'LRC Lyrics', extensions: ['lrc'] }],
  });
  if (result.canceled || !result.filePath) return;
  // UTF-8 BOM improves compatibility with older Windows LRC players.
  const saved = await window.electronAPI.saveFile(result.filePath, `\uFEFF${lrc}`);
  if (!saved?.success) showAlertDialog(t('main.lrcExportFailed', { detail: saved?.error || '' }));
}
