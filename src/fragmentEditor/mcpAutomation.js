/**
 * MCP automation handlers that live in the fragment-editor window.
 *
 * `editor.getView` / `editor.setView` cannot be served by the main window: the
 * editor keeps its own zoom, scroll and selection state. The bridge routes
 * methods whose schema target is 'editor' here over the same IPC request /
 * response channel the main window uses.
 */
import { BEAT_WIDTH } from './constants.js';
import {
  getZoomX, setZoomX,
  getScrollX, setScrollX,
  getScrollY, setScrollY,
  getSelectedNoteIds, setSelectedNoteIds,
  getCurrentFragment, getNotes,
} from './state.js';
import { render } from './canvasRenderer.js';

function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function currentMode() {
  const active = document.querySelector('.btn-param.active');
  return active && active.id === 'btn-param-Pitch' ? 'Pitch' : 'MIDI';
}

function currentLane() {
  const tab = document.querySelector('.param-lane-tab.active');
  return tab ? tab.dataset.lane : null;
}

function getView() {
  const fragment = getCurrentFragment();
  const zoomX = getZoomX();
  const scrollX = getScrollX();
  return {
    fragmentId: fragment ? fragment.id : null,
    zoomX,
    scrollX,
    scrollBeats: zoomX > 0 ? scrollX / (BEAT_WIDTH * zoomX) : 0,
    scrollY: getScrollY(),
    mode: currentMode(),
    paramLane: currentLane(),
    selectedNoteIds: [...getSelectedNoteIds()],
    noteCount: getNotes().length,
  };
}

function setView(p = {}) {
  if (p.zoomX !== undefined) {
    const z = Number(p.zoomX);
    if (!Number.isFinite(z) || z < 0.25 || z > 8) {
      throw fail('VALIDATION_ERROR', 'zoomX must be between 0.25 and 8', { field: 'zoomX' });
    }
    setZoomX(z);
  }

  if (p.scrollBeats !== undefined) {
    const beats = Number(p.scrollBeats);
    if (!Number.isFinite(beats) || beats < 0) {
      throw fail('VALIDATION_ERROR', 'scrollBeats must be >= 0', { field: 'scrollBeats' });
    }
    setScrollX(beats * BEAT_WIDTH * getZoomX());
  }

  if (p.scrollY !== undefined) {
    const y = Number(p.scrollY);
    setScrollY(Number.isFinite(y) && y > 0 ? y : 0);
  }

  if (p.mode !== undefined) {
    if (p.mode !== 'MIDI' && p.mode !== 'Pitch') {
      throw fail('VALIDATION_ERROR', 'mode must be "MIDI" or "Pitch"', { field: 'mode' });
    }
    const btn = document.getElementById(p.mode === 'Pitch' ? 'btn-param-Pitch' : 'btn-param-MIDI');
    if (btn && !btn.classList.contains('active')) btn.click();
  }

  if (p.paramLane !== undefined) {
    const allowed = ['VOL', 'PAN', 'Phoneme', 'Timbre'];
    if (!allowed.includes(p.paramLane)) {
      throw fail('VALIDATION_ERROR', `paramLane must be one of ${allowed.join(', ')}`, { field: 'paramLane' });
    }
    const tab = document.querySelector(`.param-lane-tab[data-lane="${p.paramLane}"]`);
    if (tab && !tab.classList.contains('active')) tab.click();
  }

  if (p.selectedNoteIds !== undefined) {
    if (!Array.isArray(p.selectedNoteIds)) {
      throw fail('VALIDATION_ERROR', 'selectedNoteIds must be an array', { field: 'selectedNoteIds' });
    }
    const notes = getNotes();
    const known = new Set(notes.map((n) => n.id));
    const unknown = p.selectedNoteIds.filter((id) => !known.has(id));
    if (unknown.length) {
      throw fail('NOT_FOUND', `Unknown note id(s): ${unknown.join(', ')}`, {
        field: 'selectedNoteIds',
        hint: known.size ? `known ids: ${[...known].slice(0, 12).join(', ')}${known.size > 12 ? ' …' : ''}` : 'fragment has no notes',
      });
    }
    setSelectedNoteIds(new Set(p.selectedNoteIds));
  }

  render();
  return getView();
}

async function execute(method, params = {}) {
  switch (method) {
    case 'editor.getView':
      return getView();
    case 'editor.setView':
      return setView(params);
    case 'capabilities':
      return { renderer: 'fragment_editor', methods: ['editor.getView', 'editor.setView'] };
    default:
      throw fail('UNKNOWN_METHOD', `Unknown method ${method} for the fragment editor`);
  }
}

export function registerEditorMcpAutomation() {
  if (!window.electronAPI?.onMcpAutomationRequest) return;
  window.electronAPI.onMcpAutomationRequest(async (m) => {
    try {
      window.electronAPI.sendMcpAutomationResponse({ id: m.id, ok: true, result: await execute(m.method, m.params) });
    } catch (e) {
      window.electronAPI.sendMcpAutomationResponse({
        id: m.id,
        ok: false,
        error: { code: e.code || 'INTERNAL', message: e.message || String(e), field: e.field, hint: e.hint },
      });
    }
  });
}
