/**
 * 分片编辑器播放模拟器（虚拟时钟 + 真实模块）。
 *
 * 与 scripts/sim_stream_scheduling.mjs（把主页面逻辑"移植"进模拟器）不同，
 * 本文件**直接驱动 src/fragmentEditor/audioPlayback.js 的真实代码**：
 *   · AudioContext 换成虚拟时钟实现，suspend 真的冻结时钟
 *   · setTimeout / setInterval / requestAnimationFrame / Date.now / performance.now
 *     全部挂到虚拟时钟上（播放头的活性探针、StreamingScheduler 的 watchdog 都必须
 *     跟模拟时间同源，否则测到的不是真实行为）
 *   · chunk 按"推理墙钟"到达，走真实的 onFragmentSVSChunkAudio 回调
 *
 * 输出每个 chunk 的调度与实际发声区间，以及：
 *   gaps(静音缝) / overlap(重复发声) / drift(播放头与声音错位) / suspend 次数
 *
 * 用法：
 *   node scripts/sim_fragment_playback.js              # 全部场景
 *   node scripts/sim_fragment_playback.js B            # 只跑名字含 B 的场景
 *   SIM_DEBUG=1 node scripts/sim_fragment_playback.js  # 逐事件日志
 */

require('@babel/register')({
  presets: ['@babel/preset-env'],
  ignore: [/node_modules/],
});

const { JSDOM } = require('jsdom');

const SR = 24000;
const DT_MS = 4;               // 模拟步长
const RAF_PERIOD_MS = 1000 / 60;
const OUTPUT_LATENCY = 0.02;   // 与 FakeAudioContext.outputLatency 一致
const DEBUG = !!process.env.SIM_DEBUG;

// ==================== 虚拟时钟 ====================
let vnow = 0;
const timers = new Map();
let timerSeq = 0;

global.setTimeout = (fn, ms = 0, ...args) => {
  const id = ++timerSeq;
  timers.set(id, { due: vnow + Math.max(0, ms), fn, args, interval: null });
  return id;
};
global.setInterval = (fn, ms = 0, ...args) => {
  const id = ++timerSeq;
  timers.set(id, { due: vnow + Math.max(1, ms), fn, args, interval: Math.max(1, ms) });
  return id;
};
global.clearTimeout = (id) => { timers.delete(id); };
global.clearInterval = (id) => { timers.delete(id); };
Date.now = () => Math.floor(vnow);
try { global.performance.now = () => vnow; } catch (_) {}

let rafSeq = 0;
const rafQueue = new Map();
global.requestAnimationFrame = (cb) => { const id = ++rafSeq; rafQueue.set(id, cb); return id; };
global.cancelAnimationFrame = (id) => { rafQueue.delete(id); };
let nextRafDue = 0;

function runDueTimers() {
  let guard = 0;
  while (guard++ < 20000) {
    let pickId = null;
    let pickT = null;
    for (const [id, t] of timers) {
      if (t.due <= vnow && (!pickT || t.due < pickT.due)) { pickId = id; pickT = t; }
    }
    if (!pickT) return;
    if (pickT.interval) pickT.due = vnow + pickT.interval;
    else timers.delete(pickId);
    try { pickT.fn(...pickT.args); } catch (e) { console.error('[timer]', e); }
  }
}

function runDueRaf() {
  if (vnow < nextRafDue) return;
  nextRafDue = vnow + RAF_PERIOD_MS;
  if (rafQueue.size === 0) return;
  const due = [...rafQueue.entries()];
  rafQueue.clear();
  for (const [, cb] of due) {
    try { cb(vnow); } catch (e) { console.error('[raf]', e); }
  }
}

// ==================== DOM ====================
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true, url: 'http://localhost',
});
global.window = dom.window;
global.document = dom.window.document;
// 最小化/恢复：Chromium 在 document.hidden 期间挂起 rAF（且不保证恢复后重新
// 派发）。用虚拟时钟驱动这个标志，才能测"没有 visibilitychange 事件"的最坏情况。
let _hiddenFrom = Infinity;
let _hiddenUntil = -Infinity;
Object.defineProperty(global.document, 'hidden', {
  configurable: true,
  get: () => vnow >= _hiddenFrom && vnow < _hiddenUntil,
});
global.localStorage = dom.window.localStorage;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.CustomEvent = dom.window.CustomEvent;

function ensureDom() {
  for (const id of ['piano-roll', 'piano-keys', 'param-roll', 'velocity-roll', 'pitch-roll']) {
    if (!document.getElementById(id)) {
      const c = document.createElement('canvas');
      c.id = id; c.width = 800; c.height = 400;
      document.body.appendChild(c);
    }
  }
  if (!document.getElementById('autoShiftCheck')) {
    const el = document.createElement('input');
    el.type = 'checkbox'; el.id = 'autoShiftCheck';
    document.body.appendChild(el);
  }
  if (!document.getElementById('btn-play-fragment')) {
    const b = document.createElement('button'); b.id = 'btn-play-fragment';
    document.body.appendChild(b);
  }
  if (!document.getElementById('btn-export-fragment')) {
    const b = document.createElement('button'); b.id = 'btn-export-fragment';
    document.body.appendChild(b);
  }
}
ensureDom();

const CTX_OPS = ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo',
  'bezierCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'fill', 'stroke', 'clip',
  'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'drawImage', 'putImageData',
  'setTransform', 'resetTransform', 'transform', 'translate', 'scale', 'rotate', 'setLineDash'];
global.HTMLCanvasElement.prototype.getContext = function () {
  if (!this.__ctx2d) {
    const c = { canvas: this, font: '13px sans-serif' };
    for (const op of CTX_OPS) c[op] = () => {};
    c.getLineDash = () => [];
    c.createLinearGradient = () => ({ addColorStop() {} });
    c.createRadialGradient = () => ({ addColorStop() {} });
    c.createPattern = () => null;
    c.measureText = (s) => ({ width: String(s || '').length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2 });
    c.getImageData = (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4), width: w, height: h });
    c.createImageData = (w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4), width: w, height: h });
    this.__ctx2d = c;
  }
  return this.__ctx2d;
};

// ==================== 假 AudioContext ====================
// chunk 缓冲区用唯一首样本值标记，source.start() 时据此反查它属于哪个 chunk。
// （模块内部会 createBuffer + set(chunkAudio)，只有首样本能穿透）
const chunkByMark = new Map();   // mark -> { idx, relStart, dur }
let simSession = 0;              // 播放会话号（重播/拖动后递增）

