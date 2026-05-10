# Tasks

- [ ] Task 1: 搭建主窗口布局（仿 OpenUTAU）
  - [ ] SubTask 1.1: 修改 `src/main.js` 设置窗口大小（1280x800）并启用必要权限
  - [ ] SubTask 1.2: 修改 `src/index.html` 创建左侧轨道面板 + 右侧钢琴卷帘容器结构
  - [ ] SubTask 1.3: 修改 `src/index.css` 实现左右分栏布局和工具栏样式
  - [ ] SubTask 1.4: 修改 `src/preload.js` 暴露 IPC API（文件对话框、音频保存）

- [ ] Task 2: 实现钢琴卷帘（Piano Roll）核心渲染与交互
  - [ ] SubTask 2.1: 使用 Canvas 绘制钢琴键背景、网格线、时间轴
  - [ ] SubTask 2.2: 实现音符块的绘制（不同颜色区分轨道）
  - [ ] SubTask 2.3: 实现鼠标点击/拖拽创建音符
  - [ ] SubTask 2.4: 实现音符选中、移动、调整时长、删除
  - [ ] SubTask 2.5: 实现歌词/音素编辑（双击弹窗或行内编辑）

- [ ] Task 3: 实现轨道（Track）管理系统
  - [ ] SubTask 3.1: 创建轨道数据模型（id, name, singer, notes, color）
  - [ ] SubTask 3.2: 实现左侧轨道列表 UI（显示歌手名、颜色标识）
  - [ ] SubTask 3.3: 实现添加/删除轨道功能
  - [ ] SubTask 3.4: 实现轨道选择歌手（下拉选择 ONNX 模型）

- [ ] Task 4: 实现播放控制与音频引擎
  - [ ] SubTask 4.1: 实现顶部工具栏（播放/暂停/停止按钮、时间显示）
  - [ ] SubTask 4.2: 实现 BPM、拍号设置
  - [ ] SubTask 4.3: 使用 Web Audio API 实现音频播放
  - [ ] SubTask 4.4: 实现播放头（Playhead）动画

- [ ] Task 5: 实现 ONNX SVS 推理管线
  - [ ] SubTask 5.1: 安装并配置 `onnxruntime-web`（GPU 后端）
  - [ ] SubTask 5.2: 创建 `src/inference/svsPipeline.js` 封装模型加载
  - [ ] SubTask 5.3: 实现音符序列 → 模型输入张量转换
  - [ ] SubTask 5.4: 实现推理流程：encoders → preflow → cond_emb → diff_step → vocoder
  - [ ] SubTask 5.5: 实现 GPU 加速（WebGPU/CUDA）优先，CPU 回退

- [ ] Task 6: 实现音频导出功能
  - [ ] SubTask 6.1: 实现合成音频 → WAV 编码（24kHz, 32-bit float）
  - [ ] SubTask 6.2: 集成文件保存对话框导出 WAV

- [ ] Task 7: 实现工程文件保存/加载
  - [ ] SubTask 7.1: 定义工程 JSON Schema（tracks, notes, bpm, timeSignature）
  - [ ] SubTask 7.2: 实现保存工程为 JSON 文件
  - [ ] SubTask 7.3: 实现加载 JSON 工程文件恢复状态

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 2, Task 3
- Task 6 depends on Task 5
- Task 7 depends on Task 2, Task 3
