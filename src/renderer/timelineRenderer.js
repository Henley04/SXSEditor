import { state, dom, trackManager, history } from './state.js';
import { setAccompanimentVolume } from './accompanimentMixer.js';
import {
  FRAGMENT_HEIGHT,
  SINGER_ROW_HEIGHT,
  HEADER_HEIGHT,
  FRAGMENT_BASE_BEAT_WIDTH,
} from './constants.js';
import { t } from '../i18n/index.js';
// U3: 分片时间轴是 canvas，DOM 里没有可读节点 —— 渲染时把摘要写进 aria-live 容器。
import { announce } from '../utils/a11yAnnounce.js';
import { getCanvasColors, invalidateCanvasThemeCache } from '../themes/canvasTheme.js';
import { computeLuminanceCached } from '../themes/colorUtils.js';
import { showConfirmDialog } from '../alertDialog.js';
import { loadSingerFile, showSingerSelectDialog, markDirty, loadAccompanimentFile } from './projectManager.js';
import { createIcon } from '../icons/iconHelper.js';
import { describeTrackBackend, ensurePluginCatalog, hasPluginCatalog } from './pluginBackend.js';
import { isPluginTrack } from '../editor/trackManager.js';
import { beatsPerMeasureOf, isMeasureBoundary, measureNumberAt } from '../shared/timeSignature.js';

export function getBeatWidth() {
  return FRAGMENT_BASE_BEAT_WIDTH * state.fragmentZoomX;
}

/**
 * Format duration in seconds to mm:ss.s format for accompaniment display.
 */
function formatAccompanimentDuration(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// 网格层离屏缓存：网格只依赖 zoom / 滚动位置 / 主题配色 / 视口尺寸 /
// 拍号与 DPR，逐帧重绘纯属浪费。缓存一张视口大小的离屏 canvas，
// 任一依赖变化即重建（键里全部覆盖；theme:changed 亦会显式置空）。
let _gridCache = null;

export function invalidateGridCache() {
  _gridCache = null;
}

function _gridLayerKey(beatWidth, totalBeats, viewportWidth, viewportHeight, dpr, beatsPerMeasure, colors) {
  return [
    beatWidth, totalBeats, viewportWidth, viewportHeight, dpr, beatsPerMeasure,
    state.fragmentScrollX, state.fragmentScrollY,
    colors.bgApp, colors.gridLineMeasure, colors.gridLineMajor, colors.timeText,
  ].join('|');
}

function _buildGridLayer(key, view) {
  // 复用同一张离屏 canvas（滚动导致键变化时只重绘，不重新分配）。
  const canvas = _gridCache?.canvas || document.createElement('canvas');
  const pixelW = Math.max(1, Math.round(view.viewportWidth * view.dpr));
  const pixelH = Math.max(1, Math.round(view.viewportHeight * view.dpr));
  if (canvas.width !== pixelW) canvas.width = pixelW;
  if (canvas.height !== pixelH) canvas.height = pixelH;
  const g = canvas.getContext('2d');
  if (!g) return { canvas, key };
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, pixelW, pixelH);
  g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  g.translate(-view.viewLeft, -view.viewTop);

  g.fillStyle = view.colors.bgApp;
  g.fillRect(view.viewLeft, view.viewTop, view.viewportWidth, view.viewportHeight);
  g.lineWidth = 1;
  const firstBeat = Math.max(0, Math.floor(view.viewLeft / view.beatWidth));
  const lastBeat = Math.min(view.totalBeats, Math.ceil(view.viewRight / view.beatWidth));
  for (let i = firstBeat; i <= lastBeat; i++) {
    const x = i * view.beatWidth;
    const isMeasureLine = isMeasureBoundary(i, view.beatsPerMeasure);
    g.strokeStyle = isMeasureLine ? view.colors.gridLineMeasure : view.colors.gridLineMajor;
    g.beginPath();
    g.moveTo(x, view.viewTop);
    g.lineTo(x, view.viewBottom);
    g.stroke();
    if (isMeasureLine && HEADER_HEIGHT >= view.viewTop) {
      const measureNum = measureNumberAt(i, view.beatsPerMeasure);
      g.fillStyle = view.colors.timeText;
      g.font = '10px sans-serif';
      g.fillText(String(measureNum), x + 2, HEADER_HEIGHT - 4);
    }
  }
  return { canvas, key };
}

// ---------------------------------------------------------------------------
// 渲染期复用缓存
// ---------------------------------------------------------------------------

// 分片底色 -> 音符条配色。computeLuminance 内部要做正则 + parseInt，
// 每帧对每个分片重算会白白吃掉 CPU；颜色种类有限，缓存即可。
const _noteFillCache = new Map();
function _getNoteFillFor(color) {
  let fill = _noteFillCache.get(color);
  if (fill === undefined) {
    fill = computeLuminanceCached(color) < 0.55
      ? 'rgba(255, 255, 255, 0.5)'
      : 'rgba(15, 15, 28, 0.45)';
    if (_noteFillCache.size > 512) _noteFillCache.clear();
    _noteFillCache.set(color, fill);
  }
  return fill;
}

// 分片音符数组的音高范围缓存。key 为 notes 数组本身（WeakMap 不阻止 GC），
// value 记录 length 以便音符增删后自动失效。
const _pitchRangeCache = new WeakMap();
const EMPTY_FRAGMENTS = [];
function _getFragmentPitchRange(notes, fragDuration) {
  const hit = _pitchRangeCache.get(notes);
  if (hit && hit.len === notes.length && hit.dur === fragDuration) return hit;
  let minPitch = 127;
  let maxPitch = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.start >= fragDuration) continue;
    if (n.pitch < minPitch) minPitch = n.pitch;
    if (n.pitch > maxPitch) maxPitch = n.pitch;
  }
  if (minPitch > maxPitch) { minPitch = 60; maxPitch = 72; }
  const res = { minPitch, maxPitch, len: notes.length, dur: fragDuration };
  _pitchRangeCache.set(notes, res);
  return res;
}

// ---------------------------------------------------------------------------
// 伴奏波形峰值缓存（金字塔）
// ---------------------------------------------------------------------------
// 之前绘制伴奏波形时对每个像素遍历其覆盖的全部 PCM 样本求峰值：一首 4 分钟
// 48kHz 音频约 1150 万样本，拖动/滚动/缩放每帧全量重算，是最大的渲染热点。
// 这里在首次绘制时按 WAVEFORM_BUCKET_SIZE 样本一桶预计算峰值，之后缩放级别
// 较低（每像素覆盖 ≥ 一桶）时直接取桶；放大到每像素样本数少于桶大小时按像素
// 直接扫描（本就便宜）。WeakMap 以 singer 对象为 key，轨道删除即随之回收；
// audioBuffer 引用变化（重新加载音频）时自动失效重建。
const WAVEFORM_BUCKET_SIZE = 512;
const _waveformPeakCache = new WeakMap();

