import { state, dom, trackManager, history } from './state.js';
import {
  SINGER_ROW_HEIGHT,
  HEADER_HEIGHT,
} from './constants.js';
import { t } from '../i18n/index.js';
import { updateProjectSettings, saveProject, saveProjectAs, loadProject, showSingerSelectDialog } from './projectManager.js';
import { playAll, pausePlayback, stopPlayback, exportAll } from './audioPlayback.js';
import { formatTime } from './uiControls.js';
import { getBeatWidth, renderFragmentTimeline, syncFragmentScroll, refreshAll } from './timelineRenderer.js';
import { openFragmentEditor, finishDrag, handleAudioToMidi } from './fragmentOperations.js';

// BPM and time signature inputs
dom.bpmInput.addEventListener('change', () => {
  updateProjectSettings();
  refreshAll();
});
dom.timeSigNum.addEventListener('change', () => {
  updateProjectSettings();
  refreshAll();
});
dom.timeSigDen.addEventListener('change', () => {
  updateProjectSettings();
  refreshAll();
});

// Transport controls
dom.btnPlay.addEventListener('click', async () => {
  const fragments = trackManager.getFragments();
  if (fragments.length === 0) {
    const { showAlertDialog } = await import('../alertDialog.js');
    showAlertDialog(t('main.noFragmentsToPlay'));
    return;
  }
  if (state.isSynthesizing) {
    return;
  }
  await playAll();
});

dom.btnPause.addEventListener('click', () => {
  if (state.isPlaying) {
    pausePlayback();
  }
});

dom.btnStop.addEventListener('click', () => {
  stopPlayback();
  dom.timeDisplay.textContent = formatTime(0);
});

// Project save/load/export
// Save is triggered via menu (File → Save, Ctrl+S) or the menu-request IPC.
dom.btnLoad.addEventListener('click', async () => {
  await loadProject();
  refreshAll();
});

dom.btnExport.addEventListener('click', async () => {
  await exportAll();
});

// Add singer
dom.btnAddSinger.addEventListener('click', () => {
  showSingerSelectDialog(null);
});

// Audio to MIDI
dom.btnAudioToMidi.addEventListener('click', handleAudioToMidi);

// Fragment canvas mouse events
dom.fragmentCanvas.addEventListener('mousedown', (e) => {
  const rect = dom.fragmentCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const beatWidth = getBeatWidth();

  for (let i = 0; i < singers.length; i++) {
    const singerY = i * SINGER_ROW_HEIGHT + HEADER_HEIGHT;

    if (y >= singerY && y < singerY + SINGER_ROW_HEIGHT) {
      const singerId = singers[i].id;
      const singerFragments = fragments.filter(f => f.singerId === singerId);

      for (const fragment of singerFragments) {
        const fragX = fragment.startTime * beatWidth;
        const fragWidth = fragment.duration * beatWidth;

        if (x >= fragX - 4 && x <= fragX + 4) {
          state.dragState = { type: 'resize-left', fragment, startX: x, originalStart: fragment.startTime, originalDuration: fragment.duration };
          state.fragmentDragSnapshot = { startTime: fragment.startTime, duration: fragment.duration };
          return;
        }
        if (x >= fragX + fragWidth - 4 && x <= fragX + fragWidth + 4) {
          state.dragState = { type: 'resize-right', fragment, startX: x, originalStart: fragment.startTime, originalDuration: fragment.duration };
          state.fragmentDragSnapshot = { startTime: fragment.startTime, duration: fragment.duration };
          return;
        }
        if (x >= fragX && x <= fragX + fragWidth) {
          state.dragState = { type: 'move', fragment, startX: x, startY: y, originalStart: fragment.startTime, originalSingerId: fragment.singerId };
          state.fragmentDragSnapshot = { startTime: fragment.startTime, duration: fragment.duration, singerId: fragment.singerId };
          return;
        }
      }
    }
  }
});

