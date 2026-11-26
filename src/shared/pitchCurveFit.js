/**
 * F0 → 锚点的"求值域拟合"抽稀（纯函数，无 DOM）。
 *
 * 旧算法（RDP）的误差模型是错的：它在"锚点坐标平面"上算点到线的距离，
 * 但真实曲线是 eff = 基线 + (值−基线)×strength/100 再做 easeSegment(smoothness)
 * 插值 —— strength=80 时曲线根本不经过锚点，RDP 以为经过，保留的点数和
 * 实际误差对不上。这里改为直接在**求值域**上度量：
 *
 *   1. 初始分段：RDP 只给初值（容差取目标值的 1/2）。
 *   2. 参数搜索：每段独立搜 (smoothness_left, strength_right)，11 档粗扫
 *      （0…100 步长 10）+ 邻域细调，目标是该段 max|Δ|（音分）最小。
 *      strength 的真实作用是"把锚点拉向基线"，能压掉过冲和单帧毛刺；
 *      smoothness 负责 S 形过渡。两者都进搜索，让数据选。
 *   3. 自顶向下细化：超差的段在最大误差点处切开；不超差的段进入合并测试。
 *   4. 点数预算：贪心删点 —— 每次删掉使误差增量最小的点（等距抽样会直接
 *      砍掉颤音峰，不用）。
 *   5. 颤音例外：自相关检测到 4–9Hz 调制的段不做参数优化，直接按 1/4 周期
 *      保点（strength=100 / smoothness=0），否则拟合器会把颤音抹平当噪声。
 *
 * 强度/平滑的数学与 fragmentEditor/automationCurve.js 完全同构
 * （easeSegment 直接复用真源；有效值公式与其 buildEffectiveValues 逐位一致，
 * 有测试钉死）。锚点 time 单位 = 拍，pitch 单位 = MIDI 半音，误差单位 = 音分。
 */

import { easeSegment, buildEffectiveValues, evalSortedCurve } from '../fragmentEditor/automationCurve.js';

const FPS = 50; // 参考帧率（24kHz / 480 hop）

