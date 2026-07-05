# CPU Algorithm Performance Fixes (B1-B9) — Implementation Plan

## Summary

Complete the remaining 6 CPU performance fixes (B7, B1, B3, B4, B5, B6) for the SXSEditor SVS pipeline. These are **pure performance optimizations** — they must NOT change output/behavior. After all edits, run `npm test` and fix any test failures caused by the changes.

Already completed (per prior session): B2 (ISTFT buffer reuse), B8 (audioSegmentation TypedArray.set), B9 (webnn/diffusion TypedArray.set).

---

## Current State Analysis

### B7 — `src/audio/wavEncoder.js` (PARTIALLY DONE)
- Trig LUT constants (`_cosLut`, `_sinLut`, `_trigLutScale`, `_PI4`) already added at lines 8-17.
- `applyEnvelopesToAudio` (lines 77-109) still uses `Math.cos((pan + 1) * 0.7853981633974483)` and `Math.sin((pan + 1) * 0.7853981633974483)` per sample (lines 100-101).
- Test (`test/wavEncoder.test.js`) uses `closeTo(x, 0.001)` tolerance for pan values -1, 0, 1. Angles are 0, π/4, π/2 — all exact multiples of 2π/1024, so 1024-entry LUT yields exact results at test points.

### B1 — `src/inference/pipeline/postprocessing.js` (NOT DONE)
- `createMelFilterbank` (lines 435-468) builds a dense `Float32Array(numBands * numFftBins)`. Each mel band has only ~2 nonzero triangles (~2*(fRight-fLeft) nonzero entries out of numFftBins=961). Sparsity ≈ 99.6%.
- `_cachedMelFilterbank` / `_cachedMelFilterbankSr` cache variables exist (lines 471-472).
- Dense triple loop in `extractMelSpectrogram` (lines 516-526) and `extractMelSpectrogramAsync` (lines 588-601): `for f → for m → for k: sum += powerSpec[f][k] * melFilterbank[m][k]`. Inner `for k` scans all 961 bins but only ~2-4 are nonzero per band.

### B3 — `src/inference/pipeline/postprocessing.js` (NOT DONE)
- `parseWavBuffer` (lines 69-143) uses `view.getFloat32(byteOffset, true)` / `view.getInt16(byteOffset, true)` per sample in a nested loop (lines 119-140).
- Fast paths needed for: 32-bit float mono/stereo (use `new Float32Array(buf.buffer, dataOffset, totalSamples)` view) and 16-bit PCM mono/stereo (use `new Int16Array(buf.buffer, dataOffset, totalSamples)` view + manual `/32768`).
- Tests (`test/postprocessingDSP.test.js`): 32-bit float mono (tolerance 1e-5), 16-bit PCM mono (tolerance 1e-3), stereo downmix.

### B4 — `src/inference/pipeline/diffusion.js` (NOT DONE)
- `runDiffusionLoop` (lines 131-270) has 3 passes when `cfgStrength > 0`:
  - Pass 1 (lines 192-202): compute CFG pred + write `cfgPredBuf` + accumulate `posSum`/`cfgAdjSum`
  - Pass 2 (lines 213-225): compute variance `posVarSum`/`cfgAdjVarSum` (requires means from Pass 1)
  - Pass 3 (lines 235-241): apply rescale + update `xt.data` (requires rescale from Pass 2)
  - Yield points: lines 208-210 (between Pass 1 and Pass 2), lines 231-233 (between Pass 2 and Pass 3)
- WebNN path (`src/inference/webnn/diffusion.js` lines 170-211) already uses 2 passes: Pass 1 = CFG+means, Pass 2 = variance+rescale+update (no yield between variance and update).
- **Goal**: merge pipeline Pass 2 + Pass 3 into one pass (variance loop → compute rescale → update loop, with no yield between them). This matches WebNN and preserves exact numerics (same computation order, just fewer yields).

### B5 — `src/inference/basicPitch.js` (NOT DONE)
- `outputToNotesPoly` (lines 175-299), specifically the `melodiaTrick` section (lines 240-297):
  - `while (globalMax(remainingEnergy) > inferredFrameThresh)` calls `globalMax` which scans entire 2D matrix each iteration (O(N*M)).
  - Inner loop (lines 245-253) scans entire matrix again to find the max position.
  - `remainingEnergy` is a 2D array of `frame.slice()` copies (regular arrays or Float32Array rows depending on B6).
