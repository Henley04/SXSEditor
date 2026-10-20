/**
 * F0（音高）轨迹后处理。
 *
 * 三步串联，对应分片编辑器"音色 → F0"三条独立参数曲线：
 *   1. 中值滤波      —— 消除孤立异常音高（跳点、倍频错误），窗口 = f0Median（mel 帧）。
 *   2. Savitzky-Golay —— 保形平滑，抑制帧间抖动但保留整体趋势，强度 = f0Smooth（%）。
 *   3. 三次贝塞尔过渡 —— 在音符切换处把阶跃替换为"先过冲再回落"的平滑过渡，
 *                        强度 = f0Glide（%），时长 = f0GlideMs（ms）。
 *
 * 所有滤波都在 cents（对数）域进行：
 *   - 音高感知本来就是对数关系，线性域平滑会让高音区过度迟钝；
 *   - 阶跃判断（是否构成"跳变"）也用 cents 阈值，与听感一致。
 *
 * F0 数组约定与管线一致：长度 = mel 帧数，值单位 Hz，0 表示静音 / 非浊音帧。
 * 滤波只改写浊音帧内部的采样，绝不跨越静音段，也不把 0 变成非 0。
 */

const CENTS_REF_HZ = 440;
// 相邻帧差的初筛阈值。25 音分/帧（=1250 音分/秒）低于正常颤音的帧间斜率
// （5.5Hz ±40 音分颤音即可达 ~34 音分/帧），会把颤音逐周期误判为"跳变"，
// 随后被贝塞尔过渡整体揉平。50 音分初筛 + 下面的中值台阶确认，
// 可以在保留半音级跳变的同时完全放过自然颤音。
const JUMP_CENTS_THRESHOLD = 50;
// 台阶确认：比较跳变点**远离两侧**的中值电平（前 [i-12,i-4)、后 [i+3,i+11)，
// 各 8 帧 = 160ms）。颤音是振荡，160ms ≥ 一个完整周期（5–7Hz），两侧中值都
// 回到中线上、差值≈0；真跳变两侧中值相差整个音程。紧贴跳变点的窗口会被
// 振荡相位差污染（7Hz±80 音分时可达 ~70 音分），所以刻意留出 4 帧间隔。
const JUMP_CONFIRM_PRE_START = 12;
const JUMP_CONFIRM_PRE_END = 4;
const JUMP_CONFIRM_POST_START = 3;
const JUMP_CONFIRM_POST_END = 11;
const JUMP_CONFIRM_MIN_FRAMES = 4;
// 前后中值差的最小幅度：低于它的"跳变"视为振荡/滑音，不做过冲处理
// （约 0.75 半音；谱面上半音级及以上的音程跳变都 ≥100 音分，不受影响）。
const JUMP_CONFIRM_MIN_CENTS = 75;

export function hzToCents(hz) {
  return 1200 * Math.log2(hz / CENTS_REF_HZ);
}

export function centsToHz(cents) {
  return CENTS_REF_HZ * Math.pow(2, cents / 1200);
}

/**
 * 返回浊音段列表（左闭右开帧区间）。长度为 1 的孤立浊音帧也会被当作独立段。
 */
export function buildVoicedRuns(f0) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < f0.length; i++) {
    const voiced = f0[i] > 0;
    if (voiced && start < 0) start = i;
    else if (!voiced && start >= 0) {
      runs.push({ start, end: i });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ start, end: f0.length });
  return runs;
}

// ==================== Savitzky-Golay ====================

const _sgCache = new Map();

/**
 * 计算奇数窗口、指定阶数的 Savitzky-Golay 平滑系数（中心点）。
 * 采用最小二乘正规方程 + 高斯消元求解，支持任意 window/order 组合。
 * @param {number} window 奇数窗口长度（帧）
 * @param {number} order 多项式阶数（< window）
 * @returns {Float64Array|null}
 */
