# Tasks

## Phase 0: 下载与依赖准备（用户手动执行）

- [ ] Task 0: 下载/克隆所需资源到开发机本地
  - [ ] SubTask 0.1: 克隆 NVIDIA/BigVGAN 仓库到 `third_party/BigVGAN/`（不入 git）
  - [ ] SubTask 0.2: 从 HuggingFace 下载 `nvidia/bigvgan_v2_44khz_128band_512x` 的 `config.json` 与 `bigvgan_generator.pt`（~487MB），放置于 `D:\download\bigvgan_v2_44khz_128band_512x\`
  - [ ] SubTask 0.3: 创建 conda 环境 `bigvgan`（Python 3.10 + PyTorch 2.3.1 + CUDA 12.1），安装 `third_party/BigVGAN/requirements.txt` + `onnx onnxsim onnxruntime`
  - [ ] SubTask 0.4: 验证克隆与下载完整性（`third_party/BigVGAN/bigvgan.py` 存在、`bigvgan_generator.pt` 可被 `torch.load` 加载）

## Phase 1: ONNX 导出与 DirectML 优化脚本

- [ ] Task 1: 编写 BigVGAN v2 ONNX 导出脚本 `export_bigvgan_vocoder.py`
  - [ ] SubTask 1.1: 实现 `check_repo()`：检查 `third_party/BigVGAN/` 存在性，缺失时打印克隆命令并退出
  - [ ] SubTask 1.2: 实现 `load_bigvgan_generator()`：读取 `config.json` → 实例化 `BigVGAN(h)` → 加载 `bigvgan_generator.pt` → `remove_weight_norm()` + `eval()`
  - [ ] SubTask 1.3: 实现 `BigVGANVocoderWrapper(nn.Module)`：forward 接受 `mel`（[1, seq, 128]）→ 转置为 [1, 128, seq]（BigVGAN 期望 [B, C_mel, T_frame]）→ 调用 generator → 输出 [1, num_samples]
  - [ ] SubTask 1.4: 调用 `torch.onnx.export`（opset=18，dynamic_axes 含 seq_len 与 num_samples，input_names=['mel'], output_names=['waveform']）
  - [ ] SubTask 1.5: 处理外部数据格式（若 >2GB 启用 `.onnx.data`）
  - [ ] SubTask 1.6: 实现 `validate_onnx()`：onnxruntime CPU 探针推理 + L1 误差对比（< 1e-4），失败时非零退出码
- [ ] Task 2: 编写 BigVGAN DirectML 兼容性优化脚本 `optimize_bigvgan_dml.py`
  - [ ] SubTask 2.1: 复用 `optimize_sifigan_dml.py` 的 `fix_all_conv_transposes` 框架
  - [ ] SubTask 2.2: 扫描 BigVGAN ONNX 中所有 `ConvTranspose` 节点，识别 stride > 1 实例（44kHz 512x 模型预期含 stride=8/8/4/4）
  - [ ] SubTask 2.3: 应用等价分解 `Conv1D(upsample(x, S), flip(w.T), stride=1, pads=[K-1, K-S])`
  - [ ] SubTask 2.4: onnxsim 简化图
  - [ ] SubTask 2.5: `test_with_dml()` DirectML EP 探针推理验证可用性
  - [ ] SubTask 2.6: `compare_outputs()` 与 CPU 输出对比误差 < 1e-3
  - [ ] SubTask 2.7: 若无 DML 不兼容算子，直接复制并打日志 "no optimization needed"

## Phase 2: 应用层模型清单与注册表扩展

- [ ] Task 3: 扩展模型清单与注册表
  - [ ] SubTask 3.1: `src/modelManager.js` 的 `MODEL_IDS` 新增 `bigvgan: ''`（空字符串占位 + TODO 注释）
  - [ ] SubTask 3.2: `MODEL_FILE_MANIFEST` 新增 `bigvgan_vocoder_dml.onnx`（required: false）
  - [ ] SubTask 3.3: `src/modelRegistry.js` 的 `MODEL_GROUPS` 新增 `bigvgan-vocoder` 组（optional: true, sessionKey: 'bigvgan', files: ['bigvgan_vocoder_dml.onnx']）
  - [ ] SubTask 3.4: `src/inference/pipeline/constants.js` 新增 `BIGVGAN_MODEL_FILES`、`BIGVGAN_44K_SAMPLE_RATE=44100`、`BIGVGAN_44K_HOP_SIZE=512`、`BIGVGAN_44K_N_FFT=2048`、`BIGVGAN_44K_FMAX=22050`、`MODEL_SIZES.bigvgan`（~487MB）
- [ ] Task 4: 更新模型目录路径解析
  - [ ] SubTask 4.1: `src/main/modelDir.js` 确保 `bigvgan_vocoder_dml.onnx` 走与默认 vocoder 一致的四级解析路径
  - [ ] SubTask 4.2: `src/inference/pipeline/index.js` vocoder 路径回退链扩展为四级（bigvgan_vocoder_dml→vocoder_dml→vocoder，按 vocoderType 选择起点）

## Phase 3: 两阶段 Vocoder 集成

- [ ] Task 5: 实现 BigVGAN 44kHz Mel 提取器
  - [ ] SubTask 5.1: 在 `src/inference/pipeline/postprocessing.js` 将 `extractMelSpectrogram` 参数化（接受 n_fft/hop_size/num_mels/fmax/fmin）
  - [ ] SubTask 5.2: 实现 `extractBigVGANMel_44k(audioFloat)`：固定参数 n_fft=2048, hop=512, num_mels=128, fmax=22050，不应用 MEL_MEAN/MEL_VAR 归一化（仅 log）
  - [ ] SubTask 5.3: 实现 `createMelFilterbank(128, 2048, 44100, 0, 22050)` 并缓存
  - [ ] SubTask 5.4: 验证 JS mel 与 Python `meldataset.get_mel_spectrogram` 输出 cosine similarity ≥ 0.98（用同一段 44.1kHz 音频对比）
- [ ] Task 6: 实现两阶段 Vocoder 调度
  - [ ] SubTask 6.1: 在 `src/inference/pipeline/postprocessing.js` 新增 `runTwoStageVocoder(sessions, mel24k, settings)` 函数
  - [ ] SubTask 6.2: Stage 1：用 sessions.vocoder（默认）从 mel24k 生成 24kHz 波形
  - [ ] SubTask 6.3: Stage 2：`resampleLinear(wav24k, 24000, 44100)` → `extractBigVGANMel_44k` → sessions.bigvgan 生成 44.1kHz 波形
  - [ ] SubTask 6.4: 两阶段路径下 `runVocoderChunked` 对 Stage 2 同样分块（避免 44.1kHz 长音频 OOM）
  - [ ] SubTask 6.5: 在 SVS 合成主流程按 `vocoderType === 'bigvgan44k'` 分支调用两阶段路径，否则保持单阶段
- [ ] Task 7: 输出采样率解耦
  - [ ] SubTask 7.1: 在 `src/inference/shared/constants.js` 新增 `getOutputSampleRate(vocoderType)` 工具函数
  - [ ] SubTask 7.2: WAV 写入处使用派生采样率（`src/inference/pipeline/index.js` 合成主流程的 WAV 编码）
  - [ ] SubTask 7.3: `src/fragmentEditor/audioPlayback.js` 播放器初始化使用派生采样率
  - [ ] SubTask 7.4: 合成缓存键含采样率，避免 24k/44.1k 缓存混淆
  - [ ] SubTask 7.5: `src/main/svsIpc.js` / `src/renderer/ipcHandlers.js` 传递输出采样率到 UI

## Phase 4: 设置页 UI 与持久化

- [ ] Task 8: 扩展 Vocoder 类型选择 UI
  - [ ] SubTask 8.1: `src/settings.html` 推理分区的 `<select id="vocoderType">` 新增第三 option `bigvgan44k`
  - [ ] SubTask 8.2: BigVGAN 选项标签 `BigVGAN v2 44kHz（高保真，两阶段）`，未下载时 disabled + "未下载"
  - [ ] SubTask 8.3: 选择 BigVGAN 时显示质量权衡 tooltip（两阶段处理说明）
  - [ ] SubTask 8.4: `src/main/settings.js` 的 `vocoderType` 枚举校验扩展接受 `bigvgan44k`，启动时检测模型缺失自动回退 `default`

## Phase 5: 下载管理器 UI 扩展

- [ ] Task 9: 扩展模型下载窗口
  - [ ] SubTask 9.1: `src/modelDownload.html` 新增独立卡片"BigVGAN v2 44kHz Vocoder（可选）"
  - [ ] SubTask 9.2: `src/modelDownload.js` 渲染下载/卸载按钮、文件大小（~487MB）、下载进度
  - [ ] SubTask 9.3: `src/main/modelDownload.js` IPC 检测 `MODEL_IDS.bigvgan` 为空时返回 `download_url_not_configured`，UI 提示从 HuggingFace 手动下载
  - [ ] SubTask 9.4: 检测 `onnx_models/bigvgan_vocoder_dml.onnx` 手动存在时自动刷新为"已安装"
  - [ ] SubTask 9.5: 卸载时删除 `bigvgan_vocoder_dml.onnx` 与 `.data`，重置 `vocoderType=default`

## Phase 6: 文档、测试与发布

- [ ] Task 10: 更新 `onnx_models/README.md`，新增 BigVGAN v2 章节
  - [ ] SubTask 10.1: 模型架构说明（BigVGAN v2, NVIDIA, 44kHz/128band/512x）
  - [ ] SubTask 10.2: 训练数据来源（Large-scale Compilation, 5M steps）
  - [ ] SubTask 10.3: 输入输出格式（mel [1, seq, 128] → waveform [1, num_samples], 44100Hz）
  - [ ] SubTask 10.4: 两阶段集成路径与 mel 格式不兼容说明
  - [ ] SubTask 10.5: 质量权衡文档（两阶段固有伪影、完整收益需扩散模型重训）
  - [ ] SubTask 10.6: 与默认 vocoder / SiFiGAN 的差异对比表
- [ ] Task 11: 端到端测试与验证
  - [ ] SubTask 11.1: 默认 vocoder 路径回归测试（未破坏现有功能）
  - [ ] SubTask 11.2: SiFiGAN 路径回归测试（vocoderType=sifigan 仍正常）
  - [ ] SubTask 11.3: BigVGAN 两阶段端到端合成测试（DirectML 可用）
  - [ ] SubTask 11.4: BigVGAN 模型未下载时回退测试
  - [ ] SubTask 11.5: 44100Hz WAV 文件头与播放验证
  - [ ] SubTask 11.6: `npm run package:lite` 打包测试

# Task Dependencies
- Task 1 依赖 Task 0（需克隆仓库与下载权重）
- Task 2 依赖 Task 1（需导出后的 ONNX 才能优化）
- Task 4 依赖 Task 3（清单扩展先于路径解析）
- Task 5 依赖 Task 2（需优化后模型才能端到端测试 mel 提取一致性）
- Task 6 依赖 Task 5（两阶段调度依赖 mel 提取器）
- Task 7 依赖 Task 6（采样率解耦在两阶段路径之后）
- Task 9 依赖 Task 3（下载 UI 依赖清单）
- Task 11 依赖 Task 1–Task 10 全部完成

# 可并行任务
- Task 1（Python 导出脚本）与 Task 3、Task 8（应用层清单/UI）可并行
- Task 9（下载 UI）与 Task 5（mel 提取器）可并行
- Task 10（文档）可在 Task 1 完成后并行进行
