# TRT-RTX 2048 帧边界数值错误：根因分析与修复

> 日期：2026-09-26（FP16）｜ 2026-11-12（FP32）｜ 影响：`NvTensorRTRTXExecutionProvider`（WinML 插件 EP）动态形状路径
> 状态：**已根因修复并部署**（模型级修复，非缓解）
> 关键文件：`scripts/make_diff_step_rope_table.py`（修复）、`scripts/probe_trt_rope.js`（验证）、
> `src/inference/shared/constants.js`（`DIFF_STEP_MAX_SEQ_LEN`）

## 摘要

TensorRT-RTX 的 Myelin 融合内核以 **11 位尾数网格**执行 rope 位置编码链中的 fp32 位置
MatMul（`position × inv_freq`）：序列位置 ≥ 2049 时被舍入到最近偶数（2049 → 2050），
每个受影响帧产生 ±inv_freq 的相位误差，rope 嵌入逐通道偏差最大约 0.95，污染全部 22 层
attention，经 32 步扩散迭代放大为**合成音频尾部能量凹陷/静音**。

修复方式：把 rope 的 cos/sin 表**离线烘焙为权重初始化器**（fp64 数学 + fp32 相位仿真 +
fp16/fp32 存储，与各精度图末端的 Cast 一致），运行时仅做 Slice 取行——纯数据搬运，
引擎内不再存在任何绝对位置算术，bug 从结构上不可达。模型 I/O 契约不变。

> 同一脚本同时覆盖 FP16 与 FP32 两种 diff_step 导出：FP16 图末端有
> `Cast(FLOAT→FLOAT16)`，表存 fp16；FP32 图无该 Cast，表存 fp32。

## 1. 问题现象

- 仅 TRT-RTX 动态形状路径（WinML 桥接，`NvTensorRTRTXExecutionProvider`）受影响；
  DML / CPU / 静态形状（int8/NPU）路径完全正常。
- prompt + target 总帧数 ≤ 2047 时输出与 DML 逐位一致；≥ 2048 时从第 2048 帧起
  flow_pred 与 DML 的逐帧余弦塌缩到约 0.97，32 步扩散放大后表现为长片段合成音频
  **尾部能量凹陷直至静音**。
- 历史缓解措施：pipeline 将 TRT-RTX 动态序列钳制到 2047（`TRT_RTX_MAX_DYNAMIC_SEQ_LEN`，
  已随本修复移除）。

## 2. 排查方法

### 2.1 探针模型

`scripts/make_trt_rope_probe.py` 在原模型上追加 19 个图输出，覆盖 rope 链全部中间张量
（arange → Cast → MatMul → Transpose → Concat → cos/sin → Cast → attention 内部），
使 TRT 引擎内部的每一步都可以与 DML/CPU 逐位对照。

### 2.2 三 EP 逐帧比对

`scripts/probe_trt_rope.js` 在同一进程内用同一份输入分别跑 TRT（经
`winmlProvider.tryCreateWinMLSession`，即应用真实候选链）、DML、CPU，沿 seq 轴逐帧计算
余弦，并区分 `badPre2048` / `badPost2048`。纯 Node 环境复现要点：

```bash
SXS_ORT_BRIDGE_PATH=.webpack/main/native/ort_bridge.node \
PROBE_MODEL=onnx_models/fp16/diff_step_fixed.onnx SKIP_BASELINE=1 \
node scripts/probe_trt_rope.js 2100
```

### 2.3 逐帧逐通道原始值

`scripts/probe_trt_rope_detail.js` 打印中间张量逐帧逐通道数值，用于锁定首个出错节点
与出错模式。

## 3. 定位过程：量化指纹判别

对候选假设逐一构造判别指纹：

| 假设 | 预测指纹 | 实测 | 结论 |
|------|----------|------|------|
| 位置索引 mod-2048 回绕 | 2048 帧起出现 0 值相位（灾难性错误） | 否 | **排除** |
| fp16 相位量化 | 位置约 683（2^11 × 相对精度）起即出错 | 否 | **排除** |
| int64 位置张量错误 | arange 输出有差异 | maxAbsDiff = 0 | **排除** |
| **fp32 位置 MatMul 网格量化** | ≥2049 起出错，且只错**奇数**帧 | 吻合 | **根因** |

锁定 `node_matmul` 的决定性证据：

- seq=2049 时该输出第 2049 帧，TRT = **2050.0**，DML = **2049.0**，差恰为 `1.0 × inv_freq`
  （ω=1.0 通道）——正是位置被舍入到 2050 的指纹；
- 出错帧**全部为奇数**（odd = 26，even = 0）：11 位尾数（含隐藏位）可精确表示 0..2048，
  2049..4096 中的奇数无法表示，舍入到最近偶数；偶数位置不受影响；
- 此前所有中间张量（int64 位置、inv_freq）均逐位一致，fp32 相位是**首个出错点**。

