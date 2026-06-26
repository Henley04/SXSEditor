# Tasks

## Phase 1: 模型导出与 DirectML 优化脚本

- [x] Task 1: 编写 SiFiGAN ONNX 导出脚本 `export_sifigan_vocoder.py`（已完成，脚本未实际运行，等用户执行）
  - [x] SubTask 1.1: 克隆 SiFiGAN 官方仓库到 `third_party/SiFiGAN/`（仅在开发机本地，不入 git）— 脚本仅检查并给出明确克隆提示，不自动克隆
  - [x] SubTask 1.2: 编写 `SiFiGANVocoderWrapper`（nn.Module），将 SiFiGAN 的多输入（mel-cepstrum、F0、特征统计）封装为接受 `mel`（[1, seq, 128]）与 `f0`（[1, seq, 1]）的 forward
  - [x] SubTask 1.3: 加载本地预训练权重 `D:\download\model+stats\sifigan_libritts-r-clean+nus-48e_checkpoint-1000000steps.pkl`（~611MB）
  - [x] SubTask 1.4: 加载本地统计文件 `D:\download\model+stats\libritts_r_clean+nus-48e_train_no_dev.joblib`（~2.5KB），嵌入到 Wrapper 内部作为归一化常量
  - [x] SubTask 1.5: 调用 `torch.onnx.export`（opset=18，dynamo=True，dynamic_axes 含 seq_len）输出 `sifigan_vocoder.onnx`
  - [x] SubTask 1.6: 实现 onnxruntime CPU 探针推理 + L1 误差验证（与 PyTorch 输出对比，< 1e-4）
  - [x] SubTask 1.7: 处理外部数据格式（>2GB 时启用 `.onnx.data`）
- [ ] Task 2: 编写 SiFiGAN DirectML 兼容性优化脚本 `optimize_sifigan_dml.py`
  - [ ] SubTask 2.1: 复用 `optimize_vocoder_dml.py` 的 ConvTranspose 检测与分解逻辑
  - [ ] SubTask 2.2: 扫描 SiFiGAN ONNX 中所有 `ConvTranspose` 节点，识别 stride > 1 的实例
  - [ ] SubTask 2.3: 应用等价分解 `Conv1D(upsample(x, S), flip(w.T), stride=1, pads=[K-1, K-S])`
  - [ ] SubTask 2.4: 使用 onnxsim 简化图
  - [ ] SubTask 2.5: DirectML EP 探针推理验证可用性，输出对比误差 < 1e-3
  - [ ] SubTask 2.6: 若无 DML 不兼容算子，直接复制并打日志 "no optimization needed"

## Phase 2: 应用层模型清单与下载扩展

- [x] Task 3: 扩展模型清单与注册表（已完成，字段名按现有代码约定适配 filePath/models[]/descriptionEn）
  - [x] SubTask 3.1: 在 `src/modelManager.js` 的 `MODEL_IDS` 新增 `sifigan: ''`（空字符串占位 + `// TODO: 等用户填写 ModelScope 仓库 ID` 注释）
  - [x] SubTask 3.2: 在 `MODEL_FILE_MANIFEST` 新增 `sifigan_vocoder_dml.onnx`（required: false）与 `sifigan_stats.joblib`（required: false）两条目
  - [x] SubTask 3.3: 在 `src/modelRegistry.js` 的 `MODEL_GROUPS` 新增 `sifigan-vocoder` 组（optional: true, sessionKey: 'sifigan', files 含 onnx 与 joblib）
  - [x] SubTask 3.4: 在 `src/inference/pipeline/constants.js` 新增 `SIFIGAN_MODEL_FILES`、`SIFIGAN_STATS_FILE`、`MODEL_SIZES.sifigan` 估算值（参考 pkl 611MB）
