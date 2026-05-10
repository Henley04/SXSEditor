# SoulX-Singer ExecuTorch 模型导出文档

## 概述

本文档描述了 SoulX-Singer SVS（歌声合成）模型导出到 ExecuTorch 格式的详细信息，包括模型架构、导出策略、推理流程和使用示例。

## 模型拆分策略

根据 ExecuTorch 的算子支持限制，SVS 模型被拆分为以下子模型：

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  encoder.pte     │     │  cfm_step.pte    │     │  vocoder         │
│  编码器          │────▶│  CFM单步扩散     │────▶│  vocos_backbone  │
│                  │     │                  │     │  + istft_head    │
└──────────────────┘     └──────────────────┘     └──────────────────┘
        ↑                        ↑                        ↑
   离线预处理               推理脚本循环              CPU后处理
   生成输入              n_steps 次调用            ISTFT重建
```

## 导出的模型文件

| 模型文件 | 大小 | 输入 | 输出 | 说明 |
|---------|------|------|------|------|
| `encoder.pte` | 23.72 MB | phoneme, note_pitch, note_type, f0_coarse, mel2note | cond_feat [1, F, 1024] | 音符编码 + ConvNeXtV2 + 帧对齐 |
| `cfm_step.pte` | 1688.72 MB | xt_input, t, cond, x_mask | flow_pred [1, F, 128] | CFM单步扩散预测 |
| `vocos_backbone.pte` | 965.51 MB | mel [1, 128, F] | features [1, F, 1024] | Vocos骨干网络 |
| `istft_head_linear.pte` | 7.52 MB | features [1, F, 1024] | mag_phase [1, 1922, F] | ISTFT头部Linear层 |

## 模型输入输出详细规格

### 1. Encoder (encoder.pte)

**输入:**

| 名称 | 形状 | 类型 | 范围 | 说明 |
|------|------|------|------|------|
| phoneme | [1, N] | int64 | 0-2999 | 音素ID序列 |
| note_pitch | [1, N] | int64 | 0-255 | MIDI音高 (0=休止) |
| note_type | [1, N] | int64 | 1-3 | 音符类型 (1=休止, 2=正常, 3=延续) |
| f0_coarse | [1, F] | int64 | 0-360 | 量化F0 (0=清音, 1-360=C1-B6) |
| mel2note | [1, F] | int64 | 0-N-1 | 帧到音符索引映射 |

**输出:**

| 名称 | 形状 | 类型 | 说明 |
|------|------|------|------|
| cond_feat | [1, F, 1024] | float32 | 条件特征 |

**动态维度:**
- `N`: 音符数量 (1-2000)
- `F`: 帧数量 (1-10000)

### 2. CFM-Step (cfm_step.pte)

**输入:**

| 名称 | 形状 | 类型 | 说明 |
|------|------|------|------|
| xt_input | [1, F_total, 128] | float32 | 当前步噪声梅尔频谱 |
| t | [1] | float32 | 扩散时间步 [0, 1] |
| cond | [1, F_total, 1024] | float32 | 条件嵌入 |
| x_mask | [1, F_total] | float32 | 掩码 (全1) |

**输出:**

| 名称 | 形状 | 类型 | 说明 |
|------|------|------|------|
| flow_pred | [1, F_total, 128] | float32 | 预测的速度场 |

**动态维度:**
- `F_total`: 总帧数 = F_prompt + F_target (1-20000)

### 3. Vocos Backbone (vocos_backbone.pte)

**输入:**

| 名称 | 形状 | 类型 | 说明 |
|------|------|------|------|
| mel | [1, 128, F] | float32 | 梅尔频谱 |

**输出:**

| 名称 | 形状 | 类型 | 说明 |
|------|------|------|------|
| features | [1, F, 1024] | float32 | 骨干网络特征 |

### 4. ISTFT Head Linear (istft_head_linear.pte)

**输入:**

| 名称 | 形状 | 类型 | 说明 |
|------|------|------|------|
| features | [1, F, 1024] | float32 | 骨干网络特征 |

**输出:**

| 名称 | 形状 | 类型 | 说明 |
|------|------|------|------|
| mag_phase | [1, 1922, F] | float32 | 幅度和相位 (前961为幅度，后961为相位) |

## 推理流程

### 完整推理伪代码

```python
import numpy as np
import torch
from executorch.runtime import Runtime

# 加载模型
encoder_runtime = Runtime.get_program("encoder.pte")
cfm_runtime = Runtime.get_program("cfm_step.pte")
vocos_runtime = Runtime.get_program("vocos_backbone.pte")
istft_runtime = Runtime.get_program("istft_head_linear.pte")

# ============ 1. 预处理 (CPU/NumPy) ============

# 提取参考梅尔频谱
pt_mel = extract_mel_spectrogram(prompt_wav)  # [1, F_pt, 128]

