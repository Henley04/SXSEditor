/**
 * pipeline/index.js
 * Main pipeline orchestration for the SXSEditor-Pad SVS inference.
 *
 * Coordinates model loading, preprocessing, diffusion, vocoding,
 * and postprocessing. Provides enumerateDMLDevices for device discovery.
 *
 * @module inference/pipeline
 */

import { initOrt, isOrtReady } from '../webnn/ortSetup.js';
import { createSession, getSession, releaseAll, releaseSession } from '../webnn/sessionManager.js';
import { LOG_PREFIX, MODEL_IDS, DEFAULT_DIFFUSION_STEPS, DEFAULT_CFG_SCALE } from './constants.js';
import { loadModelFromFilesystem, loadAllModels, validateModel } from './modelLoader.js';
import { prepareInputs, textToPhonemes, processPitch, processDurations, expandPhonemesToFrames } from './preprocessing.js';
import { melToAudio, normalizeAudio, formatOutput, samplesToWav } from './postprocessing.js';
import { runDiffusion, generateNoiseLatent } from './diffusion.js';
import { processSegmented } from './audioSegmentation.js';
import { getCFGScaleSchedule } from './cfgSchedule.js';
import { calculateDurationStats, getDurationPercentile } from './durationStats.js';
import { loudnorm, measureLUFS } from './loudnorm.js';
import { getTauriFs } from './utils.js';

/**
 * @typedef {Object} SynthesisResult
 * @property {Float32Array} samples - Audio waveform
 * @property {number} sampleRate - Sample rate (44100)
 * @property {number} duration - Duration in seconds
 * @property {number} segments - Number of segments processed
 */

/**
 * @typedef {Object} PipelineStatus
 * @property {boolean} ready - Whether the pipeline is initialised
 * @property {string[]} loadedModels - Currently loaded model IDs
 * @property {string} activeEP - Active execution provider
 */

// ==================== Device Enumeration ====================

/**
 * Enumerate available DML (DirectML) / compute devices.
 *
 * In a Tauri webview, this queries the available GPU/NPU devices
 * via WebNN or WebGPU APIs.
 *
 * @returns {Promise<Array<{ id: string, name: string, type: string, available: boolean }>>}
 */
export async function enumerateDMLDevices() {
  const devices = [];

  // 1. WASM is always available
  devices.push({
    id: 'wasm',
    name: 'CPU (WASM)',
    type: 'cpu',
    available: true,
  });

  // 2. WebGPU
  let webgpuAvailable = false;
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info || {};
        devices.push({
          id: 'webgpu',
          name: info.description || `GPU (WebGPU: ${info.vendor || 'unknown'})`,
          type: 'gpu',
          available: true,
        });
        webgpuAvailable = true;
      }
    } catch {
      // WebGPU not available
    }
  }

  if (!webgpuAvailable) {
    devices.push({
      id: 'webgpu',
      name: 'GPU (WebGPU)',
      type: 'gpu',
      available: false,
    });
  }

  // 3. WebNN / NPU
  if (typeof navigator !== 'undefined' && navigator.ml) {
    try {
      // Try NPU
      const npuContext = await navigator.ml.createContext({ deviceType: 'npu' });
      devices.push({
        id: 'webnn-npu',
        name: 'NPU (WebNN)',
        type: 'npu',
        available: true,
      });
    } catch {
      devices.push({
        id: 'webnn-npu',
        name: 'NPU (WebNN)',
        type: 'npu',
        available: false,
      });
    }

    try {
      // Try GPU via WebNN
      const gpuContext = await navigator.ml.createContext({ deviceType: 'gpu' });
      devices.push({
        id: 'webnn-gpu',
        name: 'GPU (WebNN)',
        type: 'gpu',
        available: true,
      });
    } catch {
      devices.push({
        id: 'webnn-gpu',
        name: 'GPU (WebNN)',
        type: 'gpu',
        available: false,
      });
    }
  }

  return devices;
}

// ==================== Pipeline Class ====================

/**
 * SVS Pipeline — orchestrates the full synthesis workflow.
 */
