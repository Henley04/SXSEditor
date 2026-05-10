# SoulX-Singer 项目 ONNX 迁移文档

## a. 项目概述

### 功能类型

SoulX-Singer 是一个**歌声合成 (Singing Voice Synthesis, SVS) + 歌声转换 (Singing Voice Conversion, SVC)** 系统，支持普通话、粤语、英语三种语言。项目包含两条核心推理管线：

| 管线 | 功能 | 输入 | 输出 |
|------|------|------|------|
| **SoulXSinger (SVS)** | 歌声合成 | 参考音频 + 目标乐谱/旋律元数据 | 目标歌声波形 |
| **SoulXSingerSVC (SVC)** | 歌声转换 | 参考音频 + 目标音频 + F0曲线 | 目标歌声波形 |

### 技术路线

- **声学模型**：基于 Flow Matching (Conditional Flow Matching, CFM) 的扩散模型，核心为 DiffLlama（改造自 HuggingFace Llama 解码器，替换 RMSNorm 为自适应 RMSNorm）
- **条件编码器（SVS）**：音素嵌入 + 音高嵌入 + 音符类型嵌入 → ConvNeXtV2 预处理 → 帧对齐扩展 + F0 嵌入
- **条件编码器（SVC）**：Whisper-base 编码器提取内容特征 + F0 嵌入
- **声码器**：Vocos（基于 ConvNeXt 骨干 + ISTFT 重建头），从梅尔频谱重建波形
- **梅尔频谱提取**：自定义 MelSpectrogram 模块（STFT → mel 滤波 → 对数压缩 → 方差归一化）

### 音频配置（默认）

| 参数 | 值 |
|------|----|
| 采样率 | 24000 Hz |
| hop_size | 480 (20ms) |
| n_fft | 1920 |
| win_size | 1920 |
| num_mels | 128 |
| fmin | 0 Hz |
| fmax | 12000 Hz |
| mel_mean | -4.92 |
| mel_var | 8.14 |

---

## b. 模型输入/输出详细规范

### b.1 SoulXSinger (SVS) 模型

#### 推理入口：`SoulXSinger.infer()`

**用户级输入（meta 字典）**

| 名称 | 形状 | 数据类型 | 语义 | 角色 |
|------|------|----------|------|------|
| `meta['target']['phoneme']` | [1, N_target] | int64 | 目标音符的音素 ID 序列（含 `<BOW>`, `<EOW>`, `<SEP>` 等特殊标记） | 模型输入 |
| `meta['target']['mel2note']` | [1, F_target] | int64 | 目标段每帧梅尔频谱到音符索引的映射表 | 模型输入 |
| `meta['target']['note_type']` | [1, N_target] | int64 | 目标音符类型（1=休止, 2=正常, 3=延续） | 模型输入 |
| `meta['target']['note_pitch']` | [1, N_target] | int64 | 目标音符 MIDI 音高（0=休止），仅 score 模式使用 | 模型输入 |
| `meta['target']['f0']` | [1, F_target] | float32 | 目标段帧级 F0 曲线（Hz，0=清音），仅 melody 模式使用 | 模型输入 |
| `meta['prompt']['phoneme']` | [1, N_prompt] | int64 | 参考段音素 ID 序列 | 模型输入 |
| `meta['prompt']['mel2note']` | [1, F_prompt] | int64 | 参考段帧到音符映射 | 模型输入 |
| `meta['prompt']['note_type']` | [1, N_prompt] | int64 | 参考段音符类型 | 模型输入 |
| `meta['prompt']['note_pitch']` | [1, N_prompt] | int64 | 参考段 MIDI 音高，仅 score 模式 | 模型输入 |
| `meta['prompt']['f0']` | [1, F_prompt] | float32 | 参考段 F0 曲线，仅 melody 模式 | 模型输入 |
| `meta['prompt']['waveform']` | [1, T_prompt] | float32 | 参考音频波形（单声道, 24kHz） | 模型输入 |

- `N_target` / `N_prompt`：音符级序列长度（含 `<BOW>/<EOW>` 扩展后的音素数）
- `F_target` / `F_prompt`：帧级序列长度 = 音频采样点数 / hop_size
- `T_prompt`：参考音频采样点数

**最终输出**

| 名称 | 形状 | 数据类型 | 语义 | 角色 |
|------|------|----------|------|------|
| `generated_audio` | [1, T_out] | float32 | 生成的歌声波形（单声道, 24kHz, PCM float32） | 最终用户输出 |

#### 内部子模块张量流

**1) 梅尔频谱编码器 `MelSpectrogramEncoder`**

| 输入 | 形状 | 类型 | 说明 |
|------|------|------|------|
| `pt_wav` | [1, T_wav] | float32 | 参考音频波形 |

| 输出 | 形状 | 类型 | 说明 |
|------|------|------|------|
| `pt_mel` | [1, F, 128] | float32 | 归一化对数梅尔频谱（减均值除标准差） |

- 梅尔频谱参数：128 维, fmin=0, fmax=12000, n_fft=1920, hop=480, win=1920
- 归一化：`(mel - mel_mean) / sqrt(mel_var)`，其中 mel_mean=-4.92, mel_var=8.14

**2) 音符编码器组**

| 模块 | 输入 | 输入形状 | 输出形状 | 说明 |
|------|------|----------|----------|------|
| `note_text_encoder` (Embedding) | phoneme IDs | [1, N] | [1, N, 512] | vocab_size=3000, dim=512 |
| `note_pitch_encoder` (Embedding) | note_pitch | [1, N] | [1, N, 512] | num_embeddings=256, dim=512 |
| `note_type_encoder` (Embedding) | note_type | [1, N] | [1, N, 512] | num_embeddings=256, dim=512 |
| `f0_encoder` (Embedding) | f0_coarse | [1, F] | [1, F, 512] | num_embeddings=361, dim=512 |

