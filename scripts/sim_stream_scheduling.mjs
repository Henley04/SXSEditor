/**
 * Streaming playback scheduling simulator (fake-data test harness).
 *
 * Ports the renderer scheduling logic (src/renderer/audioPlayback.js chunk
 * handler + src/shared/streamingScheduler.js) 1:1 into a discrete-event
 * simulation with two clocks:
 *   - wall clock: always advances (inference / watchdog / rAF tick on this)
 *   - ctx clock:  advances only while the AudioContext is "running";
 *                 suspend() freezes it (all sources freeze with it)
 *
 * Async fidelity: every step drains microtasks (setImmediate) so the real
 * class's awaits (suspend/resume in-flight promises) resolve exactly like
 * in the renderer event loop.
 *
 * Measures, per scenario:
 *   - overlap : same-fragment vocal sources covering the same content second
 *               at the same ctx time              (the old "重叠" bug)
 *   - loss    : vocal content seconds never played (the "丢片段" symptom)
 *   - drift   : |content position - elapsed| while vocal is audible (the "漂移")
 *
 * Usage: node scripts/sim_stream_scheduling.mjs [variant]
 *   variant: fix (default) | prefix | both
 */

import { StreamingScheduler } from '../src/shared/streamingScheduler.js';

const SR = 48000;
const DT = 0.005;            // simulation step (5ms)
const RAF_PERIOD = 1 / 60;   // 16.7ms
const WATCHDOG_PERIOD = 0.25;
const DEBUG = !!process.env.SIM_DEBUG;
const drain = () => new Promise(r => setImmediate(r));

// ==================== Fake AudioContext ====================

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.running = true;
    this.state = 'running';
    this.sources = [];
  }
  suspend() {
    this.running = false;
    this.state = 'suspended';
    return Promise.resolve();
  }
  resume() {
    this.running = true;
    this.state = 'running';
    return Promise.resolve();
  }
  createBufferSource() {
    const src = { buffer: null, when: 0, offset: 0, started: false, endedFired: false, onended: null };
    this.sources.push(src);
    return src;
  }
}

// ==================== Simulated world ====================

class Sim {
  constructor(scenario, { variant = 'fix' } = {}) {
    this.scenario = scenario;
    this.variant = variant;
    this.ctx = new FakeAudioContext();
    this.playbackStartTime = -1;      // stale from a "previous session"
    this.playheadRaf = null;
    this.isPlaying = false;
    this.streamingStarted = false;
    this.streamingFinished = false;
    this.streamingSources = [];
    this.inferenceDonePending = false;

    this.wall = 0;
    this._rafDue = 0;
    this._watchdogDue = 0;

    this.scheduler = new StreamingScheduler({
      getCtx: () => this.ctx,
      getElapsed: () => this.ctx.currentTime - this.playbackStartTime,
      onWaitStateChange: (waiting) => {
        if (!waiting) return;
        if (this.playheadRaf !== null) this.playheadRaf = null; // cancelAnimationFrame
        this.suspendLog.push({ wall: this.wall, ctxT: this.ctx.currentTime, frontier: this.scheduler.bufferEndSec });
        if (DEBUG) console.log(`[w=${this.wall.toFixed(3)}] WAIT enter: elapsed=${(this.ctx.currentTime - this.playbackStartTime).toFixed(3)} frontier=${this.scheduler.bufferEndSec.toFixed(3)}`);
      },
      watchdogMarginSec: 0.3,
      // min-frontier pacing across streams (ported from renderer _createScheduler)
      getPacingFrontier: () => {
        let minEnd = Infinity;
        for (const s of this.streamEnds.values()) {
          if (!s.done && s.end < minEnd) minEnd = s.end;
        }
        return minEnd;
      },
      onFinish: () => {
        this.streamingFinished = true;
        this.isPlaying = false;
        this.finishedAtElapsed = this.ctx.currentTime - this.playbackStartTime;
        if (DEBUG) console.log(`[w=${this.wall.toFixed(3)}] FINISH @ elapsed=${this.finishedAtElapsed.toFixed(2)}`);
      },
    });

    this.chunkQueue = scenario.chunks.map((c, i) => ({ ...c, idx: i, delivered: false }));
    this._inferenceDoneArmed = false;
    this.streamEnds = new Map();

    // instrumentation
    this.samples = [];
    this.playedIntervals = new Map();
    this.suspendLog = [];
    this.trimLog = [];
    this.dropLog = [];
    this.resumeLog = [];
  }

