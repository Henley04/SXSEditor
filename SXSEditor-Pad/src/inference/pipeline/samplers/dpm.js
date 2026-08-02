/**
 * dpm.js
 * DPM-Solver (Diffusion Probabilistic Model Solver) for SXSEditor-Pad.
 *
 * Implements a simplified DPM-Solver-1 (first-order) and DPM-Solver-2 (second-order)
 * for accelerated diffusion sampling with fewer steps.
 *
 * Reference: https://arxiv.org/abs/2206.00927
 *
 * @module inference/pipeline/samplers/dpm
 */

/**
 * Compute the log-SNR (signal-to-noise ratio) at a given timestep.
 * Uses a cosine schedule by default.
 *
 * @param {number} t - Timestep in [0, 1]
 * @returns {number} log-SNR
 */
function logSNR(t) {
  // Cosine schedule: alpha_bar = cos((t + 0.008) / 1.008 * pi/2)^2
  const angle = ((t + 0.008) / 1.008) * (Math.PI / 2);
  const alphaBar = Math.cos(angle) ** 2;
  return Math.log(alphaBar / (1 - alphaBar + 1e-8));
}

/**
 * DPM-Solver first-order step (equivalent to DDIM).
 *
 * @param {Float32Array} x - Current latent
 * @param {Float32Array} predicted - Model noise prediction
 * @param {number} t - Current timestep [0, 1]
 * @param {number} s - Previous timestep [0, 1] (s > t for reverse diffusion)
 * @returns {Float32Array} Updated latent
 */
export function dpmSolver1Step(x, predicted, t, s) {
  const lambdaT = logSNR(t);
  const lambdaS = logSNR(s);
  const ratio = Math.exp(lambdaT - lambdaS); // alpha_t / alpha_s
  const sigmaRatio = Math.sqrt(Math.max(0, 1 - Math.exp(2 * (lambdaT - lambdaS))));

  const n = x.length;
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    out[i] = ratio * x[i] - sigmaRatio * predicted[i];
  }

  return out;
}

/**
 * DPM-Solver second-order step.
 *
 * @param {Float32Array} x - Current latent
 * @param {Float32Array} u1 - Model prediction at (x, s)
 * @param {Float32Array} u2 - Model prediction at (x_mid, t_mid)
 * @param {number} t - Current timestep [0, 1]
 * @param {number} s - Previous timestep [0, 1]
 * @param {number} r1 - Midpoint ratio (typically 0.5)
 * @returns {Float32Array} Updated latent
 */
export function dpmSolver2Step(x, u1, u2, t, s, r1 = 0.5) {
  const lambdaT = logSNR(t);
  const lambdaS = logSNR(s);
  const lambdaMid = logSNR(s + r1 * (t - s));

  const ratio = Math.exp(lambdaT - lambdaS);
  const sigmaRatio = Math.sqrt(Math.max(0, 1 - Math.exp(2 * (lambdaT - lambdaS))));
  const D = (u2[0] - u1[0]) / (lambdaMid - lambdaS); // Simplified scalar approx

  const n = x.length;
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const correction = (lambdaT - lambdaS) / (lambdaMid - lambdaS) * (u2[i] - u1[i]);
    out[i] = ratio * x[i] - sigmaRatio * (u1[i] + correction);
  }

  return out;
}

/**
 * Full DPM-Sampler loop (auto-selects order based on totalSteps).
 *
 * For totalSteps <= 10, uses second-order for better quality.
 * For totalSteps > 10, uses first-order (faster).
 *
 * @param {Float32Array} x - Initial latent
 * @param {Function} modelFn - Async function (x, step) => predicted noise tensor (Float32Array)
 * @param {number} totalSteps - Number of sampling steps
 * @param {object} [options]
 * @param {number} [options.order] - Solver order (1 or 2, auto if omitted)
 * @param {Function} [options.onStep] - Callback after each step
 * @returns {Promise<Float32Array>} Denoised latent
 */
export async function dpmSampler(x, modelFn, totalSteps, options = {}) {
  const { order = totalSteps <= 10 ? 2 : 1, onStep } = options;
  let latent = new Float32Array(x);

  for (let step = 0; step < totalSteps; step++) {
    const t = 1 - (step + 1) / totalSteps;
    const s = 1 - step / totalSteps;

    if (order === 2 && step < totalSteps - 1) {
      // Second-order: requires two model evaluations
      const r1 = 0.5;
      const tMid = s + r1 * (t - s);

      const u1 = await modelFn(latent, step);
      // Compute midpoint latent
      const lambdaMid = logSNR(tMid);
      const lambdaS = logSNR(s);
      const ratioMid = Math.exp(lambdaMid - lambdaS);
      const sigmaRatioMid = Math.sqrt(Math.max(0, 1 - Math.exp(2 * (lambdaMid - lambdaS))));
      const xMid = new Float32Array(latent.length);
      for (let i = 0; i < latent.length; i++) {
        xMid[i] = ratioMid * latent[i] - sigmaRatioMid * u1[i];
      }

      const u2 = await modelFn(xMid, step);
      latent = dpmSolver2Step(latent, u1, u2, t, s, r1);
    } else {
      const predicted = await modelFn(latent, step);
      latent = dpmSolver1Step(latent, predicted, t, s);
    }

    if (onStep) {
      onStep(step, latent);
    }
  }

  return latent;
}

export default {
  dpmSolver1Step,
  dpmSolver2Step,
  dpmSampler,
  logSNR,
};