import { state, dom, trackManager, history } from './state.js';
import {
  SINGER_ROW_HEIGHT,
  HEADER_HEIGHT,
} from './constants.js';
import { t } from '../i18n/index.js';
import { updateProjectSettings, saveProject, saveProjectAs, loadProject, showSingerSelectDialog, markDirty } from './projectManager.js';
import { playAll, pausePlayback, stopPlayback, exportAll, getCurrentPlaybackSeconds, startAudioPlayback } from './audioPlayback.js';
import { formatTime } from './uiControls.js';
import { getBeatWidth, renderFragmentTimeline, syncFragmentScroll, refreshAll, playbackTimeToX, xToPlaybackTime, PLAYHEAD_HIT_WIDTH } from './timelineRenderer.js';
import { openFragmentEditor, finishDrag, handleAudioToMidi, handleImportMidi } from './fragmentOperations.js';
import { showConfirmDialog } from '../alertDialog.js';

// Click-vs-drag tracking for fragment selection
let _clickStartPos = null;
const CLICK_THRESHOLD = 3;

// Playhead drag state — 拖拽进度条时记录是否在拖拽 playhead
let _isPlayheadDragging = false;
// 拖拽开始时是否正在播放。mouseup 时若为 true，则从新位置恢复播放。
// 拖拽期间只更新视觉（不重启 source），避免每次 mousemove 重启播放导致卡顿。
let _wasPlayingBeforeDrag = false;
// Playhead tooltip 元素（懒创建）
let _playheadTooltip = null;

function _ensurePlayheadTooltip() {
  if (_playheadTooltip && document.body.contains(_playheadTooltip)) return _playheadTooltip;
  _playheadTooltip = document.createElement('div');
  _playheadTooltip.className = 'playhead-tooltip';
  _playheadTooltip.style.cssText = `
    position: fixed;
    z-index: 9999;
    padding: 4px 8px;
    background: var(--bg-tooltip, #1a1a2e);
    color: var(--fg-tooltip, #e0e0f0);
    border: 1px solid var(--border-tooltip, #3a3a5a);
    border-radius: 3px;
    font-size: 11px;
    font-family: sans-serif;
    pointer-events: none;
    white-space: nowrap;
    box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    display: none;
  `;
  document.body.appendChild(_playheadTooltip);
  return _playheadTooltip;
}

function _showPlayheadTooltip(clientX, clientY, seconds) {
  const tip = _ensurePlayheadTooltip();
  tip.textContent = formatTime(seconds) + ' · ' + t('main.dragToSeek');
  tip.style.left = (clientX + 12) + 'px';
  tip.style.top = (clientY + 12) + 'px';
  tip.style.display = 'block';
}

function _hidePlayheadTooltip() {
  if (_playheadTooltip) _playheadTooltip.style.display = 'none';
}

/**
 * 计算当前播放头在 fragment canvas 内部坐标系下的 X。
 * 播放中：实时计算；未播放：使用 playbackPauseOffset。
 */
function _getCurrentPlayheadX() {
  return playbackTimeToX(getCurrentPlaybackSeconds());
}

/**
 * 把鼠标事件的 clientX 转换为 fragment canvas 内部 X 坐标。
 * 因为 fragment-canvas 自身有 translate(-scrollX, -scrollY) 变换，
 * getBoundingClientRect() 已反映了变换后的位置，所以 clientX-rect.left
 * 直接就是 canvas 内部坐标。
 */
function _mouseToCanvasX(e) {
  const rect = dom.fragmentCanvas.getBoundingClientRect();
  return e.clientX - rect.left;
}

function _mouseToCanvasY(e) {
  const rect = dom.fragmentCanvas.getBoundingClientRect();
  return e.clientY - rect.top;
}

/**
 * 把 canvas 内部 X 坐标转换为可播放的秒数，并截断到 [0, duration]。
 */
function _canvasXToClampedSeconds(x) {
  const seconds = xToPlaybackTime(x);
  const audioData = state.currentAudioData;
  if (!audioData || audioData.length === 0) {
    return Math.max(0, seconds);
  }
  const duration = audioData.length / 24000; // SAMPLE_RATE
  return Math.max(0, Math.min(duration - 0.001, seconds));
}

