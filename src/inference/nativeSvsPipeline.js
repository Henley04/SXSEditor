const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');
const { pinyin } = require('pinyin-pro');

// 修复 onnxruntime-common 的 float16 类型映射
// Node.js v24+ 原生支持 Float16Array，但 onnxruntime-node 的 native binding (C++)
// 无法识别 Float16Array 的 buffer，导致 "not enough space" 错误。
// 解决方案：强制 float16 使用 Uint16Array 存储数据。
(function patchFloat16Mapping() {
    if (typeof Float16Array === 'undefined') return; // 不需要 patch
    try {
        // 触发 checkTypedArray 初始化
        try { new ort.Tensor('float16', new Uint16Array(1), [1]); } catch (_) {}

        // 通过 require.cache 直接访问已加载的模块
        for (const [key, mod] of Object.entries(require.cache)) {
            if (key.includes('onnxruntime-common') && key.includes('tensor-impl-type-mapping')) {
                if (mod.exports && mod.exports.NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP) {
                    mod.exports.NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set('float16', Uint16Array);
                    console.log('[OnnxSVSPipeline] float16 类型映射已修复 (Uint16Array)');
                }
                break;
            }
        }
    } catch (_) {
        // patch 失败不影响正常运行（非 FP16 模型不需要此 patch）
    }
})();

const SAMPLE_RATE = 24000;
const HOP_SIZE = 480;
const MEL_DIM = 128;
const EMBED_DIM = 512;
const COND_DIM = 1024;
const N_FFT = 1920;
const NUM_MELS = 128;
const MEL_MEAN = -4.92;
const MEL_VAR = 8.14;
const F0_BIN = 361;
const F0_MIN = 32.7031956625;
const CFG_STRENGTH = 3.0;
const CFG_RESCALE = 0.75;
const DEFAULT_DIFF_STEPS = 32;
const VOCODER_CHUNK_FRAMES = 1024;
const VOCODER_OVERLAP_FRAMES = 4;
const LONG_AUDIO_THRESHOLD_SEC = 30;
const SEGMENT_MIN_SEC = 15;
const SEGMENT_MAX_SEC = 30;
const SEGMENT_OVERLAP_SEC = 2;

const ONNX_MODEL_FILES = [
    'note_text_encoder.onnx',
    'note_pitch_encoder.onnx',
    'note_type_encoder.onnx',
    'f0_encoder.onnx',
    'preflow.onnx',
    'cond_emb.onnx',
    'diff_step_dml.onnx',
    'vocoder_dml.onnx',
    'mel_transform.onnx',
];

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
    const ratio = dstSampleRate / srcSampleRate;
    const newLength = Math.floor(audioFloat.length * ratio);
    const out = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
        const srcPos = i / ratio;
        const idx0 = Math.floor(srcPos);
        const idx1 = Math.min(idx0 + 1, audioFloat.length - 1);
        const t = srcPos - idx0;
        out[i] = audioFloat[idx0] * (1 - t) + audioFloat[idx1] * t;
    }
    return out;
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

    const window = new Float32Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) {
        window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N_FFT - 1)));
    }

    const real = new Float32Array(N_FFT);
    const imag = new Float32Array(N_FFT);
    const magnitude = new Float32Array(N_FFT / 2 + 1);

    const powerSpec = new Float32Array(numFrames * (N_FFT / 2 + 1));

    for (let f = 0; f < numFrames; f++) {
        const start = f * HOP_SIZE;
        for (let i = 0; i < N_FFT; i++) {
            real[i] = padded[start + i] * window[i];
            imag[i] = 0;
        }

        for (let len = N_FFT; len >= 2; len /= 2) {
            const halfLen = len / 2;
            const angle = -2 * Math.PI / len;
            for (let i = 0; i < N_FFT; i += len) {
                for (let j = 0; j < halfLen; j++) {
                    const idx1 = i + j;
                    const idx2 = i + j + halfLen;
                    const cosVal = Math.cos(angle * j);
                    const sinVal = Math.sin(angle * j);
                    const tReal = real[idx1];
                    const tImag = imag[idx1];
                    const uReal = real[idx2];
                    const uImag = imag[idx2];
                    real[idx1] = tReal + uReal;
                    imag[idx1] = tImag + uImag;
                    real[idx2] = (tReal - uReal) * cosVal - (tImag - uImag) * sinVal;
                    imag[idx2] = (tReal - uReal) * sinVal + (tImag - uImag) * cosVal;
                }
            }
        }

        bitReversePermute(real, imag);

        for (let i = 0; i <= N_FFT / 2; i++) {
            magnitude[i] = real[i] * real[i] + imag[i] * imag[i];
            powerSpec[f * (N_FFT / 2 + 1) + i] = magnitude[i];
        }
    }

    const fmax = sr / 2;
    const melFilterbank = createMelFilterbank(melBands, N_FFT, sr, 0, Math.min(fmax, 12000));

    const melSpec = new Float32Array(numFrames * melBands);
    for (let f = 0; f < numFrames; f++) {
        for (let m = 0; m < melBands; m++) {
            let sum = 0;
            for (let k = 0; k <= N_FFT / 2; k++) {
                sum += powerSpec[f * (N_FFT / 2 + 1) + k] * melFilterbank[m * (N_FFT / 2 + 1) + k];
            }
            melSpec[f * melBands + m] = Math.log(Math.max(sum, 1e-10));
        }
    }

    const melStd = Math.sqrt(MEL_VAR);
    for (let i = 0; i < melSpec.length; i++) {
        melSpec[i] = (melSpec[i] - MEL_MEAN) / melStd;
    }

    return { data: melSpec, frames: numFrames, melBands };
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
        const realPart = new Float32Array(nFft);
        const imagPart = new Float32Array(nFft);

        for (let k = 0; k < numFreqBins; k++) {
            const mag = magData[f * numFreqBins + k];
            const phase = phaseData[f * numFreqBins + k];
            realPart[k] = mag * Math.cos(phase);
            imagPart[k] = mag * Math.sin(phase);
        }
        for (let k = numFreqBins; k < nFft; k++) {
            const mirrorK = nFft - k;
            if (mirrorK > 0 && mirrorK < numFreqBins) {
                realPart[k] = realPart[mirrorK];
                imagPart[k] = -imagPart[mirrorK];
            }
        }

        const ifftReal = new Float32Array(nFft);
        const ifftImag = new Float32Array(nFft);
        for (let k = 0; k < nFft; k++) {
            for (let n = 0; n < nFft; n++) {
                const angle = 2 * Math.PI * k * n / nFft;
                ifftReal[n] += realPart[k] * Math.cos(angle) - imagPart[k] * Math.sin(angle);
                ifftImag[n] += realPart[k] * Math.sin(angle) + imagPart[k] * Math.cos(angle);
            }
        }

        const frameStart = f * hopLength;
        for (let n = 0; n < winLength; n++) {
            const outIdx = frameStart + n;
            if (outIdx < outputLength) {
                output[outIdx] += ifftReal[n] * window[n] / nFft;
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

// Float32 <-> Float16 转换工具
// 使用 Float16Array 进行转换（Node.js v24+ 原生支持）
function float32ToF16Buffer(f32Data) {
    const f16 = new Float16Array(f32Data.length);
    for (let i = 0; i < f32Data.length; i++) {
        f16[i] = f32Data[i];
    }
    return new Uint16Array(f16.buffer, f16.byteOffset, f16.length);
}

function f16BufferToFloat32(u16Data) {
    const f16 = new Float16Array(u16Data.buffer, u16Data.byteOffset, u16Data.length);
    const f32 = new Float32Array(f16.length);
    for (let i = 0; i < f16.length; i++) {
        f32[i] = f16[i];
    }
    return f32;
}

// 根据模型精度创建浮点张量
function createFloatTensor(type, f32Data, dims) {
    if (type === 'float16') {
        return new ort.Tensor('float16', float32ToF16Buffer(f32Data), dims);
    }
    return new ort.Tensor('float32', f32Data, dims);
}

// 从模型输出中提取 Float32Array（自动处理 float16 输出）
function outputToFloat32(tensor) {
    if (tensor.type === 'float16') {
        return f16BufferToFloat32(tensor.data);
    }
    return new Float32Array(tensor.data);
}

const DUMMY_TEST_INPUTS_FP32 = {
    noteTextEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([1n, 2n, 3n]), [1, 3]) },
    notePitchEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([60n, 62n, 64n]), [1, 3]) },
    noteTypeEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([0n, 0n, 0n]), [1, 3]) },
    f0Encoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([100n, 100n, 100n]), [1, 3]) },
    preflow: { features: new ort.Tensor('float32', new Float32Array(3 * EMBED_DIM), [1, 3, EMBED_DIM]) },
    condEmb: { cond_code: new ort.Tensor('float32', new Float32Array(3 * EMBED_DIM), [1, 3, EMBED_DIM]) },
    diffStep: {
        xt_input: new ort.Tensor('float32', new Float32Array(3 * MEL_DIM), [1, 3, MEL_DIM]),
        t: new ort.Tensor('float32', new Float32Array([0.5]), [1]),
        cond: new ort.Tensor('float32', new Float32Array(3 * COND_DIM), [1, 3, COND_DIM]),
        xt_mask: new ort.Tensor('float32', new Float32Array([1, 1, 1]), [1, 3]),
    },
    vocoder: { mel: new ort.Tensor('float32', new Float32Array(3 * MEL_DIM), [1, 3, MEL_DIM]) },
    melTransform: { waveform: new ort.Tensor('float32', new Float32Array(HOP_SIZE * 3), [1, HOP_SIZE * 3]) },
};

