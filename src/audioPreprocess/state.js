const state = {
  wavFileBuffer: null,
  wavFileName: '',
  wavAudioBuffer: null,
  wavDuration: 0,
  singerName: '',
  singerColor: '#3498db',
  avatarImageData: null,
  avatarImageName: '',

  pianoRoll: null,
  isPlaying: false,
  audioContext: null,
  audioSource: null,
  playStartTime: 0,
  playStartOffset: 0,
  playbackRaf: null,

  f0Data: null,
  singerData: null,

  waveformScrollX: 0,
  waveformZoomX: 1,

  activeInlineInput: null,
  activeInlineEditNote: null,

  isResizing: false,

  // 提取参数（由 extractionOptions 管理）
  extractOptions: null,

  // 合成音试听
  synthPlaying: false,
  synthSources: [],
  synthContext: null,

  // 电平/削波检测结果（加载时计算）
  levelInfo: null,
};

// DOM element references (populated in initDomRefs)
const dom = {
  btnPlayPause: null,
  btnExtractF0: null,
  btnExtractF0BasicPitch: null,
  btnImportMidi: null,
  btnSave: null,
  btnBack: null,
  wavFileNameEl: null,
  midiInfoEl: null,
  waveformCanvas: null,
  midiCanvas: null,
  resizeHandle: null,
  waveformSection: null,
  mainContent: null,
  // 滚动条（底部水平 + 右侧垂直），允许用户用鼠标拖拽调整视图位置
  hscroll: null,
  hscrollThumb: null,
  vscroll: null,
  vscrollThumb: null,
  // 提取参数面板
  extractPanel: null,
  extractPanelBody: null,
  extractStatus: null,
  btnAudition: null,
  btnTogglePanel: null,
  presetSelect: null,
  thresholdSelect: null,
  smoothingSelect: null,
  quantizationSelect: null,
  rangeAuto: null,
  f0Min: null,
  f0Max: null,
  minNote: null,
  bpmAuto: null,
  bpmInput: null,
  normalizeCheck: null,
};

export function initDomRefs() {
  dom.btnPlayPause = document.getElementById('btn-play-pause');
  dom.btnExtractF0 = document.getElementById('btn-extract-f0');
  dom.btnExtractF0BasicPitch = document.getElementById('btn-extract-f0-basic-pitch');
  dom.btnImportMidi = document.getElementById('btn-import-midi');
  dom.btnSave = document.getElementById('btn-save');
  dom.btnBack = document.getElementById('btn-back');
  dom.wavFileNameEl = document.getElementById('wav-file-name');
  dom.midiInfoEl = document.getElementById('midi-info');
  dom.waveformCanvas = document.getElementById('waveform-canvas');
  dom.midiCanvas = document.getElementById('midi-canvas');
  dom.resizeHandle = document.getElementById('resize-handle');
  dom.waveformSection = document.getElementById('waveform-section');
  dom.mainContent = document.getElementById('main-content');
  dom.hscroll = document.getElementById('midi-hscroll');
  dom.hscrollThumb = document.getElementById('midi-hscroll-thumb');
  dom.vscroll = document.getElementById('midi-vscroll');
  dom.vscrollThumb = document.getElementById('midi-vscroll-thumb');
  dom.extractPanel = document.getElementById('extract-panel');
  dom.extractPanelBody = document.getElementById('extract-panel-body');
  dom.extractStatus = document.getElementById('extract-status');
  dom.btnAudition = document.getElementById('btn-audition');
  dom.btnTogglePanel = document.getElementById('btn-toggle-panel');
  dom.presetSelect = document.getElementById('preset-select');
  dom.thresholdSelect = document.getElementById('threshold-select');
  dom.smoothingSelect = document.getElementById('smoothing-select');
  dom.quantizationSelect = document.getElementById('quantization-select');
  dom.rangeAuto = document.getElementById('range-auto');
  dom.f0Min = document.getElementById('f0-min');
  dom.f0Max = document.getElementById('f0-max');
  dom.minNote = document.getElementById('min-note');
  dom.bpmAuto = document.getElementById('bpm-auto');
  dom.bpmInput = document.getElementById('bpm-input');
  dom.normalizeCheck = document.getElementById('normalize-check');
}

export { state, dom };
