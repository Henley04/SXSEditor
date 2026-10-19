/**
 * 音色 / 后处理参数注册表。
 *
 * 分片编辑器的"音色"lane 与检查器面板都由这张表驱动：
 * 每个参数是一条**独立的自动化曲线**（各自的锚点、各自的量纲与取值范围），
 * 因为百分比、整数帧、毫秒、σ 这些值类型混在同一条曲线里既无法读数也无法插值。
 *
 * 参数分两组：
 *   F0 —— 作用于音高轨迹（在渲染进程构建 F0 时执行，结果直接进入合成）
 *   频谱 —— 作用于 vocoder 之前的 Mel 频谱（在主进程推理管线执行）
 */

export const POSTPROCESS_GROUPS = [
  { id: 'f0', labelKey: 'fragment.ppGroupF0', descKey: 'fragment.ppGroupF0Desc' },
  { id: 'spec', labelKey: 'fragment.ppGroupSpec', descKey: 'fragment.ppGroupSpecDesc' },
];

/**
 * type 用于 UI 呈现与输入控件的取值步进：
 *   percent —— 百分比（0..100，1 步进）
 *   frames  —— 整数帧（mel 帧 = hop 480 @24k，约 20ms）
 *   ms      —— 毫秒（整数）
 *   sigma   —— 高斯标准差（浮点，0.1 步进）
 */
export const POSTPROCESS_PARAMS = {
  f0Smooth: {
    id: 'f0Smooth',
    group: 'f0',
    labelKey: 'fragment.ppF0Smooth',
    descKey: 'fragment.ppF0SmoothDesc',
    type: 'percent',
    min: 0,
    max: 100,
    step: 1,
    def: 0,
    unit: '%',
    digits: 0,
    colorKey: 'paramF0',
  },
  f0Median: {
    id: 'f0Median',
    group: 'f0',
    labelKey: 'fragment.ppF0Median',
    descKey: 'fragment.ppF0MedianDesc',
    type: 'frames',
    min: 0,
    max: 9,
    step: 1,
    def: 0,
    unitKey: 'fragment.ppUnitFrames',
    unit: '帧',
    digits: 0,
    // 中值滤波窗口必须是奇数（实现按 half=⌊size/2⌋ 对称取窗）：
    // quantizeParamValue 会把 2/4/6/8 量化到 3/5/7/9，UI 读数与实际窗口一致。
    odd: true,
    colorKey: 'warning',
  },
  f0Glide: {
    id: 'f0Glide',
    group: 'f0',
    labelKey: 'fragment.ppF0Glide',
    descKey: 'fragment.ppF0GlideDesc',
    type: 'percent',
    min: 0,
    max: 100,
    step: 1,
    def: 0,
    unit: '%',
    digits: 0,
    colorKey: 'accent',
  },
  f0GlideMs: {
    id: 'f0GlideMs',
    group: 'f0',
    labelKey: 'fragment.ppF0GlideMs',
    descKey: 'fragment.ppF0GlideMsDesc',
    type: 'ms',
    min: 0,
    max: 300,
    step: 5,
    def: 140,
    unit: 'ms',
    digits: 0,
    colorKey: 'accentFg',
  },
  specBlend: {
    id: 'specBlend',
    group: 'spec',
    labelKey: 'fragment.ppSpecBlend',
    descKey: 'fragment.ppSpecBlendDesc',
    type: 'percent',
    min: 0,
    max: 100,
    step: 1,
    def: 0,
    unit: '%',
    digits: 0,
    colorKey: 'paramPan',
  },
  specSmoothT: {
    id: 'specSmoothT',
    group: 'spec',
    labelKey: 'fragment.ppSpecSmoothT',
    descKey: 'fragment.ppSpecSmoothTDesc',
    type: 'sigma',
    min: 0,
    max: 6,
    step: 0.1,
    def: 0,
    unit: 'σ',
    digits: 1,
    colorKey: 'accent',
  },
  specSmoothF: {
    id: 'specSmoothF',
    group: 'spec',
    labelKey: 'fragment.ppSpecSmoothF',
    descKey: 'fragment.ppSpecSmoothFDesc',
    type: 'sigma',
    min: 0,
    max: 6,
    step: 0.1,
    def: 0,
    unit: 'σ',
    digits: 1,
    colorKey: 'paramF0',
  },
};

export const POSTPROCESS_PARAM_LIST = Object.values(POSTPROCESS_PARAMS);

export function getParamDef(id) {
  return POSTPROCESS_PARAMS[id] || null;
}

