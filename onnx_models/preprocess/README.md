# Preprocess ONNX 模型

音频预处理模型（音高检测和 MIDI 音符识别）转换为 ONNX 格式。

## ⚠️ 版本要求（2026-10-24）

RMVPE 的旧模型（`preprocess/rmvpe_model.onnx`，输入固定 240000 采样）存在致命缺陷：
应用按 `(T帧, 2560类)` 解码，而图实际输出 `(1, T, 360)`，`base = t * 2560` 迅速越界，
argmax 永远停在 0 —— **F0 曲线整段锁死在 30 Hz**，"提取 F0 / 音频转 MIDI" 实际不可用。

修复版模型已发布，**必须升级到下列版本**，旧模型与新代码互不兼容（新代码会抛
`INVALID_MODEL_OUTPUT` 拒绝加载）：

| ModelScope 仓库 | 最低版本 |
|---|---|
| `syxppp/SoulX-Singer-onnx-directml` | **v2** |
| `syxppp/SoulX-Singer-onnx-directml-fp16` | **v3** |
| `syxppp/SoulX-Singer-onnx-directml-int8` | **v1** |
| `syxppp/SoulX-Singer-onnx-directml-int8-dynamic` | **v1** |


## 模型列表

### RMVPE 音高检测 (`rmvpe_mel.onnx`, `rmvpe_model.onnx`)

`rmvpe_model.onnx` 是端到端模型：输入 16 kHz 原始波形，图内完成
STFT → 128 维 log-mel → DeepUnet（5 层下采样）→ BiGRU → 360 维音高 salience。

| 模型文件 | 输入 | 输出 | 说明 |
|---------|------|------|------|
| `rmvpe_model.onnx` | `audio` `(batch, num_samples)` Float | `salience` `(batch, time_frames, 360)` Float | 音高 salience（Sigmoid，0~1） |
| `rmvpe_mel.onnx` | `(batch, num_samples)` Float | `(batch, mel_bins, time_frames)` Float | 仅梅尔频谱（调试用，主流程不使用） |

**参数**（与官方 RMVPE 一致）:
- 采样率: 16000 Hz
- n_fft: 1024，hop_length: 160，win_length: 1024，Hann 窗，`center=True`
- num_mels: 128，mel_fmin: 30，mel_fmax: 8000（`htk=True`），log-clamp: 1e-5
- t_min: 30 Hz（cents 映射下限）

**输出契约**:
- `time_frames = 1 + floor(num_samples / 160)`，每帧 10 ms
- **`time_frames` 必须是 32 的倍数**：U-Net 有 5 次 stride-2 下采样，
  否则 AvgPool 取整后 Decoder 的 concat 尺寸对不上，session 直接报错。
  调用方在末尾补零到 `(32k - 1) * 160` 采样即可（见 `rmvpePitchDetector.js`）。
- salience 的每个 bin 对应 `cents = 20 * bin + 1997.3794084376191`
- 解码（`RmvpePitchDetector.decodeSalience` 内实现，与 RVC `RMVPE.decode` 等价）:
  1. `bin = argmax(salience[t])`
  2. 在 `bin ± 4` 的 9 个 bin 上按 salience 加权平均 cents（超出 0..359 视为权重 0）
  3. `f0 = 10 * 2 ** (cents / 1200)`
  4. `max(salience[t]) <= 0.03` → 清音，`f0 = 0`

> 历史问题：旧版模型固定输入 `240000` 采样（15 s），输出被 JS 当成
> `(T, 2560)` 读取，实际是 `(1, 1504, 360)`。`base = t * 2560` 很快越界，
> `Float32Array` 返回 `undefined`，argmax 永远停在 0 → 整条曲线锁死在 30 Hz。
> 修复版把输入改为动态长度、类别数固定 360，并在 JS 侧显式校验形状。

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
import numpy as np
import onnxruntime as ort

# RMVPE 音高检测（帧数必须 32 对齐）
sess = ort.InferenceSession("onnx_models/preprocess/rmvpe_model.onnx")
audio = np.zeros(16000, dtype=np.float32)                 # 1 秒音频
frames = 1 + len(audio) // 160                            # 101
aligned = ((frames + 31) // 32) * 32                      # 128
n_pad = (aligned - 1) * 160                               # 20320
audio = np.pad(audio, (0, max(0, n_pad - len(audio))))
salience = sess.run(None, {"audio": audio[None, :]})[0]   # (1, 128, 360)

# 解码：argmax -> ±4 bin 加权平均 cents -> Hz
CENTS = 20 * np.arange(360) + 1997.3794084376191
f0 = np.zeros(salience.shape[1], dtype=np.float32)
for t, row in enumerate(salience[0]):
    c = int(row.argmax())
    if row[c] <= 0.03:                                    # 清音
        continue
    lo, hi = max(0, c - 4), min(359, c + 4)
    w = row[lo:hi + 1]
    f0[t] = 10 * 2 ** ((w * CENTS[lo:hi + 1]).sum() / w.sum() / 1200)
```

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
# 修复版 RMVPE（端到端，动态长度，360 类 salience）
python scripts/export_rmvpe_onnx.py --ckpt rmvpe.pt --out onnx_models/preprocess/rmvpe_model.onnx
python scripts/export_rmvpe_onnx.py --ckpt rmvpe.pt --out rmvpe_model_int8.onnx --precision int8

# 导出后自检（与官方 torch 实现逐帧对比）
python scripts/export_rmvpe_onnx.py --ckpt rmvpe.pt --out /tmp/m.onnx --verify

# 其余预处理模型（ROSVOT 等）沿用原来的导出脚本
python export_preprocess.py --model-type rosvot --output-dir onnx_models/preprocess
```

## 注意事项

1. **STFT 实现**: 修复版 RMVPE 用 `conv1d` 分帧（等价 `torch.stft(center=True)`），只依赖 Pad/Conv/Slice，避免 STFT 算子在 DirectML 上的兼容问题
2. **Mel Spectrogram**: 使用 librosa 的 mel 滤波器（`htk=True`, fmin 30, fmax 8000）计算梅尔频谱
3. **动态轴**: `audio` 的第 1 维与 `salience` 的 time 维都是动态的，但 **time 必须是 32 的倍数**
4. **GRU 警告**: 导出时会有 GRU 变长 batch 警告，属正常现象（batch 恒为 1）

## 依赖

- onnxruntime >= 1.17
- numpy >= 1.23
- librosa >= 0.10
