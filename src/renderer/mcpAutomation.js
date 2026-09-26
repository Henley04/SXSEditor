import { state, trackManager, history } from './state.js';
import { SAMPLE_RATE } from './constants.js';
import { markDirty, markClean, loadAccompanimentFile, addSingerFromFile, serializeProject, saveProject, saveProjectAs, loadProject } from './projectManager.js';
import { refreshAll } from './timelineRenderer.js';
import { openFragmentEditor } from './fragmentOperations.js';
import { buildFragmentPitchCurveF0 } from './f0Utils.js';
import { buildProjectLrc, exportProjectLrc } from './lrcExport.js';
import {
  playAll, pausePlayback, stopPlayback, seekPlayback, exportAll, runExportJob,
  getCurrentPlaybackSeconds, ensurePipelineInitialized, loadAudioSettings,
  getExportInferenceOptions,
} from './audioPlayback.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;

function snapshot() {
  return {
    schemaVersion: '1.0',
    project: clone(state.project),
    singers: clone(trackManager.getSingers().map(s => {
      const x = { ...s };
      for (const k of ['wavBuffer', 'audioBuffer', 'audioChannels', 'analysisMono', 'f0Data', 'midiNotes']) delete x[k];
      return x;
    })),
    fragments: clone(trackManager.getFragments()),
    selection: { singerId: state.selectedSingerId, fragmentId: state.selectedFragmentId },
    filePath: state.currentProjectFilePath,
    isDirty: state.isDirty,
  };
}

function note(n, i = 0) {
  const pitch = Math.round(num(n.pitch, 60));
  const start = num(n.start);
  const duration = num(n.duration, 0.25);
  if (pitch < 0 || pitch > 127 || start < 0 || duration <= 0) throw new Error(`Invalid note ${i}`);
  return { ...n, id: n.id ?? `mcp-note-${Date.now()}-${i}`, pitch, start, duration, lyric: String(n.lyric ?? 'la') };
}

function fragment(f) {
  if (!f || typeof f !== 'object') throw new Error('fragment must be an object');
  const duration = num(f.duration, 4);
  if (duration <= 0) throw new Error('duration must be positive');
  return {
    ...f,
    startTime: Math.max(0, num(f.startTime)),
    duration,
    notes: Array.isArray(f.notes) ? f.notes.map(note) : [],
  };
}

async function authorize(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const r = await window.electronAPI.authorizePath(i > 0 ? path.slice(0, i) : path);
  if (!r?.success) throw new Error(r?.error || 'Path not authorized');
}

function apply(ops) {
  if (!Array.isArray(ops)) throw new Error('operations must be an array');
  const out = [];
  for (const op of ops) {
    switch (op.op) {
      case 'set_project':
        state.project = { ...state.project, ...op.value };
        out.push(state.project);
        break;
      case 'add_singer':
        out.push(trackManager.addSinger(op.value || {}));
        break;
      case 'update_singer':
        if (!trackManager.updateSinger(op.id, op.value || {})) throw new Error(`Unknown singer ${op.id}`);
        out.push(trackManager.getSinger(op.id));
        break;
      case 'remove_singer':
        if (!trackManager.removeSinger(op.id)) throw new Error(`Unable to remove singer ${op.id}`);
        out.push({ removed: op.id });
        break;
      case 'add_fragment':
        out.push(trackManager.addFragment(fragment(op.value || {})));
        break;
      case 'update_fragment':
        if (!trackManager.updateFragment(op.id, op.value || {})) throw new Error(`Unknown fragment ${op.id}`);
        out.push(trackManager.getFragment(op.id));
        break;
      case 'remove_fragment':
        if (!trackManager.removeFragment(op.id)) throw new Error(`Unknown fragment ${op.id}`);
        out.push({ removed: op.id });
        break;
      case 'replace_notes': {
        const f = trackManager.getFragment(op.fragmentId);
        if (!f) throw new Error(`Unknown fragment ${op.fragmentId}`);
        f.notes = (op.notes || []).map(note);
        out.push({ fragmentId: f.id, noteCount: f.notes.length });
        break;
      }
      case 'set_selection':
        if (op.singerId !== undefined) state.selectedSingerId = op.singerId;
        if (op.fragmentId !== undefined) state.selectedFragmentId = op.fragmentId;
        break;
      case 'clear_project':
        trackManager.clearAll();
        state.project = { bpm: 120, timeSignature: [4, 4] };
        break;
      default:
        throw new Error(`Unsupported operation ${op.op}`);
    }
  }
  markDirty();
  refreshAll();
  return out;
}

