# Verification Checklist

## 模型导出与 DML 优化
- [ ] `export_sifigan_vocoder.py` 脚本存在，可读取本地 `D:\download\model+stats\sifigan_libritts-r-clean+nus-48e_checkpoint-1000000steps.pkl`（~611MB）
- [ ] 脚本可读取本地 `D:\download\model+stats\libritts_r_clean+nus-48e_train_no_dev.joblib`（~2.5KB）统计文件并嵌入 Wrapper
- [ ] 导出的 ONNX 输入名为 `mel`（[1, seq, 128]）和 `f0`（[1, seq, 1]），输出名为 `waveform`（[1, num_samples]）
- [ ] ONNX 导出后与 PyTorch 参考输出的 L1 误差 < 1e-4
- [ ] `optimize_sifigan_dml.py` 脚本存在，可输出 `sifigan_vocoder_dml.onnx`
- [ ] DML 优化后探针推理在 DirectML EP 下成功运行（无 `DML 不支持大 stride ConvTranspose` 错误）
- [ ] DML 优化后输出与原始 CPU 推理误差 < 1e-3
- [ ] 若 SiFiGAN 无 DML 不兼容算子，脚本记录 "no optimization needed" 并直接复制输出

## 应用层清单与注册表
- [ ] `src/modelManager.js` 的 `MODEL_IDS` 包含 `sifigan: ''`（空字符串占位）+ `// TODO: 等用户填写 ModelScope 仓库 ID` 注释
- [ ] `MODEL_FILE_MANIFEST` 包含 `sifigan_vocoder_dml.onnx`（required: false）与 `sifigan_stats.joblib`（required: false）
- [ ] `src/modelRegistry.js` 的 `MODEL_GROUPS` 包含 `sifigan-vocoder` 组，`optional: true`，files 含 onnx 与 joblib
- [ ] `src/inference/pipeline/constants.js` 包含 `SIFIGAN_MODEL_FILES`、`SIFIGAN_STATS_FILE` 和 `MODEL_SIZES.sifigan`

## 目录路径解析
- [ ] 开发模式下 `onnx_models/sifigan_vocoder_dml.onnx` 与 `onnx_models/sifigan_stats.joblib` 可被正确加载
- [ ] 精度子目录变体（fp16/int8）路径解析正确
- [ ] 打包模式下 `modelDir.js` 的 `getModelDir()` 四级解析路径覆盖 SiFiGAN onnx 与 joblib 文件
- [ ] `vocoderType = sifigan` 但 onnx 文件不存在时，自动回退到 `vocoder_dml.onnx` 并记录警告
- [ ] `vocoderType = sifigan` 且 onnx 存在但 `sifigan_stats.joblib` 缺失时，记录警告并使用零均值单位方差兜底
- [ ] 与现有 `vocoder_dml.onnx` 并存，互不影响

## 设置页 UI
- [ ] `src/settings.html` 推理分区存在 `<select id="vocoderType">` 控件
- [ ] 选项 `default` 与 `sifigan` 均可见
- [ ] SiFiGAN 未下载时选项禁用并显示"未下载"提示
- [ ] 切换后实时持久化到 settings.json 的 `vocoderType` 字段
- [ ] `src/main/settings.js` schema 包含 `vocoderType` 字段，默认 `'default'`，校验枚举值
- [ ] 启动时若 `vocoderType === 'sifigan'` 但模型缺失，自动回退并记录警告

## 下载管理器
- [ ] `src/modelDownload.html` 显示 SiFiGAN 独立卡片，标注"可选"
- [ ] 未下载时显示"下载"按钮，已下载时显示"已安装"+"卸载"按钮
- [ ] `MODEL_IDS.sifigan` 为空字符串时，IPC 返回 `download_url_not_configured` 而非报错
- [ ] UI 收到 `download_url_not_configured` 时禁用下载按钮、显示 tooltip "下载链接待配置，请等待作者上传至 ModelScope 或手动放置模型文件"
- [ ] 用户手动放置 `sifigan_vocoder_dml.onnx` 与 `sifigan_stats.joblib` 后，下载管理器自动刷新为"已安装"状态
- [ ] 配置 `MODEL_IDS.sifigan` 后，下载使用 ModelScope 镜像源，支持断点续传与分片下载
- [ ] 卸载时删除 `sifigan_vocoder_dml.onnx`、`.data` 文件与 `sifigan_stats.joblib`
- [ ] 卸载后自动将 `vocoderType` 重置为 `default`
- [ ] `src/main/modelDownload.js` IPC 处理支持 `sifigan-vocoder` 组的下载/卸载/状态查询

## SVS Pipeline 集成
- [ ] `_loadModelsPartitioned` 根据 `vocoderType` 加载对应模型文件
- [ ] 加载 SiFiGAN 时 sessionKey 为 `vocoder`，保持管线其余代码不变
- [ ] 复用 `createSessionWithValidation`，EP 配置 `[dml, cpu]`
- [ ] NPU 路径下 SiFiGAN 走 DML（不走 WebNN）
- [ ] `postprocessing.js` 根据 `vocoderType` 构造输入张量字典（`{mel}` 或 `{mel, f0}`）
- [ ] F0 序列从 `f0_encoder` 输出取并重采样到 mel 帧率
- [ ] F0 缺失时记录错误并回退到默认 vocoder
- [ ] 输出统一为 `waveform`，`runVocoderChunked` 分块推理逻辑保持不变
- [ ] `_detectVocoderPrecision` 支持 SiFiGAN 精度检测

## 文档与回归测试
- [ ] `onnx_models/README.md` 包含 SiFiGAN 模型说明章节
- [ ] 章节包含：架构、训练数据（LibriTTS-R + NUS-48E）、输入输出格式、DirectML 支持情况、与默认 vocoder 的差异对比表
- [ ] 默认 vocoder 路径回归测试通过（未破坏现有功能）
- [ ] SiFiGAN 路径端到端合成测试通过（DirectML 可用）
- [ ] SiFiGAN 路径 CPU 回退测试通过（无 GPU 也能合成）
- [ ] SiFiGAN 模型未下载时的回退测试通过
- [ ] 统计文件缺失时的兜底归一化测试通过
- [ ] `npm run package:lite` 打包后 SiFiGAN 下载与使用测试通过
- [ ] 模型路径四级解析测试通过（dev / custom / asar.unpacked / userData）