  step(dt) {
    const prevCtx = this.ctx.currentTime;
    if (this.ctx.running) this.ctx.currentTime += dt;

    // fire source starts/ends on ctx clock
    for (const src of this.ctx.sources) {
      if (!src.buffer || src._validStart === false) continue;
      const end = src.when + (src.buffer.duration - src.offset);
      if (!src.started && src.when <= this.ctx.currentTime) src.started = true;
      if (src.started && !src.endedFired && end <= this.ctx.currentTime) {
        src.endedFired = true;
        if (src.onended) src.onended();
      }
    }

    // instrument vocal content position while audible
    if (this.ctx.running && this.isPlaying) {
      const elapsed = this.ctx.currentTime - this.playbackStartTime;
      for (const src of this.ctx.sources) {
        if (!src.buffer || !src.started || src.endedFired || !src._vocal || src._validStart === false) continue;
        const active = this.ctx.currentTime >= src.when &&
          this.ctx.currentTime < src.when + (src.buffer.duration - src.offset);
        if (!active) continue;
        const contentPos = src._contentStart + (this.ctx.currentTime - src.when);
        this.samples.push({ ctxT: this.ctx.currentTime, elapsed, contentPos, fragIdx: src._fragIdx });
        if (!this.playedIntervals.has(src._fragIdx)) this.playedIntervals.set(src._fragIdx, []);
        this.playedIntervals.get(src._fragIdx).push([contentPos, contentPos + DT]);
      }
    }

    this.wall += dt;

    // rAF tick (foreground)
    if (this.playheadRaf !== null && this.wall >= this._rafDue) {
      this._rafDue = this.wall + RAF_PERIOD;
      this._rafTick();
    }
    // watchdog tick (wall clock)
    if (this.wall >= this._watchdogDue) {
      this._watchdogDue = this.wall + WATCHDOG_PERIOD;
      try {
        const elapsed = this.ctx.currentTime - this.playbackStartTime;
        this.scheduler.checkUnderrun(elapsed, undefined, this.scheduler._watchdogMarginSec);
      } catch (_) {}
    }

    // synthesis promise resolution: 0.1s after last chunk arrival
    if (!this._inferenceDoneArmed) {
      const last = this.chunkQueue[this.chunkQueue.length - 1];
      if (last.delivered && this.wall >= last.arrivalWall + 0.1) {
        this._inferenceDoneArmed = true;
        return this.scheduler.setInferenceDone().then(() => {});
      }
    }

    // deliver due chunk events (one IPC task per step)
    for (const c of this.chunkQueue) {
      if (!c.delivered && this.wall >= c.arrivalWall) {
        c.delivered = true;
        return this._chunkHandler(c);
      }
    }
    return Promise.resolve();
  }

  _rafTick() {
    if (!this.isPlaying) { this.playheadRaf = null; return; }
    const elapsed = this.ctx.currentTime - this.playbackStartTime;
    if (this.scheduler.isWaiting) return;
    if (this._enterStreamingWaitIfUnderrun(elapsed)) return;
    // 兜底停止 (ported from renderer rAF loop)
    const totalFrontierSec = Math.max(this.scheduler.bufferEndSec, this.scenario.accompanimentSec);
    if (this.scheduler.inferenceDone && elapsed >= totalFrontierSec + 0.5) {
      if (!this.streamingFinished) {
        this.streamingFinished = true;
        this.isPlaying = false;
        this.finishedAtElapsed = elapsed;
        if (DEBUG) console.log(`[w=${this.wall.toFixed(3)}] RAF fallback stop @ elapsed=${elapsed.toFixed(2)}`);
      }
      this.playheadRaf = null;
    }
  }

  _enterStreamingWaitIfUnderrun(elapsed) {
    return this.scheduler.checkUnderrun(elapsed, () => {
      if (this.playheadRaf !== null) this.playheadRaf = null;
    });
  }

  // ---------- chunk handler (ported from renderer/audioPlayback.js) ----------

