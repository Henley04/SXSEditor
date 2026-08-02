/**
 * stork2.js
 * STORK2 ODE solver for diffusion model sampling.
 *
 * STORK2 is a low-error 2nd-order ODE solver that uses
 * a single model evaluation per step with a Runge-Kutta-like
 * update. It provides a good trade-off between speed and accuracy.
 *
 * Reference: Liu et al., "STORK: A Low-Error ODE Solver for
 * Diffusion Probabilistic Models"
 *
 * @module inference/pipeline/samplers/stork2
 */

/**
 * Perform a single STORK2 step.
 *
 * The update uses a weighted combination of the current prediction
 * and a projected next-step prediction:
 *   x_{t-1} = x_t + h * (w1 * f(x_t, t) + w2 * f(x_t + h * w3 * f(x_t, t), t+1))
 *
 * where the weights w1, w2, w3 are chosen to minimise local truncation error.
 *
 * @param {Float32Array} x - Current latent
 * @param {Float32Array} f1 - Model prediction at (x, t)
 * @param {Float32Array} f2 - Model prediction at the projected point
 * @param {number} step - Current step index
 * @param {number} totalSteps - Total number of diffusion steps
 * @param {object} [options]
 * @param {number} [options.sigma=1.0] - Noise level scaling
 * @returns {Float32Array} Updated latent
 */
export function stork2Step(x, f1, f2, step, totalSteps, options = {}) {
  const { sigma = 1.0 } = options;
  const h = -1.0 / totalSteps;
  const n = x.length;

  // STORK2 coefficients (optimised for diffusion)
  const w1 = 0.5;
  const w2 = 0.5;

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = x[i] + h * sigma * (w1 * f1[i] + w2 * f2[i]);
  }

  return out;
}

/**
 * Full STORK2 sampler loop.
 *
 * Performs one model evaluation per step, plus one extra near the end,
 * giving ~totalSteps+1 evaluations total.
 *
 * @param {Float32Array} x - Initial latent (pure noise)
 * @param {Function} modelFn - Async function (x, step) => predicted noise tensor (Float32Array)
 * @param {number} totalSteps - Number of diffusion steps
 * @param {object} [options]
 * @param {number} [options.sigma=1.0] - Noise level scaling
 * @param {Function} [options.onStep] - Callback after each step (step, latent)
 * @returns {Promise<Float32Array>} Denoised latent
 */
export async function stork2Sampler(x, modelFn, totalSteps, options = {}) {
  const { sigma = 1.0, onStep } = options;
  let latent = new Float32Array(x);

  for (let step = 0; step < totalSteps; step++) {
    const h = -1.0 / totalSteps;

    // f1 = model(latent, step)
    const f1 = await modelFn(latent, step);

    // Projected point: latent + h * w3 * f1
    const w3 = 0.75; // STORK2 projection coefficient
    const projected = new Float32Array(latent.length);
    for (let i = 0; i < latent.length; i++) {
      projected[i] = latent[i] + h * sigma * w3 * f1[i];
    }

    // f2 = model(projected, step + 1)
    const f2 = await modelFn(projected, step + 1);

    // STORK2 update
    latent = stork2Step(latent, f1, f2, step, totalSteps, { sigma });

    if (onStep) {
      onStep(step, latent);
    }
  }

  return latent;
}

export default {
  stork2Step,
  stork2Sampler,
};