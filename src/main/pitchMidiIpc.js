const { ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { RmvpePitchDetector } = require('../inference/rmvpePitchDetector');
const { BasicPitchDetector } = require('../inference/basicPitch');
const { RosvotDetector } = require('../inference/rosvotDetector');
const { FcpePitchDetector } = require('../inference/fcpePitchDetector');
const pp = require('../inference/pitchPostprocess');
const { parseMidiFile, parseMidiFileMultiTrack, parseMidiProjectInfo } = require('../inference/midiParser');
const { loadSettings } = require('./settings');
const { getModelDir } = require('./modelDir');
const { createLazyInitializer } = require('./lazyInitializer');

/**
 * Get the base model directory (without precision subdirectory).
 * Shared models (basic_pitch, rmvpe, rosvot) live at the base level,
 * not inside precision-specific subdirectories like int8/optimized_npu/.
 */
function getBaseModelDir() {
  const dir = getModelDir();
  // Strip precision subdirectories if present
  const precisionSuffixes = [
    path.sep + 'int8' + path.sep + 'optimized_npu' + path.sep,
    path.sep + 'int8' + path.sep,
    path.sep + 'fp16' + path.sep,
  ];
  for (const suffix of precisionSuffixes) {
    if (dir.endsWith(suffix) || dir.endsWith(suffix.slice(0, -1))) {
      const base = dir.slice(0, dir.lastIndexOf(suffix) + 1);
      return base;
    }
  }
  return dir;
}

const rmvpeLazy = createLazyInitializer(async () => {
  const modelPath = getBaseModelDir();
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? undefined;
  console.log(`[Main] Initialize RMVPE Pitch Detector, model path: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : 'auto'}`);
  const detector = new RmvpePitchDetector(modelPath, { deviceId });
  await detector.init();
  return detector;
});

const basicPitchLazy = createLazyInitializer(async () => {
  const modelPath = getBaseModelDir();
  console.log(`[Main] Initialize Basic Pitch Detector, model path: ${modelPath}`);
  const detector = new BasicPitchDetector(modelPath);
  await detector.init();
  return detector;
});

const rosvotLazy = createLazyInitializer(async () => {
  const modelPath = getBaseModelDir();
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? undefined;
  console.log(`[Main] Initialize RosvotDetector, model path: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : 'auto'}`);
  const detector = new RosvotDetector(modelPath, { deviceId });
  await detector.init();
  return detector;
});

const fcpeLazy = createLazyInitializer(async () => {
  const modelPath = getBaseModelDir();
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? undefined;
  console.log(`[Main] Initialize FcpePitchDetector, model path: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : 'auto'}`);
  const detector = new FcpePitchDetector(modelPath, { deviceId });
  await detector.init();
  return detector;
});

function getRmvpeDetector() { return rmvpeLazy.getInstance(); }
function getBasicPitchDetector() { return basicPitchLazy.getInstance(); }
function getRosvotDetector() { return rosvotLazy.getInstance(); }
function getFcpeDetector() { return fcpeLazy.getInstance(); }

function resetRmvpe() {
  const inst = rmvpeLazy.getInstance();
  if (inst) { try { inst.dispose(); } catch (_) {} }
  rmvpeLazy.reset();
}
function resetBasicPitch() {
  const inst = basicPitchLazy.getInstance();
  if (inst) { try { inst.dispose(); } catch (_) {} }
  basicPitchLazy.reset();
}
function resetRosvot() {
  const inst = rosvotLazy.getInstance();
  if (inst) { try { inst.dispose(); } catch (_) {} }
  rosvotLazy.reset();
}
function resetFcpe() {
  const inst = fcpeLazy.getInstance();
  if (inst) { try { inst.dispose(); } catch (_) {} }
  fcpeLazy.reset();
}

// ==================== RMVPE worker_thread (offload F0 extraction) ====================
//
// RMVPE inference (resample + ONNX run + argmax) is CPU/GPU heavy and can block
// the main thread for hundreds of ms. We offload it to a worker_thread that
// owns its own ONNX session. The worker auto-shuts after 60s of inactivity to
// free GPU memory. If the worker fails to initialize or crashes mid-request,
// we fall back to the synchronous in-process path (rmvpeLazy) so functionality
// is never lost.

let pitchWorker = null;
let pitchWorkerReady = false;
let pitchWorkerInitPromise = null;
let pitchRequestId = 0;
let _pitchWorkerFailedAt = 0;
const PITCH_WORKER_RETRY_COOLDOWN_MS = 30000;
const pitchPendingRequests = new Map();

function _findPitchWorkerScript() {
  const searchPaths = [
    // Dev: src/main/ → src/inference/pitchWorker.js
    path.join(__dirname, '..', 'inference', 'pitchWorker.js'),
    // Bundled: .webpack/main/ → .webpack/main/inference/pitchWorker.js
    path.join(__dirname, 'inference', 'pitchWorker.js'),
  ];
  for (const p of searchPaths) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

function _rejectAllPitchPending(err) {
  for (const [, { reject }] of pitchPendingRequests) {
    reject(err);
  }
  pitchPendingRequests.clear();
}

function createPitchWorker() {
  const workerScript = _findPitchWorkerScript();
  if (!workerScript) {
    throw new Error('pitchWorker.js not found');
  }
  const modelDir = getBaseModelDir();
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? undefined;
  const worker = new Worker(workerScript, {
    workerData: { modelDir, deviceId },
  });

  worker.on('message', (msg) => {
    if (msg.type === 'ready') {
      pitchWorkerReady = true;
      if (pitchWorkerInitPromise) {
        pitchWorkerInitPromise.resolve();
        pitchWorkerInitPromise = null;
      }
      return;
    }
    if (msg.type === 'init-error') {
      const err = new Error(msg.error);
      if (msg.code) err.code = msg.code;
      if (pitchWorkerInitPromise) {
        pitchWorkerInitPromise.reject(err);
        pitchWorkerInitPromise = null;
      }
      return;
    }
    if (msg.type === 'inactive-shutdown') {
      pitchWorker = null;
      pitchWorkerReady = false;
      if (pitchWorkerInitPromise) {
        pitchWorkerInitPromise.reject(new Error('pitchWorker shut down during init'));
        pitchWorkerInitPromise = null;
      }
      return;
    }
    if (msg.type === 'result' || msg.type === 'error') {
      const pending = pitchPendingRequests.get(msg.id);
      if (pending) {
        pitchPendingRequests.delete(msg.id);
        if (msg.type === 'result') {
          // Reconstruct f0Array of objects from transferred TypedArrays
          const n = msg.f0.length;
          const f0Array = new Array(n);
          for (let i = 0; i < n; i++) {
            f0Array[i] = { time: msg.times[i], f0: msg.f0[i], confidence: 0 };
          }
          pending.resolve(msg.notes ? { f0Array, notes: msg.notes } : f0Array);
        } else {
          const err = new Error(msg.error);
          if (msg.code) err.code = msg.code;
          pending.reject(err);
        }
      }
    }
  });

  worker.on('error', (err) => {
    console.warn('[Main] pitchWorker error:', err.message);
    pitchWorker = null;
    pitchWorkerReady = false;
    if (pitchWorkerInitPromise) {
      pitchWorkerInitPromise.reject(err);
      pitchWorkerInitPromise = null;
    }
    _rejectAllPitchPending(err);
  });

  worker.on('exit', (code) => {
    pitchWorker = null;
    pitchWorkerReady = false;
    if (pitchWorkerInitPromise) {
      pitchWorkerInitPromise.reject(new Error(`pitchWorker exited with code ${code}`));
      pitchWorkerInitPromise = null;
    }
    _rejectAllPitchPending(new Error(`pitchWorker exited (code=${code})`));
  });

  return worker;
}

async function ensurePitchWorker() {
  if (pitchWorker && pitchWorkerReady) return pitchWorker;
  if (pitchWorker && !pitchWorkerReady && pitchWorkerInitPromise) {
    await pitchWorkerInitPromise.promise;
    return pitchWorker;
  }
  // Cooldown: if the worker recently failed to init, don't retry immediately
  // (avoids repeated slow init attempts on every call).
  if (Date.now() - _pitchWorkerFailedAt < PITCH_WORKER_RETRY_COOLDOWN_MS) {
    throw new Error('pitchWorker recently failed, in cooldown');
  }
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  pitchWorkerInitPromise = { promise, resolve, reject };
  try {
    pitchWorker = createPitchWorker();
    await promise;
    return pitchWorker;
  } catch (err) {
    pitchWorker = null;
    pitchWorkerInitPromise = null;
    _pitchWorkerFailedAt = Date.now();
    throw err;
  }
}

async function extractF0ViaWorker(audioData, sampleRate) {
  const worker = await ensurePitchWorker();
  const id = ++pitchRequestId;
  return new Promise((resolve, reject) => {
    pitchPendingRequests.set(id, { resolve, reject });
    worker.postMessage({ type: 'extract', id, audioData, sampleRate });
  });
}

async function extractMidiViaWorker(audioData, sampleRate, bpm, useRosvot, rosvotAvailable) {
  const worker = await ensurePitchWorker();
  const id = ++pitchRequestId;
  return new Promise((resolve, reject) => {
    pitchPendingRequests.set(id, { resolve, reject });
    worker.postMessage({ type: 'extract-midi', id, audioData, sampleRate, bpm, useRosvot, rosvotAvailable });
  });
}

function registerPitchMidiIpc() {
  ipcMain.handle('extractF0:onnx', async (event, { audioData, sampleRate }) => {
    try {
      try {
        const f0Array = await extractF0ViaWorker(audioData, sampleRate || 44100);
        return { success: true, f0Array };
      } catch (workerErr) {
        console.warn('[Main] pitchWorker unavailable, falling back to sync:', workerErr.message);
        const detector = await rmvpeLazy.get();
        const f0Array = await detector.extractF0(new Float32Array(audioData), sampleRate || 44100);
        return { success: true, f0Array };
      }
    } catch (err) {
      console.error('[Main] F0 extraction failed:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('extractMidi:rosvot', async (event, { audioData, sampleRate, bpm }) => {
    try {
      const settings = loadSettings();
      const useRosvot = settings?.useRosvot === true;
      const rosvotModelPath = path.join(getBaseModelDir(), 'preprocess', 'rosvot_model.onnx');
      const result = await extractMidiViaWorker(
        audioData, sampleRate || 44100, bpm || 120, useRosvot, fs.existsSync(rosvotModelPath)
      );
      return { success: true, f0Array: result.f0Array, notes: result.notes };
    } catch (workerErr) {
      // Compatibility fallback. It preserves behavior on platforms/builds where
      // worker_threads or a native addon cannot be initialized.
      console.warn('[Main] pitchWorker MIDI path unavailable, falling back to sync:', workerErr.message);
      try {
        const detector = await rmvpeLazy.get();
        const f0Array = await detector.extractF0(new Float32Array(audioData), sampleRate || 44100);
        let notes = detector.f0ToNotes(f0Array, bpm || 120);
        if (loadSettings()?.useRosvot === true) {
          try {
            const rosvot = await rosvotLazy.get();
            const candidate = await rosvot.extractNotes(new Float32Array(audioData), sampleRate || 44100, f0Array, bpm || 120);
            if (candidate.some(n => n.pitch > 0)) notes = candidate;
          } catch (_) { resetRosvot(); }
        }
        return { success: true, f0Array, notes };
      } catch (err) {
        console.error('[Main] MIDI extraction failed:', err);
        return { success: false, error: err.message };
      }
    }
  });

  ipcMain.handle('extractF0:basicPitch', async (event, { audioData, sampleRate, bpm }) => {
    try {
      const detector = await basicPitchLazy.get();
      const result = await detector.extractF0AndNotes(new Float32Array(audioData), sampleRate || 44100, bpm || 120);
      return { success: true, f0Array: result.f0Array, notes: result.notes };
    } catch (err) {
      console.error('[Main] Basic Pitch extraction failed:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('extractMidi:fcpe', async (event, { audioData, sampleRate, bpm, options }) => {
    try {
      const detector = await fcpeLazy.get();
      const audio = new Float32Array(audioData);
      const sr = sampleRate || 44100;
      const opts = options || {};
      const bpmVal = opts.bpm || bpm || 120;

      // 1. 响度归一化到 -3 ~ -6dBFS（弱信号会导致 FCPE 漏判音高）
      const workAudio = opts.normalize === false ? audio : pp.normalizeToTargetDb(audio, -4.5);

      // 2. 提取 F0（内部重采样到 16kHz）
      let f0Array = await detector.extractF0(workAudio, sr);

      // 3. 自动适配音域（快速扫描后取分位数区间）
      let f0Min = opts.f0Min || 80;
      let f0Max = opts.f0Max || 880;
      if (opts.f0RangeAuto) {
        const stats = pp.f0RangeStats(f0Array);
        const range = pp.autoRangeFromStats(stats);
        f0Min = range.f0Min;
        f0Max = range.f0Max;
      }

      // 4. 静音门限（按帧 RMS，threshold 预设 0.003/0.006/0.01）
      if (opts.thresholdEnabled !== false && opts.threshold > 0) {
        const frameDur = f0Array.length > 1 ? f0Array[1].time - f0Array[0].time : 0.02;
        const rms = pp.computeFrameRms(workAudio, sr, frameDur);
        f0Array = pp.gateByThreshold(f0Array, rms, opts.threshold);
      }

      // 5. F0 量程门限
      f0Array = pp.gateByRange(f0Array, f0Min, f0Max);

      // 6. 中值平滑（消除跳变噪音）
      const win = pp.smoothingWindow(opts.smoothing || 'medium');
      f0Array = pp.medianFilterF0(f0Array, win);

      // 7. 有效人声/静音段检测（提示 UVR 分离质量）
      const endSec = f0Array.length > 0 ? f0Array[f0Array.length - 1].time : 0;
      const quality = pp.detectVoiceQuality(f0Array, endSec);
      const warnings = quality.warnings;

      // 8. 自动 BPM 检测
      let useBpm = bpmVal;
      if (opts.autoBpm) {
        useBpm = pp.detectBpm(workAudio, sr, bpmVal);
      }

      // 9. 音符切分 + 量化（严格 / 保留滑音 Pitch Bend）
      const { notes, pitchBends } = pp.segmentNotes(f0Array, {
        quantization: opts.quantization || 'strict',
        minNoteDuration: opts.minNoteDuration || 0.05,
        bpm: useBpm,
      });

      return {
        success: true,
        f0Array,
        notes,
        pitchBends,
        warnings,
        f0Min,
        f0Max,
        device: detector.getDeviceInfo(),
        bpm: useBpm,
      };
    } catch (err) {
      console.error('[Main] FCPE extraction failed:', err);
      return {
        success: false,
        code: err.code === 'MODEL_NOT_FOUND' ? 'MODEL_NOT_FOUND' : undefined,
        error: err.message,
      };
    }
  });

  ipcMain.handle('midi:import', async () => {
    try {
      const { dialog } = require('electron');
      const { t } = require('./locale');
      const result = await dialog.showOpenDialog({
        title: t('dialog.importMidi'),
        filters: [{ name: 'MIDI Files', extensions: ['mid', 'midi'] }],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      const buffer = await require('node:fs').promises.readFile(filePath);
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      const notes = parseMidiFile(arrayBuffer);

      return { success: true, notes };
    } catch (err) {
      console.error('[Main] MIDI import failed:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('midi:importMultiTrack', async () => {
    try {
      const { dialog } = require('electron');
      const { t } = require('./locale');
      const result = await dialog.showOpenDialog({
        title: t('dialog.importMidi'),
        filters: [{ name: 'MIDI Files', extensions: ['mid', 'midi'] }],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      const buffer = await require('node:fs').promises.readFile(filePath);
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      const tracks = parseMidiFileMultiTrack(arrayBuffer);

      // Also extract project-level info (BPM, time signature) so the
      // renderer can ask the user whether to sync them into the project.
      let projectInfo = null;
      try {
        projectInfo = parseMidiProjectInfo(arrayBuffer);
      } catch (err) {
        // projectInfo is best-effort; if it fails, continue without it.
        console.warn('[Main] MIDI projectInfo extraction failed:', err.message);
      }

      return { success: true, tracks, projectInfo };
    } catch (err) {
      console.error('[Main] Multi-track MIDI import failed:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerPitchMidiIpc,
  getRmvpeDetector,
  getBasicPitchDetector,
  getRosvotDetector,
  getFcpeDetector,
  getBaseModelDir,
  resetRmvpe,
  resetBasicPitch,
  resetRosvot,
  resetFcpe,
  rmvpeLazy,
  basicPitchLazy,
  rosvotLazy,
  fcpeLazy,
};
