const { MEL_DIM, HOP_SIZE, SIFIGAN_HOP_SIZE, VOCODER_CHUNK_FRAMES, VOCODER_OVERLAP_FRAMES, NPU_VOCODER_SEQ_LEN, SAMPLE_RATE, N_FFT, NUM_MELS, MEL_MEAN, MEL_VAR } = require('./constants');
const { TWIDDLE_REAL, TWIDDLE_IMAG, HANN_WINDOW } = require('./constants');
const { createFloatTensor, outputToFloat32, disposeTensor, normalizePeakTo, gpuDrainAdaptive } = require('./utils');
const { wsolaCrossfade } = require('./wsola');
const { loudnormFinal } = require('./loudnorm');

/**
 * Read diagnosticMode flag lazily from settings. Returns false if settings
 * cannot be loaded (e.g. running outside Electron main process, in tests).
 * Used to gate [VocoderDiag] statistical console.log blocks; NaN/Inf fatal
 * console.error is always-on regardless of this flag.
 * @returns {boolean}
 */
function _readDiagnosticMode() {
    try {
        const { loadSettings } = require('../../main/settings');
        return loadSettings().diagnosticMode === true;
    } catch (_) {
        return false;
    }
}

/**
 * Read enableLoudnormFinal flag lazily from settings. Returns true (the spec
 * default) if settings cannot be loaded (e.g. running outside Electron main
 * process, in tests without settings). When true, the final vocoder output is
 * EBU R128-normalized to −14 LUFS with a −1 dBTP true-peak limit.
 * @returns {boolean}
 */
function _readEnableLoudnormFinal() {
    try {
        const { loadSettings } = require('../../main/settings');
        return loadSettings().enableLoudnormFinal !== false;
    } catch (_) {
        return true;
    }
}

/**
 * Read enableAntiAliasing flag lazily from settings. Returns false (the spec
 * default — anti-aliasing is opt-in to avoid changing default output
 * characteristics) if settings cannot be loaded.
 * @returns {boolean}
 */
function _readEnableAntiAliasing() {
    try {
        const { loadSettings } = require('../../main/settings');
        return loadSettings().enableAntiAliasing === true;
    } catch (_) {
        return false;
    }
}

/**
 * 2nd-order Butterworth low-pass filter (biquad, bilinear-transformed IIR).
 *
 * Provides steeper stopband rejection (−12 dB/oct vs −6 dB/oct for 1st-order)
 * when operating at the 2× oversampled rate. Used in the 2× oversampling
 * anti-aliasing pipeline.
 *
 * @param {Float32Array} samples - input audio
 * @param {number} srcSr - source sample rate (the 2× oversampled rate)
 * @param {number} cutoffFreq - cutoff frequency (Hz), typically dstSr/2
 * @returns {Float32Array} filtered copy
 */
function _butterworthLp2(samples, srcSr, cutoffFreq) {
    // Bilinear transform of 2nd-order Butterworth H(s) = 1/(s²/ωc² + √2·s/ωc + 1).
    // Q = 1/√2 for Butterworth maximally-flat response.
    const omega = 2 * Math.PI * cutoffFreq / srcSr;
    const cosOmega = Math.cos(omega);
    const sinOmega = Math.sin(omega);
    const Q = 1 / Math.SQRT2; // 0.7071 — Butterworth
    const alpha = sinOmega / (2 * Q);

    // Biquad coefficients (cookbook / RBJ)
    const b0 = (1 - cosOmega) / 2;
    const b1 = 1 - cosOmega;
    const b2 = (1 - cosOmega) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosOmega;
    const a2 = 1 - alpha;

    // Normalize by a0
    const nb0 = b0 / a0;
    const nb1 = b1 / a0;
    const nb2 = b2 / a0;
    const na1 = a1 / a0;
    const na2 = a2 / a0;

    const out = new Float32Array(samples.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < samples.length; i++) {
        const x0 = samples[i];
        const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
        out[i] = y0;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
    }
    return out;
}

/**
 * 2× oversampling anti-aliasing pipeline for decimation.
 *
 * Complete pipeline: 2× upsample (zero-stuff) → anti-image LP (Butterworth 2nd-order
 * at srcSr/2) → anti-alias LP (Butterworth 2nd-order at dstSr/2) → decimate by 2
 * (discard every other sample).
 *
 * The 2× oversampled rate doubles the filter's Nyquist, widening the transition
 * band relative to the target cutoff. This lets the 2nd-order Butterworth achieve
 * far better stopband attenuation than the 1st-order filter operating directly at
 * srcSr, without in-phase distortion from an overly steep IIR near the Nyquist.
 *
 * After oversampling LP, the signal is at 2×srcSr with images removed. We then
 * apply the anti-alias LP at dstSr/2 (also at 2×srcSr clock) and decimate by 2
 * to return to srcSr, ready for the Kaiser sinc resampler.
 *
 * @param {Float32Array} samples - input audio at srcSr
 * @param {number} srcSr - source sample rate
 * @param {number} dstSr - destination sample rate
 * @returns {Float32Array} anti-aliased input, same length as original, at srcSr
 */
function _oversample2xAntiAlias(samples, srcSr, dstSr) {
    const N = samples.length;
    if (N === 0) return samples;

    // Step 1: 2× upsample via zero-stuffing
    // Insert zeros between samples: [s0, 0, s1, 0, s2, 0, ...]
    // The spectral effect is: original spectrum replicated at multiples of srcSr.
    const upN = N * 2;
    const upsampled = new Float32Array(upN);
    for (let i = 0; i < N; i++) {
        upsampled[i * 2] = samples[i];
        // odd indices remain 0 (zero-stuffing)
    }

    // Step 2: Anti-image LP at srcSr/2 (remove zero-stuffing images)
    // Operating at 2×srcSr clock, cutoff = srcSr/2 (= original Nyquist).
    // This restores the original signal shape by removing the spectral replicas
    // created by zero-stuffing, while preserving all original content ≤ srcSr/2.
    const antiImaged = _butterworthLp2(upsampled, 2 * srcSr, srcSr / 2);

    // Step 3: Anti-alias LP at dstSr/2 (attenuate content above destination Nyquist)
    // Still operating at 2×srcSr clock. The wider Nyquist (srcSr vs srcSr/2 in
    // the non-oversampled case) gives the 2nd-order filter a gentler transition
    // band and much better stopband attenuation near dstSr/2.
    const antiAliased = _butterworthLp2(antiImaged, 2 * srcSr, dstSr / 2);

    // Step 4: Decimate by 2 (discard every other sample) → back to srcSr
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        out[i] = antiAliased[i * 2];
    }
    return out;
}

/**
 * Post-processing: mel transform, vocoder, audio generation
 * Also includes audio utility functions (parseWavBuffer, resampleLinear, mel spectrogram, etc.)
 */

// ---- Audio utility functions ----
// disposeTensor 从 utils.js 导入，全管线共用

/**
 * 校验 vocoder 输出波形是否有效。
 * DML 在显存耗尽边界可能不抛错而是返回全零/NaN 波形（silent failure），
 * 若不拦截会导致应用误以为合成完毕、播放空声音。
 *
 * 抽样检查：对大 chunk 全量扫描开销高，按 1024 点抽样足够检测 silent failure。
 * NaN 检测优先（任一抽样点为 NaN 即判定无效），全零检测需要所有抽样点均为零。
 *
 * @param {Float32Array} waveform - vocoder 输出波形
 * @param {number} chunkIndex - chunk 索引（用于错误信息）
 * @throws {Error} 当波形为空、包含 NaN 或全零时
 */
