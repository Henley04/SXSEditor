import { PARAM_MODES } from './constants.js';

let SAMPLE_RATE = 24000;
let pipelineInitialized = false;
let pipelineInitPromise = null;

let fragmentAudioContext = null;
let fragmentAudioSource = null;
let fragmentAudioData = null;
let fragmentIsPlaying = false;
let fragmentIsSynthesizing = false;
let fragmentIsExporting = false;
let fragmentPlaybackStartTime = 0;
let fragmentPlaybackOffset = 0;
let fragmentPlayheadRaf = null;
let fragmentCurrentTime = 0;
let fragmentGainNode = null;
// 用户拖拽 playhead 设置的播放起始位置（秒）。
// playFragment 时从此位置开始播放；0 表示从头播放。
let fragmentPlayStartPosition = 0;
// 上一次合成时 notes 的签名（用于判断 fragmentAudioData 是否可复用）。
// 当 notes 发生变化时置 null，强制下次 playFragment 重新合成。
let fragmentAudioDataSignature = null;
let fragmentUseExclusiveMode = false;
let fragmentExclusiveRaf = null;
let fragmentAudioSettings = null;

let wavFileBuffer = null;

let currentFragment = null;
let currentProject = null;
let currentParamMode = PARAM_MODES.MIDI;
let notes = [];
// Snap grid for the fragmentEditor piano roll, in beats per grid cell.
// 1/4 = quarter note, 1/8 = eighth, 1/16 = sixteenth, 1/32 = thirty-second.
// Default is 1/16 (finer than the historical hard-coded 1/4) so resize/move
// snap matches audioPreprocess pianoRoll and respects user-selected grid.
let snapGrid = 1 / 16;
let kanjiGroups = [];
let envelopes = {
  volume: { keyframes: [{ time: 0, value: 1, smoothness: 0 }] },
  pan: { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
};
let pitchCurve = {
  enabled: true,
  anchorPoints: [],
  brushSegments: [],
};

let autoSaveTimer = null;

let selectedNoteIds = new Set();
let selectedAnchorIndices = new Set();
let dragMode = null;
let dragStartX = 0;
let dragStartY = 0;
let dragStartMouseTime = 0;
let dragStartMousePitch = 0;
let dragNoteStart = { start: 0, pitch: 0, duration: 0 };
let dragNoteStarts = new Map();
let scrollY = 0;
let scrollX = 0;
let nextNoteId = 1;
let zoomX = 1;

let isBoxSelecting = false;
let boxSelectStart = { x: 0, y: 0 };
let boxSelectEnd = { x: 0, y: 0 };

let pitchDragAnchorIdx = -1;
let pitchDragStartValue = 0;
let pitchDragStartTime = 0;
let pitchDragAnchorStarts = new Map();
let isBrushDrawing = false;
let currentBrushStroke = null;
let brushSmoothing = 30;

// 右键按住锚点拖动调节 smoothness 时的状态
// pitchSmoothDragAnchorStarts: Map<anchorIdx, { smoothness: number }>
let pitchSmoothDragAnchorStarts = new Map();
let pitchSmoothDragMoved = false;
let pitchSmoothDragRightClickPos = null; // { x, y } 屏幕坐标，用于触发 context menu
// 当前 context menu 关联的锚点索引（-1 = 无菜单）
let contextMenuAnchorIdx = -1;
let sortedAnchorPointsCache = null;
let sortedAnchorPointsCacheVersion = -1;
let pitchCurveVersion = 0;

let dragOperation = null;
let pitchCurveSnapshotBeforeDrag = null;
let envelopeSnapshotBeforeDrag = null;
let lyricEditOldValue = null;
let lyricEditNoteId = null;

let phonemeDragState = null;

let selectedPhonemeNoteId = null;
let selectedPhonemeIndex = -1;

let hoveredNoteId = null;

let paramEnvelopeDrag = null;

let activeInlineInput = null;
let activeInlineEditNote = null;

let paramPanelCollapsed = false;
let paramPanelMode = 'VOL'; // 'VOL' | 'PAN' | 'Phoneme' | 'Timbre'

let fragmentDataReceived = false;

// 缓存在 currentFragment 就绪前到达的 fragmentBoundsChanged，待 handleFragmentData 完成后回放
let pendingBoundsUpdate = null;

const phonemeCache = new Map();

const _ipcCleanups = [];

// ---- Getters/Setters ----

export function getSampleRate() { return SAMPLE_RATE; }
export function setSampleRate(v) { SAMPLE_RATE = v; }

export function getPipelineInitialized() { return pipelineInitialized; }
export function setPipelineInitialized(v) { pipelineInitialized = v; }

export function getPipelineInitPromise() { return pipelineInitPromise; }
export function setPipelineInitPromise(v) { pipelineInitPromise = v; }

export function getFragmentAudioContext() { return fragmentAudioContext; }
export function setFragmentAudioContext(v) { fragmentAudioContext = v; }

export function getFragmentAudioSource() { return fragmentAudioSource; }
export function setFragmentAudioSource(v) { fragmentAudioSource = v; }

export function getFragmentAudioData() { return fragmentAudioData; }
export function setFragmentAudioData(v) { fragmentAudioData = v; }

export function getFragmentIsPlaying() { return fragmentIsPlaying; }
export function setFragmentIsPlaying(v) { fragmentIsPlaying = v; }

export function getFragmentIsSynthesizing() { return fragmentIsSynthesizing; }
export function setFragmentIsSynthesizing(v) { fragmentIsSynthesizing = v; }

export function getFragmentIsExporting() { return fragmentIsExporting; }
export function setFragmentIsExporting(v) { fragmentIsExporting = v; }

export function getFragmentPlaybackStartTime() { return fragmentPlaybackStartTime; }
export function setFragmentPlaybackStartTime(v) { fragmentPlaybackStartTime = v; }

export function getFragmentPlaybackOffset() { return fragmentPlaybackOffset; }
export function setFragmentPlaybackOffset(v) { fragmentPlaybackOffset = v; }

export function getFragmentPlayheadRaf() { return fragmentPlayheadRaf; }
export function setFragmentPlayheadRaf(v) { fragmentPlayheadRaf = v; }

export function getFragmentCurrentTime() { return fragmentCurrentTime; }
export function setFragmentCurrentTime(v) { fragmentCurrentTime = v; }

export function getFragmentGainNode() { return fragmentGainNode; }
export function setFragmentGainNode(v) { fragmentGainNode = v; }

export function getFragmentPlayStartPosition() { return fragmentPlayStartPosition; }
export function setFragmentPlayStartPosition(v) { fragmentPlayStartPosition = v; }

export function getFragmentAudioDataSignature() { return fragmentAudioDataSignature; }
export function setFragmentAudioDataSignature(v) { fragmentAudioDataSignature = v; }

export function getFragmentUseExclusiveMode() { return fragmentUseExclusiveMode; }
export function setFragmentUseExclusiveMode(v) { fragmentUseExclusiveMode = v; }

export function getFragmentExclusiveRaf() { return fragmentExclusiveRaf; }
export function setFragmentExclusiveRaf(v) { fragmentExclusiveRaf = v; }

export function getFragmentAudioSettings() { return fragmentAudioSettings; }
export function setFragmentAudioSettings(v) { fragmentAudioSettings = v; }

export function getWavFileBuffer() { return wavFileBuffer; }
export function setWavFileBuffer(v) { wavFileBuffer = v; }

export function getCurrentFragment() { return currentFragment; }
export function setCurrentFragment(v) { currentFragment = v; }

export function getCurrentProject() { return currentProject; }
export function setCurrentProject(v) { currentProject = v; }

export function getCurrentParamMode() { return currentParamMode; }
export function setCurrentParamMode(v) { currentParamMode = v; }

export function getNotes() { return notes; }
export function setNotes(v) { notes = v; }

export function getSnapGrid() { return snapGrid; }
export function setSnapGrid(v) { snapGrid = v; }

export function getKanjiGroups() { return kanjiGroups; }
export function setKanjiGroups(v) { kanjiGroups = v; }

export function getEnvelopes() { return envelopes; }
export function setEnvelopes(v) { envelopes = v; }

export function getPitchCurve() { return pitchCurve; }
export function setPitchCurve(v) { pitchCurve = v; }

export function getAutoSaveTimer() { return autoSaveTimer; }
export function setAutoSaveTimer(v) { autoSaveTimer = v; }

export function getSelectedNoteIds() { return selectedNoteIds; }
export function setSelectedNoteIds(v) { selectedNoteIds = v; }

export function getSelectedAnchorIndices() { return selectedAnchorIndices; }
export function setSelectedAnchorIndices(v) { selectedAnchorIndices = v; }

export function getDragMode() { return dragMode; }
export function setDragMode(v) { dragMode = v; }

export function getDragStartX() { return dragStartX; }
export function setDragStartX(v) { dragStartX = v; }

export function getDragStartY() { return dragStartY; }
export function setDragStartY(v) { dragStartY = v; }

export function getDragStartMouseTime() { return dragStartMouseTime; }
export function setDragStartMouseTime(v) { dragStartMouseTime = v; }

export function getDragStartMousePitch() { return dragStartMousePitch; }
export function setDragStartMousePitch(v) { dragStartMousePitch = v; }

export function getDragNoteStart() { return dragNoteStart; }
export function setDragNoteStart(v) { dragNoteStart = v; }

export function getDragNoteStarts() { return dragNoteStarts; }
export function setDragNoteStarts(v) { dragNoteStarts = v; }

export function getScrollY() { return scrollY; }
export function setScrollY(v) { scrollY = v; }

export function getScrollX() { return scrollX; }
export function setScrollX(v) { scrollX = v; }

export function getNextNoteId() { return nextNoteId; }
export function setNextNoteId(v) { nextNoteId = v; }

export function getZoomX() { return zoomX; }
export function setZoomX(v) { zoomX = v; }

export function getIsBoxSelecting() { return isBoxSelecting; }
export function setIsBoxSelecting(v) { isBoxSelecting = v; }

export function getBoxSelectStart() { return boxSelectStart; }
export function setBoxSelectStart(v) { boxSelectStart = v; }

export function getBoxSelectEnd() { return boxSelectEnd; }
export function setBoxSelectEnd(v) { boxSelectEnd = v; }

export function getPitchDragAnchorIdx() { return pitchDragAnchorIdx; }
export function setPitchDragAnchorIdx(v) { pitchDragAnchorIdx = v; }

export function getPitchDragStartValue() { return pitchDragStartValue; }
export function setPitchDragStartValue(v) { pitchDragStartValue = v; }

export function getPitchDragStartTime() { return pitchDragStartTime; }
export function setPitchDragStartTime(v) { pitchDragStartTime = v; }

export function getPitchDragAnchorStarts() { return pitchDragAnchorStarts; }
export function setPitchDragAnchorStarts(v) { pitchDragAnchorStarts = v; }

export function getPitchSmoothDragAnchorStarts() { return pitchSmoothDragAnchorStarts; }
export function setPitchSmoothDragAnchorStarts(v) { pitchSmoothDragAnchorStarts = v; }

export function getPitchSmoothDragMoved() { return pitchSmoothDragMoved; }
export function setPitchSmoothDragMoved(v) { pitchSmoothDragMoved = v; }

export function getPitchSmoothDragRightClickPos() { return pitchSmoothDragRightClickPos; }
export function setPitchSmoothDragRightClickPos(v) { pitchSmoothDragRightClickPos = v; }

export function getContextMenuAnchorIdx() { return contextMenuAnchorIdx; }
export function setContextMenuAnchorIdx(v) { contextMenuAnchorIdx = v; }

export function getIsBrushDrawing() { return isBrushDrawing; }
export function setIsBrushDrawing(v) { isBrushDrawing = v; }

export function getCurrentBrushStroke() { return currentBrushStroke; }
export function setCurrentBrushStroke(v) { currentBrushStroke = v; }

export function getBrushSmoothing() { return brushSmoothing; }
export function setBrushSmoothing(v) { brushSmoothing = v; }

export function getSortedAnchorPointsCache() { return sortedAnchorPointsCache; }
export function setSortedAnchorPointsCache(v) { sortedAnchorPointsCache = v; }

export function getSortedAnchorPointsCacheVersion() { return sortedAnchorPointsCacheVersion; }
export function setSortedAnchorPointsCacheVersion(v) { sortedAnchorPointsCacheVersion = v; }

export function getPitchCurveVersion() { return pitchCurveVersion; }
export function setPitchCurveVersion(v) { pitchCurveVersion = v; }

export function getDragOperation() { return dragOperation; }
export function setDragOperation(v) { dragOperation = v; }

export function getPitchCurveSnapshotBeforeDrag() { return pitchCurveSnapshotBeforeDrag; }
export function setPitchCurveSnapshotBeforeDrag(v) { pitchCurveSnapshotBeforeDrag = v; }

export function getEnvelopeSnapshotBeforeDrag() { return envelopeSnapshotBeforeDrag; }
export function setEnvelopeSnapshotBeforeDrag(v) { envelopeSnapshotBeforeDrag = v; }

export function getLyricEditOldValue() { return lyricEditOldValue; }
export function setLyricEditOldValue(v) { lyricEditOldValue = v; }

export function getLyricEditNoteId() { return lyricEditNoteId; }
export function setLyricEditNoteId(v) { lyricEditNoteId = v; }

export function getPhonemeDragState() { return phonemeDragState; }
export function setPhonemeDragState(v) { phonemeDragState = v; }

export function getSelectedPhonemeNoteId() { return selectedPhonemeNoteId; }
export function setSelectedPhonemeNoteId(v) { selectedPhonemeNoteId = v; }

export function getSelectedPhonemeIndex() { return selectedPhonemeIndex; }
export function setSelectedPhonemeIndex(v) { selectedPhonemeIndex = v; }

export function getHoveredNoteId() { return hoveredNoteId; }
export function setHoveredNoteId(v) { hoveredNoteId = v; }

export function getParamEnvelopeDrag() { return paramEnvelopeDrag; }
export function setParamEnvelopeDrag(v) { paramEnvelopeDrag = v; }

export function getActiveInlineInput() { return activeInlineInput; }
export function setActiveInlineInput(v) { activeInlineInput = v; }

export function getActiveInlineEditNote() { return activeInlineEditNote; }
export function setActiveInlineEditNote(v) { activeInlineEditNote = v; }

export function getParamPanelCollapsed() { return paramPanelCollapsed; }
export function setParamPanelCollapsed(v) { paramPanelCollapsed = v; }

export function getParamPanelMode() { return paramPanelMode; }
export function setParamPanelMode(v) { paramPanelMode = v; }

export function getFragmentDataReceived() { return fragmentDataReceived; }
export function setFragmentDataReceived(v) { fragmentDataReceived = v; }

export function getPendingBoundsUpdate() { return pendingBoundsUpdate; }
export function setPendingBoundsUpdate(v) { pendingBoundsUpdate = v; }

export function getPhonemeCache() { return phonemeCache; }

export function getIpcCleanups() { return _ipcCleanups; }

export function invalidatePitchCurveCache() {
  pitchCurveVersion++;
}