  async _chunkHandler(chunkInfo) {
    if (this.streamingFinished) return; // state.streamingFinished guard
    const ctx = this.ctx;
    const chunkDur = (chunkInfo.sampleEnd - chunkInfo.sampleOffset) / SR;
    const source = { buffer: { duration: chunkDur }, _validStart: true, _vocal: true, _fragIdx: chunkInfo.fragIdx };
    ctx.sources.push(source);

    const chunkStartSec = chunkInfo.sampleOffset / SR;
    const chunkEndSec = chunkInfo.sampleEnd / SR;

    // manifest merge + per-stream delivered-end tracking (ported from renderer)
    if (Array.isArray(chunkInfo.streamManifest)) {
      for (const m of chunkInfo.streamManifest) {
        if (m && m.key != null && !this.streamEnds.has(String(m.key))) {
          this.streamEnds.set(String(m.key), { end: (m.firstStartSample || 0) / SR, done: false });
        }
      }
    }
    const streamKey = chunkInfo.streamKey != null ? String(chunkInfo.streamKey) : 'default';
    let streamState = this.streamEnds.get(streamKey);
    if (!streamState) {
      streamState = { end: chunkStartSec, done: false };
      this.streamEnds.set(streamKey, streamState);
    }
    if (chunkEndSec > streamState.end) streamState.end = chunkEndSec;
    if (chunkInfo.streamLast) streamState.done = true;

    if (!this.streamingStarted) {
      this.streamingStarted = true;
      this.isPlaying = true;
      this.playbackStartTime = ctx.currentTime + 0.05;
      this.playheadRaf = 1; this._rafDue = this.wall + RAF_PERIOD;
      if (this.scenario.accompanimentSec > 0) {
        const acc = { buffer: { duration: this.scenario.accompanimentSec }, when: this.playbackStartTime, offset: 0, _vocal: false };
        ctx.sources.push(acc);
        this.scheduler.addSource();
        acc.onended = () => this.scheduler.sourceEnded();
      }
    }

    if (chunkEndSec > this.scheduler.bufferEndSec) this.scheduler.bufferEndSec = chunkEndSec;

    // late-chunk race check
    const prelimScheduleTime = this.playbackStartTime + chunkStartSec;
    const minTime = ctx.currentTime + 0.01;
    if (prelimScheduleTime < minTime && !this.scheduler.inferenceDone && !this.scheduler.isWaiting) {
      this.scheduler.checkUnderrun(Infinity, () => {
        if (this.playheadRaf !== null) this.playheadRaf = null;
      });
    }

    if (this.scheduler.isWaiting) {
      await this.scheduler.resumeFromWait();  // matches real code
      this.resumeLog.push({ wall: this.wall, ctxT: ctx.currentTime });
      if (!this.playheadRaf) { this.playheadRaf = 1; this._rafDue = this.wall + RAF_PERIOD; }
    }

    const chunkStartCtxTime = this.playbackStartTime + chunkStartSec;
    let startCtxTime;
    if (this.variant === 'fix') {
      startCtxTime = Math.max(chunkStartCtxTime, ctx.currentTime + 0.01);
    } else {
      startCtxTime = Math.max(chunkStartCtxTime, minTime); // pre-fix: minTime from before resume
    }
    const lateSec = Math.max(0, startCtxTime - chunkStartCtxTime);
    const contentStart = chunkStartSec + (this.variant === 'fix' ? lateSec : 0);
    if (DEBUG) console.log(`[w=${this.wall.toFixed(3)}] SCHEDULE [${chunkStartSec.toFixed(2)},${chunkEndSec.toFixed(2)}) frag=${chunkInfo.fragIdx} when=${startCtxTime.toFixed(3)} ctxNow=${ctx.currentTime.toFixed(3)} late=${lateSec.toFixed(3)}`);

    if (this.variant === 'fix') {
      if (lateSec >= chunkDur) {
        this.dropLog.push({ wall: this.wall, chunkStartSec, chunkDur });
        if (DEBUG) console.log(`[w=${this.wall.toFixed(3)}] DROP chunk [${chunkStartSec.toFixed(2)},${chunkEndSec.toFixed(2)})`);
        source._validStart = false;
        if (chunkInfo.isLast) this.scheduler.markLastReceived();
        return;
      }
      if (lateSec > 0) this.trimLog.push({ wall: this.wall, chunkStartSec, lateSec });
    }

    source.when = startCtxTime;
    source.offset = this.variant === 'fix' ? lateSec : 0;
    source._contentStart = contentStart;

    this.scheduler.addSource();
    if (chunkInfo.isLast) this.scheduler.markLastReceived();
    source.onended = () => this.scheduler.sourceEnded();
    this.streamingSources.push(source);
  }

  // ---------- analysis ----------

