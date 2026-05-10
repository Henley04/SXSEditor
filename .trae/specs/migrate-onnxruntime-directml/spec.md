# 迁移 SVS Pipeline 至 ONNX Runtime + DirectML 并修复歌手预处理全链路

## Why
当前 SVS Pipeline 使用 ExecuTorch C++ 原生插件（.pte 格式），构建复杂、依赖链长、跨平台困难。需要将 SVS Pipeline 迁移到 onnxruntime-node + DirectML 执行提供程序，消除 ExecuTorch 依赖，建立完备的推理逻辑，保障输入输出完美对齐。同时修复歌手预处理全链路（RMVPE F0 提取 → Basic Pitch 音符提取 → SVS 合成），确保端到端可用。RMVPE 和 Basic Pitch 保持现有实现不变。

## What Changes
- **SVS Pipeline 迁移**：将 `nativeSvsPipeline.js` 从 ExecuTorch C++ 插件迁移到 onnxruntime-node，使用 `onnx_models/` 目录下的 ONNX 模型（note_text_encoder、note_pitch_encoder、note_type_encoder、f0_encoder、preflow、cond_emb、diff_step、vocoder）
- **DirectML 执行提供程序**：SVS Pipeline 模型推理使用 DirectML GPU 加速，不可用时自动回退 CPU
- **删除 ExecuTorch 依赖**：移除 `native/` 目录下的 C++ 插件代码和 `executorch_models/` 目录
- **修复歌手预处理全链路**：确保 RMVPE F0 提取 → Basic Pitch 音符提取 → SVS 合成的完整链路打通
- **模型输入输出验证**：逐一验证每个 ONNX 模型的输入名称、形状、数据类型与推理代码的对齐

## Impact
- Affected specs: integrate-rmvpe-onnx, complete-first-release
- Affected code:
  - `src/inference/nativeSvsPipeline.js` - 完全重写为 ONNX Runtime 版本
  - `src/inference/rmvpePitchDetector.js` - 不修改
  - `src/inference/basicPitch.js` - 不修改
  - `src/main.js` - 更新 IPC handler 和模型路径
  - `src/preload.js` - 无变化
  - `src/audioPreprocess.js` - 修复预处理链路
  - `package.json` - 移除 node-addon-api 依赖，确认 onnxruntime-node 版本
  - `native/` - 删除 ExecuTorch C++ 插件
  - `executorch_models/` - 删除 .pte 模型文件

## ADDED Requirements

### Requirement: SVS Pipeline ONNX Runtime 推理
系统 SHALL 使用 onnxruntime-node 替代 ExecuTorch C++ 插件执行 SVS 推理管线，推理流程为：note_text_encoder → note_pitch_encoder → note_type_encoder → f0_encoder → preflow → cond_emb → diff_step (×N) → vocoder。

#### Scenario: 初始化 SVS Pipeline
- **WHEN** 初始化 SVS Pipeline
- **THEN** 使用 `ort.InferenceSession.create()` 加载 ONNX 模型
- **AND** 优先使用 DirectML 执行提供程序（`executionProviders: ['dml']`）
- **AND** DirectML 不可用时自动回退到 CPU
- **AND** 日志记录实际使用的执行提供程序
- **AND** 从 `onnx_models/` 目录加载以下模型：
  - note_text_encoder.onnx
  - note_pitch_encoder.onnx
  - note_type_encoder.onnx
  - f0_encoder.onnx
  - preflow.onnx
  - cond_emb.onnx
  - diff_step.onnx
  - vocoder.onnx
- **AND** 每个模型验证输入/输出名称和形状

#### Scenario: Encoder 推理
- **WHEN** 执行编码器推理
- **THEN** 分别运行 note_text_encoder、note_pitch_encoder、note_type_encoder、f0_encoder
- **AND** 输入为 int64 类型的 token 序列
- **AND** 输出为 float32 类型的嵌入向量
- **AND** 将所有嵌入拼接后送入 preflow

