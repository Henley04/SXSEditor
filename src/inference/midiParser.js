const SILENCE_THRESHOLD_SEC = 0.2;

function readUint8(view, offset) {
  return view.getUint8(offset);
}

function readUint16(view, offset) {
  return (view.getUint8(offset) << 8) | view.getUint8(offset + 1);
}

function readUint32(view, offset) {
  return (
    (view.getUint8(offset) << 24) |
    (view.getUint8(offset + 1) << 16) |
    (view.getUint8(offset + 2) << 8) |
    view.getUint8(offset + 3)
  );
}

function readInt32(view, offset) {
  const unsigned = readUint32(view, offset);
  return unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
}

function readVarLen(view, offset) {
  let value = 0;
  let byte;
  let bytesRead = 0;
  do {
    byte = view.getUint8(offset + bytesRead);
    value = (value << 7) | (byte & 0x7f);
    bytesRead++;
  } while (byte & 0x80);
  return { value, length: bytesRead };
}

function readString(view, offset, length) {
  let str = '';
  for (let i = 0; i < length; i++) {
    str += String.fromCharCode(view.getUint8(offset + i));
  }
  return str;
}

function ticksToSeconds(ticks, ticksPerBeat, tempo) {
  return (ticks / ticksPerBeat) * (tempo / 1000000);
}

