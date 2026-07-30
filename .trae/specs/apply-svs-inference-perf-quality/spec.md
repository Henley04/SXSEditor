# SVS 推理性能与音质优化 Spec

## Why

歌声合成（SVS）管线当前在默认 DML 路径下存在多处可量化的性能损失与音质短板：cond/uncond 串行调用导致 diffusion 慢一倍、诊断日志无 gating、`releaseDiffStepBeforeVocoder` 默认开启对多段合成造成 1-3s/段的时间税、vocoder overlap 过小产生边界伪影、Hann OLA 在有音高信号上产生 flanging、CFG 强度为常量无法适应早期/后期不同需求等。本 spec 落地审查报告（修订版）中所有 inference-only、零训练的优化项，预期总体 2-3× 加速 + 音质提升，且不删除任何已有可调设置。

## What Changes

### 性能（P0）
- **DML 路径 cond/uncond batch 合并**：将 `pipeline/diffusion.js` 的 `evalDiffStep` 由"先 cond 再 unconf 两次 `session.run`"改为单次 `[2, seq, ...]` 批量调用，对齐 `webnn/diffusion.js` 已有实现。预期 diffusion ~2× 加速。
- **诊断日志 gating**：新增 `diagnosticMode` 设置（默认 false），将 `[DiffusionDiag]` 与 `[VocoderDiag]` 的统计/采样日志收敛到该开关后；NaN/Inf 致命错误（`console.error`）保留 always-on。
- **`releaseDiffStepBeforeVocoder` 默认改 false**：仅在 vocoder 推理捕获到 `isVramOOMError` 后动态启用一次（next segment 起），并在该 segment 完成后恢复 false。
- **默认采样器 Euler → STORK-2**：`DEFAULT_SOLVER` 改为 `stork2`。保留 Euler/Heun/Extrap 选项不删除（用户明确要求）。

### 性能（P1）
- **`VOCODER_OVERLAP_FRAMES` 8 → 32**：提到 32 帧（≥30 帧感受野），同时新增 `vocoderOverlapFrames` 设置允许用户调整，默认 32。
- **每步 xt/t 张量预分配复用**：`pipeline/diffusion.js` 的 `_runDiffStepWithCachedTensors` 预分配 `xtTensor`/`tTensor` 一次，每步只写 `.data`，对齐 WebNN 路径。
- **CFG combine 三趟 → 单趟 Welford 在线方差**：合并 pass1（cfgVal+sum）+ pass2（two-pass 方差）+ pass3（rescale）为单次遍历，使用 Welford 在线算法计算均值/方差。
- **自适应 gpuDrain**：正常情况跳过 `gpuDrain`；捕获 OOM 后下一次 drain 延长（200ms），连续正常后恢复。

### 音质（P1）
- **WSOLA 替换 Hann OLA**：vocoder 分块交叉淡入淡出（`postprocessing.js`）与 diffusion 分块（`diffusion.js`）两处，新增 WSOLA 实现（基于互相关搜索对齐），消除有音高信号的 flanging/梳状滤波。
- **EBU R128 loudnorm + true-peak −1 dBTP**：末端加 2-pass 响度归一化（−14 LUFS）+ true-peak 限制器（−1 dBTP），走纯 JS `libebur128` 等价实现（避免 FFmpeg 子进程依赖）。
- **CFG 强度曲线**：新增 `cfgScheduleMode`（`'constant' | 'linear' | 'cosine' | 'custom'`，默认 `'linear'`）+ `cfgStrengthStart`（默认 `cfgStrength * 0.5`）+ `cfgScheduleKeyframes`（custom 模式）。默认低→高线性调度（早期低引导减少过曝光，后期高引导锁定条件），来自 A-CFG / dynamic CFG 论文建议。允许用户切换为 `'constant'` 保留旧行为。
- **CFG rescale 范围校验**：默认 `CFG_RESCALE` 0.75 → 0.6（落入 SVS 甜区 0.5-0.7）；UI 加范围保护与超界警告，但允许用户强制设为任意值。

