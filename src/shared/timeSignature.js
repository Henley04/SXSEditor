/**
 * 拍号工具。
 *
 * MIDI 的 beat 一律以**四分音符**为一拍，而拍号的分子是"每小节多少个分母音符"。
 * 所以每小节的拍数不是 `timeSignature[0]`，而是 `num * 4 / den`：
 *
 *   4/4 → 4 拍    3/4 → 3 拍    2/2 → 2 拍
 *   6/8 → 3 拍    9/8 → 4.5 拍  12/8 → 6 拍
 *
 * 之前多处直接拿 `timeSignature[0]` 当拍数，6/8、12/8 这类复合拍号下小节线
 * 和小节编号会整体画错（用户反馈的"小节数不对"）。
 */

const DEFAULT_NUM = 4;
const DEFAULT_DEN = 4;

/**
 * 每小节的四分音符拍数。
 * @param {number[]|null|undefined} timeSignature [分子, 分母]
 * @returns {number} 拍数，非法输入按 4/4 处理
 */
export function beatsPerMeasureOf(timeSignature) {
  const sig = Array.isArray(timeSignature) && timeSignature.length >= 2
    ? timeSignature
    : [DEFAULT_NUM, DEFAULT_DEN];
  const num = Number(sig[0]) > 0 ? Number(sig[0]) : DEFAULT_NUM;
  const den = Number(sig[1]) > 0 ? Number(sig[1]) : DEFAULT_DEN;
  return (num * 4) / den;
}

/**
 * 判断某个（可能是小数的）拍位置是否落在小节线上。
 * @param {number} beat
 * @param {number} beatsPerMeasure
 * @returns {boolean}
 */
export function isMeasureBoundary(beat, beatsPerMeasure) {
  if (!(beatsPerMeasure > 0)) return false;
  const k = Math.round(beat / beatsPerMeasure);
  return Math.abs(beat - k * beatsPerMeasure) < 1e-6;
}

/**
 * 拍位置对应的小节号（从 1 开始）。
 * @param {number} beat
 * @param {number} beatsPerMeasure
 * @returns {number}
 */
export function measureNumberAt(beat, beatsPerMeasure) {
  if (!(beatsPerMeasure > 0)) return 1;
  return Math.floor(beat / beatsPerMeasure + 1e-9) + 1;
}
