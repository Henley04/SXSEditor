import { t } from '../i18n/index.js';

// 静音阈值三档预设（作用于归一化后音频的 RMS）
export const THRESHOLD_VALUES = { low: 0.003, mid: 0.006, high: 0.01 };

// 平滑档位 -> 中值窗口（与主进程 pitchPostprocess.smoothingWindow 对应）
export const SMOOTHING_PRESETS = { low: 'low', medium: 'medium', high: 'high' };

const PRESET_OPTIONS = {
  popMale: { f0Min: 80, f0Max: 440, threshold: 'mid', smoothing: 'medium', quantization: 'strict' },
  folkFemale: { f0Min: 196, f0Max: 1050, threshold: 'low', smoothing: 'high', quantization: 'pitchbend' },
  traditional: { f0Min: 98, f0Max: 1100, threshold: 'low', smoothing: 'low', quantization: 'pitchbend' },
  childHigh: { f0Min: 262, f0Max: 1200, threshold: 'low', smoothing: 'medium', quantization: 'pitchbend' },
  custom: { f0Min: 80, f0Max: 880, threshold: 'mid', smoothing: 'medium', quantization: 'strict' },
};

export const PRESETS = [
  { id: 'popMale', label: 'popMale' },
  { id: 'folkFemale', label: 'folkFemale' },
  { id: 'traditional', label: 'traditional' },
  { id: 'childHigh', label: 'childHigh' },
  { id: 'custom', label: 'custom' },
];

export function presetLabel(id) {
  return t(`preprocess.preset.${id}`);
}

const DEFAULT_OPTIONS = {
  preset: 'custom',
  threshold: 'mid',
  smoothing: 'medium',
  quantization: 'strict',
  f0Min: 80,
  f0Max: 880,
  f0RangeAuto: true,
  minNoteDuration: 0.05,
  bpm: 120,
  autoBpm: false,
  normalize: true,
};

const STORAGE_KEY = 'sxseditor.preprocess.options.v1';

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

export function getOptions() {
  const stored = loadStored();
  return { ...DEFAULT_OPTIONS, ...(stored || {}) };
}

export function saveOptions(options) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch (_) {}
}

export function applyPreset(presetId) {
  const base = PRESET_OPTIONS[presetId] || PRESET_OPTIONS.custom;
  return { ...DEFAULT_OPTIONS, ...base, preset: presetId };
}

/**
 * 把 UI 选项解析为主进程可用的提取参数。
 * thresholdEnabled 始终开启（RMS 门限），thresholdValue 依档位取值。
 */
export function resolveOptions(options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  return {
    thresholdEnabled: true,
    threshold: THRESHOLD_VALUES[opts.threshold] ?? THRESHOLD_VALUES.mid,
    f0Min: opts.f0Min,
    f0Max: opts.f0Max,
    f0RangeAuto: opts.f0RangeAuto,
    smoothing: opts.smoothing,
    quantization: opts.quantization,
    minNoteDuration: opts.minNoteDuration,
    bpm: opts.bpm,
    autoBpm: opts.autoBpm,
    normalize: opts.normalize,
  };
}