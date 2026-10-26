import { state, trackManager, history } from './state.js';
import { SAMPLE_RATE, SVS_HOP_SIZE } from './constants.js';
import { markDirty, markClean, loadAccompanimentFile, addSingerFromFile, serializeProject, saveProject, saveProjectAs, loadProject } from './projectManager.js';
import { refreshAll } from './timelineRenderer.js';
import { openFragmentEditor } from './fragmentOperations.js';
import { buildFragmentPitchCurveF0 } from './f0Utils.js';
// F2/F3：MCP 导出与主窗口播放走同一套音符集合真源
import { computeActiveClippedNotes } from '../shared/activeNotes.js';
import { normalizePitchCurve } from '../shared/pitchCurveState.js';
import { normalizeAutoConfig, computeManualCoverage } from '../shared/autoPitchCurve.js';
import { buildMelPostprocessPayload } from '../shared/postprocessCurves.js';
import { buildProjectLrc, exportProjectLrc } from './lrcExport.js';
import { resampleForExport } from './exportDialog.js';
import {
  playAll, pausePlayback, stopPlayback, seekPlayback, exportAll, runExportJob,
  getCurrentPlaybackSeconds, ensurePipelineInitialized, loadAudioSettings,
  getExportInferenceOptions,
} from './audioPlayback.js';
import mcpModel from '../shared/mcpModel.js';

const { normalizeNote, normalizeFragment, validateProjectDoc, shapeSnapshot } = mcpModel;

const clone = (v) => JSON.parse(JSON.stringify(v));
const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;

function mcpError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function notFound(kind, id, known) {
  return mcpError('NOT_FOUND', `Unknown ${kind} ${id}`, {
    field: kind === 'fragment' ? 'fragmentId' : 'id',
    hint: known && known.length ? `known ${kind} ids: ${known.join(', ')}` : `use project.get to list ${kind}s`,
  });
}

function emit(type, data) {
  try { window.electronAPI?.sendMcpAutomationEvent?.({ type, data }); } catch (_) {}
}

