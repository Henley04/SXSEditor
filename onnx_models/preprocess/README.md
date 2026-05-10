# Preprocess ONNX 模型

音频预处理模型（音高检测和 MIDI 音符识别）转换为 ONNX 格式。

## 模型列表

### RMVPE 音高检测 (`rmvpe_mel.onnx`, `rmvpe_model.onnx`)

| 模型文件 | 输入 | 输出 | 说明 |
|---------|------|------|------|
| `rmvpe_mel.onnx` | `(batch, num_samples)` Float | `(batch, mel_bins, time_frames)` Float | 音频转梅尔频谱 |
| `rmvpe_model.onnx` | `(batch, num_samples)` Float | `(batch, time_frames, n_class)` Float | 音高检测 |

**参数**:
- 采样率: 16000 Hz
- n_fft: 2048
- hop_length: 160
- win_length: 2048
- num_mels: 128
- mel_fmin: 30
- mel_fmax: 7600

### ROSVOT MIDI 识别 (`rosvot_mel.onnx`, `rosvot_model.onnx`)

| 模型文件 | 输入 | 输出 | 说明 |
|---------|------|------|------|
| `rosvot_mel.onnx` | `(batch, num_samples)` Float | `(batch, time_frames, mel_bins)` Float | 音频转梅尔频谱 |
| `rosvot_model.onnx` | `wav, pitch, uv, word_bd` | `note_bd_pred, note_pred, note_lengths` | MIDI/Note 识别 |

**参数**:
- 采样率: 24000 Hz
- fft_size: 2048
- hop_size: 480
- win_size: 2048
- num_mels: 80
- fmin: 30
- fmax: 7600

## 使用示例

### Python (onnxruntime)

```python
import onnxruntime as ort
import numpy as np

# RMVPE 音高检测
sess = ort.InferenceSession("onnx_models/preprocess/rmvpe_model.onnx")
audio = np.random.randn(16000).astype(np.float32)  # 1秒音频
outputs = sess.run(None, {"audio": audio.reshape(1, -1)})
pitch_hidden = outputs[0]  # (batch, time_frames, n_class)

# ROSVOT MIDI 识别
sess = ort.InferenceSession("onnx_models/preprocess/rosvot_model.onnx")
wav = np.random.randn(1, 24000 * 5).astype(np.float32)  # 5秒音频
pitch = np.zeros((1, 3200), dtype=np.int64)
uv = np.zeros((1, 3200), dtype=np.int64)
word_bd = np.zeros((1, 3200), dtype=np.int64)
outputs = sess.run(None, {"wav": wav, "pitch": pitch, "uv": uv, "word_bd": word_bd})
note_bd_pred, note_pred, note_lengths = outputs
```

## 导出命令

```bash
# 导出所有预处理模型
python export_preprocess.py --model-type both --output-dir onnx_models/preprocess

# 仅导出 RMVPE
python export_preprocess.py --model-type rmvpe --output-dir onnx_models/preprocess

# 仅导出 ROSVOT
python export_preprocess.py --model-type rosvot --output-dir onnx_models/preprocess
```

## 注意事项

1. **STFT 实现**: 所有模型使用 `return_complex=False` 的 STFT 实现以确保 ONNX 兼容性
2. **Mel Spectrogram**: 使用 librosa 的 mel 滤波器计算梅尔频谱
3. **动态轴**: 所有模型支持动态 batch_size 和 seq_len
4. **GRU 警告**: rmvpe_model 导出时会有 GRU batch_size 警告，保存时确保 batch_size=1

## 依赖

- onnxruntime >= 1.17
- numpy >= 1.23
- librosa >= 0.10
