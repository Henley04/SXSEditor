# 集成 SiFiGAN 作为可选替代 Vocoder Spec

## Why
当前 SVS 管线的默认 vocoder 存在 DirectML 兼容性痛点（原始 `ConvTranspose(stride=480)` 不被 DML 支持，必须依赖 `optimize_vocoder_dml.py` 做节点分解）。SiFiGAN（Source-Filter HiFi-GAN，ICASSP 2023）是快速、可控音高、高保真的神经 vocoder，且 24kHz 采样率与现有管线 `SAMPLE_RATE = 24000` 完全一致。引入 SiFiGAN 作为可选替代 vocoder，可提供"音质/速度/兼容性"的备选方案，并降低单一 vocoder 的部署风险。

## What Changes
- **新增 SiFiGAN ONNX 导出脚本**：基于 SiFiGAN 官方 PyTorch 实现，编写 `export_sifigan_vocoder.py`，输入对齐 SVS 管线产出（mel 频谱 + F0），输出 24kHz 波形。预训练权重与统计文件已在本地 `D:\download\model+stats\`：
  - `sifigan_libritts-r-clean+nus-48e_checkpoint-1000000steps.pkl`（约 611 MB，1000k 步）
  - `libritts_r_clean+nus-48e_train_no_dev.joblib`（约 2.5 KB，特征归一化统计）
- **新增 SiFiGAN DirectML 优化脚本**：`optimize_sifigan_dml.py`，复用现有 `optimize_vocoder_dml.py` 的 ConvTranspose 分解思路，处理 SiFiGAN 中 DML 不兼容算子
- **扩展模型清单与注册表**：在 `MODEL_FILE_MANIFEST` 与 `MODEL_GROUPS` 中新增 `sifigan-vocoder` 模型组，标记为 **optional**（不破坏现有 `vocoder` 必需项）。`MODEL_IDS.sifigan` 留空字符串占位，并加 `// TODO: 等用户填写 ModelScope 仓库 ID` 注释；下载功能照常实现，仅在实际下载时返回"下载链接待配置"提示
- **统计文件随模型分发**：`libritts_r_clean+nus-48e_train_no_dev.joblib` 与 ONNX 模型一同部署到 `onnx_models/`，运行时由 SiFiGAN Wrapper 加载用于输入特征归一化
- **设置页新增 vocoder 切换 UI**：在"推理"分区增加"Vocoder 类型"下拉选择，选项 `default | sifigan`，持久化到 settings.json
- **SVS Pipeline 支持双 vocoder 路径**：`OnnxSVSPipeline._loadModelsPartitioned` 按 `vocoderType` 选择加载 `vocoder_dml.onnx` 或 `sifigan_vocoder_dml.onnx`，统一输入输出张量名为 `mel`/`waveform`
- **目录结构兼容设计**：SiFiGAN 模型文件命名 `sifigan_vocoder_dml.onnx`，遵循现有精度子目录约定（`fp16/`、`fp8/`、`int8/`），与默认 vocoder 并存于同一 `onnx_models/` 目录；统计文件命名为 `sifigan_stats.joblib` 避免与项目其他统计文件冲突
- **DirectML EP 复用**：SiFiGAN 加载复用 `createSessionWithValidation`，EP 配置 `[dml, cpu]`，三级回退策略保持一致
- **模型下载管理器扩展**：`modelManager.js` 新增 `sifigan` 模型 ID 配置项（占位空字符串 + TODO 注释，等待 ModelScope 仓库 ID 填入），下载源使用 ModelScope 镜像（符合国内镜像加速规则）；在 ID 未配置前，UI 显示"下载链接待配置"且禁用下载按钮，但不影响其他流程
- **README 与文档更新**：在 `onnx_models/README.md` 增加 SiFiGAN 模型说明、训练数据来源（LibriTTS-R + NUS-48E）、特性差异、DirectML 支持情况

