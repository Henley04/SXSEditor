# Checklist

## P0 — 性能关键路径

- [x] DML cond/uncond batch 合并：`pipeline/diffusion.js` 的 `evalDiffStep` 在 CFG>0 时仅 1 次 `session.run`，输出 cond/uncond target 段切片
- [x] Batch 合并数值一致性：固定 seed 噪声下，新实现输出与改造前在 FP16 epsilon（相对误差 < 1e-3）内一致
- [x] 诊断日志 gating：`diagnosticMode=false`（默认）时无 `[DiffusionDiag]` / `[VocoderDiag]` 统计日志；NaN/Inf `console.error` 仍 always-on
- [x] `releaseDiffStepBeforeVocoder` 默认值在 `settings.js` 中为 `false`
- [x] OOM 动态启用：vocoder 抛 `isVramOOMError` 后下一次 `_maybeUnloadDiffStepBeforeVocoder` 返回 `true`，再下一次恢复用户设置
- [x] `DEFAULT_SOLVER` 在 `samplers/index.js` 中为 `'stork2'`
- [x] `audioPlayback.js` `getPreviewInferenceOptions` / `getExportInferenceOptions` 默认 sampler 为 `'stork2'`
- [x] Export dialog 下拉仍包含 4 个 sampler 选项（euler/heun/extrap/stork2），未删除

## P1 — 性能与音质

- [x] `VOCODER_OVERLAP_FRAMES` 常量在 `shared/constants.js` 中为 `32`
- [x] `vocoderOverlapFrames` 设置键存在，默认 `32`，范围 8-96，在 `ALLOWED_SETTINGS_KEYS` 中
- [x] `runVocoderChunked` 接受 `overlapFramesOverride`，缺失时回退到常量 32
- [x] 每步 xt/t 张量在 `runDiffusionLoop` 循环外预分配；单步 `new ort.Tensor` 调用计数为 0（除首次）
- [x] CFG combine 在 `pipeline/diffusion.js` 与 `webnn/diffusion.js` 均为单趟 Welford 在线方差，输出与原 two-pass 在 1e-7 内一致
- [x] `gpuDrainAdaptive()` 在 `utils.js` 中实现；正常路径无 50ms 等待；OOM 后下次 > 150ms
- [x] WSOLA 模块 `wsola.js` 存在，导出 `wsolaCrossfade` 与 `wsolaCrossfadeMel`
- [x] `postprocessing.js` 多 chunk 路径使用 WSOLA 替换 Hann OLA
- [x] `diffusion.js` `_runSingleDiffusionChunk` mel 域使用 `wsolaCrossfadeMel`
- [x] Loudnorm 模块 `loudnorm.js` 存在，导出 `loudnormFinal`
- [x] `runVocoderChunked` 末端在 `normalizePeakTo` 之后调用 `loudnormFinal`，受 `enableLoudnormFinal` 控制
- [x] 单 chunk 路径同样应用 loudnorm
- [ ] CFG 调度模块 `cfgSchedule.js` 存在，导出 `resolveCfgAtStep`，支持 constant/linear/cosine/custom
- [ ] `cfgScheduleMode` 默认 `'linear'`；`cfgStrengthStart` 默认 `cfgStrength * 0.5`
- [ ] `combine` 函数按 `step` 调用 `resolveCfgAtStep` 取有效 cfg
- [ ] `audioPlayback.js` 与 `pipeline/index.js` 透传 schedule 参数
- [ ] `constant` 模式与改造前行为字节级一致
- [x] `CFG_RESCALE` 常量在 `pipeline/constants.js` 中为 `0.6`
- [x] `exportCfgRescale` / `previewCfgRescale` 默认值在 `audioPlayback.js` 与 `exportDialog.js` 中为 `0.6`
- [x] cfgRescale 超界（< 0.5 或 > 0.7）时 UI 显示警告，但不阻止设值

## P2 — 音质细节

- [x] SiFiGAN F0 4× 上采样在 `postprocessing.js` 中为线性插值（非最近邻）；mel 上采样保持最近邻
- [ ] `audioSegmentation.js` refHash 使用 `this.hashArray(buf)` 全长 FNV-1a（非前 4000 字节）
- [ ] `_planChunks` 接受可选 `f0Slope`，提供时避开 F0 斜率突变处切分
- [ ] `runDiffusionLoopChunked` 接受可选 `pitchCurveF0` 并计算 `f0Slope` 传入 `_planChunks`
- [x] `resampleLinear` 在 `srcSr > dstSr` 且 `enableAntiAliasing=true` 时先 LP 滤波再降采样
- [x] `enableAntiAliasing` 设置默认 `false`
- [ ] SDEdit 修复在 `enableSDEditRepair=true` 时对局部 NaN/能量突变区间重采样修复
- [ ] `enableSDEditRepair` 设置默认 `false`

## 设置与 UI

- [ ] `settings.js` `ALLOWED_SETTINGS_KEYS` 包含所有新增键：`diagnosticMode`、`vocoderOverlapFrames`、`cfgScheduleMode`、`cfgStrengthStart`、`cfgScheduleKeyframes`、`previewCfgScheduleMode`、`previewCfgStrengthStart`、`previewCfgScheduleKeyframes`、`exportCfgScheduleMode`、`exportCfgStrengthStart`、`exportCfgScheduleKeyframes`、`enableLoudnormFinal`、`enableAntiAliasing`、`enableSDEditRepair`
- [ ] `zh-CN.js` 与 `en.js` 包含所有新设置键的 label/hint/desc i18n 字符串
- [ ] Export dialog 包含：CFG 调度模式选择器、cfgStrengthStart 输入、custom keyframe 编辑器、vocoder overlap 输入、诊断模式开关、loudnorm 开关、抗混叠开关、SDEdit 修复开关
- [ ] `settingsToSave` 包含所有新键
- [ ] 切换 cfgScheduleMode 时 start/keyframe 输入框启用/禁用正确

## 测试与发版

- [x] `npm test` 全部既有测试通过（无回归）
- [x] 新增测试全部通过：`test/wsola.test.js`、`test/loudnorm.test.js`、`test/gpuDrainAdaptive.test.js`、`test/diffusionBatchMerge.test.js`、`test/cfgCombineWelford.test.js`（`test/cfgSchedule.test.js` 属 Task 11，未在本批次）
- [x] `npm run lint` 无新增错误
- [ ] 手动检查：清空 settings.json 后默认值全部生效（sampler=stork2、releaseDiffStepBeforeVocoder=false、cfgRescale=0.6、vocoder overlap=32、cfgScheduleMode=linear）
- [ ] Git commit 已创建，message 为英文
- [ ] 已推送到远程分支
- [ ] GitHub PR 已创建，body 列出所有变更项