function replace(doc) {
  if (!doc || !Array.isArray(doc.singers) || !Array.isArray(doc.fragments)) throw new Error('Project requires singers and fragments');
  trackManager.clearAll();
  state.project = { bpm: 120, timeSignature: [4, 4], ...(doc.project || {}) };
  doc.singers.forEach(s => trackManager.addSinger(s));
  doc.fragments.forEach(f => trackManager.addFragment(fragment(f)));
  history.clear();
  markDirty();
  refreshAll();
  return snapshot();
}

function importMidi(p) {
  if (p.projectInfo && p.applyProjectInfo !== false) {
    if (p.projectInfo.bpm > 0) state.project.bpm = p.projectInfo.bpm;
    if (Array.isArray(p.projectInfo.timeSignature)) state.project.timeSignature = p.projectInfo.timeSignature;
  }
  const created = [];
  (p.tracks || []).forEach((t, i) => {
    if (!t.notes?.length) return;
    let s = p.singerId && trackManager.getSinger(p.singerId);
    if (!s || p.createTracks !== false) {
      s = trackManager.addSinger({ trackName: t.name || `MIDI ${i + 1}`, singerName: p.singerName || t.name || `Singer ${i + 1}` });
    }
    const notes = t.notes.map(note);
    const first = Math.min(...notes.map(n => n.start));
    const last = Math.max(...notes.map(n => n.start + n.duration));
    const f = trackManager.addFragment({
      singerId: s.id,
      name: t.name || `MIDI ${i + 1}`,
      startTime: num(p.startTime) + first,
      duration: last - first,
      notes: notes.map(n => ({ ...n, start: n.start - first })),
    });
    created.push({ singerId: s.id, fragmentId: f.id, noteCount: f.notes.length });
  });
  markDirty();
  refreshAll();
  return { created, project: snapshot() };
}

// 与 GUI "音频转 MIDI" 对齐：根据全局设置选择 RMVPE / FCPE / Basic Pitch 提取。
// 返回的 notes 为 {pitch,start,duration,lyric} 数组（相对音频起点，单位拍），
// f0 为可选音高数组（浮点数列表）。
async function extractMidiFromAudio(p) {
  if (!p.path) throw new Error('path is required');
  await authorize(p.path);
  const raw = await window.electronAPI.readFileBuffer(p.path);
  const ac = new AudioContext();
  let audioBuffer;
  try {
    audioBuffer = await ac.decodeAudioData(raw.slice(0));
  } catch (decodeErr) {
    throw new Error(`Audio decode failed: ${decodeErr.message}`);
  } finally {
    ac.close();
  }
  const audioData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const bpm = num(p.bpm) > 0 ? num(p.bpm) : (state.project?.bpm || 120);
  const extractPitch = p.withPitch !== false;
  const settings = await window.electronAPI.getSettings();
  const midiTool = (settings?.midiExtractTool === 'rosvot' ? 'rmvpe' : settings?.midiExtractTool) || 'fcpe';
  const mapNotes = (list) => (list || []).map((n) => ({
    pitch: Math.round(num(n.pitch, 60)),
    start: num(n.start),
    duration: num(n.duration, 0.25),
    lyric: n.lyric || 'la',
  }));
  let notes = [];
  let f0 = null;
  if (midiTool === 'rmvpe') {
    const r = await window.electronAPI.extractMidiRosvot({ audioData, sampleRate, bpm });
    if (!r.success) throw new Error(r.error || 'RMVPE failed');
    notes = mapNotes(r.notes);
    if (extractPitch) f0 = r.f0Array;
  } else if (midiTool === 'fcpe') {
    const fcpeOpts = settings ? {
      threshold: { low: 0.003, mid: 0.006, high: 0.01 }[settings.fcpeThreshold] || 0.006,
      thresholdEnabled: true,
      f0Min: settings.fcpeF0Min ?? 80,
      f0Max: settings.fcpeF0Max ?? 880,
      f0RangeAuto: settings.fcpeF0RangeAuto !== false,
      smoothing: settings.fcpeSmoothing || 'medium',
      quantization: settings.fcpeQuantization || 'strict',
      minNoteDuration: settings.fcpeMinNoteDuration ?? 0.05,
      normalize: settings.fcpeNormalize !== false,
    } : undefined;
    const r = await window.electronAPI.extractMidiFcpe({ audioData, sampleRate, bpm, options: fcpeOpts });
    if (!r.success) throw new Error(r.error || 'FCPE failed');
    notes = mapNotes(r.notes);
    if (extractPitch) f0 = r.f0Array;
  } else {
    const r = await window.electronAPI.extractF0BasicPitch({ audioData, sampleRate, bpm });
    if (!r.success) throw new Error(r.error || 'Basic Pitch failed');
    notes = mapNotes(r.notes);
    if (extractPitch) {
      const f0r = await window.electronAPI.extractF0({ audioData, sampleRate });
      if (!f0r.success) throw new Error(f0r.error || 'RMVPE failed');
      f0 = f0r.f0Array;
    }
  }
  return {
    tool: midiTool,
    bpm,
    sampleRate,
    duration: audioBuffer.duration,
    notes,
    f0: f0 ? Array.from(f0) : null,
  };
}

