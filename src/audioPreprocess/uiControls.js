import { state, dom } from './state.js';
import { PIANO_KEY_WIDTH, NOTE_HEIGHT, BEAT_WIDTH, HEADER_HEIGHT, F0_CURVE_AREA_HEIGHT, BPM } from './constants.js';
import { t } from '../i18n/index.js';
import { mergePhoneme } from '../utils/mergePhoneme.js';
import { tokenizeLyric } from '../utils/cjkUtils.js';
import { showAlertDialog } from '../alertDialog.js';
import { stopPlayback } from './playback.js';

export function buildSingerFields(notes) {
  const mergedNotes = mergePhoneme(notes);
  const textParts = [];
  const phonemeParts = [];
  const noteTypeParts = [];
  for (let i = 0; i < mergedNotes.length; i++) {
    const n = mergedNotes[i];
    const lyric = n.lyric || '';
    const hasLyric = lyric.trim().length > 0;
    const isSlur = n.isSlur || n.isContinuation;
    if (hasLyric) {
      textParts.push(lyric);
      phonemeParts.push(lyric);
    } else {
      textParts.push('<SP>');
      phonemeParts.push('<SP>');
    }
    if (!hasLyric) {
      noteTypeParts.push('1');
    } else if (isSlur) {
      noteTypeParts.push('3');
    } else {
      noteTypeParts.push('2');
    }
  }
  return {
    text: textParts.join(' '),
    phoneme: phonemeParts.join(' '),
    note_type: noteTypeParts.join(' '),
  };
}

export function updateMidiInfo() {
  if (state.pianoRoll) {
    const noteCount = state.pianoRoll.notes.length;
    dom.midiInfoEl.textContent = noteCount > 0 ? t('preprocess.noteCount', { count: noteCount }) : t('preprocess.waitingForExtraction');
  }
}

export function startInlineEdit(roll, note, hit) {
  if (state.activeInlineInput) {
    if (state.activeInlineInput.parentElement) state.activeInlineInput.remove();
    state.activeInlineInput = null;
    state.activeInlineEditNote = null;
  }

  state.activeInlineEditNote = note;

  const container = roll.canvas.parentElement;
  const containerRect = container.getBoundingClientRect();
  const canvasRect = roll.canvas.getBoundingClientRect();

  const offsetX = canvasRect.left - containerRect.left;
  const offsetY = canvasRect.top - containerRect.top;

  const inputX = offsetX + hit.nx + 2;
  const inputY = offsetY + hit.ny;
  const inputW = Math.max(40, hit.nw - 4);
  const inputH = hit.nh;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = note.lyric || '';
  input.style.cssText = `
    position: absolute;
    left: ${inputX}px;
    top: ${inputY}px;
    width: ${inputW}px;
    height: ${inputH}px;
    background: var(--bg-input);
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: var(--fg-primary);
    font-size: 11px;
    font-family: sans-serif;
    padding: 0 2px;
    outline: none;
    z-index: 1000;
    box-sizing: border-box;
  `;

  container.style.position = 'relative';
  container.appendChild(input);
  state.activeInlineInput = input;

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  let finished = false;

  const finish = (save) => {
    if (finished) return;
    finished = true;

    if (save) {
      const newLyric = input.value;
      if (newLyric !== note.lyric) {
        const tokens = tokenizeLyric(newLyric);
        if (tokens.length <= 1) {
          note.lyric = newLyric;
        } else {
          const noteIdx = roll.notes.findIndex(n => n.id === note.id);
          if (noteIdx !== -1) {
            note.lyric = tokens[0];
            const laterNotes = roll.notes.filter(n => n.start > note.start);
            laterNotes.sort((a, b) => a.start - b.start);
            for (let t = 1; t < tokens.length && t - 1 < laterNotes.length; t++) {
              laterNotes[t - 1].lyric = tokens[t];
            }
            updateMidiInfo();
          } else {
            note.lyric = newLyric;
          }
        }
      }
    }
    if (input.parentElement) input.remove();
    state.activeInlineInput = null;
    state.activeInlineEditNote = null;
    roll._staticCacheDirty = true;
    roll.render();
  };

  input.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  input.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    roll._onWheel(e);
  }, { passive: false });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });

  input.addEventListener('blur', () => {
    finish(true);
  });
}

