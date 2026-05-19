/**
 * 轨道管理模块
 * 负责 Track、Singer、Fragment 的增删改查
 * Fragment(分片) 包含 midi、f0、vol、L/R 等完整歌唱数据
 */

const TRACK_COLORS = [
  '#f87171', '#fb923c', '#fbbf24', '#4ade80',
  '#2dd4bf', '#5b8def', '#a78bfa', '#f472b6',
  '#22d3ee', '#86efac', '#fdba74', '#f97316',
];

let nextSingerId = 1;
let nextTrackId = 1;
let nextFragmentId = 1;

function createEnvelope(defaultValue = 1) {
  return {
    keyframes: [
      { time: 0, value: defaultValue, smoothness: 0 }
    ]
  };
}

function createSinger(data = {}) {
  const id = data.id ?? nextSingerId++;
  if (typeof data.id === 'number' && data.id >= nextSingerId) {
    nextSingerId = data.id + 1;
  }
  return {
    id,
    trackName: data.trackName ?? `轨道 ${id}`,
    singerName: data.singerName ?? `歌手 ${id}`,
    avatarPath: data.avatarPath ?? null,
    wavPath: data.wavPath ?? null,
    midiPath: data.midiPath ?? null,
    color: data.color ?? TRACK_COLORS[(id - 1) % TRACK_COLORS.length],
    singerFilePath: data.singerFilePath ?? null,
    singerFileMissing: data.singerFileMissing ?? false,
  };
}

function createPitchCurve() {
  return {
    enabled: true,
    anchorPoints: [],
    brushSegments: [],
  };
}

function createFragment(data = {}) {
  const id = data.id ?? nextFragmentId++;
  if (typeof data.id === 'number' && data.id >= nextFragmentId) {
    nextFragmentId = data.id + 1;
  }
  return {
    id,
    singerId: data.singerId ?? 1,
    startTime: data.startTime ?? 0,
    duration: data.duration ?? 4,
    name: data.name ?? `分片 ${id}`,
    color: data.color ?? TRACK_COLORS[(data.singerId - 1) % TRACK_COLORS.length],
    notes: data.notes ?? [],
    envelopes: {
      volume: data.volume ?? createEnvelope(1),
      pan: data.pan ?? createEnvelope(0),
    },
    pitchCurve: data.pitchCurve ?? createPitchCurve(),
  };
}

class TrackManager {
  constructor() {
    this.singers = [];
    this.fragments = [];
    this.activeFragmentId = null;
    this.usedColorIndices = new Set();
  }

  _getNextColorIndex() {
    for (let i = 0; i < TRACK_COLORS.length; i++) {
      if (!this.usedColorIndices.has(i)) return i;
    }
    return this.singers.length % TRACK_COLORS.length;
  }

  addSinger(data = {}) {
    const colorIdx = this._getNextColorIndex();
    const singer = createSinger({
      ...data,
      color: data.color ?? TRACK_COLORS[colorIdx],
    });
    this.singers.push(singer);
    this.usedColorIndices.add(colorIdx);
    return singer;
  }

  removeSinger(singerId) {
    if (this.singers.length <= 1) return false;
    const idx = this.singers.findIndex(s => s.id === singerId);
    if (idx === -1) return false;
    this.singers.splice(idx, 1);
    this.usedColorIndices.clear();
    this.singers.forEach(s => {
      const ci = TRACK_COLORS.indexOf(s.color);
      if (ci !== -1) this.usedColorIndices.add(ci);
    });
    return true;
  }

  getSinger(singerId) {
    return this.singers.find(s => s.id === singerId) ?? null;
  }

  updateSinger(singerId, data) {
    const singer = this.getSinger(singerId);
    if (!singer) return false;
    Object.assign(singer, data);
    return true;
  }

  getSingers() {
    return this.singers;
  }

  addFragment(data = {}) {
    const singer = this.getSinger(data.singerId);
    const color = singer ? singer.color : TRACK_COLORS[0];
    const fragment = createFragment({ ...data, color });
    this.fragments.push(fragment);
    return fragment;
  }

  removeFragment(fragmentId) {
    const idx = this.fragments.findIndex(f => f.id === fragmentId);
    if (idx === -1) return false;
    this.fragments.splice(idx, 1);
    if (this.activeFragmentId === fragmentId) {
      this.activeFragmentId = this.fragments[0]?.id ?? null;
    }
    return true;
  }

  getFragment(fragmentId) {
    return this.fragments.find(f => f.id === fragmentId) ?? null;
  }

  getActiveFragment() {
    return this.fragments.find(f => f.id === this.activeFragmentId) ?? null;
  }

  setActiveFragment(fragmentId) {
    if (this.fragments.some(f => f.id === fragmentId)) {
      this.activeFragmentId = fragmentId;
    }
  }

  updateFragment(fragmentId, data) {
    const fragment = this.getFragment(fragmentId);
    if (!fragment) return false;
    Object.assign(fragment, data);
    return true;
  }

  getFragments() {
    return this.fragments;
  }

  clearAll() {
    this.singers.length = 0;
    this.fragments.length = 0;
    this.usedColorIndices.clear();
    this.activeFragmentId = null;
    nextSingerId = 1;
    nextFragmentId = 1;
  }

  getColors() {
    return TRACK_COLORS;
  }
}

export { TrackManager, TRACK_COLORS };
