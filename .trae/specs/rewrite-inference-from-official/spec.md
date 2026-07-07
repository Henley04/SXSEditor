# 从官方仓库重写推理管线并重新导出 FP32 ONNX 模型 Spec

## Why

当前 SXSEditor 的 JS 推理管线是在多次迭代修复中逐步成型的（CFG rescale、uncond seq_len、f0Shift 三处同步等），与 SoulX-Singer 官方 PyTorch 实现存在偏差风险；同时累积了大量备份文件增加维护负担。需要从官方推理仓库重写核心推理管线、重新导出 opset 20 FP32 ONNX 模型作为主路径，确保端到端高精度可部署。SiFiGAN、INT8、INT8-NPU 作为已有的可选路径保留。

## What Changes

### 删除（仅清理备份，不动可选路径）
- 删除所有 `.bak` 文件（opset 18 旧版备份，共 14 个）
- 删除 `sifigan_vocoder_dml_backup.onnx`、`sifigan_vocoder_dml_linear_backup.onnx` 及其 `.data`
- 删除 `onnx_models/fp16_w16a16_backup/` 目录（旧 W16A16 实验）
- 删除 `onnx_models/fp16/JP/_fp32_backup/` 目录（Olive 转换前备份）
- 删除 `onnx_models/int8/optimized_npu_backup/` 目录（NPU 镜像备份）
- 删除 `onnx_models/svc/` 目录（SVC 模型，当前 SVS 管线不使用）
- 删除已被新流程取代的脚本：`calibrate/upgrade_opset.py`、`calibrate/replace_with_opset20.py`（直接导出 opset 20 取代事后升级）

### 保留（不动）
- **SiFiGAN 全部代码与模型**：`SiFiGANWrapper`、`sifigan_vocoder_dml*.onnx`、`sifigan_stats.joblib`、SiFiGAN 精度切换逻辑、`export_sifigan_vocoder.py`、`quantize_sifigan_fp16.py`、`optimize_sifigan_dml.py`、`scripts/` 下 SiFiGAN mel_proj 相关脚本
- **INT8 / INT8-NPU 全部代码与模型**：`onnx_models/int8/`、`onnx_models/fp16/`(W16A32)、`quantize_w8a8_v2.py`、`optimize_npu*.py`、`PRECISION_SUBDIR_MAP`、`_detectModelPrecision`、NPU 静态形状分支
- `SoulX-Singer/` 官方仓库克隆
- `third_party/SiFiGAN/`
- `src/inference/pipeline/textProcessing.js`、`audioSegmentation.js`、`src/utils/mergePhoneme.js`
- `.sxssinger` / `.sxsproj` 文件格式
- JP/base 双语言模型切换、SiFiGAN vocoder 切换、精度切换全部机制

### 新增 / 重写
- **重写 JS 核心推理管线**（仅 FP32 default 路径）：严格对齐官方 `soulxsinger.py` / `flow_matching.py` / `data_processor.py` 的逻辑。SiFiGAN/INT8/NPU 分支保留现有实现不动，但共享的算法逻辑（diffusion 循环、encoder 前向、音素帧分配、auto_shift）的修正会同步影响所有路径。
- **重新导出 FP32 ONNX 模型**：从 `SoulX-Singer/pretrained_models/SoulX-Singer/model.pt` 直接导出 opset 20 FP32 ONNX，覆盖 `onnx_models/` 根目录下现有 FP32 模型
- **DML 兼容优化**：保留 STFT→Conv 替换、ConvTranspose 分解；不应用任何 FP16 量化（FP32 主路径）
- **精度验证脚本**：PyTorch vs FP32 ONNX 的 MSE/RMSE/COS/SNR 对比（模块级 + 端到端）
- **更新 `tools.md` 和 `onnx_models/README.md`**：反映新 FP32 导出流程，保留 SiFiGAN/INT8 说明

## Impact

