# 修复全部 Bug 和未实现功能 - 任务列表

## Task 1: 修复关键 Bug
- [ ] SubTask 1.1: 修复 `pipeline.init()` 未 await（renderer.js 的 init() 函数）
- [ ] SubTask 1.2: 修复时间显示毫秒计算错误（×100 改为 ×1000）
- [ ] SubTask 1.3: 修复 EnvelopeEditor 包络关键帧拖动索引错位
- [ ] SubTask 1.4: 修复 Fragment 编辑器包络拖动索引错位

## Task 2: 实现主窗口钢琴卷帘
- [ ] SubTask 2.1: 在 index.html 添加钢琴卷帘 canvas 元素
- [ ] SubTask 2.2: 在 renderer.js 中实例化 PianoRoll 类并连接事件
- [ ] SubTask 2.3: 实现音符创建（点击拖拽）
- [ ] SubTask 2.4: 实现音符移动、调整时长、删除
- [ ] SubTask 2.5: 实现双击音符编辑歌词
- [ ] SubTask 2.6: 实现钢琴卷帘与轨道数据联动

## Task 3: 复用 EnvelopeEditor 消除重复代码
- [ ] SubTask 3.1: 在 renderer.js 歌手面板中使用 EnvelopeEditor 类替代重复实现
- [ ] SubTask 3.2: 在 fragmentEditor.js 中使用 EnvelopeEditor 类替代重复实现
- [ ] SubTask 3.3: 删除重复的包络渲染和交互代码

## Task 4: 实现歌手创建页面
- [ ] SubTask 4.1: 实现选择 ONNX 模型文件夹对话框
- [ ] SubTask 4.2: 验证模型文件完整性（所有 .onnx 文件存在）
- [ ] SubTask 4.3: 注册歌手到下拉列表和状态管理

## Task 5: 完善 Fragment 编辑器功能
- [ ] SubTask 5.1: 实现双击音符编辑歌词功能
- [ ] SubTask 5.2: 实现 Fragment 包络关键帧交互（添加、拖拽、编辑、删除）
- [ ] SubTask 5.3: 修复 Fragment 包络渲染插值精度
- [ ] SubTask 5.4: 优化右键菜单体验（避免双对话框）

## Task 6: 应用 VOL/PAN 包络到混音
- [ ] SubTask 6.1: 在 playAll() 混音时读取并应用 VOL 包络到音量
- [ ] SubTask 6.2: 在 playAll() 混音时读取并应用 PAN 包络到声像
- [ ] SubTask 6.3: 验证包络应用效果

## Task 7: 修复体验和细节问题
- [ ] SubTask 7.1: 修复时间轴缩放按钮功能
- [ ] SubTask 7.2: 优化歌手文件路径处理（使用 path.join）
- [ ] SubTask 7.3: 添加导出加载提示
- [ ] SubTask 7.4: 优化音符默认歌词

# Task Dependencies
- Task 2 depends on Task 1（Bug 修复优先）
- Task 3 depends on Task 1
- Task 4 can be done in parallel with Task 2
- Task 5 depends on Task 2, Task 3
- Task 6 depends on Task 1
- Task 7 can be done in parallel with any task
