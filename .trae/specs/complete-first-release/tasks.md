# Tasks

- [x] Task 1: 修复 SVS 推理管线
  - [x] SubTask 1.1: 修正 `notesToModelInputs` 函数，正确构建帧级 F0 序列（按 hop_size=480, sr=24000 计算帧数）
  - [x] SubTask 1.2: 修正 `_repeatToFrames` 函数，按音符实际时长比例分配帧数（而非简单重复）
  - [x] SubTask 1.3: 修正扩散推理循环，使用合理的 t 范围和更新步进公式
  - [x] SubTask 1.4: 修正模型输入张量名称（根据 README 中的输入名称）
  - [x] SubTask 1.5: 添加参考音频音色条件嵌入支持（通过 mel_transform + cond_emb 提取）
  - [x] SubTask 1.6: 配置 onnxruntime-web 使用 WebGPU 后端优先，CPU 回退
  - [x] SubTask 1.7: 推理过程完全异步，添加进度回调（progress: 0-100%）
  - [x] SubTask 1.8: F0 包络值在推理时应用到音符 pitch 偏移

- [x] Task 2: 实现主窗口播放控制
  - [x] SubTask 2.1: 实现 `playAll()` 函数：收集所有分片音符，调用 SVS 管线合成
  - [x] SubTask 2.2: 使用 Web Audio API 创建 AudioBuffer 和 AudioBufferSourceNode 播放
  - [x] SubTask 2.3: 实现暂停/停止逻辑，保留播放位置
  - [x] SubTask 2.4: 实现播放头动画（requestAnimationFrame 更新时间显示）
  - [x] SubTask 2.5: 连接播放按钮到实际功能

- [x] Task 3: 实现音频导出功能
  - [x] SubTask 3.1: 在 `renderer.js` 中连接导出按钮到合成 + WAV 编码流程
  - [x] SubTask 3.2: 集成 `encodeWav` 将 Float32Array 编码为 24kHz 32-bit float WAV
  - [x] SubTask 3.3: 使用 `electronAPI.showSaveDialog` + `saveFile` 保存文件

- [x] Task 4: 增强分片编辑器
  - [x] SubTask 4.1: 在 `fragmentEditor.html` 添加播放/导出按钮
  - [x] SubTask 4.2: 在 `fragmentEditor.js` 实现分片内合成播放功能
  - [x] SubTask 4.3: 在 `fragmentEditor.js` 实现分片内导出功能
  - [x] SubTask 4.4: 集成 EnvelopeEditor 组件到分片编辑器的参数曲线区域
  - [x] SubTask 4.5: 实现 F0 包络编辑功能（-12 到 +12 半音范围）

- [x] Task 5: 实现歌手面板包络编辑
  - [x] SubTask 5.1: 在 `index.html` 歌手面板添加包络编辑区域（VOL/PAN）
  - [x] SubTask 5.2: 按照 `singer-panel-design.md` 实现包络曲线渲染
  - [x] SubTask 5.3: 实现关键帧交互（添加、拖拽、编辑、删除）

- [x] Task 6: 工程保存/加载（.sxsproj 格式）
  - [x] SubTask 6.1: 统一文件扩展名为 .sxsproj（保存、加载对话框过滤器）
  - [x] SubTask 6.2: 工程 JSON 包含完整数据（tracks, singers, fragments, notes, envelopes, bpm, timeSignature, version）
  - [x] SubTask 6.3: 验证加载后状态完全恢复

- [x] Task 7: 集成验证与联调
  - [x] SubTask 7.1: 验证 ONNX 模型加载（确认所有模型正确加载）
  - [x] SubTask 7.2: 验证完整推理流程（输入音符 → 输出音频）
  - [x] SubTask 7.3: 验证播放/暂停/停止功能
  - [x] SubTask 7.4: 验证导出 WAV 可正常播放
  - [x] SubTask 7.5: 验证 F0 编辑影响合成音高
  - [x] SubTask 7.6: 验证 .sxsproj 工程保存/加载

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1
- Task 5 can be done in parallel with Task 1
- Task 6 can be done in parallel with Task 1
- Task 7 depends on Task 2, Task 3, Task 4, Task 5, Task 6
