/**
 * pitchWorker.js
 * Web Worker for pitch detection in SXSEditor-Pad.
 *
 * Offloads pitch detection (RMVPE, Basic Pitch, ROSVOT) from the
 * main thread to prevent UI freezes during analysis.
 *
 * This file is bundled as a separate entry point by Vite.
 * Usage in main thread:
 *   const worker = new Worker(new URL('./pitchWorker.js', import.meta.url), { type: 'module' });
 *
 * @module inference/pitchWorker
 */

// Worker context — no DOM access, only computation.

/**
 * Handle messages from the main thread.
 *
 * Expected message payload:
 * {
 *   type: 'detect-rmvpe' | 'detect-basic-pitch' | 'detect-vad' | 'interpolate-f0',
 *   audio: Float32Array,
 *   options: object,
 *   modelData: Uint8Array (for first call to load model)
 * }
 */
self.onmessage = async function (event) {
  const { type, audio, options = {}, modelData } = event.data;

  try {
    switch (type) {
      case 'detect-rmvpe': {
        const result = await runRMVPE(audio, options, modelData);
        self.postMessage({ type: 'result', data: result }, transferable(result));
        break;
      }
      case 'detect-basic-pitch': {
        const result = await runBasicPitch(audio, options, modelData);
        self.postMessage({ type: 'result', data: result }, transferable(result));
        break;
      }
      case 'detect-vad': {
        const result = await runVAD(audio, options, modelData);
        self.postMessage({ type: 'result', data: result }, transferable(result));
        break;
      }
      case 'interpolate-f0': {
        const { f0, confidence, threshold, method } = options;
        const result = interpolateF0(f0, confidence, threshold, method);
        self.postMessage(
          { type: 'result', data: { f0: result } },
          { transfer: [result.buffer] }
        );
        break;
      }
      case 'load-models': {
        // Pre-load models in the worker
        const { rmvpeData, basicPitchData, rosvotData } = modelData || {};
        const loaded = { rmvpe: false, basicPitch: false, rosvot: false };

        if (rmvpeData) {
          loaded.rmvpe = true;
        }
        if (basicPitchData) {
          loaded.basicPitch = true;
        }
        if (rosvotData) {
          loaded.rosvot = true;
        }

        self.postMessage({ type: 'models-loaded', data: loaded });
        break;
      }
      default:
        self.postMessage({ type: 'error', data: { message: `Unknown type: ${type}` } });
    }
  } catch (err) {
    self.postMessage({ type: 'error', data: { message: err.message, stack: err.stack } });
  }
};

/**
 * Determine which data can be transferred (via Transferable) to avoid copying.
 *
 * @param {object} result
 * @returns {object} Transferable object
 */
function transferable(result) {
  const transfers = [];
  if (result.f0 instanceof Float32Array) {
    transfers.push(result.f0.buffer);
  }
  if (result.confidence instanceof Float32Array) {
    transfers.push(result.confidence.buffer);
  }
  if (result.voiceProb instanceof Float32Array) {
    transfers.push(result.voiceProb.buffer);
  }
  if (result.pitchContour instanceof Float32Array) {
    transfers.push(result.pitchContour.buffer);
  }
  return { transfer: transfers.length > 0 ? transfers : undefined };
}

// ==================== Worker-Level Inference ====================
// These functions import onnxruntime-web dynamically within the worker.

let ortInstance = null;

async function getOrt() {
  if (!ortInstance) {
    // In a Web Worker, we must import onnxruntime-web
    // Vite handles this as a dynamic import
    ortInstance = await import('onnxruntime-web');
    ortInstance.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
  }
  return ortInstance;
}

/** @type {Map<string, import('onnxruntime-web').InferenceSession>} */
const workerSessions = new Map();

async function getWorkerSession(modelId, modelData) {
  if (workerSessions.has(modelId)) {
    return workerSessions.get(modelId);
  }

  const ort = await getOrt();
  const session = await ort.InferenceSession.create(modelData, {
    executionProviders: ['wasm'],
  });
  workerSessions.set(modelId, session);
  return session;
}

