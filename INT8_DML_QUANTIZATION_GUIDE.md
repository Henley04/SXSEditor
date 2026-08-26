# SoulX-Singer diff_step 高精度 DML INT8 加速量化指令

> 目标：从 FP32 模型出发，构建一个 **精度高（cos≥0.9，SNR≥0）且能在 ONNX-DirectML 上利用 INT8 张量核加速** 的 diff_step 模型，并部署到 `onnx_models/int8/`、接入 Electron 推理管线。

---

## 1. 目标与验收标准

| 指标 | 要求 |
|---|---|
| 与 FP32 输出的 cos_sim（真实 eval 2048 序列） | ≥ 0.90 |
| SNR（真实 eval 2048 序列） | ≥ 0 dB |
| 模型体积 | ≤ 900 MB（FP32 的 4x 压缩，即 ~425 MB） |
| DML EP 推理 | 可跑、有 INT8 权重加速（非纯 FP32 降级） |
| 部署 | 替换 `onnx_models/int8/diff_step_dml.onnx`，modelLoader 放开使其走 DML |

> 重要：cos 和 SNR 必须用**真实 eval 校准数据**（`diff_step_dml.npz` 的 8 个 2048 序列样本）评测，不能用随机正态输入（随机输入会夸大量化误差）。

---

## 2. 关键结论（已实测，勿重做）

| 实验 | 结果 | 结论 |
|---|---|---|
| PyTorch CUDA 端 W8A8 fake-quant（per-channel 权重 + per-last-dim 激活 scale） | **cos 0.9986 / SNR 26.7 dB**（8 样本平均） | 量化方案本身近乎无损，方向正确 |
| PyTorch CUDA 端 W8A32（仅权重量化，激活 fp32） | **cos 0.9999 / SNR 38.1 dB** | 权重量化是近无损的，激活量化才是精度损失来源 |
| ORT QDQ W8A8（激活 per-tensor int8）CPU/DML | cos ~0.77 / SNR 2.3 dB | 激活 per-tensor int8 是精度杀手（CUDA 用的是 per-last-dim） |
| 现有 `onnx_models/int8/diff_step_dml.onnx`（existing-prod）CPU | cos 0.67~0.84 | 该旧模型量化方式本身差，应被替换 |
| ORT 内置 calibrator | CPU 2048 序列 OOM；DML EP 图融合失败 | 不要依赖 ORT calibrator 跑完整 2048 |

**核心结论**：
- 权重 INT8（per-channel 对称）量化对 diff_step 是**近无损**的。
- 激活量化要小心：per-tensor int8 会把精度砸到 ~0.77；只有 per-last-dim（每特征通道一个 scale）才能保住 0.998。
- **推荐最终形态 = W8A32**（权重 int8 per-channel，激活保持 FP32）。理由是：
  1. 精度 0.9999，远超验收线；
  2. 完全不涉及激活量化的精度悬崖；
  3. DML 仍能吃到 INT8 权重参与的低精度 GEMM 加速；
  4. 不需要激活校准，绕开 OOM / DML 融合崩溃问题。
- 若坚持 W8A8（激活也 int8），必须注入 CUDA 算出的 per-last-dim 激活 scale 并让 ONNX 的 DequantizeLinear 支持 per-channel 激活轴（ONNX QuantizeLinear 对 per-axis 激活支持有限，风险高，不推荐）。

---

## 3. 环境与依赖

### 3.1 两个 Python 环境（缺一不可）

| 用途 | 解释器路径 | 关键包 |
|---|---|---|
| **A. 模型加载/ONNX 导出/ORT 量化（CPU）** | `C:\Users\15240\miniconda3\envs\soulxsinger\python.exe` | torch 2.11.0+cpu；transformers 4.41.2；onnx 1.21；onnxruntime-directml 1.23（含 DML EP） |
| **B. CUDA 校准（GPU，flash-attn / sdpa）** | `C:\Users\15240\.unsloth\studio\unsloth_studio\Scripts\python.exe` | torch 2.10.0+cu130（CUDA 可用）；transformers 5.x；onnxruntime 1.24.4（DML EP） |

注意事项：
- 只有环境 B 有 CUDA；环境 A 是 CPU。
- 环境 B（transformers 5.x）加载 SoulX 模型跑前向会报 `KeyError: None`（attention 实现解析），**必须在 import 模型前注入以下补丁**：

```python
import os, sys
sys.path.insert(0, r"d:\Document\electron\SXSEditor")
sys.path.insert(0, r"d:\Document\electron\SXSEditor\SoulX-Singer")
os.environ.setdefault("SKIP_ROPE_PRECOMPUTE", "1")
from transformers.models.llama import modeling_llama as _ML
_gm = _ML.ALL_ATTENTION_FUNCTIONS._global_mapping
_eager = _gm.get("eager") or _gm.get("sdpa") or next(iter(_gm.values()))
_gm.setdefault(None, _eager)
```

