# 引入 BigVGAN v2 44100Hz Vocoder Spec

## Why
当前 SVS 管线 vocoder（默认 HiFi-GAN 变体 / SiFiGAN）输出采样率上限为 24kHz，高频带宽受限（fmax=12000）。BigVGAN v2（NVIDIA，ICASSP/NeurIPS 系列）是当前 SOTA 通用神经声码器，其 44kHz 版本支持 44.1kHz 输出与 fmax=22050 的高频重建，能显著扩展高频带宽并降低可感知伪影。引入 BigVGAN v2 44kHz 作为可选高保真 vocoder，可为用户提供"高采样率/高保真"的输出选项。

## 关键技术挑战（mel 格式不兼容）
当前 SVS 管线产出 mel 与 BigVGAN v2 44kHz 期望 mel **格式不匹配**：

| 维度 | SVS 管线 (diff_step 输出) | BigVGAN v2 44kHz 512x |
|------|--------------------------|------------------------|
| 采样率 | 24000 Hz | 44100 Hz |
| hop_size | 480 | 512 |
| mel 帧率 | 50 Hz | ~86.13 Hz |
| mel bins | 128 | 128（一致 ✓） |
| fmax | 12000 | 22050 |
| n_fft | 1920 | 2048 |

**结论**：SVS diff_step 产出的 24kHz 格式 mel **不能**直接喂给 BigVGAN 44kHz。有两条解决路径（见下文"集成路径选项"），均无需从头重训。

## 集成路径选项

### Path A：两阶段 Vocoder（无需训练，立即可用，质量有限）
SVS diff_step → mel(24kHz) → 默认 vocoder → 24kHz 波形 → 重采样 44.1kHz → 重提取 mel(BigVGAN STFT) → BigVGAN → 44.1kHz 波形。
- **优点**：零训练成本，可立即上线；用户下载 BigVGAN ONNX 即可用
- **缺点**：Stage 1 默认 vocoder 的 24kHz 伪影会被 BigVGAN "忠实重建"，无法消除；高频扩展收益有限
- **适用**：快速验证 BigVGAN 集成可行性、对比音质、用户体验两阶段流程

### Path B：微调 SVS 扩散模型（推荐，完整质量收益）
**不需从头重训，仅微调。** SVS 扩散模型架构与 mel 格式无关（仅操作 `[B, seq, 128]` 张量），可通过微调让 diff_step 直接输出 44kHz 格式 mel。

**微调范围**：
| 模型 | 处理方式 | 原因 |
|------|---------|------|
| `note_text_encoder` / `note_pitch_encoder` / `note_type_encoder` / `f0_encoder` | **冻结，不重训** | 符号输入（音素/MIDI/F0）编码，与 mel 格式无关 |
| `diff_step` | **微调（核心）** | 预测 mel 分布，需学习 44kHz mel 的新帧率(86Hz)与高频带(fmax=22050)分布 |
| `preflow` / `cond_emb` | **微调（推荐）** | 条件投影，与 diff_step 联动；可一并微调或仅微调 diff_step |
| `mel_transform` | **替换**（不训练） | 换为 44kHz STFT 配置的 mel 提取器 |
| `vocoder` | **替换**（不训练） | 换为 BigVGAN 44kHz ONNX |
| 日语模型 `note_text_encoder_jp` / `preflow_jp` / `cond_emb_jp` | **冻结 text encoder，微调 preflow_jp / cond_emb_jp** | 与基础管线联动 |

**微调流程**：
1. 从当前 `diff_step` checkpoint 恢复
2. 用 44kHz mel 格式（n_fft=2048, hop=512, fmax=22050, 128 bins）重新提取训练集 mel 目标
3. 微调 `diff_step`（+ `preflow` / `cond_emb`），编码器冻结，LR ~1e-5，~100k-500k steps
4. 导出新 ONNX：`diff_step_44k_dml.onnx` / `preflow_44k.onnx` / `cond_emb_44k.onnx`
5. 推理时**单阶段**：SVS diff_step(44k) → mel(44kHz 格式) → BigVGAN → 44.1kHz 波形，无需两阶段、无需 mel 重提取

