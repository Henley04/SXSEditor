# GPU/NPU Performance Fixes — Verification Plan

## Summary

This plan documents the verification of 5 GPU/NPU performance fixes (D1–D5) for the Electron SVS app. Based on Phase 1 exploration, **all 5 fixes are already implemented in the codebase**. The only remaining step is to run `npm test` to confirm the test suite still passes.

## Current State Analysis (Phase 1 Exploration)

All 5 fixes were verified present in the codebase via Read/Grep:

### D1 — NPU Performance Gating (`src/inference/webnn/npuDetection.js`) ✅
- `_detectionCache` module-level cache (line 8)
- Constants: `BENCH_DIM=8`, `BENCH_RUNS=5`, `NPU_SLOW_THRESHOLD=1.5` (lines 11-13)
- `benchmarkDevice(deviceType)` function using WebNN `MLGraphBuilder` matmul (lines 20-62)
- `detectNPU()` returns early from cache (line 70), runs parallel NPU+CPU benchmarks (lines 121-124)
- Sets `npuSlow=true` + `npuAvailable=false` when NPU > 1.5× CPU (lines 135-139)
- Exposes `npuInferenceMs` / `cpuInferenceMs` / `npuSlow` fields (lines 126-127, 136)

### D2 — classifyDevice Deduplication ✅
- `src/utils/deviceClassifier.js` created with unified `classifyDevice(name, vramBytes, dmlDiscreteFlag)` (lines 8-57)
  - Logic: NPU keywords → discrete GPU keywords → Intel Arc → integrated GPU keywords → Radeon/MS Basic fallback → DML discrete flag → VRAM ≥512MB threshold → CPU
- `src/utils/gpuWorker.js` imports from `./deviceClassifier` (line 2)
- `src/main/gpuInfo.js` imports + backward-compatible `classifyDeviceFromName = classifyDevice` alias (lines 4, 7)
- `src/inference/pipeline/modelLoader.js` imports from `../../utils/deviceClassifier` (line 6); `isDiscreteGPUByName` deprecated wrapper delegates to `classifyDevice` (lines 98-104)

### D3 — NPU Failure Retry with TTL Cache ✅
- `src/main/webnnIpc.js`:
  - `_npuFailureTime` + `NPU_FAILURE_TTL_MS = 5 * 60 * 1000` (lines 11-12)
  - `_isFailureCacheExpired()` applies TTL only to failure results where both `npuAvailable` and `gpuAvailable` are false (lines 17-24)
  - `webnn:detectNPU` handler checks TTL and clears cache if expired (lines 28-34)
  - `detectNPUAvailability()` clears cache if expired, sets `_npuFailureTime` on failures (lines 195-198, 232-236, 246)
  - `markNPUUnavailable()` sets `_npuFailureTime` (line 262)
  - `clearNPUFailureCache()` export resets both cache and failure time (lines 269-272)
- `src/main/svsIpc.js` calls `clearNPUFailureCache()` after `pipeline.swapLanguageModels(language)` (lines 81-85)

### D4 — NPU Static Shape Truncation Warning ✅
- `src/inference/webnn/index.js`:
  - `const warnings = [];` after `vocoderFloatType` declaration (line 61)
  - Push on truncation: `NPU_STATIC_SHAPE_TRUNCATION: audio truncated from ${totalFrames} to ${maxFrames} frames` (line 68)
  - Both return statements include `warnings`: skipVocoder path (line 109), full path (line 135)
- `src/inference/pipeline/index.js`:
  - `_synthesizeSegment` forwards warnings via `console.warn` (lines 1393-1396)
  - `_synthesizeSegmentPair` forwards warnings from batch results (lines 1499-1504)

### D5 — Model Warmup ✅
- `src/inference/pipeline/modelLoader.js` `createSessionWithValidation` returns `warmedUp` in all 5 paths:
  - `warmedUp: false` — no dummy inputs path (line 428)
  - `warmedUp: false` — NPU static shapes, skipped validation (line 440)
  - `warmedUp: true` — DML verified (line 456)
  - `warmedUp: true` — DML-optimized fallback verified (line 485)
  - `warmedUp: true` — CPU verified (line 500)
- `src/inference/webnn/sessionManager.js`:
  - `sessions.set` includes `warmedUp: false` field (line 151)
  - Fire-and-forget `_warmupSession(modelId).catch(() => {})` after successful load (line 155)
  - `_warmupSession(modelId)` function (lines 175-210):
    - Reads `session.inputMetadata` to build minimal input tensors
    - Replaces symbolic/non-positive dims with 1
    - Constructs proper TypedArray by type (int64/float16/float32)
    - Wraps `session.run(feeds)` in `withRunLock` for WASM stack safety
    - Sets `entry.warmedUp = true` on success
    - Best-effort: catches and logs errors without failing

## Proposed Changes

**No code changes are needed.** All 5 fixes (D1–D5) are fully implemented per spec and verified present in the codebase.

## Assumptions & Decisions

- **Assumption**: The summary's claim that `npm test` passed with 1038 tests was accurate at the time, but the test suite should be re-run to confirm the current state of the codebase still passes.
- **Decision**: Since all code is in place, the only remaining action is verification via `npm test`. If any tests fail, investigate and fix the root cause. If all pass, the task is complete.
- **Note**: The user explicitly stated "Git commit is NOT needed — the main agent will handle that," so no commit will be made.

## Verification Steps

1. Run `npm test` in the project root (`d:\Document\electron\SXSEditor`) using PowerShell
2. Confirm exit code 0 and all tests passing
3. If any failures occur:
   - Read the failing test file(s) and related source
   - Identify whether the failure is caused by the D1–D5 changes
   - Apply the minimal fix needed
   - Re-run `npm test` until green
4. Report final status to the parent agent
