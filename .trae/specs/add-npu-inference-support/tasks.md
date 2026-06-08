# Tasks

- [ ] Task 1: 统一硬件检测逻辑，新增设备分类函数
  - [ ] SubTask 1.1: 在 `nativeSvsPipeline.js` 中新增 `classifyDevice(name, vramBytes, dmlDiscreteFlag)` 函数，统一判断设备类型（`discrete-gpu`/`integrated-gpu`/`npu`/`cpu`），判断优先级：NPU 名称匹配 > GPU 名称匹配 > DML Discrete 标志 > 显存阈值兜底
  - [ ] SubTask 1.2: 新增 NPU 名称识别规则：Intel AI Boost / Intel NPU / Intel Neural / AMD XDNA / AMD Ryzen AI / Qualcomm Hexagon / QCOM NPU 等关键词
  - [ ] SubTask 1.3: 修改 `gpuCacheToDevices`，使用 `classifyDevice` 替代原有 `isDiscreteGPUByName` + 显存阈值逻辑，为设备对象增加 `deviceType` 字段
  - [ ] SubTask 1.4: 修改 `enumerateDMLDevicesInProcess`，不再过滤 `type !== 1` 的设备，对 NPU 类型设备正确归类；使用 `classifyDevice` 统一判断
  - [ ] SubTask 1.5: 修改 `enumDmlDevicesWorker.js` 同步上述逻辑
  - [ ] SubTask 1.6: 修改 `gpuWorker.js`，使用 `classifyDevice` 替代 `isDiscrete: (memoryTotal || vram) >= 512`，返回 `deviceType` 字段
  - [ ] SubTask 1.7: 修改 `main.js` 中的 `ensureGPUInfo` 兜底逻辑，使用 `classifyDevice`

- [ ] Task 2: Electron 启用 WebNN API + 安装 onnxruntime-web
  - [ ] SubTask 2.1: 在 `main.js` 的 `app.whenReady()` 之前添加 `app.commandLine.appendSwitch('enable-features', 'WebMachineLearningNeuralNetwork')`
  - [ ] SubTask 2.2: 在 `package.json` 中添加 `onnxruntime-web` 依赖
  - [ ] SubTask 2.3: 修改 `forge.config.js` 的 webpack 配置，确保 onnxruntime-web 的 WASM 文件和 Worker 正确打包
  - [ ] SubTask 2.4: 在主进程注册自定义 protocol `onnx://`，允许渲染进程安全访问模型文件

- [ ] Task 3: 渲染进程 WebNN 推理模块
  - [ ] SubTask 3.1: 新建 `src/inference/webnnPipeline.js`，封装 onnxruntime-web + WebNN EP 的推理逻辑
  - [ ] SubTask 3.2: 实现 NPU 可用性检测：通过 `navigator.ml` 检测 WebNN API，尝试创建 `{ deviceType: 'npu' }` 的 MLContext
  - [ ] SubTask 3.3: 实现模型加载：`ort.InferenceSession.create(modelUrl, { executionProviders: [{ name: 'webnn', deviceType: 'npu' }] })`，失败时回退到 WASM
  - [ ] SubTask 3.4: 实现推理执行：接收输入张量数据，执行推理，返回输出张量数据
  - [ ] SubTask 3.5: 实现会话管理：加载、卸载、查询模型状态

- [ ] Task 4: 主进程与渲染进程推理协调 IPC
  - [ ] SubTask 4.1: 在 `preload.js` 中新增 WebNN 相关 IPC 接口：`webnnDetectNPU`、`webnnLoadModel`、`webnnUnloadModel`、`webnnRunInference`、`webnnGetStatus`
  - [ ] SubTask 4.2: 在 `main.js` 中实现 IPC handler，转发渲染进程的 WebNN 请求到指定窗口的渲染进程
  - [ ] SubTask 4.3: 实现主进程到渲染进程的推理请求路由：当某模型分配到 NPU 时，主进程将推理请求转发到渲染进程
  - [ ] SubTask 4.4: 实现渲染进程推理结果回传：渲染进程执行推理后通过 IPC 将结果返回主进程
  - [ ] SubTask 4.5: 处理跨进程二进制数据传输（Float32Array），确保高效

- [ ] Task 5: 实现智能设备选择与模型-设备自动分配
  - [ ] SubTask 5.1: 在 `nativeSvsPipeline.js` 中新增 `selectBestDevice(devices, npuAvailable)` 函数，按优先级 GPU(独显) > NPU > GPU(核显) > CPU 选择主设备
  - [ ] SubTask 5.2: 新增 `buildModelDeviceMapping(devices, modelSizes, npuAvailable)` 函数，智能分配模型到设备：大模型(>100MB)→GPU(DirectML)，小模型(<10MB)→NPU(WebNN)/CPU
  - [ ] SubTask 5.3: 修改 `detectBestGPU` 为 `detectBestDevice`，返回结果包含 `deviceType` 和 `modelDeviceMapping`
  - [ ] SubTask 5.4: 修改 `_doInit` 方法，根据 `deviceMode`（smart/manual/advanced）和 `modelDeviceMapping` 为不同模型选择不同设备/进程
  - [ ] SubTask 5.5: 修改 `createSessionWithValidation`，接受可选的 `overrideDeviceId` 参数；对于分配到 NPU 的模型跳过主进程会话创建
  - [ ] SubTask 5.6: 修改合成流程（`synthesize` 等），当某步骤的模型在 NPU 时，通过 IPC 调用渲染进程执行推理

