/**
 * basicPitch.js
 * Basic Pitch detector for SXSEditor-Pad.
 *
 * Uses the Basic Pitch ONNX model for F0 extraction and
 * MIDI note import from audio.
 *
 * Basic Pitch is a lightweight pitch detection model that
 * outputs note events and pitch contours from audio.
 *
 * Reference: https://github.com/spotify/basic-pitch
 *
 * @module inference/basicPitch
 */

import { LOG_PREFIX } from './pipeline/constants.js';
import { getSession, createSession } from './webnn/sessionManager.js';
import { initOrt } from './webnn/ortSetup.js';

/**
 * @typedef {Object} NoteEvent
 * @property {number} startTime - Note onset time (seconds)
 * @property {number} endTime - Note offset time (seconds)
 * @property {number} pitch - MIDI pitch number (0-127)
 * @property {number} amplitude - Note amplitude (0-1)
 */

/**
 * @typedef {Object} PitchResult
 * @property {NoteEvent[]} notes - Detected note events
 * @property {Float32Array} pitchContour - Frame-level pitch contour (Hz)
 * @property {number} sampleRate - Audio sample rate
 * @property {number} hopLength - Hop length used for frame analysis
 */

/**
 * Run the Basic Pitch model on audio data.
 *
 * @param {Float32Array} audio - Audio samples (44100 Hz mono)
 * @param {object} [options]
 * @param {number} [options.sampleRate=44100] - Input audio sample rate
 * @param {number} [options.threshold=0.3] - Note onset threshold
 * @returns {Promise<PitchResult>}
 */
export async function detectPitch(audio, options = {}) {
  const { sampleRate = 44100, threshold = 0.3 } = options;

  const ort = await initOrt();
  const sessionMeta = getSession('basic-pitch');

  if (!sessionMeta) {
    throw new Error('Basic Pitch model not loaded. Call loadBasicPitchModel() first.');
  }

  const session = sessionMeta.session;

  // Prepare audio input: resample to 22050 Hz (Basic Pitch input rate)
  const targetSr = 22050;
  const resampledAudio = resampleAudio(audio, sampleRate, targetSr);

  // Create input tensor: [1, 1, audio_len]
  const audioTensor = new ort.Tensor('float32', resampledAudio, [1, 1, resampledAudio.length]);

  // Run inference
  const feeds = {};
  feeds[session.inputNames[0]] = audioTensor;
  const results = await session.run(feeds);

  // Parse outputs
  // Basic Pitch outputs: note_events (frame-level), onset_logits, etc.
  const outputName = session.outputNames[0];
  const outputData = results[outputName];

  // Extract note events from model output
  const notes = parseNoteEvents(outputData, threshold, targetSr);

  // Compute pitch contour
  const pitchContour = computePitchContour(notes, resampledAudio.length, targetSr);

  return {
    notes,
    pitchContour,
    sampleRate: targetSr,
    hopLength: 256, // Basic Pitch default hop length
  };
}

/**
 * Parse note events from the Basic Pitch model output.
 *
 * @param {import('onnxruntime-web').Tensor} outputTensor - Model output
 * @param {number} threshold - Onset threshold
 * @param {number} sampleRate - Audio sample rate
 * @returns {NoteEvent[]}
 */
