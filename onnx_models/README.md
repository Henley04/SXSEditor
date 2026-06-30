# SoulX-Singer ONNX 模型

SoulX-Singer 模型转换为 ONNX 格式，用于非 PyTorch 环境的推理部署。

## 导出模型

### SoulXSinger 模型 (`onnx_models/`)

| 模型文件 | 输入 | 输出 | 说明 |
|---------|------|------|------|
| `note_text_encoder.onnx` | `(batch, seq_len)` Long | `(batch, seq_len, embed_dim)` | 文本嵌入 |
| `note_pitch_encoder.onnx` | `(batch, seq_len)` Long | `(batch, seq_len, embed_dim)` | 音高嵌入 |
| `note_type_encoder.onnx` | `(batch, seq_len)` Long | `(batch, seq_len, embed_dim)` | 音符类型嵌入 |
| `f0_encoder.onnx` | `(batch, seq_len)` Long | `(batch, seq_len, embed_dim)` | F0 轮廓嵌入 |
| `preflow.onnx` | `(batch, seq_len, text_dim)` Float | `(batch, seq_len, text_dim)` Float | 预处理流 |
| `mel_transform.onnx` | `(batch, num_samples)` Float | `(batch, seq_len, mel_bins)` Float | 音频转梅尔频谱 |
| `vocoder.onnx` | `(batch, seq_len, mel_dim)` Float | `(batch, num_samples)` Float | 梅尔频谱转波形 |
| `cond_emb.onnx` | `(batch, seq_len, cond_emb_dim)` Float | `(batch, seq_len, hidden_size)` Float | 条件嵌入 |
| `diff_step.onnx` | `xt_input, t, cond, xt_mask` | `(batch, seq_len, mel_dim)` Float | 扩散步骤预测 |

### SVC 模型 (`onnx_models/svc/`)

| 模型文件 | 输入 | 输出 | 说明 |
|---------|------|------|------|
| `f0_encoder_svc.onnx` | `(batch, seq_len)` Long | `(batch, seq_len, embed_dim)` | F0 嵌入 (SVC专用) |
| `mel_transform.onnx` | `(batch, num_samples)` Float | `(batch, seq_len, mel_bins)` Float | 音频转梅尔频谱 |
| `vocoder.onnx` | `(batch, seq_len, mel_dim)` Float | `(batch, num_samples)` Float | 梅尔频谱转波形 |
| `cond_emb.onnx` | `(batch, seq_len, cond_emb_dim)` Float | `(batch, seq_len, hidden_size)` Float | 条件嵌入 |
| `diff_step.onnx` | `xt_input, t, cond, xt_mask` | `(batch, seq_len, mel_dim)` Float | 扩散步骤预测 |

## SiFiGAN Vocoder

SiFiGAN（Source-Filter HiFi-GAN）是 SVS 管线的可选替代声码器，与默认 vocoder 并存于 `onnx_models/` 目录。本节描述其架构、训练数据、输入输出格式与 DirectML 兼容性。

### 模型架构

- **SiFiGAN**（Source-Filter HiFi-GAN）
- 来源：ICASSP 2023 论文 "Source-Filter HiFi-GAN: Fast and Pitch Controllable High-Fidelity Neural Vocoder"
- 作者：Yoneyama Reo, Wu Yi-Chiao, Toda Tomoki（名古屋大学）
- 官方仓库：https://github.com/chomeyama/SiFiGAN
- 架构特点：采用 Source-Filter 设计，将神经源信号（source）与滤波器（filter）分离，支持音高（F0）可控
- 与默认 vocoder（HiFi-GAN 变体）的差异：source-filter 分离设计、支持 F0 控制

### 训练数据

- LibriTTS-R train-clean-100 + train-clean-360（约 460 小时英文语音）
- NUS-48E（48 个说话人的歌唱/语音数据集，排除 ADIZ 与 JLEE 用于评测）
- 采样率 24 kHz（与 SXSEditor SVS 管线 `SAMPLE_RATE = 24000` 一致）
- 训练步数：1,000,000 steps
- 训练超参数：参考 SiFiGAN 官方 `train=sifigan_1000k` 配置

### 输入输出格式

| 名称 | 类型 | 形状 | 说明 |
|------|------|------|------|
| `mel` | float32 | `[1, seq_len, 128]` | SVS 管线产出的 mel 频谱（输入） |
| `f0` | float32 | `[1, seq_len, 1]` | F0 曲线，单位 Hz，范围约 [60, 1000]（输入） |
| `waveform` | float32 | `[1, num_samples]` | 24 kHz 音频波形（输出） |

- 内部归一化：使用 `libritts_r_clean+nus-48e_train_no_dev.joblib` 统计文件（部署时重命名为 `sifigan_stats.joblib`）

### DirectML 支持情况

- 原始 SiFiGAN ONNX 中可能包含大 stride ConvTranspose 算子，DirectML 不支持
- 通过 `optimize_sifigan_dml.py` 脚本进行算子分解（参考现有 `optimize_vocoder_dml.py`）
- 分解策略：`ConvTranspose1D(stride=S) → Conv1D(upsample(stride=S), stride=1)`
- 优化后输出 `sifigan_vocoder_dml.onnx`，DirectML EP 可用
- 四级回退：`sifigan_vocoder_dml_fp16.onnx` → `sifigan_vocoder_dml.onnx` → `sifigan_vocoder.onnx` → `vocoder_dml.onnx`（默认）