/**
 * 拖拽期间只更新视觉（不重启 source）。
 * 更新 state.playbackPauseOffset（作为 mouseup 后恢复播放的起点）、
 * 绘制暂停态 playhead、更新时间显示。
 */
function _updatePlayheadVisual(seconds) {
  state.playbackPauseOffset = seconds;
  drawPausedPlayheadAt(seconds);
  dom.timeDisplay.textContent = formatTime(seconds);
}

/**
 * 结束拖拽：若拖拽前正在播放，从当前位置恢复播放。
 */
function _endPlayheadDrag() {
  if (!_isPlayheadDragging) return;
  _isPlayheadDragging = false;
  _hidePlayheadTooltip();
  if (_wasPlayingBeforeDrag) {
    _wasPlayingBeforeDrag = false;
    startAudioPlayback(state.playbackPauseOffset);
  }
}

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
  if (state.isPlaying || state.isSynthesizing) {
    return;
  }
  // 已有缓存的合成音频：从暂停位置恢复播放（无需重新合成）。
  // stopPlayback / 自然结束时 currentAudioData 会被置 null，下次点击 Play 会重新合成。
  if (state.currentAudioData && state.currentAudioData.length > 0) {
    await startAudioPlayback(state.playbackPauseOffset);
  } else {
    await playAll();
  }
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

// Import MIDI file (multi-track → one singer per track)
dom.btnImportMidi.addEventListener('click', handleImportMidi);

// Fragment canvas mouse events
dom.fragmentCanvas.addEventListener('mousedown', (e) => {
  const rect = dom.fragmentCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const beatWidth = getBeatWidth();

  // Record click position for click-vs-drag detection
  _clickStartPos = { x: e.clientX, y: e.clientY };

  // 左键点击播放头三角形手柄或 header 区域 → 开始拖拽设置/跳转播放位置
  // 优先级高于分片拖拽，避免 playhead 卡在分片边缘时无法拖动
  // 拖拽期间只更新视觉（不重启 source），mouseup 时若之前在播放则恢复播放。
  if (e.button === 0) {
    const canvasH = dom.fragmentCanvas.clientHeight;
    const playheadX = _getCurrentPlayheadX();
    const onPlayhead = Math.abs(x - playheadX) <= PLAYHEAD_HIT_WIDTH / 2
      && (state.playbackPauseOffset > 0 || state.isPlaying || state.currentAudioData);
    const onHeader = y <= HEADER_HEIGHT;
    if (onPlayhead || onHeader) {
      const newSeconds = _canvasXToClampedSeconds(x);
      if (state.isPlaying) {
        _wasPlayingBeforeDrag = true;
        pausePlayback();
      } else {
        _wasPlayingBeforeDrag = false;
      }
      _isPlayheadDragging = true;
      _updatePlayheadVisual(newSeconds);
      _hidePlayheadTooltip();
      return;
    }
  }

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

  // Clicked on empty area → deselect fragment
  state.selectedFragmentId = null;
  renderFragmentTimeline();
});

