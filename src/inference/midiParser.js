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
 * Walk the raw MIDI byte stream and extract lyric meta events (type 0x05)
 * directly. @tonejs/midi drops track-level lyric events (it only keeps the
 * ones on the tempo/header track), so VOCALOID-style MIDI files — where
 * lyrics live on the melody track itself — lose all lyric data after
 * parsing. This restores them.
 *
 * Returns:
 *   {
 *     byChannel: Map<channel, Array<{ticks, text}>>,
 *     global: Array<{ticks, text}>   // lyrics from tracks with no notes
 *   }
 */
function _extractRawLyrics(buffer) {
  const view = new DataView(buffer);
  const numTracks = _readUint16(view, 10);
  const byChannel = new Map();
  const global = [];
  let off = 14;

  for (let t = 0; t < numTracks && off + 8 <= buffer.byteLength; t++) {
    const tag = String.fromCharCode(
      view.getUint8(off), view.getUint8(off + 1),
      view.getUint8(off + 2), view.getUint8(off + 3),
    );
    if (tag !== 'MTrk') break;
    const trackLen = view.getUint32(off + 4);
    const trackEnd = off + 8 + trackLen;
    if (trackEnd > buffer.byteLength) break;

    let p = off + 8;
    let tick = 0;
    let lastStatus = null;
    let trackChannel = -1;
    let trackHasNotes = false;
    const trackLyrics = [];

    while (p < trackEnd) {
      // delta time (variable length)
      let delta = 0;
      let byte;
      do {
        if (p >= trackEnd) { byte = 0; break; }
        byte = view.getUint8(p++);
        delta = (delta << 7) | (byte & 0x7f);
      } while (byte & 0x80);
      tick += delta;

      if (p >= trackEnd) break;

      let status;
      const firstByte = view.getUint8(p);
      if (firstByte < 0x80) {
        // running status
        if (lastStatus === null) break;
        status = lastStatus;
      } else {
        status = firstByte;
        p++;
        if (status < 0xf0) {
          lastStatus = status;
        } else if (status >= 0xf0 && status <= 0xf7) {
          // system common resets running status
          lastStatus = null;
        }
        // 0xf8-0xff (system real-time) do not reset running status
      }

      if (status === 0xff) {
        // meta event
        if (p >= trackEnd) break;
        const metaType = view.getUint8(p++);
        let ml = 0;
        let mb;
        do {
          if (p >= trackEnd) { mb = 0; break; }
          mb = view.getUint8(p++);
          ml = (ml << 7) | (mb & 0x7f);
        } while (mb & 0x80);
        const dataStart = p;
        p += ml;
        if (metaType === 0x05 && p <= trackEnd) {
          const text = new TextDecoder('utf-8').decode(
            new Uint8Array(buffer, dataStart, ml),
          );
          trackLyrics.push({ ticks: tick, text });
        }
      } else if (status === 0xf0 || status === 0xf7) {
        // sysex event
        let ml = 0;
        let mb;
        do {
          if (p >= trackEnd) { mb = 0; break; }
          mb = view.getUint8(p++);
          ml = (ml << 7) | (mb & 0x7f);
        } while (mb & 0x80);
        p += ml;
      } else {
        // channel voice / mode message
        const hi = status >> 4;
        const lo = status & 0x0f;
        if (hi >= 0x8 && hi <= 0xe) {
          trackChannel = lo;
          if (hi === 0x9) trackHasNotes = true;
        }
        let dataLen = 0;
        switch (hi) {
          case 0xc: case 0xd: dataLen = 1; break;
          case 0x8: case 0x9: case 0xa: case 0xb: case 0xe: dataLen = 2; break;
        }
        p += dataLen;
      }
    }

    if (trackLyrics.length > 0) {
      if (trackHasNotes && trackChannel >= 0) {
        if (!byChannel.has(trackChannel)) byChannel.set(trackChannel, []);
        byChannel.get(trackChannel).push(...trackLyrics);
      } else {
        // Lyrics on a track with no notes (e.g. tempo/conductor track):
        // treat as global fallback.
        global.push(...trackLyrics);
      }
    }

    off = trackEnd;
  }

  return { byChannel, global };
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

  // Lyric-to-note matching strategy:
  //   - @tonejs/midi-aligned files usually place lyrics exactly at the
  //     note's start tick (tolerance = ticksPerBeat/100 ≈ 1 tick).
  //   - VOCALOID-exported MIDI files place each lyric event slightly
  //     before its corresponding note-on (commonly 12-168 ticks early).
  //     Strict tick matching fails for these, so we additionally allow a
  //     lyric to be matched if it sits within [note - maxLead, note +
  //     exactTolerance]. maxLead = 1 beat covers observed VOCALOID drift
  //     without stealing lyrics from adjacent notes (which are typically
  //     >= 1 beat apart in melody lines).
  //   - Lyrics are consumed in tick order; once a lyric matches a note it
  //     is not reused.
  const exactTolerance = Math.max(1, Math.floor(ticksPerBeat / 100));
  const maxLead = ticksPerBeat; // 1 beat
  let lyricIdx = 0;
  for (const note of trimmed) {
    // Skip lyrics that are too early for this note (outside maxLead window)
    while (
      lyricIdx < sortedLyrics.length &&
      note.startTicks - sortedLyrics[lyricIdx].ticks > maxLead
    ) {
      lyricIdx++;
    }
    if (lyricIdx >= sortedLyrics.length) break;
    const diff = note.startTicks - sortedLyrics[lyricIdx].ticks;
    if (diff >= -exactTolerance) {
      // lyric is at/after note (within exactTolerance) or before note
      // (within maxLead) — accept it.
      note.lyric = sortedLyrics[lyricIdx].text;
      lyricIdx++;
    }
    // else: lyric is too late for this note; leave it for the next note
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

  // Lyrics: @tonejs/midi drops track-level lyric meta events, so extract
  // them directly from the raw bytes. Use tonejs header lyrics only as a
  // fallback when raw extraction finds nothing (e.g. malformed input where
  // our parser missed events but tonejs caught them) — otherwise the two
  // would duplicate and break tick-based matching.
  const { byChannel: rawByChannel, global: rawGlobal } = _extractRawLyrics(buffer);
  const rawLyrics = [...rawGlobal];
  for (const [, channelLyrics] of rawByChannel) {
    rawLyrics.push(...channelLyrics);
  }
  const headerLyrics = rawLyrics.length === 0
    ? midi.header.meta
        .filter((m) => m.type === 'lyrics')
        .map((m) => ({ ticks: m.ticks, text: m.text || '' }))
    : [];
  const lyrics = [...rawLyrics, ...headerLyrics];

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

  // @tonejs/midi drops track-level lyric meta events. Extract them from the
  // raw bytes and bucket by channel so each virtual track can recover its
  // own lyrics. Use tonejs header lyrics only as a fallback when raw
  // extraction finds nothing (avoids duplicating lyrics that tonejs already
  // hoisted from track 0 to the header).
  const { byChannel: rawByChannel, global: rawGlobal } = _extractRawLyrics(buffer);
  const hasRawLyrics = rawGlobal.length > 0
    || [...rawByChannel.values()].some((v) => v.length > 0);
  const headerLyrics = hasRawLyrics
    ? []
    : midi.header.meta
        .filter((m) => m.type === 'lyrics')
        .map((m) => ({ ticks: m.ticks, text: m.text || '' }));
  const globalLyrics = [...rawGlobal, ...headerLyrics];

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

    // Prefer lyrics extracted from this track's channel; fall back to global
    // lyrics (header / tempo track) when the channel has none.
    const channelLyrics = rawByChannel.get(track.channel);
    const trackLyrics = channelLyrics && channelLyrics.length > 0
      ? channelLyrics
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

/**
 * Extract project-level metadata from a MIDI file: the first tempo event
 * (BPM) and the first time-signature event. Returns null when neither is
 * present so callers can decide whether to fall back to defaults.
 *
 * Returned shape:
 *   {
 *     bpm: number | null,                 // e.g. 154
 *     timeSignature: [number, number] | null  // e.g. [4, 4]
 *   }
 *
 * @param {ArrayBuffer} buffer
 * @returns {{bpm:number|null, timeSignature:[number,number]|null}}
 */
function parseMidiProjectInfo(buffer) {
  _validateMidiBuffer(buffer);
  const midi = new Midi(buffer);

  let bpm = null;
  if (midi.header.tempos && midi.header.tempos.length > 0) {
    // Use the first tempo event — most MIDI files set tempo once at tick 0.
    // If the file has multiple tempo changes, the first one is the project's
    // initial BPM and is what the user typically wants to sync.
    const tempo = midi.header.tempos[0];
    if (typeof tempo.bpm === 'number' && isFinite(tempo.bpm) && tempo.bpm > 0) {
      bpm = Math.round(tempo.bpm);
    }
  }

  let timeSignature = null;
  if (midi.header.timeSignatures && midi.header.timeSignatures.length > 0) {
    const ts = midi.header.timeSignatures[0];
    if (Array.isArray(ts.timeSignature)
      && ts.timeSignature.length === 2
      && Number.isInteger(ts.timeSignature[0]) && ts.timeSignature[0] > 0
      && Number.isInteger(ts.timeSignature[1]) && ts.timeSignature[1] > 0) {
      timeSignature = [ts.timeSignature[0], ts.timeSignature[1]];
    }
  }

  return { bpm, timeSignature };
}

module.exports = { parseMidiFile, parseMidiFileMultiTrack, parseMidiProjectInfo };
