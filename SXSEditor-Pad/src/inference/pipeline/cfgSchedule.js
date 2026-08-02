/**
 * cfgSchedule.js
 * CFG (Classifier-Free Guidance) scale scheduling for the SXSEditor-Pad diffusion pipeline.
 *
 * Provides functions to compute the CFG scale at each diffusion step,
 * supporting constant, linear, cosine, and exponential schedules.
 *
 * @module inference/pipeline/cfgSchedule
 */

import { clamp, lerp } from './utils.js';
import { CFG_SCALE_MIN } from './constants.js';

/**
 * Get the CFG scale for a given step within a diffusion process.
 *
 * @param {number} cfgScale - Base CFG scale (the user-specified value)
 * @param {number} currentStep - Current diffusion step (0-indexed)
 * @param {number} totalSteps - Total number of diffusion steps
 * @returns {number} The CFG scale to use at this step
 */
export function getCFGScale(cfgScale, currentStep, totalSteps) {
  // Default behaviour: constant scale throughout
  // Subclasses/overrides can provide a schedule function to getCFGScaleSchedule
  return cfgScale;
}

/**
 * Compute a CFG scale schedule for the entire diffusion process.
 *
 * @param {'constant'|'linear'|'cosine'|'exponential'|'inverse'} method - Schedule type
 * @param {number} cfgScale - Base CFG scale
 * @param {number} steps - Total number of diffusion steps
 * @param {number} [totalSteps] - Alias for steps (for compatibility)
 * @returns {number[]} Array of CFG scale values, one per step
 */
export function getCFGScaleSchedule(method, cfgScale, steps, totalSteps) {
  const n = totalSteps ?? steps;

  if (n <= 0) {
    return [];
  }

  const schedule = new Array(n);

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1); // Normalised progress [0, 1]

    switch (method) {
      case 'constant':
        schedule[i] = cfgScale;
        break;

      case 'linear':
        // Linearly decay from cfgScale to 1.0
        schedule[i] = lerp(cfgScale, CFG_SCALE_MIN, t);
        break;

      case 'cosine': {
        // Cosine decay: starts at cfgScale, smoothly drops to 1.0
        const cosVal = Math.cos((t * Math.PI) / 2);
        schedule[i] = CFG_SCALE_MIN + (cfgScale - CFG_SCALE_MIN) * cosVal;
        break;
      }

      case 'exponential': {
        // Exponential decay: cfgScale * (1/scale)^t
        const ratio = CFG_SCALE_MIN / cfgScale;
        schedule[i] = cfgScale * ratio ** t;
        break;
      }

      case 'inverse': {
        // Inverse schedule: high guidance early, low later
        const inv = 1 - t;
        schedule[i] = CFG_SCALE_MIN + (cfgScale - CFG_SCALE_MIN) * inv;
        break;
      }

      default:
        schedule[i] = cfgScale;
        break;
    }

    // Clamp to valid range
    schedule[i] = clamp(schedule[i], CFG_SCALE_MIN, cfgScale);
  }

  return schedule;
}

export default {
  getCFGScale,
  getCFGScaleSchedule,
};