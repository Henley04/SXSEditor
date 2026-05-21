/**
 * 简化的 smoothstep 插值
 * @param {number} t - 输入值 [0, 1]
 * @param {number} smoothness - 平滑度（>0 时应用平滑）
 * @returns {number}
 */
function smoothstep(t, smoothness) {
  return smoothness > 0 ? t * t * (3 - 2 * t) : t;
}

module.exports = { smoothstep };
