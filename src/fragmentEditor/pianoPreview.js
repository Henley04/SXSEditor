import { t } from '../i18n/index.js';
import {
  getCurrentProject,
  getCurrentFragment,
  getFragmentIsPlaying,
  getFragmentPlayStartPosition, setFragmentPlayStartPosition,
  setFragmentCurrentTime,
} from './state.js';
import { getClippedNotes, render } from './canvasRenderer.js';
import { stopFragmentPlayback } from './audioPlayback.js';
import { updateFragmentPlayButton } from './uiControls.js';

// Internal piano preview state (independent from SVS vocal pipeline)
// Uses Web Audio API oscillators for instant MIDI audition without AI inference.
let pianoContext = null;
let pianoGain = null;
let pianoSources = [];
let pianoIsPlaying = false;
let pianoPlaybackStartTime = 0;
let pianoPlaybackOffset = 0;
let pianoPlayheadRaf = null;
let pianoDurationSec = 0;

// visibility handler shared with audioPlayback logic
let _visibilityHandlerRegistered = false;
let _pianoUpdateFn = null;

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function centsToMult(cents) {
  return Math.pow(2, cents / 1200);
}

function ensureVisibilityHandler() {
  if (_visibilityHandlerRegistered) return;
  _visibilityHandlerRegistered = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (pianoPlayheadRaf) {
        cancelAnimationFrame(pianoPlayheadRaf);
        pianoPlayheadRaf = null;
      }
    } else if (pianoIsPlaying && _pianoUpdateFn && !pianoPlayheadRaf) {
      pianoPlayheadRaf = requestAnimationFrame(_pianoUpdateFn);
    }
  });
}