# F0量化
def f0_to_coarse(f0, f0_bin=361, f0_min=32.7031956625, f0_shift=0):
    """将连续F0值转换为离散bin"""
    uv_mask = f0 <= 0
    f0_safe = np.maximum(f0, f0_min)
    f0_cents = 1200 * np.log2(f0_safe / f0_min)
    f0_coarse = (f0_cents / 20) + 1
    f0_coarse = np.rint(f0_coarse).astype(np.int64)
    f0_coarse = np.clip(f0_coarse, 1, f0_bin - 1)
    f0_coarse[uv_mask] = 0
    if f0_shift != 0:
        voiced = f0_coarse > 0
        if np.any(voiced):
            shifted = f0_coarse[voiced] + f0_shift
            f0_coarse[voiced] = np.clip(shifted, 1, f0_bin - 1)
    return f0_coarse

f0_coarse_pt = f0_to_coarse(pt_f0)
f0_coarse_gt = f0_to_coarse(gt_f0, f0_shift=pitch_shift * 5)
f0_coarse = np.concatenate([f0_coarse_pt, f0_coarse_gt], axis=1)

# ============ 2. Encoder推理 ============

cond_feat = encoder_runtime.run(
    phoneme=np.concatenate([pt_phoneme, gt_phoneme], axis=1),
    note_pitch=np.concatenate([pt_note_pitch, gt_note_pitch], axis=1),
    note_type=np.concatenate([pt_note_type, gt_note_type], axis=1),
    f0_coarse=f0_coarse,
    mel2note=np.concatenate([pt_mel2note, gt_mel2note + len_pt], axis=1),
)

# 分割条件特征
F_pt = pt_mel.shape[1]
pt_decoder_inp = cond_feat[:, :F_pt, :]
gt_decoder_inp = cond_feat[:, F_pt:, :]

# ============ 3. CFM条件嵌入 ============

# cond_emb是一个简单的Linear层，可以合并到encoder或单独实现
# 这里假设已经包含在encoder输出中，或者需要额外的Linear层
diffusion_cond = np.concatenate([pt_decoder_inp, gt_decoder_inp], axis=1)

# ============ 4. CFM反向扩散循环 ============

n_steps = 32
cfg = 3.0
rescale_cfg = 0.75
h = 1.0 / n_steps

F_target = gt_decoder_inp.shape[1]
z = np.random.randn(1, F_target, 128).astype(np.float32)
xt = z

for i in range(n_steps):
    # 拼接参考和目标
    xt_input = np.concatenate([pt_mel, xt], axis=1)
    t = np.array([0 + (i + 0.5) * h], dtype=np.float32)
    x_mask = np.ones((1, F_pt + F_target), dtype=np.float32)
    
    # 有条件预测
    flow_pred = cfm_runtime.run(
        xt_input=xt_input,
        t=t,
        cond=diffusion_cond,
        x_mask=x_mask,
    )
    flow_pred = flow_pred[:, F_pt:, :]
    
    # CFG: 无条件预测
    uncond_cond = np.zeros_like(diffusion_cond)[:, :F_target, :]
    uncond_flow_pred = cfm_runtime.run(
        xt_input=xt,
        t=t,
        cond=uncond_cond,
        x_mask=np.ones((1, F_target), dtype=np.float32),
    )
    
    # CFG增强
    pos_std = flow_pred.std()
    flow_pred_cfg = flow_pred + cfg * (flow_pred - uncond_flow_pred)
    rescale_flow_pred = flow_pred_cfg * pos_std / flow_pred_cfg.std()
    flow_pred = rescale_cfg * rescale_flow_pred + (1 - rescale_cfg) * flow_pred_cfg
    
    # 更新
    xt = xt + flow_pred * h

generated_mel = xt  # [1, F_target, 128]

# ============ 5. Vocoder重建 ============

# Vocos骨干网络
backbone_features = vocos_runtime.run(mel=generated_mel.transpose(0, 2, 1))

# ISTFT头部Linear层
mag_phase = istft_runtime.run(features=backbone_features)

# ============ 6. CPU实现ISTFT ============

