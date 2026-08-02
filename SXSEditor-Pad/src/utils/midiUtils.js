/**
 * midiUtils.js
 * MIDI utilities for SXSEditor-Pad.
 * Parses MIDI file data, converts between MIDI notes and project fragments,
 * and provides common MIDI helper functions.
 *
 * @module utils/midiUtils
 */

import { Midi } from '@tonejs/midi';

/**
 * @typedef {Object} MidiNote
 * @property {number} midi - MIDI note number (0-127)
 * @property {string} name - Note name (e.g., 'C4', 'A#5')
 * @property {number} startTime - Start time in seconds
 * @property {number} endTime - End time in seconds
 * @property {number} duration - Duration in seconds
 * @property {number} velocity - Note velocity (0-1)
 */

/**
 * @typedef {Object} ProjectFragment
 * @property {number} start - Start time in beats
 * @property {number} duration - Duration in beats
 * @property {number} pitch - Pitch value
 * @property {number} velocity - Velocity value
 * @property {string} [lyric] - Optional lyric text
 * @property {string} [phoneme] - Optional phoneme
 */

/**
 * MIDI note number to scientific pitch name mapping.
 * Index 0 = C, 1 = C#, ..., 11 = B
 * @type {string[]}
 */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Regular expression for parsing note names (e.g., 'C4', 'A#5', 'Db3').
 * @type {RegExp}
 */