const DUMMY_TEST_INPUTS_FP16 = {
    noteTextEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([1n, 2n, 3n]), [1, 3]) },
    notePitchEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([60n, 62n, 64n]), [1, 3]) },
    noteTypeEncoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([0n, 0n, 0n]), [1, 3]) },
    f0Encoder: { input_ids: new ort.Tensor('int64', BigInt64Array.from([100n, 100n, 100n]), [1, 3]) },
    preflow: { features: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * EMBED_DIM)), [1, 3, EMBED_DIM]) },
    condEmb: { cond_code: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * EMBED_DIM)), [1, 3, EMBED_DIM]) },
    diffStep: {
        xt_input: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * MEL_DIM)), [1, 3, MEL_DIM]),
        t: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array([0.5])), [1]),
        cond: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * COND_DIM)), [1, 3, COND_DIM]),
        xt_mask: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array([1, 1, 1])), [1, 3]),
    },
    vocoder: { mel: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(3 * MEL_DIM)), [1, 3, MEL_DIM]) },
    melTransform: { waveform: new ort.Tensor('float16', float32ToF16Buffer(new Float32Array(HOP_SIZE * 3)), [1, HOP_SIZE * 3]) },
};

function isDiscreteGPUByName(name) {
    const n = name.toLowerCase();
    if (n.includes('nvidia') || n.includes('geforce') || n.includes('rtx') || n.includes('gtx') || n.includes('quadro')) return true;
    if (n.includes('radeon rx') || n.includes('radeon pro') || n.includes('radeon instinct')) return true;
    if (n.includes('amd') && (n.includes('rx ') || n.includes('pro w') || n.includes('pro v'))) return true;
    if (n.includes('intel') && n.includes('arc') && /\barc\s*a\d/i.test(n)) return true;
    if (n.includes('intel')) return false;
    if (n.includes('radeon') && !n.includes('rx') && !n.includes('pro') && !n.includes('instinct')) return false;
    if (n.includes('microsoft') && n.includes('basic')) return false;
    return undefined;
}

async function enumerateGPUsViaNodeGpuInfo() {
    try {
        const gpu = require('@oxmc/node-gpuinfo');
        const count = gpu.getGpuCount();
        if (count <= 0) return [];

        const allInfo = gpu.getAllGpuInfo();
        const devices = [];
        for (let i = 0; i < allInfo.length; i++) {
            const info = allInfo[i];
            const vramBytes = (info.memoryTotal || 0) * 1024 * 1024; // MB → Bytes
            const gb = vramBytes / (1024 * 1024 * 1024);
            const vramStr = gb >= 1 ? `${Math.round(gb * 10) / 10} GB` : `${Math.round(vramBytes / (1024 * 1024))} MB`;
            const vendorName = info.vendor || '';
            const isDiscrete = isDiscreteGPUByName(info.name);
            devices.push({
                name: info.name || '',
                type: 1,
                isDiscrete: isDiscrete !== undefined ? isDiscrete : (vramBytes > 0 && vramBytes >= 512 * 1024 * 1024),
                dxgiAdapterNumber: i,
                vram: vramStr,
                vramBytes: vramBytes,
                vendor: vendorName,
                source: 'node-gpuinfo',
            });
        }
        return devices;
    } catch (e) {
        console.warn('[OnnxSVSPipeline] node-gpuinfo 枚举失败:', e.message);
        return [];
    }
}

async function enumerateDMLDevicesInProcess(modelDir) {
    const probeModel = path.join(modelDir, 'note_text_encoder.onnx');
    try {
        await fs.promises.access(probeModel);
    } catch (_) {
        return [];
    }

    const origWrite = process.stderr.write.bind(process.stderr);
    let stderrBuf = '';
    process.stderr.write = function(chunk, encoding, callback) {
        if (typeof chunk === 'string') stderrBuf += chunk;
        else if (Buffer.isBuffer(chunk)) stderrBuf += chunk.toString('utf-8');
        return origWrite(chunk, encoding, callback);
    };

    ort.env.logLevel = 'verbose';

    try {
        try {
            const session = await ort.InferenceSession.create(probeModel, {
                executionProviders: [{ name: 'dml', deviceId: 0 }, 'cpu']
            });
            session.release();
        } catch (_) {}

        await new Promise(r => setTimeout(r, 500));
    } finally {
        process.stderr.write = origWrite;
        ort.env.logLevel = 'warning';
    }

    const devices = [];
    const lines = stderrBuf.split('\n');
    for (const line of lines) {
        if (!line.includes('Discovered OrtHardwareDevice')) continue;

        const descMatch = line.match(/Description=([^,\]]+)/);
        const typeMatch = line.match(/type:(\d+)/);
        const discreteMatch = line.match(/Discrete=(\d)/);
        const adapterMatch = line.match(/DxgiAdapterNumber=(\d+)/);
        const vramMatch = line.match(/DxgiVideoMemory=(\d+)\s*([MG]B)/);
        const vendorMatch = line.match(/vendor:([^,\]]+)/);

        if (!descMatch || !typeMatch) continue;

        const gpuName = descMatch[1].trim();
        const typeVal = parseInt(typeMatch[1]);

        const isDiscreteFromFlag = discreteMatch ? discreteMatch[1] === '1' : undefined;
        const isDiscreteFromName = isDiscreteGPUByName(gpuName);
        let isDiscrete;
        if (isDiscreteFromName !== undefined) {
            isDiscrete = isDiscreteFromName || (isDiscreteFromFlag === true);
        } else if (isDiscreteFromFlag !== undefined) {
            isDiscrete = isDiscreteFromFlag;
        } else {
            isDiscrete = false;
        }

        let vramStr = undefined;
        let vramBytes = 0;
        if (vramMatch) {
            const vramVal = parseInt(vramMatch[1]);
            const vramUnit = vramMatch[2];
            vramStr = `${vramVal} ${vramUnit}`;
            if (vramUnit === 'GB') vramBytes = vramVal * 1024 * 1024 * 1024;
            else if (vramUnit === 'MB') vramBytes = vramVal * 1024 * 1024;
        }

        if (typeVal !== 1) continue;

        devices.push({
            name: gpuName,
            type: typeVal,
            isDiscrete: isDiscrete,
            dxgiAdapterNumber: adapterMatch ? parseInt(adapterMatch[1]) : undefined,
            vram: vramStr,
            vramBytes: vramBytes,
            vendor: vendorMatch ? vendorMatch[1].trim() : '',
            source: 'dml',
        });
    }

    return devices;
}

async function enumerateDMLDevices(modelDir) {
    let devices = await enumerateGPUsViaNodeGpuInfo();

    if (devices.length > 0) {
        console.log(`[OnnxSVSPipeline] node-gpuinfo 枚举发现 ${devices.length} 个 GPU 设备`);
        return devices;
    }

    console.log('[OnnxSVSPipeline] node-gpuinfo 未发现 GPU，尝试 ONNX Runtime verbose 日志枚举...');
    if (modelDir) {
        devices = await enumerateDMLDevicesInProcess(modelDir);
    }

    return devices;
}

async function detectBestGPU(modelDir) {
    let devices = await enumerateDMLDevices(modelDir);

    if (devices.length === 0) {
        console.log('[OnnxSVSPipeline] 未发现任何 GPU 设备，将使用 CPU');
        return { deviceId: undefined, name: '', devices: [] };
    }

    console.log(`[OnnxSVSPipeline] 发现 ${devices.length} 个 GPU 设备:`);
    for (const d of devices) {
        const vramStr = d.vram ? ` (${d.vram})` : '';
        const discreteStr = d.isDiscrete ? ' [独显]' : ' [核显]';
        const adapterStr = d.dxgiAdapterNumber !== undefined ? ` deviceId=${d.dxgiAdapterNumber}` : '';
        const sourceStr = d.source ? ` (${d.source})` : '';
        console.log(`  - ${d.name}${vramStr}${discreteStr}${adapterStr}${sourceStr}`);
    }

    const gpus = devices.filter(d => d.dxgiAdapterNumber !== undefined);
    if (gpus.length === 0) {
        return { deviceId: undefined, name: '', devices };
    }

    const discrete = gpus.filter(d => d.isDiscrete);
    let best;
    if (discrete.length > 0) {
        best = discrete.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
    } else {
        best = gpus.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
    }
    const vramStr = best.vram ? ` (${best.vram})` : '';
    const discreteStr = best.isDiscrete ? ' [独显]' : ' [核显]';

    console.log(`[OnnxSVSPipeline] 自动选择: ${best.name}${vramStr}${discreteStr} (deviceId=${best.dxgiAdapterNumber})`);

    return {
        deviceId: best.dxgiAdapterNumber,
        name: `${best.name}${vramStr}`,
        devices,
    };
}