function parseNoteEvents(outputTensor, threshold, sampleRate) {
  const data = new Float32Array(outputTensor.data);
  const dims = outputTensor.dims;

  // Output shape depends on the model version
  // Typically: [1, 88, frames] for piano-roll style output
  const numNotes = dims.length >= 2 ? dims[dims.length - 2] : 88;
  const numFrames = dims.length >= 1 ? dims[dims.length - 1] : data.length / numNotes;

  const hopLength = 256;
  const frameDuration = hopLength / sampleRate;

  const notes = [];
  let currentNote = null;

  for (let frame = 0; frame < numFrames; frame++) {
    for (let note = 0; note < numNotes; note++) {
      const idx = note * numFrames + frame;
      const amplitude = data[idx] || 0;

      if (amplitude > threshold && !currentNote) {
        // Note onset
        currentNote = {
          startTime: frame * frameDuration,
          endTime: frame * frameDuration,
          pitch: note + 21, // MIDI note (21 = A0, 108 = C8)
          amplitude,
        };
      } else if (amplitude <= threshold && currentNote) {
        // Note offset
        currentNote.endTime = frame * frameDuration;
        notes.push(currentNote);
        currentNote = null;
      }
    }
  }

  // Close any remaining note
  if (currentNote) {
    currentNote.endTime = numFrames * frameDuration;
    notes.push(currentNote);
  }

  return notes;
}

/**
 * Compute a frame-level pitch contour from note events.
 *
 * @param {NoteEvent[]} notes - Detected notes
 * @param {number} numFrames - Total number of frames
 * @param {number} sampleRate - Audio sample rate (for hop length calculation)
 * @returns {Float32Array} Pitch contour (Hz), 0 = unvoiced
 */
function computePitchContour(notes, numFrames, sampleRate) {
  const hopLength = 256;
  const numOutputFrames = Math.ceil(numFrames / hopLength);
  const contour = new Float32Array(numOutputFrames);

  for (const note of notes) {
    const startFrame = Math.round(note.startTime * sampleRate / hopLength);
    const endFrame = Math.round(note.endTime * sampleRate / hopLength);
    const freq = midiToHz(note.pitch);

    for (let f = startFrame; f < Math.min(endFrame, numOutputFrames); f++) {
      if (f >= 0) {
        contour[f] = freq;
      }
    }
  }

  return contour;
}

/**
 * Resample audio to a target sample rate.
 *
 * @param {Float32Array} audio - Input audio
 * @param {number} inputSr - Input sample rate
 * @param {number} targetSr - Target sample rate
 * @returns {Float32Array} Resampled audio
 */
function resampleAudio(audio, inputSr, targetSr) {
  if (inputSr === targetSr) {
    return new Float32Array(audio);
  }

  const ratio = targetSr / inputSr;
  const newLength = Math.round(audio.length * ratio);
  const resampled = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIdx = i / ratio;
    const idxLow = Math.floor(srcIdx);
    const idxHigh = Math.min(idxLow + 1, audio.length - 1);
    const frac = srcIdx - idxLow;
    resampled[i] = audio[idxLow] * (1 - frac) + audio[idxHigh] * frac;
  }

  return resampled;
}

/**
 * Convert MIDI note number to frequency (Hz).
 *
 * @param {number} midiNote - MIDI note number (0-127)
 * @returns {number} Frequency in Hz
 */
export function midiToHz(midiNote) {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

/**
 * Convert frequency (Hz) to MIDI note number.
 *
 * @param {number} hz - Frequency in Hz
 * @returns {number} MIDI note number (float)
 */
export function hzToMidi(hz) {
  if (hz <= 0) return 0;
  return 69 + 12 * Math.log2(hz / 440);
}

/**
 * Import MIDI notes from audio (convenience wrapper).
 *
 * @param {Float32Array} audio - Audio samples
 * @param {object} [options] - Options passed to detectPitch
 * @returns {Promise<NoteEvent[]>} Detected note events
 */
export async function importMidiFromAudio(audio, options = {}) {
  const result = await detectPitch(audio, options);
  return result.notes;
}

/**
 * Load the Basic Pitch model.
 *
 * @param {Uint8Array} modelData - ONNX model data
 * @param {object} [options] - Session creation options
 * @returns {Promise<object>} Session metadata
 */
export async function loadBasicPitchModel(modelData, options = {}) {
  return createSession('basic-pitch', modelData, options);
}

export default {
  detectPitch,
  importMidiFromAudio,
  midiToHz,
  hzToMidi,
  loadBasicPitchModel,
};