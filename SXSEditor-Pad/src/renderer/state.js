const state = {
  project: {
    bpm: 120,
    timeSigNum: 4,
    timeSigDen: 4,
    autoShift: true,
    fragments: [],
    singers: [],
  },
  playback: {
    isPlaying: false,
    position: 0,
    duration: 0,
  },
  ui: {
    selectedFragmentId: null,
    selectedSingerId: null,
    clipboard: null,
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
  },
  dom: {
    toolbar: null,
    singerList: null,
    fragmentCanvas: null,
    playheadCanvas: null,
    timeDisplay: null,
    bpmInput: null,
    versionDisplay: null,
  },
  dirty: false,
  projectFilePath: null,
};

export function getState() { return state; }
export function getProject() { return state.project; }
export function getPlayback() { return state.playback; }
export function getUI() { return state.ui; }
export function getDOM() { return state.dom; }

export function initDOM() {
  state.dom = {
    toolbar: document.getElementById('toolbar'),
    singerList: document.getElementById('singer-list'),
    fragmentCanvas: document.getElementById('fragment-canvas'),
    playheadCanvas: document.getElementById('fragment-playhead-canvas'),
    timeDisplay: document.getElementById('time-display'),
    bpmInput: document.getElementById('bpm-input'),
    versionDisplay: document.getElementById('version-display'),
    timeSigNum: document.getElementById('time-sig-num'),
    timeSigDen: document.getElementById('time-sig-den'),
    autoShiftCheck: document.getElementById('auto-shift-check'),
  };
}

export function markDirty() {
  state.dirty = true;
}

export function markClean() {
  state.dirty = false;
}

export function isDirty() {
  return state.dirty;
}

export function setProjectFilePath(path) {
  state.projectFilePath = path;
}

export function getProjectFilePath() {
  return state.projectFilePath;
}

export function setSelectedFragmentId(id) {
  state.ui.selectedFragmentId = id;
}

export function getSelectedFragmentId() {
  return state.ui.selectedFragmentId;
}

export function setSelectedSingerId(id) {
  state.ui.selectedSingerId = id;
}

export function getSelectedSingerId() {
  return state.ui.selectedSingerId;
}

export function setClipboard(clipboard) {
  state.ui.clipboard = clipboard;
}

export function getClipboard() {
  return state.ui.clipboard;
}

export function setScroll(x, y) {
  state.ui.scrollX = x;
  state.ui.scrollY = y;
}

export function setZoom(zoom) {
  state.ui.zoom = Math.max(0.1, Math.min(5, zoom));
}

export function getZoom() {
  return state.ui.zoom;
}

export function setPlaybackPosition(position) {
  state.playback.position = position;
}

export function setPlaybackPlaying(isPlaying) {
  state.playback.isPlaying = isPlaying;
}

export function setPlaybackDuration(duration) {
  state.playback.duration = duration;
}

export function setBpm(bpm) {
  state.project.bpm = Math.max(1, Math.min(999, bpm));
}

export function setTimeSig(num, den) {
  state.project.timeSigNum = num;
  state.project.timeSigDen = den;
}

export function setAutoShift(autoShift) {
  state.project.autoShift = autoShift;
}

export function getFragmentById(id) {
  return state.project.fragments.find(f => f.id === id) || null;
}

export function addFragment(fragment) {
  state.project.fragments.push(fragment);
  state.dirty = true;
}

export function removeFragmentById(id) {
  const idx = state.project.fragments.findIndex(f => f.id === id);
  if (idx !== -1) {
    state.project.fragments.splice(idx, 1);
    state.dirty = true;
  }
}

export function updateFragment(id, updates) {
  const fragment = getFragmentById(id);
  if (fragment) {
    Object.assign(fragment, updates);
    state.dirty = true;
  }
}