  analyze() {
    const result = { scenario: this.scenario.name, variant: this.variant };

    // 1) overlap: same fragment, two sources covering same content second simultaneously
    let overlapSec = 0;
    const perFrag = new Map();
    for (const src of this.ctx.sources) {
      if (!src._vocal || src.when === undefined || src._validStart === false || !src.started) continue;
      const dur = src.buffer.duration - src.offset;
      const arr = [src._contentStart, src._contentStart + dur, src.when, src.when + dur];
      if (!perFrag.has(src._fragIdx)) perFrag.set(src._fragIdx, []);
      perFrag.get(src._fragIdx).push(arr);
    }
    for (const [, list] of perFrag) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          const cOverlap = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
          const tOverlap = Math.min(a[3], b[3]) - Math.max(a[2], b[2]);
          if (cOverlap > 0.02 && tOverlap > 0.02) overlapSec += Math.min(cOverlap, tOverlap);
        }
      }
    }
    result.overlapSec = overlapSec;

    // 2) loss: gaps in union of played content per fragment vs chunk content span
    let totalLoss = 0, gaps = 0, lossSpans = [];
    for (const [fragIdx, chunks] of Object.entries(groupBy(this.scenario.chunks, 'fragIdx'))) {
      const spanStart = Math.min(...chunks.map(c => c.sampleOffset / SR));
      const spanEnd = Math.max(...chunks.map(c => c.sampleEnd / SR));
      const played = mergeIntervals((this.playedIntervals.get(Number(fragIdx)) || [])
        .map(([a, b]) => [a, Math.min(b, spanEnd)]));
      let cursor = spanStart;
      for (const [s, e] of played) {
        if (s > cursor + 0.05) { gaps++; totalLoss += s - cursor; lossSpans.push([fragIdx, +cursor.toFixed(2), +s.toFixed(2)]); }
        cursor = Math.max(cursor, e);
      }
      if (spanEnd > cursor + 0.05) { gaps++; totalLoss += spanEnd - cursor; lossSpans.push([fragIdx, +cursor.toFixed(2), +spanEnd.toFixed(2), 'tail']); }
    }
    result.lossSec = totalLoss;
    result.lossGaps = gaps;
    result.lossSpans = lossSpans.slice(0, 8);

    // 3) drift: content position vs elapsed while audible (exclude warmup)
    let maxDrift = 0;
    for (const s of this.samples) {
      if (s.ctxT < this.playbackStartTime + 0.2) continue;
      maxDrift = Math.max(maxDrift, Math.abs(s.contentPos - s.elapsed));
    }
    result.maxDriftSec = maxDrift;

    result.waits = this.suspendLog.length;
    result.trims = this.trimLog.length;
    result.dropped = this.dropLog.length;
    result.finishedAtElapsed = Number.isFinite(this.finishedAtElapsed)
      ? this.finishedAtElapsed : -1;
    // total frozen wall time: sum of matched suspend->resume pairs
    let frozenTotal = 0;
    const pairs = Math.min(this.suspendLog.length, this.resumeLog.length);
    for (let i = 0; i < pairs; i++) {
      frozenTotal += Math.max(0, this.resumeLog[i].wall - this.suspendLog[i].wall);
    }
    result.frozenWallSec = frozenTotal;
    return result;
  }

  async run() {
    const totalWall = this.scenario.totalWallSec;
    const steps = Math.ceil(totalWall / DT);
    for (let i = 0; i < steps; i++) {
      await this.step(DT);
      await drain();
      if (this.streamingFinished && this.wall > totalWall * 0.98) break;
    }
    return this.analyze();
  }
}

// ==================== helpers ====================

function groupBy(arr, key) {
  const out = {};
  for (const item of arr) (out[item[key]] ||= []).push(item);
  return out;
}

function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  intervals.sort((a, b) => a[0] - b[0]);
  const out = [intervals[0].slice()];
  for (let i = 1; i < intervals.length; i++) {
    const last = out[out.length - 1];
    if (intervals[i][0] <= last[1] + 1e-9) last[1] = Math.max(last[1], intervals[i][1]);
    else out.push(intervals[i].slice());
  }
  return out;
}

/** Build chunks; mirrors the pipeline: per-region chunk plans are merged into a
 *  global queue sorted by chunk global start time, then inferred SEQUENTIALLY
 *  in that order (arrival = cumulative inference wall time). */
