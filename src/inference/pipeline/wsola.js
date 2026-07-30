/**
 * WSOLA (Waveform Similarity Overlap-Add) crossfade utilities.
 *
 * Replaces symmetric Hann OLA crossfades at vocoder chunk boundaries (time
 * domain) and diffusion chunk boundaries (mel domain). Plain Hann OLA assumes
 * the two segments are already time-aligned; on pitched signals a constant
 * phase/time offset between chunks produces flanging / comb filtering across
 * the overlap. WSOLA first searches for the best local alignment via
 * cross-correlation (time domain) or cosine similarity (mel domain), then
 * applies a Hann-weighted OLA on the aligned segments — eliminating the
 * comb-filter artifacts while keeping the overlap continuous.
 *
 * Both helpers return the crossfaded concatenation of length
 * `prevTail.length + currHead.length - overlapSamples` (the standard
 * "concatenate with overlap" length). When the two inputs are exactly
 * `overlap` long (the common vocoder-chunk case), the result is just the
 * `overlap`-sample crossfaded region.
 */

/**
 * Time-domain WSOLA crossfade.
 *
 * Algorithm:
 *   1. Copy the non-overlapping prefix of prevTail and suffix of currHead
 *      unchanged.
 *   2. Over the overlap region, divide into ~2 ms analysis frames with 50 %
 *      overlap. For each frame, take prevTail as reference and search currHead
 *      within ±searchWindowMs for the offset that maximizes the (zero-mean
 *      normalized) cross-correlation.
 *   3. OLA the per-frame-aligned currHead samples into an `alignedCurr` buffer
 *      using a Hann analysis window, then normalize by the window sum.
 *   4. Apply a Hann crossfade window over the full overlap:
 *      result[i] = prevTail[i] * (1 - w[i]) + alignedCurr[i] * w[i].
 *
 * @param {Float32Array|number[]} prevTail - tail of the previous segment
 * @param {Float32Array|number[]} currHead - head of the current segment
 * @param {number} overlapSamples - number of overlapping samples
 * @param {number} sampleRate - sample rate of the waveforms (Hz)
 * @param {number} [searchWindowMs=4] - per-frame alignment search window (±ms)
 * @returns {Float32Array} crossfaded output, length prevTail.length + currHead.length - overlapSamples
 */
function wsolaCrossfade(prevTail, currHead, overlapSamples, sampleRate, searchWindowMs = 4) {
    const n1 = prevTail.length;
    const n2 = currHead.length;
    const O = Math.max(0, Math.floor(overlapSamples));
    const outLen = n1 + n2 - O;
    const result = new Float32Array(Math.max(0, outLen));
    if (outLen <= 0) return result;

    // Non-overlap prefix from prevTail (unchanged).
    const prefixLen = Math.max(0, n1 - O);
    for (let i = 0; i < prefixLen; i++) result[i] = prevTail[i];
    // Non-overlap suffix from currHead (unchanged).
    const suffixLen = Math.max(0, n2 - O);
    for (let i = 0; i < suffixLen; i++) result[prefixLen + O + i] = currHead[O + i];

    if (O <= 0) return result;
    // Overlap region in prevTail: [prefixLen, prefixLen + O) (its last O samples).
    // Overlap region in currHead: [0, O) (its first O samples).
    const overlapStart = prefixLen;

    // Insufficient samples for WSOLA search — fall back to plain Hann crossfade.
    if (n1 < O || n2 < O) {
        for (let i = 0; i < O; i++) {
            const w = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (O + 1)));
            const prev = (overlapStart + i < n1) ? prevTail[overlapStart + i] : 0;
            const curr = (i < n2) ? currHead[i] : 0;
            result[overlapStart + i] = prev * (1 - w) + curr * w;
        }
        return result;
    }

    const searchSamples = Math.max(1, Math.floor((searchWindowMs || 0) * sampleRate / 1000));

    // Global alignment: a single zero-mean normalized cross-correlation search
    // over the full overlap. Unlike per-frame WSOLA (which divides the overlap
    // into ~2 ms analysis frames and can pick *different* offsets per frame on
    // periodic signals — the periodic cross-correlation has multiple equal
    // peaks, so consecutive frames may land on different peaks and stitch
    // together a discontinuous alignedCurr), a global search uses the entire
    // overlap as the correlation window. The longer window sharpens the peak
    // (more samples ⇒ better selectivity) and, critically, produces ONE
    // consistent offset, so alignedCurr is a contiguous slice of currHead with
    // no internal discontinuities. This keeps the Hann crossfade smooth even
    // on pitched (periodic) signals where per-frame WSOLA breaks down.
    //
    // For each candidate offset the correlation is computed only over the
    // mutually-valid sample range (handles the case where the offset shifts
    // part of the window outside currHead).
    let bestOff = 0;
    let bestCorr = -Infinity;
    for (let off = -searchSamples; off <= searchSamples; off++) {
        const lo = Math.max(0, -off);
        const hi = Math.min(O, n2 - off);
        const len = hi - lo;
        if (len < 8) continue; // need enough overlap for a reliable correlation

        let refMean = 0, candMean = 0;
        for (let i = lo; i < hi; i++) {
            refMean += prevTail[overlapStart + i];
            candMean += currHead[i + off];
        }
        refMean /= len;
        candMean /= len;

        let corr = 0, refVar = 0, candVar = 0;
        for (let i = lo; i < hi; i++) {
            const r = prevTail[overlapStart + i] - refMean;
            const c = currHead[i + off] - candMean;
            corr += r * c;
            refVar += r * r;
            candVar += c * c;
        }
        const denom = Math.sqrt(refVar * candVar);
        // Normalized cross-correlation in [-1, 1]; offset 0 (no shift) is kept
        // when correlations are tied so phase-continuous inputs are untouched.
        const normCorr = denom > 1e-8 ? corr / denom : 0;
        if (normCorr > bestCorr) {
            bestCorr = normCorr;
            bestOff = off;
        }
    }

    // Build alignedCurr by shifting currHead by bestOff. Samples that fall
    // outside currHead (only possible at the edges when bestOff != 0) are
    // edge-clamped; the Hann crossfade window is ~0 there so the clamp has
    // negligible effect on the output.
    const alignedCurr = new Float32Array(O);
    for (let i = 0; i < O; i++) {
        const j = i + bestOff;
        alignedCurr[i] = (j >= 0 && j < n2) ? currHead[j] : currHead[j < 0 ? 0 : n2 - 1];
    }

    // Hann crossfade window over the full overlap (w[i] + w[O-1-i] = 1).
    for (let i = 0; i < O; i++) {
        const w = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (O + 1)));
        result[overlapStart + i] = prevTail[overlapStart + i] * (1 - w) + alignedCurr[i] * w;
    }

    return result;
}

