# 新增 NPU 推理支持与智能设备分配 Spec

## Why
当前 SXSEditor 仅支持 DirectML GPU（独显/核显）和 CPU 推理，无法利用日益普及的 NPU（神经处理单元）硬件。NPU 可提供低功耗、高能效的 AI 推理能力，尤其适合 AI PC 场景。同时现有硬件检测存在判断逻辑不一致的问题，需要统一修复。此外，不同模型大小差异巨大（0.13MB~846MB），应支持将不同模型分配到不同硬件执行以优化性能。

## 架构决策：NPU 推理使用 onnxruntime-web + WebNN

### 为什么选择 onnxruntime-web + WebNN 而非 DirectML

- **onnxruntime-node 不原生支持 WebNN EP**：onnxruntime-node 仅支持 DirectML/CUDA/CPU 等 EP，无法直接使用 WebNN
- **WebNN 是浏览器标准 API**：WebNN API 通过 Chromium 内置的 DirectML/OpenVINO/QNN 后端访问 NPU，是 W3C 候选推荐标准
- **onnxruntime-web 原生支持 WebNN EP**：通过 `import * as ort from 'onnxruntime-web/all'` 并指定 `executionProviders: [{ name: 'webnn', deviceType: 'npu' }]` 即可使用 NPU
- **Electron 基于 Chromium**：可通过 `app.commandLine.appendSwitch('enable-features', 'WebMachineLearningNeuralNetwork')` 启用 WebNN API

### 混合推理架构

```
┌─────────────────────────────────────────────────────────┐
│ 主进程 (Node.js)                                         │
│ onnxruntime-node + DirectML EP                           │
│ 负责: GPU(独显/核显) 推理、CPU 推理                         │
│ 模型: diff_step, vocoder, rmvpe, rosvot 等 GPU 密集型模型  │
├─────────────────────────────────────────────────────────┤
│ 渲染进程 (Chromium)                                       │
│ onnxruntime-web + WebNN EP                               │
│ 负责: NPU 推理                                            │
│ 模型: encoders, preflow, cond_emb, mel_transform 等小模型  │
│ 通过 IPC 与主进程协调数据和推理结果                          │
└─────────────────────────────────────────────────────────┘
```

### 关键技术要点

1. **Electron 启用 WebNN**：在 `app.whenReady()` 之前调用 `app.commandLine.appendSwitch('enable-features', 'WebMachineLearningNeuralNetwork')`
2. **NPU 可用性检测**：在渲染进程中通过 `navigator.ml` API 检测 WebNN/NPU 是否可用
3. **模型文件访问**：渲染进程通过自定义 protocol（如 `onnx://`）或 `file://` 访问模型文件，需在主进程注册 protocol handler
4. **数据传输**：推理输入/输出通过 IPC 二进制传输（Float32Array），与现有音频数据传输方式一致
5. **算子兼容性**：WebNN EP 不支持的算子自动回退到 WASM（CPU），需在 UI 中提示用户

## What Changes
- 修复硬件检测不一致问题：统一 `isDiscrete` / `deviceType` 判断逻辑
- 新增 NPU 设备检测：主进程通过 DirectML 枚举 + systeminformation 检测 NPU 硬件；渲染进程通过 `navigator.ml` 检测 WebNN/NPU 可用性
- 新增 onnxruntime-web 依赖，在渲染进程中创建 WebNN 推理会话
- Electron 启动时启用 WebNN API flag
- 新增渲染进程 WebNN 推理模块（`src/inference/webnnPipeline.js`）
- 新增主进程与渲染进程之间的推理协调 IPC
- 重构设备选择逻辑：智能模式优先级 GPU(独显) > NPU > GPU(核显) > CPU
- 智能模式下按模型大小和硬件特性自动分配模型到不同设备/进程
- 设置页面新增"智能模式"与"手动指定设备"选项，设备列表显示 NPU 设备
- 设置页面新增"高级推理硬件设置"，支持手动为每个模型组指定运行设备
- 新增设备持久化与启动校验：用户手动指定的设备在下次启动未找到时，弹窗提示并自动切换到智能模式
- 新增 i18n 翻译条目（中英文）
- 扩展设置存储字段：`deviceMode`（smart/manual/advanced）、`preferredDeviceId`、`preferredDeviceType`、`modelDeviceMapping`

