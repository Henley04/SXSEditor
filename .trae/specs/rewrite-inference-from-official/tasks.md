# Tasks

## Phase 1: 清理备份文件（保留 SiFiGAN/INT8/NPU）

- [x] Task 1: Git 备份当前工作区（不单独开分支）
  - 在执行任何删除操作前，先 `git add -A && git commit -m "backup before inference pipeline rewrite"`
  - 确保工作区干净，可随时回滚

- [x] Task 2: 删除 ONNX 备份文件（仅备份，不动可选路径）
  - 删除所有 `*.bak` 和 `*.bak.data` 文件（14 个，位于 `onnx_models/` 和 `onnx_models/fp16/`）
  - 删除 `onnx_models/sifigan_vocoder_dml_backup.onnx`
  - 删除 `onnx_models/sifigan_vocoder_dml_linear_backup.onnx` 及其 `.data`
  - 删除 `onnx_models/fp16/sifigan_vocoder_dml_linear_backup.onnx.data`
  - 删除 `onnx_models/fp16_w16a16_backup/` 目录（旧 W16A16 实验）
  - 删除 `onnx_models/fp16/JP/_fp32_backup/` 目录（Olive 转换前备份）
  - 删除 `onnx_models/int8/optimized_npu_backup/` 目录（NPU 镜像备份）
  - 删除 `onnx_models/svc/` 目录（SVC 模型，当前 SVS 管线不使用）
  - **不删除**：`onnx_models/fp16/`（W16A32 保留）、`onnx_models/int8/`（INT8 保留）、SiFiGAN 模型、SiFiGAN 脚本

- [x] Task 3: 删除已被新流程取代的脚本（仅 opset 升级相关）
  - 删除 `calibrate/upgrade_opset.py`（直接导出 opset 20 取代事后升级）
  - 删除 `calibrate/replace_with_opset20.py`（同上）
  - **不删除**：SiFiGAN 脚本、INT8/NPU 脚本、W16A32 脚本、其他 calibrate 脚本

- [x] Task 4: Git 提交清理结果
  - `git add -A && git commit -m "remove obsolete backup files and opset upgrade scripts"`

## Phase 2: 重写 FP32 ONNX 导出流水线（opset 20, DML 兼容）

- [x] Task 5: 重写 `export_shared.py`
  - 保留并复用：`replace_stft()`（STFT→Conv）、`optimize_vocoder_dml.py` 的 ConvTranspose 分解逻辑（合并进来）、`postprocess_onnx()`（onnxsim + DML 验证）、`load_model()`
  - 修改：所有 `torch.onnx.export` 调用直接使用 `opset_version=20`（不再事后升级）
  - **保留**：`quantize_weights_to_fp16()`、`fix_mixed_precision()`、`DiffStepWrapper`/`VocoderBackboneWrapper` 中 FP16 相关分支（SiFiGAN/INT8/W16A32 脚本仍依赖）
  - 新增：直接 opset 20 导出的便捷函数

- [x] Task 6: 重写 `export_step1_diffstep.py`（diffStep 导出，FP32 主路径）
  - 从 `SoulX-Singer/pretrained_models/SoulX-Singer/model.pt` 加载 `SoulXSinger.cfm_decoder.diff_estimator`（DiffLlama）
  - 导出为 `onnx_models/diff_step_dml.onnx`，opset 20，FP32
  - 输入：`xt_input (B,T,128)`、`t (B,)`、`cond (B,T,512)`、`xt_mask (B,T)`
  - 输出：`flow_pred (B,T,128)`
  - 应用 `postprocess_onnx`（onnxsim + DML 验证）
  - 验证：DML EP 可加载、可推理
  - **不覆盖** `onnx_models/fp16/diff_step_dml.onnx`、`onnx_models/int8/diff_step_dml.onnx`

- [x] Task 7: 重写 `export_step2_vocoder.py`（vocoder 导出，FP32 主路径）
  - 加载 `SoulXSinger.vocoder`（Vocos）
  - 导出为 `onnx_models/vocoder_dml.onnx`，opset 20，FP32
  - 应用 ConvTranspose(stride=480) 分解（来自 `optimize_vocoder_dml.py`）
  - 应用 `postprocess_onnx`
  - 验证：DML EP 可加载、可推理
  - **不覆盖** SiFiGAN vocoder 文件、`onnx_models/fp16/`、`onnx_models/int8/` 下 vocoder

- [x] Task 8: 重写 `export_step3_postprocess.py`（其他 7 个模型导出，FP32 主路径）
  - 导出：`note_text_encoder`、`note_pitch_encoder`、`note_type_encoder`、`f0_encoder`、`preflow`、`cond_emb`、`mel_transform`
  - 全部 opset 20，FP32
  - `mel_transform` 应用 `replace_stft()`
  - 全部应用 `postprocess_onnx`
  - 输出到 `onnx_models/` 根目录
  - **不覆盖** `onnx_models/fp16/`、`onnx_models/int8/` 子目录