export class SVSPipeline {
  constructor() {
    /** @type {boolean} */
    this.initialised = false;

    /** @type {Map<string, object>} */
    this.models = new Map();

    /** @type {string} */
    this.modelDir = '';

    /** @type {object|null} */
    this.ort = null;
  }

  /**
   * Initialise the pipeline: load ONNX Runtime and all required models.
   *
   * @param {string} modelDir - Directory containing model files
   * @param {object} [options]
   * @param {string[]} [options.models] - Specific models to load
   * @param {Function} [options.onProgress] - Progress callback (modelId, current, total)
   * @returns {Promise<boolean>}
   */
  async init(modelDir, options = {}) {
    const { models, onProgress } = options;

    console.log(`${LOG_PREFIX} Initialising pipeline with model dir: ${modelDir}`);
    this.modelDir = modelDir;

    try {
      // Initialise ONNX Runtime
      this.ort = await initOrt();
      console.log(`${LOG_PREFIX} ONNX Runtime initialised`);

      // Load models
      const modelIds = models ?? [
        MODEL_IDS.BASE,
        MODEL_IDS.VOCODER,
      ];

      for (let i = 0; i < modelIds.length; i++) {
        const modelId = modelIds[i];
        try {
          const modelData = await loadModelFromFilesystem(modelId, modelDir);
          if (validateModel(modelData)) {
            const meta = await createSession(modelId, modelData.data);
            this.models.set(modelId, meta);
            console.log(`${LOG_PREFIX} Loaded model: ${modelId} (EP: ${meta.ep})`);
          }
        } catch (err) {
          console.error(`${LOG_PREFIX} Failed to load model "${modelId}":`, err.message);
        }

        if (onProgress) {
          onProgress(modelId, i + 1, modelIds.length);
        }
      }

      this.initialised = true;
      console.log(`${LOG_PREFIX} Pipeline initialised with ${this.models.size} models`);
      return true;
    } catch (err) {
      console.error(`${LOG_PREFIX} Pipeline initialisation failed:`, err);
      this.initialised = false;
      return false;
    }
  }

  /**
   * Run full synthesis from text and pitch data.
   *
   * @param {object} params
   * @param {string} params.text - Input text
   * @param {Float32Array} params.f0 - F0 contour (Hz per frame)
   * @param {number[]} params.durations - Phoneme durations (frames)
   * @param {number[]} params.phonemeIds - Phoneme IDs (optional, auto-computed from text if omitted)
   * @param {number} [params.speakerId=0] - Speaker ID
   * @param {number} [params.diffusionSteps=50] - Diffusion steps
   * @param {number} [params.cfgScale=2.0] - CFG scale
   * @param {'euler'|'heun'|'dpm'|'stork2'} [params.sampler='euler'] - Sampler
   * @param {Function} [params.onProgress] - Progress callback (step, total, message)
   * @returns {Promise<SynthesisResult>}
   */
  async synthesize(params) {
    if (!this.initialised) {
      throw new Error('Pipeline not initialised. Call init() first.');
    }

    const {
      text,
      f0,
      durations,
      phonemeIds: explicitPhonemes,
      speakerId = 0,
      diffusionSteps = DEFAULT_DIFFUSION_STEPS,
      cfgScale = DEFAULT_CFG_SCALE,
      sampler = 'euler',
      onProgress,
    } = params;

    const ort = this.ort;
    const baseSession = getSession(MODEL_IDS.BASE);
    const vocoderSession = getSession(MODEL_IDS.VOCODER);

    if (!baseSession) {
      throw new Error(`Base model "${MODEL_IDS.BASE}" not loaded`);
    }
    if (!vocoderSession) {
      throw new Error(`Vocoder model "${MODEL_IDS.VOCODER}" not loaded`);
    }

    // Step 1: Text → phonemes
    if (onProgress) onProgress(1, 6, 'Converting text to phonemes...');
    const phonemeIds = explicitPhonemes || await textToPhonemes(text);

    if (onProgress) onProgress(2, 6, 'Preparing inputs...');

    // Step 2: Prepare inputs
    const inputs = prepareInputs(ort, {
      phonemeIds,
      durations,
      f0,
      speakerId,
    });

    // Step 3: Run the acoustic model to get mel spectrogram
    if (onProgress) onProgress(3, 6, 'Running acoustic model...');
    const acousticOutput = await baseSession.session.run(inputs);

    // Get mel output (assumes first output is the mel spectrogram)
    const melOutputName = baseSession.outputNames[0];
    const melTensor = acousticOutput[melOutputName];

    // Step 4: Run diffusion refinement
    if (onProgress) onProgress(4, 6, 'Running diffusion refinement...');
    const melData = new Float32Array(melTensor.data);
    const melShape = melTensor.dims;

    // Generate noise latent of the same shape as mel
    const noiseLatent = generateNoiseLatent(melData.length);

    const denoisedMel = await runDiffusion(noiseLatent, baseSession.session, ort, {
      steps: diffusionSteps,
      cfgScale,
      sampler,
      conditioning: inputs,
      onProgress: (step, total) => {
        if (onProgress) {
          onProgress(4, 6, `Diffusion step ${step}/${total}...`);
        }
      },
    });

    // Step 5: Vocoder (mel → audio)
    if (onProgress) onProgress(5, 6, 'Running vocoder...');
    const denoisedMelTensor = new ort.Tensor('float32', denoisedMel, melShape);
    const audio = await melToAudio(ort, vocoderSession.session, denoisedMelTensor);

    // Step 6: Postprocessing
    if (onProgress) onProgress(6, 6, 'Postprocessing audio...');
    const normalized = normalizeAudio(audio);
    const output = await formatOutput(normalized);

    return {
      samples: output.samples,
      sampleRate: output.sampleRate,
      duration: output.duration,
      segments: 1,
    };
  }