#### Scenario: 扩散推理
- **WHEN** 执行扩散步骤
- **THEN** 循环执行 diff_step 模型 N 次（默认 32 步）
- **AND** 支持 CFG（Classifier-Free Guidance）强度控制
- **AND** 支持 CFG Rescale 策略
- **AND** 每步使用正确的 t 值和时间步进

#### Scenario: Vocoder 推理
- **WHEN** 扩散完成生成梅尔频谱
- **THEN** 将梅尔频谱送入 vocoder 模型
- **AND** 输出 24kHz 音频波形
- **AND** 支持分块推理以控制内存使用

#### Scenario: 参考音频条件
- **WHEN** 提供参考音频
- **THEN** 使用 mel_transform 模型提取参考音频的梅尔频谱
- **AND** 将参考梅尔频谱作为 prompt 条件拼接到推理输入中

#### Scenario: 模型会话管理
- **WHEN** 推理模块初始化
- **THEN** 每个模型创建独立的 InferenceSession
- **AND** 会话在模块 dispose 时正确释放
- **AND** 重复调用 init() 不重复创建会话

### Requirement: 歌手预处理全链路打通
系统 SHALL 确保从音频加载到 F0 提取到音符提取到数据保存的完整预处理链路可用。

#### Scenario: RMVPE F0 提取
- **WHEN** 用户在音频预处理页面点击"RMVPE提取F0"
- **THEN** 音频数据通过 IPC 传到主进程
- **AND** RMVPE 模型成功推理并返回 F0 数组
- **AND** F0 曲线正确显示在钢琴卷帘的 F0 区域
- **AND** F0 数据保存到 singerData

#### Scenario: Basic Pitch 音符提取
- **WHEN** 用户点击"Basic Pitch提取音符"
- **THEN** Basic Pitch 模型成功推理并返回音符和 F0
- **AND** 音符正确显示在钢琴卷帘中
- **AND** F0 曲线正确显示
- **AND** 音符和 F0 数据保存到 singerData

#### Scenario: 预处理数据保存
- **WHEN** 用户点击保存
- **THEN** singerData 包含完整的 f0、midiNotes、phoneme、note_type 等字段
- **AND** 数据通过 IPC 传回歌手创建页面
- **AND** 歌手文件正确保存

#### Scenario: SVS 合成使用预处理数据
- **WHEN** 用户使用已预处理的歌手进行 SVS 合成
- **THEN** 参考音频和 F0 数据正确传递到 SVS Pipeline
- **AND** 合成音频质量达到可用标准

### Requirement: DirectML GPU 加速策略
系统 SHALL 对 SVS Pipeline 模型采用 DirectML GPU 加速策略。

#### Scenario: 高负载模型使用 DirectML
- **WHEN** 加载 SVS Pipeline 模型（diff_step、vocoder、cond_emb）
- **THEN** 优先使用 DirectML 执行提供程序
- **AND** 这些模型计算量大，GPU 加速显著提升性能

#### Scenario: DirectML 不可用
- **WHEN** 系统检测到 DirectML 不可用（如无 GPU 驱动）
- **THEN** 所有 SVS 模型回退到 CPU 执行
- **AND** 日志记录回退原因
- **AND** 功能不受影响，仅性能下降

## MODIFIED Requirements

### Requirement: SVS Pipeline 模型路径
模型路径从 `executorch_models/` 变更为 `onnx_models/`，模型格式从 .pte 变更为 .onnx。

### Requirement: 依赖管理
- 移除 `node-addon-api` 依赖（仅用于 ExecuTorch C++ 插件）
- 保留 `@tensorflow/tfjs` 依赖（Basic Pitch 仍使用）
- 保留 `onnxruntime-node` 依赖（已有，SVS Pipeline 和 RMVPE 使用）

## REMOVED Requirements

### Requirement: ExecuTorch C++ 原生插件
**Reason**: 迁移到 ONNX Runtime 后不再需要 ExecuTorch 运行时
**Migration**: 删除 `native/` 目录和 `executorch_models/` 目录，SVS Pipeline 改用 ONNX 模型