def istft_reconstruction(mag_phase, n_fft=1920, hop_length=480, win_length=1920):
    """CPU实现的ISTFT重建"""
    mag = mag_phase[:, :n_fft//2+1, :]
    phase = mag_phase[:, n_fft//2+1:, :]
    
    # 指数变换幅度
    mag = np.exp(np.clip(mag, None, 100))
    
    # 构造复数频谱
    S = mag * (np.cos(phase) + 1j * np.sin(phase))
    
    # ISTFT
    window = np.hanning(win_length)
    audio = scipy.signal.istft(
        S, 
        nperseg=win_length, 
        noverlap=win_length - hop_length,
        window=window
    )[1]
    
    return audio

audio = istft_reconstruction(mag_phase)

# 保存
import soundfile as sf
sf.write("output.wav", audio, 24000)
```

## 梅尔频谱提取 (CPU实现)

由于 ExecuTorch 不支持 STFT，梅尔频谱提取需要在 CPU 上实现：

```python
import numpy as np
import librosa

def extract_mel_spectrogram(
    wav, 
    sr=24000, 
    n_fft=1920, 
    hop_length=480, 
    win_length=1920,
    n_mels=128, 
    fmin=0, 
    fmax=12000,
    mel_mean=-4.92,
    mel_var=8.14
):
    """
    提取归一化对数梅尔频谱
    
    Args:
        wav: 音频波形 [T]
        sr: 采样率
        n_fft: FFT大小
        hop_length: 帧移
        win_length: 窗长
        n_mels: 梅尔滤波器组数量
        fmin: 最低频率
        fmax: 最高频率
        mel_mean: 归一化均值
        mel_var: 归一化方差
    
    Returns:
        mel: 归一化对数梅尔频谱 [F, 128]
    """
    # 反射填充
    pad = (n_fft - hop_length) // 2
    wav = np.pad(wav, (pad, pad), mode='reflect')
    
    # STFT
    spec = librosa.stft(
        wav, 
        n_fft=n_fft, 
        hop_length=hop_length, 
        win_length=win_length,
        center=False
    )
    
    # 幅度谱
    mag = np.abs(spec)
    
    # 梅尔滤波
    mel = librosa.feature.melspectrogram(
        S=mag**2, 
        sr=sr, 
        n_mels=n_mels, 
        fmin=fmin, 
        fmax=fmax,
        n_fft=n_fft
    )
    
    # 对数压缩
    log_mel = np.log(np.clip(mel, a_min=1e-5, a_max=None))
    
    # 方差归一化
    log_mel = (log_mel - mel_mean) / np.sqrt(mel_var)
    
    return log_mel.T  # [F, 128]
```

## 音素处理

音素ID转换需要使用 `phone_set.json`：

```python
import json

# 加载音素映射表
with open("soulxsinger/utils/phoneme/phone_set.json", "r", encoding="utf-8") as f:
    phone_set = json.load(f)

# 音素字符串转ID
def phoneme_to_ids(phoneme_list, phone_set):
    """将音素列表转换为ID序列"""
    ids = []
    for phoneme in phoneme_list:
        if phoneme in phone_set:
            ids.append(phone_set[phoneme])
        else:
            ids.append(phone_set.get("<UNK>", 0))
    return np.array([ids], dtype=np.int64)  # [1, N]
```

## 特殊标记

| 标记 | ID | 说明 |
|------|-----|------|
| PAD | 0 | 填充 |
| SP | 1 | 句子停顿 |
| AP | 2 | 气声 |
| BOW | 4 | 词首 |
| EOW | 5 | 词尾 |
| SEP | 9 | 音素分隔 (英语) |

## 推理参数

| 参数 | 默认值 | 范围 | 说明 |
|------|--------|------|------|
| n_steps | 32 | 1-100 | 扩散步数，越多质量越好但速度越慢 |
| cfg | 3.0 | 0-10 | Classifier-Free Guidance 强度 |
| rescale_cfg | 0.75 | 0-1 | CFG重缩放系数 |
| pitch_shift | 0 | -12~12 | 音高偏移 (半音) |

## 音频配置

| 参数 | 值 |
|------|-----|
| 采样率 | 24000 Hz |
| hop_size | 480 (20ms) |
| n_fft | 1920 |
| win_size | 1920 |
| num_mels | 128 |
| fmin | 0 Hz |
| fmax | 12000 Hz |

## 模型配置

| 参数 | 值 |
|------|-----|
| vocab_size | 3000 |
| text_dim | 512 |
| pitch_dim | 512 |
| type_dim | 512 |
| f0_dim | 512 |
| f0_bin | 361 |
| hidden_size | 1024 |
| num_layers (CFM) | 22 |
| num_heads | 16 |
| mel_dim | 128 |

## 已知限制

1. **ISTFT需要CPU实现**：ExecuTorch不支持FFT/复数运算
2. **MelSpectrogram建议CPU预处理**：STFT算子在ExecuTorch中支持有限
3. **CFM需要循环调用**：单步模型需要在推理脚本中循环n_steps次
4. **CFG需要两次前向**：每个扩散步需要分别计算有条件和无条件预测

## 性能优化建议

1. **量化**：可以使用INT8量化减小模型大小和提升推理速度
2. **批处理**：对于批量推理，可以合并多个样本
3. **缓存**：参考段的条件特征可以缓存复用
4. **异步**：CPU预处理和模型推理可以流水线并行

## 文件结构

```
executorch_models/
├── encoder.pte              # 编码器模型
├── cfm_step.pte             # CFM单步模型
├── vocos_backbone.pte       # Vocos骨干网络
├── istft_head_linear.pte    # ISTFT头部Linear层
├── encoder.onnx             # ONNX格式 (备用)
├── cfm_step.onnx            # ONNX格式 (备用)
├── vocos_backbone.onnx      # ONNX格式 (备用)
└── istft_head.onnx          # ONNX格式 (备用)
```

## 导出脚本

导出脚本位于: `export_to_executorch.py`

使用方法:
```bash
python export_to_executorch.py \
    --model_dir path/to/model.pt \
    --output_dir ./executorch_models
```

可选参数:
- `--skip_mel`: 跳过MelSpectrogram导出
- `--skip_encoder`: 跳过Encoder导出
- `--skip_cfm`: 跳过CFM导出
- `--skip_vocoder`: 跳过Vocoder导出