export function savitzkyGolayCoefficients(window, order) {
  const w = Math.floor(window);
  if (w < 3 || w % 2 === 0) return null;
  const p = Math.max(0, Math.min(Math.floor(order), w - 2));
  const key = `${w}:${p}`;
  const cached = _sgCache.get(key);
  if (cached) return cached;

  const half = (w - 1) / 2;
  const m = p + 1;
  // 正规方程 A = VᵀV，右端项取 e0：解得 z = A⁻¹e0，则中心点系数 kernel_x = Σ_k z_k·x^k。
  const A = [];
  for (let r = 0; r < m; r++) {
    A.push(new Float64Array(m + 1));
  }
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) {
      let sum = 0;
      for (let x = -half; x <= half; x++) sum += Math.pow(x, r + c);
      A[r][c] = sum;
    }
    A[r][m] = r === 0 ? 1 : 0;
  }
  // 高斯消元（部分主元）
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) {
      _sgCache.set(key, null);
      return null;
    }
    if (pivot !== col) {
      const tmp = A[pivot];
      A[pivot] = A[col];
      A[col] = tmp;
    }
    const pv = A[col][col];
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const factor = A[r][col] / pv;
      if (factor === 0) continue;
      for (let c = col; c <= m; c++) A[r][c] -= factor * A[col][c];
    }
  }
  const coef = new Float64Array(m);
  for (let r = 0; r < m; r++) coef[r] = A[r][m] / A[r][r];

  // 中心点系数 = Σ_k coef_k · x^k（中心即原点，x=0 处）
  const kernel = new Float64Array(w);
  for (let i = 0; i < w; i++) {
    const x = i - half;
    let sum = 0;
    for (let k = 0; k < m; k++) sum += coef[k] * Math.pow(x, k);
    kernel[i] = sum;
  }
  _sgCache.set(key, kernel);
  return kernel;
}

/**
 * Savitzky-Golay 平滑（cents 域），返回新数组。
 * @param {Float32Array} f0
 * @param {{window?:number, order?:number}} opts
 * @returns {Float32Array} 平滑后的 Hz 序列（0 帧保持 0）
 */
export function savitzkyGolayFilter(f0, opts = {}) {
  const window = opts.window ?? 7;
  const order = opts.order ?? 3;
  const out = new Float32Array(f0);
  const runs = buildVoicedRuns(f0);
  const maxHalf = (Math.floor(window) - 1) / 2;
  if (maxHalf < 1) return out;

  for (const run of runs) {
    const len = run.end - run.start;
    if (len < 3) continue;
    // 分段转 cents，避免每帧重复 log
    const cents = new Float64Array(len);
    for (let i = 0; i < len; i++) cents[i] = hzToCents(f0[run.start + i]);
    for (let i = 0; i < len; i++) {
      const half = Math.min(maxHalf, i, len - 1 - i);
      const w = 2 * half + 1;
      if (w < 3) continue;
      const kernel = savitzkyGolayCoefficients(w, Math.min(order, w - 2));
      if (!kernel) continue;
      let acc = 0;
      for (let k = 0; k < w; k++) acc += kernel[k] * cents[i - half + k];
      out[run.start + i] = centsToHz(acc);
    }
  }
  return out;
}

// ==================== 中值滤波 ====================

/**
 * 中值滤波（cents 域），逐帧按各自的窗口计算，窗口内跳过静音帧。
 * @param {Float32Array} f0
 * @param {number|Float32Array|number[]} window 全局窗口或逐帧窗口（帧）
 * @param {number} maxWindow 逐帧窗口数组时的上界提示（可选）
 * @returns {Float32Array}
 */
