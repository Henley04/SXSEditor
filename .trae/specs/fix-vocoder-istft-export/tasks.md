# Tasks

## Phase 1: 验证现有 wrapper 修改导出成功

- [ ] Task 1: 重新运行导出脚本，验证手动 Pad+Add 版本导出成功
  - [ ] SubTask 1.1: 执行 `python export_step2_vocoder.py`，确认导出无异常，输出文件 `onnx_models/vocoder_dml.onnx` 与 `.data` 已更新
  - [ ] SubTask 1.2: 用 `python -c "import onnx; ..."` 检查 ONNX 算子列表：确认 `DFT`/`STFT`/`Col2Im` 节点数均为 0，`MatMul`/`Add`/`Pad` 节点存在
  - [ ] SubTask 1.3: 检查 ONNX 输入 `mel` shape `[1, 500, 128]`，输出 `waveform` shape `[1, 240000]`，dtype = float32
- [ ] Task 2: 验证 DML EP 可加载并推理（FP32 模型）
  - [ ] SubTask 2.1: 用 onnxruntime 加载 `onnx_models/vocoder_dml.onnx`，providers=['DmlExecutionProvider', 'CPUExecutionProvider']
  - [ ] SubTask 2.2: 检查 `session.get_providers()` 包含 `DmlExecutionProvider`（未回退 CPU）
  - [ ] SubTask 2.3: 推理 mel `[1, 500, 128]`（随机或真实 mel），确认输出 `[1, 240000]` 无错误、非全零、无 NaN
- [ ] Task 3: 验证 PyTorch 参考与 ONNX 输出 shape 一致
  - [ ] SubTask 3.1: 用同一 mel 输入分别跑 `VocosFullWrapper(model.vocoder)` 和 ONNX，确认两者 shape 均为 `[1, 240000]`
  - [ ] SubTask 3.2: 若 shape 不一致，检查 `_overlap_add` 边界裁剪逻辑（`out[:, self.pad:-self.pad]`）

## Phase 2: 更新精度验证脚本

- [ ] Task 4: 修改 `scripts/verify_module_precision.py` 的 `verify_vocoder` 函数
  - [ ] SubTask 4.1: 从 `export_shared` 导入 `VocosFullWrapper`（替换或并存 `VocoderBackboneWrapper` 导入）
  - [ ] SubTask 4.2: 将 `wrapper = VocoderBackboneWrapper(model.vocoder)` 改为 `wrapper = VocosFullWrapper(model.vocoder).eval()`
  - [ ] SubTask 4.3: 更新 docstring：输出从 `spec(1,T,1922)` 改为 `waveform(1, T*hop)`，并说明用完整 Vocos 前向作为参考
  - [ ] SubTask 4.4: 确认 ONNX 输入 shape 从 session 读取后，mel_torch 直接传给 `VocosFullWrapper`（wrapper 内部做 transpose）
- [ ] Task 5: 运行精度验证
  - [ ] SubTask 5.1: 执行 `python scripts/verify_module_precision.py --verbose`，仅检查 vocoder 模块（或全量运行但聚焦 vocoder）
  - [ ] SubTask 5.2: 确认 vocoder 模块 COS ≥ 0.99 且 SNR ≥ 30 dB（若未达，分析 IDFT basis 精度、window envelope 边界）
  - [ ] SubTask 5.3: 若精度不达标，检查 `_overlap_add` 实现是否与 `torch.nn.functional.fold` 在边界处等价（特别是 `pad` 裁剪位置）

## Phase 3: 验证 FP16 量化兼容性

- [ ] Task 6: 运行 W16A32 量化脚本
  - [ ] SubTask 6.1: 执行 `python export_step2_vocoder_w16a32.py`
  - [ ] SubTask 6.2: 检查输出日志：Cast 节点数 > 0（每个 FP16 weight 后插入 Cast），`istft_*` initializer 保持 FP32（不被量化）
  - [ ] SubTask 6.3: 检查 `fp16/vocoder_dml.onnx` 输入 `mel`、输出 `waveform`，DFT/STFT/Col2Im 节点数 = 0
- [ ] Task 7: 验证 W16A32 模型 DML EP 可加载并推理
  - [ ] SubTask 7.1: 用 onnxruntime 加载 `fp16/vocoder_dml.onnx`，providers=['DmlExecutionProvider', 'CPUExecutionProvider']
  - [ ] SubTask 7.2: 确认 `session.get_providers()` 包含 `DmlExecutionProvider`
  - [ ] SubTask 7.3: 推理 mel `[1, 500, 128]`（FP16 dtype），确认输出 `[1, 240000]` 无错误
  - [ ] SubTask 7.4: 对比 W16A32 与 FP32 输出（用 `calibrate/verify_real_precision.py` 或手动对比），COS ≥ 0.99, SNR ≥ 30 dB

## Phase 4: 端到端验证与备份

- [ ] Task 8: 端到端验证（FP32 主路径）
  - [ ] SubTask 8.1: 启动应用，确认 vocoder 加载新 `vocoder_dml.onnx` 成功（控制台无 EP 回退警告）
  - [ ] SubTask 8.2: 触发一次完整 SVS 合成，确认输出音频非静音、无 NaN、长度正确（10s → 240000 样本）
- [ ] Task 9: Git 备份（不单独 commit，由主流程统一提交）
  - [ ] SubTask 9.1: 所有验证通过后，提示主流程统一 `git add` 修改的文件（`export_shared.py`, `export_step2_vocoder.py`, `scripts/verify_module_precision.py`, `onnx_models/vocoder_dml.onnx`, `onnx_models/fp16/vocoder_dml.onnx`, `.trae/specs/fix-vocoder-istft-export/`）
  - [ ] SubTask 9.2: 由主流程决定 commit message 与推送时机

# Task Dependencies
- Task 2 依赖 Task 1（需导出后才能验证 DML 加载）
- Task 3 依赖 Task 1（需导出后才能对比 shape）
- Task 5 依赖 Task 4（需更新脚本后才能运行验证）
- Task 6 依赖 Task 1（需新 FP32 模型作为量化输入）
- Task 7 依赖 Task 6（需量化后才能验证 W16A32 DML）
- Task 8 依赖 Task 2 + Task 5 + Task 7（FP32 DML、精度、W16A32 全部通过）
- Task 9 依赖 Task 8（端到端验证通过后才备份）

# 可并行任务
- Task 3（PyTorch shape 对比）与 Task 2（DML EP 验证）可并行（均依赖 Task 1）
- Task 4（脚本修改）可在 Task 1 完成后立即开始（不依赖 DML 验证结果）