/**
 * Run RMVPE inference in the worker.
 */
async function runRMVPE(audio, options, modelData) {
  const { sampleRate = 44100, threshold = 0.5 } = options;
  const ort = await getOrt();
  const session = await getWorkerSession('rmvpe', modelData);

  // Resample to 16000 Hz
  const targetSr = 16000;
  const resampled = resampleAudio(audio, sampleRate, targetSr);

  const maxVal = Math.max(...resampled.map(Math.abs), 1e-8);
  const normalised = new Float32Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    normalised[i] = resampled[i] / maxVal;
  }

  const audioTensor = new ort.Tensor('float32', normalised, [1, 1, normalised.length]);
  const feeds = { [session.inputNames[0]]: audioTensor };
  const results = await session.run(feeds);

  const outputArray = new Float32Array(results[session.outputNames[0]].data);
  const dims = results[session.outputNames[0]].dims;
  const numBins = 360;
  const numFrames = dims.length === 3 ? dims[2] : outputArray.length / numBins;

  const f0 = new Float32Array(numFrames);
  const confidence = new Float32Array(numFrames);

  const binFreqs = new Float32Array(numBins);
  for (let b = 0; b < numBins; b++) {
    binFreqs[b] = 10 * Math.exp(b * Math.log(2000 / 10) / (numBins - 1));
  }

  for (let f = 0; f < numFrames; f++) {
    let maxProb = 0;
    let maxBin = 0;
    for (let b = 0; b < numBins; b++) {
      const prob = outputArray[b * numFrames + f] || 0;
      if (prob > maxProb) {
        maxProb = prob;
        maxBin = b;
      }
    }
    confidence[f] = maxProb;
    f0[f] = (maxProb >= threshold && maxBin > 0)
      ? Math.max(50, Math.min(1100, binFreqs[maxBin]))
      : 0;
  }

  return { f0, confidence, hopLength: 160, sampleRate: targetSr };
}

/**
 * Run Basic Pitch inference in the worker.
 */
async function runBasicPitch(audio, options, modelData) {
  const { sampleRate = 44100, threshold = 0.3 } = options;
  const ort = await getOrt();
  const session = await getWorkerSession('basic-pitch', modelData);

  const targetSr = 22050;
  const resampled = resampleAudio(audio, sampleRate, targetSr);
  const audioTensor = new ort.Tensor('float32', resampled, [1, 1, resampled.length]);
  const feeds = { [session.inputNames[0]]: audioTensor };
  const results = await session.run(feeds);

  const outputArray = new Float32Array(results[session.outputNames[0]].data);
  const dims = results[session.outputNames[0]].dims;

  const numNotes = dims.length >= 2 ? dims[dims.length - 2] : 88;
  const numFrames = dims.length >= 1 ? dims[dims.length - 1] : outputArray.length / numNotes;
  const hopLength = 256;
  const frameDuration = hopLength / targetSr;

  const notes = [];
  let currentNote = null;

  for (let frame = 0; frame < numFrames; frame++) {
    for (let note = 0; note < numNotes; note++) {
      const amplitude = outputArray[note * numFrames + frame] || 0;
      if (amplitude > threshold && !currentNote) {
        currentNote = { startTime: frame * frameDuration, endTime: frame * frameDuration, pitch: note + 21, amplitude };
      } else if (amplitude <= threshold && currentNote) {
        currentNote.endTime = frame * frameDuration;
        notes.push(currentNote);
        currentNote = null;
      }
    }
  }
  if (currentNote) {
    currentNote.endTime = numFrames * frameDuration;
    notes.push(currentNote);
  }

  const pitchContour = new Float32Array(numFrames * 2);
  for (const note of notes) {
    const startFrame = Math.round(note.startTime * targetSr / hopLength);
    const endFrame = Math.round(note.endTime * targetSr / hopLength);
    const freq = 440 * Math.pow(2, (note.pitch - 69) / 12);
    for (let f = startFrame; f < Math.min(endFrame, pitchContour.length); f++) {
      if (f >= 0) pitchContour[f] = freq;
    }
  }

  return { notes, pitchContour, sampleRate: targetSr, hopLength };
}

