export const PIANO_KEY_WIDTH = 80;
export const NOTE_HEIGHT = 16;
export const BEAT_WIDTH = 80;
export const HEADER_HEIGHT = 24;
export const PARAM_CURVE_HEIGHT = 80;
export const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
export const PITCH_CURVE_SAMPLE_INTERVAL = 0.02;

export const PARAM_MODES = {
  MIDI: 'MIDI',
  VOL: 'VOL',
  PAN: 'PAN',
  F0: 'F0',
};

export const PHONEME_COLORS = [
  '#5b8def', '#4ade80', '#f87171', '#facc15', '#a78bfa',
  '#38bdf8', '#fb923c', '#e879f9', '#34d399', '#f472b6',
];

export const PHONEME_CACHE_MAX = 500;
export const PARAM_PANEL_HEADER_HEIGHT = 28;

// ==================== Motion / Easing ====================
// Durations (ms) for JS-driven rAF animations (snap-back, selection ring, etc.)
export const MOTION = {
  FAST: 120,   // button press / hover
  BASE: 200,   // panel toggle / mode switch
  SLOW: 320,   // overlay fade
  PRESS: 90,   // mouse-hold press feedback
  SNAP: 130,   // drag-release snap-to-grid settle
};

// Easing functions for JS-driven rAF animations (mirrors CSS --ease-* tokens)
export const EASING = {
  OUT: (t) => 1 - Math.pow(1 - t, 3),              // ease-out-cubic, ~cubic-bezier(0.16,1,0.3,1)
  IN_OUT: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2), // ease-in-out-cubic
  OUT_BACK: (t) => {
    const c1 = 1.56;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); // ~cubic-bezier(0.34,1.56,0.64,1)
  },
  OUT_QUINT: (t) => 1 - Math.pow(1 - t, 5),         // ~cubic-bezier(0.22,1,0.36,1)
};