## Impact
- Affected specs: `migrate-onnxruntime-directml`, `add-npu-inference-support`, `complete-first-release`
- Local pre-trained artifacts（已在 `D:\download\model+stats\`，开发机本地，不入 git）:
  - `sifigan_libritts-r-clean+nus-48e_checkpoint-1000000steps.pkl`（1000k 步预训练权重，~611 MB）
  - `libritts_r_clean+nus-48e_train_no_dev.joblib`（特征归一化统计，~2.5 KB）
- Affected code:
  - `src/inference/pipeline/index.js` - 加载分支：按 `vocoderType` 选择 vocoder 路径
  - `src/inference/pipeline/postprocessing.js` - vocoder 推理调用兼容（统一张量名）
  - `src/inference/pipeline/modelLoader.js` - 复用 `createSessionWithValidation`，无侵入
  - `src/inference/pipeline/constants.js` - 新增 `SIFIGAN_MODEL_FILES`、`MODEL_SIZES.sifigan`、`SIFIGAN_STATS_FILE`
  - `src/modelManager.js` - 新增 `sifigan` 下载 ID 占位空字符串 + TODO 注释，文件清单含 `sifigan_vocoder_dml.onnx` 与 `sifigan_stats.joblib`
  - `src/modelRegistry.js` - 新增 `sifigan-vocoder` 模型组（optional）
  - `src/main/modelDownload.js` - IPC 处理扩展；ID 为空时返回"下载链接待配置"而非报错
  - `src/main/settings.js` - 新增 `vocoderType` 字段持久化
  - `src/main/modelDir.js` - SiFiGAN 路径解析（兼容 dev/packaged/custom/userData 四种模式）
  - `src/settings.html` - 新增 Vocoder 类型选择 UI
  - `src/modelDownload.html` / `src/modelDownload.js` - SiFiGAN 下载展示
  - `onnx_models/README.md` - 模型说明文档更新
  - `export_sifigan_vocoder.py` (新增) - PyTorch → ONNX 导出脚本，读取本地 pkl + joblib
  - `optimize_sifigan_dml.py` (新增) - DML 兼容性优化脚本
  - `package.json` - 仅当需要新 Python 依赖时更新（PyTorch 训练侧，非 JS 运行时）

## ADDED Requirements

### Requirement: SiFiGAN ONNX 导出脚本
系统 SHALL 提供 `export_sifigan_vocoder.py`，将 SiFiGAN 官方 PyTorch 模型（本地 `D:\download\model+stats\`）导出为 ONNX 格式，输入输出与 SVS 管线对齐。

#### Scenario: 标准 ONNX 导出
- **WHEN** 执行 `python export_sifigan_vocoder.py --checkpoint "D:\download\model+stats\sifigan_libritts-r-clean+nus-48e_checkpoint-1000000steps.pkl" --stats "D:\download\model+stats\libritts_r_clean+nus-48e_train_no_dev.joblib" --out sifigan_vocoder.onnx`
- **THEN** 加载 SiFiGAN 预训练 pkl 权重（约 611 MB）
- **AND** 加载 joblib 统计文件用于输入归一化（嵌入到 Wrapper 内部常量）
- **AND** 包装为接受 `mel`（float32, [1, seq_len, 128]）和 `f0`（float32, [1, seq_len, 1]）输入的 nn.Module
- **AND** 输出张量名 `waveform`，shape `[1, num_samples]`，采样率 24000Hz
- **AND** 使用 opset_version=18，启用 dynamic_axes（seq_len 动态）
- **AND** 使用 `torch.onnx.export` + `dynamo=True` 与现有 `export_step2_vocoder.py` 风格一致
- **AND** 验证导出后 ONNX 与原 PyTorch 模型输出数值误差 < 1e-4

#### Scenario: 导出后精度验证
- **WHEN** 导出完成
- **THEN** 自动使用 onnxruntime CPU 跑一组探针输入
- **AND** 与 PyTorch 参考输出做 L1 误差对比
- **AND** 失败时非零退出码并打印差异

### Requirement: SiFiGAN DirectML 兼容性优化
系统 SHALL 提供 `optimize_sifigan_dml.py`，将 SiFiGAN ONNX 中 DML 不支持的算子（如大 stride ConvTranspose）分解为 DML 兼容序列。

#### Scenario: DML 不兼容算子检测与分解
- **WHEN** 执行 `python optimize_sifigan_dml.py --in sifigan_vocoder.onnx --out sifigan_vocoder_dml.onnx`
- **THEN** 扫描模型中所有 `ConvTranspose` 节点，识别 stride > 1 的实例
- **AND** 应用等价分解：`ConvTranspose1D(x, w, stride=S) = Conv1D(upsample(x, S), flip(w.T), stride=1, pads=[K-1, K-S])`
- **AND** 使用 onnxsim 简化图
- **AND** 用 DirectML EP 跑探针推理验证可用性
- **AND** 与原始 CPU 推理输出对比，误差 < 1e-3
- **AND** 若 SiFiGAN 中无 DML 不兼容算子，脚本直接复制文件并标记 "no optimization needed"

### Requirement: Vocoder 类型选择设置
系统 SHALL 在设置页"推理"分区提供 Vocoder 类型选择，用户可在默认 vocoder 与 SiFiGAN 之间切换。

#### Scenario: 设置页 UI
- **WHEN** 用户打开设置页
- **THEN** 在"推理"分区显示"Vocoder 类型"下拉选择
- **AND** 选项包含 `默认 Vocoder（vocoder_dml.onnx）` 与 `SiFiGAN（sifigan_vocoder_dml.onnx）`
- **AND** 当前选择高亮显示
- **AND** 切换时实时持久化到 settings.json 的 `vocoderType` 字段
- **AND** 当 SiFiGAN 模型未下载时，选项禁用并显示提示"未下载"

#### Scenario: 持久化与读取
- **WHEN** 应用启动
- **THEN** 从 settings.json 读取 `vocoderType`，默认值 `default`
- **AND** 若值为 `sifigan` 但模型文件不存在，自动回退到 `default` 并记录警告日志
- **AND** 设置变更后下次 SVS 推理时生效（无需重启应用）

### Requirement: 模型下载管理器支持 SiFiGAN
系统 SHALL 在模型下载窗口将 SiFiGAN 显示为可选独立模型组，与现有 vocoder（svs 组的一部分）并存。下载链接暂未上传至 ModelScope，UI 需优雅处理"链接待配置"状态。

#### Scenario: 模型清单注册
- **WHEN** 模型下载窗口加载
- **THEN** `MODEL_FILE_MANIFEST` 包含 `sifigan_vocoder_dml.onnx` 与 `sifigan_stats.joblib`，均 `required: false`
- **AND** `MODEL_GROUPS` 新增 `sifigan-vocoder` 组，`required: false`，`sessionKey: 'sifigan'`
- **AND** UI 显示独立卡片，标注"可选替代 Vocoder，需手动下载"
- **AND** 默认未下载状态显示"下载"按钮
- **AND** 已下载状态显示"已安装"+"卸载"按钮

#### Scenario: 下载源未配置时的优雅降级
- **WHEN** `MODEL_IDS.sifigan` 为空字符串（占位）且用户点击"下载"
- **THEN** 不抛出异常，而是返回状态 `download_url_not_configured`
- **AND** UI 提示"下载链接待配置，请等待作者上传至 ModelScope 或手动放置模型文件"
- **AND** 按钮变为禁用状态并显示 tooltip 说明
- **AND** 主进程 IPC `modelDownload.js` 中检测空 ID 时短路返回，不进入实际下载流程
- **AND** 代码处加 `// TODO: 等用户填写 ModelScope 仓库 ID` 注释