- 三种音符嵌入相加：`features = pitch_emb + type_emb + text_emb`
- F0 量化：连续 F0 → 361 bin 离散化（C1~B6, 20 cents/bin, 0=清音）

**3) ConvNeXtV2 预处理 `preflow`**

| 输入 | 形状 | 说明 |
|------|------|------|
| `features` | [1, N, 512] | 音符嵌入之和 |

| 输出 | 形状 | 说明 |
|------|------|------|
| `features` | [1, N, 1024] | 4 层 ConvNeXtV2Block(dim=512, intermediate_dim=1024) |

**4) 帧对齐扩展 `expand_states`**

| 输入 | 形状 | 说明 |
|------|------|------|
| `h` | [1, N, 1024] | ConvNeXtV2 输出 |
| `mel2token` | [1, F] | 帧到音符索引映射 |

| 输出 | 形状 | 说明 |
|------|------|------|
| `h_expanded` | [1, F, 1024] | 按 mel2note 索引 gather 扩展到帧级 |

- 使用 `torch.gather` 实现索引扩展

**5) CFM 解码器 `CFMDecoder` → `FlowMatchingTransformer.reverse_diffusion`**

| 输入 | 形状 | 说明 |
|------|------|------|
| `pt_mel` | [1, F_prompt, 128] | 参考梅尔频谱（扩散 prompt） |
| `pt_decoder_inp` | [1, F_prompt, 1024] | 参考段条件特征 |
| `gt_decoder_inp` | [1, F_target, 1024] | 目标段条件特征 |
| `n_timesteps` | 标量 int | 扩散步数（默认 32） |
| `cfg` | 标量 float | Classifier-Free Guidance 强度（默认 3.0） |

| 输出 | 形状 | 说明 |
|------|------|------|
| `generated_mel` | [1, F_target, 128] | 生成的目标梅尔频谱 |

- 内部：`cond_emb = Linear(1024 → 1024)(cat([pt_cond, gt_cond], dim=1))`
- 扩散循环：从高斯噪声 `z ~ N(0,1)` 出发，经 `n_timesteps` 步 Euler 积分
- CFG 实现：每步计算有条件和无条件预测，`flow_pred = rescale_cfg * (cfg_pred * σ_pos / σ_cfg) + (1 - rescale_cfg) * cfg_pred`

**6) DiffLlama 核心**

| 输入 | 形状 | 说明 |
|------|------|------|
| `x` | [1, F_total, 128] | 当前步噪声梅尔频谱 |
| `t` | [1] | 扩散时间步 |
| `cond` | [1, F_total, 1024] | 条件嵌入 |
| `x_mask` | [1, F_total] | 掩码（全 1） |

| 输出 | 形状 | 说明 |
|------|------|------|
| `hidden_states` | [1, F_total, 128] | 预测的速度场（mel_dim=128） |

- 内部流程：`mel_mlp(128→1024) + cond_mlp(1024→1024)` → 22 层 LlamaNARDecoderLayer(hidden=1024, heads=16) → AdaptiveRMSNorm(时间步条件) → `mel_out_mlp(1024→128)`
- 注意力掩码：非因果（bidirectional），使用 `_prepare_decoder_attention_mask` 构建

**7) 声码器 `Vocoder` → `Vocos`**

| 输入 | 形状 | 说明 |
|------|------|------|
| `mel` | [1, 128, F] | 生成的梅尔频谱 |

| 输出 | 形状 | 说明 |
|------|------|------|
| `audio` | [1, 1, T_out] | 重建波形 |

- 内部：VocosBackbone(128→1024, 30层ConvNeXtBlock) → ISTFTHead(1024→1922, n_fft=1920, hop=480)
- ISTFTHead：Linear → chunk(mag, phase) → exp(mag) → cos/sin(phase) → 复数 ISTFT

---

### b.2 SoulXSingerSVC (SVC) 模型

#### 推理入口：`SoulXSingerSVC.infer()`

**用户级输入**

| 名称 | 形状 | 数据类型 | 语义 | 角色 |
|------|------|----------|------|------|
| `pt_wav` | [1, T_pt] | float32 | 参考音频波形（单声道, 24kHz） | 模型输入 |
| `gt_wav` | [1, T_gt] | float32 | 目标音频波形（单声道, 24kHz） | 模型输入 |
| `pt_f0` | [1, F_pt] | float32 | 参考 F0 曲线（Hz, 0=清音） | 模型输入 |
| `gt_f0` | [1, F_gt] | float32 | 目标 F0 曲线（Hz, 0=清音） | 模型输入 |

**最终输出**

| 名称 | 形状 | 数据类型 | 语义 | 角色 |
|------|------|----------|------|------|
| `generated_audio` | [1, T_out] | float32 | 转换后的歌声波形 | 最终用户输出 |
| `pitch_shift` | 标量 | int | 实际应用的音高偏移（半音） | 辅助输出 |

#### SVC 特有子模块

**Whisper 编码器 `WhisperEncoder`**

| 输入 | 形状 | 说明 |
|------|------|------|
| `wav` | [1, T_wav] | 音频波形 |

| 输出 | 形状 | 说明 |
|------|------|------|
| `encoder_out` | [1, F_enc, 512] | Whisper-base 编码器输出 |

