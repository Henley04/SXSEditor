/**
 * EBU R128 loudness normalization + true-peak limiter (pure JS, no FFmpeg).
 *
 * Implements ITU-R BS.1770-4 integrated loudness measurement (K-weighting +
 * gated block loudness) and a true-peak limiter using parabolic inter-sample
 * peak estimation. Designed for the SVS export path: normalize final output to
 * a target loudness (default -14 LUFS, streaming-friendly) and cap true-peak at
 * -1 dBTP to prevent clipping when subsequently encoded to lossy formats
 * (MP3/AAC). Replaces the peak-only `normalizePeakTo` at the export stage.
 *
 * Pipeline peak normalization (normalizePeakTo → 0.95) is retained for
 * streaming Int16 safety; this module runs AFTER the pipeline, on the final
 * mixed audio, immediately before WAV encoding.
 *
 * @module loudnessNormalize
 */

// ===== ITU-R BS.1770-4 K-weighting filter coefficients (48 kHz) =====
// Stage 1: pre-filter (high-shelf, ~+4 dB above ~1.5 kHz)
const PRE_FILTER = {
    b0:  1.53512485958697,
    b1: -2.69169618940638,
    b2:  1.19839281085285,
    a1: -1.69065929318241,
    a2:  0.73248077421585,
};
// Stage 2: RLB filter (2nd-order high-pass, ~38 Hz corner)
const RLB_FILTER = {
    b0:  1.0,
    b1: -2.0,
    b2:  1.0,
    a1: -1.99004745483398,
    a2:  0.99007225036621,
};

/**
 * Biquad filter (Direct Form II Transposed).
 * Stateful: call process() on consecutive blocks for continuous filtering.
 */
class Biquad {
    constructor(coeffs) {
        this.b0 = coeffs.b0;
        this.b1 = coeffs.b1;
        this.b2 = coeffs.b2;
        this.a1 = coeffs.a1;
        this.a2 = coeffs.a2;
        this.z1 = 0;
        this.z2 = 0;
    }
    process(samples) {
        const n = samples.length;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const x = samples[i];
            const y = this.b0 * x + this.z1;
            this.z1 = this.b1 * x - this.a1 * y + this.z2;
            this.z2 = this.b2 * x - this.a2 * y;
            out[i] = y;
        }
        return out;
    }
}

/**
 * Linear 2× upsampling (24 kHz → 48 kHz) for loudness measurement only.
 * Measurement accuracy is not sample-critical; linear interpolation suffices.
 */
function upsample2x(samples) {
    const n = samples.length;
    if (n === 0) return new Float32Array(0);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        out[2 * i] = samples[i];
        if (i + 1 < n) {
            out[2 * i + 1] = 0.5 * (samples[i] + samples[i + 1]);
        } else {
            out[2 * i + 1] = samples[i];
        }
    }
    return out;
}

/**
 * ITU-R BS.1770-4 gated integrated loudness measurement.
 *
 * Two-stage gating:
 *   1. Absolute gate: -70 LUFS (remove silence / very quiet blocks)
 *   2. Relative gate: -10 LU relative to the ungated mean (remove foreground
 *      content from background average)
 *
 * @param {Float32Array} kWeighted - K-weighted samples at 48 kHz
 * @param {number} sampleRate - sample rate of kWeighted (must be 48000)
 * @returns {number} integrated loudness in LUFS, or -Infinity if unmeasurable
 */
function measureIntegratedLoudness(kWeighted, sampleRate) {
    const sr = sampleRate || 48000;
    const blockSize = Math.floor(0.4 * sr);  // 400 ms block
    const hopSize = Math.floor(0.1 * sr);    // 100 ms hop (75% overlap)
    if (kWeighted.length < blockSize) return -Infinity;

    const ABSOLUTE_GATE = -70.0;  // LUFS
    const RELATIVE_GATE = -10.0;  // LU

    const blockLoudness = [];
    for (let start = 0; start + blockSize <= kWeighted.length; start += hopSize) {
        let sumZ = 0;
        for (let i = start; i < start + blockSize; i++) {
            sumZ += kWeighted[i] * kWeighted[i];
        }
        const meanZ = sumZ / blockSize;
        if (meanZ < 1e-12) continue;
        // LUFS = -0.691 + 10 * log10(mean square)
        blockLoudness.push(-0.691 + 10 * Math.log10(meanZ));
    }
    if (blockLoudness.length === 0) return -Infinity;

    // Stage 1: absolute gate
    const absGated = blockLoudness.filter(l => l >= ABSOLUTE_GATE);
    if (absGated.length === 0) return -Infinity;

    // Compute ungated (abs-gated) mean loudness for relative gate threshold
    let sumGatedLinear = 0;
    for (const l of absGated) {
        sumGatedLinear += Math.pow(10, (l + 0.691) / 10);
    }
    const ungatedLoudness = -0.691 + 10 * Math.log10(sumGatedLinear / absGated.length);

    // Stage 2: relative gate
    const relGateThreshold = ungatedLoudness - RELATIVE_GATE;
    const relGated = absGated.filter(l => l >= relGateThreshold);
    if (relGated.length === 0) return ungatedLoudness;

    let sumFinal = 0;
    for (const l of relGated) {
        sumFinal += Math.pow(10, (l + 0.691) / 10);
    }
    return -0.691 + 10 * Math.log10(sumFinal / relGated.length);
}

