# Tasks
- [x] Task 1: 创建RmvpePitchDetector类
  - [x] SubTask 1.1: 创建 `src/inference/rmvpePitchDetector.js` 文件
  - [x] SubTask 1.2: 实现音频重采样功能（44100Hz -> 16000Hz）
  - [x] SubTask 1.3: 实现加载RMVPE ONNX模型（rmvpe_mel.onnx 和 rmvpe_model.onnx）
  - [x] SubTask 1.4: 实现F0提取推理流程：音频 -> Mel频谱 -> 音高检测
  - [x] SubTask 1.5: 实现F0到MIDI音符的转换逻辑

- [x] Task 2: 在main.js中添加IPC支持
  - [x] SubTask 2.1: 导入RmvpePitchDetector类
  - [x] SubTask 2.2: 添加 `extractF0:onnx` IPC handler
  - [x] SubTask 2.3: 添加模型初始化和错误处理

- [x] Task 3: 在preload.js中暴露新API
  - [x] SubTask 3.1: 添加 `extractF0` IPC调用方法

- [x] Task 4: 修改audioPreprocess.js使用真实RMVPE
  - [x] SubTask 4.1: 修改 `extractF0AndPitch` 函数调用主进程的RMVPE推理
  - [x] SubTask 4.2: 移除或保留 `simulateF0AndPitchExtraction` 作为回退方案
  - [x] SubTask 4.3: 更新UI提示信息

# Task Dependencies
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 1]
- [Task 4] depends on [Task 2, Task 3]