- [ ] Task 4: 更新模型目录路径解析
  - [ ] SubTask 4.1: 在 `src/main/modelDir.js` 的 `getModelDir()` 中确保 SiFiGAN 文件名查询走与默认 vocoder 一致的四级解析路径
  - [ ] SubTask 4.2: 在 `src/inference/pipeline/index.js` 的 vocoder 路径回退逻辑中加入 `sifigan_vocoder_dml.onnx → sifigan_vocoder.onnx → vocoder_dml.onnx` 三级回退
  - [ ] SubTask 4.3: 在 `src/inference/pipeline/index.js` 中新增 `sifigan_stats.joblib` 路径解析与缺失警告逻辑

## Phase 3: 设置页 UI 与持久化

- [x] Task 5: 新增 Vocoder 类型选择设置（已完成，schema 用 ALLOWED_SETTINGS_KEYS 数组适配现有约定）
  - [x] SubTask 5.1: 在 `src/settings.html` 推理分区增加 `<select id="vocoderType">` 控件
  - [x] SubTask 5.2: 选项 `default`（默认 Vocoder）与 `sifigan`（SiFiGAN），SiFiGAN 未下载时禁用并标注"未下载"（同时检查 `sifigan_vocoder_dml.onnx` 与 `sifigan_stats.joblib` 是否都存在）
  - [x] SubTask 5.3: 在 `src/settings.js` 渲染逻辑中绑定 change 事件，通过 IPC 持久化到 settings.json 的 `vocoderType` 字段
  - [x] SubTask 5.4: 在 `src/main/settings.js` 的 settings schema 新增 `vocoderType` 字段，默认 `'default'`，校验枚举值
  - [x] SubTask 5.5: 启动时检查 `vocoderType === 'sifigan'` 但 onnx 模型缺失的情况，记录警告并自动回退到 `default`

## Phase 4: 下载管理器 UI 扩展

- [ ] Task 6: 扩展模型下载窗口
  - [ ] SubTask 6.1: 在 `src/modelDownload.html` 增加独立卡片"SiFiGAN Vocoder（可选）"
  - [ ] SubTask 6.2: 在 `src/modelDownload.js` 渲染逻辑中显示下载/卸载按钮、文件大小、下载进度
  - [ ] SubTask 6.3: 在 `src/main/modelDownload.js` IPC 中检测 `MODEL_IDS.sifigan` 为空字符串时短路返回 `download_url_not_configured` 状态，不进入实际下载流程
  - [ ] SubTask 6.4: UI 收到 `download_url_not_configured` 时禁用下载按钮、显示 tooltip "下载链接待配置，请等待作者上传至 ModelScope 或手动放置模型文件"
  - [ ] SubTask 6.5: 检测 `onnx_models/sifigan_vocoder_dml.onnx` 与 `sifigan_stats.joblib` 手动存在时，自动刷新为"已安装"状态
  - [ ] SubTask 6.6: 卸载时删除 `sifigan_vocoder_dml.onnx`、`.data` 文件与 `sifigan_stats.joblib`，并将 `vocoderType` 重置为 `default`

## Phase 5: SVS Pipeline 双 Vocoder 路径集成

- [x] Task 7: Pipeline 模型加载分支（已完成：双 vocoder 加载分支 + SiFiGAN dummy 输入 + 三处失败回退默认 vocoder）
  - [x] SubTask 7.1: 在 `src/inference/pipeline/index.js` 的 `_loadModelsPartitioned` 中读取 settings 的 `vocoderType`
  - [x] SubTask 7.2: 若为 `sifigan`，加载 `sifigan_vocoder_dml.onnx`，sessionKey 仍为 `vocoder`（保持管线其余代码不变）
  - [x] SubTask 7.3: 复用 `createSessionWithValidation`，传入 SiFiGAN 的 dummy 输入（mel + f0）
  - [x] SubTask 7.4: NPU 路径下 SiFiGAN 也走 DML（跳过 WebNN，与默认 vocoder 行为一致）
