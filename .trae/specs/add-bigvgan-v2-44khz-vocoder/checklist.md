# Verification Checklist

## 下载与依赖准备
- [ ] `third_party/BigVGAN/` 仓库已克隆（含 `bigvgan.py`、`meldataset.py`、`configs/bigvgan_v2_44khz_128band_512x.json`）
- [ ] `D:\download\bigvgan_v2_44khz_128band_512x\config.json` 已下载
- [ ] `D:\download\bigvgan_v2_44khz_128band_512x\bigvgan_generator.pt` 已下载（~487MB，122M 参数）
- [ ] conda 环境 `bigvgan` 已创建并安装 `third_party/BigVGAN/requirements.txt` + `onnx onnxsim onnxruntime`
- [ ] `torch.load('bigvgan_generator.pt')` 可成功加载（验证权重完整性）

## ONNX 导出与 DML 优化
- [ ] `export_bigvgan_vocoder.py` 脚本存在，可读取本地 `config.json` 与 `bigvgan_generator.pt`
- [ ] 导出的 ONNX 输入名为 `mel`（[1, seq, 128]），输出名为 `waveform`（[1, num_samples]，44100Hz）
- [ ] ONNX 导出代码已实现 L1 误差验证逻辑 (< 1e-4)
- [ ] `optimize_bigvgan_dml.py` 脚本存在，可输出 `bigvgan_vocoder_dml.onnx`
- [ ] DML 优化后探针推理在 DirectML EP 下成功运行（无大 stride ConvTranspose 错误）
- [ ] DML 优化后输出与原始 CPU 推理误差 < 1e-3
- [ ] 若无 DML 不兼容算子，脚本记录 "no optimization needed" 并复制输出

## 应用层清单与注册表
- [ ] `src/modelManager.js` 的 `MODEL_IDS` 包含 `bigvgan: ''`（空字符串占位）+ TODO 注释
- [ ] `MODEL_FILE_MANIFEST` 包含 `bigvgan_vocoder_dml.onnx`（required: false）
- [ ] `src/modelRegistry.js` 的 `MODEL_GROUPS` 包含 `bigvgan-vocoder` 组（optional: true, sessionKey: 'bigvgan'）
- [ ] `src/inference/pipeline/constants.js` 包含 `BIGVGAN_MODEL_FILES`、`BIGVGAN_44K_SAMPLE_RATE=44100`、`BIGVGAN_44K_HOP_SIZE=512`、`BIGVGAN_44K_N_FFT=2048`、`BIGVGAN_44K_FMAX=22050`、`MODEL_SIZES.bigvgan`

## 目录路径解析
- [ ] 开发模式下 `onnx_models/bigvgan_vocoder_dml.onnx` 可被正确加载
- [ ] 打包模式下 `modelDir.js` 的 `getModelDir()` 四级解析覆盖 BigVGAN 文件
- [ ] `vocoderType = bigvgan44k` 但 onnx 文件不存在时，自动回退到 `vocoder_dml.onnx` 并记录警告

## BigVGAN 44kHz Mel 提取器
- [ ] `extractMelSpectrogram` 已参数化（接受 n_fft/hop_size/num_mels/fmax）
- [ ] `extractBigVGANMel_44k(audioFloat)` 实现，参数 n_fft=2048, hop=512, num_mels=128, fmax=22050
- [ ] 不应用 SVS 的 MEL_MEAN/MEL_VAR 归一化（仅 log）
- [ ] JS mel 与 Python `meldataset.get_mel_spectrogram` 输出 cosine similarity ≥ 0.98

## 两阶段 Vocoder 集成
- [ ] `runTwoStageVocoder(sessions, mel24k, settings)` 函数实现
- [ ] Stage 1 用默认 vocoder 从 mel24k 生成 24kHz 波形
- [ ] Stage 2 重采样 24kHz→44100Hz + 重提取 mel + BigVGAN 生成 44.1kHz 波形
- [ ] 两阶段路径下 Stage 2 分块推理（避免 OOM）
- [ ] SVS 合成主流程按 `vocoderType === 'bigvgan44k'` 分支调用两阶段路径

## 输出采样率解耦
- [ ] `getOutputSampleRate(vocoderType)` 工具函数实现（default/sifigan→24000, bigvgan44k→44100）
- [ ] WAV 写入处使用派生采样率
- [ ] `audioPlayback.js` 播放器初始化使用派生采样率
- [ ] 合成缓存键含采样率，避免 24k/44.1k 缓存混淆
- [ ] IPC 传递输出采样率到 UI

## 设置页 UI
- [ ] `src/settings.html` 推理分区 `<select id="vocoderType">` 含第三 option `bigvgan44k`
- [ ] BigVGAN 选项标签含"两阶段"说明，未下载时 disabled + "未下载"
- [ ] 选择 BigVGAN 时显示质量权衡 tooltip
- [ ] `src/main/settings.js` 的 `vocoderType` 枚举校验接受 `bigvgan44k`
- [ ] 启动时 `vocoderType === 'bigvgan44k'` 但模型缺失时自动回退 `default` + 警告

## 下载管理器
- [ ] `src/modelDownload.html` 显示 BigVGAN 独立卡片，标注"可选"
- [ ] 未下载显示"下载"，已下载显示"已安装"+"卸载"
- [ ] `MODEL_IDS.bigvgan` 为空时 IPC 返回 `download_url_not_configured`，UI 提示从 HuggingFace 手动下载
- [ ] 手动放置 `bigvgan_vocoder_dml.onnx` 后自动刷新为"已安装"
- [ ] 卸载时删除 onnx 与 .data 文件，重置 `vocoderType=default`

## 文档与回归测试
- [ ] `onnx_models/README.md` 包含 BigVGAN v2 章节（架构/数据/I/O/两阶段/质量权衡/差异对比表）
- [ ] 默认 vocoder 路径回归测试通过
- [ ] SiFiGAN 路径回归测试通过
- [ ] BigVGAN 两阶段端到端合成测试通过（DirectML 可用）
- [ ] BigVGAN 模型未下载时回退测试通过
- [ ] 44100Hz WAV 文件头与播放验证通过
- [ ] `npm run package:lite` 打包测试通过