dom.fragmentCanvas.addEventListener('mousemove', (e) => {
  // 拖拽 playhead 优先级最高：只更新视觉（不重启 source，避免卡顿）
  if (_isPlayheadDragging) {
    const x = _mouseToCanvasX(e);
    const newSeconds = _canvasXToClampedSeconds(x);
    _updatePlayheadVisual(newSeconds);
    return;
  }

  if (!state.dragState) {
    // 鼠标悬停在 playhead 上时：显示 ew-resize 光标 + 时间 tooltip
    const rect = dom.fragmentCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const canvasH = dom.fragmentCanvas.clientHeight;
    const playheadX = _getCurrentPlayheadX();
    const onPlayhead = Math.abs(x - playheadX) <= PLAYHEAD_HIT_WIDTH / 2
      && (state.playbackPauseOffset > 0 || state.isPlaying || state.currentAudioData);
    const onHeader = y <= HEADER_HEIGHT;
    if (onPlayhead || onHeader) {
      dom.fragmentCanvas.style.cursor = 'ew-resize';
      const tipSeconds = _canvasXToClampedSeconds(x);
      _showPlayheadTooltip(e.clientX, e.clientY, tipSeconds);
      return;
    } else {
      dom.fragmentCanvas.style.cursor = 'default';
      _hidePlayheadTooltip();
    }
    return;
  }

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

dom.fragmentCanvas.addEventListener('mouseup', (e) => {
  // 结束 playhead 拖拽：若拖拽前正在播放，从新位置恢复播放
  if (_isPlayheadDragging) {
    _endPlayheadDrag();
    return;
  }

  // Check if this was a click (no significant movement) vs drag
  if (_clickStartPos && state.dragState) {
    const dx = e.clientX - _clickStartPos.x;
    const dy = e.clientY - _clickStartPos.y;
    if (Math.abs(dx) < CLICK_THRESHOLD && Math.abs(dy) < CLICK_THRESHOLD) {
      // It's a click — select the fragment
      const fragment = state.dragState.fragment;
      state.selectedFragmentId = fragment.id;
      state.dragState = null;
      state.fragmentDragSnapshot = null;
      _clickStartPos = null;
      renderFragmentTimeline();
      return;
    }
  }
  _clickStartPos = null;
  finishDrag();
});
dom.fragmentCanvas.addEventListener('mouseleave', () => {
  _clickStartPos = null;
  _endPlayheadDrag();
  finishDrag();
});

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

dom.fragmentCanvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
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
          // Select the fragment first
          state.selectedFragmentId = fragment.id;
          renderFragmentTimeline();

          // Show context menu
          showFragmentContextMenu(e.clientX, e.clientY, fragment);
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
    state.fragmentScrollX += e.deltaY;
  } else {
    state.fragmentScrollY += e.deltaY;
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

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selectedFragmentId) {
      e.preventDefault();
      deleteSelectedFragment();
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

// ---- Fragment context menu ----
let _fragmentCtxMenu = null;

function hideFragmentContextMenu() {
  if (_fragmentCtxMenu) {
    _fragmentCtxMenu.remove();
    _fragmentCtxMenu = null;
  }
}

function showFragmentContextMenu(clientX, clientY, fragment) {
  hideFragmentContextMenu();

  const menu = document.createElement('div');
  menu.className = 'fragment-ctx-menu';
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';

  const deleteItem = document.createElement('div');
  deleteItem.className = 'fragment-ctx-item fragment-ctx-danger';
  deleteItem.textContent = t('main.deleteFragment');
  deleteItem.addEventListener('click', async () => {
    hideFragmentContextMenu();
    if (await showConfirmDialog(t('main.confirmDeleteFragment', { name: fragment.name }))) {
      deleteSelectedFragment();
    }
  });

  menu.appendChild(deleteItem);
  document.body.appendChild(menu);
  _fragmentCtxMenu = menu;

  // Close on click outside
  const closeHandler = (e) => {
    if (!menu.contains(e.target)) {
      hideFragmentContextMenu();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

// ---- Fragment deletion ----
async function deleteSelectedFragment() {
  const fragmentId = state.selectedFragmentId;
  if (!fragmentId) return;
  const fragment = trackManager.getFragment(fragmentId);
  if (!fragment) return;

  // Close fragment editor window if open
  if (window.electronAPI?.closeFragmentEditor) {
    window.electronAPI.closeFragmentEditor(fragmentId);
  }

  const fragmentClone = JSON.parse(JSON.stringify(fragment));
  const idx = trackManager.getFragments().findIndex(f => f.id === fragmentId);
  if (idx === -1) return;

  trackManager.removeFragment(fragmentId);
  state.selectedFragmentId = null;

  history.push({
    undo() {
      trackManager.addFragment(fragmentClone);
      // Re-insert at the original position
      const frags = trackManager.getFragments();
      const added = frags.pop();
      frags.splice(idx, 0, added);
      refreshAll();
    },
    redo() {
      trackManager.removeFragment(fragmentId);
      if (state.selectedFragmentId === fragmentId) {
        state.selectedFragmentId = null;
      }
      refreshAll();
    }
  });

  markDirty();
  refreshAll();
}
