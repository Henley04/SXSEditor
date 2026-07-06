# SiFiGAN-MLP Vocoder (ONNX 版本模型卡)

SiFiGAN + 残差 MLP mel_proj 的 ONNX 导出版本。将 PyTorch 训练的 MelProjMLP 权重注入 SiFiGAN Generator，导出为单一 ONNX 模型，用于 DirectML 推理部署。

与原版 SiFiGAN ONNX 的核心差异：**用训练好的 MLP（128→256→256→43）替换原随机初始化的线性 mel_proj（128→43）**，消除 SVS mel 与 SiFiGAN 训练特征空间的分布不匹配（OOD），显著降低高频电流声。

## 模型架构

```
inputs:
  mel (1, T, 128)  float32  ← SVS 管线产出的 log-mel 频谱（已归一化）
  f0  (1, T, 1)    float32  ← F0 曲线（Hz）
                │
                ▼
      ┌─────────────────────┐
      │  MelProjMLP         │  116.4K params
      │  128 → 256 → 256 → 43 │  (linear + residual)
      │  feat_mean=0, scale=1│  (MLP 直接输出归一化特征)
      └─────────────────────┘
                │  c (1, T, 43)
                ▼
      ┌─────────────────────┐
      │  SiFiGAN Generator  │  11.3M params
      │  Source-Filter HiFi-GAN │
      │  - sine 激励信号生成   │
      │  - pitch-dependent dense factor │
      │  - neural filter     │
      └─────────────────────┘
                │
                ▼
  waveform (1, 1, T_audio)  float32  ← 24kHz 音频
```

**总参数量**：11.4M（MLP 116.4K + Generator 11.3M）

## 输入输出规格

| 名称 | 方向 | 类型 | 形状 | 说明 |
|------|------|------|------|------|
| `mel` | 输入 | float32 | `[1, T, 128]` | SVS mel 频谱，T 为帧数（50Hz，即 1 帧 = 480 样本 = 20ms） |
| `f0` | 输入 | float32 | `[1, T, 1]` | F0 曲线，单位 Hz，范围约 [60, 1000]，无声段填 0 |
| `waveform` | 输出 | float32 | `[1, 1, T*480]` | 24kHz 音频波形 |

**关键参数**：
- 采样率：24000 Hz
- hop_size：480（50Hz 帧率）
- n_fft：1920
- mel 归一化：`(x - (-4.92)) / sqrt(8.14)`（与 SVS 管线一致）
- opset：18
- 动态轴：支持动态 batch_size 和 seq_len

## 文件清单

| 文件 | 大小 | 说明 |
|------|------|------|
| `sifigan_vocoder_dml_mlp.onnx` | 237 KB | ONNX 图定义（external_data 格式） |
| `sifigan_vocoder_dml_mlp.onnx.data` | 33.5 MB | 外部权重数据 |
| `sifigan_vocoder_dml.onnx` | 237 KB | **当前生效版本**（MLP 版本的副本） |
| `sifigan_vocoder_dml.onnx.data` | 33.5 MB | **当前生效版本**（MLP 版本的副本） |

**备份**（旧版本，非 MLP）：
- `sifigan_vocoder_dml_linear_backup.onnx` (45.8 MB) + `.data` (45.5 MB)：原线性 mel_proj 版本

## 精度验证

PyTorch vs ONNX Runtime（CPU EP）对比：

| 指标 | 值 | 说明 |
|------|-----|------|
| 输入形状 | `(1, 50, 128)` + `(1, 50, 1)` | 探针长度 |
| PyTorch 输出范围 | `[-0.011124, 0.013192]` | — |
| ONNX 输出范围 | `[-0.011123, 0.013200]` | — |
| **L1 max error** | **0.0000388** | 远小于容差 0.01 |
| L1 mean error | 0.0000019 | — |
| 容差 | 0.01 | — |
| 验证结果 | **PASS** | — |

## 训练性能（MLP 部分）

| 指标 | 值 | 说明 |
|------|-----|------|
| 训练数据 | 1,450,690 帧 | PJS 100 + GTSinger 2913 文件 |
| 训练步数 | 600 epochs | CosineAnnealingLR 调度 |
| L1 loss | **0.1826** | 全量验证集 |
| mcep L1 | **0.1963** | 归一化空间 |
| mcep in [-5, 5] | 100% | 无异常值 |

详细训练信息见 [PyTorch 版本模型卡](../scripts/mel_proj_train_output/README.md)。

## DirectML 兼容性

- **算子分解**：原版 SiFiGAN 的 `ConvTranspose1D(stride=S)` 已分解为 `Conv1D(upsample(stride=S), stride=1)`，DirectML EP 兼容
- **精度判断**：应用层按文件名判断精度，`sifigan_vocoder_dml.onnx` 视为 FP32（注意：MLP 版本 33.7MB 接近旧 FP16 阈值，已修复 `index.js` 中 `_detectVocoderPrecision` 的误判逻辑）
- **推理路径**：WebNN 推理时 vocoder 在主进程 DML 运行（skipVocoder 模式），renderer 运行 encoder+diffusion 产出 mel，主进程运行 `_runVocoderChunked`