class FakeGain {
  constructor(ctx) {
    this._ctx = ctx;
    this._events = [];
    const self = this;
    this.gain = {
      value: 1,
      setValueAtTime(v, t) { self._events.push({ type: 'set', v, t }); return this; },
      linearRampToValueAtTime(v, t) { self._events.push({ type: 'ramp', v, t }); return this; },
      cancelScheduledValues() { self._events.length = 0; return this; },
    };
  }
  connect(n) { return n; }
  disconnect() { this._disconnected = true; }
  /** WebAudio 自动化求值：按事件时间顺序，ramp 从前一个事件值线性插值。 */
  valueAt(t) {
    const ev = this._events.slice().sort((a, b) => a.t - b.t);
    if (ev.length === 0) return this.gain.value;
    let prev = { type: 'set', v: this.gain.value, t: -Infinity };
    if (t < ev[0].t) return ev[0].type === 'ramp' ? this.gain.value : ev[0].v;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.t > t) {
        if (e.type === 'ramp') {
          const span = e.t - prev.t;
          const k = span > 0 ? (t - prev.t) / span : 1;
          return prev.v + (e.v - prev.v) * Math.max(0, Math.min(1, k));
        }
        return prev.v;
      }
      prev = e;
    }
    return prev.v;
  }
}
class FakePanner {
  constructor() { this.pan = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} }; }
  connect(n) { return n; }
  disconnect() {}
}
class FakeBufferSource {
  constructor(ctx) {
    this._ctx = ctx;
    this.buffer = null;
    this.onended = null;
    this._when = null;
    this._offset = 0;
    this._stopped = false;
    this._ended = false;
    this._meta = null;
  }
  connect(n) { (this._chain || (this._chain = [])).push(n); return n; }
  disconnect() {}
  /** 本 source 在 ctx 时刻 t 的总增益（链路各级 gain 乘积）。 */
  gainAt(t) {
    let g = 1;
    for (const n of (this._chain || [])) {
      if (n && typeof n.valueAt === 'function') g *= n.valueAt(t);
    }
    return g;
  }
  start(when, offset) {
    if (this._when !== null) throw new Error('start() called twice');
    this._when = when;
    this._offset = offset || 0;
    // 反查 chunk：取缓冲区中点样本（chunk 用唯一常量填充，头部渐入不影响中点）
    const len = this.buffer ? this.buffer.length : 0;
    const mark = len > 1 ? this.buffer.getChannelData(0)[Math.floor(len / 2)] : 0;
    this._session = simSession;
    const rec = chunkByMark.get(mark);
    if (rec) {
      // 模块会裁头（重叠 / 起播位置 / 迟到）后再建 buffer：内容起点 =
      // chunk 原点 + 裁掉的秒数；start(when, offset) 的 offset 再往后算。
      const trimmedSec = Math.max(0, rec.dur - len / SR);
      this._meta = { kind: 'chunk', idx: rec.idx, relStart: rec.relStart, trimmedSec, abs: false };
    } else {
      this._meta = { kind: 'full', idx: -1, relStart: 0, trimmedSec: 0, abs: true };
    }
    this._ctx._sources.push(this);
    if (DEBUG) {
      console.log(`  [ctx ${this._ctx.currentTime.toFixed(3)}] start(${this._meta.kind}#${this._meta.idx} when=${when.toFixed(3)} off=${(offset || 0).toFixed(3)} dur=${len ? (len / SR).toFixed(3) : '?'})`);
    }
  }
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._stoppedAt = this._ctx.currentTime;   // 被停止时真正播到哪里
    this._ended = true;
  }
}
class FakeAudioContext {
  constructor(opts = {}) {
    this.sampleRate = SR;
    this._controlDelayMs = 0;   // suspend()/resume() 的真实异步时延（控制消息）
    // 冷启动：新建的 AudioContext 处于 suspended，resume() 要等设备就绪；
    // setSinkId 也是一次异步设备切换。两者都发生在首个 chunk 的处理途中，
    // invoke 回执完全可能在此期间先到达（真实竞态）。
    this._coldStartMs = opts.coldStartMs || 0;
    this._sinkIdMs = opts.sinkIdMs || 0;
    this.state = this._coldStartMs > 0 ? 'suspended' : 'running';
    this.destination = { _isDestination: true };
    this.outputLatency = OUTPUT_LATENCY;
    this.baseLatency = 0.01;
    this._clock = 0;
    this._sources = [];
    this._gains = [];
    this.suspendCalls = 0;
    this.resumeCalls = 0;
    this.log = [];
  }
  get currentTime() { return this._clock; }
  createGain() { const g = new FakeGain(this); this._gains.push(g); return g; }
  createStereoPanner() { return new FakePanner(); }
  setSinkId(id) {
    this._sinkId = id;
    if (this._sinkIdMs > 0) return new Promise((res) => setTimeout(res, this._sinkIdMs));
    return Promise.resolve();
  }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len);
    return {
      length: len, numberOfChannels: ch, sampleRate: rate, duration: len / rate,
      getChannelData: () => data,
    };
  }
  createBufferSource() { return new FakeBufferSource(this); }
  suspend() {
    this.suspendCalls += 1;
    this.log.push({ t: this._clock, ev: 'suspend' });
    if (DEBUG) console.log(`  [ctx ${this._clock.toFixed(3)}] ctx.suspend()`);
    if (this._controlDelayMs > 0) {
      return new Promise((res) => {
        setTimeout(() => { this.state = 'suspended'; res(); }, this._controlDelayMs);
      });
    }
    this.state = 'suspended';
    return Promise.resolve();
  }
  resume() {
    this.resumeCalls += 1;
    this.log.push({ t: this._clock, ev: 'resume' });
    if (DEBUG) console.log(`  [ctx ${this._clock.toFixed(3)}] ctx.resume()`);
    let delay = this._controlDelayMs;
    if (this._coldStartMs > 0) { delay = Math.max(delay, this._coldStartMs); this._coldStartMs = 0; }
    if (delay > 0) {
      return new Promise((res) => {
        setTimeout(() => { this.state = 'running'; res(); }, delay);
      });
    }
    this.state = 'running';
    return Promise.resolve();
  }
  advance(dtSec) {
    if (this.state !== 'running') return;
    this._clock += dtSec;
    for (const s of this._sources) {
      if (s._ended || s._when === null) continue;
      const dur = s.buffer ? s.buffer.duration - s._offset : 0;
      if (this._clock >= s._when + dur) {
        s._ended = true;
        if (s.onended) { try { s.onended(); } catch (e) { console.error('[onended]', e); } }
      }
    }
  }
  activeAt(ctxTime) {
    const out = [];
    for (const s of this._sources) {
      if (s._when === null || s._ended || s._stopped || !s._meta) continue;
      const dur = s.buffer ? s.buffer.duration - s._offset : 0;
      if (ctxTime >= s._when && ctxTime < s._when + dur) out.push(s);
    }
    return out;
  }
}