- **Goal**: flatten `remainingEnergy` to 1D Float32Array, maintain per-column max array. Global max check becomes O(M), max-finding becomes O(N) (scan one column), zeroing updates 3 column maxes.
- `outputToNotesPoly` is NOT directly tested. Utility functions (`globalMax`, `meanStdDev`, `whereGreaterThanAxis1`) ARE tested but with regular 2D arrays — they must remain backward-compatible.

### B6 — `src/inference/basicPitch.js` (NOT DONE)
- `arraySync()` calls at lines 546-548 and 554-556 in `extractF0AndNotes`.
- `unwrapOutput` (line 601) reshapes to `[outputShape[0] * outputShape[1], outputShape[2]]`. After `dataSync()`, we get a flat Float32Array of length `rows * numCols` where `numCols = outputShape[2]`.
- Consumers (`outputToNotesPoly`, `getInferredOnsets`, `constrainFrequency`, `addPitchBendsToNoteEvents`, `argRelMax`, `whereGreaterThanAxis1`, `meanStdDev`, `globalMax`) all use `[r][c]` 2D indexing.
- **Key insight**: Utility functions use `for (const row of array) for (const v of row)` and `array[i][j]` — these work with Float32Array rows too. `getInferredOnsets` uses `zeroRows.concat(frames)` where `frames` is a regular Array — `concat` spreads the regular Array, adding each Float32Array row as an element. This works correctly.
- `extractF0AndNotes` is NOT directly tested (requires TF.js model). Utility functions are tested with regular arrays and must remain unchanged.

---

## Proposed Changes

### B7: Complete trig LUT in `applyEnvelopesToAudio`
**File**: `src/audio/wavEncoder.js`
**What**: Replace `Math.cos((pan + 1) * 0.7853981633974483)` and `Math.sin((pan + 1) * 0.7853981633974483)` with LUT lookups.
**How**:
- Compute angle: `const angle = (pan + 1) * _PI4;` (range [0, π/2] for pan ∈ [-1, 1])
- Lookup index: `const idx = (angle * _trigLutScale) | 0 & (_TRIG_LUT_SIZE - 1);` (bitmask wrap, fast floor)
- `const leftGain = _cosLut[idx];`
- `const rightGain = _sinLut[idx];`
- Keep all other logic identical.

### B1: Sparse mel filterbank (CSR) in `postprocessing.js`
**File**: `src/inference/pipeline/postprocessing.js`
**What**: Build CSR (Compressed Sparse Row) representation alongside the dense filterbank, then replace the dense inner `for k` loop with CSR iteration.
**How**:
1. Add new cache variables next to `_cachedMelFilterbank`:
   ```javascript
   let _cachedMelFilterbankCsr = null; // { rowPtr: Int32Array, colIdx: Int32Array, values: Float32Array }
   ```
2. Add a helper `buildMelFilterbankCsr(denseFb, numBands, numFftBins)` that iterates the dense filterbank and extracts nonzero entries into CSR arrays:
   - `rowPtr[m]` = start index in colIdx/values for band m (length numBands+1)
   - `colIdx[i]` = frequency bin index of the i-th nonzero entry
   - `values[i]` = filterbank weight at that bin
3. In `extractMelSpectrogram` / `extractMelSpectrogramAsync`, when building the cache, also build the CSR:
   ```javascript
   _cachedMelFilterbank = createMelFilterbank(...);
   _cachedMelFilterbankCsr = buildMelFilterbankCsr(_cachedMelFilterbank, melBands, numFreqBins);
   ```
