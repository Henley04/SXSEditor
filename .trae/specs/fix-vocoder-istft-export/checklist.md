# Verification Checklist

## Phase 1: 导出验证

- [ ] `python export_step2_vocoder.py` 执行无异常，退出码 0
- [ ] `onnx_models/vocoder_dml.onnx` 文件已更新（mtime 为最近）
- [ ] `onnx_models/vocoder_dml.onnx.data` 文件已更新（若使用 external_data）
- [ ] ONNX 图中 `DFT` 节点数 = 0
- [ ] ONNX 图中 `STFT` 节点数 = 0
- [ ] ONNX 图中 `Col2Im` 节点数 = 0
- [ ] ONNX 输入名 = `mel`，shape = `[1, 500, 128]`，dtype = float32
- [ ] ONNX 输出名 = `waveform`，shape = `[1, 240000]`，dtype = float32
- [ ] ONNX 图中存在 `MatMul` 节点（来自 IDFT basis 乘法）
- [ ] ONNX 图中存在 `Pad` + `Add` 节点（来自手动 overlap-add）

## Phase 1: DML EP 验证（FP32）

- [ ] `ort.InferenceSession('onnx_models/vocoder_dml.onnx', providers=['DmlExecutionProvider', 'CPUExecutionProvider'])` 初始化无异常
- [ ] `session.get_providers()` 返回列表包含 `'DmlExecutionProvider'`
- [ ] 控制台无 `E_INVALIDARG` / `80070057` / `falling back to CPU` 警告
- [ ] 推理 mel `[1, 500, 128]` float32 输出 shape `[1, 240000]` 无错误
- [ ] 输出非全零（`np.any(out != 0)` 为 True）
- [ ] 输出无 NaN（`np.isnan(out).any()` 为 False）

## Phase 1: PyTorch 参考对比

- [ ] `VocosFullWrapper(model.vocoder).forward(mel)` 输出 shape = `[1, 240000]`
- [ ] PyTorch 输出与 ONNX 输出 shape 完全一致
- [ ] PyTorch 输出与 ONNX 输出 cosine similarity ≥ 0.99（粗略检查，正式精度验证在 Phase 2）

## Phase 2: 精度验证脚本更新

- [ ] `scripts/verify_module_precision.py` 的 `verify_vocoder` 函数 docstring 已更新（输出描述从 `spec(1,T,1922)` 改为 `waveform(1, T*hop)`）
- [ ] `verify_vocoder` 使用 `VocosFullWrapper` 而非 `VocoderBackboneWrapper`
- [ ] `export_shared` 导入语句包含 `VocosFullWrapper`
- [ ] 旧 `VocoderBackboneWrapper` 导入保留（其他模块可能仍用，或从 vocoder 验证中移除但保留在 import 中）

## Phase 2: 精度验证运行

- [ ] `python scripts/verify_module_precision.py --verbose` 执行无异常
- [ ] vocoder 模块 COS ≥ 0.99
- [ ] vocoder 模块 SNR ≥ 30 dB
- [ ] 其他模块（note_text_encoder / preflow / diff_step 等）精度未受影响（COS ≥ 0.99, SNR ≥ 30 dB，或 RELAXED_MODELS 的 0.95/25 dB）

## Phase 3: W16A32 量化兼容性

- [ ] `python export_step2_vocoder_w16a32.py` 执行无异常
- [ ] `onnx_models/fp16/vocoder_dml.onnx` 文件已更新
- [ ] `onnx_models/fp16/vocoder_dml.onnx.data` 文件已更新
- [ ] W16A32 ONNX 输入名 = `mel`，输出名 = `waveform`
- [ ] W16A32 ONNX 图中 DFT/STFT/Col2Im 节点数 = 0
- [ ] W16A32 ONNX Cast 节点数 > 0（FP16 weight → FP32 激活转换）
- [ ] W16A32 ONNX 中 `istft_*` 前缀的 initializer dtype = float32（FP32，未被量化）
- [ ] W16A32 ONNX 中 Linear/Conv weight initializer dtype = float16（FP16）
- [ ] `ort.InferenceSession('onnx_models/fp16/vocoder_dml.onnx', providers=['DmlExecutionProvider', 'CPUExecutionProvider'])` 初始化无异常
- [ ] W16A32 模型 `session.get_providers()` 包含 `'DmlExecutionProvider'`
- [ ] W16A32 推理 mel `[1, 500, 128]`（FP16 dtype）输出 `[1, 240000]` 无错误
- [ ] W16A32 vs FP32 输出对比 COS ≥ 0.99, SNR ≥ 30 dB

## Phase 4: 端到端验证

- [ ] 应用启动后 vocoder 加载新 `vocoder_dml.onnx` 成功（控制台无 EP 回退警告）
- [ ] 触发完整 SVS 合成无异常
- [ ] 合成输出音频非静音
- [ ] 合成输出音频无 NaN
- [ ] 合成输出音频长度正确（10s → 240000 样本，或与 mel 帧数 * 480 一致）

## 不变量检查

- [ ] `VocoderBackboneWrapper` 类未删除（`quantize_w8a8_v2.py` 第 239 行仍依赖）
- [ ] `export_shared.py` 中 `quantize_weights_to_fp16` 函数未被修改
- [ ] `export_shared.py` 中 `replace_stft` 函数未被修改（若存在）
- [ ] `export_step2_vocoder_w16a32.py` 脚本逻辑未被修改
- [ ] `src/inference/pipeline/postprocessing.js` 未被修改（已期望 `waveform`）