async function createSessionWithValidation(modelPath, sessionKey, gpuDeviceName, dmlDeviceId, isFP16) {
    const modelName = path.basename(modelPath);
    const dummyInputs = isFP16 ? DUMMY_TEST_INPUTS_FP16[sessionKey] : DUMMY_TEST_INPUTS_FP32[sessionKey];
    const gpuTag = gpuDeviceName ? ` [${gpuDeviceName}]` : '';

    if (!dummyInputs) {
        const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
        console.log(`[OnnxSVSPipeline] ${modelName} 加载成功 [CPU] (无验证输入)`);
        return { session, ep: 'cpu' };
    }

    let dmlSession = null;
    try {
        const dmlOpts = typeof dmlDeviceId === 'number'
            ? { name: 'dml', deviceId: dmlDeviceId }
            : 'dml';
        dmlSession = await ort.InferenceSession.create(modelPath, { executionProviders: [dmlOpts, 'cpu'] });
        await dmlSession.run(dummyInputs);
        console.log(`[OnnxSVSPipeline] ${modelName} 加载成功 [DML]${gpuTag} (推理验证通过)`);
        return { session: dmlSession, ep: 'dml' };
    } catch (dmlErr) {
        if (dmlSession) {
            try { dmlSession.release(); } catch (e) {
                console.warn(`[OnnxSVSPipeline] 释放 DML 会话失败 (${modelName}):`, e.message);
            }
        }
        const reason = dmlErr.message.includes('Reshape')
            ? 'DML 不支持动态 Reshape (89个节点)'
            : dmlErr.message.includes('ConvTranspose')
            ? 'DML 不支持大 stride ConvTranspose (stride=480)'
            : `DML 推理验证失败 (${dmlErr.message.substring(0, 60).split('\n')[0]})`;
        console.log(`[OnnxSVSPipeline] ${modelName} DML 不可用: ${reason}`);
    }

    // DML不可用，尝试使用DML优化版本模型（在CPU上运行）
    const dmlModelPath = modelPath.replace('.onnx', '_dml.onnx');
    if (dmlModelPath !== modelPath) {
        let dmlModelExists = false;
        try { await fs.promises.access(dmlModelPath); dmlModelExists = true; } catch (_) {}
        if (dmlModelExists) {
            try {
                const dmlModelSession = await ort.InferenceSession.create(dmlModelPath, { executionProviders: ['cpu'] });
                try {
                    await dmlModelSession.run(dummyInputs);
                } catch (runErr) {
                    try { dmlModelSession.release(); } catch (_) {}
                    throw runErr;
                }
                console.log(`[OnnxSVSPipeline] ${path.basename(dmlModelPath)} 加载成功 [CPU] (DML优化模型，推理验证通过)`);
                return { session: dmlModelSession, ep: 'cpu' };
            } catch (dmlModelErr) {
                console.log(`[OnnxSVSPipeline] ${path.basename(dmlModelPath)} DML优化模型加载失败: ${dmlModelErr.message.substring(0, 60).split('\n')[0]}`);
            }
        }
    }

    const cpuSession = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    try {
        await cpuSession.run(dummyInputs);
    } catch (runErr) {
        try { cpuSession.release(); } catch (_) {}
        throw runErr;
    }
    console.log(`[OnnxSVSPipeline] ${modelName} 加载成功 [CPU] (推理验证通过)`);
    return { session: cpuSession, ep: 'cpu' };
}

class OnnxSVSPipeline {
    constructor(modelDir, options = {}) {
        this.modelDir = path.resolve(modelDir);
        this.sessions = {};
        this.sessionEPs = {};
        this.isFP16 = false; // 是否为 FP16 精度模型
        this.gpuDeviceName = '';
        this.dmlDeviceId = undefined;
        this.initialized = false;
        this.phone2idx = {};
        this.enG2pDict = {};
        this.userDeviceId = options.deviceId;
        this._synthCache = null;
        this._initPromise = null;
        this._loadPhoneSet();
        this._loadEnG2pDict();
    }

    _loadPhoneSet() {
        const searchPaths = [
            path.join(__dirname, 'phone_set.json'),
            path.join(__dirname, '..', 'inference', 'phone_set.json'),
            path.join(__dirname, '..', '..', 'src', 'inference', 'phone_set.json'),
        ];
        for (const phoneSetPath of searchPaths) {
            try {
                if (fs.existsSync(phoneSetPath)) {
                    const phoneList = JSON.parse(fs.readFileSync(phoneSetPath, 'utf-8'));
                    for (let i = 0; i < phoneList.length; i++) {
                        this.phone2idx[phoneList[i]] = i;
                    }
                    console.log(`[OnnxSVSPipeline] 音素词汇表已加载: ${phoneList.length} 个音素 (路径: ${phoneSetPath})`);
                    return;
                }
            } catch (e) {
                console.warn(`[OnnxSVSPipeline] 加载音素词汇表失败 (${phoneSetPath}):`, e.message);
            }
        }
        console.error('[OnnxSVSPipeline] 加载音素词汇表失败: 所有搜索路径均未找到 phone_set.json');
    }

    _loadEnG2pDict() {
        const searchPaths = [
            path.join(__dirname, 'en_g2p_dict.json'),
            path.join(__dirname, '..', 'inference', 'en_g2p_dict.json'),
            path.join(__dirname, '..', '..', 'src', 'inference', 'en_g2p_dict.json'),
        ];
        for (const dictPath of searchPaths) {
            try {
                if (fs.existsSync(dictPath)) {
                    this.enG2pDict = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
                    console.log(`[OnnxSVSPipeline] 英文G2P词典已加载(CMUdict): ${Object.keys(this.enG2pDict).length} 个词 (路径: ${dictPath})`);
                    return;
                }
            } catch (e) {
                console.warn(`[OnnxSVSPipeline] 加载英文G2P词典失败 (${dictPath}):`, e.message);
            }
        }
        console.warn('[OnnxSVSPipeline] 英文G2P词典未找到，英文歌词将使用字母级回退');
    }

    _englishG2p(word) {
        const lower = word.toLowerCase();
        if (this.enG2pDict[lower]) {
            return this.enG2pDict[lower];
        }
        console.warn(`[OnnxSVSPipeline] 英文单词 "${word}" 不在CMUdict中，使用字母级回退`);
        const letterMap = {
            a: 'EY1', b: 'B IY1', c: 'S IY1', d: 'D IY1', e: 'IY1',
            f: 'EH1 F', g: 'JH IY1', h: 'EY1 CH', i: 'AY1', j: 'JH EY1',
            k: 'K EY1', l: 'EH1 L', m: 'EH1 M', n: 'EH1 N', o: 'OW1',
            p: 'P IY1', q: 'K Y UW1', r: 'AA1 R', s: 'EH1 S', t: 'T IY1',
            u: 'Y UW1', v: 'V IY1', w: 'D AH1 B AH0 L Y UW0', x: 'EH1 K S',
            y: 'W AY1', z: 'Z IY1',
        };
        const phonemes = [];
        for (const ch of lower) {
            if (letterMap[ch]) {
                phonemes.push(...letterMap[ch].split(' '));
            }
        }
        return phonemes.length > 0 ? phonemes.join(' ') : null;
    }

    _lookupPhonemeId(lyric) {
        if (!lyric || lyric.trim().length === 0) {
            return this.phone2idx['<SP>'] || 1;
        }
        const trimmed = lyric.trim();
        if (this.phone2idx[trimmed] !== undefined) {
            return this.phone2idx[trimmed];
        }
        if (this.phone2idx['zh_' + trimmed] !== undefined) {
            return this.phone2idx['zh_' + trimmed];
        }
        if (this.phone2idx['en_' + trimmed] !== undefined) {
            return this.phone2idx['en_' + trimmed];
        }
        if (this.phone2idx['yue_' + trimmed] !== undefined) {
            return this.phone2idx['yue_' + trimmed];
        }
        const zhPhoneme = this._charToZhPhoneme(trimmed);
        if (zhPhoneme && this.phone2idx[zhPhoneme] !== undefined) {
            return this.phone2idx[zhPhoneme];
        }
        console.warn(`[OnnxSVSPipeline] 未知音素: "${trimmed}"${zhPhoneme ? ` (转换后: ${zhPhoneme})` : ''}, 使用 <UNK>`);
        return this.phone2idx['<UNK>'] || 3;
    }

    _charToZhPhoneme(char) {
        if (!/[\u4e00-\u9fff]/.test(char)) {
            return null;
        }
        try {
            const py = pinyin(char, { toneType: 'num', type: 'array' });
            if (py && py.length > 0 && py[0]) {
                return 'zh_' + py[0];
            }
        } catch (e) {
            console.warn(`[OnnxSVSPipeline] 拼音转换失败 ("${char}"):`, e.message);
        }
        return null;
    }

    async init() {
        if (this.initialized) return true;

        if (this._initPromise) {
            return this._initPromise;
        }

        this._initPromise = this._doInit();
        try {
            return await this._initPromise;
        } finally {
            this._initPromise = null;
        }
    }