- **Affected specs**: `add-bigvgan-v2-44khz-vocoder`（BigVGAN 作为另一可选 vocoder，与本 spec 不冲突）、`add-npu-inference-support`（NPU 路径保留，本 spec 不改动 NPU 代码）
- **Affected code**:
  - `src/inference/pipeline/index.js` — 主管线 default 路径重写，SiFiGAN/INT8/NPU 分支保留
  - `src/inference/pipeline/preprocessing.js` — 编码器前向 + 音素帧分配对齐官方（共享逻辑）
  - `src/inference/pipeline/diffusion.js` — flow-matching 循环对齐官方（共享逻辑）
  - `src/inference/pipeline/postprocessing.js` — default vocoder 路径重写，SiFiGAN 路径保留
  - `src/inference/pipeline/constants.js` — 不动（SiFiGAN/INT8 常量保留）
  - `src/inference/pipeline/modelLoader.js` — 不动（FP16/INT8/NPU 加载保留）
  - `src/main/singerIpc.js` / `src/renderer/projectManager.js` — 格式不变
  - 根目录 `export_step1_diffstep.py`、`export_step2_vocoder.py`、`export_step3_postprocess.py` — 重写为直接 opset 20 FP32
  - `onnx_models/` 根目录 FP32 模型 — 全量替换为 opset 20

---

## 官方推理逻辑梳理（重写依据）

### 1. 顶层流程（`cli/inference.py` → `SoulXSinger.infer`）

```
prompt_meta, prompt_wav → DataProcessor.process → infer_prompt_data
target_meta             → DataProcessor.process → infer_target_data
model.infer({prompt, target}, auto_shift, pitch_shift, n_steps, cfg, control, use_fp16)
→ generated_audio (24000 Hz)
```

### 2. `SoulXSinger.infer()` 核心步骤（`soulxsinger.py` L110-197）

1. **提取 prompt/target 的** `phoneme`、`mel2note`、`note_type`、`note_pitch`(score) 或 `f0`(melody)
2. **auto_shift 计算**（semitone 单位）：
   - score 模式：`f0_shift = round(median(pt_note_pitch) - median(gt_note_pitch))`
   - melody 模式：`f0_shift = round(log2(pt_f0_median / gt_f0_median) * 12)`
3. **prompt mel 提取**：`pt_mel = self.mel(pt_wav)` （MelSpectrogramEncoder，FP32）
4. **序列拼接**（prompt 在前，target 在后）：
   - `note_pitch = cat([pt_note_pitch, gt_note_pitch])`
   - `note_text = cat([pt_note_text, gt_note_text])`
   - `note_type = cat([pt_note_type, gt_note_type])`
   - `mel2note = cat([pt_mel2note, gt_mel2note + len_prompt])`（target 偏移 prompt token 长度）
5. **F0 量化**：
   - `f0_course_pt = f0_to_coarse(pt_f0)` （无 shift）
   - `f0_course_gt = f0_to_coarse(gt_f0, f0_shift=f0_shift * 5)` （`*5` = semitone→20cent bin）
   - `f0_course = cat([f0_course_pt, f0_course_gt])`
6. **note_pitch shift**：`note_pitch[note_pitch > 0] += f0_shift`，`clamp(note_pitch, 0, 255)`
7. **编码器前向**：
   - `features = note_pitch_encoder(note_pitch) + note_type_encoder(note_type) + note_text_encoder(note_text)`
   - `features = preflow(features)`
   - `features = expand_states(features, mel2note)` （token 级 → 帧级）
   - `features = features + f0_encoder(f0_course)`
8. **拆分 prompt/target 条件**：
   - `pt_decoder_inp = features[:, :len_prompt_mel, :]`
   - `gt_decoder_inp = features[:, len_prompt_mel:, :]`
9. **flow-matching 反扩散**：`generated_mel = cfm_decoder.reverse_diffusion(pt_mel, pt_decoder_inp, gt_decoder_inp, n_steps, cfg)`
10. **vocoder**：`generated_audio = vocoder(generated_mel.transpose(1,2))`

### 3. `f0_to_coarse`（`soulxsinger.py` L63-108）

```
f0_cents = 1200 * log2(f0 / f0_min)        # f0_min = 32.7031956625 (C1)
f0_coarse = round(f0_cents / 20) + 1       # 20 cent/bin
f0_coarse = clamp(f0_coarse, 1, f0_bin-1)  # f0_bin = 361
f0_coarse[f0 <= 0] = 0                     # unvoiced → 0
if f0_shift != 0:
    f0_coarse[voiced] = clamp(f0_coarse[voiced] + f0_shift, 1, f0_bin-1)
```

