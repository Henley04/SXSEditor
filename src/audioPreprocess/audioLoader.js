export function trimLeadingSilence(audioBuffer, threshold = 0.01) {
  const data = audioBuffer.getChannelData(0);
  let silenceEndIndex = 0;

  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > threshold) {
      silenceEndIndex = i;
      break;
    }
  }

  if (silenceEndIndex === 0) {
    return audioBuffer;
  }

  const targetLength = audioBuffer.length - silenceEndIndex;
  const offlineCtx = new OfflineAudioContext(1, targetLength, audioBuffer.sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0, silenceEndIndex / audioBuffer.sampleRate);
  return offlineCtx.startRendering();
}

export async function processWavBuffer(buffer) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });

  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(buffer.slice(0));
  } finally {
    audioCtx.close();
  }
  const originalSampleRate = audioBuffer.sampleRate;
  const originalChannels = audioBuffer.numberOfChannels;
  const originalDuration = audioBuffer.duration;

  let monoBuffer = audioBuffer;
  if (originalChannels > 1) {
    const offlineCtx = new OfflineAudioContext(1, audioBuffer.length, originalSampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;

    const splitter = offlineCtx.createChannelSplitter(originalChannels);
    const merger = offlineCtx.createChannelMerger(1);

    source.connect(splitter);
    for (let ch = 0; ch < originalChannels; ch++) {
      splitter.connect(merger, ch, 0);
    }
    merger.connect(offlineCtx.destination);
    source.start();

    monoBuffer = await offlineCtx.startRendering();
  }

  if (originalDuration > 30) {
    const targetLength = Math.floor(30 * 44100);
    if (monoBuffer.length > targetLength) {
      const offlineCtx = new OfflineAudioContext(1, targetLength, 44100);
      const source = offlineCtx.createBufferSource();
      source.buffer = monoBuffer;
      source.connect(offlineCtx.destination);
      source.start();
      monoBuffer = await offlineCtx.startRendering();
    }
  }

  if (monoBuffer.sampleRate !== 44100) {
    const targetLength = Math.floor(monoBuffer.duration * 44100);
    const offlineCtx = new OfflineAudioContext(1, targetLength, 44100);
    const source = offlineCtx.createBufferSource();
    source.buffer = monoBuffer;
    source.connect(offlineCtx.destination);
    source.start();
    monoBuffer = await offlineCtx.startRendering();
  }

  monoBuffer = await trimLeadingSilence(monoBuffer);

  return monoBuffer;
}