// ==================== 单场景运行 ====================
async function runScenario(spec) {
  chunkByMark.clear();
  const bpm = spec.bpm || 120;
  const firstNoteStartSec = spec.firstNoteStartSec;
  const ctx = new FakeAudioContext({ coldStartMs: spec.coldStartMs, sinkIdMs: spec.sinkIdMs });
  ctx._controlDelayMs = spec.controlDelayMs || 0;

  const state = require('../src/fragmentEditor/state.js');
  state.setFragmentAudioContext(null);
  state.setFragmentGainNode(null);
  state.setFragmentAudioSource(null);
  global.window.AudioContext = function () { return ctx; };
  global.AudioContext = global.window.AudioContext;

  // 按 regions 铺音符
  const notes = [];
  let nid = 1;
  for (const seg of spec.regions) {
    const startBeat = (seg.startSec / 60) * bpm;
    const endBeat = (seg.endSec / 60) * bpm;
    for (let b = startBeat; b < endBeat - 1e-6; b += 4) {
      notes.push({
        id: nid++, pitch: 60 + (nid % 3), start: b, duration: 4, lyric: 'la',
        fadeIn: spec.noteFade ? spec.noteFade.fadeIn : 0,
        fadeOut: spec.noteFade ? spec.noteFade.fadeOut : 0,
      });
    }
  }
  state.setPipelineInitialized(true);
  state.setSampleRate(SR);
  state.setFragmentAudioSettings({ audioOutputMode: 'shared', audioVolume: 1, previewDiffStepChunkEnabled: true });
  state.setNotes(notes);
  state.setCurrentProject({ bpm });
  state.setCurrentFragment({ id: 'frag1', notes, duration: (spec.fragmentDurationSec / 60) * bpm, singerId: null });
  state.setWavFileBuffer(null);
  state.setSingerAnnotation(null);
  state.setTrackBackend({ type: 'sxs' });
  state.setFragmentAudioData(null);
  state.setFragmentAudioDataSignature(null);
  state.setFragmentPlayStartPosition(spec.playFromSec || 0);
  state.setFragmentIsPlaying(false);
  state.setFragmentIsSynthesizing(false);
  state.setFragmentIsExporting(false);
  state.setFragmentIsAutoInferring(false);
  state.setFragmentCurrentTime(0);

  // chunk 计划：
  //   mode='single' —— 单 segment 分块扩散（index.js useStreamingChunked）：
  //       非首块从「上一块末端 - overlap」开始，流水线不裁头 → sampleOffset 回退。
  //   mode='multi'  —— 多 segment 流式发射器（_createSegmentStreamEmitter）：
  //       区间之间补静音 chunk、segment 之间的重叠由主进程裁掉 → 严格连续。
  const chunks = [];
  let ci = 0;
  if (spec.mode === 'cache') {
    // 整段音频缓存命中：主进程把整段按 2s 切块**一次性**重放（burst），
    // invoke 几乎同时返回。渲染层必须逐块排程、且不能因为"回执先到"再整段播一遍。
    let p = 0;
    while (p < spec.fragmentDurationSec - 1e-6) {
      const dur = Math.min(2, spec.fragmentDurationSec - p);
      chunks.push({ idx: ci++, absStartSec: p, dur, inferSec: 0 });
      p += dur;
    }
  } else if (spec.mode === 'multi') {
    let frontier = spec.regions[0].startSec;
    for (const seg of spec.regions) {
      const gap = seg.startSec - frontier;
      if (gap > 0.021) {
        chunks.push({ idx: ci++, absStartSec: frontier, dur: gap, inferSec: 0.001 });
        frontier = seg.startSec;
      }
      let p = Math.max(seg.startSec, frontier);
      while (p < seg.endSec - 1e-6) {
        const dur = Math.min(seg.chunkSec, seg.endSec - p);
        chunks.push({ idx: ci++, absStartSec: p, dur, inferSec: seg.inferSec });
        p += dur;
      }
      frontier = p;
    }
  } else {
    for (const seg of spec.regions) {
      const ov = seg.overlapSec || 0;
      let p = seg.startSec;
      let first = true;
      while (p < seg.endSec - 1e-6) {
        const start = first ? p : Math.max(seg.startSec, p - ov);
        const dur = Math.min(seg.chunkSec, seg.endSec - start);
        chunks.push({ idx: ci++, absStartSec: start, dur, inferSec: seg.inferSec });
        p = start + dur;
        first = false;
      }
    }
  }
  chunks.sort((a, b) => a.absStartSec - b.absStartSec);
  chunks.forEach((c, i) => { c.idx = i; });
  let wallCursor = spec.startupSec;
  for (const c of chunks) { wallCursor += c.inferSec; c.arrivalSec = wallCursor; }

  let chunkCb = null;
  let synthResolve = null;
  const synthPromise = new Promise((res) => { synthResolve = res; });
  const fullSamples = Math.round(spec.fragmentDurationSec * SR);

  global.window.electronAPI = {
    getSettings: async () => ({
      audioOutputMode: 'shared', audioVolume: 1,
      // 设了输出设备才会走 ctx.setSinkId（冷启动竞态的另一半）
      audioOutputDevice: spec.sinkIdMs ? 2 : -1,
    }),
    onFragmentSVSChunkAudio: (cb) => { chunkCb = cb; return () => { chunkCb = null; }; },
    synthesizeFragmentSVS: () => synthPromise,
    onAudioEnded: () => () => {},
    audioStop: async () => ({ success: true }),
    getFragmentSVSSampleRate: async () => SR,
    cancelSVSSynthesis: async () => ({ success: true }),
  };

  const playback = require('../src/fragmentEditor/audioPlayback.js');
  playback.stopFragmentPlayback();
  state.setFragmentPlayStartPosition(spec.playFromSec || 0);
  state.setFragmentIsPlaying(false);

  // 每个 chunk 一个唯一标记（填满整块，取中点即可反查）
  for (const c of chunks) {
    c.relStart = c.absStartSec - firstNoteStartSec;
    c.mark = c.idx + 1;
    chunkByMark.set(c.mark, { idx: c.idx, relStart: c.relStart, dur: c.dur });
  }
  const samples = [];
  const chunkEvents = [];
  let playPromise = playback.playFragment();
  let nextArrival = 0;
  let inferenceDone = false;
  const totalWallMs = spec.totalWallSec * 1000;
  let inferDoneMs = (wallCursor + 0.05) * 1000;
  const actions = (spec.actions || []).map((a) => ({ ...a, done: false }));
  const actionLog = [];
  _hiddenFrom = spec.hidden ? spec.hidden.fromSec * 1000 : Infinity;
  _hiddenUntil = spec.hidden ? spec.hidden.toSec * 1000 : -Infinity;
  // 控制延迟时间线：模拟负载在播放过程中起停（开始训练 / 开始录屏 / 负载消失）。
  const cdTimeline = (spec.controlDelayTimeline || []).slice().sort((a, b) => a.atSec - b.atSec);
  let cdIdx = 0;
  let wasHidden = false;

  while (vnow < totalWallMs) {
    // 进入最小化：Chromium 会把已排队的 rAF 回调直接丢掉（恢复后也不补发）。
    // 只清队列、不清 state 里的 id —— 这才是"id 非空但回调永远不会跑"的真实
    // 情形，只有心跳看门狗能救回来。
    if (document.hidden && !wasHidden) rafQueue.clear();
    wasHidden = document.hidden;
    while (cdIdx < cdTimeline.length && vnow >= cdTimeline[cdIdx].atSec * 1000) {
      ctx._controlDelayMs = cdTimeline[cdIdx].ms;
      if (DEBUG) console.log(`[wall ${(vnow / 1000).toFixed(2)}] CONTROL DELAY -> ${ctx._controlDelayMs}ms`);
      cdIdx += 1;
    }

    // 交互动作（停止 / 重播 / 拖动播放头）
    for (const a of actions) {
      if (a.done || vnow < a.atSec * 1000 - 1e-6) continue;
      a.done = true;
      simSession += 1;
      actionLog.push({ type: a.type, atSec: a.atSec, playhead: state.getFragmentCurrentTime() });
      if (a.type === 'stop') {
        if (!playback.cancelFragmentSynthesis()) playback.stopFragmentPlayback();
        state.setFragmentCurrentTime(0);
        state.setFragmentPlayStartPosition(0);
      } else if (a.type === 'play') {
        // 新一轮推理：主进程会从第一个 chunk 重新发（分片缓存命中时极快，
        // 这里仍按原耗时走，属于更严苛的 underrun 场景）
        let w = vnow / 1000 + spec.startupSec;
        for (const c of chunks) { w += c.inferSec; c.arrivalSec = w; }
        inferDoneMs = (w + 0.05) * 1000;
        nextArrival = 0;
        inferenceDone = false;
        playPromise = playback.playFragment();
      } else if (a.type === 'setpos') {
        // 时间轴点一下（不播放）：只改起播位置 + 视觉播放头
        if (state.getFragmentIsPlaying()) playback.stopFragmentPlayback();
        state.setFragmentPlayStartPosition(a.pos);
        state.setFragmentCurrentTime(a.pos);
      } else if (a.type === 'seek') {
        playback.seekFragmentPlayback(a.pos);
      } else if (a.type === 'seek-drag') {
        // 时间轴 mousedown → 拖拽 → mouseup 的真实路径
        if (state.getFragmentIsPlaying()) playback.stopFragmentPlayback();
        state.setFragmentPlayStartPosition(a.pos);
        playback.seekFragmentPlayback(a.pos);
      }
    }

    while (nextArrival < chunks.length && vnow >= chunks[nextArrival].arrivalSec * 1000 - 1e-6) {
      const c = chunks[nextArrival++];
      const audio = new Float32Array(Math.round(c.dur * SR));
      audio.fill(c.mark);
      const chunkInfo = {
        chunkIndex: c.idx,
        sampleOffset: Math.round(c.relStart * SR),
        sampleEnd: Math.round((c.relStart + c.dur) * SR),
        audio,
        totalSamples: fullSamples,
        isLast: c.idx === chunks.length - 1,
      };
      chunkEvents.push({ idx: c.idx, arrivalWall: vnow / 1000, relStart: c.relStart, absStartSec: c.absStartSec, dur: c.dur });
      if (DEBUG) console.log(`[wall ${(vnow / 1000).toFixed(2)}] CHUNK ${c.idx} abs=[${c.absStartSec.toFixed(2)},${(c.absStartSec + c.dur).toFixed(2)}) rel=${c.relStart.toFixed(2)}`);
      const cb = chunkCb;
      if (cb) setTimeout(() => cb(chunkInfo), 0);
    }

    if (!inferenceDone && vnow >= inferDoneMs) {
      inferenceDone = true;
      if (DEBUG) console.log(`[wall ${(vnow / 1000).toFixed(2)}] INFERENCE DONE`);
      synthResolve(new Float32Array(fullSamples).fill(0.5));
    }

    runDueTimers();
    ctx.advance(DT_MS / 1000);
    runDueTimers();
    // 最小化期间 Chromium 不派发 rAF（且恢复后不保证补发）；音频线程照常出声。
    if (!document.hidden) runDueRaf();

    const playhead = state.getFragmentCurrentTime();
    const audibleCtxT = ctx.currentTime - OUTPUT_LATENCY;
    let contentPos = null;
    let activeVocal = 0;
    let mutedByGain = 0;
    for (const s of ctx.activeAt(audibleCtxT)) {
      // gain 自动化把声音压到 0 = 听不见（fade 卡死 / 包络错误必须能被测出来）
      if (s.gainAt(audibleCtxT) < 1e-4) { mutedByGain += 1; continue; }
      activeVocal += 1;
      if (s._meta.kind === 'chunk') {
        contentPos = s._meta.relStart + s._meta.trimmedSec + (audibleCtxT - s._when) + s._offset;
      } else {
        // 整段播放（缓存命中路径）：缓冲区 0 点 = 分片起点（绝对秒）
        contentPos = s._offset + (audibleCtxT - s._when) - firstNoteStartSec;
      }
    }
    samples.push({
      wall: vnow / 1000,
      ctxT: ctx.currentTime,
      playhead,
      contentPos,
      activeVocal,
      mutedByGain,
      playing: state.getFragmentIsPlaying(),
      ctxState: ctx.state,
      hidden: document.hidden,
    });

    await new Promise((r) => setImmediate(r));
    if (!state.getFragmentIsPlaying() && !state.getFragmentIsSynthesizing() && inferenceDone) break;
    vnow += DT_MS;
  }

  // 收尾前的真实状态：停止动作会解冻上下文 / 复位播放标志，
  // 之后再读就把"挂死"掩盖掉了（必须在 stop 之前取样）。
  const endState = {
    playing: state.getFragmentIsPlaying(),
    synthesizing: state.getFragmentIsSynthesizing(),
    ctxState: ctx.state,
    playhead: state.getFragmentCurrentTime(),
    inferenceDone,
    wall: vnow / 1000,
    frozenTail: (() => {
      const tail = samples.filter((s) => s.wall >= vnow / 1000 - 2);
      if (tail.length < 2) return false;
      const heads = tail.map((s) => s.playhead);
      return Math.max(...heads) - Math.min(...heads) < 0.005;
    })(),
  };

  playback.stopFragmentPlayback();
  // 合成 promise 可能一直没被 resolve（推理时间表比总时长还长）：直接放弃等待，
  // 否则顶层 await 挂住、进程在没有待处理句柄时静默退出。
  if (!inferenceDone) { try { synthResolve(new Float32Array(fullSamples)); } catch (_) {} }
  await Promise.race([playPromise.catch(() => {}), new Promise((r) => setImmediate(r))]);

  return analyze({ spec, ctx, samples, chunkEvents, state, firstNoteStartSec, actionLog, endState });
}

