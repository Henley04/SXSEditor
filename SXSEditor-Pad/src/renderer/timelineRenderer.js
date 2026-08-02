import {
  FRAGMENT_HEIGHT,
  FRAGMENT_MIN_WIDTH,
  PIXELS_PER_BEAT,
  COLORS,
} from './constants.js';
import {
  getProject,
  getPlayback,
  getUI,
  getDOM,
  getZoom,
  getFragmentById,
  getSelectedFragmentId,
} from './state.js';

let resizeObserver = null;
let rafId = null;
let needsRender = true;

// Fragment color palette — cycles through for visual distinction
const FRAGMENT_COLORS = [
  { fill: 'rgba(233, 69, 96, 0.2)', stroke: '#e94560' },
  { fill: 'rgba(69, 127, 233, 0.2)', stroke: '#457fe9' },
  { fill: 'rgba(69, 233, 178, 0.2)', stroke: '#45e9b2' },
  { fill: 'rgba(233, 178, 69, 0.2)', stroke: '#e9b245' },
  { fill: 'rgba(178, 69, 233, 0.2)', stroke: '#b245e9' },
  { fill: 'rgba(233, 96, 69, 0.2)', stroke: '#e96045' },
  { fill: 'rgba(96, 233, 69, 0.2)', stroke: '#60e945' },
  { fill: 'rgba(69, 178, 233, 0.2)', stroke: '#45b2e9' },
];

function getFragmentColor(index) {
  return FRAGMENT_COLORS[index % FRAGMENT_COLORS.length];
}

/**
 * Convert a beat position to pixel x coordinate.
 */
function beatToPixel(beat, zoom, scrollX) {
  return beat * PIXELS_PER_BEAT * zoom - scrollX;
}

/**
 * Convert a pixel x coordinate to beat position.
 */
export function pixelToBeat(pixelX, zoom, scrollX) {
  return (pixelX + scrollX) / (PIXELS_PER_BEAT * zoom);
}

/**
 * Compute the total duration of the project in beats.
 */
function getProjectDurationInBeats(project) {
  let maxEnd = 0;
  for (const frag of project.fragments) {
    const end = frag.startBeat + frag.durationBeats;
    if (end > maxEnd) maxEnd = end;
  }
  return Math.max(maxEnd, 16); // at least 4 bars at 4/4
}

/**
 * Draw the background grid (bars, beats, sub-beats).
 */
function drawGrid(ctx, project, width, height, zoom, scrollX) {
  const bpm = project.bpm;
  const timeSigNum = project.timeSigNum;
  const timeSigDen = project.timeSigDen;
  const pixelsPerBeat = PIXELS_PER_BEAT * zoom;
  const totalBeats = getProjectDurationInBeats(project) + 8; // extra padding

  // Background fill
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  const startBeat = Math.max(0, Math.floor(scrollX / pixelsPerBeat));
  const endBeat = Math.ceil((scrollX + width) / pixelsPerBeat) + 1;

  for (let beat = startBeat; beat <= endBeat && beat <= totalBeats; beat++) {
    const x = beat * pixelsPerBeat - scrollX;
    const isBar = beat % timeSigNum === 0;

    if (isBar) {
      // Bar line
      ctx.strokeStyle = COLORS.barLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Bar number label
      const barNumber = Math.floor(beat / timeSigNum) + 1;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(barNumber.toString(), x + 3, 3);
    } else {
      // Beat line
      ctx.strokeStyle = COLORS.beatLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Sub-beat grid (8th notes)
      if (timeSigDen >= 4) {
        for (let sub = 1; sub < 4; sub++) {
          const subX = x + (pixelsPerBeat / 4) * sub;
          if (subX > scrollX - pixelsPerBeat && subX < scrollX + width + pixelsPerBeat) {
            ctx.strokeStyle = COLORS.gridLine;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(subX, 0);
            ctx.lineTo(subX, height);
            ctx.stroke();
          }
        }
      }
    }
  }
}

/**
 * Draw all fragment blocks on the canvas.
 */
