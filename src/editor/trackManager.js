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

let _idCounter = 0;
function generateId() {
  return Date.now().toString(36) + (_idCounter++).toString(36) + Math.random().toString(36).substr(2, 5);
}

function _hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function createEnvelope(defaultValue = 1) {
  return {
    keyframes: [
      { time: 0, value: defaultValue, smoothness: 0 }
    ]
  };
}

function createSinger(data = {}) {
  const id = data.id ?? generateId();
  return {
    id,
    type: data.type ?? 'singer', // 'singer' | 'accompaniment'
    trackName: data.trackName ?? `轨道 ${id}`,
    singerName: data.singerName ?? `歌手 ${id}`,
    avatarPath: data.avatarPath ?? null,
    wavPath: data.wavPath ?? null,
    midiPath: data.midiPath ?? null,
    color: data.color ?? TRACK_COLORS[_hashCode(String(id)) % TRACK_COLORS.length],
    singerFilePath: data.singerFilePath ?? null,
    singerFileMissing: data.singerFileMissing ?? false,
    // Accompaniment track fields (only used when type === 'accompaniment')
    audioFilePath: data.audioFilePath ?? null,
    audioFileMissing: data.audioFileMissing ?? false,
    audioFileName: data.audioFileName ?? null,
    audioDuration: data.audioDuration ?? null,
    embeddedAudioData: data.embeddedAudioData ?? null,
    accompanimentStartTime: data.accompanimentStartTime ?? 0,
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
  const id = data.id ?? generateId();
  const envelopes = data.envelopes ?? {
    volume: createEnvelope(1),
    pan: createEnvelope(0),
  };
  return {
    id,
    singerId: data.singerId ?? null,
    startTime: data.startTime ?? 0,
    duration: data.duration ?? 4,
    name: data.name ?? `分片 ${id}`,
    color: data.color ?? TRACK_COLORS[_hashCode(String(data.singerId ?? id)) % TRACK_COLORS.length],
    notes: data.notes ?? [],
    envelopes,
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
    const defaultColor = singer ? singer.color : TRACK_COLORS[0];
    // 保留已存在的 color（如从 .sxsproj 加载时），否则使用歌手颜色
    const fragment = createFragment({ ...data, color: data.color ?? defaultColor });
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
  }

  getColors() {
    return TRACK_COLORS;
  }
}

export { TrackManager, TRACK_COLORS };