4. Replace the dense triple loop:
   ```javascript
   // OLD:
   for (let m = 0; m < melBands; m++) {
     let sum = 0;
     const fbOffset = m * numFreqBins;
     for (let k = 0; k < numFreqBins; k++) {
       sum += powerSpec[specOffset + k] * melFilterbank[fbOffset + k];
     }
     melSpec[f * melBands + m] = Math.log(Math.max(sum, 1e-10));
   }
   // NEW:
   for (let m = 0; m < melBands; m++) {
     let sum = 0;
     const start = csr.rowPtr[m];
     const end = csr.rowPtr[m + 1];
     for (let i = start; i < end; i++) {
       sum += powerSpec[specOffset + csr.colIdx[i]] * csr.values[i];
     }
     melSpec[f * melBands + m] = Math.log(Math.max(sum, 1e-10));
   }
   ```
5. Numerics identical: same multiply-add operations, just skipping zeros.

### B3: `parseWavBuffer` typed array fast paths
**File**: `src/inference/pipeline/postprocessing.js`
**What**: Add fast paths for 32-bit float and 16-bit PCM using typed array views instead of per-sample DataView access.
**How**:
- After parsing fmt/data chunk headers (existing code up to line 116), add fast paths before the generic per-sample loop:
  ```javascript
  // Fast path: 32-bit float
  if (audioFormat === 3 && bitsPerSample === 32) {
    const view32 = new Float32Array(buf.buffer, buf.byteOffset + dataOffset, totalSamples);
    if (numChannels === 1) {
      // Direct copy (may need .slice() for independent buffer)
      return { data: view32.slice(), sampleRate };
    }
    // Stereo downmix
    const audioFloat = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
      audioFloat[f] = (view32[f * 2] + view32[f * 2 + 1]) / 2;
    }
    return { data: audioFloat, sampleRate };
  }
  // Fast path: 16-bit PCM
  if (audioFormat === 1 && bitsPerSample === 16) {
    const view16 = new Int16Array(buf.buffer, buf.byteOffset + dataOffset, totalSamples);
    const audioFloat = new Float32Array(numFrames);
    if (numChannels === 1) {
      for (let i = 0; i < numFrames; i++) {
        audioFloat[i] = view16[i] / 32768;
      }
    } else {
      for (let f = 0; f < numFrames; f++) {
        let sum = 0;
        for (let ch = 0; ch < numChannels; ch++) {
          sum += view16[f * numChannels + ch] / 32768;
        }
        audioFloat[f] = sum / numChannels;
      }
    }
    return { data: audioFloat, sampleRate };
  }
  ```
- Keep the existing generic loop for 24-bit and 32-bit int PCM (rare formats).
- Guard against `buf.byteOffset + dataOffset` not being aligned to element size — if not aligned, fall back to generic path. (In practice WAV data is 4-byte aligned, so this is safe.)
- Numerics identical: same conversion formula (`/32768` for 16-bit, direct float for 32-bit).

### B4: Pipeline CFG 3→2 pass merge
**File**: `src/inference/pipeline/diffusion.js`
**What**: Merge Pass 2 (variance) + Pass 3 (rescale + update) into one pass, removing the yield between them.
**How**:
- Keep Pass 1 (lines 192-204: CFG pred + means) unchanged.
- Keep the first yield (lines 208-210) — it separates Pass 1 (means) from Pass 2 (variance+update), matching WebNN.
- Merge Pass 2 + Pass 3:
  ```javascript
  // Remove the second yield (lines 231-233)
  // Combined Pass 2: variance → rescale → update (no yield between variance and update)
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
  for (let f = 0; f < totalFrames; f++) {
    for (let d = 0; d < MEL_DIM; d++) {
      const cfgVal = cfgPredBuf[f * MEL_DIM + d];
      const rescaledVal = cfgRescale * (cfgVal * rescale) + (1 - cfgRescale) * cfgVal;
      xt.data[f * MEL_DIM + d] += rescaledVal * dt;
    }
  }
  ```
- This is exactly the WebNN pattern (lines 195-211 of `webnn/diffusion.js`). Numerics identical — same operations in the same order, just no `setImmediate` yield between variance and update.

