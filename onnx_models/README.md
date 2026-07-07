# SoulX-Singer ONNX 模型

SoulX-Singer 模型转换为 ONNX 格式，用于非 PyTorch 环境的推理部署。

## 导出模型

### 默认主路径（FP32 opset 20, DML 兼容）

**导出脚本:** `export_pipeline.py`（一键导出全部 13 个模型）
**精度验证:** `scripts/verify_module_precision.py`（模块级）, `scripts/verify_e2e_precision.py`（端到端）

#### SoulXSinger 基础模型 (`onnx_models/`, 9 个 FP32 opset 20)

| 模型文件 | 输入 | 输出 | 说明 |
|---------|------|------|------|
| `note_text_encoder.onnx` | `(1, 100)` int64 | `(1, 100, 512)` float32 | 文本嵌入（静态形状） |
| `note_pitch_encoder.onnx` | `(1, 100)` int64 | `(1, 100, 512)` float32 | 音高嵌入 |
| `note_type_encoder.onnx` | `(1, 100)` int64 | `(1, 100, 512)` float32 | 音符类型嵌入 |
| `f0_encoder.onnx` | `(1, 200)` int64 | `(1, 200, 512)` float32 | F0 轮廓嵌入 |
| `preflow.onnx` | `(1, 100, 512)` float32 | `(1, 100, 512)` float32 | 预处理流（ConvNeXtV2） |
| `mel_transform.onnx` | `(1, 24000)` float32 | `(1, 50, 128)` float32 | 音频转梅尔频谱（STFT→Conv） |
| `cond_emb.onnx` | `(1, 100, 512)` float32 | `(1, 100, 1024)` float32 | 条件嵌入（nn.Linear） |
| `diff_step_dml.onnx` | `xt_input(1,2048,128), t(1), cond(1,2048,512), xt_mask(1,2048)` | `(1, 2048, 128)` float32 | flow-matching 步骤预测（DiffLlama + 内嵌 cond_emb） |
| `vocoder_dml.onnx` | `(1, 500, 128)` float32 | `(1, 240000)` float32 `waveform` | 梅尔频谱转波形（VocosFullWrapper：MatMul IDFT + manual overlap-add） |

#### JP 日文模型 (`onnx_models/JP/`, 4 个 FP32 opset 20)

| 模型文件 | 说明 |
|---------|------|
| `note_text_encoder.onnx` | 日文扩展音素嵌入 |
| `preflow.onnx` | 日文微调预处理流 |
| `cond_emb.onnx` | 日文条件嵌入 |
| `diff_step_dml.onnx` | 日文微调 flow-matching 步骤预测 |

### 可选精度路径

| 路径 | 目录 | 说明 |
|------|------|------|
| FP32 主路径 | `onnx_models/` | 默认，opset 20，DML 兼容 |
| W16A32 | `onnx_models/fp16/` | FP16 权重 + FP32 激活（`export_step2_vocoder_w16a32.py` 等） |
| INT8 | `onnx_models/int8/` | W8A8 量化（`quantize_w8a8_v2.py`） |
| INT8-NPU | `onnx_models/int8/optimized_npu/` | NPU 静态形状优化（`optimize_npu_int8.py`） |

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
- **mel_dim**: 128
- **hidden_size**: 1024
- **opset 版本**: 20（FP32 主路径，DML 兼容最大值）

## 注意事项

1. **vocoder_dml.onnx**: 使用 `VocosFullWrapper` 导出，包含完整 ISTFT 重建（MatMul IDFT + manual overlap-add），输出名为 `waveform`（非旧版的 `spec`）
2. **静态形状**: FP32 主路径模型使用静态形状（dynamo=True 导出），不支持动态 batch_size/seq_len
3. **数据类型**: 输入输出均为 Float32 类型（除 note_*_encoder/f0_encoder 输入为 int64）
4. **diff_step_dml.onnx**: 内嵌 cond_emb（DiffStepWrapper），输入 cond 为 512 维 cond_code，非 1024 维 cond_embedding
5. **DML 兼容**: 所有 FP32 主路径模型不包含 STFT/DFT/ConvTranspose(stride>1)/Col2Im 等 DML 不支持算子
6. **opset 20**: 使用 ONNX opset 20（DML EP 支持的最大版本），改进 Cast 算子和内核选择

## 精度验证

### 模块级精度（9 个 FP32 模型 vs PyTorch 子模块）

```powershell
python scripts/verify_module_precision.py --verbose
```

阈值: COS ≥ 0.99, SNR ≥ 30dB（mel_transform/vocoder 放宽至 COS ≥ 0.95, SNR ≥ 25dB）
报告: `scripts/precision_report.json`

### 端到端精度（PyTorch model.infer vs ONNX 管线复现）

```powershell
python scripts/verify_e2e_precision.py --verbose
```

阈值: COS ≥ 0.95, SNR ≥ 20dB
报告: `scripts/e2e_precision_report.json`

## 依赖

- onnxruntime >= 1.17（推荐 1.27+）
- numpy >= 1.23
- torch >= 2.6（导出脚本需要 dynamo 支持）

## 导出命令

```powershell
# 一键导出全部 FP32 opset 20 模型（13 个，约 5 分钟）
python export_pipeline.py

# 单步导出
python export_step1_diffstep.py    # diff_step_dml.onnx
python export_step2_vocoder.py     # vocoder_dml.onnx (full ISTFT)
python export_step3_postprocess.py # 其他 7 个基础模型
python export_step4_jp.py          # 4 个 JP 模型
```
