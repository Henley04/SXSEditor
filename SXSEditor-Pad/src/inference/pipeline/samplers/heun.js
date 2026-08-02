/**
 * heun.js
 * Heun's ODE solver (2nd-order Runge-Kutta) for diffusion model sampling.
 *
 * Heun's method improves on Euler by taking a midpoint correction:
 *   k1 = f(x_t, t)
 *   k2 = f(x_t + h*k1, t+1)
 *   x_{t-1} = x_t + (h/2) * (k1 + k2)
 *
 * @module inference/pipeline/samplers/heun
 */

/**
 * Perform a single Heun step (2nd-order RK).
 *
 * @param {Float32Array} x - Current latent
 * @param {Float32Array} k1 - Model prediction at (x, t)
 * @param {Float32Array} k2 - Model prediction at (x + h*k1, t+1)
 * @param {number} step - Current step index
 * @param {number} totalSteps - Total number of diffusion steps
 * @param {number} [sigma=1.0] - Noise level scaling factor
 * @returns {Float32Array} Updated latent
 */
export function heunStep(x, k1, k2, step, totalSteps, sigma = 1.0) {
  const h = -1.0 / totalSteps;
  const n = x.length;
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    out[i] = x[i] + (h / 2) * sigma * (k1[i] + k2[i]);
  }

  return out;
}

/**
 * Full Heun sampler loop.
 *
 * At each step, the model is called twice: once for k1 and once for k2,
 * making it ~2x more expensive per step than Euler, but with better accuracy.
 *
 * @param {Float32Array} x - Initial latent (pure noise)
 * @param {Function} modelFn - Async function (x, step) => predicted noise tensor
 * @param {number} totalSteps - Number of diffusion steps
 * @param {object} [options]
 * @param {number} [options.sigma=1.0] - Noise level scaling
 * @param {Function} [options.onStep] - Callback after each step (step, latent)
 * @returns {Promise<Float32Array>} Denoised latent
 */
export async function heunSampler(x, modelFn, totalSteps, options = {}) {
  const { sigma = 1.0, onStep } = options;
  let latent = new Float32Array(x);

  for (let step = 0; step < totalSteps; step++) {
    // k1 = f(latent, step)
    const k1 = await modelFn(latent, step);

    // Step to midpoint: latent + h * k1
    const h = -1.0 / totalSteps;
    const midpoint = new Float32Array(latent.length);
    for (let i = 0; i < latent.length; i++) {
      midpoint[i] = latent[i] + h * sigma * k1[i];
    }

    // k2 = f(midpoint, step+1)
    const k2 = await modelFn(midpoint, step + 1);

    // Heun update
    latent = heunStep(latent, k1, k2, step, totalSteps, sigma);

    if (onStep) {
      onStep(step, latent);
    }
  }

  return latent;
}

export default {
  heunStep,
  heunSampler,
};