// 单片段导出：与 runExportJob 的单分片逻辑一致（clippedNotes + pitchCurve + 导出参数），
// 合成后直接编码为 WAV 写入目标路径。
async function exportFragmentTo(p) {
  if (!p.path) throw new Error('path is required');
  const f = trackManager.getFragment(p.fragmentId);
  if (!f) throw new Error(`Unknown fragment ${p.fragmentId}`);
  const singer = trackManager.getSinger(f.singerId);
  if (!singer) throw new Error(`Unknown singer ${f.singerId}`);
  await ensurePipelineInitialized();
  await loadAudioSettings();
  const o = { ...getExportInferenceOptions(), ...(p.options || {}) };
  const fragDuration = f.duration;
  const clippedNotes = [];
  for (const n0 of (f.notes || [])) {
    if (n0.start >= fragDuration) continue;
    const noteEnd = n0.start + n0.duration;
    clippedNotes.push(noteEnd > fragDuration ? { ...n0, duration: fragDuration - n0.start } : n0);
  }
  if (clippedNotes.length === 0) throw new Error('Fragment has no notes');
  const pitchCurveF0 = buildFragmentPitchCurveF0(f, clippedNotes, state.project.bpm);
  const audioData = await window.electronAPI.synthesizeSVS({
    notes: clippedNotes,
    bpm: state.project.bpm,
    options: {
      refAudioWavBuffer: singer?.wavBuffer || null,
      refMidiNotes: singer?.midiNotes || null,
      refF0Data: singer?.f0Data || null,
      singerId: singer?.id || null,
      pitchCurveF0,
      autoShift: !!o.autoShift,
      smartSegmentation: o.smartSegmentation,
      nSteps: o.nSteps,
      cfg: o.cfg,
      cfgRescale: o.cfgRescale,
      sampler: o.sampler,
      // Q-Drift：MCP 显式传 qdrift 时才启用（未传 = 关闭，避免自动化脚本静默改变采样合约）
      qdrift: o.qdrift === true,
      cfgScheduleMode: o.cfgScheduleMode,
      cfgStrengthStart: o.cfgStrengthStart,
      cfgScheduleKeyframes: o.cfgScheduleKeyframes,
      dynamicThresholdEnabled: o.dynamicThresholdEnabled,
      dynamicThresholdPercentile: o.dynamicThresholdPercentile,
    },
  });
  const { encodeWav } = require('../audio/wavEncoder.js');
  const sr = p.options?.sampleRate || 24000;
  const wav = encodeWav(audioData, sr, 1);
  await authorize(p.path);
  const saved = await window.electronAPI.saveFile(p.path, wav);
  if (!saved?.success) throw new Error(saved?.error || 'Export failed');
  return { path: p.path, sampleRate: sr, duration: audioData.length / sr };
}