- 使用 `openai/whisper-base` 预训练模型
- 内部流程：torchaudio 重采样到 16kHz → WhisperFeatureExtractor 提取 80 维 mel → pad/truncate 到 3000 帧 → WhisperModel.encoder → last_hidden_state
- 输出帧率：原始 mel 帧率的一半（约 50Hz / 2 = 25Hz 推断，需验证）
- SVC 中：`pt_content_feat` 和 `gt_content_feat` 分别从参考和目标音频提取，pad 到对应 F0 长度后拼接

**SVC 条件融合**

```
content_feat = cat([pt_content_feat, gt_content_feat], dim=1)  # [1, F_total, 512]
f0_feat = f0_encoder(f0_coarse)                                 # [1, F_total, 512]
features = content_feat + f0_feat                                # [1, F_total, 512]
```

- 注意：SVC 模型的 `cond_emb` 输入维度为 512（非 1024），因为 Whisper 编码器输出 512 维

**长音频分段推理**

- 目标音频 > 30 秒时，按 F0 曲线自动分段（`build_vocal_segments`）
- 分段参数：min_duration=15s, max_duration=30s, uv_frames_th=10
- 段间重叠拼接，避免边界伪影

---

### b.3 预处理工具模型（非核心推理模型，仅供参考）

| 模型 | 功能 | 输入 | 输出 |
|------|------|------|------|
| RMVPE (F0Extractor) | F0 提取 | 音频波形 (16kHz) | F0 曲线 (Hz, 50Hz 帧率) |
| Mel-Band-Roformer | 人声分离 | 混合音频 | 人声 + 伴奏 |
| RosVot | 音符转录 | 音频 + F0 | 音符序列（起止时间、音高、类型） |
| FunASR / NeMo Parakeet | 歌词转录 | 音频 | 词语 + 时间戳 |

---

## c. ONNX 导出与算子兼容性报告

### c.1 PyTorch 算子清单

以下列出模型推理路径中使用的全部 PyTorch 算子：

#### 核心算子（nn.Module 层）

| 算子 | 使用位置 | ONNX Opset 17+ 支持 |
|------|----------|---------------------|
| `nn.Embedding` | 音素/音高/类型/F0 编码器 | ✅ Gather |
| `nn.Linear` | DiffLlama MLP/投影, Vocos, ISTFTHead | ✅ MatMul + Add |
| `nn.Conv1d` | ConvNeXtV2 深度卷积, VocosBackbone embed | ✅ Conv1D |
| `nn.LayerNorm` | ConvNeXtV2, VocosBackbone | ✅ LayerNormalization |
| `nn.GELU` | ConvNeXtV2, VocosBackbone | ✅ GELU |
| `nn.SiLU` | DiffLlama MLP, LlamaAdaptiveRMSNorm | ✅ SiLU (opset 14+) |
| `nn.ConvTranspose1d` | FlowMatchingTransformer resampling | ✅ ConvTranspose |
| `nn.GRU` | RMVPE (预处理, 非推理核心) | ✅ GRU |
| `nn.Conv2d` | RMVPE (预处理) | ✅ Conv2D |
| `nn.BatchNorm2d` | RMVPE (预处理) | ✅ BatchNormalization |
| `nn.Sigmoid` | RMVPE (预处理) | ✅ Sigmoid |
| `nn.LeakyReLU` | Vocos ResBlock1 | ✅ LeakyRelu |
| `nn.AvgPool2d` | RMVPE (预处理) | ✅ AveragePool |
| `nn.Dropout` | RMVPE (预处理, eval 模式下无操作) | ✅ (no-op in eval) |

#### 函数式算子（torch.nn.functional / torch 操作）

| 算子 | 使用位置 | ONNX Opset 17+ 支持 | 备注 |
|------|----------|---------------------|------|
| `torch.gather` | `expand_states` 帧对齐 | ✅ Gather | dim=1, 需正确索引 |
| `torch.cat` | 多处拼接 | ✅ Concat | |
| `torch.clamp` | F0 量化, 音高偏移 | ✅ Clip | |
| `torch.round` | F0 量化 | ✅ Round (opset 11+) | |
| `torch.log2` | F0 量化 | ✅ Log2 (通过 Log/Div) | |
| `torch.maximum` | F0 量化 | ✅ Max | |
| `torch.randn` | 扩散初始化噪声 | ⚠️ 需外部生成 | 需在推理脚本中预生成 |
| `torch.stft` | MelSpectrogram | ⚠️ 有限支持 | ONNX 无原生 STFT 算子 |
| `torch.istft` | ISTFTHead | ⚠️ 有限支持 | ONNX 无原生 ISTFT 算子 |
| `torch.fft.irfft` | IMDCT, ISTFT (same padding) | ⚠️ 有限支持 | ONNX opset 17 有 DFT, 但 irfft 需验证 |
| `torch.fft.fft` | MDCT | ⚠️ 有限支持 | |
| `torch.fft.ifft` | IMDCT | ⚠️ 有限支持 | |
| `torch.view_as_real` | 复数处理 | ⚠️ 需拆分 | 需手动拆分实虚部 |
| `torch.view_as_complex` | 复数处理 | ⚠️ 需拆分 | |
| `torch.rsqrt` | LlamaAdaptiveRMSNorm | ✅ Rsqrt | |
| `torch.pow` | STFT 幅度计算 | ✅ Pow | |
| `torch.sqrt` | STFT 幅度计算 | ✅ Sqrt | |
| `torch.matmul` | Mel 滤波, 注意力 | ✅ MatMul | |
| `torch.nn.functional.pad` | 多处填充 | ✅ Pad | |
| `torch.nn.functional.fold` | ISTFT/IMDCT OLA | ⚠️ 需验证 | ONNX Fold 算子支持有限 |
| `torch.nn.functional.leaky_relu` | Vocos ResBlock1 | ✅ LeakyRelu | |
| `torch.nn.functional.layer_norm` | AdaLayerNorm | ✅ LayerNormalization | |
| `torch.nn.functional.interpolate` | 无直接使用 | — | |
| `torch.cos` / `torch.sin` | ISTFTHead 相位重建 | ✅ Cos / Sin | |
| `torch.atan2` | STFT 相位计算 | ✅ Atan2 (opset 16+) | |
| `torch.sign` | symlog/symexp | ✅ Sign | |
| `torch.log1p` | symlog | ✅ Log1p (通过 Log) | |
| `torch.exp` | symexp, ISTFTHead | ✅ Exp | |
| `torch.abs` | 多处 | ✅ Abs | |
| `torch.conj` | IMDCT | ⚠️ 需手动处理 | |
| `torch.flip` | IMDCT | ✅ Flip (opset 13+) | |
| `torch.squeeze` / `unsqueeze` | 多处 | ✅ Squeeze / Unsqueeze | |
| `torch.transpose` | 多处 | ✅ Transpose | |
| `torch.arange` | 位置编码, 掩码 | ✅ Range | |
| `torch.where` | CFG 条件丢弃 | ✅ Where | |
| `torch.masked_fill` | 注意力掩码 | ✅ Where + Mask | |
| `torch.triu` | 因果掩码（本项目非因果） | ✅ | |
| `scipy.signal.cosine` | MDCT 窗口 | ⚠️ 需预计算 | 非张量操作, 需作为常量 |

