const { parentPort, workerData } = require('node:worker_threads');

// Apply float16 type mapping patch (same as main process pipeline).
// Safe to require: the patch file has internal try/catch and is a no-op if
// Float16Array is unavailable or onnxruntime-common is not yet loaded.
try { require('./pipeline/float16Patch'); } catch (_) {}

const { RmvpePitchDetector } = require('./rmvpePitchDetector');
const { RosvotDetector } = require('./rosvotDetector');

let detector = null;
let rosvot = null;
let inactivityTimer = null;
const INACTIVITY_TIMEOUT_MS = 60000;

function scheduleInactivityShutdown() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    try { parentPort.postMessage({ type: 'inactive-shutdown' }); } catch (_) {}
    if (detector) {
      try { detector.dispose(); } catch (_) {}
      detector = null;
      if (rosvot) { try { rosvot.dispose(); } catch (_) {} rosvot = null; }
    }
    process.exit(0);
  }, INACTIVITY_TIMEOUT_MS);
}

function clearInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

async function init() {
  try {
    const { modelDir, deviceId } = workerData || {};
    detector = new RmvpePitchDetector(modelDir, { deviceId });
    await detector.init();
    parentPort.postMessage({ type: 'ready' });
    scheduleInactivityShutdown();
  } catch (err) {
    parentPort.postMessage({ type: 'init-error', error: err.message, code: err.code });
    process.exit(1);
  }
}

parentPort.on('message', async (msg) => {
  if (msg.type !== 'extract' && msg.type !== 'extract-midi') return;
  clearInactivityTimer();
  if (!detector) {
    parentPort.postMessage({ type: 'error', id: msg.id, error: 'Detector not initialized' });
    scheduleInactivityShutdown();
    return;
  }
  try {
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

init();