function snapshot() {
  return {
    schemaVersion: '2.0',
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

// 授权一条路径：优先按"素材文件本身"授权（走 file:authorizePath 的文件分支，
// 扩展名必须命中白名单），只有当路径没有扩展名时才退回按父目录授权。
async function authorize(path) {
  const hasExtension = /\.[A-Za-z0-9]{1,12}$/.test(path);
  const target = hasExtension
    ? path
    : (() => {
        const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        return i > 0 ? path.slice(0, i) : path;
      })();
  const r = await window.electronAPI.authorizePath(target);
  if (!r?.success) {
    throw mcpError('FORBIDDEN', r?.error || `Path not authorized: ${target}`, {
      field: 'path',
      hint: 'grant the directory once with session.grantRoot instead of authorizing per file',
    });
  }
}

/** Shallow copy that keeps runtime audio buffers intact (rollback safety). */
function captureState() {
  return {
    project: clone(state.project),
    singers: trackManager.getSingers().map((s) => ({ ...s })),
    fragments: clone(trackManager.getFragments()),
    selectedSingerId: state.selectedSingerId,
    selectedFragmentId: state.selectedFragmentId,
  };
}

function restoreState(snap) {
  // Rebuild by splicing the live arrays instead of going through addSinger():
  // createSinger() is a field whitelist, so a round-trip through it would drop
  // wavBuffer / midiNotes / f0Data and silently change the singer's timbre on
  // the next export. Splicing also keeps object identity for the undo stack.
  const singers = trackManager.getSingers();
  singers.length = 0;
  snap.singers.forEach((s) => singers.push(s));
  const fragments = trackManager.getFragments();
  fragments.length = 0;
  snap.fragments.forEach((f) => fragments.push(clone(f)));
  state.project = clone(snap.project);
  state.selectedSingerId = snap.selectedSingerId;
  state.selectedFragmentId = snap.selectedFragmentId;
}

// ------------------------------------------------------------------ operations

function validateOperation(op, index, context) {
  const at = `operations[${index}]`;
  if (!op || typeof op !== 'object') throw mcpError('VALIDATION_ERROR', 'operation must be an object', { field: at });
  const singers = context.singerIds;
  const fragments = context.fragmentIds;
  switch (op.op) {
    case 'set_project':
      if (!op.value || typeof op.value !== 'object') throw mcpError('VALIDATION_ERROR', 'value must be an object', { field: `${at}.value` });
      break;
    case 'add_singer':
      if (!op.value || typeof op.value !== 'object') throw mcpError('VALIDATION_ERROR', 'value must be an object', { field: `${at}.value` });
      if (!op.value.trackName && !op.value.singerName) {
        throw mcpError('VALIDATION_ERROR', 'trackName or singerName is required', { field: `${at}.value` });
      }
      if (op.value.id) singers.add(op.value.id);
      break;
    case 'update_singer':
    case 'remove_singer':
      if (!op.id) throw mcpError('VALIDATION_ERROR', 'id is required', { field: `${at}.id` });
      if (!singers.has(op.id)) throw notFound('singer', op.id, [...singers]);
      break;
    case 'add_fragment': {
      if (!op.value || typeof op.value !== 'object') throw mcpError('VALIDATION_ERROR', 'value must be an object', { field: `${at}.value` });
      const sid = op.value.singerId;
      if (!sid) throw mcpError('VALIDATION_ERROR', 'singerId is required', { field: `${at}.value.singerId` });
      if (!singers.has(sid)) throw notFound('singer', sid, [...singers]);
      normalizeFragment(op.value, 0, `${at}.value`);
      if (op.value.id) fragments.add(op.value.id);
      break;
    }
    case 'update_fragment':
    case 'remove_fragment':
      if (!op.id) throw mcpError('VALIDATION_ERROR', 'id is required', { field: `${at}.id` });
      if (!fragments.has(op.id)) throw notFound('fragment', op.id, [...fragments]);
      if (op.op === 'update_fragment' && op.value && op.value.notes) {
        op.value.notes = op.value.notes.map((n, i) => normalizeNote(n, i, `${at}.value.notes`));
      }
      break;
    case 'replace_notes':
      if (!op.fragmentId) throw mcpError('VALIDATION_ERROR', 'fragmentId is required', { field: `${at}.fragmentId` });
      if (!fragments.has(op.fragmentId)) throw notFound('fragment', op.fragmentId, [...fragments]);
      (op.notes || []).forEach((n, i) => normalizeNote(n, i, `${at}.notes`));
      break;
    case 'set_selection':
      if (op.singerId !== undefined && !singers.has(op.singerId)) throw notFound('singer', op.singerId, [...singers]);
      if (op.fragmentId !== undefined && !fragments.has(op.fragmentId)) throw notFound('fragment', op.fragmentId, [...fragments]);
      break;
    case 'clear_project':
      singers.clear();
      fragments.clear();
      break;
    default:
      throw mcpError('VALIDATION_ERROR', `Unsupported operation ${op.op}`, {
        field: `${at}.op`,
        hint: 'set_project, add_singer, update_singer, remove_singer, add_fragment, update_fragment, remove_fragment, replace_notes, set_selection, clear_project',
      });
  }
}

function precheckOps(ops) {
  const context = {
    singerIds: new Set(trackManager.getSingers().map((s) => s.id)),
    fragmentIds: new Set(trackManager.getFragments().map((f) => f.id)),
  };
  ops.forEach((op, i) => validateOperation(op, i, context));
}

function applyInternal(ops) {
  const out = [];
  ops.forEach((op, index) => {
    try {
      switch (op.op) {
        case 'set_project':
          state.project = { ...state.project, ...op.value };
          out.push(state.project);
          break;
        case 'add_singer':
          out.push(trackManager.addSinger(op.value || {}));
          break;
        case 'update_singer':
          if (!trackManager.updateSinger(op.id, op.value || {})) throw notFound('singer', op.id);
          out.push(trackManager.getSinger(op.id));
          break;
        case 'remove_singer':
          if (!trackManager.removeSinger(op.id)) throw notFound('singer', op.id);
          out.push({ removed: op.id });
          break;
        case 'add_fragment':
          out.push(trackManager.addFragment(normalizeFragment(op.value || {})));
          break;
        case 'update_fragment':
          if (!trackManager.updateFragment(op.id, op.value || {})) throw notFound('fragment', op.id);
          out.push(trackManager.getFragment(op.id));
          break;
        case 'remove_fragment':
          if (!trackManager.removeFragment(op.id)) throw notFound('fragment', op.id);
          out.push({ removed: op.id });
          break;
        case 'replace_notes': {
          const f = trackManager.getFragment(op.fragmentId);
          if (!f) throw notFound('fragment', op.fragmentId);
          f.notes = (op.notes || []).map((n, i) => normalizeNote(n, i));
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
          throw mcpError('VALIDATION_ERROR', `Unsupported operation ${op.op}`);
      }
    } catch (err) {
      err.opIndex = index;
      throw err;
    }
  });
  return out;
}

function apply(ops, { dryRun = false, atomic = true } = {}) {
  if (!Array.isArray(ops)) throw mcpError('VALIDATION_ERROR', 'operations must be an array', { field: 'operations' });
  precheckOps(ops);

  if (dryRun) {
    return {
      dryRun: true,
      operations: ops.length,
      plan: ops.map((op, i) => ({ index: i, op: op.op, id: op.id || op.fragmentId || (op.value && op.value.id) || null })),
    };
  }

  const before = atomic ? captureState() : null;
  try {
    const results = applyInternal(ops);
    markDirty();
    refreshAll();
    emit('project.changed', { reason: 'apply', operations: ops.length });
    return {
      results,
      applied: ops.length,
      // Kept for callers written against the previous shape; summary only.
      project: shapeSnapshot(snapshot(), { includeNotes: false }),
    };
  } catch (err) {
    if (before) {
      restoreState(before);
      refreshAll();
    }
    throw mcpError(err.code || 'INTERNAL', err.message, {
      field: err.field,
      hint: err.hint,
      details: { opIndex: err.opIndex, rolledBack: !!before },
    });
  }
}

function replace(doc, { dryRun = false } = {}) {
  const check = validateProjectDoc(doc);
  if (!check.valid) {
    throw mcpError('VALIDATION_ERROR', check.errors[0].message, {
      field: check.errors[0].field,
      hint: check.errors[0].hint,
      details: { errors: check.errors },
    });
  }
  const normalized = {
    project: { bpm: 120, timeSignature: [4, 4], ...(doc.project || {}) },
    singers: doc.singers || [],
    fragments: (doc.fragments || []).map((f, i) => normalizeFragment(f, i)),
  };
  if (dryRun) {
    return { dryRun: true, singers: normalized.singers.length, fragments: normalized.fragments.length };
  }
  const before = captureState();
  try {
    trackManager.clearAll();
    state.project = normalized.project;
    normalized.singers.forEach((s) => trackManager.addSinger(s));
    normalized.fragments.forEach((f) => trackManager.addFragment(f));
    history.clear();
    markDirty();
    refreshAll();
    emit('project.changed', { reason: 'replace', singers: normalized.singers.length, fragments: normalized.fragments.length });
    return snapshot();
  } catch (err) {
    restoreState(before);
    refreshAll();
    throw mcpError('INTERNAL', `Replace failed and was rolled back: ${err.message}`, { details: { rolledBack: true } });
  }
}

// --------------------------------------------------------------------- midi

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
    const notes = t.notes.map((n, k) => normalizeNote(n, k));
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
  emit('project.changed', { reason: 'midi.import', tracks: created.length });
  return { created, project: shapeSnapshot(snapshot(), { includeNotes: false }) };
}

async function extractMidiFromAudio(p) {
  if (!p.path) throw mcpError('VALIDATION_ERROR', 'path is required', { field: 'path' });
  await authorize(p.path);
  const raw = await window.electronAPI.readFileBuffer(p.path);
  const ac = new AudioContext();
  let audioBuffer;
  try {
    audioBuffer = await ac.decodeAudioData(raw.slice(0));
  } catch (decodeErr) {
    throw mcpError('VALIDATION_ERROR', `Audio decode failed: ${decodeErr.message}`, { field: 'path' });
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
    if (!r.success) throw mcpError('INTERNAL', r.error || 'RMVPE failed');
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
    if (!r.success) throw mcpError('INTERNAL', r.error || 'FCPE failed');
    notes = mapNotes(r.notes);
    if (extractPitch) f0 = r.f0Array;
  } else {
    const r = await window.electronAPI.extractF0BasicPitch({ audioData, sampleRate, bpm });
    if (!r.success) throw mcpError('INTERNAL', r.error || 'Basic Pitch failed');
    notes = mapNotes(r.notes);
    if (extractPitch) {
      const f0r = await window.electronAPI.extractF0({ audioData, sampleRate });
      if (!f0r.success) throw mcpError('INTERNAL', f0r.error || 'RMVPE failed');
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

async function exportFragmentTo(p) {
  const f = trackManager.getFragment(p.fragmentId);
  if (!f) throw notFound('fragment', p.fragmentId, trackManager.getFragments().map(x => x.id));
  const singer = trackManager.getSinger(f.singerId);
  if (!singer) throw notFound('singer', f.singerId);
  await ensurePipelineInitialized();
  await loadAudioSettings();
  const o = { ...getExportInferenceOptions(), ...(p.options || {}) };
  const clippedNotes = computeActiveClippedNotes(f, f.notes);
  if (clippedNotes.length === 0) throw mcpError('PRECONDITION_FAILED', 'Fragment has no notes');
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
      qdrift: o.qdrift === true,
      cfgScheduleMode: o.cfgScheduleMode,
      cfgStrengthStart: o.cfgStrengthStart,
      cfgScheduleKeyframes: o.cfgScheduleKeyframes,
      dynamicThresholdEnabled: o.dynamicThresholdEnabled,
      dynamicThresholdPercentile: o.dynamicThresholdPercentile,
      melPostprocess: buildMelPostprocessPayload(
        f.postprocess || null,
        clippedNotes,
        state.project.bpm,
        SAMPLE_RATE,
        SVS_HOP_SIZE,
      ),
    },
  });
  const { encodeWav } = require('../audio/wavEncoder.js');
  const sr = p.options?.sampleRate || 24000;
  const outputAudio = resampleForExport(audioData, SAMPLE_RATE, sr, 1);
  const wav = encodeWav(outputAudio, sr, 1);
  await authorize(p.path);
  const saved = await window.electronAPI.saveFile(p.path, wav);
  if (!saved?.success) throw mcpError('INTERNAL', saved?.error || 'Export failed');
  return { path: p.path, sampleRate: sr, duration: outputAudio.length / sr };
}

// ------------------------------------------------------------------- execute

async function execute(m, p = {}) {
  switch (m) {
    case 'capabilities': {
      const settings = await window.electronAPI.getSettings().catch(() => null);
      return {
        schemaVersion: '2.0',
        methods: [
          'project.get', 'project.validate', 'project.apply', 'project.replace',
          'project.saveTo', 'project.loadFrom', 'project.save',
          'midi.importFile', 'audio.extractMidi', 'accompaniment.import', 'singer.import',
          'history.undo', 'history.redo', 'fragment.open', 'fragment.exportTo',
          'editor.getView', 'editor.setView',
          'playback.play', 'playback.pause', 'playback.stop', 'playback.seek', 'playback.get',
          'audio.export', 'audio.exportTo', 'lrc.export', 'lrc.exportTo',
          'settings.get', 'settings.update', 'ui.open',
        ],
        features: {
          projectOpen: true,
          singerCount: trackManager.getSingers().length,
          fragmentCount: trackManager.getFragments().length,
          settingsLoaded: !!settings,
        },
        renderer: 'main_window',
      };
    }
    case 'project.get':
      return shapeSnapshot(snapshot(), p);
    case 'project.validate': {
      const result = validateProjectDoc(p.project);
      return { ...result, errorMessages: result.errors.map((e) => `${e.field}: ${e.message}`) };
    }
    case 'project.apply':
      return apply(p.operations, { dryRun: !!p.dryRun, atomic: p.atomic !== false });
    case 'project.replace':
      return replace(p.project, { dryRun: !!p.dryRun });
    case 'midi.importParsed':
      return importMidi(p);
    case 'audio.extractMidi':
      return extractMidiFromAudio(p);
    case 'accompaniment.import': {
      if (!p.path) throw mcpError('VALIDATION_ERROR', 'path is required', { field: 'path' });
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
      emit('project.changed', { reason: 'accompaniment.import', singerId: s.id });
      return clone(s);
    }
    case 'singer.import': {
      if (!p.path) throw mcpError('VALIDATION_ERROR', 'path is required', { field: 'path' });
      await authorize(p.path);
      await addSingerFromFile(await window.electronAPI.readFileBuffer(p.path), p.path);
      markDirty();
      refreshAll();
      emit('project.changed', { reason: 'singer.import' });
      return shapeSnapshot(snapshot(), { includeNotes: false });
    }
    case 'history.undo':
      try {
        history.undo();
      } finally {
        refreshAll();
      }
      emit('project.changed', { reason: 'undo' });
      return { canUndo: history.canUndo(), canRedo: history.canRedo() };
    case 'history.redo':
      try {
        history.redo();
      } finally {
        refreshAll();
      }
      emit('project.changed', { reason: 'redo' });
      return { canUndo: history.canUndo(), canRedo: history.canRedo() };
    case 'fragment.getPitchCurve': {
      const f = trackManager.getFragment(p.fragmentId);
      if (!f) throw notFound('fragment', p.fragmentId, trackManager.getFragments().map((x) => x.id));
      const pc = normalizePitchCurve(f.pitchCurve);
      const notes = computeActiveClippedNotes(f, f.notes);
      const coverage = computeManualCoverage(pc, notes, {
        mergeGapBeats: pc.auto && pc.auto.params ? pc.auto.params.mergeGapBeats : 0.5,
      });
      return {
        fragmentId: f.id,
        pitchCurve: {
          enabled: pc.enabled,
          auto: pc.auto,
          anchorPoints: pc.anchorPoints,
          brushSegments: pc.brushSegments,
          // 派生段默认只回元信息：一个导入段可能有上千个点，全部返回会把响应撑爆
          bakedSegments: pc.bakedSegments.map((seg) => (p.includePoints
            ? { ...seg }
            : { id: seg.id, start: seg.start, end: seg.end, origin: seg.origin, pointCount: seg.points.length })),
        },
        coverage,
      };
    }
    case 'fragment.setPitchCurve': {
      const f = trackManager.getFragment(p.fragmentId);
      if (!f) throw notFound('fragment', p.fragmentId, trackManager.getFragments().map((x) => x.id));
      const pc = normalizePitchCurve(f.pitchCurve);
      if (p.reset === 'manual' || p.reset === 'all') {
        pc.anchorPoints = [];
        pc.brushSegments = [];
        pc.bakedSegments = [];
        if (p.reset === 'all') pc.auto.enabled = false;
      }
      if (p.auto && typeof p.auto === 'object') {
        const merged = {
          ...pc.auto,
          ...p.auto,
          params: { ...pc.auto.params, ...(p.auto.params || {}) },
        };
        pc.auto = normalizeAutoConfig(merged);
        pc.auto.version = (pc.auto.version || 0) + 1;
      }
      if (Array.isArray(p.anchorPoints)) pc.anchorPoints = p.anchorPoints;
      if (Array.isArray(p.bakedSegments)) pc.bakedSegments = p.bakedSegments;
      f.pitchCurve = normalizePitchCurve(pc);
      markDirty();
      refreshAll();
      return {
        fragmentId: f.id,
        pitchCurve: {
          enabled: f.pitchCurve.enabled,
          auto: f.pitchCurve.auto,
          anchorCount: f.pitchCurve.anchorPoints.length,
          bakedSegmentCount: f.pitchCurve.bakedSegments.length,
        },
      };
    }
    case 'fragment.open': {
      const ids = trackManager.getFragments().map((x) => x.id);
      const f = trackManager.getFragment(p.fragmentId);
      if (!f) throw notFound('fragment', p.fragmentId, ids);
      openFragmentEditor(f);
      emit('fragment.opened', { fragmentId: f.id });
      return { opened: f.id };
    }
    case 'fragment.exportTo':
      return exportFragmentTo(p);
    case 'playback.play':
      await playAll();
      emit('playback.state', { playing: true });
      return { playing: true };
    case 'playback.pause':
      pausePlayback();
      emit('playback.state', { playing: false, paused: true });
      return { paused: true };
    case 'playback.stop':
      stopPlayback();
      emit('playback.state', { playing: false, stopped: true });
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
      emit('project.saved', { path: state.currentProjectFilePath });
      return { path: state.currentProjectFilePath };
    case 'project.saveAs':
      await saveProjectAs();
      emit('project.saved', { path: state.currentProjectFilePath });
      return { path: state.currentProjectFilePath };
    case 'project.load':
      await loadProject();
      emit('project.changed', { reason: 'load' });
      return shapeSnapshot(snapshot(), { includeNotes: false });
    case 'project.saveTo': {
      await authorize(p.path);
      const r = await window.electronAPI.saveFile(p.path, await serializeProject(!!p.embedSingerFiles, !!p.embedAccompanimentAudio));
      if (!r?.success) throw mcpError('INTERNAL', r?.error || 'Save failed');
      state.currentProjectFilePath = p.path;
      markClean();
      emit('project.saved', { path: p.path });
      return { path: p.path };
    }
    case 'project.loadFrom': {
      await authorize(p.path);
      const raw = JSON.parse(await window.electronAPI.readFile(p.path));
      const r = replace(raw);
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
      const outputAudio = resampleForExport(r.mixedAudio, SAMPLE_RATE, sr, r.numChannels || 1);
      await authorize(p.path);
      const saved = await window.electronAPI.saveFile(p.path, encodeWav(outputAudio, sr, r.numChannels || 1));
      if (!saved?.success) throw mcpError('INTERNAL', saved?.error || 'Export failed');
      return { path: p.path, sampleRate: sr, duration: r.maxDuration };
    }
    case 'lrc.export':
      await exportProjectLrc();
      return { started: true };
    case 'lrc.exportTo': {
      const lrc = buildProjectLrc();
      if (!lrc) throw mcpError('PRECONDITION_FAILED', 'No lyrics to export');
      await authorize(p.path);
      const saved = await window.electronAPI.saveFile(p.path, `\uFEFF${lrc}`);
      if (!saved?.success) throw mcpError('INTERNAL', saved?.error || 'Save failed');
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
      if (!fn) throw mcpError('VALIDATION_ERROR', `Unknown UI target ${p.target}`, { field: 'target' });
      await fn();
      emit('ui.opened', { target: p.target });
      return { opened: p.target };
    }
    default:
      throw mcpError('UNKNOWN_METHOD', `Unknown method ${m}`);
  }
}

export function registerMcpAutomation() {
  if (!window.electronAPI?.onMcpAutomationRequest) return;
  state._ipcCleanups.push(window.electronAPI.onMcpAutomationRequest(async m => {
    try {
      window.electronAPI.sendMcpAutomationResponse({ id: m.id, ok: true, result: await execute(m.method, m.params) });
    } catch (e) {
      window.electronAPI.sendMcpAutomationResponse({
        id: m.id,
        ok: false,
        error: {
          code: e.code || 'INTERNAL',
          message: e.message || String(e),
          field: e.field,
          hint: e.hint,
          details: e.details,
        },
      });
    }
  }));
}

export { execute as _executeForTests };