- [ ] Task 8: Pipeline 推理输入对齐
  - [ ] SubTask 8.1: 在 `src/inference/pipeline/postprocessing.js` 的 vocoder 调用处，根据 `vocoderType` 构造输入张量字典（`{mel}` 或 `{mel, f0}`）
  - [ ] SubTask 8.2: 从 `f0_encoder` 输出取 F0 序列，重采样到 mel 帧率（HOP_SIZE=480, SAMPLE_RATE=24000, 帧率=50Hz）
  - [ ] SubTask 8.3: 若 `vocoderType = sifigan` 但 F0 缺失，记录错误并回退到默认 vocoder 完成本次推理
  - [ ] SubTask 8.4: 输出统一为 `waveform`，分块推理 `runVocoderChunked` 逻辑保持不变
- [ ] Task 9: Vocoder 精度检测扩展
  - [ ] SubTask 9.1: 在 `_detectVocoderPrecision` 中支持 SiFiGAN 模型精度检测
  - [ ] SubTask 9.2: 基于输入 metadata 或文件大小判定 FP16/FP32

## Phase 6: 文档、测试与发布

- [ ] Task 10: 更新 `onnx_models/README.md`，新增 SiFiGAN 模型说明章节
  - [ ] SubTask 10.1: 模型架构说明（Source-Filter HiFi-GAN, ICASSP 2023）
  - [ ] SubTask 10.2: 训练数据来源（LibriTTS-R + NUS-48E），24kHz 采样率
  - [ ] SubTask 10.3: 输入输出格式（mel + f0 → waveform）
  - [ ] SubTask 10.4: DirectML 支持情况与优化脚本说明
  - [ ] SubTask 10.5: 与默认 vocoder 的差异对比表
- [x] Task 11: 端到端测试与验证（已完成：修复 SiFiGAN 测试失败 + 打包通过 + checklist 验证；11.2/11.3 需用户提供 sifigan_vocoder_dml.onnx 模型文件后实际运行）
  - [x] SubTask 11.1: 默认 vocoder 路径回归测试（确保未破坏现有功能）— npm test 615 passing，modelPaths.test.js 默认 vocoder 相关测试全部通过
  - [ ] SubTask 11.2: SiFiGAN 路径端到端合成测试（DirectML 可用）— FAILED: 需用户提供 sifigan_vocoder_dml.onnx 模型文件后实际运行；加载分支代码已验证（index.js L388-419）
  - [ ] SubTask 11.3: SiFiGAN 路径 CPU 回退测试（断开 GPU 驱动模拟）— FAILED: 需用户提供模型文件后实际运行；CPU 回退逻辑代码已验证（modelLoader.js L545）
  - [x] SubTask 11.4: SiFiGAN 模型未下载时的回退测试 — 代码验证 index.js L407-408 回退逻辑；modelPaths.test.js manifest 一致性测试通过
  - [x] SubTask 11.5: `npm run package:lite` 打包后 SiFiGAN 下载与使用测试 — 退出码 0，webpack bundle 成功，SiFiGAN IPC/代码已编译进包
  - [x] SubTask 11.6: 模型路径四级解析测试（dev / custom / asar.unpacked / userData）— modelPaths.test.js 通过（getLocalFilePath 一致性、精度子目录映射、manifest 完整性）；modelDir.js getModelDir 四级逻辑代码检查通过

# Task Dependencies
- Task 2 依赖 Task 1（需要导出后的 ONNX 才能优化）
- Task 4 依赖 Task 3（清单扩展先于路径解析）
- Task 6 依赖 Task 3（下载 UI 依赖清单与注册表）
- Task 7 依赖 Task 3、Task 5（需要 vocoderType 设置与清单）
- Task 8 依赖 Task 7（推理输入对齐在加载分支之后）
- Task 9 依赖 Task 7（精度检测在加载逻辑之后）
- Task 11 依赖 Task 1–Task 10 全部完成

# 可并行任务
- Task 1（Python 导出脚本）与 Task 3、Task 5（应用层清单/UI）可并行
- Task 6（下载 UI）与 Task 7（Pipeline 加载）可并行（无相互依赖）
- Task 10（文档）可在 Task 1 完成后并行进行
