# 重新导出 diff_step FP32 DML 模型（Olive 优化路线）— 续接计划

## Summary

续接上一会话的执行进度。`diff_step` 模型已使用 `dynamo=True + dynamic_shapes + SKIP_ROPE_PRECOMPUTE=1` 重新导出（FP32, opset 20, 1314 节点, 0.17MB .onnx + 1688MB .onnx.data），并在 [export_shared.py](file:///d:/Document/electron/SXSEditor/export_shared.py) 中新增 `skip_dml_fixes` 参数以将 DML 兼容性优化委托给 Olive。[modelLoader.js](file:///d:/Document/electron/SXSEditor/src/inference/pipeline/modelLoader.js) 中强制 diff_step 走 CPU 的 DEBUG 覆盖已移除。

当前唯一阻塞项：[optimize_diff_step_olive.py](file:///d:/Document/electron/SXSEditor/optimize_diff_step_olive.py) 的输出复制逻辑会导致文件大小翻倍（3376MB 而非 1688MB），需要修复后再运行 Olive 优化、精度测试和 git 备份。

## Current State Analysis

### 已完成
- [export_shared.py](file:///d:/Document/electron/SXSEditor/export_shared.py#L1755): `postprocess_onnx` 和 `export_fp32_opset20` 已添加 `skip_dml_fixes` 参数
- [export_step1_diffstep.py](file:///d:/Document/electron/SXSEditor/export_step1_diffstep.py#L74): 已使用 `skip_dml_fixes=True`，导出干净模型
- [optimize_diff_step_olive.py](file:///d:/Document/electron/SXSEditor/optimize_diff_step_olive.py): 已创建，使用 `AcceleratorSpec(Device.GPU, DmlExecutionProvider)`，包含 OnnxQuantizationPreprocess + OnnxPeepholeOptimizer 两个 pass
- [modelLoader.js](file:///d:/Document/electron/SXSEditor/src/inference/pipeline/modelLoader.js#L507): DEBUG 覆盖已移除，diff_step 现在会真正尝试 DML EP
- `onnx_models/diff_step_dml.onnx`: 干净状态（0.17MB + 1688MB data, 1314 节点）

### 待解决问题：Olive 输出文件大小翻倍

**根因分析**（基于代码审查）：

1. `OnnxQuantizationPreprocess._quant_preprocess` 调用 `quant_pre_process(save_as_external_data=True)`，输出 `preprocessed/diff_step_dml.onnx` (小) + `preprocessed/diff_step_dml.onnx.data` (1688MB) ✓ 正确

2. `OnnxPeepholeOptimizer` 通过 `onnx.load(model.model_path)` 加载模型（默认 `load_external_data=True`，数据加载到内存）。`model_proto_to_olive_model` 保存时使用 `get_external_data_config()` 的默认值 `save_as_external_data=False`。由于模型 1688MB < 2GB (MAXIMUM_PROTOBUF)，`model_proto_to_file` 不会强制启用 external data，数据被内联到 `peephole/diff_step_dml.onnx` (1688MB)。

3. 当前 [optimize_diff_step_olive.py](file:///d:/Document/electron/SXSEditor/optimize_diff_step_olive.py#L89-L102) 的复制逻辑：
   - `shutil.copy2(final_model_path, MODEL_PATH)` 复制 1688MB 的 .onnx（含内联数据）到目标
   - `final_model_path.with_suffix(".onnx.data")` 在 Python 3.12+ 会抛 ValueError（多扩展名），或行为不一致
   - `final_model_path.parent.glob("*.data")` 可能复制无关的 .data 文件
   
   最终结果：目标 .onnx (1688MB 内联) + 意外存在的 .data (1688MB) = 3376MB

## Proposed Changes

### 1. 修复 `optimize_diff_step_olive.py` 的输出保存逻辑

**文件**: [optimize_diff_step_olive.py](file:///d:/Document/electron/SXSEditor/optimize_diff_step_olive.py)

**修改 1a**: 在 `OnnxPeepholeOptimizer.generate_config` 中显式启用 external data 格式，与 `OnnxQuantizationPreprocess` 保持一致：

```python
peephole_config = OnnxPeepholeOptimizer.generate_config(
    ACCEL_SPEC,
    {
        "onnxscript_optimize": True,
        "onnxoptimizer_optimize": True,
        "fuse_reshape_operations": True,
        "cast_chain_elimination": True,
        # 显式启用 external data 格式，避免 1688MB 数据内联到 .onnx 文件
        "save_as_external_data": True,
        "all_tensors_to_one_file": True,
        # external_data_name=None 时默认为 <model_path_name>.data
        "size_threshold": 1024,
    },
)
```

**修改 1b**: 替换 `shutil.copy2` 复制逻辑为 `onnx.save_model` 直接保存到 `MODEL_PATH`，确保 external data 格式正确：

```python
# Copy final output to target location with proper external data format
logger.info("\n--- Saving final output with external data format ---")
import onnx

# Load the final model proto (with external data loaded into memory)
final_model_path = Path(model.model_path)
final_proto = onnx.load(str(final_model_path), load_external_data=True)

# Remove old output files
if MODEL_PATH.exists():
    MODEL_PATH.unlink()
old_data = MODEL_PATH.with_name(MODEL_PATH.name + ".data")
if old_data.exists():
    old_data.unlink()

# Save with external data format: .onnx (small) + .onnx.data (large)
onnx.save_model(
    final_proto,
    str(MODEL_PATH),
    save_as_external_data=True,
    all_tensors_to_one_file=True,
    location=MODEL_PATH.name + ".data",
    size_threshold=1024,
)
```

**修改 1c**: 更新输出大小统计，正确计算 .onnx + .onnx.data 的总大小：

```python
output_size = MODEL_PATH.stat().st_size / (1024 * 1024)
output_data = MODEL_PATH.with_name(MODEL_PATH.name + ".data")
if output_data.exists():
    output_size += output_data.stat().st_size / (1024 * 1024)
logger.info(f"Output model: {MODEL_PATH.name} ({output_size:.1f} MB)")
```

**理由**: 
- 显式启用 `save_as_external_data=True` 确保 PeepholeOptimizer 输出正确拆分为 .onnx + .onnx.data
- 使用 `onnx.save_model` 直接保存到 `MODEL_PATH` 避免复制逻辑的 `with_suffix` 多扩展名问题
- `load_external_data=True` 确保数据加载到内存后再保存，避免外部数据引用路径问题

### 2. 运行 Olive 优化

**命令**: `python optimize_diff_step_olive.py`

**预期输出**:
- `diff_step_dml.onnx`: ~0.2MB
- `diff_step_dml.onnx.data`: ~1688MB
- 总大小: ~1688MB（与输入一致，不翻倍）
- 节点数: 应保持 ~1314 或略减（窥孔优化可能消除冗余 Cast/Reshape）

### 3. 运行精度测试

**命令**: `python test_precision.py`

**验证标准**（来自 [test_precision.py](file:///d:/Document/electron/SXSEditor/test_precision.py#L166-L172)）:
- `test_diff_step()`: NaN=0, COS(PyTorch vs DML) > 0.999, SNR(PyTorch vs DML) > 30dB
- 同时运行 `test_mel_transform()` 和 `test_vocoder()` 作为回归测试（这两个模型本次未修改，应继续通过）

**关键验证点**: 
- ONNX DML 推理无 NaN（验证 DML EP 兼容性）
- 精度达标（验证 Olive 优化未破坏数值精度）

### 4. Git 备份

**规则遵循**（来自 [.trae/rules/readme.md](file:///d:/Document/electron/SXSEditor/.trae/rules/readme.md)）:
- 精度测试通过后执行 git 备份
- commit message 使用英文
- 不单独开分支

**Commit 内容**:
- 修改: `export_shared.py` (skip_dml_fixes 参数)
- 修改: `export_step1_diffstep.py` (skip_dml_fixes=True)
- 修改: `modelLoader.js` (移除 DEBUG 覆盖)
- 新增: `optimize_diff_step_olive.py`
- 二进制: `onnx_models/diff_step_dml.onnx` + `onnx_models/diff_step_dml.onnx.data`（注意 .data 在 .gitignore 中，仅提交 .onnx）

**Commit message 示例**:
```
Re-export diff_step FP32 with Olive DML optimization

- Add skip_dml_fixes parameter to export_shared.py to delegate DML
  compatibility to Olive
- Export diff_step with dynamo=True + dynamic_shapes + native Range RoPE
- Create optimize_diff_step_olive.py using GPU+DML AcceleratorSpec
- Remove DEBUG override in modelLoader.js that forced diff_step to CPU
```

## Assumptions & Decisions

1. **假设**: Olive 0.12.1 的 `OnnxPeepholeOptimizer` 和 `OnnxQuantizationPreprocess` 通过 `get_external_data_config()` 支持 `save_as_external_data` 配置项（已通过阅读源码确认）

2. **假设**: `onnx.load(path, load_external_data=True)` + `onnx.save_model(save_as_external_data=True)` 能正确处理 1688MB 模型（已通过 `export_shared.py` 中 `postprocess_onnx` 的相同模式验证）

3. **决策**: 不修改 `OnnxQuantizationPreprocess` 的配置（它已默认使用 `save_as_external_data=True`），仅修改 `OnnxPeepholeOptimizer` 配置

4. **决策**: 不重新导出模型（当前 `diff_step_dml.onnx` 已是干净的 dynamo=True 导出状态），仅修复 Olive 脚本并重新运行

5. **决策**: 精度测试使用现有 `test_precision.py`，不新增测试脚本

## Verification Steps

1. **修复后运行 Olive 优化**:
   ```
   python optimize_diff_step_olive.py
   ```
   验证输出: 总大小 ~1688MB（非 3376MB），节点数 ~1314

2. **精度测试**:
   ```
   python test_precision.py
   ```
   验证输出: `diff_step: ✅ PASS` (NaN=0, COS>0.999, SNR>30dB)

3. **DML 加载验证**: 精度测试中的 `test_diff_step()` 已包含 `DmlExecutionProvider` 推理，若通过即验证 DML 兼容性

4. **Git 状态检查**:
   ```
   git --no-pager status
   git --no-pager diff --stat
   ```
   确认仅修改预期文件

5. **Git 提交**:
   ```
   git add export_shared.py export_step1_diffstep.py optimize_diff_step_olive.py src/inference/pipeline/modelLoader.js onnx_models/diff_step_dml.onnx
   git commit -m "..."
   ```

## Out of Scope

- 不修改其他模型（mel_transform, vocoder, encoders 等）
- 不修改 `test_precision.py` 测试逻辑
- 不更新 README（本次改动是 bugfix 性质，非新功能）
- 不打包测试（`npm run package:lite`），仅运行 Python 精度测试