export function medianFilterFrames(f0, window, maxWindow) {
  const out = new Float32Array(f0);
  const runs = buildVoicedRuns(f0);
  const perFrame = typeof window === 'object' && window !== null;
  const sizeAt = (idx) => {
    const raw = perFrame ? window[idx] : window;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    // 中值窗口必须是奇数（下面按 half=⌊size/2⌋ 对称取窗，实际窗口 = 2·half+1）。
    // 锚点值经 quantizeParamValue 保证是奇数，但**曲线插值**会产生偶数或小数
    // （如 3→9 之间插出 4.4），这里统一奇数化，使实际窗口与注册表 odd:true
    // 的语义严格一致，也让面板读数等于真实窗口。
    // 小于 3 的窗口无意义（1 帧就是原值，2 帧会退化成取端点）→ 不处理。
    // 判据用**取整后**的值，与旧实现完全等价：
    //   2.4 → round 2 → 跳过；2.5 → round 3 → 3 帧；4.4 → round 4 → 奇数化 5 → 5 帧。
    // 奇数化只修正"偶数 size 被实现按 2·floor(size/2)+1 放大成 size+1"这一隐式
    // 行为，使注册表里的 size 读数等于真实窗口，不改变任何一档实际窗口。
    let size = Math.round(n);
    if (size < 3) return 0;
    if (size % 2 === 0) size += 1;
    const maxW = maxWindow ?? 9;
    return Math.min(maxW, size);
  };
  const scratch = [];

  for (const run of runs) {
    const len = run.end - run.start;
    if (len < 3) continue;
    for (let i = 0; i < len; i++) {
      const size = sizeAt(run.start + i);
      if (size < 3) continue;
      const half = Math.floor(size / 2);
      scratch.length = 0;
      // 在 cents（对数）域取中值：与文件头的约定一致，也和同文件的
      // Savitzky-Golay / 贝塞尔过渡保持同一量纲。
      // 线性 Hz 域取中值时，数值上偏高的样本会主导结果，高音区的中值系统性
      // 偏向高端（对数尺度上不对称），听感上表现为"音高被整体拉高"。
      // run 内已排除静音帧（f0=0），不会出现 log(0) = -Infinity。
      for (let k = -half; k <= half; k++) {
        const j = i + k;
        if (j < 0 || j >= len) continue;
        scratch.push(hzToCents(f0[run.start + j]));
      }
      if (scratch.length < 3) continue;
      scratch.sort((a, b) => a - b);
      const mid = scratch.length >> 1;
      const med = scratch.length % 2 ? scratch[mid] : 0.5 * (scratch[mid - 1] + scratch[mid]);
      out[run.start + i] = centsToHz(med);
    }
  }
  return out;
}

// ==================== 三次贝塞尔过渡 ====================

/**
 * 相邻浊音帧之间的音高跳变点。
 *
 * 两级判定：
 *   1. 初筛：相邻帧 cents 差 > thresholdCents（默认 50）；
 *   2. 确认：跳变点远离两侧的中值电平相差 ≥ JUMP_CONFIRM_MIN_CENTS ——
 *      颤音是振荡且两侧窗口 ≥ 一个周期，中值都回到中线，会被这一级过滤掉；
 *      只有真正的"台阶"（音符切换、倍频错误）才会留下。
 *
 * @returns {Array<{index:number, cents:number}>} index 为跳变后第一帧，
 *          cents 为前后中值台阶幅度
 */
export function findPitchJumps(f0, thresholdCents = JUMP_CENTS_THRESHOLD) {
  const jumps = [];
  for (let i = 1; i < f0.length; i++) {
    if (!(f0[i] > 0) || !(f0[i - 1] > 0)) continue;
    const diff = Math.abs(hzToCents(f0[i]) - hzToCents(f0[i - 1]));
    if (diff <= thresholdCents) continue;
    const step = _medianStepCents(f0, i);
    if (step === null || step < JUMP_CONFIRM_MIN_CENTS) continue;
    jumps.push({ index: i, cents: step });
  }
  return jumps;
}

/**
 * 跳变点远离两侧的中值电平差（cents）。
 * 前 [i-12, i-4)、后 [i+3, i+11)；任一侧浊音帧不足返回 null。
 */
