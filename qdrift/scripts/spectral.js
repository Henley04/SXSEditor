/**
 * 谱域分析共用工具：radix-2 FFT、逐帧对数谱距离（LSD）、分频段能量、WAV 读取。
 *
 * 被 diagnose_fp16.js（归因）与 lsd_compare.js（任意两条音频对比）共用，
 * 避免同一套 DSP 出现多个副本导致两个脚本给出不同数字。
 *
 * 关于 LSD 的读法（重要）：
 *   LSD 是两个信号**短时幅度谱之间的距离**，同为 0 dB，越大越不同。
 *   它是"差异分"不是"音质分"——同一个模型换随机种子就能产生 14+ dB 的差异。
 *   只在「固定 seed、固定配置、只替换一个组件」的受控比较里才有判读意义。
 *   已知弱点：丢弃相位、无掩蔽模型/无 A 计权、逐帧比绝对幅度（电平不同会整体抬高）。
 */
'use strict';

const fs = require('node:fs');

const SAMPLE_RATE = 24000;
const N_FFT = 1024, LOG_N = 10, BINS = N_FFT / 2 + 1, HOP = 256;

const REV = new Uint16Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
    let r = 0;
    for (let b = 0; b < LOG_N; b++) if (i & (1 << b)) r |= 1 << (LOG_N - 1 - b);
    REV[i] = r;
}
const COS = new Float64Array(N_FFT / 2), SIN = new Float64Array(N_FFT / 2);
for (let i = 0; i < N_FFT / 2; i++) {
    COS[i] = Math.cos(-2 * Math.PI * i / N_FFT);
    SIN[i] = Math.sin(-2 * Math.PI * i / N_FFT);
}
const WINDOW = new Float64Array(N_FFT);
for (let i = 0; i < N_FFT; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N_FFT - 1));

/** 幅度谱（原地 FFT，返回 frames×BINS 的幅度） */
function spectrum(x) {
    const frames = Math.max(0, Math.floor((x.length - N_FFT) / HOP) + 1);
    const mag = new Float32Array(frames * BINS);
    const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
    for (let f = 0; f < frames; f++) {
        for (let n = 0; n < N_FFT; n++) { re[n] = (x[f * HOP + n] || 0) * WINDOW[n]; im[n] = 0; }
        for (let i = 0; i < N_FFT; i++) {
            const j = REV[i];
            if (j > i) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let size = 2; size <= N_FFT; size <<= 1) {
            const half = size >> 1, step = N_FFT / size;
            for (let i = 0; i < N_FFT; i += size) {
                for (let j = i, k = 0; j < i + half; j++, k += step) {
                    const l = j + half;
                    const tr = re[l] * COS[k] - im[l] * SIN[k];
                    const ti = re[l] * SIN[k] + im[l] * COS[k];
                    re[l] = re[j] - tr; im[l] = im[j] - ti;
                    re[j] += tr; im[j] += ti;
                }
            }
        }
        for (let k = 0; k < BINS; k++) {
            mag[f * BINS + k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) + 1e-10;
        }
    }
    return { mag, frames };
}

const _cache = new Map();
/** 带缓存的 spectrum（tag 相同的信号只算一次） */
function spec(x, tag) {
    if (!_cache.has(tag)) _cache.set(tag, spectrum(x));
    return _cache.get(tag);
}
function clearSpecCache() { _cache.clear(); }

const hzToBin = (hz) => Math.max(1, Math.round(hz * N_FFT / SAMPLE_RATE));

/**
 * 逐帧对数谱距离（dB）。
 * 幅度做 -80 dBFS 相对钳位，避免纯静音帧的数值噪声主导统计。
 */
function frameLsd(refS, testS, bandLo = 0, bandHi = SAMPLE_RATE / 2) {
    const frames = Math.min(refS.frames, testS.frames);
    const lo = hzToBin(bandLo), hi = Math.min(BINS - 1, hzToBin(bandHi));
    const FLOOR = 10 ** (-80 / 20);
    const per = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
        let acc = 0, n = 0;
        const off = f * BINS;
        for (let k = lo; k <= hi; k++) {
            const ra = Math.max(refS.mag[off + k], FLOOR);
            const rb = Math.max(testS.mag[off + k], FLOOR);
            const d = 20 * Math.log10(rb / ra);
            acc += d * d; n++;
        }
        per[f] = Math.sqrt(acc / Math.max(1, n));
    }
    return per;
}

function stats(arr) {
    if (!arr.length) return { mean: 0, p50: 0, p95: 0, max: 0 };
    const a = Array.from(arr).sort((x, y) => x - y);
    const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    return { mean: a.reduce((x, y) => x + y, 0) / a.length, p50: q(0.5), p95: q(0.95), max: a[a.length - 1] };
}

/**
 * LSD 汇总：整体均值/分位 + 300ms 分段分位。
 * 分段分位能暴露"只在局部很烂"的情况（全局均值会把它摊平）。
 */