## 使用方法

### 1. 作为 SXSEditor 应用声码器

模型已替换为 `sifigan_vocoder_dml.onnx`，应用启动时自动加载。无需额外配置。

### 2. Python (onnxruntime) 直接推理

```python
import onnxruntime as ort
import numpy as np

# 加载模型
sess = ort.InferenceSession(
    "onnx_models/sifigan_vocoder_dml_mlp.onnx",
    providers=["CPUExecutionProvider"]  # 或 DmlExecutionProvider
)

# 准备输入（T=50 帧 = 1 秒音频）
T = 50
mel = np.random.randn(1, T, 128).astype(np.float32) * 0.77 - 0.10  # 匹配训练分布
f0 = np.full((1, T, 1), 200.0, dtype=np.float32)  # 200Hz 常数 F0

# 推理
outputs = sess.run(None, {"mel": mel, "f0": f0})
waveform = outputs[0]  # (1, 1, T*480) = (1, 1, 24000)
```

### 3. 重新导出

```bash
python scripts/export_sifigan_with_mlp.py
```

读取 `scripts/mel_proj_train_output/mel_proj_mlp.pt` + SiFiGAN checkpoint，导出为 ONNX。导出后会自动进行精度验证。

### 4. 替换为当前生效版本

```powershell
Copy-Item -Path "onnx_models\sifigan_vocoder_dml_mlp.onnx" -Destination "onnx_models\sifigan_vocoder_dml.onnx" -Force
Copy-Item -Path "onnx_models\sifigan_vocoder_dml_mlp.onnx.data" -Destination "onnx_models\sifigan_vocoder_dml.onnx.data" -Force
```

## 与原版 SiFiGAN ONNX 的差异

| 特性 | 原版 SiFiGAN ONNX | SiFiGAN-MLP ONNX |
|------|------|------|
| mel_proj 结构 | 线性 `Linear(128, 43)` 随机初始化 | MLP `128→256→256→43` 残差结构，训练 600 epoch |
| mel_proj 参数量 | 5,504 | 116,395 |
| feat_mean / feat_scale | 来自 stats.joblib | zeros / ones（MLP 内部已归一化） |
| 输入 mel 分布 | SiFiGAN 训练分布（LibriTTS-R） | SVS mel 分布（GTSinger + PJS） |
| OOD 风险 | 高（mel 空间不匹配） | 无（MLP 学习了映射） |
| 电流声 | 明显 | 显著降低 |
| 模型大小 | 45.8 MB + 45.5 MB | 237 KB + 33.5 MB |
| stats 文件依赖 | 推理时需要 | 不需要（MLP 自包含） |

## 注意事项

1. **mel 归一化一致性**：输入 mel 必须用 `(x - (-4.92)) / sqrt(8.14)` 归一化，与 SVS 管线一致。MLP 训练时用的就是这个归一化。
2. **f0 单位**：Hz，无声段填 0（SiFiGAN 内部用 `default_f0=150` 处理）。
3. **mel 帧率**：50Hz（hop=480）。SiFiGAN 原生 200Hz（hop=120），但应用层 `runVocoderChunked` 会做 4x 上采样，ONNX 模型本身接受 50Hz 输入。
4. **精度判断**：应用层 `_detectVocoderPrecision` 按文件名 `sifigan_vocoder_dml_fp16.onnx` 判断 FP16。本模型文件名不含 `_fp16`，故视为 FP32。
5. **bap 通道**：MLP 输出 43 维（40 mcep + 3 bap），其中 bap 部分训练时用零填充，推理时 MLP 会学到接近零的输出。SiFiGAN 内部对 bap 处理较弱，零填充避免引入噪声。

## 导出脚本

`scripts/export_sifigan_with_mlp.py` 的关键流程：

1. 加载 MLP 权重（`mel_proj_mlp.pt`）
2. 加载 SiFiGAN Generator（`sifigan_libritts-r-clean+nus-48e_checkpoint-1000000steps.pkl`）
3. 构建 `SiFiGANMLPWrapper`：
   - `mel_proj = MelProjMLP(128, 256, 256, 43)` 加载训练权重
   - `feat_mean = zeros(43)`, `feat_scale = ones(43)`（跳过原版 `(c - mean) / scale`）
   - `forward` 中：`c = mel_proj(mel)` → `c.transpose(1,2)` → 生成 sine 激励 → 计算 dense factors → `generator(in_signal, c, dfs)`
4. ONNX 导出（opset=18, external_data 格式）
5. 精度验证（PyTorch vs ONNX Runtime CPU）

## 依赖

- onnxruntime >= 1.17（DirectML EP 需要 `onnxruntime-directml`）
- numpy >= 1.23

## 相关链接

- [SiFiGAN 官方仓库](https://github.com/chomeyama/SiFiGAN)
- [PyTorch 版本模型卡](../scripts/mel_proj_train_output/README.md)
- [onnx_models 综合文档](README.md)