### 4. `DataProcessor.preprocess`（`data_processor.py` L62-158）

- `merge_phoneme`：合并连续相同 phoneme + note_type + note_pitch 的 SP 音符
- 每个 note 包裹 `<BOW>` 和 `<EOW>`
- 英文 `en_xxx`：按 `-` 拆分，词间插 `<SEP>`
- 日文 `jp_xxx`：按 `-` 拆分，**不插** `<SEP>`
- `mel2note` 帧分配：每个 note 内 `inner_frames = next_start - i - 2`，按音素数 j 线性分配（`p_start = i+1 + int(p*inner/j)`）
- 输出：`phoneme`(token ids)、`note_pitch`、`note_type`、`mel2note`(帧→token 映射)

### 5. `CFMDecoder.reverse_diffusion`（`flow_matching.py` L253-309）⭐ 核心循环

```python
h = 1.0 / n_timesteps
prompt_len = prompt.shape[1]           # prompt mel 帧数
target_len = cond.shape[1] - prompt_len # target mel 帧数
xt_mask = cat([prompt_mask, x_mask])    # 全长 mask
z = randn(target_len, mel_dim)          # 仅 target 长度的噪声
xt = z

for i in range(n_timesteps):
    xt_input = cat([prompt, xt], dim=1)             # prompt + target 拼接
    t = (i + 0.5) * h                                 # t ∈ (0, 1)，从 0.5/n 到 (n-0.5)/n
    flow_pred = diff_estimator(xt_input, t, cond, xt_mask)
    flow_pred = flow_pred[:, prompt_len:, :]          # 取 target 部分

    if cfg > 0:
        # ⚠️ uncond 分支：仅 target 长度，cond 置零
        uncond_flow_pred = diff_estimator(xt, t, zeros_like(cond)[:, :xt.shape[1], :], x_mask)
        pos_std = flow_pred.std()                     # torch.std 默认 Bessel 校正 (N-1)
        flow_pred_cfg = flow_pred + cfg * (flow_pred - uncond_flow_pred)
        rescale = flow_pred_cfg * pos_std / flow_pred_cfg.std()
        flow_pred = rescale_cfg * rescale + (1 - rescale_cfg) * flow_pred_cfg

    dxt = flow_pred * h
    xt = xt + dxt                                     # Euler 积分
```

**关键点**：
- `t` 调度：`(i + 0.5) / n`，非 `i / n` 也非 `(i+1) / n`
- `h = 1 / n`，`dxt = flow_pred * h`（Euler step）
- uncond 分支：xt 是 target-only，cond 是 zeros target-only，mask 是 x_mask（target-only）
- CFG rescale：`pos_std / cfg_std`，torch.std 默认 Bessel 校正
- rescale 混合：`rescale_cfg * rescaled + (1 - rescale_cfg) * cfg`
- noise `z` 仅 target 长度，prompt 部分不参与噪声生成

### 6. 编码器维度（来自 `soulxsinger/config/soulxsinger.yaml`）

- `text_dim` = `pitch_dim` = `type_dim` = `f0_dim` = 512（embedding 维度，相加后仍 512）
- `mel_dim` = 128
- `cond_emb_dim` (hidden_size) = 1024
- `f0_bin` = 361，`f0_min` = 32.7031956625
- `vocab_size`、`num_layers` 等见 config

---

## ADDED Requirements

### Requirement: FP32 Opset 20 ONNX 模型导出（主路径）
系统 SHALL 从官方预训练 PyTorch 模型 (`SoulX-Singer/pretrained_models/SoulX-Singer/model.pt`) 重新导出全部 9 个核心 ONNX 模型作为 FP32 主路径，使用 opset 20、FP32 精度，并应用 DML 兼容性优化（STFT→Conv 替换、ConvTranspose 分解），不进行任何 FP16/INT8 量化。此操作覆盖 `onnx_models/` 根目录下现有 FP32 模型，不影响 `onnx_models/fp16/`、`onnx_models/int8/` 等子目录。

#### Scenario: 导出成功
- **WHEN** 执行导出脚本
- **THEN** `onnx_models/` 下生成 9 个 FP32 opset 20 ONNX 文件（note_text_encoder、note_pitch_encoder、note_type_encoder、f0_encoder、preflow、cond_emb、diff_step_dml、vocoder_dml、mel_transform）
- **AND** 每个 ONNX 在 DML EP 上可加载、可推理，无 unsupported op
- **AND** `onnx_models/fp16/`、`onnx_models/int8/` 子目录保持不变

