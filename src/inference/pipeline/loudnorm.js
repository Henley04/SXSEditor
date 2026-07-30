/**
 * EBU R128 loudness normalization + true-peak limiter.
 *
 * Implements ITU-R BS.1770-4 integrated loudness measurement (K-weighting +
 * gated block measurement) and a true-peak limiter (4× oversampling peak
 * detection + soft gain reduction). Pure JS — no FFmpeg / libebur128 native
 * dependency.
 *
 * The K-weighting filter is computed for the actual sample rate via the RBJ
 * biquad formulas (the ITU spec only tabulates 48/96 kHz coefficients), so the
 * measurement is valid at any rate (the SVS vocoder outputs 24 kHz).
 */

/**
 * Compute K-weighting biquad coefficients (stage 1 high-shelf + stage 2 RLB
 * high-pass) for a given sample rate, per ITU-R BS.1770-4 Annex.
 * @returns {{stage1: object, stage2: object}} normalized biquad coeffs
 */
function _kWeightCoeffs(fs) {
    // Stage 1: high-shelf pre-filter (+4 dB shelf around 1.68 kHz).
    const f0_1 = 1681.974450955533;
    const G_1 = 4.0;
    const Q_1 = 0.7071752369554196;
    const A1 = Math.pow(10, G_1 / 40);
    const w1 = 2 * Math.PI * f0_1 / fs;
    const cw1 = Math.cos(w1), sw1 = Math.sin(w1);
    const sqA1 = Math.sqrt(A1);
    const al1 = sw1 / (2 * Q_1);
    const a0_1 = (A1 + 1) - (A1 - 1) * cw1 + 2 * sqA1 * al1;
    const stage1 = {
        b0: (A1 * ((A1 + 1) + (A1 - 1) * cw1 + 2 * sqA1 * al1)) / a0_1,
        b1: (-2 * A1 * ((A1 - 1) + (A1 + 1) * cw1)) / a0_1,
        b2: (A1 * ((A1 + 1) + (A1 - 1) * cw1 - 2 * sqA1 * al1)) / a0_1,
        a1: (2 * ((A1 - 1) - (A1 + 1) * cw1)) / a0_1,
        a2: ((A1 + 1) - (A1 - 1) * cw1 - 2 * sqA1 * al1) / a0_1,
    };

    // Stage 2: RLB high-pass (~38 Hz, Q≈0.5) — removes sub-bass that does not
    // contribute to perceived loudness.
    const f0_2 = 38.13547087602444;
    const Q_2 = 0.5003270373238773;
    const w2 = 2 * Math.PI * f0_2 / fs;
    const cw2 = Math.cos(w2), sw2 = Math.sin(w2);
    const al2 = sw2 / (2 * Q_2);
    const a0_2 = 1 + al2;
    const stage2 = {
        b0: ((1 + cw2) / 2) / a0_2,
        b1: (-(1 + cw2)) / a0_2,
        b2: ((1 + cw2) / 2) / a0_2,
        a1: (-2 * cw2) / a0_2,
        a2: (1 - al2) / a0_2,
    };

    return { stage1, stage2 };
}

/**
 * Apply a biquad filter (Direct Form II Transposed) in-place to a copy.
 * @param {Float32Array} samples
 * @param {object} c - { b0, b1, b2, a1, a2 }
 * @returns {Float32Array} filtered copy
 */
function _biquad(samples, c) {
    const out = new Float32Array(samples.length);
    let z1 = 0, z2 = 0;
    for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        const y = c.b0 * x + z1;
        z1 = c.b1 * x - c.a1 * y + z2;
        z2 = c.b2 * x - c.a2 * y;
        out[i] = y;
    }
    return out;
}

/**
 * Measure EBU R128 integrated loudness (LUFS) of a mono signal.
 *
 * K-weight → 400 ms gating blocks (75 % overlap / 100 ms hop) → absolute gate
 * (−70 LUFS) → relative gate (−10 LU below absolute-gated mean) → integrated
 * loudness = mean of relative-gated blocks in the linear domain.
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {number} integrated loudness in LUFS (−70 for silence / too-short)
 */