function _getWaveformPeaks(singer) {
  const buf = singer.audioBuffer;
  if (!buf || buf.length === 0) return null;
  let entry = _waveformPeakCache.get(singer);
  if (entry && entry.buf === buf) return entry;
  const bucketCount = Math.ceil(buf.length / WAVEFORM_BUCKET_SIZE);
  const peaks = new Float32Array(bucketCount);
  for (let b = 0; b < bucketCount; b++) {
    const start = b * WAVEFORM_BUCKET_SIZE;
    const end = Math.min(start + WAVEFORM_BUCKET_SIZE, buf.length);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = buf[i] < 0 ? -buf[i] : buf[i];
      if (v > peak) peak = v;
    }
    peaks[b] = peak;
  }
  entry = { buf, bucketSize: WAVEFORM_BUCKET_SIZE, peaks };
  _waveformPeakCache.set(singer, entry);
  return entry;
}

/** 取 [sampleStart, sampleEnd) 范围峰值：整桶查表，首尾残桶直接扫描。 */
function _peakInRange(entry, buf, sampleStart, sampleEnd) {
  const { peaks, bucketSize } = entry;
  let peak = 0;
  const scan = (from, to) => {
    for (let i = from; i < to; i++) {
      const v = buf[i] < 0 ? -buf[i] : buf[i];
      if (v > peak) peak = v;
    }
  };
  if (sampleEnd <= sampleStart) return 0;
  const firstBucket = Math.floor(sampleStart / bucketSize);
  const lastBucket = Math.floor((sampleEnd - 1) / bucketSize);
  if (firstBucket === lastBucket) {
    scan(sampleStart, sampleEnd);
    return peak;
  }
  scan(sampleStart, (firstBucket + 1) * bucketSize);
  for (let b = firstBucket + 1; b < lastBucket; b++) {
    if (peaks[b] > peak) peak = peaks[b];
  }
  scan(lastBucket * bucketSize, sampleEnd);
  return peak;
}

/** 每帧构建一次 singerId -> fragments 索引，替代 singers.forEach 内的 O(N) filter。 */
function _groupFragmentsBySinger(fragments) {
  const map = new Map();
  for (let i = 0; i < fragments.length; i++) {
    const f = fragments[i];
    let arr = map.get(f.singerId);
    if (!arr) { arr = []; map.set(f.singerId, arr); }
    arr.push(f);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 分片音符预览精灵缓存
// 拖动分片时每帧都会重绘整条时间轴，而每个分片的音符条可能成百上千 ——
// 直接逐条 fillRect 是拖动掉帧的主因。音符在「拖动/滚动」期间内容不变，
// 只是整体平移，因此可以预渲染成离屏精灵，之后每帧只做一次 drawImage。
// ---------------------------------------------------------------------------
const NOTE_SPRITE_MIN_NOTES = 24;
const NOTE_SPRITE_MAX_ENTRIES = 96;
// 精灵位图分辨率必须与「当前缩放后的屏宽」解耦：
//   旧实现把缓存键写成精确的 cssW（= fragWidth），Ctrl+滚轮每缩放一点，屏宽就
//   变一点 → 每个可见分片每帧都 cache miss，于是每帧都新建一张离屏 canvas 并把
//   分片里所有音符重画一遍。缩放 60 帧 = 60×N 次位图分配（数 MB/帧），帧时间
//   直接飙到几十毫秒，表现为"缩放不跟手"，而滚动时屏宽不变所以完全正常。
//   现在改为：位图按「当前屏宽 × 2」建一次，之后只要分辨率够用就直接
//   drawImage 缩放复用（缩小属降采样、轻微放大属插值，观感无损）。
//   连续放大时屏宽必须翻倍才会触发下一次重建：0.25×→4× 全程每个分片只重建 4 次，
//   其余帧零分配；缩小方向永不重建。
const NOTE_SPRITE_MAX_CSS_W = 3072; // 位图上限：64 拍分片在 4× 缩放下屏宽上万 px，
                                    // 不设上限会瞬间分配出十几 MB 的位图
const NOTE_SPRITE_MIN_CSS_W = 24;   // 极小分片（<24px）没必要为它建位图
const NOTE_SPRITE_GROWTH = 2;       // 建图时超采样倍数 = 下一次重建前的放大余量
// 缓存总字节预算：条目数不是好的内存度量（一张 3072px 宽的位图在 dpr=2 下约
// 1.4MB）。超预算整表清空（与旧的条目数上限同一策略），避免长工程缩放浏览时
// 驻留位图无限增长。
const NOTE_SPRITE_MAX_BYTES = 48 * 1024 * 1024;
let _noteSpriteCache = new Map();
let _noteSpriteCacheBytes = 0;

/** 当前屏宽下精灵至少需要的 CSS 宽度（夹到 [MIN, MAX]，MAX 之上不再重建）。 */
function _spriteNeedWidth(fragWidth) {
  return Math.min(NOTE_SPRITE_MAX_CSS_W, Math.max(NOTE_SPRITE_MIN_CSS_W, fragWidth));
}

/** 分片音符内容或主题变化后调用，强制重建精灵。 */
export function invalidateFragmentNoteSprites() {
  _noteSpriteCache.clear();
  _noteSpriteCacheBytes = 0;
}

/** 单张精灵位图的近似字节数（RGBA 4 字节/像素）。 */
function _spriteBytes(cssW, dpr) {
  return Math.max(1, Math.floor(cssW * dpr)) * Math.max(1, Math.floor(FRAGMENT_HEIGHT * dpr)) * 4;
}

function _buildNoteSprite(fragment, cssW, fragDuration, dpr) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.floor(cssW * dpr));
  cv.height = Math.max(1, Math.floor(FRAGMENT_HEIGHT * dpr));
  const c2 = cv.getContext('2d');
  if (!c2) return null;
  c2.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 不在这里做圆角裁剪：位图分辨率与屏幕显示宽度不再相等（见 _spriteNeedWidth），
  // 位图内的圆角半径在缩放后会被拉伸成椭圆/超大圆角。改为绘制时用分片自身的
  // roundRect 裁剪（半径恒为 6px），位图只负责音符条本身。
  const notes = fragment.notes;
  const midiAreaTop = 22;
  const midiAreaHeight = FRAGMENT_HEIGHT - 26;
  const { minPitch, maxPitch } = _getFragmentPitchRange(notes, fragDuration);
  const pitchRange = Math.max(maxPitch - minPitch + 1, 6);
  const noteFill = _getNoteFillFor(fragment.color);
  const noteH = Math.max(2, midiAreaHeight / pitchRange);
  c2.fillStyle = noteFill;
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (note.start >= fragDuration) continue;
    const noteEnd = Math.min(note.start + note.duration, fragDuration);
    const noteX = (note.start / fragDuration) * cssW;
    const noteW = Math.max(1, ((noteEnd - note.start) / fragDuration) * cssW);
    if (noteX + noteW < 0 || noteX > cssW) continue;
    const noteY = midiAreaTop + ((maxPitch - note.pitch) / pitchRange) * midiAreaHeight;
    c2.fillRect(noteX, noteY, noteW, noteH);
  }
  return cv;
}

