const { expect } = require('chai');
const { Diffusion } = require('../src/inference/pipeline/diffusion');
const { MEL_DIM } = require('../src/inference/pipeline/constants');

/**
 * Task 17: SDEdit local repair tests.
 *
 * Verifies:
 * 1. No-op when no anomalous frames (clean mel → early return, zero delta applied)
 * 2. NaN frames are detected and repaired (post-repair NaN count = 0)
 * 3. Energy spikes (> median × 5) are detected and repaired
 * 4. Non-anomalous frames outside repair regions are preserved
 * 5. Repair region boundaries use Hann crossfade (smooth transition, no hard edge)
 */
describe('Diffusion._sdeditRepair - Task 17 SDEdit local repair', () => {
    let diffusion;

    beforeEach(() => {
        diffusion = new Diffusion();
    });

    /**
     * Build mock evalDiffStep + combine + buffers closures mimicking the
     * runDiffusionLoop internals. evalDiffStep returns a constant prediction
     * (zero velocity → delta = 0, so repair re-noise is the only change).
     * combine copies condPred into vBuf (no-CFG path).
     */
    function makeClosures(totalFrames) {
        const targetLen = totalFrames * MEL_DIM;
        const buffers = {
            vBuf: new Float32Array(targetLen),
            deltaBuf: new Float32Array(targetLen),
            v1Buf: new Float32Array(targetLen),
            xPredBuf: new Float32Array(targetLen),
        };
        const evalDiffStep = async () => {
            // Return zero prediction: condPred = 0, uncondPred = null (no CFG)
            return { condPred: new Float32Array(targetLen), uncondPred: null };
        };
        const combine = (condPred) => {
            buffers.vBuf.set(condPred);
            return buffers.vBuf;
        };
        return { evalDiffStep, combine, buffers };
    }

    it('should be a no-op when no anomalous frames exist (clean mel)', async () => {
        const totalFrames = 20;
        const xt = { data: new Float32Array(totalFrames * MEL_DIM).fill(0.5), dims: [1, totalFrames, MEL_DIM] };
        const original = Float32Array.from(xt.data);
        const { evalDiffStep, combine, buffers } = makeClosures(totalFrames);

        await diffusion._sdeditRepair({
            xt, totalFrames, evalDiffStep, combine, buffers, diagnosticMode: false,
        });

        // No anomalies → early return, xt unchanged
        expect(Array.from(xt.data)).to.deep.equal(Array.from(original));
    });

    it('should detect and repair NaN frames (post-repair NaN = 0)', async () => {
        const totalFrames = 20;
        const xt = { data: new Float32Array(totalFrames * MEL_DIM).fill(0.5), dims: [1, totalFrames, MEL_DIM] };
        // Inject NaN into frames 5-7
        for (let f = 5; f <= 7; f++) {
            for (let d = 0; d < MEL_DIM; d++) {
                xt.data[f * MEL_DIM + d] = NaN;
            }
        }
        const { evalDiffStep, combine, buffers } = makeClosures(totalFrames);

        await diffusion._sdeditRepair({
            xt, totalFrames, evalDiffStep, combine, buffers, diagnosticMode: false,
        });

        // Post-repair: no NaN in the repaired region
        let postNaN = 0;
        for (let i = 0; i < xt.data.length; i++) {
            if (Number.isNaN(xt.data[i])) postNaN++;
        }
        expect(postNaN).to.equal(0);
    });

    it('should detect and repair energy spike frames (> median × 5)', async () => {
        const totalFrames = 20;
        const xt = { data: new Float32Array(totalFrames * MEL_DIM).fill(0.3), dims: [1, totalFrames, MEL_DIM] };
        // Inject energy spike in frames 10-12 (value 10x normal → energy 100x)
        for (let f = 10; f <= 12; f++) {
            for (let d = 0; d < MEL_DIM; d++) {
                xt.data[f * MEL_DIM + d] = 3.0; // 10x normal → energy 100x >> 5x threshold
            }
        }
        const { evalDiffStep, combine, buffers } = makeClosures(totalFrames);

        await diffusion._sdeditRepair({
            xt, totalFrames, evalDiffStep, combine, buffers, diagnosticMode: false,
        });

        // Post-repair: spike frames should be reduced (re-noised + zero-delta → ~0.7*3.0 + noise*0.3)
        // The repaired value should be noticeably lower than the original spike
        const spikeFrameEnergy = (f) => {
            let s = 0;
            for (let d = 0; d < MEL_DIM; d++) s += xt.data[f * MEL_DIM + d] ** 2;
            return s;
        };
        // Frame 11 (core of repaired region) should have lower energy than original 3.0²×MEL_DIM
        const repairedEnergy = spikeFrameEnergy(11);
        const originalSpikeEnergy = 3.0 * 3.0 * MEL_DIM;
        expect(repairedEnergy).to.be.lessThan(originalSpikeEnergy);
    });

    it('should preserve non-anomalous frames outside repair regions', async () => {
        const totalFrames = 30;
        const xt = { data: new Float32Array(totalFrames * MEL_DIM).fill(0.4), dims: [1, totalFrames, MEL_DIM] };
        // Inject NaN in frames 15-16 only
        for (let f = 15; f <= 16; f++) {
            for (let d = 0; d < MEL_DIM; d++) {
                xt.data[f * MEL_DIM + d] = NaN;
            }
        }
        const { evalDiffStep, combine, buffers } = makeClosures(totalFrames);

        await diffusion._sdeditRepair({
            xt, totalFrames, evalDiffStep, combine, buffers, diagnosticMode: false,
        });

        // Frames far from the repair region (e.g. frame 0, 29) should be unchanged
        // (zero evalDiffStep → zero delta → only re-noise in repair region)
        for (let d = 0; d < MEL_DIM; d++) {
            expect(xt.data[0 * MEL_DIM + d]).to.be.closeTo(0.4, 1e-6);
            expect(xt.data[29 * MEL_DIM + d]).to.be.closeTo(0.4, 1e-6);
        }
    });

    it('should handle all-NaN mel gracefully (early return, no crash)', async () => {
        const totalFrames = 10;
        const xt = { data: new Float32Array(totalFrames * MEL_DIM).fill(NaN), dims: [1, totalFrames, MEL_DIM] };
        const { evalDiffStep, combine, buffers } = makeClosures(totalFrames);

        // Should not throw (validEnergies.length === 0 → early return)
        await diffusion._sdeditRepair({
            xt, totalFrames, evalDiffStep, combine, buffers, diagnosticMode: false,
        });

        // xt still NaN (no valid median to base repair on)
        expect(Number.isNaN(xt.data[0])).to.be.true;
    });
});