function validateVocoderOutput(waveform, chunkIndex) {
    if (!waveform || waveform.length === 0) {
        throw new Error(`Vocoder chunk ${chunkIndex} returned empty waveform (length=0, likely GPU VRAM exhaustion)`);
    }
    const sampleStep = Math.max(1, Math.floor(waveform.length / 1024));
    let nonZeroCount = 0;
    let sampledCount = 0;
    for (let i = 0; i < waveform.length; i += sampleStep) {
        const v = waveform[i];
        if (Number.isNaN(v)) {
            throw new Error(`Vocoder chunk ${chunkIndex} produced NaN output (GPU VRAM exhaustion or device removed)`);
        }
        if (Math.abs(v) > 1e-7) nonZeroCount++;
        sampledCount++;
    }
    if (sampledCount > 0 && nonZeroCount === 0) {
        throw new Error(`Vocoder chunk ${chunkIndex} produced all-zero output (GPU VRAM exhaustion or device removed)`);
    }
}

/**
 * 判断错误是否为 GPU 显存耗尽相关（OOM / device removed）。
 * 用于在 catch 中区分可重试的显存错误与其他致命错误。
 * @param {Error} err
 * @returns {boolean}
 */
function isVramOOMError(err) {
    const msg = (err && err.message) ? err.message.toLowerCase() : '';
    if (!msg) return false;
    // ONNX Runtime / DirectML 常见显存错误关键词
    return msg.includes('out of memory') ||
           msg.includes('cuda') && msg.includes('memory') ||
           msg.includes('dxgi_error_device_removed') ||
           msg.includes('dxgi_error_device_hung') ||
           msg.includes('0x887a0006') ||
           msg.includes('0x887a0005') ||
           // DmlCommandRecorder 抛出的错误码不含 "0x" 前缀（如 "Exception(1) tid(ac88) 887a0006"）
           msg.includes('887a0006') ||
           msg.includes('887a0005') ||
           msg.includes('gpu device') && msg.includes('removed') ||
           msg.includes('failed to allocate') ||
           msg.includes('memalloc');
}

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

    // Fast path: typed-array views for common formats (32-bit float, 16-bit PCM).
    // dataOffset is relative to the DataView start (= buf.byteOffset); convert to
    // absolute offset in the underlying ArrayBuffer for typed-array construction.
    const absDataOffset = buf.byteOffset + dataOffset;
    const availBytes = buf.byteOffset + buf.byteLength - absDataOffset;
    const availSamples = Math.max(0, Math.floor(availBytes / bytesPerSample));
    const usableSamples = Math.min(totalSamples, availSamples);
    const usableFrames = Math.floor(usableSamples / numChannels);
    // TypedArray constructors require byteOffset to be a multiple of element size
    const aligned = (absDataOffset % bytesPerSample) === 0;

    if (aligned && audioFormat === 3 && bitsPerSample === 32 && usableSamples > 0) {
        // 32-bit IEEE float: direct Float32Array view over the buffer
        const src = new Float32Array(buf.buffer, absDataOffset, usableSamples);
        if (numChannels === 1) {
            audioFloat.set(src.subarray(0, usableFrames));
        } else {
            for (let f = 0; f < usableFrames; f++) {
                let sum = 0;
                const base = f * numChannels;
                for (let ch = 0; ch < numChannels; ch++) sum += src[base + ch];
                audioFloat[f] = sum / numChannels;
            }
        }
    } else if (aligned && audioFormat === 1 && bitsPerSample === 16 && usableSamples > 0) {
        // 16-bit PCM: direct Int16Array view, convert + channel-average
        const src = new Int16Array(buf.buffer, absDataOffset, usableSamples);
        const inv32768 = 1 / 32768;
        for (let f = 0; f < usableFrames; f++) {
            let sum = 0;
            const base = f * numChannels;
            for (let ch = 0; ch < numChannels; ch++) sum += src[base + ch];
            audioFloat[f] = (sum * inv32768) / numChannels;
        }
    } else {
        // Fallback: per-sample DataView for unusual formats (24-bit, 8-bit, 32-bit int, or unaligned)
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
    }

    return { data: audioFloat, sampleRate };
}

function resampleLinear(audioFloat, srcSampleRate, dstSampleRate) {
    if (srcSampleRate === dstSampleRate) return audioFloat;
    const ratio = srcSampleRate / dstSampleRate;
    const newLength = Math.floor(audioFloat.length / ratio);
    if (newLength <= 0) return new Float32Array(0);

    // 抗混叠：降采样时（srcSr > dstSr）使用 2× 过采样管线
    // 2× upsample (zero-stuff) → anti-image LP (Butterworth 2nd-order, srcSr/2)
    // → anti-alias LP (Butterworth 2nd-order, dstSr/2) → decimate by 2
    // 完整管线在 2×srcSr 时钟下运行，比旧 1st-order LP 在 srcSr 时钟下
    // 有更宽的过渡带和更陡的阻带衰减（−12 dB/oct vs −6 dB/oct）。
    // 受 enableAntiAliasing 设置控制（默认 false — 不改变默认输出特征）。
    const input = (srcSampleRate > dstSampleRate && _readEnableAntiAliasing())
        ? _oversample2xAntiAlias(audioFloat, srcSampleRate, dstSampleRate)
        : audioFloat;

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
        const right = Math.min(input.length - 1, Math.ceil(center + halfWidth));

        let sum = 0;
        let weightSum = 0;
        for (let j = left; j <= right; j++) {
            const t = center - j;
            if (Math.abs(t) < 1e-7) {
                sum += input[j];
                weightSum += 1;
            } else {
                const sincVal = Math.sin(twoPiCutoff * t) * invPi / t;
                const kaiserArg = 1 - (t * invWidth) * (t * invWidth);
                const windowVal = kaiserArg >= 0
                    ? bessel0(kaiserBeta * Math.sqrt(kaiserArg)) / bessel0Beta
                    : 0;
                const w = sincVal * windowVal;
                sum += input[j] * w;
                weightSum += w;
            }
        }
        out[i] = weightSum > 1e-8 ? sum / weightSum : 0;
    }
    return out;
}

/**
 * 异步分块版 resampleLinear：每 RESAMPLE_YIELD_EVERY 个样本 setImmediate yield 一次，
 * 避免长音频（分钟级）同步阻塞主线程导致 UI 无响应。
 * 内部计算逻辑与 resampleLinear 完全一致，仅在外层循环插入 yield 点。
 */
