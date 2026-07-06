# SiFiGAN + MelProjMLP (PyTorch 版本模型卡)

本目录存放 **SiFiGAN + 残差 MLP mel_proj** 的 PyTorch 训练权重。MLP 用于将 SVS 管线产出的 128 维 log-mel 频谱映射到 SiFiGAN 所需的 43 维归一化特征（40 维 mcep + 3 维 bap），替换原版 SiFiGAN 的随机初始化线性 `mel_proj`，消除 OOD（out-of-distribution）输入导致的高频电流声。

## 模型架构

### 整体结构

```
SVS mel (B, T, 128)
      │
      ▼
┌─────────────────┐
│  MelProjMLP     │  116.4K params（本目录训练权重）
│  128 -> 43      │
└─────────────────┘
      │  c (B, T, 43) 归一化特征
      ▼
┌─────────────────┐
│  SiFiGAN        │  11.3M params（外部 checkpoint）
│  Generator      │
└─────────────────┘
      │
      ▼
waveform (B, 1, T_audio)  24kHz
```

### MelProjMLP 详细结构（残差设计）

```
y = linear(x) + residual(x)

linear:      Linear(128 -> 43, bias=False)    最小二乘初始化
residual:    Linear(128 -> 256)               残差主干
             LayerNorm(256)
             GELU()
             Dropout(0.1)
             Linear(256 -> 256)
             LayerNorm(256)
             GELU()
             Dropout(0.1)
             Linear(256 -> 43)                末层 0 初始化
```

**设计理由**：
- 初始时 `residual=0`，`y=linear(x)`，与纯线性映射等价（L1≈0.307），训练只能改善不能变差
- 非线性残差弥补 mel（频域 log-mel）与 mcep（倒谱域）之间的非线性关系
- 避免从随机初始化开始收敛慢的问题

### SiFiGAN Generator