#### HuggingFace Transformers 特殊算子

| 算子 | 使用位置 | ONNX 支持 | 备注 |
|------|----------|-----------|------|
| `LlamaDecoderLayer` | DiffLlama | ⚠️ 部分支持 | HuggingFace 有 ONNX 导出工具, 但自适应 RMSNorm 需自定义 |
| `LlamaRotaryEmbedding` | 旋转位置编码 | ✅ | 标准 RoPE, ONNX 兼容 |
| `WhisperModel.encoder` | SVC 内容编码 | ✅ | HuggingFace 官方支持 ONNX 导出 |

### c.2 不支持或需要特殊处理的算子

#### 🔴 高风险（ONNX 标准不支持或支持有限）

| 算子 | 问题 | 建议处理方案 |
|------|------|-------------|
| `torch.stft` | ONNX 无原生 STFT 算子 | 方案1: 将 MelSpectrogram 从模型中分离, 作为预处理步骤用 NumPy/SciPy 实现; 方案2: 用 Conv1D 重写 STFT (将窗口作为卷积核) |
| `torch.istft` | ONNX 无原生 ISTFT 算子 | 方案1: 将 Vocoder 声码器分离为独立 ONNX, 用自定义 ISTFT 实现; 方案2: 用 ConvTranspose1d 重写 ISTFT |
| `torch.fft.fft` / `ifft` / `irfft` | ONNX DFT 算子 (opset 17) 支持有限, 且 DirectML 不支持 | 分离为后处理, 或用矩阵乘法重写 DFT |
| `torch.nn.functional.fold` | ONNX Fold 支持有限 | 手动实现 overlap-add |
| `torch.conj` | ONNX 无直接 Conjugate 算子 | 手动拆分实虚部处理 |
| `torch.randn` | ONNX 推理中需确定性输入 | 在推理脚本中预生成噪声, 作为输入传入 |

#### 🟡 中等风险（需要适配但可解决）

| 算子 | 问题 | 建议处理方案 |
|------|------|-------------|
| `LlamaAdaptiveRMSNorm` | 自定义层, 非标准 Llama | 导出为自定义 SubGraph: `pow → mean → rsqrt → mul → linear → mul` |
| `WhisperModel` (SVC) | 外部预训练模型 | 单独导出 Whisper encoder 为 ONNX, 或作为预处理步骤 |
| `torch.gather` (expand_states) | 索引越界风险 | 确保索引在范围内, 或用 `torch.index_select` 替代 |
| `view_as_real` / `view_as_complex` | ONNX 无复数类型 | 拆分为实部/虚部两个张量分别处理 |

#### 🟢 低风险（ONNX 标准支持）

所有标准 nn 层（Linear, Conv1d, Embedding, LayerNorm, GELU, SiLU 等）和常见函数式操作（cat, clamp, round, log2, matmul 等）在 ONNX opset 17+ 均有良好支持。

### c.3 DirectML 后端兼容性评估

| 算子类别 | ONNX 标准支持 | DirectML 支持 | 备注 |
|----------|--------------|---------------|------|
| Embedding (Gather) | ✅ | ✅ | |
| MatMul + Add (Linear) | ✅ | ✅ | |
| Conv1D | ✅ | ✅ | |
| LayerNormalization | ✅ | ✅ | |
| GELU | ✅ | ✅ | |
| SiLU | ✅ | ✅ | |
| ConvTranspose1D | ✅ | ✅ | |
| Rsqrt | ✅ | ✅ | |
| Pow / Sqrt | ✅ | ✅ | |
| Cos / Sin | ✅ | ✅ | |
| Where / Clip | ✅ | ✅ | |
| Softmax (Attention) | ✅ | ✅ | |
| **DFT / FFT** | ⚠️ opset 17 | ❌ | DirectML 不支持 DFT 算子 |
| **Fold** | ⚠️ | ❌ | DirectML 不支持 Fold |
| **STFT / ISTFT** | ❌ | ❌ | 无原生支持 |
| **Conjugate** | ❌ | ❌ | 无原生支持 |

### c.4 CUDA / TensorRT 后端兼容性评估

