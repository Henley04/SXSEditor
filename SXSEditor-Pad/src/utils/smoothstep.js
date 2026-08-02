/**
 * smoothstep.js
 * Smooth step easing functions for SXSEditor-Pad.
 * Useful for animation, interpolation, and parameter smoothing.
 *
 * @module utils/smoothstep
 */

/**
 * Clamp a value between 0 and 1.
 *
 * @param {number} t - Input value
 * @returns {number} Clamped value between 0 and 1
 */
function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Standard smoothstep: 3t² - 2t³
 * Hermite interpolation between 0 and 1.
 *
 * @param {number} t - Input value (typically 0-1, will be clamped)
 * @returns {number} Smoothly interpolated value between 0 and 1
 */
export function smoothstep(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Smoother step: 6t⁵ - 15t⁴ + 10t³
 * An improved version of smoothstep with zero first and second derivatives at the endpoints.
 *
 * @param {number} t - Input value (typically 0-1, will be clamped)
 * @returns {number} More smoothly interpolated value between 0 and 1
 */
export function smootherstep(t) {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Generalized smoothstep with arbitrary order.
 * Higher order = smoother transition but steeper in the middle.
 *
 * @param {number} t - Input value (typically 0-1, will be clamped)
 * @param {number} [n=1] - Order of the smoothstep (1 = linear, 2 = quadratic, etc.)
 * @returns {number} Smoothly interpolated value
 */
export function smoothstepN(t, n = 1) {
  const x = clamp01(t);
  if (n <= 1) return x;

  // Use the standard smoothstep for n=2 or n=3
  if (n === 2) return smoothstep(x);
  if (n === 3) return smootherstep(x);

  // General case: xⁿ / (xⁿ + (1-x)ⁿ)
  const xn = Math.pow(x, n);
  return xn / (xn + Math.pow(1 - x, n));
}

/**
 * Smoothstep with configurable edge values.
 * Maps an input range [edge0, edge1] to a smooth [0, 1] output.
 *
 * @param {number} edge0 - Lower edge of the input range
 * @param {number} edge1 - Upper edge of the input range
 * @param {number} t - Input value
 * @returns {number} Smoothly interpolated value
 */
export function smoothstepRange(edge0, edge1, t) {
  const x = clamp01((t - edge0) / (edge1 - edge0));
  return smoothstep(x);
}

/**
 * Smoother step with configurable edge values.
 *
 * @param {number} edge0 - Lower edge of the input range
 * @param {number} edge1 - Upper edge of the input range
 * @param {number} t - Input value
 * @returns {number} More smoothly interpolated value
 */
export function smootherstepRange(edge0, edge1, t) {
  const x = clamp01((t - edge0) / (edge1 - edge0));
  return smootherstep(x);
}

/**
 * Inverse smoothstep: given a smoothstep output, find the input.
 * Useful for reverse-mapping smoothed values.
 *
 * @param {number} y - Smoothstep output value (0-1)
 * @returns {number} Input value that would produce the given output
 */
export function inverseSmoothstep(y) {
  const x = clamp01(y);
  // Solve y = 3x² - 2x³ for x
  // Using the analytical solution
  return 0.5 - Math.sin(Math.asin(1 - 2 * x) / 3);
}

/**
 * Apply smoothstep interpolation between two values.
 *
 * @param {number} a - Start value
 * @param {number} b - End value
 * @param {number} t - Interpolation factor (0-1)
 * @returns {number} Interpolated value
 */
export function smoothstepMix(a, b, t) {
  const s = smoothstep(t);
  return a + (b - a) * s;
}

/**
 * Apply smoother step interpolation between two values.
 *
 * @param {number} a - Start value
 * @param {number} b - End value
 * @param {number} t - Interpolation factor (0-1)
 * @returns {number} Interpolated value
 */
export function smootherstepMix(a, b, t) {
  const s = smootherstep(t);
  return a + (b - a) * s;
}

export default {
  smoothstep,
  smootherstep,
  smoothstepN,
  smoothstepRange,
  smootherstepRange,
  inverseSmoothstep,
  smoothstepMix,
  smootherstepMix,
};