- [x] Task 9: 重写 JP 模型导出脚本（FP32 主路径）
  - 基于 `SoulX-Singer/train/lora_jp_v3/export_onnx.py` 逻辑（LoRA 合并后导出）
  - 导出 4 个 JP 专属模型到 `onnx_models/JP/`：`note_text_encoder.onnx`、`preflow.onnx`、`cond_emb.onnx`、`diff_step_dml.onnx`
  - opset 20，FP32，应用相同 DML 兼容优化
  - **不覆盖** `onnx_models/fp16/JP/`

- [x] Task 10: 编写统一导出编排脚本 `export_pipeline.py`
  - 替代旧 `export_int8_pipeline.py`（保留旧文件不动）
  - 按序执行 step1（diffstep）→ step2（vocoder）→ step3（其他 7 个）→ step4（JP 4 个）
  - 每步独立进程（避免内存泄漏）
  - 完成后打印 `onnx_models/` 根目录文件清单和 opset 版本验证
  - 仅导出 FP32 主路径，不影响 fp16/int8 子目录

- [x] Task 11: 执行导出并验证 opset
  - 运行 `python export_pipeline.py`（317.6s，13 个 ONNX 全部导出）
  - 用 `calibrate/check_opset.py` 验证 `onnx_models/` 根目录下所有 ONNX opset = 20（9 主路径 + 4 JP 全部 PASS）
  - SiFiGAN/FP16/INT8 子目录保留未动（opset 17/18，符合预期）

## Phase 3: 精度验证脚本（PyTorch vs FP32 ONNX）

- [x] Task 12: 编写模块级精度验证脚本 `scripts/verify_module_precision.py`
  - 对 9 个核心 FP32 模型分别对比 PyTorch 输出 vs ONNX (DML EP) 输出
  - 使用真实输入数据（从 `SoulX-Singer/example/` 提取）
  - 指标：MSE、RMSE、COS(cosine similarity)、SNR(dB)
  - 阈值：COS ≥ 0.99、SNR ≥ 30dB
  - 输出：`scripts/precision_report.json` + 控制台汇总表
  - 全部 9 个模型 PASS：COS ≥ 0.999995, SNR ≥ 49.86dB（mel_transform/vocoder 达到极限精度）
  - **vocoder 重验证**：更新 verify_vocoder 使用 VocosFullWrapper（含完整 ISTFT 重建），输出 `waveform[1,240000]`，COS=1.000000, SNR=102.49dB

- [ ] Task 13: 编写端到端精度验证脚本 `scripts/verify_e2e_precision.py`
  - 对比 PyTorch `model.infer()` 完整流程 vs JS ONNX 管线产出的最终音频
  - 使用相同 prompt + target + 噪声种子
  - 指标：MSE、RMSE、COS、SNR
  - 阈值：COS ≥ 0.95、SNR ≥ 20dB
  - 输出：`scripts/e2e_precision_report.json`
  - 注意：JS 管线需在 Task 17 完成后才能运行此验证

## Phase 4: 重写 JS 核心推理管线（default 路径，保留可选路径）

- [x] Task 14: 重写 `src/inference/pipeline/diffusion.js`（flow-matching 循环，共享逻辑）
  - 严格对齐 `flow_matching.py` L253-309 的 `reverse_diffusion`
  - `t = (i + 0.5) * h`，`h = 1.0 / totalSteps`
  - uncond 分支：xt target-only、cond zeros target-only、mask x_mask target-only
  - CFG rescale：`posStd / (cfgStd + 1e-8)`，使用 Bessel 校正（N-1 分母）的样本标准差
  - rescale 混合：`rescale_cfg * rescaled + (1 - rescale_cfg) * cfg`
  - `dxt = flow_pred * h`，`xt = xt + dxt`
  - 保留：GPU drain、progress 回调、tensor 缓存优化、FP16 分支（SiFiGAN/W16A32 路径仍用）、static shapes 分支（NPU 路径仍用）
  - 此修正是共享逻辑，所有 vocoder/精度路径都受益

- [x] Task 15: 重写 `src/inference/pipeline/preprocessing.js`（编码器前向 + 音素帧分配，共享逻辑）
  - `notesToSequences`：对齐 `DataProcessor.preprocess`
    - mel2note 帧分配：`inner_frames = next_start - i - 2`，线性分配 `p_start = i+1 + floor(p*inner/j)`
    - 英文 `en_` 拆分 + SEP，日文 `jp_` 拆分无 SEP
    - BOW/EOW 包裹
  - `runEncoder`：对齐 `SoulXSinger.infer` L178-183
    - 4 个 encoder 并行 → 相加 → preflow → expand_states → + f0_encoder
  - f0_shift 三处同步：`f0Hz`(vocoder)、`f0Ids`(diffusion cond)、`notePitchSeq`(encoder)
  - 保留：SiFiGAN 4× 上采样分支、FP16 分支、所有现有工程逻辑

