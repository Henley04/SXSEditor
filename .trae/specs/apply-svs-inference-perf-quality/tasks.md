# Tasks

## P0 — 性能关键路径

- [ ] Task 1: DML 路径 cond/uncond batch 合并
  - [ ] 1.1 在 `src/inference/pipeline/diffusion.js` 的 `runDiffusionLoop` 内构造 `cfgBatchBuf`/`cfgCondBuf`/`cfgMaskBuf`，将 cond（含 prompt）与 uncond（target-only）拼成 `[2, seqLen, MEL_DIM]` 单次 `sessions.diffStep.run` 调用，对齐 `src/inference/webnn/diffusion.js` 第 60-101 行的实现。
  - [ ] 1.2 拆分 `flow_pred` 输出为 cond target 段与 uncond target 段，传给现有 `combine`。无 CFG 时走 batch=1 路径。
  - [ ] 1.3 同步改造 `_runDiffStepWithCachedTensors`：增加 batch 维度参数；保留 useStaticShapes（NPU）路径不变（NPU 走 `npuDiffBatchSize`，本任务只对齐 DML）。
  - [ ] 1.4 验证：`test/diffusionChunked.test.js` 与新增 `test/diffusionBatchMerge.test.js` 通过；输出数值与改造前在 FP16 epsilon 内一致（用固定 seed 噪声对比）。

- [ ] Task 2: 诊断日志 gating
  - [ ] 2.1 在 `src/main/settings.js` `loadSettings` 加 `diagnosticMode` 默认 `false`；加入 `ALLOWED_SETTINGS_KEYS`。
  - [ ] 2.2 在 `src/inference/pipeline/diffusion.js` 与 `src/inference/pipeline/postprocessing.js` 顶部读取 `diagnosticMode`（通过参数透传或模块级 lazy 读取），把所有 `[DiffusionDiag]` / `[VocoderDiag]` 的 `console.log` 统计/采样块包到 `if (diagnosticMode) { ... }` 内。
  - [ ] 2.3 保留所有 `console.error` 的 NaN/Inf 致命错误为 always-on。
  - [ ] 2.4 验证：默认模式下 `npm test` 不输出诊断日志（捕获 stdout 检查）；`diagnosticMode=true` 时日志恢复。

- [ ] Task 3: releaseDiffStepBeforeVocoder 默认 false + OOM 动态启用
  - [ ] 3.1 在 `src/main/settings.js` 将 `releaseDiffStepBeforeVocoder` 默认值从 `true` 改为 `false`。
  - [ ] 3.2 在 `src/inference/pipeline/index.js` 的 `_runVocoderChunked`（约 1619 行）外层加 OOM 捕获：若 `isVramOOMError(err)` 且当前未启用 release，则置 `_dynamicReleaseDiffStepNextSegment = true` 并重试该 segment（释放 diffStep → vocoder → 重载）。
  - [ ] 3.3 `_maybeUnloadDiffStepBeforeVocoder` 读取 `_dynamicReleaseDiffStepNextSegment || settings.releaseDiffStepBeforeVocoder`；segment 完成后清除动态标志。
  - [ ] 3.4 验证：单元测试模拟 OOM，断言下一次调用 release，再下一次恢复。

- [ ] Task 4: 默认采样器 Euler → STORK-2
  - [ ] 4.1 在 `src/inference/pipeline/samplers/index.js` 将 `DEFAULT_SOLVER` 从 `'euler'` 改为 `'stork2'`。
  - [ ] 4.2 在 `src/renderer/audioPlayback.js` `getPreviewInferenceOptions` 与 `getExportInferenceOptions` 默认值从 `'euler'` 改为 `'stork2'`（仅当 settings 缺失时生效）。
  - [ ] 4.3 保留 `euler`/`heun`/`extrap`/`stork2` 在 export dialog 下拉中不删除。
  - [ ] 4.4 验证：`test/samplers.test.js` 全部通过；新用户首启 sampler 解析为 `stork2`。

## P1 — 性能与音质

