/**
 * euler.js
 * Euler ODE solver for diffusion model sampling.
 *
 * x_{t-1} = x_t + h * f(x_t, t)
 * where h = -1/totalSteps and f is the model's predicted denoising direction.
 *
 * @module inference/pipeline/samplers/euler
 */

/**
 * Perform a single Euler step.
 *
 * @param {Float32Array} x - Current latent (noisy audio representation)
 * @param {Float32Array} predicted - Model's noise prediction (epsilon)
 * @param {number} step - Current step index (0-indexed)
 * @param {number} totalSteps - Total number of diffusion steps
 * @param {number} [sigma=1.0] - Noise level scaling factor
 * @returns {Float32Array} Updated latent after one Euler step
 */
export function eulerStep(x, predicted, step, totalSteps, sigma = 1.0) {
  const h = -1.0 / totalSteps;
  const n = x.length;
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    out[i] = x[i] + h * sigma * predicted[i];
  }

  return out;
}

/**
 * Full Euler sampler loop.
 *
 * @param {Float32Array} x - Initial latent (pure noise)
 * @param {Function} modelFn - Async function (x, step) => predicted noise tensor
 * @param {number} totalSteps - Number of diffusion steps
 * @param {object} [options]
 * @param {number} [options.sigma=1.0] - Noise level scaling
 * @param {Function} [options.onStep] - Callback after each step (step, latent)
 * @returns {Promise<Float32Array>} Denoised latent
 */
export async function eulerSampler(x, modelFn, totalSteps, options = {}) {
  const { sigma = 1.0, onStep } = options;
  let latent = new Float32Array(x);

  for (let step = 0; step < totalSteps; step++) {
    const predicted = await modelFn(latent, step);
    latent = eulerStep(latent, predicted, step, totalSteps, sigma);

    if (onStep) {
      onStep(step, latent);
    }
  }

  return latent;
}

export default {
  eulerStep,
  eulerSampler,
};