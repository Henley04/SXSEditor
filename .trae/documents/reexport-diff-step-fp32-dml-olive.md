# 重新导出 diff_step FP32 DML 兼容模型（通过 Olive 优化）

## Summary

重新导出且仅重新导出 `diff_step_dml.onnx`（FP32, opset 20, DML 兼容），将 DML 兼容性优化从 `export_shared.py` 的自行实现（`fix_range_to_slice` 等）迁移至 Olive passes。当前模型因 `fix_range_to_slice` 产生 "Slice starts/ends shape mismatch" 错误而损坏，且 `modelLoader.js` 存在 DEBUG 覆盖强制 diff_step 走 CPU EP（这是日志显示 "loaded [CPU]" 的直接原因）。

## Current State Analysis

### 问题根因链
1. **`export_shared.py` 的 `fix_range_to_slice`**（第1627-1750行）：尝试用预计算 arange 表 + 动态 Slice 替换 Range 算子，但产生 `Slice starts/ends shape mismatch` 错误（`seq_len_int64` 形状为 `[]` 标量，与 `sl2_starts` 形状 `[1]` 不匹配）。当前 `diff_step_dml.onnx` 已被此函数损坏。
2. **`modelLoader.js` 第507-511行 DEBUG 覆盖**：强制 `diff_step_dml.onnx` 使用 CPU EP。这是用户日志中 "loaded [CPU]" 的直接原因，并非 DML 实际拒绝该模型。
3. **CPU EP 电流声**：onnxruntime-node 的 CPU EP 对非规范的 Range limit `[1,T,1024]`（应为标量）处理不正确，产生错误输出 → 电流声。
4. **FP16 对比证据**：FP16 版 diff_step（同样使用 `dynamo=True + SKIP_ROPE_PRECOMPUTE=1`，同样包含 Range 算子）在 DML 上正常运行。这表明 FP32 版在 DML 上大概率也能运行。

### Olive 可用 Passes（已安装 olive 0.12.1）
- `OnnxQuantizationPreprocess`：调用 ORT `quant_pre_process`，执行形状推断 + 优化 + auto_merge
- `OnnxPeepholeOptimizer`：onnxscript optimizer + Cast chain elimination + Reshape fusion
- `GraphSurgeries`：自定义图手术（需 user script，作为后备方案）
- 注：Olive 没有内置的 Range→Slice 替换 pass，但 FP16 模型证明 DML 可接受原生 Range

### I/O 契约（必须保持不变）
- 输入：`xt_input` [1, T, 128] FP32, `t` [1] FP32, `cond` [1, T, 1024] FP32, `xt_mask` [1, T] FP32
- 输出：`flow_pred` [1, T, 128] FP32
- 动态维度：seq_len (T)

## Proposed Changes

### 1. `export_shared.py` — 禁用 diff_step 的自行实现 DML 修复

在 `postprocess_onnx` 函数中添加 `skip_dml_fixes` 参数（默认 False），当 diff_step 导出时设为 True，跳过以下自行实现的 DML 修复：
- `fix_range_to_slice`（破损，必须跳过）
- `fix_dynamic_rope_slice`（SKIP_ROPE_PRECOMPUTE=1 时为 no-op，跳过无害）
- `resolve_neg1_in_reshape_shapes`（移至 Olive 处理或验证是否仍需要）

**具体修改**：
- `postprocess_onnx` 新增 `skip_dml_fixes: bool = False` 参数
- 当 `skip_dml_fixes=True` 时，跳过 `fix_dynamic_rope_slice`、`fix_range_to_slice`、`resolve_neg1_in_reshape_shapes`
- `export_fp32_opset20` 新增 `skip_dml_fixes` 参数并透传

**保留的 postprocess 步骤**（这些是通用 ONNX 优化，非 DML 特定）：
- `decompose_conv_transpose_dml`（diff_step 无 ConvTranspose，no-op）
- `replace_stft`（diff_step 无 STFT，no-op）
- `topological_sort`
- `shape_inference`
- `onnxsim`（通用图简化）
- `strip_metadata`

### 2. `export_step1_diffstep.py` — 调用导出时传入 skip_dml_fixes=True

修改 `export_fp32_opset20` 调用，添加 `skip_dml_fixes=True`：
```python
export_fp32_opset20(
    wrapper, args_tuple, output_path,
    input_names=input_names,
    output_names=output_names,
    dynamic_shapes={...},
    decompose_conv_transpose=False,
    fix_mixed_precision=False,
    skip_dml_fixes=True,  # 新增：DML 兼容性交给 Olive
)
```

### 3. 新建 `optimize_diff_step_olive.py` — Olive 优化脚本

创建专用脚本对 diff_step 应用 Olive passes，参照现有 `optimize_onnx.py` 模式：

```python
# Olive passes 顺序：
# 1. OnnxQuantizationPreprocess(skip_symbolic_shape=True)
#    - ORT 形状推断 + 优化 + auto_merge
#    - 处理符号形状问题（可能解决 Reshape -1 问题）
# 2. OnnxPeepholeOptimizer(onnxscript_optimize=True, eliminate_cast_chains=True)
#    - onnxscript optimizer 通用图优化
#    - Cast chain 消除（dynamo 导出常产生冗余 Cast 往返）
#    - Reshape 融合
```