- [ ] Task 6: 扩展设置存储与 IPC
  - [ ] SubTask 6.1: 在 `main.js` 的 `ALLOWED_SETTINGS_KEYS` 中新增 `deviceMode`、`preferredDeviceId`、`preferredDeviceType`、`modelDeviceMapping`
  - [ ] SubTask 6.2: 修改 `settings:saveSettings` handler，兼容旧的 `deviceId` 字段迁移到新字段
  - [ ] SubTask 6.3: 修改 `ensureSVSPipeline`，读取新的设备设置字段传给 pipeline
  - [ ] SubTask 6.4: 新增 IPC `settings:validateDevices`，启动时校验用户手动指定的设备是否可用
  - [ ] SubTask 6.5: 修改 RMVPE / BasicPitch / Rosvot 推理器的初始化，支持按 modelDeviceMapping 分配设备（NPU 时通过渲染进程 WebNN 执行）

- [ ] Task 7: 设备丢失检测与回退提示
  - [ ] SubTask 7.1: 在主窗口加载完成后，调用设备校验逻辑
  - [ ] SubTask 7.2: 若用户手动模式指定的设备不可用，弹出 Electron dialog 提示，自动将 `deviceMode` 切换为 `smart`
  - [ ] SubTask 7.3: 若高级模式中某模型组指定的设备不可用，弹出提示并将该模型组的映射改为 `auto`
  - [ ] SubTask 7.4: 若 NPU 上次可用但本次不可用，弹出提示并将 NPU 分配的模型回退到 CPU
  - [ ] SubTask 7.5: 通过 IPC 通知渲染进程更新设备显示状态

- [ ] Task 8: 修改设置页面 UI — 设备模式选择
  - [ ] SubTask 8.1: 在 `settings.html` 推理硬件区域新增设备模式选择（智能模式/手动指定/高级设置）
  - [ ] SubTask 8.2: 修改设备下拉列表，显示 NPU 设备及类型标签（[独显]/[NPU](WebNN)/[核显]）
  - [ ] SubTask 8.3: 智能模式下禁用设备下拉列表，手动模式下启用
  - [ ] SubTask 8.4: 修改 `settings.js` 的 `loadDevices` 函数，适配新的设备数据结构（含 deviceType），增加 NPU 可用性检测
  - [ ] SubTask 8.5: 修改 `updateCurrentHardwareDisplay`，显示设备类型标签和模型分配概览
  - [ ] SubTask 8.6: 修改保存逻辑，保存 `deviceMode`、`preferredDeviceId`、`preferredDeviceType`

- [ ] Task 9: 修改设置页面 UI — 高级推理硬件设置
  - [ ] SubTask 9.1: 在 `settings.html` 新增高级推理硬件设置区域（默认隐藏，高级模式下展开）
  - [ ] SubTask 9.2: 高级区域列出模型组：SVS 扩散模型、SVS 编码器模型、SVS 辅助模型、RMVPE、RosVot，每组显示大小信息和推荐设备
  - [ ] SubTask 9.3: 每个模型组的设备选择下拉框包含：各 GPU（DirectML）、NPU（WebNN）、CPU、智能分配
  - [ ] SubTask 9.4: 在 `settings.css` 中添加高级设置区域的样式
  - [ ] SubTask 9.5: 在 `settings.js` 中实现高级设置的加载、显示和保存逻辑

- [ ] Task 10: 新增 i18n 翻译
  - [ ] SubTask 10.1: 在 `zh-CN.js` 的 settings 部分新增翻译：智能模式、手动指定、高级设置、NPU、WebNN、设备未找到提示、模型组名称等
  - [ ] SubTask 10.2: 在 `en.js` 的 settings 部分新增对应英文翻译

- [ ] Task 11: 旧设置兼容与迁移
  - [ ] SubTask 11.1: 在 `loadSettings` 中处理旧的 `deviceId` 字段：若 `deviceId` 为数字则迁移为 `deviceMode: 'manual'` + `preferredDeviceId`；若为 null 则迁移为 `deviceMode: 'smart'`

- [ ] Task 12: 适配资源管理器
  - [ ] SubTask 12.1: 修改 `resourceManager.js` 中的设备类型标签展示，支持 NPU 类型标签
  - [ ] SubTask 12.2: 修改 GPU 信息渲染，显示 `deviceType` 对应的标签而非仅 `isDiscrete`

# Task Dependencies
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 2]
- [Task 4] depends on [Task 3]
- [Task 5] depends on [Task 1, Task 4]
- [Task 6] depends on [Task 5]
- [Task 7] depends on [Task 6]
- [Task 8] depends on [Task 1]
- [Task 9] depends on [Task 8]
- [Task 10] depends on [Task 8, Task 9]
- [Task 11] depends on [Task 6]
- [Task 12] depends on [Task 1]
