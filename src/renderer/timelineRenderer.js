import { state, dom, trackManager, history } from './state.js';
import {
  FRAGMENT_HEIGHT,
  SINGER_ROW_HEIGHT,
  HEADER_HEIGHT,
  FRAGMENT_BASE_BEAT_WIDTH,
} from './constants.js';
import { t } from '../i18n/index.js';
import { getCanvasColors, invalidateCanvasThemeCache } from '../themes/canvasTheme.js';
import { computeLuminanceCached } from '../themes/colorUtils.js';
import { showConfirmDialog } from '../alertDialog.js';
import { loadSingerFile, showSingerSelectDialog, markDirty, loadAccompanimentFile } from './projectManager.js';
import { createIcon } from '../icons/iconHelper.js';

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

// Grid is rendered directly into the viewport-sized canvas.
export function invalidateGridCache() {}

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
let _noteSpriteCache = new Map();

/** 分片音符内容或主题变化后调用，强制重建精灵。 */
export function invalidateFragmentNoteSprites() {
  _noteSpriteCache.clear();
}

function _buildNoteSprite(fragment, cssW, fragDuration, dpr) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.floor(cssW * dpr));
  cv.height = Math.max(1, Math.floor(FRAGMENT_HEIGHT * dpr));
  const c2 = cv.getContext('2d');
  if (!c2) return null;
  c2.setTransform(dpr, 0, 0, dpr, 0, 0);
  c2.beginPath();
  c2.roundRect(0, 0, cssW, FRAGMENT_HEIGHT, 6);
  c2.clip();

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
  const cssW = Math.max(1, Math.round(fragWidth));
  const hit = _noteSpriteCache.get(fragment.id);
  if (hit && hit.w === cssW && hit.color === fragment.color
      && hit.len === notes.length && hit.dur === fragDuration && hit.dpr === dpr) {
    return hit.canvas;
  }
  const cv = _buildNoteSprite(fragment, cssW, fragDuration, dpr);
  if (!cv) return null;
  if (_noteSpriteCache.size >= NOTE_SPRITE_MAX_ENTRIES) _noteSpriteCache.clear();
  _noteSpriteCache.set(fragment.id, {
    canvas: cv, w: cssW, color: fragment.color,
    len: notes.length, dur: fragDuration, dpr,
  });
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

export function syncFragmentScroll() {
  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const beatWidth = getBeatWidth();
  const fragmentMaxBeat = fragments.reduce((max, f) => Math.max(max, f.startTime + f.duration), 0);
  const accompanimentMaxBeat = singers.reduce((max, singer) => {
    if (singer.type !== 'accompaniment' || !singer.audioDuration) return max;
    const endBeat = (singer.accompanimentStartTime || 0)
      + singer.audioDuration / 60 * state.project.bpm;
    return Math.max(max, endBeat);
  }, 0);
  const maxBeat = Math.max(fragmentMaxBeat, accompanimentMaxBeat);
  const totalBeats = Math.max(64, Math.ceil((maxBeat + 256) / 64) * 64);
  const canvasWidth = totalBeats * beatWidth;
  const canvasHeight = singers.length * SINGER_ROW_HEIGHT + HEADER_HEIGHT;
  const containerW = dom.fragmentContainer.clientWidth;
  const containerH = dom.fragmentContainer.clientHeight;

  state.fragmentScrollX = Math.max(0, Math.min(state.fragmentScrollX, canvasWidth - containerW));
  state.fragmentScrollY = Math.max(0, Math.min(state.fragmentScrollY, canvasHeight - containerH));

  // fragment canvas 应用 translate 变换以实现滚动；
  // playhead canvas 不再应用 translate，改为固定覆盖可视区域，
  // 绘制时由 drawPlayheadLine 自行减去 scrollX（避免大 canvas clearRect 卡顿）。
  // Canvas is viewport-sized. Scrolling is applied to the drawing transform,
  // never by moving or enlarging the backing store.
  dom.fragmentCanvas.style.transform = 'none';
  dom.singerListEl.scrollTop = state.fragmentScrollY;
}

