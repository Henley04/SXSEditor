# 修复 Vocos Vocoder ONNX 导出包含完整 ISTFT 重建 Spec

## Why
当前 `export_step2_vocoder.py` 导出的 vocoder ONNX 仅输出 `spec: [1, T, 1922]`（Vocos `head.out` Linear 层原始输出），缺少 ISTFT 重建。但 JS 推理代码 `src/inference/pipeline/postprocessing.js` 期望的输出名是 `waveform`（`results['waveform']`，最终音频波形 `[1, audio_samples]`）。两者不匹配导致 JS 推理路径无法直接使用 FP32 生产模型 `vocoder_dml.onnx`，必须依赖 W16A32 或其他已含 ISTFT 的旁路模型。修复此问题可使 FP32 主路径 ONNX 直接输出最终波形，恢复 JS 推理代码与导出脚本之间的一致性契约。

## What Changes
- 在 `export_shared.py` 新增 `VocosFullWrapper`（已完成初版）：封装 VocosBackbone + ISTFTHead 完整前向，用 MatMul 实现 IDFT（避免 DML 不支持的 DFT 节点），用手动 Pad+Add 实现 overlap-add（避免 DML 不支持的 Col2Im 节点）。Buffer 命名包含 `istft` 前缀以让 `quantize_weights_to_fp16` 跳过 IDFT basis 矩阵的 FP16 量化（保留 FP32 精度）。
- 修改 `export_step2_vocoder.py`（已完成初版）：从 `VocoderBackboneWrapper` 改用 `VocosFullWrapper`，`output_names` 从 `['spec']` 改为 `['waveform']`。
- **修改 `scripts/verify_module_precision.py`**：将 `verify_vocoder` 的 PyTorch 参考从 `VocoderBackboneWrapper`（仅输出 spec）改为完整 Vocos 前向（`VocosFullWrapper` 或直接 `model.vocoder.model(mel)`），并对比 ONNX 输出的 `waveform` 而非 `spec`。
- 验证 DML EP 可加载导出后的 ONNX 并推理（无 Col2Im / DFT 节点）。
- 验证精度：COS ≥ 0.99, SNR ≥ 30 dB vs PyTorch 完整 Vocos 前向。
- 验证 FP16 量化脚本 `export_step2_vocoder_w16a32.py` 兼容新结构（仍可直接基于 FP32 生产模型量化权重，无需修改）。

## Impact
- Affected specs: `rewrite-inference-from-official`（FP32 主路径模型重新导出的一部分；不冲突，是该 spec 的细化子任务）；`add-bigvgan-v2-44khz-vocoder`（独立，不冲突，BigVGAN 走旁路 vocoderType）。
- Affected code:
  - `export_shared.py` - 新增 `VocosFullWrapper`（已完成初版，需验证导出成功）
  - `export_step2_vocoder.py` - 改用 `VocosFullWrapper` + `output_names=['waveform']`（已完成初版，需验证导出成功）
  - `scripts/verify_module_precision.py` - `verify_vocoder` 函数需更新 PyTorch 参考为完整 Vocos 前向
  - `export_step2_vocoder_w16a32.py` - 不需修改，但需验证兼容性
  - `src/inference/pipeline/postprocessing.js` - 不修改（已期望 `waveform` 输出）
  - `quantize_w8a8_v2.py` - 不需修改（`VocoderBackboneWrapper` 仅用于 W8A8 校准输入生成，校准用 raw spec 路径不影响量化质量）

## 关键技术约束（DML EP 限制）
- **DFT / STFT 节点**：`torch.fft.irfft` 导出后产生 DFT 节点，DirectML EP 不支持。修复方式：用预计算的 cos/sin basis 矩阵做 MatMul 替代 irfft。
- **Col2Im 节点**：`torch.nn.functional.fold` 导出后产生 Col2Im 节点，DirectML EP 不支持（首次导出后 DML EP 初始化报错 `80070057 E_INVALIDARG` 并自动回退 CPU）。修复方式：利用 `win = num_overlap * hop`（1920 = 4 * 480）的因式分解，将 frames `[B, win, T]` reshape 为 `[B, hop, num_overlap, T]`，每个 overlap level j 沿 T 方向偏移 j 帧后相加（Pad + Add），生成 num_overlap-1 个 Add + num_overlap 个 Pad 节点，全部 DML 兼容。
- **FP16 量化兼容性**：`VocosFullWrapper` 的 IDFT basis 矩阵（`istft_cos_basis`, `istft_sin_basis`）和 `istft_window` 必须保持 FP32。Buffer 命名包含 `istft` 前缀让 `quantize_weights_to_fp16` 自动跳过这些张量（已验证该函数根据 initializer 名称匹配 `'istft'` 跳过逻辑）。
- **opset 版本**：opset 20（最大 DML 兼容版本），与 `export_fp32_opset20` 保持一致。