function _getNoteSprite(fragment, fragWidth, fragDuration, dpr) {
  const notes = fragment.notes;
  if (!notes || notes.length < NOTE_SPRITE_MIN_NOTES) return null;
  const needW = _spriteNeedWidth(fragWidth);
  const hit = _noteSpriteCache.get(fragment.id);
  // 命中条件：内容未变，且位图分辨率 ≥ 当前需求。
  // 位图比需求大是好事（缩小/轻微放大都直接插值复用），不要为此重建 ——
  // 旧实现要求精确相等，导致缩放时每帧重建全部精灵。
  if (hit && hit.w >= needW && hit.color === fragment.color
      && hit.len === notes.length && hit.dur === fragDuration && hit.dpr === dpr) {
    return hit.canvas;
  }
  // 重建分辨率取「当前需求 × 超采样」与「旧位图分辨率」的较大者：
  // 内容变化（改色/加音符）触发重建时不要顺手把分辨率降下来，否则随后放大又要重建一次。
  const buildW = Math.min(
    NOTE_SPRITE_MAX_CSS_W,
    Math.max(needW * NOTE_SPRITE_GROWTH, hit ? hit.w : 0),
  );
  const cv = _buildNoteSprite(fragment, buildW, fragDuration, dpr);
  if (!cv) return null;
  // 记账：替换旧条目时先扣掉它的占用
  if (hit) _noteSpriteCacheBytes -= _spriteBytes(hit.w, hit.dpr);
  const bytes = _spriteBytes(buildW, dpr);
  if (_noteSpriteCache.size >= NOTE_SPRITE_MAX_ENTRIES
      || _noteSpriteCacheBytes + bytes > NOTE_SPRITE_MAX_BYTES) {
    _noteSpriteCache.clear();
    _noteSpriteCacheBytes = 0;
  }
  _noteSpriteCache.set(fragment.id, {
    canvas: cv, w: buildW, color: fragment.color,
    len: notes.length, dur: fragDuration, dpr,
  });
  _noteSpriteCacheBytes += bytes;
  return cv;
}

function _ensureCanvasSize(canvas, cssW, cssH, dpr) {
  const pixelW = Math.floor(cssW * dpr);
  const pixelH = Math.floor(cssH * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  const expectedStyleW = cssW + 'px';
  const expectedStyleH = cssH + 'px';
  if (canvas.style.width !== expectedStyleW || canvas.style.height !== expectedStyleH) {
    canvas.style.width = expectedStyleW;
    canvas.style.height = expectedStyleH;
  }
}

// 截断结果缓存：key 为 字体 + maxWidth + 文本。每个可见分片每帧调用 2 次
// drawClippedText，文本超宽时二分查找要 ~log₂n 次 measureText；分片多且标签
// 长时拖动会累积。截断结果只取决于 (文本, 字体, maxWidth)，缓存即可。
const _textClipCache = new Map();

function _getClippedDisplay(ctx, text, maxWidth) {
  let display = text == null ? '' : String(text);
  if (ctx.measureText(display).width <= maxWidth) return display;
  const key = `${ctx.font}\u0000${maxWidth}\u0000${display}`;
  let cached = _textClipCache.get(key);
  if (cached === undefined) {
    const ellipsis = '…';
    let lo = 0, hi = display.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(display.slice(0, mid) + ellipsis).width <= maxWidth) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    cached = display.slice(0, lo) + ellipsis;
    if (_textClipCache.size > 512) _textClipCache.clear();
    _textClipCache.set(key, cached);
  }
  return cached;
}

/**
 * Draw text clipped to a rounded rectangle with horizontal ellipsis.
 * If the text is wider than maxWidth, it is truncated and ends with "…".
 * `x`, `y` is the text baseline; the clipping rect is (cx, cy, cw, ch).
 */
function drawClippedText(ctx, text, x, y, maxWidth, clipRect) {
  const { x: cx, y: cy, w: cw, h: ch } = clipRect;
  ctx.save();
  if (clipRect) {
    ctx.beginPath();
    ctx.rect(cx, cy, cw, ch);
    ctx.clip();
  }
  ctx.fillText(_getClippedDisplay(ctx, text, maxWidth), x, y);
  ctx.restore();
}

// 时间轴尺寸的唯一计算入口：syncFragmentScroll 与 renderFragmentTimeline
// 都需要 totalBeats / 虚拟宽度 / 内容高度，抽一次避免两处重复遍历与漂移。
function _computeTimelineMetrics(singers, fragments, beatWidth) {
  const fragmentMaxBeat = fragments.reduce((max, f) => Math.max(max, f.startTime + f.duration), 0);
  const accompanimentMaxBeat = singers.reduce((max, singer) => {
    if (singer.type !== 'accompaniment' || !singer.audioDuration) return max;
    const endBeat = (singer.accompanimentStartTime || 0)
      + singer.audioDuration / 60 * state.project.bpm;
    return Math.max(max, endBeat);
  }, 0);
  const maxBeat = Math.max(fragmentMaxBeat, accompanimentMaxBeat);
  const totalBeats = Math.max(64, Math.ceil((maxBeat + 256) / 64) * 64);
  return {
    beatWidth,
    totalBeats,
    canvasWidth: totalBeats * beatWidth,
    contentHeight: singers.length * SINGER_ROW_HEIGHT + HEADER_HEIGHT,
  };
}

let _lastCanvasTransform = '';

export function syncFragmentScroll(metrics) {
  let m = metrics;
  if (!m) {
    const singers = trackManager.getSingers();
    const fragments = trackManager.getFragments();
    m = _computeTimelineMetrics(singers, fragments, getBeatWidth());
  }
  const containerW = m.viewportWidth ?? dom.fragmentContainer.clientWidth;
  const containerH = m.viewportHeight ?? dom.fragmentContainer.clientHeight;

  state.fragmentScrollX = Math.max(0, Math.min(state.fragmentScrollX, m.canvasWidth - containerW));
  state.fragmentScrollY = Math.max(0, Math.min(state.fragmentScrollY, m.contentHeight - containerH));

  // fragment canvas 应用 translate 变换以实现滚动；
  // playhead canvas 不再应用 translate，改为固定覆盖可视区域，
  // 绘制时由 drawPlayheadLine 自行减去 scrollX（避免大 canvas clearRect 卡顿）。
  // Canvas is viewport-sized. Scrolling is applied to the drawing transform,
  // never by moving or enlarging the backing store.
  // 仅在值变化时写 style，避免每帧触发无意义的样式失效。
  if (_lastCanvasTransform !== 'none') {
    dom.fragmentCanvas.style.transform = 'none';
    _lastCanvasTransform = 'none';
  }
  dom.singerListEl.scrollTop = state.fragmentScrollY;
}