**脚本结构**：
- 输入：`onnx_models/diff_step_dml.onnx`（导出后、Olive 优化前）
- 输出：覆盖 `onnx_models/diff_step_dml.onnx`（Olive 优化后）
- 临时工作目录：`onnx_models/_olive_diff_step_work/`（完成后清理）
- AcceleratorSpec：**GPU + DmlExecutionProvider**（参照 `_olive_convert_jp.py`，针对 DML 优化）
  ```python
  from olive.hardware.accelerator import AcceleratorSpec, Device
  from olive.hardware.constants import ExecutionProvider
  ACCEL_SPEC = AcceleratorSpec(
      accelerator_type=Device.GPU,
      execution_provider=ExecutionProvider.DmlExecutionProvider,
  )
  ```
  这样 Olive passes 会针对 DML EP 生成最优图结构。

### 4. `src/inference/pipeline/modelLoader.js` — 移除 DEBUG 覆盖

删除第507-511行的 DEBUG 代码：
```javascript
// 删除以下代码：
// DEBUG: FORCE CPU EP for diff_step to test if issue is DML-specific
if (modelName === 'diff_step_dml.onnx') {
    console.log('[DEBUG] FORCING CPU EP for diff_step_dml.onnx (DEBUG ONLY)');
    sessionOptions.executionProviders = ['cpu'];
}
```

同时修复第515-516行受影响的条件判断，恢复正常的 DML 加载逻辑。

### 5. `test_precision.py` — 已有，无需修改

现有精度测试已覆盖 diff_step 的 PyTorch vs ONNX CPU vs ONNX DML 对比。

## Assumptions & Decisions

### 核心假设
1. **FP32 模型在 DML 上可运行 Range 算子**：基于 FP16 版本（相同 dynamo=True + Range 模式）在 DML 上正常运行的证据。若此假设不成立，需启用后备方案。

2. **Olive OnnxQuantizationPreprocess + OnnxPeepholeOptimizer 足以处理 DML 兼容性**：这两个 pass 提供形状推断、图优化、Cast 消除，足以清理 dynamo 导出产生的冗余节点。`resolve_neg1_in_reshape_shapes` 可能不再需要（onnxsim + ORT 优化应能处理）。

### 后备方案（若 DML 仍拒绝 Range）
若步骤 4 验证发现 DML EP 确实拒绝 FP32 模型的 Range 算子，则启用 Olive `GraphSurgeries` pass 编写自定义手术脚本替换 Range→预计算表+Slice。但这属于"使用 Olive 框架实现自定义手术"，需用户确认是否接受。

### 决策记录
- **不使用 Olive OnnxConversion**：该 pass 需要包装 PyTorch 模型为 PyTorchModelHandler，增加复杂度，且其核心功能（torch.onnx export + optimize）已被现有导出脚本覆盖。
- **保留 dynamo=True + SKIP_ROPE_PRECOMPUTE=1**：这是 FP16 成功路径的相同配置，产生原生 Range + Sin/Cos RoPE，避免预计算大表。
- **保留 onnxsim**：通用图简化，非 DML 特定，对所有模型有益。

## Verification Steps

### 步骤 1：导出 diff_step
```bash
cd d:\Document\electron\SXSEditor
python export_step1_diffstep.py
```
预期：导出成功，无 Slice shape mismatch 错误，节点数约 1300-1400（dynamo 原生 Range）。

### 步骤 2：Olive 优化
```bash
python optimize_diff_step_olive.py
```
预期：OnnxQuantizationPreprocess + OnnxPeepholeOptimizer 成功执行，节点数不显著增加。

### 步骤 3：Python ORT 精度测试
```bash
python test_precision.py
```
预期：diff_step COS(PyTorch vs DML) > 0.999, SNR > 30dB, NaN=0。

### 步骤 4：Node.js DML 测试（关键验证）
移除 modelLoader.js DEBUG 覆盖后，运行应用合成：
- 验证日志显示 `diff_step_dml.onnx loaded [DML]`（非 CPU）
- 验证音频输出正常（无电流声）
- 验证 diffusion 输出无 NaN

### 步骤 5：Git 备份
验证全部通过后，提交变更。

## File Impact Summary

| 文件 | 操作 | 说明 |
|------|------|------|
| `export_shared.py` | 编辑 | `postprocess_onnx` + `export_fp32_opset20` 新增 `skip_dml_fixes` 参数 |
| `export_step1_diffstep.py` | 编辑 | 调用 `export_fp32_opset20` 时传入 `skip_dml_fixes=True` |
| `optimize_diff_step_olive.py` | 新建 | Olive 优化脚本（OnnxQuantizationPreprocess + OnnxPeepholeOptimizer） |
| `src/inference/pipeline/modelLoader.js` | 编辑 | 删除第507-511行 DEBUG 覆盖，修复第515-516行条件判断 |
| `onnx_models/diff_step_dml.onnx` | 重新生成 | 导出 + Olive 优化后的新模型 |
| `test_precision.py` | 无修改 | 现有测试已覆盖 |
