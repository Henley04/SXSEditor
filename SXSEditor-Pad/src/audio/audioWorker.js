/**
 * audioWorker.js - Audio processing Web Worker.
 *
 * Runs audio processing tasks (resampling, filtering, mixing) in a
 * separate thread via postMessage communication.
 *
 * Usage (in main thread):
 *   const worker = new Worker(
 *     new URL('./audioWorker.js', import.meta.url),
 *     { type: 'module' }
 *   );
 *   worker.postMessage({ type: 'resample', data: float32Array, inputSampleRate: 44100, outputSampleRate: 22050 }, [float32Array.buffer]);
 *   worker.onmessage = (e) => { /* e.data.result *\/ };
 */

// ---- Simple biquad filter coefficients ----

/**
 * Design a biquad low-pass filter.
 * @param {number} cutoff - Cutoff frequency in Hz.
 * @param {number} sampleRate - Sample rate in Hz.
 * @param {number} [q=0.707] - Quality factor.
 * @returns {{ b0: number, b1: number, b2: number, a1: number, a2: number }}
 */
function designLowPass(cutoff, sampleRate, q = 0.707) {
  const w0 = 2 * Math.PI * cutoff / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosW0 = Math.cos(w0);

  const b0 = (1 - cosW0) / 2;
  const b1 = 1 - cosW0;
  const b2 = (1 - cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;

  return {
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
    a1: a1 / a0, a2: a2 / a0,
  };
}

/**
 * Design a biquad high-pass filter.
 * @param {number} cutoff - Cutoff frequency in Hz.
 * @param {number} sampleRate - Sample rate in Hz.
 * @param {number} [q=0.707] - Quality factor.
 * @returns {{ b0: number, b1: number, b2: number, a1: number, a2: number }}
 */
function designHighPass(cutoff, sampleRate, q = 0.707) {
  const w0 = 2 * Math.PI * cutoff / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosW0 = Math.cos(w0);

  const b0 = (1 + cosW0) / 2;
  const b1 = -(1 + cosW0);
  const b2 = (1 + cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;

  return {
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
    a1: a1 / a0, a2: a2 / a0,
  };
}

/**
 * Apply a biquad filter to a Float32Array.
 * @param {Float32Array} data - Input samples.
 * @param {Object} coeffs - Filter coefficients { b0, b1, b2, a1, a2 }.
 * @returns {Float32Array} Filtered samples.
 */
function applyBiquad(data, coeffs) {
  const { b0, b1, b2, a1, a2 } = coeffs;
  const out = new Float32Array(data.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }

  return out;
}

// ---- Resampling ----

/**
 * Resample audio using linear interpolation.
 * @param {Float32Array} data - Input audio.
 * @param {number} inputSampleRate
 * @param {number} outputSampleRate
 * @returns {Float32Array} Resampled audio.
 */
function resample(data, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) {
    return data.slice();
  }
  const ratio = outputSampleRate / inputSampleRate;
  const outLen = Math.round(data.length * ratio);
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const idx = i / ratio;
    const lo = Math.floor(idx);
    const frac = idx - lo;
    const hi = Math.min(lo + 1, data.length - 1);
    out[i] = data[lo] * (1 - frac) + data[hi] * frac;
  }

  return out;
}

/**
 * High-quality resampling using a simple windowed sinc approach (basic).
 * For most use cases, linear interpolation above is sufficient.
 * @param {Float32Array} data
 * @param {number} inputSampleRate
 * @param {number} outputSampleRate
 * @returns {Float32Array}
 */
function resampleHQ(data, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) {
    return data.slice();
  }

  // Downsampling: apply low-pass filter first (anti-aliasing)
  let processed = data;
  if (outputSampleRate < inputSampleRate) {
    const cutoff = outputSampleRate * 0.45;
    const coeffs = designLowPass(cutoff, inputSampleRate, 0.707);
    processed = applyBiquad(processed, coeffs);
  }

  return resample(processed, inputSampleRate, outputSampleRate);
}

// ---- Mixing ----

/**
 * Mix multiple audio buffers by summing with optional per-channel gains.
 * @param {Float32Array[]} buffers
 * @param {number[]} [gains]
 * @returns {Float32Array}
 */