/** 二分：第一个 time >= t 的参考帧下标。 */
function lowerBound(ref, t) {
  let lo = 0, hi = ref.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ref[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 单锚点的有效值（与 automationCurve.buildEffectiveValues 同公式）。
 * 局部 O(1) 版本：参数搜索每个候选都要取值，不能每次全量重建。
 */
function effAt(pts, strengths, i) {
  const n = pts.length;
  if (i <= 0 || i >= n - 1) return pts[i].pitch;
  const st = strengths[i];
  if (!(st < 100)) return pts[i].pitch;
  const prev = pts[i - 1], next = pts[i + 1];
  const span = next.time - prev.time;
  if (!(span > 0)) return pts[i].pitch;
  const w = (pts[i].time - prev.time) / span;
  const base = prev.pitch + (next.pitch - prev.pitch) * w;
  return base + (pts[i].pitch - base) * (st / 100);
}

/**
 * 段误差：给定左右有效值与平滑，对段内参考帧逐帧求值比 max|Δ| / RMS（音分）。
 * strengthRight 候选通过 effRight 传入（搜索时 O(1) 重算）。
 */
function segmentError(ref, i0, i1, t0, t1, effL, effR, smoothness) {
  const span = t1 - t0;
  let maxErr = 0, sumSq = 0, cnt = 0, maxErrTime = t0;
  for (let i = i0; i < i1; i++) {
    const f = ref[i];
    const t = span > 0 ? (f.time - t0) / span : 0;
    const v = effL + (effR - effL) * easeSegment(t, smoothness);
    const err = Math.abs(v - f.pitch) * 100;
    if (err > maxErr) { maxErr = err; maxErrTime = f.time; }
    sumSq += err * err;
    cnt++;
  }
  return { maxErr, rms: cnt > 0 ? Math.sqrt(sumSq / cnt) : 0, maxErrTime, frames: cnt };
}

/**
 * 单段参数搜索：(smoothness_left, strength_right) 粗扫 11×11 + 邻域细调。
 * effLeft 已由左邻段定死；strength_right 只影响本段右端点的有效值
 * （buildEffectiveValues 的基线用**原始**邻居值，段间无级联）。
 */
function fitSegment(pts, strengths, k, ref, i0, i1, opts) {
  const a = pts[k], b = pts[k + 1];
  const effL = effAt(pts, strengths, k);
  const lockRight = opts.locked[k + 1];
  const coarseOnly = opts.coarseOnly === true;

  const evalWith = (sm, sRight) => {
    let effR;
    if (lockRight || k + 1 === pts.length - 1) {
      effR = effAt(pts, strengths, k + 1);
    } else {
      const prev = a, next = pts[k + 2];
      const span = next.time - prev.time;
      if (span > 0) {
        const w = (b.time - prev.time) / span;
        const base = prev.pitch + (next.pitch - prev.pitch) * w;
        effR = base + (b.pitch - base) * (sRight / 100);
      } else {
        effR = b.pitch;
      }
    }
    return segmentError(ref, i0, i1, a.time, b.time, effL, effR, sm);
  };

  let best = { sm: 0, st: lockRight ? 100 : 100, err: Infinity, rms: Infinity };
  const consider = (sm, st) => {
    const r = evalWith(sm, st);
    if (r.maxErr < best.err - 1e-9 || (Math.abs(r.maxErr - best.err) <= 1e-9 && r.rms < best.rms)) {
      best = { sm, st, err: r.maxErr, rms: r.rms };
    }
  };
  const sVals = lockRight ? [100] : [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  for (let sm = 0; sm <= 100; sm += 10) {
    for (const st of sVals) consider(sm, st);
  }
  if (!coarseOnly) {
    // 邻域细调：±8 步长 2
    const sm0 = best.sm, st0 = best.st;
    for (let sm = Math.max(0, sm0 - 8); sm <= Math.min(100, sm0 + 8); sm += 2) {
      if (lockRight) { consider(sm, 100); continue; }
      for (let st = Math.max(0, st0 - 8); st <= Math.min(100, st0 + 8); st += 2) consider(sm, st);
    }
  }
  return best;
}

/** 颤音检测：均匀 50Hz 网格上的滑窗自相关（4–9Hz）。返回合并后的区域。 */
export function detectVibratoRegions(reference, bpm, opts = {}) {
  const minRate = opts.minRate ?? 4;
  const maxRate = opts.maxRate ?? 9;
  const threshold = opts.threshold ?? 0.55;
  if (!reference || reference.length < FPS / 2 || !(bpm > 0)) return [];
  const beatPerFrame = bpm / (60 * FPS);
  const t0 = reference[0].time;
  const tEnd = reference[reference.length - 1].time;
  const n = Math.floor((tEnd - t0) / beatPerFrame) + 1;
  const grid = new Float64Array(n).fill(NaN);
  for (const f of reference) {
    const idx = Math.round((f.time - t0) / beatPerFrame);
    if (idx >= 0 && idx < n) grid[idx] = f.pitch;
  }
  const win = Math.round(FPS * 0.6);   // 600ms 窗
  const hop = Math.round(FPS * 0.2);   // 200ms 步进
  const lagMin = Math.ceil(FPS / maxRate);
  const lagMax = Math.floor(FPS / minRate);
  const marked = new Uint8Array(n);
  const rates = [];
  for (let s = 0; s + win <= n; s += hop) {
    // 去趋势 + 有效率检查
    let cnt = 0, sum = 0, sumI = 0;
    for (let i = 0; i < win; i++) {
      const v = grid[s + i];
      if (Number.isFinite(v)) { cnt++; sum += v; sumI += v * i; }
    }
    if (cnt < win * 0.8) continue;
    const mean = sum / cnt;
    const slope = cnt > 1 ? (sumI / cnt - mean * (win - 1) / 2) / (win * win / 12) : 0;
    const x = new Float64Array(win);
    let energy = 0;
    for (let i = 0; i < win; i++) {
      const v = grid[s + i];
      x[i] = Number.isFinite(v) ? v - mean - slope * (i - (win - 1) / 2) : 0;
      energy += x[i] * x[i];
    }
    if (energy <= 0) continue;
    const std = Math.sqrt(energy / win);
    if (std < 0.02) continue; // < 2 音分：不是颤音
    let bestLag = -1, bestR = threshold;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let r = 0;
      for (let i = 0; i + lag < win; i++) r += x[i] * x[i + lag];
      r /= energy;
      if (r > bestR) { bestR = r; bestLag = lag; }
    }
    if (bestLag > 0) {
      for (let i = s; i < s + win; i++) marked[i] = 1;
      rates.push({ start: s, end: s + win, rate: FPS / bestLag });
    }
  }
  // 合并连续标记区
  const regions = [];
  let i = 0;
  while (i < n) {
    if (!marked[i]) { i++; continue; }
    let j = i;
    while (j < n && marked[j]) j++;
    const rs = rates.filter((r) => r.start < j && r.end > i).map((r) => r.rate).sort((a, b) => a - b);
    const rate = rs.length > 0 ? rs[rs.length >> 1] : 5.5;
    regions.push({
      start: t0 + i * beatPerFrame,
      end: t0 + (j - 1) * beatPerFrame,
      rate,
    });
    i = j;
  }
  return regions;
}

/** 初始分段：RDP（容差 = 目标/2），只用来给初值。 */
function rdpKeep(pts, toleranceCents) {
  const n = pts.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol = toleranceCents / 100;
  const stack = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const t0 = pts[a].time, p0 = pts[a].pitch;
    const dt = pts[b].time - t0, dp = pts[b].pitch - p0;
    let maxDev = -1, maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const proj = dt > 0 ? p0 + (dp * (pts[i].time - t0)) / dt : p0;
      const dev = Math.abs(pts[i].pitch - proj);
      if (dev > maxDev) { maxDev = dev; maxIdx = i; }
    }
    if (maxDev > tol && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([a, maxIdx]);
      stack.push([maxIdx, b]);
    }
  }
  return keep;
}

