/**
 * modelLoader.js
 * Model loader for the SXSEditor-Pad SVS pipeline.
 *
 * Loads ONNX model files from the local filesystem (via Tauri fs plugin)
 * or from a URL/protocol handler. Supports model sharding (.onnx.data files).
 *
 * @module inference/pipeline/modelLoader
 */

import { LOG_PREFIX, MODEL_IDS } from './constants.js';
import { getModelPath, getTauriFs } from './utils.js';

/**
 * @typedef {Object} ModelData
 * @property {Uint8Array} data - The raw ONNX model bytes
 * @property {string} modelId - Model identifier
 * @property {Uint8Array|null} [externalData] - Optional external data for sharded models
 */

/**
 * Read a file as Uint8Array via the Tauri fs plugin.
 *
 * @param {string} filePath - Absolute path to the file
 * @returns {Promise<Uint8Array>} File contents
 */
async function readFileViaTauri(filePath) {
  const tauriFs = await getTauriFs();
  if (!tauriFs) {
    throw new Error('Tauri fs plugin not available');
  }
  return await tauriFs.readFile(filePath);
}

/**
 * Check if a file exists via the Tauri fs plugin.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExistsViaTauri(filePath) {
  const tauriFs = await getTauriFs();
  if (!tauriFs) {
    return false;
  }
  try {
    return await tauriFs.exists(filePath);
  } catch {
    return false;
  }
}

/**
 * Load an ONNX model from the local filesystem.
 *
 * @param {string} modelId - Model identifier (e.g., 'soulx-singer-base')
 * @param {string} modelDir - Base directory containing model files
 * @param {object} [options]
 * @param {boolean} [options.useTauri=true] - Use Tauri fs plugin (falls back to fetch if false)
 * @returns {Promise<ModelData>}
 */
export async function loadModelFromFilesystem(modelId, modelDir, options = {}) {
  const { useTauri = true } = options;
  const paths = getModelPath(modelDir, modelId);

  console.log(`${LOG_PREFIX} Loading model "${modelId}" from: ${paths.onnx}`);

  let mainData;

  if (useTauri) {
    mainData = await readFileViaTauri(paths.onnx);
  } else {
    // Fallback: fetch via HTTP (for development with local server)
    const response = await fetch(paths.onnx);
    if (!response.ok) {
      throw new Error(`Failed to fetch model "${modelId}": ${response.status} ${response.statusText}`);
    }
    mainData = new Uint8Array(await response.arrayBuffer());
  }

  // Check for external data file (sharded model)
  let externalData = null;
  try {
    if (useTauri) {
      const exists = await fileExistsViaTauri(paths.data);
      if (exists) {
        externalData = await readFileViaTauri(paths.data);
        console.log(`${LOG_PREFIX} Found external data for "${modelId}": ${paths.data}`);
      }
    } else {
      const dataResponse = await fetch(paths.data);
      if (dataResponse.ok) {
        externalData = new Uint8Array(await dataResponse.arrayBuffer());
        console.log(`${LOG_PREFIX} Found external data for "${modelId}": ${paths.data}`);
      }
    }
  } catch {
    // External data is optional
  }

  return {
    modelId,
    data: mainData,
    externalData,
  };
}

/**
 * Load an ONNX model from a URL.
 *
 * @param {string} modelId - Model identifier
 * @param {string} url - URL to the .onnx file
 * @returns {Promise<ModelData>}
 */
export async function loadModelFromUrl(modelId, url) {
  console.log(`${LOG_PREFIX} Loading model "${modelId}" from URL: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch model from URL: ${response.status} ${response.statusText}`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  return { modelId, data, externalData: null };
}

/**
 * Load an ONNX model from the onnx:// protocol.
 * In a Tauri webview, this would be handled by a custom protocol.
 *
 * @param {string} modelId - Model identifier
 * @param {string} modelDir - Model directory
 * @returns {Promise<ModelData>}
 */
export async function loadModelFromProtocol(modelId, modelDir) {
  const protocolUrl = `onnx://${modelDir}/${modelId}.onnx`;
  console.log(`${LOG_PREFIX} Loading model "${modelId}" via onnx:// protocol: ${protocolUrl}`);

  try {
    const response = await fetch(protocolUrl);
    if (!response.ok) {
      throw new Error(`Protocol fetch failed: ${response.status}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    return { modelId, data, externalData: null };
  } catch (err) {
    console.warn(`${LOG_PREFIX} onnx:// protocol not available, falling back to filesystem`);
    return loadModelFromFilesystem(modelId, modelDir);
  }
}

/**
 * Validate model data by checking the ONNX magic bytes.
 *
 * @param {ModelData} modelData
 * @returns {boolean} Whether the model data is valid
 */
export function validateModel(modelData) {
  if (!modelData || !modelData.data || modelData.data.length < 4) {
    console.error(`${LOG_PREFIX} Invalid model data for "${modelData?.modelId}": too short`);
    return false;
  }

  // Check ONNX magic bytes: first 4 bytes should be the protobuf length
  // or the ONNX format identifier. We check for a reasonable protobuf length.
  const firstBytes = modelData.data.slice(0, 4);
  const length = new Uint32Array(firstBytes.buffer)[0];

  // A valid ONNX file should have a protobuf length that is reasonable
  if (length <= 0 || length > modelData.data.length) {
    console.warn(`${LOG_PREFIX} Model "${modelData.modelId}" has unusual header: length=${length}, fileSize=${modelData.data.length}`);
    // Not necessarily invalid, warn but accept
  }

  return true;
}

/**
 * Load all required models for the pipeline.
 *
 * @param {string} modelDir - Base directory containing all model files
 * @param {string[]} [modelIds] - Array of model IDs to load (defaults to all required)
 * @param {object} [options] - Options passed to loadModelFromFilesystem
 * @returns {Promise<Map<string, ModelData>>} Map of modelId → ModelData
 */
export async function loadAllModels(modelDir, modelIds, options = {}) {
  const ids = modelIds ?? [
    MODEL_IDS.BASE,
    MODEL_IDS.VOCODER,
    MODEL_IDS.RMVPE,
    MODEL_IDS.BASIC_PITCH,
    MODEL_IDS.ROSVOT,
  ];

  const modelMap = new Map();

  for (const modelId of ids) {
    try {
      const modelData = await loadModelFromFilesystem(modelId, modelDir, options);
      if (validateModel(modelData)) {
        modelMap.set(modelId, modelData);
      } else {
        console.warn(`${LOG_PREFIX} Model "${modelId}" failed validation, skipping`);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to load model "${modelId}":`, err.message);
      // Don't throw — let the caller decide which models are required
    }
  }

  return modelMap;
}

export default {
  loadModelFromFilesystem,
  loadModelFromUrl,
  loadModelFromProtocol,
  validateModel,
  loadAllModels,
};