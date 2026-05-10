# 验证清单

## 模型验证

* [x] 所有 SVS ONNX 模型可被 onnxruntime-node 成功加载

* [x] 每个 ONNX 模型的输入名称、形状、数据类型已验证并记录

* [x] 每个 ONNX 模型的输出名称、形状、数据类型已验证并记录

* [x] mel\_transform 模型输入输出规格已验证

## SVS Pipeline ONNX 迁移

* [x] OnnxSVSPipeline 类可成功初始化，加载所有 9 个 ONNX 模型（含 CPU 回退会话）

* [x] DirectML 执行提供程序优先使用，CPU 回退正常工作

* [x] Encoder 推理（4 个编码器分别运行）输出形状正确

* [x] Preflow 推理输入拼接正确，输出形状正确

* [x] Cond\_emb 推理输入输出形状正确

* [x] Diff\_step 循环推理含 CFG 和 CFG Rescale 逻辑正确

* [x] Vocoder 推理输出音频波形，分块推理正常

* [x] 参考音频 mel\_transform 推理正常，prompt 条件拼接正确

* [x] 合成音频采样率为 24000Hz，音频质量可用

* [x] 输入张量类型（int64/float32）和形状与 ONNX 模型规格完全对齐

* [x] diff\_step 和 vocoder DirectML 推理失败时自动回退到 CPU

## 主进程 IPC

* [x] svs:init IPC handler 使用 OnnxSVSPipeline 初始化成功

* [x] svs:synthesize IPC handler 合成音频正常返回

* [x] svs:dispose IPC handler 正常释放资源

* [x] fragment-svs:init/synthesize IPC handler 正常工作

* [x] 模型路径已更新为 onnx\_models/

* [x] RMVPE 和 Basic Pitch 的 IPC handler 不受影响

## 歌手预处理全链路

* [x] RMVPE F0 提取 → F0 曲线显示在钢琴卷帘 → 数据保存到 singerData

* [x] Basic Pitch 音符提取 → 音符显示在钢琴卷帘 → F0 曲线显示 → 数据保存

* [x] 预处理数据保存到 .sxssinger 文件完整（含 f0、midiNotes、phoneme、singerData 等）

* [x] 从 .sxssinger 文件加载歌手后可正常 SVS 合成

* [x] 参考音频条件正确传递到 SVS Pipeline

* [x] preload.js 暴露 onPreprocessDataSaved 监听器

* [x] .sxssinger 文件保存 singerData 字段

* [x] renderer.js 加载 singerData 到歌手对象

* [x] RMVPE/Basic Pitch 返回的 notes 包含 lyric 字段

* [x] singerCreated 事件传递完整预处理数据

* [x] SVS 合成使用歌手的预处理 F0 数据

## 依赖清理

* [x] package.json 中 node-addon-api 已移除

* [x] @tensorflow/tfjs 依赖保留（Basic Pitch 仍使用）

* [x] native/ 目录已删除

* [x] executorch\_models/ 目录已删除

* [x] 根目录下的临时检查/诊断脚本已清理（25个文件）

* [x] npm install 成功，无依赖冲突

* [x] build:native 和 rebuild:native 脚本已移除

## 端到端测试

* [x] 应用编译启动成功（electron-forge start）

* [x] 所有 9 个 ONNX 模型加载成功（DirectML）

* [x] diff\_step CPU 回退会话准备成功

* [x] vocoder CPU 回退会话准备成功

* [x] RMVPE 模型加载成功（DirectML/GPU）

* [x] Basic Pitch 模型加载成功

* [x] SVS 合成编码器推理成功（输出 \[1, 43, 1024]）

* [x] 参考音频 mel 提取成功（851帧）

* [x] diff\_step DirectML→CPU 回退机制工作正常

* [x] src/ 目录无 executorch 残留引用