function buildChunks(specs) {
  const all = [];
  for (const s of specs) {
    let pos = s.startSec;
    while (pos < s.endSec - 1e-6) {
      const chunkSec = typeof s.chunkSec === 'function' ? s.chunkSec(pos) : s.chunkSec;
      const end = Math.min(s.endSec, pos + chunkSec);
      const infer = s.inferSec === 'cache' ? 0.001 : (typeof s.inferSec === 'function' ? s.inferSec(pos) : s.inferSec);
      all.push({
        fragIdx: s.fragIdx,
        startSec: pos,
        endSec: end,
        infer,
        sampleOffset: Math.round(pos * SR),
        sampleEnd: Math.round(end * SR),
        isLast: false,
      });
      pos = end;
    }
  }
  all.sort((a, b) => a.startSec - b.startSec);
  let wall = 1.0; // pipeline startup (encoder / noise / planning)
  for (const c of all) {
    wall += c.infer;
    c.arrivalWall = wall;
  }
  if (all.length) all[all.length - 1].isLast = true;
  // streamKey per fragment group; streamLast = last chunk of each group
  // (mirrors pipeline streamKey = fragIdx:regionIdx + lastGiPerPrep marking)
  const byFrag = groupBy(all, 'fragIdx');
  const manifest = [];
  for (const [, list] of Object.entries(byFrag)) {
    for (const c of list) c.streamKey = String(c.fragIdx);
    list[list.length - 1].streamLast = true;
    manifest.push({ key: list[0].streamKey, firstStartSample: list[0].sampleOffset });
  }
  for (const c of all) c.streamManifest = manifest;
  return all;
}

// ==================== scenarios ====================

function makeScenarios() {
  const scenarios = [];
  const frag = (fragIdx, startSec, endSec, chunkSec, inferSec) =>
    ({ fragIdx, startSec, endSec, chunkSec, inferSec });

  scenarios.push({
    name: 'A: single frag, inference faster than realtime',
    accompanimentSec: 40, totalWallSec: 60,
    chunks: buildChunks([frag(0, 2, 22, 2.0, 1.2)]),
  });
  scenarios.push({
    name: 'B: single frag, inference slightly slower',
    accompanimentSec: 60, totalWallSec: 90,
    chunks: buildChunks([frag(0, 2, 32, 2.0, 2.4)]),
  });
  scenarios.push({
    name: 'C: single frag, occasional 4s stall (2s chunks)',
    accompanimentSec: 60, totalWallSec: 90,
    chunks: buildChunks([frag(0, 2, 32, 2.0, (pos) => (Math.abs(pos - 8) < 0.1 || Math.abs(pos - 18) < 0.1) ? 4.0 : 1.4)]),
  });
  scenarios.push({
    name: 'C2: severe stalls (6s per 2s chunk)',
    accompanimentSec: 80, totalWallSec: 120,
    chunks: buildChunks([frag(0, 2, 32, 2.0, 6.0)]),
  });
  scenarios.push({
    name: 'D: slow first chunk (8s)',
    accompanimentSec: 50, totalWallSec: 70,
    chunks: buildChunks([frag(0, 2, 22, 2.0, (pos) => pos < 2.1 ? 8.0 : 1.2)]),
  });
  scenarios.push({
    name: 'E: two sequential frags with 5s rest',
    accompanimentSec: 60, totalWallSec: 90,
    chunks: buildChunks([frag(0, 2, 12, 2.0, 1.4), frag(1, 17, 27, 2.0, 1.4)]),
  });
  scenarios.push({
    name: 'F: two simultaneous frags (dual singer)',
    accompanimentSec: 40, totalWallSec: 70,
    chunks: buildChunks([frag(0, 2, 22, 2.0, 1.4), frag(1, 2, 22, 2.0, 1.8)]),
  });
  scenarios.push({
    name: 'F2: three simultaneous frags, uneven speed',
    accompanimentSec: 40, totalWallSec: 80,
    chunks: buildChunks([frag(0, 2, 22, 2.0, 1.2), frag(1, 2, 22, 2.0, 1.9), frag(2, 2, 22, 2.0, 2.6)]),
  });
  scenarios.push({
    name: 'I: two regions w/ rest, 2nd region late first chunk',
    accompanimentSec: 60, totalWallSec: 90,
    chunks: buildChunks([frag(0, 2, 12, 2.0, 1.4), frag(1, 22, 32, 2.0, 1.4)]),
  });
  scenarios.push({
    name: 'G: cache-hit replay (all instant)',
    accompanimentSec: 40, totalWallSec: 50,
    chunks: buildChunks([frag(0, 2, 22, 2.0, 'cache')]),
  });
  scenarios.push({
    name: 'H: uneven chunk durations',
    accompanimentSec: 60, totalWallSec: 90,
    chunks: buildChunks([frag(0, 2, 32, (pos) => 1.3 + (Math.round(pos) % 3) * 0.7, 1.4)]),
  });
  // ---- long-rest-gap scenarios (user report: "even after inference finished,
  // playback does not seem to continue" with a 30s silent gap) ----
  // J: splitLongRestRegions equivalent — region A [2,12], 30s silent gap,
  //    region B [42,52]; inference finishes at ~wall 13, long before playhead
  //    reaches the gap. Expected: playhead walks the 30s gap in real time
  //    (silent / accompaniment only), B plays on time, no waits, no loss.
  scenarios.push({
    name: 'J: 30s rest gap, inference finishes way early',
    accompanimentSec: 55, totalWallSec: 70,
    chunks: buildChunks([frag(0, 2, 12, 2.0, 1.2), frag(1, 42, 52, 2.0, 1.2)]),
  });
  // J2: same 30s gap, but region B infers very slowly — playhead must reach
  //     the gap tail (~39.7), freeze once ("waiting for inference"), resume
  //     when B's first chunk lands, and schedule B exactly at 42 with zero
  //     trim/drop (manifest pinned the frontier at B's first-chunk start).
  scenarios.push({
    name: 'J2: 30s rest gap, 2nd region slow (freeze in gap tail)',
    accompanimentSec: 55, totalWallSec: 80,
    chunks: buildChunks([frag(0, 2, 12, 2.0, 2.0), frag(1, 42, 52, 2.0, (pos) => pos < 42.1 ? 36.0 : 2.0)]),
  });
  // J3: cache replay — every chunk arrives ~instantly (inference "done" before
  //     playback even starts). Playback must still walk the 30s gap in real
  //     time with zero vocal content there, then play B; finish at B's end.
  scenarios.push({
    name: 'J3: 30s rest gap, cache replay (no accompaniment)',
    accompanimentSec: 0, totalWallSec: 65,
    chunks: buildChunks([frag(0, 2, 12, 2.0, 'cache'), frag(1, 42, 52, 2.0, 'cache')]),
  });
  return scenarios;
}