| 算子类别 | CUDA (PyTorch) | TensorRT | 备注 |
|----------|----------------|----------|------|
| 所有标准层 | ✅ | ✅ | |
| DFT / FFT | ✅ | ⚠️ 有限 | TensorRT 8.6+ 有 IFFT 插件, 但 STFT 需自定义 |
| Fold | ✅ | ⚠️ | 需自定义插件 |
| STFT / ISTFT | ✅ | ⚠️ | 需自定义插件或拆分 |
| 自适应 RMSNorm | ✅ | ✅ | 可分解为标准算子组合 |

### c.5 后端推荐结论

**推荐使用 CUDA 后端进行 ONNX 推理。**

理由：
1. DirectML 不支持 DFT/Fold/STFT/ISTFT 等频域算子，而本项目声码器（Vocos）和梅尔频谱提取器大量依赖这些算子
2. CUDA + TensorRT 对标准算子全部支持，频域算子可通过自定义插件解决
3. 若需在 DirectML 上运行，必须将 MelSpectrogram 和 Vocoder 从 ONNX 图中分离，作为前后处理用 CPU 实现

**推荐导出策略：拆分为 3 个 ONNX 子模型**

| 子模型 | 功能 | 输入 | 输出 | DirectML 可行性 |
|--------|------|------|------|-----------------|
| **ONNX-A: Encoder** | 音符/F0/Whisper 编码 + ConvNeXtV2 + 帧对齐 | 音素ID, 音高, 类型, F0, (Whisper特征) | 条件特征 [1, F, H] | ✅ 全标准算子 |
| **ONNX-B: CFM Decoder** | DiffLlama 扩散解码 (单步) | 噪声 mel, 时间步, 条件特征, 掩码 | 速度场预测 [1, F, 128] | ✅ 全标准算子 |
| **ONNX-C: Vocoder** | Vocos 声码器 | 梅尔频谱 [1, 128, F] | 波形 [1, T] | ❌ 含 STFT/ISTFT, 需 CPU 后处理 |

其中 ONNX-A 和 ONNX-B 可在 DirectML 上运行；ONNX-C 建议用 CUDA 或 CPU 实现。

### c.6 导出注意事项

1. **动态轴设置**：
   - 所有子模型均需设置动态轴：`{0: 'batch', 1: 'sequence'}`
   - CFM Decoder 的 `n_timesteps` 循环无法直接导出为 ONNX 循环，建议导出单步模型，在推理脚本中手动循环

2. **常量折叠建议**：
   - MelSpectrogram 的 `mel_basis` 和 `hann_window` 已为 register_buffer，可折叠
   - MDCT/IMDCT 的 `pre_twiddle`, `post_twiddle`, `window` 可折叠
   - Whisper 编码器权重可折叠

3. **输入/输出节点命名建议**：
   - Encoder: `phoneme_in`, `note_pitch_in`, `note_type_in`, `f0_coarse_in`, `mel2note_in` → `cond_feat_out`
   - CFM 单步: `xt_in`, `t_in`, `cond_in`, `mask_in` → `flow_pred_out`
   - Vocoder: `mel_in` → `audio_out`

4. **FP16 注意**：
   - MelSpectrogram 必须保持 FP32（`model.mel.float()`）
   - ISTFTHead 中复数运算强制 FP32（`mag, x, y = mag.float(), x.float(), y.float()`）
   - 建议导出为 FP32 ONNX，推理时用 FP16 执行（TensorRT 支持 mixed precision）

5. **CFG 实现**：
   - 推理时需两次调用 CFM Decoder（有条件 + 无条件），可在推理脚本中实现，无需导出为 ONNX 图内逻辑

---

## d. 推理全流程描述

### d.1 SVS（歌声合成）全流程

#### 阶段 1：预处理（离线，生成元数据）

1. **输入**：用户原始音频文件（mp3/wav）
2. **人声分离**（可选）：Mel-Band-Roformer 分离人声与伴奏
3. **F0 提取**：RMVPE 从人声中提取帧级 F0 曲线（16kHz 输入 → 50Hz 帧率输出 → 重采样到目标帧率）
4. **人声检测**：基于 F0 曲线检测有声段，切分为 1~20 秒的片段
5. **歌词转录**：FunASR (中文/粤语) 或 NeMo Parakeet (英文) 识别歌词词级时间戳
6. **音符转录**：RosVot 从 F0 + 歌词生成音符序列（起止时间、MIDI 音高、音符类型）
7. **G2P 转换**：g2pM (普通话) / ToJyutping (粤语) / g2p_en (英语) 将歌词转为音素序列
8. **元数据输出**：JSON 格式，包含 phoneme, duration, note_pitch, note_type, f0, time 等字段

#### 阶段 2：数据预处理（在线，推理时）

1. **加载元数据**：读取 prompt 和 target 的 JSON 元数据
2. **音符合并**：合并连续相同的休止音符
3. **音素扩展**：为每个音符插入 `<BOW>` (词首) 和 `<EOW>` (词尾) 标记；英语音素按 `-` 分割并插入 `<SEP>`
4. **帧对齐**：计算 `mel2note` 映射表，将每个梅尔帧映射到对应的音素索引
5. **音素 ID 转换**：通过 `phone_set.json` 查表将音素字符串转为整数 ID
6. **F0 截断对齐**：将 F0 曲线截断到与 mel2note 相同的帧数
7. **参考音频加载**：加载参考 wav 文件，重采样到 24kHz，转为单声道

#### 阶段 3：模型推理

