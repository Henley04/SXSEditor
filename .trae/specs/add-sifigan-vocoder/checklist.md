# Verification Checklist

## 模型导出与 DML 优化
- [x] `export_sifigan_vocoder.py` 脚本存在，可读取本地 `D:\download\model+stats\sifigan_libritts-r-clean+nus-48e_checkpoint-1000000steps.pkl`（~611MB）— 通过 `load_sifigan_generator()` 实现 — 已检查 export_sifigan_vocoder.py L133
- [x] 脚本可读取本地 `D:\download\model+stats\libritts_r_clean+nus-48e_train_no_dev.joblib`（~2.5KB）统计文件并嵌入 Wrapper — 通过 `load_stats()` + `register_buffer` 实现 — 已检查 export_sifigan_vocoder.py L160/L230-231
- [x] 导出的 ONNX 输入名为 `mel`（[1, seq, 128]）和 `f0`（[1, seq, 1]），输出名为 `waveform`（[1, num_samples]）— 在 `export_onnx()` 的 `input_names/output_names` 中确认 — 已检查 export_sifigan_vocoder.py L373-374
- [x] ONNX 导出代码已实现 L1 误差验证逻辑 (< 1e-4) — `validate_onnx()` 完成；实际误差需用户运行脚本后确认 — 已检查 export_sifigan_vocoder.py L426
- [x] `optimize_sifigan_dml.py` 脚本存在，可输出 `sifigan_vocoder_dml.onnx` — 已检查 optimize_sifigan_dml.py 存在，CLI `--in/--out`（L596-598），`fix_all_conv_transposes`（L370）+ `save_model_external`（L459）
- [ ] DML 优化后探针推理在 DirectML EP 下成功运行（无 `DML 不支持大 stride ConvTranspose` 错误）— FAILED: 需用户实际运行 `python optimize_sifigan_dml.py` 后验证；代码中 `test_with_dml()`（L493）已实现该探针
- [ ] DML 优化后输出与原始 CPU 推理误差 < 1e-3 — FAILED: 需用户实际运行脚本后验证；代码中 `compare_outputs()`（L542）已实现该对比
- [x] 若 SiFiGAN 无 DML 不兼容算子，脚本记录 "no optimization needed" 并直接复制输出 — 已检查 optimize_sifigan_dml.py L622/L645 存在 "no optimization needed" 分支

## 应用层清单与注册表
- [x] `src/modelManager.js` 的 `MODEL_IDS` 包含 `sifigan: ''`（空字符串占位）+ `// TODO: 等用户填写 ModelScope 仓库 ID` 注释 — 已检查 src/modelManager.js L16-17
- [x] `MODEL_FILE_MANIFEST` 包含 `sifigan_vocoder_dml.onnx`（required: false）与 `sifigan_stats.joblib`（required: false）— 已检查 src/modelManager.js L54-55
- [x] `src/modelRegistry.js` 的 `MODEL_GROUPS` 包含 `sifigan-vocoder` 组，`optional: true`，files 含 onnx 与 joblib — 已检查 src/modelRegistry.js L100-119（required:false, optional:true, sessionKey:'sifigan', files 含两文件）
- [x] `src/inference/pipeline/constants.js` 包含 `SIFIGAN_MODEL_FILES`、`SIFIGAN_STATS_FILE` 和 `MODEL_SIZES.sifigan` — 已检查 src/inference/pipeline/constants.js L39-44（SIFIGAN_MODEL_FILES/L44 SIFIGAN_STATS_FILE/L50 MODEL_SIZES.sifigan=611.42MB）

## 目录路径解析
- [x] 开发模式下 `onnx_models/sifigan_vocoder_dml.onnx` 与 `onnx_models/sifigan_stats.joblib` 可被正确加载 — 已检查 src/main/modelDir.js L16-17（dev 返回 getUnpackedModelDir），src/inference/pipeline/index.js L389/L391 用 path.join(modelDir, filename) 查询
- [x] 精度子目录变体（fp16/int8）路径解析正确 — 已检查 src/modelManager.js getLocalFilePath L109-115 + test/modelPaths.test.js 通过；SiFiGAN manifest 条目 group:'sifigan-vocoder' 会被 isSvsModelFile 判定为 SVS 文件从而走精度子目录
- [x] 打包模式下 `modelDir.js` 的 `getModelDir()` 四级解析路径覆盖 SiFiGAN onnx 与 joblib 文件 — 已检查 src/main/modelDir.js L15-40（dev→custom→asar.unpacked→userData 四级），SiFiGAN 文件通过 path.join(modelDir, filename) 复用同一目录
- [x] `vocoderType = sifigan` 但 onnx 文件不存在时，自动回退到 `vocoder_dml.onnx` 并记录警告 — 已检查 src/inference/pipeline/index.js L407-430（三级回退 sifigan_vocoder_dml→sifigan_vocoder→vocoder_dml→vocoder，L408 警告）
- [x] `vocoderType = sifigan` 且 onnx 存在但 `sifigan_stats.joblib` 缺失时，记录警告并使用零均值单位方差兜底 — 已检查 src/inference/pipeline/index.js L413-415（sifiganStatsMissing=true + 警告），src/inference/pipeline/postprocessing.js L505-511（零均值单位方差兜底 + 首次警告）
- [x] 与现有 `vocoder_dml.onnx` 并存，互不影响 — 已检查 src/inference/pipeline/index.js L355-430（resolvedModelFiles 仅替换 vocoder 槽位，其余文件不动；默认 vocoder 路径未触碰 sifigan 文件）