- [ ] Task 5: VOCODER_OVERLAP_FRAMES 8 → 32 + 可调
  - [ ] 5.1 在 `src/inference/shared/constants.js` 将 `VOCODER_OVERLAP_FRAMES` 从 `8` 改为 `32`。
  - [ ] 5.2 在 `src/main/settings.js` 加 `vocoderOverlapFrames` 设置（默认 32，范围 8-96），加入 `ALLOWED_SETTINGS_KEYS`。
  - [ ] 5.3 `runVocoderChunked` 接受 `overlapFramesOverride` 参数（从 `pipeline/index.js` 透传 settings 值），缺失时回退到常量 32。
  - [ ] 5.4 验证：`test/vocoderChunked.test.js` 通过；多 chunk 路径 overlap=32 不再产生边界伪影（用正弦波 + 频谱检验无突变）。

- [ ] Task 6: 每步 xt/t 张量预分配复用
  - [ ] 6.1 在 `src/inference/pipeline/diffusion.js` `runDiffusionLoop` 循环外预分配 `xtTensor`/`tTensor`（FP16 用 `Uint16Array`，FP32 用 `Float32Array`），每步只写 `.data`，对齐 `src/inference/webnn/diffusion.js` 第 87-114 行。
  - [ ] 6.2 `_runDiffStepWithCachedTensors` 改为接受预分配张量参数；循环结束统一 dispose。
  - [ ] 6.3 验证：单步张量分配计数为 0（用 `ort.Tensor` 构造函数 spy 验证）；输出不变。

- [ ] Task 7: CFG combine 三趟 → 单趟 Welford
  - [ ] 7.1 在 `src/inference/pipeline/diffusion.js` 的 `combine` 函数内，将 pass1（cfgVal+sum）+ pass2（two-pass 方差）+ pass3（rescale）合并为单次遍历，使用 Welford 在线算法计算 cfgAdjMean/cfgAdjM2，posMean/posM2 同理。
  - [ ] 7.2 同步改造 `src/inference/webnn/diffusion.js` 的 `combineRaw`（保持两路径一致）。
  - [ ] 7.3 第二趟小循环用 Welford 最终值计算 std 与 rescale，第三趟写入 vBuf（与原数值在 1e-7 内一致）。
  - [ ] 7.4 验证：新增 `test/cfgCombineWelford.test.js`，对比 Welford 与 two-pass 在随机数据上的 std/rescale 数值一致性。

- [ ] Task 8: 自适应 gpuDrain
  - [ ] 8.1 在 `src/inference/pipeline/utils.js` 加 `gpuDrainAdaptive()` 函数：模块级 `_oomFlag` 标志，正常时 `setImmediate` yield，OOM 后下次 drain 等 200ms 然后清标志。
  - [ ] 8.2 加 `markGpuOom()` 函数供 OOM catch 调用。
  - [ ] 8.3 替换 `diffusion.js` 与 `postprocessing.js` 中的 `gpuDrain()` 调用为 `gpuDrainAdaptive()`；保留 `gpuDrainLong()` 不变（diffStep 释放后仍需长排空）。
  - [ ] 8.4 验证：正常路径无 50ms 等待（用 perf.now 断言 < 5ms）；模拟 OOM 后下次 drain > 150ms。

- [ ] Task 9: WSOLA 分块交叉淡入淡出
  - [ ] 9.1 新建 `src/inference/pipeline/wsola.js`：实现 `wsolaCrossfade(prevTail, currHead, overlapSamples, sampleRate, searchWindowMs=4)`，基于归一化互相关搜索最佳对齐 + Hann 加权 OLA。导出 `wsolaCrossfade` 与 `wsolaCrossfadeMel`（mel 域版本，按帧搜索）。
  - [ ] 9.2 在 `src/inference/pipeline/postprocessing.js` 的多 chunk 路径（约 1156-1173 行）替换 Hann OLA 为 WSOLA：保留 `prevChunkTail`（overlapSamples 长度），与当前 chunk 头做 WSOLA 对齐后加权写入。
  - [ ] 9.3 在 `src/inference/pipeline/diffusion.js` 的 `_runSingleDiffusionChunk`（约 505-530 行）替换 mel 域 Hann 加权为 `wsolaCrossfadeMel`。
  - [ ] 9.4 验证：新增 `test/wsola.test.js`，正弦波 chunk 边界无相位跳变（频谱无旁瓣）；现有 `test/vocoderChunked.test.js` + `test/diffusionChunked.test.js` 通过。