function analyze({ spec, ctx, samples, chunkEvents, state, firstNoteStartSec, actionLog, endState }) {
  const played = [];
  for (const s of ctx._sources) {
    if (!s._meta || s._when === null) continue;
    const fullDur = s.buffer ? s.buffer.duration - s._offset : 0;
    // 被 stop() 截断的 source：只算到停止那一刻
    const endCtx = s._stopped && Number.isFinite(s._stoppedAt)
      ? Math.min(s._when + fullDur, s._stoppedAt) : s._when + fullDur;
    const dur = Math.max(0, endCtx - s._when);
    if (dur <= 0) continue;
    const base = s._meta.kind === 'chunk'
      ? s._meta.relStart + (s._meta.trimmedSec || 0) + s._offset
      : s._offset - firstNoteStartSec;
    played.push({
      from: base,
      to: base + dur,
      when: s._when,
      end: s._when + dur,
      chunkIdx: s._meta.idx,
      kind: s._meta.kind,
      session: s._session,
      stopped: s._stopped,
    });
  }
  played.sort((a, b) => a.when - b.when);
  const maxActive = samples.reduce((m, s) => Math.max(m, s.activeVocal || 0), 0);

  // 被 stop 截断的 source 也算"播过"（区间已按 _stoppedAt 裁剪）
  const live = played;
  // 按会话分组：一个会话内必须连续；跨会话（重播）不算静音缝/重复
  const sessions = new Map();
  for (const p of live) {
    const key = p.session == null ? 0 : p.session;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(p);
  }
  const gaps = [];
  let playedSec = 0;
  for (const [, list] of sessions) {
    const cov = mergeIntervals(list.map((p) => [p.when, p.end]));
    playedSec += cov.reduce((a, [s, e]) => a + (e - s), 0);
    let cur = list.length ? Math.min(...list.map((p) => p.when)) : 0;
    for (const [s, e] of cov) {
      if (s > cur + 0.03) gaps.push([cur, s]);
      cur = Math.max(cur, e);
    }
  }

  let overlapSec = 0;
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (live[i].session !== live[j].session) continue;
      const o = Math.min(live[i].end, live[j].end) - Math.max(live[i].when, live[j].when);
      if (o > 0.02) overlapSec += o;
    }
  }

  let maxDrift = 0;
  let driftAt = null;
  // 最小化刚恢复的 ≤0.5s 内播放头还没被看门狗唤醒：这是有界的视觉延迟
  // （声音一直在放），不计入"声画错位"。
  const hiddenEndSec = spec.hidden ? spec.hidden.toSec : -1;
  for (const s of samples) {
    if (s.contentPos === null || !s.playing || s.hidden) continue;
    if (hiddenEndSec >= 0 && s.wall < hiddenEndSec + 0.5) continue;
    const head = s.playhead - firstNoteStartSec;
    const d = Math.abs(head - s.contentPos);
    if (d > maxDrift) { maxDrift = d; driftAt = { wall: s.wall, head: +head.toFixed(2), expect: +s.contentPos.toFixed(2) }; }
  }

  // 调度漂移：按 sampleOffset 该在 X 秒后发声，实际排在了 Y 秒后。
  // （分片编辑器按"到达顺序无缝拼接"，忽略 sampleOffset —— 一旦流水线发来重叠
  //   分块，这里就会积累出漂移，表现为越播越晚 / 重复。）
  let maxSchedDrift = 0;
  let schedDriftAt = null;
  for (const [, list] of sessions) {
    if (!list.length) continue;
    const base = list[0];
    for (const p of list) {
      const expectDelta = (p.from - base.from);
      const actualDelta = (p.when - base.when);
      const d = Math.abs(actualDelta - expectDelta);
      if (d > maxSchedDrift) {
        maxSchedDrift = d;
        schedDriftAt = { chunk: p.chunkIdx, expect: +expectDelta.toFixed(2), actual: +actualDelta.toFixed(2) };
      }
    }
  }
  // 内容重复：相邻 chunk 的内容区间重叠量（同一段音频被播两遍）
  let contentRepeatSec = 0;
  for (const [, list] of sessions) {
    const byIdx = list.filter((p) => p.kind === 'chunk').sort((a, b) => a.from - b.from);
    for (let i = 1; i < byIdx.length; i++) {
      const o = byIdx[i - 1].to - byIdx[i].from;
      if (o > 0.02) contentRepeatSec += o;
    }
  }
  const byIdx = live.slice().sort((a, b) => a.chunkIdx - b.chunkIdx);
  // 内容缺失：流水线交付的内容区间 减去 实际排程播出的内容区间
  const playFrom = spec.playFromSec || 0;
  const expected = mergeIntervals([
    ...chunkEvents.map((c) => [Math.max(c.relStart, playFrom), c.relStart + c.dur]),
    ...byIdx.filter((p) => p.kind === 'full').map((p) => [p.from, p.to]),
  ]);
  const covered = mergeIntervals(byIdx.map((p) => [Math.max(p.from, playFrom), p.to]));
  let contentLossSec = 0;
  const lossSpans = [];
  {
    let cur = expected.length ? expected[0][0] : 0;
    for (const [s, e] of covered) {
      if (s > cur + 0.03) { contentLossSec += s - cur; lossSpans.push([+cur.toFixed(2), +s.toFixed(2)]); }
      cur = Math.max(cur, e);
    }
    const tail = expected.length ? expected[expected.length - 1][1] : 0;
    if (tail > cur + 0.03) { contentLossSec += tail - cur; lossSpans.push([+cur.toFixed(2), +tail.toFixed(2), 'tail']); }
  }
  // 播放头回跳 / 卡住（卡住只统计 context 仍在跑的时间段：underrun 冻结是预期行为）
  let backJumps = 0;
  let maxBackJump = 0;
  let stalls = 0;
  let stallAt = null;
  const stallSamples = [];
  let prevHead = null;
  let lastMoveWall = null;
  let lastHead = null;
  for (const s of samples) {
    if (!s.playing || s.ctxState !== 'running' || s.hidden) { prevHead = null; lastMoveWall = null; lastHead = null; continue; }
    const head = s.playhead;
    if (prevHead !== null && head < prevHead - 0.05) {
      backJumps += 1;
      maxBackJump = Math.max(maxBackJump, prevHead - head);
    }
    if (lastHead === null || Math.abs(head - lastHead) > 0.005) {
      lastHead = head;
      lastMoveWall = s.wall;
    } else if (lastMoveWall !== null && s.wall - lastMoveWall > 0.35) {
      stalls += 1;
      if (stallSamples.length < 8) stallSamples.push({ wall: +s.wall.toFixed(2), head: +head.toFixed(2), hidden: s.hidden });
      if (!stallAt) stallAt = { wall: s.wall, head: +head.toFixed(2), forSec: +(s.wall - lastMoveWall).toFixed(2) };
      lastMoveWall = s.wall; // 不重复计
    }
    prevHead = head;
  }

  // 最小化恢复耗时：恢复后播放头多久重新开始动（看门狗 400ms 一轮）。
  let recoverSec = null;
  if (spec.hidden) {
    const t0 = spec.hidden.toSec;
    let head0 = null;
    for (const s of samples) {
      if (s.wall < t0 || !s.playing) continue;
      if (head0 === null) { head0 = s.playhead; continue; }
      if (Math.abs(s.playhead - head0) > 0.005) { recoverSec = s.wall - t0; break; }
    }
  }

  return {
    name: spec.name,
    chunks: chunkEvents.length,
    playedSec,
    gaps,
    gapSec: gaps.reduce((a, [s, e]) => a + (e - s), 0),
    overlapSec,
    maxDrift,
    driftAt,
    maxSchedDrift,
    schedDriftAt,
    contentRepeatSec,
    contentLossSec,
    maxActive,
    actionLog,
    allowLossSec: spec.allowLossSec || 0,
    // gain 自动化把正在排程的音频压成静音的累计时长（fade 卡死 / 包络错误）
    mutedSec: samples.filter((s) => s.mutedByGain > 0 && s.activeVocal === 0).length * (DT_MS / 1000),
    // 挂死：推理早已结束，墙钟跑完却仍停在"播放中"且播放头不再前进
    // （上下文被冻结无人解冻 / rAF 循环停摆）。这是"后面全程静音"的直接判据。
    hung: !!(endState && endState.inferenceDone && endState.playing && endState.frozenTail),
    endState,
    // 静音缝容差：极端控制延迟下，"负载变化的第一个接缝"会留下一段可预测的
    // bootstrap 残差（延迟 - 默认提前量）。之后的每个接缝都必须完全干净。
    allowGapSec: spec.allowGapSec != null ? spec.allowGapSec : 0.05,
    lossSpans,
    backJumps,
    maxBackJump,
    stalls,
    stallAt,
    stallSamples,
    recoverSec,
    suspends: ctx.suspendCalls,
    resumes: ctx.resumeCalls,
    finalPlaying: state.getFragmentIsPlaying(),
    finalSynthesizing: state.getFragmentIsSynthesizing(),
    finalCtxState: ctx.state,
    finalPlayhead: state.getFragmentCurrentTime(),
    audioSpan: live.length ? [live[0].when, live[live.length - 1].end] : null,
    detail: live.map((p) => `s${p.session}c${p.chunkIdx}[${p.from.toFixed(2)}..${p.to.toFixed(2)}]@${p.when.toFixed(2)}`),
  };
}

