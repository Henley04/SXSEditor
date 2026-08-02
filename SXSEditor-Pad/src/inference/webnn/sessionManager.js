/**
 * sessionManager.js
 * ONNX Runtime session manager for SXSEditor-Pad.
 *
 * Creates and manages multiple InferenceSession instances,
 * caches them by model ID, and supports WebNN, WebGL, WebGPU, and WASM
 * execution providers.
 *
 * @module inference/webnn/sessionManager
 */

import { LOG_PREFIX, EP_PRIORITY } from '../pipeline/constants.js';
import { initOrt } from './ortSetup.js';

/**
 * @typedef {Object} SessionMeta
 * @property {import('onnxruntime-web').InferenceSession} session
 * @property {string} modelId
 * @property {string[]} inputNames
 * @property {string[]} outputNames
 * @property {string} ep - Execution provider used
 * @property {number} createdAt - Timestamp
 * @property {number} [lastUsedAt] - Timestamp of last inference
 */

/** @type {Map<string, SessionMeta>} */
const sessionCache = new Map();

/**
 * Resolve the list of execution providers to try, in priority order.
 * WebNN is preferred when available (Tauri webview on Windows with NPU),
 * falling back to WebGPU, then WASM.
 *
 * @param {'webnn'|'webgpu'|'wasm'|'auto'} [preferred='auto']
 * @returns {import('onnxruntime-web').ExecutionProviderConfig[]}
 */
function resolveExecutionProviders(preferred = 'auto') {
  if (preferred !== 'auto') {
    return [{ name: preferred }];
  }

  return EP_PRIORITY.map((name) => ({ name }));
}

/**
 * Create a new ONNX Runtime InferenceSession.
 *
 * @param {string} modelId - Unique identifier for the model (used for caching)
 * @param {Uint8Array} modelData - The ONNX model binary data
 * @param {object} [options] - Session options
 * @param {'webnn'|'webgpu'|'wasm'|'auto'} [options.preferredEP='auto'] - Preferred execution provider
 * @param {import('onnxruntime-web').InferenceSession.SessionOptions} [options.extra] - Extra ort session options
 * @returns {Promise<SessionMeta>}
 */
export async function createSession(modelId, modelData, options = {}) {
  const { preferredEP = 'auto', extra = {} } = options;

  // If session already exists, return it
  const existing = sessionCache.get(modelId);
  if (existing) {
    console.log(`${LOG_PREFIX} Reusing cached session for "${modelId}"`);
    return existing;
  }

  const ort = await initOrt();

  const executionProviders = resolveExecutionProviders(preferredEP);

  console.log(`${LOG_PREFIX} Creating session "${modelId}" with EP:`, executionProviders.map((ep) => ep.name).join(', '));

  let session;
  let usedEP = 'wasm'; // fallback

  // Try each execution provider in order
  for (const ep of executionProviders) {
    try {
      session = await ort.InferenceSession.create(modelData, {
        executionProviders: [ep],
        ...extra,
      });
      usedEP = ep.name;
      console.log(`${LOG_PREFIX} Session "${modelId}" created with EP: ${usedEP}`);
      break;
    } catch (err) {
      console.warn(`${LOG_PREFIX} EP "${ep.name}" failed for "${modelId}":`, err.message);
    }
  }

  if (!session) {
    throw new Error(
      `Failed to create session "${modelId}" with any execution provider. ` +
      `Tried: ${executionProviders.map((ep) => ep.name).join(', ')}`
    );
  }

  // Collect input/output names
  const inputNames = Array.from(session.inputNames);
  const outputNames = Array.from(session.outputNames);

  /** @type {SessionMeta} */
  const meta = {
    modelId,
    session,
    inputNames,
    outputNames,
    ep: usedEP,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };

  sessionCache.set(modelId, meta);
  return meta;
}

/**
 * Get a cached session by model ID.
 *
 * @param {string} modelId
 * @returns {SessionMeta | null}
 */
export function getSession(modelId) {
  const meta = sessionCache.get(modelId);
  if (meta) {
    meta.lastUsedAt = Date.now();
  }
  return meta || null;
}

/**
 * Release (delete) a specific session from the cache.
 * Calls session.release() if available to free GPU memory.
 *
 * @param {string} modelId
 * @returns {Promise<boolean>} Whether the session was found and released
 */
export async function releaseSession(modelId) {
  const meta = sessionCache.get(modelId);
  if (!meta) {
    return false;
  }

  try {
    if (typeof meta.session.release === 'function') {
      await meta.session.release();
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error releasing session "${modelId}":`, err.message);
  }

  sessionCache.delete(modelId);
  console.log(`${LOG_PREFIX} Released session "${modelId}"`);
  return true;
}

/**
 * Release all cached sessions.
 * @returns {Promise<void>}
 */
export async function releaseAll() {
  const ids = Array.from(sessionCache.keys());
  await Promise.all(ids.map((id) => releaseSession(id)));
  console.log(`${LOG_PREFIX} All sessions released (${ids.length} total)`);
}

/**
 * Get the number of currently cached sessions.
 * @returns {number}
 */
export function getSessionCount() {
  return sessionCache.size;
}

/**
 * Get a list of all cached model IDs.
 * @returns {string[]}
 */
export function getCachedModelIds() {
  return Array.from(sessionCache.keys());
}

/**
 * Check if a session exists in the cache.
 * @param {string} modelId
 * @returns {boolean}
 */
export function hasSession(modelId) {
  return sessionCache.has(modelId);
}

export default {
  createSession,
  getSession,
  releaseSession,
  releaseAll,
  getSessionCount,
  getCachedModelIds,
  hasSession,
};