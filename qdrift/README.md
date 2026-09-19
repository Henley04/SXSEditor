# Q-Drift —— SoulX-Singer FP16 DiT 推理期漂移校正

方法来源：*Q-Drift: Quantization-Aware Drift Correction for Diffusion Model Sampling*
（Ryu, Salzmann, Javed, arXiv:2603.18095）。
上游参考实现与校准包：[modelscope.cn/models/syxppp/Qdrift](https://www.modelscope.cn/models/syxppp/Qdrift)。

不改权重、不重新导出、不微调，只在采样器侧加一个逐通道缩放：

```
原始 Euler:  x_{i+1} = x_i + h · v̂(x_i, σ_i, c)
校正 Euler:  x_{i+1} = x_i + h · ((1 + c_i) ⊙ v̂(x_i, σ_i, c))
             c_i = V_{σ_i} / (2·(i + 0.5)),   V_{σ_i} = E[Var(Δv_i | v̂)]
```

---

## ⚠️ 与上游包的三处关键差异（本仓库重新校准的原因）

| 项 | 上游 ModelScope 包 | 本仓库 |
|---|---|---|
| 执行提供者 | CPU EP | **DirectML**（应用实际运行路径） |
| `rescale_cfg` | 0.75（官方默认） | **0.7**（`src/inference/pipeline/constants.js` 的 `CFG_RESCALE`） |
| 序列长度 | 1.9 s（README 自评"不可用于生产"） | **8.82–13.54 s 自然乐谱长度** |

**为什么必须换到 DML**：实测同一条件下

| | step0 \|Δv\|rms | step2 | 单步耗时 |
|---|---|---|---|
| CPU EP | 1.26e-3 | 1.64e-3 | 12.9 s |
| **DML EP** | **8.19e-3** | **1.30e-2** | **0.65 s** |

DML 上的 FP16 量化误差是 CPU 的 **6.5–8 倍**。V 是方差统计量，直接复用 CPU 校准结果会把
误差低估约 **50–60 倍**。应用在 Windows 上跑的就是 DML，所以校准必须与之一致。

---

## 目录

```
qdrift/
  conds_long/    从 ModelScope 包下载的长序列条件张量（nat_000..007，8.82–13.54 s）
  conds_bin/     导出为裸二进制 + manifest.json（Node 直接读）
  calib/         qdrift_V.bin / qdrift_c.bin / qdrift_meta.json / qdrift_state.json（断点续跑）
  eval/          mel/*.bin、wav/*.wav、report.json
  scripts/
    export_conds.py      .pt → 裸二进制
    probe_ep.py          CPU vs DML 的 Δv 量级与速度探测（Python，仅用于对比研究）
    common.js            共用：ONNX 后端 / cfgVelocity / runSampler（与 diffusion.js 数学等价）
    calibrate_dml.js     ★ 长序列校准主程序（增量保存，可断点续跑）
    gen_asset.js         校准产物 → src/inference/pipeline/qdrift/qdriftCorrection.js
    eval_dml.js          ★ A/B/C/D 三方对比 + wav 导出 + 感知敏感指标
```

## 复现步骤

```bash
# 1) 导出条件张量（只需一次）
py qdrift/scripts/export_conds.py

# 2) 校准（8 条 × 2 seed = 16 条配对轨迹，DML 上约 5 分钟）
node qdrift/scripts/calibrate_dml.js --items 8 --seeds 1234,7777

# 3) 生成应用资产
node qdrift/scripts/gen_asset.js

# 4) 三方对比 + wav
node qdrift/scripts/eval_dml.js --items nat_000,nat_001,nat_002,nat_003 --seed 1234
```

## 校准合约（★ 改动任何一项都必须重新校准）

| 项 | 值 |
|---|---|
| 采样步数 | **32**（锁定） |
| 求解器 | **Euler**（锁定） |
| CFG / rescale | 3.0 / **0.7** |
| σ 网格 | σ_i = (i + 0.5)/32 |
| 执行提供者 | DmlExecutionProvider（onnxruntime-node） |
| 目标 / 量化 | `onnx_models/diff_step_dml.onnx` / `onnx_models/fp16/diff_step_dml.onnx` |
| 校正因子形状 | `c` = (32, 128)，逐 step、逐 mel 通道 |

换步数或换求解器 → σ 网格不重合、`1/(2σ)` 配平作废；叠加 CFG 调度 / 动态阈值 /
SDEdit 修复 → 速度场 `v` 的分布改变，`c` 失效。由于 `|c|` 只有 1e-5 量级，**这些失效在
听感上完全无法察觉（静默降级）**，所以应用侧在开启 Q-Drift 时一律强制锁定并写日志。

## 应用侧接入

| 文件 | 作用 |
|---|---|
| `src/inference/pipeline/qdrift/index.js` | 合约常量、校正表加载、`resolveQDrift()` 强制锁定 |
| `src/inference/pipeline/qdrift/qdriftCorrection.js` | 自动生成的 c（base64），勿手改 |
| `src/inference/pipeline/samplers/euler.js` | 逐通道 `(1 + c_i)` 缩放 |
| `src/inference/pipeline/diffusion.js` | 参数覆盖、日志、关闭 SDEdit |
| `src/main/settings.js` / `settingsIpc.js` | `enableQDrift` 设置项 |
| `src/inference/pipeline/qdrift/defaults.js` | 默认值策略（FP16 → 默认启用），主进程与渲染层共用 |
| `src/settings.html` / `src/settings.js` | 设置页「采样校正」开关 |
| `src/renderer/exportDialog.js` + i18n | 导出对话框开关与中英文案 |

### 默认值与开关语义

- **未显式设置时跟随模型精度**：`modelPrecision === 'fp16'` → 开；其余（fp32 / int8 /
  int8-npu）→ 关。刻意不在 settings 初始化时把默认值落盘成固定布尔值，这样用户之后
  切换模型精度时开关会跟着变，不会停在陈旧值上。
- 用户手动拨动过之后（`enableQDrift` 变成显式 boolean）就完全以用户意图为准。
- 导出对话框里切精度会同步勾选状态；用户手动改过之后不再自动改。
- 只有 **FP16 DiT + DML / NvTensorRtRtx** 才真正生效；FP32 或 CPU/WebNN/OpenVINO
  下自动跳过，并在日志写明原因。

开关打开后：求解器 → Euler、步数 → 32、CFG → 3.0、rescale → 0.7，
CFG 调度 / 动态阈值 / SDEdit 修复全部关闭，且仅对 FP16 DiT 生效。

---

## 跨执行提供者的 Δv 实测（nat_000，前 3 步，同一 latent、同一 seed）

复现：

```bash
SXS_ORT_BRIDGE_PATH=D:/Document/electron/SXSEditor/.webpack/main/native/ort_bridge.node \
  node qdrift/scripts/probe_eps.js --steps 3 --eps dml,trtrtx,cpu
```

| EP | step0 | step1 | step2 | 相对 DML | 单步耗时 |
|---|---|---|---|---|---|
| **DML**（校准基准） | 8.94e-3 | 1.26e-2 | 1.29e-2 | 1.00x | 0.6 s |
| **NvTensorRtRtx**（WinML 插件 EP） | 8.66e-3 | 1.23e-2 | 1.30e-2 | **0.98x** | 0.3 s（首步含引擎构建 2.2 s） |
| CPU | 2.01e-3 | 3.80e-3 | — | 约 1/4 ~ 1/8 | 10 s |

结论：

- **量化误差的主导项是 FP16 本身的表示/累加精度，与 GPU EP 无关** —— DML 与
  TensorRT-RTX 的 |Δv| 差 2%，在噪声范围内。所以 **DML 上校准的 c 可以直接套到
  TensorRT-RTX（WinML）上**，不需要再校准一遍。
- CPU EP 走的是另一套 fp16 kernel，误差小 4–8 倍（方差小 16–64 倍），套 GPU 的 c 属于
  超量校正。因此应用侧做了 EP 门控：见下。
- OpenVINO 未测：本机只有 OpenVINO 的 CPU/NPU 设备条目，而应用对 dynamic 形状的
  diff_step 只会选 GPU 候选链（本机即 NvTensorRtRtx），OpenVINO 不是实际路径。

### 应用侧的 EP 门控

`src/inference/pipeline/qdrift/index.js` 的 `resolveQDrift()` 会校验
`sessionEPs.diffStep`：只有 **DML / NvTensorRtRtx** 通过，CPU、WebNN-NPU、
OpenVINO 一律自动不启用（记 `ep-not-measured`）。未知 EP（信号缺失）按通过处理，
避免因为拿不到 EP 信息而误关。

## 评测结果（seed 1234，4 条：nat_000/001/002/003，9.56–13.54 s）

复现：`node qdrift/scripts/eval_dml.js --items nat_000,nat_001,nat_002,nat_003 --seed 1234`

### 音频域：20 ms 包络相关（对 A=FP32 参考）—— 4/4 一致改善

| 样本 | B（FP16） | C（FP16+Q-Drift） | D（C 的 mel + FP32 vocoder） | C−B |
|---|---|---|---|---|
| nat_000 (EN 13.54s) | 0.999511 | **0.999831** | 0.999767 | +3.2e-4 |
| nat_001 (ZH 10.70s) | 0.999900 | **0.999939** | 0.999934 | +3.9e-5 |
| nat_002 (EN 10.02s) | 0.997113 | **0.999911** | 0.999903 | +2.8e-3 |
| nat_003 (ZH 9.56s) | 0.998299 | **0.998839** | 0.998877 | +5.4e-4 |

RMS 比也更贴近 1.0（nat_002：0.9949 → 0.9997）。D 与 C 接近，说明改善来自 DiT 校正本身，
不是 vocoder 路径的巧合。

### mel 域：幅度很小且不完全单调

| 样本 | 全局相对残差 B→C | 帧 p99 B→C | 逐通道均值偏移 B→C | 逐通道 std 偏移 B→C |
|---|---|---|---|---|
| nat_000 | 4.408e-3 → **3.984e-3** | 0.0180 → **0.0164** | 4.46e-4 → **2.68e-4** | 1.88e-4 → **1.74e-4** |
| nat_001 | **3.657e-3** → 3.855e-3 | **0.0066** → 0.0077 | **4.88e-4** → 5.61e-4 | 4.05e-4 → **3.80e-4** |
| nat_002 | 3.693e-3 → **3.679e-3** | 0.0084 → **0.0079** | 6.26e-4 → **5.98e-4** | **4.76e-4** → 5.09e-4 |
| nat_003 | 3.889e-3 → **3.875e-3** | **0.0086** → 0.0089 | 4.96e-4 → **4.46e-4** | 7.53e-4 → **7.29e-4** |

FP16 与 FP32 的全局 mel 差异本来只有 **0.37%–0.44%**，可校正的"空间"就只有这么大；
逐通道均值偏移（Q-Drift 真正针对的系统性漂移量）在 3/4 样本上降低，方向正确。

### 结论

- **音频域一致正向、mel 域小幅混合**，符合论文对"温和量化"的预期：Q-Drift 保持的是采样
  边缘分布，不是逐样本最小化 L2。
- 幅度符合预期地小：`|c| ≈ 7e-5 ~ 2.6e-5`，单步缩放 0.003%–0.008%。
- 最终判定请以 `qdrift/eval/wav/` 的 A/B/C 试听为准（D 用于隔离 DiT 贡献）。

## 已知结论

- FP16 属于"温和量化"，headroom 小。Q-Drift 的目标是**保持采样边缘分布**，不是逐样本
  最小化与 FP32 的 L2/余弦，因此逐样本指标大概率只是持平（上游包在自己错误的评测长度下
  也得到"持平/混合"的结论）。判读请以 `qdrift/eval/wav/` 的实际试听为准。
- 若想看到 Q-Drift 的完整收益，应在 **INT8 / W8A8** 上校准（`V` 会大 2–3 个数量级）。
  本仓库 `onnx_models/int8/`、`onnx_models/qdit_w8a8/` 已有候选图。