### 音质（P2）
- **SiFiGAN F0 4× 最近邻 → 线性插值**：`postprocessing.js` 中 F0 上采样改线性插值，消除 F0 阶跃处的激励畸变。
- **refHash FNV-1a 全长采样**：`audioSegmentation.js` 参考音频缓存键从"前 4000 字节"改为 FNV-1a 全长（用 `hashArray` 已有函数），消除长音频碰撞。
- **分块 diffusion 边界 F0 感知**：`diffusion.js` `_planChunks` 在可选 F0 输入下避开 F0 斜率突变处切分（RDSinger arXiv:2410.21641 启发）。
- **2× 过采样→LP→降采样抗混叠**（CPU 路径，`resampleLinear`）：在降采样前加 LP 滤波，新增 `enableAntiAliasing` 设置（默认 false，避免改变默认输出特征）。
- **SDEdit 局部修复**（可选，默认 false）：新增 `enableSDEditRepair` 设置，检测 diffusion 输出 mel 局部 NaN/能量突变后用浅噪声重噪 + 少步重采样修复。

### 设置/UI
- 新增设置键：`diagnosticMode`、`cfgScheduleMode`、`cfgStrengthStart`、`cfgScheduleKeyframes`、`vocoderOverlapFrames`、`enableAntiAliasing`、`enableSDEditRepair`。
- 默认值变更：`releaseDiffStepBeforeVocoder` true → false；`exportSampler`/`previewSampler` 默认 `'euler'` → `'stork2'`；`exportCfgRescale`/`previewCfgRescale` 0.75 → 0.6；`VOCODER_OVERLAP_FRAMES` 常量 8 → 32。
- 不删除任何已有可调项；UI 新增 CFG 调度曲线编辑器、诊断模式开关、vocoder overlap 调节。

### 不实施（附理由）
- **Vocoder INT8 量化**：用户明确跳过。
- **FCPE 替换 RMVPE**：用户明确跳过，保留 RMVPE。
- **T-GATE 跨注意力缓存**：需对 diffStep ONNX 做图手术（拆分 K/V producer 子图），属模型再导出范畴，超出 inference-only 边界；本 spec 不实施，留待后续模型再导出专项。
- **RMVPE argmax ONNX ArgMax 节点**：同样需模型再导出，跳过。
- **DPM-Solver++ / UniPC 采样器**：当前 diffStep 是 flow matching（线性 ODE），DPM 系列依赖半线性结构不适用（见审查报告修订点 1）；不新增。

## Impact

- **Affected specs**: 无既有 spec 直接关联（本仓库 `.trae/specs` 下的既有 spec 均为独立功能）。
- **Affected code**:
  - `src/inference/pipeline/diffusion.js`（batch 合并、张量复用、Welford、CFG 调度、WSOLA、F0 感知分块、诊断 gating、自适应 gpuDrain）
  - `src/inference/pipeline/postprocessing.js`（WSOLA、loudnorm、SiFiGAN F0 线性、抗混叠、诊断 gating、vocoder overlap）
  - `src/inference/pipeline/samplers/index.js`（`DEFAULT_SOLVER` 改 `stork2`）
  - `src/inference/pipeline/constants.js`（`CFG_RESCALE` 0.75 → 0.6）
  - `src/inference/shared/constants.js`（`VOCODER_OVERLAP_FRAMES` 8 → 32）
  - `src/inference/pipeline/index.js`（CFG 调度读取、`releaseDiffStep` OOM 动态启用、F0 传入 `_planChunks`）
  - `src/inference/pipeline/audioSegmentation.js`（refHash FNV-1a 全长）
  - `src/inference/pipeline/preprocessing.js`（三段双重循环合并为单趟，可选优化）
  - `src/inference/pipeline/utils.js`（自适应 `gpuDrain`、新增 WSOLA/loudnorm 工具函数）
  - `src/main/settings.js`（新增设置键 + 默认值变更 + ALLOWED_SETTINGS_KEYS 扩展）
  - `src/renderer/exportDialog.js`（CFG 调度 UI、诊断开关、vocoder overlap、范围校验）
  - `src/renderer/audioPlayback.js`（透传新设置到 inference opts）
  - `src/i18n/zh-CN.js` + `src/i18n/en.js`（新 i18n key）
  - 新建 `src/inference/pipeline/wsola.js`（WSOLA 实现）
  - 新建 `src/inference/pipeline/loudnorm.js`（EBU R128 + true-peak limiter）
  - 新建 `src/inference/pipeline/cfgSchedule.js`（CFG 调度曲线求值）
  - 新建 `test/cfgSchedule.test.js`、`test/wsola.test.js`、`test/loudnorm.test.js`、`test/diffusionBatchMerge.test.js`

