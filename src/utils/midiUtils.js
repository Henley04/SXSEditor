const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToNoteName(midi) {
  // R19: 负数/NaN 会让 NOTE_NAMES[负数] 变成 undefined，拼出 "undefined-2"。
  // 数字入参钳到 [0, 127]（MIDI 合法音高范围），非数字返回占位符。
  if (midi === null || midi === undefined) return '—';
  const n = Math.round(Number(midi));
  if (!Number.isFinite(n)) return '—';
  const clamped = Math.max(0, Math.min(127, n));
  const octave = Math.floor(clamped / 12) - 1;
  const name = NOTE_NAMES[clamped % 12];
  return `${name}${octave}`;
}

module.exports = { midiToNoteName, NOTE_NAMES };
