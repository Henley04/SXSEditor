# SXSEditor SVS 编辑器 Spec

## Why
用户需要一个仿 OpenUTAU 界面的简单歌声合成编辑器（SVS），使用本地 ONNX 模型进行歌声合成推理，并支持 GPU 加速。

## What Changes
- 新增主窗口布局：左侧歌手/轨道面板 + 右侧钢琴卷帘/时间轴编辑区
- 新增钢琴卷帘（Piano Roll）音符编辑功能
- 新增轨道（Track）管理系统
- 新增基于 SoulX-Singer ONNX 模型的 SVS 推理管线
- 新增 GPU 加速推理支持（onnxruntime-web WebGPU / CUDA）
- 新增音频导出（WAV）功能
- 新增工程文件（JSON 格式）保存/加载

## Impact
- Affected code: `src/main.js`, `src/preload.js`, `src/renderer.js`, `src/index.html`, `src/index.css`
- Affected assets: `onnx_models/` 下的 SVS 模型
- New modules: `src/editor/`, `src/inference/`

## ADDED Requirements

### Requirement: 主窗口布局
The system SHALL provide a main window layout similar to OpenUTAU.

#### Scenario: 启动应用
- **WHEN** 用户启动 SXSEditor
- **THEN** 窗口显示左侧轨道列表面板 + 右侧钢琴卷帘编辑区
- **AND** 顶部显示工具栏（播放/暂停/停止、时间显示、BPM、拍号）

### Requirement: 钢琴卷帘编辑
The system SHALL provide a piano roll for note editing.

#### Scenario: 添加音符
- **WHEN** 用户在钢琴卷帘上点击或拖拽
- **THEN** 在对应音高和时间位置创建音符块

#### Scenario: 编辑音符
- **WHEN** 用户双击音符
- **THEN** 可编辑歌词/音素
- **WHEN** 用户拖拽音符边缘
- **THEN** 可调整音符时长
- **WHEN** 用户拖拽音符主体
- **THEN** 可移动音符位置

#### Scenario: 删除音符
- **WHEN** 用户选中音符并按 Delete 键
- **THEN** 音符被删除

### Requirement: 轨道管理
The system SHALL support multiple tracks.

#### Scenario: 添加轨道
- **WHEN** 用户点击左侧 "+" 按钮
- **THEN** 新增一条空轨道

#### Scenario: 选择歌手
- **WHEN** 用户在轨道面板选择歌手
- **THEN** 该轨道使用对应的 ONNX 模型进行推理

### Requirement: SVS 推理
The system SHALL synthesize singing voice from note sequences using ONNX models.

#### Scenario: 播放/导出
- **WHEN** 用户点击播放或导出
- **THEN** 系统将音符序列转换为模型输入（note_text, note_pitch, note_type, f0）
- **AND** 依次执行：note encoders → preflow → cond_emb → diff_step（多步）→ vocoder
- **AND** 输出音频波形

#### Scenario: GPU 加速
- **WHEN** 系统初始化 ONNX Runtime
- **THEN** 优先使用 WebGPU/CUDA 后端进行推理
- **AND** 若 GPU 不可用则回退到 CPU

### Requirement: 音频导出
The system SHALL export synthesized audio to WAV file.

#### Scenario: 导出 WAV
- **WHEN** 用户点击导出按钮
- **THEN** 弹出保存对话框
- **AND** 将合成音频保存为 WAV 格式（24kHz, 32-bit float）

### Requirement: 工程文件
The system SHALL support project save/load.

#### Scenario: 保存工程
- **WHEN** 用户点击保存
- **THEN** 将音符、轨道、BPM、拍号等信息保存为 JSON

#### Scenario: 加载工程
- **WHEN** 用户打开工程文件
- **THEN** 恢复编辑状态

## MODIFIED Requirements
无

## REMOVED Requirements
无