- [ ] Task 10: EBU R128 loudnorm + true-peak 限制
  - [ ] 10.1 新建 `src/inference/pipeline/loudnorm.js`：实现 `loudnormFinal(samples, sampleRate, targetLufs=-14, maxTruePeak=-1.0)` —— 纯 JS EBU R128 2-pass（K-weighting + gating block），返回归一化后 Float32Array；true-peak 限制器用 4× 过采样采样峰值检测 + 软限制。
  - [ ] 10.2 在 `src/inference/pipeline/postprocessing.js` 的 `runVocoderChunked` 末端（`normalizePeakTo(output)` 之后）调用 `loudnormFinal`，受 `enableLoudnormFinal` 设置控制（默认 true）。
  - [ ] 10.3 单 chunk 路径同样应用（单 chunk 末端 `normalizePeakTo(output)` 之后）。
  - [ ] 10.4 验证：新增 `test/loudnorm.test.js`，正弦波输入归一化到 −14 LUFS ±0.5；峰值 ≤ −1 dBTP。

- [ ] Task 11: CFG 强度曲线调度
  - [ ] 11.1 新建 `src/inference/pipeline/cfgSchedule.js`：导出 `resolveCfgAtStep({mode, cfgStrength, cfgStrengthStart, cfgStrengthEnd, keyframes, step, totalSteps})` 返回当前步有效 cfg 值。支持 `constant | linear | cosine | custom` 四种模式。`linear`: `start + (end - start) * step / (totalSteps - 1)`；`cosine`: `start + (end - start) * (1 - cos(π * step / (totalSteps - 1))) / 2`；`custom`: keyframes 分段线性插值。
  - [ ] 11.2 在 `src/main/settings.js` 加 `cfgScheduleMode`（默认 `'linear'`）、`cfgStrengthStart`（默认 null，回退到 `cfgStrength * 0.5`）、`cfgScheduleKeyframes`（默认 null）、`enableLoudnormFinal`（默认 true），加入 `ALLOWED_SETTINGS_KEYS`。同时为 `preview*` 与 `export*` 加镜像键：`previewCfgScheduleMode`/`previewCfgStrengthStart`/`exportCfgScheduleMode`/`exportCfgStrengthStart`/`exportCfgScheduleKeyframes`/`previewCfgScheduleKeyframes`。
  - [ ] 11.3 在 `src/inference/pipeline/diffusion.js` `runDiffusionLoop` 内，`combine` 函数从闭包读取固定 `cfgStrength` 改为按 `step` 调用 `resolveCfgAtStep`。`combine` 接收 `step` 参数（修改 sampler.step 调用约定，把 `step` 透传到 combine）。
  - [ ] 11.4 在 `src/renderer/audioPlayback.js` 的 `getPreviewInferenceOptions` / `getExportInferenceOptions` 透传 schedule 参数到 opts。
  - [ ] 11.5 在 `src/inference/pipeline/index.js` `_synthesizeImpl` 与 `synthesizeMultiStreaming` 读取 schedule opts 并透传到 `_runDiffusionLoop` → `runDiffusionLoop`。
  - [ ] 11.6 验证：新增 `test/cfgSchedule.test.js`，四种模式数值正确；`constant` 模式与旧行为字节级一致。