/**
 * 用最终锚点（真源 evalSortedCurve）对参考帧求整体误差。测试与量化对比用。
 * @returns {{maxErrCents:number, rmsCents:number}}
 */
export function anchorFitError(anchors, reference) {
  if (!anchors || anchors.length === 0 || !reference || reference.length === 0) {
    return { maxErrCents: 0, rmsCents: 0 };
  }
  const sorted = anchors.slice().sort((a, b) => a.time - b.time);
  const eff = buildEffectiveValues(sorted, 'pitch');
  let maxErr = 0, sumSq = 0, cnt = 0;
  for (const f of reference) {
    if (f.time < sorted[0].time || f.time > sorted[sorted.length - 1].time) continue;
    const v = evalSortedCurve(sorted, eff, f.time);
    const err = Math.abs(v - f.pitch) * 100;
    if (err > maxErr) maxErr = err;
    sumSq += err * err;
    cnt++;
  }
  return { maxErrCents: maxErr, rmsCents: cnt > 0 ? Math.sqrt(sumSq / cnt) : 0 };
}

/**
 * 求值域拟合主入口。
 *
 * @param {object} args
 * @param {Array<{time:number,pitch:number}>} args.points 分桶后的候选锚点（拍/半音，升序）
 * @param {Array<{time:number,pitch:number}>} args.reference 滤波后的逐帧参考（拍/半音，仅浊音帧）
 * @param {number} args.bpm
 * @param {number} [args.toleranceCents=6] 目标 max 误差（音分）
 * @param {number} [args.maxAnchors=4000] 点数上限（颤音保点使其不可达时为软上限）
 * @returns {{anchors:Array, maxErrCents:number, rmsCents:number, vibratoRegions:Array}}
 */
