import {
  FRAGMENT_HEIGHT,
  PIXELS_PER_BEAT,
  SNAP_DISTANCE,
} from './constants.js';
import {
  getProject,
  getPlayback,
  getUI,
  getDOM,
  getZoom,
  setPlaybackPlaying,
  setPlaybackPosition,
  setSelectedFragmentId,
  setScroll,
  setZoom,
  setBpm,
  setTimeSig,
  setAutoShift,
  addFragment,
  removeFragmentById,
  updateFragment,
  getFragmentById,
  markDirty,
} from './state.js';
import { pixelToBeat, requestRender } from './timelineRenderer.js';
import { togglePlay, stopPlayback, seekTo } from './audioPlayback.js';
import { saveProject } from './projectManager.js';
import { deleteFragment, duplicateFragment } from './fragmentOperations.js';

// Drag state
let dragState = null;
let isPointerDown = false;
let lastPointerX = 0;
let lastPointerY = 0;
let contextMenuTarget = null;

// ==================== Keyboard Shortcuts ====================

const keyHandlers = {
  ' ': (e) => {
    e.preventDefault();
    togglePlay();
  },
  Delete: (e) => {
    e.preventDefault();
    const id = getUI().selectedFragmentId;
    if (id) {
      deleteFragment(id);
    }
  },
  Backspace: (e) => {
    // Only handle when not in an input/textarea
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const id = getUI().selectedFragmentId;
    if (id) {
      e.preventDefault();
      deleteFragment(id);
    }
  },
  z: (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // Undo — dispatches custom event so the undo system can hook in
      window.dispatchEvent(new CustomEvent('sxs:undo'));
    }
  },
  s: (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      saveProject();
    }
  },
  d: (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const id = getUI().selectedFragmentId;
      if (id) {
        duplicateFragment(id);
      }
    }
  },
  a: (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // Select all — dispatches custom event
      window.dispatchEvent(new CustomEvent('sxs:select-all'));
    }
  },
  Escape: (e) => {
    setSelectedFragmentId(null);
    requestRender();
  },
};

function handleKeyDown(e) {
  const handler = keyHandlers[e.key];
  if (handler) {
    handler(e);
  }
}

// ==================== Canvas Pointer Events (Mouse + Touch unified) ====================

