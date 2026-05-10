# Tasks

- [x] Task 1: 修复 `_runEncoder` 操作顺序
  - [x] SubTask 1.1: 将 preflow 调用移到帧扩展之前：先对 tokenEmb [tokenCount, 512] 运行 preflow，得到 processedTokenEmb [tokenCount, 512]
  - [x] SubTask 1.2: 将帧扩展（expand）移到 preflow 之后：使用 mel2token 将 processedTokenEmb 扩展到 [totalFrames, 512]
  - [x] SubTask 1.3: 将 F0 嵌入相加移到帧扩展之后：expandedEmb + f0Emb → combinedFeatures [totalFrames, 512]
  - [x] SubTask 1.4: 将 combinedFeatures 传入 cond_emb 得到最终条件向量 [totalFrames, 1024]
  - [x] SubTask 1.5: 验证修改后的维度流：tokenEmb[1,N,512] → preflow[1,N,512] → expand[1,F,512] → +f0[1,F,512] → cond_emb[1,F,1024]

- [x] Task 2: 实现基于时序的 mel2token 映射
  - [x] SubTask 2.1: 在 `notesToSequences` 中新增 `_buildMel2token` 方法，基于音符起止拍时间计算每帧对应的令牌索引
  - [x] SubTask 2.2: 对每个帧，根据时间定位所属音符，再在音符的令牌范围（BOW/音素/EOW）内按比例分配
  - [x] SubTask 2.3: 无音符覆盖的帧映射到 PAD 令牌（索引 0）
  - [x] SubTask 2.4: 将 `notesToSequences` 返回值中的 `mel2note` 替换为 `mel2token`
  - [x] SubTask 2.5: 删除旧的 `_expandMel2note` 方法

- [x] Task 3: 修复 prompt 条件构造
  - [x] SubTask 3.1: 在 `synthesize` 方法中，将 prompt 部分条件从 `condInput[(f % totalFrames)]` 循环填充改为零填充
  - [x] SubTask 3.2: 验证零 prompt 条件下扩散循环仍能正常运行

- [x] Task 4: 更新测试
  - [x] SubTask 4.1: 更新 `nativeSvsPipeline.test.js` 中 `notesToSequences` 相关测试，适配 `mel2token` 返回值
  - [x] SubTask 4.2: 新增 `_buildMel2token` 单元测试，验证时序映射正确性
  - [x] SubTask 4.3: 运行全部测试确认通过

# Task Dependencies
- [Task 2] depends on [Task 1] (mel2token 映射需要在 _runEncoder 中使用)
- [Task 3] can be done in parallel with [Task 2]
- [Task 4] depends on [Task 1, Task 2, Task 3]
