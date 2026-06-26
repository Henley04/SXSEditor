const { MEL_DIM, HOP_SIZE, VOCODER_CHUNK_FRAMES, VOCODER_OVERLAP_FRAMES, NPU_VOCODER_SEQ_LEN, SAMPLE_RATE, N_FFT, NUM_MELS, MEL_MEAN, MEL_VAR } = require('./constants');
const { TWIDDLE_REAL, TWIDDLE_IMAG, HANN_WINDOW } = require('./constants');
const { createFloatTensor, outputToFloat32, normalizePeakTo } = require('./utils');

/**
 * Post-processing: mel transform, vocoder, audio generation
 * Also includes audio utility functions (parseWavBuffer, resampleLinear, mel spectrogram, etc.)
 */

// ---- Audio utility functions ----

function parseWavBuffer(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (riff !== 'RIFF') {
        throw new Error('Not a WAV file: missing RIFF header');
    }
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (wave !== 'WAVE') {
        throw new Error('Not a WAV file: missing WAVE format');
    }

    let offset = 12;
    let fmtOffset = -1;
    let dataOffset = -1;
    let dataSize = 0;

    while (offset < buf.byteLength - 8) {
        const chunkId = String.fromCharCode(
            view.getUint8(offset), view.getUint8(offset + 1),
            view.getUint8(offset + 2), view.getUint8(offset + 3)
        );
        const chunkSize = view.getUint32(offset + 4, true);

        if (offset + 8 + chunkSize > buf.byteLength) break;

        if (chunkId === 'fmt ') {
            fmtOffset = offset + 8;
        } else if (chunkId === 'data') {
            dataOffset = offset + 8;
            dataSize = chunkSize;
        }

        offset += 8 + chunkSize;
        if (chunkSize % 2 !== 0) offset++;
    }

    if (fmtOffset === -1) throw new Error('WAV file missing fmt chunk');
    if (dataOffset === -1) throw new Error('WAV file missing data chunk');

    const audioFormat = view.getUint16(fmtOffset, true);
    const numChannels = view.getUint16(fmtOffset + 2, true);
    const sampleRate = view.getUint32(fmtOffset + 4, true);
    const bitsPerSample = view.getUint16(fmtOffset + 14, true);
    const bytesPerSample = bitsPerSample / 8;
    const totalSamples = Math.floor(dataSize / bytesPerSample);
    const numFrames = Math.floor(totalSamples / numChannels);
    const audioFloat = new Float32Array(numFrames);

    for (let f = 0; f < numFrames; f++) {
        let sum = 0;
        for (let ch = 0; ch < numChannels; ch++) {
            const i = f * numChannels + ch;
            const byteOffset = dataOffset + i * bytesPerSample;
            if (byteOffset + bytesPerSample > buf.byteLength) break;
            let sample = 0;
            if (audioFormat === 3 && bitsPerSample === 32) {
                sample = view.getFloat32(byteOffset, true);
            } else if (audioFormat === 1 && bitsPerSample === 16) {
                sample = view.getInt16(byteOffset, true) / 32768;
            } else if (audioFormat === 1 && bitsPerSample === 24) {
                const low = view.getUint16(byteOffset, true);
                const high = view.getInt8(byteOffset + 2);
                sample = ((high << 16) | low) / 8388608;
            } else if (audioFormat === 1 && bitsPerSample === 32) {
                sample = view.getInt32(byteOffset, true) / 2147483648;
            }
            sum += sample;
        }
        audioFloat[f] = sum / numChannels;
    }

    return { data: audioFloat, sampleRate };
}