- 来源：[SiFiGAN 官方仓库](https://github.com/chomeyama/SiFiGAN)（ICASSP 2023）
- 架构：Source-Filter HiFi-GAN，支持 F0 可控
- 训练数据：LibriTTS-R + NUS-48E（1,000,000 steps）
- 推理只用 filter 输出 `outs[0]`

## 训练数据

| 数据集 | 文件数 | 帧数 | 说明 |
|--------|--------|------|------|
| PJS（日语歌唱） | 100 | ~80K | `SoulX-Singer/train/lora_jp_v2/dataset/wavs` |
| GTSinger（日语歌唱） | 2913 | ~1.37M | `D:\download\GTSinger\Japanese`，全量 2832 文件，19 个因音频过短跳过 |
| **合计** | **2913** | **1,450,690** | 每帧 128 mel + 43 target |

**数据提取**：
- 每个音频只读前 15 秒（GTSinger 是完整歌曲 3-5 分钟，避免全量读取）
- SVS mel：50Hz（hop=480），128 维，fmin=0, fmax=12000，归一化 `(x - (-4.92)) / sqrt(8.14)`
- target mcep：200Hz（hop=120）→ 4x 平均池化到 50Hz，归一化用 `libritts_r_clean+nus-48e_train_no_dev.joblib`
- bap：全零填充（SiFiGAN 内部对 bap 处理较弱，零填充避免引入噪声）

**数据质量**：
- 零异常值（`|val|>5` 占 0.0%）
- mel: mean=-0.1017, std=0.7671
- target mcep: mean=0.0190, std=0.9443

## 训练配置（v3，最终版本）

| 超参数 | 值 | 说明 |
|--------|-----|------|
| EPOCHS | 600 | 旧版 200 epoch 未收敛，loss 持续下降 |
| LR | 5e-4 | 初始学习率 |
| 调度器 | CosineAnnealingLR | T_max=600, eta_min=1e-6，比 ReduceLROnPlateau 更稳定 |
| BATCH_FRAMES | 8192 | 每批帧数 |
| WEIGHT_DECAY | 1e-4 | AdamW 权重衰减 |
| GRAD_CLIP | 1.0 | 梯度裁剪防爆炸 |
| PATIENCE | 40 | Early stop 耐心值 |
| MIN_DELTA | 5e-6 | Early stop 最小改善阈值 |
| 损失函数 | L1 Loss | 直接优化 mcep L1 |

**优化历程**：
- v1: 200 epoch + ReduceLROnPlateau（200 GTSinger），L1=0.2150
- v2: 200 epoch + ReduceLROnPlateau（2913 GTSinger），L1=0.1857
- **v3: 600 epoch + CosineAnnealingLR（2913 GTSinger）**，L1=0.1826

## 性能指标

| 指标 | 值 | 说明 |
|------|-----|------|
| Init L1 loss | 0.3234 | 最小二乘初始化后（仅 linear） |
| 最终 L1 loss | **0.1826** | 全量验证集 |
| mcep L1（归一化空间） | **0.1963** | 40 维 mcep 子集 |
| mcep in [-5, 5] | 100.0% | 无异常值 |
| 参数量 | 116,395 (116.4K) | 仅 MLP 部分 |

## 文件清单

| 文件 | 大小 | 说明 |
|------|------|------|
| `mel_proj_mlp.pt` | 470 KB | **本目录**，MLP 训练权重（state_dict + config + best_loss） |
| `mlp_mel_data.npy` | 708 MB | 训练输入数据（1,450,690 × 128） |
| `mlp_target_data.npy` | 238 MB | 训练目标数据（1,450,690 × 43） |
| `mlp_train_log.txt` | — | 训练日志（每 epoch 的 loss/lr） |

**外部依赖**（不在本目录）：
- SiFiGAN checkpoint: `D:\download\model+stats\sifigan_libritts-r-clean+nus-48e_checkpoint-1000000steps.pkl` (611 MB)
- SiFiGAN 源码: `third_party/SiFiGAN/`
- 特征统计: `D:\download\model+stats\libritts_r_clean+nus-48e_train_no_dev.joblib`

## 使用方法

### 1. 复用数据快速重训

```bash
python scripts/retrain_mlp_from_data.py
```

读取 `mlp_mel_data.npy` + `mlp_target_data.npy`，跳过 45 分钟数据提取阶段，直接训练。

### 2. 重新提取数据（全量 GTSinger）

```bash
python scripts/parallel_extract_data.py
```

多进程并行提取（8 CPU 进程 + GPU 批处理），约 45 分钟完成全量 2913 文件。

### 3. 导出为 ONNX

```bash
python scripts/export_sifigan_with_mlp.py
```

将 MLP 权重注入 SiFiGAN Generator，导出为 ONNX 模型（详见 `onnx_models/SiFiGAN_MLP_README.md`）。

## checkpoint 格式

```python
ckpt = torch.load("mel_proj_mlp.pt", map_location="cpu", weights_only=False)
# ckpt["state_dict"]: OrderedDict，MelProjMLP 的 state_dict
# ckpt["config"]: {"in_dim": 128, "hidden_dim": 256, "out_dim": 43, "dropout": 0.1}
# ckpt["best_loss"]: 0.182561
```

## 依赖

- PyTorch >= 2.0
- diffsptk（mcep 提取，复用模块 741x 加速）
- librosa（pyin F0 提取 + resample）
- soundfile（流式音频读取）
- joblib（加载 stats 文件）
- scikit-learn（joblib 依赖）

## 相关脚本

| 脚本 | 用途 |
|------|------|
| `scripts/train_mel_proj_mlp.py` | 原始训练脚本（含数据提取，单进程） |
| `scripts/parallel_extract_data.py` | 多进程并行数据提取（推荐） |
| `scripts/retrain_mlp_from_data.py` | 复用数据快速重训（v3 优化版） |
| `scripts/export_sifigan_with_mlp.py` | 导出为 ONNX |
