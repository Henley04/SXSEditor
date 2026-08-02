import { invoke } from '@tauri-apps/api/core';
import { open, message } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { Midi } from '@tonejs/midi';
import {
  getProject,
  getUI,
  addFragment,
  removeFragmentById,
  updateFragment,
  getFragmentById,
  setSelectedFragmentId,
  setClipboard,
  getClipboard,
  markDirty,
} from './state.js';
import { requestRender } from './timelineRenderer.js';

// ==================== ID Generation ====================

let idCounter = 0;

/**
 * Generate a unique fragment ID.
 */
export function generateFragmentId() {
  idCounter++;
  return `frag_${Date.now()}_${idCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate a unique singer ID.
 */
export function generateSingerId() {
  idCounter++;
  return `singer_${Date.now()}_${idCounter}`;
}

// ==================== Fragment CRUD ====================

/**
 * Create a new fragment with default properties.
 * Returns the created fragment.
 */
export function createFragment(options = {}) {
  const project = getProject();
  const ui = getUI();

  // Find the next available track index
  let trackIndex = 0;
  if (options.trackIndex !== undefined) {
    trackIndex = options.trackIndex;
  } else {
    // Place on the track with the most fragments, or next empty track
    const trackCounts = {};
    for (const f of project.fragments) {
      trackCounts[f.trackIndex] = (trackCounts[f.trackIndex] || 0) + 1;
    }
    // Find the track with the fewest fragments
    let minCount = Infinity;
    for (let t = 0; t <= project.fragments.length; t++) {
      const count = trackCounts[t] || 0;
      if (count <= minCount) {
        minCount = count;
        trackIndex = t;
      }
    }
  }

  // Default start beat: after the current playhead or at the end
  let startBeat = options.startBeat || 0;
  if (startBeat === 0 && project.fragments.length > 0) {
    const maxEnd = Math.max(...project.fragments.map(f => f.startBeat + f.durationBeats));
    startBeat = Math.max(0, Math.ceil(maxEnd));
  }

  const fragment = {
    id: generateFragmentId(),
    label: options.label || '',
    startBeat: Math.max(0, startBeat),
    durationBeats: options.durationBeats || 4,
    trackIndex: Math.max(0, trackIndex),
    singerId: options.singerId || null,
    singerName: options.singerName || '',
    audioPath: options.audioPath || null,
    midiPath: options.midiPath || null,
    pitchData: options.pitchData || null,
    phoneticData: options.phoneticData || null,
    muted: options.muted || false,
    gain: options.gain ?? 1.0,
    pan: options.pan ?? 0.0,
  };

  addFragment(fragment);
  setSelectedFragmentId(fragment.id);
  requestRender();
  return fragment;
}

/**
 * Delete a fragment by ID.
 */
export function deleteFragment(id) {
  const fragment = getFragmentById(id);
  if (!fragment) return false;

  removeFragmentById(id);

  const ui = getUI();
  if (ui.selectedFragmentId === id) {
    setSelectedFragmentId(null);
  }

  requestRender();
  return true;
}

/**
 * Duplicate a fragment.
 */
export function duplicateFragment(id) {
  const original = getFragmentById(id);
  if (!original) return null;

  const newFragment = createFragment({
    label: original.label ? `${original.label} (副本)` : '',
    startBeat: original.startBeat + original.durationBeats + 1,
    durationBeats: original.durationBeats,
    trackIndex: original.trackIndex,
    singerId: original.singerId,
    singerName: original.singerName,
    audioPath: original.audioPath,
    midiPath: original.midiPath,
    pitchData: original.pitchData ? [...original.pitchData] : null,
    phoneticData: original.phoneticData ? [...original.phoneticData] : null,
    muted: original.muted,
    gain: original.gain,
    pan: original.pan,
  });

  return newFragment;
}

/**
 * Copy a fragment to the clipboard.
 */
export function copyFragment(id) {
  const fragment = getFragmentById(id);
  if (!fragment) return false;

  setClipboard({
    type: 'fragment',
    data: {
      label: fragment.label,
      durationBeats: fragment.durationBeats,
      singerId: fragment.singerId,
      singerName: fragment.singerName,
      audioPath: fragment.audioPath,
      midiPath: fragment.midiPath,
      pitchData: fragment.pitchData ? [...fragment.pitchData] : null,
      phoneticData: fragment.phoneticData ? [...fragment.phoneticData] : null,
      muted: fragment.muted,
      gain: fragment.gain,
      pan: fragment.pan,
    },
  });

  return true;
}

/**
 * Paste a fragment from the clipboard at the given position.
 */
export function pasteFragment(startBeat, trackIndex) {
  const clipboard = getClipboard();
  if (!clipboard || clipboard.type !== 'fragment') return null;

  const data = clipboard.data;
  return createFragment({
    label: data.label,
    startBeat: startBeat || 0,
    durationBeats: data.durationBeats,
    trackIndex: trackIndex || 0,
    singerId: data.singerId,
    singerName: data.singerName,
    audioPath: data.audioPath,
    midiPath: data.midiPath,
    pitchData: data.pitchData,
    phoneticData: data.phoneticData,
    muted: data.muted,
    gain: data.gain,
    pan: data.pan,
  });
}

/**
 * Split a fragment at the given beat position.
 * Returns the new fragment (right half) or null if split is not possible.
 */
export function splitFragment(id, splitBeat) {
  const fragment = getFragmentById(id);
  if (!fragment) return null;

  const relativeBeat = splitBeat - fragment.startBeat;
  if (relativeBeat <= 0 || relativeBeat >= fragment.durationBeats) return null;

  const minDuration = 0.25; // minimum 1/16 note
  if (relativeBeat < minDuration || fragment.durationBeats - relativeBeat < minDuration) {
    return null;
  }

  // Shrink the original fragment
  const originalDuration = fragment.durationBeats;
  updateFragment(id, {
    durationBeats: relativeBeat,
  });

  // Create the right half
  const newFragment = createFragment({
    label: fragment.label,
    startBeat: fragment.startBeat + relativeBeat,
    durationBeats: originalDuration - relativeBeat,
    trackIndex: fragment.trackIndex,
    singerId: fragment.singerId,
    singerName: fragment.singerName,
    audioPath: fragment.audioPath,
    midiPath: fragment.midiPath,
    pitchData: fragment.pitchData ? fragment.pitchData.slice(
      Math.floor(relativeBeat / originalDuration * fragment.pitchData.length)
    ) : null,
    phoneticData: fragment.phoneticData ? fragment.phoneticData.slice(
      Math.floor(relativeBeat / originalDuration * fragment.phoneticData.length)
    ) : null,
    muted: fragment.muted,
    gain: fragment.gain,
    pan: fragment.pan,
  });

  requestRender();
  return newFragment;
}

/**
 * Merge two fragments that are adjacent on the same track.
 * Returns the merged fragment or null.
 */
export function mergeFragments(id1, id2) {
  const frag1 = getFragmentById(id1);
  const frag2 = getFragmentById(id2);

  if (!frag1 || !frag2) return null;
  if (frag1.trackIndex !== frag2.trackIndex) return null;

  // Ensure frag1 is the earlier one
  let [left, right] = [frag1, frag2];
  if (left.startBeat > right.startBeat) {
    [left, right] = [right, left];
  }

  // Check adjacency
  const leftEnd = left.startBeat + left.durationBeats;
  if (leftEnd < right.startBeat - 0.01) return null; // not adjacent

  // Merge
  const overlap = leftEnd - right.startBeat;
  const mergedDuration = left.durationBeats + right.durationBeats - overlap;

  // Update the left fragment to cover both
  updateFragment(left.id, {
    durationBeats: mergedDuration,
    audioPath: left.audioPath || right.audioPath,
    midiPath: left.midiPath || right.midiPath,
  });

  // Remove the right fragment
  removeFragmentById(right.id);

  if (getUI().selectedFragmentId === right.id) {
    setSelectedFragmentId(left.id);
  }

  requestRender();
  return getFragmentById(left.id);
}

/**
 * Select all fragments.
 */
export function selectAllFragments() {
  // For now, select the first fragment
  const project = getProject();
  if (project.fragments.length > 0) {
    setSelectedFragmentId(project.fragments[0].id);
    requestRender();
  }
}

// ==================== Audio to MIDI ====================

/**
 * Trigger audio-to-MIDI conversion for a fragment.
 * This dispatches an event so the AI inference module can handle it.
 */
export function triggerAudioToMidi(fragmentId) {
  const fragment = getFragmentById(fragmentId);
  if (!fragment) {
    console.warn('[fragmentOperations] No fragment selected for audio-to-MIDI');
    return;
  }

  if (!fragment.audioPath) {
    message('选中的片段没有关联的音频文件。', { title: 'SXSEditor-Pad', kind: 'warning' });
    return;
  }

  window.dispatchEvent(new CustomEvent('sxs:audio-to-midi-request', {
    detail: { fragmentId },
  }));
}

// ==================== MIDI Import ====================

/**
 * Import a MIDI file and create fragments from it.
 */
export async function importMidiFile() {
  try {
    const filePath = await open({
      filters: [
        { name: 'MIDI Files', extensions: ['mid', 'midi'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      multiple: false,
    });

    if (!filePath) return false;

    const data = await readFile(filePath);
    const midi = new Midi(data);

    const project = getProject();
    const bpm = project.bpm;

    // Create fragments from MIDI tracks
    for (const track of midi.tracks) {
      // Skip percussion tracks
      if (track.isPercussion) continue;

      const trackName = track.name || `Track ${track.trackNumber + 1}`;

      // Group notes into continuous phrases
      const notes = track.notes.sort((a, b) => a.time - b.time);
      if (notes.length === 0) continue;

      // Create a fragment for the entire track
      const startTime = notes[0].time; // in seconds
      const endTime = notes[notes.length - 1].time + notes[notes.length - 1].duration;
      const durationBeats = (endTime - startTime) * (bpm / 60);
      const startBeat = startTime * (bpm / 60);

      // Store pitch data as array of { time, pitch, duration }
      const pitchData = notes.map(n => ({
        time: (n.time - startTime) * (bpm / 60),
        pitch: n.midi,
        duration: n.duration * (bpm / 60),
        velocity: n.velocity,
      }));

      createFragment({
        label: trackName,
        startBeat: Math.max(0, startBeat),
        durationBeats: Math.max(1, durationBeats),
        trackIndex: project.fragments.length,
        singerName: '',
        pitchData,
      });
    }

    requestRender();
    await message(`成功导入 ${midi.tracks.length} 个轨道`, { title: 'SXSEditor-Pad', kind: 'info' });
    return true;
  } catch (err) {
    console.error('[fragmentOperations] MIDI import failed:', err);
    await message(`导入MIDI失败: ${err}`, { title: 'SXSEditor-Pad', kind: 'error' });
    return false;
  }
}

// ==================== Audio Import ====================

/**
 * Import an audio file and create a fragment from it.
 */
export async function importAudioFile() {
  try {
    const filePath = await open({
      filters: [
        { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      multiple: false,
    });

    if (!filePath) return false;

    const data = await readFile(filePath);
    const fileName = filePath.split('/').pop().split('\\').pop();

    // Create a fragment with the audio path
    // The actual audio decoding happens when the user plays it
    const project = getProject();
    const fragment = createFragment({
      label: fileName,
      audioPath: filePath,
      durationBeats: 16, // Default duration, will be updated when audio is loaded
      trackIndex: project.fragments.length,
    });

    requestRender();
    return fragment;
  } catch (err) {
    console.error('[fragmentOperations] Audio import failed:', err);
    await message(`导入音频失败: ${err}`, { title: 'SXSEditor-Pad', kind: 'error' });
    return null;
  }
}