function resampleLinear(audioFloat, srcSampleRate, dstSampleRate) {
    if (srcSampleRate === dstSampleRate) return audioFloat;
    const ratio = srcSampleRate / dstSampleRate;
    const newLength = Math.floor(audioFloat.length / ratio);
    if (newLength <= 0) return new Float32Array(0);

    // 窗口化 sinc 插值 (Kaiser 窗, β=5)
    const kaiserBeta = 5.0;
    const halfWidth = Math.ceil(12 * kaiserBeta / 5); // ~12 零交叉
    const cutoff = (dstSampleRate < srcSampleRate ? 0.95 * dstSampleRate / srcSampleRate : 0.95) * 0.5;

    // Precompute constants outside the inner loop
    const twoPiCutoff = 2 * Math.PI * cutoff;
    const invPi = 1 / Math.PI;
    const invWidth = 1 / (2 * halfWidth + 1);
    const bessel0Beta = bessel0(kaiserBeta); // Normalization factor, computed once

    const out = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
        const center = (i + 0.5) * ratio;
        const left = Math.max(0, Math.floor(center - halfWidth));
        const right = Math.min(audioFloat.length - 1, Math.ceil(center + halfWidth));

        let sum = 0;
        let weightSum = 0;
        for (let j = left; j <= right; j++) {
            const t = center - j;
            if (Math.abs(t) < 1e-7) {
                sum += audioFloat[j];
                weightSum += 1;
            } else {
                const sincVal = Math.sin(twoPiCutoff * t) * invPi / t;
                const kaiserArg = 1 - (t * invWidth) * (t * invWidth);
                const windowVal = kaiserArg >= 0
                    ? bessel0(kaiserBeta * Math.sqrt(kaiserArg)) / bessel0Beta
                    : 0;
                const w = sincVal * windowVal;
                sum += audioFloat[j] * w;
                weightSum += w;
            }
        }
        out[i] = weightSum > 1e-8 ? sum / weightSum : 0;
    }
    return out;
}

// Kaiser 窗的零阶修正贝塞尔函数 I₀(x) 近似
// Optimized: uses rational approximation for x < 8, asymptotic for x >= 8
function bessel0(x) {
    if (x < 0) x = -x;
    if (x < 3.75) {
        const t = x / 3.75;
        const t2 = t * t;
        return 1 + t2 * (3.5156229 + t2 * (3.0899424 + t2 * (1.2067492
            + t2 * (0.2659732 + t2 * (0.0360768 + t2 * 0.0045813)))));
    }
    const ax = Math.abs(x);
    const y = 3.75 / ax;
    return (Math.exp(ax) / Math.sqrt(ax)) * (0.39894228 + y * (0.01328592
        + y * (0.00225319 + y * (-0.00157565 + y * (0.00916281
        + y * (-0.02057706 + y * (0.02635537 + y * (-0.01647633
        + y * 0.00392377))))))));
}

function bitReversePermute(real, imag) {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if (i < j) {
            const tmpR = real[i]; real[i] = real[j]; real[j] = tmpR;
            const tmpI = imag[i]; imag[i] = imag[j]; imag[j] = tmpI;
        }
    }
}

// Radix-2 FFT (in-place, bit-reversed output)
function fftRadix2(real, imag) {
    const n = real.length;
    bitReversePermute(real, imag);
    for (let len = 2; len <= n; len *= 2) {
        const halfLen = len / 2;
        const step = n / len;
        for (let i = 0; i < n; i += len) {
            for (let j = 0; j < halfLen; j++) {
                const idx1 = i + j;
                const idx2 = i + j + halfLen;
                const wr = TWIDDLE_REAL[j * step];
                const wi = TWIDDLE_IMAG[j * step];
                const tReal = real[idx1];
                const tImag = imag[idx1];
                const uReal = real[idx2];
                const uImag = imag[idx2];
                real[idx1] = tReal + uReal;
                imag[idx1] = tImag + uImag;
                real[idx2] = (tReal - uReal) * wr - (tImag - uImag) * wi;
                imag[idx2] = (tReal - uReal) * wi + (tImag - uImag) * wr;
            }
        }
    }
}

// Radix-2 IFFT (in-place, bit-reversed input → standard output)
function ifftRadix2(real, imag) {
    const n = real.length;
    bitReversePermute(real, imag);
    for (let len = 2; len <= n; len *= 2) {
        const halfLen = len / 2;
        const step = n / len;
        for (let i = 0; i < n; i += len) {
            for (let j = 0; j < halfLen; j++) {
                const idx1 = i + j;
                const idx2 = i + j + halfLen;
                const wr = TWIDDLE_REAL[j * step];
                const wi = -TWIDDLE_IMAG[j * step]; // 共轭: 正号
                const tReal = real[idx1];
                const tImag = imag[idx1];
                const uReal = real[idx2];
                const uImag = imag[idx2];
                real[idx1] = tReal + uReal;
                imag[idx1] = tImag + uImag;
                real[idx2] = (tReal - uReal) * wr - (tImag - uImag) * wi;
                imag[idx2] = (tReal - uReal) * wi + (tImag - uImag) * wr;
            }
        }
    }
    const invN = 1.0 / n;
    for (let i = 0; i < n; i++) {
        real[i] *= invN;
        imag[i] *= invN;
    }
}