## ADDED Requirements

### Requirement: DML cond/uncond batch 合并
The system SHALL execute cond and uncond diffStep inference as a single `[2, seq, MEL_DIM]` batched `session.run` call on the DML path, producing identical numerical output to the prior two-call sequence (within FP16 epsilon).

#### Scenario: CFG enabled
- **WHEN** `cfgStrength > 0` and inference provider is `ortnode` (DML)
- **THEN** `evalDiffStep` issues exactly 1 `session.run` per diffusion step (was 2)
- **AND** the `flow_pred` output is split into cond (row 0, target slice) and uncond (row 1, target slice) for the CFG combine step

#### Scenario: CFG disabled
- **WHEN** `cfgStrength <= 0`
- **THEN** `evalDiffStep` issues 1 `session.run` with batch=1 (cond only), uncond skipped

### Requirement: 诊断日志 gating
The system SHALL gate all `[DiffusionDiag]` and `[VocoderDiag]` statistical/sampling `console.log` behind a `diagnosticMode` setting (default `false`). Fatal NaN/Inf `console.error` SHALL remain always-on.

#### Scenario: diagnosticMode off (default)
- **WHEN** `diagnosticMode === false`
- **THEN** no `[DiffusionDiag]` / `[VocoderDiag]` statistical logs are emitted
- **AND** NaN/Inf fatal errors still emit `console.error`

### Requirement: releaseDiffStepBeforeVocoder 动态启用
The system SHALL default `releaseDiffStepBeforeVocoder` to `false`. On vocoder inference throwing an `isVramOOMError`, the system SHALL enable release for the next segment only, then reset to the user-configured value.

#### Scenario: No OOM
- **WHEN** vocoder inference succeeds
- **THEN** diffStep session is NOT released before vocoder
- **AND** no reload overhead (~1-3s) is incurred

#### Scenario: OOM triggers dynamic enable
- **WHEN** vocoder throws `isVramOOMError` and user setting is `false`
- **THEN** next segment's vocoder call releases diffStep first
- **AND** after that segment completes, behavior reverts to user setting

### Requirement: 默认采样器 STORK-2
The system SHALL default the sampler to `stork2` for both preview and export paths. Existing `euler`, `heun`, `extrap` options SHALL remain available.

#### Scenario: New user / fresh settings
- **WHEN** settings.json has no `exportSampler` / `previewSampler` key
- **THEN** resolved sampler is `stork2`

#### Scenario: Existing user with `euler`
- **WHEN** settings.json has `exportSampler: 'euler'`
- **THEN** resolved sampler is `euler` (user choice preserved)

### Requirement: CFG 强度曲线调度
The system SHALL support CFG strength scheduling across diffusion steps with modes `constant | linear | cosine | custom`. Default mode SHALL be `linear` with `cfgStrengthStart = cfgStrength * 0.5` (low→high, per A-CFG / dynamic CFG literature).

#### Scenario: linear mode (default)
- **WHEN** `cfgScheduleMode === 'linear'` and `cfgStrengthStart < cfgStrength`
- **THEN** at step `s` of `N`, effective cfg = `cfgStrengthStart + (cfgStrength - cfgStrengthStart) * (s / (N-1))`

#### Scenario: constant mode (legacy)
- **WHEN** `cfgScheduleMode === 'constant'`
- **THEN** effective cfg = `cfgStrength` for all steps (identical to pre-change behavior)

#### Scenario: custom mode
- **WHEN** `cfgScheduleMode === 'custom'` and `cfgScheduleKeyframes` provided
- **THEN** effective cfg is piecewise-linear interpolated from keyframes