1. **参考梅尔频谱提取**：`MelSpectrogramEncoder` 将参考波形转为归一化对数梅尔频谱
2. **F0 量化**：`f0_to_coarse()` 将连续 F0 值离散化为 361 bin（C1~B6, 20 cents/bin, 0=清音）
3. **自动音高偏移计算**（可选）：计算参考与目标的中位 F0 差值，转换为半音偏移
4. **音符嵌入**：`note_pitch_encoder + note_type_encoder + note_text_encoder` 三路嵌入相加
5. **ConvNeXtV2 预处理**：4 层 ConvNeXtV2Block 处理音符特征
6. **帧对齐扩展**：`expand_states` 将音符级特征扩展到帧级
7. **F0 特征融合**：`features = expanded + f0_encoder(f0_coarse)`
8. **条件分割**：按参考/目标帧数分割为 `pt_decoder_inp` 和 `gt_decoder_inp`
9. **CFM 反向扩散**：
   - 拼接参考和目标条件 → `cond_emb = Linear(cat([pt_cond, gt_cond]))`
   - 从高斯噪声出发，经 `n_steps` 步 Euler 积分
   - 每步：预测速度场 → CFG 增强 → 更新状态
10. **声码器重建**：`Vocos` 将生成的梅尔频谱转为波形

#### 阶段 4：后处理

1. **波形拼接**：多个目标段（如果元数据含多段）的生成波形按时间戳拼接到完整音频
2. **保存**：以 24kHz PCM float32 写入 WAV 文件

### d.2 SVC（歌声转换）全流程

#### 阶段 1：预处理

1. **输入**：参考音频 + 目标音频
2. **人声分离**（可选）：分离人声与伴奏
3. **F0 提取**：RMVPE 分别提取参考和目标的 F0 曲线，保存为 `*_f0.npy`

#### 阶段 2：模型推理

1. **参考梅尔频谱提取**：`MelSpectrogramEncoder` 处理参考波形
2. **Whisper 内容编码**：分别对参考和目标音频提取 Whisper-base 编码器特征
3. **F0 量化**：参考和目标 F0 分别量化为 361 bin
4. **条件融合**：`content_feat + f0_encoder(f0_coarse)`
5. **长音频分段**（目标 > 30s）：按 F0 曲线自动分段，每段独立推理后拼接
6. **CFM 反向扩散**：同 SVS 流程
7. **声码器重建**：同 SVS 流程

#### 阶段 3：后处理

1. **长度对齐**：生成波形截断或填充到与目标音频相同长度
2. **伴奏混合**（可选）：将生成的歌声与原始伴奏混合，伴奏按音高偏移量升降调

### d.3 分支逻辑

| 条件 | 分支行为 |
|------|----------|
| `control == "melody"` | 使用 F0 曲线作为音高条件，note_pitch 置零 |
| `control == "score"` | 使用 MIDI note_pitch 作为音高条件，F0 置零 |
| `auto_shift == True` | 自动计算参考与目标的中位 F0 差值作为 pitch_shift |
| `pitch_shift != 0` | 手动 pitch_shift 覆盖 auto_shift；F0 bin 偏移 = pitch_shift × 5 |
| `use_fp16 == True` + CUDA | 模型半精度推理，但 MelSpectrogram 保持 FP32 |
| SVC 目标 > 30s | 自动分段推理，段间重叠拼接 |
| SVC 目标 ≤ 30s | 整段推理 |

---

## e. 迁移注意事项及手写 ONNX 推理脚本的必要信息

### e.1 推荐导出方案

**方案：拆分为 Encoder + CFM-Step + Vocoder 三个 ONNX 子模型**

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  ONNX-A      │     │  ONNX-B      │     │  ONNX-C      │
│  Encoder     │────▶│  CFM-Step    │────▶│  Vocoder     │
│              │     │  (单步)       │     │  (Vocos)     │
└──────────────┘     └──────────────┘     └──────────────┘
       ↑                    ↑                     ↑
   离线预处理          推理脚本循环            CPU/NumPy
   生成输入           n_steps 次            实现声码器
```

### e.2 ONNX-A: Encoder 导出规格

**SoulXSinger (SVS) Encoder**

```python
# 伪代码：导出 Encoder
inputs = {
    'phoneme':    torch.randint(0, 3000, (1, N), dtype=torch.long),   # [1, N]
    'note_pitch': torch.randint(0, 256, (1, N), dtype=torch.long),    # [1, N]
    'note_type':  torch.randint(0, 256, (1, N), dtype=torch.long),    # [1, N]
    'f0_coarse':  torch.randint(0, 361, (1, F), dtype=torch.long),    # [1, F]
    'mel2note':   torch.randint(0, N, (1, F), dtype=torch.long),      # [1, F]
}
# 输出: cond_feat [1, F, 1024]

dynamic_axes = {
    'phoneme':    {1: 'N_notes'},
    'note_pitch': {1: 'N_notes'},
    'note_type':  {1: 'N_notes'},
    'f0_coarse':  {1: 'F_frames'},
    'mel2note':   {1: 'F_frames'},
    'cond_feat':  {1: 'F_frames'},
}
```

**SoulXSingerSVC (SVC) Encoder**

```python
# SVC Encoder 包含 WhisperEncoder, 需单独处理
# 方案1: Whisper 作为预处理步骤 (推荐)
# 方案2: 将 Whisper encoder 单独导出为 ONNX

# SVC Encoder 输入 (不含 Whisper):
inputs = {
    'content_feat': torch.randn(1, F, 512),     # Whisper 编码器输出
    'f0_coarse':    torch.randint(0, 361, (1, F), dtype=torch.long),
}
# 输出: cond_feat [1, F, 512] (注意: SVC 的 hidden_size 也是 1024, 但 Whisper 输出 512)
```

### e.3 ONNX-B: CFM-Step 导出规格

```python
# 导出 DiffLlama 的单步前向
inputs = {
    'xt':      torch.randn(1, F_total, 128),     # 当前步噪声 mel
    't':       torch.randn(1),                     # 时间步 [0, 1]
    'cond':    torch.randn(1, F_total, 1024),     # 条件嵌入
    'x_mask':  torch.ones(1, F_total),            # 掩码
}
# 输出: flow_pred [1, F_total, 128]