  /**
   * Synthesize long audio with segmentation.
   *
   * @param {object} params - Same as synthesize(), plus segmentation options
   * @param {number} [params.maxSegmentFrames] - Max frames per segment
   * @returns {Promise<SynthesisResult>}
   */
  async synthesizeLong(params) {
    const totalFrames = params.f0.length;

    const audio = await processSegmented(
      totalFrames,
      async (startFrame, endFrame) => {
        // Create segment params with frame range
        const segmentParams = {
          ...params,
          f0: params.f0.slice(startFrame, endFrame),
          durations: params.durations, // TODO: slice durations per segment
        };
        const result = await this.synthesize(segmentParams);
        return result.samples;
      },
      {
        onSegment: (segIndex, totalSegs) => {
          if (params.onProgress) {
            params.onProgress(segIndex, totalSegs, `Processing segment ${segIndex + 1}/${totalSegs}`);
          }
        },
      }
    );

    const duration = audio.length / 44100;
    return {
      samples: audio,
      sampleRate: 44100,
      duration,
      segments: 0, // actual segments count from processSegmented
    };
  }

  /**
   * Get pipeline status.
   *
   * @returns {PipelineStatus}
   */
  getStatus() {
    const loadedModels = Array.from(this.models.keys());
    const firstSession = loadedModels.length > 0 ? this.models.get(loadedModels[0]) : null;

    return {
      ready: this.initialised,
      loadedModels,
      activeEP: firstSession?.ep || 'none',
    };
  }

  /**
   * Unload all models and release resources.
   */
  async dispose() {
    console.log(`${LOG_PREFIX} Disposing pipeline...`);
    await releaseAll();
    this.models.clear();
    this.initialised = false;
    this.ort = null;
    console.log(`${LOG_PREFIX} Pipeline disposed`);
  }
}

// ==================== Singleton ====================

let defaultPipeline = null;

/**
 * Get or create the default pipeline instance.
 *
 * @param {string} [modelDir] - Model directory (required on first call)
 * @param {object} [options] - Init options
 * @returns {Promise<SVSPipeline>}
 */
export async function getDefaultPipeline(modelDir, options = {}) {
  if (!defaultPipeline) {
    defaultPipeline = new SVSPipeline();
    if (modelDir) {
      await defaultPipeline.init(modelDir, options);
    }
  }
  return defaultPipeline;
}

/**
 * Reset the default pipeline.
 */
export function resetDefaultPipeline() {
  if (defaultPipeline) {
    defaultPipeline.dispose();
    defaultPipeline = null;
  }
}

export default {
  SVSPipeline,
  enumerateDMLDevices,
  getDefaultPipeline,
  resetDefaultPipeline,
};