### B5: `outputToNotesPoly` melodiaTrick O(N²)→O(N+M)
**File**: `src/inference/basicPitch.js`
**What**: Optimize the melodiaTrick while-loop by flattening `remainingEnergy` to 1D Float32Array and maintaining a per-column max array.
**How**:
- **Before the melodiaTrick section** (after the first for-loop section at line 239), flatten `remainingEnergy`:
  ```javascript
  const nFreqBins = remainingEnergy[0].length;
  const flatEnergy = new Float32Array(nFrames * nFreqBins);
  for (let r = 0; r < nFrames; r++) {
    flatEnergy.set(remainingEnergy[r], r * nFreqBins);
  }
  // Per-column max array
  const colMax = new Float32Array(nFreqBins);
  for (let c = 0; c < nFreqBins; c++) {
    let cm = 0;
    for (let r = 0; r < nFrames; r++) {
      const v = flatEnergy[r * nFreqBins + c];
      if (v > cm) cm = v;
    }
    colMax[c] = cm;
  }
  ```
- **Replace the melodiaTrick while-loop**:
  ```javascript
  if (melodiaTrick === true) {
    // Helper: find global max from colMax (O(M))
    let colMaxMax = 0;
    for (let c = 0; c < nFreqBins; c++) {
      if (colMax[c] > colMaxMax) colMaxMax = colMax[c];
    }
    while (colMaxMax > inferredFrameThresh) {
      // Find column with max (O(M))
      let freqIdx = 0;
      for (let c = 1; c < nFreqBins; c++) {
        if (colMax[c] > colMax[freqIdx]) freqIdx = c;
      }
      // Find row with max in that column (O(N))
      let maxVal = -1;
      let iMid = 0;
      for (let r = 0; r < nFrames; r++) {
        const v = flatEnergy[r * nFreqBins + freqIdx];
        if (v > maxVal) {
          maxVal = v;
          iMid = r;
        }
      }
      // Zero out region (forward + backward), update colMax for 3 affected columns
      const affectedCols = [freqIdx - 1, freqIdx, freqIdx + 1];
      flatEnergy[iMid * nFreqBins + freqIdx] = 0;
      // ... forward pass (zero flatEnergy[i * nFreqBins + freqIdx ± {0,1}]) ...
      // ... backward pass ...
      // Recompute colMax for affected columns
      for (const c of affectedCols) {
        if (c < 0 || c >= nFreqBins) continue;
        let cm = 0;
        for (let r = 0; r < nFrames; r++) {
          const v = flatEnergy[r * nFreqBins + c];
          if (v > cm) cm = v;
        }
        colMax[c] = cm;
      }
      // Recompute colMaxMax
      colMaxMax = 0;
      for (let c = 0; c < nFreqBins; c++) {
        if (colMax[c] > colMaxMax) colMaxMax = colMax[c];
      }
      // ... build note event (same as before) ...
    }
  }
  ```
- **Numerics preservation**: The max-finding logic is identical — same values, same comparisons. The only difference is data layout (flat vs 2D). The zeroing logic is identical — same cells zeroed. Note event creation uses `frames[j][freqIdx]` (unchanged, still 2D access for the read-only `frames` array).
- The first (non-melodiaTrick) section remains unchanged — it's O(noteStarts * energyTolerance), not O(N²).

### B6: `basicPitch` `arraySync`→`dataSync`
**File**: `src/inference/basicPitch.js`
**What**: Replace `arraySync()` with `dataSync()` and convert the flat TypedArray to 2D array of Float32Array subarray views (O(rows), no per-element copy).
**How**:
- Add a helper method to `BasicPitchDetector`:
  ```javascript
  _tensorTo2DViews(tensor) {
    const flat = tensor.dataSync();
    const shape = tensor.shape;
    const numRows = shape[0];
    const numCols = shape[1];
    const rows = new Array(numRows);
    for (let r = 0; r < numRows; r++) {
      rows[r] = flat.subarray(r * numCols, (r + 1) * numCols);
    }
    return rows;
  }
  ```
- Replace the 6 `arraySync()` calls (lines 546-548, 554-556):
  ```javascript
  // OLD: allFrames.push(slicedFrames.arraySync());
  // NEW: allFrames.push(this._tensorTo2DViews(slicedFrames));
  ```