- [ ] Task 12: CFG rescale 默认 0.6 + 范围校验
  - [ ] 12.1 在 `src/inference/pipeline/constants.js` 将 `CFG_RESCALE` 从 `0.75` 改为 `0.6`。
  - [ ] 12.2 在 `src/renderer/exportDialog.js` 的 cfgRescale `buildRangeField` 加超界警告 hint（< 0.5 或 > 0.7 时显示），不阻止设值。
  - [ ] 12.3 默认值：`src/renderer/exportDialog.js` 中 `exportCfgRescale ?? 0.75` 改为 `?? 0.6`；`src/renderer/audioPlayback.js` 同步。
  - [ ] 12.4 验证：默认值 0.6 生效；UI 警告在 0.4 / 0.8 时显示，0.55 时隐藏。

## P2 — 音质细节

- [ ] Task 13: SiFiGAN F0 4× 最近邻 → 线性插值
  - [ ] 13.1 在 `src/inference/pipeline/postprocessing.js` `runVocoderChunked` 的 SiFiGAN F0 上采样块（约 855-864 行）将"每帧重复 4 次"改为线性插值（`alignedF0[f]` 与 `alignedF0[f+1]` 之间线性插值 4 点）。同样改造 mel 上采样（约 810-822 行）—— 但 mel 上采样保持最近邻（模型训练时即如此），仅 F0 改线性。
  - [ ] 13.2 验证：F0 阶跃处不再产生瞬时跳变；`test/vocoderChunked.test.js` 通过。

- [ ] Task 14: refHash FNV-1a 全长
  - [ ] 14.1 在 `src/inference/pipeline/audioSegmentation.js` `computeSynthCacheKey`（约 210-220 行）将 refHash 从"前 4000 字节 + 步长"扫描改为调用现有 `this.hashArray(buf)`（FNV-1a 全长）。注意 `hashArray` 接受 array-like，`Uint8Array`/`Buffer` 可直接传入。
  - [ ] 14.2 验证：`test/audioSegmentation.test.js` 通过；新增测试：两个仅前 4000 字节相同的长 buffer 产生不同 hash。

- [ ] Task 15: 分块 diffusion 边界 F0 感知
  - [ ] 15.1 在 `src/inference/pipeline/diffusion.js` `_planChunks` 增加可选 `f0Slope` 参数（每帧 F0 斜率数组）。若提供，调整 `safeOverlap` 区内 chunkEnd 选择：在 `[chunkStart + minBeats, chunkStart + maxBeats]` 候选边界中选 `|f0Slope[boundary]|` 最小的位置。
  - [ ] 15.2 `runDiffusionLoopChunked` 接受可选 `pitchCurveF0`，计算 `f0Slope`（差分）后传入 `_planChunks`。
  - [ ] 15.3 验证：F0 斜率突变处不被选为边界；`test/diffusionChunked.test.js` 通过。

- [ ] Task 16: 2× 过采样→LP→降采样抗混叠（可选，默认 false）
  - [ ] 16.1 在 `src/inference/pipeline/postprocessing.js` 的 `resampleLinear`（约 182-280 行）当 `srcSr > dstSr` 且 `enableAntiAliasing` 时，先 LP 滤波（截止 `dstSr/2`）再降采样。LP 用 Butterworth 1-order IIR 简化实现。
  - [ ] 16.2 在 `src/main/settings.js` 加 `enableAntiAliasing` 设置（默认 false）。
  - [ ] 16.3 验证：`test/resampleAudio.test.js` 通过；`enableAntiAliasing=true` 时高频混叠减少（用 chirp 信号检验）。

- [ ] Task 17: SDEdit 局部修复（可选，默认 false）
  - [ ] 17.1 在 `src/inference/pipeline/diffusion.js` `runDiffusionLoop` 末端增加可选 SDEdit 修复：若 `enableSDEditRepair` 且检测到 mel 局部 NaN/能量突变（帧能量 > 中位数 ×5），对该区间加浅噪声（t=0.3）+ 5 步重采样（用 STORK-2）。修复仅在该帧区间，边界交叉淡入淡出。
  - [ ] 17.2 在 `src/main/settings.js` 加 `enableSDEditRepair` 设置（默认 false）。
  - [ ] 17.3 验证：默认 false 不影响现有行为；`true` 时局部 NaN 被修复，输出无 NaN。