#### Scenario: 下载源配置后正常下载（未来）
- **WHEN** 用户填入 `MODEL_IDS.sifigan` 后点击"下载"
- **THEN** 使用 ModelScope 镜像（`modelscope.cn`）
- **AND** 按精度（fp32/fp16/int8）选择对应 `MODEL_IDS` 仓库
- **AND** 支持断点续传、分片下载（复用现有 `modelManager.js` 逻辑）
- **AND** 下载完成后校验文件完整性（大小或哈希）

#### Scenario: 手动放置模型文件
- **WHEN** 用户从官方 dropbox 下载 SiFiGAN 预训练模型并手动放到 `onnx_models/` 后
- **THEN** 应用启动时检测到 `sifigan_vocoder_dml.onnx` 与 `sifigan_stats.joblib` 存在
- **AND** 下载管理器自动刷新状态为"已安装"
- **AND** 设置页 `vocoderType` 选项解除禁用

#### Scenario: 卸载
- **WHEN** 用户点击卸载 SiFiGAN
- **THEN** 删除 `sifigan_vocoder_dml.onnx`、`.data` 外部数据文件与 `sifigan_stats.joblib`
- **AND** 自动将 `vocoderType` 重置为 `default`
- **AND** 释放已加载的 SiFiGAN InferenceSession

### Requirement: SVS Pipeline 双 Vocoder 路径
系统 SHALL 在 `OnnxSVSPipeline` 中支持根据 `vocoderType` 加载并使用对应 vocoder。

#### Scenario: 模型加载分支
- **WHEN** `_loadModelsPartitioned` 执行
- **THEN** 读取 settings 中的 `vocoderType`
- **AND** 若为 `sifigan`，加载 `sifigan_vocoder_dml.onnx`，sessionKey 为 `vocoder`（保持管线其余代码不变）
- **AND** 若为 `default` 或文件缺失，加载现有 `vocoder_dml.onnx`
- **AND** 复用 `createSessionWithValidation`，传入正确的模型路径与 dummy 输入
- **AND** NPU 路径下 SiFiGAN 也走 DML（与默认 vocoder 行为一致，原因：大卷积核不适合 NPU）