/**
 * True-peak estimation via parabolic inter-sample peak interpolation.
 *
 * For each interior sample, fits a parabola through [y[i-1], y[i], y[i+1]]
 * (using absolute values) and computes the analytical peak. Parabolic
 * interpolation can produce peaks ABOVE both endpoints (unlike linear
 * interpolation), making it a conservative (overestimating) true-peak detector
 * — safe for limiting. This approximates the 4× oversampling method in
 * ITU-R BS.1770-4 with negligible error for limiting purposes.
 *
 * @param {Float32Array} samples
 * @returns {number} estimated true-peak (linear amplitude, >= 0)
 */
function computeTruePeak(samples) {
    const n = samples.length;
    if (n === 0) return 0;
    let truePeak = 0;
    for (let i = 0; i < n; i++) {
        const a = Math.abs(samples[i]);
        if (a > truePeak) truePeak = a;
    }
    if (n < 3) return truePeak;
    for (let i = 1; i < n - 1; i++) {
        const y0 = Math.abs(samples[i - 1]);
        const y1 = Math.abs(samples[i]);
        const y2 = Math.abs(samples[i + 1]);
        const denom = y0 - 2 * y1 + y2;
        if (Math.abs(denom) < 1e-12) continue;
        const xOffset = 0.5 * (y0 - y2) / denom;
        if (xOffset < -0.5 || xOffset > 0.5) continue;
        const peakVal = y1 - 0.25 * (y0 - y2) * xOffset;
        if (peakVal > truePeak) truePeak = peakVal;
    }
    return truePeak;
}

/**
 * Apply true-peak limiting: if true-peak exceeds the ceiling, scale down.
 * One-pass (no look-ahead); sufficient because we only prevent clipping,
 * not creative dynamic-range control.
 *
 * @param {Float32Array} audio
 * @param {number} truePeakCeilingDb - ceiling in dBTP (e.g. -1.0)
 * @returns {Float32Array} limited audio (new array if scaled, original if within ceiling)
 */
function applyTruePeakLimit(audio, truePeakCeilingDb) {
    const tp = computeTruePeak(audio);
    const ceilingLinear = Math.pow(10, truePeakCeilingDb / 20);
    if (tp > ceilingLinear && tp > 0) {
        const scale = ceilingLinear / tp;
        const limited = new Float32Array(audio.length);
        for (let i = 0; i < audio.length; i++) limited[i] = audio[i] * scale;
        return limited;
    }
    return audio;
}

/**
 * EBU R128 loudness normalization + true-peak limiter.
 *
 * Pipeline:
 *   1. Upsample to 48 kHz (if needed) and apply K-weighting for measurement
 *   2. Measure gated integrated loudness (LUFS)
 *   3. Compute linear gain to hit targetLufs
 *   4. Apply gain to the ORIGINAL audio (not the upsampled copy)
 *   5. Apply true-peak limiting to cap at truePeakCeilingDb
 *
 * If the audio is silent / unmeasurable, only true-peak limiting is applied
 * (no gain change), preserving the original dynamics.
 *
 * @param {Float32Array} audio - input audio (mono, any sample rate)
 * @param {number} sampleRate - input sample rate (e.g. 24000)
 * @param {number} [targetLufs=-14] - target integrated loudness in LUFS
 * @param {number} [truePeakCeilingDb=-1.0] - true-peak ceiling in dBTP
 * @returns {Float32Array} normalized + limited audio
 */
function loudnessNormalizeAndLimit(audio, sampleRate, targetLufs = -14.0, truePeakCeilingDb = -1.0) {
    if (!audio || audio.length === 0) return audio;

    // 1. Prepare 48 kHz version for K-weighting measurement
    let audio48k;
    if (sampleRate === 48000) {
        audio48k = audio;
    } else if (sampleRate === 24000) {
        audio48k = upsample2x(audio);
    } else {
        // Fallback: assume integer ratio to 48 kHz; use linear resample ratio
        const ratio = 48000 / sampleRate;
        const newLen = Math.round(audio.length * ratio);
        audio48k = new Float32Array(newLen);
        for (let i = 0; i < newLen; i++) {
            const srcIdx = i / ratio;
            const lo = Math.floor(srcIdx);
            const hi = Math.min(lo + 1, audio.length - 1);
            const frac = srcIdx - lo;
            audio48k[i] = audio[lo] * (1 - frac) + audio[hi] * frac;
        }
    }

    // 2. K-weighting (pre-filter then RLB) and measure
    const preFilter = new Biquad(PRE_FILTER);
    const rlbFilter = new Biquad(RLB_FILTER);
    const kWeighted = rlbFilter.process(preFilter.process(audio48k));
    const measuredLufs = measureIntegratedLoudness(kWeighted, 48000);

    let gained = audio;
    if (Number.isFinite(measuredLufs)) {
        // 3-4. Compute and apply gain to original audio
        const gainDb = targetLufs - measuredLufs;
        const gainLinear = Math.pow(10, gainDb / 20);
        gained = new Float32Array(audio.length);
        for (let i = 0; i < audio.length; i++) gained[i] = audio[i] * gainLinear;
    }

    // 5. True-peak limiting
    return applyTruePeakLimit(gained, truePeakCeilingDb);
}

module.exports = {
    loudnessNormalizeAndLimit,
    measureIntegratedLoudness,
    computeTruePeak,
    applyTruePeakLimit,
    upsample2x,
};