function istftReconstruction(magPhaseData, numFrames, nFft, hopLength, winLength) {
    const numFreqBins = nFft / 2 + 1;
    const magData = new Float32Array(numFrames * numFreqBins);
    const phaseData = new Float32Array(numFrames * numFreqBins);

    for (let f = 0; f < numFrames; f++) {
        for (let k = 0; k < numFreqBins; k++) {
            magData[f * numFreqBins + k] = Math.exp(Math.min(magPhaseData[f * (numFreqBins * 2) + k], 100));
            phaseData[f * numFreqBins + k] = magPhaseData[f * (numFreqBins * 2) + numFreqBins + k];
        }
    }

    const window = new Float32Array(winLength);
    for (let i = 0; i < winLength; i++) {
        window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (winLength - 1)));
    }

    const outputLength = (numFrames - 1) * hopLength + winLength;
    const output = new Float32Array(outputLength);
    const windowSum = new Float32Array(outputLength);

    for (let f = 0; f < numFrames; f++) {
        const ifftReal = new Float32Array(nFft);
        const ifftImag = new Float32Array(nFft);

        for (let k = 0; k < numFreqBins; k++) {
            const mag = magData[f * numFreqBins + k];
            const phase = phaseData[f * numFreqBins + k];
            ifftReal[k] = mag * Math.cos(phase);
            ifftImag[k] = mag * Math.sin(phase);
        }
        for (let k = numFreqBins; k < nFft; k++) {
            const mirrorK = nFft - k;
            if (mirrorK > 0 && mirrorK < numFreqBins) {
                ifftReal[k] = ifftReal[mirrorK];
                ifftImag[k] = -ifftImag[mirrorK];
            }
        }

        ifftRadix2(ifftReal, ifftImag);

        const frameStart = f * hopLength;
        for (let n = 0; n < winLength; n++) {
            const outIdx = frameStart + n;
            if (outIdx < outputLength) {
                output[outIdx] += ifftReal[n] * window[n];
                windowSum[outIdx] += window[n] * window[n];
            }
        }
    }

    for (let i = 0; i < outputLength; i++) {
        if (windowSum[i] > 1e-8) {
            output[i] /= windowSum[i];
        }
    }

    return output;
}

function hzToMel(hz) {
    return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
    return 700 * (Math.pow(10, mel / 2595) - 1);
}

function createMelFilterbank(numBands, fftSize, sampleRate, fmin, fmax) {
    const numFftBins = fftSize / 2 + 1;
    const melMin = hzToMel(fmin);
    const melMax = hzToMel(fmax);
    const melPoints = new Float32Array(numBands + 2);
    for (let i = 0; i < melPoints.length; i++) {
        melPoints[i] = melMin + (melMax - melMin) * i / (melPoints.length - 1);
    }

    const binPoints = new Float32Array(melPoints.length);
    for (let i = 0; i < melPoints.length; i++) {
        binPoints[i] = Math.floor((fftSize + 1) * melToHz(melPoints[i]) / sampleRate);
    }

    const filterbank = new Float32Array(numBands * numFftBins);
    for (let m = 0; m < numBands; m++) {
        const fLeft = binPoints[m];
        const fCenter = binPoints[m + 1];
        const fRight = binPoints[m + 2];

        for (let k = fLeft; k < fCenter; k++) {
            if (k >= 0 && k < numFftBins) {
                filterbank[m * numFftBins + k] = (k - fLeft) / Math.max(fCenter - fLeft, 1);
            }
        }
        for (let k = fCenter; k < fRight; k++) {
            if (k >= 0 && k < numFftBins) {
                filterbank[m * numFftBins + k] = (fRight - k) / Math.max(fRight - fCenter, 1);
            }
        }
    }

    return filterbank;
}