export function renderFragmentTimeline() {
  const ctx = dom.fragmentCanvas.getContext('2d');
  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const dpr = window.devicePixelRatio || 1;

  // U3：读屏播报（内容相同/过频时 announce 内部自动跳过）
  announce('fragment-canvas-a11y-status', t('main.a11yFragmentTimelineStatus', {
    fragments: fragments.length,
    singers: singers.length,
  }));

  const beatWidth = getBeatWidth();
  const metrics = _computeTimelineMetrics(singers, fragments, beatWidth);
  const totalBeats = metrics.totalBeats;
  const virtualWidth = metrics.canvasWidth;
  const contentHeight = metrics.contentHeight;
  const viewportWidth = Math.max(1, dom.fragmentContainer.clientWidth || 1);
  const viewportHeight = Math.max(1, dom.fragmentContainer.clientHeight || contentHeight || 1);

  // Keep the backing stores bounded by the viewport. Long MIDI projects only
  // increase virtualWidth, not canvas.width, avoiding Chromium's canvas limit.
  _ensureCanvasSize(dom.fragmentCanvas, viewportWidth, viewportHeight, dpr);
  _ensureCanvasSize(dom.fragmentPlayheadCanvas, viewportWidth, viewportHeight, dpr);

  state.fragmentScrollX = Math.max(0, Math.min(state.fragmentScrollX, virtualWidth - viewportWidth));
  state.fragmentScrollY = Math.max(0, Math.min(state.fragmentScrollY, contentHeight - viewportHeight));
  syncFragmentScroll({ ...metrics, viewportWidth, viewportHeight });

  // Clear in device-independent viewport coordinates, then translate the
  // world timeline into the viewport. Existing fragment drawing remains in
  // world coordinates and is clipped by the viewport backing store.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewportWidth, viewportHeight);
  ctx.translate(-state.fragmentScrollX, -state.fragmentScrollY);

  const c = getCanvasColors();
  const beatsPerMeasure = beatsPerMeasureOf(state.project.timeSignature);
  const _viewLeft = state.fragmentScrollX;
  const _viewRight = state.fragmentScrollX + viewportWidth;
  const _viewTop = state.fragmentScrollY;
  const _viewBottom = state.fragmentScrollY + viewportHeight;

  // 网格层走离屏缓存（键见 _gridLayerKey）：命中时只 blit 一次，
  // 不再逐帧重画所有可见分割线。
  const gridKey = _gridLayerKey(beatWidth, totalBeats, viewportWidth, viewportHeight, dpr, beatsPerMeasure, c);
  if (!_gridCache || _gridCache.key !== gridKey) {
    _gridCache = _buildGridLayer(gridKey, {
      colors: c,
      beatWidth,
      totalBeats,
      beatsPerMeasure,
      viewportWidth,
      viewportHeight,
      dpr,
      viewLeft: _viewLeft,
      viewRight: _viewRight,
      viewTop: _viewTop,
      viewBottom: _viewBottom,
    });
  }
  ctx.drawImage(_gridCache.canvas, _viewLeft, _viewTop, viewportWidth, viewportHeight);

  singers.forEach((singer, index) => {
    const y = index * SINGER_ROW_HEIGHT + HEADER_HEIGHT;
    if (y + SINGER_ROW_HEIGHT < _viewTop || y > _viewBottom) return;
    ctx.fillStyle = c.bgElevated;
    ctx.fillRect(_viewLeft, y, viewportWidth, SINGER_ROW_HEIGHT - 2);
    ctx.strokeStyle = c.borderSubtle;
    ctx.beginPath();
    ctx.moveTo(_viewLeft, y + SINGER_ROW_HEIGHT - 2);
    ctx.lineTo(_viewRight, y + SINGER_ROW_HEIGHT - 2);
    ctx.stroke();
  });

  // Draw dynamic content (fragments) on top of cached grid
  // Visible bounds were computed above; skip offscreen dynamic content.
  // 每帧只做一次分组，避免 singers × fragments 的重复 filter（歌手轨道渲染热点）。
  const fragmentsBySinger = _groupFragmentsBySinger(fragments);
  singers.forEach((singer, index) => {
    const y = index * SINGER_ROW_HEIGHT + HEADER_HEIGHT;
    // 跳过整行不在可视区域的 singer
    if (y + SINGER_ROW_HEIGHT < _viewTop || y > _viewBottom) return;

    const isAccompaniment = singer.type === 'accompaniment';
    const singerFragments = fragmentsBySinger.get(singer.id) || EMPTY_FRAGMENTS;

    // For accompaniment tracks, render the audio as a continuous waveform block
    if (isAccompaniment) {
      const accStartBeat = singer.accompanimentStartTime || 0;
      const accDuration = singer.audioDuration || 0;
      const accDurationBeats = (accDuration / 60) * state.project.bpm;
      const accX = accStartBeat * beatWidth;
      const accWidth = Math.max(2, accDurationBeats * beatWidth);

      // Skip if not visible
      if (accX + accWidth < _viewLeft || accX > _viewRight) {
        // Still show empty state if no audio
      } else {
        const fragY = y + 4;
        const radius = 6;

        // Rounded rect fill with accompaniment color
        ctx.fillStyle = (singer.color || c.accent) + '99';
        ctx.beginPath();
        ctx.roundRect(accX, fragY, accWidth, FRAGMENT_HEIGHT, radius);
        ctx.fill();

        // Rounded rect stroke
        ctx.strokeStyle = singer.color || c.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(accX, fragY, accWidth, FRAGMENT_HEIGHT, radius);
        ctx.stroke();

        // Draw waveform-like pattern if audioBuffer is available
        if (singer.audioBuffer && singer.audioBuffer.length > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(accX, fragY, accWidth, FRAGMENT_HEIGHT, radius);
          ctx.clip();

          const buf = singer.audioBuffer;
          const samplesPerPixel = Math.max(1, Math.floor(buf.length / accWidth));
          const midY = fragY + FRAGMENT_HEIGHT / 2;
          const maxAmp = FRAGMENT_HEIGHT / 2 - 4;

          // 放大状态下每像素只覆盖少量样本，直接扫描即可；缩小状态下使用
          // 预计算的桶峰值，避免每帧全量遍历 PCM。
          const useBuckets = samplesPerPixel > WAVEFORM_BUCKET_SIZE;
          const peakEntry = useBuckets ? _getWaveformPeaks(singer) : null;

          ctx.strokeStyle = c.fragmentText || '#fff';
          ctx.lineWidth = 1;
          // 只绘制视口内的像素列。等价性：每列是一条独立的竖线段
          // (moveTo+lineTo)，横向无连续性，裁剪不会产生接缝；画布 backing store
          // 恰为视口大小且已 clip 到 roundRect，[ _viewLeft, _viewRight ] 之外的列
          // 本来就会被裁掉；samplesPerPixel 只依赖 buf.length/accWidth，不随循环
          // 范围变化，故每一列的 sampleStart/sampleEnd 与旧代码完全相同。
          // 左右各外扩 1px 是防御性的，覆盖 lineWidth=1 的半像素边与 dpr 缩放。
          const pxStart = Math.max(0, Math.floor(_viewLeft - accX) - 1);
          const pxEnd = Math.min(accWidth - 1, Math.ceil(_viewRight - accX) + 1);
          ctx.beginPath();
          for (let px = pxStart; px <= pxEnd; px++) {
            const sampleStart = Math.floor(px * samplesPerPixel);
            const sampleEnd = Math.min(sampleStart + samplesPerPixel, buf.length);
            let peak;
            if (peakEntry) {
              peak = _peakInRange(peakEntry, buf, sampleStart, sampleEnd);
            } else {
              peak = 0;
              for (let s = sampleStart; s < sampleEnd; s++) {
                const v = Math.abs(buf[s]);
                if (v > peak) peak = v;
              }
            }
            const barH = peak * maxAmp;
            ctx.moveTo(accX + px, midY - barH);
            ctx.lineTo(accX + px, midY + barH);
          }
          ctx.stroke();
          ctx.restore();
        }

        // Label
        const labelInsetX = 6;
        const labelClipRect = { x: accX, y: fragY, w: accWidth, h: FRAGMENT_HEIGHT };
        const labelMaxWidth = Math.max(0, accWidth - labelInsetX * 2);

        ctx.fillStyle = c.fragmentText;
        ctx.font = '11px sans-serif';
        drawClippedText(
          ctx,
          singer.audioFileName || t('main.accompanimentTrack'),
          accX + labelInsetX,
          y + 16,
          labelMaxWidth,
          labelClipRect,
        );

        ctx.fillStyle = c.fgMuted;
        ctx.font = '10px sans-serif';
        drawClippedText(
          ctx,
          formatAccompanimentDuration(accDuration),
          accX + labelInsetX,
          y + 36,
          labelMaxWidth,
          labelClipRect,
        );
      }
    }

    singerFragments.forEach(fragment => {
      const fragX = fragment.startTime * beatWidth;
      const fragWidth = fragment.duration * beatWidth;
      // 跳过不可见分片（在可视区域左右两侧之外）
      if (fragX + fragWidth < _viewLeft || fragX > _viewRight) return;
      const fragY = y + 4;
      const radius = 6;

      // Rounded rect fill
      ctx.fillStyle = fragment.color + 'cc';
      ctx.beginPath();
      ctx.roundRect(fragX, fragY, fragWidth, FRAGMENT_HEIGHT, radius);
      ctx.fill();

      // Rounded rect stroke
      ctx.strokeStyle = fragment.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(fragX, fragY, fragWidth, FRAGMENT_HEIGHT, radius);
      ctx.stroke();

      // MIDI note visualization
      if (fragment.notes && fragment.notes.length > 0) {
        // 音符较多时复用离屏精灵，拖动/滚动/缩放时每帧只做一次 drawImage。
        // 精灵位图分辨率与屏宽解耦（见 _spriteNeedWidth），因此这里必须用分片
        // 自身的圆角矩形裁剪：否则位图四角的音符条会溢出圆角。
        const sprite = _getNoteSprite(fragment, fragWidth, fragment.duration, dpr);
        if (sprite) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(fragX, fragY, fragWidth, FRAGMENT_HEIGHT, radius);
          ctx.clip();
          ctx.drawImage(sprite, fragX, fragY, fragWidth, FRAGMENT_HEIGHT);
          ctx.restore();
        } else {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(fragX, fragY, fragWidth, FRAGMENT_HEIGHT, radius);
          ctx.clip();

          const midiAreaTop = fragY + 22;
          const midiAreaHeight = FRAGMENT_HEIGHT - 26;
          const fragDuration = fragment.duration;

          // Calculate pitch range（带缓存：音符未增删时直接复用上次结果）
          const { minPitch, maxPitch } = _getFragmentPitchRange(fragment.notes, fragDuration);
          const pitchRange = Math.max(maxPitch - minPitch + 1, 6);

          // 音符条颜色必须与分片底色（fragment.color）保持对比度。
          // 否则分片被拖到颜色相近（如蓝色系）的歌手上、换色后，
          // 固定蓝色音符条会与底色融为一体而“消失”。按底色的亮度
          // 在浅色/深色音符条之间切换，保证任意歌手颜色下都可辨认。
          const noteFill = _getNoteFillFor(fragment.color);

          for (const note of fragment.notes) {
            if (note.start >= fragDuration) continue;
            const noteEnd = Math.min(note.start + note.duration, fragDuration);
            const noteX = fragX + (note.start / fragDuration) * fragWidth;
            const noteW = Math.max(1, ((noteEnd - note.start) / fragDuration) * fragWidth);
            // 视口剔除：超长分片里绝大多数音符在屏幕外，不必进 fillRect
            if (noteX + noteW < _viewLeft || noteX > _viewRight) continue;
            const pitchOffset = (maxPitch - note.pitch) / pitchRange;
            const noteH = Math.max(2, midiAreaHeight / pitchRange);
            const noteY = midiAreaTop + pitchOffset * midiAreaHeight;

            ctx.fillStyle = noteFill;
            ctx.fillRect(noteX, noteY, noteW, noteH);
          }
          ctx.restore();
        }
      }

      // Fragment labels — clipped to the rounded rect with ellipsis
      const labelInsetX = 6;
      const labelClipRect = { x: fragX, y: fragY, w: fragWidth, h: FRAGMENT_HEIGHT };
      const labelMaxWidth = Math.max(0, fragWidth - labelInsetX * 2);

      ctx.fillStyle = c.fragmentText;
      ctx.font = '11px sans-serif';
      drawClippedText(
        ctx,
        fragment.name || t('main.newFragment'),
        fragX + labelInsetX,
        y + 16,
        labelMaxWidth,
        labelClipRect,
      );

      // 自动/手动徽标：让"这段有没有自动曲线、有没有被手动改过"在主窗口一眼可见
      // （不需要打开分片编辑器才能发现）。
      _drawPitchCurveBadge(ctx, fragment, fragX + labelInsetX, y + 4, labelMaxWidth, c);

      ctx.fillStyle = c.fgMuted;
      ctx.font = '10px sans-serif';
      // 每小节的拍数要按拍号换算（MIDI 的 beat 是四分音符）：6/8 是 3 拍而不是 6 拍。
      const beatsPerBar = beatsPerMeasureOf(state.project.timeSignature);
      const measStart = measureNumberAt(fragment.startTime, beatsPerBar);
      const measEnd = measureNumberAt(fragment.startTime + fragment.duration - 0.001, beatsPerBar);
      drawClippedText(
        ctx,
        t('main.measureRange', { start: measStart, end: measEnd }),
        fragX + labelInsetX,
        y + 36,
        labelMaxWidth,
        labelClipRect,
      );

      ctx.save();
      ctx.strokeStyle = c.scrollbarThumb;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(fragX - 2, y + 4, 4, FRAGMENT_HEIGHT);
      ctx.strokeRect(fragX + fragWidth - 2, y + 4, 4, FRAGMENT_HEIGHT);
      ctx.restore();

      // Selection highlight
      if (fragment.id === state.selectedFragmentId) {
        ctx.save();
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.roundRect(fragX - 1, fragY - 1, fragWidth + 2, FRAGMENT_HEIGHT + 2, radius + 1);
        ctx.stroke();
        ctx.restore();
      }
    });

    if (singerFragments.length === 0) {
      ctx.fillStyle = c.fgDisabled;
      ctx.font = '11px sans-serif';
      ctx.fillText(t('main.clickToAddFragment'), 8, y + 30);
    }
  });

  // 调整 playhead canvas 大小会清空其内容；非播放态时立即重绘 playhead，
  // 避免缩放/滚动后 playhead 消失（播放态由 rAF 循环自动刷新）。
  // playhead canvas 只覆盖 container 大小，重绘成本很低。
  if (!state.isPlaying && (state.playbackPauseOffset > 0 || state.currentAudioData)) {
    drawPausedPlayheadAt(state.playbackPauseOffset);
  }
}

