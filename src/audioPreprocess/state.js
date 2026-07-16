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
}

export { state, dom };
