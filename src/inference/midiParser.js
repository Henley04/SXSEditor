const { Midi } = require('@tonejs/midi');

const SILENCE_THRESHOLD_SEC = 0.2;

function _readUint16(view, offset) {
  return (view.getUint8(offset) << 8) | view.getUint8(offset + 1);
}

function _validateMidiBuffer(buffer) {
  if (!buffer || buffer.byteLength < 14) {
    throw new Error('Invalid MIDI file: too short');
  }
  const view = new DataView(buffer);
  const numTracks = _readUint16(view, 10);
  if (numTracks === 0) {
    throw new Error('No notes found in MIDI file');
  }
}

/**
 * Apply SVS-specific post-processing to a single track's raw notes:
 *   - trim overlapping notes (monophonic timeline)
 *   - attach lyrics (from the track or shared header) by tick proximity
 *   - insert SP (rest) notes for gaps > 0.2s
 *   - classify noteType: 1 = SP, 2 = normal, 3 = slur ('-')
 *
 * Output note shape:
 *   { pitch, start (beats), duration (beats), lyric, noteType }
 */
function _processTrackNotes(rawNotes, lyrics, ticksPerBeat, ticksToSeconds, secondsToTicks) {
  if (rawNotes.length === 0) return [];

  for (const n of rawNotes) {
    n.endTicks = n.startTicks + n.durationTicks;
  }

  rawNotes.sort((a, b) => a.startTicks - b.startTicks || a.endTicks - b.endTicks);

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

  const sortedLyrics = lyrics
    .filter((m) => typeof m.ticks === 'number')
    .map((m) => ({ ticks: m.ticks, text: m.text || '' }))
    .sort((a, b) => a.ticks - b.ticks);

  const tolerance = Math.max(1, Math.floor(ticksPerBeat / 100));
  let lyricIdx = 0;
  for (const note of trimmed) {
    while (lyricIdx < sortedLyrics.length && sortedLyrics[lyricIdx].ticks < note.startTicks - tolerance) {
      lyricIdx++;
    }
    if (lyricIdx < sortedLyrics.length) {
      if (Math.abs(sortedLyrics[lyricIdx].ticks - note.startTicks) <= tolerance) {
        note.lyric = sortedLyrics[lyricIdx].text;
        lyricIdx++;
      }
    }
  }

  const result = [];
  let prevEndS = 0.0;

  for (let idx = 0; idx < trimmed.length; idx++) {
    const n = trimmed[idx];
    let startS = ticksToSeconds(n.startTicks);
    const endS = ticksToSeconds(n.endTicks);
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
      const spStartTick = secondsToTicks(prevEndS);
      const spStartBeat = spStartTick / ticksPerBeat;
      const spEndTick = secondsToTicks(startS);
      const spDurBeats = (spEndTick - spStartTick) / ticksPerBeat;
      result.push({
        pitch: 0,
        start: spStartBeat,
        duration: spDurBeats,
        lyric: '',
        noteType: 1,
      });
    } else {
      // Small gap: extend the previous note to fill it so the timeline is
      // contiguous (matches original parser behavior).
      if (result.length > 0) {
        const lastResult = result[result.length - 1];
        lastResult.duration = n.startTicks / ticksPerBeat - lastResult.start;
      }
    }

    const startBeat = n.startTicks / ticksPerBeat;
    const durBeats = n.durationTicks / ticksPerBeat;
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

/**
 * Parse a MIDI file buffer and return SVS-compatible note objects from ALL
 * non-drum tracks merged onto a single timeline. Use this for the Fragment
 * Editor and Audio Preprocessing window, which work on a single melody line.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Array<{pitch:number,start:number,duration:number,lyric:string,noteType:number}>}
 */
function parseMidiFile(buffer) {
  _validateMidiBuffer(buffer);
  const midi = new Midi(buffer);
  const ticksPerBeat = midi.header.ppq;

  const rawNotes = [];
  for (const track of midi.tracks) {
    if (track.instrument.percussion) continue;
    for (const note of track.notes) {
      rawNotes.push({
        midi: note.midi,
        startTicks: note.ticks,
        durationTicks: note.durationTicks,
        velocity: Math.round(note.velocity * 127),
        lyric: '',
      });
    }
  }

  if (rawNotes.length === 0) {
    throw new Error('No notes found in MIDI file');
  }

  // Lyrics are global (header-level) in MIDI format 0; attach them to the
  // merged timeline.
  const lyrics = midi.header.meta
    .filter((m) => m.type === 'lyrics')
    .map((m) => ({ ticks: m.ticks, text: m.text || '' }));

  const ticksToSeconds = (t) => midi.header.ticksToSeconds(t);
  const secondsToTicks = (s) => midi.header.secondsToTicks(s);

  return _processTrackNotes(rawNotes, lyrics, ticksPerBeat, ticksToSeconds, secondsToTicks);
}

/**
 * Parse a MIDI file buffer and return per-track SVS note objects.
 *
 * Each non-drum track with at least one note becomes one entry in the
 * returned array. Drum tracks (channel 10) are skipped. Empty tracks are
 * skipped. This is used by the main window to create one singer track per
 * MIDI track.
 *
 * Returned shape:
 *   [{ name, channel, notes: [{pitch,start,duration,lyric,noteType}] }]
 *
 * @param {ArrayBuffer} buffer
 * @returns {Array<{name:string,channel:number,notes:Array}>}
 */
function parseMidiFileMultiTrack(buffer) {
  _validateMidiBuffer(buffer);
  const midi = new Midi(buffer);
  const ticksPerBeat = midi.header.ppq;
  const ticksToSeconds = (t) => midi.header.ticksToSeconds(t);
  const secondsToTicks = (s) => midi.header.secondsToTicks(s);

  // Global lyrics (format 0 / tempo track). Used as a fallback when a track
  // has no lyrics of its own.
  const globalLyrics = midi.header.meta
    .filter((m) => m.type === 'lyrics')
    .map((m) => ({ ticks: m.ticks, text: m.text || '' }));

  const result = [];
  for (const track of midi.tracks) {
    if (track.instrument.percussion) continue;
    if (track.notes.length === 0) continue;

    const rawNotes = track.notes.map((note) => ({
      midi: note.midi,
      startTicks: note.ticks,
      durationTicks: note.durationTicks,
      velocity: Math.round(note.velocity * 127),
      lyric: '',
    }));

    // Per-track lyrics (some MIDI exporters attach lyrics to the track
    // they belong to rather than the global tempo track).
    const trackLyrics = (track && Array.isArray(track.lyrics))
      ? track.lyrics.map((l) => ({ ticks: l.ticks, text: l.text || '' }))
      : globalLyrics;

    const notes = _processTrackNotes(
      rawNotes,
      trackLyrics,
      ticksPerBeat,
      ticksToSeconds,
      secondsToTicks,
    );

    if (notes.length === 0) continue;

    result.push({
      name: track.name || `Track ${result.length + 1}`,
      channel: track.channel,
      notes,
    });
  }

  if (result.length === 0) {
    throw new Error('No notes found in MIDI file');
  }

  return result;
}

module.exports = { parseMidiFile, parseMidiFileMultiTrack };
