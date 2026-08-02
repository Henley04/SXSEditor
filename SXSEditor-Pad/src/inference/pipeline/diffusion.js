/**
 * diffusion.js
 * Diffusion model inference for the SXSEditor-Pad SVS pipeline.
 *
 * Orchestrates the denoising process using the selected sampler,
 * with optional Classifier-Free Guidance (CFG).
 *
 * @module inference/pipeline/diffusion
 */

import { DEFAULT_DIFFUSION_STEPS, DEFAULT_CFG_SCALE, LOG_PREFIX } from './constants.js';
import { eulerSampler } from './samplers/euler.js';
import { heunSampler } from './samplers/heun.js';
import { dpmSampler } from './samplers/dpm.js';
import { stork2Sampler } from './samplers/stork2.js';
import { getCFGScaleSchedule } from './cfgSchedule.js';

/**
 * Get a sampler function by name.
 *
 * @param {'euler'|'heun'|'dpm'|'stork2'} name - Sampler name
 * @returns {Function} Sampler async function
 */
function getSampler(name) {
  switch (name) {
    case 'euler': return eulerSampler;
    case 'heun': return heunSampler;
    case 'dpm': return dpmSampler;
    case 'stork2': return stork2Sampler;
    default:
      console.warn(`${LOG_PREFIX} Unknown sampler "${name}", falling back to Euler`);
      return eulerSampler;
  }
}

/**
 * Run the diffusion denoising process on a latent representation.
 *
 * @param {Float32Array} latent - Initial latent (noise) to denoise
 * @param {object} session - ONNX Runtime session for the diffusion model
 * @param {object} ort - ONNX Runtime module
 * @param {object} [options]
 * @param {number} [options.steps=DEFAULT_DIFFUSION_STEPS] - Number of diffusion steps
 * @param {number} [options.cfgScale=DEFAULT_CFG_SCALE] - CFG scale (1.0 = no guidance)
 * @param {number} [options.cfgScaleSchedule='constant'] - CFG schedule type
 * @param {'euler'|'heun'|'dpm'|'stork2'} [options.sampler='euler'] - Sampler to use
 * @param {object} [options.conditioning] - Conditioning inputs for the model
 * @param {object} [options.unconditionalInputs] - Unconditional inputs for CFG (if different from conditioning)
 * @param {Function} [options.onProgress] - Callback (step, totalSteps, latent)
 * @returns {Promise<Float32Array>} Denoised latent
 */
export async function runDiffusion(latent, session, ort, options = {}) {
  const {
    steps = DEFAULT_DIFFUSION_STEPS,
    cfgScale = DEFAULT_CFG_SCALE,
    cfgScaleSchedule = 'constant',
    sampler = 'euler',
    conditioning = {},
    unconditionalInputs = null,
    onProgress,
  } = options;

  // Compute CFG schedule
  const cfgSchedule = cfgScale > 1.0
    ? getCFGScaleSchedule(cfgScaleSchedule, cfgScale, steps)
    : null;

  const samplerFn = getSampler(sampler);

  const inputNames = session.inputNames;
  const outputNames = session.outputNames;

  // Build the model function that the sampler calls
  const modelFn = async (x, step) => {
    // Prepare feeds: combine the latent with conditioning inputs
    const feeds = {};

    // Set the latent as the first input (usually named "x" or "latent")
    // The sampler passes x as a Float32Array; we need to reshape it
    const latentTensor = new ort.Tensor('float32', x, [1, 1, x.length]);
    feeds[inputNames[0]] = latentTensor;

    // Add conditioning inputs
    for (const [key, tensor] of Object.entries(conditioning)) {
      if (inputNames.includes(key)) {
        feeds[key] = tensor;
      }
    }

    // Run conditioned inference
    const conditionedResult = await session.run(feeds);
    const conditionedOutput = new Float32Array(conditionedResult[outputNames[0]].data);

    // If CFG is enabled, also run unconditional inference
    if (cfgSchedule && cfgScale > 1.0) {
      const currentCFG = cfgSchedule[Math.min(step, cfgSchedule.length - 1)];

      const uncondFeeds = { ...feeds };
      if (unconditionalInputs) {
        for (const [key, tensor] of Object.entries(unconditionalInputs)) {
          if (inputNames.includes(key)) {
            uncondFeeds[key] = tensor;
          }
        }
      }

      const uncondResult = await session.run(uncondFeeds);
      const uncondOutput = new Float32Array(uncondResult[outputNames[0]].data);

      // Apply CFG: guided = uncond + cfg * (cond - uncond)
      const guided = new Float32Array(conditionedOutput.length);
      for (let i = 0; i < conditionedOutput.length; i++) {
        guided[i] = uncondOutput[i] + currentCFG * (conditionedOutput[i] - uncondOutput[i]);
      }

      return guided;
    }

    return conditionedOutput;
  };

  // Run the sampler
  const denoised = await samplerFn(latent, modelFn, steps, {
    onStep: (step, currentLatent) => {
      if (onProgress) {
        onProgress(step + 1, steps, currentLatent);
      }
    },
  });

  return denoised;
}

/**
 * Generate initial noise latent for the diffusion process.
 *
 * @param {number} length - Number of elements in the latent
 * @param {number} [seed] - Random seed (optional, for reproducibility)
 * @returns {Float32Array} Initial noise latent
 */
export function generateNoiseLatent(length, seed) {
  const latent = new Float32Array(length);

  if (seed !== undefined) {
    // Simple seeded PRNG (mulberry32)
    let s = seed | 0;
    const next = () => {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let i = 0; i < length; i++) {
      // Box-Muller transform for Gaussian noise
      const u1 = next();
      const u2 = next();
      latent[i] = Math.sqrt(-2 * Math.log(u1 + 1e-8)) * Math.cos(2 * Math.PI * u2);
    }
  } else {
    // Use Math.random (crypto-secure in browsers)
    for (let i = 0; i < length; i++) {
      const u1 = Math.random();
      const u2 = Math.random();
      latent[i] = Math.sqrt(-2 * Math.log(u1 + 1e-8)) * Math.cos(2 * Math.PI * u2);
    }
  }

  return latent;
}

export default {
  runDiffusion,
  generateNoiseLatent,
  getSampler,
};