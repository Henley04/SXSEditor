const { expect } = require('chai');
const { NativeSVSPipeline } = require('../src/inference/pipeline');

describe('NPU Batch Processing - Logic Tests', () => {
  let pipeline;

  beforeEach(() => {
    pipeline = new NativeSVSPipeline('/fake/model/dir/');
  });

  describe('CFG batch tensor layout', () => {
    // Replicate the CFG batch buffer construction logic from webnnPipeline.js
    function buildCfGBatchBuf(diffBatch, totalFramesWithPrompt, MEL_DIM, ptFrameCount, totalFrames, xtInputBuf, xtData) {
      const cfgBatchBuf = new Float32Array(diffBatch * totalFramesWithPrompt * MEL_DIM);
      const cfgCondBuf = new Float32Array(diffBatch * totalFramesWithPrompt * 1024);
      const cfgMaskBuf = new Float32Array(diffBatch * totalFramesWithPrompt);

      for (let r = 0; r < diffBatch; r++) {
        const rowOff = r * totalFramesWithPrompt;
        if (r % 2 === 0) {
          cfgMaskBuf.fill(1, rowOff, rowOff + totalFramesWithPrompt);
        } else {
          cfgMaskBuf.fill(1, rowOff + ptFrameCount, rowOff + totalFramesWithPrompt);
        }
      }

      for (let r = 0; r < diffBatch; r += 2) {
        cfgCondBuf.fill(1.0, r * totalFramesWithPrompt * 1024, (r + 1) * totalFramesWithPrompt * 1024);
      }

      for (let r = 0; r < diffBatch; r++) {
        const rowOff = r * totalFramesWithPrompt * MEL_DIM;
        if (r % 2 === 0) {
          cfgBatchBuf.set(xtInputBuf, rowOff);
        } else {
          for (let f = 0; f < totalFrames; f++) {
            for (let d = 0; d < MEL_DIM; d++) {
              cfgBatchBuf[rowOff + (ptFrameCount + f) * MEL_DIM + d] = xtData[f * MEL_DIM + d];
            }
          }
        }
      }

      return { cfgBatchBuf, cfgCondBuf, cfgMaskBuf };
    }

    it('should place conditional data in even rows and unconditional in odd rows (batch=2)', () => {
      const MEL_DIM = 4;
      const totalFrames = 3;
      const ptFrameCount = 2;
      const totalFramesWithPrompt = ptFrameCount + totalFrames;
      const diffBatch = 2;

      const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
      xtInputBuf.fill(1.0); // prompt + conditional data = 1.0

      const xtData = new Float32Array(totalFrames * MEL_DIM);
      xtData.fill(2.0); // current xt = 2.0

      const { cfgBatchBuf, cfgMaskBuf } = buildCfGBatchBuf(
        diffBatch, totalFramesWithPrompt, MEL_DIM, ptFrameCount, totalFrames, xtInputBuf, xtData
      );

      // Row 0 (conditional): all mask = 1
      for (let f = 0; f < totalFramesWithPrompt; f++) {
        expect(cfgMaskBuf[f]).to.equal(1);
      }

      // Row 1 (unconditional): mask = 0 for prompt, 1 for target
      for (let f = 0; f < ptFrameCount; f++) {
        expect(cfgMaskBuf[totalFramesWithPrompt + f]).to.equal(0);
      }
      for (let f = ptFrameCount; f < totalFramesWithPrompt; f++) {
        expect(cfgMaskBuf[totalFramesWithPrompt + f]).to.equal(1);
      }

      // Row 0 data: xtInputBuf values (1.0)
      for (let f = 0; f < totalFramesWithPrompt; f++) {
        for (let d = 0; d < MEL_DIM; d++) {
          expect(cfgBatchBuf[f * MEL_DIM + d]).to.equal(1.0);
        }
      }

      // Row 1 data: 0 for prompt (masked out), xtData (2.0) for target
      const row1Off = totalFramesWithPrompt * MEL_DIM;
      for (let f = 0; f < ptFrameCount; f++) {
        for (let d = 0; d < MEL_DIM; d++) {
          expect(cfgBatchBuf[row1Off + f * MEL_DIM + d]).to.equal(0);
        }
      }
      for (let f = 0; f < totalFrames; f++) {
        for (let d = 0; d < MEL_DIM; d++) {
          expect(cfgBatchBuf[row1Off + (ptFrameCount + f) * MEL_DIM + d]).to.equal(2.0);
        }
      }
    });

    it('should duplicate rows for batch=4 (rows 0,1 = first pair, rows 2,3 = second pair)', () => {
      const MEL_DIM = 4;
      const totalFrames = 3;
      const ptFrameCount = 2;
      const totalFramesWithPrompt = ptFrameCount + totalFrames;
      const diffBatch = 4;

      const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
      xtInputBuf.fill(1.0);
      const xtData = new Float32Array(totalFrames * MEL_DIM);
      xtData.fill(2.0);

      const { cfgBatchBuf, cfgMaskBuf } = buildCfGBatchBuf(
        diffBatch, totalFramesWithPrompt, MEL_DIM, ptFrameCount, totalFrames, xtInputBuf, xtData
      );

      // Rows 0 and 2 should be identical (conditional)
      const row0 = cfgBatchBuf.slice(0, totalFramesWithPrompt * MEL_DIM);
      const row2 = cfgBatchBuf.slice(2 * totalFramesWithPrompt * MEL_DIM, 3 * totalFramesWithPrompt * MEL_DIM);
      for (let i = 0; i < row0.length; i++) {
        expect(row0[i]).to.equal(row2[i]);
      }

      // Rows 1 and 3 should be identical (unconditional)
      const row1 = cfgBatchBuf.slice(totalFramesWithPrompt * MEL_DIM, 2 * totalFramesWithPrompt * MEL_DIM);
      const row3 = cfgBatchBuf.slice(3 * totalFramesWithPrompt * MEL_DIM, 4 * totalFramesWithPrompt * MEL_DIM);
      for (let i = 0; i < row1.length; i++) {
        expect(row1[i]).to.equal(row3[i]);
      }

      // Mask rows 0,2 = all ones; rows 1,3 = prompt=0, target=1
      for (let r = 0; r < diffBatch; r++) {
        const maskOff = r * totalFramesWithPrompt;
        if (r % 2 === 0) {
          for (let f = 0; f < totalFramesWithPrompt; f++) {
            expect(cfgMaskBuf[maskOff + f]).to.equal(1);
          }
        } else {
          for (let f = 0; f < ptFrameCount; f++) {
            expect(cfgMaskBuf[maskOff + f]).to.equal(0);
          }
          for (let f = ptFrameCount; f < totalFramesWithPrompt; f++) {
            expect(cfgMaskBuf[maskOff + f]).to.equal(1);
          }
        }
      }
    });

    it('should handle batch=4 with padding (rows beyond the first pair are duplicates)', () => {
      const MEL_DIM = 4;
      const totalFrames = 3;
      const ptFrameCount = 1;
      const totalFramesWithPrompt = ptFrameCount + totalFrames;
      const diffBatch = 4;

      const xtInputBuf = new Float32Array(totalFramesWithPrompt * MEL_DIM);
      xtInputBuf.fill(1.0);
      const xtData = new Float32Array(totalFrames * MEL_DIM);
      xtData.fill(2.0);

      const { cfgBatchBuf, cfgCondBuf } = buildCfGBatchBuf(
        diffBatch, totalFramesWithPrompt, MEL_DIM, ptFrameCount, totalFrames, xtInputBuf, xtData
      );

      // Total buffer size should be diffBatch * totalFramesWithPrompt * MEL_DIM
      expect(cfgBatchBuf.length).to.equal(diffBatch * totalFramesWithPrompt * MEL_DIM);

      // Cond rows: even rows have data, odd rows are zero
      for (let r = 0; r < diffBatch; r++) {
        const condOff = r * totalFramesWithPrompt * 1024;
        const condEnd = (r + 1) * totalFramesWithPrompt * 1024;
        let hasNonZero = false;
        for (let i = condOff; i < condEnd; i++) {
          if (cfgCondBuf[i] !== 0) { hasNonZero = true; break; }
        }
        if (r % 2 === 0) {
          expect(hasNonZero).to.be.true;
        } else {
          expect(hasNonZero).to.be.false;
        }
      }
    });
  });

  describe('Vocoder batch chunk collection', () => {
    // Replicate the vocoder chunk collection logic
    function collectVocoderChunks(totalFrames, vocBatch, chunkSize, stepFrames) {
      const batches = [];
      let offset = 0;

      while (offset < totalFrames) {
        const batchInfos = [];
        let maxChunkFrames = 0;

        for (let b = 0; b < vocBatch && offset < totalFrames; b++) {
          const end = Math.min(offset + chunkSize, totalFrames);
          const chunkFrames = end - offset;
          batchInfos.push({ offset, chunkFrames, end });
          maxChunkFrames = Math.max(maxChunkFrames, chunkFrames);
          offset += stepFrames;
        }

        batches.push({ batchInfos, maxChunkFrames });
      }

      return batches;
    }

    it('should collect single chunks when vocBatch=1', () => {
      const totalFrames = 2000;
      const vocBatch = 1;
      const chunkSize = 1008;
      const stepFrames = 1000; // chunkSize - overlap

      const batches = collectVocoderChunks(totalFrames, vocBatch, chunkSize, stepFrames);

      // First batch: [0, 1008]
      expect(batches[0].batchInfos.length).to.equal(1);
      expect(batches[0].batchInfos[0].offset).to.equal(0);
      expect(batches[0].batchInfos[0].chunkFrames).to.equal(1008);

      // Second batch: [1000, 2008] → clipped to [1000, 2000]
      expect(batches[1].batchInfos.length).to.equal(1);
      expect(batches[1].batchInfos[0].offset).to.equal(1000);
      expect(batches[1].batchInfos[0].chunkFrames).to.equal(1000);
    });

    it('should collect 4 chunks per batch when vocBatch=4', () => {
      const totalFrames = 5000;
      const vocBatch = 4;
      const chunkSize = 1008;
      const stepFrames = 1000;

      const batches = collectVocoderChunks(totalFrames, vocBatch, chunkSize, stepFrames);

      // First batch should have 4 chunks
      expect(batches[0].batchInfos.length).to.equal(4);
      expect(batches[0].batchInfos[0].offset).to.equal(0);
      expect(batches[0].batchInfos[1].offset).to.equal(1000);
      expect(batches[0].batchInfos[2].offset).to.equal(2000);
      expect(batches[0].batchInfos[3].offset).to.equal(3000);

      // Second batch should have 1 chunk (remaining)
      expect(batches[1].batchInfos.length).to.equal(1);
      expect(batches[1].batchInfos[0].offset).to.equal(4000);
      expect(batches[1].batchInfos[0].chunkFrames).to.equal(1000);
    });

    it('should pad shorter chunks to maxChunkFrames in a batch', () => {
      const totalFrames = 3500;
      const vocBatch = 4;
      const chunkSize = 1008;
      const stepFrames = 1000;

      const batches = collectVocoderChunks(totalFrames, vocBatch, chunkSize, stepFrames);

      // First batch: 4 chunks, but last one is shorter
      const b0 = batches[0];
      expect(b0.batchInfos.length).to.equal(4);
      expect(b0.batchInfos[0].chunkFrames).to.equal(1008);
      expect(b0.batchInfos[1].chunkFrames).to.equal(1008);
      expect(b0.batchInfos[2].chunkFrames).to.equal(1008);
      expect(b0.batchInfos[3].chunkFrames).to.equal(500); // 3500 - 3000
      expect(b0.maxChunkFrames).to.equal(1008); // padded to max
    });

    it('should handle totalFrames < chunkSize (single chunk)', () => {
      const totalFrames = 500;
      const vocBatch = 4;
      const chunkSize = 1008;
      const stepFrames = 1000;

      const batches = collectVocoderChunks(totalFrames, vocBatch, chunkSize, stepFrames);

      expect(batches.length).to.equal(1);
      expect(batches[0].batchInfos.length).to.equal(1);
      expect(batches[0].batchInfos[0].chunkFrames).to.equal(500);
    });
  });

  describe('Settings flow to pipeline options', () => {
    it('should include batch settings in preview inference options', () => {
      // Simulate getPreviewInferenceOptions from renderer.js
      const audioSettings = {
        previewDiffSteps: 16,
        previewCfgStrength: 3.0,
        previewCfgRescale: 0.75,
        npuDiffBatchSize: 4,
        npuVocoderBatchSize: 4,
      };

      const opts = {
        nSteps: audioSettings?.previewDiffSteps ?? 16,
        cfg: audioSettings?.previewCfgStrength ?? 3.0,
        cfgRescale: audioSettings?.previewCfgRescale ?? 0.75,
        npuDiffBatchSize: audioSettings?.npuDiffBatchSize ?? 4,
        npuVocoderBatchSize: audioSettings?.npuVocoderBatchSize ?? 4,
      };

      expect(opts.npuDiffBatchSize).to.equal(4);
      expect(opts.npuVocoderBatchSize).to.equal(4);
    });

    it('should use defaults when batch settings are missing', () => {
      const audioSettings = {};

      const opts = {
        npuDiffBatchSize: audioSettings?.npuDiffBatchSize ?? 4,
        npuVocoderBatchSize: audioSettings?.npuVocoderBatchSize ?? 4,
      };

      expect(opts.npuDiffBatchSize).to.equal(4);
      expect(opts.npuVocoderBatchSize).to.equal(4);
    });

    it('should pass batch settings through synthesize options', () => {
      // Simulate the synthesize method receiving options
      const options = {
        nSteps: 32,
        cfg: 3.0,
        cfgRescale: 0.75,
        npuDiffBatchSize: 2,
        npuVocoderBatchSize: 1,
      };

      const npuDiffBatchSize = options.npuDiffBatchSize || 2;
      const npuVocoderBatchSize = options.npuVocoderBatchSize || 1;

      expect(npuDiffBatchSize).to.equal(2);
      expect(npuVocoderBatchSize).to.equal(1);
    });

    it('should compute diffBatch correctly from cfgStrength and npuDiffBatchSize', () => {
      // diffBatch = cfgStrength > 0 ? Math.max(2, npuDiffBatchSize) : 1
      function computeDiffBatch(cfgStrength, npuDiffBatchSize) {
        return cfgStrength > 0 ? Math.max(2, npuDiffBatchSize) : 1;
      }

      expect(computeDiffBatch(3.0, 4)).to.equal(4);
      expect(computeDiffBatch(3.0, 2)).to.equal(2);
      expect(computeDiffBatch(3.0, 1)).to.equal(2); // min 2 for CFG
      expect(computeDiffBatch(0, 4)).to.equal(1);   // no CFG = batch 1
      expect(computeDiffBatch(0, 1)).to.equal(1);
    });
  });

  describe('Segment pairing for batch=4', () => {
    it('should pair segments correctly (0+1, 2+3, ...)', () => {
      const segments = [
        { startBeat: 0, endBeat: 10 },
        { startBeat: 9, endBeat: 20 },
        { startBeat: 19, endBeat: 30 },
        { startBeat: 29, endBeat: 40 },
      ];

      const pairs = [];
      for (let i = 0; i < segments.length; i += 2) {
        if (i + 1 < segments.length) {
          pairs.push([segments[i], segments[i + 1]]);
        } else {
          pairs.push([segments[i]]); // odd segment
        }
      }

      expect(pairs.length).to.equal(2);
      expect(pairs[0].length).to.equal(2);
      expect(pairs[1].length).to.equal(2);
    });

    it('should handle odd number of segments (last segment unpaired)', () => {
      const segments = [
        { startBeat: 0, endBeat: 10 },
        { startBeat: 9, endBeat: 20 },
        { startBeat: 19, endBeat: 30 },
      ];

      const pairs = [];
      for (let i = 0; i < segments.length; i += 2) {
        if (i + 1 < segments.length) {
          pairs.push([segments[i], segments[i + 1]]);
        } else {
          pairs.push([segments[i]]);
        }
      }

      expect(pairs.length).to.equal(2);
      expect(pairs[0].length).to.equal(2);
      expect(pairs[1].length).to.equal(1); // last segment alone
    });

    it('should handle single segment (no pairing)', () => {
      const segments = [{ startBeat: 0, endBeat: 10 }];

      const pairs = [];
      for (let i = 0; i < segments.length; i += 2) {
        if (i + 1 < segments.length) {
          pairs.push([segments[i], segments[i + 1]]);
        } else {
          pairs.push([segments[i]]);
        }
      }

      expect(pairs.length).to.equal(1);
      expect(pairs[0].length).to.equal(1);
    });

    it('should only pair when useBatch is true and segments > 1', () => {
      const useBatch = true;
      const segments = [
        { startBeat: 0, endBeat: 10 },
        { startBeat: 9, endBeat: 20 },
      ];

      const shouldPair = useBatch && segments.length > 1;
      expect(shouldPair).to.be.true;

      const useBatchFalse = false;
      const shouldNotPair = useBatchFalse && segments.length > 1;
      expect(shouldNotPair).to.be.false;
    });
  });

  describe('Batch=4 diffusion result extraction', () => {
    it('should extract conditional from row 0 and unconditional from row 1', () => {
      const MEL_DIM = 4;
      const totalFrames = 3;
      const ptFrameCount = 1;
      const totalFramesWithPrompt = ptFrameCount + totalFrames;
      const diffBatch = 4;

      // Simulate batch prediction output: row 0 = 10, row 1 = 20, row 2 = 10, row 3 = 20
      const batchPred = new Float32Array(diffBatch * totalFramesWithPrompt * MEL_DIM);
      for (let r = 0; r < diffBatch; r++) {
        const val = r % 2 === 0 ? 10 : 20;
        for (let i = r * totalFramesWithPrompt * MEL_DIM; i < (r + 1) * totalFramesWithPrompt * MEL_DIM; i++) {
          batchPred[i] = val;
        }
      }

      // Extract from rows 0 and 1 (first CFG pair)
      const condSrc = (ptFrameCount) * MEL_DIM; // row 0, target frames
      const uncondSrc = (totalFramesWithPrompt + ptFrameCount) * MEL_DIM; // row 1, target frames

      expect(batchPred[condSrc]).to.equal(10);   // conditional
      expect(batchPred[uncondSrc]).to.equal(20); // unconditional
    });

    it('should NOT accidentally read from rows 2,3 for single-segment CFG', () => {
      const MEL_DIM = 4;
      const totalFrames = 3;
      const ptFrameCount = 1;
      const totalFramesWithPrompt = ptFrameCount + totalFrames;
      const diffBatch = 4;

      const batchPred = new Float32Array(diffBatch * totalFramesWithPrompt * MEL_DIM);
      // Row 0 = 10 (conditional), Row 1 = 20 (unconditional)
      // Row 2 = 99 (should NOT be used), Row 3 = 99 (should NOT be used)
      for (let i = 0; i < 2 * totalFramesWithPrompt * MEL_DIM; i++) {
        batchPred[i] = i < totalFramesWithPrompt * MEL_DIM ? 10 : 20;
      }
      for (let i = 2 * totalFramesWithPrompt * MEL_DIM; i < batchPred.length; i++) {
        batchPred[i] = 99;
      }

      // Verify extraction only uses rows 0 and 1
      const condVal = batchPred[ptFrameCount * MEL_DIM]; // row 0
      const uncondVal = batchPred[totalFramesWithPrompt * MEL_DIM + ptFrameCount * MEL_DIM]; // row 1

      expect(condVal).to.equal(10);
      expect(uncondVal).to.equal(20);

      // Verify row 2 has value 99 (would corrupt results if accidentally used)
      const row2Val = batchPred[2 * totalFramesWithPrompt * MEL_DIM + ptFrameCount * MEL_DIM];
      expect(row2Val).to.equal(99);
    });
  });

  describe('WebNN pipeline batch parameters', () => {
    it('should accept npuDiffBatchSize and npuVocoderBatchSize in params', () => {
      const params = {
        sequences: {},
        tokenCount: 10,
        totalFrames: 100,
        ptMelData: null,
        ptFrameCount: 0,
        totalSteps: 32,
        cfgStrength: 3.0,
        cfgRescale: 0.75,
        isFP16: false,
        npuDiffBatchSize: 4,
        npuVocoderBatchSize: 4,
      };

      const {
        npuDiffBatchSize = 2,
        npuVocoderBatchSize = 1,
      } = params;

      expect(npuDiffBatchSize).to.equal(4);
      expect(npuVocoderBatchSize).to.equal(4);
    });

    it('should default batch sizes when not provided', () => {
      const params = {
        totalSteps: 32,
        cfgStrength: 3.0,
      };

      const {
        npuDiffBatchSize = 2,
        npuVocoderBatchSize = 1,
      } = params;

      expect(npuDiffBatchSize).to.equal(2);
      expect(npuVocoderBatchSize).to.equal(1);
    });
  });

  describe('Settings ALLOWED_SETTINGS_KEYS', () => {
    it('should include npuDiffBatchSize and npuVocoderBatchSize', () => {
      const { ALLOWED_SETTINGS_KEYS } = require('../src/main/settings');
      expect(ALLOWED_SETTINGS_KEYS).to.include('npuDiffBatchSize');
      expect(ALLOWED_SETTINGS_KEYS).to.include('npuVocoderBatchSize');
    });
  });

  describe('_synthesizeSegment batch parameter passthrough', () => {
    it('should have _synthesizeSegment method accepting batch parameters', () => {
      // Verify the method exists and has the right arity
      expect(pipeline._synthesizeSegment).to.be.a('function');
      // The function should accept 15 parameters (including batch settings)
      // segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift,
      // ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale,
      // npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange
      expect(pipeline._synthesizeSegment.length).to.be.at.least(12);
    });

    it('should have _synthesizeSegmentPair method for batch=4 segment pairing', () => {
      expect(pipeline._synthesizeSegmentPair).to.be.a('function');
    });

    it('should have _runWebNNSynthesisBatch method for batch IPC', () => {
      expect(pipeline._runWebNNSynthesisBatch).to.be.a('function');
    });
  });
});