function drawFragments(ctx, project, width, height, zoom, scrollX) {
  const pixelsPerBeat = PIXELS_PER_BEAT * zoom;
  const selectedId = getSelectedFragmentId();

  for (let i = 0; i < project.fragments.length; i++) {
    const frag = project.fragments[i];
    const x = frag.startBeat * pixelsPerBeat - scrollX;
    const fragWidth = Math.max(frag.durationBeats * pixelsPerBeat, FRAGMENT_MIN_WIDTH);
    const y = frag.trackIndex * FRAGMENT_HEIGHT + 4; // 4px top padding
    const h = FRAGMENT_HEIGHT - 8; // 4px bottom padding
    const radius = 6;

    // Skip fragments outside viewport
    if (x + fragWidth < -10 || x > width + 10) continue;

    const isSelected = frag.id === selectedId;
    const colorScheme = getFragmentColor(i);

    // Fragment shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;

    // Fragment body (rounded rect)
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + fragWidth - radius, y);
    ctx.quadraticCurveTo(x + fragWidth, y, x + fragWidth, y + radius);
    ctx.lineTo(x + fragWidth, y + h - radius);
    ctx.quadraticCurveTo(x + fragWidth, y + h, x + fragWidth - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();

    // Fill
    ctx.fillStyle = isSelected ? COLORS.fragmentHover : colorScheme.fill;
    ctx.fill();

    // Stroke
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = isSelected ? COLORS.fragmentStroke : colorScheme.stroke;
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();

    // Selection indicator overlay
    if (isSelected) {
      ctx.fillStyle = COLORS.selection;
      ctx.fill();
    }

    // Fragment label
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelY = y + h / 2;

    // Singer name badge
    if (frag.singerName) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      const badgeWidth = ctx.measureText(frag.singerName).width + 10;
      ctx.beginPath();
      ctx.roundRect(x + 6, y + 4, badgeWidth, 16, 3);
      ctx.fill();
      ctx.fillStyle = '#a0a0a0';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(frag.singerName, x + 11, y + 12);
    }

    // Fragment name / label
    ctx.fillStyle = '#ffffff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelText = frag.label || `Fragment ${i + 1}`;
    ctx.fillText(labelText, x + 10, labelY - 2);

    // Duration text
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const durationStr = `${frag.durationBeats.toFixed(1)} beats`;
    ctx.fillText(durationStr, x + fragWidth - 6, y + h - 4);
  }
}

/**
 * Draw the playhead line.
 */
function drawPlayhead(ctx, playback, width, height, zoom, scrollX) {
  const pixelsPerBeat = PIXELS_PER_BEAT * zoom;
  const x = playback.position * pixelsPerBeat - scrollX;

  if (x < -5 || x > width + 5) return;

  // Playhead line
  ctx.strokeStyle = COLORS.playhead;
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(233, 69, 96, 0.5)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 0;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.shadowColor = 'transparent';

  // Playhead triangle handle at top
  ctx.fillStyle = COLORS.playhead;
  ctx.beginPath();
  ctx.moveTo(x - 6, 0);
  ctx.lineTo(x + 6, 0);
  ctx.lineTo(x, 10);
  ctx.closePath();
  ctx.fill();

  // Playhead triangle handle at bottom
  ctx.beginPath();
  ctx.moveTo(x - 6, height);
  ctx.lineTo(x + 6, height);
  ctx.lineTo(x, height - 10);
  ctx.closePath();
  ctx.fill();
}

/**
 * Master render function — draws everything.
 */
export function render() {
  const dom = getDOM();
  const canvas = dom.fragmentCanvas;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const project = getProject();
  const playback = getPlayback();
  const ui = getUI();
  const zoom = getZoom();
  const { scrollX, scrollY } = ui;

  const width = canvas.width;
  const height = canvas.height;

  // Clear
  ctx.clearRect(0, 0, width, height);

  // Draw layers
  drawGrid(ctx, project, width, height, zoom, scrollX);
  drawFragments(ctx, project, width, height, zoom, scrollX);
  drawPlayhead(ctx, playback, width, height, zoom, scrollX);

  needsRender = false;
}

/**
 * Request a render on the next animation frame.
 */
export function requestRender() {
  needsRender = true;
}

/**
 * Render loop — runs via requestAnimationFrame.
 */
function renderLoop() {
  if (needsRender) {
    render();
  }
  rafId = requestAnimationFrame(renderLoop);
}

/**
 * Initialize the renderer: set up canvas sizing, ResizeObserver, and start the loop.
 */
export function initRenderer() {
  const dom = getDOM();
  const canvas = dom.fragmentCanvas;
  const playheadCanvas = dom.playheadCanvas;

  if (!canvas) {
    console.warn('[timelineRenderer] fragment-canvas not found in DOM');
    return;
  }

  // Size canvas to parent
  function sizeCanvas() {
    const parent = canvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = parent.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);

    // Also size the playhead overlay canvas
    if (playheadCanvas) {
      playheadCanvas.width = w * dpr;
      playheadCanvas.height = h * dpr;
      playheadCanvas.style.width = `${w}px`;
      playheadCanvas.style.height = `${h}px`;
      const phCtx = playheadCanvas.getContext('2d');
      if (phCtx) phCtx.scale(dpr, dpr);
    }

    requestRender();
  }

  // Initial size
  sizeCanvas();

  // ResizeObserver for responsive sizing
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
  resizeObserver = new ResizeObserver(() => {
    sizeCanvas();
  });
  resizeObserver.observe(canvas.parentElement);

  // Start render loop
  if (rafId) {
    cancelAnimationFrame(rafId);
  }
  rafId = requestAnimationFrame(renderLoop);
}

/**
 * Clear the canvas.
 */
export function clear() {
  const dom = getDOM();
  const canvas = dom.fragmentCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * Clean up the renderer (disconnect observers, cancel animation frame).
 */
export function destroyRenderer() {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}