**优点**：完整质量收益（BigVGAN 高频重建能力 + 无 24kHz 阶段伪影）
**缺点**：需训练资源（单 GPU 数天）+ 训练数据访问
**适用**：追求最佳音质的最终方案

### 路径选择策略
- **Phase 1（先 Path A）**：完成 BigVGAN ONNX 导出 + 两阶段集成，立即验证音质提升幅度
- **Phase 2（后 Path B）**：若 Path A 验证有正向收益，启动微调训练，迁移到单阶段高质量路径
- 两条路径的应用层代码并存：`vocoderType=bigvgan44k` 走 Path A（两阶段），`vocoderType=bigvgan44k_ft` 走 Path B（单阶段微调版）

## Required Downloads / Clones（用户问题的直接回答）

### 1. 克隆官方 PyTorch 仓库（用于 ONNX 导出脚本依赖）
```powershell
git clone https://github.com/NVIDIA/BigVGAN.git third_party/BigVGAN
```
- 仓库地址：https://github.com/NVIDIA/BigVGAN
- 用途：导出脚本需引用其中的 `bigvgan.py`、`meldataset.py`、`inference.py`、`env.py`、`activations.py`、`alias_free_activation/`、`configs/bigvgan_v2_44khz_128band_512x.json`
- 分支/Tag：`main`（v2.4，2024-09 最新，5M steps 最终版权重）
- **不入 git**（加入 `.gitignore` 的 `third_party/` 规则，仅开发机本地使用）

### 2. 下载 HuggingFace 预训练 checkpoint（推荐 512x 版本）
仓库地址：https://huggingface.co/nvidia/bigvgan_v2_44khz_128band_512x

需下载文件：
| 文件 | 大小 | 用途 |
|------|------|------|
| `config.json` | ~2 KB | STFT 超参（n_fft/hop_size/fmax/num_mels 等），ONNX 导出与 mel 重提取必需 |
| `bigvgan_generator.pt` | ~487 MB（122M 参数 FP32） | 生成器权重，ONNX 导出输入 |
| `bigvgan_discriminator_optimizer.pt` | ~1.5 GB | 仅 fine-tune 需要，**ONNX 导出不需要**，可不下 |