const NOTE_NAME_REGEX = /^([A-Ga-g])([#b]?)(-?\d+)$/;

/**
 * Map of flat note names to their sharp equivalents.
 * @type {Object<string, string>}
 */
const FLAT_TO_SHARP = {
  'Db': 'C#',
  'Eb': 'D#',
  'Gb': 'F#',
  'Ab': 'G#',
  'Bb': 'A#',
};

/**
 * Convert a MIDI note number to its scientific pitch name.
 * E.g., 60 -> 'C4', 61 -> 'C#4'
 *
 * @param {number} noteNumber - MIDI note number (0-127)
 * @returns {string} Note name in scientific pitch notation
 */
export function noteNumberToName(noteNumber) {
  if (typeof noteNumber !== 'number' || !Number.isFinite(noteNumber)) {
    return 'Unknown';
  }

  const midi = Math.round(noteNumber);
  if (midi < 0 || midi > 127) {
    return `Note${midi}`;
  }

  const octave = Math.floor(midi / 12) - 1;
  const noteIndex = midi % 12;
  return `${NOTE_NAMES[noteIndex]}${octave}`;
}

/**
 * Convert a scientific pitch name to a MIDI note number.
 * E.g., 'C4' -> 60, 'C#4' -> 61, 'Db4' -> 61
 *
 * @param {string} noteName - Note name in scientific pitch notation
 * @returns {number|null} MIDI note number, or null if parsing fails
 */
export function nameToNoteNumber(noteName) {
  if (typeof noteName !== 'string') return null;

  const match = noteName.trim().match(NOTE_NAME_REGEX);
  if (!match) return null;

  let [, note, accidental, octaveStr] = match;
  const octave = parseInt(octaveStr, 10);

  // Handle flats by converting to sharps
  if (accidental === 'b') {
    const sharpName = FLAT_TO_SHARP[note + accidental];
    if (!sharpName) return null;
    note = sharpName[0];
    accidental = '#';
  }

  const noteIndex = NOTE_NAMES.indexOf(note.toUpperCase() + accidental);
  if (noteIndex === -1) return null;

  return (octave + 1) * 12 + noteIndex;
}

/**
 * Scale a velocity value from one range to another.
 *
 * @param {number} velocity - Input velocity
 * @param {number} [minIn=0] - Input range minimum
 * @param {number} [maxIn=1] - Input range maximum
 * @param {number} [minOut=0] - Output range minimum
 * @param {number} [maxOut=1] - Output range maximum
 * @returns {number} Scaled velocity
 */
export function scaleVelocity(velocity, minIn = 0, maxIn = 1, minOut = 0, maxOut = 1) {
  if (typeof velocity !== 'number') return minOut;

  const clamped = Math.max(minIn, Math.min(maxIn, velocity));
  if (maxIn === minIn) return minOut;

  const ratio = (clamped - minIn) / (maxIn - minIn);
  return minOut + ratio * (maxOut - minOut);
}

/**
 * Parse MIDI file data from an ArrayBuffer or Uint8Array.
 *
 * @param {ArrayBuffer|Uint8Array} data - MIDI file binary data
 * @returns {Midi} Parsed MIDI object
 */
export function parseMidiData(data) {
  if (data instanceof Uint8Array) {
    return new Midi(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Midi(new Uint8Array(data));
  }
  throw new Error('MIDI data must be an ArrayBuffer or Uint8Array');
}

/**
 * Convert MIDI notes to project fragments.
 * Each track's notes are converted to fragments with timing
 * converted from seconds to beats.
 *
 * @param {Midi} midi - Parsed MIDI object
 * @param {Object} [options] - Conversion options
 * @param {number} [options.bpm=120] - Beats per minute for timing conversion
 * @param {number} [options.velocityScale=1] - Velocity scaling factor
 * @returns {ProjectFragment[]} Array of project fragments
 */
export function midiNotesToFragments(midi, options = {}) {
  if (!midi) return [];

  const { bpm = 120, velocityScale = 1 } = options;
  const fragments = [];
  const secondsPerBeat = 60 / bpm;

  for (const track of midi.tracks) {
    for (const note of track.notes) {
      const fragment = {
        start: note.time / secondsPerBeat,
        duration: note.duration / secondsPerBeat,
        pitch: note.midi,
        velocity: scaleVelocity(note.velocity, 0, 1, 0, velocityScale),
      };

      // Try to extract lyric from note name if present
      if (note.name && note.name !== noteNumberToName(note.midi)) {
        fragment.lyric = note.name;
      }

      fragments.push(fragment);
    }
  }

  // Sort fragments by start time
  fragments.sort((a, b) => a.start - b.start);

  return fragments;
}

/**
 * Convert project fragments to MIDI notes.
 *
 * @param {ProjectFragment[]} fragments - Array of project fragments
 * @param {Object} [options] - Conversion options
 * @param {number} [options.bpm=120] - Beats per minute for timing conversion
 * @param {number} [options.velocityScale=1] - Velocity scaling factor
 * @param {number} [options.trackIndex=0] - MIDI track index to write to
 * @returns {Midi} Generated MIDI object
 */
export function fragmentsToMidi(fragments, options = {}) {
  const { bpm = 120, velocityScale = 1, trackIndex = 0 } = options;
  const secondsPerBeat = 60 / bpm;

  const midi = new Midi();
  midi.header.setTempo(bpm);

  // Ensure we have enough tracks
  while (midi.tracks.length <= trackIndex) {
    midi.addTrack();
  }

  const track = midi.tracks[trackIndex];
  track.name = 'SXSEditor-Pad';

  for (const fragment of fragments) {
    const startTime = fragment.start * secondsPerBeat;
    const duration = fragment.duration * secondsPerBeat;
    const velocity = scaleVelocity(fragment.velocity, 0, 1, 0, 1);

    track.addNote({
      midi: Math.round(fragment.pitch),
      time: startTime,
      duration: duration,
      velocity: velocity,
      name: fragment.lyric || noteNumberToName(fragment.pitch),
    });
  }

  return midi;
}

/**
 * Convert MIDI object to a Uint8Array for file export.
 *
 * @param {Midi} midi - MIDI object to encode
 * @returns {Uint8Array} Encoded MIDI file data
 */
export function midiToBytes(midi) {
  if (!midi) throw new Error('MIDI object is required');
  return midi.toArray();
}

/**
 * Get the frequency of a MIDI note number.
 * Uses A4 = 440Hz standard tuning.
 *
 * @param {number} noteNumber - MIDI note number
 * @returns {number} Frequency in Hz
 */
export function noteNumberToFrequency(noteNumber) {
  return 440 * Math.pow(2, (noteNumber - 69) / 12);
}

/**
 * Get the MIDI note number closest to a given frequency.
 *
 * @param {number} frequency - Frequency in Hz
 * @returns {number} MIDI note number
 */
export function frequencyToNoteNumber(frequency) {
  if (frequency <= 0) return 0;
  return 12 * Math.log2(frequency / 440) + 69;
}

export default {
  noteNumberToName,
  nameToNoteNumber,
  scaleVelocity,
  parseMidiData,
  midiNotesToFragments,
  fragmentsToMidi,
  midiToBytes,
  noteNumberToFrequency,
  frequencyToNoteNumber,
};