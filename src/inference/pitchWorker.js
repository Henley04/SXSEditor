const { parentPort, workerData } = require('node:worker_threads');

// Apply float16 type mapping patch (same as main process pipeline).
// Safe to require: the patch file has internal try/catch and is a no-op if
// Float16Array is unavailable or onnxruntime-common is not yet loaded.
try { require('./pipeline/float16Patch'); } catch (_) {}

const { RmvpePitchDetector } = require('./rmvpePitchDetector');
const { RosvotDetector } = require('./rosvotDetector');
const { FcpePitchDetector } = require('./fcpePitchDetector');
const pp = require('./pitchPostprocess');

// 检测器按需懒加载：worker 启动不再立刻加载 RMVPE，仅使用 FCPE（默认 MIDI
// 提取）时不会白占一份 RMVPE 显存/加载时间；反之亦然。
let detector = null;
let rmvpeInitPromise = null;
let fcpeDetector = null;
let fcpeInitPromise = null;
let rosvot = null;
let inactivityTimer = null;
const INACTIVITY_TIMEOUT_MS = 60000;

function disposeAllDetectors() {
  if (detector) {
    try { detector.dispose(); } catch (_) {}
    detector = null;
  }
  if (fcpeDetector) {
    try { fcpeDetector.dispose(); } catch (_) {}
    fcpeDetector = null;
  }
  if (rosvot) {
    try { rosvot.dispose(); } catch (_) {}
    rosvot = null;
  }
}

function scheduleInactivityShutdown() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    try { parentPort.postMessage({ type: 'inactive-shutdown' }); } catch (_) {}
    disposeAllDetectors();
    process.exit(0);
  }, INACTIVITY_TIMEOUT_MS);
}

function clearInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

function ensureRmvpe() {
  if (!rmvpeInitPromise) {
    rmvpeInitPromise = (async () => {
      const { modelDir, deviceId } = workerData || {};
      detector = new RmvpePitchDetector(modelDir, { deviceId });
      await detector.init();
    })();
  }
  return rmvpeInitPromise;
}

function ensureFcpe() {
  if (!fcpeInitPromise) {
    fcpeInitPromise = (async () => {
      const { modelDir, deviceId } = workerData || {};
      fcpeDetector = new FcpePitchDetector(modelDir, { deviceId });
      await fcpeDetector.init();
    })();
  }
  return fcpeInitPromise;
}

// FCPE MIDI 提取管线（必须与 pitchMidiIpc.js 的同步 fallback 保持一致）：
// FCPE 内部的 48k→16k Kaiser 窗重采样在主线程执行时会冻结所有渲染窗口
//（5 分钟音频约 3.4s），连同后处理一起在 worker 内完成。
async function runFcpeExtraction(msg) {
  const opts = msg.options || {};
  const sr = msg.sampleRate || 44100;
  const bpmVal = opts.bpm || msg.bpm || 120;

  const audioInput = msg.audioData instanceof Float32Array
    ? msg.audioData
    : new Float32Array(msg.audioData);

  // 1. 响度归一化到 -3 ~ -6dBFS（弱信号会导致 FCPE 漏判音高）
  const workAudio = opts.normalize === false ? audioInput : pp.normalizeToTargetDb(audioInput, -4.5);

  // 2. 提取 F0（内部重采样到 16kHz）
  let f0Array = await fcpeDetector.extractF0(workAudio, sr);

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

  // 转为可转移 TypedArray，与 RMVPE 路径协议一致（零拷贝回主线程）。
  const n = f0Array.length;
  const f0 = new Float32Array(n);
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    f0[i] = f0Array[i].f0;
    times[i] = f0Array[i].time;
  }
  parentPort.postMessage({
    type: 'result',
    id: msg.id,
    kind: 'fcpe',
    f0,
    times,
    notes,
    pitchBends,
    warnings,
    f0Min,
    f0Max,
    device: fcpeDetector.getDeviceInfo(),
    bpm: useBpm,
  }, [f0.buffer, times.buffer]);
}

parentPort.on('message', async (msg) => {
  if (msg.type !== 'extract' && msg.type !== 'extract-midi' && msg.type !== 'extract-fcpe') return;
  clearInactivityTimer();
  try {
    if (msg.type === 'extract-fcpe') {
      await ensureFcpe();
      await runFcpeExtraction(msg);
      scheduleInactivityShutdown();
      return;
    }

    await ensureRmvpe();
    const audioData = msg.audioData instanceof Float32Array
      ? msg.audioData
      : new Float32Array(msg.audioData);
    const f0Array = await detector.extractF0(audioData, msg.sampleRate || 44100);
    let notes = null;
    if (msg.type === 'extract-midi') {
      if (msg.useRosvot && msg.rosvotAvailable) {
        try {
          if (!rosvot) {
            rosvot = new RosvotDetector(workerData.modelDir, { deviceId: workerData.deviceId });
            await rosvot.init();
          }
          notes = await rosvot.extractNotes(audioData, msg.sampleRate || 44100, f0Array, msg.bpm || 120);
          if (!notes.some(n => n.pitch > 0)) notes = detector.f0ToNotes(f0Array, msg.bpm || 120);
        } catch (err) {
          try { rosvot?.dispose(); } catch (_) {}
          rosvot = null;
          notes = detector.f0ToNotes(f0Array, msg.bpm || 120);
        }
      } else {
        notes = detector.f0ToNotes(f0Array, msg.bpm || 120);
      }
    }
    // Convert to transferable TypedArrays for zero-copy transfer back to main thread.
    const n = f0Array.length;
    const f0 = new Float32Array(n);
    const times = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      f0[i] = f0Array[i].f0;
      times[i] = f0Array[i].time;
    }
    parentPort.postMessage({ type: 'result', id: msg.id, f0, times, notes }, [f0.buffer, times.buffer]);
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, error: err.message, code: err.code });
  }
  scheduleInactivityShutdown();
});

// 启动即报 ready：模型加载延迟到首个具体请求（懒加载），这样仅用 FCPE 时
// 不会触发 RMVPE 加载。脚本级加载失败仍以 init-error 通知主线程。
try {
  parentPort.postMessage({ type: 'ready' });
  scheduleInactivityShutdown();
} catch (err) {
  parentPort.postMessage({ type: 'init-error', error: err.message, code: err.code });
  process.exit(1);
}
