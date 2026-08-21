import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { getCurrentFragment, getCurrentProject, getNotes } from './state.js';

const PPQ = 480;

function u16(value) { return [(value >>> 8) & 0xff, value & 0xff]; }
function u32(value) { return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]; }
function ascii(text) { return Array.from(text, c => c.charCodeAt(0)); }
function utf8(text) { return Array.from(new TextEncoder().encode(text)); }
function vlq(value) {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
}
function meta(type, data) { return [0xff, type, ...vlq(data.length), ...data]; }
function continuationLyric(note) {
  return (note.isContinuation || note.isSlur || note.noteType === 3) ? '-' : String(note.lyric || '').trim();
}
function safeName(value) {
  return String(value || 'fragment').replace(/[\\/:*?"<>|]/g, '_').trim() || 'fragment';
}

export function encodeFragmentMidi(notes, bpm, trackName = 'Fragment') {
  const tempo = Math.max(1, Math.round(60000000 / Math.max(1, Number(bpm) || 120)));
  const events = [
    { tick: 0, order: 0, bytes: meta(0x03, utf8(trackName)) },
    { tick: 0, order: 1, bytes: meta(0x51, [(tempo >>> 16) & 0xff, (tempo >>> 8) & 0xff, tempo & 0xff]) },
    { tick: 0, order: 2, bytes: meta(0x58, [4, 2, 24, 8]) },
  ];

  for (const note of notes || []) {
    const pitch = Math.max(0, Math.min(127, Math.round(Number(note.pitch) || 0)));
    if (pitch <= 0 || !Number.isFinite(note.start) || !Number.isFinite(note.duration) || note.duration <= 0) continue;
    const startTick = Math.max(0, Math.round(note.start * PPQ));
    const endTick = Math.max(startTick + 1, Math.round((note.start + note.duration) * PPQ));
    const lyric = continuationLyric(note);
    if (lyric) events.push({ tick: startTick, order: 1, bytes: meta(0x05, utf8(lyric)) });
    events.push({ tick: startTick, order: 2, bytes: [0x90, pitch, 96] });
    events.push({ tick: endTick, order: 0, bytes: [0x80, pitch, 0] });
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track = [];
  let previousTick = 0;
  for (const event of events) {
    track.push(...vlq(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

  return new Uint8Array([
    ...ascii('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(PPQ),
    ...ascii('MTrk'), ...u32(track.length), ...track,
  ]);
}

export async function exportFragmentMidi() {
  const notes = getNotes();
  if (!notes.length) {
    showAlertDialog(t('fragment.noNotesToExportMidi'));
    return;
  }
  try {
    const project = getCurrentProject();
    const fragment = getCurrentFragment();
    const bpm = project?.bpm || 120;
    const name = safeName(fragment?.name || fragment?.title || t('fragment.fragment'));
    const result = await window.electronAPI.showSaveDialog({
      title: t('fragment.exportMidi'),
      defaultPath: `${name}.mid`,
      filters: [{ name: 'MIDI', extensions: ['mid', 'midi'] }],
    });
    if (result.canceled || !result.filePath) return;
    const data = encodeFragmentMidi(notes, bpm, name);
    const saved = await window.electronAPI.saveFile(result.filePath, data);
    if (saved && saved.success === false) throw new Error(saved.error || 'Failed to save MIDI');
  } catch (error) {
    console.error('[Fragment MIDI Export]', error);
    showAlertDialog(t('fragment.exportMidiFailedDetail', { detail: error.message || String(error) }));
  }
}