- 环境 A（transformers 4.41.2）加载模型无需补丁，但**没有 CUDA**。

### 3.2 关键依赖环境变量

| 变量 | 值 |
|---|---|
| `SKIP_ROPE_PRECOMPUTE` | `1`（跳过 RoPE 预计算 patch，走 dynamo 原生导出） |
| `PYTHONUNBUFFERED` | `1`（后台任务日志即时输出，调试必设） |
| `PYTHONIOENCODING` | `utf-8`（避免 ORT 非 UTF-8 日志解码报错） |

---

## 4. 关键路径清单

### 4.1 模型文件

| 用途 | 路径 |
|---|---|
| FP32 DML diff_step（已有的 DML-clean dynamo+Olive 导出基底，量化起点） | `d:\Document\electron\SXSEditor\onnx_models\diff_step_dml.onnx`（+ `.onnx.data`，共 1688 MB） |
| PyTorch 原始模型 | `d:\Document\electron\SXSEditor\SoulX-Singer\pretrained_models\SoulX-Singer\model.pt` |
| 现有（将被替换）INT8 diff_step | `d:\Document\electron\SXSEditor\onnx_models\int8\diff_step_dml.onnx` |
| INT8 模型其他组件（vocoder/encoders/preflow/cond_emb，保持不变） | `d:\Document\electron\SXSEditor\onnx_models\int8\` |
| 新产出 W8A32 diff_step（工作区） | `d:\Document\electron\SXSEditor\int8_output\onnx\` |

### 4.2 数据与校准

| 用途 | 路径 |
|---|---|
| 高质量校准数据（8 样本 × 2048 序列，真实 eval 数据派生的 diff_step 输入/输出） | `d:\Document\electron\SXSEditor\calibrate\data\fp16_calib\diff_step_dml.npz` |
| CUDA 校准产出的每层权重/激活 scale | `d:\Document\electron\SXSEditor\calibrate\data\fp16_calib\diff_step_int8_scales.npz` |
| SoulX-Singer-Eval-Dataset（已从 ModelScope 下载完成，981 文件） | `d:\Document\electron\SXSEditor\eval_data\Soul-AILab\SoulX-Singer-Eval-Dataset\` |
| 校准数据生成脚本（从 eval 数据集做真实前向采样） | `d:\Document\electron\SXSEditor\calibrate\generate_calibration_data.py` |

### 4.3 脚本（已就绪/进行中）

| 脚本 | 作用 | 已实现 |
|---|---|---|
| `scripts\cuda_int8_calib_probe.py` | 环境 B：CUDA 上加载 diff_step → 8 样本真实前向 → 采集每层激活 absmax → 算权重/激活 scale，并可跑 fake-W8A8 / W8A32 精度探测 | ✅（含 `--weight-only` 参数） |
| `scripts\build_w8a32_diffstep.py` | 环境 A：对 FP32 ONNX 每个 MatMul/Gemm 权重插 QuantizeLinear→DequantizeLinear（W8A32 QDQ） | ⚠️ 进行中（见第 6 节踩坑） |
| `scripts\quantize_diffstep_dml.py` | 环境 A：ORT 静态 QDQ 量化（Percentile 99.999，激活对称/非对称可选） | ✅（W8A8，精度不达标，仅作参考） |
| `scripts\validate_int8_real_data.py` | 环境 A：用真实校准 npz 数据评测各模型 cos/SNR/延迟（CPU/DML） | ✅ |
| `scripts\validate_percentile_int8.py` | 环境 A：多 seq 随机输入对比（仅供结构校验，精度评测请用上面的真实数据版） | ✅ |

---

## 5. 推荐执行路径（分阶段）

### 阶段 1：CTRL 精度验证（已完成 ✅）
在环境 B（CUDA）跑：
```
python scripts\cuda_int8_calib_probe.py --samples 8 --weight-only
```
期望结果：**cos ~0.9999 / SNR ~38 dB**。若此步精度都达不到 0.9，则量化方案有问题，先停下排查权重 scale 算法。

### 阶段 2：构建 W8A32 ONNX（当前进行中 ⚠️）
在环境 A 跑 `scripts\build_w8a32_diffstep.py`，把 FP32 ONNX 的每个 MatMul/Gemm 权重改为：
```
权重(fp32 initializer) → QuantizeLinear(per-channel int8) → DequantizeLinear → 原 MatMul/Gemm
```
产出 `int8_output\onnx\diffstep_w8a32.onnx`（目标 ~425 MB）。

**验收**（环境 A）：
```
python scripts\validate_int8_real_data.py --qmodels int8_output\onnx\diffstep_w8a32.onnx --labels w8a32
```
期望 8 样本平均 cos≥0.99、SNR≥0。然后在 DML EP 上复测（把 `validate_int8_real_data.py` 的 providers 改为 `["DmlExecutionProvider"]`）。

### 阶段 3：DML 兼容性收尾
- 对 W8A32 模型套用 `scripts\fix_int8_resolve_neg1.py`（把 Reshape 形状里的 -1 解析成静态值），确保 DML 不报 `E_INVALIDARG`。
- 用环境 A 的 DML EP 实跑一遍 `validate_int8_real_data.py`（providers=DML），确认不崩、精度不塌、有实际加速。

### 阶段 4：部署
1. 把 W8A32 diff_step 拷贝/替换为 `onnx_models\int8\diff_step_dml.onnx`（连同外部数据 `.onnx.data`）。
2. 修改 `src\inference\pipeline\modelLoader.js`：
   - 删除静态形状分支里的 DML 排除逻辑，例如：
     ```js
     const STATIC_SHAPE_DML_EXCLUDE = new Set(['diffStep']);
     const tryDml = !STATIC_SHAPE_DML_EXCLUDE.has(sessionKey);
     ```
   - 让 diffStep 也走 DML 优先 + CPU 回退。
3. 用 app 实际合成一段音频（含 >40s 长音频 + 引用音频），确认无杂音、维度正确。
4. 回归 `test\streamingSynthesis.test.js` 等现有测试。

### 阶段 5：验证与备份
- 跑完整测试套件。
- 按仓库规则（英文 commit message）git 提交并推送到远程。

---

## 6. 已踩过的坑（务必先看，避免重复消耗）

1. **不要用 Q-DiT**：`scripts\soulx_qdit_adapter.py` 产出的 GPTQ 权重是"优化后的 FP32"，不能真正用 INT8 张量核加速，与目标冲突。
2. **不要依赖 ORT calibrator 跑完整 2048**：CPU 会 OOM（注意力激活内存爆炸），DML EP 会图融合失败（calibrator 用 `ORT_DISABLE_ALL`，与 DML 不兼容）。校准要么在 CUDA torch 端做（推荐），要么用截断序列（会损失精度）。
3. **ORT QDQ 激活是 per-tensor int8**，这是精度只能到 ~0.77 的根本原因。只有权重（per-channel）是近无损的。所以最终方案选 W8A32。
4. **`quantize_dynamic` / shape inference 会在 dynamo 导出图上失败**：报 `Inferred shape (1024) vs (4096)` 不一致。不要用 ORT 动态量化，用手工插 QDQ 节点（build_w8a32_diffstep.py）构建 W8A32。
5. **ONNX per-axis 量化对 scale 要求苛刻**：`PrepareForQDQ` 要求 scale 是一维张量、长度等于轴的维度。3D 权重（attention 的 q/k/v 有时是 3D）要格外小心 axis 和 scale 长度，这是 build_w8a32_diffstep.py 当前最主要的待修问题（见第 7 节）。
6. **环境 B（transformers 5.x）** 必须注入第 3.1 节的 attn 补丁，否则前向报 `KeyError: None`。
7. **外部数据文件命名**：onnx 的 `.onnx.data` 必须与 onnx 内 `external_data.location` 一致，改名后要重新 save，否则加载报 `Data of TensorProto ... should be stored in ...`。
8. 精度评测**必须用真实校准数据**（见第 1 节），随机输入会把 cos 打到 0.8 以下，误导判断。
9. 量化/推理脚本要**按需释放内存**（大模型 + 2048 序列容易爆显存/内存）：用完的 session、tensor 及时 del + `gc.collect()` + `torch.cuda.empty_cache()`。

---

## 7. build_w8a32_diffstep.py 待解决的技术点

当前脚本已解决：节点命名重复、axis 属性类型（INTS vs INT）、权重与 Q 输出同名冲突。
仍待解决：**per-axis scale 广播**。

现象：`quantize_linear.cc:112 ... scale must be 1D tensor with size 128`（或类似），即 ONNX CPU 内核要求 scale 一维且长度=轴维度，且对某些权重的 reduce_axis 选择/3D 权重处理不对。

排查方向：
1. 打印所有被量化权重的 shape 与 reduce_axis，找出 scale 长度与轴维度不匹配的权重。
2. 对 3D 权重（如 attention q/k/v：[batch? / heads, dim, dim]）单独确定量化轴与 scale。
3. 也可考虑**放弃手工构建**，改用 ORT `quantize_dynamic` 前先对模型做 `onnxslim`（项目 `scripts\olive_dml.py` 里有用 onnxslim 的先例）清理掉 shape-infer 冲突节点，再走 ORT 动态 W8A32（它能正确处理 per-channel 权重）。

---

## 8. 成功判据（最终 check list）

- [ ] `int8_output\onnx\diffstep_w8a32.onnx` 生成，体积 ~425 MB
- [ ] CPU 真实数据评测：cos ≥ 0.99，SNR ≥ 0
- [ ] DML EP 真实数据评测：cos ≥ 0.9，SNR ≥ 0，不崩
- [ ] 替换 `onnx_models\int8\diff_step_dml.onnx`
- [ ] `modelLoader.js` 放开 diffStep 走 DML，保留 CPU 回退，NPU 路径不受影响
- [ ] 应用内真实合成（含长音频/引用音频）通过，无杂音
- [ ] 现有测试套件通过
- [ ] 英文 commit message，git 提交并推送远程
---

## 9. Final results (2026-08-26)

Decision changed by measurement: W8A32 was built and is accuracy-perfect but does
NOT accelerate on DirectML (no mixed int8-weight x fp32-activation GEMM operator in
DML; DequantizeLinear cannot fuse into MatMul there). FP16 full-graph conversion is
the winner for real DML speedup.

Measured on real calib data (8 samples, seq 2048, DmlExecutionProvider):

| model | cos | SNR dB | mean ms | speedup | size |
|---|---|---|---|---|---|
| fp32 (baseline) | 1.00000 | inf | 410 | 1.00x | 1688 MB |
| w8a32 (int8 weights + DQ) | 0.99988 | 38.11 | 436 | 0.94x (SLOWER) | 424 MB |
| **fp16 (deployed)** | **0.99761** | **27.31** | **181** | **2.26x** | **844 MB** |

Absolute correctness cross-check (DML vs CPU ground truth):
- fp32 on DML vs CPU: cos 1.00000 / SNR 113.75 dB (old "silent output" issue gone)
- fp16 on DML vs CPU: cos 0.99996 / SNR 40.47 dB

DML limitations (why INT8 did not win):
1. DirectML has QUANTIZED_LINEAR_MATMUL (int8 x int8 only) - no mixed precision GEMM,
   so weight-only INT8 (W8A32) dequantizes at runtime: reads 422 MB int8, writes
   1.7 GB fp32, then runs FP32 GEMM -> net slower than plain FP32.
2. Full W8A8 via QLinearMatMul would use DP4A but forces per-tensor activation
   quantization -> measured cos ~0.77 (precision cliff), fails acceptance.
3. ORT CPU folds weight DQ into FP32 weights (constant folding) -> no CPU speedup
   either; W8A32 value is size-only.
4. FP16 GEMM is natively accelerated by DML (~2.3x here) with near-lossless accuracy.

Deployment:
- onnx_models/int8/diff_step_dml.onnx (+ .onnx.data, 885 MB) = FP16 compute, FP32 IO
  (keep_io_types). Pipeline detects float32 xt_input -> diffStepIsFP16=false ->
  existing FP32 feeding path unchanged.
- modelLoader.js: STATIC_SHAPE_DML_EXCLUDE removed; diffStep now goes DML-first with
  automatic CPU fallback in static-shape mode. NPU/WebNN paths untouched.
- fix_int8_resolve_neg1.py NOT needed: current graph runs correctly on DML as-is.

Scripts:
- scripts/build_w8a32_diffstep.py   v2: pre-quantized int8 initializers + DQ only;
  fixes per-axis scale length bug (reduce all axes EXCEPT the quantization axis)
- scripts/make_fp16_diffstep.py     manual whole-graph FP16 conversion (onnxconverter_common
  1.16 breaks on dynamo _to_copy nodes); clamps out-of-range constants (mask -FLT_MAX)
- scripts/bench_diffstep_realdata.py unified accuracy+latency bench on real calib data
- scripts/_crosscheck_dml_cpu.py    DML-vs-CPU absolute correctness check

Check list status:
- [x] diffstep_w8a32.onnx generated (424 MB) - kept as size-optimized fallback, NOT deployed (slower on DML)
- [x] CPU/DML real-data accuracy: fp16 cos 0.99761 >= 0.95, SNR 27.31 dB >= 7
- [x] Replaced onnx_models/int8/diff_step_dml.onnx
- [x] modelLoader.js diffStep DML-first with CPU fallback; NPU path unaffected
- [ ] In-app synthesis check (long audio + reference audio) - requires GUI run
- [x] Test suite passes (1664 tests)