dynamic_axes = {
    'xt':       {1: 'F_total'},
    'cond':     {1: 'F_total'},
    'x_mask':   {1: 'F_total'},
    'flow_pred':{1: 'F_total'},
}
```

**推理脚本中的扩散循环（伪代码）**：

```
h = 1.0 / n_steps
prompt_len = pt_mel.shape[1]
target_len = F_target
z = random_normal(shape=[1, target_len, 128])  # 初始噪声
xt = z

for i in range(n_steps):
    xt_input = concat([pt_mel, xt], dim=1)       # [1, F_total, 128]
    t = (0 + (i + 0.5) * h) * ones([1])

    # 有条件预测
    flow_pred = onnx_b.run(xt_input, t, cond_emb, mask)

    # 无条件预测 (CFG)
    uncond_pred = onnx_b.run(xt, t, zeros_like(cond)[:, :target_len, :], x_mask)

    # CFG 增强
    flow_pred_cfg = flow_pred + cfg * (flow_pred - uncond_pred)
    rescale = pos_std / cfg_std
    flow_pred = rescale_cfg * (flow_pred_cfg * rescale) + (1 - rescale_cfg) * flow_pred_cfg

    xt = xt + flow_pred[:, prompt_len:, :] * h

generated_mel = xt  # [1, target_len, 128]
```

### e.4 ONNX-C: Vocoder 导出规格

**问题**：Vocos 声码器内部使用 `torch.stft` (在 MelSpectrogram 中) 和自定义 ISTFT (含 `torch.fft.irfft`, `torch.nn.functional.fold`)，这些算子在 ONNX/DirectML 中不支持。

**推荐方案：将 Vocoder 作为 CPU 后处理**

用 NumPy/SciPy 实现等效的 Vocos 推理：

1. **VocosBackbone**：可导出为 ONNX（纯 ConvNeXt + Linear），输出 `[1, F, 1024]`
2. **ISTFTHead**：用 NumPy 实现
   - `Linear(1024 → 1922)` 可导出为 ONNX
   - `chunk → exp(mag), cos/sin(phase) → 复数 ISTFT` 用 SciPy `scipy.signal.istft` 或手动 overlap-add 实现

**替代方案**：使用预训练的 HiFi-GAN 声码器替代 Vocos，HiFi-GAN 全部为标准卷积算子，ONNX 兼容性好。

### e.5 F0 量化函数的 ONNX 兼容实现

`f0_to_coarse` 函数需在推理脚本中实现（非模型内部）：

```python
def f0_to_coarse(f0, f0_bin=361, f0_min=32.7031956625, f0_shift=0):
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
```

### e.6 MelSpectrogram 的 CPU 实现要点

```python
# 等效于 MelSpectrogramEncoder 的 NumPy 实现
def extract_mel(wav, sr=24000, n_fft=1920, hop=480, win=1920, n_mels=128, fmin=0, fmax=12000, mel_mean=-4.92, mel_var=8.14):
    # 1. 反射填充
    pad = (n_fft - hop) // 2
    wav = np.pad(wav, (pad, pad), mode='reflect')
    # 2. STFT
    spec = librosa.stft(wav, n_fft=n_fft, hop_length=hop, win_length=win, center=False)
    # 3. 幅度谱
    mag = np.abs(spec)
    # 4. Mel 滤波
    mel = librosa.feature.melspectrogram(S=mag**2, sr=sr, n_mels=n_mels, fmin=fmin, fmax=fmax, n_fft=n_fft)
    # 5. 对数压缩
    log_mel = np.log(np.clip(mel, a_min=1e-5, a_max=None))
    # 6. 方差归一化
    log_mel = (log_mel - mel_mean) / np.sqrt(mel_var)
    # 7. 转置为 [F, 128]
    return log_mel.T
```

### e.7 关键常量与参数汇总

| 参数 | 值 | 来源 |
|------|----|------|
| 音素词表大小 (vocab_size) | 3000 | config: model.encoder.vocab_size |
| text_dim / pitch_dim / type_dim / f0_dim | 512 | config: model.encoder.* |
| ConvNeXtV2 层数 | 4 | config: model.encoder.num_layers |
| ConvNeXtV2 intermediate_dim | 1024 (= text_dim * 2) | 代码: ConvNeXtV2Block(text_dim, text_dim * 2) |
| DiffLlama hidden_size | 1024 | config: model.flow_matching.hidden_size |
| DiffLlama num_layers | 22 | config: model.flow_matching.num_layers |
| DiffLlama num_heads | 16 | config: model.flow_matching.num_heads |
| mel_dim | 128 | config: model.flow_matching.mel_dim / audio.num_mels |
| F0 bin 数 | 361 | config: model.encoder.f0_bin |
| F0 最低频率 | 32.7031956625 Hz (C1) | 代码常量 |
| F0 量化精度 | 20 cents/bin | 代码: f0_cents / 20 |
| cond_emb 类型 | Linear (非 Embedding) | config: model.flow_matching.use_embedding=False |
| cond_codebook_size | 512 | config: model.flow_matching.cond_codebook_size |
| sigma (CFM) | 1e-5 | config: model.flow_matching.sigma |
| time_scheduler | cos | config: model.flow_matching.time_scheduler |
| cfg_drop_prob | 0.2 | config: model.flow_matching.cfg_drop_prob |
| Vocos input_channels | 128 | 默认配置 |
| Vocos dim | 1024 | 默认配置 |
| Vocos intermediate_dim | 4096 | 默认配置 |
| Vocos num_layers | 30 | 默认配置 |
| Vocos n_fft | 1920 | 默认配置 |
| Whisper 模型 | openai/whisper-base | 代码硬编码 |
| Whisper 输出维度 | 512 | whisper-base hidden_size |
| 默认扩散步数 | 32 | config: infer.n_steps |
| 默认 CFG 强度 | 3.0 | config: infer.cfg |
| CFG rescale 系数 | 0.75 | 代码硬编码 |
| 音符类型编码 | 1=休止, 2=正常, 3=延续 | 元数据约定 |
| 音素特殊标记 | PAD=0, SP=1, AP=2, BOW=4, EOW=5, SEP=9 | phone_set.json |

### e.8 推理脚本伪代码（完整流程）

```
# ============ SVS ONNX 推理伪代码 ============