export function getParamsByGroup(groupId) {
  return POSTPROCESS_PARAM_LIST.filter((p) => p.group === groupId);
}

export function clampParamValue(id, value) {
  const def = POSTPROCESS_PARAMS[id];
  if (!def) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return def.def;
  return Math.max(def.min, Math.min(def.max, n));
}

export function quantizeParamValue(id, value) {
  const def = POSTPROCESS_PARAMS[id];
  if (!def) return 0;
  let clamped = clampParamValue(id, value);
  // 奇数窗口参数（中值滤波）：>0 的偶数取值就近舍入到奇数（2→3、4→5、8→9），
  // 0/1 保持关闭 —— UI 读数与实际窗口一致。
  if (def.odd) {
    const n = Math.round(clamped);
    if (n < 2) return 0;
    clamped = Math.min(def.max, n % 2 === 0 ? n + 1 : n);
  }
  if (def.step > 0) {
    const q = Math.round(clamped / def.step) * def.step;
    return Math.max(def.min, Math.min(def.max, q));
  }
  return clamped;
}

/** 该值是否"非关闭状态"（用于判断是否需要走滤波 / 后处理快路径）。 */
export function isParamActive(id, value) {
  const def = POSTPROCESS_PARAMS[id];
  if (!def) return false;
  if (id === 'f0GlideMs') return Number(value) > 0;
  return Number(value) > def.min;
}

/** 显示用格式化：百分比 / 帧 / 毫秒 / σ。 */
/**
 * 参数的本地化单位文本。
 *
 * 注册表的 `unit` 是中文兜底值（`f0Median` 的"帧"），`unitKey` 才是可翻译的键。
 * 任何直接读 `def.unit` 的地方在英文界面下都会漏出中文，必须走这里。
 * t() 缺键时会回退成键名本身，此时继续用中文单位兜底。
 *
 * @param {object} def POSTPROCESS_PARAMS 的条目
 * @param {(key:string)=>string} [t] 翻译函数
 * @returns {string}
 */
export function paramUnitText(def, t) {
  if (!def) return '';
  if (def.unitKey && typeof t === 'function') {
    const localized = t(def.unitKey);
    if (localized && localized !== def.unitKey) return localized;
  }
  return def.unit || '';
}

export function formatParamValue(id, value, t) {
  const def = POSTPROCESS_PARAMS[id];
  if (!def) return String(value);
  const n = Number(value);
  const fixed = Number.isFinite(n) ? n.toFixed(def.digits) : '0';
  const unit = paramUnitText(def, t);
  return unit ? `${fixed}${unit}` : fixed;
}

/**
 * 快捷预设：一次性给出整组参数的推荐取值。
 * 应用预设 = 替换**整组**状态：写入全局默认值并清空全部自动化锚点（撤销栈可恢复）。
 * 旧语义"只写默认值、保留锚点"已废弃：锚点优先级高于默认值，会导致选了预设
 * 但音频不变，且重开工程后下拉高亮与曲线状态自相矛盾。
 */
export const POSTPROCESS_PRESETS = [
  {
    id: 'off',
    labelKey: 'fragment.ppPresetOff',
    values: { f0Smooth: 0, f0Median: 0, f0Glide: 0, specBlend: 0, specSmoothT: 0, specSmoothF: 0 },
  },
  {
    id: 'soft',
    labelKey: 'fragment.ppPresetSoft',
    values: { f0Smooth: 25, f0Median: 3, f0Glide: 20, specBlend: 25, specSmoothT: 0.8, specSmoothF: 0.4 },
  },
  {
    id: 'standard',
    labelKey: 'fragment.ppPresetStandard',
    values: { f0Smooth: 50, f0Median: 3, f0Glide: 35, specBlend: 45, specSmoothT: 1.2, specSmoothF: 0.6 },
  },
  {
    id: 'strong',
    labelKey: 'fragment.ppPresetStrong',
    values: { f0Smooth: 80, f0Median: 5, f0Glide: 55, specBlend: 70, specSmoothT: 2.0, specSmoothF: 1.0 },
  },
];

/** 生成全新的默认参数表（每个参数一份独立曲线，初始无锚点）。 */
export function createDefaultPostprocessState() {
  const defaults = {};
  const curves = {};
  for (const p of POSTPROCESS_PARAM_LIST) {
    defaults[p.id] = p.def;
    curves[p.id] = { keyframes: [] };
  }
  return { defaults, curves };
}
