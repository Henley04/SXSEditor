/**
 * 自然度自检 —— 把"听起来自然吗"拆成可测量的指标。
 *
 * 为什么需要：自动音高曲线有十几个参数，用户调完只能靠耳朵判断"是不是更好"，
 * 而这种判断在短循环里极不可靠（听觉适应）。这里对**实际曲线**（含自动层、
 * 手动覆盖、颤音）采样，输出与真人歌唱统计区间可比的指标，让"自然度"从
 * 主观感受变成可回归的数值。
 *
 * 纯函数、无 DOM、无 state：接收 `pitchAt(beat)` 采样器，便于单测与 MCP 调用。
 *
 * 参考区间（来自设计方案 §7 的四大波动研究）：
 *   · 颤音速率 3–9 Hz（常用 5–7），深度 15–30 音分
 *   · 大跳进过冲 10–25 音分
 *   · 抖动（jitter）≈ 3–10 音分
 *   · 持续音不应有"完全平直"的段（人声永远在动）
 */

/** 指标状态 */
export const NAT_STATUS = { GOOD: 'good', WARN: 'warn', BAD: 'bad', INFO: 'info' };

// 采样密度：200/拍 → 120BPM 下 400Hz。为什么需要这么高：
//   · 颤音 3–9Hz 至少要 >2 倍频（奈奎斯特定理）。
//   · 抖动（jitter）是逐周期随机，要把它和颤音分开，必须有足够带宽做高通。
// 自检是手动触发的低频操作，300 音符 × 400 点 ≈ 12 万次采样，实测量级 < 50ms。
const SAMPLES_PER_BEAT = 200;