function getCanvasCoords(e) {
  const canvas = getDOM().fragmentCanvas;
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  const clientX = e.clientX !== undefined ? e.clientX : e.touches?.[0]?.clientX || 0;
  const clientY = e.clientY !== undefined ? e.clientY : e.touches?.[0]?.clientY || 0;
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function findFragmentAt(x, y) {
  const project = getProject();
  const zoom = getZoom();
  const ui = getUI();
  const pixelsPerBeat = PIXELS_PER_BEAT * zoom;

  // Search in reverse order so top-most fragments are hit first
  for (let i = project.fragments.length - 1; i >= 0; i--) {
    const frag = project.fragments[i];
    const fragX = frag.startBeat * pixelsPerBeat - ui.scrollX;
    const fragW = frag.durationBeats * pixelsPerBeat;
    const fragY = frag.trackIndex * FRAGMENT_HEIGHT + 4;
    const fragH = FRAGMENT_HEIGHT - 8;

    if (x >= fragX && x <= fragX + fragW && y >= fragY && y <= fragY + fragH) {
      return frag;
    }
  }
  return null;
}

function handlePointerDown(e) {
  const canvas = getDOM().fragmentCanvas;
  if (!canvas) return;
  const coords = getCanvasCoords(e);
  isPointerDown = true;
  lastPointerX = coords.x;
  lastPointerY = coords.y;

  const frag = findFragmentAt(coords.x, coords.y);

  if (frag) {
    // Select fragment
    setSelectedFragmentId(frag.id);
    dragState = {
      type: 'drag-fragment',
      fragmentId: frag.id,
      offsetX: coords.x - (frag.startBeat * PIXELS_PER_BEAT * getZoom() - getUI().scrollX),
      startBeat: frag.startBeat,
      startTrack: frag.trackIndex,
    };
    requestRender();
  } else {
    // Deselect and prepare for playhead move
    setSelectedFragmentId(null);
    const beat = pixelToBeat(coords.x, getZoom(), getUI().scrollX);
    dragState = {
      type: 'move-playhead',
    };
    setPlaybackPosition(Math.max(0, beat));
    requestRender();
  }

  // Capture pointer for reliable tracking
  canvas.setPointerCapture(e.pointerId);
}

function handlePointerMove(e) {
  const canvas = getDOM().fragmentCanvas;
  if (!canvas) return;
  const coords = getCanvasCoords(e);

  if (!isPointerDown || !dragState) {
    // Hover effect — update cursor
    const frag = findFragmentAt(coords.x, coords.y);
    canvas.style.cursor = frag ? 'grab' : 'default';

    // Update hover state for fragment highlighting
    if (frag) {
      canvas.dataset.hoverFragmentId = frag.id;
    } else {
      delete canvas.dataset.hoverFragmentId;
    }
    requestRender();
    return;
  }

  const zoom = getZoom();
  const ui = getUI();

  if (dragState.type === 'drag-fragment') {
    const pixelsPerBeat = PIXELS_PER_BEAT * zoom;
    const rawBeat = pixelToBeat(coords.x - dragState.offsetX, zoom, ui.scrollX);
    const snappedBeat = Math.round(rawBeat * 4) / 4; // snap to 16th notes
    const newTrack = Math.max(0, Math.floor((coords.y) / FRAGMENT_HEIGHT));

    updateFragment(dragState.fragmentId, {
      startBeat: Math.max(0, snappedBeat),
      trackIndex: newTrack,
    });
    requestRender();
  } else if (dragState.type === 'move-playhead') {
    const beat = pixelToBeat(coords.x, zoom, ui.scrollX);
    setPlaybackPosition(Math.max(0, beat));
    requestRender();
  }

  lastPointerX = coords.x;
  lastPointerY = coords.y;
}

function handlePointerUp(e) {
  if (!isPointerDown) return;
  isPointerDown = false;
  dragState = null;

  const canvas = getDOM().fragmentCanvas;
  if (canvas) {
    canvas.style.cursor = 'default';
  }

  requestRender();
}

// ==================== Touch Events ====================

function handleTouchStart(e) {
  if (e.touches.length === 1) {
    const touch = e.touches[0];
    handlePointerDown({
      clientX: touch.clientX,
      clientY: touch.clientY,
      pointerId: 'touch',
      preventDefault: () => e.preventDefault(),
    });
  }
}

function handleTouchMove(e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    const touch = e.touches[0];
    handlePointerMove({
      clientX: touch.clientX,
      clientY: touch.clientY,
      pointerId: 'touch',
    });
  }
}

function handleTouchEnd(e) {
  handlePointerUp({});
}

// ==================== Scroll Wheel Zoom ====================

function handleWheel(e) {
  const ui = getUI();
  const zoom = getZoom();

  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    const newZoom = Math.max(0.1, Math.min(5, zoom + delta));
    setZoom(newZoom);

    // Adjust scroll position to keep the point under cursor stable
    const rect = getDOM().fragmentCanvas?.getBoundingClientRect();
    if (rect) {
      const mouseX = e.clientX - rect.left;
      const oldBeat = pixelToBeat(mouseX, zoom, ui.scrollX);
      const newPixelsPerBeat = PIXELS_PER_BEAT * newZoom;
      const newScrollX = oldBeat * newPixelsPerBeat - mouseX;
      setScroll(newScrollX, ui.scrollY);
    }

    requestRender();
  } else {
    // Horizontal scroll
    const newScrollX = Math.max(0, ui.scrollX + e.deltaX * 0.5);
    setScroll(newScrollX, ui.scrollY);
    requestRender();
  }
}

// ==================== Context Menu ====================

function handleContextMenu(e) {
  e.preventDefault();
  const canvas = getDOM().fragmentCanvas;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const frag = findFragmentAt(x, y);
  if (frag) {
    setSelectedFragmentId(frag.id);
    contextMenuTarget = frag.id;
    requestRender();

    // Dispatch custom context menu event for the UI layer
    window.dispatchEvent(new CustomEvent('sxs:context-menu', {
      detail: {
        fragmentId: frag.id,
        x: e.clientX,
        y: e.clientY,
      },
    }));
  }
}