function schedulePianoNote(ctx, filter, note, beatDur, baseTime, offsetSec) {
  const noteStartSec = note.start * beatDur;
  const noteEndSec = (note.start + note.duration) * beatDur;

  // Skip notes that end before playback offset
  if (noteEndSec <= offsetSec) return null;

  const startSecRelative = Math.max(0, noteStartSec - offsetSec);
  const startAbs = baseTime + startSecRelative;

  // If truncated (playhead inside note), shorten attack and adjust duration
  const truncated = noteStartSec < offsetSec;
  const truncatedOffsetBeats = truncated ? (offsetSec - noteStartSec) : 0;
  const truncatedOffsetSec = truncatedOffsetBeats * beatDur;
  const remainingDurSec = noteEndSec - Math.max(noteStartSec, offsetSec);

  const durSec = Math.max(0.05, remainingDurSec);

  const baseHz = midiToHz(note.pitch);
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(baseHz, startAbs);

  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(baseHz * 2, startAbs);

  // Slight detune for piano-like chorus (only when not truncated to keep stable)
  if (!truncated) {
    try { osc2.detune.setValueAtTime(7, startAbs); } catch (_) {}
  }

  const env = ctx.createGain();
  const peak = 0.5;
  const attack = truncated ? 0.001 : 0.005;
  const release = 0.12;
  const envEnd = startAbs + durSec + release;

  // Apply fadeIn/fadeOut envelope if present (mirrors vocal fade for consistency)
  // For piano we bake fade into gain envelope linearly at boundaries.
  const fadeInSec = note.fadeIn ? note.fadeIn / 1000 : 0;
  const fadeOutSec = note.fadeOut ? note.fadeOut / 1000 : 0;

  env.gain.setValueAtTime(0.0001, startAbs);
  env.gain.linearRampToValueAtTime(peak, startAbs + attack);
  // If fadeIn is active and note was not truncated, ramp from 0
  if (!truncated && fadeInSec > 0 && fadeInSec > attack) {
    env.gain.setValueAtTime(0.0001, startAbs);
    env.gain.linearRampToValueAtTime(peak, startAbs + Math.min(fadeInSec, durSec));
  }
  env.gain.setValueAtTime(peak, startAbs + Math.min(durSec * 0.25, 0.12) + attack);
  env.gain.linearRampToValueAtTime(peak * 0.55, startAbs + durSec);
  // fadeOut: ramp to 0 earlier
  if (fadeOutSec > 0 && fadeOutSec < durSec) {
    env.gain.setValueAtTime(peak * 0.55, startAbs + durSec - fadeOutSec);
    env.gain.linearRampToValueAtTime(0.0001, startAbs + durSec);
    // Release after fadeOut
    env.gain.setValueAtTime(0.0001, startAbs + durSec);
    env.gain.exponentialRampToValueAtTime(0.0001, envEnd);
  } else {
    env.gain.setValueAtTime(peak * 0.55, startAbs + durSec);
    env.gain.exponentialRampToValueAtTime(0.0001, envEnd);
  }

  const g1 = ctx.createGain();
  const g2 = ctx.createGain();
  g1.gain.value = 0.7;
  g2.gain.value = 0.3;

  osc.connect(g1);
  osc2.connect(g2);
  // Second harmonic through slightly lower gain for brightness without harshness
  g1.connect(env);
  g2.connect(env);
  env.connect(filter);

  // Pitch bend / vibrato support: if note has vibrato enabled, generate pitch bend cents
  // similar to vocal vibrato but simplified for piano audition.
  // This keeps piano preview roughly in sync with intended vocal pitch contour.
  if (note.vibrato && note.vibrato.enabled) {
    const vib = note.vibrato;
    const vibStartBeat = note.start + vib.start * note.duration;
    const vibLenBeat = vib.length * note.duration;
    const vibEndBeat = vibStartBeat + vibLenBeat;
    // Sample vibrato at 10ms intervals for smooth pitch curve
    const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
    const sampleStep = 0.01; // seconds
    const depthCents = vib.depth;
    const rate = vib.rate;
    const fadeInRatio = vib.fadeIn;
    let t = vibStartBeat * beatDur;
    const vibStartSec = vibStartBeat * beatDur;
    const vibEndSec = vibEndBeat * beatDur;
    // Only schedule if vibrato overlaps with scheduled region
    if (vibEndSec > offsetSec && vibStartSec < offsetSec + durSec + startSecRelative) {
      // Schedule piecewise frequency changes
      // For simplicity, use setValueAtTime at each sample point
      let lastTime = Math.max(vibStartSec, offsetSec);
      while (lastTime <= Math.min(vibEndSec, noteEndSec)) {
        const vibPos = (lastTime / beatDur - vibStartBeat) / (vibEndBeat - vibStartBeat);
        let envFactor = 1;
        if (fadeInRatio > 0 && vibPos < fadeInRatio) {
          envFactor = vibPos / fadeInRatio;
        }
        const vibTimeSec = lastTime - vibStartSec;
        const cents = depthCents * Math.sin(2 * Math.PI * rate * vibTimeSec) * envFactor;
        const absTime = baseTime + (lastTime - offsetSec);
        if (absTime >= startAbs && absTime <= envEnd) {
          osc.frequency.setValueAtTime(baseHz * centsToMult(cents), absTime);
          osc2.frequency.setValueAtTime(baseHz * 2 * centsToMult(cents), absTime);
        }
        lastTime += sampleStep;
      }
    }
  }

  osc.start(startAbs);
  osc2.start(startAbs);
  osc.stop(envEnd + 0.02);
  osc2.stop(envEnd + 0.02);

  const onEndedCleanup = () => {
    try { osc.disconnect(); } catch (_) {}
    try { osc2.disconnect(); } catch (_) {}
    try { g1.disconnect(); } catch (_) {}
    try { g2.disconnect(); } catch (_) {}
    try { env.disconnect(); } catch (_) {}
  };
  osc.onended = onEndedCleanup;
  osc2.onended = onEndedCleanup;

  return [osc, osc2, env, g1, g2];
}

export function getIsPianoPlaying() {
  return pianoIsPlaying;
}

export function updatePianoPlayButton() {
  const btn = document.getElementById('btn-piano-preview');
  if (!btn) return;
  if (pianoIsPlaying) {
    btn.textContent = t('fragment.pianoStop');
    btn.classList.add('playing');
    btn.title = t('fragment.pianoStopHint');
  } else {
    btn.textContent = t('fragment.pianoPreview');
    btn.classList.remove('playing');
    btn.title = t('fragment.pianoPreviewHint');
  }
}

export function stopPianoPreview() {
  pianoIsPlaying = false;
  if (pianoPlayheadRaf) {
    cancelAnimationFrame(pianoPlayheadRaf);
    pianoPlayheadRaf = null;
  }
  for (const s of pianoSources) {
    try { s.stop(); } catch (_) {}
    try { s.disconnect(); } catch (_) {}
  }
  pianoSources = [];
  // Don't close context immediately — keep for quick replay, but disconnect gain
  if (pianoGain) {
    try { pianoGain.disconnect(); } catch (_) {}
    pianoGain = null;
  }
  updatePianoPlayButton();
  render();
}