## Impact
- Affected specs: 推理管道、设置系统、设备枚举、进程间通信
- Affected code:
  - `src/inference/nativeSvsPipeline.js` — 设备枚举、会话创建、智能分配、按模型分配设备
  - `src/inference/webnnPipeline.js` — **新增** 渲染进程 WebNN 推理模块
  - `src/inference/enumDmlDevicesWorker.js` — NPU 设备检测
  - `src/main.js` — WebNN flag 启用、设置 IPC、启动校验、设备持久化、WebNN 推理协调 IPC、自定义 protocol 注册
  - `src/settings.js` — 设置 UI 逻辑、高级推理硬件设置、NPU 可用性检测
  - `src/settings.html` — 设置页面结构
  - `src/settings.css` — 高级设置样式
  - `src/preload.js` — 新增 IPC 接口（WebNN 推理、NPU 检测）
  - `src/i18n/zh-CN.js` / `src/i18n/en.js` — 翻译
  - `src/utils/gpuCache.js` / `src/utils/gpuWorker.js` — GPU/NPU 信息缓存、统一 deviceType
  - `src/resourceManager.js` — 设备类型标签展示适配
  - `package.json` — 新增 onnxruntime-web 依赖
  - `forge.config.js` — webpack 配置适配 onnxruntime-web

## ADDED Requirements

### Requirement: 统一硬件检测逻辑
系统 SHALL 统一所有硬件检测入口的设备类型判断逻辑，消除当前 main.js（512MB 显存阈值）与 nativeSvsPipeline.js（名称匹配+DML标志）之间的不一致。

#### Scenario: 统一 deviceType 判断
- **WHEN** 任何模块枚举硬件设备
- **THEN** 使用统一的 `classifyDevice(name, vramBytes, dmlDiscreteFlag)` 函数判断设备类型，返回 `discrete-gpu`/`integrated-gpu`/`npu`/`cpu`，判断优先级：NPU 名称匹配 > GPU 名称匹配 > DML Discrete 标志 > 显存阈值兜底

#### Scenario: gpuWorker.js 返回 deviceType
- **WHEN** gpuWorker.js 查询 GPU 信息
- **THEN** 返回 `deviceType` 字段替代 `isDiscrete` 布尔值（保留 `isDiscrete` 向后兼容）

### Requirement: NPU 设备检测（双路径）
系统 SHALL 在启动时通过两个路径自动检测可用的 NPU 设备。

#### Scenario: 主进程检测 NPU 设备（DirectML 枚举）
- **WHEN** 应用启动并枚举 DirectML 设备
- **THEN** 系统识别出 NPU 类型的设备（通过设备描述关键词和 vendor 信息判断），并在设备列表中标记 `deviceType: 'npu'`

#### Scenario: 渲染进程检测 NPU 可用性（WebNN API）
- **WHEN** 渲染进程加载时
- **THEN** 通过 `navigator.ml` API 检测 WebNN 是否可用，尝试创建 `{ deviceType: 'npu' }` 的 MLContext 验证 NPU 可用性，结果通过 IPC 报告给主进程

#### Scenario: 未检测到 NPU 设备
- **WHEN** 系统中没有 NPU 硬件或驱动不支持
- **THEN** 设备列表中不显示 NPU 选项，智能模式跳过 NPU 优先级

#### Scenario: DML 枚举中 NPU 设备的 type 值
- **WHEN** ONNX Runtime verbose 日志中发现 `type` 不为 1 但设备名称匹配 NPU 关键词
- **THEN** 不再过滤掉该设备，而是将其归类为 NPU 类型

### Requirement: Electron 启用 WebNN API
系统 SHALL 在 Electron 启动时启用 WebNN API，使渲染进程可以使用 WebNN EP 进行 NPU 推理。

#### Scenario: 启用 WebNN flag
- **WHEN** 应用启动，在 `app.whenReady()` 之前
- **THEN** 调用 `app.commandLine.appendSwitch('enable-features', 'WebMachineLearningNeuralNetwork')` 启用 WebNN API

#### Scenario: WebNN 不可用（旧版 Electron/Chromium）
- **WHEN** 当前 Electron 版本的 Chromium 不支持 WebNN
- **THEN** 渲染进程中 `navigator.ml` 为 undefined，NPU 检测返回不可用，系统回退到 GPU/CPU 推理

### Requirement: 渲染进程 WebNN 推理模块
系统 SHALL 在渲染进程中提供 WebNN 推理模块，使用 onnxruntime-web + WebNN EP 在 NPU 上执行推理。

#### Scenario: 加载模型到 NPU
- **WHEN** 智能模式或手动模式选择将某模型分配到 NPU
- **THEN** 渲染进程通过 onnxruntime-web 创建推理会话：`ort.InferenceSession.create(modelUrl, { executionProviders: [{ name: 'webnn', deviceType: 'npu' }] })`，不支持的算子自动回退到 WASM