function _medianStepCents(f0, index) {
  const prev = [];
  const next = [];
  for (let k = index - JUMP_CONFIRM_PRE_START; k < index - JUMP_CONFIRM_PRE_END + 1; k++) {
    if (k >= 0 && f0[k] > 0) prev.push(hzToCents(f0[k]));
  }
  for (let k = index + JUMP_CONFIRM_POST_START; k <= index + JUMP_CONFIRM_POST_END; k++) {
    if (k < f0.length && f0[k] > 0) next.push(hzToCents(f0[k]));
  }
  if (prev.length < JUMP_CONFIRM_MIN_FRAMES || next.length < JUMP_CONFIRM_MIN_FRAMES) return null;
  const med = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
  };
  return Math.abs(med(next) - med(prev));
}

// 三次贝塞尔 x(t) 的控制点（时间轴方向），与 CSS ease-in-out 接近，先慢-中快-后慢
const BX1 = 0.35;
const BX2 = 0.65;
const _bezierXTable = (() => {
  const N = 64;
  const xs = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const mt = 1 - t;
    xs[i] = 3 * mt * mt * t * BX1 + 3 * mt * t * t * BX2 + t * t * t;
  }
  return xs;
})();

/** 由归一化时间 u∈[0,1] 反解贝塞尔参数 t（x(t) 单调，查表 + 线性插值）。 */
function solveBezierT(u) {
  const table = _bezierXTable;
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const N = table.length - 1;
  let lo = 0;
  let hi = N;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= u) lo = mid;
    else hi = mid;
  }
  const x0 = table[lo];
  const x1 = table[hi];
  const frac = x1 > x0 ? (u - x0) / (x1 - x0) : 0;
  return (lo + frac) / N;
}

/**
 * 求三次贝塞尔 y 值（x 为归一化时间）。
 * 控制点：P0=(0,y0) P1=(0.35,y1) P2=(0.65,y2) P3=(1,y3)
 */
export function cubicBezierY(u, y0, y1, y2, y3) {
  const t = solveBezierT(u);
  const mt = 1 - t;
  return mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
}

/**
 * 在音符切换处用三次贝塞尔替换阶跃，模拟真人"先过冲再回落"。
 *
 * @param {Float32Array} f0 输入 F0（Hz）
 * @param {object} opts
 * @param {(frame:number)=>number} opts.getStrength 逐帧过渡强度 0..100（0 = 不处理）
 * @param {(frame:number)=>number} opts.getDurationMs 逐帧过渡时长（ms）
 * @param {number} opts.sampleRate
 * @param {number} opts.hopSize
 * @returns {Float32Array}
 */
export function applyBezierTransitions(f0, opts) {
  const { getStrength, getDurationMs, sampleRate, hopSize } = opts;
  const out = new Float32Array(f0);
  if (!(sampleRate > 0) || !(hopSize > 0)) return out;
  const framesPerMs = sampleRate / hopSize / 1000;
  const jumps = findPitchJumps(f0);
  if (jumps.length === 0) return out;
  const runs = buildVoicedRuns(f0);

  // 跳变点 → 所属浊音段（用于窗口裁剪）
  const runOf = (idx) => {
    for (const run of runs) {
      if (idx >= run.start && idx < run.end) return run;
    }
    return null;
  };

  let lastEnd = -1;
  for (const jump of jumps) {
    const strength = Math.max(0, Math.min(100, Number(getStrength(jump.index)) || 0));
    if (strength <= 0) continue;
    const durMs = Math.max(0, Number(getDurationMs(jump.index)) || 0);
    // 0 = 显式关闭过渡，照常跳过。
    // 但 0 < durMs < 60ms 时不能静默跳过：50fps 下 60ms 才刚够 3 帧，低于它的
    // 取值（注册表 step=5 → 5/10/…/45ms）此前会让滑音**整个失效**，而 UI 上
    // 没有任何提示，用户设了 glide 却听不出变化。这里钳到最小可用窗口，
    // 让短时长按"最短过渡"生效，而不是悄悄消失。
    if (durMs <= 0) continue;
    const minSpanMs = 3 / framesPerMs;
    const spanFrames = Math.max(3, Math.round(Math.max(durMs, minSpanMs) * framesPerMs));

    const run = runOf(jump.index);
    if (!run) continue;
    // 过渡窗口在跳变点两侧不对称：起音侧留 40%（提前滑动），落音侧留 60%
    // （让过冲有足够的帧数回落，否则回落会挤在一两帧里反而更"机械"）。
    const before = Math.round(spanFrames * 0.4);
    const after = Math.round(spanFrames * 0.6);
    let start = Math.max(run.start, jump.index - before, lastEnd + 1);
    let end = Math.min(run.end - 1, jump.index + after);
    if (end - start < 2) continue;

    const y0 = hzToCents(f0[start]);
    const y3 = hzToCents(f0[end]);
    const interval = y3 - y0;
    if (Math.abs(interval) < 1) continue;
    const dir = interval > 0 ? 1 : -1;
    // 过冲幅度：强度 100% → 音程的 35%，先冲过目标再由贝塞尔回落
    const overshoot = Math.abs(interval) * 0.35 * (strength / 100);
    const y1 = y0 + interval * 0.45 + dir * overshoot;
    const y2 = y3 + dir * overshoot * 0.55;

    const width = end - start;
    for (let i = start; i <= end; i++) {
      const u = width > 0 ? (i - start) / width : 0;
      out[i] = centsToHz(cubicBezierY(u, y0, y1, y2, y3));
    }
    lastEnd = end;
  }
  return out;
}