// 播放头拖拽 hit-test 容差（像素）
export const PLAYHEAD_HIT_WIDTH = 12;

/**
 * 把秒数转换为 fragment canvas 内部的 X 坐标（含 zoom，不含 scroll，
 * 因为 fragment-canvas 自身有 translate(-scrollX, -scrollY) 变换，
 * 鼠标事件的 clientX-rect.left 已经反映了 scroll）。
 */
export function playbackTimeToX(seconds) {
  const beatWidth = getBeatWidth();
  const beat = (seconds / 60) * (state.project?.bpm || 120);
  return beat * beatWidth;
}

/**
 * 把 fragment canvas 内部的 X 坐标转换为秒数。
 * 用于拖拽时根据鼠标位置计算新的播放时间。
 */
export function xToPlaybackTime(x) {
  const beatWidth = getBeatWidth();
  if (beatWidth <= 0) return 0;
  const beat = x / beatWidth;
  return (beat * 60) / (state.project?.bpm || 120);
}

export function drawPlayheadLine(elapsedSeconds, options = {}) {
  if (!dom.fragmentPlayheadCanvas) return;
  const ctx = dom.fragmentPlayheadCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = dom.fragmentPlayheadCanvas.width / dpr;
  const h = dom.fragmentPlayheadCanvas.height / dpr;

  // The playhead is positioned solely by timeline time. Playback must not
  // mutate scrollX, otherwise the indicator appears pinned to the viewport.

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // playhead canvas 固定覆盖可视区域（不再随 fragment canvas translate），
  // 因此 x 需减去 scrollX 才能与 fragment canvas 内容对齐。
  const x = playbackTimeToX(elapsedSeconds) - state.fragmentScrollX;
  if (x < 0 || x > w) return;

  const c = getCanvasColors();
  const isPaused = options.isPaused === true;
  const isHandleVisible = options.showHandle !== false;

  ctx.save();
  if (isPaused) {
    // 暂停/拖拽态：半透明虚线，区分"已设置位置"与"实时播放"
    ctx.globalAlpha = 0.65;
    ctx.setLineDash([4, 3]);
  }

  ctx.strokeStyle = c.playhead;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();
  ctx.restore();

  if (isHandleVisible) {
    // 顶部三角手柄：底边在 canvas 顶端 y=0，顶点指向下 y=8，
    // 视觉上像挂在天花板上的小旗，提示用户可在此处按下并拖拽跳转播放进度。
    ctx.fillStyle = c.playhead;
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * 绘制"已设置但未播放"的播放头位置（用户拖拽后或暂停后）。
 * 不带三角手柄时也可用作纯位置指示。
 */
export function drawPausedPlayheadAt(offsetSeconds) {
  if (!dom.fragmentPlayheadCanvas) return;
  if (offsetSeconds == null || offsetSeconds < 0) {
    clearPlayheadLine();
    return;
  }
  drawPlayheadLine(offsetSeconds, { isPaused: true, showHandle: true });
}

export function clearPlayheadLine() {
  if (!dom.fragmentPlayheadCanvas) return;
  const ctx = dom.fragmentPlayheadCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = dom.fragmentPlayheadCanvas.width / dpr;
  const h = dom.fragmentPlayheadCanvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
}

function commitTrackNameEdit(singer, newName) {
  if (newName && newName !== singer.trackName) {
    const oldName = singer.trackName;
    const singerId = singer.id;
    trackManager.updateSinger(singer.id, { trackName: newName });
    history.push({
      undo() {
        trackManager.updateSinger(singerId, { trackName: oldName });
        refreshAll();
      },
      redo() {
        trackManager.updateSinger(singerId, { trackName: newName });
        refreshAll();
      }
    });
    markDirty();
  }
}

/**
 * 把轨道后端标签写进歌手行：内置后端是既有的 'SXS INFERENCE' 品牌标识，
 * 插件后端由插件自己声明名称（见 pluginBackend.describeTrackBackend）。
 */
function appendBackendConfig(infoDiv, singer) {
  const desc = describeTrackBackend(singer);
  const configDiv = document.createElement('div');
  configDiv.className = 'singer-config';
  configDiv.textContent = desc.label;
  infoDiv.appendChild(configDiv);
  if (desc.detail) {
    const subDiv = document.createElement('div');
    subDiv.className = 'singer-config';
    subDiv.style.opacity = '0.72';
    subDiv.textContent = desc.detail;
    infoDiv.appendChild(subDiv);
  }
}

export function renderSingerList() {
  const singers = trackManager.getSingers();

  // 插件轨道的标签来自插件清单（异步 IPC）。清单未就绪时先用 kindId 顶着，
  // 到达后靠缓存键变化触发一次重绘 —— 不能因为等 IPC 就阻塞列表渲染。
  if (!hasPluginCatalog() && singers.some(isPluginTrack)) {
    ensurePluginCatalog().then(() => renderSingerList()).catch(() => {});
  }

  // 单次遍历拼接缓存键：原先 5 次 map().join() 会产生 10 个临时数组与字符串，
  // 歌手数量一多时 refreshAll 会有可感知的额外开销。
  let key = String(state.editingTrackNameId || '');
  // 插件清单状态与后端信息进缓存键：清单异步到达/切换后端后标签必须重建
  key += `|cat${hasPluginCatalog() ? 1 : 0}`;
  for (let i = 0; i < singers.length; i++) {
    const s = singers[i];
    // color/avatarPath 参与缓存键：换色或换头像后列表 UI 必须重建，
    // 否则用户改完看不到变化（功能性 bug）。
    key += `|${s.id}~${s.trackName}~${s.singerFileMissing ? 1 : 0}${s.audioFileMissing ? 1 : 0}${s.type || 'singer'}~${s.color || ''}~${s.avatarPath || ''}`;
    const backend = s.backend;
    key += `~${backend ? backend.type : 'sxs'}${backend && backend.pluginId ? backend.pluginId : ''}${backend && backend.kindId ? backend.kindId : ''}${backend && backend.voiceId ? backend.voiceId : ''}${s.backendMissing ? 1 : 0}`;
  }
  const cacheKey = key;
  if (renderSingerList._cacheKey === cacheKey && dom.singerListEl.childElementCount > 0) return;
  renderSingerList._cacheKey = cacheKey;

  dom.singerListEl.innerHTML = '';

  const spacer = document.createElement('div');
  spacer.className = 'singer-row-spacer';
  dom.singerListEl.appendChild(spacer);

  if (singers.length === 0) {
    const emptyItem = document.createElement('div');
    emptyItem.className = 'singer-item-empty';
    emptyItem.setAttribute('role', 'listitem');
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'singer-avatar-empty';
    const placeholder = document.createElement('span');
    placeholder.className = 'singer-avatar-placeholder';
    placeholder.textContent = '+';
    avatarDiv.appendChild(placeholder);
    const infoDiv = document.createElement('div');
    infoDiv.className = 'singer-info-empty';
    const textDiv = document.createElement('div');
    textDiv.className = 'singer-empty-text';
    textDiv.textContent = t('main.clickToAddSinger');
    infoDiv.appendChild(textDiv);
    emptyItem.appendChild(avatarDiv);
    emptyItem.appendChild(infoDiv);
    emptyItem.addEventListener('click', () => {
      showSingerSelectDialog(null);
    });
    dom.singerListEl.appendChild(emptyItem);
    return;
  }

  singers.forEach(singer => {
    const isAccompaniment = singer.type === 'accompaniment';
    const item = document.createElement('div');
    item.className = isAccompaniment ? 'singer-item accompaniment-item' : 'singer-item';
    item.setAttribute('role', 'listitem');
    item.dataset.singerId = singer.id;

    const isEditingTrackName = state.editingTrackNameId === singer.id;

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'singer-avatar';
    if (!isAccompaniment && singer.avatarPath && (singer.avatarPath.startsWith('data:image/') || /^[a-zA-Z]:\\|^\//.test(singer.avatarPath))) {
      const img = document.createElement('img');
      img.src = singer.avatarPath;
      img.alt = singer.singerName || '';
      avatarDiv.appendChild(img);
    } else {
      const iconName = isAccompaniment ? 'music' : 'microphone';
      const icon = createIcon(iconName, { size: 22 });
      if (icon) avatarDiv.appendChild(icon);
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'singer-info';

    if (isEditingTrackName) {
      const input = document.createElement('input');
      input.className = 'singer-track-name-input';
      input.value = singer.trackName;
      input.style.cssText = `
        background: var(--bg-input);
        color: var(--fg-primary);
        border: 1px solid var(--accent);
        border-radius: 3px;
        padding: 2px 4px;
        font-size: 12px;
        font-weight: 600;
        width: 100%;
        outline: none;
        box-shadow: 0 0 0 2px var(--accent-soft);
        transition: border-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
      `;
      infoDiv.appendChild(input);

      const singerNameDiv = document.createElement('div');
      singerNameDiv.className = 'singer-singer-name';
      singerNameDiv.textContent = singer.singerName;
      infoDiv.appendChild(singerNameDiv);

      if (singer.singerFileMissing) {
        const warningDiv = document.createElement('div');
        warningDiv.className = 'singer-file-missing-warning';
        warningDiv.textContent = t('main.singerFileNotFound');
        infoDiv.appendChild(warningDiv);
      } else {
        appendBackendConfig(infoDiv, singer);
      }

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          commitTrackNameEdit(singer, input.value.trim());
          state.editingTrackNameId = null;
          renderSingerList();
        } else if (e.key === 'Escape') {
          state.editingTrackNameId = null;
          renderSingerList();
        }
      });
      input.addEventListener('blur', () => {
        if (state.editingTrackNameId === singer.id) {
          commitTrackNameEdit(singer, input.value.trim());
          state.editingTrackNameId = null;
          renderSingerList();
        }
      });

      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      const trackNameDiv = document.createElement('div');
      trackNameDiv.className = 'singer-track-name';
      trackNameDiv.textContent = singer.trackName;
      infoDiv.appendChild(trackNameDiv);

      const singerNameDiv = document.createElement('div');
      singerNameDiv.className = 'singer-singer-name';
      if (isAccompaniment) {
        // Show audio file name and duration for accompaniment tracks
        const fileName = singer.audioFileName || t('main.accompanimentTrack');
        const duration = singer.audioDuration ? ` (${formatAccompanimentDuration(singer.audioDuration)})` : '';
        singerNameDiv.textContent = fileName + duration;
      } else {
        singerNameDiv.textContent = singer.singerName;
      }
      infoDiv.appendChild(singerNameDiv);

      if (isAccompaniment) {
        if (singer.audioFileMissing) {
          const warningDiv = document.createElement('div');
          warningDiv.className = 'singer-file-missing-warning';
          warningDiv.textContent = t('main.audioFileNotFound');
          infoDiv.appendChild(warningDiv);

          const relocateBtn = document.createElement('button');
          relocateBtn.className = 'btn-relocate-singer';
          relocateBtn.textContent = t('main.relocate');
          relocateBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              const result = await window.electronAPI.showOpenDialog({
                title: t('main.relocateAudioFile'),
                filters: [
                  { name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac'] },
                ],
                properties: ['openFile'],
              });
              if (!result.canceled && result.filePaths.length > 0) {
                const filePath = result.filePaths[0];
                const buffer = await window.electronAPI.readFileBuffer(filePath);
                await loadAccompanimentFile(singer.id, buffer, filePath);
                refreshAll();
              }
            } catch (_err) {
              // Relocation failed silently
            }
          });
          infoDiv.appendChild(relocateBtn);
        } else {
          const configDiv = document.createElement('div');
          configDiv.className = 'singer-config';
          configDiv.textContent = t('main.accompanimentLabel');
          infoDiv.appendChild(configDiv);

          const volumeWrap = document.createElement('label');
          volumeWrap.className = 'accompaniment-volume-control';
          const volumeText = document.createElement('span');
          const currentVolume = Number.isFinite(singer.accompanimentVolume) ? singer.accompanimentVolume : 1;
          volumeText.textContent = t('main.accompanimentVolumeShort', { volume: Math.round(currentVolume * 100) });
          const volumeInput = document.createElement('input');
          volumeInput.type = 'range';
          volumeInput.min = '0';
          volumeInput.max = '2';
          volumeInput.step = '0.01';
          volumeInput.value = String(currentVolume);
          volumeInput.addEventListener('input', (e) => {
            e.stopPropagation();
            const value = Math.max(0, Math.min(2, Number(volumeInput.value)));
            singer.accompanimentVolume = value;
            volumeText.textContent = t('main.accompanimentVolumeShort', { volume: Math.round(value * 100) });
            // 播放中即时生效：伴奏改为独立 BufferSource → GainNode 调度，
            // 这里直接改增益（15ms 斜坡），不再需要重新播放。
            setAccompanimentVolume(singer.id, value);
          });
          volumeInput.addEventListener('click', e => e.stopPropagation());
          volumeWrap.append(volumeText, volumeInput);
          infoDiv.appendChild(volumeWrap);
        }
      } else if (singer.singerFileMissing) {
        const warningDiv = document.createElement('div');
        warningDiv.className = 'singer-file-missing-warning';
        warningDiv.textContent = t('main.singerFileNotFound');
        infoDiv.appendChild(warningDiv);

        const relocateBtn = document.createElement('button');
        relocateBtn.className = 'btn-relocate-singer';
        relocateBtn.textContent = t('main.relocate');
        relocateBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const result = await window.electronAPI.showOpenDialog({
              title: t('main.relocateSingerFile'),
              filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              const filePath = result.filePaths[0];
              const buffer = await window.electronAPI.readFileBuffer(filePath);
              await loadSingerFile(singer.id, buffer, filePath);
              refreshAll();
            }
          } catch (err) {
            console.warn('Unable to relocate the singer file:', err);
          }
        });
        infoDiv.appendChild(relocateBtn);
      } else {
        appendBackendConfig(infoDiv, singer);
      }

      trackNameDiv.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        state.editingTrackNameId = singer.id;
        renderSingerList();
      });
    }

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'singer-item-actions';

    // Accompaniment tracks don't have fragments (no SVS synthesis)
    if (!isAccompaniment) {
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-fragment-add';
      addBtn.title = t('main.addFragment');
      addBtn.dataset.singerId = singer.id;
      addBtn.textContent = '+';
      actionsDiv.appendChild(addBtn);
    }

    if (singers.length > 1) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-singer-delete';
      delBtn.title = t('main.deleteSinger');
      delBtn.dataset.singerId = singer.id;
      delBtn.textContent = '×';
      actionsDiv.appendChild(delBtn);
    }

    item.appendChild(avatarDiv);
    item.appendChild(infoDiv);
    item.appendChild(actionsDiv);

    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-fragment-add') || e.target.closest('.btn-singer-delete') || e.target.closest('.singer-track-name-input') || e.target.closest('.btn-relocate-singer')) {
        return;
      }
      if (state.editingTrackNameId === singer.id) {
        const input = item.querySelector('.singer-track-name-input');
        if (input) {
          commitTrackNameEdit(singer, input.value.trim());
        }
        state.editingTrackNameId = null;
        renderSingerList();
        return;
      }
      document.querySelectorAll('.singer-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      state.selectedSingerId = singer.id;
    });

    if (!isAccompaniment) {
      const addBtn = item.querySelector('.btn-fragment-add');
      if (addBtn) {
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const singerId = addBtn.dataset.singerId;
          const fragments = trackManager.getFragments();
          const lastFragment = fragments.filter(f => f.singerId === singerId).pop();
          const startTime = lastFragment ? lastFragment.startTime + lastFragment.duration : 0;
          const newFragment = trackManager.addFragment({ singerId, startTime, duration: 4 });
          const newFragmentId = newFragment.id;
          history.push({
            undo() {
              trackManager.removeFragment(newFragmentId);
              refreshAll();
            },
            redo() {
              const singer = trackManager.getSinger(singerId);
              const color = singer ? singer.color : getCanvasColors().accent;
              const _frag = trackManager.addFragment({ singerId, startTime, duration: 4, color });
              renderFragmentTimeline();
            }
          });
          markDirty();
          renderFragmentTimeline();
        });
      }
    }

    if (singers.length > 1) {
      const delBtn = item.querySelector('.btn-singer-delete');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const singerId = delBtn.dataset.singerId;
          if (await showConfirmDialog(t('main.confirmDeleteSinger', { name: singer.trackName }))) {
            // structuredClone 保留 ArrayBuffer / Float32Array（wavBuffer、f0Data、
            // midiNotes、audioChannels），JSON 序列化会把它们变成普通对象导致
            // undo 后歌手无法合成。
            const singerClone = structuredClone(singer);
            const singerFragments = trackManager.getFragments().filter(f => f.singerId === singerId);
            const fragmentsClone = singerFragments.map(f => JSON.parse(JSON.stringify(f)));
            trackManager.removeSinger(singerId);
            history.push({
              undo() {
                const restoredSinger = trackManager.addSinger(singerClone);
                // createSinger 只收白名单字段；二进制/大字段不在其中，必须显式回填，
                // 否则 undo 后歌手虽然回来了却缺少参考音频 / F0 / MIDI，无法合成。
                for (const k of ['wavBuffer', 'midiNotes', 'f0Data', 'audioBuffer', 'audioChannels', 'singerData']) {
                  if (singerClone[k] !== undefined) restoredSinger[k] = singerClone[k];
                }
                for (const fc of fragmentsClone) {
                  trackManager.addFragment(fc);
                }
                refreshAll();
              },
              redo() {
                trackManager.removeSinger(singerId);
                refreshAll();
              }
            });
            markDirty();
            refreshAll();
          }
        });
      }
    }

    dom.singerListEl.appendChild(item);
  });
}