#### Scenario: NPU 推理执行
- **WHEN** 需要在 NPU 上执行推理
- **THEN** 主进程通过 IPC 将输入数据发送到渲染进程，渲染进程执行推理后将输出数据通过 IPC 返回主进程

#### Scenario: 模型文件访问
- **WHEN** 渲染进程需要加载 ONNX 模型文件
- **THEN** 通过主进程注册的自定义 protocol（`onnx://`）访问模型文件，主进程验证路径安全性后返回文件内容

#### Scenario: WebNN EP 不可用回退
- **WHEN** WebNN EP 创建会话失败（NPU 驱动问题、算子不支持等）
- **THEN** 自动回退到 WASM EP（CPU），并在日志中记录回退原因

### Requirement: 智能设备选择模式
系统 SHALL 提供"智能模式"作为默认设备选择策略，按以下优先级自动选择最佳推理设备：GPU(独显) > NPU > GPU(核显) > CPU。智能模式下还应根据模型大小和硬件特性自动分配不同模型到不同设备/进程。

#### Scenario: 智能模式选择主设备
- **WHEN** 用户选择智能模式（默认）
- **THEN** 系统按优先级自动选择可用设备作为主推理设备，并在设置页面显示当前智能选择的设备名称

#### Scenario: 智能模式下的模型-设备自动分配
- **WHEN** 智能模式生效且 Pipeline 初始化
- **THEN** 系统按以下策略分配模型到设备：
  - 大模型（>100MB：diff_step、vocoder、rmvpe）→ 优先分配到 GPU(独显)（主进程 DirectML）
  - 中等模型（10-100MB：rosvot）→ 优先分配到 GPU（主进程 DirectML）
  - 小模型（<10MB：encoders、preflow、mel_transform）→ 若 NPU 可用则分配到 NPU（渲染进程 WebNN），否则分配到 CPU（主进程）
  - 若 NPU 可用，优先将小模型分配到 NPU 以释放 GPU 显存给大模型

#### Scenario: 智能模式下的设备信息展示
- **WHEN** 智能模式生效
- **THEN** 设置页面的"当前运行硬件"区域显示智能选择的设备名称和类型，以及模型分配概览（标注哪些模型在 GPU、哪些在 NPU、哪些在 CPU）

### Requirement: 手动设备选择模式
系统 SHALL 允许用户手动指定推理设备，包括所有检测到的 GPU 和 NPU 设备。手动模式下所有模型统一在指定设备上运行。

#### Scenario: 用户手动选择 GPU 设备
- **WHEN** 用户在设置中选择手动模式并指定某 GPU 设备
- **THEN** 系统使用用户指定的 GPU 设备通过主进程 DirectML 运行所有模型

#### Scenario: 用户手动选择 NPU 设备
- **WHEN** 用户在设置中选择手动模式并指定 NPU 设备
- **THEN** 系统将所有模型通过渲染进程 WebNN EP 在 NPU 上运行，不支持的算子回退到 WASM

#### Scenario: 用户手动选择 CPU
- **WHEN** 用户在设置中选择手动模式并指定 CPU
- **THEN** 系统使用主进程 CPU 运行所有模型

### Requirement: 高级推理硬件设置
系统 SHALL 在设置页面提供"高级推理硬件设置"区域，允许用户为每个模型组手动指定运行设备。

#### Scenario: 启用高级模式
- **WHEN** 用户在设置中选择"高级"模式
- **THEN** 显示高级推理硬件设置区域，列出所有模型组及其当前分配的设备，每个模型组可独立选择设备

#### Scenario: 高级模式下为模型组分配设备
- **WHEN** 用户在高级模式中为某模型组选择特定设备
- **THEN** 该模型组中的所有模型将使用指定设备/进程创建推理会话，设置保存 `deviceMode: 'advanced'` 和 `modelDeviceMapping`

#### Scenario: 高级模式下的模型组列表
- **WHEN** 高级模式启用
- **THEN** 显示以下模型组及其大小信息：
  - SVS 扩散模型（diff_step + vocoder，约 1340MB FP16 / 887MB INT8）→ 推荐 GPU
  - SVS 编码器模型（text/pitch/type/f0 encoder + preflow + cond_emb，约 13MB FP16 / 6.5MB INT8）→ 推荐 NPU/CPU
  - SVS 辅助模型（mel_transform，约 0.25MB）→ 推荐 NPU/CPU
  - RMVPE 音高检测（约 349MB）→ 推荐 GPU
  - RosVot 语音检测（约 55MB）→ 推荐 GPU/NPU
  - 每组可选择的设备：各 GPU（DirectML）、NPU（WebNN）、CPU、智能分配