function updatePianoPlayhead() {
  ensureVisibilityHandler();
  _pianoUpdateFn = updatePianoPlayhead;
  if (!pianoIsPlaying || !pianoContext) return;

  const elapsed = pianoContext.currentTime - pianoPlaybackStartTime;
  const currentTime = pianoPlaybackOffset + elapsed;
  setFragmentCurrentTime(currentTime);

  if (currentTime >= pianoDurationSec) {
    stopPianoPreview();
    setFragmentCurrentTime(0);
    setFragmentPlayStartPosition(0);
    updateFragmentPlayButton();
    updatePianoPlayButton();
    render();
    return;
  }

  render();
  pianoPlayheadRaf = requestAnimationFrame(updatePianoPlayhead);
}

export async function playPianoPreview() {
  const notes = getClippedNotes();
  if (!notes || notes.length === 0) {
    return false;
  }

  // Mutual exclusion: stop vocal playback if it's playing or synthesizing
  if (getFragmentIsPlaying()) {
    stopFragmentPlayback();
  }

  // If already playing, stop first (toggle behavior is handled by caller)
  if (pianoIsPlaying) {
    stopPianoPreview();
  }

  const bpm = getCurrentProject() ? getCurrentProject().bpm : 120;
  const beatDur = 60 / bpm;

  const fragment = getCurrentFragment();
  const fragDurationBeats = fragment && fragment.duration ? fragment.duration : null;
  let durationSec;
  if (fragDurationBeats) {
    durationSec = (fragDurationBeats / bpm) * 60;
  } else {
    const lastNote = notes.slice().sort((a, b) => a.start - b.start).pop();
    const lastBeat = lastNote ? lastNote.start + lastNote.duration : 4;
    durationSec = lastBeat * beatDur;
  }
  pianoDurationSec = durationSec;

  const offsetSec = getFragmentPlayStartPosition() || 0;
  // Clamp offset
  const clampedOffset = Math.min(offsetSec, Math.max(0, durationSec - 0.01));

  try {
    if (!pianoContext || pianoContext.state === 'closed') {
      pianoContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (pianoContext.state === 'suspended') {
      await pianoContext.resume();
    }
  } catch (_) {
    return false;
  }

  const ctx = pianoContext;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 4200;
  filter.Q.value = 0.7;

  pianoGain = ctx.createGain();
  // Use same master gain concept — respect system volume if available
  pianoGain.gain.value = 0.9;
  pianoGain.connect(ctx.destination);
  filter.connect(pianoGain);

  const baseTime = ctx.currentTime + 0.06;
  const sources = [];
  const sorted = notes.slice().sort((a, b) => a.start - b.start);

  for (const note of sorted) {
    const scheduled = schedulePianoNote(ctx, filter, note, beatDur, baseTime, clampedOffset);
    if (scheduled) {
      sources.push(...scheduled);
    }
  }

  // If no notes scheduled (all before offset), treat as finished
  if (sources.length === 0) {
    try { filter.disconnect(); } catch (_) {}
    try { pianoGain.disconnect(); } catch (_) {}
    pianoGain = null;
    return false;
  }

  pianoSources = sources;
  pianoIsPlaying = true;
  pianoPlaybackStartTime = baseTime - 0.06; // align with ctx.currentTime + 0.06 offset
  // Actually we want playbackStartTime = ctx.currentTime such that currentTime = offset + (ctx.currentTime - playbackStartTime)
  // So set to ctx.currentTime
  pianoPlaybackStartTime = ctx.currentTime;
  pianoPlaybackOffset = clampedOffset;
  setFragmentCurrentTime(clampedOffset);

  updatePianoPlayButton();
  updatePianoPlayhead();
  render();

  // Auto-stop when the longest scheduled source ends (fallback via timeout)
  const remainingSec = pianoDurationSec - clampedOffset + 0.3; // include tail
  setTimeout(() => {
    if (pianoIsPlaying) {
      const expectedEnd = pianoPlaybackOffset + (pianoContext ? (pianoContext.currentTime - pianoPlaybackStartTime) : 0);
      if (expectedEnd >= pianoDurationSec - 0.05) {
        stopPianoPreview();
        setFragmentCurrentTime(0);
        setFragmentPlayStartPosition(0);
        render();
      }
    }
  }, (remainingSec + 0.5) * 1000);

  return true;
}

export async function seekPianoPreview(newStartTime) {
  // Stop current and restart from new position if playing, otherwise just update position
  const wasPlaying = pianoIsPlaying;
  stopPianoPreview();
  setFragmentPlayStartPosition(newStartTime);
  setFragmentCurrentTime(newStartTime);
  render();
  if (wasPlaying) {
    await playPianoPreview();
  }
}
