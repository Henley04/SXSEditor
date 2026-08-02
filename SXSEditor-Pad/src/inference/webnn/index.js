/**
 * webnn/index.js
 * WebNN inference entry point for SXSEditor-Pad.
 *
 * Provides model loading, inference execution, status reporting,
 * and NPU detection via the WebNN API.
 *
 * @module inference/webnn
 */

import { initOrt, getOrt, isOrtReady } from './ortSetup.js';
import { createSession, getSession, releaseSession, releaseAll } from './sessionManager.js';
import { LOG_PREFIX, MODEL_IDS } from '../pipeline/constants.js';
import { loadModelFromFilesystem } from '../pipeline/modelLoader.js';

/**
 * @typedef {Object} BackendStatus
 * @property {boolean} ortReady - ONNX Runtime initialised
 * @property {boolean} webnnAvailable - WebNN API available
 * @property {string|null} npuDevice - NPU device name (if detected)
 * @property {string[]} activeModels - Currently loaded model IDs
 * @property {string} activeEP - Active execution provider
 */

// ==================== WebNN / NPU Detection ====================

/**
 * Detect whether the WebNN API is available in the current browser.
 * WebNN is available as navigator.ml in supported browsers (Edge, Chrome).
 *
 * @returns {boolean}
 */
export function isWebNNAvailable() {
  return typeof navigator !== 'undefined' && navigator.ml !== undefined;
}

/**
 * Detect NPU (Neural Processing Unit) availability via the WebNN API.
 *
 * @returns {Promise<{ available: boolean, device: string | null }>}
 */
export async function detectNPU() {
  if (!isWebNNAvailable()) {
    return { available: false, device: null };
  }

  try {
    const context = await navigator.ml.createContext({ deviceType: 'npu' });
    // If we get here, NPU is available
    const deviceName = 'NPU (WebNN)';
    console.log(`${LOG_PREFIX} NPU detected via WebNN: ${deviceName}`);
    return { available: true, device: deviceName };
  } catch (err) {
    console.log(`${LOG_PREFIX} NPU not available via WebNN:`, err.message);
    return { available: false, device: null };
  }
}

/**
 * Get the best available execution provider.
 *
 * @returns {Promise<'webnn'|'webgpu'|'wasm'>}
 */
export async function getBestEP() {
  // Check WebNN first (NPU)
  const npu = await detectNPU();
  if (npu.available) {
    return 'webnn';
  }

  // Check WebGPU
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        return 'webgpu';
      }
    } catch {
      // Fall through
    }
  }

  return 'wasm';
}

// ==================== Model Loading ====================

/**
 * Load an ONNX model into a session.
 *
 * @param {string} modelId - Model identifier
 * @param {Uint8Array} modelData - Raw ONNX model bytes
 * @param {object} [options] - Session creation options
 * @returns {Promise<object>} Session metadata
 */
export async function loadModel(modelId, modelData, options = {}) {
  console.log(`${LOG_PREFIX} Loading model: ${modelId}`);

  const ort = await initOrt();

  // Determine best EP if not specified
  if (!options.preferredEP || options.preferredEP === 'auto') {
    options.preferredEP = await getBestEP();
  }

  const meta = await createSession(modelId, modelData, options);
  return meta;
}

/**
 * Unload a model and release its session.
 *
 * @param {string} modelId
 * @returns {Promise<boolean>}
 */
export async function unloadModel(modelId) {
  return releaseSession(modelId);
}

// ==================== Inference ====================

/**
 * Run inference on a loaded model.
 *
 * @param {string} modelId - Model identifier (must be loaded)
 * @param {object} feeds - Input tensor feeds (name → Tensor)
 * @returns {Promise<import('onnxruntime-web').InferenceSession.OnnxValueMap>}
 */
export async function runInference(modelId, feeds) {
  const meta = getSession(modelId);
  if (!meta) {
    throw new Error(`Model "${modelId}" is not loaded. Call loadModel() first.`);
  }

  const ort = getOrt();
  if (!ort) {
    throw new Error('ONNX Runtime not initialised');
  }

  try {
    const results = await meta.session.run(feeds);
    return results;
  } catch (err) {
    console.error(`${LOG_PREFIX} Inference failed for "${modelId}":`, err);
    throw err;
  }
}

// ==================== Status ====================

/**
 * Get the current inference backend status.
 *
 * @returns {Promise<BackendStatus>}
 */
export async function getStatus() {
  const npu = await detectNPU();
  const ortReady = isOrtReady();

  let activeEP = 'none';
  if (ortReady) {
    // Check which EP is in use by looking at any active session
    const { getCachedModelIds, getSession } = await import('./sessionManager.js');
    const ids = getCachedModelIds();
    if (ids.length > 0) {
      const firstSession = getSession(ids[0]);
      if (firstSession) {
        activeEP = firstSession.ep;
      }
    } else {
      activeEP = 'initialised';
    }
  }

  return {
    ortReady,
    webnnAvailable: isWebNNAvailable(),
    npuDevice: npu.device,
    activeModels: ortReady ? (await import('./sessionManager.js')).getCachedModelIds() : [],
    activeEP,
  };
}

/**
 * Initialise the WebNN inference backend.
 *
 * @param {object} [options] - Options passed to initOrt
 * @returns {Promise<{ success: boolean, ep: string, npu: object }>}
 */
export async function initWebNN(options = {}) {
  console.log(`${LOG_PREFIX} Initialising WebNN inference backend...`);

  try {
    await initOrt(options);
    const bestEP = await getBestEP();
    const npu = await detectNPU();

    console.log(`${LOG_PREFIX} WebNN backend initialised. Best EP: ${bestEP}, NPU: ${npu.available}`);

    return {
      success: true,
      ep: bestEP,
      npu,
    };
  } catch (err) {
    console.error(`${LOG_PREFIX} WebNN backend initialisation failed:`, err);
    return {
      success: false,
      ep: 'none',
      npu: { available: false, device: null },
    };
  }
}

export default {
  isWebNNAvailable,
  detectNPU,
  getBestEP,
  loadModel,
  unloadModel,
  runInference,
  getStatus,
  initWebNN,
};