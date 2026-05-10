# 集成RMVPE ONNX模型进行F0和音高提取

## Why
当前 `audioPreprocess.js` 中的 `simulateF0AndPitchExtraction` 函数使用的是模拟数据生成F0和音高，而非真实的音高检测。需要将已放置在 `onnx_models/preprocess` 文件夹中的RMVPE ONNX模型应用到自动获取F0和音高的功能中，实现真实的音高检测。

## What Changes
- 在主进程创建 `RmvpePitchDetector` 类，封装RMVPE ONNX模型的推理逻辑
- 在 `main.js` 中添加IPC handler处理前端的F0提取请求
- 在 `preload.js` 中暴露新的IPC API给渲染进程
- 修改 `audioPreprocess.js` 中的 `extractF0AndPitch` 函数，调用真实的RMVPE模型替代模拟数据

## Impact
- 受影响的功能：音频预处理页面的F0和音高自动提取
- 受影响的代码：
  - `src/main.js` - 添加新的IPC handler和RMVPE推理逻辑
  - `src/preload.js` - 添加新的API暴露
  - `src/audioPreprocess.js` - 替换模拟数据为真实推理
- ONNX模型：`onnx_models/preprocess/rmvpe_mel.onnx`, `onnx_models/preprocess/rmvpe_model.onnx`

## ADDED Requirements
### Requirement: RMVPE F0提取
系统shall使用RMVPE ONNX模型进行真实的音高检测，从加载的WAV音频中提取F0数据。

#### Scenario: 成功提取F0
- **WHEN** 用户点击"自动获取F0和音高"按钮
- **THEN** 系统使用RMVPE模型分析音频，提取真实的F0曲线和MIDI音符
- **AND** 将提取的音符显示在MIDI编辑器中

#### Scenario: 音频未加载
- **WHEN** 用户点击"自动获取F0和音高"但未加载音频
- **THEN** 提示"请先加载音频文件"

### Requirement: RMVPE模型推理
系统shall在主进程中加载和运行RMVPE ONNX模型，因为渲染进程无法直接访问文件系统加载ONNX模型。

#### 推理流程
1. 前端将音频数据（Float32Array，44100Hz采样率）通过IPC发送到主进程
2. 主进程将音频重采样到16000Hz（RMVPE要求的采样率）
3. 主进程运行 `rmvpe_mel.onnx` 将音频转换为梅尔频谱
4. 主进程运行 `rmvpe_model.onnx` 进行音高检测
5. 主进程将F0结果返回给前端

## MODIFIED Requirements
### Requirement: F0和音高提取
原有的 `simulateF0AndPitchExtraction` 函数shall被替换为调用真实的RMVPE模型推理，不再使用模拟数据。
