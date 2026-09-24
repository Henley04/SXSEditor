# Q-Drift —— SoulX-Singer 量化 DiT（FP16 / INT8）推理期漂移校正

> 2026-09-24 起标定覆盖 **FP16 与 INT8 两种精度**，校准样本除 ModelScope 的 8 条
> nat_*（中英）外，新增 30 条来自真实 `.sxsproj` 工程的条件（含《心做》xinzuo 全曲
> 分段、洛天依 V2/V3/V4 三种歌手），每样本 3 个噪声种子，共 **38 × 3 = 114 条配对轨迹**。

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
  conds_bin/     导出为裸二进制 + manifest.json（nat_*，中英文，Node 直接读，gitignored）
  conds_proj/    真实 .sxsproj 工程导出的条件（prj_*，30 条，5.14–19.58 s，gitignored）
  calib/         FP16 结果：qdrift_V.bin / _c.bin / _meta.json（state 不入库）
  calib_int8/    INT8 结果：同名产物（state 不入库）
  eval/          mel/*.bin、wav/*.wav、report_<precision>.json
  scripts/
    export_conds.py      .pt → 裸二进制
    probe_ep.py          CPU vs DML 的 Δv 量级与速度探测（Python，仅用于对比研究）
    common.js            共用：ONNX 后端 / cfgVelocity / runSampler（与 diffusion.js 数学等价）
    calibrate_dml.js     ★ 校准主程序（--precision fp16|int8，增量保存，可断点续跑）
    gen_asset.js         校准产物 → qdriftCorrection.js / qdriftCorrectionInt8.js
    eval_dml.js          ★ A/B/C/D 四方对比 + wav 导出 + cosine/SNR/包络指标
```

## 复现步骤

```bash
# 1a) ModelScope 条件张量（只需一次）
py qdrift/scripts/export_conds.py

# 1b) 从真实工程导出条件（--file 可重复；用 Electron CLI 跑完整 FP32 管线）
npx electron . --cli qdrift-conds `
  --file "D:\Document\waveform\cliper\已导出\xinzuo.sxsproj" `
  --file D:/path/to/other.sxsproj --out qdrift/conds_proj

# 2) 校准（38 条 × 3 seed = 114 轨迹；FP16 约 45 min，INT8 约 40 min，DML）
node --expose-gc qdrift/scripts/calibrate_dml.js --precision fp16 `
  --data-dirs qdrift/conds_bin,qdrift/conds_proj --tags nat,prj `
  --seeds 1234,7777,20260924
node --expose-gc qdrift/scripts/calibrate_dml.js --precision int8 `
  --data-dirs qdrift/conds_bin,qdrift/conds_proj --tags nat,prj `
  --seeds 1234,7777,20260924

# 3) 生成应用资产（分别写入 qdriftCorrection.js / qdriftCorrectionInt8.js）
node qdrift/scripts/gen_asset.js --precision fp16
node qdrift/scripts/gen_asset.js --precision int8

# 4) 四方对比 + wav（跨数据目录选 item；INT8 加 --precision int8）
node qdrift/scripts/eval_dml.js --precision fp16 `
  --data-dirs qdrift/conds_bin,qdrift/conds_proj `
  --items nat_000,prj_xinzuo_f0_s00,prj_xinzuo_f0_s05,prj_lagtrain_f0_s01 --seed 1234
```

**为什么校准比整首歌导出慢得多**：一条轨迹的 32 步里，每步都要跑 FP32 参考模型与
量化模型各一次 CFG（cond + uncond，共 **4 次** DiT 推理；导出只需量化模型 2 次），
xinzuo 的长参考音频还要把 1500 帧 prompt 拼进序列（单条最长 2471 帧）。全量是
114 条独立轨迹，因此 FP16 约 45 min、INT8 约 40 min。state 每条轨迹落盘，中断后
重跑同一命令即可续跑。

## 校准合约（★ 改动任何一项都必须重新校准）

| 项 | 值 |
|---|---|
| 采样步数 | **32**（锁定） |
| 求解器 | **Euler**（锁定） |
| CFG / rescale | 3.0 / **0.7** |
| σ 网格 | σ_i = (i + 0.5)/32 |
| 执行提供者 | DmlExecutionProvider（onnxruntime-node） |
| 目标 | `onnx_models/diff_step_dml.onnx`（FP32） |
| 量化 / 结果 | FP16：`onnx_models/fp16/diff_step_dml.onnx` → `calib/`；INT8：`onnx_models/int8/diff_step_dml.onnx`（QDQ 图，float32 I/O，输出 `flow_pred.to_f32`）→ `calib_int8/` |
| 校正因子形状 | `c` = (32, 128)，逐 step、逐 mel 通道；两种精度各自一张表（Δv 量级差 2~3 个数量级） |

换步数或换求解器 → σ 网格不重合、`1/(2σ)` 配平作废；叠加 CFG 调度 / 动态阈值 /
SDEdit 修复 → 速度场 `v` 的分布改变，`c` 失效。由于 `|c|` 只有 1e-5 量级，**这些失效在
听感上完全无法察觉（静默降级）**，所以应用侧在开启 Q-Drift 时一律强制锁定并写日志。

## 应用侧接入

| 文件 | 作用 |
|---|---|
| `src/inference/pipeline/qdrift/index.js` | 合约常量、按精度加载校正表、`resolveQDrift()` 强制锁定 |
| `src/inference/pipeline/qdrift/qdriftCorrection.js` | FP16 的 c（base64，自动生成，勿手改） |
| `src/inference/pipeline/qdrift/qdriftCorrectionInt8.js` | INT8 的 c（可选资产；缺失时运行时自动降级关闭，不报错） |
| `src/inference/pipeline/samplers/euler.js` | 逐通道 `(1 + c_i)` 缩放（c 已按当前精度选表） |
| `src/inference/pipeline/diffusion.js` | 注入 `diffStepPrecision`、参数覆盖、日志、关闭 SDEdit |
| `src/inference/pipeline/index.js` | 合成前把 `_modelPrecision` 传给 diffusion（fp32/fp16/int8/int8-npu） |
| `src/main/settings.js` / `settingsIpc.js` | `enableQDrift` 设置项（按精度分别记忆意愿） |
| `src/inference/pipeline/qdrift/defaults.js` | 默认值策略（FP16 默认开、INT8 opt-in），主进程与渲染层共用 |
| `src/settings.html` / `src/settings.js` | 设置页「采样校正」开关（FP16/INT8 可勾，其余置灰） |
| `src/renderer/exportDialog.js` + i18n | 导出对话框开关与中英文案 |

### 默认值与开关语义

- **未显式设置时跟随模型精度**：`modelPrecision === 'fp16'` → 开；`'int8'` → 关
  （opt-in，INT8 校正幅度大，需用户显式打开）；其余（fp32 / int8-npu）→ 关。
  两种支持精度的用户意愿分别记忆，刻意不在 settings 初始化时把默认值落盘成固定布尔值，
  这样切换模型精度时开关会跟着变，不会停在陈旧值上。
- 用户手动拨动过之后（`enableQDrift` 变成显式 boolean）就完全以用户意图为准。
- 导出对话框里切精度会同步勾选状态；用户手动改过之后不再自动改。
- 只有 **FP16 / INT8 DiT + DML / NvTensorRtRtx** 才真正生效；FP32、int8-npu
  （WebNN 另一套模型）或 CPU/OpenVINO 下自动跳过，并在日志写明原因
  （`disabled` / `precision-unsupported` / `correction-unavailable` / `ep-not-measured`）。

开关打开后：求解器 → Euler、步数 → 32、CFG → 3.0、rescale → 0.7，
CFG 调度 / 动态阈值 / SDEdit 修复全部关闭。

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

## ⚠️ FP16 质量归因：劣化主要来自 vocoder，不是 DiT（2026-09-20）

主观上 FP16 明显不如 FP32，而上面的 mel 指标只有 0.4%。原因是**指标选错了**：全局
mel 残差被高能量帧主导，而感知劣化集中在高频细节上；mel 域 0.4% 的误差经 vocoder
这种非线性放大器后，波形域差异完全不成比例。

`qdrift/scripts/diagnose_fp16.js` 用 8 条波形把误差拆开（同 seed，STFT 对数谱距离 LSD）：

| 路径 | LSD 均值 | 8–12 kHz | 说明 |
|---|---|---|---|
| AA2：FP32 换随机种子 | **14.77 dB** | 12.82 | 感知基线：模型自身的随机性 |
| AB：**只换 vocoder** | 2.38 dB | **3.54** | 同一份 FP32 mel 喂 FP16 声码器 |
| BA：只换 DiT | 0.95 dB | 0.88 | FP16 DiT → FP32 声码器 |
| BB：两者都换（FP16 档现状） | 2.68 dB | 3.77 | |
| CC：BB + Q-Drift | 2.68 dB | 3.80 | **几乎无变化** |
| AD：FP32 + CFG linear 调度 | 5.51 dB | 5.25 | 仅换 CFG 调度，供对比 |

**结论 1：vocoder 占波形域偏差的约 86%**（2.38²/(2.38²+0.95²)），DiT 只占 14%。
误差集中在 8–12 kHz：声码器 3.54 dB vs DiT 0.88 dB（4 倍）。Q-Drift 只作用于 DiT，
**所以它对 FP16 的听感问题无能为力**——这解释了"Q-Drift 无济于事"。

**结论 2（更重要）：开启 Q-Drift 反而让偏离变差约 2 倍。**

`resolveQDrift()` 会把 CFG 调度强制成 constant 3.0，而应用默认
`exportCfgScheduleMode = 'linear'`（start = cfg×0.5 = 1.5 → end = 3.0）。仅这一项
就造成 **5.51 dB** 的谱差异，远大于 FP16 本身的 2.68 dB（见 AD 行）。

用户真实配置（CFG 3.0 + linear）下三条样本：

| 样本 | FP16 档 vs FP32 档 | 开 Q-Drift 后 vs FP32 档 | 开 Q-Drift 前后 |
|---|---|---|---|
| nat_000 | 2.58 dB | **6.01 dB** | 5.70 dB |
| nat_001 | 3.29 dB | **5.64 dB** | 5.27 dB |
| nat_003 | 3.31 dB | **6.36 dB** | 5.84 dB |

即：**开了 Q-Drift 之后，输出离 FP32 比不开时远了约 2 倍。** 用户感觉的"无济于事"
实际是"变差了"，祸首不是校正因子（量级 1e-5），而是被连带关掉的 CFG 调度。

### LSD 怎么读（以及它不能说明什么）

LSD 是**两个信号短时幅度谱之间的距离**，同为 0 dB，越大越不同。所以"越低越好"只在
**参考就是你想逼近的目标**时才成立。它有两个必须记住的限制：

- **它是"差异分"，不是"音质分"**。同一个 FP32 模型换个随机种子，LSD 高达 14.77 dB，
  但那两条音频本身都完全正常。所以绝不能拿"LSD 大"直接推"难听"。
- **它只在受控比较里可判读**：固定 seed、固定配置、只替换一个组件。本文所有归因都是这样做的
  （AB 只换 vocoder、BA 只换 DiT、BD/BE 只换 vocoder 而 DiT 相同），此时 LSD 恰好回答
  "这个组件对输出的改变有多大"，这才是它的用途。

本实现的已知弱点（看数字时请一并考虑）：

- 只比幅度谱、**丢弃相位**。反相或时移的失真可以显示得很小，而纯相位类的劣化会被低估。
- **没有掩蔽模型 / 没有 A 计权**：被掩蔽的误差和被听见的误差记同样的分，所以不能把
  3.5 dB 直接读成"3.5 dB 的听感劣化"。
- 逐帧做的是**绝对幅度**比较（仅对 -80 dBFS 做钳位），信号电平不同会让所有频段一起抬高。
  本次各条路径的 RMS 差异 < 0.5%，所以不构成问题，但不是通用前提。
- 上表刻度里的"轻微 / 明显 / 另一个版本"分区是**本项目的经验性划分**，不是测出来的 JND。

要一个能对外主张的"音质"结论，需要带感知加权或掩蔽模型的指标（上游包的
`perceptual_metrics.py` 有 MCD/STOI/F0，需要 `pystoi`），或者直接做盲听 A/B —— 后者才是终审。
本次结论不依赖绝对刻度：它是同 seed 的受控对比，"Q-Drift 6.01 dB vs 不开 2.58 dB"与
"推荐方案 0.89 dB vs 现状 2.58 dB"都是同口径比较。

### 各种因素对输出的影响排序（同一 seed，LSD 均值）

1. 随机种子：14.77 dB
2. CFG 调度 linear ↔ constant：5.51 dB
3. FP16 全栈（DiT + vocoder）：2.58–3.31 dB ← 其中 86% 来自 vocoder
4. 仅 FP16 DiT：0.95 dB
5. Q-Drift 校正本身：≈ 0（被前四项淹没）

### 可行的修复方向

| 方案 | 效果 | 代价 |
|---|---|---|
| **FP16 DiT + FP32 vocoder** | 偏差 2.58 → ~0.95 dB（8–12 kHz 3.73 → 0.88） | vocoder 519→1054 MB；耗时 24 → 540 ms / 10 s 音频（导出离线，可接受） |
| 关掉 Q-Drift（或不再强制 CFG 调度） | 立刻少 5.5 dB 的劣化 | 无 |
| 重新导出 fp16 声码器（敏感层保留 fp32） | 治本 | 需要 Python 导出管线 |
| 按 linear 调度重新校准 Q-Drift | 依然可忽略（c 量级 1e-5） | 不划算 |

### 复现

```bash
node qdrift/scripts/diagnose_fp16.js --items nat_000 --seed 1234
# 产物：qdrift/diag/<item>__*.wav（可直接试听对比）+ summary.json
```

## 评测结果：2026-09-24 全量重标定（FP16，38 样本 × 3 seed = 114 轨迹）

校准数据：nat_*（8，中英文，ModelScope）+ prj_*（30，真实工程：xinzuo《心做》、
lagtrain、ZhangXF、monitoring_explict、example；洛天依 V2/V3/V4，5.14–19.58 s）。
FP16 校正因子逐步均值（0/8/16/24/31）：
c = **7.20e-5 / 1.29e-5 / 8.32e-6 / 9.08e-6 / 2.75e-5**（单步缩放 ≤ 0.008%）。

A/B/C/D 评测（seed 1234，constant CFG 3.0，B 与 C 仅差校正因子）：
A=FP32 全套；B=FP16 DiT + FP16 vocoder；C=B + Q-Drift；D=C 的 mel + FP32 vocoder。

| 样本 | cosine B→C | SNR(dB) B→C | 帧cos min B→C | 全局残差 B→C |
|---|---|---|---|---|
| nat_000 (EN 13.5s) | 0.99999 | 47.11 → **47.92** | 0.99909 → **0.99952** | 4.41e-3 → **4.02e-3** |
| xinzuo s00 (19.4s, 1500 帧 prompt) | 0.99999 | 46.14 → **46.15** | 0.99978 → **0.99979** | 4.93e-3 → 4.93e-3 |
| xinzuo s05 (19.6s) | 0.99999 | 48.32 → **48.56** | 0.99974 → **0.99987** | 3.84e-3 → **3.73e-3** |
| lagtrain f0 s01 (14.3s) | 0.99999 | 49.18 → **49.23** | 0.99995 → 0.99991 | 3.47e-3 → **3.46e-3** |

聚合硬指标（阈值 cosine ≥ 0.90、SNR ≥ 0 dB）：**B 与 C 全部 PASS**
（cosine min 0.99999；SNR mean B 47.69 / C 47.96 dB）。

音频域 20 ms 包络相关：0.993–0.9999，B/C 基本持平（±5e-4）；RMS 比 C 普遍更贴近 1.0
（xinzuo s05：0.9979 → 0.9993）。结论与旧标定一致：**FP16 是温和量化，Q-Drift 的
收益在 mel 边缘分布上方向正确但幅度很小**，硬指标本来就远超阈值；最终以
`qdrift/eval/wav/fp16__*__{A,B,C,D}.wav` 试听为准。INT8 的 |Δv| 末步达 0.46
（FP16 仅 0.04），校正空间大 2 个数量级，是 Q-Drift 的主要目标场景（标定待续跑）。

## 评测结果：2026-09-20 首次标定（FP16，seed 1234，4 条：nat_000/001/002/003，9.56–13.54 s）

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