### Requirement: WSOLA 分块交叉淡入淡出
The system SHALL use WSOLA (Waveform Similarity Overlap-Add) for vocoder chunk and diffusion chunk crossfades, replacing symmetric Hann OLA, to eliminate flanging/comb filtering on pitched signals.

#### Scenario: Vocoder multi-chunk
- **WHEN** `effectiveTotalFrames > chunkSize` (multi-chunk vocoder path)
- **THEN** chunk overlap region uses WSOLA with cross-correlation search (search window ≤ 4ms) instead of Hann OLA

#### Scenario: Diffusion chunked path
- **WHEN** `runDiffusionLoopChunked` is invoked
- **THEN** chunk overlap region in mel domain uses WSOLA-style alignment

### Requirement: EBU R128 loudnorm + true-peak 限制
The system SHALL apply 2-pass EBU R128 loudness normalization (−14 LUFS target) and true-peak limiting (−1 dBTP) to the final audio output before WAV encoding, gated by a `enableLoudnormFinal` setting (default `true`).

#### Scenario: Default export
- **WHEN** `enableLoudnormFinal === true` (default)
- **THEN** final output is normalized to −14 LUFS ±0.5 and peak-limited to −1 dBTP

#### Scenario: Disabled
- **WHEN** `enableLoudnormFinal === false`
- **THEN** only existing `normalizePeakTo(0.95)` is applied (legacy behavior)

### Requirement: Vocoder overlap frames 可调
The system SHALL expose `vocoderOverlapFrames` as a user-adjustable setting (default 32, range 8-96) replacing the hardcoded `VOCODER_OVERLAP_FRAMES = 8` constant.

#### Scenario: Default
- **WHEN** settings has no `vocoderOverlapFrames`
- **THEN** effective overlap = 32 frames

### Requirement: CFG rescale 范围校验
The system SHALL default `CFG_RESCALE` to 0.6 (was 0.75) and warn the user in the UI when cfgRescale is outside [0.5, 0.7], while still allowing the value.

#### Scenario: Out-of-range warning
- **WHEN** user sets cfgRescale to 0.9 in export dialog
- **THEN** UI shows a warning hint but allows the value
- **AND** synthesis proceeds with 0.9

### Requirement: SiFiGAN F0 线性插值上采样
The system SHALL use linear interpolation (instead of nearest-neighbor) when 4× upsampling F0 for SiFiGAN vocoder input.

#### Scenario: SiFiGAN path
- **WHEN** `vocoderType === 'sifigan'`
- **THEN** F0 is upsampled 4× via linear interpolation, not nearest-neighbor

### Requirement: refHash FNV-1a 全长
The system SHALL compute the reference audio cache key using FNV-1a over the full buffer length (via existing `hashArray`), replacing the 4000-byte prefix scan.

#### Scenario: Long reference audio
- **WHEN** two different 60s reference audios share the first 4000 bytes (unlikely but possible)
- **THEN** cache keys differ (no false hit)

### Requirement: 自适应 gpuDrain
The system SHALL skip `gpuDrain` (50ms wait) when no recent OOM has occurred, and extend it to 200ms for one cycle after an OOM is caught.

#### Scenario: Normal operation
- **WHEN** no OOM in current synthesis
- **THEN** inter-chunk `gpuDrain` calls are replaced with `setImmediate` yields

#### Scenario: Post-OOM
- **WHEN** an OOM was caught in the current or previous chunk
- **THEN** next `gpuDrain` waits 200ms, then reverts to skip mode

## MODIFIED Requirements

### Requirement: 默认推理参数
Default values updated:
- `releaseDiffStepBeforeVocoder`: `true` → `false`
- `exportSampler` / `previewSampler`: `'euler'` → `'stork2'`
- `exportCfgRescale` / `previewCfgRescale`: `0.75` → `0.6`
- `VOCODER_OVERLAP_FRAMES` (constant): `8` → `32`
- `CFG_RESCALE` (constant): `0.75` → `0.6`
- New `cfgScheduleMode` default `'linear'` (was implicitly constant)

All existing adjustable items remain adjustable; no setting key is removed.

## REMOVED Requirements

(none — no setting keys or UI controls are removed)
