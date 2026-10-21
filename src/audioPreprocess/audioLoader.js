import { state } from './state.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';

/** 用 AudioBuffer 直接切片，避免一次 OfflineAudioContext 全缓冲渲染。 */
function sliceBuffer(audioBuffer, startSample, length) {
  const targetLength = Math.max(0, Math.min(length ?? (audioBuffer.length - startSample), audioBuffer.length - startSample));
  const out = new AudioBuffer({
    length: targetLength,
    numberOfChannels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate,
  });
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const src = audioBuffer.getChannelData(ch);
    out.getChannelData(ch).set(src.subarray(startSample, startSample + targetLength));
  }
  return out;
}

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

  return sliceBuffer(audioBuffer, silenceEndIndex);
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
    // 下混与原先 ChannelSplitter→ChannelMerger 的连接方式保持一致：
    // 所有声道都接到 merger 的同一个输入，等价于逐样本求和（不是平均）。
    const mono = new Float32Array(audioBuffer.length);
    for (let ch = 0; ch < originalChannels; ch++) {
      const src = audioBuffer.getChannelData(ch);
      for (let i = 0; i < mono.length; i++) mono[i] += src[i];
    }
    const monoOut = new AudioBuffer({
      length: audioBuffer.length,
      numberOfChannels: 1,
      sampleRate: originalSampleRate,
    });
    monoOut.copyToChannel(mono, 0);
    monoBuffer = monoOut;
  }

  if (originalDuration > 30) {
    const targetLength = Math.floor(30 * monoBuffer.sampleRate);
    if (monoBuffer.length > targetLength) {
      monoBuffer = sliceBuffer(monoBuffer, 0, targetLength);
    }
    // 静默截断会让用户以为音频丢了半段，必须明确告知。
    showAlertDialog(t('preprocess.audioTruncatedNotice'));
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

  // 裁剪前导静音会改变时间轴原点：记录偏移量，保存 singerData 时再补回，
  // 否则音符/F0 在原始音频上会整体提前。
  const beforeTrimLength = monoBuffer.length;
  const beforeTrimRate = monoBuffer.sampleRate;
  monoBuffer = trimLeadingSilence(monoBuffer);
  const trimmedSamples = beforeTrimLength - monoBuffer.length;
  const trimOffsetSec = trimmedSamples > 0 ? trimmedSamples / beforeTrimRate : 0;
  state.trimOffsetSec = trimOffsetSec;
  if (trimOffsetSec > 0.01) {
    showAlertDialog(t('preprocess.silenceTrimmedNotice', { seconds: trimOffsetSec.toFixed(2) }));
  }

  return monoBuffer;
}
