import { TrackManager } from '../editor/trackManager.js';
import { HistoryManager } from '../editor/historyManager.js';
import { SINGER_ROW_HEIGHT, HEADER_HEIGHT } from './constants.js';

export const trackManager = new TrackManager();
export const history = new HistoryManager();

// 左侧歌手列表（DOM）与右侧分片时间轴（canvas）必须按同一套行高排版，
// 否则两者会逐行漂移：canvas 用 SINGER_ROW_HEIGHT 画行与做命中测试，
// DOM 侧若在 CSS 里写死另一个数值（历史上是 64px vs 80px），第 N 行就偏 16×N px，
// 滚动同步（singerListEl.scrollTop = fragmentScrollY）也跟着对不上。
// 这里把常量发布成 CSS 变量，index.css 只消费变量 —— 行高只有constants.js 一个真源。
if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.style.setProperty('--singer-row-height', `${SINGER_ROW_HEIGHT}px`);
  document.documentElement.style.setProperty('--timeline-header-height', `${HEADER_HEIGHT}px`);
}

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
  // 传输控件右侧的进度区（推理 / 模型加载共用）
  transportStatus: document.getElementById('transport-status'),
  transportStatusText: document.getElementById('transport-status-text'),
  transportProgress: document.getElementById('transport-progress'),
  transportProgressFill: document.getElementById('transport-progress-fill'),
  timeDisplay: document.getElementById('time-display'),
  bpmInput: document.getElementById('bpm-input'),
  timeSigNum: document.getElementById('time-sig-num'),
  timeSigDen: document.getElementById('time-sig-den'),
  autoShiftCheck: document.getElementById('auto-shift-check'),
  btnLoad: document.getElementById('btn-load'),
  btnExport: document.getElementById('btn-export'),
  btnExportLrc: document.getElementById('btn-export-lrc'),
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