### Requirement: 设备丢失检测与回退
系统 SHALL 在启动时校验用户上次指定的设备是否仍然可用，若不可用则提示用户并自动切换到智能模式。

#### Scenario: 用户手动指定的设备在下次启动时不可用
- **WHEN** 应用启动，检测到用户上次手动指定的设备不存在
- **THEN** 弹出对话框提示用户"之前选择的设备 XXX 未找到，已切换到智能模式"，并将 `deviceMode` 设为 `smart`

#### Scenario: 高级模式下某模型组的指定设备不可用
- **WHEN** 应用启动，高级模式中某模型组指定的设备不存在
- **THEN** 弹出对话框提示用户"模型组 XXX 指定的设备 YYY 未找到，已切换为智能分配"，将该模型组的设备映射改为 `auto`

#### Scenario: NPU 在上次可用但本次不可用
- **WHEN** 应用启动，上次 NPU 可用但本次 WebNN 检测不到 NPU
- **THEN** 弹出对话框提示用户"NPU 设备未找到，已切换到智能模式"，原本分配到 NPU 的模型回退到 CPU

#### Scenario: 用户指定的设备仍然可用
- **WHEN** 应用启动，检测到用户上次指定的设备存在
- **THEN** 继续使用用户指定的设备，不弹出提示

### Requirement: 设置页面设备选择 UI
系统 SHALL 在设置页面的推理硬件区域提供设备模式选择和设备列表。

#### Scenario: 设置页面展示设备选项
- **WHEN** 用户打开设置页面
- **THEN** 推理硬件区域显示：
  - 设备模式选择（智能模式/手动指定/高级设置）
  - 设备下拉列表（手动模式下启用，智能/高级模式下禁用）
  - 设备列表中 NPU 设备标注 [NPU] 和 "(WebNN)"
  - 当前运行硬件信息（含设备类型标签如 [独显]/[NPU]/[核显]）
  - 高级设置区域（仅高级模式展开，显示各模型组的设备分配）
  - WebNN/NPU 可用性状态提示

### Requirement: WebNN 推理会话创建
系统 SHALL 支持通过 onnxruntime-web + WebNN EP 在 NPU 设备上创建 ONNX Runtime 推理会话。

#### Scenario: NPU 设备上创建推理会话
- **WHEN** 智能模式或手动模式选择了 NPU 设备
- **THEN** 在渲染进程中使用 `ort.InferenceSession.create(modelUrl, { executionProviders: [{ name: 'webnn', deviceType: 'npu' }] })` 创建会话，若 NPU 不支持某些算子则自动回退到 WASM EP

#### Scenario: WebNN EP 创建失败
- **WHEN** WebNN EP 创建会话失败（NPU 驱动问题等）
- **THEN** 尝试回退到 `{ name: 'webnn', deviceType: 'gpu' }`，再失败则回退到 WASM，记录日志并通知用户

## MODIFIED Requirements

### Requirement: 设备枚举
原需求：枚举 DirectML GPU 设备（仅区分独显/核显），过滤 type !== 1 的设备
修改为：枚举所有 DirectML 兼容设备，包括 GPU（独显/核显）和 NPU，不再过滤 NPU 类型的设备。每个设备附带 `deviceType` 字段（`discrete-gpu`/`integrated-gpu`/`npu`/`cpu`），保留 `isDiscrete` 向后兼容。同时通过渲染进程 WebNN API 检测 NPU 实际可用性

### Requirement: 设置存储
原需求：存储 `deviceId`（数字或 null 表示自动）
修改为：存储 `deviceMode`（`smart`/`manual`/`advanced`）、`preferredDeviceId`（数字，手动模式时有效）、`preferredDeviceType`（字符串，用于设备丢失校验）、`modelDeviceMapping`（对象，高级模式下各模型组的设备分配，key 为模型组 ID，value 为 deviceId 或 `'auto'` 或 `'npu-webnn'`）

### Requirement: Pipeline 初始化
原需求：所有模型使用同一个 deviceId 在主进程创建会话
修改为：支持按模型组分配不同设备/进程创建会话。GPU/CPU 模型在主进程通过 onnxruntime-node + DirectML 创建；NPU 模型在渲染进程通过 onnxruntime-web + WebNN 创建。主进程和渲染进程通过 IPC 协调推理

### Requirement: 模型文件访问
原需求：主进程直接通过文件系统路径加载模型
修改为：主进程继续直接加载模型；渲染进程通过自定义 protocol（`onnx://`）访问模型文件，主进程注册 protocol handler 并验证路径安全性

## REMOVED Requirements
无移除的需求。
