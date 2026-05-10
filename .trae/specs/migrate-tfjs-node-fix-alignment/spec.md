# 替换tfjs为tfjs-node并修正对齐问题

## Why
Basic Pitch Detector在Electron主进程使用`@tensorflow/tfjs`时，`file://`协议模型加载依赖`fetch`，而Node.js的undici fetch不支持`file://`协议导致"fetch failed"错误。同时音频预处理页面中wav波形、F0曲线和MIDI编辑器之间存在时间轴错位问题。此外，需要统一使用DirectML而非WebGPU进行GPU加速，实现低负载模型CPU执行、高负载模型GPU执行的策略。

## What Changes
- 将`@tensorflow/tfjs`替换为`@tensorflow/tfjs-node`，使用native后端直接读取本地文件
- 修正音频预处理页面中F0曲线和MIDI音符与wav波形的时间轴对齐
- 统一GPU加速策略：DirectML用于高负载模型（SVS pipeline），CPU用于低负载模型（RMVPE）
- 删除不再需要的`@tensorflow/tfjs`依赖

## Impact
- 受影响的规格：F0提取（RMVPE + Basic Pitch）、SVS合成
- 受影响的代码：
  - `package.json` - 依赖变更
  - `src/inference/basicPitch.js` - tfjs API切换
  - `src/audioPreprocess.js` - F0曲线时间轴计算修正
  - `src/inference/rmvpePitchDetector.js` - 可选GPU回退支持
  - `src/inference/nativeSvsPipeline.js` - 已有DirectML策略确认

## MODIFIED Requirements
### Requirement: Basic Pitch模型加载
系统shall使用`@tensorflow/tfjs-node`加载本地Basic Pitch模型，避免Node.js环境下的`fetch`协议限制。

#### Scenario: 成功加载Basic Pitch模型
- **WHEN** 主进程初始化Basic Pitch Detector
- **THEN** 使用`tf.loadGraphModel`配合`file://`协议或本地文件系统读取器加载模型
- **AND** 不再出现"fetch failed"错误

### Requirement: F0曲线和MIDI时间轴对齐
F0曲线和MIDI音符的X轴位置shall与wav波形的时间轴严格对齐，基于统一的秒到像素的映射。

#### Scenario: 显示F0曲线和MIDI音符
- **WHEN** 用户提取F0后
- **THEN** F0曲线的每个点在X轴上的位置对应正确的音频时间
- **AND** MIDI音符的起始和结束时间与音频波形对齐

### Requirement: GPU/CPU分配策略
高负载模型（SVS Pipeline中的vocoder、diff_step等）使用DirectML/GPU，低负载模型（RMVPE F0检测）使用CPU。

#### Scenario: 模型初始化
- **WHEN** 初始化SVS Pipeline
- **THEN** 使用DirectML执行提供程序
- **AND** RMVPE使用CPU执行提供程序
- **AND** Basic Pitch（tfjs-node）默认使用CPU后端