### 误差传播链

```
2049 → 2050 (Myelin 11-bit 舍入)
  → 相位误差 ±inv_freq（ω=1.0 通道 1.0 rad）
  → rope cos/sin 逐通道偏差至 ~0.95
  → 22 层 DiffLlama attention 的 q/k 旋转全部被污染
  → 32 步扩散迭代放大
  → 合成音频尾部能量凹陷/静音
```

## 4. 为什么不能在引擎内修

1. **TRT-RTX EP 无精度控制选项**：官方文档的 EP 选项表中没有任何 TF32 开关、
   fp32 强制执行或融合粒度控制。
2. **fp64 借道无效（已实测推翻）**：`scripts/fix_diff_step_trt_rope.py` 曾尝试
   `Cast(fp32→fp64) → fp64 MatMul → Cast(fp64→fp16)`，结果与术前**逐位一致**。
   用 `nv_dump_subgraphs` dump TRT 子图发现 DOUBLE 节点被**静默吸收**进引擎降级执行；
   只有当 DOUBLE 作为图输出绑定时才报 `EP_FAIL`。
3. **结论**：引擎内计算的任何绝对位置都不可信。位置信息必须变成**常量数据**。

## 5. 修复：烘焙 rope 表

`scripts/make_diff_step_rope_table.py` 对模型做图手术：

### 5.1 数值一致性（与原图逐位对齐）

```python
inv32   = expand_1 的值（inv_freq = 0.75^i, i=0..31）       # 从 initializer 读出
phase32 = np.outer(pos, inv32)                              # fp32 外积，复现原 fp32 MatMul 的乘积舍入
cos32   = np.cos(phase32.astype(np.float64)).astype(fp32)   # fp64 算 cos，避免 CPU libm 差异
cos64   = np.concatenate([cos32, cos32], axis=1)            # 复现 node_cat_1 的 64 通道布局（32 通道重复两遍）
table   = cos64.astype(fp16)                                # fp16 图：与原图 Cast(FLOAT→FLOAT16) 同一舍入
                                                            # fp32 图：直接 astype(fp32)，保留原精度
```

### 5.2 图手术

- **FP16 图删除** 12 节点链：`node_arange_1, node_unsqueeze_2, node_view, node_unsqueeze_7,
  node__to_copy_2, node_matmul, node_transpose, node_cat_1, node_cos_1, node_sin_1,
  node__to_copy_3, node__to_copy_4`
- **FP32 图删除** 10 节点链（无末尾两个 Cast）：`node_arange_1, node_unsqueeze_2,
  node_view, node_unsqueeze_7, node__to_copy_1, node_matmul, node_transpose, node_cat_1,
  node_cos_1, node_sin_1`
- **新增** 2 个 initializer：`rope_cos_table` / `rope_sin_table`（[1, 8192, 64]；
  FP16 图存 fp16，FP32 图存 fp32，覆盖位置 0..8191 ≈ 163.8s @ 50fps）
- **新增** 4 个胶水节点：`Unsqueeze(seq_len)` → `Concat(ends)` → `Slice ×2`
  （`starts=[0,0,0], axes=[0,1,2]`，ends 的 seq 维动态取自 `sym_size_int_5`）
- **改线**：FP16 图 `node_unsqueeze_9/10` 的输入从 `_to_copy_3/_to_copy_4` 改接
  `rope_cos_slice / rope_sin_slice`；FP32 图从 `cos_1/sin_1` 改接同两个 Slice 输出
- **清理**：孤儿 value_info（FP16 12 个 / FP32 10 个）与孤儿 initializer
  （FP16 `val_26/val_27/expand_1`，FP32 `val_25/val_26/expand_1`），
  否则每次加载都产生 ORT `CleanUnused` 警告
- **不变量**：I/O 契约与张量精度不变（FP16 图全 fp16，FP32 图全 fp32），
  qdrift `wrapDiffSession` 等下游零改动

### 5.3 安全性论证

- 运行时只剩 **Slice**（纯数据搬运 + 形状运算），TRT 无法在数据搬运中引入数值误差；
- 原图消费者数量经脚本 sanity 校验（每个被删张量的消费者数与预期一致）；
- seq > 8192 时 Slice 钳制输出 8192 行，与 attention 的 `[1, seq, ·, 64]` 广播失败 →
  ORT 硬错误。由 pipeline 的 `_clampDiffStepMaxFrames`（`DIFF_STEP_MAX_SEQ_LEN = 8192`）
  优雅兜底（先截 prompt，超 163.8s 才截 target）。

## 6. 验证结果

同一 probe 三 EP 同输入比对（负值 firstBad 表示无坏帧）：

