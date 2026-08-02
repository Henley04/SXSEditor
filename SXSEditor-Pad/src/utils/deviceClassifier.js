/**
 * deviceClassifier.js
 * Device classifier for SXSEditor-Pad.
 * Classifies device type based on name and VRAM for selecting
 * the appropriate execution provider.
 *
 * @module utils/deviceClassifier
 */

/**
 * @typedef {'discrete-gpu' | 'integrated-gpu' | 'npu' | 'cpu'} DeviceCategory
 */

/**
 * @typedef {Object} DeviceInfo
 * @property {string} name - Device name
 * @property {number} vramMB - VRAM in megabytes (0 for CPU/NPU)
 * @property {DeviceCategory} category - Device category
 * @property {string} [vendor] - Optional vendor string
 */

/**
 * Known GPU vendor identifiers for name-based matching.
 */
const VENDOR_PATTERNS = {
  nvidia: /nvidia|geforce|quadro|tesla|rtx|gtx/i,
  amd: /amd|radeon|rx|vega|instinct|firepro/i,
  intel: /intel|iris|arc|uhd|hd graphics/i,
  apple: /apple|m[1-9]|m[1-9]\s*(pro|max|ultra)/i,
  qualcomm: /qualcomm|adreno|snapdragon/i,
  arm: /arm|mali|valhall|bifrost/i,
};

/**
 * VRAM thresholds in MB for classification.
 * Discrete GPUs typically have dedicated VRAM >= 1024MB.
 * Integrated GPUs share system memory and usually report < 1024MB.
 */
const VRAM_THRESHOLDS = {
  discreteGpuMin: 1024,
  integratedGpuMax: 1023,
};

/**
 * Classify a device based on its name and VRAM.
 *
 * @param {string} deviceName - Name of the device
 * @param {number} vramMB - VRAM in megabytes (0 if unknown or not applicable)
 * @returns {DeviceCategory} Classified device category
 */
export function classifyDevice(deviceName, vramMB) {
  if (typeof deviceName !== 'string' || deviceName.length === 0) {
    return 'cpu';
  }

  const effectiveVRAM = Number.isFinite(vramMB) ? Math.max(0, vramMB) : 0;

  // NPU detection: devices with "npu" in name or known NPU patterns
  if (/npu|neural\s*(processing|engine)|ai\s*accelerator|tensor\s*processing/i.test(deviceName)) {
    return 'npu';
  }

  // Apple Silicon Neural Engine is considered an NPU
  if (VENDOR_PATTERNS.apple.test(deviceName) && /neural/i.test(deviceName)) {
    return 'npu';
  }

  // Qualcomm Hexagon NPU
  if (VENDOR_PATTERNS.qualcomm.test(deviceName) && /hexagon|npu/i.test(deviceName)) {
    return 'npu';
  }

  // Discrete GPU: dedicated VRAM >= threshold or known discrete GPU patterns
  if (effectiveVRAM >= VRAM_THRESHOLDS.discreteGpuMin) {
    return 'discrete-gpu';
  }

  // Check for known discrete GPU vendors even if VRAM is low (unreported)
  if (VENDOR_PATTERNS.nvidia.test(deviceName)) {
    return effectiveVRAM >= 512 ? 'discrete-gpu' : 'integrated-gpu';
  }
  if (VENDOR_PATTERNS.amd.test(deviceName)) {
    return effectiveVRAM >= 512 ? 'discrete-gpu' : 'integrated-gpu';
  }

  // Integrated GPU: known integrated GPU patterns or low VRAM
  if (VENDOR_PATTERNS.intel.test(deviceName)) {
    return 'integrated-gpu';
  }

  // Apple Silicon (M-series) has unified memory, treat as integrated GPU
  if (VENDOR_PATTERNS.apple.test(deviceName)) {
    return 'integrated-gpu';
  }

  // Qualcomm Adreno is integrated
  if (VENDOR_PATTERNS.qualcomm.test(deviceName)) {
    return 'integrated-gpu';
  }

  // ARM Mali and other mobile GPUs
  if (VENDOR_PATTERNS.arm.test(deviceName)) {
    return 'integrated-gpu';
  }

  // If VRAM is reported but very low (< 512MB), it's likely integrated
  if (effectiveVRAM > 0 && effectiveVRAM < 512) {
    return 'integrated-gpu';
  }

  // Fallback: if VRAM unreported and no known GPU patterns, treat as CPU
  return 'cpu';
}

/**
 * Get the recommended execution provider for a device category.
 *
 * @param {DeviceCategory} category - Device category
 * @returns {string[]} Ordered array of recommended execution providers
 */
export function getRecommendedProviders(category) {
  switch (category) {
    case 'discrete-gpu':
      return ['dml', 'webgpu', 'wasm'];
    case 'integrated-gpu':
      return ['webgpu', 'wasm'];
    case 'npu':
      return ['webnn', 'wasm'];
    case 'cpu':
    default:
      return ['wasm'];
  }
}

/**
 * Parse device info from a WebGPU adapter or system description.
 *
 * @param {string} name - Device name
 * @param {number} [vramMB=0] - VRAM in megabytes
 * @returns {DeviceInfo} Parsed device info
 */
export function parseDeviceInfo(name, vramMB = 0) {
  const category = classifyDevice(name, vramMB);
  let vendor = 'unknown';

  for (const [v, pattern] of Object.entries(VENDOR_PATTERNS)) {
    if (pattern.test(name)) {
      vendor = v;
      break;
    }
  }

  return {
    name,
    vramMB: Number.isFinite(vramMB) ? Math.max(0, vramMB) : 0,
    category,
    vendor,
  };
}

export default {
  classifyDevice,
  getRecommendedProviders,
  parseDeviceInfo,
};