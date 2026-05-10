# Tasks

- [x] Task 1: 修正mel2token构建逻辑 - 重写为Python精确帧级别对齐算法
  - [x] SubTask 1.1: 在nativeSvsPipeline.js中重写`_buildMel2token()`方法，实现Python `DataProcessor.preprocess()`的ph_locations + 重复填充算法
  - [x] SubTask 1.2: 修改`notesToSequences()`以生成ph_locations信息（每个音符的起始帧和token数）
  - [x] SubTask 1.3: 添加mel2token边界检查（mel2token.max() <= tokenCount - 1）
  - [x] SubTask 1.4: 更新测试用例验证新的mel2token构建逻辑

- [x] Task 2: 修正英文音素SEP位置
  - [x] SubTask 2.1: 修改`notesToSequences()`中英文音素处理逻辑，将`<SEP>`从子音素之间移到所有子音素之后
  - [x] SubTask 2.2: 确保英文子音素每个都带`en_`前缀（与Python一致：`['en_' + x for x in phoneme[3:].split('-')]`）

- [x] Task 3: 修正CFG std计算方式
  - [x] SubTask 3.1: 修改`synthesize()`中CFG计算逻辑，从逐帧std改为全局std
  - [x] SubTask 3.2: 对target区域所有帧和维度计算一个全局的pos_std和cfg_std
  - [x] SubTask 3.3: 使用全局std进行rescale计算

- [x] Task 4: 实现auto_shift自动音高偏移
  - [x] SubTask 4.1: 在`synthesize()`中添加auto_shift参数
  - [x] SubTask 4.2: 实现中位F0差值计算逻辑（melody模式：log2比 * 1200/100，score模式：中位pitch差）
  - [x] SubTask 4.3: 将f0_shift应用于F0量化（f0_shift * 5）和note_pitch偏移
  - [x] SubTask 4.4: 在fragmentEditor UI中添加auto_shift开关

- [x] Task 5: 实现F0帧率插值
  - [x] SubTask 5.1: 在rmvpePitchDetector.js中添加`interpolateF0()`方法
  - [x] SubTask 5.2: 实现从RMVPE 16kHz/160hop到24kHz/480hop的线性插值
  - [x] SubTask 5.3: 在F0提取流程中自动调用插值

- [x] Task 6: 实现merge_phoneme合并连续SP音符
  - [x] SubTask 6.1: 在audioPreprocess.js的`buildSingerFields()`中添加merge_phoneme逻辑
  - [x] SubTask 6.2: 合并相邻相同SP音符（phoneme、note_type、note_pitch都相同）

- [x] Task 7: 修复已知bug
  - [x] SubTask 7.1: 修复renderer.js中`pipeline`未定义变量（应为`pipelineInitialized`）
  - [x] SubTask 7.2: 修复导出混合时startSample计算错误（使用秒数而非拍数）
  - [x] SubTask 7.3: 修复rmvpePitchDetector.js dispose未调用session.release()

- [x] Task 8: 实现MIDI文件导入
  - [x] SubTask 8.1: 在main.js中添加MIDI文件解析IPC通道
  - [x] SubTask 8.2: 实现MIDI解析器（参考Python midi2notes），解析note_on/note_off/lyrics事件
  - [x] SubTask 8.3: 在preload.js中暴露MIDI导入API
  - [x] SubTask 8.4: 在fragmentEditor UI中添加MIDI导入按钮

- [x] Task 9: 实现英文G2P词典映射
  - [x] SubTask 9.1: 创建英文G2P词典文件（常用单词到CMU音素的映射）
  - [x] SubTask 9.2: 在nativeSvsPipeline.js中添加英文G2P查找逻辑
  - [x] SubTask 9.3: 未知英文单词使用字母级回退

- [x] Task 10: 更新测试用例
  - [x] SubTask 10.1: 为新的mel2token构建逻辑编写测试
  - [x] SubTask 10.2: 为英文音素SEP位置修正编写测试
  - [x] SubTask 10.3: 为CFG全局std计算编写测试
  - [x] SubTask 10.4: 为auto_shift编写测试
  - [x] SubTask 10.5: 为F0插值编写测试
  - [x] SubTask 10.6: 为merge_phoneme编写测试

# Task Dependencies
- [Task 1] 是最关键的任务，其他推理管线修正依赖它
- [Task 2] 依赖 [Task 1]（英文音素处理影响mel2token构建）
- [Task 3] 独立，可并行
- [Task 4] 依赖 [Task 5]（auto_shift需要正确的F0数据）
- [Task 5] 独立，可并行
- [Task 6] 独立，可并行
- [Task 7] 独立，可并行
- [Task 8] 独立，可并行
- [Task 9] 独立，可并行
- [Task 10] 依赖所有其他任务完成