/** 线性回归去趋势，返回残差（单位与输入一致）。 */
function detrend(values, xs) {
  const n = values.length;
  if (n < 3) return values.map(() => 0);
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += values[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * values[i];
  }
  const den = n * sxx - sx * sx;
  const slope = Math.abs(den) < 1e-12 ? 0 : (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  return values.map((v, i) => v - (slope * xs[i] + intercept));
}

/** 中位数 */
function median(arr) {
  if (!arr || arr.length === 0) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 标准差 */
function stdev(arr) {
  if (!arr || arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/**
 * 对一个音符采样。返回 { beats, cents }（cents 相对该音符的 MIDI 音高）。
 * 清音帧（pitchAt 返回 null）跳过。
 */
function sampleNote(pitchAt, note, bpm, samplesPerBeat = SAMPLES_PER_BEAT) {
  const span = Math.max(1e-6, note.duration);
  const n = Math.max(2, Math.round(span * samplesPerBeat));
  const beats = [];
  const cents = [];
  for (let i = 0; i <= n; i++) {
    // ×0.999：最后一个采样点不能正好落在音符终点（那里已经是下一个音符或
    // 静音区，会把 -60 半音之类的越界值算进来，实测把颤音深度算成 0）
    const beat = note.start + (i / n) * span * 0.999;
    const p = pitchAt(beat);
    if (p === null || !Number.isFinite(p)) continue;
    beats.push(beat);
    cents.push((p - note.pitch) * 100);
  }
  return { beats, cents };
}

/**
 * 颤音分析：去趋势后看振荡。
 *
 * 用"残差的 2.5%–97.5% 分位差 / 2"作为振幅，比 max-min 抗单点毛刺。
 * 频率不用过零计数 —— 过零在"颤音渐入"段会被抖动带偏（实测把 5.5Hz 测成
 * 8Hz），改用**归一化自相关**找周期：对幅度包络与噪声都不敏感，再用抛物线
 * 插值提高分辨率。
 */
function analyzeVibrato(samples, note, bpm, sampleRate) {
  const { beats, cents } = samples;
  if (cents.length < 16) return null;
  const durSec = (note.duration / bpm) * 60;
  if (durSec < 0.25) return null;
  // 只取中段 30%–80%：起音滑音、过冲、句尾下滑都是**低频趋势**，线性去趋势
  // 去不掉它们（实测把 22 音分的颤音测成 81 音分）。缩短到中段后趋势基本平坦。
  const a = Math.floor(cents.length * 0.3);
  const b = Math.max(a + 8, Math.ceil(cents.length * 0.8));
  const segCents = cents.slice(a, b);
  const segBeats = beats.slice(a, b);
  const residRaw = detrend(segCents, segBeats);
  // 9 点滑动平均（400Hz 采样下 ≈ 22Hz 低通）：压掉 jitter 的宽带成分，
  // 只留 3–9Hz 的颤音。
  // 为什么不是 5 点：jitter 是 5ms 一格的随机（≈2 个采样点），5 点窗（12.5ms）
  // 只压掉一半，残余会在自相关里形成伪峰。9 点窗 22.5ms 对 5.5Hz（周期 182ms）
  // 几乎无衰减，对 jitter 足够。
  const resid = new Array(residRaw.length);
  for (let i = 0; i < residRaw.length; i++) {
    let sum = 0;
    let cnt = 0;
    for (let k = -4; k <= 4; k++) {
      const j = i + k;
      if (j >= 0 && j < residRaw.length) { sum += residRaw[j]; cnt++; }
    }
    resid[i] = sum / cnt;
  }
  const sorted = resid.slice().sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.025)];
  const hi = sorted[Math.floor(sorted.length * 0.975)];
  const depth = Math.abs(hi - lo) / 2;

  const rate = autocorrRate(resid, sampleRate);
  return { depth, rate, residualSpread: Math.abs(hi - lo) };
}

/**
 * 归一化自相关估周期，返回 Hz（无法判定时返回 null）。
 *
 * @param {number[]} resid 去趋势 + 低通后的残差
 * @param {number} sampleRate 采样率（Hz）
 */
function autocorrRate(resid, sampleRate) {
  const n = resid.length;
  if (!(sampleRate > 0) || n < 32) return null;
  const mean = resid.reduce((a, b) => a + b, 0) / n;
  const x = resid.map((v) => v - mean);
  const minLag = Math.max(2, Math.floor(sampleRate / 10));   // 10Hz 上限
  const maxLag = Math.min(Math.floor(sampleRate / 2.5), Math.floor(n / 2));
  if (maxLag <= minLag + 1) return null;
  const r = new Array(maxLag + 2).fill(0);
  let best = -1;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let d1 = 0;
    let d2 = 0;
    for (let i = 0; i + lag < n; i++) {
      const vi = x[i];
      const vj = x[i + lag];
      num += vi * vj;
      d1 += vi * vi;
      d2 += vj * vj;
    }
    const den = Math.sqrt(d1 * d2);
    const v = den > 1e-12 ? num / den : 0;
    r[lag] = v;
    if (v > best) { best = v; bestLag = lag; }
  }
  if (best < 0.25 || bestLag === 0) return null;
  const y0 = r[bestLag - 1] || 0;
  const y1 = r[bestLag];
  const y2 = r[bestLag + 1] || 0;
  const den = y0 - 2 * y1 + y2;
  const delta = Math.abs(den) > 1e-9 ? (0.5 * (y0 - y2)) / den : 0;
  const lag = bestLag + Math.max(-0.5, Math.min(0.5, delta));
  return lag > 0 ? sampleRate / lag : null;
}

/** 起音：从音符开始到首次进入目标 ±tol 音分所需时间（ms）；未进入返回 null。 */
function analyzeAttack(samples, bpm, tol = 25) {
  const { beats, cents } = samples;
  if (beats.length < 2) return null;
  for (let i = 0; i < cents.length; i++) {
    if (Math.abs(cents[i]) <= tol) {
      return ((beats[i] - beats[0]) / bpm) * 60 * 1000;
    }
  }
  return null;
}

/**
 * 运行自检。
 *
 * @param {object} ctx
 * @param {(beat:number)=>(number|null)} ctx.pitchAt 采样器：返回绝对 MIDI 音高
 * @param {Array} ctx.notes 已激活（clipped + 排序）的音符
 * @param {number} ctx.bpm
 * @param {{min:number,max:number}} [ctx.ranges] 音域
 * @returns {{score:number, items:Array, counts:object}}
 */
export function analyzeNaturalness(ctx) {
  const { pitchAt, notes, bpm, ranges } = ctx || {};
  if (typeof pitchAt !== 'function' || !Array.isArray(notes) || notes.length === 0 || !(bpm > 0)) {
    return { score: 0, items: [], counts: { notes: 0, longNotes: 0, leaps: 0 } };
  }

  const sorted = notes
    .filter((n) => n && Number.isFinite(n.start) && Number.isFinite(n.duration) && n.duration > 0 && n.pitch > 0)
    .sort((a, b) => a.start - b.start);

  const longNotes = sorted.filter((n) => n.duration >= 1); // ≥1 拍才算"长音"
  const vibratos = [];
  const attacks = [];
  const flats = [];
  let notesWithVibrato = 0;
  let outOfRange = 0;
  const tuningCents = [];
  let jitterDiffs = [];

  for (const note of sorted) {
    const s = sampleNote(pitchAt, note, bpm);
    if (s.cents.length < 4) continue;

    // 调音偏差：取中段（跳开起音/收尾各 20%）的中位数
    const a = Math.floor(s.cents.length * 0.2);
    const b = Math.ceil(s.cents.length * 0.8);
    const mid = s.cents.slice(a, Math.max(a + 1, b));
    if (mid.length > 0) tuningCents.push(median(mid));

    // 死平段：中段残差几乎不动
    if (note.duration >= 0.8 && mid.length >= 6) {
      const resid = detrend(mid, s.beats.slice(a, Math.max(a + 1, b)));
      const spread = Math.max(...resid) - Math.min(...resid);
      if (spread < 6) flats.push({ note, spread });
    }

    // 抖动估计：**高通残差**。
    // 一阶差分的 std 会把颤音也算进去（400Hz 采样下 ±22¢ @5.5Hz 的差分约 4¢，
    // 而真实 jitter 也是这个量级，两者混在一起无法区分）。这里先减掉 5 点
    // 滑动平均（≈80Hz 低通，颤音完全落在通带内被减掉），残差就是逐点高频抖动。
    if (s.cents.length > 12) {
      const j0 = Math.floor(s.cents.length * 0.3);
      const j1 = Math.ceil(s.cents.length * 0.8);
      for (let i = j0 + 2; i < j1 - 2; i++) {
        let sum = 0;
        for (let k = -2; k <= 2; k++) sum += s.cents[i + k];
        jitterDiffs.push(s.cents[i] - sum / 5);
      }
    }

    // 采样率 = 每拍采样数 × 拍/秒（120BPM → 400Hz），自相关用它换算周期
    const v = analyzeVibrato(s, note, bpm, (SAMPLES_PER_BEAT * bpm) / 60);
    // 门槛 4¢：低于它的是抖动的慢分量，不是"颤音"。不设门槛会把直声长音
    // 也算成"有颤音"，覆盖率和深度都会被稀释。
    if (v && v.rate && v.rate >= 2.5 && v.rate <= 12 && v.depth >= 4) {
      vibratos.push({ note, ...v });
      notesWithVibrato++;
    }

    const atk = analyzeAttack(s, bpm);
    if (atk !== null) attacks.push(atk);

    if (ranges && (note.pitch < ranges.min || note.pitch > ranges.max)) outOfRange++;
  }

  // ---- 跳进与过冲 ----
  const overshoots = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    // 只算真正相邻的换音（间隔 < 0.35 拍，明显同句）
    const gap = cur.start - (prev.start + prev.duration);
    if (gap > 0.35 || gap < -0.5) continue;
    const interval = cur.pitch - prev.pitch;
    if (Math.abs(interval) < 4) continue; // 小音程不做过冲
    const dir = Math.sign(interval);
    // 新音起音后 200ms 窗口：再长就会把自动颤音（约 0.35 拍后渐入）算成过冲
    const winBeats = Math.min(cur.duration, (0.2 / 60) * bpm);
    let peak = 0;
    for (let t = 0; t <= winBeats; t += winBeats / 12 || 0.01) {
      const p = pitchAt(cur.start + t);
      if (p === null || !Number.isFinite(p)) continue;
      const over = (p - cur.pitch) * 100 * dir; // 同方向超出为正值
      if (over > peak) peak = over;
    }
    overshoots.push({ interval, overshoot: peak });
  }

  // ---- 汇总为指标 ----
  const items = [];
  // weight：这一项对"自然度"的贡献权重。
  // 关键区分：vibrato / flat / overshoot / jitter 是"表现力"指标（做不好
  // 一定机械），给 1；tuning / attack / range 是"正确性"指标（做对了不加分，
  // 做错了扣分），给 0.5 —— 否则一条完全平直的曲线会因为这四项自动满足
  // 而拿到 50 分，用户会以为"还行"。
  const push = (id, label, value, unit, target, status, hint, weight = 1) => {
    items.push({ id, label, value, unit, target, status, hint, weight });
  };

  const vibDepth = vibratos.length > 0 ? median(vibratos.map((v) => v.depth)) : null;
  const vibRate = vibratos.length > 0 ? median(vibratos.map((v) => v.rate)) : null;

  if (longNotes.length === 0) {
    push('vibrato', 'vibratoDepth', null, '¢', '15–30', NAT_STATUS.INFO, 'noLongNotes');
  } else if (vibDepth === null) {
    push('vibrato', 'vibratoDepth', 0, '¢', '15–30', NAT_STATUS.BAD, 'flatLongNotes');
  } else {
    // good 下界取 12 而不是 15：短音符（2 拍）上颤音是渐入的，中段平均幅度
    // 天然低于稳态深度（实测 22¢ 参数在 2 拍音符上测出 14.7¢）。15 会把
    // "参数完全正确"的曲线误判成 warn。
    const st = vibDepth < 7 ? NAT_STATUS.BAD
      : vibDepth < 12 ? NAT_STATUS.WARN
        : vibDepth <= 32 ? NAT_STATUS.GOOD
          : vibDepth <= 50 ? NAT_STATUS.WARN : NAT_STATUS.BAD;
    push('vibrato', 'vibratoDepth', vibDepth, '¢', '12–32', st, 'vibratoHint');
  }

  if (vibRate !== null) {
    const st = vibRate >= 4.5 && vibRate <= 7.5 ? NAT_STATUS.GOOD
      : vibRate >= 3 && vibRate <= 9 ? NAT_STATUS.WARN : NAT_STATUS.BAD;
    push('vibratoRate', 'vibratoRate', vibRate, 'Hz', '3–9 (5–7)', st, 'vibratoRateHint', 0.5);
  }

  // 颤音覆盖率：真人不给每个长音都加颤音（大约 60%–95%），全部 100% 反而是
  // "参数化机械"的信号。这一项只在长音足够多（≥4）时才有统计意义。
  if (longNotes.length >= 4) {
    const cov = (notesWithVibrato / longNotes.length) * 100;
    const st = cov < 25 ? NAT_STATUS.BAD
      : cov < 45 ? NAT_STATUS.WARN
        : cov <= 98 ? NAT_STATUS.GOOD : NAT_STATUS.WARN;
    push('vibratoCoverage', 'vibratoCoverage', cov, '%', '45–98', st, 'vibratoCoverageHint', 0.5);
  }

  const flatRatio = longNotes.length > 0 ? flats.length / longNotes.length : 0;
  push('flat', 'deadFlat', flatRatio * 100, '%', '< 20',
    flatRatio <= 0.2 ? NAT_STATUS.GOOD : flatRatio <= 0.5 ? NAT_STATUS.WARN : NAT_STATUS.BAD,
    'deadFlatHint');

  if (overshoots.length > 0) {
    // 过冲不再"每个跳进都必须有"（auto 用概率闸门控制），所以判档看两件事：
    //   · 有过多冲的比例（太少 = 每个跳进都硬切，太多 = 每个跳进都在"抻"）
    //   · 真正发生过冲的那些，峰值是否落在 10–25¢
    const hit = overshoots.filter((o) => o.overshoot >= 6);
    const share = hit.length / overshoots.length;
    const mid = hit.length > 0 ? median(hit.map((o) => o.overshoot)) : 0;
    let st;
    if (overshoots.length < 2) st = NAT_STATUS.INFO;   // 样本太小，不下结论
    else if (hit.length === 0) st = NAT_STATUS.WARN;
    else if (share >= 0.3 && mid >= 8 && mid <= 30) st = NAT_STATUS.GOOD;
    else if (mid > 0) st = NAT_STATUS.WARN;
    else st = NAT_STATUS.BAD;
    push('overshoot', 'overshoot', mid, '¢', '10–25', st, 'overshootHint');
  }

  if (attacks.length > 0) {
    const mid = median(attacks);
    const st = mid <= 80 ? NAT_STATUS.GOOD : mid <= 200 ? NAT_STATUS.WARN : NAT_STATUS.BAD;
    push('attack', 'attackMs', mid, 'ms', '< 80', st, 'attackHint', 0.5);
  }

  // 逐点高频残差的 std ≈ 抖动幅度（正弦抖动 → std = amp/√2，取保守值直接比较）
  const jitterCents = jitterDiffs.length > 1 ? stdev(jitterDiffs) : 0;
  // 判档与 target 对齐：默认 6¢ 的 jitter 经高通残差后实测约 1.5–4¢
  // （宽带随机在高通/标准差下会衰减，且高音区按音分折算更小），所以 good
  // 下界取 1.5¢ 而不是 3¢。
  push('jitter', 'jitter', jitterCents, '¢', '1.5–14',
    jitterCents >= 1.5 && jitterCents <= 14 ? NAT_STATUS.GOOD
      : jitterCents > 0.8 ? NAT_STATUS.WARN : NAT_STATUS.BAD,
    'jitterHint');

  const tune = tuningCents.length > 0 ? median(tuningCents) : 0;
  push('tuning', 'tuning', tune, '¢', '±20',
    Math.abs(tune) <= 20 ? NAT_STATUS.GOOD : Math.abs(tune) <= 40 ? NAT_STATUS.WARN : NAT_STATUS.BAD,
    'tuningHint', 0.5);

  push('range', 'outOfRange', outOfRange, 'notes', '0',
    outOfRange === 0 ? NAT_STATUS.GOOD : NAT_STATUS.WARN, 'rangeHint', 0.5);

  const scored = items.filter((it) => it.status !== NAT_STATUS.INFO);
  let weightSum = 0;
  let credit = 0;
  for (const it of scored) {
    const w = Number(it.weight) > 0 ? Number(it.weight) : 1;
    weightSum += w;
    if (it.status === NAT_STATUS.GOOD) credit += w;
    else if (it.status === NAT_STATUS.WARN) credit += w * 0.5;
  }
  const score = weightSum > 0 ? Math.round((credit / weightSum) * 100) : 0;

  return {
    score,
    items,
    counts: { notes: sorted.length, longNotes: longNotes.length, leaps: overshoots.length },
  };
}