// Cached mel filterbank (only depends on sr, which is fixed at 24kHz)
let _cachedMelFilterbank = null;
let _cachedMelFilterbankSr = 0;

function extractMelSpectrogram(audioFloat, sr) {
    const padLength = (N_FFT - HOP_SIZE) / 2;
    const padded = new Float32Array(audioFloat.length + 2 * padLength);
    for (let i = 0; i < padLength; i++) {
        padded[i] = audioFloat[padLength - i];
        padded[padded.length - 1 - i] = audioFloat[audioFloat.length - 1 - (padLength - i)];
    }
    padded.set(audioFloat, padLength);

    const numFrames = Math.floor((padded.length - N_FFT) / HOP_SIZE) + 1;
    const melBands = NUM_MELS;
    const numFreqBins = N_FFT / 2 + 1;

    // Reuse FFT buffers across frames (pool allocation)
    const real = new Float32Array(N_FFT);
    const imag = new Float32Array(N_FFT);
    const powerSpec = new Float32Array(numFrames * numFreqBins);

    for (let f = 0; f < numFrames; f++) {
        const start = f * HOP_SIZE;
        const specOffset = f * numFreqBins;
        for (let i = 0; i < N_FFT; i++) {
            real[i] = padded[start + i] * HANN_WINDOW[i];
            imag[i] = 0;
        }

        fftRadix2(real, imag);

        for (let i = 0; i < numFreqBins; i++) {
            powerSpec[specOffset + i] = real[i] * real[i] + imag[i] * imag[i];
        }
    }

    // Use cached mel filterbank (recompute only if sample rate changed)
    if (!_cachedMelFilterbank || _cachedMelFilterbankSr !== sr) {
        const fmax = sr / 2;
        _cachedMelFilterbank = createMelFilterbank(melBands, N_FFT, sr, 0, Math.min(fmax, 12000));
        _cachedMelFilterbankSr = sr;
    }
    const melFilterbank = _cachedMelFilterbank;

    const melSpec = new Float32Array(numFrames * melBands);
    for (let f = 0; f < numFrames; f++) {
        const specOffset = f * numFreqBins;
        for (let m = 0; m < melBands; m++) {
            let sum = 0;
            const fbOffset = m * numFreqBins;
            for (let k = 0; k < numFreqBins; k++) {
                sum += powerSpec[specOffset + k] * melFilterbank[fbOffset + k];
            }
            melSpec[f * melBands + m] = Math.log(Math.max(sum, 1e-10));
        }
    }

    const melStd = Math.sqrt(MEL_VAR);
    const invMelStd = 1 / melStd;
    for (let i = 0; i < melSpec.length; i++) {
        melSpec[i] = (melSpec[i] - MEL_MEAN) * invMelStd;
    }

    return { data: melSpec, frames: numFrames, melBands };
}

// SiFiGAN 统计文件缺失警告仅记录一次（避免日志刷屏）
let _sifiganStatsWarned = false;

/**
 * 线性插值将 F0 序列重采样到目标长度（mel 帧率对齐）。
 * mel 帧率 = SAMPLE_RATE / HOP_SIZE = 24000 / 480 = 50Hz；buildF0FrameSequence 已产出该帧率，
 * 此函数仅在 F0 长度与 mel 帧数不一致时做长度对齐（防御性）。
 * @param {Float32Array|Array} src - 源 F0 序列（Hz）
 * @param {number} targetLen - 目标长度（mel 帧数）
 * @returns {Float32Array} 重采样后的 F0 序列
 */
function resizeF0Linear(src, targetLen) {
    const srcArr = src instanceof Float32Array ? src : new Float32Array(src);
    if (targetLen <= 0) return new Float32Array(0);
    if (srcArr.length === 0) return new Float32Array(targetLen);
    if (srcArr.length === targetLen) return srcArr;
    const out = new Float32Array(targetLen);
    const ratio = (srcArr.length - 1) / Math.max(1, targetLen - 1);
    for (let i = 0; i < targetLen; i++) {
        const srcIdx = i * ratio;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(srcArr.length - 1, lo + 1);
        const frac = srcIdx - lo;
        out[i] = srcArr[lo] * (1 - frac) + srcArr[hi] * frac;
    }
    return out;
}