export function fitPitchCurveAnchors({ points, reference, bpm, toleranceCents = 6, maxAnchors = 4000 }) {
  if (!Array.isArray(points) || points.length === 0) {
    return { anchors: [], maxErrCents: 0, rmsCents: 0, vibratoRegions: [] };
  }
  const tol = Math.max(0.5, toleranceCents);
  const ref = Array.isArray(reference) ? reference : [];
  if (points.length <= 2 || ref.length === 0) {
    return {
      anchors: points.map((p) => ({ time: p.time, pitch: p.pitch, strength: 100, smoothness: 0 })),
      maxErrCents: 0, rmsCents: 0, vibratoRegions: [],
    };
  }

  // ---- 1) 颤音区检测 + 1/4 周期保点 ----
  const vibratoRegions = detectVibratoRegions(ref, bpm);
  const inVibrato = (t) => vibratoRegions.some((r) => t >= r.start && t <= r.end);
  const lockedSet = new Set(); // 锁定锚点（颤音保点）：strength=100，不参与删点/参数搜索
  const vibKept = [];
  for (const r of vibratoRegions) {
    const step = bpm / (60 * r.rate * 4); // 1/4 周期（拍）：周期秒 = 1/rate，除以每拍秒数
    // 保点密度 ≥ 1/4 周期：桶距本来就更密时全保留（更密只会更准），
    // 桶距更稀时按半周期阈值抽稀，保证相邻保点间隔不超过一个周期网格
    let last = -Infinity;
    for (const p of points) {
      if (p.time < r.start || p.time > r.end) continue;
      if (last === -Infinity || p.time - last >= step * 0.5) {
        vibKept.push(p);
        last = p.time;
      }
    }
  }
  for (const p of vibKept) lockedSet.add(p);

  // ---- 2) 非颤音区：RDP(tol/2) 初始分段 ----
  const keepInit = rdpKeep(points, tol / 2);
  let pts = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (lockedSet.has(p)) { pts.push(p); continue; }
    if (inVibrato(p.time)) continue; // 颤音区只留保点
    if (keepInit[i]) pts.push(p);
  }
  pts.sort((a, b) => a.time - b.time);
  // 去重（同一时间可能同时命中 RDP 与颤音保点）
  pts = pts.filter((p, i) => i === 0 || p.time > pts[i - 1].time);
  if (pts.length < 2) pts = [points[0], points[points.length - 1]];

  let locked = pts.map((p) => lockedSet.has(p));
  let strengths = pts.map(() => 100);
  let smoothness = pts.map(() => 0);

  const segFrames = (k) => {
    const i0 = lowerBound(ref, pts[k].time);
    const i1 = lowerBound(ref, pts[k + 1].time + 1e-9);
    return [i0, i1];
  };
  const isVibSeg = (k) => locked[k] && locked[k + 1];

  /** 左→右扫描：每段定 (smoothness[k], strength[k+1])。 */
  const sweep = (coarseOnly) => {
    for (let k = 0; k < pts.length - 1; k++) {
      if (isVibSeg(k)) { smoothness[k] = 0; strengths[k + 1] = 100; continue; }
      const [i0, i1] = segFrames(k);
      const best = fitSegment(pts, strengths, k, ref, i0, i1, { locked, coarseOnly });
      smoothness[k] = best.sm;
      if (!locked[k + 1]) strengths[k + 1] = best.st;
    }
    strengths[0] = 100;
    strengths[pts.length - 1] = 100;
  };

  const segErrors = () => {
    const errs = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const [i0, i1] = segFrames(k);
      errs.push(segmentError(ref, i0, i1, pts[k].time, pts[k + 1].time,
        effAt(pts, strengths, k), effAt(pts, strengths, k + 1), smoothness[k]));
    }
    return errs;
  };

  // ---- 3) 自顶向下细化：超差段在最大误差点处切开 ----
  const refine = (maxRounds) => {
    for (let round = 0; round < maxRounds; round++) {
      sweep(false);
      const errs = segErrors();
      const inserts = [];
      for (let k = 0; k < errs.length; k++) {
        if (errs[k].maxErr <= tol || isVibSeg(k)) continue;
        // 找段内离最大误差时刻最近、尚未保留的候选点
        const t = errs[k].maxErrTime;
        let bestP = null, bestD = Infinity;
        for (const p of points) {
          if (p.time <= pts[k].time || p.time >= pts[k + 1].time) continue;
          const d = Math.abs(p.time - t);
          if (d < bestD) { bestD = d; bestP = p; }
        }
        if (bestP) inserts.push(bestP);
      }
      if (inserts.length === 0) break;
      const add = new Set(inserts);
      const merged = pts.concat([...add].filter((p) => !pts.includes(p)));
      merged.sort((a, b) => a.time - b.time);
      pts = merged.filter((p, i) => i === 0 || p.time > merged[i - 1].time);
      locked = pts.map((p) => lockedSet.has(p));
      strengths = pts.map(() => 100);
      smoothness = pts.map(() => 0);
    }
  };
  refine(8);

  // ---- 4) 合并测试：删掉共享锚点后仍不超差则合并 ----
  // （删除会改变左邻锚点的基线，因此同时校验前一段误差。）
  for (let i = 1; i < pts.length - 1; i++) {
    if (locked[i] || locked[i - 1] || locked[i + 1]) continue;
    const trial = pts.slice(0, i).concat(pts.slice(i + 1));
    const trialSt = strengths.slice(0, i).concat(strengths.slice(i + 1));
    const trialSm = smoothness.slice(0, i).concat(smoothness.slice(i + 1));
    const trialLocked = locked.slice(0, i).concat(locked.slice(i + 1));
    // 合并段 = trial[i-1] → trial[i]
    const k = i - 1;
    const i0 = lowerBound(ref, trial[k].time);
    const i1 = lowerBound(ref, trial[k + 1].time + 1e-9);
    const best = fitSegment(trial, trialSt, k, ref, i0, i1, { locked: trialLocked, coarseOnly: false });
    if (best.err > tol) continue;
    // 前一段（trial[k-1] → trial[k]）右端点有效值变了，校验仍不超差
    if (k > 0) {
      const j0 = lowerBound(ref, trial[k - 1].time);
      const j1 = lowerBound(ref, trial[k].time + 1e-9);
      const stPrev = trialSt.slice();
      stPrev[k + 1] = best.st;
      const prevErr = segmentError(ref, j0, j1, trial[k - 1].time, trial[k].time,
        effAt(trial, stPrev, k - 1), effAt(trial, stPrev, k), trialSm[k - 1]);
      if (prevErr.maxErr > tol) continue;
    }
    // 后一段（trial[k+1] → trial[k+2]）左端点基线变了（prev 邻居换成 trial[k]），同样校验
    if (k + 2 < trial.length) {
      const stNext = trialSt.slice();
      if (!trialLocked[k + 1]) stNext[k + 1] = best.st;
      const j0 = lowerBound(ref, trial[k + 1].time);
      const j1 = lowerBound(ref, trial[k + 2].time + 1e-9);
      const nextErr = segmentError(ref, j0, j1, trial[k + 1].time, trial[k + 2].time,
        effAt(trial, stNext, k + 1), effAt(trial, stNext, k + 2), trialSm[k + 1]);
      if (nextErr.maxErr > tol) continue;
    }
    pts = trial;
    strengths = trialSt;
    smoothness = trialSm;
    locked = trialLocked;
    smoothness[k] = best.sm;
    if (!locked[k + 1]) strengths[k + 1] = best.st;
    i--; // 合并后重新检查同一位置
  }

  // 合并可能让个别段残留超差（邻段基线变化的连锁），补一轮细化
  refine(4);

  // ---- 5) 点数预算：贪心删点（每次删误差增量最小的点）----
  // 颤音保点可能让预算本来就不够（锁定点数 > maxAnchors）。此时继续删
  // 非颤音点只会把滑音/换音删崩，得不偿失：删点代价一旦超过颤音区已接受
  // 的弦高误差就停（预算是软上限，颤音保真优先）。无颤音时预算是硬约束。
  let vibBound = Infinity;
  {
    const errs = segErrors();
    let worstVib = 0;
    for (let k = 0; k < errs.length; k++) {
      if (isVibSeg(k) && errs[k].maxErr > worstVib) worstVib = errs[k].maxErr;
    }
    if (worstVib > 0) vibBound = Math.max(worstVib, tol);
  }
  while (pts.length > maxAnchors) {
    let bestIdx = -1, bestCost = Infinity, bestFit = null;
    for (let i = 1; i < pts.length - 1; i++) {
      if (locked[i] || locked[i - 1] || locked[i + 1]) continue;
      const trial = pts.slice(0, i).concat(pts.slice(i + 1));
      const trialSt = strengths.slice(0, i).concat(strengths.slice(i + 1));
      const trialLocked = locked.slice(0, i).concat(locked.slice(i + 1));
      const k = i - 1;
      const i0 = lowerBound(ref, trial[k].time);
      const i1 = lowerBound(ref, trial[k + 1].time + 1e-9);
      const fit = fitSegment(trial, trialSt, k, ref, i0, i1, { locked: trialLocked, coarseOnly: true });
      let cost = fit.err;
      // 删点改变左邻锚点的基线 → 前一段误差也要计入代价
      if (k > 0) {
        const j0 = lowerBound(ref, trial[k - 1].time);
        const j1 = lowerBound(ref, trial[k].time + 1e-9);
        const stPrev = trialSt.slice();
        stPrev[k + 1] = fit.st;
        const prevErr = segmentError(ref, j0, j1, trial[k - 1].time, trial[k].time,
          effAt(trial, stPrev, k - 1), effAt(trial, stPrev, k), smoothness[k - 1]);
        cost = Math.max(cost, prevErr.maxErr);
      }
      // 右邻锚点的 prev 邻居换成 trial[k] → 后一段左端有效值也变，计入代价
      if (k + 2 < trial.length) {
        const stNext = trialSt.slice();
        if (!trialLocked[k + 1]) stNext[k + 1] = fit.st;
        const j0 = lowerBound(ref, trial[k + 1].time);
        const j1 = lowerBound(ref, trial[k + 2].time + 1e-9);
        const nextErr = segmentError(ref, j0, j1, trial[k + 1].time, trial[k + 2].time,
          effAt(trial, stNext, k + 1), effAt(trial, stNext, k + 2), smoothness[k + 2]);
        cost = Math.max(cost, nextErr.maxErr);
      }
      if (cost < bestCost) { bestCost = cost; bestIdx = i; bestFit = { trial, trialSt, trialLocked, k, fit }; }
    }
    if (bestIdx < 0 || bestCost > vibBound) break; // 全是锁定点 / 预算不可达且保真优先
    const { trial, trialSt, trialLocked, k, fit } = bestFit;
    const trialSm = smoothness.slice(0, bestIdx).concat(smoothness.slice(bestIdx + 1));
    pts = trial;
    strengths = trialSt;
    smoothness = trialSm;
    locked = trialLocked;
    smoothness[k] = fit.sm;
    if (!locked[k + 1]) strengths[k + 1] = fit.st;
  }
  // 删点后邻段基线已变，最后整体重扫一遍参数
  sweep(false);

  const anchors = pts.map((p, i) => ({
    time: p.time,
    pitch: p.pitch,
    strength: Math.round(strengths[i]),
    smoothness: Math.round(smoothness[i]),
  }));
  const err = anchorFitError(anchors, ref);
  return { anchors, maxErrCents: err.maxErrCents, rmsCents: err.rmsCents, vibratoRegions };
}