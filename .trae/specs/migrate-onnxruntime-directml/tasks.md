# Tasks

- [x] Task 1: 验证 ONNX 模型输入输出规格
  - [x] SubTask 1.1: 编写模型检查脚本，逐一加载 onnx_models/ 下的所有 ONNX 模型，打印输入/输出名称、形状、数据类型
  - [x] SubTask 1.2: 验证 note_text_encoder、note_pitch_encoder、note_type_encoder、f0_encoder 的输入形状和嵌入维度
  - [x] SubTask 1.3: 验证 preflow、cond_emb、diff_step、vocoder 的输入输出规格
  - [x] SubTask 1.4: 验证 mel_transform 模型（用于参考音频梅尔频谱提取）的输入输出规格
  - [x] SubTask 1.5: 将验证结果记录，作为后续推理代码的参考

- [x] Task 2: 重写 SVS Pipeline 为 ONNX Runtime 版本
  - [x] SubTask 2.1: 创建 OnnxSVSPipeline 类，替换 NativeSVSPipeline，使用 onnxruntime-node
  - [x] SubTask 2.2: 实现 DirectML 优先 + CPU 回退的会话创建逻辑
  - [x] SubTask 2.3: 实现 Encoder 推理（note_text_encoder、note_pitch_encoder、note_type_encoder、f0_encoder 分别运行，拼接嵌入）
  - [x] SubTask 2.4: 实现 preflow 推理（嵌入拼接 → 预处理流）
  - [x] SubTask 2.5: 实现 cond_emb 推理（条件嵌入生成）
  - [x] SubTask 2.6: 实现 diff_step 循环推理（含 CFG 和 CFG Rescale）
  - [x] SubTask 2.7: 实现 vocoder 推理（梅尔频谱 → 音频波形，支持分块）
  - [x] SubTask 2.8: 实现参考音频 mel_transform 推理（提取参考梅尔频谱作为 prompt）
  - [x] SubTask 2.9: 保留所有辅助函数（parseWavBuffer、resampleLinear、extractMelSpectrogram、istftReconstruction 等）
  - [x] SubTask 2.10: 确保输入张量类型（int64/float32）和形状与 ONNX 模型规格完全对齐

- [x] Task 3: 更新主进程 IPC 和模型管理
  - [x] SubTask 3.1: 更新 main.js 中的 SVS Pipeline 初始化，使用 OnnxSVSPipeline 替换 NativeSVSPipeline
  - [x] SubTask 3.2: 更新模型路径从 executorch_models 到 onnx_models
  - [x] SubTask 3.3: 确保 IPC handler（svs:init、svs:synthesize、svs:dispose）正常工作
  - [x] SubTask 3.4: 确保 fragment-svs 相关 IPC handler 正常工作
  - [x] SubTask 3.5: 确保 RMVPE 和 Basic Pitch 的 IPC handler 不受影响

- [x] Task 4: 修复歌手预处理全链路
  - [x] SubTask 4.1: 验证 RMVPE F0 提取 → F0 曲线显示 → 数据保存链路
  - [x] SubTask 4.2: 验证 Basic Pitch 音符提取 → 钢琴卷帘显示 → 数据保存链路
  - [x] SubTask 4.3: 验证预处理数据保存到 .sxssinger 文件的完整性
  - [x] SubTask 4.4: 验证从 .sxssinger 文件加载歌手后 SVS 合成链路
  - [x] SubTask 4.5: 修复发现的任何链路断点或数据格式不匹配问题

- [x] Task 5: 清理旧依赖和文件
  - [x] SubTask 5.1: 从 package.json 移除 node-addon-api 依赖
  - [x] SubTask 5.2: 删除 native/ 目录（ExecuTorch C++ 插件代码）
  - [x] SubTask 5.3: 删除 executorch_models/ 目录（.pte 模型文件）
  - [x] SubTask 5.4: 删除根目录下的模型检查/诊断脚本（check_*.js、diagnose_*.js、test_*.js、inspect_*.js、fix_*.py 等）
  - [x] SubTask 5.5: 运行 npm install 确认依赖清理完成

- [x] Task 6: 端到端集成测试
  - [x] SubTask 6.1: 测试 RMVPE F0 提取功能（加载 WAV → 提取 F0 → 显示曲线）
  - [x] SubTask 6.2: 测试 Basic Pitch 音符提取功能（加载 WAV → 提取音符 → 显示钢琴卷帘）
  - [x] SubTask 6.3: 测试 SVS 合成功能（输入音符 → 合成音频 → 播放）
  - [x] SubTask 6.4: 测试歌手创建全流程（上传 WAV → 预处理 → 保存 → 加载 → 合成）
  - [x] SubTask 6.5: 测试分片编辑器合成和导出功能
  - [x] SubTask 6.6: 验证 DirectML GPU 加速是否生效（检查日志）

# Task Dependencies
- [Task 2] depends on [Task 1] (需要知道模型输入输出规格才能编写推理代码)
- [Task 3] depends on [Task 2] (需要新的推理类才能更新 main.js)
- [Task 4] depends on [Task 3] (需要 IPC handler 更新后才能测试全链路)
- [Task 5] depends on [Task 3, Task 4] (确认新架构工作后再清理旧依赖)
- [Task 6] depends on [Task 4, Task 5] (最终集成测试)