/**
 * Mel-domain WSOLA crossfade.
 *
 * Per-frame alignment using cosine similarity between mel frames, then
 * frame-by-frame Hann OLA crossfade. Mel frames are treated as atomic units
 * (no sub-frame interpolation), matching how the diffusion model produces mel.
 *
 * @param {Float32Array|number[]} prevTail - tail mel of previous chunk (frames*melDim flat)
 * @param {Float32Array|number[]} currHead - head mel of current chunk (frames*melDim flat)
 * @param {number} overlapFrames - number of overlapping mel frames
 * @param {number} melDim - mel feature dimension (e.g. 128)
 * @returns {Float32Array} crossfaded mel, length (prevFrames + currFrames - overlapFrames) * melDim
 */
function wsolaCrossfadeMel(prevTail, currHead, overlapFrames, melDim) {
    const md = Math.max(1, Math.floor(melDim));
    const n1 = Math.floor(prevTail.length / md); // prevTail frames
    const n2 = Math.floor(currHead.length / md); // currHead frames
    const O = Math.max(0, Math.floor(overlapFrames));
    const outFrames = n1 + n2 - O;
    const result = new Float32Array(Math.max(0, outFrames) * md);
    if (outFrames <= 0) return result;

    // Non-overlap prefix from prevTail.
    const prefixFrames = Math.max(0, n1 - O);
    for (let f = 0; f < prefixFrames; f++) {
        for (let d = 0; d < md; d++) result[f * md + d] = prevTail[f * md + d];
    }
    // Non-overlap suffix from currHead.
    const suffixFrames = Math.max(0, n2 - O);
    for (let f = 0; f < suffixFrames; f++) {
        for (let d = 0; d < md; d++) result[(prefixFrames + O + f) * md + d] = currHead[(O + f) * md + d];
    }

    if (O <= 0) return result;
    const overlapStart = prefixFrames; // == n1 - O

    if (n1 < O || n2 < O) {
        // Fallback plain Hann crossfade.
        for (let i = 0; i < O; i++) {
            const w = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (O + 1)));
            for (let d = 0; d < md; d++) {
                const prev = (overlapStart + i < n1) ? prevTail[(overlapStart + i) * md + d] : 0;
                const curr = (i < n2) ? currHead[i * md + d] : 0;
                result[(overlapStart + i) * md + d] = prev * (1 - w) + curr * w;
            }
        }
        return result;
    }

    // Per-frame best alignment via cosine similarity.
    // Search window: ±O/4 frames (clamped to >=1).
    const searchFrames = Math.max(1, Math.floor(O / 4));
    const alignedCurr = new Float32Array(O * md);

    for (let i = 0; i < O; i++) {
        const refBase = (overlapStart + i) * md;
        let refNorm = 0;
        for (let d = 0; d < md; d++) refNorm += prevTail[refBase + d] * prevTail[refBase + d];
        refNorm = Math.sqrt(refNorm);

        let bestOff = 0;
        let bestSim = -Infinity;
        for (let off = -searchFrames; off <= searchFrames; off++) {
            const j = i + off;
            if (j < 0 || j >= O || j >= n2) continue;
            const candBase = j * md;
            let dot = 0;
            let candNorm = 0;
            for (let d = 0; d < md; d++) {
                dot += prevTail[refBase + d] * currHead[candBase + d];
                candNorm += currHead[candBase + d] * currHead[candBase + d];
            }
            candNorm = Math.sqrt(candNorm);
            const sim = (refNorm > 1e-8 && candNorm > 1e-8) ? dot / (refNorm * candNorm) : 0;
            if (sim > bestSim) {
                bestSim = sim;
                bestOff = off;
            }
        }
        const srcBase = (i + bestOff) * md;
        for (let d = 0; d < md; d++) alignedCurr[i * md + d] = currHead[srcBase + d];
    }

    // Hann OLA crossfade over the overlap frames.
    const xfWin = new Float32Array(O);
    for (let i = 0; i < O; i++) {
        xfWin[i] = 0.5 * (1 - Math.cos(Math.PI * (i + 1) / (O + 1)));
    }
    for (let i = 0; i < O; i++) {
        const w = xfWin[i];
        const refBase = (overlapStart + i) * md;
        const alignedBase = i * md;
        for (let d = 0; d < md; d++) {
            result[refBase + d] = prevTail[refBase + d] * (1 - w) + alignedCurr[alignedBase + d] * w;
        }
    }

    return result;
}

module.exports = {
    wsolaCrossfade,
    wsolaCrossfadeMel,
};