    async _doInit() {
        console.log('[OnnxSVSPipeline] 开始初始化 (ONNX Runtime + DirectML)...');
        console.log('[OnnxSVSPipeline] 模型目录:', this.modelDir);

        const gpuInfo = await detectBestGPU(this.modelDir);
        this.allDevices = gpuInfo.devices || [];

        if (this.userDeviceId !== undefined && this.userDeviceId !== null) {
            this.dmlDeviceId = this.userDeviceId;
            const selectedDevice = this.allDevices.find(d => d.dxgiAdapterNumber === this.userDeviceId);
            this.gpuDeviceName = selectedDevice ? `${selectedDevice.name}${selectedDevice.vram ? ` (${selectedDevice.vram})` : ''}` : `deviceId=${this.userDeviceId}`;
            console.log(`[OnnxSVSPipeline] 使用用户指定设备: ${this.gpuDeviceName} (deviceId=${this.dmlDeviceId})`);
        } else {
            this.dmlDeviceId = gpuInfo.deviceId;
            this.gpuDeviceName = gpuInfo.name || '无 GPU (仅 CPU)';
            console.log(`[OnnxSVSPipeline] GPU 设备 (自动): ${this.gpuDeviceName}${this.dmlDeviceId !== undefined ? ` (deviceId=${this.dmlDeviceId})` : ''}`);
        }

        const resolvedModelFiles = [...ONNX_MODEL_FILES];
        const dmlIdx = resolvedModelFiles.indexOf('diff_step_dml.onnx');
        if (dmlIdx >= 0) {
            const dmlPath = path.join(this.modelDir, 'diff_step_dml.onnx');
            let dmlExists = false;
            try { await fs.promises.access(dmlPath); dmlExists = true; } catch (_) {}
            if (!dmlExists) {
                resolvedModelFiles[dmlIdx] = 'diff_step.onnx';
                console.log('[OnnxSVSPipeline] diff_step_dml.onnx 不存在，使用 diff_step.onnx');
            }
        }
        const vocDmlIdx = resolvedModelFiles.indexOf('vocoder_dml.onnx');
        if (vocDmlIdx >= 0) {
            const vocDmlPath = path.join(this.modelDir, 'vocoder_dml.onnx');
            let vocDmlExists = false;
            try { await fs.promises.access(vocDmlPath); vocDmlExists = true; } catch (_) {}
            if (!vocDmlExists) {
                resolvedModelFiles[vocDmlIdx] = 'vocoder.onnx';
                console.log('[OnnxSVSPipeline] vocoder_dml.onnx 不存在，使用 vocoder.onnx');
            }
        }

        for (const modelFile of resolvedModelFiles) {
            const filePath = path.join(this.modelDir, modelFile);
            let stats;
            try {
                stats = await fs.promises.stat(filePath);
            } catch (_) {
                throw new Error(`模型文件不存在: ${filePath}`);
            }
            console.log(`[OnnxSVSPipeline] ${modelFile}: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        }

        const sessionKeys = [
            'noteTextEncoder',
            'notePitchEncoder',
            'noteTypeEncoder',
            'f0Encoder',
            'preflow',
            'condEmb',
            'diffStep',
            'vocoder',
            'melTransform',
        ];

        // 检测模型精度：通过检查第一个浮点输入模型的输入类型
        // 先临时加载 preflow 模型检测精度
        const probeModelPath = path.join(this.modelDir, resolvedModelFiles[4]); // preflow
        const probeSession = await ort.InferenceSession.create(probeModelPath, { executionProviders: ['cpu'] });
        const probeInputType = probeSession.inputMetadata[0]?.type;
        this.isFP16 = probeInputType === 'float16';
        await probeSession.release();
        console.log(`[OnnxSVSPipeline] 模型精度检测: ${this.isFP16 ? 'FP16 (半精度)' : 'FP32 (全精度)'}`);

        const loadedSessions = [];
        try {
            for (let i = 0; i < resolvedModelFiles.length; i++) {
                const modelPath = path.join(this.modelDir, resolvedModelFiles[i]);
                const { session, ep } = await createSessionWithValidation(modelPath, sessionKeys[i], this.gpuDeviceName, this.dmlDeviceId, this.isFP16);
                this.sessions[sessionKeys[i]] = session;
                this.sessionEPs[sessionKeys[i]] = ep;
                loadedSessions.push(sessionKeys[i]);
            }

            const dmlCount = Object.values(this.sessionEPs).filter(e => e === 'dml').length;
            const cpuCount = Object.values(this.sessionEPs).filter(e => e === 'cpu').length;
            console.log(`[OnnxSVSPipeline] 初始化完成: ${dmlCount} 个模型使用 DML, ${cpuCount} 个模型使用 CPU`);
        } catch (err) {
            console.error('[OnnxSVSPipeline] ONNX Runtime 初始化失败:', err.message);
            for (const key of loadedSessions) {
                if (this.sessions[key] && typeof this.sessions[key].release === 'function') {
                    try { this.sessions[key].release(); } catch (_) {}
                }
                delete this.sessions[key];
                delete this.sessionEPs[key];
            }
            throw err;
        }

        this.initialized = true;
        console.log('[OnnxSVSPipeline] 初始化完成: ONNX Runtime 已就绪');
        return true;
    }

    midiToFreq(pitch) {
        return 440 * Math.pow(2, (pitch - 69) / 12);
    }

    interpolateEnvelope(envelope, beatTime) {
        const kfs = envelope.keyframes;
        if (kfs.length === 0) return 0;
        if (kfs.length === 1) return kfs[0].value;
        if (beatTime <= kfs[0].time) return kfs[0].value;
        if (beatTime >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;
        for (let i = 0; i < kfs.length - 1; i++) {
            if (beatTime >= kfs[i].time && beatTime < kfs[i + 1].time) {
                const t = (beatTime - kfs[i].time) / (kfs[i + 1].time - kfs[i].time);
                return kfs[i].value + t * (kfs[i + 1].value - kfs[i].value);
            }
        }
        return kfs[kfs.length - 1].value;
    }

    buildF0FrameSequence(notes, bpm, f0Envelope, pitchCurveF0) {
        if (notes.length === 0) return new Float32Array(0);
        const lastNote = notes[notes.length - 1];
        const totalBeats = lastNote.start + lastNote.duration;
        const totalSeconds = (totalBeats / bpm) * 60;
        const totalFrames = Math.floor(totalSeconds * SAMPLE_RATE / HOP_SIZE);

        if (pitchCurveF0 && pitchCurveF0.length > 0) {
            const srcData = pitchCurveF0 instanceof Float32Array ? pitchCurveF0 : new Float32Array(pitchCurveF0);
            const f0 = new Float32Array(totalFrames);
            for (let i = 0; i < totalFrames; i++) {
                f0[i] = i < srcData.length ? srcData[i] : 0;
            }
            return f0;
        }

        const f0 = new Float32Array(totalFrames);
        f0.fill(0);
        for (const note of notes) {
            let effectivePitch = note.pitch;
            if (f0Envelope && f0Envelope.keyframes && f0Envelope.keyframes.length > 0) {
                const noteCenterBeat = note.start + note.duration / 2;
                const semitoneShift = this.interpolateEnvelope(f0Envelope, noteCenterBeat);
                effectivePitch = note.pitch + semitoneShift;
            }
            const freq = this.midiToFreq(effectivePitch);
            const startSec = (note.start / bpm) * 60;
            const endSec = ((note.start + note.duration) / bpm) * 60;
            const startFrame = Math.floor(startSec * SAMPLE_RATE / HOP_SIZE);
            const endFrame = Math.min(totalFrames, Math.floor(endSec * SAMPLE_RATE / HOP_SIZE));
            for (let i = startFrame; i < endFrame; i++) {
                f0[i] = freq;
            }
        }
        return f0;
    }

    quantizeF0(f0Frames, f0Shift = 0) {
        const seq = new Int32Array(f0Frames.length);
        for (let i = 0; i < f0Frames.length; i++) {
            const f = f0Frames[i];
            if (f <= 0) {
                seq[i] = 0;
            } else {
                const f0Cents = 1200 * Math.log2(Math.max(f, F0_MIN) / F0_MIN);
                let bin = Math.round(f0Cents / 20) + 1;
                if (f0Shift !== 0 && bin > 0) {
                    bin = Math.max(1, Math.min(F0_BIN - 1, bin + f0Shift * 5));
                }
                seq[i] = Math.max(1, Math.min(F0_BIN - 1, bin));
            }
        }
        return seq;
    }

    notesToSequences(notes, bpm, f0Envelope, pitchCurveF0, f0Shift = 0) {
        const PAD_ID = this.phone2idx['<PAD>'] || 0;
        const BOW_ID = this.phone2idx['<BOW>'] || 4;
        const EOW_ID = this.phone2idx['<EOW>'] || 5;
        const SEP_ID = this.phone2idx['<SEP>'] || 9;

        const noteDurations = [];
        for (let i = 0; i < notes.length; i++) {
            noteDurations.push((notes[i].duration / bpm) * 60);
        }

        const totalDuration = noteDurations.reduce((a, b) => a + b, 0);
        const totalFrames = Math.floor(totalDuration * SAMPLE_RATE / HOP_SIZE);

        if (totalFrames === 0) {
            return {
                f0Ids: new Int32Array(0),
                noteTextSeq: new Int32Array([PAD_ID]),
                notePitchSeq: new Int32Array([0]),
                noteTypeSeq: new Int32Array([1]),
                mel2token: new Int32Array(0),
                tokenCount: 1,
            };
        }

        const phLocations = [];
        const newPhonemes = [PAD_ID];
        const note2origin = [];
        const notePitches = [0];
        const noteTypes = [1];

        let durSum = 0;

        for (let phIdx = 0; phIdx < notes.length; phIdx++) {
            const note = notes[phIdx];
            const lyric = note.lyric || '';
            const pitch = note.pitch;
            let noteType;
            if (lyric.trim().length === 0) {
                noteType = 1;
            } else if (note.isSlur || note.isContinuation) {
                noteType = 3;
            } else {
                noteType = 2;
            }

            let dur = Math.round(durSum * SAMPLE_RATE / HOP_SIZE);
            dur = Math.min(dur, totalFrames - 1);

            newPhonemes.push(BOW_ID);
            note2origin.push(phIdx);
            notePitches.push(pitch);
            noteTypes.push(noteType);

            if (lyric.startsWith('en_') && lyric.includes('-')) {
                const subParts = lyric.slice(3).split('-');
                const enPhIds = [];
                for (let s = 0; s < subParts.length; s++) {
                    enPhIds.push(this._lookupPhonemeId('en_' + subParts[s].trim()));
                }
                enPhIds.push(SEP_ID);
                phLocations.push([dur, Math.max(1, enPhIds.length)]);
                for (let e = 0; e < enPhIds.length; e++) {
                    newPhonemes.push(enPhIds[e]);
                    note2origin.push(phIdx);
                    notePitches.push(pitch);
                    noteTypes.push(noteType);
                }
            } else if (/^[a-zA-Z]+$/.test(lyric) && !lyric.startsWith('en_') && !lyric.startsWith('zh_') && !lyric.startsWith('yue_')) {
                const g2pResult = this._englishG2p(lyric);
                if (g2pResult) {
                    const phParts = g2pResult.split(' ');
                    const enPhIds = [];
                    for (let s = 0; s < phParts.length; s++) {
                        enPhIds.push(this._lookupPhonemeId('en_' + phParts[s].trim()));
                    }
                    enPhIds.push(SEP_ID);
                    phLocations.push([dur, Math.max(1, enPhIds.length)]);
                    for (let e = 0; e < enPhIds.length; e++) {
                        newPhonemes.push(enPhIds[e]);
                        note2origin.push(phIdx);
                        notePitches.push(pitch);
                        noteTypes.push(noteType);
                    }
                } else {
                    const phId = this._lookupPhonemeId(lyric);
                    phLocations.push([dur, 1]);
                    newPhonemes.push(phId);
                    note2origin.push(phIdx);
                    notePitches.push(pitch);
                    noteTypes.push(noteType);
                }
            } else {
                const phId = this._lookupPhonemeId(lyric);
                phLocations.push([dur, 1]);
                newPhonemes.push(phId);
                note2origin.push(phIdx);
                notePitches.push(pitch);
                noteTypes.push(noteType);
            }

            newPhonemes.push(EOW_ID);
            note2origin.push(phIdx);
            notePitches.push(pitch);
            noteTypes.push(noteType);

            durSum += noteDurations[phIdx];
        }

        const mel2token = this._buildMel2token(phLocations, newPhonemes.length, totalFrames);

        const f0Hz = new Float32Array(totalFrames);
        if (pitchCurveF0 && pitchCurveF0.length > 0) {
            const srcData = pitchCurveF0 instanceof Float32Array ? pitchCurveF0 : new Float32Array(pitchCurveF0);
            let frameOffset = 0;
            for (let i = 0; i < notes.length; i++) {
                const note = notes[i];
                const lyric = note.lyric || '';
                const noteDurationSec = noteDurations[i];
                const noteFrames = Math.round(noteDurationSec * SAMPLE_RATE / HOP_SIZE);
                const noteStartSec = (note.start / bpm) * 60;
                const noteFreq = lyric.trim().length === 0 ? 0 : this.midiToFreq(note.pitch);
                for (let f = 0; f < noteFrames && frameOffset + f < totalFrames; f++) {
                    const absTimeSec = noteStartSec + f * HOP_SIZE / SAMPLE_RATE;
                    const srcFrame = Math.floor(absTimeSec * SAMPLE_RATE / HOP_SIZE);
                    if (srcFrame >= 0 && srcFrame < srcData.length && srcData[srcFrame] > 0) {
                        f0Hz[frameOffset + f] = srcData[srcFrame];
                    } else {
                        f0Hz[frameOffset + f] = noteFreq;
                    }
                }
                frameOffset += noteFrames;
            }
        } else {
            let frameOffset = 0;
            for (let i = 0; i < notes.length; i++) {
                const note = notes[i];
                const lyric = note.lyric || '';
                let effectivePitch = note.pitch;
                if (f0Envelope && f0Envelope.keyframes && f0Envelope.keyframes.length > 0) {
                    const noteCenterBeat = note.start + note.duration / 2;
                    const semitoneShift = this.interpolateEnvelope(f0Envelope, noteCenterBeat);
                    effectivePitch = note.pitch + semitoneShift;
                }
                const freq = lyric.trim().length === 0 ? 0 : this.midiToFreq(effectivePitch);
                const noteFrames = Math.round(noteDurations[i] * SAMPLE_RATE / HOP_SIZE);
                for (let f = 0; f < noteFrames && frameOffset + f < totalFrames; f++) {
                    f0Hz[frameOffset + f] = freq;
                }
                frameOffset += noteFrames;
            }
        }

        const f0Ids = this.quantizeF0(f0Hz, f0Shift);

        const tokenCount = newPhonemes.length;
        const noteTextSeq = new Int32Array(tokenCount);
        const notePitchSeq = new Int32Array(tokenCount);
        const noteTypeSeq = new Int32Array(tokenCount);

        for (let t = 0; t < tokenCount; t++) {
            noteTextSeq[t] = newPhonemes[t];
            notePitchSeq[t] = notePitches[t];
            noteTypeSeq[t] = noteTypes[t];
        }

        if (f0Shift !== 0) {
            for (let t = 0; t < tokenCount; t++) {
                if (notePitchSeq[t] > 0) {
                    notePitchSeq[t] = Math.max(0, Math.min(255, notePitchSeq[t] + f0Shift));
                }
            }
        }

        return {
            f0Ids,
            noteTextSeq,
            notePitchSeq,
            noteTypeSeq,
            mel2token,
            tokenCount,
        };
    }

    _buildMel2token(phLocations, tokenCount, totalFrames) {
        const mel2token = new Int32Array(totalFrames);
        mel2token.fill(0);

        if (phLocations.length === 0) return mel2token;

        let phIdx = 1;
        for (let idx = 0; idx < phLocations.length; idx++) {
            let i = phLocations[idx][0];
            const j = phLocations[idx][1];
            const nextPhonemeStart = idx < phLocations.length - 1 ? phLocations[idx + 1][0] : totalFrames;
            if (i >= totalFrames || i + j > totalFrames) {
                break;
            }
            if (i < totalFrames && mel2token[i] > 0) {
                while (i < totalFrames && mel2token[i] > 0) {
                    i += 1;
                }
            }
            mel2token[i] = phIdx;
            let k = i + 1;
            while (k + j < nextPhonemeStart) {
                for (let m = 0; m < j; m++) {
                    mel2token[k + m] = phIdx + m + 1;
                }
                k += j;
            }
            mel2token[nextPhonemeStart - 1] = phIdx + j + 1;
            phIdx += j + 2;
        }

        let maxVal = 0;
        for (let f = 0; f < totalFrames; f++) {
            if (mel2token[f] > maxVal) maxVal = mel2token[f];
        }
        if (maxVal > tokenCount - 1) {
            for (let f = 0; f < totalFrames; f++) {
                mel2token[f] = Math.min(mel2token[f], tokenCount - 1);
            }
        }

        return mel2token;
    }

    randomNoise(frameLen, melDim) {
        const data = new Float32Array(frameLen * melDim);
        for (let i = 0; i < data.length; i += 2) {
            const u1 = Math.random();
            const u2 = Math.random();
            const r = Math.sqrt(-2.0 * Math.log(u1 + 1e-10));
            const theta = 2.0 * Math.PI * u2;
            data[i] = r * Math.cos(theta);
            if (i + 1 < data.length) {
                data[i + 1] = r * Math.sin(theta);
            }
        }
        return { data, dims: [1, frameLen, melDim] };
    }

    _extractRefMel(refAudioWavBuffer) {
        const { data: audioFloat, sampleRate: srcSr } = parseWavBuffer(refAudioWavBuffer);
        const resampled = resampleLinear(audioFloat, srcSr, SAMPLE_RATE);
        const melResult = extractMelSpectrogram(resampled, SAMPLE_RATE);
        return melResult;
    }

    async _extractRefMelOnnx(refAudioWavBuffer) {
        const { data: audioFloat, sampleRate: srcSr } = parseWavBuffer(refAudioWavBuffer);
        const resampled = resampleLinear(audioFloat, srcSr, SAMPLE_RATE);
        const floatType = this.isFP16 ? 'float16' : 'float32';
        const waveform = createFloatTensor(floatType, resampled, [1, resampled.length]);
        const results = await this.sessions.melTransform.run({ waveform });
        const melOutput = results['mel_spectrogram'];
        const melData = outputToFloat32(melOutput);
        const melDims = melOutput.dims;
        const frames = melDims[1];
        return { data: melData, frames, melBands: MEL_DIM };
    }

    async _runEncoder(sequences, tokenCount, totalFrames, ptFrameCount = 0) {
        const phonemeIds = new BigInt64Array(tokenCount);
        const pitchIds = new BigInt64Array(tokenCount);
        const typeIds = new BigInt64Array(tokenCount);
        const f0IdsArr = new BigInt64Array(totalFrames);

        for (let i = 0; i < tokenCount; i++) {
            phonemeIds[i] = BigInt(sequences.noteTextSeq[i]);
            pitchIds[i] = BigInt(sequences.notePitchSeq[i]);
            typeIds[i] = BigInt(sequences.noteTypeSeq[i]);
        }
        for (let i = 0; i < totalFrames; i++) {
            f0IdsArr[i] = BigInt(sequences.f0Ids[i]);
        }

        const textInput = new ort.Tensor('int64', phonemeIds, [1, tokenCount]);
        const textResults = await this.sessions.noteTextEncoder.run({ input_ids: textInput });
        const textEmb = outputToFloat32(textResults['embeddings']);

        const pitchInput = new ort.Tensor('int64', pitchIds, [1, tokenCount]);
        const pitchResults = await this.sessions.notePitchEncoder.run({ input_ids: pitchInput });
        const pitchEmb = outputToFloat32(pitchResults['embeddings']);

        const typeInput = new ort.Tensor('int64', typeIds, [1, tokenCount]);
        const typeResults = await this.sessions.noteTypeEncoder.run({ input_ids: typeInput });
        const typeEmb = outputToFloat32(typeResults['embeddings']);

        const f0Input = new ort.Tensor('int64', f0IdsArr, [1, totalFrames]);
        const f0Results = await this.sessions.f0Encoder.run({ input_ids: f0Input });
        const f0Emb = outputToFloat32(f0Results['embeddings']);

        const tokenEmb = new Float32Array(tokenCount * EMBED_DIM);
        for (let t = 0; t < tokenCount; t++) {
            for (let d = 0; d < EMBED_DIM; d++) {
                tokenEmb[t * EMBED_DIM + d] =
                    textEmb[t * EMBED_DIM + d] +
                    pitchEmb[t * EMBED_DIM + d] +
                    typeEmb[t * EMBED_DIM + d];
            }
        }

        const floatType = this.isFP16 ? 'float16' : 'float32';
        const featuresTensor = createFloatTensor(floatType, tokenEmb, [1, tokenCount, EMBED_DIM]);
        const preflowResults = await this.sessions.preflow.run({ features: featuresTensor });
        const processedTokenEmb = outputToFloat32(preflowResults['processed_features']);

        const mel2token = sequences.mel2token;
        const expandedEmb = new Float32Array(totalFrames * EMBED_DIM);
        for (let f = 0; f < totalFrames; f++) {
            const tokenIdx = mel2token[f];
            for (let d = 0; d < EMBED_DIM; d++) {
                expandedEmb[f * EMBED_DIM + d] = processedTokenEmb[tokenIdx * EMBED_DIM + d];
            }
        }

        const combinedFeatures = new Float32Array(totalFrames * EMBED_DIM);
        for (let f = 0; f < totalFrames; f++) {
            for (let d = 0; d < EMBED_DIM; d++) {
                combinedFeatures[f * EMBED_DIM + d] =
                    expandedEmb[f * EMBED_DIM + d] +
                    f0Emb[f * EMBED_DIM + d];
            }
        }

        const totalCondFrames = ptFrameCount > 0 ? ptFrameCount + totalFrames : totalFrames;
        const condCodeData = new Float32Array(totalCondFrames * EMBED_DIM);
        for (let f = 0; f < totalFrames; f++) {
            for (let d = 0; d < EMBED_DIM; d++) {
                condCodeData[(ptFrameCount + f) * EMBED_DIM + d] = combinedFeatures[f * EMBED_DIM + d];
            }
        }

        const condCodeTensor = createFloatTensor(floatType, condCodeData, [1, totalCondFrames, EMBED_DIM]);
        const condEmbResults = await this.sessions.condEmb.run({ cond_code: condCodeTensor });
        const cond = outputToFloat32(condEmbResults['cond_embedding']);

        return cond;
    }

    async _runDiffStep(xtInputData, tVal, condData, maskData, totalFramesWithPrompt) {
        const floatType = this.isFP16 ? 'float16' : 'float32';
        const xtTensor = createFloatTensor(floatType, xtInputData, [1, totalFramesWithPrompt, MEL_DIM]);
        const tTensor = createFloatTensor(floatType, new Float32Array([tVal]), [1]);
        const condTensor = createFloatTensor(floatType, condData, [1, totalFramesWithPrompt, COND_DIM]);
        const maskTensor = createFloatTensor(floatType, maskData, [1, totalFramesWithPrompt]);

        const results = await this.sessions.diffStep.run({
            xt_input: xtTensor,
            t: tTensor,
            cond: condTensor,
            xt_mask: maskTensor,
        });

        return outputToFloat32(results['flow_pred']);
    }

    async _runVocoderChunked(melData, totalFrames) {
        const chunkSize = VOCODER_CHUNK_FRAMES;
        const overlapFrames = VOCODER_OVERLAP_FRAMES;
        const totalSamples = totalFrames * HOP_SIZE;
        const output = new Float32Array(totalSamples);
        const t0 = performance.now();

        // 短音频（≤chunkSize帧 ≈ 20.5秒）直接一次性推理，避免分块开销
        if (totalFrames <= chunkSize) {
            const melTensor = createFloatTensor(this.isFP16 ? 'float16' : 'float32', melData instanceof Float32Array ? melData : new Float32Array(melData), [1, totalFrames, MEL_DIM]);
            const results = await this.sessions.vocoder.run({ mel: melTensor });
            const waveform = outputToFloat32(results['waveform']);
            const copyLen = Math.min(waveform.length, totalSamples);
            output.set(waveform.subarray(0, copyLen));
            const elapsed = performance.now() - t0;
            console.log(`[OnnxSVSPipeline] Vocoder一次性推理: ${totalFrames}帧 → ${copyLen}样本, ${elapsed.toFixed(0)}ms`);
            return output;
        }

        // 长音频分块推理
        const stepFrames = chunkSize - overlapFrames;
        const weightSum = new Float32Array(totalSamples);

        const fadeSamples = overlapFrames * HOP_SIZE;
        const fadeWindow = new Float32Array(fadeSamples);
        for (let i = 0; i < fadeSamples; i++) {
            fadeWindow[i] = i / fadeSamples;
        }

        let framePos = 0;
        let chunkIdx = 0;

        while (framePos < totalFrames) {
            const chunkStart = Math.max(0, framePos - (chunkIdx > 0 ? overlapFrames : 0));
            const chunkEnd = Math.min(chunkStart + chunkSize, totalFrames);
            const currentChunkFrames = chunkEnd - chunkStart;

            const chunkMel = new Float32Array(currentChunkFrames * MEL_DIM);
            for (let f = 0; f < currentChunkFrames; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    chunkMel[f * MEL_DIM + d] = melData[(chunkStart + f) * MEL_DIM + d];
                }
            }

            const melTensor = createFloatTensor(this.isFP16 ? 'float16' : 'float32', chunkMel, [1, currentChunkFrames, MEL_DIM]);
            const results = await this.sessions.vocoder.run({ mel: melTensor });
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

        const elapsed = performance.now() - t0;
        console.log(`[OnnxSVSPipeline] Vocoder分块推理: ${totalFrames}帧, ${chunkIdx}块, ${elapsed.toFixed(0)}ms`);
        return output;
    }

    _hashArray(arr) {
        if (!arr) return 0;
        let h = 0;
        const step = Math.max(1, Math.floor(arr.length / 2000));
        for (let i = 0; i < arr.length; i += step) {
            h = ((h << 5) - h + (arr[i] | 0)) | 0;
        }
        return h;
    }

    _computeSynthCacheKey(notes, bpm, options) {
        const f0Envelope = options.f0Envelope || null;
        const pitchCurveF0 = options.pitchCurveF0 || null;
        const refAudioWavBuffer = options.refAudioWavBuffer || null;
        const totalSteps = options.nSteps || DEFAULT_DIFF_STEPS;
        const cfgStrength = options.cfg || CFG_STRENGTH;
        const cfgRescale = options.cfgRescale !== undefined ? options.cfgRescale : CFG_RESCALE;
        const autoShift = options.autoShift || false;
        const pitchShift = options.pitchShift || 0;

        let notesHash = 0;
        for (let i = 0; i < notes.length; i++) {
            const n = notes[i];
            const s = `${n.lyric || ''}|${n.pitch}|${n.start}|${n.duration}|${n.isSlur ? 1 : 0}|${n.isContinuation ? 1 : 0}`;
            for (let j = 0; j < s.length; j++) {
                notesHash = ((notesHash << 5) - notesHash + s.charCodeAt(j)) | 0;
            }
        }

        const f0EnvHash = f0Envelope ? this._hashArray(
            f0Envelope.keyframes ? f0Envelope.keyframes.flatMap(kf => [kf.time, kf.value * 1000]) : []
        ) : 0;

        const f0Hash = this._hashArray(pitchCurveF0);

        let refHash = 0;
        if (refAudioWavBuffer) {
            const buf = refAudioWavBuffer instanceof ArrayBuffer ? new Uint8Array(refAudioWavBuffer) :
                        Buffer.isBuffer(refAudioWavBuffer) ? refAudioWavBuffer : null;
            if (buf) {
                refHash = buf.length;
                for (let i = 0; i < Math.min(buf.length, 4000); i += Math.max(1, Math.floor(buf.length / 2000))) {
                    refHash = ((refHash << 5) - refHash + buf[i]) | 0;
                }
            }
        }

        return `${notesHash}_${bpm}_${f0EnvHash}_${f0Hash}_${refHash}_${totalSteps}_${cfgStrength}_${cfgRescale}_${autoShift}_${pitchShift}`;
    }

    clearSynthCache() {
        this._synthCache = null;
    }

    _fillNoteGaps(notes) {
        if (!notes || notes.length <= 1) return notes;

        const sorted = [...notes].sort((a, b) => a.start - b.start);
        const result = [sorted[0]];
        let currentTime = sorted[0].start + sorted[0].duration;

        for (let i = 1; i < sorted.length; i++) {
            const note = sorted[i];
            const gap = note.start - currentTime;
            if (gap > 0.01) {
                result.push({
                    lyric: '',
                    pitch: 0,
                    start: currentTime,
                    duration: gap,
                });
            }
            result.push(note);
            currentTime = Math.max(currentTime, note.start + note.duration);
        }

        return result;
    }

    _buildVocalSegments(notes, bpm) {
        if (!notes || notes.length === 0) return [{ notes, startBeat: 0, endBeat: 0 }];

        const sorted = [...notes].sort((a, b) => a.start - b.start);
        const totalBeats = sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration;
        const totalSec = (totalBeats / bpm) * 60;

        if (totalSec <= LONG_AUDIO_THRESHOLD_SEC) {
            return [{ notes, startBeat: 0, endBeat: totalBeats }];
        }

        console.log(`[OnnxSVSPipeline] 长音频检测: ${totalSec.toFixed(1)}s > ${LONG_AUDIO_THRESHOLD_SEC}s，启用分段推理`);

        const overlapBeats = (SEGMENT_OVERLAP_SEC / 60) * bpm;
        const minBeats = (SEGMENT_MIN_SEC / 60) * bpm;
        const maxBeats = (SEGMENT_MAX_SEC / 60) * bpm;

        const restBoundaries = [0];
        for (let i = 0; i < sorted.length; i++) {
            const note = sorted[i];
            if (note.lyric && note.lyric.trim().length === 0) {
                const midBeat = note.start + note.duration / 2;
                restBoundaries.push(midBeat);
            }
            if (i > 0) {
                const prevEnd = sorted[i - 1].start + sorted[i - 1].duration;
                const gap = note.start - prevEnd;
                if (gap > 0.05) {
                    restBoundaries.push(prevEnd + gap / 2);
                }
            }
        }
        restBoundaries.push(totalBeats);
        restBoundaries.sort((a, b) => a - b);

        const segments = [];
        let segStart = 0;

        while (segStart < totalBeats - 0.01) {
            let segEnd = segStart + maxBeats;

            if (segEnd >= totalBeats - 0.01) {
                segEnd = totalBeats;
            } else {
                let bestBoundary = segEnd;
                let bestDist = Infinity;
                for (const b of restBoundaries) {
                    if (b <= segStart + minBeats) continue;
                    if (b >= segStart + maxBeats + overlapBeats) break;
                    const dist = Math.abs(b - (segStart + (maxBeats + minBeats) / 2));
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestBoundary = b;
                    }
                }
                segEnd = bestBoundary;
            }

            const segNotes = sorted.filter(n => {
                const noteEnd = n.start + n.duration;
                return n.start < segEnd && noteEnd > segStart;
            }).map(n => ({
                ...n,
                start: n.start - segStart,
            }));

            if (segNotes.length > 0) {
                segments.push({
                    notes: segNotes,
                    startBeat: segStart,
                    endBeat: segEnd,
                });
            }

            segStart = segEnd - overlapBeats;
            if (segStart >= totalBeats - 0.01) break;
        }

        console.log(`[OnnxSVSPipeline] 分段完成: ${segments.length} 段, 每段 ${segments.map(s => ((s.endBeat - s.startBeat) / bpm * 60).toFixed(1) + 's').join(', ')}`);
        return segments;
    }

    async _runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange) {
        const totalFramesWithPrompt = ptFrameCount + totalFrames;
        const frameMask = new Float32Array(totalFramesWithPrompt).fill(1);
        const targetMask = new Float32Array(totalFrames).fill(1);

        const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
        const xtTargetBuf = new Float32Array(totalFrames * MEL_DIM);
        const uncondCondBuf = new Float32Array(totalFrames * COND_DIM);
        const cfgPredBuf = new Float32Array(totalFrames * MEL_DIM);

        const dt = 1.0 / totalSteps;
        const progressPerStep = progressRange / totalSteps;

        for (let step = 0; step < totalSteps; step++) {
            const tVal = (step + 0.5) / totalSteps;

            for (let f = 0; f < ptFrameCount; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    xtInputBuf[f * MEL_DIM + d] = ptMelData[f * MEL_DIM + d];
                }
            }
            for (let f = 0; f < totalFrames; f++) {
                for (let d = 0; d < MEL_DIM; d++) {
                    xtInputBuf[(ptFrameCount + f) * MEL_DIM + d] = xt.data[f * MEL_DIM + d];
                }
            }

            const predData = await this._runDiffStep(xtInputBuf, tVal, combinedCond, frameMask, totalFramesWithPrompt);

            if (cfgStrength > 0) {
                for (let i = 0; i < totalFrames * MEL_DIM; i++) {
                    xtTargetBuf[i] = xt.data[i];
                }

                const uncondPred = await this._runDiffStep(xtTargetBuf, tVal, uncondCondBuf, targetMask, totalFrames);

                const targetLen = totalFrames * MEL_DIM;
                // Single pass: compute conditional mean, CFG prediction, and CFG mean
                let posSum = 0;
                let cfgAdjSum = 0;
                for (let f = 0; f < totalFrames; f++) {
                    const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        const condVal = predData[tgtOffset + d];
                        const uncondVal = uncondPred[f * MEL_DIM + d];
                        posSum += condVal;
                        const cfgVal = condVal + cfgStrength * (condVal - uncondVal);
                        cfgPredBuf[f * MEL_DIM + d] = cfgVal;
                        cfgAdjSum += cfgVal;
                    }
                }
                const posMean = posSum / targetLen;
                const cfgAdjMean = cfgAdjSum / targetLen;

                // Second pass: compute variances
                let posVarSum = 0;
                let cfgAdjVarSum = 0;
                for (let f = 0; f < totalFrames; f++) {
                    const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        const condVal = predData[tgtOffset + d];
                        const diff1 = condVal - posMean;
                        posVarSum += diff1 * diff1;
                        const cfgVal = cfgPredBuf[f * MEL_DIM + d];
                        const diff2 = cfgVal - cfgAdjMean;
                        cfgAdjVarSum += diff2 * diff2;
                    }
                }
                const posStd = Math.sqrt(posVarSum / targetLen + 1e-8);
                const cfgAdjStd = Math.sqrt(cfgAdjVarSum / targetLen + 1e-8);
                const rescale = posStd / (cfgAdjStd + 1e-8);

                // Third pass: apply rescaled CFG
                for (let f = 0; f < totalFrames; f++) {
                    for (let d = 0; d < MEL_DIM; d++) {
                        const cfgVal = cfgPredBuf[f * MEL_DIM + d];
                        const rescaledVal = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
                        xt.data[f * MEL_DIM + d] += rescaledVal * dt;
                    }
                }
            } else {
                for (let f = 0; f < totalFrames; f++) {
                    const tgtOffset = (ptFrameCount + f) * MEL_DIM;
                    for (let d = 0; d < MEL_DIM; d++) {
                        xt.data[f * MEL_DIM + d] += predData[tgtOffset + d] * dt;
                    }
                }
            }

            const currentProgress = progressStart + (step + 1) * progressPerStep;
            onProgress(Math.min(Math.round(currentProgress), 90));
            await new Promise(r => setTimeout(r, 0));
        }
    }

    async _synthesizeSegment(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange) {
        const sequences = this.notesToSequences(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift);
        const totalFrames = sequences.f0Ids.length;
        const tokenCount = sequences.tokenCount;

        if (totalFrames === 0) {
            return { audio: [], frames: 0 };
        }

        console.log(`[OnnxSVSPipeline] 段落合成: frames=${totalFrames}, tokens=${tokenCount}, steps=${totalSteps}`);

        const totalFramesWithPrompt = ptFrameCount + totalFrames;

        const combinedCond = await this._runEncoder(sequences, tokenCount, totalFrames, ptFrameCount);

        const xt = this.randomNoise(totalFrames, MEL_DIM);

        await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange);

        const audioData = await this._runVocoderChunked(xt.data, totalFrames);

        return { audio: audioData, frames: totalFrames };
    }

    async synthesize(notes, bpm, options = {}) {
        if (!this.initialized) {
            await this.init();
        }
        await this.ensureAllModelsLoaded();
        const onProgress = options.onProgress || (() => {});
        const f0Envelope = options.f0Envelope || null;
        const pitchCurveF0 = options.pitchCurveF0 || null;
        const refAudioWavBuffer = options.refAudioWavBuffer || null;
        const totalSteps = options.nSteps || DEFAULT_DIFF_STEPS;
        const cfgStrength = options.cfg || CFG_STRENGTH;
        const cfgRescale = options.cfgRescale !== undefined ? options.cfgRescale : CFG_RESCALE;
        const autoShift = options.autoShift || false;
        const pitchShift = options.pitchShift || 0;

        const filledNotes = this._fillNoteGaps(notes);

        const cacheKey = this._computeSynthCacheKey(notes, bpm, options);
        if (this._synthCache && this._synthCache.key === cacheKey) {
            console.log('[OnnxSVSPipeline] 缓存命中，复用上次生成的音频');
            onProgress(100);
            return this._synthCache.audio;
        }

        let currentProgress = 0;
        onProgress(currentProgress);

        let f0Shift = 0;
        if (autoShift && pitchShift === 0) {
            const targetF0 = this.buildF0FrameSequence(filledNotes, bpm, f0Envelope, pitchCurveF0);
            const targetNonZero = [];
            for (let i = 0; i < targetF0.length; i++) {
                if (targetF0[i] > 0) targetNonZero.push(targetF0[i]);
            }
            const targetNotePitches = [];
            for (const note of filledNotes) {
                if (note.pitch >= 1) targetNotePitches.push(note.pitch);
            }

            let refF0 = null;
            if (refAudioWavBuffer) {
                try {
                    refF0 = this._extractRefF0FromWav(refAudioWavBuffer);
                } catch (e) {
                    console.warn('[OnnxSVSPipeline] 参考音频F0提取失败:', e.message);
                }
            }

            if (refF0 && refF0.length > 0) {
                const refNonZero = [];
                for (let i = 0; i < refF0.length; i++) {
                    if (refF0[i] > 0) refNonZero.push(refF0[i]);
                }
                if (refNonZero.length > 0 && targetNonZero.length > 0) {
                    const refMedian = this._median(refNonZero);
                    const targetMedian = this._median(targetNonZero);
                    f0Shift = Math.round(Math.log2(refMedian / targetMedian) * 1200 / 100);
                } else if (targetNotePitches.length > 0) {
                    const refNotePitches = this._extractRefNotePitches(refAudioWavBuffer);
                    if (refNotePitches && refNotePitches.length > 0) {
                        const refMedianPitch = this._median(refNotePitches);
                        const targetMedianPitch = this._median(targetNotePitches);
                        f0Shift = Math.round(refMedianPitch - targetMedianPitch);
                    }
                }
            } else if (targetNotePitches.length > 0) {
                const refNotePitches = options.refNotePitches || null;
                if (refNotePitches && refNotePitches.length > 0) {
                    const refMedianPitch = this._median(refNotePitches);
                    const targetMedianPitch = this._median(targetNotePitches);
                    f0Shift = Math.round(refMedianPitch - targetMedianPitch);
                }
            }
        } else {
            f0Shift = pitchShift;
        }

        let ptMelData = null;
        let ptFrameCount = 0;

        if (refAudioWavBuffer) {
            try {
                const melResult = await this._extractRefMelOnnx(refAudioWavBuffer);
                ptMelData = melResult.data;
                ptFrameCount = melResult.frames;
                console.log(`[OnnxSVSPipeline] 参考音频mel: ${ptFrameCount}帧`);
            } catch (err) {
                console.warn('[OnnxSVSPipeline] 参考音频mel提取失败，尝试JS回退:', err.message);
                try {
                    const melResult = this._extractRefMel(refAudioWavBuffer);
                    ptMelData = melResult.data;
                    ptFrameCount = melResult.frames;
                    console.log(`[OnnxSVSPipeline] 参考音频mel(JS回退): ${ptFrameCount}帧`);
                } catch (err2) {
                    console.warn('[OnnxSVSPipeline] JS回退也失败，使用零prompt:', err2.message);
                }
            }
        }

        const segments = this._buildVocalSegments(filledNotes, bpm);

        if (segments.length === 1) {
            const seg = segments[0];
            const segNotes = seg.notes || filledNotes;
            const sequences = this.notesToSequences(segNotes, bpm, f0Envelope, pitchCurveF0, f0Shift);
            const totalFrames = sequences.f0Ids.length;

            if (totalFrames === 0) {
                return [];
            }

            if (!ptMelData || ptFrameCount === 0) {
                ptFrameCount = Math.min(50, Math.max(10, Math.floor(totalFrames * 0.1)));
                ptMelData = new Float32Array(ptFrameCount * MEL_DIM);
                console.log(`[OnnxSVSPipeline] 使用零prompt: ${ptFrameCount}帧`);
            }

            console.log(`[OnnxSVSPipeline] 合成参数: frames=${totalFrames}, tokens=${sequences.tokenCount}, steps=${totalSteps}, cfg=${cfgStrength}, f0Shift=${f0Shift}`);

            currentProgress = 30;
            onProgress(currentProgress);

            const combinedCond = await this._runEncoder(sequences, sequences.tokenCount, totalFrames, ptFrameCount);
            const xt = this.randomNoise(totalFrames, MEL_DIM);

            await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, 40, 50);

            onProgress(90);
            console.log(`[OnnxSVSPipeline] 扩散完成，开始声码器重建 (${totalFrames}帧)...`);
            const audioData = await this._runVocoderChunked(xt.data, totalFrames);

            this._synthCache = { key: cacheKey, audio: audioData };
            console.log('[OnnxSVSPipeline] 音频已缓存');

            onProgress(100);
            return audioData;
        }

        if (!ptMelData || ptFrameCount === 0) {
            ptFrameCount = Math.min(50, 10);
            ptMelData = new Float32Array(ptFrameCount * MEL_DIM);
            console.log(`[OnnxSVSPipeline] 分段模式使用零prompt: ${ptFrameCount}帧`);
        }

        const totalBeats = filledNotes.length > 0
            ? Math.max(...filledNotes.map(n => n.start + n.duration))
            : 0;
        const totalSamples = Math.floor((totalBeats / bpm) * 60 * SAMPLE_RATE);
        const finalAudio = new Float32Array(totalSamples);
        const weightSum = new Float32Array(totalSamples);

        const overlapBeats = (SEGMENT_OVERLAP_SEC / 60) * bpm;
        const overlapSamples = Math.floor(SEGMENT_OVERLAP_SEC * SAMPLE_RATE);

        const fadeWindow = new Float32Array(overlapSamples);
        for (let i = 0; i < overlapSamples; i++) {
            fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * i / overlapSamples));
        }

        const progressPerSegment = 80 / segments.length;

        for (let segIdx = 0; segIdx < segments.length; segIdx++) {
            const seg = segments[segIdx];
            const segProgressStart = 10 + segIdx * progressPerSegment;
            const segProgressRange = progressPerSegment * 0.9;
            const vocoderProgressStart = segProgressStart + segProgressRange;
            const vocoderProgressRange = progressPerSegment * 0.1;

            onProgress(Math.round(segProgressStart));

            const segResult = await this._synthesizeSegment(
                seg.notes, bpm, f0Envelope, pitchCurveF0, f0Shift,
                ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale,
                onProgress, segProgressStart, segProgressRange
            );

            if (segResult.audio.length === 0) continue;

            const segStartSample = Math.floor((seg.startBeat / bpm) * 60 * SAMPLE_RATE);
            const segAudio = segResult.audio;
            const segSamples = segAudio.length;

            const hasOverlap = segIdx > 0 && seg.startBeat < segments[segIdx - 1].endBeat;

            for (let i = 0; i < segSamples; i++) {
                const outIdx = segStartSample + i;
                if (outIdx >= totalSamples) break;

                let w = 1.0;
                if (hasOverlap && i < overlapSamples) {
                    w = fadeWindow[i];
                }
                if (segIdx < segments.length - 1 && seg.endBeat > segments[segIdx + 1].startBeat) {
                    const remainingSamples = segSamples - i;
                    if (remainingSamples <= overlapSamples) {
                        w = Math.min(w, 1.0 - fadeWindow[overlapSamples - remainingSamples]);
                    }
                }

                finalAudio[outIdx] += segAudio[i] * w;
                weightSum[outIdx] += w;
            }

            onProgress(Math.round(vocoderProgressStart + vocoderProgressRange));
        }

        for (let i = 0; i < totalSamples; i++) {
            if (weightSum[i] > 1e-8) {
                finalAudio[i] /= weightSum[i];
            }
        }

        const audioData = finalAudio;
        this._synthCache = { key: cacheKey, audio: audioData };
        console.log('[OnnxSVSPipeline] 分段合成完成，音频已缓存');

        onProgress(100);
        return audioData;
    }

    _median(arr) {
        if (!arr || arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    _extractRefF0FromWav(wavBuffer) {
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

    _extractRefNotePitches(wavBuffer) {
        try {
            const f0 = this._extractRefF0FromWav(wavBuffer);
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
            console.warn('[OnnxSVSPipeline] 参考音频音符音高提取失败:', e.message);
            return null;
        }
    }

    getHardwareInfo() {
        if (!this.initialized) {
            return null;
        }
        const dmlCount = Object.values(this.sessionEPs).filter(e => e === 'dml').length;
        const cpuCount = Object.values(this.sessionEPs).filter(e => e === 'cpu').length;
        const totalModels = Object.keys(this.sessionEPs).length;
        return {
            gpuDeviceName: this.gpuDeviceName || '无 GPU (仅 CPU)',
            dmlDeviceId: this.dmlDeviceId,
            dmlModelCount: dmlCount,
            cpuModelCount: cpuCount,
            totalModels,
            isUsingDML: dmlCount > 0,
        };
    }

    /**
     * 检查指定模型是否已加载
     */
    isModelLoaded(sessionKey) {
        return !!(this.sessions[sessionKey] && this.initialized);
    }

    /**
     * 获取所有模型的状态信息
     */
    getModelsStatus() {
        const sessionKeys = [
            'noteTextEncoder',
            'notePitchEncoder',
            'noteTypeEncoder',
            'f0Encoder',
            'preflow',
            'condEmb',
            'diffStep',
            'vocoder',
            'melTransform',
        ];
        return sessionKeys.map(key => ({
            sessionKey: key,
            loaded: !!(this.sessions[key]),
            ep: this.sessionEPs[key] || null,
        }));
    }

    /**
     * 卸载指定模型（释放其 ONNX 会话）
     */
    unloadModel(sessionKey) {
        if (!this.sessions[sessionKey]) {
            return { success: false, error: 'Model not loaded' };
        }
        try {
            if (typeof this.sessions[sessionKey].release === 'function') {
                this.sessions[sessionKey].release();
            }
            delete this.sessions[sessionKey];
            delete this.sessionEPs[sessionKey];
            console.log(`[OnnxSVSPipeline] 模型 ${sessionKey} 已卸载`);
            return { success: true };
        } catch (err) {
            console.warn(`[OnnxSVSPipeline] 卸载模型 ${sessionKey} 失败:`, err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * 加载指定模型
     */
    async loadModel(sessionKey) {
        if (this.sessions[sessionKey]) {
            return { success: true, alreadyLoaded: true };
        }

        const sessionKeyToModelFile = {
            noteTextEncoder: 'note_text_encoder.onnx',
            notePitchEncoder: 'note_pitch_encoder.onnx',
            noteTypeEncoder: 'note_type_encoder.onnx',
            f0Encoder: 'f0_encoder.onnx',
            preflow: 'preflow.onnx',
            condEmb: 'cond_emb.onnx',
            diffStep: 'diff_step_dml.onnx',
            vocoder: 'vocoder_dml.onnx',
            melTransform: 'mel_transform.onnx',
        };

        const modelFile = sessionKeyToModelFile[sessionKey];
        if (!modelFile) {
            return { success: false, error: `Unknown session key: ${sessionKey}` };
        }

        let resolvedFile = modelFile;
        if (modelFile === 'diff_step_dml.onnx') {
            const dmlPath = path.join(this.modelDir, 'diff_step_dml.onnx');
            let dmlExists = false;
            try { await fs.promises.access(dmlPath); dmlExists = true; } catch (_) {}
            if (!dmlExists) {
                resolvedFile = 'diff_step.onnx';
            }
        }
        if (modelFile === 'vocoder_dml.onnx') {
            const vocDmlPath = path.join(this.modelDir, 'vocoder_dml.onnx');
            let vocDmlExists = false;
            try { await fs.promises.access(vocDmlPath); vocDmlExists = true; } catch (_) {}
            if (!vocDmlExists) {
                resolvedFile = 'vocoder.onnx';
            }
        }

        const modelPath = path.join(this.modelDir, resolvedFile);
        try {
            await fs.promises.access(modelPath);
        } catch (_) {
            return { success: false, error: `Model file not found: ${resolvedFile}` };
        }

        try {
            const { session, ep } = await createSessionWithValidation(
                modelPath, sessionKey, this.gpuDeviceName, this.dmlDeviceId
            );
            this.sessions[sessionKey] = session;
            this.sessionEPs[sessionKey] = ep;
            console.log(`[OnnxSVSPipeline] 模型 ${sessionKey} 已加载 [${ep}]`);
            return { success: true, ep };
        } catch (err) {
            console.error(`[OnnxSVSPipeline] 加载模型 ${sessionKey} 失败:`, err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * 确保所有必需模型已加载（合成前调用）
     */
    async ensureAllModelsLoaded() {
        const requiredKeys = [
            'noteTextEncoder', 'notePitchEncoder', 'noteTypeEncoder',
            'f0Encoder', 'preflow', 'condEmb', 'diffStep', 'vocoder', 'melTransform',
        ];
        const missing = requiredKeys.filter(key => !this.sessions[key]);
        if (missing.length === 0) return;

        console.log(`[OnnxSVSPipeline] 需要加载 ${missing.length} 个缺失模型: ${missing.join(', ')}`);
        for (const key of missing) {
            const result = await this.loadModel(key);
            if (!result.success) {
                throw new Error(`Failed to load required model ${key}: ${result.error}`);
            }
        }
    }

    dispose() {
        for (const key of Object.keys(this.sessions)) {
            if (this.sessions[key] && typeof this.sessions[key].release === 'function') {
                try { this.sessions[key].release(); } catch (e) {
                    console.warn(`[OnnxSVSPipeline] 释放会话失败 (${key}):`, e.message);
                }
            }
        }
        this.sessions = {};
        this.sessionEPs = {};
        this.initialized = false;
        this._initPromise = null;
        this._synthCache = null;
        console.log('[OnnxSVSPipeline] ONNX Runtime 会话已释放');
    }
}

module.exports = { OnnxSVSPipeline, NativeSVSPipeline: OnnxSVSPipeline, SAMPLE_RATE, enumerateDMLDevices };