function lsd(refS, testS, opts = {}) {
    const { bandLo = 0, bandHi = SAMPLE_RATE / 2, segMs = 300 } = opts;
    const per = frameLsd(refS, testS, bandLo, bandHi);
    const sorted = Array.from(per).sort((a, b) => a - b);
    const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
    const win = Math.max(1, Math.round(segMs / 1000 * SAMPLE_RATE / HOP));
    const seg = [];
    for (let s = 0; s + win <= sorted.length; s += win) {
        let acc = 0;
        for (let i = s; i < s + win; i++) acc += per[i] * per[i];
        seg.push(Math.sqrt(acc / win));
    }
    seg.sort((a, b) => a - b);
    const sq = (p) => seg.length ? seg[Math.min(seg.length - 1, Math.floor(p * seg.length))] : 0;
    return {
        mean: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length),
        p50: q(0.5), p95: q(0.95), max: sorted[sorted.length - 1] || 0,
        seg_p50: sq(0.5), seg_p95: sq(0.95), seg_max: seg[seg.length - 1] || 0,
    };
}

/** 某频段的能量（用于高频能量比等） */
function bandEnergy(s, loHz, hiHz) {
    const lo = hzToBin(loHz), hi = Math.min(BINS - 1, hzToBin(hiHz));
    let e = 0;
    for (let f = 0; f < s.frames; f++) {
        const off = f * BINS;
        for (let k = lo; k <= hi; k++) e += s.mag[off + k] ** 2;
    }
    return e;
}

/** 逐帧高频能量，用于把帧分成"齿音/气声"与"稳态"两类 */
function frameHfEnergy(s, loHz = 4000) {
    const lo = hzToBin(loHz), hi = BINS - 1;
    const out = new Float64Array(s.frames);
    for (let f = 0; f < s.frames; f++) {
        const off = f * BINS;
        let e = 0;
        for (let k = lo; k <= hi; k++) e += s.mag[off + k] ** 2;
        out[f] = Math.sqrt(e);
    }
    return out;
}

/** 读 WAV（16-bit PCM / 32-bit float，单/多声道取第一声道），返回 Float32Array */
function readWav(file) {
    const b = fs.readFileSync(file);
    if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`not a RIFF file: ${file}`);
    let pos = 12, fmt = null, dataOff = 0, dataLen = 0;
    while (pos + 8 <= b.length) {
        const id = b.toString('ascii', pos, pos + 4);
        const size = b.readUInt32LE(pos + 4);
        if (id === 'fmt ') {
            fmt = {
                format: b.readUInt16LE(pos + 8),
                channels: b.readUInt16LE(pos + 10),
                sampleRate: b.readUInt32LE(pos + 12),
                bits: b.readUInt16LE(pos + 22),
            };
        } else if (id === 'data') {
            dataOff = pos + 8; dataLen = Math.min(size, b.length - dataOff);
        }
        pos += 8 + size + (size & 1);
    }
    if (!fmt || !dataLen) throw new Error(`bad WAV structure: ${file}`);
    const ch = fmt.channels || 1;
    const out = [];
    if (fmt.format === 3 && fmt.bits === 32) {
        const n = Math.floor(dataLen / 4);
        for (let i = 0; i < n; i += ch) out.push(b.readFloatLE(dataOff + i * 4));
    } else if (fmt.bits === 16) {
        const n = Math.floor(dataLen / 2);
        for (let i = 0; i < n; i += ch) out.push(b.readInt16LE(dataOff + i * 2) / 32768);
    } else {
        throw new Error(`unsupported WAV format=${fmt.format} bits=${fmt.bits}`);
    }
    return { data: Float32Array.from(out), sampleRate: fmt.sampleRate, channels: ch };
}

/**
 * 写 32-bit float WAV。
 * 为什么不用 16-bit：16bit 量化本底在 8-12kHz 就有 ~1-2 dB 的谱差异量级，
 * 会把「FP16 相对 FP32」这种本来就小的差异淹掉。测量链路必须用 float。
 * 给人听的成品仍然用 16-bit（兼容播放器）。
 */
function writeWavF32(file, samples, sampleRate = SAMPLE_RATE, channels = 1) {
    const n = samples.length;
    const dataBytes = n * 4;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(3, 20);                       // IEEE float
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * channels * 4, 28);
    buf.writeUInt16LE(channels * 4, 32);
    buf.writeUInt16LE(32, 34);
    buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < n; i++) buf.writeFloatLE(samples[i], 44 + i * 4);
    require('node:fs').writeFileSync(file, buf);
}

function rms(a) { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); }

module.exports = {
    SAMPLE_RATE, N_FFT, HOP, BINS,
    spectrum, spec, clearSpecCache, frameLsd, lsd, stats,
    bandEnergy, frameHfEnergy, readWav, writeWavF32, rms, hzToBin,
};