- [x] Task 16: 重写 `src/inference/pipeline/index.js`（主管线编排，default 路径对齐官方）
  - `synthesize` / `_synthesizeImpl`：default 路径对齐 `SoulXSinger.infer` 编排
    - auto_shift 计算（score: median 差；melody: log2 比值 × 12）
    - f0_shift = round(...) 后：`f0_to_coarse(gt_f0, f0_shift*5)`、`note_pitch += f0_shift`
    - prompt mel 提取（mel_transform.onnx）
    - 序列拼接（prompt + target，mel2note 偏移 len_prompt）
    - encoder → diffusion → vocoder
  - 保留：`swapVocoder`、`swapSifiganPrecision`、`PRECISION_SUBDIR_MAP` 加载逻辑、SiFiGAN vocoder 分支、INT8/NPU 路径
  - 保留：`swapLanguageModels`（JP/base）、多 segment 合成、crossfade、synth cache、runLock 互斥
  - 保留：`_runVocoderChunked`（vocoder 分块工程逻辑）

- [x] Task 17: 重写 `src/inference/pipeline/postprocessing.js`（default vocoder 路径对齐官方）
  - `runVocoderChunked` default vocoder 分支：对齐官方 `vocoder(generated_mel.transpose(1,2))` 调用
  - 保留 SiFiGAN 分支（vocoderType 判断、4× 上采样、f0 输入）不动
  - 保留：分块串行、GPU drain、validateVocoderOutput、流式回调
  - 保留：`extractRefMelOnnx`、`extractRefF0FromWavAsync`、重采样、WAV 解析

- [x] Task 18: 验证 SiFiGAN/INT8/NPU 路径未受影响
  - 确认 `constants.js`、`modelLoader.js`、`svsIpc.js` 未被修改（或仅最小改动）
  - 确认 SiFiGAN vocoder 切换正常工作
  - 确认 INT8/INT8-NPU 精度切换正常工作
  - 确认 `swapVocoder`、`swapSifiganPrecision` IPC 仍可用

## Phase 5: 集成测试与文档

- [ ] Task 19: 端到端功能测试（default FP32 路径）
  - 用 `SoulX-Singer/example/` 中的 prompt + target 元数据生成参考音频
  - 在 SXSEditor 中加载相同 prompt 歌手文件，合成相同 target
  - 对比 JS 管线产出 vs PyTorch 官方产出（COS、SNR）
  - 测试 JP 模型切换
  - 测试多 segment 长音频合成
  - 测试歌手/工程文件加载保存

- [ ] Task 20: 测试可选路径未受影响
  - 测试 SiFiGAN vocoder 切换后合成正常
  - 测试 INT8 精度切换后合成正常
  - 测试 INT8-NPU 路径（如环境支持）

- [ ] Task 21: 运行精度验证脚本
  - 执行 `python scripts/verify_module_precision.py`，确认 9 个 FP32 模型全部达标
  - 执行 `python scripts/verify_e2e_precision.py`，确认端到端达标
  - 如有未达标项，定位并修复（可能需调整 ONNX 导出或 JS 实现）

- [ ] Task 22: 打包测试
  - 执行 `npm run package:lite`
  - 验证打包后的应用可正常加载模型、合成音频
  - 验证 `app.asar.unpacked/onnx_models/` 包含全部 9 个 FP32 模型 + JP/ 子目录 + fp16/ + int8/ + SiFiGAN 文件

- [ ] Task 23: 更新文档
  - 更新 `tools.md`：新增 `export_pipeline.py` 用法，保留现有 SiFiGAN/INT8/NPU 脚本说明
  - 更新 `onnx_models/README.md`：标注 FP32 opset 20 为默认主路径，保留 FP16/INT8/SiFiGAN 说明
  - 更新 `README.md`（如有必要）

- [ ] Task 24: Git 提交并推送
  - `git add -A && git commit -m "rewrite default inference pipeline from official SoulX-Singer, re-export FP32 opset 20 ONNX models"`
  - 推送到远程 GitHub 仓库

# Task Dependencies

- Task 1 → Task 2, 3（清理前先备份）
- Task 2, 3 → Task 4（清理后提交）
- Task 4 → Task 5（共享工具先就绪）
- Task 5 → Task 6, 7, 8, 9（导出脚本重写，可并行）
- Task 6, 7, 8, 9 → Task 10（编排脚本依赖各 step）
- Task 10 → Task 11（执行导出）
- Task 11 → Task 12（模块级验证依赖导出结果）
- Task 5 → Task 12（验证脚本复用 export_shared.py 的 Wrapper）
- Task 12 → Task 13（端到端验证依赖模块级通过）
- Task 14, 15, 16, 17 → Task 18（验证可选路径依赖 default 路径完成）
- Task 16 → Task 13（端到端验证依赖 JS 管线完成）
- Task 18 → Task 19（集成测试依赖全部代码完成）
- Task 19 → Task 20（可选路径测试依赖 default 路径通过）
- Task 20 → Task 21（精度验证依赖功能测试通过）
- Task 21 → Task 22（打包前精度达标）
- Task 22 → Task 23（文档更新依赖测试通过）
- Task 23 → Task 24（最终提交）
