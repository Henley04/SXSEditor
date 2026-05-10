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
