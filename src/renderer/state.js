import { TrackManager } from '../editor/trackManager.js';
import { HistoryManager } from '../editor/historyManager.js';

export const trackManager = new TrackManager();
export const history = new HistoryManager();

export const state = {
  // Project
  project: { bpm: 120, timeSignature: [4, 4] },
  currentProjectFilePath: null,
  isDirty: false,

  // Audio
  audioContext: null,
  currentAudioSource: null,
  currentAudioBuffer: null,
  playbackStartTime: 0,
  playbackPauseOffset: 0,
  isPlaying: false,
  isSynthesizing: false,
  synthesisCancelled: false,
  playheadRaf: null,
  currentAudioData: null,
  currentAudioChannels: null,
  gainNode: null,
  useExclusiveMode: false,
  exclusivePlaybackRaf: null,
  audioSettings: null,
  pipelineInitialized: false,
  pipelineInitPromise: null,

  // 流式播放（主页面 Play All 启用 diffStepChunk 时使用）
  streamingSources: [],
  streamingFinished: false,

  // UI
  fragmentZoomX: 1,
  selectedSingerId: null,
  selectedFragmentId: null,
  editingTrackNameId: null,
  fragmentScrollX: 0,
  fragmentScrollY: 0,
  dragState: null,
  fragmentDragSnapshot: null,
  renderPending: false,
  _ipcCleanups: [],
};

export const dom = {
  btnPlay: document.getElementById('btn-play'),
  btnPause: document.getElementById('btn-pause'),
  btnStop: document.getElementById('btn-stop'),
  timeDisplay: document.getElementById('time-display'),
  bpmInput: document.getElementById('bpm-input'),
  timeSigNum: document.getElementById('time-sig-num'),
  timeSigDen: document.getElementById('time-sig-den'),
  autoShiftCheck: document.getElementById('auto-shift-check'),
  btnLoad: document.getElementById('btn-load'),
  btnExport: document.getElementById('btn-export'),
  btnAudioToMidi: document.getElementById('btn-audio-to-midi'),
  btnImportMidi: document.getElementById('btn-import-midi'),
  btnAddSinger: document.getElementById('btn-add-singer'),
  btnImportAccompaniment: document.getElementById('btn-import-accompaniment'),
  btnOpenSingerMarket: document.getElementById('btn-open-singer-market'),
  singerListEl: document.getElementById('singer-list'),
  fragmentCanvas: document.getElementById('fragment-canvas'),
  fragmentContainer: document.getElementById('fragment-canvas-container'),
  fragmentPlayheadCanvas: document.getElementById('fragment-playhead-canvas'),
  bpmDisplayBadge: document.getElementById('bpm-display-badge'),
  versionDisplay: document.getElementById('version-display'),
};
