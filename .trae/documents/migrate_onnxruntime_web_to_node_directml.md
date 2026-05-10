# 从 onnxruntime-web 迁移到 onnxruntime-node (DirectML) 计划

## 当前架构分析

### 现有实现
1. **主进程** (`src/main.js`):
   - 使用 `NativeSVSPipeline` (基于 `onnxruntime-node` + DirectML/CPU)
   - 通过 IPC 处理 `svs:init`, `svs:synthesize`, `svs:dispose`

2. **主窗口渲染进程** (`src/renderer.js`):
   - 通过 `window.electronAPI.initSVSPipeline()` 等 IPC 调用主进程
   - 已经正确使用 native 推理 ✅

3. **分片编辑窗口** (`src/fragmentEditor.js`):
   - **直接导入** `svsPipeline.js` (基于 `onnxruntime-web` + WebGPU/WASM)
   - 在渲染进程中直接创建 `SVSPipeline` 实例进行推理 ❌
   - 这是唯一使用 `onnxruntime-web` 的地方

### 问题
- `fragmentEditor.js` 在渲染进程中使用 WebGPU/WASM 推理，性能较差
- 需要将分片编辑窗口的推理也迁移到主进程的 native pipeline

## 迁移方案

### 核心思路
为分片编辑窗口添加独立的 IPC 通道，使其也能通过主进程使用 DirectML 推理。

### 具体步骤

#### 步骤 1: 扩展主进程 IPC 支持
**文件**: `src/main.js`
- 添加独立的分片编辑窗口 pipeline 变量 `fragmentSvsPipeline`
- 添加新的 IPC handlers:
  - `fragment-svs:init` - 初始化分片窗口专用 pipeline
  - `fragment-svs:synthesize` - 执行分片合成
  - `fragment-svs:dispose` - 释放分片窗口 pipeline
- 复用已有的 `NativeSVSPipeline` 类

#### 步骤 2: 扩展 preload 脚本
**文件**: `src/preload.js`
- 添加分片编辑窗口专用的 API 暴露:
  - `initFragmentSVSPipeline`
  - `synthesizeFragmentSVS`
  - `disposeFragmentSVSPipeline`
- 注意：preload 脚本可能被多个窗口共享，需要确认是否要创建独立 preload 或复用

#### 步骤 3: 重构 fragmentEditor.js
**文件**: `src/fragmentEditor.js`
- 移除 `import { SVSPipeline, SAMPLE_RATE } from './inference/svsPipeline.js'`
- 改用 IPC 调用:
  - `window.electronAPI.initFragmentSVSPipeline()` 初始化
  - `window.electronAPI.synthesizeFragmentSVS()` 合成
  - `window.electronAPI.disposeFragmentSVSPipeline()` 释放
- 需要处理 SAMPLE_RATE 常量的来源（可从 main 进程获取或本地定义）
- 修改 `pipeline.synthesize()` 调用为 IPC 调用

#### 步骤 4: 更新 preload 配置
**文件**: 需要检查 forge.config.js 或 webpack 配置
- 确认 FRAGMENT_EDITOR_WINDOW_PRELOAD_WEBPACK_ENTRY 指向的 preload 脚本
- 确保新 API 在分片编辑窗口的 preload 中可用
- 可能需要修改 preload 文件或创建专用 preload

#### 步骤 5: 移除 onnxruntime-web 依赖
**文件**: `package.json`
- 移除 `"onnxruntime-web": "^1.24.3"` 依赖
- 删除 `src/inference/svsPipeline.js` 文件（不再需要）

#### 步骤 6: 验证和测试
- 运行 `npm install` 更新依赖
- 运行 `npm start` 测试应用
- 验证主窗口合成功能
- 验证分片编辑窗口合成功能
- 检查 DirectML GPU 加速是否生效（查看控制台日志）

## 技术细节

### DirectML 配置
`nativeSvsPipeline.js` 已经配置了正确的 DirectML:
```javascript
executionProviders: ['DmlExecutionProvider']
```
回退到 CPU:
```javascript
executionProviders: ['CPUExecutionProvider']
```

### IPC 数据传输
- `synthesize` 返回 `Array.from(waveOut.data)` (Float32 数组)
- 数据量较大时，Electron IPC 可以处理
- 需要确保音频数据正确传递

### 注意事项
- `fragmentEditor.js` 目前使用异步初始化 `pipeline.init()`，迁移后需要适配
- `synthesize` 调用需要支持 `onProgress` 回调（可能需要实现 IPC 进度通知）
- `sampleRate` 常量需要从其他地方获取（可定义为 24000 或从 main 进程获取）

## 风险点
1. **进度回调**: 当前 native pipeline 的 synthesize 支持 `onProgress`，但通过 IPC 调用时，渲染进程无法直接接收进度更新。可能需要添加 `ipcRenderer.on` 监听进度事件。
2. **数据序列化**: 大量音频数据通过 IPC 传输可能存在性能问题，但对于单次合成通常可接受。
3. **Multiple pipelines**: 主窗口和分片窗口可能需要独立的 pipeline 实例，避免冲突。