### 文件清单

| 文件 | 大小 | 说明 |
|------|------|------|
| `sifigan_vocoder_dml_fp16.onnx` | ~23 MB | FP16 量化版 ONNX 模型（含 `.data`，推荐） |
| `sifigan_vocoder_dml.onnx` | ~48 MB | FP32 DML 优化版 ONNX 模型（含 `.data`） |
| `sifigan_vocoder.onnx` | ~35 MB | FP32 未优化版 ONNX 模型（含 `.data`，CPU 兼容） |
| `sifigan_stats.joblib` | ~2.5 KB | 特征归一化统计文件 |

### FP16 量化

通过 `quantize_sifigan_fp16.py` 脚本从 FP32 DML 优化版生成本地 FP16 变体：

```bash
python quantize_sifigan_fp16.py
```

- 压缩比：45.8 MB → 23.1 MB（~1.99x）
- 精度验证：cosine similarity ≥ 0.95（CPU EP 对比 FP32 输出）
- 量化策略：
  - 权重 initializer: float32 → float16
  - 模型 I/O 类型: float32 → float16（与应用层 `createFloatTensor('float16', ...)` 路径匹配）
  - 中间张量: 通过 `onnx.shape_inference` 推断后同步类型
  - Cast 节点处理:
    - `Cast(to=FLOAT)`: `to` 属性改为 `FLOAT16`，输出 value_info 同步转 FP16
    - `Cast(to=INT64/INT32/BOOL)`: 跳过（输出的是索引/形状张量）
  - Constant / ConstantOfShape 节点: 持有的 float32 TensorProto 值转为 float16
- FP16 变体不通过 ModelScope 下载，需在本地运行量化脚本生成

### 差异对比表

| 特性 | 默认 Vocoder | SiFiGAN |
|------|--------------|---------|
| 架构 | HiFi-GAN 变体 | Source-Filter HiFi-GAN |
| 输入 | mel (128 维) | mel (128 维) + f0 (1 维) |
| 音高可控 | 否 | 是 |
| DirectML 支持 | 需 optimize_vocoder_dml.py | 需 optimize_sifigan_dml.py |
| 模型大小 | 495 MB (FP16) | 611 MB (FP32) |
| 训练数据 | SoulX-Singer 项目私有 | LibriTTS-R + NUS-48E 公开 |
| 采样率 | 24 kHz | 24 kHz |
| 推理速度 | 标准 | 相当或更快（source-filter 解耦） |
| 适用场景 | 默认 SVS 合成 | 需要音高控制、英文/歌唱场景 |

### 引用

```bibtex
@INPROCEEDINGS{10095298,
  author={Yoneyama, Reo and Wu, Yi-Chiao and Toda, Tomoki},
  booktitle={ICASSP 2023 - 2023 IEEE International Conference on Acoustics, Speech and Signal Processing (ICASSP)},
  title={{Source-Filter HiFi-GAN: Fast and Pitch Controllable High-Fidelity Neural Vocoder}},
  year={2023},
  pages={1-5},
  doi={10.1109/ICASSP49357.2023.10095298}
}
```

## 使用示例

### Python (onnxruntime)

```python
import onnxruntime as ort
import numpy as np

# 加载模型
sess = ort.InferenceSession("onnx_models/mel_transform.onnx")

# 准备输入 (5秒音频，24kHz采样率)
audio = np.random.randn(1, 24000 * 5).astype(np.float32)

# 推理
outputs = sess.run(None, {"waveform": audio})
mel_spec = outputs[0]  # (batch, seq_len, mel_bins)
```

### C++ (ONNX Runtime)

```cpp
#include <onnxruntime/core/session/onnxruntime_cxx_api.h>

Ort::Env env(ORT_LOGGING_LEVEL_WARNING);
Ort::Session session(env, "onnx_models/vocoder.onnx", Ort::SessionOptions{nullptr});

std::vector<const char*> input_names = {"mel"};
std::vector<const char*> output_names = {"waveform"};

std::vector<float> mel_input(/* your mel input data */);
std::vector<float> waveform_output;

session.Run(Ort::RunOptions{nullptr},
            input_names.data(), &mel_input, 1,
            output_names.data(), &waveform_output, 1);
```

## 模型参数

- **采样率**: 24000 Hz
- **hop_size**: 480
- **n_fft**: 1920
- **win_length**: 1920
- **num_mels**: 128
- **mel_dim**: 100
- **hidden_size**: 1024

## 注意事项

1. **vocoder.onnx**: 使用 `torch-istft-onnx` 实现，支持复数 ISTFT 操作
2. **动态轴**: 所有模型支持动态 batch_size 和 seq_len
3. **数据类型**: 输入输出均为 Float32 类型
4. **WhisperEncoder**: 未导出（SVC 模型的 whisper 编码器无法导出到 ONNX）

## 依赖

- onnxruntime >= 1.17
- numpy >= 1.23

## 导出命令

```bash
python convert_to_onnx.py --model-type both
```

- `--model-type soulx`: 仅导出 SoulXSinger 模型
- `--model-type svc`: 仅导出 SVC 模型
- `--model-type both`: 导出两个模型（默认）