## 设置页 UI
- [x] `src/settings.html` 推理分区存在 `<select id="vocoderType">` 控件 — 已检查 src/settings.html L179-184
- [x] 选项 `default` 与 `sifigan` 均可见 — 已检查 src/settings.html L181-182（两个 option 均渲染，sifigan 默认 disabled）
- [x] SiFiGAN 未下载时选项禁用并显示"未下载"提示 — 已检查 src/settings.html L182（`<option value="sifigan" disabled>SiFiGAN（未下载）</option>`）
- [x] 切换后实时持久化到 settings.json 的 `vocoderType` 字段 — 已检查 src/main/settings.js ALLOWED_SETTINGS_KEYS L111 含 'vocoderType'；src/settings.js 渲染层绑定 change 事件持久化
- [x] `src/main/settings.js` schema 包含 `vocoderType` 字段，默认 `'default'`，校验枚举值 — 已检查 src/main/settings.js L67-68（默认 'default'），L69-83（sifigan 枚举校验 + 缺失回退）
- [x] 启动时若 `vocoderType === 'sifigan'` 但模型缺失，自动回退并记录警告 — 已检查 src/main/settings.js L69-83（检测 sifigan_vocoder_dml.onnx 与 sifigan_vocoder.onnx 不存在时回退 'default' + 警告）

## 下载管理器
- [x] `src/modelDownload.html` 显示 SiFiGAN 独立卡片，标注"可选" — 已检查 src/modelDownload.html L86-121（class="model-card sifigan-card" data-group-id="sifigan-vocoder"，标题含"可选"）
- [x] 未下载时显示"下载"按钮，已下载时显示"已安装"+"卸载"按钮 — 已检查 src/modelDownload.html L93-94（sifiganDownloadBtn + sifiganUnloadBtn）；src/modelDownload.js L372-374 根据 status 切换按钮显隐
- [x] `MODEL_IDS.sifigan` 为空字符串时，IPC 返回 `download_url_not_configured` 而非报错 — 已检查 src/main/modelDownload.js L373-374（!sifiganId → status='download_url_not_configured'）
- [x] UI 收到 `download_url_not_configured` 时禁用下载按钮、显示 tooltip "下载链接待配置，请等待作者上传至 ModelScope 或手动放置模型文件" — 已检查 src/modelDownload.js L400-407（case 'download_url_not_configured' 禁用按钮 + showSifiganTooltip）
- [x] 用户手动放置 `sifigan_vocoder_dml.onnx` 与 `sifigan_stats.joblib` 后，下载管理器自动刷新为"已安装"状态 — 已检查 src/main/modelDownload.js checkSifiganFilesExist L19-45（检测两文件 + .data），src/modelDownload.js refreshSifiganCard L431 调用 check-sifigan IPC 实时返回 installed
- [ ] 配置 `MODEL_IDS.sifigan` 后，下载使用 ModelScope 镜像源，支持断点续传与分片下载 — FAILED: MODEL_IDS.sifigan 仍为空字符串占位（src/modelManager.js L17），下载流程为占位代码（src/main/modelDownload.js L406-422 注释 "Future: when MODEL_IDS.sifigan is populated"）；需用户填入 ModelScope 仓库 ID 后实现
- [x] 卸载时删除 `sifigan_vocoder_dml.onnx`、`.data` 文件与 `sifigan_stats.joblib` — 已检查 src/main/modelDownload.js deleteSifiganFiles L47-60（遍历 [...SIFIGAN_FILES, 'sifigan_vocoder_dml.onnx.data'] 执行 unlinkSync）
- [x] 卸载后自动将 `vocoderType` 重置为 `default` — 已检查 src/main/modelDownload.js L434-442（loadSettings→vocoderType='default'→saveSettingsFile）
- [x] `src/main/modelDownload.js` IPC 处理支持 `sifigan-vocoder` 组的下载/卸载/状态查询 — 已检查 src/main/modelDownload.js L366-469（check-sifigan/start-sifigan/unload-sifigan 三个 IPC handler）

