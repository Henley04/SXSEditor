import { state, dom } from './state.js';
import { t } from '../i18n/index.js';
import { setLabel } from '../icons/iconHelper.js';
import { stopPlayback } from './playback.js';

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function centsToMult(cents) {
  return Math.pow(2, cents / 1200);
}

// 注意：调用处只传 (ctx, note, beatDur, filter)。此前多出的 dest 形参让实参
// 整体错位（note 实为 number、filter 为 undefined），filter.type 直接抛 TypeError。
function schedulePianoNote(ctx, note, beatDur, filter) {
  const startSec = note.start * beatDur;
  const durSec = Math.max(0.05, note.duration * beatDur);

  const baseHz = midiToHz(note.pitch);
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(baseHz, startSec);

  // 明亮泛音增强钢琴感
  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(baseHz * 2, startSec);

  const env = ctx.createGain();
  const peak = 0.5;
  const attack = 0.005;
  const release = 0.08;
  const envEnd = startSec + durSec + release;
  env.gain.setValueAtTime(0.0001, startSec);
  env.gain.linearRampToValueAtTime(peak, startSec + attack);
  env.gain.setValueAtTime(peak, startSec + Math.min(durSec * 0.3, 0.1) + attack);
  env.gain.linearRampToValueAtTime(peak * 0.55, startSec + durSec);
  env.gain.setValueAtTime(peak * 0.55, startSec + durSec);
  env.gain.exponentialRampToValueAtTime(0.0001, envEnd);

  const g1 = ctx.createGain();
  const g2 = ctx.createGain();
  g1.gain.value = 0.7;
  g2.gain.value = 0.3;

  osc.connect(g1);
  osc2.connect(g2);
  g1.connect(env);
  g2.connect(env);
  env.connect(filter);

  // 滑音 / Pitch Bend：逐帧设置频率
  if (note.bend && note.bend.length) {
    for (const b of note.bend) {
      const t = startSec + b.time;
      if (t >= startSec && t <= envEnd) {
        osc.frequency.setValueAtTime(baseHz * centsToMult(b.cents), t);
        osc2.frequency.setValueAtTime(baseHz * 2 * centsToMult(b.cents), t);
      }
    }
  }

  osc.start(startSec);
  osc2.start(startSec);
  osc.stop(envEnd + 0.02);
  osc2.stop(envEnd + 0.02);

  const sources = [osc, osc2];
  sources.forEach((s) => {
    s.onended = () => { try { s.disconnect(); } catch (_) {} };
  });
  return sources;
}

export function stopSynth() {
  if (state.synthPlaying) {
    for (const s of state.synthSources) {
      try { s.stop(); } catch (_) {}
      try { s.disconnect(); } catch (_) {}
    }
  }
  state.synthSources = [];
  state.synthPlaying = false;
  if (state.synthContext && state.synthContext.state !== 'closed') {
    try { state.synthContext.close(); } catch (_) {}
  }
  state.synthContext = null;
  if (dom.btnAudition) setLabel(dom.btnAudition, t('preprocess.auditionSynth'), { icon: 'music' });
}

export async function startSynth() {
  const notes = state.pianoRoll ? state.pianoRoll.notes : [];
  if (!notes || notes.length === 0) {
    return false;
  }
  // 试听的 1 beat 时长必须与钢琴卷轴的时间映射使用同一 BPM（pianoRoll.bpm），
  // 否则同一批音符在卷轴上画的位置和听到的节奏对不上。
  const beatBpm = (state.pianoRoll && state.pianoRoll.bpm) || 120;
  const beatDur = 60 / beatBpm;

  try {
    if (!state.synthContext || state.synthContext.state === 'closed') {
      state.synthContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (state.synthContext.state === 'suspended') {
      await state.synthContext.resume();
    }
  } catch (_) {
    return false;
  }

  const ctx = state.synthContext;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 3200;
  filter.connect(ctx.destination);

  const sources = [];
  const sorted = notes.slice().sort((a, b) => a.start - b.start);
  for (const note of sorted) {
    const s = schedulePianoNote(ctx, note, beatDur, filter);
    sources.push(...s);
  }
  state.synthSources = sources;
  state.synthPlaying = true;
  if (dom.btnAudition) setLabel(dom.btnAudition, t('preprocess.stopAudition'), { icon: 'stop' });
  return true;
}

export function toggleSynth() {
  if (state.synthPlaying) {
    stopSynth();
    return;
  }
  stopPlayback();
  startSynth();
}