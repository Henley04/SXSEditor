// Kaiser 窗的零阶修正贝塞尔函数 I₀(x)（20 阶级数，仅用于一次性建表）
function bessel0(x) {
  let sum = 1;
  let term = 1;
  const halfX = x / 2;
  for (let k = 1; k <= 20; k++) {
    term *= (halfX / k);
    sum += term * term;
  }
  return sum;
}

// Kaiser 窗值查找表：window(|t|) = I0(β·sqrt(1-(2t/(2HW+1))²)) / I0(β)。
// β/HW 固定（5 / 12），旧实现每个输出样本的 ~25 个抽头各调用一次 20 迭代
// bessel0 + sqrt（FCPE 48k→16k 重采样是主进程阻塞的主要来源）。表只构建
// 一次，线性插值误差远低于 1e-6；窗外（|t| > (2HW+1)/2 = 12.5）窗值为 0。
const KAISER_BETA = 5.0;
const HALF_WIDTH = Math.ceil(12 * KAISER_BETA / 5);
const TWO_HALF_WIDTH_PLUS_1 = 2 * HALF_WIDTH + 1;
const KAISER_LUT_POINTS = 8192;
const KAISER_LUT_XMAX = TWO_HALF_WIDTH_PLUS_1 / 2; // 12.5 — 窗值在此处自然为 0
let _kaiserLut = null;

function getKaiserLut() {
  if (_kaiserLut) return _kaiserLut;
  const values = new Float32Array(KAISER_LUT_POINTS + 1);
  const norm = bessel0(KAISER_BETA);
  for (let k = 0; k <= KAISER_LUT_POINTS; k++) {
    const t = (k / KAISER_LUT_POINTS) * KAISER_LUT_XMAX;
    const kaiserArg = 1 - (2 * t / TWO_HALF_WIDTH_PLUS_1) ** 2;
    values[k] = kaiserArg >= 0 ? bessel0(KAISER_BETA * Math.sqrt(kaiserArg)) / norm : 0;
  }
  _kaiserLut = { values, scale: KAISER_LUT_POINTS / KAISER_LUT_XMAX };
  return _kaiserLut;
}

function resampleAudio(audioData, fromSampleRate, toSampleRate) {
  if (fromSampleRate === toSampleRate) return audioData;
  const ratio = fromSampleRate / toSampleRate;
  const newLength = Math.floor(audioData.length / ratio);
  if (newLength <= 0) return new Float32Array(0);

  // 窗口化 sinc 插值 (Kaiser 窗, β=5)
  const cutoff = (toSampleRate < fromSampleRate ? 0.95 * toSampleRate / fromSampleRate : 0.95) * 0.5;
  const twoPiCutoff = 2 * Math.PI * cutoff;
  const lut = getKaiserLut();
  const lutValues = lut.values;
  const lutScale = lut.scale;

  const resampled = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const center = (i + 0.5) * ratio;
    const left = Math.max(0, Math.floor(center - HALF_WIDTH));
    const right = Math.min(audioData.length - 1, Math.ceil(center + HALF_WIDTH));

    let sum = 0;
    let weightSum = 0;
    for (let j = left; j <= right; j++) {
      const t = center - j;
      if (Math.abs(t) < 1e-7) {
        sum += audioData[j];
        weightSum += 1;
      } else {
        const sincVal = Math.sin(twoPiCutoff * t) / (Math.PI * t);
        // 线性插值查表替代每抽头 sqrt + 20 迭代 bessel0。
        // 注意 t 恰为 12.5 时窗值非零（I0(0)/I0(β)≈0.036），故边界要用
        // 表端点值；只有 t > 12.5（kaiserArg<0）窗值才为 0。
        const fi = Math.abs(t) * lutScale;
        let windowVal = 0;
        if (fi <= KAISER_LUT_POINTS) {
          const i0 = fi >= KAISER_LUT_POINTS ? KAISER_LUT_POINTS - 1 : (fi | 0);
          const frac = Math.min(1, fi - i0);
          const w0 = lutValues[i0];
          windowVal = w0 + (lutValues[i0 + 1] - w0) * frac;
        }
        const w = sincVal * windowVal;
        sum += audioData[j] * w;
        weightSum += w;
      }
    }
    resampled[i] = weightSum > 1e-8 ? sum / weightSum : 0;
  }

  return resampled;
}

module.exports = { resampleAudio };