dom.fragmentCanvas.addEventListener('mousemove', (e) => {
  if (!state.dragState) return;

  const rect = dom.fragmentCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const beatWidth = getBeatWidth();
  const dx = (x - state.dragState.startX) / beatWidth;

  if (state.dragState.type === 'move') {
    const newStart = Math.max(0, state.dragState.originalStart + dx);
    const updateData = { startTime: Math.round(newStart * 4) / 4 };

    // Check if mouse moved to another singer track row
    const singers = trackManager.getSingers();
    for (let i = 0; i < singers.length; i++) {
      const singerY = i * SINGER_ROW_HEIGHT + HEADER_HEIGHT;
      if (y >= singerY && y < singerY + SINGER_ROW_HEIGHT) {
        const targetSingerId = singers[i].id;
        if (targetSingerId !== state.dragState.fragment.singerId) {
          updateData.singerId = targetSingerId;
          updateData.color = singers[i].color;
        }
        break;
      }
    }

    trackManager.updateFragment(state.dragState.fragment.id, updateData);
  } else if (state.dragState.type === 'resize-right') {
    const newDuration = Math.max(0.25, state.dragState.originalDuration + dx);
    trackManager.updateFragment(state.dragState.fragment.id, { duration: Math.round(newDuration * 4) / 4 });
  } else if (state.dragState.type === 'resize-left') {
    const originalEnd = state.dragState.originalStart + state.dragState.originalDuration;
    const newStart = state.dragState.originalStart + dx;
    const alignedStart = Math.max(0, Math.round(newStart * 4) / 4);
    const newDuration = originalEnd - alignedStart;
    if (alignedStart >= 0 && newDuration >= 0.25) {
      trackManager.updateFragment(state.dragState.fragment.id, {
        startTime: alignedStart,
        duration: newDuration,
      });
    }
  }

  if (!state.renderPending) {
    state.renderPending = true;
    requestAnimationFrame(() => {
      renderFragmentTimeline();
      if (window.electronAPI?.updateFragmentBounds && state.dragState) {
        const frag = state.dragState.fragment;
        window.electronAPI.updateFragmentBounds(frag.id, {
          startTime: frag.startTime,
          duration: frag.duration,
        });
      }
      state.renderPending = false;
    });
  }
});

dom.fragmentCanvas.addEventListener('mouseup', finishDrag);
dom.fragmentCanvas.addEventListener('mouseleave', finishDrag);

dom.fragmentCanvas.addEventListener('dblclick', (e) => {
  const rect = dom.fragmentCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const beatWidth = getBeatWidth();

  for (let i = 0; i < singers.length; i++) {
    const singerY = i * SINGER_ROW_HEIGHT + HEADER_HEIGHT;

    if (y >= singerY && y < singerY + SINGER_ROW_HEIGHT) {
      const singerFragments = fragments.filter(f => f.singerId === singers[i].id);

      for (const fragment of singerFragments) {
        const fragX = fragment.startTime * beatWidth;
        const fragWidth = fragment.duration * beatWidth;

        if (x >= fragX && x <= fragX + fragWidth) {
          openFragmentEditor(fragment);
          return;
        }
      }
    }
  }
});

// Scroll events
dom.fragmentContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const containerRect = dom.fragmentContainer.getBoundingClientRect();
    const mouseXInContainer = e.clientX - containerRect.left;
    const beatWidth = getBeatWidth();
    const mouseBeats = (mouseXInContainer + state.fragmentScrollX) / beatWidth;

    const delta = e.deltaY > 0 ? 0.85 : 1.18;
    state.fragmentZoomX = Math.max(0.25, Math.min(4, state.fragmentZoomX * delta));

    const newBeatWidth = getBeatWidth();
    state.fragmentScrollX = mouseBeats * newBeatWidth - mouseXInContainer;
    renderFragmentTimeline();
  } else if (e.shiftKey) {
    state.fragmentScrollY += e.deltaY;
  } else {
    state.fragmentScrollX += e.deltaY;
  }
  syncFragmentScroll();
}, { passive: false });

dom.singerListEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.fragmentScrollY += e.deltaY;
  syncFragmentScroll();
}, { passive: false });

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    if (history.canUndo()) {
      history.undo();
      refreshAll();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey))) {
    e.preventDefault();
    if (history.canRedo()) {
      history.redo();
      refreshAll();
    }
    return;
  }
});

// Window beforeunload
window.addEventListener('beforeunload', () => {
  for (const cleanup of state._ipcCleanups) {
    try { cleanup(); } catch (_) {}
  }
  state._ipcCleanups.length = 0;
});

// Menu-driven save / save-as requests (sent from the main process File menu).
// The menu registers the Ctrl+S / Ctrl+Shift+S accelerators.
if (window.electronAPI?.onMainMenuSaveRequest) {
  const off1 = window.electronAPI.onMainMenuSaveRequest(() => { saveProject(); });
  if (state._ipcCleanups) state._ipcCleanups.push(off1);
}
if (window.electronAPI?.onMainMenuSaveAsRequest) {
  const off2 = window.electronAPI.onMainMenuSaveAsRequest(() => { saveProjectAs(); });
  if (state._ipcCleanups) state._ipcCleanups.push(off2);
}
