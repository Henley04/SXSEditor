function resampleAudio(audioData, fromSampleRate, toSampleRate) {
  const ratio = fromSampleRate / toSampleRate;
  const newLength = Math.floor(audioData.length / ratio);
  const resampled = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexInt = Math.floor(srcIndex);
    const frac = srcIndex - srcIndexInt;

    if (srcIndexInt + 1 < audioData.length) {
      resampled[i] = audioData[srcIndexInt] * (1 - frac) + audioData[srcIndexInt + 1] * frac;
    } else {
      resampled[i] = audioData[srcIndexInt] || 0;
    }
  }

  return resampled;
}

module.exports = { resampleAudio };