#### Scenario: 推理输入对齐
- **WHEN** 执行 vocoder 推理
- **THEN** SiFiGAN 接受输入 `mel`（[1, seq, 128]）与 `f0`（[1, seq, 1]）
- **AND** 默认 vocoder 仅接受 `mel`（[1, seq, 128]）
- **AND** 若 SiFiGAN 需要 F0 输入，从 `f0_encoder` 输出取 F0 序列，重采样到 mel 帧率
- **AND** 输出统一为 `waveform`（[1, num_samples]）
- **AND** 分块推理（`runVocoderChunked`）逻辑保持不变，仅替换 session 调用

#### Scenario: F0 缺失处理
- **WHEN** `vocoderType = sifigan` 但管线未产出 F0
- **THEN** 记录错误日志
- **AND** 自动回退到默认 vocoder 完成本次推理
- **AND** UI 提示用户检查 F0 配置

### Requirement: 目录结构兼容设计
系统 SHALL 在开发和部署环境下设计可靠的 SiFiGAN 模型目录结构，与现有模型并存，包括 ONNX 模型文件与统计文件。

#### Scenario: 开发模式目录
- **WHEN** 应用以开发模式运行
- **THEN** SiFiGAN 模型位于 `<appPath>/onnx_models/sifigan_vocoder_dml.onnx`
- **AND** 统计文件位于 `<appPath>/onnx_models/sifigan_stats.joblib`（重命名以避免与项目其他 stats 文件冲突）
- **AND** 精度变体位于 `onnx_models/fp16/sifigan_vocoder_dml.onnx` 等
- **AND** 若有外部数据文件（`.onnx.data`），与主文件同目录
- **AND** 与现有 `vocoder_dml.onnx` 并存，互不影响

#### Scenario: 打包模式目录
- **WHEN** 应用以打包模式运行（package:lite 或完整打包）
- **THEN** 通过 `modelDir.js` 的 `getModelDir()` 解析路径
- **AND** 解析顺序保持现有四级：开发目录 → customModelDir → asar.unpacked → userData
- **AND** SiFiGAN 文件名查询逻辑与默认 vocoder 完全一致（包括 `sifigan_stats.joblib`）
- **AND** lite 打包模式下，SiFiGAN 通过下载管理器从 ModelScope 拉取到 userData，或用户手动放置

#### Scenario: 模型路径回退
- **WHEN** `vocoderType = sifigan` 但 `sifigan_vocoder_dml.onnx` 不存在
- **THEN** 自动尝试加载 `sifigan_vocoder.onnx`（未做 DML 优化的原版）
- **AND** 若仍不存在，回退到默认 `vocoder_dml.onnx` 并记录警告

#### Scenario: 统计文件缺失处理
- **WHEN** `vocoderType = sifigan` 且 `sifigan_vocoder_dml.onnx` 存在但 `sifigan_stats.joblib` 缺失
- **THEN** 记录警告"统计文件缺失，SiFiGAN 输入归一化可能不可用"
- **AND** 尝试使用零均值单位方差作为兜底归一化（仅用于不破坏流程，质量可能下降）
- **AND** UI 提示用户重新下载或手动放置统计文件

## MODIFIED Requirements

### Requirement: 模型文件清单
`MODEL_FILE_MANIFEST` 在保留现有 `vocoder_dml.onnx`（required: true）基础上，新增 `sifigan_vocoder_dml.onnx`（required: false）与 `sifigan_stats.joblib`（required: false）。`ONNX_MODEL_FILES` 中 vocoder 路径解析逻辑增加 SiFiGAN 分支。

### Requirement: 模型组注册
`MODEL_GROUPS` 数组在 `svs` 组之后新增 `sifigan-vocoder` 组，定义为：
```
{ id: 'sifigan-vocoder', name: 'SiFiGAN Vocoder', nameEn: 'SiFiGAN Vocoder',
  description: '可选替代声码器，基于 Source-Filter HiFi-GAN，支持音高可控',
  files: ['sifigan_vocoder_dml.onnx', 'sifigan_stats.joblib'],
  sessionKey: 'sifigan',
  required: false, optional: true }
```

### Requirement: 下载源 ID 占位约定
`MODEL_IDS.sifigan` 初始为空字符串 `''`，并附加 `// TODO: 等用户填写 ModelScope 仓库 ID` 注释。代码必须对空字符串做短路处理，UI 不应阻塞或崩溃。

### Requirement: 设置持久化
`src/main/settings.js` 的 settings schema 新增 `vocoderType` 字段，取值 `'default' | 'sifigan'`，默认 `'default'`。变更通过现有 IPC `settings:update` 持久化。

### Requirement: Vocoder 精度检测
`_detectVocoderPrecision` 函数扩展为同时支持检测默认 vocoder 与 SiFiGAN 的精度（FP16/FP32），基于输入 metadata 或文件大小判定。

## REMOVED Requirements

无。本变更纯新增，不删除任何现有功能。默认 vocoder 保持完全可用作为回退方案。
