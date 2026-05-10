# Tasks

- [x] Task 1: 替换tfjs为tfjs-node依赖
  - [x] SubTask 1.1: 从package.json移除@tensorflow/tfjs，添加@tensorflow/tfjs-node
  - [x] SubTask 1.2: 运行npm install安装新依赖
  - [x] SubTask 1.3: 验证tfjs-node安装成功

- [x] Task 2: 修改Basic Pitch Detector使用tfjs-node
  - [x] SubTask 2.1: 将basicPitch.js中的require('@tensorflow/tfjs')改为require('@tensorflow/tfjs-node')
  - [x] SubTask 2.2: 更新webpack.main.config.js externals配置
  - [ ] SubTask 2.3: 验证模型加载不再出现fetch failed错误

- [x] Task 3: 修正音频预处理页面时间轴对齐
  - [x] SubTask 3.1: 分析wav波形、F0曲线、MIDI音符的时间映射关系
  - [x] SubTask 3.2: 修正audioPreprocess.js中pianoRoll的_drawF0Curve方法，使用统一的_secondsToBeats和_timeToX方法
  - [x] SubTask 3.3: 确保F0数据的time字段与音频秒数对应（RMVPE和Basic Pitch都已使用秒）
  - [x] SubTask 3.4: 确保MIDI音符的start时间正确转换为像素位置（使用统一的_timeToX方法）

- [x] Task 4: 统一GPU加速策略
  - [x] SubTask 4.1: 确认nativeSvsPipeline.js使用DirectML（已有）
  - [x] SubTask 4.2: 确认rmvpePitchDetector.js使用CPU（已有）
  - [x] SubTask 4.3: 在rmvpePitchDetector.js中添加可选的DirectML支持（优先DirectML，回退CPU）
  - [x] SubTask 4.4: 确认Basic Pitch通过tfjs-node使用CPU

- [ ] Task 5: 端到端验证
  - [ ] SubTask 5.1: 运行应用，验证Basic Pitch模型加载成功
  - [ ] SubTask 5.2: 验证RMVPE模型加载成功
  - [ ] SubTask 5.3: 验证SVS Pipeline DirectML加载成功
  - [ ] SubTask 5.4: 验证音频预处理页面F0曲线与波形对齐
  - [ ] SubTask 5.5: 验证MIDI音符与波形对齐

# Task Dependencies
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 2] (需要先确保F0数据格式正确)
- [Task 5] depends on [Task 1, Task 2, Task 3, Task 4]