## ADDED Requirements

### Requirement: VocosFullWrapper 包含完整 ISTFT 重建
系统 SHALL 在 `export_shared.py` 提供 `VocosFullWrapper(nn.Module)`，封装 Vocos 的完整前向：backbone → head.out (Linear) → exp/clip/cos/sin 构造复数 spectrogram → MatMul 实现 IDFT → 加窗 → 手动 Pad+Add 实现 overlap-add → 窗函数包络归一化 → 输出波形 `[B, T*hop]`。

#### Scenario: PyTorch 前向输出 shape 与官方一致
- **WHEN** 用 mel `[1, 500, 128]` 输入调用 `VocosFullWrapper(model.vocoder).forward(mel)`
- **THEN** 输出 shape 为 `[1, 240000]`（500 * 480）
- **AND** 与官方 `ISTFTHead.forward` + `ISTFT.forward(padding='same')` 的输出 cosine similarity ≥ 0.99

#### Scenario: ONNX 导出无 DML 不兼容算子
- **WHEN** 执行 `python export_step2_vocoder.py` 导出 ONNX
- **THEN** ONNX 图中 `DFT` 节点数 = 0
- **AND** ONNX 图中 `STFT` 节点数 = 0
- **AND** ONNX 图中 `Col2Im` 节点数 = 0
- **AND** ONNX 输出名 = `waveform`
- **AND** ONNX 输出 shape = `[1, 240000]`（静态，seq_len=500）

#### Scenario: DML EP 可加载并推理
- **WHEN** 用 onnxruntime 加载导出的 `vocoder_dml.onnx`，providers=['DmlExecutionProvider', 'CPUExecutionProvider']
- **THEN** session 初始化成功，无 `E_INVALIDARG` 错误
- **AND** 实际生效的 EP 列表包含 `DmlExecutionProvider`（未回退 CPU）
- **AND** 推理 mel `[1, 500, 128]` 输出 `[1, 240000]` 无错误

### Requirement: 精度验证使用完整 Vocos 前向作为参考
系统 SHALL 在 `scripts/verify_module_precision.py` 的 `verify_vocoder` 中使用完整 Vocos 前向（`VocosFullWrapper` 或直接调用 `model.vocoder.model(mel)`）作为 PyTorch 参考，对比 ONNX 输出的 `waveform`。

#### Scenario: PyTorch 参考输出波形
- **WHEN** 运行 `python scripts/verify_module_precision.py`
- **THEN** `verify_vocoder` 的 PyTorch 参考输出 shape 为 `[1, T*hop]`（波形），而非 `[1, T, 1922]`（spec）
- **AND** PyTorch 参考输出与 ONNX `waveform` 输出对比，COS ≥ 0.99 且 SNR ≥ 30 dB（vocoder 属于 RELAXED_MODELS 集合，但目标是严格阈值）

### Requirement: FP16 量化脚本兼容性
系统 SHALL 保持 `export_step2_vocoder_w16a32.py` 可直接基于新 FP32 生产模型 `vocoder_dml.onnx` 生成 W16A32 版本，无需修改脚本逻辑。

#### Scenario: W16A32 量化成功
- **WHEN** 执行 `python export_step2_vocoder_w16a32.py`
- **THEN** 加载 FP32 `vocoder_dml.onnx` 成功（含 external_data）
- **AND** `quantize_weights_to_fp16` 跳过 `istft_*` 前缀的 initializer（保留 FP32）
- **AND** 输出 `fp16/vocoder_dml.onnx` 的输入名 = `mel`，输出名 = `waveform`
- **AND** ONNX 图中 DFT/STFT/Col2Im 节点数 = 0
- **AND** DML EP 可加载 W16A32 模型并推理

## MODIFIED Requirements

### Requirement: Vocoder ONNX 输出契约
`export_step2_vocoder.py` 导出的 `vocoder_dml.onnx` 输出名 SHALL 为 `waveform`（shape `[1, T*hop]`，float32 音频波形），与 JS 推理代码 `src/inference/pipeline/postprocessing.js` 第 895/897/1026/1029 行 `results['waveform']` 一致。原 `spec` 输出名不再使用。

## REMOVED Requirements
无。旧 `VocoderBackboneWrapper` 保留（仍被 `quantize_w8a8_v2.py` 第 239 行用于 W8A8 校准输入生成）。