/**
 * F0 后处理主入口：中值滤波 → Savitzky-Golay → 贝塞尔过渡。
 *
 * @param {Float32Array} f0 原始 F0（Hz，0=静音）
 * @param {object} params 逐帧参数（长度与 f0 对齐，缺失项按关闭处理）
 * @param {Float32Array|number[]} [params.median] 中值窗口（帧）
 * @param {Float32Array|number[]} [params.smooth] 平滑强度 %
 * @param {Float32Array|number[]} [params.glide] 过渡强度 %
 * @param {Float32Array|number[]} [params.glideMs] 过渡时长 ms
 * @param {object} ctx { sampleRate, hopSize }
 * @returns {Float32Array} 处理后的 F0；未启用任何参数时原样返回新数组
 */
export function applyF0Postprocess(f0, params, ctx) {
  if (!f0 || f0.length === 0) return f0;
  const { sampleRate, hopSize } = ctx || {};
  const pick = (arr, i) => (arr ? Number(arr[i]) || 0 : 0);

  let cur = new Float32Array(f0);

  // 1) 中值滤波：只在有非零窗口时执行
  let hasMedian = false;
  if (params && params.median) {
    for (let i = 0; i < params.median.length; i++) {
      if (params.median[i] >= 3) { hasMedian = true; break; }
    }
  }
  if (hasMedian) cur = medianFilterFrames(cur, params.median, 9);

  // 2) Savitzky-Golay：整体算一次，再按逐帧强度混合
  let maxSmooth = 0;
  if (params && params.smooth) {
    for (let i = 0; i < params.smooth.length; i++) {
      const v = Number(params.smooth[i]) || 0;
      if (v > maxSmooth) maxSmooth = v;
    }
  }
  if (maxSmooth > 0) {
    const filtered = savitzkyGolayFilter(cur, { window: 7, order: 3 });
    const blend = new Float32Array(cur.length);
    for (let i = 0; i < cur.length; i++) {
      const w = Math.max(0, Math.min(100, pick(params.smooth, i))) / 100;
      blend[i] = cur[i] + (filtered[i] - cur[i]) * w;
    }
    cur = blend;
  }

  // 3) 贝塞尔过渡
  let hasGlide = false;
  if (params && params.glide) {
    for (let i = 0; i < params.glide.length; i++) {
      if (params.glide[i] > 0) { hasGlide = true; break; }
    }
  }
  if (hasGlide) {
    cur = applyBezierTransitions(cur, {
      getStrength: (i) => pick(params.glide, i),
      getDurationMs: (i) => pick(params.glideMs, i),
      sampleRate,
      hopSize,
    });
  }

  return cur;
}