// ---- Post-processing class ----

class Postprocessing {
    /**
     * Extract reference mel spectrogram (JS fallback)
     */
    extractRefMel(refAudioWavBuffer) {
        const { data: audioFloat, sampleRate: srcSr } = parseWavBuffer(refAudioWavBuffer);
        const resampled = resampleLinear(audioFloat, srcSr, SAMPLE_RATE);
        const melResult = extractMelSpectrogram(resampled, SAMPLE_RATE);
        return melResult;
    }

    /**
     * Extract reference mel spectrogram using ONNX mel_transform model
     */
    async extractRefMelOnnx(sessions, refAudioWavBuffer, isFP16, useStaticShapes = false) {
        const { data: audioFloat, sampleRate: srcSr } = parseWavBuffer(refAudioWavBuffer);
        const resampled = resampleLinear(audioFloat, srcSr, SAMPLE_RATE);
        const floatType = isFP16 ? 'float16' : 'float32';
        const NPU_STATIC_NUM_SAMPLES = 240000;
        if (useStaticShapes && resampled.length < NPU_STATIC_NUM_SAMPLES) {
            const padded = new Float32Array(NPU_STATIC_NUM_SAMPLES);
            padded.set(resampled);
            const waveform = createFloatTensor(floatType, padded, [1, NPU_STATIC_NUM_SAMPLES]);
            const results = await sessions.melTransform.run({ waveform });
            const melOutput = results['mel_spectrogram'];
            const melData = outputToFloat32(melOutput);
            const actualFrames = Math.ceil(resampled.length / HOP_SIZE);
            const melDims = melOutput.dims;
            const maxFrames = melDims[1];
            const frames = Math.min(actualFrames, maxFrames);
            const trimmed = melData.subarray(0, frames * MEL_DIM);
            return { data: trimmed.slice(), frames, melBands: MEL_DIM };
        }
        const waveform = createFloatTensor(floatType, resampled, [1, resampled.length]);
        const results = await sessions.melTransform.run({ waveform });
        const melOutput = results['mel_spectrogram'];
        const melData = outputToFloat32(melOutput);
        const melDims = melOutput.dims;
        const frames = melDims[1];
        return { data: melData, frames, melBands: MEL_DIM };
    }

