import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { getCurrentFragment, getCurrentProject, getNotes } from './state.js';
// 音高曲线采样（含自动层）：用于把曲线导出为 pitch bend
import { getPitchAtTime } from './canvasRenderer.js';

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

/**
 * 拍号编码：[numerator, log2(denominator), 24, 8]（24 = MIDI clocks/click,
 * 8 = 32nd notes per quarter）。缺省回退 4/4，分母取最近的 2 的幂。
 */
function timeSignatureBytes(timeSignature) {
  const num = Number(timeSignature?.[0]);
  const den = Number(timeSignature?.[1]);
  const numerator = Number.isFinite(num) && num > 0 ? Math.max(1, Math.min(255, Math.round(num))) : 4;
  const denominator = Number.isFinite(den) && den > 0 ? Math.round(den) : 4;
  const dd = Math.max(0, Math.min(7, Math.round(Math.log2(denominator))));
  return [numerator, dd, 24, 8];
}

/**
 * @param {Array} notes
 * @param {number} bpm
 * @param {string} [trackName]
 * @param {Array|null} [timeSignature]
 * @param {((beat:number)=>number|null)|null} [curveSampler]
 *   音高曲线采样器（beat → 绝对 MIDI 音高，null = 无覆盖）。传入后把曲线
 *   量化为 14-bit pitch bend 写进 MIDI —— 否则用户画的滑音带不到别的 DAW/歌声合成器
 *   （审查报告 F12）。pitch bend 范围按 GM 默认 ±2 半音。
 */
export function encodeFragmentMidi(notes, bpm, trackName = 'Fragment', timeSignature = null, curveSampler = null) {
  const tempo = Math.max(1, Math.round(60000000 / Math.max(1, Number(bpm) || 120)));
  const events = [
    { tick: 0, order: 0, bytes: meta(0x03, utf8(trackName)) },
    { tick: 0, order: 1, bytes: meta(0x51, [(tempo >>> 16) & 0xff, (tempo >>> 8) & 0xff, tempo & 0xff]) },
    { tick: 0, order: 2, bytes: meta(0x58, timeSignatureBytes(timeSignature)) },
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

  // ---- 音高曲线 → pitch bend（每 16 分音符采样一次，量化到 ±2 半音 / 14 bit）----
  if (typeof curveSampler === 'function' && Array.isArray(notes) && notes.length > 0) {
    let lastBeat = 0;
    for (const n of notes) {
      if (Number.isFinite(n.start) && Number.isFinite(n.duration)) {
        lastBeat = Math.max(lastBeat, n.start + n.duration);
      }
    }
    const stepTicks = Math.max(1, Math.round(PPQ / 4));
    const lastTick = Math.round(lastBeat * PPQ);
    const sorted = notes.slice().sort((a, b) => a.start - b.start);
    for (let tick = 0; tick <= lastTick; tick += stepTicks) {
      const beat = tick / PPQ;
      let pitch;
      try { pitch = curveSampler(beat); } catch (_e) { pitch = null; }
      if (pitch === null || !Number.isFinite(pitch)) continue;
      const baseNote = _noteAtBeat(sorted, beat);
      if (!baseNote || !(baseNote.pitch > 0)) continue;
      // cents → ±2 半音 → 14 bit（0..16383，中心 8192）
      const cents = (pitch - baseNote.pitch) * 100;
      const norm = Math.max(-1, Math.min(1, cents / 200));
      const bend = Math.max(-8192, Math.min(8191, Math.round(norm * 8191)));
      const value = bend + 8192;
      events.push({ tick, order: 3, bytes: [0xE0, value & 0x7f, (value >> 7) & 0x7f] });
    }
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
    // 传入曲线采样器：把音高曲线导出为 pitch bend（F12）
    const data = encodeFragmentMidi(notes, bpm, name, project?.timeSignature, (beat) => getPitchAtTime(beat));
    const saved = await window.electronAPI.saveFile(result.filePath, data);
    if (saved && saved.success === false) throw new Error(saved.error || t('fragment.midiSaveFailed'));
  } catch (error) {
    console.error('[Fragment MIDI Export]', error);
    showAlertDialog(t('fragment.exportMidiFailedDetail', { detail: error.message || String(error) }));
  }
}

/** 某拍所在的音符（用于把曲线差值换算成相对该音符的 pitch bend）。 */
function _noteAtBeat(sortedNotes, beat) {
  let lo = 0;
  let hi = sortedNotes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const n = sortedNotes[mid];
    if (beat < n.start) hi = mid - 1;
    else if (beat >= n.start + n.duration) lo = mid + 1;
    else return n;
  }
  return null;
}