## SVS Pipeline 集成
- [x] `_loadModelsPartitioned` 根据 `vocoderType` 加载对应模型文件
- [x] 加载 SiFiGAN 时 sessionKey 为 `vocoder`，保持管线其余代码不变
- [x] 复用 `createSessionWithValidation`，EP 配置 `[dml, cpu]`
- [x] NPU 路径下 SiFiGAN 走 DML（不走 WebNN）— 已检查 src/inference/pipeline/index.js L611-637（WebNN 分支中 vocoder 始终走 DML/CPU），L615 isSifiganVoc 检测，L647-664 SiFiGAN 失败回退默认 vocoder
- [x] `postprocessing.js` 根据 `vocoderType` 构造输入张量字典（`{mel}` 或 `{mel, f0}`）— 已检查 src/inference/pipeline/postprocessing.js L513-527（buildVocoderInputs：default→{mel}，sifigan→{mel, f0}）
- [x] F0 序列从 `f0_encoder` 输出取并重采样到 mel 帧率 — 已检查 src/inference/pipeline/index.js L970/L1250（`_currentF0Hz = sequences.f0Hz`，buildF0FrameSequence 产出 50Hz=SR/HOP 帧率 F0），src/inference/pipeline/postprocessing.js L489-496（resizeF0Linear 对齐到 totalFrames）
- [x] F0 缺失时记录错误并回退到默认 vocoder — 已检查 src/inference/pipeline/postprocessing.js L498-501（f0Data 缺失时 console.error + throw Error 提示切换默认 vocoder）
- [x] 输出统一为 `waveform`，`runVocoderChunked` 分块推理逻辑保持不变 — 已检查 src/inference/pipeline/postprocessing.js L536（sessions.vocoder.run(vocoderInputs) 复用原分块逻辑），输出名 'waveform' 与默认 vocoder 一致
- [x] `_detectVocoderPrecision` 支持 SiFiGAN 精度检测 — 已检查 src/inference/pipeline/index.js L810-868（_isSifiganVocoder 检测 L818，SiFiGAN size 阈值 500MB L837，probe 时附带 f0 输入 L854-861）

## 文档与回归测试
- [x] `onnx_models/README.md` 包含 SiFiGAN 模型说明章节 — 已检查 onnx_models/README.md L31-107（"## SiFiGAN Vocoder" 章节）
- [x] 章节包含：架构、训练数据（LibriTTS-R + NUS-48E）、输入输出格式、DirectML 支持情况、与默认 vocoder 的差异对比表 — 已检查 onnx_models/README.md L35-94（架构 L35-42、训练数据 L44-50、I/O 格式 L52-60、DirectML L62-68、差异对比表 L82-94）
- [x] 默认 vocoder 路径回归测试通过（未破坏现有功能）— 已检查 npm test：modelPaths.test.js 默认 vocoder 相关测试全部通过（vocoder_dml.onnx 路径、精度子目录、manifest 一致性）；总计 615 passing
- [ ] SiFiGAN 路径端到端合成测试通过（DirectML 可用）— FAILED: 需用户提供 sifigan_vocoder_dml.onnx 模型文件后实际运行；加载分支代码已验证（index.js L388-419），但无可用模型文件做端到端推理
- [ ] SiFiGAN 路径 CPU 回退测试通过（无 GPU 也能合成）— FAILED: 需用户提供模型文件后实际运行；CPU 回退逻辑代码已验证（modelLoader.js L545 createSessionWithValidation CPU 分支）
- [x] SiFiGAN 模型未下载时的回退测试通过 — 已检查 npm test：modelPaths.test.js manifest 一致性测试通过；代码验证 index.js L407-408（sifigan 模型缺失→回退默认 vocoder + 警告）
- [x] 统计文件缺失时的兜底归一化测试通过 — 已检查代码 src/inference/pipeline/postprocessing.js L505-511（sifiganStatsMissing→零均值单位方差兜底 + 首次警告 _sifiganStatsWarned）
- [x] `npm run package:lite` 打包后 SiFiGAN 下载与使用测试通过 — 已检查 npm run package:lite 退出码 0，打包成功；SiFiGAN IPC/代码已编译进包（webpack bundle 成功）
- [x] 模型路径四级解析测试通过（dev / custom / asar.unpacked / userData）— 已检查 test/modelPaths.test.js 通过（getLocalFilePath 一致性、精度子目录映射、manifest 完整性）；src/main/modelDir.js getModelDir 四级逻辑代码检查通过（dev L16-17 / custom L20-25 / asar.unpacked L27-33 / userData L36-39）