function mergeIntervals(iv) {
  if (!iv.length) return [];
  const sorted = iv.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1] + 1e-9) last[1] = Math.max(last[1], sorted[i][1]);
    else out.push(sorted[i].slice());
  }
  return out;
}

// ==================== 场景表 ====================
const SCENARIOS = [
  {
    name: 'A 单段 20s，推理 1.6x 实时（必然 underrun）',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 22, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 45,
    regions: [{ startSec: 0, endSec: 20, chunkSec: 4, inferSec: 6.4 }],
  },
  {
    name: 'B 首音符在 4s（前导静音），从 0 播放',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 4, fragmentDurationSec: 26, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 50,
    regions: [{ startSec: 4, endSec: 24, chunkSec: 4, inferSec: 6.4 }],
  },
  {
    name: 'C 从中段 10s 起播',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 24, playFromSec: 10,
    startupSec: 0.6, totalWallSec: 45,
    regions: [{ startSec: 0, endSec: 22, chunkSec: 4, inferSec: 6.4 }],
  },
  {
    name: 'D 推理快于实时（无 underrun）',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 24, playFromSec: 0,
    startupSec: 0.4, totalWallSec: 32,
    regions: [{ startSec: 0, endSec: 22, chunkSec: 4, inferSec: 1.2 }],
  },
  {
    name: 'E 多段 + 8s 长休止（发射器补静音 chunk）',
    mode: 'multi',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 34, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 70,
    regions: [
      { startSec: 0, endSec: 10, chunkSec: 4, inferSec: 6.4 },
      { startSec: 18, endSec: 30, chunkSec: 4, inferSec: 6.4 },
    ],
  },
  {
    name: 'F 单段真实分块：10s/1s 重叠，推理 1.6x',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 32, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 90,
    regions: [{ startSec: 0, endSec: 30, chunkSec: 10, overlapSec: 1, inferSec: 16 }],
  },
  {
    name: 'G 单段真实分块：10s/1s 重叠，推理 1.1x',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 32, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 70,
    regions: [{ startSec: 0, endSec: 30, chunkSec: 10, overlapSec: 1, inferSec: 11 }],
  },
  {
    name: 'K 长分片 60s/10s 块，推理 3x，异步控制消息',
    mode: 'single', controlDelayMs: 8,
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 62, playFromSec: 0,
    startupSec: 1.2, totalWallSec: 175,
    regions: [{ startSec: 0, endSec: 60, chunkSec: 10, overlapSec: 1, inferSec: 20 }],
  },
  {
    name: 'K-EXTREME 长分片60s,推理3x,控制延迟300ms(GPU争用)',
    mode: 'single', controlDelayMs: 300,
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 62, playFromSec: 0,
    startupSec: 1.2, totalWallSec: 175,
    regions: [{ startSec: 0, endSec: 60, chunkSec: 10, overlapSec: 1, inferSec: 20 }],
  },
  {
    name: 'K-EXT2 长分片60s,推理3x,控制延迟500ms(极端)',
    mode: 'single', controlDelayMs: 500,
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 62, playFromSec: 0,
    allowGapSec: 0.3,
    startupSec: 1.2, totalWallSec: 175,
    // 首个 underrun 之前无法预知控制延迟，提前量只能取默认下限：
    // 这一缝会多丢"延迟 - 0.3s"，之后每次冻结都被自适应提前量完全吸收。
    allowLossSec: 0.3,
    regions: [{ startSec: 0, endSec: 60, chunkSec: 10, overlapSec: 1, inferSec: 20 }],
  },
  {
    name: 'L 控制延迟500ms + 流式中停止 → 重播（延迟估计跨会话保留）',
    mode: 'single', controlDelayMs: 500, allowLossSec: 0.3, allowGapSec: 0.3,
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 26, playFromSec: 0,
    startupSec: 1.0, totalWallSec: 150,
    regions: [{ startSec: 0, endSec: 24, chunkSec: 5, overlapSec: 0.5, inferSec: 9 }],
    actions: [{ atSec: 30, type: 'stop' }, { atSec: 33, type: 'play' }],
  },
  {
    name: 'M 负载突增：控制延迟 8ms→500ms（开始训练/录屏）',
    mode: 'single',
    controlDelayTimeline: [{ atSec: 0, ms: 8 }, { atSec: 45, ms: 500 }],
    allowLossSec: 0.3, allowGapSec: 0.3,
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 26, playFromSec: 0,
    startupSec: 1.0, totalWallSec: 120,
    regions: [{ startSec: 0, endSec: 24, chunkSec: 5, overlapSec: 0.5, inferSec: 9 }],
  },
  {
    name: 'N 负载回落：控制延迟 500ms→8ms（训练结束，提前量应缓降）',
    mode: 'single',
    controlDelayTimeline: [{ atSec: 0, ms: 500 }, { atSec: 45, ms: 8 }],
    allowLossSec: 0.3, allowGapSec: 0.3,
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 26, playFromSec: 0,
    startupSec: 1.0, totalWallSec: 120,
    regions: [{ startSec: 0, endSec: 24, chunkSec: 5, overlapSec: 0.5, inferSec: 9 }],
  },
  {
    name: 'O 控制延迟 1200ms（病态排队，上限钳制不失控）',
    mode: 'single', controlDelayMs: 1200, allowLossSec: 1.0, allowGapSec: 1.0,
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 26, playFromSec: 0,
    startupSec: 1.0, totalWallSec: 150,
    regions: [{ startSec: 0, endSec: 24, chunkSec: 5, overlapSec: 0.5, inferSec: 9 }],
  },
  {
    name: 'H 流式中点停止 → 重播',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 22, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 60,
    regions: [{ startSec: 0, endSec: 20, chunkSec: 4, inferSec: 6.4 }],
    actions: [{ atSec: 12, type: 'stop' }, { atSec: 15, type: 'play' }],
  },
  {
    name: 'I 合成中拖动播放头到 8s',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 22, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 90, allowLossSec: 5,
    regions: [{ startSec: 0, endSec: 20, chunkSec: 4, inferSec: 6.4 }],
    actions: [{ atSec: 13, type: 'seek', pos: 8 }],
  },
  {
    name: 'J 播完后重播（缓存整段）',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 14, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 60,
    regions: [{ startSec: 0, endSec: 12, chunkSec: 6, inferSec: 4 }],
    actions: [{ atSec: 20, type: 'play' }],
  },
  {
    name: 'P 全局缓存命中：整段 2s 分块 burst 重放（不得再整段叠一遍）',
    mode: 'cache',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 30, playFromSec: 0,
    startupSec: 0.2, totalWallSec: 40,
    regions: [],
  },
  {
    name: 'Q 最小化 6s 后恢复：无 visibilitychange 事件，看门狗必须重启播放头',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 24, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 45,
    regions: [{ startSec: 0, endSec: 22, chunkSec: 4, inferSec: 1.2 }],
    hidden: { fromSec: 6, toSec: 12 },
  },
  {
    name: 'R 暂停后从中段 10s 再播：起播点之前的块丢弃且不锚定',
    mode: 'single',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 24, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 60,
    // 6s 处停止、把播放头点到 10s：4.15→10 是用户主动跳过的区间，不算内容丢失。
    allowLossSec: 6,
    regions: [{ startSec: 0, endSec: 22, chunkSec: 4, inferSec: 1.2 }],
    actions: [
      { atSec: 6, type: 'stop' },
      { atSec: 7, type: 'setpos', pos: 10 },
      { atSec: 7.5, type: 'play' },
    ],
  },
  {
    name: 'S 缓存命中 + 从中段 16s 起播（burst 里前 8 块应全部丢弃）',
    mode: 'cache',
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 30, playFromSec: 16,
    startupSec: 0.2, totalWallSec: 30,
    regions: [],
  },
  {
    // 真实竞态：AudioContext 冷启动（resume 120ms + setSinkId 80ms）期间，
    // invoke 回执先到达 → setInferenceDone() 被随后的 scheduler.activate() 抹掉。
    name: 'T 缓存 burst + 冷启动 AudioContext（回执先于首块处理）',
    mode: 'cache', coldStartMs: 120, sinkIdMs: 80,
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 30, playFromSec: 0,
    startupSec: 0.2, totalWallSec: 45,
    regions: [],
  },
  {
    name: 'U 多段推理 + 冷启动 AudioContext',
    mode: 'multi', coldStartMs: 150, sinkIdMs: 60,
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 34, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 70,
    regions: [
      { startSec: 0, endSec: 10, chunkSec: 4, inferSec: 6.4 },
      { startSec: 18, endSec: 30, chunkSec: 4, inferSec: 6.4 },
    ],
  },
  {
    name: 'V 缓存 burst + 冷启动 + 中段 16s 起播',
    mode: 'cache', coldStartMs: 120, sinkIdMs: 80,
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 30, playFromSec: 16,
    startupSec: 0.2, totalWallSec: 30,
    regions: [],
  },
  {
    // per-note fade：gain 自动化必须与 chunk 排程同一条时间轴，
    // 且 fadeOut 之后要恢复 1（否则后续音符全程静音）。
    name: 'W 每音符淡入淡出 + 推理 1.6x（gain 自动化不得卡死）',
    mode: 'single', noteFade: { fadeIn: 120, fadeOut: 150 },
    bpm: 120, firstNoteStartSec: 0, fragmentDurationSec: 22, playFromSec: 0,
    startupSec: 0.6, totalWallSec: 45,
    regions: [{ startSec: 0, endSec: 20, chunkSec: 4, inferSec: 6.4 }],
  },
];

