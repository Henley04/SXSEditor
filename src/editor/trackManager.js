/**
 * 轨道管理模块
 * 负责 Track、Singer、Fragment 的增删改查
 * Fragment(分片) 包含 midi、f0、vol、L/R 等完整歌唱数据
 *
 * 歌声后端（backend）：
 *   · { type: 'sxs' } —— 内置 SoulX-Singer 推理，缺省值；
 *   · { type: 'plugin', pluginId, kindId, voiceId, params } —— 第三方/自定义插件后端，
 *     由插件契约 v1（src/shared/pluginContract.js）的 trackKind 决定轨道形态。
 * 后端判定统一走本文件的 getSingerBackend() / isPluginTrack()，不要在各处手写
 * `singer.backend?.type === 'plugin'`，否则插件被删除后的兼容策略会散落得到处都是。
 */

/** 内置后端（缺省）。每次返回新对象，避免调用方共享引用后互相污染。 */
export function createBuiltinBackend() {
  return { type: 'sxs' };
}

/**
 * 规范化一个插件后端。pluginId/kindId 只做类型收敛，不做存在性校验 ——
 * 插件是否还装着要在拿到插件清单后才知道（见 renderer/pluginBackend.js），
 * 工程加载阶段缺插件只做标记，不改写 backend 本身。
 * @param {object} data
 * @returns {{type:'plugin', pluginId:string, kindId:string|null, voiceId:string|null, params:object}}
 */
export function createPluginBackend(data = {}) {
  const input = data || {};
  return {
    type: 'plugin',
    pluginId: typeof input.pluginId === 'string' ? input.pluginId : '',
    kindId: typeof input.kindId === 'string' ? input.kindId : null,
    voiceId: typeof input.voiceId === 'string' ? input.voiceId : null,
    params: input.params && typeof input.params === 'object' && !Array.isArray(input.params)
      ? { ...input.params }
      : {},
  };
}

/**
 * 把一个可能是任意来源（工程文件、IPC、旧数据）的 backend 收敛成合法形状。
 * 非法/缺失一律退回内置后端；type 不是 'plugin' 但确实是对象时原样保留，
 * 这样将来新增后端类型不会被静默降级成 sxs。
 * @param {unknown} backend
 */
export function normalizeBackend(backend) {
  if (!backend || typeof backend !== 'object' || Array.isArray(backend)) return createBuiltinBackend();
  if (backend.type === 'plugin') return createPluginBackend(backend);
  if (typeof backend.type !== 'string' || !backend.type) return createBuiltinBackend();
  return { ...backend };
}

/** 取轨道后端（一定返回对象，调用方无需判空）。 */
export function getSingerBackend(singer) {
  const backend = singer && singer.backend;
  if (backend && typeof backend === 'object') return backend;
  return createBuiltinBackend();
}

/** 是否插件后端。 */
export function isPluginTrack(singer) {
  return getSingerBackend(singer).type === 'plugin';
}

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
    accompanimentVolume: data.accompanimentVolume ?? 1,
    audioSampleRate: data.audioSampleRate ?? null,
    numberOfChannels: data.numberOfChannels ?? 1,
    // 'sxs' = 内置 SoulX-Singer 推理（缺省）；'plugin' = 第三方/自定义歌声后端
    backend: normalizeBackend(data.backend),
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
    // 汉字分组与音色/后处理曲线都是分片的持久化字段：createFragment 是显式
    // 白名单对象，漏登记的字段会在工程 load→addFragment 时被静默丢弃
    // （postprocess 丢失后编辑器回退全默认，首次自动保存还会把默认值写回）。
    kanjiGroups: data.kanjiGroups ?? [],
    postprocess: data.postprocess ?? null,
  };
}

class TrackManager {
  constructor() {
    this.singers = [];
    this.fragments = [];
    this.activeFragmentId = null;
    this.usedColorIndices = new Set();
    // id -> 对象 的索引。拖拽、播放、渲染等热路径每帧都会按 id 查找，
    // 原先的 Array.find 是 O(n)，这里降为 O(1)。
    // 所有增删都走 addSinger/removeSinger/addFragment/removeFragment/clearAll，
    // 索引可保证与数组同步。
    this._singerIndex = new Map();
    this._fragmentIndex = new Map();
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
    this._singerIndex.set(singer.id, singer);
    this.usedColorIndices.add(colorIdx);
    return singer;
  }

  removeSinger(singerId) {
    if (this.singers.length <= 1) return false;
    const idx = this.singers.findIndex(s => s.id === singerId);
    if (idx === -1) return false;
    this.singers.splice(idx, 1);
    this._singerIndex.delete(singerId);
    this.usedColorIndices.clear();
    this.singers.forEach(s => {
      const ci = TRACK_COLORS.indexOf(s.color);
      if (ci !== -1) this.usedColorIndices.add(ci);
    });
    return true;
  }

  getSinger(singerId) {
    return this._singerIndex.get(singerId) ?? null;
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
    this._fragmentIndex.set(fragment.id, fragment);
    return fragment;
  }

  removeFragment(fragmentId) {
    const idx = this.fragments.findIndex(f => f.id === fragmentId);
    if (idx === -1) return false;
    this.fragments.splice(idx, 1);
    this._fragmentIndex.delete(fragmentId);
    if (this.activeFragmentId === fragmentId) {
      this.activeFragmentId = this.fragments[0]?.id ?? null;
    }
    return true;
  }

  getFragment(fragmentId) {
    return this._fragmentIndex.get(fragmentId) ?? null;
  }

  getActiveFragment() {
    return this._fragmentIndex.get(this.activeFragmentId) ?? null;
  }

  setActiveFragment(fragmentId) {
    if (this._fragmentIndex.has(fragmentId)) {
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
    this._singerIndex.clear();
    this._fragmentIndex.clear();
    this.usedColorIndices.clear();
    this.activeFragmentId = null;
  }

  getColors() {
    return TRACK_COLORS;
  }
}

export { TrackManager, TRACK_COLORS, createSinger };