/**
 * Run VAD inference in the worker.
 */
async function runVAD(audio, options, modelData) {
  const { sampleRate = 44100, threshold = 0.5, minSegmentDuration = 0.1 } = options;
  const ort = await getOrt();
  const session = await getWorkerSession('rosvot', modelData);

  const targetSr = 16000;
  const resampled = resampleAudio(audio, sampleRate, targetSr);
  const maxVal = Math.max(...resampled.map(Math.abs), 1e-8);
  const normalised = new Float32Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    normalised[i] = resampled[i] / maxVal;
  }

  const audioTensor = new ort.Tensor('float32', normalised, [1, 1, normalised.length]);
  const feeds = { [session.inputNames[0]]: audioTensor };
  const results = await session.run(feeds);

  const outputArray = new Float32Array(results[session.outputNames[0]].data);
  const numFrames = outputArray.length;
  const hopLength = 160;

  const voiceProb = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    voiceProb[i] = outputArray[i] || 0;
  }

  const segments = [];
  let inVoice = false;
  let segStart = 0;

  for (let i = 0; i < numFrames; i++) {
    const time = i * hopLength / targetSr;
    if (voiceProb[i] >= threshold && !inVoice) {
      segStart = time;
      inVoice = true;
    } else if (voiceProb[i] < threshold && inVoice) {
      if (time - segStart >= minSegmentDuration) {
        segments.push({ start: segStart, end: time });
      }
      inVoice = false;
    }
  }
  if (inVoice) {
    const endTime = numFrames * hopLength / targetSr;
    if (endTime - segStart >= minSegmentDuration) {
      segments.push({ start: segStart, end: endTime });
    }
  }

  return { voiceProb, segments, hopLength, sampleRate: targetSr };
}

/**
 * Interpolate F0 contour.
 */
function interpolateF0(f0, confidence, threshold = 0.5, method = 'linear') {
  const n = f0.length;
  const result = new Float32Array(f0);

  if (method === 'nearest') {
    let lastVoiced = 0;
    for (let i = 0; i < n; i++) {
      if (confidence[i] >= threshold && f0[i] > 0) {
        lastVoiced = f0[i];
      } else if (lastVoiced > 0) {
        result[i] = lastVoiced;
      }
    }
    let nextVoiced = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (confidence[i] >= threshold && f0[i] > 0) {
        nextVoiced = f0[i];
      } else if (nextVoiced > 0) {
        result[i] = nextVoiced;
      }
    }
  } else if (method === 'linear') {
    let lastIdx = -1;
    let lastVal = 0;
    for (let i = 0; i < n; i++) {
      if (confidence[i] >= threshold && f0[i] > 0) {
        if (lastIdx >= 0) {
          for (let j = 1; j < i - lastIdx; j++) {
            const t = j / (i - lastIdx);
            result[lastIdx + j] = lastVal * (1 - t) + f0[i] * t;
          }
        }
        lastIdx = i;
        lastVal = f0[i];
      }
    }
    if (lastIdx > 0) {
      for (let i = 0; i < lastIdx; i++) {
        result[i] = lastVal;
      }
    }
  }

  return result;
}

/**
 * Resample audio (linear interpolation).
 */
function resampleAudio(audio, inputSr, targetSr) {
  if (inputSr === targetSr) return new Float32Array(audio);
  const ratio = targetSr / inputSr;
  const newLen = Math.round(audio.length * ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const src = i / ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, audio.length - 1);
    const frac = src - lo;
    out[i] = audio[lo] * (1 - frac) + audio[hi] * frac;
  }
  return out;
}