| 模型 | seq | minCos | 首个坏帧 | maxAbsDiff | 结论 |
|------|-----|--------|----------|------------|------|
| 修复前 | 2100 | ≈0.97（自第 2048 帧塌缩） | 2048 | — | 复现 bug |
| 修复后 | 1950 | 0.9986（原模型 0.9991，噪声底） | -1 | — | 无退化 |
| 修复后 | 2100 | **0.998607** | **-1** | 2.661e-2 | 边界 bug 消失 |
| 修复后 | 4096 | ≈0.998 | -1 | — | 深水区通过 |

补充验证：

- 孤儿 initializer 清理后 `CleanUnused` 警告计数为 0（`probe_fixed_final.log`）；
- 修复模型自包含（0 个外部数据引用），体积 +2.08MB = 恰好两张 rope 表
  （8192 × 64 × 2B × 2）；
- DML/CPU 与修复前输出一致（rope 表在 DML/CPU 上同样正确）。

FP32 模型补充验证（与原图逐位对照）：

| 检查 | 结果 |
|------|------|
| 烘焙表 vs 原图运行时 rope 链（位置 0..8191） | cos 最大偏差 5.96e-8，sin 1.19e-7 |
| 修复版 vs 备份整模型（seq=2100, CPU） | cos = 1.000000075，minFrameCos = 0.999999830，maxAbsDiff = 1.216e-5 |
| 修复版 vs 备份整模型（seq=2100, DML） | cos = 1.000000107，maxAbsDiff = 2.164e-4 |
| 图结构 | 1314 → 1308 节点；删除 10 节点，新增 4 胶水节点 + 2 张 fp32 表（+4.19MB） |

## 7. 部署与代码变更

| 项 | 变更 |
|----|------|
| 模型（FP16） | 修复版改名部署为 `onnx_models/fp16/diff_step_dml.onnx`；原版备份为 `diff_step_dml.onnx.bak` |
| 模型（FP32） | 修复版部署为 `onnx_models/diff_step_dml.onnx`；原版备份为 `diff_step_dml.onnx.bak`（外部权重 `diff_step_dml.onnx.data` 不变） |
| 修复脚本 | `scripts/make_diff_step_rope_table.py` 自动识别 FP16/FP32 图尾并选择表 dtype |
| `shared/constants.js` | `TRT_RTX_MAX_DYNAMIC_SEQ_LEN(2047)` → `DIFF_STEP_MAX_SEQ_LEN(8192)`（rope 表容量，对所有 EP 生效） |
| `pipeline/index.js` | `_clampTrtRtxDynamicFrames` + `_isTrtRtxDynamicDiffStep` → `_clampDiffStepMaxFrames`（通用容量兜底，无 TRT 门控；`SXS_DIAG_NO_TRTCLAMP` 保留） |
| `pipeline/constants.js` | 导入/导出同步重命名 |
| `winml/trtDiagnostic.js` | diffStep 探测序列 `[32,512,1950]` → `[32,512,1950,2100]`：2100 跨过旧 bug 边界，将来模型若退化为未修复版本，诊断报告的 trtVsDml cosine 会塌缩报警；FP32 精度下 feeds 改用 float32 张量（原固定 float16，FP32 模型会输入类型不匹配） |
| qdrift | 无需改动（I/O 契约不变） |

> 备注：`onnx_models/JP/diff_step_dml.onnx`（FP32）是静态 100 帧导出，图中不含动态
> rope 位置链（无 Range / 位置 MatMul），因此不涉及本修复；其 I/O 精度与形状均未改动。

## 8. 维护注意事项

⚠️ **重导出模型会退化回未修复版**。`tools/export_fp16_onnx_dynamo.py` 等导出脚本产出
的 diff_step 不含 rope 烘焙。重导出后必须重跑（脚本自动识别 FP16/FP32）：

```bash
# FP16
C:\Users\15240\AppData\Local\Python\bin\python.exe scripts/make_diff_step_rope_table.py \
  --input onnx_models/fp16/diff_step_dml.onnx --output onnx_models/fp16/diff_step_fixed.onnx

# FP32
C:\Users\15240\AppData\Local\Python\bin\python.exe scripts/make_diff_step_rope_table.py \
  --input onnx_models/diff_step_dml.onnx --output onnx_models/diff_step_fixed.onnx
```

再验证 + 部署。快速回归检查：trtDiagnostic（seq=2100 的 trtVsDml cosine 应 ≈1）
或 `scripts/probe_trt_rope.js 2100`。

其他注意：

- 修复脚本的 CHAIN/消费者数校验绑定在当前图拓扑上；若导出图结构变化（节点名改变），
  脚本会以 `expected node missing` 显式失败，需同步更新节点清单；
- `SXS_DIAG_NO_TRTCLAMP=1` 仍是诊断用的钳制旁路（现仅影响 >8192 帧的极端输入）；
- TRT-RTX 引擎内计算的任何东西都不可用于绝对位置/高精度需求——本结论对今后新增
  图内位置/索引类算术同样适用，一律离线烘焙为常量。