    /**
     * Run vocoder in chunked mode for long audio
     */
    async runVocoderChunked(sessions, melData, totalFrames, isFP16, useStaticShapes = false, vocoderType = 'default', f0Data = null, sifiganStatsMissing = false) {
        const chunkSize = VOCODER_CHUNK_FRAMES;
        const overlapFrames = VOCODER_OVERLAP_FRAMES;
        const totalSamples = totalFrames * HOP_SIZE;
        const output = new Float32Array(totalSamples);
        const t0 = performance.now();
        const floatType = isFP16 ? 'float16' : 'float32';

        // Yield to event loop to keep window responsive during long DML inference
        const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

        const padFloat = (src, len) => {
            if (src.length >= len) return src;
            const padded = new Float32Array(len);
            padded.set(src);
            return padded;
        };

        // ---- SiFiGAN 双输入（mel + f0）准备 ----
        // mel 帧率 = SAMPLE_RATE / HOP_SIZE = 24000 / 480 = 50Hz；buildF0FrameSequence 已产出该帧率的 F0，
        // 此处仅需将 F0 长度对齐到 totalFrames（防御性线性插值）。
        const useSifiganF0 = vocoderType === 'sifigan';
        let effectiveF0 = null;
        if (useSifiganF0) {
            if (f0Data && f0Data.length > 0) {
                const srcArr = f0Data instanceof Float32Array ? f0Data : new Float32Array(f0Data);
                effectiveF0 = (srcArr.length === totalFrames) ? srcArr : resizeF0Linear(srcArr, totalFrames);
            } else {
                // F0 缺失处理（简化策略）：SiFiGAN 的 f0 是 ONNX 必需输入，无法跳过；
                // 立即报错并提示用户检查 F0 配置，不修改 vocoderType 设置（仅本次推理失败）。
                console.error('[OnnxSVSPipeline] vocoderType=sifigan 但 F0 缺失，回退默认 vocoder 完成本次推理');
                throw new Error('SiFiGAN vocoder 需要 F0 输入但 F0 数据缺失，请检查 F0 配置（pitchCurveF0 / f0Envelope / notes）或切换为默认 vocoder');
            }
        }

        // 统计文件缺失兜底：实际归一化发生在 SiFiGAN ONNX 模型内部（导出时已嵌入 stats 常量），
        // stats 缺失意味着 ONNX 模型本身未正确导出归一化常量。此处无法在运行时补偿（兜底为零均值单位方差，
        // 即假设输入已是归一化状态），仅记录警告（首次），质量会下降。
        if (useSifiganF0 && sifiganStatsMissing && !_sifiganStatsWarned) {
            console.warn('[OnnxSVSPipeline] SiFiGAN 统计文件缺失，输入归一化可能不可用（兜底为零均值单位方差，质量会下降）');
            _sifiganStatsWarned = true;
        }

        // 构造 vocoder 输入字典：default → { mel }；sifigan → { mel, f0 }（f0 与 mel 同帧率、同 seq_len）
        const buildVocoderInputs = (melTensor, vocSeqLen, frameOffset, frameCount) => {
            if (!useSifiganF0 || !effectiveF0) {
                return { mel: melTensor };
            }
            // F0 分块：取当前 chunk 对应帧区间，静态形状时 pad 到 vocSeqLen（与 mel 一致）
            let chunkF0;
            if (frameCount >= vocSeqLen) {
                chunkF0 = effectiveF0.subarray(frameOffset, frameOffset + vocSeqLen);
            } else {
                chunkF0 = padFloat(effectiveF0.subarray(frameOffset, frameOffset + frameCount), vocSeqLen);
            }
            const f0Tensor = createFloatTensor(floatType, chunkF0, [1, vocSeqLen, 1]);
            return { mel: melTensor, f0: f0Tensor };
        };

        // 短音频（≤chunkSizeframes ≈ 20.5秒）直接一次性推理，避免分chunks开销
        if (totalFrames <= chunkSize) {
            const vocSeqLen = useStaticShapes ? NPU_VOCODER_SEQ_LEN : totalFrames;
            const melArr = melData instanceof Float32Array ? melData : new Float32Array(melData);
            const paddedMel = useStaticShapes ? padFloat(melArr, vocSeqLen * MEL_DIM) : melArr;
            const melTensor = createFloatTensor(floatType, paddedMel, [1, vocSeqLen, MEL_DIM]);
            const vocoderInputs = buildVocoderInputs(melTensor, vocSeqLen, 0, totalFrames);
            const results = await sessions.vocoder.run(vocoderInputs);
            await yieldToEventLoop(); // Prevent UI freeze during DML inference
            const waveform = outputToFloat32(results['waveform']);
            const copyLen = Math.min(waveform.length, totalSamples);
            output.set(waveform.subarray(0, copyLen));
            normalizePeakTo(output);
            return output;
        }

        // 长音频分chunks推理
        const stepFrames = chunkSize - overlapFrames;
        const weightSum = new Float32Array(totalSamples);

        const fadeSamples = overlapFrames * HOP_SIZE;
        const fadeWindow = new Float32Array(fadeSamples);
        for (let i = 0; i < fadeSamples; i++) {
            fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));
        }

        let framePos = 0;
        let chunkIdx = 0;

        while (framePos < totalFrames) {
            const chunkStart = Math.max(0, framePos - (chunkIdx > 0 ? overlapFrames : 0));
            const chunkEnd = Math.min(chunkStart + chunkSize, totalFrames);
            const currentChunkFrames = chunkEnd - chunkStart;

            const chunkMel = new Float32Array(currentChunkFrames * MEL_DIM);
            chunkMel.set(melData.subarray(chunkStart * MEL_DIM, chunkEnd * MEL_DIM));

            const vocSeqLen = useStaticShapes ? NPU_VOCODER_SEQ_LEN : currentChunkFrames;
            const paddedChunk = useStaticShapes ? padFloat(chunkMel, vocSeqLen * MEL_DIM) : chunkMel;
            const melTensor = createFloatTensor(floatType, paddedChunk, [1, vocSeqLen, MEL_DIM]);
            const vocoderInputs = buildVocoderInputs(melTensor, vocSeqLen, chunkStart, currentChunkFrames);
            const results = await sessions.vocoder.run(vocoderInputs);
            await yieldToEventLoop(); // Prevent UI freeze between vocoder chunks
            const waveform = outputToFloat32(results['waveform']);

            const writeStart = chunkStart * HOP_SIZE;
            const writeLen = Math.min(waveform.length, totalSamples - writeStart);

            for (let i = 0; i < writeLen; i++) {
                const outIdx = writeStart + i;
                if (outIdx >= totalSamples) break;
                let w = 1.0;
                if (chunkIdx > 0 && i < fadeSamples) {
                    w = fadeWindow[i];
                }
                if (chunkEnd < totalFrames && i >= writeLen - fadeSamples) {
                    w = Math.min(w, 1.0 - fadeWindow[writeLen - 1 - i]);
                }
                output[outIdx] += waveform[i] * w;
                weightSum[outIdx] += w;
            }

            framePos = chunkIdx === 0 ? chunkEnd : chunkEnd - overlapFrames;
            chunkIdx++;
        }

        for (let i = 0; i < totalSamples; i++) {
            if (weightSum[i] > 1e-8) {
                output[i] /= weightSum[i];
            }
        }

        normalizePeakTo(output, totalSamples);

        const elapsed = performance.now() - t0;
        console.log(`[OnnxSVSPipeline] Vocoder chunked: ${totalFrames} frames, ${chunkIdx} chunks, ${elapsed.toFixed(0)}ms`);
        return output;
    }

    /**
     * Extract F0 from WAV buffer (simple autocorrelation)
     */
    extractRefF0FromWav(wavBuffer) {
        const { data: audioFloat, sampleRate: srcSr } = parseWavBuffer(wavBuffer);
        const resampled = resampleLinear(audioFloat, srcSr, SAMPLE_RATE);
        const f0 = new Float32Array(Math.floor(resampled.length / HOP_SIZE));
        const minRms = 0.01;
        const frameSize = HOP_SIZE;
        for (let i = 0; i < f0.length; i++) {
            const start = i * frameSize;
            const end = Math.min(start + frameSize, resampled.length);
            let rms = 0;
            for (let j = start; j < end; j++) {
                rms += resampled[j] * resampled[j];
            }
            rms = Math.sqrt(rms / (end - start));
            if (rms < minRms) {
                f0[i] = 0;
                continue;
            }
            let bestLag = 0;
            let bestCorr = 0;
            const minLag = Math.floor(SAMPLE_RATE / 1000);
            const maxLag = Math.floor(SAMPLE_RATE / 50);
            for (let lag = minLag; lag <= maxLag; lag++) {
                let corr = 0;
                let energy = 0;
                for (let j = 0; j < Math.min(frameSize, resampled.length - start - lag); j++) {
                    corr += resampled[start + j] * resampled[start + j + lag];
                    energy += resampled[start + j] * resampled[start + j];
                }
                if (energy > 0) corr /= energy;
                if (corr > bestCorr) {
                    bestCorr = corr;
                    bestLag = lag;
                }
            }
            if (bestCorr > 0.3 && bestLag > 0) {
                f0[i] = SAMPLE_RATE / bestLag;
            } else {
                f0[i] = 0;
            }
        }
        return f0;
    }

    /**
     * Extract reference note pitches from WAV buffer
     */
    extractRefNotePitches(wavBuffer) {
        try {
            const f0 = this.extractRefF0FromWav(wavBuffer);
            if (!f0 || f0.length === 0) return null;
            const notePitches = [];
            for (let i = 0; i < f0.length; i++) {
                if (f0[i] > 0) {
                    const midi = 69 + 12 * Math.log2(f0[i] / 440);
                    if (midi >= 24 && midi <= 108) {
                        notePitches.push(midi);
                    }
                }
            }
            return notePitches.length > 0 ? notePitches : null;
        } catch (e) {
            return null;
        }
    }
}

module.exports = {
    Postprocessing,
    parseWavBuffer,
    resampleLinear,
    bessel0,
    bitReversePermute,
    fftRadix2,
    ifftRadix2,
    istftReconstruction,
    hzToMel,
    melToHz,
    createMelFilterbank,
    extractMelSpectrogram,
};