- 国内镜像加速：使用 `hf-mirror.com` 镜像（`HF_ENDPOINT=https://hf-mirror.com` 环境变量），或通过 ModelScope 社区镜像（若已搬运）
- 推荐放置路径：`D:\download\bigvgan_v2_44khz_128band_512x\`（与现有 `D:\download\model+stats\` 约定一致，开发机本地，不入 git）

### 3. 备选：256x 版本（可选）
仓库地址：https://huggingface.co/nvidia/bigvgan_v2_44khz_128band_256x
- 与 512x 的差异：hop_size=256（帧率 ~172Hz）、112M 参数
- **不推荐**作为首选：帧率 172Hz 与 SVS 50Hz 帧率差距更大，mel 重采样更激进；且 512x 是 NVIDIA 44kHz 旗舰配置

### 4. Python 环境依赖（导出脚本运行时需要）
```powershell
conda create -n bigvgan python=3.10 pytorch torchvision torchaudio pytorch-cuda=12.1 -c pytorch -c nvidia
conda activate bigvgan
cd third_party/BigVGAN
pip install -r requirements.txt
# 额外需要（ONNX 导出）：
pip install onnx onnxsim onnxruntime
```

## What Changes

### 共通部分（两条路径都需要）
- **新增 BigVGAN v2 ONNX 导出脚本** `export_bigvgan_vocoder.py`：基于 `third_party/BigVGAN/`，加载本地 `bigvgan_generator.pt` + `config.json`，包装为接受 `mel`（[1, seq, 128]）输入、输出 `waveform`（[1, num_samples]，44100Hz）的 ONNX 模型
- **新增 DirectML 兼容性优化脚本** `optimize_bigvgan_dml.py`：复用现有 `optimize_vocoder_dml.py` / `optimize_sifigan_dml.py` 的 ConvTranspose 分解思路，处理 BigVGAN 中大 stride ConvTranspose（44kHz 512x 上采样链含 stride=8/8/4/4 等大 stride 算子）
- **新增 BigVGAN mel 提取器**：JS 实现 BigVGAN 44kHz STFT/mel filterbank（复用 `postprocessing.js` 的 `extractMelSpectrogram` 框架，参数化 n_fft/hop/fmax）
- **扩展模型清单与注册表**：`MODEL_GROUPS` 新增 `bigvgan-vocoder` 组（optional），文件 `bigvgan_vocoder_dml.onnx`
- **SAMPLE_RATE 输出解耦**：合成主流程的输出采样率从固定的 24000 改为按 vocoderType 决定（default/sifigan → 24000，bigvgan44k / bigvgan44k_ft → 44100），影响 WAV 写入、播放、文件导出
- **README 与文档更新**：`onnx_models/README.md` 新增 BigVGAN v2 章节说明

### Path A 专属（两阶段，立即上线）
- **两阶段 vocoding 集成**：
  1. SVS diff_step → mel (24kHz/50Hz/128bin/fmax=12k)
  2. 默认 vocoder → 24kHz 波形
  3. 波形重采样 24kHz → 44100Hz
  4. 用 BigVGAN 44kHz STFT 配置（n_fft=2048, hop=512, fmax=22050）重新提取 mel → [1, seq', 128]
  5. BigVGAN 44kHz → 44100Hz 波形
- **设置页 vocoder 选择**：`vocoderType` 枚举新增 `bigvgan44k`，选项标签 `BigVGAN v2 44kHz（两阶段）`

### Path B 专属（微调，完整质量）
- **新增微调训练脚本** `finetune_diff_step_44k.py`：从当前 diff_step checkpoint 恢复，用 44kHz mel 目标微调 diff_step（+可选 preflow/cond_emb），编码器冻结
- **新增训练集 mel 重提取脚本** `reextract_mel_44k.py`：用 44kHz STFT 配置从训练音频重新提取 mel 目标
- **新增微调后 ONNX 导出**：`diff_step_44k_dml.onnx` / `preflow_44k.onnx` / `cond_emb_44k.onnx`
- **应用层 Path B 加载分支**：`vocoderType=bigvgan44k_ft` 时加载微调版 diff_step/preflow/cond_emb + BigVGAN，单阶段推理
- **设置页 vocoder 选择**：`vocoderType` 枚举新增 `bigvgan44k_ft`，选项标签 `BigVGAN v2 44kHz（微调版，单阶段）`

## Impact
- Affected specs: `add-sifigan-vocoder`（vocoderType 枚举扩展需保持向后兼容）、`migrate-onnxruntime-directml`、`complete-first-release`
- Affected code:
  - `export_bigvgan_vocoder.py` (新增) - BigVGAN PyTorch → ONNX 导出
  - `optimize_bigvgan_dml.py` (新增) - DML 兼容性优化
  - `reextract_mel_44k.py` (新增, Path B) - 训练集 44kHz mel 重提取
  - `finetune_diff_step_44k.py` (新增, Path B) - diff_step 微调训练脚本
  - `src/inference/pipeline/index.js` - vocoder 加载分支扩展支持 `bigvgan44k` / `bigvgan44k_ft`；两阶段 vocoding 调度；Path B 单阶段调度
  - `src/inference/pipeline/postprocessing.js` - BigVGAN 44kHz mel 提取；两阶段串联；输出采样率派生
  - `src/inference/pipeline/constants.js` - `BIGVGAN_MODEL_FILES`、`BIGVGAN_44K_SAMPLE_RATE=44100`、`BIGVGAN_44K_HOP_SIZE=512`、`BIGVGAN_44K_N_FFT=2048`、`BIGVGAN_44K_FMAX=22050`、`MODEL_SIZES.bigvgan`、`DIFF_STEP_44K_FILES`（Path B）
  - `src/inference/shared/constants.js` - 输出采样率派生逻辑（不再硬编码 24000 为唯一输出率）
  - `src/modelRegistry.js` - 新增 `bigvgan-vocoder` 模型组（+ 可选 `bigvgan-44k-ft` 模型组含微调版 diff_step/preflow/cond_emb）
  - `src/modelManager.js` - `MODEL_IDS.bigvgan` 占位 + `MODEL_FILE_MANIFEST` 新增 `bigvgan_vocoder_dml.onnx`（+ Path B 的 `diff_step_44k_dml.onnx` 等）
  - `src/main/modelDownload.js` - bigvgan 下载 IPC（占位，未配置下载源时优雅降级）
  - `src/main/settings.js` - `vocoderType` 枚举校验扩展接受 `bigvgan44k` / `bigvgan44k_ft`
  - `src/settings.html` / `src/settings.js` - vocoder 选择 UI 新增第四选项（两阶段 + 微调版）
  - `src/fragmentEditor/audioPlayback.js` - 播放支持 44100Hz 音频
  - `onnx_models/README.md` - 文档更新

## ADDED Requirements

### Requirement: BigVGAN v2 ONNX 导出脚本
系统 SHALL 提供 `export_bigvgan_vocoder.py`，将 NVIDIA BigVGAN v2 官方 PyTorch 生成器（本地 `bigvgan_generator.pt` + `config.json`）导出为 ONNX 格式。

#### Scenario: 标准 ONNX 导出
- **WHEN** 执行 `python export_bigvgan_vocoder.py --repo third_party/BigVGAN --checkpoint "D:\download\bigvgan_v2_44khz_128band_512x\bigvgan_generator.pt" --config "D:\download\bigvgan_v2_44khz_128band_512x\config.json" --out bigvgan_vocoder.onnx`
- **THEN** 加载 BigVGAN v2 预训练生成器权重（122M 参数，~487MB）
- **THEN** 调用 `model.remove_weight_norm()` 并 `model.eval()`
- **AND** 包装为接受 `mel`（float32, [1, seq_len, 128]）输入的 forward
- **AND** 输出张量名 `waveform`，shape `[1, num_samples]`，采样率 44100Hz
- **AND** 使用 opset_version=18，启用 dynamic_axes（seq_len 动态）
- **AND** 验证导出后 ONNX 与原 PyTorch 输出 L1 误差 < 1e-4

#### Scenario: 导出前依赖检查
- **WHEN** 执行导出脚本
- **THEN** 检查 `third_party/BigVGAN/` 是否存在，缺失时打印明确克隆命令并退出
- **AND** 检查 checkpoint 与 config.json 文件存在性，缺失时打印下载链接并退出

### Requirement: BigVGAN DirectML 兼容性优化
系统 SHALL 提供 `optimize_bigvgan_dml.py`，将 BigVGAN ONNX 中 DML 不支持的大 stride ConvTranspose 分解为 DML 兼容序列。

#### Scenario: DML 不兼容算子分解
- **WHEN** 执行 `python optimize_bigvgan_dml.py --in bigvgan_vocoder.onnx --out bigvgan_vocoder_dml.onnx`
- **THEN** 扫描所有 `ConvTranspose` 节点，识别 stride > 1 的实例（44kHz 512x 模型含 stride=8/8/4/4 等）
- **AND** 应用等价分解：`ConvTranspose1D(x, w, stride=S) = Conv1D(upsample(x, S), flip(w.T), stride=1, pads=[K-1, K-S])`
- **AND** 使用 onnxsim 简化图
- **AND** DirectML EP 探针推理成功，与 CPU 输出误差 < 1e-3

### Requirement: 两阶段 Vocoder 集成路径
系统 SHALL 在 SVS 管线中实现两阶段 vocoding 路径，以解决 SVS mel（24kHz 格式）与 BigVGAN 44kHz mel 格式不兼容问题。

#### Scenario: 两阶段合成流程
- **WHEN** `vocoderType === 'bigvgan44k'` 且 `bigvgan_vocoder_dml.onnx` 已加载
- **THEN** Stage 1：SVS diff_step 产出 mel（24kHz/50Hz）→ 调用默认 vocoder 生成 24kHz 波形
- **AND** Stage 2：波形重采样 24kHz → 44100Hz（线性插值，复用 `resampleLinear`）
- **AND** Stage 2 续：用 BigVGAN 44kHz STFT 配置（n_fft=2048, hop=512, fmax=22050, 128 bins）从重采样波形重新提取 mel
- **AND** Stage 2 续：BigVGAN 44kHz 接受重提取 mel，输出 44100Hz 波形
- **AND** 最终输出采样率标记为 44100，贯穿 WAV 写入、播放、导出

#### Scenario: Stage 1 默认 vocoder 选择
- **WHEN** 进入两阶段路径
- **THEN** Stage 1 默认使用 `vocoder_dml.onnx`（24kHz 原版），不使用 SiFiGAN（避免引入 F0 依赖）
- **AND** 若 `vocoder_dml.onnx` 不可用，回退到 `vocoder.onnx`

#### Scenario: 已知质量权衡（Path A 文档化）
- **WHEN** 用户选择 `bigvgan44k`（两阶段）
- **THEN** 设置页显示说明 tooltip："此选项为两阶段处理：先以 24kHz 合成再以 BigVGAN 44kHz 重 vocoding，高频带宽扩展但无法消除 24kHz 阶段的固有伪影。完整收益请改用「微调版」选项（需微调训练后的 diff_step_44k 模型）。"
- **AND** 该说明同时写入 `onnx_models/README.md`

### Requirement: BigVGAN 44kHz Mel 提取器
系统 SHALL 提供 BigVGAN 44kHz 格式的 mel 提取能力，输入为 44100Hz 波形，输出为 [1, seq, 128] mel 频谱，STFT 参数与 BigVGAN 官方 `config.json` 一致。

#### Scenario: JS 实现 mel 提取
- **WHEN** 进入两阶段路径的 Stage 2
- **THEN** 使用参数化的 `extractMelSpectrogram(audio, 44100, { n_fft: 2048, hop_size: 512, num_mels: 128, fmax: 22050 })`
- **AND** mel filterbank 使用 Hz→Mel 转换，fmin=0, fmax=22050
- **AND** 不应用 SVS 管线的 MEL_MEAN/MEL_VAR 归一化（BigVGAN 训练未使用该归一化，仅做 log 后归一化）
- **AND** 输出 mel 帧数 = floor(num_samples / hop_size) + 1

#### Scenario: 与 BigVGAN 训练 mel 一致性验证
- **WHEN** 用 `third_party/BigVGAN/meldataset.py` 的 `get_mel_spectrogram` 跑同一段 44.1kHz 音频
- **THEN** JS 提取的 mel 与 Python 参考输出 cosine similarity ≥ 0.98
- **AND** 若低于阈值，检查 Hann 窗、FFT、mel filterbank 实现差异

### Requirement: Vocoder 类型选择扩展
系统 SHALL 在设置页"推理"分区将 Vocoder 类型选择扩展为四选一。

#### Scenario: UI 四选项
- **WHEN** 用户打开设置页
- **THEN** "Vocoder 类型"下拉包含四个选项：`默认 Vocoder（24kHz）`、`SiFiGAN（24kHz，音高可控）`、`BigVGAN v2 44kHz（两阶段）`、`BigVGAN v2 44kHz（微调版，单阶段）`
- **AND** 两个 BigVGAN 选项未下载时禁用并显示"未下载"
- **AND** 切换到 `bigvgan44k` 时显示两阶段质量权衡 tooltip
- **AND** 切换到 `bigvgan44k_ft` 时显示"微调版单阶段，完整高频重建"说明

#### Scenario: 持久化与回退
- **WHEN** 应用启动且 `vocoderType === 'bigvgan44k'` 但 `bigvgan_vocoder_dml.onnx` 缺失
- **THEN** 自动回退到 `default` 并记录警告
- **WHEN** 应用启动且 `vocoderType === 'bigvgan44k_ft'` 但 `diff_step_44k_dml.onnx` 或 `bigvgan_vocoder_dml.onnx` 缺失
- **THEN** 自动回退到 `default` 并记录警告
- **AND** 设置变更后下次 SVS 推理生效（无需重启）

### Requirement: 输出采样率解耦
系统 SHALL 将合成输出采样率从硬编码 24000 改为按 vocoderType 派生，确保 44100Hz 输出正确写入 WAV 与播放。

#### Scenario: 采样率派生
- **WHEN** vocoderType 为 `default` 或 `sifigan`
- **THEN** 输出采样率 = 24000
- **WHEN** vocoderType 为 `bigvgan44k` 或 `bigvgan44k_ft`
- **THEN** 输出采样率 = 44100

#### Scenario: WAV 写入与播放
- **THEN** WAV 文件头 sample rate 字段使用派生值
- **AND** 音频播放器（`fragmentEditor/audioPlayback.js`）使用派生值初始化 AudioContext
- **AND** 缓存键（cache key）含采样率以避免 24k/44.1k 缓存混淆

### Requirement: 模型下载管理器支持 BigVGAN
系统 SHALL 在模型下载窗口将 BigVGAN v2 显示为可选独立模型组，与 SiFiGAN 并存。

#### Scenario: 清单注册与占位
- **WHEN** 模型下载窗口加载
- **THEN** `MODEL_FILE_MANIFEST` 包含 `bigvgan_vocoder_dml.onnx`（required: false）
- **AND** `MODEL_GROUPS` 新增 `bigvgan-vocoder` 组，`sessionKey: 'bigvgan'`
- **AND** `MODEL_IDS.bigvgan` 初始为空字符串 + `// TODO: 等用户填写 ModelScope/HF Mirror 仓库 ID`
- **AND** UI 显示独立卡片"BigVGAN v2 44kHz Vocoder（可选，需手动下载）"