const RESAMPLE_YIELD_EVERY = 8192;
async function resampleLinearAsync(audioFloat, srcSampleRate, dstSampleRate) {
    if (srcSampleRate === dstSampleRate) return audioFloat;
    const ratio = srcSampleRate / dstSampleRate;
    const newLength = Math.floor(audioFloat.length / ratio);
    if (newLength <= 0) return new Float32Array(0);

    // 抗混叠：与 resampleLinear 同步实现（详见上方注释）。
    // 2× 过采样完整管线：upsample → anti-image LP → anti-alias LP → decimate
    const input = (srcSampleRate > dstSampleRate && _readEnableAntiAliasing())
        ? _oversample2xAntiAlias(audioFloat, srcSampleRate, dstSampleRate)
        : audioFloat;

    const kaiserBeta = 5.0;
    const halfWidth = Math.ceil(12 * kaiserBeta / 5);
    const cutoff = (dstSampleRate < srcSampleRate ? 0.95 * dstSampleRate / srcSampleRate : 0.95) * 0.5;
    const twoPiCutoff = 2 * Math.PI * cutoff;
    const invPi = 1 / Math.PI;
    const invWidth = 1 / (2 * halfWidth + 1);
    const bessel0Beta = bessel0(kaiserBeta);

    const out = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
        const center = (i + 0.5) * ratio;
        const left = Math.max(0, Math.floor(center - halfWidth));
        const right = Math.min(input.length - 1, Math.ceil(center + halfWidth));

        let sum = 0;
        let weightSum = 0;
        for (let j = left; j <= right; j++) {
            const t = center - j;
            if (Math.abs(t) < 1e-7) {
                sum += input[j];
                weightSum += 1;
            } else {
                const sincVal = Math.sin(twoPiCutoff * t) * invPi / t;
                const kaiserArg = 1 - (t * invWidth) * (t * invWidth);
                const windowVal = kaiserArg >= 0
                    ? bessel0(kaiserBeta * Math.sqrt(kaiserArg)) / bessel0Beta
                    : 0;
                const w = sincVal * windowVal;
                sum += input[j] * w;
                weightSum += w;
            }
        }
        out[i] = weightSum > 1e-8 ? sum / weightSum : 0;

        // 每 N 个样本 yield 一次，让事件循环处理 UI 响应
        if ((i & (RESAMPLE_YIELD_EVERY - 1)) === 0 && i > 0) {
            await new Promise(r => setImmediate(r));
        }
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
// 注意：预计算的 TWIDDLE_REAL/IMAG 仅对 n == N_FFT 有效。当传入其他尺寸时
// 必须动态计算旋转因子，否则会静默返回错误的频谱（生产路径始终用 N_FFT，
// 但单元测试和未来复用可能传入任意 2 的幂）。
// 蝶形运算为标准 DIT 形式：X[idx1] = t + w*u, X[idx2] = t - w*u
// （位反转在前 → DIT）。先前版本误用 DIF 蝶形 (t-u)*w 搭配 DIT 位反转，
// 对非 DC 信号产生错误频谱。
function fftRadix2(real, imag) {
    const n = real.length;
    const useTable = (n === TWIDDLE_REAL.length * 2);
    bitReversePermute(real, imag);
    for (let len = 2; len <= n; len *= 2) {
        const halfLen = len / 2;
        const step = n / len;
        for (let i = 0; i < n; i += len) {
            for (let j = 0; j < halfLen; j++) {
                const idx1 = i + j;
                const idx2 = i + j + halfLen;
                let wr, wi;
                if (useTable) {
                    wr = TWIDDLE_REAL[j * step];
                    wi = TWIDDLE_IMAG[j * step];
                } else {
                    const theta = -2 * Math.PI * j / len;
                    wr = Math.cos(theta);
                    wi = Math.sin(theta);
                }
                const tReal = real[idx1];
                const tImag = imag[idx1];
                const uReal = real[idx2];
                const uImag = imag[idx2];
                // w * u
                const wuReal = wr * uReal - wi * uImag;
                const wuImag = wr * uImag + wi * uReal;
                real[idx1] = tReal + wuReal;
                imag[idx1] = tImag + wuImag;
                real[idx2] = tReal - wuReal;
                imag[idx2] = tImag - wuImag;
            }
        }
    }
}

// Radix-2 IFFT (in-place, bit-reversed input → standard output)
function ifftRadix2(real, imag) {
    const n = real.length;
    const useTable = (n === TWIDDLE_REAL.length * 2);
    bitReversePermute(real, imag);
    for (let len = 2; len <= n; len *= 2) {
        const halfLen = len / 2;
        const step = n / len;
        for (let i = 0; i < n; i += len) {
            for (let j = 0; j < halfLen; j++) {
                const idx1 = i + j;
                const idx2 = i + j + halfLen;
                let wr, wi;
                if (useTable) {
                    wr = TWIDDLE_REAL[j * step];
                    wi = -TWIDDLE_IMAG[j * step]; // 共轭: 正号
                } else {
                    const theta = 2 * Math.PI * j / len;
                    wr = Math.cos(theta);
                    wi = Math.sin(theta);
                }
                const tReal = real[idx1];
                const tImag = imag[idx1];
                const uReal = real[idx2];
                const uImag = imag[idx2];
                // w_conj * u
                const wuReal = wr * uReal - wi * uImag;
                const wuImag = wr * uImag + wi * uReal;
                real[idx1] = tReal + wuReal;
                imag[idx1] = tImag + wuImag;
                real[idx2] = tReal - wuReal;
                imag[idx2] = tImag - wuImag;
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

    const _ifftReal = new Float32Array(nFft);
    const _ifftImag = new Float32Array(nFft);

    for (let f = 0; f < numFrames; f++) {
        _ifftReal.fill(0);
        _ifftImag.fill(0);

        for (let k = 0; k < numFreqBins; k++) {
            const mag = magData[f * numFreqBins + k];
            const phase = phaseData[f * numFreqBins + k];
            _ifftReal[k] = mag * Math.cos(phase);
            _ifftImag[k] = mag * Math.sin(phase);
        }
        for (let k = numFreqBins; k < nFft; k++) {
            const mirrorK = nFft - k;
            if (mirrorK > 0 && mirrorK < numFreqBins) {
                _ifftReal[k] = _ifftReal[mirrorK];
                _ifftImag[k] = -_ifftImag[mirrorK];
            }
        }

        ifftRadix2(_ifftReal, _ifftImag);

        const frameStart = f * hopLength;
        for (let n = 0; n < winLength; n++) {
            const outIdx = frameStart + n;
            if (outIdx < outputLength) {
                output[outIdx] += _ifftReal[n] * window[n];
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
// CSR representation of the cached mel filterbank (only non-zero entries per band).
// Reduces the inner mel loop from O(numFreqBins) to O(~triangle_width) per band.
let _cachedMelFilterbankCsr = null; // { values: Float32Array, colIdx: Int32Array, rowPtr: Int32Array }

/**
 * Build a CSR (Compressed Sparse Row) representation of a dense mel filterbank.
 * Each mel triangle has many zero bins; CSR stores only non-zero weights and their bin indices.
 * @param {Float32Array} filterbank - dense filterbank [numBands * numFftBins]
 * @param {number} numBands
 * @param {number} numFftBins
 * @returns {{values: Float32Array, colIdx: Int32Array, rowPtr: Int32Array}}
 */
function buildMelFilterbankCsr(filterbank, numBands, numFftBins) {
    // First pass: count non-zeros per row
    const rowPtr = new Int32Array(numBands + 1);
    for (let m = 0; m < numBands; m++) {
        const fbOffset = m * numFftBins;
        let count = 0;
        for (let k = 0; k < numFftBins; k++) {
            if (filterbank[fbOffset + k] !== 0) count++;
        }
        rowPtr[m + 1] = rowPtr[m] + count;
    }
    const nnz = rowPtr[numBands];
    const values = new Float32Array(nnz);
    const colIdx = new Int32Array(nnz);
    // Second pass: fill values and colIdx
    for (let m = 0; m < numBands; m++) {
        const fbOffset = m * numFftBins;
        let idx = rowPtr[m];
        for (let k = 0; k < numFftBins; k++) {
            const v = filterbank[fbOffset + k];
            if (v !== 0) {
                values[idx] = v;
                colIdx[idx] = k;
                idx++;
            }
        }
    }
    return { values, colIdx, rowPtr };
}

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

    // Use cached mel filterbank + CSR (recompute only if sample rate changed)
    if (!_cachedMelFilterbank || _cachedMelFilterbankSr !== sr) {
        const fmax = sr / 2;
        _cachedMelFilterbank = createMelFilterbank(melBands, N_FFT, sr, 0, Math.min(fmax, 12000));
        _cachedMelFilterbankCsr = buildMelFilterbankCsr(_cachedMelFilterbank, melBands, numFreqBins);
        _cachedMelFilterbankSr = sr;
    }
    const melCsr = _cachedMelFilterbankCsr;

    const melSpec = new Float32Array(numFrames * melBands);
    for (let f = 0; f < numFrames; f++) {
        const specOffset = f * numFreqBins;
        for (let m = 0; m < melBands; m++) {
            let sum = 0;
            const rowStart = melCsr.rowPtr[m];
            const rowEnd = melCsr.rowPtr[m + 1];
            for (let idx = rowStart; idx < rowEnd; idx++) {
                sum += powerSpec[specOffset + melCsr.colIdx[idx]] * melCsr.values[idx];
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

/**
 * 异步分块版 extractMelSpectrogram：FFT 帧循环与 mel filterbank 应用循环
 * 每 EXTRACT_MEL_YIELD_EVERY 帧插入 setImmediate yield，避免长音频 JS FFT
 * 同步阻塞主线程导致 UI 无响应。
 * 计算逻辑与 extractMelSpectrogram 完全一致，仅插入 yield 点。
 */
const EXTRACT_MEL_YIELD_EVERY = 32;
async function extractMelSpectrogramAsync(audioFloat, sr) {
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

        if ((f % EXTRACT_MEL_YIELD_EVERY) === 0 && f > 0) {
            await new Promise(r => setImmediate(r));
        }
    }

    if (!_cachedMelFilterbank || _cachedMelFilterbankSr !== sr) {
        const fmax = sr / 2;
        _cachedMelFilterbank = createMelFilterbank(melBands, N_FFT, sr, 0, Math.min(fmax, 12000));
        _cachedMelFilterbankCsr = buildMelFilterbankCsr(_cachedMelFilterbank, melBands, numFreqBins);
        _cachedMelFilterbankSr = sr;
    }
    const melCsr = _cachedMelFilterbankCsr;

    const melSpec = new Float32Array(numFrames * melBands);
    for (let f = 0; f < numFrames; f++) {
        const specOffset = f * numFreqBins;
        for (let m = 0; m < melBands; m++) {
            let sum = 0;
            const rowStart = melCsr.rowPtr[m];
            const rowEnd = melCsr.rowPtr[m + 1];
            for (let idx = rowStart; idx < rowEnd; idx++) {
                sum += powerSpec[specOffset + melCsr.colIdx[idx]] * melCsr.values[idx];
            }
            melSpec[f * melBands + m] = Math.log(Math.max(sum, 1e-10));
        }
        if ((f % EXTRACT_MEL_YIELD_EVERY) === 0 && f > 0) {
            await new Promise(r => setImmediate(r));
        }
    }

    const melStd = Math.sqrt(MEL_VAR);
    const invMelStd = 1 / melStd;
    for (let i = 0; i < melSpec.length; i++) {
        melSpec[i] = (melSpec[i] - MEL_MEAN) * invMelStd;
    }

    return { data: melSpec, frames: numFrames, melBands };
}

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
     * 异步版 extractRefMel：使用 resampleLinearAsync + extractMelSpectrogramAsync，
     * 避免长音频 JS FFT 同步阻塞主线程。计算结果与 extractRefMel 一致。
     */
    async extractRefMelAsync(refAudioWavBuffer) {
        const { data: audioFloat, sampleRate: srcSr } = parseWavBuffer(refAudioWavBuffer);
        const resampled = await resampleLinearAsync(audioFloat, srcSr, SAMPLE_RATE);
        const melResult = await extractMelSpectrogramAsync(resampled, SAMPLE_RATE);
        return melResult;
    }

    /**
     * Extract reference mel spectrogram using ONNX mel_transform model
     *
     * mel_transform 在不同精度/导出版本中输入输出名不一致：
     *   - ROOT mel_transform.onnx:  input='audio',     output='mel'
     *   - fp16/mel_transform.onnx:  input='waveform',   output='mel_spectrogram'
     *   - int8/mel_transform.onnx:  input='waveform',   output='output'
     * 这里通过 session.inputNames / outputNames 动态取首个输入/输出名，避免硬编码导致
     * ROOT 模型运行时报 "input 'audio' is missing in 'feeds'"。
     */
    async extractRefMelOnnx(sessions, refAudioWavBuffer, isFP16, useStaticShapes = false) {
        const { data: audioFloat, sampleRate: srcSr } = parseWavBuffer(refAudioWavBuffer);
        const resampled = await resampleLinearAsync(audioFloat, srcSr, SAMPLE_RATE);
        const floatType = isFP16 ? 'float16' : 'float32';
        // 动态获取输入/输出名（不同导出版本名称不同）
        const melInputName = sessions.melTransform.inputNames[0];   // 'waveform' | 'audio'
        const melOutputName = sessions.melTransform.outputNames[0]; // 'mel_spectrogram' | 'mel' | 'output'
        const NPU_STATIC_NUM_SAMPLES = 240000;
        if (useStaticShapes && resampled.length < NPU_STATIC_NUM_SAMPLES) {
            const padded = new Float32Array(NPU_STATIC_NUM_SAMPLES);
            padded.set(resampled);
            const waveform = createFloatTensor(floatType, padded, [1, NPU_STATIC_NUM_SAMPLES]);
            const results = await sessions.melTransform.run({ [melInputName]: waveform });
            const melOutput = results[melOutputName];
            const melData = outputToFloat32(melOutput);
            const melDims = melOutput.dims; // 先取 dims 再 dispose，避免 use-after-free
            const actualFrames = Math.ceil(resampled.length / HOP_SIZE);
            const maxFrames = melDims[1];
            const frames = Math.min(actualFrames, maxFrames);
            // 释放输入和输出张量（数据已拷贝到 melData）
            disposeTensor(waveform);
            disposeTensor(melOutput);
            const trimmed = melData.subarray(0, frames * MEL_DIM);
            return { data: trimmed.slice(), frames, melBands: MEL_DIM };
        }
        const waveform = createFloatTensor(floatType, resampled, [1, resampled.length]);
        const results = await sessions.melTransform.run({ [melInputName]: waveform });
        const melOutput = results[melOutputName];
        const melData = outputToFloat32(melOutput);
        const melDims = melOutput.dims; // 先取 dims 再 dispose
        const frames = melDims[1];
        // 释放输入和输出张量（数据已拷贝到 melData）
        disposeTensor(waveform);
        disposeTensor(melOutput);
        return { data: melData, frames, melBands: MEL_DIM };
    }

    /**
     * Run vocoder in chunked mode for long audio（强制串行，支持流式回调）
     *
     * @param {function} [onChunkComplete=null] - chunk 完成回调（流式播放用）
     *        chunkInfo = { chunkIndex, sampleOffset, sampleEnd, audio: Float32Array, totalSamples, isLast }
     *        audio 为该 chunk 贡献的"已确定"音频段（weightSum=1，可直接播放），按顺序拼接即得完整音频。
     */
    async runVocoderChunked(sessions, melData, totalFrames, isFP16, useStaticShapes = false, vocoderType = 'default', f0Data = null, sifiganStatsMissing = false, onChunkComplete = null, chunkFrames = 0, overlapFramesOverride = 0) {
        const _vocoderStartMs = performance.now();
        if (!sessions || !sessions.vocoder) {
            console.error(`[VocoderDiag] CRITICAL: sessions.vocoder is ${sessions ? (sessions.vocoder === undefined ? 'undefined' : 'null') : 'sessions is null'}! Vocoder will throw. sessionEPs=${JSON.stringify(sessions ? Object.keys(sessions) : [])}`);
        }
        if (_readDiagnosticMode()) {
            console.log(`[VocoderDiag] runVocoderChunked START: totalFrames=${totalFrames}, vocoderType=${vocoderType}, isFP16=${isFP16}, melDataLen=${melData.length}`);
        }
        // SiFiGAN mel 帧率（200Hz, hop=120）与 SVS 管线 mel 帧率（50Hz, hop=480）不一致。
        // SiFiGANWrapper 内部 T_audio = T_frames * 120，若直接喂 50Hz mel 会输出 1/4 期望时长。
        // 修复：在 SiFiGAN 路径下将 mel 和 F0 在时间维度 4× 上采样（最近邻），让 SiFiGAN 看到正确帧率。
        // effectiveTotalFrames * SIFIGAN_HOP_SIZE == totalFrames * HOP_SIZE，输出时长与 default vocoder 一致。
        const SIFIGAN_UPSAMPLE_RATIO = vocoderType === 'sifigan' ? (HOP_SIZE / SIFIGAN_HOP_SIZE) : 1;
        let effectiveTotalFrames = totalFrames;
        let effectiveMelData = melData;
        if (SIFIGAN_UPSAMPLE_RATIO > 1) {
            effectiveTotalFrames = totalFrames * SIFIGAN_UPSAMPLE_RATIO;
            // mel 最近邻上采样：每帧重复 SIFIGAN_UPSAMPLE_RATIO 次
            const srcArr = melData instanceof Float32Array ? melData : new Float32Array(melData);
            effectiveMelData = new Float32Array(effectiveTotalFrames * MEL_DIM);
            for (let f = 0; f < totalFrames; f++) {
                const srcOff = f * MEL_DIM;
                for (let r = 0; r < SIFIGAN_UPSAMPLE_RATIO; r++) {
                    const dstOff = (f * SIFIGAN_UPSAMPLE_RATIO + r) * MEL_DIM;
                    effectiveMelData.set(srcArr.subarray(srcOff, srcOff + MEL_DIM), dstOff);
                }
            }
        }

        // vocoder 期望标准化 mel (mean=0, std=1)，与官方 PyTorch soulxsinger.py 一致。
        // 之前的爆炸是 VocosFullWrapper._overlap_add 的 reshape 维度顺序 bug 导致的（已修复）。
        // effectiveMelData 保持扩散模型输出（标准化 mel），不做反标准化。
        const chunkSize = ((chunkFrames && chunkFrames > 0) ? chunkFrames : VOCODER_CHUNK_FRAMES) * SIFIGAN_UPSAMPLE_RATIO;
        // Vocoder 分块重叠帧数：优先使用调用方透传的 overlapFramesOverride（来自
        // settings.vocoderOverlapFrames，范围 8-96），否则回退到 VOCODER_OVERLAP_FRAMES 常量（32）。
        // SiFiGAN 路径下乘以 SIFIGAN_UPSAMPLE_RATIO 以保持与上采样后的 mel 帧率对齐。
        const _baseOverlapFrames = (Number.isFinite(overlapFramesOverride) && overlapFramesOverride >= 8 && overlapFramesOverride <= 96)
            ? Math.floor(overlapFramesOverride)
            : VOCODER_OVERLAP_FRAMES;
        const overlapFrames = _baseOverlapFrames * SIFIGAN_UPSAMPLE_RATIO;
        const vocoderHopSize = vocoderType === 'sifigan' ? SIFIGAN_HOP_SIZE : HOP_SIZE;
        const totalSamples = effectiveTotalFrames * vocoderHopSize;
        const output = new Float32Array(totalSamples);
        const t0 = performance.now();
        const floatType = isFP16 ? 'float16' : 'float32';

        // Yield to event loop to keep window responsive during long DML inference
        // setImmediate 比 setTimeout(0) 快约 4 倍（Windows ~1ms vs ~4ms）
        const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

        const padFloat = (src, len) => {
            if (src.length >= len) return src;
            const padded = new Float32Array(len);
            padded.set(src);
            return padded;
        };

        // ---- SiFiGAN 双输入（mel + f0）准备 ----
        // SVS 管线产出 50Hz F0；上采样到 effectiveTotalFrames 与 mel 对齐（SiFiGAN 期望 f0/mel 同帧率）。
        const useSifiganF0 = vocoderType === 'sifigan';
        let effectiveF0 = null;
        if (useSifiganF0) {
            if (f0Data && f0Data.length > 0) {
                const srcArr = f0Data instanceof Float32Array ? f0Data : new Float32Array(f0Data);
                // 先对齐到原始 50Hz totalFrames（防御性线性插值），再 4× 上采样到 effectiveTotalFrames
                const alignedF0 = (srcArr.length === totalFrames) ? srcArr : resizeF0Linear(srcArr, totalFrames);
                if (SIFIGAN_UPSAMPLE_RATIO > 1) {
                    effectiveF0 = new Float32Array(effectiveTotalFrames);
                    const ratio = SIFIGAN_UPSAMPLE_RATIO;
                    // F0 4× 上采样：线性插值（取代最近邻"每帧重复 4 次"）。
                    // 最近邻在 F0 阶跃处产生瞬时跳变，线性插值平滑过渡，消除激励畸变。
                    // mel 上采样保持最近邻（模型训练时即如此），仅 F0 改线性。
                    for (let f = 0; f < totalFrames; f++) {
                        const f0 = alignedF0[f];
                        // 最后一帧无 f+1，clamp 到末尾值（保持常量）。
                        const f1 = (f + 1 < totalFrames) ? alignedF0[f + 1] : f0;
                        for (let r = 0; r < ratio; r++) {
                            const frac = r / ratio;
                            effectiveF0[f * ratio + r] = f0 * (1 - frac) + f1 * frac;
                        }
                    }
                } else {
                    effectiveF0 = alignedF0;
                }
            } else {
                // F0 缺失处理（简化策略）：SiFiGAN 的 f0 是 ONNX 必需输入，无法跳过；
                // 立即报错并提示用户检查 F0 配置，不修改 vocoderType 设置（仅本次推理失败）。
                console.error('[OnnxSVSPipeline] vocoderType=sifigan but F0 missing, falling back to default vocoder for this inference');
                throw new Error('SiFiGAN vocoder requires F0 input but F0 data is missing, please check F0 config (pitchCurveF0 / f0Envelope / notes) or switch to default vocoder');
            }
        }

        // 统计文件缺失已在 _doInit 阶段强制回退默认 vocoder，此处 sifiganStatsMissing 永远为 false。
        // 保留参数仅为接口兼容，运行时不再触发兜底逻辑。

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
        if (effectiveTotalFrames <= chunkSize) {
            const vocSeqLen = useStaticShapes ? NPU_VOCODER_SEQ_LEN : effectiveTotalFrames;
            const melArr = effectiveMelData instanceof Float32Array ? effectiveMelData : new Float32Array(effectiveMelData);
            const paddedMel = useStaticShapes ? padFloat(melArr, vocSeqLen * MEL_DIM) : melArr;
            const melTensor = createFloatTensor(floatType, paddedMel, [1, vocSeqLen, MEL_DIM]);
            const vocoderInputs = buildVocoderInputs(melTensor, vocSeqLen, 0, effectiveTotalFrames);

            // 诊断：检查 mel 输入是否包含 NaN（在 vocoder run 之前）+ mel 统计（标准化 mel，期望 mean≈0 std≈1）
            // NaN/Inf 致命错误 console.error 始终输出；统计采样 console.log 受 diagnosticMode 控制
            // 全量扫描 NaN/Inf（采样检测可能漏掉 NaN 簇），always-on 以保证致命错误不被静默
            {
                let melNaN = 0, melInf = 0;
                for (let i = 0; i < paddedMel.length; i++) {
                    if (Number.isNaN(paddedMel[i])) { melNaN++; }
                    else if (!Number.isFinite(paddedMel[i])) { melInf++; }
                }
                if (melNaN > 0 || melInf > 0) {
                    console.error(`[VocoderDiag] MEL INPUT BEFORE VOCODER HAS NaN/Inf! NaN=${melNaN}, Inf=${melInf - melNaN}, total=${paddedMel.length}, frames=${effectiveTotalFrames}, vocoderType=${vocoderType}`);
                }
                // 采样统计：每 64 个采样取 1 个，避免长音频（如 2000 帧 × 128 = 256000 元素）下全量遍历的开销
                if (_readDiagnosticMode()) {
                    const DIAG_STRIDE = 64;
                    let melMin = Infinity, melMax = -Infinity, melSum = 0, melSumSq = 0;
                    let sampledCount = 0;
                    for (let i = 0; i < paddedMel.length; i += DIAG_STRIDE) {
                        const v = paddedMel[i];
                        if (Number.isNaN(v) || !Number.isFinite(v)) continue;
                        if (v < melMin) melMin = v;
                        if (v > melMax) melMax = v;
                        melSum += v;
                        melSumSq += v * v;
                        sampledCount++;
                    }
                    const melMean = sampledCount > 0 ? melSum / sampledCount : 0;
                    const melStd = sampledCount > 0 ? Math.sqrt(Math.max(0, melSumSq / sampledCount - melMean * melMean)) : 0;
                    console.log(`[VocoderDiag] single-chunk mel stats (sampled 1/${DIAG_STRIDE}): frames=${effectiveTotalFrames}, len=${paddedMel.length}, NaN=${melNaN}, Inf=${melInf}, min=${melMin.toFixed(6)}, max=${melMax.toFixed(6)}, mean=${melMean.toFixed(6)}, std=${melStd.toFixed(6)}`);
                }
            }

            let results;
            try {
                results = await sessions.vocoder.run(vocoderInputs);
            } catch (runErr) {
                disposeTensor(melTensor);
                if (vocoderInputs.f0) disposeTensor(vocoderInputs.f0);
                // OOM / device removed：DML 显存耗尽，抛出带上下文的明确错误，
                // 防止上层误以为合成完毕而播放空声音
                if (isVramOOMError(runErr)) {
                    throw new Error(`Vocoder OOM on single-chunk inference (frames=${effectiveTotalFrames}): ${runErr.message}. Try reducing vocoder chunk frames in settings.`);
                }
                throw runErr;
            }
            await yieldToEventLoop(); // Prevent UI freeze during DML inference
            const waveform = outputToFloat32(results['waveform']);
            // 释放单 chunk 的输入和输出张量
            disposeTensor(results['waveform']);
            disposeTensor(melTensor);
            if (vocoderInputs.f0) disposeTensor(vocoderInputs.f0);
            // 诊断：检查 vocoder 输出
            // NaN/Inf 致命错误 console.error 始终输出；统计采样 console.log 受 diagnosticMode 控制
            {
                let wavNaN = 0, wavInf = 0;
                for (let i = 0; i < waveform.length; i++) {
                    if (Number.isNaN(waveform[i])) wavNaN++;
                    if (!Number.isFinite(waveform[i])) wavInf++;
                }
                const expectedSamples = effectiveTotalFrames * vocoderHopSize;
                if (wavNaN > 0 || wavInf > 0) {
                    console.error(`[VocoderDiag] VOCODER OUTPUT HAS NaN/Inf! NaN=${wavNaN}, Inf=${wavInf - wavNaN}, total=${waveform.length}, expected=${expectedSamples}, frames=${effectiveTotalFrames}, vocoderType=${vocoderType}`);
                }
                if (_readDiagnosticMode()) {
                    let wavZero = 0;
                    for (let i = 0; i < waveform.length; i++) {
                        if (waveform[i] === 0) wavZero++;
                    }
                    console.log(`[VocoderDiag] single-chunk: frames=${effectiveTotalFrames}, vocoderType=${vocoderType}, outputLen=${waveform.length}, expectedLen=${expectedSamples}, NaN=${wavNaN}, zero=${wavZero}/${waveform.length}`);
                }
            }
            // 校验输出：DML 在显存边界可能返回全零/NaN 而不抛错（silent failure）
            validateVocoderOutput(waveform, 0);
            // 诊断：vocoder 输出开头能量分布（排查"第一个 midi 开头缺音"问题）
            // 纯统计采样，受 diagnosticMode 控制
            if (_readDiagnosticMode()) {
                const hopSamples = vocoderHopSize; // 1 mel frame = hopSamples audio samples
                const diagFrames = Math.min(10, Math.floor(waveform.length / hopSamples));
                const parts = [];
                let totalAbs = 0;
                for (let f = 0; f < diagFrames; f++) {
                    let s = 0;
                    const s0 = f * hopSamples;
                    const s1 = Math.min(s0 + hopSamples, waveform.length);
                    for (let i = s0; i < s1; i++) s += waveform[i] * waveform[i];
                    const rms = Math.sqrt(s / Math.max(1, s1 - s0));
                    totalAbs += rms;
                    parts.push(`f${f}=${rms.toFixed(5)}`);
                }
                // 同时统计 mel 开头能量（前 5 帧）
                const melParts = [];
                const melDiagFrames = Math.min(5, effectiveTotalFrames);
                for (let f = 0; f < melDiagFrames; f++) {
                    let s = 0;
                    for (let d = 0; d < MEL_DIM; d++) {
                        const v = paddedMel[f * MEL_DIM + d];
                        s += v * v;
                    }
                    melParts.push(`m${f}=${Math.sqrt(s / MEL_DIM).toFixed(5)}`);
                }
                console.log(`[VocoderDiag] single-chunk: frames=${effectiveTotalFrames}, vocoderType=${vocoderType}, melRMS=[${melParts.join(', ')}], wavRMS=[${parts.join(', ')}]`);
            }
            const copyLen = Math.min(waveform.length, totalSamples);
            output.set(waveform.subarray(0, copyLen));
            normalizePeakTo(output);
            // M7: streaming preview consistency — push the peak-normalized
            // chunk to onChunkComplete BEFORE loudnorm, so the streaming
            // preview receives the same peak-normalized audio as the
            // multi-chunk path (whose onChunkComplete also sends
            // normalizePeakTo(chunkAudio), with loudnorm applied only to the
            // final merged output). The final returned `output` is loudnorm'd
            // below, matching the multi-chunk path's final loudnormFinal.
            // 单 chunk 路径：一次性推送全部音频（流式播放用）
            if (onChunkComplete) {
                try {
                    onChunkComplete({
                        chunkIndex: 0,
                        sampleOffset: 0,
                        sampleEnd: copyLen,
                        audio: output.slice(0, copyLen),
                        totalSamples: copyLen,
                        isLast: true,
                    });
                } catch (e) {
                    console.warn('[OnnxSVSPipeline] onChunkComplete callback error:', e.message);
                }
            }
            // EBU R128 响度归一化（−14 LUFS）+ true-peak 限制（−1 dBTP）。
            // 受 enableLoudnormFinal 设置控制（默认 true）；关闭时仅走上面的
            // normalizePeakTo(0.95) 峰值归一化（旧行为）。单 chunk 路径在
            // onChunkComplete 推送后统一应用，与多 chunk 路径保持一致。
            if (_readEnableLoudnormFinal()) {
                loudnormFinal(output, SAMPLE_RATE);
            }
            if (_readDiagnosticMode()) {
                console.log(`[VocoderDiag] runVocoderChunked END (single-chunk): ${(performance.now() - _vocoderStartMs).toFixed(0)}ms, outputLen=${output.length}`);
            }
            return output;
        }

        // 长音频分chunks推理（流式：每 chunk 创建/推理/释放，避免 GPU 张量累积导致 OOM）
        // framePos 语义：下一个 chunk 的"新数据起始位置"（不含与前一个 chunk 的重叠区）。
        //   chunk 0:   chunkStart=0,                 chunkEnd=chunkSize,      framePos→chunkEnd
        //   chunk N:   chunkStart=framePos-overlap,  chunkEnd=chunkStart+chunkSize, framePos→chunkEnd
        //   末尾 chunk（chunkEnd 被 effectiveTotalFrames 截断）：写入后显式 break，
        //     避免旧逻辑 framePos = chunkEnd - overlapFrames 反复回退导致死循环
        const weightSum = new Float32Array(totalSamples);

        const fadeSamples = overlapFrames * vocoderHopSize;
        // WSOLA 分块交叉淡入淡出：取代旧的对称 Hann OLA 窗。
        // 旧 fadeWindow 已移除——WSOLA 内部使用互相关搜索最佳对齐后再做 Hann OLA，
        // 消除有音高信号在 chunk 边界的 flanging/梳状滤波。
        // prevChunkTail 在循环中跨 chunk 维护：每个非末尾 chunk 保存其波形尾部
        // (fadeSamples 长)，下个 chunk 用 WSOLA 与自身头部对齐后写回重叠区。
        let prevChunkTail = null;

        // 第一阶段：仅计算所有 chunk 的边界元数据（不创建张量）。
        // 旧版本在此阶段预创建所有 chunk 的 melTensor/f0Tensor 并存入 chunkSpecs，
        // 导致所有 chunk 的 GPU 输入张量同时驻留显存；加上第二阶段每个 chunk 的
        // 输出张量（results['waveform']）未显式释放，chunk 间累积触发 887A0006
        // (GPU device removed)。现改为：第一阶段只存元数据，第二阶段流式创建+释放。
        const chunkSpecs = [];
        let framePos = 0;
        let chunkIdx = 0;
        while (framePos < effectiveTotalFrames) {
            const isFirst = chunkIdx === 0;
            const chunkStart = isFirst ? 0 : Math.max(0, framePos - overlapFrames);
            const chunkEnd = Math.min(chunkStart + chunkSize, effectiveTotalFrames);
            const currentChunkFrames = chunkEnd - chunkStart;
            const isLast = chunkEnd >= effectiveTotalFrames;
            chunkSpecs.push({ chunkStart, chunkEnd, currentChunkFrames, isFirst, isLast });
            if (isLast) break;
            framePos = chunkEnd;
            chunkIdx++;
        }

        // 第二阶段：强制串行执行 vocoder chunk 推理（流式创建/释放张量）。
        // 注意：DML 后端下，同一个 InferenceSession 并发 run() 会向命令队列交叉提交命令流，
        // 触发 DXGI_ERROR_DEVICE_REMOVED (0x887A0006) — GPU 设备因无效命令被驱动移除。
        // 旧版本 VOC_PARALLEL=2 的 Promise.all 并行已移除，所有 chunk 严格按顺序逐个推理。
        //
        // 张量生命周期：每个 chunk 在循环内创建 melTensor/f0Tensor → 推理 → 提取波形 →
        // 立即解除输入/输出张量的 JS 引用（data 置空 + 变量置 null），并额外 yield 一次
        // 给 V8 GC 回收 native 资源。否则 chunk 间累积的 GPU 张量会耗尽显存导致后续 chunk OOM。
        // 流式播放：每完成一个 chunk，通过 onChunkComplete 推送"已确定"的音频段（weightSum=1）。
        //
        // 错误处理：每个 chunk 的 vocoder.run() 都包 try/catch。
        // - OOM / device removed：立即抛出明确错误，阻止后续 chunk 继续浪费 GPU 时间，
        //   同时防止 onChunkComplete 推送部分音频后中段失败导致应用误判合成完毕。
        // - 输出校验：DML 在显存边界可能不抛错而是返回全零/NaN 波形（silent failure），
        //   validateVocoderOutput 拦截此类无效输出。
        const totalChunkCount = chunkSpecs.length;
        let committedSamples = 0;
        for (let i = 0; i < totalChunkCount; i++) {
            const spec = chunkSpecs[i];
            // 流式创建当前 chunk 的输入张量（不预存到 chunkSpecs）
            const chunkMel = new Float32Array(spec.currentChunkFrames * MEL_DIM);
            chunkMel.set(effectiveMelData.subarray(spec.chunkStart * MEL_DIM, spec.chunkEnd * MEL_DIM));
            const vocSeqLen = useStaticShapes ? NPU_VOCODER_SEQ_LEN : spec.currentChunkFrames;
            const paddedChunk = useStaticShapes ? padFloat(chunkMel, vocSeqLen * MEL_DIM) : chunkMel;
            const melTensor = createFloatTensor(floatType, paddedChunk, [1, vocSeqLen, MEL_DIM]);
            const vocoderInputs = buildVocoderInputs(melTensor, vocSeqLen, spec.chunkStart, spec.currentChunkFrames);

            let results;
            try {
                results = await sessions.vocoder.run(vocoderInputs);
            } catch (runErr) {
                // 推理失败也要释放当前 chunk 输入张量，避免后续重试时累积
                disposeTensor(melTensor);
                if (vocoderInputs.f0) disposeTensor(vocoderInputs.f0);
                if (isVramOOMError(runErr)) {
                    throw new Error(`Vocoder OOM at chunk ${i}/${totalChunkCount} (frames=${spec.currentChunkFrames}, offset=${spec.chunkStart}): ${runErr.message}. Try reducing vocoder chunk frames in settings.`);
                }
                throw new Error(`Vocoder inference failed at chunk ${i}/${totalChunkCount}: ${runErr.message}`);
            }
            await yieldToEventLoop(); // Prevent UI freeze between vocoder chunks

            const waveform = outputToFloat32(results['waveform']);
            // 立即释放 ONNX 输出张量与输入张量：解除 JS 引用，让 V8 GC 回收 native 资源。
            // DML 后端 GPU 张量依赖 finalizer 异步释放，多个 chunk 累积会导致后续 chunk OOM。
            const outTensor = results['waveform'];
            disposeTensor(outTensor);
            disposeTensor(melTensor);
            if (vocoderInputs.f0) disposeTensor(vocoderInputs.f0);
            results = null;
            // chunk 间 GPU 排空：非末尾 chunk 时使用自适应排空（正常 setImmediate yield，
            // OOM 后 200ms 长等待）。自适应排空由 utils.gpuDrainAdaptive 实现，OOM 标志由
            // pipeline/index.js 的 OOM catch 通过 markGpuOom() 设置。
            // 旧版固定 50ms gpuDrain 在无 OOM 压力下浪费累积时间，已替换为自适应版本。
            if (i < totalChunkCount - 1) {
                await gpuDrainAdaptive();
            } else {
                await yieldToEventLoop();
            }

            // 校验输出：拦截 DML silent failure（全零/NaN）
            validateVocoderOutput(waveform, i);
            // 诊断：首 chunk 输出开头能量分布（排查"第一个 midi 开头缺音"问题）
            // 纯统计采样，受 diagnosticMode 控制
            if (spec.isFirst && _readDiagnosticMode()) {
                const hopSamples = vocoderHopSize;
                const diagFrames = Math.min(10, Math.floor(waveform.length / hopSamples));
                const parts = [];
                for (let f = 0; f < diagFrames; f++) {
                    let s = 0;
                    const s0 = f * hopSamples;
                    const s1 = Math.min(s0 + hopSamples, waveform.length);
                    for (let k = s0; k < s1; k++) s += waveform[k] * waveform[k];
                    parts.push(`f${f}=${Math.sqrt(s / Math.max(1, s1 - s0)).toFixed(5)}`);
                }
                // mel 开头能量（前 5 帧）
                const melParts = [];
                const melDiagFrames = Math.min(5, spec.currentChunkFrames);
                for (let f = 0; f < melDiagFrames; f++) {
                    let s = 0;
                    for (let d = 0; d < MEL_DIM; d++) {
                        const v = paddedChunk[f * MEL_DIM + d];
                        s += v * v;
                    }
                    melParts.push(`m${f}=${Math.sqrt(s / MEL_DIM).toFixed(5)}`);
                }
                // 完整 mel 输入统计（整个 chunk，采样 1/64 降低开销）
                {
                    const DIAG_STRIDE = 64;
                    let melMin = Infinity, melMax = -Infinity, melSum = 0, melSumSq = 0;
                    let sampledCount = 0;
                    const melLen = paddedChunk.length;
                    for (let i2 = 0; i2 < melLen; i2 += DIAG_STRIDE) {
                        const v = paddedChunk[i2];
                        if (v < melMin) melMin = v;
                        if (v > melMax) melMax = v;
                        melSum += v;
                        melSumSq += v * v;
                        sampledCount++;
                    }
                    const melMean = sampledCount > 0 ? melSum / sampledCount : 0;
                    const melStd = sampledCount > 0 ? Math.sqrt(Math.max(0, melSumSq / sampledCount - melMean * melMean)) : 0;
                    console.log(`[VocoderDiag] chunk0 FULL mel stats (sampled 1/${DIAG_STRIDE}): frames=${spec.currentChunkFrames}, len=${melLen}, min=${melMin.toFixed(6)}, max=${melMax.toFixed(6)}, mean=${melMean.toFixed(6)}, std=${melStd.toFixed(6)}`);
                }
                console.log(`[VocoderDiag] chunk0: chunkFrames=${spec.currentChunkFrames}, vocoderType=${vocoderType}, melRMS=[${melParts.join(', ')}], wavRMS=[${parts.join(', ')}]`);
            }
            const writeStart = spec.chunkStart * vocoderHopSize;
            const writeLen = Math.min(waveform.length, totalSamples - writeStart);
            // WSOLA 交叉淡入淡出写回：
            // - 首 chunk 或样本不足：直接整段写入（weight=1）。
            // - 非首 chunk 且 prevChunkTail/currHead 均有足够样本：WSOLA 对齐后写入重叠区
            //   （覆盖前一 chunk 尾部贡献），再写入非重叠区。
            // - 非末 chunk：保存尾部 fadeSamples 样本到 prevChunkTail 供下个 chunk WSOLA。
            const overlapWriteLen = Math.min(fadeSamples, writeLen);
            const canWsola = !spec.isFirst && prevChunkTail && overlapWriteLen > 0 &&
                prevChunkTail.length >= overlapWriteLen && waveform.length >= overlapWriteLen;
            if (canWsola) {
                const currChunkHead = waveform.subarray(0, overlapWriteLen);
                const wsolaResult = wsolaCrossfade(prevChunkTail, currChunkHead, overlapWriteLen, SAMPLE_RATE);
                for (let j = 0; j < overlapWriteLen; j++) {
                    const outIdx = writeStart + j;
                    if (outIdx >= totalSamples) break;
                    output[outIdx] = wsolaResult[j]; // 覆盖前一 chunk 尾部
                    weightSum[outIdx] = 1;
                }
                for (let j = overlapWriteLen; j < writeLen; j++) {
                    const outIdx = writeStart + j;
                    if (outIdx >= totalSamples) break;
                    output[outIdx] = waveform[j];
                    weightSum[outIdx] = 1;
                }
            } else {
                for (let j = 0; j < writeLen; j++) {
                    const outIdx = writeStart + j;
                    if (outIdx >= totalSamples) break;
                    output[outIdx] = waveform[j];
                    weightSum[outIdx] = 1;
                }
            }
            // 保存尾部供下个 chunk WSOLA 对齐（仅非末尾 chunk 且样本足够）
            if (!spec.isLast && fadeSamples > 0 && waveform.length >= fadeSamples) {
                prevChunkTail = waveform.slice(waveform.length - fadeSamples);
            }

            // 流式推送：推送 [committedSamples, stableEnd]（weightSum=1，overlap crossfade 权重和为 1）
            // - 首 chunk：stableEnd = (isLast ? chunkEnd : chunkEnd - overlapFrames) * vocoderHopSize
            // - 中间 chunk：包含头部 overlap 的 crossfade 结果 + 稳定段（weightSum=1）
            // - 末 chunk：stableEnd = chunkEnd * vocoderHopSize（尾部无 fade）
            // 注意：peak 归一化在每 chunk 推送前独立应用（仅向下缩放，peak>0.95 时生效），
            // 防止流式音频在 Int16 转换时削波。最终 output 仍会在循环结束后统一 normalizePeakTo。
            if (onChunkComplete) {
                const stableEndFrames = spec.isLast ? spec.chunkEnd : (spec.chunkEnd - overlapFrames);
                const stableEnd = Math.min(stableEndFrames * vocoderHopSize, totalSamples);
                if (stableEnd > committedSamples) {
                    const chunkAudio = output.slice(committedSamples, stableEnd);
                    normalizePeakTo(chunkAudio);
                    try {
                        onChunkComplete({
                            chunkIndex: i,
                            sampleOffset: committedSamples,
                            sampleEnd: stableEnd,
                            audio: chunkAudio,
                            totalSamples,
                            isLast: spec.isLast,
                        });
                    } catch (e) {
                        console.warn('[OnnxSVSPipeline] onChunkComplete callback error:', e.message);
                    }
                    committedSamples = stableEnd;
                }
            }
        }

        for (let i = 0; i < totalSamples; i++) {
            if (weightSum[i] > 1e-8) {
                output[i] /= weightSum[i];
            }
        }

        normalizePeakTo(output, totalSamples);

        // EBU R128 响度归一化（−14 LUFS）+ true-peak 限制（−1 dBTP）。
        // 受 enableLoudnormFinal 设置控制（默认 true）；关闭时仅走上面的
        // normalizePeakTo(0.95) 峰值归一化（旧行为）。多 chunk 路径在所有
        // chunk 合并归一化后统一应用，避免逐 chunk 响度跳变。
        if (_readEnableLoudnormFinal()) {
            loudnormFinal(output, SAMPLE_RATE);
        }

        const elapsed = performance.now() - t0;
        const logFrames = SIFIGAN_UPSAMPLE_RATIO > 1 ? `${effectiveTotalFrames} (${totalFrames}x${SIFIGAN_UPSAMPLE_RATIO})` : `${totalFrames}`;
        console.log(`[OnnxSVSPipeline] Vocoder chunked: ${logFrames} frames, ${totalChunkCount} chunks (serial, streaming), ${elapsed.toFixed(0)}ms`);
        if (_readDiagnosticMode()) {
            console.log(`[VocoderDiag] runVocoderChunked END (multi-chunk): ${(performance.now() - _vocoderStartMs).toFixed(0)}ms, outputLen=${output.length}`);
        }
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
     * 异步版 extractRefF0FromWav：使用 resampleLinearAsync + 帧循环 yield，
     * 避免长音频自相关计算同步阻塞主线程。计算逻辑与 extractRefF0FromWav 一致。
     */
    async extractRefF0FromWavAsync(wavBuffer) {
        const { data: audioFloat, sampleRate: srcSr } = parseWavBuffer(wavBuffer);
        const resampled = await resampleLinearAsync(audioFloat, srcSr, SAMPLE_RATE);
        const f0 = new Float32Array(Math.floor(resampled.length / HOP_SIZE));
        const minRms = 0.01;
        const frameSize = HOP_SIZE;
        const EXTRACT_F0_YIELD_EVERY = 32;
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
                if ((i % EXTRACT_F0_YIELD_EVERY) === 0 && i > 0) {
                    await new Promise(r => setImmediate(r));
                }
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
            if ((i % EXTRACT_F0_YIELD_EVERY) === 0 && i > 0) {
                await new Promise(r => setImmediate(r));
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

    /**
     * 异步版 extractRefNotePitches：使用 extractRefF0FromWavAsync，
     * 避免长音频自相关同步阻塞主线程。
     */
    async extractRefNotePitchesAsync(wavBuffer) {
        try {
            const f0 = await this.extractRefF0FromWavAsync(wavBuffer);
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
    resampleLinearAsync,
    bessel0,
    bitReversePermute,
    fftRadix2,
    ifftRadix2,
    istftReconstruction,
    hzToMel,
    melToHz,
    createMelFilterbank,
    extractMelSpectrogram,
    extractMelSpectrogramAsync,
    validateVocoderOutput,
    isVramOOMError,
};
