# FP16 精度检查报告（AIMET QuantAnalyzer + 真实 IEEE FP16 测量）

> 生成时间：2026-11-14
> 脚本：`scripts/fp16_aimet_analysis.py`、`scripts/fp16_per_layer_sensitivity.py`、`scripts/fp16_e2e_audio_check.py`
> 原始数据：`scripts/fp16_aimet_report.json`、`scripts/fp16_per_layer_report.json`、`scripts/fp16_e2e_audio_report.json`

## 1. 结论

1. **FP16 模型整体可用**：8 个模型的输出 SQNR 在 **46–74 dB**，余弦相似度 ≥ **0.99998**，相对 L2 误差 ≤ 4.8e-3。
2. **`mel_transform` 是唯一硬伤**：FP16 图在 DML 上 SQNR **-9.44 dB**、cos **-0.993**（输出与参考基本无关）。
   仅权重舍入（CPU 计算）仍有 66.4 dB，说明问题出在 DML 的 FP16 计算，而不是权重精度。
   生产管线已把 `fp16/mel_transform.onnx` 换成 FP32 图；老版本下载的 FP16 图会被检测出来并改到 CPU EP
   （`pipeline/index.js` 的 `_melSessionIsFP16Input` + `createSessionWithValidation({ cpuOnly })`）。
3. **vocoder 的 W16A32 是必要设计**：AIMET 16-bit 激活量化后只剩 **0.71 dB**，而只量化权重有 **47.19 dB**，
   与实测 W16A32 的 **46.86 dB** 几乎重合 —— 声码器激活动态范围过大，激活必须留 FP32。
4. **diff_step 没有“坏层”**：163 个可覆写权重逐层做 IEEE FP16 舍入，最差单层仍有 **86.6 dB**，
   全部权重同时 FP16 为 **74.5 dB**。真实 DML FP16 的 48.0 dB 主要损失来自 **FP16 累加/逐算子计算**，
   而不是某个权重张量。
5. **端到端**：同种子下 FP16 管线 vs FP32 管线的 mel SQNR **44.2 dB**；作为对照，FP32 管线只换随机种子
   mel SQNR 为 **-2.0 dB**。即 FP16 引入的偏差比采样本身的随机性低约 **46 dB**，在 mel 域可视为可忽略。

## 2. 方法与判据

| 项目 | 说明 |
|---|---|
| 参考 | FP32 ONNX 在 CPU EP 上的输出（确定性） |
| 被测 | ① FP32 模型 + DML；② FP16 模型 + CPU（只体现权重/激活的存储舍入，CPU 会提升到 FP32 计算）；③ FP16 模型 + DML（生产真实 FP16 计算） |
| 指标 | SQNR = 10·log10(Σref²/Σerr²)、cosine、rel_L2、max_abs_err |
| 数据 | `calibrate/data/fp16_calib/*.npz` 的真实校准样本（每模型 8 组） |
| 截断 | diff_step 取 seq 256、vocoder 取 200 帧、preflow/cond_emb 取 512 帧（其余为原始长度） |
| AIMET | `aimet_onnx.quant_analyzer.QuantAnalyzer`，`post_training_tf_enhanced`，W/A 均 16-bit |

> **口径提醒**：AIMET 的 16-bit 是 **int16 仿射量化**，不是 IEEE FP16。它给出的是“哪些层对低位宽表示敏感”的
> 排序与量级参照；真实 FP16 误差以第 3 节的 ONNX 实测为准。两者在 vocoder 权重上互相印证（47.19 vs 46.86 dB）。

## 3. 真实 FP16 精度（vs FP32 CPU）

| 模型 | FP32-DML | FP16-CPU（仅存储） | FP16-DML（生产） | cos | rel_L2 |
|---|---|---|---|---|---|
| note_text_encoder | 260.2 | 73.65 | 73.65 | 1.00000 | 2.1e-04 |
| note_pitch_encoder | 260.2 | 73.65 | 73.65 | 1.00000 | 2.1e-04 |
| note_type_encoder | 260.2 | 73.65 | 73.65 | 1.00000 | 2.1e-04 |
| f0_encoder | 260.2 | 73.64 | 73.64 | 1.00000 | 2.1e-04 |
| cond_emb | 128.7 | 69.01 | 61.12 | 1.00000 | 8.8e-04 |
| preflow | 125.2 | 67.53 | 58.59 | 1.00000 | 1.2e-03 |
| mel_transform | 84.9 | 66.41 | **-9.44** | **-0.99266** | 3.0e+00 |
| vocoder（W16A32） | 99.9 | 46.85 | 46.86 | 0.99998 | 4.8e-03 |
| diff_step | 111.2 | 60.77 | 48.05 | 0.99998 | 4.2e-03 |