#### Scenario: 下载源未配置时优雅降级
- **WHEN** `MODEL_IDS.bigvgan` 为空且用户点击下载
- **THEN** 返回 `download_url_not_configured` 状态
- **AND** UI 提示"下载链接待配置，请从 HuggingFace nvidia/bigvgan_v2_44khz_128band_512x 手动下载后放置于 onnx_models/"
- **AND** 手动放置后自动刷新为"已安装"

### Requirement: Path B 微调训练脚本
系统 SHALL 提供 Python 微调脚本，将当前 SVS 扩散模型（`diff_step`）适配为输出 44kHz mel 格式，无需从头重训。

#### Scenario: 训练集 mel 重提取
- **WHEN** 执行 `python reextract_mel_44k.py --audio_dir <训练音频> --out <mel_44k_dir>`
- **THEN** 用 BigVGAN 44kHz STFT 配置（n_fft=2048, hop=512, fmax=22050, 128 bins）从训练音频重新提取 mel 目标
- **AND** 输出 mel shape `[1, seq_44k, 128]`，seq_44k = floor(num_samples / 512)
- **AND** 保留与原训练集对齐的音素/MIDI/F0 标注（仅 mel 目标更换）

#### Scenario: diff_step 微调
- **WHEN** 执行 `python finetune_diff_step_44k.py --resume <current_diff_step_ckpt> --mel_dir <mel_44k_dir> --epochs N`
- **THEN** 从当前 diff_step checkpoint 恢复权重
- **AND** 编码器（note_text/pitch/type/f0_encoder）权重冻结（`requires_grad=False`）
- **AND** 仅微调 diff_step（+ 可选 preflow / cond_emb）
- **AND** 学习率 ~1e-5，~100k-500k steps，单 GPU 数天
- **AND** 训练完成后导出 `diff_step_44k_dml.onnx`（+ 可选 `preflow_44k.onnx` / `cond_emb_44k.onnx`）
- **AND** 导出后 ONNX 与 PyTorch 输出 L1 误差 < 1e-4

