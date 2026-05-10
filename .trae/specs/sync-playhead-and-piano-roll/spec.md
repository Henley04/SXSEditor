# 同步播放头与增强钢琴卷帘 Spec

## Why
音频预处理页面中，WAV波形和MIDI编辑器的播放头位置没有完全同步，MIDI编辑器功能较简单，缺少歌词编辑能力。RMVPE音高线在滚轮滑动时存在渲染异常，Basic Pitch和RMVPE模型功能描述混乱。需要统一播放头同步机制，增强钢琴卷帘功能，明确模型用途，参考分片编辑器的实现。

## What Changes
- 统一上下两个播放线的同步机制，确保位置完全一致
- 修复RMVPE音高线在滚轮滑动时的渲染异常
- 解决Basic Pitch和RMVPE数据冲突，允许同时显示
- 明确两个模型的用途：RMVPE用于F0基频提取，Basic Pitch用于MIDI音符提取
- 增强MIDI编辑器钢琴卷帘，参考fragmentEditor的完整实现
- 添加音符歌词编辑功能，支持双击编辑文字
- 完善音符与音频时间的映射关系

## Impact
- Affected specs: 音频预处理功能，MIDI编辑功能，音高检测功能
- Affected code: 
  - `src/audioPreprocess.js` - 主要修改文件，同步播放头、修复渲染异常、增强钢琴卷帘
  - `src/audioPreprocess.html` - 可能需要微调布局
  - `src/audioPreprocess.css` - 可能需要微调样式
  - `src/editor/pianoRoll.js` - 参考实现
  - `src/fragmentEditor.js` - 参考实现

## ADDED Requirements

### Requirement: 播放头同步
系统 SHALL 确保音频波形和MIDI编辑器的播放头位置始终保持同步。

#### Scenario: 播放音频时
- **WHEN** 用户点击播放按钮播放音频
- **THEN** WAV波形和MIDI编辑器的红色播放线应该在同一时间位置同步移动

#### Scenario: 点击波形跳转时间
- **WHEN** 用户点击WAV波形跳转到特定时间
- **THEN** MIDI编辑器的播放头也应该同步跳转到对应位置

### Requirement: MIDI钢琴卷帘增强
系统 SHALL 提供完整的钢琴卷帘功能，参考fragmentEditor的实现。

#### Scenario: 显示钢琴键
- **WHEN** MIDI编辑器渲染
- **THEN** 左侧应该显示钢琴键，白键显示音名，黑键深色背景

#### Scenario: 网格显示
- **WHEN** MIDI编辑器渲染
- **THEN** 应该显示小节线和拍线，小节编号标注在顶部

#### Scenario: 音符编辑
- **WHEN** 用户点击空白区域
- **THEN** 应该创建新的音符块，支持拖拽移动和调整时长

### Requirement: 音符歌词编辑
系统 SHALL 支持双击音符编辑歌词文字。

#### Scenario: 双击编辑歌词
- **WHEN** 用户双击MIDI编辑器中的音符
- **THEN** 弹出输入框，允许用户编辑该音符的歌词

#### Scenario: 歌词显示
- **WHEN** 音符宽度足够
- **THEN** 音符块内应该显示歌词文字

### Requirement: 数据格式兼容
系统 SHALL 保持与singer数据格式的兼容性。

#### Scenario: 保存数据
- **WHEN** 用户保存预处理数据
- **THEN** notes数组中的每个音符应包含lyric字段，与singerCreator中的text/phoneme字段对应

### Requirement: 模型用途明确
系统 SHALL 明确区分RMVPE和Basic Pitch模型的用途。

#### Scenario: RMVPE模型
- **WHEN** 用户点击"RMVPE获取F0和音高"按钮
- **THEN** 系统使用RMVPE模型提取F0基频数据，并在MIDI编辑器中显示音高曲线

#### Scenario: Basic Pitch模型
- **WHEN** 用户点击"Basic Pitch获取MIDI"按钮
- **THEN** 系统使用Basic Pitch模型提取MIDI音符数据，并在MIDI编辑器中显示音符块

#### Scenario: 模型数据共存
- **WHEN** 用户先后使用RMVPE和Basic Pitch提取数据
- **THEN** 两个模型的数据应该可以同时显示，不产生冲突

## MODIFIED Requirements

### Requirement: 播放控制
播放控制 SHALL 统一使用同一时间源，通过共享的currentTime变量同步上下两个区域。

### Requirement: 钢琴卷帘渲染
钢琴卷帘渲染 SHALL 使用统一的时间到像素坐标转换函数，确保与波形区域的缩放和滚动同步。RMVPE音高线在缩放和滚动时应保持正确的坐标映射，不再出现"抽风"现象。

### Requirement: F0曲线显示
F0曲线显示 SHALL 与音符编辑独立，RMVPE提取的F0数据应以曲线形式叠加在钢琴卷帘上，与Basic Pitch提取的音符块可以同时存在。

## REMOVED Requirements
无