// ==================== Toolbar Handlers ====================

function setupToolbarHandlers() {
  const dom = getDOM();

  // Play
  dom.toolbar?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    switch (action) {
      case 'play':
        togglePlay();
        break;
      case 'pause':
        togglePlay();
        break;
      case 'stop':
        stopPlayback();
        break;
      case 'load':
        window.dispatchEvent(new CustomEvent('sxs:load-project'));
        break;
      case 'export':
        window.dispatchEvent(new CustomEvent('sxs:export'));
        break;
      case 'audio-to-midi':
        window.dispatchEvent(new CustomEvent('sxs:audio-to-midi'));
        break;
      case 'import-midi':
        window.dispatchEvent(new CustomEvent('sxs:import-midi'));
        break;
      case 'singer-market':
        window.dispatchEvent(new CustomEvent('sxs:singer-market'));
        break;
    }
  });
}

// ==================== BPM Input Handler ====================

function setupBpmHandler() {
  const dom = getDOM();
  dom.bpmInput?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val >= 1 && val <= 999) {
      setBpm(val);
      markDirty();
      requestRender();
    } else {
      e.target.value = getProject().bpm;
    }
  });
}

// ==================== Time Signature Handlers ====================

function setupTimeSigHandlers() {
  const dom = getDOM();
  dom.timeSigNum?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val >= 1 && val <= 32) {
      setTimeSig(val, getProject().timeSigDen);
      markDirty();
      requestRender();
    } else {
      e.target.value = getProject().timeSigNum;
    }
  });
  dom.timeSigDen?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && (val === 1 || val === 2 || val === 4 || val === 8 || val === 16)) {
      setTimeSig(getProject().timeSigNum, val);
      markDirty();
      requestRender();
    } else {
      e.target.value = getProject().timeSigDen;
    }
  });
}

// ==================== Auto Shift Handler ====================

function setupAutoShiftHandler() {
  const dom = getDOM();
  dom.autoShiftCheck?.addEventListener('change', (e) => {
    setAutoShift(e.target.checked);
    markDirty();
  });
}

// ==================== Window Resize ====================

function handleWindowResize() {
  requestRender();
}

// ==================== Init ====================

/**
 * Initialize all event handlers.
 */
export function initEventHandlers() {
  const canvas = getDOM().fragmentCanvas;
  if (!canvas) return;

  // Pointer events (mouse + pen)
  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp);

  // Touch events (for mobile)
  canvas.addEventListener('touchstart', handleTouchStart, { passive: true });
  canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
  canvas.addEventListener('touchend', handleTouchEnd, { passive: true });

  // Wheel / zoom
  canvas.addEventListener('wheel', handleWheel, { passive: false });

  // Context menu
  canvas.addEventListener('contextmenu', handleContextMenu);

  // Keyboard
  document.addEventListener('keydown', handleKeyDown);

  // Toolbar
  setupToolbarHandlers();

  // Inputs
  setupBpmHandler();
  setupTimeSigHandlers();
  setupAutoShiftHandler();

  // Window resize
  window.addEventListener('resize', handleWindowResize);
}

/**
 * Remove all event handlers (cleanup).
 */
export function destroyEventHandlers() {
  const canvas = getDOM().fragmentCanvas;
  if (canvas) {
    canvas.removeEventListener('pointerdown', handlePointerDown);
    canvas.removeEventListener('pointermove', handlePointerMove);
    canvas.removeEventListener('pointerup', handlePointerUp);
    canvas.removeEventListener('pointercancel', handlePointerUp);
    canvas.removeEventListener('touchstart', handleTouchStart);
    canvas.removeEventListener('touchmove', handleTouchMove);
    canvas.removeEventListener('touchend', handleTouchEnd);
    canvas.removeEventListener('wheel', handleWheel);
    canvas.removeEventListener('contextmenu', handleContextMenu);
  }
  document.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('resize', handleWindowResize);
}