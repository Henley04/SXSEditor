# Complete SXSEditor First Release Spec

## Why
SXSEditor 已有大量骨架代码，但核心功能（播放、推理、导出）均标记为"待实现"。需要基于 SoulX-Singer ONNX 模型架构和论文描述，补全所有功能，打造第一个可完整使用的版本。

## What Changes
- **播放系统**：使用 Web Audio API 实现真实音频播放、暂停、停止，播放头动画
- **SVS 推理管线修复**：根据 SoulX-Singer 论文（Flow Matching + note-level alignment），修正输入张量构建、推理流程、张量对齐
- **GPU 加速推理**：onnxruntime-web 使用 WebGPU 后端，推理过程完全异步，不阻塞 UI
- **音频预览播放**：合成音频后实时预览试听
- **WAV 导出功能**：将合成音频导出为 24kHz 32-bit float WAV
- **分片编辑器播放/导出**：在分片编辑窗口集成播放和导出按钮
- **钢琴卷帘交互**：完善主窗口钢琴卷帘（目前仅有 fragment timeline）
- **包络编辑器集成**：在分片编辑器中连接 EnvelopeEditor 组件
- **F0 包络编辑**：在分片编辑器和主窗口均支持 F0 包络曲线编辑
- **歌手面板包络编辑**：按照 singer-panel-design.md 实现 VOL/PAN 包络编辑
- **工程文件格式**：工程文件使用 *.sxsproj 扩展名（非 .sxs/.json）

## Impact
- **Affected specs**: create-svs-editor (延续并补全所有未完成任务)
- **Affected code**:
  - `src/renderer.js` - 主窗口播放、推理、导出
  - `src/fragmentEditor.js` - 分片编辑器播放/导出
  - `src/inference/svsPipeline.js` - 推理管线修复
  - `src/audio/wavEncoder.js` - WAV 编码（已有，待集成）
  - `src/index.html` - 主窗口 HTML 结构
  - `src/fragmentEditor.html` - 分片编辑器 HTML

## ADDED Requirements

### Requirement: 播放控制（主窗口）
The system SHALL provide full playback control using Web Audio API.

#### Scenario: 播放合成音频
- **WHEN** 用户点击播放按钮
- **THEN** 收集所有分片的音符数据
- **AND** 通过 SVS 推理管线合成音频
- **AND** 使用 AudioBufferSourceNode 播放
- **AND** 播放头随播放进度移动
- **AND** 时间显示实时更新

#### Scenario: 暂停/停止
- **WHEN** 用户点击暂停
- **THEN** 暂停当前播放并记录位置
- **WHEN** 用户点击停止
- **THEN** 停止播放并回到起始位置

### Requirement: SVS 推理管线
The system SHALL correctly execute the SoulX-Singer inference pipeline.

#### Scenario: 音符到音频合成
- **WHEN** 用户提供音符序列和 BPM
- **THEN** 构建正确的模型输入张量（note_text, note_pitch, note_type, f0）
- **AND** 按顺序执行：encoders → preflow → cond_emb → diffusion → vocoder
- **AND** 输出 24kHz Float32 音频波形

#### Scenario: 参考音频克隆（零样本）
- **WHEN** 歌手包含参考 WAV 文件
- **THEN** 使用参考音频提取音色条件嵌入
- **AND** 在合成时应用该音色条件

### Requirement: 音频导出
The system SHALL export synthesized audio to WAV file.

#### Scenario: 导出 WAV 文件
- **WHEN** 用户点击导出按钮
- **THEN** 弹出保存对话框
- **AND** 合成完整音频并编码为 WAV（24kHz, 32-bit float）
- **AND** 保存到用户指定路径

### Requirement: 分片编辑器增强
The fragment editor SHALL provide playback and export buttons.

#### Scenario: 分片内播放
- **WHEN** 用户在分片编辑器中点击播放
- **THEN** 合成当前分片音频并播放

#### Scenario: 分片内导出
- **WHEN** 用户点击导出
- **THEN** 导出当前分片合成音频为 WAV

### Requirement: F0 包络编辑
The system SHALL provide F0 envelope editing in both the main window and fragment editor.

#### Scenario: 切换 F0 编辑模式
- **WHEN** 用户点击 F0 模式按钮
- **THEN** 参数曲线区域切换到 F0 编辑模式（范围 -12 到 +12 半音）

#### Scenario: 编辑 F0 关键帧
- **WHEN** 用户在 F0 曲线区域操作
- **THEN** 支持添加、拖拽、编辑、删除 F0 关键帧
- **AND** F0 值影响合成时的音高偏移

### Requirement: 工程文件格式
The system SHALL use *.sxsproj as the project file extension.

#### Scenario: 保存工程
- **WHEN** 用户点击保存
- **THEN** 文件对话框默认扩展名为 .sxsproj

#### Scenario: 加载工程
- **WHEN** 用户打开工程
- **THEN** 文件过滤器仅显示 .sxsproj 文件

### Requirement: GPU 加速推理
The system SHALL utilize GPU acceleration for inference.

#### Scenario: GPU 加速
- **WHEN** 系统初始化 ONNX Runtime
- **THEN** 优先使用 WebGPU 后端进行推理
- **AND** 若 WebGPU 不可用则回退到 CPU
- **AND** 推理过程完全异步，不阻塞 UI 线程
- **AND** 合成进度通过回调实时更新

## MODIFIED Requirements

### Requirement: 主窗口 HTML 结构
修改 `src/index.html`，将现有的 fragment timeline 视图与钢琴卷帘视图整合。主窗口应显示：
- 左侧：歌手/轨道面板（已有）
- 右侧上方：分片时间轴（已有）
- 右侧下方：钢琴卷帘编辑区（新增，初始隐藏，双击分片时显示或打开分片编辑器）

### Requirement: 推理管线输入构建
根据 SoulX-Singer 论文，模型采用 note-level 对齐机制，将歌声合成建模为 audio infilling 任务。推理流程：
1. **note_text_encoder**: 歌词文本 → 文本嵌入
2. **note_pitch_encoder**: MIDI 音高 → 音高嵌入  
3. **note_type_encoder**: 音符类型（note/rest）→ 类型嵌入
4. **f0_encoder**: F0 轮廓 → F0 嵌入（基于音符时长构建帧级 F0）
5. **preflow**: 拼接所有嵌入 → 预处理流
6. **cond_emb**: 预处理流 → 条件嵌入
7. **diffusion** (diff_step × N): 条件嵌入 + 噪声 → 梅尔频谱
8. **vocoder**: 梅尔频谱 → 音频波形

关键修正：
- F0 需要帧级序列（每个 hop_size 一帧），而非音符级
- note 级别的 embedding 需要正确插值到 frame 级别（按音符时长比例分配帧数）
- 扩散步骤需要正确的 t 值范围和更新公式

## REMOVED Requirements
无