// 语言切换后动态文案必须重建：清空列表缓存键，让下一次 refreshAll 真正重建 DOM。
export function invalidateSingerListCache() {
  renderSingerList._cacheKey = null;
}

export function refreshAll() {
  renderSingerList();
  renderFragmentTimeline();
}

// Re-render when theme changes
if (typeof window !== 'undefined') {
  window.addEventListener('theme:changed', () => {
    invalidateCanvasThemeCache();
    invalidateGridCache();
    invalidateFragmentNoteSprites();
    refreshAll();
  });
}

/**
 * 分片卡片上的音高曲线状态徽标。
 *   · 自动开启 + 无手动内容  → "自动"（浅色）
 *   · 自动开启 + 有手动内容  → "混合"（强调色）
 *   · 仅手动                 → "手动"
 * 未开启自动且无手动内容时不画（v2.0.2 的旧工程不会多出任何视觉元素）。
 */
function _drawPitchCurveBadge(ctx, fragment, x, y, maxWidth, c) {
  const pc = fragment && fragment.pitchCurve;
  if (!pc) return;
  const autoOn = !!(pc.auto && pc.auto.enabled);
  const manualCount = (pc.anchorPoints?.length || 0)
    + (pc.brushSegments?.length || 0)
    + (pc.bakedSegments?.length || 0);
  if (!autoOn && manualCount === 0) return;

  const label = autoOn ? (manualCount > 0 ? t('main.pitchCurveMixed') : t('main.pitchCurveAuto')) : t('main.pitchCurveManual');
  ctx.font = '9px sans-serif';
  const w = Math.min(maxWidth, ctx.measureText(label).width + 8);
  if (w < 16) return;
  const h = 12;
  const bx = Math.max(0, x);
  if (bx + w > maxWidth) return;

  ctx.save();
  ctx.fillStyle = autoOn ? (c.accent || '#5b8def') : (c.fgMuted || '#8888a8');
  ctx.globalAlpha = 0.85;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(bx, y, w, h, 3);
    ctx.fill();
  } else {
    ctx.fillRect(bx, y, w, h);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, bx + 4, y + 9);
  ctx.restore();
}