async function execute(m, p = {}) {
  switch (m) {
    case 'capabilities':
      return {
        methods: [
          'project.get', 'project.apply', 'project.replace', 'project.validate',
          'project.saveTo', 'project.loadFrom',
          'midi.importFile', 'audio.extractMidi',
          'accompaniment.import', 'singer.import',
          'history.undo', 'history.redo',
          'fragment.open', 'fragment.exportTo',
          'playback.play', 'playback.pause', 'playback.stop', 'playback.seek', 'playback.get',
          'audio.export', 'audio.exportTo', 'lrc.export', 'lrc.exportTo',
          'settings.get', 'settings.update', 'ui.open',
        ],
      };
    case 'project.get':
      return snapshot();
    case 'project.validate': {
      const d = p.project || snapshot();
      const errors = [];
      if (!d.project || num(d.project.bpm) <= 0) errors.push('project.bpm must be positive');
      if (!Array.isArray(d.singers)) errors.push('singers must be an array');
      if (!Array.isArray(d.fragments)) errors.push('fragments must be an array');
      return { valid: !errors.length, errors };
    }
    case 'project.apply':
      return { results: apply(p.operations), project: snapshot() };
    case 'project.replace':
      return replace(p.project);
    case 'midi.importParsed':
      return importMidi(p);
    case 'audio.extractMidi':
      return extractMidiFromAudio(p);
    case 'accompaniment.import': {
      await authorize(p.path);
      const b = await window.electronAPI.readFileBuffer(p.path);
      const s = trackManager.addSinger({
        type: 'accompaniment',
        trackName: p.name || 'Accompaniment',
        singerName: p.name || 'Accompaniment',
        audioFilePath: p.path,
        accompanimentStartTime: num(p.startTime),
        accompanimentVolume: num(p.volume, 1),
      });
      await loadAccompanimentFile(s.id, b, p.path);
      markDirty();
      refreshAll();
      return clone(s);
    }
    case 'singer.import':
      await authorize(p.path);
      await addSingerFromFile(await window.electronAPI.readFileBuffer(p.path), p.path);
      markDirty();
      refreshAll();
      return snapshot();
    case 'history.undo':
      history.undo();
      refreshAll();
      return { canUndo: history.canUndo(), canRedo: history.canRedo() };
    case 'history.redo':
      history.redo();
      refreshAll();
      return { canUndo: history.canUndo(), canRedo: history.canRedo() };
    case 'fragment.open': {
      const f = trackManager.getFragment(p.fragmentId);
      if (!f) throw new Error('Unknown fragment');
      openFragmentEditor(f);
      return { opened: f.id };
    }
    case 'fragment.exportTo':
      return exportFragmentTo(p);
    case 'playback.play':
      await playAll();
      return { playing: true };
    case 'playback.pause':
      pausePlayback();
      return { paused: true };
    case 'playback.stop':
      stopPlayback();
      return { playing: false };
    case 'playback.seek':
      await seekPlayback(Math.max(0, num(p.seconds)));
      return { seconds: p.seconds };
    case 'playback.get': {
      const position = getCurrentPlaybackSeconds();
      const duration = state.currentAudioData?.length ? state.currentAudioData.length / SAMPLE_RATE : 0;
      return {
        playing: !!state.isPlaying,
        position: Math.max(0, position),
        duration: Math.max(0, duration),
        synthesizing: !!state.isSynthesizing,
        streaming: (state.streamingSources?.length ?? 0) > 0,
      };
    }
    case 'project.save':
      await saveProject();
      return { path: state.currentProjectFilePath };
    case 'project.saveAs':
      await saveProjectAs();
      return { path: state.currentProjectFilePath };
    case 'project.load':
      await loadProject();
      return snapshot();
    case 'project.saveTo': {
      await authorize(p.path);
      const r = await window.electronAPI.saveFile(p.path, await serializeProject(!!p.embedSingerFiles, !!p.embedAccompanimentAudio));
      if (!r?.success) throw new Error(r?.error || 'Save failed');
      state.currentProjectFilePath = p.path;
      markClean();
      return { path: p.path };
    }
    case 'project.loadFrom': {
      await authorize(p.path);
      const r = replace(JSON.parse(await window.electronAPI.readFile(p.path)));
      state.currentProjectFilePath = p.path;
      markClean();
      return r;
    }
    case 'audio.export':
      await exportAll();
      return { started: true };
    case 'audio.exportTo': {
      const settings = await window.electronAPI.getSettings();
      const r = await runExportJob({ ...settings, ...p.options });
      const { encodeWav } = require('../audio/wavEncoder.js');
      const sr = p.options?.sampleRate || 24000;
      await authorize(p.path);
      const saved = await window.electronAPI.saveFile(p.path, encodeWav(r.mixedAudio, sr, r.numChannels || 1));
      if (!saved?.success) throw new Error(saved?.error || 'Export failed');
      return { path: p.path, sampleRate: sr, duration: r.maxDuration };
    }
    case 'lrc.export':
      await exportProjectLrc();
      return { started: true };
    case 'lrc.exportTo': {
      const lrc = buildProjectLrc();
      if (!lrc) throw new Error('No lyrics to export');
      await authorize(p.path);
      // UTF-8 BOM improves compatibility with older Windows LRC players (与 GUI 一致)。
      const saved = await window.electronAPI.saveFile(p.path, `\uFEFF${lrc}`);
      if (!saved?.success) throw new Error(saved?.error || 'Save failed');
      return { path: p.path };
    }
    case 'settings.get':
      return window.electronAPI.getSettings();
    case 'settings.update':
      return window.electronAPI.saveSettings(p.settings || {});
    case 'ui.open': {
      const actions = {
        singerCreator: () => window.electronAPI.openSingerCreator(),
        singerMarket: () => window.electronAPI.openSingerMarket(),
        modelDownload: () => window.electronAPI.modelDownloadOpen(p.precision),
        resourceManager: () => window.electronAPI.resmgrOpen(),
      };
      const fn = actions[p.target];
      if (!fn) throw new Error('Unknown UI target');
      await fn();
      return { opened: p.target };
    }
    default:
      throw new Error(`Unknown method ${m}`);
  }
}

export function registerMcpAutomation() {
  if (!window.electronAPI?.onMcpAutomationRequest) return;
  state._ipcCleanups.push(window.electronAPI.onMcpAutomationRequest(async m => {
    try {
      window.electronAPI.sendMcpAutomationResponse({ id: m.id, ok: true, result: await execute(m.method, m.params) });
    } catch (e) {
      window.electronAPI.sendMcpAutomationResponse({ id: m.id, ok: false, error: e.message || String(e) });
    }
  }));
}