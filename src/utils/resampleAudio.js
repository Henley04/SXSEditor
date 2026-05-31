// Kaiser 窗的零阶修正贝塞尔函数 I₀(x) 近似
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

function resampleAudio(audioData, fromSampleRate, toSampleRate) {
  if (fromSampleRate === toSampleRate) return audioData;
  const ratio = fromSampleRate / toSampleRate;
  const newLength = Math.floor(audioData.length / ratio);
  if (newLength <= 0) return new Float32Array(0);

  // 窗口化 sinc 插值 (Kaiser 窗, β=5)
  const kaiserBeta = 5.0;
  const halfWidth = Math.ceil(12 * kaiserBeta / 5);
  const cutoff = (toSampleRate < fromSampleRate ? 0.95 * toSampleRate / fromSampleRate : 0.95) * 0.5;

  const resampled = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const center = (i + 0.5) * ratio;
    const left = Math.max(0, Math.floor(center - halfWidth));
    const right = Math.min(audioData.length - 1, Math.ceil(center + halfWidth));

    let sum = 0;
    let weightSum = 0;
    for (let j = left; j <= right; j++) {
      const t = center - j;
      if (Math.abs(t) < 1e-7) {
        sum += audioData[j];
        weightSum += 1;
      } else {
        const sincVal = Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
        const kaiserArg = 1 - (2 * t / (2 * halfWidth + 1)) ** 2;
        const windowVal = kaiserArg >= 0
          ? bessel0(kaiserBeta * Math.sqrt(kaiserArg)) / bessel0(kaiserBeta)
          : 0;
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