# 1. 离线预处理（与原始流程相同，生成 metadata.json）
#    - 人声分离、F0 提取、歌词/音符转录、G2P

# 2. 在线数据预处理
meta = load_json(target_metadata_path)
prompt_meta = load_json(prompt_metadata_path)
processor = DataProcessor(hop_size=480, sample_rate=24000, phoneset_path=...)
prompt_data = processor.process(prompt_meta, prompt_wav_path)
target_data = processor.process(target_meta, None)

# 3. 提取参考梅尔频谱（CPU/NumPy）
pt_mel = extract_mel(prompt_wav)  # [1, F_pt, 128]

# 4. F0 量化
f0_coarse_pt = f0_to_coarse(prompt_data['f0'])
f0_coarse_gt = f0_to_coarse(target_data['f0'], f0_shift=pitch_shift * 5)
f0_coarse = np.concatenate([f0_coarse_pt, f0_coarse_gt], axis=1)

# 5. 音高偏移
note_pitch = concatenate([prompt_data['note_pitch'], target_data['note_pitch']])
note_pitch[note_pitch > 0] += pitch_shift
note_pitch = clip(note_pitch, 0, 255)

# 6. Encoder 推理
cond_feat = onnx_a.run(
    phoneme=concat([prompt_data['phoneme'], target_data['phoneme']], dim=1),
    note_pitch=note_pitch,
    note_type=concat([prompt_data['note_type'], target_data['note_type']], dim=1),
    f0_coarse=f0_coarse,
    mel2note=concat([prompt_data['mel2note'], target_data['mel2note'] + len_prompt], dim=1),
)

# 7. 分割条件
pt_decoder_inp = cond_feat[:, :F_pt, :]
gt_decoder_inp = cond_feat[:, F_pt:, :]

# 8. CFM 条件嵌入
cond_emb = linear_layer(cond_feat)  # 或作为 Encoder 的一部分

# 9. CFM 反向扩散循环
z = random_normal([1, F_target, 128])
xt = z
for i in range(n_steps):
    xt_input = concat([pt_mel, xt], dim=1)
    t = (0 + (i + 0.5) / n_steps) * ones([1])

    flow_pred = onnx_b.run(xt=xt_input, t=t, cond=cond_emb, x_mask=mask)
    # ... CFG 增强 ...
    xt = xt + flow_pred[:, F_pt:, :] * (1.0 / n_steps)

generated_mel = xt  # [1, F_target, 128]

# 10. 声码器重建（CPU/NumPy 或独立 ONNX）
audio = vocoder_reconstruct(generated_mel)  # [1, T_out]

# 11. 保存
soundfile.write('output.wav', audio, 24000)
```

### e.9 已知限制与风险

1. **Whisper 编码器**：SVC 模型依赖 `openai/whisper-base`，该模型较大（~74M 参数），且使用 HuggingFace Transformers 的自定义注意力实现。建议将其作为独立预处理步骤，不纳入主 ONNX 图。

2. **MelSpectrogram 必须保持 FP32**：项目代码中明确 `model.mel.float()`，即使在 FP16 推理模式下也不可降精度。

3. **ISTFTHead 复数运算**：代码中强制将 mag, cos, sin 转为 float32 后计算复数 ISTFT，ONNX 导出时需注意精度。

4. **`expand_states` 的 `torch.gather`**：需确保 `mel2note` 索引不越界，否则导出时会触发 assert。

5. **CFM 循环无法直接导出**：`reverse_diffusion` 中的 for 循环 + CFG 双次前向传播，必须拆分为单步模型在推理脚本中循环调用。

6. **Vocos 声码器的 `fold` 操作**：ISTFT 的 overlap-add 使用 `torch.nn.functional.fold`，ONNX 支持有限，建议用 NumPy 手动实现。

7. **MDCT/IMDCT 模块**：虽然当前默认配置使用 ISTFTHead（非 MDCT），但代码中包含 IMDCTSymExpHead 和 IMDCTCosHead 选项，这些使用 `torch.fft.fft/ifft` 和 `view_as_complex`，ONNX 兼容性更差。

8. **`scipy.signal.cosine`**：MDCT 窗口函数依赖 SciPy，需在导出前预计算为常量张量。

9. **音素词表**：`phone_set.json` 包含 2822 个条目（含 10 个 SPECIAL_TOKEN），但 `vocab_size=3000`，存在未使用的嵌入位。推理时需确保音素 ID 不超过词表范围。

10. **SVC 长音频分段**：`build_vocal_segments` 逻辑依赖 F0 曲线的清浊音判断，需在推理脚本中用 NumPy 重新实现。