说明：
- 编码器类模型 FP16 与 FP16-CPU 完全一致（73.6 dB），因为其计算只有 Gather/Add，DML 不会引入额外误差。
- vocoder 两种后端一致（46.9 dB），符合 W16A32 “只有权重是 FP16” 的定义。
- diff_step 的 FP16-DML 比 FP16-CPU 低 **12.7 dB**，即 **FP16 计算**（而非存储）贡献了主要误差。

## 4. AIMET QuantAnalyzer 16-bit 敏感度

| 模型 | FP32 | 仅 W 16-bit | 仅 A 16-bit | 逐层分析层数 |
|---|---|---|---|---|
| note_text_encoder | 260.2 | 260.21 | 87.54 | 1 |
| note_pitch_encoder | 260.2 | 260.19 | 85.36 | 1 |
| note_type_encoder | 260.2 | 260.20 | 85.88 | 1 |
| f0_encoder | 260.2 | 260.23 | 87.39 | 1 |
| cond_emb | 239.4 | 78.61 | 83.30 | 1 |
| preflow | 254.7 | 78.62 | 75.07 | 57 |
| mel_transform | 239.4 | 239.38 | **14.87** | 10 |
| vocoder | 211.8 | 47.19 | **0.71** | 234 |

逐层热点（`per_layer_disabled`：关掉该层量化器后 SQNR 的回升量，越大越敏感）：

| 模型 | 最敏感层 | 回升 | 解读 |
|---|---|---|---|
| mel_transform | `node_pow_1`（STFT 后取模平方） | +30.99 dB | 唯一热点，单层解释全部损失 |
| vocoder | `/MatMul_1` 等 | ≤ +0.05 dB | 无单点热点，激活量化全域失效 → 必须 A32 |
| preflow | `preflow.0/pwconv2` | +0.64 dB | 误差均匀分布，无热点 |

> `diff_step` 的逐层分析在 32 GB 机器上不可行：AIMET 每层重建一次 ORT 会话，1.77 GB 权重反复分配不归还，
> RSS 涨到 17.5 GB、系统可用内存剩 0.4 GB 后终止。改用第 5 节的轻量扫描。

## 5. 真实 IEEE FP16 逐层权重敏感度（diff_step / vocoder）

| 模型 | 可覆写权重 | 全部权重 FP16 | 最差单层 | 最差层 |
|---|---|---|---|---|
| diff_step | 163 | 74.49 dB | 86.62 dB | `diff_estimator.diff_step_mlp.0.weight` |
| vocoder | 92 | 50.14 dB | 59.60 dB | `backbone.convnext.29.dwconv.weight` |
| preflow | 12 | 73.75 dB | 83.17 dB | `preflow.2.dwconv.weight` |

vocoder 其余较敏感项：`onnx::MatMul_1076/1079`（ISTFT 基矩阵）60.8/61.2 dB、`backbone.embed.weight` 62.9 dB。
即使全部权重 FP16，vocoder 仍有 50.1 dB，说明 W16A32 的选择已经把权重误差控制在安全区。

## 6. 端到端（32 步扩散 + 声码器，cfg 3.0，rescale 0.75）

固定 cond（`cond_emb` 真实样本）与 prompt mel，只切换模型精度：

| 对比 | mel SQNR | 波形 SNR | 幅度谱 SNR | 波形相关 |
|---|---|---|---|---|
| FP32 管线 vs FP16 管线（同种子） | **44.21 dB** | 10.41 dB | 24.35 dB | 0.955 |
| 仅 vocoder 换 FP16（W16A32） | — | 41.51 dB | 51.95 dB | 1.000 |
| 仅 diff_step 换 FP16 | 44.21 dB | 10.49 dB | 24.39 dB | 0.955 |
| **对照：FP32、只换随机种子** | **-2.02 dB** | -1.91 dB | -1.38 dB | -0.003 |

解读：
- mel 域 44.2 dB 相对“换种子”的 -2.0 dB 高出 **46 dB**，FP16 对内容的影响远小于采样随机性。
- 波形 SNR 只有 10.4 dB 是**相位敏感**造成的指标失真：幅度谱仍有 24.4 dB，且只换种子时波形相关为 0
  （完全不同的样本）。因此不应拿波形 SNR 判断 FP16 是否“坏了”。
- 声码器单独换 FP16 为 41.5 dB / 幅度谱 52.0 dB，与第 3 节结论一致。

## 7. 建议

1. **维持现状**：`mel_transform` 在 FP16 下强制走 FP32 图；vocoder 维持 W16A32。这两条都不是“保守”，而是实测必需。
2. ~~若要继续压 FP16 误差，优先改 diff_step 的累加精度~~ —— **已实验证伪**，见第 10 节：
   逐算子保留 FP32 会被 Cast 往返的第二轮舍入抵消，按步切精度也几乎没有收益。
   要显著提升只能整图 FP32（约 2x 时间）。当前 FP16 的 48 dB 已是这张图的固有水平，
   且端到端比采样随机性低 46 dB，建议维持 FP16。