function parseMidiFile(buffer) {
  const view = new DataView(buffer);
  let offset = 0;

  const headerTag = readString(view, offset, 4);
  offset += 4;
  if (headerTag !== 'MThd') {
    throw new Error('Invalid MIDI file: missing MThd header');
  }

  const headerLength = readUint32(view, offset);
  offset += 4;

  const format = readUint16(view, offset);
  offset += 2;
  const numTracks = readUint16(view, offset);
  offset += 2;
  const ticksPerBeat = readUint16(view, offset);
  offset += 2;

  if (ticksPerBeat & 0x8000) {
    throw new Error('SMPTE time division not supported');
  }

  offset = 8 + headerLength;

  let tempo = 500000;
  const rawNotes = [];
  const lyrics = [];

  for (let trackIdx = 0; trackIdx < numTracks; trackIdx++) {
    if (offset + 8 > buffer.byteLength) break;

    const trackTag = readString(view, offset, 4);
    offset += 4;
    if (trackTag !== 'MTrk') {
      offset += readUint32(view, offset) + 4;
      continue;
    }

    const trackLength = readUint32(view, offset);
    offset += 4;
    const trackEnd = offset + trackLength;

    let absTicks = 0;
    let runningStatus = 0;
    const active = {};

    while (offset < trackEnd) {
      const varLen = readVarLen(view, offset);
      offset += varLen.length;
      absTicks += varLen.value;

      let statusByte = readUint8(view, offset);

      if (statusByte & 0x80) {
        runningStatus = statusByte;
        offset++;
      } else {
        statusByte = runningStatus;
      }

      const eventType = statusByte & 0xf0;
      const channel = statusByte & 0x0f;

      if (statusByte === 0xff) {
        const metaType = readUint8(view, offset);
        offset++;
        const metaLen = readVarLen(view, offset);
        offset += metaLen.length;

        if (metaType === 0x51) {
          if (metaLen.value === 3) {
            tempo =
              (readUint8(view, offset) << 16) |
              (readUint8(view, offset + 1) << 8) |
              readUint8(view, offset + 2);
          }
        } else if (metaType === 0x05) {
          let text = '';
          for (let i = 0; i < metaLen.value; i++) {
            text += String.fromCharCode(readUint8(view, offset + i));
          }
          try {
            const bytes = [];
            for (let i = 0; i < text.length; i++) {
              bytes.push(text.charCodeAt(i));
            }
            text = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
          } catch (_) {}
          lyrics.push({ ticks: absTicks, text });
        }

        offset += metaLen.value;
      } else if (statusByte === 0xf0 || statusByte === 0xf7) {
        const sysLen = readVarLen(view, offset);
        offset += sysLen.length;
        offset += sysLen.value;
      } else if (eventType === 0x90) {
        const note = readUint8(view, offset);
        offset++;
        const velocity = readUint8(view, offset);
        offset++;

        const key = channel * 128 + note;
        if (velocity > 0) {
          active[key] = { startTicks: absTicks, velocity };
        } else {
          if (active[key]) {
            const startTicks = active[key].startTicks;
            const vel = active[key].velocity;
            delete active[key];
            rawNotes.push({
              midi: note,
              startTicks,
              durationTicks: absTicks - startTicks,
              velocity: vel,
              lyric: '',
            });
          }
        }
      } else if (eventType === 0x80) {
        const note = readUint8(view, offset);
        offset++;
        offset++;

        const key = channel * 128 + note;
        if (active[key]) {
          const startTicks = active[key].startTicks;
          const vel = active[key].velocity;
          delete active[key];
          rawNotes.push({
            midi: note,
            startTicks,
            durationTicks: absTicks - startTicks,
            velocity: vel,
            lyric: '',
          });
        }
      } else if (eventType === 0xa0 || eventType === 0xb0 || eventType === 0xe0) {
        offset += 2;
      } else if (eventType === 0xc0 || eventType === 0xd0) {
        offset += 1;
      }
    }

    offset = trackEnd;
  }

  if (rawNotes.length === 0) {
    throw new Error('No notes found in MIDI file');
  }

  for (const n of rawNotes) {
    n.endTicks = n.startTicks + n.durationTicks;
  }

  rawNotes.sort((a, b) => a.startTicks - b.startTicks || a.endTicks - b.endTicks);
  lyrics.sort((a, b) => a.ticks - b.ticks);

  const trimmed = [];
  for (const note of rawNotes) {
    while (trimmed.length > 0) {
      const prev = trimmed[trimmed.length - 1];
      if (note.startTicks < prev.endTicks) {
        prev.endTicks = note.startTicks;
        prev.durationTicks = prev.endTicks - prev.startTicks;
        if (prev.durationTicks <= 0) {
          trimmed.pop();
          continue;
        }
      }
      break;
    }
    trimmed.push(note);
  }

  const tolerance = Math.max(1, Math.floor(ticksPerBeat / 100));
  let lyricIdx = 0;
  for (const note of trimmed) {
    while (lyricIdx < lyrics.length && lyrics[lyricIdx].ticks < note.startTicks - tolerance) {
      lyricIdx++;
    }
    if (lyricIdx < lyrics.length) {
      if (Math.abs(lyrics[lyricIdx].ticks - note.startTicks) <= tolerance) {
        note.lyric = lyrics[lyricIdx].text;
        lyricIdx++;
      }
    }
  }

  const result = [];
  let prevEndS = 0.0;

  for (let idx = 0; idx < trimmed.length; idx++) {
    const n = trimmed[idx];
    let startS = ticksToSeconds(n.startTicks, ticksPerBeat, tempo);
    const endS = ticksToSeconds(n.endTicks, ticksPerBeat, tempo);
    if (prevEndS > startS) {
      startS = prevEndS;
    }
    const durS = endS - startS;
    if (durS <= 0) continue;

    const lyric = n.lyric || '';
    let noteType;
    let text;
    if (!lyric) {
      noteType = 2;
      text = 'la';
    } else if (lyric === '<SP>') {
      noteType = 1;
      text = '<SP>';
    } else if (lyric === '-') {
      noteType = 3;
      text = idx > 0 ? (trimmed[idx - 1].lyric || '-') : '-';
    } else {
      noteType = 2;
      text = lyric;
    }

    if (startS - prevEndS > SILENCE_THRESHOLD_SEC) {
      const spStartBeat = (prevEndS / (tempo / 1000000));
      const spDurS = startS - prevEndS;
      const spDurBeats = spDurS / (tempo / 1000000);
      result.push({
        pitch: 0,
        start: spStartBeat,
        duration: spDurBeats,
        lyric: '',
        noteType: 1,
      });
    } else {
      if (result.length > 0) {
        const lastResult = result[result.length - 1];
        const lastStartS = lastResult.start * (tempo / 1000000);
        lastResult.duration = (startS - lastStartS) / (tempo / 1000000);
      }
    }

    const startBeat = startS / (tempo / 1000000);
    const durBeats = durS / (tempo / 1000000);
    result.push({
      pitch: n.midi,
      start: startBeat,
      duration: durBeats,
      lyric: text,
      noteType,
    });

    prevEndS = endS;
  }

  return result;
}

module.exports = { parseMidiFile };