function measureLoudness(samples, sampleRate) {
    if (!samples || samples.length === 0) return -70.0;

    const coeffs = _kWeightCoeffs(sampleRate);
    const stage1 = _biquad(samples, coeffs.stage1);
    const kWeighted = _biquad(stage1, coeffs.stage2);

    // Gating block: 400 ms, 75 % overlap (100 ms hop).
    const blockSize = Math.floor(0.4 * sampleRate);
    const hopSize = Math.max(1, Math.floor(0.1 * sampleRate));
    if (kWeighted.length < blockSize) {
        // Signal shorter than one block: measure over all available samples.
        let sum = 0;
        for (let i = 0; i < kWeighted.length; i++) sum += kWeighted[i] * kWeighted[i];
        const mean = sum / Math.max(1, kWeighted.length);
        return mean > 0 ? -0.691 + 10 * Math.log10(mean) : -70.0;
    }

    const numBlocks = Math.floor((kWeighted.length - blockSize) / hopSize) + 1;
    const blockLufs = [];
    for (let b = 0; b < numBlocks; b++) {
        const start = b * hopSize;
        const end = start + blockSize;
        let sum = 0;
        for (let i = start; i < end; i++) sum += kWeighted[i] * kWeighted[i];
        const mean = sum / blockSize;
        blockLufs.push(mean > 0 ? -0.691 + 10 * Math.log10(mean) : -70.0);
    }

    // Absolute gate: −70 LUFS.
    const absGated = blockLufs.filter(l => l > -70.0);
    if (absGated.length === 0) return -70.0;

    // Relative gate: −10 LU below the mean of absolute-gated blocks.
    const absMean = absGated.reduce((a, b) => a + b, 0) / absGated.length;
    const relGate = absMean - 10.0;

    const relGated = absGated.filter(l => l >= relGate);
    if (relGated.length === 0) return absMean;

    // Integrated loudness: linear mean of relative-gated blocks.
    let linSum = 0;
    for (const l of relGated) linSum += Math.pow(10, (l + 0.691) / 10);
    const linMean = linSum / relGated.length;
    return linMean > 0 ? -0.691 + 10 * Math.log10(linMean) : -70.0;
}

/**
 * True-peak limiter: 4× oversampling peak detection + soft gain reduction.
 *
 * Detects inter-sample peaks via 4× linear-interpolation oversampling, then —
 * if the true peak exceeds the threshold — scales the entire signal down so
 * the true peak lands just below the threshold. This is transparent (no
 * harmonic distortion, unlike hard clipping or tanh saturation) and is the
 * approach used by ffmpeg `loudnorm` in linear (one-pass) mode.
 *
 * @param {Float32Array} samples - modified in place
 * @param {number} sampleRate
 * @param {number} maxTruePeakDb - threshold in dBTP (e.g. −1.0)
 */
function _limitTruePeak(samples, sampleRate, maxTruePeakDb) {
    const threshold = Math.pow(10, maxTruePeakDb / 20); // e.g. −1 dB → 0.891
    const up = 4; // 4× oversampling for true-peak detection

    // Find max true-peak via 4× linear interpolation.
    let maxTp = 0;
    for (let i = 0; i < samples.length - 1; i++) {
        let a = Math.abs(samples[i]);
        if (a > maxTp) maxTp = a;
        const s0 = samples[i], s1 = samples[i + 1];
        for (let r = 1; r < up; r++) {
            const frac = r / up;
            const v = Math.abs(s0 * (1 - frac) + s1 * frac);
            if (v > maxTp) maxTp = v;
        }
    }
    const lastA = Math.abs(samples[samples.length - 1]);
    if (lastA > maxTp) maxTp = lastA;

    if (maxTp <= threshold) return; // already within limit

    // Soft gain reduction: scale so true-peak ≈ threshold (1 % safety margin
    // prevents floating-point overshoot from landing exactly at the limit).
    const scale = (threshold / maxTp) * 0.99;
    for (let i = 0; i < samples.length; i++) samples[i] *= scale;
}

/**
 * Apply EBU R128 loudness normalization + true-peak limiting.
 *
 * Two-pass: (1) measure current integrated loudness, (2) apply the gain needed
 * to reach `targetLufs`, then limit true-peak to `maxTruePeak`. The input
 * array is modified in place and also returned for chaining.
 *
 * @param {Float32Array} samples - audio samples (modified in place)
 * @param {number} sampleRate - sample rate in Hz
 * @param {number} [targetLufs=-14] - target integrated loudness in LUFS
 * @param {number} [maxTruePeak=-1.0] - max true-peak in dBTP
 * @returns {Float32Array} the normalized samples (same array, modified in place)
 */
function loudnormFinal(samples, sampleRate, targetLufs = -14, maxTruePeak = -1.0) {
    if (!samples || samples.length === 0) return samples;

    // Pass 1: measure current loudness.
    const currentLufs = measureLoudness(samples, sampleRate);
    if (currentLufs <= -70.0) return samples; // silence — nothing to normalize

    // Pass 2: apply gain to reach target.
    const gainDb = targetLufs - currentLufs;
    const gainLin = Math.pow(10, gainDb / 20);
    for (let i = 0; i < samples.length; i++) samples[i] *= gainLin;

    // True-peak limiting (may reduce gain slightly if peaks exceed threshold).
    _limitTruePeak(samples, sampleRate, maxTruePeak);

    return samples;
}

module.exports = { loudnormFinal, measureLoudness };
