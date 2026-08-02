/**
 * utils.js
 * Utility functions for the SXSEditor-Pad inference pipeline.
 *
 * @module inference/pipeline/utils
 */

/**
 * Build the full path to a model file, given a directory and a name.
 * @param {string} modelDir - Base directory for models
 * @param {string} name - Model name (without extension)
 * @returns {{ onnx: string, data?: string }} Paths to the .onnx and optional .onnx.data files
 */
export function getModelPath(modelDir, name) {
  const paths = {
    onnx: `${modelDir}/${name}.onnx`,
  };
  // Sharded models produce a .onnx.data file alongside the .onnx
  const dataPath = `${modelDir}/${name}.onnx.data`;
  // We return the data path — the caller decides whether it exists
  paths.data = dataPath;
  return paths;
}

/**
 * Validate that the required model files exist.
 * @param {Array<{ name: string, exists: boolean }>} files - File existence checks
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateModelFiles(files) {
  const missing = files
    .filter((f) => !f.exists)
    .map((f) => f.name);

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Create an ONNX Runtime Tensor.
 * Wraps ort.Tensor to handle type coercion safely.
 *
 * @param {object} ort - The onnxruntime-web module
 * @param {'float32'|'float64'|'int32'|'int64'|'bool'|'string'} type - Tensor element type
 * @param {import('onnxruntime-web').Tensor.DataType} data - Tensor data (typed array or plain array)
 * @param {number[]} dims - Tensor dimensions
 * @returns {import('onnxruntime-web').Tensor}
 */
export function createTensor(ort, type, data, dims) {
  // Ensure data is the correct typed array for the requested type
  let typedData = data;

  switch (type) {
    case 'float32':
      if (!(data instanceof Float32Array)) {
        typedData = new Float32Array(data);
      }
      break;
    case 'float64':
      if (!(data instanceof Float64Array)) {
        typedData = new Float64Array(data);
      }
      break;
    case 'int32':
      if (!(data instanceof Int32Array)) {
        typedData = new Int32Array(data);
      }
      break;
    case 'int64':
      if (!(data instanceof BigInt64Array)) {
        typedData = BigInt64Array.from(data);
      }
      break;
    case 'bool':
      if (!(data instanceof Uint8Array)) {
        typedData = new Uint8Array(data);
      }
      break;
    default:
      break;
  }

  return new ort.Tensor(type, typedData, dims);
}

/**
 * Deep-clone a Float32Array or regular array.
 * @param {Float32Array|number[]} arr
 * @returns {Float32Array}
 */
export function cloneFloat32Array(arr) {
  if (arr instanceof Float32Array) {
    return new Float32Array(arr);
  }
  return new Float32Array(arr);
}

/**
 * Linearly interpolate between two values.
 * @param {number} a - Start value
 * @param {number} b - End value
 * @param {number} t - Interpolation factor [0, 1]
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Clamp a value between min and max.
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Sleep for a given number of milliseconds.
 * Useful for yielding control back to the browser event loop.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a time value (seconds) to "MM:SS.mmm".
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const ms = (s - Math.floor(s)) * 1000;
  return `${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(Math.round(ms)).padStart(3, '0')}`;
}

/**
 * Check if the current environment is a Tauri webview.
 * @returns {boolean}
 */
export function isTauri() {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

/**
 * Get the Tauri fs plugin if available.
 * @returns {Promise<object|null>}
 */
export async function getTauriFs() {
  if (!isTauri()) return null;
  try {
    const { readFile, stat, exists } = await import('@tauri-apps/plugin-fs');
    return { readFile, stat, exists };
  } catch {
    return null;
  }
}