- **Compatibility verification**: All consumers use patterns that work with Float32Array rows:
  - `globalMax`, `meanStdDev`, `whereGreaterThanAxis1`, `argMaxAxis1`: use `for (const row of array)` or `array[i][j]` — work with Float32Array.
  - `constrainFrequency`: uses `array[i].fill(0, start)` — Float32Array.fill works.
  - `getInferredOnsets`: uses `zeroRows.concat(frames)` — `concat` on regular Array spreads elements, adding each Float32Array row. `row.map((v, c) => ...)` on Float32Array returns Float32Array. `min3dForAxis0`/`max3dForAxis0` use `array[0].map(v => v.slice())` — Float32Array.slice returns Float32Array copy. All indexing `[y][z]` works.
  - `addPitchBendsToNoteEvents`: uses `contours.slice(start, end).map(d => d.slice(...).map(...))` — works with Float32Array.
  - `outputToNotesPoly`: uses `frames.map(frame => frame.slice())` — Float32Array.slice returns Float32Array copy. All `[r][c]` indexing works.
  - `argRelMax`: uses `array[0].length`, `array[row][col]` — work with Float32Array.
- **Important**: `remainingEnergy = frames.map(frame => frame.slice())` creates independent Float32Array copies (not views), so modifying `remainingEnergy` doesn't affect `frames`. This is correct.
- The exported utility functions (`globalMax`, `meanStdDev`, etc.) remain unchanged — they still accept any 2D-array-like input. Tests pass regular arrays, which still work.

---

## Assumptions & Decisions

1. **B4 interpretation**: "merge Pass 1 + Pass 2" from the summary means merging pipeline Pass 2 (variance) + Pass 3 (rescale+update) into one pass, matching the WebNN 2-pass pattern (Pass 1 = CFG+means, Pass 2 = variance+rescale+update). This preserves exact numerics. Merging Pass 1+2 would require sum-of-squares variance formula which changes floating-point results.

2. **B5 scope**: Only optimize the `melodiaTrick` while-loop section. The first note-processing section (lines 207-239) is O(noteStarts × energyTolerance) and not a bottleneck. `frames` array (read-only in melodiaTrick) stays as 2D for `frameSum` access; only `remainingEnergy` is flattened.

3. **B6 approach**: Use Float32Array subarray views (not flat-array indexing refactor). This is because: (a) utility functions are exported and tested with 2D regular arrays — changing their signature would break tests; (b) Float32Array views give O(rows) conversion with zero per-element copy; (c) all consumers verified to work with Float32Array rows.

4. **B1 CSR building**: Build CSR at filterbank creation time (one-time cost). The dense filterbank is kept for `createMelFilterbank` export compatibility (tested in `postprocessingDSP.test.js`).

5. **B3 alignment guard**: Typed array views require `dataOffset` to be aligned to element size (4 bytes for Float32, 2 bytes for Int16). WAV spec mandates data chunk alignment, but add a safety check: if `dataOffset % bytesPerSample !== 0`, fall back to generic path.

6. **No git commit**: Per task instructions, git commit is handled by the main agent.

---

## Verification Steps

1. Run `npm test` in project root (PowerShell):
   ```powershell
   npm test
   ```
2. Expected affected test files:
   - `test/wavEncoder.test.js` — B7 (applyEnvelopesToAudio trig LUT)
   - `test/postprocessingDSP.test.js` — B1 (createMelFilterbank export), B3 (parseWavBuffer)
   - `test/basicPitch.test.js` — B6 (utility functions, should still pass)
   - Other tests should be unaffected.
3. If any test fails:
   - Check if it's a numerics issue (B7 LUT precision, B1 CSR correctness, B3 view alignment)
   - Check if it's a type issue (B6 Float32Array vs regular Array compatibility)
   - Fix the specific failure without changing the optimization approach
4. All 32 test files should pass (per prior session: 96 tests in nativeSvsPipeline alone).

## Implementation Order

1. B7 (smallest, LUT already added) → verify wavEncoder tests
2. B3 (parseWavBuffer fast paths) → verify postprocessingDSP tests
3. B1 (CSR filterbank) → verify postprocessingDSP tests
4. B4 (CFG pass merge) → verify no diffusion test breakage
5. B6 (arraySync→dataSync) → verify basicPitch tests
6. B5 (melodiaTrick optimization) → verify basicPitch tests
7. Final `npm test` run