export function renderFragmentTimeline() {
  const ctx = dom.fragmentCanvas.getContext('2d');
  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const dpr = window.devicePixelRatio || 1;

  const beatWidth = getBeatWidth();
  const fragmentMaxBeat = fragments.reduce((max, f) => Math.max(max, f.startTime + f.duration), 0);
  const accompanimentMaxBeat = singers.reduce((max, singer) => {
    if (singer.type !== 'accompaniment' || !singer.audioDuration) return max;
    const endBeat = (singer.accompanimentStartTime || 0)
      + singer.audioDuration / 60 * state.project.bpm;
    return Math.max(max, endBeat);
  }, 0);
  const maxBeat = Math.max(fragmentMaxBeat, accompanimentMaxBeat);
  const totalBeats = Math.max(64, Math.ceil((maxBeat + 256) / 64) * 64);
  const virtualWidth = totalBeats * beatWidth;
  const contentHeight = singers.length * SINGER_ROW_HEIGHT + HEADER_HEIGHT;
  const viewportWidth = Math.max(1, dom.fragmentContainer.clientWidth || 1);
  const viewportHeight = Math.max(1, dom.fragmentContainer.clientHeight || contentHeight || 1);

  // Keep the backing stores bounded by the viewport. Long MIDI projects only
  // increase virtualWidth, not canvas.width, avoiding Chromium's canvas limit.
  _ensureCanvasSize(dom.fragmentCanvas, viewportWidth, viewportHeight, dpr);
  _ensureCanvasSize(dom.fragmentPlayheadCanvas, viewportWidth, viewportHeight, dpr);

  state.fragmentScrollX = Math.max(0, Math.min(state.fragmentScrollX, virtualWidth - viewportWidth));
  state.fragmentScrollY = Math.max(0, Math.min(state.fragmentScrollY, contentHeight - viewportHeight));
  syncFragmentScroll();

  // Clear in device-independent viewport coordinates, then translate the
  // world timeline into the viewport. Existing fragment drawing remains in
  // world coordinates and is clipped by the viewport backing store.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewportWidth, viewportHeight);
  ctx.translate(-state.fragmentScrollX, -state.fragmentScrollY);

  const c = getCanvasColors();
  const beatsPerMeasure = state.project.timeSignature ? state.project.timeSignature[0] : 4;
  const _viewLeft = state.fragmentScrollX;
  const _viewRight = state.fragmentScrollX + viewportWidth;
  const _viewTop = state.fragmentScrollY;
  const _viewBottom = state.fragmentScrollY + viewportHeight;

  // Draw only the visible grid. A full-width offscreen cache would recreate
  // the same oversized-canvas failure as the main canvas.
  ctx.fillStyle = c.bgApp;
  ctx.fillRect(_viewLeft, _viewTop, viewportWidth, viewportHeight);
  ctx.lineWidth = 1;
  const firstBeat = Math.max(0, Math.floor(_viewLeft / beatWidth));
  const lastBeat = Math.min(totalBeats, Math.ceil(_viewRight / beatWidth));
  for (let i = firstBeat; i <= lastBeat; i++) {
    const x = i * beatWidth;
    const isMeasureLine = (i % beatsPerMeasure === 0);
    ctx.strokeStyle = isMeasureLine ? c.gridLineMeasure : c.gridLineMajor;
    ctx.beginPath();
    ctx.moveTo(x, _viewTop);
    ctx.lineTo(x, _viewBottom);
    ctx.stroke();
    if (isMeasureLine && HEADER_HEIGHT >= _viewTop) {
      const measureNum = Math.floor(i / beatsPerMeasure) + 1;
      ctx.fillStyle = c.timeText;
      ctx.font = '10px sans-serif';
      ctx.fillText(String(measureNum), x + 2, HEADER_HEIGHT - 4);
    }
  }

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
          ctx.beginPath();
          for (let px = 0; px < accWidth; px++) {
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
        // 音符较多时复用离屏精灵，拖动/滚动时每帧只做一次 drawImage
        const sprite = _getNoteSprite(fragment, fragWidth, fragment.duration, dpr);
        if (sprite) {
          ctx.drawImage(sprite, fragX, fragY, fragWidth, FRAGMENT_HEIGHT);
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

      ctx.fillStyle = c.fgMuted;
      ctx.font = '10px sans-serif';
      const bps = state.project.timeSignature ? state.project.timeSignature[0] : 4;
      const measStart = Math.floor(fragment.startTime / bps) + 1;
      const measEnd = Math.floor((fragment.startTime + fragment.duration - 0.001) / bps) + 1;
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

export function renderSingerList() {
  const singers = trackManager.getSingers();
  // 单次遍历拼接缓存键：原先 5 次 map().join() 会产生 10 个临时数组与字符串，
  // 歌手数量一多时 refreshAll 会有可感知的额外开销。
  let key = String(state.editingTrackNameId || '');
  for (let i = 0; i < singers.length; i++) {
    const s = singers[i];
    // color/avatarPath 参与缓存键：换色或换头像后列表 UI 必须重建，
    // 否则用户改完看不到变化（功能性 bug）。
    key += `|${s.id}~${s.trackName}~${s.singerFileMissing ? 1 : 0}${s.audioFileMissing ? 1 : 0}${s.type || 'singer'}~${s.color || ''}~${s.avatarPath || ''}`;
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
        const configDiv = document.createElement('div');
        configDiv.className = 'singer-config';
        configDiv.textContent = 'SXS INFERENCE';
        infoDiv.appendChild(configDiv);
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
          volumeText.textContent = `Vol ${Math.round(currentVolume * 100)}%`;
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
            volumeText.textContent = `Vol ${Math.round(value * 100)}%`;
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
        const configDiv = document.createElement('div');
        configDiv.className = 'singer-config';
        configDiv.textContent = 'SXS INFERENCE';
        infoDiv.appendChild(configDiv);
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
            const singerClone = JSON.parse(JSON.stringify(singer));
            const singerFragments = trackManager.getFragments().filter(f => f.singerId === singerId);
            const fragmentsClone = singerFragments.map(f => JSON.parse(JSON.stringify(f)));
            trackManager.removeSinger(singerId);
            history.push({
              undo() {
                const _restoredSinger = trackManager.addSinger(singerClone);
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