### Requirement: Path B 单阶段 Vocoder 集成
系统 SHALL 在 SVS 管线中支持 Path B 单阶段路径，加载微调版 diff_step + BigVGAN 44kHz 直接产出 44.1kHz 波形。

#### Scenario: 单阶段合成流程
- **WHEN** `vocoderType === 'bigvgan44k_ft'` 且 `diff_step_44k_dml.onnx` + `bigvgan_vocoder_dml.onnx` 均已加载
- **THEN** SVS 编码器（冻结版）→ preflow_44k → cond_emb_44k → diff_step_44k 产出 mel（44kHz 格式，[1, seq_44k, 128]）
- **AND** BigVGAN 44kHz 直接接受该 mel，输出 44100Hz 波形（无需 mel 重提取、无需两阶段）
- **AND** 最终输出采样率标记为 44100

#### Scenario: 模型加载分支
- **WHEN** `_loadModelsPartitioned` 且 `vocoderType === 'bigvgan44k_ft'`
- **THEN** 加载 `diff_step_44k_dml.onnx` 到 sessionKey `diffStep`（覆盖默认 diff_step）
- **AND** 加载 `preflow_44k.onnx` / `cond_emb_44k.onnx`（若存在，否则回退默认版 + 警告）
- **AND** 加载 `bigvgan_vocoder_dml.onnx` 到 sessionKey `vocoder`
- **AND** 若任一关键模型缺失，回退到 `default` 并警告