#### Scenario: JP 模型导出
- **WHEN** 执行 JP 导出（基于 LoRA 合并后的 checkpoint）
- **THEN** `onnx_models/JP/` 下生成 4 个 JP 专属 FP32 ONNX（note_text_encoder、preflow、cond_emb、diff_step_dml）

### Requirement: 推理管线对齐官方 PyTorch（default 路径）
系统 SHALL 在 JS 推理管线的 default FP32 路径中严格实现官方 `SoulXSinger.infer()` + `CFMDecoder.reverse_diffusion()` + `DataProcessor.preprocess()` 的逻辑，包括 t 调度 `(i+0.5)/n`、uncond 分支 target-only 序列、CFG Bessel 校正 rescale、f0_shift 三处同步（f0Hz/f0Ids/notePitchSeq）。SiFiGAN vocoder 路径和 INT8/NPU 精度路径保留现有实现，但共享的算法逻辑修正（diffusion 循环、encoder 前向、音素帧分配、auto_shift）同步生效。

#### Scenario: flow-matching 循环一致
- **WHEN** 给定相同 prompt mel、相同 cond、相同噪声 z、相同 n_steps
- **THEN** JS 推理产出的 mel 与 PyTorch `reverse_diffusion` 产出的 mel 在 COS ≥ 0.999、SNR ≥ 30dB

#### Scenario: auto_shift 一致
- **WHEN** 给定相同 prompt/target note_pitch 或 f0
- **THEN** JS 计算的 f0_shift 与 PyTorch `model.infer` 中的 auto_shift 完全一致（整数 semitone）

### Requirement: 精度验证（MSE/RMSE/COS/SNR）
系统 SHALL 提供精度验证脚本，对每个 FP32 ONNX 模块及端到端管线，在真实输入数据上对比 PyTorch 输出与 ONNX 输出，计算 MSE、RMSE、COS(cosine similarity)、SNR(dB)。

#### Scenario: 模块级精度达标
- **WHEN** 对 9 个核心 FP32 模型分别运行精度验证
- **THEN** 每个模型 COS ≥ 0.99、SNR ≥ 30dB
- **AND** 验证结果保存到 `scripts/precision_report.json`

#### Scenario: 端到端精度达标
- **WHEN** 对完整 SVS 管线（FP32 路径：encoder + diffusion 32 步 + vocoder）运行端到端验证
- **THEN** 最终音频 COS ≥ 0.95、SNR ≥ 20dB
- **AND** 验证结果保存到 `scripts/e2e_precision_report.json`

### Requirement: 歌手/工程文件兼容性
系统 SHALL 保持 `.sxssinger` 和 `.sxsproj` 文件格式（`formatVersion: 1.0.0`、`version: 1.1.0`）不变，现有文件可正常加载。

#### Scenario: 现有歌手文件加载
- **WHEN** 加载现有 `.sxssinger` 文件
- **THEN** 歌手信息（singerName、wavBase64、midiNotes、f0Data 等）完整还原

#### Scenario: 现有工程文件加载
- **WHEN** 加载现有 `.sxsproj` 文件
- **THEN** 项目（bpm、timeSignature、singers、fragments）完整还原并可合成

## MODIFIED Requirements

### Requirement: 默认 Vocoder 路径对齐官方
系统 SHALL 将 default vocoder 路径（`vocoder_dml.onnx`）的调用逻辑对齐官方 `SoulXSinger.infer()` 的 vocoder 调用（`vocoder(generated_mel.transpose(1,2))`），同时保留 SiFiGAN vocoder 路径（`sifigan_vocoder_dml*.onnx`）作为可选 vocoder 不动。vocoder 类型切换机制（`swapVocoder`）保留。

### Requirement: 默认精度为 FP32
系统 SHALL 将 FP32 作为默认精度路径，重新导出的 opset 20 FP32 ONNX 模型位于 `onnx_models/` 根目录。FP16(W16A32)/INT8/INT8-NPU 精度路径保留现有实现和模型文件不动，通过 `PRECISION_SUBDIR_MAP` 机制切换。