(async () => {
  const filter = process.argv[2];
  const list = filter ? SCENARIOS.filter((s) => s.name.includes(filter)) : SCENARIOS;
  const results = [];
  for (const spec of list) {
    vnow = 0; timers.clear(); rafQueue.clear(); nextRafDue = 0;
    results.push(await runScenario(spec));
    await new Promise((res) => setImmediate(res));
  }

  const w = [40, 6, 8, 5, 7, 6, 7, 7, 9, 7, 6, 6, 8];
  const pad = (s, n) => {
    // 中文按 2 列宽计算，超长截断，保证表格不右移
    const str = String(s);
    let width = 0;
    for (const ch of str) width += /[一-鿿]/.test(ch) ? 2 : 1;
    if (width > n) {
      let out = '';
      let acc = 0;
      for (const ch of str) {
        const cw = /[一-鿿]/.test(ch) ? 2 : 1;
        if (acc + cw > n - 1) break;
        out += ch; acc += cw;
      }
      return out + '…';
    }
    return str + ' '.repeat(n - width);
  };
  console.log('\n' + pad('scenario', w[0]) + pad('chunks', w[1]) + pad('played', w[2]) + pad('gaps', w[3])
    + pad('gap(s)', w[4]) + pad('loss', w[5]) + pad('repeat', w[6]) + pad('sDrift', w[7])
    + pad('backJmp', w[8]) + pad('stalls', w[9]) + pad('maxAct', w[10]) + pad('final', w[11]) + pad('ctx', w[12]));
  console.log('-'.repeat(w.reduce((a, b) => a + b, 0)));
  for (const r of results) {
    console.log(pad(r.name, w[0]) + pad(r.chunks, w[1]) + pad(r.playedSec.toFixed(2), w[2]) + pad(r.gaps.length, w[3])
      + pad(r.gapSec.toFixed(2), w[4]) + pad(r.contentLossSec.toFixed(2), w[5]) + pad(r.contentRepeatSec.toFixed(2), w[6])
      + pad(r.maxSchedDrift.toFixed(2), w[7]) + pad(r.backJumps, w[8]) + pad(r.stalls, w[9])
      + pad(r.maxActive, w[10]) + pad(String(r.finalPlaying), w[11]) + pad(r.finalCtxState, w[12]));
  }
  console.log('\n每个 chunk 的调度时刻 @ 内容起点（ctx 秒 / 秒）：');
  for (const r of results) console.log(`  ${r.name}\n    ${r.detail.join('  ') || '(无声)'}`);
  for (const r of results) {
    if (r.actionLog && r.actionLog.length) console.log(`  动作 ${r.name}: ` + r.actionLog.map((a) => `${a.type}@${a.atSec}s(播放头${a.playhead.toFixed(2)})`).join(' '));
    if (r.maxSchedDrift > 0.02 && r.schedDriftAt) console.log(`  调度漂移 ${r.name}: c${r.schedDriftAt.chunk} 应为 +${r.schedDriftAt.expect}s，实际 +${r.schedDriftAt.actual}s`);
    if (r.maxDrift > 0.08 && r.driftAt) console.log(`  声画错位 ${r.name}: wall=${r.driftAt.wall}s 播放头=${r.driftAt.head} 声音=${r.driftAt.expect}`);
    if (r.stallAt) console.log(`  播放头卡住 ${r.name}: wall=${r.stallAt.wall}s 停在 ${r.stallAt.head}s 达 ${r.stallAt.forSec}s`);
    if (r.stalls > 0 && process.env.SIM_DEBUG) console.log(`  stall samples ${r.name}: ${JSON.stringify(r.stallSamples)}`);
    if (r.recoverSec !== null && r.recoverSec !== undefined) console.log(`  最小化恢复 ${r.name}: 播放头 ${r.recoverSec.toFixed(2)}s 后重新开始动`);
    if (r.lossSpans.length) console.log(`  内容缺失 ${r.name}: ${JSON.stringify(r.lossSpans)}`);
  }
  const bad = results.filter((r) => r.gapSec > r.allowGapSec || r.overlapSec > 0.05 || r.contentRepeatSec > 0.05
    || r.contentLossSec > (r.allowLossSec + 0.05) || r.maxSchedDrift > 0.05 || r.maxDrift > 0.08 || r.backJumps > 0
    || r.stalls > 0 || r.maxActive > 1 || r.hung || r.mutedSec > 0.05
    || (r.recoverSec !== null && r.recoverSec !== undefined && r.recoverSec > 0.8));
  if (bad.length) console.log('\nFAIL：' + bad.map((b) => `${b.name}${b.hung ? '[挂死]' : ''}${b.mutedSec > 0.05 ? `[gain静音${b.mutedSec.toFixed(2)}s]` : ''}`).join('; '));
  else console.log('\nOK：无静音缝 / 无重复 / 无漂移 / 播放头连续');
})().catch((e) => { console.error(e); process.exit(1); });
