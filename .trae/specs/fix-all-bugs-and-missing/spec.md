# 修复全部 Bug 和未实现功能 Spec

## Why
代码审计发现 SXSEditor 存在多个关键 bug 和未实现功能，包括主窗口缺少钢琴卷帘、时间显示计算错误、包络编辑器未复用、歌手创建页面缺失等，需要全面修复以达到可用状态。

## What Changes
- 修复 `pipeline.init()` 未 await 的关键问题
- 修复时间显示毫秒计算错误（×100 → ×1000）
- 修复包络关键帧拖动时索引错位
- 实现主窗口钢琴卷帘编辑功能（复用 PianoRoll 类）
- 复用 EnvelopeEditor 类消除重复代码
- 实现歌手创建页面
- 修复时间轴缩放按钮无效
- 实现 Fragment 编辑器歌词编辑功能
- 实现 Fragment 包络交互功能
- 将 VOL/PAN 包络应用到混音
- 优化右键菜单体验（使用右键菜单而非双对话框）
- 修复歌手文件路径处理

## Impact
- Affected specs: create-svs-editor, complete-first-release
- Affected code: renderer.js, fragmentEditor.js, index.html, fragmentEditor.html, envelopeEditor.js, pianoRoll.js

## ADDED Requirements
### Requirement: 主窗口钢琴卷帘
系统应在主窗口右侧显示可交互的钢琴卷帘，支持音符创建、移动、调整时长、删除、歌词编辑。

#### Scenario: 用户创建音符
- **WHEN** 用户在钢琴卷帘空白区域点击并拖拽
- **THEN** 创建对应时长和音高的音符

#### Scenario: 用户编辑歌词
- **WHEN** 用户双击音符
- **THEN** 弹出歌词编辑对话框

### Requirement: 歌手创建页面
系统应提供歌手创建功能，允许用户选择 ONNX 模型文件夹并注册歌手。

#### Scenario: 创建新歌手
- **WHEN** 用户点击添加歌手
- **THEN** 弹出文件夹选择对话框，选择后注册歌手到下拉列表

### Requirement: 歌词编辑
Fragment 编辑器应支持双击音符编辑歌词。

#### Scenario: 编辑歌词
- **WHEN** 用户双击 Fragment 编辑器中的音符
- **THEN** 弹出编辑对话框，允许修改歌词

### Requirement: Fragment 包络交互
Fragment 编辑器中的 F0 包络应支持关键帧添加、拖拽、编辑、删除。

## MODIFIED Requirements
### Requirement: 播放时间显示
时间显示应正确显示 MM:SS:ms 格式，毫秒部分应 ×1000 计算。

### Requirement: 包络关键帧拖动
关键帧拖动时应正确跟踪对应的包络索引，不发生错位。

### Requirement: 混音系统
混音时应应用 VOL/PAN 包络到各轨道音量平衡。

## REMOVED Requirements
### Requirement: 重复的包络编辑实现
**Reason**: EnvelopeEditor 类已存在但未使用，主代码中有重复实现
**Migration**: 统一使用 EnvelopeEditor 类