## MODIFIED Requirements

### Requirement: Vocoder 类型枚举
`vocoderType` 取值集合从 `'default' | 'sifigan'` 扩展为 `'default' | 'sifigan' | 'bigvgan44k' | 'bigvgan44k_ft'`，默认 `'default'`。`src/main/settings.js` 枚举校验同步扩展。

### Requirement: Vocoder 路径回退链
`_loadModelsPartitioned` 的 vocoder 路径回退扩展为按 vocoderType 选择起点：
- `bigvgan44k` / `bigvgan44k_ft`：`bigvgan_vocoder_dml.onnx` → `vocoder_dml.onnx` → `vocoder.onnx`
- `sifigan`：`sifigan_vocoder_dml_fp16.onnx` → `sifigan_vocoder_dml.onnx` → `vocoder_dml.onnx` → `vocoder.onnx`
- `bigvgan44k_ft` 额外：diff_step 加载 `diff_step_44k_dml.onnx`（缺失则回退默认 + 警告降级为 Path A 两阶段）

### Requirement: Pipeline Vocoder 调度
`OnnxSVSPipeline` 的 vocoder 调度扩展为三种模式：
- `vocoderType ∈ {default, sifigan}`：单阶段（现有逻辑，24kHz 输出）
- `vocoderType === bigvgan44k`：两阶段（Stage 1 默认 vocoder + Stage 2 BigVGAN，44.1kHz 输出）
- `vocoderType === bigvgan44k_ft`：单阶段（微调版 diff_step → BigVGAN，44.1kHz 输出）
`runVocoderChunked` 分块逻辑需在两阶段路径中对 Stage 2 同样分块（44.1kHz 波形更长，避免单次 OOM）。

## REMOVED Requirements
无。本变更纯新增，不删除任何现有功能。默认 vocoder 与 SiFiGAN 保持完全可用作为回退方案。