## 设置与 UI 整合

- [ ] Task 18: settings.js / i18n / exportDialog UI 整合
  - [ ] 18.1 在 `src/main/settings.js` 完成所有新增键与默认值变更（前述任务已分散加），统一在 `ALLOWED_SETTINGS_KEYS` 加入：`diagnosticMode`、`vocoderOverlapFrames`、`cfgScheduleMode`、`cfgStrengthStart`、`cfgScheduleKeyframes`、`previewCfgScheduleMode`、`previewCfgStrengthStart`、`previewCfgScheduleKeyframes`、`exportCfgScheduleMode`、`exportCfgStrengthStart`、`exportCfgScheduleKeyframes`、`enableLoudnormFinal`、`enableAntiAliasing`、`enableSDEditRepair`。
  - [ ] 18.2 在 `src/i18n/zh-CN.js` 与 `src/i18n/en.js` 新增所有新设置键对应的 label/hint/desc。
  - [ ] 18.3 在 `src/renderer/exportDialog.js` 新增：CFG 调度模式选择器（constant/linear/cosine/custom）+ start 值输入 + custom keyframe 编辑器（简单文本框，格式 `step:value,step:value`）；vocoder overlap frames 数字输入；诊断模式复选框；loudnorm 开关；抗混叠开关；SDEdit 修复开关。
  - [ ] 18.4 在 `src/renderer/exportDialog.js` 的 `settingsToSave` 加入所有新键。
  - [ ] 18.5 验证：UI 渲染正常；保存后 settings.json 含新键；切换 mode 时 start 输入框启用/禁用。

## 验证与发版

- [ ] Task 19: 测试与 lint
  - [ ] 19.1 运行 `npm test`，确保全部既有测试通过 + 新增测试通过。
  - [ ] 19.2 运行 `npm run lint`，确保无新增 lint 错误。
  - [ ] 19.3 手动检查：默认 sampler=stork2、releaseDiffStepBeforeVocoder=false、cfgRescale=0.6、vocoder overlap=32、cfgScheduleMode=linear 全部在 settings.json 缺失时生效。

- [ ] Task 20: git 备份与 PR
  - [ ] 20.1 `git add -A && git commit -m "perf+quality: apply SVS inference review (batch merge, WSOLA, CFG schedule, loudnorm, etc.)"`
  - [ ] 20.2 推送到远程：`git push origin <branch>`
  - [ ] 20.3 通过 GitHub MCP 创建 PR，标题与 commit message 一致，body 列出所有变更项。

# Task Dependencies

- Task 1（batch 合并）→ 独立，可与 Task 2/3/4 并行
- Task 2（诊断 gating）→ 独立
- Task 3（releaseDiffStep）→ 独立
- Task 4（默认 sampler）→ 独立
- Task 5（vocoder overlap）→ 独立
- Task 6（张量复用）→ 依赖 Task 1（在 batch 合并后的张量结构上做复用）
- Task 7（Welford combine）→ 依赖 Task 1（combine 输入来源变更后）
- Task 8（自适应 gpuDrain）→ 独立
- Task 9（WSOLA）→ 独立（新模块 + 替换两处调用点）
- Task 10（loudnorm）→ 独立（新模块 + 末端调用）
- Task 11（CFG 调度）→ 依赖 Task 7（combine 已重构后再加 step 参数）
- Task 12（cfgRescale）→ 独立
- Task 13（SiFiGAN F0 线性）→ 独立
- Task 14（refHash FNV）→ 独立
- Task 15（F0 感知分块）→ 独立
- Task 16（抗混叠）→ 独立
- Task 17（SDEdit）→ 依赖 Task 4（用 STORK-2 重采样）
- Task 18（UI 整合）→ 依赖 Task 11（CFG 调度设置键已定义）
- Task 19（测试）→ 依赖所有前述任务
- Task 20（PR）→ 依赖 Task 19