export function updateInlineInputPosition(roll) {
  if (!state.activeInlineInput || !state.activeInlineEditNote) return;

  const note = state.activeInlineEditNote;
  const container = roll.canvas.parentElement;
  const containerRect = container.getBoundingClientRect();
  const canvasRect = roll.canvas.getBoundingClientRect();

  const offsetX = canvasRect.left - containerRect.left;
  const offsetY = canvasRect.top - containerRect.top;

  const nx = roll._timeToX(note.start);
  const ny = roll._pitchToY(note.pitch);
  const nw = note.duration * BEAT_WIDTH * roll.zoomX;
  const nh = NOTE_HEIGHT * roll.zoomY;

  const visible = nx + nw >= PIANO_KEY_WIDTH && nx <= roll.width &&
                  ny + nh >= HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT && ny <= roll.height;

  if (visible) {
    state.activeInlineInput.style.display = '';
    state.activeInlineInput.style.left = (offsetX + nx + 2) + 'px';
    state.activeInlineInput.style.top = (offsetY + ny) + 'px';
    state.activeInlineInput.style.width = Math.max(40, nw - 4) + 'px';
    state.activeInlineInput.style.height = nh + 'px';
  } else {
    state.activeInlineInput.style.display = 'none';
  }
}

export function showPromptDialog(title, defaultValue, onConfirm) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--overlay-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    padding: 20px;
    min-width: 280px;
    color: var(--fg-primary);
  `;

  const titleDiv = document.createElement('div');
  titleDiv.style.cssText = 'margin-bottom: 12px; font-weight: 600;';
  titleDiv.textContent = title;
  dialog.appendChild(titleDiv);

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'prompt-input';
  input.value = defaultValue || '';
  input.style.cssText = `
    width: 100%;
    padding: 8px;
    background: var(--bg-input);
    border: 1px solid var(--border-default);
    border-radius: 4px;
    color: var(--fg-primary);
    margin-bottom: 12px;
    box-sizing: border-box;
  `;
  dialog.appendChild(input);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.id = 'prompt-cancel';
  cancelBtn.style.cssText = `
    padding: 6px 16px;
    background: var(--bg-button);
    border: 1px solid var(--button-secondary-border);
    border-radius: 4px;
    color: var(--fg-primary);
    cursor: pointer;
  `;
  cancelBtn.textContent = t('common.cancel');

  const okBtn = document.createElement('button');
  okBtn.id = 'prompt-ok';
  okBtn.style.cssText = `
    padding: 6px 16px;
    background: var(--bg-button-primary);
    border: none;
    border-radius: 4px;
    color: var(--fg-on-accent);
    cursor: pointer;
  `;
  okBtn.textContent = t('common.confirm');

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  dialog.appendChild(btnRow);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const close = (value) => {
    document.body.removeChild(overlay);
    if (value !== null) {
      onConfirm(value);
    }
  };

  cancelBtn.addEventListener('click', () => close(null));
  okBtn.addEventListener('click', () => close(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') close(input.value);
    if (e.key === 'Escape') close(null);
  });

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

export function showLoading(text = t('preprocess.processing')) {
  const existing = document.querySelector('.loading-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'loading-overlay';

  const content = document.createElement('div');
  content.className = 'loading-content';

  const spinner = document.createElement('div');
  spinner.className = 'loading-spinner';
  content.appendChild(spinner);

  const textEl = document.createElement('div');
  textEl.className = 'loading-text';
  textEl.textContent = text;
  content.appendChild(textEl);

  overlay.appendChild(content);
  document.body.appendChild(overlay);
  return overlay;
}

export function hideLoading(overlay) {
  if (overlay && overlay.parentNode) {
    overlay.remove();
  }
}

export async function saveSingerData() {
  if (!state.wavAudioBuffer) {
    showAlertDialog(t('preprocess.noAudioToSave'));
    return;
  }

  const currentNotes = state.pianoRoll ? state.pianoRoll.notes : [];
  const hasNotes = currentNotes.length > 0;
  const hasF0 = state.f0Data && state.f0Data.length > 0;

  if (!hasNotes && !hasF0) {
    showAlertDialog(t('preprocess.noDataToSave'));
    return;
  }

  // 始终根据当前pianoRoll音符和F0数据重新构建singerData，确保编辑后的变更被保存
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
    f0: hasF0 ? state.f0Data.map((f) => f.f0.toFixed(1)).join(' ') : '',
  };

  const loading = showLoading(t('preprocess.savingPreprocessData'));

  try {
    const preprocessResult = {
      singerData: state.singerData,
      f0Data: state.f0Data,
      midiNotes: state.pianoRoll ? state.pianoRoll.notes : [],
    };

    await window.electronAPI.sendPreprocessData(preprocessResult);

    showAlertDialog(t('preprocess.preprocessSaveSuccess'), () => {
      stopPlayback();
      window.close();
    });
  } catch (err) {
    console.error('Save failed:', err);
    showAlertDialog(t('preprocess.saveFailed') + ': ' + err.message);
  } finally {
    hideLoading(loading);
  }
}
