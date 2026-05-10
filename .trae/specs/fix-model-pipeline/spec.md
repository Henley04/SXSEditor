# 修复 SVS 模型推理全链路 Spec

## Why
SVS 模型输出音频不正常，经全链路审查发现 `_runEncoder` 中操作顺序与原始 PyTorch 模型架构严重不符，帧-令牌映射存在索引类型混淆，导致模型条件编码完全错误，合成结果异常。

## What Changes
- **修复 `_runEncoder` 操作顺序**：将 preflow 移到帧扩展之前，F0 嵌入加到帧扩展之后，与原始 SoulX-Singer 架构一致
- **修复帧-令牌映射**：当前 `mel2note` 存储的是音符索引却被当作令牌索引使用，需改为正确的帧-令牌映射 (`mel2token`)
- **改用基于时序的 mel2token 映射**：替换线性插值映射为基于音符起止时间的精确映射
- **修复 prompt 条件构造**：不再用目标条件循环填充 prompt 条件，改为用零条件或从参考音频 F0 构造简化 prompt 条件

## Impact
- Affected specs: 无其他 spec 受影响
- Affected code: `src/inference/nativeSvsPipeline.js` 的 `_runEncoder`、`notesToSequences`、`_expandMel2note`、`synthesize` 方法

## ADDED Requirements

### Requirement: Encoder 操作顺序必须与原始模型一致
系统 SHALL 按 `嵌入求和 → preflow → 帧扩展 → +F0嵌入 → cond_emb` 的顺序执行编码器推理。

#### Scenario: 正确的编码器流程
- **WHEN** 调用 `_runEncoder` 进行编码器推理
- **THEN** 执行顺序为：
  1. text_emb + pitch_emb + type_emb → tokenEmb [tokenCount, 512]
  2. preflow(tokenEmb) → processedTokenEmb [tokenCount, 512]
  3. expand(processedTokenEmb, mel2token) → expandedEmb [totalFrames, 512]
  4. expandedEmb + f0Emb → combinedFeatures [totalFrames, 512]
  5. cond_emb(combinedFeatures) → cond [totalFrames, 1024]

### Requirement: 帧-令牌映射必须使用令牌索引
系统 SHALL 使用 `mel2token`（帧到令牌的映射）进行帧扩展，而非 `mel2note`（帧到音符的映射）。

#### Scenario: 帧扩展使用令牌索引
- **WHEN** 将令牌级特征扩展到帧级
- **THEN** 每个帧映射到一个令牌索引，使用该索引从令牌嵌入数组中取值
- **AND** 映射基于音符的起止时间精确计算，而非线性插值近似

### Requirement: mel2token 映射基于音符时序
系统 SHALL 根据每个音符的起止拍时间计算帧到令牌的映射。

#### Scenario: 时序映射
- **WHEN** 计算 mel2token 映射
- **THEN** 对每个帧，根据其时间位置确定所属音符
- **AND** 在音符的令牌范围（BOW, 音素, EOW）内按比例分配帧到具体令牌
- **AND** 无音符覆盖的帧映射到 PAD 令牌（索引 0）

### Requirement: Prompt 条件不使用目标条件循环填充
系统 SHALL 为 prompt 部分构造独立的条件向量。

#### Scenario: 零 prompt 条件
- **WHEN** 没有参考音频的元数据（音符序列、F0 等）
- **THEN** prompt 部分的条件向量使用零填充
- **AND** 不再使用 `condInput[(f % totalFrames)]` 循环填充

## MODIFIED Requirements

### Requirement: _runEncoder 方法
原方法中 preflow 在帧扩展和 F0 相加之后执行，需改为在帧扩展之前执行。原方法使用 `mel2note`（音符索引）进行帧扩展，需改为使用 `mel2token`（令牌索引）。

### Requirement: notesToSequences 方法
原方法返回 `mel2note`（帧到音符索引映射），需改为返回 `mel2token`（帧到令牌索引映射），基于音符时序精确计算。

### Requirement: synthesize 方法中 prompt 条件构造
原方法使用 `condInput[(f % totalFrames)]` 循环填充 prompt 条件，需改为零填充。

## REMOVED Requirements
无移除的需求。