function mix(buffers, gains) {
  if (buffers.length === 0) return new Float32Array(0);
  const len = buffers[0].length;
  const out = new Float32Array(len);

  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    const g = (gains && gains[i] !== undefined) ? gains[i] : 1.0;
    for (let j = 0; j < len && j < buf.length; j++) {
      out[j] += buf[j] * g;
    }
  }
  return out;
}

// ---- Filtering ----

/**
 * Apply a low-pass filter to audio data.
 * @param {Float32Array} data
 * @param {number} cutoff - Cutoff frequency in Hz.
 * @param {number} sampleRate
 * @param {number} [q=0.707]
 * @returns {Float32Array}
 */
function lowPass(data, cutoff, sampleRate, q = 0.707) {
  const coeffs = designLowPass(cutoff, sampleRate, q);
  return applyBiquad(data, coeffs);
}

/**
 * Apply a high-pass filter to audio data.
 * @param {Float32Array} data
 * @param {number} cutoff - Cutoff frequency in Hz.
 * @param {number} sampleRate
 * @param {number} [q=0.707]
 * @returns {Float32Array}
 */
function highPass(data, cutoff, sampleRate, q = 0.707) {
  const coeffs = designHighPass(cutoff, sampleRate, q);
  return applyBiquad(data, coeffs);
}

/**
 * Apply a simple gain to the audio data.
 * @param {Float32Array} data
 * @param {number} gain - Gain factor.
 * @returns {Float32Array}
 */
function applyGain(data, gain) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] * gain;
  }
  return out;
}

/**
 * Normalise audio data to peak amplitude = 1.0.
 * @param {Float32Array} data
 * @returns {Float32Array}
 */
function normalize(data) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > peak) peak = abs;
  }
  if (peak === 0) return data.slice();
  const gain = 1.0 / peak;
  return applyGain(data, gain);
}

// ---- Message handler ----

self.onmessage = function (e) {
  const { type, id, data, ...params } = e.data;

  try {
    let result;

    switch (type) {
      case 'resample': {
        const input = new Float32Array(data);
        result = resample(input, params.inputSampleRate, params.outputSampleRate);
        break;
      }
      case 'resampleHQ': {
        const input = new Float32Array(data);
        result = resampleHQ(input, params.inputSampleRate, params.outputSampleRate);
        break;
      }
      case 'lowpass': {
        const input = new Float32Array(data);
        result = lowPass(input, params.cutoff, params.sampleRate, params.q);
        break;
      }
      case 'highpass': {
        const input = new Float32Array(data);
        result = highPass(input, params.cutoff, params.sampleRate, params.q);
        break;
      }
      case 'gain': {
        const input = new Float32Array(data);
        result = applyGain(input, params.gain);
        break;
      }
      case 'normalize': {
        const input = new Float32Array(data);
        result = normalize(input);
        break;
      }
      case 'mix': {
        // data is an array of Float32Array buffers
        const buffers = data.map((buf) => new Float32Array(buf));
        result = mix(buffers, params.gains);
        break;
      }
      case 'convertToMono': {
        const input = new Float32Array(data);
        const numChannels = params.numChannels || 1;
        const numFrames = Math.floor(input.length / numChannels);
        const mono = new Float32Array(numFrames);
        for (let i = 0; i < numFrames; i++) {
          let sum = 0;
          for (let ch = 0; ch < numChannels; ch++) {
            sum += input[i * numChannels + ch];
          }
          mono[i] = sum / numChannels;
        }
        result = mono;
        break;
      }
      case 'convertToStereo': {
        const input = new Float32Array(data);
        const stereo = new Float32Array(input.length * 2);
        for (let i = 0; i < input.length; i++) {
          stereo[i * 2] = input[i];
          stereo[i * 2 + 1] = input[i];
        }
        result = stereo;
        break;
      }
      case 'ping': {
        // Simple health check
        self.postMessage({ type: 'pong', id });
        return;
      }
      default:
        throw new Error(`Unknown audio worker command: ${type}`);
    }

    // Transfer the result buffer back if it's a Float32Array
    if (result instanceof Float32Array) {
      self.postMessage(
        { type: 'result', id, originalType: type },
        { transfer: [result.buffer] }
      );
    } else {
      self.postMessage({ type: 'result', id, originalType: type, data: result });
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      originalType: type,
      error: err.message,
    });
  }
};