3. 后续精度回归可直接复用本报告的脚本；`mel_transform` 的 DML 检查应作为常驻用例（-9.4 dB 属于灾难性失败）。

## 8. 复现

```bash
# 真实 FP16 精度（9 个模型）
python scripts/fp16_aimet_analysis.py --stage fp16

# AIMET 16-bit 模型级 + 逐层（小模型/vocoder；diff_step 只跑模型级）
python scripts/fp16_aimet_analysis.py --stage aimet --bits 16 --models preflow cond_emb vocoder --per-layer both
python scripts/fp16_aimet_analysis.py --stage aimet --bits 16 --models diff_step --per-layer none --seq-limit 128

# 真实 IEEE FP16 逐层权重扫描
python scripts/fp16_per_layer_sensitivity.py --model diff_step --seq-limit 128
python scripts/fp16_per_layer_sensitivity.py --model vocoder

# 端到端音频级对比（含随机种子对照组）
python scripts/fp16_e2e_audio_check.py --steps 32 --cfg 3.0 --target-len 200
```

## 9. 环境与已知限制

- AIMET 只装在 **conda `soulxsinger`（Python 3.10）**：`aimet-onnx 2.43.0` 的 wheel 是 `cp310-abi3`，
  在系统 Python 3.14 上导入时会触发 PEP 649 延迟注解求值的 `pattern.OpsetPatternBuilder` 崩溃
  （`aimet_onnx/graph_passes/fusions/layernorm.py`）。
- 安装 `onnx2torch` 时 pip 把该环境的 `torch` 从 2.11.0 升到 2.14.1，已回滚为 2.11.0。
- `onnx` 1.21 拒绝加载“多硬链接”的外部数据文件，脚本会先把模型复制到 `%TEMP%\aimet_fp16_models`（约 2.7 GB）。
- diff_step 的 AIMET 逐层分析在当前 32 GB 机器上不可行（见第 4 节），需要 ≥64 GB 或改造 AIMET 的会话复用逻辑。

## 10. 后续动作（2026-11-14 晚）

### 10.1 `mel_transform`：FP16 目录直接放 FP32 图

- `onnx_models/fp16/mel_transform.onnx`（及其 `.data`）已用根目录 FP32 版本**覆盖**（字节一致）。
  这样只下载了 FP16 子目录的用户也能拿到正确的参考 mel，不再依赖"根目录同时存在 FP32"。
- 兼容老安装：`index.js` 的 `_loadModelsPartitioned` 在加载 `melTransform` 后检查会话输入类型，
  若仍是 `float16`（历史下载的图），记录警告并在 **CPU EP** 上重建会话；`modelLoader.js` 的
  `createSessionWithValidation` 新增 `options.cpuOnly` 支持该回退。
- 守护：`test/fp16MelTransformFp32.test.js` 断言 fp16 目录的图与根目录字节一致、输入名为 `audio`。

### 10.2 diff_step 混合精度：负结果

在同一张 DML、同一份校准样本（seq=256，p50 为 15 次中位数）：

| 变体（哪类算子留 FP32） | SQNR | p50 |
|---|---|---|
| 全 FP16（现状） | 48.13 dB | ~21 ms |
| Softmax | 47.89 dB | 23.8 ms |
| LayerNorm 链（ReduceMean/Sqrt/Reciprocal/Pow） | 47.50 dB | 21.2 ms |
| LN 链 + Sigmoid | 48.66 dB | 22.7 ms |
| LN 链 + Sin/Cos | 47.50 dB | 21.8 ms |
| 全部 Gemm（AdaLN/时间嵌入） | 47.50 dB | 19.0 ms |
| 全部 MatMul + Gemm | 49.88 dB | 53.1 ms |
| 全部 Add + Mul | 46.98 dB | 30.4 ms |
| 整图 FP32 | 115.17 dB | 41.2 ms |

结论：**没有任何一个算子子集能带来超过噪声的收益**。原因清楚——把一段算子留在 FP32，
两侧各插一次 `Cast(FP16→FP32/FP32→FP16)`，等于新增两次 fp16 舍入，抵消了该子集本身的改善；
`MatMul+Gemm` 全 FP32 也只到 49.88 dB，说明误差不是某个算子类的"坏点"，而是 ~1300 个节点
顺序舍入的累积。

采样级混合精度（`scripts/fp16_step_mix_probe.py`，32 步）同样是负结果：

| 配置 | mel SQNR |
|---|---|
| 32 步全 FP16 | 44.21 dB |
| 28 步 FP16 + 4 步 FP32 | 44.98 dB |
| 24 步 FP16 + 8 步 FP32 | 45.52 dB |
| 16 步 FP16 + 16 步 FP32 | 46.90 dB |

后段换 FP32 只能把 +2.7 dB 换回 +50% 时间，因为误差在早期步就已经注入。

**建议**：diff_step 维持全 FP16。若要更高保真，直接用 `modelPrecision=fp32`（约 2x 时间），
不要做算子级混合精度。
