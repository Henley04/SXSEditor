/**
 * ortSetup.js
 * ONNX Runtime Web setup for SXSEditor-Pad.
 *
 * Dynamically imports onnxruntime-web, configures WASM paths,
 * and provides a singleton initOrt() function.
 *
 * @module inference/webnn/ortSetup
 */

import { LOG_PREFIX } from '../pipeline/constants.js';

/** @type {import('onnxruntime-web') | null} */
let ortModule = null;

/** @type {boolean} */
let isInitializing = false;

/** @type {Promise<import('onnxruntime-web')> | null} */
let initPromise = null;

/**
 * CDN base URL for ONNX Runtime Web WASM files.
 * In production, these should be bundled or served from a local path.
 */
const WASM_CDN_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';

/**
 * Initialise the ONNX Runtime Web module.
 *
 * This function is idempotent — it will only load the module once and
 * return the same instance on subsequent calls.
 *
 * @param {object} [options] - Optional configuration overrides
 * @param {string} [options.wasmBase] - Custom WASM base URL (overrides CDN default)
 * @param {boolean} [options.logging=true] - Enable logging
 * @returns {Promise<import('onnxruntime-web')>} The ort module
 */
export async function initOrt(options = {}) {
  if (ortModule) {
    return ortModule;
  }

  if (isInitializing && initPromise) {
    return initPromise;
  }

  isInitializing = true;

  initPromise = (async () => {
    const { wasmBase, logging = true } = options;

    try {
      // Dynamically import onnxruntime-web
      const ort = await import('onnxruntime-web');

      // Configure WASM paths
      if (wasmBase) {
        ort.env.wasm.wasmPaths = wasmBase;
      } else {
        ort.env.wasm.wasmPaths = WASM_CDN_BASE;
      }

      // Configure logging
      if (logging) {
        ort.env.logLevel = 'verbose';
        console.log(`${LOG_PREFIX} ONNX Runtime Web initialised`);
        console.log(`${LOG_PREFIX} ort version:`, ort.env?.versions?.ort || 'unknown');
        console.log(`${LOG_PREFIX} WASM paths:`, ort.env.wasm.wasmPaths);
      }

      ortModule = ort;
      isInitializing = false;
      return ort;
    } catch (err) {
      isInitializing = false;
      initPromise = null;
      console.error(`${LOG_PREFIX} Failed to initialise ONNX Runtime Web:`, err);
      throw new Error(`ONNX Runtime Web initialisation failed: ${err.message}`);
    }
  })();

  return initPromise;
}

/**
 * Check whether ONNX Runtime has been initialised.
 * @returns {boolean}
 */
export function isOrtReady() {
  return ortModule !== null;
}

/**
 * Get the ort module if already initialised, or null.
 * @returns {import('onnxruntime-web') | null}
 */
export function getOrt() {
  return ortModule;
}

/**
 * Reset the ort module (useful for testing / hot-reload).
 */
export function resetOrt() {
  ortModule = null;
  isInitializing = false;
  initPromise = null;
}

export default {
  initOrt,
  isOrtReady,
  getOrt,
  resetOrt,
};