// ==================== main ====================

const variantArg = process.argv[2] || 'both';
const variants = variantArg === 'both' ? ['prefix', 'fix'] : [variantArg];
const rows = [];
for (const scenario of makeScenarios()) {
  for (const variant of variants) {
    const sim = new Sim(scenario, { variant });
    rows.push(await sim.run());
  }
}

const w = [56, 8, 10, 8, 6, 9, 6, 7, 9, 8];
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('scenario', w[0]) + pad('variant', w[1]) + pad('overlap(s)', w[2]) + pad('loss(s)', w[3]) + pad('gaps', w[4]) + pad('drift(s)', w[5]) + pad('waits', w[6]) + pad('drops', w[7]) + pad('finish@el', w[8]) + pad('frozen(w)', w[9]));
console.log('-'.repeat(w.reduce((a, b) => a + b, 0)));
for (const r of rows) {
  console.log(
    pad(r.scenario, w[0]) + pad(r.variant, w[1]) +
    pad(r.overlapSec.toFixed(3), w[2]) + pad(r.lossSec.toFixed(3), w[3]) +
    pad(r.lossGaps, w[4]) + pad(r.maxDriftSec.toFixed(3), w[5]) + pad(r.waits, w[6]) + pad(r.dropped, w[7]) +
    pad(r.finishedAtElapsed.toFixed(2), w[8]) + pad(r.frozenWallSec.toFixed(2), w[9])
  );
}
console.log('\nLoss spans (frag, from, to) per run:');
for (const r of rows) {
  if (r.lossSpans.length) console.log(`  [${r.variant}] ${r.scenario}: ` + JSON.stringify(r.lossSpans));
}
const bad = rows.filter(r => r.variant === 'fix' && (r.overlapSec > 0.05 || r.maxDriftSec > 0.05));
if (bad.length) {
  console.log('\nFAIL: fix variant still has overlap/drift in:', bad.map(b => b.scenario).join('; '));
  process.exitCode = 1;
} else {
  console.log('\nOK: fix variant has no overlap / no drift (loss reported above for inspection).');
}
